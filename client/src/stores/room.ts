import { create } from "zustand";

// Outgoing mic gain is a per-device preference, so it's persisted and survives
// reloads — and carries from the lobby's mic preview into the room.
const MIC_GAIN_KEY = "sonicroom:micGain";
export const MAX_MIC_GAIN = 4;

function loadMicGain(): number {
  try {
    const v = parseFloat(localStorage.getItem(MIC_GAIN_KEY) ?? "");
    if (Number.isFinite(v)) return Math.min(MAX_MIC_GAIN, Math.max(0, v));
  } catch {
    // localStorage unavailable (e.g. private mode) — fall back to unity.
  }
  return 1;
}

export interface PeerState {
  peerId: string;
  displayName: string;
  isSpeaking: boolean;
  isMuted: boolean;
  volume: number; // 0-4
  // True for a send-only "music caster" peer (e.g. Ecobox): rendered with a
  // music icon and treated as a media source rather than a talking participant.
  isMusic: boolean;
}

export type RoomMode = "p2p" | "sfu";

interface RoomState {
  // Connection
  connected: boolean;
  roomName: string | null;
  displayName: string | null;
  localPeerId: string | null;
  mode: RoomMode;

  // Local controls
  isMuted: boolean;
  isDeafened: boolean;
  isPushToTalk: boolean;
  pttActive: boolean;
  isSharingAudio: boolean;
  // Outgoing (send-side) mic gain applied before the track reaches peers/SFU,
  // 0–MAX_MIC_GAIN. 1 = unity (raw mic). Lets a quiet/cheap mic be boosted for
  // everyone, independent of each listener's per-peer playback volume.
  micGain: number;

  // Recording (a recording belongs to the room; visible to everyone)
  isRecording: boolean;
  recordingId: string | null;

  // Latest screen-reader announcement (peer join/leave, recording, etc.).
  // `announceSeq` changes on every announce() so React re-renders even when
  // the same message repeats.
  announcement: string;
  announceSeq: number;

  // Peers
  peers: Map<string, PeerState>;

  // Actions
  setConnected: (connected: boolean) => void;
  setRoom: (roomName: string, displayName: string, localPeerId: string) => void;
  setMode: (mode: RoomMode) => void;
  setMuted: (muted: boolean) => void;
  setDeafened: (deafened: boolean) => void;
  setPttActive: (active: boolean) => void;
  togglePushToTalk: () => void;
  setSharingAudio: (sharing: boolean) => void;
  setMicGain: (gain: number) => void;
  setRecording: (recording: boolean, recordingId?: string | null) => void;
  announce: (message: string) => void;
  addPeer: (peerId: string, displayName: string) => void;
  removePeer: (peerId: string) => void;
  setPeerSpeaking: (peerId: string, speaking: boolean) => void;
  setPeerMuted: (peerId: string, muted: boolean) => void;
  setPeerVolume: (peerId: string, volume: number) => void;
  setPeerMusic: (peerId: string, isMusic: boolean) => void;
  reset: () => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  connected: false,
  roomName: null,
  displayName: null,
  localPeerId: null,
  mode: "p2p",
  isMuted: false,
  isDeafened: false,
  isPushToTalk: false,
  pttActive: false,
  isSharingAudio: false,
  micGain: loadMicGain(),
  isRecording: false,
  recordingId: null,
  announcement: "",
  announceSeq: 0,
  peers: new Map(),

  setConnected: (connected) => set({ connected }),
  setRoom: (roomName, displayName, localPeerId) =>
    set({ roomName, displayName, localPeerId }),
  setMode: (mode) => set({ mode }),
  setMuted: (isMuted) => set({ isMuted }),
  setDeafened: (isDeafened) => set({ isDeafened }),
  setPttActive: (pttActive) => set({ pttActive }),
  togglePushToTalk: () => set((s) => ({ isPushToTalk: !s.isPushToTalk })),
  setSharingAudio: (isSharingAudio) => set({ isSharingAudio }),
  setMicGain: (micGain) => {
    try {
      localStorage.setItem(MIC_GAIN_KEY, String(micGain));
    } catch {
      // Persistence is best-effort; keep the in-memory value regardless.
    }
    set({ micGain });
  },
  setRecording: (isRecording, recordingId) =>
    set((s) => ({
      isRecording,
      recordingId: recordingId !== undefined ? recordingId : s.recordingId,
    })),
  announce: (message) => set((s) => ({ announcement: message, announceSeq: s.announceSeq + 1 })),

  addPeer: (peerId, displayName) =>
    set((state) => {
      const peers = new Map(state.peers);
      peers.set(peerId, {
        peerId,
        displayName,
        isSpeaking: false,
        isMuted: false,
        volume: 1,
        isMusic: false,
      });
      return { peers };
    }),

  removePeer: (peerId) =>
    set((state) => {
      const peers = new Map(state.peers);
      peers.delete(peerId);
      return { peers };
    }),

  setPeerSpeaking: (peerId, speaking) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, isSpeaking: speaking });
      return { peers };
    }),

  setPeerMuted: (peerId, muted) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, isMuted: muted });
      return { peers };
    }),

  setPeerVolume: (peerId, volume) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, volume });
      return { peers };
    }),

  setPeerMusic: (peerId, isMusic) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, isMusic });
      return { peers };
    }),

  reset: () =>
    set({
      connected: false,
      roomName: null,
      displayName: null,
      localPeerId: null,
      mode: "p2p",
      isMuted: false,
      isDeafened: false,
      isPushToTalk: false,
      pttActive: false,
      isSharingAudio: false,
      isRecording: false,
      recordingId: null,
      announcement: "",
      announceSeq: 0,
      peers: new Map(),
    }),
}));
