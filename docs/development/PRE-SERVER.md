# Offline milestone before home-server setup

Scope: complete the Windows-only Notes workflow, portable recovery, unattended backups and release preparation. Home-server purchase/deployment, synchronization, Files, Android and integrations remain later work. The server is not required for this milestone.

## Current gates

| Gate | Implementation / evidence | Still required |
| --- | --- | --- |
| Offline Notes | Existing create/edit/tree/search/Trash plus TXT, Markdown, HTML and complete-state JSON exports; additive recovery JSON import | Packaged Windows acceptance, keyboard/IME/accessibility/drag testing |
| Backup and restore | Existing verified packages, staged transactional restore and rollback; new password-encrypted export/decryption for review | Physical independent-drive and separate-profile/device recovery drill |
| Weekly backups | Durable seven-day schedule, startup/minute checks, one catch-up copy, failure retry, visible status; optional signed-in-user Windows task | Real Windows task registration, close/reopen, sign-in and sleep/wake testing |
| Retention | Manual preview remains; optional automatic cleanup only after verified scheduled success | Confirm real storage and desired retention; automatic deletion stays off by default |
| Security | AES-256-GCM/Argon2id portable backup, no stored passphrase, profile lock, explicit restore/import flows | Independently store/rehearse passphrase recovery; use encrypted storage for plaintext profiles and scheduled packages |
| Releases | Locked builds, installer hashes, signed-release helper with certificate/timestamp checks | Obtain/provision a trusted code-signing identity; run the helper and verify its result |
| Milestone acceptance | Automated checks and this repeatable procedure | User Windows acceptance and recorded results; merge/release only after checks and review |

A feature being implemented does not mean its packaged Windows behavior has been accepted. Do not mark this milestone complete until the remaining gates have evidence.

## Windows acceptance drill (use disposable notes first)

1. Download the current successful CI installer plus SHA256SUMS. Check `Get-FileHash <installer> -Algorithm SHA256` against the checksum. Close every old NOU instance before upgrading. Keep a verified pre-upgrade copy.
2. Launch offline. Confirm existing pages, hierarchy, search and Trash. Create a rich note with headings, bold, nested lists, a checked item, a table and Unicode; restart and verify. Convert a disposable legacy note and confirm the original text remains available.
3. Export that note to TXT, Markdown, HTML and Recovery JSON using new filenames. Inspect the text exports; HTML should open without loading remote resources. Import the JSON and review its preview. Confirm a new page appears, the original is unchanged, formatting survives and search finds the imported text. Restart again.
4. Choose a separate physical backup destination and create/verify a package. Confirm the complete manifest/database pair exists there. Another folder/partition on the same disk does not meet this requirement.
5. Perform the A/B/C restore-and-rollback drill in BACKUP-RESTORE.md. Verify after restart. Repeat verification using a second disposable Windows profile or device, with the source PC/profile unavailable. Do not use a destructive live-profile drill.
6. Export a password-encrypted `.noubackup` using a long unique passphrase. Store the passphrase separately. Test a wrong passphrase: no preview or replacement should happen. Test the correct passphrase: inspect the verified staged preview, then use the normal RESTORE confirmation in the disposable profile and verify content. Preserve the source encrypted file.
7. Enable weekly backups with automatic cleanup off. The first due copy should appear within a minute. Confirm status, path and version inventory. Reopen NOU: there should be no duplicate catch-up within seven days. For an accelerated test, use a disposable profile with its schedule's `last_success.at` set over seven days in the past while NOU is closed; preserve settings before editing.
8. While a disposable schedule is due, unplug the destination. Confirm a visible failure and unchanged last-success time. Reconnect; an open app retries after 15 minutes. No fallback package should be silently created in the profile. An overdue period should create one catch-up version, not one per missed week.
9. Install the Windows background task in Backups & restore. Close NOU; in Task Scheduler run `ProjectNOU-Backup-<your SID>` manually on a due disposable schedule. Check its last result and reopen NOU to verify the new backup. Check sign-in and sleep/wake catch-up. Remove/reinstall the task and verify both actions. It runs only while the configured user is signed in; it cannot run on a powered-off PC or unlock an encrypted drive.
10. Review manual retention. Enable automatic cleanup only after confirming the policy. With disposable older versions, verify at least three valid versions, all versions under seven days, invalid packages and local rollback copies survive. A failed backup must not trigger deletion.
11. Exercise keyboard navigation, Chinese/Japanese input, long notes, block dragging, undo/redo, exports with non-ASCII filenames, low-space errors and recovery controls. Test normal close and reload protection. Existing failure-injection tests cover the state handling; real WebView prompts and disk-full behavior need host testing.
12. Record Windows version, app version, commit, destination arrangement and pass/fail for each step. Never record passwords or private note contents in GitHub. Resolve failures before approving the milestone.

## Signed release procedure

A trusted signing certificate/provider and accessible private key are external prerequisites. Do not invent a certificate or describe an unsigned installer as signed. The helper supports an existing certificate in `Cert:\CurrentUser\My`; hardware/cloud providers may need their own supported signing command.

From a trusted Windows checkout with the normal build prerequisites:

```powershell
./tools/Build-SignedRelease.ps1 -CertificateThumbprint '<your certificate thumbprint>'
```

The helper runs checks, generates icons, applies a temporary ignored signing override, packages NSIS, then requires a valid matching Authenticode signature and timestamp on both application and installer. It writes installer SHA256SUMS. It does not upload/publish the result or bypass Windows acceptance. Certificate files/private keys must not be committed. See the official Tauri Windows signing documentation: https://v2.tauri.app/distribute/sign/windows/.

Unsigned CI builds remain clearly labelled test artifacts. Upgrades are manual: preserve a backup, close NOU, verify the new installer/hash/signature as applicable, install, then run the smoke checks. Do not use uninstall options that erase the profile. There is no automatic updater in this milestone.
