# pi-brain (lean) — What it does, and deliberately does NOT do

> Supersedes the 2026-09-16 observability audit. Written for the `steve-jobs-version` experiment:
> the product got smaller, so the honesty surface got smaller.

## Hooks do exactly three things

1. **Tutor** (`tool_result` + `tool_call`) — counts consecutive `write`/`edit`/`bash` failures.
   At 2 in a row, further `write`/`edit` are **blocked** until `think{goal:'debug <task>', hypotheses:[cause, fix]}`
   succeeds. `bash` stays free (probing/verification is never locked); any success or a debug `think` clears the counter.
   Duplicate blocks in one batch are terse (first block explains).
2. **Safety** (`tool_call`) — `rm -rf` (or `rm -r -f` / `rm --recursive --force`) requires `ui.confirm`.
3. **Memory nudge** (`turn_end`) — edits landed + plan done but no `remember` yet → nudges once
   ("2nd repeat → `habit`"). An audit-blocked `remember` counts as attempted — the nudge stops.

No happy-path gates. No mode-specific branches — hooks only read `on`/`off`.
`think`, `plan`, `creative-thinking` are never mandatory before `write`/`edit`.

## What pi-brain deliberately does NOT do

- **No auto-encode** — `edit`/`write`/`bash` success only sets flags; only explicit `remember` persists episodes.
- **No auto-inject of episodes/thoughts** — the only injected text is the static `[brain:on]` flow note
  appended to the latest user message (byte-identical every turn = KV-cache friendly).
- **No hidden writes** — `remember` is the single write path to memory; `habit` writes its own SKILL.md.
- **No prompt scoring for injection** — `context` only dedups legacy blocks; it never ranks or trims for injection.
- **No strict/guided modes** — one guarded mode (`on`); legacy `strict`/`guided` map to it on read.

## Think is lean by design

`think` keeps the rubric engine (hypotheses scored on cost/risk/reversibility/relevance, winner pinned,
memory links attached) but its **output is a decision memo** — the debater/judge courtroom, parent-graph
branching narrative, and graph dashboard are gone. `details.debate` is still returned (machine-readable,
backward-compatible) and replays via `recall{query:"think:<id>"}`.

## Tools (7)

`remember` · `recall` · `think` · `creative-thinking` · `plan` · `habit` · `brain-status` —
every one explicit, every write visible in the transcript.