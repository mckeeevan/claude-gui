#!/usr/bin/env python3
"""Builds viewer/index.html from index.template.html, embedding the example files as demo data."""
import pathlib
here = pathlib.Path(__file__).resolve().parent
example = here.parent / "example" / ".claude-gui"
state = (example / "state.yaml").read_text()
events = (example / "events.jsonl").read_text()
coverage = (example / "coverage.json").read_text()
assert "</script" not in state + events + coverage
html = (here / "index.template.html").read_text().replace("__DEMO_STATE__", state).replace("__DEMO_EVENTS__", events).replace("__DEMO_COVERAGE__", coverage)
(here / "index.html").write_text(html)
print("wrote", here / "index.html")
