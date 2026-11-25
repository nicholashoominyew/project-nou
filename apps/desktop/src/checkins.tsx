import { useCallback, useEffect, useRef, useState } from "react";
import { announceHabits, CHECKINS_CHANGED, habitsApi, HABITS_CHANGED, TEST_CHECKIN, todayLocal } from "./habitsApi";
import { activeCheckins, appliesOn, blockRunning, slotRange, slotTime, type Checkin, type CheckinEvent, type Habit } from "./habitsLogic";
import { invoke } from "@tauri-apps/api/core";
import { now } from "./timetable/clock";
import { buildGrids, clock as hhmm, eventAt, names, SLOTS_PER_DAY } from "./timetable/schedule";
import { useTimetable, type TimetableData } from "./timetable/useTimetable";

const msg = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");
const keyOf = (e: Pick<CheckinEvent, "checkin_id" | "day">) => e.checkin_id + "|" + e.day;

// ---- the system notification (Windows desktop notification, with a Checked in button where the platform shows it) ----
let onAnswerFromNotification: ((answer: "done", extra: Record<string, unknown> | undefined) => void) | null = null;
let notificationsReady: Promise<boolean> | null = null;
/** The plugin is loaded once and shared, so the notifications of one moment all use the same module. */
let plugin: Promise<typeof import("@tauri-apps/plugin-notification")> | null = null;
const loadPlugin = () => (plugin ??= import("@tauri-apps/plugin-notification"));
function setupNotifications(): Promise<boolean> {
  notificationsReady ??= (async () => {
    try {
      const n = await loadPlugin();
      let granted = await n.isPermissionGranted();
      if (!granted) granted = (await n.requestPermission()) === "granted";
      if (!granted) return false;
      try { // the buttons are optional: without them the notification is still shown, and the in-app pop-up has the buttons
        await n.registerActionTypes([{ id: "nou-checkin", actions: [{ id: "done", title: "Checked in" }] }]);
        await n.onAction(e => { if (e.actionId === "done") onAnswerFromNotification?.("done", e.notification?.extra); });
      } catch { /* plain notification only */ }
      return true;
    } catch { return false; }
  })();
  return notificationsReady;
}
/** Forget the notification set-up (permission and listener). Only tests need this. */
export function resetNotificationSetup() { notificationsReady = null; plugin = null; }
export async function notifyCheckin(ev: CheckinEvent): Promise<boolean> {
  if (!(await setupNotifications())) return false;
  try {
    const n = await loadPlugin();
    n.sendNotification({ title: `Check-in: ${ev.habit}`, body: `${ev.block ? ev.block + " · " : ""}${slotRange(ev.start_slot, ev.end_slot)}. Did you do it?`, actionTypeId: "nou-checkin", extra: { checkinId: ev.checkin_id, day: ev.day } });
    return true;
  } catch { return false; }
}

export type CheckinPopupState = { visible: CheckinEvent[]; errors: Record<string, string>; answer: (ev: CheckinEvent) => Promise<void>; /** Hide a pop-up for now (it stays on the Habits page and comes back at the next block or when NOU is reopened). */ hide: (ev: CheckinEvent) => void; /** What the timetable has right after this check-in's block, like "05:30 PROJECT BLOCK", or "" when nothing is planned. */ next: (ev: CheckinEvent) => string };

/**
 * Mounted once for the whole app. Every few seconds it looks at the clock. While a check-in's timetable block is running and the habit is not ticked yet, there is a pop-up
 * for it (shown once as a system notification too), and it stays up for the whole block until it is ticked or the block ends. Ticking it on the Habits page closes it. A pop-up
 * left alone for two hours becomes "no answer" (not done). Nothing happens when a block ends except that the pop-up goes away.
 */
export function useCheckinPopups(): CheckinPopupState {
  const { timeline, activities, variantNow } = useTimetable();
  const [pending, setPending] = useState<CheckinEvent[]>([]);
  const [clock, setClock] = useState(() => now().getTime());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [tests, setTests] = useState<CheckinEvent[]>([]);
  const checkins = useRef<Checkin[]>([]);
  const habits = useRef<Habit[]>([]);
  const latest = useRef({ timeline, activities, variantNow });
  latest.current = { timeline, activities, variantNow };
  const busy = useRef(false);

  const loadCheckins = useCallback(async () => {
    try { const [c, h] = await Promise.all([habitsApi.checkins(), habitsApi.list()]); checkins.current = Array.isArray(c) ? c : []; habits.current = Array.isArray(h) ? h : []; } catch { /* no check-ins until it works */ }
  }, []);
  const loadPending = useCallback(async () => { try { const p = await habitsApi.pending(); setPending(Array.isArray(p) ? p : []); } catch { /* the Habits page shows errors */ } }, []);
  const hide = useCallback((ev: CheckinEvent) => setHidden(old => new Set(old).add(keyOf(ev))), []);
  const answer = useCallback(async (ev: CheckinEvent) => {
    if (ev.checkin_id.startsWith("test-")) { // a test pop-up: answering it ticks the habit for today, like any answer
      try { await habitsApi.set(ev.day, ev.habit_id, "done"); announceHabits(); } catch (e) { setErrors(old => ({ ...old, [keyOf(ev)]: msg(e) })); return; }
      setTests(old => old.filter(t => keyOf(t) !== keyOf(ev))); return;
    }
    try { await habitsApi.answer(ev.checkin_id, ev.day, "done"); setErrors(old => { const n = { ...old }; delete n[keyOf(ev)]; return n; }); announceHabits(); }
    catch (e) { setErrors(old => ({ ...old, [keyOf(ev)]: msg(e) })); }
    await loadPending();
  }, [loadPending]);

  const check = useCallback(async () => {
    if (busy.current) return; busy.current = true;
    try {
      const nowMs = now().getTime(); setClock(nowMs);
      const { timeline, activities, variantNow } = latest.current;
      const variant = variantNow(new Date(nowMs));
      const active = activeCheckins(checkins.current, nowMs, variant);
      // The block's name is read from the database, not from this window's copy of the grid: right after an edit that copy can still be the old one.
      let nowOn = { grid: timeline.grids, activities };
      if (active.length) try {
        const d = await invoke<TimetableData>("timetable_get");
        if (d && Array.isArray(d.slots) && Array.isArray(d.activities)) nowOn = { grid: buildGrids(d.slots.map(x => ({ ...x, variant: x.variant === "B" ? "B" : "A" }))), activities: d.activities };
      } catch { /* keep this window's copy */ }
      for (const k of active) {
        const habit = habits.current.find(h => h.id === k.habit_id);
        if (!habit || !appliesOn(habit, k.day)) continue;
        const ids = nowOn.grid[variant]?.[k.weekday * SLOTS_PER_DAY + k.start_slot] ?? [];
        let ev: CheckinEvent | null = null;
        try { ev = await habitsApi.show(k.id, k.day, names(ids, nowOn.activities), Math.floor(new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), new Date(nowMs).getDate(), 0, k.end_slot * 30).getTime() / 1000)); } catch { ev = null; } // null: already shown today, or already ticked
        if (ev) { void notifyCheckin(ev); }
      }
      let closed = 0; try { closed = await habitsApi.sweep(false); } catch { closed = 0; }
      if (closed > 0) announceHabits();
      await loadPending();
    } finally { busy.current = false; }
  }, [loadPending]);

  useEffect(() => {
    let gone = false; let off: (() => void) | undefined;
    (async () => {
      // NOU was just opened: pop-ups whose two hours ran out while it was closed are only marked lapsed (nothing is logged), so the habit can be ticked by hand.
      try { await habitsApi.sweep(true); } catch { /* ignore */ }
      await loadCheckins(); await loadPending();
      if (!gone) void check(); // a block that is running right now gets its pop-up straight away
    })();
    const id = setInterval(() => void check(), 5000);
    const resume = () => { if (!document.hidden) void check(); };
    const changed = () => { void loadCheckins().then(() => check()); }; const habitsChanged = () => void loadPending();
    document.addEventListener("visibilitychange", resume); window.addEventListener("focus", resume); window.addEventListener("nou-sim-changed", resume);
    window.addEventListener(CHECKINS_CHANGED, changed); window.addEventListener("nou-timetable-changed", changed); window.addEventListener(HABITS_CHANGED, changed);
    window.addEventListener(HABITS_CHANGED, habitsChanged);
    const test = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; name: string }>).detail; if (!d) return;
      const t = new Date(now().getTime()), slot = Math.floor((t.getHours() * 60 + t.getMinutes()) / 30);
      const ev: CheckinEvent = { checkin_id: "test-" + d.id, day: todayLocal(), habit_id: d.id, habit: d.name, block: "Test pop-up", start_slot: slot, end_slot: Math.min(48, slot + 1), shown_at: 0, expires_at: 0, state: "shown" };
      setHidden(old => { const n = new Set(old); n.delete(keyOf(ev)); return n; }); setTests(old => [...old.filter(x => keyOf(x) !== keyOf(ev)), ev]); void notifyCheckin(ev);
    };
    window.addEventListener(TEST_CHECKIN, test);
    onAnswerFromNotification = (_a, extra) => {
      const checkinId = typeof extra?.checkinId === "string" ? extra.checkinId : null, day = typeof extra?.day === "string" ? extra.day : null;
      if (checkinId && day) void habitsApi.answer(checkinId, day, "done").then(() => { announceHabits(); return loadPending(); }).catch(() => loadPending());
    };
    import("@tauri-apps/api/event").then(m => m.listen("timetable-tick", () => void check())).then(u => { if (gone) u(); else off = u; }).catch(() => { /* not running inside Tauri */ });
    return () => { gone = true; clearInterval(id); off?.(); onAnswerFromNotification = null; document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume); window.removeEventListener("nou-sim-changed", resume); window.removeEventListener(CHECKINS_CHANGED, changed); window.removeEventListener("nou-timetable-changed", changed); window.removeEventListener(HABITS_CHANGED, changed); window.removeEventListener(HABITS_CHANGED, habitsChanged); window.removeEventListener(TEST_CHECKIN, test); };
  }, [check, loadCheckins, loadPending]);

  const next = useCallback((ev: CheckinEvent) => {
    const { timeline, activities } = latest.current; const [y, m, d] = ev.day.split("-").map(Number);
    const after = eventAt(timeline, new Date(y, m - 1, d, 0, ev.end_slot * 30)); // the event that is on at the moment this block ends
    return after && after.ids.length ? `${hhmm(after.start)} ${names(after.ids, activities)}`.toUpperCase() : "";
  }, []);
  return { visible: [...tests, ...pending.filter(e => blockRunning(e, clock))].filter(e => !hidden.has(keyOf(e))), errors, answer, hide, next };
}

/** The pop-ups themselves: one card per open check-in, with one tap to say it started. It stays for the whole block until ticked, and nothing is asked when a block ends. */
export function CheckinPopups({ state }: { state: CheckinPopupState }) {
  if (!state.visible.length) return null;
  return <div className="checkin-stack" aria-label="Check-ins">
    {state.visible.map(ev => { const next = state.next(ev);
      return <section key={keyOf(ev)} className="checkin-pop hx-pop-card" role="alertdialog" aria-label={`Check-in: ${ev.habit}`}>
        <div className="hx-mono hx-pop-top"><span><i className="hx-blink" />CHECK-IN · {slotTime(ev.start_slot)}</span><span>{ev.block || slotRange(ev.start_slot, ev.end_slot)}</span>
          <button type="button" className="hx-pop-x" aria-label={`Hide the ${ev.habit} check-in for now`} title="Hide for now. It stays on the Habits page until you answer." onClick={() => state.hide(ev)}>×</button></div>
        <div><div className="hx-pop-name">{ev.habit}</div><div className="hx-pop-q">Did you start {ev.habit}?</div></div>
        {state.errors[keyOf(ev)] && <span className="checkin-err" role="alert">{state.errors[keyOf(ev)]}</span>}
        <button type="button" className="hx-pop-yes" onClick={() => void state.answer(ev)}>Yes, started</button>
        <div className="hx-mono hx-pop-foot"><span>START ONLY · NO CHECK-OUT</span>{next && <span>NEXT · {next}</span>}</div>
      </section>; })}
  </div>;
}
