/**
 * Current weather from Open-Meteo (api.open-meteo.com, free, no account). Only the latitude and longitude of a place you chose are sent, and only when
 * Home is opened with a location set or you press Refresh. Never on a timer after that. The answer is checked and shown as plain text.
 */
export type Place = { name: string; lat: number; lng: number };
export type Weather = { timezone: string | null; temp: number; high: number | null; low: number | null; wind: number | null; label: string; code: number };
export const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
export const WEATHER_KEY = "nou-weather-places";

export function normalizePlaces(raw: unknown): (Place | null)[] {
  const list = Array.isArray(raw) ? raw : [];
  return [0, 1].map(i => {
    const p = list[i] as Record<string, unknown> | null | undefined;
    const lat = Number(p?.lat), lng = Number(p?.lng), name = typeof p?.name === "string" ? p.name.trim().slice(0, 100) : "";
    return p && name && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { name, lat, lng } : null;
  });
}
export function weatherLabel(code: number): string {
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code >= 95 && code <= 99) return "Thunderstorm";
  return "Unknown";
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rounded = (v: unknown): number | null => { const n = Array.isArray(v) ? num(v[0]) : num(v); return n === null ? null : Math.round(n); };
export async function fetchWeather(place: Place, signal?: AbortSignal, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<Weather> {
  const url = `${WEATHER_URL}?latitude=${place.lat.toFixed(3)}&longitude=${place.lng.toFixed(3)}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto`;
  // Give up after 10 seconds so a blocked connection shows "unavailable" instead of loading forever.
  const guard = new AbortController(), timer = setTimeout(() => guard.abort(), 10000);
  const stop = () => guard.abort();
  signal?.addEventListener("abort", stop);
  let res: Response;
  try { res = await fetchImpl(url, { signal: guard.signal, headers: { Accept: "application/json" } }); }
  catch (e) { throw new Error(signal?.aborted ? "Cancelled" : guard.signal.aborted ? "The weather service did not answer" : "Could not reach the weather service"); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
  if (!res.ok) throw new Error("The weather service returned " + res.status);
  const body = (await res.json()) as { timezone?: unknown; current?: Record<string, unknown>; daily?: Record<string, unknown> };
  const temp = rounded(body?.current?.temperature_2m), code = num(body?.current?.weather_code);
  if (temp === null || code === null) throw new Error("The weather service gave an answer I could not read");
  return { timezone: typeof body.timezone === "string" && body.timezone.length < 60 ? body.timezone : null, temp, high: rounded(body.daily?.temperature_2m_max), low: rounded(body.daily?.temperature_2m_min), wind: rounded(body.current?.wind_speed_10m), label: weatherLabel(code), code };
}
