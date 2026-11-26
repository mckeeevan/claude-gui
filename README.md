# Claude GUI

![The Claude GUI dashboard](docs/screenshot.png)

A live D3 view of what Claude is working on. It shows a headline of where Claude is, a map of the app's parts as nested boxes with arrows for what uses what (laid out by ELK), the current thought, agents and the messages between them, a todo list with sub-todos, and an activity feed.

On a wide screen everything fits on one page: the headline and four numbers on top, then three columns (the current thought, tests and agents; the map, scaled to fit, with a Full size button; todos and the activity feed). Narrow screens stack the same panels.

Tests: the hook spots test commands (npm test, pytest, jest, vitest, cargo test, go test, node --test and others), reads the pass/fail summary and failing test names, and logs a `test` event. Claude adds the diagnosis in `state.yaml` under `tests:` (which part the cause is in, and why). The Tests panel shows recent runs as a strip, each suite, and each failure with its cause; failing parts get a red badge on the map, and hovering a failure lights up its part.

Coverage: after a test run the hook also looks for a fresh coverage report (coverage/coverage-summary.json, coverage-final.json, lcov.info, coverage.py's coverage.json, Cobertura coverage.xml, or Go's cover.out) and saves per-file line counts to `.claude-gui/coverage.json`. The page maps files to parts through their `paths`. The map's Tests view shades each part by coverage, hatches parts with no tests, and outlines failing ones in red.

Agents: a timeline with one lane per agent (its current task, busy stretches, a tick per action) and lines for messages, spawns and hand-backs. Hover a tick for what happened, hover a name for the agent's card.

Brainstorming: parts can be `status: idea`, and a part can say `from:` which part(s) it was split off from or merged out of. The map grows new parts out of the old boxes and shrinks removed ones into whatever replaced them, so you can watch the plan reshape.

Each agent is a marker on the map. It stands on the part it is working on (that box grows a lane for it), glides to the next part when it moves, and parks in a waiting area under the map when idle. Hovering an agent shows a card with what it's for, what it's doing, where, and its skills; clicking pins the card. Hovering anything (a todo, a part, an agent, a feed line) lights up the related parts, agents and todos and dims the rest.

## How it works

Two files in the project you're working on, in a `.claude-gui/` folder:

| File | Written by | Holds |
| --- | --- | --- |
| `state.yaml` | Claude, by hand, following the skill | Goal, phase, focus, thinking, app structure, agents, todos |
| `events.jsonl` | Hooks, automatically (Claude can append too) | One timestamped line per read, edit, command, agent start or finish, message, prompt |
| `history/` | The hook | A timestamped copy of `state.yaml` each time Claude edits it |

The viewer re-reads both files every second and merges them. Any tool can drive it: only the hook script is specific to Claude Code.

## Folder layout

```
viewer/            the page
  index.template.html   markup and styles; build.py embeds the example as demo data -> index.html
  src/model.js     pure data logic (parsing, merging, ELK layout, headline), no DOM
  src/structure-chart.js, src/agent-chart.js, src/panels.js   reusable D3 views
  src/app.js       polling, demo mode and wiring
  test/            node:test unit tests and jsdom view tests
  serve.py         local server for one project
hooks/
  claude_gui_hook.py      turns Claude Code hook events into events.jsonl lines
  settings-snippet.json   hook config to merge into ~/.claude/settings.json
skill/SKILL.md     instructions Claude follows to keep state.yaml current
example/.claude-gui/      sample state.yaml and events.jsonl
```

## Setup

```bash
git clone https://github.com/mckeeevan/claude-gui ~/claude-gui
python3 ~/claude-gui/install.py /path/to/project
python3 /path/to/project/.claude/claude-gui/viewer/serve.py /path/to/project
```

To update a project: `git -C ~/claude-gui pull && python3 ~/claude-gui/install.py /path/to/project`.

Then open http://localhost:8765. `install.py` puts the hook, viewer and skill in the project's `.claude/` (or `~/.claude/` with `--global`), registers the hook in `settings.json` without touching other settings, and starts `.claude-gui/` if it is missing. Claude does the rest from the skill: it fills in `state.yaml` and turns on test coverage.

The hook also talks back to Claude: after an edit to `state.yaml` it flags values cut off by unquoted commas, and after a test run with no coverage report it tells Claude how to turn coverage on for that runner (once per session). The viewer also repairs names already cut at commas.

## Use it from claude.ai

In a cloud session (no hooks) or to get a shareable link, drive a published claude.ai artifact instead of `serve.py`:

```bash
python3 ~/claude-gui/install.py /path/to/project --artifact   # prints the steps below with real paths
```

1. Publish once with the Artifact tool: page `viewer/index.html`, files `viewer/src/*.js`, and `capabilities: {"db": {"rules": [{"path": "workview", "read": "view", "write": "admin"}]}}`. Republish only when the viewer code changes; a new version reloads every open view.
2. For every update, record it with `tools/artifact_state.py` (`log` an event, `set` a state patch, `coverage` after tests), pack it with `artifact_state.py live`, and write `.claude-gui/live.json` to the artifact database: ArtifactData `set`, collection `workview`, doc `live`, `if_version` from the last write. The page reads the document live and animates the change, with no reload.

The page uses the database when it has one and falls back to polling `state/*.yaml|jsonl|json` files otherwise, so `serve.py` keeps working unchanged. It is still the zero-latency option when Claude runs on the same machine with the hooks installed.

The page loads D3, js-yaml and elkjs from jsDelivr, so it needs internet access. Opening `index.html` directly from disk won't work, because browsers block ES modules on `file://`. Use `serve.py`.

After editing `index.template.html` or the example files, run `python3 viewer/build.py`.

## Tests

```
cd viewer && npm install && npm test
```

## Still to do

- Wrap the viewer as a panel beside the chat in the Claude desktop app.
- Replay: a time scrubber over `events.jsonl` and `history/`.
- Read only the new part of a long `events.jsonl` instead of the whole file each second.
