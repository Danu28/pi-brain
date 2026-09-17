# Changelog

All notable changes to pi-brain follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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