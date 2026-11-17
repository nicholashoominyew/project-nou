# Linked to-dos

One to-do that can sit on several pages and stays in step everywhere. Tick it on one page and it is ticked on all of them; edit its text and every copy changes.

## Using it
- Type `/` and choose **Linked to-do** to make a new one.
- To show an existing one on another page, type `/linked` (or `/shared`): the to-dos that already exist are listed under "Existing linked to-dos".
- The small link badge on the right shows how many pages carry it. Click it to see them and jump to one.
- Edit the text in place; it saves when you click away or press Enter.

## How it works
- **Schema 7** (`db/notes/007_linked_todos.sql`, a one-way step with the usual rollback snapshot): `linked_todos` holds the shared text and ticked state. `linked_todo_refs` records which pages show which to-do; it is derived data, rebuilt on every save like `page_links`.
- The note only stores the to-do id plus a copy of the text (so search finds it). The copy is refreshed whenever you change the to-do on that page. A copy on a page you have not opened since may be out of date until you open it; what you see on screen always comes from the shared state.
- Commands (`todos.rs`): `linked_todo_create`, `linked_todo_get`, `linked_todo_set`, `linked_todo_list`, `linked_todo_pages`, `set_page_todo_links`. Text is limited to 500 characters; ids are validated; saving is refused while the notes are read-only or being restored.
- Open copies on screen update through a `nou:linked-todo` event. Pages in other tabs read the shared state when you switch to them.
- A to-do whose record is missing (for example after restoring an old backup) keeps its saved text, shown as "Unavailable", and cannot be ticked.
- Trashed pages are not counted or listed. Deleting every copy leaves the to-do record behind so it can be linked again from `/linked`.

## Verified
- Rust: 5 tests (shared state, refs, bad input, picker wildcards, page deletion), and the backup and restore tests now run on schema 7.
- Vitest: 11 tests for the block (shared state wins over the copy, ticking, sync between copies, text edits, read-only, missing record, page list, failed save) and the plumbing (index extraction, search text, slash-menu gating).
- Not yet verified: how it looks and behaves in the real window, and the slash menu in the real editor.

## Not built
Due dates, assignees, a "all my linked to-dos" overview page, deleting an unused to-do record, and showing linked to-dos in markdown/HTML exports.
