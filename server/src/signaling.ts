import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import type { DtlsParameters, MediaKind, RtpCapabilities, RtpParameters } from "mediasoup/types";
import {
  getOrCreateRoom,
  getRooms,
  createPeer,
  createWebRtcTransport,
  removePeer,
  rememberRoomBitrate,
  rememberSpatialPosition,
  renameSpatialPosition,
  type Room,
  type Peer,
} from "./room-manager.js";
import { decideMode } from "./recording-util.js";
import { RateLimiter, CHAT_HISTORY_MAX, CHAT_TEXT_MAX, type ChatMessage } from "./chat-util.js";
import type { RecordingManager, ProducerInfo } from "./recording.js";

// Minimum gap between a socket's chat typing ticks. ~25 keys/sec is already
// faster than anyone types, so this only clips a flood (held key / hostile
// client) and never a real typist. The client throttles too; this is the
// authoritative floor.
const TYPING_TICK_MIN_MS = 40;

// Minimum gap between nudges from the same sender. A nudge is loud, room-wide
// and unsolicited, so this is deliberately long enough to make spamming it
// pointless without getting in the way of legitimate use.
const NUDGE_MIN_MS = 5000;

// --- Validation schemas ---
const roomNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "Room name must be alphanumeric, hyphens, or underscores");

const displayNameSchema = z
  .string()
  .min(1)
  .max(256)
  .transform((s) => s.replace(/[<>"'&]/g, ""));

// A chat message body: trimmed, non-empty, capped. React escapes it on render
// and it's only ever used as text content (list + ARIA announcement), so the
// content itself isn't sanitized beyond trimming/length.
const chatTextSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, "Message is empty").max(CHAT_TEXT_MAX));

const joinSchema = z.object({
  roomName: roomNameSchema,
  displayName: displayNameSchema,
  // A "caster" is a send-only media source (e.g. Ecobox streaming music). It
  // produces a stereo track but never consumes or sets up P2P, so its presence
  // forces the room onto the SFU.
  role: z.enum(["caster"]).optional(),
  // Explicitly disable P2P for this room (the `?p2p=off` room URL param). Pins
  // the room to the SFU even with <=2 peers; sticky once any joiner sets it.
  disableP2p: z.boolean().optional(),
});

function closeSfuResources(peer: Peer) {
  peer.sendTransport?.close();
  peer.sendTransport = null;
  peer.recvTransport?.close();
  peer.recvTransport = null;
  peer.producers.clear();
  peer.consumers.clear();
}

export function createSignalingServer(
  httpServer: HttpServer,
  recordingManager: RecordingManager,
) {
  const io = new Server(httpServer, {
    cors: { origin: "*" },
    transports: ["websocket"],
    pingInterval: 5000,
    pingTimeout: 10000,
  });

  // When a finished recording is auto-discarded (TTL), tell the room so
  // clients can hide the now-dead download link.
  recordingManager.onExpire = (roomName, recordingId) => {
    io.to(roomName).emit("recording-expired", { recordingId });
  };

  // Anti-spam: 5 messages / 10s per sender. Keyed by socket id for in-room
  // chat, and by `api:<room>` for HTTP posts. Blocked sends are dropped (the
  // client keeps the unsent text and plays a "thunk"), never queued.
  const chatLimiter = new RateLimiter();

  // Append a message to the room's bounded history and fan it out to everyone
  // in the room — INCLUDING the original sender, so the sender's own client
  // also gets the echo to render, announce, and chime on.
  function deliverChatMessage(room: Room, sender: string, text: string): ChatMessage {
    const msg: ChatMessage = { id: randomUUID(), sender, text, ts: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > CHAT_HISTORY_MAX) {
      room.messages.splice(0, room.messages.length - CHAT_HISTORY_MAX);
    }
    io.to(room.name).emit("chat-message", msg);
    return msg;
  }

  // HTTP entrypoint (see the POST /api/rooms/:room/messages route): post a
  // message into a live room from outside the socket world (e.g. Ecobox
  // announcing the now-playing track). Same validation + rate limit as a peer.
  function postChatMessage(
    roomName: string,
    sender: string,
    rawText: string,
  ): { ok: true; message: ChatMessage } | { ok: false; error: string; status: number } {
    const room = getRooms().get(roomName);
    if (!room) return { ok: false, error: "Room not found or empty", status: 404 };

    const parsed = chatTextSchema.safeParse(rawText);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid message",
        status: 400,
      };
    }
    const cleanSender =
      sender
        .replace(/[<>"'&]/g, "")
        .trim()
        .slice(0, 256) || "System";
    if (!chatLimiter.tryConsume(`api:${roomName}`, Date.now())) {
      return { ok: false, error: "Rate limited", status: 429 };
    }
    return { ok: true, message: deliverChatMessage(room, cleanSender, parsed.data) };
  }

  // The room must be pinned to the SFU when the server has to see/route the
  // media itself: while recording, or while a send-only "music caster" peer
  // (Ecobox) is present (a caster produces but never sets up P2P). P2P can also
  // be disabled outright for the room via the `?p2p=off` URL param.
  function shouldForceSfu(room: Room): boolean {
    return (
      recordingManager.isRecording(room.name) ||
      room.casters.size > 0 ||
      room.disableP2p
    );
  }

  // --- Evaluate room mode and trigger switches ---
  // A recording (or an active music caster) forces SFU and prevents the usual
  // downgrade to P2P, so the server keeps seeing the media.
  // exceptSocketId: when a newly-joined peer pushes the room into SFU, that peer
  // already learned mode:"sfu" from its join response and sets up the SFU from
  // it — so it must be EXCLUDED from the switch broadcast, or it would set up
  // SFU twice concurrently (duplicate transports → "connect() already called",
  // and one transport that never finishes connecting).
  function applyModeDecision(room: Room, exceptSocketId?: string) {
    const decision = decideMode(room.peers.size, room.mode, shouldForceSfu(room));
    if (decision.action === "none") return;

    room.mode = decision.mode;
    const targets = exceptSocketId ? io.to(room.name).except(exceptSocketId) : io.to(room.name);
    if (decision.action === "switch-to-sfu") {
      console.log(`[room:${room.name}] switching to SFU (${room.peers.size} peers)`);
      targets.emit("switch-to-sfu", {
        rtpCapabilities: room.router.rtpCapabilities,
      });
    } else {
      console.log(`[room:${room.name}] switching to P2P (${room.peers.size} peers)`);
      for (const peer of room.peers.values()) {
        closeSfuResources(peer);
      }
      const peerIds = Array.from(room.peers.keys());
      targets.emit("switch-to-p2p", { peerIds });
    }
  }

  // Remove one peer from the room and clean up everything they held.
  // No-ops if the peer is already gone.
  function teardownPeer(room: Room, peerId: string, opts: { announceLeft: boolean }) {
    const peer = room.peers.get(peerId);
    if (!peer) return;

    if (opts.announceLeft) {
      io.to(room.name).except(peerId).emit("peer-left", { peerId });
    }

    // Stop capturing/feeding this peer's producers (already-recorded audio stays
    // on disk and is still included in downloads).
    if (recordingManager.isRecording(room.name)) {
      for (const producerId of peer.producers.keys()) {
        void recordingManager.removeProducer(room.name, producerId).catch(() => {});
      }
    }
    // If this was the last peer, the room is about to be destroyed — drop any
    // recording (active or finished-but-downloadable).
    if (room.peers.size <= 1 && recordingManager.getRecording(room.name)) {
      void recordingManager.discard(room.name).catch(() => {});
    }

    // Drop from the casters set before removePeer (which may destroy the room)
    // so the mode decision no longer forces SFU once this music caster is gone.
    room.casters.delete(peerId);

    removePeer(room, peerId);

    if (room.peers.size > 0) {
      applyModeDecision(room);
    }
  }

  // Real client IP for logging. We sit behind Caddy (reverse_proxy to
  // 127.0.0.1), so socket.handshake.address is always the proxy — the real
  // client is the FIRST entry of X-Forwarded-For (Caddy appends its own hops
  // after it). Falls back to the direct address in dev (no proxy).
  const clientIp = (socket: Socket): string => {
    const xff = socket.handshake.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const first = raw?.split(",")[0]?.trim();
    return first || socket.handshake.address || "?";
  };

  io.on("connection", (socket) => {
    console.log(`[ws] connected: ${socket.id} [${clientIp(socket)}]`);
    let currentRoom: Room | null = null;
    let currentPeer: Peer | null = null;
    // Server-side floor between typing ticks from this socket (see the handler).
    let lastTypingTick = 0;
    // Last nudge sent by this socket, for the nudge throttle.
    let lastNudge = 0;

    socket.on("join", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        const { roomName, displayName, role, disableP2p } =
          joinSchema.parse(data);
        const room = await getOrCreateRoom(roomName);

        console.log(
          `[ws] ${socket.id} joined ${roomName} as "${displayName}" [${clientIp(socket)}]${role ? ` (${role})` : ""}${disableP2p ? " (p2p disabled)" : ""}`,
        );

        const peer = createPeer(room, socket.id, displayName);

        // Register a caster / P2P-disable BEFORE deciding the mode, so the join
        // response (and the new peer's own setup) already reflects the
        // forced-SFU room. disableP2p is sticky for the room's lifetime.
        if (role === "caster") room.casters.add(socket.id);
        if (disableP2p) room.disableP2p = true;
        currentRoom = room;
        currentPeer = peer;

        await socket.join(roomName);

        // Notify existing peers
        socket.to(roomName).emit("peer-joined", {
          peerId: socket.id,
          displayName,
        });

        // Send existing peers to the new joiner. Each producer carries its
        // `source` ("voice" | "music") so a late joiner can label/treat the
        // music caster as a media source without waiting for a new-producer event.
        const existingPeers = Array.from(room.peers.entries())
          .filter(([id]) => id !== socket.id)
          .map(([id, p]) => ({
            peerId: id,
            displayName: p.displayName,
            muted: p.muted,
            producers: Array.from(p.producers.values()).map((prod) => ({
              producerId: prod.id,
              source: (prod.appData?.source as string) ?? "voice",
            })),
          }));

        // Determine mode: 3+ peers => SFU; an active recording or music caster
        // also forces SFU even with <=2 peers.
        const decision = decideMode(room.peers.size, room.mode, shouldForceSfu(room));

        cb({
          ok: true,
          rtpCapabilities: room.router.rtpCapabilities,
          peers: existingPeers,
          mode: decision.mode,
          // Recording is private to whoever started it — not revealed to others.
          recording: null,
          // Current room voice bitrate (kbps, 128 = original) so a late joiner
          // matches the room's current quality.
          audioBitrate: room.audioBitrate,
          spatialPositions: room.spatialPositions,
          // Recent chat so a late joiner can read/announce the last messages.
          messages: room.messages,
        });

        if (decision.action === "switch-to-sfu") {
          // A new peer pushed the room into SFU — switch everyone ELSE over.
          // Exclude this socket: it already got mode:"sfu" in its join response
          // and sets up the SFU from that, so re-notifying it would double-setup.
          applyModeDecision(room, socket.id);
        }
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Invalid input" });
      }
    });

    // --- P2P signaling relay ---
    socket.on("p2p-signal", (data: unknown) => {
      if (!currentRoom) return;
      const parsed = z
        .object({
          targetPeerId: z.string(),
          type: z.enum(["offer", "answer", "ice-candidate"]),
          payload: z.any(),
        })
        .safeParse(data);
      if (!parsed.success) return;

      const { targetPeerId, type, payload } = parsed.data;
      io.to(targetPeerId).emit("p2p-signal", {
        fromPeerId: socket.id,
        type,
        payload,
      });
    });

    // --- Chat ---
    // Broadcast a text message to the room. Rate-limited per socket; a blocked
    // send returns `rate_limited` and is NOT delivered (the client keeps the
    // text and plays a thunk). The accepted message echoes back to the sender
    // too, so every client renders/announces it through one code path.
    socket.on("chat-message", (data: unknown, cb: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) {
        cb?.({ ok: false, error: "Not in a room" });
        return;
      }
      const parsed = z.object({ text: chatTextSchema }).safeParse(data);
      if (!parsed.success) {
        cb?.({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid message" });
        return;
      }
      if (!chatLimiter.tryConsume(socket.id, Date.now())) {
        cb?.({ ok: false, error: "rate_limited" });
        return;
      }
      const msg = deliverChatMessage(currentRoom, currentPeer.displayName, parsed.data.text);
      cb?.({ ok: true, message: msg });
    });

    // --- SFU transport/produce/consume (same as before) ---
    socket.on("create-transport", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom || !currentPeer) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }

        const { direction } = z.object({ direction: z.enum(["send", "recv"]) }).parse(data);
        const { transport, params } = await createWebRtcTransport(currentRoom);

        if (direction === "send") {
          currentPeer.sendTransport = transport;
        } else {
          currentPeer.recvTransport = transport;
        }

        cb({ ok: true, params });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Transport creation failed" });
      }
    });

    socket.on("connect-transport", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentPeer) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }

        const { direction, dtlsParameters } = z
          .object({
            direction: z.enum(["send", "recv"]),
            dtlsParameters: z.any() as z.ZodType<DtlsParameters>,
          })
          .parse(data);

        const transport =
          direction === "send" ? currentPeer.sendTransport : currentPeer.recvTransport;

        if (!transport) {
          cb({ ok: false, error: "Transport not found" });
          return;
        }

        await transport.connect({ dtlsParameters });
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Connect failed" });
      }
    });

    socket.on("produce", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom || !currentPeer?.sendTransport) {
          cb({ ok: false, error: "No send transport" });
          return;
        }

        const { kind, rtpParameters, source } = z
          .object({
            kind: z.enum(["audio", "video"]) as z.ZodType<MediaKind>,
            rtpParameters: z.any() as z.ZodType<RtpParameters>,
            // "music" for a caster's stereo track, "share" for a peer's stereo
            // system/tab-audio share, "file" for a peer streaming a local audio
            // file, "voice" (default) for mics.
            source: z.enum(["voice", "music", "share", "file"]).optional(),
          })
          .parse(data);

        const producer = await currentPeer.sendTransport.produce({
          kind,
          rtpParameters,
          appData: { source: source ?? "voice" },
        });

        currentPeer.producers.set(producer.id, producer);

        // If the room is being recorded, tap this producer too. Not awaited —
        // the produce callback should return promptly, and the recorder spins up
        // in the background.
        const producerInfo: ProducerInfo = {
          producerId: producer.id,
          peerId: socket.id,
          label: currentPeer.displayName,
          source: source ?? "voice",
        };
        if (recordingManager.isRecording(currentRoom.name)) {
          void recordingManager
            .addProducer(currentRoom.name, producerInfo)
            .catch((err) => console.error("[recording] addProducer failed:", err));
        }

        // Notify all other peers that a new producer is available
        socket.to(currentRoom.name).emit("new-producer", {
          peerId: socket.id,
          producerId: producer.id,
          kind: producer.kind,
          source: (producer.appData?.source as string) ?? "voice",
        });

        cb({ ok: true, producerId: producer.id });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Produce failed" });
      }
    });

    socket.on("consume", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom || !currentPeer?.recvTransport) {
          cb({ ok: false, error: "No recv transport" });
          return;
        }

        const { producerId, rtpCapabilities } = z
          .object({
            producerId: z.string(),
            rtpCapabilities: z.any() as z.ZodType<RtpCapabilities>,
          })
          .parse(data);

        if (!currentRoom.router.canConsume({ producerId, rtpCapabilities })) {
          cb({ ok: false, error: "Cannot consume" });
          return;
        }

        const consumer = await currentPeer.recvTransport.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });

        currentPeer.consumers.set(consumer.id, consumer);

        cb({
          ok: true,
          consumerId: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Consume failed" });
      }
    });

    // Mute/unmute pauses only the VOICE producer — a peer's shared-audio
    // ("share") producer keeps streaming so the music isn't cut when they mute.
    socket.on("producer-pause", async (_data: unknown, cb: (res: unknown) => void) => {
      if (!currentPeer) return cb({ ok: false });
      currentPeer.muted = true;
      for (const producer of currentPeer.producers.values()) {
        if (((producer.appData?.source as string) ?? "voice") !== "voice") continue;
        await producer.pause();
      }
      if (currentRoom) {
        socket.to(currentRoom.name).emit("peer-muted", { peerId: socket.id });
      }
      cb({ ok: true });
    });

    socket.on("producer-resume", async (_data: unknown, cb: (res: unknown) => void) => {
      if (!currentPeer) return cb({ ok: false });
      currentPeer.muted = false;
      for (const producer of currentPeer.producers.values()) {
        if (((producer.appData?.source as string) ?? "voice") !== "voice") continue;
        await producer.resume();
      }
      if (currentRoom) {
        socket.to(currentRoom.name).emit("peer-unmuted", { peerId: socket.id });
      }
      cb({ ok: true });
    });

    // Visual mute toggle that does NOT pause the producer — used when a peer has a
    // secondary transmission device mixed into their voice track, so muting their
    // mic must not stop the producer (the secondary keeps flowing). Mirrors the
    // peer-muted/-unmuted broadcast of producer-pause without touching media.
    socket.on("set-mute-state", (data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      const parsed = z.object({ muted: z.boolean() }).safeParse(data);
      if (!parsed.success) return cb?.({ ok: false, error: "Invalid value" });
      currentPeer.muted = parsed.data.muted;
      socket.to(currentRoom.name).emit(parsed.data.muted ? "peer-muted" : "peer-unmuted", {
        peerId: socket.id,
      });
      cb?.({ ok: true });
    });

    // --- Recording ---
    socket.on("start-recording", async (_data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }
        const room = currentRoom;

        if (recordingManager.isRecording(room.name)) {
          cb({ ok: true, recordingId: recordingManager.getRecording(room.name)!.id });
          return;
        }

        // Snapshot producers that already exist (only present if the room was
        // already in SFU). In P2P there are none yet — applyModeDecision below
        // forces SFU, and each peer's `produce` then registers via addProducer.
        const producers: ProducerInfo[] = [];
        for (const [peerId, peer] of room.peers) {
          for (const [producerId, producer] of peer.producers) {
            producers.push({
              producerId,
              peerId,
              label: peer.displayName,
              source: (producer.appData?.source as string) ?? "voice",
            });
          }
        }

        const rec = await recordingManager.start(room.name, room.router, producers);
        // Force SFU if we're in P2P so the server can see the media.
        applyModeDecision(room);

        // Recording is silent to the room — only the initiator learns of it, via
        // this callback. No room-wide notification or REC badge for others.
        cb({ ok: true, recordingId: rec.id });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Failed to start recording" });
      }
    });

    socket.on("stop-recording", async (_data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }
        const room = currentRoom;
        // Finalize (not discard): captures stop, but the file stays
        // downloadable until its TTL / a new recording / room exit.
        await recordingManager.finalize(room.name);
        // Recording no longer pins SFU — fall back to P2P if <=2 peers remain.
        applyModeDecision(room);
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Failed to stop recording" });
      }
    });

    // --- Live rename: a peer changed their display name; broadcast it so others
    // re-render their card. The peer's own client updates locally.
    socket.on("rename", (data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      const parsed = z.object({ displayName: displayNameSchema }).safeParse(data);
      if (!parsed.success) return cb?.({ ok: false, error: "Invalid name" });
      const previousName = currentPeer.displayName;
      currentPeer.displayName = parsed.data.displayName;
      socket.to(currentRoom.name).emit("peer-renamed", {
        peerId: socket.id,
        displayName: parsed.data.displayName,
      });
      // Seats are keyed by name, so carry this peer's spatial position over —
      // otherwise renaming would silently drop them back to the default seat.
      renameSpatialPosition(currentRoom.name, previousName, parsed.data.displayName);
      io.to(currentRoom.name).emit("spatial-positions", currentRoom.spatialPositions);
      cb?.({ ok: true, displayName: parsed.data.displayName });
    });

    // --- Room audio quality (bitrate). No UI: changed live via a keyboard
    // shortcut; whoever triggers it sets it for EVERYONE (broadcast). Each
    // client then re-creates its outgoing voice stream at the new bitrate.
    socket.on("set-bitrate", (data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      const parsed = z.object({ kbps: z.number().int() }).safeParse(data);
      const allowed = [8, 16, 32, 64, 96, 128];
      if (!parsed.success || !allowed.includes(parsed.data.kbps)) {
        return cb?.({ ok: false, error: "Invalid bitrate" });
      }
      rememberRoomBitrate(currentRoom.name, parsed.data.kbps);
      io.to(currentRoom.name).emit("bitrate-changed", {
        kbps: parsed.data.kbps,
        by: currentPeer.displayName,
      });
      cb?.({ ok: true });
    });

    // Audible typing indicator: ONE tick per keystroke, so the room hears the
    // typist's actual rhythm. Deliberately stateless (no "is typing" flag to get
    // stuck): if someone drops mid-sentence the ticks simply stop arriving.
    // The client throttles, but don't trust it — a peer could flood the room, so
    // drop ticks that arrive faster than a human types.
    // Spatial audio seating: move a participant's position in the room's 3D
    // field. Room-wide on purpose — everyone should hear a given person from the
    // same direction, so the "virtual table" is consistent for all listeners.
    // Reached only from the hidden Ctrl+Alt+U panel (like the bitrate shortcut),
    // which is why there's no permission model here: knowing the shortcut is it.
    socket.on("set-spatial-position", (data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      const parsed = z
        .object({ name: z.string().min(1).max(256), degrees: z.number().min(-90).max(90) })
        .safeParse(data);
      if (!parsed.success) return cb?.({ ok: false, error: "Invalid position" });
      // Round to the slider's step so tiny float drift can't churn the map.
      const degrees = Math.round(parsed.data.degrees / 5) * 5;
      rememberSpatialPosition(currentRoom.name, parsed.data.name, degrees);
      io.to(currentRoom.name).emit("spatial-positions", currentRoom.spatialPositions);
      cb?.({ ok: true });
    });

    // Nudge ("zumbido", MSN-style): plays an attention-grabbing sound for the
    // WHOLE room. Because it's loud and unsolicited it's the easiest thing to
    // abuse, so it's throttled harder than anything else — one per NUDGE_MIN_MS
    // per sender, enforced here (the client also disables its button meanwhile).
    // A blocked nudge answers ok:false so the sender gets the "thunk" instead.
    socket.on("nudge", (_data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      const now = Date.now();
      if (now - lastNudge < NUDGE_MIN_MS) return cb?.({ ok: false, error: "rate_limited" });
      lastNudge = now;
      socket.to(currentRoom.name).emit("peer-nudge", { from: currentPeer.displayName });
      cb?.({ ok: true });
    });

    socket.on("typing-tick", () => {
      if (!currentRoom || !currentPeer) return;
      const now = Date.now();
      if (now - lastTypingTick < TYPING_TICK_MIN_MS) return;
      lastTypingTick = now;
      socket.to(currentRoom.name).emit("peer-typing-tick");
    });

    socket.on("disconnect", (reason) => {
      console.log(`[ws] disconnected: ${socket.id} (${reason})`);
      chatLimiter.forget(socket.id);

      if (currentRoom && currentPeer) {
        const room = currentRoom;
        teardownPeer(room, socket.id, { announceLeft: true });
      }
    });
  });

  return { io, postChatMessage };
}
