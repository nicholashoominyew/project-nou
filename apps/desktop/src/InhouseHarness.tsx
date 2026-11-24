import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { HARNESS_PRESETS, type Harness, type InhouseChatInfo } from "./hubModel";

const msg = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");
type Form = { id?: number; name: string; instructions: string; always: boolean };
const MAX = 4000;

/**
 * Harnesses for Kura: named blocks of extra instructions written for NOU. A harness marked "every chat" is always given to the model; the others are
 * ticked per chat. They shape how Kura answers and what it knows about NOU. They do not give it access to your notes or any new ability.
 */
export default function InhouseHarness({ chatId, chat, harnesses, disabled, onChanged, onClose }: { chatId: number; chat?: InhouseChatInfo; harnesses: Harness[]; disabled?: boolean; onChanged: () => Promise<void>; onClose: () => void }) {
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const chosen = chat?.harnesses ?? [];
  const run = async (job: () => Promise<unknown>): Promise<boolean> => {
    try { await job(); setError(""); await onChanged(); return true; } catch (e) { setError(msg(e)); return false; }
  };
  const toggle = (h: Harness) => run(() => invoke("inhouse_chat_harnesses", { chatId, ids: chosen.includes(h.id) ? chosen.filter(x => x !== h.id) : [...chosen, h.id] }));
  const save = async () => {
    if (!form) return;
    if (await run(() => invoke("inhouse_harness_save", { id: form.id ?? null, name: form.name, instructions: form.instructions, always: form.always }))) setForm(null);
  };
  const remove = (h: Harness) => { if (window.confirm(`Delete the harness “${h.name}”? It is taken out of every chat.`)) void run(() => invoke("inhouse_harness_delete", { id: h.id })); };
  const taken = new Set(harnesses.map(h => h.name.trim().toLowerCase()));
  const presets = HARNESS_PRESETS.filter(p => !taken.has(p.name.toLowerCase()));

  return <div className="hub-harness" role="region" aria-label="Kura harness">
    <div className="hub-harness-head">
      <h3>Harness</h3>
      <button type="button" className="hub-ghost" onClick={onClose}>Back to chat</button>
    </div>
    <p className="hub-empty small">A harness is extra instructions for Kura, written for NOU. Tick the ones this chat should use; one marked “every chat” is used everywhere. Kura reads them each time it answers. They shape its answers; they do not give it access to your notes.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!harnesses.length && !form && <p className="hub-empty small">No harnesses yet. Add one below, or start from a template.</p>}
    <ul className="hub-harness-list" aria-label="Harnesses">
      {harnesses.map(h => <li key={h.id} className="hub-harness-row">
        <label className="hub-harness-pick">
          <input type="checkbox" checked={h.always || chosen.includes(h.id)} disabled={disabled || h.always} onChange={() => void toggle(h)} aria-label={`Use ${h.name} in this chat`} />
          <span className="hub-harness-name">{h.name}{h.always && <em className="hub-harness-tag">every chat</em>}</span>
        </label>
        <p className="hub-harness-preview">{h.instructions.length > 110 ? h.instructions.slice(0, 109) + "…" : h.instructions}</p>
        <span className="hub-harness-actions">
          <button type="button" className="hub-ghost" disabled={disabled} onClick={() => setForm({ id: h.id, name: h.name, instructions: h.instructions, always: h.always })} aria-label={`Edit ${h.name}`}>Edit</button>
          <button type="button" className="hub-ghost danger" disabled={disabled} onClick={() => remove(h)} aria-label={`Delete ${h.name}`}>Delete</button>
        </span>
      </li>)}
    </ul>
    {form
      ? <form className="hub-harness-form" aria-label={form.id ? "Edit harness" : "New harness"} onSubmit={e => { e.preventDefault(); void save(); }}>
          <label>Name<input value={form.name} maxLength={60} autoFocus onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label>Instructions<textarea rows={6} maxLength={MAX} value={form.instructions} placeholder="What should Kura know or do in NOU?" onChange={e => setForm({ ...form, instructions: e.target.value })} /></label>
          <span className="hub-harness-count">{form.instructions.length} / {MAX}</span>
          <label className="hub-harness-always"><input type="checkbox" checked={form.always} onChange={e => setForm({ ...form, always: e.target.checked })} />Use in every chat</label>
          <div className="hub-harness-formbtns">
            <button type="button" className="hub-ghost" onClick={() => { setForm(null); setError(""); }}>Cancel</button>
            <button type="submit" className="hub-ghost primary" disabled={disabled || !form.name.trim() || !form.instructions.trim()}>Save harness</button>
          </div>
        </form>
      : <div className="hub-harness-add">
          <button type="button" className="hub-ghost" disabled={disabled} onClick={() => setForm({ name: "", instructions: "", always: false })}>+ New harness</button>
          {presets.length > 0 && <div className="hub-harness-presets" role="group" aria-label="Templates for NOU">
            <span className="hub-eyebrow tight">TEMPLATES FOR NOU</span>
            {presets.map(p => <button key={p.name} type="button" className="hub-ghost" disabled={disabled} title="Fills in the form so you can read and change it before saving" onClick={() => setForm({ name: p.name, instructions: p.instructions, always: false })}>{p.name}</button>)}
          </div>}
        </div>}
  </div>;
}
