// Compile and exercise the production portable modules without WebView/GTK dependencies.
#[path = "../../../apps/desktop/src-tauri/src/backup.rs"]
pub mod backup;
#[path = "../../../apps/desktop/src-tauri/src/recovery.rs"]
pub mod recovery;
#[path = "../../../apps/desktop/src-tauri/src/schedule.rs"]
pub mod schedule;
#[path = "../../../apps/desktop/src-tauri/src/encrypted.rs"]
pub mod encrypted;

#[path = "../../../apps/desktop/src-tauri/src/attachments.rs"]
pub mod attachments;
