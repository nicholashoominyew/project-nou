# Roadmap proposal — 11 November 2026 (DRAFT, not yet in the Notion plan)

Status: **draft for the owner's review.** Nothing here has been written to the Notion plan. If accepted, paste the "Plan text" section into the plan page and update the Pending Features rows' build order.

## Why change the phase layout
Most wishlist features need only the desktop app. Phase 8 sits after the home server and Android work, so leaving them there would delay them for months without a technical reason. Two new phases are proposed: **1b** (before the importer) and **2b** (after it). The Notion importer stays the first big item because it unblocks cancelling Notion.

## Proposed order
| Phase | Contents | Effort |
|---|---|---|
| **1b — finish the offline MVP** | Merge 0.0.4 and the `fix/editor` + `feature/databases` stack after acceptance checks; tags UI; clickable breadcrumb; backlinks; focus mode | S–M |
| **2 — Notion importer** (existing) | Importer with dry run, hierarchy, attachments, database fields; minimal formula, Files & media and Person-style properties pulled forward from Phase 8 so Notion databases have somewhere to land | L |
| **2b — daily workspace** | Split view (and a per-pane save guard); custom home page widget shell; global quick-capture hotkey; linked checklist items; resurfacing and spaced repetition; project file links and file tracker (database view); flowchart block; graph view; lock notes (before Phase 4) | M–L each |
| **3 — gateway** (existing) | Local approval gateway, audit log, revocable tokens; local web clipper behind the same local-API security | L |
| **3b — AI plumbing** | AI bot queue UI and scheduled jobs, first over a cloud AI via MCP; swap for a self-hosted AI later | L |
| **4, 5, 6, 7** (existing) | Home server and sync; Files archive; laptop and Android; integrations | XL |
| **8 (reduced)** | Templates, date ranges and times, automation rules | M each |
| **9** (existing) | Ollama, private AI search over notes/PDFs/images, hardening | L |

## Build-order notes (replaces the numeric order in the Pending Features rows)
1. Backlinks before graph view. 2. Split view before the home page and quick capture, because both add panes and today the save status is a single slot. 3. Home page before everything that shows a widget (inbox, resurfacing, approval, bot queue, linked checklist items). 4. Lock notes before sync so the server never handles locked plaintext. 5. Approval gateway before bots or scheduled jobs write anything.

## Open decisions
- Importer first, or home page and quick capture first (daily use before migrating)? Default here: importer first.
- Should lock notes move up if sensitive notes go into NOU early?
- Hosting route (home SER8 vs VPS) is unchanged and still undecided.

## Plan text (paste-ready)
> **Phase 1b — Finish the offline MVP (S–M).** Merge and accept alpha 0.0.4 and the editor/databases stack; tags UI; clickable breadcrumb; backlinks; focus mode.
>
> **Phase 2b — Daily workspace (M–L).** Split view; custom home page with widget shell; global quick-capture hotkey; linked checklist items; resurfacing and spaced repetition; project file links and file tracker as a database view; flowchart block; graph view; lock notes. Needs no server.
>
> **Phase 3 additions.** Local web clipper behind the gateway's local-API security. **Phase 3b — AI plumbing.** AI bot queue and scheduled jobs, first via a cloud AI over MCP, later a self-hosted AI, all behind the approval gateway.
>
> **Phase 8 (reduced)** keeps templates, date ranges and automation. Formulas and the property types Notion databases need move into Phase 2.
