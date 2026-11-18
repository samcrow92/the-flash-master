#!/usr/bin/env bash
# Update Flash Server code from an unpacked copy, keep config + data: sudo ./deploy/update.sh [--no-backup]
# Takes a backup first (into <dataDir>/backups/), replaces /opt/flash-server/flashserver, restarts, checks health.
set -euo pipefail

APP_DIR=/opt/flash-server
CONF=/etc/flash-server/config.json
SVC_USER=flash
BACKUP=1
[ "${1:-}" = "--no-backup" ] && BACKUP=0

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run with sudo"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
cd /  # python -m puts the cwd on sys.path; never run from a writable folder
[ -f "$SRC/server/flashserver/__init__.py" ] || die "flashserver package not found in $SRC/server"
[ -d "$APP_DIR/flashserver" ] || die "Flash Server is not installed; run install.sh"

run_cli() { runuser -u "$SVC_USER" -- env PYTHONPATH="$APP_DIR" PYTHONDONTWRITEBYTECODE=1 python3 -m flashserver "$@" --config "$CONF"; }

if [ "$BACKUP" -eq 1 ]; then
  echo "==> backup"
  run_cli backup >&2
fi
echo "==> code"
rm -rf "$APP_DIR/flashserver.new"
cp -r "$SRC/server/flashserver" "$APP_DIR/flashserver.new"
find "$APP_DIR/flashserver.new" -name '__pycache__' -type d -prune -exec rm -rf {} +
rm -rf "$APP_DIR/flashserver"
mv "$APP_DIR/flashserver.new" "$APP_DIR/flashserver"
for f in install.sh update.sh uninstall.sh flash-server.service nginx-flash-server.conf; do
  if [ -f "$HERE/$f" ]; then install -D -m 755 "$HERE/$f" "$APP_DIR/deploy/$f"; fi
done
chown -R root:root "$APP_DIR"
chmod -R a+rX,go-w "$APP_DIR"
if ! cmp -s "$HERE/flash-server.service" /etc/systemd/system/flash-server.service; then
  install -m 644 "$HERE/flash-server.service" /etc/systemd/system/flash-server.service
  systemctl daemon-reload
fi
echo "==> migrations"
run_cli init --json >/dev/null
systemctl restart flash-server.service
PORT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("port", 8787))' "$CONF")"
for _ in $(seq 1 20); do
  if python3 -c 'import sys,urllib.request; print(urllib.request.urlopen(sys.argv[1], timeout=2).read().decode())' "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null; then
    exit 0
  fi
  sleep 0.5
done
die "flash-server did not come back; see journalctl -u flash-server -n 50"
