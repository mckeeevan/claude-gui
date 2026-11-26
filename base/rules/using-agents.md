<!-- claude-gui base: install.py keeps this file up to date. Delete this line to make it yours and stop updates. -->

# When to use the subagents

Applies to every change in a project with agents in `.claude/agents/`. How to write and brief an agent is in `.claude/rules/prompts-and-agents.md`; this file says which agent runs at which step, and when to skip one.

## The steps of a change

| Step | Agent | When it runs | When to skip it |
|---|---|---|---|
| Research | `task-researcher` | An outside API, file format or library you have not used in this project, or more than one reasonable way to build it. | You already know the answer and can point to it in the code or the docs. |
| Plan | `task-planner` | Work that spans more than one PR, a new subsystem or data model, or the person asks for a plan. | A fix or a feature that fits in one small PR. |
| Red tests | `tester` | Once per phase, covering every new function, component or endpoint in it (the red step of `.claude/rules/testing.md`), and once per bug fix (the failing repro). | Shell scripts, config and docs, which `testing.md` already exempts. |
| Build | you | Stub, green and refactor steps; wiring; styles. | Never skipped. You do this step yourself. |
| Review | `reviewer` | Every branch, before its first push, and again after a fix that changes more than about 50 lines. | Only a diff with no code: docs, Work View state, a version bump. |

A project may add its own agents (for example an `explorer` for outside APIs). Use one when its `description` matches the step; the table above still applies.

## Rules that keep the agents honest

- **The tester writes from the spec, not the code.** Brief it once per phase with every stub in the phase, what each must do and its edge cases; don't paste your implementation. It writes the tests with the expected-failure markers, runs them, shows them failing, and stops.
- **You don't change the tester's assertions.** If one is wrong, say why and send it back to the tester, or fix it yourself as its own step and say so in the PR. Never edit an assertion so it passes.
- **The reviewer is a gate, not a suggestion.** Fix every finding it marks as a bug before you push. Nits are optional: fix the cheap ones and say which you left. If you disagree with a finding, say why in the PR instead of ignoring it.
- **The reviewer reuses the phase gate's check run.** Give it the saved check output (`output.txt`); it re-runs `## Checks` only when files changed after that run.
- **One review pass and at most one re-review per PR.** A third pass means the change is too big: split it.
- **The research and plan steps can run in the background** while you do work that doesn't depend on them. Red tests and review are blocking: wait for the result before the next step.

## Cost

- Don't spawn an agent for a question you can answer with one search or one file read.
- No chains deeper than three (you, an agent, and one agent it calls).
- Pass only the context the step needs (paths, the spec, the diff range), as `prompts-and-agents.md` says.

## Showing it in the Work View

- The hooks log a `spawn` event when an agent starts and a `done` event when it reports. Log them yourself (`artifact_state.py log spawn --to tester`) only when the hooks aren't running, which you can tell when `.claude-gui/events.jsonl` doesn't grow as you work. Give the agent's to-dos `owner: <id>` (`tester`, `reviewer`).
- If an agent's tool is unavailable (a surface without subagents), do the step yourself, say so in one line in the PR, and log it under your own id with the text "done inline: no subagents here".
