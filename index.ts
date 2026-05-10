/**
 * pi-recap - Pi extension.
 *
 * Always-visible recap panel above the editor: session goal + last few turns,
 * each with a timestamp and a "you"/"pi" prefix tag. Focus a tab and the
 * panel tells you what you were doing without scrolling back. Ctrl+Shift+R
 * focuses the panel; arrow keys walk the history; Esc releases.
 *
 * Architecture:
 *   - Each stream binds to its own HistoryEntry id. before_agent_start
 *     creates a "user" streaming entry up front; agent_end creates an
 *     "agent" streaming entry. The two streams run in parallel - they
 *     write to different entries so they cannot collide.
 *   - The widget reads straight from state on each render() and animates
 *     per-entry. Multiple rows can stream at once.
 *   - Goal auto-derivation runs in parallel with the agent recap on
 *     agent_end, no UI surface of its own.
 *
 * v5 picker chain (top-to-bottom, see subagent/picker.ts):
 *   1. user override (modelOverride from /recap-model <id>)
 *   2. cached winner with 24h TTL (cachedRecapModel.cachedAt)
 *   3. CURATED_CHAIN (hand-picked tiny/cheap ids, edit in picker.ts)
 *   4. regex+sort discovery (1 per family in FAMILY_ORDER)
 *   5. ctx.model (sacred fallback, thinking-off)
 *
 * v5 surfaces:
 *   - state/blacklist.json: persistent skip-list with seed; addressed by
 *     auto-blacklist on failure and by /recap-blacklist subcommands.
 *   - session-start toast: state.notice ("Selected: <id> · /recap-model
 *     to change") shows for 2.5s in the title-right slot, then expires.
 *
 * Persistence: "recap" custom entries in the session branch. Streaming flags
 * are stripped on replay. Sub-agent calls a fast/cheap model directly to
 * keep the main thread free of summarization context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	addStreamingEntry,
	clearCachedGoalModel,
	clearCachedRecapModel,
	commitState,
	finalizeEntry,
	getState,
	removeEntry,
	replaceState,
	seedLastModel,
	setCachedGoalModel,
	setCachedRecapModel,
	setNotice,
	updateEntryText,
} from "./state/store.js";
import { replayFromBranch } from "./state/replay.js";
import { StatusWidget } from "./ui/status-widget.js";
import {
	generateUserRecap,
	generateAgentRecap,
	listAvailableFastModels,
	previewFirstPick,
} from "./subagent/recap.js";
import { deriveGoalInitial, deriveGoalRefine } from "./subagent/goal.js";
import {
	addToBlacklist,
	loadBlacklist,
	removeFromBlacklist,
	resetBlacklist,
	seedBlacklist,
} from "./state/blacklist.js";
import { logError } from "./util/log.js";

// ── Helpers ───────────────────────────────────────────────────────────

/** How long the session-start notice toast stays visible before the
 *  title-right slot reverts to the model tag. */
const NOTICE_DURATION_MS = 2500;

/** Single pass over the session branch: returns the trailing window of
 *  user+assistant messages and the total user-turn count. Folded together so
 *  the agent_end handler walks the branch once instead of twice. */
function scanBranch(
	ctx: { sessionManager: { getBranch(): Iterable<unknown> } },
	maxMessages: number = 12,
): { messages: any[]; userTurnCount: number } {
	const messages: any[] = [];
	let userTurnCount = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as {
			type?: string;
			message?: { role?: string; content?: unknown };
		};
		if (e.type !== "message") continue;
		const msg = e.message;
		if (!msg) continue;
		if (msg.role === "user") userTurnCount++;
		if (msg.role === "user" || msg.role === "assistant") messages.push(msg);
	}
	return { messages: messages.slice(-maxMessages), userTurnCount };
}

/** Persist current state. Streaming flag is stripped client-side too -- a
 *  recap entry that's still streaming when this fires would otherwise
 *  re-load as a zombie spinner. The transient `notice` field is intentionally
 *  not persisted so toasts never resurrect on session reload. */
function persistState(pi: ExtensionAPI): void {
	const state = getState();
	pi.appendEntry("recap", {
		goal: state.goal,
		goalSource: state.goalSource,
		goalAutoTurnsApplied: state.goalAutoTurnsApplied,
		status: state.status,
		history: state.history
			.filter((h) => !h.streaming)
			.map((h) => ({
				id: h.id,
				timestamp: h.timestamp,
				recap: h.recap,
				speaker: h.speaker,
			})),
		nextId: state.nextId,
		lastModel: state.lastModel,
		modelOverride: state.modelOverride,
		cachedRecapModel: state.cachedRecapModel,
		cachedGoalModel: state.cachedGoalModel,
	});
}

/**
 * Fire the session-start toast in the title-right slot. Picks the picker's
 * likely first attempt at this exact moment so the toast is honest. Falls
 * back gracefully if the picker would land on nothing (no notice fires).
 *
 * Also seeds state.lastModel when empty so the title-right slot doesn't go
 * blank in the window between toast expiry (2.5s) and the first finalize.
 * The actual winner from finalizeEntry overwrites this value once it lands.
 */
function fireSessionStartNotice(ctx: {
	model: { id: string } | undefined;
	modelRegistry: any;
}): void {
	const before = getState();
	const sessionModel = ctx.model as any;
	const pickedId = previewFirstPick(
		ctx.modelRegistry,
		before.modelOverride,
		sessionModel,
		before.cachedRecapModel,
	);
	if (!pickedId) return;
	setNotice(`Selected: ${pickedId} · /recap to change`, NOTICE_DURATION_MS);
	seedLastModel(pickedId);
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let statusWidget: StatusWidget | undefined;

	// ── Session lifecycle ──────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));

		// Bootstrap the blacklist file on first ever session_start. seedBlacklist()
		// is idempotent: subsequent calls won't duplicate entries.
		try {
			loadBlacklist(); // triggers seed-on-empty
		} catch (err) {
			logError("blacklist load failed:", err);
		}

		if (ctx.hasUI) {
			statusWidget ??= new StatusWidget();
			statusWidget.setUICtx(ctx.ui);
			fireSessionStartNotice(ctx);
			statusWidget.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
		statusWidget?.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
		statusWidget?.update();
	});

	pi.on("session_shutdown", async () => {
		statusWidget?.dispose();
		statusWidget = undefined;
	});

	// ── User-recap on before_agent_start ──────────────────────────

	pi.on("before_agent_start", (event, ctx) => {
		if (!ctx.hasUI) return;
		const prompt = event.prompt?.trim();
		if (!prompt) return;

		// Allocate a streaming entry up front so the widget shows a "you"
		// row immediately. The stream then writes deltas straight into it.
		const entryId = addStreamingEntry("user");
		statusWidget?.update();

		const before = getState();
		const sessionModel = ctx.model;
		void (async () => {
			try {
				const { result, cachedWinnerCleared } = await generateUserRecap(prompt, ctx.modelRegistry, {
					onDelta: (running) => {
						updateEntryText(entryId, running);
						statusWidget?.update();
					},
					preferredModelId: before.modelOverride,
					sessionModel,
					cachedWinner: before.cachedRecapModel,
				});
				if (cachedWinnerCleared) clearCachedRecapModel();
				if (!result) {
					removeEntry(entryId);
					statusWidget?.update();
					return;
				}
				finalizeEntry(entryId, result.recap, result.modelId);
				setCachedRecapModel(result.modelId);
				persistState(pi);
				statusWidget?.update();
			} catch (err) {
				logError("user recap failed:", err);
				removeEntry(entryId);
				statusWidget?.update();
			}
		})();
	});

	// ── Agent-recap on agent_end + goal derivation in parallel ────

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;

		const { messages: branchMessages, userTurnCount } = scanBranch(ctx);
		const before = getState();

		// Goal derivation: parallel, no UI.
		const shouldDeriveGoal =
			before.goalSource === "auto" &&
			before.goalAutoTurnsApplied < 2 &&
			userTurnCount > before.goalAutoTurnsApplied &&
			branchMessages.length > 0;

		if (shouldDeriveGoal) {
			const isFirst = before.goalAutoTurnsApplied === 0;
			const sessionModel = ctx.model;
			const goalOpts = {
				preferredModelId: before.modelOverride,
				sessionModel,
				cachedWinner: before.cachedGoalModel,
			};
			void (async () => {
				try {
					const { result, cachedWinnerCleared } = isFirst
						? await deriveGoalInitial(branchMessages, ctx.modelRegistry, goalOpts)
						: await deriveGoalRefine(before.goal, branchMessages, ctx.modelRegistry, goalOpts);
					if (cachedWinnerCleared) clearCachedGoalModel();
					const current = getState();
					if (current.goalSource === "manual") return; // manual lock landed in-flight
					if (result?.modelId) setCachedGoalModel(result.modelId);
					const nextGoal = result?.action === "update" && result.goal ? result.goal : current.goal;
					commitState({
						...getState(),
						goal: nextGoal,
						goalSource: "auto",
						goalAutoTurnsApplied: Math.min(2, userTurnCount),
					});
					persistState(pi);
					statusWidget?.update();
					// Mirror into pi's session label. Fire-and-forget; if pi
					// throws here it must NOT tank the widget update above.
					if (nextGoal && nextGoal !== before.goal) {
						try {
							pi.setSessionName?.(nextGoal);
						} catch (err) {
							logError("setSessionName failed:", err);
						}
					}
				} catch (err) {
					logError("goal derivation failed:", err);
				}
			})();
		}

		// Agent recap: own entry id, runs concurrently with the user-recap
		// stream that may still be wrapping up from before_agent_start.
		const entryId = addStreamingEntry("agent");
		statusWidget?.update();

		void (async () => {
			try {
				const beforeAgent = getState();
				const { result, cachedWinnerCleared } = await generateAgentRecap(
					event.messages,
					ctx.modelRegistry,
					{
						onDelta: (running) => {
							updateEntryText(entryId, running);
							statusWidget?.update();
						},
						preferredModelId: beforeAgent.modelOverride,
						sessionModel: ctx.model,
						cachedWinner: beforeAgent.cachedRecapModel,
					},
				);
				if (cachedWinnerCleared) clearCachedRecapModel();
				if (!result) {
					removeEntry(entryId);
					statusWidget?.update();
					return;
				}
				finalizeEntry(entryId, result.recap, result.modelId);
				setCachedRecapModel(result.modelId);
				persistState(pi);
				statusWidget?.update();
			} catch (err) {
				logError("agent recap failed:", err);
				removeEntry(entryId);
				statusWidget?.update();
			}
		})();
	});

	// ── Keyboard shortcut: ctrl+shift+r - focus the recap panel ──
	// Plain ctrl+r is the built-in app.session.rename, so we use the shift
	// variant. Shortcut flips focus to the StatusWidget so arrow keys route
	// to its handleInput. Esc or ctrl+shift+r again releases.

	pi.registerShortcut("ctrl+shift+r", {
		description: "Focus the recap panel (arrows to navigate, esc to release)",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			statusWidget?.toggleFocus();
		},
	});

	// ── Slash command: /recap - unified interactive menu ──────────

	pi.registerCommand("recap", {
		description: "Manage session goal, recap model, and blacklist",
		handler: async (_args, ctx) => {
			const current = getState();

			// Build menu with context snippets
			const goalLabel = current.goal
				? `goal: ${current.goal.slice(0, 40)}${current.goal.length > 40 ? "…" : ""}${current.goalSource === "manual" ? " (locked)" : ""}`
				: "goal: not set (auto-derives after first turn)";
			const modelLabel = current.modelOverride
				? `model: ${current.modelOverride} (override)`
				: `model: auto-pick${current.lastModel ? ` (last: ${current.lastModel})` : ""}`;
			const bl = loadBlacklist();
			const blLabel = `blacklist: ${bl.entries.length} entries`;

			const options = [
				goalLabel,
				"clear goal",
				modelLabel,
				"clear model",
				blLabel,
			];

			const choice = await ctx.ui.select("recap", options);
			if (!choice) return; // dismissed

			// ── Goal ────────────────────────────────────────────────

			if (choice === goalLabel) {
				const input = await ctx.ui.input(
					"Session goal",
					current.goalSource === "manual" ? current.goal : undefined,
				);
				if (!input) return; // cancelled
				const next = input.trim().slice(0, 60);
				if (!next) return;
				commitState({ ...getState(), goal: next, goalSource: "manual", goalAutoTurnsApplied: 2 });
				persistState(pi);
				statusWidget?.update();
				ctx.ui.notify(`Goal locked: ${next}`, "info");
				return;
			}

			if (choice === "clear goal") {
				commitState({ ...getState(), goal: "", goalSource: "auto", goalAutoTurnsApplied: 0 });
				persistState(pi);
				statusWidget?.update();
				ctx.ui.notify("Goal cleared. Will auto-derive next turn.", "info");
				return;
			}

			// ── Model ───────────────────────────────────────────────

			if (choice === modelLabel) {
				const available = await listAvailableFastModels(ctx.modelRegistry);
				const fastList = available.filter((id) => {
					const lower = id.toLowerCase();
					const hasMini = lower.includes("mini") && !lower.includes("gemini");
					return lower.includes("flash") || hasMini || lower.includes("haiku")
						|| lower.includes("turbo") || lower.includes("lite");
				});
				if (fastList.length === 0) {
					ctx.ui.notify("No fast models with valid keys available.", "warning");
					return;
				}
				const picked = await ctx.ui.select("Recap model", fastList);
				if (!picked) return;
				commitState({ ...getState(), modelOverride: picked });
				persistState(pi);
				statusWidget?.update();
				ctx.ui.notify(`Recap model set: ${picked}`, "info");
				return;
			}

			if (choice === "clear model") {
				commitState({ ...getState(), modelOverride: undefined });
				persistState(pi);
				statusWidget?.update();
				ctx.ui.notify("Recap model reset to auto-pick.", "info");
				return;
			}

			// ── Blacklist ───────────────────────────────────────────

			if (choice === blLabel) {
				const blCurrent = loadBlacklist();
				if (blCurrent.entries.length === 0) {
					const blAction = await ctx.ui.select("Blacklist is empty", ["seed defaults"]);
					if (blAction === "seed defaults") {
						seedBlacklist();
						const after = loadBlacklist();
						ctx.ui.notify(`Blacklist seeded. ${after.entries.length} entries.`, "info");
					}
					return;
				}

				const blOptions = [
					"view entries",
					"add entry",
					"remove entry",
					"reset",
					"re-seed defaults",
				];
				const blChoice = await ctx.ui.select("Blacklist", blOptions);
				if (!blChoice) return;

				if (blChoice === "view entries") {
					const lines = blCurrent.entries.map((e) => `${e.id} — ${e.reason} [${e.addedBy}]`);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				if (blChoice === "add entry") {
					const id = await ctx.ui.input("Model ID to blacklist");
					if (!id?.trim()) return;
					const reason = await ctx.ui.input("Reason (optional)", "user added");
					addToBlacklist(id.trim(), (reason || "user added").trim(), "user");
					ctx.ui.notify(`Blacklisted ${id.trim()}.`, "info");
					return;
				}

				if (blChoice === "remove entry") {
					const blForRemove = loadBlacklist();
					const ids = blForRemove.entries.map((e) => e.id);
					const pick = await ctx.ui.select("Remove from blacklist", ids);
					if (!pick) return;
					const removed = removeFromBlacklist(pick);
					ctx.ui.notify(removed ? `Removed ${pick}.` : `${pick} not found.`, "info");
					return;
				}

				if (blChoice === "reset") {
					resetBlacklist();
					ctx.ui.notify("Blacklist reset.", "info");
					return;
				}

				if (blChoice === "re-seed defaults") {
					seedBlacklist();
					const after = loadBlacklist();
					ctx.ui.notify(`Blacklist re-seeded. ${after.entries.length} entries.`, "info");
					return;
				}
			}
		},
	});
}
