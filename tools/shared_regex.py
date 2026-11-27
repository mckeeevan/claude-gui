"""Shared regex patterns for the hook and guard.

Both the event hook (hooks/claude_gui_hook.py) and the work view guard
(tools/workview_guard.py) need to agree on what counts as a "significant"
command. This module is the single source of truth so they can't drift.
"""
import re

# Commands that count as "significant work" for the guard (bug 5: was
# different in hook vs guard). Matches test runners, builds, git mutations,
# and PR operations.
SIGNIFICANT = re.compile(
    r"\bgit\s+(commit|push|merge|rebase)\b"
    r"|\bgh\s+pr\b"
    r"|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck)\b"
    r"|\b(vitest|jest|pytest|tsc|mocha|playwright|rspec|tox|nox|ctest|phpunit|mix|swift\s+test|deno\s+test|dotnet\s+test)\b"
    r"|\bnode\s+--test\b"
    r"|\bgo\s+test\b"
    r"|\bcargo\s+(test|build|nextest)\b"
    r"|\bmake\s+(test|check|build)\b"
)

# Tools that count as "research" (reads/searches) for the guard (bug 6:
# guard was blind to research). Weighted lower than edits.
RESEARCH_TOOLS = frozenset({
    "Read", "Grep", "Glob", "WebSearch", "WebFetch",
    "semantic_search", "grep", "glob", "view",
})
