# Changelog

All notable changes to pi-brain follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.0.0] — 2026-09-15 — hash-neural-384 single brain dual corpus (CPU <50ms, 100% private, 0 deps)

Proposal: `docs/v2-proposal.html` · Roadmap: `docs/v2-roadmap.md` — hash-neural-384 only (no Xenova, no vector DB, no daemon, offline).

### Added — P1 Neural recall core
- New `src/neural.ts` — pure JS `hashNeuralEmbed` (DIM 384, W[384*384]+B via `mulberry32(42)` Xavier, `tanh*0.7+residual*0.3`, `l2Normalize`, `cosine`) ~50 lines, 0 deps, deterministic, <1ms CPU, air-gap safe.
- `Episode.embedding?: string` base64 (~1.5KB/ep) + `state.embeddings` runtime cache + `session` hydrate + `prune` cleanup; old episodes without vec → `cosine 0` graceful.
- Hybrid scorer: `final = (0.55*normLex +0.35*cosine +0.10*tag) * decay(0.5/7d) * sourceBoost` — SYN kept, exact cue 2× before normalize, `BLEND_SEMANTIC=0` instantly reverts to v1 lexical.
- `remember` semantic dedup `cosine>0.82` alongside TF-IDF `score≥5` (open vocab ship→deploy), embeds on encode/upsert; `recall` hybrid batch + perQuery, `brain-status` shows `vecs/model`.

### Added — P2 Code index absorb (dual corpus)
- New `src/code.ts` — `walkFiles` 500 cap gitignore-aware, `chunk` 800c/120, `hashNeuralEmbed` per block, `buildCodeIndex <2s`, `patchCodeFile` single-file, `searchCode cosine+0.02 boost` — all CPU/private, Pi-NN absorbed.
- `state.codeBlocks/codeFileHashes/codeIndexStats`, `session` builds code index on `session_start` (lazy), `hooks` patches on `write/edit`.
- `recall {includeCode: "auto"|true|false, filterPath}` auto detects `where/how/find/src/.ts`, returns `episodes + codeHits` (decision+proof) with `--- code (3/500 blocks)` in text, memo includes `codeHits`, lazy build if empty.
- `brain-status` shows `Code: N blocks M files synced Xm ago`.

### Added — P3 Cognition augment
- `think` retrieval-augmented: `rankedForQuery(goal+hypotheses,3)` + `searchCode(q,2)` → appends `[retrieved 3 episodes + 2 code]` — PFC grounded.
- `creative-thinking` far-neighbor 0.4-0.6: `qEmb=hashNeuralEmbed(cues)` picks `cosine 0.4-0.6` (not nearest) for novel fusion.
- `plan` draft from centroid `cosine>0.78`: goal-only `plan {goal}` → searches past plans via `hashNeuralEmbed(goal)` → `Draft from centroid [id] cosine 0.81` + suggested tasks.
- `brain-status` habit cluster (brute pairwise `cosine>0.82` no lib, <5ms) → `Habit suggestion: cluster "x" x5`.
- Build: 42KB → 69.87KB, `typecheck` pass, `21 tests` pass, `BLEND_SEMANTIC=0` rollback preserved.

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