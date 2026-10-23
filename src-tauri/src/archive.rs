//! ZIP compress / extract, like Explorer's "Compress to ZIP file" and "Extract All",
//! and other archives (7z, RAR, TAR…) listed and extracted through 7-Zip when it is
//! installed, or Windows' own tar.exe.

use crate::fsops::{code, unique_path};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use zip::write::SimpleFileOptions;

fn zerr(e: zip::result::ZipError) -> String {
    match e {
        zip::result::ZipError::Io(e) => code(&e),
        other => other.to_string(),
    }
}

/// Packs `paths` (files or folders, all in one folder) into a new ZIP next to
/// them. One item → "<name>.zip"; several → "封存.zip". Returns the ZIP's path.
pub fn compress(paths: &[String]) -> Result<String, String> {
    let first = Path::new(paths.first().ok_or("ENOENT")?);
    let dir = first.parent().ok_or("ENOENT")?;
    let name = if paths.len() == 1 {
        let stem = if first.is_dir() { first.file_name() } else { first.file_stem() };
        format!("{}.zip", stem.map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "封存".into()))
    } else {
        "封存.zip".into()
    };
    let target = unique_path(dir, &name);
    let result = (|| {
        let mut zip = zip::ZipWriter::new(io::BufWriter::new(fs::File::create(&target).map_err(|e| code(&e))?));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
        for p in paths {
            let p = Path::new(p);
            let base = p.file_name().ok_or("ENOENT")?.to_string_lossy().into_owned();
            add(&mut zip, p, &base, opts)?;
        }
        zip.finish().map_err(zerr)?;
        Ok(target.to_string_lossy().into_owned())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&target);
    }
    result
}

fn add<W: io::Write + io::Seek>(zip: &mut zip::ZipWriter<W>, path: &Path, name: &str, opts: SimpleFileOptions) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| code(&e))?;
    if meta.is_dir() {
        zip.add_directory(format!("{name}/"), opts).map_err(zerr)?;
        let mut kids: Vec<_> = fs::read_dir(path).map_err(|e| code(&e))?.filter_map(|e| e.ok()).collect();
        kids.sort_by_key(|e| e.file_name());
        for kid in kids {
            add(zip, &kid.path(), &format!("{name}/{}", kid.file_name().to_string_lossy()), opts)?;
        }
    } else if meta.is_file() {
        zip.start_file(name, opts).map_err(zerr)?;
        io::copy(&mut fs::File::open(path).map_err(|e| code(&e))?, zip).map_err(|e| code(&e))?;
    }
    Ok(())
}

/// Extracts an archive into a new folder named after it, next to it. Entries
/// that would land outside that folder are skipped. Returns the folder.
pub fn extract(archive: &str) -> Result<String, String> {
    if !ext_of(archive).eq_ignore_ascii_case("zip") {
        return extract_other(archive);
    }
    let src = Path::new(archive);
    let dir = src.parent().ok_or("ENOENT")?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "封存".into());
    let mut zip = zip::ZipArchive::new(fs::File::open(src).map_err(|e| code(&e))?).map_err(zerr)?;
    let target = unique_path(dir, &stem);
    fs::create_dir(&target).map_err(|e| code(&e))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(zerr)?;
        let Some(rel) = entry.enclosed_name() else { continue };
        if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
            continue;
        }
        let out: PathBuf = target.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| code(&e))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| code(&e))?;
        }
        let mut f = fs::File::create(&out).map_err(|e| code(&e))?;
        io::copy(&mut entry, &mut f).map_err(|e| code(&e))?;
    }
    Ok(target.to_string_lossy().into_owned())
}

// ---------- other formats ----------

/// Archives listed and extracted through 7-Zip or tar.exe.
pub const OTHER: &[&str] = &["7z", "rar", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "iso", "cab"];

fn ext_of(path: &str) -> String {
    Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// "a.tar.gz", "a.tgz": a tar inside a compressed file.
fn is_tarball(path: &str) -> bool {
    let p = Path::new(path);
    matches!(ext_of(path).as_str(), "tar" | "tgz" | "tbz2" | "txz")
        || p.file_stem().is_some_and(|s| s.to_string_lossy().to_lowercase().ends_with(".tar"))
}

/// 7-Zip's command-line program, if 7-Zip is installed.
fn seven_zip() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let mut tries: Vec<PathBuf> = reg_7zip_dir().into_iter().collect();
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(d) = std::env::var_os(var) {
                tries.push(PathBuf::from(d).join("7-Zip"));
            }
        }
        tries.into_iter().map(|d| d.join("7z.exe")).find(|p| p.is_file())
    }
    #[cfg(not(windows))]
    {
        in_path(&["7z", "7zz", "7za"])
    }
}

/// tar.exe (libarchive), part of Windows 10 and 11.
fn tar() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let p = PathBuf::from(std::env::var_os("SystemRoot")?).join("System32").join("tar.exe");
        p.is_file().then_some(p)
    }
    #[cfg(not(windows))]
    {
        in_path(&["bsdtar"])
    }
}

#[cfg(not(windows))]
fn in_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

/// Where the 7-Zip installer recorded itself (HKLM or HKCU\SOFTWARE\7-Zip, "Path").
#[cfg(windows)]
fn reg_7zip_dir() -> Option<PathBuf> {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let mut buf = [0u16; 520];
        let mut size = (buf.len() * 2) as u32;
        let r = unsafe { RegGetValueW(root, w!("SOFTWARE\\7-Zip"), w!("Path"), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as _), Some(&mut size)) };
        if r.is_ok() {
            let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            return Some(PathBuf::from(String::from_utf16_lossy(&buf[..n])));
        }
    }
    None
}

/// Runs a tool without a console window, with no input (so a password prompt fails instead of waiting).
fn run(exe: &Path, args: &[&std::ffi::OsStr]) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.output().map_err(|e| code(&e))
}

fn failure(out: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&out.stderr);
    let line = text.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("");
    if line.to_lowercase().contains("password") {
        "PASSWORD".into()
    } else if line.is_empty() {
        "BAD_ARCHIVE".into()
    } else {
        line.to_string()
    }
}

/// An archive entry: name (with "/"), size, is a folder.
pub type Listed = (String, u64, bool);

/// The archive's entries, at most `limit`, and how many there are.
pub fn list_other(path: &str, limit: usize) -> Result<(Vec<Listed>, usize), String> {
    let exe = seven_zip().ok_or("NO_7ZIP")?;
    let out = run(&exe, &["l".as_ref(), "-slt".as_ref(), "-ba".as_ref(), "-sccUTF-8".as_ref(), "--".as_ref(), path.as_ref()])?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let (mut entries, mut total) = (Vec::new(), 0usize);
    let mut cur: Option<Listed> = None;
    let mut flush = |cur: &mut Option<Listed>| {
        if let Some(e) = cur.take() {
            total += 1;
            if entries.len() < limit {
                entries.push(e);
            }
        }
    };
    for line in text.lines() {
        let Some((key, value)) = line.split_once(" = ").or_else(|| line.strip_suffix(" =").map(|k| (k, ""))) else { continue };
        match key {
            "Path" => {
                flush(&mut cur);
                cur = Some((value.replace('\\', "/"), 0, false));
            }
            "Size" => {
                if let Some(c) = cur.as_mut() {
                    c.1 = value.parse().unwrap_or(0);
                }
            }
            "Folder" if value == "+" => {
                if let Some(c) = cur.as_mut() {
                    c.2 = true;
                }
            }
            "Attributes" if value.starts_with('D') => {
                if let Some(c) = cur.as_mut() {
                    c.2 = true;
                }
            }
            _ => {}
        }
    }
    flush(&mut cur);
    Ok((entries, total))
}

fn extract_other(archive: &str) -> Result<String, String> {
    let src = Path::new(archive);
    let dir = src.parent().ok_or("ENOENT")?;
    let mut stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "封存".into());
    if stem.to_lowercase().ends_with(".tar") {
        stem.truncate(stem.len() - 4);
    }
    // tar unpacks "a.tar.gz" in one go; 7-Zip would stop at the inner .tar.
    let (seven, tar) = (seven_zip(), tar());
    let tools: Vec<(PathBuf, bool)> = if is_tarball(archive) {
        tar.map(|t| (t, true)).into_iter().chain(seven.map(|s| (s, false))).collect()
    } else {
        seven.map(|s| (s, false)).into_iter().chain(tar.map(|t| (t, true))).collect()
    };
    if tools.is_empty() {
        return Err("NO_7ZIP".into());
    }
    let target = unique_path(dir, &stem);
    let mut last = String::new();
    for (exe, is_tar) in tools {
        fs::create_dir(&target).map_err(|e| code(&e))?;
        let out = if is_tar {
            run(&exe, &["-xf".as_ref(), archive.as_ref(), "-C".as_ref(), target.as_os_str()])?
        } else {
            let to = format!("-o{}", target.display());
            run(&exe, &["x".as_ref(), "-y".as_ref(), to.as_ref(), "--".as_ref(), archive.as_ref()])?
        };
        if out.status.success() {
            return Ok(target.to_string_lossy().into_owned());
        }
        last = failure(&out);
        let _ = fs::remove_dir_all(&target);
        if last == "PASSWORD" {
            break;
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let d = std::env::temp_dir().join(format!("finder-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("資料夾/子/空")).unwrap();
        fs::write(d.join("資料夾/a.txt"), "hello").unwrap();
        fs::write(d.join("資料夾/子/b.txt"), "世界").unwrap();
        fs::write(d.join("c.txt"), "c").unwrap();

        let one = compress(&[d.join("資料夾").to_string_lossy().into_owned()]).unwrap();
        assert!(one.ends_with("資料夾.zip"));
        let both = compress(&[d.join("資料夾").to_string_lossy().into_owned(), d.join("c.txt").to_string_lossy().into_owned()]).unwrap();
        assert!(both.ends_with("封存.zip"));

        let out = PathBuf::from(extract(&both).unwrap());
        assert!(out.ends_with("封存"));
        assert_eq!(fs::read_to_string(out.join("資料夾/a.txt")).unwrap(), "hello");
        assert_eq!(fs::read_to_string(out.join("資料夾/子/b.txt")).unwrap(), "世界");
        assert!(out.join("資料夾/子/空").is_dir());
        assert_eq!(fs::read_to_string(out.join("c.txt")).unwrap(), "c");
        // A second extract doesn't overwrite the first.
        assert!(extract(&both).unwrap().ends_with("封存 2"));
        fs::remove_dir_all(&d).unwrap();
    }

    /// Needs 7-Zip and tar (skipped without them): lists and extracts a 7z, extracts a .tar.gz.
    #[test]
    fn other_formats() {
        let (Some(seven), Some(tar)) = (seven_zip(), tar()) else { return };
        let d = std::env::temp_dir().join(format!("finder-7z-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("src/資料夾")).unwrap();
        fs::write(d.join("src/讀我.txt"), "hello").unwrap();
        fs::write(d.join("src/資料夾/b.txt"), "世界").unwrap();
        let src = d.join("src");
        let a7z = d.join("a.7z");
        assert!(std::process::Command::new(&seven).arg("a").arg("-bd").arg(&a7z).arg(".").current_dir(&src).output().unwrap().status.success());
        let tgz = d.join("b.tar.gz");
        assert!(std::process::Command::new(&tar).arg("-czf").arg(&tgz).arg(".").current_dir(&src).output().unwrap().status.success());

        let (entries, total) = list_other(&a7z.to_string_lossy(), 2000).unwrap();
        assert_eq!(total, 3);
        assert!(entries.contains(&("讀我.txt".into(), 5, false)));
        assert!(entries.contains(&("資料夾".into(), 0, true)));
        assert!(entries.contains(&("資料夾/b.txt".into(), "世界".len() as u64, false)));

        let out = PathBuf::from(extract(&a7z.to_string_lossy()).unwrap());
        assert!(out.ends_with("a"));
        assert_eq!(fs::read_to_string(out.join("資料夾/b.txt")).unwrap(), "世界");
        let out = PathBuf::from(extract(&tgz.to_string_lossy()).unwrap());
        assert!(out.ends_with("b"));
        assert_eq!(fs::read_to_string(out.join("讀我.txt")).unwrap(), "hello");

        fs::write(d.join("broken.7z"), "not an archive").unwrap();
        assert!(extract(&d.join("broken.7z").to_string_lossy()).is_err());
        assert!(!d.join("broken").exists());
        fs::remove_dir_all(&d).unwrap();
    }
}
