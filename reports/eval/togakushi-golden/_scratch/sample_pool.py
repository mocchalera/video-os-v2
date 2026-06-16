#!/usr/bin/env python3
"""Select the analysis pool: all 26 human-selected + ~30 random non-selected NINJAV clips."""
import random, re

# Human-selected takes (from DB decode)
HUMAN_SELECTED = {
    "T001","T003","T005","T008","T009","T010","T012","T015","T016",
    "T018","T019","T020","T023","T026","T027","T029","T031","T035",
    "T036","T037","T039","T042","T050","T056","T058","T062"
}

# Full pool: T001-T300 + DJI_0073-0083
ALL_NINJAV = {f"T{i:03d}" for i in range(1, 301)}
ALL_DJI = {f"DJI_{i:04d}" for i in range(73, 84)}

NON_SELECTED = sorted(ALL_NINJAV - HUMAN_SELECTED)

# Sample ~30 non-selected, spread across the range
random.seed(42)  # reproducible
SAMPLE_SIZE = 30
sampled = sorted(random.sample(NON_SELECTED, SAMPLE_SIZE))

# Also include a few DJI clips (human didn't use them, but they were in pool)
DJI_SAMPLE = sorted(random.sample(sorted(ALL_DJI), min(4, len(ALL_DJI))))

pool = sorted(HUMAN_SELECTED) + sampled + DJI_SAMPLE
print(f"=== Analysis Pool ===")
print(f"Human selected: {len(HUMAN_SELECTED)}")
print(f"Random non-selected NINJAV: {len(sampled)}")
print(f"DJI sample: {len(DJI_SAMPLE)}")
print(f"TOTAL: {len(pool)}")
print()

# Estimate size (avg NINJAV ~1.5GB, DJI ~0.5GB)
est_gb = len(HUMAN_SELECTED) * 1.5 + len(sampled) * 1.5 + len(DJI_SAMPLE) * 0.5
print(f"Estimated total size: ~{est_gb:.0f} GB")
print(f"(Cannot fit on 22GB internal; need batch copy-analyze-delete via Finder)")
print()

# Output as file list for the analyze script
print("=== File list (NINJAV_S001_S001_TXXX.MOV / DJI_XXXX.MOV) ===")
for t in pool:
    if t.startswith("DJI"):
        print(f"  {t}.MOV")
    else:
        print(f"  NINJAV_S001_S001_{t}.MOV")

# Save as JSON for automation
import json
files = []
for t in pool:
    if t.startswith("DJI"):
        files.append(f"{t}.MOV")
    else:
        files.append(f"NINJAV_S001_S001_{t}.MOV")
with open("/Users/mocchalera/Dev/video-os-v2-spec/reports/eval/togakushi-golden/_scratch/analysis_pool.json", "w") as f:
    json.dump({"human_selected": sorted(HUMAN_SELECTED),
               "sampled_non_selected": sampled,
               "dji_sample": DJI_SAMPLE,
               "files": files,
               "total": len(files)}, f, indent=2)
print(f"\nSaved to analysis_pool.json")
