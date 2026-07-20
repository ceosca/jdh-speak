# TV en vivo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "TV en vivo" button that opens a channel picker (categories as headings, channel buttons below, from a server-served `tv/db.json`) and plays the chosen DASH+ClearKey channel — decrypted client-side with Shaka Player — into the room, controlled by the existing player footer (volume + stop).

**Architecture:** The server exposes `/api/tv-channels` reading `tv/db.json` (gitignored). The client lazy-loads Shaka Player, plays the channel on a dedicated `<audio>` element, and routes it through the existing `fileVolumeGain → outDest` node so it broadcasts on the voice track (reusing the "URL stream = only volume" player mode). Picking a channel does NOT close the dialog; Escape no longer closes the player.

**Tech Stack:** TypeScript, React 19, zustand, Web Audio, Express, socket.io, mediasoup-client, **shaka-player ^4.7** (client, lazy `import()`), node:test (server).

## Global Constraints

- **pnpm via `corepack pnpm …`** (never npm). Spanish-only UI; new strings in `client/messages/es.json`; `client/src/paraglide/**` is generated — **regenerate before tsc** (`corepack pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide`); a stale dir causes false message-key tsc errors.
- **The client has no test suite.** Client tasks verify with **static gates + manual**: `corepack pnpm --filter client exec tsc --noEmit`, `corepack pnpm lint`, `corepack pnpm --filter client build`. Only the **server** gets a unit test (node:test via tsx).
- ICE/TURN, sounds, and other recent features must keep working — this feature only adds a parallel audio path; it must **not** create a separate producer (no SFU pin) and must reuse `fileVolumeGain`.
- No `sonicroom`/`SonicRoom` strings anywhere.
- On every push, append a `CHANGELOG.md` entry (newest first).
- Pre-existing server test note: on Windows the transcode-lifecycle tests fail (fake timers / fake spawn) — that's expected, not a regression.

---

### Task 1: Server — channel parser + `/api/tv-channels` endpoint

**Files:**
- Create: `server/src/tv-channels.ts`
- Test: `server/src/tv-channels.test.ts`
- Modify: `server/src/index.ts`
- Modify: `.gitignore`
- Create: `tv/README.md`

**Interfaces:**
- Produces: `interface Channel { nombre: string; categoria: string; url: string; key: string }` and `parseTvChannels(raw: string): Channel[]` (invalid JSON / non-array → `[]`; drops entries missing any of the four string fields).
- Produces HTTP: `GET /api/tv-channels` → `Channel[]` (`[]` when `tv/db.json` is absent/unreadable).

- [ ] **Step 1: Write the failing test** — `server/src/tv-channels.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTvChannels } from "./tv-channels.js";

describe("parseTvChannels", () => {
  it("keeps well-formed channels", () => {
    const raw = JSON.stringify([
      { nombre: "TELEFE", categoria: "Argentina", url: "https://x/y.mpd", key: "aa:bb" },
    ]);
    const out = parseTvChannels(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0].nombre, "TELEFE");
    assert.equal(out[0].key, "aa:bb");
  });

  it("drops malformed entries, non-arrays, and returns [] on bad JSON", () => {
    assert.deepEqual(parseTvChannels("{}"), []);
    assert.deepEqual(parseTvChannels("not json"), []);
    const raw = JSON.stringify([
      { nombre: "OK", categoria: "C", url: "u", key: "k" },
      { nombre: "missing key", categoria: "C", url: "u" },
      42,
      null,
    ]);
    assert.equal(parseTvChannels(raw).length, 1);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module not found)

Run: `corepack pnpm --filter server exec node --import tsx --test src/tv-channels.test.ts`
Expected: FAIL (`Cannot find module './tv-channels.js'`).

- [ ] **Step 3: Implement `server/src/tv-channels.ts`**

```ts
export interface Channel {
  nombre: string;
  categoria: string;
  url: string;
  // ClearKey as "kid:key" (hex:hex) — decrypted client-side by Shaka.
  key: string;
}

// Parse the operator's tv/db.json. Keeps only well-formed entries (all four
// string fields present) so a partial/messy file still yields the good
// channels. Returns [] on invalid JSON or a non-array.
export function parseTvChannels(raw: string): Channel[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.filter(
    (c): c is Channel =>
      !!c &&
      typeof c === "object" &&
      typeof (c as Channel).nombre === "string" &&
      typeof (c as Channel).categoria === "string" &&
      typeof (c as Channel).url === "string" &&
      typeof (c as Channel).key === "string",
  );
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `corepack pnpm --filter server exec node --import tsx --test src/tv-channels.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the endpoint in `server/src/index.ts`**

Add to the imports at the top (near the other `node:` imports):
```ts
import { readFile, stat } from "node:fs/promises";
```
Add near the other `./` imports:
```ts
import { parseTvChannels, type Channel } from "./tv-channels.js";
```
After `const PORT = …` (before `async function main()`), add:
```ts
// TV channels live in tv/db.json at the repo root (next to sounds/). It's an
// operator-managed deployment file (gitignored, may hold DRM keys). Re-read only
// when the file's mtime changes so edits show up without a restart.
const TV_DB_PATH = path.resolve(__dirname, "../../tv/db.json");
let tvCache: { mtimeMs: number; channels: Channel[] } | null = null;
async function loadTvChannels(): Promise<Channel[]> {
  try {
    const s = await stat(TV_DB_PATH);
    if (tvCache && tvCache.mtimeMs === s.mtimeMs) return tvCache.channels;
    const channels = parseTvChannels(await readFile(TV_DB_PATH, "utf8"));
    tvCache = { mtimeMs: s.mtimeMs, channels };
    return channels;
  } catch {
    return []; // absent/unreadable — TV is optional
  }
}
```
Inside `main()`, next to the other `app.get(...)` routes (e.g. right after the `/api/audio-proxy` block), add:
```ts
  // Operator-managed live-TV channel list (see docs/superpowers/specs/...tv...).
  app.get("/api/tv-channels", async (_req, res) => {
    res.json(await loadTvChannels());
  });
```

- [ ] **Step 6: `.gitignore` — ignore the data, version the README**

Append to `.gitignore`:
```
# Operator-provided live-TV channel list (may hold DRM keys) + the standalone tool
/tv/*
!/tv/README.md
```

- [ ] **Step 7: Create `tv/README.md`**

```markdown
# Canales de TV en vivo (`tv/db.json`)

El servidor sirve este archivo en `GET /api/tv-channels`. **No** se versiona
(puede tener llaves DRM). Editalo a mano para agregar/quitar canales — sin
recompilar ni reiniciar (el endpoint relee cuando cambia el archivo).

`db.json` es un array. Cada canal:

```json
{
  "nombre": "TELEFE AMBA",
  "categoria": "Argentina",
  "url": "https://.../variant.mpd",
  "key": "KID_hex:LLAVE_hex"
}
```

- `categoria` agrupa los canales (encabezados en la app).
- `url` es un manifiesto DASH (`.mpd`).
- `key` es la ClearKey en formato `kid:key` (hex:hex); Shaka la usa para descifrar
  en el navegador. Requiere Chrome (EME/ClearKey).
```

- [ ] **Step 8: Verify + commit**

Run: `corepack pnpm --filter server exec tsc --noEmit` (PASS) and `corepack pnpm --filter server exec node --import tsx --test src/tv-channels.test.ts` (PASS).
Manual (optional, with the server running): `curl -s localhost:3100/api/tv-channels | head` returns the JSON array (or `[]` if no file).
```bash
git add server/src/tv-channels.ts server/src/tv-channels.test.ts server/src/index.ts .gitignore tv/README.md
git commit -m "feat(tv): serve operator-managed channel list at /api/tv-channels"
```

---

### Task 2: Client — `shaka-player` dependency + `lib/tv.ts` helpers

**Files:**
- Modify: `client/package.json` (via `pnpm add`)
- Create: `client/src/lib/tv.ts`
- (Maybe) Create: `client/src/shaka.d.ts`

**Interfaces:**
- Produces: `interface Channel { nombre; categoria; url; key: string }`; `fetchTvChannels(): Promise<Channel[]>`; `groupByCategoria(channels): { categoria: string; channels: Channel[] }[]`; `parseClearKey(key: string): Record<string,string> | null`.

- [ ] **Step 1: Add Shaka (pinned to 4.x to match the working standalone tool)**

Run: `corepack pnpm --filter client add shaka-player@^4.7`
(If `pnpm-workspace.yaml` gets an `allowBuilds:` stub, delete it — see CLAUDE.md.)

- [ ] **Step 2: Create `client/src/lib/tv.ts`**

```ts
export interface Channel {
  nombre: string;
  categoria: string;
  url: string; // DASH .mpd
  key: string; // ClearKey "kid:key" (hex:hex)
}

// Fetch the operator-managed channel list from the server. [] on any failure
// (TV is optional).
export async function fetchTvChannels(): Promise<Channel[]> {
  try {
    const res = await fetch("/api/tv-channels");
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as Channel[]) : [];
  } catch {
    return [];
  }
}

// Group by categoria; categories A–Z, channels A–Z within each.
export function groupByCategoria(
  channels: Channel[],
): { categoria: string; channels: Channel[] }[] {
  const map = new Map<string, Channel[]>();
  for (const c of channels) {
    const list = map.get(c.categoria) ?? [];
    list.push(c);
    map.set(c.categoria, list);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([categoria, list]) => ({
      categoria,
      channels: [...list].sort((a, b) => a.nombre.localeCompare(b.nombre)),
    }));
}

// Split the "kid:key" field into Shaka's clearKeys map { kid: key }. null if
// malformed.
export function parseClearKey(key: string): Record<string, string> | null {
  const [kid, k] = key.split(":");
  if (!kid || !k) return null;
  return { [kid.replace(/-/g, "")]: k.replace(/-/g, "") };
}
```

- [ ] **Step 3: Typecheck; add a Shaka shim only if needed**

Run: `corepack pnpm --filter client exec tsc --noEmit`.
If tsc later (Task 3) errors on `import("shaka-player")` types, create `client/src/shaka.d.ts`:
```ts
declare module "shaka-player" {
  const shaka: {
    polyfill: { installAll(): void };
    Player: {
      isBrowserSupported(): boolean;
      new (media?: HTMLMediaElement): {
        configure(config: unknown): void;
        load(uri: string): Promise<void>;
        unload(): Promise<void>;
        destroy(): Promise<void>;
      };
    };
  };
  export default shaka;
}
```

- [ ] **Step 4: Commit**

```bash
git add client/package.json pnpm-lock.yaml client/src/lib/tv.ts
git commit -m "feat(tv): add shaka-player dep and channel helpers (lib/tv.ts)"
```

---

### Task 3: Client — playback in the hook (`startTvChannel`)

**Files:**
- Modify: `client/src/hooks/useMediasoup.ts`

**Interfaces:**
- Consumes: `Channel`, `parseClearKey` from `../lib/tv`.
- Produces: `startTvChannel(channel: Channel): Promise<void>` (added to the hook's return). Reuses `fileVolumeGain`, sets `fileStreamName`/`playerIsUrl` so the existing footer shows it. `stopFileStream` gains an optional `{ silent?: boolean }` and tears TV down.

- [ ] **Step 1: Import the helpers** (top of `useMediasoup.ts`, with the other `../lib` imports)

```ts
import { parseClearKey, type Channel } from "../lib/tv";
```

- [ ] **Step 2: Add TV refs** (near the other `useRef`s, e.g. by `shuffleOrderRef`)

```ts
// Live-TV playback (Shaka + a dedicated <audio>, routed through fileVolumeGain).
// createMediaElementSource is one-shot per element, so element + source are made
// once and reused; only the Shaka player's loaded content changes per channel.
const tvAudioRef = useRef<HTMLAudioElement | null>(null);
const tvSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
// Loosely typed: the shaka.Player instance (lazy-loaded).
const tvPlayerRef = useRef<{
  configure(c: unknown): void;
  load(u: string): Promise<void>;
  unload(): Promise<void>;
} | null>(null);
```

- [ ] **Step 3: Extract `ensureFileVolumeGain`** — in `ensureFileSlots`, replace the inline `fileVolumeGain` creation with a shared helper. Add this callback ABOVE `ensureFileSlots`:

```ts
// The single "streamer volume" node: files, URL streams and TV all feed it, and
// it feeds outDest (room) + the local monitor. Created lazily, once.
const ensureFileVolumeGain = useCallback(
  (g: NonNullable<typeof outGraphRef.current>) => {
    if (!g.fileVolumeGain) {
      g.fileVolumeGain = sharedAudioContext.createGain();
      g.fileVolumeGain.gain.value = store.getState().fileVolume;
      g.fileVolumeGain.connect(g.outDest);
      g.fileVolumeGain.connect(sharedAudioContext.destination);
    }
    return g.fileVolumeGain;
  },
  [store],
);
```
Then in `ensureFileSlots`, replace the `if (!g.fileVolumeGain) { … }` block with:
```ts
      // Ensure the shared volume node is ready before wiring slots into it.
      ensureFileVolumeGain(g);
```
and add `ensureFileVolumeGain` to `ensureFileSlots`'s dependency array.

- [ ] **Step 4: Extend `stopFileStream`** to accept `{ silent }` and tear TV down.

Change the signature/first line:
```ts
  const stopFileStream = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (store.getState().fileStreamName == null) return;
```
Right after the file-slots teardown loop (before `store.getState().setFileStream(null)`), add:
```ts
      // Tear down a TV channel if one is playing. Keep the element + source node
      // (reused next time); just unload Shaka, pause, and disconnect the source.
      if (tvPlayerRef.current) {
        void tvPlayerRef.current.unload().catch(() => {});
      }
      tvAudioRef.current?.pause();
      try {
        tvSourceRef.current?.disconnect();
      } catch {
        /* not connected */
      }
```
Add the URL-stream flag reset is already there; also reset it (it already calls `setPlayerIsUrl(false)`). Finally, guard the stop cue:
```ts
      // was: playCue(sharedAudioContext, "share-stop");
      if (!opts?.silent) playCue(sharedAudioContext, "share-stop");
```

- [ ] **Step 5: Add `startTvChannel`** (place it after `startUrlStream`)

```ts
const startTvChannel = useCallback(
  async (channel: Channel) => {
    const g = ensureOutGraph();
    resumeSharedContext();

    // One streamer source at a time — stop whatever's playing (silent: switching
    // channels shouldn't chime).
    await stopFileStream({ silent: true });

    const fvg = ensureFileVolumeGain(g);

    // Lazy-load Shaka the first time TV is used (keeps it out of the main bundle).
    const shaka = (await import("shaka-player")).default;
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      throw new Error("unsupported");
    }

    // Dedicated <audio> + Web Audio source, made once and reused.
    if (!tvAudioRef.current) {
      const el = new Audio();
      (el as unknown as Record<string, boolean>).playsInline = true;
      el.crossOrigin = "anonymous";
      tvAudioRef.current = el;
      tvSourceRef.current = sharedAudioContext.createMediaElementSource(el);
    }
    tvSourceRef.current!.connect(fvg);

    if (!tvPlayerRef.current) {
      tvPlayerRef.current = new shaka.Player(tvAudioRef.current);
    }
    const player = tvPlayerRef.current;
    const clearKeys = parseClearKey(channel.key);
    player.configure({ drm: clearKeys ? { clearKeys } : {} });
    await player.load(channel.url);
    await tvAudioRef.current.play().catch(() => {});

    store.getState().setFileStream(channel.nombre);
    store.getState().setPlayerIsUrl(true);
    store.getState().setFileStreamPlaying(true);
  },
  [ensureOutGraph, ensureFileVolumeGain, stopFileStream, store],
);
```

- [ ] **Step 6: Expose it** — add `startTvChannel,` to the hook's returned object (near `startUrlStream`).

- [ ] **Step 7: Verify + commit**

Run (regenerate paraglide first is unnecessary — no messages changed):
`corepack pnpm --filter client exec tsc --noEmit` (PASS — if it errors on shaka types, add `client/src/shaka.d.ts` from Task 2 Step 3), then `corepack pnpm lint` (PASS).
```bash
git add client/src/hooks/useMediasoup.ts client/src/shaka.d.ts 2>/dev/null; git add -A
git commit -m "feat(tv): startTvChannel — Shaka ClearKey playback routed into the room"
```

---

### Task 4: Client — `TvDialog` component + i18n

**Files:**
- Create: `client/src/components/TvDialog.tsx`
- Modify: `client/messages/es.json`

**Interfaces:**
- Consumes: `fetchTvChannels`, `groupByCategoria`, `Channel` from `../lib/tv`.
- Produces: `TvDialog({ onClose, onPlayChannel })` — `onClose: () => void`, `onPlayChannel: (c: Channel) => void`.

- [ ] **Step 1: Add i18n keys** to `client/messages/es.json` (anywhere sensible, e.g. near the `controls_*` keys):

```json
  "controls_tv": "TV en vivo",
  "controls_tv_title": "Abrir la lista de canales de TV en vivo",
  "tv_dialog_heading": "TV en vivo",
  "tv_dialog_loading": "Cargando canales…",
  "tv_dialog_empty": "No hay canales configurados",
  "tv_dialog_error": "No se pudo cargar la lista de canales",
  "tv_dialog_close": "Cerrar la lista de canales",
  "tv_dialog_play": "Reproducir {name}",
```

- [ ] **Step 2: Create `client/src/components/TvDialog.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { Tv, X } from "lucide-react";
import { m } from "../paraglide/messages.js";
import { fetchTvChannels, groupByCategoria, type Channel } from "../lib/tv";

interface TvDialogProps {
  onClose: () => void;
  // Play a channel. The dialog stays OPEN (switch channels without reopening) —
  // it closes only via the X or Escape.
  onPlayChannel: (channel: Channel) => void;
}

// Live-TV channel picker. A native <dialog> (inert background, Escape closes the
// dialog — not the player). Channels come from /api/tv-channels, grouped by
// categoria: each category is an <h3> heading (H-navigable in NVDA) with a button
// per channel below. Picking a channel plays it and keeps the dialog open.
export function TvDialog({ onClose, onPlayChannel }: TvDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [groups, setGroups] = useState<{ categoria: string; channels: Channel[] }[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [playing, setPlaying] = useState<string>("");

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    closeRef.current?.focus();
    return () => dlg?.close();
  }, []);

  useEffect(() => {
    let active = true;
    void fetchTvChannels().then((channels) => {
      if (!active) return;
      if (channels.length === 0) {
        setState("empty");
        return;
      }
      setGroups(groupByCategoria(channels));
      setState("ready");
    });
    return () => {
      active = false;
    };
  }, []);

  const pick = (c: Channel) => {
    setPlaying(c.url);
    onPlayChannel(c);
  };

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tv-dialog-heading"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="w-full max-w-md rounded-xl border border-sonic-600 bg-sonic-800 p-4 text-sonic-100 shadow-2xl backdrop:bg-black/70"
    >
      <div className="mb-4 flex items-center gap-2">
        <Tv className="h-5 w-5 text-sonic-accent" aria-hidden="true" />
        <h2 id="tv-dialog-heading" className="text-base font-semibold text-sonic-100">
          {m.tv_dialog_heading()}
        </h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
          aria-label={m.tv_dialog_close()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {state === "loading" && <p className="text-sm text-sonic-400">{m.tv_dialog_loading()}</p>}
      {state === "empty" && <p className="text-sm text-sonic-400">{m.tv_dialog_empty()}</p>}
      {state === "error" && (
        <p role="alert" className="text-sm text-muted">
          {m.tv_dialog_error()}
        </p>
      )}

      {state === "ready" && (
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          {groups.map((g) => (
            <section key={g.categoria} aria-labelledby={`tv-cat-${g.categoria}`}>
              <h3
                id={`tv-cat-${g.categoria}`}
                className="mb-1 text-xs font-semibold uppercase tracking-wide text-sonic-300"
              >
                {g.categoria}
              </h3>
              <div className="grid grid-cols-2 gap-1.5">
                {g.channels.map((c) => (
                  <button
                    key={c.url}
                    type="button"
                    onClick={() => pick(c)}
                    aria-current={c.url === playing ? "true" : undefined}
                    aria-label={m.tv_dialog_play({ name: c.nombre })}
                    className={`truncate rounded-lg px-2 py-1.5 text-left text-xs font-medium ${
                      c.url === playing
                        ? "bg-sonic-accent text-white"
                        : "bg-sonic-700 text-sonic-100 hover:bg-sonic-600"
                    }`}
                    title={c.nombre}
                  >
                    {c.nombre}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </dialog>
  );
}
```

- [ ] **Step 3: Verify + commit**

Run: regenerate paraglide (`corepack pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide`), then `corepack pnpm --filter client exec tsc --noEmit` (PASS) and `corepack pnpm lint` (PASS).
```bash
git add client/src/components/TvDialog.tsx client/messages/es.json
git commit -m "feat(tv): TvDialog — categories as headings, a button per channel"
```

---

### Task 5: Client — wire it up (button, Room, Escape change)

**Files:**
- Modify: `client/src/components/AudioControls.tsx`
- Modify: `client/src/components/Room.tsx`
- Modify: `client/src/components/FileStreamPlayer.tsx`

**Interfaces:**
- Consumes: `startTvChannel` (hook), `TvDialog`, `Channel`.
- Produces: `AudioControls` gains `onOpenTv: () => void`; `Room` owns `tvOpen` state.

- [ ] **Step 1: `AudioControls.tsx` — add the button**

Add `Tv` to the `lucide-react` import. Add to `AudioControlsProps`:
```ts
  // Opens the live-TV channel picker.
  onOpenTv: () => void;
```
Add `onOpenTv,` to the destructured props. After the "Abrir URL" button block, add:
```tsx
        {/* Live TV channels */}
        <button
          onClick={onOpenTv}
          className={`${btn} ${idle}`}
          aria-label={m.controls_tv()}
          title={m.controls_tv_title()}
        >
          <Tv className="h-5 w-5" />
        </button>
```

- [ ] **Step 2: `Room.tsx` — state, wiring, dialog**

Add the imports:
```ts
import { TvDialog } from "./TvDialog";
```
Destructure `startTvChannel` from `useMediasoup()` (next to `startUrlStream`).
Add state next to `urlOpen`:
```ts
  const [tvOpen, setTvOpen] = useState(false);
```
Pass to `<AudioControls … />`:
```tsx
            onOpenTv={() => setTvOpen(true)}
```
Where `{urlOpen && <UrlDialog … />}` is, add below it:
```tsx
      {tvOpen && (
        <TvDialog onClose={() => setTvOpen(false)} onPlayChannel={(c) => void startTvChannel(c)} />
      )}
```

- [ ] **Step 3: `FileStreamPlayer.tsx` — Escape no longer closes the player**

In `onKeyDown`, delete the whole Escape block:
```ts
    // DELETE THIS:
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
```
(Leave the rest of `onKeyDown` intact. The player now closes only via its X button or the toolbar toggle. The TvDialog/UrlDialog still handle their own Escape.)

- [ ] **Step 4: Verify + commit**

Run: regenerate paraglide, then `corepack pnpm --filter client exec tsc --noEmit`, `corepack pnpm lint`, `corepack pnpm --filter client build` — all PASS.
```bash
git add client/src/components/AudioControls.tsx client/src/components/Room.tsx client/src/components/FileStreamPlayer.tsx
git commit -m "feat(tv): TV en vivo button + dialog wiring; Escape no longer closes the player"
```

---

### Task 6: End-to-end verification + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Static gates (whole workspace)**

Run and confirm PASS: `corepack pnpm --filter client exec tsc --noEmit`, `corepack pnpm --filter server exec tsc --noEmit`, `corepack pnpm lint`, `corepack pnpm --filter server test` (only the pre-existing Windows transcode-lifecycle failures), `corepack pnpm --filter client build`.

- [ ] **Step 2: Manual — the real check (needs `tv/db.json` with a real channel + a second peer)**

Start server + client (`corepack pnpm --filter server exec tsx watch src/index.ts`; then `corepack pnpm --filter client exec vite`). In the app:
- "TV en vivo" → dialog shows categories (headings) + channel buttons.
- Pick a channel → it plays; **the dialog stays open**; picking another switches.
- **A second peer in the room hears the channel** (this validates CORS/re-broadcast — if the peer hears silence, the channel's CDN isn't sending CORS headers; note which channels work).
- The player footer shows the channel in "only volume" mode; the volume slider lowers it for everyone.
- **Escape** closes the dialog but the channel keeps playing; **Escape does not close the player**.
- The player's **X** (or the toolbar toggle) stops the channel and tears Shaka down.

- [ ] **Step 3: CHANGELOG + commit**

Prepend an entry under today's date to `CHANGELOG.md`:
```markdown
### `<hash>` — TV en vivo: canales de TV en la sala

- **Qué:** botón "TV en vivo" → diálogo con categorías (encabezados) + un botón
  por canal (de `tv/db.json` servido por el server). Al elegir, el canal suena
  **para toda la sala** y el diálogo queda abierto (se cambia de canal sin
  reabrir; se cierra con X/Escape). Se controla desde el pie del reproductor
  (volumen + detener). **Escape ya no cierra el reproductor.**
- **Cómo:** `GET /api/tv-channels` lee `tv/db.json` (gitignored). El cliente
  reproduce DASH+ClearKey con **Shaka Player** (carga diferida) en un `<audio>`
  propio enrutado por `fileVolumeGain → outDest` (misma vía que un stream de URL,
  sin productor aparte). `startTvChannel` en el hook; `TvDialog.tsx`; `lib/tv.ts`.
- **Riesgo verificado:** re-emisión a la sala depende de CORS del CDN del canal.
- **Fuera de v1:** timeshift, idioma, grabación, panel de administración.
```
```bash
git add CHANGELOG.md
git commit -m "docs(changelog): record TV en vivo"
```

## Self-Review

- **Spec coverage:** button + dialog with headings/buttons (T4/T5); broadcast to room via fileVolumeGain (T3); minimal footer controls reused (T3 sets playerIsUrl); dialog stays open on pick (T4); Escape stops closing the player (T5); server-served gitignored db.json (T1); Shaka lazy ClearKey (T2/T3); README (T1); CORS caveat verified (T6). All covered.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `Channel` shape identical in `server/src/tv-channels.ts` and `client/src/lib/tv.ts`; `startTvChannel(channel: Channel)` and `ensureFileVolumeGain(g)` names consistent across T3; `TvDialog` prop names (`onClose`, `onPlayChannel`) match T5 wiring; `stopFileStream({ silent })` optional so existing callers (X button, onError) keep working.
