#!/usr/bin/env bash
# Sync local fly → Replit package and push to GitHub (Replit pulls from this repo).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLISH="${ROOT}/replit-publish"
DEST_ALSO="${ROOT}/replit"

sync_into() {
  local dest="$1"
  mkdir -p "${dest}/ladder/dials"
  cp "${ROOT}/server.py" "${dest}/main.py"
  cp "${ROOT}/game_log.py" "${dest}/game_log.py"
  cp "${ROOT}/dials.py" "${dest}/dials.py"
  cp "${ROOT}/ladder/dials/leader.json" "${dest}/ladder/dials/leader.json"
  echo "synced → ${dest}"
}

sync_into "$DEST_ALSO"
sync_into "$PUBLISH"

cd "$PUBLISH"
if [[ ! -d .git ]]; then
  echo "replit-publish is not a git repo — copy files manually into Replit" >&2
  exit 1
fi

git add main.py game_log.py dials.py ladder/dials/leader.json README.md 2>/dev/null || true
if git diff --cached --quiet; then
  echo "nothing new to commit"
else
  git commit -m "$(cat <<'EOF'
Sync Walton-LoFly leader dials to Replit

EOF
)"
fi

git push origin HEAD
echo "pushed. On Replit: pull / republish, then wake the public URL before playing."
