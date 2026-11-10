import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Linked = { id: string; title: string };

/**
 * "Linked from": pages that contain a link to this page; hidden when there are none. Loaded when a page opens, not on every save: saving this page cannot change which other pages link to it. Keeping it out
 * of the save cycle also stops the panel from vanishing and reappearing (and shifting the editor) while you type.
 */
export default function Backlinks({ pageId, onOpen }: { pageId: string; onOpen: (id: string) => void }) {
  const [pages, setPages] = useState<Linked[]>([]);
  useEffect(() => {
    let cancelled = false;
    setPages([]);
    void invoke<Linked[]>("list_backlinks", { pageId }).then(list => { if (!cancelled && Array.isArray(list)) setPages(list); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [pageId]);
  if (!pages.length) return null;
  return <section className="backlinks" aria-label="Linked from">
    <h2>Linked from <span className="backlinks-count">{pages.length}</span></h2>
    <ul>{pages.map(p => <li key={p.id}><button onClick={() => onOpen(p.id)}>{p.title}</button></li>)}</ul>
  </section>;
}
