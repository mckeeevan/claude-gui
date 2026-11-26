---
name: claude-gui-state
description: Keep .claude-gui/state.yaml up to date while working, so the live D3 viewer shows the app's structure, the current focus and thinking, agents and todos. Use in any project that has a .claude-gui/ folder, or when asked to show work in the Claude GUI viewer.
---

# Keeping the Claude GUI state file current

A live page (the Claude GUI viewer) draws what you are working on from two files in the project's `.claude-gui/` folder:

- `state.yaml` is **your picture of the work**. You edit it by hand. It holds the parts that need judgment: the goal, what you're thinking, the app's structure, agents' roles and the todo list.
- `events.jsonl` is **the timestamped log of what happened**. Hooks append to it automatically: every file read and edit, every command, every subagent start and stop, every prompt. Do not rewrite it. You may append a line for things hooks can't see (see "Messages" below).

The person watches the page while you work, so keep `state.yaml` honest and current. Small, frequent edits are better than one big rewrite.

## When to update state.yaml

Update it at these moments. Each update is one small Edit, not a rewrite.

1. **At the start of a task.** Set `session.goal` and `session.phase`. If `structure` is empty or stale, sketch the parts of the app you expect to touch.
2. **When your focus moves** to a different part of the app. Set `session.focus` to that part's id and mark the part `active`.
3. **When your thinking changes direction**: a decision, a doubt, a new plan. Rewrite `session.thinking` in one to three plain sentences, as you'd say it to a colleague looking over your shoulder.
4. **When you learn the app's shape.** Add, rename or regroup parts in `structure`. Add `paths` globs so the hooks can color the right part when files are edited, and `uses` so the map can draw what depends on what.
5. **When work finishes or gets stuck.** Mark parts `done` or `blocked`, and update the todo.
6. **When you start or finish a subagent.** Add or update its entry in `agents` with its role, task and the parts it's on. The hooks already log the start and the finish.
7. **At the end of the task.** Set `phase: done`, close out todos, and clear `focus` if nothing is in progress.

If you're unsure whether something is worth an update, ask: would the person watching be misled if it stayed as it is? If yes, update.

## Format

```yaml
version: 1
project: Short project name
updated: 2026-11-24T21:40:00-05:00   # set to now on every edit

session:
  goal: One sentence about what this session is for
  phase: building     # brainstorming | planning | exploring | building | testing | reviewing | done
  focus: api.auth     # id of the structure part you're on now
  thinking: >
    One to three sentences on what you're weighing right now.

structure:            # your mental model of the app, not the file tree
  - id: api           # unique; dotted ids read well
    name: API         # what a person would call it
    status: active    # untouched | idea | planned | active | done | blocked
    paths: ["src/api/**"]   # optional globs; matching edits light this part up
    note: Optional one-liner
    children:
      - id: api.auth
        name: Sign-in
        status: active
        paths: ["src/api/auth/**"]
        from: api.old             # optional: the part(s) this was split off from or merged out of
        coverage: 60%             # optional estimate, used only when no coverage report covers the part
        uses:                     # what this part depends on; drawn as arrows
          - db.sessions           # shorthand: just the id
          - { to: mail, kind: events, weight: 2 }   # kind: calls | data | events; weight 1-5

agents:               # optional; agents seen in the event log appear even if not listed
  - id: main          # "main" is always you, the lead
    name: Claude
    role: Lead
    about: One line on what this agent is for (shown when someone hovers it)
    task: What you're doing now
    nodes: [api.auth] # parts this agent is on; empty or idle means it waits off the map
    skills:           # optional; listed on the agent's card
      - write-good-d3
      - { name: claude-gui-state, description: "Keeps this file up to date" }
  - id: Explore       # use the subagent type as the id, so it matches the hook events
    name: Explorer
    role: Research
    task: Finding where sessions are stored
    nodes: [api.auth]

tests:                # what each suite covers, and why it fails when it does
  - id: auth
    name: Sign-in tests
    nodes: [api.auth]       # parts this suite covers
    passed: 14
    failed: 1
    failures:
      - name: rejects an expired session    # the test's name as the runner prints it
        node: db.sessions                   # the part where the cause is, which may differ from what the suite covers
        cause: Expiry is compared in local time, not UTC
        error: expected 401, got 200        # optional, one line
  - { id: mail, name: Mail tests, nodes: [mail], status: not_run }

todos:                # the one global list for the session
  - id: t1
    text: Add the sign-in route
    owner: main
    node: api.auth
    children:           # sub-todos; a parent without a status takes it from these
      - { id: t1a, text: Route and handler, status: done }
      - { id: t1b, text: Session cookie, status: in_progress }
  - { id: t2, text: Write tests for it, status: pending, node: api.auth }
  # status: pending | in_progress | done | blocked; note: optional
```

Rules that keep the page readable:

- Model the app the way a person would explain it: 3 to 8 top-level parts, each with a few children. Group files under parts with `paths`; don't list every file.
- Keep ids stable. Renaming an id makes the page treat it as a new part.
- Only one or two parts should be `active` at once. When you move on, set the old one back to `planned` or forward to `done`.
- Keep todos to things a person would recognize as steps, about 3 to 15 at the top level. Break a big one into sub-todos rather than adding more top-level items, and leave the parent's status off so it follows its children.
- Add `uses` for real dependencies only: calls, data a part reads or writes, events it listens to. The map lays parts out by these arrows, so a missing one puts a part in the wrong place and an invented one adds clutter. Use `weight` for how heavily one part leans on another.
- Clear an agent's `nodes` (or set `status: idle`) when it finishes, so its marker walks back to the waiting area instead of standing on a part it left.
- Brainstorming: write the structure early, before any code, with `status: idea` and `phase: brainstorming`. Rewrite it freely as the idea changes. When a part splits, give each new part `from: <old id>` and delete the old one; when parts merge, give the result `from: [a, b]`. To break a part down, just add `children`. The map animates each of these from the old boxes, so keep ids stable otherwise.
- Tests: the hook logs every test run with pass and fail counts and the failing test names, so don't copy counts by hand after each run. Your job is the diagnosis: after a failing run, add the failure under its suite with the `node` where the cause is and one sentence of `cause`. A later green run clears the failures on the page by itself; tidy them out of the file when you next edit it.
- Coverage: turn it on in the project's test config once, so every plain test run writes a report (see "Setting up a project"). The hook reads the report after each run and the page shades parts by it, so give parts accurate `paths`. Only write `coverage:` by hand when the project truly can't produce a report. If the hook tells you a run wrote no report, set coverage up then and there without asking.
- Test files: put tests where the runner finds them (`test/`, `*.test.ts`, `test_*.py`, `*_test.go`) and tag the work with the part's `node` or `paths`. The page counts a part as tested as soon as its test files exist.
- Quote any value that contains a comma, a colon followed by a space, or starts with a special character: `name: "IndexedDB (words, sightings)"`. Inside `{ ... }` an unquoted comma starts a new key and silently cuts the text. When in doubt, write the entry in block style. The hook checks the file after every edit and tells you what to fix.
- Write the YAML so it always parses. If an edit leaves it broken, the page keeps the last good version and shows a warning, so fix it right away.

## Messages

Hooks log subagent starts (`spawn`) and finishes (`done`) as messages. When something passes between agents that the hooks can't see, such as a subagent's key finding, append one line to `events.jsonl`:

```bash
echo '{"t":"'"$(date -Iseconds)"'","agent":"Explore","type":"message","to":"main","text":"Sessions are stored in Redis"}' >> .claude-gui/events.jsonl
```

Event fields: `t` (ISO time), `agent`, `type` (prompt, read, edit, run, search, spawn, done, message, note, state, stop), and optionally `target` (file or command), `to` (agent), `node` (structure id) and `text`.

## Setting up a project

Do all of this yourself; the person should not have to.

1. Install or update: `git clone https://github.com/mckeeevan/claude-gui ~/claude-gui` (or `git -C ~/claude-gui pull` if it is already there), then `python3 ~/claude-gui/install.py <project>`. It puts the hook, the viewer and this skill in the project's `.claude/`, registers the hook in `.claude/settings.json`, and creates `.claude-gui/` with a starter `state.yaml`. Run it again to update; it never overwrites `state.yaml` or the event log.
2. Fill in `state.yaml`: goal, a first sketch of the structure with `paths` for every part, agents and todos.
3. Turn on coverage in the test config, so a plain test run writes a report the hook can read:
   - vitest: `npm i -D @vitest/coverage-v8`, then in `vitest.config` set `test.coverage = { enabled: true, provider: 'v8', reporter: ['text', 'json-summary'] }`
   - jest: `collectCoverage: true, coverageReporters: ['text', 'json-summary']`
   - pytest: `pip install pytest-cov`, and `addopts = "--cov --cov-report=json --cov-report=term"`
   - go: `go test -coverprofile=cover.out ./...`; cargo: `cargo llvm-cov --lcov --output-path lcov.info`
   - node --test: `--experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=lcov.info`
   Add the report (`coverage/`, `coverage.json`, `lcov.info`) to `.gitignore`.
4. Run the tests once and check the viewer shows coverage: `python3 .claude/claude-gui/viewer/serve.py .`
5. Add `.claude-gui/` to `.gitignore` unless the person wants to keep the history.
