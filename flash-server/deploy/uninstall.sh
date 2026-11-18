#!/usr/bin/env bash
# Remove Flash Server: sudo ./uninstall.sh [--purge]
# Keeps /etc/flash-server and /var/lib/flash-server (data, backups) unless --purge is given.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "error: run with sudo" >&2; exit 1; }
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

if systemctl list-unit-files flash-server.service >/dev/null 2>&1; then
  systemctl disable --now flash-server.service >/dev/null 2>&1 || true
fi
rm -f /etc/systemd/system/flash-server.service
systemctl daemon-reload
rm -rf /opt/flash-server
if [ "$PURGE" -eq 1 ]; then
  rm -rf /etc/flash-server /var/lib/flash-server
  if id -u flash >/dev/null 2>&1; then userdel flash || true; fi
  echo "Flash Server removed, including config and data."
else
  echo "Flash Server removed. Config (/etc/flash-server) and data (/var/lib/flash-server) were kept; use --purge to delete them."
fi
