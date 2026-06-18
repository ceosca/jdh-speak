# Design: Español-only + procesamiento de voz en vivo + atenuado en origen

**Fecha:** 2026-06-17
**Estado:** Aprobado (pendiente de generar el plan de implementación)
**Alcance:** Primer spec de un lote de 4 funciones. Cubre **F1, F2, F3**.
F4 (reproductor tipo VLC) va en un spec/plan aparte — ver "Fuera de alcance".

## Contexto

Tras renombrar el proyecto a JDH Speak y simplificarlo, el dueño pide cuatro
mejoras de audio/UX. Se acordó agrupar las tres pequeñas-medianas en este spec y
dejar el reproductor para después. Las tres:

1. **Solo español** — quitar inglés/francés y el selector de idioma (también de la
   sala), forzar español.
2. **Procesamiento de voz en tiempo real** — que marcar/desmarcar "Procesamiento
   de voz" (cancelación de eco, supresión de ruido, AGC) aplique y se quite al
   instante durante una llamada.
3. **Atenuado en origen** — que el audio emitido (compartir pantalla/archivo) se
   atenúe en la fuente cuando alguien habla, no solo en cada receptor; así la
   grabación, el streaming Icecast y todos los oyentes lo reciben atenuado por igual.

## F1 · Solo español

Mantener Paraglide con **un único locale** (`es`). No se reescriben las cientos de
llamadas `m.*()`: con un solo idioma resuelven siempre a español.

- `client/project.inlang/settings.json`: `locales: ["es"]`, `baseLocale: "es"`.
- Borrar `client/messages/en.json` y `client/messages/fr.json` (queda `es.json`).
- Borrar `client/src/components/LanguageSelect.tsx` y su uso en la cabecera de la
  sala (`client/src/components/Room.tsx`) — desaparece "Idioma" de la sala. (En el
  lobby ya no estaba.)
- `client/src/lib/i18n.ts`: reducir a español — quitar el override `?lang=`, dejar
  `LOCALE_NAMES` solo con `es` (o eliminarlo si queda sin uso). `document.documentElement.lang = "es"`.
- `client/src/stores/room.ts`: eliminar el campo `locale` y la acción `setLanguage`
  (ya no hay cambio de idioma en vivo). `client/src/main.tsx`: quitar la suscripción
  a `locale` que re-renderiza el árbol al cambiar idioma.
- i18n: eliminar la clave `language_label` de `es.json` (y verificar que ninguna
  otra clave quede sin usar tras quitar el picker).
- Recordar: `client/src/paraglide/**` es generado; se recompila solo. No editarlo.

**Verificación:** `tsc --noEmit` + `lint` limpios; build de producción OK
(Paraglide recompila con un solo locale); la sala ya no muestra el selector de idioma
y toda la UI sale en español.

## F2 · Procesamiento de voz en tiempo real

Ya existe el mecanismo: un efecto en `client/src/hooks/useMediasoup.ts` (~línea 453)
re-adquiere el micro vía `getUserMedia(microphoneConstraints(device, voiceProcessing))`
cuando cambia `voiceProcessingEnabled` a mitad de llamada y lo re-enchufa al grafo de
salida con `connectMicToGraph`. Como el productor/senders siempre llevan la pista de
`outDest`, el cambio aplica **sin renegociar** la sesión.

Trabajo:
- **Verificar con micro real** (en la app levantada) que marcar/desmarcar la casilla
  aplica/quita el procesamiento al instante. Usar systematic-debugging si no aplica.
- Arreglar huecos detectados. Caso conocido a cubrir: el efecto hace `return` si
  `localStreamRef.current` es null (sesión sin micro) — correcto, pero confirmar que
  en una sesión CON micro siempre re-adquiere.
- Añadir **aviso a lector de pantalla** al alternar la casilla ("Procesamiento de voz
  activado/desactivado") para que NVDA confirme que se aplicó. Va por `announce()`
  (transitorio, como mute), localizado en `es.json`.

**Verificación:** en una llamada con micro, alternar la casilla cambia el
comportamiento de eco/ruido/AGC en tiempo real (probar hablando con eco/ruido) y NVDA
anuncia el cambio.

## F3 · Atenuado en origen

Hoy el atenuado es **solo en recepción**: cada cliente baja la ganancia del peer de
música vía `effectiveGain` (`useMediasoup.ts:296`) cuando el servidor emite
`duck {active}`. La grabación y el streaming, que consumen el productor crudo en el
SFU, capturan la música a volumen completo.

Cambio: atenuar también **en la fuente**, en el grafo de salida del emisor.

- En el grafo de salida (`outGraphRef`), insertar un nodo de ganancia de atenuado en
  las rutas de **compartir** y **archivo**, antes de `shareDest`/`fileDest`
  (p. ej. `displaySource → emitDuckGain → shareDest`, `fileSource → emitDuckGain → fileDest`).
- Al recibir `duck {active}` (función `applyDuck`, `useMediasoup.ts:324`), y
  respetando el toggle de sala `duckingEnabled`, si este cliente está emitiendo
  share/file, rampar `emitDuckGain` a `DUCK_FACTOR` (ataque `DUCK_ATTACK`) / a `1`
  (liberación `DUCK_RELEASE`) — mismas constantes que el atenuado de recepción.
- Resultado: los productores `"share"`/`"file"` salen ya atenuados → grabación,
  Icecast y oyentes uniformes. La **voz** del emisor (ruta `mic → micGain → limiter →
  outDest`) NO se atenúa: solo lo emitido.

**Evitar doble atenuado (clave):**
- El atenuado de recepción (`effectiveGain`) debe aplicarse **solo** a las fuentes
  `"music"` (el caster externo Ecobox, que envía estéreo crudo y no puede
  auto-atenuarse), **no** a `"share"`/`"file"` (ya atenuadas en origen).
- Hoy el receptor marca `isMusic` para todo lo no-voz. Refinar para distinguir la
  `source` real por peer/productor (la `source` ya viaja en `new-producer` y en
  `existingPeers` del join): atenuar en recepción si `source === "music"`; para
  `"share"`/`"file"` no atenuar (lo hace el origen).

**Verificación:** con un emisor de navegador compartiendo audio o archivo, al hablar
otro peer la música baja una sola vez (no doble); una grabación/stream simultáneo
sale atenuado; con un caster Ecobox, el atenuado de recepción sigue funcionando.

## Notas de accesibilidad (NVDA)

- F1: toda la UI en español; `<html lang="es">` desde el primer paint.
- F2: el alternado anuncia su efecto por la live-region.
- F3: sin UI nueva; el toggle de atenuado de sala existente no cambia su semántica
  (sigue siendo room-wide), solo cambia DÓNDE se aplica la ganancia.

## Fuera de alcance (próximo spec — F4)

Reproductor tipo VLC para el archivo/emisión: espacio play/pausa; flechas con
Ctrl/Alt/Shift para saltar con los tiempos de VLC (3s Shift, 10s Alt, 60s Ctrl,
5min Ctrl+Alt); `n`/`p` siguiente/anterior con **cola manual** de reproducción;
`Shift+n`/`Shift+p` capítulos (m4b, requiere leer metadatos de capítulos); y
comportamiento correcto con NVDA. Spec y plan propios.
