# pi-brain — human brain → pi

A `pi` extension that gives your coding agent a **hippocampus + PFC**: episodes you `remember` by cue, `recall` with TF-IDF, `think` before you act, `creative-thinking` distant ideas, `plan` in an ordered checklist, and `habit`-ize repeats. Strict workflow optional via `/pi-brain on`.

Zero runtime deps beyond the pi-bundled core (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) — one compiled entry, one skill.

## Install

```bash
# from npm (recommended, versioned)
pi install npm:@danu28/pi-brain

# or directly from git (can pin: @v1.0.0)
pi install git:github.com/Danu28/pi-brain@v1.0.0

# load once without installing
pi -e npm:@danu28/pi-brain
```

Then restart `pi` (or run `/reload`). Verify with `/pi-brain status` or `pi list`.

> Local dev: `pi -e ./src/index.ts` hot-loads the TypeScript source directly — no build needed.

## Permissions

Pi extensions run with **full system permissions**. pi-brain uses:

- **Writes** `~/.pi/agent/pi-brain.json` (or `$PI_CODING_AGENT_DIR/pi-brain.json`) to persist the strict-mode toggle across sessions.
- **Writes** skill files at `.pi/skills/brain-<name>/SKILL.md` when the `habit` tool drafts a skill (blocked in untrusted projects).
- **Runs git** — when a `plan` is completed, the strict workflow commits with `git init` (if needed) + `git add -A && git commit`.
- **Reads** optional override `pi-brain.syn.json` (cwd or `~/.pi/agent/`) merged into the synonym map.
- **UI** — uses `notify` / `confirm` dialogs and a status bar entry for strict mode.

Review the source before installing; only install packages you trust.

## Tools

| Tool | What |
|---|---|
| `remember` | encode episode (`cue`, `summary`, `detail?`, `tags?`, `refs?`) — exact cue → upsert, similar ≥3 → preview unless `force:true` |
| `recall` | TF-IDF recall by cue/query, ranked; batch `queries[]`, filters `tags/source/since`, tag-only recall |
| `think` | PFC scratchpad `goal + hypotheses[1..3]`, injected next turn |
| `creative-thinking` | fuse 2–3 cues + latest think into a novel approach |
| `plan` | ordered tasklist `goal + tasks[]`, update via `id+done` (batch `done:[0,1]` in one call) |
| `habit` | scaffold `.pi/skills/brain-<name>/SKILL.md` (+ `variant`, diff preview, undo hint) |
| `brain-status` | episode count + token usage + overload signal, index/memo stats |
| `/pi-brain on\|off\|status` | strict recall-only vs default pi behavior |

## Strict workflow (`/pi-brain on`)

Happy (2-call floor): `recall → think → [creative-thinking if novel] → plan #1 → Turn1 read×N → Turn2 edit×N+write×N+bash → plan #2 done:[all] → remember → habit → git commit`

Unhappy (3-call floor): `plan #1 → failure → think{goal:"debug <Task N>"} → plan #2 → retry → plan #3 done:[all] → remember`

Blocks `write/edit/bash` until `think{goal:"debug ..."}`. Full rules in [`skills/pi-brain/SKILL.md`](skills/pi-brain/SKILL.md).

## Docs

- [`docs/architecture.html`](docs/architecture.html) — offline single-file architecture doc (how it works)
- [`docs/development.md`](docs/development.md) — build / test / publish for contributors
- [`skills/pi-brain/SKILL.md`](skills/pi-brain/SKILL.md) — loaded by pi; tool contracts + calibration knobs
- [CHANGELOG.md](CHANGELOG.md) — release history

## Development

```bash
npm install       # dev tooling (tsup, typescript, vitest)
npm run typecheck # tsc --noEmit
npm test          # vitest — scoring/validation unit tests
npm run build     # tsup → dist/index.js + dist/index.d.ts
npm run pack      # npm pack --dry-run — inspect the tarball
npm publish       # publishes after prepublishOnly checks
```

## License

MIT © 2026 Danu28