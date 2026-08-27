# JDH Speak — cliente nativo de jam (romper el piso de WASAPI)

Cliente **headless** en Python que toca en la MISMA sala de jam que la malla del
navegador, pero haciendo el audio **fuera del navegador** para bajar la latencia por
debajo del piso de WASAPI-shared de Chrome/Edge.

Se conecta al relay WebTransport `/jam` (el mismo que usa la malla del navegador), así
que un músico nativo (p.ej. Cristian con su interfaz) toca junto a peers del navegador
(Edu/Franco), y los espectadores web siguen escuchando a todos por el relay.

## Por qué existe — el piso de WASAPI, MEDIDO

Chrome/Edge reproduce por **WASAPI shared mode**, y en placas USB eso no se puede bajar
desde el navegador (es un borde del sandbox: el JS entrega PCM y Chrome elige el backend).
Medido en la máquina de Cristian (Focusrite USB + Realtek), con PortAudio (pip):

| Camino | Latencia de salida | Notas |
|---|---|---|
| Navegador (Chrome, WASAPI shared) | ~23 ms | lo que teníamos |
| Nativo WASAPI **exclusive** (Focusrite) | ~34 ms | **no ayuda** — el driver USB fija el buffer |
| Nativo **WDM-KS** (kernel streaming) | **~10 ms** | por debajo del motor de audio; pip, sin ASIO |
| Nativo **ASIO** (Focusrite) | ~3–5 ms | el máximo; necesita un build con el SDK de ASIO |

Conclusión: **WASAPI (shared o exclusive) no se puede vencer en la Focusrite desde
espacio de usuario** — pero **WDM-KS sí baja a ~10 ms** (–13 ms vs navegador) y **ASIO
llega a ~3–5 ms**. Este cliente usa el camino de menor latencia que expone el dispositivo
elegido (prefiere WDM-KS, luego WASAPI).

También medido: Opus a **2.5 ms** por frame en Python (PyAV, 1 paquete por frame, ~22 B),
y el **round-trip real por el relay** desde el cliente nativo = **~1–2.5 ms** (LAN).

## Requisitos

- Python 3.10+ (probado en 3.12).
- `pip install -r requirements.txt` (sounddevice/PortAudio, numpy, PyAV, aioquic).
- El relay `WT_PROBE` arriba en la Pi (lo está: udp/40059).

## Uso

```bash
python jam_native.py --list                 # lista dispositivos + host APIs
python jam_native.py --room test            # entra a la sala "test" con el device de menor latencia
python jam_native.py --room test --in 23 --out 18   # elegir device (índices de --list)
python jam_native.py --room test --cushion 15       # colchón de jitter (ms)
python jam_native.py --room test --test     # sin audio: capture sintético + mide RTT del relay
```

Elegí tu interfaz (Focusrite) como `--in`/`--out` para el menor buffer. Con **la misma
placa** en entrada y salida, el full-duplex WDM-KS/exclusive es estable (medido, 0 xruns).

## Estado

- ✅ Audio de baja latencia (WDM-KS ~10 ms, medido).
- ✅ Opus 2.5 ms (PyAV), encode/decode por frame en tiempo real.
- ✅ Cliente WebTransport (aioquic) que entra a la sala `/jam`, habla el protocolo exacto
  de la malla (`[0x01][idLen][appId][ch][seq][sendTime][opus]`), envía y recibe el
  fan-out del relay. Verificado punta a punta (sent≈recv, RTT ~1–2.5 ms).
- ✅ El navegador ahora **no silencia** a un peer nativo (los `appId` desconocidos suenan
  a ganancia 1 en la malla; deafen sigue mandando).

## Lo que falta para producto (siguiente etapa — la GUI)

- **Señalización**: el cliente nativo entra al relay directo; todavía no aparece en la
  lista de participantes ni manda su nombre (appId) para volumen por-peer. Falta unirlo
  al socket.io/SFU para que aparezca como "vos" en la sala (es la GUI planeada).
- **Jitter buffer**: v1 usa un ring simple (prebuffer al colchón + descarte por
  overrun). Falta portar la compensación de drift por resampling del navegador.
- **ASIO**: para bajar la Focusrite a ~3–5 ms hay que construir PortAudio/otra lib con el
  SDK de ASIO (licencia Steinberg). WDM-KS ya da ~10 ms sin eso.
- **Estéreo**: v1 es mono; el protocolo ya lleva el byte de canales para extender.
