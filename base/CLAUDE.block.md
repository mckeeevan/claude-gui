## How to work here

This section is kept up to date by claude-gui's `install.py`; edit outside the markers. The rules themselves live in `.claude/rules/`; this list only says when each applies.

**Always**
- `.claude/rules/coding.md`: change as little as the task needs, readable code, edge cases, no secrets.
- `.claude/rules/testing.md`: tests that can fail, and the test-first cycle for new code.
- `.claude/rules/using-agents.md`: the `tester` writes the red tests and bug repros, and the `reviewer` checks every branch before it is pushed.
- Keep the Work View current (the `claude-gui-state` skill): `.claude-gui/state.yaml`, or `$WORKVIEW_DIR`.
- Keep replies short: the result, the link, and anything the person needs to do.
- Before each tool call, say in one short line what you are about to do and why.

**When the task calls for it**
- A new or empty project: run `/new-project`. It picks the stack, sets up tests, coverage, lint, type checks and CI, and writes `## Checks` and `## Project` below.
- Asked to research, plan or scope something bigger than a quick fix, or the work needs an outside API you haven't used here: use the `task-researcher` and `task-planner` subagents (`.claude/agents/`, and `.claude/rules/using-agents.md` for when). Planning files go in `.planning/`.
- Carrying out a plan (`/implement-*`): `.claude/rules/implementing-plans.md`. Planning ends with the phases and to-dos laid out and a design outline (a Claude Design mockup, or an outline doc when there is nothing to see); stop there for the person's OK; after that, run every phase on a work branch, committing each one, and stop again before merging or touching the main branch.
- Writing a subagent, command, skill or a prompt inside an app: `.claude/rules/prompts-and-agents.md`.
- D3, charts or data graphics: the `write-good-d3` skill, and `editorial-d3-stories` (or `editorial-d3-observable` in Observable) for editorial or animated graphics.

Keep `## Project` below current when the stack, layout or conventions change. The project's own instructions in this file, outside these markers, win where they differ.
