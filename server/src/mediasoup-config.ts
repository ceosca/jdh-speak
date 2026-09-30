import type { WorkerSettings, RouterOptions, WebRtcTransportOptions } from "mediasoup/types";
import type { TransportListenInfo } from "mediasoup/types";
import os from "node:os";

const numCores = os.cpus().length;

// PORTS. The router forwards ONLY 40000-40100 to this host, shared by:
//   - the SFU: a mediasoup WebRtcServer per worker = 2 FIXED UDP ports per worker
//     (public + LAN candidate), WEBRTC_SERVER_BASE_PORT… (40000-40007 with 4 workers).
//     ALL of a worker's WebRtcTransports share them. Before, every transport opened its
//     own port per announced address (2 per transport → 4 per SFU peer), eating 59 ports
//     for ~14 people and starving coturn.
//   - the WebTransport probe (parked jam experiment): WT_PROBE_PORT, default 40008.
//   - coturn's relay range: 40009-40100 (92 ports; was 41 → "no available ports" bursts
//     logged 164 times in 14 days, leaving TURN-dependent phones unable to hear some
//     people). See /etc/turnserver.conf + deploy/pi/coturn/turnserver.conf.
// The worker's own rtc port range is now used only by LOOPBACK PlainTransports
// (recording / Icecast taps on 127.0.0.1), so it lives OUTSIDE the forwarded range.
// Two processes can't bind the same port — keep all of these disjoint.
export const WEBRTC_SERVER_BASE_PORT = Number(process.env.WEBRTC_SERVER_BASE_PORT || 40000);
export const workerSettings: WorkerSettings = {
  logLevel: "warn",
  rtcMinPort: 44000,
  rtcMaxPort: 44999,
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
    // Video codecs for the opt-in camera. VP8 covers Chrome/Firefox/Android;
    // H264 (constrained-baseline, packetization-mode 1) is what Safari/iOS
    // encode, so BOTH must be here or an iPhone camera can't be consumed by a
    // Chrome peer (and vice-versa). Video only ever flows on the SFU — turning a
    // camera on forces the room onto the SFU (shouldForceSfu), so there is no P2P
    // video path to negotiate.
    {
      kind: "video",
      mimeType: "video/VP8",
      clockRate: 90000,
    },
    {
      kind: "video",
      mimeType: "video/H264",
      clockRate: 90000,
      parameters: {
        "packetization-mode": 1,
        "profile-level-id": "42e01f",
        "level-asymmetry-allowed": 1,
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
// EnvironmentFile=...  (see jdh-speak.service) — relying on the app's own .env
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

// The WebRtcServer listen infos for worker `index`: the same announced addresses as
// `listenInfos`, each on its own FIXED port (base + index*count + k).
export function webRtcServerListenInfos(index: number): TransportListenInfo[] {
  return listenInfos.map((info, k) => ({
    ...info,
    port: WEBRTC_SERVER_BASE_PORT + index * listenInfos.length + k,
  }));
}

// How many forwarded ports the WebRtcServers take (the WebTransport probe sits right after).
export function webRtcServerPortCount(): number {
  return numWorkers * listenInfos.length;
}

// Per-transport options when a WebRtcServer is used (listen addresses come from it).
export const serverTransportOptions = {
  initialAvailableOutgoingBitrate: 600000,
  enableUdp: true,
  enableTcp: false,
  preferUdp: true,
  iceConsentTimeout: 30,
};

// Fallback (no WebRtcServer could be created): one port per transport and address,
// taken from the worker's range — which is now loopback-only, so give these transports
// an explicit FORWARDED port range instead.
export const transportOptions: WebRtcTransportOptions = {
  listenInfos: listenInfos.map((info) => ({ ...info, portRange: { min: 40000, max: 40007 } })),
  initialAvailableOutgoingBitrate: 600000,
  enableUdp: true,
  enableTcp: false,
  preferUdp: true,
  // Grace before mediasoup drops a transport whose ICE consent (liveness) checks stop
  // getting answered. 20 was BELOW the default (30) — a ~20s media stall on a weak SFU
  // peer (Franco/Edu) cut their audio. 30 rides out a real blip; genuine death still
  // closes it, and the client's transport watchdog now recovers via restart-ice anyway.
  iceConsentTimeout: 30,
};
