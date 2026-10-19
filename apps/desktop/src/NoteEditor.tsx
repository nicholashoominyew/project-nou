import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as Y from "yjs";

type SaveStatus = "loading" | "saved" | "saving" | "failed";

/** Phase 1 prototype text editor. CRDT updates persist in SQLite; BlockNote UI comes later. */
export default function NoteEditor({ pageId }: { pageId: string }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [error, setError] = useState("");
  const docRef = useRef<Y.Doc | null>(null);
  const pendingRef = useRef<Promise<void>>(Promise.resolve());
  const failedRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const document = new Y.Doc();
    docRef.current = document;
    failedRef.current = false;
    setText("");
    setError("");
    setStatus("loading");

    void invoke<number[][]>("load_note_updates", { pageId })
      .then((updates) => {
        if (cancelled) return;
        for (const bytes of updates) Y.applyUpdate(document, Uint8Array.from(bytes));
        setText(document.getText("body").toString());
        setStatus("saved");
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setStatus("failed");
          setError(String(reason));
          failedRef.current = true;
        }
      });

    return () => {
      cancelled = true;
      if (docRef.current === document) docRef.current = null;
      // Unmount does not cancel previously queued SQLite writes.
      // Keep the Y.Doc alive until any enqueued writes resolve.
      void pendingRef.current.finally(() => document.destroy());
      pendingRef.current = Promise.resolve();
    };
  }, [pageId]);

  function change(next: string) {
    const document = docRef.current;
    if (!document || status === "loading" || failedRef.current) return;
    const body = document.getText("body");
    const previous = body.toString();
    if (next === previous) return;

    document.transact(() => {
      body.delete(0, body.length);
      body.insert(0, next);
    }, "local-input");

    setText(next);
    setStatus("saving");
    // Use a complete-state update for every save. It's idempotent under Yjs merge.
    // This avoids a lost intermediate update if an earlier write fails.
    const update = Array.from(Y.encodeStateAsUpdate(document));
    const currentPage = pageId;
    const generation = ++generationRef.current;
    const previousWrite = pendingRef.current;
    const nextWrite = previousWrite.then(() =>
      invoke<number>("append_note_update", {
        pageId: currentPage, update, plainText: next
      }).then(() => undefined)
    );

    pendingRef.current = nextWrite.catch((reason: unknown) => {
      failedRef.current = true;
      setError("Saving failed: " + String(reason) + ". Copy your text before leaving this page.");
      setStatus("failed");
      throw reason;
    });

    // Prevent an unhandled rejection while ensuring failed saves stop the queue.
    void pendingRef.current.catch(() => undefined);
    void nextWrite.then(() => {
      if (docRef.current === document && generationRef.current === generation) {
        setStatus("saved");
      }
    }).catch(() => undefined);
  }

  return <section className="note-editor">
    <div className="save-status" aria-live="polite">
      {status === "loading" ? "Opening note…" : status === "saving" ? "Saving locally…" :
        status === "saved" ? "Saved on this device" : "Save error"}
    </div>
    {error && <p className="editor-error" role="alert">{error}</p>}
    <textarea
      aria-label="Note content"
      value={text}
      disabled={status === "loading" || (status === "failed" && !text)}
      placeholder="Start writing your note…"
      onChange={event => change(event.target.value)}
      spellCheck
    />
    <p className="editor-help">Offline text editor preview · Rich-text blocks are the next milestone.</p>
  </section>;
}
