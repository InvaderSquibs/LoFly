#!/usr/bin/env bash
# Start FS-Avatar webhook(s) detached from the parent shell.
# Cursor agent shells kill background jobs on exit — we must start a new session.
#
# Walton (:8001): FS_AVATAR_DIALS → ladder/dials/leader.json by default
# Three rivals (:8002/:8003/:8004): optional FS_RIVAL_<port>_DIALS=path
#   or FS_AVATAR_RIVAL_DIALS=- for code defaults on all rivals
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PATH="$(go env GOPATH 2>/dev/null)/bin:${PATH:-}"
PRIMARY_PORT="${FS_AVATAR_PORT:-8001}"
WALTON_DIALS="${FS_AVATAR_DIALS:-$ROOT/ladder/dials/leader.json}"

start_one() {
  local port="$1" name="$2" color="$3" dials="${4:-}"
  local log="/tmp/fs-${port}.log"
  local pidfile="/tmp/fs-${port}.pid"
  local force="${FS_AVATAR_FORCE_RESTART:-0}"

  if [[ "$force" != "1" ]] && curl -sf --max-time 1 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
    echo "already up :${port} (${name})"
    return 0
  fi

  # Kill stale / forced restart
  if lsof -tiTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    lsof -tiTCP:"${port}" -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
    sleep 0.2
  fi

  local -a env_args=(
    "FS_AVATAR_PORT=${port}"
    "FS_AVATAR_NAME=${name}"
    "FS_AVATAR_COLOR=${color}"
  )
  if [[ "$port" == "$PRIMARY_PORT" ]]; then
    env_args+=( "FS_AVATAR_DIALS=${WALTON_DIALS}" )
    dials="$WALTON_DIALS"
  elif [[ -n "$dials" ]]; then
    env_args+=( "FS_AVATAR_DIALS=${dials}" )
  else
    env_args+=( "FS_AVATAR_DIALS=-" )
  fi

  env "${env_args[@]}" \
    python3 - "$ROOT" "$log" "$pidfile" <<'PY'
import os, sys, subprocess
root, log, pidfile = sys.argv[1], sys.argv[2], sys.argv[3]
env = os.environ.copy()
with open(log, "a", encoding="utf-8") as fh:
    fh.write(
        f"\n--- ensure_up {os.environ.get('FS_AVATAR_NAME')} "
        f":{os.environ.get('FS_AVATAR_PORT')} "
        f"dials={os.environ.get('FS_AVATAR_DIALS', '(defaults)')} ---\n"
    )
    fh.flush()
    proc = subprocess.Popen(
        [sys.executable, os.path.join(root, "server.py")],
        cwd=root,
        env=env,
        stdout=fh,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
open(pidfile, "w", encoding="utf-8").write(str(proc.pid))
print(proc.pid)
PY

  local ok=0
  for _ in $(seq 1 40); do
    if curl -sf --max-time 1 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 0.15
  done
  if [[ "$ok" -eq 1 ]]; then
    echo "started :${port} (${name}) pid=$(cat "$pidfile") dials=${dials:-defaults}"
  else
    echo "FAILED to start :${port} — see ${log}" >&2
    return 1
  fi
}

# Default: Walton + 3 ladder bots (Hungry / Scared / Hippo seats)
start_one "$PRIMARY_PORT" "${FS_AVATAR_NAME:-Walton-LoFly-v0.1}" "${FS_AVATAR_COLOR:-#141414}" ""
if [[ "${FS_AVATAR_RIVALS:-1}" == "1" ]]; then
  start_one 8002 "${FS_RIVAL_8002_NAME:-Bot-Hungry}" "${FS_RIVAL_8002_COLOR:-#52c7e0}" "${FS_RIVAL_8002_DIALS:-}"
  start_one 8003 "${FS_RIVAL_8003_NAME:-Bot-Scared}" "${FS_RIVAL_8003_COLOR:-#7aa2ff}" "${FS_RIVAL_8003_DIALS:-}"
  start_one 8004 "${FS_RIVAL_8004_NAME:-Bot-Hippo}" "${FS_RIVAL_8004_COLOR:-#ef6a61}" "${FS_RIVAL_8004_DIALS:-}"
fi
echo "status: $(curl -sf http://127.0.0.1:${PRIMARY_PORT}/dev/status | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("dials_id","ok") if d.get("ok") else d)' 2>/dev/null || echo down)"
