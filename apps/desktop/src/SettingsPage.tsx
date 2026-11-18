import { Icon } from "./Icons";

type Props = { trashedCount: number; disabled: boolean; readOnly: boolean; onBackups: () => void; onImport: () => void; onTrash: () => void; onAccess: () => void };

/** App-wide tools that used to sit at the bottom of the sidebar: backups and restore, importing a recovered note, the trash, and AI access. */
export default function SettingsPage({ trashedCount, disabled, readOnly, onBackups, onImport, onTrash, onAccess }: Props) {
  const cards: { icon: string; title: string; text: string; action: string; run: () => void; off: boolean; meta?: string }[] = [
    { icon: "archive", title: "Backups & restore", text: "Make a backup of your notes, restore from one, or set up automatic and encrypted backups.", action: "Open", run: onBackups, off: disabled },
    { icon: "import", title: "Import a recovered note", text: "Bring back a note from a recovery file you exported earlier. The note is added as a new page.", action: "Import…", run: onImport, off: disabled || readOnly },
    { icon: "trash", title: "Trash", text: "Pages you deleted stay here until you restore them. Restoring a page also restores its subpages deleted at the same time.", action: "Open trash", run: onTrash, off: disabled, meta: String(trashedCount) },
    { icon: "link", title: "AI access", text: "Give an AI tool a token so it can read what you allow and ask for changes. You approve each change.", action: "Manage", run: onAccess, off: false },
  ];
  return <div className="document settings-screen">
    <h1>Settings</h1>
    <p className="hint">Tools that apply to the whole app. Everything is stored on this device.</p>
    <ul className="settings-list" aria-label="Settings">
      {cards.map(c => <li key={c.title} className="settings-card">
        <span className="settings-icon" aria-hidden="true"><Icon name={c.icon} size={20} /></span>
        <div className="settings-text"><h2>{c.title}{c.meta !== undefined && <em aria-label={c.meta + " pages"}>{c.meta}</em>}</h2><p>{c.text}</p></div>
        <button disabled={c.off} onClick={c.run}>{c.action}</button>
      </li>)}
    </ul>
  </div>;
}
