#!/usr/bin/env python3
"""Create labeled contact sheets for photo selection review."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff", ".webp"}


def iter_images(path: Path) -> list[Path]:
    return sorted(p for p in path.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)


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


def build_sheet(
    files: list[Path],
    output: Path,
    title: str,
    cols: int,
    rows: int,
    thumb_w: int,
    thumb_h: int,
) -> None:
    label_h = 34
    page = Image.new("RGB", (cols * thumb_w, rows * (thumb_h + label_h) + 30), "white")
    draw = ImageDraw.Draw(page)
    label_font = font(14)
    draw.text((8, 8), title, fill=(0, 0, 0), font=label_font)

    for idx, src in enumerate(files):
        row = idx // cols
        col = idx % cols
        x = col * thumb_w
        y = 30 + row * (thumb_h + label_h)
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
            bg = Image.new("RGB", (thumb_w, thumb_h), (238, 238, 238))
            bg.paste(im, ((thumb_w - im.width) // 2, (thumb_h - im.height) // 2))
        page.paste(bg, (x, y))
        draw.text((x + 6, y + thumb_h + 4), f"{src.name}", fill=(0, 0, 0), font=label_font)

    output.parent.mkdir(parents=True, exist_ok=True)
    page.save(output, quality=92)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--prefix", default="contact_sheet")
    parser.add_argument("--cols", type=int, default=5)
    parser.add_argument("--rows", type=int, default=8)
    parser.add_argument("--thumb-width", type=int, default=300)
    parser.add_argument("--thumb-height", type=int, default=200)
    args = parser.parse_args()

    files = iter_images(args.input)
    if not files:
        raise SystemExit(f"no images found in {args.input}")

    per_page = args.cols * args.rows
    total_pages = math.ceil(len(files) / per_page)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    for page_idx, start in enumerate(range(0, len(files), per_page), 1):
        batch = files[start : start + per_page]
        output = args.output_dir / f"{args.prefix}_{page_idx:02d}.jpg"
        title = f"{args.prefix} page {page_idx}/{total_pages} ({start + 1}-{start + len(batch)} of {len(files)})"
        build_sheet(batch, output, title, args.cols, args.rows, args.thumb_width, args.thumb_height)
        print(output)


if __name__ == "__main__":
    main()
