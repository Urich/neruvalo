use anyhow::{anyhow, ensure, Result};
use neruvalo_client::normalize_server;
use serde_json::{json, Value};
use std::path::Path;

pub fn pinned_server(args: impl IntoIterator<Item = String>) -> Result<Option<String>> {
    let mut args = args.into_iter();
    let mut server = None;
    while let Some(arg) = args.next() {
        let value = if arg == "--server" {
            Some(
                args.next()
                    .ok_or_else(|| anyhow!("--server requires an address"))?,
            )
        } else {
            arg.strip_prefix("--server=").map(str::to_owned)
        };
        if let Some(value) = value {
            ensure!(server.is_none(), "--server may only be specified once");
            server = Some(normalize_server(&value)?);
        } else {
            return Err(anyhow!("Unknown launch argument"));
        }
    }
    Ok(server)
}
pub fn check_server(pinned: Option<&str>, candidate: &str) -> Result<String> {
    let normalized = normalize_server(candidate)?;
    if let Some(pinned) = pinned {
        ensure!(normalized == pinned, "SERVER_PIN_MISMATCH");
    }
    Ok(normalized)
}
pub fn server_history(path: &Path) -> Result<Vec<String>> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let values: Vec<String> = serde_json::from_slice(&std::fs::read(path)?)?;
    let mut safe = vec![];
    for value in values {
        if let Ok(value) = normalize_server(&value) {
            if !safe.contains(&value) {
                safe.push(value);
            }
        }
    }
    Ok(safe)
}
pub fn remember_server(path: &Path, server: &str) -> Result<()> {
    let server = normalize_server(server)?;
    let mut history = server_history(path)?;
    history.retain(|s| s != &server);
    history.insert(0, server);
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, serde_json::to_vec(&history)?)?;
    std::fs::rename(temp, path)?;
    Ok(())
}
pub fn config(path: &Path, pinned: Option<&str>, error: Option<&str>) -> Result<Value> {
    Ok(json!({"pinned_server": pinned, "startup_error": error,
        "servers": server_history(path)?, "locale": system_locale()}))
}
#[cfg(windows)]
fn system_locale() -> String {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetUserDefaultLocaleName(name: *mut u16, length: i32) -> i32;
    }
    let mut name = [0u16; 85];
    let count = unsafe { GetUserDefaultLocaleName(name.as_mut_ptr(), name.len() as i32) };
    if count > 1 {
        String::from_utf16_lossy(&name[..(count - 1) as usize])
    } else {
        "en".into()
    }
}
#[cfg(not(windows))]
fn system_locale() -> String {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|v| !v.is_empty())
        .unwrap_or_else(|| "en".into())
        .split('.')
        .next()
        .unwrap_or("en")
        .replace('_', "-")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pins_origin_and_rejects_invalid_or_duplicate_arguments() {
        let parse = |args: &[&str]| pinned_server(args.iter().map(|s| s.to_string()));
        assert_eq!(
            parse(&["--server", "https://vault.example/"]).unwrap(),
            Some("https://vault.example".into())
        );
        assert!(parse(&["--server"]).is_err());
        assert!(parse(&["--server=http://remote.example"]).is_err());
        assert!(parse(&["--server=https://a.example", "--server=https://b.example"]).is_err());
        assert!(check_server(Some("https://a.example"), "https://b.example").is_err());
        assert!(check_server(None, "https://user:secret@a.example").is_err());
    }
    #[test]
    fn history_is_recent_deduplicated_and_ignores_unsafe_addresses() {
        let dir = std::env::temp_dir().join(format!("neruvalo-launch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("servers.json");
        std::fs::write(
            &path,
            r#"["https://a.example/","https://bad:secret@b.example","https://a.example"]"#,
        )
        .unwrap();
        remember_server(&path, "https://b.example").unwrap();
        remember_server(&path, "https://a.example").unwrap();
        assert_eq!(
            server_history(&path).unwrap(),
            vec!["https://a.example", "https://b.example"]
        );
        let pinned_config = config(&path, Some("https://a.example"), None).unwrap();
        assert_eq!(pinned_config["pinned_server"], "https://a.example");
        assert!(pinned_config["locale"].is_string());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
