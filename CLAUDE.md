# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ Migration note (2026-06-28) — read after pulling

The project was fully renamed from **SonicRoom** to **JDH Speak**. Anyone pulling
these changes should know:

- **localStorage keys changed** from `sonicroom:*` to `jdh-speak:*`. Locally saved
  settings (mic gain, display name, player volume/speed/repeat, selected devices,
  per-room `p2p-off`) **reset once** on the next page load. Harmless — just re-set them.
- **Deployment paths renamed.** The systemd unit is now `jdh-speak.service` (was
  `sonicroom.service`) and it expects the app at **`/home/jdh-speak`** (was
  `/home/sonicroom`), with `EnvironmentFile=/home/jdh-speak/.env`. The default
  `AUDIO_LIBRARY_DIR` is now `/var/lib/jdh-speak/media`. If you run a live server
  from the old paths, move it (or override via env) before restarting, and
  reinstall the renamed unit (`systemctl daemon-reload`).
- **Package name** is now `jdh-speak`; the runtime config global is
  `window.__JDH_SPEAK_CONFIG__`; recording download files are `jdh-speak-*.ogg/.zip`.
- No `sonicroom`/`SonicRoom` string remains anywhere in the repo — keep it that way.

Also removed as dead code this round: the entire **auto-ducking** subsystem
(server stopped driving it) and **push-to-talk** store state (no UI used it).

## Change log — read & maintain `CHANGELOG.md`

There's a running **`CHANGELOG.md`** at the repo root that records every change
that lands (what / how / why), newest first. **Read it** to catch up on recent
work if you've lost context. **Convention: on every `git push`, append an entry**
for what shipped, so Cristian (and any future Claude) can follow the project
without re-reading all the code.

## ✅ We run our own TURN (done — was the pending infra task)

The third-party coturn (`turn.oriolgomez.com`, Oriol's borrowed VPS) is **gone
from the code**. We now run **our own coturn on the Pi**, and the ICE servers are
**configured from the deployment's `.env`** — injected into the served
`index.html` like `INSTANCE_NAME`, so changing the TURN is an `.env` edit +
server restart, with **no client rebuild and no credentials in the repo**.

- Client reads them via `getIceServers()` (`client/src/lib/ice.ts`); with no
  `TURN_*` set it falls back to public STUN only. **Never hardcode a TURN here.**
- Env vars: `TURN_URLS` (comma-separated), `TURN_USERNAME`, `TURN_CREDENTIAL`,
  optional `STUN_URLS`. See `server/src/index.ts` (`buildIceServers`).
- **Port ranges are shared and must stay disjoint:** the router forwards
  `40000-40100`; mediasoup is capped to `40000-40059`
  (`server/src/mediasoup-config.ts`) and coturn's relay uses `40060-40100`.
  Widening `rtcMaxPort` again would collide with the TURN.
- coturn config lives on the Pi at `/etc/turnserver.conf` (not in this repo):
  auth required, quotas, and all private ranges denied.

**Details, config and how to verify: [`docs/turn-server.md`](docs/turn-server.md).**

## What this is

JDH Speak — low-latency browser audio conferencing (voice) with hi-fi stereo music casting. pnpm monorepo:

- `client/` — React 19 + Vite + Tailwind v4 + zustand, using `mediasoup-client` and `socket.io-client`.
- `server/` — Express 5 + socket.io + `mediasoup` (SFU) + `zod`. Runs TypeScript **directly via `tsx`** (no build artifact).

**Use pnpm, never npm.** It's a pnpm workspace, and `onlyBuiltDependencies` (in `pnpm-workspace.yaml`) builds esbuild and mediasoup's native worker. Reinstalling/adding deps can purge `node_modules` and drop the prebuilt `mediasoup-worker` binary — if the server then fails with a worker error on startup, run `pnpm install` to rebuild it. Also: `pnpm add` (v11) may write a malformed `allowBuilds:` stub into `pnpm-workspace.yaml` that then breaks every `pnpm` run with `ERR_PNPM_IGNORED_BUILDS` on the deps-status check — **delete that stub** (esbuild/mediasoup are already approved via `onlyBuiltDependencies`).

## Commands

**System binaries** (the server shells out to these — install on the host, on `PATH` or pointed to by `FFMPEG_PATH` / `YTDLP_PATH`):

- **`ffmpeg`** — recording, Icecast streaming, and transcoding URL/stream audio sources to Opus/WebM.
- **`yt-dlp`** — audio extraction for the in-call URL streamer when a link isn't a direct media URL (YouTube/SoundCloud/IPTV pages, via `/api/audio-proxy`). Keep it current — extraction breaks against site changes when stale (`pip install -U yt-dlp` or the official binary; distro packages lag).

```bash
pnpm install                 # workspace install (builds mediasoup worker)
pnpm dev                     # server (tsx watch :3100) + client (vite :5173) together
pnpm dev:server              # server only
pnpm dev:client              # client only — vite proxies /socket.io and /api to :3100
pnpm build                   # builds the CLIENT only -> client/dist (server needs no build)
pnpm start                   # prod: server runs signaling AND serves client/dist statically
pnpm --filter server test    # server tests (node:test via tsx)
pnpm lint                    # eslint (flat config in eslint.config.mjs, whole workspace)
pnpm format                  # prettier --write (printWidth 100; generated/dist ignored)
pnpm format:check            # prettier in CI/check mode
```

Run a single server test file / single test:

```bash
pnpm --filter server exec node --import tsx --test src/recording-util.test.ts
pnpm --filter server exec node --import tsx --test --test-name-pattern="PortAllocator" "src/**/*.test.ts"
pnpm --filter client exec tsc --noEmit     # typecheck the client
pnpm --filter server exec tsc --noEmit     # typecheck the server (it runs untyped via tsx, so this is the only type gate)
```

Only the server has tests (the client has none). They cover the pure helpers (`recording-util.ts`, `chat-util.ts`, `zip-stream.ts`, `streaming-util.ts`, `kick-util.ts`, `audio-sources.ts`) **and** the stateful managers (`recording.ts`, `streaming.ts`): each manager (and the `audio-sources` transcode resolvers) takes injected deps (`RecordingDeps` / `StreamDeps` / an injected `spawn`) so the tests drive it with fakes — a fake `spawn` (no real ffmpeg/yt-dlp), structural mediasoup Router/Transport/Consumer, a fake clock and fake timers — asserting on the args/SDP/ports/lifecycle without launching a process or touching media.

## Architecture

### Hybrid P2P ↔ SFU transport (the core idea)

A room dynamically switches transport based on size and needs. **`decideMode(peerCount, currentMode, forceSfu)` in `server/src/recording-util.ts` is the single, pure source of truth** — both the join and leave handlers in `signaling.ts` re-evaluate through it:

- ≤2 peers → **P2P mesh**: clients connect WebRTC directly; the server only relays signaling (`p2p-signal`). Media never touches the server.
- 3+ peers → **mediasoup SFU**.
- `forceSfu` pins the SFU even with ≤2 peers when the server _must_ see the media: while **recording** (P2P media is invisible to the server), when a **music caster** is present, or when **`?p2p=off`** was set (`shouldForceSfu` in `signaling.ts`).

On transitions the server emits `switch-to-sfu` / `switch-to-p2p`; the client (`useMediasoup.ts`) tears down one transport stack and builds the other. The outgoing audio graph (below) survives the switch — only senders/producers are rebuilt.

### Client audio graph (`client/src/hooks/useMediasoup.ts`)

One module-scoped shared `AudioContext` for the whole session (resumed on first user gesture for iOS).

- **Outgoing**: `mic → micGain → soft limiter → outDest`. The track added to peers / produced to the SFU is **always `outDest`'s stream track**, so tracks are never swapped on senders/producer across mode switches or when sharing audio. Shared system/tab audio (`getDisplayMedia`) is mixed **straight into `outDest`**, bypassing the mic gain/limiter so music keeps its dynamics.
- **Incoming**: per-peer `MediaStreamSource → gainNode → destination`. `effectiveGain(peerId)` composes per-peer volume × deafen × music ducking; every place that changes gain ramps via `setTargetAtTime`.

### Auto-ducking (controlled client-side)

The server's `AudioLevelObserver` watches **voice producers only** — music/caster producers are deliberately never added to it. It emits `duck {active}` on each on/off transition (`wireDucking` in `signaling.ts`). The **client** does the actual gain ramp: music-peer gain → `volume * DUCK_FACTOR` with `DUCK_ATTACK` (voice starts) / `DUCK_RELEASE` (voice stops) time-constants. Ecobox/the caster just sends raw stereo; ducking timing lives in the client constants, not the caster.

### Music caster (Ecobox)

A send-only "music caster" peer joins with `role: "caster"` (see `joinSchema`). It produces a stereo track but never consumes or sets up P2P, so its presence forces the room onto the SFU. Voice defaults to **mono ~64 kbps** for everyone; it's a **per-user opt-in** to send **stereo ~128 kbps** ("Hi-fi voice" toggle in `DeviceSettings`, persisted as `jdh-speak:hifiVoice`, default off — `hifiVoiceEnabled` in the store). The flag is read at **call start** — `forceOpusParams(sdp, hifi)` in `client/src/lib/sdp-munger.ts` sets `stereo`/`maxaveragebitrate` on the P2P fmtp, and the SFU `produce` sets `opusStereo`/`opusMaxAverageBitrate`; `microphoneConstraints` captures 1 vs 2 channels to match. It applies on the **next** call (the live producer's codec can't be re-negotiated mid-call). Why opt-in: most mics are mono (so stereo adds nothing audible) and 128k voice costs **every listener** bandwidth in the SFU fan-out. The router's `maxaveragebitrate: 256000` (`mediasoup-config.ts`) is a **ceiling** above even hi-fi voice — it lets the dedicated stereo caster/share/file producers negotiate full hi-fi — **do not lower it to 64000**, that silently clamps music to voice quality.

### Server-side recording (`server/src/recording.ts` + `recording-util.ts`)

Recording is server-side and forces SFU. Per producer: a mediasoup `PlainTransport` pushes RTP to a local UDP port (`PortAllocator` hands out P/P+1 pairs since ffmpeg also opens an RTCP socket at port+1) where an ffmpeg process captures it to a streamable Ogg/Opus file with `-c:a copy` (no re-encode). The download endpoint (`/api/recordings/:id/download`) spawns a **second** ffmpeg that `amix`es all captures (with `adelay` to align late joiners, `normalize=0`) and streams to HTTP `pipe:1` — captures keep running, never interrupted. Recordings are keyed by a `recordingId` capability token, not room name. `RecordingManager` takes injected `RecordingDeps` so the logic is unit-testable without real ffmpeg/mediasoup.

### Live Icecast streaming (`server/src/streaming.ts` + `streaming-util.ts`)

`StreamManager` mirrors `RecordingManager` and is **independent of it** — both tap the SFU with their own consumers, so a room can record, stream, both, or neither. It also forces SFU. Per producer it has its own `PlainTransport`+consumer → local UDP port (its own `PortAllocator`, range **51000–51998**, distinct from recording's). One **live mixer ffmpeg per room** reads every active producer's RTP (via SDP files), `amix`es them (`normalize=0`) and pushes to `icecast://user:pass@host:port/mount` (`-c:a libmp3lame`/`-f mp3` or `libopus`/`-f ogg`). A permanent silent stereo **anchor** (`anullsrc`) keeps the Icecast source alive (streaming silence) when there are zero active producers. The Icecast target is supplied by whoever starts streaming (in-call **Streaming** settings panel, persisted in `localStorage`), validated by `icecastConfigSchema`, sent on `start-streaming`, and **never broadcast** — only `streaming-started { by }` / `streaming-stopped` / `streaming-failed` go to the room (state is room-wide, like recording: a `LIVE` badge + `announceEvent`).

Key constraint: a **paused** producer (peer muted) sends no RTP and would stall `amix`, so the mixer is **rebuilt** (debounced, `rebuildDebounceMs`) whenever the _active_ producer set changes — join/leave/share/mute/unmute (`addProducer`/`removeProducer`/`setProducerActive`, wired in `signaling.ts`). Each rebuild kills+respawns the mixer, i.e. a brief Icecast source reconnect; configure an Icecast `<fallback-mount>` for seamless listening. `StreamManager` takes injected `StreamDeps` (reuses recording's structural mediasoup/process interfaces) so it's unit-testable without real ffmpeg/mediasoup.

### In-call audio sources & URL proxy (`server/src/audio-sources.ts`)

The in-call "Stream audio" chooser (`AudioSourceDialog.tsx`) plays into the **same per-stream `<audio>` → file producer** as the local-file path (`startFileSource` in `useMediasoup.ts`), from three sources: a local file (object URL), a **server-side library** file, or a **public URL**.

- **Library**: a browsable **folder tree** under `AUDIO_LIBRARY_DIR` (default `/var/lib/jdh-speak/media`). `GET /api/audio-library?path=<subfolder>` lists (`{ path, entries:[{name,dir}] }` — folders first then audio files, dotfiles/symlinks dropped); `GET /api/audio-library/file?path=<relpath>` serves one file. `resolveLibraryPath` is the traversal guard (neutralizes leading slashes/backslashes, collapses `..`, rejects anything escaping the root incl. sibling-prefix), `isAudioFileName` gates the served basename, and `sendFile` is rooted with `dotfiles: deny`. The picker (`AudioSourceDialog`) is a file browser: click a folder to descend, a back button / **Backspace** goes up, names truncate via CSS while the full name stays in each button's `aria-label`.
- **URL proxy**: `GET /api/audio-proxy?url=…` is a same-origin proxy so Web Audio can consume sources lacking CORS headers. It first tries a **direct** pass-through (preserving `Range`/seek for plain audio + Icecast radio), and if the body isn't browser-playable, **transcodes** via the fallback resolvers — ffmpeg for direct media streams (IPTV `.ts`/HLS/DASH/raw, picked by extension _or_ content-type) and yt-dlp for sites (YouTube/SoundCloud/…), each backing the other.
- **SSRF guard** (`resolvePublicAudioUrl`): http(s) only, no credentials, ≤4 KB; rejects any address resolving to private/loopback/link-local/CGNAT/metadata (IPv4 + IPv6 incl. `::ffff:` mapped); the direct fetch **pins DNS** to the validated address (rebinding-proof) and **re-validates every redirect**. Caveat: the **transcode fallback can't be DNS-pinned** — ffmpeg/yt-dlp resolve the host themselves, so a rebind between the Node check and their connect is a residual gap (ffmpeg's `-protocol_whitelist` still blocks `file:`). The three endpoints are **unauthenticated** like the rest of `/api`; the transcode path (which spawns processes) is bounded by a **concurrency cap** — `MAX_CONCURRENT_TRANSCODES` (env `AUDIO_TRANSCODE_LIMIT`, default 32; a slot is held for the whole playback, and only transcoded URLs count — plain audio/radio/library/local don't); over the cap returns **503**. If this is internet-facing, gate/rate-limit it further.

`audio-sources.ts` is split into pure helpers (guards + argv builders) and the process-spawning resolvers, which take an **injected `spawn`** so the first-byte gating, teardown, timeout, routing/backup, and concurrency cap are unit-tested with a fake child process (no real ffmpeg/yt-dlp) — same seam as `RecordingManager`/`StreamManager`.

### Live TV channels (TV en vivo)

An in-call **"TV en vivo"** button (`AudioControls.tsx`, `Tv` icon) opens `TvDialog.tsx`, which fetches an operator-managed channel list and plays a channel **into the room** — same path as a file/URL source (mixed into `fileVolumeGain → outDest`, the single voice producer, so it re-broadcasts to everyone and needs no SFU pin of its own).

- **Channel list is server-managed.** `GET /api/tv-channels` (`server/src/index.ts`) reads **`tv/db.json`** at the repo root and returns the parsed channels (mtime-cached; `[]` on any error). `server/src/tv-channels.ts` (`parseTvChannels`) validates the raw JSON and drops malformed entries. Each channel is `{ nombre, categoria, url, key }` where `url` is a DASH manifest (`.mpd`) and `key` is a ClearKey `"kid:key"`. The dialog groups by `categoria` (headings) with a button per channel; picking one keeps the dialog open (close with X/Escape) so the user can keep operating the app.
- **Playback is 100% client-side** — no server binaries. **Shaka Player** (`shaka-player`, **lazy-loaded** so it code-splits into its own async chunk — see `vite.config.ts` manualChunks) does DASH + **ClearKey** decryption (EME) in the browser. `parseClearKey` (`client/src/lib/tv.ts`) turns `"kid:key"` into Shaka's `{ [kid]: key }`. `startTvChannel` (`useMediasoup.ts`) tears down any active file/URL/TV source, builds a detached `<audio>` + one-shot `createMediaElementSource`, then `player.load(url)`.
- **Audio-only, verified.** `player.configure({ restrictions: { maxHeight: 0 } })` makes Shaka pick the audio-only variant and **never download the video track** — measured in-browser: a single representation of `audio/mp4` (`.m4a`, ~49 KB/segment), zero video segments, ~150–200 kbps. This is the whole point: cheap for the Pi and for the room fan-out. **Do not remove `maxHeight: 0`** — it silently reintroduces multi-Mbps video downloads.
- **Failures are surfaced** (blind-user critical): `startTvChannel` try/catches configure/load/play, cleans up (`unload`, disconnect, pause), announces via `m.tv_play_error()` / `m.tv_unsupported()`, and `TvDialog` shows an inline alert.

### Serieteca (series de audio)

An in-call **"Serieteca"** button (`AudioControls.tsx`) opens `SerietecaDialog.tsx` — a search box, "Continuar escuchando" / "Últimas agregadas" sections, and the rest of the catalog grouped by `país`. Picking a series plays it **into the room** and leaves the dialog open (same "keep operating the app" pattern as `TvDialog`).

- **One continuous `.m4b` per series, not one file per episode.** The catalog (`client/src/lib/serieteca.ts`) is fetched directly from `https://archive.org/download/m4bua/series.json` (it has CORS, so no proxy needed for the JSON itself). Each series (`Serie`) has `temporadas`, each `Temporada` has `capitulos` — a chapter/episode is a **millisecond time-range** (`inicio`/`fin`) into the single `.m4b`, and offsets are **continuous across seasons**. The episode list is all seasons' `capitulos` **flattened and sorted by `inicio`**; playing episode _i_ means **seeking the same `<audio>` element to `inicio/1000`**, never swapping `src`.
- **Room broadcast reuses the file/TV audio graph**: a dedicated `<audio>` → `createMediaElementSource` → `fileVolumeGain → outDest`, the single voice producer — no SFU pin of its own. `startSerie` and episode navigation (next/prev/restart/seek) live in `useMediasoup.ts`, alongside `startFileSource`/`startTvChannel`.
- **CORS on the `.m4b` itself**: unlike the catalog JSON, archive.org's `.m4b` download has no CORS header, so its `src` goes through the same-origin `GET /api/audio-proxy?url=…`. archive.org also serves `.m4b` as generic `application/octet-stream`, which the proxy's audio-type check used to reject and send down the **transcode** path — fatal here, since transcoding breaks the byte-Range seeking episode playback depends on. `browserPlayableAudioType` (`server/src/audio-sources.ts`) now recognizes known playable extensions (`.m4b`, `.m4a`, `.mp3`, …) when the upstream content-type is generic binary, and serves them via the **direct, Range-preserving** path instead.
- **Full accessible player**: season and episode `<select>`s (season selector hidden for single-season series), next/prev/restart-episode buttons in the footer, keyboard shortcuts **Alt+K/J/L/S/A/R/I** (play/pause, seek ±15s, next/prev episode, restart, announce series+episode), all gated on an active series so they never shadow the file/TV/URL shortcuts. Each episode change fires its own `announce()`.
- **Progress ("continuar escuchando") is per-browser `localStorage`** (`jdh-speak:serieteca:progress`) — no accounts, no server-side state.
- **No new server binaries**: playback is a plain `<audio>` element, no Shaka/DRM (unlike Live TV channels above) — the only server-side change was teaching the existing audio proxy to pass `.m4b` through directly.
- **Dropped from the reference app (YAGNI):** user accounts, server-side progress/stats, TV device-linking.

### Screen-reader announcements (rule: announcements go to chat)

Every room-**event** announcement (recording start/stop, audio-share start/stop, music caster start/stop, mute/unmute, …) must go through the store's `announceEvent()`, which speaks it on the ARIA live region in `Room.tsx` **and** appends it to the chat history as a `kind: "system"` entry — chat is the single timeline of everything announced, readable later via the panel or the Alt+1..0 readback. Peer join/leave keeps its dedicated `kind: "join"/"leave"` entries (localized at render time; `system` entries snapshot the locale active at event time). Bare `announce()` is reserved for re-reading chat content that is already in history: the incoming `chat-message` announcement (which appends a one-time Alt+number hint on the session's first message) and the Alt+number readback itself.

### Public rooms & moderation (knock-to-join, vote-to-kick)

A room is **private by default** and **sticky-public** once any joiner sets it (`isPublic`, via the lobby's "Make this room public" toggle / `?public=true`). Public rooms are listed in the lobby (`getPublicRooms`) and ping the operator's off-box notify daemon on activity (`notify.ts`, target hidden in `.env`). There are **no moderators** — admission and removal are collective:

- **Knock-to-join.** A newcomer to an already-public, occupied room is held in `room.pendingJoins` (keyed by socket id) and gets `{status:"pending"}`; participants see a modal (`JoinRequests.tsx`) + looping knock cue and `join-decision {requestId, allow}`. Allow records an `admittedToken`/`admittedName` (so a reconnect/return skips the gate) and pushes `join-approved`; **deny IP-bans them from this room** (`bannedIps`, checked first on every join) and pushes `join-denied`. Casters and already-admitted sessions skip the gate. The flip private→public broadcasts `room-public` so people already inside update.
- **Vote-to-kick.** Only in public rooms, and only with **3+ votable peers** (humans — non-casters; the target is counted). **`kickThreshold(n)` in `server/src/kick-util.ts` is the single, pure source of truth** (unit-tested): `Infinity` for n<3 (disabled — same as a private room, so no one can be removed unilaterally), else `ceil(n/2)` ("at least half": 3→2, 4→2, 5→3). Votes live in `room.kickVotes` (target peerId → set of voter ids). `vote-kick {targetId, vote}` toggles and broadcasts `kick-vote` to the whole room (incl. the voter — server is authoritative, the client never updates optimistically); `settleKicks` then removes anyone at threshold. **Re-evaluated on every vote AND every membership change** — a leaver shrinks the room and can tip an already-half-voted target over the line. A kick reuses the deny path: room-ban the IP (`bannedIps`), `peer-kicked` to the room + `you-were-kicked` to the target, then `teardownPeer` + force-disconnect (a server-initiated disconnect doesn't auto-reconnect; the client shows a "removed" screen via the `kicked` store flag). `teardownPeer` is the **shared leave/kick path** (the disconnect handler routes through it too); `cleanupKickVotes` drops a departed peer's votes and recounts. Anti-spam: a dedicated `RateLimiter` where **only real toggles cost a slot** (redundant re-vote / empty withdraw is a silent no-op).
- **Client/UI.** Gated on `roomIsPublic && votableCount >= 3` (seeded from the join response + the `room-public` event). The per-peer button (`ParticipantCard.tsx`) uses **`aria-pressed`** for _your_ vote and carries the running tally in its accessible name ("Kick {name} (2 votes)"); the card uses **`aria-selected`** when a peer has any votes against them. Per-vote announcements ("X voted to kick Y" / "…withdrew…") are **bare `announce()`** (transient, like mute); the kick itself goes through **`announceEvent()`** (logged to chat, like recording).

### Client routing

Two routes (`client/src/main.tsx`): `/` → `Lobby`, `/room/:roomName` → `Room`. Room URL params: `?p2p=off` (also false/0/no/disable/disabled) pins SFU; `?public=true` (also 1/yes/on/enable/enabled/public) lists the room publicly; `?displayName=…` deep-links past the lobby name prompt; `?lang=` overrides the UI language (see i18n below). State lives in a single zustand store (`client/src/stores/room.ts`); mic gain persists to localStorage. The room name is reflected into `document.title` from the `Room` component.

### Localization / i18n (Paraglide JS)

UI strings live in `client/messages/{en,es,fr}.json` (flat key→string, `{var}` interpolation). The **inlang Vite plugin** (`paraglideVitePlugin` in `vite.config.ts`) compiles them into tree-shakeable, type-safe functions under `client/src/paraglide/` — **generated, gitignored, never hand-edit** (regenerated on every `pnpm dev`/`pnpm build`; or `pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide`). `tsconfig` has `allowJs` on so `tsc` reads the JSDoc-typed output. Import message functions from `../paraglide/messages.js` (`m.some_key(...)` or named exports) and call them at render/event time — they read the active locale, so they work in non-React code too.

- **Locale resolution** (`strategy` in `vite.config.ts`, first hit wins): `localStorage` (the picker's choice) → `preferredLanguage` (browser) → `baseLocale` (`en`). On top of that, a **`?lang=` override** is applied imperatively in `client/src/lib/i18n.ts` _before_ anything reads the locale (so the store/`main.tsx` import `i18n` to force that ordering), then persisted.
- **Switch without reload**: the locale is mirrored in the store (`locale` + `setLanguage`, which calls Paraglide's `setLocale(…, { reload: false })`). `<App>` in `main.tsx` subscribes to `locale` so a change re-renders the whole tree **in place** — every `m.*()` re-evaluates, but nothing remounts, so an active call survives a mid-session language switch. `setLanguage` also updates `<html lang>`.
- Non-component strings are localized via the same functions: SR announcements in `useMediasoup.ts`, and `client/src/lib/chat.ts` (`formatMessage` stays the single source for both the visible message and its ARIA announcement; `relativeTime` builds a per-locale `Intl.RelativeTimeFormat`).
- **Add a language**: add the code to `locales` in `client/project.inlang/settings.json`, add `messages/<code>.json` (keys at parity with `en.json`), and add its native name to `LOCALE_NAMES` in `client/src/lib/i18n.ts`. The picker (`LanguageSelect`) and detection pick it up automatically.

## Deployment / runtime

- Runs under systemd as **`jdh-speak.service`** (`ExecStart=/usr/bin/pnpm start`, `WorkingDirectory=/home/jdh-speak`). Env: `PORT` (3100), `ANNOUNCED_IP` / `ANNOUNCED_IP6` (the VPS public IPs — required for ICE), `NODE_ENV=production`, optional `INSTANCE_NAME` (rebrands the app title — injected into the served `index.html` at runtime, read client-side via `getInstanceName()` in `client/src/lib/branding.ts`, so no rebuild). Restart with `systemctl restart jdh-speak`.
- **Client changes need only `pnpm build`** — `express.static(client/dist)` serves the new bundle on the next page load, so no server restart and no dropped calls. **Restart the service only for server-code changes** (server runs TS live via tsx).
- Ports: WebRTC media UDP **40000–40100**; recording RTP **50000–50998**; Icecast-streaming RTP **51000–51998**. (The recording/streaming RTP ranges are loopback-only — mediasoup→ffmpeg on 127.0.0.1 — so no firewall change; only the outbound Icecast connection leaves the box.) ICE is **UDP-only** by design; TCP/TLS fallback is handled by an external coturn (`turn.oriolgomez.com`). TURN credentials are in client code intentionally (WebRTC requires them browser-side).
- **Outbound egress**: besides the Icecast push, the `/api/audio-proxy` URL streamer makes the server fetch arbitrary **public** http(s) hosts (and run yt-dlp, which hits site CDNs) — the SSRF guard blocks private targets but egress to the public internet is the feature. Keep `ffmpeg`/`yt-dlp` installed and yt-dlp current (see top of this file). Optional env: `AUDIO_LIBRARY_DIR`, `FFMPEG_PATH`, `YTDLP_PATH`, `AUDIO_TRANSCODE_LIMIT`.
- **TV en vivo (for the operator/Cristian).** The "TV en vivo" feature needs **no new binaries** on the Pi — Shaka runs in each viewer's browser (server just serves the list). It reads **`tv/db.json` at the repo root** (`/home/jdh-speak/tv/db.json`); that file is **gitignored** (it holds DRM ClearKeys) so it doesn't travel with `git pull` — **create/update it on the Pi by hand** (see [`tv/README.md`](tv/README.md) for the schema: an array of `{ nombre, categoria, url, key }`). No file → the button just shows an empty list, nothing breaks. It's picked up live (mtime-cached), so **no service restart** to change channels — edit `tv/db.json` and the next dialog open sees it. Playback is **audio-only** (~150–200 kbps per viewer, verified), so bandwidth is comparable to a music share, not video.
