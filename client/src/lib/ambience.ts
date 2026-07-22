// Acoustic "ambiences" — reverb spaces the whole room drops into. Each one is a
// REAL recorded impulse response (genuine convolution of an actual place), loaded
// on demand from `/ir/<id>.ogg`. No synthetic/procedural reverb: it either sounds
// like the real room or it isn't here.
//
// Two families: INTERIORES from OpenAIR (openairlib.net, CC-BY) and EXTERIORES
// from the "Fields & Spaces" pack (stereo) that Cristian added. Operators can
// also drop extra impulses next to these in client/public/ir/ and they show up
// via the server (see server loadAmbiences / AMBIENCE_IR_DIR) without a rebuild.

export interface Ambience {
  id: string;
  name: string;
}

// "seco" (dry) is off; every other id has a matching /ir/<id>.ogg impulse.
export const AMBIENCES: Ambience[] = [
  { id: "seco", name: "Seco (sin efecto)" },

  // Interiores — OpenAIR (openairlib.net, CC-BY).
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

  // Exteriores — pack "Fields & Spaces" (impulsos estéreo) que aportó Cristian.
  { id: "callejon", name: "Callejón" },
  { id: "puente", name: "Puente" },
  { id: "canon-eco", name: "Cañón (eco)" },
  { id: "canon-suave", name: "Cañón (suave)" },
  { id: "ciudad", name: "Ciudad" },
  { id: "puerto-contenedores", name: "Puerto de contenedores" },
  { id: "patio", name: "Patio" },
  { id: "represa", name: "Represa" },
  { id: "pueblo-desierto", name: "Pueblo del desierto" },
  { id: "bosque", name: "Bosque" },
  { id: "bosque-denso", name: "Bosque denso" },
  { id: "bosque-abierto", name: "Bosque abierto" },
  { id: "camino-bosque", name: "Camino del bosque" },
  { id: "bosque-nevado", name: "Bosque nevado" },
  { id: "fortaleza", name: "Fortaleza" },
  { id: "colinas", name: "Colinas" },
  { id: "colinas-nevadas", name: "Colinas nevadas" },
  { id: "ladera", name: "Ladera" },
  { id: "zona-industrial", name: "Zona industrial" },
  { id: "metropolis", name: "Metrópolis" },
  { id: "montana", name: "Montaña" },
  { id: "montana-retumbo", name: "Montaña (retumbo)" },
  { id: "pradera", name: "Pradera" },
  { id: "llanura-arena", name: "Llanura de arena" },
  { id: "llanura-nevada", name: "Llanura nevada" },
  { id: "llanura-piedra", name: "Llanura de piedra" },
  { id: "orilla-rio", name: "Orilla del río" },
  { id: "cantera", name: "Cantera" },
  { id: "pueblo", name: "Pueblo" },
  { id: "pueblo-nevado", name: "Pueblo nevado" },
  { id: "paso-bajo-nivel", name: "Paso bajo nivel" },
  { id: "rio-pueblo", name: "Río del pueblo" },
];

export const DEFAULT_AMBIENCE = "seco";
// Wet mix (how much reverb returns into the speakers). Clearly present.

export function findAmbience(id: string): Ambience | undefined {
  return AMBIENCES.find((a) => a.id === id);
}

// Name to show for an ambience id. Built-ins have curated Spanish names; extras
// hosted by the server (see `serverAmbiences` in the store) fall back to the
// name the server sent (their filename), then the raw id.
export function ambienceName(id: string, serverAmbiences: Ambience[] = []): string {
  if (id === "seco") return "Seco";
  return (
    findAmbience(id)?.name ?? serverAmbiences.find((a) => a.id === id)?.name ?? id
  );
}

// Where to fetch the impulse response for an id, or null if it's dry/unknown.
// Built-ins are bundled at /ir/<id>.ogg; server extras stream from the API.
export function ambienceIrUrl(id: string, serverAmbiences: Ambience[] = []): string | null {
  if (!id || id === "seco") return null;
  if (findAmbience(id)) return `/ir/${id}.ogg`;
  if (serverAmbiences.some((a) => a.id === id))
    return `/api/ambiences/file?id=${encodeURIComponent(id)}`;
  return null;
}
