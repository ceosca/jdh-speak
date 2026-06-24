import type { WorkerSettings, RouterOptions, WebRtcTransportOptions } from "mediasoup/types";
import type { TransportListenInfo } from "mediasoup/types";
import os from "node:os";

const numCores = os.cpus().length;

export const workerSettings: WorkerSettings = {
  logLevel: "warn",
  rtcMinPort: 40000,
  rtcMaxPort: 40100,
};

export const numWorkers = Math.max(1, numCores);

export const routerOptions: RouterOptions = {
  mediaCodecs: [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
      parameters: {
        useinbandfec: 1,
        usedtx: 0,
        maxplaybackrate: 48000,
        maxaveragebitrate: 256000,
        minptime: 10,
        ptime: 10,
      },
    },
  ],
};

// ICE candidates announced to clients. We always announce the public IPv4
// (ANNOUNCED_IP) so remote participants reach the SFU through the router's
// port-forward. We ALSO announce the LAN IP (ANNOUNCED_IP_LOCAL) when set, so
// participants on the same local network connect directly over the LAN — no NAT
// hairpin needed and lower latency. ICE picks whichever candidate actually works
// for each client, so advertising both is safe. IPv6 is announced only when
// ANNOUNCED_IP6 is set, to avoid advertising unreachable ULA/link-local addresses.
//
// IMPORTANT: these are read at import time (before index.ts loads the .env), so
// in production the env MUST be present before the process starts. Use systemd's
// EnvironmentFile=...  (see sonicroom.service) — relying on the app's own .env
// loader alone leaves ANNOUNCED_IP unset here and ICE falls back to 127.0.0.1.
const listenInfos: TransportListenInfo[] = [
  {
    protocol: "udp",
    ip: "0.0.0.0",
    announcedAddress: process.env.ANNOUNCED_IP || "127.0.0.1",
  },
];

if (process.env.ANNOUNCED_IP_LOCAL) {
  listenInfos.push({
    protocol: "udp",
    ip: "0.0.0.0",
    announcedAddress: process.env.ANNOUNCED_IP_LOCAL,
  });
}

if (process.env.ANNOUNCED_IP6) {
  listenInfos.push({
    protocol: "udp",
    ip: "::",
    announcedAddress: process.env.ANNOUNCED_IP6,
  });
}

export const transportOptions: WebRtcTransportOptions = {
  listenInfos,
  initialAvailableOutgoingBitrate: 600000,
  enableUdp: true,
  enableTcp: false,
  preferUdp: true,
  iceConsentTimeout: 20,
};
