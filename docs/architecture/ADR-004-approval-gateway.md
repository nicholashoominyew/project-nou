# ADR-004: Approval gateway (Phase 3 foundation)

Status: core, local API and approval UI implemented on branch `feature/approval-gateway` (see `docs/development/GATEWAY.md` for what is built and verified); MCP transport and the remaining appliers are not built. Nothing here is merged.

## Context
The plan requires that **every AI- or bot-requested write is explicitly approved by the human**, with an audit log and revocable tokens, and that scheduled jobs and bots cannot write without it. The same gateway must later serve Claude, ChatGPT, Grok and a self-hosted AI, so it cannot be tied to one provider. Today NOU is a single-process desktop app with one SQLite Notes database; the Bot Queue, daily page and housekeeping scripts live in Notion and need an equivalent write path.

## Decisions
1. **One write path.** A client never writes notes directly. It sends a *proposal* (`op` + `payload` + human-readable `summary`). A human approves or rejects it in the app. On approval the **app itself** applies the change through the same code that handles the user's own edits (editor, validation, backups, undo guard). The gateway never builds Yjs documents itself and never writes note content from a background thread.
2. **Reads need a scope; writes always need approval.** A token has scopes (`notes:read`, `databases:read`, `notes:write`, `databases:write`). Having a write scope only allows *proposing*; it never allows applying.
3. **Tokens.** Random 244-bit secrets shown once, stored only as SHA-256 hashes, named, scoped, revocable, with last-used time. A revoked token is refused immediately and its pending proposals are cancelled.
4. **Append-only audit log.** Every token created/revoked/used-to-propose, and every decision and application, is logged. Database triggers refuse UPDATE and DELETE on the log.
5. **Proposals are inert data.** The `op` is one of a fixed allow-list; payloads are size-limited and validated again when applied. The approval screen shows the exact change, never a model-written description alone (the `summary` is shown but labelled as the client's claim).
6. **Duplicate protection.** An identical pending proposal from the same token returns the existing one instead of creating another (the "AI posted the same checklist item twice" problem). Similar-item checks are added per feature.
7. **Expiry.** Pending proposals expire after 7 days; expired proposals cannot be approved.
8. **Built so far:** storage, token and proposal rules, audit log, a loopback-only opt-in HTTP API, the approval widget and token screen, and appliers for `create_page`, `rename_page`, `set_value`, `create_row`, `append_text` and `add_checklist_item` (note-body edits go through a headless editor bound to the note's Yjs state and the normal save command). An MCP transport is a separate step.

## Threat model (summary)
- **Prompt injection:** content read through the gateway may contain instructions aimed at the model. Defences: reads are data only; no tool can write without a human decision; the approval screen shows the real operation and target; payload limits; op allow-list.
- **Stolen token:** limited by scopes, instant revocation, no write without approval, audit trail. Tokens never appear in logs or the UI after creation.
- **Local malware / another local user:** out of scope for the gateway itself; the listener (later step) binds to loopback only and requires a token.
- **Replay / approval confusion:** each proposal has a unique id and a single decision; a decided proposal cannot be decided again.
- **Audit tampering:** triggers block edits; the log is inside the Notes database and therefore inside backups (an attacker with file access can still replace the whole file, which is outside this threat model).

## Consequences
Schema 6 (`db/notes/006_gateway.sql`), another one-way schema step. Providers that cannot work with a human-approval loop (fully autonomous agents) are intentionally unsupported.

## Not built yet
MCP transport, linked (multi-page) checklist items, per-provider setup, per-token rate limits, and a self-hosted-AI runner.
