# Claude GUI

![The Claude GUI dashboard](docs/screenshot.png)

A live D3 view of what Claude is working on. It shows a headline of where Claude is, a map of the app's parts as nested boxes with arrows for what uses what (laid out by ELK), the current thought, agents and the messages between them, a todo list with sub-todos, and an activity feed.

On a wide screen everything fits on one page: the headline and four numbers on top, then three columns (the current thought, tests and agents; the map, scaled to fit, with a Full size button; todos and the activity feed). Narrow screens stack the same panels.

Tests: the hook spots test commands (npm test, pytest, jest, vitest, cargo test, go test, node --test and others), reads the pass/fail summary and failing test names, and logs a `test` event. Claude adds the diagnosis in `state.yaml` under `tests:` (which part the cause is in, and why). The Tests panel shows recent runs as a strip, each suite, and each failure with its cause; failing parts get a red badge on the map, and hovering a failure lights up its part.

Coverage: after a test run the hook also looks for a fresh coverage report (coverage/coverage-summary.json, coverage-final.json, lcov.info, coverage.py's coverage.json, Cobertura coverage.xml, or Go's cover.out) and saves per-file line counts to `.claude-gui/coverage.json`. The page maps files to parts through their `paths`. The map's Tests view shades each part by coverage, hatches parts with no tests, and outlines failing ones in red.

Agents: one card per working agent, with a ring for its todos, its task, and a ribbon of what it did over the last 10 minutes (grey reads, black edits, red failed tests, orange for what it is doing now) with message pins above. Hover a stretch for the file and time; click a card for recent actions, its last message, todos and skills. Idle agents sit as chips below.

Brainstorming: parts can be `status: idea`, and a part can say `from:` which part(s) it was split off from or merged out of. The map grows new parts out of the old boxes and shrinks removed ones into whatever replaced them, so you can watch the plan reshape.

Each agent is a marker on the map. It stands on the part it is working on (that box grows a lane for it), glides to the next part when it moves, and parks in a waiting area under the map when idle. Hovering an agent shows a card with what it's for, what it's doing, where, and its skills; clicking pins the card. Hovering anything (a todo, a part, an agent, a feed line) lights up the related parts, agents and todos and dims the rest.

## Start here

**Claude:** follow [`skill/SKILL.md`](skill/SKILL.md), starting with "First: which way is this session running?". It covers install, picking hooks or the claude.ai artifact, turning on coverage and keeping the page current. If the person saved the `work-view` skill, it points here too.

**A person:** you need Python 3 and a browser with internet access (the page loads D3, js-yaml and elkjs from jsDelivr). Node is only needed to run the viewer's tests, and PyYAML (`pip install pyyaml`) only for `artifact_state.py set`. Then follow "Setup" below and ask Claude to "set up the Work View" in your project.

## How it works

Files in the project you're working on, in a `.claude-gui/` folder (or wherever `WORKVIEW_DIR` points):

| File | Written by | Holds |
| --- | --- | --- |
| `state.yaml` | Claude, by hand, following the skill | Goal, phase, focus, thinking, app structure, agents, todos |
| `events.jsonl` | Hooks, automatically (`auto: true`; Claude can append too) | One timestamped line per read, edit, command, test run, agent start or finish, message, pull request, prompt. Past 200 KB, older lines move to `history/` and the last 400 stay |
| `heartbeat` | The hook | The time of the last action, so the page can show "Live" or "Idle 4m ago" |
| `history/` | The hook | A timestamped copy of `state.yaml` each time Claude edits it |

The viewer re-reads the files every second (or, from a claude.ai project folder, every 2 seconds and only when the heartbeat moved) and merges them. When the heartbeat is fresh but `state.yaml` hasn't changed in 10 minutes, it shows "To-dos may be behind". Any tool can drive it: only the hook script is specific to Claude Code.

## Folder layout

```
install.py         installs or updates a project (hooks + local page, or --artifact) and its working base
base/              subagents, rules and the CLAUDE.md section install.py gives each project
viewer/            the page
  index.template.html   markup and styles; build.py embeds the example as demo data -> index.html
  src/model.js     pure data logic (parsing, merging, ELK layout, headline, agent cards), no DOM
  src/structure-chart.js, src/agent-chart.js, src/panels.js   reusable D3 views
  src/flip.js      glides HTML rows and cards to their new places
  src/panes.js, src/splitters.js   draggable dividers: pure sizing logic, and the pointer and key wiring
  src/app.js       data sources (artifact database, file polling, demo) and wiring
  test/            node:test unit tests and jsdom view tests
  serve.py         local server for one project
  legacy/          the previous page, kept as a fallback
hooks/
  claude_gui_hook.py      turns Claude Code hook events into events.jsonl lines, and warns Claude about bad state or missing coverage
  settings-snippet.json   the hook config install.py registers
tools/artifact_state.py   logs events, patches state.yaml, converts coverage, packs live.json (for the artifact)
tools/workview_guard.py   hook that reminds Claude, and blocks ending a turn, while the view is behind
tools/test_*.py    unit tests for both hooks
skill/SKILL.md     instructions Claude follows
example/.claude-gui/      sample state.yaml, events.jsonl and coverage.json (the demo data)
```

## Setup

```bash
git clone https://github.com/mckeeevan/claude-gui ~/claude-gui
python3 ~/claude-gui/install.py /path/to/project
python3 /path/to/project/.claude/claude-gui/viewer/serve.py /path/to/project
```

To update a project: `git -C ~/claude-gui pull && python3 ~/claude-gui/install.py /path/to/project`.

Then open http://localhost:8765. `install.py` puts the hook, viewer and skill in the project's `.claude/` (or `~/.claude/` with `--global`), registers the hook in `settings.json` without touching other settings, and starts `.claude-gui/` if it is missing. Claude does the rest from the skill: it fills in `state.yaml` and turns on test coverage.

A second hook, the Work View guard (`tools/workview_guard.py`), keeps Claude from letting the view fall behind: it reminds Claude when the view is 2 minutes or 6 steps behind its work (it never blocks a tool call), and blocks Claude from ending a turn until the view shows its latest step (once per turn, so it can't loop). In hooks mode "up to date" means `state.yaml` was updated; in artifact mode it means `workview/live` was written.

The event hook also talks back to Claude: after an edit to `state.yaml` it flags values cut off by unquoted commas, and after a test run with no coverage report it tells Claude how to turn coverage on for that runner (once per session). The viewer also repairs names already cut at commas.

## The working base

`install.py` also gives each project a way of working (skip it with `--no-base`):

- `.claude/agents/task-researcher.md` and `task-planner.md`: research before planning, plans in phases that can each be committed on their own, and an `/implement-<task>` command per plan. Planning files go in `.planning/`.
- `.claude/agents/tester.md` and `reviewer.md`: the tester writes red tests and bug repros from a spec; the reviewer checks every branch with code before it is pushed.
- `.claude/rules/`: `coding.md`, `testing.md` (including the test-first cycle), `implementing-plans.md`, `prompts-and-agents.md` and `using-agents.md` (which agent runs at which step of a change, and when to skip one).
- `.claude/commands/new-project.md`: `/new-project <what it's for>` sets up an empty project: it picks the stack, then (after your OK on the plan and outline) adds tests, coverage, lint, type checks, CI, the checks list and the project notes.
- A "How to work here" section in `CLAUDE.md` between `<!-- claude-gui:start -->` markers, saying when each rule applies, plus a `## Checks` list of the project's test and build commands (detected once, filled in later if the project started empty, then the project's to edit) and a `## Project` section for the stack and layout.

Planning stops once the phases, to-dos and a design outline (a Claude Design mockup, or an outline doc) are ready, for a go-ahead. After that, every phase runs and is committed to a work branch, and Claude stops again before merging. Rerunning `install.py` updates the base files; delete the marker line at the top of one to make it yours. Where these rules came from: [docs/agent-rules-merge.md](docs/agent-rules-merge.md).

## Use it from a claude.ai project folder

When Claude Code runs in a claude.ai project, the hooks can write straight into the project's shared folder and the published page can read it there, so the activity feed never falls behind and Claude never pushes anything but its own `state.yaml` edits:

```bash
python3 ~/claude-gui/install.py /path/to/project --dir /mnt/project-files/work-view --files-project chan_...
```

This saves `WORKVIEW_DIR` in `.claude/settings.json` (`"env"`), so every hook and `artifact_state.py` use that folder, and prints the publish steps with `capabilities: {"files": {"project": "chan_..."}, "db": ...}`. The page asks each viewer once for access to the project's files, then polls `work-view/heartbeat` every 2 seconds; only when it changed does it read the new tail of `events.jsonl` (by byte offset) and `state.yaml`. Viewers who can't open the project's files fall back to the database document, then to plain files.

## Use it from claude.ai

In a cloud session, or to get a shareable link, drive a published claude.ai artifact instead of `serve.py`. The hooks are installed either way (Claude Code runs project hooks in cloud sessions too), so actions are still logged automatically; only the push to the artifact is Claude's job:

```bash
python3 ~/claude-gui/install.py /path/to/project --artifact   # prints the steps below with real paths
```

1. Publish once with the Artifact tool: page `viewer/index.html`, files `viewer/src/*.js`, and `capabilities: {"db": {"rules": [{"path": "workview", "read": "view", "write": "admin"}]}}`. Republish only when the viewer code changes; a new version reloads every open view.
2. Save the artifact's URL to `.claude-gui/artifact-url`; this puts the guard in artifact mode.
3. For every update, record it with `tools/artifact_state.py` (`log` an event, `set` a state patch, `coverage` after tests), pack it with `artifact_state.py live`, and write `.claude-gui/live.json` to the artifact database: ArtifactData `set`, collection `workview`, doc `live`, `if_version` from the last write. The page reads the document live and animates the change, with no reload.

The page uses the database when it has one and falls back to polling `state/*.yaml|jsonl|json` files otherwise, so `serve.py` keeps working unchanged. It is still the zero-latency option when Claude runs on the same machine with the hooks installed.

The page loads D3, js-yaml and elkjs from jsDelivr, so it needs internet access. Opening `index.html` directly from disk won't work, because browsers block ES modules on `file://`. Use `serve.py`.

After editing `index.template.html` or the example files, run `python3 viewer/build.py`.

## Resizing

On wide screens, drag the lines between the columns, or between the panels in a side column, to give room to what matters now. Pull a panel down to its title to fold it. Double-click a line to put it back; arrow keys work on a focused line. Sizes are kept in this browser.

## If something looks wrong

- **"Demo data" in the header:** the page found no state. With `serve.py`, check the path you passed holds `.claude-gui/state.yaml`. On claude.ai, the `workview/live` document hasn't been written yet.
- **"Waiting for data":** the artifact database didn't answer within 10 seconds. Reload; if it persists, check the artifact was published with the `db` capability.
- **A warning bar about state.yaml:** the file didn't parse, so the last good version is shown. Fix the YAML, or rewrite it with `python3 tools/artifact_state.py set`.
- **Coverage shows "no tests" or "tested, no %":** the tests don't write a coverage report yet. See "Turning on coverage" in the skill.
- **"Idle 12m ago" while Claude is working:** the hooks aren't writing to the folder the page reads. Check `WORKVIEW_DIR` in `.claude/settings.json` matches the folder in the page (`filesDir`, default `work-view`).
- **"To-dos may be behind":** the hooks see Claude working but `state.yaml` hasn't changed in 10 minutes. Ask Claude to update its to-dos; the guard also reminds it.
- **Nothing moves when Claude works:** the hooks aren't running (check `.claude/settings.json` has the `claude_gui_hook.py` and `workview_guard.py` entries, rerun `install.py`, then start a new session), or, in artifact mode, Claude hasn't pushed `workview/live`.

## Configuration

Set `window.CLAUDE_GUI` before `src/app.js` loads to change where the page reads from: `{ state, events, coverage }` file paths (default `state/state.yaml` and so on), `heartbeat` (default `state/heartbeat`), `poll` (ms, default 1000), `dbDoc` (default `"workview/live"`), `filesDir` (the folder inside the claude.ai project, default `"work-view"`; empty turns the files source off) and `filesPoll` (ms, default 2000). The live document holds the files as text: `{ "state": "...yaml...", "events": "...jsonl...", "coverage": "...json...", "heartbeat": "..." }`.

The hooks and tools read `WORKVIEW_DIR` (absolute, or relative to the project) for the state folder; `serve.py` takes it too, or `--dir`.

## Tests

```
cd viewer && npm install && npm test
python3 -m unittest discover tools
```

## Still to do

- Wrap the viewer as a panel beside the chat in the Claude desktop app.
- Replay: a time scrubber over `events.jsonl` and `history/`.
- Read only the new part of a long `events.jsonl` instead of the whole file each second.
