# Probe: WebTransport + WebCodecs para jam (DESECHABLE)

> **Nivel 1 de la evaluación de factibilidad.** Su única salida es **un número
> con el que decidir**, no código para quedarse. Si gana claramente, se diseña
> el Nivel 2 aparte; si no, se descarta esta carpeta. **No** está en el workspace
> pnpm, **no** lo arranca systemd, **no** toca mediasoup, grabación ni streaming.

## Qué mide

Reproduce el **monitoreo de red** (oír tu propio retorno por el servidor) pero
por un camino totalmente distinto:

```
mic → AudioWorklet → AudioEncoder(Opus 10ms, lowdelay) → datagrama WebTransport
      → relay QUIC en la Pi (eco) → datagrama de vuelta
      → AudioDecoder → ring buffer propio (sin NetEQ) → altavoz
```

Frente a lo actual (WebRTC/mediasoup + NetEQ). La pregunta que responde:
**¿el transporte QUIC + nuestro propio buffer mínimo da menos latencia que lo que
ya tenemos, que ya está muy exprimido?**

Números en la página:

- **RTT de red (mediana/mín/p95):** ida y vuelta de un datagrama de ping.
  Comparable con lo que muestra **Ctrl+Alt+L** ("al servidor") en la app real.
- **Colchón de retorno (ms):** cuánto audio tenemos en nuestro ring buffer. Es el
  cojín que sustituye a NetEQ; cuanto más bajo sin cortes, mejor.
- **Cortes (underflows):** veces que el buffer se quedó seco (colchón demasiado
  bajo para el jitter real).
- **Latencia estimada del monitor:** `RTT/2 + 10ms (trama) + colchón`. Es lo que
  de verdad oyes de retraso en tu propio retorno.

## Cómo correrlo

### 1. Relay en la Pi

```bash
ssh pi@192.168.4.2
cd /home/pi/jdh-speak/experiments/webtransport-jam
bash run-on-pi.sh
```

La primera vez compila el módulo nativo HTTP/3 (unos minutos en la Pi). Deja la
terminal abierta; imprime `echo probe up`.

### 2. Puerto (solo para prueba entre redes distintas)

- **En la misma LAN / desde la propia Pi:** no hace falta tocar el router.
- **Con alguien en otra red:** reenvía **UDP 4433 → 192.168.4.2** en el router
  (igual que el rango 40000–40100 de mediasoup). Es el puerto de la prueba, no
  pisa nada.

### 3. Página probe

Está servida por la app (contexto seguro HTTPS, cert válido):

```
https://jdh.privatedns.org/webtransport-jam-probe/probe.html
```

> Solo existe en la rama `feat/webtransport-jam`. Para verla, en la Pi hay que
> estar en esa rama y haber hecho `pnpm --filter client build`.

Abre esa URL, **ponte auriculares**, pulsa **Empezar**, habla/toca y:

1. Oirás tu propio retorno por QUIC.
2. Compara la **latencia estimada del monitor** con la del monitoreo de red
   actual (activa la casilla en la app, Ctrl+Alt+L, y anota).

Navegadores: Chrome/Edge, Firefox 130+ (escritorio), o Safari 26.4+.

## Cómo leer el resultado

- Si el **monitor estimado** aquí es **claramente menor** que en la app actual
  (varios ms, de forma repetible) → vale la pena el Nivel 2.
- Si **empatan** → el transporte no es el cuello de botella; el trabajo ya hecho
  (captura latency:0, ptime=10, jitter 0, FEC off) ya alcanzó el suelo práctico.
  Se descarta la migración. **Ese también es un resultado bueno**: ahorra meses.

## Limpieza

Es una rama aislada. Si se descarta: `git branch -D feat/webtransport-jam` y
borra esta carpeta. No queda nada colgado en la app ni en systemd. El cert
copiado aquí (`*.crt`/`*.key`) está en `.gitignore`; no se versiona.
