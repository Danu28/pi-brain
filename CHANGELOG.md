# Changelog

All notable changes to pi-brain follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0.0] — 2026-09-14

First publishable pi package release.

### Changed

- Restructured repo → pi package layout: `src/` (source), `skills/pi-brain/` (skill), `docs/` (docs), `scripts/` (legacy copy installers), `tests/`.
- Added `package.json` with pi manifest (`pi.extensions` → `./dist/index.js`, `pi.skills` → `./skills`), `peerDependencies` on `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` / `typebox` (`"*"` — pi bundles these), and a `pi-package` keyword for the gallery.
- Split the 1061-line monolith `index.ts` into typed modules: `types.ts`, `knobs.ts`, `util.ts`, `scoring.ts`, `storage.ts`, `state.ts`, `recall.ts`, `tools/*.ts`, `session.ts`, `inject.ts`, `hooks.ts`. Behavior identical.
- Renamed tool `brain_status` → `brain-status` (kebab, matches `creative-thinking`).
- Rewrote README for `pi install` flows + permissions disclosure; LICENSE holder → Danu28.
- Added `tsconfig.json` (strict), `tsup.config.ts` (ESM + dts + sourcemap), vitest suite (`tests/scoring.test.ts`) — ported from the inline self-check.
- Added CI (`ci.yml`) and release (`release.yml`) GitHub Actions workflows.

### Install

```bash
pi install npm:@danu28/pi-brain
```

Previous installers (`install.bat`/`install.sh`) now live in `scripts/` for air-gapped copy installs.