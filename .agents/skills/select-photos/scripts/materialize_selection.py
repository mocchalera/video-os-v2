#!/usr/bin/env python3
"""Materialize album/highlight selections from photo_selection_manifest.json."""

from __future__ import annotations

import argparse
import json
import shutil
import zipfile
from pathlib import Path


def copy_selection(source_dir: Path, output_dir: Path, files: list[str]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for existing in output_dir.iterdir():
        if existing.is_file():
            existing.unlink()
    for idx, name in enumerate(files, 1):
        source = source_dir / name
        if not source.exists():
            raise FileNotFoundError(source)
        shutil.copy2(source, output_dir / f"{idx:03d}_{name}")


def zip_dir(directory: Path, output_zip: Path) -> None:
    if output_zip.exists():
        output_zip.unlink()
    with zipfile.ZipFile(output_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(directory.iterdir()):
            if path.is_file():
                zf.write(path, arcname=f"{directory.name}/{path.name}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--source-dir", type=Path)
    parser.add_argument("--no-zip", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text())
    source_dir = args.source_dir or args.project / "02_media" / "originals"
    delivery = args.project / "05_delivery"

    album = manifest.get("album_select", [])
    highlights = manifest.get("digest_highlights", [])
    if not album and not highlights:
        raise SystemExit("manifest has no album_select or digest_highlights")

    if album:
        album_dir = delivery / "album_select"
        copy_selection(source_dir, album_dir, album)
        if not args.no_zip:
            zip_dir(album_dir, delivery / f"album_select_{len(album)}.zip")
        print(album_dir)

    if highlights:
        highlights_dir = delivery / "digest_highlights"
        copy_selection(source_dir, highlights_dir, highlights)
        if not args.no_zip:
            zip_dir(highlights_dir, delivery / f"digest_highlights_{len(highlights)}.zip")
        print(highlights_dir)


if __name__ == "__main__":
    main()
