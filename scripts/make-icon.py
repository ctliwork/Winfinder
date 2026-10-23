# Draws the app icon and writes every size Tauri needs.
# Run: python3 scripts/make-icon.py src-tauri/icons  (needs Pillow)
#
# Dapo Pond in Chishang, Taitung, in the style of macOS app icons, kept
# simple: blue sky, two clouds and the mountain mirrored in the still pond.
# A squircle tile with a soft shadow, lit softly from the upper left.
import math
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 4  # supersampling
W = 512 * S
U = lambda v: v * S  # 512-unit design coords -> canvas px


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


def ridge(points, base=600):
    """A filled range through (x, y) points, eased between them, down to `base`."""
    pts = []
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        for i in range(32):
            t = i / 32
            s = (1 - math.cos(math.pi * t)) / 2
            pts.append((U(x0 + (x1 - x0) * t), U(y0 + (y1 - y0) * s)))
    pts.append((U(points[-1][0]), U(points[-1][1])))
    m = Image.new('L', (W, W), 0)
    ImageDraw.Draw(m).polygon(pts + [(U(points[-1][0]), U(base)), (U(points[0][0]), U(base))], fill=255)
    return m


def squircle(x0, y0, x1, y1, n=5.0):
    """The macOS icon shape: a superellipse |x|^n + |y|^n = 1."""
    cx, cy, rx, ry = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    pts = []
    for i in range(720):
        a = 2 * math.pi * i / 720
        c, s = math.cos(a), math.sin(a)
        pts.append((U(cx + rx * math.copysign(abs(c) ** (2 / n), c)), U(cy + ry * math.copysign(abs(s) ** (2 / n), s))))
    m = Image.new('L', (W, W), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m


H = 288  # the far shore: sky and mountains above, the pond's mirror below


def clouds():
    m = Image.new('L', (W, W), 0)
    d = ImageDraw.Draw(m)
    for x0, x1, y, h in ((40, 250, 118, 34), (86, 210, 98, 42), (280, 470, 76, 28), (318, 420, 62, 32)):
        d.rounded_rectangle([U(x0), U(y), U(x1), U(y + h)], U(h / 2), fill=255)
    return m


def landscape():
    """Sky, clouds and the mountains behind the pond, down to the far shore."""
    sc = vgrad((22, 118, 230), (124, 194, 248), 40, H)
    paint(sc, vgrad((164, 208, 246), (136, 194, 240), 190, H), ridge([(-10, 236), (110, 204), (240, 226), (380, 190), (530, 222)]))
    cl = clouds()
    shade = cl.filter(ImageFilter.GaussianBlur(U(4))).transform((W, W), Image.AFFINE, (1, 0, 0, 0, 1, -U(4)))
    paint(sc, (20, 70, 150), shade.point(lambda v: v * 45 // 255))
    paint(sc, vgrad((255, 255, 255), (224, 237, 250), 60, 220), cl)
    massif = ridge([(-10, 286), (90, 250), (200, 206), (262, 198), (330, 214), (430, 256), (530, 276)])
    paint(sc, vgrad((92, 200, 140), (38, 146, 98), 198, H), massif)
    # shade deepening gradually toward the right (light from the upper left), no hard edge
    shade = Image.linear_gradient('L').rotate(90).transpose(Image.FLIP_LEFT_RIGHT).resize((W, W))
    shade = shade.point(lambda v: max(0, min(255, (v - 90) * 230 // 165)))
    paint(sc, vgrad((54, 170, 116), (24, 124, 84), 198, H), ImageChops.multiply(massif, shade))
    return sc


def icon():
    T = (40, 34, 472, 466)  # the tile, leaving room for its shadow below
    up = landscape()
    scene = up.copy()

    # the pond: the landscape mirrored at the far shore, a little deeper in tone
    mirror = up.crop((0, 0, W, U(H))).transpose(Image.FLIP_TOP_BOTTOM)
    pond = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    pond.paste(mirror, (0, U(H)))
    pond = Image.blend(pond, Image.new('RGBA', (W, W), (18, 96, 150, 255)), 0.28)
    water = Image.new('L', (W, W), 0)
    ImageDraw.Draw(water).rectangle([0, U(H), W, W], fill=255)
    paint(scene, pond, water)
    # deeper water toward the viewer, so the reflection fades out near the bottom
    depth = Image.new('L', (1, W))
    for y in range(W):
        depth.putpixel((0, y), int(max(0, min(1, (y / S - (H + 30)) / 110)) * 245))
    paint(scene, (26, 104, 196), ImageChops.multiply(water, depth.resize((W, W))))
    # the far shore: a thin green line where the mountain meets its reflection
    bank = Image.new('L', (W, W), 0)
    ImageDraw.Draw(bank).rectangle([0, U(H - 3), W, U(H + 3)], fill=255)
    paint(scene, (22, 104, 72), bank)

    tile = squircle(*T)
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    # a soft shadow under the tile, as macOS draws its icons
    shadow = squircle(T[0] + 4, T[1] + 10, T[2] - 4, T[3] + 10).filter(ImageFilter.GaussianBlur(U(9)))
    paint(img, (0, 30, 70), shadow.point(lambda v: v * 70 // 255))
    paint(img, scene, tile)
    # a faint highlight along the top edge
    edge = ImageChops.subtract(tile, squircle(T[0], T[1] + 3, T[2], T[3] + 3))
    paint(img, (255, 255, 255), edge.point(lambda v: v * 90 // 255))
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
