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
