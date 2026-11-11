/**
 * Look a place up by name or address. This is the only place the app contacts a third party, and only when the person
 * presses Enter on a place field or the map's search box: the text they typed is sent to OpenStreetMap's Nominatim
 * service (nominatim.openstreetmap.org, allowed in the CSP for exactly this). Nothing is sent in the background.
 */
export type FoundPlace = { name: string; address: string; lat: number; lng: number };

export const GEOCODER_URL = "https://nominatim.openstreetmap.org/search";

export async function searchPlaces(query: string, signal?: AbortSignal, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<FoundPlace[]> {
  const q = query.trim();
  if (q.length < 2 || q.length > 200) return [];
  const res = await fetchImpl(`${GEOCODER_URL}?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`The place search returned ${res.status}`);
  const rows: unknown = await res.json();
  if (!Array.isArray(rows)) return [];
  const found: FoundPlace[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const lat = Number(row?.lat), lng = Number(row?.lon);
    // Never trust a remote answer: coordinates must be real and in range, text is length-limited and shown as plain text.
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const address = String(row?.display_name ?? "").trim().slice(0, 300);
    const name = (String(row?.name ?? "").trim() || address.split(",")[0].trim()).slice(0, 100);
    if (!name && !address) continue;
    found.push({ name: name || address.slice(0, 100), address, lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
  }
  return found;
}
