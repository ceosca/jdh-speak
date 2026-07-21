# Serieteca — diseño

**Fecha:** 2026-07-21
**Estado:** aprobado (brainstorming)

## Qué es

Una **biblioteca de series de audio** dentro de JDH Speak, al estilo del botón
"TV en vivo": un botón **"Serieteca"** en la barra abre un diálogo con el catálogo
de series; al elegir una, **suena para toda la sala** y aparece un reproductor
accesible completo con navegación de temporadas/episodios.

Es la versión "para la sala" de una app de referencia existente
(`serieteca/index.php`), quedándonos con lo esencial y descartando su ecosistema
propio (cuentas, stats en servidor, vinculación de TV).

## Modelo de datos (de `series.json`)

La base **siempre** se baja de `https://archive.org/download/m4bua/series.json`.
Formato: `{ "series": [ Serie, ... ] }`.

```
Serie {
  nombre: string
  genero: string            // p.ej. "Drama", "Comedia; Drama"
  pais_origen: string       // 8 países: España, México, Colombia, Argentina, ...
  enlace: string            // UN solo .m4b por serie (todas las temporadas)
  temporadas: Temporada[]
}
Temporada {
  numero: number
  anio: number
  reparto: string[]
  sinopsis: string
  cantidad_episodios: number
  capitulos: Capitulo[]
}
Capitulo {
  inicio: number            // MILISEGUNDOS dentro del .m4b
  fin: number               // MILISEGUNDOS
  titulo: string
}
```

**Hechos verificados del catálogo** (414 series):
- Todas las series son **un único `.m4b`** (AAC en contenedor MP4) alojado en
  archive.org. `enlace` es a nivel serie, no por temporada.
- Los `inicio`/`fin` son **milisegundos** (no bytes) y son **continuos entre
  temporadas**: la T2 empieza en el `fin` de la T1 dentro del mismo archivo.
  Por eso un episodio = *seek* por tiempo (`currentTime = inicio/1000`), y la
  lista de episodios se arma **aplanando** todas las temporadas y ordenando por
  `inicio`.
- 97 series tienen más de una temporada.

## Punto crítico: CORS y la vía a la sala

Como la serie se emite a la sala, el audio pasa por Web Audio
(`createMediaElementSource`), y eso **exige CORS en el recurso**. Verificado:
- `series.json` **sí** manda `access-control-allow-origin: *` → el cliente la
  baja directo.
- El `.m4b` **NO** manda CORS (nginx de archive.org, `application/octet-stream`,
  sin `access-control-allow-origin`). Un `<audio crossOrigin="anonymous">` sobre
  el `.m4b` quedaría *tainted* → **silencio** al enrutarlo por Web Audio.

**Solución:** el `src` del `<audio>` apunta a **`/api/audio-proxy?url=<enlace>`**
(mismo origen, ya existe). El proxy hace pass-through directo **preservando
`Range`**, así que:
- Web Audio puede tomar el audio (mismo origen, no *tainted*) y emitirlo a la sala.
- El navegador puede **saltar de episodio** por *seek* (el proxy pasa `Range`/
  `Content-Range`), sin bajar los ~450 MB del archivo entero.

**Ajuste necesario en el proxy:** hoy el proxy manda a *transcode* (ffmpeg) lo
que no reconoce como audio reproducible por content-type/extensión. Un `.m4b`
servido como `application/octet-stream` podría caer en esa rama, y transcodificar
**rompe el *seek*** (ffmpeg re-encodea como stream hacia adelante). Hay que
asegurar que el `.m4b` se sirva por la **vía directa con Range** (reconocer
`.m4b`/`audio/mp4`/octet-stream-con-extensión-`.m4b` como audio directo).

## Reproducción a la sala (reusa la infra de TV/archivos)

Idéntico grafo que archivo/URL/TV:
`<audio> → createMediaElementSource → fileVolumeGain → outDest`
(un solo productor de voz, **no fuerza SFU**). Se reutiliza `ensureFileVolumeGain`,
el `playerIsUrl`/estado del pie del reproductor, y el patrón de teardown
(`stopFileStream`). Empezar una serie corta cualquier fuente activa (archivo/URL/
TV/otra serie) primero, igual que hoy entre archivo y TV.

## Reproductor de series (completo, accesible)

Al elegir una serie:
- Se muestra la ficha (nombre, género, año, país, reparto, sinopsis de la
  temporada actual, cantidad de episodios).
- Controles (reusando el pie del reproductor + nuevos):
  - **Selector de temporada** (oculto si hay una sola).
  - **Selector de episodio**.
  - **Siguiente episodio / Episodio anterior**.
  - **Reiniciar episodio** (vuelve al `inicio` del episodio actual).
  - Play/pausa, ±15s, subir/bajar volumen (ya existen).
- **Seguimiento automático:** un `timeupdate` calcula el episodio actual según
  `currentTime` (función tipo `gci`), actualiza los selectores y **anuncia** el
  título del episodio por aria-live al cambiar.
- **Al terminar un episodio** (llegar al `fin`) pasa al siguiente automáticamente.
- **Atajos de teclado** (cuando el reproductor de serie está activo):
  `Alt+K` play/pausa, `Alt+J` −15s, `Alt+L` +15s, `Alt+S` siguiente episodio,
  `Alt+A` episodio anterior, `Alt+R` reiniciar episodio, `Alt+I` leer
  serie+episodio+tiempo. (Se respeta el patrón de anuncios de la app.)

## Base de datos (fetch)

- Cliente baja `series.json` directo de archive.org (tiene CORS), la parsea y la
  **cachea en memoria** por sesión (se re-baja al reabrir la app).
- Parser defensivo: JSON inválido / no-array → catálogo vacío; se descartan
  entradas malformadas (sin `nombre`/`enlace`/`temporadas`).

## Progreso — "continuar escuchando"

- **localStorage** por navegador, clave `jdh-speak:serieteca:progress` →
  `{ [nombreSerie]: { episodio: number, tiempo: number } }`.
- Se guarda de forma *debounced* mientras suena (y al pausar/cerrar).
- Al abrir una serie con progreso, retoma en ese episodio/tiempo.
- El diálogo muestra una sección **"Continuar escuchando"** con esas series
  (con botón para borrar una entrada). Es el progreso del que puso la serie
  (no hay cuentas).

## Listado del diálogo (414 series)

- **Buscador** de texto arriba (filtra por nombre, sin acentos, en vivo).
- **"Continuar escuchando"** (de localStorage) y **"Últimas agregadas"**
  (últimas N del catálogo, como hace la referencia con `slice(-N).reverse()`).
- Catálogo agrupado por **país** (encabezados `<h3>` con id por índice para
  accesibilidad — mismo fix que la TV con categorías multi-palabra), series
  ordenadas alfabéticamente dentro de cada país, un `<button>` por serie.
- Elegir una serie **no cierra** el diálogo (se cierra con X/Escape).
- Estados: cargando / vacío / error (con aviso accesible).

## Fuera de alcance (YAGNI, de la app de referencia)

- Login / registro de usuarios.
- Progreso y estadísticas en servidor ("top 10 más escuchadas", contador de
  vistas).
- Vinculación de TV por código (device flow).

## Archivos

**Nuevos:**
- `client/src/components/SerietecaDialog.tsx` — diálogo (buscador, secciones,
  agrupado por país, picking).
- `client/src/lib/serieteca.ts` — tipos, `fetchSeries()`, `flattenEpisodes()`,
  `groupByPais()`, helpers de progreso (localStorage), `episodeAt(time)`.

**Tocados:**
- `client/src/hooks/useMediasoup.ts` — `startSerie(serie)`, navegación de
  episodios (siguiente/anterior/reiniciar/seek), seguimiento por `timeupdate`,
  teardown; reusa `ensureFileVolumeGain`/vía de archivo. `src` vía
  `/api/audio-proxy`.
- `client/src/components/AudioControls.tsx` — botón "Serieteca".
- `client/src/components/Room.tsx` — estado del diálogo + controles de serie en
  el pie.
- `server/src/audio-sources.ts` (y/o `server/src/index.ts`) — reconocer `.m4b`
  como audio directo con Range (no transcode).
- `client/messages/es.json` — strings (español).
- `CHANGELOG.md` — entrada.
- `CLAUDE.md` — subsección de arquitectura + nota de deploy si aplica.

## Riesgos a verificar en vivo

1. Que el `.m4b` vía `/api/audio-proxy` **suene en la sala** para un 2º peer
   (CORS resuelto por el proxy) — la prueba definitiva.
2. Que el **seek de episodio** funcione a través del proxy (Range) sin bajar el
   archivo entero, incluido saltar hacia atrás.
3. Latencia del primer *seek* en `.m4b` con `moov` al final (el navegador puede
   necesitar leer el índice al final antes de saltar).
