# Draws the app icon and writes every size Tauri needs.
# Run: python3 scripts/make-icon.py src-tauri/icons  (needs Pillow)
#
# Taitung as layered paper: a band of blue sky, three gentle ranges from hazy
# blue to deep green, and a wide stretch of the Pacific, each layer
# lifted off the next by a soft shadow. A macOS-style squircle tile.
import math
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 4  # supersampling
W = 512 * S
U = lambda v: v * S  # 512-unit design coords -> canvas px

WHITE = (255, 255, 255)
SHADOW = (0, 40, 110)


def vgrad(top, bottom, y0, y1):
    """A vertical gradient from `top` at design y0 to `bottom` at y1."""
    col = Image.new('RGBA', (1, W))
    for y in range(W):
        t = min(1, max(0, (y / S - y0) / (y1 - y0)))
        col.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    return col.resize((W, W))


def paint(img, colour, mask):
    """Lays `colour` (a colour or an image) onto `img` through `mask`."""
    c = colour.copy() if isinstance(colour, Image.Image) else Image.new('RGBA', (W, W), colour)
    c.putalpha(ImageChops.multiply(c.getchannel('A'), mask))
    img.alpha_composite(c)


def poly(pts):
    m = Image.new('L', (W, W), 0)
    ImageDraw.Draw(m).polygon([(U(x), U(y)) for x, y in pts], fill=255)
    return m


def ridge(points):
    """A range through (x, y) points, eased between them, filled to the bottom."""
    pts = []
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        for i in range(32):
            t = i / 32
            e = (1 - math.cos(math.pi * t)) / 2
            pts.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * e))
    pts.append(points[-1])
    return poly(pts + [(points[-1][0], 600), (points[0][0], 600)])


def band(y0, y1):
    m = Image.new('L', (W, W), 0)
    ImageDraw.Draw(m).rectangle([0, U(y0), W, U(y1)], fill=255)
    return m


def shadow_of(mask, dy, blur, alpha):
    """`mask` moved down by `dy`, blurred, as a soft shadow."""
    sh = mask.transform((W, W), Image.AFFINE, (1, 0, 0, 0, 1, -U(dy))).filter(ImageFilter.GaussianBlur(U(blur)))
    return sh.point(lambda v: v * alpha // 255)


def squircle(x0, y0, x1, y1, n=5.0):
    """The macOS icon shape: a superellipse |x|^n + |y|^n = 1."""
    cx, cy, rx, ry = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    pts = []
    for i in range(720):
        a = 2 * math.pi * i / 720
        c, s = math.cos(a), math.sin(a)
        pts.append((cx + rx * math.copysign(abs(c) ** (2 / n), c), cy + ry * math.copysign(abs(s) ** (2 / n), s)))
    return poly(pts)


def icon():
    scene = vgrad((60, 150, 240), (132, 196, 250), 40, 200)
    # three gentle ranges, from hazy blue to deep green, then a wide sea
    layers = [
        (ridge([(-10, 196), (160, 148), (340, 116), (530, 160)]), (176, 216, 246)),
        (ridge([(-10, 248), (190, 208), (370, 228), (530, 202)]), (72, 184, 136)),
        (ridge([(-10, 300), (210, 276), (530, 306)]), (34, 138, 98)),
        (band(334, 512), vgrad((64, 146, 222), (26, 92, 182), 334, 470)),
    ]
    for m, colour in layers:
        paint(scene, SHADOW, shadow_of(m, 10, 8, 55))
        paint(scene, colour, m)

    T = (40, 34, 472, 466)  # the tile, leaving room for its shadow below
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    paint(img, (0, 30, 70), shadow_of(squircle(T[0] + 4, T[1], T[2] - 4, T[3]), 10, 9, 70))
    paint(img, scene, squircle(*T))
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
