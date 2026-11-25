// The app's side of auto-approval (docs/development/AUTO-APPROVE.md). The backend decides what a rule covers; this applies it,
// after the backend has checked once more, through the same code an approval by hand uses.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { applyProposal, type ApplyAfter, type Proposal } from "./gatewayApply";
import { removeAddedBlocks, type AddedBlock } from "./noteAppend";

export type AutoRule = { id: string; name: string; page_id: string | null; include_subtree: boolean; ops: string[]; source: string | null; enabled: boolean; per_hour: number };
export type AutoOverview = { feature_on: boolean; paused: boolean; rules: AutoRule[]; sources: string[] };
export type AutoRecent = { proposal_id: string; at: string; source: string; op: string; rule_name: string; page_id: string | null; page_title: string | null; change_text: string; summary: string; status: string; result: string | null; undone_at: string | null; seen: boolean };
export type AutoUnseen = { count: number; pages: string[] };
export const AUTO_OPS = ["create_page", "append_text", "add_checklist_item", "create_row", "set_value", "rename_page"] as const;

/** Something about auto-approval changed (applied, undone, switched, seen): screens read again. */
export const AUTO_CHANGED = "nou:auto-changed";
export const OPEN_AUTO = "nou:open-auto";
export const announceAuto = () => { try { window.dispatchEvent(new Event(AUTO_CHANGED)); } catch { /* only a refresh hint */ } };
export const openAutoScreen = () => { try { window.dispatchEvent(new Event(OPEN_AUTO)); } catch { /* only a request */ } };
const noteChanged = (pageId: string) => { try { window.dispatchEvent(new CustomEvent("nou:note-changed", { detail: pageId })); } catch { /* only a refresh hint */ } };

let running: Promise<number> | null = null;
/** Apply everything a rule has approved, one at a time. Returns how many were applied or failed. */
export function runAutoApply(): Promise<number> {
  running ??= (async () => {
    let done = 0;
    const ids = (await invoke<string[]>("auto_pending")) ?? [];
    for (const id of Array.isArray(ids) ? ids : []) {
      // The pause switch, the rule and the page are checked again here; null means it went back to waiting for the owner.
      const p = await invoke<Proposal | null>("auto_claim", { id });
      if (!p) continue;
      const after: ApplyAfter = {};
      const outcome = await applyProposal(p, after);
      await invoke("auto_applied", { id, ok: outcome.ok, result: outcome.result, after });
      done++;
    }
    return done;
  })().finally(() => { running = null; });
  return running;
}

/** Take one automatic change back. Throws a plain message when it can't be done safely. */
export async function undoAuto(id: string): Promise<void> {
  const plan = await invoke<{ kind: "trash" | "rename" | "clear" | "blocks"; page?: string; row?: string; property?: string; title?: string; blocks?: AddedBlock[] }>("auto_undo_plan", { id });
  if (plan.kind === "trash") await invoke("trash_page", { pageId: plan.page });
  else if (plan.kind === "rename") await invoke("rename_page", { pageId: plan.page, title: plan.title });
  else if (plan.kind === "clear") await invoke("set_value", { rowId: plan.row, propertyId: plan.property, value: null });
  else { await removeAddedBlocks(plan.page!, plan.blocks!); noteChanged(plan.page!); }
  await invoke("auto_undone", { id });
  announceAuto();
}

/** Mounted once. Applies what rules approve (at once when the backend says so, and every few seconds), and keeps the badges current. */
export function useAutoApply(disabled: boolean, refresh: () => Promise<void> | void): AutoUnseen {
  const [unseen, setUnseen] = useState<AutoUnseen>({ count: 0, pages: [] });
  const latest = useRef({ disabled, refresh }); latest.current = { disabled, refresh };
  useEffect(() => {
    let gone = false; let off: (() => void) | undefined;
    const badges = async () => { try { const u = await invoke<AutoUnseen>("auto_unseen"); if (!gone && u && Array.isArray(u.pages)) setUnseen(old => (old.count === u.count && old.pages.join() === u.pages.join() ? old : u)); } catch { /* badges are a convenience */ } };
    const tick = async () => {
      if (latest.current.disabled) return;
      try { if (await runAutoApply()) { await latest.current.refresh(); announceAuto(); } } catch { /* tried again at the next look */ }
      await badges();
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    const changed = () => void badges();
    window.addEventListener(AUTO_CHANGED, changed);
    import("@tauri-apps/api/event").then(m => m.listen("auto-approved", () => void tick())).then(u => { if (gone) u(); else off = u; }).catch(() => { /* not inside Tauri */ });
    return () => { gone = true; window.clearInterval(timer); window.removeEventListener(AUTO_CHANGED, changed); off?.(); };
  }, []);
  return unseen;
}
