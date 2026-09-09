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
// negotiates its own rate regardless. The device is pinned with `exact` so the
// browser actually switches to the chosen mic — with `ideal` it may silently keep
// the current/default device, so picking another mic appeared to do nothing.
// Callers use getMicrophoneStream(), which falls back to the default device if
// the chosen one is gone (OverconstrainedError).
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
): MediaTrackConstraints {
  return {
    channelCount: isIOS ? 1 : 2,
    ...(isIOS ? {} : { sampleRate: 48000 }),
    echoCancellation: voiceProcessingEnabled,
    noiseSuppression: voiceProcessingEnabled,
    autoGainControl: voiceProcessingEnabled,
    ...(lowLatency ? { latency: { ideal: 0 } } : {}),
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

// Acquire the microphone for the selected device. We pin the device with `exact`
// (see above) so the switch actually takes effect; if that device is
// gone/unavailable the browser rejects with OverconstrainedError, so we retry on
// the default device instead of failing the switch and silently keeping the old
// track.
export async function getMicrophoneStream(
  deviceId: string,
  voiceProcessingEnabled: boolean,
  lowLatency = false,
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: microphoneConstraints(deviceId, voiceProcessingEnabled, lowLatency),
    });
  } catch (err) {
    if (deviceId && err instanceof DOMException && err.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraints("", voiceProcessingEnabled, lowLatency),
      });
    }
    throw err;
  }
}
