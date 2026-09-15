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
- Combine distant ideas for novelty → `creative`
- Repeated correction → `habit` (+ preview + undo hint)
- How full is memory → `brain-status` or `/pi-brain status` dashboard

## Tools

- `remember {cue, summary, detail?, tags?: string[] (≤8 kebab), refs?: string[] (≤5 files)}` — durable episode (`brain:episode` entry). Tags weight 1.5× in recall, refs show in TUI.
- `recall {query?, queries?: string[] (≤5 batch), limit?, tags?: string[], source?: "remember"|"auto", since?: "7d"|"24h"|ms|ISO}` — TF-IDF ranked recall (cue 2×, summary 1×, detail 0.5× per term + tag boost + half-life 0.5/7d). Empty query + tags allowed (tag-only). Batch `queries[]` = 1 call = N recalls. Incremental token→ids index + 30s memo + fallback scan.
- `search {query?, queries?: string[] (≤5 batch), limit?, filterPath?}` — **codebase search** hybrid hash-neural-384 + lexical (800-char chunks, 120 overlap). Offline, no grep. Batch `queries[]` = 1 call = N code searches — always batch related queries (e.g. `search{queries:["auth","retry","payment"]}`) to save LLM calls. Use `filterPath` to narrow (e.g. `src/payments`). Auto-builds index if empty.
- `think {goal, hypotheses[], conclusion?}` — PFC deliberation, injected next turn via `before_agent_start`. Unhappy path: goal must start with `debug`.
- `plan {goal, tasks[], id?, done?, hypotheses?: string[]}` — **detailed** ordered checklist after think+creative (`[ ] Task 1` → `[x] Task 1` via `plan{id,done:[0]}`), `brain:plan` entry. **Requires 3-10 tasks, each detailed (≥10 chars) and well-split to match the user requirement** — a good plan makes execution trivial. Aim 8-10 when the requirement is multi-step; keep 3 minimum. **>10 tasks: chunk — create with first 10, then `plan{id,tasks:["remaining…"]}` appends** (validation is actionable, not a raw schema error). Single-shot: include `hypotheses` to auto-create deliberation (2 calls → 1). When all [x], `bash: git init if needed + commit`. Auto-link: when all done + hasWriteEdit, turn_end surfaces prefilled `remember` template. Example (8 tasks for "add auth flow"): `["think + analyze auth requirement & existing routes","design token schema + decide storage","implement login endpoint","implement refresh/logout","add middleware + protect routes","write client integration","verify with bash + tests","remember + habit"]` — tool stays small, output stays detailed.
- `creative {cues: [2-3], prompt?}` — **post-think creative layer** (STRICTLY after `think`): 1 layer on top of `think` → takes latest `think {goal, hypotheses}` + optional `cues[2..3]` episodes → **3 forced variants** (each concrete, not in think/episodes alone). Episodes are **optional enhancement** — fused if `recall(cues)` hits, else deliberation-only SCAMPER (Substitute/Combine/Invert) + `⚠️ low-value warning` for CRUD. If no prior `think`, hint “call think first”. Contract: Variant 1=Substitute, 2=Combine, 3=Invert/Anti-pattern. Prompt e.g. `neon + login → glass login` NOT `creative approach`.
- `habit {name, when, steps, variant?, force?: boolean}` — draft `.pi/skills/brain-<name>/SKILL.md`; `variant` adds alternative. Preview: if exists returns diff + "call again with force:true to confirm"; reports sanitized name + `rm -r` undo hint. Blocked if project untrusted.
- `brain-status {}` — dashboard table: episodes | deliberations | plan | tokens | overload | recent cues + index stats (tokens→episodes + cueIndex + memo hits/miss); emits `brain:overload` if >80% or episodes>PRUNE_CAP 40 (honest vs old >50 which never fired).

> 8 tools total (remember/recall/search/think/creative/plan/habit/brain-status — 8 impls). **Recall 2.0:** filters `tags/source/since` AND with query, half-life decay, tag boost, tag-only recall, incremental `Map<token,Set<id>>` + `exactCueIndex` O(1) upsert + `rankedForQuery` DRY + `perQuery` batch details + 30s memo. **Gated inject:** strict: scored top-3 (1 if no match) + trace; default: 1 episode +1 deliberation gated (~250 tokens saved/turn). **Single-shot:** `plan{hypotheses}` creates deliberation (2→1). **Compact:** <15→3 else 5, overload→5. **Trim:** `context` dedups duplicate episode blocks then tails to 20.
> **C1 Hybrid full-memory:** `pi-memory (episodes Map, PRUNE_CAP 40)` is selective episodic store → `recall` is ranked filter `O(k)` TF-IDF + `avgIdf` → `LLM` is generative associator — full memory = episodes + weights. Recall grounds LLM (cite cue), LLM fills gaps; budget `75/85%` keeps injection lean.

## Command

- `/pi-brain on` — strict mode: all queries answered **only** from brain episodes (scored recall injected + systemPrompt clamp; no external knowledge). Persisted to `$PI_CODING_AGENT_DIR/pi-brain.json` (default `~/.pi/agent/pi-brain.json`) + `brain:mode` branch entry — stays on across sessions until `/pi-brain off`; file wins over branch on `session_start`.
- `/pi-brain off` — default pi behavior (relevance-gated 1–2 injection).
- `/pi-brain status` (or bare `/pi-brain`) — dashboard table: episodes, deliberations, plan, tokens, overload, recent cues, index stats.

## Behavior

- Default (`off`): gated 1 episode +1 deliberation auto-inject via `before_agent_start` (strict gets top-3 scored).
- Strict (`on`): 7-rule workflow enforced by extension (not docs): **Happy (2-call floor): recall → think → [creative if novel] → plan #1 → Turn1 read×N parallel → Turn2 edit×N+write×N+bash parallel → plan #2 done:[all] → remember → habit → git commit**
  **Unhappy (3-call floor): same but triggers ONLY on 2 continuous failures: `brainStrict && activePlan && !isPlanDone && tool in [write,edit,bash] && (isError || bash logical fail: output /\b(fail|error|ENOENT|not found|cannot)\b/ without /\b(passed|success)\b/)` + streak `consecutiveFailures>=2`. Streak `1/2` → warn only (`[first failure 1/2]`), `2/2` → block `write/edit/bash` until `think{goal:'debug <failed Task N: tool:err>', hypotheses:[cause,fix]}` → `plan #2 (must update plan{id,…})` → retry Turn1/Turn2 → `plan #3 done:[all] → remember`. Any successful mutation resets streak to 0; `think debug` also resets. Ad-hoc failures with no active plan do NOT trigger.**
  **Batch: 1 LLM call = N tool calls. Turn1 read×N; Turn2 edit×N+write×N+bash. Chunk edits: 1 edit/file, exact oldText, merge nearby. If oldText known → 1 call. Record → 0-call replay. 5-Step: Question→Delete→Simplify→Accelerate→Automate. // ponytail: deleted readCache, add per-path cache if throughput matters**
  1. **Recall-first** — `before_agent_start` scores TF-IDF top-5 + decay for prompt + `systemPrompt` clamp (`ONLY from episodes, cite cue`). Empty query allowed; tag filter intersects.
  2. **Think-before-act** — `tool_call` blocks `write/edit` until `think{goal,hypotheses}` or `plan{hypotheses}` called (per-agent run).
  3. **Creative-only-for-novelty (post-think creative layer)** — prompt instructs: `creative` for creative/novel tasks, skip for CRUD/bugfix; **STRICTLY after `think`** (workflow: `think → [creative if novel] → plan`). 1 layer on top of `think` → **forces 3 variants** not in either source: deliberation-only = SCAMPER (Substitute/Combine/Invert) + `⚠️ low-value warning` (episodes would be real value); fused = 2× think×episode fusions + 1× anti-pattern. If called without prior `think`, hint “call think first”. Delegates `rankedForQuery` when episodes exist.
  4. **Plan-after-inputs** — `think` (+ `creative` if used) → `plan{goal,tasks[]}` creates `[ ]` list; single-shot `plan{hypotheses}` allowed; mark `[x]` via `plan{id,done:[i]}`; latest plan auto-injected. All-done → prefilled `remember` hint. Execution is batched: Turn1 read×N, Turn2 edit×N+write×N+bash.
  5. **Shortest-diff + Batch** — Turn1 read×N parallel → Turn2 edit×N+write×N+bash parallel, 1 edit/file with exact oldText, no scaffolding for later. Bash verify after edits land.
  6. **Encode** — `tool_result` auto-encodes `write/edit/bash` with indexed episode; `turn_end`/`agent_end` nudges if `remember`/`habit` not called; 2nd repeat → `habit`; habit preview checks collision.
  7. **Git** — when plan 2/2 done + remember done, `bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>'` (auto-init first time, skip if no changes).
  Rebuilt from `brain:mode` + `brain:plan` on `session_start` (branch-durable, index rebuilt).
- `edit/write/bash` auto-encode (indexed); `bash` error hints recall with failedTool snippet; `rm -rf` confirm.
- Compaction injects top 3 if <15 else 5; overload keeps 5.
- `context` dedups duplicate episode blocks then prunes >40 msgs / >30KB → system + last 20.

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
plan { goal:"fix cold start", hypotheses:["pool init eager 10s","lazy-load pool on recall"], tasks:["fix pool with lazy init","bash verify pool works"] } // single-shot saves think (hypotheses ≥10 chars)
```
Cue cheat sheet: `kebab-short` (2×), tags for grouping, refs for file jump, since filters recency, half-life auto-decays stale.
