use anyhow::{anyhow, Result};
use neruvalo_client::VerificationView;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct Sessions(Mutex<Option<(String, Arc<AtomicBool>)>>);

struct View {
    app: tauri::AppHandle,
    id: String,
    closed: Arc<AtomicBool>,
}
impl VerificationView for View {
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}
impl Drop for View {
    fn drop(&mut self) {
        let sessions = self.app.state::<Sessions>();
        if let Ok(mut active) = sessions.0.lock() {
            if active.as_ref().is_some_and(|(id, _)| id == &self.id) {
                *active = None;
            }
        }
        let _ = self.app.emit_to("main", "verification-close", &self.id);
    }
}

#[tauri::command]
pub fn cancel_verification(
    window: tauri::WebviewWindow,
    sessions: tauri::State<'_, Sessions>,
    id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Commands are only available in the main window".into());
    }
    let active = sessions.0.lock().map_err(|e| e.to_string())?;
    if let Some((active_id, closed)) = active.as_ref() {
        if active_id == &id {
            closed.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

pub fn open(app: &tauri::AppHandle, url: &str) -> Result<Box<dyn VerificationView>> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
    let closed = Arc::new(AtomicBool::new(false));
    *app.state::<Sessions>()
        .0
        .lock()
        .map_err(|e| anyhow!(e.to_string()))? = Some((id.clone(), closed.clone()));
    let view = View {
        app: app.clone(),
        id: id.clone(),
        closed,
    };
    // Only the local main UI receives the bearer URL. The remote frame gets no IPC access.
    app.emit_to(
        "main",
        "verification-open",
        serde_json::json!({"id":id,"url":url}),
    )?;
    Ok(Box::new(view))
}
