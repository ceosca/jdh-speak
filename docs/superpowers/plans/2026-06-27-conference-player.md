# Conference Player (VLC-style) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the local-file streamer into a full conference player: local file/folder playlist, VLC-style seek + prev/next, crossfade between tracks, a volume that lowers for all listeners, and accessible keyboard shortcuts reachable via a global hotkey.

**Architecture:** Generalize the existing single-`<audio>` "file" producer path in `useMediasoup.ts` into a **two-slot** engine (two persistent `<audio>` elements + sources + crossfade gains) feeding one shared `fileVolumeGain → fileDuckGain → fileDest` so the produced "file" track never changes. Playlist/playback UI state lives in the store; the player window (`FileStreamPlayer.tsx`) becomes the full UI; a global `Ctrl+Alt+P` moves focus into the `role="application"` player so the in-player shortcuts work with NVDA.

**Tech Stack:** TypeScript, React 19, zustand, Web Audio API, mediasoup-client.

## Global Constraints

- **pnpm via `corepack pnpm …`** (never npm). Spanish-only; strings in `client/messages/es.json`; `client/src/paraglide/**` generated (regenerate, don't hand-edit).
- The produced **"file"** track stays `fileDest`'s — never swap it (no SFU/tile churn). All changes feed into `fileDest`.
- **Volume lowers at the source** (`fileVolumeGain`) so every listener hears it lower; independent of per-peer volume and of `fileDuckGain` (auto-duck).
- Keyboard: global **`Ctrl+Alt+P`** focuses the player; in-player keys — **Space** play/pause, **Ctrl+←/→** ∓1 min, **Alt+←/→** ∓10 s (preventDefault the browser back/forward), **Shift+←/→** ∓5 s, **Shift+P** prev, **Shift+N** next. Shortcuts never fire while typing in an input/textarea.
- **m4b chapters are out of scope** (deferred).
- No client unit tests: gates are `corepack pnpm --filter client exec tsc --noEmit`, `corepack pnpm lint`, `corepack pnpm --filter client build`, plus manual checks.

---

### Task 1: Volume for all (source-side `fileVolumeGain` + combobox)

Delivers the "lower volume for everyone" on the existing single-file player, standalone.

**Files:** Modify `client/src/hooks/useMediasoup.ts`, `client/src/stores/room.ts`, `client/src/components/FileStreamPlayer.tsx`, `client/messages/es.json`

**Interfaces:**
- Produces: store `fileVolume: number` (0–1, default 1, persisted) + `setFileVolume(v)`; graph field `fileVolumeGain: GainNode | null`; `setFileVolume` applies live to the gain.

- [ ] **Step 1: Store** — add `fileVolume` (load from localStorage `jdh-speak:fileVolume`, default 1) + `setFileVolume` (persist + `set`).
- [ ] **Step 2: Graph** — add `fileVolumeGain` to the `outGraphRef` type and init null. In `startFileSource` (~line 1885) build it once: `fileVolumeGain = ctx.createGain(); fileVolumeGain.gain.value = store.getState().fileVolume; fileVolumeGain.connect(g.fileDuckGain)`. Change `source.connect(g.fileDuckGain)` to `source.connect(g.fileVolumeGain)`. Keep the local monitor (`source.connect(destination)`) at full volume. In the file teardown (~1820) disconnect+null `fileVolumeGain`.
- [ ] **Step 3: Apply live** — add a `useCallback setPlayerVolume(v)` that calls `store.getState().setFileVolume(v)` and ramps `outGraphRef.current?.fileVolumeGain?.gain.setTargetAtTime(v, ctx.currentTime, 0.05)`. Expose it from the hook’s return.
- [ ] **Step 4: UI** — in `FileStreamPlayer.tsx` add a `<select>` (combobox) with options 100/75/50/25/10 % bound to `fileVolume` (value → `setPlayerVolume`). Add `settings`/player i18n keys (`player_volume_label`) in `es.json`; regenerate paraglide.
- [ ] **Step 5: Verify + commit** — tsc + lint PASS; in-app a peer hears the file quieter when you lower it. Commit: `feat(player): source-side volume that lowers the file for all listeners`.

---

### Task 2: Two-slot file engine (graph refactor)

Refactor the file path to two persistent chains so crossfade is possible. No behavior change yet (single track still works).

**Files:** Modify `client/src/hooks/useMediasoup.ts`

**Interfaces:**
- Produces: graph slots `fileSlots: [Slot, Slot]` where `Slot = { audioEl: HTMLAudioElement; source: MediaElementAudioSourceNode; xfadeGain: GainNode }`, plus `activeSlot: 0 | 1`. Shared `fileVolumeGain → fileDuckGain → fileDest`. An internal `loadIntoSlot(slot, src, name, objectUrl?)` that swaps `audioEl.src` (the source/xfadeGain persist) and returns when metadata is ready.

- [ ] **Step 1** — Build the two slots lazily in `ensureOutGraph`/first file start: for each slot create a persistent `new Audio()` (playsInline), `createMediaElementSource(audioEl)` once, and an `xfadeGain` (value 1 for the active slot, 0 for the idle one) connected `source → xfadeGain → fileVolumeGain`. (`createMediaElementSource` may only be called once per element — never recreate the element; only swap `.src`.)
- [ ] **Step 2** — Reimplement `startFileSource` to load into the active slot via `loadIntoSlot` (swap `.src`, revoke the previous object URL for that slot, re-bind `ended`/`error` with a per-load AbortController). Keep the existing SFU pin / `start-file-stream` / `produceFile` flow on first start. Single-track playback must behave exactly as before.
- [ ] **Step 3: Verify + commit** — tsc + lint PASS; a single local file still streams, pause/resume/replace still work. Commit: `refactor(player): two-slot file audio engine (no behavior change)`.

---

### Task 3: Playlist (local file + folder), prev/next, auto-advance, crossfade

**Files:** Modify `client/src/hooks/useMediasoup.ts`, `client/src/stores/room.ts`, `client/src/components/Room.tsx` (file pickers), `client/messages/es.json`

**Interfaces:**
- Consumes: Task 2 slots/`loadIntoSlot`.
- Produces: store `playlist: { name: string; objectUrl: string }[]`, `playlistIndex: number`, `playerRepeat: "off"|"one"|"all"`, `playerShuffle: boolean`; hook actions `playTrack(index)`, `playerNext()`, `playerPrev()` that crossfade between slots; auto-advance on `ended`.

- [ ] **Step 1: Pickers** — add a folder picker (`<input type="file" webkitdirectory>`) alongside the existing file picker (in `Room.tsx`/`AudioSourceDialog`); filter to audio files (`file.type.startsWith("audio/")` or extension in `mp3,m4a,aac,ogg,opus,wav,flac,m4b`), build `{ name, objectUrl: URL.createObjectURL(file) }[]`, set `playlist` + start `playTrack(0)`. A single file sets a 1-item playlist.
- [ ] **Step 2: Crossfade next/prev** — `playTrack(index)`: load the target into the **idle** slot, `play()` it, then ramp idle `xfadeGain` 0→1 and active `xfadeGain` 1→0 over ~3 s (`setTargetAtTime`), swap `activeSlot`, pause the now-idle element after the fade. `playerNext`/`playerPrev` compute the next index respecting `playerShuffle` (precomputed shuffled order) and call `playTrack`.
- [ ] **Step 3: Auto-advance** — the active slot's `ended` handler: if `repeat==="one"` replay same; else advance (`playerNext`); if at end and `repeat!=="all"`, stop the stream (existing `stopFileStream`). Revoke object URLs on stop.
- [ ] **Step 4: Repeat/shuffle store + setters** — add `playerRepeat`/`playerShuffle` (persisted) + setters.
- [ ] **Step 5: Verify + commit** — tsc + lint PASS; pick a folder → list builds; next/prev crossfade; auto-advance works; repeat/shuffle behave. Commit: `feat(player): folder playlist with crossfade, prev/next, repeat and shuffle`.

---

### Task 4: Player UI (progress, times, buttons, list, speed)

**Files:** Modify `client/src/components/FileStreamPlayer.tsx`, `client/messages/es.json`

**Interfaces:**
- Consumes: store playlist/index/repeat/shuffle/volume; hook actions `playerTogglePlay`, `playerSeekBy(seconds)`, `playerSeekTo(seconds)`, `playerNext`, `playerPrev`, `setPlayerRate`, `playTrack`.

- [ ] **Step 1** — Expose from `useMediasoup`: `playerSeekBy(sec)` (active `audioEl.currentTime += sec`, clamped), `playerSeekTo(sec)`, `playerTogglePlay`, `setPlayerRate(r)` (`audioEl.playbackRate = r`, persisted). Surface `currentTime`/`duration` via a lightweight subscription (a `timeupdate`/`durationchange` listener writing to store `playerTime`/`playerDuration`, throttled).
- [ ] **Step 2** — Rebuild `FileStreamPlayer.tsx` as the full UI inside a `role="application"` container with `aria-label`: track name; a range `<input type="range">` progress bar (value=`playerTime`, max=`playerDuration`, onChange=`playerSeekTo`, `aria-valuetext` = formatted time); current/total time text; buttons play/pause, −10 s, +10 s, previous, next (each with `aria-label`); the volume combobox (Task 1); a speed `<select>` (0.5/0.75/1/1.25/1.5/2×); repeat and shuffle toggle buttons (`aria-pressed`); and, when `playlist.length>1`, a playlist `<ul role="listbox">` (current `aria-selected`, click/Enter → `playTrack`). Reuse existing Tailwind classes.
- [ ] **Step 3: i18n** — add all new labels to `es.json` (`player_progress`, `player_back10`, `player_fwd10`, `player_prev`, `player_next`, `player_speed`, `player_repeat`, `player_shuffle`, `player_playlist`, …); regenerate paraglide.
- [ ] **Step 4: Verify + commit** — tsc + lint + build PASS; all controls work in-app. Commit: `feat(player): full player UI (progress, seek, list, speed, repeat, shuffle)`.

---

### Task 5: Resume position + now-playing announcement + persisted prefs

**Files:** Modify `client/src/hooks/useMediasoup.ts`, `client/src/stores/room.ts`, `client/messages/es.json`

- [ ] **Step 1: Resume position** — keep a `Map<string, number>` of file-name → last position (persist a bounded version in localStorage). On `loadIntoSlot`, after metadata loads, `audioEl.currentTime = saved` if present. Update on `pause`/track-change/`stopFileStream`.
- [ ] **Step 2: Announce track change** — when a new track becomes active, `store.getState().announceEvent(player_now_playing({ name }))` (goes to the ARIA region + chat for NVDA). Add `player_now_playing` to `es.json`; regenerate.
- [ ] **Step 3: Persist** — confirm `fileVolume`, `playerRate`, `playerRepeat`, `playerShuffle` all load from localStorage on init.
- [ ] **Step 4: Verify + commit** — tsc + lint PASS; reopening a long file resumes; NVDA hears "Ahora suena: X". Commit: `feat(player): resume position, now-playing announcement, persisted prefs`.

---

### Task 6: Keyboard — global focus hotkey + in-player shortcuts

**Files:** Modify `client/src/components/Room.tsx`, `client/src/components/FileStreamPlayer.tsx`, `client/messages/es.json`

**Interfaces:**
- Consumes: hook player actions; a ref/id to focus the player container.

- [ ] **Step 1: Global hotkey** — in `Room.tsx`'s `handleKeyDown` (the existing `useEffect`, near the `Alt+Ctrl+C` branch ~line 238) add: `if (e.altKey && e.ctrlKey && (e.code === "KeyP" || e.key === "p" || e.key === "P")) { e.preventDefault(); focus the player container (a ref or document.getElementById on the player's id); }`. Only when the player is open (`fileStreamName != null`); otherwise announce it’s not playing.
- [ ] **Step 2: In-player shortcuts** — on the `role="application"` container's `onKeyDown`: Space → `playerTogglePlay` (preventDefault); ArrowLeft/Right with `ctrlKey` → `playerSeekBy(∓60)`, with `altKey` → `playerSeekBy(∓10)` **and `preventDefault`** (kills browser back/forward), with `shiftKey` → `playerSeekBy(∓5)`; `shiftKey`+KeyP → `playerPrev`; `shiftKey`+KeyN → `playerNext`. Stop-propagation so the global handler doesn't double-handle. Keep Escape = stop (existing).
- [ ] **Step 3: Typing guard** — the global hotkey already sits after the input/textarea guard pattern in `Room.tsx`; ensure the player container shortcuts also ignore events whose target is an inner input/select (the volume/speed selects) so arrows still adjust those natively.
- [ ] **Step 4: i18n + a11y hint** — update the player hint string to describe the shortcuts; add `player_focus_hint`. Regenerate.
- [ ] **Step 5: Verify + commit** — tsc + lint + build PASS; `Ctrl+Alt+P` focuses the player; Space/arrows/Shift+P/N work; Alt+arrows no longer navigate browser history; chat typing unaffected. Commit: `feat(player): global focus hotkey + accessible in-player shortcuts`.

---

### Task 7: End-to-end verification

- [ ] **Step 1: Static gates** — client tsc, server tsc, `corepack pnpm --filter server test`, lint, `corepack pnpm --filter client build` → all PASS.
- [ ] **Step 2: Manual** — folder → playlist; play/seek (buttons + all key combos); crossfade on next/auto-advance; volume combo lowers it for a second peer; speed/repeat/shuffle; `Ctrl+Alt+P` + NVDA focus mode; "Ahora suena" announced; resume position on a long file; no regression to single-file / library / URL sources.
- [ ] **Step 3: Final note** — branch ready for review/merge (superpowers:finishing-a-development-branch).

## Self-Review

- Spec coverage: sources/playlist (T3), two-slot+crossfade (T2/T3), controls UI (T4), volume-for-all (T1), resume+announce (T5), keyboard+a11y (T6), verify (T7). m4b explicitly out of scope. All spec sections covered.
- Placeholder scan: steps name exact files/edits and the engine interface; no "TBD"/"handle edge cases".
- Type consistency: `fileVolumeGain` (T1) reused T2; `fileSlots`/`xfadeGain`/`activeSlot`/`loadIntoSlot` (T2) used T3; player actions (`playerTogglePlay`/`playerSeekBy`/`playerSeekTo`/`playerNext`/`playerPrev`/`setPlayerRate`/`playTrack`) defined T3/T4 and consumed T4/T6; store fields (`fileVolume`/`playlist`/`playlistIndex`/`playerRepeat`/`playerShuffle`/`playerRate`/`playerTime`/`playerDuration`) consistent across tasks.
