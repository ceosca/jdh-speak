// iOS/iPadOS Safari (iPadOS now reports as "MacIntel" + touch). WebKit's audio
// stack should use the device-native sample rate because hardware route changes
// can otherwise interrupt or garble capture.
export const isIOS =
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

// Mic capture constraints. Two independent per-user choices:
//   - voiceProcessingEnabled: echo cancel / noise suppress / auto gain.
//   - hifiVoice: capture 2 channels for the opt-in stereo voice path. Off by
//     default, so the default voice path stays mono (matching the wire codec —
//     see `forceOpusParams` / the produce `opusStereo` flag). A mono mic is
//     unaffected either way; this only matters for a genuinely stereo source.
// On iOS we drop the sample-rate hint so WebKit can use the device-native rate
// (forcing a rate a route can't honour garbles capture); WebRTC/Opus negotiates
// its own rate regardless. The device is `ideal`, not `exact`, so a
// remembered-but-unplugged mic falls back to the default instead of failing.
export function microphoneConstraints(
  deviceId: string,
  voiceProcessingEnabled: boolean,
  hifiVoice: boolean,
): MediaTrackConstraints {
  return {
    channelCount: hifiVoice ? 2 : 1,
    ...(isIOS ? {} : { sampleRate: 48000 }),
    echoCancellation: voiceProcessingEnabled,
    noiseSuppression: voiceProcessingEnabled,
    autoGainControl: voiceProcessingEnabled,
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}
