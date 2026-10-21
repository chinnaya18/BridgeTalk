#!/usr/bin/env bash
# ============================================================================
# BridgeTalk — start the React frontend (macOS / Linux)
#
#   ./scripts/run_frontend.sh
#
# Vite dev server on http://localhost:5173.
#
# Camera note: browsers only grant getUserMedia on a secure context, which
# means HTTPS *or* localhost. http://localhost:5173 works. Reaching this
# machine from a second laptop over http://192.168.x.x will NOT get camera
# access — see the two-machine testing section of the README.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR/frontend"

if [ ! -d "node_modules" ]; then
  echo "✗ No node_modules found. Run ./scripts/setup.sh first." >&2
  exit 1
fi

# Keep CORS_ORIGINS pointed at this machine's current LAN address.
#
# The IP changes whenever the laptop joins a different network, and a stale
# entry has a confusing symptom: the other device loads the page and then
# cannot sign in, because the backend rejects the request before it reaches any
# handler. Doing it here means simply starting the app keeps it correct.
#
# Never fatal: if there is no network, the script says so and leaves .env alone.
"$SCRIPT_DIR/set-lan-ip.sh" || true

echo "Starting BridgeTalk frontend on http://localhost:5173"
exec npm run dev
