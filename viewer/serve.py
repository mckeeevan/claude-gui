#!/usr/bin/env python3
"""Serve the Claude GUI viewer for one project.

    python3 serve.py /path/to/your/repo [--port 8765]

Then open http://localhost:8765. The page re-reads the repo's
.claude-gui/state.yaml, events.jsonl and heartbeat every second. With
WORKVIEW_DIR set (or --dir), it serves that folder instead.
"""
import argparse
import http.server
import os
import mimetypes
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
HEAD = (b'<!doctype html><html lang="en"><head><meta charset="utf-8">'
        b'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>')


def make_handler(project, state_dir=None):
    state_dir = pathlib.Path(state_dir or project / ".claude-gui").resolve()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html"):
                return self.send(200, HEAD + (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
            if path.startswith("/state/"):
                f = (state_dir / path[len("/state/"):]).resolve()
                if f.parent == state_dir and f.is_file():
                    return self.send(200, f.read_bytes(), "text/plain; charset=utf-8")
            f = (HERE / path.lstrip("/")).resolve()
            if f.is_file() and HERE in f.parents and f.suffix in (".js", ".css", ".svg", ".png", ".json"):
                ctype = "text/javascript" if f.suffix == ".js" else (mimetypes.guess_type(f.name)[0] or "application/octet-stream")
                return self.send(200, f.read_bytes(), ctype)
            self.send(404, b"not found", "text/plain")

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project", nargs="?", default=os.getcwd())
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--dir", default=os.environ.get("WORKVIEW_DIR"), help="the state folder (default .claude-gui)")
    a = ap.parse_args()
    project = pathlib.Path(a.project).resolve()
    state = project / (a.dir or ".claude-gui")  # an absolute --dir replaces the project path
    state.mkdir(parents=True, exist_ok=True)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(project, state))
    print(f"Claude GUI for {project}\n  http://localhost:{a.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
