import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// One self-contained page: the desktop app's own timetable code, with the database, events and notifications replaced by browser versions.
export default defineConfig({
  root: here("."),
  base: "./",
  plugins: [react()],
  resolve: { alias: {
    "@tauri-apps/api/core": here("./shims/core.ts"),
    "@tauri-apps/api/event": here("./shims/event.ts"),
    "@tauri-apps/plugin-notification": here("./shims/notification.ts"),
  } },
  build: { outDir: here("./.build"), emptyOutDir: true, target: "chrome105", assetsInlineLimit: 100_000_000, cssCodeSplit: false, rollupOptions: { output: { inlineDynamicImports: true } } },
});
