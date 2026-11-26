<!-- claude-gui base: install.py keeps this file up to date. Delete this line to make it yours and stop updates. -->

# Implementing a plan

Used by the `/implement-*` commands that task-planner writes, and whenever the person says to carry out a plan in `.planning/plans/`.

## Before starting

- **Outline before building.** The last step of planning, after the phases and to-dos are laid out, is a design outline the person can react to: a Claude Design mockup (the Artifact tool's design type) when the work has anything to see, such as a page, a chart, a layout or a flow; otherwise a short outline doc of the shape of the change. Where Claude Design isn't available, use the nearest equivalent (an artifact mockup, or an image of a sketch). Link the plan and the outline, then stop: the shape of the work is still easy to change here. Start implementing once the person says go, or right away if they already said to plan and build in one go.
- Read the whole plan and the changes file (`.planning/changes/<same name>-changes.md`; create it from the template below if it is missing).
- Before each task, read that task's full section in the details file and the files it names.

## Each task

1. Do the tasks in order, one at a time, and tie every change to a task in the plan.
2. Follow `.claude/rules/testing.md`: the stub, red, green, refactor cycle for new code with a test framework; for scripts and config, check the result another way and say how.
3. Follow the project's patterns first and outside examples second.
4. When the task works, tick it `[x]` in the plan, and add one line per file to the changes file (Added, Modified or Removed: path and what changed). If you did something the plan didn't say, say what and why in that line.
5. When every task in a phase is ticked, tick the phase.

## Phase gate and cadence

- A phase is done only when every check under `## Checks` in `CLAUDE.md` passes: tests, type checks, builds, and the integration or e2e suites if the phase touched them. Capture the full output of long suites to a file (`cmd 2>&1 | tee output.txt`) and read it, rather than trusting a truncated tail.
- Then commit the phase to the work branch, never to the main branch:

  ```
  feat: Phase N - <what this phase does>

  - <change>
  - <change>

  Rationale: <why this phase exists>
  ```

- After that first OK, carry on to the next phase without waiting. Stop and ask only before merging, pushing to the main branch, or any step that can't be undone. If the person asks for a different pace ("stop after each phase"), follow that instead.
- If a check fails and you can't fix it within the phase, stop, leave the phase unticked, and report what fails with the output.

## Work View

If the project has a Work View, keep its todos in step: mark each task's todo in progress when you start it and done when it is ticked.

## Finishing

When every phase is ticked, add a release summary to the changes file (files created, modified and removed, dependencies, anything to know before deploying). Then give the person a short summary with links to the changes, plan, details and research files, and suggest deleting the planning files once they are merged.

## Changes file template

```markdown
<!-- markdownlint-disable-file -->
# Changes: <task name>

## Summary
<one or two sentences>

## Changes
### Added
### Modified
### Removed

## Release summary
<written once every phase is done>
```
