import type { Router, WebRtcTransport, Producer, Consumer, Worker } from "mediasoup/types";
import { routerOptions, transportOptions } from "./mediasoup-config.js";
import type { ChatMessage } from "./chat-util.js";

export interface Peer {
  id: string;
  displayName: string;
  // Mirrors the client's mute toggle (set via producer-pause/-resume, which
  // fire in P2P mode too) so late joiners can render existing peers' state.
  muted: boolean;
  sendTransport: WebRtcTransport | null;
  recvTransport: WebRtcTransport | null;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

export type RoomMode = "p2p" | "sfu";

// Where a participant sits in the room's 3D field:
//   az   -180…180 degrees — 0 = straight ahead, + = right, ±180 = behind
//   el    -90…90 degrees  — 0 = ear level, + = above
//   dist  metres from the listener
export interface SpatialSeat {
  az: number;
  el: number;
  dist: number;
}

export interface Room {
  name: string;
  router: Router;
  peers: Map<string, Peer>;
  mode: RoomMode;
  // P2P explicitly disabled for this room (via the `?p2p=off` room URL param).
  // Pins the room to the SFU even with <=2 peers; sticky for the room's
  // lifetime once any joiner sets it (see decideMode's forceSfu).
  disableP2p: boolean;
  // Peer ids of send-only "music caster" peers (e.g. Ecobox). While any are
  // present the room is forced to SFU (see decideMode's forceSfu).
  casters: Set<string>;
  // Current room voice bitrate in kbps (128 = original). Changed live via a
  // keyboard shortcut and broadcast to everyone; each client applies it to its
  // own outgoing voice sender. Persists for the room's lifetime so late joiners
  // match the current quality.
  audioBitrate: number;
  // Spatial audio seats for this room, by displayName → SpatialSeat
  // (azimuth / elevation / distance). Shared by everyone; see roomSpatial.
  spatialPositions: Record<string, SpatialSeat>;
  // Whether spatial audio is on for the whole room (see roomSpatialEnabled).
  spatialEnabled: boolean;
  // Rolling chat history (bounded to CHAT_HISTORY_MAX) so late joiners receive
  // recent messages on join. Newest last.
  messages: ChatMessage[];
}

const rooms = new Map<string, Room>();

// Room voice bitrate (kbps) kept BY NAME, surviving room destruction — so a
// quality change isn't lost if every peer briefly reconnects at once (the
// reconnect is how the new bitrate is applied) and the room is recreated.
const roomBitrates = new Map<string, number>();

// Spatial audio seats: where each participant sits around the room, in degrees
// of azimuth (-90 = hard left, 0 = straight ahead, +90 = hard right). Set from
// the hidden Ctrl+Alt+U panel and shared by the WHOLE room, so everyone hears a
// given person from the same direction.
//
// Keyed by displayName, NOT peerId: peerId is the socket id, which changes on
// every reconnect — a seat keyed by it would be lost the moment someone's
// connection blips, and could later be applied to a different person entirely.
// By name, your seat follows you across reconnects.
//
// Kept BY ROOM NAME (surviving room destruction) for the same reason as the
// bitrate: the seating shouldn't be lost just because the room briefly emptied.
const roomSpatial = new Map<string, Record<string, SpatialSeat>>();

// Whether spatial audio is ON for the room. Room-wide like the bitrate: whoever
// flips it (Ctrl+Alt+E) flips it for EVERYONE, so the whole room shares one
// listening mode instead of each person hearing a different arrangement.
const roomSpatialEnabled = new Map<string, boolean>();

export function rememberSpatialEnabled(roomName: string, enabled: boolean): void {
  roomSpatialEnabled.set(roomName, enabled);
  const room = rooms.get(roomName);
  if (room) room.spatialEnabled = enabled;
}

export function rememberSpatialPosition(roomName: string, name: string, seat: SpatialSeat): void {
  const positions = { ...(roomSpatial.get(roomName) ?? {}), [name]: seat };
  roomSpatial.set(roomName, positions);
  const room = rooms.get(roomName);
  if (room) room.spatialPositions = positions;
}

// Carry a seat over when someone renames, so changing your display name doesn't
// silently dump you back to the default position.
export function renameSpatialPosition(roomName: string, from: string, to: string): void {
  const positions = roomSpatial.get(roomName);
  if (!positions || positions[from] === undefined || from === to) return;
  const next = { ...positions, [to]: positions[from] };
  delete next[from];
  roomSpatial.set(roomName, next);
  const room = rooms.get(roomName);
  if (room) room.spatialPositions = next;
}

export function rememberRoomBitrate(roomName: string, kbps: number): void {
  roomBitrates.set(roomName, kbps);
  const room = rooms.get(roomName);
  if (room) room.audioBitrate = kbps;
}

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
    disableP2p: false,
    casters: new Set(),
    audioBitrate: roomBitrates.get(roomName) ?? 128,
    spatialPositions: roomSpatial.get(roomName) ?? {},
    spatialEnabled: roomSpatialEnabled.get(roomName) ?? false,
    messages: [],
  };
  rooms.set(roomName, room);
  return room;
}

export function createPeer(room: Room, peerId: string, displayName: string): Peer {
  const peer: Peer = {
    id: peerId,
    displayName,
    muted: false,
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
