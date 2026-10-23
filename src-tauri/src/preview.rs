//! Content previews for formats the web view can't show by itself:
//! Word, PowerPoint and Excel (text and tables pulled from the Office XML), the legacy
//! binary .doc and .xls formats (for PCs without Office's preview handlers) and ZIP listings.

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read};

const MAX_XML: u64 = 40 * 1024 * 1024;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
    pub text: String,
    /// 1..=6 for headings, 0 for body text.
    pub heading: u8,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Preview {
    Doc { paragraphs: Vec<Paragraph>, truncated: bool },
    Slides { slides: Vec<Vec<String>> },
    Sheet { sheets: Vec<String>, rows: Vec<Vec<String>>, truncated: bool },
    Archive { entries: Vec<ArchiveEntry>, total: usize },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
}

type Zip = zip::ZipArchive<BufReader<File>>;

fn open_zip(path: &str) -> Result<Zip, String> {
    let f = File::open(path).map_err(|e| crate::fsops::code(&e))?;
    zip::ZipArchive::new(BufReader::new(f)).map_err(|e| e.to_string())
}

fn read_member(z: &mut Zip, name: &str) -> Option<String> {
    let f = z.by_name(name).ok()?;
    let mut s = String::new();
    f.take(MAX_XML).read_to_string(&mut s).ok()?;
    Some(s)
}

fn local(name: &[u8]) -> &[u8] {
    name.rsplit(|&c| c == b':').next().unwrap_or(name)
}

fn attr(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| local(a.key.as_ref()) == key)
        // Not `unescape_value`: calamine turns on quick-xml's `encoding` feature, which removes it.
        .and_then(|a| quick_xml::escape::unescape(std::str::from_utf8(&a.value).ok()?).ok().map(|v| v.into_owned()))
}

pub fn preview(path: &str) -> Result<Preview, String> {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "docx" | "docm" | "dotx" => docx(path),
        "pptx" | "pptm" => pptx(path),
        "xlsx" | "xlsm" => xlsx(path),
        "doc" | "dot" => doc(path),
        "xls" | "xlt" => workbook::<calamine::Xls<_>>(path),
        "xlsb" => workbook::<calamine::Xlsb<_>>(path),
        "ods" => workbook::<calamine::Ods<_>>(path),
        "zip" | "jar" | "apk" | "epub" | "nupkg" | "vsix" => archive(path),
        e if crate::archive::OTHER.contains(&e) => {
            let (list, total) = crate::archive::list_other(path, 2000)?;
            let entries = list.into_iter().map(|(name, size, is_dir)| ArchiveEntry { name, size, is_dir }).collect();
            Ok(Preview::Archive { entries, total })
        }
        _ => Err("UNSUPPORTED".into()),
    }
}

fn docx(path: &str) -> Result<Preview, String> {
    let mut z = open_zip(path)?;
    let xml = read_member(&mut z, "word/document.xml").ok_or("INVALID")?;
    let mut r = Reader::from_str(&xml);
    let mut paragraphs = Vec::new();
    let mut cur = Paragraph::default();
    let mut in_text = false;
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => match local(e.name().as_ref()) {
                b"t" => in_text = true,
                b"p" => cur = Paragraph::default(),
                _ => {}
            },
            Ok(Event::Empty(e)) => match local(e.name().as_ref()) {
                b"tab" => cur.text.push('\t'),
                b"br" => cur.text.push('\n'),
                b"pStyle" => {
                    let style = attr(&e, b"val").unwrap_or_default().to_lowercase();
                    if style == "title" {
                        cur.heading = 1;
                    } else if let Some(n) = style.strip_prefix("heading") {
                        cur.heading = n.trim().parse::<u8>().unwrap_or(1).clamp(1, 6);
                    }
                }
                _ => {}
            },
            Ok(Event::Text(t)) if in_text => {
                if let Ok(s) = t.unescape() {
                    cur.text.push_str(&s);
                }
            }
            Ok(Event::End(e)) => match local(e.name().as_ref()) {
                b"t" => in_text = false,
                b"p" => {
                    paragraphs.push(std::mem::take(&mut cur));
                    if paragraphs.len() >= 3000 {
                        return Ok(Preview::Doc { paragraphs, truncated: true });
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    Ok(Preview::Doc { paragraphs, truncated: false })
}

fn pptx(path: &str) -> Result<Preview, String> {
    let mut z = open_zip(path)?;
    let mut names: Vec<(u32, String)> = z
        .file_names()
        .filter_map(|n| {
            let num = n.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?.parse().ok()?;
            Some((num, n.to_string()))
        })
        .collect();
    names.sort();
    let mut slides = Vec::new();
    for (_, name) in names.into_iter().take(300) {
        let Some(xml) = read_member(&mut z, &name) else { continue };
        let mut r = Reader::from_str(&xml);
        let (mut lines, mut cur, mut in_text) = (Vec::new(), String::new(), false);
        loop {
            match r.read_event() {
                Ok(Event::Start(e)) if local(e.name().as_ref()) == b"t" => in_text = true,
                Ok(Event::Text(t)) if in_text => cur.push_str(&t.unescape().unwrap_or_default()),
                Ok(Event::End(e)) => match local(e.name().as_ref()) {
                    b"t" => in_text = false,
                    b"p" if !cur.trim().is_empty() => lines.push(std::mem::take(&mut cur)),
                    b"p" => cur.clear(),
                    _ => {}
                },
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
        slides.push(lines);
    }
    if slides.is_empty() {
        return Err("INVALID".into());
    }
    Ok(Preview::Slides { slides })
}

/// "B12" -> 1 (zero-based column index).
fn col_index(cell_ref: &str) -> usize {
    cell_ref
        .bytes()
        .take_while(|b| b.is_ascii_alphabetic())
        .fold(0usize, |acc, b| acc * 26 + (b.to_ascii_uppercase() - b'A' + 1) as usize)
        .saturating_sub(1)
}

fn xlsx(path: &str) -> Result<Preview, String> {
    const MAX_ROWS: usize = 300;
    const MAX_COLS: usize = 40;
    let mut z = open_zip(path)?;

    let mut shared = Vec::new();
    if let Some(xml) = read_member(&mut z, "xl/sharedStrings.xml") {
        let mut r = Reader::from_str(&xml);
        let (mut cur, mut in_t) = (String::new(), false);
        loop {
            match r.read_event() {
                Ok(Event::Start(e)) if local(e.name().as_ref()) == b"t" => in_t = true,
                Ok(Event::Text(t)) if in_t => cur.push_str(&t.unescape().unwrap_or_default()),
                Ok(Event::End(e)) => match local(e.name().as_ref()) {
                    b"t" => in_t = false,
                    b"si" => shared.push(std::mem::take(&mut cur)),
                    _ => {}
                },
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
    }

    let dates = date_styles(&mut z);
    let mut date1904 = false;
    let mut sheets = Vec::new();
    if let Some(xml) = read_member(&mut z, "xl/workbook.xml") {
        let mut r = Reader::from_str(&xml);
        loop {
            match r.read_event() {
                Ok(Event::Empty(e)) | Ok(Event::Start(e)) if local(e.name().as_ref()) == b"sheet" => {
                    sheets.push(attr(&e, b"name").unwrap_or_default());
                }
                Ok(Event::Empty(e)) | Ok(Event::Start(e)) if local(e.name().as_ref()) == b"workbookPr" => {
                    date1904 = matches!(attr(&e, b"date1904").as_deref(), Some("1" | "true"));
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
    }

    let first = if z.by_name("xl/worksheets/sheet1.xml").is_ok() {
        "xl/worksheets/sheet1.xml".to_string()
    } else {
        let mut ws: Vec<String> = z.file_names().filter(|n| n.starts_with("xl/worksheets/sheet")).map(str::to_owned).collect();
        ws.sort();
        ws.into_iter().next().ok_or("INVALID")?
    };
    let xml = read_member(&mut z, &first).ok_or("INVALID")?;
    let mut r = Reader::from_str(&xml);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let (mut col, mut kind, mut val, mut in_v) = (0usize, String::new(), String::new(), false);
    let mut is_date = false;
    let mut truncated = false;
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => match local(e.name().as_ref()) {
                b"row" => row.clear(),
                b"c" => {
                    col = attr(&e, b"r").map(|s| col_index(&s)).unwrap_or(row.len());
                    kind = attr(&e, b"t").unwrap_or_default();
                    is_date = attr(&e, b"s").and_then(|i| i.parse::<usize>().ok()).is_some_and(|i| dates.get(i) == Some(&true));
                    val.clear();
                }
                b"v" | b"t" => in_v = true,
                _ => {}
            },
            Ok(Event::Text(t)) if in_v => val.push_str(&t.unescape().unwrap_or_default()),
            Ok(Event::End(e)) => match local(e.name().as_ref()) {
                b"v" | b"t" => in_v = false,
                b"c" => {
                    if col < MAX_COLS {
                        let text = match kind.as_str() {
                            "s" => val.trim().parse::<usize>().ok().and_then(|i| shared.get(i).cloned()).unwrap_or_default(),
                            "b" => if val == "1" { "TRUE".into() } else { "FALSE".into() },
                            "" | "n" if is_date => val.trim().parse::<f64>().ok().map(|v| excel_date(v, date1904)).unwrap_or_else(|| val.clone()),
                            _ => val.clone(),
                        };
                        if row.len() <= col {
                            row.resize(col + 1, String::new());
                        }
                        row[col] = text;
                    }
                }
                b"row" => {
                    rows.push(std::mem::take(&mut row));
                    if rows.len() >= MAX_ROWS {
                        truncated = true;
                        break;
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    Ok(Preview::Sheet { sheets, rows, truncated })
}

/// Legacy spreadsheets (and .xlsb / .ods) read with calamine: the first sheet, laid out at its real
/// row and column positions like the xlsx preview.
fn workbook<R>(path: &str) -> Result<Preview, String>
where
    R: calamine::Reader<BufReader<File>>,
{
    use calamine::Data;
    const MAX_ROWS: usize = 300;
    const MAX_COLS: usize = 40;
    let mut wb: R = calamine::open_workbook(path).map_err(|_| "INVALID")?;
    let sheets = wb.sheet_names();
    let first = sheets.first().ok_or("INVALID")?.clone();
    let range = wb.worksheet_range(&first).map_err(|_| "INVALID")?;
    let (r0, c0) = range.start().map(|(r, c)| (r as usize, c as usize)).unwrap_or((0, 0));
    let mut rows: Vec<Vec<String>> = vec![Vec::new(); r0.min(MAX_ROWS)];
    for cells in range.rows() {
        if rows.len() >= MAX_ROWS {
            break;
        }
        let mut row = vec![String::new(); c0.min(MAX_COLS)];
        for cell in cells.iter().take(MAX_COLS.saturating_sub(row.len())) {
            row.push(match cell {
                Data::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
                Data::DateTime(d) if d.is_datetime() => match d.as_datetime() {
                    Some(t) => {
                        let s = t.format("%Y/%m/%d %H:%M").to_string();
                        s.strip_suffix(" 00:00").map(str::to_owned).unwrap_or(s)
                    }
                    None => d.to_string(),
                },
                other => other.to_string(),
            });
        }
        while row.last().is_some_and(String::is_empty) {
            row.pop();
        }
        rows.push(row);
    }
    let truncated = range.height() + r0 > rows.len();
    Ok(Preview::Sheet { sheets, rows, truncated })
}

/// Word 97–2003: the main text, read through the piece table (the CLX in the table stream).
fn doc(path: &str) -> Result<Preview, String> {
    let mut cf = cfb::open(path).map_err(|e| crate::fsops::code(&e))?;
    let mut stream = |name: &str| -> Result<Vec<u8>, String> {
        let mut buf = Vec::new();
        cf.open_stream(name).map_err(|_| "INVALID")?.take(MAX_XML).read_to_end(&mut buf).map_err(|_| "INVALID")?;
        Ok(buf)
    };
    let word = stream("/WordDocument")?;
    let flags = u16_at(&word, 0x0A).ok_or("INVALID")?;
    if flags & 0x0100 != 0 {
        return Err("ENCRYPTED".into());
    }
    let table = stream(if flags & 0x0200 != 0 { "/1Table" } else { "/0Table" })?;
    let text = doc_text(&word, &table).ok_or("INVALID")?;
    let (paragraphs, truncated) = doc_paragraphs(&text);
    Ok(Preview::Doc { paragraphs, truncated })
}

fn u16_at(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
}

/// The main document's characters (control characters included), in order.
fn doc_text(word: &[u8], table: &[u8]) -> Option<Vec<u16>> {
    const MAX_CHARS: u32 = 2_000_000;
    if u16_at(word, 0)? != 0xA5EC || u16_at(word, 2)? < 0x00C1 {
        return None; // not Word 97 or later
    }
    // FIB: fixed 32-byte base, then counted arrays of shorts, longs and fc/lcb pairs.
    let rg_lw = 0x22 + u16_at(word, 0x20)? as usize * 2 + 2;
    let ccp_text = u32_at(word, rg_lw + 12)?.min(MAX_CHARS);
    let fc_lcb = rg_lw + u16_at(word, rg_lw - 2)? as usize * 4 + 2;
    let fc_clx = u32_at(word, fc_lcb + 33 * 8)? as usize;
    let lcb_clx = u32_at(word, fc_lcb + 33 * 8 + 4)? as usize;
    let clx = table.get(fc_clx..fc_clx.checked_add(lcb_clx)?)?;

    // Skip the Prc entries (formatting) to reach the Pcdt (the piece table).
    let mut i = 0;
    let plc = loop {
        match *clx.get(i)? {
            1 => i += 3 + u16_at(clx, i + 1)? as usize,
            2 => {
                let len = u32_at(clx, i + 1)? as usize;
                break clx.get(i + 5..(i + 5).checked_add(len)?)?;
            }
            _ => return None,
        }
    };
    let n = plc.len().checked_sub(4)? / 12;
    let mut out = Vec::new();
    for k in 0..n {
        let (start, end) = (u32_at(plc, k * 4)?, u32_at(plc, k * 4 + 4)?.min(ccp_text));
        if start >= ccp_text {
            break;
        }
        let count = end.saturating_sub(start) as usize;
        let fc = u32_at(plc, (n + 1) * 4 + k * 8 + 2)?;
        if fc & 0x4000_0000 != 0 {
            // Compressed piece: one Windows-1252 byte per character.
            let at = (fc & 0x3FFF_FFFF) as usize / 2;
            out.extend(word.get(at..at + count)?.iter().map(|&b| cp1252(b)));
        } else {
            let at = fc as usize;
            let bytes = word.get(at..at + count * 2)?;
            out.extend(bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])));
        }
    }
    Some(out)
}

fn cp1252(b: u8) -> u16 {
    const HIGH: [u16; 32] = [
        0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
        0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
    ];
    if (0x80..0xA0).contains(&b) { HIGH[b as usize - 0x80] } else { b as u16 }
}

/// Splits Word's character stream into paragraphs: drops field codes (keeping their results),
/// turns table cells into tab-separated rows and removes object anchors.
fn doc_paragraphs(text: &[u16]) -> (Vec<Paragraph>, bool) {
    let mut paragraphs = Vec::new();
    let mut cur = String::new();
    // One entry per open field: true once its separator was seen (its result is showing).
    let mut fields: Vec<bool> = Vec::new();
    let mut prev = 0u16;
    let end = |cur: &mut String, paragraphs: &mut Vec<Paragraph>| {
        let text = std::mem::take(cur).trim_end_matches('\t').to_string();
        paragraphs.push(Paragraph { text, heading: 0 });
    };
    for ch in char::decode_utf16(text.iter().copied()) {
        let c = ch.unwrap_or('\u{FFFD}');
        let code = c as u32;
        match code {
            0x13 => fields.push(false),
            0x14 => {
                if let Some(top) = fields.last_mut() {
                    *top = true;
                }
            }
            0x15 => {
                fields.pop();
            }
            _ if fields.iter().any(|&shown| !shown) => {}
            0x0D | 0x0C | 0x0E => end(&mut cur, &mut paragraphs),
            // A cell ends with 0x07; a second one right after closes the table row.
            0x07 if prev == 0x07 => end(&mut cur, &mut paragraphs),
            0x07 => cur.push('\t'),
            0x0B => cur.push('\n'),
            0x09 => cur.push('\t'),
            0x1E => cur.push('-'),
            _ if code < 0x20 => {}
            _ => cur.push(c),
        }
        prev = if code == 0x07 && prev == 0x07 { 0 } else { code as u16 };
        if paragraphs.len() >= 3000 {
            return (paragraphs, true);
        }
    }
    if !cur.trim().is_empty() {
        end(&mut cur, &mut paragraphs);
    }
    (paragraphs, false)
}

/// For each cell style (xl/styles.xml cellXfs), whether its number format is a date or time.
fn date_styles(z: &mut Zip) -> Vec<bool> {
    let Some(xml) = read_member(z, "xl/styles.xml") else { return Vec::new() };
    let mut custom = std::collections::HashMap::new();
    let mut xfs = Vec::new();
    let mut in_xfs = false;
    let mut r = Reader::from_str(&xml);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) if local(e.name().as_ref()) == b"cellXfs" => in_xfs = true,
            Ok(Event::End(e)) if local(e.name().as_ref()) == b"cellXfs" => in_xfs = false,
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => match local(e.name().as_ref()) {
                b"numFmt" => {
                    if let (Some(id), Some(code)) = (attr(&e, b"numFmtId"), attr(&e, b"formatCode")) {
                        custom.insert(id, code);
                    }
                }
                b"xf" if in_xfs => xfs.push(attr(&e, b"numFmtId").unwrap_or_default()),
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    xfs.iter()
        .map(|id| match id.parse::<u32>() {
            // Excel's built-in date and time formats, including the East Asian ones.
            Ok(14..=22 | 27..=36 | 45..=47 | 50..=58) => true,
            _ => custom.get(id).is_some_and(|c| is_date_format(c)),
        })
        .collect()
}

/// A custom number format that shows a date or time ("yyyy/mm/dd", "上午/下午 h:mm"…).
fn is_date_format(code: &str) -> bool {
    let (mut plain, mut quoted, mut bracket, mut escaped) = (String::new(), false, false, false);
    for c in code.chars() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => quoted = !quoted,
            '[' if !quoted => bracket = true,
            ']' if !quoted => bracket = false,
            _ if quoted || bracket => {}
            _ => plain.push(c.to_ascii_lowercase()),
        }
    }
    let first = plain.split(';').next().unwrap_or("");
    first != "general" && first.chars().any(|c| matches!(c, 'y' | 'm' | 'd' | 'h' | 's'))
}

/// An Excel date serial as "2025/01/15" (with " 09:30" when it has a time of day).
fn excel_date(serial: f64, date1904: bool) -> String {
    let days = serial.floor() as i64 + if date1904 { -24107 } else { -25569 }; // days since 1970-01-01
    // Howard Hinnant's civil_from_days.
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let secs = ((serial - serial.floor()) * 86400.0).round() as i64;
    if secs == 0 || secs >= 86400 {
        format!("{y}/{m:02}/{d:02}")
    } else {
        format!("{y}/{m:02}/{d:02} {:02}:{:02}", secs / 3600, secs % 3600 / 60)
    }
}

fn archive(path: &str) -> Result<Preview, String> {
    let mut z = open_zip(path)?;
    let total = z.len();
    let mut entries = Vec::new();
    for i in 0..total.min(2000) {
        if let Ok(f) = z.by_index_raw(i) {
            entries.push(ArchiveEntry { name: f.name().to_string(), size: f.size(), is_dir: f.is_dir() });
        }
    }
    Ok(Preview::Archive { entries, total })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(name: &str, members: &[(&str, &str)]) -> String {
        let path = std::env::temp_dir().join(format!("finder-win-prev-{}-{name}", std::process::id()));
        let mut w = zip::ZipWriter::new(File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        for (n, body) in members {
            w.start_file(*n, opts).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn reads_docx_paragraphs_and_headings() {
        let doc = r#"<w:document xmlns:w="w"><w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>標題</w:t></w:r></w:p>
            <w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> &amp; 續</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let p = make_zip("a.docx", &[("word/document.xml", doc)]);
        let Preview::Doc { paragraphs, .. } = preview(&p).unwrap() else { panic!() };
        assert_eq!(paragraphs[0].text, "標題");
        assert_eq!(paragraphs[0].heading, 1);
        assert_eq!(paragraphs[1].text, "第一段\t & 續");
        assert_eq!(paragraphs[1].heading, 0);
    }

    #[test]
    fn reads_pptx_slides_in_order() {
        let slide = |t: &str| format!(r#"<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>"#);
        let (s1, s2, s10) = (slide("一"), slide("二"), slide("十"));
        let p = make_zip("b.pptx", &[("ppt/slides/slide10.xml", &s10), ("ppt/slides/slide2.xml", &s2), ("ppt/slides/slide1.xml", &s1)]);
        let Preview::Slides { slides } = preview(&p).unwrap() else { panic!() };
        assert_eq!(slides, vec![vec!["一"], vec!["二"], vec!["十"]]);
    }

    #[test]
    fn reads_xlsx_cells() {
        let ss = r#"<sst><si><t>品名</t></si><si><t>蘋果</t></si></sst>"#;
        let wb = r#"<workbook><sheets><sheet name="報價" sheetId="1"/></sheets></workbook>"#;
        let sheet = r#"<worksheet><sheetData>
            <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>備註</t></is></c></row>
            <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>3.5</v></c></row>
        </sheetData></worksheet>"#;
        let p = make_zip("c.xlsx", &[("xl/sharedStrings.xml", ss), ("xl/workbook.xml", wb), ("xl/worksheets/sheet1.xml", sheet)]);
        let Preview::Sheet { sheets, rows, .. } = preview(&p).unwrap() else { panic!() };
        assert_eq!(sheets, vec!["報價"]);
        assert_eq!(rows[0], vec!["品名", "", "備註"]);
        assert_eq!(rows[1], vec!["蘋果", "3.5"]);
        assert_eq!(col_index("AB7"), 27);

        // Dates: a built-in format (14), a custom one, and a plain number next to them.
        let styles = r##"<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot; h:mm"/>
            <numFmt numFmtId="165" formatCode="#,##0.00&quot;元&quot;"/></numFmts>
            <cellStyleXfs><xf numFmtId="14"/></cellStyleXfs>
            <cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>"##;
        let sheet = r#"<worksheet><sheetData><row r="1">
            <c r="A1" s="1"><v>45672</v></c><c r="B1" s="2"><v>45672.5</v></c><c r="C1" s="3"><v>45672</v></c><c r="D1"><v>45672</v></c>
        </row></sheetData></worksheet>"#;
        let p = make_zip("e.xlsx", &[("xl/styles.xml", styles), ("xl/workbook.xml", wb), ("xl/worksheets/sheet1.xml", sheet)]);
        let Preview::Sheet { rows, .. } = preview(&p).unwrap() else { panic!() };
        assert_eq!(rows[0], vec!["2025/01/15", "2025/01/15 12:00", "45672", "45672"]);
        assert_eq!(excel_date(1462.0, true), "1908/01/02");
        assert_eq!(excel_date(61.0, false), "1900/03/01");
        assert!(!is_date_format("0.00E+00") && !is_date_format("General") && !is_date_format("[Red]#,##0"));
        assert!(is_date_format("[$-404]e/m/d") && is_date_format("上午/下午 h\\:mm") && is_date_format("mm:ss"));
    }

    fn make_cfb(name: &str, streams: &[(&str, &[u8])]) -> String {
        let path = std::env::temp_dir().join(format!("finder-win-prev-{}-{name}", std::process::id()));
        let mut cf = cfb::create(&path).unwrap();
        for (n, body) in streams {
            cf.create_stream(n).unwrap().write_all(body).unwrap();
        }
        cf.flush().unwrap();
        path.to_string_lossy().into_owned()
    }

    /// A Word 97 file: a FIB pointing at a piece table with one Unicode and one compressed piece.
    #[test]
    fn reads_legacy_doc_text() {
        let utf16 = |s: &str| s.encode_utf16().flat_map(|c| c.to_le_bytes()).collect::<Vec<u8>>();
        // Field: code "PAGE" hidden, result "3" shown. Table: two cells then the row mark.
        let uni = "標題\r內文\x13 PAGE \x143\x15頁\r甲\x07乙\x07\x07";
        let latin = b"caf\xe9 \x93ok\x94\r";
        let mut word = vec![0u8; 0x400];
        word[0..2].copy_from_slice(&0xA5ECu16.to_le_bytes());
        word[2..4].copy_from_slice(&0x00C1u16.to_le_bytes());
        word[0x0A..0x0C].copy_from_slice(&0x0200u16.to_le_bytes()); // text in 1Table
        word[0x20..0x22].copy_from_slice(&14u16.to_le_bytes());
        word[0x3E..0x40].copy_from_slice(&22u16.to_le_bytes());
        word[0x98..0x9A].copy_from_slice(&0x5Du16.to_le_bytes());
        let n_uni = uni.encode_utf16().count() as u32;
        let ccp = n_uni + latin.len() as u32;
        word[0x4C..0x50].copy_from_slice(&ccp.to_le_bytes());
        let (fc_uni, fc_latin) = (word.len() as u32, (word.len() + n_uni as usize * 2) as u32);
        word.extend(utf16(uni));
        word.extend(latin);

        let mut plc = Vec::new();
        for cp in [0, n_uni, ccp] {
            plc.extend(cp.to_le_bytes());
        }
        for fc in [fc_uni, (fc_latin * 2) | 0x4000_0000] {
            plc.extend([0, 0]);
            plc.extend(fc.to_le_bytes());
            plc.extend([0, 0]);
        }
        let mut table = vec![0u8; 16];
        let fc_clx = table.len() as u32;
        table.extend([1, 2, 0, 0xAA, 0xBB]); // a Prc to skip
        table.push(2);
        table.extend((plc.len() as u32).to_le_bytes());
        table.extend(&plc);
        let lcb_clx = table.len() as u32 - fc_clx;
        word[0x1A2..0x1A6].copy_from_slice(&fc_clx.to_le_bytes());
        word[0x1A6..0x1AA].copy_from_slice(&lcb_clx.to_le_bytes());

        let p = make_cfb("e.doc", &[("/WordDocument", &word), ("/1Table", &table)]);
        let Preview::Doc { paragraphs, truncated } = preview(&p).unwrap() else { panic!() };
        let texts: Vec<&str> = paragraphs.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(texts, vec!["標題", "內文3頁", "甲\t乙", "café “ok”"]);
        assert!(!truncated);

        word[0x0B] |= 0x01; // fEncrypted (0x0100)
        let p = make_cfb("f.doc", &[("/WordDocument", &word), ("/1Table", &table)]);
        assert!(preview(&p).is_err());
    }

    /// A minimal BIFF8 workbook: one sheet with a shared string, a number and a date.
    #[test]
    fn reads_legacy_xls_cells() {
        fn rec(out: &mut Vec<u8>, id: u16, body: &[u8]) {
            out.extend(id.to_le_bytes());
            out.extend((body.len() as u16).to_le_bytes());
            out.extend(body);
        }
        let bof = |kind: u16| [&0x0600u16.to_le_bytes()[..], &kind.to_le_bytes(), &[0u8; 12]].concat();
        let ustr = |s: &str| [&(s.encode_utf16().count() as u16).to_le_bytes()[..], &[1], &s.encode_utf16().flat_map(|c| c.to_le_bytes()).collect::<Vec<u8>>()].concat();
        let cell = |r: u16, c: u16, xf: u16| [r.to_le_bytes(), c.to_le_bytes(), xf.to_le_bytes()].concat();

        let mut globals = Vec::new();
        rec(&mut globals, 0x0809, &bof(0x0005));
        rec(&mut globals, 0x0042, &1200u16.to_le_bytes()); // CODEPAGE: UTF-16
        // FORMAT 164 = a date format; XF 0 = General, XF 1 uses format 164.
        let mut fmt = 164u16.to_le_bytes().to_vec();
        fmt.extend(ustr("yyyy/mm/dd"));
        rec(&mut globals, 0x041E, &fmt);
        for ifmt in [0u16, 164] {
            let mut xf = vec![0u8; 20];
            xf[2..4].copy_from_slice(&ifmt.to_le_bytes());
            rec(&mut globals, 0x00E0, &xf);
        }
        let mut sst = [2u32.to_le_bytes(), 2u32.to_le_bytes()].concat();
        sst.extend(ustr("品名"));
        sst.extend(ustr("蘋果"));
        rec(&mut globals, 0x00FC, &sst);
        let sheet_name = ustr("報價");
        let bs_len = 4 + 4 + 2 + sheet_name.len() - 1; // BOUNDSHEET name is a ShortXLUnicodeString
        let sheet_at = globals.len() + bs_len + 4 /* EOF */;
        let mut bs = (sheet_at as u32).to_le_bytes().to_vec();
        bs.extend([0, 0]);
        bs.push(2); // name length (8-bit count)
        bs.extend(&sheet_name[2..]);
        rec(&mut globals, 0x0085, &bs);
        rec(&mut globals, 0x000A, &[]);
        assert_eq!(globals.len(), sheet_at);

        let mut sheet = Vec::new();
        rec(&mut sheet, 0x0809, &bof(0x0010));
        let dims = [0u32.to_le_bytes(), 2u32.to_le_bytes()].concat();
        rec(&mut sheet, 0x0200, &[dims, vec![0, 0, 3, 0, 0, 0]].concat());
        rec(&mut sheet, 0x00FD, &[cell(0, 0, 0), 0u32.to_le_bytes().to_vec()].concat());
        rec(&mut sheet, 0x00FD, &[cell(1, 0, 0), 1u32.to_le_bytes().to_vec()].concat());
        rec(&mut sheet, 0x0203, &[cell(1, 1, 0), 3.5f64.to_le_bytes().to_vec()].concat());
        rec(&mut sheet, 0x0203, &[cell(1, 2, 1), 45658f64.to_le_bytes().to_vec()].concat()); // 2025-01-01
        rec(&mut sheet, 0x000A, &[]);
        globals.extend(sheet);

        let p = make_cfb("g.xls", &[("/Workbook", &globals)]);
        let Preview::Sheet { sheets, rows, truncated } = preview(&p).unwrap() else { panic!() };
        assert_eq!(sheets, vec!["報價"]);
        assert_eq!(rows[0], vec!["品名"]);
        assert_eq!(rows[1], vec!["蘋果", "3.5", "2025/01/01"]);
        assert!(!truncated);
    }

    #[test]
    fn lists_zip_entries() {
        let p = make_zip("d.zip", &[("readme.txt", "hi"), ("src/main.rs", "fn main(){}")]);
        let Preview::Archive { entries, total } = preview(&p).unwrap() else { panic!() };
        assert_eq!(total, 2);
        assert_eq!(entries[1].name, "src/main.rs");
        assert_eq!(entries[0].size, 2);
    }
}
