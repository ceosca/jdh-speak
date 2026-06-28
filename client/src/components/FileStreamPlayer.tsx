import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// Volume step: 1 % of the 0–1 gain range, per the "lower it one by one" design.
const VOLUME_STEP = 0.01;
const clampVolume = (v: number) => Math.min(1, Math.max(0, Math.round(v * 100) / 100));

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
  const volumePct = Math.round(fileVolume * 100);

  // Roving cursor for the playlist listbox: a single tab stop whose
  // aria-activedescendant moves with Up/Down, so reaching the volume below no
  // longer means tabbing through every track. Follows the playing track until
  // the user navigates.
  const [listFocus, setListFocus] = useState(playlistIndex);
  useEffect(() => {
    setListFocus(playlistIndex);
  }, [playlistIndex]);

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
    // Always handle Escape to stop, regardless of target.
    if (e.key === "Escape") {
      e.stopPropagation();
      onStop();
      return;
    }

    // Don't intercept keys typed into inner form controls (volume/speed selects,
    // range slider) — let the native control handle them.
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }

    // Space → play/pause.
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      onTogglePlay();
      return;
    }

    // Up / Down → volume +/- 1 % (for all listeners). The playlist listbox stops
    // propagation of these keys, so this only fires when focus is on the player
    // container or its buttons — not while navigating the track list.
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.key === "ArrowUp" ? VOLUME_STEP : -VOLUME_STEP;
      onVolumeChange(clampVolume(fileVolume + delta));
      return;
    }

    // Arrow keys with modifiers → seek.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      if (e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        onSeekBy(dir * 60);
        return;
      }
      if (e.altKey) {
        // preventDefault cancels browser Alt+Arrow back/forward navigation.
        e.preventDefault();
        e.stopPropagation();
        onSeekBy(dir * 10);
        return;
      }
      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        onSeekBy(dir * 5);
        return;
      }
    }

    // Shift+P → previous track; Shift+N → next track.
    if (e.shiftKey && (e.code === "KeyP" || e.key === "P" || e.key === "p")) {
      e.preventDefault();
      e.stopPropagation();
      onPrev();
      return;
    }
    if (e.shiftKey && (e.code === "KeyN" || e.key === "N" || e.key === "n")) {
      e.preventDefault();
      e.stopPropagation();
      onNext();
      return;
    }
  };

  // Keyboard handling for the playlist listbox (a single tab stop). Up/Down move
  // the roving cursor; Enter/Space play the focused track. stopPropagation keeps
  // these keys from also triggering the container's volume/seek shortcuts.
  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setListFocus((i) => Math.min(playlist.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setListFocus((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      setListFocus(0);
    } else if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      setListFocus(playlist.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      onPlayTrack(listFocus);
    }
  };

  const progressValueText = m.player_progress_valuetext({ current: formatTime(playerTime), total: formatTime(playerDuration) });

  return (
    <div
      id="conference-player"
      role="application"
      aria-label={m.file_player_heading()}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      className="fixed bottom-28 right-4 z-20 w-80 rounded-xl border border-sonic-600 bg-sonic-800 p-3 shadow-2xl focus:outline-none focus:ring-2 focus:ring-sonic-accent"
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
        {m.player_focus_hint()}
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

      {/* Playlist track list (only for multi-track playlists). A single tab stop:
          the listbox holds focus and aria-activedescendant points at the roving
          cursor; Up/Down move it, Enter/Space play. */}
      {hasPlaylist && (
        <ul
          role="listbox"
          tabIndex={0}
          aria-label={m.player_playlist()}
          aria-activedescendant={`player-track-${listFocus}`}
          onKeyDown={onListKeyDown}
          className="mt-1.5 max-h-28 overflow-y-auto rounded-lg border border-sonic-600 bg-sonic-900/40 p-1 focus:outline-none focus:ring-2 focus:ring-sonic-accent"
        >
          {playlist.map((track, i) => (
            <li
              key={track.objectUrl}
              id={`player-track-${i}`}
              role="option"
              aria-selected={i === playlistIndex}
              className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs ${
                i === playlistIndex
                  ? "bg-sonic-700 text-sonic-100"
                  : "text-sonic-300 hover:bg-sonic-700/60"
              } ${i === listFocus ? "ring-1 ring-inset ring-sonic-accent" : ""}`}
              onClick={() => {
                setListFocus(i);
                onPlayTrack(i);
              }}
            >
              <FileMusic className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate" title={track.name || m.player_track_n({ n: i + 1 })}>
                {track.name || m.player_track_n({ n: i + 1 })}
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
        <input
          id="file-player-volume"
          type="range"
          min={0}
          max={100}
          step={1}
          value={volumePct}
          aria-valuetext={`${volumePct} %`}
          onChange={(e) => onVolumeChange(clampVolume(parseFloat(e.target.value) / 100))}
          className="w-24 accent-sonic-accent"
        />
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-sonic-300" aria-hidden="true">
          {volumePct} %
        </span>
      </div>
    </div>
  );
}
