# Draws the app icon (blue folder with a smile) and writes every size Tauri
# needs. Run: python3 scripts/make-icon.py src-tauri/icons  (needs Pillow)
from PIL import Image, ImageDraw
import sys
S = 8  # supersampling
U = lambda v: int(round(v * S))  # 512-unit design coords -> canvas px
W = 512 * S

def icon():
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    x0, x1, bot, r = 10, 502, 470, 40
    # back panel with tab
    back = Image.new('L', (W, W), 0); d = ImageDraw.Draw(back)
    d.rounded_rectangle([U(x0), U(86), U(x1), U(bot)], U(r), fill=255)
    d.rounded_rectangle([U(x0), U(40), U(214), U(220)], U(r), fill=255)
    d.polygon([(U(170), U(40)), (U(194), U(42)), (U(206), U(48)), (U(248), U(86)), (U(170), U(86))], fill=255)
    grad_b = Image.linear_gradient('L').resize((W, W))
    backc = Image.merge('RGBA', [grad_b.point(lambda v: int(96 - 10 * v / 255)), grad_b.point(lambda v: int(178 - 12 * v / 255)),
                                 grad_b.point(lambda v: 245), back])
    img.alpha_composite(backc)
    # front panel, vertical gradient
    front = Image.new('L', (W, W), 0)
    ImageDraw.Draw(front).rounded_rectangle([U(x0), U(132), U(x1), U(bot)], U(r), fill=255)
    top, btm = (138, 206, 255), (60, 154, 242)
    g = Image.linear_gradient('L').resize((W, W))
    ys = (U(132), U(bot))
    def ch(i):
        return g.point(lambda v: int(top[i] + (btm[i] - top[i]) * min(1, max(0, (v / 255 * W - ys[0]) / (ys[1] - ys[0])))))
    frontc = Image.merge('RGBA', [ch(0), ch(1), ch(2), front])
    # soft shadow line between back and front
    sh = Image.new('L', (W, W), 0)
    ImageDraw.Draw(sh).rounded_rectangle([U(x0), U(128), U(x1), U(bot)], U(r), fill=35)
    img.alpha_composite(Image.merge('RGBA', [Image.new('L', (W, W), 30), Image.new('L', (W, W), 100), Image.new('L', (W, W), 200), sh]))
    img.alpha_composite(frontc)
    d = ImageDraw.Draw(img)
    # highlight
    d.rounded_rectangle([U(x0 + 18), U(144), U(x1 - 18), U(152)], U(4), fill=(206, 234, 255, 235))
    # smile face
    face = (52, 134, 222, 255)
    w = 17
    for cx in (174, 338):
        d.rounded_rectangle([U(cx - w / 2), U(258), U(cx + w / 2), U(360)], U(w / 2), fill=face)
    # mouth: a gentle curve with round ends
    pts = []
    for i in range(41):
        t = i / 40
        x = 182 + (330 - 182) * t
        y = 376 + 26 * (1 - (2 * t - 1) ** 2)
        pts.append((U(x), U(y)))
    d.line(pts, fill=face, width=U(w), joint='curve')
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - U(w / 2), y - U(w / 2), x + U(w / 2), y + U(w / 2)], fill=face)
    return img.resize((512, 512), Image.LANCZOS)

big = icon()
out = sys.argv[1]
big.save(f'{out}/icon.png')
def sz(n): return big.resize((n, n), Image.LANCZOS)
for n, name in [(32, '32x32.png'), (64, '64x64.png'), (128, '128x128.png'), (256, '128x128@2x.png'), (30, 'Square30x30Logo.png'),
                (44, 'Square44x44Logo.png'), (71, 'Square71x71Logo.png'), (89, 'Square89x89Logo.png'), (107, 'Square107x107Logo.png'),
                (142, 'Square142x142Logo.png'), (150, 'Square150x150Logo.png'), (284, 'Square284x284Logo.png'), (310, 'Square310x310Logo.png'), (50, 'StoreLogo.png')]:
    sz(n).save(f'{out}/{name}')
big.save(f'{out}/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)])
big.resize((1024, 1024), Image.LANCZOS).save(f'{out}/icon.icns')
