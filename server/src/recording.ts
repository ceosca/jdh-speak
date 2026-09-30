import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  mkdir as fsMkdir,
  writeFile as fsWriteFile,
  rm as fsRm,
  rename as fsRename,
} from "node:fs/promises";
import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RtpParameters, RtpCapabilities } from "mediasoup/types";
import {
  PortAllocator,
  buildSdp,
  sdpParamsFromRtp,
  buildCaptureArgs,
  buildMixPlan,
  captureHasAudio,
  computeDelayMs,
  trackFileName,
  type MixInput,
  type MixPlan,
} from "./recording-util.js";

// --- Minimal structural interfaces -----------------------------------------
// We depend only on the slices of mediasoup / child_process / fs that we use,
// so the manager can be driven by fakes in tests. The real mediasoup Router,
// PlainTransport and Consumer satisfy these structurally.

export interface SpawnedProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

// A process spawned with EXTRA input pipes (fd 3, 4, …) — the final stage of the
// parallel mix reads each group's PCM from one of them.
export interface PipedProcess extends SpawnedProcess {
  fds: NodeJS.WritableStream[];
}

export interface RtpConsumer {
  id: string;
  kind: string;
  rtpParameters: RtpParameters;
  resume(): Promise<void>;
  close(): void;
}

export interface RtpPlainTransport {
  connect(params: { ip: string; port: number }): Promise<void>;
  consume(params: {
    producerId: string;
    rtpCapabilities: RtpCapabilities;
    paused?: boolean;
  }): Promise<RtpConsumer>;
  close(): void;
}

export interface RecordingRouter {
  rtpCapabilities: RtpCapabilities;
  createPlainTransport(opts: {
    listenInfo: { protocol: "udp"; ip: string };
    rtcpMux: boolean;
    comedia: boolean;
  }): Promise<RtpPlainTransport>;
}

export interface RecordingDeps {
  spawn: (command: string, args: string[]) => SpawnedProcess;
  // Spawn with `extraFds` additional writable input pipes (fd 3…). Used by the mixer.
  spawnPiped: (command: string, args: string[], extraFds: number) => PipedProcess;
  // Wrap a mixer command so it runs at low CPU priority (it must never starve the live
  // call's media). Identity where unsupported.
  lowPriority: (command: string, args: string[]) => [string, string[]];
  rename: (from: string, to: string) => Promise<void>;
  // Pre-render the mixed download right after a recording is stopped, so the single-file
  // download is then served straight from disk (as fast as the per-track zip) instead of
  // being mixed on the fly while the user waits.
  preRenderMix: boolean;
  // How long to wait for the capture ffmpegs to exit (SIGINT → Ogg trailer written)
  // before pre-rendering anyway.
  captureExitTimeoutMs: number;
  now: () => number;
  mkdir: (dir: string) => Promise<void>;
  writeFile: (file: string, data: string) => Promise<void>;
  rm: (dir: string) => Promise<void>;
  fileSize: (file: string) => number;
  sleep: (ms: number) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  tmpRoot: string;
  ports: PortAllocator;
  ffmpegPath: string;
  rtpListenIp: string;
  // ms to wait after spawning the capture ffmpeg (so it binds its UDP port)
  // before resuming the consumer, to avoid losing the first packets — the FALLBACK
  // when waitForPortBound can't tell (non-Linux).
  resumeDelayMs: number;
  // Resolves true once something listens on this loopback UDP port (the capture
  // ffmpeg), false if it can't tell / timed out. Measured on the Pi: ffmpeg takes
  // ~420 ms to bind (idle; more with several starting at once), so the old fixed
  // 250 ms lost the first part of every track.
  waitForPortBound: (port: number, timeoutMs: number) => Promise<boolean>;
  // How long a stopping capture may keep receiving RTP to exit cleanly on SIGINT
  // before it's cut (see stopRecorder).
  captureStopGraceMs: number;
  // how long a finished (stopped) recording stays downloadable before it's
  // auto-discarded. 0 disables the timer.
  finishedTtlMs: number;
  log: (msg: string) => void;
}

export interface ProducerInfo {
  producerId: string;
  peerId: string;
  // Display name of the producing peer and the track's source ("voice" |
  // "music" | "share"), if known. Purely cosmetic — used to name the files in
  // the per-track download. Captured up front so a left peer's track keeps its
  // name even after the peer is gone.
  label?: string;
  source?: string;
}

interface ProducerRecorder {
  producerId: string;
  peerId: string;
  label?: string;
  source?: string;
  port: number;
  filePath: string;
  startedAt: number;
  transport: RtpPlainTransport;
  consumer: RtpConsumer;
  ffmpeg: SpawnedProcess;
  // Resolves when the capture ffmpeg has exited (its Ogg file is complete).
  exited: Promise<void>;
  // Consumer/transport closed and port released (stopRecorder runs that once).
  released?: boolean;
}

// One captured track in the per-track download: the on-disk file and the name
// it should carry inside the zip.
export interface TrackFile {
  path: string;
  name: string;
}

export type RecordingStatus = "recording" | "finished";

// The pre-rendered mixed download of a finished recording (see RecordingDeps.preRenderMix).
export interface MixCache {
  state: "rendering" | "ready" | "failed";
  // Written while rendering; renamed to `path` when complete.
  partPath: string;
  path: string;
  proc: SpawnedProcess | null;
  // Resolves when rendering ends (true = ready).
  done: Promise<boolean>;
}

// How the mixed download should be served (see mixDownload).
export type MixDownload =
  | { kind: "file"; path: string }
  | {
      kind: "follow";
      partPath: string;
      path: string;
      done: Promise<boolean>;
      isDone: () => boolean;
    }
  | { kind: "stream"; proc: SpawnedProcess };

export interface RoomRecording {
  id: string;
  dir: string;
  startedAt: number;
  router: RecordingRouter;
  recorders: Map<string, ProducerRecorder>;
  // Recorders whose producer went away mid-recording (peer left, stopped
  // sharing, etc.). Their capture is stopped and the file kept on disk so the
  // already-recorded audio is still part of the mix and the per-track download
  // — we never drop a track just because its peer left before the end.
  closedRecorders: ProducerRecorder[];
  status: RecordingStatus;
  ttlHandle: unknown;
  closing: boolean;
  mixCache: MixCache | null;
}

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Linux: is anything bound to this local UDP port? (/proc/net/udp{,6}, local_address
// column "ADDR:PORT" in hex.) null when /proc isn't available (not Linux).
function udpPortBound(port: number): boolean | null {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  let seen = false;
  for (const file of ["/proc/net/udp", "/proc/net/udp6"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    seen = true;
    for (const line of text.split("\n").slice(1)) {
      const local = line.trim().split(/\s+/)[1];
      if (local && local.split(":").pop() === hex) return true;
    }
  }
  return seen ? false : null;
}

async function waitUdpPortBound(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const bound = udpPortBound(port);
    if (bound === null) return false; // can't tell → caller falls back to a fixed delay
    if (bound) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function createDefaultDeps(overrides: Partial<RecordingDeps> = {}): RecordingDeps {
  return {
    spawn: (command, args) => nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }),
    spawnPiped: (command, args, extraFds) => {
      const child = nodeSpawn(command, args, {
        stdio: ["ignore", "pipe", "pipe", ...Array<"pipe">(extraFds).fill("pipe")],
      });
      const fds = child.stdio.slice(3) as unknown as NodeJS.WritableStream[];
      return Object.assign(child, { fds }) as unknown as PipedProcess;
    },
    lowPriority: (command, args) =>
      process.platform === "win32" ? [command, args] : ["nice", ["-n", "19", command, ...args]],
    rename: (from, to) => fsRename(from, to),
    preRenderMix: true,
    captureExitTimeoutMs: 5000,
    now: () => Date.now(),
    mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => undefined),
    writeFile: (file, data) => fsWriteFile(file, data),
    rm: (dir) => fsRm(dir, { recursive: true, force: true }),
    fileSize: (file) => {
      try {
        return statSync(file).size;
      } catch {
        return 0;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      // don't keep the process alive just for a cleanup timer
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    tmpRoot: path.join(os.tmpdir(), "jdh-speak-recordings"),
    ports: new PortAllocator(),
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
    rtpListenIp: "127.0.0.1",
    resumeDelayMs: 250,
    waitForPortBound: waitUdpPortBound,
    captureStopGraceMs: 1500,
    finishedTtlMs: 15 * 60 * 1000,
    log: (msg) => console.log(`[recording] ${msg}`),
    ...overrides,
  };
}

export class RecordingManager {
  private readonly deps: RecordingDeps;
  private readonly recordings = new Map<string, RoomRecording>();

  // Set by the signaling layer so the manager can tell the room when a
  // finished recording is auto-discarded (so clients hide the stale link).
  onExpire?: (roomName: string, recordingId: string) => void;

  constructor(deps: Partial<RecordingDeps> = {}) {
    this.deps = createDefaultDeps(deps);
  }

  // True only while actively capturing — this is what pins the room to SFU.
  // A finished-but-downloadable recording does NOT count.
  isRecording(roomName: string): boolean {
    return this.recordings.get(roomName)?.status === "recording";
  }

  getRecording(roomName: string): RoomRecording | undefined {
    return this.recordings.get(roomName);
  }

  // Begin recording a room. Starts one capture per existing producer; later
  // producers are added via addProducer(). Idempotent while active; if a
  // previous recording for this room is still hanging around (finished, not
  // yet discarded), it's discarded first.
  async start(
    roomName: string,
    router: RecordingRouter,
    producers: ProducerInfo[],
  ): Promise<RoomRecording> {
    const existing = this.recordings.get(roomName);
    if (existing?.status === "recording") return existing;
    if (existing) {
      await this.discard(roomName);
      // A concurrent start() may have claimed the room while discard awaited.
      const claimed = this.recordings.get(roomName);
      if (claimed?.status === "recording") return claimed;
    }

    const startedAt = this.deps.now();
    // Random id: the download URLs are unauthenticated and rely on this being
    // an unguessable capability token (a timestamp-based id is enumerable).
    const id = `rec_${randomUUID()}`;
    const dir = path.join(this.deps.tmpRoot, id);

    const rec: RoomRecording = {
      id,
      dir,
      startedAt,
      router,
      recorders: new Map(),
      closedRecorders: [],
      status: "recording",
      ttlHandle: null,
      closing: false,
      mixCache: null,
    };
    // Claim the room slot BEFORE the first await below — two concurrent
    // start() calls could otherwise both pass the checks above, and the
    // losing recording would be orphaned with its ffmpeg processes and
    // ports never released.
    this.recordings.set(roomName, rec);
    try {
      await this.deps.mkdir(dir);
    } catch (err) {
      this.recordings.delete(roomName);
      throw err;
    }
    this.deps.log(`started ${id} for room "${roomName}" (${producers.length} producer(s))`);

    for (const info of producers) {
      await this.startRecorder(rec, info);
    }
    return rec;
  }

  // Add a producer to an in-progress recording (a new speaker, or a producer
  // that came online after a P2P→SFU switch). No-op unless actively recording.
  async addProducer(roomName: string, info: ProducerInfo): Promise<void> {
    const rec = this.recordings.get(roomName);
    if (!rec || rec.status !== "recording" || rec.closing) return;
    if (rec.recorders.has(info.producerId)) return;
    await this.startRecorder(rec, info);
  }

  // Stop capturing a single producer (it closed / its peer left). The already
  // captured audio stays on disk AND in the recording (moved to closedRecorders)
  // so it's still included in the mix and the per-track download. No-op once a
  // recording is finished (its files must be preserved for download).
  async removeProducer(roomName: string, producerId: string): Promise<void> {
    const rec = this.recordings.get(roomName);
    if (!rec || rec.status !== "recording") return;
    const recorder = rec.recorders.get(producerId);
    if (!recorder) return;
    rec.recorders.delete(producerId);
    rec.closedRecorders.push(recorder);
    await this.stopRecorder(recorder, true);
  }

  // Every recorder that belongs to this recording — still-live ones plus those
  // whose producer left — in chronological (start) order.
  private allRecorders(rec: RoomRecording): ProducerRecorder[] {
    return [...rec.recorders.values(), ...rec.closedRecorders].sort(
      (a, b) => a.startedAt - b.startedAt,
    );
  }

  // Current per-producer files with their start offsets, for mixing. Includes
  // producers that already left — their captured audio is still part of the mix.
  getMixInputs(roomName: string): MixInput[] {
    const rec = this.recordings.get(roomName);
    if (!rec) return [];
    return this.allRecorders(rec).map((r) => ({
      path: r.filePath,
      delayMs: computeDelayMs(rec.startedAt, r.startedAt),
    }));
  }

  // Per-track files (live + already-left producers) with friendly, unique names
  // for the "download every track on its own" zip. Empty/missing captures (a
  // recorder that failed to start) are skipped so the zip has no dead entries.
  getTrackFiles(roomName: string): TrackFile[] {
    const rec = this.recordings.get(roomName);
    if (!rec) return [];
    return this.allRecorders(rec)
      .map((r, i) => ({ path: r.filePath, name: trackFileName(r, i) }))
      .filter((t) => captureHasAudio(this.deps.fileSize(t.path)));
  }

  // Same as getTrackFiles(), addressed by the (hard-to-guess) recording id that
  // the download URL carries. Works for active and finished recordings.
  tracksByRecordingId(recordingId: string): TrackFile[] | null {
    for (const [roomName, rec] of this.recordings) {
      if (rec.id === recordingId) return this.getTrackFiles(roomName);
    }
    return null;
  }

  // The capture files that carry audio, with their start offsets, and their sizes (used
  // to balance the parallel mix groups).
  private mixInputsWithAudio(roomName: string): { inputs: MixInput[]; sizes: number[] } {
    const inputs: MixInput[] = [];
    const sizes: number[] = [];
    for (const i of this.getMixInputs(roomName)) {
      const size = this.deps.fileSize(i.path);
      if (!captureHasAudio(size)) continue;
      inputs.push(i);
      sizes.push(size);
    }
    return { inputs, sizes };
  }

  // Run a mix plan: the group ffmpegs (if any) each write PCM into one extra input pipe
  // of the final ffmpeg, which writes the Ogg/Opus result (stdout or a file). Returns ONE
  // process-like handle: stdout/exit are the final stage's, kill() stops every stage.
  // All stages run at low CPU priority so a download never starves the live call.
  private runMixPlan(plan: MixPlan): SpawnedProcess {
    const { deps } = this;
    const [fCmd, fArgs] = deps.lowPriority(deps.ffmpegPath, plan.final);
    if (plan.groups.length === 0) return deps.spawn(fCmd, fArgs);
    const final = deps.spawnPiped(fCmd, fArgs, plan.groups.length);
    const groups: SpawnedProcess[] = [];
    plan.groups.forEach((gArgs, g) => {
      const [cmd, args] = deps.lowPriority(deps.ffmpegPath, gArgs);
      const proc = deps.spawn(cmd, args);
      groups.push(proc);
      const sink = final.fds[g];
      // A broken pipe (final stage gone / client aborted) must not crash the server.
      (sink as unknown as EventEmitter).on?.("error", () => {});
      (proc.stdout as unknown as EventEmitter | null)?.on?.("error", () => {});
      proc.stdout?.pipe(sink);
      proc.stderr?.on("data", (d: Buffer) => {
        const line = d.toString().trim();
        if (line) deps.log(`mix group ${g}: ${line}`);
      });
    });
    const handle = new EventEmitter() as EventEmitter & SpawnedProcess;
    handle.pid = final.pid;
    handle.stdout = final.stdout;
    handle.stderr = final.stderr;
    handle.kill = (signal?: NodeJS.Signals | number) => {
      for (const p of groups) {
        try {
          p.kill(signal);
        } catch {
          /* gone */
        }
      }
      return final.kill(signal);
    };
    final.on("exit", (code, signal) => {
      // The final stage is done (or died): stop any group still producing.
      for (const p of groups) {
        try {
          p.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
      handle.emit("exit", code, signal);
    });
    return handle;
  }

  // Spawn a one-shot mix of the current capture files into a single Ogg/Opus stream on
  // stdout. Capture processes (if still running) are never interrupted. Files that don't
  // exist yet or carry no audio (e.g. a recorder that failed to start) are skipped, so one
  // bad stream can't zero out the mix. Returns null if there's nothing with audio to mix.
  mix(roomName: string): SpawnedProcess | null {
    const { inputs, sizes } = this.mixInputsWithAudio(roomName);
    if (inputs.length === 0) return null;
    const plan = buildMixPlan(inputs, "pipe:1", sizes);
    this.deps.log(
      `mixing ${inputs.length} stream(s) for room "${roomName}"` +
        (plan.groups.length ? ` in ${plan.groups.length} parallel groups` : ""),
    );
    return this.runMixPlan(plan);
  }

  // Same as mix(), but addressed by the (hard-to-guess) recording id, which is
  // what the download URL carries. Works for active and finished recordings.
  mixByRecordingId(recordingId: string): SpawnedProcess | null {
    for (const [roomName, rec] of this.recordings) {
      if (rec.id === recordingId) return this.mix(roomName);
    }
    return null;
  }

  // How to serve the single-file (mixed) download:
  //  - finished + pre-rendered: the file on disk (fast, like the zip; Range/length work);
  //  - finished + still pre-rendering: follow the growing file (no second, competing mix);
  //  - still recording, or the pre-render failed/was skipped: mix on the fly.
  mixDownload(recordingId: string): MixDownload | null {
    for (const [roomName, rec] of this.recordings) {
      if (rec.id !== recordingId) continue;
      const cache = rec.mixCache;
      if (rec.status === "finished" && cache) {
        if (cache.state === "ready") return { kind: "file", path: cache.path };
        if (cache.state === "rendering") {
          return {
            kind: "follow",
            partPath: cache.partPath,
            path: cache.path,
            done: cache.done,
            isDone: () => cache.state !== "rendering",
          };
        }
      }
      const proc = this.mix(roomName);
      return proc ? { kind: "stream", proc } : null;
    }
    return null;
  }

  // Pre-render the mixed download of a just-finished recording (see preRenderMix). The
  // cache entry already exists (finalize creates it synchronously, so a download clicked
  // the instant "stop" is pressed follows the render instead of starting a second, competing
  // mix). Waits for the capture ffmpegs to exit first so every Ogg file is complete, and
  // creates the (empty) output file BEFORE spawning ffmpeg — ffmpeg only creates it after
  // probing all its inputs, and a download following the file in that gap used to fail.
  private async preRender(
    rec: RoomRecording,
    roomName: string,
    cache: MixCache,
    resolveDone: (ok: boolean) => void,
  ): Promise<void> {
    const { deps } = this;
    const fail = (why: string) => {
      cache.state = "failed";
      deps.log(`mix render ${rec.id}: ${why}`);
      resolveDone(false);
    };
    const exits = this.allRecorders(rec).map((r) => r.exited);
    await Promise.race([Promise.all(exits), deps.sleep(deps.captureExitTimeoutMs)]);
    if (rec.closing || this.recordings.get(roomName) !== rec) return fail("recording discarded");
    const { inputs, sizes } = this.mixInputsWithAudio(roomName);
    if (inputs.length === 0) return fail("nothing with audio to mix");
    try {
      await deps.writeFile(cache.partPath, "");
    } catch (err) {
      return fail(`could not create ${cache.partPath}: ${String(err)}`);
    }
    if (rec.closing) return fail("recording discarded");
    const startedAt = deps.now();
    const proc = this.runMixPlan(buildMixPlan(inputs, cache.partPath, sizes));
    cache.proc = proc;
    proc.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) deps.log(`mix render ${rec.id}: ${line}`);
    });
    proc.on("exit", (code) => {
      cache.proc = null;
      if (code !== 0 || rec.closing) return fail(`failed (code ${code})`);
      deps
        .rename(cache.partPath, cache.path)
        .then(() => {
          cache.state = "ready";
          deps.log(
            `pre-rendered mix for ${rec.id} (${inputs.length} stream(s)) in ` +
              `${Math.round((deps.now() - startedAt) / 1000)} s`,
          );
          resolveDone(true);
        })
        .catch((err) => fail(`rename failed: ${String(err)}`));
    });
  }

  // Stop capturing but KEEP the recording downloadable. Closes every capture
  // (SIGINT finalizes the Ogg trailer), releases transports/ports, and keeps
  // the files on disk until discarded (TTL, a new recording, or room exit).
  async finalize(roomName: string): Promise<RoomRecording | null> {
    const rec = this.recordings.get(roomName);
    if (!rec || rec.status !== "recording") return null;

    rec.status = "finished";
    // Graceful, in parallel: each capture gets up to captureStopGraceMs to exit cleanly.
    await Promise.all(Array.from(rec.recorders.values(), (r) => this.stopRecorder(r, true)));
    // Pre-render the single-file download in the background (never blocks the stop). The
    // cache entry is created NOW, so a download clicked right after "stop" follows it.
    if (this.deps.preRenderMix) {
      let resolveDone!: (ok: boolean) => void;
      const cache: MixCache = {
        state: "rendering",
        partPath: path.join(rec.dir, "mix.ogg.part"),
        path: path.join(rec.dir, "mix.ogg"),
        proc: null,
        done: new Promise<boolean>((r) => (resolveDone = r)),
      };
      rec.mixCache = cache;
      void this.preRender(rec, roomName, cache, resolveDone).catch((err) => {
        cache.state = "failed";
        this.deps.log(`mix render ${rec.id} crashed: ${String(err)}`);
        resolveDone(false);
      });
    }

    if (this.deps.finishedTtlMs > 0) {
      rec.ttlHandle = this.deps.setTimer(() => {
        // Only discard if this exact recording is still the one parked here.
        if (this.recordings.get(roomName)?.id === rec.id) {
          void this.discard(roomName).then(() => this.onExpire?.(roomName, rec.id));
        }
      }, this.deps.finishedTtlMs);
    }
    this.deps.log(`finalized ${rec.id} for room "${roomName}" (kept for download)`);
    return rec;
  }

  // Fully tear down a recording: kill any live captures, release ports/
  // transports, cancel the TTL, and delete the working directory.
  async discard(roomName: string): Promise<void> {
    const rec = this.recordings.get(roomName);
    if (!rec) return;
    rec.closing = true;
    this.recordings.delete(roomName);

    if (rec.ttlHandle) this.deps.clearTimer(rec.ttlHandle);
    // Stop a pre-render still running (its files are about to be deleted).
    try {
      rec.mixCache?.proc?.kill("SIGKILL");
    } catch {
      /* gone */
    }
    // If still actively recording, captures are live and must be killed (their files
    // are about to be deleted, so no graceful wait).
    for (const recorder of rec.recorders.values()) {
      void this.stopRecorder(recorder, false);
    }
    rec.recorders.clear();

    try {
      await this.deps.rm(rec.dir);
    } catch (err) {
      this.deps.log(`failed to remove ${rec.dir}: ${String(err)}`);
    }
    this.deps.log(`discarded ${rec.id} for room "${roomName}"`);
  }

  // Best-effort teardown of every recording (server shutdown).
  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.recordings.keys()).map((name) => this.discard(name)));
  }

  // --- internals ----------------------------------------------------------

  private async startRecorder(rec: RoomRecording, info: ProducerInfo): Promise<void> {
    const { deps } = this;
    let port: number | undefined;
    let transport: RtpPlainTransport | undefined;
    let consumer: RtpConsumer | undefined;
    let ffmpeg: SpawnedProcess | undefined;
    try {
      port = deps.ports.allocate();
      transport = await rec.router.createPlainTransport({
        listenInfo: { protocol: "udp", ip: deps.rtpListenIp },
        rtcpMux: true,
        comedia: false,
      });
      await transport.connect({ ip: deps.rtpListenIp, port });

      consumer = await transport.consume({
        producerId: info.producerId,
        rtpCapabilities: rec.router.rtpCapabilities,
        paused: true,
      });

      const sdp = buildSdp(sdpParamsFromRtp(consumer.rtpParameters, port));
      const base = `${safeId(info.peerId)}__${safeId(info.producerId)}`;
      const sdpPath = path.join(rec.dir, `${base}.sdp`);
      const filePath = path.join(rec.dir, `${base}.ogg`);
      await deps.writeFile(sdpPath, sdp);

      ffmpeg = deps.spawn(deps.ffmpegPath, buildCaptureArgs(sdpPath, filePath));
      const captured = ffmpeg;
      const exited = new Promise<void>((resolve) => captured.on("exit", () => resolve()));
      ffmpeg.stderr?.on("data", (d: Buffer) => {
        const line = d.toString().trim();
        if (line) deps.log(`ffmpeg[${base}]: ${line}`);
      });
      ffmpeg.on("exit", (code, signal) => {
        deps.log(`ffmpeg[${base}] exited code=${code} signal=${signal}`);
      });

      // Let ffmpeg bind its UDP port before media starts flowing (packets sent before
      // that are dropped → the start of the track was missing).
      const bound = await deps.waitForPortBound(port, 5000);
      if (!bound && deps.resumeDelayMs > 0) await deps.sleep(deps.resumeDelayMs);
      // Bail out if the recording was torn down while we were waiting.
      if (rec.closing || rec.status !== "recording") {
        throw new Error("recording closed during recorder startup");
      }
      await consumer.resume();

      rec.recorders.set(info.producerId, {
        producerId: info.producerId,
        peerId: info.peerId,
        label: info.label,
        source: info.source,
        port,
        filePath,
        startedAt: deps.now(),
        transport,
        consumer,
        ffmpeg: captured,
        exited,
      });
      deps.log(`recording producer ${info.producerId} (peer ${info.peerId}) on port ${port}`);
    } catch (err) {
      // Clean up any partially-created resources for this producer.
      try {
        ffmpeg?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      try {
        consumer?.close();
      } catch {
        /* ignore */
      }
      try {
        transport?.close();
      } catch {
        /* ignore */
      }
      if (port !== undefined) deps.ports.release(port);
      deps.log(`failed to record producer ${info.producerId}: ${String(err)}`);
    }
  }

  // Stop one capture. SIGINT makes ffmpeg finish the Ogg cleanly — but ffmpeg only
  // notices the FIRST SIGINT when its next packet arrives (a blocked read isn't
  // interrupted by it). The old code closed the consumer in the same instant, so no
  // packet ever came: ffmpeg hung until a second signal cut it hard ("Immediate exit
  // requested", no trailer, the last buffered audio lost — measured: tracks ~4 s short
  // on the Pi). Graceful: SIGINT while RTP still flows, close the consumer once ffmpeg
  // has exited; if it can't (muted/paused or gone producer → no RTP), cut it after
  // captureStopGraceMs (100 ms Ogg pages keep that loss negligible).
  private async stopRecorder(recorder: ProducerRecorder, graceful: boolean): Promise<void> {
    try {
      recorder.ffmpeg.kill("SIGINT");
    } catch {
      /* ignore */
    }
    if (graceful) {
      const exited = await Promise.race([
        recorder.exited.then(() => true),
        this.deps.sleep(this.deps.captureStopGraceMs).then(() => false),
      ]);
      if (!exited) {
        try {
          recorder.ffmpeg.kill("SIGINT"); // 2nd signal: ffmpeg exits now
        } catch {
          /* ignore */
        }
      }
    }
    // A discard may have torn it down during the grace wait: release only once (a port
    // released twice could be handed to a new capture while still in use).
    if (recorder.released) return;
    recorder.released = true;
    try {
      recorder.consumer.close();
    } catch {
      /* ignore */
    }
    try {
      recorder.transport.close();
    } catch {
      /* ignore */
    }
    this.deps.ports.release(recorder.port);
  }
}
