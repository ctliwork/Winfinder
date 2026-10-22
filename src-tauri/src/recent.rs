//! Recently used files for the Home page, read from the OS's own list.

use crate::fsops::{entry_from, Entry};
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;

const LIMIT: usize = 20;

pub fn recent_files() -> Vec<Entry> {
    let mut seen = std::collections::HashSet::new();
    candidates()
        .into_iter()
        .filter(|p| p.is_file() && seen.insert(p.to_string_lossy().to_lowercase()))
        .take(LIMIT)
        .map(|p| entry_from(&p, std::fs::symlink_metadata(&p).ok()))
        .collect()
}

#[cfg(windows)]
fn candidates() -> Vec<PathBuf> {
    // %APPDATA%\Microsoft\Windows\Recent holds one .lnk per recently opened item.
    let Some(dir) = dirs::data_dir().map(|d| d.join("Microsoft").join("Windows").join("Recent")) else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut links: Vec<(std::time::SystemTime, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    links.sort_by(|a, b| b.0.cmp(&a.0));
    links.into_iter().take(LIMIT * 4).filter_map(|(_, p)| lnk_target(&p)).collect()
}

#[cfg(windows)]
fn lnk_target(link: &Path) -> Option<PathBuf> {
    // Malformed shortcuts must never take the app down.
    std::panic::catch_unwind(|| {
        let l = lnk::ShellLink::open(link, lnk::encoding::WINDOWS_1252).ok()?;
        let info = l.link_info().as_ref()?;
        let base = info
            .local_base_path_unicode()
            .clone()
            .or_else(|| info.local_base_path().map(str::to_owned))?;
        let suffix = info
            .common_path_suffix_unicode()
            .clone()
            .unwrap_or_else(|| info.common_path_suffix().to_string());
        Some(if suffix.is_empty() { PathBuf::from(base) } else { Path::new(&base).join(suffix) })
    })
    .ok()
    .flatten()
}

#[cfg(not(windows))]
fn candidates() -> Vec<PathBuf> {
    // freedesktop: ~/.local/share/recently-used.xbel, newest entries last.
    let Some(file) = dirs::data_local_dir().map(|d| d.join("recently-used.xbel")) else { return Vec::new() };
    let Ok(xml) = std::fs::read_to_string(file) else { return Vec::new() };
    let mut out: Vec<PathBuf> = xml
        .split("href=\"file://")
        .skip(1)
        .filter_map(|s| s.split('"').next())
        .map(|s| PathBuf::from(percent_decode(s)))
        .collect();
    out.reverse();
    out
}

#[cfg_attr(windows, allow(dead_code))]
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes_file_uris() {
        assert_eq!(super::percent_decode("/home/a/%E5%A0%B1%E5%91%8A%20v2.pdf"), "/home/a/報告 v2.pdf");
        assert_eq!(super::percent_decode("/x/100%"), "/x/100%");
    }
}
