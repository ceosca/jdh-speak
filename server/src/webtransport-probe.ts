// THROWAWAY probe (branch feat/webtransport-jam only) — WebTransport echo relay
// embedded in the MAIN server so `pnpm start` runs it, no separate process and no
// new ports (reuses udp/40059, already inside the forwarded 40000-40100 range —
// mediasoup's rtcMaxPort was lowered to 40058 to free it).
//
// It reproduces the network-monitor over a completely different transport: your
// own audio, sent as WebCodecs Opus over WebTransport (QUIC) datagrams, echoed
// straight back by this relay, so the browser can time the round-trip against the
// current WebRTC/mediasoup path. It does NOT relay between peers, record, stream,
// or touch any real-app state — just bounces datagrams.
//
// FAIL-SAFE BY DESIGN: everything is wrapped so that a missing dependency, an
// unreadable cert, or a bind error only logs a warning and leaves the probe
// disabled. It must never crash or degrade the conferencing server. To turn it
// off entirely, set WT_PROBE=0.

import { readFileSync } from "node:fs";

const CADDY_DIR =
  "/var/lib/caddy/.local/share/caddy/certificates/" +
  "acme-v02.api.letsencrypt.org-directory/jdh.privatedns.org";

let info: { enabled: boolean; url: string | null } = { enabled: false, url: null };

export function getWebTransportProbeInfo() {
  return info;
}

export async function startWebTransportProbe(): Promise<void> {
  if (process.env.WT_PROBE === "0") {
    console.log("[wt-probe] disabled (WT_PROBE=0)");
    return;
  }
  const port = Number(process.env.WT_PROBE_PORT || 40059);
  const host = process.env.WT_PROBE_HOST || "0.0.0.0";
  const publicHost = process.env.WT_PROBE_PUBLIC_HOST || "jdh.privatedns.org";
  const certPath = process.env.CERT_PATH || `${CADDY_DIR}/jdh.privatedns.org.crt`;
  const keyPath = process.env.KEY_PATH || `${CADDY_DIR}/jdh.privatedns.org.key`;

  try {
    const cert = readFileSync(certPath, "utf8");
    const privKey = readFileSync(keyPath, "utf8");

    // Dynamic import so an absent/incompatible native module can't break server
    // startup — the whole conferencing app must boot with or without this probe.
    // Indirected specifier so `tsc` doesn't try to resolve the (native, not
    // installed on dev machines) package at build time.
    const spec = "@fails-components/webtransport";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ spec);
    const Http3Server = mod.Http3Server;

    const server = new Http3Server({
      port,
      host,
      secret: "webtransport-jam-probe-throwaway",
      cert,
      privKey,
    });
    server.startServer();
    await server.ready;

    info = { enabled: true, url: `https://${publicHost}:${port}/echo` };
    console.log(`[wt-probe] HTTP/3 echo relay on udp/${port} (path /echo) — ${info.url}`);

    void acceptLoop(server);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wt-probe] not started (probe stays off, server unaffected): ${msg}`);
    info = { enabled: false, url: null };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function acceptLoop(server: any): Promise<void> {
  try {
    const reader = server.sessionStream("/echo").getReader();
    for (;;) {
      const { done, value: session } = await reader.read();
      if (done) break;
      void handleSession(session);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wt-probe] accept loop ended: ${msg}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleSession(session: any): Promise<void> {
  try {
    await session.ready;
    const writer = session.datagrams.writable.getWriter();
    const dgReader = session.datagrams.readable.getReader();
    for (;;) {
      const { done, value } = await dgReader.read();
      if (done) break;
      // Bounce the exact bytes back = your own return. Unreliable datagrams: a
      // dropped/reordered one is exactly what we're measuring, so no retry/order.
      writer.write(value).catch(() => {});
    }
  } catch {
    /* session error — ignore, it's a throwaway echo */
  }
}
