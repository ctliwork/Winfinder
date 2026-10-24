//! Photo, video and music details for the previews (Windows): what Explorer's
//! details pane shows (size in pixels, date taken, camera, exposure, place,
//! length...), read through the shell's property system and formatted the way
//! Explorer formats them. Other platforms have none.

/// (label, value) rows in display order; empty when the file has none.
pub fn info(path: &str) -> Vec<(String, String)> {
    platform(path)
}

#[cfg(not(windows))]
fn platform(_path: &str) -> Vec<(String, String)> {
    Vec::new()
}

/// Windows wraps some values in direction marks (e.g. "\u{202a}4032 x 3024\u{202c}").
#[cfg_attr(not(windows), allow(dead_code))]
fn clean(s: &str) -> String {
    s.chars().filter(|c| !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}')).collect::<String>().trim().to_string()
}

/// "Canon" + "Canon EOS R6" → "Canon EOS R6"; "Apple" + "iPhone 15 Pro" → "Apple iPhone 15 Pro".
#[cfg_attr(not(windows), allow(dead_code))]
fn camera(make: Option<String>, model: Option<String>) -> Option<String> {
    match (make, model) {
        (Some(make), Some(model)) => {
            let first = make.split_whitespace().next().unwrap_or("").to_lowercase();
            Some(if !first.is_empty() && model.to_lowercase().starts_with(&first) { model } else { format!("{make} {model}") })
        }
        (make, model) => make.or(model),
    }
}

/// Degrees as "25.03303° N, 121.56540° E".
#[cfg_attr(not(windows), allow(dead_code))]
fn place(lat: f64, lon: f64) -> Option<String> {
    if !(lat.is_finite() && lon.is_finite()) || (lat == 0.0 && lon == 0.0) || lat.abs() > 90.0 || lon.abs() > 180.0 {
        return None;
    }
    let ns = if lat < 0.0 { 'S' } else { 'N' };
    let ew = if lon < 0.0 { 'W' } else { 'E' };
    Some(format!("{:.5}° {ns}, {:.5}° {ew}", lat.abs(), lon.abs()))
}

#[cfg(windows)]
fn platform(path: &str) -> Vec<(String, String)> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantGetDoubleElem, PropVariantGetElementCount, PropVariantToDouble, PropVariantToUInt32, PROPVARIANT};
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PSFormatForDisplayAlloc, PSGetPropertyKeyFromName, GPS_BESTEFFORT, PDFF_DEFAULT};
    use windows::Win32::UI::Shell::{IShellItem2, SHCreateItemFromParsingName};

    unsafe {
        // Each worker thread needs COM; repeated calls on the same thread are harmless.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem2>(&HSTRING::from(path), None) else { return Vec::new() };
        // Best effort: never downloads a cloud-only file just to read its details.
        let Ok(store) = item.GetPropertyStore::<IPropertyStore>(GPS_BESTEFFORT) else { return Vec::new() };
        let value = |name: &str| -> Option<(PROPERTYKEY, PROPVARIANT)> {
            let mut key = PROPERTYKEY::default();
            PSGetPropertyKeyFromName(&HSTRING::from(name), &mut key).ok()?;
            let v = store.GetValue(&key).ok()?;
            (!v.is_empty()).then_some((key, v))
        };
        let text = |name: &str| -> Option<String> {
            let (key, v) = value(name)?;
            let p = PSFormatForDisplayAlloc(&key, &v, PDFF_DEFAULT).ok()?;
            let s = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as _));
            s.map(|s| clean(&s)).filter(|s| !s.is_empty())
        };
        let number = |name: &str| value(name).and_then(|(_, v)| PropVariantToDouble(&v).ok());
        let count = |name: &str| value(name).and_then(|(_, v)| PropVariantToUInt32(&v).ok()).filter(|&n| n > 0);

        let mut rows: Vec<(&str, Option<String>)> = Vec::new();
        let pixels = match (count("System.Image.HorizontalSize"), count("System.Image.VerticalSize")) {
            (Some(w), Some(h)) => Some((w, h)),
            _ => count("System.Video.FrameWidth").zip(count("System.Video.FrameHeight")),
        };
        rows.push(("尺寸", pixels.map(|(w, h)| format!("{w} × {h}"))));
        rows.push(("長度", text("System.Media.Duration")));
        rows.push(("畫面速率", text("System.Video.FrameRate")));
        rows.push(("拍攝日期", text("System.Photo.DateTaken")));
        rows.push(("相機", camera(text("System.Photo.CameraManufacturer"), text("System.Photo.CameraModel"))));
        let exposure: Vec<String> = ["System.Photo.FNumber", "System.Photo.ExposureTime", "System.Photo.ISOSpeed", "System.Photo.FocalLength"]
            .iter()
            .filter_map(|n| text(n))
            .collect();
        rows.push(("曝光", (!exposure.is_empty()).then(|| exposure.join(" · "))));
        // Signed degrees; older Windows only has degrees, minutes, seconds and N/S, E/W.
        let degrees = |decimal: &str, dms: &str, reference: &str, negative: char| {
            number(decimal).or_else(|| {
                let (_, v) = value(dms)?;
                if PropVariantGetElementCount(&v) < 3 {
                    return None;
                }
                let part = |i| PropVariantGetDoubleElem(&v, i).ok();
                let d = part(0)? + part(1)? / 60.0 + part(2)? / 3600.0;
                Some(if text(reference).is_some_and(|r| r.starts_with(negative)) { -d } else { d })
            })
        };
        let lat = degrees("System.GPS.LatitudeDecimal", "System.GPS.Latitude", "System.GPS.LatitudeRef", 'S');
        let lon = degrees("System.GPS.LongitudeDecimal", "System.GPS.Longitude", "System.GPS.LongitudeRef", 'W');
        rows.push(("地點", lat.zip(lon).and_then(|(a, b)| place(a, b))));
        rows.push(("標題", text("System.Title")));
        rows.push(("演出者", text("System.Music.Artist")));
        rows.push(("專輯", text("System.Music.AlbumTitle")));
        rows.into_iter().filter_map(|(k, v)| Some((k.to_string(), v?))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(clean("\u{202a}4032 x 3024\u{202c} "), "4032 x 3024");
        assert_eq!(camera(Some("Canon".into()), Some("Canon EOS R6".into())).unwrap(), "Canon EOS R6");
        assert_eq!(camera(Some("Apple".into()), Some("iPhone 15 Pro".into())).unwrap(), "Apple iPhone 15 Pro");
        assert_eq!(camera(None, Some("X100V".into())).unwrap(), "X100V");
        assert_eq!(place(25.033031, 121.565402).unwrap(), "25.03303° N, 121.56540° E");
        assert_eq!(place(-33.8688, -151.2093).unwrap(), "33.86880° S, 151.20930° W");
        assert_eq!(place(0.0, 0.0), None);
    }

    /// A 64×48 JPEG with EXIF (camera, exposure, date, GPS) made with Pillow: its details come back.
    #[cfg(windows)]
    #[test]
    fn reads_photo_details() {
        let path = std::env::temp_dir().join(format!("winfinder-media-{}.jpg", std::process::id()));
        std::fs::write(&path, include_bytes!("../tests/exif.jpg")).unwrap();
        let rows = info(&path.to_string_lossy());
        let _ = std::fs::remove_file(&path);
        let get = |k: &str| rows.iter().find(|(l, _)| l == k).map(|(_, v)| v.clone());
        assert_eq!(get("尺寸").as_deref(), Some("64 × 48"), "{rows:?}");
        assert!(get("拍攝日期").is_some_and(|d| d.contains("2024")), "{rows:?}");
        assert_eq!(get("相機").as_deref(), Some("Canon EOS R6"), "{rows:?}");
        assert!(get("曝光").is_some_and(|e| e.contains("1.8")), "{rows:?}");
        assert_eq!(get("地點").as_deref(), Some("25.03303° N, 121.56540° E"), "{rows:?}");
    }
}
