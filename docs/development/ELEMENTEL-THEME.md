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

## Later changes
- **Settings page.** Backups & restore, Import recovered note and Trash left the sidebar. **Settings** (sidebar, bottom) lists them as cards, with AI access. The Trash screen has a link back to Settings.
- **Removed from the page.** The "Linked from" panel is gone entirely (the component and its styles are deleted; the backend `list_backlinks` command stays but nothing calls it). **+ Subpage** and the up and down arrows are gone from the page toolbar: arrange pages by dragging in the sidebar (or Move up and Move down in a row's menu) and add subpages with `/` then **Page** inside a note.
- **Motion.** Short, quiet animations in `theme.css`: pages and screens fade in and rise 8px, Home cards arrive one after another, pop-ups and menus scale in, new tabs pop in, buttons give under the finger, the graph fades in. Each is under half a second, only opacity and transform are animated, and all of it is off for reduced motion.

## Permanent pages, Home layout, tags and icons
- **Permanent pages** have fixed places in the sidebar and cannot be moved or deleted: **Home**, **Graph**, **Inbox**, **Bots Hub** and **Files** (in that order). The Inbox is a normal note (Quick capture writes to it, and it is made the first time it is opened); it is left out of the page tree and has no Trash button. Every other page is editable: rename, move, favourite, subpages, trash.
- **Bots Hub** replaces "Bot queue": a collaboration room, an in-house chat and a bot queue on one page (see `BOTS-HUB.md`; the old Chat and Queue tabs are gone, and the full approvals view is behind **Open full queue**) and a **Queue** tab with the requests assistants have asked you to approve. The badge counts unread assistant messages.
- **Home layout:** the Daily page across the top (one page per day, named for the date, made on first use), then Waiting for approval, Recently edited and Favorites side by side. Worth revisiting sits below, full width (hide it from the gear). The gear (top right) opens the customize panel: move or hide sections, and **AI access** lives there. Saved layouts from before keep their old order for sections they already knew.
- **Tags are gone** from the page, Home and Quick find. Existing tags stay in the database untouched, nothing reads them.
- **Buttons** all follow the theme: a zero-specificity base rule in `theme.css` themes any button without its own look.
- **Icons:** `iconPaths.ts` holds one stroke icon set (about 70). Pages can wear 24 of them (the Rust list in `workspace_commands.rs` matches). The slash menu (Page, Database, columns, Flowchart, Linked to-do, Bookmark, Image, PDF, File, page mentions) and the ⠿ menu rows have icons.
- **Reloading:** refreshes now keep the old data when nothing changed, so polling no longer redraws Home or the sidebar. Icon data moved out of `Icons.tsx` so the dev server can hot-update instead of reloading the whole page. In dev, the page also reloaded whenever Rust rebuilt; ignoring `src-tauri` in `vite.config.ts` stops that (your uncommitted edit there does this).
