import { useRef, useCallback, useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import type { Transport, Producer, Consumer } from "mediasoup-client/types";
import { forceOpusParams } from "../lib/sdp-munger";
import { applySpeakerToContext, canSelectElementSink } from "../lib/audio-devices";
import { isIOS, getMicrophoneStream } from "../lib/microphone";
import { playCue, preloadCueSamples, playTypingTick } from "../lib/sounds";
import { getIceServers } from "../lib/ice";
import { autoSeat, seatToPoint, type SpatialSeat } from "../lib/spatial";
import { ambienceName, ambienceIrUrl } from "../lib/ambience";
import { analyseImpulse, buildReverbImpulse, wetGainFor } from "../lib/ir-analysis";
import { parseClearKey, type Channel } from "../lib/tv";
import {
  setupJamReceiveBypass,
  setupGeneratorMonitor,
  generatorMonitorSupported,
  type GeneratorMonitorHandle,
} from "../lib/jam-neteq-bypass";
import { setupWtMonitor, wtMonitorSupported, type WtMonitorHandle } from "../lib/jam-wt-monitor";
import {
  setupWtMesh,
  wtMeshSupported,
  type WtMeshHandle,
  type JamBufferBounds,
} from "../lib/jam-wt-mesh";
import {
  flattenEpisodes,
  seasonsOf,
  episodeIndexAt,
  serieAudioSrc,
  loadProgress,
  saveProgress,
  type Serie,
  type Episode,
} from "../lib/serieteca";
import { formatMessage, RateLimiter, META_SEP, type ChatMessage } from "../lib/chat";
import { m } from "../paraglide/messages.js";
import {
  announce_chat_hint,
  announce_a_participant,
  announce_recording_on,
  announce_recording_off,
  announce_recording_unavailable,
  announce_recording_failed,
  announce_force_sfu_on,
  announce_force_sfu_off,
  announce_room_closed,
  announce_room_open,
  announce_room_entering,
  announce_room_no_admit,
  announce_jam_on,
  announce_jam_on_sfu,
  announce_jam_off,
  announce_jam_room_on,
  announce_jam_room_off,
  announce_net_monitor_on,
  announce_net_monitor_off,
  announce_net_monitor_forcing_sfu,
  announce_bitrate,
  announce_bitrate_original,
} from "../paraglide/messages.js";
import { useRoomStore, type RoomMode } from "../stores/room";
import type { PlayerRepeat } from "../stores/room";

interface ConsumeResult {
  ok: boolean;
  consumerId: string;
  producerId: string;
  kind: string;
  rtpParameters: Record<string, unknown>;
  error?: string;
}

interface PeerAudio {
  audioEl: HTMLAudioElement;
  gainNode: GainNode;
  sourceNode: MediaStreamAudioSourceNode;
  // Spatial audio: seats this peer at its own direction around the listener.
  // Always created, but only inserted into the chain while spatial audio is on
  // (see applySpatialLayout) — so toggling is a rewire, never a rebuild.
  panner: PannerNode;
  // Low-pass that dulls distant voices (air absorption) — in the chain only
  // while spatial audio is on, like the panner.
  airFilter: BiquadFilterNode;
  // SFU-only
  consumer?: Consumer;
  // Jam mode: when set, this peer's audio is decoded by us (WebCodecs) through a
  // minimal ring buffer instead of NetEQ (see setupJamReceiveBypass). teardown
  // restores the normal NetEQ path.
  jamBypass?: { teardown: () => void } | null;
}

// One of the two persistent file-audio slots. The source and xfadeGain are
// created once (createMediaElementSource may only be called once per element);
// only audioEl.src is swapped when loading a different track.
interface FileSlot {
  audioEl: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  xfadeGain: GainNode;
  // Per-load AbortController so ended/error handlers from a previous load are
  // revoked cleanly when the slot is reused for a new track.
  abortCtrl: AbortController | null;
  // The object URL for the current track (if any); revoked on next load.
  objectUrl: string | null;
}

// ICE servers come from the server's .env at runtime (see lib/ice.ts and
// docs/turn-server.md) — no third-party TURN or credentials in this repo.
// STUN is tried first, so most P2P connections never hit the relay; TURN only
// kicks in for symmetric NATs and restrictive corporate/hotel networks. TURN
// credentials are visible to clients by design (WebRTC needs them in the
// browser); coturn's denied-peer-ip rules limit the blast radius.

// Shared AudioContext — single output buffer for all peers (lower latency than
// one per peer). On iOS we let it adopt the device-native rate instead of pinning
// 48 kHz, so WebKit doesn't resample/fight the hardware on every route change;
// other browsers honour the pin cleanly.
const sharedAudioContext = new AudioContext({
  ...(isIOS ? {} : { sampleRate: 48000 }),
  latencyHint: "interactive",
});

// Master output bus. Every peer pipeline connects here instead of straight to the
// context destination, so ONE node decides how the whole mix reaches the speaker:
//  - normal: masterBus → context.destination (Chrome's AudioContext output, measured
//    ~42 ms on Windows/WASAPI-shared with USB devices — playbackStats confirmed).
//  - jam: masterBus → MediaStreamAudioDestinationNode → <audio> element, which uses
//    Chrome's MEDIA output path (~23 ms measured via WebRTC's media-playout stat).
//    That ~19 ms is the browser's accessible slice of the WASAPI bottleneck — the
//    same "lower the output buffer" Jamulus gets from ASIO, minus what the sandbox
//    won't give (exclusive mode / IAudioClient3, which USB devices can't use anyway).
// Fail-safe: if per-element sinks aren't supported (Safari/Firefox), stays on the
// plain destination, so nothing breaks.
const masterBus = sharedAudioContext.createGain();
masterBus.connect(sharedAudioContext.destination);
let jamOutEl: HTMLAudioElement | null = null;
let jamOutDest: MediaStreamAudioDestinationNode | null = null;
function routeMasterOutput(jam: boolean, speakerDeviceId: string) {
  try {
    masterBus.disconnect();
  } catch {
    /* not connected */
  }
  if (jam && canSelectElementSink()) {
    if (!jamOutDest) jamOutDest = sharedAudioContext.createMediaStreamDestination();
    masterBus.connect(jamOutDest);
    if (!jamOutEl) {
      jamOutEl = new Audio();
      jamOutEl.autoplay = true;
      (jamOutEl as unknown as Record<string, boolean>).playsInline = true;
    }
    jamOutEl.srcObject = jamOutDest.stream;
    (jamOutEl as unknown as { setSinkId: (s: string) => Promise<void> })
      .setSinkId(speakerDeviceId || "")
      .catch(() => {});
    jamOutEl.play().catch(() => {});
  } else {
    masterBus.connect(sharedAudioContext.destination);
    if (jamOutEl) {
      try {
        jamOutEl.pause();
        jamOutEl.srcObject = null;
      } catch {
        /* gone */
      }
    }
  }
}

// Probe once for any operator-provided cue samples (/sounds/<cue>.<ext>) so the
// first join/leave already uses them; cues with no file fall back to the synth.
preloadCueSamples(sharedAudioContext);

// setTargetAtTime time-constant (seconds) for per-peer gain ramps. Smaller = snappier.
const GAIN_RAMP = 0.03;

// Rapid mute toggling would otherwise announce + chime on every single
// flip — mute 10× and everyone hears/reads it 10×. Coalesce a burst: surface the
// FIRST change immediately (leading edge, so a deliberate single toggle still
// gives instant feedback), suppress the middle, then surface the final settled
// state once more after TOGGLE_DEDUP_MS of quiet — and only if it actually
// differs from what was last surfaced. So a mash shows at most the first + last.
const TOGGLE_DEDUP_MS = 1000;

// Soft limiter sitting after the outgoing mic gain so boosting a quiet/cheap
// mic doesn't clip: transparent until peaks approaching 0 dBFS, then ~20:1 with a
// fast attack. Adds ~5 ms of look-ahead latency, negligible for voice.
const MIC_LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 };

// Crossfade duration (in setTargetAtTime time-constant seconds). ~3 s total
// perceived fade because setTargetAtTime reaches 63 % at one τ; the remainder
// fades exponentially. This value gives a clean, perceptible 3-second cross.
const XFADE_TAU = 1.0;

// Keep the shared context running. iOS needs a user gesture to start it, and it
// also drops to "suspended" or the WebKit-only "interrupted" state whenever the
// audio route changes / the tab backgrounds — and without re-resuming, audio dies
// until a reload (this is what "keeps fucking up" mid-call). So we resume on the
// first AND every gesture, on each statechange, and when the tab refocuses.
function resumeSharedContext() {
  const state = sharedAudioContext.state as string;
  if (state === "suspended" || state === "interrupted") {
    // iOS rejects resume() while still interrupted (e.g. mid phone call); the
    // statechange/visibility/gesture retries pick it up once it's allowed again.
    sharedAudioContext.resume().catch(() => {});
  }
}
document.addEventListener("touchstart", resumeSharedContext);
document.addEventListener("click", resumeSharedContext);
sharedAudioContext.addEventListener("statechange", resumeSharedContext);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeSharedContext();
});

// Audio file extensions accepted by the folder-playlist picker.
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac", "m4b"]);

// Cap a P2P sender's outgoing bitrate directly on the encoder via setParameters
// (Chrome ignores SDP bitrate caps for the P2P audio sender). 128+ = original
// (remove the cap).
// Jitter-buffer floor (seconds) for received audio, via each track's
// playoutDelayHint. Was 0 (minimum latency, but no cushion), which drops audio
// on the slightest packet reordering / variable delay — the "choppy at times" on
// an otherwise-working P2P link between two peers. A small floor lets the
// browser's adaptive buffer (NetEQ) absorb those short jitter bursts. Receiver
// side only, applied to BOTH P2P and SFU received tracks. Tunable.
const JITTER_BUFFER_HINT = 0.05;
// Jam receive cushion (seconds). NOT 0: the mesh is gone, so jam now plays through NetEQ
// like normal mode, and a 0 target makes NetEQ choppy on the slightest reordering (see
// JITTER_BUFFER_HINT note). 30 ms is a real cushion (clean) but below normal's 50 ms, so
// jam is still tighter than normal — clean AND lower latency, on the standard path.
const JAM_JITTER_HINT = 0.03;

// Set the receiver-side jitter buffer target. `jitterBufferTarget` (RTCRtpReceiver,
// Chrome 124+) is the modern, spec'd successor to the non-standard track
// `playoutDelayHint` — and crucially Chrome now *honours it* while increasingly
// ignoring the old hint. In jam mode we ask for 0 (minimum the UA allows) so the
// return is heard as early as the network permits; otherwise the small floor
// (ms) matching JITTER_BUFFER_HINT. We set BOTH APIs at each receive site: the
// new one for Chrome 124+, the old hint as a fallback for anything older/Firefox.
// Wrapped in try/catch because the setter throws RangeError outside [0, 4000] and
// isn't present on every engine.
function setReceiverJitterTarget(receiver: RTCRtpReceiver | undefined, jam: boolean) {
  if (!receiver || !("jitterBufferTarget" in receiver)) return;
  try {
    (receiver as unknown as Record<string, number | null>).jitterBufferTarget = jam
      ? JAM_JITTER_HINT * 1000
      : JITTER_BUFFER_HINT * 1000;
  } catch {
    /* unsupported value/engine — the playoutDelayHint fallback still applies */
  }
}

async function setSenderMaxBitrate(
  sender: RTCRtpSender | null | undefined,
  kbps: number,
): Promise<void> {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    const max = kbps >= 128 ? undefined : kbps * 1000;
    for (const enc of params.encodings) {
      if (max === undefined) delete enc.maxBitrate;
      else enc.maxBitrate = max;
    }
    await sender.setParameters(params);
  } catch (err) {
    console.error("[bitrate] setParameters failed:", err);
  }
}

function createAudioPipeline(track: MediaStreamTrack): Omit<PeerAudio, "consumer"> {
  const stream = new MediaStream([track]);
  const audioEl = new Audio();
  audioEl.srcObject = stream;
  audioEl.autoplay = true;
  // iOS Safari requires webkit attributes
  (audioEl as unknown as Record<string, boolean>).playsInline = true;
  (audioEl as unknown as Record<string, string>).webkitPlaysinline = "true";
  // Mute the HTML element — audio is routed through the shared AudioContext.
  // NOTE: iOS Safari ignores `volume = 0` on media elements (volume is hardware-
  // controlled there), so the element would play at full volume ALONGSIDE the
  // Web Audio graph → doubled/"chorus" audio on iOS. `muted` IS honoured on iOS,
  // so it actually silences the element, leaving the AudioContext as the single
  // playback path (and preserving per-peer gain/ducking).
  audioEl.volume = 0;
  audioEl.muted = true;

  resumeSharedContext();

  const sourceNode = sharedAudioContext.createMediaStreamSource(stream);
  const gainNode = sharedAudioContext.createGain();
  gainNode.gain.value = 1;
  sourceNode.connect(gainNode);

  const panner = sharedAudioContext.createPanner();
  panner.panningModel = "HRTF";
  // Direction only: rolloffFactor 0 means the seat's DISTANCE from the listener
  // never changes loudness — walking around the floor only changes WHERE a voice
  // sounds, never how loud (distance-as-volume was intentionally removed).
  panner.rolloffFactor = 0;

  // Kept as a transparent pass-through so the wiring (and the self-monitor chain)
  // stay identical; it no longer dulls by distance.
  const airFilter = sharedAudioContext.createBiquadFilter();
  airFilter.type = "lowpass";
  airFilter.frequency.value = 22000;
  airFilter.Q.value = 0.7;

  // Start non-spatial; applySpatialLayout inserts the panner when it's enabled.
  // Output goes to the master bus (which routes to the plain or low-latency sink).
  gainNode.connect(masterBus);

  return { audioEl, gainNode, sourceNode, panner, airFilter };
}

// ⚠️ Jam PEER audio path (2026-08-27). CONFIRMED LIVE: the custom low-latency playout —
// the WT mesh (Opus 2.5 ms → our jitter buffer → MediaStreamTrackGenerator) AND the
// NetEQ bypass (encodedInsertableStreams tap) — produces audible crackling/clipping for
// EVERYONE, on every machine (not laptops, not one bad network). Meanwhile the standard
// mediasoup/WebRTC/NetEQ path (what "modo normal" uses) is clean. So jam now plays peers
// through that SAME clean NetEQ path, keeping only the SAFE latency tuning
// (jitterBufferTarget=0 + the send-side ptime/FEC/priority). The custom pipeline is a
// nice idea that didn't deliver clean audio — parked behind these flags. Do NOT flip
// them back on without fixing the underlying crackle first.
const JAM_WT_MESH = false; // WT peer mesh playout
const JAM_NETEQ_BYPASS = false; // encoded-transform NetEQ bypass
// Raw-mic send (skip the outgoing soft limiter for ~6 ms less latency). OFF: it shipped a
// CLIPPING signal for a hot mic/instrument — the "clipeando" everyone heard. Jam now sends
// the limited track like normal mode; clean beats the 6 ms.
const JAM_RAW_SEND = false;

// Does this browser expose the Encoded Transform tap we use to bypass NetEQ?
// Chrome/Edge yes; Safari/Firefox no → they just use NetEQ (no bypass, no harm).
const SUPPORTS_INSERTABLE_STREAMS =
  typeof RTCRtpReceiver !== "undefined" &&
  "createEncodedStreams" in (RTCRtpReceiver.prototype as object);

// Tap an SFU consumer's encoded stream. `tap` MUST be true iff the recv PC was
// created with encodedInsertableStreams — because when it was, Chrome routes every
// frame through the tap and an UNtapped consumer is silent (that was the outage).
// So on a flagged transport we tap EVERY consumer: `bypass` ones decode through our
// minimal ring (low latency), the rest just passthrough to NetEQ. Channels come
// from the negotiated codec so decode never guesses. Always safe: any failure
// returns null and the normal pipeline plays.
async function tapConsumer(
  consumer: Consumer,
  gainNode: GainNode,
  tap: boolean,
  bypass: boolean,
): Promise<{ teardown: () => void } | null> {
  if (!tap) return null;
  const receiver = consumer.rtpReceiver;
  if (!receiver) return null;
  const channels =
    (consumer.rtpParameters.codecs?.[0] as { channels?: number } | undefined)?.channels ?? 1;
  try {
    return await setupJamReceiveBypass(receiver, gainNode, sharedAudioContext, channels, bypass);
  } catch {
    return null;
  }
}

// Cached /api/wt-probe result (the embedded QUIC echo relay's URL + self-signed
// cert hash) for the WebTransport 2.5 ms monitor. Fetched once per session.
let wtProbeInfoCache: {
  enabled: boolean;
  url: string | null;
  jamUrl?: string | null;
  certHash: { value: number[] } | null;
} | null = null;
async function fetchWtProbeInfo() {
  if (wtProbeInfoCache) return wtProbeInfoCache;
  try {
    const r = await fetch("/api/wt-probe");
    wtProbeInfoCache = await r.json();
  } catch {
    wtProbeInfoCache = { enabled: false, url: null, certHash: null };
  }
  return wtProbeInfoCache!;
}

function destroyAudioPipeline(pa: PeerAudio) {
  // Restore NetEQ + free the decoder/worker BEFORE closing the consumer.
  pa.jamBypass?.teardown();
  pa.consumer?.close();
  pa.audioEl.srcObject = null;
  pa.audioEl.pause();
  pa.sourceNode.disconnect();
  pa.gainNode.disconnect();
  pa.panner.disconnect();
  pa.airFilter.disconnect();
}

// --- Spatial audio ----------------------------------------------------------
// Seats each participant somewhere on the sphere around you (left/right,
// front/back, up/down, near/far), so you can tell WHO is talking by WHERE they
// sound — and two people talking at once stay separable (the cocktail-party
// effect) instead of mushing together. Seats are ROOM-WIDE: everyone hears a
// given person from the same place. Geometry lives in lib/spatial.ts.
//
// (Re)wire every peer for the current setting and re-apply the seats. Called
// whenever the toggle flips, a seat moves, or the participant set changes.
//
// Music casters are deliberately EXCLUDED: HRTF collapses its input to a single
// point, which would destroy the stereo image of hi-fi music. They stay centred
// and full-stereo, which is the whole point of the music path.
function applySpatialLayout(
  peerAudios: Map<string, PeerAudio>,
  enabled: boolean,
  // When on, EVERY participant is seated on the even spread, ignoring their
  // configured seat (which is kept elsewhere, so turning it off restores it).
  autoAll: boolean,
  isMusic: (peerId: string) => boolean,
  // True while a peer is streaming audio (file/URL/TV/series/share). Their track
  // carries music mixed into their voice, so it stays CENTRED (never panned) —
  // music shouldn't move around the room with the person, like a music caster.
  isStreaming: (peerId: string) => boolean,
  nameOf: (peerId: string) => string,
  // Room-wide seat overrides keyed by displayName. An explicit seat (from the
  // Ctrl+Alt+U panel, shared by everyone) wins unless auto-all is on.
  positions: Record<string, SpatialSeat>,
  // The even-spread seat for a display name — computed over the whole room's
  // participant list, so it's the same on every client.
  autoSeatOf: (name: string) => SpatialSeat,
  // The shared ambience reverb send bus — every peer taps into it so their
  // voice/music is heard "in" the room's space (dry until an ambience is picked).
  reverbSend: AudioNode | null,
) {
  for (const [peerId, pa] of peerAudios) {
    const spatial = enabled && !isMusic(peerId) && !isStreaming(peerId);
    if (spatial) {
      const name = nameOf(peerId);
      const seat = autoAll ? autoSeatOf(name) : (positions[name] ?? autoSeatOf(name));
      const { x, y, z } = seatToPoint(seat);
      pa.panner.positionX.value = x;
      pa.panner.positionY.value = y;
      pa.panner.positionZ.value = z;
    }
    // Rewire the DRY path: gain → [airFilter → panner] → destination. gain feeds
    // only the output + the reverb send, both re-added here after the wholesale
    // disconnect.
    pa.gainNode.disconnect();
    pa.panner.disconnect();
    pa.airFilter.disconnect();
    if (spatial) {
      pa.gainNode.connect(pa.airFilter);
      pa.airFilter.connect(pa.panner);
      pa.panner.connect(masterBus);
    } else {
      pa.gainNode.connect(masterBus);
    }
    // Wet send (survives the disconnect above): tapped post-volume/deafen, so a
    // quieted or deafened peer contributes nothing to the reverb either.
    if (reverbSend) pa.gainNode.connect(reverbSend);
  }
}

export function useMediasoup() {
  const socketRef = useRef<Socket | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  // Whether the current recv transport's PC was created with encodedInsertableStreams
  // (jam room + Chrome). When true, EVERY consumer on it must be tapped (bypass or
  // passthrough) or it goes silent — see tapConsumer.
  const recvInsertableRef = useRef(false);
  const producerRef = useRef<Producer | null>(null);
  // Network-monitor self-consumer (our own producer returned via the server, as
  // a Jamulus-style timing reference). SFU-only; keyed by the producer id it
  // follows so a re-produce re-establishes it.
  const netMonitorRef = useRef<
    | (ReturnType<typeof createAudioPipeline> & {
        consumer?: Consumer;
        producerId?: string;
        jamBypass?: { teardown: () => void } | null;
        // Optional dedicated output: when the user picks a second card for the
        // return, its gain feeds this MediaStreamDestination → <audio> (setSinkId)
        // instead of the shared context's primary output.
        monitorDest?: MediaStreamAudioDestinationNode;
        monitorEl?: HTMLAudioElement;
      })
    | null
  >(null);
  // Alternative monitor playout: our WebCodecs decode written to a
  // MediaStreamTrackGenerator → <audio> (WebRTC's ~23ms output instead of the
  // AudioContext graph's ~42ms). Used for the network monitor in jam on Chrome/Edge;
  // mutually exclusive with netMonitorRef (createEncodedStreams is once-per-receiver).
  const netMonitorGenRef = useRef<{
    gen: GeneratorMonitorHandle;
    consumer: Consumer;
    producerId: string;
  } | null>(null);
  // WebTransport 2.5 ms monitor (Jamulus-frame-size self-return over QUIC, bypassing
  // WebRTC's audio path). Mutually exclusive with the two refs above.
  const netMonitorWtRef = useRef<{ handle: WtMonitorHandle; producerId: string } | null>(null);
  // Jam PEER mesh over WebTransport (2.5 ms frames, routed between clients). While
  // it's up, masterBus is muted so the mediasoup peer audio doesn't double it.
  const wtMeshRef = useRef<WtMeshHandle | null>(null);
  // Live jitter-buffer bounds (ms) for every jam playout path — a SHARED object the
  // sliders mutate in place, so the running buffers pick up new min/max without a
  // rebuild. Seeded from the persisted store values.
  const jamBoundsRef = useRef<JamBufferBounds>({
    minMs: useRoomStore.getState().jamBufferMinMs,
    maxMs: useRoomStore.getState().jamBufferMaxMs,
  });
  const peerAudiosRef = useRef<Map<string, PeerAudio>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  // True when we joined WITHOUT a microphone (opted out, or none available /
  // permission denied) — we listen and use text chat only. The outgoing track is
  // always outDest's (silent with no mic connected), so producing/adding it
  // still works; we just never acquire a mic and stay muted. Persists across
  // reconnects so a rejoin doesn't re-prompt.
  const noMicRef = useRef(false);
  // Current room voice bitrate in kbps (128 = original). Re-applied to new
  // senders on (re)produce / new P2P connection so they match the room.
  const roomBitrateRef = useRef(128);
  // P2P
  const p2pConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Remote ICE candidates that arrived before their peer connection had a
  // remote description (or before it existed at all) — applied after
  // setRemoteDescription instead of being dropped (addIceCandidate throws
  // without a remote description, and a lost host candidate can stall ICE).
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  // Monotonic per-peer offer counter: a queued offer handler bails when a
  // newer offer from the same peer arrived while it waited in the transition
  // chain — answering the superseded one would consume the newer session's
  // queued candidates and build a dead connection.
  const offerSeqRef = useRef<Map<string, number>>(new Map());
  const modeRef = useRef<RoomMode>("p2p");
  // Producers announced while the SFU transports were still being built —
  // consumed at the end of setupSfu instead of being silently dropped.
  const pendingProducersRef = useRef<Array<{ peerId: string; producerId: string; source: string }>>(
    [],
  );
  // P2P↔SFU transitions (and reconnect rebuilds) are serialized through this
  // promise chain so an in-flight transition always finishes tearing down /
  // building up before the next starts — overlapping async handlers could
  // otherwise re-add stale connections after a newer teardown already ran.
  const transitionChainRef = useRef<Promise<void>>(Promise.resolve());
  // Outgoing audio graph: mic → micGain → limiter → outDest → outgoing track.
  // The track added to peers / produced to the SFU is always outDest's, so the
  // mic slider just rides `micGain` and shared system audio is mixed straight
  // into `outDest` (bypassing the gain/limiter so the music keeps its dynamics).
  const outGraphRef = useRef<{
    micSource: MediaStreamAudioSourceNode | null;
    micGain: GainNode;
    limiter: DynamicsCompressorNode;
    outDest: MediaStreamAudioDestinationNode;
    displaySource: MediaStreamAudioSourceNode | null;
    // Two persistent file slots feed the shared fileVolumeGain → outDest chain.
    // The file mixes directly into the voice track (no separate producer).
    // The active slot's xfadeGain is 1; the idle slot's is 0.
    // (createMediaElementSource may only be called once per element — the slots
    // are created lazily and reused; only .src is swapped per load.)
    fileSlots: [FileSlot, FileSlot] | null;
    activeSlot: 0 | 1;
    // Source-side volume gain for the file stream on the SENT path. Inserted
    // before outDest so lowering it quiets the file for ALL listeners.
    // The local monitor (source → sharedAudioContext.destination) bypasses this
    // and stays at full volume. Null until the file path is first started.
    fileVolumeGain: GainNode | null;
    micStream: MediaStream | null;
    // Self-monitor spatialisation (see applyMicMonitor).
    monitorAir: BiquadFilterNode;
    monitorPanner: PannerNode;
    // Secondary input device: captured stereo + no voice-processing, mixed
    // directly into outDest alongside the mic chain.
    secondarySource: MediaStreamAudioSourceNode | null;
    secondaryGain: GainNode | null;
    secondaryStream: MediaStream | null;
    // Room ambience (reverb): everything speaker-bound sends into reverbInput →
    // convolver → reverbWet → destination. reverbWet is 0 (dry) until an ambience
    // is picked. See applyAmbience.
    reverbInput: GainNode;
    reverbConvolver: ConvolverNode;
    reverbWet: GainNode;
  } | null>(null);
  // Audio share (system / tab audio mixed into the voice track via outDest)
  const displayStreamRef = useRef<MediaStream | null>(null);
  // Local anti-spam guard for instant "thunk" feedback (the server enforces the
  // same 5-per-10s budget authoritatively).
  const chatLimiterRef = useRef(new RateLimiter());
  // Precomputed shuffled play order for the current playlist. Rebuilt whenever
  // the playlist is set or shuffle is toggled. Each entry is a playlist index.
  const shuffleOrderRef = useRef<number[]>([]);
  // Live-TV playback (Shaka + a dedicated <audio>, routed through fileVolumeGain).
  // createMediaElementSource is one-shot per element, so element + source are made
  // once and reused; only the Shaka player's loaded content changes per channel.
  const tvAudioRef = useRef<HTMLAudioElement | null>(null);
  const tvSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  // Loosely typed: the shaka.Player instance (lazy-loaded).
  const tvPlayerRef = useRef<{
    configure(c: unknown): void;
    load(u: string): Promise<void>;
    unload(): Promise<void>;
  } | null>(null);
  // True while a TV channel is the current streamer source. TV audio is a live
  // Shaka stream, not a file slot, so it can't cross-fade — startFileSource and
  // startPlaylist check this and force a clean stopFileStream first instead of
  // taking the crossfade branch (which would leave TV running alongside the
  // new source).
  const tvActiveRef = useRef(false);
  // Series playback: a dedicated <audio> whose src is the same-origin
  // /api/audio-proxy (the .m4b lacks CORS), routed through fileVolumeGain like TV.
  // createMediaElementSource is one-shot per element, so element + source persist.
  const serieAudioRef = useRef<HTMLAudioElement | null>(null);
  const serieSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const serieActiveRef = useRef(false);
  const serieEpisodesRef = useRef<Episode[]>([]);
  const serieIndexRef = useRef(0);
  const serieNameRef = useRef<string | null>(null);
  const serieProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable ref so that ended handlers can call playTrack without a stale closure.
  // Updated synchronously every render after playTrack is defined.
  const playTrackRef = useRef<((index: number) => Promise<void>) | null>(null);
  // Per-slot generation counter for stale fade-pause cancellation. Each entry
  // is incremented before scheduling a fade-pause on that slot. A scheduled
  // timeout checks that the captured generation still matches before pausing,
  // so a rapid skip (which increments the counter) makes the old timer a no-op.
  // Indexed by slot index (0 or 1). Also holds the pending timer IDs so they
  // can be cancelled on teardown.
  const fadeGenRef = useRef<[number, number]>([0, 0]);
  const fadeTimerRef = useRef<[number | null, number | null]>([null, null]);
  // The first received chat message carries a one-time hint that Alt+1..0
  // reads recent messages aloud even with the chat panel closed.
  const chatHintGivenRef = useRef(false);
  // Last time we emitted a chat typing tick, to throttle key repeat (see below).
  const lastTypingTickRef = useRef(0);
  const store = useRoomStore;
  // One tick per keystroke while composing chat: play it here (so the typist
  // hears their own rhythm) and send it to the room. Throttled so a held key
  // can't machine-gun; the server enforces the same floor authoritatively.
  const typingTick = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingTickRef.current < 40) return;
    lastTypingTickRef.current = now;
    playTypingTick(sharedAudioContext);
    socketRef.current?.emit("typing-tick");
  }, []);

  // Queue `fn` behind any in-flight mode transition. The chain itself never
  // breaks (failures are surfaced to the caller's promise, then swallowed for
  // the next link), so one failed transition can't wedge all later ones.
  const runTransition = useCallback(<T>(fn: () => Promise<T>): Promise<T> => {
    const run = transitionChainRef.current.then(fn);
    transitionChainRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  const emit = useCallback(
    <T>(event: string, data?: unknown): Promise<T> =>
      new Promise((resolve, reject) => {
        const socket = socketRef.current;
        if (!socket) return reject(new Error("No socket"));
        // The timeout matters beyond slow servers: if the socket drops while
        // an ack is pending, socket.io NEVER invokes the callback — an
        // un-timed-out emit inside a queued transition would leave the
        // transition chain pending forever and block the reconnect rejoin.
        socket
          .timeout(10_000)
          .emit(event, data, (err: Error | null, res: T & { ok: boolean; error?: string }) => {
            if (err) return reject(err);
            if (res.ok) resolve(res);
            else reject(new Error(res.error || "Unknown error"));
          });
      }),
    [],
  );

  // The gain a peer's audio should currently play at: the listener's per-peer
  // volume, zeroed while deafened.
  // Nudge ("zumbido"): buzz the whole room, MSN-style. Played locally right away
  // so the sender gets instant feedback, then broadcast by the server. If the
  // server refuses (throttled), the "thunk" cue + an announcement say so — the
  // same feedback a rate-limited chat message gets.
  const sendNudge = useCallback(async () => {
    playCue(sharedAudioContext, "zumbido");
    try {
      await emit("nudge");
    } catch {
      playCue(sharedAudioContext, "thunk");
      store.getState().announce(m.nudge_too_soon());
    }
  }, [emit, store]);

  const effectiveGain = useCallback(
    (peerId: string): number => {
      const state = store.getState();
      const peer = state.peers.get(peerId);
      if (!peer || state.isDeafened) return 0;
      return peer.volume;
    },
    [store],
  );

  // Per-key state for the toggle coalescer (see TOGGLE_DEDUP_MS): a debounce
  // timer, the value we last surfaced, and the latest pending value + emitter.
  const surfaceRef = useRef<
    Map<
      string,
      {
        timer: number | null;
        lastEmitted: boolean | undefined;
        latestValue: boolean;
        latestEmit: () => void;
      }
    >
  >(new Map());

  // Coalesce a rapid run of boolean-state toggles (mute, ducking, …) into at
  // most a leading + a trailing announcement. `emit` does the actual
  // announce/chime for THIS change; it runs immediately on the first change of a
  // burst, and again when the burst settles iff the final value differs from the
  // last surfaced one. The underlying effect (mute/gain) is applied by the
  // caller BEFORE this — only the user-facing surfacing is debounced.
  const surfaceToggle = useCallback((key: string, value: boolean, emit: () => void) => {
    const map = surfaceRef.current;
    const s = map.get(key) ?? {
      timer: null,
      lastEmitted: undefined as boolean | undefined,
      latestValue: value,
      latestEmit: emit,
    };
    s.latestValue = value;
    s.latestEmit = emit;
    // Leading edge: nothing pending and this is a genuine change → surface now.
    if (s.timer === null && value !== s.lastEmitted) {
      s.lastEmitted = value;
      emit();
    }
    if (s.timer !== null) clearTimeout(s.timer);
    s.timer = window.setTimeout(() => {
      s.timer = null;
      if (s.latestValue !== s.lastEmitted) {
        s.lastEmitted = s.latestValue;
        s.latestEmit();
      }
    }, TOGGLE_DEDUP_MS);
    map.set(key, s);
  }, []);

  // The even-spread seat for a display name, computed over the WHOLE room's
  // participant list (me + non-music peers, sorted by name) — so the automatic
  // seating (and the "auto-position everyone" mode) is identical on every
  // client, and each voice keeps its spot as others come and go.
  const spatialAutoSeatOf = useCallback(() => {
    const state = store.getState();
    const names = new Set<string>();
    if (state.displayName) names.add(state.displayName);
    for (const p of state.peers.values()) if (!p.isMusic) names.add(p.displayName);
    const sorted = [...names].sort();
    return (name: string): SpatialSeat =>
      autoSeat(Math.max(0, sorted.indexOf(name)), sorted.length || 1);
  }, [store]);

  // Re-seat everyone for the current spatial setting. Called when the toggle
  // flips and whenever the participant set changes (so seats stay spread out).
  const refreshSpatial = useCallback(() => {
    const state = store.getState();
    applySpatialLayout(
      peerAudiosRef.current,
      state.spatialAudio,
      state.spatialAutoAll,
      (peerId) => !!state.peers.get(peerId)?.isMusic,
      (peerId) => !!state.peers.get(peerId)?.isStreaming,
      (peerId) => state.peers.get(peerId)?.displayName ?? "",
      state.spatialPositions,
      spatialAutoSeatOf(),
      outGraphRef.current?.reverbInput ?? null,
    );
  }, [store, spatialAutoSeatOf]);

  // Decoded real-space impulse responses, cached by preset id after the first
  // fetch. `null` marks a load that failed, so we don't retry it every time.
  const irCacheRef = useRef<Map<string, AudioBuffer | null>>(new Map());
  // Prepared reverb impulses: direct removed + unit-energy normalised, with the
  // wet gain derived from the file's own measurements (see lib/ir-analysis).
  const irPreparedRef = useRef<Map<string, { buffer: AudioBuffer; gain: number }>>(new Map());
  const loadIr = useCallback(async (id: string, url: string): Promise<AudioBuffer | null> => {
    const cache = irCacheRef.current;
    if (cache.has(id)) return cache.get(id) ?? null;
    try {
      const res = await fetch(url);
      const buf = await sharedAudioContext.decodeAudioData(await res.arrayBuffer());
      cache.set(id, buf);
      return buf;
    } catch {
      cache.set(id, null);
      return null;
    }
  }, []);

  // Load the room's chosen ambience into the shared reverb and ramp the wet
  // return. Every ambience is a recorded impulse (genuine convolution of a real
  // space): built-ins bundled at /ir/<id>.ogg, extras streamed from the server's
  // IR folder (see ambienceIrUrl). "seco"/unknown = fully dry.
  const applyAmbience = useCallback(async () => {
    const g = outGraphRef.current;
    if (!g) return;
    const id = store.getState().ambience;
    const url = ambienceIrUrl(id, store.getState().serverAmbiences);
    const now = sharedAudioContext.currentTime;
    if (!url) {
      g.reverbWet.gain.setTargetAtTime(0, now, 0.05);
      return;
    }
    const buffer = await loadIr(id, url);
    // The room may have changed ambience while the IR was loading — only apply
    // if this is still the current one.
    if (store.getState().ambience !== id) return;
    if (!buffer) {
      // Impulse missing/failed to load → stay dry (no synthetic fallback).
      g.reverbWet.gain.setTargetAtTime(0, sharedAudioContext.currentTime, 0.05);
      return;
    }
    // Measure THIS impulse and derive its wet level from the file itself
    // (ISO 3382-1 metrics — see lib/ir-analysis.ts). Replaces the single
    // hand-tuned constant that every space used to share: across this library
    // the measured DRR spans ~34 dB, i.e. spaces whose natural reverberation
    // differs by ~50x were all getting the same dose, which is why small rooms
    // sounded artificial. Cached per impulse, so it's computed once.
    let prepared = irPreparedRef.current.get(id);
    if (!prepared) {
      const analysis = analyseImpulse(buffer);
      const { gain, source } = wetGainFor(analysis);
      prepared = { buffer: buildReverbImpulse(sharedAudioContext, buffer, analysis), gain };
      irPreparedRef.current.set(id, prepared);
      console.log(
        `[ambience] ${id}: RT60=${analysis.rt60?.toFixed(2) ?? "—"}s ` +
          `DRR=${analysis.drr?.toFixed(1) ?? "—"}dB C50=${analysis.c50?.toFixed(1) ?? "—"}dB ` +
          `SNR=${analysis.snr.toFixed(0)}dB fit=${analysis.decayFit.toFixed(3)} ` +
          `→ wet=${gain.toFixed(3)} (via ${source})`,
      );
    }
    // normalize=false: the impulse is normalised to unit energy by
    // buildReverbImpulse, which is what makes the derived gain exact. Leaving
    // the browser's own normalisation on would rescale by an unknown factor and
    // put the guesswork straight back in.
    g.reverbConvolver.normalize = false;
    g.reverbConvolver.buffer = prepared.buffer;
    g.reverbWet.gain.setTargetAtTime(prepared.gain, sharedAudioContext.currentTime, 0.05);
  }, [store, loadIr]);

  // Pick the room's ambience (Ctrl+Alt+A panel). Server-owned and broadcast:
  // every client applies it from the `ambience` handler.
  const setAmbience = useCallback((id: string) => {
    socketRef.current?.emit("set-ambience", { id });
  }, []);

  // Move a participant's seat in the room's 3D field. Room-wide: the server
  // stores it (by display name) and broadcasts to everyone, so a person sounds
  // like they're in the same place for ALL listeners. Called live while dragging
  // the slider in the hidden Ctrl+Alt+U panel.
  const setSpatialPosition = useCallback((name: string, seat: SpatialSeat) => {
    socketRef.current?.emit("set-spatial-position", { name, ...seat });
  }, []);

  // Toggle spatial audio (Ctrl+Alt+E) for the WHOLE room. Like the bitrate
  // shortcut, whoever presses it flips it for everyone: the server stores it and
  // broadcasts, and every client (including this one) applies it from the
  // `spatial-enabled` handler — so there's no local-only state to drift.
  const toggleSpatialAudio = useCallback(() => {
    socketRef.current?.emit("set-spatial-enabled", { enabled: !store.getState().spatialAudio });
  }, [store]);

  // Turn "auto-position everyone" on/off for the WHOLE room (the panel checkbox).
  // Server-owned and broadcast, like the spatial toggle: every client applies it
  // from the `spatial-auto` handler.
  const setSpatialAutoAll = useCallback((enabled: boolean) => {
    socketRef.current?.emit("set-spatial-auto", { enabled });
  }, []);

  // --- Shared: clean up all peer audio ---
  const cleanupAllPeerAudio = useCallback(() => {
    for (const pa of peerAudiosRef.current.values()) {
      destroyAudioPipeline(pa);
    }
    peerAudiosRef.current.clear();
  }, []);

  // --- Outgoing audio graph (mic gain + soft limiter, + optional shared audio) ---
  // Built lazily and reused for the whole session. The produced/added track is
  // always `outDest`'s, so we never have to swap tracks on senders/producer.
  const ensureOutGraph = useCallback(() => {
    if (outGraphRef.current) return outGraphRef.current;
    // The mic now flows through the shared context, so it must be running
    // (it starts suspended on iOS until a user gesture).
    resumeSharedContext();
    const ctx = sharedAudioContext;
    const micGain = ctx.createGain();
    micGain.gain.value = store.getState().micGain;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = MIC_LIMITER.threshold;
    limiter.knee.value = MIC_LIMITER.knee;
    limiter.ratio.value = MIC_LIMITER.ratio;
    limiter.attack.value = MIC_LIMITER.attack;
    limiter.release.value = MIC_LIMITER.release;
    const outDest = ctx.createMediaStreamDestination();
    micGain.connect(limiter);
    limiter.connect(outDest);
    // Spatialised self-monitor: when the monitor is on AND spatial audio is on,
    // your own voice is played back through YOUR seat, so you hear yourself
    // where the room hears you (and can hear your own position change as you
    // drag the sliders). Built once; applyMicMonitor wires/unwires it.
    const monitorAir = ctx.createBiquadFilter();
    monitorAir.type = "lowpass";
    monitorAir.frequency.value = 22000; // transparent pass-through (no distance dulling)
    monitorAir.Q.value = 0.7;
    const monitorPanner = ctx.createPanner();
    monitorPanner.panningModel = "HRTF";
    monitorPanner.rolloffFactor = 0; // direction only — never changes loudness
    // Shared ambience reverb bus: every speaker-bound source sends into
    // reverbInput; the wet return goes to the speakers. Dry until an ambience is
    // picked (reverbWet 0). applyAmbience loads the impulse + sets the wet level.
    const reverbInput = ctx.createGain();
    const reverbConvolver = ctx.createConvolver();
    // Normalise the impulse (the default): keeps reverb loudness consistent
    // across rooms regardless of tail length. "Raw energy" (normalize=false) let
    // long tails accumulate huge energy and SATURATE — this is the clean setting.
    reverbConvolver.normalize = true;
    const reverbWet = ctx.createGain();
    reverbWet.gain.value = 0;
    reverbInput.connect(reverbConvolver);
    reverbConvolver.connect(reverbWet);
    reverbWet.connect(ctx.destination);
    // The monitor edge is wired by applyMicMonitor (called right after this and
    // whenever the monitor / spatial settings change).
    outGraphRef.current = {
      micSource: null,
      micGain,
      limiter,
      outDest,
      displaySource: null,
      fileSlots: null,
      activeSlot: 0,
      fileVolumeGain: null,
      micStream: null,
      monitorAir,
      monitorPanner,
      secondarySource: null,
      secondaryGain: null,
      secondaryStream: null,
      reverbInput,
      reverbConvolver,
      reverbWet,
    };
    return outGraphRef.current;
  }, [store]);

  // (Re)route the raw mic into the outgoing graph. Idempotent for a given
  // stream; re-runs when the mic is re-acquired (track died / device change).
  const connectMicToGraph = useCallback(
    (stream: MediaStream) => {
      const g = ensureOutGraph();
      if (g.micStream === stream && g.micSource) return;
      g.micSource?.disconnect();
      g.micSource = sharedAudioContext.createMediaStreamSource(stream);
      g.micSource.connect(g.micGain);
      // The mic monitor edge lives on micGain (a permanent node), not on
      // micSource — so it survives this re-acquisition and needs no re-wiring here.
      g.micStream = stream;
    },
    [ensureOutGraph],
  );

  // --- Device selection (set in the lobby or via the in-call settings) ---
  const micDeviceId = useRoomStore((s) => s.micDeviceId);
  const speakerDeviceId = useRoomStore((s) => s.speakerDeviceId);
  const voiceProcessingEnabled = useRoomStore((s) => s.voiceProcessingEnabled);
  const jamMode = useRoomStore((s) => s.jamMode);
  const networkMonitor = useRoomStore((s) => s.networkMonitor);
  const secondaryEnabled = useRoomStore((s) => s.secondaryEnabled);
  const secondaryDeviceId = useRoomStore((s) => s.secondaryDeviceId);
  const secondaryMonitor = useRoomStore((s) => s.secondaryMonitor);
  const micMonitor = useRoomStore((s) => s.micMonitor);
  const shareMonitor = useRoomStore((s) => s.shareMonitor);
  const fileStreamNameLocal = useRoomStore((s) => s.fileStreamName);
  const isSharingAudioLocal = useRoomStore((s) => s.isSharingAudio);

  // Tell the room when WE start/stop streaming audio (a file/URL/TV/series or a
  // system-audio share), so others keep our track centred (never spatialised)
  // while music is playing through it — music shouldn't follow our 3D seat.
  useEffect(() => {
    socketRef.current?.emit("set-streaming", {
      streaming: fileStreamNameLocal != null || isSharingAudioLocal,
    });
  }, [fileStreamNameLocal, isSharingAudioLocal]);

  // All incoming audio plays through the shared context, so the speaker pick
  // is one setSinkId there — it covers every peer, current and future.
  useEffect(() => {
    applySpeakerToContext(sharedAudioContext, speakerDeviceId);
  }, [speakerDeviceId]);

  // Route the whole mix through the low-latency media output when jam is on (the
  // ~19 ms WASAPI win), or the plain context destination otherwise. Re-applied when
  // jam toggles or the speaker changes.
  useEffect(() => {
    routeMasterOutput(jamMode, speakerDeviceId);
  }, [jamMode, speakerDeviceId]);

  // Jam PEER mesh over WebTransport: hear the others at 2.5 ms Opus over QUIC instead
  // of mediasoup's 10 ms path. When it's up we mute masterBus so the mediasoup peer
  // audio doesn't play the same voices twice. Fail-safe: if the relay/mic/APIs aren't
  // there, the mesh stays off and mediasoup peer audio plays as usual.
  const applyJamMesh = useCallback(async () => {
    const stopMesh = () => {
      if (wtMeshRef.current) {
        wtMeshRef.current.teardown();
        wtMeshRef.current = null;
      }
      masterBus.gain.value = 1; // mediasoup peer audio audible again
    };
    // Parked (see JAM_WT_MESH): the mesh crackled for everyone → jam plays peers through
    // the clean mediasoup/NetEQ path instead. Always keep the mesh off + masterBus live.
    if (!JAM_WT_MESH) return stopMesh();
    if (!store.getState().jamMode || !wtMeshSupported()) return stopMesh();
    if (wtMeshRef.current) return; // already meshing
    const micTrack = localStreamRef.current?.getAudioTracks()[0];
    const room = store.getState().roomName;
    if (!micTrack || !room) return stopMesh();
    const probe = await fetchWtProbeInfo();
    const jamUrl = probe.jamUrl;
    if (!probe.enabled || !jamUrl) return stopMesh();
    // Follow the mic's real channel count so a STEREO input stays stereo in jam
    // (mono mics → 1, no change). Fixes "jam collapses everything to mono".
    const micChannels = micTrack.getSettings().channelCount === 2 ? 2 : 1;
    const handle = await setupWtMesh(
      micTrack,
      jamUrl,
      probe.certHash?.value ?? null,
      room,
      store.getState().speakerDeviceId,
      micChannels,
      store.getState().localPeerId ?? "",
      // Per-peer volume, but a peer the store doesn't know (e.g. a NATIVE jam client
      // that's on the WT mesh but not in socket signaling) defaults to AUDIBLE at unity
      // instead of effectiveGain's 0 — otherwise browser peers would silence it. Deafen
      // still wins.
      (peerId: string) => {
        const st = store.getState();
        if (st.isDeafened) return 0;
        const peer = st.peers.get(peerId);
        return peer ? peer.volume : 1;
      },
      jamBoundsRef.current,
      sharedAudioContext,
    );
    if (handle) {
      wtMeshRef.current = handle;
      masterBus.gain.value = 0; // silence the mediasoup peer mix — the mesh plays it
    } else {
      masterBus.gain.value = 1;
    }
  }, [store]);

  useEffect(() => {
    void applyJamMesh();
    // Keep the mesh peers on the chosen speaker.
    if (wtMeshRef.current) wtMeshRef.current.setDevice(speakerDeviceId);
  }, [jamMode, speakerDeviceId, applyJamMesh]);

  // Jitter-buffer sliders: mutate the SHARED bounds object in place so every running
  // jam buffer (mesh peers, WT monitor, generator monitor) adopts the new min/max live,
  // no rebuild and no dropped audio.
  const jamBufferMinMs = useRoomStore((s) => s.jamBufferMinMs);
  const jamBufferMaxMs = useRoomStore((s) => s.jamBufferMaxMs);
  useEffect(() => {
    jamBoundsRef.current.minMs = jamBufferMinMs;
    jamBoundsRef.current.maxMs = jamBufferMaxMs;
  }, [jamBufferMinMs, jamBufferMaxMs]);

  const netMonitorDeviceId = useRoomStore((s) => s.netMonitorDeviceId);

  // Mid-call mic setting change: re-acquire the mic with the selected device
  // and voice-processing preference, then reroute it into the outgoing graph.
  // Senders/producers never see the swap because they always carry outDest's
  // track. Before a call (no local stream), join() picks the settings up.
  // Jam ("modo ensayo") forces capture UNPROCESSED (echo cancel / noise suppress
  // / AGC off) for full-band instrument tone with no processing latency — so the
  // effective processing is voiceProcessing AND NOT jam.
  // Send-path bypass for jam: send the RAW mic track directly instead of the
  // processed outDest track, dropping the outgoing Web Audio graph latency — the
  // soft limiter's ~6 ms lookahead plus the MediaStreamDestination→source buffer.
  // Live via replaceTrack (no renegotiation), so it toggles seamlessly.
  //
  // Trade-offs, all fine for jamming: no send-side limiter (an interface's line
  // level won't clip anyway), and shared/secondary audio (which mix into outDest)
  // aren't sent while raw — you're playing, not sharing. Mute still works: it
  // disables the raw mic track upstream either way. Contained to jam (opt-in), so
  // normal calls are untouched.
  const applyJamSendPath = useCallback(async () => {
    const jam = store.getState().jamMode;
    const raw = localStreamRef.current?.getAudioTracks()[0] ?? null;
    const processed = outGraphRef.current?.outDest.stream.getAudioTracks()[0] ?? null;
    const track = JAM_RAW_SEND && jam && raw ? raw : processed;
    if (!track) return;
    if (modeRef.current === "sfu") {
      const producer = producerRef.current;
      if (producer && producer.track !== track) {
        try {
          await producer.replaceTrack({ track });
        } catch (err) {
          console.error("[jam] SFU replaceTrack failed:", err);
        }
      }
    } else {
      for (const pc of p2pConnectionsRef.current.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (sender && sender.track !== track) {
          try {
            await sender.replaceTrack(track);
          } catch (err) {
            console.error("[jam] P2P replaceTrack failed:", err);
          }
        }
      }
    }
  }, [store]);

  const effectiveProcessing = voiceProcessingEnabled && !jamMode;
  const prevMicSettingsRef = useRef({ micDeviceId, effectiveProcessing, jamMode });
  useEffect(() => {
    const previous = prevMicSettingsRef.current;
    if (
      previous.micDeviceId === micDeviceId &&
      previous.effectiveProcessing === effectiveProcessing &&
      previous.jamMode === jamMode
    )
      return;
    prevMicSettingsRef.current = { micDeviceId, effectiveProcessing, jamMode };
    if (!localStreamRef.current) return;
    let cancelled = false;
    void (async () => {
      let stream: MediaStream;
      try {
        // jam = lowLatency capture (smallest input buffer).
        stream = await getMicrophoneStream(micDeviceId, effectiveProcessing, jamMode);
      } catch (err) {
        console.error("[mic] device switch failed:", err);
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // Carry an active mute onto the fresh track before it can leak audio.
      if (store.getState().isMuted) stream.getAudioTracks().forEach((t) => (t.enabled = false));
      const old = localStreamRef.current;
      localStreamRef.current = stream;
      connectMicToGraph(stream);
      // Jam sends the raw mic directly, so a device change must re-point the
      // producer/senders at the new raw track (a no-op when jam is off).
      void applyJamSendPath();
      old?.getTracks().forEach((t) => t.stop());
    })();
    return () => {
      cancelled = true;
    };
  }, [micDeviceId, effectiveProcessing, jamMode, connectMicToGraph, applyJamSendPath, store]);

  // Jam mode ("modo ensayo") toggled: re-apply the jitter-buffer target to the
  // tracks we're already receiving (0 for jam = lowest latency; the normal floor
  // otherwise) so it takes effect live, and give the honest guidance. The
  // unprocessed-capture half is handled by the mic effect above (effectiveProcessing).
  // Mark our OUTGOING audio as high network priority while jamming, so the OS/
  // network stack sets DSCP/QoS on those packets — many networks then queue them
  // ahead of bulk traffic, shaving jitter/latency on a busy link. Applied to the
  // SFU producer's sender and every P2P audio sender; re-applied on rebuild.
  const applyJamSenderPriority = useCallback(async () => {
    const priority: RTCPriorityType = store.getState().jamMode ? "high" : "medium";
    const setPrio = async (sender: RTCRtpSender | null | undefined) => {
      if (!sender) return;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        for (const enc of params.encodings) enc.networkPriority = priority;
        await sender.setParameters(params);
      } catch {
        /* not renegotiated yet / unsupported — best-effort */
      }
    };
    if (modeRef.current === "sfu") {
      await setPrio(producerRef.current?.rtpSender);
    } else {
      for (const pc of p2pConnectionsRef.current.values()) {
        await setPrio(pc.getSenders().find((s) => s.track?.kind === "audio"));
      }
    }
  }, [store]);

  const prevJamRef = useRef(jamMode);
  useEffect(() => {
    const hint = jamMode ? 0 : JITTER_BUFFER_HINT;
    for (const pa of peerAudiosRef.current.values()) {
      const track = (pa.audioEl.srcObject as MediaStream | null)?.getAudioTracks()[0];
      if (track && "playoutDelayHint" in track) {
        (track as unknown as Record<string, number>).playoutDelayHint = hint;
      }
    }
    void applyJamSenderPriority();
    void applyJamSendPath();
    // Only speak on an actual toggle, not on initial mount.
    if (prevJamRef.current === jamMode) return;
    prevJamRef.current = jamMode;
    if (jamMode) {
      // In SFU the media detours through the server, so latency won't drop — warn.
      store
        .getState()
        .announce(modeRef.current === "sfu" ? announce_jam_on_sfu() : announce_jam_on());
    } else {
      store.getState().announce(announce_jam_off());
    }
  }, [jamMode, applyJamSenderPriority, applyJamSendPath, store]);

  // Track previously-applied secondary settings so a monitor-only change can
  // skip the getUserMedia round-trip (mirrors prevMicSettingsRef pattern).
  const prevSecondaryRef = useRef({ enabled: secondaryEnabled, deviceId: secondaryDeviceId });

  // Acquire/release the secondary input device and wire it into outDest.
  // Re-runs whenever secondaryEnabled, secondaryDeviceId, or secondaryMonitor
  // changes. Uses a cancellation flag to avoid stale getUserMedia races.
  const applySecondaryDevice = useCallback(async () => {
    const g = ensureOutGraph();
    const state = store.getState();
    const enabled = state.secondaryEnabled;
    const deviceId = state.secondaryDeviceId;
    const monitor = state.secondaryMonitor;

    // Tear down any existing secondary path before rebuilding.
    if (g.secondarySource) {
      g.secondarySource.disconnect();
      g.secondarySource = null;
    }
    if (g.secondaryGain) {
      g.secondaryGain.disconnect();
      g.secondaryGain = null;
    }
    if (g.secondaryStream) {
      g.secondaryStream.getTracks().forEach((t) => t.stop());
      g.secondaryStream = null;
    }

    if (!enabled || !deviceId) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          channelCount: 2,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      console.error("[secondary] getUserMedia failed:", err);
      return;
    }

    // Re-check after the async boundary — effect may have been superseded.
    // We return the cancellation check to the caller via a captured flag.
    // (The caller sets it; we read it via the closure created in the effect.)
    return { stream, monitor };
  }, [ensureOutGraph, store]);

  // Live effect: acquire/release the secondary device whenever its settings change.
  useEffect(() => {
    const state = store.getState();
    const enabled = state.secondaryEnabled;
    const deviceId = state.secondaryDeviceId;
    const monitor = state.secondaryMonitor;
    const prev = prevSecondaryRef.current;
    const g = outGraphRef.current;

    // Monitor-only change: enabled and deviceId are unchanged, and the source
    // node is already live — just connect/disconnect the destination edge
    // without re-acquiring the device (avoids an audible gap on monitor toggle).
    if (enabled === prev.enabled && deviceId === prev.deviceId && g?.secondaryGain) {
      if (monitor) {
        // Guard against double-connect: disconnect first (no-op if not connected),
        // then reconnect — Web Audio silently allows duplicate connects but it
        // stacks, so a disconnect/reconnect cycle keeps exactly one connection.
        // Tapped at secondaryGain (post-gain) so the monitor matches what's sent.
        try {
          g.secondaryGain.disconnect(sharedAudioContext.destination);
        } catch {
          /* not connected */
        }
        g.secondaryGain.connect(sharedAudioContext.destination);
      } else {
        try {
          g.secondaryGain.disconnect(sharedAudioContext.destination);
        } catch {
          /* already disconnected */
        }
      }
      return;
    }

    // Enabled or deviceId changed — full acquire/release path.
    prevSecondaryRef.current = { enabled, deviceId };
    let cancelled = false;
    void (async () => {
      const result = await applySecondaryDevice();
      if (cancelled || !result) return;

      const { stream, monitor: mon } = result;
      const graph = outGraphRef.current;
      if (!graph) {
        // Graph was torn down (leave) between the async call and here.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const ctx = sharedAudioContext;
      const secondarySource = ctx.createMediaStreamSource(stream);
      const secondaryGain = ctx.createGain();
      // Start at your current "mic level" so the secondary placa matches it from
      // the first sample; setMicGain keeps the two in lockstep afterward.
      secondaryGain.gain.value = store.getState().micGain;
      secondarySource.connect(secondaryGain);
      secondaryGain.connect(graph.outDest);
      // Monitor tapped at secondaryGain (post-gain) so it matches what's sent.
      if (mon) secondaryGain.connect(ctx.destination);

      graph.secondarySource = secondarySource;
      graph.secondaryGain = secondaryGain;
      graph.secondaryStream = stream;
    })();
    return () => {
      cancelled = true;
    };
  }, [secondaryEnabled, secondaryDeviceId, secondaryMonitor, applySecondaryDevice, store]);

  // Toggle the local primary-mic monitor live: connect/disconnect the
  // micGain → destination edge so you hear yourself through your speakers AT THE
  // SAME volume people receive (post-gain) — lowering "your mic level" lowers the
  // monitor too. For-you only (never reaches the room). micGain is permanent, so
  // a single disconnect-then-connect keeps exactly one edge.
  // Wire the self-monitor for the current settings. With spatial audio ON it
  // goes through YOUR seat (air filter → HRTF panner), so you hear yourself from
  // where the room hears you — and hear your own position move as you drag the
  // Ctrl+Alt+U sliders. With it off, it's the plain dry tap as before.
  //
  // IMPORTANT: micGain also feeds the limiter → outDest (what the room hears),
  // so only ever disconnect the SPECIFIC monitor edges here. A bare
  // micGain.disconnect() would cut your outgoing audio.
  const applyMicMonitor = useCallback(() => {
    const g = outGraphRef.current;
    if (!g) return;
    const ctx = sharedAudioContext;
    try {
      g.micGain.disconnect(ctx.destination);
    } catch {
      /* not connected */
    }
    try {
      g.micGain.disconnect(g.monitorAir);
    } catch {
      /* not connected */
    }
    try {
      g.micGain.disconnect(g.reverbInput);
    } catch {
      /* not connected */
    }
    g.monitorAir.disconnect();
    g.monitorPanner.disconnect();

    const state = store.getState();
    // Network monitoring (your own return via the server) replaces the local
    // monitor — otherwise you'd hear yourself twice (locally at 0 ms AND the
    // network return). So the local monitor stands down while it's on.
    if (!state.micMonitor || state.networkMonitor) return;

    if (state.spatialAudio) {
      // Your own seat: your configured spot, or the even-spread spot — matching
      // exactly what the room hears of you (auto-all forces the spread).
      const myName = state.displayName ?? "";
      const seat = state.spatialAutoAll
        ? spatialAutoSeatOf()(myName)
        : (state.spatialPositions[myName] ?? spatialAutoSeatOf()(myName));
      const { x, y, z } = seatToPoint(seat);
      g.monitorPanner.positionX.value = x;
      g.monitorPanner.positionY.value = y;
      g.monitorPanner.positionZ.value = z;
      g.micGain.connect(g.monitorAir);
      g.monitorAir.connect(g.monitorPanner);
      g.monitorPanner.connect(ctx.destination);
    } else {
      g.micGain.connect(ctx.destination);
    }
    // Wet send: hear your OWN monitored voice in the room's ambience too (only
    // while monitoring, so you don't hear a reverb tail without the dry tap).
    g.micGain.connect(g.reverbInput);
  }, [store, spatialAutoSeatOf]);

  useEffect(() => {
    applyMicMonitor();
  }, [micMonitor, applyMicMonitor]);

  // Network monitoring ("a lo Jamulus"): hear your OWN signal returned via the
  // server (consume your own producer) so you can play to the shared timing —
  // you anticipate your own return instead of your local sound. SFU-only (P2P has
  // no producer and never returns your audio). Re-established whenever the
  // producer is (re)built, since consuming needs the current producer id.
  // Route the network-monitor return to its own output device (a second card /
  // headphones), or back to the primary output when the picker is "". Live: called
  // both when the monitor is (re)built and when the user changes the device.
  const routeNetMonitorOutput = useCallback((deviceId: string) => {
    // WebTransport 2.5 ms monitor: re-point its <audio> sink.
    if (netMonitorWtRef.current) {
      netMonitorWtRef.current.handle.setDevice(deviceId);
      return;
    }
    // Generator-playout monitor: just re-point its <audio> element's sink.
    if (netMonitorGenRef.current) {
      netMonitorGenRef.current.gen.setDevice(deviceId);
      return;
    }
    const nm = netMonitorRef.current;
    if (!nm) return;
    // Drop any previous dedicated output.
    if (nm.monitorEl) {
      try {
        nm.monitorEl.pause();
        nm.monitorEl.srcObject = null;
      } catch {
        /* gone */
      }
      nm.monitorEl = undefined;
    }
    try {
      nm.gainNode.disconnect(); // clears whatever it fed (dest or primary)
    } catch {
      /* not connected */
    }
    nm.monitorDest = undefined;
    if (deviceId && canSelectElementSink()) {
      // gain → MediaStreamDestination → <audio> pinned to the chosen card.
      const dest = sharedAudioContext.createMediaStreamDestination();
      nm.gainNode.connect(dest);
      const el = new Audio();
      el.srcObject = dest.stream;
      (el as unknown as { setSinkId: (id: string) => Promise<void> })
        .setSinkId(deviceId)
        .catch(() => {
          /* stale/unplugged device — the element then plays on default */
        });
      el.play().catch(() => {});
      nm.monitorDest = dest;
      nm.monitorEl = el;
    } else {
      // Default: back to the primary output via the master bus (so the monitor
      // rides the same low-latency media sink as the peers in jam).
      nm.gainNode.connect(masterBus);
    }
  }, []);

  const applyNetworkMonitor = useCallback(async () => {
    const tearDown = () => {
      const nm = netMonitorRef.current;
      if (nm) {
        if (nm.monitorEl) {
          try {
            nm.monitorEl.pause();
            nm.monitorEl.srcObject = null;
          } catch {
            /* gone */
          }
        }
        destroyAudioPipeline(nm);
        netMonitorRef.current = null;
      }
      const g = netMonitorGenRef.current;
      if (g) {
        g.gen.teardown();
        try {
          g.consumer.close();
        } catch {
          /* gone */
        }
        netMonitorGenRef.current = null;
      }
      const w = netMonitorWtRef.current;
      if (w) {
        w.handle.teardown();
        netMonitorWtRef.current = null;
      }
    };
    const on = store.getState().networkMonitor;
    if (!on) return tearDown();

    // Needs the server in the loop and our own producer to consume back.
    const producer = producerRef.current;
    const device = deviceRef.current;
    const recvTransport = recvTransportRef.current;
    if (modeRef.current !== "sfu" || !producer || !device || !recvTransport) {
      tearDown();
      return;
    }
    // Already monitoring THIS producer — nothing to do.
    if (
      netMonitorRef.current?.producerId === producer.id ||
      netMonitorGenRef.current?.producerId === producer.id ||
      netMonitorWtRef.current?.producerId === producer.id
    )
      return;
    tearDown();

    // Lowest-latency return (jam + Chrome/Edge + relay up): 2.5 ms Opus frames over
    // WebTransport, echoed by the relay — bypasses WebRTC's audio path entirely for
    // the timing reference. Falls through to the mediasoup self-consume if the relay
    // is off or anything fails.
    if (JAM_WT_MESH && store.getState().jamMode && wtMonitorSupported()) {
      const micTrack = localStreamRef.current?.getAudioTracks()[0];
      if (micTrack) {
        const info = await fetchWtProbeInfo();
        if (info.enabled && info.url) {
          const handle = await setupWtMonitor(
            micTrack,
            info.url,
            info.certHash?.value ?? null,
            store.getState().netMonitorDeviceId,
            micTrack.getSettings().channelCount === 2 ? 2 : 1,
            jamBoundsRef.current,
          );
          if (handle) {
            netMonitorWtRef.current = { handle, producerId: producer.id };
            return;
          }
        }
      }
    }

    try {
      const res = await emit<ConsumeResult>("consume", {
        producerId: producer.id,
        rtpCapabilities: device.recvRtpCapabilities,
      });
      const consumer = await recvTransport.consume({
        id: res.consumerId,
        producerId: res.producerId,
        kind: res.kind as "audio",
        rtpParameters: res.rtpParameters as Parameters<
          typeof recvTransport.consume
        >[0]["rtpParameters"],
      });
      // Minimum buffer on the return — the whole point is to hear it as early as
      // the network allows (this IS the latency you play against).
      if ("playoutDelayHint" in consumer.track) {
        (consumer.track as unknown as Record<string, number>).playoutDelayHint = JAM_JITTER_HINT;
      }
      setReceiverJitterTarget(consumer.rtpReceiver, true);

      // Lowest-latency monitor (jam + Chrome/Edge + flagged recv): decode the tapped
      // frames ourselves and play them through a MediaStreamTrackGenerator → <audio>
      // (WebRTC's ~23ms output) instead of the AudioContext graph (~42ms) — the
      // biggest browser-side win, no ASIO. Falls through to the graph path if
      // unsupported/fails (createEncodedStreams is once-per-receiver, so it's this OR
      // the graph+bypass, never both).
      const rcv = consumer.rtpReceiver;
      if (
        useRoomStore.getState().jamMode &&
        recvInsertableRef.current &&
        rcv &&
        generatorMonitorSupported(rcv)
      ) {
        const channels =
          (consumer.rtpParameters.codecs?.[0] as { channels?: number } | undefined)?.channels ?? 1;
        const gen = setupGeneratorMonitor(
          rcv,
          store.getState().netMonitorDeviceId,
          channels,
          1,
          jamBoundsRef.current,
        );
        if (gen) {
          netMonitorGenRef.current = { gen, consumer, producerId: producer.id };
          return;
        }
      }

      const pipeline = createAudioPipeline(consumer.track); // gain → destination
      pipeline.gainNode.gain.value = 1;
      // Jam: bypass NetEQ on your OWN return too — this is the timing reference you
      // play against, so its latency matters most.
      const jamBypass = await tapConsumer(
        consumer,
        pipeline.gainNode,
        recvInsertableRef.current,
        useRoomStore.getState().jamMode,
      );
      netMonitorRef.current = { ...pipeline, consumer, producerId: producer.id, jamBypass };
      // Send the return out the user's chosen card (or the primary if unset).
      routeNetMonitorOutput(store.getState().netMonitorDeviceId);
    } catch (err) {
      console.error("[net-monitor] self-consume failed:", err);
    }
  }, [emit, store, routeNetMonitorOutput]);

  // Live re-route of the network-monitor return to its own card when the picker
  // changes (no-op unless the monitor is currently up).
  useEffect(() => {
    routeNetMonitorOutput(netMonitorDeviceId);
  }, [netMonitorDeviceId, routeNetMonitorOutput]);

  const prevNetMonRef = useRef(networkMonitor);
  // Did network-monitor auto-force the SFU (so it should release it on off)? Kept
  // separate from a MANUAL force-SFU (Ctrl+Alt+S) or jam, which we must not undo.
  const netMonitorForcedSfuRef = useRef(false);
  useEffect(() => {
    void applyNetworkMonitor();
    applyMicMonitor(); // local monitor stands down (or returns) to avoid doubling
    if (prevNetMonRef.current === networkMonitor) return;
    prevNetMonRef.current = networkMonitor;
    if (networkMonitor) {
      if (modeRef.current !== "sfu" && !store.getState().forceSfu) {
        // Network monitoring needs the server in the loop (your signal has to
        // return via it). Auto-force SFU for the room instead of just warning:
        // the switch-to-SFU then produces, and the post-produce hook wires the
        // self-return automatically.
        void emit("set-force-sfu", { force: true })
          .then(() => store.getState().setForceSfu(true))
          .catch((err) => console.error("[net-monitor] auto force-SFU failed:", err));
        netMonitorForcedSfuRef.current = true;
        store.getState().announce(announce_net_monitor_forcing_sfu());
      } else {
        store.getState().announce(announce_net_monitor_on());
      }
    } else {
      // Release the SFU pin we set — but ONLY if WE set it (never undo a manual
      // Ctrl+Alt+S or jam). The server re-evaluates the mode, so if nothing else
      // needs the SFU (≤5 peers, no jam/recording/caster) the room returns to P2P,
      // exactly as it was before network monitoring was turned on.
      if (netMonitorForcedSfuRef.current) {
        netMonitorForcedSfuRef.current = false;
        void emit("set-force-sfu", { force: false })
          .then(() => store.getState().setForceSfu(false))
          .catch((err) => console.error("[net-monitor] release force-SFU failed:", err));
      }
      store.getState().announce(announce_net_monitor_off());
    }
  }, [networkMonitor, applyNetworkMonitor, applyMicMonitor, emit, store]);

  // Toggle the shared-audio monitor live: also play the shared tab/system audio
  // out the app's selected playback device (it follows the speaker pick via the
  // context sinkId), in addition to sending it to peers. Off by default; may
  // echo if the shared tab already plays on that same device.
  useEffect(() => {
    const g = outGraphRef.current;
    if (!g?.displaySource) return;
    try {
      g.displaySource.disconnect(sharedAudioContext.destination);
    } catch {
      /* not connected */
    }
    if (shareMonitor) g.displaySource.connect(sharedAudioContext.destination);
  }, [shareMonitor]);

  // --- P2P: create a peer connection ---
  const ensureLocalStream = useCallback(async () => {
    // Mic-less session: never acquire (or re-acquire) a microphone. Callers
    // build/produce from outDest's silent track instead, guarding the null.
    if (noMicRef.current) return null;

    const existing = localStreamRef.current;
    const track = existing?.getAudioTracks()[0];
    if (track && track.readyState === "live") return existing!;

    // Re-acquire mic (on the user's selected device, if any)
    const stream = await getMicrophoneStream(
      useRoomStore.getState().micDeviceId,
      useRoomStore.getState().voiceProcessingEnabled && !useRoomStore.getState().jamMode,
      useRoomStore.getState().jamMode,
    );
    localStreamRef.current = stream;
    connectMicToGraph(stream);
    return stream;
  }, [connectMicToGraph]);

  const createP2pConnection = useCallback(
    async (peerId: string, isOfferer: boolean) => {
      const socket = socketRef.current;
      if (!socket) return;

      // If we already have a connection to this peer (a re-offer, or a mode
      // switch re-establishing the mesh), tear it down first so the peer map
      // never ends up pointing at a stale/duplicate RTCPeerConnection — ICE
      // candidates are routed by peer id, and a dead PC in the map silently
      // sinks them so ICE never completes.
      const stale = p2pConnectionsRef.current.get(peerId);
      if (stale) {
        stale.close();
        p2pConnectionsRef.current.delete(peerId);
      }

      const localStream = await ensureLocalStream();
      if (localStream) connectMicToGraph(localStream);

      const pc = new RTCPeerConnection({
        iceServers: getIceServers(),
      });

      // Send the processed outgoing track (mic gain + limiter, + shared audio),
      // not the raw mic.
      const g = ensureOutGraph();
      const voiceSender = pc.addTrack(g.outDest.stream.getAudioTracks()[0], g.outDest.stream);
      // Apply the current room bitrate to this new P2P sender's encoder.
      void setSenderMaxBitrate(voiceSender, roomBitrateRef.current);
      // Re-assert jam high network priority on this new sender.
      void applyJamSenderPriority();
      void applyJamSendPath();

      // ICE candidates → relay via server
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit("p2p-signal", {
            targetPeerId: peerId,
            type: "ice-candidate",
            payload: e.candidate.toJSON(),
          });
        }
      };

      // Remote track → audio pipeline
      pc.ontrack = (e) => {
        const remoteTrack = e.track;
        const jam = useRoomStore.getState().jamMode;
        if ("playoutDelayHint" in remoteTrack) {
          (remoteTrack as unknown as Record<string, number>).playoutDelayHint = jam
            ? JAM_JITTER_HINT
            : JITTER_BUFFER_HINT;
        }
        setReceiverJitterTarget(e.receiver, jam);
        const pipeline = createAudioPipeline(remoteTrack);
        // Respect deafen / per-peer volume on a (re)built P2P pipeline too —
        // otherwise an SFU→P2P switch resets everyone to full volume and a
        // deafened listener starts hearing audio again.
        pipeline.gainNode.gain.value = effectiveGain(peerId);
        peerAudiosRef.current.set(peerId, pipeline);
        refreshSpatial();
      };

      p2pConnectionsRef.current.set(peerId, pc);

      if (isOfferer) {
        // Create offer with stereo 128k low-latency Opus params.
        pc.createOffer().then(async (offer) => {
          offer.sdp = forceOpusParams(offer.sdp!, 128, useRoomStore.getState().jamMode);
          await pc.setLocalDescription(offer);
          socket.emit("p2p-signal", {
            targetPeerId: peerId,
            type: "offer",
            payload: offer,
          });
        });
      }

      return pc;
    },
    [
      ensureLocalStream,
      connectMicToGraph,
      ensureOutGraph,
      effectiveGain,
      refreshSpatial,
      applyJamSenderPriority,
      applyJamSendPath,
    ],
  );

  // Apply candidates that were queued for a peer while its connection had no
  // remote description yet. Call right after setRemoteDescription.
  const flushPendingCandidates = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const pending = pendingCandidatesRef.current.get(peerId);
    pendingCandidatesRef.current.delete(peerId);
    if (!pending) return;
    for (const candidate of pending) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => {
        console.error("[p2p] queued addIceCandidate failed:", err);
      });
    }
  }, []);

  // --- P2P: tear down all connections ---
  const teardownP2p = useCallback(() => {
    for (const pc of p2pConnectionsRef.current.values()) {
      pc.close();
    }
    p2pConnectionsRef.current.clear();
    pendingCandidatesRef.current.clear();
    cleanupAllPeerAudio();
  }, [cleanupAllPeerAudio]);

  // --- SFU: tear down mediasoup transports ---
  const teardownSfu = useCallback(() => {
    producerRef.current?.close();
    producerRef.current = null;
    sendTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current?.close();
    recvTransportRef.current = null;
    pendingProducersRef.current = [];
    // Candidates queued here can only be trailing ones from a dead P2P epoch
    // (a new P2P session's candidates can't arrive before its offer) — drop
    // them so they never flush into a future session's connection.
    pendingCandidatesRef.current.clear();
    // The network-monitor self-consumer belongs to the (now-closed) producer.
    if (netMonitorRef.current) {
      destroyAudioPipeline(netMonitorRef.current);
      netMonitorRef.current = null;
    }
    if (netMonitorGenRef.current) {
      netMonitorGenRef.current.gen.teardown();
      netMonitorGenRef.current = null;
    }
    if (netMonitorWtRef.current) {
      netMonitorWtRef.current.handle.teardown();
      netMonitorWtRef.current = null;
    }
    if (wtMeshRef.current) {
      wtMeshRef.current.teardown();
      wtMeshRef.current = null;
      masterBus.gain.value = 1;
    }
    cleanupAllPeerAudio();
  }, [cleanupAllPeerAudio]);

  // --- SFU: consume a producer ---
  const consumeProducer = useCallback(
    async (peerId: string, producerId: string, source: string = "voice") => {
      const device = deviceRef.current;
      const recvTransport = recvTransportRef.current;
      if (!device || !recvTransport) {
        // SFU setup is still in flight — queue it for the end of setupSfu
        // (dropping it would permanently silence this producer for us).
        pendingProducersRef.current.push({ peerId, producerId, source });
        return;
      }

      const res = await emit<ConsumeResult>("consume", {
        producerId,
        rtpCapabilities: device.recvRtpCapabilities,
      });

      const consumer = await recvTransport.consume({
        id: res.consumerId,
        producerId: res.producerId,
        kind: res.kind as "audio",
        rtpParameters: res.rtpParameters as Parameters<
          typeof recvTransport.consume
        >[0]["rtpParameters"],
      });

      {
        const jam = useRoomStore.getState().jamMode;
        if ("playoutDelayHint" in consumer.track) {
          (consumer.track as unknown as Record<string, number>).playoutDelayHint = jam
            ? JAM_JITTER_HINT
            : JITTER_BUFFER_HINT;
        }
        setReceiverJitterTarget(consumer.rtpReceiver, jam);
      }

      const pipeline = createAudioPipeline(consumer.track);

      // Drop any previous pipeline for this peer first (a re-consume on a mode
      // switch, reconnect, or a live bitrate re-produce) so it never leaks or
      // doubles up.
      const existingPeerAudio = peerAudiosRef.current.get(peerId);
      if (existingPeerAudio) destroyAudioPipeline(existingPeerAudio);
      // On a flagged (jam) transport we MUST tap every consumer: voice peers get the
      // low-latency bypass; the music caster is passthrough (bypass=false) so NetEQ
      // plays it untouched — but it still MUST be tapped or it'd be silent.
      const jamBypass = await tapConsumer(
        consumer,
        pipeline.gainNode,
        recvInsertableRef.current,
        useRoomStore.getState().jamMode && source !== "music",
      );
      peerAudiosRef.current.set(peerId, { ...pipeline, consumer, jamBypass });
      refreshSpatial();

      // Flag a music-caster peer (e.g. Ecobox) so the UI shows it as a media
      // source. Stereo is preserved end-to-end by createAudioPipeline.
      if (source === "music") {
        store.getState().setPeerMusic(peerId, true);
      }

      // Start at the correct gain (respects per-peer volume and deafen).
      pipeline.gainNode.gain.value = effectiveGain(peerId);
    },
    [emit, store, effectiveGain, refreshSpatial],
  );

  // --- SFU: set up transports and produce ---
  const setupSfuInner = useCallback(
    async (rtpCapabilities: Record<string, unknown>) => {
      // Re-acquires the mic if its track died (e.g. iOS killed it during the
      // outage that preceded a reconnect) — producing from a dead source
      // would silently send silence for the rest of the session. Null in a
      // mic-less session; the produce below still uses outDest's silent track.
      const localStream = await ensureLocalStream();
      if (localStream) connectMicToGraph(localStream);

      // Load device if needed
      let device = deviceRef.current;
      if (!device) {
        device = new Device();
        deviceRef.current = device;
      }
      if (!device.loaded) {
        await device.load({
          routerRtpCapabilities: rtpCapabilities as Parameters<
            typeof device.load
          >[0]["routerRtpCapabilities"],
        });
      }

      // Create send transport
      const sendRes = await emit<{ ok: boolean; params: Record<string, unknown> }>(
        "create-transport",
        { direction: "send" },
      );
      const sendTransport = device.createSendTransport({
        ...(sendRes.params as Parameters<typeof device.createSendTransport>[0]),
        iceServers: getIceServers(),
      });

      sendTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
        try {
          await emit("connect-transport", { direction: "send", dtlsParameters });
          callback();
        } catch (e) {
          errback(e as Error);
        }
      });

      sendTransport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          // Forward the track's source ("voice" default, or "share" for a
          // stereo audio share) so the server tags/routes it correctly.
          const res = await emit<{ producerId: string }>("produce", {
            kind,
            rtpParameters,
            source: (appData as { source?: string })?.source,
          });
          callback({ id: res.producerId });
        } catch (e) {
          errback(e as Error);
        }
      });

      sendTransportRef.current = sendTransport;

      // Create recv transport
      const recvRes = await emit<{ ok: boolean; params: Record<string, unknown> }>(
        "create-transport",
        { direction: "recv" },
      );
      // Enable Encoded Transform ONLY in a jam room on a browser that supports it.
      // This is the safe gate learned from the outage: when the flag is on, Chrome
      // routes every frame through the tap, so EVERY consumer must be tapped (bypass
      // or passthrough) — which we can only guarantee in an all-or-nobody jam room.
      // Off for normal calls entirely, so they're byte-for-byte the old path.
      const useInsertable =
        JAM_NETEQ_BYPASS && SUPPORTS_INSERTABLE_STREAMS && store.getState().jamMode;
      recvInsertableRef.current = useInsertable;
      const recvTransport = device.createRecvTransport({
        ...(recvRes.params as Parameters<typeof device.createRecvTransport>[0]),
        iceServers: getIceServers(),
        ...(useInsertable ? { additionalSettings: { encodedInsertableStreams: true } } : {}),
      } as Parameters<typeof device.createRecvTransport>[0]);

      recvTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
        try {
          await emit("connect-transport", { direction: "recv", dtlsParameters });
          callback();
        } catch (e) {
          errback(e as Error);
        }
      });

      recvTransportRef.current = recvTransport;

      // Produce the processed outgoing track (mic gain + limiter, + shared audio).
      // Voice is always stereo 128k.
      const producer = await sendTransport.produce({
        track: ensureOutGraph().outDest.stream.getAudioTracks()[0],
        codecOptions: {
          opusStereo: true,
          opusDtx: false,
          // Jam mode: FEC off — in-band FEC recovers a lost packet from the NEXT
          // one, so the decoder holds a packet back "just in case", adding one
          // packet-time of latency. A musician wants the earliest sample, not the
          // safest. Read at produce time (like hi-fi voice), so it applies on the
          // next call / mode switch. Normal calls keep FEC on for resilience.
          opusFec: !store.getState().jamMode,
          opusMaxPlaybackRate: 48000,
          // Jam mode: 10ms packetisation (default is 20ms — a full 20ms buffered on
          // the sender before the first packet leaves). MEASURED: pushing ptime to 5
          // doesn't help — Chrome mixes 5/10ms frames (~8.5ms avg), so the receive
          // floor (which must cover the LARGEST frame) stays ~10ms while packet rate
          // rises. 10ms is the sweet spot; the receive-side ring floor auto-tracks
          // the actual frame size (jam-neteq-bypass) so this stays coupled.
          ...(store.getState().jamMode ? { opusPtime: 10 } : {}),
          // Honour the room's current quality at produce time (a mode switch or
          // late join rebuilds the producer); 128 = original.
          opusMaxAverageBitrate:
            roomBitrateRef.current < 128 ? roomBitrateRef.current * 1000 : 128000,
        },
        codec: device.recvRtpCapabilities.codecs?.find(
          (c) => c.mimeType.toLowerCase() === "audio/opus",
        ),
        // outDest is an app-owned, long-lived Web Audio track reused for the
        // whole session and across P2P↔SFU switches; mediasoup-client must NOT
        // stop it when this producer closes (default stopTracks:true would kill
        // it, so the next produce sends a dead track and no RTP flows).
        stopTracks: false,
      });
      producerRef.current = producer;
      // (Re)establish network monitoring on the fresh producer, if it's on, and
      // re-assert the jam high-priority marking on the new sender.
      void applyNetworkMonitor();
      void applyJamSenderPriority();
      void applyJamSendPath();
      // The mic/producer is now live — (re)start the jam mesh if we joined a room
      // that was ALREADY in jam (the jamMode effect may have run before the mic was
      // ready and bailed). Idempotent: no-op if the mesh is already up.
      void applyJamMesh();

      // Share audio and file audio both mix directly into outDest (no separate
      // producer for either — no rebuild needed on SFU setup).

      // Consume any producers announced while the transports were still being
      // built (their new-producer events arrived too early and were queued).
      while (pendingProducersRef.current.length > 0) {
        const pending = pendingProducersRef.current.shift()!;
        await consumeProducer(pending.peerId, pending.producerId, pending.source).catch((err) => {
          console.error("[sfu] queued consume failed:", err);
        });
      }
    },
    [
      emit,
      connectMicToGraph,
      ensureLocalStream,
      ensureOutGraph,
      consumeProducer,
      applyNetworkMonitor,
      applyJamSenderPriority,
      applyJamSendPath,
      applyJamMesh,
      store,
    ],
  );

  // setupSfu never leaves a half-built SFU behind on failure — a live-but-
  // broken sendTransport would arm the switch-to-sfu idempotency guard and
  // block the next rebuild from ever running.
  const setupSfu = useCallback(
    async (rtpCapabilities: Record<string, unknown>) => {
      try {
        await setupSfuInner(rtpCapabilities);
      } catch (err) {
        teardownSfu();
        throw err;
      }
    },
    [setupSfuInner, teardownSfu],
  );

  // --- Main join ---
  const join = useCallback(
    async (
      roomName: string,
      displayName: string,
      opts?: { disableP2p?: boolean; noMic?: boolean },
    ) => {
      // Acquire stereo audio + build the outgoing graph BEFORE connecting so
      // it's ready the moment we (re)join. The mic, AudioContext and outgoing
      // track are reused for the whole session and survive reconnects, so a
      // network blip never re-prompts for the mic or rebuilds the send chain.
      //
      // A microphone must NEVER block joining: if the user opted out ("Join
      // without a microphone") we don't even prompt, and if acquisition fails
      // (no device, or permission denied) we fall back to the same mic-less
      // mode instead of throwing. Either way they can still listen and chat —
      // the outgoing track is outDest's, which is valid (silent) without a mic.
      let stream: MediaStream | null = null;
      if (!opts?.noMic) {
        try {
          stream = await getMicrophoneStream(
            store.getState().micDeviceId,
            store.getState().voiceProcessingEnabled && !store.getState().jamMode,
            store.getState().jamMode,
          );
        } catch (err) {
          console.warn("[mic] no microphone — joining in listen/chat-only mode:", err);
        }
      }
      if (stream) {
        noMicRef.current = false;
        localStreamRef.current = stream;
        connectMicToGraph(stream);
        store.getState().setHasMic(true);
      } else {
        // Mic-less: build the (silent) outgoing graph so producing/adding the
        // outDest track still works, and reflect the state in the store (gates
        // the mute control + mic slider, shows a "text only" indicator).
        noMicRef.current = true;
        localStreamRef.current = null;
        ensureOutGraph();
        store.getState().setHasMic(false);
        store.getState().setMuted(true);
      }

      const socket = io({ transports: ["websocket"] });
      socketRef.current = socket;

      // (Re)join the room and (re)build all media from the server's response.
      // Runs on the initial join AND on every reconnect; it never registers
      // socket handlers (those are attached once, below, and persist across
      // reconnects).
      const joinAndSetup = async () => {
        type JoinResponse = {
          ok: boolean;
          rtpCapabilities: Record<string, unknown>;
          peers: Array<{
            peerId: string;
            displayName: string;
            muted?: boolean;
            streaming?: boolean;
            producers: Array<{ producerId: string; source: string }>;
          }>;
          mode: RoomMode;
          recording: { recordingId: string } | null;
          audioBitrate?: number;
          spatialPositions?: Record<string, SpatialSeat>;
          spatialEnabled?: boolean;
          spatialAutoAll?: boolean;
          ambience?: string;
          forceSfu?: boolean;
          jamMode?: boolean;
          token?: string;
          closed?: boolean;
          ghosted?: boolean;
          messages: ChatMessage[];
        };
        // Per-room membership token (see closed-room ghost routing). Persisted so
        // a reconnect is recognised as a member and not ghosted out of a closed
        // room. sessionStorage: per-tab, cleared when the tab closes.
        const roomTokenKey = `jdh-speak:roomToken:${roomName}`;
        let storedToken: string | undefined;
        try {
          storedToken = sessionStorage.getItem(roomTokenKey) ?? undefined;
        } catch {
          /* storage blocked — token is best-effort */
        }
        const joinPayload = {
          roomName,
          displayName,
          disableP2p: opts?.disableP2p,
          token: storedToken,
        };

        const joinRes = await emit<JoinResponse>("join", joinPayload);

        store.getState().setRoom(roomName, displayName, socket.id!);
        store.getState().setMode(joinRes.mode);
        modeRef.current = joinRes.mode;

        // Match the room's current voice bitrate (late joiner / reconnect).
        roomBitrateRef.current = joinRes.audioBitrate ?? 128;
        // Seats are room-wide, so adopt whatever the room already has.
        store.getState().setSpatialPositions(joinRes.spatialPositions ?? {});
        // Spatial on/off is room state too — adopt the room's current mode.
        store.getState().setSpatialAudio(joinRes.spatialEnabled ?? false);
        store.getState().setSpatialAutoAll(joinRes.spatialAutoAll ?? false);
        // Adopt the room's current ambience (reverb space) and load it.
        store.getState().setAmbience(joinRes.ambience ?? "seco");
        applyAmbience();
        // Adopt the room's manual force-SFU state (so the toggle is correct).
        store.getState().setForceSfu(joinRes.forceSfu ?? false);
        // Adopt the room's jam (ensayo) state — it's room-wide, so a late joiner
        // matches whatever the room is currently running.
        store.getState().setJamMode(joinRes.jamMode ?? false);
        // Persist our membership token and adopt the room's closed state.
        if (joinRes.token) {
          try {
            sessionStorage.setItem(roomTokenKey, joinRes.token);
          } catch {
            /* storage blocked — reconnect into a closed room may be ghosted */
          }
        }
        store.getState().setRoomClosed(joinRes.closed ?? false);
        // Were we ghosted into a separate room because the real one is closed?
        // Ctrl+Alt+B reads this to decide: admit-to-real (ghosted) vs toggle.
        store.getState().setGhosted(joinRes.ghosted ?? false);
        // The out graph exists by now — wire the (possibly spatial) monitor.
        applyMicMonitor();

        // Seed chat history (de-duped in the store, silent — no chime/announce).
        for (const m of joinRes.messages ?? []) store.getState().addMessage(m);

        // Sync recording state — it may have started/stopped while we were away.
        store
          .getState()
          .setRecording(
            !!joinRes.recording,
            joinRes.recording ? joinRes.recording.recordingId : null,
          );

        // Reconcile the peer list: drop anyone who left while we were
        // disconnected, add newcomers. addPeer resets per-peer state, so only
        // add peers we don't already track (keeps volume/mute across a rejoin).
        const present = new Set(joinRes.peers.map((p) => p.peerId));
        for (const id of [...store.getState().peers.keys()]) {
          if (!present.has(id)) store.getState().removePeer(id);
        }
        for (const peer of joinRes.peers) {
          if (!store.getState().peers.has(peer.peerId)) {
            store.getState().addPeer(peer.peerId, peer.displayName);
          }
          // Server truth for mute state — a late joiner (or a reconnect that
          // missed the peer-muted events) renders existing mutes correctly.
          store.getState().setPeerMuted(peer.peerId, !!peer.muted);
          store.getState().setPeerStreaming(peer.peerId, !!peer.streaming);
        }

        // Producers queued before this ack (stale modeRef during a rejoin) are
        // all covered by the join snapshot below — draining them too would
        // consume them twice and double that peer's audio.
        pendingProducersRef.current = [];

        if (joinRes.mode === "p2p") {
          // P2P: we're the newcomer, so we offer to every existing peer (they
          // wait for the offer in the p2p-signal handler).
          for (const peer of joinRes.peers) {
            await createP2pConnection(peer.peerId, true);
          }
        } else {
          // SFU mode: set up transports, then consume existing producers.
          await setupSfu(joinRes.rtpCapabilities);
          for (const peer of joinRes.peers) {
            for (const prod of peer.producers) {
              await consumeProducer(peer.peerId, prod.producerId, prod.source);
            }
          }
        }

        // Mic-less session: we still produced/added outDest's silent track, so
        // present as muted — pause the (SFU) voice producer and tell the server,
        // which marks us muted and broadcasts peer-muted so everyone sees it.
        // Re-runs on every reconnect, keeping us muted after a rejoin.
        if (noMicRef.current) {
          store.getState().setMuted(true);
          if (modeRef.current === "sfu") producerRef.current?.pause();
          await emit("producer-pause", {}).catch(() => {});
        }
      };

      // socket.io fires "connect" on the first connection AND on every
      // reconnection — each reconnect gets a NEW socket id, so the server has
      // already dropped our old peer and we must rejoin from scratch. Without
      // this, a transient drop silently left us in a room the server no longer
      // knew about: the call appeared to "drop", and a forced-SFU room (e.g.
      // ?p2p=off) could fall back to P2P for the peers that stayed.
      let hasJoined = false;
      let resolveReady!: () => void;
      let rejectReady!: (err: unknown) => void;
      const ready = new Promise<void>((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
      });

      socket.on("connect", async () => {
        store.getState().setConnected(true);
        try {
          // Serialized with the mode-switch handlers so a rejoin never
          // interleaves with an in-flight P2P↔SFU transition.
          await runTransition(async () => {
            if (hasJoined) {
              console.log("[ws] reconnected — rejoining room");
              // The old transports / peer connections are dead; rebuild them.
              teardownP2p();
              teardownSfu();
            }
            await joinAndSetup();
          });
          if (!hasJoined) {
            hasJoined = true;
            resolveReady();
          }
        } catch (err) {
          if (hasJoined) console.error("[ws] rejoin failed:", err);
          else rejectReady(err);
        }
      });

      socket.on("disconnect", () => {
        store.getState().setConnected(false);
      });

      // --- Socket event handlers (attached once; persist across reconnects) ---
      socket.on(
        "peer-joined",
        ({ peerId, displayName: name }: { peerId: string; displayName: string }) => {
          store.getState().addPeer(peerId, name);
          const joinTs = Date.now();
          store.getState().addMessage({
            id: `sys-join-${peerId}-${joinTs}`,
            sender: name,
            text: "",
            ts: joinTs,
            kind: "join",
          });
          playCue(sharedAudioContext, "join");
          // In P2P mode, the new peer will send us an offer — we wait for it
        },
      );

      // Spatial audio was switched on/off for the room — apply and say who did it.
      socket.on("spatial-enabled", ({ enabled, by }: { enabled: boolean; by: string }) => {
        store.getState().setSpatialAudio(enabled);
        refreshSpatial();
        applyMicMonitor();
        store
          .getState()
          .announceEvent(enabled ? m.spatial_on_by({ name: by }) : m.spatial_off_by({ name: by }));
      });

      // Someone toggled force-SFU for the room. Adopt the state silently (no
      // announcement — only the presser hears a local confirmation). The actual
      // transport switch arrives separately via switch-to-sfu / switch-to-p2p.
      socket.on("force-sfu", ({ force }: { force: boolean }) => {
        store.getState().setForceSfu(force);
      });

      // Someone toggled room-wide jam (ensayo) mode. Adopt it — this drives the
      // jam send path + receive tuning for everyone — and announce who did it.
      socket.on("jam-mode", ({ enabled, by }: { enabled: boolean; by?: string }) => {
        store.getState().setJamMode(enabled);
        store
          .getState()
          .announce(enabled ? announce_jam_room_on({ by: by ?? "" }) : announce_jam_room_off({ by: by ?? "" }));
      });

      // Wire the DeviceSettings jam checkbox to broadcast room-wide: emit to the
      // server (which tells everyone else) and apply locally for the presser.
      useRoomStore.setState({
        onJamToggle: (enabled: boolean) => {
          void emit("set-jam-mode", { enabled })
            .then(() => store.getState().setJamMode(enabled))
            .catch((err) => console.error("[jam] set-jam-mode failed:", err));
        },
      });

      // Someone closed/opened the room. Adopt the state silently (no
      // announcement — only the presser hears a local confirmation).
      socket.on("room-closed", ({ closed }: { closed: boolean }) => {
        store.getState().setRoomClosed(closed);
      });

      // "Auto-position everyone" was toggled for the room — re-seat all and
      // re-wire your own monitor, then say who did it.
      socket.on("spatial-auto", ({ enabled, by }: { enabled: boolean; by: string }) => {
        store.getState().setSpatialAutoAll(enabled);
        refreshSpatial();
        applyMicMonitor();
        store
          .getState()
          .announceEvent(
            enabled ? m.spatial_auto_on_by({ name: by }) : m.spatial_auto_off_by({ name: by }),
          );
      });

      // The room's acoustic ambience changed — load the new space and say who.
      socket.on("ambience", ({ id, by }: { id: string; by: string }) => {
        store.getState().setAmbience(id);
        applyAmbience();
        store.getState().announceEvent(
          m.ambience_set_by({
            name: by,
            ambience: ambienceName(id, store.getState().serverAmbiences),
          }),
        );
      });

      // Someone moved a seat in the 3D field (room-wide) — re-apply for everyone.
      socket.on("spatial-positions", (positions: Record<string, SpatialSeat>) => {
        store.getState().setSpatialPositions(positions ?? {});
        refreshSpatial();
        // If YOUR seat moved, the self-monitor has to follow it — that's what
        // makes dragging your own sliders audible while monitoring.
        applyMicMonitor();
      });

      // Someone else pressed a key in chat — one tick, matching their rhythm.
      socket.on("peer-typing-tick", () => playTypingTick(sharedAudioContext));

      // Someone nudged the room. Announce who as well as playing it — the sound
      // alone doesn't say who sent it, and this app is screen-reader-first.
      socket.on("peer-nudge", ({ from }: { from: string }) => {
        playCue(sharedAudioContext, "zumbido");
        store.getState().announceEvent(m.nudge_received({ name: from }));
      });

      socket.on("peer-left", ({ peerId }: { peerId: string }) => {
        const name = store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
        const wasMusic = !!store.getState().peers.get(peerId)?.isMusic;
        // Clean up P2P connection if any
        const pc = p2pConnectionsRef.current.get(peerId);
        if (pc) {
          pc.close();
          p2pConnectionsRef.current.delete(peerId);
        }
        pendingCandidatesRef.current.delete(peerId);
        // Clean up audio
        const peerAudio = peerAudiosRef.current.get(peerId);
        if (peerAudio) {
          destroyAudioPipeline(peerAudio);
          peerAudiosRef.current.delete(peerId);
          refreshSpatial(); // re-spread the remaining seats
        }
        store.getState().removePeer(peerId);
        if (!wasMusic) {
          const leaveTs = Date.now();
          store.getState().addMessage({
            id: `sys-leave-${peerId}-${leaveTs}`,
            sender: name,
            text: "",
            ts: leaveTs,
            kind: "leave",
          });
        }
        playCue(sharedAudioContext, "leave");
      });

      // --- Recording (private to whoever started it; silent to others) ---
      // The finished recording was cleaned up server-side (TTL) — drop the link.
      // Only matters to the initiator (the only client holding a recordingId).
      socket.on("recording-expired", () => {
        if (!store.getState().recordingId) return;
        store.getState().setRecording(false, null);
        store.getState().announce(announce_recording_unavailable());
      });

      // A peer changed their display name live — update their card.
      socket.on(
        "peer-renamed",
        ({ peerId, displayName }: { peerId: string; displayName: string }) => {
          store.getState().setPeerName(peerId, displayName);
        },
      );

      // Room voice quality changed (by anyone, via the keyboard shortcut). Opus
      // bitrate can't change without renegotiation, so reconnect: the connect
      // handler rejoins and rebuilds ALL media (P2P mesh or SFU) using the room
      // bitrate carried in the join response. Reliable for any size/topology —
      // brief reconnect gap, which is fine for a deliberate quality change.
      socket.on("bitrate-changed", ({ kbps, by }: { kbps: number; by?: string }) => {
        roomBitrateRef.current = kbps;
        const name = by ?? announce_a_participant();
        store
          .getState()
          .announce(
            kbps >= 128 ? announce_bitrate_original({ name }) : announce_bitrate({ name, kbps }),
          );
        if (modeRef.current === "sfu") {
          // SFU bitrate is set by mediasoup at produce time → reconnect to
          // re-produce at the new bitrate (verified to actually lower it).
          socket.disconnect();
          socket.connect();
        } else {
          // P2P: cap each sender's encoder directly (SDP caps are ignored by
          // Chrome for P2P audio; setParameters talks to the encoder).
          for (const pc of p2pConnectionsRef.current.values()) {
            const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
            void setSenderMaxBitrate(sender, kbps);
          }
        }
      });

      // P2P signaling relay
      socket.on(
        "p2p-signal",
        async ({
          fromPeerId,
          type,
          payload,
        }: {
          fromPeerId: string;
          type: "offer" | "answer" | "ice-candidate";
          payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
        }) => {
          if (type === "offer") {
            // Candidates already queued for this peer belong to a previous
            // session — a session's candidates always arrive after its offer —
            // so clear them NOW, at offer arrival; everything queued from this
            // point on belongs to the session this offer starts.
            pendingCandidatesRef.current.delete(fromPeerId);
            const seq = (offerSeqRef.current.get(fromPeerId) ?? 0) + 1;
            offerSeqRef.current.set(fromPeerId, seq);
            // Serialized behind any in-flight transition: answering immediately
            // could build a pipeline that a queued teardown then destroys.
            void runTransition(async () => {
              // Re-checked at run time — ignore offers from a stale P2P epoch
              // (relayed just before a switch-to-sfu), and offers superseded by
              // a newer one from the same peer while this waited in the chain.
              if (modeRef.current !== "p2p") return;
              if (offerSeqRef.current.get(fromPeerId) !== seq) return;
              // We received an offer — create connection as answerer
              const pc = await createP2pConnection(fromPeerId, false);
              if (!pc) return;
              await pc.setRemoteDescription(
                new RTCSessionDescription(payload as RTCSessionDescriptionInit),
              );
              await flushPendingCandidates(fromPeerId, pc);
              const answer = await pc.createAnswer();
              answer.sdp = forceOpusParams(answer.sdp!, 128, useRoomStore.getState().jamMode);
              await pc.setLocalDescription(answer);
              socket.emit("p2p-signal", {
                targetPeerId: fromPeerId,
                type: "answer",
                payload: answer,
              });
            }).catch((err) => console.error("[p2p] offer handling failed:", err));
          } else if (type === "answer") {
            const pc = p2pConnectionsRef.current.get(fromPeerId);
            if (pc) {
              await pc.setRemoteDescription(
                new RTCSessionDescription(payload as RTCSessionDescriptionInit),
              );
              await flushPendingCandidates(fromPeerId, pc);
            }
          } else if (type === "ice-candidate") {
            const pc = p2pConnectionsRef.current.get(fromPeerId);
            if (pc?.remoteDescription) {
              await pc.addIceCandidate(new RTCIceCandidate(payload as RTCIceCandidateInit));
            } else {
              // No remote description yet (its offer/answer is still being
              // processed) — addIceCandidate would throw and lose the
              // candidate. Queue it; flushed right after setRemoteDescription.
              const pending = pendingCandidatesRef.current.get(fromPeerId) ?? [];
              pending.push(payload as RTCIceCandidateInit);
              pendingCandidatesRef.current.set(fromPeerId, pending);
            }
          }
        },
      );

      // Switch to SFU (3+ peers)
      socket.on(
        "switch-to-sfu",
        ({ rtpCapabilities }: { rtpCapabilities: Record<string, unknown> }) => {
          console.log("[mode] switching to SFU");
          // Mode flips synchronously (event arrival order = server truth) so
          // other handlers route correctly even while the rebuild is queued.
          modeRef.current = "sfu";
          store.getState().setMode("sfu");
          void runTransition(async () => {
            // Already on a live SFU (e.g. our own join response said "sfu" and
            // this broadcast raced it) — rebuilding would duplicate transports
            // and producers, so peers would hear us twice.
            if (sendTransportRef.current && !sendTransportRef.current.closed) return;
            teardownP2p();
            await setupSfu(rtpCapabilities);
            // The server will send new-producer events for all existing producers after they also set up
          }).catch((err) => console.error("[mode] switch to SFU failed:", err));
        },
      );

      // Switch to P2P (back to 2 peers)
      socket.on("switch-to-p2p", ({ peerIds }: { peerIds: string[] }) => {
        console.log("[mode] switching to P2P");
        // Mode flips synchronously so an offer arriving right behind this
        // event isn't dropped by the p2p-signal handler's mode guard.
        modeRef.current = "p2p";
        store.getState().setMode("p2p");
        void runTransition(async () => {
          teardownSfu();

          // Re-establish the mesh. Only the lower-id peer initiates; the higher-id
          // peer waits for the offer and builds its side in the p2p-signal handler
          // (same convention as the initial join). Previously BOTH sides called
          // createP2pConnection here, which raced with the incoming offer also
          // creating one — the peer map could end up pointing at the orphaned PC,
          // so ICE candidates went to a dead connection and the call silently
          // dropped on every SFU→P2P switch (stopping a recording, or a caster
          // leaving).
          const myId = socket.id!;
          for (const peerId of peerIds) {
            if (peerId !== myId && myId < peerId) {
              await createP2pConnection(peerId, true);
            }
          }
        }).catch((err) => console.error("[mode] switch to P2P failed:", err));
      });

      // SFU: new producer available
      socket.on(
        "new-producer",
        async ({
          peerId,
          producerId,
          source,
        }: {
          peerId: string;
          producerId: string;
          source?: string;
        }) => {
          if (modeRef.current !== "sfu") return;
          try {
            await consumeProducer(peerId, producerId, source ?? "voice");
          } catch (err) {
            console.error("[sfu] consume failed:", err);
          }
        },
      );

      // A remote peer toggled their mic: reflect it, play a soft cue, and speak
      // it on the polite ARIA region. Unlike other room events this is NOT
      // logged to chat (announce, not announceEvent) — it'd be too noisy.
      socket.on("peer-muted", ({ peerId }: { peerId: string }) => {
        store.getState().setPeerMuted(peerId, true);
        // Coalesced per peer so a peer mashing their mic only blips us once or
        // twice, not on every flip (see surfaceToggle).
        surfaceToggle(`peer:${peerId}`, true, () => {
          playCue(sharedAudioContext, "peer-mute");
        });
      });

      socket.on("peer-unmuted", ({ peerId }: { peerId: string }) => {
        store.getState().setPeerMuted(peerId, false);
        surfaceToggle(`peer:${peerId}`, false, () => {
          playCue(sharedAudioContext, "peer-unmute");
        });
      });

      // A peer started/stopped streaming audio — re-seat so their track is
      // centred (never spatialised) while streaming, then back to their seat.
      socket.on(
        "peer-streaming",
        ({ peerId, streaming }: { peerId: string; streaming: boolean }) => {
          store.getState().setPeerStreaming(peerId, streaming);
          refreshSpatial();
        },
      );

      // Incoming chat (including the echo of our own messages): render it, chime
      // a distinct cue, and announce it via the user's chosen channel — a polite
      // or assertive ARIA live region, or the browser's spoken TTS (announceChat
      // reads chatAnnounceMode). Both sent and received messages flow through
      // here (own messages come back as an echo), so both get announced.
      socket.on("chat-message", (msg: ChatMessage) => {
        store.getState().addMessage(msg);
        let announcement = formatMessage(msg, Date.now());
        // First message of the session: tell SR users once that Alt+1..0 reads
        // the recent messages aloud even while the chat panel is closed.
        if (!chatHintGivenRef.current) {
          chatHintGivenRef.current = true;
          announcement += `${META_SEP}${announce_chat_hint()}`;
        }
        store.getState().announceChat(announcement);
        playCue(sharedAudioContext, "message");
      });

      // Resolve once the first connect → join → media setup has completed (or
      // reject if that initial join fails), so callers can flip to "joined".
      await ready;

      // No-mic mode: UI reflects listen/chat-only state via store flag.
    },
    [
      emit,
      consumeProducer,
      setupSfu,
      createP2pConnection,
      connectMicToGraph,
      ensureOutGraph,
      teardownP2p,
      teardownSfu,
      surfaceToggle,
      runTransition,
      flushPendingCandidates,
      applyMicMonitor,
      refreshSpatial,
      applyAmbience,

      store,
    ],
  );

  const mute = useCallback(async () => {
    // Silence the mic track in the outgoing graph.
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = false;

    // When extra audio (secondary device, audio share, or file stream) is mixed
    // into the same voice producer as the mic, pausing that producer would silence
    // it too.  Instead we signal muted state via set-mute-state (which broadcasts
    // peer-muted without touching the producer) and leave the producer running.
    const outDestHasExtraAudio = () =>
      (store.getState().secondaryEnabled && !!outGraphRef.current?.secondarySource) ||
      store.getState().isSharingAudio ||
      store.getState().fileStreamName != null;
    if (outDestHasExtraAudio()) {
      await emit("set-mute-state", { muted: true }).catch(() => {});
    } else {
      if (modeRef.current === "sfu" && producerRef.current) producerRef.current.pause();
      await emit("producer-pause", {}).catch(() => {});
    }
    store.getState().setMuted(true);
    // Coalesced so mashing mute doesn't spam the cue (see surfaceToggle).
    surfaceToggle("mic", true, () => {
      playCue(sharedAudioContext, "mute");
    });
  }, [emit, store, surfaceToggle]);

  const unmute = useCallback(async () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = true;

    const outDestHasExtraAudio = () =>
      (store.getState().secondaryEnabled && !!outGraphRef.current?.secondarySource) ||
      store.getState().isSharingAudio ||
      store.getState().fileStreamName != null;
    if (outDestHasExtraAudio()) {
      await emit("set-mute-state", { muted: false }).catch(() => {});
    } else {
      if (modeRef.current === "sfu" && producerRef.current) producerRef.current.resume();
      await emit("producer-resume", {}).catch(() => {});
    }
    store.getState().setMuted(false);
    surfaceToggle("mic", false, () => {
      playCue(sharedAudioContext, "unmute");
    });
  }, [emit, store, surfaceToggle]);

  const toggleMute = useCallback(async () => {
    if (store.getState().isMuted) await unmute();
    else await mute();
  }, [mute, unmute, store]);

  const toggleDeafen = useCallback(() => {
    store.getState().setDeafened(!store.getState().isDeafened);
    // Recompute every peer's gain so un-deafen restores per-peer volume
    // instead of resetting everyone to 1.
    const now = sharedAudioContext.currentTime;
    for (const [peerId, peerAudio] of peerAudiosRef.current) {
      peerAudio.gainNode.gain.setTargetAtTime(effectiveGain(peerId), now, GAIN_RAMP);
    }
  }, [store, effectiveGain]);

  const setPeerVolume = useCallback(
    (peerId: string, volume: number) => {
      store.getState().setPeerVolume(peerId, volume);
      const peerAudio = peerAudiosRef.current.get(peerId);
      if (peerAudio) {
        peerAudio.gainNode.gain.setTargetAtTime(
          effectiveGain(peerId),
          sharedAudioContext.currentTime,
          GAIN_RAMP,
        );
      }
    },
    [store, effectiveGain],
  );

  // --- Audio share: cast system/tab audio mixed into outDest (voice track) ---
  // The shared audio connects directly into outDest so it travels on the
  // existing voice track — no separate producer, no SFU pin.
  const detachSharedAudio = useCallback(() => {
    const g = outGraphRef.current;
    g?.displaySource?.disconnect();
    if (g) {
      g.displaySource = null;
    }
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
  }, []);

  const stopAudioShare = useCallback(async () => {
    if (!store.getState().isSharingAudio) return;
    // Detach the shared-audio nodes (disconnects displaySource, stops display tracks).
    detachSharedAudio();
    store.getState().setSharingAudio(false);
    // Local feedback.
    playCue(sharedAudioContext, "share-stop");
  }, [store, detachSharedAudio]);

  const startAudioShare = useCallback(async () => {
    if (store.getState().isSharingAudio) return;
    if (!localStreamRef.current) return;

    // Chrome requires `video: true` to expose system/tab audio. We discard
    // the video track immediately — we only want the audio.
    let displayStream: MediaStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // Exclude this page's own playback (the other participants) from
          // system-audio capture, so they don't get looped back and doubled.
          // Chrome 140+ on Windows/macOS; ignored elsewhere.
          restrictOwnAudio: true,
        } as MediaTrackConstraints,
      });
    } catch {
      // User cancelled the picker, or the browser refused
      return;
    }

    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach((t) => t.stop());
      alert(
        'No audio was shared. When choosing what to share, tick "Share system audio" (entire screen) or "Share tab audio" (Chrome tab). On Firefox/Safari this is not supported.',
      );
      return;
    }

    // Discard the video track — we don't need to send any video
    displayStream.getVideoTracks().forEach((t) => t.stop());

    // Mix the shared audio directly into outDest (the voice track) so it
    // travels on the existing P2P/SFU track — no separate producer, no SFU pin,
    // no duck gain (manual volume / caster handle ducking elsewhere).
    const g = ensureOutGraph();
    const displaySource = sharedAudioContext.createMediaStreamSource(new MediaStream(audioTracks));
    displaySource.connect(g.outDest);
    // Optionally also play it out your selected playback device so you hear it
    // where you listen (the live effect keeps this in sync when toggled).
    if (store.getState().shareMonitor) displaySource.connect(sharedAudioContext.destination);
    g.displaySource = displaySource;
    displayStreamRef.current = displayStream;

    // Fire when the user hits the browser's "Stop sharing" UI
    audioTracks[0].addEventListener("ended", () => {
      stopAudioShare();
    });

    store.getState().setSharingAudio(true);

    // Local feedback.
    playCue(sharedAudioContext, "share-start");
  }, [store, ensureOutGraph, stopAudioShare]);

  const toggleAudioShare = useCallback(async () => {
    if (store.getState().isSharingAudio) await stopAudioShare();
    else await startAudioShare();
  }, [store, startAudioShare, stopAudioShare]);

  // --- File streaming: stream a local audio file into the call as a SEPARATE
  // stereo "file" producer. Independent of the audio share; the file is decoded
  // by one of two persistent <audio> slots whose Web Audio source feeds its own
  // destination (produced) and the local speakers (monitored). Like a share it
  // forces SFU and is auto-tapped by recording/streaming server-side. ---

  // Build the two persistent file slots lazily (called once per session, on
  // first file start). Each slot: createMediaElementSource once, xfadeGain once,
  // connected source → xfadeGain → fileVolumeGain → outDest. Active slot
  // xfadeGain = 1, idle = 0. The file mixes into the voice track directly;
  // no separate producer or duck gain on the sent path.
  // The single "streamer volume" node: files, URL streams and TV all feed it, and
  // it feeds outDest (room) + the local monitor. Created lazily, once.
  const ensureFileVolumeGain = useCallback(
    (g: NonNullable<typeof outGraphRef.current>) => {
      if (!g.fileVolumeGain) {
        g.fileVolumeGain = sharedAudioContext.createGain();
        g.fileVolumeGain.gain.value = store.getState().fileVolume;
        g.fileVolumeGain.connect(g.outDest);
        // Local monitor: the streamer hears the file through the SAME volume node
        // that feeds the room, so lowering "volume for all" lowers it for the
        // streamer too (and the crossfade is audible locally). One shared
        // connection on the volume node — no per-slot source → destination wires.
        g.fileVolumeGain.connect(sharedAudioContext.destination);
        // Also feed the ambience reverb, so the music you play is heard "in" the
        // room's space too (wet return handled by reverbWet; dry until picked).
        g.fileVolumeGain.connect(g.reverbInput);
      }
      return g.fileVolumeGain;
    },
    [store],
  );

  const ensureFileSlots = useCallback(
    (g: NonNullable<typeof outGraphRef.current>) => {
      if (g.fileSlots) return g.fileSlots;

      // Ensure the shared volume node is ready before wiring slots into it.
      ensureFileVolumeGain(g);

      const makeSlot = (active: boolean): FileSlot => {
        const audioEl = new Audio();
        (audioEl as unknown as Record<string, boolean>).playsInline = true;
        const source = sharedAudioContext.createMediaElementSource(audioEl);
        const xfadeGain = sharedAudioContext.createGain();
        xfadeGain.gain.value = active ? 1 : 0;
        source.connect(xfadeGain);
        xfadeGain.connect(g.fileVolumeGain!);
        return { audioEl, source, xfadeGain, abortCtrl: null, objectUrl: null };
      };

      g.fileSlots = [makeSlot(true), makeSlot(false)];
      return g.fileSlots;
    },
    [ensureFileVolumeGain],
  );

  // Load a new track into a slot: revoke its previous object URL, swap .src,
  // re-bind ended/error with a fresh AbortController. The source node and
  // xfadeGain are untouched (they are permanent). Returns the slot. Tracks
  // always start from the beginning (no resume).
  const loadIntoSlot = useCallback(
    (
      slot: FileSlot,
      src: string,
      objectUrl: string | undefined,
      onEnded: () => void,
      onError: () => void,
    ): FileSlot => {
      // Revoke previous AbortController so stale ended/error don't fire.
      slot.abortCtrl?.abort();
      // Revoke the previous object URL for this slot.
      if (slot.objectUrl) {
        URL.revokeObjectURL(slot.objectUrl);
      }
      slot.objectUrl = objectUrl ?? null;
      slot.audioEl.pause();
      slot.audioEl.src = src;

      const ac = new AbortController();
      slot.abortCtrl = ac;
      slot.audioEl.addEventListener("ended", onEnded, { signal: ac.signal });
      slot.audioEl.addEventListener("error", onError, { signal: ac.signal });
      return slot;
    },
    [],
  );

  const stopFileStream = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (store.getState().fileStreamName == null) return;
      const g = outGraphRef.current;
      // Abort ended/error listeners on both slots before teardown so they
      // cannot re-trigger stopFileStream recursively.
      if (g?.fileSlots) {
        // Use indexed access + local destructuring so the linter doesn't trace
        // mutations back to outGraphRef through a for-of loop variable.
        for (let i = 0; i < 2; i++) {
          const { abortCtrl, audioEl, source, xfadeGain, objectUrl } = g.fileSlots[i]!;
          abortCtrl?.abort();
          audioEl.pause();
          audioEl.src = "";
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          source.disconnect();
          xfadeGain.disconnect();
        }
        g.fileSlots = null;
        g.activeSlot = 0;
      }
      // Tear down a TV channel if one is playing. Keep the element + source node
      // (reused next time); just unload Shaka, pause, and disconnect the source.
      // Awaited (not fire-and-forget) so a fast channel re-switch — which reuses
      // the same tvPlayerRef.current for configure()/load() right after this
      // returns — can't race an in-flight unload().
      if (tvPlayerRef.current) {
        await tvPlayerRef.current.unload().catch(() => {});
      }
      tvAudioRef.current?.pause();
      try {
        tvSourceRef.current?.disconnect();
      } catch {
        /* not connected */
      }
      tvActiveRef.current = false;
      // Tear down series playback (keep the element + source node, reused next time).
      serieAudioRef.current?.pause();
      if (serieAudioRef.current) serieAudioRef.current.src = "";
      try {
        serieSourceRef.current?.disconnect();
      } catch {
        /* not connected */
      }
      if (serieProgressTimerRef.current) {
        clearTimeout(serieProgressTimerRef.current);
        serieProgressTimerRef.current = null;
      }
      serieActiveRef.current = false;
      serieEpisodesRef.current = [];
      serieNameRef.current = null;
      store.getState().clearSerie();
      if (g) {
        g.fileVolumeGain?.disconnect();
        g.fileVolumeGain = null;
      }
      store.getState().setFileStream(null);
      store.getState().setFileStreamPlaying(false);
      store.getState().setPlayerIsUrl(false);
      // Revoke all playlist object URLs to avoid memory leaks. The slot
      // teardown above already revoked the two per-slot objectUrls; here we
      // handle any remaining entries in the playlist that were not yet played.
      const { playlist } = store.getState();
      for (const track of playlist) {
        try {
          URL.revokeObjectURL(track.objectUrl);
        } catch {
          /* best-effort */
        }
      }
      store.getState().setPlaylist([]);
      store.getState().setPlaylistIndex(0);
      shuffleOrderRef.current = [];
      // Cancel any pending stale fade-pause timers so they don't fire after
      // teardown and try to pause a future track.
      for (let i = 0; i < 2; i++) {
        if (fadeTimerRef.current[i as 0 | 1] !== null) {
          clearTimeout(fadeTimerRef.current[i as 0 | 1]!);
          fadeTimerRef.current[i as 0 | 1] = null;
        }
      }
      // File now mixes into the voice track — no server-side pin or producer to
      // close. Play the cue, unless the caller wants a silent teardown (e.g.
      // startTvChannel switching channels).
      if (!opts?.silent) playCue(sharedAudioContext, "share-stop");
    },
    [store],
  );

  // Cross-fade the active file slot OUT and a new track (loaded into the idle
  // slot) IN. Plays the idle slot, ramps idle 0→1 and active 1→0, flips
  // activeSlot, then pauses the old element after the fade. The new track
  // becomes the active stream (`name`); its saved position is restored by name
  // on metadata load. Only gain values change — the fileVolumeGain → outDest /
  // monitor chain is untouched, so there is no producer/SFU flicker. Shared by
  // playTrack (playlist navigation) and startFileSource (a fresh pick while
  // something is already playing) so both fade instead of cutting.
  const crossfadeTo = useCallback(
    async (
      g: NonNullable<typeof outGraphRef.current>,
      src: string,
      name: string,
      objectUrl: string | undefined,
      onEnded: () => void,
    ) => {
      const slots = ensureFileSlots(g);
      const activeIdx = g.activeSlot;
      const idleIdx: 0 | 1 = activeIdx === 0 ? 1 : 0;
      const idleSlot = slots[idleIdx]!;
      const activeSlotNode = slots[activeIdx]!;

      // Invalidate any pending fade-pause timer for the IDLE slot before we load
      // and play a new track in it. On a rapid skip the previous crossfade may
      // have scheduled a 5τ "pause the old element" timer targeting this very
      // slot; without bumping its generation that stale timer would fire and
      // pause the NEW track a few seconds in (the "plays then goes silent" bug).
      fadeGenRef.current[idleIdx] = (fadeGenRef.current[idleIdx]! + 1) & 0xffff;
      if (fadeTimerRef.current[idleIdx] !== null) {
        clearTimeout(fadeTimerRef.current[idleIdx]!);
        fadeTimerRef.current[idleIdx] = null;
      }

      // Load the idle slot (abort old ended/error, swap .src). Source node and
      // xfadeGain are permanent. objectUrl is undefined for playlist-owned URLs
      // (bulk-revoked on stop) so revisiting an earlier track still has a live URL.
      // The track starts from the beginning (no resume).
      loadIntoSlot(idleSlot, src, objectUrl, onEnded, () => void stopFileStream());

      // Start the idle slot at gain 0; the ramp brings it up.
      idleSlot.xfadeGain.gain.setValueAtTime(0, sharedAudioContext.currentTime);
      try {
        await idleSlot.audioEl.play();
      } catch {
        /* autoplay refused; the user can press play */
      }

      // Ramp: idle slot 0→1, active slot 1→0 over ~3 s (XFADE_TAU time-constant).
      const now = sharedAudioContext.currentTime;
      idleSlot.xfadeGain.gain.setTargetAtTime(1, now, XFADE_TAU);
      activeSlotNode.xfadeGain.gain.setTargetAtTime(0, now, XFADE_TAU);

      // Flip activeSlot immediately so new ended events bind to the right slot.
      g.activeSlot = idleIdx;

      // Pause the old-active element after the fade completes (5×τ ≈ 99.3%). A
      // generation counter makes a rapid re-fade on the same slot cancel this
      // stale pause (otherwise it would pause the NEW track loaded into the slot
      // while this timer was pending).
      const oldActive = activeSlotNode;
      const oldActiveIdx = activeIdx;
      fadeGenRef.current[oldActiveIdx] = (fadeGenRef.current[oldActiveIdx]! + 1) & 0xffff;
      const capturedGen = fadeGenRef.current[oldActiveIdx]!;
      if (fadeTimerRef.current[oldActiveIdx] !== null) {
        clearTimeout(fadeTimerRef.current[oldActiveIdx]!);
        fadeTimerRef.current[oldActiveIdx] = null;
      }
      fadeTimerRef.current[oldActiveIdx] = window.setTimeout(
        () => {
          fadeTimerRef.current[oldActiveIdx] = null;
          if (fadeGenRef.current[oldActiveIdx] !== capturedGen) return;
          oldActive.audioEl.pause();
        },
        XFADE_TAU * 5 * 1000,
      );

      store.getState().setFileStream(name);
      store.getState().setFileStreamPlaying(true);
    },
    [store, ensureFileSlots, loadIntoSlot, stopFileStream],
  );

  const startFileSource = useCallback(
    async (src: string, name: string, objectUrl?: string) => {
      const g = ensureOutGraph();
      resumeSharedContext();

      // If a TV channel is the current source, tear it down first (its audio
      // can't cross-fade — it's a live Shaka stream), so this starts fresh, not
      // alongside.
      if (tvActiveRef.current) await stopFileStream({ silent: true });
      if (serieActiveRef.current) await stopFileStream({ silent: true });

      const firstStart = store.getState().fileStreamName == null;

      // Build (or reuse) the two persistent slots and the shared chain
      // (slots → xfadeGain → fileVolumeGain → outDest + local monitor).
      const slots = ensureFileSlots(g);

      // Something is already playing → cross-fade the new track in (fade the
      // current one out) instead of cutting it. Single track, so it ends → stop.
      if (!firstStart) {
        await crossfadeTo(g, src, name, objectUrl, () => void stopFileStream());
        return;
      }

      // First start: nothing is playing — load straight into the active slot.
      const slotIdx = g.activeSlot;
      const slot = slots[slotIdx];

      loadIntoSlot(
        slot,
        src,
        objectUrl,
        () => void stopFileStream(),
        () => void stopFileStream(),
      );

      // Active slot xfadeGain = 1; idle slot remains at 0.
      slot.xfadeGain.gain.value = 1;
      slots[slotIdx === 0 ? 1 : 0].xfadeGain.gain.value = 0;

      store.getState().setFileStream(name);
      try {
        await slot.audioEl.play();
        store.getState().setFileStreamPlaying(true);
      } catch {
        // Autoplay refused (rare — we're in a user gesture); land paused so the
        // window's play button can start it.
        store.getState().setFileStreamPlaying(false);
      }

      // File mixes into the voice track (outDest) — no SFU pin, no separate
      // producer. Play the cue.
      playCue(sharedAudioContext, "share-start");
    },
    [store, ensureOutGraph, ensureFileSlots, loadIntoSlot, stopFileStream, crossfadeTo],
  );

  const startUrlStream = useCallback(
    async (rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid URL");
      const name = decodeURIComponent(
        url.pathname.split("/").filter(Boolean).pop() ?? url.hostname,
      );
      // Mark URL-stream mode so the player shows only the volume control.
      store.getState().setPlayerIsUrl(true);
      await startFileSource(`/api/audio-proxy?url=${encodeURIComponent(url.href)}`, name);
    },
    [store, startFileSource],
  );

  // Play a live-TV channel (DASH + ClearKey) through Shaka into a dedicated
  // <audio> element, whose output is routed into fileVolumeGain — same shared
  // node as files/URL streams, so TV never gets its own producer or SFU pin.
  const startTvChannel = useCallback(
    async (channel: Channel) => {
      const g = ensureOutGraph();
      resumeSharedContext();

      // One streamer source at a time — stop whatever's playing (silent: switching
      // channels shouldn't chime).
      await stopFileStream({ silent: true });

      const fvg = ensureFileVolumeGain(g);

      try {
        // Lazy-load Shaka the first time TV is used (keeps it out of the main bundle).
        const shaka = (await import("shaka-player")).default;
        shaka.polyfill.installAll();
        if (!shaka.Player.isBrowserSupported()) {
          store.getState().announce(m.tv_unsupported());
          throw new Error("unsupported");
        }

        // Dedicated <audio> + Web Audio source, made once and reused.
        if (!tvAudioRef.current) {
          const el = new Audio();
          (el as unknown as Record<string, boolean>).playsInline = true;
          el.crossOrigin = "anonymous";
          tvAudioRef.current = el;
          tvSourceRef.current = sharedAudioContext.createMediaElementSource(el);
        }
        tvSourceRef.current!.connect(fvg);

        if (!tvPlayerRef.current) {
          tvPlayerRef.current = new shaka.Player(tvAudioRef.current);
        }
        const player = tvPlayerRef.current;
        const clearKeys = parseClearKey(channel.key);
        // Audio only: restrict video (maxHeight 0) so Shaka picks the audio-only
        // variant and never downloads the video track — we play into an <audio>
        // element and re-broadcast to the room, so the video would be pure waste.
        player.configure({
          drm: clearKeys ? { clearKeys } : {},
          restrictions: { maxHeight: 0 },
        });
        await player.load(channel.url);
        await tvAudioRef.current.play().catch(() => {});

        // TV is now the active streamer source — startFileSource/startPlaylist
        // check this to force a clean teardown before starting (TV can't cross-fade).
        tvActiveRef.current = true;

        store.getState().setFileStream(channel.nombre);
        store.getState().setPlayerIsUrl(true);
        store.getState().setFileStreamPlaying(true);
      } catch (err) {
        // Clean up the half-established TV path so a later stopFileStream doesn't skip it.
        try {
          tvSourceRef.current?.disconnect();
        } catch {
          /* not connected */
        }
        try {
          await tvPlayerRef.current?.unload();
        } catch {
          /* nothing loaded */
        }
        tvAudioRef.current?.pause();
        tvActiveRef.current = false;
        // If this was the unsupported case we already announced; otherwise announce a generic error.
        if (!(err instanceof Error && err.message === "unsupported")) {
          store.getState().announce(m.tv_play_error());
        }
        throw err; // let the dialog react too
      }
    },
    [ensureOutGraph, ensureFileVolumeGain, stopFileStream, store],
  );

  // Save the current position, debounced (called from timeupdate + pause).
  const saveSerieProgress = useCallback(() => {
    const name = serieNameRef.current;
    const el = serieAudioRef.current;
    if (!name || !el) return;
    if (serieProgressTimerRef.current) clearTimeout(serieProgressTimerRef.current);
    serieProgressTimerRef.current = setTimeout(() => {
      saveProgress(name, { episode: serieIndexRef.current, time: el.currentTime });
    }, 1000);
  }, []);

  // timeupdate: detect which episode currentTime is in; on change, update the
  // store (selectors + season) and announce the new episode title.
  const onSerieTimeUpdate = useCallback(() => {
    const el = serieAudioRef.current;
    const episodes = serieEpisodesRef.current;
    if (!el || !episodes.length) return;
    const idx = episodeIndexAt(episodes, el.currentTime);
    if (idx !== serieIndexRef.current) {
      serieIndexRef.current = idx;
      const ep = episodes[idx]!;
      store.getState().setSerieEpisode(idx, ep.tn);
      store.getState().announce(ep.titulo);
    }
    saveSerieProgress();
  }, [store, saveSerieProgress]);

  const startSerie = useCallback(
    async (serie: Serie) => {
      const g = ensureOutGraph();
      resumeSharedContext();
      await stopFileStream({ silent: true });
      const fvg = ensureFileVolumeGain(g);

      const episodes = flattenEpisodes(serie);
      if (!episodes.length) {
        store.getState().announce(m.serie_empty());
        return;
      }

      // Resume from saved progress if the entry is well-formed and the episode
      // still exists (loadProgress isn't shape-validated — a malformed time/
      // episode must not flow into el.currentTime, which would throw).
      const prog = loadProgress()[serie.nombre];
      const resumable =
        !!prog &&
        Number.isInteger(prog.episode) &&
        Number.isFinite(prog.time) &&
        !!episodes[prog.episode];
      const idx = resumable ? prog.episode : 0;
      const startTime = resumable ? prog.time : episodes[idx]!.inicio / 1000;

      try {
        if (!serieAudioRef.current) {
          const el = new Audio();
          (el as unknown as Record<string, boolean>).playsInline = true;
          el.crossOrigin = "anonymous";
          el.addEventListener("timeupdate", () => onSerieTimeUpdate());
          // `play`/`pause` are the single source of truth for fileStreamPlaying
          // while a series is active — every path that starts/stops playback
          // (toggle, episode seek, next/prev/restart) routes through el.play()/
          // el.pause(), so listening here keeps the footer button + Alt+K state
          // correct without every call site having to set it explicitly.
          el.addEventListener("play", () => store.getState().setFileStreamPlaying(true));
          el.addEventListener("pause", () => {
            saveSerieProgress();
            store.getState().setFileStreamPlaying(false);
          });
          el.addEventListener("ended", () => store.getState().setFileStreamPlaying(false));
          serieAudioRef.current = el;
          serieSourceRef.current = sharedAudioContext.createMediaElementSource(el);
        }
        serieSourceRef.current!.connect(fvg);

        serieEpisodesRef.current = episodes;
        serieIndexRef.current = idx;
        serieNameRef.current = serie.nombre;

        const el = serieAudioRef.current;
        el.src = serieAudioSrc(serie.enlace);
        const seek = () => {
          el.currentTime = startTime;
          el.play().catch(() => {});
        };
        el.addEventListener("canplay", seek, { once: true });
        el.load();

        serieActiveRef.current = true;
        store.getState().setSerie({
          name: serie.nombre,
          episodes,
          seasons: seasonsOf(serie),
          index: idx,
          season: episodes[idx]!.tn,
        });
        store.getState().setFileStream(serie.nombre);
        store.getState().setPlayerIsUrl(false);
        store.getState().setFileStreamPlaying(true);
      } catch (err) {
        try {
          serieSourceRef.current?.disconnect();
        } catch {
          /* not connected */
        }
        serieAudioRef.current?.pause();
        serieActiveRef.current = false;
        store.getState().announce(m.serie_play_error());
        throw err;
      }
    },
    [
      ensureOutGraph,
      ensureFileVolumeGain,
      stopFileStream,
      store,
      onSerieTimeUpdate,
      saveSerieProgress,
    ],
  );

  const serieSeekEpisode = useCallback(
    (index: number) => {
      const el = serieAudioRef.current;
      const episodes = serieEpisodesRef.current;
      const ep = episodes[index];
      if (!el || !ep) return;
      serieIndexRef.current = index;
      store.getState().setSerieEpisode(index, ep.tn);
      el.currentTime = ep.inicio / 1000;
      el.play().catch(() => {});
      store.getState().announce(ep.titulo);
    },
    [store],
  );

  const serieNextEpisode = useCallback(() => {
    const i = serieIndexRef.current;
    if (i < serieEpisodesRef.current.length - 1) serieSeekEpisode(i + 1);
  }, [serieSeekEpisode]);

  const seriePrevEpisode = useCallback(() => {
    const i = serieIndexRef.current;
    if (i > 0) serieSeekEpisode(i - 1);
  }, [serieSeekEpisode]);

  const serieRestartEpisode = useCallback(() => {
    serieSeekEpisode(serieIndexRef.current);
  }, [serieSeekEpisode]);

  const serieSelectSeason = useCallback(
    (numero: number) => {
      const i = serieEpisodesRef.current.findIndex((e) => e.tn === numero);
      if (i >= 0) serieSeekEpisode(i);
    },
    [serieSeekEpisode],
  );

  // --- Folder playlist: crossfade-based track navigation ---

  // Fisher-Yates shuffle returning a new array of indices [0..len-1].
  const shuffleIndices = (len: number): number[] => {
    const arr = Array.from({ length: len }, (_, i) => i);
    for (let i = len - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  };

  // Cross-fade to a track by playlist index. Delegates the slot/ramp mechanics
  // to crossfadeTo; here we just resolve the index, set it, and build the
  // playlist-aware auto-advance ended handler.
  const playTrack = useCallback(
    async (index: number) => {
      const state = store.getState();
      const { playlist } = state;
      if (playlist.length === 0 || index < 0 || index >= playlist.length) return;
      const track = playlist[index]!;

      state.setPlaylistIndex(index);

      const g = ensureOutGraph();
      resumeSharedContext();

      // The ended handler for this track. Uses playTrackRef so the closure
      // always calls the latest version of playTrack without a forward-reference
      // lint error (playTrack hasn't been returned yet when this function runs).
      const onEnded = () => {
        const s = store.getState();
        const repeat: PlayerRepeat = s.playerRepeat;
        const pt = playTrackRef.current;
        if (!pt) return;
        if (repeat === "one") {
          void pt(s.playlistIndex);
        } else {
          // Determine the next track index (respecting shuffle).
          const pl = s.playlist;
          if (pl.length === 0) return;
          let nextIdx: number;
          if (s.playerShuffle) {
            const order = shuffleOrderRef.current;
            const pos = order.indexOf(s.playlistIndex);
            if (pos < 0 || pos >= order.length - 1) {
              // At the end of shuffled order.
              if (repeat === "all") {
                // Rebuild shuffle order and start again.
                const newOrder = shuffleIndices(pl.length);
                shuffleOrderRef.current = newOrder;
                nextIdx = newOrder[0]!;
              } else {
                void stopFileStream();
                return;
              }
            } else {
              nextIdx = order[pos + 1]!;
            }
          } else {
            const cur = s.playlistIndex;
            if (cur >= pl.length - 1) {
              if (repeat === "all") {
                nextIdx = 0;
              } else {
                void stopFileStream();
                return;
              }
            } else {
              nextIdx = cur + 1;
            }
          }
          void pt(nextIdx);
        }
      };

      // Playlist-owned URLs are bulk-revoked in stopFileStream, so pass undefined
      // for objectUrl — letting the slot revoke them here would break playerPrev
      // (the URL would already be gone when revisiting an earlier track).
      await crossfadeTo(g, track.objectUrl, track.name, undefined, onEnded);
    },
    [store, ensureOutGraph, crossfadeTo, stopFileStream],
  );
  // Keep the ref in sync so ended handlers always call the latest playTrack.
  playTrackRef.current = playTrack;

  // playerNext: advance to the next track respecting shuffle and repeat.
  const playerNext = useCallback(() => {
    const state = store.getState();
    const { playlist, playlistIndex, playerShuffle, playerRepeat: repeat } = state;
    if (playlist.length === 0) return;
    let nextIdx: number;
    if (playerShuffle) {
      const order = shuffleOrderRef.current;
      const pos = order.indexOf(playlistIndex);
      if (pos < 0 || pos >= order.length - 1) {
        if (repeat === "all" || repeat === "one") {
          const newOrder = shuffleIndices(playlist.length);
          shuffleOrderRef.current = newOrder;
          nextIdx = newOrder[0]!;
        } else {
          return; // at end, no wrap
        }
      } else {
        nextIdx = order[pos + 1]!;
      }
    } else {
      if (playlistIndex >= playlist.length - 1) {
        if (repeat === "all" || repeat === "one") {
          nextIdx = 0;
        } else {
          return; // at end, no wrap
        }
      } else {
        nextIdx = playlistIndex + 1;
      }
    }
    void playTrack(nextIdx);
  }, [store, playTrack]);

  // playerPrev: go back to the previous track (or restart if near the beginning).
  const playerPrev = useCallback(() => {
    const state = store.getState();
    const { playlist, playlistIndex, playerShuffle } = state;
    if (playlist.length === 0) return;
    let prevIdx: number;
    if (playerShuffle) {
      const order = shuffleOrderRef.current;
      const pos = order.indexOf(playlistIndex);
      prevIdx = pos > 0 ? order[pos - 1]! : order[order.length - 1]!;
    } else {
      prevIdx = playlistIndex > 0 ? playlistIndex - 1 : playlist.length - 1;
    }
    void playTrack(prevIdx);
  }, [store, playTrack]);

  // Toggle shuffle AND rebuild the play order so the change takes effect now.
  // (Before, the order was only built at playlist load, so flipping shuffle
  // mid-playback left a stale sequential order — "next" kept going in sequence.)
  // Turning on: a random order with the current track first, so playback
  // continues and "next" jumps to a random track. Turning off: sequential.
  const togglePlayerShuffle = useCallback(() => {
    const s = store.getState();
    const on = !s.playerShuffle;
    s.setPlayerShuffle(on);
    const len = s.playlist.length;
    if (len === 0) {
      shuffleOrderRef.current = [];
      return;
    }
    if (on) {
      const rest = shuffleIndices(len).filter((i) => i !== s.playlistIndex);
      shuffleOrderRef.current = [s.playlistIndex, ...rest];
    } else {
      shuffleOrderRef.current = Array.from({ length: len }, (_, i) => i);
    }
  }, [store]);

  // Start a playlist from an array of Files. Filters to audio files, builds
  // object URLs, persists the playlist in the store, and starts track 0.
  // A single-file array produces a 1-item playlist.
  // Start (or switch to) a playlist from an ALREADY-ORDERED list of audio files.
  // Builds object URLs, sets the playlist, picks the play order (shuffle/
  // sequential), and starts the first track via playTrack — which cross-fades in
  // if something is already playing, so switching folders/files mid-playback
  // never cuts the current track.
  const startPlaylist = useCallback(
    async (orderedFiles: File[]) => {
      const audioFiles = orderedFiles.filter(
        (f) =>
          f.type.startsWith("audio/") ||
          AUDIO_EXTENSIONS.has(f.name.split(".").pop()?.toLowerCase() ?? ""),
      );
      if (audioFiles.length === 0) return;

      // Local files/folder → not a URL stream (the player shows full controls).
      store.getState().setPlayerIsUrl(false);

      // If a TV channel is the current source, tear it down first (its audio
      // can't cross-fade — it's a live Shaka stream), so this starts fresh, not
      // alongside.
      if (tvActiveRef.current) await stopFileStream({ silent: true });
      if (serieActiveRef.current) await stopFileStream({ silent: true });

      const firstStart = store.getState().fileStreamName == null;
      const oldPlaylist = store.getState().playlist;

      const playlist = audioFiles.map((f) => ({
        name: f.name,
        objectUrl: URL.createObjectURL(f),
        // Folder-relative path (e.g. "Álbum/Disco 1/01 tema.mp3") so the player
        // can render a folder tree; a plain file pick has no webkitRelativePath.
        path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
      }));
      store.getState().setPlaylist(playlist);

      // Build the navigation order (shuffled or sequential), then start the
      // first track via playTrack — it cross-fades in and binds the
      // playlist-aware auto-advance/ended handler.
      shuffleOrderRef.current = store.getState().playerShuffle
        ? shuffleIndices(playlist.length)
        : Array.from({ length: playlist.length }, (_, i) => i);
      const firstIdx = shuffleOrderRef.current[0]!;

      await playTrack(firstIdx);

      // File mixes into the voice track (outDest) — no SFU pin. Cue on first start.
      if (firstStart) playCue(sharedAudioContext, "share-start");

      // Switched playlists while playing: revoke the OLD playlist's object URLs,
      // but only after the crossfade tail so the still-fading outgoing track is
      // not cut. (The new playlist's URLs are bulk-revoked by stopFileStream.)
      if (!firstStart && oldPlaylist.length > 0) {
        const stale = oldPlaylist.map((t) => t.objectUrl);
        window.setTimeout(
          () => {
            for (const u of stale) {
              try {
                URL.revokeObjectURL(u);
              } catch {
                /* already revoked */
              }
            }
          },
          XFADE_TAU * 5 * 1000 + 500,
        );
      }
    },
    [store, playTrack, stopFileStream],
  );

  // Folder picker fallback (<input webkitdirectory>): order the files by relative
  // path (folder order, subfolders included) then start the playlist.
  const startFolderStream = useCallback(
    async (files: File[]) => {
      const ordered = [...files].sort((a, b) => {
        const pa = (a as File & { webkitRelativePath?: string }).webkitRelativePath ?? a.name;
        const pb = (b as File & { webkitRelativePath?: string }).webkitRelativePath ?? b.name;
        return pa.localeCompare(pb);
      });
      await startPlaylist(ordered);
    },
    [startPlaylist],
  );

  // Play/pause the active streamer. A playing series routes to serieAudioRef
  // (its own <audio> element, separate from the file-slot chain) — otherwise
  // this acts on the active file slot, as before. fileStreamPlaying is kept in
  // sync via the `play`/`pause` listeners wired on each element.
  const toggleFilePlayback = useCallback(() => {
    if (serieActiveRef.current) {
      const el = serieAudioRef.current;
      if (!el) return;
      if (el.paused) void el.play().catch(() => {});
      else el.pause();
      return;
    }
    const g = outGraphRef.current;
    const el = g?.fileSlots?.[g.activeSlot]?.audioEl;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => {});
      store.getState().setFileStreamPlaying(true);
    } else {
      el.pause();
      store.getState().setFileStreamPlaying(false);
    }
  }, [store]);

  // Set the source-side file volume for ALL listeners. Persists the value and
  // ramps the fileVolumeGain node live. A short 5 ms time-constant makes it feel
  // immediate — like a radio-console fader — while still being click-safe (a raw
  // setValueAtTime jump would pop, especially on a big Ctrl+arrow step).
  const setPlayerVolume = useCallback(
    (v: number) => {
      store.getState().setFileVolume(v);
      const gain = outGraphRef.current?.fileVolumeGain;
      if (gain) gain.gain.setTargetAtTime(v, sharedAudioContext.currentTime, 0.005);
    },
    [store],
  );

  // Seek the active streamer by `sec` seconds (clamped to [0, duration]). Routes
  // to the series element while a series is active — see toggleFilePlayback.
  const playerSeekBy = useCallback((sec: number) => {
    if (serieActiveRef.current) {
      const el = serieAudioRef.current;
      if (!el) return;
      el.currentTime = Math.min(el.duration || Infinity, Math.max(0, el.currentTime + sec));
      return;
    }
    const g = outGraphRef.current;
    const el = g?.fileSlots?.[g.activeSlot]?.audioEl;
    if (!el) return;
    el.currentTime = Math.min(el.duration || 0, Math.max(0, el.currentTime + sec));
  }, []);

  // Seek the active streamer to an absolute position (clamped to [0, duration]).
  const playerSeekTo = useCallback((sec: number) => {
    if (serieActiveRef.current) {
      const el = serieAudioRef.current;
      if (!el) return;
      el.currentTime = Math.min(el.duration || Infinity, Math.max(0, sec));
      return;
    }
    const g = outGraphRef.current;
    const el = g?.fileSlots?.[g.activeSlot]?.audioEl;
    if (!el) return;
    el.currentTime = Math.min(el.duration || 0, Math.max(0, sec));
  }, []);

  // Toggle play/pause — alias exposed under the brief's name.
  const playerTogglePlay = toggleFilePlayback;

  // Subscribe timeupdate / durationchange / loadedmetadata on the active slot's
  // element so the store stays current. Throttle writes to ~250 ms so React
  // doesn't re-render at 60 fps while seeking. Re-runs whenever the active slot
  // element changes (track swap writes a new audioEl into the slot).
  //
  // We poll via a ref rather than subscribing to audioEl directly, because the
  // slot element is stable for the session — only .src changes. The listeners
  // are lightweight (no allocation; store.setPlayerTime is a zustand setter).
  useEffect(() => {
    let lastWrite = 0;
    let rafId: number | null = null;

    const tick = () => {
      const g = outGraphRef.current;
      const el = serieActiveRef.current
        ? serieAudioRef.current
        : g?.fileSlots?.[g.activeSlot]?.audioEl;
      if (!el) return;
      const now = performance.now();
      if (now - lastWrite >= 250) {
        lastWrite = now;
        store.getState().setPlayerTime(isFinite(el.currentTime) ? el.currentTime : 0);
        store.getState().setPlayerDuration(isFinite(el.duration) ? el.duration : 0);
      }
      rafId = requestAnimationFrame(tick);
    };

    // Only run the loop while we have an active file stream.
    const unsubscribe = useRoomStore.subscribe((s) => {
      if (s.fileStreamName != null && rafId == null) {
        rafId = requestAnimationFrame(tick);
      } else if (s.fileStreamName == null && rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
        store.getState().setPlayerTime(0);
        store.getState().setPlayerDuration(0);
      }
    });

    return () => {
      unsubscribe();
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [store]);

  // --- Recording ---
  // Recording is server-side: the server taps every participant's stream off
  // the SFU. Starting it forces the room out of P2P (the server can't see P2P
  // media). Download happens via /api/recordings/:id/download at any time.
  const startRecording = useCallback(async () => {
    if (store.getState().isRecording) return;
    try {
      const res = await emit<{ recordingId: string }>("start-recording");
      store.getState().setRecording(true, res.recordingId);
      // Local-only confirmation — recording is NOT announced to the room.
      store.getState().announce(announce_recording_on());
    } catch (err) {
      console.error("[recording] failed to start:", err);
      store.getState().announceEvent(announce_recording_failed());
    }
  }, [emit, store]);

  const stopRecording = useCallback(async () => {
    if (!store.getState().isRecording) return;
    try {
      await emit("stop-recording");
    } catch (err) {
      console.error("[recording] failed to stop:", err);
    }
    // Mark stopped locally but keep recordingId so the download link remains
    // until the file expires. Local-only confirmation (not announced to the room).
    store.getState().setRecording(false);
    store.getState().announce(announce_recording_off());
  }, [emit, store]);

  const toggleRecording = useCallback(async () => {
    if (store.getState().isRecording) await stopRecording();
    else await startRecording();
  }, [startRecording, stopRecording, store]);

  // --- Force SFU (Ctrl+Alt+S) ---
  // Pin the room to the SFU (or release it back to automatic P2P/SFU-by-size).
  // Room-wide; the server flips its flag and re-evaluates the transport (so
  // everyone switches). Silent to the room, like recording: only the presser
  // gets a local confirmation; others just adopt the state (see the "force-sfu"
  // handler) so any of them can toggle it too.
  const toggleForceSfu = useCallback(async () => {
    const next = !store.getState().forceSfu;
    try {
      await emit("set-force-sfu", { force: next });
      store.getState().setForceSfu(next);
      store.getState().announce(next ? announce_force_sfu_on() : announce_force_sfu_off());
    } catch (err) {
      console.error("[force-sfu] failed:", err);
    }
  }, [emit, store]);

  // --- Close/open the room (Ctrl+Alt+B) ---
  // Close it so newcomers are ghosted (see the server's join routing): they land
  // in an empty ghost room, never see the real group, and get no message. Silent
  // to the room — only the presser hears a local confirmation. Toggle to reopen.
  const toggleRoomClosed = useCallback(async () => {
    const next = !store.getState().roomClosed;
    try {
      await emit("set-room-closed", { closed: next });
      store.getState().setRoomClosed(next);
      store.getState().announce(next ? announce_room_closed() : announce_room_open());
    } catch (err) {
      console.error("[room-closed] failed:", err);
    }
  }, [emit, store]);

  // Self-admit from a ghost room into the real (closed) room. Ctrl+Alt+B does
  // THIS when we were ghosted (instead of toggling the ghost room): whoever knows
  // the shortcut lets themselves through. The server mints a real-room membership
  // token; we persist it and reconnect, so the rejoin is recognised as a member
  // and routed to the real room. The real room STAYS CLOSED for everyone else.
  const admitToRealRoom = useCallback(async () => {
    const roomName = store.getState().roomName;
    if (!roomName) return;
    try {
      const res = await emit<{ token: string }>("admit-to-room", { roomName });
      try {
        sessionStorage.setItem(`jdh-speak:roomToken:${roomName}`, res.token);
      } catch {
        /* storage blocked — the rejoin below still carries the token in memory
           only if reconnect re-reads it; without storage this can't proceed. */
      }
      store.getState().announce(announce_room_entering());
      // Reconnect: the connect handler rejoins reading the token we just stored,
      // so the server routes us into the real room this time.
      socketRef.current?.disconnect();
      socketRef.current?.connect();
    } catch (err) {
      console.error("[admit] failed:", err);
      store.getState().announce(announce_room_no_admit());
    }
  }, [emit, store]);

  // Change your display name live: persist it, tell the server (which broadcasts
  // peer-renamed to other peers), and reflect it locally.
  const rename = useCallback(
    async (newName: string) => {
      const name = newName
        .trim()
        .replace(/[<>"'&]/g, "")
        .slice(0, 256);
      if (!name) return;
      store.getState().setDisplayName(name);
      await emit("rename", { displayName: name }).catch((err) => {
        console.error("[rename] failed:", err);
      });
    },
    [emit, store],
  );

  // Cycle the room voice bitrate: 128 (original) → 96 → 64 → 32 → 16 → 8 → wrap.
  // Room-wide and shortcut-only — the server broadcasts bitrate-changed back to
  // everyone (us included), which is what actually applies it.
  const cycleRoomBitrate = useCallback(() => {
    const order = [128, 96, 64, 32, 16, 8];
    const idx = order.indexOf(roomBitrateRef.current);
    const next = order[(idx + 1) % order.length] ?? 96;
    void emit("set-bitrate", { kbps: next }).catch(() => {});
  }, [emit]);

  // Diagnostic latency read-out (Ctrl+Alt+L). Measures the REAL numbers from
  // WebRTC stats per participant and announces them on the SR live region, so a
  // blind user gets the figures without the console. Read-only — changes nothing.
  //   red    = network round-trip (candidate-pair currentRoundTripTime)
  //   buffer = our receive jitter buffer (jitterBufferDelay / emittedCount) —
  //            the tunable we set with JITTER_BUFFER_HINT
  //   jitter = inbound-rtp jitter
  //   pérdida = packetsLost / (lost + received)
  // Not shown: the fixed codec + audio-device pipeline (~40–60 ms) that stats
  // can't see; it's the browser floor we can't reduce.
  const announceLatency = useCallback(async () => {
    const peers = store.getState().peers;
    const ms = (s: number | undefined) => (typeof s === "number" ? Math.round(s * 1000) : null);
    const parts: string[] = [];

    const gather = async (peerId: string, getStats: () => Promise<RTCStatsReport>) => {
      const name = peers.get(peerId)?.displayName ?? "?";
      let rtt: number | undefined;
      let jbDelay = 0;
      let jbCount = 0;
      let jitter: number | undefined;
      let lost = 0;
      let recv = 0;
      // Candidate types, to tell a DIRECT path from one relayed through TURN:
      // a relayed pair (either end "relay") roughly doubles the RTT, so it's the
      // first thing to check when the network figure looks too high for direct.
      const candType = new Map<string, string>();
      let pairLocalId: string | undefined;
      let pairRemoteId: string | undefined;
      try {
        const stats = await getStats();
        stats.forEach((r: Record<string, unknown>) => {
          if (r.type === "local-candidate" || r.type === "remote-candidate") {
            candType.set(r.id as string, r.candidateType as string);
          }
          if (
            r.type === "candidate-pair" &&
            r.nominated &&
            typeof r.currentRoundTripTime === "number"
          ) {
            rtt = r.currentRoundTripTime;
            pairLocalId = r.localCandidateId as string;
            pairRemoteId = r.remoteCandidateId as string;
          }
          if (r.type === "remote-inbound-rtp" && typeof r.roundTripTime === "number") {
            rtt = rtt ?? r.roundTripTime;
          }
          if (r.type === "inbound-rtp" && r.kind === "audio") {
            jbDelay = (r.jitterBufferDelay as number) ?? 0;
            jbCount = (r.jitterBufferEmittedCount as number) ?? 0;
            jitter = r.jitter as number;
            lost = (r.packetsLost as number) ?? 0;
            recv = (r.packetsReceived as number) ?? 0;
          }
        });
      } catch {
        return;
      }
      const buffer = jbCount > 0 ? jbDelay / jbCount : undefined;
      const lossPct = lost + recv > 0 ? (lost / (lost + recv)) * 100 : 0;
      const localT = pairLocalId ? candType.get(pairLocalId) : undefined;
      const remoteT = pairRemoteId ? candType.get(pairRemoteId) : undefined;
      // IMPORTANT: in SFU every consumer shares ONE recv transport to the server,
      // so this candidate-pair RTT is OUR leg to the Pi — NOT the path to this
      // peer. With the Pi on the operator's own LAN that reads ~1 ms and looks
      // like near-zero latency, which is a lie: the real mouth-to-ear is this leg
      // PLUS the peer's own leg to the Pi (not visible from here). So in SFU label
      // it honestly as "al servidor". In P2P the pair really is peer-to-peer, so
      // direct/relay is meaningful.
      let path = "";
      if (modeRef.current === "sfu") {
        path = " al servidor";
      } else if (localT || remoteT) {
        path = localT === "relay" || remoteT === "relay" ? " (relay)" : " (directo)";
      }
      parts.push(
        `${name}: red ${ms(rtt) ?? "?"} ms${path}, buffer ${ms(buffer) ?? "?"} ms, ` +
          `jitter ${ms(jitter) ?? "?"} ms, pérdida ${lossPct.toFixed(1)}%`,
      );
    };

    if (modeRef.current === "sfu") {
      for (const [peerId, pa] of peerAudiosRef.current) {
        if (pa.consumer) await gather(peerId, () => pa.consumer!.getStats());
      }
    } else {
      for (const [peerId, pc] of p2pConnectionsRef.current) {
        await gather(peerId, () => pc.getStats());
      }
    }

    store
      .getState()
      .announce(parts.length ? `Latencia. ${parts.join(". ")}` : "No hay conexiones que medir");
  }, [store]);

  // Live mic-gain control: persists the value and ramps the outgoing gain node.
  const setMicGain = useCallback(
    (gain: number) => {
      store.getState().setMicGain(gain);
      const g = outGraphRef.current;
      if (g) {
        g.micGain.gain.setTargetAtTime(gain, sharedAudioContext.currentTime, GAIN_RAMP);
        // The secondary placa rides the same "your volume" level, so its monitor
        // tracks the mic slider just like the primary — and listeners hear it at
        // that level too (monitor == what people receive).
        g.secondaryGain?.gain.setTargetAtTime(gain, sharedAudioContext.currentTime, GAIN_RAMP);
      }
    },
    [store],
  );

  // Send a chat message. Returns why it didn't go out so the caller can keep
  // the text in the box ("empty"/"rate_limited" — never cleared on failure).
  // A blocked send plays the "thunk" cue; the delivered message comes back via
  // the `chat-message` echo, which is what renders/announces/chimes it.
  const sendChatMessage = useCallback(
    async (text: string): Promise<{ ok: boolean; reason?: "empty" | "rate_limited" }> => {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, reason: "empty" };
      if (!chatLimiterRef.current.tryConsume()) {
        playCue(sharedAudioContext, "thunk");
        return { ok: false, reason: "rate_limited" };
      }
      try {
        await emit("chat-message", { text: trimmed });
        return { ok: true };
      } catch {
        // Server rejected (its budget was also spent via the API, or transient).
        playCue(sharedAudioContext, "thunk");
        return { ok: false, reason: "rate_limited" };
      }
    },
    [emit],
  );

  const leave = useCallback(() => {
    detachSharedAudio();
    teardownP2p();
    teardownSfu();
    // Tear down a live series the same way stopFileStream's series block does,
    // so the .m4b stops buffering, timeupdate stops firing onSerieTimeUpdate
    // (phantom announce / progress writes against the reset store), and the RAF
    // ticker no longer sees serieActiveRef true. Element + source node are kept.
    serieAudioRef.current?.pause();
    if (serieAudioRef.current) serieAudioRef.current.src = "";
    try {
      serieSourceRef.current?.disconnect();
    } catch {
      /* not connected */
    }
    if (serieProgressTimerRef.current) {
      clearTimeout(serieProgressTimerRef.current);
      serieProgressTimerRef.current = null;
    }
    serieActiveRef.current = false;
    serieEpisodesRef.current = [];
    serieNameRef.current = null;
    // Same for a live TV channel (stopFileStream's TV block). Fire-and-forget
    // the Shaka unload — nothing re-uses the player after leave().
    void tvPlayerRef.current?.unload().catch(() => {});
    tvAudioRef.current?.pause();
    try {
      tvSourceRef.current?.disconnect();
    } catch {
      /* not connected */
    }
    tvActiveRef.current = false;
    // Tear down the outgoing graph (nodes live in the shared context, so just
    // disconnect them — the context itself is reused for the next room).
    const g = outGraphRef.current;
    if (g) {
      g.micSource?.disconnect();
      g.micGain.disconnect();
      g.limiter.disconnect();
      g.monitorAir.disconnect();
      g.monitorPanner.disconnect();
      g.displaySource?.disconnect();
      // Tear down both file slots: abort listeners, stop elements, revoke URLs,
      // disconnect source nodes. xfadeGain is disconnected per-slot below;
      // fileVolumeGain is disconnected after the slot loop.
      if (g.fileSlots) {
        // Use indexed access + local destructuring so the linter doesn't trace
        // mutations back to outGraphRef through a for-of loop variable.
        for (let i = 0; i < 2; i++) {
          const { abortCtrl, audioEl, source, xfadeGain, objectUrl } = g.fileSlots[i]!;
          abortCtrl?.abort();
          audioEl.pause();
          audioEl.src = "";
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          source.disconnect();
          xfadeGain.disconnect();
        }
        g.fileSlots = null;
      }
      // Cancel any pending stale fade-pause timers.
      for (let i = 0; i < 2; i++) {
        if (fadeTimerRef.current[i as 0 | 1] !== null) {
          clearTimeout(fadeTimerRef.current[i as 0 | 1]!);
          fadeTimerRef.current[i as 0 | 1] = null;
        }
      }
      g.fileVolumeGain?.disconnect();
      // Secondary device: disconnect nodes and stop the MediaStream tracks.
      g.secondarySource?.disconnect();
      g.secondaryGain?.disconnect();
      g.secondaryStream?.getTracks().forEach((t) => t.stop());
      outGraphRef.current = null;
    }
    // Cancel any pending coalesced mute/duck announcements.
    for (const s of surfaceRef.current.values()) {
      if (s.timer !== null) clearTimeout(s.timer);
    }
    surfaceRef.current.clear();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    deviceRef.current = null;
    // Revoke any remaining playlist object URLs before reset() clears the array.
    for (const track of store.getState().playlist) {
      try {
        URL.revokeObjectURL(track.objectUrl);
      } catch {
        /* best-effort */
      }
    }
    store.getState().reset();
  }, [teardownP2p, teardownSfu, detachSharedAudio, store]);

  useEffect(() => {
    return () => {
      leave();
    };
  }, [leave]);

  return {
    join,
    leave,
    mute,
    unmute,
    toggleMute,
    toggleDeafen,
    toggleAudioShare,
    startPlaylist,
    startFolderStream,
    startUrlStream,
    startTvChannel,
    startSerie,
    serieSeekEpisode,
    serieNextEpisode,
    seriePrevEpisode,
    serieRestartEpisode,
    serieSelectSeason,
    stopFileStream,
    playTrack,
    playerNext,
    playerPrev,
    togglePlayerShuffle,
    toggleFilePlayback,
    playerTogglePlay,
    playerSeekBy,
    playerSeekTo,
    setPlayerVolume,
    toggleRecording,
    startRecording,
    stopRecording,
    rename,
    cycleRoomBitrate,
    announceLatency,
    setPeerVolume,
    setMicGain,
    sendChatMessage,
    typingTick,
    sendNudge,
    toggleSpatialAudio,
    setSpatialPosition,
    setSpatialAutoAll,
    setAmbience,
    toggleForceSfu,
    toggleRoomClosed,
    admitToRealRoom,
    peerAudiosRef,
  };
}
