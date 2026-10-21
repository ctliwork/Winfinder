//! Sidebar locations, drives and free space.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct Place {
    pub id: String,
    pub label: String,
    pub path: String,
    pub icon: String,
}

#[derive(Serialize)]
pub struct Places {
    pub favorites: Vec<Place>,
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
        place("downloads", "下載項目", dirs::download_dir(), "download"),
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
    Places {
        favorites,
        locations: drives(),
        home: home.to_string_lossy().into_owned(),
        sep: std::path::MAIN_SEPARATOR.to_string(),
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

#[cfg(windows)]
pub fn disk_free(path: &str) -> Option<u64> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let w = wide(path);
    let mut avail = 0u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(w.as_ptr()), Some(&mut avail), None, None) }.ok()?;
    Some(avail)
}

#[cfg(unix)]
pub fn disk_free(path: &str) -> Option<u64> {
    let c = std::ffi::CString::new(path).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    Some(s.f_bavail as u64 * s.f_frsize as u64)
}
