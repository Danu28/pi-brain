---
name: pi-brain
description: Use pi-brain when you need to remember, recall, reason or habituate across sessions (hippocampal + PFC memory).
---

# pi-brain

Hippocampus + PFC for pi — strict workflow optional via `/pi-brain on`.

## When to use

| Job | Tool |
|-----|------|
| Persist fix/decision | `remember {cue, summary, tags?, refs?}` |
| Find prior episode | `recall {query, tags?, since?}` |
| Reason before mutating | `think {goal, hypotheses}` |
| Novel synthesis | `creative-thinking {cues}` |
| Ordered execution | `plan {goal, tasks}` |
| Repeated fix → skill | `habit {name, when, steps}` |
| Memory health | `brain-status {verbose?}` or `/pi-brain status` |

## Workflow

| Mode | Rule |
|------|------|
| `off` (default) | disabled — no gates, no notes |
| `guided` | nudge only (no blocks except `rm -rf`) |
| `strict` | hard blocks: `plan` gated on `think`, `write/edit` gated on `think+plan`, 2 fails → `think:debug` gate |

Flow: `[recall?] → think → [creative-thinking] → plan → batch (read×N → edit×N) → plan done → remember → habit → commit`

- Recall is **optional** (never blocks).
- Gates are **batch-aware** — sibling `think`/`plan` in same message satisfies.
- `depends:0,1` must be earlier indices; DAG verified, blocked task shows waiter hint.
- `edit/write/bash` sets `hasWriteEdit`; `turn_end` nudges `remember` when plan done.
- `habit` preview on collision; `force:true` to overwrite.

## Tools

- `remember {cue, summary, detail?, tags(≤8 kebab), refs(≤5), force?}` — QDS scored; duplicate/similar audited. Tip: reuse `cue` to update, `force:true` or rename to `cue-v2` to force new.
- `recall {query?, queries[≤5], limit, tags, source, since}` — TF-IDF + half-life + tag boost; breakdown shown for top 2; memo 30s; graph links to think/plan (replay via `recall{query:"think:id"}`).
- `think {goal, hypotheses[1..3], conclusion?, parentId?}` — debate graph: rubric `cost/risk/rev` (single-pass parse, any order), winner pinned, QDS <4 hidden.
- `plan {goal, tasks[3..10], id?, done?, parentId?}` — QDS scored, debate-linked, depends-verified; commit hint when all done.
- `creative-thinking {cues[2..3], prompt?}` — fuses episodes + latest think; loose prompt auto-enriched.
- `habit {name, when, steps, variant?, force?}` — scaffolds `.pi/skills/brain-<name>/SKILL.md`; emits `brain:habit-due` on 2nd similar `remember`.
- `brain-status {verbose?}` — collapsed default (6 lines); `verbose:true` adds gist/knobs/budget/compaction.

## Commands

- `/pi-brain strict|on` — hard blocks (file wins, branch-persisted)
- `/pi-brain guided` — nudges only
- `/pi-brain off` — disabled
- `/pi-brain status|help` — dashboard (same output)

## Tips

- Cue: `kebab-short` (scores 2×). Tags: `infra`, `landmine`. Refs: file paths for jump.
- Batch: `read×N` → `edit×N+write×N+bash` in 2 LLM calls. 1 edit/file, exact `oldText`.
- Knobs: `pi-brain.knobs.json` (cwd or `$PI_CODING_AGENT_DIR`) merges into `src/knobs.ts` defaults; `brain-status(verbose:true)` shows source. SYN: `pi-brain.syn.json` file-only.
- Durability: sidecar `pi-brain-memory.json` + branch (`type:custom`) — file wins; survives compact/fork/tree.
- Tokens: static `[brain:mode]` note (~90) KV-stable; `MAX_BYTES=50KB`/`MAX_LINES=2K`; `PRUNE_CAP=40`.

See `docs/architecture.html` for full lifecycle + brain→pi map.
