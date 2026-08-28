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
    const now = Date.now();
    const lookaheadMs = 220;
    // First upcoming beat index on the SERVER timeline.
    let n = Math.ceil((this.clock.serverNow() - this.anchorServerMs) / beatMs);
    if (n < 0) n = 0;
    for (let i = 0; i < 16; i++) {
      const idx = n + i;
      const beatServer = this.anchorServerMs + idx * beatMs;
      const beatLocal = this.clock.localForServer(beatServer);
      const dt = beatLocal - now; // ms until this beat, in local time
      if (dt < -10) continue;
      if (dt > lookaheadMs) break;
      if (this.scheduled.has(idx)) continue;
      this.scheduled.add(idx);
      this.click(this.ctx.currentTime + Math.max(0, dt) / 1000, idx);
    }
    // Prune old scheduled indices so the Set doesn't grow unbounded.
    if (this.scheduled.size > 64) {
      const cutoff = n - 8;
      for (const k of this.scheduled) if (k < cutoff) this.scheduled.delete(k);
    }
    this.timer = window.setTimeout(this.tick, 50);
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
