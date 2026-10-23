# Draws the app icon and writes every size Tauri needs.
# Run: python3 scripts/make-icon.py src-tauri/icons  (needs Pillow)
#
# Taitung, flat and a little abstract: layered peaks down to the Coastal
# Range and a strip of the Pacific under a wide blue sky with a few clouds.
# Solid colours and big shapes, so it still reads at 16-32 px on the taskbar.
import sys

from PIL import Image, ImageChops, ImageDraw

S = 4  # supersampling
W = 512 * S
U = lambda v: v * S  # 512-unit design coords -> canvas px

SKY = (46, 136, 232, 255)
CLOUD = (255, 255, 255, 255)
SEA = (22, 92, 178, 255)


def layer(colour_img, mask):
    out = colour_img.copy()
    out.putalpha(ImageChops.multiply(colour_img.getchannel('A'), mask))
    return out


def icon():
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    scene = Image.new('RGBA', (W, W), SKY)
    d = ImageDraw.Draw(scene)

    # clouds: plain white pills
    for x0, y0, x1, y1 in ((96, 112, 236, 150), (150, 92, 206, 130), (372, 120, 456, 144)):
        d.rounded_rectangle([U(x0), U(y0), U(x1), U(y1)], U((y1 - y0) / 2), fill=CLOUD)

    # peaks, back to front, each with a light and a shadow face
    def peak(top, left, right, light, shade, base=440):
        tx, ty = top
        d.polygon([(U(left), U(base)), (U(tx), U(ty)), (U(tx), U(base))], fill=light)
        d.polygon([(U(tx), U(ty)), (U(right), U(base)), (U(tx), U(base))], fill=shade)
    peak((330, 168), 130, 540, (122, 200, 168), (92, 176, 146))
    peak((168, 218), -60, 380, (66, 170, 122), (44, 146, 104))
    peak((410, 286), 270, 560, (30, 128, 92), (20, 108, 80))

    # a strip of the Pacific
    d.rectangle([0, U(440), W, W], fill=SEA)

    tile = Image.new('L', (W, W), 0)
    ImageDraw.Draw(tile).rounded_rectangle([U(16), U(16), U(496), U(496)], U(104), fill=255)
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
