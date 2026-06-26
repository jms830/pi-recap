/**
 * Pure model-picker logic for recap streams (v6, 4-layer chain).
 *
 * The chain (top-to-bottom, every layer skips blacklisted ids):
 *   1. user-locked override (modelOverride / preferredId)        -- never blacklisted
 *   2. cached winner with 24h TTL (cachedWinner.id)              -- skipped if expired or blacklisted
 *   3. CURATED_CHAIN (imported from pi-bench)                    -- skipped if blacklisted
 *   4. ctx.model (the user's session model)                      -- sacred fallback
 *
 * Free-only auto-pick mode filters automatic layers (cached, curated, session)
 * to zero-cost models. Manual override remains explicit and sacred.
 */
import { isCachedModelFresh } from "../state/state.js";
import { isBlacklisted } from "../state/blacklist.js";
import { CURATED_CHAIN } from "pi-bench";
export function thinkingOffOpts(model) {
    switch (model.api) {
        case "anthropic-messages":
            return { thinkingEnabled: false };
        case "google-generative-ai":
        case "google-vertex":
            return { thinking: { enabled: false } };
        default:
            return {};
    }
}
// ── CURATED CHAIN ──────────────────────────────────────────────────────
//
// Imported from pi-bench (the source of truth for bench data).
// Run a new bench → pi-bench updates CURATED_CHAIN → pi-recap picks it up.
export { CURATED_CHAIN };
export function isFreeModel(model) {
    const cost = model.cost;
    if (!cost)
        return false;
    // A model with zero input+output cost is free. Cache pricing is often
    // undefined on free tiers (e.g. OpenRouter ":free", gemini free) — treat
    // missing cache costs as zero so they aren't wrongly excluded.
    const zeroish = (v) => v === undefined || v === 0;
    return cost.input === 0 && cost.output === 0 && zeroish(cost.cacheRead) && zeroish(cost.cacheWrite);
}
export function isFastRecapModelId(id) {
    const lower = id.toLowerCase();
    const hasMini = lower.includes("mini") && !lower.includes("gemini");
    return lower.includes("flash") || hasMini || lower.includes("haiku") || lower.includes("turbo") || lower.includes("lite") || lower.includes(":free");
}
/**
 * Resolve auth across runtimes. Vanilla pi exposes getApiKeyAndHeaders(model);
 * the @oh-my-pi fork exposes only getApiKey(model). The fork's stream() merges
 * model-defined headers automatically, so an empty headers map is correct there.
 */
export async function resolveModelAuth(registry, model) {
    if (typeof registry?.getApiKeyAndHeaders === "function") {
        try {
            const r = await registry.getApiKeyAndHeaders(model);
            return { ok: Boolean(r?.ok && r?.apiKey), apiKey: r?.apiKey, headers: r?.headers ?? {} };
        }
        catch {
            return { ok: false, apiKey: undefined, headers: {} };
        }
    }
    if (typeof registry?.getApiKey === "function") {
        try {
            const apiKey = await registry.getApiKey(model);
            return { ok: Boolean(apiKey), apiKey, headers: {} };
        }
        catch {
            return { ok: false, apiKey: undefined, headers: {} };
        }
    }
    return { ok: false, apiKey: undefined, headers: {} };
}
function resolveModel(available, byId, id) {
    const target = byId.get(id);
    if (target)
        return target;
    const normalized = id.replace(/\./g, "-");
    return available.find((m) => m.id === normalized ||
        m.id.endsWith("." + normalized) ||
        m.id.endsWith("." + id) ||
        m.id.endsWith("-" + id));
}
/**
 * Build the v6 ordered fallback chain.
 *
 * In free-only auto-pick mode, the manual override remains first if present;
 * all automatic fallbacks are filtered to zero-cost models.
 */
export function findFastModelChain(registry, preferredId, sessionModel, cachedWinner, now = Date.now(), freeOnlyAutoPick = false) {
    const available = registry.getAvailable();
    const byId = new Map();
    for (const m of available)
        byId.set(m.id, m);
    const seen = new Set();
    const chain = [];
    const push = (m, source) => {
        if (!m)
            return;
        if (source === "auto" && freeOnlyAutoPick && !isFreeModel(m))
            return;
        if (seen.has(m.id))
            return;
        seen.add(m.id);
        chain.push(m);
    };
    // Layer 1: user override. Never blacklist-checked here -- sacred.
    if (preferredId)
        push(resolveModel(available, byId, preferredId), "manual");
    // Layer 2: cached winner with 24h TTL. Skip if expired or blacklisted.
    if (isCachedModelFresh(cachedWinner, now) && cachedWinner && !isBlacklisted(cachedWinner.id)) {
        push(resolveModel(available, byId, cachedWinner.id), "auto");
    }
    // Layer 3: curated chain. Skip blacklisted.
    for (const id of CURATED_CHAIN) {
        if (isBlacklisted(id))
            continue;
        const resolved = resolveModel(available, byId, id);
        if (resolved && !isBlacklisted(resolved.id))
            push(resolved, "auto");
    }
    // Free-only mode needs live free fallbacks even when pi-bench has not
    // benchmarked that provider yet. Keep them after curated entries so bench
    // ranking still wins when present.
    if (freeOnlyAutoPick) {
        const freeLive = available.filter((m) => isFreeModel(m) && !isBlacklisted(m.id));
        freeLive.sort((a, b) => Number(isFastRecapModelId(b.id)) - Number(isFastRecapModelId(a.id)));
        for (const model of freeLive)
            push(model, "auto");
    }
    // Layer 4: sessionModel. Sacred from blacklisting, but still automatic.
    push(sessionModel, "auto");
    return chain;
}
