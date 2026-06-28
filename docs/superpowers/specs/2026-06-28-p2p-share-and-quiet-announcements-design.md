# Design: Compartir/Emitir sin forzar SFU + anuncios mínimos

**Fecha:** 2026-06-28
**Estado:** Aprobado (pendiente de plan de implementación)

## Contexto

Dos cambios de comportamiento pedidos por el dueño:

1. **Compartir audio** y **Emitir audio (reproductor)** no deben **forzar el SFU**. Hoy
   cada uno produce una pista/productor estéreo separado, que solo puede enrutarse en
   SFU — así que al compartir/emitir en P2P la sala salta a SFU (con su corte y mayor
   latencia). El dueño quiere quedarse en P2P al compartir/emitir.
2. **Anuncios mínimos:** que la app deje de hablar casi todo. Solo deben anunciarse
   **grabación** (inicio/fin) y **mensajes de chat**. Todo lo demás se silencia.

**Decisiones tomadas:**
- Umbral P2P/SFU: **sin cambios** (P2P hasta 5, SFU a partir de 6 — `decideMode`).
- Alcance del cambio 1: **compartir Y emitir**, ambos.
- El **caster externo (Ecobox)** sigue forzando SFU (es solo-envío, no hace P2P) y la
  **grabación** sigue forzando SFU (el servidor debe ver la media). `?p2p=off` también.

## Parte A — Compartir y Emitir se mezclan en la voz (sin forzar SFU)

**Idea:** ambos se mezclan en la pista de salida única `outDest` (la de voz), igual que
ya hace la placa de transmisión secundaria. Como no crean un productor aparte, viajan en
la pista de voz tanto en P2P como en SFU, y nunca obligan al SFU.

### Cliente (`client/src/hooks/useMediasoup.ts`)
- **Compartir:** enrutar `displaySource → shareDuckGain → outDest` (en vez de
  `shareDest` → productor "share"). Eliminar `produceShare`, `musicProducerRef`, y la
  llamada `emit("start-share")` / `emit("stop-share")`. Mantener el nodo de atenuado.
- **Emitir (reproductor de 2 slots):** la salida del motor pasa a `outDest`. Hoy es
  `slots → xfadeGain → fileVolumeGain → fileDuckGain → fileDest → productor "file"`;
  pasa a `… → fileDuckGain → outDest`. Eliminar `produceFile`, `fileProducerRef`,
  `fileDest`, y `emit("start-file-stream")` / `emit("stop-file-stream")`. **El
  reproductor conserva TODAS sus funciones** (crossfade, volumen-para-todos, velocidad,
  lista, reanudar, atajos) — solo cambia el destino final. Mantener el monitor local
  (`source.connect(sharedAudioContext.destination)`) para que el emisor se oiga.
- **Muteo:** generalizar la condición que hoy mira `secondaryActive` para que también
  cubra compartir/emitir activos: si `outDest` lleva audio que no es el micro (placa
  secundaria, compartir o emitir), el muteo **solo silencia el micro** (no pausa el
  productor) y usa `set-mute-state` para avisar a los demás. Sugerido: un helper
  `outDestHasExtraAudio()` que devuelva true si hay secundaria, compartir o emitir
  activos.
- **Lado receptor:** las ramas de `consume` para `source === "share"` y
  `source === "file"` quedan muertas (los navegadores ya no producen esas pistas) —
  limpiarlas. La rama `source === "music"` (caster) **se mantiene** (con su ficha).

### Servidor (`server/src/signaling.ts`, `server/src/room-manager.ts`)
- `shouldForceSfu`: dejar de contar `room.sharers` y `room.fileStreamers`. Mantener
  `casters`, `disableP2p`, y la grabación.
- Eliminar los handlers `start-share` / `stop-share` / `start-file-stream` /
  `stop-file-stream` y los sets `sharers` / `fileStreamers` del `Room` (y su limpieza en
  `teardownPeer` y en `join`). El `joinSchema.sharing` / `fileStreaming` (re-pin en
  reconexión) ya no aplica — quitarlos.

### Implicaciones (aceptadas)
- Compartir/emitir van a **estéreo 128k** (calidad de la voz), no 256k, y **sin ficha
  aparte** para los demás (lo oyen dentro de tu audio).
- Las **grabaciones** capturan voz+compartido+emitido **mezclados en la pista de voz**
  del emisor (ya no como pistas separadas "share"/"file"). El caster sigue como pista
  aparte.
- **Atenuado automático:** al ir compartir/emitir DENTRO de la voz, el auto-ducking ya
  **no aplica** a ellos: el detector de voz del servidor observa los productores de voz
  y no puede separar la música mezclada (y en P2P no hay observador). El **caster
  Ecobox** sí mantiene su atenuado (sigue siendo productor separado). Para compartir/
  emitir, el control es el **volumen manual "para todos"** del reproductor. (Se pueden
  retirar los nodos `shareDuckGain`/`fileDuckGain` de la rama mezclada, o dejarlos
  inertes a ganancia 1 — el plan lo define.)

## Parte B — Anuncios mínimos

**Regla:** solo se anuncian **grabación (inicio/fin)** y **mensajes de chat**. Se
silencia **todo lo demás**: mute/desmute, compartir (inicio/fin), entrar/salir
(peer join/leave), "ahora suena" (now-playing), y cualquier otro anuncio de evento
(atenuado on/off, procesamiento de voz on/off, etc.).

- Implementación: quitar (o convertir en no-op) las llamadas `announceEvent(...)` /
  `announce(...)` de los eventos silenciados, en `client/src/hooks/useMediasoup.ts`
  (mute/share/file/join/leave/now-playing/ducking/voice-processing) y donde
  correspondan (p. ej. peer join/leave en `Room.tsx` / el store).
- **Conservar** los anuncios de **grabación** (start/stop) y el camino de **mensajes de
  chat** (`announceChat`, según `chatAnnounceMode`).
- Las **cues de sonido** (chimes) no son anuncios hablados: se mantienen salvo que el
  dueño pida lo contrario (fuera de alcance).

## Verificación (end-to-end)

- `tsc --noEmit` (client + server), `lint`, `corepack pnpm --filter server test` (4
  fallos preexistentes de Windows), `corepack pnpm --filter client build` → limpios.
- En la app:
  - En P2P (≤5), pulsar **Compartir audio** → la sala **sigue en P2P** (no salta a SFU) y
    el otro peer oye el audio compartido dentro de tu voz.
  - **Emitir** un archivo en P2P → igual, sin SFU; el reproductor funciona completo.
  - **Mutear** mientras compartes/emites → el otro deja de oír tu micro pero **sigue
    oyendo** lo compartido/emitido; te ve muteado.
  - El caster Ecobox sigue forzando SFU y con su ficha.
  - Anuncios: solo se hablan grabación y chat; mute/compartir/entrar-salir/"ahora suena"
    quedan en silencio.

## Fuera de alcance
- Cambiar el umbral P2P/SFU.
- Multi-track P2P de alta calidad (la opción de "pistas separadas" se descartó).
- Tocar las cues de sonido (chimes).
