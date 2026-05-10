/**
 * Per-session state map for pi-recap.
 *
 * Each session (keyed by ctx.sessionManager.getSessionId()) gets its own
 * StatusState cell. The active session tracks which session's UI is
 * currently mounted so the widget renders the correct data.
 *
 * Adds per-entry helpers used by the streaming pipeline:
 *   - addStreamingEntry(sessionId, speaker)
 *   - updateEntryText(sessionId, id, text)
 *   - finalizeEntry(sessionId, id, recap, modelId)
 *   - removeEntry(sessionId, id)
 *
 * Cached-winner helpers (v5):
 *   - setCachedRecapModel / clear
 *   - setCachedGoalModel / clear
 *
 * Notice (v5):
 *   - setNotice / clearNotice
 *
 * All helpers take sessionId as the first argument and operate only on
 * that session's state cell. No cross-session bleed.
 */
import { EMPTY_STATE, } from "./state.js";
const sessions = new Map();
/** Which session's UI is currently mounted (the widget renders this one). */
let activeSessionId;
export function getActiveSessionId() {
    return activeSessionId;
}
export function setActiveSessionId(id) {
    activeSessionId = id;
}
/** Get or create a session's state cell. */
function ensureSession(id) {
    let s = sessions.get(id);
    if (!s) {
        s = { ...EMPTY_STATE, history: [] };
        sessions.set(id, s);
    }
    return s;
}
export function getState(sessionId) {
    return ensureSession(sessionId);
}
/** Get state for the currently active session. Convenience for widget render. */
export function getActiveState() {
    if (!activeSessionId)
        return { ...EMPTY_STATE, history: [] };
    return ensureSession(activeSessionId);
}
export function getGoal(sessionId) {
    return ensureSession(sessionId).goal;
}
export function getStatus(sessionId) {
    return ensureSession(sessionId).status;
}
export function getHistory(sessionId) {
    return ensureSession(sessionId).history;
}
export function replaceState(sessionId, next) {
    sessions.set(sessionId, next);
}
export function commitState(sessionId, next) {
    sessions.set(sessionId, next);
}
/** Drop a session's state cell (called on session_shutdown). */
export function dropSession(sessionId) {
    sessions.delete(sessionId);
    if (activeSessionId === sessionId)
        activeSessionId = undefined;
}
export function addStreamingEntry(sessionId, speaker, timestamp = Date.now()) {
    const s = ensureSession(sessionId);
    const id = s.nextId;
    const entry = {
        id,
        timestamp,
        recap: "",
        speaker,
        streaming: true,
    };
    sessions.set(sessionId, {
        ...s,
        history: [...s.history, entry],
        nextId: id + 1,
    });
    return id;
}
export function updateEntryText(sessionId, id, running) {
    const s = ensureSession(sessionId);
    const idx = s.history.findIndex((h) => h.id === id);
    if (idx < 0)
        return;
    const next = s.history.slice();
    next[idx] = { ...next[idx], recap: running };
    sessions.set(sessionId, { ...s, history: next });
}
export function finalizeEntry(sessionId, id, recap, modelId) {
    const s = ensureSession(sessionId);
    const idx = s.history.findIndex((h) => h.id === id);
    if (idx < 0)
        return;
    const next = s.history.slice();
    next[idx] = { ...next[idx], recap, streaming: false };
    sessions.set(sessionId, {
        ...s,
        history: next,
        status: recap,
        lastModel: modelId ?? s.lastModel,
    });
}
export function removeEntry(sessionId, id) {
    const s = ensureSession(sessionId);
    const next = s.history.filter((h) => h.id !== id);
    if (next.length === s.history.length)
        return;
    sessions.set(sessionId, { ...s, history: next });
}
export function seedLastModel(sessionId, id) {
    const s = ensureSession(sessionId);
    if (s.lastModel)
        return;
    sessions.set(sessionId, { ...s, lastModel: id });
}
export function setCachedRecapModel(sessionId, id) {
    const s = ensureSession(sessionId);
    const next = { id, cachedAt: Date.now() };
    sessions.set(sessionId, { ...s, cachedRecapModel: next });
}
export function clearCachedRecapModel(sessionId) {
    const s = ensureSession(sessionId);
    if (!s.cachedRecapModel)
        return;
    sessions.set(sessionId, { ...s, cachedRecapModel: undefined });
}
export function setCachedGoalModel(sessionId, id) {
    const s = ensureSession(sessionId);
    const next = { id, cachedAt: Date.now() };
    sessions.set(sessionId, { ...s, cachedGoalModel: next });
}
export function clearCachedGoalModel(sessionId) {
    const s = ensureSession(sessionId);
    if (!s.cachedGoalModel)
        return;
    sessions.set(sessionId, { ...s, cachedGoalModel: undefined });
}
export function setNotice(sessionId, text, durationMs) {
    const s = ensureSession(sessionId);
    const next = { text, expiresAt: Date.now() + durationMs };
    sessions.set(sessionId, { ...s, notice: next });
}
export function clearNotice(sessionId) {
    const s = ensureSession(sessionId);
    if (!s.notice)
        return;
    sessions.set(sessionId, { ...s, notice: undefined });
}
export function __resetState() {
    sessions.clear();
    activeSessionId = undefined;
}
