---
name: pi-brain
description: Use pi-brain when you need to remember, recall, reason or habituate across sessions (memory + guardrails, lean).
---

# pi-brain — lean

*Experiment branch: `steve-jobs-version`. Silent when it works. A tutor only when you fail twice. Memory always.*

**The whole product:** episodes you `remember` by cue, `recall` by association, a rubric-scored deliberation,
an ordered plan checklist, habits from repeated fixes, and a status dashboard. No ceremony — `think` and `plan`
are tools, never requirements. If the work is going well, the extension is silent.

## When to use

- Persist a decision/fix before fork/resume/compact → `remember {cue, summary, detail?, tags? (≤8 kebab), refs? (≤5 files)}`
- Find a prior fix/episode → `recall {query?|queries[] (≤5 batch), tags?, source?, since?, limit?}` (TF-IDF + half-life + tag boost)
- Decide between options before acting → `think {goal, hypotheses[] (≤3), conclusion?}` (decision memo, replayable via `recall{query:"think:<id>"}`)
- Fuse distant ideas for novelty → `creative-thinking {cues:[2-3], prompt?}`
- Ordered checklist of checkable steps → `plan {goal, tasks[] (3-10), id?, done?}` (mark `[x]` via `plan{id, done:[i]}`)
- Repeated correction (2nd repeat of the same fix) → `habit {name, when, steps, variant?, force?}`
- How full is the brain? → `brain-status`

## Rules (all three)

1. **Memory always** — hooks never write silently; only explicit `remember` persists episodes.
2. **Tutor on 2 failures** — two consecutive `write`/`edit`/`bash` failures arm the tutor:
   further `write`/`edit` are **blocked** until `think{goal:'debug <task>', hypotheses:[cause, fix]}`.
   `bash` stays free for probing; any success (or a debug `think`) clears the counter.
3. **Remember when done** — after edits landed + plan done with no `remember`, `turn_end` nudges once
   (`remember {cue, summary}` — same fix a 2nd time → `habit`).

Safety: `rm -rf` needs UI confirm. That is everything hooks do. No mandatory think/plan gates, no nudges for
following the "happy path" — the model stays in charge; pi-brain protects against thrashing, not against thinking.

## Command

- `/pi-brain on` — guarded mode. Persisted to `$PI_CODING_AGENT_DIR/pi-brain.json` (default `~/.pi/agent/pi-brain.json`)
  + `brain:mode` branch entry; stays on across sessions; file wins over branch on `session_start`.
- `/pi-brain off` — stock pi behavior restored. (`strict`/`guided` accepted as legacy aliases for `on`.)
- `/pi-brain status` — dashboard: episodes, deliberations, plan, tokens, failures, index stats.

## Quickstart (60s)

```
remember { cue:"cold-start-fix", summary:"lazy-load DB pool fixes cold start", tags:["infra"], refs:["db.ts"] }
recall { query:"cold start", limit:3 }          // next session: past fix in 1 call
think { goal:"which fix fits cold start", hypotheses:["eager pool init 10s","lazy-load on first query"] }
plan { goal:"fix cold start", tasks:["implement lazy pool","bash verify","remember + commit"] }
```

Cue cheat sheet: `kebab-short` cues, tags for grouping, refs for file jump, `since:"7d"` filters recency,
half-life auto-decays stale episodes. Batch recall: `queries:[c1,c2,c3]` = 1 call = N recalls.