import { useEffect, useMemo, useRef, useState } from "react";
import { Move3d, X } from "lucide-react";
import { useRoomStore } from "../stores/room";
import { m } from "../paraglide/messages.js";

interface SpatialDialogProps {
  onClose: () => void;
  // Moves a participant's seat. Room-wide — the server broadcasts it, so every
  // listener hears that person from the new direction. Called live while the
  // slider moves (there's no Save button; changes apply as you go).
  onSetPosition: (name: string, degrees: number) => void;
}

// Slider range/step. 5° steps keep arrow-key nudges meaningful without being
// so fine that they're inaudible, and match the server's rounding.
const MIN_DEG = -90;
const MAX_DEG = 90;
const STEP_DEG = 5;

// Spoken description of a position — a bare number ("-45") means nothing when
// you can't see the slider, so the screen reader gets words instead.
function describeDegrees(deg: number): string {
  if (deg === 0) return m.spatial_pos_center();
  const amount = Math.abs(deg);
  if (amount >= 85) return deg < 0 ? m.spatial_pos_full_left() : m.spatial_pos_full_right();
  return deg < 0 ? m.spatial_pos_left({ deg: amount }) : m.spatial_pos_right({ deg: amount });
}

// Hidden 3D-seating panel (Ctrl+Alt+U). Deliberately not reachable from any
// button: like the recording and bitrate shortcuts, if you don't know the key
// combo the UI doesn't exist — so nobody moves people around by accident.
//
// Flow (as designed with Cristian): a combobox of participants, Tab to the
// position slider, adjust (applies + saves as you move), Shift+Tab back to pick
// the next person. No Save button, no confirmation step.
export function SpatialDialog({ onClose, onSetPosition }: SpatialDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const peers = useRoomStore((s) => s.peers);
  const positions = useRoomStore((s) => s.spatialPositions);
  const spatialAudio = useRoomStore((s) => s.spatialAudio);
  const myName = useRoomStore((s) => s.displayName);
  const [selected, setSelected] = useState("");

  // Everyone in the room, INCLUDING yourself. Your own seat is what the others
  // hear — you never render your own voice, so moving yourself changes how the
  // room hears you, not what you hear. (Without this you couldn't place
  // yourself at all, and alone in a room the list would be empty.)
  //
  // Music casters are left out: they're excluded from spatialisation (HRTF
  // would collapse their stereo image), so listing them would offer a control
  // that does nothing.
  const seatable = useMemo(() => {
    const others = [...peers.values()]
      .filter((p) => !p.isMusic)
      .map((p) => ({ key: p.peerId, name: p.displayName, self: false }));
    const list = myName ? [{ key: "self", name: myName, self: true }, ...others] : others;
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [peers, myName]);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    selectRef.current?.focus();
    return () => dlg?.close();
  }, []);

  // Default to the first participant, and drop a selection whose peer left.
  useEffect(() => {
    setSelected((cur) => {
      if (cur && seatable.some((p) => p.name === cur)) return cur;
      return seatable[0]?.name ?? "";
    });
  }, [seatable]);

  // The seat currently in effect for the selected person (0 = centre when they
  // have no explicit seat yet).
  const current = selected ? (positions[selected] ?? 0) : 0;

  const move = (deg: number) => {
    if (!selected) return;
    onSetPosition(selected, deg);
  };

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="spatial-dialog-heading"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="w-full max-w-md rounded-xl border border-sonic-600 bg-sonic-800 p-4 text-sonic-100 shadow-2xl backdrop:bg-black/70"
    >
      <div className="mb-4 flex items-center gap-2">
        <Move3d className="h-5 w-5 text-sonic-accent" aria-hidden="true" />
        <h2 id="spatial-dialog-heading" className="text-base font-semibold text-sonic-100">
          {m.spatial_dialog_heading()}
        </h2>
        <button
          onClick={onClose}
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
          aria-label={m.spatial_dialog_close()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {seatable.length === 0 ? (
        <p className="text-sm text-sonic-300">{m.spatial_dialog_empty()}</p>
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="spatial-peer" className="mb-1 block text-xs font-medium text-sonic-300">
              {m.spatial_peer_label()}
            </label>
            <select
              id="spatial-peer"
              ref={selectRef}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full rounded-lg border border-sonic-600 bg-sonic-700 px-2.5 py-1.5 text-sm text-sonic-100 focus:border-sonic-accent focus:outline-none"
            >
              {seatable.map((p) => (
                <option key={p.key} value={p.name}>
                  {p.self ? m.spatial_you({ name: p.name }) : p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="spatial-position"
              className="mb-1 block text-xs font-medium text-sonic-300"
            >
              {m.spatial_position_label()}
            </label>
            <input
              id="spatial-position"
              type="range"
              min={MIN_DEG}
              max={MAX_DEG}
              step={STEP_DEG}
              value={current}
              onChange={(e) => move(parseInt(e.target.value, 10))}
              // The value is spoken as a direction, not a raw number.
              aria-valuetext={describeDegrees(current)}
              aria-describedby="spatial-help"
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
            />
            <p className="mt-1 text-xs text-sonic-400">{describeDegrees(current)}</p>
          </div>

          <p id="spatial-help" className="text-xs text-sonic-400">
            {m.spatial_dialog_help()}
            {/* You never hear your own voice, so say what moving yourself does —
                otherwise it looks like the slider did nothing. */}
            {selected === myName && ` ${m.spatial_self_hint()}`}
            {/* Seating is shared, but HEARING it is a local choice — say so, or
                someone with spatial audio off would think the panel is broken. */}
            {!spatialAudio && ` ${m.spatial_dialog_disabled_hint()}`}
          </p>
        </div>
      )}
    </dialog>
  );
}
