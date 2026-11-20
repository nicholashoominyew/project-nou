import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icons";
import { onSecond } from "./secondTick";
import { PlaceSearchBox } from "./PlaceSearch";
import type { HomeContext } from "./Home";
import { Arc, CardHead, Flip, SkyIcon, StateDot } from "./HomeBits";
import { searchPlaces, type FoundPlace } from "./geocode";
import { fetchWeather, normalizePlaces, WEATHER_KEY, type Place, type Weather } from "./weather";
import { activityLevel, dayFraction, isDaytime, pickForDay, pickSunPlace, rangePosition, sunPosition, sunTimes, writingDays } from "./homeLogic";
import { COUNTDOWNS_KEY, MAX_COUNTDOWNS, clockParts, countdownState, dayKey, groupByDay, localZone, monthGrid, normalizeCountdowns, parseDay, periods, validZone, zoneCity, zoneList, type CalendarEvent, type Countdown, type Unit } from "./timeLogic";

function read(key: string): unknown { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } }
function write(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* a preference only */ } }
function useNow(ms = 20000): Date {
  const [now, setNow] = useState(() => new Date());
  // Anything that shows seconds rides the shared second clock so every counter changes at the same instant; slower ones just poll.
  useEffect(() => {
    if (ms <= 1000) return onSecond(() => setNow(new Date()));
    const t = window.setInterval(() => setNow(new Date()), ms); return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
const two = (n: number) => String(n).padStart(2, "0");
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");

// ---- daily page strip -----------------------------------------------------------------------------------------------
/** A slim strip: today's date, a 14-day writing streak (a day counts when a page titled with that date exists), and a button to open or make today's page. */
export function DailyWidget({ ctx }: { ctx: HomeContext }) {
  const now = new Date(ctx.today + "T12:00:00");
  const { days, streak } = useMemo(() => writingDays(ctx.pages.map(p => p.title), now, 14), [ctx.pages, ctx.today]); // eslint-disable-line react-hooks/exhaustive-deps
  const long = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return <>
    <div className="daily-id">
      <div className="date-tile" aria-hidden="true"><em>{now.toLocaleDateString("en-GB", { month: "short" }).toUpperCase()}</em><b>{now.getDate()}</b></div>
      <div><h2><StateDot />Daily page</h2><span className="daily-date">{long}</span></div>
    </div>
    <div className="daily-streak">
      <div className="streak" role="img" aria-label={"Writing streak, last 14 days: " + streak + (streak === 1 ? " day" : " days") + " in a row"}>
        {days.map((d, i) => <span key={d.date} className={"streak-day" + (d.written ? " on" : "") + (i === days.length - 1 ? " today" : "")} style={{ animationDelay: 0.2 + i * 0.03 + "s" }} />)}
      </div>
      <span className="mono-note">{streak}-DAY STREAK</span>
    </div>
    <button disabled={ctx.disabled} onClick={ctx.openDaily}><Icon name="calendar" size={15} /> Open today's page</button>
  </>;
}

// ---- weather store, shared by the weather card and the daylight arc ------------------------------------------------
export type Slot = { weather?: Weather; error?: string; loading?: boolean };
export type WeatherStore = { places: (Place | null)[]; slots: Slot[]; setPlace: (i: number, p: Place | null) => void; refresh: () => void };
/** Two remembered places and their weather. It asks once when mounted (for places that are set), when a place changes, and on refresh. Never on a timer. */
export function useWeatherStore(fetchImpl?: typeof fetch, enabled = true): WeatherStore {
  const [places, setPlaces] = useState<(Place | null)[]>(() => normalizePlaces(read(WEATHER_KEY)));
  const [slots, setSlots] = useState<Slot[]>([{}, {}]);
  const load = useCallback((i: number, place: Place | null, signal?: AbortSignal) => {
    if (!place) { setSlots(s => s.map((x, j) => (j === i ? {} : x))); return; }
    setSlots(s => s.map((x, j) => (j === i ? { ...x, loading: true, error: undefined } : x)));
    fetchWeather(place, signal, fetchImpl).then(weather => { if (!signal?.aborted) setSlots(s => s.map((x, j) => (j === i ? { weather } : x))); })
      .catch(e => { if (!signal?.aborted) setSlots(s => s.map((x, j) => (j === i ? { error: errText(e) } : x))); });
  }, [fetchImpl]);
  useEffect(() => { if (!enabled) return; const c = new AbortController(); places.forEach((p, i) => load(i, p, c.signal)); return () => c.abort(); }, [places, load, enabled]);
  const setPlace = (i: number, p: Place | null) => { const next = places.map((x, j) => (j === i ? p : x)); setPlaces(next); write(WEATHER_KEY, next); };
  return { places, slots, setPlace, refresh: () => places.forEach((p, i) => load(i, p)) };
}

// ---- daylight arc in the header ------------------------------------------------------------------------------------
const SUN_KEY = "nou-sun-place", SUN_CUSTOM_KEY = "nou-sun-custom";
/** Index 0 and 1 are the two weather places; 2 is a place searched for in the arc's own menu (a city that is not one of the weather places). */
const CUSTOM = 2;
type SunCustom = { name: string; lat: number; lng: number; timezone?: string };
const readSunChoice = (): "auto" | number => { try { const v = JSON.parse(localStorage.getItem(SUN_KEY) || "null"); return v === 0 || v === 1 || v === CUSTOM ? v : "auto"; } catch { return "auto"; } };
function readSunCustom(): SunCustom | null {
  try {
    const v = JSON.parse(localStorage.getItem(SUN_CUSTOM_KEY) || "null") as SunCustom | null;
    return v && typeof v.name === "string" && v.name && Number.isFinite(v.lat) && Number.isFinite(v.lng) && Math.abs(v.lat) <= 90 && Math.abs(v.lng) <= 180 ? { name: v.name.slice(0, 100), lat: v.lat, lng: v.lng, timezone: validZone(v.timezone) ? v.timezone : undefined } : null;
  } catch { return null; }
}
export function SunArc({ store, fetchImpl }: { store: WeatherStore; fetchImpl?: typeof fetch }) {
  const now = useNow(30000);
  const [choice, setChoice] = useState(readSunChoice);
  const [custom, setCustom] = useState(readSunCustom);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // Results of the place search are drawn outside this box, so a click on them is not "away".
    const away = (e: MouseEvent) => { const el = e.target as Element; if (wrap.current && !wrap.current.contains(el) && !el.closest?.(".db-place-results")) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* a preference only */ } };
  const pick = (c: "auto" | number) => { setChoice(c); setOpen(false); save(SUN_KEY, c); };
  const pickFound = (f: { name: string; lat: number; lng: number }) => {
    const c: SunCustom = { name: f.name, lat: f.lat, lng: f.lng };
    setCustom(c); save(SUN_CUSTOM_KEY, c); pick(CUSTOM);
    // The time zone of the searched place comes from the same weather service the weather cards use (coordinates only).
    fetchWeather({ name: c.name, lat: c.lat, lng: c.lng }, undefined, fetchImpl).then(w => {
      if (!validZone(w.timezone)) return;
      const withZone = { ...c, timezone: w.timezone }; setCustom(withZone); save(SUN_CUSTOM_KEY, withZone);
    }).catch(() => { /* the longitude is then used to find the place's day */ });
  };
  // Describe the place in the device's own time zone (where you are), unless one was picked by hand.
  let device = ""; try { device = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* unknown */ }
  const places: (Place | null)[] = [...store.places, custom ? { name: custom.name, lat: custom.lat, lng: custom.lng } : null];
  const zones = [...store.slots.map(s => s?.weather?.timezone), custom?.timezone];
  const at0 = pickSunPlace(zones, device, choice, places.map(p => !!p));
  const place = places[at0] ?? null, tzRaw = zones[at0];
  const tz = tzRaw && validZone(tzRaw) ? tzRaw : undefined;
  const t = place ? sunTimes(now, place.lat, place.lng, tz) : null;
  if (!place || !t) return null;
  const at = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  const pos = sunPosition(now, t), x = 130 - 120 * Math.cos(Math.PI * pos.fraction), y = 58 - 50 * Math.sin(Math.PI * pos.fraction);
  const code = place.name.replace(/[^\p{L}]/gu, "").slice(0, 3).toUpperCase() || "SUN";
  const note = pos.up ? `${code} · ${Math.floor(pos.leftMinutes / 60)}H ${pos.leftMinutes % 60}M OF LIGHT` : `${code} · NIGHT`;
  const label = `Daylight in ${place.name}: sunrise ${at(t.rise)}, sunset ${at(t.set)}, ` + (pos.up ? `${Math.floor(pos.leftMinutes / 60)} hours ${pos.leftMinutes % 60} minutes of light left` : "the sun has set");
  const matchesDevice = zones.some(z => !!z && z === device);
  return <div className="sun-wrap" ref={wrap}><svg className="sun-arc" width="260" height="78" viewBox="0 0 260 78" role="img" aria-label={label}>
    <line x1="0" y1="58" x2="260" y2="58" className="sun-base" />
    <path d="M10 58 A120 50 0 0 1 250 58" className="sun-dash" fill="none" />
    <path d="M10 58 A120 50 0 0 1 250 58" pathLength="100" className="sun-done" fill="none" strokeDasharray={`${(pos.fraction * 100).toFixed(1)} 100`} />
    <circle cx={x.toFixed(1)} cy={y.toFixed(1)} r="12" className="sun-glow" />
    <text x="10" y="74" className="sun-text">↑ {at(t.rise)}</text>
    <text x="250" y="74" textAnchor="end" className="sun-text">{at(t.set)} ↓</text>
    <text x="130" y="74" textAnchor="middle" className="sun-text ink">{note}</text>
  </svg>
    {/* The sun itself is the control: hover or focus enlarges it slightly, rings it and names the time zone beside it; a click opens the place menu. The label opens toward the middle of the arc so it never leaves the bar. */}
    <span className={"sun-anchor " + (pos.fraction > 0.5 ? "to-left" : "to-right")} style={{ left: x, top: y }}>
      <button type="button" className={"sun-dot-btn" + (pos.up ? " up" : "")} aria-label="Choose where the daylight arc is for" aria-haspopup="true" aria-expanded={open} title={"Daylight for " + place.name + (tz ? " · " + tz : "")} onClick={() => setOpen(v => !v)} />
      <span className="sun-zone" aria-hidden="true">{tz ?? place.name}</span>
    </span>
    {open && <fieldset className={"sun-menu " + (pos.fraction > 0.5 ? "to-left" : "to-right")} style={{ top: y + 16 }} aria-label="Daylight arc place">
      <legend>Daylight for</legend>
      <label><input type="radio" name="sun-place" checked={choice === "auto"} onChange={() => pick("auto")} /> Where I am <small>{device || "this device"}</small></label>
      {places.map((p, i) => p && <label key={i}><input type="radio" name="sun-place" checked={choice === i} onChange={() => pick(i)} /> {p.name}{zones[i] && <small>{zones[i]}</small>}</label>)}
      {!matchesDevice && <p className="hint">None of these is in {device || "your time zone"}. Search for your city to see its daylight.</p>}
      <PlaceSearchBox onPick={pickFound} placeholder="Search for a city, for example Tokyo…" />
    </fieldset>}
  </div>;
}

// ---- two flip clocks ------------------------------------------------------------------------------------------------
const CLOCKS_KEY = "nou-clocks";
export function ClocksWidget() {
  const now = useNow(1000);
  const [zones, setZones] = useState<string[]>(() => { const r = read(CLOCKS_KEY); const l = Array.isArray(r) ? r : []; return [validZone(l[0]) ? l[0] : "Europe/London", validZone(l[1]) ? l[1] : "Asia/Kuala_Lumpur"]; });
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const all = useMemo(() => zoneList(), []);
  const secs = two(now.getSeconds());
  function commit(i: number) {
    const value = draft.trim();
    if (validZone(value)) { const next = zones.map((z, j) => (j === i ? value : z)); setZones(next); write(CLOCKS_KEY, next); setEditing(null); }
  }
  return <>
    <CardHead title="Clocks" live>
      <span className="sec" role="img" aria-label={"Seconds " + secs}><Flip small value={secs[0]} /><Flip small value={secs[1]} /><em>SEC</em></span>
    </CardHead>
    <div className="sec-line" aria-hidden="true">{
      // At second 0 the bar is full and flashes out once; from second 1 a fresh bar starts again (a new element, so it never slides backwards).
      now.getSeconds() === 0
        ? <i key={"flash" + now.getMinutes()} className="flash" style={{ width: "100%" }} />
        : <i key={"run" + now.getMinutes()} style={{ width: (now.getSeconds() / 60) * 100 + "%" }} />
    }</div>
    <datalist id="nou-zones">{all.map(z => <option key={z} value={z} />)}</datalist>
    <div className="clocks">
      {zones.map((zone, i) => {
        const c = clockParts(now, zone), city = zoneCity(zone), day = isDaytime(c.hour);
        return <div className="clock" key={i} aria-label={"Clock " + (i + 1)}>
          <time className="clock-time" dateTime={c.time} aria-label={city + " " + c.time}>
            <Flip value={c.time[0]} /><Flip value={c.time[1]} /><span className="colon" aria-hidden="true"><i /><i /></span><Flip value={c.time[3]} /><Flip value={c.time[4]} />
          </time>
          {editing === i
            ? <span className="clock-edit"><input list="nou-zones" aria-label={"Time zone for clock " + (i + 1)} value={draft} autoFocus placeholder="e.g. Europe/London" onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") commit(i); else if (e.key === "Escape") setEditing(null); }} />
                <button disabled={!validZone(draft.trim())} onClick={() => commit(i)}>Set</button></span>
            : <span className="clock-city"><Icon name={day ? "sun" : "moon"} size={13} /><button className="clock-zone" aria-label={"Change the time zone of clock " + (i + 1) + ", now " + zone} title={zone} onClick={() => { setDraft(zone); setEditing(i); }}>{city}</button></span>}
          <span className="clock-date">{c.date}</span>
          <div className="day-band" aria-hidden="true"><i style={{ "--f": dayFraction(c.hour, c.minute) } as CSSProperties} /></div>
        </div>;
      })}
    </div>
  </>;
}

// ---- weather: compact rows ------------------------------------------------------------------------------------------
export function WeatherWidget({ fetchImpl, store }: { fetchImpl?: typeof fetch; store?: WeatherStore }) {
  const own = useWeatherStore(fetchImpl, !store);
  const { places, slots, setPlace, refresh } = store ?? own;
  const [editing, setEditing] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<FoundPlace[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const startEdit = (i: number) => { setEditing(i); setQuery(""); setFound(null); setSearchError(""); };
  async function search() {
    setSearchError(""); setFound(null);
    try { setFound(await searchPlaces(query)); } catch (e) { setSearchError(errText(e)); }
  }
  function choose(i: number, f: FoundPlace) { setPlace(i, { name: f.name, lat: f.lat, lng: f.lng }); setEditing(null); setFound(null); setQuery(""); }

  return <>
    <CardHead title="Weather">
      {places.some(Boolean) && <button className="icon-tool" aria-label="Refresh weather" title="Refresh" onClick={refresh}><Icon name="undo" size={14} /></button>}
    </CardHead>
    <div className="weather">
      {places.map((place, i) => { const w = slots[i].weather; return <div className="wx-row" key={i} aria-label={"Weather " + (i + 1)}>
        {place ? <div className="wx-main">
            <span className="wx-icon">{w ? <SkyIcon code={w.code} size={16} /> : <Icon name="globe" size={16} />}</span>
            <span className="wx-name" title={w && w.wind !== null ? "Wind " + w.wind + " km/h" : undefined}><strong>{place.name}</strong>
              {w ? <span className="hint">{w.label}</span> : slots[i].error ? <span className="hint wx-unavail" title={slots[i].error}>Weather unavailable. <button className="link-button" onClick={refresh}>Retry</button></span> : <span className="hint">{slots[i].loading ? "Loading…" : ""}</span>}</span>
            {w && w.high !== null && w.low !== null
              ? <span className="wx-range" aria-label={`Low ${w.low}°, high ${w.high}°`} title={`Low ${w.low}° · High ${w.high}°`}><span className="wx-bar"><i style={{ "--f": rangePosition(w.temp, w.low, w.high) } as CSSProperties} /></span></span>
              : <span className="wx-range" />}
            <span className="wx-temp">{w ? w.temp + "°" : ""}</span>
            <button className="link-button" aria-label={"Change location " + (i + 1)} onClick={() => startEdit(i)}>Change</button>
          </div>
        : <div className="wx-main"><span className="wx-icon"><Icon name="globe" size={16} /></span><span className="wx-name"><span className="hint">No location yet.</span></span><button onClick={() => startEdit(i)}>Set location {i + 1}</button></div>}
        {editing === i && <div className="weather-edit">
          <input aria-label={"Search for location " + (i + 1)} value={query} placeholder="City or place" autoFocus onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void search(); else if (e.key === "Escape") setEditing(null); }} />
          <button disabled={query.trim().length < 2} onClick={() => void search()}>Search</button>
          <button onClick={() => setEditing(null)}>Cancel</button>
          {place && <button onClick={() => { setPlace(i, null); setEditing(null); }}>Remove</button>}
          {searchError && <p className="error" role="alert">{searchError}</p>}
          {found && !found.length && <p className="hint">Nothing found.</p>}
          {found && found.length > 0 && <ul className="weather-results" aria-label="Places found">{found.map(f => <li key={f.lat + "," + f.lng}><button onClick={() => choose(i, f)}><strong>{f.name}</strong><span className="hint">{f.address}</span></button></li>)}</ul>}
          <p className="hint">Searching sends what you typed to OpenStreetMap; the weather sends only the place's coordinates to Open-Meteo.</p>
        </div>}
      </div>; })}
    </div>
  </>;
}

// ---- year / quarter / month / day: four rings -------------------------------------------------------------------------
export function PeriodsWidget() {
  const now = useNow();
  const list = periods(now);
  const radii = [44, 35, 26, 17];
  return <div className="periods">
    <svg className="rings" viewBox="0 0 100 100" aria-hidden="false" role="group" aria-label="Progress rings">
      {list.map((p, i) => <g key={p.id} role="progressbar" aria-label={p.label + " progress"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.fraction * 100)} className={"ring ring-" + p.id}><Arc radius={radii[i]} stroke={6} fraction={p.fraction} /></g>)}
    </svg>
    <ul className="legend">{list.map(p => <li key={p.id}><i className={"key key-" + p.id} aria-hidden="true" /><strong>{p.label}</strong><span className="hint">{Math.round(p.fraction * 100)}% · {p.left}</span></li>)}</ul>
  </div>;
}

// ---- countdowns: one ring each --------------------------------------------------------------------------------------
export const COUNTDOWNS_CHANGED = "nou:countdowns-changed";
/** One countdown: the ring and the title only. The time left and the end date are kept for screen readers and the tooltip; the unit and Remove sit behind one settings button. */
function CountdownRow({ c, s, setUnit, remove }: { c: Countdown; s: ReturnType<typeof countdownState>; setUnit: (u: Unit) => void; remove: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return <li ref={box} title={`${s.text} · Ends ${c.end}`}>
    <svg className="cd-ring" viewBox="0 0 100 100" role="progressbar" aria-label={c.label + " countdown"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.fraction * 100)}>
      <Arc radius={40} stroke={9} fraction={s.fraction} /><text x="50" y="56" textAnchor="middle" className="cd-days">{s.done ? "✓" : s.daysLeft}</text></svg>
    <div className="cd-text"><strong>{c.label}</strong><span className="sr-only">{s.text}</span><span className="sr-only">Ends {c.end}</span></div>
    <button type="button" className="icon-tool cd-gear" aria-label={"Settings for " + c.label} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(v => !v)}><Icon name="settings" size={14} /></button>
    {open && <div className="cd-menu" role="group" aria-label={"Settings for " + c.label}>
      <label>Show in <select aria-label={"Show " + c.label + " in"} value={c.unit} onChange={e => setUnit(e.target.value as Unit)}><option value="day">Days</option><option value="week">Weeks</option><option value="month">Months</option></select></label>
      <button type="button" className="cd-remove" aria-label={"Remove " + c.label} onClick={() => { setOpen(false); remove(); }}><Icon name="close" size={12} /> Remove</button>
    </div>}
  </li>;
}

export function CountdownWidget() {
  const now = useNow(60000);
  const [items, setItems] = useState<Countdown[]>(() => normalizeCountdowns(read(COUNTDOWNS_KEY)));
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [end, setEnd] = useState("");
  const [unit, setUnit] = useState<Unit>("day");
  const save = (next: Countdown[]) => { setItems(next); write(COUNTDOWNS_KEY, next); try { window.dispatchEvent(new CustomEvent(COUNTDOWNS_CHANGED)); } catch { /* only a refresh hint */ } };
  const ok = label.trim().length > 0 && !!parseDay(end) && items.length < MAX_COUNTDOWNS;
  function add() {
    if (!ok) return;
    const id = (globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 40);
    const start = dayKey(new Date());
    save(normalizeCountdowns([...items, { id, label: label.trim(), start: parseDay(end)! < parseDay(start)! ? end : start, end, unit }]));
    setLabel(""); setEnd(""); setAdding(false);
  }
  return <div className="countdowns">
    {!items.length && !adding && <p className="hint">Nothing counting down. Add a deadline and a ring fills up as it gets closer.</p>}
    <ul className="countdown-list">{items.map(c => { const s = countdownState(c, now); return <CountdownRow key={c.id} c={c} s={s}
      setUnit={u => save(items.map(x => (x.id === c.id ? { ...x, unit: u } : x)))} remove={() => save(items.filter(x => x.id !== c.id))} />; })}</ul>
    {adding
      ? <form className="countdown-add" onSubmit={e => { e.preventDefault(); add(); }}>
          <input aria-label="Countdown name" placeholder="What are you counting down to?" maxLength={80} value={label} onChange={e => setLabel(e.target.value)} autoFocus />
          <input aria-label="Countdown date" type="date" value={end} onChange={e => setEnd(e.target.value)} />
          <select aria-label="Count in" value={unit} onChange={e => setUnit(e.target.value as Unit)}><option value="day">Days</option><option value="week">Weeks</option><option value="month">Months</option></select>
          <button type="submit" disabled={!ok}>Add</button><button type="button" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      : <button className="link-button add-link" disabled={items.length >= MAX_COUNTDOWNS} onClick={() => setAdding(true)}><Icon name="plus" size={13} /> Add a countdown</button>}
  </div>;
}

// ---- today's tasks: the linked to-dos --------------------------------------------------------------------------------
type Todo = { id: string; text: string; checked: boolean; pages: number };
export function TasksWidget({ disabled }: { disabled?: boolean }) {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const load = useCallback(async () => {
    try { const list = await invoke<Todo[]>("linked_todo_list", { query: "" }); setTodos(Array.isArray(list) ? list : []); setError(""); }
    catch (e) { setError(errText(e)); setTodos(old => old ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // A to-do ticked or edited inside a note reaches this list through the same event the editor already sends.
  useEffect(() => { const f = () => void load(); window.addEventListener("nou:linked-todo", f); return () => window.removeEventListener("nou:linked-todo", f); }, [load]);
  async function toggle(t: Todo) {
    setTodos(old => (old ?? []).map(x => (x.id === t.id ? { ...x, checked: !t.checked } : x)));
    try { await invoke("linked_todo_set", { id: t.id, checked: !t.checked, text: null }); } catch (e) { setError(errText(e)); void load(); }
  }
  async function add() {
    const text = draft.trim();
    if (!text || disabled) return;
    try { await invoke("linked_todo_create", { text }); setDraft(""); await load(); } catch (e) { setError(errText(e)); }
  }
  const list = [...(todos ?? [])].sort((a, b) => Number(a.checked) - Number(b.checked)).slice(0, 100);
  const done = list.filter(t => t.checked).length;
  return <>
    <CardHead title="Today's tasks" live>
      <span className="task-count"><span className="mini-bar" aria-hidden="true"><i style={{ width: (list.length ? (done / list.length) * 100 : 0) + "%" }} /></span>{done}/{list.length}</span>
    </CardHead>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="task-scroll-wrap"><div className="task-scroll" role="list">
      {todos === null && <p className="hint">Loading…</p>}
      {todos !== null && !list.length && <p className="hint">No to-dos yet. Add one below, or type /[] in a note.</p>}
      {list.map(t => <div className={"task" + (t.checked ? " done" : "")} role="listitem" key={t.id}>
        <input type="checkbox" id={"task-" + t.id} checked={t.checked} disabled={disabled} onChange={() => void toggle(t)} />
        <div><label htmlFor={"task-" + t.id}>{t.text || "(empty)"}</label>
          {t.pages > 0 && <span className="chip">On {t.pages} {t.pages === 1 ? "page" : "pages"}</span>}</div>
      </div>)}
    </div></div>
    <form className="task-add" onSubmit={e => { e.preventDefault(); void add(); }}>
      <span aria-hidden="true">+</span><input aria-label="Add a task" placeholder="Add a task" maxLength={500} value={draft} disabled={disabled} onChange={e => setDraft(e.target.value)} />
    </form>
  </>;
}

// ---- teaching of the day: from a database called Teachings ----------------------------------------------------------
type Db = { title: string; properties: { id: string; name: string; type: string; options?: { id: string; name: string }[] }[]; rows: { id: string; title: string; values: Record<string, unknown> }[] };
type Teaching = { text: string; theme: string; source: string };
const prop = (db: Db, names: string[], types: string[]) => db.properties.find(p => names.includes(p.name.trim().toLowerCase()) && types.includes(p.type));
function valueOf(p: Db["properties"][number] | undefined, v: unknown): string {
  if (!p || v == null) return "";
  if (typeof v === "string") return (p.options?.find(o => o.id === v)?.name ?? v).slice(0, 300);
  if (Array.isArray(v)) return v.map(x => (typeof x === "string" ? p.options?.find(o => o.id === x)?.name ?? x : "")).filter(Boolean).join(", ").slice(0, 300);
  return "";
}
export function TeachingWidget({ today }: { today: string }) {
  const [items, setItems] = useState<Teaching[] | null>(null);
  const [at, setAt] = useState(0);
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const list = await invoke<{ id: string; title: string }[]>("list_databases");
        const brief = (Array.isArray(list) ? list : []).find(d => d.title.trim().toLowerCase() === "teachings");
        const db = brief ? await invoke<Db | null>("get_database", { pageId: brief.id }) : null;
        if (!db) { if (!off) setItems([]); return; }
        const body = prop(db, ["teaching", "text", "quote", "note"], ["text"]), theme = prop(db, ["theme"], ["select", "multi_select", "text"]), src = prop(db, ["book", "source"], ["select", "text", "url"]);
        const all = db.rows.map(r => ({ text: (valueOf(body, r.values?.[body?.id ?? ""]) || r.title || "").trim(), theme: valueOf(theme, r.values?.[theme?.id ?? ""]), source: valueOf(src, r.values?.[src?.id ?? ""]) })).filter(t => t.text);
        if (!off) setItems(pickForDay(all, today, 5));
      } catch { if (!off) setItems([]); }
    })();
    return () => { off = true; };
  }, [today]);
  const cur = items?.[at];
  return <>
    <CardHead title="Teaching of the day">
      {items && items.length > 1 && <div role="group" aria-label="Choose a teaching" className="teach-dots">{items.map((_, i) => <button key={i} aria-label={"Teaching " + (i + 1) + " of " + items.length} aria-pressed={i === at} className={i === at ? "on" : ""} onClick={() => setAt(i)} />)}</div>}
    </CardHead>
    {items === null && <p className="hint">Loading…</p>}
    {items && !cur && <p className="hint">One teaching appears here each day. Make a database called Teachings with a Theme and a Book column and add rows to it.</p>}
    {cur && <><p className="teach-text">{cur.text}</p>
      <div className="teach-meta">{cur.theme && <span className="chip">{cur.theme}</span>}<span className="mono-note">{[cur.source, (at + 1) + " OF " + items!.length].filter(Boolean).join(" · ")}</span></div></>}
  </>;
}

// ---- master calendar ------------------------------------------------------------------------------------------------
type Brief = { id: string; title: string };
type CalDb = { title: string; properties: { id: string; type: string }[]; rows: { id: string; title: string; values: Record<string, unknown> }[] };
const MAX_DATABASES = 20;
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
export function CalendarWidget({ ctx }: { ctx: HomeContext }) {
  const today = dayKey(new Date());
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [selected, setSelected] = useState(today);
  const [rows, setRows] = useState<CalendarEvent[]>([]);
  const [counts, setCounts] = useState<Countdown[]>(() => normalizeCountdowns(read(COUNTDOWNS_KEY)));
  useEffect(() => { const f = () => setCounts(normalizeCountdowns(read(COUNTDOWNS_KEY))); window.addEventListener(COUNTDOWNS_CHANGED, f); return () => window.removeEventListener(COUNTDOWNS_CHANGED, f); }, []);
  // Dates from every database: any row with a date property shows on that day.
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const list = await invoke<Brief[]>("list_databases");
        const out: CalendarEvent[] = [];
        for (const b of (Array.isArray(list) ? list : []).slice(0, MAX_DATABASES)) {
          const data = await invoke<CalDb | null>("get_database", { pageId: b.id }).catch(() => null);
          const dateProps = (data?.properties ?? []).filter(p => p.type === "date");
          for (const r of data?.rows ?? []) for (const p of dateProps) { const v = r.values?.[p.id]; const day = typeof v === "string" ? v.slice(0, 10) : ""; if (parseDay(day)) out.push({ date: day, title: r.title || "Untitled", kind: "row", from: data!.title }); }
        }
        if (!off) setRows(out);
      } catch { if (!off) setRows([]); }
    })();
    return () => { off = true; };
  }, [ctx.pages]);
  const events = useMemo(() => {
    const daily: CalendarEvent[] = ctx.pages.filter(p => parseDay(p.title.trim())).map(p => ({ date: p.title.trim(), title: "Daily page", kind: "daily", pageId: p.id }));
    const ends: CalendarEvent[] = counts.map(c => ({ date: c.end, title: c.label, kind: "countdown" }));
    return groupByDay([...daily, ...ends, ...rows]);
  }, [ctx.pages, counts, rows]);
  const weeks = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor]);
  const shift = (n: number) => setCursor(c => { const d = new Date(c.y, c.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const title = new Date(cursor.y, cursor.m, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const dayEvents = events.get(selected) ?? [];
  const todayEvents = events.get(today) ?? [];
  return <>
    <CardHead title="Calendar">
      <span className="mcal-nav"><strong aria-live="polite">{title}</strong>
        <button className="icon-tool" aria-label="Previous month" onClick={() => shift(-1)}><Icon name="chevronLeft" size={14} /></button>
        <button className="plain-tool" onClick={() => { const d = new Date(); setCursor({ y: d.getFullYear(), m: d.getMonth() }); setSelected(today); }}>Today</button>
        <button className="icon-tool" aria-label="Next month" onClick={() => shift(1)}>›</button></span>
    </CardHead>
    <div className="mcal-grid" role="grid" aria-label={title}>
      {WEEKDAYS.map(d => <span key={d} className="mcal-dow" role="columnheader">{d}</span>)}
      {weeks.flat().map(cell => {
        const n = events.get(cell.date)?.length ?? 0, past = cell.date <= today, level = past && cell.inMonth ? activityLevel(n) : 0;
        return <button key={cell.date} role="gridcell" className={"mcal-day lvl-" + level + (cell.inMonth ? "" : " out") + (cell.date === today ? " today" : "") + (cell.date === selected ? " sel" : "")}
          aria-label={cell.date + (n ? ", " + n + (n === 1 ? " item" : " items") : "")} aria-selected={cell.date === selected} onClick={() => setSelected(cell.date)}>
          <span className="num">{+cell.date.slice(8)}</span>{n > 0 && <i className="mcal-dot" aria-hidden="true" />}</button>;
      })}
    </div>
    <div className="mcal-foot">
      <div className="mcal-today"><span className="mono-note">TODAY</span>{todayEvents.length ? todayEvents.slice(0, 3).map((e, i) => <span key={i}>{i > 0 && <span className="hint">· </span>}{e.title}</span>) : <span className="hint">Nothing today</span>}</div>
      <div className="mcal-legend" aria-hidden="true"><span className="mono-note">LESS</span>{[0, 1, 2, 3].map(l => <i key={l} className={"lvl-" + l} />)}<span className="mono-note">MORE</span></div>
    </div>
    <div className="mcal-list" aria-label={"Items on " + selected}>
      <p className="hint">{selected}</p>
      {!dayEvents.length && <p className="hint">Nothing on this day.</p>}
      <ul>{dayEvents.map((e, i) => <li key={i}>{e.kind === "daily" && e.pageId
        ? <button disabled={ctx.disabled} onClick={() => ctx.open(e.pageId!)}><Icon name="calendar" size={14} /> Daily page</button>
        : <span><Icon name={e.kind === "countdown" ? "flag" : "database"} size={14} /> {e.title}{e.from && <em className="hint"> · {e.from}</em>}{e.kind === "countdown" && <em className="hint"> · countdown ends</em>}</span>}</li>)}</ul>
    </div>
  </>;
}
