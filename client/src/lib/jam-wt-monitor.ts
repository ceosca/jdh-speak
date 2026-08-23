// Jam network monitor over WebTransport with 2.5 ms Opus frames — the last
// non-WASAPI lever.
//
// The WASAPI I/O floor (~10 ms capture + ~23 ms media output on USB devices in the
// browser) is immovable (IAudioClient3 low-latency is blocked for USB, no browser
// API changes it — probed and researched). But the CODEC/BUFFER overhead ON TOP of
// it still can shrink: Jamulus/SonoBus use 2.5 ms Opus frames; WebRTC's encoder is
// locked at 10 ms. So this path bypasses WebRTC's audio entirely for the self-return
// timing reference: capture the mic as raw AudioData (MediaStreamTrackProcessor),
// encode with WebCodecs at frameDuration 2500 (verified Chrome honours it), send as
// QUIC datagrams to the relay which echoes them straight back (measured ~1.8 ms
// round-trip on LAN), decode with WebCodecs, and play through a
// MediaStreamTrackGenerator → <audio> (the low ~23 ms media output). Net receive
// overhead ~2.5 ms frame + tiny buffer instead of ~10 ms — ~7-15 ms tighter than the
// mediasoup self-consume return.
//
// FAIL-SAFE: returns null on any missing API / setup failure, so applyNetworkMonitor
// falls back to the normal mediasoup self-consume monitor. Monitor-only (the self
// return); the room's real audio is untouched.

export type WtMonitorHandle = {
  teardown: () => void;
  setDevice: (deviceId: string) => void;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = any;

export function wtMonitorSupported(): boolean {
  return (
    typeof WebTransport !== "undefined" &&
    typeof AudioEncoder !== "undefined" &&
    typeof AudioDecoder !== "undefined" &&
    typeof (globalThis as AnyRec).MediaStreamTrackGenerator !== "undefined" &&
    typeof (globalThis as AnyRec).MediaStreamTrackProcessor !== "undefined"
  );
}

export async function setupWtMonitor(
  micTrack: MediaStreamTrack,
  relayUrl: string,
  certHash: number[] | null,
  deviceId: string,
  channels: number,
): Promise<WtMonitorHandle | null> {
  if (!wtMonitorSupported()) return null;
  const ch = channels === 2 ? 2 : 1;
  let wt: AnyRec = null;
  let encoder: AudioEncoder | null = null;
  let decoder: AudioDecoder | null = null;
  let el: HTMLAudioElement | null = null;
  try {
    const opts = certHash
      ? {
          serverCertificateHashes: [
            { algorithm: "sha-256", value: new Uint8Array(certHash) },
          ],
        }
      : undefined;
    wt = new (globalThis as AnyRec).WebTransport(relayUrl, opts);
    await wt.ready;
    const writer = wt.datagrams.writable.getWriter();

    // --- Send: mic → WebCodecs Opus 2.5 ms → datagram (seq + send-time header). ---
    let seq = 0;
    encoder = new AudioEncoder({
      output: (chunk) => {
        try {
          const buf = new ArrayBuffer(chunk.byteLength + 12);
          const dv = new DataView(buf);
          dv.setUint32(0, seq, true);
          dv.setFloat64(4, performance.now(), true);
          chunk.copyTo(new Uint8Array(buf, 12));
          seq = (seq + 1) >>> 0;
          writer.write(new Uint8Array(buf)).catch(() => {});
        } catch {
          /* skip */
        }
      },
      error: () => {
        /* encoder error — path goes quiet; teardown restores the mediasoup monitor */
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
        const audioData = r.value;
        try {
          if (encoder && encoder.state === "configured") encoder.encode(audioData);
        } catch {
          /* skip */
        }
        try {
          audioData.close();
        } catch {
          /* already closed */
        }
      }
    })();

    // --- Receive: echoed datagram → WebCodecs decode → generator → <audio>. ---
    const gen = new (globalThis as AnyRec).MediaStreamTrackGenerator({ kind: "audio" });
    const gw: WritableStreamDefaultWriter = gen.writable.getWriter();
    // Anti-creep: bound the playout buffer (sender/receiver clock drift would grow the
    // delay forever otherwise). Drop a frame when we're > ~45 ms of audio ahead of
    // wall-clock so latency stays pinned near the minimum.
    const clock = { startMs: 0, written: 0 };
    const MAX_BUFFER_SAMPLES = 48000 * 0.045;
    decoder = new AudioDecoder({
      output: (ad) => {
        const now = performance.now();
        if (clock.startMs === 0) clock.startMs = now;
        const buffered = clock.written - ((now - clock.startMs) / 1000) * 48000;
        if (buffered > MAX_BUFFER_SAMPLES) {
          try {
            ad.close();
          } catch {
            /* already closed */
          }
          return;
        }
        clock.written += ad.numberOfFrames;
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

    el = new Audio();
    el.autoplay = true;
    (el as unknown as Record<string, boolean>).playsInline = true;
    el.srcObject = new MediaStream([gen]);
    const setDevice = (id: string) => {
      if (el && "setSinkId" in el) {
        (el as unknown as { setSinkId: (s: string) => Promise<void> })
          .setSinkId(id || "")
          .catch(() => {});
      }
    };
    setDevice(deviceId);
    el.play().catch(() => {});

    const dgReader: ReadableStreamDefaultReader = wt.datagrams.readable.getReader();
    let ts = 0;
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
        if (!v || v.byteLength <= 12) continue;
        const opus = v.slice(12);
        if (decoder && decoder.state === "configured") {
          try {
            decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: ts, data: opus }));
            ts += 2500;
          } catch {
            /* skip */
          }
        }
      }
    })();

    return {
      teardown: () => {
        try {
          if (el) {
            el.pause();
            el.srcObject = null;
          }
        } catch {
          /* gone */
        }
        try {
          if (encoder && encoder.state !== "closed") encoder.close();
        } catch {
          /* gone */
        }
        try {
          if (decoder && decoder.state !== "closed") decoder.close();
        } catch {
          /* gone */
        }
        try {
          wt.close();
        } catch {
          /* gone */
        }
      },
      setDevice,
    };
  } catch {
    try {
      if (el) {
        el.pause();
        el.srcObject = null;
      }
    } catch {
      /* noop */
    }
    try {
      if (encoder && encoder.state !== "closed") encoder.close();
    } catch {
      /* noop */
    }
    try {
      if (decoder && decoder.state !== "closed") decoder.close();
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
