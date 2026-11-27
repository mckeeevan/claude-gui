#!/usr/bin/env python3
"""Work View guard: makes sure Claude never lets the live view fall behind.

A Claude Code hook (stdlib only; it never raises and never blocks on its own
errors). It only acts in projects with a .claude-gui/ folder, or WORKVIEW_DIR set
(the same folder the event hook writes to).

It keeps two times in .claude-gui/.guard.json:
  work  the last real step: a file edit outside .claude-gui/, or a significant
        command (tests, type checks, git commit or push, gh pr)
  push  the last time the view was brought up to date:
        - artifact mode: an ArtifactData write to the workview/live document
        - hooks mode: an edit to .claude-gui/state.yaml (the events hook already
          logs actions; only Claude can keep todos, focus and thinking current)

Then:
  PostToolUse        records work and pushes; reminds Claude when the view is
                     over 2 minutes behind (at most once a minute) or after every
                     6 steps it hasn't seen. A tool call is never blocked.
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
NAG_STEPS = 6       # steps since the last push that earn a reminder, whatever the time
SESSION_TTL = 3600  # bug 4: guard state older than this is dropped, so an interrupted
                    # session can never block a future session's Stop forever
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}

# Bug 5: the significant-command regex lives in one place now, shared with the
# event hook, so the two can never disagree about what counts as real work.
try:
    from shared_regex import SIGNIFICANT, RESEARCH_TOOLS
except ImportError:  # installed as a hook, tools/ not on the path
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
    try:
        from shared_regex import SIGNIFICANT, RESEARCH_TOOLS
    except ImportError:
        SIGNIFICANT = re.compile(r"\bgit\s+(commit|push|merge|rebase)\b|\bgh\s+pr\b")
        RESEARCH_TOOLS = frozenset({"Read", "Grep", "Glob", "WebSearch", "WebFetch"})


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


def state_dir(root):
    d = os.environ.get("WORKVIEW_DIR")
    return os.path.join(root, d) if d else os.path.join(root, STATE_DIR)


def session_state(path, session_id):
    """Bug 4: the guard state is per session. The old single work/push pair meant an
    interrupted session blocked every future session's Stop, once, forever."""
    st = load(path)
    if st.get("session") != session_id or time.time() - st.get("ts", 0) > SESSION_TTL:
        st = {"session": session_id}
    return st


def save_state(path, session_id, st):
    st["session"] = session_id
    st["ts"] = time.time()
    save(path, st)


def is_push(tool, ti, artifact, d):
    if artifact:
        if "ArtifactData" not in tool:
            return False
        if str(ti.get("action") or ti.get("db_op") or "set") in ("get", "list", "query"):
            return False
        blob = json.dumps(ti)
        return "workview" in blob and "live" in blob
    if tool in EDIT_TOOLS:
        p = str(ti.get("file_path") or "")
        return os.path.basename(p) == "state.yaml" and inside(p, d)
    if tool == "Bash":  # artifact_state.py set rewrites state.yaml for Claude
        cmd = str(ti.get("command") or "")
        return "artifact_state.py" in cmd and " set" in cmd
    return False


def inside(p, d):
    try:
        a, b = os.path.abspath(p), os.path.abspath(d)
        return os.path.commonpath([a, b]) == b
    except ValueError:
        return False


def is_work(tool, ti, d):
    if tool in EDIT_TOOLS:
        p = str(ti.get("file_path") or ti.get("notebook_path") or "")
        return bool(p) and not inside(p, d)
    if tool == "Bash":
        cmd = str(ti.get("command") or "")
        return bool(SIGNIFICANT.search(cmd)) and "artifact_state.py" not in cmd
    return False


def is_research(tool):
    """Bug 6: the guard used to be blind to research. Reads and searches count as
    work at a lower weight, so a long research-only stretch still gets a reminder."""
    return tool in RESEARCH_TOOLS


def how(artifact):
    if artifact:
        return ("log what you did (artifact_state.py log / set), run artifact_state.py live, then ArtifactData set "
                "collection workview, doc_id live, file_path .claude-gui/live.json, if_version from your last write")
    return "update .claude-gui/state.yaml (todos, focus, thinking, tests) to match what you just did"


def profile_settings(root):
    """Strictness comes from profile.yaml (workview.behind_seconds / remind_every_seconds),
    not from hardcoded constants, so a project can tune how naggy the guard is."""
    try:
        import yaml
        with open(os.path.join(root, "profile.yaml"), encoding="utf-8") as fh:
            wv = (yaml.safe_load(fh) or {}).get("workview") or {}
        return int(wv.get("behind_seconds", BEHIND)), int(wv.get("remind_every_seconds", REMIND_EVERY))
    except Exception:
        return BEHIND, REMIND_EVERY


def main():
    data = json.load(sys.stdin)
    root = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    d = state_dir(root)
    if not os.path.isdir(d):
        return
    behind_limit, remind_limit = profile_settings(root)
    artifact = os.path.exists(os.path.join(d, "artifact-url"))
    path = os.path.join(d, ".guard.json")
    session = data.get("session_id") or "default"
    g = session_state(path, session)
    now = time.time()
    event = data.get("hook_event_name")

    if event == "PostToolUse":
        tool = data.get("tool_name") or ""
        ti = data.get("tool_input") or {}
        if is_push(tool, ti, artifact, d):
            g["push"] = now
            g.pop("pending_since", None)  # the view caught up
            g["steps"] = 0
        elif is_work(tool, ti, d):
            g["work"] = now
            g.setdefault("pending_since", now)  # the first step the view hasn't seen
            g["steps"] = g.get("steps", 0) + 1
            behind = now - g["pending_since"]
            late = behind > behind_limit and now - g.get("reminded", 0) > remind_limit
            many = g["steps"] % NAG_STEPS == 0
            if late or many:
                g["reminded"] = now
                lag = f"{int(behind // 60)}+ min" if behind >= 60 else f"{g['steps']} steps"
                out({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext":
                     f"Work View is {lag} behind what you have done. Bring it up to date now: {how(artifact)}."}})
        elif is_research(tool):
            # Bug 6: research counts at half weight, and never blocks a Stop.
            g["research"] = g.get("research", 0) + 1
            if g["research"] % (NAG_STEPS * 2) == 0 and now - g.get("reminded", 0) > remind_limit:
                g["reminded"] = now
                out({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext":
                     f"You have taken {g['research']} research steps since the view was last updated. "
                     f"If this is turning into real work, {how(artifact)}."}})
        save_state(path, session, g)
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
