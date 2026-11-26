#!/usr/bin/env python3
"""Install or update the Claude GUI in a project. Run it again to update.

    python3 install.py /path/to/project            # hook, skill and viewer inside the project's .claude/
    python3 install.py /path/to/project --global   # hook and skill in ~/.claude/ for every project
    python3 install.py /path/to/project --artifact # no hooks: drive a claude.ai artifact instead

What it does, all safe to repeat:
  - copies the hook script, tools/artifact_state.py and the viewer into <.claude>/claude-gui/
  - copies the skill to <.claude>/skills/claude-gui-state/SKILL.md
  - registers the event hook and the Work View guard in <.claude>/settings.json,
    leaving other settings and hooks alone
  - creates <project>/.claude-gui/ with a starter state.yaml and an empty events.jsonl,
    keeping any that already exist

The per-project install is the one to use in cloud sessions, where ~ does not last.
Then: python3 <.claude>/claude-gui/viewer/serve.py /path/to/project

--artifact also prints how to publish the viewer as a claude.ai artifact and push
live updates. The hooks are installed either way: they log events and guard
against the view falling behind; a hook just can't publish, so Claude pushes.
"""
import argparse
import json
import pathlib
import shutil

HERE = pathlib.Path(__file__).resolve().parent
# (script, {event: matcher or None}) for each hook installed.
HOOKS = [
    # Logs every action to events.jsonl, and warns Claude about bad state or missing coverage.
    ("claude_gui_hook.py", {"UserPromptSubmit": None, "PreToolUse": "Task|Agent|Bash", "PostToolUse": "*",
                            "PostToolUseFailure": "Bash", "SubagentStop": None, "Stop": None}),
    # Keeps the view from falling behind: reminds, and blocks ending a turn until it is current.
    ("workview_guard.py", {"UserPromptSubmit": None, "PostToolUse": "ArtifactData|Edit|Write|MultiEdit|NotebookEdit|Bash",
                           "Stop": None}),
]
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

# Anyone with the link reads the live document; only editors (Claude, as the owner) write it.
CAPABILITIES = {"db": {"rules": [{"path": "workview", "read": "view", "write": "admin"}]}}
ARTIFACT_STEPS = """
Publish once (and again only when the viewer code changes), with the Artifact tool:
  file_path: {page}
  files: {files}
  capabilities: {caps}

Then save the artifact's URL to .claude-gui/artifact-url (this turns the guard's artifact mode on).

Every update after that, don't publish (a new version reloads every open view):
  python3 {tool} set ...                  # todos, focus, thinking (the hook logs actions)
  python3 {tool} live                     # pack .claude-gui/live.json
  ArtifactData set, collection "workview", doc_id "live",
    file_path .claude-gui/live.json, if_version = the version the last write returned
The page picks the document up live, with no reload.
"""


def copy_tree(src, dst):
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("node_modules", "test", "package*.json", "*.template.html", "build.py"))


def add_hooks(settings_path, command_for):
    """Registers every hook in HOOKS, replacing earlier entries for the same script (an old path, say)."""
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        settings = {}
    hooks = settings.setdefault("hooks", {})
    for script, events in HOOKS:
        for event, matcher in events.items():
            groups = hooks.setdefault(event, [])
            for g in groups:
                g["hooks"] = [h for h in g.get("hooks", []) if script not in h.get("command", "")]
            groups[:] = [g for g in groups if g.get("hooks")]
            entry = {"hooks": [{"type": "command", "command": command_for(script), "timeout": 5}]}
            if matcher:
                entry = {"matcher": matcher, **entry}
            groups.append(entry)
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=pathlib.Path)
    ap.add_argument("--global", dest="glob", action="store_true", help="install the hook and skill in ~/.claude instead")
    ap.add_argument("--artifact", action="store_true", help="also print the claude.ai artifact publish steps")
    a = ap.parse_args()
    project = a.project.expanduser().resolve()
    base = pathlib.Path.home() / ".claude" if a.glob else project / ".claude"
    home = base / "claude-gui"

    home.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / "hooks" / "claude_gui_hook.py", home / "claude_gui_hook.py")
    for tool in ("artifact_state.py", "workview_guard.py"):
        shutil.copy2(HERE / "tools" / tool, home / tool)
    copy_tree(HERE / "viewer", home / "viewer")
    skill = base / "skills" / "claude-gui-state"
    skill.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / "skill" / "SKILL.md", skill / "SKILL.md")
    # Hooks go in for both modes: Claude Code runs project hooks in cloud sessions too, so the
    # event log fills itself and the guard keeps the view current. Only the push to the artifact is Claude's.
    add_hooks(base / "settings.json", lambda script: f"python3 ~/.claude/claude-gui/{script}" if a.glob
              else f'python3 "$CLAUDE_PROJECT_DIR/.claude/claude-gui/{script}"')

    state = project / ".claude-gui"
    state.mkdir(exist_ok=True)
    if not (state / "state.yaml").exists():
        (state / "state.yaml").write_text(STARTER.format(name=project.name), encoding="utf-8")
    (state / "events.jsonl").touch()

    print(f"Claude GUI installed in {base}")
    if not a.artifact:
        print(f"View it: python3 {home / 'viewer' / 'serve.py'} {project}")
        return
    viewer = home / "viewer"
    files = {f"src/{p.name}": str(p) for p in sorted((viewer / "src").glob("*.js"))}
    print(ARTIFACT_STEPS.format(page=viewer / "index.html", files=json.dumps(files, indent=2),
                                caps=json.dumps(CAPABILITIES), tool=home / "artifact_state.py"))


if __name__ == "__main__":
    main()
