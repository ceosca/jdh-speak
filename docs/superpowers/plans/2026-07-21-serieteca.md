# Serieteca Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Serieteca" — an accessible audio-series library that plays a
chosen series into the whole room, with full season/episode navigation.

**Architecture:** Reuses the existing file/TV audio graph
(`<audio> → createMediaElementSource → fileVolumeGain → outDest`, single voice
producer, no SFU pin). Each series is one continuous `.m4b` on archive.org whose
episodes are millisecond time-ranges; playback = seek by time. Because the `.m4b`
lacks CORS, its `src` is the same-origin `/api/audio-proxy` (which must serve it
via the direct, Range-preserving path — not transcode). The catalog is fetched
directly from archive.org (`series.json` has CORS). Progress is per-browser
localStorage.

**Tech Stack:** React 19, zustand, Web Audio, Express 5 + `/api/audio-proxy`,
Paraglide i18n (Spanish only). Server tests: `node:test` via tsx. Client has NO
test suite — verify client tasks with `tsc --noEmit`, `pnpm lint`, and the
in-app browser preview.

## Global Constraints

- **Spanish only.** All user-facing strings go through Paraglide `m.*()` from
  `client/messages/es.json`. Regenerate before typecheck:
  `pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide`.
- **Announcements rule.** Series *events* worth logging (start/stop) — decide per
  CLAUDE.md's rule; per-episode changes are transient `announce()` (like mute),
  not `announceEvent()`. Follow `useMediasoup.ts` precedent (TV uses `announce`).
- **No new producer / no SFU pin.** Series audio must mix into `fileVolumeGain`,
  exactly like files/URL/TV. Never create a dedicated producer for it.
- **DB source is fixed:** `https://archive.org/download/m4bua/series.json`.
- **`inicio`/`fin` are milliseconds.** Seek with `inicio / 1000`.
- **One `.m4b` per series**, offsets continuous across seasons → flatten all
  `temporadas[].capitulos[]` into one list sorted by `inicio`.
- **localStorage key prefix:** `jdh-speak:`.
- **Client verification gate:** `pnpm --filter client exec tsc --noEmit` and
  `pnpm lint` must pass; no client unit-test runner exists.
- **Reuse, don't fork:** model `startSerie` on the existing `startTvChannel`
  (`useMediasoup.ts` ~1907) and `stopFileStream` (~1686).

---

### Task 1: Serve `.m4b` (binary-typed audio) via the direct Range-preserving proxy path

**Why:** archive.org serves the `.m4b` as `application/octet-stream`, so
`isAudioContentType` returns false and the proxy transcodes it — which kills
byte-Range seeking (episode jumps). We must serve known browser-playable audio
extensions directly, preserving Range, rewriting the Content-Type so `<audio>`
plays it.

**Files:**
- Modify: `server/src/audio-sources.ts` (add `browserPlayableAudioType`)
- Modify: `server/src/index.ts:161-190` (use it in the direct path)
- Test: `server/src/audio-sources.test.ts` (add a pure-function test block)

**Interfaces:**
- Produces: `export function browserPlayableAudioType(url: string, contentType: string): string | null`
  — returns the Content-Type to serve if the resource is directly playable
  (possibly rewritten from a generic binary type), else `null`.

- [ ] **Step 1: Write the failing test** — append to `server/src/audio-sources.test.ts`:

```ts
import { browserPlayableAudioType } from "./audio-sources.ts";

test("browserPlayableAudioType", async (t) => {
  await t.test("passes through a real audio content-type unchanged", () => {
    assert.equal(
      browserPlayableAudioType("https://x/y.m4b", "audio/mp4"),
      "audio/mp4",
    );
    assert.equal(
      browserPlayableAudioType("https://x/stream", "audio/mpeg; charset=binary"),
      "audio/mpeg; charset=binary",
    );
  });

  await t.test("rewrites generic binary to audio/mp4 for .m4b / .m4a by extension", () => {
    assert.equal(
      browserPlayableAudioType("https://ia.us.archive.org/items/x/a.m4b", "application/octet-stream"),
      "audio/mp4",
    );
    assert.equal(
      browserPlayableAudioType("https://x/song.m4a", ""),
      "audio/mp4",
    );
    assert.equal(
      browserPlayableAudioType("https://x/song.mp3?token=1", "application/octet-stream"),
      "audio/mpeg",
    );
  });

  await t.test("returns null for HTML pages and unknown binary", () => {
    assert.equal(browserPlayableAudioType("https://x/a.m4b", "text/html"), null);
    assert.equal(browserPlayableAudioType("https://x/video.ts", "application/octet-stream"), null);
    assert.equal(browserPlayableAudioType("https://x/clip.mp4", "video/mp4"), null);
  });

  await t.test("does not treat HLS/DASH manifests as directly playable", () => {
    assert.equal(browserPlayableAudioType("https://x/a.m3u8", "application/octet-stream"), null);
    assert.equal(browserPlayableAudioType("https://x/a.mpd", "application/octet-stream"), null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter server exec node --import tsx --test --test-name-pattern="browserPlayableAudioType" src/audio-sources.test.ts`
Expected: FAIL — `browserPlayableAudioType` is not exported.

- [ ] **Step 3: Implement `browserPlayableAudioType`** in `server/src/audio-sources.ts`, right after `isAudioContentType` (line 18):

```ts
// Extensions a browser <audio> can decode directly, mapped to the Content-Type
// we serve them as. archive.org ships .m4b audiobooks as application/octet-stream,
// which isAudioContentType rejects — that would push them to the transcoder and
// break byte-Range seeking. When the content-type is generic binary (or absent)
// but the URL path clearly names a playable audio file, serve it directly with a
// correct audio Content-Type so <audio> plays it and Range/seek keep working.
const PLAYABLE_AUDIO_EXT: Record<string, string> = {
  ".m4b": "audio/mp4",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

const GENERIC_BINARY_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

export function browserPlayableAudioType(url: string, contentType: string): string | null {
  // A real audio content-type is authoritative — serve as-is.
  if (isAudioContentType(contentType)) return contentType;
  const base = contentType.split(";", 1)[0].trim().toLowerCase();
  // Only override when upstream gave us a generic/absent type (never for HTML or video/*).
  if (!GENERIC_BINARY_TYPES.has(base)) return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return null;
  return PLAYABLE_AUDIO_EXT[pathname.slice(dot)] ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter server exec node --import tsx --test --test-name-pattern="browserPlayableAudioType" src/audio-sources.test.ts`
Expected: PASS (4 subtests).

- [ ] **Step 5: Wire it into the proxy route** — in `server/src/index.ts`, replace the direct-path condition/headers (lines ~164-167):

```ts
      const contentType = upstream.headers["content-type"] || "";
      const playType = browserPlayableAudioType(raw, contentType);
      if (status >= 200 && status < 300 && playType) {
        res.status(status);
        res.setHeader("Content-Type", playType);
```

Add `browserPlayableAudioType` to the existing import from `./audio-sources.ts`
at the top of `index.ts` (alongside `isAudioContentType`).

- [ ] **Step 6: Typecheck the server**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/audio-sources.ts server/src/index.ts server/src/audio-sources.test.ts
git commit -m "feat(proxy): serve .m4b (binary-typed audio) via direct Range path, not transcode"
```

---

### Task 2: Client library `serieteca.ts` (types, fetch, flatten, grouping, progress)

**Files:**
- Create: `client/src/lib/serieteca.ts`

**Interfaces:**
- Produces:
  - `interface Capitulo { inicio: number; fin: number; titulo: string }`
  - `interface Temporada { numero: number; anio?: number; reparto?: string[]; sinopsis?: string; cantidad_episodios?: number; capitulos: Capitulo[] }`
  - `interface Serie { nombre: string; genero?: string; pais_origen?: string; enlace: string; temporadas: Temporada[] }`
  - `interface Episode { inicio: number; fin: number; titulo: string; tn: number; ti: number }` (flat, `tn`=season number, `ti`=season array index)
  - `interface SeasonInfo { numero: number; count: number }`
  - `interface ProgressEntry { episode: number; time: number }`
  - `const SERIES_DB_URL = "https://archive.org/download/m4bua/series.json"`
  - `async function fetchSeries(): Promise<Serie[]>`
  - `function flattenEpisodes(serie: Serie): Episode[]`
  - `function seasonsOf(serie: Serie): SeasonInfo[]`
  - `function groupByPais(series: Serie[]): { pais: string; series: Serie[] }[]`
  - `function episodeIndexAt(episodes: Episode[], timeSec: number): number`
  - `function serieAudioSrc(enlace: string): string`
  - `function loadProgress(): Record<string, ProgressEntry>`
  - `function saveProgress(nombre: string, entry: ProgressEntry): void`
  - `function clearProgress(nombre: string): void`
  - `function normalizeForSearch(s: string): string`

- [ ] **Step 1: Write the module** — `client/src/lib/serieteca.ts`:

```ts
// Serieteca — audio-series catalog + playback helpers.
//
// Each series is ONE continuous .m4b on archive.org; a "chapter"/episode is a
// millisecond time-range (inicio/fin) into that single file, with offsets
// continuous across seasons. So an episode list is all temporadas' capitulos
// flattened and sorted by inicio, and playing episode i = seeking to inicio/1000.
// The .m4b lacks CORS, so we route its src through our same-origin /api/audio-proxy.

export interface Capitulo {
  inicio: number; // ms
  fin: number; // ms
  titulo: string;
}
export interface Temporada {
  numero: number;
  anio?: number;
  reparto?: string[];
  sinopsis?: string;
  cantidad_episodios?: number;
  capitulos: Capitulo[];
}
export interface Serie {
  nombre: string;
  genero?: string;
  pais_origen?: string;
  enlace: string;
  temporadas: Temporada[];
}
export interface Episode {
  inicio: number;
  fin: number;
  titulo: string;
  tn: number; // season number
  ti: number; // season index in temporadas[]
}
export interface SeasonInfo {
  numero: number;
  count: number;
}
export interface ProgressEntry {
  episode: number;
  time: number;
}

export const SERIES_DB_URL = "https://archive.org/download/m4bua/series.json";
const PROGRESS_KEY = "jdh-speak:serieteca:progress";

// Drop malformed entries so one bad record can't break the catalog.
function isValidSerie(x: unknown): x is Serie {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.nombre === "string" &&
    typeof s.enlace === "string" &&
    Array.isArray(s.temporadas)
  );
}

export async function fetchSeries(): Promise<Serie[]> {
  try {
    const r = await fetch(SERIES_DB_URL);
    if (!r.ok) return [];
    const d: unknown = await r.json();
    const arr = (d as { series?: unknown }).series;
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidSerie);
  } catch {
    return [];
  }
}

export function flattenEpisodes(serie: Serie): Episode[] {
  const out: Episode[] = [];
  serie.temporadas.forEach((tp, ti) => {
    for (const c of tp.capitulos || []) {
      out.push({ inicio: c.inicio, fin: c.fin, titulo: c.titulo, tn: tp.numero, ti });
    }
  });
  out.sort((a, b) => a.inicio - b.inicio);
  return out;
}

export function seasonsOf(serie: Serie): SeasonInfo[] {
  return serie.temporadas.map((tp) => ({
    numero: tp.numero,
    count: tp.cantidad_episodios ?? (tp.capitulos ? tp.capitulos.length : 0),
  }));
}

export function groupByPais(series: Serie[]): { pais: string; series: Serie[] }[] {
  const map = new Map<string, Serie[]>();
  for (const s of series) {
    const p = s.pais_origen || "Sin clasificar";
    (map.get(p) ?? map.set(p, []).get(p)!).push(s);
  }
  return [...map.keys()]
    .sort((a, b) => a.localeCompare(b, "es"))
    .map((pais) => ({
      pais,
      series: map
        .get(pais)!
        .slice()
        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" })),
    }));
}

// Which episode index contains timeSec (seconds). Mirrors the reference player's
// gci: inside [inicio,fin] → that index; before the first → clamp; past the last
// → last. Returns 0 for an empty list.
export function episodeIndexAt(episodes: Episode[], timeSec: number): number {
  if (!episodes.length) return 0;
  for (let i = 0; i < episodes.length; i++) {
    const a = episodes[i]!.inicio / 1000;
    const b = episodes[i]!.fin / 1000;
    if (timeSec >= a && timeSec <= b) return i;
    if (timeSec < a) return i > 0 ? i - 1 : 0;
    if (i === episodes.length - 1 && timeSec > b) return i;
  }
  return 0;
}

export function serieAudioSrc(enlace: string): string {
  return `/api/audio-proxy?url=${encodeURIComponent(enlace)}`;
}

export function loadProgress(): Record<string, ProgressEntry> {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return {};
    const d: unknown = JSON.parse(raw);
    return d && typeof d === "object" ? (d as Record<string, ProgressEntry>) : {};
  } catch {
    return {};
  }
}

export function saveProgress(nombre: string, entry: ProgressEntry): void {
  try {
    const all = loadProgress();
    all[nombre] = entry;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* storage full / disabled — best effort */
  }
}

export function clearProgress(nombre: string): void {
  try {
    const all = loadProgress();
    delete all[nombre];
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* best effort */
  }
}

// Accent-insensitive, lowercased — for the dialog's live name filter.
export function normalizeForSearch(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify the tricky pure function** (`episodeIndexAt`) with a scratch check (no committed client test runner exists):

Run:
```bash
pnpm --filter server exec node --import tsx -e "import {episodeIndexAt} from '../client/src/lib/serieteca.ts'; const e=[{inicio:0,fin:2000,titulo:'a',tn:1,ti:0},{inicio:2000,fin:5000,titulo:'b',tn:1,ti:0}]; console.log(episodeIndexAt(e,0.5), episodeIndexAt(e,3), episodeIndexAt(e,99));"
```
Expected: `0 1 1`. (If the tsx path resolution is awkward on Windows, inline the
three cases in a `scratchpad` .ts file and run it — the assertion is just those
three outputs.)

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/serieteca.ts
git commit -m "feat(serieteca): catalog + playback lib (fetch, flatten, episodeIndexAt, progress)"
```

---

### Task 3: Store slice for the series player

**Files:**
- Modify: `client/src/stores/room.ts`

**Interfaces:**
- Consumes: `Episode`, `SeasonInfo` from `../lib/serieteca`.
- Produces (on the store):
  - state: `serieName: string | null`, `serieEpisodes: Episode[]`,
    `serieSeasons: SeasonInfo[]`, `serieEpisodeIndex: number`,
    `serieCurrentSeason: number`
  - actions: `setSerie(p: { name: string; episodes: Episode[]; seasons: SeasonInfo[]; index: number; season: number }): void`,
    `setSerieEpisode(index: number, season: number): void`,
    `clearSerie(): void`

- [ ] **Step 1: Add imports** at the top of `client/src/stores/room.ts`:

```ts
import type { Episode, SeasonInfo } from "../lib/serieteca";
```

- [ ] **Step 2: Add state fields** to the store's state interface (near
`playerIsUrl`, ~line 146):

```ts
  serieName: string | null;
  serieEpisodes: Episode[];
  serieSeasons: SeasonInfo[];
  serieEpisodeIndex: number;
  serieCurrentSeason: number;
```

- [ ] **Step 3: Add action signatures** (near `setPlayerIsUrl`, ~line 229):

```ts
  setSerie: (p: {
    name: string;
    episodes: Episode[];
    seasons: SeasonInfo[];
    index: number;
    season: number;
  }) => void;
  setSerieEpisode: (index: number, season: number) => void;
  clearSerie: () => void;
```

- [ ] **Step 4: Add initial values** (near `playerIsUrl: false`, ~line 275):

```ts
  serieName: null,
  serieEpisodes: [],
  serieSeasons: [],
  serieEpisodeIndex: 0,
  serieCurrentSeason: 1,
```

- [ ] **Step 5: Add action implementations** (near `setPlayerIsUrl`, ~line 317):

```ts
  setSerie: ({ name, episodes, seasons, index, season }) =>
    set({
      serieName: name,
      serieEpisodes: episodes,
      serieSeasons: seasons,
      serieEpisodeIndex: index,
      serieCurrentSeason: season,
    }),
  setSerieEpisode: (serieEpisodeIndex, serieCurrentSeason) =>
    set({ serieEpisodeIndex, serieCurrentSeason }),
  clearSerie: () =>
    set({ serieName: null, serieEpisodes: [], serieSeasons: [], serieEpisodeIndex: 0 }),
```

- [ ] **Step 6: Reset on leave** — in the store's room-reset block (near line 529
where `fileStreamName: null` is reset), add:

```ts
      serieName: null,
      serieEpisodes: [],
      serieSeasons: [],
      serieEpisodeIndex: 0,
      serieCurrentSeason: 1,
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add client/src/stores/room.ts
git commit -m "feat(serieteca): store slice for the series player"
```

---

### Task 4: `startSerie` + episode navigation in `useMediasoup.ts`

**Files:**
- Modify: `client/src/hooks/useMediasoup.ts`

**Interfaces:**
- Consumes: store slice from Task 3; `serieteca` lib from Task 2.
- Produces (returned from the hook):
  - `startSerie(serie: Serie): Promise<void>`
  - `serieSeekEpisode(index: number): void`
  - `serieNextEpisode(): void`
  - `seriePrevEpisode(): void`
  - `serieRestartEpisode(): void`
  - `serieSelectSeason(numero: number): void`

- [ ] **Step 1: Add imports** near the existing `Channel`/`parseClearKey` import
and the `m` messages import:

```ts
import {
  flattenEpisodes,
  seasonsOf,
  episodeIndexAt,
  serieAudioSrc,
  loadProgress,
  saveProgress,
  type Serie,
  type Episode,
} from "../lib/serieteca";
```

- [ ] **Step 2: Add refs** next to the TV refs (~line 256-272):

```ts
  // Series playback: a dedicated <audio> whose src is the same-origin
  // /api/audio-proxy (the .m4b lacks CORS), routed through fileVolumeGain like TV.
  // createMediaElementSource is one-shot per element, so element + source persist.
  const serieAudioRef = useRef<HTMLAudioElement | null>(null);
  const serieSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const serieActiveRef = useRef(false);
  const serieEpisodesRef = useRef<Episode[]>([]);
  const serieIndexRef = useRef(0);
  const serieNameRef = useRef<string | null>(null);
  const serieProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

- [ ] **Step 3: Add `startSerie` and navigation** — place after `startTvChannel`
(~line 1981). Mirror `startTvChannel`'s structure (ensureOutGraph →
resumeSharedContext → silent stopFileStream → ensureFileVolumeGain → try/catch):

```ts
  // Save the current position, debounced (called from timeupdate + pause).
  const saveSerieProgress = useCallback(() => {
    const name = serieNameRef.current;
    const el = serieAudioRef.current;
    if (!name || !el) return;
    if (serieProgressTimerRef.current) clearTimeout(serieProgressTimerRef.current);
    serieProgressTimerRef.current = setTimeout(() => {
      saveProgress(name, { episode: serieIndexRef.current, time: el.currentTime });
    }, 1000);
  }, []);

  // timeupdate: detect which episode currentTime is in; on change, update the
  // store (selectors + season) and announce the new episode title.
  const onSerieTimeUpdate = useCallback(() => {
    const el = serieAudioRef.current;
    const episodes = serieEpisodesRef.current;
    if (!el || !episodes.length) return;
    const idx = episodeIndexAt(episodes, el.currentTime);
    if (idx !== serieIndexRef.current) {
      serieIndexRef.current = idx;
      const ep = episodes[idx]!;
      store.getState().setSerieEpisode(idx, ep.tn);
      store.getState().announce(ep.titulo);
    }
    saveSerieProgress();
  }, [store, saveSerieProgress]);

  const startSerie = useCallback(
    async (serie: Serie) => {
      const g = ensureOutGraph();
      resumeSharedContext();
      await stopFileStream({ silent: true });
      const fvg = ensureFileVolumeGain(g);

      const episodes = flattenEpisodes(serie);
      if (!episodes.length) {
        store.getState().announce(m.serie_empty());
        return;
      }

      // Resume from saved progress if the episode still exists.
      const prog = loadProgress()[serie.nombre];
      const idx = prog && episodes[prog.episode] ? prog.episode : 0;
      const startTime =
        prog && episodes[prog.episode] ? prog.time : episodes[idx]!.inicio / 1000;

      try {
        if (!serieAudioRef.current) {
          const el = new Audio();
          (el as unknown as Record<string, boolean>).playsInline = true;
          el.crossOrigin = "anonymous";
          el.addEventListener("timeupdate", () => onSerieTimeUpdate());
          el.addEventListener("pause", () => saveSerieProgress());
          el.addEventListener("ended", () =>
            store.getState().setFileStreamPlaying(false),
          );
          serieAudioRef.current = el;
          serieSourceRef.current = sharedAudioContext.createMediaElementSource(el);
        }
        serieSourceRef.current!.connect(fvg);

        serieEpisodesRef.current = episodes;
        serieIndexRef.current = idx;
        serieNameRef.current = serie.nombre;

        const el = serieAudioRef.current;
        el.src = serieAudioSrc(serie.enlace);
        const seek = () => {
          el.currentTime = startTime;
          el.play().catch(() => {});
        };
        el.addEventListener("canplay", seek, { once: true });
        el.load();

        serieActiveRef.current = true;
        store.getState().setSerie({
          name: serie.nombre,
          episodes,
          seasons: seasonsOf(serie),
          index: idx,
          season: episodes[idx]!.tn,
        });
        store.getState().setFileStream(serie.nombre);
        store.getState().setPlayerIsUrl(false);
        store.getState().setFileStreamPlaying(true);
      } catch (err) {
        try {
          serieSourceRef.current?.disconnect();
        } catch {
          /* not connected */
        }
        serieAudioRef.current?.pause();
        serieActiveRef.current = false;
        store.getState().announce(m.serie_play_error());
        throw err;
      }
    },
    [ensureOutGraph, ensureFileVolumeGain, stopFileStream, store, onSerieTimeUpdate, saveSerieProgress],
  );

  const serieSeekEpisode = useCallback(
    (index: number) => {
      const el = serieAudioRef.current;
      const episodes = serieEpisodesRef.current;
      const ep = episodes[index];
      if (!el || !ep) return;
      serieIndexRef.current = index;
      store.getState().setSerieEpisode(index, ep.tn);
      el.currentTime = ep.inicio / 1000;
      el.play().catch(() => {});
      store.getState().announce(ep.titulo);
    },
    [store],
  );

  const serieNextEpisode = useCallback(() => {
    const i = serieIndexRef.current;
    if (i < serieEpisodesRef.current.length - 1) serieSeekEpisode(i + 1);
  }, [serieSeekEpisode]);

  const seriePrevEpisode = useCallback(() => {
    const i = serieIndexRef.current;
    if (i > 0) serieSeekEpisode(i - 1);
  }, [serieSeekEpisode]);

  const serieRestartEpisode = useCallback(() => {
    serieSeekEpisode(serieIndexRef.current);
  }, [serieSeekEpisode]);

  const serieSelectSeason = useCallback(
    (numero: number) => {
      const i = serieEpisodesRef.current.findIndex((e) => e.tn === numero);
      if (i >= 0) serieSeekEpisode(i);
    },
    [serieSeekEpisode],
  );
```

- [ ] **Step 4: Tear down series in `stopFileStream`** — inside `stopFileStream`
(~line 1712, next to the TV teardown), add:

```ts
      // Tear down series playback (keep the element + source node, reused next time).
      serieAudioRef.current?.pause();
      if (serieAudioRef.current) serieAudioRef.current.src = "";
      try {
        serieSourceRef.current?.disconnect();
      } catch {
        /* not connected */
      }
      if (serieProgressTimerRef.current) {
        clearTimeout(serieProgressTimerRef.current);
        serieProgressTimerRef.current = null;
      }
      serieActiveRef.current = false;
      serieEpisodesRef.current = [];
      serieNameRef.current = null;
      store.getState().clearSerie();
```

- [ ] **Step 5: Guard the other starters** — in `startFileSource` (~line 1842),
`startPlaylist` (~line 2164), and `startTvChannel` (~line 1914, the silent
`stopFileStream` already covers it), ensure a playing series is torn down first.
`stopFileStream` now handles series teardown, so the existing
`await stopFileStream({ silent: true })` / `if (tvActiveRef.current) await stopFileStream(...)`
lines are sufficient — **add an analogous guard** in `startFileSource` and
`startPlaylist` right beside the `tvActiveRef` guard:

```ts
      if (serieActiveRef.current) await stopFileStream({ silent: true });
```

- [ ] **Step 6: Return the new functions** — add to the hook's returned object
(~line 2487, next to `startTvChannel`):

```ts
    startSerie,
    serieSeekEpisode,
    serieNextEpisode,
    seriePrevEpisode,
    serieRestartEpisode,
    serieSelectSeason,
```

- [ ] **Step 7: Add the message keys** to `client/messages/es.json`:

```json
"serie_empty": "Esta serie no tiene episodios.",
"serie_play_error": "No se pudo reproducir esa serie."
```

- [ ] **Step 8: Regenerate Paraglide + typecheck**

Run:
```bash
pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide
pnpm --filter client exec tsc --noEmit
```
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add client/src/hooks/useMediasoup.ts client/messages/es.json
git commit -m "feat(serieteca): startSerie + episode navigation (room broadcast via proxy)"
```

---

### Task 5: `SerietecaDialog` + "Serieteca" button + Room wiring

**Files:**
- Create: `client/src/components/SerietecaDialog.tsx`
- Modify: `client/src/components/AudioControls.tsx`
- Modify: `client/src/components/Room.tsx`
- Modify: `client/messages/es.json`

**Interfaces:**
- Consumes: `startSerie` (Task 4), `serieteca` lib (Task 2).
- `SerietecaDialog` props: `{ onClose: () => void; onPlaySerie: (s: Serie) => Promise<void> }`.

- [ ] **Step 1: Add message keys** to `client/messages/es.json`:

```json
"controls_serieteca": "Serieteca",
"controls_serieteca_title": "Abrir la serieteca",
"serieteca_heading": "Serieteca",
"serieteca_search": "Buscar serie",
"serieteca_loading": "Cargando series…",
"serieteca_empty": "No hay series.",
"serieteca_error": "No se pudo cargar la serieteca.",
"serieteca_close": "Cerrar",
"serieteca_continue": "Continuar escuchando",
"serieteca_latest": "Últimas agregadas",
"serieteca_no_results": "Sin resultados para tu búsqueda."
```

- [ ] **Step 2: Create `SerietecaDialog.tsx`** — model it on `TvDialog.tsx`
(same native `<dialog>` modal, index-based heading ids, keep-open-on-pick,
loading/empty/error states). Structure:
  - On mount: `fetchSeries()` → state `series`, plus `loading`/`error`.
  - A search `<input>` (`aria-label={m.serieteca_search()}`) filtering by
    `normalizeForSearch(nombre)`.
  - When the query is empty: render **"Continuar escuchando"** (series present in
    `loadProgress()`), **"Últimas agregadas"** (`series.slice(-20).reverse()`),
    then the full catalog `groupByPais(series)`. When the query is non-empty:
    render only matching series (flat list) or `m.serieteca_no_results()`.
  - Each series is a `<button>` calling `pick(s)`; picking does NOT close the
    dialog. `pick` is async with try/catch → an inline `playError` alert (same as
    TvDialog).
  - Categories/sections use `<h3 id={`serieteca-cat-${i}`}>` with
    `aria-labelledby` on their `<ul>` — index-based ids (never raw país text).
  - Close via an X button and Escape (native `<dialog>`).

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import * as m from "../paraglide/messages.js";
import {
  fetchSeries,
  groupByPais,
  loadProgress,
  normalizeForSearch,
  type Serie,
} from "../lib/serieteca";

export function SerietecaDialog({
  onClose,
  onPlaySerie,
}: {
  onClose: () => void;
  onPlaySerie: (s: Serie) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [series, setSeries] = useState<Serie[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [playError, setPlayError] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
    fetchSeries().then((s) => {
      if (s.length) setSeries(s);
      else setError(true);
    });
  }, []);

  const q = normalizeForSearch(query);
  const filtered = useMemo(
    () => (series && q ? series.filter((s) => normalizeForSearch(s.nombre).includes(q)) : null),
    [series, q],
  );

  const pick = async (s: Serie) => {
    setPlayError(null);
    try {
      await onPlaySerie(s);
    } catch {
      setPlayError(m.serie_play_error());
    }
  };

  const progress = series ? loadProgress() : {};
  const cont = series ? series.filter((s) => progress[s.nombre]) : [];
  const latest = series ? series.slice(-20).reverse() : [];
  const groups = series ? groupByPais(series) : [];

  const btn = (s: Serie) => (
    <li key={s.nombre}>
      <button type="button" className="w-full text-left …" onClick={() => pick(s)}>
        {s.nombre}
      </button>
    </li>
  );

  return (
    <dialog ref={dialogRef} onClose={onClose} className="…">
      <div className="flex items-center justify-between …">
        <h2>{m.serieteca_heading()}</h2>
        <button type="button" aria-label={m.serieteca_close()} onClick={() => dialogRef.current?.close()}>
          <X aria-hidden />
        </button>
      </div>

      {playError && <p role="alert">{playError}</p>}

      <input
        type="search"
        aria-label={m.serieteca_search()}
        placeholder={m.serieteca_search()}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {!series && !error && <p>{m.serieteca_loading()}</p>}
      {error && <p role="alert">{m.serieteca_error()}</p>}

      {filtered && (filtered.length ? <ul>{filtered.map(btn)}</ul> : <p>{m.serieteca_no_results()}</p>)}

      {series && !q && (
        <>
          {cont.length > 0 && (
            <section aria-labelledby="serieteca-cont">
              <h3 id="serieteca-cont">{m.serieteca_continue()}</h3>
              <ul>{cont.map(btn)}</ul>
            </section>
          )}
          <section aria-labelledby="serieteca-latest">
            <h3 id="serieteca-latest">{m.serieteca_latest()}</h3>
            <ul>{latest.map(btn)}</ul>
          </section>
          {groups.map((g, i) => (
            <section key={g.pais} aria-labelledby={`serieteca-cat-${i}`}>
              <h3 id={`serieteca-cat-${i}`}>{g.pais}</h3>
              <ul>{g.series.map(btn)}</ul>
            </section>
          ))}
        </>
      )}
    </dialog>
  );
}
```
(Match `TvDialog.tsx` for the exact Tailwind classes / modal chrome.)

- [ ] **Step 3: Add the "Serieteca" button** in `AudioControls.tsx` — mirror the
"TV en vivo" button. Add an `onOpenSerieteca: () => void` prop and a button with
a `lucide-react` icon (e.g. `Library`), `title={m.controls_serieteca_title()}`,
label `m.controls_serieteca()`, placed right after the TV button.

- [ ] **Step 4: Wire Room.tsx** — mirror the TV wiring: add
`const [serietecaOpen, setSerietecaOpen] = useState(false);`, destructure
`startSerie` from `useMediasoup`, pass `onOpenSerieteca={() => setSerietecaOpen(true)}`
to `AudioControls`, and render:

```tsx
{serietecaOpen && (
  <SerietecaDialog onClose={() => setSerietecaOpen(false)} onPlaySerie={startSerie} />
)}
```

- [ ] **Step 5: Regenerate Paraglide + typecheck + lint**

Run:
```bash
pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide
pnpm --filter client exec tsc --noEmit
pnpm lint
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/SerietecaDialog.tsx client/src/components/AudioControls.tsx client/src/components/Room.tsx client/messages/es.json
git commit -m "feat(serieteca): dialog (search + sections + país groups) + toolbar button"
```

---

### Task 6: Series player controls in the footer + keyboard shortcuts

**Files:**
- Modify: `client/src/components/Room.tsx`
- Modify: `client/messages/es.json`

**Interfaces:**
- Consumes: store serie state (Task 3) + navigation functions (Task 4).

- [ ] **Step 1: Add message keys** to `client/messages/es.json`:

```json
"serie_season": "Temporada",
"serie_episode": "Episodio",
"serie_next": "Siguiente episodio",
"serie_prev": "Episodio anterior",
"serie_restart": "Reiniciar episodio"
```

- [ ] **Step 2: Render series controls** in the player footer in `Room.tsx`, shown
only when `serieName != null` (read `serieName`, `serieSeasons`, `serieEpisodes`,
`serieEpisodeIndex`, `serieCurrentSeason` from the store; destructure
`serieSeekEpisode`, `serieNextEpisode`, `seriePrevEpisode`, `serieRestartEpisode`,
`serieSelectSeason` from `useMediasoup`):
  - **Season `<select>`** (hidden when `serieSeasons.length <= 1`), value
    `serieCurrentSeason`, `aria-label={m.serie_season()}`; on change →
    `serieSelectSeason(Number(value))`.
  - **Episode `<select>`** listing only episodes of the current season:
    `serieEpisodes.map((e,i)=>({e,i})).filter(x=>x.e.tn===serieCurrentSeason)`,
    option value = global index `i`, text `e.titulo`, value `serieEpisodeIndex`,
    `aria-label={m.serie_episode()}`; on change → `serieSeekEpisode(Number(value))`.
  - **Buttons:** `m.serie_prev()` → `seriePrevEpisode`, `m.serie_next()` →
    `serieNextEpisode`, `m.serie_restart()` → `serieRestartEpisode`. Reuse the
    footer's existing play/pause + volume controls (they act on `fileVolumeGain`,
    already wired for any streamer).

- [ ] **Step 3: Add keyboard shortcuts** — extend the existing player keydown
handler (or add one) so, when a series is active (`serieName != null`), `Alt`+key
triggers: `k` play/pause (existing), `j` −15s, `l` +15s, `s` `serieNextEpisode`,
`a` `seriePrevEpisode`, `r` `serieRestartEpisode`, `i` announce
`{serieName}. {episodio actual}. ` via the store's `announce()`. Call
`e.preventDefault()` when handled. Keep this consistent with any existing
player-mode Up/Down volume handling; do not shadow global shortcuts when no
series is active.

- [ ] **Step 4: Regenerate Paraglide + typecheck + lint**

Run:
```bash
pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide
pnpm --filter client exec tsc --noEmit
pnpm lint
```
Expected: no errors.

- [ ] **Step 5: Verify in the browser** — start the dev servers
(`preview_start {name}`), join a room, open Serieteca, pick a series; confirm:
  - It plays (footer shows the series name).
  - Season/episode selectors populate; changing the episode seeks.
  - Next/prev/restart work; the current episode is announced on change.
  - Check `read_network_requests` for `/api/audio-proxy?url=…m4b` returning
    206/200 (Range), and that seeking a later episode does NOT download the whole
    file (multiple ranged requests, not one huge transfer).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Room.tsx client/messages/es.json
git commit -m "feat(serieteca): season/episode controls + keyboard shortcuts in the player"
```

---

### Task 7: Documentation (CHANGELOG + CLAUDE.md)

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: CHANGELOG entry** — add a new dated section (newest first, 2026-07-21)
under the convention header, on the `feat/serieteca` branch: **qué** (Serieteca:
botón → diálogo con buscador + secciones + países; suena en la sala; reproductor
con temporadas/episodios; progreso en localStorage), **cómo** (un `.m4b` continuo
por serie, episodios = rangos en ms → seek; vía `/api/audio-proxy` por CORS; el
proxy ahora sirve `.m4b` por la vía directa con Range; DB directa de archive.org),
**por qué** / riesgos (prueba en vivo con 2º peer + seek por Range).

- [ ] **Step 2: CLAUDE.md architecture subsection** — add a "### Serieteca
(series de audio)" subsection near the TV one, covering: one `.m4b` per serie
(ms ranges, continuous across seasons, flatten+seek), room broadcast via
`fileVolumeGain` (no producer), `.m4b` proxied by `/api/audio-proxy` for CORS +
the direct-Range requirement (`browserPlayableAudioType`), catalog fetched from
`https://archive.org/download/m4bua/series.json`, localStorage progress, and that
it needs no new server binaries (plain `<audio>`, no Shaka).

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs(serieteca): CHANGELOG + CLAUDE.md architecture note"
```

---

## Self-Review notes

- **Spec coverage:** listing (search + país groups + continue + latest) → Task 5;
  full player (season/episode/next/prev/restart + shortcuts + announce) → Task 6;
  room broadcast via proxy + CORS fix → Tasks 1 & 4; ms-range flatten/seek →
  Tasks 2 & 4; localStorage progress → Tasks 2 & 4; DB from archive.org → Task 2.
  Dropped (YAGNI: accounts, server stats, TV-linking) — not planned. ✓
- **Type consistency:** `Episode`/`SeasonInfo`/`Serie` defined in Task 2, consumed
  by Tasks 3–6 with the same shapes. `startSerie(serie)` signature consistent
  across Tasks 4–5. ✓
- **Placeholders:** component Tailwind chrome intentionally deferred to "match
  TvDialog.tsx" (an existing concrete reference), not a logic placeholder. ✓
