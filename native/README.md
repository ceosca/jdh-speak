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

| Camino (salida) | Latencia | Notas |
|---|---|---|
| Navegador (Chrome, WASAPI shared) | ~23 ms | lo que teníamos |
| Nativo WASAPI (Focusrite / Maono / cualquier USB) | ~22 ms | **no ayuda** — el driver USB fija el buffer |
| Nativo WASAPI **exclusive** (Focusrite) | ~34 ms | peor todavía |
| Nativo **WDM-KS** — USB Advanced | **~10 ms** | kernel streaming; pip, sin ASIO |
| Nativo **WDM-KS** — Realtek SPDIF | **~4 ms** | salida digital S/PDIF |
| Nativo **ASIO** (Focusrite) | ~3–5 ms | el máximo; necesita build con SDK de ASIO |

**Medido en vivo con el cliente completo** (`--in 23 Focusrite --out 35 USB-Advanced`):
captura **22 ms** (Focusrite WASAPI) · **playout 10 ms (WDM-KS)** vs 23 ms del navegador
→ **–13 ms para OÍR a los demás**, con audio real, capturando el micro y mandando al
relay (~400 frames/s), en silencio cuando estás solo.

Conclusión: **WASAPI no se vence en placas USB desde espacio de usuario** (ni exclusive).
Pero **WDM-KS baja la SALIDA a ~10 ms** (o ~4 ms por SPDIF) — el cliente usa streams de
entrada y salida **separados**, así la salida va por un device WDM-KS de baja latencia
aunque el micro siga en la Focusrite. Para bajar la CAPTURA de la Focusrite hace falta
**ASIO** (su driver está instalado — `Focusrite USB ASIO` — pero PortAudio-con-ASIO
necesita compilarse con MSVC, que no está en esta máquina).

También medido: Opus a **2.5 ms** por frame en Python (PyAV, 1 paquete por frame, ~22 B),
y el **round-trip real por el relay** desde el cliente nativo = **~1–2.5 ms** (LAN).

## Requisitos

- Python 3.10+ (probado en 3.12).
- `pip install -r requirements.txt` (sounddevice/PortAudio, numpy, PyAV, aioquic).
- El relay `WT_PROBE` arriba en la Pi (lo está: udp/40059).

## Uso

```bash
python jam_native.py --list                 # lista dispositivos + host APIs (con latencias)
python jam_native.py --room test            # sala "test", devices de menor latencia (auto)
python jam_native.py --room test --in 23 --out 35   # micro Focusrite, salida WDM-KS (índices de --list)
python jam_native.py --room test --cushion 15       # colchón de jitter (ms)
python jam_native.py --room test --test     # sin audio: capture sintético + mide RTT del relay
```

Para la **menor latencia al oír a los demás**, elegí como `--out` un dispositivo que
aparezca como **WDM-KS** en `--list` (p.ej. el "USB Advanced" ~10 ms, o "Realtek SPDIF"
~4 ms). El micro (`--in`) va por tu interfaz (Focusrite). Los streams son separados, así
que pueden ser placas distintas. **Usá el nombre de sala en minúsculas** (el navegador
las pasa a minúsculas). Y con **auriculares** para no realimentar el micro.

Para probar con la banda: Cristian corre esto (audio nativo) y Edu/Franco entran por el
navegador con **Modo ensayo** activado en la MISMA sala. Se escuchan entre sí; el nativo
suena para ellos (el navegador ya no silencia a un peer nativo).

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
