# Development

Contributor guide for pi-brain — a [pi package](https://pi.dev/docs/latest/packages).

## Layout

```
src/
  index.ts        entry — registers tools, command, renderers, event handlers
  types.ts        BrainEpisode / BrainPlan / Deliberation
  knobs.ts        calibration constants (single knob surface)
  util.ts         truncate / isNoiseBash
  scoring.ts      pure: tokenize, normalizeTags, parseSince, SYN, TF-IDF scoring
  storage.ts      strict-mode persistence (~/.pi/agent/pi-brain.json)
  state.ts        module-singleton brain state (episodes, index, plans, flags) + reset
  recall.ts       incremental token index, prune, candidate pool
  tools/          one file per tool: remember, recall, think, creative, plan, habit, brain-status
  session.ts      session_start rebuild, compaction, shutdown, entry renderers
  inject.ts       before_agent_start injection + context dedup
  hooks.ts        tool_result auto-encode, tool_call guards, turn_end nudge
tests/            vitest unit tests (pure functions from scoring/validation)
scripts/          legacy copy-installers (install.sh / install.bat) — not needed for git installs
skills/pi-brain/  SKILL.md shipped via pi.skills
docs/             architecture.html (offline doc) + this guide
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

## Conventions

- Tool/command names: kebab-case (`brain-status`, `creative-thinking`, `/pi-brain`).
- Entry types: `:`-scoped (`brain:episode`, `brain:plan`, `brain:mode`, `brain:deliberation`).
- Constants: UPPER_SNAKE in `knobs.ts`; functions camelCase; types `Brain*` prefixed.
- Behavior-parity porting: every refactor keeps the exact scoring/guard logic — tests in `tests/` pin it.