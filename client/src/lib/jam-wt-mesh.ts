// Jam audio MESH over WebTransport with 2.5 ms Opus frames — hear the PEERS over the
// low-latency QUIC path, not just your own monitor return.
//
// This is the peer-routed sibling of jam-wt-monitor.ts: instead of the relay echoing
// your own frames, the /jam relay routes them to every OTHER client in the same room
// (and fans everyone else's back to you). So the ensemble is heard entirely off
// WebRTC's audio path: 2.5 ms Opus frames (Jamulus/SonoBus frame size, which WebRTC's
// encoder can't do) + our own minimal buffer + the low ~23 ms media output.
//
// Wire format — see server/src/webtransport-probe.ts (handleJamSession):
//   send hello : [0x00][utf8 room]                 → relay: [0x00][id:u16]
//   send audio : [0x01][seq:4][sendTime:8][opus]
//   recv audio : [0x01][senderId:u16][seq:4][sendTime:8][opus]  (opus at offset 15)
// We play every senderId that ISN'T our own id (the self-return is the /echo monitor's
// job). One AudioDecoder → MediaStreamTrackGenerator → <audio> per peer, so per-peer
// volume/device is just the element's volume/sinkId.
//
// FAIL-SAFE: returns null on any missing API / setup failure; the caller then keeps
// the mediasoup peer audio. Additive — the room/signalling/recording still run on
// mediasoup; this only replaces the jam audio PLAYOUT for peers.

export type WtMeshHandle = {
  teardown: () => void;
  setDevice: (deviceId: string) => void;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = any;

// Memoryless soft limiter for the OUTGOING jam signal. The jam send path deliberately
// bypasses the Web Audio limiter (it sends the RAW mic for zero lookahead latency), so a
// hot mic/instrument would ship a CLIPPING signal that distorts for EVERY listener — and
// the sender never hears itself, so they don't notice (that's why Franco/Edu clipped on
// Cristian's signal but Cristian didn't). This waveshaper is transparent below −3 dB
// (|x| ≤ 0.7) and smoothly compresses toward ±1 above it; tanh asymptotes to ±1 so the
// output can never exceed full scale → no hard clip. ZERO added latency (no lookahead).
const LIMIT_KNEE = 0.7;
function sendLimit(x: number): number {
  if (x > LIMIT_KNEE) return LIMIT_KNEE + (1 - LIMIT_KNEE) * Math.tanh((x - LIMIT_KNEE) / (1 - LIMIT_KNEE));
  if (x < -LIMIT_KNEE) return -LIMIT_KNEE + (1 - LIMIT_KNEE) * Math.tanh((x + LIMIT_KNEE) / (1 - LIMIT_KNEE));
  return x;
}
// Reused per-channel scratch so peak-scanning a clean frame allocates nothing.
const _encScratch: Float32Array[] = [];
function encScratch(c: number, n: number): Float32Array {
  if (!_encScratch[c] || _encScratch[c].length < n) _encScratch[c] = new Float32Array(n);
  return _encScratch[c];
}

// Encode one captured chunk at the encoder's channel count, with a zero-latency send
// limiter (above) so we never ship a clipping signal. The mic often captures STEREO
// (channelCount:2 on desktop); if the encoder is MONO we downmix first (else encode()
// throws and NOTHING is sent). If the encoder is STEREO, we keep both channels.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function encodeFrame(encoder: AudioEncoder, ad: any, channels: number): void {
  if (encoder.state !== "configured") return;
  try {
    const n = ad.numberOfFrames as number;
    if (channels === 1 && ad.numberOfChannels > 1) {
      // Stereo capture into a mono encoder → downmix (L+R)/2, then limit.
      const a = new Float32Array(n);
      const b = encScratch(1, n);
      ad.copyTo(a, { planeIndex: 0, format: "f32-planar" });
      ad.copyTo(b, { planeIndex: 1, format: "f32-planar" });
      for (let i = 0; i < n; i++) a[i] = sendLimit((a[i] + b[i]) * 0.5);
      const mono = new AudioData({
        format: "f32-planar",
        sampleRate: ad.sampleRate,
        numberOfFrames: n,
        numberOfChannels: 1,
        timestamp: ad.timestamp,
        data: a,
      });
      encoder.encode(mono);
      mono.close();
      return;
    }
    // Matched channels: peak-scan into reused scratch; only HOT frames get limited (and
    // allocate), clean frames encode the original AudioData directly.
    let peak = 0;
    for (let c = 0; c < channels; c++) {
      const s = encScratch(c, n);
      ad.copyTo(s, { planeIndex: c, format: "f32-planar" });
      for (let i = 0; i < n; i++) {
        const v = s[i] < 0 ? -s[i] : s[i];
        if (v > peak) peak = v;
      }
    }
    if (peak <= LIMIT_KNEE) {
      encoder.encode(ad);
      return;
    }
    const data = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) {
      const s = encScratch(c, n); // still holds channel c from the scan
      for (let i = 0; i < n; i++) data[c * n + i] = sendLimit(s[i]);
    }
    const out = new AudioData({
      format: "f32-planar",
      sampleRate: ad.sampleRate,
      numberOfFrames: n,
      numberOfChannels: channels,
      timestamp: ad.timestamp,
      data,
    });
    encoder.encode(out);
    out.close();
  } catch {
    /* skip a bad frame */
  }
}

export function wtMeshSupported(): boolean {
  return (
    typeof WebTransport !== "undefined" &&
    typeof AudioEncoder !== "undefined" &&
    typeof AudioDecoder !== "undefined" &&
    typeof (globalThis as AnyRec).MediaStreamTrackGenerator !== "undefined" &&
    typeof (globalThis as AnyRec).MediaStreamTrackProcessor !== "undefined"
  );
}

type MeshPeer = {
  decoder: AudioDecoder;
  el: HTMLAudioElement | null; // per-peer <audio> (fallback path, no master limiter)
  src: MediaStreamAudioSourceNode | null; // context path: generator → src → master limiter
  ts: number;
  buf: AdaptiveJitterBuffer;
  appId: string; // the sender's app peerId (store key) → per-peer volume lookup
  lastSeq: number; // last received sender seq, to count lost datagrams (−1 = none yet)
};

// Soft knee above 0.8 so a >1.0 boost doesn't hard-clip into buzz on loud samples.
// Below the knee it's exactly linear (transparent), matching the pre-jam AudioContext
// gain for normal levels.
function softclip(x: number): number {
  const t = 0.8;
  if (x > t) return t + (1 - t) * Math.tanh((x - t) / (1 - t));
  if (x < -t) return -t + (1 - t) * Math.tanh((x + t) / (1 - t));
  return x;
}

const SR = 48000;
const DEFAULT_JITTER_MS = 8; // cushion when no user slider is wired
const SAFETY_MS = 250; // drop ceiling ABOVE the cushion — resampler should never reach it
const TAU_SMOOTH = 2; // s — how heavily the buffer level is smoothed for the controller
const TAU_CORRECT = 4; // s — how gently drift is drained (buffer above target: smooth)
const TAU_REFILL = 1; // s — how fast the cushion is rebuilt (buffer below target: quick
//                           recovery after a loss glitch, so gaps don't linger)
const MAX_ADJ = 0.02; // ±2 % max playback-speed nudge (drift is normally <0.03 %)

export type JamBufferBounds = { minMs: number; maxMs: number };
// Live diagnostics, shared on window.__jamMeshStats so a real session can be inspected
// (crucially, so a user who cuts can report WHAT is happening — underruns vs lost
// packets vs jitter). `lost` is filled by the mesh receive loop (seq gaps), the rest by
// the buffer.
export type JamMeshStats = {
  bufferedMs: number;
  targetMs: number;
  jitterMs: number;
  drops: number;
  ppm: number;
  underruns: number;
  lost: number;
};
export function jamMeshStats(): JamMeshStats {
  const g = globalThis as unknown as { __jamMeshStats?: JamMeshStats };
  return (g.__jamMeshStats ||= {
    bufferedMs: 0,
    targetMs: 8,
    jitterMs: 0,
    drops: 0,
    ppm: 0,
    underruns: 0,
    lost: 0,
  });
}
// Minimal shape the buffer needs from a decoded frame (real WebCodecs AudioData
// satisfies it; a plain stub satisfies it in tests).
export type JamFrame = {
  numberOfFrames: number;
  numberOfChannels: number;
  copyTo: (dest: Float32Array, opts: { planeIndex: number; format: "f32-planar" }) => void;
  close: () => void;
};

// ── Streaming linear resampler (the drift-compensation engine). ────────────────────
// Plays the incoming sample stream back at a variable speed `s`: s>1 = play faster =
// emit FEWER samples = drain the downstream queue; s<1 = slower = emit more = fill it.
// Linear interpolation with a fractional read cursor carried across frames, so there's
// no discontinuity at frame boundaries. Verified in isolation: at s=1 it's transparent,
// at ±1 % it shifts pitch ±1 % with no added clicks (max sample step = the signal's own).
//
// ALLOCATION-FREE hot path: a preallocated ring per channel (copyWithin to drop consumed
// samples — no concat/slice) and a reused output buffer (no per-sample Array.push / no
// Float32Array.from). The old version allocated ~4 arrays PER FRAME per channel → at
// 400 fps × N peers that GC churn stalled the audio on weaker machines (Franco/Edu
// crackled even at a 100 ms buffer — a bigger cushion can't absorb a GC pause on the
// thread PRODUCING frames). Results live in `out`/`outLen`, valid until the next call.
class StreamResampler {
  private ring: Float32Array[];
  private cap = 4096; // ~85 ms of headroom; grows only if ever exceeded
  private n = 0; // valid samples currently in the ring
  private readPos = 0;
  out: Float32Array[]; // reused output scratch (read [0..outLen))
  outLen = 0;
  private outCap = 1024;
  constructor(private readonly ch: number) {
    this.ring = Array.from({ length: ch }, () => new Float32Array(this.cap));
    this.out = Array.from({ length: ch }, () => new Float32Array(this.outCap));
  }
  // `input[c]` may be a reused scratch LARGER than `inN`; only the first inN are valid.
  process(input: Float32Array[], inN: number, s: number): void {
    if (this.n + inN > this.cap) {
      this.cap = Math.max(this.cap * 2, this.n + inN);
      this.ring = this.ring.map((r) => {
        const g = new Float32Array(this.cap);
        g.set(r.subarray(0, this.n));
        return g;
      });
    }
    for (let c = 0; c < this.ch; c++) {
      const r = this.ring[c];
      const src = input[c];
      for (let i = 0; i < inN; i++) r[this.n + i] = src[i];
    }
    this.n += inN;
    const est = Math.ceil((this.n - this.readPos) / Math.max(s, 0.001)) + 2;
    if (est > this.outCap) {
      this.outCap = Math.max(this.outCap * 2, est);
      this.out = this.out.map(() => new Float32Array(this.outCap));
    }
    let o = 0;
    let rp = this.readPos;
    while (rp + 1 < this.n) {
      const i = rp | 0;
      const f = rp - i;
      for (let c = 0; c < this.ch; c++) {
        const r = this.ring[c];
        const a = r[i];
        this.out[c][o] = a + (r[i + 1] - a) * f;
      }
      o++;
      rp += s;
    }
    const drop = rp | 0;
    if (drop > 0) {
      for (let c = 0; c < this.ch; c++) this.ring[c].copyWithin(0, drop, this.n);
      this.n -= drop;
      rp -= drop;
    }
    this.readPos = rp;
    this.outLen = o;
  }
}

// ── Jamulus/SonoBus-style jitter buffer with SMOOTH drift compensation. ─────────────
//
// The buffer is now ONLY for jitter: the user's single slider sets the cushion (`min`).
// Clock drift (why the delay used to grow over hours) is absorbed the "pro" way — like
// SonoBus/AOO's DLL + resampler — instead of by dropping frames at a ceiling:
//   • PREBUFFER to the cushion with real audio, then play.
//   • A slow controller measures the heavily-smoothed buffer level and nudges the
//     playback SPEED (resampler `s`) by a fraction of a percent so the buffer sits at
//     the cushion forever — drift in either direction is cancelled continuously, with
//     no clicks and no growth. On a true underrun it re-prebuffers.
//   • A drop ceiling `cushion + 250 ms` stays only as a catastrophic-desync safety; the
//     resampler should never let the buffer get near it.
// Playout is a MediaStreamTrackGenerator that pulls at realtime, so the buffer level is
// written-samples − wall-clock×SR (verified: <audio>.currentTime tracks wall-clock).
export class AdaptiveJitterBuffer {
  private startMs = 0;
  private written = 0; // OUTPUT samples handed to the generator since (re)start
  private lastArrival = 0;
  private jitterMs = 0; // smoothed RFC 3550 jitter (live readout only)
  private prebuffering = true;
  private pendingOut: Float32Array[][] = []; // resampled planes held during prebuffer
  private pendingSamples = 0;
  private outTs = 0; // running output timestamp (µs), monotonic
  private bufSmoothed = -1; // heavily-smoothed buffer level for the controller (−1 = init)
  private speed = 1; // current resampler speed
  private readonly nominalMs: number;
  private readonly ch: number;
  private readonly bounds: JamBufferBounds | null;
  private readonly resampler: StreamResampler;
  private readonly smoothA: number;
  private readonly stat: JamMeshStats;
  // Reused extraction scratch (grown as needed) so the hot path allocates nothing per
  // frame — the whole point of the perf pass. `tmp` holds one raw channel; `inScratch`
  // the gained planes fed to the resampler (which copies them out immediately).
  private tmp: Float32Array = new Float32Array(0);
  private inScratch: Float32Array[] = [];

  // `bounds` is a LIVE shared object: the slider mutates its minMs and this buffer reads
  // the new cushion on the fly — no rebuild. (maxMs is ignored now; drift is resampled,
  // not capped, so only the cushion is user-facing.)
  constructor(nominalMs = 2.5, channels = 1, bounds?: JamBufferBounds) {
    this.nominalMs = nominalMs;
    this.ch = channels;
    this.bounds = bounds ?? null;
    this.resampler = new StreamResampler(channels);
    this.smoothA = nominalMs / 1000 / TAU_SMOOTH;
    this.stat = jamMeshStats();
  }

  private cushionSamples(): number {
    return SR * ((this.bounds ? this.bounds.minMs : DEFAULT_JITTER_MS) / 1000);
  }

  private updateStat(bufSamples: number, target: number): void {
    this.stat.bufferedMs = +((bufSamples / SR) * 1000).toFixed(0);
    this.stat.targetMs = +((target / SR) * 1000).toFixed(0);
    this.stat.jitterMs = +this.jitterMs.toFixed(1);
    this.stat.ppm = +((this.speed - 1) * 1e6).toFixed(0);
  }

  // Feed one decoded frame + its per-peer gain (0..4; 1 = passthrough). The buffer
  // applies the gain, drift-resamples, prebuffers/plays, and calls `write` with the
  // generator-ready AudioData it produces.
  push(ad: JamFrame, gain: number, write: (f: AudioData) => void): void {
    const now = performance.now();
    if (this.lastArrival === 0) this.lastArrival = now;
    this.jitterMs += (Math.abs(now - this.lastArrival - this.nominalMs) - this.jitterMs) / 16;
    this.lastArrival = now;

    // Extract input planes, applying the per-peer gain (soft knee) while we copy.
    const n = ad.numberOfFrames;
    if (this.tmp.length < n) this.tmp = new Float32Array(n);
    if (this.inScratch.length !== this.ch) {
      this.inScratch = Array.from({ length: this.ch }, () => new Float32Array(0));
    }
    const inPlanes = this.inScratch;
    for (let c = 0; c < this.ch; c++) {
      if (inPlanes[c].length < n) inPlanes[c] = new Float32Array(n);
      ad.copyTo(this.tmp, { planeIndex: c, format: "f32-planar" });
      const p = inPlanes[c];
      if (gain === 1) for (let i = 0; i < n; i++) p[i] = this.tmp[i];
      else for (let i = 0; i < n; i++) p[i] = gain === 0 ? 0 : softclip(this.tmp[i] * gain);
    }
    try {
      ad.close();
    } catch {
      /* already closed */
    }

    const target = this.cushionSamples();
    const ceilS = target + (SR * SAFETY_MS) / 1000;

    // Controller (only while playing): steer the speed so the buffer holds at `target`.
    if (!this.prebuffering) {
      const buffered = this.written - ((now - this.startMs) / 1000) * SR;
      if (buffered < 0) {
        // Underrun — the queue ran dry (jitter spike, packet loss, or a clock-estimate
        // slip). DON'T stall with a full re-prebuffer: that turns every hiccup into a
        // cushion-long silence, and a BIGGER cushion makes it WORSE (that's why raising
        // the buffer didn't help Edu — it lengthened each stall). Instead re-anchor to
        // the live edge and let the controller refill the cushion by playing very
        // slightly slow. One tiny glitch at the underrun, no stall.
        this.startMs = now;
        this.written = 0;
        this.bufSmoothed = 0;
        this.speed = 1;
        this.stat.underruns++;
      } else {
        if (this.bufSmoothed < 0) this.bufSmoothed = buffered;
        this.bufSmoothed += (buffered - this.bufSmoothed) * this.smoothA;
        const err = this.bufSmoothed - target;
        // Below target → refill fast (recover the cushion after a glitch); above target
        // → drain slow (smooth drift correction, no audible pitch wobble).
        const tau = err < 0 ? TAU_REFILL : TAU_CORRECT;
        this.speed = Math.max(1 - MAX_ADJ, Math.min(1 + MAX_ADJ, 1 + err / (SR * tau)));
      }
    }

    this.resampler.process(inPlanes, n, this.prebuffering ? 1 : this.speed);
    const outLen = this.resampler.outLen;
    const outPlanes = this.resampler.out; // reused — valid only until the next process()

    if (this.prebuffering) {
      if (outLen > 0) {
        // pendingOut is held across process() calls, so COPY out of the reused buffer.
        const copy: Float32Array[] = [];
        for (let c = 0; c < this.ch; c++) copy.push(outPlanes[c].slice(0, outLen));
        this.pendingOut.push(copy);
        this.pendingSamples += outLen;
      }
      if (this.pendingSamples >= target) {
        this.startMs = now;
        this.written = this.pendingSamples;
        this.bufSmoothed = this.pendingSamples;
        for (const planes of this.pendingOut) this.emit(planes, planes[0].length, write);
        this.pendingOut = [];
        this.prebuffering = false;
      }
      this.updateStat(this.pendingSamples, target);
      return;
    }

    const buffered = this.written - ((now - this.startMs) / 1000) * SR;
    this.updateStat(buffered, target);
    if (buffered > ceilS) {
      // Safety only (should never fire while the resampler is holding target).
      this.stat.drops++;
      return;
    }
    if (outLen > 0) {
      this.written += outLen;
      this.emit(outPlanes, outLen, write); // emitted immediately → reused buffer is safe
    }
  }

  private emit(planes: Float32Array[], outLen: number, write: (f: AudioData) => void): void {
    if (outLen === 0) return;
    const data = new Float32Array(outLen * this.ch);
    for (let c = 0; c < this.ch; c++) {
      // planes[c] may be a reused buffer LONGER than outLen — copy exactly outLen.
      data.set(planes[c].subarray(0, outLen), c * outLen);
    }
    const out = new AudioData({
      format: "f32-planar",
      sampleRate: SR,
      numberOfFrames: outLen,
      numberOfChannels: this.ch,
      timestamp: this.outTs,
      data,
    });
    this.outTs += Math.round((outLen / SR) * 1e6);
    write(out);
  }

  // Nothing to close (input frames are closed on entry, output planes are plain arrays).
  dispose(): void {
    this.pendingOut = [];
  }
}

export async function setupWtMesh(
  micTrack: MediaStreamTrack,
  jamUrl: string,
  certHash: number[] | null,
  room: string,
  deviceId: string,
  channels: number,
  localPeerId: string,
  getGain: (peerId: string) => number,
  bounds: JamBufferBounds,
  audioCtx: AudioContext | null,
): Promise<WtMeshHandle | null> {
  if (!wtMeshSupported()) return null;
  const ch = channels === 2 ? 2 : 1;
  const localIdBytes = new TextEncoder().encode(localPeerId).slice(0, 255);
  const stats = jamMeshStats();
  let wt: AnyRec = null;
  let encoder: AudioEncoder | null = null;
  const peers = new Map<number, MeshPeer>();
  let myId = -1;
  let curDevice = deviceId;

  // MASTER LIMITER: route every peer's generator through ONE DynamicsCompressor so the
  // SUM of simultaneous players can't clip at the output — the send limiter only bounds
  // each peer individually, but N players summing at the OS mixer can still exceed full
  // scale (the "clipea aun con 3 tocando" case). Costs ~10 ms of AudioContext latency, so
  // it engages only when an AudioContext is available and the chain builds; otherwise we
  // fall back to the per-peer <audio> path (byte-for-byte the old behaviour). Fail-safe.
  let masterComp: DynamicsCompressorNode | null = null;
  let masterEl: HTMLAudioElement | null = null;
  if (audioCtx) {
    try {
      if (audioCtx.state !== "running") void audioCtx.resume().catch(() => {});
      masterComp = audioCtx.createDynamicsCompressor();
      masterComp.threshold.value = -1; // only tame peaks approaching full scale
      masterComp.knee.value = 0;
      masterComp.ratio.value = 20; // brickwall-ish limiting
      masterComp.attack.value = 0.003;
      masterComp.release.value = 0.25;
      const md = audioCtx.createMediaStreamDestination();
      masterComp.connect(md);
      masterEl = new Audio();
      masterEl.autoplay = true;
      (masterEl as unknown as Record<string, boolean>).playsInline = true;
      masterEl.srcObject = md.stream;
      if ("setSinkId" in masterEl) {
        (masterEl as unknown as { setSinkId: (s: string) => Promise<void> })
          .setSinkId(curDevice || "")
          .catch(() => {});
      }
      masterEl.play().catch(() => {});
    } catch {
      masterComp = null;
      masterEl = null;
    }
  }

  const closePeers = () => {
    for (const p of peers.values()) {
      try {
        if (p.el) {
          p.el.pause();
          p.el.srcObject = null;
        }
        if (p.src) p.src.disconnect();
      } catch {
        /* gone */
      }
      try {
        if (p.decoder.state !== "closed") p.decoder.close();
      } catch {
        /* gone */
      }
      p.buf.dispose();
    }
    peers.clear();
  };

  try {
    const opts = certHash
      ? { serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(certHash) }] }
      : undefined;
    wt = new (globalThis as AnyRec).WebTransport(jamUrl, opts);
    await wt.ready;
    const writer = wt.datagrams.writable.getWriter();

    // hello → join the room.
    const roomBytes = new TextEncoder().encode(room);
    const hello = new Uint8Array(1 + roomBytes.length);
    hello[0] = 0x00;
    hello.set(roomBytes, 1);
    await writer.write(hello);

    // A new sender showed up → build its decoder → generator → <audio>. `senderCh` is
    // the SENDER's channel count (from its packets), so a mono listener still decodes a
    // stereo sender correctly and vice-versa.
    const ensurePeer = (id: number, senderCh: number): MeshPeer | null => {
      let p = peers.get(id);
      if (p) return p;
      try {
        const gen = new (globalThis as AnyRec).MediaStreamTrackGenerator({ kind: "audio" });
        const gw: WritableStreamDefaultWriter = gen.writable.getWriter();
        // `p` is assigned just below; the output closure reads its clock fields.
        const decoder = new AudioDecoder({
          output: (ad) => {
            const self = peers.get(id);
            const writeOut = (f: AudioData) =>
              gw.write(f).catch(() => {
                try {
                  f.close();
                } catch {
                  /* already closed */
                }
              });
            // The buffer applies this peer's per-slider volume (the <audio> element
            // can't go above 1.0), drift-resamples, and writes generator-ready frames.
            if (self) self.buf.push(ad as unknown as JamFrame, getGain(self.appId), writeOut);
            else
              try {
                ad.close();
              } catch {
                /* already closed */
              }
          },
          error: () => {
            /* skip */
          },
        });
        decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: senderCh });
        let el: HTMLAudioElement | null = null;
        let src: MediaStreamAudioSourceNode | null = null;
        if (masterComp && audioCtx) {
          // Context path: generator → source → shared master limiter → one <audio>.
          src = audioCtx.createMediaStreamSource(new MediaStream([gen]));
          src.connect(masterComp);
        } else {
          // Fallback: per-peer <audio> (no master limiter, lowest latency).
          el = new Audio();
          el.autoplay = true;
          (el as unknown as Record<string, boolean>).playsInline = true;
          el.srcObject = new MediaStream([gen]);
          if ("setSinkId" in el) {
            (el as unknown as { setSinkId: (s: string) => Promise<void> })
              .setSinkId(curDevice || "")
              .catch(() => {});
          }
          el.play().catch(() => {});
        }
        p = {
          decoder,
          el,
          src,
          ts: 0,
          buf: new AdaptiveJitterBuffer(2.5, senderCh, bounds),
          appId: "",
          lastSeq: -1,
        };
        peers.set(id, p);
        return p;
      } catch {
        return null;
      }
    };

    // --- Send: mic → WebCodecs Opus 2.5 ms → [1][seq][sendTime][opus]. ---
    let seq = 0;
    encoder = new AudioEncoder({
      output: (chunk) => {
        try {
          // [0x01][idLen:u8][appId][ch:u8][seq:4][sendTime:8][opus]. The relay prepends
          // our senderId and forwards the rest verbatim, so stamping our peerId (for
          // per-peer volume) and OUR channel count (so the receiver decodes mono/stereo
          // correctly regardless of ITS own mic) needs no relay/server change.
          const idLen = localIdBytes.length;
          const headLen = 1 + 1 + idLen + 1 + 4 + 8;
          const buf = new ArrayBuffer(headLen + chunk.byteLength);
          const dv = new DataView(buf);
          const u8 = new Uint8Array(buf);
          dv.setUint8(0, 0x01);
          dv.setUint8(1, idLen);
          u8.set(localIdBytes, 2);
          let o = 2 + idLen;
          dv.setUint8(o, ch);
          o += 1;
          dv.setUint32(o, seq, true);
          o += 4;
          dv.setFloat64(o, performance.now(), true);
          o += 8;
          chunk.copyTo(new Uint8Array(buf, o));
          seq = (seq + 1) >>> 0;
          writer.write(u8).catch(() => {});
        } catch {
          /* skip */
        }
      },
      error: () => {
        /* encoder error — peers stop hearing us; teardown restores mediasoup */
      },
    });
    encoder.configure({
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: ch,
      bitrate: ch === 2 ? 128000 : 64000, // stereo (a musical input) needs the headroom
      opus: { frameDuration: 2500, useinbandfec: false, usedtx: false },
    });

    const proc = new (globalThis as AnyRec).MediaStreamTrackProcessor({ track: micTrack });
    const capReader: ReadableStreamDefaultReader = proc.readable.getReader();
    (async () => {
      for (;;) {
        let r: ReadableStreamReadResult<AnyRec>;
        try {
          r = await capReader.read();
        } catch {
          break;
        }
        if (r.done) break;
        if (encoder) encodeFrame(encoder, r.value, ch);
        try {
          r.value.close();
        } catch {
          /* already closed */
        }
      }
    })();

    // --- Receive: hello-ack (id) + routed peer audio. ---
    const dgReader: ReadableStreamDefaultReader = wt.datagrams.readable.getReader();
    (async () => {
      for (;;) {
        let r: ReadableStreamReadResult<AnyRec>;
        try {
          r = await dgReader.read();
        } catch {
          break;
        }
        if (r.done) break;
        const v = r.value as Uint8Array;
        if (!v || v.byteLength < 1) continue;
        const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
        const type = v[0];
        if (type === 0x00 && v.byteLength >= 3) {
          myId = dv.getUint16(1, true);
          continue;
        }
        if (type === 0x01 && v.byteLength > 4) {
          // [0x01][senderId:u16][idLen:u8][appId][ch:u8][seq:4][sendTime:8][opus]
          const senderId = dv.getUint16(1, true);
          if (senderId === myId) continue; // our own return → the /echo monitor's job
          const idLen = v[3];
          const senderCh = v[4 + idLen] === 2 ? 2 : 1;
          const seqOffset = 4 + idLen + 1; // after appId + ch byte
          const opusOffset = seqOffset + 12; // seq(4) + sendTime(8)
          if (v.byteLength <= opusOffset) continue;
          const p = ensurePeer(senderId, senderCh);
          if (p) {
            if (idLen > 0) p.appId = new TextDecoder().decode(v.subarray(4, 4 + idLen));
            // Count lost datagrams via seq gaps (WebTransport datagrams are unreliable).
            // This is the key diagnostic: cuts from LOST packets can't be fixed by a
            // bigger buffer — they need FEC/PLC or the mediasoup fallback.
            const seq = dv.getUint32(seqOffset, true);
            if (p.lastSeq >= 0) {
              const gap = (seq - p.lastSeq - 1) | 0;
              if (gap > 0 && gap < 1000) stats.lost += gap;
            }
            p.lastSeq = seq;
            if (p.decoder.state === "configured") {
              try {
                p.decoder.decode(
                  new EncodedAudioChunk({ type: "key", timestamp: p.ts, data: v.slice(opusOffset) }),
                );
                p.ts += 2500;
              } catch {
                /* skip */
              }
            }
          }
        }
      }
    })();

    const setSink = (elem: HTMLAudioElement | null, id: string) => {
      if (elem && "setSinkId" in elem) {
        (elem as unknown as { setSinkId: (s: string) => Promise<void> })
          .setSinkId(id || "")
          .catch(() => {});
      }
    };

    return {
      teardown: () => {
        closePeers();
        try {
          if (masterEl) {
            masterEl.pause();
            masterEl.srcObject = null;
          }
          if (masterComp) masterComp.disconnect();
        } catch {
          /* gone */
        }
        try {
          if (encoder && encoder.state !== "closed") encoder.close();
        } catch {
          /* gone */
        }
        try {
          wt.close();
        } catch {
          /* gone */
        }
      },
      setDevice: (id: string) => {
        curDevice = id;
        setSink(masterEl, id); // context path: one shared output element
        for (const p of peers.values()) setSink(p.el, id); // fallback path: per-peer
      },
    };
  } catch {
    closePeers();
    try {
      if (encoder && encoder.state !== "closed") encoder.close();
    } catch {
      /* noop */
    }
    try {
      if (wt) wt.close();
    } catch {
      /* noop */
    }
    return null;
  }
}
