import { useEffect, useCallback, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { Headphones, Users, Loader2, Circle } from "lucide-react";
import { useRoomStore, loadStoredDisplayName } from "../stores/room";
import { useMediasoup } from "../hooks/useMediasoup";
import { formatMessage, messageContent } from "../lib/chat";
import { getInstanceName } from "../lib/branding";
import { ParticipantCard } from "./ParticipantCard";
import { AudioControls } from "./AudioControls";
import { FileStreamPlayer } from "./FileStreamPlayer";
import { UrlDialog } from "./UrlDialog";
import { Chat } from "./Chat";
import { pickFolderAudioFiles } from "../lib/audioFolder";
import { m } from "../paraglide/messages.js";

type JoinState = "idle" | "joining" | "joined" | "error";

// The main room joined at the base domain "/". Any "/<roomName>" joins that room.
const DEFAULT_ROOM = "jdh";

// Max gap between two Alt+<same number> presses for the second to count as a
// "copy that message" double-press rather than a fresh readback.
const DOUBLE_PRESS_MS = 600;

function isP2pDisabled(value: string | null): boolean {
  if (value == null) return false;
  const v = value.toLowerCase();
  return ["off", "false", "0", "no", "disable", "disabled"].includes(v);
}

function isMicDisabled(value: string | null): boolean {
  if (value == null) return false;
  const v = value.toLowerCase();
  return ["off", "false", "0", "no", "disable", "disabled"].includes(v);
}

function sanitizeName(input: string): string {
  return input
    .replace(/[<>"'&]/g, "")
    .trim()
    .slice(0, 256);
}

// When embedded in an iframe (e.g. jitchat), mirror room lifecycle events to the
// host page via postMessage so it can play sounds / reset its view.
function postToHost(type: string, payload?: Record<string, unknown>) {
  if (typeof window !== "undefined" && window.parent !== window) {
    window.parent.postMessage({ source: "jdh-speak", type, ...payload }, "*");
  }
}

export function Room() {
  const params = useParams<{ roomName: string }>();
  const roomName = params.roomName || DEFAULT_ROOM;
  const [searchParams] = useSearchParams();
  const p2pStorageKey = `jdh-speak:p2p-off:${roomName}`;
  const disableP2p =
    isP2pDisabled(searchParams.get("p2p")) ||
    sessionStorage.getItem(p2pStorageKey) === "1";
  const noMic = isMicDisabled(searchParams.get("mic"));
  const navigate = useNavigate();
  const {
    join,
    toggleMute,
    toggleAudioShare,
    startPlaylist,
    startFolderStream,
    startUrlStream,
    stopFileStream,
    playTrack,
    playerNext,
    playerPrev,
    playerTogglePlay,
    playerSeekBy,
    playerSeekTo,
    setPlayerRate,
    setPlayerVolume,
    toggleRecording,
    rename,
    cycleRoomBitrate,
    setPeerVolume,
    setMicGain,
    sendChatMessage,
  } = useMediasoup();

  const [joinState, setJoinState] = useState<JoinState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  // Name prompt: shown once on first ever visit (no stored name), and reopened
  // by the "Change name" button under your own card.
  const [namePromptOpen, setNamePromptOpen] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const joinedRef = useRef(false);
  const knownPeersRef = useRef<Set<string>>(new Set());
  const lastAltNumRef = useRef<{ digit: string; at: number } | null>(null);

  const closeChat = useCallback(() => setChatOpen(false), []);

  // "Abrir archivos": hidden multi-file picker (no upload-confirmation dialog,
  // that only happens for directories). One or many files → a playlist, ordered
  // by name. Opening this while playing does NOT stop the current track — it
  // cross-fades to the new selection (startPlaylist → playTrack).
  const filesInputRef = useRef<HTMLInputElement>(null);
  const openFiles = useCallback(() => {
    filesInputRef.current?.click();
  }, []);
  const onFilesChosen = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []).sort((a, b) => a.name.localeCompare(b.name));
      e.target.value = "";
      if (files.length > 0) void startPlaylist(files);
    },
    [startPlaylist],
  );

  // "Abrir carpeta": prefer the File System Access API (showDirectoryPicker) —
  // it recurses into subfolders and skips Chrome's "Upload N files?" prompt.
  // Falls back to the <input webkitdirectory> picker when the API is missing.
  // Also non-stopping: it cross-fades to the new folder.
  const folderInputRef = useRef<HTMLInputElement>(null);
  const openFolder = useCallback(async () => {
    let files: File[] | null;
    try {
      files = await pickFolderAudioFiles();
    } catch (err) {
      console.error("[folder] picker failed:", err);
      return;
    }
    if (files === null) {
      // API unavailable → fall back to the directory input.
      folderInputRef.current?.click();
      return;
    }
    if (files.length > 0) void startPlaylist(files); // [] = cancelled → do nothing
  }, [startPlaylist]);
  const onFolderChosen = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      if (files.length > 0) void startFolderStream(files);
    },
    [startFolderStream],
  );
  // Close the virtual player: stop any stream and hide the window.
  const closePlayer = useCallback(() => {
    void stopFileStream();
    setPlayerOpen(false);
  }, [stopFileStream]);
  // Toggle the player from the controls: if it's showing (open or streaming),
  // close it; otherwise open it (idle, ready for Open files / Open folder).
  const openPlayer = useCallback(() => {
    if (playerOpen || useRoomStore.getState().fileStreamName != null) closePlayer();
    else setPlayerOpen(true);
  }, [playerOpen, closePlayer]);
  const openUrl = useCallback(() => setUrlOpen(true), []);

  const localPeerId = useRoomStore((s) => s.localPeerId);
  const displayName = useRoomStore((s) => s.displayName);
  const peers = useRoomStore((s) => s.peers);
  const isMuted = useRoomStore((s) => s.isMuted);
  const hasMic = useRoomStore((s) => s.hasMic);
  const micGain = useRoomStore((s) => s.micGain);
  const micMonitor = useRoomStore((s) => s.micMonitor);
  const setMicMonitor = useRoomStore((s) => s.setMicMonitor);
  const mode = useRoomStore((s) => s.mode);
  const isRecording = useRoomStore((s) => s.isRecording);
  const fileStreamName = useRoomStore((s) => s.fileStreamName);
  const fileStreamPlaying = useRoomStore((s) => s.fileStreamPlaying);
  const playlist = useRoomStore((s) => s.playlist);
  const playlistIndex = useRoomStore((s) => s.playlistIndex);
  const playerRepeat = useRoomStore((s) => s.playerRepeat);
  const playerShuffle = useRoomStore((s) => s.playerShuffle);
  const playerRate = useRoomStore((s) => s.playerRate);
  const announcement = useRoomStore((s) => s.announcement);
  const announceSeq = useRoomStore((s) => s.announceSeq);
  const chatPoliteMsg = useRoomStore((s) => s.chatPoliteMsg);
  const chatAssertiveMsg = useRoomStore((s) => s.chatAssertiveMsg);
  const chatAnnounceSeq = useRoomStore((s) => s.chatAnnounceSeq);

  useEffect(() => {
    const instance = getInstanceName();
    document.title = `${roomName} · ${instance}`;
    return () => {
      document.title = instance;
    };
  }, [roomName]);

  // Actually join the room with the given name. Idempotent via joinedRef.
  const doJoin = useCallback(
    (name: string) => {
      if (joinedRef.current) return;
      joinedRef.current = true;
      setJoinState("joining");
      if (disableP2p) sessionStorage.setItem(p2pStorageKey, "1");
      join(roomName, name, { disableP2p, noMic })
        .then(() => setJoinState("joined"))
        .catch((err) => {
          setJoinState("error");
          const msg = err instanceof Error ? err.message : "";
          setErrorMsg(msg || m.room_failed_to_join());
        });
    },
    [roomName, join, disableP2p, noMic, p2pStorageKey],
  );

  // On mount: join immediately if we already have a name (from ?displayName= or
  // the persisted one); otherwise show the one-time name prompt and wait.
  useEffect(() => {
    if (joinedRef.current) return;
    const fromQuery = sanitizeName(searchParams.get("displayName") ?? "");
    const name = fromQuery || loadStoredDisplayName();
    if (name) {
      useRoomStore.getState().setDisplayName(name);
      doJoin(name);
    } else {
      setNameInput("");
      setNamePromptOpen(true);
    }
  }, [doJoin, searchParams]);

  // Confirm the name prompt: persist the name, then join (first time) or rename
  // live (already in the room).
  const submitName = useCallback(() => {
    const name = sanitizeName(nameInput);
    if (!name) return;
    useRoomStore.getState().setDisplayName(name);
    setNamePromptOpen(false);
    if (joinedRef.current) void rename(name);
    else doJoin(name);
  }, [nameInput, rename, doJoin]);

  const openChangeName = useCallback(() => {
    setNameInput(useRoomStore.getState().displayName ?? "");
    setNamePromptOpen(true);
  }, []);

  useEffect(() => {
    if (joinState === "joined") postToHost("videoConferenceJoined");
  }, [joinState]);

  useEffect(() => {
    if (joinState !== "joined") return;
    const known = knownPeersRef.current;
    const current = new Set(peers.keys());
    for (const id of current) {
      if (!known.has(id)) postToHost("participantJoined", { peerId: id });
    }
    for (const id of known) {
      if (!current.has(id)) postToHost("participantLeft", { peerId: id });
    }
    knownPeersRef.current = current;
  }, [peers, joinState]);

  // Keyboard shortcuts
  useEffect(() => {
    if (joinState !== "joined") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Alt+1..9 / Alt+0 read back the last 10 chat messages (double-press copies).
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const digit =
          /^(?:Digit|Numpad)([0-9])$/.exec(e.code)?.[1] ?? (/^[0-9]$/.test(e.key) ? e.key : null);
        if (digit != null) {
          e.preventDefault();
          const n = digit === "0" ? 10 : Number(digit);
          const { messages: msgs, announce } = useRoomStore.getState();
          const msg = msgs[msgs.length - n];
          const now = Date.now();
          const prev = lastAltNumRef.current;
          if (msg && prev && prev.digit === digit && now - prev.at < DOUBLE_PRESS_MS) {
            lastAltNumRef.current = null;
            void navigator.clipboard
              ?.writeText(messageContent(msg))
              .then(() => announce(m.chat_copied()));
            return;
          }
          lastAltNumRef.current = { digit, at: now };
          announce(msg ? formatMessage(msg, now) : m.room_no_message({ n }));
          return;
        }
      }

      // Recording toggle: deliberate Alt+Shift+R (works regardless of focus).
      if (e.altKey && e.shiftKey && (e.code === "KeyR" || e.key === "r" || e.key === "R")) {
        e.preventDefault();
        void toggleRecording();
        return;
      }

      // Room quality (bitrate) cycle: deliberate Alt+Ctrl+C (no UI, room-wide).
      if (e.altKey && e.ctrlKey && (e.code === "KeyC" || e.key === "c" || e.key === "C")) {
        e.preventDefault();
        cycleRoomBitrate();
        return;
      }

      // Player focus: Ctrl+Alt+P moves keyboard focus to the player container.
      if (e.altKey && e.ctrlKey && (e.code === "KeyP" || e.key === "p" || e.key === "P")) {
        e.preventDefault();
        if (useRoomStore.getState().fileStreamName != null) {
          document.getElementById("conference-player")?.focus();
        } else {
          useRoomStore.getState().announce(m.player_nothing_playing());
        }
        return;
      }

      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleMute();
      } else if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        toggleAudioShare();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        setPlayerOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [joinState, toggleMute, toggleAudioShare, toggleRecording, cycleRoomBitrate]);

  // Name prompt overlay (first visit or "Change name"). Rendered above whatever
  // is behind it; on first visit nothing is behind yet.
  const namePrompt = namePromptOpen ? (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-sonic-900/80 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitName();
        }}
        className="w-full max-w-sm rounded-2xl border border-sonic-600 bg-sonic-800 p-6 shadow-2xl"
        role="dialog"
        aria-labelledby="name-prompt-title"
      >
        <h2 id="name-prompt-title" className="mb-4 text-lg font-semibold text-sonic-100">
          {m.name_prompt_title()}
        </h2>
        <label htmlFor="name-prompt-input" className="mb-1.5 block text-sm text-sonic-200">
          {m.name_prompt_label()}
        </label>
        <input
          id="name-prompt-input"
          type="text"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          placeholder={m.name_prompt_placeholder()}
          maxLength={256}
          autoFocus
          autoComplete="off"
          className="mb-4 w-full rounded-lg border border-sonic-600 bg-sonic-700 px-4 py-2.5 text-sonic-100 placeholder-sonic-400 focus:border-sonic-accent focus:outline-none"
        />
        <button
          type="submit"
          className="w-full rounded-lg bg-sonic-accent px-4 py-2.5 font-medium text-white hover:bg-sonic-accent/90"
        >
          {joinedRef.current ? m.name_prompt_save() : m.name_prompt_confirm()}
        </button>
      </form>
    </div>
  ) : null;

  // Loading state
  if (joinState === "joining") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-sonic-900">
        <div className="flex max-w-sm flex-col items-center gap-4 px-4 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-sonic-accent" />
          <p className="text-sonic-300" role="alert" aria-live="assertive" aria-atomic="true">
            {m.room_connecting()}
          </p>
        </div>
      </div>
    );
  }

  // Error state
  if (joinState === "error") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-sonic-900">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-lg text-muted">{errorMsg}</p>
          <button
            onClick={() => {
              joinedRef.current = false;
              navigate(0);
            }}
            className="rounded-lg bg-sonic-accent px-4 py-2 text-sm text-white hover:bg-sonic-accent/90"
          >
            {m.room_back_to_lobby()}
          </button>
        </div>
      </div>
    );
  }

  // Before joining (waiting for the first-visit name), show only the prompt.
  if (joinState === "idle") {
    return <div className="min-h-dvh bg-sonic-900">{namePrompt}</div>;
  }

  const peerList = Array.from(peers.values());

  return (
    <div className="flex min-h-dvh flex-col bg-sonic-900">
      {/* Slim header: room name + live mode + participant count. */}
      <header className="flex items-center justify-between border-b border-sonic-700 px-6 py-3">
        <div className="flex items-center gap-3">
          <Headphones aria-hidden="true" className="h-5 w-5 text-sonic-accent" />
          <h1 className="text-lg font-semibold text-sonic-100">{roomName}</h1>
        </div>
        <div className="flex items-center gap-3 text-sm text-sonic-300">
          {isRecording && (
            <span
              className="flex items-center gap-1.5 rounded bg-red-500/20 px-1.5 py-0.5 text-xs font-medium text-red-400"
              title={m.room_recording_title()}
            >
              <Circle aria-hidden="true" className="h-2.5 w-2.5 animate-pulse fill-red-500 text-red-500" />
              REC
            </span>
          )}
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-medium ${
              mode === "p2p" ? "bg-green-500/20 text-green-400" : "bg-blue-500/20 text-blue-400"
            }`}
          >
            {mode === "p2p" ? "P2P" : "SFU"}
          </span>
          <div className="flex items-center gap-1">
            <Users aria-hidden="true" className="h-4 w-4" />
            <span>{peerList.length + 1}</span>
          </div>
        </div>
      </header>

      {/* Participants (top) + optional chat side panel. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <section aria-labelledby="participants-heading" className="mx-auto max-w-4xl">
            <h2
              id="participants-heading"
              className="mb-4 text-sm font-semibold uppercase tracking-wide text-sonic-400"
            >
              {m.room_participants_heading()}
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
              {localPeerId && displayName && (
                <ParticipantCard
                  peer={{
                    peerId: localPeerId,
                    displayName,
                    isSpeaking: false,
                    isMuted,
                    volume: 1,
                    isMusic: false,
                  }}
                  isLocal
                  textOnly={!hasMic}
                  micGain={micGain}
                  onMicGainChange={hasMic ? setMicGain : undefined}
                  onChangeName={openChangeName}
                  micMonitor={micMonitor}
                  onToggleMicMonitor={hasMic ? () => setMicMonitor(!micMonitor) : undefined}
                />
              )}
              {peerList.map((peer) => (
                <ParticipantCard
                  key={peer.peerId}
                  peer={peer}
                  isLocal={false}
                  onVolumeChange={(v) => setPeerVolume(peer.peerId, v)}
                />
              ))}
            </div>
          </section>
        </main>

        {chatOpen && <Chat onSend={sendChatMessage} onClose={closeChat} />}
      </div>

      {/* Bottom control bar. */}
      <footer className="border-t border-sonic-700 p-4">
        <div className="mx-auto max-w-4xl">
          <AudioControls
            onToggleMute={toggleMute}
            onToggleAudioShare={toggleAudioShare}
            onOpenPlayer={openPlayer}
            playerOpen={playerOpen || fileStreamName != null}
            onOpenUrl={openUrl}
            onToggleChat={() => setChatOpen((o) => !o)}
            chatOpen={chatOpen}
          />
        </div>
      </footer>

      {/* Screen-reader event log (peer join/leave, recording, etc.), at the very
          bottom as before. */}
      <div aria-live="polite" role="status" className="sr-only" id="sr-announcements">
        <span key={announceSeq}>{announcement}</span>
      </div>
      <div aria-live="polite" role="status" className="sr-only" id="sr-chat-polite">
        <span key={`cp-${chatAnnounceSeq}`}>{chatPoliteMsg}</span>
      </div>
      <div aria-live="assertive" role="alert" className="sr-only" id="sr-chat-assertive">
        <span key={`ca-${chatAnnounceSeq}`}>{chatAssertiveMsg}</span>
      </div>

      {urlOpen && <UrlDialog onClose={() => setUrlOpen(false)} onStartUrl={startUrlStream} />}

      <input
        ref={filesInputRef}
        type="file"
        accept="audio/*"
        multiple
        onChange={onFilesChosen}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
      <input
        ref={folderInputRef}
        type="file"
        // webkitdirectory enables folder selection in all major browsers.
        // The attribute is non-standard but widely supported; cast to satisfy TS.
        {...({ webkitdirectory: "", multiple: true } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={onFolderChosen}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      {(playerOpen || fileStreamName) && (
        <FileStreamPlayer
          name={fileStreamName}
          playing={fileStreamPlaying}
          onTogglePlay={playerTogglePlay}
          onClose={closePlayer}
          onVolumeChange={setPlayerVolume}
          onSeekBy={playerSeekBy}
          onSeekTo={playerSeekTo}
          playlist={playlist}
          playlistIndex={playlistIndex}
          playerRepeat={playerRepeat}
          playerShuffle={playerShuffle}
          onPlayTrack={playTrack}
          onNext={playerNext}
          onPrev={playerPrev}
          onSetRepeat={(r) => useRoomStore.getState().setPlayerRepeat(r)}
          onToggleShuffle={() =>
            useRoomStore.getState().setPlayerShuffle(!useRoomStore.getState().playerShuffle)
          }
          playerRate={playerRate}
          onSetRate={setPlayerRate}
          onOpenFiles={openFiles}
          onOpenFolder={() => void openFolder()}
        />
      )}

      {namePrompt}
    </div>
  );
}
