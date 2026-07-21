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
}

// "seco" (dry) is the off state — no reverb. The rest go roughly small → huge.
export const AMBIENCES: Ambience[] = [
  { id: "seco", duration: 0, decay: 1, preDelay: 0, wet: 0 },
  { id: "auto", duration: 0.12, decay: 5, preDelay: 0, wet: 0.12 },
  { id: "habitacion", duration: 0.5, decay: 2.6, preDelay: 0.006, wet: 0.18 },
  { id: "bano", duration: 0.8, decay: 2.2, preDelay: 0.004, wet: 0.24 },
  { id: "concierto", duration: 2.2, decay: 2.0, preDelay: 0.02, wet: 0.28 },
  { id: "catedral", duration: 4.5, decay: 1.7, preDelay: 0.04, wet: 0.32 },
  { id: "estadio", duration: 3.6, decay: 1.4, preDelay: 0.06, wet: 0.3 },
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

// Build a stereo impulse response for a space: decaying noise (a different noise
// per channel for stereo width), with a pre-delay of silence up front. This is
// the classic cheap-but-convincing procedural reverb.
export function buildImpulseResponse(ctx: BaseAudioContext, amb: Ambience): AudioBuffer {
  const rate = ctx.sampleRate;
  const tail = Math.max(1, Math.floor(rate * amb.duration));
  const pre = Math.floor(rate * amb.preDelay);
  const buffer = ctx.createBuffer(2, pre + tail, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < tail; i++) {
      const env = Math.pow(1 - i / tail, amb.decay);
      data[pre + i] = (Math.random() * 2 - 1) * env;
    }
  }
  return buffer;
}
