// Builds standalone/life-timetable.html: one file with the script, styles and fonts inside it. Run from apps/desktop:  node standalone/build.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, ".build");
execFileSync(process.execPath, [join(here, "..", "..", "..", "node_modules", "vite", "bin", "vite.js"), "build", "--config", join(here, "vite.config.ts")], { stdio: "inherit", cwd: join(here, "..") });
const files = readdirSync(join(out, "assets"));
const js = files.find(f => f.endsWith(".js")), css = files.find(f => f.endsWith(".css"));
if (!js || !css) throw new Error("The build did not produce one script and one stylesheet");
const safeScript = readFileSync(join(out, "assets", js), "utf8").replace(/<\/script/gi, "<\\/script");
const html = readFileSync(join(out, "index.html"), "utf8")
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>\s*/g, "")
  .replace(/<link rel="stylesheet"[^>]*>\s*/g, "")
  .replace("</head>", () => `<style>${readFileSync(join(out, "assets", css), "utf8")}</style></head>`)
  .replace("</body>", () => `<script type="module">${safeScript}</script></body>`);
writeFileSync(join(here, "life-timetable.html"), html);
rmSync(out, { recursive: true, force: true });
console.log(`Wrote standalone/life-timetable.html (${Math.round(html.length / 1024)} KB)`);
