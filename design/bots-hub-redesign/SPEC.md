# Bots Hub redesign — spec

**Theme:** Elementel dark. The NOU light theme uses the same layout with the blue accent.
**Reference:** `design/bots-hub.dc.html`.

## Layout

- The NOU shell stays as it is:
  - sidebar 272px wide (minimum 220px) on `panel`;
  - tab bar 46px high;
  - content padding 32px top and 48px at the sides, maximum width about 1240px.
- **Page head:**
  - eyebrow with a live dot and "N BOTS ONLINE" (mono, 11px, 0.14em tracking, muted);
  - title "Bots Hub" (Plex, 36/700, −0.02em);
  - one-line description (15px, muted);
  - on the right, two ghost buttons: "Tokens & scopes" and "API: POST /v1/chat".
- **Body:** a wrapping flex row with a 16px gap.
  - Collaboration chat: `flex: 999 1 560px`, height about 760px.
  - Side column: `flex: 1 1 340px`. It holds two panels of about 372px each, with a 16px gap between them.
  - All panels use `panel` fill, a 1px `line` border, `radius-lg` (10px) corners and no shadow.
- **Sidebar:** the Bots Hub row is active (`raised` fill plus a 2px accent inset on the left) and shows "N WAITING" in mono accent, where N is the number of queue items in Needs Nick.

## 1. Bot collaboration chat (big)

**Header**
- Eyebrow "COLLABORATION ROOM", with the room name below it as `# room-slug`.
- Room tabs on a recessed track: General, DraftBot, NOU build. Rooms come from data, so users can add more.
- A strip of overlapping participant avatars (2-letter mono codes) with presence dots: accent means online, muted means idle.

**Feed** — scrolls, with a "TODAY" date divider. It has three item types:
- `message`: avatar tile (32px, `radius-sm`), name (600), role tag in mono (YOU / ROUTER / EXECUTOR / LOCAL …), time in mono, then body text (14/1.55, maximum about 70ch).
- `handoff`: an indented, dashed-border mono line with an arrow icon, for example `CLAUDE → CHATGPT · HANDED OFF "C# DIMENSION COMPONENT"`, plus the time.
- `approval`: an indented card on `card` fill.
  - Status shows as dot plus word, either NEEDS NICK (accent, with a soft ring) or APPROVED (muted). It also says which bot it is from, plus the question text.
  - While open, it shows **Approve** (accent outline button) and **Open spec** (ghost).
  - Approving it:
    - closes the card;
    - marks the linked queue item Done;
    - updates the sidebar badge;
    - lets the bot know, through the API.

**Composer**
- A row of @mention chips. Clicking one appends `@Name ` to the draft.
- A textarea: Enter sends, Shift+Enter adds a new line.
- The **Send** button is the only accent fill on the page.
- An @mention in a sent message should be routed to that bot. Reuse the existing Bot Queue routing if there is one.

## 2. In-house bot chat (small)

- **Header:**
  - KU avatar;
  - "In-house bot · Kura";
  - "LOCAL MODEL · PRIVATE TO YOU" (mono);
  - live status shown as dot plus word (RUNNING / SLEEPING / OFFLINE).
- **Messages:** compact bubbles. Nick's are on the right (`raised`), the bot's on the left (`card`), corners 10px with the corner nearest the sender at 4px.
- **Input:** a single-line input with Enter to send, and an icon-only send button that has an `aria-label`.
- This is a private 1:1 channel with the self-hosted model. It is **not** visible to other bots and does not appear in the collaboration room.

## 3. Bot queue (small)

- **Header:** "Bot queue" plus an "N OPEN" count (anything not Done).
- **Filter tabs:** All, Running, Needs Nick, Done, each with a count. Mono, 10px, uppercase.
- **Rows:**
  - bot code chip;
  - task title (13px, truncated with an ellipsis);
  - status as dot plus word.
- **Status styles:**
  - RUNNING = accent dot;
  - NEEDS NICK = accent dot with a soft ring;
  - QUEUED = muted dot;
  - DONE = hollow muted dot, with the title muted and struck through.
- When a filter has no items, show a dashed-border placeholder reading "Nothing here."
- A footer link "OPEN FULL QUEUE →" goes to the existing full queue view.

## Data and API (to confirm against the codebase)

- **Rooms:** `id`, `name`, `slug`, `order`.
- **Collaboration items:**
  - `room_id`, `type` (message | handoff | approval), `author` (the token name), `role`, `text`, `created_at`;
  - for handoffs: `from`, `to`, `task_ref`;
  - for approvals: `status` (open | approved | declined), `queue_item_id`.
- **In-house chat:** its own channel or table, tied to the local model's token. The bot replies through the local model.
- **Queue items:** `title`, `bot`, `status` (queued | running | needs_nick | done), links to the room and approval.
- **Token scopes:** keep the existing chat scopes, and add separate scopes for posting to the collaboration room, the in-house chat and the queue if they are needed.

## Acceptance criteria

1. All three panels are visible at once on a 1440px-wide screen, with the collaboration chat clearly the largest.
2. Below about 1000px wide, the side column drops under the collaboration chat. On phone width the sidebar stacks and nothing scrolls sideways.
3. A bot can post a message, a hand-off and an approval to a room through the API with its token, and each one appears with the right style.
4. Approving a card updates the card, the queue row and the sidebar badge without a page reload.
5. In-house chat messages never appear in the collaboration room or in the API responses that other bots receive.
6. The queue filters show the right items and counts.
7. Keyboard: every control can be reached with Tab and shows a 2px accent focus ring. Enter sends in both chats.
8. Exactly one accent-filled button is on screen (the collaboration Send), not counting the quick-capture button.
9. Existing chat history migrates into the "General" room.
