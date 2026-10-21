#!/usr/bin/env bash
# ============================================================================
# BridgeTalk — start the FastAPI backend (macOS / Linux)
#
#   ./scripts/run_backend.sh
#
# Serves the REST API and both WebSocket endpoints on http://localhost:8000.
# Interactive API docs: http://localhost:8000/docs
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -d ".venv" ]; then
  echo "✗ No .venv found. Run ./scripts/setup.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1091
source .venv/bin/activate

if [ ! -f ".env" ]; then
  echo "✗ No .env found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# Read host/port from .env if present, otherwise fall back to the defaults.
# Keep CORS_ORIGINS pointed at this machine's current LAN address.
#
# The IP changes whenever the laptop joins a different network, and a stale
# entry has a confusing symptom: the other device loads the page and then
# cannot sign in, because the backend rejects the request before it reaches any
# handler. Doing it here means simply starting the app keeps it correct.
#
# Never fatal: if there is no network, the script says so and leaves .env alone.
"$SCRIPT_DIR/set-lan-ip.sh" || true

HOST="$(grep -E '^BACKEND_HOST=' .env | cut -d= -f2- || true)"
PORT="$(grep -E '^BACKEND_PORT=' .env | cut -d= -f2- || true)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

echo "Starting BridgeTalk API on http://localhost:${PORT}  (docs at /docs)"

# --app-dir backend puts backend/ on the import path, so `app.main` resolves.
# --reload restarts on save; drop it if you ever deploy this for real.
exec uvicorn app.main:app --app-dir backend --host "$HOST" --port "$PORT" --reload
