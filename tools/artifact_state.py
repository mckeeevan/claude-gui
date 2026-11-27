#!/usr/bin/env python3
"""Keep .claude-gui/ current without hooks, and pack it for the claude.ai artifact.

Use it where no hook runs (a cloud session, a claude.ai artifact). Every command
works on the state folder (--dir, else $WORKVIEW_DIR, else .claude-gui):

  log TYPE [--agent A] [--target T] [--to B] [--node N] [--text X]
           [--ok | --failed-run] [--passed N] [--failed N]
      Appends one event to events.jsonl, stamped now.

  set PATCH            PATCH is YAML (or JSON) merged into state.yaml, e.g.
      set '{session: {focus: yt.overlay}, todos: [{id: t3, status: done}]}'
      Lists of items with ids merge by id at any depth (a todo's children
      too), so one patch can touch a nested item. A new id is appended to the
      list it is given in. `--remove ID` deletes items by id. The file is
      rewritten with yaml.safe_dump, so values are always quoted correctly,
      text already cut at commas is glued back, and `updated` is set to now.
      Run `set` with no patch to just clean the file.

  coverage REPORT [ROOT]
      Converts a coverage report (istanbul json-summary or final, lcov,
      coverage.py json, cobertura xml, go cover profile) into coverage.json
      with paths relative to ROOT (default: the current folder).

  live [--out FILE] [--max-events N]
      Writes live.json ({state, events, coverage, heartbeat} as text) for the artifact
      database: ArtifactData set, collection "workview", doc "live",
      file_path = that file. Keeps the last N events (default 200) so the
      document stays well under the 256 KiB limit.

Needs PyYAML for `set` (pip install pyyaml); the other commands do not.
"""
import argparse
import datetime
import json
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def hook_module():
    """The hook script holds the coverage parsers; it sits beside this file once installed, or in ../hooks in the repo."""
    for d in (HERE, HERE.parent / "hooks"):
        if (d / "claude_gui_hook.py").exists():
            sys.path.insert(0, str(d))
            import claude_gui_hook
            return claude_gui_hook
    sys.exit("claude_gui_hook.py not found next to this script or in ../hooks")


# ---- log ----------------------------------------------------------------------
def cmd_log(a, d):
    ev = {"t": now(), "agent": a.agent, "type": a.type}
    for k in ("target", "to", "node", "text"):
        if getattr(a, k):
            ev[k] = getattr(a, k)
    if a.type == "test":
        # Tri-state like the hook: a failed run is False, a counted pass is True,
        # and no flag at all is None (unknown) so the viewer shows it grey.
        if a.failed_run:
            ev["ok"] = False
        elif a.ok:
            ev["ok"] = True
        else:
            ev["ok"] = None
        ev["passed"] = a.passed or 0
        ev["failed"] = a.failed or 0
    # Lock the append so a concurrent hook write can't interleave a torn line.
    import fcntl
    with open(d / "events.jsonl", "a", encoding="utf-8") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)
    (d / "heartbeat").write_text(ev["t"], encoding="utf-8")
    print(json.dumps(ev, ensure_ascii=False))


# ---- set ----------------------------------------------------------------------
def find_by_id(items, id_):
    """Returns (list, index) of the item with this id anywhere under items (through children)."""
    for i, it in enumerate(items):
        if isinstance(it, dict) and str(it.get("id")) == id_:
            return items, i
        if isinstance(it, dict) and isinstance(it.get("children"), list):
            hit = find_by_id(it["children"], id_)
            if hit:
                return hit
    return None


def merge(base, patch):
    if isinstance(base, dict) and isinstance(patch, dict):
        out = dict(base)
        for k, v in patch.items():
            out[k] = merge(base.get(k), v) if k in base else v
        return out
    if isinstance(base, list) and isinstance(patch, list) and all(isinstance(p, dict) and "id" in p for p in patch):
        out = [dict(x) if isinstance(x, dict) else x for x in base]
        for p in patch:
            hit = find_by_id(out, str(p["id"]))
            if hit:
                lst, i = hit
                lst[i] = merge(lst[i], p)
            else:
                out.append(p)
        return out
    return patch


def remove_ids(node, ids):
    if isinstance(node, dict):
        return {k: remove_ids(v, ids) for k, v in node.items()}
    if isinstance(node, list):
        return [remove_ids(x, ids) for x in node if not (isinstance(x, dict) and str(x.get("id")) in ids)]
    return node


TEXT_KEYS = ("name", "text", "task", "about", "note", "thinking", "cause", "description", "goal")


def repair(node, known):
    """Glues text that YAML split at an unquoted comma back together: an unknown key with
    no value right after a text field is the rest of that text (see the viewer's repairCommaSplits)."""
    if isinstance(node, list):
        return [repair(x, known) for x in node]
    if not isinstance(node, dict):
        return node
    out, last = {}, None
    for k, v in node.items():
        if v is None and k not in known and last:
            out[last] = f"{out[last]}, {k}"
            continue
        out[k] = repair(v, known)
        last = k if k in TEXT_KEYS and isinstance(out[k], str) else None
    return out


def cmd_set(a, d):
    try:
        import yaml
    except ImportError:
        sys.exit("`set` needs PyYAML: pip install pyyaml")
    path = d / "state.yaml"
    # The whole read-merge-write runs under an exclusive lock, so two agents (or an
    # agent and the hook) can't clobber each other's state.
    import fcntl
    lock = open(d / ".state.lock", "a")
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        state = yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else {}
        state = state or {}
        if a.patch:
            patch = yaml.safe_load(a.patch)
            if not isinstance(patch, dict):
                sys.exit("the patch must be a mapping, e.g. '{session: {focus: x}}'")
            state = merge(state, patch)
        if a.remove:
            state = remove_ids(state, set(a.remove))
        state = repair(state, hook_module().KNOWN_KEYS)
        state["updated"] = now()
        # sort_keys=False keeps Claude's order; width keeps long thoughts on one line per value.
        text = yaml.safe_dump(state, sort_keys=False, allow_unicode=True, width=100, default_flow_style=False)
        tmp = path.with_suffix(".yaml.tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)  # the viewer never reads a half-written file
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
    print(f"updated {path}")


# ---- coverage -------------------------------------------------------------------
def cmd_coverage(a, d):
    hook = hook_module()
    root = pathlib.Path(a.root).resolve()
    files = {}
    for f, (covered, total) in hook.read_coverage(str(pathlib.Path(a.report).resolve())).items():
        if total:
            files[hook.rel(f, str(root)).replace("\\", "/")] = [int(covered), int(total)]
    if not files:
        sys.exit(f"no file coverage found in {a.report}")
    out = {"t": now(), "source": os.path.relpath(a.report, root).replace("\\", "/"), "files": files}
    (d / "coverage.json").write_text(json.dumps(out), encoding="utf-8")
    covered = sum(c for c, _ in files.values())
    total = sum(t for _, t in files.values())
    print(f"coverage {covered}/{total} lines ({covered / total:.0%}) in {len(files)} files")


# ---- live -----------------------------------------------------------------------
def cmd_live(a, d):
    read = lambda name: (d / name).read_text(encoding="utf-8") if (d / name).exists() else ""
    lines = [l for l in read("events.jsonl").splitlines() if l.strip()]
    doc = {"state": read("state.yaml"), "events": "\n".join(lines[-a.max_events:]) + ("\n" if lines else "")}
    beat = read("heartbeat").strip()
    if beat:
        doc["heartbeat"] = beat
    cov = read("coverage.json")
    if cov:
        doc["coverage"] = cov
    out = pathlib.Path(a.out) if a.out else d / "live.json"
    text = json.dumps(doc, ensure_ascii=False)
    out.write_text(text, encoding="utf-8")
    size = len(text.encode("utf-8"))
    print(f"wrote {out} ({size // 1024} KiB)")
    if size > 200 * 1024:
        print("warning: close to the 256 KiB document limit; lower --max-events", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default=os.environ.get("WORKVIEW_DIR") or ".claude-gui",
                    help="the state folder (default $WORKVIEW_DIR, else .claude-gui)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("log")
    p.add_argument("type")
    p.add_argument("--agent", default="main")
    for k in ("target", "to", "node", "text"):
        p.add_argument(f"--{k}")
    p.add_argument("--ok", action="store_true")
    p.add_argument("--failed-run", action="store_true", help="a test run that failed without a count (a crash)")
    p.add_argument("--passed", type=int)
    p.add_argument("--failed", type=int)
    p = sub.add_parser("set")
    p.add_argument("patch", nargs="?")
    p.add_argument("--remove", nargs="*", default=[])
    p = sub.add_parser("coverage")
    p.add_argument("report")
    p.add_argument("root", nargs="?", default=".")
    p = sub.add_parser("live")
    p.add_argument("--out")
    p.add_argument("--max-events", type=int, default=200)
    a = ap.parse_args()
    d = pathlib.Path(a.dir)
    d.mkdir(parents=True, exist_ok=True)
    {"log": cmd_log, "set": cmd_set, "coverage": cmd_coverage, "live": cmd_live}[a.cmd](a, d)


if __name__ == "__main__":
    main()
