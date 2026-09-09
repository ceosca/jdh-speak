// iOS/iPadOS Safari (iPadOS now reports as "MacIntel" + touch). WebKit's audio
// stack should use the device-native sample rate because hardware route changes
// can otherwise interrupt or garble capture.
export const isIOS =
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

// Apple WebKit (Safari on iOS/iPadOS/macOS, and every iOS browser — they're all
// WebKit under the hood). WebKit only shows the getUserMedia permission prompt
// when the call happens INSIDE a user activation (a real tap/click); called
// outside a gesture it denies silently, with NO prompt. Chrome/Firefox on
// desktop are permissive and prompt regardless. We use this to require an
// explicit "Entrar" tap before the initial auto-join on Apple, so the mic is
// requested from within that gesture and the prompt actually appears.
//   - iOS: `isIOS` already covers Safari + iOS Chrome/Firefox (all WebKit).
//   - macOS Safari: vendor is "Apple Computer, Inc." and it's not a Chromium/
//     Firefox build (those report a different vendor on the Mac).
export const isAppleWebKit =
  isIOS ||
  (typeof navigator !== "undefined" &&
    navigator.vendor === "Apple Computer, Inc." &&
    /Safari/.test(navigator.userAgent) &&
    !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS/.test(navigator.userAgent));

// Mic capture constraints. One per-user choice:
//   - voiceProcessingEnabled: echo cancel / noise suppress / auto gain.
// Voice is captured as stereo (2 channels) — EXCEPT on iPhone/iPad, which capture
// MONO (1 channel). iOS mics are mono anyway, so a "stereo" capture there is just
// a fake dual-mono that can garble; a real single channel is cleaner. The iPhone
// then sends a clean mono signal (and iOS defaults voice processing OFF — see the
// store — so it's mono, not suppressed).
// On iOS we also drop the sample-rate hint so WebKit can use the device-native
// rate (forcing a rate a route can't honour garbles capture); WebRTC/Opus
// negotiates its own rate regardless.
// DEVICE PINNING — `pinDevice`:
//   - true  (explicit switch from Device settings): `deviceId: { exact }` so the
//     browser ACTUALLY moves to the chosen mic — with `ideal` it may silently keep
//     the current one, making a manual switch appear to do nothing.
//   - false (INITIAL join / auto-detect probe): `deviceId: { ideal }`. A stored id
//     can point to a mic that is NOT currently connected (e.g. the AirPods/interface
//     you used last time). `exact` on a disconnected device FAILS or even HANGS on
//     iOS, which is exactly why entering showed no mic and forced the "Entrar" gate.
//     `ideal` never fails on a missing device — the browser just falls back to the
//     system default — so entering always gets a working mic without pinning a stale id.
// lowLatency (jam / "modo ensayo"): ask the browser for the SMALLEST possible
// capture buffer via the `latency` constraint (seconds). The default capture
// buffer is often 20-40 ms; requesting ~0 pushes Chrome/Edge toward ~10 ms or
// less — the biggest reduction available in the otherwise-fixed browser audio
// floor. It's an `ideal`, so devices that can't honour it just keep their
// minimum instead of failing.
export function microphoneConstraints(
  deviceId: string,
  voiceProcessingEnabled: boolean,
  lowLatency = false,
  pinDevice = true,
): MediaTrackConstraints {
  return {
    channelCount: isIOS ? 1 : 2,
    ...(isIOS ? {} : { sampleRate: 48000 }),
    echoCancellation: voiceProcessingEnabled,
    noiseSuppression: voiceProcessingEnabled,
    autoGainControl: voiceProcessingEnabled,
    ...(lowLatency ? { latency: { ideal: 0 } } : {}),
    ...(deviceId ? { deviceId: pinDevice ? { exact: deviceId } : { ideal: deviceId } } : {}),
  };
}

// Acquire the microphone. `pinDevice` (see microphoneConstraints):
//   - true  → explicit device switch: `exact` so the switch takes effect; if that
//     device is gone the browser rejects with a device-selection error and we retry
//     the system default instead of failing the switch.
//   - false → initial join / probe: `ideal`, so a stored-but-disconnected mic can't
//     fail or hang the entry — it just falls back to the default. The catch-retry
//     below is then only a belt-and-suspenders for edge browsers.
export async function getMicrophoneStream(
  deviceId: string,
  voiceProcessingEnabled: boolean,
  lowLatency = false,
  pinDevice = true,
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: microphoneConstraints(deviceId, voiceProcessingEnabled, lowLatency, pinDevice),
    });
  } catch (err) {
    // A stored `micDeviceId` can be STALE or DISCONNECTED — iOS/iPadOS rotate device
    // ids across sessions, and the last-used mic (AirPods, an interface) may simply
    // not be plugged in now. With `deviceId: { exact }` that fails, and depending on
    // the browser it comes back as OverconstrainedError OR NotFoundError (Safari has
    // used both). Before, we only retried the default device on OverconstrainedError,
    // so a NotFound left the user with NO microphone at all even though a perfectly
    // good default mic was available ("no me detecta ninguno"). Now: whenever a
    // SPECIFIC device was requested and it fails for a device-selection reason, drop
    // the id and retry the system default. We still rethrow permission/gesture errors
    // (NotAllowedError, SecurityError) — retrying wouldn't help and could double a prompt.
    const name = err instanceof DOMException ? err.name : "";
    const deviceSelectionError =
      name === "OverconstrainedError" || name === "NotFoundError" || name === "NotReadableError";
    if (deviceId && deviceSelectionError) {
      return navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraints("", voiceProcessingEnabled, lowLatency),
      });
    }
    throw err;
  }
}
