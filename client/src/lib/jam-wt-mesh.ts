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

// The mic often captures STEREO (channelCount:2 on desktop), but our Opus encoder is
// mono — encoding a stereo AudioData into a mono encoder throws ("Input audio buffer
// is incompatible with codec") and NOTHING gets sent. So downmix to mono first. Voice
// is mono anyway (half the bytes). Called for every captured chunk on both the mesh
// and the WT monitor.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function encodeMono(encoder: AudioEncoder, ad: any): void {
  if (encoder.state !== "configured") return;
  try {
    if (ad.numberOfChannels > 1) {
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

// Apply the per-peer playback gain (0..4) to a decoded PCM frame BEFORE it reaches the
// generator. The mesh plays peers through raw <audio> elements whose `.volume` is capped
// at 1.0 and, worse, was never wired to the per-peer slider at all — so every peer
// played at unity and any voice you'd boosted above 1.0 came out quieter than before
// jam. Scaling the samples here restores the full 0..4 range (with a soft knee) at zero
// added latency and no AudioContext. gain===1 is a no-op (no copy).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scaleAudio(ad: any, gain: number): any {
  if (gain === 1) return ad;
  const ch = ad.numberOfChannels as number;
  const n = ad.numberOfFrames as number;
  const out = new Float32Array(n * ch);
  const tmp = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    ad.copyTo(tmp, { planeIndex: c, format: "f32-planar" });
    for (let i = 0; i < n; i++) out[c * n + i] = gain === 0 ? 0 : softclip(tmp[i] * gain);
  }
  const scaled = new AudioData({
    format: "f32-planar",
    sampleRate: ad.sampleRate,
    numberOfFrames: n,
    numberOfChannels: ch,
    timestamp: ad.timestamp,
    data: out,
  });
  try {
    ad.close();
  } catch {
    /* already closed */
  }
  return scaled;
}

// ── Jamulus-style jitter buffer with USER-CONTROLLED min/max (the fader sliders). ──
//
// Reverse-engineered from Jamulus' buffer.cpp: it sizes the jitter buffer to the
// smallest that keeps the underrun error-rate under a bound, IIR-filtered. Jamulus
// exposes this as a slider (buffer size in blocks) + an Auto checkbox. We mirror BOTH:
// each user drags a min and a max (ms); the buffer floats between them, auto-picking a
// target from the measured jitter, and if they set min==max it's a fixed buffer.
//
//   • min = the floor CUSHION, prebuffered with real frames before playout starts, so
//     it's genuine added latency AND genuine jitter tolerance. Lower = tighter/lower
//     latency but crackles sooner on a jittery link; raise it if it crackles.
//   • max = the drop ceiling (also the anti-creep cap): the buffer may grow to here
//     under jitter/burst before it starts dropping, and clock-drift is always cut back
//     to it so the delay can't run away.
//
// Playout is a MediaStreamTrackGenerator that pulls at realtime, so we estimate the
// live buffer from written-samples vs wall-clock (verified: <audio>.currentTime tracks
// wall-clock). We PREBUFFER to `min` with real audio (no synthetic silence — same
// proven write path), then play; measure RFC 3550 jitter and every ~0.5 s move the
// drop target toward `frame + 3×jitter` (clamped to [min,max], IIR up-fast/down-slow);
// drop above the target; and on a true underrun re-prebuffer to rebuild the cushion.
const SR = 48000;
const MIN_TARGET_MS = 8; // default floor when no user bounds are wired
const MAX_TARGET_MS = 60; // default ceiling when no user bounds are wired

export type JamBufferBounds = { minMs: number; maxMs: number };
// The generator writer only needs these two members of AudioData, so the buffer is
// unit-testable with a plain stub (no real WebCodecs AudioData).
export type JamFrame = { numberOfFrames: number; close: () => void };

export class AdaptiveJitterBuffer {
  private startMs = 0;
  private written = 0; // samples handed to the generator since (re)start
  private lastArrival = 0;
  private jitterMs = 0; // smoothed RFC 3550 jitter (for the live readout only)
  private prebuffering = true; // filling the floor cushion before playout starts
  private pending: JamFrame[] = [];
  private pendingSamples = 0;
  private readonly nominalMs: number;
  private readonly bounds: JamBufferBounds | null;
  // Live stat for verifying the buffer in a real session (window.__jamMeshStats).
  private readonly stat: { bufferedMs: number; targetMs: number; jitterMs: number; drops: number };

  // `bounds` is a LIVE shared object: the caller mutates its minMs/maxMs from the
  // sliders and this buffer reads the new values on the fly — no rebuild.
  constructor(nominalMs = 2.5, bounds?: JamBufferBounds) {
    this.nominalMs = nominalMs;
    this.bounds = bounds ?? null;
    const g = globalThis as unknown as {
      __jamMeshStats?: { bufferedMs: number; targetMs: number; jitterMs: number; drops: number };
    };
    this.stat = g.__jamMeshStats ||= { bufferedMs: 0, targetMs: 20, jitterMs: 0, drops: 0 };
  }

  private minSamples(): number {
    return SR * ((this.bounds ? this.bounds.minMs : MIN_TARGET_MS) / 1000);
  }
  private maxSamples(): number {
    // Guard max ≥ min so a crossed pair can't invert the buffer.
    return Math.max(this.minSamples(), SR * ((this.bounds ? this.bounds.maxMs : MAX_TARGET_MS) / 1000));
  }

  private updateStat(bufSamples: number, ceilingS: number): void {
    this.stat.bufferedMs = +((bufSamples / SR) * 1000).toFixed(0);
    this.stat.targetMs = +((ceilingS / SR) * 1000).toFixed(0);
    this.stat.jitterMs = +this.jitterMs.toFixed(1);
  }

  // Feed one decoded (already gain-scaled) frame. The buffer prebuffers/plays/drops and
  // calls `write` for frames that should reach the generator now; frames it drops (or
  // holds and later discards) are close()d so nothing leaks.
  //
  // Manual, Jamulus-style: PREBUFFER to `min` (the floor cushion — real latency AND
  // jitter tolerance), play, DROP above `max` (latency ceiling + clock-drift creep cap;
  // dropping while we're AHEAD is inaudible — it's just catching up), and on a true
  // underrun re-prebuffer to rebuild the cushion. The user IS the adaptation: lower min
  // for less latency, raise it if it crackles; lower max to cap latency/drift.
  push(ad: JamFrame, write: (f: JamFrame) => void): void {
    const now = performance.now();
    if (this.lastArrival === 0) this.lastArrival = now;
    const d = Math.abs(now - this.lastArrival - this.nominalMs);
    this.lastArrival = now;
    this.jitterMs += (d - this.jitterMs) / 16;

    const minS = this.minSamples();
    const maxS = this.maxSamples();

    if (this.prebuffering) {
      // Hold real frames until the floor cushion (min) is filled, then flush & play.
      // min 0 ⇒ threshold 0 ⇒ flush the first frame immediately (tightest possible).
      this.pending.push(ad);
      this.pendingSamples += ad.numberOfFrames;
      if (this.pendingSamples >= minS) {
        this.startMs = now;
        this.written = this.pendingSamples;
        for (const f of this.pending) write(f);
        this.pending = [];
        this.prebuffering = false;
      }
      this.updateStat(this.pendingSamples, maxS);
      return;
    }

    const played = ((now - this.startMs) / 1000) * SR;
    const buffered = this.written - played;

    if (buffered < 0) {
      // True underrun: the queue drained and the generator output a gap. Re-prebuffer
      // so we refill to the cushion before playing again.
      this.prebuffering = true;
      this.pending = [ad];
      this.pendingSamples = ad.numberOfFrames;
      this.updateStat(this.pendingSamples, maxS);
      return;
    }

    this.updateStat(buffered, maxS);

    if (buffered > maxS) {
      // Past the ceiling (drift/early burst) → drop to cap latency. Inaudible: we're
      // ahead, so skipping a frame just lets playout catch up.
      this.stat.drops++;
      try {
        ad.close();
      } catch {
        /* already closed */
      }
      return;
    }
    this.written += ad.numberOfFrames;
    write(ad);
  }

  // Close any frames still held in the prebuffer (call on teardown).
  dispose(): void {
    for (const f of this.pending) {
      try {
        f.close();
      } catch {
        /* already closed */
      }
    }
    this.pending = [];
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

    // A new sender showed up → build its decoder → generator → <audio>.
    const ensurePeer = (id: number): MeshPeer | null => {
      let p = peers.get(id);
      if (p) return p;
      try {
        const gen = new (globalThis as AnyRec).MediaStreamTrackGenerator({ kind: "audio" });
        const gw: WritableStreamDefaultWriter = gen.writable.getWriter();
        // `p` is assigned just below; the output closure reads its clock fields.
        const decoder = new AudioDecoder({
          output: (ad) => {
            const self = peers.get(id);
            // Apply this peer's per-slider volume (0..4) to the PCM — the <audio>
            // element can't (capped at 1.0), so do it digitally with a soft knee.
            const scaled = scaleAudio(ad, self ? getGain(self.appId) : 1);
            const writeOut = (f: JamFrame) =>
              gw.write(f as unknown as AudioData).catch(() => {
                try {
                  f.close();
                } catch {
                  /* already closed */
                }
              });
            if (self) self.buf.push(scaled, writeOut);
            else writeOut(scaled);
          },
          error: () => {
            /* skip */
          },
        });
        decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: ch });
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
        p = { decoder, el, ts: 0, buf: new AdaptiveJitterBuffer(2.5, bounds), appId: "" };
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
          // [0x01][idLen:u8][appId][seq:4][sendTime:8][opus]. The relay prepends our
          // senderId and forwards the rest verbatim, so stamping our peerId here lets
          // receivers map the stream to the app peer (for per-peer volume) with no
          // relay/server change.
          const idLen = localIdBytes.length;
          const headLen = 1 + 1 + idLen + 4 + 8;
          const buf = new ArrayBuffer(headLen + chunk.byteLength);
          const dv = new DataView(buf);
          const u8 = new Uint8Array(buf);
          dv.setUint8(0, 0x01);
          dv.setUint8(1, idLen);
          u8.set(localIdBytes, 2);
          let o = 2 + idLen;
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
      bitrate: 64000,
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
        if (encoder) encodeMono(encoder, r.value);
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
          // [0x01][senderId:u16][idLen:u8][appId][seq:4][sendTime:8][opus]
          const senderId = dv.getUint16(1, true);
          if (senderId === myId) continue; // our own return → the /echo monitor's job
          const idLen = v[3];
          const opusOffset = 4 + idLen + 12; // idLen + seq(4) + sendTime(8)
          if (v.byteLength <= opusOffset) continue;
          const p = ensurePeer(senderId);
          if (p) {
            if (idLen > 0) p.appId = new TextDecoder().decode(v.subarray(4, 4 + idLen));
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
