import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
// Fonts are bundled so the app looks right offline and under the strict CSP (no remote fonts).
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-sans-jp/400.css";
import "@fontsource/ibm-plex-sans-jp/500.css";
import "@fontsource/ibm-plex-sans-jp/600.css";
import "@fontsource/ibm-plex-sans-jp/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/barlow-condensed/700.css";
import "./habits.css";
import "./theme.css";

// Do NOT wrap <App /> in <React.StrictMode>. In development StrictMode mounts, unmounts and re-mounts
// every BlockNote editor; unmounting destroys y-prosemirror's UndoManager and the re-mount reuses the
// same editor state, so Ctrl+Z silently stops working (reproduced against the unchanged editor code).
// main.test.ts guards this.
createRoot(document.getElementById("root")!).render(<App />);
