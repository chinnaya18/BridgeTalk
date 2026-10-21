#!/usr/bin/env bash
#
# Keep CORS_ORIGINS in .env pointed at this machine's current LAN address.
#
# WHY THIS EXISTS
# ---------------
# The IP is needed in exactly one place — CORS_ORIGINS — but it changes every
# time the laptop joins a different network, and a stale entry has a confusing
# symptom: the other device LOADS the page fine and then cannot sign in,
# because the backend rejects the request before it reaches any handler. The
# browser reports a CORS error that mentions nothing about BridgeTalk.
#
# run_backend.sh and run_frontend.sh call this automatically, so simply starting
# the app keeps the value correct. Run it by hand if the network changes while
# the servers are already up — then restart the backend, which reads
# CORS_ORIGINS once at startup.
#
# WHAT IT WILL NOT DO
# -------------------
# It rewrites ONE line and leaves every other line byte-for-byte alone,
# including DATABASE_URL and JWT_SECRET_KEY. It never prints a secret. It never
# widens CORS to a wildcard: the allowlist stays explicit, with exactly this
# machine's address in it.
#
#   ./scripts/set-lan-ip.sh              detect and update
#   ./scripts/set-lan-ip.sh 10.0.0.7     force a specific address
#   ./scripts/set-lan-ip.sh --print      show what it would do, change nothing
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
PORT=5173

DRY_RUN=0
FORCED=""
for arg in "$@"; do
  case "$arg" in
    --print|--dry-run) DRY_RUN=1 ;;
    -*) echo "set-lan-ip: unknown option $arg" >&2; exit 2 ;;
    *) FORCED="$arg" ;;
  esac
done

# --- find this machine's LAN address ---------------------------------------
# The interface behind the default route is the one actually carrying traffic,
# which matters on a laptop with Wi-Fi and Ethernet both up — picking the wrong
# one gives an address the other device cannot reach.
detect_ip() {
  local ip=""

  if command -v route >/dev/null 2>&1 && command -v ipconfig >/dev/null 2>&1; then
    local iface
    iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')" || true
    if [ -n "$iface" ]; then
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null)" || true
    fi
    # Fall back to any interface with an address, in listed order.
    if [ -z "$ip" ]; then
      for iface in $(ipconfig getiflist 2>/dev/null); do
        ip="$(ipconfig getifaddr "$iface" 2>/dev/null)" || true
        [ -n "$ip" ] && break
      done
    fi
  fi

  # Linux
  if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')" || true
  fi
  if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  fi

  printf '%s' "$ip"
}

IP="${FORCED:-$(detect_ip)}"

if [ -z "$IP" ]; then
  echo "set-lan-ip: no network address found — leaving .env unchanged." >&2
  echo "            localhost will still work; another device will not." >&2
  exit 0
fi

if ! printf '%s' "$IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
  echo "set-lan-ip: '$IP' is not an IPv4 address — leaving .env unchanged." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "set-lan-ip: no .env at $ENV_FILE. Copy .env.example to .env first." >&2
  exit 1
fi

DESIRED="http://localhost:$PORT,http://127.0.0.1:$PORT,https://$IP:$PORT,http://$IP:$PORT"
CURRENT="$(awk -F= '/^CORS_ORIGINS=/{sub(/^CORS_ORIGINS=/,""); print; exit}' "$ENV_FILE" || true)"

if [ "$CURRENT" = "$DESIRED" ]; then
  echo "  LAN address: $IP (CORS_ORIGINS already correct)"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would set CORS_ORIGINS to:"
  echo "    $DESIRED"
  echo "  current value:"
  echo "    ${CURRENT:-<missing>}"
  exit 0
fi

# --- rewrite exactly one line ----------------------------------------------
# A temp file plus mv, so an interrupted run cannot leave a half-written .env
# holding the database password. Every other line is copied verbatim.
TMP="$(mktemp "${TMPDIR:-/tmp}/bridgetalk-env.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"

if grep -q '^CORS_ORIGINS=' "$ENV_FILE"; then
  # `value` is passed via -v rather than interpolated, so an address can never
  # be read as an awk expression.
  awk -v value="CORS_ORIGINS=$DESIRED" \
    '/^CORS_ORIGINS=/ && !done { print value; done = 1; next } { print }' \
    "$ENV_FILE" > "$TMP"
else
  cat "$ENV_FILE" > "$TMP"
  printf '\n# Added by scripts/set-lan-ip.sh\nCORS_ORIGINS=%s\n' "$DESIRED" >> "$TMP"
fi

# Preserve the original permissions rather than inheriting the temp file's.
if [ -f "$ENV_FILE" ]; then
  PERMS="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 600)"
  chmod "$PERMS" "$TMP"
fi

mv "$TMP" "$ENV_FILE"
trap - EXIT

echo "  LAN address: $IP"
echo "  CORS_ORIGINS updated. Other devices: https://$IP:$PORT"
if [ -n "$CURRENT" ] && [ "$CURRENT" != "$DESIRED" ]; then
  echo "  (the backend reads this at startup — restart it if it is already running)"
fi
