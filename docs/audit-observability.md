# pi-brain Observability Audit — Hidden / Efficiency Shortcuts

> Goal: list every place the extension does work *internally* instead of via an explicit tool/hook call, so tools/hooks do what they claim.
> Generated 2026-09-16 from `src/{index,hooks,inject,session,tools,scoring,state,knobs}.ts` + `skills/pi-brain/SKILL.md`.

## Summary

| # | Category | What happens internally (instead of explicit call) | Where | Explicit tool it shadows | Visibility today | Risk if unobserved |
|---|----------|-----------------------------------------------------|-------|--------------------------|------------------|---------------------|
| 1 | **Auto-recall injection (strict)** | `before_agent_start` runs `rankedEpisodes(query, 3)` → TF-IDF+decay+tagBoost scoring and injects `Brain episodes for query "...":` as hidden `system` message + `STRICT_STABLE_PREFIX` systemPrompt clamp, without caller invoking `recall` | `src/inject.ts:18,32-43` `rankedEpisodes()` | `recall` | No `recall` tool call in transcript; only `message.role=system` delta | Looks like model "knew" episodes; breaks recall-first trace |
| 2 | **Auto-recall injection (default)** | Same hook in default mode injects `Recent brain episodes:` (top-1 scored) + last `think` + active plan as `system` message, gated by token budget | `src/inject.ts:44-62` `budgetTrim()` | `recall` + `think` | No tool call; counted as "recent" but scoring hidden | 1-episode limit invisible; budget trim hides episodes |
| 3 | **Think + Plan single-shot merge** | `plan{goal,tasks,hypotheses:[2-3]}` auto-creates a `Deliberation` entry, sets `thinkSatisfied=true`, emits `brain:deliberation` — replaces explicit `think` call | `src/tools.ts:131-147` `plan` hypotheses branch | `think` | `think` never appears in tool_calls; only `plan` does | Violates "think MUST read then plan" observability if caller skips `think` |
| 4 | **before_provider_request merged away** | `before_provider_request` handler deleted; logic merged into `context` dedup only. Old provider-trim + context-trim were two prunes; now `context` only dedups duplicate `Brain episodes:` blocks, never slices tool pairs | `src/hooks.ts:103` comment + `src/inject.ts:64-81` | `before_provider_request` | No hook fires; invisible window management | Token trim now only via `budgetTrim` + pi compaction; confusion if expecting 20-msg tail |
| 5 | **Auto-encode on `edit`/`write` success** | `tool_result` for `edit`/`write` (non-error) auto-creates `auto` episode `cue="edit:path"` / `write:path`, summary = first 200 chars of result, `expiresAt = now+3d`, indexes it, clears memo, sets `hasWriteEdit=true, hasRemember=false` | `src/hooks.ts:21-26` `encodeAuto()` | `remember` | No `remember` tool call; appears as `brain:episode` branch entry with `source:auto` | Rule 6 "must remember" violated silently; user thinks they remembered but only auto persisted |
| 6 | **Auto-encode on `bash` (noise-gated)** | `tool_result` for `bash` auto-encodes unless `isNoiseBash()` (ls/cat/head/tail/grep/find/echo/pwd/... with <200 chars, git status/diff --stat with <200 chars) — otherwise same auto episode `bash:cmd` | `src/hooks.ts:5-14,27-44` | `remember` | No log; noisy commands silently dropped | Short but important bash outputs (e.g. `ls -la` showing new files) never encoded |
| 7 | **Touch-on-success (re-rank boost)** | If `bash` output matches `/passed|success|fixed|done|ok/` and >20 chars, extension `touch`es best `remember` episode (max `scoreBase(ep,cmd)`) — bumps `ts=now`, clears memo, no new episode | `src/hooks.ts:29-35` | — (recall ranking) | No `brain:episode:encoded` event; silent re-rank | Episodes silently move to top of recall; hard to reproduce ranking |
| 8 | **Post-plan-done bash encode gated** | Same `bash` hook: if `isPlanDone() && hasRemember` then noise `bash` returns without encode; else encodes. Intended to avoid auto noise after task done | `src/hooks.ts:36-44` | `remember` | Conditional branch invisible in transcript | Inconsistent: some successful `bash verify` steps not encoded after plan done |
| 9 | **Recall memoization (30s)** | `recall` caches by `queries+tags+source+since+limit` for `RECALL_MEMO_MS=30000`; `memoHits/misses` tracked, LRU 50 entries; cache busted on any `indexEpisode`/prune | `src/tools.ts:64-65,83` `src/knobs.ts:11` | `recall` scoring | `details.cached:true` only on hit; first call shows full scoring invisibly skipped on hit | Stale results if episodes changed within 30s but index not cleared (edge) |
|10| **Incremental token→ids index** | `indexEpisode`/`unindexEpisode` maintain `Map<token,Set<id>>` on every encode/prune; `recall` + `creative-thinking` + `candidatePool` first probe index, fallback to full scan only if miss | `src/scoring.ts:107-109` `src/tools.ts:68-76` | Full scan `scoreEpisode` over all episodes | No `index` tool; `brain-status` only shows `tokenIndex.size` | Scoring explains but index miss vs hit changes result set |
|11| **Synonym expansion + scoring knobs** | `expandTokens()` injects `SYN` map (`deploy:ship/release`, `bug:fix/error`, `auth:login`, etc.) plus file-loaded `pi-brain.syn.json`; `scoreBase` adds `TAG_BOOST=1.5` per matching tag/term, `scoreEpisode` multiplies `HALF_LIFE_FACTOR=0.5^(age/7d)` and `REMEMBER_BOOST=2.0` vs `AUTO_BOOST=0.6`, `avgIdf` weights query | `src/scoring.ts:27-51,68-100` `src/knobs.ts:6-10` | `recall` ranking | `recall` text shows `score` only on `remember` audit block, not normal recall | Tag-only recall (`query=""`) silently scores via tags; synonym hits invisible |
|12| **Budget-aware injection trim** | `budgetTrim(list,pct)` — if `getContextUsage().percent >85` inject `[]`; if `>75` inject `1` episode only. Applied to both strict top-3 and default top-1 | `src/inject.ts:12,33,50,57-58` `src/knobs.ts:12-13` | — (context window) | No log unless overload; silent truncation | Under high tokens episodes vanish without trace |
|13| **Context dedup (orphan-safe)** | `context` handler dedups duplicate `Recent brain episodes:` / `Brain episodes:` system blocks via `Set`, but explicitly *does not* slice `sys.slice(0,1)+tail(-20)` to avoid orphaning `tool_result` from `tool_calls` (OpenAI 400 fix) | `src/inject.ts:64-81` | `context` window | Only logs when `changed=true`; otherwise no-op | Duplicate strict prefix across turns silently deduped |
|14| **Truncation (50KB / 2000 lines)** | `truncate(text)` caps every `cue/summary/detail`, recall output, think/plan titles to `MAX_BYTES=50KB` + `MAX_LINES=2000` with `[truncated...]` suffix | `src/scoring.ts:41-46` `src/knobs.ts:3-4` | `read` / `remember` input | Adds suffix string; no metric | Long episodes silently clipped before scoring (cue/summary tokens lost) |
|15| **Prune / TTL / overload eviction** | `pruneExpired()` runs on `before_agent_start` if `size>35`, on `session_start` always + if `>40`, clears `expiresAt<now` (auto episodes 3-day TTL) then LRU evicts oldest `auto` first until `PRUNE_CAP=40`; emits `brain:overload` if evicting `remember` | `src/scoring.ts:110-121` `src/inject.ts:28` `src/session.ts:59-61` `src/knobs.ts:9,14-15` | Manual prune | `brain-status` shows counts; `brain:overload` event only on remember eviction | Auto episodes disappear after 3 days without explicit delete |
|16| **Waking rebuild (session_start)** | `session_start` resets brain, replays branch entries `brain:episode`/`brain:plan`/`brain:mode`/`brain:deliberation`/`toolResult(remember)`, `rebuildIndex()`, `pruneExpired()`, file `pi-brain.json` wins over branch | `src/session.ts:29-69` `src/state.ts:12-20` | `recall` persistence | No user call; footer `_brainStrict` set silently | File vs branch conflict resolved silently (file wins) |
|17| **Compaction injection** | `session_before_compact` scored-ranks by last `think.goal` or `plan.goal`, takes top 5, then keeps `3 if ≤15 else 5`, injects `Brain episodes:\n...` into compaction `summary` | `src/session.ts:71-88` `src/knobs.ts:7-8` | `recall` | No tool call; only summary text | Compaction may drop recent `auto` episodes in favor of scored ones |
|18| **Tool-call guards (blocking)** | `tool_call` blocks `write/edit` if `!thinkSatisfied` (strict), blocks `write/edit/bash` if `needsDebugThink` (failure) or `needsPlanUpdate` (debug done, need plan update), plus `rm -rf` guard with `ui.confirm` | `src/hooks.ts:64-95` | `think` / `plan` / `bash` | Returns `{block:true, reason:...}` + `ui.notify` warning — visible as blocked tool call | Block reason only in tool_call rejection, not in transcript history |
|19| **Turn-end Rule-5 nudge** | `turn_end` if `strict && hasWriteEdit && !hasRemember && isPlanDone() && !rule5Warned` then once-per-run `ui.notify` "Strict Rule 5: ... call remember" | `src/hooks.ts:97-101` | `remember` | Only fires once (`rule5Warned`); silent otherwise | Easy to miss if plan not marked done |
|20| **Remember audit (exact vs similar)** | `remember` audits: exact `cue` (case-insensitive) → `upsert` (unindex→update→reindex→appendEntry) with `audit:"exact-cue-upsert"`; else if `scoreBase*avgIdf >=5` top-3 similar `source!="auto"` → `blocked:true` preview unless `force:true` | `src/tools.ts:29-46` | `remember` force flow | Preview returned as text + `details.blocked:true` (not error) but `hasRemember` NOT set (see hooks.ts:48-53) | Looks like success but not persisted |
|21| **Habit preview guard** | `habit` if file exists and `!force` reads `.pi/skills/brain-<name>/SKILL.md` and returns `blocked:true` preview + `variant` hint; also blocks if `isProjectTrusted()===false`; `force:true` overwrites + optional `variant` appends `## Alternative` | `src/tools.ts:132-160` | `habit` write | No file write; preview only | Repeated fix won't habitize until `force:true` |
|22| **Status overload signal** | `brain-status` emits `brain:overload` if `percent>80` or `episodes>50`, shows `Index` + `Gist` + `Knobs` + `Budget` | `src/tools.ts:162-191` | — | `details.overloaded` + event | Pollutes event stream if called frequently |

## What the docs say vs reality (drift)

- `SKILL.md` says strict injection is "scored top-3 (1 if no match) + trace; default: 1 episode +1 deliberation gated (~250 tokens saved/turn)" — true, but `budgetTrim` + `rankedEpisodes` fallback-to-recency is undocumented.
- `SKILL.md` says "before_agent_start (strict/default inject) + context dedup" — correct, but the *deletion* of `before_provider_request` (one prune not two) is only in `hooks.ts:103` comment, not in SKILL.
- `SKILL.md` says "edit/write/bash auto-encode (indexed); bash error hints recall" — auto-encode noise filter + touch-on-success are not in SKILL.
- `README` Strict workflow 2-call/3-call floor is accurate but omits `isNoiseBash` filtering and `post-plan-done` bash gating.

## Recommendations for clear observability

1. **Make auto-recall explicit** — log a synthetic `recall` tool_result (or `events.emit("brain:auto-recall", {query, rankedIds, injected})`) on every `before_agent_start` injection, with `injected: false` when budgetTrim drops to 0. Then filter in TUI but keep in `--verbose`.
2. **Split `plan{hypotheses}` audit** — emit both `brain:deliberation` and `brain:plan` events; include `details.synthesis:"plan+think single-shot"` so transcripts show the hidden think.
3. **Restore `before_provider_request` as no-op log** — keep it deleted for perf but add `events.emit("brain:context", {deduped, trimmed, reason})` in `context` handler when `changed` or `budgetTrim` acts.
4. **Auto-encode transparency** — every `encodeAuto` should `events.emit("brain:auto-encode", {cue, path, truncated, expiresAt})` and `appendEntry` already does; surface in `brain-status` `recent auto` list (already does) plus `notify` opt-in `PI_BRAIN_VERBOSE=1`.
5. **Noise filter visibility** — when `isNoiseBash` drops an encode, emit `brain:skip {reason:"noise", cmd}` instead of silent return; expose via `brain-status` counter `skippedNoise`.
6. **Touch-on-success** — change silent `best.ts=now` to `events.emit("brain:touch", {id, cue, reason:"bash success", cmd})` so recall re-rank is traceable.
7. **Memo hits** — surface `memoHits` in `brain-status` already, but also include `details.cached` on hit; add log line `recall cache hit key=... age=...` when verbose.
8. **Budget trim** — when `pct>75` emit `brain:budget-trim {pct, kept, dropped}`; otherwise injection silently shrinks.
9. **Prune/TTL** — `pruneExpired` already clears memo; add `events.emit("brain:prune", {n, remaining})` (partial); make it `notify` when verbose.
10. **Guard blocks** — `tool_call` blocks already return `reason` but also `ui.notify` only for unhappy path; add same for Rule2 `thinkSatisfied` so transcript shows why blocked without UI.
11. **Rule-5 nudge** — make it fire per `turn_end` until `hasRemember` or add `events.emit("brain:nudge", {rule:5})` so automation can detect.
12. **Single knob surface** — move `SYN` override load to `state.ts` init and log loaded path; today `loadSyn` silently merges `pi-brain.syn.json`.

## Quick grep for auditors

```bash
grep -rn "encodeAuto\|isNoiseBash\|rankedEpisodes\|budgetTrim\|recallMemo\|indexEpisode\|pruneExpired\|expandTokens\|SYN\|before_provider_request" src --include="*.ts" -n
# All shortcuts funnel through: hooks.ts (auto-encode + guards), inject.ts (auto-recall), tools.ts (single-shot + memo), scoring.ts (SYN/boost/decay), session.ts (waking/compaction)
```

## Files

- `src/index.ts:14-18` — wiring (one factory, 4 registrars)
- `src/hooks.ts` — #5,6,7,8,18,19
- `src/inject.ts` — #1,2,4,12,13
- `src/tools.ts` — #3,9,10,20,21,22
- `src/scoring.ts` — #10,11,14,15
- `src/session.ts` — #16,17
- `src/knobs.ts` — tunable thresholds
- `src/state.ts` — singleton + flags (`thinkSatisfied`, `needsDebugThink`, `rule5Warned`)
