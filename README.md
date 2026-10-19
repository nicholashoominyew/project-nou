# Project NOU (脳)

A Windows-first, local-first knowledge workspace with independent Notes and future Files systems.

## Current stage: Windows alpha 0.0.2

The first 0.0.1 Windows alpha was installed and manually confirmed by the user: note persistence after restart, search, Trash and restoration of preserved text. This increment adds verified backup packages, a complete guided Notes restore with rollback, and a BlockNote editor with explicit per-note migration. It remains an unsigned alpha.

### Implemented

- Offline pages, hierarchy, rename, manual ordering, search and recoverable Trash.
- BlockNote rich text: headings, lists, checklists, tables, formatting, slash menu, block handles and undo; Yjs persists to the separate SQLite Notes database.
- Existing Y.Text notes stay editable as plain text until **Convert this note to rich text**. Original text, old Yjs history and a pre-conversion database recovery package are preserved.
- **Backups & restore**: select a destination; create uniquely versioned standalone database packages with SHA-256, integrity, exact schema and reference checks; inspect and restore a selected package; preserve verified rollback first.
- SQLite transactional restore handles WAL without replacing open files or deleting sidecars. Interrupted operations require review before further edits. A process lock prevents two current NOU instances from using the profile.
- Explicit retention preview/deletion: at least three verified versions and all versions younger than seven days; revalidation before deletion; unknown/corrupt packages and local rollback copies stay untouched.
- Windows tests and NSIS packaging CI with JS/Rust lockfiles and installer checksums.

**Choosing a destination does not prove independence.** Another folder or drive letter can share a physical disk. External-drive and remote/cloud protection are user declarations; NOU cannot verify physical separation, remote upload, provider retention or offline ransomware protection. Packages are not application-encrypted. See [backup and recovery guide](docs/development/BACKUP-RESTORE.md).

### Verification

The [verification record](docs/development/VERIFICATION.md) separates executed tests from manual checks still needed. A generated installer is not evidence that every packaged GUI flow passed. Test with disposable notes before migration.

**Not implemented:** scheduled/weekly backups, server sync or relocation, Files storage/attachments/archive, Notion import, integrations, application-managed encryption, signed releases. Media blocks are disabled until their files can be stored and backed up. No external AI service is used by the editor.

## Windows development

Prerequisites: Node 22+, Python 3.12+, Rust MSVC, Visual Studio C++ Build Tools, WebView2 and Git. See [Windows guide](docs/development/WINDOWS.md).

```powershell
npm ci
npm run icons
npm run tauri -- dev
```

```powershell
npm test
npm run build
python -m unittest discover -s tests -v
./tests/test_cold_recovery.ps1
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run package:windows
```

The [Windows CI workflow](https://github.com/nicholashoominyew/project-nou/actions/workflows/desktop-checks.yml) uploads the unsigned NSIS installer and SHA256SUMS only after checks pass. Do not infer success from workflow configuration alone.

## Architecture and next work

- [Canonical architecture and build plan](https://app.notion.com/p/3fc9441b1f1681b6b278d7314dc5cce6)
- [Phase 0 baseline](docs/architecture/PHASE-0.md)
- [Notes persistence](docs/architecture/ADR-001-notes-persistence.md)
- [Backup, restore and document migration decisions](docs/architecture/ADR-002-recovery-and-blocknote.md)

The selected future server is a Beelink SER8 with Windows 11 Pro; no server is required for this offline alpha. Notes backups duplicate content. Future file archiving moves content only after verified independent backup coverage. Neither subsystem may silently delete the only recoverable copy.

Never commit private notes, local backup packages or credentials.
