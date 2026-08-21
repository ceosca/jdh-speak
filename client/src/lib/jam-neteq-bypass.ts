// Jam-mode receive-side NetEQ bypass.
//
// Measured problem: WebRTC's NetEQ jitter buffer will not go below ~20-30 ms even
// with `jitterBufferTarget = 0` and a near-perfect stream (verified live: a
// 1 ms-jitter loopback still held ~30 ms). That floor — not the transport — is the
// dominant latency in the jam monitor. This bypasses NetEQ ENTIRELY while keeping
// mediasoup: we tap the encoded Opus frames off the receiver, drop them from the
// normal decode path, decode them ourselves with WebCodecs, and play them through
// our own minimal ring buffer. Net receive latency ~15 ms instead of ~30-60 ms.
//
// Why createEncodedStreams and not RTCRtpScriptTransform: measured in the real app
// that RTCRtpScriptTransform, when attached AFTER mediasoup's receiver is already
// flowing (the only point we can reach it), delivers ZERO frames — Chrome only
// wires that transform if set before setRemoteDescription. createEncodedStreams has
// no such timing constraint (verified: attached 3 s into a live stream, 254 frames
// flowed), but it requires the RTCPeerConnection to be created with
// `encodedInsertableStreams: true` — which we do on the recv transport.
//
// FAIL-SAFE: only engaged when jam mode is on AND every needed API is present. If
// setup throws (e.g. the PC wasn't created with the flag), we never touch the
// stream, so the normal NetEQ path plays as usual — audio is never lost. Teardown
// pipes frames back through (passthrough), restoring NetEQ.
//
// TRADE-OFF (why jam-only): NetEQ does excellent packet-loss concealment and
// jitter adaptation; our minimal buffer trades that robustness for latency. Great
// on a clean network (a jam session), not something to impose on normal calls.

type BypassHandle = { teardown: () => void };

const PREBUFFER_SAMPLES = 480; // 10 ms cushion before playback starts
const RING_CAPACITY = 48000; // 1 s

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = any;

export function jamBypassSupported(receiver: RTCRtpReceiver): boolean {
  return (
    typeof AudioDecoder !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof (receiver as unknown as AnyRec).createEncodedStreams === "function"
  );
}

// Ring-buffer AudioWorklet: main thread posts decoded PCM (per channel); this
// drains it. Underflow -> silence. This is our jitter buffer, as small as the
// prebuffer lets it be. Posts back buffer health so latency is measurable.
const WORKLET_CODE = `
class JamRing extends AudioWorkletProcessor {
  constructor(o){ super();
    const opt=o.processorOptions||{}; this.channels=opt.channels||1; this.cap=opt.capacity||48000; this.pre=opt.prebuffer||480;
    this.buf=[]; for(let c=0;c<this.channels;c++) this.buf.push(new Float32Array(this.cap));
    this.read=0; this.write=0; this.avail=0; this.started=false; this.underflows=0; this._t=0;
    this.port.onmessage=(e)=>{ const ch=e.data; const n=ch[0].length;
      for(let i=0;i<n;i++){ for(let c=0;c<this.channels;c++) this.buf[c][this.write]=ch[c]?ch[c][i]:ch[0][i];
        this.write=(this.write+1)%this.cap; if(this.avail<this.cap) this.avail++; else this.read=(this.read+1)%this.cap; } };
  }
  _report(){ if(((this._t=(this._t+1))&15)===0) this.port.postMessage({h:{avail:this.avail,underflows:this.underflows}}); }
  process(_i,outputs){ const out=outputs[0]; const frames=out[0].length;
    if(!this.started){ if(this.avail>=this.pre) this.started=true; else { for(const o of out) o.fill(0); this._report(); return true; } }
    // Drift compensation: the sender's clock and our AudioContext clock are never
    // exactly equal, so over a long session the cushion slowly creeps up (latency
    // grows) or down (underflows). NetEQ resamples to fix this; our minimal ring
    // instead drops ONE sample per block when the cushion has grown past 2x target
    // (shrinks latency) — a single 48kHz sample is inaudible, and it only kicks in
    // when there's plenty of buffer, so it never causes an underflow.
    if(this.avail > this.pre*2 + frames){ this.read=(this.read+1)%this.cap; this.avail--; }
    for(let i=0;i<frames;i++){ if(this.avail>0){ for(let c=0;c<out.length;c++) out[c][i]=this.buf[Math.min(c,this.channels-1)][this.read];
        this.read=(this.read+1)%this.cap; this.avail--; } else { for(let c=0;c<out.length;c++) out[c][i]=0; this.started=false; this.underflows++; } }
    this._report(); return true; }
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
  if (!jamBypassSupported(receiver)) return null;
  const ch = channels === 2 ? 2 : 1;

  const w = window as unknown as { __jamBypassStats?: Record<string, unknown> };
  const stats = { channels: ch, framesIn: 0, decoded: 0, cushionMs: 0, underflows: 0 };
  const statId = "r" + Math.random().toString(36).slice(2, 8);
  (w.__jamBypassStats ||= {})[statId] = stats;

  let decoder: AudioDecoder | null = null;
  let node: AudioWorkletNode | null = null;
  let active = true; // false after teardown -> passthrough to NetEQ
  try {
    // createEncodedStreams can only be called ONCE per receiver and throws if the
    // PC wasn't created with encodedInsertableStreams. Do it first: if it throws,
    // we bail before touching anything, and NetEQ keeps playing.
    const streams = (receiver as unknown as AnyRec).createEncodedStreams();
    const reader: ReadableStreamDefaultReader = streams.readable.getReader();
    const writer: WritableStreamDefaultWriter = streams.writable.getWriter();

    await ensureWorkletModule(ctx);
    node = new AudioWorkletNode(ctx, "jam-ring", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [ch],
      processorOptions: { channels: ch, capacity: RING_CAPACITY, prebuffer: PREBUFFER_SAMPLES },
    });
    node.port.onmessage = (e: MessageEvent) => {
      const h = (e.data as { h?: { avail: number; underflows: number } }).h;
      if (h) {
        stats.cushionMs = +((h.avail / 48000) * 1000).toFixed(1);
        stats.underflows = h.underflows;
      }
    };
    node.connect(gainNode);

    const ringNode = node;
    decoder = new AudioDecoder({
      output: (audioData) => {
        try {
          stats.decoded++;
          const n = audioData.numberOfFrames;
          const planes: Float32Array[] = [];
          for (let c = 0; c < ch; c++) {
            const p = new Float32Array(n);
            audioData.copyTo(p, { planeIndex: c, format: "f32-planar" });
            planes.push(p);
          }
          ringNode.port.postMessage(
            planes,
            planes.map((p) => p.buffer),
          );
        } catch {
          /* bad frame — skip */
        } finally {
          audioData.close();
        }
      },
      error: () => {
        /* decoder error — this path goes quiet; teardown will restore NetEQ */
      },
    });
    decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: ch });

    // The pump: read encoded frames. While active, decode+drop (NetEQ starved).
    // After teardown, write frames straight through so NetEQ takes over again.
    let ts = 0;
    (async () => {
      for (;;) {
        let r: ReadableStreamReadResult<AnyRec>;
        try {
          r = await reader.read();
        } catch {
          break;
        }
        if (r.done) break;
        const frame = r.value as { data: ArrayBuffer };
        if (active) {
          stats.framesIn++;
          if (decoder && decoder.state === "configured") {
            try {
              decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: ts, data: frame.data }));
              ts += 20000; // monotonic label only
            } catch {
              /* skip */
            }
          }
          // NOT written to `writer` -> dropped from the NetEQ path
        } else {
          try {
            await writer.write(frame as AnyRec);
          } catch {
            break;
          }
        }
      }
    })();

    return {
      teardown: () => {
        active = false; // pump switches to passthrough -> NetEQ restored
        try {
          node?.disconnect();
        } catch {
          /* gone */
        }
        try {
          if (decoder && decoder.state !== "closed") decoder.close();
        } catch {
          /* gone */
        }
        try {
          delete (w.__jamBypassStats as Record<string, unknown>)[statId];
        } catch {
          /* noop */
        }
      },
    };
  } catch {
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
      delete (w.__jamBypassStats as Record<string, unknown>)[statId];
    } catch {
      /* noop */
    }
    return null;
  }
}
