#!/usr/bin/env python3
"""Local Battlesnake API proxy that forwards via curl (sandbox-friendly)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REMOTE = os.environ.get("REMOTE_SNAKE_URL", "https://battlesnake.fly.dev").rstrip("/")
PORT = int(os.environ.get("PROXY_PORT", "19001"))


def curl(method, path, body=None):
    url = REMOTE + (path if path.startswith("/") else "/" + path)
    cmd = ["curl", "-sS", "-m", "8", "-w", "\n%{http_code}", "-X", method, url]
    if body is not None:
        cmd.extend(["-H", "Content-Type: application/json", "--data-binary", "@-"])
    try:
        proc = subprocess.run(
            cmd,
            input=body,
            capture_output=True,
            timeout=10,
        )
    except Exception as e:
        return 502, json.dumps({"error": str(e)}).encode()
    out = proc.stdout or b""
    if b"\n" in out:
        payload, _, code_s = out.rpartition(b"\n")
        try:
            code = int(code_s.decode().strip() or "502")
        except ValueError:
            code, payload = 502, out
    else:
        code, payload = (200 if proc.returncode == 0 else 502), out
    if proc.returncode != 0 and not payload:
        payload = (proc.stderr or b"curl failed")
    return code, payload


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, payload: bytes) -> None:
        self.send_response(code if 100 <= code <= 599 else 502)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        code, payload = curl("GET", "/")
        self._send(code, payload)

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b"{}"
        path = self.path.split("?", 1)[0]
        if path not in ("/move", "/start", "/end"):
            path = "/move"
        code, payload = curl("POST", path, body)
        self._send(code, payload)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"proxy {REMOTE} -> http://127.0.0.1:{PORT}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
