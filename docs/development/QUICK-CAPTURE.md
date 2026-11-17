# Quick capture

Jot something down without leaving the page you are on.

## Using it
- Press **Ctrl+Shift+A** (or click **Quick capture** in the sidebar). Type, then press **Enter** to save. **Shift+Enter** starts a new line, **Esc** closes.
- What you type goes to the end of a page called **Inbox**. The first time, NOU creates it at the top level; after that it reuses it. If you rename or move it, NOU remembers it by id, and if it is gone it looks for a top-level page called Inbox before making a new one.
- Each non-empty line becomes a paragraph. Typing `- ` (a dash and a space) at the start of a line turns it into a bullet point (`•`) as you type, and it is saved as a real bullet list item. **Shift+Enter** in a bullet starts the next bullet; on an empty bullet it ends the list. A dash without a space (`-5 degrees`), a lone dash or a dash inside a line stays ordinary text. `*` and `•` at the start of a line also make bullets.
- Start a line with `[]`, `[ ]` or `- [ ]` to make it a to-do, or `[x]` for a ticked one (to-dos win over bullets). Nothing is read as markup.
- After saving, the box clears so you can capture again, and **Open Inbox** takes you there. If the Inbox is open, it refreshes by itself when it has no unsaved text.
- Limits: 50 lines, 2,000 characters a line, 20,000 in all. A to-do that is already on the Inbox page is not added twice.
- It is blocked while a restore needs review or a restore is running, like other writes.

## How it works
It reuses the note-editing path built for the AI gateway (`noteAppend.ts`: a hidden editor bound to the note's saved state, saved through the normal `save_note` command), so validation, search indexing and backups all apply. `captureParse.ts` holds the parsing and Inbox lookup; `QuickCapture.tsx` is the small dialog.

## Verified
- Vitest: parsing (lines, to-dos, markup, limits), Inbox lookup (remembered page, top-level only, case and spacing), the dialog (Enter saves, Shift+Enter, empty, failure keeps your text, limit error, Esc, locked while restoring) and the app (shortcut, first-use Inbox creation, existing Inbox, sidebar button).
- Not verified: the whole flow in the real window.

## Not built
A system-wide shortcut that works while NOU is in the background or minimised. That needs a global-shortcut plugin (a new dependency and an OS-level hotkey), so it is a separate decision. A choice of destination page, and capturing from the clipboard or a screenshot, are also not built.
