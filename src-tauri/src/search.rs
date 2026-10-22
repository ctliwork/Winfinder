//! Parallel recursive name search.

use crate::fsops::{entry_from, hidden_by_name, Entry};
use jwalk::{Parallelism, WalkDir};
use serde::{Deserialize, Serialize};
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

/// The search bar's type / size / date filters, applied while walking so the
/// result limit counts only matches.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    /// Some(true): folders only.
    pub dirs: Option<bool>,
    /// Files with one of these extensions (lowercase, no dot).
    pub exts: Option<Vec<String>>,
    /// Files larger / smaller than this many bytes.
    pub larger: Option<u64>,
    pub smaller: Option<u64>,
    /// Modified after this time (ms since the epoch).
    pub after: Option<f64>,
}

impl Filter {
    pub fn passes(&self, e: &Entry) -> bool {
        if self.dirs.is_some_and(|d| d != e.is_dir) {
            return false;
        }
        if let Some(exts) = &self.exts {
            if e.is_dir || !exts.contains(&e.ext) {
                return false;
            }
        }
        if self.larger.is_some() || self.smaller.is_some() {
            let size = e.size.unwrap_or(0);
            if e.is_dir || self.larger.is_some_and(|n| size <= n) || self.smaller.is_some_and(|n| size >= n) {
                return false;
            }
        }
        !self.after.is_some_and(|t| e.mtime.unwrap_or(0.0) < t)
    }
}

/// Returns None when a newer search started before this one finished.
pub fn search(root: &str, query: &str, show_hidden: bool, filter: &Filter) -> Option<SearchResult> {
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
            let entry = entry_from(&path, std::fs::symlink_metadata(&path).ok());
            if !filter.passes(&entry) {
                continue;
            }
            entries.push(entry);
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
        let none = Filter::default();
        let r = search(d.to_str().unwrap(), "報告", false, &none).unwrap();
        let mut names: Vec<_> = r.entries.iter().map(|e| e.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["報告-final.pdf", "報告.docx"]);
        let r = search(d.to_str().unwrap(), "報告", true, &none).unwrap();
        assert_eq!(r.entries.len(), 3);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn filters_apply_while_walking() {
        let d = std::env::temp_dir().join(format!("finder-win-filter-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("photos/old")).unwrap();
        fs::write(d.join("photos/a.jpg"), vec![0u8; 2000]).unwrap();
        fs::write(d.join("photos/old/b.PNG"), "x").unwrap();
        fs::write(d.join("notes.txt"), "x").unwrap();
        let root = d.to_str().unwrap();
        let names = |f: &Filter| {
            let mut v: Vec<_> = search(root, "", false, f).unwrap().entries.into_iter().map(|e| e.name).collect();
            v.sort();
            v
        };
        let images = Filter { exts: Some(vec!["jpg".into(), "png".into()]), ..Default::default() };
        assert_eq!(names(&images), vec!["a.jpg", "b.PNG"]);
        assert_eq!(names(&Filter { dirs: Some(true), ..Default::default() }), vec!["old", "photos"]);
        assert_eq!(names(&Filter { larger: Some(1000), ..Default::default() }), vec!["a.jpg"]);
        assert_eq!(names(&Filter { smaller: Some(1000), ..Default::default() }), vec!["b.PNG", "notes.txt"]);
        assert!(names(&Filter { after: Some(f64::MAX), ..Default::default() }).is_empty());
        let _ = fs::remove_dir_all(&d);
    }
}
