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
