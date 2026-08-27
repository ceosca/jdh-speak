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

- ≤5 peers → **P2P mesh**: clients connect WebRTC directly; the server only relays signaling (`p2p-signal`). Media never touches the server.
- 6+ peers → **mediasoup SFU**.
- `forceSfu` pins the SFU even with ≤5 peers when the server _must_ see/route the media: while **recording** (P2P media is invisible to the server), when a **music caster** is present, when **`?p2p=off`** was set, or when someone toggled **force-SFU** (`Ctrl+Alt+S`) — a live, room-wide toggle useful on a bad connection (on the SFU each client uploads once instead of a full mesh). All via `shouldForceSfu` in `signaling.ts`.

On transitions the server emits `switch-to-sfu` / `switch-to-p2p`; the client (`useMediasoup.ts`) tears down one transport stack and builds the other. The outgoing audio graph (below) survives the switch — only senders/producers are rebuilt.

### Client audio graph (`client/src/hooks/useMediasoup.ts`)

One module-scoped shared `AudioContext` for the whole session (resumed on first user gesture for iOS).

- **Outgoing**: `mic → micGain → soft limiter → outDest`. The track added to peers / produced to the SFU is **always `outDest`'s stream track**, so tracks are never swapped on senders/producer across mode switches or when sharing audio. Shared system/tab audio (`getDisplayMedia`) is mixed **straight into `outDest`**, bypassing the mic gain/limiter so music keeps its dynamics.
- **Incoming**: per-peer `MediaStreamSource → gainNode → destination`. `effectiveGain(peerId)` composes per-peer volume × deafen × music ducking; every place that changes gain ramps via `setTargetAtTime`.

### Auto-ducking (controlled client-side)

The server's `AudioLevelObserver` watches **voice producers only** — music/caster producers are deliberately never added to it. It emits `duck {active}` on each on/off transition (`wireDucking` in `signaling.ts`). The **client** does the actual gain ramp: music-peer gain → `volume * DUCK_FACTOR` with `DUCK_ATTACK` (voice starts) / `DUCK_RELEASE` (voice stops) time-constants. Ecobox/the caster just sends raw stereo; ducking timing lives in the client constants, not the caster.

### Music caster (Ecobox)

A send-only "music caster" peer joins with `role: "caster"` (see `joinSchema`). It produces a stereo track but never consumes or sets up P2P, so its presence forces the room onto the SFU. Voice defaults to **mono ~64 kbps** for everyone; it's a **per-user opt-in** to send **stereo ~128 kbps** ("Hi-fi voice" toggle in `DeviceSettings`, persisted as `jdh-speak:hifiVoice`, default off — `hifiVoiceEnabled` in the store). The flag is read at **call start** — `forceOpusParams(sdp, hifi)` in `client/src/lib/sdp-munger.ts` sets `stereo`/`maxaveragebitrate` on the P2P fmtp, and the SFU `produce` sets `opusStereo`/`opusMaxAverageBitrate`; `microphoneConstraints` captures 1 vs 2 channels to match. It applies on the **next** call (the live producer's codec can't be re-negotiated mid-call). Why opt-in: most mics are mono (so stereo adds nothing audible) and 128k voice costs **every listener** bandwidth in the SFU fan-out. The router's `maxaveragebitrate: 256000` (`mediasoup-config.ts`) is a **ceiling** above even hi-fi voice — it lets the dedicated stereo caster/share/file producers negotiate full hi-fi — **do not lower it to 64000**, that silently clamps music to voice quality.

### Jam mode / "Modo ensayo" (low-latency ensemble) — branch `feat/webtransport-jam`

> **For Edu's Claude (and future me):** this whole feature lives on the branch
> **`feat/webtransport-jam`**, NOT on `main`. **The Pi's live deployment currently
> runs this branch** (`git -C /home/pi/jdh-speak branch` to confirm). It's still in
> testing with real users. Cristian drives the listening tests; when he's away, keep
> the invariants below — the risky part (the NetEQ bypass) already caused one outage.
> **⚠️ On THIS Pi the systemd unit is `sonicroom.service`, NOT `jdh-speak.service`**
> (never renamed here — the migration note at the top is wrong for this box). Deploy
> a client-only change with `git pull && pnpm --filter client build` (no restart);
> restart with `sudo systemctl restart sonicroom` only for server-code changes.

**Goal:** let musicians play together in the browser, squeezing latency toward
Jamulus/SonoBus territory. Two pillars: a **network monitor** (hear your own signal
returned via the server as a timing reference, à la Jamulus) and an **all-out
latency stack**. Two DeviceSettings checkboxes: **"Modo ensayo"** (`jamMode`) and
**"Monitoreo de red"** (`networkMonitor`).

**⚠️⚠️ WHY JAM RUNS ON THE SFU, NOT P2P — this is the whole logic, do NOT "optimise"
it away.** It is tempting to think "P2P is lower latency, so jam should use P2P."
**That is wrong and it breaks the Jamulus model.** The reason is not speed, it's
that an ensemble needs **one universal, shared timing reference** — a single hub
everyone relates to. Only the SFU gives that:
- **SFU (correct for jam):** every stream goes through the server, so there is **one
  common hub**. Your **network monitor** is your own signal returned *via that hub*.
  Everyone relates to the same point, at a symmetric server-relayed delay, so there
  is a single clock to play against — you anticipate your own server-return and
  everyone's parts line up **at the hub, the same way for everyone**. This is exactly
  the Jamulus principle (play ahead so your part lands aligned in the common mix).
- **P2P mesh (wrong for jam, even though it's faster point-to-point):** there is **no
  common hub**. Each pair has its own latency: A hears B at `lat(A↔B)`, C at
  `lat(A↔C)`; B hears A at `lat(A↔B)` but C at `lat(B↔C)`. So **the "mix" every
  person hears is different and skewed** — there is no universal reference to
  synchronise to, and no way to know how far ahead to play for *everyone* at once.
  Worse, **the network monitor literally cannot exist in P2P** — no server returns
  your own signal, so the timing reference you play against isn't there. Lower
  per-link latency is useless if the ensemble can't share a clock.

So: **jam ⇒ SFU is a correctness requirement, not a performance choice.** `jamMode`
and `networkMonitor` both pin the room to the SFU on purpose. Never route jam over
P2P "for speed" — you'd trade a working ensemble for a faster but unsynchronisable
one. (The bypass work below shaves latency *within* the SFU path; that's the right
place to optimise, not the transport topology.)

**Room-wide (all-or-nobody).** `jamMode` is a **room-wide** toggle now, mirroring the
force-SFU pattern exactly: the checkbox calls `onJamToggle` (registered in the store
by `useMediasoup`) → emits `set-jam-mode {enabled}` → server sets `room.jamMode`,
broadcasts `jam-mode {enabled, by}` to the others, and re-evaluates the mode. It's
all-or-nobody **on purpose** — the receive-side NetEQ bypass can only safely tap
every consumer if the whole room is jam (a mixed room would leave non-jam peers out).
`room.jamMode` is in `shouldForceSfu` (jam pins the SFU) and in the join response
(late joiners adopt it). **Symmetry matters:** unchecking jam re-evaluates → returns
to P2P if ≤5 peers and nothing else forces SFU. Network monitor also auto-forces SFU
and now **releases its own pin** on disable (`netMonitorForcedSfuRef`) — it must
never undo a manual Ctrl+Alt+S or jam's pin.

**The latency stack (all jam-gated).** Send side (`useMediasoup` + `sdp-munger.ts`):
`getUserMedia({ latency:0 })` (minimal capture buffer) · Opus `ptime=10` (halves the
20 ms packetisation; SFU produce uses `opusPtime:10`, P2P via the munger) · **FEC
off** (`opusFec:false`/`useinbandfec=0` — FEC holds a packet back) · DTX off ·
`networkPriority:"high"` (DSCP) · **raw-mic send bypass** (`applyJamSendPath` sends
the raw mic track via `replaceTrack`, skipping the outgoing Web Audio limiter's
lookahead). Receive side: `jitterBufferTarget=0` + `playoutDelayHint=0`, **and** the
NetEQ bypass below.

**The NetEQ bypass — the big win, and the dangerous part.** Measured live: WebRTC's
NetEQ jitter buffer **won't drop below ~20-30 ms even with `jitterBufferTarget=0`**
on a 1 ms-jitter loopback — that floor, not the transport, is the dominant latency.
So we bypass NetEQ while keeping mediasoup: `client/src/lib/jam-neteq-bypass.ts` taps
the receiver's encoded Opus frames via **`RTCRtpScriptTransform` +
`createEncodedStreams`** (which sit BEFORE the jitter buffer), decodes with
**WebCodecs `AudioDecoder`**, and plays through our own **minimal ring AudioWorklet**
(~10-12 ms). Half NetEQ's latency, on the existing SFU — no WebTransport, no new
ports.
- **⚠️ THE SAFETY INVARIANT (an outage taught us this):** enabling
  `encodedInsertableStreams` on the recv PC makes Chrome route **every** incoming
  frame through the tap — **any consumer you don't tap+pipe goes SILENT**, not to
  NetEQ. So: the flag is set **only in a jam room, only on Chrome/Edge**
  (`recvInsertableRef`, `SUPPORTS_INSERTABLE_STREAMS`), and when it's on, **`tapConsumer`
  taps EVERY consumer** — voice → `bypass` (decode+ring), the music caster / anything
  else → **passthrough** (`bypass:false`, pipe frames straight to NetEQ so it plays
  untouched but is never silent). Normal (non-jam) calls **never set the flag** → the
  path is byte-for-byte the old NetEQ one, zero risk. Safari/Firefox lack
  `createEncodedStreams` → they fall back to plain NetEQ automatically.
- **Never re-enable `encodedInsertableStreams` PC-wide/unconditionally** — that's
  exactly what silenced non-jam users (commit history: "URGENT — remove
  encodedInsertableStreams"). Keep it jam-gated + tap-everyone.
- Known edge: enabling jam while a room is **already** SFU (6+ peers) doesn't rebuild
  the recv transport, so the bypass engages on the next SFU (re)build. Audio is always
  correct either way (flag off → plain NetEQ).

**Key files:** `client/src/lib/jam-neteq-bypass.ts` (bypass+passthrough, inline
Worker+AudioWorklet via Blob URLs, fully fail-safe — any setup failure returns null
and leaves NetEQ playing); `client/src/hooks/useMediasoup.ts`
(`applyJamSendPath`/`applyJamSenderPriority`/`applyNetworkMonitor`/`tapConsumer`/
`setReceiverJitterTarget`, the `jam-mode` socket handler, `onJamToggle` registration);
`server/src/signaling.ts` (`set-jam-mode` handler, `shouldForceSfu`, join response);
`server/src/room-manager.ts` (`Room.jamMode`); `client/src/lib/sdp-munger.ts`
(`forceOpusParams(sdp, kbps, jam)`).

**Status:** send stack + room-wide jam + jitterBufferTarget=0 shipped and safe. The
NetEQ bypass is re-enabled and mechanism-verified (engages on all consumers, no
errors; bypass ~12 ms and passthrough validated in isolation) but the **final
audio-quality/latency confirmation is a human listening test** Cristian still owes.
If jam audio glitches/doubles/goes silent for someone, unchecking "Modo ensayo"
restores normal audio instantly (it's opt-in and fail-safe).

**✅ Master output bus → media-element sink (EAR-VALIDATED).** Measured with
`AudioContext.playbackStats` (the accurate API, not the `outputLatency` estimate):
the AudioContext output is a real ~42 ms on Windows with USB devices — which can't
use WASAPI's IAudioClient3 low-latency path. Chrome's MEDIA output path is ~23 ms.
So all peer pipelines now feed one `masterBus` (`useMediasoup.ts`) which, in jam,
routes the whole mix through a `MediaStreamAudioDestinationNode → <audio>` (media
output ~23 ms) instead of `AudioContext.destination` (~42 ms) — the browser's
accessible slice of the WASAPI bottleneck, **~19 ms lower for hearing everyone**.
`routeMasterOutput(jam, speakerDeviceId)` on a jamMode/speaker effect. **Confirmed
live with Cristian+Edu+Franco: with jam on, everyone still hears everyone** (no
silence) — the master-bus media path works for the full mesh, not just the monitor.
Normal (non-jam) calls: `masterBus → destination`, a unity-gain passthrough, the old
path byte-for-byte. Safari/Firefox (no per-element sink) stay on destination.
**Device tip that's real, not code:** a NON-USB output (a laptop's built-in
audio/jack, e.g. Edu's/Franco's) can reach IAudioClient3 → ~22 ms lower still; USB
interfaces (Cristian's Maonocaster/Focusrite) are locked out of it.

**Also on this branch (throwaway):** `experiments/webtransport-jam/` — a Level-1
feasibility probe of **WebTransport + WebCodecs** (own buffer over QUIC, bypassing
NetEQ via a different transport). It measured ~15 ms vs NetEQ's ~30 ms. **The
receive-side bypass above supersedes it** (same win, on the existing stack), so the
WebTransport rewrite is parked. The probe embedded a QUIC echo relay in the main
server on udp/40059 behind `WT_PROBE`; if `server/src/webtransport-probe.ts` still
exists it's inert unless `WT_PROBE` is set and needs `@fails-components/webtransport`
pinned to **1.4.0** (newer arm64 prebuilds need glibc 2.38; the Pi has 2.36).

**More recent details (so nobody re-derives them):**
- **Separate output card for the return.** The network monitor can play its return
  out its **own** sound card / headphones while the primary card keeps regular sound
  (e.g. primary = your local piano, secondary = the server-return so you hear how far
  behind you are). Store `netMonitorDeviceId` ("" = same as primary); `useMediasoup`'s
  `routeNetMonitorOutput()` sends the monitor's gain through a
  `MediaStreamAudioDestinationNode → <audio>.setSinkId(deviceId)`; picker in
  `DeviceSettings` under the monitor checkbox (Chrome/Edge — `canSelectElementSink`).
- **ptime is 10 ms, and that was MEASURED, not assumed.** Pushing Opus to `ptime=5`
  to lower the receive floor was tried in a loopback: Chrome doesn't honour it
  cleanly (mixes 5/10 ms frames, ~8.5 ms avg), so the receive floor — which must
  cover the LARGEST frame — stays ~10 ms while packet rate rises. Not worth it. Don't
  re-try it expecting a win.
- **The bypass ring floor auto-couples to the frame size.** A cushion can't be smaller
  than one Opus frame (PCM arrives one frame at a time), so the ring's floor tracks
  the actual decoded frame size (decaying max) instead of a fixed value — robust to
  whatever frame size a stream uses.
- **Jitter buffer + SMOOTH drift compensation via RESAMPLING (`AdaptiveJitterBuffer` in
  `jam-wt-mesh.ts`) — the current design.** History: fixed 45 ms cap → auto "adaptive
  minimum" (eroded the cushion under jitter) → manual min/max sliders → **single cushion
  slider + resampling drift compensation** (current). The buffer is now ONLY for jitter;
  clock drift (why the delay used to grow over hours) is cancelled the SonoBus/AOO way —
  a DLL-lite + resampler — NOT by dropping frames.
  - **One user slider** = the jitter cushion (`jamBufferMinMs`, 0–100 ms). Lower = less
    latency; raise if it crackles. `jamBufferMaxMs` still exists in the store but is
    **ignored by the buffer** (no user-facing max anymore).
  - **`StreamResampler`** (linear interp, fractional cursor carried across frames) plays
    the stream at a variable speed `s`. A slow controller (buffer level smoothed τ=2 s)
    nudges `s` by a fraction of a percent (correction τ=4 s, clamp ±2 %) so the buffer
    sits at the cushion forever — drift in either direction is absorbed continuously,
    **no clicks, no growth**. Prebuffers to the cushion; re-prebuffers on a true
    underrun; a `cushion+250 ms` drop ceiling is catastrophe-only (never hit normally).
  - Per-peer gain moved INTO the buffer: `push(ad, gain, write)` (applied while copying
    the PCM, before the resampler). Buffer built with channels: `new
    AdaptiveJitterBuffer(nominalMs, channels, bounds)`. Output is fresh f32-planar
    `AudioData` written to the generator (variable length — verified Chrome accepts it).
  - All three playout paths (WT mesh, WT monitor, NetEQ-bypass generator) use it. Bounds
    are a **live shared object** (`jamBoundsRef` in `useMediasoup`) the slider mutates in
    place → no rebuild. Live stat `window.__jamMeshStats = {bufferedMs, targetMs,
    jitterMs, drops, ppm}` (ppm = the drift the resampler is cancelling).
  - Sim (`node`): resampler transparent at s=1, ±1 % shifts pitch ±1 % with no added
    clicks; control loop over 10 min at ±300/±1000 ppm drift → buffer **flat, creep
    0.00 ms**, 0 drops, 0 underruns. **Don't go back to dropping at a max ceiling** for
    drift — resampling is smoother and is the whole point of this revision.
  - **A11y (NVDA):** the live ms readout must NOT be `aria-live` (it updates ~1/s and
    flooded NVDA, blocking navigation to the slider). Keep it a plain readable snapshot;
    slider carries `aria-valuetext`/`aria-describedby`; controls wrapped in a labelled
    group.

**📏 MEASURED latency budget (so nobody chases the wrong ms).** On Cristian's
Windows box, live-measured the whole round-trip and found the dominant cost is
**hidden in the browser's audio I/O buffers, NOT in our stack**:
- **Output latency ≈ 42 ms** (`AudioContext.outputLatency`, measured with audio
  actually playing — it reads 0 until then). This is the single biggest number, and
  it does **not** move with `latencyHint` (`"interactive"`, numeric `0`, `0.001`,
  `"balanced"` all give 42 ms) or with `setSinkId` to a different card (all ~42 ms;
  the Focusrite was *worse* at 54 ms — Chrome uses **WASAPI shared mode, not ASIO**).
- **Capture ≈ 10 ms** (`getUserMedia` `track.getSettings().latency` with
  `latency:{ideal:0}`), and `baseLatency` ≈ 10 ms — both already near their floor.
- **WebRTC's native `<audio>` playout** (`media-playout` stat `totalPlayoutDelay`) is
  ~42 ms total = NetEQ jitter ~19 ms + device output **~23 ms** — i.e. WebRTC's
  output path is ~19 ms LOWER than AudioContext's on this box. So routing everything
  through AudioContext (for gain/spatial) *costs* ~19 ms vs a plain element. Possible
  browser win, IMPLEMENTED for the monitor: `setupGeneratorMonitor` (jam-neteq-bypass)
  decodes the tapped frames with WebCodecs and writes them to a
  **`MediaStreamTrackGenerator` → `<audio>`** (WebRTC's ~23 ms media output) instead
  of the AudioContext graph — combining our ~10 ms decode ring with the low WebRTC
  output ≈ **~33 ms vs ~52 ms** through the graph. Used in `applyNetworkMonitor` when
  jam + Chrome/Edge + a flagged recv (mutually exclusive with the graph+bypass path —
  `createEncodedStreams` is once-per-receiver). Integrates with the output-card
  picker (`gen.setDevice`). Fail-safe: returns null → graph path. **Mechanism
  verified in a loopback (generated track plays in real time); the actual latency win
  is a human listening test** (no output-latency API for a generated-track element).

**The point:** network 1 ms + ptime 10 ms + ring 10 ms are already tiny next to the
~42 ms output + ~10 ms capture = **~50 ms of browser I/O buffer that JS cannot
reduce** — it's the WASAPI-shared-mode floor. **The only thing that beats it is
native audio (ASIO), which takes output to ~3-5 ms — a ~37 ms win, far bigger than
every browser trick combined.** That is exactly what the Python GUI below is for; do
not keep grinding browser ms expecting a breakthrough — the breakthrough is leaving
the browser's audio I/O.

**🧪 Jamulus/SonoBus techniques reverse-engineered — what's adaptable to the browser.**
Studied their internals and tested the enabling primitives live:
- **Tiny Opus frames (2.5 ms) — ADAPTABLE, confirmed.** Jamulus uses 64/128-sample
  Opus frames (~1.3-2.7 ms) with a custom encoder; SonoBus uses 2.5 ms. We use 10 ms.
  **WebCodecs `AudioEncoder` DOES honour `frameDuration:2500`** (verified: 43 frames
  from 100 ms of audio, ~21 bytes each). Going 10 ms → 2.5 ms cuts ~7.5 ms of send
  packetisation AND lets the receive buffer floor drop to ~one frame (~2.5 ms) —
  together ~15 ms. **But WebRTC's own encoder is fixed at 10 ms**, so 2.5 ms frames
  need a parallel path: **WebCodecs encode → a datagram transport → WebCodecs decode →
  the MediaStreamTrackGenerator playout above.** The transport can be **mediasoup
  DataChannels** (SCTP DataProducer/DataConsumer — reuses the SFU, no new ports) or
  WebTransport. This is essentially the parked `experiments/webtransport-jam` pipeline
  redone with 2.5 ms frames + the generator output — a real, buildable "Jamulus in the
  browser" audio path. **BUILT for the network monitor** (`client/src/lib/jam-wt-monitor.ts`,
  wired in `applyNetworkMonitor` via `netMonitorWtRef`): mic → `MediaStreamTrackProcessor`
  → WebCodecs Opus `frameDuration:2500` → QUIC datagrams to the `WT_PROBE` echo relay
  (udp/40059) → decode → `MediaStreamTrackGenerator` → `<audio>`. Verified engaging in
  production (WebTransport `created`+`ready`, no errors, needs a live mic). Fail-safe:
  null → the mediasoup self-consume monitor. Extending 2.5 ms to hearing PEERS (not just
  the self-return) is BUILT: the relay grew a `/jam` path (`handleJamSession`) that
  routes each client's 2.5 ms frames to everyone else in the room (senderId prepended)
  + echoes to self; `client/src/lib/jam-wt-mesh.ts` sends the mic and plays each peer
  via its own decoder → generator → `<audio>`. `applyJamMesh` (`useMediasoup`) starts
  it on the jamMode effect and mutes `masterBus.gain=0` so the mediasoup peer mix
  doesn't double it (restored on stop/fail). Relay routing VERIFIED (A's frame reaches
  B with senderId===A) + client mesh VERIFIED engaging (WebTransport /jam created+ready,
  no errors); the full-band audio-by-ear test is the remaining confirmation. Jam-gated
  + fail-safe (null → mediasoup peers play). Needs the `WT_PROBE` relay up (it is).
- **`AudioContext renderSizeHint` (configurable render quantum) — NO help.** Tested
  `32`/`64`/`hardware`: `baseLatency` stays 10 ms. Don't chase it.
- **The immovable floor stays ~33 ms** = capture ~10 ms + output ~23 ms (WASAPI
  shared, best case with the generator path). Even a perfect browser-Jamulus lands
  ~40 ms; native (ASIO) reaches ~15-20 ms by beating that I/O floor. So the browser
  ceiling is ~40 ms, native is the only way under it — but ~40 ms IS playable, and it
  needs no ASIO (works for Edu/Franco).

**🔮 Future direction (Cristian + Edu's plan — keep the jam logic intact for it).**
The plan is a **Python GUI** companion for this platform: Python specifically so
**ASIO / native low-latency audio** (and other native extras) can be added later —
the thing the browser fundamentally can't do (see the "leaving the browser" note in
the status). The split would be: **the web app for chatting/among everything else,
and the GUI for the jam (instrument) path**; the *last* link is wiring the GUI into
this platform's signalling/SFU. **Critically, jam must keep working in BOTH forms —
web and GUI — at the same time**, because someone who isn't playing should be able
to **spectate** (over the web) the people who ARE playing (via the GUI). That's the
whole reason jam can't become GUI-only: web participants need to hear the jam too.
And it's another reason **jam stays on the SFU** — the SFU is the shared hub that a
native GUI client and web spectators would both connect to, exchanging the same
server-relayed streams. **When building toward this, do not "simplify" jam into a
P2P or GUI-only path — that would break both the Jamulus timing model (above) and
the web-spectator requirement.**

**✅ The native foundation now EXISTS: `native/jam_native.py`.** A headless Python jam
client that does audio OUTSIDE the browser and joins the SAME WT `/jam` room as the
browser mesh — the first concrete step of the GUI plan, and the answer to "break the
WASAPI floor." **Measured on Cristian's box** (PortAudio via pip, no ASIO SDK):
Chrome's WASAPI-shared output ~23 ms; native WASAPI **exclusive** on the USB Focusrite
is ~34 ms (NO win — the USB driver fixes the buffer, so WASAPI can't be beaten from
user space); native **WDM-KS (kernel streaming) = ~10 ms** (−13 ms, pip-achievable
today); native **ASIO ~3–5 ms** (needs a PortAudio/cpal build with the Steinberg SDK).
So the win is real and the client picks the lowest-latency host API the device exposes
(WDM-KS → WASAPI). It speaks the exact mesh wire format over aioquic WebTransport
(`CONNECT 200`, hello→id, `[0x01][idLen][appId][ch][seq][sendTime][opus]`, relay
fan-out; verified sent≈recv, relay RTT ~1–2.5 ms). **aioquic gotcha:** set
`max_datagram_frame_size` or you can send datagrams but never RECEIVE them. Opus 2.5 ms
via PyAV (1 packet/frame). **Browser interop:** the mesh's per-peer gain callback now
defaults an UNKNOWN `appId` (a native client not in socket signaling) to unity instead
of `effectiveGain`'s 0 — otherwise browser peers silence the native client (deafen
still wins). Remaining for the product: signalling (native client should appear in the
room with a name/volume), port the resampling jitter buffer into Python (v1 is a simple
prebuffer ring), ASIO, and stereo (the wire already carries the channel byte). See
[`native/README.md`](native/README.md).

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
