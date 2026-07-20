import { useEffect, useRef, useState } from "react";
import { Tv, X } from "lucide-react";
import { m } from "../paraglide/messages.js";
import { fetchTvChannels, groupByCategoria, type Channel } from "../lib/tv";

interface TvDialogProps {
  onClose: () => void;
  // Play a channel. The dialog stays OPEN (switch channels without reopening) —
  // it closes only via the X or Escape.
  onPlayChannel: (channel: Channel) => Promise<void>;
}

// Live-TV channel picker. A native <dialog> (inert background, Escape closes the
// dialog — not the player). Channels come from /api/tv-channels, grouped by
// categoria: each category is an <h3> heading (H-navigable in NVDA) with a button
// per channel below. Picking a channel plays it and keeps the dialog open.
export function TvDialog({ onClose, onPlayChannel }: TvDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [groups, setGroups] = useState<{ categoria: string; channels: Channel[] }[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [playing, setPlaying] = useState<string>("");
  const [playError, setPlayError] = useState(false);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    closeRef.current?.focus();
    return () => dlg?.close();
  }, []);

  useEffect(() => {
    let active = true;
    void fetchTvChannels().then((channels) => {
      if (!active) return;
      if (channels.length === 0) {
        setState("empty");
        return;
      }
      setGroups(groupByCategoria(channels));
      setState("ready");
    });
    return () => {
      active = false;
    };
  }, []);

  const pick = async (c: Channel) => {
    setPlaying(c.url);
    setPlayError(false);
    try {
      await onPlayChannel(c);
    } catch {
      setPlayError(true);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tv-dialog-heading"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="w-full max-w-md rounded-xl border border-sonic-600 bg-sonic-800 p-4 text-sonic-100 shadow-2xl backdrop:bg-black/70"
    >
      <div className="mb-4 flex items-center gap-2">
        <Tv className="h-5 w-5 text-sonic-accent" aria-hidden="true" />
        <h2 id="tv-dialog-heading" className="text-base font-semibold text-sonic-100">
          {m.tv_dialog_heading()}
        </h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
          aria-label={m.tv_dialog_close()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {playError && (
        <p role="alert" className="mb-2 text-sm text-muted">
          {m.tv_play_error()}
        </p>
      )}

      {state === "loading" && <p className="text-sm text-sonic-400">{m.tv_dialog_loading()}</p>}
      {state === "empty" && <p className="text-sm text-sonic-400">{m.tv_dialog_empty()}</p>}
      {state === "error" && (
        <p role="alert" className="text-sm text-muted">
          {m.tv_dialog_error()}
        </p>
      )}

      {state === "ready" && (
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          {groups.map((g, i) => (
            <section key={g.categoria} aria-labelledby={`tv-cat-${i}`}>
              <h3
                id={`tv-cat-${i}`}
                className="mb-1 text-xs font-semibold uppercase tracking-wide text-sonic-300"
              >
                {g.categoria}
              </h3>
              <div className="grid grid-cols-2 gap-1.5">
                {g.channels.map((c) => (
                  <button
                    key={c.url}
                    type="button"
                    onClick={() => pick(c)}
                    aria-current={c.url === playing ? "true" : undefined}
                    aria-label={m.tv_dialog_play({ name: c.nombre })}
                    className={`truncate rounded-lg px-2 py-1.5 text-left text-xs font-medium ${
                      c.url === playing
                        ? "bg-sonic-accent text-white"
                        : "bg-sonic-700 text-sonic-100 hover:bg-sonic-600"
                    }`}
                    title={c.nombre}
                  >
                    {c.nombre}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </dialog>
  );
}
