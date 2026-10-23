# Draws the app icon and writes every size Tauri needs.
# Run: python3 scripts/make-icon.py src-tauri/icons  (needs Pillow)
#
# Taitung, soft, flat and a little abstract: layered peaks down to the Coastal
# Range and a strip of the Pacific under a wide blue sky with a few clouds.
# Gentle solid colours and big rounded shapes, so it still reads at 16-32 px on the taskbar.
import math
import sys

from PIL import Image, ImageChops, ImageDraw

S = 4  # supersampling
W = 512 * S
U = lambda v: v * S  # 512-unit design coords -> canvas px

SKY = (128, 184, 234, 255)
CLOUD = (255, 255, 255, 255)
SEA = (96, 150, 208, 255)


def layer(colour_img, mask):
    out = colour_img.copy()
    out.putalpha(ImageChops.multiply(colour_img.getchannel('A'), mask))
    return out


def icon():
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    scene = Image.new('RGBA', (W, W), SKY)
    d = ImageDraw.Draw(scene)

    # clouds: big and plain, a long pill with a dome on top
    for x0, y0, x1, y1, dx, dw in ((58, 132, 282, 188, 108, 104), (328, 84, 468, 122, 372, 62)):
        h = y1 - y0
        d.rounded_rectangle([U(x0), U(y0), U(x1), U(y1)], U(h / 2), fill=CLOUD)
        d.ellipse([U(dx), U(y0 - dw / 2), U(dx + dw), U(y0 + dw / 2)], fill=CLOUD)

    # peaks, back to front: rounded tops, each with a light and a shadow face
    def peak(top, left, right, light, shade, r=26, base=440):
        tx, ty = top
        # The tip is a circle of radius r touching both slopes.
        ul = (left - tx, base - ty)  # down the left slope
        ur = (right - tx, base - ty)  # down the right slope
        ul = [c / math.hypot(*ul) for c in ul]
        ur = [c / math.hypot(*ur) for c in ur]
        half = math.acos(ul[0] * ur[0] + ul[1] * ur[1]) / 2
        bis = [ul[0] + ur[0], ul[1] + ur[1]]
        bis = [c / math.hypot(*bis) for c in bis]
        cx, cy = tx + bis[0] * r / math.sin(half), ty + bis[1] * r / math.sin(half)
        t = r / math.tan(half)  # tip to where the circle meets each slope
        a0 = math.atan2((ty + ul[1] * t) - cy, (tx + ul[0] * t) - cx)
        a1 = math.atan2((ty + ur[1] * t) - cy, (tx + ur[0] * t) - cx)
        # from the left touch point over the top (angle -90 degrees, y grows downwards) to the right one
        arc = [(cx + r * math.cos(a0 + (a1 - a0) * i / 24), cy + r * math.sin(a0 + (a1 - a0) * i / 24)) for i in range(25)]
        shape = [(left, base)] + arc + [(right, base)]
        m = Image.new('L', (W, W), 0)
        ImageDraw.Draw(m).polygon([(U(x), U(y)) for x, y in shape], fill=255)
        scene.alpha_composite(layer(Image.new('RGBA', (W, W), light), m))
        half_m = Image.new('L', (W, W), 0)
        ImageDraw.Draw(half_m).rectangle([U(cx), 0, W, W], fill=255)
        scene.alpha_composite(layer(Image.new('RGBA', (W, W), shade), ImageChops.multiply(m, half_m)))
    peak((330, 168), 130, 540, (184, 220, 200, 255), (166, 206, 188, 255))
    peak((168, 218), -60, 380, (138, 196, 166, 255), (122, 182, 152, 255))
    peak((410, 286), 270, 560, (98, 168, 138, 255), (84, 154, 126, 255))

    # a strip of the Pacific
    d.rectangle([0, U(440), W, W], fill=SEA)

    tile = Image.new('L', (W, W), 0)
    ImageDraw.Draw(tile).rounded_rectangle([U(16), U(16), U(496), U(496)], U(116), fill=255)
    img.alpha_composite(layer(scene, tile))
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
