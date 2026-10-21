//! Independent, content-addressed Files store. Immutable blobs; no automatic deletion.
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Serialize, Deserialize};
use sha2::{Digest,Sha256};
use std::{fs,io::Read,path::{Path,PathBuf}};
pub const LIMIT: usize = 20*1024*1024;
const SCHEMA: &str = "CREATE TABLE file_blobs(id TEXT PRIMARY KEY,name TEXT NOT NULL,mime TEXT NOT NULL,data BLOB NOT NULL); PRAGMA user_version=1;";
#[derive(Clone,Debug,Serialize,Deserialize)]
pub struct Info { pub id:String, pub name:String, pub mime:String, pub bytes:usize }
#[derive(Serialize)]
pub struct File { pub info:Info, pub data:Vec<u8> }
pub fn open(data:&Path)->Result<Connection,String>{
 let c=Connection::open(data.join("files.sqlite3")).map_err(|e|e.to_string())?;
 c.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e|e.to_string())?;
 let version:i64=c.query_row("PRAGMA user_version",[],|r|r.get(0)).map_err(|e|e.to_string())?;
 if version==0 { let tables:i64=c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",[],|r|r.get(0)).map_err(|e|e.to_string())?;if tables>0{return Err("Unrecognized Files database; original file preserved".into());}c.execute_batch(SCHEMA).map_err(|e|e.to_string())?; } else if version!=1 { return Err("Unsupported Files database".into()); }
 c.pragma_update(None,"synchronous","FULL").map_err(|e|e.to_string())?; Ok(c)
}
fn mime(bytes:&[u8])->Result<&'static str,String>{
 if bytes.starts_with(b"%PDF-"){Ok("application/pdf")}
 else if bytes.starts_with(b"\x89PNG\r\n\x1a\n"){Ok("image/png")}
 else if bytes.starts_with(&[255,216,255]){Ok("image/jpeg")}
 else if bytes.starts_with(b"GIF87a")||bytes.starts_with(b"GIF89a"){Ok("image/gif")}
 else if bytes.len()>=12 && &bytes[..4]==b"RIFF" && &bytes[8..12]==b"WEBP"{Ok("image/webp")}
 else{Err("Choose a PNG, JPEG, GIF, WebP image or PDF; file content does not match a supported format".into())}
}
fn id(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
fn check_id(value:&str)->Result<(),String>{if value.len()!=64||!value.bytes().all(|b|b.is_ascii_hexdigit()){Err("Invalid file ID".into())}else{Ok(())}}
pub fn insert(c:&Connection,name:&str,data:&[u8])->Result<Info,String>{
 if data.is_empty()||data.len()>LIMIT{return Err("Each image or PDF must be no larger than 20 MB".into());}
 let media=mime(data)?;let hash=id(data);
 c.execute("INSERT OR IGNORE INTO file_blobs(id,name,mime,data) VALUES(?1,?2,?3,?4)",params![hash,name,media,data]).map_err(|e|e.to_string())?;
 Ok(Info{id:hash,name:name.into(),mime:media.into(),bytes:data.len()})
}
pub fn upload(profile:&Path,path:&Path)->Result<Info,String>{
 let file=fs::File::open(path).map_err(|e|e.to_string())?;
 if !file.metadata().map_err(|e|e.to_string())?.is_file(){return Err("Choose a regular file".into());}
 let mut bytes=Vec::new();file.take((LIMIT+1)as u64).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
 insert(&open(profile)?,path.file_name().and_then(|s|s.to_str()).unwrap_or("Upload"),&bytes)
}
pub fn read(profile:&Path,value:&str)->Result<File,String>{
 check_id(value)?; let c=open(profile)?;
 let (name,media,bytes):(String,String,Vec<u8>)=c.query_row("SELECT name,mime,data FROM file_blobs WHERE id=?1",[value],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?.ok_or("File unavailable. Restore a Notes + Files backup.")?;
 if bytes.len()>LIMIT||id(&bytes)!=value||mime(&bytes)?!=media{return Err("File integrity check failed".into());}
 Ok(File{info:Info{id:value.into(),name,mime:media,bytes:bytes.len()},data:bytes})
}
pub fn require(profile:&Path,ids:&[String])->Result<(),String>{let c=open(profile)?;for value in ids{check_id(value)?;let found:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM file_blobs WHERE id=?1)",[value],|r|r.get(0)).map_err(|e|e.to_string())?;if !found{return Err("Missing attachment: restore a Notes + Files backup".into());}}Ok(())}
pub fn source(c:&Connection)->Option<PathBuf>{
 let path:String=c.query_row("SELECT file FROM pragma_database_list WHERE name='main'",[],|r|r.get(0)).ok()?;
 let candidate=Path::new(&path).parent()?.join("files.sqlite3");candidate.is_file().then_some(candidate)
}
pub fn validate(path:&Path)->Result<(),String>{
 if fs::symlink_metadata(path).map_err(|e|e.to_string())?.file_type().is_symlink(){return Err("Files snapshot must not be a link".into());}
 for suffix in ["-wal","-shm","-journal"]{if PathBuf::from(format!("{}{suffix}",path.display())).exists(){return Err("Files snapshot is not standalone".into());}}
 let c=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e|e.to_string())?;
 let ok:String=c.query_row("PRAGMA integrity_check",[],|r|r.get(0)).map_err(|e|e.to_string())?;if ok!="ok"{return Err("Files integrity check failed".into());}
 let expected=Connection::open_in_memory().map_err(|e|e.to_string())?;expected.execute_batch(SCHEMA).map_err(|e|e.to_string())?;
 fn definitions(c:&Connection)->Result<Vec<String>,String>{let mut q=c.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").map_err(|e|e.to_string())?;let rows=q.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;rows.map(|r|r.map(|s|s.split_whitespace().collect::<Vec<_>>().join(" "))).collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())}
 if definitions(&c)?!=definitions(&expected)?{return Err("Unsupported Files schema".into());}
 let mut q=c.prepare("SELECT id,mime,data FROM file_blobs").map_err(|e|e.to_string())?;
 let mut rows=q.query([]).map_err(|e|e.to_string())?;
 while let Some(row)=rows.next().map_err(|e|e.to_string())?{let key:String=row.get(0).map_err(|e|e.to_string())?;let media:String=row.get(1).map_err(|e|e.to_string())?;let bytes:Vec<u8>=row.get(2).map_err(|e|e.to_string())?;if bytes.is_empty()||bytes.len()>LIMIT||id(&bytes)!=key||mime(&bytes)?!=media{return Err("Files content verification failed".into());}}
 Ok(())
}
pub fn snapshot(source:&Path,target:&Path)->Result<(),String>{
 let c=Connection::open_with_flags(source,OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e|e.to_string())?;
 c.execute("VACUUM INTO ?1",[target.to_string_lossy().as_ref()]).map_err(|e|e.to_string())?;
 fs::OpenOptions::new().write(true).open(target).and_then(|f|f.sync_all()).map_err(|e|e.to_string())?;validate(target)
}
/// Add restored immutable blobs before publishing Notes. Preserve newer blobs for rollback.
pub fn merge(source:&Path,profile:&Path)->Result<(),String>{
 validate(source)?;let input=Connection::open_with_flags(source,OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e|e.to_string())?;let mut output=open(profile)?;let tx=output.transaction().map_err(|e|e.to_string())?;
 let mut q=input.prepare("SELECT name,data FROM file_blobs").map_err(|e|e.to_string())?;let mut rows=q.query([]).map_err(|e|e.to_string())?;
 while let Some(r)=rows.next().map_err(|e|e.to_string())?{let name:String=r.get(0).map_err(|e|e.to_string())?;let bytes:Vec<u8>=r.get(1).map_err(|e|e.to_string())?;insert(&tx,&name,&bytes)?;}
 tx.commit().map_err(|e|e.to_string())
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn immutable_files_verify_restore_and_reject_spoofed_uploads(){let dir=std::env::temp_dir().join(format!("nou-files-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&dir).unwrap();let c=open(&dir).unwrap();let a=insert(&c,"a.pdf",b"%PDF-1.7 test").unwrap();assert!(insert(&c,"fake.pdf",b"executable").is_err());drop(c);let snapshot_path=dir.join("copy.sqlite3");snapshot(&dir.join("files.sqlite3"),&snapshot_path).unwrap();validate(&snapshot_path).unwrap();let other=dir.join("other");fs::create_dir(&other).unwrap();merge(&snapshot_path,&other).unwrap();assert_eq!(read(&other,&a.id).unwrap().data,b"%PDF-1.7 test");let c=Connection::open(&snapshot_path).unwrap();c.execute("UPDATE file_blobs SET data=x'01'",[]).unwrap();drop(c);assert!(validate(&snapshot_path).is_err());fs::remove_dir_all(dir).unwrap();}
}

#[derive(Deserialize)]pub struct Imported{pub id:String,pub name:String,pub data:Vec<u8>}
pub fn import_all(profile:&Path,files:&[Imported],required:&[String])->Result<(),String>{
 if files.len()>100||files.iter().map(|f|f.data.len()).sum::<usize>()>LIMIT{return Err("Note transfer files exceed 20 MB; use a complete backup".into());}
 for f in files{if id(&f.data)!=f.id||f.data.is_empty()||f.data.len()>LIMIT{ return Err("Recovery attachment hash/size mismatch".into()); }mime(&f.data)?;}
 let mut c=open(profile)?;let tx=c.transaction().map_err(|e|e.to_string())?;
 for f in files{insert(&tx,&f.name,&f.data)?;}
 for value in required{check_id(value)?;let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM file_blobs WHERE id=?1)",[value],|r|r.get(0)).map_err(|e|e.to_string())?;if !exists{return Err("Recovery file is missing an attachment. Use a complete Notes + Files backup.".into());}}
 tx.commit().map_err(|e|e.to_string())
}
