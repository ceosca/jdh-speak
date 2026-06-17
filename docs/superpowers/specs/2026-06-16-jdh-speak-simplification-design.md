# Design: Simplificar SonicRoom → "JDH Speak"

**Fecha:** 2026-06-16
**Estado:** Aprobado (pendiente revisión del spec por el usuario)

## Contexto

El proyecto SonicRoom se va a adaptar a un uso más simple y se rebautiza como
**JDH Speak**. El dueño quiere quitar la complejidad que no necesita: la calidad
de voz opcional, las opciones extra de la pantalla de entrada, el crédito al
proyecto original, y todo el sistema de salas públicas + moderación colectiva.
El resultado: una app de voz directa donde entras con sala + nombre y hablas en
la mejor calidad disponible, sin opciones intermedias.

Decisiones de alcance ya tomadas con el usuario:

- Voz: **siempre estéreo 128 kbps** (el "Hi-fi" actual). Sin opt-in. Se podrá
  subir a 256k en el futuro.
- Lobby: **solo** campo de sala + campo de nombre + botón. Nada más.
- Moderación: **eliminación a fondo** (no solo ocultar UI) de salas públicas,
  knock-to-join y vote-to-kick, en server y cliente.

## Cambio 1 — Audio siempre HD (eliminar mono / opt-in hi-fi)

La app define "más calidad" como Hi-fi = estéreo ~128 kbps. Pasa a ser fijo.

- `client/src/lib/sdp-munger.ts` — `forceOpusParams`: quitar el parámetro `hifi`;
  fijar siempre `stereo=1`, `sprop-stereo=1`, `maxaveragebitrate=128000`. Resto de
  params low-latency sin cambios.
- `client/src/lib/microphone.ts` — `microphoneConstraints`: quitar el parámetro
  `hifiVoice`; fijar siempre `channelCount: 2`.
- `client/src/hooks/useMediasoup.ts` — la producción de **voz** SFU (~líneas
  908–916) pasa a `opusStereo: true` + `opusMaxAverageBitrate: 128000` fijo;
  los call-sites que pasaban `hifiVoiceEnabled` a `forceOpusParams` /
  `microphoneConstraints` dejan de pasarlo (líneas ~482, 520, 587, 995, 1459).
- `client/src/components/MicPreview.tsx` — quitar el arg `hifiVoiceEnabled`
  (~línea 116).
- `client/src/components/DeviceSettings.tsx` — eliminar el toggle "Hi-fi voice"
  (~líneas 132–149) y sus refs (`hifiVoiceId`, selectores del store).
- `client/src/stores/room.ts` — eliminar `hifiVoiceEnabled`, `setHifiVoiceEnabled`,
  `loadHifiVoice`, `HIFI_VOICE_KEY`, y su entrada en `reset`/estado inicial.
- i18n: eliminar `settings_hifi_voice_label` y `settings_hifi_voice_hint` de
  `client/messages/{en,es,fr}.json` (Paraglide regenera).

**No tocar:** los productores caster/share/file ya van estéreo con techo 256k; el
techo `maxaveragebitrate: 256000` del router en `server/src/mediasoup-config.ts`
se mantiene (es ceiling, no baja la voz).

## Cambio 2 — Lobby solo con sala + nombre

`client/src/components/Lobby.tsx` queda: encabezado (nombre de instancia),
tagline, input **sala**, input **nombre**, mensaje de error, botón entrar.

Eliminar:

- Los 3 checkboxes: desactivar P2P, hacer pública, entrar sin micro (+ estados
  `disableP2p`, `makePublic`, `joinWithoutMic` y los helpers `isP2pDisabled`,
  `isPublicEnabled`, `isMicDisabled`).
- El listbox de salas públicas y todo su soporte: `publicRooms`, polling
  (`PUBLIC_ROOMS_POLL_MS`, fetch a `/api/public-rooms`), `activeRoomIdx`,
  `selectPublicRoom`, `onRoomListKeyDown`, refs, y la región SR de selección.
- `<LanguageSelect />` y `<MicPreview />`.
- En `handleJoin`: dejar de añadir `?p2p=off`, `?public=true`, `?mic=off` a la URL
  de la sala (solo navega a `/room/<sala>`).
- Imports sin uso (`Globe`, `DoorOpen`, `MicPreview`, `LanguageSelect`,
  `getLocale`, `Footer`).

El idioma se detecta del navegador; `?lang=` y `?displayName=` por URL siguen
operativos. El fallback "sin micro" cuando el permiso se deniega **se conserva**
en `Room` (solo desaparece el checkbox explícito del lobby).

## Cambio 3 — Quitar "Powered by SonicRoom"

- `client/src/components/Footer.tsx` — eliminar el archivo (`PoweredBy` + `Footer`).
- `client/src/components/Lobby.tsx` — quitar `<Footer />`.
- `client/src/components/Room.tsx` — quitar imports y usos de `Footer`/`PoweredBy`
  (pantallas connecting/error y el footer de controles de la sala). El `<footer>`
  landmark de controles se mantiene, sin el crédito.
- i18n: eliminar `footer_powered_by` de `client/messages/{en,es,fr}.json`.

## Cambio 4 — Eliminar moderación a fondo

### Server

- `server/src/room-manager.ts` — quitar de `Room`: `isPublic`, `pendingJoins`,
  `admittedTokens`, `admittedNames`, `bannedIps`, `kickVotes` (y su init en
  `getOrCreateRoom`); quitar `ip` de `Peer` y de `createPeer`; eliminar
  `getPublicRooms`.
- `server/src/signaling.ts` — eliminar:
  - `joinSchema.isPublic` y `joinToken`.
  - Toda la lógica de knock en `join` (`wasPublic`, `alreadyAdmitted`, gate de
    `pendingJoins`, respuesta `status:"pending"`, `broadcastJoinRequests`, los
    emits `room-public`, los `notify*`), e `isPublic`/`kickVotes` de la respuesta
    del join.
  - Handler `join-decision`.
  - Vote-to-kick completo: handler `vote-kick`, `votablePeerCount`,
    `cleanupKickVotes`, `kickPeer`, `settleKicks`, `kickLimiter`,
    import de `kickThreshold`, y emisiones `peer-kicked`/`you-were-kicked`.
  - En `teardownPeer`: el bloque de `cleanupKickVotes` y el manejo de
    `pendingJoins` al vaciarse la sala.
  - En `disconnect`: `pendingRequest`, `kickLimiter.forget`, `settleKicks`.
  - `clientIp` queda sin uso → eliminar (la `ip` ya no se almacena).
- `server/src/index.ts` — eliminar la ruta `GET /api/public-rooms` y el import
  `getPublicRooms`.
- Borrar `server/src/kick-util.ts` y `server/src/kick-util.test.ts`.
- Borrar `server/src/notify.ts`; limpiar `NOTY_*` de `.env.example`.

### Cliente

- `client/src/stores/room.ts` — eliminar: tipo `JoinRequest`; campos
  `joinRequests`, `awaitingApproval`, `roomIsPublic`, `kicked`; `PeerState.kickVotes`
  e `iVotedKick`; acciones `setJoinRequests`, `setAwaitingApproval`,
  `setRoomIsPublic`, `setKicked`, `setPeerKickVote`; init en `addPeer`/`reset`.
- `client/src/hooks/useMediasoup.ts` — eliminar handlers `join-requests`,
  `join-approved`, `join-denied`, `room-public`, `kick-vote`, `peer-kicked`,
  `you-were-kicked`; el envío de `isPublic`/`joinToken` en `join`; el camino
  `status:"pending"`; el emit `vote-kick`; uso de `joinToken` en sessionStorage.
- `client/src/components/Room.tsx` — eliminar el modal `JoinRequests`, la pantalla
  "esperando aprobación" (`awaitingApproval`), la pantalla "te expulsaron"
  (`kicked`) y el cue de knock.
- Borrar `client/src/components/JoinRequests.tsx`.
- `client/src/components/ParticipantCard.tsx` — eliminar el botón de votar
  (`aria-pressed`/`aria-selected`, tally en el nombre accesible) y props
  asociadas.
- `client/src/lib/sounds.ts` — eliminar el cue de knock (y sus usos).
- i18n: eliminar todas las claves de knock / kick / salas públicas de
  `client/messages/{en,es,fr}.json`.

**Se conserva** `?p2p=off` / `disableP2p` en el server (no es moderación; sigue
útil por URL). Solo desaparece su checkbox del lobby.

## Renombrar a "JDH Speak"

- `client/src/lib/branding.ts` — `DEFAULT_INSTANCE_NAME = "JDH Speak"`.
- `server/src/index.ts` — default de `INSTANCE_NAME` → `"JDH Speak"`.
- Se mantiene el mecanismo de override por `INSTANCE_NAME` en `.env`.

## Verificación (end-to-end)

1. Typecheck limpio: `corepack pnpm --filter client exec tsc --noEmit` y
   `corepack pnpm --filter server exec tsc --noEmit`.
2. Tests del server: `corepack pnpm --filter server test` (sin el de kick-util,
   ya borrado; el resto en verde).
3. Lint: `corepack pnpm lint` (sin imports/vars sin usar tras las eliminaciones).
4. Arrancar (`start.bat` o los dos comandos) y en `http://localhost:5173`:
   - El lobby muestra **solo** sala + nombre + botón, con título "JDH Speak" y sin
     footer "Powered by".
   - Entrar a una sala con dos pestañas: se escuchan (P2P ≤2, SFU 3+).
   - En `chrome://webrtc-internals` (o el SDP), confirmar voz **estéreo** y
     `maxaveragebitrate=128000`.
   - No aparece ninguna UI de "hacer pública", knock, ni votar para expulsar.
   - La pestaña del navegador muestra "JDH Speak".

## Fuera de alcance

- Subir la voz a 256 kbps (futuro).
- Eliminar `?p2p=off` / `disableP2p`.
- Tocar grabación, streaming Icecast, audio sources, ducking o chat.
