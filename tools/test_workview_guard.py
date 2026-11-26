"""Tests for the Work View guard hook: python3 -m unittest discover tools"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest

GUARD = pathlib.Path(__file__).with_name("workview_guard.py")


class Guard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        (self.root / ".claude-gui").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, payload):
        r = subprocess.run([sys.executable, str(GUARD)], input=json.dumps(payload), capture_output=True, text=True,
                           env={**os.environ, "CLAUDE_PROJECT_DIR": str(self.root)})
        self.assertEqual(r.returncode, 0)
        return json.loads(r.stdout) if r.stdout.strip() else None

    def edit(self, path):
        return self.run_hook({"hook_event_name": "PostToolUse", "tool_name": "Edit", "tool_input": {"file_path": str(self.root / path)}})

    def test_blocks_a_stop_after_unpushed_work_once(self):
        (self.root / ".claude-gui" / "artifact-url").write_text("x")
        self.edit("src/a.ts")
        self.assertEqual(self.run_hook({"hook_event_name": "Stop"})["decision"], "block")
        self.assertIsNone(self.run_hook({"hook_event_name": "Stop", "stop_hook_active": True}), "never loops")

    def test_a_push_to_workview_live_clears_it(self):
        (self.root / ".claude-gui" / "artifact-url").write_text("x")
        self.edit("src/a.ts")
        self.run_hook({"hook_event_name": "PostToolUse", "tool_name": "ArtifactData",
                       "tool_input": {"action": "set", "collection": "workview", "doc_id": "live"}})
        self.assertIsNone(self.run_hook({"hook_event_name": "Stop"}))

    def test_a_read_of_the_document_is_not_a_push(self):
        (self.root / ".claude-gui" / "artifact-url").write_text("x")
        self.edit("src/a.ts")
        self.run_hook({"hook_event_name": "PostToolUse", "tool_name": "ArtifactData",
                       "tool_input": {"action": "get", "collection": "workview", "doc_id": "live"}})
        self.assertEqual(self.run_hook({"hook_event_name": "Stop"})["decision"], "block")

    def test_hooks_mode_counts_a_state_yaml_edit_as_the_push(self):
        self.edit("src/a.ts")
        self.edit(".claude-gui/state.yaml")
        self.assertIsNone(self.run_hook({"hook_event_name": "Stop"}))

    def test_only_significant_commands_are_work(self):
        self.run_hook({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "ls -la"}})
        self.assertIsNone(self.run_hook({"hook_event_name": "Stop"}))
        self.run_hook({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "git commit -m x"}})
        self.assertEqual(self.run_hook({"hook_event_name": "Stop"})["decision"], "block")

    def test_reminds_when_the_view_is_two_minutes_behind(self):
        self.edit("src/a.ts")
        g = self.root / ".claude-gui" / ".guard.json"
        data = json.loads(g.read_text())
        data["pending_since"] = time.time() - 200
        g.write_text(json.dumps(data))
        out = self.edit("src/b.ts")
        self.assertIn("behind", out["hookSpecificOutput"]["additionalContext"])
        self.assertIsNone(self.edit("src/c.ts"), "at most once a minute")

    def test_reminds_after_six_unseen_steps_without_blocking(self):
        outs = [self.edit(f"src/{i}.ts") for i in range(6)]
        self.assertEqual(outs[:5], [None] * 5)
        self.assertIn("6 steps behind", outs[5]["hookSpecificOutput"]["additionalContext"])
        self.assertNotIn("decision", outs[5], "a tool call is never blocked")
        self.edit(".claude-gui/state.yaml")
        self.assertIsNone(self.edit("src/x.ts"), "the count restarts after a push")

    def test_artifact_state_set_counts_as_the_push(self):
        self.edit("src/a.ts")
        self.run_hook({"hook_event_name": "PostToolUse", "tool_name": "Bash",
                       "tool_input": {"command": "python3 .claude/claude-gui/artifact_state.py set '{session: {focus: x}}'"}})
        self.assertIsNone(self.run_hook({"hook_event_name": "Stop"}))

    def test_follows_workview_dir(self):
        (self.root / ".claude-gui").rmdir()
        shared = self.root / "shared"
        shared.mkdir()
        env = {**os.environ, "CLAUDE_PROJECT_DIR": str(self.root), "WORKVIEW_DIR": str(shared)}
        run = lambda p: subprocess.run([sys.executable, str(GUARD)], input=json.dumps(p), capture_output=True, text=True, env=env).stdout
        run({"hook_event_name": "PostToolUse", "tool_name": "Edit", "tool_input": {"file_path": str(self.root / "a.ts")}})
        self.assertIn("block", run({"hook_event_name": "Stop"}))
        run({"hook_event_name": "PostToolUse", "tool_name": "Edit", "tool_input": {"file_path": str(shared / "state.yaml")}})
        self.assertEqual(run({"hook_event_name": "Stop"}).strip(), "")

    def test_does_nothing_without_a_claude_gui_folder(self):
        (self.root / ".claude-gui").rmdir()
        self.edit("src/a.ts")
        self.assertIsNone(self.run_hook({"hook_event_name": "Stop"}))

    def test_bad_input_never_fails(self):
        r = subprocess.run([sys.executable, str(GUARD)], input="not json", capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
