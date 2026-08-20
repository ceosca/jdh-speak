# Probe: WebTransport + WebCodecs para jam (DESECHABLE, integrado en el servidor)

> **Nivel 1 de la evaluación de factibilidad.** Su única salida es **un número
> con el que decidir**, no código para quedarse. Corre **dentro del servidor
> principal** (rama `feat/webtransport-jam`), así que tu operación es solo
> *cambiar de rama + build*, y revertir es *borrar la rama + build de `main`*.
> No abre puertos nuevos, no hay procesos aparte, y es **a prueba de fallos**: si
> el probe no puede arrancar, solo loguea un aviso y el servidor de conferencia
> sigue igual.

## Qué mide

Reproduce el **monitoreo de red** (oír tu propio retorno por el servidor) pero
por un transporte totalmente distinto:

```
mic → AudioWorklet → AudioEncoder(Opus 10ms, FEC off) → datagrama WebTransport(QUIC)
    → eco en el servidor → AudioDecoder → ring buffer propio (sin NetEQ) → auriculares
```

La pregunta: **¿QUIC + nuestro propio buffer mínimo baja la latencia respecto a
lo que ya tenemos (WebRTC/mediasoup + NetEQ), que ya está muy exprimido?**

## Cómo está integrado (sin procesos ni puertos extra)

- **Relay de eco**: `server/src/webtransport-probe.ts`, arrancado desde
  `server/src/index.ts` justo tras `httpServer.listen`. Escucha QUIC en
  **udp/40059**, que se liberó bajando `rtcMaxPort` de mediasoup a **40058**
  (`server/src/mediasoup-config.ts`). 40059 sigue dentro del rango
  **40000–40100 ya reenviado** en el router → **no hay puerto nuevo**.
- **Cert**: el servicio corre como **root**, así que el relay lee directamente el
  cert vivo de Caddy (`jdh.privatedns.org`). Conexión **de confianza**, sin
  `serverCertificateHashes`.
- **Página**: `client/public/webtransport-jam-probe/probe.html` — la sirve la
  app por HTTPS (Caddy 443). Lee la URL del relay desde `GET /api/wt-probe`.
- **Apagar sin revertir**: `WT_PROBE=0` en el entorno del servicio.

## Cómo probarlo

En la Raspberry, poné el despliegue en esta rama y build (como cualquier cambio
de servidor):

```bash
cd /home/pi/jdh-speak
git fetch origin && git checkout feat/webtransport-jam && git pull
pnpm install            # baja el binario QUIC (arm64, glibc 2.36) — pineado a 1.4.0
pnpm --filter client build
sudo systemctl restart jdh-speak
journalctl -u jdh-speak -n 20 --no-pager   # debe verse: [wt-probe] HTTP/3 echo relay on udp/40059
```

Luego, en Chrome/Edge y **con auriculares**:

```
https://jdh.privatedns.org/webtransport-jam-probe/probe.html
```

Pulsá **Empezar**, tocá/hablá, oís tu retorno por QUIC. Compará la **latencia
estimada del monitor** con la del monitoreo de red actual (Ctrl+Alt+L en la app).

> Navegadores: Chrome/Edge, Firefox 130+ (escritorio), o Safari 26.4+.

## Cómo leer el resultado

- **Claramente menor y repetible** que lo actual → vale el Nivel 2 (relay entre
  músicos, no solo eco).
- **Empatan** → el transporte no es el cuello de botella; lo ya hecho (captura
  `latency:0`, `ptime=10`, jitter 0, FEC off) ya tocó el suelo práctico. **Se
  descarta la migración** — y eso ahorra meses. Es un resultado válido.

## Revertir

```bash
cd /home/pi/jdh-speak
git checkout main && pnpm install && pnpm --filter client build
sudo systemctl restart jdh-speak
git branch -D feat/webtransport-jam    # opcional
```

`main` no fue tocado en ningún momento: mediasoup vuelve a 40000–40059, sin la
dependencia QUIC, sin la página, sin el módulo del probe.
