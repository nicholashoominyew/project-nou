import { useCallback, useEffect, useRef, useState } from "react";
import { announceHabits, CHECKINS_CHANGED, habitsApi, HABITS_CHANGED } from "./habitsApi";
import { dueCheckins, slotRange, slotTime, type Checkin, type CheckinEvent } from "./habitsLogic";
import { now } from "./timetable/clock";
import { names, SLOTS_PER_DAY } from "./timetable/schedule";
import { useTimetable } from "./timetable/useTimetable";

const msg = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");
const keyOf = (e: Pick<CheckinEvent, "checkin_id" | "day">) => e.checkin_id + "|" + e.day;

// ---- the system notification (Windows desktop notification, with Checked in / Skipping buttons where the platform shows them) ----
let onAnswerFromNotification: ((answer: "done" | "skipped", extra: Record<string, unknown> | undefined) => void) | null = null;
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
        await n.registerActionTypes([{ id: "nou-checkin", actions: [{ id: "done", title: "Checked in" }, { id: "skipped", title: "Skipping" }] }]);
        await n.onAction(e => { if (e.actionId === "done" || e.actionId === "skipped") onAnswerFromNotification?.(e.actionId, e.notification?.extra); });
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

export type CheckinPopupState = { visible: CheckinEvent[]; errors: Record<string, string>; answer: (ev: CheckinEvent, a: "done" | "skipped") => Promise<void>; hide: (ev: CheckinEvent) => void };

/**
 * Mounted once for the whole app. Every few seconds it looks at the clock and, for each check-in whose timetable block has just started (and only if NOU was running and
 * looking a moment before, so a block that started while NOU was closed or asleep is ignored), records a pop-up and shows it, once. A pop-up left alone for two hours becomes
 * "no answer". Nothing happens when a block ends.
 */
export function useCheckinPopups(): CheckinPopupState {
  const { timeline, activities, variantNow } = useTimetable();
  const [pending, setPending] = useState<CheckinEvent[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const checkins = useRef<Checkin[]>([]);
  const last = useRef<number | null>(null);
  const latest = useRef({ timeline, activities, variantNow });
  latest.current = { timeline, activities, variantNow };
  const busy = useRef(false);

  const loadCheckins = useCallback(async () => { try { const c = await habitsApi.checkins(); checkins.current = Array.isArray(c) ? c : []; } catch { /* no check-ins until it works */ } }, []);
  const loadPending = useCallback(async () => { try { const p = await habitsApi.pending(); setPending(Array.isArray(p) ? p : []); } catch { /* the Habits page shows errors */ } }, []);
  const answer = useCallback(async (ev: CheckinEvent, a: "done" | "skipped") => {
    try { await habitsApi.answer(ev.checkin_id, ev.day, a); setErrors(old => { const n = { ...old }; delete n[keyOf(ev)]; return n; }); announceHabits(); }
    catch (e) { setErrors(old => ({ ...old, [keyOf(ev)]: msg(e) })); }
    await loadPending();
  }, [loadPending]);
  const hide = useCallback((ev: CheckinEvent) => setHidden(old => new Set(old).add(keyOf(ev))), []);

  const check = useCallback(async () => {
    if (busy.current) return; busy.current = true;
    try {
      const nowMs = now().getTime(), prev = last.current; last.current = nowMs;
      const { timeline, activities, variantNow } = latest.current;
      const variant = variantNow(new Date(nowMs));
      for (const k of dueCheckins(checkins.current, prev, nowMs, variant)) {
        const ids = timeline.grids[variant]?.[k.weekday * SLOTS_PER_DAY + k.start_slot] ?? [];
        let ev: CheckinEvent | null = null;
        try { ev = await habitsApi.show(k.id, k.day, names(ids, activities)); } catch { ev = null; }
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
      if (!gone) last.current = now().getTime(); // start looking from now: nothing that started earlier is replayed
    })();
    const id = setInterval(() => void check(), 5000);
    const resume = () => { if (!document.hidden) void check(); };
    const changed = () => void loadCheckins(); const habitsChanged = () => void loadPending();
    document.addEventListener("visibilitychange", resume); window.addEventListener("focus", resume); window.addEventListener("nou-sim-changed", resume);
    window.addEventListener(CHECKINS_CHANGED, changed); window.addEventListener("nou-timetable-changed", changed); window.addEventListener(HABITS_CHANGED, habitsChanged);
    onAnswerFromNotification = (a, extra) => {
      const checkinId = typeof extra?.checkinId === "string" ? extra.checkinId : null, day = typeof extra?.day === "string" ? extra.day : null;
      if (checkinId && day) void habitsApi.answer(checkinId, day, a).then(() => { announceHabits(); return loadPending(); }).catch(() => loadPending());
    };
    import("@tauri-apps/api/event").then(m => m.listen("timetable-tick", () => void check())).then(u => { if (gone) u(); else off = u; }).catch(() => { /* not running inside Tauri */ });
    return () => { gone = true; clearInterval(id); off?.(); onAnswerFromNotification = null; document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume); window.removeEventListener("nou-sim-changed", resume); window.removeEventListener(CHECKINS_CHANGED, changed); window.removeEventListener("nou-timetable-changed", changed); window.removeEventListener(HABITS_CHANGED, habitsChanged); };
  }, [check, loadCheckins, loadPending]);

  return { visible: pending.filter(e => !hidden.has(keyOf(e))), errors, answer, hide };
}

/** The pop-ups themselves: one card per open check-in, each with one tap to say Checked in or Skipping. Nothing to type. */
export function CheckinPopups({ state }: { state: CheckinPopupState }) {
  if (!state.visible.length) return null;
  return <div className="checkin-stack" aria-label="Check-ins">
    {state.visible.map(ev => <section key={keyOf(ev)} className="checkin-pop" role="alertdialog" aria-label={`Check-in: ${ev.habit}`}>
      <div className="checkin-pop-head"><div><span className="checkin-pop-kicker">CHECK-IN · {slotTime(ev.start_slot)}</span><span className="checkin-pop-name">{ev.habit}</span><span className="checkin-pop-range">{ev.block ? ev.block + " · " : ""}{slotRange(ev.start_slot, ev.end_slot)}</span></div>
        <button type="button" className="checkin-pop-x" aria-label={`Hide the ${ev.habit} check-in for now`} title="Hide for now. It stays on the Habits page until you answer." onClick={() => state.hide(ev)}>×</button></div>
      {state.errors[keyOf(ev)] && <span className="checkin-err" role="alert">{state.errors[keyOf(ev)]}</span>}
      <div className="checkin-pop-actions"><button type="button" className="yes" onClick={() => void state.answer(ev, "done")}>Checked in</button><button type="button" className="no" onClick={() => void state.answer(ev, "skipped")}>Skipping</button></div>
    </section>)}
  </div>;
}
