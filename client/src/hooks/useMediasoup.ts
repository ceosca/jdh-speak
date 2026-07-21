import { useRef, useCallback, useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import type { Transport, Producer, Consumer } from "mediasoup-client/types";
import { forceOpusParams } from "../lib/sdp-munger";
import { applySpeakerToContext } from "../lib/audio-devices";
import { isIOS, getMicrophoneStream } from "../lib/microphone";
import { playCue, preloadCueSamples } from "../lib/sounds";
import { getIceServers } from "../lib/ice";
import { parseClearKey, type Channel } from "../lib/tv";
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
  // SFU-only
  consumer?: Consumer;
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
  gainNode.connect(sharedAudioContext.destination);

  return { audioEl, gainNode, sourceNode };
}

function destroyAudioPipeline(pa: PeerAudio) {
  pa.consumer?.close();
  pa.audioEl.srcObject = null;
  pa.audioEl.pause();
  pa.sourceNode.disconnect();
  pa.gainNode.disconnect();
}

export function useMediasoup() {
  const socketRef = useRef<Socket | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const producerRef = useRef<Producer | null>(null);
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
    // Secondary input device: captured stereo + no voice-processing, mixed
    // directly into outDest alongside the mic chain.
    secondarySource: MediaStreamAudioSourceNode | null;
    secondaryGain: GainNode | null;
    secondaryStream: MediaStream | null;
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
  const store = useRoomStore;

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
    // Local mic monitor (hear yourself): tapped AFTER micGain so it plays at the
    // same volume people receive — lowering "your mic level" lowers it too.
    // micGain is permanent, so this edge survives mic re-acquisition.
    if (store.getState().micMonitor) micGain.connect(ctx.destination);
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
      secondarySource: null,
      secondaryGain: null,
      secondaryStream: null,
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
  const secondaryEnabled = useRoomStore((s) => s.secondaryEnabled);
  const secondaryDeviceId = useRoomStore((s) => s.secondaryDeviceId);
  const secondaryMonitor = useRoomStore((s) => s.secondaryMonitor);
  const micMonitor = useRoomStore((s) => s.micMonitor);
  const shareMonitor = useRoomStore((s) => s.shareMonitor);

  // All incoming audio plays through the shared context, so the speaker pick
  // is one setSinkId there — it covers every peer, current and future.
  useEffect(() => {
    applySpeakerToContext(sharedAudioContext, speakerDeviceId);
  }, [speakerDeviceId]);

  // Mid-call mic setting change: re-acquire the mic with the selected device
  // and voice-processing preference, then reroute it into the outgoing graph.
  // Senders/producers never see the swap because they always carry outDest's
  // track. Before a call (no local stream), join() picks the settings up.
  const prevMicSettingsRef = useRef({ micDeviceId, voiceProcessingEnabled });
  useEffect(() => {
    const previous = prevMicSettingsRef.current;
    if (
      previous.micDeviceId === micDeviceId &&
      previous.voiceProcessingEnabled === voiceProcessingEnabled
    )
      return;
    prevMicSettingsRef.current = { micDeviceId, voiceProcessingEnabled };
    if (!localStreamRef.current) return;
    let cancelled = false;
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await getMicrophoneStream(micDeviceId, voiceProcessingEnabled);
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
      old?.getTracks().forEach((t) => t.stop());
      // Voice-processing flag changed — no announcement needed.
    })();
    return () => {
      cancelled = true;
    };
  }, [micDeviceId, voiceProcessingEnabled, connectMicToGraph, store]);

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
    if (
      enabled === prev.enabled &&
      deviceId === prev.deviceId &&
      g?.secondaryGain
    ) {
      if (monitor) {
        // Guard against double-connect: disconnect first (no-op if not connected),
        // then reconnect — Web Audio silently allows duplicate connects but it
        // stacks, so a disconnect/reconnect cycle keeps exactly one connection.
        // Tapped at secondaryGain (post-gain) so the monitor matches what's sent.
        try { g.secondaryGain.disconnect(sharedAudioContext.destination); } catch { /* not connected */ }
        g.secondaryGain.connect(sharedAudioContext.destination);
      } else {
        try { g.secondaryGain.disconnect(sharedAudioContext.destination); } catch { /* already disconnected */ }
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
  useEffect(() => {
    const g = outGraphRef.current;
    if (!g) return;
    try { g.micGain.disconnect(sharedAudioContext.destination); } catch { /* not connected */ }
    if (micMonitor) g.micGain.connect(sharedAudioContext.destination);
  }, [micMonitor]);

  // Toggle the shared-audio monitor live: also play the shared tab/system audio
  // out the app's selected playback device (it follows the speaker pick via the
  // context sinkId), in addition to sending it to peers. Off by default; may
  // echo if the shared tab already plays on that same device.
  useEffect(() => {
    const g = outGraphRef.current;
    if (!g?.displaySource) return;
    try { g.displaySource.disconnect(sharedAudioContext.destination); } catch { /* not connected */ }
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
      useRoomStore.getState().voiceProcessingEnabled,
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
        if ("playoutDelayHint" in remoteTrack) {
          (remoteTrack as unknown as Record<string, number>).playoutDelayHint = 0;
        }
        const pipeline = createAudioPipeline(remoteTrack);
        // Respect deafen / per-peer volume on a (re)built P2P pipeline too —
        // otherwise an SFU→P2P switch resets everyone to full volume and a
        // deafened listener starts hearing audio again.
        pipeline.gainNode.gain.value = effectiveGain(peerId);
        peerAudiosRef.current.set(peerId, pipeline);
      };

      p2pConnectionsRef.current.set(peerId, pc);

      if (isOfferer) {
        // Create offer with stereo 128k low-latency Opus params.
        pc.createOffer().then(async (offer) => {
          offer.sdp = forceOpusParams(offer.sdp!);
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
    [ensureLocalStream, connectMicToGraph, ensureOutGraph, effectiveGain],
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

      if ("playoutDelayHint" in consumer.track) {
        (consumer.track as unknown as Record<string, number>).playoutDelayHint = 0;
      }

      const pipeline = createAudioPipeline(consumer.track);

      // Drop any previous pipeline for this peer first (a re-consume on a mode
      // switch, reconnect, or a live bitrate re-produce) so it never leaks or
      // doubles up.
      const existingPeerAudio = peerAudiosRef.current.get(peerId);
      if (existingPeerAudio) destroyAudioPipeline(existingPeerAudio);
      peerAudiosRef.current.set(peerId, { ...pipeline, consumer });

      // Flag a music-caster peer (e.g. Ecobox) so the UI shows it as a media
      // source. Stereo is preserved end-to-end by createAudioPipeline.
      if (source === "music") {
        store.getState().setPeerMusic(peerId, true);
      }

      // Start at the correct gain (respects per-peer volume and deafen).
      pipeline.gainNode.gain.value = effectiveGain(peerId);
    },
    [emit, store, effectiveGain],
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
      const recvTransport = device.createRecvTransport({
        ...(recvRes.params as Parameters<typeof device.createRecvTransport>[0]),
        iceServers: getIceServers(),
      });

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
          opusFec: true,
          opusMaxPlaybackRate: 48000,
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
            store.getState().voiceProcessingEnabled,
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
            producers: Array<{ producerId: string; source: string }>;
          }>;
          mode: RoomMode;
          recording: { recordingId: string } | null;
          audioBitrate?: number;
          messages: ChatMessage[];
        };
        const joinPayload = {
          roomName,
          displayName,
          disableP2p: opts?.disableP2p,
        };

        const joinRes = await emit<JoinResponse>("join", joinPayload);

        store.getState().setRoom(roomName, displayName, socket.id!);
        store.getState().setMode(joinRes.mode);
        modeRef.current = joinRes.mode;

        // Match the room's current voice bitrate (late joiner / reconnect).
        roomBitrateRef.current = joinRes.audioBitrate ?? 128;

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
              answer.sdp = forceOpusParams(answer.sdp!);
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
        try { URL.revokeObjectURL(track.objectUrl); } catch { /* best-effort */ }
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
      fadeTimerRef.current[oldActiveIdx] = window.setTimeout(() => {
        fadeTimerRef.current[oldActiveIdx] = null;
        if (fadeGenRef.current[oldActiveIdx] !== capturedGen) return;
        oldActive.audioEl.pause();
      }, XFADE_TAU * 5 * 1000);

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

      // Resume from saved progress if the episode still exists.
      const prog = loadProgress()[serie.nombre];
      const idx = prog && episodes[prog.episode] ? prog.episode : 0;
      const startTime =
        prog && episodes[prog.episode] ? prog.time : episodes[idx]!.inicio / 1000;

      try {
        if (!serieAudioRef.current) {
          const el = new Audio();
          (el as unknown as Record<string, boolean>).playsInline = true;
          el.crossOrigin = "anonymous";
          el.addEventListener("timeupdate", () => onSerieTimeUpdate());
          el.addEventListener("pause", () => saveSerieProgress());
          el.addEventListener("ended", () =>
            store.getState().setFileStreamPlaying(false),
          );
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
    [ensureOutGraph, ensureFileVolumeGain, stopFileStream, store, onSerieTimeUpdate, saveSerieProgress],
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

  const toggleFilePlayback = useCallback(() => {
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
  // ramps the fileVolumeGain node live (smooth, 50 ms time-constant).
  const setPlayerVolume = useCallback(
    (v: number) => {
      store.getState().setFileVolume(v);
      const gain = outGraphRef.current?.fileVolumeGain;
      if (gain) gain.gain.setTargetAtTime(v, sharedAudioContext.currentTime, 0.05);
    },
    [store],
  );

  // Seek the active slot by `sec` seconds (clamped to [0, duration]).
  const playerSeekBy = useCallback((sec: number) => {
    const g = outGraphRef.current;
    const el = g?.fileSlots?.[g.activeSlot]?.audioEl;
    if (!el) return;
    el.currentTime = Math.min(el.duration || 0, Math.max(0, el.currentTime + sec));
  }, []);

  // Seek the active slot to an absolute position (clamped to [0, duration]).
  const playerSeekTo = useCallback((sec: number) => {
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
      const el = g?.fileSlots?.[g.activeSlot]?.audioEl;
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
    // Tear down the outgoing graph (nodes live in the shared context, so just
    // disconnect them — the context itself is reused for the next room).
    const g = outGraphRef.current;
    if (g) {
      g.micSource?.disconnect();
      g.micGain.disconnect();
      g.limiter.disconnect();
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
      try { URL.revokeObjectURL(track.objectUrl); } catch { /* best-effort */ }
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
    setPeerVolume,
    setMicGain,
    sendChatMessage,
    peerAudiosRef,
  };
}
