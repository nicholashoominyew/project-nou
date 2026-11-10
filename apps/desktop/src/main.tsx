import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Do NOT wrap <App /> in <React.StrictMode>. In development StrictMode mounts, unmounts and re-mounts
// every BlockNote editor; unmounting destroys y-prosemirror's UndoManager and the re-mount reuses the
// same editor state, so Ctrl+Z silently stops working (reproduced against the unchanged editor code).
// main.test.ts guards this.
createRoot(document.getElementById("root")!).render(<App />);
