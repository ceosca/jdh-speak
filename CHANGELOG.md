# Registro de cambios (CHANGELOG)

> **Convención (para Cristian y para Claude):** cada vez que hacemos `git push`,
> anotamos acá lo que quedó: **qué** se cambió, **cómo** se hizo y **por qué**.
> Sirve para entender el estado actual sin leer todo el código —
> especialmente si Claude pierde el contexto. Lo más nuevo va arriba. Cada
> entrada lleva el hash del commit.

---

## 2026-09-11

### Video (videollamada opt-in): botón "Cámara" por usuario, por defecto apagado

Nueva función: quien quiera puede encender su cámara y hacer videollamada; quien no la
pulse sigue en solo audio. La cámara arranca SIEMPRE apagada (no se persiste) y solo se
enciende con el botón, deliberadamente.

**Decisión de arquitectura:** el video va SIEMPRE por el SFU. Encender una cámara **fuerza
la sala al SFU** (como ya hacen grabación/caster/`?p2p=off`/Ctrl+Alt+S), así se reusa el
camino probado de producir/consumir del servidor y se evita reconstruir la renegociación
P2P en caliente (que no existe en este código y sería frágil). La pista de video es
SEPARADA de la de audio (nunca se mezcla en `outDest`), así mutear el micro no toca el
video y viceversa.

- **Servidor:** codecs de video en el router (VP8 + H264 constrained-baseline, para cubrir
  Chrome/Firefox/Android y Safari/iOS) — `mediasoup-config.ts`. Nuevo `set-camera {on}` que
  marca `peer.camera`, fuerza/relaja el SFU (`shouldForceSfu`), avisa a la sala
  (`peer-camera`) y, al apagar, cierra el producer de video del peer. `produce` acepta
  `source:"camera"`. `signaling.ts` + `room-manager.ts`.
- **Cliente:** `toggleCamera` (adquiere la cámara dentro del click — Safari/iOS necesita el
  gesto —, emite `set-camera`, produce el video en el SFU vía `ensureVideoProducer`, que se
  reejecuta en cada (re)armado de SFU para sobrevivir reconexión/cambio de modo).
  `consumeProducer` ramifica por `kind`: el video se envuelve en un `MediaStream` por peer y
  va al store, no al grafo de audio. Self-view local + `<video>` por peer en
  `ParticipantCard` (self espejado). Botón "Cámara" con `aria-pressed` en `AudioControls`.
- **Accesibilidad:** el `<video>` es `aria-hidden` (visual); el estado se transmite por
  texto (", cámara encendida" junto al nombre) y por anuncios al lector de pantalla
  ("X encendió/apagó su cámara", "Encendiste tu cámara") vía `announceEvent`. Claves i18n
  `controls_camera*`, `event_camera_*`, `card_camera_on`, `camera_error`.

## 2026-09-09

### ✅ RESUELTO y CONFIRMADO — iPhone: el problema era el bundle viejo cacheado

Confirmado con datos del propio iPhone de Cristian (iOS 18.7 / Safari 26.6, capturado por
un diagnóstico temporal ya retirado): con el código nuevo el `probe` da `probe-ok`, permiso
`granted`, detecta los dos micros (EarPods + iPhone) y entra **con micro y sin botón**.

**El bloqueante real era la caché** (ver la entrada del `Cache-Control` más abajo): Safari
servía un `index.html` viejo que apuntaba al bundle anterior (botón incondicional + `exact`
del micro), así que **ninguno de los fixes llegaba** ("me sigue todo exactamente igual").
Al cargar el bundle nuevo (pestaña privada / tras el header `no-cache`), los dos arreglos
de abajo (`ideal` para el micro + auto-detección sin botón) funcionan. Quedó andando.

Se retiró el diagnóstico temporal (`POST /api/client-diag` + el reporte del cliente) una vez
leído el dato real.

### iPhone: no fijar (`exact`) el micro guardado en el join — usar `ideal` (la causa real del botón)

El intento anterior no alcanzó. Causa real (dicha por Cristian, no supuesta): su
`micDeviceId` guardado apunta al **último micro que usó y que ahora NO está conectado**.
La captura inicial pedía ese id con `deviceId: { exact }`, que sobre un dispositivo
desconectado **falla o se cuelga** en iOS — el probe se agotaba (6s) y por eso SIEMPRE
aparecía el botón "Entrar", y como nunca se capturaba nada, iOS tampoco poblaba la lista
de micrófonos (solo "por defecto").

Fix (solo cliente): la captura **inicial** (join + probe de Apple) ahora pide el micro
guardado como **preferencia** (`deviceId: { ideal }`), no fijado (`exact`). Un micro
guardado que no está conectado ya no falla: el navegador cae al micrófono por defecto.
Con el permiso en "Permitir", esa captura limpia funciona sin gesto → entra con micro y
**sin botón** (igual que le pasó a la amiga con iOS). El `exact` se mantiene SOLO para
cuando se elige un micro a propósito en Ajustes (ahí sí debe forzar el cambio).
`microphoneConstraints`/`getMicrophoneStream` reciben `pinDevice` (default true; el join
lo pasa false). Al capturarse el default, la lista de micrófonos en Ajustes se puebla.



Seguimiento del gate de abajo. En iPhone con el permiso de micrófono en "Permitir" no se
detectaba **ningún** micrófono y, además, no se quería tener que pulsar "Entrar".

Dos causas y dos arreglos (solo cliente, sin restart):
1. **`micDeviceId` guardado obsoleto** (`client/src/lib/microphone.ts`): iOS rota los ids de
   dispositivo entre sesiones, así que un micro elegido antes deja de existir; con
   `deviceId:{exact}` eso fallaba. El reintento al micro por defecto solo cubría
   `OverconstrainedError`; Safari a veces devuelve `NotFoundError` → te quedabas SIN micro
   pese a haber uno por defecto. Ahora reintenta el default ante cualquier error de
   selección de dispositivo (Overconstrained/NotFound/NotReadable); se re-lanzan los de
   permiso (NotAllowed/Security).
2. **El botón era incondicional en Apple** (`client/src/components/Room.tsx`): ahora, en
   Apple, primero se **auto-detecta el micro sin tap** (`tryAppleAutoJoin`, con timeout de
   6s). En iOS/macOS moderno, con permiso "Allow", `getUserMedia` funciona sin gesto → se
   entra directo **con micro y sin botón**. Solo si eso falla (iOS que aún exige gesto, o
   permiso no concedido) se cae al gate "Entrar" como respaldo. `join` acepta un
   `preStream` para reutilizar el micro del probe y no pedirlo dos veces. `?mic=off` y los
   navegadores no-Apple quedan igual que antes.

**Verificado** por un agente (constraints probe↔join idénticas, sin doble getUserMedia, sin
loop de efecto, sin fuga de micro tras cerrar el caso late-resolve, cero regresión no-Apple,
typecheck limpio, servidor intacto). **Pendiente de confirmar en un iPhone real** que ya
toma el micro sin botón — no hay Safari en la máquina de desarrollo.

### Safari/Apple: el micrófono ya no cae en "solo texto" (faltaba el gesto de usuario)

**Síntoma:** en Safari (iPhone iOS y macOS) se entraba y NO aparecía el prompt de
micrófono (aún con Safari en "preguntar"), cayendo a modo "solo texto/chat".

**Causa (confirmada con agentes, sin especular):** WebKit solo muestra el prompt de
`getUserMedia()` si la llamada ocurre **dentro de una activación de usuario** (un tap/
click real); fuera de un gesto lo deniega en silencio. Cuando ya había nombre guardado
(`?displayName=` o localStorage), la sala se **auto-unía en un `useEffect` de montaje**,
o sea sin ningún tap → Safari denegaba el micro sin prompt → modo sin-micro. Chrome/
Firefox son permisivos y por eso ahí nunca se notó.

**Fix (solo cliente, sin reiniciar el servicio):**
- Nuevo `isAppleWebKit` (`client/src/lib/microphone.ts`): `isIOS` (Safari + Chrome/
  Firefox de iOS, todos WebKit) más Safari de macOS (`navigator.vendor` de Apple, no
  Chromium/Firefox). No se tocaron `isIOS` ni los constraints (la captura mono de iOS
  queda igual).
- Nuevo estado de join `"gate"` (`client/src/components/Room.tsx`): en Apple WebKit, en
  vez de auto-unir, se muestra una pantalla con un botón **"Entrar"**; el join — y por
  ende `getUserMedia` — corre **dentro del `onClick`**, síncrono (sin `await` antes que
  rompa la activación), así que Safari muestra el prompt. Chrome/Firefox/Android siguen
  con el auto-join instantáneo de siempre. `?mic=off` salta el gate.
- Botón con `autoFocus`, encabezado y descripción claros (doble accesibilidad: sirve
  igual a lector de pantalla y a vidente). Claves i18n `room_enter_*` en `es.json`.

**Verificado:** dos agentes (uno resuelve, otro comprueba) confirmaron la causa con
evidencia, que la cadena de activación no se rompe, que la detección Apple no clasifica
mal a Chrome/Firefox de Mac, cero regresiones (modo sin-micro legítimo, jam, reconexión,
robustez previa), typecheck limpio y servidor intacto. **Pendiente de confirmar en un
Safari real** (iPhone/Mac) que el prompt aparece al tocar "Entrar" — no hay Safari en la
máquina de desarrollo.

---

## 2026-09-07

### Robustez: que un fallo al entrar sea SIEMPRE culpa de la red del usuario, no de la Pi

Auditoría con agentes de los timeouts/errores "aleatorios" que a veces impedían entrar.
Se cerraron todos los caminos por los que la Pi, la URL o un timeout evitable podían dejar
a alguien fuera. Ahora si algo falla es por su internet o porque yo paré el servidor a mano.

**Servidor:**
- **Red de seguridad global** (`index.ts`): `unhandledRejection`/`uncaughtException` ahora
  se **loguean y el servidor sigue**, en vez del comportamiento por defecto de Node (tirar
  el proceso entero). Una promesa mediasoup que rechaza suelta ya no corta la sala a todos.
  (El worker de mediasoup muriendo sigue saliendo con `exit(1)` a propósito → systemd
  reinicia.)
- **`producer-pause`/`producer-resume`** (`signaling.ts`): envueltos en try/catch + saltan
  el producer ya cerrado + **siempre llaman al callback**. Antes, `pause()` sobre un
  producer cerrado (carrera mute vs. cambio de modo) rechazaba sin handler y el cliente
  quedaba colgado en el `await` (un timeout que no debía existir).
- **`index.html` cacheado en memoria por mtime, con `stat`/`readFile` async**
  (`index.ts`): antes se hacía un `readFileSync` **síncrono en CADA carga** — en la SD de
  la Pi eso bloquea el event loop (todo HTTP + socket.io, incl. "join") mientras lee. Ahora
  se sirve de memoria y solo re-lee si cambió el mtime (comprobado como mucho 1 vez cada
  2s). Un build de cliente se sigue viendo en ~2s, sin restart.
- **`create-transport` cierra el transport anterior antes de reemplazarlo**
  (`signaling.ts`): un reintento (reconexión, cambio a SFU) dejaba el transport viejo
  huérfano con sus puertos/consumers abiertos — una fuga lenta que agotaba el rango
  40000-40058 y hacía fallar entradas nuevas.

**Cliente (`useMediasoup.ts`):**
- **Fallback a long-polling** (`transports: ["websocket","polling"]` + `tryAllTransports`):
  era **solo WebSocket**, y en redes que bloquean el upgrade WS (algunas móviles/CGNAT/
  proxies) el socket no conectaba nunca → el join colgaba para siempre. Esta era la causa
  más probable del "a algunos no les carga, aleatorio".
- **Timeout de conexión** (25s): si la primera conexión no entra, se **rechaza el join con
  un error recuperable** ("no se pudo conectar", recargar reintenta) en vez de un spinner
  eterno. `connect_error` se loguea (socket.io sigue reintentando solo).
- **Timeout de captura de micro** (12s): `getUserMedia` puede **colgarse** (prompt sin
  responder, device ocupado); ahora se entra en modo escucha/chat en vez de no cargar.
- **Reintento si falla el rejoin**: si un rejoin tras reconexión falla, el socket seguía
  conectado pero fuera de la sala (mudo para el mundo, sin que nada lo reintente); ahora
  fuerza un ciclo de reconexión limpio.
- **Sondeo de mantenimiento exige 2 respuestas 502/503 seguidas** antes de recargar: un
  502 transitorio (Caddy que no alcanza el upstream durante un restart normal) ya no
  rebotea a nadie fuera de una llamada que iba a recuperarse.

### Modo mantenimiento (parar el servicio) + fix de fiabilidad del corte

- **Mantenimiento:** `sudo systemctl stop sonicroom` (por ssh) pausa la plataforma; Caddy
  sirve una página "En mantenimiento" (`/var/www/maintenance/index.html`, `handle_errors`
  en el Caddyfile) en vez de un 502. `start` (o `sudo reboot`, el servicio es `enabled`)
  la devuelve; la página se auto-refresca cada 30s y vuelve sola a la app.
- **Cortar a TODOS, no solo a los nuevos:** en P2P el audio va directo entre peers, así que
  parar el servidor NO cortaba a los ya conectados. El cliente ahora, al desconectarse,
  **sondea el servidor** (`fetch /`): 502 (Caddy arriba, app parada = mantenimiento) →
  `location.reload()` a la página de mantenimiento; 200 (servidor arriba) o fallo de fetch
  (tu red) → NO recarga.
- **Fix de fiabilidad (regresión propia):** la primera versión recargaba tras cualquier
  desconexión de >6s, lo que **reboteaba a los clientes de red inestable** (uno hizo 106
  requests en 10 min recargando), y esas recargas fallidas eran el "a veces no carga". El
  sondeo lo resuelve: solo recarga si el servidor está realmente caído. **Verificado:**
  30/30 cargas OK vía Caddy, carga externa OK (WebFetch), sondeo 200 arriba / 502 parado,
  y el churn de reconexiones se detuvo. Todo cliente → build, sin restart.

## 2026-09-06 (2)

### Fix raíz de "algunos entran en calidad baja hasta ciclar el bitrate"

- **Aclaración de Cristian:** pasaba AUN estando la sala en 128 — un joiner (Franco/Edu)
  entraba bajo hasta que ciclaban el bitrate y lo volvían a 128; ahí quedaban todos alto.
  Es decir: no era el valor de la sala (eso fue el fix anterior), era el **arranque del
  encoder del que entra**.
- **Causa (medida en vivo, no supuesta):** en P2P el bitrate del sender se aplicaba en
  `addTrack()` — ANTES de negociar la conexión — y **nunca se re-aplicaba tras conectar**.
  Ese seteo temprano no "prende", así que el encoder quedaba en el default bajo de Chrome
  (~48k) hasta que un ciclo manual re-aplicaba `setParameters` en la conexión ya viva.
  Además `setSenderMaxBitrate` para 128 borraba el cap ("ilimitado"), que dejaba a Chrome
  en ese default en vez de forzar el target.
- **Fix (`1584cb2`):** (1) cap EXPLÍCITO de 128000 en vez de "ilimitado"; (2)
  `createP2pConnection` re-aplica el bitrate en `connectionstatechange='connected'`
  (inmediato + a los 1.2s), para offerer y answerer — automatiza el ciclo manual.
- **Verificado MIDIENDO el bitrate de salida real** (instrumenté `tx=Nkbps ch=N` en el log
  por peer): un joiner limpio (Franco) subió 113→128 en ~12s sin ciclar; en estado estable
  **edu 128k 100% del tiempo, franquito ≥96k 100%**, todos estéreo (ch=2) alcanzando 128-130.
  Los dips que quedan (sobre todo de Cristian, en la LAN pero con enlaces WAN largos a los
  remotos en Argentina) son **adaptación de congestión** — exactamente "bajar solo si el
  audio se pone malo", que es lo pedido. Forzar 128 sobre un enlace con pérdida cortaría.
- SFU (6+ peers) usa el bitrate del produce (`opusMaxAverageBitrate=128000`, post-conexión),
  cubierto por el mismo instrumento; no probado en vivo (hace falta 6+). Solo cliente → build.

## 2026-09-06

### Fix: el bitrate bajo se quedaba pegado entre sesiones → ahora se arranca en 128

- **Síntoma (Cristian):** a veces, al entrar, a algunos les entraba en calidad baja y se
  quedaba trabado hasta subir a 128 KBPS a mano.
- **Causa (deducida del código, no supuesta):** no hay auto-degradación en ningún lado —
  nada baja el bitrate solo. El produce (SFU) y el SDP (P2P) ya apuntan al bitrate del
  room. El ÚNICO camino a "entrar bajo" era `roomBitrates`, un Map por nombre de sala que
  guardaba el valor **para siempre** (incluso al vaciarse y recrearse la sala). Si alguien
  lo bajó una vez, cada joiner nuevo lo adoptaba → entraba bajo; los que ya estaban en 128
  seguían bien hasta reconectar (de ahí "a algunos"); subir a 128 lo arreglaba para todos.
- **Fix (`df3521a`):** al vaciarse la sala se borra su entrada en `roomBitrates`, así la
  próxima sesión arranca en 128 (full) y solo baja si se baja a propósito EN la sesión.
  El log de join ahora muestra `[Nkbps]` para verificar en vivo. El restart del deploy
  además limpió el Map en memoria → las salas ya pegadas volvieron a 128 al instante
  (**verificado:** la banda reconectó en `[128kbps]`). Cambio de servidor → restart.

## 2026-09-05

### UI más intuitiva para videntes no técnicos (sin romper el lector) + jam oculto por defecto

- **Meta:** que un amigo que ve y no sabe de tecnología entienda la plataforma sin que
  le expliquen botón por botón, y que un ciego siga usándola igual con el lector. Regla de
  doble accesibilidad guardada en la memoria de Claude.
- **Barra de controles:** cada botón ahora es **ícono + etiqueta de texto** visible,
  agrupado (Tu voz | Reproducir en la sala | Sala) con separadores. Estado on/off
  inequívoco (color + ícono + texto, no solo color): mute silenciado en **rojo** con
  "Activar audio" (convención universal). Los `aria-label` largos que usa el lector quedan
  intactos; las etiquetas visibles son `aria-hidden` (sin doble lectura).
- **Indicador de quién habla:** anillo verde + borde de tarjeta + insignia "Hablando ahora"
  con punto que pulsa, por cada peer y por vos mismo. Detección por analyser pasivo (no
  afecta el audio), ~10 Hz con hold anti-parpadeo, escrito al store solo en cambios. Todo
  `aria-hidden` (no satura al lector; el estado ya se anuncia por el nombre). Sliders de
  volumen con etiqueta visible.
- **Jam oculto por defecto:** todas las opciones de Modo ensayo (jam, buffer, metrónomo,
  Monitoreo de red) quedan ocultas en Ajustes hasta pulsar **Alt+Shift+J**, que alterna
  `jamUiVisible` (persistido) y lo anuncia para el lector. Los primerizos solo ven los
  controles estándar. Sin colisión con Alt+J de serieteca (ese es sin Shift).
- **Verificado por Claude en su navegador** (capturas): barra con etiquetas, estados
  rojo/verde/violeta, jam oculto y Alt+Shift+J revelándolo. `window.__roomStore` agregado
  como hook de debug (estilo `__jamClock`).
- Commits ahora en **`main`** (la rama `feat/webtransport-jam` se consolidó ahí por
  fast-forward; la Pi también sigue `main`). Corregida la nota de ruteo del CLAUDE.md: la
  ruta de sala es `/:roomName`, NO `/room/:roomName`. Solo cliente → build, sin restart.

## 2026-08-28 (2)

### Fix: `?p2p=off` ya no clava la sala en SFU para siempre — se libera al irse quien lo pidió

- **Síntoma (Cristian, en vivo):** 3 personas, sin Modo ensayo, y aun así en SFU. El log
  del servidor mostró que el Android de Edu había entrado antes con `?p2p=off`.
- **Causa:** `room.disableP2p` se ponía en `true` al entrar alguien con `?p2p=off` y era
  **sticky toda la vida de la sala** — nunca se recalculaba. Cuando ese cliente se iba, el
  flag quedaba pegado → SFU para siempre aunque no quedara nadie con p2p-off ni jam.
- **Fix (`69e28a8`):** `disableP2p` ahora se **deriva de `room.p2pOffPeers`** (los peers
  `?p2p=off` presentes AHORA): se agrega al entrar y se quita en `teardownPeer`, igual que
  `casters`, recalculando en ambos. Al irse el último que lo pidió, `applyModeDecision`
  devuelve la sala a P2P sola. **Verificado en vivo:** tras el restart, los 3 reconectaron
  sin flag y `txRtt` no-null ⇒ P2P. Cambio de servidor → requiere restart.
- Nota cliente (pendiente opcional): `?p2p=off` también queda en `sessionStorage` por
  pestaña (`jdh-speak:p2p-off:<sala>`), así que esa pestaña lo re-manda en cada F5 mientras
  siga abierta (ahora se libera al salir). Se podría agregar un atajo para limpiarlo en vivo.

## 2026-08-28

### Jam: el retorno de red es la REFERENCIA de tiempo (modelo Jamulus), no un eco rápido — bug de raíz

- **Lo que Cristian explicó (y yo no entendía):** el problema no era la sincronía del
  metrónomo (esa ya quedó, medida). Es el modelo de Jamulus: uno toca contra su PROPIO
  retorno vía servidor, mezclado con los demás (también vía servidor), y anticipa hasta
  que su retorno cuadra **en tempo** con los otros en ese monitor. Cuando cuadra para
  uno, cuadra para TODOS — porque alinear tu retorno a los peers de oído equivale a que
  tu audio **llegue al servidor alineado** con el de ellos (el servidor es el punto común).
- **La cancelación (y el invariante):** oís tu retorno en `t+subida+(bajada+buffer+salida)`
  y a un peer en `t'+subida'+(bajada+buffer+salida)`; alinearlos cancela el término común
  `bajada+buffer+salida` ⇒ llegan alineados al servidor. **Solo se cancela si el retorno
  pasa por el MISMO buffer y la MISMA salida que los peers.** La latencia absoluta da igual
  (funciona a 100 ms o a 5000 ms; solo anticipás más). Por eso "bajar la latencia del
  monitor" era el objetivo EQUIVOCADO.
- **El bug:** yo había construido el monitor para que fuera lo más rápido posible (buffer
  `≤8 ms`, rutas WT-2.5 ms/generator, su propia placa). Eso hacía que el retorno llegara
  ANTES que los peers → alinearte a él te dejaba adelantado para todos → "ni con el
  metrónomo podemos tocar juntos".
- **Fix (`1195ce0`):** en jam el retorno usa el **mismo buffer (`jamBufferMinMs`) que los
  peers** y se fuerza a la **misma salida (`masterBus`)** que los peers
  (`applyNetworkMonitor` + efecto de buffer en vivo + `routeNetMonitorOutput` fuerza
  `deviceId=""` en jam). Fuera de jam sigue siendo un eco-diagnóstico ajustado. El
  metrónomo NO es el mecanismo — el retorno del servidor sí. Solo cliente → build, sin
  restart. Requiere recargar.

## 2026-08-27 (4)

### Metrónomo compartido sincronizado — el "elemento que llega a todos igual" + verificación acústica

- **Necesidad real de la banda:** no un hub de audio de menor latencia, sino **una línea
  de tiempo común** contra la cual tocar mientras el audio de instrumentos va P2P a mínima
  latencia (compensás el retardo de red contra el beat compartido, estilo Jamulus: tocás
  al clic, no a lo que escuchás). Solución: **un clic generado localmente en cada máquina
  pero enganchado (phase-lock) al reloj del SERVIDOR**, no audio ruteado por el SFU.
- **Piezas:** `client/src/lib/clocksync.ts` (sync NTP-style, se queda con el sample de
  **menor RTT**), `client/src/lib/metronome.ts` (scheduler look-ahead ~50 ms que agenda
  cada beat con `getOutputTimestamp()` para que el SONIDO emerja en el instante-servidor
  objetivo, compensando la latencia de salida de CADA máquina), server `set-metronome`
  (mismo `anchorServerMs` para todos, incl. late joiners), UI en `DeviceSettings` (BPM,
  Iniciar/Detener, calidad de sync).
- **Dos bugs de raíz arreglados** (eran la desincronía gruesa "no llega al mismo tiempo"):
  1. `6d7568d` — el ack `time-sync` **necesita `ok:true`** (el wrapper `emit` del cliente
     rechaza sin eso). Sin el fix, la sync de reloj estaba **rota** → cada máquina usaba su
     reloj crudo, desfasado cientos de ms/segundos.
  2. `da7ccff` — compensar la latencia de salida **por máquina** con `getOutputTimestamp`
     (no el estimador `outputLatency`) → dos máquinas con distinta latencia de salida
     disparan juntas.
- **Verificado ACÚSTICAMENTE (no simulado):** dos clientes independientes de la app en una
  máquina, clics a frecuencias distinguibles, capturados por loopback WASAPI:
  **flam por correlación cruzada 0.17 ms, 16/16 beats < 2 ms**. Control (inyecté +25 ms de
  error de reloj): medido 24.62 ms → la medición es real y el pipeline es sub-ms. El
  residual que queda es la **asimetría de la sync de reloj sobre WAN** (el piso de
  Jamulus, ~unos–decenas de ms; en LAN medí ±2.5 ms), que solo la banda —oyendo ambos
  extremos físicamente— puede confirmar. Hook de debug: `window.__jamClock`.
- Commits `6d7568d`, `da7ccff`, `fcb9225` (código, ya desplegados en la Pi) + esta entrada.

## 2026-08-27 (3)

### Jam: DEJA de forzar SFU → usa P2P como el modo normal (raíz de "jam tiene más latencia")

- **Síntoma (medido por Cristian, no especulativo):** en jam, su voz llegaba a los
  parlantes de Iván con MÁS retardo que en modo normal, con todos. **Causa raíz:**
  `jamMode` estaba en `shouldForceSfu`, así que jam **forzaba el SFU** → la voz hacía un
  salto extra por el servidor (vos→Pi→peer) en vez del P2P directo del modo normal
  (vos→peer). Enumerando lo que cambia jamMode, SOLO el force-SFU sumaba latencia; el
  jitter buffer más chico la BAJA.
- **Fix:** saqué `room.jamMode` de `shouldForceSfu` (`server/src/signaling.ts`). Ahora
  jam usa el **mismo transporte que normal** (P2P ≤5, SFU 6+) + su buffer más ajustado ⇒
  **jam es más rápido que normal, no más lento.** El **monitoreo de red** sigue
  necesitando SFU y lo fuerza por su cuenta (`forceSfu`); grabación/caster/Ctrl+Alt+S
  también. El re-tuneo del jitter buffer se aplica en vivo en receptores P2P y SFU al
  togglear jam o mover el slider. Doctrina "jam ⇒ SFU" del CLAUDE.md **revertida**.
- **Cambio de servidor** → requiere reiniciar el servicio (corta las llamadas activas;
  reconectan).

## 2026-08-27 (2)

### Jam: el slider "Buffer de jitter" ahora controla el buffer REAL (en vivo)

Cristian aclaró lo que esperaba del slider: que baje/suba el buffer de **todo** lo que
escucha — menos = menos latencia general + más riesgo de cortes; más = estable. Estaba
inerte (controlaba la malla muerta). Ahora está cableado al `jitterBufferTarget` de NetEQ
de **cada receptor** (consumers SFU + P2P), y se aplica **en vivo** mientras lo movés (sin
reconectar) — `setReceiverJitterTarget(rcv, ms)` + `playoutDelayHint`, recorriendo
`peerAudiosRef` y `p2pConnectionsRef` en el effect del slider. El retorno propio (monitor)
se mantiene ≤8 ms (loopback) pero sigue al slider hacia abajo. Default 30 ms (limpio, <50
del normal). Descripción del slider actualizada. Solo cliente → build, sin reinicio.

## 2026-08-27

### Jam: abandonar la malla custom — usar el camino LIMPIO de mediasoup

**Corrección de rumbo.** Cristian dejó claro que **a TODOS** (él, Pablo, Edu, Franco) les
crujía/clipeaba en modo ensayo, en **cualquier máquina** (no son laptops), mientras el
**modo normal (mediasoup/WebRTC/NetEQ) suena limpio**. O sea: el problema NO era de red ni
de CPU — era que **la tubería de audio custom de jam** (malla WT con Opus 2.5 ms → nuestro
jitter buffer → `MediaStreamTrackGenerator`, y el bypass de NetEQ por `encodedInsertable
Streams`) produce audio malo para todos. Todos los fixes anteriores puleaban una tubería
rota de raíz.

- **Apagadas ambas rutas custom** (`JAM_WT_MESH=false`, `JAM_NETEQ_BYPASS=false` en
  `useMediasoup.ts`): la malla WT, el bypass NetEQ y el monitor WT quedan parkeados. Jam
  reproduce a los peers por el **mismo NetEQ limpio** que el modo normal.
- **`jitterBufferTarget` de jam pasó de 0 a 30 ms** (`JAM_JITTER_HINT`). El 0 hacía NetEQ
  entrecortado ante el mínimo reordenamiento (lo dice el propio comentario del código). 30
  ms = colchón real (limpio) pero por debajo de los 50 ms del modo normal → jam sigue más
  ajustado que normal, pero **limpio**, sobre el camino estándar.
- Cambio **solo de cliente** → build, sin reinicio, sin cortar llamadas.
- Pendiente (si quieren aún menos latencia): que jam NO fuerce SFU (que sea P2P como el
  normal) — es un cambio de servidor, va aparte. Y re-cablear el slider "Buffer de jitter"
  al `jitterBufferTarget` de NetEQ (ahora quedó inerte).

## 2026-08-26 (2)

### Jam: clipping + crackling de raíz (limitadores + resampler sin GC + RED anti-pérdida)

Franco/Edu clipeaban y crujían **aun con el buffer en 100** (buffer-independiente).
Diagnóstico en vivo (extensión en la máquina de Cristian, sala real): `lost:1004`,
`underruns:621` en ~5 s → **el crackle es PÉRDIDA DE PAQUETES**, que ningún buffer tapa.
Cuatro causas de raíz, cuatro arreglos:

1. **Clipping en origen** — el envío de jam saltea el limitador (micro crudo). Agregado
   un **limitador soft sin latencia** (tanh, rodilla 0.7) en `encodeFrame` (malla +
   monitor): un micro caliente ya no manda señal saturada.
2. **Crackle por GC en laptops** — el `StreamResampler` asignaba ~4 arrays por trama por
   canal (400 fps × N peers) → pausas de GC. Reescrito **sin asignar** (ring preasignado
   + buffers reusados). Verificado byte-idéntico al anterior.
3. **Clipping por SUMA** de varios que tocan a la vez — cada peer ≤1 pero la suma en la
   salida del SO clipea. Agregado un **limitador maestro**: todos los peers van por un
   `DynamicsCompressor` compartido → un `<audio>`. Cuesta ~10 ms de AudioContext; fail-safe
   al camino por-peer si no hay contexto.
4. **Pérdida de paquetes** (la raíz principal del crackle) — datagramas WT no son
   confiables. Agregado **RED**: cada datagrama lleva también los **2 frames Opus
   anteriores** (`RED_DEPTH=2`), así una pérdida aislada Y una **ráfaga de hasta 2
   seguidos** se recuperan de un datagrama posterior (a 2.5 ms/frame, latencia de
   recuperación mínima). Verificado: ráfaga de 2 caídos → recuperada entera, orden
   intacto; ráfaga de 3 → recupera 2, reporta 1 perdido. El lector en vivo muestra
   `recuperados` y `perdidos`. Costo: ~3× el payload Opus (que es diminuto).

- **⚠️ Cambió el formato de paquete** (RED + limitador) → **todos deben recargar a la vez**.

## 2026-08-26

### Cliente nativo de jam (romper el piso de WASAPI) + interop navegador

- **Qué:** nuevo `native/jam_native.py` — cliente headless en Python que hace el audio
  FUERA del navegador (WDM-KS/ASIO) y entra a la MISMA sala WT `/jam` que la malla del
  navegador. Rompe el piso de WASAPI-shared de Chrome bajando la salida de ~23 ms a
  ~10 ms (medido), interoperando con peers del navegador.
- **Reingeniería/medición (en la máquina de Cristian, PortAudio pip):** WASAPI shared y
  **exclusive** en la Focusrite USB quedan en ~20/34 ms (el driver USB fija el buffer —
  no se vence desde user-space); **WDM-KS (kernel streaming) = 10 ms in / 10 ms out**
  (–13 ms vs navegador); **ASIO ~3–5 ms** (necesita build con SDK). Opus 2.5 ms en
  Python (PyAV, 1 pkt/frame, ~22 B). Cliente WebTransport en aioquic: `CONNECT 200`,
  hello→ack, envía/recibe el fan-out del relay (sent≈recv, **RTT real ~1–2.5 ms**).
  Detalle clave que costó: aioquic necesita `max_datagram_frame_size` para RECIBIR
  datagramas (sin eso mandás pero no recibís).
- **Interop navegador (`useMediasoup.ts`):** la malla aplicaba `effectiveGain`, que
  devuelve 0 para un peer desconocido → **silenciaba al cliente nativo**. Ahora un
  `appId` desconocido en la malla suena a ganancia 1 (deafen sigue mandando). Cambio de
  cliente → build, sin reinicio.
- **Estado:** camino de baja latencia probado punta a punta. Falta (etapa GUI):
  señalización (que el nativo aparezca en la sala con nombre/volumen), portar el jitter
  buffer con resampling, ASIO, y estéreo. Ver `native/README.md`.

## 2026-08-24 (4)

### Jam: estéreo real (dejó de forzar mono) + no-stall en underrun

- **Qué:** el modo ensayo ya no colapsa todo a mono. La malla y el monitor WT ahora
  siguen el **conteo de canales real del micrófono/interfaz**: entrada mono → mono
  (igual que antes), interfaz estéreo → **estéreo de verdad** (Opus estéreo a 2.5 ms,
  128 kbps). Probado en el navegador real (Edge del usuario): captura mono `max:1` en el
  device por defecto, `createMediaStreamDestination` es estéreo (no era el culpable),
  Opus estéreo 2.5 ms encode/decode OK, `AudioData` estéreo de largo variable →
  generator OK.
- **Cómo:** `encodeMono` → `encodeFrame(encoder, ad, channels)` (downmix solo si el
  encoder es mono; si es estéreo, encodea los 2 canales directo). `applyJamMesh` /
  `applyNetworkMonitor` pasan `micTrack.getSettings().channelCount`. **Cada emisor
  estampa SU conteo de canales en el paquete** (`[0x01][idLen][appId][ch][seq][t][opus]`,
  el relay lo reenvía verbatim), así un oyente mono decodifica bien a un emisor estéreo y
  viceversa (arregla el bug latente de decoders con canales cruzados). Buffer y resampler
  ya eran por-canal. Verificado el formato de bytes de punta a punta (`node`).
- **⚠️ Cambió el formato de paquete** → todos deben recargar a la vez (mezclar clientes
  viejos/nuevos silencia entre ellos hasta recargar).

## 2026-08-24 (3)

### Jam: compensación de drift por RESAMPLING + un solo slider + fix a11y NVDA

- **Qué:** el buffer de jam ahora es **solo para el jitter** (un único slider "Buffer de
  jitter"). El desfase por diferencia de relojes —lo que hacía crecer el retardo con las
  horas— se corrige por **resampling continuo** (como SonoBus/AOO), no descartando frames.
  Se eliminó el slider "máximo" (ya no hace falta un techo de descarte).
- **Cómo (DSP):** nueva clase `StreamResampler` (interpolación lineal, cursor fraccional
  continuo entre frames) dentro de `AdaptiveJitterBuffer` (`jam-wt-mesh.ts`). Un
  controlador lento mide el nivel del buffer muy suavizado (τ=2 s) y **empuja la
  velocidad de reproducción** ±fracción de % (τ_corrección=4 s, clamp ±2 %) para que el
  buffer quede clavado en el cushion elegido. Prebufferea al cushion, y ante underrun
  real re-prebufferea. Queda un techo de seguridad (cushion+250 ms) que en la práctica no
  se toca. La ganancia por-peer se pasó a `push(ad, gain, write)` (se aplica al extraer
  el PCM, antes del resampler). Los tres caminos (malla, monitor, generador NetEQ) usan
  el mismo buffer.
- **Verificado:** resampler aislado (`node`) — a s=1 transparente, a ±1 % desplaza el
  pitch ±1 % sin clicks (salto máx = el de la propia señal), sin NaN/clip. Lazo de
  control (`node`, corridas de 10 min): con drift de −300/+300/−1000 ppm el buffer queda
  **plano, creep = 0.00 ms**, 0 descartes, 0 underruns; la velocidad se asienta justo en
  el ppm del drift. En navegador real: `AudioData` f32-planar de largo variable +
  escrituras al `MediaStreamTrackGenerator` OK, track `live`, sin errores; UI = un solo
  slider, accesible.
- **Fix accesibilidad (NVDA):** el lector de ms en vivo era `aria-live="polite"`, así que
  NVDA lo leía sin parar (cada cambio) y tapaba la navegación hasta el slider. Se quitó
  `aria-live` (un usuario de lector puede navegar y leer el snapshot cuando quiera), el
  sondeo bajó a 1 s, y los controles quedaron en un grupo etiquetado. El slider tiene
  `aria-valuetext` (“N ms”) y `aria-describedby` con la explicación.

## 2026-08-24 (2)

### Jam: barras deslizantes de buffer por-usuario (a lo Jamulus)

- **Qué:** dos sliders en Ajustes de audio (visibles con Modo ensayo activo) — **Buffer
  mínimo** (0–100 ms) y **Buffer máximo** (10–200 ms) — para que **cada uno** controle
  su jitter buffer, más un lector en vivo (`{buffered} ms · jitter · descartes`). Por
  usuario, local, persistido, y **en vivo** (sin reconstruir nada).
- **Cómo:** convertí `AdaptiveJitterBuffer` (jam-wt-mesh.ts) de "auto-mínimo fijo" a un
  buffer manual estilo Jamulus: **prebufferea a `min`** con frames reales (cushion real
  = latencia y tolerancia a jitter), reproduce, **descarta por encima de `max`** (techo
  de latencia + corta el creep de drift; descartar estando adelantado es inaudible), y
  **re-prebufferea ante un underrun** para reconstruir el cushion. El usuario ES la
  adaptación: bajás el mínimo para menos latencia, lo subís si hay cortes/crackling; el
  máximo pone el techo. Bounds vía un objeto compartido vivo (`jamBoundsRef` en
  useMediasoup) que los sliders mutan → los tres caminos de playout (malla de peers,
  monitor WT, generador NetEQ-bypass) lo leen al vuelo. Store: `jamBufferMinMs/MaxMs`
  con cross-clamp (min ≤ max). i18n en es.json.
- **Por qué el rediseño:** el target adaptativo anterior, al quedar pegado al `min`,
  **erosionaba** el cushion bajo jitter (simulado: con min=20 el buffer caía a ~11 ms
  promedio y rozaba underrun). El modelo manual lo arregla: simulado (`node`, 6 casos)
  → min=8 mantiene 8 ms; min=30 mantiene ~28; drift con max=25 queda clavado ≤25;
  jitter ±10 ms con min=20 aguanta sin un solo underrun ni descarte; recupera de un
  corte de 300 ms re-prebuffereando. Cero descartes/erosión donde antes había ambos.
- **Verificado en navegador** (además de types/lint/build): sliders aparecen solo con
  jam, valor actualiza+persiste, cross-clamp en ambos sentidos, `aria-valuetext` para
  lectores de pantalla, lector en vivo oculto sin datos.

## 2026-08-24

### Jam: buffer de jitter ADAPTATIVO (reingeniería de Jamulus/SonoBus)

- **Qué:** reemplacé el tope FIJO de 45 ms (+ descarte de frames) de la malla/monitor
  por un **buffer de jitter adaptativo** estilo Jamulus. Nueva clase
  `AdaptiveJitterBuffer` en `client/src/lib/jam-wt-mesh.ts`, usada en los tres caminos
  de playout: la malla WT de peers, el monitor WT (`jam-wt-monitor.ts`) y el bypass
  NetEQ por generador (`jam-neteq-bypass.ts`).
- **Cómo:** estudié el fuente real (son GPL, no hace falta desensamblar). Jamulus
  (`buffer.cpp`) corre buffers simulados en paralelo (2–11 bloques), mide la tasa de
  *underrun* de cada uno y elige el **más chico** cuyo error queda bajo un umbral, con
  filtro IIR + histéresis. SonoBus/AOO llega a lo mismo con DLL + resampling. Adapté el
  **principio** a nuestro playout (un `MediaStreamTrackGenerator` que consume a
  tiempo real, no un `Get()` por bloque): mido el jitter real de llegada (RFC 3550
  suavizado) y cada ~0,5 s muevo el cushion objetivo hacia `frame + 3×jitter` — sube
  rápido para cubrir un pico, baja lento cuando el enlace se calma (IIR up-fast/
  down-slow). Descarto un frame solo cuando paso ese objetivo **adaptativo**, así la
  latencia queda clavada en el mínimo que la red pide en cada momento.
- **Por qué:** el tope fijo de 45 ms era la versión cruda — en un enlace limpio dejaba
  ~30 ms sobre la mesa, y bajo *drift* de reloj el delay trepaba hasta 45 ms antes de
  recortar (el "el delay se va agrandando" que se sentía). Simulado (`node`,
  3 escenarios): **limpio** → objetivo 8 ms (vs 45); **con jitter ±8 ms** → 20 ms
  (cubre sin recortar, sigue < 45); **con drift** → fija el buffer en ~6 ms mientras el
  fijo dejaba trepar a ~19 ms en 60 s (y hasta 45 en sesiones largas). Es un
  **DROP-only** a propósito: subir el objetivo no evita underruns (no añadimos cushion
  deliberado, que subiría latencia sin beneficio reportado — no hay glitches), así que
  el objetivo es puro umbral de descarte y el término de jitter se autorregula.
- **Stat en vivo:** `window.__jamMeshStats` ahora expone `{bufferedMs, targetMs,
  jitterMs, drops}` para verificar en sesión real.
- **Honestidad de alcance:** esto recorta el buffer/creep (real), pero el piso duro
  sigue siendo I/O de WASAPI (~33 ms captura+salida en placas USB) + red. La malla
  suena parecido al P2P porque **no está pensada para bajar la latencia por-enlace**
  sino para dar el **reloj común** (modelo Jamulus, hub compartido en el relay); bajar
  de ~40 ms en navegador exige ASIO (el plan de la GUI en Python).

## 2026-08-19 (3)

### Modo ensayo: auto-SFU + hacks de latencia (fase 1)

- **Auto-SFU:** al marcar **Monitoreo de red**, si la sala no está en SFU, se
  fuerza automáticamente (`set-force-sfu`) — el retorno propio necesita el
  servidor en el bucle, así que ya no hay que activarlo a mano.
- **Captura de baja latencia:** en modo ensayo, `getUserMedia` pide el buffer de
  entrada **mínimo** (constraint `latency: { ideal: 0 }`). Ataca el "suelo fijo"
  del navegador (el buffer de captura suele ser 20-40 ms; esto empuja a ~10 ms o
  menos donde el dispositivo lo permite). Es la mayor reducción disponible.
- **Prioridad de red alta:** el audio saliente en ensayo se marca
  `networkPriority: "high"` (DSCP/QoS) para que la red lo encole antes que el
  tráfico masivo → menos jitter en enlaces cargados. Se re-aplica en cada
  (re)producción y conexión P2P nueva.
- **Buffer de jitter 0** en ensayo (ya estaba).
- **Bypass del grafo de envío (fase 2, hecho):** en ensayo se manda el **micro
  crudo** directo al productor/senders vía `replaceTrack` (no renegocia), saltando
  el grafo de Web Audio de salida — el _lookahead_ ~6 ms del limitador más el
  buffer `MediaStreamDestination→source`. Live y sin cortes; se re-aplica al
  (re)producir, en cada P2P nueva y al **cambiar de dispositivo** de micro
  (el productor apunta a la pista cruda nueva). Contras (asumibles al tocar): sin
  limitador de salida (una interfaz a nivel de línea no clippea) y el audio
  compartido/secundario no se envía mientras va crudo. Acotado a ensayo (opt-in):
  las llamadas normales no cambian. El mute sigue funcionando (desactiva la pista
  cruda aguas arriba).
- **FEC off (hecho, ver fase 3):** ya no queda pendiente.

---

## 2026-08-19 (4)

### Modo ensayo: hacks de latencia fase 3 (investigados, no de memoria)

Tras investigar el estado del arte actual (WebCodecs/WebTransport, la API nueva
`jitterBufferTarget`, `ptime` de Opus, y el proyecto selkies que exprime WebRTC
para streaming en vivo), tres palancas **reales y nuevas**, todas **solo en
ensayo** y apuntando al camino del **monitoreo de red** (mic → produce → consume
de vuelta):

- **`ptime=10` en el SFU (lo más gordo aquí):** el `produce` usaba la
  paquetización por defecto de **20 ms** — 20 ms de muestras acumuladas en el
  emisor antes de que salga el primer paquete. En ensayo se pone
  `opusPtime: 10` en los `codecOptions` → **10 ms menos** justo en lo que oís
  volver. (En P2P el `ptime=10` ya estaba vía `sdp-munger`; el hueco era el SFU,
  que es el camino del monitoreo de red.) Coste: ~+32 kbps de cabeceras, trivial.
- **`jitterBufferTarget = 0` (API nueva, Chrome 124+):** es el sucesor con
  especificación del viejo `playoutDelayHint` **no estándar** — y Chrome ya lo
  **honra** mientras ignora cada vez más el hint viejo. Se aplica en los tres
  sitios de recepción (P2P `ontrack`, consume SFU, retorno del monitoreo de red)
  vía `RTCRtpReceiver.jitterBufferTarget`; seguimos poniendo también el
  `playoutDelayHint` como respaldo para motores viejos/Firefox. Helper
  `setReceiverJitterTarget` con try/catch (el setter lanza `RangeError` fuera de
  `[0,4000]` y no existe en todo motor).
- **FEC off en ensayo:** in-band FEC recupera un paquete perdido **desde el
  siguiente**, así que el decodificador retiene un paquete "por si acaso" → suma
  un tiempo-de-paquete de latencia. Un músico quiere la muestra más temprana, no
  la más segura. `opusFec: false` en el produce (SFU) y `useinbandfec=0` en el
  `sdp-munger` (P2P). Se lee al producir (como hi-fi voice), aplica en la próxima
  llamada / cambio de modo; las llamadas normales mantienen FEC para resiliencia.

Descartado a propósito (por ahora): reescribir el transporte a
**WebCodecs + WebTransport** (buffer propio, sin NetEQ) — es la vía nuclear real
para bajar aún más, pero es un rework grande y aparte del stack mediasoup; se
deja anotado como la siguiente frontera si algún día hace falta.

---

## 2026-08-19 (2)

### Monitoreo de red (retorno propio, "a lo Jamulus")

- **Qué:** casilla **"Monitoreo de red (oír tu propio retorno)"**. En vez del
  monitor local, oís **tu propia señal de vuelta por el servidor** a la latencia
  de red — la referencia de tiempo con la que se toca en Jamulus: te adelantás a
  tu propio rebote para caer en tiempo con todos. Requiere **SFU** y auriculares.
- **Cómo:** el cliente **consume su PROPIO productor** (el servidor ya lo
  permitía; la app se auto-excluía solo del lado cliente). Ese retorno se
  reproduce por un pipeline dedicado (gain → destino) con `playoutDelayHint = 0`
  (la latencia que oís ES la de red). Se re-establece al (re)crear el productor
  (reconexión / cambio de modo); se cae solo en `teardownSfu` (P2P no tiene
  productor). Suprime el monitor local mientras está activo (para no oírte dos
  veces). Aviso hablado; si la sala no está en SFU, avisa que pulses Ctrl+Alt+S.
- **Por qué corrige el diseño:** el monitoreo de red **no** se puede en P2P (tu
  señal nunca vuelve); necesita el servidor en el bucle. Es la esencia del modelo
  de Jamulus (mezcla/retorno en servidor).

---

## 2026-08-19

### Modo ensayo (instrumentos) — casilla en Ajustes de audio

- **Qué:** casilla **"Modo ensayo (instrumentos)"** (bajo las de monitoreo) que
  exprime la latencia de WebRTC para tocar en vivo con amigos **cercanos**. Es
  per-usuario, local y persistido.
- **Cómo:** con jam **on**, la captura del micro va **sin procesar** (sin
  cancelación de eco / supresión de ruido / AGC) para tono real de instrumento y
  cero latencia de procesado, y el **buffer de jitter** de recepción baja a **0**
  (vs 50 ms). Ambas se re-aplican en vivo al alternar (re-adquiere el micro vía
  `effectiveProcessing = voiceProcessing && !jam`; ajusta `playoutDelayHint` de
  las pistas ya recibidas). Aviso hablado al activar con la guía honesta (interfaz
  + monitor directo por hardware, auriculares, P2P).
- **Honestidad / límites:** un navegador **no** iguala a Jamulus (la tubería de
  audio `getUserMedia`+WebAudio, ~40-60 ms, es infranqueable desde JS). Solo es
  *tocable* con RTT bajo (gente cercana) y en **P2P**; en SFU el audio pasa por el
  servidor y la latencia no baja (el aviso lo dice). El `.deb` de Jamulus es
  C++/Qt nativo, no reutilizable en navegador. Palancas siguientes posibles:
  puentear el limitador de envío y forzar P2P automáticamente en jam.

---

## 2026-08-05

### Auto-colarse desde la fantasma a la sala cerrada — `Ctrl+Alt+B`

- **Qué:** amplía la sala cerrada de Edu. Si te fantasmearon (entraste a una sala
  cerrada sin ser miembro y caíste en `#ghost:<sala>`), pulsar **Ctrl+Alt+B** ahora
  **te mete en la sala real** — quien conoce el atajo se cuela solo. La sala
  **sigue cerrada** para el resto: los que no conocen el atajo quedan fantasmeados
  como hasta ahora. Dentro de la sala real, el atajo sigue cerrando/abriendo como
  lo dejó Edu.
- **Cómo:** el join ahora devuelve `ghosted`. Con eso, Ctrl+Alt+B es contextual:
  si `ghosted` → `admitToRealRoom()` (nuevo), si no → `toggleRoomClosed()` (de
  Edu). `admitToRealRoom` pide al servidor un **token de miembro** de la sala real
  (evento `admit-to-room` → `realRoom.memberTokens.add(token)`), lo guarda en
  `sessionStorage` y **reconecta**: el rejoin presenta el token, el servidor lo
  reconoce como miembro y lo enruta a la sala real. Solo se añadió ESE token, así
  que la sala no se abre para nadie más.
- **Modelo de seguridad:** por oscuridad, igual que todo lo demás — conocer el
  atajo ES la llave. Aceptado explícitamente.

---

## 2026-07-22 (3)

### Cerrar la sala (privada) sin cartel — `Ctrl+Alt+B`

Para tener privacidad cuando ya están los que querés: `Ctrl+Alt+B` **cierra** la
sala. Con la sala cerrada, el que entra nuevo **no ve un cartel de "cerrada"** ni
nada — ve una **sala vacía**, como si fuera el primero y todavía no llegó nadie.
Así nadie se siente rechazado ni ustedes tienen que dar explicaciones.

- **Sala "fantasma"**: el recién llegado (sin token de miembro) se enruta a una
  sala aparte (`#ghost:<sala>`), invisible para el grupo real. Si entran **dos
  desconocidos**, se ven **entre ellos** (no a ustedes). Los de adentro **no
  reciben ningún aviso** de que alguien rebotó.
- **Reconexión protegida**: al entrar, cada uno guarda un **token** de la sala
  (sessionStorage). Si a un miembro se le corta el internet y vuelve, el token lo
  reconoce y **entra igual** aunque esté cerrada — no queda afuera por un corte.
- **Silencioso**: no se anuncia a la sala ni al chat. Solo quien pulsa escucha
  una confirmación local ("Sala cerrada" / "Sala abierta"). Es toggle: se reabre
  con la misma tecla. Estado de sala (cualquiera adentro puede cerrar/abrir).
- **Cómo**: `room.closed` + `memberTokens` (`room-manager.ts`); enrutado fantasma
  + emisión de token en el join (`signaling.ts`, evento `set-room-closed`/
  `room-closed`); estado en el store + token en sessionStorage. Probado con un
  test de integración por sockets (12/12: ghosting, reconexión por token,
  fantasmas que se ven entre sí, reapertura). Server + cliente → `git pull` +
  `pnpm build` + **reiniciar `jdh-speak`**.

---

## 2026-07-22 (2)

### Comando para forzar SFU (servidor) — `Ctrl+Alt+S`

Un comando para **pasar la sala al servidor (SFU) en cualquier momento**. Sirve
cuando la conexión anda mal: en P2P (malla, hasta 5 personas) cada uno **sube su
audio a todos los demás** (con 5 = 4 copias); en SFU **subís una sola vez** al
servidor y él reparte.

- **`Ctrl+Alt+S`** = interruptor "forzar SFU" (S de Servidor/SFU). Prendido fuerza
  el SFU; apagado vuelve al **automático** (P2P si son ≤5, SFU con 6+).
- **De sala**: el transporte es de toda la sala, así que cambia para todos (el
  server flipa el flag y re-evalúa el modo → todos hacen el switch).
- **Silencioso, como la grabación**: **no** se anuncia a la sala ni al chat —
  solo quien lo pulsa escucha una confirmación local ("Servidor forzado (SFU)" /
  "Modo automático"). Los demás adoptan el estado sin ruido.
- **Cómo**: flag `room.forceSfu` (toggleable, a diferencia de `?p2p=off` que es
  pegajoso) sumado a `shouldForceSfu`; evento `set-force-sfu`/`force-sfu`; estado
  en el join para late joiners. Server + cliente → `git pull` + `pnpm build` +
  **reiniciar `jdh-speak`**.
- (De paso corregí el `CLAUDE.md`: el umbral real es **≤5 P2P / 6+ SFU**, estaba
  escrito viejo como ≤2 / 3+.)

---

## 2026-07-22 (1)

### iPhone/iPad: capturan en MONO (sin supresión)

Los iPhone (y iPad) tienen micrófono **mono**, así que capturar en "estéreo"
genera un dual-mono falso que puede ensuciar. Ahora **cada iPhone se detecta a sí
mismo** (`isIOS`, en el cliente — no toca al server ni a los demás) y **captura en
1 canal (mono)**. Manda una señal mono limpia.

- **No supresado**: además, la supresión de ruidos (cancelación de eco / ruido /
  ganancia automática) pasa a venir **apagada por defecto también en iOS** (antes
  venía prendida en iPhone/iPad). Así el iPhone manda **mono, crudo** — no
  procesado. Igual se puede prender a mano si el entorno lo necesita.
- **Solo el iPhone**: el resto de los dispositivos siguen en estéreo, sin cambios.
- **Cómo**: `channelCount: isIOS ? 1 : 2` en `microphoneConstraints`
  (`lib/microphone.ts`) + `loadVoiceProcessing` default `false`
  (`stores/room.ts`). **Solo cliente**: `git pull` + `pnpm build`.

---

## 2026-07-21 (8)

### Ambientes desde el servidor + pack "Fields & Spaces" (exteriores)

Ahora el menú de **Ambiente** (Ctrl+Alt+A) puede crecer **sin recompilar el
cliente**: además de los espacios que vienen incluidos (los de OpenAIR en
`client/public/ir/`), el servidor sirve **impulsos extra** que se dejan en una
carpeta. Así sumamos el pack **Fields & Spaces** que pasó Cristian (exteriores:
callejón, cañón, ciudad, bosque, montaña, cantera, pueblo, etc.).

- **Carpeta del servidor** para extras (`AMBIENCE_IR_DIR`, por defecto una carpeta
  **`ir/`** en la raíz del repo — gitignored, vacía; **separada** de los incluidos
  para que no choquen): se dejan ahí archivos de audio (wav/ogg/flac/…) y **el
  nombre del archivo es el nombre que aparece en el menú**. `GET /api/ambiences`
  lista `{id,name}` (id = slug del nombre, mtime-cache como `tv/db.json`);
  `GET /api/ambiences/file?id=…` sirve el archivo **por id** (solo ids listados →
  sin traversal). El cliente los suma al menú arriba de los incluidos y **de-duplica**
  por id. Server: `server/src/index.ts`. (Para el pack de Cristian **no** usamos
  esto — lo curamos como incluidos, ver abajo.)
- **Cliente**: cada uno hace `fetch('/api/ambiences')` al entrar (así **todos**
  pueden resolver un ambiente del servidor aunque nunca abran el panel, cuando
  otro lo elige). `AmbienceDialog` muestra **incluidos + del servidor**;
  `ambienceIrUrl(id)` decide de dónde cargar el impulso (`/ir/<id>.ogg` incluido,
  o `/api/ambiences/file?id=…` del servidor). Store: `serverAmbiences`. El id del
  ambiente que se transmite subió de 32 a 128 chars (los slugs son más largos).
- **Pack Fields & Spaces → 32 exteriores incluidos (en español)**: el pack son
  **123 WAV estéreo 24-bit/48kHz (303 MB)**, con variantes de distancia. En vez de
  servir los 123 crudos (menú larguísimo, nombres en inglés, y 303 MB copiándose
  a `client/dist` en cada `pnpm build`), **curé 32 espacios distintos** (uno por
  lugar), pasados a **ogg estéreo (~2 MB total)** con **nombres en español**
  (Callejón, Cañón, Ciudad, Bosque, Montaña, Cantera, Pueblo, Represa, Colinas…),
  y los sumé como **ambientes incluidos** en `client/public/ir/` +
  `lib/ambience.ts`. Reemplacé los 2 "bosque" viejos de OpenAIR (mono) por los del
  pack (estéreo). Total del menú: **~62** (Seco + 29 interiores + 32 exteriores).
  **Para Cristian**: `git pull` + `pnpm build` + reiniciar `jdh-speak`, y **borrá
  el pack crudo** de `client/public/ir/` (los `.wav`), que ya no hace falta.

---

## 2026-07-21 (3)

### `feat/ambience` — Ambientes: efecto de espacio (reverb) para toda la sala

Para armar "fiesta sonora": un panel oculto **Ctrl+Alt+A** ("Ambiente") deja
elegir un **espacio acústico** — **Seco (sin efecto), Auto, Habitación, Baño,
Sala de concierto, Catedral, Estadio** — y **todo lo que suena en la sala** (voces
y música) sale con esa reverb, así toda la escena queda "dentro" del lugar.
Combina con el espacial (cada uno posicionado, todos en la misma sala).

- **Room-wide** como el on/off del espacial: quien lo elige lo aplica para todos
  (server `set-ambience` → `ambience`, en el join). Se **anuncia** quién lo puso.
- **Sin archivos de audio**: cada espacio es una **reverb por convolución** con un
  **impulso generado por código** (`lib/ambience.ts`) — su cola/tamaño/pre-delay
  por preset. El **húmedo (wet) está medido** para que las **voces sigan
  entendiéndose** (auto = sutil; catedral = más cola).
- **Cómo suena**: un **bus de reverb compartido** en `useMediasoup` — cada peer y
  la música mandan al bus (envío tomado post-volumen, así un peer silenciado o
  ensordecido no aporta), y el retorno húmedo va a tus parlantes. Seco hasta
  elegir. Panel `AmbienceDialog.tsx` (Ctrl+Alt+A), sin botón (como grabación/3D).
- **Deploy:** tocó server + cliente → en la Pi, `git pull` + **`pnpm build`** +
  **`systemctl restart jdh-speak`**.
- **Reverbs rehechos por geometría** (después, solo cliente): los primeros salían
  flojos. Ahora cada espacio se define por las **distancias a sus 6 paredes**, y de
  ahí se derivan **reflexiones tempranas** (un tap por pared, a su retardo real) y
  la **cola** según el tamaño. `lib/ambience.ts`.
- **Banco completo del plugin de referencia** (después): las **46 salas** con sus
  **medidas reales** (extraídas del manual del plugin) + el **brillo real de cada
  una** (de sus presets de fábrica) → Auto 1/2, Baño, Toilette, Cabina, Estudio,
  Living, Salas chica/media/grande, Oficinas, Sótano, Escalera, Pasillo, Cine,
  Conferencias, Depósito, Capilla, Iglesia, Catedral, Salón real, Sala de concierto
  1/2, Sala acústica, Grabación grande/chica, Escenario, Arena, Batería, Voces,
  Cuerdas, Ambientes/Placas, Calle, Callejón. Sin inventar nada. El convolver
  corre **sin normalizar** (energía cruda, con tope de pico para no clipear).

---

## 2026-07-21 (7)

### `ambience` — banco 100% REAL: 31 espacios grabados, fuera todo lo procedural

El motor procedural no daba realismo. Ahora **todos** los ambientes son
**impulsos reales grabados** (convolución de lugares de verdad) — se borró el
generador sintético entero. 31 espacios de **OpenAIR** (CC-BY, crédito en el
panel), bundleados en `client/public/ir/*.ogg` (~1,1 MB total, carga on-demand):
Catedral, Capilla, Iglesia (x2), Sala de concierto, Auditorio, Teatro, Salón
grande / de club / de mármol, Estudio, Sala, Aula, Atrio, Museo, Escalera, Túnel,
Mina, Cueva, Tumba, Cámara neolítica, Torre, Mausoleo, Reactor nuclear, Depósito,
Polideportivo, Mazmorra, Cancha techada, Horno de cal, Bosque (verano/nieve).
`lib/ambience.ts` quedó reducido a la lista + carga en `applyAmbience`. Si un
impulso no carga, queda seco (sin fallback sintético). Solo cliente → `pnpm build`.

---

## 2026-07-21 (6)

### `ambience` — impulsos REALES (convolución de espacios grabados) + fin de la saturación

- **Saturación arreglada:** el "energía cruda" (convolver `normalize=false`) hacía
  que las colas largas acumularan energía y **clipearan**. Volví a **normalizar** y
  bajé el wet a 0.3 — limpio en vez de reventado.
- **Impulsos reales:** 5 espacios ahora usan **IRs reales grabados** (convolución
  de verdad, no sintético): **Catedral** (St Paul's), **Capilla** (Lady Chapel, St
  Albans), **Sala de concierto 1** (Jack Lyons), **Salón real** (Central Hall),
  **Escalera** (todos de **OpenAIR**, CC-BY, con crédito en el panel). Van
  bundleados en `client/public/ir/*.ogg` (17–123 KB) y se cargan on-demand al
  elegir el ambiente (con caché). Los demás siguen procedurales (los espacios
  chicos/secos como auto/oficina no existen como IR real). Marcador `real` en
  `lib/ambience.ts`; carga en `applyAmbience` (`useMediasoup.ts`).
- **Deploy:** solo cliente → `git pull` + **`pnpm build`**.

---

## 2026-07-21 (4)

### `feat/music-centered` — la música no sigue el 3D: queda centrada

Antes, cuando un participante reproducía (archivo/URL/TV/serie o compartía audio),
esa música iba mezclada en su pista de voz y **se paneaba a su asiento 3D** — la
música "seguía" a la persona por la sala. Ahora **mientras alguien reproduce, su
pista queda centrada** (nunca espacializada), como el caster de música.

- **Cómo:** nuevo flag por peer `streaming` (server, espejo de `muted`): el cliente
  emite `set-streaming` cuando arranca/para de reproducir o compartir, el server
  lo difunde (`peer-streaming`) y lo manda en el join. `applySpatialLayout` centra
  a los peers con `isStreaming` (además de los casters `isMusic`).
- **Nota:** mientras alguien reproduce, su **voz también queda centrada** (es una
  sola pista) — es el trade-off para que la música no se mueva.
- **Deploy:** server + cliente → `git pull` + `pnpm build` + `systemctl restart jdh-speak`.

---

## 2026-07-21 (2)

### `feat/spatial-walk` — audio espacial: caminar con flechas, sin distancia, auto-ubicar

Reforma del **audio espacial** que había armado Cristian (asientos 3D room-wide,
Ctrl+Alt+E para prender, panel oculto Ctrl+Alt+U). Cambios pedidos por el usuario:

- **Posicionar "caminando" con las flechas** en vez de sliders de ángulo: en el
  panel Ctrl+Alt+U, con un participante elegido, **↑ adelante, ↓ atrás, ← izquierda,
  → derecha** te mueven por el piso; **Re Pág / Av Pág** suben y bajan la altura.
  También hay botones. La posición se **habla como dirección** ("Adelante a la
  izquierda, arriba"), nunca números. Modelo (x piso izq/der, z piso atrás/adelante,
  y altura) en `lib/spatial.ts`.
- **Se sacó la distancia** (el eje en metros que bajaba el volumen + el filtro de
  agudos). Ojo Cristian: **esto revierte a propósito** tu eje de distancia — el
  usuario lo consideró "inventado" (no parte del 3D real, solo volumen). Ahora el
  panner es **dirección pura** (`rolloffFactor 0`), así caminar nunca cambia qué
  tan fuerte suena nadie. La **altura se mantuvo** (aunque con HRTF genérico casi
  no se note).
- **Casilla "Posicionar automáticamente a todos"**: al marcarla, **todos** los
  participantes ocupan un lugar del reparto parejo (arco al frente, radio fijo,
  ninguno en el centro, sin dos en el mismo lugar), ignorando las posiciones
  configuradas — que **quedan guardadas**, así al desmarcarla cada uno vuelve a la
  suya. Es room-wide como el on/off (server `set-spatial-auto` → `spatial-auto`).
  El reparto se calcula sobre **toda la sala** (vos + los demás, por nombre), así
  es idéntico en cada cliente.
- **Modelo del asiento cambió** de `{az, el, dist}` a `{x, z, y}` — server
  (`room-manager.ts`, validación en `signaling.ts`) y cliente. El mapa es en
  memoria, no hay nada que migrar.
- **Deploy:** tocó server + cliente → en la Pi, `git pull` + **`pnpm build`** y
  **`systemctl restart jdh-speak`**.

---

## 2026-07-21

### `feat/serieteca` — Serieteca: biblioteca de series de audio en la sala

- **Qué:** botón **"Serieteca"** en la barra → diálogo con **buscador**, secciones
  **"Continuar escuchando"** y **"Últimas agregadas"**, y el resto del catálogo
  **agrupado por país**. Al elegir una serie **suena para toda la sala** y **el
  diálogo queda abierto** (se puede seguir buscando/eligiendo). El reproductor
  (en el pie, igual que TV) agrega selector de **temporada** y de **episodio**
  (se oculta el de temporada si la serie tiene una sola), botones **siguiente /
  anterior / reiniciar episodio**, atajos **Alt+K/J/L/S/A/R/I** y un
  `announce()` por episodio — todo gateado a que haya una serie activa para no
  taparle los atajos a TV/archivo/URL.
- **Cómo:**
  - **Un `.m4b` continuo por serie** en archive.org — no hay un archivo por
    episodio. Cada "capítulo" es un **rango en milisegundos** (`inicio`/`fin`)
    dentro de ese único archivo, y los offsets son **continuos entre
    temporadas**. La lista de episodios sale de aplanar y ordenar los
    `capitulos` de todas las `temporadas` por `inicio`; reproducir el episodio
    *i* es **buscar (`seek`) a `inicio/1000`** dentro del mismo `<audio>`, no
    cambiar de archivo. `client/src/lib/serieteca.ts` (Task 2).
  - **Catálogo** leído directo de `https://archive.org/download/m4bua/series.json`
    (tiene CORS, no necesita el proxy). El `.m4b` en sí **no** tiene CORS, así
    que su `src` sí va por `/api/audio-proxy` (mismo origen).
  - **Proxy:** el proxy sólo re-emitía audio con `Content-Type: audio/*`
    reconocido; archive.org sirve los `.m4b` como
    `application/octet-stream`, así que caían al **transcodificador**, que
    rompe el seek por Range que necesita el reproductor de episodios. Se le
    enseñó a `browserPlayableAudioType` (`server/src/audio-sources.ts`,
    `fac86aa`) a reconocer extensiones reproducibles conocidas (`.m4b`, `.m4a`,
    `.mp3`, …) cuando el content-type upstream es binario genérico, y a
    servirlas por la **vía directa con Range** en vez de transcodificar.
  - **Difusión a la sala:** reutiliza el mismo grafo que archivo/TV — un
    `<audio>` dedicado → `createMediaElementSource` → `fileVolumeGain →
    outDest`, **un solo productor de voz**, **sin forzar SFU**.
    `startSerie`/navegación de episodios en `useMediasoup.ts` (`e272d43`).
  - **Progreso ("continuar escuchando")** es **por navegador**, en
    `localStorage` (`jdh-speak:serieteca:progress`) — sin cuentas ni servidor.
  - Store (`client/src/stores/room.ts`, `300636d`/`dc00aa9`), diálogo
    (`SerietecaDialog.tsx` + botón en `AudioControls.tsx`, `44d217e`),
    controles de temporada/episodio + atajos (`Room.tsx`/`useMediasoup.ts`,
    `69b0442`).
  - **Sin binarios nuevos en el servidor** — `<audio>` HTML plano, nada de
    Shaka/DRM (a diferencia de TV en vivo).
- **Por qué / riesgos:** el `.m4b` sirve **audio-only** de por sí (no hay pista
  de video que filtrar, a diferencia de TV). El riesgo queda del lado del
  Range: falta la prueba en vivo con un **2º peer** confirmando que el seek por
  episodio funciona de punta a punta a través del proxy en producción (se
  verificó local/manual, no con dos participantes reales).
- **Fuera de v1 (YAGNI, no está en la app de referencia que copiamos):** cuentas
  de usuario, progreso/estadísticas en servidor, vinculación de dispositivos TV.
- **Deploy (para Cristian):** esto tocó **código de server** (el proxy
  `browserPlayableAudioType`), así que al hacer `git pull` en la Pi hace falta
  **`pnpm build`** (cliente) **y `systemctl restart jdh-speak`** (server) — no
  alcanza solo el build. **No hay archivo nuevo que colocar**: el catálogo se
  baja solo de archive.org (`series.json`), sin `db.json` ni binarios nuevos.

---

## 2026-07-20 (2)

### `feat/log-client-ip` — loguear la IP real del cliente junto al nombre

- **Qué:** el log del servidor ahora incluye la **IP real** del cliente en las
  líneas de conexión/entrada, p. ej.
  `[ws] abc123 joined jdh as "crichu" [186.122.224.201]`. Permite mapear IP↔nombre
  (para saber quién es quién en el log de Caddy, o quién machaca el servidor).
- **Cómo:** helper `clientIp(socket)` en `server/src/signaling.ts` que lee la
  **primera** entrada de `X-Forwarded-For` (Caddy la reenvía; `handshake.address`
  siempre sería el proxy `127.0.0.1`), con fallback a la dirección directa en dev.
  Se usa en los `console.log` de `connected` y `joined`.
- **Cómo consultarlo:**
  `journalctl -u sonicroom | grep -oP 'as "\K[^"]+" \[[^]]+' ` (o similar) da los
  pares nombre↔IP.
- **Privacidad:** deja las IP de los participantes en el journal del sistema
  (ya estaban en el log de Caddy). Aceptado a propósito.

---

## 2026-07-20

### `feat/tv-live-channels` — TV en vivo: canales de TV en la sala

- **Qué:** botón **"TV en vivo"** en la barra → diálogo con las **categorías como
  encabezados** (navegables con H en NVDA) y **un botón por canal** debajo (de
  `tv/db.json`, servido por el server). Al elegir un canal, **suena para toda la
  sala** y **el diálogo queda abierto** (se cambia de canal sin reabrir; se cierra
  con la X o Escape). Se controla desde el pie del reproductor (volumen + detener).
  **Escape ya no cierra el reproductor** (así seguís usando la plataforma con algo
  sonando).
- **Cómo:**
  - Server: `GET /api/tv-channels` lee `tv/db.json` (gitignored, dato de
    despliegue con llaves DRM; re-lee al cambiar el mtime). Parser + test en
    `server/src/tv-channels.ts`. Se versiona `tv/README.md`.
  - Cliente: DASH+ClearKey descifrado con **Shaka Player** en el navegador
    (`import()` diferido → chunk async propio, no infla el bundle). Un `<audio>`
    dedicado enrutado por `fileVolumeGain → outDest` (misma vía que un stream de
    URL, **sin productor aparte**, no fuerza SFU). `startTvChannel` en el hook;
    `TvDialog.tsx`; `lib/tv.ts`.
  - Al arrancar un archivo/URL mientras la TV suena, la TV se corta primero
    (evita doble audio).
  - **Solo audio** (`b2e843a`): `player.configure({ restrictions: { maxHeight: 0 } })`
    → Shaka elige la variante de solo audio y **nunca baja el video**. Verificado en
    el navegador: una sola representación `audio/mp4` (`.m4a`, ~49 KB/segmento),
    cero segmentos de video, ~150–200 kbps (comparable a compartir música, no video).
    **No sacar `maxHeight: 0`** o vuelve a bajar video de varios Mbps.
  - **Errores a la vista** (`8e5fa80`): si un canal no carga, se limpia todo, se
    **anuncia** (`tv_play_error` / `tv_unsupported`) y el diálogo muestra un aviso
    — clave para el usuario ciego (antes fallaba en silencio).
- **CORS:** el `fetch` directo a un segmento del CDN dio 200 con cuerpo legible, así
  que la re-emisión a la sala debería andar; falta el test final con un 2º peer real.
- **Fuera de v1:** timeshift, selección de idioma, grabación, panel de
  administración de canales.
- **Requisito:** Chrome (EME/ClearKey). `tv/db.json` en el servidor con
  `{ nombre, categoria, url(.mpd), key: "kid:key" }`.

---

## 2026-07-17

### `docs` — Guía para montar un TURN propio (tarea pendiente de infra)

- **Qué:** nueva **[`docs/turn-server.md`](docs/turn-server.md)** — runbook
  completo para dejar de depender del coturn ajeno (`turn.oriolgomez.com`, el VPS
  de Oriol compartido con sus juegos) y montar el nuestro. Aviso destacado en
  `CLAUDE.md` para que cualquier Claude lo vea al hacer pull.
- **Por qué importa:** el TURN es el *fallback* de conectividad. Si ese servidor
  ajeno se cae o rota credenciales, se rompe el **P2P** en NAT simétrico / redes
  restrictivas y el **fallback TCP/TLS del SFU**. El camino normal del SFU (UDP
  directo al Pi) **no** se ve afectado — por eso el problema está **latente**: no
  se nota hasta que alguien entra desde una red difícil.
- **Contexto útil:** el SFU anda estable con gente de afuera → el Pi **ya es
  alcanzable** (no hay CGNAT), así que correr coturn en el mismo Pi es viable;
  solo hay que abrirle sus puertos (3478 udp/tcp, 5349 tcp, 49152–65535 udp).
- **Incluye:** requisitos, config de `turnserver.conf` (con `external-ip` para el
  NAT del router, rangos privados denegados), firewall/reenvío, TLS opcional,
  alternativa administrada (Cloudflare/Metered), **el cambio de código** para que
  `ICE_SERVERS` salga del entorno (inyectado por el server como ya se hace con
  `INSTANCE_NAME` → sin rebuild), cómo probar candidatos `relay`, y un checklist.

---

## 2026-07-17

### `de632bf` — TURN propio: fuera la dependencia del servidor de Oriol

- **Qué:** ya **no dependemos del coturn prestado** (`turn.oriolgomez.com`, el VPS
  de Oriol). Corremos **nuestro propio coturn en la Raspberry**, y los servidores
  ICE se configuran desde el `.env` del despliegue en vez de estar hardcodeados
  con credenciales ajenas dentro del repo.
- **Cómo (código):** `buildIceServers()` en `server/src/index.ts` lee `TURN_URLS`,
  `TURN_USERNAME`, `TURN_CREDENTIAL` y `STUN_URLS` y los inyecta en el HTML
  servido como `__JDH_SPEAK_CONFIG__.iceServers` (mismo mecanismo que
  `INSTANCE_NAME`). El cliente los lee con `getIceServers()`
  (`client/src/lib/ice.ts`), con **fallback a solo STUN** si no hay nada.
  ⇒ Cambiar de TURN = editar `.env` + reiniciar, **sin rebuild del cliente**, y
  **sin credenciales en el repo**.
- **Cómo (infra):** en vez de abrir un rango nuevo (el enfoque naíf pedía 16.384
  puertos), se **repartió el rango que el router ya reenviaba**: mediasoup pasó a
  `40000–40059` (`rtcMaxPort`) y el relay de coturn usa `40060–40100`. Solo hizo
  falta **1 puerto nuevo** en el router: el `3478`. ⚠️ **Deben seguir disjuntos.**
- **Seguridad:** autenticación obligatoria (`lt-cred-mech` + credencial de 24
  bytes aleatorios), **todos los rangos privados denegados** (`denied-peer-ip`, así
  el TURN no sirve para tocar la LAN), cuotas (40 allocations, ~2 Mbit/s por
  sesión), `no-cli`, y `5349` ni se abre (`no-tls`/`no-dtls`). Verificado: con
  credencial relayea (0 pérdidas, UDP y TCP); **sin credencial es rechazado**.
- **Fiabilidad:** el timer que ya actualizaba `ANNOUNCED_IP` ahora también
  actualiza el `external-ip` de coturn y lo reinicia — si el ISP cambia la IP, el
  TURN no queda anunciando una IP muerta.
- **Por qué:** el TURN es el fallback para NAT simétrico y redes restrictivas
  (y el fallback TCP del SFU). Era una dependencia latente: nada parecía roto
  hasta que alguien entraba desde una red difícil y el servidor ajeno fallaba.
- **Detalle completo:** `docs/turn-server.md`.

---

## 2026-07-15

### `25ec76e` — Sonidos de eventos personalizables por el operador (con fallback sintetizado)

- **Qué:** el operador puede **reemplazar los sonidos** de la app (entrar, salir,
  chat, silenciar, compartir…) dejando un archivo de audio por evento en el
  servidor. Si un evento tiene archivo, **todos los clientes** lo reproducen al
  ocurrir; si no tiene, suena el **sonido sintetizado** de siempre. Un solo sonido
  para toda la sala.
- **Cómo:** el servidor sirve la carpeta raíz `sounds/` en `/sounds`
  (`server/src/index.ts`, `express.static` con `fallthrough:false` para que un
  archivo ausente dé 404 y no caiga a la SPA). El cliente
  (`client/src/lib/sounds.ts`) sondea `/sounds/<cue>.{mp3,wav,ogg}` con
  `cache:"no-cache"`, decodifica y cachea una vez (`preloadCueSamples` al crear el
  `AudioContext`); `playCue` reproduce el sample si existe, si no el sintetizado.
  Es **local** (mismo camino que el sintetizado): no se transmite por la llamada,
  cada quien reproduce su copia — cero ancho de banda extra.
- **Nombres reconocidos:** `<cue>.mp3` (o `.wav`/`.ogg`) donde cue es `join`,
  `leave`, `message`, `mute`, `unmute`, `peer-mute`, `peer-unmute`, `thunk`,
  `share-start`, `share-stop` (ver `sounds/README.md`). Los audios **no** se
  versionan (son por despliegue); solo el README.
- **Operación:** dejar/añadir archivos en `/home/pi/jdh-speak/sounds/` **no**
  requiere rebuild ni reinicio (recarga forzada en el navegador para saltar
  caché). El único reinicio fue el de añadir la ruta la primera vez.
- **Por qué:** poder darle identidad sonora a la instancia sin tocar código, igual
  que el rebrand por `INSTANCE_NAME`.

---

## 2026-06-29

### `a87f76f` — Stream de URL: solo volumen; y monitor opcional del audio compartido

- **Qué (1):** al abrir un **stream de URL** (m3u8/mp3 radio), el reproductor
  muestra **solo el control de volumen** (más el título y cerrar). Se ocultan
  progreso, transporte, lista y los botones de abrir **hasta que el stream se
  cierra**. (Para archivos/carpeta locales sigue el reproductor completo.)
- **Qué (2):** el **audio de compartir pestaña/pantalla** puede reproducirse
  también por **tu dispositivo de salida elegido** (sigue el altavoz de la app),
  para oírlo donde escuchás. Es un **toggle opcional** en Ajustes ("Oír el audio
  compartido en tu dispositivo"), **apagado por defecto** — puede generar **eco**
  si la pestaña ya suena en ese mismo dispositivo.
- **Cómo:** flag de sesión `playerIsUrl` (se setea en `startUrlStream`, se limpia
  en `startPlaylist`/`stopFileStream`); el `FileStreamPlayer` recibe `isUrlStream`
  y renderiza mínimo. Para compartir: store `shareMonitor` (persistido) +
  conexión `displaySource → destination` (en `startAudioShare` y un efecto en
  vivo); casilla en `DeviceSettings`.
- **Por qué:** un stream en vivo no tiene posición/lista que controlar, solo
  volumen; y poder oír lo compartido por el dispositivo propio.

### `8a6e432` — Arreglo del aleatorio (al togglear) y quita de los botones ±10 s

- **Qué:** el **aleatorio** ahora reordena de verdad. Antes, el orden de
  reproducción se armaba **solo al cargar la lista**, así que activar aleatorio
  en marcha dejaba un orden secuencial viejo → "siguiente" y el auto-avance iban
  en secuencia. También se **eliminan los botones de Retroceder/Avanzar 10 s**.
- **Cómo:** nuevo `togglePlayerShuffle` en el hook que **rebaraja el orden al
  togglear** (aleatorio con la pista actual primero al activar; secuencial al
  desactivar); `Room` lo usa en vez de solo setear el flag. Se quitan los dos
  botones ±10 s de `FileStreamPlayer` (las flechas Alt/Mayús/Ctrl siguen
  buscando, comparten `onSeekBy`); se podan `player_back10`/`player_fwd10`.
- **Por qué:** el aleatorio no era aleatorio. **Repetir** se verificó: funciona
  (repetir-una repite la pista; repetir-todas da la vuelta) — se mantiene.

### `89e5d09` — Reproductor como footer de página completo; sin velocidad; orden de abajo hacia arriba; Ctrl+Fin

- **Qué:** el reproductor virtual pasa a ser una **barra de ancho completo al pie
  de la página** (después de la barra de controles, en flujo), no una ventana
  flotante — así queda último en el orden de lectura y fácil de alcanzar en NVDA.
  Orden de abajo hacia arriba: **Abrir archivos** (lo más abajo) → **Abrir
  carpeta** → **volumen** → el resto del transporte arriba. **Ctrl+Fin** lleva el
  foco a "Abrir archivos". Se **elimina la velocidad** por completo.
- **Cómo:** `FileStreamPlayer` cambia el contenedor flotante por una barra
  full-width y apila los botones de abrir (carpeta arriba, archivos abajo, con
  `id="player-open-files"`); maneja Ctrl+Fin en su `onKeyDown`. En `Room` el
  reproductor se renderiza tras el `</footer>` de controles, con un handler
  global de Ctrl+Fin y Ctrl+Alt+P que enfoca el reproductor si está visible. Se
  quita la velocidad del store (`playerRate`/`setPlayerRate`), del hook
  (`playbackRate`) y de la UI; se poda `player_speed`.
- **Por qué:** pedido del dueño — footer real abajo de todo, controles en el
  orden que usa, y sin la velocidad.

### `d9a1c88` — Separar "Abrir URL" del reproductor virtual; eliminar la biblioteca del servidor

- **Qué:** reorganización de las fuentes de audio, una función por control y sin
  opciones duplicadas:
  - **Se elimina la biblioteca del servidor** por completo (navegador en el
    cliente + endpoints, helpers y tests del server).
  - **"Abrir URL"** pasa a ser su propio botón en la barra → un diálogo mínimo
    (mp3 / m3u8 / radio…), separado del reproductor.
  - **"Abrir reproductor virtual"** abre el reproductor a demanda. Puede abrirse
    vacío: si no hay nada cargado muestra solo los botones **Abrir archivos /
    Abrir carpeta** + una pista; al cargar algo aparecen transporte, lista y
    velocidad/volumen.
  - **Abrir archivos / Abrir carpeta viven SOLO en el reproductor**, agrupados
    **al pie** (footer) para encontrarlos fácil en NVDA. Ya no hay un diálogo
    aparte (se elimina el `AudioSourceDialog` combinado).
  - Cerrar el reproductor (la X o el botón de la barra) detiene la emisión y lo
    oculta.
- **Cómo:** nuevo `UrlDialog.tsx`; `FileStreamPlayer` acepta `name` nulo (estado
  vacío) y mueve los botones de abrir al pie; `AudioControls` cambia el único
  botón "Emitir audio" por dos ("Abrir reproductor virtual" + "Abrir URL");
  `Room` maneja `playerOpen`/`urlOpen`. En el server se quitan
  `/api/audio-library{,/file}`, `resolveLibraryPath`, `classifyLibraryEntries`,
  `isAudioFileName`, `AUDIO_LIBRARY_DIR` y `startServerFileStream`. Se podan las
  claves i18n muertas.
- **Por qué:** no repetir lo mismo en dos lugares y separar funciones (URL vs.
  archivos locales); quitar la biblioteca que no se usa.
- **Notas:** en Windows, los tests de lifecycle del transcode (timers falsos /
  spawn simulado) figuran como fallidos — son **preexistentes** (antes salían
  "cancelled" por el cascade del test de `resolveLibraryPath`); en Linux pasan.
  tsc (cliente+server), lint y build: en verde.

### `824fc0a` — Reproductor: abrir archivos/carpeta sobre la marcha, sin diálogo de subida, con subcarpetas

- **Qué:** botones **"Abrir archivos"** y **"Abrir carpeta"** siempre visibles en
  el reproductor, para cambiar de fuente mientras suena algo, sin pasar por el
  diálogo. Abrir una fuente **no frena** la pista actual: hace crossfade a la
  nueva. "Abrir carpeta" ya **no muestra** el "¿Subir N archivos?" y carga
  **todas las subcarpetas** (todos los tracks, en orden de carpeta). "Abrir
  archivos" acepta uno o varios archivos → lista (orden por nombre).
- **Cómo:**
  - Selector de carpeta vía **File System Access API** (`showDirectoryPicker`),
    que evita el diálogo de subida y permite recorrer subcarpetas
    recursivamente; si el navegador no la tiene (Firefox/Safari) cae al
    `<input webkitdirectory>` de siempre. Nueva `client/src/lib/audioFolder.ts`.
  - En el hook, `startFolderStream`/`startFileStream` se unifican en un solo
    `startPlaylist(File[])` (ya ordenado); `startFolderStream` queda como wrapper
    que ordena por ruta relativa para el fallback del input. Al cambiar de lista
    se revocan los object URLs viejos **después** del crossfade (sin fuga ni
    corte de la pista que se desvanece).
  - Botones nuevos en `FileStreamPlayer.tsx`; handlers `openFiles`/`openFolder`
    en `Room.tsx`, compartidos con el diálogo de fuentes.
- **Por qué:** poder ir cambiando de música en vivo sin fricción ni cortes.
- **Notas:** lo de "sin diálogo de subida" aplica en Chromium (la API). Aleatorio
  y repetir ya estaban visibles (verificado, sin cambios).

### `d6ca2fe` — Tu nivel de micrófono controla también la placa secundaria

- **Qué:** el slider **"Tu nivel de micrófono"** ahora mueve el volumen de la
  placa **secundaria** además del micro. Antes solo afectaba al micro.
- **Cómo:** `secondaryGain` deja de estar fijo en `1×`. Se inicializa al nivel
  actual del micro al adquirir la placa, y `setMicGain` rampa `secondaryGain`
  junto con `micGain` (`client/src/hooks/useMediasoup.ts`).
- **Por qué:** el monitor de la secundaria se toma post-ganancia (ver entrada
  anterior). Para que ese monitor siga tu volumen **y** siga igualando lo que
  reciben los demás, el envío de la secundaria tiene que seguir tu nivel.
  Consecuencia aceptada: al bajar tu nivel, la secundaria baja **para todos**.
  Es solo ganancia (no compresión), así que no afecta la dinámica de la música.

---

## 2026-06-28

### `c2c6db8` — Monitoreo al mismo volumen que recibe la gente

- **Qué:** los monitores locales (oírte a vos mismo) suenan al volumen que
  reciben los demás, no a volumen crudo.
- **Cómo:** el monitor se toma **después** de la ganancia: `micGain → destination`
  (placa 1) y `secondaryGain → destination` (placa 2), en vez de la fuente cruda
  (`client/src/hooks/useMediasoup.ts`). Siguen siendo solo nodos de ganancia, así
  que no agregan latencia. `micGain` es permanente, por eso el monitor del micro
  sobrevive a cambios de dispositivo sin re-cablear.
- **Por qué:** antes el monitor salía antes de la ganancia, así que bajar tu
  nivel no cambiaba lo que oías.

### `90e784d` — Arreglos del reproductor, rename a JDH Speak, limpieza, monitor de micrófono

Un commit grande con varias cosas:

**Reproductor:**
- **Volumen "para todos" baja también tu monitor.** El monitor del archivo pasa
  por `fileVolumeGain` (antes iba `source → destination` directo, saltándoselo).
- **Cambio de pista con fade-out.** Elegir una pista/carpeta nueva mientras suena
  otra hace crossfade en vez de cortar. Se extrajo el helper `crossfadeTo`; se
  eliminaron ~90 líneas frágiles de "re-bind" en `startFolderStream`.
- **Fix del corte al saltar rápido.** La pista nueva se callaba a los segundos
  porque un temporizador viejo de "pausar pista" del slot destino seguía vivo.
  Ahora se invalida ese temporizador antes de cargar la pista nueva.
- **Lista de canciones con un solo foco.** La lista es un `listbox` único
  (`aria-activedescendant`): ↑/↓ mueven el cursor, Enter/Espacio reproduce,
  Inicio/Fin saltan. Antes cada pista era un tab-stop (`FileStreamPlayer.tsx`).
- **Volumen como slider 0–100%, paso 1%** (antes 5 presets). Con foco en el
  reproductor, ↑/↓ ajustan el volumen de a 1.
- **Las pistas arrancan siempre desde el principio.** Se eliminó la reanudación
  de posición (no recuerda dónde quedaste en una pista).
- **m3u8 / HLS.** Pegando una URL `.m3u8` en "Emitir audio → URL" se reproduce
  **solo el audio** (aunque sea un video), vía el transcode de ffmpeg del proxy
  (`-vn`). Arreglo: los manifiestos servidos como `audio/(x-)mpegurl` se enrutan
  al transcoder en vez de servirse crudos (`server/src/audio-sources.ts`).
  Requiere `ffmpeg` instalado. No funciona con DRM (Widevine/FairPlay).

**Monitor de micrófono:** casilla **"Monitorear micrófono"** en tu tarjeta (entre
"Cambiar nombre" y tu nivel), persistida. Te oís a vos mismo. (Ojo: con parlantes
genera eco; usá auriculares.)

**Rename SonicRoom → JDH Speak (en todo):** código, configs, claves de
localStorage (`jdh-speak:*`), global de runtime (`__JDH_SPEAK_CONFIG__`),
etiquetas SDP, nombre del paquete, archivos de descarga, y el servicio systemd
(`jdh-speak.service`, `/home/jdh-speak`). Detalle de migración al principio de
`CLAUDE.md`.

**Código muerto eliminado:**
- Todo el subsistema de **atenuado automático** del cliente (el server ya no lo
  maneja, así que estaba inerte).
- El estado de **push-to-talk** del store (ningún componente lo usaba).

---

## Antes (base previa)

Lo anterior a `90e784d` (rebranding inicial, simplificación, Spanish-only,
compartir/emitir sin forzar SFU, anuncios mínimos, dispositivo secundario,
reproductor estilo VLC) ya estaba en `origin/main`. Las especificaciones y planes
de esos cambios están en `docs/superpowers/specs/` y `docs/superpowers/plans/`.
