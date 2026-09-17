# Development

Contributor guide for pi-brain — a [pi package](https://pi.dev/docs/latest/packages).

## Layout

```
src/
  index.ts        entry — registers tools, command, renderers, event handlers
  types.ts        BrainEpisode / BrainPlan / Deliberation
  knobs.ts        calibration constants + truncate() (single knob surface, pi-brain.knobs.json override)
  scoring.ts      pure: tokenize, normalizeTags, parseSince, SYN (file-only via pi-brain.syn.json), TF-IDF scoring, rubric parse, index, prune, candidatePool, truncate re-export
  state.ts        module-singleton brain state (episodes, tokenIndex, plans, deliberations, flags, memo, compaction) + MODE_FILE + sidecar (async saveMemory) + reset/latestPlan/renderPlan
  tools.ts        7 tools in one file: remember (audit+habit-due) / recall (score breakdown + memo gen) / think (debate) / creative-thinking / plan (QDS+DAG+commit hint) / habit / brain-status (collapsed)
  session.ts      session_start/tree rebuild (sidecar + branch, file wins), compaction (score keep 3/5, lastCompactionKept), entry renderers, footer sync
  inject.ts       before_agent_start flag reset + context static BRAIN_FLOW_NOTE (KV-stable) + legacy dedup
  hooks.ts        tool_result flags + 2-failure debug gate + tool_call think/plan gates (batch-aware) + rm -rf guard + turn_end Rule-5 nudge
  command.ts      /pi-brain strict|guided|off|status|help (help alias, file wins)
  footer.ts       🧠 ON/OFF themed status bar
pi-brain.syn.json  synonym map (file-only SYN, merged from cwd + $PI_CODING_AGENT_DIR)
pi-brain.knobs.json knob overrides (cwd or $PI_CODING_AGENT_DIR, logged via brain-status)
tests/            vitest unit tests (scoring, hooks, inject, tools — 56 tests)
scripts/          legacy copy-installers (install.sh / install.bat) — not needed for git installs
skills/pi-brain/  SKILL.md shipped via pi.skills (slim workflow, calibration knobs)
docs/             architecture.html (offline single-file doc, post-delete reality) + this guide
```

## Commands

```bash
npm install          # dev tooling
npm run typecheck    # tsc --noEmit (strict)
npm test             # vitest run
npm run build        # tsup → dist/index.js + dist/index.d.ts + sourcemap
```

## Release

```bash
npm version patch|minor|major   # bumps + tags (keeps package.json ↔ git tag in sync)
git push origin main release/1.0.0 --tags
```

Releases are git tags (`v1.0.0`). Installers pin a tag to get a fixed version, or install unpinned to track latest:

```bash
pi install git:github.com/Danu28/pi-brain@v1.0.0   # pinned release
pi install git:github.com/Danu28/pi-brain          # latest
```

`ci.yml` verifies `main` and `release/*` on every push (typecheck → test → build). No npm publishing.

Release sanity checklist:

1. `npm run typecheck && npm test && npm run build` pass locally.
2. Fresh shell `pi install git:github.com/Danu28/pi-brain@v1.0.0` — `/pi-brain status` responds.
3. `pi install git:github.com/Danu28/pi-brain` (unpinned) works from a clean clone.
4. `pi-brain.syn.json` + `pi-brain.knobs.json` overrides read correctly (brain-status shows override source when verbose).

## Conventions

- Tool/command names: kebab-case (`brain-status`, `creative-thinking`, `/pi-brain`).
- Entry types: `:`-scoped (`brain:episode`, `brain:plan`, `brain:mode`, `brain:deliberation`).
- Constants: UPPER_SNAKE in `knobs.ts` (let with file override); functions camelCase; types `Brain*` prefixed.
- Scoring: single-pass `RUBRIC_RE` for `cost:/risk:/rev:`; `truncate()` lives in `knobs.ts` (single surface) and is re-exported by `scoring.ts`.
- State: single source `getBrainMode()` (no `brainStrict` mirror); `saveMemory()` is async via `withFileMutationQueue`.
- Behavior-parity porting: every refactor keeps the exact scoring/guard logic — tests in `tests/` pin it.
