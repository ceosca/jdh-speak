# Registro de cambios (CHANGELOG)

> **Convención (para Cristian y para Claude):** cada vez que hacemos `git push`,
> anotamos acá lo que quedó: **qué** se cambió, **cómo** se hizo y **por qué**.
> Sirve para entender el estado actual sin leer todo el código —
> especialmente si Claude pierde el contexto. Lo más nuevo va arriba. Cada
> entrada lleva el hash del commit.

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
