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


if __name__ == "__main__":
    unittest.main()
