# Registro de cambios (CHANGELOG)

> **Convención (para Cristian y para Claude):** cada vez que hacemos `git push`,
> anotamos acá lo que quedó: **qué** se cambió, **cómo** se hizo y **por qué**.
> Sirve para entender el estado actual sin leer todo el código —
> especialmente si Claude pierde el contexto. Lo más nuevo va arriba. Cada
> entrada lleva el hash del commit.

---

## 2026-06-29

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
