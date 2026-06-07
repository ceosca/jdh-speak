import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { useRoomStore, MAX_MIC_GAIN } from "../stores/room";

// Mirror the room's outgoing soft limiter so the previewed level matches what
// peers will actually hear (see MIC_LIMITER in useMediasoup).
const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 };

// Test your mic before joining and set a send-side gain (handy for a quiet or
// cheap mic). The value lives in the room store + localStorage, so it carries
// straight into the room.
export function MicPreview() {
  const micGain = useRoomStore((s) => s.micGain);
  const setMicGain = useRoomStore((s) => s.setMicGain);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const meterRef = useRef<HTMLDivElement | null>(null);

  // Live-apply slider changes to the preview gain while testing.
  useEffect(() => {
    const ctx = ctxRef.current;
    const gain = gainRef.current;
    if (ctx && gain) gain.gain.setTargetAtTime(micGain, ctx.currentTime, 0.03);
  }, [micGain]);

  const stop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    gainRef.current = null;
    const bar = meterRef.current;
    if (bar) {
      bar.style.transform = "scaleX(0)";
      bar.style.backgroundColor = "";
    }
    setTesting(false);
  }, []);

  const start = useCallback(async () => {
    setError("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch {
      setError("Couldn't access your microphone — check the browser permission.");
      return;
    }
    streamRef.current = stream;

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = micGain;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    // Terminate into a muted gain → destination so the graph is pulled, without
    // routing the mic to the speakers (which would cause echo/feedback).
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(gain);
    gain.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(silent);
    silent.connect(ctx.destination);

    ctxRef.current = ctx;
    gainRef.current = gain;

    const buf = new Float32Array(analyser.fftSize);
    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const level = Math.min(1, rms * 4); // ~rms 0.25 fills the bar
      const bar = meterRef.current;
      if (bar) {
        bar.style.transform = `scaleX(${level})`;
        // Warn (red) as the post-gain signal nears clipping.
        bar.style.backgroundColor = level > 0.9 ? "#f43f5e" : "";
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    setTesting(true);
  }, [micGain]);

  // Stop the preview on unmount (e.g. when navigating into the room).
  useEffect(() => () => stop(), [stop]);

  return (
    <div className="rounded-lg border border-sonic-600 bg-sonic-700/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-sonic-200">Mic level</span>
        <span className="font-mono text-xs text-sonic-400">{micGain.toFixed(1)}×</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={testing ? stop : start}
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
            testing
              ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
              : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-pressed={testing}
        >
          {testing ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          {testing ? "Stop" : "Test"}
        </button>
        <input
          type="range"
          min="0"
          max={MAX_MIC_GAIN}
          step="0.01"
          value={micGain}
          onChange={(e) => setMicGain(parseFloat(e.target.value))}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
          aria-label="Microphone level"
        />
      </div>

      {/* Live level meter — only animates while testing. */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sonic-600">
        <div
          ref={meterRef}
          className="h-full w-full origin-left rounded-full bg-sonic-accent"
          style={{ transform: "scaleX(0)" }}
        />
      </div>

      <p className="mt-1.5 text-xs text-sonic-400">
        {error
          ? error
          : testing
            ? "Speak normally and raise the slider until the bar sits around the middle."
            : "Quiet or cheap mic? Test it and boost — the level carries into the room."}
      </p>
    </div>
  );
}
