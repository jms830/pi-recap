# pi-recap project notes

## Architecture
- `pi-recap` is a pi extension that provides AI-powered conversation recaps
- State persistence is dual: per-branch via `pi.appendEntry("recap", ...)` and global via `$XDG_STATE_HOME/pi-recap/state/config.json` (defaults to `~/.local/state/pi-recap/...`; falls back to the legacy `~/.pi/agent/extensions/pi-recap/state/config.json` when present)
- The StatusWidget renders in the terminal via pi-tui; it's reused across sessions (`??=` in `session_start`)

## Model identity: persist provider/id, resolve legacy bare IDs
The model object has separate `provider` and `id` fields. Persist and display the canonical key as `provider/id` (for example `freeride/auto`) so duplicate bare IDs from different providers do not collide.

The bench CSV and `CURATED_CHAIN` still use **bare handles** like `claude-haiku-4.5`, and old saved state may also contain bare IDs.

**Resolution strategy** (in `subagent/picker.ts:resolveModel()` and `index.ts:resolveModelId()`):
1. Exact `provider/id` match first
2. Legacy bare `id` match
3. Normalize dots to dashes (`claude-haiku-4.5` → `claude-haiku-4-5`)
4. Suffix match against registry IDs / provider keys

Applied in:
- `/recap → model` list: returns provider/id keys from `listAvailableFastModels()`
- Bench handler (index.ts): resolves before saving `modelOverride`
- Picker Layer 1 (user override): provider/id disambiguates duplicate bare IDs; legacy bare IDs still work
- Picker Layer 2/3 cache + curated chain: fallback resolution so old cached winners and pi-bench handles still work
- Regression coverage: `test-picker.ts`

## Widget rendering pause pattern
To prevent the StatusWidget animation timer from painting over custom UI overlays:
- `pauseRendering()` before showing overlay (atomically sets flag, clears benchLines, stops timers, forces redraw)
- `resumeRendering()` after overlay is dismissed (only clears flag, no eager update())
- **Never** call `setBenchProgress(undefined)` immediately before `pauseRendering()` — it triggers a premature `update()` that races with the overlay

## Global config persistence
- `state/config.ts` stores global model override under the XDG state dir (`$XDG_STATE_HOME/pi-recap/state/config.json`, default `~/.local/state/...`), with `PI_RECAP_HOME` override and legacy `~/.pi/...` fallback
- Loaded on `session_start` if per-branch replay has no modelOverride
- Saved whenever user picks a model from bench or `/recap` menu
- `fireSessionStartNotice` must fire AFTER global override commit (reads state, needs fresh modelOverride)

## Known issues (latent)
- **Blacklist ID format mismatch**: blacklist stores bare handles (`gemini-1.5-flash`), but cached winners are now saved as registry IDs (`anthropic.claude-haiku-4-5-20251001-v1:0`). `isBlacklisted(cachedWinner.id)` in picker Layer 2 will never match. Low priority — seed blacklist only contains retired Gemini models, not cached winners. Fix by normalizing IDs in `isBlacklisted()`.

## Conventions
- Never put AI as coauthor/author in commits, package manifests, or READMEs
- Less code is better — prefer deleting 50 lines and adding 10 over adding 30 on top
