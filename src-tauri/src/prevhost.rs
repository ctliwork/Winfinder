//! Explorer's preview pane for the column view: the file type's registered
//! preview handler (IPreviewHandler — Office, PDF, text, PowerToys…) drawn in
//! a child window laid over the page's preview area.
//!
//! One STA thread owns the host window and talks to the handlers, so a slow
//! one (Word can take a second) never stalls the UI thread.
//!
//! Starting a handler is the slow part: most run in prevhost.exe, which
//! starts and loads the handler again once nothing holds it. So, like
//! Explorer, handlers are kept and reused for the next file of their type
//! (Unload, then Initialize again), and the ones a folder will need can be
//! started ahead of time (`warm`). Rectangles are in
//! physical pixels: `host` relative to the main window's client area, `inner`
//! (the preview itself, which may stick out of the visible part) relative to
//! `host`.

use serde::Deserialize;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use windows::core::{w, Interface, GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, PAINTSTRUCT};
use windows::Win32::System::Com::{CLSIDFromString, CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithFile, IInitializeWithStream};
use windows::Win32::UI::Shell::{
    AssocQueryStringW, IInitializeWithItem, IPreviewHandler, IPreviewHandlerVisuals, IShellItem, SHCreateItemFromParsingName,
    SHCreateStreamOnFileEx, ASSOCF_NONE, ASSOCSTR_SHELLEXTENSION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW, RegisterClassW, SetWindowPos,
    ShowWindow, TranslateMessage, HWND_TOP, MSG, PM_NOREMOVE, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, WINDOW_EX_STYLE, WM_APP,
    WM_ERASEBKGND, WM_PAINT, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
};

#[derive(Deserialize, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn win(self) -> RECT {
        RECT { left: self.x, top: self.y, right: self.x + self.w, bottom: self.y + self.h }
    }
}

enum Cmd {
    Show { parent: isize, path: String, gen: u64, host: Rect, inner: Rect, dark: bool, reply: Sender<Result<(), String>> },
    /// None: hide for now (something is drawn over the preview), keeping it loaded.
    Move(Option<(Rect, Rect)>),
    Hide,
    /// Start the handlers for these extensions while nothing else is waiting.
    Warm(Vec<String>),
}

/// Handlers kept for reuse, most recently used first.
const KEEP: usize = 4;

struct Worker {
    tx: Sender<Cmd>,
    thread: u32,
}

static WORKER: OnceLock<Mutex<Worker>> = OnceLock::new();
/// The newest show request; older ones still queued are skipped.
static LATEST: AtomicU64 = AtomicU64::new(0);
/// Host background (COLORREF) while a handler loads, matching the theme.
static BG: AtomicU32 = AtomicU32::new(0x00FF_FFFF);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// The preview handler Explorer would use for this extension, if any.
fn handler_clsid(ext: &str) -> Option<GUID> {
    let ext = wide(&format!(".{ext}"));
    let iid = wide("{8895b1c6-b41f-4c1c-a562-0d564250836f}");
    let mut buf = [0u16; 64];
    let mut n = buf.len() as u32;
    unsafe {
        AssocQueryStringW(ASSOCF_NONE, ASSOCSTR_SHELLEXTENSION, PCWSTR(ext.as_ptr()), PCWSTR(iid.as_ptr()), Some(PWSTR(buf.as_mut_ptr())), &mut n)
            .ok()
            .ok()?;
        CLSIDFromString(PCWSTR(buf.as_ptr())).ok()
    }
}

pub fn available(ext: &str) -> bool {
    !ext.is_empty() && handler_clsid(ext).is_some()
}

fn send(cmd: Cmd) -> Result<(), String> {
    let w = WORKER.get_or_init(|| Mutex::new(spawn())).lock().map_err(|e| e.to_string())?;
    w.tx.send(cmd).map_err(|e| e.to_string())?;
    unsafe { PostThreadMessageW(w.thread, WM_APP, WPARAM(0), LPARAM(0)) }.map_err(|e| e.message())
}

/// How long a handler may take before it is given up on.
const GIVE_UP: std::time::Duration = std::time::Duration::from_secs(15);

/// Loads `path` into the preview area. Blocks until the handler has drawn it
/// (or failed); `gen` lets a newer request overtake this one.
pub fn show(parent: isize, path: String, gen: u64, host: Rect, inner: Rect, dark: bool) -> Result<(), String> {
    LATEST.fetch_max(gen, Ordering::SeqCst);
    let (reply, rx) = channel();
    send(Cmd::Show { parent, path, gen, host, inner, dark, reply })?;
    match rx.recv_timeout(GIVE_UP) {
        Ok(r) => r,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // The handler is stuck inside the thread, and every later preview
            // would wait behind it. Leave that thread to it and start a new one;
            // whatever the old one finishes with is stale and gets hidden.
            LATEST.fetch_add(1, Ordering::SeqCst);
            if let Some(w) = WORKER.get() {
                if let Ok(mut w) = w.lock() {
                    *w = spawn();
                }
            }
            Err("TIMEOUT".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

pub fn move_to(rects: Option<(Rect, Rect)>) -> Result<(), String> {
    send(Cmd::Move(rects))
}

/// Unloads the preview; shows queued before `gen` are dropped.
pub fn hide(gen: u64) -> Result<(), String> {
    LATEST.fetch_max(gen, Ordering::SeqCst);
    send(Cmd::Hide)
}

/// Starts (and keeps) the handlers for `exts`, so their first preview is quick.
pub fn warm(exts: Vec<String>) -> Result<(), String> {
    send(Cmd::Warm(exts))
}

fn spawn() -> Worker {
    let (tx, rx) = channel();
    let (ready_tx, ready_rx) = channel();
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            // Create the message queue before anyone posts to it.
            let mut msg = MSG::default();
            let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        }
        let _ = ready_tx.send(unsafe { GetCurrentThreadId() });
        run(rx);
    });
    Worker { tx, thread: ready_rx.recv().unwrap_or(0) }
}

#[derive(Default)]
struct State {
    host: Option<HWND>,
    /// The handler showing the current file.
    handler: Option<IPreviewHandler>,
    /// Handlers kept for reuse (the current one included), most recent first.
    kept: Vec<(GUID, IPreviewHandler)>,
    /// Extensions waiting to be warmed up.
    warm: Vec<String>,
}

fn run(rx: Receiver<Cmd>) {
    let mut st = State::default();
    let mut msg = MSG::default();
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.hwnd.is_invalid() && msg.message == WM_APP {
                while let Ok(cmd) = rx.try_recv() {
                    handle(&mut st, cmd);
                }
                // One warm-up at a time, then look at the queue again, so a
                // preview asked for meanwhile doesn't wait for all of them.
                if let Some(ext) = st.warm.pop() {
                    warm_one(&mut st, &ext);
                    if !st.warm.is_empty() {
                        let _ = PostThreadMessageW(GetCurrentThreadId(), WM_APP, WPARAM(0), LPARAM(0));
                    }
                }
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn handle(st: &mut State, cmd: Cmd) {
    match cmd {
        Cmd::Show { parent, path, gen, host, inner, dark, reply } => {
            let r = if gen < LATEST.load(Ordering::SeqCst) { Err("STALE".into()) } else { load(st, parent, &path, gen, host, inner, dark) };
            if r.is_err() {
                unload(st);
                hide_host(st);
            }
            let _ = reply.send(r);
        }
        Cmd::Move(Some((host, inner))) => {
            if let (Some(h), Some(ph)) = (st.host, &st.handler) {
                unsafe {
                    let _ = SetWindowPos(h, Some(HWND_TOP), host.x, host.y, host.w, host.h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                    let _ = ph.SetRect(&inner.win());
                }
            }
        }
        Cmd::Move(None) => hide_host(st),
        Cmd::Hide => {
            unload(st);
            hide_host(st);
        }
        Cmd::Warm(exts) => {
            for ext in exts {
                if !st.warm.contains(&ext) {
                    st.warm.insert(0, ext);
                }
            }
        }
    }
}

fn warm_one(st: &mut State, ext: &str) {
    let Some(clsid) = handler_clsid(ext) else { return };
    if st.kept.iter().any(|(c, _)| *c == clsid) || st.kept.len() >= KEEP {
        return;
    }
    if let Ok(ph) = create(&clsid) {
        st.kept.push((clsid, ph));
    }
}

fn create(clsid: &GUID) -> Result<IPreviewHandler, String> {
    // Most handlers run out of process (prevhost.exe), like in Explorer.
    unsafe { CoCreateInstance(clsid, None, CLSCTX_LOCAL_SERVER | CLSCTX_INPROC_SERVER) }.map_err(|e| e.message())
}

fn hide_host(st: &State) {
    if let Some(h) = st.host {
        unsafe {
            let _ = ShowWindow(h, SW_HIDE);
        }
    }
}

fn unload(st: &mut State) {
    if let Some(ph) = st.handler.take() {
        unsafe {
            let _ = ph.Unload();
        }
    }
}

fn load(st: &mut State, parent: isize, path: &str, gen: u64, host: Rect, inner: Rect, dark: bool) -> Result<(), String> {
    unload(st);
    // Hidden while the handler works (PowerPoint takes a while): the page's own
    // preview of the file shows meanwhile, not a blank box or the last file.
    hide_host(st);
    let ext = std::path::Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let clsid = handler_clsid(&ext).ok_or("NO_HANDLER")?;
    let (bg, fg) = if dark { (0x002B_2A28u32, 0x00EB_EBEBu32) } else { (0x00FF_FFFF, 0x001F_1D1D) };
    BG.store(bg, Ordering::SeqCst);
    unsafe {
        // Reuse a kept handler of this type; one that won't take another file is replaced.
        let ph = match st.kept.iter().position(|(c, _)| *c == clsid) {
            Some(i) => {
                let (_, old) = st.kept.remove(i);
                if init(&old, path).is_ok() {
                    old
                } else {
                    let ph = create(&clsid)?;
                    init(&ph, path)?;
                    ph
                }
            }
            None => {
                let ph = create(&clsid)?;
                init(&ph, path)?;
                ph
            }
        };
        let h = host_window(st, HWND(parent as _))?;
        SetWindowPos(h, Some(HWND_TOP), host.x, host.y, host.w, host.h, SWP_NOACTIVATE).map_err(|e| e.message())?;
        ph.SetWindow(h, &inner.win()).map_err(|e| e.message())?;
        if let Ok(v) = ph.cast::<IPreviewHandlerVisuals>() {
            let _ = v.SetBackgroundColor(COLORREF(bg));
            let _ = v.SetTextColor(COLORREF(fg));
        }
        st.handler = Some(ph.clone());
        ph.DoPreview().map_err(|e| e.message())?;
        // Kept only once it has worked; the oldest kept one is let go.
        st.kept.insert(0, (clsid, ph));
        st.kept.truncate(KEEP);
        // Another file was picked (or this one was given up on) while it drew: don't show it.
        if gen < LATEST.load(Ordering::SeqCst) {
            return Err("STALE".into());
        }
        let _ = SetWindowPos(h, Some(HWND_TOP), host.x, host.y, host.w, host.h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
    Ok(())
}

/// Handlers take the file one of three ways; try each, as Explorer does.
unsafe fn init(ph: &IPreviewHandler, path: &str) -> Result<(), String> {
    let p = wide(path);
    if let Ok(i) = ph.cast::<IInitializeWithFile>() {
        if i.Initialize(PCWSTR(p.as_ptr()), 0).is_ok() {
            return Ok(());
        }
    }
    if let Ok(i) = ph.cast::<IInitializeWithItem>() {
        if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(p.as_ptr()), None) {
            if i.Initialize(&item, 0).is_ok() {
                return Ok(());
            }
        }
    }
    if let Ok(i) = ph.cast::<IInitializeWithStream>() {
        let stream = SHCreateStreamOnFileEx(PCWSTR(p.as_ptr()), 0, 0, false, None).map_err(|e| e.message())?;
        return i.Initialize(&stream, 0).map_err(|e| e.message());
    }
    Err("NO_INIT".into())
}

unsafe extern "system" fn host_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            let brush = CreateSolidBrush(COLORREF(BG.load(Ordering::SeqCst)));
            FillRect(hdc, &ps.rcPaint, brush);
            let _ = DeleteObject(brush.into());
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

unsafe fn host_window(st: &mut State, parent: HWND) -> Result<HWND, String> {
    if let Some(h) = st.host {
        return Ok(h);
    }
    let instance = GetModuleHandleW(None).map_err(|e| e.message())?;
    let class = w!("FinderPreviewHost");
    let wc = WNDCLASSW { lpfnWndProc: Some(host_proc), hInstance: instance.into(), lpszClassName: class, ..Default::default() };
    RegisterClassW(&wc);
    let h = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        class,
        w!(""),
        WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
        0,
        0,
        0,
        0,
        Some(parent),
        None,
        Some(instance.into()),
        None,
    )
    .map_err(|e| e.message())?;
    st.host = Some(h);
    Ok(h)
}
