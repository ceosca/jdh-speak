// THROWAWAY probe relay — echoes every WebTransport datagram back to the sender.
//
// This is the server half of the Level-1 feasibility probe: it does for
// WebTransport exactly what the current SFU self-consume does for the
// network-monitor, i.e. return your own signal via the server so we can time
// the round-trip. It does NOT relay between peers, record, or touch anything in
// the real app. Isolated on its own UDP port with its own dependency tree.
//
// Transport: HTTP/3 (QUIC) via @fails-components/webtransport. Uses the real
// Caddy/Let's Encrypt cert for jdh.privatedns.org so the browser trusts the
// connection with no serverCertificateHashes dance (and no 14-day self-signed
// limit). The cert is copied next to this file by run-on-pi.sh (readable by the
// pi user) — see the README.
//
// Datagram wire format (little-endian), echoed verbatim:
//   byte 0        : type (0 = ping / network-only, 1 = audio frame)
//   bytes 1..4    : uint32 seq
//   bytes 5..12   : float64 client send-time (performance.now, ms)
//   bytes 13..    : opus payload (type 1 only)
// The relay never parses the body — it just bounces the exact bytes back, so all
// timing math lives in the browser against its own clock (no clock-sync needed).

import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { extname, join, normalize } from "node:path";
import { Http3Server } from "@fails-components/webtransport";

const PORT = Number(process.env.WT_PORT || 4433);
const PAGE_PORT = Number(process.env.PAGE_PORT || 8444);
const HOST = process.env.WT_HOST || "0.0.0.0";
const CERT_PATH = process.env.CERT_PATH || "./jdh.privatedns.org.crt";
const KEY_PATH = process.env.KEY_PATH || "./jdh.privatedns.org.key";

const cert = readFileSync(CERT_PATH, "utf8");
const privKey = readFileSync(KEY_PATH, "utf8");

// Serve the probe page itself over HTTPS with the SAME real cert, so it's a
// trusted secure context (WebTransport + WebCodecs both require one) without
// touching the live app or rebuilding its client. Static, read-only, public/.
const MIME = { ".html": "text/html", ".js": "text/javascript" };
const PUBLIC = join(process.cwd(), "public");
createServer({ cert, key: privKey }, (req, res) => {
  let rel = normalize(decodeURIComponent((req.url || "/").split("?")[0]));
  if (rel === "/" || rel === "\\") rel = "/probe.html";
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end("no");
    return;
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PAGE_PORT, HOST, () =>
  console.log(`[relay] probe page at https://jdh.privatedns.org:${PAGE_PORT}/probe.html`),
);

const server = new Http3Server({
  port: PORT,
  host: HOST,
  secret: "webtransport-jam-probe-throwaway",
  cert,
  privKey,
});

server.startServer();
await server.ready;
console.log(`[relay] HTTP/3 listening on udp/${PORT} (path /echo) — echo probe up`);

// Accept sessions on /echo and echo their datagrams.
async function acceptLoop() {
  const reader = server.sessionStream("/echo").getReader();
  for (;;) {
    const { done, value: session } = await reader.read();
    if (done) break;
    void handleSession(session);
  }
}

async function handleSession(session) {
  try {
    await session.ready;
    console.log("[relay] session ready — echoing datagrams");
    const writer = session.datagrams.writable.getWriter();
    const dgReader = session.datagrams.readable.getReader();
    session.closed
      .then(() => console.log("[relay] session closed"))
      .catch(() => console.log("[relay] session closed (err)"));
    for (;;) {
      const { done, value } = await dgReader.read();
      if (done) break;
      // Bounce the exact bytes straight back. Unreliable datagrams: a dropped or
      // reordered one is exactly what we want to measure, so no retry/order here.
      writer.write(value).catch(() => {});
    }
  } catch (err) {
    console.error("[relay] session error:", err?.message || err);
  }
}

acceptLoop().catch((err) => {
  console.error("[relay] accept loop died:", err);
  process.exit(1);
});
