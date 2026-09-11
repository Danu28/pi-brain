# pi-brain — human brain → pi

A `pi` extension that gives your coding agent a **hippocampus + PFC**: episodes you `remember` by cue, `recall` with TF-IDF, `think` before you act, `creative-thinking` distant ideas, `plan` in an ordered checklist, and `habit`-ize repeats. Strict workflow optional via `/pi-brain on`.

Standalone, zero deps — one `index.ts`, one `SKILL.md`.

## Install

```bat
install.bat        :: menu: [1] project  [2] global  [3] both
```

Copies `pi-brain/index.ts` + `SKILL.md` + `docs.html` to:
- project: `.pi/extensions/pi-brain/` + `.pi/skills/pi-brain/`
- global: `%USERPROFILE%\.pi\agent\extensions\pi-brain\` + `%USERPROFILE%\.pi\agent\skills\pi-brain\`

Manual: copy `pi-brain/` to either location above.

## Tools

| Tool | What |
|---|---|
| `remember` | encode episode (`cue`, `summary`, `detail?`) — exact cue → upsert, similar ≥3 → preview unless `force:true` |
| `recall` | TF-IDF recall by cue, ranked |
| `think` | PFC scratchpad `goal + hypotheses[1..3]` |
| `creative-thinking` | fuse 2–3 cues + latest think |
| `plan` | ordered tasklist `goal + tasks[]`, update via `id+done` |
| `habit` | scaffold `.pi/skills/brain-<name>/SKILL.md` |
| `brain_status` | count + token usage, overload signal |
| `/pi-brain on|off|status` | strict recall-only vs default |

## Strict workflow (on)

`recall → think → [creative-thinking if novel] → plan → read→edit 1 file→bash → plan.done → remember → habit → git commit`

Unhappy path auto-blocks `write/edit/bash` until `think{goal:"debug <Task N>"}` + `plan{id,done}`.

## Docs

Open `pi-brain/docs.html` (offline, single file) or read `pi-brain/SKILL.md`.

## License

MIT
