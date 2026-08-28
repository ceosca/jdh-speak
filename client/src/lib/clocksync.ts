// Clock sync (NTP-style) to the server, so a locally-generated metronome can be phase-
// locked to a SHARED server timeline — the "elemento que llega a todos igual". Audio
// stays P2P (minimum latency); synchronisation comes from this shared clock, not from
// routing audio through the SFU hub.
//
// Each ping stamps local time before/after a `time-sync` round-trip and reads the
// server's timestamp. The sample with the LOWEST RTT has the least path asymmetry, so
// its offset (serverMs − localMid) is the most accurate — we keep that one. Over a
// handful of pings this converges to a stable offset; on WAN it's good to ~a few–tens of
// ms, the realistic floor for networked-music sync (same limit Jamulus lives with).

export class ClockSync {
  private offset = 0; // add to Date.now() to get server time
  private minRtt = Infinity;
  private samples: { offset: number; rtt: number }[] = [];
  private timer: number | null = null;

  constructor(
    private readonly emit: <T>(ev: string, data?: unknown) => Promise<T>,
    private readonly onSync?: (rttMs: number) => void,
  ) {}

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
    // Sliding window; the offset is taken from the LOWEST-RTT sample in the window (its
    // path is the most symmetric, so its offset is the most accurate). The window lets us
    // re-acquire a better sample and track slow drift without a growing-error hack.
    this.samples.push({ offset, rtt });
    if (this.samples.length > 60) this.samples.shift();
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.minRtt = best.rtt;
    this.onSync?.(this.rttMs);
  }

  // Rapid burst to converge, then a steady heartbeat to track drift + re-acquire minima.
  async start(): Promise<void> {
    for (let i = 0; i < 15; i++) await this.ping();
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
  get rttMs(): number {
    return this.minRtt === Infinity ? -1 : Math.round(this.minRtt);
  }
}
