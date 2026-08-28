// Clock sync (NTP-style) to the server, so a locally-generated metronome can be phase-
// locked to a SHARED server timeline — the "elemento que llega a todos igual". Audio
// stays P2P (minimum latency); synchronisation comes from this shared clock, not from
// routing audio through the SFU hub.
//
// Each ping stamps local time before/after a `time-sync` round-trip and reads the
// server's timestamp. The sample with the LOWEST RTT has the least path asymmetry, so
// its offset (serverMs − localMid) is the most accurate. But a SINGLE lowest-RTT sample
// is fragile — one anomalously-fast-but-asymmetric packet fixes a bad offset — so we take
// the MEDIAN offset of the K lowest-RTT samples. That resists a single bad packet while
// still favouring the least-queued (most symmetric) part of the window. Over a handful of
// pings this converges to a stable offset; on WAN it's good to ~a few–tens of ms, the
// realistic floor for networked-music sync (same limit Jamulus lives with).

const K_BEST = 5; // median the offsets of the K lowest-RTT samples

export class ClockSync {
  private offset = 0; // add to Date.now() to get server time
  private minRtt = Infinity;
  private sampleCount = 0;
  private samples: { offset: number; rtt: number }[] = [];
  private timer: number | null = null;

  constructor(
    private readonly emit: <T>(ev: string, data?: unknown) => Promise<T>,
    private readonly onSync?: (rttMs: number) => void,
  ) {}

  private recompute(): void {
    if (this.samples.length === 0) return;
    // Take the K lowest-RTT samples, then the MEDIAN of their offsets (robust to a single
    // asymmetric outlier that happens to have a low RTT).
    const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, K_BEST);
    const offs = byRtt.map((s) => s.offset).sort((a, b) => a - b);
    const mid = Math.floor(offs.length / 2);
    this.offset = offs.length % 2 ? offs[mid] : (offs[mid - 1] + offs[mid]) / 2;
    this.minRtt = byRtt[0].rtt;
  }

  private async ping(): Promise<void> {
    const l0 = Date.now();
    let res: { serverMs: number };
    try {
      res = await this.emit<{ serverMs: number }>("time-sync");
    } catch {
      return;
    }
    const l1 = Date.now();
    const rtt = l1 - l0;
    if (rtt < 0 || rtt > 5000) return;
    const localMid = (l0 + l1) / 2;
    const offset = res.serverMs - localMid;
    // Sliding window; offset = median of the K lowest-RTT samples in the window. The window
    // lets us re-acquire better samples and track slow drift without a growing-error hack.
    this.samples.push({ offset, rtt });
    if (this.samples.length > 60) this.samples.shift();
    this.sampleCount++;
    this.recompute();
    this.onSync?.(this.rttMs);
  }

  // Rapid burst to converge, then a steady heartbeat to track drift + re-acquire minima.
  // The burst is lightly spaced so the samples land in DIFFERENT network moments (back-to-
  // back round-trips can all catch the same transient queue state and agree on a biased
  // minimum); the spacing lets a truly low-asymmetry moment show up.
  async start(): Promise<void> {
    for (let i = 0; i < 15; i++) {
      await this.ping();
      await new Promise((r) => window.setTimeout(r, 40));
    }
    const loop = async () => {
      await this.ping();
      this.timer = window.setTimeout(loop, 2000);
    };
    this.timer = window.setTimeout(loop, 2000);
  }

  stop(): void {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  serverNow(): number {
    return Date.now() + this.offset;
  }
  // Local Date.now() time at which the server clock reads `serverMs`.
  localForServer(serverMs: number): number {
    return serverMs - this.offset;
  }
  // Ready once we have a few samples to median — before that the offset can be raw/biased,
  // so the metronome should hold rather than fire beats at a not-yet-converged offset.
  get ready(): boolean {
    return this.sampleCount >= 3;
  }
  get offsetMs(): number {
    return Math.round(this.offset);
  }
  get rttMs(): number {
    return this.minRtt === Infinity ? -1 : Math.round(this.minRtt);
  }
}
