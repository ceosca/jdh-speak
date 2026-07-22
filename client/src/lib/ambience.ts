// Acoustic "ambiences" — reverb spaces the whole room drops into. Each one is a
// REAL recorded impulse response (genuine convolution of an actual place), loaded
// on demand from `/ir/<id>.ogg`. No synthetic/procedural reverb: it either sounds
// like the real room or it isn't here.
//
// The impulses are recordings from OpenAIR (openairlib.net), licensed CC-BY — see
// the credit shown in the ambience panel.

export interface Ambience {
  id: string;
  name: string;
}

// "seco" (dry) is off; every other id has a matching /ir/<id>.ogg impulse.
export const AMBIENCES: Ambience[] = [
  { id: "seco", name: "Seco (sin efecto)" },
  { id: "catedral", name: "Catedral" },
  { id: "capilla", name: "Capilla" },
  { id: "iglesia", name: "Iglesia" },
  { id: "iglesiachica", name: "Iglesia chica" },
  { id: "concierto", name: "Sala de concierto" },
  { id: "auditorio", name: "Auditorio" },
  { id: "teatro", name: "Teatro" },
  { id: "salon", name: "Salón grande" },
  { id: "salonclub", name: "Salón de club" },
  { id: "palacio", name: "Salón de mármol" },
  { id: "estudio", name: "Estudio (live room)" },
  { id: "sala", name: "Sala" },
  { id: "aula", name: "Aula" },
  { id: "atrio", name: "Atrio" },
  { id: "museo", name: "Museo (hangar)" },
  { id: "escalera", name: "Escalera" },
  { id: "tunel", name: "Túnel" },
  { id: "mina", name: "Mina" },
  { id: "cueva", name: "Cueva" },
  { id: "tumba", name: "Tumba de piedra" },
  { id: "camara", name: "Cámara neolítica" },
  { id: "torre", name: "Torre de piedra" },
  { id: "mausoleo", name: "Mausoleo" },
  { id: "reactor", name: "Reactor nuclear" },
  { id: "deposito", name: "Depósito / fábrica" },
  { id: "gimnasio", name: "Polideportivo" },
  { id: "mazmorra", name: "Mazmorra" },
  { id: "cancha", name: "Cancha techada" },
  { id: "horno", name: "Horno de cal" },
  { id: "bosque", name: "Bosque (verano)" },
  { id: "bosquenieve", name: "Bosque (nieve)" },
];

export const DEFAULT_AMBIENCE = "seco";
// Wet mix (how much reverb returns into the speakers). Clearly present.
export const AMBIENCE_WET = 0.55;

export function findAmbience(id: string): Ambience | undefined {
  return AMBIENCES.find((a) => a.id === id);
}

export function ambienceName(id: string): string {
  return findAmbience(id)?.name ?? "Seco";
}
