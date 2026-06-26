import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  ScreenShare,
  ScreenShareOff,
  Download,
  FileArchive,
  FileMusic,
  Waves,
  Settings,
  MessageSquare,
} from "lucide-react";
import { useRoomStore } from "../stores/room";
import { DeviceSettings } from "./DeviceSettings";
import { m } from "../paraglide/messages.js";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
// jdh_record_dd-mm-aa-hh-mm-ss — the recording download filename.
function recordingStamp(ts: number | null): string {
  const d = ts ? new Date(ts) : new Date();
  return [
    pad2(d.getDate()),
    pad2(d.getMonth() + 1),
    pad2(d.getFullYear() % 100),
    pad2(d.getHours()),
    pad2(d.getMinutes()),
    pad2(d.getSeconds()),
  ].join("-");
}

interface AudioControlsProps {
  onToggleMute: () => void;
  onToggleAudioShare: () => void;
  // "Emitir audio": opens the source chooser when idle, stops the stream when one
  // is active (the floating player also offers play/pause + stop).
  onToggleFileStream: () => void;
  onToggleChat: () => void;
  chatOpen: boolean;
}

// The bottom control bar. Plain buttons (no ARIA toolbar / roving tabindex) so a
// screen reader reads each as a normal Tab stop under the "Controles de audio"
// heading, instead of announcing "barra de herramientas / fuera de barra de
// herramientas". Recording has no button — it's a keyboard shortcut (Alt+Shift+R)
// handled in Room; its download links appear here only while a recording exists.
export function AudioControls({
  onToggleMute,
  onToggleAudioShare,
  onToggleFileStream,
  onToggleChat,
  chatOpen,
}: AudioControlsProps) {
  const isMuted = useRoomStore((s) => s.isMuted);
  const hasMic = useRoomStore((s) => s.hasMic);
  const isSharingAudio = useRoomStore((s) => s.isSharingAudio);
  const isStreamingFile = useRoomStore((s) => s.fileStreamName != null);
  const recordingId = useRoomStore((s) => s.recordingId);
  const recordingStartedAt = useRoomStore((s) => s.recordingStartedAt);
  const voiceProcessingEnabled = useRoomStore((s) => s.voiceProcessingEnabled);
  const setVoiceProcessingEnabled = useRoomStore((s) => s.setVoiceProcessingEnabled);

  // The gear (device pickers) opens a popover above the bar.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (settingsOpen) settingsPanelRef.current?.querySelector("select")?.focus();
  }, [settingsOpen]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsBtnRef.current?.focus();
  }, []);

  const btn =
    "flex h-12 min-w-12 items-center justify-center gap-2 rounded-full px-3 transition-all";
  const idle = "bg-sonic-700 text-sonic-200 hover:bg-sonic-600";
  const active = "bg-sonic-accent text-white hover:bg-sonic-accent/90";

  return (
    <section
      aria-labelledby="controls-heading"
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && settingsOpen) {
          e.stopPropagation();
          closeSettings();
        }
      }}
    >
      <h2 id="controls-heading" className="sr-only">
        {m.controls_heading()}
      </h2>

      {/* Device pickers popover (mic/speaker). */}
      {settingsOpen && (
        <div
          ref={settingsPanelRef}
          className="absolute bottom-full left-1/2 z-10 mb-3 w-72 -translate-x-1/2 rounded-xl border border-sonic-600 bg-sonic-800 p-4 shadow-2xl"
          role="dialog"
          aria-label={m.settings_heading()}
        >
          <h3 className="mb-3 text-sm font-semibold text-sonic-100">{m.settings_heading()}</h3>
          <DeviceSettings />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-sonic-600 bg-sonic-800 p-3">
        {/* Mute */}
        <button
          onClick={hasMic ? onToggleMute : undefined}
          aria-disabled={!hasMic}
          className={`${btn} ${!hasMic ? "cursor-not-allowed bg-sonic-700 text-sonic-500" : isMuted ? "bg-muted/20 text-muted hover:bg-muted/30" : idle}`}
          aria-label={
            hasMic ? (isMuted ? m.controls_unmute() : m.controls_mute()) : m.controls_no_mic()
          }
          title={hasMic ? m.controls_mute_title() : m.controls_no_mic_title()}
        >
          {!hasMic || isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>

        {/* Share system/tab audio */}
        <button
          onClick={onToggleAudioShare}
          className={`${btn} ${isSharingAudio ? active : idle}`}
          aria-label={isSharingAudio ? m.controls_stop_share() : m.controls_share()}
          aria-pressed={isSharingAudio}
          title={isSharingAudio ? m.controls_stop_share_title() : m.controls_share_title()}
        >
          {isSharingAudio ? (
            <ScreenShareOff className="h-5 w-5" />
          ) : (
            <ScreenShare className="h-5 w-5" />
          )}
        </button>

        {/* Emit audio (file/URL/server) */}
        <button
          onClick={onToggleFileStream}
          className={`${btn} ${isStreamingFile ? active : idle}`}
          aria-label={isStreamingFile ? m.controls_stop_file() : m.controls_stream_file()}
          aria-pressed={isStreamingFile}
          title={isStreamingFile ? m.controls_stop_file_title() : m.controls_stream_file_title()}
        >
          <FileMusic className="h-5 w-5" />
        </button>

        {/* Noise-suppression toggle (echo cancel / noise / auto-gain). */}
        <button
          onClick={() => setVoiceProcessingEnabled(!voiceProcessingEnabled)}
          className={`${btn} ${voiceProcessingEnabled ? active : idle}`}
          aria-label={
            voiceProcessingEnabled
              ? m.controls_noise_suppression_disable()
              : m.controls_noise_suppression_enable()
          }
          aria-pressed={voiceProcessingEnabled}
          title={
            voiceProcessingEnabled
              ? m.controls_noise_suppression_on_title()
              : m.controls_noise_suppression_off_title()
          }
        >
          <Waves className="h-5 w-5" />
        </button>

        {/* Device settings (mic/speaker) */}
        <button
          ref={settingsBtnRef}
          onClick={() => setSettingsOpen((o) => !o)}
          className={`${btn} ${settingsOpen ? active : idle}`}
          aria-label={m.settings_open()}
          aria-expanded={settingsOpen}
          title={m.settings_open()}
        >
          <Settings className="h-5 w-5" />
        </button>

        {/* Chat */}
        <button
          onClick={onToggleChat}
          className={`${btn} ${chatOpen ? active : idle}`}
          aria-label={chatOpen ? m.room_chat_close() : m.room_chat_open()}
          aria-expanded={chatOpen}
          title={m.room_toggle_chat_title()}
        >
          <MessageSquare className="h-5 w-5" />
        </button>

        {/* Recording download links — only while a recording exists (started via
            the Alt+Shift+R shortcut). */}
        {recordingId && (
          <a
            href={`/api/recordings/${encodeURIComponent(recordingId)}/download`}
            download={`jdh_record_${recordingStamp(recordingStartedAt)}.ogg`}
            className={`${btn} ${idle}`}
            aria-label={m.controls_download_recording()}
            title={m.controls_download_title()}
          >
            <Download className="h-4 w-4" />
            <span className="text-sm font-medium">{m.controls_download()}</span>
          </a>
        )}
        {recordingId && (
          <a
            href={`/api/recordings/${encodeURIComponent(recordingId)}/tracks`}
            download={`jdh_record_${recordingStamp(recordingStartedAt)}-tracks.zip`}
            className={`${btn} ${idle}`}
            aria-label={m.controls_download_tracks_recording()}
            title={m.controls_download_tracks_title()}
          >
            <FileArchive className="h-4 w-4" />
            <span className="text-sm font-medium">{m.controls_download_tracks()}</span>
          </a>
        )}
      </div>
    </section>
  );
}
