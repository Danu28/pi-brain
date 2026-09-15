# pi-brain v2 Roadmap — hash-neural-384 · CPU/private · Single Brain

> Proposal: `docs/v2-proposal.html` — offline single-file spec.

## Versions
- **v1.0.0** (current, `master`): TF-IDF + SYN 10, 7 tools, Map, truncate 50KB, half-life decay.
- **v2.0.0-alpha.0** (`v2` branch, this): scaffold only — `src/neural.ts` + knobs, no behavior change yet.
- **v1.1.0** → P1: neural recall core (hybrid).
- **v1.2.0** → P2: code index absorb.
- **v2.0.0** → P3: think/plan/habit augment.

## P1 — Neural recall core (1 day) — ✅ DONE on v2
- [x] `src/neural.ts` pure JS hash-neural-384 (0 deps, mulberry32 42, <1ms)
- [x] `src/knobs.ts` BLEND_LEXICAL 0.55 / BLEND_SEMANTIC 0.35 / BLEND_TAG 0.10, SIMILAR_COSINE 0.82, NEURAL_DIM 384
- [x] `src/types.ts` `Episode.embedding?: string` base64 + `src/state.ts` `embeddings: Map<string,Float32Array>` cache + `resetBrain` + `session.ts` hydrate + `recall.ts` prune cleanup
- [x] `src/scoring.ts` hybrid: `hybridScore()` + `getEpisodeEmbedding()` + `episodeTextForEmbedding()`, `final = (0.55*normLex +0.35*cosine +0.10*tag) * decay * source` via maxLex norm, `BLEND_SEMANTIC=0` → v1 pure lexical
- [x] `src/recall.ts` `rankedForQuery` hybrid + `src/tools/recall.ts` batch hybrid + perQuery hybrid + qEmb cache
- [x] `src/tools/remember.ts` embeds on encode/upsert (`toBase64` + `brain.embeddings`), semantic dedup `cosine>0.82` alongside TF-IDF `score≥5`
- [x] `src/tools/brain-status.ts` shows `vecs / model hash-neural-384 384d seed:42 blend 0.55/0.35/0.10 sim:0.82`
- [x] `npm run typecheck` pass, `npm test` 21 passed (3 files)

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
