// THROWAWAY probe — playback worklet.
// A minimal ring buffer we control ourselves — this is the whole point of the
// experiment: bypass WebRTC's NetEQ and hold the smallest jitter cushion we
// choose. Decoded PCM arrives via port messages; process() drains it. Underflow
// plays silence (and is counted on the main thread via the fill level we post
// back). targetFill (samples) is the deliberate cushion, settable live.
class PlaybackWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const cap = (options.processorOptions && options.processorOptions.capacity) || 48000;
    this.buf = new Float32Array(cap);
    this.read = 0;
    this.write = 0;
    this.available = 0;
    this.underflows = 0;
    this.port.onmessage = (e) => {
      const pcm = e.data;
      for (let i = 0; i < pcm.length; i++) {
        this.buf[this.write] = pcm[i];
        this.write = (this.write + 1) % this.buf.length;
        if (this.available < this.buf.length) this.available++;
        else this.read = (this.read + 1) % this.buf.length; // overwrite oldest
      }
    };
    this._tick = 0;
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.available > 0) {
        out[i] = this.buf[this.read];
        this.read = (this.read + 1) % this.buf.length;
        this.available--;
      } else {
        out[i] = 0;
        this.underflows++;
      }
    }
    // Report buffer health ~every 100 ms so the page can show the real cushion.
    if ((this._tick++ & 15) === 0) {
      this.port.postMessage({ available: this.available, underflows: this.underflows });
    }
    return true;
  }
}
registerProcessor("playback-worklet", PlaybackWorklet);
