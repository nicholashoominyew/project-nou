# Split view

Show a second page beside the one you have open, so you can read one while you write in the other.

## Using it
- Open a page, then right-click (or use the ⋯ menu of) any other page in the sidebar and choose **Open in split view**. The second page appears on the right with its own editor.
- The split header has **Swap** (exchange the two pages), **Open alone** (make it the main page and close the split) and **Close**.
- Both pages are fully editable. The page title, tags and "Linked from" list stay with the main page only; rename the split page by swapping it to the main side.
- Opening the split page normally from the sidebar closes the split rather than showing the same page twice. The split is remembered when you restart NOU, and it closes by itself if that page is deleted or trashed.
- Not offered from Home (open a page first), and not offered for the page that is already open.

## Safety
- Each editor has its own save status. Switching pages, swapping, and closing are blocked while **either** pane has a save pending, the same rule the single editor already follows, so nothing can be cut off mid-save.
- Undo and redo go to the pane you were last typing in (the existing editor-ownership rule, one entry per editor).
- Printing prints only the main page.

## How it works
`App.tsx` keeps `splitId` and the split pane's save status next to the main ones, and renders a second `NoteEditor` (with a `secondary` prop that skips the page-options portal, which belongs to the main toolbar). The layout is a plain two-column flex row; when no split is open the wrapper uses `display: contents`, so the single-page layout is unchanged.

## Verified
- Vitest (App): opening a split, no entry from Home or for the open page, Swap, Close, Open alone, opening the split page from the sidebar, a pending save blocking switching and closing, persistence across restarts and ignoring a stale or duplicate id.
- Not verified: how it looks and scrolls in the real window, two editors open at once in the real editor (the tests replace the editor with a stand-in), and Ctrl+Z focus between two real editors.

## Not built
A draggable divider (the panes are 50/50), a keyboard shortcut, more than two panes, and dragging a tab into the split.
