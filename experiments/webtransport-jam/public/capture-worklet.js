// THROWAWAY probe — capture worklet.
// Pulls mono mic render-quanta (128 frames) and forwards them to the main thread
// where they're batched into 10 ms Opus frames. Kept dead simple: no processing,
// lowest possible added latency (one quantum).
class CaptureWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      // Copy — the input buffer is reused by the engine after process() returns.
      this.port.postMessage(ch.slice(0));
    }
    return true;
  }
}
registerProcessor("capture-worklet", CaptureWorklet);
