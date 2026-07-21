// Spatial-audio geometry: where each participant sits around the listener, and
// how that maps onto Web Audio. Kept out of the hook so the store and the
// Ctrl+Alt+U panel can share the types and helpers without importing it.

// A seat on the sphere around the listener:
//   az   -180…180 degrees — 0 = straight ahead, + = right, ±180 = behind
//   el    -90…90 degrees  — 0 = ear level, + = above
//   dist  metres from the listener
export interface SpatialSeat {
  az: number;
  el: number;
  dist: number;
}

// Spread used for the automatic (unconfigured) seating, and the default radius.
export const SPATIAL_ARC_DEG = 140;
export const SPATIAL_RADIUS = 1.6;

// Slider ranges/steps, shared by the panel and the server's snapping.
export const AZ_MIN = -180;
export const AZ_MAX = 180;
export const AZ_STEP = 5;
export const EL_MIN = -90;
export const EL_MAX = 90;
export const EL_STEP = 5;
export const DIST_MIN = 0.5;
export const DIST_MAX = 7;
export const DIST_STEP = 0.5;

export const DEFAULT_SEAT: SpatialSeat = { az: 0, el: 0, dist: SPATIAL_RADIUS };

// Web Audio's listener sits at the origin facing -Z, with +X right and +Y up.
export function seatToPoint({ az, el, dist }: SpatialSeat) {
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  const horizontal = Math.cos(e) * dist;
  return { x: Math.sin(a) * horizontal, y: Math.sin(e) * dist, z: -Math.cos(a) * horizontal };
}

// Seat for a peer with no explicit position: spread evenly across the frontal
// arc at ear level, so voices are separated out of the box.
export function autoSeat(index: number, total: number): SpatialSeat {
  const t = total <= 1 ? 0.5 : index / (total - 1);
  return { az: -SPATIAL_ARC_DEG / 2 + t * SPATIAL_ARC_DEG, el: 0, dist: SPATIAL_RADIUS };
}

// Air absorption: distant sources lose their highs. Web Audio's distance model
// only changes LEVEL, and level alone reads as "quieter", not "further away" —
// this dulling is what actually sells depth (it's what pro spatialisers do).
// ~18 kHz (effectively open) up close, down to ~2.5 kHz at the far end.
export function airAbsorptionHz(dist: number): number {
  const t = Math.min(1, Math.max(0, (dist - 1) / 6));
  return 18000 - t * 15500;
}
