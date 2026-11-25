# Embedded pages

A note can hold an **Embed** block (`nouEmbed`): a web page shown inside the note, or a saved copy of an HTML page. Assistants can ask to add one; nothing is written to a note without approval in NOU.

## The block
Fields: `url`, `title`, `height` (200 to 1600, default 480), `mode` (`live` or `snapshot`), `fileId` (the stored .html file of a snapshot).
- Insert with `/embed`, or paste an address of an allowed site onto an **empty line** (anything else pastes as before).
- **Live**: a lazy-loaded frame with `sandbox="allow-scripts allow-same-origin allow-popups"` (no top navigation), `referrerpolicy="no-referrer"`. Resize by dragging the grip under it or with the up and down arrow keys.
- **Snapshot**: attach an .html file (stored with the page's files like any attachment, up to the normal 20 MB limit when attached by hand). It is shown with `srcdoc` in `sandbox="allow-scripts"` (no same-origin, no top navigation, no pop-ups, no forms) behind a policy that allows no network of any kind (`default-src 'none'`, `connect-src 'none'`, no nested frames). It works offline and never updates.
- Never a blank frame: a card with the title, the address and **Open in new tab** is shown when the host is not on the list, the computer is offline, the host is known to refuse framing, or the frame has not reported loading after 10 seconds (with Try again). A live frame always has an "Open in new tab" link under it. The sandbox is never loosened to make a page load.

## The allowlist
`claude.ai` is built in (and its subdomains). Add other sites in **Settings, Embedded pages**. Rules (the same in `embed.ts` and `embeds.rs`): `https://` only, no user name or password, no port other than 443, a real host name (no IP address, no `localhost`), a listed host or a subdomain of one (`evilclaude.ai` and `claude.ai.evil.com` do not match). The list is kept in the window and copied into the database (`app_settings`, key `nou-embed-hosts`) so requests from assistants are checked against it when they are made; it also travels with a sync.
The app's own frame policy (`tauri.conf.json`) is `frame-src blob: https:` so that a site you add can be framed; which sites are actually framed is decided by the allowlist in the code, not by that policy.

## Does claude.ai allow framing? (tested)
**No.** Requests to `https://claude.ai/artifact/<id>` answer with `Content-Security-Policy: frame-ancestors 'self' chrome-extension://…` (two Chrome extension ids), and `https://claude.ai/public/artifacts/<id>` with `frame-ancestors 'self'`. A page in NOU is neither, so a browser refuses to show it. Tested with `curl -I` on 2026-11-25 against a made-up id (no sign-in), so the header on a real, signed-in artifact was not seen; the policy looked the same on both routes. For that reason claude.ai embeds open as a card first, with "Open in new tab", "Try live view anyway" and "Use a snapshot instead". This is checked in a real Chromium, not just assumed: a frame refused by `X-Frame-Options` or `frame-ancestors` still fires a normal `load` event and cannot be told apart from a loaded cross-origin page from inside the page, which is why the known refusal list, the offline check, the 10-second wait and the always-visible link are used.

## Snapshot limits (tested in Chromium with NOU's policy)
- A frame made with `srcdoc` **inherits NOU's own policy** (`script-src 'self'`), so **inline scripts in a snapshot are blocked** (confirmed in a Windows release build; a `tauri dev` build applies no policy to its own page, so scripts do run there). Static HTML and CSS display; scripts do not run. Most Claude artifacts are interactive (React, charts), so a snapshot of those will be mostly static or blank. Fixing this properly means serving the snapshot from its own origin with its own policy (a custom protocol in the app), which has not been built and could not be tried on Windows here.
- With no network, anything loaded from another site (CDN scripts, web fonts, remote images) does not load. The HTML must be self-contained: inline everything and use `data:` URLs.

## Assistant tools (same approval flow as the other nou_propose_* tools)
- `nou_propose_append_embed(page, url, title?, height?, summary?)`
- `nou_propose_attach_html(page, title, html, summary?)` (at most 48,000 bytes, because a request must fit the 64 KB proposals table)
Both need the `notes:write` scope. The backend refuses a request whose address is not https or not on the list before it is queued; the app checks again when it is approved. The approval card shows what would be added: a snapshot is previewed in the no-network frame; a live page is only loaded if you press "Load a live preview". Approving adds one block at the end of the note through the normal save path; the same address is not added twice. `nou_propose_append_text` is unchanged; its description now points at the embed tools.

## Checked on Windows (25 Nov 2026)
Pasting an address onto an empty line (a simulated paste event), the claude.ai card, "Try live view anyway" showing the browser's blocked page, and a static snapshot, in WebView2.

## Not verified
The "/" menu item, a paste from the real clipboard and the resize grip; a live frame that does load; offline behaviour on a real machine; a custom protocol for scripted snapshots (not built).
