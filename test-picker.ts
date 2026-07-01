/**
 * Regression tests for provider/id model identity in the picker chain.
 *
 * Covers the bug class where two providers expose the same bare model id
 * (e.g. "auto" from both "openrouter" and "freeride") and the picker used
 * to silently collapse them (Map keyed by bare id) or resolve the wrong
 * one. modelKey()/resolveModel() now key on "provider/id" so callers can
 * disambiguate with a provider-qualified selector while bare legacy
 * selectors keep resolving to *some* matching model.
 *
 * No network, no live registry -- everything below is a mock model/registry.
 * Run: npx tsx test-picker.ts   (or bunx tsx test-picker.ts)
 */

import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { findFastModelChain, isFreeModel, modelKey, resolveModel, resolveModelKey } from "./subagent/picker.js";
import { listAvailableFastModels } from "./subagent/recap.js";

type TestModel = Model<Api>;

function makeModel(overrides: Partial<TestModel> & Pick<TestModel, "id">): TestModel {
	return {
		id: overrides.id,
		name: overrides.name ?? overrides.id,
		api: overrides.api ?? "openai-completions",
		provider: overrides.provider ?? "",
		baseUrl: overrides.baseUrl ?? "https://example.invalid",
		reasoning: overrides.reasoning ?? false,
		input: overrides.input ?? ["text"],
		cost: overrides.cost ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: overrides.contextWindow ?? 128000,
		maxTokens: overrides.maxTokens ?? 4096,
	} as TestModel;
}

const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PAID_COST = { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 };

// Two providers, both exposing a bare id "auto" -- the case that broke the
// old Map<string, Model>-by-bare-id dedup in findFastModelChain.
const openrouterAuto = makeModel({ id: "auto", provider: "openrouter", cost: PAID_COST });
const freerideAuto = makeModel({ id: "auto", provider: "freeride", cost: FREE_COST });
// A second, distinct provider that ALSO exposes a free bare id "auto" --
// used to prove listAvailableFastModels keys its output by provider/id
// (both must appear) rather than by bare id (which would collapse to one).
const vertexFreeAuto = makeModel({ id: "auto", provider: "vertex", cost: FREE_COST });
// A legacy-shaped model: no provider at all (pre-provider/id registries).
const legacyBare = makeModel({ id: "legacy-fast-mini", provider: "", cost: PAID_COST });

function mockRegistry(models: TestModel[], authFor: (id: string) => boolean = () => true) {
	return {
		getAvailable: () => models,
		getApiKeyAndHeaders: async (model: TestModel) => {
			const ok = authFor(modelKey(model));
			return { ok, apiKey: ok ? "fake-key" : undefined, headers: {} };
		},
	};
}

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
	tests.push({ name, fn });
}

// ── modelKey ──────────────────────────────────────────────────────────

test("modelKey: provider/id when provider is set", () => {
	assert.equal(modelKey(freerideAuto), "freeride/auto");
	assert.equal(modelKey(openrouterAuto), "openrouter/auto");
});

test("modelKey: bare id when provider is empty (legacy shape)", () => {
	assert.equal(modelKey(legacyBare), "legacy-fast-mini");
});

// ── resolveModel: duplicate bare ids across providers ───────────────────

test("resolveModel: provider/id selector picks the exact provider, not the other duplicate", () => {
	const available = [openrouterAuto, freerideAuto];
	const resolved = resolveModel(available, "freeride/auto");
	assert.ok(resolved, "expected freeride/auto to resolve");
	assert.equal(resolved!.provider, "freeride");
	assert.equal(resolved!.id, "auto");
});

test("resolveModel: the other provider/id selector resolves to its own duplicate", () => {
	const available = [openrouterAuto, freerideAuto];
	const resolved = resolveModel(available, "openrouter/auto");
	assert.ok(resolved, "expected openrouter/auto to resolve");
	assert.equal(resolved!.provider, "openrouter");
});

test("resolveModel: legacy bare selector still resolves to a matching model when ids collide", () => {
	const available = [openrouterAuto, freerideAuto];
	const resolved = resolveModel(available, "auto");
	// Contract: a bare, non-provider-qualified selector must still resolve to
	// *some* model sharing that bare id (never silently drop it), and the
	// resolution is deterministic -- first match in registry order.
	assert.ok(resolved, "bare 'auto' selector must still resolve despite duplicate ids");
	assert.equal(resolved!.id, "auto");
	assert.equal(resolved, available[0], "bare selector resolves the first array match deterministically");
});

test("resolveModelKey: legacy bare selector canonicalizes to one exact provider/id key", () => {
	const available = [openrouterAuto, freerideAuto];
	assert.equal(resolveModelKey(available, "auto"), "openrouter/auto");
	assert.notEqual(resolveModelKey(available, "auto"), "freeride/auto");
});

test("resolveModelKey: provider/id selector stays exact", () => {
	const available = [openrouterAuto, freerideAuto];
	assert.equal(resolveModelKey(available, "freeride/auto"), "freeride/auto");
});

test("resolveModel: legacy no-provider model resolves by bare id", () => {
	const available = [legacyBare, freerideAuto];
	const resolved = resolveModel(available, "legacy-fast-mini");
	assert.ok(resolved);
	assert.equal(resolved, legacyBare);
});

test("resolveModel: unknown selector resolves to undefined", () => {
	const available = [openrouterAuto, freerideAuto];
	assert.equal(resolveModel(available, "nonexistent/nope"), undefined);
});

// ── findFastModelChain: provider/id manual override ─────────────────────

test("findFastModelChain: provider/id preferredId disambiguates the manual layer", () => {
	const registry = mockRegistry([openrouterAuto, freerideAuto]);
	const chain = findFastModelChain(registry, "freeride/auto", undefined, undefined, Date.now(), false);
	assert.ok(chain.length > 0, "chain must not be empty");
	assert.equal(chain[0]!.provider, "freeride", "manual override must select the freeride duplicate, not openrouter");
	assert.equal(chain[0]!.id, "auto");
});

test("findFastModelChain: bare legacy preferredId still lands a manual pick first", () => {
	const registry = mockRegistry([openrouterAuto, freerideAuto]);
	const chain = findFastModelChain(registry, "auto", undefined, undefined, Date.now(), false);
	assert.ok(chain.length > 0);
	assert.equal(chain[0]!.id, "auto", "legacy bare preferredId must still resolve to an 'auto' model");
});

test("findFastModelChain: duplicate ids across providers are not deduped into one slot", () => {
	// Both openrouter/auto and freeride/auto should survive as *distinct*
	// chain entries when both are reachable (manual override for one,
	// sessionModel for the other) -- proving the chain keys on provider/id,
	// not bare id, for de-duplication.
	const registry = mockRegistry([openrouterAuto, freerideAuto]);
	const chain = findFastModelChain(registry, "freeride/auto", openrouterAuto, undefined, Date.now(), false);
	const keys = chain.map((m) => modelKey(m));
	assert.deepEqual(keys, ["freeride/auto", "openrouter/auto"], "both duplicate-id models must appear as distinct chain entries");
});

// ── findFastModelChain: free-only auto-pick ──────────────────────────────

test("findFastModelChain: free-only auto-pick includes the zero-cost freeride/auto entry", () => {
	const registry = mockRegistry([openrouterAuto, freerideAuto]);
	// No preferredId -- pure auto-pick path.
	const chain = findFastModelChain(registry, undefined, undefined, undefined, Date.now(), true);
	const keys = chain.map((m) => modelKey(m));
	assert.ok(keys.includes("freeride/auto"), "free-only auto-pick must surface freeride/auto");
	assert.ok(!keys.includes("openrouter/auto"), "free-only auto-pick must exclude the paid openrouter/auto duplicate");
});

test("findFastModelChain: free-only auto-pick still filters an automatic (session) layer to free models", () => {
	const registry = mockRegistry([freerideAuto]);
	// sessionModel is paid -- must be dropped from the auto layer under free-only.
	const chain = findFastModelChain(registry, undefined, openrouterAuto, undefined, Date.now(), true);
	const keys = chain.map((m) => modelKey(m));
	assert.ok(!keys.includes("openrouter/auto"), "paid session model must be excluded under free-only auto-pick");
	assert.ok(keys.includes("freeride/auto"));
});

test("findFastModelChain: manual override is never filtered by free-only mode, even if paid", () => {
	const registry = mockRegistry([openrouterAuto, freerideAuto]);
	const chain = findFastModelChain(registry, "openrouter/auto", undefined, undefined, Date.now(), true);
	assert.equal(chain[0]!.provider, "openrouter", "explicit manual override is sacred and survives free-only filtering");
});

// ── isFreeModel sanity (used directly by free-only filtering above) ─────

test("isFreeModel: zero cost across the board is free", () => {
	assert.equal(isFreeModel(freerideAuto), true);
});

test("isFreeModel: nonzero input/output cost is not free", () => {
	assert.equal(isFreeModel(openrouterAuto), false);
});

// ── listAvailableFastModels: provider/id keys in the lister output ──────
//
// The lister ranks fast-named then free models ahead of the rest (see
// recap.ts); an id-less-fast, cost-only-free pair of "auto" duplicates
// exercises the free-branch while forcing distinct provider/id keys.

test("listAvailableFastModels: duplicate free bare ids surface as distinct provider/id keys", async () => {
	const registry = mockRegistry([freerideAuto, vertexFreeAuto]);
	const keys = await listAvailableFastModels(registry as unknown as ModelRegistry, { freeOnly: false });
	assert.deepEqual(
		[...keys].sort(),
		["freeride/auto", "vertex/auto"].sort(),
		"lister must key duplicate bare ids by provider/id so both are distinguishable",
	);
});

test("listAvailableFastModels: freeOnly drops the paid duplicate and keeps the free provider/id key", async () => {
	const registry = mockRegistry([openrouterAuto, freerideAuto]);
	const keys = await listAvailableFastModels(registry as unknown as ModelRegistry, { freeOnly: true });
	assert.deepEqual(keys, ["freeride/auto"]);
});

test("listAvailableFastModels: drops entries whose auth fails to resolve, keyed by provider/id not bare id", async () => {
	const registry = mockRegistry([freerideAuto, vertexFreeAuto], (key) => key !== "freeride/auto");
	const keys = await listAvailableFastModels(registry as unknown as ModelRegistry, { freeOnly: false });
	assert.deepEqual(keys, ["vertex/auto"], "auth-less freeride/auto must be filtered out of the lister despite sharing bare id 'auto' with vertex/auto");
});

// ── runner ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	let failures = 0;
	for (const { name, fn } of tests) {
		try {
			await fn();
			console.log(`ok - ${name}`);
		} catch (err) {
			failures++;
			console.error(`FAIL - ${name}`);
			console.error(err instanceof Error ? (err.stack ?? err.message) : err);
		}
	}
	console.log(`\n${tests.length - failures}/${tests.length} passed`);
	if (failures > 0) {
		process.exitCode = 1;
	}
}

main();
