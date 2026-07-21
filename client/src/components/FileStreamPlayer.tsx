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
  FolderOpen,
  Folder,
} from "lucide-react";
import { m } from "../paraglide/messages.js";
import { useRoomStore, type PlayerRepeat } from "../stores/room";

interface FileStreamPlayerProps {
  // The track currently playing, or null when the player is open but idle.
  name: string | null;
  playing: boolean;
  onTogglePlay: () => void;
  // Closes the player; stops the stream if one is playing.
  onClose: () => void;
  // Called with a 0–1 volume value when the user changes the volume.
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
  // Open a local source (files or a folder). Cross-fades if something plays.
  onOpenFiles: () => void;
  onOpenFolder: () => void;
  // True when the current source is a URL stream (m3u8/mp3 radio): show ONLY the
  // volume control (and the close button) — hide the rest until it's closed.
  isUrlStream: boolean;
}

// Volume step: 1 % per Up/Down. The range runs 0–200 % (gain 0–2): above 100 %
// the fileVolumeGain node amplifies, to rescue quiet sources (e.g. low series).
const VOLUME_STEP = 0.01;
const VOLUME_MAX = 2;
const clampVolume = (v: number) => Math.min(VOLUME_MAX, Math.max(0, Math.round(v * 100) / 100));

// Format a duration in seconds to "m:ss".
function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Full-width player bar at the very bottom of the page (the document footer, after
// the controls). It's the last thing in reading order, and the bottom-most control
// is "Abrir archivos" — Ctrl+End jumps straight there. Order bottom→top: Open
// files, Open folder, volume, then (when a track is loaded) the rest of the
// transport above. It's a plain `role="group"` (NOT `role="application"`, which
// trapped screen readers into forms mode — "press Enter to enter" — and hid the
// controls); the buttons/sliders are directly navigable. URL playback lives in
// its own dialog — one job per control. A series hides the local-file/playlist
// controls (repeat, shuffle, open files/folder) and shows episode-relative time.
export function FileStreamPlayer({
  name,
  playing,
  onTogglePlay,
  onClose,
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
  onOpenFiles,
  onOpenFolder,
  isUrlStream,
}: FileStreamPlayerProps) {
  const playRef = useRef<HTMLButtonElement>(null);
  const openFilesRef = useRef<HTMLButtonElement>(null);
  const volumeRef = useRef<HTMLInputElement>(null);
  const fileVolume = useRoomStore((s) => s.fileVolume);
  const playerTime = useRoomStore((s) => s.playerTime);
  const playerDuration = useRoomStore((s) => s.playerDuration);
  const serieName = useRoomStore((s) => s.serieName);
  const serieEpisodes = useRoomStore((s) => s.serieEpisodes);
  const serieEpisodeIndex = useRoomStore((s) => s.serieEpisodeIndex);
  const hasTrack = name != null;
  const hasPlaylist = playlist.length > 1;
  const volumePct = Math.round(fileVolume * 100);

  // A series plays ONE long .m4b where each episode is a millisecond time-range
  // inside it, so the raw element time/duration span the whole file. Show
  // progress RELATIVE to the current episode instead, and seek back into
  // absolute time by adding the episode's start. (chapterStart is 0 for a plain
  // local track, so the math is a no-op there.)
  const isSeries = serieName != null;
  const currentEp = isSeries ? serieEpisodes[serieEpisodeIndex] : undefined;
  const chapterStart = currentEp ? currentEp.inicio / 1000 : 0;
  const progressDuration = currentEp
    ? Math.max(0, currentEp.fin / 1000 - chapterStart)
    : playerDuration;
  const progressTime = currentEp
    ? Math.min(Math.max(0, playerTime - chapterStart), progressDuration)
    : playerTime;

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

  // On open: a URL stream → the volume; a loaded track → play; idle → open files.
  useEffect(() => {
    if (isUrlStream) volumeRef.current?.focus();
    else if (hasTrack) playRef.current?.focus();
    else openFilesRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount only

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Ctrl+End → jump to the bottom-most control (Open files).
    if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      openFilesRef.current?.focus();
      return;
    }

    // Don't intercept keys typed into inner form controls (range sliders) — let
    // the native control handle them.
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

  const progressValueText = m.player_progress_valuetext({
    current: formatTime(progressTime),
    total: formatTime(progressDuration),
  });

  return (
    <div
      id="conference-player"
      onKeyDown={onKeyDown}
      tabIndex={-1}
      className="w-full border-t border-sonic-600 bg-sonic-800 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-sonic-accent"
    >
      <div className="mx-auto max-w-md p-3">
        {/* Title (a level-2 heading so screen readers can jump straight to the
            player by heading) + close button */}
        <div className="mb-2 flex items-center gap-2">
          <FileMusic className="h-4 w-4 shrink-0 text-sonic-accent" aria-hidden="true" />
          <h2
            className="truncate text-sm font-medium text-sonic-100"
            title={name ?? undefined}
          >
            {hasTrack ? name : m.player_virtual_title()}
          </h2>
          <button
            onClick={onClose}
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sonic-700 text-sonic-200 transition-all hover:bg-sonic-600"
            aria-label={hasTrack ? m.file_player_stop() : m.audio_source_close()}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Transport, playlist, etc. — only for a loaded LOCAL track (a URL
            stream shows just the volume below). */}
        {hasTrack && !isUrlStream && (
          <>
            {/* Progress bar */}
            <div className="mb-1">
              <input
                type="range"
                aria-label={m.player_progress()}
                aria-valuetext={progressValueText}
                min={0}
                max={progressDuration || 0}
                step={1}
                value={progressTime}
                onChange={(e) => onSeekTo(parseFloat(e.target.value) + chapterStart)}
                className="w-full accent-sonic-accent"
              />
              <div className="flex justify-between text-xs text-sonic-400" aria-hidden="true">
                <span>{formatTime(progressTime)}</span>
                <span>{formatTime(progressDuration)}</span>
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
                ref={playRef}
                onClick={onTogglePlay}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-sonic-accent text-white transition-all hover:bg-sonic-accent/90"
                aria-label={playing ? m.file_player_pause() : m.file_player_play()}
                aria-pressed={playing}
              >
                {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
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

            {/* Repeat + shuffle controls. Hidden for a series — it's a single
                continuous .m4b with no playlist to repeat or shuffle. */}
            {!isSeries && (
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
            )}

            {/* Playlist track list (only for multi-track playlists). A single tab
                stop: the listbox holds focus and aria-activedescendant points at
                the roving cursor; Up/Down move it, Enter/Space play. */}
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

          </>
        )}

        {/* Volume — always shown while a track plays (the only control for a URL
            stream); sits just above the Open folder / Open files buttons. */}
        {hasTrack && (
          <div className="mt-2 flex items-center gap-2">
            {/* Visual-only label (aria-hidden) so screen readers don't stop on it
                separately; the slider carries the name via aria-label, reading as
                one element: "Volumen para todos, deslizador, 54 %". */}
            <span className="shrink-0 text-xs text-sonic-300" aria-hidden="true">
              {m.player_volume_label()}
            </span>
            <input
              ref={volumeRef}
              id="file-player-volume"
              type="range"
              min={0}
              max={200}
              step={1}
              value={volumePct}
              aria-label={m.player_volume_label()}
              aria-valuetext={`${volumePct} %`}
              onChange={(e) => onVolumeChange(clampVolume(parseFloat(e.target.value) / 100))}
              className="min-w-0 flex-1 accent-sonic-accent"
            />
            <span
              className="w-12 shrink-0 text-right text-xs tabular-nums text-sonic-300"
              aria-hidden="true"
            >
              {volumePct} %
            </span>
          </div>
        )}

        {/* Idle hint when nothing is loaded yet. */}
        {!hasTrack && <p className="mb-2 text-xs text-sonic-400">{m.player_empty_hint()}</p>}

        {/* Open a local source, stacked at the very bottom (Open files last, so
            Ctrl+End lands on it). Does NOT stop the current track — cross-fades.
            Hidden during a URL stream or a series (those aren't local files —
            only the volume shows). Still available when idle or on a local track. */}
        {!isUrlStream && !isSeries && (
          <div className="mt-2 flex flex-col gap-2 border-t border-sonic-700 pt-2">
            <button
              onClick={onOpenFolder}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-sonic-700 px-2 py-2 text-xs font-medium text-sonic-100 transition-colors hover:bg-sonic-600"
            >
              <Folder aria-hidden="true" className="h-3.5 w-3.5" />
              {m.player_open_folder()}
            </button>
            <button
              id="player-open-files"
              ref={openFilesRef}
              onClick={onOpenFiles}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-sonic-700 px-2 py-2 text-xs font-medium text-sonic-100 transition-colors hover:bg-sonic-600"
            >
              <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
              {m.player_open_files()}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
