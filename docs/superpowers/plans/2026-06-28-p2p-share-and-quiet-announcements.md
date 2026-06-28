# Share/Emit stay P2P + Minimal Announcements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Compartir audio" and the file player ("Emitir") mix into the voice track instead of separate SFU producers (so they never force SFU), and silence all spoken announcements except recording and chat messages.

**Architecture:** Re-route the share path and the two-slot file engine's output into `outDest` (the single voice producer's destination, the same node the secondary device mixes into) and delete their separate `shareDest`/`fileDest` producers + server `start/stop-share` / `start/stop-file-stream` machinery. The server stops force-pinning SFU for sharers/file-streamers (caster + recording + `?p2p=off` still pin). Then remove all event announcements except recording and chat.

**Tech Stack:** TypeScript, React 19, zustand, Web Audio, mediasoup-client, socket.io.

## Global Constraints

- **pnpm via `corepack pnpm …`** (never npm). Spanish-only; new/changed strings in `client/messages/es.json`; `client/src/paraglide/**` generated — **regenerate before tsc** (`corepack pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide`); a stale dir causes false message-key tsc errors.
- The single voice producer's track is `outDest`'s. Share + file mix into `outDest` (no new producer) → must NOT force SFU. The **caster** (`source:"music"`, Ecobox) and **recording** and `?p2p=off` still force SFU.
- Auto-ducking no longer applies to share/file (they're inside voice); drop their duck gains and their duck-ramp. The caster keeps receiver-side ducking. Manual "volume for all" is the share/file level control.
- Keep the local monitor for the file (`source.connect(sharedAudioContext.destination)`) and the manual `fileVolumeGain`.
- Announcements: announce ONLY recording (start/stop/unavailable) and chat messages. Remove every other `announceEvent`/`announce` event call. Keep sound cues (`playCue`).
- Verification gates: `corepack pnpm --filter client exec tsc --noEmit`, `corepack pnpm --filter server exec tsc --noEmit`, `corepack pnpm lint`, `corepack pnpm --filter server test` (4 pre-existing Windows failures), `corepack pnpm --filter client build`. No client unit-test suite — manual checks + static gates.

---

### Task 1: Server — stop forcing SFU for sharers/file-streamers

**Files:** Modify `server/src/signaling.ts`, `server/src/room-manager.ts`

- [ ] **Step 1** — In `server/src/signaling.ts` `shouldForceSfu` (~line 138) remove the `room.sharers.size > 0` and `room.fileStreamers.size > 0` lines. Keep `casters`, `disableP2p`, and the recording check.
- [ ] **Step 2** — Delete the socket handlers `start-share`, `stop-share`, `start-file-stream`, `stop-file-stream` (~lines 530-600) entirely.
- [ ] **Step 3** — Remove the `sharing` and `fileStreaming` fields from `joinSchema` and their use in the `join` handler (`if (sharing) room.sharers.add(...)`, `if (fileStreaming) room.fileStreamers.add(...)`), and remove `room.sharers.delete`/`room.fileStreamers.delete` from `teardownPeer`.
- [ ] **Step 4** — In `server/src/room-manager.ts` remove the `sharers` and `fileStreamers` `Set<string>` fields from the `Room` interface and their init in `getOrCreateRoom`. (Keep `casters`.)
- [ ] **Step 5: Verify + commit** — `corepack pnpm --filter server exec tsc --noEmit` and `corepack pnpm --filter server test` (4 pre-existing fails only) PASS. Commit: `feat(p2p): stop forcing SFU for share and file streaming (server)`.

---

### Task 2: Client — share mixes into the voice track

**Files:** Modify `client/src/hooks/useMediasoup.ts`

**Interfaces:**
- Produces: sharing no longer creates a producer or emits `start-share`/`stop-share`; `displaySource` connects to `outDest`. `outGraphRef.shareDest`/`shareDuckGain` and `musicProducerRef` removed.

- [ ] **Step 1** — In `startAudioShare` (where `displaySource.connect(shareDuckGain); shareDuckGain.connect(shareDest)`), route `displaySource.connect(g.outDest)` directly. Remove `shareDest`/`shareDuckGain` creation. Remove the `emit("start-share")` and the `produceShare()` / `wasSfu` SFU-pin block — sharing is now purely local (it mixes into the already-sent voice track).
- [ ] **Step 2** — Remove `produceShare` (the whole `useCallback`), `musicProducerRef`, and the `shareDest`/`shareDuckGain` fields from the `outGraphRef` type + `ensureOutGraph` init. In `stopAudioShare`, remove the `emit("stop-share")` and the producer close; keep stopping the `displayStream` tracks + disconnecting `displaySource` + `setSharingAudio(false)`.
- [ ] **Step 3** — Remove `shareDuckGain` from the duck logic: in `applyDuck`/`rampEmitDuck`/`emitDuckTarget` drop any reference to `shareDuckGain` (share is no longer source-ducked).
- [ ] **Step 4: Verify + commit** — regenerate paraglide; client tsc + lint PASS. Commit: `feat(p2p): share audio mixes into the voice track (no SFU)`.

---

### Task 3: Client — file player mixes into the voice track

**Files:** Modify `client/src/hooks/useMediasoup.ts`

**Interfaces:**
- Produces: the two-slot file engine's shared chain ends at `outDest`: `slots → xfadeGain → fileVolumeGain → outDest`. `fileDest`/`fileDuckGain`/`fileProducerRef` removed; no `produceFile`/`start-file-stream`/`stop-file-stream`.

- [ ] **Step 1** — In `ensureFileSlots` (builds the shared chain), connect `fileVolumeGain.connect(g.outDest)` instead of `fileVolumeGain.connect(fileDuckGain)` → `fileDuckGain.connect(fileDest)`. Remove the `fileDuckGain` and `fileDest` nodes from the chain and the `outGraphRef` type + init. Keep `fileVolumeGain` (manual "volume for all"). Keep each slot's local monitor `source.connect(sharedAudioContext.destination)`.
- [ ] **Step 2** — In `startFileSource`/`startFolderStream`, remove the first-start SFU-pin block (`emit("start-file-stream")`, `wasSfu`, `produceFile()`). The file now just mixes into the voice track. Remove `produceFile` (the whole `useCallback`) and `fileProducerRef`. In `stopFileStream`, remove `emit("stop-file-stream")` and the producer close; keep tearing down the slots, revoking object URLs, the playlist, and resetting player state.
- [ ] **Step 3** — Remove `fileDuckGain` from the duck logic (`applyDuck`/`rampEmitDuck`/`emitDuckTarget`) — file is no longer source-ducked.
- [ ] **Step 4: Verify + commit** — regenerate paraglide; client tsc + lint + `corepack pnpm --filter client build` PASS; the player still loads/plays/crossfades/seeks (manual). Commit: `feat(p2p): file player mixes into the voice track (no SFU)`.

---

### Task 4: Client — mute keeps share/file/secondary alive

**Files:** Modify `client/src/hooks/useMediasoup.ts`

- [ ] **Step 1** — Replace the `secondaryActive` check in `mute`/`unmute` with a broader test: muting keeps the producer running (only silences the mic via `track.enabled=false`, signalling via `set-mute-state`) whenever `outDest` carries non-mic audio. Add a helper:
```ts
const outDestHasExtraAudio = () =>
  (store.getState().secondaryEnabled && !!outGraphRef.current?.secondarySource) ||
  store.getState().isSharingAudio ||
  store.getState().fileStreamName != null;
```
Use it in both `mute` and `unmute` in place of `secondaryActive`. (So muting while sharing/emitting keeps that audio flowing; muting with nothing extra keeps the original pause-producer behavior.)
- [ ] **Step 2: Verify + commit** — regenerate paraglide; client tsc + lint PASS. Commit: `feat(p2p): mute keeps share/file flowing, not just the secondary device`.

---

### Task 5: Client — remove dead share/file receive handling

**Files:** Modify `client/src/hooks/useMediasoup.ts`

- [ ] **Step 1** — In the `consume` handler, remove the `source === "share"` and `source === "file"` branches (browsers no longer produce these). Keep `source === "music"` (caster). Remove `shareOwnersRef`/`fileOwnersRef` and the `removeShareStream`/`removeFileStream` paths if they become unused (verify no other caller). Keep the music/caster tile path intact.
- [ ] **Step 2: Verify + commit** — regenerate paraglide; client tsc + lint PASS (no unused symbols). Commit: `chore(p2p): remove dead share/file consume handling`.

---

### Task 6: Client — minimal announcements (only recording + chat)

**Files:** Modify `client/src/hooks/useMediasoup.ts`, possibly `client/src/components/Room.tsx` / `client/src/stores/room.ts`

- [ ] **Step 1** — Remove every `announceEvent(...)` / `announce(...)` event announcement EXCEPT recording and chat. Concretely remove the calls for: `announce_mic_muted`/`_unmuted`, `announce_peer_muted`/`_unmuted`, `announce_share_started`/`_stopped`/`_you`, `announce_file_stream_started`/`_stopped`/`_you`/`_ended`/`_error`/`_paused`/`_resumed`, `player_now_playing`, `announce_joined`/`announce_left` (peer join/leave), `announce_music_started`/`_stopped` (caster), `announce_ducking_enabled`/`_disabled`, `announce_voice_processing_on`/`_off`, `announce_no_mic`. **Keep** the cue calls (`playCue(...)`) that sit beside them (in `surfaceToggle` callbacks, drop only the `announceEvent` line, keep `playCue`).
- [ ] **Step 2** — **Keep**: recording announcements (`announce_recording_started`/`_stopped`/`_unavailable` — search and leave them) and the chat-message path (`announceChat` / `chat-message` handler). Verify peer join/leave announcements in `Room.tsx`/store (if any) are also removed.
- [ ] **Step 3** — Leave the now-unused i18n message keys in `es.json` (Paraglide tree-shakes unused keys; do not delete to avoid churn) OR remove the clearly-dead ones if trivial — implementer's call, no functional impact either way.
- [ ] **Step 4: Verify + commit** — regenerate paraglide; client tsc + lint + build PASS. Manual: muting/sharing/emitting/join/leave/now-playing are silent; recording start/stop and incoming chat still announce. Commit: `feat(quiet): announce only recording and chat messages`.

---

### Task 7: End-to-end verification

- [ ] **Step 1: Static gates** — client tsc, server tsc, lint, `corepack pnpm --filter server test`, `corepack pnpm --filter client build` → all PASS.
- [ ] **Step 2: Manual** — In P2P (2 peers): Compartir audio → stays P2P, other peer hears it in your voice; Emitir a file → stays P2P, player works (crossfade/seek/volume); mute while sharing/emitting → peer loses your voice but keeps the shared/emitted audio and sees you muted. Caster (if available) still forces SFU + tile. Announcements: only recording + chat spoken.
- [ ] **Step 3: Final note** — branch ready for review/merge.

## Self-Review

- Spec coverage: server SFU-pin (T1); share→voice (T2); file→voice (T3); mute generalization (T4); receive cleanup (T5); announcements (T6); verify (T7). All spec sections covered.
- Placeholders: none — each step names exact functions/symbols; removals are by name (implementer greps + reads).
- Type consistency: `outDest` target consistent T2/T3; `outDestHasExtraAudio()` defined T4; duck-gain removal consistent T2/T3; `set-mute-state` (already in the codebase from the secondary-device feature) reused in T4.
