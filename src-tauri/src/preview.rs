//! Content previews for formats the web view can't show by itself:
//! Word, PowerPoint and Excel (text and tables pulled from the Office XML) and ZIP listings.

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
        .and_then(|a| a.unescape_value().ok().map(|v| v.into_owned()))
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
        "zip" | "jar" | "apk" | "epub" | "nupkg" | "vsix" => archive(path),
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

    let mut sheets = Vec::new();
    if let Some(xml) = read_member(&mut z, "xl/workbook.xml") {
        let mut r = Reader::from_str(&xml);
        loop {
            match r.read_event() {
                Ok(Event::Empty(e)) | Ok(Event::Start(e)) if local(e.name().as_ref()) == b"sheet" => {
                    sheets.push(attr(&e, b"name").unwrap_or_default());
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
    let mut truncated = false;
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => match local(e.name().as_ref()) {
                b"row" => row.clear(),
                b"c" => {
                    col = attr(&e, b"r").map(|s| col_index(&s)).unwrap_or(row.len());
                    kind = attr(&e, b"t").unwrap_or_default();
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
