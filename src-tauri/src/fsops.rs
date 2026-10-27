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
    /// Hidden + system: Explorer's "protected operating system files" (e.g.
    /// the legacy "Application Data" / "My Documents" junctions, which can't
    /// be opened). Shown only when that is asked for separately.
    pub system: bool,
    pub link: bool,
    /// A folder that may have an icon of its own: Explorer reads a folder's
    /// desktop.ini (special folders, custom icons) only when it is read-only or
    /// system; links get an arrow. Any other folder shows the usual folder icon.
    pub own_icon: bool,
    /// Cloud sync status (see cloud::state); absent outside synced folders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud: Option<&'static str>,
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

const READONLY: u32 = 0x1;
const HIDDEN: u32 = 0x2;
const SYSTEM: u32 = 0x4;

#[cfg(windows)]
fn attrs(meta: &fs::Metadata) -> u32 {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes()
}

#[cfg(not(windows))]
fn attrs(_meta: &fs::Metadata) -> u32 {
    0
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
    let meta = if link || lmeta.is_none() { fs::metadata(path).ok().or_else(|| lmeta.clone()) } else { lmeta.clone() };
    let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    // A link's own attributes count: Windows marks its compatibility junctions
    // hidden + system while their targets are ordinary folders.
    let a = lmeta.as_ref().map(attrs).unwrap_or(0) | meta.as_ref().map(attrs).unwrap_or(0);
    let hidden = hidden_by_name(&name) || a & (HIDDEN | SYSTEM) != 0;
    let system = a & (HIDDEN | SYSTEM) == HIDDEN | SYSTEM;
    Entry {
        ext: ext_of(&name, is_dir),
        size: meta.as_ref().filter(|m| !m.is_dir()).map(|m| m.len()),
        mtime: meta.as_ref().and_then(|m| ms(m.modified())),
        birth: meta.as_ref().and_then(|m| ms(m.created())),
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir,
        hidden,
        system,
        link,
        own_icon: is_dir && (link || a & (READONLY | SYSTEM) != 0),
        cloud: crate::cloud::state(a, is_dir),
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
    let synced = crate::cloud::in_sync_root(dir);
    Ok(items
        .into_par_iter()
        .map(|(p, meta, cheap)| {
            let meta = if cheap { meta } else { fs::symlink_metadata(&p).ok() };
            let mut e = entry_from(&p, meta);
            if synced && e.cloud.is_none() && !e.is_dir {
                e.cloud = Some("local");
            }
            e
        })
        .collect())
}

/// Lists `dirs` and, level by level, the folders inside them, until `depth`
/// levels, `max_dirs` folders or `budget` time is reached. Used to read ahead
/// before a drag, when the app can't ask for listings until the drop.
pub fn list_many(dirs: &[String], depth: usize, max_dirs: usize, budget: std::time::Duration) -> Vec<(String, Vec<Entry>)> {
    let start = std::time::Instant::now();
    let mut out: Vec<(String, Vec<Entry>)> = Vec::new();
    let mut level: Vec<String> = dirs.to_vec();
    for _ in 0..depth {
        if level.is_empty() || out.len() >= max_dirs || start.elapsed() > budget {
            break;
        }
        level.truncate(max_dirs - out.len());
        let listed: Vec<(String, Vec<Entry>)> =
            level.par_iter().filter_map(|d| list(d).ok().map(|v| (d.clone(), v))).collect();
        level = listed
            .iter()
            .flat_map(|(_, v)| v.iter().filter(|e| e.is_dir && !e.link && !e.system).map(|e| e.path.clone()))
            .collect();
        out.extend(listed);
    }
    out
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

/// Creates an empty text file ("新文字文件.txt", "新文字文件 2.txt"…).
pub fn new_file(dir: &str) -> Result<String, String> {
    let target = unique_path(Path::new(dir), "新文字文件.txt");
    fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| code(&e))?;
    Ok(target.to_string_lossy().into_owned())
}

#[derive(Serialize, Default)]
pub struct DirSize {
    pub size: u64,
    pub files: u64,
    pub dirs: u64,
}

/// Bumped to stop the background sizes the list view asked for (see dir_size).
pub static SIZE_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Total size of everything under `dir` (links are not followed; unreadable
/// entries are skipped). A `background` request returns None once SIZE_GEN
/// moves on (the user left the folder).
pub fn dir_size(dir: &str, background: bool) -> Option<DirSize> {
    use std::sync::atomic::Ordering;
    let gen = SIZE_GEN.load(Ordering::SeqCst);
    let mut out = DirSize::default();
    for (i, e) in jwalk::WalkDir::new(dir).skip_hidden(false).follow_links(false).into_iter().skip(1).flatten().enumerate() {
        if background && i % 256 == 0 && SIZE_GEN.load(Ordering::SeqCst) != gen {
            return None;
        }
        if e.file_type().is_dir() {
            out.dirs += 1;
        } else if let Ok(m) = e.metadata() {
            out.files += 1;
            out.size += m.len();
        }
    }
    Some(out)
}

/// How a transfer treats a name that already exists in the destination.
#[derive(Clone, Copy, PartialEq)]
pub enum Conflict {
    /// "名稱 2" next to the existing item (the default).
    KeepBoth,
    /// Overwrite files; merge folders.
    Replace,
    Skip,
}

impl Conflict {
    pub fn parse(s: &str) -> Self {
        match s {
            "replace" => Conflict::Replace,
            "skip" => Conflict::Skip,
            _ => Conflict::KeepBoth,
        }
    }
}

/// Byte progress for a running transfer, with cancellation.
pub struct Progress<'a> {
    pub report: &'a (dyn Fn(u64, u64, &str) + Sync),
    pub cancel: &'a std::sync::atomic::AtomicBool,
    pub total: u64,
    done: std::cell::Cell<u64>,
    last: std::cell::Cell<std::time::Instant>,
}

impl<'a> Progress<'a> {
    pub fn new(report: &'a (dyn Fn(u64, u64, &str) + Sync), cancel: &'a std::sync::atomic::AtomicBool, total: u64) -> Self {
        Progress { report, cancel, total, done: 0.into(), last: std::time::Instant::now().into() }
    }
    fn add(&self, n: u64, name: &str) -> io::Result<()> {
        self.done.set(self.done.get() + n);
        if self.last.get().elapsed().as_millis() >= 100 {
            self.last.set(std::time::Instant::now());
            (self.report)(self.done.get(), self.total, name);
        }
        if self.cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "CANCELLED"));
        }
        Ok(())
    }
}

/// Bytes a copy of `paths` will write (links not followed).
pub fn total_size(paths: &[String]) -> u64 {
    paths
        .iter()
        .map(|p| match fs::symlink_metadata(p) {
            Ok(m) if m.is_dir() => dir_size(p, false).map_or(0, |d| d.size),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

fn copy_file(src: &Path, dst: &Path, progress: Option<&Progress>) -> io::Result<()> {
    let Some(p) = progress else {
        fs::copy(src, dst)?;
        return Ok(());
    };
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let result = (|| {
        let mut from = fs::File::open(src)?;
        let mut to = fs::File::create(dst)?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = from.read(&mut buf)?;
            if n == 0 {
                break;
            }
            io::Write::write_all(&mut to, &buf[..n])?;
            p.add(n as u64, &name)?;
        }
        // Keep what fs::copy would keep: permissions and the modified time.
        let meta = from.metadata()?;
        to.set_permissions(meta.permissions())?;
        if let Ok(t) = meta.modified() {
            let _ = to.set_modified(t);
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(dst);
    }
    result
}

/// Copies a file or folder. With `merge`, an existing folder at `dst` is
/// filled in and existing files are overwritten.
fn copy_tree(src: &Path, dst: &Path, merge: bool, progress: Option<&Progress>) -> io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.is_dir() {
        match fs::create_dir(dst) {
            Err(e) if merge && e.kind() == io::ErrorKind::AlreadyExists && dst.is_dir() => {}
            r => r?,
        }
        for e in fs::read_dir(src)? {
            let e = e?;
            copy_tree(&e.path(), &dst.join(e.file_name()), merge, progress)?;
        }
    } else {
        if merge && dst.is_dir() {
            fs::remove_dir_all(dst)?;
        }
        copy_file(src, dst, progress)?;
    }
    Ok(())
}

fn remove_any(p: &Path) -> io::Result<()> {
    if fs::symlink_metadata(p)?.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
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
    transfer_with(op, files, dest, Conflict::KeepBoth, None)
}

pub fn transfer_with(op: &str, files: &[String], dest: &str, conflict: Conflict, progress: Option<&Progress>) -> Vec<TransferResult> {
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
            if progress.is_some_and(|p| p.cancel.load(std::sync::atomic::Ordering::Relaxed)) {
                return fail("CANCELLED".into());
            }
            let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let direct = dest.join(&name);
            let exists = fs::symlink_metadata(&direct).is_ok() && src.parent() != Some(dest);
            let (target, merge) = match (exists, conflict) {
                (true, Conflict::Skip) => return fail("SKIPPED".into()),
                (true, Conflict::Replace) => (direct, true),
                _ => (unique_path(dest, &name), false),
            };
            let res = (|| {
                if op == "move" {
                    if merge && fs::symlink_metadata(&target)?.is_dir() != src.is_dir() {
                        remove_any(&target)?;
                    }
                    // A plain rename works within a volume unless a folder has to be merged.
                    let renamed = !(merge && target.is_dir()) && fs::rename(src, &target).is_ok();
                    if !renamed {
                        copy_tree(src, &target, merge, progress)?;
                        remove_any(src)?;
                    }
                    Ok(())
                } else {
                    if merge && fs::symlink_metadata(&target)?.is_dir() != src.is_dir() {
                        remove_any(&target)?;
                    }
                    copy_tree(src, &target, merge, progress)
                }
            })();
            match res {
                Ok(()) => TransferResult { src: src_s.clone(), path: Some(target.to_string_lossy().into_owned()), error: None },
                Err(e) if e.kind() == io::ErrorKind::Interrupted => fail("CANCELLED".into()),
                Err(e) => fail(code(&e)),
            }
        })
        .collect()
}

/// Puts items back from the Recycle Bin to where they were deleted from.
/// Returns the paths that could not be restored.
#[cfg(any(windows, all(unix, not(target_os = "macos"))))]
pub fn restore_trash(paths: &[String]) -> Vec<String> {
    let Ok(items) = trash::os_limited::list() else { return paths.to_vec() };
    let same = |a: &Path, b: &Path| a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase();
    let mut picked = Vec::new();
    let mut missing = Vec::new();
    for p in paths {
        let path = Path::new(p);
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            missing.push(p.clone());
            continue;
        };
        // The most recent deletion of that name from that folder.
        let hit = items
            .iter()
            .filter(|t| same(&t.original_parent, parent) && t.name.to_string_lossy().eq_ignore_ascii_case(&name.to_string_lossy()))
            .max_by_key(|t| t.time_deleted);
        match hit {
            Some(t) => picked.push(t.clone()),
            None => missing.push(p.clone()),
        }
    }
    if trash::os_limited::restore_all(picked.clone()).is_err() {
        // restore_all stops at the first conflict; report everything not back in place.
        missing.extend(picked.iter().map(|t| t.original_parent.join(&t.name)).filter(|p| !p.exists()).map(|p| p.to_string_lossy().into_owned()));
    }
    missing
}

#[cfg(not(any(windows, all(unix, not(target_os = "macos")))))]
pub fn restore_trash(paths: &[String]) -> Vec<String> {
    paths.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("winfinder-test-{name}-{}", std::process::id()));
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

    // Windows CI: the profile's legacy junctions count as protected system items.
    #[cfg(windows)]
    #[test]
    fn compatibility_junctions_are_system() {
        let home = std::env::var("USERPROFILE").unwrap();
        let v = list(&home).unwrap();
        let ad = v.iter().find(|e| e.name == "Application Data").expect("Application Data junction");
        assert!(ad.link && ad.hidden && ad.system);
        let desktop = v.iter().find(|e| e.name == "Desktop").expect("Desktop");
        assert!(!desktop.system);
    }

    #[test]
    fn reads_ahead_level_by_level() {
        let d = tmp("ahead");
        fs::create_dir_all(d.join("a/b/c")).unwrap();
        fs::create_dir_all(d.join("x")).unwrap();
        let root = d.to_string_lossy().into_owned();
        let got = list_many(&[root.clone()], 2, 100, std::time::Duration::from_secs(5));
        let names: Vec<_> = got.iter().map(|(p, _)| Path::new(p).file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(got.len(), 3); // root, a, x
        assert!(names.contains(&"a".to_string()) && names.contains(&"x".to_string()));
        assert_eq!(list_many(&[root], 5, 2, std::time::Duration::from_secs(5)).len(), 2); // capped
    }

    #[test]
    fn conflicts_and_progress() {
        use std::sync::atomic::AtomicBool;
        let d = tmp("conflict");
        let (a, b) = (d.join("a"), d.join("b"));
        fs::create_dir_all(a.join("f")).unwrap();
        fs::create_dir_all(b.join("f")).unwrap();
        fs::write(a.join("x.txt"), "new").unwrap();
        fs::write(b.join("x.txt"), "old").unwrap();
        fs::write(a.join("f").join("1.txt"), "1").unwrap();
        fs::write(b.join("f").join("2.txt"), "2").unwrap();
        let srcs: Vec<String> = ["x.txt", "f"].iter().map(|n| a.join(n).to_string_lossy().into_owned()).collect();
        let bs = b.to_str().unwrap();

        let r = transfer_with("copy", &srcs, bs, Conflict::Skip, None);
        assert!(r.iter().all(|r| r.error.as_deref() == Some("SKIPPED")));
        assert_eq!(fs::read_to_string(b.join("x.txt")).unwrap(), "old");

        let r = transfer_with("copy", &srcs, bs, Conflict::KeepBoth, None);
        assert!(r[0].path.as_ref().unwrap().ends_with("x 2.txt"));

        let seen = std::sync::Mutex::new(0u64);
        let report = |done: u64, _total: u64, _name: &str| *seen.lock().unwrap() = done;
        let cancel = AtomicBool::new(false);
        let p = Progress::new(&report, &cancel, total_size(&srcs));
        let r = transfer_with("move", &srcs, bs, Conflict::Replace, Some(&p));
        assert!(r.iter().all(|r| r.error.is_none()));
        assert_eq!(fs::read_to_string(b.join("x.txt")).unwrap(), "new");
        // Folders merge: both files are there.
        assert!(b.join("f").join("1.txt").exists() && b.join("f").join("2.txt").exists());
        assert!(!a.join("x.txt").exists() && !a.join("f").exists());

        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        fs::write(a.join("y.txt"), "y").unwrap();
        let p = Progress::new(&report, &cancel, 1);
        let r = transfer_with("copy", &[a.join("y.txt").to_string_lossy().into_owned()], bs, Conflict::KeepBoth, Some(&p));
        assert_eq!(r[0].error.as_deref(), Some("CANCELLED"));
        assert!(!b.join("y.txt").exists());
    }

    #[test]
    fn new_file_and_dir_size() {
        let d = tmp("size");
        let a = new_file(d.to_str().unwrap()).unwrap();
        let b = new_file(d.to_str().unwrap()).unwrap();
        assert!(a.ends_with("新文字文件.txt") && b.ends_with("新文字文件 2.txt"));
        fs::create_dir(d.join("sub")).unwrap();
        fs::write(d.join("sub").join("x.bin"), [0u8; 1000]).unwrap();
        let s = dir_size(d.to_str().unwrap(), false).unwrap();
        assert_eq!((s.size, s.files, s.dirs), (1000, 3, 1));
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
