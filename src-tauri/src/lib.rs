mod archive;
#[doc(hidden)]
pub mod fsops;
mod places;
mod preview;
mod recent;
mod search;
mod thumb;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State, WebviewUrl, WebviewWindowBuilder};
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

#[tauri::command]
async fn disk_free(path: String) -> Option<u64> {
    blocking(move || places::disk_free(&path)).await.ok().flatten()
}

#[tauri::command]
async fn disk_space(path: String) -> Option<places::Space> {
    blocking(move || places::disk_space(&path)).await.ok().flatten()
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

#[tauri::command]
async fn transfer(op: String, files: Vec<String>, dest: String) -> Result<Vec<fsops::TransferResult>, String> {
    blocking(move || fsops::transfer(&op, &files, &dest)).await
}

#[tauri::command]
fn new_file(dir: String) -> Result<String, String> {
    fsops::new_file(&dir)
}

#[tauri::command]
async fn dir_size(path: String) -> Result<fsops::DirSize, String> {
    blocking(move || fsops::dir_size(&path)).await
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
async fn search(root: String, query: String, show_hidden: bool) -> Option<search::SearchResult> {
    blocking(move || search::search(&root, &query, show_hidden)).await.ok().flatten()
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
fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let start_dir = std::env::args()
        .find_map(|a| a.strip_prefix("--dir=").map(str::to_owned))
        .or_else(|| std::env::args().nth(1).filter(|a| std::path::Path::new(a).is_dir()));

    #[cfg(windows)]
    let (platform, material) = {
        let win11 = windows_version::OsVersion::current().build >= 22000;
        ("win32", if win11 { "mica" } else { "none" })
    };
    #[cfg(target_os = "macos")]
    let (platform, material) = ("darwin", "none");
    #[cfg(all(unix, not(target_os = "macos")))]
    let (platform, material) = ("linux", "none");

    let env = serde_json::json!({
        "platform": platform,
        "material": material,
        "dir": start_dir,
        "sep": std::path::MAIN_SEPARATOR.to_string(),
    });

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Finder")
        .inner_size(1180.0, 740.0)
        .min_inner_size(680.0, 420.0)
        .decorations(false)
        .visible(false)
        .initialization_script(&format!("window.__finderEnv = {env};"));

    #[cfg(windows)]
    {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::Effect;
        builder = builder.shadow(true);
        if material == "mica" {
            // Mica keeps resizing smooth; acrylic lags on some Windows 11 builds.
            builder = builder
                .transparent(true)
                .effects(WindowEffectsConfig { effects: vec![Effect::Mica], ..Default::default() });
        }
    }

    let window = builder.build()?;
    // Show the window even if the page never signals readiness.
    let w = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let _ = w.show();
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate::default())
        .manage(WatchState { watcher: Mutex::new(None), dirs: Mutex::new(HashSet::new()) })
        .setup(|app| {
            create_main_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            places, pin_home, list_dir, new_file, dir_size, compress, extract, open_terminal, disk_free, disk_space, recent_files, folder_count, thumbnail, open_path, reveal, trash, rename, mkdir,
            transfer, read_text, rich_preview, search, watch, check_update, install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running Finder");
}
