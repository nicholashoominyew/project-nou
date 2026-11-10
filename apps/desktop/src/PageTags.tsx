import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Tag chips under a page title. Type a tag and press Enter or comma; click × to remove. Suggestions come from existing tags. */
export default function PageTags({ pageId, readOnly, onError }: { pageId: string; readOnly: boolean; onError: (e: unknown) => void }) {
  const [tags, setTags] = useState<string[]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const load = useCallback(async () => {
    const [mine, all] = await Promise.all([invoke<string[]>("get_page_tags", { pageId }), invoke<{ name: string }[]>("list_tags")]);
    setTags(Array.isArray(mine) ? mine : []);
    setKnown(Array.isArray(all) ? all.map(t => t.name) : []);
  }, [pageId]);
  useEffect(() => { setTags([]); setDraft(""); void load().catch(() => undefined); }, [load]);

  async function save(next: string[]) {
    try { const saved = await invoke<string[]>("set_page_tags", { pageId, names: next }); setTags(Array.isArray(saved) ? saved : next); void load().catch(() => undefined); }
    catch (e) { onError(e); void load().catch(() => undefined); }
  }
  function commit() {
    const names = draft.split(",").map(t => t.trim()).filter(Boolean);
    setDraft("");
    if (names.length) void save([...tags, ...names]);
  }
  const listId = "tag-suggestions-" + pageId;
  if (readOnly && !tags.length) return null;
  return <div className="page-tags" aria-label="Tags">
    {tags.map(tag => <span key={tag} className="page-tag">#{tag}{!readOnly && <button aria-label={"Remove tag " + tag} onClick={() => void save(tags.filter(t => t !== tag))}>×</button>}</span>)}
    {!readOnly && <>
      <input aria-label="Add a tag" placeholder={tags.length ? "Add tag" : "Add tags"} value={draft} list={listId} maxLength={40}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); } else if (e.key === "Backspace" && !draft && tags.length) void save(tags.slice(0, -1)); }} />
      <datalist id={listId}>{known.filter(k => !tags.some(t => t.toLowerCase() === k.toLowerCase())).map(k => <option key={k} value={k} />)}</datalist>
    </>}
  </div>;
}
