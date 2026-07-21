// Serieteca — audio-series catalog + playback helpers.
//
// Each series is ONE continuous .m4b on archive.org; a "chapter"/episode is a
// millisecond time-range (inicio/fin) into that single file, with offsets
// continuous across seasons. So an episode list is all temporadas' capitulos
// flattened and sorted by inicio, and playing episode i = seeking to inicio/1000.
// The .m4b lacks CORS, so we route its src through our same-origin /api/audio-proxy.

export interface Capitulo {
  inicio: number; // ms
  fin: number; // ms
  titulo: string;
}
export interface Temporada {
  numero: number;
  anio?: number;
  reparto?: string[];
  sinopsis?: string;
  cantidad_episodios?: number;
  capitulos: Capitulo[];
}
export interface Serie {
  nombre: string;
  genero?: string;
  pais_origen?: string;
  enlace: string;
  temporadas: Temporada[];
}
export interface Episode {
  inicio: number;
  fin: number;
  titulo: string;
  tn: number; // season number
  ti: number; // season index in temporadas[]
}
export interface SeasonInfo {
  numero: number;
  count: number;
}
export interface ProgressEntry {
  episode: number;
  time: number;
}

export const SERIES_DB_URL = "https://archive.org/download/m4bua/series.json";
const PROGRESS_KEY = "jdh-speak:serieteca:progress";

// Drop malformed entries so one bad record can't break the catalog. Validation
// reaches into temporadas: every entry must be an object with an array
// `capitulos`, so flattenEpisodes/seasonsOf/episodeIndexAt never throw on a kept
// series. (Per-capitulo fields are trusted — a bad titulo/inicio/fin degrades a
// single episode, it doesn't crash the helpers.)
function isValidSerie(x: unknown): x is Serie {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.nombre === "string" &&
    typeof s.enlace === "string" &&
    Array.isArray(s.temporadas) &&
    s.temporadas.every(
      (tp) =>
        !!tp &&
        typeof tp === "object" &&
        Array.isArray((tp as Record<string, unknown>).capitulos),
    )
  );
}

export async function fetchSeries(): Promise<Serie[]> {
  try {
    const r = await fetch(SERIES_DB_URL);
    if (!r.ok) return [];
    const d: unknown = await r.json();
    const arr = (d as { series?: unknown }).series;
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidSerie);
  } catch {
    return [];
  }
}

export function flattenEpisodes(serie: Serie): Episode[] {
  const out: Episode[] = [];
  serie.temporadas.forEach((tp, ti) => {
    for (const c of tp.capitulos || []) {
      out.push({ inicio: c.inicio, fin: c.fin, titulo: c.titulo, tn: tp.numero, ti });
    }
  });
  out.sort((a, b) => a.inicio - b.inicio);
  return out;
}

export function seasonsOf(serie: Serie): SeasonInfo[] {
  return serie.temporadas.map((tp) => ({
    numero: tp.numero,
    count: tp.cantidad_episodios ?? (tp.capitulos ? tp.capitulos.length : 0),
  }));
}

export function groupByPais(series: Serie[]): { pais: string; series: Serie[] }[] {
  const map = new Map<string, Serie[]>();
  for (const s of series) {
    const p = s.pais_origen || "Sin clasificar";
    (map.get(p) ?? map.set(p, []).get(p)!).push(s);
  }
  return [...map.keys()]
    .sort((a, b) => a.localeCompare(b, "es"))
    .map((pais) => ({
      pais,
      series: map
        .get(pais)!
        .slice()
        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" })),
    }));
}

// Which episode index contains timeSec (seconds). Mirrors the reference player's
// gci: inside [inicio,fin] → that index; before the first → clamp; past the last
// → last. Returns 0 for an empty list.
export function episodeIndexAt(episodes: Episode[], timeSec: number): number {
  if (!episodes.length) return 0;
  for (let i = 0; i < episodes.length; i++) {
    const a = episodes[i]!.inicio / 1000;
    const b = episodes[i]!.fin / 1000;
    if (timeSec >= a && timeSec <= b) return i;
    if (timeSec < a) return i > 0 ? i - 1 : 0;
    if (i === episodes.length - 1 && timeSec > b) return i;
  }
  return 0;
}

export function serieAudioSrc(enlace: string): string {
  return `/api/audio-proxy?url=${encodeURIComponent(enlace)}`;
}

export function loadProgress(): Record<string, ProgressEntry> {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return {};
    const d: unknown = JSON.parse(raw);
    return d && typeof d === "object" ? (d as Record<string, ProgressEntry>) : {};
  } catch {
    return {};
  }
}

export function saveProgress(nombre: string, entry: ProgressEntry): void {
  try {
    const all = loadProgress();
    all[nombre] = entry;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* storage full / disabled — best effort */
  }
}

export function clearProgress(nombre: string): void {
  try {
    const all = loadProgress();
    delete all[nombre];
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* best effort */
  }
}

// Accent-insensitive, lowercased — for the dialog's live name filter.
export function normalizeForSearch(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
