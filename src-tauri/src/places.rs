//! Sidebar locations, drives and free space.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Clone)]
pub struct Place {
    pub id: String,
    pub label: String,
    pub path: String,
    pub icon: String,
}

#[derive(Serialize)]
pub struct Places {
    /// Known folders (Desktop, Documents, ...): used for names and badges.
    pub favorites: Vec<Place>,
    /// What the navigation pane lists as pinned. On Windows this is Explorer's
    /// own Quick Access list, so both apps show the same folders.
    pub pinned: Vec<Place>,
    /// True when `pinned` came from Explorer and pinning goes through it too.
    pub pinned_live: bool,
    /// OneDrive roots, listed above the pinned folders like Explorer does.
    pub cloud: Vec<Place>,
    pub locations: Vec<Place>,
    pub home: String,
    pub sep: String,
}

fn place(id: &str, label: &str, path: Option<PathBuf>, icon: &str) -> Option<Place> {
    let path = path?;
    path.is_dir().then(|| Place {
        id: id.into(),
        label: label.into(),
        path: path.to_string_lossy().into_owned(),
        icon: icon.into(),
    })
}

pub fn places() -> Places {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let user = home.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "個人".into());
    let favorites = [
        place("home", &user, Some(home.clone()), "home"),
        place("desktop", "桌面", dirs::desktop_dir(), "desktop"),
        place("documents", "文件", dirs::document_dir(), "doc"),
        place("downloads", "下載", dirs::download_dir(), "download"),
        place("pictures", "圖片", dirs::picture_dir(), "photo"),
        place("music", "音樂", dirs::audio_dir(), "music"),
        place("videos", "影片", dirs::video_dir(), "video"),
    ]
    .into_iter()
    .flatten()
    // Unconfigured XDG dirs fall back to $HOME; don't list home twice.
    .fold(Vec::<Place>::new(), |mut acc, p| {
        if !acc.iter().any(|q| q.path == p.path) {
            acc.push(p);
        }
        acc
    });
    #[cfg(windows)]
    let favorites: Vec<Place> = favorites.into_iter().map(|p| Place { label: shell::display_name(&p.path).unwrap_or(p.label), ..p }).collect();
    let live = quick_access(&favorites);
    let pinned_live = live.is_some();
    let pinned = live.unwrap_or_else(|| favorites.iter().filter(|p| p.id != "home").cloned().collect());
    Places {
        cloud: cloud(),
        pinned,
        pinned_live,
        favorites,
        locations: drives(),
        home: home.to_string_lossy().into_owned(),
        sep: std::path::MAIN_SEPARATOR.to_string(),
    }
}

#[cfg(windows)]
fn quick_access(known: &[Place]) -> Option<Vec<Place>> {
    let items = shell::quick_access()?;
    Some(
        items
            .into_iter()
            .map(|(path, label)| {
                let icon = known.iter().find(|k| k.path.eq_ignore_ascii_case(&path)).map_or("folder", |k| k.icon.as_str());
                Place { id: path.clone(), label, icon: icon.into(), path }
            })
            .collect(),
    )
}

#[cfg(not(windows))]
fn quick_access(_known: &[Place]) -> Option<Vec<Place>> {
    None
}

#[cfg(windows)]
fn cloud() -> Vec<Place> {
    // Same variables the OneDrive client sets; consumer and business can coexist.
    let mut out: Vec<Place> = Vec::new();
    for (var, personal) in [("OneDriveConsumer", true), ("OneDriveCommercial", false), ("OneDrive", true)] {
        let Some(dir) = std::env::var_os(var).map(PathBuf::from) else { continue };
        let path = dir.to_string_lossy().into_owned();
        if !dir.is_dir() || out.iter().any(|p| p.path.eq_ignore_ascii_case(&path)) {
            continue;
        }
        let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        // Business folders are already named "OneDrive - <org>".
        let label = if personal && !folder.contains(" - ") { "OneDrive - 個人".to_string() } else { folder };
        out.push(Place { id: format!("cloud:{path}"), label, path, icon: "cloud".into() });
    }
    out
}

#[cfg(not(windows))]
fn cloud() -> Vec<Place> {
    Vec::new()
}

/// Pins or unpins a folder in Explorer's Quick Access.
#[cfg(windows)]
pub fn pin_home(path: &str, pin: bool) -> Result<(), String> {
    shell::invoke_verb(path, if pin { "pintohome" } else { "unpinfromhome" })
}

#[cfg(not(windows))]
pub fn pin_home(_path: &str, _pin: bool) -> Result<(), String> {
    Err("unsupported".into())
}

#[cfg(windows)]
mod shell {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::PropertiesSystem::PSGetPropertyKeyFromName;
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, IEnumShellItems, IShellItem, IShellItem2, SHCreateItemFromParsingName, ShellExecuteExW,
        SEE_MASK_FLAG_NO_UI, SEE_MASK_INVOKEIDLIST, SHELLEXECUTEINFOW, SIGDN, SIGDN_FILESYSPATH, SIGDN_NORMALDISPLAY,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn name(item: &IShellItem, kind: SIGDN) -> Option<String> {
        unsafe {
            let p = item.GetDisplayName(kind).ok()?;
            let s = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as _));
            s
        }
    }

    fn item(parsing: &str) -> Option<IShellItem> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let w = wide(parsing);
            SHCreateItemFromParsingName(PCWSTR(w.as_ptr()), None).ok()
        }
    }

    /// The localized name Explorer shows (e.g. "下載" for Downloads).
    pub fn display_name(path: &str) -> Option<String> {
        name(&item(path)?, SIGDN_NORMALDISPLAY).filter(|s| !s.is_empty())
    }

    /// Folders pinned to Quick Access, in Explorer's order. Frequent (unpinned)
    /// folders are skipped, as in Explorer's navigation pane.
    pub fn quick_access() -> Option<Vec<(String, String)>> {
        unsafe {
            let root = item("shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}")?;
            let list: IEnumShellItems = root.BindToHandler(None, &BHID_EnumItems).ok()?;
            let mut key = Default::default();
            let pinned_key = PSGetPropertyKeyFromName(windows::core::w!("System.Home.IsPinned"), &mut key).ok().map(|_| key);
            let mut out = Vec::new();
            loop {
                let mut got = [None];
                if list.Next(&mut got, None).is_err() {
                    break;
                }
                let Some(it) = got[0].take() else { break };
                if let (Some(key), Ok(it2)) = (pinned_key.as_ref(), it.cast::<IShellItem2>()) {
                    // Older builds lack the property; then everything listed counts.
                    if let Ok(b) = it2.GetBool(key) {
                        if !b.as_bool() {
                            continue;
                        }
                    }
                }
                let Some(path) = name(&it, SIGDN_FILESYSPATH) else { continue }; // virtual items (Gallery, Network...)
                if !std::path::Path::new(&path).is_dir() {
                    continue;
                }
                let label = name(&it, SIGDN_NORMALDISPLAY).unwrap_or_else(|| path.clone());
                out.push((path, label));
            }
            Some(out)
        }
    }

    pub fn invoke_verb(path: &str, verb: &str) -> Result<(), String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let (p, v) = (wide(path), wide(verb));
            let mut info = SHELLEXECUTEINFOW {
                cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                fMask: SEE_MASK_INVOKEIDLIST | SEE_MASK_FLAG_NO_UI,
                lpVerb: PCWSTR(v.as_ptr()),
                lpFile: PCWSTR(p.as_ptr()),
                nShow: 1,
                ..Default::default()
            };
            ShellExecuteExW(&mut info).map_err(|e| e.message())
        }
    }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

#[cfg(windows)]
fn drives() -> Vec<Place> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;

    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| {
            let letter = (b'A' + i) as char;
            let root = format!("{letter}:\\");
            let w = wide(&root);
            let kind = unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) };
            // Querying a disconnected network share can block for seconds; skip it.
            let mut name = [0u16; 261];
            let label = if kind == DRIVE_REMOTE {
                String::new()
            } else if unsafe { GetVolumeInformationW(PCWSTR(w.as_ptr()), Some(&mut name), None, None, None, None) }.is_ok() {
                String::from_utf16_lossy(&name[..name.iter().position(|&c| c == 0).unwrap_or(0)])
            } else {
                String::new()
            };
            let fallback = match kind {
                DRIVE_REMOTE => "網路磁碟機",
                DRIVE_REMOVABLE => "卸除式磁碟",
                DRIVE_CDROM => "光碟機",
                _ => "本機磁碟",
            };
            let label = if label.is_empty() { fallback.to_string() } else { label };
            Place {
                id: root.clone(),
                label: format!("{label} ({letter}:)"),
                path: root,
                icon: "drive".into(),
            }
        })
        .collect()
}

#[cfg(not(windows))]
fn drives() -> Vec<Place> {
    let host = std::fs::read_to_string("/etc/hostname").map(|s| s.trim().to_string()).unwrap_or_default();
    vec![Place {
        id: "/".into(),
        label: if host.is_empty() { "電腦".into() } else { host },
        path: "/".into(),
        icon: "drive".into(),
    }]
}

#[derive(Serialize)]
pub struct Space {
    pub free: u64,
    pub total: u64,
}

pub fn disk_free(path: &str) -> Option<u64> {
    disk_space(path).map(|s| s.free)
}

#[cfg(windows)]
pub fn disk_space(path: &str) -> Option<Space> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let w = wide(path);
    let (mut free, mut total) = (0u64, 0u64);
    unsafe { GetDiskFreeSpaceExW(PCWSTR(w.as_ptr()), Some(&mut free), Some(&mut total), None) }.ok()?;
    Some(Space { free, total })
}

#[cfg(unix)]
pub fn disk_space(path: &str) -> Option<Space> {
    let c = std::ffi::CString::new(path).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let unit = s.f_frsize as u64;
    Some(Space { free: s.f_bavail as u64 * unit, total: s.f_blocks as u64 * unit })
}
