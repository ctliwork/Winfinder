"""Test files for the Windows end-to-end run (tests/windows-e2e.mjs).

Usage: python tests/make_fixtures.py <folder>
Needs: pip install python-docx python-pptx openpyxl fpdf2 pillow; 7-Zip and tar on the PATH or in their usual places.
"""

import datetime
import os
import shutil
import subprocess
import sys

from docx import Document
from fpdf import FPDF
from openpyxl import Workbook
from PIL import Image
from pptx import Presentation

root = os.path.abspath(sys.argv[1])  # absolute: some steps run with another working directory
shutil.rmtree(root, ignore_errors=True)
os.makedirs(root)
p = lambda *n: os.path.join(root, *n)

with open(p("筆記.txt"), "w", encoding="utf-8") as f:
    f.write("第一行 zebra quartz\nsecond line\n" * 50)
with open(p("說明.md"), "w", encoding="utf-8") as f:
    f.write("# 標題\n\n- 項目一\n- **粗體**\n\n```\ncode\n```\n")
with open(p("資料.csv"), "w", encoding="utf-8") as f:
    f.write("品名,數量\n蘋果,3\n香蕉,5\n")
with open(p("說明.rtf"), "w", encoding="ascii") as f:
    f.write(r"{\rtf1\ansi{\fonttbl{\f0 Arial;}}\f0\fs28 Rich text preview test.\par Second paragraph.}")

# A phone-sized photo: 24 MP, ~10 MB.
w, h = 6000, 4000
noise = Image.effect_noise((w, h), 50)
Image.merge("RGB", [noise, Image.linear_gradient("L").resize((w, h)), noise]).save(p("照片.jpg"), quality=92)

doc = Document()
doc.add_heading("季度報告", 1)
doc.add_paragraph("營收成長 12%，zebra 是測試關鍵字。")
table = doc.add_table(rows=2, cols=2)
table.cell(0, 0).text, table.cell(0, 1).text = "品名", "數量"
table.cell(1, 0).text, table.cell(1, 1).text = "蘋果", "3"
doc.save(p("報告.docx"))

deck = Presentation()
for title in ("第一頁標題", "第二頁"):
    s = deck.slides.add_slide(deck.slide_layouts[1])
    s.shapes.title.text = title
    s.placeholders[1].text = "重點一\n重點二"
deck.save(p("簡報.pptx"))

wb = Workbook()
ws = wb.active
ws.title = "報價"
ws.append(["品名", "數量", "日期"])
ws.append(["蘋果", 3.5, datetime.date(2025, 1, 15)])
wb.save(p("預算.xlsx"))

pdf = FPDF()
pdf.add_page()
pdf.set_font("Helvetica", size=24)
pdf.cell(0, 20, "PDF preview test page")
pdf.output(p("文件.pdf"))

shutil.copy(os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts", "arial.ttf"), p("arial.ttf"))

src = p("_src")
os.makedirs(os.path.join(src, "資料夾"))
with open(os.path.join(src, "讀我.txt"), "w", encoding="utf-8") as f:
    f.write("hello")
with open(os.path.join(src, "資料夾", "b.txt"), "w", encoding="utf-8") as f:
    f.write("世界")
# The real 7z.exe, not a package manager's shim on the PATH (Chocolatey's mangles non-ASCII arguments).
seven = next((c for c in (r"C:\Program Files\7-Zip\7z.exe", shutil.which("7z"), shutil.which("7zz")) if c and os.path.isfile(c)), "7z")
subprocess.run([seven, "a", "-bd", p("封存.7z"), "."], cwd=src, check=True, stdout=subprocess.DEVNULL)
# tar.exe on Windows can't take names outside the system code page; 7-Zip can.
subprocess.run([seven, "a", "-bd", "-ttar", p("封存.tar"), "."], cwd=src, check=True, stdout=subprocess.DEVNULL)
subprocess.run([seven, "a", "-bd", "-tgzip", p("封存.tar.gz"), p("封存.tar")], check=True, stdout=subprocess.DEVNULL)
os.remove(p("封存.tar"))
shutil.rmtree(src)

os.makedirs(p("大資料夾"))
for i in range(3000):
    open(p("大資料夾", f"file {i:05d}.txt"), "w").close()
os.makedirs(p("子資料夾"))
with open(p("子資料夾", "inner.txt"), "w") as f:
    f.write("inner")
print("fixtures in", root)
