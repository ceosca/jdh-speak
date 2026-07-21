import express from "express";
import { createServer } from "node:http";
import { createReadStream, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createWorker } from "mediasoup";
import type { Worker } from "mediasoup/types";
import { workerSettings, numWorkers } from "./mediasoup-config.js";
import { setWorkers } from "./room-manager.js";
import { createSignalingServer } from "./signaling.js";
import { RecordingManager } from "./recording.js";
import { createZipStream } from "./zip-stream.js";
import {
  assertPublicAudioUrl,
  browserPlayableAudioType,
  fetchPublicAudio,
  looksLikeStreamContentType,
  streamFallbackAudio,
  TranscodeBusyError,
} from "./audio-sources.js";
import { parseTvChannels, type Channel } from "./tv-channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load local config from the repo-root .env before anything reads process.env.
// tsx/Node don't auto-load it, and it's gitignored; an absent file is fine.
// Resolved from this file, not cwd, since `pnpm --filter server start` runs
// with the server package as cwd.
try {
  process.loadEnvFile(path.resolve(__dirname, "../../.env"));
} catch {
  /* no .env present — fine */
}

const PORT = parseInt(process.env.PORT || "3100", 10);

// Display name of this instance, shown as the app title (lobby heading + browser
// tab). Operators rebrand a deployment by setting INSTANCE_NAME in .env; it's
// injected into the served index.html at runtime (see below), so a pre-built
// client is rebranded without a rebuild. Defaults to "JDH Speak".
const INSTANCE_NAME = process.env.INSTANCE_NAME?.trim() || "JDH Speak";

// ICE servers, injected into the served index.html like INSTANCE_NAME so the
// TURN can be changed by editing .env + restarting — no client rebuild, and no
// credentials in the repo (see docs/turn-server.md).
//   TURN_URLS       comma-separated, e.g. "turn:host:3478?transport=udp,turn:host:3478?transport=tcp"
//   TURN_USERNAME / TURN_CREDENTIAL   long-term credentials for those URLs
//   STUN_URLS       optional override; defaults to Google's public STUN
// A TURN entry is only emitted when all three TURN_* vars are set; otherwise we
// ship STUN only. We never hardcode a third-party TURN again.
const DEFAULT_STUN = "stun:stun.l.google.com:19302";

function buildIceServers(): { urls: string | string[]; username?: string; credential?: string }[] {
  const split = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const stunUrls = split(process.env.STUN_URLS);
  const servers: { urls: string | string[]; username?: string; credential?: string }[] = [
    { urls: stunUrls.length ? stunUrls : [DEFAULT_STUN] },
  ];

  const turnUrls = split(process.env.TURN_URLS);
  const username = process.env.TURN_USERNAME?.trim();
  const credential = process.env.TURN_CREDENTIAL?.trim();
  if (turnUrls.length && username && credential) {
    servers.push({ urls: turnUrls, username, credential });
  } else if (turnUrls.length) {
    console.warn("[ice] TURN_URLS set but TURN_USERNAME/TURN_CREDENTIAL missing — ignoring TURN");
  }
  return servers;
}

const ICE_SERVERS = buildIceServers();

// TV channels live in tv/db.json at the repo root (next to sounds/). It's an
// operator-managed deployment file (gitignored, may hold DRM keys). Re-read only
// when the file's mtime changes so edits show up without a restart.
const TV_DB_PATH = path.resolve(__dirname, "../../tv/db.json");
let tvCache: { mtimeMs: number; channels: Channel[] } | null = null;
async function loadTvChannels(): Promise<Channel[]> {
  try {
    const s = await stat(TV_DB_PATH);
    if (tvCache && tvCache.mtimeMs === s.mtimeMs) return tvCache.channels;
    const channels = parseTvChannels(await readFile(TV_DB_PATH, "utf8"));
    tvCache = { mtimeMs: s.mtimeMs, channels };
    return channels;
  } catch {
    return []; // absent/unreadable — TV is optional
  }
}

async function main() {
  // Create mediasoup workers
  const workers: Worker[] = [];
  for (let i = 0; i < numWorkers; i++) {
    const worker = await createWorker(workerSettings);
    worker.on("died", () => {
      console.error(`Worker ${worker.pid} died, exiting...`);
      process.exit(1);
    });
    workers.push(worker);
  }
  setWorkers(workers);
  console.log(`Created ${workers.length} mediasoup worker(s)`);

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  const httpServer = createServer(app);

  const recordingManager = new RecordingManager();
  const { postChatMessage } = createSignalingServer(httpServer, recordingManager);
  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", workers: workers.length });
  });

  // Post a chat message into a live room from outside the browser (e.g. Ecobox
  // announcing the now-playing track). Body: { text, sender? }. Rate-limited
  // and validated identically to an in-room peer; 404 if the room isn't live.
  app.post("/api/rooms/:roomName/messages", (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown; sender?: unknown };
    if (typeof body.text !== "string") {
      res.status(400).json({ error: "Body must include a string `text`" });
      return;
    }
    const sender = typeof body.sender === "string" ? body.sender : "System";
    const result = postChatMessage(req.params.roomName, sender, body.text);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({ ok: true, message: result.message });
  });

  app.get("/api/audio-proxy", async (req, res) => {
    const raw = typeof req.query.url === "string" ? req.query.url : "";
    if (!raw) {
      res.status(400).json({ error: "Missing audio URL" });
      return;
    }

    // Validate up front: blocks private/SSRF targets for both the direct proxy
    // and the yt-dlp fallback, and gives a clean 400 for an unusable URL.
    try {
      await assertPublicAudioUrl(raw);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Audio URL failed" });
      return;
    }

    // Whether the failed direct fetch looked like a media stream (IPTV/HLS/DASH/
    // octet-stream) rather than a web page — routes the fallback to ffmpeg first.
    let preferFfmpeg = false;

    // 1) Direct path: a plain audio file or Icecast/HTTP radio stream. Kept for
    //    these because it preserves Range requests (seeking) with no transcode.
    try {
      const upstream = await fetchPublicAudio(raw, req.headers.range);
      const status = upstream.statusCode ?? 502;
      const contentType = upstream.headers["content-type"] || "";
      const playType = browserPlayableAudioType(raw, contentType);
      if (status >= 200 && status < 300 && playType) {
        res.status(status);
        res.setHeader("Content-Type", playType);
        for (const header of [
          "accept-ranges",
          "content-length",
          "content-range",
          "icy-br",
          "icy-name",
        ]) {
          const value = upstream.headers[header];
          if (value) res.setHeader(header, value);
        }
        res.on("close", () => upstream.destroy());
        upstream.on("error", (err) => {
          console.error(`[audio-proxy] stream failed: ${String(err)}`);
          res.destroy(err);
        });
        upstream.pipe(res);
        return;
      }
      // Not directly playable (an HTML page, a player redirect, a hotlink block,
      // an IPTV `.ts`/octet-stream, …) — fall through to the transcoder. Note
      // whether it smelled like a media stream so the fallback prefers ffmpeg.
      preferFfmpeg = looksLikeStreamContentType(contentType);
      upstream.destroy();
    } catch (err) {
      console.error(`[audio-proxy] direct fetch failed, trying transcode fallback: ${String(err)}`);
    }

    // 2) Fallback: transcode to a progressive Opus/WebM stream the <audio>
    //    element can play. Direct media streams (IPTV `.ts`, HLS, DASH) go
    //    through ffmpeg; sites (YouTube, SoundCloud, …) through yt-dlp. No Range
    //    support here — it's a live transcode.
    try {
      const extracted = await streamFallbackAudio(raw, { preferFfmpeg });
      res.status(200);
      res.setHeader("Content-Type", extracted.contentType);
      res.setHeader("Cache-Control", "no-store");
      res.on("close", () => extracted.destroy());
      extracted.stream.on("error", (err) => {
        console.error(`[audio-proxy] transcode stream failed: ${String(err)}`);
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      });
      extracted.stream.pipe(res);
    } catch (err) {
      console.error(`[audio-proxy] transcode fallback failed: ${String(err)}`);
      if (!res.headersSent) {
        // Slot exhaustion is transient (503 + Retry-After); anything else is an
        // upstream/extraction failure for this URL (502).
        if (err instanceof TranscodeBusyError) {
          res.setHeader("Retry-After", "5");
          res.status(503).json({ error: "Server busy transcoding audio, try again shortly" });
        } else {
          res.status(502).json({ error: "Could not get audio from that URL" });
        }
      } else {
        res.destroy();
      }
    }
  });

  // Operator-managed live-TV channel list (see docs/superpowers/specs/...tv...).
  app.get("/api/tv-channels", async (_req, res) => {
    res.json(await loadTvChannels());
  });

  // Recording download — mixes all participants' captured audio into a single
  // Ogg/Opus file and streams it. Works at any time while recording continues;
  // the capture processes are never interrupted. Keyed by the recording id
  // (a capability token handed to clients), not the room name.
  app.get("/api/recordings/:id/download", (req, res) => {
    const proc = recordingManager.mixByRecordingId(req.params.id);
    if (!proc || !proc.stdout) {
      res.status(404).json({ error: "No active recording with that id, or nothing captured yet" });
      return;
    }
    res.setHeader("Content-Type", "audio/ogg");
    res.setHeader("Content-Disposition", `attachment; filename="jdh-speak-${req.params.id}.ogg"`);

    proc.stderr?.on("data", (d: Buffer) => console.error(`[mix] ${d.toString().trim()}`));
    proc.stdout.pipe(res);

    // If the client aborts the download, kill the mixing ffmpeg.
    const kill = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    res.on("close", kill);
    proc.on("exit", (code) => {
      if (code) console.error(`[mix] ffmpeg exited with code ${code}`);
    });
  });

  // Per-track download — packs each participant's captured audio into its own
  // file inside one streamed .zip (no mixing). Includes tracks whose peer
  // already left, since their captures are kept on disk. Like the mix above,
  // works while still recording and never interrupts the live captures.
  app.get("/api/recordings/:id/tracks", (req, res) => {
    const tracks = recordingManager.tracksByRecordingId(req.params.id);
    if (!tracks || tracks.length === 0) {
      res.status(404).json({ error: "No recording with that id, or nothing captured yet" });
      return;
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="jdh-speak-${req.params.id}-tracks.zip"`,
    );

    const zip = createZipStream(
      tracks.map((t) => ({ name: t.name, open: () => createReadStream(t.path) })),
    );
    zip.on("error", (err) => {
      console.error(`[tracks] zip error: ${String(err)}`);
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    });
    // If the client aborts the download, stop reading the files.
    res.on("close", () => zip.destroy());
    zip.pipe(res);
  });

  // Serve built client in production. Hashed assets (JS/CSS) are served
  // statically, but NOT index.html (`index: false`) — every page / SPA-route
  // request falls through to the handler below, which injects this instance's
  // runtime config into the HTML.
  const clientDist = path.resolve(__dirname, "../../client/dist");
  const indexHtmlPath = path.join(clientDist, "index.html");
  app.use(express.static(clientDist, { index: false }));

  // Optional operator-provided event sounds, served from repo-root `sounds/`
  // (gitignored, populated by the operator). Drop e.g. sounds/join.mp3 and every
  // client plays it on join instead of the built-in synth cue — no rebuild
  // needed, mirroring the INSTANCE_NAME rebrand model. Absent dir/file → the
  // static handler 404s and the client falls back to the synth (see
  // client/src/lib/sounds.ts). Recognised names: <cue>.{mp3,wav,ogg} where cue
  // is join, leave, message, mute, unmute, thunk, share-start, share-stop,
  // peer-mute, peer-unmute.
  // fallthrough:false so a missing file returns a real 404 here instead of
  // falling through to the SPA catch-all (which would answer 200 + index.html,
  // making the client fetch and try to decode HTML as audio on every probe).
  const soundsDir = path.resolve(__dirname, "../../sounds");
  app.use("/sounds", express.static(soundsDir, { fallthrough: false }));

  // Inject the operator-configurable instance name into the served index.html so
  // the pre-built static client can be rebranded via INSTANCE_NAME in .env with
  // no rebuild: an inline config script the client reads before it mounts (see
  // client/src/lib/branding.ts), plus the static <title>. Read fresh per request
  // (not cached) so a client-only `pnpm build` — which changes the asset hashes
  // referenced in index.html — is picked up on the next load without a restart.
  const renderIndexHtml = (): string | null => {
    let html: string;
    try {
      html = readFileSync(indexHtmlPath, "utf8");
    } catch {
      return null; // client not built yet
    }
    // JS object literal; escape "<" so a name containing "</script>" can't break
    // out of the inline <script>. Injected right after <head> so it runs before
    // the (deferred) app bundle.
    const configJson = JSON.stringify({
      instanceName: INSTANCE_NAME,
      iceServers: ICE_SERVERS,
    }).replace(/</g, "\\u003c");
    html = html.replace(
      "<head>",
      `<head><script>window.__JDH_SPEAK_CONFIG__=${configJson};</script>`,
    );
    const safeTitle = INSTANCE_NAME.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${safeTitle}</title>`);
    return html;
  };

  app.get("/{*splat}", (_req, res) => {
    const html = renderIndexHtml();
    if (html == null) {
      res.status(404).type("text/plain").send("Client not built. Run `pnpm build`.");
      return;
    }
    res.type("html").send(html);
  });

  httpServer.listen(PORT, () => {
    console.log(`JDH Speak server listening on port ${PORT}`);
  });

  // Clean up recordings and live streams (ffmpeg processes, temp files) on
  // shutdown.
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, cleaning up recordings...`);
    Promise.allSettled([recordingManager.stopAll()]).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
