# Design: Reproductor de conferencia (estilo VLC)

**Fecha:** 2026-06-27
**Estado:** Aprobado (pendiente de plan de implementación)
**Feature:** 2 de 2 (la otra es la placa de transmisión secundaria — spec aparte).

## Contexto

La app ya emite audio de un archivo local hacia la sala a través de un productor
estéreo "file" (`startFileSource` en `client/src/hooks/useMediasoup.ts`, ventana
flotante `client/src/components/FileStreamPlayer.tsx`). El usuario quiere convertirlo
en un **reproductor completo** para "pasar de todo" en conferencia: lista de
reproducción desde una carpeta, controles tipo VLC, crossfade entre pistas, volumen
que baja para todos, y atajos de teclado accesibles con NVDA.

Decisiones tomadas con el usuario:
- Fuente: **archivo local** suelto **o carpeta local** (`webkitdirectory`) → lista.
- Audio **mezclado/único** ya existe; aquí se enriquece el reproductor del productor
  "file" actual.
- **Atajo global** lleva el foco al reproductor (contenedor `role="application"` →
  NVDA entra en modo foco) y ahí funcionan los atajos.
- **Siguiente = Shift+N**, **Anterior = Shift+P**.
- **m4b/capítulos: fuera de v1** (requiere parsear metadatos; fase posterior).

## Fuentes y lista de reproducción

- **Archivo local** suelto (como hoy): un solo elemento.
- **Carpeta local**: `<input type="file" webkitdirectory>` → se filtran los audios
  (por extensión/`type`) y forman la **lista** (array `{ name, objectUrl }`, índice
  actual). Privado: nada se sube; se reproduce vía object URLs locales.
- La biblioteca del servidor y la URL (diálogo `AudioSourceDialog`) siguen
  alimentando el mismo reproductor (una sola pista, sin lista) — sin cambios.

## Componentes y estructura

Para no inflar un solo archivo:
- **`usePlayer` (hook nuevo, `client/src/hooks/usePlayer.ts`)**: estado y lógica de
  la lista/reproducción (pista actual, repeat, shuffle, velocidad, volumen, posición,
  play/pause, seek, prev/next, crossfade). Expone acciones y estado; no toca el DOM.
- **`FileStreamPlayer.tsx` (ampliado)**: la UI (barra de progreso, tiempos, botones,
  combo de volumen, lista). Contenedor con `role="application"` y `aria-label`.
- **Grafo de audio** en `useMediasoup.ts`: generaliza el camino "file" para soportar
  **dos elementos `<audio>` a la vez** (crossfade) y un nodo de **volumen** de
  usuario en la ruta enviada.

## Grafo de audio (envío + crossfade + volumen)

Hoy: `audioEl → MediaElementSource → fileDuckGain → fileDest → productor "file"`
(+ monitor local a `destination`).

Cambios:
- **Volumen para todos:** insertar `fileVolumeGain` antes del duck:
  `source → fileVolumeGain → fileDuckGain → fileDest`. Bajar `fileVolumeGain` baja el
  audio **en la fuente** → todos los oyentes lo reciben más bajo (independiente del
  volumen por-peer de cada quien). Niveles desde un **cuadro combinado** (100/75/50/
  25/10 %), persistido.
- **Crossfade:** mantener **dos cadenas** (A y B), cada una `audioEl_x → source_x →
  xfadeGain_x → fileVolumeGain → fileDuckGain → fileDest`. Al pasar de pista
  (siguiente/auto-avance): la siguiente se precarga en la cadena libre, se hace
  **fade-in** de su `xfadeGain` mientras **fade-out** de la actual (rampas de ~2–4 s,
  configurable). Al terminar el fade, se libera el elemento saliente. La pista
  producida sigue siendo la de `fileDest` (no cambia el productor → sin parpadeo SFU).

## Controles (UI del reproductor)

- **Nombre de la pista** actual + **barra de progreso** (slider accesible, arrastrable
  para buscar) con **tiempo actual / total**.
- Botones visibles: **play/pausa**, **−10 s**, **+10 s**, **anterior**, **siguiente**.
- **Cuadro combinado de volumen** (baja para todos).
- **Velocidad** 0.5×–2× (`audioEl.playbackRate`).
- **Repetir** (una / todas) y **aleatorio** (shuffle).
- **Lista de reproducción** visible cuando hay carpeta: pistas, la actual resaltada,
  click/Enter para saltar. Roving focus accesible.

## Comportamiento

- **Auto-avance** al terminar una pista → siguiente (con crossfade). Respeta repeat
  (una = repite la misma; todas = vuelve al inicio al final) y shuffle (orden
  barajado).
- **Reanudar posición**: guardar la posición por nombre de archivo (Map en memoria +
  localStorage acotado) y, al cargar esa pista, hacer `seek` a donde iba. Útil para
  audiolibros largos.
- **Anuncio "Ahora suena: <pista>"** al cambiar de pista, vía `announceEvent` (va a la
  región ARIA + al chat, como el resto de eventos) para NVDA.
- **Recordar volumen** y velocidad entre sesiones (localStorage).

## Teclado y accesibilidad

- **Atajo global "ir al reproductor": `Ctrl+Alt+P`** (ajustable). Mueve el foco a la
  ventana del reproductor. El contenedor es `role="application"` → NVDA pasa a **modo
  foco** y reenvía las teclas a nuestros manejadores.
- Atajos dentro del reproductor (con foco en él):
  - **Espacio** = play/pausa
  - **Ctrl+← / Ctrl+→** = −1 min / +1 min
  - **Alt+← / Alt+→** = −10 s / +10 s (se hace `preventDefault` para anular el
    "atrás/adelante" del navegador)
  - **Shift+← / Shift+→** = −5 s / +5 s
  - **Shift+P** = anterior · **Shift+N** = siguiente
- Los atajos **no se disparan mientras se escribe** (foco en input/textarea del chat).
- Todos los controles son botones/sliders reales con `aria-label`/`aria-valuetext`;
  el `role="application"` se acota al reproductor para no romper la navegación NVDA
  del resto de la sala.

## Verificación (end-to-end)

- `tsc --noEmit` (client) y `lint` limpios.
- En la app: elegir una carpeta local → se arma la lista; play, ±10 s (botón y
  Alt+flecha), ±1 min (Ctrl+flecha), ±5 s (Shift+flecha), anterior/siguiente
  (Shift+P / Shift+N) funcionan. El crossfade solapa al pasar de pista. Bajar el
  volumen del combo → otro peer lo oye más bajo. `Ctrl+Alt+P` lleva el foco al
  reproductor y NVDA entra en modo foco. Al cambiar de pista se anuncia "Ahora suena".

## Fuera de alcance (v1)

- **Capítulos m4b** (Shift+capítulo) — requiere parsear átomos de capítulo del archivo.
- Lista/cola manual mezclando varias carpetas (v1: una carpeta o un archivo a la vez).
