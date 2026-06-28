import { useEffect, useRef, type KeyboardEvent } from "react";
import {
  Play,
  Pause,
  X,
  FileMusic,
  SkipBack,
  SkipForward,
  Repeat,
  Repeat1,
  Shuffle,
  Rewind,
  FastForward,
} from "lucide-react";
import { m } from "../paraglide/messages.js";
import { useRoomStore, type PlayerRepeat } from "../stores/room";

interface FileStreamPlayerProps {
  // The name of the file currently being streamed.
  name: string;
  playing: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  // Called with a 0–1 volume value when the user changes the combobox.
  onVolumeChange: (v: number) => void;
  // Seek actions.
  onSeekBy: (sec: number) => void;
  onSeekTo: (sec: number) => void;
  // Playlist navigation (only shown when playlist.length > 1).
  playlist: { name: string; objectUrl: string }[];
  playlistIndex: number;
  playerRepeat: PlayerRepeat;
  playerShuffle: boolean;
  onPlayTrack: (index: number) => void;
  onNext: () => void;
  onPrev: () => void;
  onSetRepeat: (repeat: PlayerRepeat) => void;
  onToggleShuffle: () => void;
  // Playback rate (0.5 / 0.75 / 1 / 1.25 / 1.5 / 2).
  playerRate: number;
  onSetRate: (rate: number) => void;
}

// Volume options: label → 0–1 value.
const VOLUME_OPTIONS: { label: string; value: number }[] = [
  { label: "100 %", value: 1 },
  { label: "75 %", value: 0.75 },
  { label: "50 %", value: 0.5 },
  { label: "25 %", value: 0.25 },
  { label: "10 %", value: 0.1 },
];

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// Format a duration in seconds to "m:ss".
function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Floating mini-window for the local-file stream: shows the file name, a
// progress bar (with seek), play/pause, seek ±10 s, prev/next, repeat, shuffle,
// speed, volume, and an optional playlist. Escape stops the stream and closes
// the window. `role="application"` lets screen readers use the contained
// interactive widgets natively. Independent of the audio share and music caster.
export function FileStreamPlayer({
  name,
  playing,
  onTogglePlay,
  onStop,
  onVolumeChange,
  onSeekBy,
  onSeekTo,
  playlist,
  playlistIndex,
  playerRepeat,
  playerShuffle,
  onPlayTrack,
  onNext,
  onPrev,
  onSetRepeat,
  onToggleShuffle,
  playerRate,
  onSetRate,
}: FileStreamPlayerProps) {
  const playRef = useRef<HTMLButtonElement>(null);
  const fileVolume = useRoomStore((s) => s.fileVolume);
  const playerTime = useRoomStore((s) => s.playerTime);
  const playerDuration = useRoomStore((s) => s.playerDuration);
  const hasPlaylist = playlist.length > 1;

  // Cycle repeat: off → all → one → off.
  const cycleRepeat = () => {
    const next: PlayerRepeat =
      playerRepeat === "off" ? "all" : playerRepeat === "all" ? "one" : "off";
    onSetRepeat(next);
  };

  const repeatLabel =
    playerRepeat === "off"
      ? m.player_repeat_off()
      : playerRepeat === "all"
        ? m.player_repeat_all()
        : m.player_repeat_one();

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

  const progressValueText = `${formatTime(playerTime)} de ${formatTime(playerDuration)}`;

  return (
    <div
      role="application"
      aria-label={m.file_player_heading()}
      onKeyDown={onKeyDown}
      className="fixed bottom-28 right-4 z-20 w-80 rounded-xl border border-sonic-600 bg-sonic-800 p-3 shadow-2xl"
    >
      {/* Track name + stop button */}
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

      {/* Progress bar */}
      <div className="mb-1">
        <input
          type="range"
          aria-label={m.player_progress()}
          aria-valuetext={progressValueText}
          min={0}
          max={playerDuration || 0}
          step={1}
          value={playerTime}
          onChange={(e) => onSeekTo(parseFloat(e.target.value))}
          className="w-full accent-sonic-accent"
        />
        <div className="flex justify-between text-xs text-sonic-400" aria-hidden="true">
          <span>{formatTime(playerTime)}</span>
          <span>{formatTime(playerDuration)}</span>
        </div>
      </div>

      {/* Playback controls row */}
      <div className="flex items-center justify-center gap-1">
        {hasPlaylist && (
          <button
            onClick={onPrev}
            className="flex h-8 w-8 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
            aria-label={m.player_prev()}
          >
            <SkipBack className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={() => onSeekBy(-10)}
          className="flex h-8 w-8 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
          aria-label={m.player_back10()}
        >
          <Rewind className="h-4 w-4" />
        </button>
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
        <button
          onClick={() => onSeekBy(10)}
          className="flex h-8 w-8 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
          aria-label={m.player_fwd10()}
        >
          <FastForward className="h-4 w-4" />
        </button>
        {hasPlaylist && (
          <button
            onClick={onNext}
            className="flex h-8 w-8 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
            aria-label={m.player_next()}
          >
            <SkipForward className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Keyboard guidance — tied to play button via aria-describedby. */}
      <p id="file-player-hint" className="mt-1 text-center text-xs text-sonic-400">
        {m.file_player_hint()}
      </p>

      {/* Repeat + shuffle controls (always visible when there's audio). */}
      <div className="mt-1.5 flex items-center gap-1">
        <button
          onClick={cycleRepeat}
          className={`flex h-7 w-7 items-center justify-center rounded text-sonic-300 hover:bg-sonic-700 ${playerRepeat !== "off" ? "text-sonic-accent" : ""}`}
          aria-label={`${m.player_repeat()}: ${repeatLabel}`}
          aria-pressed={playerRepeat !== "off"}
        >
          {playerRepeat === "one" ? (
            <Repeat1 className="h-4 w-4" />
          ) : (
            <Repeat className="h-4 w-4" />
          )}
        </button>
        <button
          onClick={onToggleShuffle}
          className={`flex h-7 w-7 items-center justify-center rounded text-sonic-300 hover:bg-sonic-700 ${playerShuffle ? "text-sonic-accent" : ""}`}
          aria-label={m.player_shuffle()}
          aria-pressed={playerShuffle}
        >
          <Shuffle className="h-4 w-4" />
        </button>
        {hasPlaylist && (
          <span className="ml-auto text-xs text-sonic-400">
            {playlistIndex + 1} / {playlist.length}
          </span>
        )}
      </div>

      {/* Playlist track list (only for multi-track playlists). */}
      {hasPlaylist && (
        <ul
          role="listbox"
          aria-label={m.player_playlist()}
          className="mt-1.5 max-h-28 overflow-y-auto rounded-lg border border-sonic-600 bg-sonic-900/40 p-1"
        >
          {playlist.map((track, i) => (
            <li
              key={track.objectUrl}
              role="option"
              aria-selected={i === playlistIndex}
              tabIndex={0}
              className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs ${
                i === playlistIndex
                  ? "bg-sonic-700 text-sonic-100"
                  : "text-sonic-300 hover:bg-sonic-700/60"
              }`}
              onClick={() => onPlayTrack(i)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPlayTrack(i);
                }
              }}
            >
              <FileMusic className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate" title={track.name}>
                {track.name}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Speed + Volume row */}
      <div className="mt-2 flex items-center gap-2">
        <label htmlFor="file-player-speed" className="shrink-0 text-xs text-sonic-300">
          {m.player_speed()}
        </label>
        <select
          id="file-player-speed"
          value={playerRate}
          onChange={(e) => onSetRate(parseFloat(e.target.value))}
          className="rounded bg-sonic-700 px-2 py-1 text-xs text-sonic-100 focus:outline-none focus:ring-1 focus:ring-sonic-accent"
        >
          {RATE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r === 1 ? "1×" : `${r}×`}
            </option>
          ))}
        </select>

        <label htmlFor="file-player-volume" className="ml-auto shrink-0 text-xs text-sonic-300">
          {m.player_volume_label()}
        </label>
        <select
          id="file-player-volume"
          value={selectedValue}
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
          className="rounded bg-sonic-700 px-2 py-1 text-xs text-sonic-100 focus:outline-none focus:ring-1 focus:ring-sonic-accent"
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
