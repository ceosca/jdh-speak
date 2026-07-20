export interface Channel {
  nombre: string;
  categoria: string;
  url: string;
  // ClearKey as "kid:key" (hex:hex) — decrypted client-side by Shaka.
  key: string;
}

// Parse the operator's tv/db.json. Keeps only well-formed entries (all four
// string fields present) so a partial/messy file still yields the good
// channels. Returns [] on invalid JSON or a non-array.
export function parseTvChannels(raw: string): Channel[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.filter(
    (c): c is Channel =>
      !!c &&
      typeof c === "object" &&
      typeof (c as Channel).nombre === "string" &&
      typeof (c as Channel).categoria === "string" &&
      typeof (c as Channel).url === "string" &&
      typeof (c as Channel).key === "string",
  );
}
