use crate::{attachments,Db,rebalance};
use rusqlite::{params,Connection,OptionalExtension};
use std::{path::Path,io::Write,fs};
use tauri::{Manager,State};
pub const ICONS:&[&str]=&["document","book","folder","bulb","star","code","briefcase","calendar","flag","home","link","image"];
#[tauri::command]
pub fn set_page_icon(db:State<'_,Db>,page_id:String,icon:String)->Result<(),String>{
 let c=db.0.lock().map_err(|_|"Database lock poisoned")?;db.writable()?;
 if !ICONS.contains(&icon.as_str()){return Err("Choose a monochrome page icon".into());}
 if c.execute("UPDATE pages SET icon=?1,revision=revision+1 WHERE id=?2 AND deleted_at IS NULL",params![icon,page_id]).map_err(|e|e.to_string())?!=1{return Err("Page not found".into());}Ok(())
}
/// Move a whole subtree; destination is root/parent plus an optional next sibling.
pub fn relocate(c:&mut Connection,page:&str,parent:Option<&str>,before:Option<&str>)->Result<(),String>{
 let tx=c.transaction().map_err(|e|e.to_string())?;
 let old:Option<String>=tx.query_row("SELECT parent_id FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL",[page],|r|r.get(0)).optional().map_err(|e|e.to_string())?.ok_or("Page not found")?;
 if parent==Some(page)||before==Some(page){return Err("A page cannot be dropped onto itself".into());}
 if let Some(parent)=parent{
  let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL)",[parent],|r|r.get(0)).map_err(|e|e.to_string())?;
  if !valid{return Err("Destination is missing or in Trash".into());}
  let cycle:bool=tx.query_row("WITH RECURSIVE children(id) AS (SELECT id FROM pages WHERE id=?1 UNION SELECT p.id FROM pages p JOIN children c ON p.parent_id=c.id) SELECT EXISTS(SELECT 1 FROM children WHERE id=?2)",params![page,parent],|r|r.get(0)).map_err(|e|e.to_string())?;
  if cycle{return Err("A page cannot be moved inside its own descendants".into());}
 }
 let mut q=tx.prepare("SELECT id FROM pages WHERE workspace_id='personal' AND parent_id IS ?1 AND deleted_at IS NULL AND id<>?2 ORDER BY sort_key COLLATE BINARY,id").map_err(|e|e.to_string())?;
 let mut ids=q.query_map(params![parent,page],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())?;drop(q);
 let position=if let Some(next)=before{ids.iter().position(|id|id==next).ok_or("Drop position changed; try again")?}else{ids.len()};ids.insert(position,page.into());
 tx.execute("UPDATE pages SET parent_id=?1,sort_key=?2,revision=revision+1 WHERE id=?3",params![parent,format!("~move-{page}"),page]).map_err(|e|e.to_string())?;
 for id in &ids{tx.execute("UPDATE pages SET sort_key=?1 WHERE id=?2",params![format!("~{id}"),id]).map_err(|e|e.to_string())?;}
 for(i,id)in ids.iter().enumerate(){tx.execute("UPDATE pages SET sort_key=?1 WHERE id=?2",params![format!("{:016x}",(i as u64+1)*1024),id]).map_err(|e|e.to_string())?;}
 if old.as_deref()!=parent{rebalance(&tx,old.as_deref())?;}tx.commit().map_err(|e|e.to_string())
}
#[tauri::command]
pub fn relocate_page(db:State<'_,Db>,page_id:String,parent_id:Option<String>,before_id:Option<String>)->Result<(),String>{
 let mut c=db.0.lock().map_err(|_|"Database lock poisoned")?;db.writable()?;relocate(&mut c,&page_id,parent_id.as_deref(),before_id.as_deref())
}
#[tauri::command]
pub async fn upload_attachment(app:tauri::AppHandle,path:String)->Result<attachments::Info,String>{
 tauri::async_runtime::spawn_blocking(move||{let db=app.state::<Db>();let _c=db.0.lock().map_err(|_|"Database lock poisoned")?;db.writable()?;attachments::upload(&app.path().app_data_dir().map_err(|e|e.to_string())?,Path::new(&path))}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn read_attachment(app:tauri::AppHandle,id:String)->Result<attachments::File,String>{
 tauri::async_runtime::spawn_blocking(move||{let db=app.state::<Db>();let _c=db.0.lock().map_err(|_|"Database lock poisoned")?;attachments::read(&app.path().app_data_dir().map_err(|e|e.to_string())?,&id)}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub fn export_attachment(app:tauri::AppHandle,db:State<'_,Db>,id:String,path:String)->Result<(),String>{
 let _c=db.0.lock().map_err(|_|"Database lock poisoned")?;
 let file=attachments::read(&app.path().app_data_dir().map_err(|e|e.to_string())?,&id)?;
 let ext=Path::new(&path).extension().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase();
 let valid=match file.info.mime.as_str(){"application/pdf"=>ext=="pdf","image/png"=>ext=="png","image/jpeg"=>ext=="jpg"||ext=="jpeg","image/gif"=>ext=="gif","image/webp"=>ext=="webp",_=>false};
 if !valid{return Err("Use a filename matching the uploaded image or PDF type".into());}
 let mut out=fs::OpenOptions::new().create_new(true).write(true).open(&path).map_err(|e|format!("Choose a new filename; existing files stay unchanged: {e}"))?;
 let result=out.write_all(&file.data).and_then(|_|out.sync_all()).map_err(|e|e.to_string());drop(out);if result.is_err(){let _=fs::remove_file(path);}result
}
#[tauri::command]
pub fn open_bookmark(url:String)->Result<(),String>{
 if !(url.starts_with("https://")||url.starts_with("http://"))||url.chars().any(|c|c.is_control())||url.len()>4096{return Err("Only HTTP and HTTPS bookmarks can be opened".into());}
 #[cfg(target_os="windows")]{std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler",&url]).spawn().map_err(|e|e.to_string())?;Ok(())}
 #[cfg(not(target_os="windows"))]{Err("Open bookmarks from the Windows application".into())}
}

#[tauri::command]pub fn notes_write_blocked(db:State<'_,Db>)->bool{db.2.load(std::sync::atomic::Ordering::SeqCst)}
