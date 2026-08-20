#!/usr/bin/env bash
# THROWAWAY probe launcher — run ON THE PI (pi@192.168.4.2).
#   cd /home/pi/jdh-speak/experiments/webtransport-jam && bash run-on-pi.sh
# Copies the live Caddy cert next to the relay (so the browser trusts the QUIC
# connection with no self-signed hash dance), installs deps once, and starts the
# echo relay on udp/4433. Ctrl-C to stop. Nothing here touches the real app,
# systemd, or mediasoup.
set -euo pipefail

CADDY_DIR="/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/jdh.privatedns.org"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "[run] copying live Caddy cert for jdh.privatedns.org …"
sudo cp "$CADDY_DIR/jdh.privatedns.org.crt" "$HERE/jdh.privatedns.org.crt"
sudo cp "$CADDY_DIR/jdh.privatedns.org.key" "$HERE/jdh.privatedns.org.key"
sudo chown "$(id -un):$(id -gn)" "$HERE/jdh.privatedns.org.crt" "$HERE/jdh.privatedns.org.key"
chmod 600 "$HERE/jdh.privatedns.org.key"

if [ ! -d "$HERE/node_modules" ]; then
  echo "[run] installing deps (native HTTP/3 build, first time only) …"
  ( cd "$HERE" && npm install --no-save )
fi

echo "[run] starting relay on udp/4433 (path /echo). Ctrl-C to stop."
cd "$HERE"
WT_PORT="${WT_PORT:-4433}" node relay.mjs
