// Spatial-audio geometry: where each participant sits on the floor around you,
// plus a separate height. Kept out of the hook so the store and the Ctrl+Alt+U
// panel can share the types and helpers without importing it.
//
// Distance-as-volume was intentionally removed — it read as "quieter", not
// "further", and isn't really part of the 3D cue we want. Spatial audio here
// conveys DIRECTION only: the panner uses the seat's direction, never its
// magnitude, so walking around never changes how loud anyone is.

// A seat: a spot on the floor around the listener, plus height.
//   x  left(−) … right(+)
//   z  back(−) … front(+)   (front = ahead of you)
//   y  down(−) … up(+)
// Units are grid steps (≈ metres); only the direction matters for the panner.
export interface SpatialSeat {
  x: number;
  z: number;
  y: number;
}

// Floor + height ranges/steps — shared by the "walking" panel and the server
// snap. The floor is a bounded grid you step across with the arrow keys.
export const FLOOR_MIN = -4;
export const FLOOR_MAX = 4;
export const FLOOR_STEP = 1;
export const HEIGHT_MIN = -3;
export const HEIGHT_MAX = 3;
export const HEIGHT_STEP = 1;

// Radius of the automatic ring; the default seat is straight ahead.
export const SPATIAL_RADIUS = 2;
export const DEFAULT_SEAT: SpatialSeat = { x: 0, z: SPATIAL_RADIUS, y: 0 };

// Web Audio's listener sits at the origin facing −Z, +X right, +Y up. Our z is
// "front positive", so it maps onto the panner's −Z.
export function seatToPoint({ x, y, z }: SpatialSeat) {
  return { x, y, z: -z };
}

// Clamp + snap a seat to the grid (client-side, mirrored by the server).
export function snapSeat(seat: SpatialSeat): SpatialSeat {
  const snap = (v: number, min: number, max: number, step: number) =>
    Math.min(max, Math.max(min, Math.round(v / step) * step));
  return {
    x: snap(seat.x, FLOOR_MIN, FLOOR_MAX, FLOOR_STEP),
    z: snap(seat.z, FLOOR_MIN, FLOOR_MAX, FLOOR_STEP),
    y: snap(seat.y, HEIGHT_MIN, HEIGHT_MAX, HEIGHT_STEP),
  };
}

// Even seat for a participant with no explicit position — and for the
// "auto-position everyone" mode. Spread evenly across a frontal arc at ear
// level and a fixed radius, so voices come out separated, no two share a spot,
// and nobody sits dead centre (which would have no direction at all).
const AUTO_ARC_DEG = 160;
export function autoSeat(index: number, total: number): SpatialSeat {
  const t = total <= 1 ? 0.5 : index / (total - 1);
  const az = (-AUTO_ARC_DEG / 2 + t * AUTO_ARC_DEG) * (Math.PI / 180);
  return { x: Math.sin(az) * SPATIAL_RADIUS, z: Math.cos(az) * SPATIAL_RADIUS, y: 0 };
}
