#!/usr/bin/env bash
set -euo pipefail
ENV_FILE=/home/pi/jdh-speak/.env
TURN_CONF=/etc/turnserver.conf
LOCAL_IP=192.168.4.2

CUR=$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)
# Solo continuar si parece una IPv4 valida
if ! [[ "$CUR" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  exit 0
fi

# --- mediasoup (ANNOUNCED_IP en el .env) ---
OLD=$(grep -E '^ANNOUNCED_IP=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
if [ "$CUR" != "$OLD" ]; then
  sed -i "s/^ANNOUNCED_IP=.*/ANNOUNCED_IP=$CUR/" "$ENV_FILE"
  systemctl restart sonicroom
  logger -t sonicroom-announce-ip "ANNOUNCED_IP actualizado: '$OLD' -> '$CUR'"
fi

# --- coturn (external-ip=PUBLICA/LOCAL). Si la IP publica cambia y esto no se
# --- actualiza, el TURN anuncia una IP muerta y el relay deja de funcionar.
if [ -f "$TURN_CONF" ]; then
  OLD_TURN=$(grep -oP '^external-ip=\K[0-9.]+' "$TURN_CONF" 2>/dev/null || true)
  if [ -n "$OLD_TURN" ] && [ "$CUR" != "$OLD_TURN" ]; then
    sed -i "s|^external-ip=.*|external-ip=$CUR/$LOCAL_IP|" "$TURN_CONF"
    systemctl restart coturn
    logger -t sonicroom-announce-ip "coturn external-ip actualizado: '$OLD_TURN' -> '$CUR'"
  fi
fi
