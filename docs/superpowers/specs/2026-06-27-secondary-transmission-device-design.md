# Design: Placa de transmisión secundaria

**Fecha:** 2026-06-27
**Estado:** Aprobado (pendiente de plan de implementación)
**Feature:** 1 de 2 (la otra es el reproductor de conferencia — spec aparte).

## Contexto

El usuario quiere transmitir **dos fuentes de audio a la vez** desde el navegador:
su micrófono principal ("placa titular") más una **fuente secundaria** elegida de
sus dispositivos de **grabación** — otro micro, o el loopback de otra placa (Stereo
Mix / cable virtual) para pasar música mejor. El audio secundario va **mezclado en
el mismo stream de voz** (no como pista/ficha aparte). Al **mutear**, se silencia
**solo el micro titular**; la fuente secundaria **sigue sonando** para los demás.

Limitación conocida (aceptada): el navegador solo captura dispositivos de **entrada
(grabación)**. Un loopback de altavoces solo aparece si Windows lo expone como
grabación (Stereo Mix activado, o un cable virtual tipo VB-CABLE). La app no puede
crear ese loopback (no hay WASAPI en una página web); lo provee el sistema.

## Arquitectura (grafo de salida)

La app ya tiene un grafo de salida en `client/src/hooks/useMediasoup.ts`
(`outGraphRef`): `mic → micGain → limiter → outDest`, y la pista producida es
siempre la de `outDest`. La secundaria se suma a `outDest` en paralelo.

- **Captura:** `getUserMedia({ audio: { deviceId, channelCount: 2,
  echoCancellation: false, noiseSuppression: false, autoGainControl: false } })`
  para el dispositivo secundario (sin procesamiento de voz, estéreo — la música no
  debe pasar por eco/ruido/AGC).
- **Mezcla:** `secondarySource → secondaryGain → outDest`, **en paralelo** a
  `limiter → outDest`. Esquiva micGain/limiter para conservar la dinámica (igual
  criterio que el audio compartido). `secondaryGain` por defecto a 1.
- **Resultado:** un único productor de voz que lleva micro + secundaria mezclados.
  **No** crea productor nuevo → **no fuerza SFU** (en P2P sigue con 2 peers).
- **Monitor local (opcional):** `secondarySource → sharedAudioContext.destination`
  para que el emisor oiga lo que manda (necesario si la secundaria es un loopback de
  otra placa que no vuelve a sus oídos). Toggle, por defecto **apagado**.

Nuevos campos en `outGraphRef`: `secondarySource: MediaStreamAudioSourceNode | null`,
`secondaryGain: GainNode | null`, `secondaryStream: MediaStream | null`.

## Muteo (ajuste clave)

El muteo actual (`useMediasoup.ts`, función mute ~línea 1620) hace dos cosas:
`micTrack.enabled = false` **y** `producerRef.current.pause()` + `emit("producer-pause")`.

Cambio condicionado a si hay secundaria activa:
- **Sin secundaria:** comportamiento actual (silencia micro + pausa productor; ahorra
  ancho de banda).
- **Con secundaria activa:** muteo silencia **solo el micro** (`micTrack.enabled =
  false`); **no** pausa el productor ni emite `producer-pause`, para que `outDest`
  siga fluyendo con la secundaria. Al desmutear: `micTrack.enabled = true` (y, si el
  productor estaba pausado por un muteo previo sin secundaria, lo reanuda).
- El estado visible de muteo (`setMuted`, evento `peer-muted`) se mantiene igual: los
  demás te ven muteado aunque siga llegando la música — coherente con "en conjunto".

## UI (en Ajustes de audio — `client/src/components/DeviceSettings.tsx`)

- Casilla **"Activar placa de transmisión secundaria"**. Al activarla aparece:
  - Desplegable de **dispositivos de grabación** (reusa la lista `audioinput` que ya
    arma `DeviceSettings` con `enumerateDevices`).
  - Casilla **"Escuchar tu placa secundaria"** (monitor local), por defecto apagada.
- Cambios **en vivo**: activar/elegir dispositivo mid-llamada arranca la captura y la
  mezcla; desactivar la corta y libera el stream.

## Estado y persistencia (store `client/src/stores/room.ts`)

Nuevos, persistidos en localStorage como mic/altavoz:
- `secondaryEnabled: boolean` (default false)
- `secondaryDeviceId: string` (default "")
- `secondaryMonitor: boolean` (default false)
Con sus setters. `useMediasoup` reacciona a los cambios (efecto, como el de
re-adquisición del micro) para adquirir/soltar la secundaria y conectar/desconectar
el monitor en vivo.

## Errores / casos borde

- Dispositivo desconectado o `getUserMedia` falla → esa rama queda en silencio sin
  romper la llamada (log + desactivar el toggle, o reintentar al reconectar el
  dispositivo vía `devicechange`).
- Sin permiso de micro aún → la lista no muestra etiquetas (igual que hoy); el
  toggle queda disponible y aplica cuando haya permiso.
- Reconexión / cambio P2P↔SFU: la secundaria vive en `outGraphRef` (sobrevive al
  cambio, como la voz), así que se mantiene mezclada en `outDest`.

## Verificación (end-to-end)

- `tsc --noEmit` (client) y `lint` limpios.
- En la app: activar la secundaria con un segundo dispositivo de grabación; otro peer
  oye micro + secundaria mezclados. Mutear → el otro peer deja de oír tu voz pero
  **sigue oyendo la secundaria**. Activar monitor → tú oyes la secundaria.
- Confirmar que con secundaria activa NO se fuerza SFU (sigue P2P con 2 peers).

## Fuera de alcance

- Control de **volumen** independiente de la secundaria (capturamos a volumen unidad;
  se puede añadir luego).
