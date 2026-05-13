import type {
  Router,
  WebRtcTransport,
  Producer,
  Consumer,
  Worker,
} from "mediasoup/types";
import { routerOptions, transportOptions } from "./mediasoup-config.js";

export interface Peer {
  id: string;
  displayName: string;
  sendTransport: WebRtcTransport | null;
  recvTransport: WebRtcTransport | null;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

export type RoomMode = "p2p" | "sfu";

export interface Room {
  name: string;
  router: Router;
  peers: Map<string, Peer>;
  mode: RoomMode;
}

const rooms = new Map<string, Room>();

let workers: Worker[] = [];
let workerIdx = 0;

export function setWorkers(w: Worker[]) {
  workers = w;
}

function getNextWorker(): Worker {
  const worker = workers[workerIdx % workers.length];
  workerIdx++;
  return worker;
}

export async function getOrCreateRoom(roomName: string): Promise<Room> {
  const existing = rooms.get(roomName);
  if (existing) return existing;

  const worker = getNextWorker();
  const router = await worker.createRouter(routerOptions);

  const room: Room = {
    name: roomName,
    router,
    peers: new Map(),
    mode: "p2p",
  };
  rooms.set(roomName, room);
  return room;
}

export function createPeer(room: Room, peerId: string, displayName: string): Peer {
  const peer: Peer = {
    id: peerId,
    displayName,
    sendTransport: null,
    recvTransport: null,
    producers: new Map(),
    consumers: new Map(),
  };
  room.peers.set(peerId, peer);
  return peer;
}

export async function createWebRtcTransport(room: Room) {
  const transport = await room.router.createWebRtcTransport(transportOptions);

  // Reduce latency: set max incoming bitrate
  await transport.setMaxIncomingBitrate(1500000);

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
  };
}

export function removePeer(room: Room, peerId: string) {
  const peer = room.peers.get(peerId);
  if (!peer) return;

  // Close all transports (this also closes producers/consumers)
  peer.sendTransport?.close();
  peer.recvTransport?.close();

  room.peers.delete(peerId);

  // If room is empty, destroy it
  if (room.peers.size === 0) {
    room.router.close();
    rooms.delete(room.name);
  }
}

export function getRooms() {
  return rooms;
}
