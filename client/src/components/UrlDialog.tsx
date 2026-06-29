import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, X } from "lucide-react";
import { m } from "../paraglide/messages.js";

interface UrlDialogProps {
  onClose: () => void;
  // Play a public URL (mp3, m3u8/HLS, radio, …). Resolves when started.
  onStartUrl: (url: string) => Promise<void>;
}

// Minimal "Abrir URL" modal: one URL field + start. Separate from the virtual
// player (which owns local files/folders) — one job per control, no duplicated
// open options. Native <dialog> gives the inert background, focus containment
// and Escape-to-close.
export function UrlDialog({ onClose, onStartUrl }: UrlDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    inputRef.current?.focus();
    return () => dlg?.close();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value) return;
    setStarting(true);
    setError("");
    try {
      await onStartUrl(value);
      onClose();
    } catch {
      setError(m.audio_source_error());
      setStarting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="url-dialog-heading"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="w-full max-w-md rounded-xl border border-sonic-600 bg-sonic-800 p-4 text-sonic-100 shadow-2xl backdrop:bg-black/70"
    >
      <div className="mb-4 flex items-center gap-2">
        <Link className="h-5 w-5 text-sonic-accent" aria-hidden="true" />
        <h2 id="url-dialog-heading" className="text-base font-semibold text-sonic-100">
          {m.url_dialog_heading()}
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

      <form onSubmit={submit}>
        <label htmlFor="url-dialog-input" className="mb-1 block text-xs font-medium text-sonic-300">
          {m.audio_source_url_label()}
        </label>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            id="url-dialog-input"
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

      {error && (
        <p role="alert" className="mt-3 text-sm text-muted">
          {error}
        </p>
      )}
    </dialog>
  );
}
