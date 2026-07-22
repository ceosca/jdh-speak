// Acoustic "ambiences" — reverb spaces the whole room drops into, like a reverb
// plugin's room presets. No audio files: each space is a convolution reverb whose
// impulse response is generated procedurally from the room's geometry, so it
// costs nothing to ship and applies to EVERYTHING you hear.
//
// The full set of spaces (and their per-room character) is modelled on a
// well-known immersive-reverb plugin's factory rooms: each has real wall
// distances (metres) — from which we build physically-plausible early
// reflections and a tail sized to the room — plus a per-room damping taken from
// how bright/dark that space's reflections are. Nothing here is invented; the
// numbers come straight from those reference rooms.

export interface Ambience {
  id: string;
  name: string;
  // Distances to the six walls in metres: [left, front, right, top, back, floor].
  // 0 = open (outdoors) → no reflection from that side.
  walls: number[];
  // High-frequency damping 0–1: 0 = bright/live (tile, stone), 1 = dark/soft.
  // Only used for the procedural spaces (see buildImpulseResponse).
  damp: number;
  // When true, a REAL recorded impulse response is loaded from `/ir/<id>.ogg`
  // instead of the procedural one — genuine convolution of a real space. These
  // are CC-BY recordings from OpenAIR (openairlib.net); see the panel credit.
  real?: boolean;
}

// "seco" (dry) is off. The rest are the reference plugin's rooms, small → huge.
export const AMBIENCES: Ambience[] = [
  { id: "seco", name: "Seco (sin efecto)", walls: [0, 0, 0, 0, 0, 0], damp: 0 },
  { id: "auto1", name: "Auto 1", walls: [0.6, 0.7, 1.7, 1.6, 1.9, 1.3], damp: 0.55 },
  { id: "auto2", name: "Auto 2", walls: [0.5, 0.7, 1.0, 1.3, 1.6, 1.2], damp: 0.4 },
  { id: "bano", name: "Baño", walls: [2.1, 2.0, 2.3, 2.8, 1.6, 1.8], damp: 0.13 },
  { id: "toilette", name: "Toilette", walls: [2.7, 1.5, 3.2, 4.2, 2.3, 1.8], damp: 0.13 },
  { id: "cabina", name: "Cabina", walls: [3.7, 2.1, 3.3, 2.5, 1.3, 1.8], damp: 0.53 },
  { id: "estudiochico", name: "Estudio chico", walls: [2.7, 2.0, 3.4, 4.7, 2.1, 1.8], damp: 0.52 },
  { id: "estudio", name: "Estudio", walls: [6.7, 3.4, 6.9, 8.0, 3.3, 1.8], damp: 0.48 },
  { id: "living", name: "Living", walls: [2.3, 3.1, 2.7, 2.9, 2.6, 1.8], damp: 0.53 },
  { id: "salachica", name: "Sala chica", walls: [2.7, 1.5, 2.6, 3.6, 2.2, 1.8], damp: 0.47 },
  { id: "salamedia", name: "Sala media", walls: [3.8, 2.1, 4.1, 4.0, 2.8, 1.8], damp: 0.55 },
  { id: "salagrande", name: "Sala grande", walls: [7.9, 4.4, 6.9, 10.0, 5.5, 1.8], damp: 0.53 },
  { id: "vacia", name: "Sala vacía", walls: [5.0, 3.2, 3.7, 5.8, 4.3, 1.8], damp: 0.53 },
  { id: "oficina1", name: "Oficina 1", walls: [3.2, 1.9, 3.9, 4.5, 2.8, 1.8], damp: 0.52 },
  { id: "oficina2", name: "Oficina 2", walls: [6.7, 2.4, 6.9, 5.3, 3.3, 1.8], damp: 0.52 },
  { id: "sotano", name: "Sótano", walls: [2.5, 2.8, 3.0, 3.2, 2.1, 1.8], damp: 0.56 },
  { id: "escalera", name: "Escalera", walls: [4.7, 3.5, 4.9, 8.0, 3.3, 1.8], damp: 0.47, real: true },
  { id: "pasillo", name: "Pasillo", walls: [2.7, 2.0, 2.6, 8.8, 4.5, 1.8], damp: 0.65 },
  { id: "cine", name: "Cine", walls: [8.0, 7.0, 9.0, 14.0, 9.0, 1.3], damp: 0.54 },
  { id: "conferencias", name: "Sala de conferencias", walls: [6.7, 3.4, 6.9, 7.0, 3.3, 1.8], damp: 0.55 },
  { id: "deposito", name: "Depósito", walls: [12.0, 10.0, 8.0, 20.0, 15.0, 1.8], damp: 0.4 },
  { id: "capilla", name: "Capilla", walls: [14.7, 12.4, 14.1, 23.0, 16.3, 1.8], damp: 0.48, real: true },
  { id: "iglesia", name: "Iglesia", walls: [13.9, 17.9, 11.5, 25.5, 22.1, 1.8], damp: 0.48 },
  { id: "catedral", name: "Catedral", walls: [27.5, 24.2, 29.0, 30.0, 30.0, 1.8], damp: 0.47, real: true },
  { id: "salonreal", name: "Salón real", walls: [13.7, 10.4, 13.9, 20.3, 7.3, 1.8], damp: 0.43, real: true },
  { id: "concierto1", name: "Sala de concierto 1", walls: [12.9, 14.0, 10.5, 20.8, 25.1, 1.8], damp: 0.73, real: true },
  { id: "concierto2", name: "Sala de concierto 2", walls: [14.1, 16.6, 13.3, 21.5, 28.3, 1.8], damp: 0.27 },
  { id: "salaacustica", name: "Sala acústica", walls: [20.2, 15.0, 21.5, 25.0, 12.7, 1.8], damp: 0.05 },
  { id: "grabaciongrande", name: "Grabación grande", walls: [15.7, 12.1, 15.9, 22.2, 19.3, 1.8], damp: 0.27 },
  { id: "grabacionchica", name: "Grabación chica", walls: [7.7, 5.4, 7.9, 12.0, 9.3, 1.8], damp: 0.05 },
  { id: "escenario", name: "Escenario", walls: [11.7, 5.4, 11.9, 16.5, 14.3, 1.8], damp: 0.54 },
  { id: "arena", name: "Arena en vivo", walls: [20.2, 17.0, 21.5, 25.0, 15.7, 1.8], damp: 0.74 },
  { id: "bateria1", name: "Sala de batería 1", walls: [6.7, 3.1, 6.9, 8.0, 3.3, 1.8], damp: 0.59 },
  { id: "bateria2", name: "Sala de batería 2", walls: [2.7, 3.1, 2.9, 6.0, 4.3, 1.8], damp: 0.23 },
  { id: "voces1", name: "Sala de voces 1", walls: [20.2, 15.0, 21.5, 25.0, 12.7, 1.8], damp: 0.05 },
  { id: "voces2", name: "Sala de voces 2", walls: [20.2, 15.0, 21.5, 25.0, 12.7, 1.8], damp: 0.05 },
  { id: "cuerdas", name: "Sala de cuerdas", walls: [20.2, 15.0, 21.5, 25.0, 12.7, 1.8], damp: 0.05 },
  { id: "ambdenso", name: "Ambiente denso", walls: [6.7, 3.1, 6.9, 8.0, 3.3, 1.8], damp: 0.45 },
  { id: "ambmedio", name: "Ambiente medio", walls: [6.7, 3.1, 6.9, 8.0, 3.3, 1.8], damp: 0.45 },
  { id: "ambchico", name: "Ambiente chico", walls: [6.7, 3.1, 6.9, 8.0, 3.3, 1.8], damp: 0.53 },
  { id: "ambperc", name: "Ambiente percusión", walls: [6.7, 3.4, 6.9, 8.0, 4.3, 1.8], damp: 0.48 },
  { id: "placa", name: "Placa", walls: [6.7, 3.1, 6.9, 8.0, 3.3, 1.8], damp: 0.45 },
  { id: "placaperc", name: "Placa percusión", walls: [6.7, 3.4, 6.9, 8.0, 4.3, 1.8], damp: 0.45 },
  { id: "placacuerdas", name: "Placa de cuerdas", walls: [20.2, 15.0, 21.5, 25.0, 12.7, 1.8], damp: 0.05 },
  { id: "placavoces", name: "Placa de voces", walls: [20.2, 15.0, 21.5, 25.0, 12.7, 1.8], damp: 0.05 },
  { id: "calle", name: "Calle", walls: [24.9, 0.0, 22.5, 0.0, 0.0, 1.8], damp: 0.68 },
  { id: "callejon", name: "Callejón", walls: [14.2, 0.0, 16.5, 0.0, 3.1, 1.8], damp: 0.43 },
];

export const DEFAULT_AMBIENCE = "seco";
// Wet mix (how much reverb returns into the speakers). Bold — this is for a party.
export const AMBIENCE_WET = 0.3;

const SPEED_OF_SOUND = 343; // m/s
const IR_PEAK = 0.7; // peak-normalise each impulse so the raw energy can't clip

export function findAmbience(id: string): Ambience | undefined {
  return AMBIENCES.find((a) => a.id === id);
}

export function ambienceName(id: string): string {
  return findAmbience(id)?.name ?? "Seco";
}

// Build a stereo impulse response for a space from its wall geometry:
//   • Early reflections: one tap per real wall, at its round-trip delay
//     (2·distance / speed-of-sound), louder for nearer walls — the space's BODY.
//   • A diffuse decaying tail whose length scales with the room's mean size and
//     whose decay tightens for small rooms; low-passed by `damp` for warmth.
// Then peak-normalised so bigger rooms stay louder (more tail energy) without a
// single sample clipping — the convolver runs with normalize = false.
export function buildImpulseResponse(ctx: BaseAudioContext, amb: Ambience): AudioBuffer {
  const rate = ctx.sampleRate;
  const present = amb.walls.filter((w) => w > 0);
  const mean = present.length ? present.reduce((a, b) => a + b, 0) / present.length : 1;
  const duration = Math.min(6, Math.max(0.1, mean * 0.2));
  const decay = Math.min(4.5, Math.max(1.2, 4 - mean * 0.1));
  const front = amb.walls[1] || mean;
  const pre = Math.floor(rate * Math.min(0.06, front / SPEED_OF_SOUND));
  const tail = Math.max(1, Math.floor(rate * duration));
  const len = pre + tail;
  const buffer = ctx.createBuffer(2, len, rate);

  let peak = 1e-6;
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < tail; i++) {
      const env = Math.pow(1 - i / tail, decay);
      const white = Math.random() * 2 - 1;
      lp += amb.damp * (white - lp); // one-pole low-pass → warmth
      data[pre + i] = ((1 - amb.damp) * white + lp) * env;
    }
    amb.walls.forEach((d, wi) => {
      if (d <= 0) return;
      const delay = ((2 * d) / SPEED_OF_SOUND) * (ch === 0 ? 1 : 1.06);
      const idx = Math.floor(rate * delay);
      if (idx < len) data[idx] += Math.min(0.9, 1.4 / (d + 0.7)) * (wi % 2 ? -1 : 1);
    });
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]!));
  }
  const scale = IR_PEAK / peak;
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) data[i] *= scale;
  }
  return buffer;
}
