#!/usr/bin/env bash
# Pairs a device. Run it on the server host, as the gateway's user: it asks the gateway's CLI for a one-time link and shows it as
# a QR code here; it isn't logged or written to disk. LUMBRIDGE_STATE_DIR and LUMBRIDGE_SERVER (the binary) default to the paths
# in the README's install steps.
# The link works once, for 10 minutes, and only from a node the gateway admits.
#   scripts/pair.sh <device-name>          QR code in this terminal
#   scripts/pair.sh <device-name> --link   the link as text, to open on this same computer
set -euo pipefail
device=${1:?usage: scripts/pair.sh <device-name> [--link]}
mode=${2:-qr}
[[ $device =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "device names are letters, digits, . _ -" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
server=${LUMBRIDGE_SERVER:-$HOME/.local/bin/lumbridge-mobile-server}
link=$(LUMBRIDGE_STATE_DIR=${LUMBRIDGE_STATE_DIR:-$HOME/.config/lumbridge-mobile/state} "$server" pair "$device")
show_qr() {
  if command -v qrencode >/dev/null; then
    printf '%s' "$link" | qrencode -t ansiutf8
  else
    printf '%s' "$link" | python3 -I "$here/qr.py"
  fi
}
if [ "$mode" = --link ] || ! show_qr; then
  printf '%s\n' "$link"
fi
echo "One use, 10 minutes. Tailscale must be on." >&2
