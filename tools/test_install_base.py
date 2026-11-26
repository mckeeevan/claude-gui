"""Tests for install.py's working base: python3 -m unittest discover tools"""
import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("install", pathlib.Path(__file__).resolve().parent.parent / "install.py")
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = pathlib.Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_merge_block_appends_once_and_replaces_in_place(self):
        once = install.merge_block("# App\n\nUse tabs.\n", "v1")
        twice = install.merge_block(once + "\nMore of mine.\n", "v2")
        self.assertEqual(twice.count(install.BLOCK_START), 1)
        self.assertIn("v2", twice)
        self.assertNotIn("v1", twice)
        self.assertTrue(twice.startswith("# App\n\nUse tabs."))
        self.assertIn("More of mine.", twice)

    def test_a_file_made_your_own_is_kept(self):
        src = self.p / "src.md"
        src.write_text(install.BASE_MARK + " -->\nnew")
        dst = self.p / "dst.md"
        dst.write_text("mine")
        self.assertIsNotNone(install.install_managed(src, dst))
        self.assertEqual(dst.read_text(), "mine")
        dst.write_text(install.BASE_MARK + " -->\nold")
        self.assertIsNone(install.install_managed(src, dst))
        self.assertIn("new", dst.read_text())

    def test_detects_node_python_rust_and_go_checks(self):
        (self.p / "package.json").write_text(json.dumps({"scripts": {"test": "vitest", "build": "vite build", "dev": "vite"}}))
        (self.p / "pyproject.toml").write_text("[tool.pytest.ini_options]\n[tool.mypy]\n")
        (self.p / "uv.lock").write_text("")
        (self.p / "Cargo.toml").write_text("")
        (self.p / "go.mod").write_text("")
        checks = install.detect_checks(self.p)
        for c in ("npm run build", "npm test", "uv run pytest", "uv run mypy .", "cargo test", "go test ./..."):
            self.assertIn(c, checks)
        self.assertNotIn("npm run dev", checks)

    def test_install_base_writes_agents_rules_and_checks_once(self):
        install.install_base(self.p)
        md = (self.p / "CLAUDE.md").read_text()
        self.assertTrue((self.p / ".claude/agents/task-planner.md").exists())
        self.assertTrue((self.p / ".claude/rules/testing.md").exists())
        (self.p / "CLAUDE.md").write_text(md.replace("(none found yet", "(edited"))
        install.install_base(self.p)
        md2 = (self.p / "CLAUDE.md").read_text()
        self.assertEqual(md2.count("## Checks"), 1)
        self.assertIn("(edited", md2, "the checks list is the project's after the first install")


if __name__ == "__main__":
    unittest.main()
