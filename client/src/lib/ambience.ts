import { m } from "../paraglide/messages.js";

// Acoustic "ambiences" — reverb spaces you can drop the whole room into, like a
// reverb plugin's presets (concert hall, car cabin, room, cathedral…). No audio
// files: each space is a convolution reverb whose impulse response is generated
// procedurally, so it costs nothing to ship and applies to EVERYTHING you hear.
//
// Wet levels are kept modest on purpose — this is a screen-reader-first app, so
// voices have to stay intelligible even "inside" a big hall.

export interface Ambience {
  id: string;
  // Impulse length in seconds (the reverb tail) — bigger space, longer tail.
  duration: number;
  // Decay exponent: higher = the tail dies faster (tighter, more damped).
  decay: number;
  // Silence before the tail (seconds) — bigger spaces have a longer pre-delay.
  preDelay: number;
  // Wet mix 0–1 (how much reverb returns into the speakers). 0 = dry.
  wet: number;
  // High-frequency damping 0–1: 0 = bright/harsh, 1 = dark/warm. Softens the
  // white-noise edge so the wash sounds like a real room, not hiss.
  damp: number;
  // Early-reflection strength 0–1: discrete taps up front that give the space its
  // BODY (the "room" impression a plain noise tail lacks). This is most of what
  // makes a reverb read as a real place instead of a soft wash.
  er: number;
}

// "seco" (dry) is the off state — no reverb. The rest go roughly small → huge.
// Wet levels are deliberately BOLD (this is for a party) — voices colour a lot.
export const AMBIENCES: Ambience[] = [
  { id: "seco", duration: 0, decay: 1, preDelay: 0, wet: 0, damp: 0, er: 0 },
  { id: "auto", duration: 0.2, decay: 4, preDelay: 0.003, wet: 0.32, damp: 0.55, er: 0.8 },
  { id: "habitacion", duration: 0.9, decay: 2.3, preDelay: 0.008, wet: 0.42, damp: 0.28, er: 0.65 },
  { id: "bano", duration: 1.5, decay: 1.9, preDelay: 0.004, wet: 0.52, damp: 0.08, er: 0.75 },
  { id: "concierto", duration: 3.0, decay: 1.6, preDelay: 0.022, wet: 0.58, damp: 0.2, er: 0.55 },
  { id: "catedral", duration: 6.0, decay: 1.35, preDelay: 0.045, wet: 0.66, damp: 0.24, er: 0.45 },
  { id: "estadio", duration: 4.8, decay: 1.25, preDelay: 0.09, wet: 0.62, damp: 0.32, er: 0.6 },
];

export const DEFAULT_AMBIENCE = "seco";

export function findAmbience(id: string): Ambience | undefined {
  return AMBIENCES.find((a) => a.id === id);
}

// Localized name for a preset id (Paraglide messages are static per key, so we
// switch here rather than interpolate an id).
export function ambienceName(id: string): string {
  switch (id) {
    case "auto": return m.ambience_auto();
    case "habitacion": return m.ambience_habitacion();
    case "bano": return m.ambience_bano();
    case "concierto": return m.ambience_concierto();
    case "catedral": return m.ambience_catedral();
    case "estadio": return m.ambience_estadio();
    default: return m.ambience_seco();
  }
}

// Build a stereo impulse response for a space. Two layers make it read as a real
// place rather than a soft "shhh":
//   1. Early reflections — discrete taps in the first ~120 ms (offset per channel
//      for stereo width). This is the space's BODY.
//   2. A diffuse decaying tail, one-pole low-passed by `damp` so it's a warm wash
//      instead of white hiss, then shaped by the decay envelope.
export function buildImpulseResponse(ctx: BaseAudioContext, amb: Ambience): AudioBuffer {
  const rate = ctx.sampleRate;
  const tail = Math.max(1, Math.floor(rate * amb.duration));
  const pre = Math.floor(rate * amb.preDelay);
  const len = pre + tail;
  const buffer = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);

    // Diffuse tail.
    let lp = 0;
    for (let i = 0; i < tail; i++) {
      const env = Math.pow(1 - i / tail, amb.decay);
      const white = Math.random() * 2 - 1;
      lp += amb.damp * (white - lp); // one-pole low-pass → warmth
      data[pre + i] = ((1 - amb.damp) * white + lp) * env;
    }

    // Early reflections layered on top (a touch later/decorrelated on the right
    // channel for width).
    if (amb.er > 0) {
      const count = 8;
      for (let k = 0; k < count; k++) {
        const frac = (k + 1) / count;
        const tapT = (0.006 + 0.11 * frac) * (ch === 0 ? 1 : 1.09);
        const idx = pre + Math.floor(rate * tapT);
        if (idx < len) data[idx] += amb.er * (1 - frac) * (k % 2 === 0 ? 1 : -1);
      }
    }
  }
  return buffer;
}
