#!/usr/bin/env python3
"""Create neighboring-frame sheets for suspected blink/blur replacement candidates."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff", ".webp"}


def font(size: int) -> ImageFont.ImageFont:
    for candidate in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            pass
    return ImageFont.load_default()


def iter_images(path: Path) -> list[Path]:
    return sorted(p for p in path.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)


def make_sheet(target: Path, neighbors: list[Path], output: Path, cols: int = 5) -> None:
    thumb_w, thumb_h, label_h = 300, 210, 34
    rows = math.ceil(len(neighbors) / cols)
    sheet = Image.new("RGB", (cols * thumb_w, rows * (thumb_h + label_h) + 34), "white")
    draw = ImageDraw.Draw(sheet)
    label_font = font(15)
    draw.text((8, 8), f"Swap candidates for {target.name} (target marked with *)", fill=(0, 0, 0), font=label_font)

    for idx, src in enumerate(neighbors):
        row, col = divmod(idx, cols)
        x = col * thumb_w
        y = 34 + row * (thumb_h + label_h)
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
            bg = Image.new("RGB", (thumb_w, thumb_h), (238, 238, 238))
            bg.paste(im, ((thumb_w - im.width) // 2, (thumb_h - im.height) // 2))
        sheet.paste(bg, (x, y))
        mark = "* " if src.name == target.name else "  "
        color = (180, 0, 0) if src.name == target.name else (0, 0, 0)
        draw.text((x + 6, y + thumb_h + 4), f"{mark}{src.name}", fill=color, font=label_font)

    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, quality=92)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--candidates", required=True, help="comma-separated filenames or stems")
    parser.add_argument("--window", type=int, default=6)
    args = parser.parse_args()

    files = iter_images(args.input)
    by_name = {p.name: p for p in files}
    by_stem = {p.stem: p for p in files}
    positions = {p.name: idx for idx, p in enumerate(files)}
    args.output_dir.mkdir(parents=True, exist_ok=True)

    for raw in [item.strip() for item in args.candidates.split(",") if item.strip()]:
        target = by_name.get(raw) or by_stem.get(Path(raw).stem)
        if target is None:
            print(f"missing candidate: {raw}")
            continue
        pos = positions[target.name]
        neighbors = files[max(0, pos - args.window) : min(len(files), pos + args.window + 1)]
        output = args.output_dir / f"{target.stem}_swap_candidates.jpg"
        make_sheet(target, neighbors, output)
        print(output)


if __name__ == "__main__":
    main()
