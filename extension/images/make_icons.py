# @author Dario | ewtos.com
"""Erzeugt die EwtosBrain-Extension-Icons aus einem 512px-Master.

Brand-Akzent #6c63ff (Setup-Wizard). Motiv: abgerundete Kachel mit
Knowledge-Graph-Glyph (verbundene Nodes) — passt zur Vault-/Brain-Idee.
Lauf bei Brand-Aenderung erneut: python images/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent
S = 512
TOP = (124, 99, 255)     # #7c63ff
BOTTOM = (88, 60, 224)   # dunkleres Violett
NODE = (255, 255, 255)
LINK = (255, 255, 255, 150)


def rounded_mask(size: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size: int) -> Image.Image:
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        t = y / (size - 1)
        r = round(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        gr = round(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = round(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        for x in range(size):
            px[x, y] = (r, gr, b)
    return g


def build_master() -> Image.Image:
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bg = gradient(S).convert("RGBA")
    base.paste(bg, (0, 0), rounded_mask(S, int(S * 0.22)))

    draw = ImageDraw.Draw(base)
    # Knowledge-Graph: zentraler Node + 4 Satelliten
    cx = cy = S // 2
    big = int(S * 0.085)
    small = int(S * 0.055)
    sat = [
        (cx - int(S * 0.20), cy - int(S * 0.18)),
        (cx + int(S * 0.21), cy - int(S * 0.14)),
        (cx - int(S * 0.17), cy + int(S * 0.20)),
        (cx + int(S * 0.18), cy + int(S * 0.21)),
    ]
    link_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(link_layer)
    for (x, y) in sat:
        ld.line([(cx, cy), (x, y)], fill=LINK, width=int(S * 0.022))
    base.alpha_composite(link_layer)

    for (x, y) in sat:
        draw.ellipse([x - small, y - small, x + small, y + small], fill=NODE)
    draw.ellipse([cx - big, cy - big, cx + big, cy + big], fill=NODE)
    return base


def main() -> None:
    master = build_master()
    master.save(HERE / "icon-512.png")
    for size in (128, 48, 16):
        master.resize((size, size), Image.LANCZOS).save(HERE / f"icon-{size}.png")
    print("Icons geschrieben:", [p.name for p in HERE.glob("icon-*.png")])


if __name__ == "__main__":
    main()
