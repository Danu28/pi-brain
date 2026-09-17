---
name: pi-brain
description: Use pi-brain when you need to remember, recall, reason or habituate across sessions (hippocampal + PFC memory).
---

# pi-brain

Brain-inspired memory for pi. One file, one Map — recall 2.0 + incremental index + strict workflow gates.

## When to use

- Persist a decision/fix across fork/resume/compact → `remember` (with tags/refs)
- Find a prior fix/episode → `recall` (TF-IDF + tag boost + half-life + filters)
- Reason explicitly before acting → `think` (PFC deliberation debate graph)
- Combine distant ideas for novelty → `creative-thinking`
- Repeated correction → `habit` (+ preview + undo hint)
- How full is memory → `brain-status` or `/pi-brain status` dashboard

## Tools

- `remember {cue, summary, detail?, tags?: string[] (≤8 kebab), refs?: string[] (≤5 files)}` — durable episode (`brain:episode` entry). Tags weight 1.5× in recall, refs show in TUI.
- `recall {query?, queries?: string[] (≤5 batch), limit?, tags?: string[], source?: "remember"|"auto", since?: "7d"|"24h"|ms|ISO}` — TF-IDF ranked recall (cue 2×, summary 1×, detail 0.5× per term + tag boost + half-life 0.5/7d). Empty query + tags allowed (tag-only). Batch `queries[]` = 1 call = N recalls. Incremental token→ids index + 30s memo + fallback scan.
- `think {goal, hypotheses[], conclusion?}` — PFC deliberation (debate graph: 2 debaters + judge, rubric cost/risk/reversibility, winner pinned, loser pruned, parentId branching). Unhappy path: goal must start with `debug`. Replay later via `recall{query:"<think id>"}` (verbatim id).
- `plan {goal, tasks[], id?, done?}` — **detailed** ordered checklist after think+creative-thinking (`[ ] Task 1` → `[x] Task 1` via `plan{id,done:[0]}`), `brain:plan` entry. **Requires 3-10 tasks, each detailed (≥10 chars) and well-split to match the user requirement** — a good plan makes execution trivial. Aim 8-10 when the requirement is multi-step; keep 3 minimum. **>10 tasks: chunk — create with first 10, then `plan{id,tasks:["remaining…"]}` appends** (validation is actionable, not a raw schema error). `depends:0,1` (rich tasks) = 0-based indices of EARLIER tasks — self-refs, cycles and out-of-range depends are rejected with a clear error. When all [x], `bash: git init if needed + commit`. Rule 5: after plan all-done + write/edit succeeded, turn_end nudges `remember` (encode-or-it-didn't-happen). Example (8 tasks for "add auth flow"): `["think + analyze auth requirement & existing routes","design token schema + decide storage","implement login endpoint","implement refresh/logout","add middleware + protect routes","write client integration","verify with bash + tests","remember + habit"]` — tool stays small, output stays detailed.
- `creative-thinking {cues: [2-3], prompt?}` — divergent synthesis fusing episodes + latest `think`. Prompt e.g. `creative-thinking neon + login into glass login` NOT `creative approach`; loose/missing auto-enriched with cues+think goal.
- `habit {name, when, steps, variant?, force?: boolean}` — draft `.pi/skills/brain-<name>/SKILL.md`; `variant` adds alternative. Preview: if exists returns diff + "call again with force:true to confirm"; reports sanitized name + `rm -r` undo hint. Blocked if project untrusted.
- `brain-status {}` — dashboard table: episodes | deliberations | plan | tokens | overload | recent cues + index stats; emits `brain:overload` if >80% or episodes>50.

> 7 tools total (remember/recall/think/creative-thinking/plan/habit/brain-status — 7 impls). **Recall 2.0:** filters `tags/source/since` AND with query, half-life decay, tag boost, tag-only recall, incremental `Map<token,Set<id>>` updated on encode. **Inject (clean):** no scored auto-inject, no systemPrompt clamp — only a small STATIC `[brain:mode]` flow note appended to the latest user message on new-task turns (KV-cache friendly), plus legacy-block dedup. **Compact:** <15→3 else 5. **Replay:** `recall{query:"<think id>"}` / `recall{query:"<brain-plan id>"}` (verbatim ids).

## Command

- `/pi-brain on` — strict mode: hard blocks enforced by hooks (code, not prompt): `plan` gated on think, think + plan MANDATORY before `write/edit`; 2 consecutive `write/edit/bash` failures → blocked until `think{goal:'debug …'}`; `rm -rf` needs UI confirm. Recall stays OPTIONAL (never blocked). Persisted to `$PI_CODING_AGENT_DIR/pi-brain.json` (default `~/.pi/agent/pi-brain.json`) + `brain:mode` branch entry — stays on across sessions until `/pi-brain off`; file wins over branch on `session_start`.
- `/pi-brain guided` — same flow as notes/nudges, no hard blocks (except `rm -rf`).
- `/pi-brain off` — extension disabled, default pi behavior restored.
- `/pi-brain status` (or bare `/pi-brain`) — dashboard table: episodes, deliberations, plan, tokens, overload, recent cues, index stats.

## Behavior

- **Memory durability** — episodes/plans are snapshotted to `$PI_CODING_AGENT_DIR/pi-brain-memory.json` on every mutation and reloaded on `session_start`/`session_tree`, so memory survives `/resume`, `/fork`, compactions and `/tree` navigation (branch custom entries are compaction-pruned; the sidecar is not). Mode toggle persists in `pi-brain.json` (file wins).
- Default (`off`): disabled — no notes, no blocks, no nudges, stock pi behavior.
- Strict (`on`): 7-rule workflow enforced by extension (not docs): **Gate fires early + batch-aware.** `plan` is gated on `think` — the Rule-2 block hits the first pre-edit tool, not the write/edit batch. Preflight is batch-aware: a pending `think`/`plan` call in the SAME assistant message counts as satisfied (pi preflights all siblings before any executes), so a compliant batched model is never blocked and never re-emits.
- Strict (`on`): 7-rule workflow enforced by extension (not docs): **Happy (2-call floor): recall → think → [creative-thinking if novel] → plan #1 → Turn1 read×N parallel → Turn2 edit×N+write×N+bash parallel → plan #2 done:[all] → remember → habit → git commit**
  **Unhappy (3-call floor): same flow but 3 plan calls — plan #1 → failure → think{goal:'debug <Task N> — <tool>: <err>', hypotheses:[cause,fix]} → plan #2 → retry Turn1/Turn2 → plan #3 done:[all] → remember (enforced: `tool_call` blocks write/edit/bash until debug-think).**
  **Batch: 1 LLM call = N tool calls. Turn1 read×N; Turn2 edit×N+write×N+bash. Chunk edits: 1 edit/file, exact oldText, merge nearby. If oldText known → 1 call. Record → 0-call replay. 5-Step: Question→Delete→Simplify→Accelerate→Automate. // ponytail: deleted readCache, add per-path cache if throughput matters**
  1. **Recall-first (optional)** — `recall` by cue/query to pattern-complete from memory before acting; recall is NEVER required or blocked. Empty query allowed; tag filter intersects. Time-travel: replay past think/plan via verbatim id.
  2. **Think-before-act** — `tool_call` blocks `plan` until `think{goal,hypotheses}` called (earliest gate) and blocks `write/edit` until think + `plan{goal,tasks[]}` created (per-agent run). Batch-aware: a pending `think`/`plan` call in the same assistant message counts as satisfied; duplicate blocks within one batch are terse (first one explains).
  3. **Creative-thinking-only-for-novelty** — prompt instructs: `creative-thinking` for creative/novel tasks, skip for CRUD/bugfix (before plan to get all inputs). Now fuses `think` deliberation + episodes.
  4. **Plan-after-inputs** — `think` (+ `creative-thinking` if used) → `plan{goal,tasks[]}` (plan itself is gated on think in strict) creates `[ ]` list; mark `[x]` via `plan{id,done:[i]}`; depends-verified DAG (`depends` must be earlier tasks — invalid depends rejected; `check:` is guidance metadata, not auto-executed). All-done → Rule 5 nudge to `remember`. Execution is batched: Turn1 read×N, Turn2 edit×N+write×N+bash.
  5. **Shortest-diff + Batch** — Turn1 read×N parallel → Turn2 edit×N+write×N+bash parallel, 1 edit/file with exact oldText, no scaffolding for later. Bash verify after edits land.
  6. **Encode** — explicit: call `remember` to persist what matters; hooks only set flags (no auto-encode, no hidden writes). `turn_end` Rule 5 nudges if write/edit succeeded without `remember`; 2nd repeat → `habit`; habit preview checks collision.
  7. **Git** — when plan 2/2 done + remember done, `bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>'` (auto-init first time, skip if no changes).
  Rebuilt from `brain:mode` + `brain:plan` on `session_start` (branch-durable, index rebuilt).
- `edit/write/bash` success only records flags (`hasWriteEdit`); 2 CONSECUTIVE failures → debug-think gate (strict blocks, guided nudges); `rm -rf` needs UI confirm.
- Compaction injects top 3 if <15 else 5; overload keeps 5.
- `context` dedups duplicate legacy brain blocks; nothing new is injected today — the static `[brain:]` flow note is appended once per new-task turn (idempotent).

## Pi Default Tools (pi-brain must know)

- `read {path, offset?, limit?}` — read text/image (50KB/2000 lines cap), use offset/limit to page large files
- `write {path, content}` — create/overwrite file, auto-creates dirs
- `edit {path, edits:[{oldText,newText}]}` — exact unique `oldText`, non-overlapping edits, merge nearby lines, one file per call
- `bash {command, timeout?}` — shell (`ls`, `grep`, `find`, `git`, verify), output truncated 50KB
- Custom tools — any `pi.registerTool {name, parameters}` — call by `name` with matching params (discover via skill list/recall)

Rule: Turn1 `read×N` parallel → Turn2 `edit×N+write×N+bash` parallel. 1 edit/file exact oldText. Prefer `edit` over `write` for patches, `bash` only for checks/git. If oldText known → skip reads → 1 call. // ponytail: deleted readCache

## Calibration knobs (top of index.ts)

`MAX_BYTES`/`MAX_LINES` (50KB/2K), `TAG_BOOST=1.5`, `HALF_LIFE_DAYS=7`, `HALF_LIFE_FACTOR=0.5`, `RECALL_MEMO_MS=30000`, `PRUNE_WARN=35/PRUNE_CAP=40`, `REMEMBER_BOOST=2.0`, `COMPACT_SMALL=3`, `COMPACT_LARGE=5` — tune without code change. Batch: `queries[]` up to 5. SYN override: `pi-brain.syn.json` or `~/.pi/agent/pi-brain.syn.json` merges into SYN.

## Quickstart (60s)

```
remember { cue:"my-fix", summary:"lazy-load DB pool fixes cold start", tags:["infra"], refs:["pi-brain/index.ts"] }
recall { query:"cold start", tags:["infra"], since:"7d", limit:3 }  // tag-only: recall { query:"", tags:["landmine"] }
think { goal:"which fix for cold start", hypotheses:["eager pool init 10s","lazy-load pool on first query"] }
plan { goal:"fix cold start", tasks:["implement lazy pool init lazy","bash verify pool works","remember + habit"] }
```
Cue cheat sheet: `kebab-short` (2×), tags for grouping, refs for file jump, since filters recency, half-life auto-decays stale.
