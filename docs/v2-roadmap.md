# pi-brain v2 Roadmap — hash-neural-384 · CPU/private · Single Brain

> Proposal: `docs/v2-proposal.html` — offline single-file spec.

## Versions
- **v1.0.0** (current, `master`): TF-IDF + SYN 10, 7 tools, Map, truncate 50KB, half-life decay.
- **v2.0.0-alpha.0** (`v2` branch, this): scaffold only — `src/neural.ts` + knobs, no behavior change yet.
- **v1.1.0** → P1: neural recall core (hybrid).
- **v1.2.0** → P2: code index absorb.
- **v2.0.0** → P3: think/plan/habit augment.

## P1 — Neural recall core (1 day)
- [x] `src/neural.ts` pure JS hash-neural-384 (0 deps)
- [x] `src/knobs.ts` BLEND_LEXICAL 0.55 / BLEND_SEMANTIC 0.35 / BLEND_TAG 0.10, SIMILAR_COSINE 0.82
- [ ] `Episode.embedding?: Float32Array` + base64 persistence in `storage.ts`
- [ ] `remember` embeds `cue+summary+detail+tags`, warns if `cosine>SIMILAR_COSINE`
- [ ] `scoring.ts` hybrid: `final = (0.55*normLex +0.35*cosine +0.10*tag) * decay * sourceBoost`, SYN kept
- [ ] `recall.ts` uses `hybridScore`, keeps `tokenIndex/exactCueIndex`, adds `includeCode` stub (no code yet)
- [ ] `brain-status` shows `vecs / model: hash-neural-384`
- [ ] `tests/neural.test.ts` + `tests/scoring-hybrid.test.ts`, `npm run typecheck && npm test`

Rollback: `BLEND_SEMANTIC=0` → v1 lexical instantly.

## P2 — Code index absorb (1 day)
- [ ] `src/neural.ts` already covers embed; add `chunk.ts` (800c/120) + `walk.ts` (500 cap, gitignore)
- [ ] `state.ts` `codeVectors: IndexedBlock[]`, `session.ts` build on `session_start`
- [ ] `hooks.ts` `patchFile` on `write/edit/bash`
- [ ] `recall {includeCode:"auto"|true|false}` returns `episodes + codeHits`
- [ ] `brain-status` `blocks` count, `docs/v2-proposal.html` bars reproducible via `npm run bench:recall`

## P3 — Think/Plan/Habit augment (1 day)
- [ ] `think` retrieval-augmented (top3 episodes + top2 code via `hashNeuralEmbed(goal)`)
- [ ] `creative-thinking` latent far-neighbor `0.4-0.6`
- [ ] `plan` draft from centroid `cosine>0.78`
- [ ] `habit` cluster (brute k-means, no lib) → proposal
- [ ] `docs/architecture.html` updated, `CHANGELOG` → 2.0.0, tag + publish

## Branching
- `master` stays 1.0.0 (publishable).
- `v2` branch tracks this roadmap; merge to master at P3.
- No Xenova, no vector DB — stays CPU/private.

## Commands
```bash
git checkout v2
npm run typecheck
npm test
npm run build
# preview proposal
start docs/v2-proposal.html
```
