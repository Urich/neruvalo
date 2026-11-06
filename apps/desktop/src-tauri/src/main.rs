#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use anyhow::{anyhow, Result};
use neruvalo_client::{Attachment, Client, RecordData};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use zeroize::Zeroizing;
mod launch;
mod verification;
#[cfg(windows)]
mod windows_lock;
struct Desktop {
    client: Mutex<Client>,
    pinned_server: Option<String>,
    startup_error: Option<String>,
    history_path: PathBuf,
    clipboard_generation: Arc<AtomicU64>,
}
fn text(r: &Value, key: &str) -> Result<String> {
    r.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("Missing {key}"))
}
fn secret(r: &mut Value, key: &str) -> Result<Zeroizing<String>> {
    match r.get_mut(key).map(Value::take) {
        Some(Value::String(s)) => Ok(Zeroizing::new(s)),
        _ => Err(anyhow!("Missing {key}")),
    }
}
#[tauri::command]
async fn command(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Desktop>,
    mut request: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Commands are only available in the main window".into());
    }
    async fn dispatch(app: &tauri::AppHandle, state: &Desktop, r: &mut Value) -> Result<Value> {
        let action = text(r, "action")?;
        if action == "launch_config" {
            let mut config = launch::config(
                &state.history_path,
                state.pinned_server.as_deref(),
                state.startup_error.as_deref(),
            )?;
            let mut servers: Vec<String> = serde_json::from_value(config["servers"].clone())?;
            for profile in state.client.lock().await.profiles().await? {
                if let Some(server) = profile["server"].as_str() {
                    if let Ok(server) = launch::check_server(None, server) {
                        if !servers.contains(&server) {
                            servers.push(server);
                        }
                    }
                }
            }
            config["servers"] = json!(servers);
            return Ok(config);
        }
        if let Some(error) = &state.startup_error {
            anyhow::bail!("Invalid launch configuration: {error}");
        }
        let mut c = state.client.lock().await;
        if matches!(action.as_str(), "create_local" | "restore_local_backup") {
            anyhow::ensure!(c.status()["unlocked"] != true, "LOCK_VAULT_FIRST");
        }
        if matches!(
            action.as_str(),
            "touch"
                | "sync"
                | "list"
                | "groups"
                | "create_group"
                | "save"
                | "history"
                | "copy_field"
                | "sharing"
                | "resolve_recipient"
                | "share_change"
                | "settings"
                | "export_local_backup"
                | "import_local"
                | "pick_attachment"
                | "save_attachment"
                | "keepass_prepare"
                | "keepass_status"
                | "keepass_commit"
                | "keepass_cancel"
                | "keepass_last_report"
                | "keepass_open_report"
        ) {
            let status = c.status();
            launch::check_profile(r["expected_profile"].as_str(), status["profile"].as_str())?;
        }
        if matches!(
            action.as_str(),
            "login" | "register_begin" | "register_finish" | "prepare_verification"
        ) {
            launch::check_server(state.pinned_server.as_deref(), &text(r, "server")?)?;
        }
        if action == "unlock_offline" {
            let profiles = c.profiles().await?;
            let id = text(r, "id")?;
            let p = profiles
                .iter()
                .find(|p| p["id"].as_str() == Some(&id))
                .ok_or_else(|| anyhow!("Profile not found"))?;
            if p["local"] != true {
                launch::check_server(
                    state.pinned_server.as_deref(),
                    p["server"].as_str().unwrap_or(""),
                )?;
            }
        }
        match text(r, "action")?.as_str() {
            "keepass_status" => Ok(serde_json::to_value(c.keepass_import_status().await?)?),
            "keepass_last_report" => Ok(serde_json::to_value(c.keepass_last_report().await?)?),
            "keepass_open_report" => {
                let labels = serde_json::from_value(r["labels"].take())?;
                let html = c.keepass_report_html(&text(r, "ticket")?, &labels).await?;
                let directory = app.path().app_cache_dir()?.join("import-reports");
                std::fs::create_dir_all(&directory)?;
                let path = directory.join(format!("keepass-{}.html", uuid_for_report()));
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                use std::io::Write;
                options.open(&path)?.write_all(html.as_bytes())?;
                let url = tauri::Url::from_file_path(&path)
                    .map_err(|_| anyhow!("Invalid report path"))?;
                open_browser_url(url.as_str())?;
                Ok(json!(true))
            }
            "keepass_cancel" => {
                c.cancel_keepass_import(&text(r, "ticket")?).await?;
                Ok(json!(true))
            }
            "keepass_commit" => c.commit_keepass_import(&text(r, "ticket")?).await,
            "keepass_prepare" => {
                let password = secret(r, "password")?;
                let folder = text(r, "folder")?;
                let Some(path) = app
                    .dialog()
                    .file()
                    .add_filter("KeePass KDBX", &["kdbx"])
                    .blocking_pick_file()
                else {
                    return Ok(Value::Null);
                };
                let keyfile = if r["use_keyfile"] == true {
                    let Some(keyfile) = app.dialog().file().blocking_pick_file() else {
                        return Ok(Value::Null);
                    };
                    Some(keyfile.into_path().map_err(|_| anyhow!("Invalid path"))?)
                } else {
                    None
                };
                Ok(serde_json::to_value(
                    c.prepare_keepass_import(
                        path.into_path().map_err(|_| anyhow!("Invalid path"))?,
                        password,
                        keyfile,
                        folder,
                    )
                    .await?,
                )?)
            }
            "pick_attachment" => {
                anyhow::ensure!(c.status()["unlocked"] == true, "Vault is locked");
                let Some(path) = app.dialog().file().blocking_pick_file() else {
                    return Ok(Value::Null);
                };
                anyhow::ensure!(c.status()["unlocked"] == true, "LOCKED");
                Ok(serde_json::to_value(Attachment::from_file(
                    &path.into_path().map_err(|_| anyhow!("Invalid path"))?,
                )?)?)
            }
            "save_attachment" => {
                anyhow::ensure!(c.status()["unlocked"] == true, "Vault is locked");
                let attachment: Attachment = serde_json::from_value(r["attachment"].take())?;
                attachment.validate()?;
                let Some(path) = app
                    .dialog()
                    .file()
                    .set_file_name(&attachment.name)
                    .blocking_save_file()
                else {
                    return Ok(json!(false));
                };
                anyhow::ensure!(c.status()["unlocked"] == true, "LOCKED");
                attachment.save_to(&path.into_path().map_err(|_| anyhow!("Invalid path"))?)?;
                Ok(json!(true))
            }
            "create_local" => {
                c.create_local(&text(r, "name")?, secret(r, "password")?)
                    .await
            }
            "export_local_backup" => {
                let password = secret(r, "password")?;
                let path = app
                    .dialog()
                    .file()
                    .set_file_name("neruvalo.nvbackup")
                    .blocking_save_file();
                let Some(path) = path else {
                    return Ok(json!(false));
                };
                c.export_local_backup(
                    &path.into_path().map_err(|_| anyhow!("Invalid path"))?,
                    password,
                )
                .await?;
                Ok(json!(true))
            }
            "restore_local_backup" => {
                let password = secret(r, "password")?;
                let path = app
                    .dialog()
                    .file()
                    .add_filter("Neruvalo backup", &["nvbackup"])
                    .blocking_pick_file();
                let Some(path) = path else {
                    return Ok(Value::Null);
                };
                c.restore_local_backup(
                    &path.into_path().map_err(|_| anyhow!("Invalid path"))?,
                    password,
                )
                .await
            }
            "import_local" => {
                let source = text(r, "source_id")?;
                c.import_local(&source, secret(r, "password")?).await
            }
            "profiles" => {
                let mut profiles = c.profiles().await?;
                if let Some(server) = &state.pinned_server {
                    profiles.retain(|p| {
                        p["local"] == true || p["server"].as_str() == Some(server.as_str())
                    });
                }
                Ok(serde_json::to_value(profiles)?)
            }
            "open_project_link" => {
                open_project_link(&text(r, "target")?, r["commit"].as_str())?;
                Ok(Value::Null)
            }
            "proxy_settings" => c.proxy_settings(),
            "set_proxy" => c.set_proxy(serde_json::from_value(r["settings"].clone())?),
            "about" => Ok(
                serde_json::json!({"version":env!("CARGO_PKG_VERSION"), "os":std::env::consts::OS,"arch":std::env::consts::ARCH,"protocol":2,"record_format":2,"group_format":2}),
            ),
            "status" => Ok(c.status()),
            "touch" => {
                c.touch()?;
                Ok(Value::Null)
            }
            "lock" => {
                c.lock();
                app.emit("vault-locked", ())?;
                Ok(Value::Null)
            }
            "prepare_verification" => {
                c.prepare_verification(
                    &text(r, "server")?,
                    &text(r, "kind")?,
                    &text(r, "login")?,
                    r["email"].as_str().unwrap_or(""),
                )
                .await
            }
            "register_begin" => {
                c.set_verification_secret(r["verification_secret"].as_str().map(str::to_owned));
                let password = secret(r, "password")?;
                c.register_begin(
                    &text(r, "server")?,
                    &text(r, "login")?,
                    &text(r, "email")?,
                    password,
                    r["with_recovery"].as_bool().unwrap_or(false),
                )
                .await
            }
            "register_finish" => {
                c.register_finish(&text(r, "server")?, &text(r, "code")?)
                    .await
            }
            "login" => {
                c.set_verification_secret(r["verification_secret"].as_str().map(str::to_owned));
                let password = secret(r, "password")?;
                let server = text(r, "server")?;
                let result = c.login(&server, &text(r, "login")?, password).await?;
                // History contains only normalized public origins after successful online login.
                launch::remember_server(&state.history_path, &server)?;
                Ok(result)
            }
            "unlock_offline" => {
                let password = secret(r, "password")?;
                c.unlock_offline(&text(r, "id")?, password).await
            }
            "sync" => c.sync().await,
            "archive_tree" => {
                c.archive_tree(
                    &text(r, "id")?,
                    r["archived"]
                        .as_bool()
                        .ok_or_else(|| anyhow!("Missing archive state"))?,
                )
                .await
            }
            "sharing" => c.sharing().await,
            "resolve_recipient" => c.resolve_recipient(&text(r, "login")?).await,
            "share_change" => {
                c.share_change(&text(r, "kind")?, &text(r, "id")?, &text(r, "target")?)
                    .await
            }
            "groups" => Ok(serde_json::to_value(c.groups().await?)?),
            "create_group" => {
                c.create_group(text(r, "title")?, r["parent"].as_str())
                    .await
            }
            "list" => Ok(serde_json::to_value(c.list().await?)?),
            "history" => Ok(serde_json::to_value(c.history(&text(r, "id")?).await?)?),
            "save" => {
                let data: RecordData = serde_json::from_value(r["data"].take())?;
                let id = r["id"].as_str().map(str::to_owned);
                if r.get("group").is_some() {
                    return c
                        .save_in_group(
                            id,
                            r["expected_revision"]
                                .as_i64()
                                .ok_or_else(|| anyhow!("Missing revision"))?,
                            data,
                            r["archived"].as_bool().unwrap_or(false),
                            r["group"].as_str(),
                        )
                        .await;
                }
                c.save(
                    id,
                    r["expected_revision"]
                        .as_i64()
                        .ok_or_else(|| anyhow!("Missing revision"))?,
                    data,
                    r["archived"].as_bool().unwrap_or(false),
                )
                .await
            }
            "settings" => {
                c.settings(
                    r["seconds"]
                        .as_u64()
                        .filter(|x| *x <= 86400)
                        .ok_or_else(|| anyhow!("Invalid timeout"))? as u32,
                )
                .await
            }
            "save_certificate" => {
                let path = app
                    .dialog()
                    .file()
                    .set_file_name("neruvalo-recovery.json")
                    .blocking_save_file();
                let Some(path) = path else {
                    return Ok(json!(false));
                };
                c.save_certificate_to(&path.into_path().map_err(|_| anyhow!("Invalid path"))?)?;
                Ok(json!(true))
            }
            "recover_file" => {
                let password = secret(r, "password")?;
                let path = app
                    .dialog()
                    .file()
                    .add_filter("Recovery certificate", &["json"])
                    .blocking_pick_file();
                let Some(path) = path else {
                    return Ok(Value::Null);
                };
                let path = path.into_path().map_err(|_| anyhow!("Invalid path"))?;
                anyhow::ensure!(
                    std::fs::metadata(&path)?.len() <= 65536,
                    "Certificate too large"
                );
                let certificate = Zeroizing::new(std::fs::read_to_string(path)?);
                let parsed: Value = serde_json::from_str(&certificate)?;
                launch::check_server(state.pinned_server.as_deref(), &text(&parsed, "server")?)?;
                c.recover(certificate, password).await
            }
            "read_clipboard" => Ok(json!(arboard::Clipboard::new()?.get_text()?)),
            "copy_field" => {
                let seconds = r["seconds"].as_u64().unwrap_or(30);
                anyhow::ensure!(seconds <= 3600, "Invalid clipboard timeout");
                let received = c.sharing().await?;
                let shared = received["incoming"]
                    .as_array()
                    .and_then(|v| v.iter().find(|v| v["record_id"] == r["id"]));
                let list = if let Some(shared) = shared {
                    vec![serde_json::from_value::<neruvalo_client::RecordData>(
                        shared["data"].clone(),
                    )?]
                } else {
                    c.history(&text(r, "id")?)
                        .await?
                        .into_iter()
                        .map(|v| v.data)
                        .collect()
                };
                let current = list.first().ok_or_else(|| anyhow!("Record not found"))?;
                let value = Zeroizing::new(
                    current
                        .fields
                        .get(&text(r, "field")?)
                        .ok_or_else(|| anyhow!("Field not found"))?
                        .clone(),
                );
                anyhow::ensure!(!value.is_empty(), "Field is empty");
                arboard::Clipboard::new()?.set_text(value.as_str())?;
                let sequence = state.clipboard_generation.fetch_add(1, Ordering::SeqCst) + 1;
                if seconds > 0 {
                    let generation = state.clipboard_generation.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
                        if generation.load(Ordering::SeqCst) == sequence {
                            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                                if clipboard.get_text().is_ok_and(|s| s == value.as_str()) {
                                    let _ = clipboard.clear();
                                }
                            }
                        }
                    });
                }
                Ok(Value::Null)
            }
            _ => Err(anyhow!("Unsupported command")),
        }
    }
    #[cfg(debug_assertions)]
    let action = request["action"].as_str().unwrap_or("unknown").to_owned();
    dispatch(&app, &state, &mut request).await.map_err(|e| {
        #[cfg(debug_assertions)]
        eprintln!("Neruvalo command {action} failed: {e:#}");
        e.to_string()
    })
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = match std::env::var("NERUVALO_CLIENT_DIR") {
                Ok(p) => PathBuf::from(p),
                Err(_) => app.path().app_local_data_dir()?,
            };
            let (pinned_server, startup_error) =
                match launch::pinned_server(std::env::args().skip(1)) {
                    Ok(server) => (server, None),
                    Err(e) => (None, Some(e.to_string())),
                };
            let mut client = Client::new(dir.clone())?;
            app.manage(verification::Sessions::default());
            let verification_app = app.handle().clone();
            client.set_verification_opener(Box::new(move |url| {
                verification::open(&verification_app, url)
            }));
            app.manage(Desktop {
                history_path: dir.join("servers.json"),
                pinned_server,
                startup_error,
                client: Mutex::new(client),
                clipboard_generation: Arc::new(AtomicU64::new(0)),
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut was_unlocked = false;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    let state = handle.state::<Desktop>();
                    let mut c = state.client.lock().await;
                    let unlocked = c.status()["unlocked"].as_bool().unwrap_or(false);
                    if was_unlocked && !unlocked {
                        let _ = handle.emit("vault-locked", ());
                    }
                    was_unlocked = unlocked;
                }
            });
            #[cfg(windows)]
            {
                let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
                windows_lock::start(sender);
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    while receiver.recv().await.is_some() {
                        handle.state::<Desktop>().client.lock().await.lock();
                        let _ = handle.emit("vault-locked", ());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            command,
            verification::cancel_verification
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start Neruvalo");
}

#[cfg(feature = "desktop")]
fn open_project_link(target: &str, commit: Option<&str>) -> anyhow::Result<()> {
    let commit = commit.filter(|c| c.len() == 40 && c.bytes().all(|b| b.is_ascii_hexdigit()));
    let url = match target {
        "issues" => "https://github.com/Urich/neruvalo/issues".to_owned(),
        "source" => format!(
            "https://github.com/Urich/neruvalo/tree/{}",
            commit.ok_or_else(|| anyhow::anyhow!("Missing build commit"))?
        ),
        "security" => format!(
            "https://github.com/Urich/neruvalo/blob/{}/SECURITY.md",
            commit.ok_or_else(|| anyhow::anyhow!("Missing build commit"))?
        ),
        _ => anyhow::bail!("Invalid project link"),
    };
    open_browser_url(&url)
}

fn uuid_for_report() -> String {
    // A random token avoids collisions without using source file names in paths.
    uuid::Uuid::new_v4().to_string()
}

fn open_browser_url(url: &str) -> anyhow::Result<()> {
    #[cfg(target_os = "windows")]
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn()?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(url).spawn()?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open").arg(url).spawn()?;
    Ok(())
}
