import { useCallback, useEffect, useRef, useState } from "react";
import { announceHabits, CHECKINS_CHANGED, habitsApi, HABITS_CHANGED } from "./habitsApi";
import { activeCheckins, appliesOn, blockRunning, slotRange, slotTime, type Checkin, type CheckinEvent, type Habit } from "./habitsLogic";
import { now } from "./timetable/clock";
import { names, SLOTS_PER_DAY } from "./timetable/schedule";
import { useTimetable } from "./timetable/useTimetable";

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

export type CheckinPopupState = { visible: CheckinEvent[]; errors: Record<string, string>; answer: (ev: CheckinEvent) => Promise<void> };

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
  const checkins = useRef<Checkin[]>([]);
  const habits = useRef<Habit[]>([]);
  const latest = useRef({ timeline, activities, variantNow });
  latest.current = { timeline, activities, variantNow };
  const busy = useRef(false);

  const loadCheckins = useCallback(async () => {
    try { const [c, h] = await Promise.all([habitsApi.checkins(), habitsApi.list()]); checkins.current = Array.isArray(c) ? c : []; habits.current = Array.isArray(h) ? h : []; } catch { /* no check-ins until it works */ }
  }, []);
  const loadPending = useCallback(async () => { try { const p = await habitsApi.pending(); setPending(Array.isArray(p) ? p : []); } catch { /* the Habits page shows errors */ } }, []);
  const answer = useCallback(async (ev: CheckinEvent) => {
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
      for (const k of activeCheckins(checkins.current, nowMs, variant)) {
        const habit = habits.current.find(h => h.id === k.habit_id);
        if (!habit || !appliesOn(habit, k.day)) continue;
        const ids = timeline.grids[variant]?.[k.weekday * SLOTS_PER_DAY + k.start_slot] ?? [];
        let ev: CheckinEvent | null = null;
        try { ev = await habitsApi.show(k.id, k.day, names(ids, activities), Math.floor(new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), new Date(nowMs).getDate(), 0, k.end_slot * 30).getTime() / 1000)); } catch { ev = null; } // null: already shown today, or already ticked
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
    onAnswerFromNotification = (_a, extra) => {
      const checkinId = typeof extra?.checkinId === "string" ? extra.checkinId : null, day = typeof extra?.day === "string" ? extra.day : null;
      if (checkinId && day) void habitsApi.answer(checkinId, day, "done").then(() => { announceHabits(); return loadPending(); }).catch(() => loadPending());
    };
    import("@tauri-apps/api/event").then(m => m.listen("timetable-tick", () => void check())).then(u => { if (gone) u(); else off = u; }).catch(() => { /* not running inside Tauri */ });
    return () => { gone = true; clearInterval(id); off?.(); onAnswerFromNotification = null; document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume); window.removeEventListener("nou-sim-changed", resume); window.removeEventListener(CHECKINS_CHANGED, changed); window.removeEventListener("nou-timetable-changed", changed); window.removeEventListener(HABITS_CHANGED, changed); window.removeEventListener(HABITS_CHANGED, habitsChanged); };
  }, [check, loadCheckins, loadPending]);

  return { visible: pending.filter(e => blockRunning(e, clock)), errors, answer };
}

/** The pop-ups themselves: one card per open check-in, with one tap to say Checked in. It stays for the whole block until ticked. */
export function CheckinPopups({ state }: { state: CheckinPopupState }) {
  if (!state.visible.length) return null;
  return <div className="checkin-stack" aria-label="Check-ins">
    {state.visible.map(ev => <section key={keyOf(ev)} className="checkin-pop" role="alertdialog" aria-label={`Check-in: ${ev.habit}`}>
      <div className="checkin-pop-head"><div><span className="checkin-pop-kicker">CHECK-IN · {slotTime(ev.start_slot)}</span><span className="checkin-pop-name">{ev.habit}</span><span className="checkin-pop-range">{ev.block ? ev.block + " · " : ""}{slotRange(ev.start_slot, ev.end_slot)}</span></div></div>
      {state.errors[keyOf(ev)] && <span className="checkin-err" role="alert">{state.errors[keyOf(ev)]}</span>}
      <div className="checkin-pop-actions"><button type="button" className="yes" onClick={() => void state.answer(ev)}>Checked in</button></div>
    </section>)}
  </div>;
}
