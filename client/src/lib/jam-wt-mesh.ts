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

// Encode one captured chunk at the encoder's channel count. The mic often captures
// STEREO (channelCount:2 on desktop); if the encoder is MONO we must downmix first, or
// encode() throws ("Input audio buffer is incompatible with codec") and NOTHING gets
// sent. If the encoder is STEREO (the user's input is a stereo interface), we encode the
// two channels as-is so jam keeps stereo instead of collapsing it to mono. `channels` is
// the encoder's channel count. Called for every captured chunk on the mesh and monitor.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function encodeFrame(encoder: AudioEncoder, ad: any, channels: number): void {
  if (encoder.state !== "configured") return;
  try {
    if (channels === 1 && ad.numberOfChannels > 1) {
      // Stereo capture into a mono encoder → downmix (L+R)/2.
      const n = ad.numberOfFrames as number;
      const a = new Float32Array(n);
      const b = new Float32Array(n);
      ad.copyTo(a, { planeIndex: 0, format: "f32-planar" });
      ad.copyTo(b, { planeIndex: 1, format: "f32-planar" });
      for (let i = 0; i < n; i++) a[i] = (a[i] + b[i]) * 0.5;
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
    } else {
      // Channel counts match (mono→mono or stereo→stereo) → encode directly.
      encoder.encode(ad);
    }
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
  el: HTMLAudioElement;
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
class StreamResampler {
  private pending: Float32Array[];
  private readPos = 0;
  constructor(private readonly ch: number) {
    this.pending = Array.from({ length: ch }, () => new Float32Array(0));
  }
  process(input: Float32Array[], s: number): Float32Array[] {
    for (let c = 0; c < this.ch; c++) {
      const merged = new Float32Array(this.pending[c].length + input[c].length);
      merged.set(this.pending[c], 0);
      merged.set(input[c], this.pending[c].length);
      this.pending[c] = merged;
    }
    const len = this.pending[0].length;
    const out: number[][] = Array.from({ length: this.ch }, () => []);
    while (this.readPos + 1 < len) {
      const i = Math.floor(this.readPos);
      const frac = this.readPos - i;
      for (let c = 0; c < this.ch; c++) {
        const a = this.pending[c][i];
        out[c].push(a + (this.pending[c][i + 1] - a) * frac);
      }
      this.readPos += s;
    }
    const drop = Math.floor(this.readPos);
    if (drop > 0) {
      for (let c = 0; c < this.ch; c++) this.pending[c] = this.pending[c].slice(drop);
      this.readPos -= drop;
    }
    return out.map((a) => Float32Array.from(a));
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
    const inPlanes: Float32Array[] = [];
    const tmp = new Float32Array(n);
    for (let c = 0; c < this.ch; c++) {
      ad.copyTo(tmp, { planeIndex: c, format: "f32-planar" });
      const p = new Float32Array(n);
      if (gain === 1) p.set(tmp);
      else for (let i = 0; i < n; i++) p[i] = gain === 0 ? 0 : softclip(tmp[i] * gain);
      inPlanes.push(p);
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

    const outPlanes = this.resampler.process(inPlanes, this.prebuffering ? 1 : this.speed);
    const outLen = outPlanes[0].length;

    if (this.prebuffering) {
      if (outLen > 0) {
        this.pendingOut.push(outPlanes);
        this.pendingSamples += outLen;
      }
      if (this.pendingSamples >= target) {
        this.startMs = now;
        this.written = this.pendingSamples;
        this.bufSmoothed = this.pendingSamples;
        for (const planes of this.pendingOut) this.emit(planes, write);
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
      this.emit(outPlanes, write);
    }
  }

  private emit(planes: Float32Array[], write: (f: AudioData) => void): void {
    const outLen = planes[0].length;
    if (outLen === 0) return;
    const data = new Float32Array(outLen * this.ch);
    for (let c = 0; c < this.ch; c++) data.set(planes[c], c * outLen);
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

  const closePeers = () => {
    for (const p of peers.values()) {
      try {
        p.el.pause();
        p.el.srcObject = null;
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
        const el = new Audio();
        el.autoplay = true;
        (el as unknown as Record<string, boolean>).playsInline = true;
        el.srcObject = new MediaStream([gen]);
        if ("setSinkId" in el) {
          (el as unknown as { setSinkId: (s: string) => Promise<void> })
            .setSinkId(curDevice || "")
            .catch(() => {});
        }
        el.play().catch(() => {});
        p = {
          decoder,
          el,
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

    return {
      teardown: () => {
        closePeers();
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
        for (const p of peers.values()) {
          if ("setSinkId" in p.el) {
            (p.el as unknown as { setSinkId: (s: string) => Promise<void> })
              .setSinkId(id || "")
              .catch(() => {});
          }
        }
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
