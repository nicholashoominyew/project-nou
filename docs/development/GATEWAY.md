# Approval gateway and local API (branch `feature/approval-gateway`)

Roadmap: Phase 3 (`ROADMAP-PROPOSAL-2026-11-11.md`, draft). Design and threat model: `docs/architecture/ADR-004-approval-gateway.md`. Stacked on `feature/home-page`. Nothing here is merged.

## What exists
- **Schema 6** (`db/notes/006_gateway.sql`): `api_tokens` (SHA-256 hashes only), `proposals`, `audit_log` with triggers that refuse UPDATE and DELETE.
- **Core** (`gateway.rs`): create/list/revoke/verify tokens (scopes `notes:read`, `databases:read`, `notes:write`, `databases:write`); `propose` (scope and operation checks, payload and summary limits, duplicate protection, 50-pending cap); decide once; apply only after approval; 7-day expiry; every step audited.
- **Local API** (`gateway_http.rs`, new dependency `tiny_http`): loopback `127.0.0.1` only, **off until the owner turns it on** in *AI access*, default port 47651 (`NOU_API_PORT` overrides). The on/off choice is stored in `gateway.json` in the profile folder, not in the database.
  - Always refused: any request with an `Origin` header (browsers), a `Host` other than `127.0.0.1:<port>` / `localhost:<port>` (DNS rebinding), bodies over 70 KB, more than 120 requests a minute, missing or revoked tokens.
  - `GET /v1/status`, `GET /v1/search?q=`, `GET /v1/pages/{id}` (needs `notes:read`), `GET /v1/databases/{id}` (needs `databases:read`), `POST /v1/proposals` and `GET /v1/proposals/{id}` (a client sees only its own). Read responses carry `content_is_untrusted_data: true`.
  - There is **no endpoint that changes a note**. `POST /v1/proposals` only queues a request.
- **Approvals on Home** (`Approvals.tsx`, widget "Waiting for your approval"): shows the exact operation and fields; the client's own description is shown separately and labelled *not verified*; all text is rendered as plain text. Approving records the decision, then the **app applies the change through its normal commands** (`gatewayApply.ts`) and records the result. Operations the app cannot apply yet can only be rejected.
- **AI access screen** (`GatewayPanel.tsx`, Home → *AI access*): create tokens (secret shown once), revoke (confirmation; cancels the token's waiting requests), local API switch, recent activity.

## Applying changes
Supported: `create_page`, `rename_page`, `set_value`, `create_row`, `append_text`, `add_checklist_item`. Payloads are re-validated in the app before anything runs.

**Note-body edits** (`noteAppend.ts`): the app loads the note's Yjs state, binds a headless BlockNote editor to it with the same collaboration setup the visible editor uses, inserts the blocks, and saves the resulting state through the normal `save_note` command (so validation, search indexing, the restore barrier and backups apply). New blocks go before the editor's trailing empty line.
- `append_text`: each non-empty line becomes a plain paragraph (max 200 lines, 2,000 characters a line, 20,000 in all). Control characters are dropped and nothing is read as markup.
- `add_checklist_item`: one to-do of one line (max 500 characters), optionally ticked. A to-do whose text (case and spacing ignored) already exists as a to-do on the page is not added again, and the approval is recorded as applied with "already on the page".
- Old plain-text notes (`text-v1`) are refused until converted to rich text.
- If the page is open it reloads itself (`nou:note-changed`), but only when it has no unsaved text.

## Verified (run this session on the development PC)
TypeScript clean; Vitest tests including end-to-end note edits with the real BlockNote editor (saved update decoded and checked); 61 Rust library tests (token hashing, scopes, duplicate protection, decide-once, revocation, expiry, append-only audit, request handling including browser/host refusal, and a real-socket round trip that also stops the listener). Schema 1→6 upgrade ran in the real app binary on a disposable profile (integrity `ok`). **Not** verified: the Home approvals widget, token screen or live API in the real window; use with any actual AI tool; behaviour under Windows firewall prompts.

## Limitations and next steps
- The headless editor used for note-body edits is tested in jsdom but has not run in the real WebView2 window yet.
- Reading a page returns its searchable plain text, not formatting, tables or attachments.
- No per-token rate limits (one global limit); no IP allow-list beyond loopback.
- Tokens cannot be edited, only revoked and recreated.
- The local web clipper and scheduled-job runner (Phase 3/3b) are not built.

## Using it (example, from the same computer)
```powershell
$h = @{ Authorization = "Bearer nou_YOURTOKEN" }
Invoke-RestMethod http://127.0.0.1:47651/v1/search?q=plan -Headers $h
Invoke-RestMethod http://127.0.0.1:47651/v1/proposals -Method Post -Headers $h -ContentType application/json `
  -Body '{"op":"create_page","payload":{"title":"From a script"},"summary":"Create a page"}'
```
Then open Home in NOU and approve or reject it.

## MCP bridge (`tools/nou-mcp/nou-mcp.mjs`)
A single dependency-free Node file (Node 18+) that speaks MCP over stdio and forwards to the local API, so MCP clients such as Claude Desktop or Claude Code can use NOU.
- It has no powers of its own. Tools: `nou_search`, `nou_read_page`, `nou_read_database`, `nou_proposal_status`, and `nou_propose_*` for `create_page`, `rename_page`, `append_text`, `add_checklist_item`, `set_value`, `create_row`. There is no approve or apply tool: every proposal waits for the person in NOU.
- Settings: `NOU_TOKEN` (create it under AI access; only the scopes you tick are usable) and optionally `NOU_API_URL` (default `http://127.0.0.1:47651`). It refuses any address that is not `http://` on this computer, so the token cannot be sent elsewhere, and it never prints the token.
- Anything read from notes is returned with a note that it is untrusted data.
- Setup (example for a client's MCP config): `{"mcpServers":{"nou":{"command":"node","args":["C:\path\to\project-nou\tools\nou-mcp\nou-mcp.mjs"],"env":{"NOU_TOKEN":"nou_..."}}}}`. NOU must be open with the local API switched on.
- Verified: 13 Node tests (`npm run test:mcp`) cover the handshake, tool list, request mapping, error handling, token never leaking, id encoding and a real stdio round trip against a fake API. Not yet verified: a real MCP client (Claude Desktop or Claude Code) driving it end to end.

A remote client can use the same tools over Streamable HTTP through the separate [MCP gateway](MCP-GATEWAY.md).

## Bots Hub
Six more scopes give a token access to the Bots Hub: `chat:read` and `chat:write` (rooms, messages, hand-offs, approval cards: `GET` and `POST /v1/chat`, `GET /v1/rooms`), `queue:read` and `queue:write` (the bot queue: `/v1/queue`), and `inhouse:read` and `inhouse:write` (the private chat with the local model, for its runner only). The MCP tools are `nou_chat_read`, `nou_chat_post`, `nou_rooms`, `nou_queue_read`, `nou_queue_item`, `nou_queue_add` and `nou_queue_update`. See [BOTS-HUB.md](BOTS-HUB.md). See `BOT-QUEUE.md`. Messages are plain text, signed with the token's name, rate-limited, and never change notes.

## Bot runner (starts bots when they are tagged)

While NOU is open, a built-in runner can start a bot when it is tagged in the Bots Hub. Switch it on under **AI access, Bot runners, Start bots when tagged**. It is off by default and runs only when **both** its own switch and the **Local API** are on; switching either off stops it.

**What it needs.** The Local API on; Node.js 18 or newer on the PATH; and, for Claude, the Claude Code CLI (`claude`) installed and signed in on this computer. The card shows one word: RUNNING, STOPPED, NEEDS THE LOCAL API, NODE MISSING or CLAUDE CLI MISSING (the runner still runs without the CLI, so the relay bots work, but a tag of @Claude will fail).

**The bots.**
- **Claude** (type `claude`): starts Claude Code (`claude -p`) limited to the NOU MCP tools (`--strict-mcp-config`, `--allowedTools mcp__nou`). It may reply and propose; it cannot approve.
- **xGrok** and **GrokBots** (type `relay`): they exist only as a web chat or a separate app, so nothing can start them. When one is tagged, the runner posts an **approval card** (`POST /v1/chat {type:"approval"}`) whose text is "Ready to paste into <Name>" followed by the tagging message with its `@Name` removed (so the card cannot tag it again; at most 4,000 characters, shortened with a marker if longer) and a queue title `Paste into <Name>: …` (at most 160 characters). Approving the card means "pasted". Both relays use one shared token, "NOU relay" (chat and queue scopes only: it cannot read or propose notes). Both accept hand-offs from Claude (`allowFrom: ["Claude"]`).

**Loop protection** (unchanged): a bot reacts only to tags written by the owner, unless its `allowFrom` names another bot; such bot-triggered runs are capped (default 3 per 10 minutes). A failed run is never retried.

**How it runs.** The two programs are built into the app and written to `<profile>/runner/` (with a generated `nou-bots.json`, no secrets in any of it). NOU starts `node nou-claude.mjs` hidden, with its own stdin held open: the runner exits when that pipe closes, so it stops when NOU closes or crashes, after killing any bot process it started. Output goes to `<profile>/runner/runner.log` (about 1 MB, the tail is kept; the card shows the end of it). Settings are in `<profile>/runner.json` (`enabled`, and the ids of the tokens it made). Each start begins after the newest message in the room, so tags written while the runner was off are not replayed.

**Tokens.** At each start NOU makes two tokens in memory, "Claude" (notes, databases, chat, queue, timetable and Home scopes) and "NOU relay", and gives the secrets to the runner only through its environment. They appear in the token list like any other token and can be revoked there. Revoking a token cancels its pending proposals, so an earlier runner token is revoked only when it has no pending or approved proposal; otherwise it stays valid until a later start or stop finds it idle. Audit entries: `runner.enabled`, `runner.disabled`, `runner.started`, `runner.stopped` (token ids only, never a secret). While a restore waits for review, nothing starts.

**Verified.** Rust tests (settings, the generated bots file read by the real runner, token scopes, the idle-revoke rule across several starts, no secret in files, listings, the audit log or the runner's log, a real child process stopping when its pipe closes, and the whole chain from a tag to an approval card through the real local API handler). Node tests for the relay and external types and the parent-pipe exit (a real child process). Vitest for the card. **Not verified:** the real WebView2 window, the real `claude` CLI, a real @Claude tag end to end, and Windows process handling (the hidden window, `taskkill`, running `claude` through `cmd`). Manual check (do this on Windows with NOU installed):

1. Turn on the Local API, then **Start bots when tagged**. The card says RUNNING. (If it says NODE MISSING or CLAUDE CLI MISSING, fix that first.)
2. In the Bots Hub, General room, post `@Claude hello`. After a few seconds a reply from Claude appears. Anything it wants changed shows up as a proposal waiting for you; nothing changes until you approve it.
3. Post `@xGrok test message`. A "Ready to paste into xGrok" card appears, without the @xGrok in its text, and a matching item in the queue. Approve it: it is marked pasted.
4. Close NOU. In Task Manager, check that no `node.exe` started by NOU (and no `claude`) is left.
5. Reopen NOU. The card says RUNNING again, and none of the earlier tags is answered a second time.

## Life Timetable and Home page requests

Three more things an assistant can **ask** for, with the same rules as every other request (it only proposes; you read exactly what would change and decide on the Home page):

| Operation | Scope | What approving does |
| --- | --- | --- |
| `timetable_set_block` `{weeks:["A"\|"B"], days:["Mon"…], start:"HH:MM", end:"HH:MM", activities:[names]}` | `timetable:write` | Puts those activities (they split the time) into that stretch on those days in those weeks, replacing what is there. No activities empties the stretch. Times are half-hour steps (`end` may be `24:00`). |
| `timetable_add_activity` `{name, category}` | `timetable:write` | Adds an activity to the list (not placed on any day). A later request can then use its name. |
| `home_set_widgets` `{show?:[ids], hide?:[ids]}` | `home:write` | Shows or hides sections of the Home page. Only visibility changes (the layout is fixed). The **Waiting for approval** section can be shown but a request can never hide it. |

- **Reading.** `GET /v1/timetable` (scope `timetable:read`) returns the activities (name and category, no ids) and, for each week and day, the blocks with start, end and activity names; empty stretches are left out. It is labelled as untrusted data like every other read. MCP tools: `nou_timetable_read`, `nou_propose_timetable_set_block`, `nou_propose_timetable_add_activity`, `nou_propose_home_widgets`.
- **Checked twice.** The bridge and the API only pass the request on; the app re-checks every field when you approve (days, weeks, times, names, section ids) and refuses a badly shaped request without writing anything. An unknown activity name is refused (ask for it to be added first). A timetable change goes through the timetable's own save command, so it is the same write a click would make, and Home sections change only the stored show/hide choice and update an open Home page at once.
- **Approval card.** Each of these shows a plain sentence first ("In week A, on Mon, 09:00–10:30 will be set to Work, replacing what is there now."), then the exact fields, then the assistant's own description marked *not verified*.
- **Not reachable.** An assistant still cannot rename, move or delete the Life Timetable page, edit a block without a request you approve, change the A/B swap, delete or recolour activities, move or resize Home sections, or change any other setting.
- **Schema 15** (`db/notes/015_proposal_ops.sql`) rebuilds the `proposals` table with the longer list of operations (every existing request is copied unchanged). The runner's "Claude" token gets the three new scopes; "NOU relay" does not.
