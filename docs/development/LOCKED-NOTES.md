# Locked notes (password lock)

One lock icon in the page toolbar. A locked note's text is encrypted on this computer and cannot be read, searched or edited until you enter its password.

## Using it
- Open a note and click the **lock icon** in the toolbar. Choose a password (8 or more characters, entered twice) and **Lock this note**. The note stays open for this session.
- A locked note shows a small lock beside its name in the sidebar. Opening it shows a lock screen; enter the password to read and edit it.
- The lock icon on an open locked note offers **Lock now** (back to the lock screen), **Change password…** and **Remove lock…**.
- **If you forget the password, the note cannot be recovered.** Nothing that could recover it is stored. Keep a separate copy of the password.

## What is protected
- The note's content: every saved change and snapshot is stored as AES-256-GCM ciphertext. The key comes from your password with Argon2id (a random salt per lock, the same cost as encrypted backups). A wrong password is detected without storing the password or the key.
- Each stored piece is tied to its note and its position, so pieces cannot be swapped between notes or reordered.
- While locked, the note's text is removed from the search index, the pages and to-dos it links to are not indexed, and the local AI API refuses to read it (it answers "locked"). Backups contain only the encrypted form.
- The unlocked key lives in memory only, until you choose **Lock now** or close NOU.
- After five wrong passwords on a note, further guesses wait a growing number of seconds (up to five minutes).

## What is NOT protected (be aware)
- **The title**, the tags, and where the page sits in the tree stay visible and searchable.
- **Files attached to the note** (images, PDFs, other files) are stored separately and are not encrypted; they also appear in the Files screen.
- Anyone using NOU while a note is unlocked can read it. Lock it when you step away.
- Exporting a note you have unlocked (txt, md, html, JSON) writes readable text; a regular backup stores the encrypted form.
- It does not protect against malware running on your computer while the note is unlocked, or against someone watching you type.

## Limits
- Only rich-text notes can be locked. An old plain-text note must be converted first, and a note converted from plain text (which keeps a plain copy of the original) cannot be locked yet.
- The note must be saved before locking, changing or removing a lock.
- No automatic re-lock after a period of inactivity yet.

## How it works
- Schema 8 (`db/notes/008_page_locks.sql`, a one-way step with the usual rollback snapshot): `page_locks` holds the salt, Argon2 settings and a small encrypted check value per locked note. Existing rows are untouched.
- `locks.rs` does the work. Locking, removing the lock and changing the password each run in one transaction, so a failure leaves the note exactly as it was. `load_note` and `save_note` decrypt and encrypt transparently when the note is unlocked in memory; the plain loader and saver refuse a locked note.
- `PageLock.tsx` has the toolbar icon, the lock screen and the gate that keeps the editor from opening a locked note.

## Verified
- Rust: 14 tests (everything encrypted and the plain bytes absent; search text removed and title kept; plain loader and saver refuse; wrong password and per-page binding; saving into a locked note; blobs cannot move between notes or positions; remove lock restores text and search; change password; failed lock changes nothing; plain-text and converted notes refused; links and linked to-dos not indexed; password rules, key tied to the stored lock; throttling), and the backup and restore tests run on schema 8.
- Vitest: 12 tests for the lock screen, gate and toolbar (unlock, wrong password, lock again, set with rules and warning, failure shown, menu, hidden on the lock screen, change password, remove lock reads the text first) plus the sidebar mark and lock screen in the app.
- Not verified: the whole flow in the real window; behaviour after restoring a backup in the real app; the cost of unlocking on slower computers (about a third of a second here).

## Not built
Auto-lock after inactivity, encrypting titles or attached files, locking a note converted from plain text, a password hint (deliberately none), and "lock all" in one click.
