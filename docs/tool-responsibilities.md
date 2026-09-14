# Tool Responsibilities — Current vs Proposed (1 Tool = 1 Verb)

> Companion to `docs/srp-audit.md`. Each pi-brain tool should have **one clear verb**. Table shows what the code *actually* does today vs the strict single-responsibility target. API stays stable — changes are internal delegation to helpers.

## Summary Rule

**One tool, one verb:** `remember` encodes · `recall` retrieves · `think` deliberates · `creative-thinking` fuses · `plan` sequences · `habit` scaffolds · `brain-status` reports. Helpers own scoring, tokenizing, gist, validation, indexing.

---

## 7 Tools

| Tool | Current responsibility (declared + actual code) | Proposed single responsibility | Owns (stays) | Delegates (extract) | API change? |
|---|---|---|---|---|---|
| **remember** `src/tools/remember.ts` | **Declared:** “Explicitly encode an episode… audits before write: exact cue → upsert, similar → preview, tags/refs” **Code:** `cueNorm` + empty checks, `normalizeTags`/`truncate` for tags/refs, exact-cue `find` → `unindex`/`index`, similarity audit `scoreBase` + `avgIdf` + IDF loop (duplicate), threshold `≥5`, `brain:episode` append, `recallMemo.clear()`, `brain:episode:encoded` emit. | **Encode** — persist one episode by cue. Verb: *encode* | Cue normalization, summary/detail truncate (50KB/2K), tag/refs cap (≤8/≤5), `appendEntry` + `episodes.set` + event. | **Audit** → `src/audit.ts:auditSimilarity(query, tags)` returning `scored[]`. **IDF** → `scoring.avgIdf()`. **Indexing** → `recall/index.ts:indexEpisode`. Memo clear stays but via helper. | No — params `cue,summary,detail,tags,refs,force` unchanged. Description trims audit detail: “encode; audit helper blocks similar unless force”. |
| **recall** `src/tools/recall.ts` | **Declared:** “TF-IDF cue→ranked… index + half-life + tag boost + filters” **Code:** memo key (tags normalized, `\x00` join) + LRU, `candidatePool` via `tokenIndex` + tag union, filters `source/since/expires/tags(AND)`, scoring `scoreEpisode` + `avgIdf` loop (duplicate), max across `queries[]`, fallback recency, `truncate` format, memo store/cap 50. | **Retrieve** — ranked episodes for cue(s). Verb: *retrieve* | Filter interpretation, `limit` handling, batch `queries[]` max-score logic, empty-query/tag-only path, fallback decision. | **Candidate pool** → `recall/candidates.ts:candidatePool()`. **Scoring+IDF** → `scoring.scoreEpisode` + `avgIdf`. **Memo LRU** → `recall/memo.ts`. **Formatting** → `gist.ts:formatRecall()`. | No — params `query,queries,limit,tags,source,since` unchanged. Batch stays 1-call=N. |
| **think** `src/tools/think.ts` | **Declared:** “PFC deliberation scratchpad: encode reasoning step… injected next turn” **Code:** `needsDebugThink` guard (requires goal startsWith `debug`), `Deliberation{goal,hypotheses,conclusion}` create, `deliberations` cap 10, `appendEntry`, `thinkSatisfied=true`, `needsDebugThink=false`, `needsPlanUpdate` if was debug, event emit. | **Deliberate** — save one deliberation. Verb: *deliberate* | Goal/hypotheses truncate, conclusion optional, `deliberations` append + cap, `appendEntry`, `thinkSatisfied` flag. | Guard stays as workflow enforcement but documented as cross-cutting; optionally move prefix check to `hooks/guards.ts` so tool is pure. Helper `createDeliberation()` becomes canonical owner for `plan.hypotheses` sugar. | No — `goal,hypotheses,conclusion` unchanged. |
| **creative-thinking** `src/tools/creative.ts` | **Declared:** "fuse distant episodes + latest think into novel approach" **Code:** loop `cues[2..3]` → `candidatePool(q)` + `scoreEpisode` + filter `>0` + sort + slice 2 → `pooled`, dedup `Map`, `recentThink` from `brain.deliberations`, `isLoose` prompt check (<15 chars or `creative approach`) → `synthesisPrompt` enrich, `gistForEpisode` sources, `context` = sources+deliberation, final fuse instruction. | **Fuse (strictly post-think)** — **When:** must be called *after* `think` (reads `brain.deliberations[−1]`; if missing, hint “call think first”). **Input:** latest `think {goal, hypotheses, conclusion}` + `cues[2..3]` episodes (+ `prompt?`). **Process:** delegate `rankedForQuery(cue,2)` per cue → dedup top-5 → fuse **hypotheses × episode patterns** into **novel variant not in either source**. **Output:** `synthesisPrompt` (enriched if loose) + `Sources` (gist) + `Deliberation` block + `→ Combine insights` instruction. Verb: *fuse* | Owns: prompt enrich (`isLoose` → append `cues+thinkGoal`), `deliberationBlock` build, final synthesis framing, `truncate`. | Delegates: **Retrieval** → `recall.rankedForQuery(query,2)` (instead of own `candidatePool+scoreEpisode` loop). **Gist** → `gist.ts`. **Think output** → reads but never writes (think owns deliberation). | No — `cues[2..3],prompt?` unchanged; sequencing is workflow rule (think → creative-thinking → plan). |
| **plan** `src/tools/plan.ts` | **Declared:** “Create/update detailed ordered tasklist after think… Requires 3-10… Pass id+done… Single-shot: include hypotheses to auto-create deliberation” **Code:** branch `if id exists` → `done` + `tasks` dedup + `goal` update; branch `if hypotheses` → validate len 2–3, chars ≥10, create `Deliberation` + `thinkSatisfied` (does think’s job); then require `goal+tasks`, validate `planTaskError` (now in `validation.ts`), create `BrainPlan` id `brain-plan:<ts>:<rand>`, `done` apply, `plans.set`, `cachedLatestPlan`, `needsPlanUpdate=false`, `appendEntry`, emit. | **Sequence** — create/update ordered tasklist. Verb: *sequence* | Validation via `validation.planTaskError`, dedup task titles, `id+done` update path, `renderPlan` + id return, `cachedLatestPlan` cache. | **Deliberation creation** → delegate `think.createDeliberation({goal,hypotheses})` — `plan` becomes one-line `if hypotheses → createDeliberation()` sugar, not owner. No own validation logic (already fixed: imports from `validation.ts`). | No (keep `goal,tasks,id,done,hypotheses` for compat) — but docs mark `hypotheses` as sugar deprecated → canonical is `think` then `plan`. |
| **habit** `src/tools/habit.ts` | **Declared:** “Create/update detailed ordered tasklist… Requires 3-10… Scaffold .pi/skills/…” (copy-paste desc) **Code:** `name` kebab sanitize, `cwd` resolve, `isProjectTrusted` block, `dir/file` calc, preview if exists without `force` → return preview + undo hint, `variant` → `## Alternative` append, `mkdirSync` + `withFileMutationQueue`/`writeFileSync`, text `Drafted … — undo: rm -r`. | **Scaffold** — draft one skill file. Verb: *scaffold* | Name sanitize, trust check, `mkdir` + write via mutation queue, `variant` merge, preview→blocked unless `force:true`, undo hint. | Nothing major — all supports scaffolding; helper `fs/skill.ts` optional for testability. | No — `name,when,steps,variant?,force?` unchanged. Fix description copy-paste (currently repeats plan’s description). |
| **brain-status** `src/tools/brain-status.ts` | **Declared:** “How full is brain? Episode count + context usage… Emits overload if >80%… Shows index + knobs” **Code:** `getContextUsage` try, `count/autoCount/remCount`, `pct`, `overloaded` if >80% or >50 eps → emit `brain:overload`, `idxStats` tokens→episodes + memo hits/miss, `gistPreview` 3×via `gistForEpisode`, `estTokens`, `knobs` string `MAX_BYTES…`, `budget` warn/stop, `txt` join + return details. | **Report** — metacognition dashboard. Verb: *report* | Count breakdown, `pct` calc, `overloaded` bool, `knobs` snapshot, `budget` label. | **Gist/token** → `gist.ts`/`scoring.estTokens` (already). Emit stays but documented as side-effect of reporting. | No — `brain-status {}` unchanged. |

---

## Supporting modules — where delegated code lives

| Helper (proposed) | Single duty | Owned by |
|---|---|---|
| `src/validation.ts` ✅ done | `planTaskError` | `plan` only |
| `src/scoring.ts:avgIdf()` ✅ done | `avg((N+1)/(df+1))+1` | `remember` + `recall` |
| `src/gist.ts` (proposed PR2) | `gistForEpisode` + `compressEpisodes` + `formatRecall` | `inject, session, creative, brain-status, recall` |
| `src/recall/candidates.ts` / `src/recall/index.ts` | `indexEpisode/unindex/rebuild` + `candidatePool` + `rankedForQuery(q, limit)` | `recall` + `creative` |
| `src/recall/memo.ts` | Memo key + LRU `30s` + cap 50 | `recall` |
| `src/audit.ts` | `auditSimilarity(query,tags)` → `scored[]` with `scoreBase*avgIdf` | `remember` |
| `src/deliberation.ts` | `createDeliberation({goal,hypotheses,conclusion})` | `think` (owner) — `plan` delegates |
| `src/hooks/guards.ts` etc. | `rm -rf` guard + `think-before-act` + `needsDebugThink/PlanUpdate` blocks | `hooks` barrel |

---

## How to use this table

- **Current** helps review PRs: if a change touches `remember` but modifies scoring weight, it should move to helper.
- **Proposed** is the target — achieves *one reason to change* per file. No tool gains a second verb.
- **API stable:** all `pi.registerTool` names + `Type.Object` params stay backward compatible; refactors are internal. `plan.hypotheses` stays as sugar calling `createDeliberation()` rather than owning it.

See also: `docs/srp-audit.md §2` overlaps, `skills/pi-brain/SKILL.md` Tools table (update habit description, shorten plan/remember blurbs to match verbs).
