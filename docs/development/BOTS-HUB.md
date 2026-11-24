# Bots Hub

One page, three panels, replacing the old Bot queue (one shared chat with Chat and Queue tabs). Open **Bots Hub** in the sidebar, which shows **N WAITING** when queue items need you. The approved design and spec are in `design/bots-hub-redesign/` (`SPEC.md` is the source of truth). Schema version **12**.

## The three panels

1. **Bot collaboration room** (big, left). Room tabs (General plus any rooms you add with **+**), a strip of avatars with presence dots, and a feed of three item types: messages (avatar, name, role tag, time), hand-off lines (`CLAUDE → CHATGPT · HANDED OFF “C# DIMENSION COMPONENT”`) and approval cards (**NEEDS NICK · FROM CLAUDE**, with **Approve** and, when the bot gave a spec reference, **Open spec**). The composer has @mention buttons, Enter to send and Shift+Enter for a new line. Its **Send** button is the only accent-filled button on the page.
2. **In-house bot** (top right). A private one-to-one chat with the local model (Kura): its own status (RUNNING, SLEEPING or OFFLINE as a dot plus a word), compact bubbles, a single-line input and an icon-only send button. Like an ordinary AI chat app it holds **several chats**: a chat picker, **+ New**, **Rename**, **Clear chat** and **Delete** (both ask first), and a **Harness** button for extra instructions.
3. **Bot queue** (bottom right). Open count, filters All / Running / Needs Nick / Done with counts, a bot code, title and status per row, "Nothing here." for an empty filter, and **OPEN FULL QUEUE →** which opens the existing approvals view (note changes that AI tools asked for) with a way back.

Below about 1000 px the side column drops under the room; on a phone the sidebar folds and nothing scrolls sideways.

## How a bot uses it

Create a token under **Settings, then AI access** and tick the scopes it needs. Bots use the local API (or the MCP bridge in `tools/nou-mcp`). Everything they write is plain text signed with the **token's name**, and everything they read is labelled untrusted data.

| Scope | Allows |
|---|---|
| `chat:read` / `chat:write` | Read and post messages and hand-offs in a room (existing scopes, now room-aware) |
| `queue:read` / `queue:write` | Read the queue; add and update the token's **own** items; post approval cards (an approval needs `chat:write` **and** `queue:write`) |
| `inhouse:read` / `inhouse:write` | Only for the local model's runner: read your private questions and reply |

| Call | What it does |
|---|---|
| `GET /v1/rooms` | The rooms (name, slug) |
| `GET /v1/chat?room=<slug>&after=<id>&limit=<n>&mentioning=<name>` | Messages of a room (General by default). `mentioning` returns only what was handed to that bot with an @mention (nothing is pushed to a bot) |
| `POST /v1/chat` | `{body, room?, type?, role?, to?, task_ref?, queue_title?}`. `type` is `message` (default), `handoff` (needs `to`; `task_ref` names what was handed over) or `approval` (the question is `body`; also makes a queue item) |
| `GET /v1/queue?status=` / `GET /v1/queue/:id` | The queue. One item also reports the owner's decision when it came from an approval card, which is how the asking bot finds out |
| `POST /v1/queue` / `PATCH /v1/queue/:id` | `{title, status?, room?}` / `{status}` with status `queued`, `running` or `done` |
| `GET /v1/inhouse?chat=<id>&after=<id>&limit=<n>` / `POST /v1/inhouse/reply` | The private channel; only a token with the in-house scopes. Every message carries its `chat_id`; without `chat` the messages of all chats come back. A reply is `{body, chat?}` and goes into that chat (by default the chat of your latest question) |
| `GET /v1/inhouse/harness?chat=<id>` | The extra instructions for one chat, already combined: `{chat, names, instructions}`. In-house scopes only |

Only **you** decide an approval card (an app action, never an API call). Approving closes the card, marks its queue item Done, lowers the sidebar count and records an entry in the audit log. A bot cannot close its own waiting item, cannot edit another bot's items, and cannot make rooms.

## The in-house bot (Kura)

The app provides the private channel and the screen. The answers come from a small runner on your computer, `tools/nou-kura/nou-kura.mjs` (Node 18 or newer, no dependencies):

1. Install [Ollama](https://ollama.com) and a model, for example `ollama pull llama3.2`.
2. In NOU create a token with **only** `inhouse:read` and `inhouse:write`, and switch the local API on.
3. Run it:

```bash
NOU_TOKEN=<the token> KURA_MODEL=llama3.2 node tools/nou-kura/nou-kura.mjs
```

It polls every few seconds, answers the chat that has been waiting longest using only that chat's own messages (the last 20), asks Ollama on `127.0.0.1`, and posts the answer into the same chat. Before it answers it reads that chat's harness and adds it after its usual instructions; if the harness cannot be read it answers without it. It only talks to addresses on this computer, and the token has no access to your notes or to the collaboration room. The panel shows RUNNING when the runner's token was used in the last 30 seconds, SLEEPING within 10 minutes, otherwise OFFLINE.

### Chats and harnesses

- **Chats.** A new chat is called *New chat* and takes its name from the first thing you say in it (you can rename it). Clearing a chat deletes its messages but keeps the chat, its name and its harnesses. Deleting a chat deletes its messages; deleting the last one leaves a fresh empty chat. There are at most 100 chats, and the newest 1,000 messages across all chats are kept. Messages from before chats existed are in a chat called *Earlier chat*.
- **Harnesses.** A harness is a named block of extra instructions (up to 4,000 characters; up to 30 harnesses), written for NOU, for example how NOU's pages, databases, Life Timetable and Bots Hub work, or a style such as "brief answers". Tick the harnesses a chat should use, or mark one **Use in every chat**. The model gets them after its usual instructions, always-on ones first, up to 8,000 characters in all. The panel offers templates (*NOU helper*, *Timetable coach*, *Brief answers*); choosing one only fills in the form, and nothing is saved until you save it.
- **What a harness cannot do.** It only changes what Kura is told. The runner still has no access to your notes, and its usual instructions say that no harness changes what it can do or lets it claim to have changed a note.

## Privacy and safety

- The in-house channel is a separate set of tables (`inhouse_messages`, `inhouse_chats`, `inhouse_harnesses`, `inhouse_chat_harnesses`; schema 14, `db/notes/014_inhouse_chats.sql`). `/v1/chat`, `/v1/queue` and the mention filter never read it, and a token needs the in-house scopes to touch it (tested, including a token with every other scope).
- Nothing said in the Hub changes a note, a database or a setting. A message, a hand-off or a card is data.
- 20 messages a minute and 30 queue items a minute per token. The room keeps the latest 2,000 messages; finished queue items are pruned past 300.
- A bot's author name, a hand-off's sender and an item's owner always come from the token. The tables refuse a forged author, an approval without a status and a hand-off without both sides.

## Migration

Schema 12 (`db/notes/012_bots_hub.sql`, one-way, with the usual rollback snapshot) adds rooms, the message type columns, the queue and the in-house table. Every existing message moves into the **General** room, and the old unread badge is replaced by **N WAITING**.

## Development sample data

In a development build only, **Load sample data** (page header) loads the mockup's conversation: sample bot tokens (their secrets are discarded), the DraftBot and NOU build rooms, messages, a hand-off, an open approval card, queue items and a private chat. It refuses to run in a release build.

## Acceptance check (SPEC.md)

| # | Criterion | How it was checked |
|---|---|---|
| 1 | Three panels at once at 1440 px, the room largest | Measured in a browser: room 717 px wide and 760 px high, both side panels 340 × 372 |
| 2 | Side column drops under the room below about 1000 px; phone width has no sideways scroll | Measured at 900 px (side below) and 400 px (no overflow) |
| 3 | A bot posts a message, a hand-off and an approval through the API and each shows in its own style | Rust API tests, and the page tests render each type |
| 4 | Approving updates the card, the queue row and the sidebar badge without a reload | Page test, and clicked in a browser with sample data (1 WAITING → none, card APPROVED, row DONE, 3 OPEN) |
| 5 | In-house messages never appear in the room or in other bots' API responses | Rust API test (scopes and no leak through chat, mention and queue reads) and a page test |
| 6 | The queue filters show the right items and counts | Page tests |
| 7 | Keyboard: Tab reaches every control with a 2px accent focus ring; Enter sends in both chats | Real buttons, inputs and labels; the ring is a style rule (checked in `theme.test.ts`); Enter tested in both chats. Not walked through by hand with a keyboard |
| 8 | Exactly one accent-filled button (Send), not counting quick capture | Style test, and computed styles in a browser (Send and the quick-capture button only) |
| 9 | Existing chat history moves into General | Rust migration test |

## Tests

- Rust: rooms, hand-offs, mentions, approval cards and decisions (including a failure leaving no queue item), the queue (own items only, a bot cannot close a waiting item, ordering, rate limit, pruning), the in-house channel and its status, participants, the sample data, the migration of old messages, a backup and restore at schema 12, and 5 API tests.
- Vitest: `botsHub.test.tsx` (panels, feed items, rooms, composer, approve flow, queue filters, in-house chat, header buttons, helpers), the sidebar count in `App.test.tsx`, and the style rules in `theme.test.ts`.
- Node: the MCP bridge tools for rooms, hand-offs, approvals and the queue, and the Kura runner.

## Not verified

A real bot posting through the API from outside the app, the Kura runner against a real Ollama, the page inside the real Tauri window, a hand walk-through of Tab order and focus rings, and contrast ratios measured in the running app (the colours are the existing theme tokens).

## Not built

Declining an approval from the card (the data model supports it), editing or deleting single messages, deleting rooms from the screen, push notifications to bots, and an "Open spec" that does more than open a page by title or id.
