#!/usr/bin/env python3
"""Install or update the Claude GUI in a project. Run it again to update.

    python3 install.py /path/to/project            # hook, skill and viewer inside the project's .claude/
    python3 install.py /path/to/project --global   # hook and skill in ~/.claude/ for every project

What it does, all safe to repeat:
  - copies the hook script and the viewer into <.claude>/claude-gui/
  - copies the skill to <.claude>/skills/claude-gui-state/SKILL.md
  - adds the hook to <.claude>/settings.json, leaving other settings and hooks alone
  - creates <project>/.claude-gui/ with a starter state.yaml and an empty events.jsonl,
    keeping any that already exist

The per-project install is the one to use in cloud sessions, where ~ does not last.
Then: python3 <.claude>/claude-gui/viewer/serve.py /path/to/project
"""
import argparse
import json
import pathlib
import shutil

HERE = pathlib.Path(__file__).resolve().parent
EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop", "Stop"]
MATCHERS = {"PreToolUse": "Task|Agent|Bash", "PostToolUse": "*", "PostToolUseFailure": "Bash"}
STARTER = """version: 1
project: {name}
updated: null
session:
  goal: null
  phase: planning
  focus: null
  thinking: null
structure: []
agents:
  - id: main
    name: Claude
    role: Lead
todos: []
"""


def copy_tree(src, dst):
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("node_modules", "test", "package*.json", "*.template.html", "build.py"))


def add_hooks(settings_path, command):
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        settings = {}
    hooks = settings.setdefault("hooks", {})
    for event in EVENTS:
        groups = hooks.setdefault(event, [])
        # Drop any earlier Claude GUI entry (an old path, say), then add the current one.
        for g in groups:
            g["hooks"] = [h for h in g.get("hooks", []) if "claude_gui_hook.py" not in h.get("command", "")]
        groups[:] = [g for g in groups if g.get("hooks")]
        entry = {"hooks": [{"type": "command", "command": command, "timeout": 5}]}
        if event in MATCHERS:
            entry = {"matcher": MATCHERS[event], **entry}
        groups.append(entry)
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=pathlib.Path)
    ap.add_argument("--global", dest="glob", action="store_true", help="install the hook and skill in ~/.claude instead")
    a = ap.parse_args()
    project = a.project.expanduser().resolve()
    base = pathlib.Path.home() / ".claude" if a.glob else project / ".claude"
    home = base / "claude-gui"

    home.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / "hooks" / "claude_gui_hook.py", home / "claude_gui_hook.py")
    copy_tree(HERE / "viewer", home / "viewer")
    skill = base / "skills" / "claude-gui-state"
    skill.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / "skill" / "SKILL.md", skill / "SKILL.md")
    command = ('python3 ~/.claude/claude-gui/claude_gui_hook.py' if a.glob
               else 'python3 "$CLAUDE_PROJECT_DIR/.claude/claude-gui/claude_gui_hook.py"')
    add_hooks(base / "settings.json", command)

    state = project / ".claude-gui"
    state.mkdir(exist_ok=True)
    if not (state / "state.yaml").exists():
        (state / "state.yaml").write_text(STARTER.format(name=project.name), encoding="utf-8")
    (state / "events.jsonl").touch()

    print(f"Claude GUI installed in {base}")
    print(f"View it: python3 {home / 'viewer' / 'serve.py'} {project}")


if __name__ == "__main__":
    main()
