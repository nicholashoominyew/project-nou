import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "../src/theme.css";
import LifeTimetable from "../src/timetable/LifeTimetable";
import ReminderSettings from "../src/timetable/ReminderSettings";
import { ReminderToast, useReminders } from "../src/timetable/reminders";
import { exportData, importData } from "./store";

const THEME_KEY = "nou-standalone-theme";
function readTheme(): "dark" | "light" { try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; } }

function Page() {
  const [theme, setTheme] = useState(readTheme);
  const [note, setNote] = useState("");
  const [, bump] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const reminders = useReminders();
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; try { localStorage.setItem(THEME_KEY, theme); } catch { /* not remembered */ } }, [theme]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportData()], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "life-timetable-backup.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNote("Backup downloaded.");
  };
  const restore = async (f: File | undefined) => {
    if (!f) return;
    try { importData(await f.text()); setNote("Backup restored."); bump(n => n + 1); } catch (e) { setNote(String(e)); }
    if (file.current) file.current.value = "";
  };
  return <>
    <ReminderToast reminder={reminders.toast} dismiss={reminders.dismiss} />
    <div className="document" style={{ paddingBottom: 0 }}>
      <div className="tt-wrap center" style={{ justifyContent: "flex-end" }}>
        <span className="tt-mono-muted" role="status">{note}</span>
        <button type="button" className="tt-text-btn" onClick={download} title="Save your timetable to a file">Back up</button>
        <button type="button" className="tt-text-btn" onClick={() => file.current?.click()} title="Load a backup file">Restore</button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={e => void restore(e.target.files?.[0])} />
        <button type="button" className="tt-text-btn" onClick={() => setTheme(t => (t === "dark" ? "light" : "dark"))}>{theme === "dark" ? "Light mode" : "Dark mode"}</button>
      </div>
    </div>
    <LifeTimetable />
    <div className="document" style={{ paddingTop: 0 }}><ReminderSettings /></div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Page />);
