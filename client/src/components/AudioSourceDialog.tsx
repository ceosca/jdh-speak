import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ChevronLeft, FileMusic, Folder, FolderOpen, Link, Music, X } from "lucide-react";
import { m } from "../paraglide/messages.js";

interface AudioSourceDialogProps {
  onClose: () => void;
  onChooseComputerFile: () => void;
  onStartUrl: (url: string) => Promise<void>;
  // `relPath` may include subfolders, e.g. "Movies/Dune.mp3".
  onStartServerFile: (relPath: string) => Promise<void>;
}

interface LibraryEntry {
  name: string;
  dir: boolean;
}

export function AudioSourceDialog({
  onClose,
  onChooseComputerFile,
  onStartUrl,
  onStartServerFile,
}: AudioSourceDialogProps) {
  const browseButtonRef = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState("");
  // The server library is a browsable tree: `libPath` is the current folder
  // ("" = root) and `entries` are its folders + audio files.
  const [libPath, setLibPath] = useState("");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  // Focus the "browse computer" button on open (runs once).
  useEffect(() => {
    browseButtonRef.current?.focus();
  }, []);

  // (Re)list whenever the folder changes.
  useEffect(() => {
    let active = true;
    setLoading(true);
    void fetch(`/api/audio-library?path=${encodeURIComponent(libPath)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error();
        return (await res.json()) as { entries?: LibraryEntry[] };
      })
      .then(({ entries: next }) => {
        if (active && Array.isArray(next)) setEntries(next);
      })
      .catch(() => {
        // The library is optional and a folder may be unreadable — fall through
        // to the empty state. The `error` banner is reserved for an actual
        // failure to *start* a source.
        if (active) setEntries([]);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [libPath]);

  const start = async (action: () => Promise<void>) => {
    setStarting(true);
    setError("");
    try {
      await action();
      onClose();
    } catch {
      setError(m.audio_source_error());
      setStarting(false);
    }
  };

  const atRoot = libPath === "";
  const openFolder = (name: string) => setLibPath((p) => (p ? `${p}/${name}` : name));
  const goUp = () => setLibPath((p) => p.split("/").slice(0, -1).join("/"));
  const streamFile = (name: string) =>
    void start(() => onStartServerFile(libPath ? `${libPath}/${name}` : name));

  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (value) void start(() => onStartUrl(value));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    // Backspace goes up a folder — but never while typing in the URL field.
    if (e.key === "Backspace" && !atRoot) {
      const target = e.target as HTMLElement;
      if (
        target.tagName !== "INPUT" &&
        target.tagName !== "TEXTAREA" &&
        !target.isContentEditable
      ) {
        e.preventDefault();
        goUp();
      }
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="audio-source-heading"
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-xl border border-sonic-600 bg-sonic-800 p-4 shadow-2xl"
      >
        <div className="mb-4 flex items-center gap-2">
          <FileMusic className="h-5 w-5 text-sonic-accent" aria-hidden="true" />
          <h2 id="audio-source-heading" className="text-base font-semibold text-sonic-100">
            {m.audio_source_heading()}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
            aria-label={m.audio_source_close()}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <button
          ref={browseButtonRef}
          type="button"
          disabled={starting}
          onClick={onChooseComputerFile}
          className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-sonic-700 px-3 py-2 text-sm font-medium text-sonic-100 hover:bg-sonic-600 disabled:opacity-50"
        >
          <FolderOpen className="h-4 w-4" />
          {m.audio_source_computer()}
        </button>

        <form onSubmit={submitUrl} className="mb-4">
          <label
            htmlFor="audio-source-url"
            className="mb-1 block text-xs font-medium text-sonic-300"
          >
            {m.audio_source_url_label()}
          </label>
          <div className="flex gap-2">
            <input
              id="audio-source-url"
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={m.audio_source_url_placeholder()}
              className="min-w-0 flex-1 rounded-lg border border-sonic-600 bg-sonic-700 px-2.5 py-1.5 text-sm text-sonic-100 placeholder-sonic-400 focus:border-sonic-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={starting || !url.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-sonic-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              <Link className="h-4 w-4" />
              {m.audio_source_url_start()}
            </button>
          </div>
        </form>

        {/* Server library: a folder browser. Back button + Backspace go up a
            level; names truncate visually (CSS) but the full name stays in each
            button's accessible label. */}
        <div role="group" aria-label={m.audio_source_library_label()}>
          <div className="mb-1 flex items-center gap-1.5">
            {!atRoot && (
              <button
                type="button"
                onClick={goUp}
                aria-label={m.audio_source_back()}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            <span
              className="min-w-0 flex-1 truncate text-xs font-medium text-sonic-300"
              title={libPath || undefined}
            >
              {atRoot
                ? m.audio_source_library_label()
                : `${m.audio_source_library_label()} / ${libPath}`}
            </span>
          </div>

          {loading ? (
            <p className="text-xs text-sonic-400">{m.audio_source_loading()}</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-sonic-400">
              {atRoot ? m.audio_source_library_empty() : m.audio_source_folder_empty()}
            </p>
          ) : (
            <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-sonic-600 bg-sonic-900/40 p-1">
              {entries.map((entry) => (
                <li key={`${entry.dir ? "d" : "f"}:${entry.name}`}>
                  <button
                    type="button"
                    disabled={starting}
                    onClick={() => (entry.dir ? openFolder(entry.name) : streamFile(entry.name))}
                    aria-label={
                      entry.dir
                        ? m.audio_source_open_folder({ name: entry.name })
                        : m.audio_source_stream_named({ name: entry.name })
                    }
                    title={entry.name}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-sonic-100 hover:bg-sonic-700 disabled:opacity-50"
                  >
                    {entry.dir ? (
                      <Folder className="h-4 w-4 shrink-0 text-sonic-accent" aria-hidden="true" />
                    ) : (
                      <Music className="h-4 w-4 shrink-0 text-sonic-300" aria-hidden="true" />
                    )}
                    <span className="truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-muted">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
