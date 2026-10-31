"""Génère l'icône source de LoL BOT (assets/app-icon.png).

Design original « cyber » : hexagone néon cyan/magenta sur fond sombre,
monogramme LB. Aucun asset Riot Games n'est utilisé.

Usage :
    python scripts/make-icon.py
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = 2048  # rendu en 2x puis réduction pour l'anticrénelage
OUT = Path(__file__).resolve().parent.parent / "assets" / "app-icon.png"

BG = (7, 11, 22, 255)
INNER = (10, 16, 29, 255)
CYAN = (34, 211, 238)
MAGENTA = (232, 121, 249)
WHITE = (234, 246, 255, 255)


def hexagon(cx: float, cy: float, radius: float) -> list[tuple[float, float]]:
    """Hexagone « pointu » (pointe en haut), orienté comme un écusson."""
    points = []
    for i in range(6):
        angle = math.radians(60 * i - 90)
        points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return points


def gradient(size: int) -> Image.Image:
    """Dégradé diagonal cyan -> magenta."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / (size - 1)
    t = np.clip((x + y) / 2.0, 0.0, 1.0)
    rgb = np.zeros((size, size, 3), dtype=np.float32)
    for channel in range(3):
        rgb[..., channel] = CYAN[channel] + (MAGENTA[channel] - CYAN[channel]) * t
    alpha = np.full((size, size, 1), 255, dtype=np.float32)
    return Image.fromarray(np.concatenate([rgb, alpha], axis=2).astype(np.uint8), "RGBA")


def main() -> None:
    size = SIZE
    cx = cy = size / 2

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    # Fond : carré arrondi sombre.
    draw.rounded_rectangle((48, 48, size - 48, size - 48), radius=360, fill=BG)

    # Grille technique discrète.
    grid = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grid)
    step = 128
    for offset in range(48, size - 48, step):
        gdraw.line((offset, 48, offset, size - 48), fill=(34, 211, 238, 10), width=2)
        gdraw.line((48, offset, size - 48, offset), fill=(34, 211, 238, 10), width=2)
    canvas = Image.alpha_composite(canvas, grid)

    # Halo néon derrière l'hexagone.
    grad = gradient(size)
    glow_mask = Image.new("L", (size, size), 0)
    gm = ImageDraw.Draw(glow_mask)
    gm.polygon(hexagon(cx, cy, 800), outline=255, width=64)
    glow_mask = glow_mask.filter(ImageFilter.GaussianBlur(70))
    glow = Image.composite(grad, Image.new("RGBA", (size, size), (0, 0, 0, 0)), glow_mask)
    glow.putalpha(glow_mask.point(lambda v: int(v * 0.75)))
    canvas = Image.alpha_composite(canvas, glow)

    # Hexagone intérieur (plaque sombre).
    inner = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    idraw = ImageDraw.Draw(inner)
    idraw.polygon(hexagon(cx, cy, 700), fill=INNER)
    canvas = Image.alpha_composite(canvas, inner)

    # Anneau néon de l'hexagone.
    ring_mask = Image.new("L", (size, size), 0)
    rdraw = ImageDraw.Draw(ring_mask)
    rdraw.polygon(hexagon(cx, cy, 760), outline=255, width=34)
    ring = Image.composite(grad, Image.new("RGBA", (size, size), (0, 0, 0, 0)), ring_mask)
    ring.putalpha(ring_mask)
    canvas = Image.alpha_composite(canvas, ring)

    # Monogramme « LB » avec son halo cyan.
    font_path = Path("C:/Windows/Fonts/segoeuib.ttf")
    font = ImageFont.truetype(str(font_path), 560) if font_path.exists() else ImageFont.load_default()
    text = "LB"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = cx - text_w / 2 - bbox[0]
    ty = cy - text_h / 2 - bbox[1]

    text_glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tdraw = ImageDraw.Draw(text_glow)
    tdraw.text((tx, ty), text, font=font, fill=(34, 211, 238, 220))
    text_glow = text_glow.filter(ImageFilter.GaussianBlur(46))
    canvas = Image.alpha_composite(canvas, text_glow)

    text_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tldraw = ImageDraw.Draw(text_layer)
    tldraw.text((tx, ty), text, font=font, fill=WHITE)
    canvas = Image.alpha_composite(canvas, text_layer)

    # Petit trait d'accent sous le monogramme.
    accent = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    adraw = ImageDraw.Draw(accent)
    adraw.rounded_rectangle((cx - 250, cy + 330, cx + 250, cy + 348), radius=9, fill=(232, 121, 249, 235))
    canvas = Image.alpha_composite(canvas, accent)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.resize((1024, 1024), Image.LANCZOS).save(OUT)
    print(f"icône source générée : {OUT}")


if __name__ == "__main__":
    main()
