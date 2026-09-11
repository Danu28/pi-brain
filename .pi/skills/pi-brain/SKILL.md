---
name: pi-brain
description: Use pi-brain when you need to remember, recall, reason or habituate across sessions (hippocampal + PFC memory).
---

# pi-brain

Brain-inspired memory for pi. One file, one Map — now with reasoning.

## When to use

- Persist a decision/fix across fork/resume/compact → `remember`
- Find a prior fix/episode → `recall` (TF-IDF)
- Reason explicitly before acting → `think` (deliberation scratchpad)
- Combine distant ideas for novelty → `synthesize` (alias `combine` for compat)
- Repeated correction → `habit` (+ mutate variant)
- How full is memory → `brain_status` (emits overload if >80%)

## Tools

- `remember {cue, summary, detail?}` — durable episode (`brain:episode` entry).
- `recall {query, limit?}` — TF-IDF ranked recall (cue 2×, summary 1×, detail 0.5× per term).
- `think {goal, hypotheses[], conclusion?}` — PFC deliberation, injected next turn via `before_agent_start`.
- `plan {goal, tasks[], id?, done?}` — ordered checklist after think+synthesize (`[ ] Task 1` → `[x] Task 1` via `plan{id,done:[0]}`), `brain:plan` entry, TUI `brain:plan` renderer, latest plan auto-injected. When all [x], `bash: git init if needed + commit`.
- `synthesize {cues: [2-3], prompt?}` / `combine` alias — divergent synthesis fusing episodes + latest `think`. Prompt e.g. `synthesize neon + login into glass login` NOT `creative approach`; loose/missing auto-enriched with cues+think goal.
- `habit {name, when, steps, variant?}` — draft `.pi/skills/brain-<name>/SKILL.md`; `variant` adds alternative.
- `brain_status {}` — episodes + tokens + recent deliberations; emits `brain:overload` if >80% or episodes>50.

> 8 tools total (remember/recall/think/synthesize+combine alias/plan/habit/brain_status — 7 impls, 2 names for one). **Fix batch 2:** `remember` id now `cue:ts:rand`, `appendEntry` awaited, `hasRemember` tracked post-success, `think` debug-gated (goal must start with `debug` when unhappy), `plan{goal?,tasks?}` optional on update, habit `toLowerCase` + `isProjectTrusted?.()===false`, `rm` guard covers `-fr`/`--recursive --force`, `before_agent_start` unconditional reset + single `systemPrompt` inject, auto-episode ids collision-free.

## Gaps Fixed

- **B1 over-block** — unhappy path no longer blocks `read`/`recall`; only `write/edit/bash` blocked until debug `think` + `plan` update.
- **B2 timestamp drift** — `before_agent_start` unconditionally resets `thinkSatisfied/needsDebugThink/needsPlanUpdate`; stale deliberations no longer satisfy.
- **B3 tracking** — `hasWriteEdit` moved from `tool_call` to `tool_result` (post-success), correctly counts `bash`.
- **B4 plan id** — `brain-plan:<ts>:<rand>` + normalized dedupe, `appendEntry` awaited, `cachedLatestPlan` avoids per-prompt sort.
- **Unhappy sequence** — `failure → think(debug) → plan{id,done} → retry` enforced via `needsDebugThink` + `needsPlanUpdate` gates; `rm -rf` guard runs first.
- **Persistence** — `session_start` clears `deliberations` + all flags; `/pi-brain` toggle resets workflow state; habit blocked in untrusted projects.

## Command

- `/pi-brain on` — strict mode: all queries answered **only** from brain episodes (scored recall injected + systemPrompt clamp; no external knowledge). Persisted as `brain:mode` entry, survives fork/resume.
- `/pi-brain off` — default pi behavior (light recent-3 injection only).
- `/pi-brain status` (or bare `/pi-brain`) — show current mode.

## Behavior

- Default (`off`): recent 3 episodes + 2 deliberations auto-inject via `before_agent_start`.
- Strict (`on`): 7-rule workflow enforced by extension (not docs): **Happy: recall → think → [synthesize/combine if novel] → plan → execute → plan.done → remember → habit → git commit**
  **Unhappy (on ANY failure): same flow, but failure → think{goal:'debug <Task N>', hypotheses:[cause,fix]} → update plan → retry (enforced: `tool_call` blocks read/write/edit/bash until debug-think).**
  1. **Recall-first** — `before_agent_start` scores TF-IDF top-5 for prompt + `systemPrompt` clamp (`ONLY from episodes, cite cue`).
  2. **Think-before-act** — `tool_call` blocks `write/edit` until `think{goal,hypotheses}` called (per-agent run).
  3. **Combine-only-for-novelty** — prompt instructs: `synthesize`/`combine` for creative/novel tasks, skip for CRUD/bugfix (before plan to get all inputs). Now fuses `think` deliberation + episodes.
  4. **Plan-after-inputs** — `think` (+ `synthesize/combine` if used) → `plan{goal,tasks[]}` creates `[ ]` list; mark `[x]` via `plan{id,done:[i]}`; latest plan auto-injected.
  5. **Shortest-diff** — prompt instructs: read target → edit one file → bash verify, no scaffolding.
  6. **Encode** — `tool_result` auto-encodes `write/edit/bash`; `turn_end`/`agent_end` nudges if `remember`/`habit` not called; 2nd repeat → `habit`.
  7. **Git** — when plan 2/2 done + remember done, `bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>'` (auto-init first time, skip if no changes).
  Rebuilt from `brain:mode` + `brain:plan` on `session_start` (branch-durable).
- `edit/write/bash` auto-encode; `bash` error hints recall; `rm -rf` confirm.
- Compaction injects top 5 episodes; `before_provider_request` trims >30KB payloads.
- `context` prunes >40 msgs → system + last 20.
