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

import { AdaptiveJitterBuffer, type JamBufferBounds, type JamFrame } from "./jam-wt-mesh";

type BypassHandle = { teardown: () => void };

// 10 ms floor. Measured: dropping this to 5 ms did NOT lower steady-state latency —
// each stream self-tunes to a jitter-bound cushion (~11-14 ms clean, more when
// jittery) regardless of the floor, and 5 ms only added startup churn. The receive
// latency here is jitter-bound, not floor-bound; 10 ms is the stable minimum.
const PREBUFFER_SAMPLES = 480;
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
    this.target=this.pre; this.clean=0; // adaptive cushion + samples since last underflow
    this.floorMin=opt.floorMin||144; // absolute lowest cushion (3ms) — never below this
    this.buf=[]; for(let c=0;c<this.channels;c++) this.buf.push(new Float32Array(this.cap));
    this.read=0; this.write=0; this.avail=0; this.started=false; this.underflows=0; this._t=0;
    this.port.onmessage=(e)=>{ const ch=e.data; const n=ch[0].length;
      // Couple the cushion floor to the ACTUAL frame size: PCM arrives one Opus
      // frame at a time (480 samples @ ptime=10, 240 @ ptime=5). A cushion smaller
      // than one frame drains between arrivals and underflows every frame, so the
      // real floor is ~one frame + 1ms. Tracking it here means lowering ptime to 5
      // automatically lowers the receive floor to ~5ms, and if the browser ignores
      // ptime=5 and keeps 10ms frames the floor stays at 10ms — no periodic glitch
      // either way.
      if(n>0){ const need=Math.max(this.floorMin, n+48); this.pre = need>this.pre ? need : Math.max(this.floorMin, this.pre-1); if(this.target<this.pre) this.target=this.pre; }
      for(let i=0;i<n;i++){ for(let c=0;c<this.channels;c++) this.buf[c][this.write]=ch[c]?ch[c][i]:ch[0][i];
        this.write=(this.write+1)%this.cap; if(this.avail<this.cap) this.avail++; else this.read=(this.read+1)%this.cap; } };
  }
  _report(){ if(((this._t=(this._t+1))&15)===0) this.port.postMessage({h:{avail:this.avail,underflows:this.underflows,target:this.target}}); }
  process(_i,outputs){ const out=outputs[0]; const frames=out[0].length;
    // Adaptive cushion: start at pre (10ms); each underflow grows the target
    // (+5ms, cap 60ms) so a jittery stream finds its own stable buffer, exactly
    // what NetEQ does — but we start far lower and only grow as needed. After a
    // long clean run we decay it back down (probe for lower latency).
    if(!this.started){ if(this.avail>=this.target) this.started=true; else { for(const o of out) o.fill(0); this._report(); return true; } }
    // Drift compensation: sender vs AudioContext clocks differ, so the cushion
    // creeps over a long session. Drop ONE 48kHz sample (inaudible) per block when
    // it exceeds 2x the current target — only with ample buffer, never causing an
    // underflow.
    if(this.avail > this.target*2 + frames){ this.read=(this.read+1)%this.cap; this.avail--; }
    for(let i=0;i<frames;i++){ if(this.avail>0){ for(let c=0;c<out.length;c++) out[c][i]=this.buf[Math.min(c,this.channels-1)][this.read];
        this.read=(this.read+1)%this.cap; this.avail--; }
      else { for(let c=0;c<out.length;c++) out[c][i]=0; this.started=false; this.underflows++;
        this.target=Math.min(this.target+240, 2880); this.clean=0; break; } }
    // Decay: ~8s clean -> shave 1ms off the target, never below pre.
    this.clean+=frames; if(this.clean>384000 && this.target>this.pre){ this.target=Math.max(this.pre, this.target-48); this.clean=0; }
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
  bypass: boolean,
): Promise<BypassHandle | null> {
  if (!jamBypassSupported(receiver)) return null;
  const ch = channels === 2 ? 2 : 1;

  const w = window as unknown as { __jamBypassStats?: Record<string, unknown> };
  const stats = { channels: ch, framesIn: 0, decoded: 0, cushionMs: 0, targetMs: 0, underflows: 0 };
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

    // Passthrough: pipe every frame straight through to the normal decoder/NetEQ.
    // This is REQUIRED whenever the recv PC has encodedInsertableStreams enabled —
    // Chrome routes every frame through this pipeline, so a consumer we don't tap
    // would be SILENT. The music caster and any consumer we choose not to bypass go
    // through here and play normally (that outage was exactly an untapped consumer).
    if (!bypass) {
      delete (w.__jamBypassStats as Record<string, unknown>)[statId];
      (async () => {
        for (;;) {
          let r: ReadableStreamReadResult<AnyRec>;
          try {
            r = await reader.read();
          } catch {
            break;
          }
          if (r.done) break;
          try {
            await writer.write(r.value);
          } catch {
            break;
          }
        }
      })();
      return { teardown: () => {} };
    }

    await ensureWorkletModule(ctx);
    node = new AudioWorkletNode(ctx, "jam-ring", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [ch],
      processorOptions: { channels: ch, capacity: RING_CAPACITY, prebuffer: PREBUFFER_SAMPLES },
    });
    node.port.onmessage = (e: MessageEvent) => {
      const h = (e.data as { h?: { avail: number; underflows: number; target: number } }).h;
      if (h) {
        stats.cushionMs = +((h.avail / 48000) * 1000).toFixed(1);
        stats.targetMs = +((h.target / 48000) * 1000).toFixed(1);
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

// ── Generator playout for the network monitor (the biggest browser win) ──────
//
// Measured on Windows: AudioContext output ≈ 42 ms, but WebRTC/media-element output
// ≈ 23 ms. Routing the monitor through the AudioContext graph therefore costs ~19 ms
// of pure output buffer. This path avoids the AudioContext entirely: tap the encoded
// frames (bypassing NetEQ, ~10 ms cushion of our own), decode with WebCodecs, write
// the PCM into a MediaStreamTrackGenerator, and play THAT track through a plain
// <audio> element (WebRTC's low-latency media output) — with setSinkId so it can go
// out a second card. Net ≈ ring 10 + output 23 ≈ 33 ms vs ~52 ms through the graph.
// Universal (any Chrome/Edge), no ASIO needed. Mechanism verified in a loopback
// (generated track plays in real time). FAIL-SAFE: returns null on any failure so
// the caller keeps the normal AudioContext monitor path.

export function generatorMonitorSupported(receiver: RTCRtpReceiver): boolean {
  return (
    jamBypassSupported(receiver) &&
    typeof (globalThis as AnyRec).MediaStreamTrackGenerator !== "undefined" &&
    typeof AudioDecoder !== "undefined"
  );
}

export type GeneratorMonitorHandle = {
  teardown: () => void;
  setDevice: (deviceId: string) => void;
  // Per-peer volume/deafen: the <audio> element's own volume (0..1). Not used for
  // the self-monitor (always 1), but the peer playout composes effectiveGain here.
  setVolume: (v: number) => void;
};

export function setupGeneratorMonitor(
  receiver: RTCRtpReceiver,
  deviceId: string,
  channels: number,
  initialVolume = 1,
  bounds?: JamBufferBounds,
): GeneratorMonitorHandle | null {
  if (!generatorMonitorSupported(receiver)) return null;
  const ch = channels === 2 ? 2 : 1;
  let decoder: AudioDecoder | null = null;
  let el: HTMLAudioElement | null = null;
  try {
    const streams = (receiver as unknown as AnyRec).createEncodedStreams();
    const reader: ReadableStreamDefaultReader = streams.readable.getReader();
    // Frames are read and NOT written back → dropped from NetEQ (we play them).
    const gen = new (globalThis as AnyRec).MediaStreamTrackGenerator({ kind: "audio" });
    const w: WritableStreamDefaultWriter = gen.writable.getWriter();
    // Jitter cushion + SMOOTH drift compensation (mediasoup frames are 10 ms here).
    // See AdaptiveJitterBuffer.
    const jbuf = new AdaptiveJitterBuffer(10, ch, bounds);
    decoder = new AudioDecoder({
      output: (ad) => {
        jbuf.push(ad as unknown as JamFrame, 1, (f) =>
          (w.write(f) as Promise<void>).catch(() => {
            try {
              f.close();
            } catch {
              /* already closed */
            }
          }),
        );
      },
      error: () => {
        /* stream goes quiet on this path; teardown restores NetEQ */
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
    el.volume = Math.max(0, Math.min(1, initialVolume));
    el.play().catch(() => {});

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
        const buf = (r.value as { data: ArrayBuffer }).data;
        if (!buf || buf.byteLength === 0) continue; // DTX/comfort-noise → skip
        if (decoder && decoder.state === "configured") {
          try {
            decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: ts, data: buf }));
            ts += 20000; // monotonic label only
          } catch {
            /* skip */
          }
        }
      }
    })();

    const elForVol = el;
    return {
      setVolume: (v: number) => {
        try {
          elForVol.volume = Math.max(0, Math.min(1, v));
        } catch {
          /* element gone */
        }
      },
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
          if (decoder && decoder.state !== "closed") decoder.close();
        } catch {
          /* gone */
        }
        jbuf.dispose();
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
      if (decoder && decoder.state !== "closed") decoder.close();
    } catch {
      /* noop */
    }
    return null;
  }
}
