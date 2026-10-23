mod archive;
mod cloud;
#[doc(hidden)]
pub mod fsops;
mod places;
mod preview;
mod recent;
mod search;
mod thumb;
#[cfg(windows)]
mod prevhost;
#[cfg(windows)]
mod winshell;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

// Blocking work runs off the async runtime so the UI thread never waits on disk.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

// Async: reading Explorer's Quick Access goes through the shell and must not
// block the UI thread.
#[tauri::command]
async fn places() -> Result<places::Places, String> {
    blocking(places::places).await
}

#[tauri::command]
async fn pin_home(path: String, pin: bool) -> Result<(), String> {
    blocking(move || places::pin_home(&path, pin)).await?
}

#[tauri::command]
async fn list_dir(dir: String) -> Result<Vec<fsops::Entry>, String> {
    blocking(move || fsops::list(&dir)).await?
}

/// "Always keep on this device" / "Free up space" (see cloud::set_pin_state); returns the paths that failed.
#[tauri::command]
async fn cloud_pin(paths: Vec<String>, state: String) -> Result<Vec<String>, String> {
    blocking(move || cloud::set_pin_state(&paths, &state)).await
}

/// Folder listings read ahead before a drag (see fsops::list_many).
#[tauri::command]
async fn list_many(dirs: Vec<String>, depth: usize) -> Vec<(String, Vec<fsops::Entry>)> {
    blocking(move || fsops::list_many(&dirs, depth.min(3), 1500, std::time::Duration::from_millis(250))).await.unwrap_or_default()
}

#[tauri::command]
async fn disk_free(path: String) -> Option<u64> {
    blocking(move || places::disk_free(&path)).await.ok().flatten()
}

#[tauri::command]
async fn disk_space(path: String) -> Option<places::Space> {
    blocking(move || places::disk_space(&path)).await.ok().flatten()
}

#[tauri::command]
async fn resolve_link(path: String) -> Option<fsops::Entry> {
    blocking(move || recent::link_target(&path)).await.ok().flatten()
}

#[tauri::command]
async fn recent_files() -> Vec<fsops::Entry> {
    blocking(recent::recent_files).await.unwrap_or_default()
}

#[tauri::command]
async fn folder_count(dir: String) -> Option<usize> {
    blocking(move || fsops::folder_count(&dir)).await.ok().flatten()
}

#[tauri::command]
async fn thumbnail(path: String, size: i32, icon: Option<bool>) -> Option<String> {
    blocking(move || thumb::thumbnail(&path, size.clamp(16, 1024), icon.unwrap_or(false))).await.ok().flatten()
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn trash(paths: Vec<String>) -> Vec<String> {
    blocking(move || paths.into_iter().filter(|p| trash::delete(p).is_err()).collect())
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn rename(path: String, new_name: String) -> Result<String, String> {
    fsops::rename(&path, &new_name)
}

#[tauri::command]
fn mkdir(dir: String) -> Result<String, String> {
    fsops::mkdir(&dir)
}

static CANCEL_TRANSFER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Copies or moves files, reporting byte progress as "transfer-progress"
/// events (done, total, name) when data actually has to be copied.
#[tauri::command]
async fn transfer(app: AppHandle, op: String, files: Vec<String>, dest: String, conflict: Option<String>) -> Result<Vec<fsops::TransferResult>, String> {
    use std::sync::atomic::Ordering;
    CANCEL_TRANSFER.store(false, Ordering::Relaxed);
    blocking(move || {
        let conflict = fsops::Conflict::parse(conflict.as_deref().unwrap_or(""));
        let total = fsops::total_size(&files);
        let report = |done: u64, total: u64, name: &str| {
            let _ = app.emit("transfer-progress", (done, total, name));
        };
        let progress = fsops::Progress::new(&report, &CANCEL_TRANSFER, total);
        let r = fsops::transfer_with(&op, &files, &dest, conflict, Some(&progress));
        let _ = app.emit("transfer-progress", (total, total, ""));
        r
    })
    .await
}

#[tauri::command]
fn cancel_transfer() {
    CANCEL_TRANSFER.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
async fn restore_trash(paths: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || fsops::restore_trash(&paths)).await
}

#[tauri::command]
fn new_file(dir: String) -> Result<String, String> {
    fsops::new_file(&dir)
}

#[tauri::command]
async fn dir_size(path: String, background: Option<bool>) -> Result<Option<fsops::DirSize>, String> {
    blocking(move || fsops::dir_size(&path, background.unwrap_or(false))).await
}

#[tauri::command]
fn cancel_dir_sizes() {
    fsops::SIZE_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
async fn compress(paths: Vec<String>) -> Result<String, String> {
    blocking(move || archive::compress(&paths)).await?
}

#[tauri::command]
async fn extract(path: String) -> Result<String, String> {
    blocking(move || archive::extract(&path)).await?
}

/// Opens Windows Terminal in `dir`, or PowerShell when it isn't installed.
#[tauri::command]
fn open_terminal(dir: String) -> Result<(), String> {
    use std::process::Command;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x10;
        if Command::new("wt.exe").arg("-d").arg(&dir).spawn().is_ok() {
            return Ok(());
        }
        Command::new("powershell.exe")
            .arg("-NoExit")
            .current_dir(&dir)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
            .iter()
            .find_map(|t| Command::new(t).current_dir(&dir).spawn().ok())
            .map(|_| ())
            .ok_or_else(|| "找不到終端機".to_string())
    }
}

// ---------- Windows shell (UI thread) ----------
// Menus, property sheets and the clipboard belong to the window's thread.
#[cfg(windows)]
async fn on_ui<T: Send + 'static>(
    window: tauri::WebviewWindow,
    f: impl FnOnce(windows::Win32::Foundation::HWND) -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    window
        .run_on_main_thread(move || {
            let _ = tx.send(f(windows::Win32::Foundation::HWND(hwnd as _)));
        })
        .map_err(|e| e.to_string())?;
    blocking(move || rx.recv().map_err(|e| e.to_string())).await?
}

/// Shows Explorer's context menu; returns a verb the UI handles itself.
#[tauri::command]
async fn native_menu(
    window: tauri::WebviewWindow,
    paths: Vec<String>,
    background: bool,
    shift: bool,
    extras: Option<serde_json::Value>,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        let extras: Vec<winshell::Extra> = extras.map(serde_json::from_value).transpose().map_err(|e| e.to_string())?.unwrap_or_default();
        on_ui(window, move |h| winshell::show_menu(h, &paths, background, shift, &extras)).await?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, paths, background, shift, extras);
        Err("unsupported".into())
    }
}

#[tauri::command]
async fn properties(window: tauri::WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    #[cfg(windows)]
    return on_ui(window, move |h| winshell::properties(h, &paths)).await?;
    #[cfg(not(windows))]
    {
        let _ = (window, paths);
        Err("unsupported".into())
    }
}

// ---------- Explorer preview handlers (column view) ----------
#[cfg(windows)]
type PreviewRect = prevhost::Rect;
#[cfg(not(windows))]
#[derive(serde::Deserialize)]
struct PreviewRect {}

#[tauri::command]
async fn preview_available(ext: String) -> bool {
    #[cfg(windows)]
    return blocking(move || prevhost::available(&ext)).await.unwrap_or(false);
    #[cfg(not(windows))]
    {
        let _ = ext;
        false
    }
}

#[tauri::command]
async fn preview_show(window: tauri::WebviewWindow, path: String, gen: u64, host: PreviewRect, inner: PreviewRect, dark: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let parent = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        blocking(move || prevhost::show(parent, path, gen, host, inner, dark)).await?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, path, gen, host, inner, dark);
        Err("unsupported".into())
    }
}

#[tauri::command]
fn preview_move(host: Option<PreviewRect>, inner: Option<PreviewRect>) -> Result<(), String> {
    #[cfg(windows)]
    return prevhost::move_to(host.zip(inner));
    #[cfg(not(windows))]
    {
        let _ = (host, inner);
        Ok(())
    }
}

#[tauri::command]
fn preview_hide(gen: u64) -> Result<(), String> {
    #[cfg(windows)]
    return prevhost::hide(gen);
    #[cfg(not(windows))]
    {
        let _ = gen;
        Ok(())
    }
}

#[cfg(windows)]
type ClipFiles = winshell::ClipFiles;
#[cfg(not(windows))]
#[derive(Serialize)]
struct ClipFiles {
    paths: Vec<String>,
    cut: bool,
}

#[tauri::command]
async fn clipboard_write(window: tauri::WebviewWindow, paths: Vec<String>, cut: bool) -> Result<(), String> {
    #[cfg(windows)]
    return on_ui(window, move |h| winshell::clipboard_write(h, &paths, cut)).await?;
    #[cfg(not(windows))]
    {
        let _ = (window, paths, cut);
        Err("unsupported".into())
    }
}

#[tauri::command]
async fn clipboard_read(window: tauri::WebviewWindow) -> Option<ClipFiles> {
    #[cfg(windows)]
    return on_ui(window, |_| winshell::clipboard_read()).await.ok().flatten();
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

#[tauri::command]
async fn clipboard_clear(window: tauri::WebviewWindow) {
    #[cfg(windows)]
    let _ = on_ui(window, winshell::clipboard_clear).await;
    #[cfg(not(windows))]
    let _ = window;
}

#[derive(Serialize)]
struct TextResult {
    text: Option<String>,
    binary: bool,
    truncated: bool,
    error: Option<String>,
}

#[tauri::command]
async fn read_text(path: String) -> TextResult {
    let r = blocking(move || fsops::read_text(&path, 256 * 1024)).await;
    match r {
        Ok(Ok((text, binary, truncated))) => TextResult { text, binary, truncated, error: None },
        Ok(Err(e)) | Err(e) => TextResult { text: None, binary: false, truncated: false, error: Some(e) },
    }
}

#[tauri::command]
async fn rich_preview(path: String) -> Result<preview::Preview, String> {
    blocking(move || preview::preview(&path)).await?
}

#[tauri::command]
fn everything_available() -> bool {
    search::everything_available()
}

#[tauri::command]
async fn everything(query: String) -> Option<search::SearchResult> {
    blocking(move || search::everything(&query)).await.ok().flatten()
}

#[tauri::command]
async fn search(root: String, query: String, show_hidden: bool, filter: Option<search::Filter>) -> Option<search::SearchResult> {
    blocking(move || search::search(&root, &query, show_hidden, &filter.unwrap_or_default())).await.ok().flatten()
}

// ---------- updates ----------
// The update found by check_update, kept until the user chooses to install it.
#[derive(Default)]
struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

#[tauri::command]
async fn check_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else { return Ok(None) };
    let info = UpdateInfo { version: update.version.clone(), current: update.current_version.clone(), notes: update.body.clone() };
    *pending.0.lock().unwrap() = Some(update);
    Ok(Some(info))
}

#[tauri::command]
async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("NO_UPDATE")?;
    let progress = app.clone();
    let mut received = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                let _ = progress.emit("update-progress", (received, total));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // On Windows the installer usually closes the app itself; restart covers the rest.
    app.restart();
}

// ---------- folder watching ----------
struct WatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    dirs: Mutex<HashSet<PathBuf>>,
}

fn make_watcher(app: AppHandle) -> Option<RecommendedWatcher> {
    notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let dirs: HashSet<String> = event
            .paths
            .iter()
            .filter_map(|p| p.parent())
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        for d in dirs {
            let _ = app.emit("fs-changed", d);
        }
    })
    .ok()
}

#[tauri::command]
fn watch(app: AppHandle, state: State<WatchState>, dirs: Vec<String>) {
    let mut guard = state.watcher.lock().unwrap();
    if guard.is_none() {
        *guard = make_watcher(app);
    }
    let Some(watcher) = guard.as_mut() else { return };
    let wanted: HashSet<PathBuf> = dirs.into_iter().map(PathBuf::from).collect();
    let mut current = state.dirs.lock().unwrap();
    for old in current.difference(&wanted) {
        let _ = watcher.unwatch(old);
    }
    for new in wanted.difference(&current) {
        let _ = watcher.watch(new, RecursiveMode::NonRecursive);
    }
    *current = wanted;
}

// ---------- window ----------
// The theme chosen in Settings lives in the page's storage, which the window
// can't read before it exists. A copy on disk lets the window open in that
// theme, so Mica and the sidebar never start in the other one and flash.
fn theme_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("theme"))
}

#[tauri::command]
fn save_theme(app: AppHandle, theme: String) {
    if let Some(f) = theme_file(&app) {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(f, theme);
    }
}

fn saved_theme(app: &AppHandle) -> Option<tauri::Theme> {
    match std::fs::read_to_string(theme_file(app)?).ok()?.trim() {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    }
}

// Interface size (Settings > 外觀): the webview's zoom, which scales text and
// layout together. Kept on disk too so the window opens at that size.
fn scale_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("ui-scale"))
}

fn saved_scale(app: &AppHandle) -> f64 {
    scale_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|s| (0.5..=2.0).contains(s))
        .unwrap_or(1.0)
}

#[tauri::command]
fn set_ui_scale(app: AppHandle, window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
    let scale = scale.clamp(0.5, 2.0);
    window.set_zoom(scale).map_err(|e| e.to_string())?;
    if let Some(f) = scale_file(&app) {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(f, scale.to_string());
    }
    Ok(())
}

/// Whether Windows apps use the dark theme (Settings > Personalization > Colors).
#[cfg(windows)]
fn system_dark() -> bool {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut value: u32 = 1;
    let mut size = std::mem::size_of::<u32>() as u32;
    let r = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    r.is_ok() && value == 0
}

#[cfg(not(windows))]
fn system_dark() -> bool {
    false
}

/// The folder asked for on the command line: `--dir=<path>` or a folder as the first argument.
fn dir_arg(args: &[String]) -> Option<String> {
    args.iter()
        .find_map(|a| a.strip_prefix("--dir=").map(str::to_owned))
        .or_else(|| args.get(1).filter(|a| std::path::Path::new(a).is_dir()).cloned())
}

/// Started at sign-in (see set_run_at_login): load everything but stay hidden.
const BACKGROUND_ARG: &str = "--background";

fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let start_dir = dir_arg(&args);
    let background = args.iter().any(|a| a == BACKGROUND_ARG);

    // Opaque on every platform: a transparent (Mica) window can show white
    // for a moment at startup while its layers catch up.
    #[cfg(windows)]
    let (platform, material) = ("win32", "none");
    #[cfg(target_os = "macos")]
    let (platform, material) = ("darwin", "none");
    #[cfg(all(unix, not(target_os = "macos")))]
    let (platform, material) = ("linux", "none");

    let env = serde_json::json!({
        "platform": platform,
        "material": material,
        "dir": start_dir,
        "sep": std::path::MAIN_SEPARATOR.to_string(),
        "background": background,
    });

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Finder")
        .inner_size(1180.0, 740.0)
        .min_inner_size(680.0, 420.0)
        .decorations(false)
        .visible(false)
        .initialization_script(&format!("window.__finderEnv = {env};"))
        .theme(saved_theme(app));

    #[cfg(windows)]
    {
        builder = builder.shadow(true);
    }
    // The window and the webview start out in the page's own background colour
    // (body / --side-solid in styles.css), so the first frame already matches.
    let dark = match saved_theme(app) {
        Some(tauri::Theme::Dark) => true,
        Some(tauri::Theme::Light) => false,
        _ => system_dark(),
    };
    builder = builder.background_color(if dark {
        tauri::window::Color(0x26, 0x27, 0x2b, 0xff)
    } else {
        tauri::window::Color(0xee, 0xf0, 0xf5, 0xff)
    });

    let window = builder.build()?;
    let scale = saved_scale(app);
    if scale != 1.0 {
        let _ = window.set_zoom(scale);
    }
    // Show the window even if the page never signals readiness.
    if !background {
        let w = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let _ = w.show();
        });
    }
    Ok(())
}

// ---------- staying in the background ----------
// Closing the window only hides it (Settings: 關閉視窗後在背景執行), so the
// next open is instant. The app then lives in the notification area, and
// starting it again brings back the window that is already running.
static KEEP_RUNNING: AtomicBool = AtomicBool::new(true);

#[tauri::command]
fn set_keep_running(on: bool) {
    KEEP_RUNNING.store(on, Ordering::Relaxed);
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "打開 Finder", true, None::<&str>)?,
            &MenuItem::with_id(app, "new-tab", "新分頁", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "結束", true, None::<&str>)?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Finder")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => show_main(app),
            "new-tab" => {
                show_main(app);
                let _ = app.emit("open-dir", None::<String>);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Starts the app hidden when the user signs in to Windows (HKCU\...\Run).
#[tauri::command]
fn set_run_at_login(on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::System::Registry::{RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
        const RUN: windows::core::PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
        const NAME: windows::core::PCWSTR = w!("Finder for Windows");
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let cmd: Vec<u16> = format!("\"{}\" {BACKGROUND_ARG}", exe.display()).encode_utf16().chain(Some(0)).collect();
            let r = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, RUN, NAME, REG_SZ.0, Some(cmd.as_ptr() as _), (cmd.len() * 2) as u32) };
            r.ok().map_err(|e| e.message())?;
        } else {
            // Missing already is fine.
            let _ = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN, NAME) };
        }
    }
    #[cfg(not(windows))]
    let _ = on;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must come first: a second launch hands its folder to this one and quits.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == BACKGROUND_ARG) {
                return;
            }
            show_main(app);
            if let Some(dir) = dir_arg(&args) {
                let _ = app.emit("open-dir", Some(dir));
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate::default())
        .manage(WatchState { watcher: Mutex::new(None), dirs: Mutex::new(HashSet::new()) })
        .setup(|app| {
            create_main_window(app.handle())?;
            create_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && KEEP_RUNNING.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit("window-hidden", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            places, pin_home, list_dir, list_many, cloud_pin, new_file, dir_size, cancel_dir_sizes, compress, extract, open_terminal, native_menu, properties,
            clipboard_write, clipboard_read, clipboard_clear, save_theme, set_ui_scale, preview_available, preview_show, preview_move, preview_hide, cancel_transfer, restore_trash,
            everything_available, everything, disk_free, disk_space, recent_files, resolve_link, folder_count, thumbnail, open_path, reveal, trash, rename, mkdir,
            transfer, read_text, rich_preview, search, watch, check_update, install_update, set_keep_running, set_run_at_login, quit
        ])
        .run(tauri::generate_context!())
        .expect("error while running Finder");
}
