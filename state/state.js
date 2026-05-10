/**
 * State types for pi-recap.
 *
 * Each HistoryEntry is the unit the widget renders. Streaming uses
 * `streaming: true` plus the running raw text in `recap`. When a stream
 * completes, the orchestrator commits cleaned text and clears the flag,
 * which kicks the widget into a short "settle" animation.
 *
 * Multiple entries may have streaming = true at the same time (a user
 * recap and an agent recap can overlap). Animation state hangs off the
 * entry id, not a shared slot.
 *
 * v5 changes:
 *   - cachedRecapModel / cachedGoalModel are now objects with a `cachedAt`
 *     epoch ms so the picker can expire stale winners after 24h.
 *   - notice (transient, NOT persisted) drives the session-start toast in
 *     the title-right slot. Cleared by an animation tick after expiresAt.
 */
export const EMPTY_STATE = {
    goal: "",
    goalSource: "auto",
    goalAutoTurnsApplied: 0,
    status: "",
    history: [],
    nextId: 1,
};
/** TTL for cached winners. Beyond this, the cache is treated as expired
 *  by the picker so the next stream re-walks the curated chain. */
export const CACHED_MODEL_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * True if a cached entry is non-null and within TTL. Used by the picker
 * to decide whether to hoist the cached id to layer 2.
 */
export function isCachedModelFresh(cached, now = Date.now()) {
    if (!cached)
        return false;
    if (typeof cached.cachedAt !== "number" || cached.cachedAt <= 0)
        return false;
    return (now - cached.cachedAt) < CACHED_MODEL_TTL_MS;
}
