# Changelog

All notable changes to pi-brain follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased] — v2.0.0-alpha (hash-neural-384, single brain dual corpus)

Proposal: `docs/v2-proposal.html` (hash-neural-384 only, 0 download, CPU <50ms, 100% private). No Xenova, no vector DB.

### Planned — P1 Neural recall core (v1.1.0 → v2 alpha)
- New `src/neural.ts` — pure JS `hashNeuralEmbed` (DIM 384, W[384*384]+B via `mulberry32(42)` Xavier, `tanh*0.7+residual*0.3`, `l2Normalize`, `cosine`) ~50 lines, 0 deps, deterministic, <1ms.
- `Episode += embedding?: Float32Array` (~1.5KB/ep), hydrated lazily on next `remember`; old episodes without vec → `cosine=0` (graceful).
- Hybrid scorer: `final = (0.55*normLex +0.35*cosine +0.10*tag) * decay(0.5/7d) * sourceBoost` — SYN kept as lexical boost, exact cue 2× before normalize.
- `knobs.ts` adds `BLEND_*`, `SIMILAR_COSINE 0.82`, `AUTO_TAG_COSINE 0.75`, `CODE_TOPK 3`, `NEURAL_DIM 384`; `BLEND_SEMANTIC=0` instantly reverts to v1.
- `remember` semantic dedup (`cosine>0.82` warns) + `recall` hybrid ranking, `brain-status` shows `vecs/blocks/model`.

### Planned — P2 Code index absorb (v1.2.0)
- Absorb Pi-NN: `walkFiles 500 cap, chunk 800c/120 overlap, gitignore`, `IndexedBlock[]+embedding`, `patchFile` on `write/edit/bash`.
- `recall {includeCode: "auto"|true|false}` returns `episodes + codeHits` (decision+proof) in one call.

### Planned — P3 Think/Plan/Habit augment (v2.0.0)
- `think` retrieval-augmented (top3 episodes + top2 code), `plan` draft from centroid (`cosine>0.78`), `habit` cluster → skill proposal.
- Bench: `npm run bench:recall` reproduces hit-rate bars (842 synthetic eps, 0.68→0.89).

---

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

### Install

```bash
pi install npm:@danu28/pi-brain
```

Previous installers (`install.bat`/`install.sh`) now live in `scripts/` for air-gapped copy installs.