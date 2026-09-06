import { useCallback } from "react";
import { Mic, Volume2, Music, UserPen } from "lucide-react";
import type { PeerState } from "../stores/room";
import { m } from "../paraglide/messages.js";

interface ParticipantCardProps {
  peer: PeerState;
  isLocal: boolean;
  onVolumeChange?: (volume: number) => void;
  // Local card only: you joined without a microphone (listen + text chat only).
  textOnly?: boolean;
  // Local card only: your outgoing mic gain (send-side), and its setter.
  micGain?: number;
  onMicGainChange?: (gain: number) => void;
  // Local card only: open the "change name" prompt.
  onChangeName?: () => void;
  // Local card only: monitor your own primary mic locally (hear yourself).
  micMonitor?: boolean;
  onToggleMicMonitor?: () => void;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// One participant. Accessibility model (screen-reader first):
//  - The mic status is read RIGHT NEXT TO the name as one phrase, e.g.
//    "Eedutú, micrófono activado" — so navigating to a participant says it all.
//  - The avatar and the status icon are decorative (aria-hidden) so the reader
//    never says "gráfico" or a duplicated "Activado".
//  - The volume slider's label is ONLY "Volumen de <name>" (no on/off — that's
//    already next to the name above).
export function ParticipantCard({
  peer,
  isLocal,
  onVolumeChange,
  textOnly,
  micGain,
  onMicGainChange,
  onChangeName,
  micMonitor,
  onToggleMicMonitor,
}: ParticipantCardProps) {
  const handleVolume = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onVolumeChange?.(parseFloat(e.target.value));
    },
    [onVolumeChange],
  );

  const handleMicGain = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onMicGainChange?.(parseFloat(e.target.value));
    },
    [onMicGainChange],
  );

  const micStatus = peer.isMusic
    ? m.card_music_stream()
    : textOnly
      ? m.card_text_only_status()
      : peer.isMuted
        ? m.card_mic_off()
        : m.card_mic_on();

  const nameWithYou = isLocal ? `${peer.displayName} (${m.card_you()})` : peer.displayName;

  // "Talking now" indicator: VISUAL ONLY (everything below is aria-hidden), so it
  // never floods the screen reader — the SR already reads mute status by the name.
  // Not shown for a muted peer or a music stream (their level isn't "talking").
  const speaking = peer.isSpeaking && !peer.isMusic && !peer.isMuted;

  return (
    <div
      className={`flex flex-col items-center gap-2 rounded-xl border bg-sonic-800 p-4 transition-colors ${
        speaking ? "border-green-400/80 ring-2 ring-green-400/40" : "border-sonic-600"
      }`}
    >
      {/* Decorative avatar — hidden from the screen reader. Green glowing ring while
          this person is talking (universal video-call cue). */}
      <div
        aria-hidden="true"
        className={`flex h-14 w-14 items-center justify-center rounded-full text-lg font-bold transition-all ${
          speaking
            ? "border-2 border-green-400 bg-sonic-700 text-green-100 shadow-[0_0_14px_rgba(74,222,128,0.55)] ring-4 ring-green-400/50"
            : peer.isMusic
              ? "border-2 border-sonic-accent bg-sonic-accent/20 text-sonic-accent"
              : peer.isMuted
                ? "border-2 border-sonic-600 bg-sonic-700 text-sonic-400"
                : "border-2 border-sonic-500 bg-sonic-700 text-sonic-200"
        }`}
      >
        {peer.isMusic ? <Music className="h-6 w-6" /> : getInitials(peer.displayName)}
      </div>

      {/* Name + mic status, read together: "Name, micrófono activado". */}
      <p className="max-w-[150px] truncate text-center text-sm text-sonic-100">
        <span className="font-medium">{nameWithYou}</span>, {micStatus}
      </p>

      {/* Talking badge — extra cue (dot animation + text, not colour alone). */}
      {speaking && (
        <span
          aria-hidden="true"
          className="flex items-center gap-1.5 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-300"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-green-400" />
          {m.card_speaking_now()}
        </span>
      )}

      {/* Local: change-name button right under your name. */}
      {isLocal && onChangeName && (
        <button
          onClick={onChangeName}
          className="flex items-center gap-1.5 rounded-lg bg-sonic-700 px-3 py-1 text-xs font-medium text-sonic-200 transition-colors hover:bg-sonic-600"
        >
          <UserPen aria-hidden="true" className="h-3.5 w-3.5" />
          {m.room_change_name()}
        </button>
      )}

      {/* Local: monitor your own mic (hear yourself), between change-name and your
          own level. For-you only — never reaches the room. */}
      {isLocal && onToggleMicMonitor && (
        <label className="flex w-full cursor-pointer items-center gap-2 text-xs text-sonic-200">
          <input
            type="checkbox"
            checked={!!micMonitor}
            onChange={onToggleMicMonitor}
            className="accent-sonic-accent"
          />
          <Mic aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-sonic-400" />
          {m.card_monitor_mic()}
        </label>
      )}

      {/* Remote peer: how loud you hear them. Visible "Volumen" label so a sighted
          first-timer knows what the slider does; the aria-label keeps the name. */}
      {!isLocal && (
        <div className="w-full">
          <span aria-hidden="true" className="mb-0.5 block text-[11px] text-sonic-400">
            {m.card_volume_label()}
          </span>
          <div className="flex w-full items-center gap-2">
            <Volume2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-sonic-400" />
            <input
              type="range"
              min="0"
              max="4"
              step="0.01"
              value={peer.volume}
              onChange={handleVolume}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
              aria-label={m.card_volume_for({ name: peer.displayName })}
            />
          </div>
        </div>
      )}

      {/* Your own card: your outgoing mic level (how loud others hear you). */}
      {isLocal && onMicGainChange && (
        <div className="w-full">
          <span aria-hidden="true" className="mb-0.5 block text-[11px] text-sonic-400">
            {m.card_your_mic_label()}
          </span>
          <div className="flex w-full items-center gap-2">
            <Mic aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-sonic-400" />
            <input
              type="range"
              min="0"
              max="4"
              step="0.01"
              value={micGain ?? 1}
              onChange={handleMicGain}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
              aria-label={m.card_your_mic_level()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
