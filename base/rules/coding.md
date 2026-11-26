<!-- claude-gui base: install.py keeps this file up to date. Delete this line to make it yours and stop updates. -->

# Coding

Applies to every code change. Language and library guides (for example the write-good-d3 and editorial-d3-stories skills for D3) add to these rules and win where they are more specific.

## Change as little as the task needs

- The existing code is the source of truth. Keep its structure, style and logic.
- Change the least code that does the job, and fold new logic into what is there rather than replacing whole functions.
- Only touch code the task is about: no drive-by refactors, renames or style changes. Mention cleanups you notice instead of making them.
- Prefer the simplest standard solution: the standard library and common patterns first, a new dependency only when it is the clear standard or truly needed. No clever or speculative code, and no features nobody asked for.

## Readable code

- Code should explain itself through names and structure. Comment the why (a business rule, a non-obvious constraint, a workaround), not the what, and explain the approach of any non-trivial algorithm.
- Write comments as full sentences. No vacuous comments, and no emoji in code or comments.
- Say in a comment why an outside library is used when it isn't obvious.
- Follow the language's naming and idioms, and the project's linter and formatter.

## Correctness

- Handle edge cases on purpose: empty input, missing or invalid values, very large input. Fail with a clear error where the caller can act on it.
- Check facts that change over time (library APIs, versions, CLI flags) with a tool or the docs, not memory.
- Run the code or its tests before calling it done. The project's checks are listed under `## Checks` in `CLAUDE.md`.

## Safety

- Never commit secrets, tokens, personal names or private details, in code, config, fixtures or commit messages.
- Don't run destructive commands (deleting data, force-pushing, rewriting history) unless the person asked for that step.
