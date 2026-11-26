#!/usr/bin/env python3
"""Work View guard: makes sure Claude never lets the live view fall behind.

A Claude Code hook (stdlib only; it never raises and never blocks on its own
errors). It only acts in projects with a .claude-gui/ folder.

It keeps two times in .claude-gui/.guard.json:
  work  the last real step: a file edit outside .claude-gui/, or a significant
        command (tests, type checks, git commit or push, gh pr)
  push  the last time the view was brought up to date:
        - artifact mode: an ArtifactData write to the workview/live document
        - hooks mode: an edit to .claude-gui/state.yaml (the events hook already
          logs actions; only Claude can keep todos, focus and thinking current)

Then:
  PostToolUse        records work and pushes; when the view is over 2 minutes
                     behind, reminds Claude (at most once a minute)
  Stop               blocks ending the turn while work is newer than the last
                     push, once per stop (stop_hook_active), so it cannot loop
  UserPromptSubmit   in artifact mode, restates the rule in one line, so it
                     survives a context summary

Artifact mode is on when .claude-gui/artifact-url exists.
"""
import json
import os
import re
import sys
import time

STATE_DIR = ".claude-gui"
BEHIND = 120        # seconds before a reminder
REMIND_EVERY = 60   # seconds between reminders
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SIGNIFICANT = re.compile(
    r"\bgit\s+(commit|push|merge|rebase)\b|\bgh\s+pr\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck)\b"
    r"|\b(vitest|jest|pytest|tsc|mocha|playwright)\b|\bnode\s+--test\b|\bgo\s+test\b|\bcargo\s+(test|build|nextest)\b"
)


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def save(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


def out(obj):
    print(json.dumps(obj))


def is_push(tool, ti, artifact):
    if artifact:
        if "ArtifactData" not in tool:
            return False
        if str(ti.get("action") or ti.get("db_op") or "set") in ("get", "list", "query"):
            return False
        blob = json.dumps(ti)
        return "workview" in blob and "live" in blob
    if tool in EDIT_TOOLS:
        p = str(ti.get("file_path") or "").replace("\\", "/")
        return p.endswith(f"{STATE_DIR}/state.yaml")
    return False


def is_work(tool, ti):
    if tool in EDIT_TOOLS:
        p = str(ti.get("file_path") or ti.get("notebook_path") or "").replace("\\", "/")
        return bool(p) and f"/{STATE_DIR}/" not in f"/{p}"
    if tool == "Bash":
        cmd = str(ti.get("command") or "")
        return bool(SIGNIFICANT.search(cmd)) and "artifact_state.py" not in cmd
    return False


def how(artifact):
    if artifact:
        return ("log what you did (artifact_state.py log / set), run artifact_state.py live, then ArtifactData set "
                "collection workview, doc_id live, file_path .claude-gui/live.json, if_version from your last write")
    return "update .claude-gui/state.yaml (todos, focus, thinking, tests) to match what you just did"


def main():
    data = json.load(sys.stdin)
    root = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    d = os.path.join(root, STATE_DIR)
    if not os.path.isdir(d):
        return
    artifact = os.path.exists(os.path.join(d, "artifact-url"))
    path = os.path.join(d, ".guard.json")
    g = load(path)
    now = time.time()
    event = data.get("hook_event_name")

    if event == "PostToolUse":
        tool = data.get("tool_name") or ""
        ti = data.get("tool_input") or {}
        if is_push(tool, ti, artifact):
            g["push"] = now
            g.pop("pending_since", None)  # the view caught up
        elif is_work(tool, ti):
            g["work"] = now
            g.setdefault("pending_since", now)  # the first step the view hasn't seen
            behind = now - g["pending_since"]
            if behind > BEHIND and now - g.get("reminded", 0) > REMIND_EVERY:
                g["reminded"] = now
                out({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext":
                     f"Work View is {int(behind // 60)}+ min behind what you have done. Bring it up to date now: {how(artifact)}."}})
        save(path, g)
        return

    if event == "Stop":
        if data.get("stop_hook_active"):
            return  # we already blocked this stop once; never loop
        if g.get("work", 0) > g.get("push", 0):
            out({"decision": "block", "reason":
                 f"The Work View is behind your last step. Before you reply, {how(artifact)}. Then finish your turn."})
        return

    if event == "UserPromptSubmit" and artifact:
        out({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext":
             "Work View is live: log every step as it happens and push workview/live before each reply. Never batch."}})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
