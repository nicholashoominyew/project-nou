# Backup and recovery guide — alpha 0.0.2

## Choose protection deliberately

Open **Backups & restore** after the editor reports Saved. Choose an existing dedicated backup folder. NOU creates a `Project-NOU-backups` subfolder and a separate version for every successful run. A missing/unplugged destination fails visibly and never causes fallback to the application folder.

NOU cannot prove that this folder is independent. Another folder, drive letter or partition can be on the same physical disk. For external storage, use a genuinely separate physical device and disconnect it after verification when practical. For a NAS/cloud destination, independently confirm upload, remote availability and version retention. A synced local folder alone is not proof of remote protection. Connected backups can share ransomware exposure. NOU records your description but always labels independence unverified.

Backup packages contain plaintext SQLite. Use an encrypted destination for private notes. Application-managed encryption, weekly scheduling, catch-up jobs and remote upload confirmation are not implemented.

## Create and inspect a backup

1. Finish editing and wait for Saved. Open Backups & restore.
2. Choose the destination and its protection description. Click **Create verified backup now**.
3. Check the returned path and SHA-256. The package includes `manifest.json` and `notes.sqlite3`; keep both together, including the original `backup-…` folder name.
4. Select **Verify & review**. NOU verifies and stages a separate copy, then shows the page count (including Trash), schema, time and hash. Cancel to perform a non-destructive recovery rehearsal.
5. On your independent destination, confirm the complete package is present. Use the package picker to verify that copy, preferably on a separate test profile/device. Do not delete the original as a consequence of backup.

The complete Notes database is included: hierarchy, tags, Trash, Yjs histories and legacy text, location metadata and search. Files/attachments/settings/credentials are not included. Media blocks are disabled in this version; external link targets are never implied to be backed up.

## Complete guided restore

1. Finish all saves. Open Backups & restore and select a listed version, external package folder, or local rollback package.
2. Check the date, page count and path. A standalone old `.sqlite3` snapshot can be imported through **Import an old .sqlite3 snapshot**. Import copies and validates it without changing the original; the displayed date is import time. Files with WAL/SHM/journal companions or unsupported schema are rejected.
3. Understand that restore replaces **all notes and Trash**, not one page. Newer notes will instead be retained in the rollback package.
4. Type `RESTORE`, then choose **Restore all notes**. NOU re-verifies staging, creates a verified rollback of current committed data, writes a recovery intent and performs a transactional SQLite restore. If rollback creation, disk space, verification or locking fails, it does not proceed blindly.
5. Return to notes; confirm titles, hierarchy, rich formatting, text, search and Trash. Restart NOU and check again.
6. To undo it, select the listed **local rollback** from just before the restore and use the same review/confirmation flow. This also preserves the current version first.

Do not copy a file over `notes.sqlite3` while the app is running. Do not remove `-wal` or `-shm` files to make a restore work. SQLite's Backup API handles the active connection and committed WAL content. Close older NOU releases before upgrading; only the current release implements the profile process lock.

## Interrupted restore

An intent without a completion marker pauses editing on startup. The application does not guess whether you prefer old or restored data. Inspect current notes, then either choose the preserved rollback or type `KEEP CURRENT DATABASE`. The latter validates and preserves another snapshot before clearing the barrier. Old intent and completion records stay available under `restore-journal`.

Successful rollback after an interrupted operation does not silently dismiss its historical intent. Inspect the resulting notes and explicitly keep the current database to complete review.

## If damaged data prevents NOU from opening

1. Close every NOU process. Locate the actual profile containing `notes.sqlite3` (normally `%APPDATA%\app.projectnou.desktop`). Confirm you have a separate verified backup package. Do not uninstall and delete your profile.
2. From a trusted checkout, preview the helper:

   ```powershell
   ./tools/Recover-Nou.ps1 -DataDirectory "$env:APPDATA/app.projectnou.desktop"
   ```

3. Review the exact source and recovery paths. Run the same command with `-Execute` and type `PRESERVE AND RESET` only when ready. It checks the process lock and renames the **entire** profile to a uniquely named sibling on the same volume. Database, WAL/SHM, settings and rollback copies remain together. Nothing is deleted or overwritten. A lock/permission failure stops the operation.
4. Open NOU. A new empty profile is created. Choose your external backup package, or a valid rollback package in the preserved profile, and use the guided restore above.
5. Keep the preserved profile until content and restart checks pass. It may contain newer recoverable data absent from your last backup. If no valid backup exists, retain it for specialist recovery; the helper cannot repair corrupt SQLite/Yjs data.

## Retention

Choose a minimum count (default 10, minimum 3), preview, inspect exact listed IDs, then explicitly delete that list. Versions younger than seven days stay. Immediately before removal NOU re-verifies inventory and survivor counts. Corrupt/incomplete packages, unrecognized files, extra package contents and local rollback/migration copies are not automatically deleted. No background retention runs. A deletion failure is reported and previously valid survivors remain.

Rollback, migration and staging copies consume local space indefinitely in this alpha. Low space causes backup/restore failure rather than removal of the only good copy. Provision enough space for staging, a full rollback and SQLite's transaction/WAL overhead before restoring large databases.

## Disposable-data drill

Create notes A and B, nested rich blocks and a trashed page. Back up to a separate destination. Change A and create C. Verify/stage the earlier package and cancel once, confirming C remains. Restore it with confirmation: A/B/Trash should match the earlier state, and C should disappear from active notes. Restart. Restore the generated rollback: C and the newer A should return. Repeat with an unplugged destination and a deliberately damaged **duplicate** package; expect visible errors without losing live notes or prior valid versions.

Automated process-crash tests are not a physical power-cut, cloud service, removable-media or actual-user-data recovery drill. Record those manual outcomes separately.

## Alpha 0.0.3 additions

### Weekly schedule and background checks

Weekly backups are opt-in under **Backups & restore**. A verified manual copy also resets the seven-day interval for that destination. The open application checks once a minute and immediately after startup; missed weeks produce one catch-up copy. A failed destination is retried after 15 minutes and never falls back to local profile storage. The sidebar reports errors; the panel shows last attempt and last verified success. Settings are written by atomic replacement. An unreadable schedule stops automatic work; the reset control preserves the original file before disabling the schedule and cleanup.

Install the per-user Windows task to check hourly and at sign-in while NOU is closed. It runs as the signed-in user, without storing an account password or requesting administrator rights. An open GUI owns the profile lock and performs its own checks; the headless task exits instead of opening a second writer. The PC must be on, the user signed in and the destination unlocked/available. Reinstall the task if the executable moves; remove it from the panel before uninstalling NOU. It does not wake a powered-off PC. Windows task failures/status and real catch-up behavior still require the packaged acceptance drill.

Automatic retention is a separate explicit opt-in, default off. It runs only after a newly verified scheduled backup, preserving the manual retention safety floors. Manual backup creation does not automatically delete versions. Local rollback/migration/staging copies are still not automatically pruned.

### Encrypted portable backup

Use a new `.noubackup` filename and matching passphrases (minimum 12 characters) to export an encrypted complete Notes snapshot, up to 64 MB. Encryption is AES-256-GCM with a fresh 16-byte salt and 12-byte nonce; the fixed version-one KDF is Argon2id v1.3, 64 MiB memory, three passes, one lane, 32-byte output. Header bytes are authenticated. Export reads the written file back and decrypts it before reporting success. Import authenticates/decrypts before creating a staged package, then applies the existing hash/schema/reference checks and explicit full-restore confirmation.

Keep the passphrase in a separate password manager/recovery record and test it in another disposable profile. NOU has no reset/backdoor and does not save passphrases. Passphrase strings necessarily exist temporarily in WebView/native memory; derived native keys/plaintext buffers use zeroizing storage where practical. This does not encrypt the live database, regular scheduled packages or local rollback/staging. Export temporarily creates a plaintext snapshot in the profile; its known files are removed after the operation, but crashes/failures may leave local plaintext staging and deletion is not guaranteed secure erasure. Decrypted restore staging remains local for review. Use device encryption for the profile and an encrypted destination for unattended backups. No passphrase is stored to automate portable encrypted exports.

### Note-level exports and recovery

**Export this note** saves TXT, Markdown, HTML or complete-state Recovery JSON using the native save dialog. Existing destination files are never overwritten. TXT/Markdown/HTML can simplify formatting; HTML exports block scripts and remote resources with a restrictive CSP. JSON is the fidelity-preserving note transfer format.

**Import recovered note…** validates a NOU recovery JSON file and previews its text. It reconstructs the Yjs document rather than trusting its supplied text cache; unsupported/incomplete updates are rejected. Import adds a new root page with a new ID in one transaction, preserving the source and existing notes. It is not a workspace restore or a general Notion/HTML/Markdown importer. Recovery files are plaintext. A schema change was not needed for this increment.

Follow PRE-SERVER.md for the Windows acceptance procedure and release gates.
