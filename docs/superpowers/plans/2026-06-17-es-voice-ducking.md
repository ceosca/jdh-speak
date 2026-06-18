# Spanish-only + Live Voice Processing + Source-Side Ducking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make JDH Speak Spanish-only, apply the voice-processing toggle live mid-call (with a screen-reader confirmation), and duck emitted (share/file) audio at the source so recording, Icecast, and all listeners receive it uniformly attenuated.

**Architecture:** All client-side (React 19 + zustand + Web Audio + Paraglide). F1 collapses Paraglide to a single `es` locale and removes the language picker. F2 builds on the existing mid-call mic re-acquire effect and adds an SR announcement. F3 inserts duck gain nodes on the outgoing share/file Web-Audio paths and stops double-ducking by only receiver-ducking the external caster.

**Tech Stack:** TypeScript, React 19, zustand, mediasoup-client, Web Audio API, Paraglide JS i18n, Vite.

## Global Constraints

- **Package manager:** pnpm via `corepack pnpm …` (no `pnpm` on PATH; never use npm).
- **i18n:** message JSON lives in `client/messages/*.json`; `client/src/paraglide/**` is GENERATED — never hand-edit. Regenerated on `pnpm dev`/`pnpm build` or `corepack pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide`.
- **Single locale:** after F1 the only locale is `es` (`baseLocale: "es"`, `locales: ["es"]`). `m.*()` calls stay; with one locale they always return Spanish.
- **Ducking constants** (already in `useMediasoup.ts`): `DUCK_FACTOR = 0.22`, `DUCK_ATTACK = 0.05`, `DUCK_RELEASE = 0.09`. Reuse them — do not invent new values.
- **F3 scope:** duck ONLY the emitted share/file path (the sent producer). Do NOT duck the emitter's voice (`mic → micGain → limiter → outDest`) nor the local monitor (`source.connect(sharedAudioContext.destination)`).
- **No client unit tests exist.** Per-task gates: `corepack pnpm --filter client exec tsc --noEmit` and `corepack pnpm lint`, plus manual checks in the running app (`http://localhost:5173`). Verification commands run from repo root.

---

### Task 1: Spanish-only (remove en/fr + language picker)

**Files:**
- Modify: `client/project.inlang/settings.json`
- Delete: `client/messages/en.json`, `client/messages/fr.json`
- Delete: `client/src/components/LanguageSelect.tsx`
- Modify: `client/src/components/Room.tsx` (remove `<LanguageSelect />` from the room header)
- Modify: `client/src/lib/i18n.ts`
- Modify: `client/src/stores/room.ts` (remove `locale` field + `setLanguage` action)
- Modify: `client/src/main.tsx` (remove the `locale` subscription)
- Modify: `client/messages/es.json` (remove `language_label`)

**Interfaces:**
- Produces: the store no longer has `locale` or `setLanguage`; `LanguageSelect` no longer exists. Nothing else consumes these after this task.

- [ ] **Step 1: Collapse the inlang project to Spanish**

In `client/project.inlang/settings.json` set the locale list to Spanish only. Find the `baseLocale` and `locales` keys and set:
```json
"baseLocale": "es",
"locales": ["es"]
```
(Leave the rest of the file — plugins, paths — unchanged.)

- [ ] **Step 2: Delete the other message catalogs**

```
git rm client/messages/en.json client/messages/fr.json
```

- [ ] **Step 3: Remove the language picker component and its room usage**

```
git rm client/src/components/LanguageSelect.tsx
```
In `client/src/components/Room.tsx`, remove the `import { LanguageSelect } from "./LanguageSelect";` line and the `<LanguageSelect … />` element rendered in the room header (the banner area showing "Idioma"). Remove any now-unused wrapper that only held it.

- [ ] **Step 4: Simplify `i18n.ts`**

Replace `client/src/lib/i18n.ts` with a Spanish-only version — drop the `?lang=` override and the multi-locale `LOCALE_NAMES`, keep the runtime re-exports other code imports, and pin `<html lang>` to `es`:
```ts
// App-wide locale wiring on top of Paraglide's generated runtime.
// The app is Spanish-only (a single `es` locale), so there is no picker and
// no language resolution — Paraglide's m.*() always return Spanish.
import { getLocale, setLocale, isLocale, locales, baseLocale } from "../paraglide/runtime.js";

// Single supported locale, derived from the generated `locales` tuple.
export type Locale = (typeof locales)[number];

// Keep <html lang> correct from the first paint (a11y, hyphenation, SEO).
document.documentElement.lang = "es";

export { getLocale, setLocale, isLocale, locales, baseLocale };
```

- [ ] **Step 5: Remove `locale`/`setLanguage` from the store**

In `client/src/stores/room.ts`:
- Remove the `locale: Locale;` field from the `RoomState` interface and `setLanguage: (locale: Locale) => void;` from it.
- Remove `locale: getLocale(),` from the initial state object and the whole `setLanguage: (locale) => { … }` implementation.
- Remove now-unused imports: `getLocale`, `setLocale as applyParaglideLocale`, `type Locale` from `../lib/i18n` (keep any of those that remain used elsewhere — verify by search; `speak` and others stay).
- If `reset` references `locale`, remove that line (it does not currently, but confirm).

- [ ] **Step 6: Remove the `locale` subscription in `main.tsx`**

In `client/src/main.tsx`, delete the line `useRoomStore((s) => s.locale);` and its explanatory comment block. Update the import side-effect comment if it mentions `?lang=` (the override is gone). `App` no longer needs to read the store.

- [ ] **Step 7: Remove the `language_label` message**

In `client/messages/es.json` delete the `"language_label": …` entry (it was only used by the picker).

- [ ] **Step 8: Regenerate Paraglide and verify**

Run:
```
corepack pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide
corepack pnpm --filter client exec tsc --noEmit
corepack pnpm lint
```
Expected: all PASS. Then `corepack pnpm --filter client build` succeeds (proves the single-locale catalog is consistent and no removed key is still referenced). Confirm `grep -rn "LanguageSelect\|language_label\|setLanguage\|s.locale" client/src` returns nothing outside generated `paraglide/`.

- [ ] **Step 9: Commit**

```
git add client/
git commit -m "feat: Spanish-only — remove en/fr and the language picker"
```

---

### Task 2: Voice processing applies live (+ SR announcement)

The mid-call re-acquire already exists (`client/src/hooks/useMediasoup.ts`, the effect with deps `[micDeviceId, voiceProcessingEnabled, connectMicToGraph, store]`, ~line 454). This task verifies it applies in real time and announces the change for NVDA.

**Files:**
- Modify: `client/src/hooks/useMediasoup.ts`
- Modify: `client/messages/es.json`

**Interfaces:**
- Consumes: existing `store.getState().announce(msg)`, the existing re-acquire effect.
- Produces: two new message functions `m.announce_voice_processing_on()` / `m.announce_voice_processing_off()` (added to `es.json`, generated by Paraglide).

- [ ] **Step 1: Add the announcement messages**

In `client/messages/es.json` add (alphabetical position near other `announce_*` keys):
```json
"announce_voice_processing_on": "Procesamiento de voz activado",
"announce_voice_processing_off": "Procesamiento de voz desactivado",
```

- [ ] **Step 2: Regenerate Paraglide so the functions exist**

Run:
```
corepack pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide
```
Then add the imports to `client/src/hooks/useMediasoup.ts` alongside the other `announce_*` imports from `../paraglide/messages.js`: `announce_voice_processing_on`, `announce_voice_processing_off`.

- [ ] **Step 3: Announce on successful live re-acquire**

In the mic re-acquire effect (the one that calls `getUserMedia({ audio: microphoneConstraints(micDeviceId, voiceProcessingEnabled) })` and then `connectMicToGraph(stream)`), after `connectMicToGraph(stream)` and `old?.getTracks().forEach((t) => t.stop());`, announce the new state — but only when the change was the voice-processing flag (not a device switch), so a device change doesn't read out "voice processing on". Compare against the captured `previous`:
```ts
// Confirm the live change to screen readers when the voice-processing flag
// (not the device) is what changed.
if (previous.voiceProcessingEnabled !== voiceProcessingEnabled) {
  store
    .getState()
    .announce(
      voiceProcessingEnabled ? announce_voice_processing_on() : announce_voice_processing_off(),
    );
}
```
(`previous` is the `prevMicSettingsRef.current` snapshot already read at the top of the effect; reuse it — do not re-read the ref after it was reassigned.)

- [ ] **Step 4: Verify (live, with a real mic)**

Run `corepack pnpm --filter client exec tsc --noEmit` and `corepack pnpm lint` — expect PASS. Then in the running app (`http://localhost:5173`) with a real microphone: join a room, open audio settings, toggle "Procesamiento de voz" off then on. Expected: the echo-cancel/noise-suppress/AGC behavior changes immediately (no rejoin), and each toggle is announced on the live region. If the change does NOT apply live, use superpowers:systematic-debugging on the re-acquire effect (likely suspects: the effect early-returns because `localStreamRef.current` is null, or the new track is not rerouted) before adjusting; do not weaken the announcement to hide a missing re-acquire.

- [ ] **Step 5: Commit**

```
git add client/
git commit -m "feat: announce live voice-processing toggle for screen readers"
```

---

### Task 3: Source-side ducking of emitted audio

Duck the emitter's share/file output at the source; stop receiver-ducking it (keep receiver-ducking only the external `music` caster).

**Files:**
- Modify: `client/src/hooks/useMediasoup.ts`
- Modify: `client/src/stores/room.ts`

**Interfaces:**
- Consumes: existing `applyDuck(active)` (~line 324), `effectiveGain(id)` (~line 296), the outgoing graph `outGraphRef` (fields incl. `displaySource`, `shareDest`, `fileSource`, `fileDest`), and `isVoiceActiveRef`/`store.getState().duckingEnabled`.
- Produces: `PeerState.duckAtReceiver: boolean` (true only for the external `music` caster). Two new graph gain nodes `shareDuckGain`, `fileDuckGain`.

- [ ] **Step 1: Add `duckAtReceiver` to peer state**

In `client/src/stores/room.ts`, add to the `PeerState` interface (near `isMusic`):
```ts
  // True only for an EXTERNAL music caster (Ecobox, source "music"), which
  // sends raw stereo and cannot duck itself — so listeners duck it. A browser
  // emitter's share/file producer is ducked at the source instead, so it is
  // NOT receiver-ducked (duckAtReceiver false) to avoid double-ducking.
  duckAtReceiver: boolean;
```
In `addPeer(...)`, initialize `duckAtReceiver: false,` in the new peer object. (Leave `reset`/others; this field defaults false everywhere a peer is created.)

- [ ] **Step 2: Add a store action and mark the caster as receiver-ducked on consume**

First add a setter (the consume handler has `store` but not `set`, so a store action is needed). In `client/src/stores/room.ts` add to the `RoomState` interface, near `setPeerMusic`:
```ts
  setPeerDuckAtReceiver: (peerId: string, value: boolean) => void;
```
and implement it (mirroring `setPeerMusic`):
```ts
  setPeerDuckAtReceiver: (peerId, value) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, duckAtReceiver: value });
      return { peers };
    }),
```
Then in `client/src/hooks/useMediasoup.ts`, in the consume handler's `source === "music"` branch (~line 700), right after `store.getState().setPeerMusic(peerId, true);` add:
```ts
store.getState().setPeerDuckAtReceiver(peerId, true);
```
Leave the `share`/`file` branches as-is (they keep `isMusic: true` but `duckAtReceiver` stays false).

- [ ] **Step 3: Receiver-duck only the caster**

In `effectiveGain` (~line 296), change the ducking condition so only `duckAtReceiver` peers (the caster) duck on the receiving side:
```ts
if (
  peer.isMusic &&
  peer.duckAtReceiver &&
  isVoiceActiveRef.current &&
  state.duckingEnabled
)
  return peer.volume * DUCK_FACTOR;
```
(Share/file peers have `isMusic: true` but `duckAtReceiver: false`, so they no longer receiver-duck.)

- [ ] **Step 4: Add duck gain nodes to the outgoing graph type**

In `client/src/hooks/useMediasoup.ts`, in the `outGraphRef` ref type (the object literal type around line 221) add two fields:
```ts
    shareDuckGain: GainNode | null;
    fileDuckGain: GainNode | null;
```
In `ensureOutGraph()` (~line 410) initialize both to `null` in the returned object.

- [ ] **Step 5: Route the share through its duck gain**

In `startAudioShare` (where `displaySource.connect(shareDest)` is — ~line 1678), insert a gain node between them:
```ts
const shareDuckGain = sharedAudioContext.createGain();
shareDuckGain.gain.value = duckGainTarget(); // current duck level (see Step 7)
displaySource.connect(shareDuckGain);
shareDuckGain.connect(shareDest);
g.displaySource = displaySource;
g.shareDest = shareDest;
g.shareDuckGain = shareDuckGain;
```
In the share teardown paths that null `displaySource`/`shareDest` (the `stopAudioShare` area ~line 1609-1613 and the cleanup ~line 2004-2005), also `g.shareDuckGain?.disconnect();` and set `g.shareDuckGain = null;`.

- [ ] **Step 6: Route the file through its duck gain**

In `startFileSource` (where `source.connect(g.fileDest)` is — ~line 1786), insert the duck gain on the SENT path only (leave the local monitor `source.connect(sharedAudioContext.destination)` untouched):
```ts
if (!g.fileDest) g.fileDest = sharedAudioContext.createMediaStreamDestination();
if (!g.fileDuckGain) {
  g.fileDuckGain = sharedAudioContext.createGain();
  g.fileDuckGain.gain.value = duckGainTarget();
  g.fileDuckGain.connect(g.fileDest);
}
source.connect(g.fileDuckGain);
// Also monitor it locally at full volume (not ducked).
source.connect(sharedAudioContext.destination);
```
On the file-stream replace path the previous `g.fileSource?.disconnect()` already detaches the old element; `fileDuckGain`→`fileDest` persists (correct — the producer is fileDest's). In the file teardown that nulls `fileSource`/`fileDest`, also disconnect+null `g.fileDuckGain`.

- [ ] **Step 7: Ramp the emit duck gains under voice**

Add a helper near `DUCK_FACTOR` and use it in `applyDuck`. First a tiny helper that returns the current target (so newly-created nodes start at the right level):
```ts
// Current emit-side duck target: the emitter drops its OWN share/file output
// to DUCK_FACTOR while a voice is active (and room ducking is on), 1 otherwise.
function emitDuckTarget(): number {
  const s = useRoomStore.getState();
  return isVoiceActiveRef.current && s.duckingEnabled ? DUCK_FACTOR : 1;
}
```
`isVoiceActiveRef` is in scope inside the hook; place `emitDuckTarget` as a `useCallback` (or inline closure) inside the hook, not module scope. Replace the `duckGainTarget()` placeholder in Steps 5/6 with `emitDuckTarget()`.

In `applyDuck(active)` (~line 324), after `rampMusicGains(...)`, ramp the emit duck gains too:
```ts
const g = outGraphRef.current;
const target = active && useRoomStore.getState().duckingEnabled ? DUCK_FACTOR : 1;
const ramp = active ? DUCK_ATTACK : DUCK_RELEASE;
const now = sharedAudioContext.currentTime;
g?.shareDuckGain?.gain.setTargetAtTime(target, now, ramp);
g?.fileDuckGain?.gain.setTargetAtTime(target, now, ramp);
```
Also handle the room ducking toggle: in the `ducking-changed` handler / wherever `rampMusicGains` is called on toggle (`toggleDucking` path ~line 1585 and the `ducking-changed` socket handler ~line 1405), re-ramp the emit gains to `emitDuckTarget()` so turning room ducking off un-ducks the emitted output too. Reuse the same three lines (factor out a small `rampEmitDuck(active)` `useCallback` to avoid duplication, called from both `applyDuck` and the toggle path).

- [ ] **Step 8: Verify**

Run `corepack pnpm --filter client exec tsc --noEmit` and `corepack pnpm lint` — expect PASS. Then in the running app with **three tabs** (so the room is SFU and the server actually routes producers):
- Tab A shares system/tab audio (or streams a file). Tabs B/C listen.
- While music plays, Tab B talks. Expected: the music drops ONCE (not double-faint), and returns when B stops.
- Start a recording (or Icecast stream) from any tab while talking over the music; the captured audio is attenuated during speech (this is the whole point — verify the recording download is ducked).
- Toggle room auto-ducking off: the emitted music stays at full even while talking.

- [ ] **Step 9: Commit**

```
git add client/
git commit -m "feat: duck emitted share/file audio at the source"
```

---

### Task 4: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Static gates**

Run and confirm PASS:
```
corepack pnpm --filter client exec tsc --noEmit
corepack pnpm lint
corepack pnpm --filter client build
```

- [ ] **Step 2: Manual smoke (running app)**

In `http://localhost:5173`:
- UI is fully Spanish; the room header has NO language selector.
- With a real mic: toggling "Procesamiento de voz" applies live and is announced.
- Three tabs, source-side ducking behaves as in Task 3 Step 8 (single duck; recording/stream ducked; respects the room toggle).
- Existing features still work: mute/unmute, deafen, per-peer volume, audio share, file stream, recording, Icecast streaming, chat — no regressions.

- [ ] **Step 3: Final note**

Branch `es-voice-ducking` ready for review/merge (see superpowers:finishing-a-development-branch). No commit for this task.

## Self-Review

- **Spec coverage:** F1 → Task 1; F2 → Task 2; F3 → Task 3; verification → Task 4. All spec sections covered.
- **Placeholder scan:** the `duckGainTarget()` placeholder in Steps 5/6 is explicitly resolved to `emitDuckTarget()` in Step 7 (called out in both places). No "TBD"/"handle edge cases" left.
- **Type consistency:** `duckAtReceiver` (PeerState) defined in Task 3 Step 1, set via `setPeerDuckAtReceiver` (Step 2), read in `effectiveGain` (Step 3). `shareDuckGain`/`fileDuckGain` graph fields defined Step 4, used Steps 5–7. `emitDuckTarget()`/`rampEmitDuck()` defined Step 7, referenced Steps 5–7 consistently.
