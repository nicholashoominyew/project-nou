//! Embedded pages in a note. An assistant may ASK to add one; the owner approves in the app. This module holds the one rule for which addresses are acceptable:
//! https only, no credentials or odd ports, and a host on the allowlist (claude.ai always; others the owner adds in Settings, kept in `app_settings`).
//! The page applies the same rule again when the request is approved, and again when a block is drawn.
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

pub const DEFAULT_HOSTS: [&str; 1] = ["claude.ai"];
pub const MAX_URL: usize = 2048;
pub const MIN_HEIGHT: i64 = 200;
pub const MAX_HEIGHT: i64 = 1600;
/// The request has to fit the proposals table (65,536 bytes of JSON); quotes and new lines grow when written as JSON, so the page itself is capped lower.
pub const MAX_HTML: usize = 48_000;

/// The host of an acceptable embed address, lower-cased, or why it is not acceptable.
pub fn parse_https_host(url: &str) -> Result<String, String> {
    if url.len() > MAX_URL || url.chars().any(|c| c.is_control() || c.is_whitespace()) { return Err("The address is empty, too long or contains spaces".into()); }
    let rest = url.strip_prefix("https://").ok_or("Only https:// addresses can be embedded")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() { return Err("The address has no host".into()); }
    if authority.contains('@') { return Err("Addresses with a user name or password are not allowed".into()); }
    let host = authority.strip_suffix(":443").unwrap_or(authority).to_ascii_lowercase();
    if host.contains(':') { return Err("Only the standard https port is allowed".into()); }
    if !host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.') || host.starts_with(['.', '-']) || host.ends_with(['.', '-']) || host.contains("..") { return Err("The host name is not valid".into()); }
    if !host.contains('.') || host.bytes().all(|b| b.is_ascii_digit() || b == b'.') { return Err("Use a host name, not an IP address or a local name".into()); }
    Ok(host)
}
/// Is `host` one of the allowed hosts or a subdomain of one? (`claude.ai` allows `x.claude.ai`, never `evilclaude.ai` or `claude.ai.evil.com`.)
pub fn host_allowed(host: &str, allowed: &[String]) -> bool {
    allowed.iter().any(|a| host == a || host.strip_suffix(a.as_str()).is_some_and(|p| p.ends_with('.')))
}
/// Hosts the owner added in Settings (stored as JSON in `app_settings`), plus the built-in ones.
pub fn allowed_hosts(c: &Connection) -> Vec<String> {
    let mut hosts: Vec<String> = DEFAULT_HOSTS.iter().map(|s| s.to_string()).collect();
    let raw: Option<String> = c.query_row("SELECT value FROM app_settings WHERE key='nou-embed-hosts'", [], |r| r.get(0)).optional().ok().flatten();
    if let Some(v) = raw.and_then(|r| serde_json::from_str::<Vec<String>>(&r).ok()) { for h in v.into_iter().take(50) { let h = h.trim().to_ascii_lowercase(); if parse_https_host(&format!("https://{h}/")).is_ok_and(|x| x == h) && !hosts.contains(&h) { hosts.push(h); } } }
    hosts
}
fn text(v: &Value, max: usize) -> bool { v.as_str().is_some_and(|s| s.chars().count() <= max && !s.chars().any(char::is_control)) }

/// Check an assistant's embed request before it is queued. The owner still sees and approves it.
pub fn validate_request(c: &Connection, op: &str, payload: &Value) -> Result<(), String> {
    match op {
        "append_embed" => {
            let url = payload.get("url").and_then(Value::as_str).ok_or("The address is missing")?;
            let host = parse_https_host(url)?;
            if !host_allowed(&host, &allowed_hosts(c)) { return Err(format!("{host} is not on the list of hosts that can be embedded. The owner can add it in Settings, Embedded pages.")); }
            if let Some(t) = payload.get("title") { if !text(t, 200) { return Err("The title must be text of at most 200 characters".into()); } }
            if let Some(h) = payload.get("height") { if !h.as_i64().is_some_and(|n| (MIN_HEIGHT..=MAX_HEIGHT).contains(&n)) { return Err(format!("The height must be a whole number from {MIN_HEIGHT} to {MAX_HEIGHT}")); } }
            Ok(())
        }
        "attach_html" => {
            if !payload.get("title").is_some_and(|t| text(t, 200) && t.as_str().is_some_and(|s| !s.trim().is_empty())) { return Err("A title of 1 to 200 characters is required".into()); }
            let html = payload.get("html").and_then(Value::as_str).ok_or("The page's HTML is missing")?;
            if html.trim().is_empty() || html.len() > MAX_HTML { return Err(format!("The HTML must be present and at most {MAX_HTML} bytes; embed the page by its address instead if it is larger")); }
            if let Some(h) = payload.get("height") { if !h.as_i64().is_some_and(|n| (MIN_HEIGHT..=MAX_HEIGHT).contains(&n)) { return Err(format!("The height must be a whole number from {MIN_HEIGHT} to {MAX_HEIGHT}")); } }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap(); c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap(); c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        crate::editor::upgrade(&c).unwrap(); c
    }
    #[test]
    fn only_plain_https_addresses_with_a_real_host_are_accepted() {
        assert_eq!(parse_https_host("https://Claude.AI/artifact/abc?x=1#y").unwrap(), "claude.ai");
        assert_eq!(parse_https_host("https://claude.ai:443/a").unwrap(), "claude.ai");
        for bad in ["http://claude.ai/a", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "//claude.ai/a", "claude.ai/a", "https://", "https:///a", "https://user:pw@claude.ai/a", "https://claude.ai@evil.com/", "https://claude.ai:8443/a", "https://localhost/a", "https://127.0.0.1/a", "https://10.0.0.1/", "https://[::1]/", "https://claude.ai/a b", "https://claude.ai/a\nb", "https://-bad.example.com/", "https://a..b.com/", "https://exa_mple.com/", &format!("https://claude.ai/{}", "a".repeat(MAX_URL))] { assert!(parse_https_host(bad).is_err(), "{bad:?}"); }
    }
    #[test]
    fn a_host_is_allowed_if_listed_or_a_subdomain_of_a_listed_one_and_nothing_else() {
        let a = vec!["claude.ai".to_string()];
        for ok in ["claude.ai", "www.claude.ai", "a.b.claude.ai"] { assert!(host_allowed(ok, &a), "{ok}"); }
        for no in ["evilclaude.ai", "claude.ai.evil.com", "claude.com", "ai", "notclaude.ai", "claude.aix"] { assert!(!host_allowed(no, &a), "{no}"); }
    }
    #[test]
    fn the_owners_extra_hosts_come_from_the_settings_and_junk_in_them_is_ignored() {
        let c = fresh(); assert_eq!(allowed_hosts(&c), vec!["claude.ai"]);
        c.execute("INSERT INTO app_settings(key,value) VALUES('nou-embed-hosts',?1)", [json!(["Example.com", "  ", "http://bad", "localhost", "claude.ai", "x y.com", "ok.dev"]).to_string()]).unwrap();
        assert_eq!(allowed_hosts(&c), vec!["claude.ai", "example.com", "ok.dev"]);
        c.execute("UPDATE app_settings SET value='not json' WHERE key='nou-embed-hosts'", []).unwrap(); assert_eq!(allowed_hosts(&c), vec!["claude.ai"]);
    }
    #[test]
    fn an_embed_request_needs_an_allowed_https_address_and_sane_fields() {
        let c = fresh();
        assert!(validate_request(&c, "append_embed", &json!({ "url": "https://claude.ai/artifact/abc", "title": "Chart", "height": 600 })).is_ok());
        assert!(validate_request(&c, "append_embed", &json!({ "url": "https://claude.ai/artifact/abc" })).is_ok());
        assert!(validate_request(&c, "append_embed", &json!({ "url": "https://example.com/x" })).unwrap_err().contains("not on the list"));
        for bad in [json!({}), json!({ "url": "http://claude.ai/a" }), json!({ "url": "https://claude.ai/a", "height": 100 }), json!({ "url": "https://claude.ai/a", "height": 5000 }), json!({ "url": "https://claude.ai/a", "height": "tall" }), json!({ "url": "https://claude.ai/a", "title": "a\u{7}b" }), json!({ "url": "https://claude.ai/a", "title": "x".repeat(201) })] { assert!(validate_request(&c, "append_embed", &bad).is_err(), "{bad}"); }
        c.execute("INSERT INTO app_settings(key,value) VALUES('nou-embed-hosts','[\"example.com\"]')", []).unwrap();
        assert!(validate_request(&c, "append_embed", &json!({ "url": "https://docs.example.com/x" })).is_ok(), "a host the owner added, and its subdomains");
    }
    #[test]
    fn an_attach_html_request_needs_a_title_and_a_page_that_fits() {
        let c = fresh();
        assert!(validate_request(&c, "attach_html", &json!({ "title": "Chart", "html": "<p>hi</p>" })).is_ok());
        for bad in [json!({ "html": "<p>x</p>" }), json!({ "title": "  ", "html": "<p>x</p>" }), json!({ "title": "T" }), json!({ "title": "T", "html": "  " }), json!({ "title": "T", "html": "x".repeat(MAX_HTML + 1) }), json!({ "title": "T", "html": "<p>x</p>", "height": 10 })] { assert!(validate_request(&c, "attach_html", &bad).is_err(), "{bad}"); }
        assert!(validate_request(&c, "attach_html", &json!({ "title": "T", "html": "x".repeat(MAX_HTML) })).is_ok());
    }
}
