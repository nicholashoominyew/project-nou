# Auto-approval

Rules let low-risk bot changes apply without a tap. Everything else waits for you, as before. **Off until you turn it on, and nothing is automatic until you add a rule.** Schema 18 (`db/notes/018_auto_approve.sql`).

## Using it

**Settings → Auto-approval** (or **Set up / Rules and history** on Home). Turn it on, then **Add a rule**:

- **Name.**
- **Where**: a page (optionally with everything under it) or any page.
- **What may happen by itself**: create a page, add text, add a checklist item, add a database row, change a database cell, rename a page.
- **Which bot**: a token's name, or any bot. This includes a remote one using the MCP gateway.
- **Limit**: changes an hour for that rule (default 100). Over it, requests wait for you.

**Pause all auto-approval** is on Home and on that screen. Pausing (or turning the feature off) sends every approved-but-not-yet-applied change back to the waiting list at once. A change already being written finishes.

**Recently auto-approved** shows time, bot, rule, what changed and the bot's own (unverified) description, with **Undo**. Pages a rule changed carry an **AUTO** badge until you open them; Home shows the count.

**Waiting list**: **Approve all** and **Reject all** (each asks first). Requests from the same bot, of the same kind, under the same page and with the same description (titles in quotes ignored) appear as one group; **Show each one** lists them.

## Never automatic, whatever the rules say

- Anything but the six operations above (timetable, habits, tasks, Home sections, embeds, attached HTML).
- Deleting or moving anything (bots have no such request at all).
- Locked, trashed or system pages; adding text to an old plain-text note.
- **Overwriting.** A cell is filled only when it is empty. A page is renamed only if that same bot created it and its title and text are as the bot left them.
- Relation cells (they also write to other rows).

## How it works

1. `gateway::propose` stores the request as pending, then `auto::on_proposed` checks the switches and rules against the page's **stored** position. Nothing the bot says about the tree is read. A match marks it `approved` and records it in `auto_log`.
2. The API answers `status: "approved", auto: true`; `GET /v1/proposals/{id}` carries `auto`. The MCP bridge says so in words. Tool names and parameters are unchanged.
3. The app window is told at once (and also looks every 5 seconds). `auto_claim` checks the switches, rule, token and page **again**; if anything no longer holds, the request goes back to pending. Then the same code as a manual approval applies it, and the status becomes `applied` or `failed`.
4. An identical request while one waits to be applied returns the same id, so it is not applied twice. If NOU closes mid-apply, the change is marked `failed` ("check the page") and never rerun.

NOU must be open for anything to be applied. Rules and switches are changed only by Tauri commands from the app's own screens; the local API and MCP have no route to them. Rule changes, automatic approvals, withdrawals, pauses and undos are in the append-only audit log.

## Undo

NOU keeps every save of a note but cannot restore one, so undo reverses the specific change, and refuses if it has been touched since:

| Change | Undo |
| --- | --- |
| New page or row | Moved to Trash, only if still empty with no subpages |
| Added text or to-do | Exactly those blocks removed, only if unedited |
| Filled cell | Cleared, only if it still holds that value |
| Rename | Old title back, only if the title is still the bot's |

If a bot created a page and then added text to it, undo the text first, then the page.

## Upgrading and sync

Schema 18 is one-way. NOU takes a rollback copy before upgrading. **Install the same build on every device before syncing between them**: an older NOU refuses a version 18 database. Rules and switches are part of the database, so a restore or sync brings theirs with it: check the switches afterwards.

## Verified, and not

**Tests:** `auto_tests.rs` (rule matching by the real tree, source, action, enabled, the never-automatic cases, hourly limit, pause, recheck at apply time, token revocation, no repeat, interrupted apply, undo conditions, no API route to settings, the `auto` flag); `autoApprove.test.tsx` (apply loop, undo including the real editor, grouping, bulk approval, rules screen, pause); one bridge test.

**Run once in the real window** (25 November 2026, test build, new throwaway profile, real local API): manual approval; adding a rule; covered append and page creation applied without a tap; a request outside the rule stayed pending; undo of added text; pause; a group of three approved at once.

**Not verified:** the installed build; your real notes' upgrade; database cell and row rules in the window; a real bot or the bot runner; light mode of the new screens; bulk volumes (the local API accepts 120 requests a minute from all bots together, and a token may have at most 50 requests waiting).
