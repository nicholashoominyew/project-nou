import { describe, expect, it } from "vitest";
// @ts-ignore node built-ins are available in the test runner
import { readFileSync } from "node:fs";

// @ts-ignore process is available in the test runner
const read = (name: string) => readFileSync(process.cwd() + "/src/" + name, "utf8").replace(/\r\n/g, "\n") as string;
const theme = read("theme.css"), main = read("main.tsx"), styles = read("styles.css");

/** The custom properties declared in the first block that starts with `selector{`. */
function tokens(selector: string): Record<string, string> {
  const start = theme.indexOf(selector + "{");
  const body = theme.slice(start + selector.length + 1, theme.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const light = tokens(":root"), dark = { ...light, ...tokens(":root[data-theme=dark]") };
const rgb = (hex: string) => { const h = hex.replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const lum = (hex: string) => { const [r, g, b] = rgb(hex).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe("Elementel theme tokens", () => {
  it("has the light (white and blue) and dark (black, yellow, white) palettes from the brief", () => {
    expect(light).toMatchObject({ "--bg": "#ffffff", "--panel": "#f5f7fb", "--card": "#ffffff", "--line": "#e1e6ef", "--text": "#0e1a2b", "--muted": "#5b6880", "--accent": "#1d4ed8", "--accent-ink": "#ffffff", "--active": "#e2eafc", "--track": "#eef1f6", "--raised": "#ffffff", "--danger": "#c0352b" });
    expect(dark).toMatchObject({ "--bg": "#0b0c0e", "--panel": "#121317", "--card": "#1b1d23", "--line": "#2b2e36", "--text": "#ecebe7", "--muted": "#8e919a", "--accent": "#ffff90", "--accent-ink": "#17170a", "--active": "#23252c", "--track": "#121317", "--raised": "#23252c", "--danger": "#ff8a7a" });
    expect(light["--accent-soft"]).toBe("rgba(29,78,216,.14)"); expect(dark["--accent-soft"]).toBe("rgba(255,255,144,.16)");
  });
  it("keeps text at 4.5:1 or better in both themes, including the small muted labels", () => {
    for (const [name, t] of [["light", light], ["dark", dark]] as const) {
      for (const [fg, bg] of [["--text", "--bg"], ["--text", "--panel"], ["--muted", "--bg"], ["--muted", "--panel"], ["--muted", "--card"], ["--accent", "--bg"], ["--accent-ink", "--accent"], ["--danger", "--bg"], ["--text", "--raised"], ["--muted", "--track"]]) {
        const ratio = contrast(t[fg], t[bg]);
        expect(ratio, `${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("re-points the sidebar variables used by styles.css", () => {
    for (const k of ["--sb-bg", "--sb-hover", "--sb-active", "--sb-text", "--sb-muted"]) { expect(light[k]).toBeTruthy(); expect(tokens(":root[data-theme=dark]")[k]).toBeTruthy(); }
  });
  it("puts text on the accent colour in --accent-ink so dark mode never shows white on yellow", () => {
    expect(styles).not.toMatch(/background:var\(--accent\)[^}]*color:#fff/);
    expect(styles).toMatch(/\.db-tl-bar\{[^}]*color:var\(--accent-ink\)/);
    expect(styles).toMatch(/\.db-cal-cell\.today \.db-cal-day span\{[^}]*color:var\(--accent-ink\)/);
    expect(theme).toMatch(/\.flowchart-node\.terminal text\{fill:var\(--accent-ink\)\}/);
    expect(theme).toMatch(/\.fab\{[^}]*background:var\(--accent\);color:var\(--accent-ink\)/);
  });
});

describe("fonts and loading order", () => {
  it("bundles the fonts instead of loading them from the web, and loads theme.css last", () => {
    for (const f of ["@fontsource/ibm-plex-sans/400.css", "@fontsource/ibm-plex-sans/700.css", "@fontsource/ibm-plex-sans-jp/400.css", "@fontsource/ibm-plex-sans-jp/700.css", "@fontsource/jetbrains-mono/400.css", "@fontsource/jetbrains-mono/500.css"]) expect(main).toContain(`import "${f}";`);
    expect(main.indexOf('import "./styles.css"')).toBeLessThan(main.indexOf("@fontsource/ibm-plex-sans/400.css"));
    expect(main.lastIndexOf("import")).toBe(main.indexOf('import "./theme.css"'));
    expect(theme + styles).not.toMatch(/fonts\.googleapis|fonts\.gstatic|https?:\/\/[^"')]*\.(woff2?|ttf)/);
  });
  it("uses Plex for text and JetBrains Mono for small upper-case labels", () => {
    expect(theme).toMatch(/--font-body:"IBM Plex Sans","IBM Plex Sans JP"/);
    expect(theme).toMatch(/--font-mono:"JetBrains Mono"/);
    expect(theme).toMatch(/font-size:10px;font-weight:500;letter-spacing:\.14em;text-transform:uppercase/);
  });
  it("sets the type scale: 40px page title, 30/24/20 headings, 16px body, sentence-case headings", () => {
    expect(theme).toMatch(/\.title-input\{font-size:40px;font-weight:700;letter-spacing:-\.02em/);
    expect(theme).toMatch(/data-level="1"\]\{--level:30px\}/); expect(theme).toMatch(/data-level="2"\]\{--level:24px\}/); expect(theme).toMatch(/data-level="3"\]\{--level:20px\}/);
    expect(theme).toMatch(/:root,body\{[^}]*font-size:16px;line-height:1\.6/);
    expect(theme).toMatch(/\.home-head h1\{[^}]*text-transform:none/);
  });
});

describe("chrome rules from the brief", () => {
  it("floating Quick capture: 52px accent circle with a soft ring, hidden in focus mode and print", () => {
    expect(theme).toMatch(/\.fab\{position:fixed;right:28px;bottom:calc\(28px/);
    expect(theme).toMatch(/width:52px;height:52px;[^}]*border-radius:50%/);
    expect(theme).toMatch(/box-shadow:0 0 0 6px var\(--accent-soft\),0 10px 28px rgba\(0,0,0,\.28\)/);
    expect(theme).toMatch(/\.shell\.focus \.fab\{display:none!important\}/);
    expect(theme).toMatch(/@media print\{[^]*\.fab[^]*display:none!important/);
  });
  it("tab bar: a track of pills, the selected tab is a raised bubble with an accent dot, close shows on the selected tab and on hover or focus", () => {
    expect(theme).toMatch(/\.page-tabs\{[^}]*padding:3px;border-radius:10px;background:var\(--track\)/);
    expect(theme).toMatch(/\.page-tab\{height:28px;min-width:96px;max-width:200px;border:0;border-radius:7px/);
    expect(theme).toMatch(/\.page-tab\.selected\{background:var\(--raised\)[^}]*font-weight:600;box-shadow:0 1px 2px rgba\(0,0,0,\.12\),0 0 0 1px var\(--line\)/);
    expect(theme).toMatch(/\.page-tab\.selected \.tab-dot\{background:var\(--accent\)[^}]*box-shadow:0 0 0 3px var\(--accent-soft\)/);
    expect(theme).toMatch(/\.page-tab>\.close-tab\{display:none/);
    expect(theme).toMatch(/\.page-tab\.selected>\.close-tab,\.page-tab:hover>\.close-tab,\.page-tab:focus-within>\.close-tab\{display:grid\}/);
    expect(theme).toMatch(/\.tab-new\{[^}]*width:30px;height:30px;[^}]*border:1px dashed var\(--line\);border-radius:8px/);
  });
  it("sidebar: accent square mark, compact 28px rows, active row with an accent bar, mono labels", () => {
    expect(theme).toMatch(/\.sb-header \.mark\{width:26px;height:26px;border-radius:6px;background:var\(--accent\);color:var\(--accent-ink\)/);
    expect(theme).toMatch(/\.sb-item,\.tree-row\{min-height:28px/);
    expect(theme).toMatch(/\.sb-item\.active,\.tree-row\.active\{background:var\(--active\);font-weight:600;box-shadow:inset 2px 0 0 var\(--accent\)\}/);
    expect(theme).toMatch(/\.sb-item\.active svg,\.tree-row\.active \.row-icon\{color:var\(--accent\)\}/);
  });
  it("backlinks are one quiet line, about a third of the old height", () => {
    expect(theme).toMatch(/\.backlinks\{display:flex;[^}]*opacity:\.75/);
    expect(theme).toMatch(/\.backlinks h2\{margin:0;font-size:9px\}/);
    expect(theme).toMatch(/\.backlinks button\{border:0;background:transparent;padding:0;[^}]*font-size:11px[^}]*text-decoration:underline/);
  });
  it("Home: approvals span the grid, cards are 8px panels, and state is a 7px dot with a soft ring when live", () => {
    expect(theme).toMatch(/\.home-card\[aria-label="Waiting for your approval"\]\{grid-column:1\/-1\}/);
    expect(theme).toMatch(/\.home-card\{background:var\(--panel\);border:1px solid var\(--line\);border-radius:8px;padding:16px 18px\}/);
    expect(theme).toMatch(/\.state-dot\{[^}]*width:7px;height:7px;border-radius:50%/);
    expect(theme).toMatch(/\.state-dot\.live\{background:var\(--accent\);box-shadow:0 0 0 3px var\(--accent-soft\)\}/);
  });
  it("print keeps plain light colours", () => {
    expect(theme).toMatch(/@media print\{\s*:root,:root\[data-theme=dark\]\{--bg:#ffffff;[^}]*--text:#000000/);
  });
  it("passes the tokens to BlockNote", () => {
    expect(theme).toMatch(/\.note-editor \.bn-container\[data-color-scheme\]\{/);
    for (const k of ["--bn-colors-editor-text", "--bn-colors-editor-background", "--bn-colors-menu-background", "--bn-colors-hovered-background", "--bn-colors-selected-background", "--bn-colors-border"]) expect(theme).toContain(k + ":");
  });
});
