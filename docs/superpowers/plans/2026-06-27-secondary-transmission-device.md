# Secondary Transmission Device — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user transmit a second recording device (mic or hardware loopback) mixed into their voice stream, with mute silencing only the primary mic and an optional local monitor.

**Architecture:** Client-side Web Audio addition (a second `MediaStreamAudioSourceNode` mixed into the existing `outDest`), plus a small server socket event so the muted state can be broadcast without pausing the voice producer when the secondary is active.

**Tech Stack:** TypeScript, React 19, zustand, Web Audio API, mediasoup-client, socket.io.

## Global Constraints

- **pnpm via `corepack pnpm …`** (no `pnpm` on PATH; never npm).
- App is **Spanish-only**; new UI strings go in `client/messages/es.json`; `client/src/paraglide/**` is generated (regenerate, don't hand-edit).
- The secondary mixes into the **voice** producer (`outDest`) — **not** a separate producer, so it must **not** force SFU.
- Capture the secondary with **stereo, no voice processing** (`channelCount: 2`, `echoCancellation/noiseSuppression/autoGainControl: false`).
- No client unit-test suite: per-task gates are `corepack pnpm --filter client exec tsc --noEmit` and `corepack pnpm lint`, plus manual checks in the running app. Server has `node:test`: `corepack pnpm --filter server test`.

---

### Task 1: Store — secondary device state + persistence

**Files:** Modify `client/src/stores/room.ts`

**Interfaces:**
- Produces: store fields `secondaryEnabled: boolean`, `secondaryDeviceId: string`, `secondaryMonitor: boolean`; setters `setSecondaryEnabled(b)`, `setSecondaryDeviceId(s)`, `setSecondaryMonitor(b)` (all persist to localStorage).

- [ ] **Step 1: Add localStorage keys + loaders**

Near the other device keys (`MIC_DEVICE_KEY`, etc.) add:
```ts
const SECONDARY_ENABLED_KEY = "sonicroom:secondaryEnabled";
const SECONDARY_DEVICE_KEY = "sonicroom:secondaryDeviceId";
const SECONDARY_MONITOR_KEY = "sonicroom:secondaryMonitor";
```
Use the existing `loadString` for the device id, and a boolean read (`loadString(KEY) === "true"`) for the two booleans.

- [ ] **Step 2: Add fields to the state interface + initial state**

In the `RoomState` interface add `secondaryEnabled`, `secondaryDeviceId`, `secondaryMonitor` and the three setters. In the store object add initial values (`loadString(SECONDARY_DEVICE_KEY)`, booleans from localStorage) and implement each setter mirroring `setVoiceProcessingEnabled` (persist via `saveString`, then `set({...})`).

- [ ] **Step 3: Verify + commit**

`corepack pnpm --filter client exec tsc --noEmit` → PASS. Commit: `feat(secondary): store state for a secondary transmission device`.

---

### Task 2: Server — broadcast mute state without pausing the producer

When the secondary is active, the client must signal "muted" to peers WITHOUT pausing the voice producer (which would also stop the secondary). Add a socket event that only flips `peer.muted` and broadcasts `peer-muted`/`peer-unmuted`.

**Files:** Modify `server/src/signaling.ts`

**Interfaces:**
- Produces: socket event `set-mute-state` with payload `{ muted: boolean }`; sets `currentPeer.muted` and broadcasts `peer-muted`/`peer-unmuted` to the room (same events the existing `producer-pause`/`-resume` emit), but does NOT touch any producer.

- [ ] **Step 1: Add the handler**

Near the `producer-pause`/`producer-resume` handlers in `server/src/signaling.ts`, add:
```ts
// Visual mute toggle that does NOT pause the producer — used when a peer has a
// secondary transmission device mixed into their voice track, so muting their
// mic must not stop the producer (the secondary keeps flowing). Mirrors the
// peer-muted/-unmuted broadcast of producer-pause without touching media.
socket.on("set-mute-state", (data: unknown, cb?: (res: unknown) => void) => {
  if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
  const parsed = z.object({ muted: z.boolean() }).safeParse(data);
  if (!parsed.success) return cb?.({ ok: false, error: "Invalid value" });
  currentPeer.muted = parsed.data.muted;
  socket.to(currentRoom.name).emit(parsed.data.muted ? "peer-muted" : "peer-unmuted", {
    peerId: socket.id,
  });
  cb?.({ ok: true });
});
```
(Match the exact `peer-muted`/`peer-unmuted` payload shape the existing handlers use — confirm by reading the `producer-pause` handler.)

- [ ] **Step 2: Verify + commit**

`corepack pnpm --filter server exec tsc --noEmit` and `corepack pnpm --filter server test` → PASS. Commit: `feat(secondary): server event to broadcast mute state without pausing`.

---

### Task 3: Audio graph — capture, mix, and monitor the secondary

**Files:** Modify `client/src/hooks/useMediasoup.ts`

**Interfaces:**
- Consumes: store fields from Task 1; `ensureOutGraph()`, `outGraphRef`, `sharedAudioContext`.
- Produces: `outGraphRef` fields `secondarySource: MediaStreamAudioSourceNode | null`, `secondaryGain: GainNode | null`, `secondaryStream: MediaStream | null`; an effect that acquires/releases the secondary device live and connects/disconnects the monitor.

- [ ] **Step 1: Add graph fields**

In the `outGraphRef` object type (~line 248) add `secondarySource`, `secondaryGain`, `secondaryStream` (all `… | null`). Initialize them to `null` in `ensureOutGraph()`'s returned object.

- [ ] **Step 2: Acquire/release helper**

Add a `useCallback` `applySecondaryDevice` that reads `secondaryEnabled`/`secondaryDeviceId`/`secondaryMonitor` from the store and:
- If disabled or no device: disconnect + stop any existing secondary (`secondarySource?.disconnect()`, stop tracks of `secondaryStream`, null the three fields).
- If enabled with a device id: `getUserMedia({ audio: { deviceId: { exact: id }, channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })`; build `secondarySource = ctx.createMediaStreamSource(stream)`, `secondaryGain = ctx.createGain()` (value 1), connect `secondarySource → secondaryGain → outDest`. Store the stream.
- Monitor: if `secondaryMonitor`, also `secondarySource.connect(sharedAudioContext.destination)`; if off, ensure it's not connected to destination. (Re-acquire only when the device id changes; for a monitor-only change, just connect/disconnect the destination edge.)
- Guard with a cancellation flag like the existing mic re-acquire effect; on failure, `console.error` and leave the secondary off.

- [ ] **Step 3: Wire the live effect**

Add a `useEffect` depending on `[secondaryEnabled, secondaryDeviceId, secondaryMonitor]` (selected from the store) that calls `applySecondaryDevice()`. It must early-return cleanly before the out-graph exists is fine (calling `ensureOutGraph()` inside is OK — the graph is lazily built). On unmount/leave, disconnect + stop the secondary stream (extend the existing teardown that nulls the graph).

- [ ] **Step 4: Verify + commit**

`corepack pnpm --filter client exec tsc --noEmit` and `corepack pnpm lint` → PASS. Commit: `feat(secondary): capture, mix and monitor the secondary device`.

---

### Task 4: Mute — keep the secondary alive in SFU

**Files:** Modify `client/src/hooks/useMediasoup.ts`

**Interfaces:**
- Consumes: `emit`, the store secondary fields, the Task 2 `set-mute-state` event.

- [ ] **Step 1: Branch mute on the secondary**

In `mute` (~line 1619): keep `track.enabled = false`. Then:
```ts
const secondaryActive =
  store.getState().secondaryEnabled && !!outGraphRef.current?.secondarySource;
if (secondaryActive) {
  // Don't pause the producer — the secondary must keep flowing. Tell peers we're
  // muted via the non-pausing event instead of producer-pause.
  await emit("set-mute-state", { muted: true }).catch(() => {});
} else {
  if (modeRef.current === "sfu" && producerRef.current) producerRef.current.pause();
  await emit("producer-pause", {}).catch(() => {});
}
```
Keep the rest (`setMuted(true)`, `surfaceToggle`). In `unmute` mirror it: re-enable the track, and `if (secondaryActive) emit("set-mute-state", { muted: false })` else resume producer + `emit("producer-resume")`. (Compute `secondaryActive` the same way; on unmute, resuming the producer when it was never paused is harmless, but prefer the symmetric branch.)

- [ ] **Step 2: Verify + commit**

`corepack pnpm --filter client exec tsc --noEmit` and `corepack pnpm lint` → PASS. Commit: `feat(secondary): mute silences only the primary mic when secondary is active`.

---

### Task 5: UI (DeviceSettings) + i18n

**Files:** Modify `client/src/components/DeviceSettings.tsx`, `client/messages/es.json`

**Interfaces:**
- Consumes: store secondary fields/setters (Task 1), the `mics` list already built by `DeviceSettings`.

- [ ] **Step 1: Add Spanish messages**

In `client/messages/es.json` add:
```json
"settings_secondary_label": "Activar placa de transmisión secundaria",
"settings_secondary_device_label": "Dispositivo secundario",
"settings_secondary_monitor_label": "Escuchar tu placa secundaria",
"settings_secondary_hint": "Mezcla un segundo dispositivo de grabación (otro micro o un loopback) en tu audio. Al silenciar, solo se silencia tu micro principal."
```
Regenerate: `corepack pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide`.

- [ ] **Step 2: Render the controls**

In `DeviceSettings.tsx`, read the three secondary store values + setters. After the speaker block, add a checkbox bound to `secondaryEnabled` (label `m.settings_secondary_label()`, describedby a hint `m.settings_secondary_hint()`). When `secondaryEnabled` is true, render: a `<select>` of `mics` (reuse the existing `mics` list and `selectClass`; value = `secondaryDeviceId`, onChange = `setSecondaryDeviceId`) and a checkbox bound to `secondaryMonitor` (label `m.settings_secondary_monitor_label()`). Use `useId()` for the new ids; match the existing markup/classes.

- [ ] **Step 3: Verify + commit**

`corepack pnpm --filter client exec tsc --noEmit`, `corepack pnpm lint`, and `corepack pnpm --filter client build` → PASS. Commit: `feat(secondary): device settings UI for the secondary transmission device`.

---

### Task 6: End-to-end verification

**Files:** none.

- [ ] **Step 1: Static gates**

`corepack pnpm --filter client exec tsc --noEmit`, `corepack pnpm --filter server exec tsc --noEmit`, `corepack pnpm --filter server test`, `corepack pnpm lint`, `corepack pnpm --filter client build` → all PASS.

- [ ] **Step 2: Manual (running app, real devices)**

With two browsers/peers and a second recording device available:
- Enable the secondary + pick a device → the other peer hears your mic + secondary mixed.
- Mute → the other peer stops hearing your voice but **keeps hearing the secondary**, and sees you as muted. Unmute restores your voice.
- Enable the monitor → you hear the secondary locally.
- Confirm with 2 peers the room stays **P2P** with the secondary active (no SFU forced).

- [ ] **Step 3: Final note**

Branch ready for the player feature plan / review. No commit.

## Self-Review

- Spec coverage: store (T1), mute-state server event (T2), capture/mix/monitor (T3), mute behavior (T4), UI+i18n (T5), verify (T6). All spec sections covered.
- Placeholder scan: each step names exact files/edits; T2/T3 note "confirm the existing payload shape" — that's a read instruction, not a placeholder.
- Type consistency: `secondaryEnabled/secondaryDeviceId/secondaryMonitor` and `secondarySource/secondaryGain/secondaryStream` used consistently across T1/T3/T4; `set-mute-state {muted}` consistent T2/T4.
