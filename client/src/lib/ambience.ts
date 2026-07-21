import { m } from "../paraglide/messages.js";

// Acoustic "ambiences" — reverb spaces the whole room drops into, like a reverb
// plugin's room presets. No audio files: each space is a convolution reverb
// whose impulse response is generated procedurally, so it costs nothing to ship
// and applies to EVERYTHING you hear.
//
// Each space is defined by the distances to its six walls (in metres) — the same
// "auralization by room geometry" idea a proper spatializer uses. From those we
// derive physically-plausible early reflections (each wall → a tap at its
// round-trip delay) and a tail sized to the room, so the spaces sound like real
// places, not a generic wash. The metres are modelled on well-known reference
// rooms (car, living room, studio, concert hall, cathedral, arena…).

export interface Ambience {
  id: string;
  // Distances to the six walls in metres: [left, front, right, top, back, floor].
  // 0 = open (no wall / outdoors) → no reflection from that side.
  walls: [number, number, number, number, number, number];
  // Wet mix 0–1 (how much reverb returns into the speakers). 0 = dry. Bold on
  // purpose — this is for a party, voices colour a lot.
  wet: number;
  // High-frequency damping 0–1: 0 = bright/live (tile, stone), 1 = dark/soft.
  damp: number;
}

// Curated from reference room geometries, small → huge. "seco" (dry) is off.
export const AMBIENCES: Ambience[] = [
  { id: "seco", walls: [0, 0, 0, 0, 0, 0], wet: 0, damp: 0 },
  { id: "auto", walls: [0.6, 0.7, 1.7, 1.6, 1.9, 1.3], wet: 0.34, damp: 0.55 },
  { id: "bano", walls: [2.1, 2.0, 2.3, 2.8, 1.6, 1.8], wet: 0.5, damp: 0.05 },
  { id: "habitacion", walls: [2.3, 3.1, 2.7, 2.9, 2.6, 1.8], wet: 0.4, damp: 0.35 },
  { id: "sotano", walls: [2.5, 2.8, 3.0, 3.2, 2.1, 1.8], wet: 0.5, damp: 0.45 },
  { id: "estudio", walls: [6.7, 3.4, 6.9, 8.0, 3.3, 1.8], wet: 0.42, damp: 0.25 },
  { id: "escenario", walls: [11.7, 5.4, 11.9, 16.5, 14.3, 1.8], wet: 0.55, damp: 0.22 },
  { id: "concierto", walls: [12.9, 14.0, 10.5, 20.8, 25.1, 1.8], wet: 0.6, damp: 0.2 },
  { id: "iglesia", walls: [13.9, 17.9, 11.5, 25.5, 22.1, 1.8], wet: 0.62, damp: 0.18 },
  { id: "estadio", walls: [20.2, 17.0, 21.5, 25.0, 15.7, 1.8], wet: 0.62, damp: 0.3 },
  { id: "catedral", walls: [27.5, 24.2, 29.0, 30.0, 30.0, 1.8], wet: 0.68, damp: 0.22 },
  { id: "calle", walls: [24.9, 0, 22.5, 0, 0, 1.8], wet: 0.34, damp: 0.25 },
];

export const DEFAULT_AMBIENCE = "seco";
const SPEED_OF_SOUND = 343; // m/s

export function findAmbience(id: string): Ambience | undefined {
  return AMBIENCES.find((a) => a.id === id);
}

// Localized name for a preset id (Paraglide messages are static per key).
export function ambienceName(id: string): string {
  switch (id) {
    case "auto": return m.ambience_auto();
    case "bano": return m.ambience_bano();
    case "habitacion": return m.ambience_habitacion();
    case "sotano": return m.ambience_sotano();
    case "estudio": return m.ambience_estudio();
    case "escenario": return m.ambience_escenario();
    case "concierto": return m.ambience_concierto();
    case "iglesia": return m.ambience_iglesia();
    case "estadio": return m.ambience_estadio();
    case "catedral": return m.ambience_catedral();
    case "calle": return m.ambience_calle();
    default: return m.ambience_seco();
  }
}

// Build a stereo impulse response for a space from its wall geometry:
//   • Early reflections: one tap per real wall, at its round-trip delay
//     (2·distance / speed-of-sound), louder for nearer walls — this is the
//     space's BODY and what makes it read as a real place.
//   • A diffuse decaying tail whose length scales with the room's mean size and
//     whose decay shape tightens for small rooms; one-pole low-passed by `damp`
//     for warmth instead of white hiss.
export function buildImpulseResponse(ctx: BaseAudioContext, amb: Ambience): AudioBuffer {
  const rate = ctx.sampleRate;
  const present = amb.walls.filter((w) => w > 0);
  const mean = present.length ? present.reduce((a, b) => a + b, 0) / present.length : 1;
  const duration = Math.min(6, Math.max(0.1, mean * 0.2)); // bigger room → longer tail
  const decay = Math.min(4.5, Math.max(1.2, 4 - mean * 0.1)); // small room → tighter
  const front = amb.walls[1] || mean;
  const pre = Math.floor(rate * Math.min(0.06, front / SPEED_OF_SOUND));
  const tail = Math.max(1, Math.floor(rate * duration));
  const len = pre + tail;
  const buffer = ctx.createBuffer(2, len, rate);

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);

    // Diffuse tail.
    let lp = 0;
    for (let i = 0; i < tail; i++) {
      const env = Math.pow(1 - i / tail, decay);
      const white = Math.random() * 2 - 1;
      lp += amb.damp * (white - lp); // one-pole low-pass → warmth
      data[pre + i] = ((1 - amb.damp) * white + lp) * env;
    }

    // Early reflection per real wall (slightly decorrelated on the right channel).
    amb.walls.forEach((d, wi) => {
      if (d <= 0) return;
      const delay = ((2 * d) / SPEED_OF_SOUND) * (ch === 0 ? 1 : 1.06);
      const idx = Math.floor(rate * delay);
      if (idx < len) data[idx] += Math.min(0.9, 1.4 / (d + 0.7)) * (wi % 2 ? -1 : 1);
    });
  }
  return buffer;
}
