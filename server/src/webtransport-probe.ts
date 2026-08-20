// THROWAWAY probe (branch feat/webtransport-jam only) — WebTransport echo relay
// embedded in the MAIN server so `pnpm start` runs it, no separate process and no
// new ports (reuses udp/40059, already inside the forwarded 40000-40100 range —
// mediasoup's rtcMaxPort was lowered to 40058 to free it).
//
// It reproduces the network-monitor over a completely different transport: your
// own audio, sent as WebCodecs Opus over WebTransport (QUIC) datagrams, echoed
// straight back, so the browser can time the round-trip against the current
// WebRTC/mediasoup path. It does NOT relay between peers, record, stream, or touch
// any real-app state — just bounces datagrams.
//
// CERT — two modes, decided at runtime:
//   * If CERT_PATH/KEY_PATH point at a readable cert (e.g. the service runs as
//     root and can read Caddy's live cert), use it: the browser trusts it and no
//     serverCertificateHashes is needed.
//   * Otherwise (this Pi runs the service as `pi`, which can't read Caddy's cert)
//     self-sign a short-lived ECDSA P-256 cert with openssl and hand its SHA-256
//     to the browser via serverCertificateHashes. No root, and the domain's real
//     private key is never copied.
//
// FAIL-SAFE BY DESIGN: any failure (missing dep, no openssl, bind error) only logs
// a warning and leaves the probe disabled; the conferencing server boots
// regardless. Turn it off entirely with WT_PROBE=0.

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CertHash = { algorithm: "sha-256"; value: number[] };
let info: { enabled: boolean; url: string | null; certHash: CertHash | null } = {
  enabled: false,
  url: null,
  certHash: null,
};

export function getWebTransportProbeInfo() {
  return info;
}

// SHA-256 of the cert's DER bytes — the value WebTransport's serverCertificateHashes
// expects. Returned as a plain number[] so it survives JSON to the browser.
function certSha256(certPem: string): CertHash {
  const b64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  const der = Buffer.from(b64, "base64");
  const digest = createHash("sha256").update(der).digest();
  return { algorithm: "sha-256", value: Array.from(digest) };
}

// Self-sign a short-lived ECDSA P-256 cert (serverCertificateHashes requires
// ECDSA and validity <=14 days). Regenerated if missing or expiring soon.
function ensureSelfSignedCert(dir: string): { cert: string; key: string } | null {
  const certFile = path.join(dir, "cert.pem");
  const keyFile = path.join(dir, "key.pem");

  const stillValid = () => {
    if (!existsSync(certFile) || !existsSync(keyFile)) return false;
    const r = spawnSync("openssl", ["x509", "-in", certFile, "-checkend", "172800"]); // 2 days
    return r.status === 0;
  };

  if (!stillValid()) {
    mkdirSync(dir, { recursive: true });
    const r = spawnSync("openssl", [
      "req", "-x509", "-newkey", "ec",
      "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", keyFile, "-out", certFile,
      "-days", "13", "-nodes", "-subj", "/CN=jam-probe",
    ]);
    if (r.status !== 0) {
      const msg = (r.stderr || Buffer.from("")).toString().split("\n")[0] || "openssl failed";
      throw new Error(`openssl self-sign failed: ${msg}`);
    }
  }
  return { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") };
}

export async function startWebTransportProbe(): Promise<void> {
  if (process.env.WT_PROBE === "0") {
    console.log("[wt-probe] disabled (WT_PROBE=0)");
    return;
  }
  const port = Number(process.env.WT_PROBE_PORT || 40059);
  const host = process.env.WT_PROBE_HOST || "0.0.0.0";
  const publicHost = process.env.WT_PROBE_PUBLIC_HOST || "jdh.privatedns.org";
  const certPath = process.env.CERT_PATH;
  const keyPath = process.env.KEY_PATH;

  try {
    let cert = "";
    let privKey = "";
    let certHash: CertHash | null = null;

    // Try the trusted real cert first (root deploy). existsSync can be true while
    // the read still EACCESes — pi can stat Caddy's cert (dir has +x) but not read
    // it (files are 640 caddy) — so ACTUALLY read inside try/catch and fall
    // through to self-signed on any failure.
    if (certPath && keyPath) {
      try {
        cert = readFileSync(certPath, "utf8");
        privKey = readFileSync(keyPath, "utf8");
      } catch {
        cert = "";
        privKey = "";
      }
    }
    if (!cert || !privKey) {
      // Self-signed fallback (service runs as pi). Browser trusts it via the hash.
      const here = path.dirname(fileURLToPath(import.meta.url));
      const gen = ensureSelfSignedCert(path.join(here, "..", ".wt-probe-cert"));
      if (!gen) throw new Error("could not obtain a certificate");
      cert = gen.cert;
      privKey = gen.key;
      certHash = certSha256(gen.cert);
    }

    // Indirected specifier so `tsc` (and dev machines without the native module)
    // don't try to resolve the package at build time.
    const spec = "@fails-components/webtransport";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(spec);
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

    info = { enabled: true, url: `https://${publicHost}:${port}/echo`, certHash };
    console.log(
      `[wt-probe] HTTP/3 echo relay on udp/${port} (path /echo) — ${info.url}` +
        (certHash ? " [self-signed + hash]" : " [trusted cert]"),
    );

    void acceptLoop(server);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wt-probe] not started (probe stays off, server unaffected): ${msg}`);
    info = { enabled: false, url: null, certHash: null };
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
