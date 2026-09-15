# pi-brain — human brain → pi

A `pi` extension that gives your coding agent a **hippocampus + PFC + hash-neural memory**: episodes you `remember` by cue, `recall` with **hybrid TF-IDF + hash-neural-384 (0.55/0.35) + code hits** (single brain dual corpus), `think` retrieval-augmented, `creative-thinking` far-neighbor, `plan` centroid draft, and `habit` cluster. **CPU <1ms embed, <50ms recall, 100% private, 0 deps** — `hash-neural-384` pure JS `mulberry32(42)` deterministic, no download, no daemon, offline. Strict workflow optional via `/pi-brain on`. `BLEND_SEMANTIC=0` reverts to v1 TF-IDF instantly.

Zero runtime deps beyond the pi-bundled core (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) — one compiled entry, one skill, `69.87KB`.

## Install

```bash
# from git (recommended, versioned — can pin: @v2.0.0)
pi install git:github.com/Danu28/pi-brain

pi install git:github.com/Danu28/pi-brain@v2.0.0

# from npm (after publish)
pi install npm:@danu28/pi-brain

# load once without installing (local dev)
pi -e ./src/index.ts
```

Then restart `pi` (or run `/reload`). Verify with `/pi-brain status` or `pi list`.

> Local dev: `pi -e ./src/index.ts` hot-loads the TypeScript source directly — no build needed.

## Permissions

Pi extensions run with **full system permissions**. pi-brain uses:

- **Writes** `~/.pi/agent/pi-brain.json` (or `$PI_CODING_AGENT_DIR/pi-brain.json`) to persist the strict-mode toggle across sessions.
- **Writes** skill files at `.pi/skills/brain-<name>/SKILL.md` when the `habit` tool drafts a skill (blocked in untrusted projects).
- **Runs git** — when a `plan` is completed, the strict workflow commits with `git init` (if needed) + `git add -A && git commit`.
- **Reads** optional override `pi-brain.syn.json` (cwd or `~/.pi/agent/`) merged into the synonym map.
- **Reads** workspace files for code index — `walkFiles` 500 cap gitignore-aware, chunk `800c/120`, embedded with `hash-neural-384` locally (no network).
- **UI** — uses `notify` / `confirm` dialogs and a status bar entry for strict mode.

Review the source before installing; only install packages you trust.

## Tools — v2.0.0 (hash-neural-384 single brain dual corpus)

| Tool | What — v2 |
|---|---|
| `remember` | encode episode (`cue`, `summary`, `detail?`, `tags?`, `refs?`) — exact cue → upsert, **semantic dedup `cosine>0.82` + TF-IDF `score≥5` → preview unless `force:true`**, embeds `hash-neural-384` base64 |
| `recall` | **hybrid `0.55 lexical +0.35 semantic` + code hits** — ranked episodes + `codeHits` (dual corpus, CPU/private); `includeCode: auto\|true\|false` (auto detects `where/how/find`), `filterPath`, `queries[]`, `tags/source/since`, tag-only recall |
| `think` | PFC scratchpad `goal + hypotheses[1..3]` **retrieval-augmented — appends top3 episodes + top2 code** via `rankedForQuery` + `searchCode` for grounded reasoning, injected next turn |
| `creative-thinking` | fuse 2–3 cues + latest think into a novel approach — **far-neighbor `0.4-0.6` cosine** (not nearest) for divergent `Substitute/Combine/Invert` variants |
| `plan` | ordered tasklist `goal + tasks[]`, update via `id+done` — **draft from centroid `cosine>0.78` when goal-only** (suggests tasks from most similar past plan) |
| `habit` | scaffold `.pi/skills/brain-<name>/SKILL.md` (+ `variant`, diff preview, undo hint) — **cluster suggestion via brute pairwise `cosine>0.82` in `brain-status`** |
| `brain-status` | episode count + token usage + overload signal, **neural `vecs/model 384d seed:42 blend:0.55/0.35 sim:0.82` + code `blocks/files synced`** |
| `/pi-brain on\|off\|status` | strict recall-only vs default pi behavior |

Rollback: set `BLEND_SEMANTIC=0` in `src/knobs.ts` or `~/.pi/agent/pi-brain.json` → v1 TF-IDF instantly, no rebuild.

## Strict workflow (`/pi-brain on`)

Happy (2-call floor): `recall → think → [creative-thinking if novel] → plan #1 → Turn1 read×N → Turn2 edit×N+write×N+bash → plan #2 done:[all] → remember → habit → git commit`

Unhappy (3-call floor): `plan #1 → failure → think{goal:"debug <Task N>"} → plan #2 → retry → plan #3 done:[all] → remember`

Blocks `write/edit/bash` until `think{goal:"debug ..."}`. Full rules in [`skills/pi-brain/SKILL.md`](skills/pi-brain/SKILL.md).

## Docs

- [`docs/architecture.html`](docs/architecture.html) — offline single-file architecture doc (how it works)
- [`docs/v2-proposal.html`](docs/v2-proposal.html) — v2 proposal: hash-neural-384, dual corpus, hybrid, CPU/private, examples
- [`docs/v2-roadmap.md`](docs/v2-roadmap.md) — P1+P2+P3 roadmap and build log
- [`docs/development.md`](docs/development.md) — build / test / publish for contributors
- [`skills/pi-brain/SKILL.md`](skills/pi-brain/SKILL.md) — loaded by pi; tool contracts + calibration knobs
- [CHANGELOG.md](CHANGELOG.md) — release history (v2.0.0 — 2026-09-15)

## Development

```bash
npm install       # dev tooling (tsup, typescript, vitest)
npm run typecheck # tsc --noEmit
npm test          # vitest — scoring/validation unit tests
npm run build     # tsup → dist/index.js + dist/index.d.ts (69.87KB)
npm pack --dry-run # verify 2.0.0 tarball 109KB
```

## License

MIT © 2026 Danu28
