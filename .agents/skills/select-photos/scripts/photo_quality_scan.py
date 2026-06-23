#!/usr/bin/env python3
"""Generate lightweight quality metrics and optional face/eye review sheets."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps, ImageStat

try:
    import cv2  # type: ignore
    import numpy as np
except Exception:  # pragma: no cover - optional dependency
    cv2 = None
    np = None


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


def metrics_for(path: Path) -> dict:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        width, height = im.size
        gray = im.convert("L")
        gray.thumbnail((900, 900), Image.Resampling.LANCZOS)
        stat = ImageStat.Stat(gray)
        edge = ImageStat.Stat(gray.filter(ImageFilter.FIND_EDGES)).mean[0]
        return {
            "file": path.name,
            "width": width,
            "height": height,
            "mean_luma": round(stat.mean[0], 2),
            "contrast": round(stat.stddev[0], 2),
            "edge_score": round(edge, 2),
            "bytes": path.stat().st_size,
        }


def build_review_sheet(files: list[Path], output: Path, title: str, cols: int = 5) -> None:
    thumb_w, thumb_h, label_h = 280, 200, 44
    rows = math.ceil(len(files) / cols)
    sheet = Image.new("RGB", (cols * thumb_w, rows * (thumb_h + label_h) + 30), "white")
    draw = ImageDraw.Draw(sheet)
    label_font = font(14)
    draw.text((8, 8), title, fill=(0, 0, 0), font=label_font)
    for idx, src in enumerate(files):
        row, col = divmod(idx, cols)
        x = col * thumb_w
        y = 30 + row * (thumb_h + label_h)
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
            bg = Image.new("RGB", (thumb_w, thumb_h), (238, 238, 238))
            bg.paste(im, ((thumb_w - im.width) // 2, (thumb_h - im.height) // 2))
        sheet.paste(bg, (x, y))
        draw.text((x + 5, y + thumb_h + 3), src.name, fill=(0, 0, 0), font=label_font)
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, quality=92)


def face_crops(path: Path, cascade_path: str | None) -> list[Image.Image]:
    with Image.open(path) as src:
        image = ImageOps.exif_transpose(src).convert("RGB")
    if cv2 is None or np is None:
        return [center_crop(image)]

    cascade = None
    if cascade_path:
        cascade = cv2.CascadeClassifier(cascade_path)
    else:
        try:
            cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_alt2.xml")
        except Exception:
            cascade = None
    if cascade is None or cascade.empty():
        return [center_crop(image)]

    arr = np.asarray(image)
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(42, 42))
    faces = sorted([tuple(map(int, face)) for face in faces], key=lambda face: face[2] * face[3], reverse=True)[:4]
    if len(faces) == 0:
        return [center_crop(image)]

    crops: list[Image.Image] = []
    for x, y, w, h in faces:
        pad = int(max(w, h) * 0.55)
        x1 = max(0, x - pad)
        y1 = max(0, y - pad)
        x2 = min(image.width, x + w + pad)
        y2 = min(image.height, y + h + pad)
        crops.append(image.crop((x1, y1, x2, y2)))
    return crops


def center_crop(image: Image.Image) -> Image.Image:
    w, h = image.size
    side = min(w, h, int(max(w, h) * 0.6))
    x = max(0, (w - side) // 2)
    y = max(0, (h - side) // 3)
    return image.crop((x, y, x + side, y + side))


def build_eye_review(files: list[Path], output_dir: Path, cascade_path: str | None) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    items: list[tuple[str, Image.Image]] = []
    for path in files:
        for idx, crop in enumerate(face_crops(path, cascade_path), 1):
            items.append((f"{path.name} f{idx}", crop))

    cols, rows = 5, 5
    thumb_w, thumb_h, label_h = 260, 220, 42
    per_page = cols * rows
    label_font = font(14)
    for page_idx, start in enumerate(range(0, len(items), per_page), 1):
        batch = items[start : start + per_page]
        sheet = Image.new("RGB", (cols * thumb_w, rows * (thumb_h + label_h) + 30), "white")
        draw = ImageDraw.Draw(sheet)
        draw.text(
            (8, 8),
            f"Eye review crops page {page_idx} ({start + 1}-{start + len(batch)} of {len(items)})",
            fill=(0, 0, 0),
            font=label_font,
        )
        for idx, (label, crop) in enumerate(batch):
            row, col = divmod(idx, cols)
            x = col * thumb_w
            y = 30 + row * (thumb_h + label_h)
            crop = crop.convert("RGB")
            crop.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
            bg = Image.new("RGB", (thumb_w, thumb_h), (238, 238, 238))
            bg.paste(crop, ((thumb_w - crop.width) // 2, (thumb_h - crop.height) // 2))
            sheet.paste(bg, (x, y))
            draw.text((x + 5, y + thumb_h + 3), label, fill=(0, 0, 0), font=label_font)
        output = output_dir / f"eye_review_faces_{page_idx:02d}.jpg"
        sheet.save(output, quality=92)
        print(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--review-dir", type=Path)
    parser.add_argument("--eye-review-dir", type=Path)
    parser.add_argument("--cascade-path")
    parser.add_argument("--low-sharpness-count", type=int, default=30)
    args = parser.parse_args()

    files = iter_images(args.input)
    if not files:
        raise SystemExit(f"no images found in {args.input}")

    records = [metrics_for(p) for p in files]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"count": len(records), "items": records}, ensure_ascii=False, indent=2))
    print(args.output)

    if args.review_dir:
        by_name = {p.name: p for p in files}
        low = sorted(records, key=lambda item: item["edge_score"])[: args.low_sharpness_count]
        low_files = [by_name[item["file"]] for item in low]
        build_review_sheet(
            low_files,
            args.review_dir / "low_sharpness_review.jpg",
            f"Low sharpness candidates ({len(low_files)})",
        )
        print(args.review_dir / "low_sharpness_review.jpg")

    if args.eye_review_dir:
        build_eye_review(files, args.eye_review_dir, args.cascade_path)


if __name__ == "__main__":
    main()
