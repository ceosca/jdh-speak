import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RtpParameters } from "mediasoup/types";
import {
  PortAllocator,
  buildSdp,
  sdpParamsFromRtp,
  buildCaptureArgs,
  buildMixArgs,
  buildMixPlan,
  MIX_TREE_MIN_INPUTS,
  captureHasAudio,
  MIN_CAPTURE_BYTES,
  decideMode,
  computeDelayMs,
  trackFileName,
} from "./recording-util.js";

describe("PortAllocator", () => {
  it("hands out distinct ports within the range", () => {
    const a = new PortAllocator(50000, 50004, 2);
    const p1 = a.allocate();
    const p2 = a.allocate();
    const p3 = a.allocate();
    assert.equal(new Set([p1, p2, p3]).size, 3);
    for (const p of [p1, p2, p3]) {
      assert.ok(p >= 50000 && p <= 50004);
    }
    assert.equal(a.size, 3);
  });

  it("spaces ports by the step so RTP/RTCP pairs never collide", () => {
    // ffmpeg opens RTCP at port+1, so consecutive recorders must be >=2 apart.
    const a = new PortAllocator(50000, 50998, 2);
    const ports = [a.allocate(), a.allocate(), a.allocate()].sort((x, y) => x - y);
    assert.deepEqual(ports, [50000, 50002, 50004]);
    for (const p of ports) assert.equal(p % 2, 0);
  });

  it("reuses a released port and never double-allocates", () => {
    const a = new PortAllocator(50000, 50002, 2);
    const p1 = a.allocate();
    const p2 = a.allocate();
    a.release(p1);
    const p3 = a.allocate();
    assert.equal(p3, p1);
    assert.notEqual(p3, p2);
    assert.equal(a.size, 2);
  });

  it("throws when exhausted", () => {
    const a = new PortAllocator(50000, 50000, 2);
    a.allocate();
    assert.throws(() => a.allocate(), /no free ports/);
  });

  it("rejects an invalid range", () => {
    assert.throws(() => new PortAllocator(50001, 50000));
  });
});

describe("buildSdp", () => {
  it("produces a valid recvonly SDP with fmtp and ssrc", () => {
    const sdp = buildSdp({
      port: 50000,
      payloadType: 100,
      codec: "opus",
      clockRate: 48000,
      channels: 2,
      ssrc: 12345,
      fmtp: { minptime: 10, useinbandfec: 1 },
    });
    assert.ok(sdp.includes("m=audio 50000 RTP/AVP 100"));
    assert.ok(sdp.includes("a=rtpmap:100 opus/48000/2"));
    assert.ok(sdp.includes("a=fmtp:100 minptime=10;useinbandfec=1"));
    assert.ok(sdp.includes("a=ssrc:12345 cname:jdh-speak"));
    assert.ok(sdp.includes("a=recvonly"));
    assert.ok(sdp.includes("c=IN IP4 127.0.0.1"));
    assert.ok(sdp.endsWith("\n"));
  });

  it("omits fmtp/ssrc lines when not provided", () => {
    const sdp = buildSdp({
      port: 50001,
      payloadType: 111,
      codec: "opus",
      clockRate: 48000,
      channels: 1,
    });
    assert.ok(!sdp.includes("a=fmtp"));
    assert.ok(!sdp.includes("a=ssrc"));
    assert.ok(sdp.includes("a=rtpmap:111 opus/48000/1"));
  });
});

describe("sdpParamsFromRtp", () => {
  it("derives codec/payload/ssrc from rtpParameters", () => {
    const rtp = {
      codecs: [
        {
          mimeType: "audio/opus",
          payloadType: 100,
          clockRate: 48000,
          channels: 2,
          parameters: { minptime: 10 },
          rtcpFeedback: [],
        },
      ],
      encodings: [{ ssrc: 999 }],
      headerExtensions: [],
      rtcp: {},
    } as unknown as RtpParameters;
    const p = sdpParamsFromRtp(rtp, 50005);
    assert.equal(p.port, 50005);
    assert.equal(p.payloadType, 100);
    assert.equal(p.codec, "opus");
    assert.equal(p.clockRate, 48000);
    assert.equal(p.channels, 2);
    assert.equal(p.ssrc, 999);
    assert.deepEqual(p.fmtp, { minptime: 10 });
  });

  it("throws when there is no codec", () => {
    const rtp = { codecs: [], encodings: [] } as unknown as RtpParameters;
    assert.throws(() => sdpParamsFromRtp(rtp, 50000));
  });
});

describe("buildCaptureArgs", () => {
  it("captures RTP from an SDP file to a copied Ogg with frequent flushing", () => {
    const args = buildCaptureArgs("/tmp/in.sdp", "/tmp/out.ogg");
    assert.ok(args.includes("-protocol_whitelist"));
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,udp,rtp");
    assert.deepEqual(args.slice(args.indexOf("-i")), [
      "-i",
      "/tmp/in.sdp",
      "-c:a",
      "copy",
      "-flush_packets",
      "1",
      "-page_duration",
      "100000",
      "-y",
      "/tmp/out.ogg",
    ]);
  });
});

describe("buildMixArgs", () => {
  it("copies a single zero-offset input straight to stdout", () => {
    const args = buildMixArgs([{ path: "/tmp/a.ogg", delayMs: 0 }]);
    assert.deepEqual(args, [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-i",
      "/tmp/a.ogg",
      "-c:a",
      "copy",
      "-f",
      "ogg",
      "pipe:1",
    ]);
  });

  it("mixes multiple inputs with per-input delay and no volume normalization", () => {
    const args = buildMixArgs([
      { path: "/tmp/a.ogg", delayMs: 0 },
      { path: "/tmp/b.ogg", delayMs: 1500 },
    ]);
    const fc = args[args.indexOf("-filter_complex") + 1];
    assert.ok(fc.includes("[0:a]aformat=channel_layouts=stereo,aresample=async=1[a0]"));
    assert.ok(
      fc.includes("[1:a]aformat=channel_layouts=stereo,aresample=async=1,adelay=1500:all=1[a1]"),
    );
    assert.ok(fc.includes("amix=inputs=2:normalize=0[out]"));
    assert.deepEqual(args.slice(-2), ["ogg", "pipe:1"]);
    assert.ok(args.includes("libopus"));
  });

  it("re-encodes a single delayed input (cannot copy with a filter)", () => {
    const args = buildMixArgs([{ path: "/tmp/a.ogg", delayMs: 800 }]);
    assert.ok(args.includes("-filter_complex"));
    assert.ok(args.includes("libopus"));
  });

  it("throws when there are no inputs", () => {
    assert.throws(() => buildMixArgs([]));
  });
});

describe("decideMode", () => {
  it("requires SFU for 6+ peers", () => {
    assert.deepEqual(decideMode(6, "p2p", false), { mode: "sfu", action: "switch-to-sfu" });
    assert.deepEqual(decideMode(7, "sfu", false), { mode: "sfu", action: "none" });
  });

  it("uses P2P for <=5 peers when not recording", () => {
    assert.deepEqual(decideMode(3, "p2p", false), { mode: "p2p", action: "none" });
    assert.deepEqual(decideMode(1, "p2p", false), { mode: "p2p", action: "none" });
    // From P2P, 5 is still within the mesh range — no switch.
    assert.deepEqual(decideMode(5, "p2p", false), { mode: "p2p", action: "none" });
  });

  it("hysteresis: once on SFU it stays until the room drops to <=4 (no 5<->6 thrash)", () => {
    // The bug this fixes: a flaky peer flapping the count 5<->6 used to thrash the whole
    // room P2P<->SFU on every join/leave. Now the boundary is sticky.
    assert.deepEqual(decideMode(6, "p2p", false), { mode: "sfu", action: "switch-to-sfu" });
    // Drops to 5 while on SFU -> STAY on SFU (was the thrash back to P2P).
    assert.deepEqual(decideMode(5, "sfu", false), { mode: "sfu", action: "none" });
    // Back up to 6 -> still SFU, no action.
    assert.deepEqual(decideMode(6, "sfu", false), { mode: "sfu", action: "none" });
    // Only when it truly empties to 4 or fewer does it return to P2P.
    assert.deepEqual(decideMode(4, "sfu", false), { mode: "p2p", action: "switch-to-p2p" });
  });

  it("forces SFU when forceSfu is set even within the P2P range (<=5 peers)", () => {
    // forceSfu is true while recording OR while a music caster is present.
    assert.deepEqual(decideMode(2, "p2p", true), { mode: "sfu", action: "switch-to-sfu" });
    assert.deepEqual(decideMode(5, "p2p", true), { mode: "sfu", action: "switch-to-sfu" });
    assert.deepEqual(decideMode(1, "sfu", true), { mode: "sfu", action: "none" });
  });

  it("never downgrades to P2P while forceSfu holds", () => {
    const d = decideMode(2, "sfu", true);
    assert.equal(d.action, "none");
    assert.equal(d.mode, "sfu");
  });

  it("a 2-peer room with a caster (user + Ecobox) stays SFU", () => {
    // user + caster = 2 peers; forceSfu (caster present) keeps it on the SFU.
    assert.deepEqual(decideMode(2, "p2p", true), { mode: "sfu", action: "switch-to-sfu" });
    // caster leaves -> 1 peer, not forced -> back to P2P.
    assert.deepEqual(decideMode(1, "sfu", false), { mode: "p2p", action: "switch-to-p2p" });
  });
});

describe("computeDelayMs", () => {
  it("returns the offset of a recorder from the recording start", () => {
    assert.equal(computeDelayMs(1000, 1000), 0);
    assert.equal(computeDelayMs(1000, 4500), 3500);
  });

  it("clamps negative offsets to zero", () => {
    assert.equal(computeDelayMs(5000, 4000), 0);
  });
});

describe("captureHasAudio", () => {
  it("rejects a missing/empty file", () => {
    assert.equal(captureHasAudio(0), false);
  });

  it("rejects a header-only capture (OpusHead+OpusTags, no audio pages)", () => {
    // real header-only Ogg/Opus files measure ~150-250 bytes
    assert.equal(captureHasAudio(168), false);
    assert.equal(captureHasAudio(250), false);
    assert.equal(captureHasAudio(MIN_CAPTURE_BYTES - 1), false);
  });

  it("accepts a capture that carries real audio", () => {
    assert.equal(captureHasAudio(MIN_CAPTURE_BYTES), true);
    assert.equal(captureHasAudio(50000), true);
  });
});

describe("trackFileName", () => {
  it("uses a 1-based index prefix and the display name", () => {
    assert.equal(trackFileName({ peerId: "x", label: "Alice" }, 0), "01-Alice.ogg");
    assert.equal(trackFileName({ peerId: "x", label: "Bob" }, 1), "02-Bob.ogg");
  });

  it("appends the source only when it isn't plain voice", () => {
    assert.equal(trackFileName({ peerId: "x", label: "Al", source: "voice" }, 0), "01-Al.ogg");
    assert.equal(
      trackFileName({ peerId: "x", label: "Al", source: "share" }, 0),
      "01-Al-share.ogg",
    );
    assert.equal(
      trackFileName({ peerId: "x", label: "Eco", source: "music" }, 2),
      "03-Eco-music.ogg",
    );
  });

  it("falls back to the peer id when there is no label", () => {
    assert.equal(trackFileName({ peerId: "sock-42" }, 0), "01-sock-42.ogg");
    assert.equal(trackFileName({ peerId: "sock-42", label: "   " }, 0), "01-sock-42.ogg");
  });

  it("sanitizes names and stays unique via the index prefix", () => {
    // same display name, different index -> still distinct files
    assert.equal(trackFileName({ peerId: "a", label: "DJ / Río!" }, 0), "01-DJ_R_o.ogg");
    assert.equal(trackFileName({ peerId: "b", label: "DJ / Río!" }, 1), "02-DJ_R_o.ogg");
  });

  it("never yields an empty base name", () => {
    assert.equal(trackFileName({ peerId: "???", label: "***" }, 0), "01-track.ogg");
  });
});

describe("buildMixPlan", () => {
  const mk = (n: number, delay = (i: number) => i * 1000) =>
    Array.from({ length: n }, (_, i) => ({ path: `/r/t${i}.ogg`, delayMs: delay(i) }));

  it("keeps a single process below the tree threshold", () => {
    const inputs = mk(MIX_TREE_MIN_INPUTS - 1);
    const plan = buildMixPlan(inputs);
    assert.equal(plan.groups.length, 0);
    assert.deepEqual(plan.final, buildMixArgs(inputs));
  });

  it("splits many inputs into groups that each read every input exactly once", () => {
    const inputs = mk(13);
    const plan = buildMixPlan(inputs);
    assert.equal(plan.groups.length, 3);
    const read = plan.groups.flatMap((g) => g.filter((_, i) => g[i - 1] === "-i"));
    assert.equal(read.length, 13);
    assert.deepEqual([...read].sort(), inputs.map((i) => i.path).sort());
    for (const g of plan.groups) assert.deepEqual(g.slice(-2), ["f32le", "pipe:1"]);
  });

  it("keeps each input's own delay inside its group", () => {
    const plan = buildMixPlan(mk(5, (i) => (i === 4 ? 2500 : 0)));
    const filters = plan.groups.map((g) => g[g.indexOf("-filter_complex") + 1]).join(" ");
    assert.equal((filters.match(/adelay=2500:all=1/g) ?? []).length, 1);
  });

  it("final stage reads one raw PCM pipe per group and encodes Opus", () => {
    const plan = buildMixPlan(mk(6));
    const f = plan.final;
    const pipes = f.filter((_, i) => f[i - 1] === "-i");
    assert.deepEqual(pipes, ["pipe:3", "pipe:4", "pipe:5"]);
    assert.ok(f.join(" ").includes("amix=inputs=3:normalize=0"));
    assert.deepEqual(f.slice(-2), ["ogg", "pipe:1"]);
  });

  it("writes to a file with -y when given an output path", () => {
    const plan = buildMixPlan(mk(6), "/r/mix.ogg.part");
    assert.deepEqual(plan.final.slice(-3), ["ogg", "-y", "/r/mix.ogg.part"]);
    assert.deepEqual(
      buildMixArgs(
        mk(1, () => 0),
        "/r/x.ogg",
      ).slice(-2),
      ["-y", "/r/x.ogg"],
    );
  });

  it("balances groups by weight (file size)", () => {
    const inputs = mk(6);
    const weights = [100, 1, 1, 1, 1, 96];
    const plan = buildMixPlan(inputs, "pipe:1", weights);
    // the two big files must not share a group
    const groupOf = (p: string) => plan.groups.findIndex((g) => g.includes(p));
    assert.notEqual(groupOf("/r/t0.ogg"), groupOf("/r/t5.ogg"));
  });
});
