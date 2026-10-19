# Project NOU (脳) — Phase 0 Architecture

Status: Phase 0 / Architecture baseline — 19 October 2026

## Mission
A local-first, self-hosted knowledge workspace combining Notion-style note-taking (primary) and OneDrive-style file handling (secondary). These are **two independent systems** in one application.

## Deployment targets
- **Phase 1:** Windows desktop, fully offline, without home server.
- **Later:** Beelink SER8 Ryzen 7 8745HS, Windows 11 Pro preferred; Windows laptop and Android clients.
- **Connectivity:** local network and private Tailscale access. No public server endpoint by default.
- **Desktop archive:** existing 4 TB Windows desktop drive; machine is not continuously online.

## Boundaries
1. Knowledge System owns notes, page tree, sorting, tags, databases, Yjs updates, search and note storage-location metadata.
2. Files System owns folders, blobs, large uploads, archive jobs, file retention pins and file catalogue.
3. Shared shell provides navigation, authentication and UI; integrations use authorized APIs rather than accessing either database directly.
4. Notes may reference files only through stable file IDs and Files APIs.
5. Both systems have independent databases, storage directories, synchronization and recovery workflows.

## Knowledge storage rules
- Default authoritative note content on server once deployed; offline client caches are not backups.
- Weekly consistent, versioned **duplicate** notes backup to desktop; server original stays.
- Per-note single location switch: Server ↔ Desktop. Transfer, verify, commit new location, then safely retire old primary copy.
- Desktop-primary notes may be inaccessible from other devices while desktop is off; server retains catalogue metadata.
- Relocation does not replace independent backups.

## Files storage rules
- Files initially upload to server; support large videos/photos/backup files with resumable transfers.
- Weekly archive to desktop when online; verify integrity before deleting server content.
- Per-file **Keep on Server** pin prevents archival deletion.
- File catalogue stays on server and indicates desktop-off unavailability.
- **Safety gate:** independent restorable backup required before destructive server deletion. Archiving alone is not backup.

## Initial technology choices
- Desktop: Tauri 2 + React + TypeScript + BlockNote.
- Local data: SQLite; Yjs for rich-text document updates.
- Server later: TypeScript + Fastify, Windows services, separate Notes and Files stores.
- Android later: Capacitor + React.
- External integrations: Google Calendar, Gmail, Claude, ChatGPT, Grok and Grok Bot via verified supported APIs/MCP. Scoped reads and explicit approval for writes.
- Private local AI deferred.

## Phase 0 deliverables
1. Architecture decision records (ADRs) and module boundaries.
2. Data schema drafts for notes, hierarchy/order, Yjs persistence and file catalogue.
3. Storage-location, note backup and file archive state machines.
4. Threat model and backup/restore policy.
5. Monorepo skeleton and Windows development instructions.
6. Phase 1 prioritized backlog and testable acceptance criteria.

## Phase 1 exit criteria
Offline Windows app creates, edits, organizes, sorts, searches, exports and restores notes without network access; no data loss on restart. File subsystem and home server are not prerequisites.

## Open decisions
- Independent backup medium and retention duration.
- Exact note relocation semantics when desktop offline or concurrent edits exist.
- Current Notion/OneDrive data volumes and desktop hardware.
- SER8 SKU, RAM/SSD configuration and Windows licence.
- Provider-specific MCP/API connector capabilities.

## Security invariants
- Source data is never removed before verified durable destination and required backup protection.
- Notes backups are snapshots, not blind copies of an open SQLite database.
- No AI-requested write without explicit human approval; audit all actions.
- Default network posture is private; least privilege and encryption at rest where supported.
