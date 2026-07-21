import { useEffect, useMemo, useRef, useState } from "react";
import { Move3d, X } from "lucide-react";
import { useRoomStore } from "../stores/room";
import {
  AZ_MIN, AZ_MAX, AZ_STEP,
  EL_MIN, EL_MAX, EL_STEP,
  DIST_MIN, DIST_MAX, DIST_STEP,
  DEFAULT_SEAT,
  type SpatialSeat,
} from "../lib/spatial";
import { m } from "../paraglide/messages.js";

interface SpatialDialogProps {
  onClose: () => void;
  // Moves a participant's seat. Room-wide — the server broadcasts it, so every
  // listener hears that person from the new direction. Called live while the
  // slider moves (there's no Save button; changes apply as you go).
  onSetPosition: (name: string, seat: SpatialSeat) => void;
}

// Spoken descriptions — a bare number ("-135") means nothing when you can't see
// the slider, so the screen reader gets words instead.

// Azimuth around the full circle: 0 = ahead, ±180 = behind, - = left, + = right.
function describeAzimuth(deg: number): string {
  if (deg === 0) return m.spatial_az_front();
  if (Math.abs(deg) === 180) return m.spatial_az_back();
  const amount = Math.abs(deg);
  const side = deg < 0 ? m.spatial_side_left() : m.spatial_side_right();
  if (amount === 90) return m.spatial_az_side({ side, deg: amount });
  const zone = amount < 90 ? m.spatial_zone_front() : m.spatial_zone_back();
  return m.spatial_az_full({ side, deg: amount, zone });
}

function describeElevation(deg: number): string {
  if (deg === 0) return m.spatial_el_level();
  const amount = Math.abs(deg);
  return deg > 0 ? m.spatial_el_up({ deg: amount }) : m.spatial_el_down({ deg: amount });
}

function describeDistance(metres: number): string {
  return m.spatial_dist_value({ m: metres.toFixed(1).replace(".", ",") });
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

  // The seat currently in effect for the selected person (the default when they
  // haven't been placed yet).
  const current = (selected ? positions[selected] : undefined) ?? DEFAULT_SEAT;

  // Every slider sends the WHOLE seat, so moving one axis never resets another.
  const move = (patch: Partial<SpatialSeat>) => {
    if (!selected) return;
    onSetPosition(selected, { ...current, ...patch });
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

          {/* Three axes, in the order they matter audibly: direction all the way
              around, then distance (the strongest depth cue), then height. */}
          <div>
            <label htmlFor="spatial-az" className="mb-1 block text-xs font-medium text-sonic-300">
              {m.spatial_az_label()}
            </label>
            <input
              id="spatial-az"
              type="range"
              min={AZ_MIN}
              max={AZ_MAX}
              step={AZ_STEP}
              value={current.az}
              onChange={(e) => move({ az: parseInt(e.target.value, 10) })}
              aria-valuetext={describeAzimuth(current.az)}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
            />
            <p className="mt-1 text-xs text-sonic-400">{describeAzimuth(current.az)}</p>
          </div>

          <div>
            <label htmlFor="spatial-dist" className="mb-1 block text-xs font-medium text-sonic-300">
              {m.spatial_dist_label()}
            </label>
            <input
              id="spatial-dist"
              type="range"
              min={DIST_MIN}
              max={DIST_MAX}
              step={DIST_STEP}
              value={current.dist}
              onChange={(e) => move({ dist: parseFloat(e.target.value) })}
              aria-valuetext={describeDistance(current.dist)}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
            />
            <p className="mt-1 text-xs text-sonic-400">{describeDistance(current.dist)}</p>
          </div>

          <div>
            <label htmlFor="spatial-el" className="mb-1 block text-xs font-medium text-sonic-300">
              {m.spatial_el_label()}
            </label>
            <input
              id="spatial-el"
              type="range"
              min={EL_MIN}
              max={EL_MAX}
              step={EL_STEP}
              value={current.el}
              onChange={(e) => move({ el: parseInt(e.target.value, 10) })}
              aria-valuetext={describeElevation(current.el)}
              aria-describedby="spatial-el-note"
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
            />
            <p className="mt-1 text-xs text-sonic-400">{describeElevation(current.el)}</p>
            {/* Set expectations: generic HRTFs render height weakly, so this is
                the subtlest axis by far. Saying so beats "is it even working?". */}
            <p id="spatial-el-note" className="mt-0.5 text-xs text-sonic-500">
              {m.spatial_el_note()}
            </p>
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
