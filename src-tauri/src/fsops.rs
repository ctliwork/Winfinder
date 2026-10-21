//! File system operations exposed to the UI.

use rayon::prelude::*;
use serde::Serialize;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub mtime: Option<f64>,
    pub birth: Option<f64>,
    pub ext: String,
    pub hidden: bool,
    pub link: bool,
}

/// Maps an io::Error to the short codes the UI understands.
pub fn code(err: &io::Error) -> String {
    use io::ErrorKind::*;
    match err.kind() {
        PermissionDenied => "EACCES".into(),
        NotFound => "ENOENT".into(),
        AlreadyExists => "EXISTS".into(),
        NotADirectory => "ENOTDIR".into(),
        ResourceBusy => "EBUSY".into(),
        _ => err.to_string(),
    }
}

fn ms(t: io::Result<SystemTime>) -> Option<f64> {
    t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs_f64() * 1000.0)
}

const SYSTEM_NAMES: &[&str] = &[
    "desktop.ini", "thumbs.db", "$recycle.bin", "system volume information", "pagefile.sys",
    "hiberfil.sys", "swapfile.sys", "dumpstack.log", "dumpstack.log.tmp", "$windows.~bt",
    "$windows.~ws", "$winreagent", "config.msi", "documents and settings",
];

pub fn hidden_by_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    name.starts_with('.') || lower.starts_with("ntuser.") || SYSTEM_NAMES.contains(&lower.as_str())
}

#[cfg(windows)]
fn hidden_by_attr(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    meta.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn hidden_by_attr(_meta: &fs::Metadata) -> bool {
    false
}

fn ext_of(name: &str, is_dir: bool) -> String {
    if is_dir {
        return String::new();
    }
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Builds an entry. `lmeta` is the metadata of the link itself (cheap on Windows,
/// where directory enumeration already returns it).
pub fn entry_from(path: &Path, lmeta: Option<fs::Metadata>) -> Entry {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let link = lmeta.as_ref().map(|m| m.file_type().is_symlink()).unwrap_or(false);
    // Follow links so a link to a folder behaves like a folder.
    let meta = if link || lmeta.is_none() { fs::metadata(path).ok().or(lmeta) } else { lmeta };
    let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    let hidden = hidden_by_name(&name) || meta.as_ref().map(hidden_by_attr).unwrap_or(false);
    Entry {
        ext: ext_of(&name, is_dir),
        size: meta.as_ref().filter(|m| !m.is_dir()).map(|m| m.len()),
        mtime: meta.as_ref().and_then(|m| ms(m.modified())),
        birth: meta.as_ref().and_then(|m| ms(m.created())),
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir,
        hidden,
        link,
    }
}

pub fn list(dir: &str) -> Result<Vec<Entry>, String> {
    let rd = fs::read_dir(dir).map_err(|e| code(&e))?;
    let items: Vec<(PathBuf, Option<fs::Metadata>, bool)> = rd
        .filter_map(|r| r.ok())
        .map(|de| {
            // On Windows DirEntry::metadata comes from FindNextFile and costs nothing;
            // on Unix it is one lstat, which we run in parallel below.
            let cheap = cfg!(windows);
            let meta = if cheap { de.metadata().ok() } else { None };
            (de.path(), meta, cheap)
        })
        .collect();
    Ok(items
        .into_par_iter()
        .map(|(p, meta, cheap)| {
            let meta = if cheap { meta } else { fs::symlink_metadata(&p).ok() };
            entry_from(&p, meta)
        })
        .collect())
}

pub fn folder_count(dir: &str) -> Option<usize> {
    fs::read_dir(dir).ok().map(|r| r.count())
}

pub fn read_text(path: &str, max: usize) -> Result<(Option<String>, bool, bool), String> {
    let mut f = fs::File::open(path).map_err(|e| code(&e))?;
    let mut buf = vec![0u8; max];
    let mut n = 0;
    while n < max {
        let r = f.read(&mut buf[n..]).map_err(|e| code(&e))?;
        if r == 0 {
            break;
        }
        n += r;
    }
    buf.truncate(n);
    let head = &buf[..buf.len().min(8000)];
    if head.contains(&0) {
        return Ok((None, true, false));
    }
    // Cut at a char boundary if the read stopped mid-sequence.
    let text = match String::from_utf8(buf) {
        Ok(s) => s,
        Err(e) => {
            let valid = e.utf8_error().valid_up_to();
            let mut bytes = e.into_bytes();
            if bytes.len() - valid > 4 {
                String::from_utf8_lossy(&bytes).into_owned()
            } else {
                bytes.truncate(valid);
                String::from_utf8(bytes).unwrap_or_default()
            }
        }
    };
    Ok((Some(text), false, n == max))
}

fn invalid_name(name: &str) -> bool {
    name.is_empty() || name == "." || name == ".." || name.chars().any(|c| "\\/:*?\"<>|".contains(c) || c.is_control())
}

pub fn rename(path: &str, new_name: &str) -> Result<String, String> {
    if invalid_name(new_name) {
        return Err("INVALID".into());
    }
    let src = PathBuf::from(path);
    let target = src.with_file_name(new_name);
    if target == src {
        return Ok(path.into());
    }
    let case_only = target.to_string_lossy().to_lowercase() == src.to_string_lossy().to_lowercase();
    if !case_only && target.exists() {
        return Err("EXISTS".into());
    }
    fs::rename(&src, &target).map_err(|e| code(&e))?;
    Ok(target.to_string_lossy().into_owned())
}

/// "名稱 2.txt", "名稱 3.txt"… until the name is free.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() && fs::symlink_metadata(&candidate).is_err() {
        return candidate;
    }
    let p = Path::new(name);
    let (stem, ext) = match (p.file_stem(), p.extension()) {
        (Some(s), Some(e)) if !name.starts_with('.') || name.matches('.').count() > 1 => {
            (s.to_string_lossy().into_owned(), format!(".{}", e.to_string_lossy()))
        }
        _ => (name.to_string(), String::new()),
    };
    (2..)
        .map(|i| dir.join(format!("{stem} {i}{ext}")))
        .find(|c| fs::symlink_metadata(c).is_err())
        .unwrap()
}

pub fn mkdir(dir: &str) -> Result<String, String> {
    let target = unique_path(Path::new(dir), "未命名資料夾");
    fs::create_dir(&target).map_err(|e| code(&e))?;
    Ok(target.to_string_lossy().into_owned())
}

fn copy_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.is_dir() {
        fs::create_dir(dst)?;
        for e in fs::read_dir(src)? {
            let e = e?;
            copy_recursive(&e.path(), &dst.join(e.file_name()))?;
        }
    } else {
        fs::copy(src, dst)?;
    }
    Ok(())
}

fn is_inside(child: &Path, parent: &Path) -> bool {
    let c = child.to_string_lossy().to_lowercase();
    let p = parent.to_string_lossy().to_lowercase();
    c == p || c.starts_with(&format!("{}{}", p.trim_end_matches(std::path::MAIN_SEPARATOR), std::path::MAIN_SEPARATOR))
}

#[derive(Serialize)]
pub struct TransferResult {
    pub src: String,
    pub path: Option<String>,
    pub error: Option<String>,
}

pub fn transfer(op: &str, files: &[String], dest: &str) -> Vec<TransferResult> {
    let dest = Path::new(dest);
    files
        .iter()
        .map(|src_s| {
            let src = Path::new(src_s);
            let fail = |e: String| TransferResult { src: src_s.clone(), path: None, error: Some(e) };
            if is_inside(dest, src) {
                return fail("INTO_SELF".into());
            }
            if op == "move" && src.parent() == Some(dest) {
                return TransferResult { src: src_s.clone(), path: Some(src_s.clone()), error: None };
            }
            let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let target = unique_path(dest, &name);
            let res = if op == "move" {
                fs::rename(src, &target).or_else(|_| {
                    // Different volume: copy then delete.
                    copy_recursive(src, &target)?;
                    if src.is_dir() { fs::remove_dir_all(src) } else { fs::remove_file(src) }
                })
            } else {
                copy_recursive(src, &target)
            };
            match res {
                Ok(()) => TransferResult { src: src_s.clone(), path: Some(target.to_string_lossy().into_owned()), error: None },
                Err(e) => fail(code(&e)),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("finder-win-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lists_entries_with_metadata() {
        let d = tmp("list");
        fs::write(d.join("a.TXT"), "hi").unwrap();
        fs::create_dir(d.join("子資料夾")).unwrap();
        fs::write(d.join(".hidden"), "").unwrap();
        let mut v = list(d.to_str().unwrap()).unwrap();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(v.len(), 3);
        let a = v.iter().find(|e| e.name == "a.TXT").unwrap();
        assert_eq!(a.ext, "txt");
        assert_eq!(a.size, Some(2));
        assert!(!a.is_dir && !a.hidden && a.mtime.is_some());
        assert!(v.iter().find(|e| e.name == "子資料夾").unwrap().is_dir);
        assert!(v.iter().find(|e| e.name == ".hidden").unwrap().hidden);
    }

    #[test]
    fn unique_names_and_mkdir() {
        let d = tmp("uniq");
        fs::write(d.join("報告.pdf"), "").unwrap();
        assert_eq!(unique_path(&d, "報告.pdf").file_name().unwrap(), "報告 2.pdf");
        let a = mkdir(d.to_str().unwrap()).unwrap();
        let b = mkdir(d.to_str().unwrap()).unwrap();
        assert!(a.ends_with("未命名資料夾"));
        assert!(b.ends_with("未命名資料夾 2"));
    }

    #[test]
    fn rename_rules() {
        let d = tmp("rename");
        fs::write(d.join("x.txt"), "").unwrap();
        fs::write(d.join("y.txt"), "").unwrap();
        let x = d.join("x.txt").to_string_lossy().into_owned();
        assert_eq!(rename(&x, "a/b").unwrap_err(), "INVALID");
        assert_eq!(rename(&x, "y.txt").unwrap_err(), "EXISTS");
        assert!(rename(&x, "z.txt").unwrap().ends_with("z.txt"));
    }

    #[test]
    fn copy_and_move() {
        let d = tmp("xfer");
        let src = d.join("src");
        fs::create_dir_all(src.join("inner")).unwrap();
        fs::write(src.join("inner/f.txt"), "data").unwrap();
        let dest = d.join("dest");
        fs::create_dir(&dest).unwrap();
        let s = src.to_string_lossy().into_owned();
        let r = transfer("copy", &[s.clone()], dest.to_str().unwrap());
        assert!(r[0].error.is_none());
        assert_eq!(fs::read_to_string(dest.join("src/inner/f.txt")).unwrap(), "data");
        // Copying again picks a new name; moving into itself is refused.
        let r = transfer("copy", &[s.clone()], dest.to_str().unwrap());
        assert!(r[0].path.as_ref().unwrap().ends_with("src 2"));
        let r = transfer("move", &[s.clone()], src.join("inner").to_str().unwrap());
        assert_eq!(r[0].error.as_deref(), Some("INTO_SELF"));
        let r = transfer("move", &[s.clone()], dest.to_str().unwrap());
        assert!(r[0].error.is_none() && !src.exists());
    }

    #[test]
    fn reads_text_and_detects_binary() {
        let d = tmp("text");
        fs::write(d.join("t.md"), "中文內容").unwrap();
        fs::write(d.join("b.bin"), [0u8, 1, 2]).unwrap();
        let (t, bin, _) = read_text(d.join("t.md").to_str().unwrap(), 1024).unwrap();
        assert_eq!(t.as_deref(), Some("中文內容") );
        assert!(!bin);
        let (_, bin, _) = read_text(d.join("b.bin").to_str().unwrap(), 1024).unwrap();
        assert!(bin);
        // Truncating in the middle of a multi-byte char must not fail.
        let (t, _, truncated) = read_text(d.join("t.md").to_str().unwrap(), 4).unwrap();
        assert_eq!(t.as_deref(), Some("中"));
        assert!(truncated);
    }
}
