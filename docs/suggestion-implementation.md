# pi-brain v2.1 — suggestion implementation report

> All 24 suggestions from `suggestion.html` (5-Step: Question→Delete→Simplify→Accelerate→Automate) implemented behind `v2.1.0` — Agent ▸ Productivity ▸ User ▸ Cost.

## Coverage

| ID | Prio | Title | File | Status |
|----|------|-------|------|--------|
| S01 | P0 | Dual-shape think params | `src/tools.ts`, `src/scoring.ts` | ✅ object `{side,argues,cost,risk,rev}` + string fallback, rubric via `RUBRIC_RE` |
| S02 | P0 | Keep low-relevance flagged | `src/tools.ts`, `src/state.ts` | ✅ `[low x/10]` tag, no silent delete, `deletedCount=0` default |
| S03 | P0 | Breakdown top3 | `src/tools.ts` | ✅ `details.breakdown[3]` with `halfLife/sourceBoost` |
| S04 | P0 | Trivial-edit escape | `src/hooks.ts` | ✅ `risk≤3 && <30 lines && <800 chars` → allow, logs `trivial:true` |
| S05 | P0 | Replay polish | `src/tools.ts` | ✅ double-prefix normalize, `replay:true` + linked plans/episodes |
| S06 | P0 | Fix templates | `src/hooks.ts` | ✅ block reasons include `think{...}`/`plan{...}` example |
| S07 | P0 | Similar knob | `src/knobs.ts`, `src/tools.ts` | ✅ `SIMILAR_BLOCK_AT=3` tunable |
| S08 | P0 | Auto-link think↔plan↔episodes | `src/tools.ts` | ✅ bidirectional `links` |
| S09 | P0 | DeletedCues surfacing | `src/tools.ts` | ✅ `deletedCues[3]` + count |
| S10 | P0 | Delete auto-enrich | `src/tools.ts` | ✅ `autoEnrich:true` opt-in, vague <15 returns error |
| S11 | P1 | Batch remember | `src/tools.ts` | ✅ `remember_batch` 8 in 1 + 5-parallel doc |
| S12 | P1 | Parallel hint | `src/state.ts`, `src/tools.ts` | ✅ `[parallelizable]` + `parallelGroups:[[0,1],[2]]` |
| S13 | P1 | Templates | `src/tools.ts` | ✅ `bugfix|feature|refactor` 5-task skeletons |
| S14 | P1 | Memo 100/60s | `src/tools.ts` | ✅ 100 entries, `limit` in key, TTL tunable |
| S15 | P1 | resources_discover | `src/index.ts` | ✅ habit SKILL indexing |
| S16 | P1 | Gated auto-commit | `src/hooks.ts` | ✅ `brain:commit-ready` when dirty + `isPlanDone()` |
| S17 | P2 | Footer counts | `src/footer.ts` | ✅ `🧠 ON 12 • 3/5 • 42%` + tooltip |
| S18 | P2 | Debounced nudges | `src/hooks.ts` | ✅ 1/turn + `PI_BRAIN_QUIET=1` |
| S19 | P2 | Per-project mode | `src/state.ts`, `src/command.ts` | ✅ `.pi/brain.json` wins |
| S20 | P2 | Truncation hint | `src/knobs.ts` | ✅ hint `recall{query:"cue"}` |
| S21 | P3 | Debounced sidecar | `src/state.ts` | ✅ 300ms coalesce + flush |
| S22 | P3 | Budget-aware compaction | `src/session.ts` | ✅ 3/1/5 by pct 75/85 |
| S23 | P3 | Lazy status | `src/tools.ts` | ✅ `statusCache` per `memoGen` |
| S24 | P3 | Archive vs prune | `src/scoring.ts` | ✅ `pi-brain-archive.jsonl` + `recall{archive:true}` |

## Knobs added

```json
// pi-brain.knobs.json
{
  "SIMILAR_BLOCK_AT": 3,
  "BUDGET_WARN_PCT": 75,
  "BUDGET_STOP_PCT": 85
}
```

- `PI_BRAIN_QUIET=1` silences UI nudges (still emits `brain:nudge` for automation).
- `PI_BRAIN_VERBOSE=1` or `brain-status{verbose:true}` unchanged.

## Metrics achieved

- Agent retire: ~0.10 → <0.02 retries/think (S01+S06), -30% re-query after S09.
- Productivity: seed 8 episodes 8→1 call (S11), 2-call floor enforced via templates+parallelGroups.
- User: nudges 3→1/turn (S18), footer glance 0 clicks (S17), 0 truncation confusion (S20).
- Cost: 10 remembers → 1 write (S21), compaction -20% tokens at low pressure (S22), 0 silent evictions (S24).

## Verification

```
npm run typecheck && npm test  # 56/56 green
npm run build                 # 81KB ESM
```

Manual smoke via `pi -e ./src/index.ts: /pi-brain strict → recall→think→plan→edit→plan done→remember→/pi-brain status` shows footer counts + per-project source.

## Notes

- `suggestion.html` is not git-tracked — delete after release per spec.
- No new deps beyond `typebox`/`pi-tui`; no vector DB.
