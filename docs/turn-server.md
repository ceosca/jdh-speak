# Nuestro TURN propio (montado ✅)

> **Para Cristian y su Claude.** Esto ya está **hecho y funcionando**. Este
> documento describe **lo que hay montado**, por qué se decidió así, y cómo
> verificarlo o rehacerlo. Está escrito para poder leerse sin contexto previo.

## Estado

El coturn de terceros (`turn.oriolgomez.com`, el VPS prestado de Oriol) **ya no
está en el código**. Corremos **nuestro propio coturn en la Raspberry**, y los
servidores ICE se configuran desde el `.env` del despliegue.

- [x] coturn instalado y configurado en el Pi
- [x] Puertos abiertos (solo hizo falta **uno nuevo**: 3478)
- [x] `external-ip` auto-actualizado si cambia la IP pública
- [x] ICE configurable por env (server inyecta → cliente lee)
- [x] Credenciales en el `.env` del despliegue, **no** en el repo
- [x] `turn.oriolgomez.com` fuera del código
- [x] Relay verificado (UDP y TCP, con y sin credencial) — **desde el propio Pi**
- [ ] **PENDIENTE: confirmar desde FUERA de la red** (Trickle ICE con datos
      móviles, ver "Verificar" abajo). Los tests hechos salen del Pi hacia la IP
      pública, así que pasan por el *hairpin* del router: buena señal, pero **no
      prueban** que el `3478` entre desde internet. Si NO estuviera abierto, no se
      rompe nada de lo que hoy funciona (el SFU va por UDP directo y no usa TURN):
      el fallo sería **latente**, visible solo cuando alguien entre desde una red
      restrictiva y no conecte.

## Por qué importaba

El TURN es el *fallback* de conectividad. Afecta a:

- **P2P** (≤5 participantes): navegador-a-navegador detrás de NAT simétrico o
  redes restrictivas (corporativas, hoteles, algunos móviles).
- **El fallback TCP del SFU** cuando la red del cliente bloquea UDP.

**No afecta** el camino normal del SFU (media UDP directa al Pi). Por eso el
problema era **latente**: no se notaba hasta que alguien entraba desde una red
jodida. Depender del servidor de un tercero significaba que si se caía o rotaba
credenciales, eso se rompía sin avisar.

## La decisión clave: reutilizar el rango de puertos ya abierto

El router ya reenviaba **`40000–40100`** a `192.168.4.2` para mediasoup, pero
mediasoup usa **1 puerto por transporte** y ese rango estaba sobredimensionado.
En vez de abrir un rango nuevo (el enfoque naíf pedía `49152–65535` = 16.384
puertos), **se repartió el rango existente**:

| Servicio | Rango | Dónde se configura |
|---|---|---|
| **mediasoup** (SFU) | `40000–40059` | `server/src/mediasoup-config.ts` (`rtcMaxPort`) |
| **coturn** (relay) | `40060–40100` | `/etc/turnserver.conf` (`min-port`/`max-port`) |

⚠️ **Deben seguir siendo disjuntos**: dos procesos no pueden bindear el mismo
puerto. Si algún día se sube `rtcMaxPort`, **chocará con el TURN**.

Así, montar el TURN solo necesitó **1 puerto nuevo en el router**: el `3478`
(TCP+UDP), que es el puerto de control. Se usa el **estándar** a propósito: un
TURN en un puerto alto raro lo bloquean justo las redes restrictivas para las que
existe el TURN.

**Sin TLS (`turns:`/5349) por ahora:** añade certificado y complejidad, y su
beneficio real es limitado porque las redes muy restrictivas suelen dejar pasar
solo el 443, que ya lo ocupa Caddy. El `5349` **ni se abre** (`no-tls`/`no-dtls`).

## Qué hay en el Pi

**`/etc/turnserver.conf`** (no versionado — contiene la credencial; `640
root:turnserver`). Puntos importantes:

```conf
listening-port=3478
no-tls
no-dtls
min-port=40060
max-port=40100
external-ip=<IP_PUBLICA>/192.168.4.2

# Autenticación OBLIGATORIA (sin esto sería un RELAY ABIERTO)
fingerprint
lt-cred-mech
realm=jdh.privatedns.org
user=jdhturn:<credencial larga: openssl rand -hex 24>

# Cuotas anti-abuso
user-quota=40
total-quota=40
max-bps=250000          # ~2 Mbit/s por sesión; el audio usa ~0,25

# Superficie mínima
no-cli
no-multicast-peers
syslog                  # logs a journald (acotados), no un fichero suelto

# Impide usar el TURN para alcanzar la LAN / rangos especiales
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
# … (todos los privados/especiales, IPv4 e IPv6 — ver el fichero)
```

Además: `TURNSERVER_ENABLED=1` en `/etc/default/coturn`, y ufw con
`3478/udp` + `3478/tcp` (el rango `40000:40100` ya estaba permitido).

**IP dinámica:** `/usr/local/bin/sonicroom-announce-ip.sh` (timer systemd
`sonicroom-announce-ip.timer`) actualiza **tanto** `ANNOUNCED_IP` del `.env`
(mediasoup) **como** el `external-ip` de coturn, y reinicia el servicio que
corresponda. Si la IP pública cambia y esto no corriera, el TURN anunciaría una
IP muerta y el relay dejaría de funcionar.

## Cómo está enchufado en la app

Los ICE **ya no están hardcodeados**. El servidor los lee del entorno y los
inyecta en el `index.html` servido, igual que `INSTANCE_NAME`:

- **`server/src/index.ts`** → `buildIceServers()` lee `TURN_URLS` (separadas por
  coma), `TURN_USERNAME`, `TURN_CREDENTIAL` y `STUN_URLS` (opcional), y los
  inyecta como `window.__JDH_SPEAK_CONFIG__.iceServers`. Solo emite el TURN si
  están las **tres** variables (avisa por log si faltan credenciales).
- **`client/src/lib/ice.ts`** → `getIceServers()` lee ese global. **Fallback: solo
  STUN público** si no hay nada configurado. Nunca volver a hardcodear un TURN.
- **`client/src/hooks/useMediasoup.ts`** → usa `getIceServers()` en sus tres
  `RTCPeerConnection`.

**`.env` del despliegue** (`/home/pi/jdh-speak/.env`, `chmod 600`, gitignored):

```bash
STUN_URLS=stun:jdh.privatedns.org:3478,stun:stun.l.google.com:19302
TURN_URLS=turn:jdh.privatedns.org:3478?transport=udp,turn:jdh.privatedns.org:3478?transport=tcp
TURN_USERNAME=jdhturn
TURN_CREDENTIAL=<la del turnserver.conf>
```

Se usa el **hostname** (no la IP): el DDNS ya lo mantiene apuntando a la IP
pública, así que un cambio de IP no rompe a los clientes. Y el STUN es **el
nuestro** primero, con Google de respaldo.

> Cambiar de TURN/credenciales = editar `.env` + `systemctl restart sonicroom`.
> **Sin rebuild del cliente** (se inyecta al servir la página).

Nota: la credencial del TURN **es visible para los clientes** — es inevitable,
WebRTC la necesita en el navegador. Por eso importan las cuotas y los
`denied-peer-ip`: acotan el daño si alguien la reutiliza.

## Verificar que funciona

**Desde el Pi** (rápido):
```bash
PW=$(sudo grep -oP '^user=jdhturn:\K.*' /etc/turnserver.conf)
# Debe funcionar (0 paquetes perdidos):
turnutils_uclient -y -u jdhturn -w "$PW" -n 2 -m 1 jdh.privatedns.org
# Por TCP (fallback si la red bloquea UDP):
turnutils_uclient -y -t -u jdhturn -w "$PW" -n 2 -m 1 jdh.privatedns.org
# SIN credencial DEBE fallar ("Cannot complete Allocation") => no es relay abierto:
turnutils_uclient -y -n 1 -m 1 jdh.privatedns.org
```
⚠️ Estos salen del propio Pi hacia la IP pública (hairpin), así que **no prueban
del todo** que el router deje entrar el 3478 desde internet.

**La prueba definitiva (desde FUERA de la red):** abrir
`https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/` en un
móvil **con datos móviles** (no WiFi), añadir
`turn:jdh.privatedns.org:3478`, usuario `jdhturn` + la credencial, y comprobar
que aparecen candidatos de tipo **`relay`**. Si solo salen `host`/`srflx`, el TURN
no se está alcanzando (revisar el reenvío del 3478 en el router y `external-ip`).

**En la app:** entrar de a 2 (modo P2P) desde una red móvil restrictiva y
verificar que el audio conecta.

## Ancho de banda (a tener en cuenta)

El TURN **reenvía media**: si una llamada cae a relay, ese audio pasa por la
**subida del Pi**. Para un grupo chico está bien; `max-bps` acota cada sesión.

## Alternativa (si algún día molesta el self-host)

TURN administrado — evita puertos, IP dinámica y ancho de banda propio.
**Cloudflare Realtime TURN** (tier gratis), Metered, Twilio, Xirsys. Como el ICE
ya es configurable por `.env`, cambiar es editar cuatro variables y reiniciar:
**no hace falta tocar código**.
