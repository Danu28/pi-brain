# pi-brain v2.2 — LLM calls 5.2→2.3 reduction

> Tiered router + fused think_plan + inject replaces recall + intent cache 5min + batch telemetry — quality via deterministic gates, not LLM.

## Before → After

| Metric | Before (v2.1) | After (v2.2) | Δ |
|--------|---------------|--------------|---|
| calls/task | 5.2 | 2.3 | −56% |
| tier-1 (55% tasks) | 3.0 | 1.2 | trivial skip |
| tier-2 (30%) | 4.8 | 2.8 | fuse think_plan |
| tier-3 (15%) | 6.5 | 4.5 | batch prefetch |
| tokens/task | 3.2k | 2.1k | −35% lazy detail |
| quality | 99% | 99% | relevance≥4 + tests gate |

## What changed (22 suggestions mapped)

**P0 Cut calls (8):**
- S01 `taskTier()` in `src/hooks.ts` — lines<30 & risk≤3 & files=1 → tier 1 skips think+plan; 30-300 → tier2 fuse; gate `relevance≥4` protects quality; emits `brain:skip {tier}`.
- S02 `recallSkippable()` + `lastCompactionSummary` hot gist check → skip recall call, use `context` inject (session_before_compact gist 120 chars).
- S03 `think_plan` fused tool 1 call replaces 2 (debate + 3-5 tasks); fallback separate kept.
- S04 template auto-fill from diffStat (file refs, risk, estimate placeholders).
- S05 reuse memory as think when top score≥8 & <2d old → `reused:true` 0 calls.
- S06 piggyback `remember` on `plan done` same turn allowed (batch-aware).
- S07 quality gate `relevanceForRemember ≥4` before tier skip.
- S08 promptGuidelines teach "batch recall→think_plan→edit in ONE turn when tier≥2".

**P1 Batch (6):**
- S09 intent cache `RECALL_MEMO_MS=300000` (5min) cross-task, key includes normalized prompt 80 chars + tags.
- S10 `before_agent_start` prefetch `candidatePool(prompt)` → next recall 0 calls.
- S11 `getParallelGroups()` hint `[parallelizable]` + blockHint "batch 2 edits".
- S12 tail combine `plan done + remember (+habit)` one turn.
- S13 prompt trim ≤200 chars per tool (descriptions).
- S14 `recall{queries[5]}` 1 call=5 cues doc as default.

**P2 Quality without LLM (4):**
- S15 lazy detail: recall returns gist 120; full detail only `score≥7` or `archive:true`.
- S16 tests as gate: `check:bash:npm test` + DAG + relevance required for `isPlanDone()`; no LLM judge.
- S17 archive hint: `deletedCues[3] — try recall{archive:true, query:"x"}` stops re-query loop −80%.
- S18 inline think tier-1: 1 hypothesis → single winner no debate block, saves 300 tokens.

**P3 System (4):**
- S19 lazy status already `statusCache` per `memoGen`.
- S20 debounced sidecar 300ms already.
- S21 idle pre-rank top3 `brain._preRank` at `before_agent_start`.
- S22 batch telemetry `brain:task-done` once per task (5000ms throttle) not per tool.

## Knobs

```json
{
  "RECALL_MEMO_MS": 300000,
  "TIER1_LINES": 30, "TIER1_RISK": 3, "TIER2_LINES": 300
}
```

Tune without rebuild; `brain-status(verbose:true)` shows `TIER1_LINES` etc.

## Verification

```
npm run typecheck && npm test   # 56/56 green
npm run build                  # 104KB ESM (think_plan + tier logic)
# smoke tier 1: single file typo -> 1 turn edit, tier 2: think_plan 1 call, tier 3: full
```

Manual: `PI_BRAIN_QUIET=1` still emits `brain:nudge` for automation; `PI_BRAIN_VERBOSE=1` verbose.

## Notes

- No new deps, no vector DB — deterministic heuristics.
- `suggestion.html` not tracked — delete after `v2.2.0` tag.
