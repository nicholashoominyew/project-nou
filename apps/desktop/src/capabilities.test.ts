import { expect, it } from "vitest";
import capabilities from "../src-tauri/capabilities/default.json?raw";
import appSource from "./App.tsx?raw";

// App.tsx registers an onCloseRequested handler (to protect unsaved work). Tauri's JS API then calls
// window.destroy() itself whenever the handler does not cancel the close, and that call is rejected
// unless the capability grants it, which leaves the X button doing nothing.
it("grants the window permissions that the close-request handler relies on", () => {
  expect(appSource).toContain("onCloseRequested");
  const permissions: string[] = JSON.parse(capabilities).permissions;
  expect(permissions).toContain("core:window:allow-destroy");
  expect(permissions).toContain("core:window:allow-close");
});
