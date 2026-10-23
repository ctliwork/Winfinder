# Draws the app icon and writes every size Tauri needs.
# Run: python3 scripts/make-icon.py src-tauri/icons  (needs Pillow)
#
# Taitung: the Coastal Mountain Range meeting the Pacific under a wide blue
# sky with summer clouds, and a hot-air balloon over Luye. Big simple shapes,
# so it still reads at 16-32 px on the taskbar.
import math
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 4  # supersampling
W = 512 * S
U = lambda v: v * S  # 512-unit design coords -> canvas px


def vgrad(top, bottom, y0=0, y1=512):
    """A vertical gradient between two colours, from design y0 to y1."""
    g = Image.new('RGBA', (1, W))
    for y in range(W):
        t = min(1, max(0, (y / S - y0) / (y1 - y0)))
        g.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    return g.resize((W, W))


def layer(colour_img, mask):
    out = colour_img.copy()
    out.putalpha(ImageChops.multiply(colour_img.getchannel('A'), mask))
    return out


def ridge(points, base=520):
    """A filled mountain shape through (x, y) points, smoothed, down to `base`."""
    pts = []
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        for i in range(24):
            t = i / 24
            s = (1 - math.cos(math.pi * t)) / 2  # ease between peaks and saddles
            pts.append((U(x0 + (x1 - x0) * t), U(y0 + (y1 - y0) * s)))
    pts.append((U(points[-1][0]), U(points[-1][1])))
    mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(mask).polygon(pts + [(U(points[-1][0]), U(base)), (U(points[0][0]), U(base))], fill=255)
    return mask


def cloud(d, cx, cy, k):
    """A puffy cloud: a flat base and three domes, `k` = scale."""
    for dx, dy, r in ((-46, 6, 30), (-8, -14, 42), (36, 2, 32), (0, 14, 30)):
        d.ellipse([U(cx + (dx - r) * k), U(cy + (dy - r) * k), U(cx + (dx + r) * k), U(cy + (dy + r) * k)], fill=255)
    d.rounded_rectangle([U(cx - 76 * k), U(cy + 4 * k), U(cx + 68 * k), U(cy + 44 * k)], U(20 * k), fill=255)


def icon():
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    scene = vgrad((22, 119, 214), (150, 214, 245), 20, 330)  # sky: deep azure to pale near the horizon

    # clouds, with a faint shadow so they stand out from the pale sky
    cl = Image.new('L', (W, W), 0)
    d = ImageDraw.Draw(cl)
    cloud(d, 170, 128, 1.15)
    cloud(d, 380, 200, 0.7)
    shadow = cl.filter(ImageFilter.GaussianBlur(U(6)))
    scene.alpha_composite(layer(Image.new('RGBA', (W, W), (40, 90, 150, 255)), shadow.point(lambda v: v * 45 // 255)), (0, U(6)))
    scene.alpha_composite(layer(vgrad((255, 255, 255), (226, 238, 248), 90, 250), cl))

    # hot-air balloon (Luye), small, right of the big cloud
    # the envelope: a round top tapering to the mouth, with stripes that follow its shape
    bx, by, br = 338, 82, 20
    env = Image.new('L', (W, W), 0)
    ed = ImageDraw.Draw(env)
    ed.ellipse([U(bx - br), U(by - br), U(bx + br), U(by + br)], fill=255)
    ed.polygon([(U(bx - br * 0.98), U(by + 4)), (U(bx + br * 0.98), U(by + 4)), (U(bx + 5), U(by + br + 13)), (U(bx - 5), U(by + br + 13))], fill=255)
    stripes = Image.new('L', (W, W), 0)
    sd = ImageDraw.Draw(stripes)
    for k in (-1, 1):  # two curved yellow panels either side of the middle
        sd.ellipse([U(bx + k * br * 0.5 - br * 0.2), U(by - br - 4), U(bx + k * br * 0.5 + br * 0.2), U(by + br + 16)], fill=255)
    scene.alpha_composite(layer(Image.new('RGBA', (W, W), (236, 72, 60, 255)), env))
    scene.alpha_composite(layer(Image.new('RGBA', (W, W), (255, 196, 58, 255)), ImageChops.multiply(env, stripes)))
    bd = ImageDraw.Draw(scene)
    bd.line([(U(bx - 5), U(by + br + 13)), (U(bx - 5), U(by + br + 18))], fill=(120, 74, 44, 255), width=int(U(1.5)))
    bd.line([(U(bx + 5), U(by + br + 13)), (U(bx + 5), U(by + br + 18))], fill=(120, 74, 44, 255), width=int(U(1.5)))
    bd.rounded_rectangle([U(bx - 6), U(by + br + 18), U(bx + 6), U(by + br + 27)], U(2), fill=(140, 84, 50, 255))

    # far range: hazy blue-green
    far = ridge([(-10, 300), (60, 250), (130, 282), (215, 228), (300, 268), (380, 236), (460, 272), (530, 252)])
    scene.alpha_composite(layer(vgrad((92, 160, 180), (120, 182, 190), 230, 360), far))
    # near range: the Coastal Range, deep green, sloping down to the sea on the right
    near = ridge([(-10, 336), (70, 268), (150, 312), (235, 282), (330, 330), (420, 352), (530, 362)])
    scene.alpha_composite(layer(vgrad((52, 150, 92), (24, 104, 70), 270, 400), near))

    # the Pacific: deep blue, lighter near the shore, with a line of surf
    sea = Image.new('L', (W, W), 0)
    ImageDraw.Draw(sea).rectangle([0, U(384), W, W], fill=255)
    scene.alpha_composite(layer(vgrad((18, 112, 196), (8, 70, 150), 384, 512), sea))
    surf = Image.new('L', (W, W), 0)
    sd = ImageDraw.Draw(surf)
    pts = [(U(x), U(388 + 5 * math.sin(x / 34))) for x in range(-10, 530, 4)]
    sd.line(pts, fill=235, width=int(U(9)), joint='curve')
    scene.alpha_composite(layer(Image.new('RGBA', (W, W), (236, 248, 255, 255)), surf))
    glint = Image.new('L', (W, W), 0)
    gd = ImageDraw.Draw(glint)
    for x, y, w in ((96, 432, 70), (300, 452, 96), (190, 478, 58)):
        gd.rounded_rectangle([U(x), U(y), U(x + w), U(y + 7)], U(4), fill=110)
    scene.alpha_composite(layer(Image.new('RGBA', (W, W), (200, 232, 255, 255)), glint))

    # the tile: a rounded square like Windows 11 app icons, with a soft inner edge
    tile = Image.new('L', (W, W), 0)
    ImageDraw.Draw(tile).rounded_rectangle([U(16), U(16), U(496), U(496)], U(104), fill=255)
    img.alpha_composite(layer(scene, tile))
    edge = Image.new('L', (W, W), 0)
    ImageDraw.Draw(edge).rounded_rectangle([U(16), U(16), U(496), U(496)], U(104), outline=255, width=int(U(4)))
    img.alpha_composite(layer(Image.new('RGBA', (W, W), (255, 255, 255, 255)), edge.point(lambda v: v * 60 // 255)))
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
