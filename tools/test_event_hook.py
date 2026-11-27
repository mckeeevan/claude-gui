"""Tests for the event hook's log plumbing: python3 -m unittest discover tools"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HOOK = pathlib.Path(__file__).resolve().parent.parent / "hooks" / "claude_gui_hook.py"


class EventHook(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.d = self.root / ".claude-gui"
        self.d.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, payload, **env):
        r = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), capture_output=True, text=True,
                           env={**os.environ, "CLAUDE_PROJECT_DIR": str(self.root), **env})
        self.assertEqual(r.returncode, 0)
        return r.stdout

    def events(self, d=None):
        text = ((d or self.d) / "events.jsonl").read_text()
        return [json.loads(l) for l in text.splitlines() if l.strip()]

    def post(self, tool, ti, **env):
        return self.run_hook({"hook_event_name": "PostToolUse", "tool_name": tool, "tool_input": ti}, **env)

    def post_test(self, cmd, stdout, success=True, **env):
        """Post a Bash test command with its runner output, like a real PostToolUse."""
        payload = {"hook_event_name": "PostToolUse", "tool_name": "Bash",
                   "tool_input": {"command": cmd},
                   "tool_response": {"stdout": stdout, "stderr": ""}}
        if not success:
            payload["tool_response"] = {"stdout": stdout, "stderr": "", "error": "exit 1"}
        return self.run_hook(payload, **env)

    def test_every_logged_action_touches_the_heartbeat(self):
        self.post("Edit", {"file_path": str(self.root / "src/a.ts")})
        ev = self.events()[-1]
        self.assertEqual(ev["type"], "edit")
        self.assertEqual((self.d / "heartbeat").read_text(), ev["t"])

    def test_messages_and_pull_requests_get_their_own_types(self):
        self.post("mcp__hearthbot__post_message", {"text": "PR is up"})
        self.post("mcp__github__create_pull_request", {"head": "autolog", "title": "Auto log"})
        msg, pr = self.events()[-2:]
        self.assertEqual((msg["type"], msg["to"], msg["text"]), ("message", "user", "PR is up"))
        self.assertEqual((pr["type"], pr["target"], pr["text"]), ("pr", "autolog", "Auto log"))

    def test_trims_a_large_log_and_keeps_the_older_lines_in_history(self):
        line = json.dumps({"t": "x", "type": "run", "text": "y" * 600}) + "\n"
        (self.d / "events.jsonl").write_text(line * 400)  # about 250 KB
        self.post("Edit", {"file_path": str(self.root / "a.ts")})
        self.assertEqual(len(self.events()), 400)
        self.assertEqual(self.events()[-1]["type"], "edit", "the newest line survives")
        archived = list((self.d / "history").glob("events-*.jsonl"))
        self.assertEqual(len(archived), 1)
        self.assertEqual(len(archived[0].read_text().splitlines()), 1)

    def test_workview_dir_moves_the_log_and_is_the_opt_in(self):
        self.d.rmdir()
        shared = self.root / "project-files" / "work-view"
        self.post("Bash", {"command": "ls", "description": "List files"}, WORKVIEW_DIR=str(shared))
        self.assertEqual(self.events(shared)[-1]["text"], "List files")
        self.assertTrue((shared / "heartbeat").exists())

    def test_an_edit_of_the_state_file_in_workview_dir_is_a_state_event(self):
        shared = self.root / "wv"
        shared.mkdir()
        (shared / "state.yaml").write_text("version: 1\n")
        self.post("Write", {"file_path": str(shared / "state.yaml")}, WORKVIEW_DIR=str(shared))
        self.assertEqual(self.events(shared)[-1]["type"], "state")

    def test_does_nothing_without_a_folder_or_workview_dir(self):
        self.d.rmdir()
        self.post("Edit", {"file_path": str(self.root / "a.ts")})
        self.assertFalse(self.d.exists())

    # --- Golden tests per runner (bug 1: tri-state ok, real counts) ---

    def test_pytest_pass_is_green_with_counts(self):
        self.post_test("python3 -m pytest -q", "18 passed in 0.11s")
        ev = self.events()[-1]
        self.assertEqual((ev["type"], ev["ok"], ev["passed"], ev["failed"]), ("test", True, 18, 0))

    def test_pytest_fail_is_red_with_counts_and_names(self):
        self.post_test("python3 -m pytest -q",
                       "1 failed, 17 passed in 0.2s\nFAILED test_foo.py::test_bar")
        ev = self.events()[-1]
        self.assertEqual((ev["type"], ev["ok"], ev["passed"], ev["failed"]), ("test", False, 17, 1))
        self.assertIn("test_foo.py::test_bar", ev["failures"])

    def test_pytest_piped_through_tail_still_parses(self):
        # `| tail -5` strips the === separator lines; the bare summary must still parse.
        self.post_test("python3 -m pytest tools/ -q 2>&1 | tail -5",
                       ".................. [100%]\n18 passed in 0.11s")
        ev = self.events()[-1]
        self.assertEqual((ev["ok"], ev["passed"], ev["failed"]), (True, 18, 0))

    def test_jest_pass(self):
        self.post_test("npm test", "Tests: 12 passed, 12 total")
        ev = self.events()[-1]
        self.assertEqual((ev["ok"], ev["passed"], ev["failed"]), (True, 12, 0))

    def test_jest_fail(self):
        self.post_test("npm test", "Tests: 2 failed, 10 passed, 12 total")
        ev = self.events()[-1]
        self.assertEqual((ev["ok"], ev["passed"], ev["failed"]), (False, 10, 2))

    def test_node_test_tap(self):
        self.post_test("node --test", "# pass 5\n# fail 1\nnot ok 3 - my test")
        ev = self.events()[-1]
        self.assertEqual((ev["ok"], ev["passed"], ev["failed"]), (False, 5, 1))
        self.assertIn("my test", ev["failures"])

    def test_cargo(self):
        self.post_test("cargo test", "test result: ok. 9 passed; 0 failed")
        ev = self.events()[-1]
        self.assertEqual((ev["ok"], ev["passed"], ev["failed"]), (True, 9, 0))

    def test_go(self):
        self.post_test("go test ./...", "ok  \texample\t0.01s")
        ev = self.events()[-1]
        # go's "ok" line has no counts; a successful exit with no parseable count is unknown.
        self.assertIsNone(ev["ok"])
        self.assertEqual(ev.get("runner"), "unsupported")

    def test_unsupported_runner_is_unknown_not_green(self):
        # Bug 1: an unparseable runner used to render green (not None is True).
        self.post_test("phpunit", "some output with no recognizable counts")
        ev = self.events()[-1]
        self.assertIsNone(ev["ok"])
        self.assertEqual(ev.get("runner"), "unsupported")

    def test_crashed_test_command_is_red(self):
        self.post_test("npm test", "", success=False)
        ev = self.events()[-1]
        self.assertFalse(ev["ok"])

    # --- Bug 7: secrets redacted at write time ---

    def test_bearer_token_is_redacted(self):
        self.post("Bash", {"command": 'curl -H "Authorization: Bearer abcdef1234567890" https://api.example.com'})
        ev = self.events()[-1]
        self.assertNotIn("abcdef1234567890", json.dumps(ev))
        self.assertIn("redacted", json.dumps(ev))

    def test_api_key_assignment_is_redacted(self):
        self.post("Bash", {"command": "export API_KEY=sk_live_9f8e7d6c5b4a"})
        ev = self.events()[-1]
        self.assertNotIn("sk_live_9f8e7d6c5b4a", json.dumps(ev))

    def test_url_credentials_are_redacted(self):
        self.post("Bash", {"command": "curl https://user:secretpw@host.example.com/x"})
        ev = self.events()[-1]
        self.assertNotIn("secretpw", json.dumps(ev))


if __name__ == "__main__":
    unittest.main()
