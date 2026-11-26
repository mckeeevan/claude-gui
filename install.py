#!/usr/bin/env python3
"""Install or update the Claude GUI in a project. Run it again to update.

    python3 install.py /path/to/project            # hook, skill and viewer inside the project's .claude/
    python3 install.py /path/to/project --global   # hook and skill in ~/.claude/ for every project
    python3 install.py /path/to/project --artifact # no hooks: drive a claude.ai artifact instead
    python3 install.py /path/to/project --dir /mnt/project-files/work-view --files-project chan_...
        # claude.ai project: hooks log into the shared project folder, the page reads it directly

What it does, all safe to repeat:
  - copies the hook script, tools/artifact_state.py and the viewer into <.claude>/claude-gui/
  - copies the skill to <.claude>/skills/claude-gui-state/SKILL.md
  - registers the event hook and the Work View guard in <.claude>/settings.json,
    leaving other settings and hooks alone
  - installs the working base (unless --no-base): task-researcher and task-planner subagents
    in .claude/agents/, shared rules in .claude/rules/, the /new-project command in
    .claude/commands/, and a "How to work here" section in
    CLAUDE.md between markers. Files you have made your own (the marker line deleted) are
    left alone. "## Checks" (the project's test and build commands) and "## Project" (stack and
    layout notes) are added once; an empty checks list is filled in once commands exist
  - creates <project>/.claude-gui/ (or --dir) with a starter state.yaml and an empty events.jsonl,
    keeping any that already exist; --dir is saved as WORKVIEW_DIR in settings.json "env"

The per-project install is the one to use in cloud sessions, where ~ does not last.
Then: python3 <.claude>/claude-gui/viewer/serve.py /path/to/project

--artifact also prints how to publish the viewer as a claude.ai artifact and push
live updates. The hooks are installed either way: they log events and guard
against the view falling behind; a hook just can't publish, so Claude pushes.
"""
import argparse
import json
import pathlib
import re
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

FILES_NOTE = """
The hooks write to {dir}, and the page reads it through the files capability, so
the log, heartbeat and state.yaml reach it with no push. Publish as below, but
skip saving artifact-url and the ArtifactData steps: editing state.yaml is the
whole update.{sub}
"""


def copy_tree(src, dst):
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("node_modules", "test", "package*.json", "*.template.html", "build.py"))


BASE_MARK = "<!-- claude-gui base: install.py keeps this file up to date."
NO_CHECKS = "- (none found yet: list the commands that must pass)"
NO_PROJECT = ("(Not written yet. Run /new-project on a new project, or fill this in: what it is, the stack and "
              "versions, the folder layout, naming and code conventions, and how to run it.)")
BLOCK_START, BLOCK_END = "<!-- claude-gui:start -->", "<!-- claude-gui:end -->"


def install_managed(src, dst):
    """Copies a base file unless the project has made it its own (by deleting the marker line)."""
    if dst.exists() and BASE_MARK not in dst.read_text(encoding="utf-8"):
        return f"kept your {dst.name}"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return None


def merge_block(text, block):
    """Puts the managed block between its markers, replacing an older copy, and leaves the rest alone."""
    section = f"{BLOCK_START}\n{block.strip()}\n{BLOCK_END}"
    if BLOCK_START in text and BLOCK_END in text:
        head, rest = text.split(BLOCK_START, 1)
        return head + section + rest.split(BLOCK_END, 1)[1]
    return text.rstrip() + ("\n\n" if text.strip() else "") + section + "\n"


def detect_checks(project):
    """The commands that must pass before a phase counts as done, guessed from the project's files."""
    checks = []
    for pkg in [project / "package.json", *sorted(project.glob("*/package.json"))]:
        if "node_modules" in pkg.parts:
            continue
        try:
            scripts = json.loads(pkg.read_text(encoding="utf-8")).get("scripts", {})
        except (OSError, ValueError):
            continue
        where = "" if pkg.parent == project else f"cd {pkg.parent.name} && "
        runner = "pnpm" if (pkg.parent / "pnpm-lock.yaml").exists() else "yarn" if (pkg.parent / "yarn.lock").exists() else "npm"
        for name in ("lint", "typecheck", "build", "test"):
            if name in scripts:
                checks.append(f"{where}{runner} {'test' if name == 'test' else 'run ' + name}")
    py = [project / f for f in ("pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini")]
    uv = "uv run " if (project / "uv.lock").exists() else ""
    if any(f.exists() and ("pytest" in f.read_text(encoding="utf-8", errors="ignore") or f.name == "pytest.ini") for f in py):
        checks.append(f"{uv}pytest")
    else:
        for d in sorted({t.parent for t in project.glob("*/test_*.py")}):
            checks.append(f"python3 -m unittest discover {d.name}")
    if any(f.exists() and "mypy" in f.read_text(encoding="utf-8", errors="ignore") for f in py):
        checks.append(f"{uv}mypy .")
    if (project / "Cargo.toml").exists():
        checks += ["cargo clippy --all-targets -- -D warnings", "cargo test"]
    if (project / "go.mod").exists():
        checks += ["go vet ./...", "go test ./..."]
    return checks


def install_base(project):
    notes = []
    claude = project / ".claude"
    for kind in ("agents", "rules", "commands"):
        for src in sorted((HERE / "base" / kind).glob("*.md")):
            note = install_managed(src, claude / kind / src.name)
            if note:
                notes.append(note)
    md = project / "CLAUDE.md"
    text = md.read_text(encoding="utf-8") if md.exists() else f"# {project.name}\n"
    text = merge_block(text, (HERE / "base" / "CLAUDE.block.md").read_text(encoding="utf-8"))
    checks = detect_checks(project)
    lines = "\n".join(f"- `{c}`" for c in checks)
    has = lambda heading: re.search(rf"^{heading}\s*$", text, re.M)  # a real heading, not a mention in the block
    if not has("## Checks"):
        text += "\n## Checks\n\nA phase is done when all of these pass:\n\n" + (lines or NO_CHECKS) + "\n"
    elif NO_CHECKS in text and lines:
        text = text.replace(NO_CHECKS, lines)  # an empty project has grown its first commands
    if not has("## Project"):
        text += "\n## Project\n\n" + NO_PROJECT + "\n"
    md.write_text(text, encoding="utf-8")
    return notes


def set_env(settings_path, key, value):
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        settings = {}
    settings.setdefault("env", {})[key] = value
    settings_path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


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
    ap.add_argument("--dir", help="the state folder, e.g. a shared claude.ai project folder (saved as WORKVIEW_DIR)")
    ap.add_argument("--no-base", action="store_true", help="skip the subagents, rules and CLAUDE.md section")
    ap.add_argument("--files-project", help="claude.ai project id (chan_...): the page reads --dir through the files capability")
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

    if a.dir:
        set_env(base / "settings.json", "WORKVIEW_DIR", a.dir)
    state = project / (a.dir or ".claude-gui")  # an absolute --dir replaces the project path
    state.mkdir(parents=True, exist_ok=True)
    if not (state / "state.yaml").exists():
        (state / "state.yaml").write_text(STARTER.format(name=project.name), encoding="utf-8")
    (state / "events.jsonl").touch()

    print(f"Claude GUI installed in {base}")
    if not a.no_base:
        # The base is per project even with --global: its rules are referenced by project paths.
        for note in install_base(project):
            print(f"  {note} (delete-the-marker means it's yours; install.py won't update it)")
    if not a.artifact and not a.files_project:
        print(f"View it: python3 {home / 'viewer' / 'serve.py'} {project}")
        return
    viewer = home / "viewer"
    files = {f"src/{p.name}": str(p) for p in sorted((viewer / "src").glob("*.js"))}
    caps = dict(CAPABILITIES)
    if a.files_project:
        # The page reads the shared folder itself, by its path inside the project folder.
        caps["files"] = {"project": a.files_project}
        d = (a.dir or "work-view").rstrip("/")
        sub = d.split("/mnt/project-files/", 1)[1] if "/mnt/project-files/" in d else pathlib.PurePosixPath(d).name
        print(FILES_NOTE.format(dir=a.dir or "(set --dir)", sub="" if sub == "work-view" else
              f' The folder is not "work-view", so set window.CLAUDE_GUI = {{filesDir: "{sub}"}} in the page.'))
    print(ARTIFACT_STEPS.format(page=viewer / "index.html", files=json.dumps(files, indent=2),
                                caps=json.dumps(caps), tool=home / "artifact_state.py"))


if __name__ == "__main__":
    main()
