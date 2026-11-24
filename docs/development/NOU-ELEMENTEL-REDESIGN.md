# NOU — Elementel redesign: implementation brief for Claude Code

**Design reference (open it before starting):** https://claude.ai/artifact/2evrhgaM84WJZPUXYdWeW3
Four artboards: Home (light, dark) and an Inbox note page (light, dark). Match them. The exact Home markup is in `reference/Main.dc.html`.

**Scope:** visual restyle of the desktop app (`apps/desktop`) plus three small UI changes: the sidebar order, a Quick capture button and the tab bar. No behaviour, data or Rust changes.

---

## 0. Ground rules

- The working tree has **uncommitted quick-capture work** (`CustomBlocks.tsx`, `NoteEditor.tsx`, `QuickCapture.tsx`, `captureParse.ts`, `noteAppend.ts`, `styles.css`, `vite.config.ts`, …). **Do not discard, reformat or commit it as part of this work.** Ask Nick to commit or stash it first, then branch: `git switch -c feature/elementel-redesign`.
- **Files use CRLF line endings.** Keep them CRLF.
- **Fonts must be bundled.** The Tauri CSP is `default-src 'self'` with no `font-src`, and NOU must work offline, so Google Fonts URLs will not load.
- Keep every existing `aria-label`, keyboard shortcut and test id. Ctrl+Shift+A must still open Quick capture.
- Do not wrap `<App />` in StrictMode (`main.test.ts` guards this).
- Finish with `npm run typecheck` and `npm test` from the repo root. Update any tests that assert removed markup, such as the Quick capture sidebar row or its `<kbd>`.

## 1. Fonts

```
npm i -w @nou/desktop @fontsource/ibm-plex-sans @fontsource/ibm-plex-sans-jp @fontsource/jetbrains-mono
```

Import the weights you use in `src/main.tsx`, after `./styles.css`:
- Plex Sans 400/500/600/700
- Plex Sans JP 400/500/600/700, which loads in unicode-range chunks
- JetBrains Mono 400/500

| Role | Stack |
|---|---|
| Body + headings | `'IBM Plex Sans', 'IBM Plex Sans JP', 'Yu Gothic UI', 'Segoe UI', system-ui, sans-serif` |
| Labels / meta | `'JetBrains Mono', Consolas, monospace`, **10–11px, uppercase, letter-spacing .14em** |
| 脳 logo glyph | `'Yu Mincho', 'Hiragino Mincho ProN', serif` (system font; no extra download), or reuse `assets/nou-icon.svg` |

**Type scale (Notion-like):**
- Page title 40px/700, letter-spacing −.02em
- H1 in editor 30px, H2 24px/600, H3 20px/600
- Body 16px, line-height 1.6
- Sidebar rows 13px
- Headings are **sentence case**: no uppercase transform on titles

## 2. Colour tokens

Add a new stylesheet `src/theme.css`, imported last, that re-points the existing variables in `styles.css`: `--bg --panel --text --muted --line --hover --accent` plus the sidebar set `--sb-*`. Add the new ones below.

| Token | Light (white + blue) | Dark (black + yellow + white) |
|---|---|---|
| `--bg` page | `#ffffff` | `#0b0c0e` |
| `--panel` sidebar, cards | `#f5f7fb` | `#121317` |
| `--card` raised surface | `#ffffff` | `#1b1d23` |
| `--line` borders | `#e1e6ef` | `#2b2e36` |
| `--text` ink | `#0e1a2b` | `#ecebe7` |
| `--muted` | `#5b6880` | `#8e919a` |
| `--accent` | `#1d4ed8` | `#ffff90` |
| `--accent-ink` text on accent | `#ffffff` | `#17170a` |
| `--accent-soft` rings, tints | `rgba(29,78,216,.14)` | `rgba(255,255,144,.16)` |
| `--active` selected row | `#e2eafc` | `#23252c` |
| `--track` tab track | `#eef1f6` | `#121317` |
| `--raised` selected tab | `#ffffff` | `#23252c` |
| `--danger` | `#c0352b` | `#ff8a7a` |

**Watch for:** any place that puts `color:#fff` on `var(--accent)` must use `var(--accent-ink)`, or dark mode shows white on yellow. Known places:
- `.db-cal-cell.today span`
- `.db-tl-bar`
- `.flowchart-node.terminal text`
- `.graph-node`, `.db-map-pin` strokes

**Also:**
- Pass the tokens into BlockNote: set `--bn-colors-*` on `.bn-container[data-color-scheme]`.
- Focus outline: `2px solid var(--accent)`.
- Corner radius: 6px on controls, 8px on cards.
- Print keeps plain light colours. Repeat the print token block at the end of `theme.css`.

**Signature detail:** state is shown as a **7px dot + word**. A live state is an accent dot with a 3px `--accent-soft` ring; an idle state is a muted dot. Use it on Home card headers and the current tab.

## 3. Sidebar (`App.tsx` ~lines 219–242, `.sb-*` in `styles.css`)

- **Header:** the 脳 mark becomes a 26×26 rounded (6px) square, `background: var(--accent)`, glyph `var(--accent-ink)`. "NOU" is 15px/600. Keep the collapse and new-page buttons.
- **Order:** the search box (`<SidebarSearchBox>`) moves **above** Home. The order becomes: search, Home, Graph, Files.
- **Remove the Quick capture row**, including its `<kbd>Ctrl+Shift+A</kbd>`. See §4.
- **Compact rows:** min-height 28px, padding 2px 10px, 13px text, gap 0, radius 5px, 16px icons. **No numbering.**
- **Active row:** `--active` background, `inset 2px 0 0 var(--accent)` bar on the left, 600 weight, and the icon in accent.
- **Section label** ("Private"): mono label style. Tree rows use the same compact row; indent 16px per level.
- **Bottom block:** Trash (count in mono), Import recovered note…, Backups & restore. The footer "Offline · Saved on this device" uses the mono label style.

## 4. Quick capture button

- Add a **floating round button**, bottom-right of `.workspace`.
- `position: absolute`, `right: 28px`, `bottom: 28px`; the workspace needs `position: relative`. If the workspace scrolls, use `position: sticky` or anchor it to the shell so it stays put.
- 52×52px, `border-radius: 50%`, `background: var(--accent)`.
- `box-shadow: 0 0 0 6px var(--accent-soft), 0 10px 28px rgba(0,0,0,.28)`.
- Lightning-bolt icon, 22px, stroke `var(--accent-ink)`. Path: `M13 2L4 14h7l-1 8 9-12h-7z`.
- `aria-label="Quick capture"` and `title="Quick capture"`. **Don't show the shortcut** anywhere; the Ctrl+Shift+A handler stays.
- Same `disabled={recoveryBlocked||busy}` and `onClick={()=>setShowCapture(true)}` as the old row.
- Hide it in focus mode and print.

## 5. Tab bar (`.workspace-topbar`, `.page-tabs`, `.page-tab`, App.tsx ~line 248)

- Wrap the tabs in a **track**: `padding: 3px`, `border-radius: 10px`, `background: var(--track)`, gap 2px, horizontal scroll.
- **Tab:** pill shape, height 28px, radius 7px, 13px text, min-width 96px, max-width 200px. No dividers between tabs.
- **Selected tab:** the "bubble", with `background: var(--raised)`, `box-shadow: 0 1px 2px rgba(0,0,0,.12), 0 0 0 1px var(--line)`, 600 weight and ink colour. A 6px **filled accent dot** with an accent-soft ring replaces the page icon.
- **Other tabs:** muted text, a hollow 6px dot (1.4px muted border), no background.
- **Close ×** only on the selected tab. Other tabs show it on hover or focus-within, so it stays reachable by keyboard.
- **New:** a 30×30 dashed-border **+** button after the track. `aria-label="Open a page in a new tab"`; it opens Quick find (`QuickFind.tsx`).
- **Window tools** (theme, fullscreen): replace the ☾ ☀ ⛶ glyphs with stroke SVG icons, 17px, coloured `var(--accent)` for theme and muted for fullscreen.

## 6. Page view

- **Toolbar** (`.toolbar`): the breadcrumb "Workspace / Inbox" is 14px, muted, with the current page in ink.
- **Action buttons** (`.actions`): lock, Focus, + Subpage, ↑, ↓, Trash, ⋯.
  - 34px high, 1px `--line` border, 6px radius, `--bg` background.
  - Trash text is `var(--danger)`.
- **Heading:** page icon about 40px, title 40px/700, then tags (`.page-tags`). Tag chips are pills with a `--panel` fill; "Add tags" is muted.
- **Editor:** body 16px/1.6. Links are in accent. Checkboxes use `accent-color: var(--accent)`. Linked to-dos keep their "On 2 pages" chip, styled as a mono pill on `--accent-soft`.
- **Backlinks** (`Backlinks.tsx`, `.backlinks`): about **1/3 the old height** and low-key.
  - One line with a 9px mono "LINKED FROM" label, then page names as 11px muted underlined text buttons.
  - No chip boxes, opacity .75, 8px top padding, thin top border.

## 7. Home (`Home.tsx`, `.home*`) — redesigned layout

The artboards "Home · light" and "Home · dark" are the spec. `reference/Main.dc.html` (next to this brief) is the exact markup, spacing and the sample logic. It is a Design Component file: read it for sizes, colours and animations, but **re-implement in React**; do not import it. Keep all existing widgets and their data sources; this is a re-layout and a restyle. Content width max 1120px, page padding 32px 48px, 16px gaps.

**Grid.** One shared 3-column grid for every row: `grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; align-items: stretch`.

**Order, top to bottom**

1. **Header:** 脳 in accent (26px), greeting (sentence case, 36px/700, by time of day), "Wednesday 18 November · N pages". Right side: a daylight arc SVG (sunrise, sunset, sun position, "LDN · nH nM OF LIGHT"), then **New page** (primary) and a gear icon button (Customize Home).
2. **Daily page strip** (slim, full width): date tile (accent, month abbreviation + day), "Daily page" label and today's long date, a 14-day writing streak of small squares (today ringed in accent) with "N-DAY STREAK", and **Open today's page**.
3. **Calendar + sidebar column.** Left column spans 2 grid columns and stacks **Calendar** then **Teaching of the day**. Right column (1 grid column) stacks **Clocks**, **Today's tasks**, **Weather**.
   - **Calendar:** month grid, cells 50px tall, activity shading (4 levels, accent at .07/.14/.24 alpha), today filled accent, dot under days with items, LESS to MORE legend, footer line "TODAY · Daily page · …".
   - **Teaching of the day:** one teaching (text, theme chip, "Book · n OF 5"), 5 pagination dots top right (active dot is a 16px pill). Source: the Teachings database (see `areas` docs if present); a placeholder array is in the reference.
   - **Clocks:** two flip clocks (London, Kuala Lumpur; zones configurable). Each clock is stacked vertically: flip tiles (HH:MM), then the city name (dotted underline, opens time zone picker) with a sun/moon icon, then the date on its own line, then a 24-hour day band with a position marker. **Seconds are shared**: two small flip tiles plus "SEC" in the card header, and a 2px progress line under the header. Tiles: `--tile` background, `--tile-ink` digits, centre split line, and a flip animation (`nouFlip`, 0.45s) when a digit changes. Digits flip only when the value changes; respect `prefers-reduced-motion`.
   - **Today's tasks:** fills the remaining height of the right column; the list scrolls inside the card (thin scrollbar, bottom fade mask). Rows have a checkbox, strike-through when done, and chips for time, linked page and "FROM XGROK/CLAUDE". Header shows a mini progress bar and "n/N". "Add a task" input pinned to the bottom. Source: today's daily-page to-dos and linked to-dos.
   - **Weather:** compact rows, one per city: icon, city plus sky condition on one line, low-to-high range bar with a "now" dot, current temperature. Refresh icon button in the header.
4. **Row of three:** **Year / quarter / month / day** (four concentric progress rings with legend and time left today), **Countdowns** (ring per countdown with days left), **Waiting for approval** (initial badge, pulse dot when live, Approve primary and Review outline).
5. **Row of three:** **Recently edited** (14-day activity bars plus a list with fading dots and relative times), **Favourites** (2×2 tiles), **Worth revisiting** (progress bar per note and a Later button).

**Cards:** `--panel` background, 1px `--line` border, 10px radius, 18px padding (compact cards 10px 16px). Card headings are 10px mono, uppercase, `letter-spacing: .14em`, `--muted`. Entry animation `nouRise`; all animations behind `prefers-reduced-motion: no-preference`.

**Quick capture** stays the floating bolt button (section 4); keep its keyboard shortcut.

## 8. Done when

- Both themes match the canvas on Home and a note page.
- Ctrl+Shift+L toggles the theme, and the setting persists (`nou-theme`).
- No remote font requests in DevTools; works offline.
- Dark mode never shows white text on yellow.
- Contrast is ≥ 4.5:1 for text, including 10–11px mono labels.
- `npm run typecheck` and `npm test` pass. The uncommitted quick-capture work is untouched.
- Open a PR into `main` with before/after screenshots (light and dark) of Home and a note page.
