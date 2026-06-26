import { create } from "zustand";
import type { ChatMessage } from "../lib/chat";
import { isIOS } from "../lib/microphone";
import { speak } from "../lib/tts";

// Keep the in-memory chat bounded; the server caps history too. Newest last.
const CHAT_MESSAGES_MAX = 200;

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

// Selected audio devices ("" = browser default). Per-device preferences like
// micGain: persisted, and carried from the lobby preview into the call.
const MIC_DEVICE_KEY = "sonicroom:micDeviceId";
const SPEAKER_DEVICE_KEY = "sonicroom:speakerDeviceId";
const VOICE_PROCESSING_KEY = "sonicroom:voiceProcessing";

function loadString(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function saveString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence is best-effort; keep the in-memory value regardless.
  }
}

function loadVoiceProcessing(): boolean {
  try {
    const value = localStorage.getItem(VOICE_PROCESSING_KEY);
    return value == null ? isIOS : value === "true";
  } catch {
    return isIOS;
  }
}

// Display name persisted across ALL sessions (set on first visit, changed via
// the "Change name" button). "" = not chosen yet, so the Room shows a one-time
// name prompt before joining.
const DISPLAY_NAME_KEY = "sonicroom:displayName";

export function loadStoredDisplayName(): string {
  return loadString(DISPLAY_NAME_KEY);
}

// How incoming/outgoing chat messages are spoken to the user. A persisted
// accessibility preference:
//  - "polite"    — announced on a polite ARIA live region (default; queues
//                  behind other screen-reader speech).
//  - "assertive" — announced on an assertive ARIA live region (interrupts).
//  - "tts"       — read aloud by the browser's speech synthesis, for users who
//                  do NOT run a screen reader (see lib/tts).
//  - "off"       — not announced at all (still shown in the chat list).
export type ChatAnnounceMode = "polite" | "assertive" | "tts" | "off";

const CHAT_ANNOUNCE_KEY = "sonicroom:chatAnnounceMode";

function loadChatAnnounceMode(): ChatAnnounceMode {
  const v = loadString(CHAT_ANNOUNCE_KEY);
  return v === "assertive" || v === "tts" || v === "off" ? v : "polite";
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
  // True only for an EXTERNAL music caster (Ecobox, source "music"), which
  // sends raw stereo and cannot duck itself — so listeners duck it. A browser
  // emitter's share/file producer is ducked at the source instead, so it is
  // NOT receiver-ducked (duckAtReceiver false) to avoid double-ducking.
  duckAtReceiver: boolean;
}

export type RoomMode = "p2p" | "sfu";

interface RoomState {
  // Connection
  connected: boolean;
  roomName: string | null;
  displayName: string | null;
  localPeerId: string | null;
  mode: RoomMode;

  // Whether we joined with a working microphone. False when the user opted out
  // ("Join without a microphone") or no mic was available / permission denied —
  // they listen and use text chat only. Gates the mute control + mic-level
  // slider and shows a "text only" indicator on their own card.
  hasMic: boolean;

  // Local controls
  isMuted: boolean;
  isDeafened: boolean;
  isPushToTalk: boolean;
  pttActive: boolean;
  // Room-wide auto-ducking toggle (default on). When off, no music-type stream
  // (caster/share/file) is ducked under voice. Synced from the server.
  duckingEnabled: boolean;
  isSharingAudio: boolean;
  // Local-file streaming (independent of the audio share): the name of the file
  // currently being streamed into the call (null = not streaming), and whether
  // it's playing or paused. Drives the floating file-player window and the
  // toolbar button. The actual <audio> element lives in the media hook.
  fileStreamName: string | null;
  fileStreamPlaying: boolean;
  // Outgoing (send-side) mic gain applied before the track reaches peers/SFU,
  // 0–MAX_MIC_GAIN. 1 = unity (raw mic). Lets a quiet/cheap mic be boosted for
  // everyone, independent of each listener's per-peer playback volume.
  micGain: number;
  // Selected input/output devices ("" = browser default). The lobby preview
  // and the in-call media graph both follow these (see DeviceSettings).
  micDeviceId: string;
  speakerDeviceId: string;
  // Browser voice processing (echo cancellation, noise suppression and
  // automatic gain). Defaults on for iOS/iPadOS and off elsewhere.
  voiceProcessingEnabled: boolean;

  // Recording (initiator-private). recordingStartedAt stamps the start time so
  // the download filename can carry it.
  isRecording: boolean;
  recordingId: string | null;
  recordingStartedAt: number | null;

  // Latest screen-reader announcement (peer join/leave, recording, etc.).
  // `announceSeq` changes on every announce() so React re-renders even when
  // the same message repeats.
  announcement: string;
  announceSeq: number;

  // Chat-message announcements are kept on their OWN channel, separate from the
  // general announcement above, so they can follow the user's chatAnnounceMode
  // (polite / assertive / spoken / off). `chatPoliteMsg` and `chatAssertiveMsg`
  // feed two always-mounted live regions of the matching politeness — only the
  // one for the active mode is filled. `chatAnnounceSeq` re-keys the region so
  // an identical repeated message is still re-announced. (TTS mode speaks via
  // the browser and leaves both region strings empty.)
  chatAnnounceMode: ChatAnnounceMode;
  chatPoliteMsg: string;
  chatAssertiveMsg: string;
  chatAnnounceSeq: number;

  // Peers
  peers: Map<string, PeerState>;

  // Chat messages in arrival order (newest last). Seeded with room history on
  // join, then appended as `chat-message` events arrive (including our own).
  messages: ChatMessage[];

  // Actions
  setConnected: (connected: boolean) => void;
  setRoom: (roomName: string, displayName: string, localPeerId: string) => void;
  // Persist + apply a new display name (first-time set or the "Change name" button).
  setDisplayName: (displayName: string) => void;
  setMode: (mode: RoomMode) => void;
  setHasMic: (hasMic: boolean) => void;
  setMuted: (muted: boolean) => void;
  setDeafened: (deafened: boolean) => void;
  setPttActive: (active: boolean) => void;
  togglePushToTalk: () => void;
  setDuckingEnabled: (enabled: boolean) => void;
  setSharingAudio: (sharing: boolean) => void;
  setFileStream: (name: string | null) => void;
  setFileStreamPlaying: (playing: boolean) => void;
  setMicGain: (gain: number) => void;
  setMicDeviceId: (deviceId: string) => void;
  setSpeakerDeviceId: (deviceId: string) => void;
  setVoiceProcessingEnabled: (enabled: boolean) => void;
  setRecording: (recording: boolean, recordingId?: string | null) => void;
  announce: (message: string) => void;
  announceEvent: (message: string) => void;
  setChatAnnounceMode: (mode: ChatAnnounceMode) => void;
  // Announce a chat message via whichever channel chatAnnounceMode selects.
  announceChat: (message: string) => void;
  addMessage: (message: ChatMessage) => void;
  addPeer: (peerId: string, displayName: string) => void;
  removePeer: (peerId: string) => void;
  setPeerSpeaking: (peerId: string, speaking: boolean) => void;
  setPeerMuted: (peerId: string, muted: boolean) => void;
  setPeerName: (peerId: string, displayName: string) => void;
  setPeerVolume: (peerId: string, volume: number) => void;
  setPeerMusic: (peerId: string, isMusic: boolean) => void;
  setPeerDuckAtReceiver: (peerId: string, value: boolean) => void;
  reset: () => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  connected: false,
  roomName: null,
  displayName: null,
  localPeerId: null,
  mode: "p2p",
  hasMic: true,
  isMuted: false,
  isDeafened: false,
  isPushToTalk: false,
  pttActive: false,
  duckingEnabled: true,
  isSharingAudio: false,
  fileStreamName: null,
  fileStreamPlaying: false,
  micGain: loadMicGain(),
  micDeviceId: loadString(MIC_DEVICE_KEY),
  speakerDeviceId: loadString(SPEAKER_DEVICE_KEY),
  voiceProcessingEnabled: loadVoiceProcessing(),
  isRecording: false,
  recordingId: null,
  recordingStartedAt: null,
  announcement: "",
  announceSeq: 0,
  chatAnnounceMode: loadChatAnnounceMode(),
  chatPoliteMsg: "",
  chatAssertiveMsg: "",
  chatAnnounceSeq: 0,
  peers: new Map(),
  messages: [],

  setConnected: (connected) => set({ connected }),
  setRoom: (roomName, displayName, localPeerId) => set({ roomName, displayName, localPeerId }),
  setDisplayName: (displayName) => {
    saveString(DISPLAY_NAME_KEY, displayName);
    set({ displayName });
  },
  setMode: (mode) => set({ mode }),
  setHasMic: (hasMic) => set({ hasMic }),
  setMuted: (isMuted) => set({ isMuted }),
  setDeafened: (isDeafened) => set({ isDeafened }),
  setPttActive: (pttActive) => set({ pttActive }),
  togglePushToTalk: () => set((s) => ({ isPushToTalk: !s.isPushToTalk })),
  setDuckingEnabled: (duckingEnabled) => set({ duckingEnabled }),
  setSharingAudio: (isSharingAudio) => set({ isSharingAudio }),
  setFileStream: (fileStreamName) => set({ fileStreamName }),
  setFileStreamPlaying: (fileStreamPlaying) => set({ fileStreamPlaying }),
  setMicGain: (micGain) => {
    try {
      localStorage.setItem(MIC_GAIN_KEY, String(micGain));
    } catch {
      // Persistence is best-effort; keep the in-memory value regardless.
    }
    set({ micGain });
  },
  setMicDeviceId: (micDeviceId) => {
    saveString(MIC_DEVICE_KEY, micDeviceId);
    set({ micDeviceId });
  },
  setSpeakerDeviceId: (speakerDeviceId) => {
    saveString(SPEAKER_DEVICE_KEY, speakerDeviceId);
    set({ speakerDeviceId });
  },
  setVoiceProcessingEnabled: (voiceProcessingEnabled) => {
    saveString(VOICE_PROCESSING_KEY, String(voiceProcessingEnabled));
    set({ voiceProcessingEnabled });
  },
  setRecording: (isRecording, recordingId) =>
    set((s) => ({
      isRecording,
      recordingId: recordingId !== undefined ? recordingId : s.recordingId,
      // Stamp the start time (for the download filename); clear it when the
      // recording is dropped (recordingId explicitly null, e.g. expired).
      recordingStartedAt: isRecording
        ? (s.recordingStartedAt ?? Date.now())
        : recordingId === null
          ? null
          : s.recordingStartedAt,
    })),
  announce: (message) => set((s) => ({ announcement: message, announceSeq: s.announceSeq + 1 })),

  // Room-event announcement (recording/share/music/mute…): speak it AND log it
  // into the chat history as a "system" entry, so chat is the single timeline
  // of everything that was ever announced (rule: announcements go to chat).
  // Bare announce() stays reserved for re-reading chat content that is already
  // in history (incoming messages, the Alt+number readback).
  announceEvent: (message) =>
    set((s) => {
      const ts = Date.now();
      const messages = [
        ...s.messages,
        {
          id: `sys-evt-${ts}-${s.announceSeq + 1}`,
          sender: "",
          text: message,
          ts,
          kind: "system" as const,
        },
      ];
      if (messages.length > CHAT_MESSAGES_MAX)
        messages.splice(0, messages.length - CHAT_MESSAGES_MAX);
      return { announcement: message, announceSeq: s.announceSeq + 1, messages };
    }),

  setChatAnnounceMode: (mode) => {
    saveString(CHAT_ANNOUNCE_KEY, mode);
    set({ chatAnnounceMode: mode });
  },

  // Route a chat-message announcement to the channel the user chose. Each call
  // bumps chatAnnounceSeq so the live-region <span> re-keys (re-announcing an
  // identical repeated line), and fills exactly one of the two region strings
  // (clearing the other) — or, in TTS mode, speaks it and leaves both empty.
  // "off" announces nothing (the message is still rendered + chimed elsewhere).
  announceChat: (message) => {
    const s = get();
    const chatAnnounceSeq = s.chatAnnounceSeq + 1;
    switch (s.chatAnnounceMode) {
      case "off":
        set({ chatAnnounceSeq });
        return;
      case "tts":
        speak(message, "es");
        set({ chatAnnounceSeq, chatPoliteMsg: "", chatAssertiveMsg: "" });
        return;
      case "assertive":
        set({ chatAnnounceSeq, chatAssertiveMsg: message, chatPoliteMsg: "" });
        return;
      case "polite":
      default:
        set({ chatAnnounceSeq, chatPoliteMsg: message, chatAssertiveMsg: "" });
        return;
    }
  },

  addMessage: (message) =>
    set((s) => {
      // De-dupe: the sender receives its own message via the room broadcast,
      // and join history may overlap with an in-flight message.
      if (s.messages.some((m) => m.id === message.id)) return s;
      const messages = [...s.messages, message];
      if (messages.length > CHAT_MESSAGES_MAX)
        messages.splice(0, messages.length - CHAT_MESSAGES_MAX);
      return { messages };
    }),

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
        duckAtReceiver: false,
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

  setPeerName: (peerId, displayName) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, displayName });
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

  setPeerDuckAtReceiver: (peerId, value) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, duckAtReceiver: value });
      return { peers };
    }),

  reset: () =>
    set({
      connected: false,
      roomName: null,
      displayName: null,
      localPeerId: null,
      mode: "p2p",
      hasMic: true,
      isMuted: false,
      isDeafened: false,
      isPushToTalk: false,
      pttActive: false,
      duckingEnabled: true,
      isSharingAudio: false,
      fileStreamName: null,
      fileStreamPlaying: false,
      isRecording: false,
      recordingId: null,
      recordingStartedAt: null,
      announcement: "",
      announceSeq: 0,
      // Keep chatAnnounceMode (a persisted preference); only the live strings reset.
      chatPoliteMsg: "",
      chatAssertiveMsg: "",
      chatAnnounceSeq: 0,
      peers: new Map(),
      messages: [],
    }),
}));
