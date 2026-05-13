import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { z } from "zod";
import type { DtlsParameters, MediaKind, RtpCapabilities, RtpParameters } from "mediasoup/types";
import {
  getOrCreateRoom,
  createPeer,
  createWebRtcTransport,
  removePeer,
  type Room,
  type Peer,
} from "./room-manager.js";

// --- Validation schemas ---
const roomNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "Room name must be alphanumeric, hyphens, or underscores");

const displayNameSchema = z
  .string()
  .min(1)
  .max(32)
  .transform((s) => s.replace(/[<>"'&]/g, ""));

const joinSchema = z.object({
  roomName: roomNameSchema,
  displayName: displayNameSchema,
});

function closeSfuResources(peer: Peer) {
  peer.sendTransport?.close();
  peer.sendTransport = null;
  peer.recvTransport?.close();
  peer.recvTransport = null;
  peer.producers.clear();
  peer.consumers.clear();
}

export function createSignalingServer(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: { origin: "*" },
    transports: ["websocket"],
    pingInterval: 5000,
    pingTimeout: 10000,
  });

  io.on("connection", (socket) => {
    console.log(`[ws] connected: ${socket.id}`);
    let currentRoom: Room | null = null;
    let currentPeer: Peer | null = null;

    // --- Evaluate room mode and trigger switches ---
    function evaluateMode(room: Room) {
      const peerCount = room.peers.size;
      if (peerCount <= 2 && room.mode === "sfu") {
        // Switch to P2P
        room.mode = "p2p";
        console.log(`[room:${room.name}] switching to P2P (${peerCount} peers)`);

        // Tell all peers to tear down SFU and go P2P
        for (const peer of room.peers.values()) {
          closeSfuResources(peer);
        }

        const peerIds = Array.from(room.peers.keys());
        io.to(room.name).emit("switch-to-p2p", { peerIds });
      } else if (peerCount > 2 && room.mode === "p2p") {
        // Switch to SFU
        room.mode = "sfu";
        console.log(`[room:${room.name}] switching to SFU (${peerCount} peers)`);

        io.to(room.name).emit("switch-to-sfu", {
          rtpCapabilities: room.router.rtpCapabilities,
        });
      }
    }

    socket.on("join", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        const { roomName, displayName } = joinSchema.parse(data);
        console.log(`[ws] ${socket.id} joined ${roomName} as "${displayName}"`);
        const room = await getOrCreateRoom(roomName);
        const peer = createPeer(room, socket.id, displayName);

        currentRoom = room;
        currentPeer = peer;

        await socket.join(roomName);

        // Notify existing peers
        socket.to(roomName).emit("peer-joined", {
          peerId: socket.id,
          displayName,
        });

        // Send existing peers to the new joiner
        const existingPeers = Array.from(room.peers.entries())
          .filter(([id]) => id !== socket.id)
          .map(([id, p]) => ({
            peerId: id,
            displayName: p.displayName,
            producerIds: Array.from(p.producers.keys()),
          }));

        // Determine mode: 2 peers = p2p, 3+ = sfu
        const shouldBeSfu = room.peers.size > 2;
        const wasP2p = room.mode === "p2p";

        cb({
          ok: true,
          rtpCapabilities: room.router.rtpCapabilities,
          peers: existingPeers,
          mode: shouldBeSfu ? "sfu" : "p2p",
        });

        if (shouldBeSfu && wasP2p) {
          // 3rd peer just joined — switch everyone to SFU
          evaluateMode(room);
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

        const { kind, rtpParameters } = z
          .object({
            kind: z.enum(["audio", "video"]) as z.ZodType<MediaKind>,
            rtpParameters: z.any() as z.ZodType<RtpParameters>,
          })
          .parse(data);

        const producer = await currentPeer.sendTransport.produce({
          kind,
          rtpParameters,
        });

        currentPeer.producers.set(producer.id, producer);

        // Notify all other peers that a new producer is available
        socket.to(currentRoom.name).emit("new-producer", {
          peerId: socket.id,
          producerId: producer.id,
          kind: producer.kind,
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

    socket.on("producer-pause", async (_data: unknown, cb: (res: unknown) => void) => {
      if (!currentPeer) return cb({ ok: false });
      for (const producer of currentPeer.producers.values()) {
        await producer.pause();
      }
      if (currentRoom) {
        socket.to(currentRoom.name).emit("peer-muted", { peerId: socket.id });
      }
      cb({ ok: true });
    });

    socket.on("producer-resume", async (_data: unknown, cb: (res: unknown) => void) => {
      if (!currentPeer) return cb({ ok: false });
      for (const producer of currentPeer.producers.values()) {
        await producer.resume();
      }
      if (currentRoom) {
        socket.to(currentRoom.name).emit("peer-unmuted", { peerId: socket.id });
      }
      cb({ ok: true });
    });

    socket.on("disconnect", (reason) => {
      console.log(`[ws] disconnected: ${socket.id} (${reason})`);
      if (currentRoom && currentPeer) {
        socket.to(currentRoom.name).emit("peer-left", { peerId: socket.id });
        removePeer(currentRoom, socket.id);

        // Check if we should switch back to P2P
        if (currentRoom.peers.size > 0) {
          evaluateMode(currentRoom);
        }
      }
    });
  });

  return io;
}
