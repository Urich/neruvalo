//! A hidden top-level window receives suspend and WTS session-lock notifications.
use std::sync::OnceLock;
use tokio::sync::mpsc::UnboundedSender;
use windows_sys::Win32::{
    Foundation::*,
    System::{LibraryLoader::GetModuleHandleW, RemoteDesktop::*},
    UI::WindowsAndMessaging::*,
};
static SENDER: OnceLock<UnboundedSender<()>> = OnceLock::new();
unsafe extern "system" fn procedure(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if (message == WM_WTSSESSION_CHANGE && wparam == WTS_SESSION_LOCK as usize)
        || (message == WM_POWERBROADCAST && wparam == 4)
    {
        if let Some(sender) = SENDER.get() {
            let _ = sender.send(());
        }
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}
pub fn start(sender: UnboundedSender<()>) {
    let _ = SENDER.set(sender);
    std::thread::spawn(|| unsafe {
        let name: Vec<u16> = "NeruvaloSessionEvents\0".encode_utf16().collect();
        let module = GetModuleHandleW(std::ptr::null());
        let mut class: WNDCLASSW = std::mem::zeroed();
        class.lpfnWndProc = Some(procedure);
        class.hInstance = module;
        class.lpszClassName = name.as_ptr();
        if RegisterClassW(&class) == 0 {
            return;
        }
        let window = CreateWindowExW(
            0,
            name.as_ptr(),
            name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            module,
            std::ptr::null(),
        );
        if window.is_null() {
            return;
        }
        if WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION) == 0 {
            DestroyWindow(window);
            return;
        }
        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        WTSUnRegisterSessionNotification(window);
        DestroyWindow(window);
    });
}
