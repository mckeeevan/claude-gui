# Where the working base came from

The subagents and rules in `base/` adapt the task researcher and planner system from [bretmckee/game-scheduler](https://github.com/bretmckee/game-scheduler) (main) to Claude Code, alongside the rules this project already had: the claude-gui-state skill, the D3 skills, short replies, and no names or secrets in committed files.

Only the Claude Code variants were used. The Copilot (`.github/agents`), DSH (`.agents/skills`) and Codex (`.copilot-tracking/*/AGENTS.md`) copies say the same thing in other formats. The Codex planning copy supplied the 4-task test-first structure.

| Source rule | Verdict | Where it went and why |
| --- | --- | --- |
| Research before plan (planner refuses without research, calls the researcher) | Adopt | `base/agents/task-planner.md` |
| Context budget, read once, one write then edits, length limits | Adopt | Both agents |
| Recovery protocol (finish the file, list what's outstanding, stop) | Adopt | Both agents |
| Measured `(Lines X-Y)` with `grep -n`; write order details → plan → command | Adopt | Planner |
| Phase isolation: callers move with code, no forward imports, add → migrate → delete | Adopt | Planner |
| Phase gate = every check green, not just tests | Merge | Gates come from the `## Checks` list in each project's `CLAUDE.md`; install.py detects npm/pnpm/yarn scripts, pytest, mypy, unittest, cargo and go |
| Research-only role: writes only to the research dir, cites every claim, narrows to one approach | Adopt | Researcher (dir is `.planning/research/`) |
| Version policy (latest stable or LTS, whichever is supported longer) | Adopt | Researcher |
| Stop after each task or phase; never commit without being told | Replace (your choice) | Plans stop once, after the phases, to-dos and design outline are laid out. After your OK, every phase runs and is committed to a work branch; Claude stops again before merging or touching main |
| Design outline before building | Add (yours) | Last planning step: a Claude Design mockup, or an outline doc when there is nothing to see |
| Naming `YYYYMMDD-NN-…`, `{{snake_case}}` markers that never survive | Adopt | Both agents |
| Thin router: root file indexes, rules hold the content | Adopt | The `CLAUDE.md` "How to work here" section, merged between markers so a project's own text is kept |
| Test-first 4-task cycle (stub, red with expected-failure markers, green without touching assertions, refactor) | Adopt, generalized | `base/rules/testing.md`, with markers for pytest, Vitest, Jest and node:test |
| Test quality (falsifiable tests, check mock calls, run every test) | Adopt | `base/rules/testing.md` |
| Minimal diff, preserve existing code, no unsolicited refactors, standard first | Adopt | `base/rules/coding.md` |
| Self-documenting code, comment why not what, no emoji | Adopt | `base/rules/coding.md`; the D3 skills stay in charge of D3 code |
| "Don't handle edge cases nobody mentioned" vs "always handle edge cases" | Merge | Handle edge cases on purpose; add no features nobody asked for |
| Verify version- or time-dependent facts with tools | Adopt | `base/rules/coding.md` |
| Changes file, divergences called out, release summary | Adopt | `base/rules/implementing-plans.md` |
| Capture long test output with `tee` | Adopt | `base/rules/implementing-plans.md` |
| Least-privilege tools, orchestrator's tools are the ceiling, wrapper brief, no pipelines over 5 to 10 steps | Adopt | `base/rules/prompts-and-agents.md` |
| Prompt safety: untrusted input as delimited data, no secrets, test prompts | Adopt, condensed | `base/rules/prompts-and-agents.md` (the 991-line guide's checklists, without the regex "sanitizer") |
| Prompt file structure (`.prompt.md`) | Adapt | Claude Code slash commands in `.claude/commands/` |
| Copilot handoffs, `#file`/`#fetch`/`${input:}`, `applyTo:` | Skip | Copilot-only |
| "Declare intent before every tool call" | Adopt (your choice) | One short line before each tool call: the `CLAUDE.md` section and both agents |
| "Code on request only" | Skip | Doesn't fit an agent that edits files |
| Researcher and planner opening every reply with a role banner | Adopt (your choice) | `## **Task Researcher**: …` and `## **Task Planner**: …` |
| Plan content never pasted into chat | Adopt | Fits short replies: plans are linked |
| `model: sonnet` | Replace | `model: inherit`, so the agents use the session's model |
| `uv`, testmon, docker compose, `services/api`, Fabric/Terraform examples | Skip | Project-specific; examples generalized |
| "Copilot: don't read AGENTS.md" | Skip | Only one harness here, so there is nothing to route around |
