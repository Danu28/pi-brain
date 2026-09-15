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

## P2 — Code index absorb (1 day) — ✅ DONE on v2
- [x] `src/code.ts` — walkFiles 500 cap gitignore-aware, chunk 800c/120, hashNeuralEmbed per block, buildCodeIndex <2s, patchCodeFile single-file, searchCode cosine+0.02 boost (all CPU/private, 0 deps, Pi-NN absorb)
- [x] `src/state.ts` `codeBlocks: CodeBlock[]`, `codeFileHashes`, `codeIndexStats {files,blocks,model,lastIndexedAt}`, `codeIndexing` + `resetBrain` cleanup, `src/session.ts` builds code index on `session_start` (lazy, <2s)
- [x] `src/hooks.ts` `patchCodeFile` on `write/edit` (cwd-relative, keeps index fresh)
- [x] `src/tools/recall.ts` `includeCode: auto|true|false` + `filterPath`, auto detects `where/how/find/src/.ts`, returns `episodes + codeHits` (decision+proof) with `-- code (3/500 blocks)` in text, memo includes codeHits, lazy build if empty
- [x] `src/tools/brain-status.ts` shows `Code: 0 blocks 0 files synced never` → after index `Code: 210 blocks 42 files synced 0m ago`, neural still `hash-neural-384 384d`
- [x] `npm run typecheck` pass, `npm test` 21 passed, `npm run build` 66KB (was 42KB)

## P3 — Think/Plan/Habit augment (1 day) — ✅ DONE on v2
- [x] `src/tools/think.ts` retrieval-augmented: after `createDeliberation`, `rankedForQuery(goal+hypotheses,3)` + `searchCode(q,2)` → appends `[retrieved 3 episodes + 2 code]` to return text
- [x] `src/tools/creative.ts` latent far-neighbor 0.4-0.6: pools top5 per cue, computes `qEmb=hashNeuralEmbed(cues)`, picks `cosine 0.4-0.6` far-neighbor for novel fusion, fallback to farthest
- [x] `src/tools/plan.ts` draft from centroid `cosine>0.78`: if goal-only, `hashNeuralEmbed(goal)` vs past plans → returns `Draft from centroid [id] cosine 0.81` + suggested tasks
- [x] `src/tools/brain-status.ts` habit cluster (brute pairwise `cosine>0.82` no lib, <5ms) → `Habit suggestion: cluster "x" x5` or hint, exposed in `txt` + `details.habitHint`
- [x] `npm run typecheck` pass, `npm test` 21 passed, `npm run build` pending 2.0.0 tag
- [ ] `docs/architecture.html` update + `CHANGELOG 2.0.0` + tag + publish (next)

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
