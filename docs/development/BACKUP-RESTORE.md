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
