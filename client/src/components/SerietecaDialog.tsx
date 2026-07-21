import { useEffect, useMemo, useRef, useState } from "react";
import { Library, X } from "lucide-react";
import { m } from "../paraglide/messages.js";
import {
  fetchSeries,
  groupByPais,
  loadProgress,
  normalizeForSearch,
  type Serie,
} from "../lib/serieteca";

interface SerietecaDialogProps {
  onClose: () => void;
  // Play a series. The dialog stays OPEN (switch series without reopening) —
  // it closes only via the X or Escape.
  onPlaySerie: (serie: Serie) => Promise<void>;
}

// Audio-series catalog picker. A native <dialog> (inert background, Escape
// closes the dialog — not the player). Series come from fetchSeries(): with an
// empty search box we show "Continuar escuchando" (series with saved
// progress), "Últimas agregadas" (the 20 most recently added), then the full
// catalog grouped by país (each an <h3> heading, H-navigable in NVDA). Typing
// in the search box switches to a flat filtered list instead. Picking a
// series plays it and keeps the dialog open.
export function SerietecaDialog({ onClose, onPlaySerie }: SerietecaDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [series, setSeries] = useState<Serie[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [query, setQuery] = useState("");
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
    void fetchSeries().then((s) => {
      if (!active) return;
      if (s.length === 0) {
        setState("empty");
        return;
      }
      setSeries(s);
      setState("ready");
    });
    return () => {
      active = false;
    };
  }, []);

  const q = normalizeForSearch(query);
  const filtered = useMemo(
    () => (series && q ? series.filter((s) => normalizeForSearch(s.nombre).includes(q)) : null),
    [series, q],
  );

  const pick = async (s: Serie) => {
    setPlaying(s.nombre);
    setPlayError(false);
    try {
      await onPlaySerie(s);
    } catch {
      setPlayError(true);
    }
  };

  const progress = series ? loadProgress() : {};
  const continuing = series ? series.filter((s) => progress[s.nombre]) : [];
  const latest = series ? series.slice(-20).reverse() : [];
  const groups = series ? groupByPais(series) : [];

  const seriesButton = (s: Serie) => (
    <button
      key={s.nombre}
      type="button"
      onClick={() => void pick(s)}
      aria-current={s.nombre === playing ? "true" : undefined}
      className={`w-full truncate rounded-lg px-2 py-1.5 text-left text-xs font-medium ${
        s.nombre === playing
          ? "bg-sonic-accent text-white"
          : "bg-sonic-700 text-sonic-100 hover:bg-sonic-600"
      }`}
      title={s.nombre}
    >
      {s.nombre}
    </button>
  );

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="serieteca-dialog-heading"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="w-full max-w-md rounded-xl border border-sonic-600 bg-sonic-800 p-4 text-sonic-100 shadow-2xl backdrop:bg-black/70"
    >
      <div className="mb-4 flex items-center gap-2">
        <Library className="h-5 w-5 text-sonic-accent" aria-hidden="true" />
        <h2 id="serieteca-dialog-heading" className="text-base font-semibold text-sonic-100">
          {m.serieteca_heading()}
        </h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
          aria-label={m.serieteca_close()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {playError && (
        <p role="alert" className="mb-2 text-sm text-muted">
          {m.serie_play_error()}
        </p>
      )}

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label={m.serieteca_search()}
        placeholder={m.serieteca_search()}
        className="mb-3 w-full rounded-lg border border-sonic-600 bg-sonic-700 px-3 py-1.5 text-sm text-sonic-100 placeholder-sonic-400 focus:border-sonic-accent focus:outline-none"
      />

      {state === "loading" && <p className="text-sm text-sonic-400">{m.serieteca_loading()}</p>}
      {state === "empty" && <p className="text-sm text-sonic-400">{m.serieteca_empty()}</p>}
      {state === "error" && (
        <p role="alert" className="text-sm text-muted">
          {m.serieteca_error()}
        </p>
      )}

      {series && (
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          {filtered ? (
            filtered.length > 0 ? (
              <div className="grid grid-cols-2 gap-1.5">{filtered.map(seriesButton)}</div>
            ) : (
              <p className="text-sm text-sonic-400">{m.serieteca_no_results()}</p>
            )
          ) : (
            <>
              {continuing.length > 0 && (
                <section aria-labelledby="serieteca-continue">
                  <h3
                    id="serieteca-continue"
                    className="mb-1 text-xs font-semibold uppercase tracking-wide text-sonic-300"
                  >
                    {m.serieteca_continue()}
                  </h3>
                  <div className="grid grid-cols-2 gap-1.5">{continuing.map(seriesButton)}</div>
                </section>
              )}
              {latest.length > 0 && (
                <section aria-labelledby="serieteca-latest">
                  <h3
                    id="serieteca-latest"
                    className="mb-1 text-xs font-semibold uppercase tracking-wide text-sonic-300"
                  >
                    {m.serieteca_latest()}
                  </h3>
                  <div className="grid grid-cols-2 gap-1.5">{latest.map(seriesButton)}</div>
                </section>
              )}
              {groups.map((g, i) => (
                <section key={g.pais} aria-labelledby={`serieteca-cat-${i}`}>
                  <h3
                    id={`serieteca-cat-${i}`}
                    className="mb-1 text-xs font-semibold uppercase tracking-wide text-sonic-300"
                  >
                    {g.pais}
                  </h3>
                  <div className="grid grid-cols-2 gap-1.5">{g.series.map(seriesButton)}</div>
                </section>
              ))}
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
