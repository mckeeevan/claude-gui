---
name: claude-gui-state
description: Set up and keep current the Claude GUI (Work View), the live D3 page showing the app's structure, focus, tests and coverage, agents and todos. Use in any project with a .claude-gui/ folder, or when asked to show work in the Claude GUI, Work View or viewer.
---

# Keeping the Claude GUI state file current

## The rule

The person watches the Work View live. For the whole session, including after a context summary or a long break:

- **Every action shows up as it happens**: each read, edit, command, test run, commit, push, agent start or finish, and message. Never batch, and never plan to "catch up later".
- **A reply to the person is a step too.** Bring the view up to date before the reply goes out: todos, focus and thinking in `state.yaml`, and in artifact mode a push of `workview/live`.
- **The guard hook enforces this.** It reminds you when the view falls 2 minutes or 6 steps behind, and blocks ending your turn while you have done work the view hasn't seen. When it fires, update the view, then carry on. Don't argue with it or work around it.

A live page (the Claude GUI viewer) draws what you are working on from two files in the project's `.claude-gui/` folder (or `$WORKVIEW_DIR` when it is set):

- `state.yaml` is **your picture of the work**. You edit it by hand. It holds the parts that need judgment: the goal, what you're thinking, the app's structure, agents' roles and the todo list.
- `events.jsonl` is **the timestamped log of what happened**. Hooks append to it automatically (marked `auto: true`): every file read and edit, every command, test run, subagent start and stop, prompt, message and pull request. They also touch `heartbeat`, so the page can tell "working now" from "idle", and move old lines to `history/` once the log passes 200 KB. Do not rewrite it. You may append a line for things hooks can't see (see "Messages" below).

The person watches the page while you work, so keep `state.yaml` honest and current. Small, frequent edits are better than one big rewrite.

## First: which way is this session running?

Decide at the start of every task, without asking the person, and set it up if it isn't:

1. **Get the latest code**: `git -C ~/claude-gui pull`, or `git clone https://github.com/mckeeevan/claude-gui ~/claude-gui` if it is missing. If the clone is refused in a cloud session, attach the repo `mckeeevan/claude-gui` to the session and clone again.
2. **Pick the mode.**
   - **Hooks + local page**: Claude runs on the person's own machine and they will open the page there. Run `python3 ~/claude-gui/install.py <project>` (once per project; again to update). Hooks log your actions; serve the page with `python3 .claude/claude-gui/viewer/serve.py .` and give the person `http://localhost:8765`.
   - **claude.ai artifact**: a cloud session, or the person wants a link they can open anywhere. Run `python3 ~/claude-gui/install.py <project> --artifact` and follow "Running as a claude.ai artifact" below. If the project already has a Work View artifact (check `.claude-gui/artifact-url`, or list artifacts), keep using it; otherwise publish one and save its URL to `.claude-gui/artifact-url`, which switches the guard to artifact mode.
   - **claude.ai project folder**: the session runs in a claude.ai project with a shared folder (`/mnt/project-files/`). Run `python3 ~/claude-gui/install.py <project> --dir /mnt/project-files/work-view --files-project <the project's chan_ id>`. The hooks write straight into that folder and the published page reads it through the `files` capability, so the log is never behind and nothing needs pushing: your only job is `state.yaml`. Don't save `artifact-url` in this mode. Prefer this over the plain artifact whenever the folder exists.
   - All modes install the hooks. Claude Code runs project hooks in cloud sessions too, so actions are logged for you; after installing, start a new session or check `/hooks` if they don't fire yet.
   - When unsure, use the artifact: it works everywhere.
3. **Turn on coverage** if the tests don't already write a report (see "Turning on coverage").
4. **Give the person the link** once, then keep it current without being asked.

## When to update state.yaml

Update it at these moments. Each update is one small Edit, not a rewrite.

1. **At the start of a task.** Set `session.goal` and `session.phase`, and break the ask into todos with sub-items before you start (see the todo rules below). If `structure` is empty or stale, sketch the parts of the app you expect to touch. If the project has tests and a plain test run writes no coverage report, turn coverage on now, without asking (how, per runner, is under "Turning on coverage").
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
      - { id: t1c, text: Tests for expired and missing sessions, status: pending }
  - id: t2
    text: Send password reset mail
    node: mail
    children:
      - { id: t2a, text: Pick a mail provider, status: blocked, note: Waiting on the person to choose }
      - { id: t2b, text: Reset link and token expiry, status: pending }
  # status: pending | in_progress | done | blocked; note: optional
```

Rules that keep the page readable:

- Model the app the way a person would explain it: 3 to 8 top-level parts, each with a few children. Group files under parts with `paths`; don't list every file.
- Keep ids stable. Renaming an id makes the page treat it as a new part.
- Only one or two parts should be `active` at once. When you move on, set the old one back to `planned` or forward to `done`.
- Split every todo into concrete sub-items (`children`), one per deliverable step, so it's obvious what will get done and how far along it is. "Add sign-in" becomes route and handler, session cookie, tests, docs. Keep about 3 to 15 at the top level, and leave a parent's status off so it follows its children.
- Every ask goes on the list the moment you hear it: one you're putting off goes in as `pending`, and anything waiting on the person (a decision, access, a review) gets its own todo with `status: blocked` and a `note` saying what you need.
- Add `uses` for real dependencies only: calls, data a part reads or writes, events it listens to. The map lays parts out by these arrows, so a missing one puts a part in the wrong place and an invented one adds clutter. Use `weight` for how heavily one part leans on another.
- Clear an agent's `nodes` (or set `status: idle`) when it finishes, so its marker walks back to the waiting area instead of standing on a part it left.
- Brainstorming: write the structure early, before any code, with `status: idea` and `phase: brainstorming`. Rewrite it freely as the idea changes. When a part splits, give each new part `from: <old id>` and delete the old one; when parts merge, give the result `from: [a, b]`. To break a part down, just add `children`. The map animates each of these from the old boxes, so keep ids stable otherwise.
- Tests: the hook logs every test run with pass and fail counts and the failing test names, so don't copy counts by hand after each run. Your job is the diagnosis: after a failing run, add the failure under its suite with the `node` where the cause is and one sentence of `cause`. A later green run clears the failures on the page by itself; tidy them out of the file when you next edit it.
- Coverage: turn it on in the project's test config once, so every plain test run writes a report (see "Turning on coverage"). The hook reads the report after each run and the page shades parts by it, so give parts accurate `paths`. Only write `coverage:` by hand when the project truly can't produce a report. If the hook tells you a run wrote no report, set coverage up then and there without asking.
- Test files: put tests where the runner finds them (`test/`, `*.test.ts`, `test_*.py`, `*_test.go`) and tag the work with the part's `node` or `paths`. The page counts a part as tested as soon as its test files exist.
- Quote any value that contains a comma, a colon followed by a space, or starts with a special character: `name: "IndexedDB (words, sightings)"`. Inside `{ ... }` an unquoted comma starts a new key and silently cuts the text. When in doubt, write the entry in block style. The hook checks the file after every edit and tells you what to fix.
- Write the YAML so it always parses. If an edit leaves it broken, the page keeps the last good version and shows a warning, so fix it right away.

## Messages

Hooks log subagent starts (`spawn`) and finishes (`done`), messages you post to the person or other sessions (`message`) and pull requests you open (`pr`). When something passes between agents that the hooks can't see, such as a subagent's key finding, append one line to `events.jsonl`:

```bash
python3 .claude/claude-gui/artifact_state.py log message --agent Explore --to main --text "Sessions are stored in Redis"
```

Event fields: `t` (ISO time), `agent`, `type` (prompt, read, edit, run, search, spawn, done, message, pr, note, state, stop), and optionally `target` (file or command), `to` (agent), `node` (structure id) and `text`. A line you write for the same target within 2 seconds of a hook's line replaces it in the feed, so add `text` when you have something better to say than the hook.

## Setting up a project

Do all of this yourself; the person should not have to.

**A new or empty project:** install (step 1), then run `/new-project` with what the project is for. It researches the stack, plans and outlines the setup, stops for the person's OK, then sets up tests, coverage, lint, type checks, CI, `## Checks` and `## Project`. The steps below are for an existing project.

1. Install or update: `git clone https://github.com/mckeeevan/claude-gui ~/claude-gui` (or `git -C ~/claude-gui pull` if it is already there), then `python3 ~/claude-gui/install.py <project>`. It puts the hook, the viewer and this skill in the project's `.claude/`, registers the hook in `.claude/settings.json`, creates `.claude-gui/` with a starter `state.yaml`, and adds the working base (researcher and planner subagents, `.claude/rules/`, and a section in `CLAUDE.md`). Run it again to update; it never overwrites `state.yaml` or the event log.
2. Fill in `state.yaml`: goal, a first sketch of the structure with `paths` for every part, agents and todos.
3. Turn on coverage (see "Turning on coverage").
4. Run the tests once and check the viewer shows coverage: `python3 .claude/claude-gui/viewer/serve.py .`
5. Add `.claude-gui/` to `.gitignore` unless the person wants to keep the history.

## Turning on coverage

Set it in the test config, so a plain test run writes a report the hook (or `artifact_state.py coverage`) can read:
   - vitest: `npm i -D @vitest/coverage-v8`, then in `vitest.config` set `test.coverage = { enabled: true, provider: 'v8', reporter: ['text', 'json-summary'] }`
   - jest: `collectCoverage: true, coverageReporters: ['text', 'json-summary']`
   - pytest: `pip install pytest-cov`, and `addopts = "--cov --cov-report=json --cov-report=term"`
   - go: `go test -coverprofile=cover.out ./...`; cargo: `cargo llvm-cov --lcov --output-path lcov.info`
   - node --test: `--experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=lcov.info`

Add the report (`coverage/`, `coverage.json`, `lcov.info`) to `.gitignore`. Whoever runs the tests (this session, a session on the person's machine, CI) reports the coverage.

## Running as a claude.ai artifact

The viewer is a published claude.ai artifact rather than `serve.py`. Install with `python3 ~/claude-gui/install.py <project> --artifact`; it prints the publish steps. The hooks log your actions to `events.jsonl` when they run; where they don't (a surface without Claude Code hooks), log each step yourself with `artifact_state.py log`. Either way, only you can push the view:

- **Publish the viewer once** with the `db` capability `{"db": {"rules": [{"path": "workview", "read": "view", "write": "admin"}]}}` (anyone with the link reads, only editors write). Publish again only when the viewer code changes. **Never republish for a state change**: a new version reloads every open view and loses what the person had open.
- **Log every step as it happens** (see "The rule"). If the hooks aren't running, write each event yourself: `python3 .claude/claude-gui/artifact_state.py log edit --target src/a.ts --node api.auth`. Check `.claude-gui/events.jsonl` grows as you work to know which case you're in.
- **Publishing state files directly** (instead of the database) needs `contentType: "text/plain"` for `.yaml` and `.jsonl`; prefer the database, which never reloads the page.
- **Change state.yaml only through the tool**: `artifact_state.py set '{todos: [{id: t3, status: done}]}'`. It merges by id at any depth, writes valid YAML (quoting included) and stamps `updated`. Don't hand-edit flow maps.
- **Push each update**: `artifact_state.py live`, then ArtifactData `set` with collection `workview`, doc_id `live`, `file_path` `.claude-gui/live.json`, and `if_version` set to the version your last write returned. The page updates in place.
- **After every test run**: `artifact_state.py log test --target "npm test" --passed N --failed M`, then `artifact_state.py coverage coverage/coverage-summary.json .`, then `live` and `set`.
- **Several writers** (you plus helper or remote sessions) share the one document: always pin writes with `if_version`, and say in each helper's brief whether it writes its own events or reports to you and you write them.
- **Agent ids** should be what the person sees (`tester`, `reviewer`, `mac` for a session on their machine). The hooks log each agent's `spawn` and `done`; log them yourself only when the hooks aren't running. Give its to-dos `owner: <id>`, and clear its `nodes` when it finishes. When the Work View shows only you for a whole PR, the tester and reviewer steps were skipped.
- **Keep a copy of `.claude-gui/`** where the person can open it (the project's shared files, or the repo), since a cloud scratchpad is wiped.
- **The page may be shared by link**: no secrets, tokens or private data in state, events or paths.
