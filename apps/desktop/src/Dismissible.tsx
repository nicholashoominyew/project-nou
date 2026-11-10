import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/** Calls onClose when the user presses Escape or clicks/taps anywhere outside `ref` while `open`. */
export function useDismiss(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (ref.current && !ref.current.contains(event.target as Node)) latest.current(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") latest.current(); };
    // Capture phase, so a component that stops propagation cannot keep a stale popover open.
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
  }, [open, ref]);
}

/** A <details> disclosure that closes itself on outside click or Escape (menus, dropdowns, tool lists). */
export function DismissibleDetails({ className, summary, summaryLabel, children }: { className?: string; summary: ReactNode; summaryLabel?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(open, () => { if (ref.current) ref.current.open = false; }, ref);
  return <details ref={ref} className={className} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label={summaryLabel}>{summary}</summary>{children}
  </details>;
}
