#!/usr/bin/env python3
"""Claude GUI hook: turns Claude Code hook events into lines in .claude-gui/events.jsonl.

It only does anything in projects that have a .claude-gui/ folder (or that set
WORKVIEW_DIR, see state_dir), so it is safe to install globally. It never blocks
Claude: every error is swallowed and it always exits 0.

Besides the event line, every call touches `heartbeat` (the time of the last
action, so a viewer can show "live"), and once events.jsonl passes 200 KB the
older lines move to history/ and the last 400 stay.

Each line it writes is one JSON object:
  {"t": ISO time, "agent": who, "type": what, "target": file or command,
   "to": other agent, "text": short description, "session": session id}
Test runs (any command that looks like a test runner) also carry
  "ok": bool, "passed": n, "failed": n, "failures": [names of failing tests]
"""
import datetime
import json
import os
import re
import shutil
import sys

STATE_DIR = ".claude-gui"
MAX_TEXT = 160
TRIM_AT = 200_000   # bytes of events.jsonl before older lines move to history/
KEEP = 400          # lines kept in events.jsonl after a trim

READ_TOOLS = {"Read", "NotebookRead"}
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SEARCH_TOOLS = {"Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch"}
AGENT_TOOLS = {"Task", "Agent"}


def state_dir(root):
    """The folder the view reads. WORKVIEW_DIR overrides it (absolute, or relative to the project),
    e.g. a claude.ai project folder like /mnt/project-files/work-view that the page reads directly."""
    d = os.environ.get("WORKVIEW_DIR")
    return os.path.join(root, d) if d else os.path.join(root, STATE_DIR)


def short(s, n=MAX_TEXT):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def rel(path, root):
    if not path:
        return None
    try:
        p = os.path.relpath(os.path.abspath(path), root)
        return path if p.startswith("..") else p
    except ValueError:
        return path


# Commands that run tests. Matching is loose on purpose: a false positive only adds a test run to the page.
TEST_CMD = re.compile(
    r"(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(pytest|jest|vitest|mocha|rspec|phpunit|ctest|tox|nox)\b"
    r"|\b(cargo|go|dotnet|mix|swift|deno)\s+test\b|\bnode\s+--test\b|\bpython3?\s+-m\s+(pytest|unittest)\b|\bmake\s+(test|check)\b"
)

# Summary lines from common runners: (regex, which group is passed, which is failed).
SUMMARIES = [
    (re.compile(r"^# pass (\d+)\s*$.*?^# fail (\d+)", re.M | re.S), 1, 2),                     # node:test / TAP
    (re.compile(r"Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(\d+) passed"), 2, 1),           # jest
    (re.compile(r"Tests\s+(?:(\d+) failed \| )?(\d+) passed"), 2, 1),                             # vitest
    (re.compile(r"test result: \w+\. (\d+) passed; (\d+) failed"), 1, 2),                        # cargo
    (re.compile(r"(\d+) examples?, (\d+) failures?"), 1, 2),                                       # rspec (total, failed)
]
PYTEST = re.compile(r"=+ (.*?(?:passed|failed|error).*?) in [\d.]+s")
FAIL_NAMES = [
    re.compile(r"^not ok \d+ - (.+)$", re.M),       # TAP
    re.compile(r"^FAILED (\S+)", re.M),             # pytest -rf summary
    re.compile(r"^\s*● (.+?)$", re.M),              # jest
    re.compile(r"^--- FAIL: (\S+)", re.M),          # go
    re.compile(r"^test (\S+) \.\.\. FAILED$", re.M),  # cargo
]


def is_test_command(cmd):
    return bool(TEST_CMD.search(cmd or ""))


def parse_test_output(text):
    """Pulls passed/failed counts and up to 8 failing test names out of runner output."""
    text = text or ""
    passed = failed = None
    for rx, gp, gf in SUMMARIES:
        m = rx.search(text)
        if m:
            passed, failed = int(m.group(gp) or 0), int(m.group(gf) or 0)
            if rx.pattern.startswith("(\\d+) examples"):
                passed -= failed  # rspec reports a total
            break
    if passed is None:
        m = PYTEST.search(text)
        if m:
            counts = dict((k, int(v)) for v, k in re.findall(r"(\d+) (passed|failed|errors?)", m.group(1)))
            passed = counts.get("passed", 0)
            failed = counts.get("failed", 0) + counts.get("error", 0) + counts.get("errors", 0)
    names = []
    for rx in FAIL_NAMES:
        for n in rx.findall(text):
            n = short(n, 120)
            # node:test prints suite lines as "not ok" too when a child fails; keep the leaf names unique.
            if n not in names:
                names.append(n)
    return passed, failed, names[:8]


# Coverage reports the hook understands, relative to the project root. After a test run the newest
# one written in the last 15 minutes is read, reduced to covered/total lines per file, and saved as
# .claude-gui/coverage.json, which the viewer maps onto parts through their `paths` globs.
COVERAGE_FILES = [
    "coverage/coverage-summary.json", "coverage/coverage-final.json", "coverage/lcov.info", "lcov.info",
    "coverage.json", "coverage.xml", "coverage/cobertura-coverage.xml", "cover.out", "coverage.out",
]


def _istanbul_summary(path):
    data = json.load(open(path, encoding="utf-8"))
    return {f: (v["lines"]["covered"], v["lines"]["total"]) for f, v in data.items() if f != "total" and isinstance(v, dict) and "lines" in v}


def _istanbul_final(path):
    data = json.load(open(path, encoding="utf-8"))
    out = {}
    for f, v in data.items():
        counts = list((v.get("s") or {}).values())
        out[v.get("path", f)] = (sum(1 for c in counts if c), len(counts))
    return out


def _lcov(path):
    out, cur, lf, lh = {}, None, 0, 0
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if line.startswith("SF:"):
            cur, lf, lh = line[3:], 0, 0
        elif line.startswith("LF:"):
            lf = int(line[3:] or 0)
        elif line.startswith("LH:"):
            lh = int(line[3:] or 0)
        elif line == "end_of_record" and cur:
            out[cur] = (lh, lf)
            cur = None
    return out


def _coverage_py(path):
    data = json.load(open(path, encoding="utf-8"))
    files = data.get("files") if isinstance(data, dict) else None
    if not isinstance(files, dict):
        raise ValueError("not a coverage.py report")
    return {f: (v["summary"]["covered_lines"], v["summary"]["num_statements"]) for f, v in files.items()}


def _cobertura(path):
    import xml.etree.ElementTree as ET
    root = ET.parse(path).getroot()
    base = (root.findtext("sources/source") or "").strip()
    out = {}
    for cls in root.iter("class"):
        f = cls.get("filename")
        lines = [int(l.get("hits", "0")) for l in cls.iter("line")]
        c, t = out.get(f, (0, 0))
        out[os.path.join(base, f) if base and not os.path.isabs(f) else f] = (c + sum(1 for h in lines if h), t + len(lines))
    return out


def _go(path):
    out = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        m = re.match(r"^(.+?):\d+\.\d+,\d+\.\d+ (\d+) (\d+)$", line.strip())
        if m:
            c, t = out.get(m.group(1), (0, 0))
            n = int(m.group(2))
            out[m.group(1)] = (c + (n if int(m.group(3)) else 0), t + n)
    return out


def read_coverage(path):
    name = os.path.basename(path)
    if name == "coverage-summary.json":
        return _istanbul_summary(path)
    if name == "coverage-final.json":
        return _istanbul_final(path)
    if name.endswith(".info"):
        return _lcov(path)
    if name == "coverage.json":
        return _coverage_py(path)
    if name.endswith(".xml"):
        return _cobertura(path)
    return _go(path)


def collect_coverage(root, max_age=900):
    """Writes .claude-gui/coverage.json from the freshest coverage report, if there is one."""
    now = datetime.datetime.now().timestamp()
    found = [os.path.join(root, f) for f in COVERAGE_FILES if os.path.isfile(os.path.join(root, f))]
    found = [f for f in found if now - os.path.getmtime(f) < max_age]
    if not found:
        return None
    src = max(found, key=os.path.getmtime)
    files = {}
    for f, (covered, total) in read_coverage(src).items():
        if total:
            files[rel(f, root).replace("\\", "/")] = [int(covered), int(total)]
    if not files:
        return None
    out = {"t": datetime.datetime.now().astimezone().isoformat(timespec="seconds"), "source": rel(src, root), "files": files}
    with open(os.path.join(state_dir(root), "coverage.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    return out



# ---- feedback to Claude -----------------------------------------------------
# The hook can't fix Claude's files for it, but it can tell Claude right away,
# through the hook's additionalContext, so problems get fixed without the person.

def _flow_maps(line):
    """Yields the inside of each top-level { ... } on a line, skipping quoted text."""
    depth, start, quote = 0, None, None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
        elif ch == "#" and depth == 0 and (i == 0 or line[i - 1] == " "):
            return
        elif ch == "{":
            depth += 1
            if depth == 1:
                start = i + 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0:
                yield line[start:i]


def _split_top(text):
    """Splits on commas that are not inside quotes, brackets or braces."""
    parts, depth, quote, cur = [], 0, None, ""
    for ch in text:
        if quote:
            quote = None if ch == quote else quote
        elif ch in "'\"":
            quote = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
            continue
        cur += ch
    parts.append(cur)
    return parts


KNOWN_KEYS = {"version", "project", "updated", "session", "goal", "phase", "focus", "thinking", "structure", "id", "name",
              "status", "paths", "note", "children", "uses", "to", "kind", "weight", "from", "split_from", "coverage", "agents",
              "role", "about", "task", "nodes", "skills", "description", "tests", "suites", "passed", "failed", "failures", "test",
              "cause", "error", "todos", "text", "owner", "node", "viewer"}


def check_state(text):
    """Returns problems in state.yaml that would silently garble the page.

    The common one: an unquoted comma inside a { flow: map }, which YAML reads as
    the start of a new key, so `{ name: Words (a, b) }` loses everything after "a".
    """
    problems = []
    for n, line in enumerate(text.splitlines(), 1):
        # Already split and re-saved: the fragment sits on its own line as `rest of text): null`.
        m = re.match(r"^\s*(?:- )?([^\s#'\"][^:]*):\s*(null|~)?\s*$", line)
        if m and m.group(1).strip() not in KNOWN_KEYS and (m.group(2) or not line.rstrip().endswith(":")):
            problems.append(f"line {n}: \"{m.group(1).strip()[:40]}\" looks like the end of a value cut off at a comma")
        for inner in _flow_maps(line):
            for piece in _split_top(inner):
                if piece.strip() and not re.search(r":(\s|$)", piece):
                    problems.append(f"line {n}: a comma splits a value in {{ ... }} near \"{piece.strip()[:40]}\"")
    try:
        import yaml  # optional; only used when installed
        yaml.safe_load(text)
    except ImportError:
        pass
    except Exception as err:
        problems.append("does not parse: " + str(err).splitlines()[0])
    return problems


COVERAGE_HOW = [
    (re.compile(r"\bvitest\b"), "vitest",
     "npm i -D @vitest/coverage-v8, then in vitest.config set test.coverage = { enabled: true, provider: 'v8', reporter: ['text', 'json-summary'] } so every run writes coverage/coverage-summary.json"),
    (re.compile(r"\bjest\b"), "jest",
     "in the jest config set collectCoverage: true and coverageReporters: ['text', 'json-summary'] so every run writes coverage/coverage-summary.json"),
    (re.compile(r"\bpytest\b|python -m pytest"), "pytest",
     "pip install pytest-cov, then add `addopts = --cov --cov-report=json --cov-report=term` under [tool.pytest.ini_options] (or pytest.ini) so every run writes coverage.json"),
    (re.compile(r"\bgo test\b"), "go test", "run go test with -coverprofile=cover.out"),
    (re.compile(r"\bcargo (test|nextest)\b"), "cargo", "use cargo llvm-cov --lcov --output-path lcov.info"),
    (re.compile(r"node --test|node:test"), "node --test",
     "add --experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=lcov.info to the test script"),
]


def detect_runner(cmd, root):
    """Names the test runner from the command, or from package.json when it's `npm test`."""
    text = cmd or ""
    try:
        with open(os.path.join(root, "package.json"), encoding="utf-8") as fh:
            pkg = json.load(fh)
        text += " " + json.dumps(pkg.get("scripts", {})) + " " + " ".join({**pkg.get("devDependencies", {}), **pkg.get("dependencies", {})})
    except Exception:
        pass
    for pattern, name, how in COVERAGE_HOW:
        if pattern.search(text):
            return name, how
    return None, "turn on the test runner's coverage output (json-summary, lcov, coverage.py json, cobertura xml or a go cover profile)"


def coverage_hint(data, root, cmd):
    """Tells Claude once per session how to turn coverage on, when a run wrote no report."""
    marker = os.path.join(state_dir(root), ".coverage-hint")
    session = data.get("session_id") or "-"
    try:
        with open(marker, encoding="utf-8") as fh:
            if fh.read().strip() == session:
                return None
    except OSError:
        pass
    with open(marker, "w", encoding="utf-8") as fh:
        fh.write(session)
    name, how = detect_runner(cmd, root)
    return ("Claude GUI: that test run wrote no coverage report, so the viewer can't shade parts by coverage. "
            f"Turn it on in the project's test config ({name or 'unknown runner'}): {how}. "
            "Do it now without asking, run the tests once more, and make sure state.yaml parts have accurate paths.")


def say(event_name, text):
    """Hands text back to Claude as additional context for its next step."""
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event_name, "additionalContext": text}}))

def output_of(data):
    r = data.get("tool_response")
    if isinstance(r, dict):
        return "\n".join(str(r.get(k) or "") for k in ("stdout", "stderr", "output", "error"))
    return str(r or data.get("error") or "")


def who(data):
    # Hooks fired inside a subagent carry agent_type / agent_id (newer Claude Code versions).
    return data.get("agent_type") or data.get("agent_id") or "main"


def to_event(data, root):
    name = data.get("hook_event_name")
    tool = data.get("tool_name") or ""
    ti = data.get("tool_input") or {}
    agent = who(data)

    if name == "UserPromptSubmit":
        return {"agent": "user", "type": "prompt", "to": "main", "text": short(data.get("prompt"))}

    if name == "PreToolUse" and tool in AGENT_TOOLS:
        target_agent = ti.get("subagent_type") or ti.get("name") or "general-purpose"
        return {"agent": agent, "type": "spawn", "to": target_agent, "text": short(ti.get("description") or ti.get("prompt"))}

    if name == "SubagentStop":
        return {"agent": agent, "type": "done", "to": "main", "text": "Finished"}

    if name == "Stop":
        return {"agent": "main", "type": "stop", "text": "Finished its turn"}

    if tool == "Bash" and is_test_command(ti.get("command")):
        cmd = short(ti.get("command"), 80)
        if name == "PreToolUse":
            return {"agent": agent, "type": "test_start", "target": cmd}
        if name in ("PostToolUse", "PostToolUseFailure"):
            passed, failed, names = parse_test_output(output_of(data))
            # A failed exit with no failing count is still a failed run (a crash, a compile error).
            ok = name == "PostToolUse" and not failed
            ev = {"agent": agent, "type": "test", "target": cmd, "ok": ok, "passed": passed, "failed": failed, "failures": names}
            try:
                cov = collect_coverage(root)
                if cov:
                    covered = sum(c for c, _ in cov["files"].values())
                    total = sum(t for _, t in cov["files"].values())
                    ev["coverage"] = round(covered / total, 4) if total else None
                else:
                    hint = coverage_hint(data, root, ti.get("command"))
                    if hint:
                        say(name, hint)
            except Exception:
                pass  # a broken or unknown report never stops the run from being logged
            if not ok and not failed and not names:
                ev["text"] = short(output_of(data).strip().splitlines()[-1] if output_of(data).strip() else "Test command failed", 120)
            return ev

    if name != "PostToolUse":
        return None

    if tool in EDIT_TOOLS or tool in READ_TOOLS:
        path = ti.get("file_path") or ti.get("notebook_path") or ti.get("path")
        target = rel(path, root)
        if path and in_state_dir(path, root):
            if tool in READ_TOOLS:
                return None  # reading its own state file is noise
            snapshot(root)
            if path.replace("\\", "/").endswith("state.yaml"):
                try:
                    with open(os.path.join(state_dir(root), "state.yaml"), encoding="utf-8") as fh:
                        problems = check_state(fh.read())
                    if problems:
                        say(name, "Claude GUI: .claude-gui/state.yaml needs a fix or the viewer shows it wrong: "
                            + "; ".join(problems[:5])
                            + ". Quote any value that has a comma or colon (name: \"Words (a, b)\"), or write that entry in block style, then save it again.")
                except Exception:
                    pass
            return {"agent": agent, "type": "state", "target": target}
        return {"agent": agent, "type": "edit" if tool in EDIT_TOOLS else "read", "target": target}

    if tool == "Bash":
        cmd = ti.get("command", "")
        if "events.jsonl" in cmd or "artifact_state.py" in cmd:
            return None  # Claude logging its own events by shell
        return {"agent": agent, "type": "run", "target": short(cmd, 80), "text": short(ti.get("description"), 80) or None}

    if tool in SEARCH_TOOLS:
        q = ti.get("pattern") or ti.get("query") or ti.get("url") or ""
        return {"agent": agent, "type": "search", "target": short(q, 80)}

    if tool.startswith("mcp__"):
        op = tool.split("__", 2)[-1]
        if op in ("post_message", "send_message", "message_coordinator", "message_thread"):
            return {"agent": agent, "type": "message", "to": "user" if op == "post_message" else "peer",
                    "text": short(ti.get("text") or ti.get("message"))}
        if op == "create_pull_request":
            return {"agent": agent, "type": "pr", "target": ti.get("head"), "text": short(ti.get("title"))}
        return {"agent": agent, "type": "run", "target": op}

    return None


def in_state_dir(path, root):
    try:
        return os.path.commonpath([os.path.abspath(os.path.join(root, path)), os.path.abspath(state_dir(root))]) \
            == os.path.abspath(state_dir(root))
    except ValueError:
        return False  # different drives on Windows


def trim(d):
    """Keeps events.jsonl small for the page to read: past TRIM_AT bytes, older lines go to history/."""
    path = os.path.join(d, "events.jsonl")
    if os.path.getsize(path) < TRIM_AT:
        return
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines(keepends=True)
    hist = os.path.join(d, "history")
    os.makedirs(hist, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    with open(os.path.join(hist, f"events-{stamp}.jsonl"), "a", encoding="utf-8") as fh:
        fh.writelines(lines[:-KEEP])
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.writelines(lines[-KEEP:])
    os.replace(tmp, path)  # a reader never sees a half-written file


def snapshot(root):
    """Keep a timestamped copy of state.yaml each time Claude edits it, for replay later."""
    src = os.path.join(state_dir(root), "state.yaml")
    if not os.path.exists(src):
        return
    hist = os.path.join(state_dir(root), "history")
    os.makedirs(hist, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    shutil.copy2(src, os.path.join(hist, f"state-{stamp}.yaml"))


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    root = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    d = state_dir(root)
    if os.environ.get("WORKVIEW_DIR"):
        os.makedirs(d, exist_ok=True)  # setting the variable is the opt-in
    if not os.path.isdir(d):
        return  # project has not opted in
    ev = to_event(data, root)
    if not ev:
        return
    # Drop empty fields, but keep ok=False and counts of 0, which carry meaning for test runs.
    ev = {"t": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
          **{k: v for k, v in ev.items() if v or v is False or v == 0 and k in ("passed", "failed")}}
    if data.get("session_id"):
        ev["session"] = data["session_id"]
    ev["auto"] = True  # logged by the hook, not by Claude; a hand-written line for the same step wins
    with open(os.path.join(d, "events.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    with open(os.path.join(d, "heartbeat"), "w", encoding="utf-8") as f:
        f.write(ev["t"])
    trim(d)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
