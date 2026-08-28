// Shared jam metronome — clicks generated locally but phase-locked to the SERVER clock
// (via ClockSync), so the beat lands at the same server-instant for every musician even
// though their audio flows P2P at minimum latency. This is the "elemento que llega a
// todos igual": you play to the shared click, not to what you hear, and compensate the
// network delay of the instruments against a common timeline.
//
// Scheduling: a ~50 ms look-ahead loop converts each upcoming beat's server-time to
// local time (ClockSync) and then to AudioContext time, and schedules a short click.
// Web Audio's sample-accurate scheduling makes the click land within a fraction of a ms
// of the intended moment; the only error is the clock-sync offset error.

interface Clock {
  serverNow(): number;
  localForServer(serverMs: number): number;
}

export class Metronome {
  private timer: number | null = null;
  private scheduled = new Set<number>();
  private bpm = 100;
  private anchorServerMs = 0;
  private clock: Clock | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: AudioNode,
  ) {}

  start(bpm: number, anchorServerMs: number, clock: Clock): void {
    this.stop();
    this.bpm = bpm;
    this.anchorServerMs = anchorServerMs;
    this.clock = clock;
    this.tick();
  }

  update(bpm: number, anchorServerMs: number): void {
    // Live BPM/anchor change without a restart (keeps already-scheduled clicks).
    this.bpm = bpm;
    this.anchorServerMs = anchorServerMs;
  }

  private tick = (): void => {
    if (!this.clock) return;
    const beatMs = 60000 / this.bpm;
    // Snapshot the three clocks together: Date.now() (clock-sync domain), performance.now
    // (audio domain), and getOutputTimestamp() (the ACTUAL ctx↔output correlation, which
    // captures this machine's real output latency). We compute the ctx time to schedule
    // each beat so the SOUND EMERGES at the target server-instant — so two machines with
    // different output latencies still emerge together (the big desync source, measured
    // ~52 ms here). Without getOutputTimestamp, fall back to the outputLatency estimate.
    const dateNow = Date.now();
    const perfNow = performance.now();
    const ots =
      typeof this.ctx.getOutputTimestamp === "function" ? this.ctx.getOutputTimestamp() : null;
    const otsCtx = ots?.contextTime;
    const otsPerf = ots?.performanceTime;
    const useOts = otsCtx != null && otsPerf != null && otsPerf > 0;
    const outLat = this.ctx.outputLatency || this.ctx.baseLatency || 0.02;

    let n = Math.ceil((this.clock.serverNow() - this.anchorServerMs) / beatMs);
    if (n < 0) n = 0;
    for (let i = 0; i < 24; i++) {
      const idx = n + i;
      if (this.scheduled.has(idx)) continue;
      const beatServer = this.anchorServerMs + idx * beatMs;
      const beatLocalDate = this.clock.localForServer(beatServer); // Date.now() domain
      let at: number; // ctx.currentTime domain time to schedule at
      if (useOts) {
        const beatPerf = perfNow + (beatLocalDate - dateNow); // performance.now() domain
        at = otsCtx + (beatPerf - otsPerf) / 1000;
      } else {
        at = this.ctx.currentTime + (beatLocalDate - dateNow) / 1000 - outLat;
      }
      const ahead = at - this.ctx.currentTime;
      if (ahead < -0.03) continue; // already passed at the output → skip
      if (ahead > 0.3) break; // beyond the look-ahead window
      this.scheduled.add(idx);
      this.click(Math.max(this.ctx.currentTime + 0.0005, at), idx);
    }
    if (this.scheduled.size > 64) {
      const cutoff = n - 8;
      for (const k of this.scheduled) if (k < cutoff) this.scheduled.delete(k);
    }
    this.timer = window.setTimeout(this.tick, 40);
  };

  private click(at: number, idx: number): void {
    const accent = idx % 4 === 0; // stress beat 1 of each 4
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1100;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(accent ? 0.6 : 0.4, at + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(g).connect(this.out);
    osc.start(at);
    osc.stop(at + 0.06);
  }

  stop(): void {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduled.clear();
    this.clock = null;
  }
}
