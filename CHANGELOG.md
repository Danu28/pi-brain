# Changelog

All notable changes to pi-brain follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [2.2.0] — 2026-09-18

### Cut calls P0 — 5.2→2.3 tiered router (S01-S08)
- **S01 tiered router** `taskTier()` 1|2|3 — <30 lines & risk≤3 & 1 file → tier1 skips think+plan; quality gate relevance≥4; emits `brain:skip {tier}` (`src/hooks.ts`, `src/knobs.ts` TIER1_LINES/RISK/TIER2_LINES)
- **S02 inject replaces recall** — `recallSkippable()` checks `lastCompactionSummary` hot gist (score≥7 recent) → skip recall call, use `context` inject; prefetch warms next recall (`src/hooks.ts`, `src/session.ts`)
- **S03 think_plan fuse** — new tool `think_plan{goal,hypotheses[2],tasks?,template?}` 1 call replaces 2; debate+plan atomic (`src/tools.ts`)
- **S05 reuse memory as think** — top score≥8 & <2d reuses conclusion `reused:true` 0 calls (`src/tools.ts` think)
- **S08 batch teaching** — promptGuidelines "batch recall→think_plan→edit in ONE turn when tier≥2" + blockHint (`src/tools.ts`)

### Batch P1 + Quality P2 (S09-S18)
- **S09 intent cache 5min** `RECALL_MEMO_MS=300000` cross-task, archive hint added (`src/knobs.ts`, `src/tools.ts`)
- **S10 prefetch** `before_agent_start` warms `candidatePool` → 0 calls (`src/session.ts`)
- **S15 lazy detail** gist 120 chars; full detail only `score≥7` or `archive:true` (`src/tools.ts`)
- **S17 archive hint** `— try recall{archive:true, query:"x"}` on deletedCues (`src/tools.ts`)
- **S18 inline think tier-1** 1 hypothesis → single winner no debate block

### System P3 + docs
- **S21 pre-rank** `_preRank` idle top3, **S22 batch telemetry** `brain:task-done` throttle 5s (`src/state.ts`, `src/session.ts`)
- Docs: `docs/llm-calls-reduction.md` + `SKILL.md` tiered workflow (1.2/2.8/4.5) + `pi-brain.knobs.json` TIER knobs; `suggestion.html` not tracked

## [2.1.0] — 2026-09-18

### Agent-friendly P0 (S01-S10)
- **S01 dual-shape think** — `hypotheses:[{side, argues, cost?, risk?, rev?}]` object shape preferred, pipe-string fallback kept; `RUBRIC_RE` single-pass unchanged (`src/tools.ts`, `src/scoring.ts`)
- **S02 keep-flag vs delete** — plan keeps low-relevance tasks flagged `[low 2.1/10]` instead of silent QDS delete; `details.deletedCount/preview` optional (`src/tools.ts`, `src/state.ts` `renderPlan`)
- **S03 recall breakdown top 3** — `scoreBreakdown` now top 3 with `halfLife`/`sourceBoost` structured `details.breakdown[3]` (+80 tok, better picks) (`src/tools.ts`)
- **S04 trivial-edit escape** — `risk≤3 + singleFile + <30 lines/<800 chars` bypasses strict `plan` gate; logged `brain:block {trivial:true}` (`src/hooks.ts`)
- **S05 replay polish** — `recall{query:"plan:xyz"}`/`"brain-plan:xyz"` normalized double-prefix; returns `details.replay:true` + compact render + linked plans/episodes (`src/tools.ts`)
- **S06 fix templates** — block reasons carry copy-paste `think{goal,hypotheses}`/`plan{goal,tasks}` fix (`src/hooks.ts` `blockHint`)
- **S07 knob SIMILAR_BLOCK_AT** — `SIMILAR_BLOCK_AT=3` tunable via `pi-brain.knobs.json`; `remember` audit uses knob + `force` hint (`src/knobs.ts`, `src/tools.ts`)
- **S08 auto-link think↔plan↔episodes** — bidirectional `links` stored; `recall{query:"think:id"}` surfaces linked plan/episodes (`src/tools.ts`)
- **S09 deletedCues surfacing** — recall returns `details.deletedCount + deletedCues[3]` when `score<5.0` hidden; plan exposes flagged lows (`src/tools.ts`)
- **S10 delete auto-enrich** — `creative-thinking` requires `prompt.length≥15` or `autoEnrich:true`; vague prompt returns actionable error (`src/tools.ts`)

### Productivity P1 (S11-S16)
- **S11 batch remember** — `remember_batch{episodes:[8]}` + server dedup + one `saveMemory` flush; doc 5-parallel `Promise.all(cues.map(c=>remember(c)))` 7× faster (`src/tools.ts`)
- **S12 parallel hint** — `renderPlan` tags `[parallelizable]` when tasks share no `depends`; `details.parallelGroups:[[0,1],[2]]` + `getParallelGroups()` (`src/state.ts`, `src/tools.ts`)
- **S13 templates** — `plan{template:"bugfix|feature|refactor"}` expands 5-task skeleton with `refs/check/risk` placeholders; DAG preserved (`src/tools.ts` `PLAN_TEMPLATES`)
- **S14 memo 100/60s** — `recallMemo` cap 100 (was 50), `RECALL_MEMO_MS` tunable 30s→60s; `limit` included in memo key (`src/tools.ts`, `src/knobs.ts`)
- **S15 resources_discover** — re-enabled `.pi/skills/brain-*/SKILL.md` indexing so habits auto-load without reload (`src/index.ts`)
- **S16 gated auto-commit** — `turn_end` when `isPlanDone() && git diff --quiet` fails emits `brain:commit-ready` + one-line `bash` nudge (never push) (`src/hooks.ts`)

### User-friendly P2 (S17-S20)
- **S17 footer counts** — `🧠 ON 12 • 3/5 • 42%` collapsed; tooltip `mode | episodes | failures | last plan goal` (`src/footer.ts`)
- **S18 debounced nudges** — 1 nudge/turn max (1000ms), extends terse duplicate to guided, `PI_BRAIN_QUIET=1` silences UI nudges (still emits `brain:nudge`) (`src/hooks.ts`)
- **S19 per-project mode** — `.pi/brain.json` (cwd) wins over global `~/.pi/agent/pi-brain.json`; `/pi-brain status` prints `mode: strict (source: .pi/brain.json)` (`src/state.ts` `MODE_SOURCE`)
- **S20 truncation honesty** — `[truncated to 50KB — full detail via recall{query:"cue"} or .pi/agent/pi-brain-memory.json]` (`src/knobs.ts` `truncate`)

### Cost-efficient P3 (S21-S24)
- **S21 debounced sidecar** — 300ms debounce coalesce via `saveChain`/`pendingSave`; flush on `session_shutdown` + `turn_end` plan-done + `before_agent_start` (`src/state.ts`)
- **S22 budget-aware compaction** — `pct>85 keep 5 else if pct>75 keep 1 else keep 3`; gist cap 120 chars + `compressEpisodes` dedup by cue (`src/session.ts`)
- **S23 lazy status** — `brain-status` memoizes `Index: …` until `memoGen` bumps; `gistForEpisode` loop skipped on cache hit (`src/tools.ts` `statusCache`)
- **S24 archive vs prune** — `pi-brain-archive.jsonl` append (1 JSON/line) instead of silent drop; `recall{archive:true}` searches it (`src/scoring.ts` `pruneExpired`+`archiveEpisodes`)

## [2.0.0] — 2026-09-17

### Added
- **Knobs/SYN externalized** — `pi-brain.knobs.json` + `pi-brain.syn.json` file-only overrides (cwd + `$PI_CODING_AGENT_DIR`), logged via `brain-status verbose:true` (`src/knobs.ts`, `src/scoring.ts`)
- **Habit-due signal** — 2nd similar `remember` → `brain:habit-due` event + `[Habit due]` hint (`src/tools.ts`)
- **Recall transparency** — top-2 `[Score breakdown: base × half-life × boost]` (`src/scoring.ts`, `src/tools.ts`)
- **Commit hint** — `plan` returns copy-paste `bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit` when done/all (`src/tools.ts`, `src/session.ts` stores `lastCompactionKept`)

### Changed
- **SKILL.md slim** — 10.6k → 3.3k, one workflow table + tips, links to `docs/architecture.html` (`skills/pi-brain/SKILL.md`)
- **brain-status collapsed** — default 6 lines; `verbose:true` / `PI_BRAIN_VERBOSE=1` adds gist/knobs/budget/compaction (`src/tools.ts`)
- **DAG UX** — `renderPlan` shows `→ waits: T2` + `[blocked]` tags; blocked msg includes waiter titles + `plan{id,done:[x]} first` fix (`src/state.ts`, `src/tools.ts`)
- **Debate parser** — single-pass `RUBRIC_RE` for `cost:/risk:/rev:` any order/pipe (`src/scoring.ts`)
- **Scoring** — `tokenizeCached` LRU, `candidatePool` index-miss fast-path `[]` when `>10` episodes, `scoreBreakdown()` helper, `truncate()` single-surface in `knobs.ts` (`src/knobs.ts`, `src/scoring.ts`)

### Fixed
- **Async sidecar** — `saveMemory()` via `withFileMutationQueue` chain, `saveChain` coalescing — burst 10 remembers safe (`src/state.ts`, `src/tools.ts`, `src/session.ts`)
- **Documentation drift** — `docs/architecture.html` now post-delete reality (no auto-encode, static `[brain:mode]` note, no `before_provider_request`/`resources_discover`, sidecar+branch file-wins) (`docs/architecture.html`)
- **Development layout** — `docs/development.md` now lists real `src/*.ts` + `pi-brain.knobs/syn.json` (`docs/development.md`)
- **Memo coherence** — `brain.memoGen` + `gen` in `recallMemo` — memo invalidated on `index/unindex/rebuild`; `pruneExpired` clears correctly (`src/state.ts`, `src/scoring.ts`)
- **Cleanup** — removed `totalRisk` var, deduped `brain:debate` duplicate emit (`src/tools.ts`)

### Deleted
- Legacy `brainStrict`/`needsPlanUpdate` read paths unified via `getBrainMode()` (compat shim retained in `src/state.ts`/`src/command.ts` for test transition); `budgetTrim`/`BUDGET` trim table removed (static note is KV-stable)

### Fixed

- **Memory survive restart/fork/compact** — session rebuild now reads pi's real custom-entry shape (`type:"custom"` + `customType` + `data`) instead of the nonexistent `type:"entry"/entryType` fields, so episodes/plans/mode were silently wiped on every `/resume`, `/fork` or `/reload`. (`src/session.ts`)
- **`/tree` navigation** — state is re-derived on `session_tree` (todo.ts pattern) so recalls never leak episodes from other branches. (`src/session.ts`)
- **Compaction result shape** — `session_before_compact` now returns `{ compaction: { summary, firstKeptEntryId, tokensBefore } }` per the extension contract; the brain-episode compaction summary previously never applied. (`src/session.ts`)
- **`brain-status` context usage** — reads the real `ContextUsage` fields (`tokens`/`contextWindow`/`percent`) instead of nonexistent `used`/`total`; token numbers were always `? / ?`. (`src/tools.ts`)
- **Custom-event bus** — the `brain:mode` footer-sync listener moved from `pi.on` (lifecycle only) to `pi.events.on` (the inter-extension bus) — it was dead code. (`src/session.ts`)
- **`habit` file race** — writes now go through the imported `withFileMutationQueue` (the `pi.withFileMutationQueue` member never existed on ExtensionAPI). (`src/tools.ts`)
- **Footer/RPC-safe status** — removed raw ANSI escape fallbacks and the `_brainStrict` hack; status colors use `ctx.ui.theme`. (`src/footer.ts`)
- **Chatter** — the pre-threshold failure toast is now `PI_BRAIN_VERBOSE`-only (the in-result hint stays); the 2nd-failure block message still notifies. (`src/hooks.ts`)
- **Strict gate timing** — `plan` is now gated on `think` (Rule 2 fires at the earliest pre-edit tool, not on the write/edit batch), so skipping `think` costs one small blocked `plan` instead of a full blocked edit batch + re-emission. (`src/hooks.ts`)

### Added

- **Durable sidecar memory store** — episodes/plans snapshot to `$PI_CODING_AGENT_DIR/pi-brain-memory.json` on every mutation and reload on `session_start`/`session_tree`/`session_shutdown`, so memory survives compaction boundaries and cross-session resumes. (`src/state.ts`)
- **Tool discoverability** — `promptSnippet` + `promptGuidelines` on all 7 tools so they appear in the system prompt's "Available tools" section. (`src/tools.ts`)

### Changed

- Removed dead stats counters (`skip`/`autoEncode`/`touch`/`budgetTrim`) from `brain-status` output. (`src/tools.ts`)
- Docs now honest about the plan DAG: `depends` is validated; the `bash: git init + commit` on plan completion is a model-driven nudge, not an enforced block. (`README.md`, `skills/pi-brain/SKILL.md`)

## [1.0.0] — 2026-09-14
- **Batch-aware preflight** — pending sibling `think`/`plan` calls in the same assistant message count as satisfying the gate (pi preflights all siblings before any executes), so a compliant batched model is never blocked and never re-emits edits. (`src/hooks.ts`)
- **Terse duplicate block hints** — siblings blocked by the same rule in one batch get a 1-line reason; the first block carries the full explanation (cuts block noise on multi-tool batches). (`src/hooks.ts`)
- Guided mode nudges on `plan` too (same earlier-steering benefit, no blocks). (`src/hooks.ts`)

First publishable pi package release.

### Changed

- Restructured repo → pi package layout: `src/` (source), `skills/pi-brain/` (skill), `docs/` (docs), `scripts/` (legacy copy installers), `tests/`.
- Added `package.json` with pi manifest (`pi.extensions` → `./src/index.ts` — TS source, pi loads it natively so git installs need no build artifacts; `pi.skills` → `./skills`), `peerDependencies` on `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` / `typebox` (`"*"` — pi bundles these), and a `pi-package` keyword for the gallery.
- Fixed: `pi install git:...@v1.0.0` reported installed but loaded no extension — the manifest pointed at gitignored `./dist/index.js`; repointed to `./src/index.ts` (npm tarball still ships `dist/` via the `files` field).
- Split the 1061-line monolith `index.ts` into typed modules: `types.ts`, `knobs.ts`, `util.ts`, `scoring.ts`, `storage.ts`, `state.ts`, `recall.ts`, `tools/*.ts`, `session.ts`, `inject.ts`, `hooks.ts`. Behavior identical.
- Renamed tool `brain_status` → `brain-status` (kebab, matches `creative-thinking`).
- Rewrote README for `pi install` flows + permissions disclosure; LICENSE holder → Danu28.
- Added `tsconfig.json` (strict), `tsup.config.ts` (ESM + dts + sourcemap), vitest suite (`tests/scoring.test.ts`) — ported from the inline self-check.
- Added CI (`ci.yml`) and release (`release.yml`) GitHub Actions workflows.

### Fixed (2026-09-17)

- `recall` time-travel replay: `think:`/`brain-plan:` ids already carry their prefix, so a verbatim `recall{query:"<id>"}` double-prefixed and silently missed the stored id. Replay now normalizes before matching — both the verbatim-id and prefix+id conventions resolve.
- `plan` depends DAG: self-references, cycles and out-of-range indices are now rejected at create/append with a clear error (depends must be 0-based indices of EARLIER tasks). Previously such tasks could never complete — silently stalling the Rule-5 nudge and the plan-done → commit step.
- `skills/pi-brain/SKILL.md` synced to the clean implementation: removed stale auto-encode / systemPrompt-clamp / scored-inject / `plan{hypotheses}` claims (hooks set flags only; inject appends a static flow note).
- Added `tests/tools.test.ts` — first permanent tool-level coverage (remember/recall/think/plan/habit/brain-status/command, replay + DAG regressions) and `vitest.config.ts` sandboxing `PI_CODING_AGENT_DIR`.

### Changed (2026-09-17)

- Install is now git-only — npm distribution removed. `release.yml` deleted; `pack` + `prepublishOnly` scripts dropped.
- `ci.yml` guards `main` and `release/*` (was `master`/`main`).
- README + dev docs rewritten for `pi install git:...` flows (`@v1.0.0` pin or latest).

### Install

```bash
pi install git:github.com/Danu28/pi-brain@v1.0.0   # pinned release
pi install git:github.com/Danu28/pi-brain          # latest
```

Previous installers (`install.bat`/`install.sh`) now live in `scripts/` for air-gapped copy installs.