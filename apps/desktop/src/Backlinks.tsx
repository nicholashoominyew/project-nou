import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Linked = { id: string; title: string };

/** "Linked from" — pages that contain a link to this page. Hidden when nothing links here. */
export default function Backlinks({ pageId, refreshKey, onOpen }: { pageId: string; refreshKey?: string; onOpen: (id: string) => void }) {
  const [pages, setPages] = useState<Linked[]>([]);
  useEffect(() => {
    let cancelled = false;
    setPages([]);
    void invoke<Linked[]>("list_backlinks", { pageId }).then(list => { if (!cancelled && Array.isArray(list)) setPages(list); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [pageId, refreshKey]);
  if (!pages.length) return null;
  return <section className="backlinks" aria-label="Linked from">
    <h2>Linked from <span className="backlinks-count">{pages.length}</span></h2>
    <ul>{pages.map(p => <li key={p.id}><button onClick={() => onOpen(p.id)}>{p.title}</button></li>)}</ul>
  </section>;
}
