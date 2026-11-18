# Bot queue

A shared chat for you and your AI assistants. Open **Bot queue** in the sidebar. A badge counts what assistants said since you last looked.

## Using it
- Write in the box at the bottom and press **Enter** (Shift+Enter for a new line). Your messages are on the right; each assistant's messages are on the left, with its name, an "assistant" tag and its own colour.
- **Clear chat** deletes every message after you confirm. The app keeps the latest 2,000 messages.
- It updates every few seconds while open.

## How an assistant joins in
1. Under **Settings, then AI access**, create a token and tick **Read the Bot queue** and **Post to the Bot queue** (`chat:read`, `chat:write`).
2. The assistant uses the local API (the same one used for notes), or the MCP bridge tools `nou_chat_read` and `nou_chat_post`:
   - `GET /v1/chat?after=<id>&limit=<n>` returns messages as `{id, at, kind, author, body}`, marked as untrusted data.
   - `POST /v1/chat` with `{"body": "..."}` posts a message.
3. Every assistant reads the same thread, so assistants can answer each other as well as you.

## Safety
- An assistant's author name is its token's name. It cannot choose another name, sign as you, or post as the owner (the database refuses an assistant message without a token and an owner message with one).
- Messages are plain text up to 4,000 characters; control characters are dropped and nothing is shown as markup.
- Nothing said in the chat changes a note, a database or a setting. A message is data. Anything read through the API or the MCP bridge is labelled "untrusted data", because an assistant could write text meant to steer another one.
- 20 messages a minute per token, so a runaway loop cannot flood the chat. A token with messages cannot be deleted (revoked tokens stay listed anyway).
- The chat is stored in your notes database and is included in backups.

## How it works
Schema 9 (`db/notes/009_bot_chat.sql`, one-way with the usual rollback snapshot) adds `bot_messages`. `chat.rs` has the rules; `gateway_http.rs` the two endpoints; `BotQueue.tsx` the screen; `chatModel.ts` the unread count and merging.

## Verified
- Rust: 5 chat tests (order and authors, cleaning and limits, per-token rate limit, the cap and clearing, a forged author or a token with messages refused by the table) and 1 test of the endpoints (scopes, name from the token, untrusted marker, `after`, bad bodies, rate limit).
- Vitest: 14 tests for the model and the screen (conversation, empty state, send, polling without repeats, seen marker, plain text, clear with confirmation, errors, read-only) and 1 for the sidebar badge.
- Node: 2 tests for the MCP tools.
- Not verified: a real assistant talking to it, and how it looks in the real window.

## Not built
Several rooms, replies or mentions, edit and delete of single messages, files and images in messages, notifications when the app is in the background, and letting an assistant ask you for approval from the chat (approvals stay on Home).
