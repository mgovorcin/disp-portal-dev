#!/usr/bin/env bash
# Keep disp-proxy running on 127.0.0.1:8790. Safe to run often (e.g. from cron every minute):
# does nothing when /health answers, otherwise starts the proxy detached from any session.
#
# Install (your decision; not done automatically):
#   (crontab -l; echo "* * * * * /path/to/disp-portal-dev/scripts/ensure_proxy.sh") | crontab -
set -u
PORTAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${DISP_PROXY_PORT:-8790}"
LOG="$PORTAL/logs/disp-proxy.log"
mkdir -p "$PORTAL/logs"

if curl -sf -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null; then
  exit 0
fi
# Port held by a hung process? Report it rather than killing blindly.
if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "$(date -Is) port ${PORT} busy but /health not answering" >> "$LOG"
  exit 1
fi
echo "$(date -Is) starting disp-proxy on port ${PORT}" >> "$LOG"
cd "$PORTAL"
export TMPDIR="${TMPDIR:-$PORTAL/.cache/tmp}"
mkdir -p "$TMPDIR"
setsid nohup "$PORTAL/.venv/bin/disp-proxy" --host 127.0.0.1 --port "$PORT" >> "$LOG" 2>&1 < /dev/null &
disown
