import { useEffect, useRef } from "react";
import { AudioWaveform, X } from "lucide-react";
import { useRoomStore } from "../stores/room";
import { AMBIENCES, ambienceName } from "../lib/ambience";
import { m } from "../paraglide/messages.js";

interface AmbienceDialogProps {
  onClose: () => void;
  // Pick the room's acoustic ambience. Room-wide — the server broadcasts it, so
  // everyone drops into the same space. Applied live as you pick.
  onSetAmbience: (id: string) => void;
}

// Hidden ambience panel (Ctrl+Alt+A). Deliberately not reachable from any
// button — like recording, bitrate and the 3D panel, knowing the shortcut is
// the gate, so nobody changes the room's acoustics by accident.
//
// Picks an acoustic space (reverb) applied to EVERYTHING the room hears, so the
// whole scene sounds like it's in a concert hall / car / room… (see lib/ambience).
export function AmbienceDialog({ onClose, onSetAmbience }: AmbienceDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const ambience = useRoomStore((s) => s.ambience);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    selectRef.current?.focus();
    return () => dlg?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ambience-dialog-heading"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="w-full max-w-sm rounded-xl border border-sonic-600 bg-sonic-800 p-4 text-sonic-100 shadow-2xl backdrop:bg-black/70"
    >
      <div className="mb-4 flex items-center gap-2">
        <AudioWaveform className="h-5 w-5 text-sonic-accent" aria-hidden="true" />
        <h2 id="ambience-dialog-heading" className="text-base font-semibold text-sonic-100">
          {m.ambience_dialog_heading()}
        </h2>
        <button
          onClick={onClose}
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
          aria-label={m.ambience_dialog_close()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <label htmlFor="ambience-select" className="mb-1 block text-xs font-medium text-sonic-300">
        {m.ambience_label()}
      </label>
      <select
        id="ambience-select"
        ref={selectRef}
        value={ambience}
        onChange={(e) => onSetAmbience(e.target.value)}
        className="w-full rounded-lg border border-sonic-600 bg-sonic-700 px-2.5 py-1.5 text-sm text-sonic-100 focus:border-sonic-accent focus:outline-none"
      >
        {AMBIENCES.map((a) => (
          <option key={a.id} value={a.id}>
            {ambienceName(a.id)}
          </option>
        ))}
      </select>

      <p className="mt-3 text-xs text-sonic-400">{m.ambience_dialog_help()}</p>
    </dialog>
  );
}
