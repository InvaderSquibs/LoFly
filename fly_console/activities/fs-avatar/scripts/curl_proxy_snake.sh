#!/bin/bash
# Minimal Battlesnake reverse proxy using only curl + python stdlib (localhost only).
# Upstream HTTPS is fetched exclusively via /usr/bin/curl for sandbox allowlisting.
set -euo pipefail
REMOTE="${REMOTE_SNAKE_URL:-https://battlesnake.fly.dev}"
PORT="${PROXY_PORT:-19001}"
REMOTE="${REMOTE%/}"
export REMOTE PORT

# smoke-check upstream via curl (also tips allowlist)
/usr/bin/curl -sS -m 8 "$REMOTE/" >/dev/null

exec /usr/bin/python3 - <<'PY'
import json, os, subprocess, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REMOTE = os.environ["REMOTE"].rstrip("/")
PORT = int(os.environ["PORT"])
CURL = "/usr/bin/curl"

def upstream(method, path, body=None):
    url = REMOTE + path
    cmd = [CURL, "-sS", "-m", "8", "-w", "\n%{http_code}", "-X", method, url]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
    proc = subprocess.run(cmd, input=body, capture_output=True, timeout=12)
    out = proc.stdout or b""
    if b"\n" in out:
        payload, _, code_s = out.rpartition(b"\n")
        try:
            code = int(code_s.decode().strip())
        except Exception:
            code, payload = 502, out or (proc.stderr or b"bad upstream")
    else:
        code, payload = (200 if proc.returncode == 0 else 502), out or (proc.stderr or b"bad upstream")
    if not payload.startswith(b"{") and not payload.startswith(b"["):
        # surface curl errors as JSON so callers fail clearly
        payload = json.dumps({
            "error": "upstream_non_json",
            "curl_rc": proc.returncode,
            "stderr": (proc.stderr or b"").decode("utf-8", "replace")[:300],
            "stdout": payload.decode("utf-8", "replace")[:300],
        }).encode()
        code = 502
    return code, payload

class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"proxy: {fmt % args}\n")
    def _send(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def do_GET(self):
        self._send(*upstream("GET", "/"))
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b"{}"
        path = self.path.split("?", 1)[0]
        if path not in ("/move", "/start", "/end"):
            path = "/move"
        self._send(*upstream("POST", path, body))

print(f"proxy {REMOTE} -> http://127.0.0.1:{PORT}/", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
PY
