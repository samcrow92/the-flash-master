#!/usr/bin/env bash
# Install or upgrade Flash Server on Ubuntu 22.04 / 24.04 (idempotent). Run from an unpacked copy of flash-server/:
#   sudo ./deploy/install.sh [--host 0.0.0.0] [--port 8787] [--name "Body SW"] [--open-firewall]
# The last line of output is JSON: {"adminToken": "fs_..."} on the first install, {"adminToken": null} on an upgrade.
set -euo pipefail

APP_DIR=/opt/flash-server
CONF_DIR=/etc/flash-server
CONF="$CONF_DIR/config.json"
DATA_DIR=/var/lib/flash-server
UNIT=/etc/systemd/system/flash-server.service
SVC_USER=flash
HOST=""
PORT=""
NAME=""
OPEN_FW=0

usage() { sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --open-firewall) OPEN_FW=1; shift ;;
    -h|--help) usage 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run with sudo"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
cd /  # python -m puts the cwd on sys.path; never run from a writable folder
[ -f "$SRC/server/flashserver/__init__.py" ] || die "flashserver package not found next to this script ($SRC/server)"
command -v python3 >/dev/null || die "python3 is required (apt install python3)"
python3 -c 'import sys, sqlite3; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || die "Python 3.10+ with sqlite3 is required"
if [ -n "$PORT" ]; then
  case "$PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac
fi

log "system user $SVC_USER"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

log "code -> $APP_DIR"
install -d -m 755 "$APP_DIR"
rm -rf "$APP_DIR/flashserver.new"
cp -r "$SRC/server/flashserver" "$APP_DIR/flashserver.new"
find "$APP_DIR/flashserver.new" -name '__pycache__' -type d -prune -exec rm -rf {} +
rm -rf "$APP_DIR/flashserver"
mv "$APP_DIR/flashserver.new" "$APP_DIR/flashserver"
install -d -m 755 "$APP_DIR/deploy"
for f in install.sh update.sh uninstall.sh flash-server.service nginx-flash-server.conf; do
  if [ -f "$HERE/$f" ]; then install -m 755 "$HERE/$f" "$APP_DIR/deploy/$f"; fi
done
chown -R root:root "$APP_DIR"
chmod -R a+rX,go-w "$APP_DIR"

log "config $CONF"
install -d -m 750 -o root -g "$SVC_USER" "$CONF_DIR"
# Write defaults when absent; apply --host/--port/--name when given (other keys are kept).
CONF="$CONF" DATA_DIR="$DATA_DIR" HOST="$HOST" PORT="$PORT" NAME="$NAME" python3 - <<'PY'
import json, os
p = os.environ["CONF"]
cfg = {"name": "Flash Server", "host": "127.0.0.1", "port": 8787, "dataDir": os.environ["DATA_DIR"], "publicRead": False}
if os.path.exists(p):
    with open(p, encoding="utf-8") as f:
        cfg.update(json.load(f))
if os.environ["HOST"]:
    cfg["host"] = os.environ["HOST"]
if os.environ["PORT"]:
    cfg["port"] = int(os.environ["PORT"])
if os.environ["NAME"]:
    cfg["name"] = os.environ["NAME"]
tmp = p + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
os.replace(tmp, p)
PY
chown root:"$SVC_USER" "$CONF"
chmod 640 "$CONF"
PORT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$CONF")"

log "data dir $DATA_DIR"
install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"

log "initialising (database migrations; first admin on a new install)"
INIT_OUT="$(runuser -u "$SVC_USER" -- env PYTHONPATH="$APP_DIR" PYTHONDONTWRITEBYTECODE=1 python3 -m flashserver init --config "$CONF" --json)"
TOKEN_JSON="$(printf '%s\n' "$INIT_OUT" | tail -n 1 | python3 -c 'import json,sys; print(json.dumps({"adminToken": json.loads(sys.stdin.read()).get("adminToken")}))')"

log "systemd unit"
install -m 644 "$HERE/flash-server.service" "$UNIT"
systemctl daemon-reload
systemctl enable flash-server.service >/dev/null 2>&1
systemctl restart flash-server.service

if [ "$OPEN_FW" -eq 1 ]; then
  if command -v ufw >/dev/null; then
    log "ufw allow $PORT/tcp"
    ufw allow "$PORT/tcp" >/dev/null
  else
    log "ufw not installed; open port $PORT yourself"
  fi
fi

log "waiting for http://127.0.0.1:$PORT/api/v1/health"
ok=0
for _ in $(seq 1 20); do
  if python3 -c 'import sys,urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2)' "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null; then
    ok=1; break
  fi
  sleep 0.5
done
if [ "$ok" -eq 1 ]; then
  log "flash-server is running (journalctl -u flash-server -f for logs)"
else
  log "flash-server did not answer yet; check: systemctl status flash-server; journalctl -u flash-server -n 50"
fi
printf '%s\n' "$TOKEN_JSON"
