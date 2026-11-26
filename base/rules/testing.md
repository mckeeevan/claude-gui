<!-- claude-gui base: install.py keeps this file up to date. Delete this line to make it yours and stop updates. -->

# Testing

## Good tests

- Every test can fail: it asserts on a real result, not just that code ran. A test that passes against a stub is not a test.
- When mocking, check what the mock was called with, not only that it was called. Don't mock the thing under test.
- Cover the critical paths, then the edges: empty, missing, invalid, boundary and large inputs, and error paths.
- Name each test as the behavior it checks ("returns an empty list for no input").
- A bug fix comes with a test that fails before the fix; the `tester` writes it.
- Run every test you write and see it pass (and, for test-first, fail first) before you finish. Writing tests without running them doesn't count.

## Test-first (red, green, refactor)

Use it for new production code in any language with a unit test framework. Skip it for shell scripts, Dockerfiles, config, and for adding tests to code that already exists. A plan gives each new function or component four tasks, in one phase:

1. **Stub:** create the function or component so it imports cleanly and throws "not implemented".
2. **Red:** the `tester` subagent writes the phase's tests from the spec in one call (see `.claude/rules/using-agents.md`), with the real expected assertions, marked as expected failures, and run them to see them fail as expected. Markers: pytest `@pytest.mark.xfail(strict=True)`, Vitest or Jest `test.failing`, node:test `{ todo: true }`; elsewhere, the runner's nearest equivalent.
3. **Green:** write the simplest working code and remove the markers. Don't change the assertions: if a test was wrong, say so and fix it as its own step.
4. **Refactor:** tidy the code and add edge-case tests, keeping everything green.

An endpoint follows the same cycle: a stub that answers 501, red tests that expect the real behavior, then the implementation and its error handling.

Never put all the tests in a later phase than the code, and never rewrite a test's assertions to match what the code happens to do.
