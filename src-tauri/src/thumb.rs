//! Shell thumbnails (Windows): images, videos, PDFs and Office files, or the
//! file's icon when no thumbnail provider exists. Other platforms return None
//! and the UI falls back to loading images directly.

use std::collections::HashMap;
use std::sync::Mutex;

static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

pub fn thumbnail(path: &str, size: i32) -> Option<String> {
    let key = format!("{path}|{size}");
    if let Some(hit) = CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&key) {
        return hit.clone();
    }
    let value = platform_thumbnail(path, size);
    let mut cache = CACHE.lock().unwrap();
    let map = cache.get_or_insert_with(HashMap::new);
    if map.len() > 4000 {
        map.clear();
    }
    map.insert(key, value.clone());
    value
}

#[cfg_attr(not(windows), allow(dead_code))]
fn encode_png(rgba: &[u8], w: u32, h: u32) -> Option<String> {
    use base64::Engine;
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
}

#[cfg(windows)]
fn platform_thumbnail(path: &str, size: i32) -> Option<String> {
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK};

    unsafe {
        // Each worker thread needs COM; repeated calls on the same thread are harmless.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let factory: IShellItemImageFactory = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok()?;
        let hbmp = factory.GetImage(SIZE { cx: size, cy: size }, SIIGBF_BIGGERSIZEOK).ok()?;
        let obj = HGDIOBJ(hbmp.0);

        let mut bm = BITMAP::default();
        let got = GetObjectW(obj, std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void));
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        if got == 0 || w <= 0 || h <= 0 {
            let _ = DeleteObject(obj);
            return None;
        }
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let hdc = GetDC(None);
        let lines = GetDIBits(hdc, hbmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);
        ReleaseDC(None, hdc);
        let _ = DeleteObject(obj);
        if lines == 0 {
            return None;
        }
        // BGRA -> RGBA. Opaque thumbnails often come back with alpha 0 everywhere.
        let all_clear = buf.chunks_exact(4).all(|p| p[3] == 0);
        for p in buf.chunks_exact_mut(4) {
            p.swap(0, 2);
            if all_clear {
                p[3] = 255;
            }
        }
        encode_png(&buf, w as u32, h as u32)
    }
}

#[cfg(not(windows))]
fn platform_thumbnail(_path: &str, _size: i32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes_png_data_url() {
        let url = super::encode_png(&[255, 0, 0, 255], 1, 1).unwrap();
        assert!(url.starts_with("data:image/png;base64,iVBOR"));
    }

    // Runs in the Windows CI job: the shell must produce a thumbnail for a real PNG.
    #[cfg(windows)]
    #[test]
    fn shell_thumbnail_for_png() {
        use base64::Engine;
        let url = super::encode_png(&[30, 144, 255, 255].repeat(64 * 64), 64, 64).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(url.split(',').nth(1).unwrap()).unwrap();
        let file = std::env::temp_dir().join(format!("finder-win-thumb-{}.png", std::process::id()));
        std::fs::write(&file, bytes).unwrap();
        let thumb = super::platform_thumbnail(file.to_str().unwrap(), 48);
        assert!(thumb.is_some_and(|t| t.starts_with("data:image/png;base64,")));
    }
}
