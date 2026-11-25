import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1", watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_"],
  // Fonts are never inlined as data: URLs: the app's content policy (tauri.conf.json) only allows its own files, so an inlined font is blocked in the installed app.
  build: { target: "chrome105", assetsInlineLimit: (file: string) => (/\.woff2?$/.test(file) ? false : undefined) }
});
