export interface Channel {
  nombre: string;
  categoria: string;
  url: string; // DASH .mpd
  key: string; // ClearKey "kid:key" (hex:hex)
}

// Fetch the operator-managed channel list from the server. [] on any failure
// (TV is optional).
export async function fetchTvChannels(): Promise<Channel[]> {
  try {
    const res = await fetch("/api/tv-channels");
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as Channel[]) : [];
  } catch {
    return [];
  }
}

// Group by categoria; categories A–Z, channels A–Z within each.
export function groupByCategoria(
  channels: Channel[],
): { categoria: string; channels: Channel[] }[] {
  const map = new Map<string, Channel[]>();
  for (const c of channels) {
    const list = map.get(c.categoria) ?? [];
    list.push(c);
    map.set(c.categoria, list);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([categoria, list]) => ({
      categoria,
      channels: [...list].sort((a, b) => a.nombre.localeCompare(b.nombre)),
    }));
}

// Split the "kid:key" field into Shaka's clearKeys map { kid: key }. null if
// malformed.
export function parseClearKey(key: string): Record<string, string> | null {
  const [kid, k] = key.split(":");
  if (!kid || !k) return null;
  return { [kid.replace(/-/g, "")]: k.replace(/-/g, "") };
}
