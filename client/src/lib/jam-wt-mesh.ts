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

// ── Jamulus-style ADAPTIVE jitter buffer (replaces the old fixed 45 ms cap). ──────
//
// Reverse-engineered from Jamulus' buffer.cpp: it runs parallel simulated buffers of
// sizes 2..11 blocks, tracks each one's underrun ERROR-RATE, and picks the SMALLEST
// buffer whose error-rate stays under a bound — IIR-filtered with hysteresis (up fast,
// down slow) so it settles at the true minimum the network needs instead of a fixed
// guess. SonoBus/AOO reach the same end with a DLL + resampling. A fixed 45 ms cap is
// the crude version: on a clean link it wastes ~30 ms it never needed.
//
// We can't clone the C++ verbatim (our playout is a MediaStreamTrackGenerator that
// pulls at realtime, not a block Get()), so this is the faithful *principle* adapted to
// our path: estimate the live buffer from written-samples vs wall-clock (the generator
// plays at realtime — verified: <audio>.currentTime tracks wall-clock), measure real
// inter-arrival jitter (RFC 3550-style) and near-underruns, and every ~0.5 s move the
// target cushion toward `frame + 3×jitter` — snapping UP fast when underruns appear,
// drifting DOWN slowly when the link is stable. Drop a frame only when we're past the
// *adaptive* target, so latency pins to the minimum the network currently allows.
const SR = 48000;
const MIN_TARGET_MS = 8; // never below ~3 frames of cushion (sample-rate offset safety)
const MAX_TARGET_MS = 60; // hard ceiling so a bad link can't creep forever
const ADAPT_EVERY = 200; // frames between re-decisions (~0.5 s at 2.5 ms/frame)

export class AdaptiveJitterBuffer {
  private startMs = 0;
  private written = 0; // samples handed to the generator
  private lastArrival = 0;
  private jitterMs = 0; // smoothed RFC 3550 jitter
  private frames = 0;
  private targetSamples = SR * 0.02; // start at 20 ms, adapt from there
  private readonly nominalMs: number;
  private readonly minS = SR * (MIN_TARGET_MS / 1000);
  private readonly maxS = SR * (MAX_TARGET_MS / 1000);
  // Live stat for verifying the buffer in a real session (window.__jamMeshStats).
  private readonly stat: { bufferedMs: number; targetMs: number; jitterMs: number; drops: number };

  constructor(nominalMs = 2.5) {
    this.nominalMs = nominalMs;
    const g = globalThis as unknown as {
      __jamMeshStats?: { bufferedMs: number; targetMs: number; jitterMs: number; drops: number };
    };
    this.stat = g.__jamMeshStats ||= { bufferedMs: 0, targetMs: 20, jitterMs: 0, drops: 0 };
  }

  // true ⇒ DROP this frame (we're already past the adaptive target).
  shouldDrop(numberOfFrames: number): boolean {
    const now = performance.now();
    if (this.startMs === 0) {
      this.startMs = now;
      this.lastArrival = now;
    }
    // RFC 3550 jitter: smoothed |interarrival − nominal|.
    const d = Math.abs(now - this.lastArrival - this.nominalMs);
    this.lastArrival = now;
    this.jitterMs += (d - this.jitterMs) / 16;
    this.frames++;

    const played = ((now - this.startMs) / 1000) * SR;
    const buffered = this.written - played;

    if (this.frames % ADAPT_EVERY === 0) {
      // Smallest cushion that covers the measured jitter (Jamulus: the min buffer whose
      // error-rate stays under bound; here the jitter estimate IS that bound). 3×jitter
      // ≈ P99 of a roughly-normal arrival spread — enough that legitimate jitter bursts
      // aren't clipped, but drift past it IS dropped. This is a DROP-only playout, so
      // the target is purely the drop threshold; raising it can't prevent underruns, so
      // there's no underrun-boost — the jitter term self-regulates (clean→low, jittery→
      // higher) and drift is always capped at this adaptive minimum, never a fixed 45.
      const wantS =
        SR *
        (Math.min(MAX_TARGET_MS, Math.max(MIN_TARGET_MS, this.nominalMs + 3 * this.jitterMs)) /
          1000);
      // IIR up-fast / down-slow (Jamulus: down filtering slower than up) so it snaps to
      // cover a jitter spike quickly but reclaims latency gently as the link settles.
      const k = wantS > this.targetSamples ? 0.5 : 0.08;
      this.targetSamples += (wantS - this.targetSamples) * k;
      this.targetSamples = Math.max(this.minS, Math.min(this.maxS, this.targetSamples));
    }

    this.stat.bufferedMs = +((buffered / SR) * 1000).toFixed(0);
    this.stat.targetMs = +((this.targetSamples / SR) * 1000).toFixed(0);
    this.stat.jitterMs = +this.jitterMs.toFixed(1);

    if (buffered > this.targetSamples) {
      this.stat.drops++;
      return true;
    }
    this.written += numberOfFrames;
    return false;
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
            if (self && self.buf.shouldDrop(ad.numberOfFrames)) {
              try {
                ad.close();
              } catch {
                /* already closed */
              }
              return;
            }
            // Apply this peer's per-slider volume (0..4) to the PCM — the <audio>
            // element can't (capped at 1.0), so do it digitally with a soft knee.
            const scaled = scaleAudio(ad, self ? getGain(self.appId) : 1);
            gw.write(scaled).catch(() => {
              try {
                scaled.close();
              } catch {
                /* already closed */
              }
            });
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
        p = { decoder, el, ts: 0, buf: new AdaptiveJitterBuffer(2.5), appId: "" };
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
