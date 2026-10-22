//! ZIP compress / extract, like Explorer's "Compress to ZIP file" and "Extract All".

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

/// Extracts a ZIP into a new folder named after it, next to the ZIP. Entries
/// that would land outside that folder are skipped. Returns the folder.
pub fn extract(archive: &str) -> Result<String, String> {
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
}
