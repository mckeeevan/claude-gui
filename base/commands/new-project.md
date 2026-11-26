---
description: 'Set up a new or empty project on the claude-gui base: stack, tests, coverage, lint, type checks, CI, structure notes and the Work View'
argument-hint: 'what the project is for, and any stack you already want'
---
<!-- claude-gui base: install.py keeps this file up to date. Delete this line to make it yours and stop updates. -->

# New project

Sets up a project so every later task starts from working checks and written-down conventions. The project's idea: $ARGUMENTS. If that is empty, ask what the project is for in one question, then carry on.

## 1. Plan (then stop)

1. Install the base if it isn't there yet: `python3 ~/claude-gui/install.py .` (clone or pull `https://github.com/mckeeevan/claude-gui` to `~/claude-gui` first). This gives the subagents, rules, `CLAUDE.md` section and Work View.
2. Have the `task-researcher` subagent research the stack for this idea: language and runtime, framework, test runner and coverage tool, linter and formatter, type checker, package manager, and CI. Follow its version policy (latest stable or LTS, whichever is supported longer). Keep what the person asked for; research only the open choices.
3. Have the `task-planner` subagent turn that into a setup plan. Its phases should match step 2 below, each committable on its own.
4. Fill the Work View: the goal, a first sketch of `structure:` with `paths` for each part, and the plan's phases as todos.
5. Make the design outline: a Claude Design mockup when the project has something to see (an app, a page, a chart); otherwise an outline doc with the folder layout, main parts and how they talk. Link the plan and the outline and **stop for the person's OK**.

## 2. Set up (after the OK, on a work branch, committing each phase)

Each item must end with a command that runs and passes on the empty skeleton.

| Item | Done when |
| --- | --- |
| Skeleton: package or module files, source and test folders, an entry point | The project builds or imports |
| `.gitignore` for the stack, plus `.claude-gui/` state, coverage output and `.planning/` scratch files the person doesn't want kept | `git status` shows only real files |
| Test runner with one real test of the skeleton | The test passes, and fails if the skeleton breaks |
| Coverage written as a report on every test run (see "Turning on coverage" in the claude-gui-state skill) | A test run writes the report and the Work View shows a % |
| Linter and formatter, configured in the project | Both run clean |
| Type checking where the language has it (TypeScript `tsc --noEmit`, Python mypy or pyright) | Runs clean |
| CI (GitHub Actions unless the person uses another) running every check on push and pull request | The workflow file runs the same commands as `## Checks` |
| `## Checks` in `CLAUDE.md` lists every command above, fastest first | Each listed command passes |
| `## Project` in `CLAUDE.md`: what it is, the stack and versions, the folder layout, naming and code conventions, and how to run it | Someone new could start from it |

Follow `.claude/rules/testing.md` and `.claude/rules/coding.md`. For D3 or charts, follow the write-good-d3 skill.

## 3. Finish

Run every check once more, tick the plan, update the Work View, and give the person a short summary: the stack chosen, the commands, and links to the plan and outline. Stop before merging.
