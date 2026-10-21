//! Versioned, password-portable authenticated Notes backup envelope.
//! Fixed Argon2id parameters prevent attacker-controlled memory/work factors.
use aes_gcm::{aead::{Aead, KeyInit, OsRng, rand_core::RngCore, Payload}, Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use crate::recovery::{self, Manifest, Verified};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}};
use zeroize::Zeroizing;
const MAGIC: &[u8; 8] = b"NOUENC01";
const LIMIT: usize = 64 * 1024 * 1024;
const HEADER: usize = 8 + 16 + 12;
fn key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8;32]>, String> {
    if password.is_empty() || password.len() > 1024 { return Err("Enter a passphrase of at most 1024 bytes".into()); }
    let mut key = Zeroizing::new([0;32]);
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|e| e.to_string())?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password_into(password.as_bytes(), salt, key.as_mut()).map_err(|e| e.to_string())?;
    Ok(key)
}
fn seal(plain: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if password.chars().count() < 12 { return Err("Use a passphrase of at least 12 characters and keep a separate recovery copy".into()); }
    if plain.len() > LIMIT + 16388 { return Err("Encrypted Notes backups currently support databases up to 64 MB".into()); }
    let mut header = [0;HEADER]; header[..8].copy_from_slice(MAGIC); OsRng.fill_bytes(&mut header[8..]);
    let key = key(password, &header[8..24])?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "Invalid encryption key")?;
    let cipher_text = cipher.encrypt(Nonce::from_slice(&header[24..]), Payload { msg: plain, aad: &header }).map_err(|_| "Encryption failed")?;
    let mut output = header.to_vec(); output.extend(cipher_text); Ok(output)
}
fn unseal(bytes: &[u8], password: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    if bytes.len() < HEADER + 16 || bytes.len() > LIMIT + 16440 || &bytes[..8] != MAGIC { return Err("Unsupported, truncated or oversized encrypted backup".into()); }
    let key = key(password, &bytes[8..24])?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "Invalid encryption key")?;
    cipher.decrypt(Nonce::from_slice(&bytes[24..HEADER]), Payload { msg: &bytes[HEADER..], aad: &bytes[..HEADER] }).map(Zeroizing::new).map_err(|_| "Wrong passphrase or damaged encrypted backup; no notes were replaced".into())
}
fn bounded_read(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("Choose a regular encrypted backup file".into()); }
    let mut bytes = Vec::new(); file.take((LIMIT + 16441) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > LIMIT + 16440 { return Err("Encrypted backup exceeds the supported size".into()); }
    Ok(bytes)
}
fn cleanup(dir: &Path) {
    // Only files in the fresh, app-generated staging package are removed; never recursive user paths.
    for name in ["manifest.json", "notes.sqlite3"] { let _ = fs::remove_file(dir.join(name)); }
    let _ = fs::remove_dir(dir);
    if let Some(parent) = dir.parent() { let _ = fs::remove_dir(parent); }
}
#[derive(serde::Serialize)]
pub struct Export { pub path: String, pub sha256: String, pub bytes: u64 }
pub fn export(source: &rusqlite::Connection, data: &Path, target: &Path, password: String) -> Result<Export, String> {
    let password = Zeroizing::new(password);
    if target.extension().and_then(|x| x.to_str()) != Some("noubackup") { return Err("Choose a new .noubackup filename".into()); }
    let staging = data.join("encrypted-export-staging").join(uuid::Uuid::new_v4().to_string());
    let backup = recovery::create(source, &staging)?;
    let dir = PathBuf::from(&backup.path);
    let result = (|| {
        if backup.manifest.bytes > LIMIT as u64 { return Err("Encrypted backup limit is 64 MB; your regular backup remains available".into()); }
        let manifest = serde_json::to_vec(&backup.manifest).map_err(|e| e.to_string())?;
        let mut plain = Zeroizing::new(Vec::new()); plain.extend((manifest.len() as u32).to_le_bytes()); plain.extend(manifest); plain.extend(fs::read(dir.join("notes.sqlite3")).map_err(|e| e.to_string())?);
        let encrypted = seal(&plain, &password)?;
        let mut file = fs::OpenOptions::new().create_new(true).write(true).open(target).map_err(|e| format!("Choose a new filename; existing files are preserved: {e}"))?;
        if let Err(error) = file.write_all(&encrypted).and_then(|_| file.sync_all()) { drop(file); let _ = fs::remove_file(target); return Err(error.to_string()); }
        drop(file);
        // Read from the destination and authenticate/decrypt before reporting success.
        let written = bounded_read(target)?;
        if unseal(&written, &password)?.as_slice() != plain.as_slice() { return Err("Encrypted output verification failed".into()); }
        Ok(Export { path: target.to_string_lossy().into(), sha256: recovery::hash_file(target)?, bytes: written.len() as u64 })
    })();
    cleanup(&dir); result
}
pub fn stage(source: &Path, data: &Path, password: String) -> Result<Verified, String> {
    let password = Zeroizing::new(password);
    let bytes = bounded_read(source)?;
    let plain = unseal(&bytes, &password)?;
    if plain.len() < 4 { return Err("Encrypted payload is incomplete".into()); }
    let n = u32::from_le_bytes(plain[..4].try_into().map_err(|_| "Invalid payload")?) as usize;
    if n > 16384 || plain.len() < 4+n || plain.len()-4-n > LIMIT { return Err("Invalid encrypted payload size".into()); }
    let manifest: Manifest = serde_json::from_slice(&plain[4..4+n]).map_err(|e| e.to_string())?;
    if !manifest.id.starts_with("backup-") || manifest.id.len() > 100 || !manifest.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("Invalid package identifier".into()); }
    let dir = data.join("restore-staging").join(uuid::Uuid::new_v4().to_string()).join(&manifest.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut file = fs::OpenOptions::new().create_new(true).write(true).open(dir.join("notes.sqlite3")).map_err(|e| e.to_string())?;
        file.write_all(&plain[4+n..]).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?; drop(file);
        recovery::write_new_json(&dir.join("manifest.json"), &manifest)?;
        recovery::verify(&dir)
    })();
    if result.is_err() { cleanup(&dir); }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_randomized_encryption_rejects_wrong_password_and_tampering() {
        let a = seal(b"private Notes bytes", "long recovery passphrase").unwrap();
        let b = seal(b"private Notes bytes", "long recovery passphrase").unwrap();
        assert_ne!(a,b); assert_eq!(unseal(&a, "long recovery passphrase").unwrap().as_slice(), b"private Notes bytes");
        assert!(unseal(&a, "different passphrase").is_err());
        let mut changed = a.clone(); changed[30] ^= 1; assert!(unseal(&changed,"long recovery passphrase").is_err());
        changed = a.clone(); changed[HEADER] ^= 1; assert!(unseal(&changed,"long recovery passphrase").is_err());
        assert!(unseal(&a[..HEADER],"long recovery passphrase").is_err()); assert!(seal(b"x","short").is_err());
    }
    #[test]
    fn encrypted_package_can_be_staged_without_modifying_the_source_and_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("nou-encryption-{}",uuid::Uuid::new_v4())); fs::create_dir_all(&dir).unwrap();
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap(); c.execute_batch(include_str!("../../../../db/notes/002_editor_formats.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        let target = dir.join("notes.noubackup");
        export(&c, &dir, &target, "long recovery passphrase".into()).unwrap();
        let before = recovery::hash_file(&target).unwrap();
        assert!(export(&c, &dir, &target, "long recovery passphrase".into()).is_err());
        let staged = stage(&target,&dir,"long recovery passphrase".into()).unwrap(); assert_eq!(staged.pages,0);
        assert_eq!(before,recovery::hash_file(&target).unwrap());
        assert!(stage(&target,&dir,"wrong passphrase".into()).is_err()); drop(c); fs::remove_dir_all(dir).unwrap();
    }
}
