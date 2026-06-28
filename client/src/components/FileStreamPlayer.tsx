import { useEffect, useRef, type KeyboardEvent } from "react";
import { Play, Pause, X, FileMusic } from "lucide-react";
import { m } from "../paraglide/messages.js";
import { useRoomStore } from "../stores/room";

interface FileStreamPlayerProps {
  // The name of the file currently being streamed.
  name: string;
  playing: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  // Called with a 0–1 volume value when the user changes the combobox.
  onVolumeChange: (v: number) => void;
}

// Volume options: label → 0–1 value.
const VOLUME_OPTIONS: { label: string; value: number }[] = [
  { label: "100 %", value: 1 },
  { label: "75 %", value: 0.75 },
  { label: "50 %", value: 0.5 },
  { label: "25 %", value: 0.25 },
  { label: "10 %", value: 0.1 },
];

// Floating mini-window for the local-file stream: shows the file name, a
// play/pause toggle (autofocused when the window appears, so Space toggles it
// straight away), a stop button, and a source-side volume combobox that lowers
// the file for ALL listeners. Escape anywhere inside stops the stream and
// closes the window. Independent of the audio share and the music caster.
export function FileStreamPlayer({
  name,
  playing,
  onTogglePlay,
  onStop,
  onVolumeChange,
}: FileStreamPlayerProps) {
  const playRef = useRef<HTMLButtonElement>(null);
  const fileVolume = useRoomStore((s) => s.fileVolume);

  // Autofocus the play/pause control the moment the window opens (i.e. as soon
  // as a file is picked), so keyboard/SR users land on it without tabbing.
  useEffect(() => {
    playRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onStop();
    }
  };

  // Find the closest option value for the current store value (snaps to
  // nearest entry so a persisted mid-range value still renders a valid option).
  const selectedValue = VOLUME_OPTIONS.reduce((best, opt) =>
    Math.abs(opt.value - fileVolume) < Math.abs(best.value - fileVolume) ? opt : best,
  ).value;

  return (
    <div
      role="dialog"
      aria-label={m.file_player_heading()}
      onKeyDown={onKeyDown}
      className="fixed bottom-28 right-4 z-20 w-72 rounded-xl border border-sonic-600 bg-sonic-800 p-3 shadow-2xl"
    >
      <div className="mb-2 flex items-center gap-2">
        <FileMusic className="h-4 w-4 shrink-0 text-sonic-accent" />
        <span className="truncate text-sm font-medium text-sonic-100" title={name}>
          {name}
        </span>
        <button
          onClick={onStop}
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sonic-700 text-sonic-200 transition-all hover:bg-sonic-600"
          aria-label={m.file_player_stop()}
          title={m.controls_stop_file_title()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          ref={playRef}
          onClick={onTogglePlay}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-sonic-accent text-white transition-all hover:bg-sonic-accent/90"
          aria-label={playing ? m.file_player_pause() : m.file_player_play()}
          aria-describedby="file-player-hint"
          aria-pressed={playing}
        >
          {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </button>
        {/* Keyboard guidance for the autofocused play button (Space toggles,
            Escape stops) — tied to it via aria-describedby. */}
        <p id="file-player-hint" className="text-xs text-sonic-400">
          {m.file_player_hint()}
        </p>
      </div>

      {/* Source-side volume: lowers the transmitted audio for all listeners. */}
      <div className="mt-2 flex items-center gap-2">
        <label
          htmlFor="file-player-volume"
          className="shrink-0 text-xs text-sonic-300"
        >
          {m.player_volume_label()}
        </label>
        <select
          id="file-player-volume"
          value={selectedValue}
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
          className="ml-auto rounded bg-sonic-700 px-2 py-1 text-xs text-sonic-100 focus:outline-none focus:ring-1 focus:ring-sonic-accent"
        >
          {VOLUME_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
