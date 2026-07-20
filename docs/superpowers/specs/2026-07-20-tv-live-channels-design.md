# Diseño: Canales de TV en vivo ("TV en vivo")

**Fecha:** 2026-07-20
**Estado:** Aprobado (pendiente de plan de implementación)

## Contexto

El dueño quiere ver/oír canales de TV en vivo dentro de JDH Speak. Ya existe una
herramienta autónoma en `tv/` (`index.html` + `db.json`) que reproduce canales
**DASH (`.mpd`) con DRM ClearKey** usando **Shaka Player** del lado del cliente
(descifra en el navegador vía EME). `db.json` es un array de canales:

```json
{ "nombre": "TELEFE AMBA", "categoria": "Argentina",
  "url": "https://.../variant.mpd", "key": "KID_hex:LLAVE_hex" }
```

Encaja con la infraestructura existente: el audio de un canal se puede mezclar en
la pista de voz (como el streamer de URL) para que lo oiga toda la sala, y el
descifrado lo hace Shaka en el cliente (no hace falta ffmpeg en el servidor).

## Decisiones tomadas (con el dueño)

1. **A quién suena:** el canal **se emite a toda la sala** (se mezcla en la pista
   de voz, igual que "Abrir URL" / compartir música). No fuerza SFU.
2. **Controles del canal:** **mínimos** — reusa el pie del reproductor existente
   en modo "solo volumen" (volumen + detener), igual que un stream de URL.
3. **El diálogo de canales NO se cierra al elegir:** queda abierto para poder
   cambiar de canal sin reabrirlo; se cierra a mano con su **X** o con **Escape**.
4. **Escape ya no cierra el reproductor** (cambio global en `FileStreamPlayer`):
   el canal (o cualquier fuente) sigue sonando mientras se usa el resto de la
   plataforma. Se cierra con la **X** o el botón de la barra. (Escape SÍ cierra
   el diálogo de canales, que está por encima — ver punto 3.)
5. **Datos:** el servidor maneja los canales (**opción A**): sirve `tv/db.json`
   en un endpoint; Cristian edita el archivo a mano. `db.json` **gitignored**
   (dato de despliegue con llaves DRM); se versiona solo un `tv/README.md`.
6. **DRM/reproducción:** **Shaka Player en el cliente**, ClearKey desde el campo
   `key` (`kid:key`). Shaka se **carga bajo demanda** (`import()` dinámico) para
   no inflar el bundle principal.

## Arquitectura

### Servidor (`server/src/index.ts`)

- Nuevo endpoint **`GET /api/tv-channels`**: lee `tv/db.json` (ruta relativa a la
  raíz del repo, junto a `sounds/`), lo parsea y devuelve el array. Con una
  **cache chica** (p. ej. relee si cambió el mtime) para no leer disco en cada
  pedido pero reflejar ediciones sin reiniciar. Si el archivo no existe o está
  mal formado → `200` con `[]` (TV opcional, no rompe la app) + log.
- Se sirve bajo `/api/*` (no una carpeta estática nueva) para que el **proxy de
  Vite en dev** lo cubra sin config extra.
- `tv/db.json` va al **`.gitignore`**; se versiona `tv/README.md` con el formato
  y los nombres de campo.

### Cliente — selección de canal (`TvDialog.tsx`, nuevo)

- Modal nativo (`<dialog>`, como `UrlDialog`): al abrir, `fetch("/api/tv-channels")`.
- Agrupa por `categoria`; **cada categoría es un encabezado** (`<h3>`, navegable
  con H en NVDA) y debajo un **botón por canal** (orden alfabético). Lista
  dinámica: sale de `db.json`, no hardcodeada.
- Estados: cargando / vacío / error (banner accesible).
- Elegir un canal → `onPlayChannel(channel)` y el **diálogo QUEDA ABIERTO** (para
  cambiar de canal rápido). Se cierra solo con su botón **X** o con **Escape**
  (`onCancel` del `<dialog>`). Puede marcarse el canal activo (`aria-current`).

### Cliente — reproducción (`useMediasoup.ts`)

- **Carga diferida de Shaka:** `const shaka = (await import("shaka-player")).default`
  la primera vez; se instala `shaka.polyfill.installAll()` una vez.
- Un **`<audio>` dedicado a TV** (creado una sola vez;
  `createMediaElementSource` solo admite una llamada por elemento) manejado por
  una instancia de `shaka.Player`.
- `startTvChannel(channel)`:
  1. `stopFileStream()` — la fuente del streamer es única (archivo | URL | TV son
     mutuamente excluyentes); se corta lo que hubiera.
  2. Asegura `fileVolumeGain` (se extrae un helper `ensureFileVolumeGain()` desde
     `ensureFileSlots`, que crea el nodo y lo conecta a `outDest` + monitor).
  3. Conecta el `tvSource` (del `<audio>` de Shaka) a `fileVolumeGain`
     → `outDest` → **viaja en la pista de voz a toda la sala**; y al monitor local.
  4. Parsear `key` → `const [kid, k] = key.split(":")`; `player.configure({ drm:
     { clearKeys: { [kid]: k } } })`; `await player.load(channel.url)`; `play()`.
  5. `setFileStream(channel.nombre)` + `setPlayerIsUrl(true)` → el pie del
     reproductor lo muestra en modo "solo volumen".
- **`stopFileStream` extendido:** si hay TV activa, además `player.unload()` /
  `destroy()` según convenga, pausar el `<audio>` de TV y desconectar `tvSource`.
- El **volumen** (slider del pie / flechas ↑↓) ya controla `fileVolumeGain` → cubre
  TV sin cambios. Nada de productor aparte → no fuerza SFU.

### Cliente — barra de controles (`AudioControls.tsx`) y `Room.tsx`

- Nuevo botón **"TV en vivo"** (icono tipo `Tv`/`MonitorPlay`) al lado de
  "Abrir URL". `onOpenTv` abre el `TvDialog` (estado `tvOpen` en `Room`).
- `Room` conecta `onPlayChannel` → `startTvChannel` (nuevo, del hook).

### Cambio en `FileStreamPlayer.tsx`

- Quitar el manejo de **Escape** en `onKeyDown` (hoy llama `onClose`). El
  reproductor solo se cierra con la X o el toggle de la barra. Aplica a todas las
  fuentes (archivo/URL/TV), no solo TV.

## Interfaces

- `GET /api/tv-channels` → `Channel[]` con `{ nombre, categoria, url, key }`.
- `TvDialog({ onClose, onPlayChannel })`.
- Hook: `startTvChannel(channel: Channel): Promise<void>` (expuesto en el return).
- `AudioControls`: props `onOpenTv: () => void`.

## Manejo de errores

- **Fetch de canales falla / archivo ausente:** el diálogo muestra "sin canales"
  o un error; la app sigue.
- **Shaka falla al cargar el canal** (manifest/DRM/red): se surface un error
  breve, se limpia el estado (no queda el pie del reproductor colgado).
- **Navegador sin EME/ClearKey:** `shaka.Player.isBrowserSupported()` falso →
  avisar "TV no soportada en este navegador".

## Riesgos / caveats (aceptados)

- **CORS (a verificar en implementación):** para **re-emitir** a la sala, el CDN
  del canal debe mandar cabeceras CORS; si el elemento queda "tainted", Web Audio
  emite silencio. La herramienta autónoma pasa por Web Audio y suena, así que
  debería andar — **verificar con un canal real** antes de dar por cerrado.
- **Llaves DRM visibles** para cualquiera en la sala (inherente a ClearKey; ya
  pasa en el tool autónomo).
- **Soporte:** ClearKey/EME anda en Chrome (el navegador que se usa); Firefox/
  Safari puede variar.
- **Contenido:** responsabilidad del operador (la herramienta ya existe).
- **Tamaño:** `shaka-player` (~400 KB gz) entra por `import()` dinámico → solo se
  descarga al usar TV, no en el arranque normal.

## Fuera de alcance (v1)

- Timeshift / retroceso-avance en el diferido.
- Selección de idioma cuando el canal trae varios audios.
- Grabación del canal (ya se puede grabar la llamada).
- Panel de administración para editar canales desde la app (posible fase 2, con
  autenticación).
- Múltiples bases por país (el `index.html` tenía varias; acá una sola `db.json`).

## Verificación (end-to-end)

- `tsc` (cliente+servidor), `lint`, `build` limpios.
- `GET /api/tv-channels` devuelve el array; con `db.json` ausente → `[]`.
- En la app: botón "TV en vivo" → diálogo con categorías (encabezados) + botones;
  elegir un canal → suena y **el diálogo queda abierto** (se puede elegir otro);
  **otro peer en la sala lo oye**; el pie muestra volumen + detener; el volumen lo
  baja para todos; **Escape cierra el diálogo pero NO el reproductor**; cerrar el
  diálogo (X/Escape) deja el canal sonando; detener (pie) corta Shaka y libera todo.
- Verificar CORS/re-emisión con un canal real.
