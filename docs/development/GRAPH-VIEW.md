# Graph view

A map of the workspace, opened from **Graph** in the sidebar (under Search).

- Each dot is a page. **A main page (top level) is a solid dot; every subpage is a ring** (an outline with no fill), and the deeper a page sits the smaller its dot. A key above the graph shows both. A dot grows slightly when the pointer is over it or it has keyboard focus. The graph follows the app's light and dark theme; there is no decorative background. A solid line is a link written in a note (an `@` page mention); a faint dashed line means "this page sits under that one". Click a dot, or focus it and press Enter, to open the page.
- It is only a view. The lines come from the same `page_links` index that powers "Linked from", which is rebuilt from the note bodies, so nothing is stored by the graph itself.
- Data: the `list_link_edges` command returns links where both ends can be opened from the sidebar. Trashed pages, databases and database rows are left out, the same rule as backlinks. Capped at 20,000 links.
- Layout: `graphLayout.ts` is a small force-directed layout that is deterministic, so the same pages always land in the same places. It lays out at most 400 pages; above that the screen asks you to narrow it with the two toggles instead of freezing the app.
- Controls: show or hide the hierarchy lines, show or hide pages with no lines, zoom buttons and the mouse wheel, drag the background to pan, Reset. Hovering or focusing a page highlights it and its neighbours.
- While a save is pending the dots do nothing, the same guard the sidebar uses.

## What is verified
- Rust: `graph_edges_skip_trashed_pages_and_database_rows` (cargo test, links module).
- Vitest: layout (determinism, stays in frame, linked pages closer, caps), the screen (counts, click and Enter open a page, save guard, toggles, unknown links ignored, empty and error states, too-many message, zoom and reset) and the sidebar wiring in the app.
- Not verified: how it looks and feels in the real window (spacing, label overlap on a busy workspace, wheel-zoom and drag-pan with a real mouse).

## Not built
Search or filter inside the graph, colouring by tag, a "local graph" of just the open page's neighbours, and drag-to-rearrange.
