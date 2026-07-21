import { useEffect, useMemo, useRef, useState } from "react";
import { Move3d, X } from "lucide-react";
import { useRoomStore } from "../stores/room";
import {
  FLOOR_MIN, FLOOR_MAX, FLOOR_STEP,
  HEIGHT_MIN, HEIGHT_MAX, HEIGHT_STEP,
  DEFAULT_SEAT,
  type SpatialSeat,
} from "../lib/spatial";
import { m } from "../paraglide/messages.js";

interface SpatialDialogProps {
  onClose: () => void;
  // Moves a participant's seat. Room-wide — the server broadcasts it, so every
  // listener hears that person from the new spot. Applied live as you walk.
  onSetPosition: (name: string, seat: SpatialSeat) => void;
  // Toggle "auto-position everyone" for the whole room.
  onSetAutoAll: (enabled: boolean) => void;
}

const clampFloor = (v: number) => Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, v));
const clampHeight = (v: number) => Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, v));

// Spoken descriptions — a bare "1, -2" means nothing when you can't see the
// pad, so the screen reader gets a direction in words. One key per octant keeps
// the Spanish grammar clean (no runtime string-stitching).
function describeDir(x: number, z: number): string {
  if (x === 0 && z === 0) return m.spatial_dir_center();
  if (z > 0 && x === 0) return m.spatial_dir_front();
  if (z < 0 && x === 0) return m.spatial_dir_back();
  if (z === 0 && x < 0) return m.spatial_dir_left();
  if (z === 0 && x > 0) return m.spatial_dir_right();
  if (z > 0 && x < 0) return m.spatial_dir_front_left();
  if (z > 0 && x > 0) return m.spatial_dir_front_right();
  if (z < 0 && x < 0) return m.spatial_dir_back_left();
  return m.spatial_dir_back_right();
}

function describeHeight(y: number): string {
  return y > 0 ? m.spatial_h_up() : y < 0 ? m.spatial_h_down() : m.spatial_h_level();
}

function describeSeat(seat: SpatialSeat): string {
  return m.spatial_pos_full({ dir: describeDir(seat.x, seat.z), height: describeHeight(seat.y) });
}

// Hidden 3D-seating panel (Ctrl+Alt+U). Deliberately not reachable from any
// button: like the recording and bitrate shortcuts, if you don't know the key
// combo the UI doesn't exist — so nobody moves people around by accident.
//
// You "walk" the selected person around the floor with the arrow keys (or the
// buttons); Page Up / Page Down raise and lower them. Applies + saves live.
export function SpatialDialog({ onClose, onSetPosition, onSetAutoAll }: SpatialDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const peers = useRoomStore((s) => s.peers);
  const positions = useRoomStore((s) => s.spatialPositions);
  const spatialAudio = useRoomStore((s) => s.spatialAudio);
  const autoAll = useRoomStore((s) => s.spatialAutoAll);
  const myName = useRoomStore((s) => s.displayName);
  const [selected, setSelected] = useState("");

  // Everyone in the room, INCLUDING yourself (your seat is what others hear).
  // Music casters are excluded — they're never spatialised.
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

  useEffect(() => {
    setSelected((cur) => {
      if (cur && seatable.some((p) => p.name === cur)) return cur;
      return seatable[0]?.name ?? "";
    });
  }, [seatable]);

  // The seat in effect for the selected person (default until they're placed).
  const current = (selected ? positions[selected] : undefined) ?? DEFAULT_SEAT;

  const walk = (dx: number, dz: number) => {
    if (!selected || autoAll) return;
    onSetPosition(selected, {
      ...current,
      x: clampFloor(current.x + dx * FLOOR_STEP),
      z: clampFloor(current.z + dz * FLOOR_STEP),
    });
  };
  const lift = (dy: number) => {
    if (!selected || autoAll) return;
    onSetPosition(selected, { ...current, y: clampHeight(current.y + dy * HEIGHT_STEP) });
  };

  const onPadKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowUp": e.preventDefault(); walk(0, +1); break; // forward
      case "ArrowDown": e.preventDefault(); walk(0, -1); break; // back
      case "ArrowLeft": e.preventDefault(); walk(-1, 0); break;
      case "ArrowRight": e.preventDefault(); walk(+1, 0); break;
      case "PageUp": e.preventDefault(); lift(+1); break;
      case "PageDown": e.preventDefault(); lift(-1); break;
      default: break;
    }
  };

  const btn =
    "rounded-lg border border-sonic-600 bg-sonic-700 px-2 py-2 text-sm text-sonic-100 hover:bg-sonic-600 disabled:opacity-40";

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

      {/* Auto-position everyone: seat all participants on the even spread; when
          off, each goes back to their configured seat. */}
      <label className="mb-3 flex items-center gap-2 text-sm text-sonic-100">
        <input
          type="checkbox"
          checked={autoAll}
          onChange={(e) => onSetAutoAll(e.target.checked)}
          className="h-4 w-4 accent-sonic-accent"
        />
        {m.spatial_auto_label()}
      </label>

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

          {/* Walk pad: focusable, takes arrows (floor) + Page Up/Down (height).
              Buttons do the same for mouse/touch. Disabled while auto-position
              is on (the configured seat is ignored until you turn it off). */}
          <div
            role="group"
            aria-label={`${m.spatial_pos_label()}: ${describeSeat(current)}`}
            tabIndex={0}
            onKeyDown={onPadKey}
            className="rounded-lg border border-sonic-600 bg-sonic-900/40 p-2 focus:outline-none focus:ring-2 focus:ring-sonic-accent"
          >
            <p className="mb-2 text-sm text-sonic-100">{describeSeat(current)}</p>
            <div className="grid grid-cols-3 gap-1.5">
              <button className={btn} onClick={() => walk(-1, 0)} disabled={autoAll}>{m.spatial_walk_left()}</button>
              <button className={btn} onClick={() => walk(0, +1)} disabled={autoAll}>{m.spatial_walk_forward()}</button>
              <button className={btn} onClick={() => walk(+1, 0)} disabled={autoAll}>{m.spatial_walk_right()}</button>
              <button className={btn} onClick={() => lift(-1)} disabled={autoAll}>{m.spatial_walk_down()}</button>
              <button className={btn} onClick={() => walk(0, -1)} disabled={autoAll}>{m.spatial_walk_back()}</button>
              <button className={btn} onClick={() => lift(+1)} disabled={autoAll}>{m.spatial_walk_up()}</button>
            </div>
          </div>
          {/* Announce the new spot on every move (aria-label changes aren't spoken). */}
          <p aria-live="polite" className="sr-only">
            {describeSeat(current)}
          </p>

          <p id="spatial-help" className="text-xs text-sonic-400">
            {m.spatial_walk_help()}
            {/* You never hear your own voice, so say what moving yourself does. */}
            {selected === myName && ` ${m.spatial_self_hint()}`}
            {/* Hearing the seating is a local choice — say so, or the panel looks broken. */}
            {!spatialAudio && ` ${m.spatial_dialog_disabled_hint()}`}
            {autoAll && ` ${m.spatial_auto_hint()}`}
          </p>
        </div>
      )}
    </dialog>
  );
}
