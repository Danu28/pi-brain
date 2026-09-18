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
| Find prior episode | `recall {query, tags?, since?, archive?}` |
| Reason before mutating | `think {goal, hypotheses}` |
| Novel synthesis | `creative-thinking {cues, prompt?, autoEnrich?}` |
| Ordered execution | `plan {goal, tasks, template?, parallelGroups}` |
| Repeated fix → skill | `habit {name, when, steps}` |
| Memory health | `brain-status {verbose?}` or `/pi-brain status` |

## Workflow

| Mode | Rule |
|------|------|
| `off` (default) | disabled — no gates, no notes |
| `guided` | nudge only (no blocks except `rm -rf`) — 1 nudge/turn, `PI_BRAIN_QUIET=1` silences UI |
| `strict` | hard blocks: `plan` gated on `think`, `write/edit` gated on `think+plan` (trivial escape: risk≤3+singleFile+<30 lines bypasses), 2 fails → `think:debug` gate |

Flow: `[recall?] → think → [creative-thinking] → plan → batch (read×N → edit×N) → plan done → remember → habit → commit`

- Recall is **optional** (never blocks). Supports `archive:true` to search `pi-brain-archive.jsonl`.
- Gates are **batch-aware** — sibling `think`/`plan` in same message satisfies.
- `depends:0,1` must be earlier indices; DAG verified, blocked task shows waiter hint; parallelizable tasks tagged `[parallelizable]` + `details.parallelGroups`.
- `edit/write/bash` sets `hasWriteEdit`; `turn_end` nudges `remember` when plan done + flushes debounced sidecar (300ms).
- `habit` preview on collision; `force:true` to overwrite. Habits discovered via `resources_discover`.

## Tools

- `remember {cue, summary, detail?, tags(≤8 kebab), refs(≤5), force?}` — QDS scored; `SIMILAR_BLOCK_AT=3` knob; duplicate/similar audited. Tip: reuse `cue` to update, `force:true` or rename to `cue-v2`. Batch: `remember_batch {episodes:[{cue,summary,tags,refs,force?}]}` 1 call=8 encodes.
- `recall {query?, queries[≤5], limit, tags, source, since, archive?}` — TF-IDF + half-life + tag boost; breakdown top 3 with `halfLife/sourceBoost`; memo 60s 100 entries; deletedCues surfaced; replay `recall{query:"think:id"|"brain-plan:id"}` handles double-prefix; bidirectional think↔episode links.
- `think {goal, hypotheses[1..3], conclusion?, parentId?}` — dual-shape: string `"Side | cost:3 risk:2 rev:9 | argues"` OR object `{side, argues, cost?, risk?, rev?}` (prefer object); debate graph: rubric `cost/risk/rev` (single-pass), winner pinned, QDS <4 hidden.
- `plan {goal, tasks[3..10], id?, done?, parentId?, template?}` — `template:bugfix|feature|refactor` expands 5-task skeleton; keeps low-relevance flagged `[low x/10]` not deleted; debate-linked; depends-verified; `parallelGroups:[[0,1],[2]]`; commit hint when all done (gated auto-commit via `brain:commit-ready`).
- `creative-thinking {cues[2..3], prompt?, autoEnrich?}` — fuses episodes + latest think; prompt must be ≥15 chars or `autoEnrich:true` to allow vague.
- `habit {name, when, steps, variant?, force?}` — scaffolds `.pi/skills/brain-<name>/SKILL.md`; emits `brain:habit-due` on 2nd similar `remember`.
- `brain-status {verbose?}` — collapsed default (6 lines, lazy-cached per `memoGen`); `verbose:true` adds gist/knobs/budget/compaction; knobs show `SIMILAR_BLOCK_AT`, `BUDGET_*`.

## Commands

- `/pi-brain strict|on` — hard blocks (file wins, branch-persisted)
- `/pi-brain guided` — nudges only
- `/pi-brain off` — disabled
- `/pi-brain status|help` — dashboard shows `mode: strict (source: .pi/brain.json)` — per-project `.pi/brain.json` wins over global

## Tips

- Cue: `kebab-short` (scores 2×). Tags: `infra`, `landmine`. Refs: file paths for jump.
- Batch: `read×N` → `edit×N+write×N+bash` in 2 calls. `remember_batch` for seeding 8 episodes in 1 call. Trivial single-file <30-line edits bypass strict `plan` gate (audit logged `trivial:true`).
- Knobs: `pi-brain.knobs.json` (cwd or `$PI_CODING_AGENT_DIR`) merges into `src/knobs.ts` defaults; `brain-status(verbose:true)` shows source. SYN: `pi-brain.syn.json` file-only. New knobs: `SIMILAR_BLOCK_AT=3`, `BUDGET_WARN_PCT=75`, `BUDGET_STOP_PCT=85`. `PI_BRAIN_QUIET=1` silences nudges (still emits `brain:nudge`).
- Durability: sidecar `pi-brain-memory.json` debounced 300ms + branch (`type:custom`) — file wins; flush on `turn_end` plan-done + `session_shutdown`. Archive `pi-brain-archive.jsonl` (not prune) — searchable via `recall{archive:true}`.
- Budget: compaction keeps 3 (<75%), 1 (75-85%), 5 (>85%) episodes; gist cap 120 chars + dedup by cue; tokens: static `[brain:mode]` note (~90) KV-stable; `MAX_BYTES=50KB`/`MAX_LINES=2K` truncation now hints `recall{query:"cue"}`; `PRUNE_CAP=40`.
- Footer: `🧠 ON 12 • 3/5 • 42%` collapsed; hover = `mode | episodes | failures | last plan goal`.

See `docs/architecture.html` for full lifecycle + brain→pi map.
