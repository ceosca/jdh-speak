import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  ScreenShare,
  ScreenShareOff,
  Download,
  FileArchive,
  FileMusic,
  Library,
  Link,
  Tv,
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
  // Opens (or closes) the virtual player — the home of local files/folders.
  onOpenPlayer: () => void;
  // Whether the player window is currently showing (for the button's pressed state).
  playerOpen: boolean;
  // Opens the "Abrir URL" dialog (mp3 / m3u8 / radio …).
  onOpenUrl: () => void;
  // Opens the live-TV channel picker.
  onOpenTv: () => void;
  // Opens the audio-series catalog (Serieteca).
  onOpenSerieteca: () => void;
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
  onOpenPlayer,
  playerOpen,
  onOpenUrl,
  onOpenTv,
  onOpenSerieteca,
  onToggleChat,
  chatOpen,
}: AudioControlsProps) {
  const isMuted = useRoomStore((s) => s.isMuted);
  const hasMic = useRoomStore((s) => s.hasMic);
  const isSharingAudio = useRoomStore((s) => s.isSharingAudio);
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

  // Every control now shows an ICON + a short visible LABEL stacked (mobile-app
  // pattern) so a sighted first-timer reads what it does without being told. The
  // aria-label (unchanged, longer/descriptive) still governs the screen reader —
  // the visible label is aria-hidden, so there is no double-read and no regression.
  const btn =
    "flex min-w-[68px] flex-col items-center justify-center gap-1 rounded-xl px-3 py-2 text-[11px] font-medium leading-tight transition-all";
  const idle = "bg-sonic-700 text-sonic-200 hover:bg-sonic-600";
  const active = "bg-sonic-accent text-white hover:bg-sonic-accent/90";
  const danger = "bg-red-600 text-white hover:bg-red-500"; // muted mic (universal red)
  const lbl = "whitespace-nowrap"; // the visible text under each icon
  const divider = (
    <div aria-hidden="true" className="mx-0.5 hidden h-10 w-px self-center bg-sonic-600 sm:block" />
  );

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

      <div className="flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-sonic-600 bg-sonic-800 p-3">
        {/* ── Grupo: TU VOZ (mute + supresión de ruido) ── */}
        {/* Mute — muted state is UNMISTAKABLE: red button + MicOff icon + "Activar
            audio" (the universal video-call convention), not colour alone. */}
        <button
          onClick={hasMic ? onToggleMute : undefined}
          aria-disabled={!hasMic}
          className={`${btn} ${!hasMic ? "cursor-not-allowed bg-sonic-700 text-sonic-500" : isMuted ? danger : idle}`}
          aria-label={
            hasMic ? (isMuted ? m.controls_unmute() : m.controls_mute()) : m.controls_no_mic()
          }
          title={hasMic ? m.controls_mute_title() : m.controls_no_mic_title()}
        >
          {!hasMic || isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          <span aria-hidden="true" className={lbl}>
            {!hasMic
              ? m.controls_no_mic_short()
              : isMuted
                ? m.controls_unmute_short()
                : m.controls_mute_short()}
          </span>
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
          <span aria-hidden="true" className={lbl}>
            {m.controls_noise_short()}
          </span>
        </button>

        {divider}

        {/* ── Grupo: REPRODUCIR EN LA SALA ── */}
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
          <span aria-hidden="true" className={lbl}>
            {isSharingAudio ? m.controls_stop_share_short() : m.controls_share_short()}
          </span>
        </button>

        {/* Open the virtual player (local files / folders live there) */}
        <button
          onClick={onOpenPlayer}
          className={`${btn} ${playerOpen ? active : idle}`}
          aria-label={m.controls_open_player()}
          aria-pressed={playerOpen}
          title={m.controls_open_player_title()}
        >
          <FileMusic className="h-5 w-5" />
          <span aria-hidden="true" className={lbl}>
            {m.controls_player_short()}
          </span>
        </button>

        {/* Open a URL (mp3 / m3u8 / radio …) */}
        <button
          onClick={onOpenUrl}
          className={`${btn} ${idle}`}
          aria-label={m.controls_open_url()}
          title={m.controls_open_url_title()}
        >
          <Link className="h-5 w-5" />
          <span aria-hidden="true" className={lbl}>
            {m.controls_url_short()}
          </span>
        </button>

        {/* Live TV channels */}
        <button
          onClick={onOpenTv}
          className={`${btn} ${idle}`}
          aria-label={m.controls_tv()}
          title={m.controls_tv_title()}
        >
          <Tv className="h-5 w-5" />
          <span aria-hidden="true" className={lbl}>
            {m.controls_tv_short()}
          </span>
        </button>

        {/* Audio-series catalog (Serieteca) */}
        <button
          onClick={onOpenSerieteca}
          className={`${btn} ${idle}`}
          aria-label={m.controls_serieteca()}
          title={m.controls_serieteca_title()}
        >
          <Library className="h-5 w-5" />
          <span aria-hidden="true" className={lbl}>
            {m.controls_serieteca_short()}
          </span>
        </button>

        {divider}

        {/* ── Grupo: SALA (chat + ajustes) ── */}
        {/* Chat */}
        <button
          onClick={onToggleChat}
          className={`${btn} ${chatOpen ? active : idle}`}
          aria-label={chatOpen ? m.room_chat_close() : m.room_chat_open()}
          aria-expanded={chatOpen}
          title={m.room_toggle_chat_title()}
        >
          <MessageSquare className="h-5 w-5" />
          <span aria-hidden="true" className={lbl}>
            {m.controls_chat_short()}
          </span>
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
          <span aria-hidden="true" className={lbl}>
            {m.controls_settings_short()}
          </span>
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
