// iOS/iPadOS Safari (iPadOS now reports as "MacIntel" + touch). WebKit's audio
// stack should use the device-native sample rate because hardware route changes
// can otherwise interrupt or garble capture.
export const isIOS =
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

// Mic capture constraints. One per-user choice:
//   - voiceProcessingEnabled: echo cancel / noise suppress / auto gain.
// With voice processing ON we always capture stereo 2 channels — the browser's
// processing chain downmixes to (at most) 2 anyway, so a multichannel interface
// (e.g. a Zoom L12) behaves exactly like a plain 2-input card. With voice
// processing OFF we ask for the device's full channel count (`ideal: 32`, the
// browser clamps to what the device offers) so a multichannel interface exposes
// all its inputs; the caller then splits out the chosen input pair (1/2, 3/4,…).
// A normal 1/2-channel mic just returns 1/2 here, so nothing changes for it.
// On iOS we drop the sample-rate hint so WebKit can use the device-native rate
// (forcing a rate a route can't honour garbles capture); WebRTC/Opus negotiates
// its own rate regardless. The device is pinned with `exact` so the browser
// actually switches to the chosen mic — with `ideal` it may silently keep the
// current/default device, so picking another mic appeared to do nothing.
// Callers use getMicrophoneStream(), which falls back to the default device if
// the chosen one is gone (OverconstrainedError).
export function microphoneConstraints(
  deviceId: string,
  voiceProcessingEnabled: boolean,
): MediaTrackConstraints {
  return {
    channelCount: voiceProcessingEnabled ? 2 : { ideal: 32 },
    ...(isIOS ? {} : { sampleRate: 48000 }),
    echoCancellation: voiceProcessingEnabled,
    noiseSuppression: voiceProcessingEnabled,
    autoGainControl: voiceProcessingEnabled,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

// How many input channels a captured stream actually delivered. Used to decide
// whether to offer input-pair selection (>2 = multichannel interface). Falls
// back to 2 when the browser doesn't report a channelCount setting.
export function streamChannelCount(stream: MediaStream): number {
  const track = stream.getAudioTracks()[0];
  const count = track?.getSettings().channelCount;
  return typeof count === "number" && count > 0 ? count : 2;
}

// Acquire the microphone for the selected device. We pin the device with `exact`
// (see above) so the switch actually takes effect; if that device is
// gone/unavailable the browser rejects with OverconstrainedError, so we retry on
// the default device instead of failing the switch and silently keeping the old
// track.
export async function getMicrophoneStream(
  deviceId: string,
  voiceProcessingEnabled: boolean,
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: microphoneConstraints(deviceId, voiceProcessingEnabled),
    });
  } catch (err) {
    if (deviceId && err instanceof DOMException && err.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraints("", voiceProcessingEnabled),
      });
    }
    throw err;
  }
}
