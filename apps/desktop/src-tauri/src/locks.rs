//! Password locks for individual notes.
//!
//! A locked note's content (every Yjs update and snapshot) is stored as AES-256-GCM ciphertext. The key comes from the person's password through
//! Argon2id (a per-lock random salt, parameters stored with the lock). Nothing that could recover the password is stored; a forgotten password
//! cannot be recovered. While locked the note's text is also removed from the search index, its links are not indexed, and the local API refuses to read it.
//!
//! NOT protected: the page title, tags, the page tree position, and files attached to the note (they live in the separate Files store, unencrypted).
//! Unlocking keeps the key in memory only until the person locks again or the app closes.
use aes_gcm::{aead::{rand_core::RngCore, Aead, KeyInit, OsRng, Payload}, Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
use tauri::State;
use zeroize::Zeroizing;

use crate::{editor, Db};

const FORMAT: u8 = 1;
const CHECK: &[u8] = b"nou-lock-v1";
pub const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_BYTES: usize = 1024;
pub const LOCKED: &str = "This note is locked. Unlock it to continue.";
pub const WRONG_PASSWORD: &str = "That password is not right.";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Kdf { pub m: u32, pub t: u32, pub p: u32 }
/// Same cost as encrypted backups. Stored per lock, so it can be raised later without breaking existing locks.
pub const KDF: Kdf = Kdf { m: 65536, t: 3, p: 1 };

type Key = Zeroizing<[u8; 32]>;

fn e(error: rusqlite::Error) -> String { error.to_string() }

pub fn derive(password: &str, salt: &[u8], kdf: Kdf) -> Result<Key, String> {
    if password.is_empty() || password.len() > MAX_PASSWORD_BYTES { return Err("Enter a password of at most 1024 bytes".into()); }
    let mut key = Zeroizing::new([0u8; 32]);
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(|e| e.to_string())?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password_into(password.as_bytes(), salt, key.as_mut()).map_err(|e| e.to_string())?;
    Ok(key)
}
fn check_new_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_CHARS { return Err(format!("Use a password of at least {MIN_PASSWORD_CHARS} characters")); }
    if password.len() > MAX_PASSWORD_BYTES { return Err("Use a password of at most 1024 bytes".into()); }
    Ok(())
}
/// `[format][12-byte nonce][ciphertext+tag]`. The page id and position are authenticated, so blobs cannot be swapped between notes or places.
fn seal(key: &Key, page: &str, slot: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "Invalid key")?;
    let mut nonce = [0u8; 12]; OsRng.fill_bytes(&mut nonce);
    let aad = format!("nou-lock-v1|{page}|{slot}");
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad: aad.as_bytes() }).map_err(|_| "Encryption failed")?;
    let mut out = vec![FORMAT]; out.extend(nonce); out.extend(ct);
    Ok(out)
}
fn unseal(key: &Key, page: &str, slot: &str, blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < 1 + 12 + 16 || blob[0] != FORMAT { return Err("This note's stored data is not in a locked format".into()); }
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "Invalid key")?;
    let aad = format!("nou-lock-v1|{page}|{slot}");
    cipher.decrypt(Nonce::from_slice(&blob[1..13]), Payload { msg: &blob[13..], aad: aad.as_bytes() }).map_err(|_| WRONG_PASSWORD.to_string())
}

pub struct LockRow { pub salt: Vec<u8>, pub kdf: Kdf, pub check: Vec<u8> }
pub fn lock_row(c: &Connection, page: &str) -> Result<Option<LockRow>, String> {
    c.query_row("SELECT salt,kdf_m,kdf_t,kdf_p,check_blob FROM page_locks WHERE page_id=?1", [page],
        |r| Ok(LockRow { salt: r.get(0)?, kdf: Kdf { m: r.get(1)?, t: r.get(2)?, p: r.get(3)? }, check: r.get(4)? })).optional().map_err(e)
}
pub fn is_locked(c: &Connection, page: &str) -> Result<bool, String> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM page_locks WHERE page_id=?1)", [page], |r| r.get(0)).map_err(e)
}
pub fn locked_pages(c: &Connection) -> Result<Vec<String>, String> {
    let mut s = c.prepare("SELECT page_id FROM page_locks ORDER BY page_id").map_err(e)?;
    let it = s.query_map([], |r| r.get(0)).map_err(e)?;
    it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}
/// Is this the right password for the lock? Returns the key when it is.
pub fn verify(row: &LockRow, page: &str, password: &str) -> Result<Key, String> {
    let key = derive(password, &row.salt, row.kdf)?;
    let plain = unseal(&key, page, "check", &row.check)?;
    if plain != CHECK { return Err(WRONG_PASSWORD.into()); }
    Ok(key)
}

// ---- in-memory unlocked keys, with a short delay after repeated wrong passwords ----
struct Open { salt: Vec<u8>, key: Key }
#[derive(Default)]
pub struct Locks { open: Mutex<HashMap<String, Open>>, failures: Mutex<HashMap<String, (u32, Instant)>> }
impl Locks {
    fn remember(&self, page: &str, salt: Vec<u8>, key: Key) { if let Ok(mut m) = self.open.lock() { m.insert(page.to_string(), Open { salt, key }); } }
    pub fn forget(&self, page: &str) { if let Ok(mut m) = self.open.lock() { m.remove(page); } }
    /// The key, only if it was derived for the lock that is stored now (a restore may have replaced the lock).
    pub fn key_for(&self, c: &Connection, page: &str) -> Result<Key, String> {
        let row = lock_row(c, page)?.ok_or("This note is not locked")?;
        let m = self.open.lock().map_err(|_| "Lock state poisoned")?;
        match m.get(page) { Some(o) if o.salt == row.salt => Ok(Zeroizing::new(*o.key)), _ => Err(LOCKED.into()) }
    }
    pub fn is_open(&self, c: &Connection, page: &str) -> bool { self.key_for(c, page).is_ok() }
    fn throttle(&self, page: &str) -> Result<(), String> {
        let m = self.failures.lock().map_err(|_| "Lock state poisoned")?;
        if let Some((n, at)) = m.get(page) {
            if *n >= 5 {
                let wait = Duration::from_secs((1u64 << (*n - 5).min(8)).min(300));
                if at.elapsed() < wait { return Err(format!("Too many wrong passwords. Wait {} seconds and try again.", (wait - at.elapsed()).as_secs() + 1)); }
            }
        }
        Ok(())
    }
    fn failed(&self, page: &str) { if let Ok(mut m) = self.failures.lock() { let n = m.get(page).map_or(0, |x| x.0) + 1; m.insert(page.to_string(), (n, Instant::now())); } }
    fn succeeded(&self, page: &str) { if let Ok(mut m) = self.failures.lock() { m.remove(page); } }
}

// ---- reading and writing a locked note ----
fn rows(c: &Connection, page: &str) -> Result<(Option<Vec<u8>>, Vec<(i64, Vec<u8>)>), String> {
    let snapshot = c.query_row("SELECT snapshot_bytes FROM yjs_snapshots WHERE page_id=?1", [page], |r| r.get::<_, Vec<u8>>(0)).optional().map_err(e)?;
    let mut s = c.prepare("SELECT seq,update_bytes FROM yjs_updates WHERE page_id=?1 ORDER BY seq").map_err(e)?;
    let list = s.query_map([page], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    Ok((snapshot, list))
}
/// A locked note, decrypted for the editor. The caller must hold the key.
pub fn load(c: &Connection, page: &str, epoch: u64, key: &Key) -> Result<editor::Note, String> {
    let mut note = editor::load_raw(c, page, epoch)?;
    let (snapshot, list) = rows(c, page)?;
    let mut updates = Vec::new();
    if let Some(s) = snapshot { updates.push(unseal(key, page, "snapshot", &s)?); }
    for (seq, bytes) in list { updates.push(unseal(key, page, &seq.to_string(), &bytes)?); }
    note.updates = updates;
    Ok(note)
}
/// Save into a locked note: like `editor::append_with_files`, but the update is encrypted and no text is added to the search index.
pub fn append(c: &mut Connection, page: &str, update: &[u8], format: &str, files: Option<&[String]>, key: &Key) -> Result<i64, String> {
    if update.is_empty() || update.len() > 8 * 1024 * 1024 { return Err("Note exceeds the supported save size; copy your content before leaving".into()); }
    let tx = c.transaction().map_err(e)?;
    tx.query_row("SELECT 1 FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL", [page], |r| r.get::<_, i64>(0)).map_err(|_| "Note not found".to_string())?;
    let current: String = tx.query_row("SELECT format FROM note_formats WHERE page_id=?1", [page], |r| r.get(0)).optional().map_err(e)?.unwrap_or("text-v1".into());
    if current != format { return Err("Editor format changed; reopen this note".into()); }
    let seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq),0) FROM yjs_updates WHERE page_id=?1", [page], |r| r.get(0)).map_err(e)?;
    let sealed = seal(key, page, &(seq + 1).to_string(), update)?;
    tx.execute("INSERT INTO yjs_updates(page_id,seq,update_bytes) VALUES (?1,?2,?3)", params![page, seq + 1, sealed]).map_err(e)?;
    tx.execute("UPDATE pages SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [page]).map_err(e)?;
    if let Some(files) = files {
        tx.execute("DELETE FROM note_files WHERE page_id=?1", [page]).map_err(e)?;
        for id in files { tx.execute("INSERT OR IGNORE INTO note_files(page_id,file_id) VALUES(?1,?2)", params![page, id]).map_err(e)?; }
    }
    tx.commit().map_err(e)?;
    Ok(seq + 1)
}

/// Re-encrypt (or encrypt) every stored piece of a note: `from` None means it is stored in the clear, `to` None means store it in the clear.
fn transform(tx: &rusqlite::Transaction<'_>, page: &str, from: Option<&Key>, to: Option<&Key>) -> Result<(), String> {
    let (snapshot, list) = rows(tx, page)?;
    let convert = |slot: &str, bytes: &[u8]| -> Result<Vec<u8>, String> {
        let plain = match from { Some(k) => unseal(k, page, slot, bytes)?, None => bytes.to_vec() };
        match to { Some(k) => seal(k, page, slot, &plain), None => Ok(plain) }
    };
    if let Some(s) = snapshot { tx.execute("UPDATE yjs_snapshots SET snapshot_bytes=?2 WHERE page_id=?1", params![page, convert("snapshot", &s)?]).map_err(e)?; }
    for (seq, bytes) in list { tx.execute("UPDATE yjs_updates SET update_bytes=?3 WHERE page_id=?1 AND seq=?2", params![page, seq, convert(&seq.to_string(), &bytes)?]).map_err(e)?; }
    Ok(())
}
fn bump(tx: &rusqlite::Transaction<'_>, page: &str) -> Result<(), String> {
    tx.execute("UPDATE pages SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [page]).map_err(e)?;
    Ok(())
}
fn reset_search(tx: &rusqlite::Transaction<'_>, page: &str, body: &str) -> Result<(), String> {
    let title: String = tx.query_row("SELECT title FROM pages WHERE id=?1", [page], |r| r.get(0)).map_err(e)?;
    tx.execute("DELETE FROM page_search WHERE page_id=?1", [page]).map_err(e)?;
    tx.execute("INSERT INTO page_search(page_id,title,body) VALUES (?1,?2,?3)", params![page, title, body]).map_err(e)?;
    Ok(())
}

/// Lock a note that is stored in the clear. Everything happens in one transaction: a failure leaves the note exactly as it was.
pub fn set_lock(c: &mut Connection, page: &str, salt: &[u8], kdf: Kdf, key: &Key) -> Result<(), String> {
    let tx = c.transaction().map_err(e)?;
    tx.query_row("SELECT 1 FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL", [page], |r| r.get::<_, i64>(0)).map_err(|_| "Note not found".to_string())?;
    if is_locked(&tx, page)? { return Err("This note is already locked".into()); }
    let format: Option<(String, String)> = tx.query_row("SELECT format,legacy_text FROM note_formats WHERE page_id=?1", [page], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?;
    match format {
        None => return Err("This is an old plain-text note. Open it and convert it to rich text first, then lock it.".into()),
        Some((_, legacy)) if !legacy.is_empty() => return Err("This note keeps a plain copy of the old text it was converted from, so it cannot be locked yet.".into()),
        _ => {}
    }
    transform(&tx, page, None, Some(key))?;
    tx.execute("INSERT INTO page_locks(page_id,salt,kdf_m,kdf_t,kdf_p,check_blob) VALUES(?1,?2,?3,?4,?5,?6)", params![page, salt, kdf.m, kdf.t, kdf.p, seal(key, page, "check", CHECK)?]).map_err(e)?;
    reset_search(&tx, page, "")?;
    // What the note links to is derived from its text; drop it while locked.
    tx.execute("DELETE FROM page_links WHERE source_id=?1", [page]).map_err(e)?;
    tx.execute("DELETE FROM linked_todo_refs WHERE page_id=?1", [page]).map_err(e)?;
    bump(&tx, page)?;
    tx.commit().map_err(e)
}
/// Take the lock off: decrypt everything back, restore the search text (the editor supplies it) and delete the lock.
pub fn remove_lock(c: &mut Connection, page: &str, key: &Key, plain_text: &str) -> Result<(), String> {
    if plain_text.len() > 5_000_000 { return Err("Note exceeds the supported size".into()); }
    let tx = c.transaction().map_err(e)?;
    if !is_locked(&tx, page)? { return Err("This note is not locked".into()); }
    transform(&tx, page, Some(key), None)?;
    tx.execute("DELETE FROM page_locks WHERE page_id=?1", [page]).map_err(e)?;
    reset_search(&tx, page, plain_text)?;
    bump(&tx, page)?;
    tx.commit().map_err(e)
}
pub fn change_password(c: &mut Connection, page: &str, old: &Key, salt: &[u8], kdf: Kdf, new: &Key) -> Result<(), String> {
    let tx = c.transaction().map_err(e)?;
    if !is_locked(&tx, page)? { return Err("This note is not locked".into()); }
    transform(&tx, page, Some(old), Some(new))?;
    tx.execute("UPDATE page_locks SET salt=?2,kdf_m=?3,kdf_t=?4,kdf_p=?5,check_blob=?6 WHERE page_id=?1", params![page, salt, kdf.m, kdf.t, kdf.p, seal(new, page, "check", CHECK)?]).map_err(e)?;
    bump(&tx, page)?;
    tx.commit().map_err(e)
}

// ---- commands ----
#[derive(Serialize)]
pub struct State_ { pub locked: bool, pub open: bool }

#[tauri::command]
pub fn list_locked_pages(db: State<'_, Db>) -> Result<Vec<String>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    locked_pages(&c)
}
#[tauri::command]
pub fn lock_state(db: State<'_, Db>, locks: State<'_, Locks>, page_id: String) -> Result<State_, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    Ok(State_ { locked: is_locked(&c, &page_id)?, open: locks.is_open(&c, &page_id) })
}
#[tauri::command]
pub fn lock_set(db: State<'_, Db>, locks: State<'_, Locks>, page_id: String, password: String) -> Result<(), String> {
    let password = Zeroizing::new(password);
    check_new_password(&password)?;
    db.writable()?;
    let mut salt = [0u8; 16]; OsRng.fill_bytes(&mut salt);
    let key = derive(&password, &salt, KDF)?; // slow on purpose, done before taking the database
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    set_lock(&mut c, &page_id, &salt, KDF, &key)?;
    locks.remember(&page_id, salt.to_vec(), key); // the note stays open for this session
    Ok(())
}
#[tauri::command]
pub fn lock_unlock(db: State<'_, Db>, locks: State<'_, Locks>, page_id: String, password: String) -> Result<(), String> {
    let password = Zeroizing::new(password);
    let row = { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; lock_row(&c, &page_id)?.ok_or("This note is not locked")? };
    locks.throttle(&page_id)?;
    match verify(&row, &page_id, &password) {
        Ok(key) => { locks.succeeded(&page_id); locks.remember(&page_id, row.salt, key); Ok(()) }
        Err(m) => { if m == WRONG_PASSWORD { locks.failed(&page_id); } Err(m) }
    }
}
#[tauri::command]
pub fn lock_relock(locks: State<'_, Locks>, page_id: String) -> Result<(), String> { locks.forget(&page_id); Ok(()) }
#[tauri::command]
pub fn lock_change_password(db: State<'_, Db>, locks: State<'_, Locks>, page_id: String, old_password: String, new_password: String) -> Result<(), String> {
    let (old_password, new_password) = (Zeroizing::new(old_password), Zeroizing::new(new_password));
    check_new_password(&new_password)?;
    db.writable()?;
    let row = { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; lock_row(&c, &page_id)?.ok_or("This note is not locked")? };
    locks.throttle(&page_id)?;
    let old = verify(&row, &page_id, &old_password).inspect_err(|m| { if m == WRONG_PASSWORD { locks.failed(&page_id); } })?;
    locks.succeeded(&page_id);
    let mut salt = [0u8; 16]; OsRng.fill_bytes(&mut salt);
    let new = derive(&new_password, &salt, KDF)?;
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    change_password(&mut c, &page_id, &old, &salt, KDF, &new)?;
    locks.remember(&page_id, salt.to_vec(), new);
    Ok(())
}
#[tauri::command]
pub fn lock_remove(db: State<'_, Db>, locks: State<'_, Locks>, page_id: String, password: String, plain_text: String) -> Result<(), String> {
    let password = Zeroizing::new(password);
    db.writable()?;
    let row = { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; lock_row(&c, &page_id)?.ok_or("This note is not locked")? };
    locks.throttle(&page_id)?;
    let key = verify(&row, &page_id, &password).inspect_err(|m| { if m == WRONG_PASSWORD { locks.failed(&page_id); } })?;
    locks.succeeded(&page_id);
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    remove_lock(&mut c, &page_id, &key, &plain_text)?;
    locks.forget(&page_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const CHEAP: Kdf = Kdf { m: 8192, t: 1, p: 1 };
    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        editor::upgrade(&c).unwrap();
        c
    }
    /// A rich note with three updates, a search row with text, and a link.
    fn note(c: &mut Connection, id: &str, title: &str) {
        let tx = c.transaction().unwrap();
        tx.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES(?1,'personal',?2,?1)", params![id, title]).unwrap();
        tx.execute("INSERT INTO page_search(page_id,title,body) VALUES(?1,?2,'')", params![id, title]).unwrap();
        editor::initialize_rich(&tx, id, b"first update").unwrap();
        tx.commit().unwrap();
        editor::append(c, id, b"second update", "secret zebra text", "blocknote-v1", None).unwrap();
        editor::append(c, id, b"third update", "secret zebra text more", "blocknote-v1", None).unwrap();
    }
    fn lock(c: &mut Connection, id: &str, password: &str) -> Key {
        let salt = [7u8; 16];
        let key = derive(password, &salt, CHEAP).unwrap();
        set_lock(c, id, &salt, CHEAP, &key).unwrap();
        key
    }
    fn stored(c: &Connection, id: &str) -> Vec<Vec<u8>> { c.prepare("SELECT update_bytes FROM yjs_updates WHERE page_id=?1 ORDER BY seq").unwrap().query_map([id], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect() }
    fn body(c: &Connection, id: &str) -> String { c.query_row("SELECT body FROM page_search WHERE page_id=?1", [id], |r| r.get(0)).unwrap() }

    #[test]
    fn locking_encrypts_every_update_and_removes_the_text_from_search() {
        let mut c = fresh(); note(&mut c, "p", "Diary");
        assert_eq!(body(&c, "p"), "secret zebra text more");
        let key = lock(&mut c, "p", "correct horse");
        for blob in stored(&c, "p") {
            assert_eq!(blob[0], FORMAT);
            assert!(!String::from_utf8_lossy(&blob).contains("update"), "plain bytes must not appear in the stored blob");
        }
        assert_eq!(body(&c, "p"), "", "the search text is gone");
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM page_search WHERE page_search MATCH 'zebra'", [], |r| r.get(0)).unwrap(), 0);
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM page_search WHERE page_search MATCH 'Diary'", [], |r| r.get(0)).unwrap(), 1, "the title stays searchable");
        let loaded = load(&c, "p", 0, &key).unwrap();
        assert_eq!(loaded.updates, vec![b"first update".to_vec(), b"second update".to_vec(), b"third update".to_vec()]);
        assert!(is_locked(&c, "p").unwrap());
    }
    #[test]
    fn the_plain_loader_and_saver_refuse_a_locked_note() {
        let mut c = fresh(); note(&mut c, "p", "Diary"); lock(&mut c, "p", "correct horse");
        assert_eq!(editor::load(&c, "p", 0).unwrap_err(), LOCKED);
        assert_eq!(editor::append(&mut c, "p", b"x", "t", "blocknote-v1", None).unwrap_err(), LOCKED);
    }
    #[test]
    fn a_wrong_password_never_gives_a_key_and_the_right_one_does() {
        let mut c = fresh(); note(&mut c, "p", "Diary"); lock(&mut c, "p", "correct horse");
        let row = lock_row(&c, "p").unwrap().unwrap();
        assert_eq!(verify(&row, "p", "wrong horse").err().unwrap(), WRONG_PASSWORD);
        assert_eq!(verify(&row, "p", "").err().is_some(), true);
        assert!(verify(&row, "p", "correct horse").is_ok());
        assert_eq!(verify(&row, "other-page", "correct horse").err().unwrap(), WRONG_PASSWORD, "the check is bound to the page");
    }
    #[test]
    fn saving_into_a_locked_note_stores_ciphertext_and_keeps_it_out_of_search() {
        let mut c = fresh(); note(&mut c, "p", "Diary"); let key = lock(&mut c, "p", "correct horse");
        let seq = append(&mut c, "p", b"fourth update with a secret", "blocknote-v1", Some(&[]), &key).unwrap();
        assert_eq!(seq, 4);
        assert!(!String::from_utf8_lossy(&stored(&c, "p")[3]).contains("secret"));
        assert_eq!(body(&c, "p"), "");
        assert_eq!(load(&c, "p", 0, &key).unwrap().updates.last().unwrap(), b"fourth update with a secret");
        let other = derive("another password", &[9u8; 16], CHEAP).unwrap();
        assert!(load(&c, "p", 0, &other).is_err(), "the wrong key cannot read it");
    }
    #[test]
    fn ciphertext_cannot_be_moved_between_notes_or_positions() {
        let mut c = fresh(); note(&mut c, "a", "A"); note(&mut c, "b", "B");
        let ka = lock(&mut c, "a", "password one"); let kb = lock(&mut c, "b", "password one");
        let blob = stored(&c, "a")[0].clone();
        assert!(unseal(&ka, "b", "1", &blob).is_err(), "a blob for note a does not open as note b, even with the same password");
        assert!(unseal(&ka, "a", "2", &blob).is_err(), "nor at another position");
        assert!(unseal(&kb, "b", "1", &blob).is_err());
    }
    #[test]
    fn unlocking_for_good_restores_the_note_and_its_search_text() {
        let mut c = fresh(); note(&mut c, "p", "Diary"); let key = lock(&mut c, "p", "correct horse");
        remove_lock(&mut c, "p", &key, "secret zebra text more").unwrap();
        assert!(!is_locked(&c, "p").unwrap());
        assert_eq!(stored(&c, "p"), vec![b"first update".to_vec(), b"second update".to_vec(), b"third update".to_vec()]);
        assert_eq!(body(&c, "p"), "secret zebra text more");
        assert_eq!(editor::load(&c, "p", 0).unwrap().updates.len(), 3);
        assert!(remove_lock(&mut c, "p", &key, "").is_err(), "not locked any more");
    }
    #[test]
    fn changing_the_password_re_encrypts_with_a_new_key() {
        let mut c = fresh(); note(&mut c, "p", "Diary"); let old = lock(&mut c, "p", "correct horse");
        let new_salt = [3u8; 16]; let new = derive("battery staple", &new_salt, CHEAP).unwrap();
        change_password(&mut c, "p", &old, &new_salt, CHEAP, &new).unwrap();
        assert!(load(&c, "p", 0, &old).is_err());
        assert_eq!(load(&c, "p", 0, &new).unwrap().updates.len(), 3);
        let row = lock_row(&c, "p").unwrap().unwrap();
        assert!(verify(&row, "p", "correct horse").is_err()); assert!(verify(&row, "p", "battery staple").is_ok());
    }
    #[test]
    fn a_failed_lock_changes_nothing() {
        let mut c = fresh(); note(&mut c, "p", "Diary");
        let key = derive("correct horse", &[7u8; 16], CHEAP).unwrap();
        // corrupt one row so encrypting cannot complete? Instead: an unknown page and an already locked page are refused untouched.
        assert!(set_lock(&mut c, "missing", &[7u8; 16], CHEAP, &key).is_err());
        set_lock(&mut c, "p", &[7u8; 16], CHEAP, &key).unwrap();
        let before = stored(&c, "p");
        assert!(set_lock(&mut c, "p", &[1u8; 16], CHEAP, &key).is_err());
        assert_eq!(stored(&c, "p"), before);
    }
    #[test]
    fn plain_text_notes_and_notes_with_a_legacy_copy_cannot_be_locked() {
        let mut c = fresh();
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES('old','personal','Old','1')", []).unwrap();
        c.execute("INSERT INTO yjs_updates(page_id,seq,update_bytes) VALUES('old',1,x'01')", []).unwrap();
        let key = derive("correct horse", &[7u8; 16], CHEAP).unwrap();
        assert!(set_lock(&mut c, "old", &[7u8; 16], CHEAP, &key).unwrap_err().contains("convert"));
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES('conv','personal','Conv','2')", []).unwrap();
        c.execute("INSERT INTO note_formats(page_id,format,legacy_text) VALUES('conv','blocknote-v1','the original text')", []).unwrap();
        c.execute("INSERT INTO yjs_updates(page_id,seq,update_bytes) VALUES('conv',1,x'01')", []).unwrap();
        assert!(set_lock(&mut c, "conv", &[7u8; 16], CHEAP, &key).unwrap_err().contains("plain copy"));
        assert!(!is_locked(&c, "conv").unwrap());
    }
    #[test]
    fn locking_drops_links_and_linked_todo_refs_and_deleting_the_page_removes_the_lock() {
        let mut c = fresh(); note(&mut c, "p", "Diary"); note(&mut c, "q", "Other");
        c.execute("INSERT INTO page_links(source_id,target_id) VALUES('p','q')", []).unwrap();
        c.execute("INSERT INTO linked_todos(id,text) VALUES('todo-12345678','x')", []).unwrap();
        c.execute("INSERT INTO linked_todo_refs(todo_id,page_id) VALUES('todo-12345678','p')", []).unwrap();
        lock(&mut c, "p", "correct horse");
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM page_links", [], |r| r.get(0)).unwrap(), 0);
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM linked_todo_refs", [], |r| r.get(0)).unwrap(), 0);
        c.execute("DELETE FROM pages WHERE id='p'", []).unwrap();
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM page_locks", [], |r| r.get(0)).unwrap(), 0);
    }
    #[test]
    fn password_rules_and_the_unlocked_key_is_tied_to_the_stored_lock() {
        assert!(check_new_password("short").is_err()); assert!(check_new_password("long enough").is_ok());
        assert!(check_new_password(&"x".repeat(1025)).is_err());
        let mut c = fresh(); note(&mut c, "p", "Diary"); let key = lock(&mut c, "p", "correct horse");
        let locks = Locks::default();
        assert!(locks.key_for(&c, "p").is_err());
        locks.remember("p", vec![7u8; 16], key);
        assert!(locks.is_open(&c, "p"));
        locks.forget("p"); assert!(!locks.is_open(&c, "p"));
        // a key remembered for a different lock (for example before a restore) is not accepted
        locks.remember("p", vec![1u8; 16], derive("x password", &[1u8; 16], CHEAP).unwrap());
        assert!(!locks.is_open(&c, "p"));
    }
    #[test]
    fn repeated_wrong_passwords_slow_further_guesses() {
        let locks = Locks::default();
        for _ in 0..4 { locks.failed("p"); }
        assert!(locks.throttle("p").is_ok());
        locks.failed("p");
        assert!(locks.throttle("p").unwrap_err().contains("Wait"));
        locks.succeeded("p");
        assert!(locks.throttle("p").is_ok());
    }
    #[test]
    fn a_locked_note_does_not_index_its_links_or_linked_todos_when_saved_by_the_editor() {
        let mut c = fresh(); note(&mut c, "p", "Diary"); note(&mut c, "q", "Other");
        c.execute("INSERT INTO linked_todos(id,text) VALUES('todo-12345678','x')", []).unwrap();
        lock(&mut c, "p", "correct horse");
        let tx = c.transaction().unwrap();
        assert_eq!(crate::links::replace_links(&tx, "p", &["q".to_string()]).unwrap(), 0);
        assert_eq!(crate::todos::replace_refs(&tx, "p", &["todo-12345678".to_string()]).unwrap(), 0);
        tx.commit().unwrap();
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM page_links", [], |r| r.get(0)).unwrap(), 0);
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM linked_todo_refs", [], |r| r.get(0)).unwrap(), 0);
        // an unlocked note still indexes normally
        let tx = c.transaction().unwrap();
        assert_eq!(crate::links::replace_links(&tx, "q", &["p".to_string()]).unwrap(), 1);
        tx.commit().unwrap();
    }
}
