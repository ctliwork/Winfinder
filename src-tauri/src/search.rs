//! Parallel recursive name search.

use crate::fsops::{entry_from, hidden_by_name, Entry};
use jwalk::{Parallelism, WalkDir};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static TOKEN: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
pub struct SearchResult {
    pub entries: Vec<Entry>,
    pub partial: bool,
    pub visited: usize,
}

const LIMIT: usize = 500;
const SKIP_DIRS: &[&str] = &["node_modules", "$recycle.bin", "system volume information", "windows", "winsxs"];

/// Returns None when a newer search started before this one finished.
pub fn search(root: &str, query: &str, show_hidden: bool) -> Option<SearchResult> {
    let token = TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
    let q = query.to_lowercase();
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut entries = Vec::new();
    let mut visited = 0usize;
    let mut partial = false;

    let walker = WalkDir::new(root)
        .skip_hidden(false)
        .follow_links(false)
        .parallelism(Parallelism::RayonNewPool(0))
        .process_read_dir(move |_depth, _path, _state, children| {
            children.retain(|c| match c {
                Ok(e) => {
                    let name = e.file_name.to_string_lossy();
                    if !show_hidden && hidden_by_name(&name) {
                        return false;
                    }
                    !(e.file_type.is_dir() && SKIP_DIRS.contains(&name.to_lowercase().as_str()))
                }
                Err(_) => false,
            });
        });

    for item in walker.into_iter().skip(1) {
        visited += 1;
        if visited % 256 == 0 {
            if TOKEN.load(Ordering::SeqCst) != token {
                return None;
            }
            if Instant::now() > deadline {
                partial = true;
                break;
            }
        }
        let Ok(e) = item else { continue };
        if e.file_name.to_string_lossy().to_lowercase().contains(&q) {
            let path = e.path();
            entries.push(entry_from(&path, std::fs::symlink_metadata(&path).ok()));
            if entries.len() >= LIMIT {
                partial = true;
                break;
            }
        }
    }
    Some(SearchResult { entries, partial, visited })
}

/// Everything's command-line client (es.exe), when it is installed.
#[cfg(windows)]
fn es_path() -> Option<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            dirs.push(std::path::PathBuf::from(&base).join("Everything"));
            dirs.push(std::path::PathBuf::from(base).join("Programs").join("Everything"));
        }
    }
    dirs.into_iter().map(|d| d.join("es.exe")).find(|p| p.is_file())
}

pub fn everything_available() -> bool {
    #[cfg(windows)]
    return es_path().is_some();
    #[cfg(not(windows))]
    false
}

/// Whole-PC search through Everything's index (instant, any drive).
/// None when Everything isn't installed or running.
pub fn everything(query: &str) -> Option<SearchResult> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let es = es_path()?;
        let run = |utf8: bool| {
            let mut cmd = std::process::Command::new(&es);
            // UTF-8 output keeps non-ASCII names intact; older es.exe lacks -cp.
            if utf8 {
                cmd.args(["-cp", "65001"]);
            }
            cmd.args(["-n", &LIMIT.to_string()]).args(query.split_whitespace()).creation_flags(CREATE_NO_WINDOW).output().ok()
        };
        let out = run(true).filter(|o| o.status.success()).or_else(|| run(false).filter(|o| o.status.success()))?;
        let text = String::from_utf8_lossy(&out.stdout);
        let entries: Vec<Entry> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| {
                let p = std::path::Path::new(l);
                entry_from(p, std::fs::symlink_metadata(p).ok())
            })
            .collect();
        let visited = entries.len();
        Some(SearchResult { partial: visited >= LIMIT, entries, visited })
    }
    #[cfg(not(windows))]
    {
        let _ = query;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_nested_matches_and_skips_hidden() {
        let d = std::env::temp_dir().join(format!("finder-win-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("a/b/c")).unwrap();
        fs::create_dir_all(d.join(".git/x")).unwrap();
        fs::write(d.join("a/b/c/報告-final.pdf"), "").unwrap();
        fs::write(d.join("a/報告.docx"), "").unwrap();
        fs::write(d.join(".git/x/報告.txt"), "").unwrap();
        let r = search(d.to_str().unwrap(), "報告", false).unwrap();
        let mut names: Vec<_> = r.entries.iter().map(|e| e.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["報告-final.pdf", "報告.docx"]);
        let r = search(d.to_str().unwrap(), "報告", true).unwrap();
        assert_eq!(r.entries.len(), 3);
    }
}
