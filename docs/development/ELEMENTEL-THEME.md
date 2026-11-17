# Elementel look

A visual restyle of the desktop app, following `NOU-ELEMENTEL-REDESIGN.md` and the design reference. No behaviour, data or Rust changes.

## Where it lives
- `src/theme.css`, imported last in `src/main.tsx`, re-points the colour tokens used by `styles.css` (`--bg --panel --text --muted --line --hover --accent` and the `--sb-*` sidebar set) and adds `--card --accent-ink --accent-soft --active --track --raised --danger`. Layout and behaviour stay in `styles.css`.
- Fonts are bundled with `@fontsource` (IBM Plex Sans 400 to 700, IBM Plex Sans JP 400 to 700, JetBrains Mono 400 and 500) because the app CSP blocks remote fonts and NOU must work offline. The 脳 glyph uses the system Yu Mincho / Hiragino Mincho serif.

## Palettes
- **Light:** white ground, navy ink, blue accent `#1d4ed8` (white text on it).
- **Dark:** near-black ground, warm white ink, yellow accent `#ffff90` (near-black text on it). Text on the accent colour is always `--accent-ink`, so dark mode never shows white on yellow.
- State is a 7px dot plus a word. A live state is an accent dot with a 3px soft ring; an idle state is a muted dot. Used on Home card headers and the selected tab.

## Changes you can see
- **Sidebar:** the 脳 mark is a 26px accent square. The order is search, Home, Graph, Files. Rows are compact (28px, 13px text, 16px indent per level), the active row has an accent bar, labels are small mono caps. The Quick capture row is gone.
- **Quick capture** is a floating round accent button at the bottom right (hidden in focus mode and print). Ctrl+Shift+A still opens it; the shortcut is not shown anywhere.
- **Tab bar:** tabs sit in a track as pills. The selected tab is a raised bubble with an accent dot, other tabs have a hollow dot. The close button shows on the selected tab and on hover or keyboard focus. A dashed **+** opens Quick find. Theme and fullscreen are stroke icons.
- **Page view:** 40px bold title, sentence-case headings (30/24/20px), 16px body, links in the accent colour, tag pills, outlined action buttons with a red Trash. **Linked from** is one quiet line.
- **Home:** greeting in sentence case with the accent 脳, New page as the primary button, panel cards with a mono header and state dot, approvals across the full width.
- BlockNote gets the same tokens through `--bn-colors-*`. Print keeps plain light colours.

## Verified
- Vitest: palettes match the brief; every text pair (including the small muted labels and text on the accent colour) is at least 4.5:1 in both themes; no remote font URLs; fonts and `theme.css` load in the right order; the key rules for the floating button, tabs, sidebar, backlinks, Home cards and print; plus app tests for the sidebar order, the missing Quick capture row, the floating button, the tab dot, the + button and the icon window tools, and for the Home state dots.
- `tsc` is clean and the whole suite passes.

## Not verified
- It has not been looked at in a real window yet, in either theme, so spacing and the BlockNote menus need an eye. Offline loading of the fonts in the packaged app has not been checked. The before and after screenshots for the pull request still need taking.
- The old draft in `_to_delete/` was left alone.
