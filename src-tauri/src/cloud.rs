//! OneDrive (and other cloud-files providers) sync status, read from the file
//! attributes the directory listing already returns, and Explorer's
//! "Always keep on this device" / "Free up space" through the Cloud Files API.

const OFFLINE: u32 = 0x1000;
const RECALL_ON_OPEN: u32 = 0x0004_0000;
const PINNED: u32 = 0x0008_0000;
const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

/// The status Explorer shows in its Status column, as far as attributes tell:
/// "online" (only in the cloud), "pinned" (always kept on this device) or
/// "downloading" (pinned but not here yet).
/// Files that are simply available locally get "local" from `list` once the
/// folder is known to be in a sync root, since nothing in their attributes says so.
pub fn state(attrs: u32, is_dir: bool) -> Option<&'static str> {
    let online = attrs & (RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE) != 0;
    // A folder that was opened keeps RECALL_ON_OPEN off but its files may still be online-only.
    let online = if is_dir { attrs & (RECALL_ON_OPEN | OFFLINE) != 0 } else { online };
    if attrs & PINNED != 0 {
        Some(if online && !is_dir { "downloading" } else { "pinned" })
    } else if online {
        Some("online")
    } else {
        None
    }
}

/// True when `dir` is inside a folder synced by a cloud-files provider (OneDrive, iCloud, Dropbox...).
#[cfg(windows)]
pub fn in_sync_root(dir: &str) -> bool {
    use windows::core::HSTRING;
    use windows::Win32::Storage::CloudFilters::{CfGetSyncRootInfoByPath, CF_SYNC_ROOT_INFO_BASIC};
    // CF_SYNC_ROOT_BASIC_INFO is a single 64-bit file ID.
    let mut info = 0i64;
    let mut len = 0u32;
    unsafe {
        CfGetSyncRootInfoByPath(&HSTRING::from(dir), CF_SYNC_ROOT_INFO_BASIC, &mut info as *mut i64 as _, 8, Some(&mut len)).is_ok()
    }
}

#[cfg(not(windows))]
pub fn in_sync_root(_dir: &str) -> bool {
    false
}

/// Sets each path's pin state, folders recursively: "pinned" (always keep on this
/// device), "unpinned" (free up space) or "unspecified" (back to the default).
/// Returns the paths that failed.
#[cfg(windows)]
pub fn set_pin_state(paths: &[String], state: &str) -> Vec<String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::CloudFilters::{
        CfSetPinState, CF_PIN_STATE_PINNED, CF_PIN_STATE_UNPINNED, CF_PIN_STATE_UNSPECIFIED, CF_SET_PIN_FLAG_RECURSE,
    };
    use windows::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_DATA};
    let state = match state {
        "pinned" => CF_PIN_STATE_PINNED,
        "unpinned" => CF_PIN_STATE_UNPINNED,
        _ => CF_PIN_STATE_UNSPECIFIED,
    };
    paths
        .iter()
        .filter(|p| {
            // Opening a handle doesn't download anything; FILE_READ_DATA is the access CfSetPinState asks for.
            let Ok(f) = std::fs::OpenOptions::new()
                .access_mode(FILE_READ_DATA.0)
                .share_mode(7) // read | write | delete
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0) // needed to open folders
                .open(p)
            else {
                return true;
            };
            unsafe { CfSetPinState(HANDLE(f.as_raw_handle()), state, CF_SET_PIN_FLAG_RECURSE, None) }.is_err()
        })
        .cloned()
        .collect()
}

#[cfg(not(windows))]
pub fn set_pin_state(paths: &[String], _state: &str) -> Vec<String> {
    paths.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_attributes_to_states() {
        assert_eq!(state(0x20, false), None);
        assert_eq!(state(RECALL_ON_DATA_ACCESS | 0x400, false), Some("online"));
        assert_eq!(state(PINNED, false), Some("pinned"));
        assert_eq!(state(PINNED | RECALL_ON_DATA_ACCESS, false), Some("downloading"));
        // Unpinned ("free up space") but still here: just available locally.
        assert_eq!(state(0x0010_0000, false), None);
        assert_eq!(state(0x0010_0000 | RECALL_ON_DATA_ACCESS, false), Some("online"));
        // Folders: only their own placeholder state counts.
        assert_eq!(state(0x10 | RECALL_ON_OPEN, true), Some("online"));
        assert_eq!(state(0x10 | RECALL_ON_DATA_ACCESS, true), None);
        assert_eq!(state(0x10 | PINNED | RECALL_ON_OPEN, true), Some("pinned"));
    }

    /// An ordinary folder isn't a sync root, and pinning one of its files fails cleanly.
    #[cfg(windows)]
    #[test]
    fn plain_files_on_windows() {
        let d = std::env::temp_dir().join(format!("finder-cloud-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        assert!(!in_sync_root(&d.to_string_lossy()));
        let path = f.to_string_lossy().into_owned();
        assert_eq!(set_pin_state(std::slice::from_ref(&path), "pinned"), vec![path.clone()]);
        assert_eq!(set_pin_state(&[d.join("missing").to_string_lossy().into_owned()], "unpinned").len(), 1);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
