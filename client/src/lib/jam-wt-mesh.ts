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
  // Anti-creep clock: written-audio-samples vs wall-clock, to drop when we get ahead.
  startMs: number;
  written: number;
};

// Bound the playout buffer so latency can't creep. The sender's 48 kHz capture clock
// and our playout clock drift; if we write faster than realtime the generator queues
// unboundedly and the delay grows forever (exactly the "delay keeps growing" bug). So
// before writing a decoded frame, estimate the buffer = samplesWritten − samplesPlayed
// (wall-clock × 48000); if it exceeds the cap, DROP this frame to catch up. Keeps the
// added latency pinned near the target instead of climbing.
const MAX_BUFFER_SAMPLES = 48000 * 0.045; // ~45 ms cap
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shouldDrop(p: { startMs: number; written: number }, ad: any): boolean {
  const now = performance.now();
  if (p.startMs === 0) p.startMs = now;
  const played = ((now - p.startMs) / 1000) * 48000;
  const buffered = p.written - played;
  // Lightweight live stat so the bounded-buffer behaviour can be verified in a real
  // session (window.__jamMeshStats.bufferedMs / drops). Harmless; throwaway-branch aid.
  const g = globalThis as unknown as { __jamMeshStats?: { bufferedMs: number; drops: number } };
  const s = (g.__jamMeshStats ||= { bufferedMs: 0, drops: 0 });
  s.bufferedMs = +((buffered / 48000) * 1000).toFixed(0);
  if (buffered > MAX_BUFFER_SAMPLES) {
    s.drops++;
    return true; // ahead of realtime → drop
  }
  p.written += ad.numberOfFrames;
  return false;
}

export async function setupWtMesh(
  micTrack: MediaStreamTrack,
  jamUrl: string,
  certHash: number[] | null,
  room: string,
  deviceId: string,
  channels: number,
): Promise<WtMeshHandle | null> {
  if (!wtMeshSupported()) return null;
  const ch = channels === 2 ? 2 : 1;
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
            if (self && shouldDrop(self, ad)) {
              try {
                ad.close();
              } catch {
                /* already closed */
              }
              return;
            }
            gw.write(ad).catch(() => {
              try {
                ad.close();
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
        p = { decoder, el, ts: 0, startMs: 0, written: 0 };
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
          const buf = new ArrayBuffer(chunk.byteLength + 13);
          const dv = new DataView(buf);
          dv.setUint8(0, 0x01);
          dv.setUint32(1, seq, true);
          dv.setFloat64(5, performance.now(), true);
          chunk.copyTo(new Uint8Array(buf, 13));
          seq = (seq + 1) >>> 0;
          writer.write(new Uint8Array(buf)).catch(() => {});
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
        if (type === 0x01 && v.byteLength > 15) {
          const senderId = dv.getUint16(1, true);
          if (senderId === myId) continue; // our own return → the /echo monitor's job
          const p = ensurePeer(senderId);
          if (p && p.decoder.state === "configured") {
            try {
              p.decoder.decode(
                new EncodedAudioChunk({ type: "key", timestamp: p.ts, data: v.slice(15) }),
              );
              p.ts += 2500;
            } catch {
              /* skip */
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
