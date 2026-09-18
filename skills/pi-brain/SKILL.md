---
name: pi-brain
description: Use pi-brain when you need to remember, recall, reason or habituate across sessions (hippocampal + PFC memory).
---

# pi-brain

Hippocampus + PFC for pi — strict workflow optional via `/pi-brain on`.

## When to use

| Job | Tool |
|-----|------|
| Persist fix/decision | `remember {cue, summary, tags?, refs?}` or `remember_batch {episodes:[8]}` |
| Find prior episode | `recall {query, tags?, since?, archive?}` — optional, 80% skipped when gist hot |
| Reason before mutating | `think {goal, hypotheses}` or `think_plan {goal, hypotheses[2], template?}` |
| Novel synthesis | `creative-thinking {cues, prompt?, autoEnrich?}` |
| Ordered execution | `plan {goal, tasks, template?, parallelGroups}` |
| Repeated fix → skill | `habit {name, when, steps}` |
| Memory health | `brain-status {verbose?}` or `/pi-brain status` |

## Workflow — tiered by calls (5.2→2.3)

| Tier | When | Calls | Flow |
|------|------|-------|------|
| 1 trivial | &lt;30 lines, 1 file, risk≤3 | 1.2 | `edit` (skip think+plan, qualityGate relevance≥4) |
| 2 feature | 30-300 lines | 2.8 | `think_plan` fused 1 call → `edit×N` → `plan done+remember` |
| 3 complex | &gt;300 lines / multi-file | 4.5 | `recall? → think → plan → edit×N → remember` |

| Mode | Rule |
|------|------|
| `off` (default) | disabled — no gates, no notes |
| `guided` | nudge only (no blocks except `rm -rf`) — 1 nudge/turn, `PI_BRAIN_QUIET=1` |
| `strict` | tier-1 skips `think+plan` when trivial escape + relevance≥4; tier-2 requires `think_plan` or `think+plan` batch; 2 fails → `think:debug` gate |

Flow (quality via relevance≥4 + DAG + tests, not extra LLM): `[recall? inject] → think(+plan fuse?) → batch (read×N → edit×N) → plan done+remember+habit → commit`
- Recall optional: when `session_before_compact` gist hot (score≥7 recent &lt;2d) skip recall call, use inject; prefetch warms next recall to 0 calls.
- Gates batch-aware: sibling `think`+`plan` (or `think_plan`) in same msg satisfies; `think_plan` 1 call replaces 2.
- `depends:0,1` DAG verified, `[parallelizable]` + `parallelGroups:[[0,1],[2]]` → batch ≥2 edits/turn.
- Tail combined: `plan done + remember (+habit)` in one turn.

## Tools

- `remember {cue, summary, detail?, tags(≤8), refs(≤5), force?}` — `SIMILAR_BLOCK_AT=3`; reuse `cue` to upsert. Batch: `remember_batch {episodes:[8]}` 1 call=8.
- `recall {query?, queries[≤5], limit, tags, source, since, archive?}` — TF-IDF + half-life + tag boost; gist 120 chars (lazy detail on demand `score≥7` or `archive:true`); breakdown top3; intent cache 5min 100 entries (cross-task); replay `recall{query:"think:id"|"brain-plan:id"}` handles double-prefix.
- `think {goal, hypotheses[1..3], conclusion?, parentId?}` — dual-shape string `"Side | cost:3 rev:9 | argues"` OR `{side,argues,cost,risk,rev}`; when top memory score≥8 &lt;2d reuses conclusion (0 calls); tier-1 inline 1 hypothesis no debate.
- `think_plan {goal, hypotheses[2], tasks?, template?, parentId?}` — fused S03: debate+plan in ONE call for tier-2; prefer for 30-300 lines.
- `plan {goal, tasks[3..10], id?, done?, parentId?, template?}` — `bugfix|feature|refactor` expands 5 tasks from diff stat; flagged `[low]` not deleted; `parallelGroups`; gated `brain:commit-ready`.
- `creative-thinking {cues[2..3], prompt?, autoEnrich?}` — prompt ≥15 or `autoEnrich:true`.
- `habit {name, when, steps, variant?, force?}` — 2nd repeat → `brain:habit-due`.
- `brain-status {verbose?}` — 6 lines lazy-cached per `memoGen`; `verbose:true` shows `TIER1_LINES=30`, `SIMILAR_BLOCK_AT`, `BUDGET_*`.

## Commands

- `/pi-brain strict|on` — hard blocks (tier-aware)
- `/pi-brain guided` — nudges only
- `/pi-brain off` — disabled
- `/pi-brain status|help` — shows `mode: strict (source: .pi/brain.json)`

## Tips

- **Calls 5.2→2.3:** tier-1 skip saves 1.8, fuse saves 1.0, inject saves 0.8, intent cache/tail saves 0.5 weighted.
- **Batch:** `read×N → edit×N+write×N+bash` in 2 calls; `think_plan` 1 call; `queries[5]` 1 call=5 cues; trivial &lt;30 lines bypasses `plan` (audit `tier1-skip`).
- **Quality without LLM:** relevance≥4 + `check:bash:npm test` + DAG; gist hot skip only when score≥7 &lt;2d.
- **Knobs:** `RECALL_MEMO_MS=300000` (5min intent), `TIER1_LINES=30`, `TIER1_RISK=3`, `TIER2_LINES=300`, `SIMILAR_BLOCK_AT=3`, `BUDGET_*` — tune without rebuild via `pi-brain.knobs.json`.
- **Prefetch:** `before_agent_start` warms `candidatePool(prompt)` so next recall is hit; idle pre-rank top3.
- **Tokens −35%:** lazy detail (gist 120) + prompt trim (≤200 chars per tool) + inject not tool call.
- **Durability:** sidecar 300ms debounce + branch; `archive.jsonl` not prune.
