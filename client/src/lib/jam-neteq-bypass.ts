// Jam-mode receive-side NetEQ bypass.
//
// Measured problem: WebRTC's NetEQ jitter buffer will not go below ~20-30 ms even
// with `jitterBufferTarget = 0` and a near-perfect stream (verified live: a
// 1 ms-jitter loopback still held ~30 ms). That floor — not the transport — is the
// dominant latency in the jam monitor. This bypasses NetEQ ENTIRELY while keeping
// mediasoup: we tap the encoded Opus frames off the receiver via
// RTCRtpScriptTransform (which sits BEFORE the jitter buffer/decoder), drop them
// from the normal decode path, decode them ourselves with WebCodecs, and play them
// through our own minimal ring buffer — the same trick the WebTransport probe used,
// but on the existing SFU. Net receive latency ~15 ms instead of ~30-60 ms.
//
// FAIL-SAFE: only engaged when jam mode is on AND every needed API is present. If
// setup throws, we never attach the transform, so the normal NetEQ path plays as
// usual — audio is never lost. Teardown restores NetEQ (`transform = null`).
//
// TRADE-OFF (why jam-only): NetEQ does excellent packet-loss concealment and
// jitter adaptation; our minimal buffer trades that robustness for latency. Great
// on a clean network (a jam session), not something to impose on normal calls.

type BypassHandle = { teardown: () => void };

// A tiny cushion (samples @48k) the ring buffer tries to keep so brief jitter
// doesn't starve playback. 480 = 10 ms. Kept minimal on purpose — this is the
// whole point. Playback starts once this much has arrived.
const PREBUFFER_SAMPLES = 480; // 10 ms
const RING_CAPACITY = 48000; // 1 s

export function jamBypassSupported(): boolean {
  return (
    typeof RTCRtpScriptTransform !== "undefined" &&
    typeof AudioDecoder !== "undefined" &&
    typeof AudioWorkletNode !== "undefined"
  );
}

// The RTCRtpScriptTransform worker: read encoded frames as they arrive off the
// network and hand each to the main thread; DO NOT enqueue them back, so the
// normal decoder/NetEQ receives nothing and the receiver's track goes silent (we
// play the audio ourselves). Runs one worker per receiver — cheap for jam sizes.
const WORKER_CODE = `
self.onrtctransform = (event) => {
  const t = event.transformer;
  const reader = t.readable.getReader();
  (async () => {
    for (;;) {
      let r;
      try { r = await reader.read(); } catch { break; }
      if (r.done) break;
      const frame = r.value;
      const buf = frame.data; // ArrayBuffer of the encoded Opus packet
      try { self.postMessage({ ts: frame.timestamp, data: buf }, [buf]); } catch {}
      // intentionally NOT calling controller.enqueue / writable.write -> dropped
    }
  })();
};
`;

// A ring-buffer AudioWorklet: main thread posts decoded PCM (per channel); this
// drains it into the output. Underflow -> silence. This is our jitter buffer, and
// it is as small as PREBUFFER lets it be.
const WORKLET_CODE = `
class JamRing extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const opt = o.processorOptions || {};
    this.channels = opt.channels || 1;
    this.cap = opt.capacity || 48000;
    this.pre = opt.prebuffer || 480;
    this.buf = []; for (let c=0;c<this.channels;c++) this.buf.push(new Float32Array(this.cap));
    this.read = 0; this.write = 0; this.avail = 0; this.started = false;
    this.port.onmessage = (e) => {
      const ch = e.data; // array of Float32Array, one per channel
      const n = ch[0].length;
      for (let i=0;i<n;i++){
        for (let c=0;c<this.channels;c++) this.buf[c][this.write] = ch[c] ? ch[c][i] : ch[0][i];
        this.write = (this.write + 1) % this.cap;
        if (this.avail < this.cap) this.avail++; else this.read = (this.read + 1) % this.cap;
      }
    };
  }
  process(_i, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    if (!this.started) { if (this.avail >= this.pre) this.started = true; else { for (const o of out) o.fill(0); return true; } }
    for (let i=0;i<frames;i++){
      if (this.avail > 0) {
        for (let c=0;c<out.length;c++) out[c][i] = this.buf[Math.min(c,this.channels-1)][this.read];
        this.read = (this.read + 1) % this.cap; this.avail--;
      } else { for (let c=0;c<out.length;c++) out[c][i] = 0; this.started = false; }
    }
    return true;
  }
}
registerProcessor('jam-ring', JamRing);
`;

let workletModulePromise: Promise<void> | null = null;
function ensureWorkletModule(ctx: AudioContext): Promise<void> {
  if (!workletModulePromise) {
    const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "text/javascript" }));
    workletModulePromise = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  }
  return workletModulePromise;
}

/**
 * Route one receiver's audio around NetEQ. Returns a handle to tear it down, or
 * null if unsupported / setup failed (caller then keeps the normal NetEQ path).
 */
export async function setupJamReceiveBypass(
  receiver: RTCRtpReceiver,
  gainNode: GainNode,
  ctx: AudioContext,
  channels: number,
): Promise<BypassHandle | null> {
  if (!jamBypassSupported()) return null;
  const ch = channels === 2 ? 2 : 1;
  let worker: Worker | null = null;
  let decoder: AudioDecoder | null = null;
  let node: AudioWorkletNode | null = null;
  let workerUrl = "";
  try {
    await ensureWorkletModule(ctx);

    node = new AudioWorkletNode(ctx, "jam-ring", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [ch],
      processorOptions: { channels: ch, capacity: RING_CAPACITY, prebuffer: PREBUFFER_SAMPLES },
    });
    node.connect(gainNode);

    decoder = new AudioDecoder({
      output: (audioData) => {
        try {
          const n = audioData.numberOfFrames;
          const planes: Float32Array[] = [];
          for (let c = 0; c < ch; c++) {
            const p = new Float32Array(n);
            audioData.copyTo(p, { planeIndex: c, format: "f32-planar" });
            planes.push(p);
          }
          node?.port.postMessage(planes, planes.map((p) => p.buffer));
        } catch {
          /* a bad frame — skip */
        } finally {
          audioData.close();
        }
      },
      error: () => {
        /* decoder error — the stream just goes quiet on this path; non-fatal */
      },
    });
    decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: ch });

    let tsCounter = 0;
    workerUrl = URL.createObjectURL(new Blob([WORKER_CODE], { type: "text/javascript" }));
    worker = new Worker(workerUrl);
    worker.onmessage = (e: MessageEvent) => {
      const { data } = e.data as { ts: number; data: ArrayBuffer };
      if (!decoder || decoder.state !== "configured") return;
      try {
        decoder.decode(
          new EncodedAudioChunk({ type: "key", timestamp: tsCounter, data }),
        );
        tsCounter += 20000; // monotonic label only; playback uses sample counts
      } catch {
        /* skip */
      }
    };

    // Attaching the transform is the point of no return: from here the receiver's
    // own decode path is starved, so if anything above had thrown we would already
    // have bailed WITHOUT touching it (NetEQ still plays). Do it last.
    (receiver as unknown as { transform: unknown }).transform = new RTCRtpScriptTransform(
      worker,
      { channels: ch },
    );

    return {
      teardown: () => {
        try {
          (receiver as unknown as { transform: unknown }).transform = null;
        } catch {
          /* restoring NetEQ failed — nothing else we can do */
        }
        try {
          node?.disconnect();
        } catch {
          /* already gone */
        }
        try {
          if (decoder && decoder.state !== "closed") decoder.close();
        } catch {
          /* already closed */
        }
        try {
          worker?.terminate();
        } catch {
          /* already gone */
        }
        if (workerUrl) URL.revokeObjectURL(workerUrl);
      },
    };
  } catch {
    // Setup failed — undo anything partial and, crucially, DO NOT leave a transform
    // attached, so the normal NetEQ path keeps playing. Return null.
    try {
      node?.disconnect();
    } catch {
      /* noop */
    }
    try {
      if (decoder && decoder.state !== "closed") decoder.close();
    } catch {
      /* noop */
    }
    try {
      worker?.terminate();
    } catch {
      /* noop */
    }
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    return null;
  }
}
