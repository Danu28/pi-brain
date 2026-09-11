---
name: pi-brain
description: Use pi-brain when you need to remember, recall, reason or habituate across sessions (hippocampal + PFC memory).
---

# pi-brain

Brain-inspired memory for pi. One file, one Map — now with recall 2.0 + incremental index + gated inject.

## When to use

- Persist a decision/fix across fork/resume/compact → `remember` (with tags/refs)
- Find a prior fix/episode → `recall` (TF-IDF + tag boost + half-life + filters)
- Reason explicitly before acting → `think` (deliberation scratchpad) or single-shot `plan{hypotheses}`
- Combine distant ideas for novelty → `synthesize` (alias `combine` for compat)
- Repeated correction → `habit` (+ preview + undo hint)
- How full is memory → `brain_status` or `/pi-brain status` dashboard

## Tools

- `remember {cue, summary, detail?, tags?: string[] (≤8 kebab), refs?: string[] (≤5 files)}` — durable episode (`brain:episode` entry). Tags weight 1.5× in recall, refs show in TUI.
- `recall {query, limit?, tags?: string[], source?: "remember"|"auto", since?: "7d"|"24h"|ms|ISO}` — TF-IDF ranked recall (cue 2×, summary 1×, detail 0.5× per term + tag boost + half-life 0.95/7d). Empty query + tags allowed (tag-only). Incremental token→ids index, fallback scan.
- `think {goal, hypotheses[], conclusion?}` — PFC deliberation, injected next turn via `before_agent_start`. Unhappy path: goal must start with `debug`.
- `plan {goal, tasks[], id?, done?, hypotheses?: string[]}` — ordered checklist after think+synthesize (`[ ] Task 1` → `[x] Task 1` via `plan{id,done:[0]}`), `brain:plan` entry. Single-shot: include `hypotheses` to auto-create deliberation (2 calls → 1). When all [x], `bash: git init if needed + commit`. Auto-link: when all done + hasWriteEdit, turn_end surfaces prefilled `remember` template.
- `synthesize {cues: [2-3], prompt?}` / `combine` alias — divergent synthesis fusing episodes + latest `think`. Prompt e.g. `synthesize neon + login into glass login` NOT `creative approach`; loose/missing auto-enriched with cues+think goal.
- `habit {name, when, steps, variant?, force?: boolean}` — draft `.pi/skills/brain-<name>/SKILL.md`; `variant` adds alternative. Preview: if exists returns diff + "call again with force:true to confirm"; reports sanitized name + `rm -r` undo hint. Blocked if project untrusted.
- `brain_status {}` — dashboard table: episodes | deliberations | plan | tokens | overload | recent cues + index stats; emits `brain:overload` if >80% or episodes>50.

> 8 tools total (remember/recall/think/synthesize+combine alias/plan/habit/brain_status — 7 impls, 2 names for one). **Recall 2.0:** filters `tags/source/since` AND with query, half-life decay, tag boost, tag-only recall, incremental `Map<token,Set<id>>` updated on encode. **Gated inject:** strict: scored up to 5 (1 if no match) + trace; default: 1 episode +1 deliberation gated (~250 tokens saved/turn). **Single-shot:** `plan{hypotheses}` creates deliberation (2→1). **Compact:** <15→3 else 5, overload→5. **Trim:** `context` dedups duplicate episode blocks then tails to 20.

## Command

- `/pi-brain on` — strict mode: all queries answered **only** from brain episodes (scored recall injected + systemPrompt clamp; no external knowledge). Persisted as `brain:mode` entry, survives fork/resume.
- `/pi-brain off` — default pi behavior (relevance-gated 1–2 injection).
- `/pi-brain status` (or bare `/pi-brain`) — dashboard table: episodes, deliberations, plan, tokens, overload, recent cues, index stats.

## Behavior

- Default (`off`): gated 1 episode +1 deliberation auto-inject via `before_agent_start` (strict gets up to 5 scored).
- Strict (`on`): 7-rule workflow enforced by extension (not docs): **Happy: recall → think → [synthesize/combine if novel] → plan → execute → plan.done → remember → habit → git commit**
  **Unhappy (on ANY failure): same flow, but failure → think{goal:'debug <Task N> — <tool>: <err>', hypotheses:[cause,fix]} → update plan → retry (enforced: `tool_call` blocks write/edit/bash until debug-think, block message includes template + failedTool + error snippet).**
  1. **Recall-first** — `before_agent_start` scores TF-IDF top-5 + decay for prompt + `systemPrompt` clamp (`ONLY from episodes, cite cue`). Empty query allowed; tag filter intersects.
  2. **Think-before-act** — `tool_call` blocks `write/edit` until `think{goal,hypotheses}` or `plan{hypotheses}` called (per-agent run).
  3. **Combine-only-for-novelty** — prompt instructs: `synthesize`/`combine` for creative/novel tasks, skip for CRUD/bugfix (before plan to get all inputs). Now fuses `think` deliberation + episodes.
  4. **Plan-after-inputs** — `think` (+ `synthesize/combine` if used) → `plan{goal,tasks[]}` creates `[ ]` list; single-shot `plan{hypotheses}` allowed; mark `[x]` via `plan{id,done:[i]}`; latest plan auto-injected. All-done → prefilled `remember` hint.
  5. **Shortest-diff** — prompt instructs: read target → edit one file → bash verify, no scaffolding.
  6. **Encode** — `tool_result` auto-encodes `write/edit/bash` with indexed episode; `turn_end`/`agent_end` nudges if `remember`/`habit` not called; 2nd repeat → `habit`; habit preview checks collision.
  7. **Git** — when plan 2/2 done + remember done, `bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>'` (auto-init first time, skip if no changes).
  Rebuilt from `brain:mode` + `brain:plan` on `session_start` (branch-durable, index rebuilt).
- `edit/write/bash` auto-encode (indexed); `bash` error hints recall with failedTool snippet; `rm -rf` confirm.
- Compaction injects top 3 if <15 else 5; overload keeps 5.
- `context` dedups duplicate episode blocks then prunes >40 msgs / >30KB → system + last 20.

## Calibration knobs (top of index.ts)

`MAX_BYTES`/`MAX_LINES` (50KB/2K), `TAG_BOOST=1.5`, `HALF_LIFE_DAYS=7`, `HALF_LIFE_FACTOR=0.95`, `DEFAULT_INJECT_COUNT=1`, `DEFAULT_INJECT_SCORED=2`, `COMPACT_SMALL=3`, `COMPACT_LARGE=5` — tune without code change.

## Quickstart (60s)

```
remember { cue:"my-fix", summary:"lazy-load DB pool fixes cold start", tags:["infra"], refs:["pi-brain/index.ts"] }
recall { query:"cold start", tags:["infra"], since:"7d", limit:3 }  // tag-only: recall { query:"", tags:["landmine"] }
plan { goal:"fix cold start", hypotheses:["pool eager","lazy-load"], tasks:["fix pool","bash verify"] } // single-shot saves think
```
Cue cheat sheet: `kebab-short` (2×), tags for grouping, refs for file jump, since filters recency, half-life auto-decays stale.
