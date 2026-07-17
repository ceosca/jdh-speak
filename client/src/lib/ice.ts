// ICE servers for the P2P peer connections (and the SFU's TCP/TLS fallback).
//
// These come from the server, injected into the served index.html as
// `window.__JDH_SPEAK_CONFIG__.iceServers` (see server/src/index.ts) — the same
// runtime-config mechanism as the instance name. So the TURN and its credentials
// live in the deployment's .env, NOT in this repo, and changing them is an .env
// edit + server restart with no client rebuild.
//
// Fallback (dev, where Vite serves the raw HTML so the global is absent, or a
// deployment with no TURN_* configured): public STUN only. STUN alone is enough
// to discover a reflexive address, but NOT to relay — so on symmetric NAT or
// restrictive networks a call may fail to connect without a TURN. That's the
// deliberate trade-off: never hardcode someone else's TURN here again.
// See docs/turn-server.md.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export function getIceServers(): RTCIceServer[] {
  const injected =
    typeof window !== "undefined" ? window.__JDH_SPEAK_CONFIG__?.iceServers : undefined;
  return Array.isArray(injected) && injected.length > 0 ? injected : DEFAULT_ICE_SERVERS;
}
