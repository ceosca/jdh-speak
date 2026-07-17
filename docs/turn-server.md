# Montar un TURN propio (pendiente importante)

> **Para Cristian y su Claude.** Esto es una tarea de infraestructura pendiente,
> no un bug. Está escrito para poder ejecutarse sin contexto previo.

## Por qué importa (el problema hoy)

Los servidores ICE están **hardcodeados** en
[`client/src/hooks/useMediasoup.ts`](../client/src/hooks/useMediasoup.ts) (busca
`ICE_SERVERS`, ~línea 60) y apuntan a un **coturn de un tercero**:

```
turn.oriolgomez.com   (usuario "gamesturn", credencial en el código)
```

Ese servidor es el **VPS de Oriol Gomez, compartido con sus juegos** — no es
nuestro. Implica:

- **Dependencia externa fuera de nuestro control:** si se cae, cambia las
  credenciales o nos saca, se rompe la conectividad en las redes difíciles.
- **Qué se rompe exactamente:** el TURN es el *fallback*. Afecta a
  - **P2P** (≤5 participantes): conexiones navegador-a-navegador detrás de NAT
    simétrico o redes restrictivas (corporativas, hoteles, algunos móviles).
  - **El fallback TCP/TLS del SFU** cuando la red del cliente bloquea UDP.
- **No afecta** el camino normal del SFU (media UDP directa al Pi), que es lo que
  hoy anda estable. Por eso el problema **está latente**: no se nota hasta que
  alguien entra desde una red jodida.

**Objetivo:** tener nuestro propio TURN y sacarnos la dependencia de encima.

## Buena noticia: el Pi ya es alcanzable

El SFU funciona con gente de afuera, o sea que el Pi **ya tiene IP pública
alcanzable + reenvío de puertos** (mediasoup usa UDP `40000–40100` y
`ANNOUNCED_IP`). **No hay CGNAT bloqueando.** Por lo tanto, correr coturn en el
mismo Pi es viable: solo hay que abrirle sus puertos.

(Si algún día el SFU dejara de funcionar para gente de afuera, revisar CGNAT
primero: `curl -s ifconfig.me` debe coincidir con la IP de internet del router y
no empezar en `100.64.–100.127.`)

## Qué necesita un TURN

1. **Ser alcanzable desde internet** (✓ ya lo tenemos).
2. **Puertos abiertos** (reenvío en el router **y** firewall del Pi):
   - `3478` **UDP y TCP** — TURN/STUN
   - `5349` **TCP** — TURN sobre TLS (`turns:`), opcional pero muy útil en redes
     que solo dejan salir 443/TLS
   - **Rango UDP de relay**: `49152–65535` (es por donde pasa la media relayeada)
3. **Credenciales** (usuario/clave fijos, o secreto compartido para credenciales
   temporales).
4. **(Opcional, para `turns:`)** un dominio apuntando al Pi + certificado
   Let's Encrypt.

⚠️ **Ojo con el ancho de banda:** el TURN **reenvía media**. Si una llamada cae a
relay, el audio de esos peers pasa por la subida del Pi. Para un grupo chico está
bien; tenerlo en cuenta.

## Camino A — coturn en el Pi (recomendado)

```bash
sudo apt update && sudo apt install coturn
```

Habilitar el servicio:
```bash
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

`/etc/turnserver.conf` (mínimo funcional):
```conf
listening-port=3478
tls-listening-port=5349

# Rango de relay (abrir en el router y en ufw)
min-port=49152
max-port=65535

fingerprint
lt-cred-mech
realm=jdh-speak

# Credencial fija. Generar una larga: openssl rand -hex 24
user=jdhturn:PONER_UNA_CLAVE_LARGA

# El Pi está detrás del router: mapear IP pública -> IP local del Pi.
# Si la IP pública es dinámica, ver la nota de DDNS abajo.
external-ip=IP_PUBLICA/IP_LOCAL_DEL_PI

# Higiene / seguridad
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1
# Evitar que el TURN sea usado para tocar la red interna:
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

Firewall del Pi:
```bash
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp
```
Y **reenviar esos mismos puertos** en el router hacia la IP local del Pi.

Arrancar:
```bash
sudo systemctl enable --now coturn
sudo systemctl status coturn
```

**TLS (`turns:`, opcional):** con un dominio apuntando al Pi, sacar el cert con
certbot y agregar a `turnserver.conf`:
```conf
cert=/etc/letsencrypt/live/TU_DOMINIO/fullchain.pem
pkey=/etc/letsencrypt/live/TU_DOMINIO/privkey.pem
```
(coturn necesita poder leerlos: revisar permisos / grupo `turnserver`.)

**IP dinámica:** si el ISP la cambia, `external-ip` queda viejo. Opciones: DDNS
(duckdns/no-ip) + un hook que reescriba `external-ip` y recargue coturn, o IP fija.

## Camino B — TURN administrado (si no se quiere self-host)

Evita puertos/CGNAT/IP dinámica por completo. Dan `urls` + `username` +
`credential` y listo:
- **Cloudflare Realtime TURN** (tier gratis generoso)
- **Metered**, **Twilio**, **Xirsys** (tiers gratis chicos)

## Enchufarlo en JDH Speak (cambio de código necesario)

Hoy `ICE_SERVERS` está **hardcodeado en el cliente**, así que cambiar de TURN
obliga a recompilar. **Hacerlo configurable por entorno**, igual que ya se hace
con `INSTANCE_NAME`:

1. **`server/src/index.ts`** — leer del entorno (p. ej. `TURN_URLS` separadas por
   coma, `TURN_USERNAME`, `TURN_CREDENTIAL`) e inyectarlas en el mismo global que
   ya se inyecta al servir el `index.html`:
   ```js
   window.__JDH_SPEAK_CONFIG__ = { instanceName, iceServers: [...] }
   ```
   (buscar `__JDH_SPEAK_CONFIG__` en ese archivo — el patrón ya está hecho).
2. **Cliente** — leer `iceServers` de ese global (junto a `getInstanceName()` en
   `client/src/lib/branding.ts`, o un `lib/ice.ts` nuevo) y usarlo en
   `useMediasoup.ts` en vez del `const ICE_SERVERS` hardcodeado.
3. **Fallback:** si no hay env, dejar solo STUN público
   (`stun:stun.l.google.com:19302`) — nunca volver a hardcodear el TURN ajeno.
4. **Credenciales fuera del repo:** van en el `.env` del despliegue
   (`/home/pi/jdh-speak/.env` o donde esté), nunca commiteadas.

Ventaja: cambiar TURN/credenciales = editar `.env` + reiniciar el server. **Sin
rebuild del cliente** (se inyecta al servir la página).

## Probar que funciona

1. **Directo al coturn:**
   ```bash
   turnutils_uclient -v -t -u jdhturn -w LA_CLAVE TU_DOMINIO_O_IP
   ```
2. **Desde el navegador:** abrir la página de Trickle ICE
   (`webrtc.github.io/samples/src/content/peerconnection/trickle-ice/`), cargar
   `turn:TU_HOST:3478` + usuario/clave y comprobar que aparecen candidatos de
   tipo **`relay`**. Si solo salen `host`/`srflx`, el TURN no está siendo
   alcanzado (revisar puertos/`external-ip`).
3. **En la app:** entrar de a 2 (modo P2P) desde una red móvil restrictiva y
   verificar que el audio conecta.

## Resumen para el que lo haga

- [ ] Confirmar puertos abiertos (3478 udp/tcp, 5349 tcp, 49152–65535 udp)
- [ ] Instalar + configurar coturn en el Pi (`external-ip` con el mapeo correcto)
- [ ] (Opcional) dominio + cert para `turns:`
- [ ] Hacer `ICE_SERVERS` configurable por env (server inyecta → cliente lee)
- [ ] Poner las credenciales en el `.env` del despliegue (no en el repo)
- [ ] Verificar candidatos `relay` con Trickle ICE
- [ ] Sacar `turn.oriolgomez.com` del código
