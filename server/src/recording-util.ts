import type { RtpParameters } from "mediasoup/types";

export type RoomMode = "p2p" | "sfu";

// --- Port allocator -------------------------------------------------------
// mediasoup sends each consumed stream's RTP to a local UDP port where an
// ffmpeg process is listening. ffmpeg's RTP receiver ALSO opens an RTCP socket
// at port+1, so each capture actually occupies a *pair* of ports (P and P+1).
// We therefore hand out ports spaced `step` (default 2) apart, so consecutive
// recorders never collide on each other's RTCP port.
export class PortAllocator {
  private readonly start: number;
  private readonly end: number;
  private readonly step: number;
  private readonly inUse = new Set<number>();
  private cursorIdx = 0;

  constructor(start = 50000, end = 50998, step = 2) {
    if (end < start) throw new Error("PortAllocator: end must be >= start");
    if (step < 1) throw new Error("PortAllocator: step must be >= 1");
    this.start = start;
    this.end = end;
    this.step = step;
  }

  private get slots(): number {
    return Math.floor((this.end - this.start) / this.step) + 1;
  }

  allocate(): number {
    const n = this.slots;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursorIdx + i) % n;
      const port = this.start + idx * this.step;
      if (!this.inUse.has(port)) {
        this.inUse.add(port);
        this.cursorIdx = (idx + 1) % n;
        return port;
      }
    }
    throw new Error("PortAllocator: no free ports available");
  }

  release(port: number): void {
    this.inUse.delete(port);
  }

  get size(): number {
    return this.inUse.size;
  }
}

// --- SDP generation -------------------------------------------------------
// ffmpeg receives the RTP we push to it by reading an SDP file describing the
// single audio stream. Built from the mediasoup consumer's rtpParameters.
export interface SdpParams {
  port: number;
  payloadType: number;
  codec: string; // e.g. "opus"
  clockRate: number;
  channels: number;
  ssrc?: number;
  fmtp?: Record<string, string | number>;
  ip?: string; // default 127.0.0.1
}

export function buildSdp(p: SdpParams): string {
  const ip = p.ip ?? "127.0.0.1";
  const lines = [
    "v=0",
    `o=- 0 0 IN IP4 ${ip}`,
    "s=jdh-speak-recording",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=audio ${p.port} RTP/AVP ${p.payloadType}`,
    `a=rtpmap:${p.payloadType} ${p.codec}/${p.clockRate}/${p.channels}`,
  ];
  if (p.fmtp && Object.keys(p.fmtp).length > 0) {
    const fmtp = Object.entries(p.fmtp)
      .map(([k, v]) => `${k}=${v}`)
      .join(";");
    lines.push(`a=fmtp:${p.payloadType} ${fmtp}`);
  }
  if (p.ssrc !== undefined) {
    lines.push(`a=ssrc:${p.ssrc} cname:jdh-speak`);
  }
  lines.push("a=recvonly");
  return lines.join("\n") + "\n";
}

export function sdpParamsFromRtp(rtpParameters: RtpParameters, port: number): SdpParams {
  const codec = rtpParameters.codecs[0];
  if (!codec) throw new Error("sdpParamsFromRtp: no codec in rtpParameters");
  // "audio/opus" -> "opus"
  const subtype = codec.mimeType.split("/")[1]?.toLowerCase() ?? "opus";
  const ssrc = rtpParameters.encodings?.[0]?.ssrc;
  return {
    port,
    payloadType: codec.payloadType,
    codec: subtype,
    clockRate: codec.clockRate,
    channels: codec.channels ?? 2,
    ssrc,
    fmtp: codec.parameters as Record<string, string | number> | undefined,
  };
}

// --- ffmpeg argument builders --------------------------------------------
// Capture one RTP stream (described by an SDP file) into a streamable Ogg
// Opus file. `-c:a copy` keeps the original Opus payload (no re-encode), and
// `-flush_packets 1` keeps the file flushed so a mid-recording read picks up
// recent audio. `-page_duration 100000` (100 ms Ogg pages, default 1 s): the Ogg
// muxer holds up to a page in memory, so a capture that has to be cut hard (no RTP
// left to wake it — see RecordingManager.stopRecorder) lost its last ~1 s; measured
// on the Pi: 5.0 s of 6.0 s kept by default vs all of it with 100 ms pages.
export function buildCaptureArgs(sdpPath: string, outPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-protocol_whitelist",
    "file,udp,rtp",
    "-fflags",
    "+genpts",
    "-f",
    "sdp",
    "-i",
    sdpPath,
    "-c:a",
    "copy",
    "-flush_packets",
    "1",
    "-page_duration",
    "100000",
    "-y",
    outPath,
  ];
}

export interface MixInput {
  path: string;
  // ms by which this stream started after the recording began; used to keep
  // late-joiners aligned in the mix.
  delayMs: number;
}

// A capture that received (almost) no RTP is still a valid Ogg/Opus file on
// disk — just the OpusHead + OpusTags headers, ~150-250 bytes, with no audio
// pages. `-c:a copy` writes those headers the moment ffmpeg starts, before any
// media arrives. Such a file passes a naive `size > 0` check, so it used to be
// fed to the mixer and packed into the per-track zip — which is exactly how a
// recording where no audio ever reached the server produced a ~1 KB "download"
// (all inputs header-only → amix emits header-only) while the zip still
// "worked" (a valid zip of empty tracks). We therefore require a capture to
// carry real audio (well above any header-only file, yet far below even a
// fraction of a second of Opus voice) before it counts as a mix input or a
// downloadable track. When NONE qualify the endpoints return a clear "nothing
// captured yet" instead of a mystery tiny file.
export const MIN_CAPTURE_BYTES = 1024;
export function captureHasAudio(size: number): boolean {
  return size >= MIN_CAPTURE_BYTES;
}

// Per-input filter chain, in order:
//  - aformat upmixes mono voice to stereo BEFORE amix (amix adopts the first input's
//    layout, so a mono-first mix would fold the stereo music/share tracks down to mono);
//  - aresample async fills timestamp gaps with silence so a track that paused
//    mid-recording (mute, share stopped) stays time-aligned;
//  - adelay shifts a late-joining stream so voices line up in time.
function inputChain(delayMs: number): string {
  const d = Math.max(0, Math.round(delayMs));
  return `aformat=channel_layouts=stereo,aresample=async=1${d > 0 ? `,adelay=${d}:all=1` : ""}`;
}

// Mix N captured Ogg files into a single Ogg Opus stream written to `output` (stdout —
// "pipe:1" — so the HTTP download can stream it without a temp file, or a file path for
// the pre-rendered cache). The source capture files keep being written — mixing does
// not stop them. Single ffmpeg process.
export function buildMixArgs(inputs: MixInput[], output = "pipe:1"): string[] {
  if (inputs.length === 0) throw new Error("buildMixArgs: no inputs");

  const args: string[] = ["-hide_banner", "-loglevel", "warning"];
  for (const input of inputs) {
    args.push("-i", input.path);
  }

  if (inputs.length === 1 && inputs[0].delayMs <= 0) {
    // Single stream, no offset — stream it straight through, no re-encode.
    args.push("-c:a", "copy");
  } else {
    const parts: string[] = [];
    const labels: string[] = [];
    inputs.forEach((input, i) => {
      const label = `a${i}`;
      labels.push(`[${label}]`);
      parts.push(`[${i}:a]${inputChain(input.delayMs)}[${label}]`);
    });
    // normalize=0 keeps each voice at full level instead of dividing by N
    // (which would make everyone quieter as more people join).
    const filter = `${parts.join(";")};${labels.join("")}amix=inputs=${inputs.length}:normalize=0[out]`;
    args.push("-filter_complex", filter, "-map", "[out]", "-c:a", "libopus", "-b:a", "96k");
  }

  args.push("-f", "ogg");
  if (output !== "pipe:1") args.push("-y");
  args.push(output);
  return args;
}

// --- Parallel ("tree") mix -------------------------------------------------
// ffmpeg 5.1 (the Pi's) decodes every input and runs the whole filter graph on ONE core.
// Measured on the Pi 400 with 13 real stereo Opus captures: 4.7x realtime — a 77-min
// recording took ~16 min to mix, so the "single file" download crawled while the zip
// (plain file reads) flew. Splitting the inputs into a few GROUPS, each decoded and
// pre-mixed by its own ffmpeg (raw float PCM out), and a FINAL ffmpeg that sums the
// group outputs and encodes, spreads the work over the cores: 12.3x realtime with 3
// groups on the same data, byte-identical output. Below MIX_TREE_MIN_INPUTS the single
// process is already fast enough and simpler.
export const MIX_TREE_MIN_INPUTS = 4;
export const MIX_TREE_GROUPS = 3;

export interface MixPlan {
  // One ffmpeg per group: decodes its inputs, mixes them, writes f32le stereo 48 kHz to
  // stdout. Empty for a single-process mix.
  groups: string[][];
  // The final ffmpeg. With groups, it reads group g from file descriptor 3+g (pipe:3…)
  // and must be spawned with that many extra input pipes.
  final: string[];
}

// Greedy balance: biggest files first, each to the currently lightest group. `weights`
// (e.g. file sizes) default to 1 each.
function assignGroups(n: number, groups: number, weights?: number[]): number[][] {
  const out: number[][] = Array.from({ length: groups }, () => []);
  const load = new Array<number>(groups).fill(0);
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => (weights?.[b] ?? 1) - (weights?.[a] ?? 1) || a - b,
  );
  for (const i of order) {
    let g = 0;
    for (let k = 1; k < groups; k++) if (load[k] < load[g]) g = k;
    out[g].push(i);
    load[g] += weights?.[i] ?? 1;
  }
  // Keep chronological input order inside each group (deterministic args).
  return out.map((idx) => idx.sort((a, b) => a - b)).filter((idx) => idx.length > 0);
}

export function buildMixPlan(
  inputs: MixInput[],
  output = "pipe:1",
  weights?: number[],
  groupCount = MIX_TREE_GROUPS,
): MixPlan {
  if (inputs.length === 0) throw new Error("buildMixPlan: no inputs");
  if (inputs.length < MIX_TREE_MIN_INPUTS || groupCount < 2) {
    return { groups: [], final: buildMixArgs(inputs, output) };
  }
  const grouping = assignGroups(inputs.length, Math.min(groupCount, inputs.length), weights);
  const groups = grouping.map((idx) => {
    const args = ["-hide_banner", "-loglevel", "warning"];
    for (const i of idx) args.push("-i", inputs[i].path);
    const parts = idx.map((i, k) => `[${k}:a]${inputChain(inputs[i].delayMs)}[a${k}]`);
    const labels = idx.map((_, k) => `[a${k}]`).join("");
    const filter =
      `${parts.join(";")};${labels}amix=inputs=${idx.length}:normalize=0,` +
      `aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo[o]`;
    args.push("-filter_complex", filter, "-map", "[o]", "-f", "f32le", "pipe:1");
    return args;
  });
  const final = ["-hide_banner", "-loglevel", "warning"];
  // A deep per-input queue: with the default (8) the final stage stalls on its raw
  // PCM pipes ("Thread message queue blocking").
  groups.forEach((_, g) =>
    final.push(
      "-thread_queue_size",
      "1024",
      "-f",
      "f32le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      `pipe:${3 + g}`,
    ),
  );
  const labels = groups.map((_, g) => `[${g}:a]`).join("");
  final.push(
    "-filter_complex",
    `${labels}amix=inputs=${groups.length}:normalize=0[out]`,
    "-map",
    "[out]",
    "-c:a",
    "libopus",
    "-b:a",
    "96k",
    "-f",
    "ogg",
  );
  if (output !== "pipe:1") final.push("-y");
  final.push(output);
  return { groups, final };
}

// --- Mode decision --------------------------------------------------------
export interface ModeDecision {
  mode: RoomMode;
  action: "switch-to-sfu" | "switch-to-p2p" | "none";
}

// Pure decision for the mode a room should be in:
//   - 6+ peers always require the SFU (full-mesh P2P is used for up to 5 peers,
//     trading the SFU's single server hop for lower latency in small groups).
//   - `forceSfu` pins the SFU even with <=5 peers. Callers set this when the
//     server must see/route the media on the SFU: while recording (P2P media
//     never reaches the server) or when a send-only "music caster" peer is
//     present (it produces but never sets up P2P, so the room must be SFU).
//   - otherwise <=5 peers fall back to P2P.
export function decideMode(
  peerCount: number,
  currentMode: RoomMode,
  forceSfu: boolean,
): ModeDecision {
  // HYSTERESIS around the P2P↔SFU boundary. Without it, a peer flapping at the edge (a
  // flaky mobile that keeps reconnecting, or its stale socket lingering while the new one
  // is already in) toggles the count 5↔6 and THRASHES the whole room between modes — and
  // every switch tears down + rebuilds every transport, which is exactly when a weak
  // peer's leg gets lost and someone stops hearing them ("Edu no escucha a Franco"). So:
  // ENTER the SFU at 6+, but once on the SFU STAY there until the room drops to 4 or fewer.
  // Between 5 and 6 the mode is sticky — a single joiner/leaver at the edge changes nothing.
  // forceSfu (recording / caster / camera / ?p2p=off / manual) always pins the SFU.
  let target: RoomMode;
  if (forceSfu) target = "sfu";
  else if (currentMode === "sfu") target = peerCount >= 5 ? "sfu" : "p2p";
  else target = peerCount >= 6 ? "sfu" : "p2p";
  if (target === currentMode) return { mode: currentMode, action: "none" };
  return {
    mode: target,
    action: target === "sfu" ? "switch-to-sfu" : "switch-to-p2p",
  };
}

export function computeDelayMs(recordingStartedAt: number, recorderStartedAt: number): number {
  return Math.max(0, recorderStartedAt - recordingStartedAt);
}

// Friendly, unique file name for one captured track inside the per-track zip.
// Shape: `NN-<who>[-<source>].ogg`, e.g. `01-alice.ogg`, `02-alice-share.ogg`,
// `03-ecobox-music.ogg`. The `NN` prefix (1-based, from the caller's order)
// guarantees uniqueness even when two tracks share a display name, and keeps a
// stable, chronological ordering when the archive is unpacked. `who` falls back
// to the peer id when no display name is known; `source` is appended only when
// it isn't plain voice, so mic tracks stay clean.
export function trackFileName(
  meta: { peerId: string; label?: string; source?: string },
  index: number,
): string {
  const raw = meta.label?.trim() || meta.peerId;
  const who =
    raw
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "track";
  const src = meta.source && meta.source !== "voice" ? `-${meta.source}` : "";
  const n = String(index + 1).padStart(2, "0");
  return `${n}-${who}${src}.ogg`;
}
