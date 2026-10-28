#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use anyhow::{anyhow, Result};
use neruvalo_client::{Client, RecordData};
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
#[cfg(windows)]
mod windows_lock;
struct Desktop {
    client: Mutex<Client>,
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
    state: tauri::State<'_, Desktop>,
    mut request: Value,
) -> Result<Value, String> {
    async fn dispatch(app: &tauri::AppHandle, state: &Desktop, r: &mut Value) -> Result<Value> {
        let mut c = state.client.lock().await;
        match text(r, "action")?.as_str() {
            "profiles" => Ok(serde_json::to_value(c.profiles().await?)?),
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
            "register_begin" => {
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
                let password = secret(r, "password")?;
                c.login(&text(r, "server")?, &text(r, "login")?, password)
                    .await
            }
            "unlock_offline" => {
                let password = secret(r, "password")?;
                c.unlock_offline(&text(r, "id")?, password).await
            }
            "sync" => c.sync().await,
            "list" => Ok(serde_json::to_value(c.list().await?)?),
            "history" => Ok(serde_json::to_value(c.history(&text(r, "id")?).await?)?),
            "save" => {
                let data: RecordData = serde_json::from_value(r["data"].take())?;
                let id = r["id"].as_str().map(str::to_owned);
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
                c.recover(Zeroizing::new(std::fs::read_to_string(path)?), password)
                    .await
            }
            "copy_field" => {
                let seconds = r["seconds"].as_u64().unwrap_or(30);
                anyhow::ensure!(seconds <= 3600, "Invalid clipboard timeout");
                let list = c.history(&text(r, "id")?).await?;
                let current = list.first().ok_or_else(|| anyhow!("Record not found"))?;
                let value = Zeroizing::new(
                    current
                        .data
                        .fields
                        .get(&text(r, "field")?)
                        .ok_or_else(|| anyhow!("Field not found"))?
                        .clone(),
                );
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
    dispatch(&app, &state, &mut request)
        .await
        .map_err(|e| e.to_string())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = match std::env::var("NERUVALO_CLIENT_DIR") {
                Ok(p) => PathBuf::from(p),
                Err(_) => app.path().app_local_data_dir()?,
            };
            app.manage(Desktop {
                client: Mutex::new(Client::new(dir)?),
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
        .invoke_handler(tauri::generate_handler![command])
        .run(tauri::generate_context!())
        .expect("Failed to start Neruvalo");
}
