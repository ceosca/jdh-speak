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

// Resolve a saved device selection to a deviceId that ACTUALLY exists in the current
// device list — matching by id first, then by LABEL. Why the label fallback: browsers
// (especially for `audiooutput`) can hand the SAME physical device a DIFFERENT deviceId
// across a full close/reopen — the salted id isn't as stable as `audioinput`'s. Matching
// by id alone then fails and the picker silently falls back to "Default" even though the
// device is right there (Edu's "la placa primaria no se guarda"). So:
//   1. saved id still present  → keep it (heal: null).
//   2. else a device shares the saved LABEL → use its CURRENT id, and return it as `heal`
//      so the caller can persist the fresh id (next reopen matches by id again).
//   3. else → "" (Default), the device really is gone/unplugged.
// `heal` is set only when the resolved id DIFFERS from what was saved (rotated or relabelled),
// so the caller writes back just once. Pure + framework-free so it's unit-testable.
export interface ResolvedDevice {
  value: string; // the deviceId to show/use ("" = browser default)
  heal: string | null; // if non-null, persist this as the new saved id
}
export function resolveSavedDevice(
  savedId: string,
  savedLabel: string,
  devices: readonly MediaDeviceInfo[],
): ResolvedDevice {
  if (savedId && devices.some((d) => d.deviceId === savedId)) return { value: savedId, heal: null };
  if (savedLabel) {
    const byLabel = devices.find((d) => d.label && d.label === savedLabel);
    if (byLabel) return { value: byLabel.deviceId, heal: byLabel.deviceId };
  }
  return { value: "", heal: null };
}

// Routing ONE audio path to its own device (used for the network-monitor return,
// so it can play on a second card while the primary context stays on the main one)
// needs per-ELEMENT sinks: an <audio> fed by a MediaStreamAudioDestinationNode.
// HTMLMediaElement.setSinkId is the knob; Chrome/Edge have it, Safari doesn't.
export function canSelectElementSink(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}
