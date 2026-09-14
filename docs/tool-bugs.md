# Tool Bugs & Gaps Audit — All 7 Tools

**Date:** 2026-09-14 · **Scope:** `src/tools/*.ts` + cross-cutting `hooks/inject/recall/scoring/state/util`
**Method:** line-by-line read, happy/unhappy workflow replay, edge-input fuzz

---

## Summary

- **Critical (fix now):** 2 — `creative` unreachable dead code after post-think guard, `plan` update path bypasses `planTaskError` validation (can exceed 10 or add short tasks)
- **High (fix next PR):** 2 — `remember` description says `≥3` but code `≥5`, `think` vs `plan{hypotheses}` validation mismatch (1 vs 2, no length check)
- **Medium (gaps):** 4 — `recall` tag-only fallback keeps 0-score, `hooks` duplicate auto-encode, `brain-status` overload `>50` vs `PRUNE_CAP 40`, `creative` no `avgIdf` vs `recall`
- **Low (debt):** rest — SYN file silent catch, `truncate` UTF-8, `isNoiseBash` tiny-error exception

No blocking API break — all fixes keep `pi.registerTool` params stable.

---

## Tool-by-tool

### 1. remember `src/tools/remember.ts`

| # | Severity | Current | Gap/Bug | Proposed fix |
|---|---|---|---|---|
| R1 | High | Description: “similar (score≥3) → preview” but code `filter s>=5` | Doc/code drift → callers expect 3 | Align desc to `≥5` (we use 5 to cut false positives) or lower to 3. **Fix desc** to `≥5`. |
| R2 | Medium | `if (exact && !force) upsert else if (force) → new duplicate cue` | `force:true` with duplicate cue creates duplicate id `cue:<ts>:rand` — same cue appears twice | Document: `force` bypasses similar audit only, **exact cue always upserts** even with force. Change `if (exact)` to upsert regardless of force (or make force only for similar). |
| R3 | Low | O(n) `find` for exact | Scale n=40 fine, but index would be O(1) | Optional: `tokenIndex` exact cue map |
| R4 | Low | `id: cue.replace(/[^a-z0-9-]/gi,"-").slice(0,30)` — cue `!!!` → id `---:ts` | Cosmetic | Clamp empty → `episode:ts` |

### 2. recall `src/tools/recall.ts`

| # | Current | Gap |
|---|---|---|
| RC1 | `filter(x=>x.s>0 \|\| every query empty \|\| filterTags?)` keeps 0-score when query empty | Tag-only empty query returns *all* candidates sorted recency after fallback — okay for tag-only but empty+no-filter also returns recency (maybe surprise, but convenient). Keep but document. |
| RC2 | `avgIdf` applied after `scoreEpisode` (which already has `decay*sourceBoost`) — intentional but creative skips it | Normalize: creative should also use `avgIdf` for consistency. |
| RC3 | `allQToks` computed twice (candidate pool + idf) | DRY — reuse `terms` |

### 3. think `src/tools/think.ts`

| # | Current | Gap |
|---|---|---|
| T1 | `hypotheses[1..3]` only schema `minItems:1`, no length check | `think{goal:"x", hypotheses:["a"]}` passes but `plan{hypotheses:["a"]}` requires `≥10 chars` + `≥2`. **Mismatch** — strict workflow says “think 2-3 detailed”. Fix: align think to also require `≥10 chars` or document difference (think is scratchpad, plan is gate). |
| T2 | No `thinkSatisfied` reset on `session_start`? Actually `before_agent_start` resets, ok | — |

### 4. creative-thinking `src/tools/creative.ts` — **Critical**

| # | Current | Bug |
|---|---|---|
| C1 | **Dead code** `if (!unique.length && !recentThink)` on line 45 is **unreachable** after `if (!recentThink)` early return on line 28. Copy-paste left 2nd check dead. | Remove dead `if`, keep single path. Also duplicated `synthesisPrompt2/sources2` vs `synthesisPrompt/sources` — extract helper. |
| C2 | No `avgIdf` vs recall | Ranking differs. Should delegate to `rankedForQuery(q,2)` helper (proposed). |
| C3 | Hint path builds `text2` with `Sources` only, omits `Deliberation` block (since missing think) — intentional but `→ Combine` instruction truncated | Keep but share `gistForEpisode` path |

**Fix applied in this patch:** remove dead `if`, keep hint path.

### 5. plan `src/tools/plan.ts` — **Critical**

| # | Current | Bug |
|---|---|---|
| P1 | **Update path `if (params.id)` does not validate** `planTaskError` — can `plan{id,tasks:["a","b"]}` push 2 short tasks or exceed 10 via repeated updates. Create path validates, update path does not. | Add validation after merge: `if (params.tasks?.length) { const err = planTaskError(pl.tasks.map(t=>t.title)); if(err) return error }` or at least length≥10 check. |
| P2 | `plan{hypotheses}` validates `≥2` + `≥10 chars` but `think` validates `≥1` no length — same concern as T1 | Align or delegate to `think.createDeliberation()` so validation single place. |
| P3 | `plan` goal optional on update but `goal` truncate not checked empty | Minor — allow empty goal update? Currently `if (params.goal) pl.goal=truncate` — empty string `""` falsy so no update, ok. |

### 6. habit `src/tools/habit.ts`

| # | Gap |
|---|---|
| H1 | Description was plan copy — **fixed** `5df1c53` to scaffold. |
| H2 | No `steps` length check — empty skill would be `---\nname...\n\n# name\n\n\n` | Add guard `if (!steps.trim())` |
| H3 | `safe` empty → `Invalid habit name` good, but `dir` still derived from cwd — ok |

### 7. brain-status `src/tools/brain-status.ts`

| # | Gap |
|---|---|
| B1 | `overloaded = pct>80 || count>50` but `PRUNE_CAP=40` — count never exceeds 50 after prune, so second clause rarely fires. Should be `> PRUNE_WARN 35` or `>40`. |
| B2 | `knobs` string omits `PRUNE_WARN/CAP` | Add to string |

### Cross-cutting

| Module | Gap |
|---|---|
| `hooks.ts` | Duplicate `bash` auto-encode block (lines 24-52 vs 53-73) — 90% copy. Should extract `encodeBash(cmd,output)` helper. Also `isNoiseBash` tiny-error `output.length<30 → false` means short errors still encoded (intentional per comment). |
| `inject.ts` | Strict top-3 scored vs default top-1 — ok, but `PRUNE_WARN 35` prune not awaited? `pruneExpired(pi)` sync. |
| `scoring.ts` SYN | Silent catch on `pi-brain.syn.json` parse — invalid JSON silently ignored; should warn. |
| `state.ts` | `resetBrain` clears `deliberations.length=0` but `plans` via `clear()` — asymmetry ok (array vs Map). |
| `util.ts` | `truncate` `Buffer.from(text).slice(0,MAX_BYTES).toString().replace(/\uFFFD+$/, "")` — removes replacement char but not handling that slice may cut in middle of multi-byte; ok per comment. |

---

## Minimal patches applied now

1. **`creative.ts`** — remove unreachable `if (!unique.length && !recentThink)` dead branch (keeps hint path).
2. **`plan.ts`** — add validation in update path: after merging tasks, check `planTaskError` on full list and shortcheck (keeps 3..10, ≥10 chars). Prevents exceeding cap via updates.
3. **Docs** — this file + `tool-responsibilities` creative post-think already documented.

Next PR (optional):
- align `think` hypotheses length check (or keep scratchpad lenient),
- `remember` desc `≥5`,
- `hooks` DRY `encodeBash`,
- `brain-status` overload `>40`,
- `gist.ts` extract.

Verification: `npm run typecheck && npm test && npm run build` must pass (13 tests).
