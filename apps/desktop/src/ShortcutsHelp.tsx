import { useRef } from "react";
import { useDismiss } from "./Dismissible";

const GROUPS: { title: string; items: [string, string][] }[] = [
  { title: "Pages and tabs", items: [
    ["Ctrl+Q", "Quick find"], ["Ctrl+N", "New page"], ["Ctrl+W", "Close tab"], ["Ctrl+Tab / Ctrl+Shift+Tab", "Next / previous tab"],
    ["Ctrl+1 … 8", "Go to that tab"], ["Ctrl+9", "Go to the last tab"], ["Ctrl+Shift+T", "Reopen the last closed tab"],
    ["Ctrl+[ / Ctrl+]", "Back / forward through visited pages"], ["Ctrl+Shift+U", "Go to the parent page"],
  ] },
  { title: "Window", items: [
    ["Ctrl+\\", "Show or hide the sidebar"], ["F11", "Full screen"], ["Ctrl+P", "Print the page"], ["Ctrl+Shift+L", "Light / dark mode"],
    ["Ctrl+= / Ctrl+− / Ctrl+0", "Zoom in / out / reset"], ["Ctrl+/", "This list"],
  ] },
  { title: "Editing", items: [
    ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["Ctrl+C / Ctrl+X / Ctrl+V", "Copy / cut / paste"], ["Ctrl+Shift+V", "Paste without formatting"],
    ["Ctrl+D", "Duplicate the current block"], ["Ctrl+Shift+↑ / ↓", "Move the block up / down"], ["Tab / Shift+Tab", "Indent / outdent"],
    ["Ctrl+Alt+1 … 6", "Heading 1 – 6"], ["Ctrl+Alt+0", "Plain paragraph"], ["Ctrl+Shift+7 / 8 / 9", "Numbered / bulleted / to-do list"],
    ["Ctrl+Alt+C / Ctrl+Alt+Q", "Code block / quote"], ["/", "Insert a block (page, database, image, file …)"], ["@", "Link to a page"], [":", "Emoji"],
  ] },
];

/** Ctrl+/ cheat sheet. Everything listed here is wired up in the app or provided by the editor. */
export default function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  return <div className="quick-find-backdrop">
    <div className="shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" ref={ref}>
      <header><h2>Keyboard shortcuts</h2><button onClick={onClose} aria-label="Close shortcuts">Close</button></header>
      <div className="shortcuts-body">
        {GROUPS.map(group => <section key={group.title}><h3>{group.title}</h3>
          <dl>{group.items.map(([keys, what]) => <div key={keys}><dt>{keys}</dt><dd>{what}</dd></div>)}</dl></section>)}
      </div>
    </div>
  </div>;
}
