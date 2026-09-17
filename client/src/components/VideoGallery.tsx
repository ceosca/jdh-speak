import { useEffect, useState } from "react";
import type { PeerState } from "../stores/room";
import { m } from "../paraglide/messages.js";

// A dedicated VIDEO gallery, shown only when at least one participant has their camera on.
// Why it exists: video used to be a 128px strip inside each (small) participant card in a
// 2/3/4-column grid, so with cameras on everyone showed as a cramped row of thumbnails —
// hard to actually SEE each face ("se ven como hileras", Kati). This lays the cameras out
// as a real video-call gallery: large 16:9 tiles whose column count adapts to how many
// cameras are on AND the viewport, so faces stay big and legible. It is purely visual
// (aria-hidden) — the accessible roster below still carries every name/status/control, so
// a screen-reader user loses nothing.

// Optimal column count for `count` tiles, capped at `maxCols` (from the viewport). 1–3
// cameras get their own row (1, 2, or 3 across); 4+ use ~sqrt so they form a balanced grid
// (4→2×2, 6→3×2, 9→3×3) with the biggest possible tiles rather than one long thin row.
export function galleryColumns(count: number, maxCols: number): number {
  if (count <= 1) return 1;
  const desired = count <= 3 ? count : Math.ceil(Math.sqrt(count));
  return Math.max(1, Math.min(desired, maxCols));
}

// Column cap by viewport width: phones 2, tablets 3, desktops 4. Tracked live so rotating
// the phone / resizing re-flows the gallery.
function useMaxCols(): number {
  const compute = () => {
    if (typeof window === "undefined") return 4;
    const w = window.innerWidth;
    return w < 640 ? 2 : w < 1024 ? 3 : 4;
  };
  const [maxCols, setMaxCols] = useState(compute);
  useEffect(() => {
    const onResize = () => setMaxCols(compute());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return maxCols;
}

interface VideoTile {
  peer: PeerState;
  isLocal: boolean;
}

export function VideoGallery({ tiles }: { tiles: VideoTile[] }) {
  const maxCols = useMaxCols();
  if (tiles.length === 0) return null;
  const cols = galleryColumns(tiles.length, maxCols);
  const solo = tiles.length === 1;

  return (
    // Purely visual — the screen reader reads the participant roster below, so hide this
    // whole gallery from it to avoid reading every name twice.
    <div
      aria-hidden="true"
      className="mx-auto mb-6 grid w-full justify-items-center gap-3"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {tiles.map(({ peer, isLocal }) => {
        const speaking = peer.isSpeaking && !peer.isMusic && !peer.isMuted;
        const nameWithYou = isLocal ? `${peer.displayName} (${m.card_you()})` : peer.displayName;
        return (
          <div
            key={peer.peerId}
            className={`relative aspect-video w-full overflow-hidden rounded-xl border bg-black ${
              solo ? "max-w-2xl" : ""
            } ${speaking ? "border-green-400 ring-2 ring-green-400/70" : "border-sonic-600"}`}
          >
            {peer.videoStream ? (
              <video
                autoPlay
                playsInline
                muted
                ref={(el) => {
                  if (el && el.srcObject !== peer.videoStream) el.srcObject = peer.videoStream;
                }}
                // object-cover fills the 16:9 tile (no black bars) like every video-call
                // gallery; a webcam is centred so the slight edge crop doesn't lose the face.
                className={`h-full w-full bg-black object-cover ${isLocal ? "-scale-x-100" : ""}`}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-sonic-500">
                {/* videoOn but no stream yet (negotiating) — a neutral placeholder. */}
                <span className="text-sm">{nameWithYou}</span>
              </div>
            )}

            {/* Name + mic status pill, overlaid bottom-left, readable over any frame. */}
            <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center gap-1.5">
              <span
                className={`inline-flex max-w-full items-center gap-1.5 truncate rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    peer.isMuted ? "bg-[var(--status-danger)]" : "bg-[var(--status-ok)]"
                  }`}
                />
                <span className="truncate">{nameWithYou}</span>
              </span>
            </div>

            {/* Talking badge top-right (extra cue beyond the ring — not colour alone). */}
            {speaking && (
              <span className="absolute right-2 top-2 rounded-full bg-green-500/25 px-2 py-0.5 text-xs font-medium text-[var(--status-ok)]">
                {m.card_speaking_now()}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
