#!/usr/bin/env python3
"""Copy only the source clips used in the ena timeline from BUFFALO to local."""
import json, os, glob, shutil, sys

TIMELINE = "reports/eval/ena-golden/_scratch/full_timeline.json"
DEST = "projects/ena-promo/02_media"
MEDIA_DIRS = [
    "/Volumes/BUFFALO/恵那プロモーション/素材",
    "/Volumes/BUFFALO/恵那プロモーション/Final Cut Original Media",
]

with open(TIMELINE) as f:
    data = json.load(f)

sources = set()
for t in data["timeline"]:
    if t["type"] == "clip":
        sources.add(t["display_name"])

print(f"Unique sources to copy: {len(sources)}")

found = {}
for src in sorted(sources):
    for d in MEDIA_DIRS:
        for ext in [".mov", ".MOV", ".mp4", ".MP4"]:
            candidates = glob.glob(os.path.join(d, "**", src + ext), recursive=True)
            if candidates:
                found[src] = candidates[0]
                break
        if src in found:
            break

print(f"Found on disk: {len(found)}/{len(sources)}")
missing = sources - set(found.keys())
if missing:
    print(f"Missing (will skip): {sorted(missing)}")

total_size = sum(os.path.getsize(p) for p in found.values())
print(f"Total to copy: {total_size/1024/1024/1024:.1f}GB")

os.makedirs(DEST, exist_ok=True)

copied = 0
skipped = 0
for i, (src, src_path) in enumerate(sorted(found.items())):
    dest_path = os.path.join(DEST, os.path.basename(src_path))
    if os.path.exists(dest_path):
        existing_size = os.path.getsize(dest_path)
        expected_size = os.path.getsize(src_path)
        if existing_size == expected_size:
            skipped += 1
            continue
    sz_mb = os.path.getsize(src_path) / 1024 / 1024
    print(f"  [{i+1}/{len(found)}] {os.path.basename(src_path)} ({sz_mb:.0f}MB)...", end="", flush=True)
    shutil.copy2(src_path, dest_path)
    copied += 1
    print(" done")

print(f"\nCopied: {copied}, Skipped (already exists): {skipped}, Missing: {len(missing)}")
