"""Draws Gil Tube's app icons into ../assets (needs Pillow: pip install pillow).

The mark is a video screen with a play triangle and a download arrow under
it, in the same sky-blue-on-navy palette as the UI. Everything is drawn at
4x and downsampled so edges stay smooth.

    python scripts/generate-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

N = 1024          # output size
S = 4             # supersampling factor
BIG = N * S

NAVY_TOP = (18, 32, 61)
NAVY_BOTTOM = (11, 17, 32)
SKY_TOP = (56, 189, 248)
SKY_BOTTOM = (2, 132, 199)
ARROW = (56, 189, 248)
WHITE = (255, 255, 255)

ASSETS = Path(__file__).resolve().parent.parent / "assets"


def gradient(size, top, bottom):
    mask = Image.linear_gradient("L").resize(size)
    return Image.composite(Image.new("RGB", size, bottom), Image.new("RGB", size, top), mask)


def xf(points, scale):
    """Scale artwork coordinates (1024 space) about the centre, into the big canvas."""
    return [((512 + (x - 512) * scale) * S, (512 + (y - 512) * scale) * S) for x, y in points]


def rounded_polygon(draw, points, radius, scale):
    pts = xf(points, scale)
    draw.polygon(pts, fill=255)
    # A thick line with curved joins rounds the corners of the polygon.
    draw.line(pts + [pts[0], pts[1]], fill=255, width=int(2 * radius * scale * S), joint="curve")


def masks(scale):
    screen = Image.new("L", (BIG, BIG), 0)
    play = Image.new("L", (BIG, BIG), 0)
    arrow = Image.new("L", (BIG, BIG), 0)

    # Video screen
    sd = ImageDraw.Draw(screen)
    (x0, y0), (x1, y1) = xf([(232, 224), (792, 584)], scale)
    sd.rounded_rectangle([x0, y0, x1, y1], radius=84 * scale * S, fill=255)

    # Play triangle (nudged right so it looks optically centred)
    rounded_polygon(ImageDraw.Draw(play), [(468, 336), (468, 474), (600, 405)], 12, scale)

    # Download arrow: shaft + head
    ad = ImageDraw.Draw(arrow)
    (sx0, sy0), (sx1, sy1) = xf([(482, 636), (542, 724)], scale)
    ad.rounded_rectangle([sx0, sy0, sx1, sy1], radius=30 * scale * S, fill=255)
    rounded_polygon(ad, [(424, 716), (600, 716), (512, 802)], 14, scale)

    return screen, play, arrow


def down(img):
    return img.resize((N, N), Image.LANCZOS)


def artwork_rgba(scale):
    """Colour artwork on a transparent background."""
    screen, play, arrow = masks(scale)
    layer = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    layer.paste(gradient((BIG, BIG), SKY_TOP, SKY_BOTTOM), (0, 0), screen)
    layer.paste(Image.new("RGB", (BIG, BIG), WHITE), (0, 0), play)
    layer.paste(Image.new("RGB", (BIG, BIG), ARROW), (0, 0), arrow)
    return down(layer)


def main():
    ASSETS.mkdir(exist_ok=True)
    background = gradient((N, N), NAVY_TOP, NAVY_BOTTOM)

    # Full icon (iOS / fallback): opaque, artwork fills the tile.
    icon = background.convert("RGBA")
    icon.alpha_composite(artwork_rgba(1.0))
    icon.convert("RGB").save(ASSETS / "icon.png")

    # Android adaptive icon: the launcher masks/crops to ~66% of the canvas,
    # so the foreground is drawn smaller to stay inside that safe zone.
    artwork_rgba(0.84).save(ASSETS / "android-icon-foreground.png")
    background.save(ASSETS / "android-icon-background.png")

    # Themed (monochrome) icon: single colour, play triangle cut out.
    screen, play, arrow = masks(0.84)
    mono_mask = Image.new("L", (BIG, BIG), 0)
    mono_mask.paste(255, (0, 0), screen)
    mono_mask.paste(0, (0, 0), play)
    mono_mask.paste(255, (0, 0), arrow)
    mono = Image.new("RGBA", (BIG, BIG), (255, 255, 255, 0))
    mono.putalpha(mono_mask)
    down(mono).save(ASSETS / "android-icon-monochrome.png")

    # Splash mark and web favicon
    artwork_rgba(0.84).save(ASSETS / "splash-icon.png")
    icon.convert("RGB").resize((48, 48), Image.LANCZOS).save(ASSETS / "favicon.png")

    print("wrote icons to", ASSETS)


if __name__ == "__main__":
    main()
