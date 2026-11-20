# Prompt for Claude Code — Project NOU: Bots Hub redesign

Paste everything below the line into Claude Code, run from the root of the Project NOU repo, with this folder copied in as `design/bots-hub-redesign/`.

---

Redesign the **Bots Hub** page in Project NOU. Reference files are in `design/bots-hub-redesign/`:

- `SPEC.md` — layout, behaviour, data and acceptance criteria. Treat it as the source of truth.
- `design/bots-hub.dc.html` — the approved mockup. Its markup, inline styles and the `renderVals()` script show the exact layout, spacing, colours, copy and interactions. It uses a design-tool runtime (`support.js`, `<x-dc>`, `<sc-for>`, `<sc-if>`, `{{holes}}`). **Do not copy that runtime into the app.** Rebuild it in NOU's own framework and components.
- `design/elementel-tokens.json` — Elementel design tokens (colours for dark/light, type, spacing, radius, shadow). Use NOU's existing theme variables where they already map to these. Add any that are missing to the theme, not hard-coded per component.
- `design/current-bots-hub.png` — the page as it is today, for comparison.

## What to build

Replace the current Bots Hub (one shared chat, plus Chat/Queue tabs) with one page that shows three panels at once:

1. **Bot collaboration chat (big, left, about two-thirds of the width).** A multi-bot room where Nick and the bots talk. It has room tabs, an online-participants strip, hand-off event lines, inline "Needs Nick" approval cards, @mention quick buttons and a composer. The Send button is the page's only accent-filled button.
2. **In-house bot chat (small, top right).** A private 1:1 chat with the local/self-hosted model (Kura). It is separate from the collaboration room.
3. **Bot queue (small, bottom right).** A compact task list with filter tabs (All / Running / Needs Nick / Done), a bot code per row, a status shown as dot plus word, and an "Open full queue" link.

## How to work

1. **Explore first. Don't change anything yet.** Find the current Bots Hub page, its chat and queue components, the local API routes (`POST /v1/chat` and the queue), the token and scope settings (Settings → AI access), how bot tokens sign their messages, and the theme/token setup. Report back briefly: the files involved, the data model, and what already exists versus what is missing for each panel.
2. **Propose a plan** covering:
   - frontend components;
   - any backend and schema changes (rooms, message types `message` / `handoff` / `approval`, the in-house chat channel, queue status values, approve action);
   - new token scopes;
   - a migration path for existing chat messages, which should land in a "General" room.

   Wait for my OK on any schema change or new scope before writing code.
3. **Build it in small commits:**
   1. Theme tokens.
   2. Page layout shell.
   3. Collaboration chat.
   4. In-house chat.
   5. Queue panel.
   6. Approve flow wired end to end: approving in the chat updates the queue row and the sidebar "N WAITING" badge.
4. **Keep existing behaviour working.** Bots must still be able to post via the API with their tokens, and nothing said in the Hub changes notes.
5. **Finish with a check:**
   - Run the app.
   - Confirm every acceptance criterion in `SPEC.md`.
   - Run existing tests and add tests for the new API routes and the approve flow.
   - Tell me what you couldn't verify.

## Rules

- Follow Elementel: one accent fill per view, borders not shadows, status = dot + word (never colour alone), mono uppercase for labels, IBM Plex Sans for reading text, British spelling, no emoji.
- Accessibility: real `<button>` / `<a>` / `<label>` elements, `aria-label` on icon-only buttons, visible focus ring (2px accent), text contrast at least 4.5:1, touch targets at least 44px where practical.
- Responsive: below about 1000px the side column stacks under the collaboration chat, and the sidebar stacks on phone width.
- Use the mockup's sample messages and tasks only as placeholder or seed data in development, never as hard-coded production content.
- Don't add new dependencies without asking.
