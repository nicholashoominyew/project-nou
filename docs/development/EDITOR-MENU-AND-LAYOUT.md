# The ⠿ menu, page links, columns, compact files and sidebar search

## The ⠿ menu (the six dots beside a block)
Modelled on Notion's. Top to bottom:
- **Search actions…** filters every action as you type (Enter runs the first match). Typing "h2", "todo", "red" or "move" finds things.
- **Turn into** (text-like blocks only): Text, Heading 1–3, Bulleted list, Numbered list, To-do list, Quote, Code.
- **Color** (BlockNote's own colour picker).
- On a **page link**: **Show as a line / Show as a box**, and for a box **Box border colour** and **Box fill colour** (default, gray, brown, red, orange, yellow, green, blue, purple, pink). The fill is a light tint, so it reads well in light and dark mode.
- **Duplicate** (Ctrl+D), **Move to…** (a searchable list of your other pages), table header options, **Delete**.
- **Move to…** copies the whole block (type, settings, nested blocks) to the end of the other page through the normal save, and removes it here only after that save succeeded. If the other page is locked or the save fails, nothing is removed and the error is shown.
- Not included: **Copy link to block**. A link to a block needs a way to open it, and notes cannot hold a custom link type, so it would copy something that does nothing. It needs its own design.

## Page links
A line (icon and name, no border) or a bordered box, chosen per link from the ⠿ menu. New links are lines; links from before keep the box look. The small / medium / big buttons are gone.

## Columns
`/` then **2 columns** or **3 columns** (up to five with **+ Add column**). The child blocks of a columns block are the columns, so each column can hold anything and you add to it by dragging a block in or pressing Tab. They stack on narrow windows. The layout is done by the stylesheet (it relies on how BlockNote nests blocks; the tests check that structure). This is NOU's own block, not BlockNote's multi-column add-on, which is not under a licence suitable for this project.

## Compact attachments
A PDF is one slim row: icon, name, **Preview**, **Save a copy** (the buttons appear on hover). Other files are one row too. Images have no frame or padding; the 25 / 50 / 75 / 100 / Auto size buttons still appear on hover.

## `/[]` linked to-do
Typing `/[]` (or `/[ ]`) offers **Linked to-do**.

## Flowchart canvas
While editing, the chart sits on a fixed 440px dotted canvas: drag the background to pan, two-finger scroll pans, pinch or Ctrl+wheel zooms, and **+ / − / Fit** buttons. Dragging a step freezes the view so the picture does not rescale under you. When the note is read-only the whole chart is always fitted and cannot be panned or zoomed.

## Sidebar search
A box at the top of the sidebar searches **page titles** (instant), **lines inside notes** (an excerpt with the matched words highlighted, from the local search index, `search_lines`) and **file names** (each with the pages that use it). Esc clears it. Locked notes never appear (their text is not indexed). Ctrl+Q still opens the page switcher.

## Arranging pages
Pages can already be dragged in the sidebar (drop above, below or inside another page, or on "Drop here to move to the top level"), and the page toolbar has ↑ ↓. The sidebar ⋯ menu now also has **Move up** and **Move down**.

## Verified
- Rust: 4 tests for the line search (marked excerpt, title-only matches ignored, trash/database/row/locked/empty excluded, odd input, limit).
- Vitest: menu helpers and a real-editor test that moves a nested custom block to another page; page link styles in a real editor; the columns structure and CSS rules in a real editor; the flowchart camera and canvas (pan, pinch, buttons, Fit, locked when reading); the sidebar search (titles, lines, files, plain-text safety, errors, one file-list request).
- **Not verified in the real window:** the ⠿ menu itself (search box focus inside the menu, submenus, Move to), the look of columns, compact files and the page boxes, and trackpad behaviour on the flowchart canvas. The menu depends on BlockNote's menu components, which the test environment cannot open.
