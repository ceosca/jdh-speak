// Pure decision helpers for WebRTC connection recovery — no DOM, fully unit-testable.
//
// Why this exists: the app used to recover a broken media path ONLY when the signaling
// socket bounced. But the WebRTC media (UDP, often TURN-relayed) can die on its own — a
// NAT rebinding, a route change, a congestion burst — while the signaling WebSocket (TCP,
// via Caddy) rides through. When that happens there was no detection and no rebuild, so a
// peer went silently mute until a full page refresh ("Edu heard everyone but Franco").
// These helpers drive the recovery state machine wired in useMediasoup for BOTH P2P peer
// connections and the SFU transports.

// A connection/ICE state meaning the media path is broken. "failed" is terminal (recover
// now); "disconnected" MAY self-heal, so callers give it a short grace period first.
export function isFailingState(state: string): boolean {
  return state === "failed" || state === "disconnected";
}

// Terminal failure — recover immediately, no grace.
export function isTerminalState(state: string): boolean {
  return state === "failed";
}

// A healthy state cancels any pending recovery.
export function isHealthyState(state: string): boolean {
  return state === "connected" || state === "completed";
}

// P2P glare rule: the LOWER socket id owns the (re)offer, exactly like the initial-join
// and switch-to-p2p conventions. The higher-id side must NOT offer (that races into
// glare) — it sends a "renegotiate" nudge instead, and this side re-offers.
export function iOwnP2pOffer(myId: string, peerId: string): boolean {
  return myId < peerId;
}

// What THIS side should do when its P2P leg to `peerId` needs recovery:
//   "offer"     → rebuild as offerer (fresh offer, new ICE).
//   "nudge"     → ask the peer (the offer owner) to re-offer, via a "renegotiate" signal.
export function p2pRecoveryAction(myId: string, peerId: string): "offer" | "nudge" {
  return iOwnP2pOffer(myId, peerId) ? "offer" : "nudge";
}

// Exponential backoff (ms) for the Nth recovery attempt (1-based), capped — the first
// retry is prompt, a flapping link doesn't hammer restarts.
export function recoveryBackoffMs(attempt: number, base = 2000, max = 15000): number {
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
}

// Give up after this many attempts (then the user can refresh). High on purpose: the
// watchdog already rate-limits retries (seconds apart), so this isn't a storm guard so much
// as a final backstop — we'd rather keep trying to (re)hear someone for minutes than abandon
// a link that's merely flaky. The counter is per-connection and resets on a healthy link or
// when the peer leaves/rejoins (a rejoin brings a new socket id → a fresh counter).
export const MAX_RECOVERY_ATTEMPTS = 40;
export function shouldKeepRetrying(attempt: number, max = MAX_RECOVERY_ATTEMPTS): boolean {
  return attempt <= max;
}

// From a list of the producers the server currently advertises and the producer ids we
// already have a consumer for, the ones we're MISSING and must consume (resync after a
// reconnect / ICE recovery / a missed new-producer). Excludes our own producers (the
// server already omits them) and anything already consumed.
export function missingProducerIds(
  advertised: readonly { producerId: string }[],
  consumedProducerIds: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const p of advertised) {
    if (!consumedProducerIds.has(p.producerId)) out.push(p.producerId);
  }
  return out;
}
