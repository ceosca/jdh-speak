#!/bin/sh
# Watchdog de sonicroom: recupera el servicio si se COLGO (event loop bloqueado -> el
# proceso sigue "vivo" para systemd pero no responde) o si systemd se RINDIO (failed).
# NO toca si esta "inactive": eso es un stop deliberado (mantenimiento), hay que respetarlo.
SVC=sonicroom
state=$(systemctl is-active "$SVC" 2>/dev/null)

# Parada manual (mantenimiento) -> dejar en paz.
[ "$state" = "inactive" ] && exit 0

# Crasheo y quedo failed -> revivir.
if [ "$state" = "failed" ]; then
  logger -t sonicroom-hc "servicio en failed -> reset-failed + start"
  systemctl reset-failed "$SVC"; systemctl start "$SVC"; exit 0
fi

# Activo: confirmar que RESPONDE. Solo reinicia si 3 chequeos seguidos fallan (no un
# bache momentaneo): un server sano contesta / en milisegundos, uno colgado nunca.
i=0
while [ "$i" -lt 3 ]; do
  if curl -sf --max-time 10 -o /dev/null http://127.0.0.1:3100/ 2>/dev/null; then
    exit 0
  fi
  i=$((i+1)); [ "$i" -lt 3 ] && sleep 5
done
logger -t sonicroom-hc "activo pero sin responder (3 fallos) -> restart"
systemctl restart "$SVC"
