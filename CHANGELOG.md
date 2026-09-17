# Changelog

All notable changes to pi-brain follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.0.0-lean] — experiment branch `steve-jobs-version` (unreleased, not on main)

A product cut, not a feature release: "silent when it works, a tutor only when you fail twice, memory always."

### Removed (the ceremony)

- **Happy-path gates** — `plan` is no longer gated on `think`; `write`/`edit` no longer require `think`+`plan`.
  Mandatory think/plan before edits was the tax: an agent that reasons correctly now never gets blocked,
  never re-emits a rejected batch.
- **Guided mode** — modes collapsed to one guarded mode `on`; legacy `strict`/`guided` map to it on read
  (`/pi-brain strict|guided` are accepted aliases for `on`).
- **Think courtroom** — debate-block output, `Judge:` narrative and the graph dashboard line are gone.
  `think` returns a decision memo (rubric engine, `details.debate`, memory links and replay preserved).
- **Batch-aware preflight + strict-gate machinery** in `hooks.ts` — deleted along with the gates they served.

### Kept (the product)

- `remember` / `recall` / `think` / `creative-thinking` / `plan` / `habit` / `brain-status` — behavior unchanged.
- **Tutor gate** — 2 consecutive `write`/`edit`/`bash` failures still block until
  `think{goal:'debug <task>', hypotheses:[cause, fix]}`; any success or a debug `think` clears it.
- `rm -rf` UI confirm; one-time `remember` nudge after edits + plan done; static `[brain:on]` flow note (KV-cache friendly).

### Updated

- SKILL.md rewritten as a ~70-line manual; `docs/audit-observability.md` superseded by an honest
  "what it does / deliberately does NOT do" page; README, inject note and tests aligned to the new
  contract — tests now assert `edit`/`write`/`plan` are NOT blocked without `think`/`plan`.

## [1.0.0] — 2026-09-14

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