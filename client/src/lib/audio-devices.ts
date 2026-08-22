// Speaker (output device) routing. All playback flows through an AudioContext
// (the shared session context in a call; the preview's own context in the
// lobby), so picking a speaker is AudioContext.setSinkId — no per-element
// sink juggling. Safari doesn't implement it; callers hide the picker when
// unsupported so users never see a dead control.

type SinkableContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

export function canSelectSpeaker(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

// Best-effort: a stale/unplugged device id rejects — fall back to the default
// output ("" per spec) instead of surfacing an error mid-call.
export function applySpeakerToContext(ctx: AudioContext, deviceId: string): void {
  const sinkable = ctx as SinkableContext;
  if (!sinkable.setSinkId) return;
  sinkable.setSinkId(deviceId).catch(() => {
    if (deviceId) sinkable.setSinkId!("").catch(() => {});
  });
}

// Routing ONE audio path to its own device (used for the network-monitor return,
// so it can play on a second card while the primary context stays on the main one)
// needs per-ELEMENT sinks: an <audio> fed by a MediaStreamAudioDestinationNode.
// HTMLMediaElement.setSinkId is the knob; Chrome/Edge have it, Safari doesn't.
export function canSelectElementSink(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}
