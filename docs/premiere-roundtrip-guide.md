# Premiere Pro Roundtrip Guide

Video OS v2 generates FCP7 XML (xmeml v5) for Premiere Pro interchange.
This document covers the export, edit, and reimport workflow.

## Prerequisites

- Adobe Premiere Pro 2022 or later (CC)
- Source media files accessible from the paths in `02_media/source_map.json`
- `timeline.json` compiled in `05_timeline/`

## 1. Export to Premiere

```bash
npx tsx scripts/export-premiere-xml.ts <project-path> [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--source-map <file>` | Override asset_id to file path mapping |
| `--titles <file>` | Text overlay definitions (JSON array) |
| `--auto-titles` | Auto-generate overlays from timeline markers |

**Output:** `<project-path>/09_output/<project_id>_premiere.xml`

The XML embeds `video_os` marker metadata in each clip, enabling roundtrip identification. A metadata comment at the top records the project ID, generation timestamp, and compiler version.

Simple transitions are limited to marked, centered Cross Dissolve (`crossfade`) and Dip to Color (`match_cut_bridge` / `match_cut`). IDs, endpoint pairs, named-track membership, adjacency, positive integer duration, and the centered timeline window are validated before output. `fade_to_black` is never represented as Cross Dissolve.

Canonical `timeline.tracks.overlay` title clips are enumerated before XML generation, but the current registered presets all require motion, font, layout, shadow/stroke, accent, panel/background, or safe-area semantics that Outline Text cannot represent. Canonical overlay export therefore fails closed with a structured styling diagnostic before XML or receipt writes. No registered plain-title preset currently provides an exact route. Caption tracks are never exported as generators. `--titles` and `--auto-titles` remain legacy export-only options and cannot be treated as canonical O1.

### Display Names

If `02_media/source_map.json` contains `display_name` fields, they are used as clip names in Premiere. Otherwise, the clip's `motivation` field is used.

## 2. Import into Premiere Pro

1. Open Premiere Pro
2. **File > Import** (Ctrl+I / Cmd+I)
3. Select the `_premiere.xml` file
4. The sequence appears in the Project panel -- double-click to open in the Timeline

### What to Expect

- Video tracks V1, V2, ... map to Premiere video tracks
- Audio tracks A1, A2, ... map to Premiere audio tracks
- Clip names show display names or editorial motivations
- Marker comments contain `video_os:{...}` metadata (visible in Marker panel)
- Media may show as offline if paths differ from your local machine; relink via **File > Link Media**

## 3. Edit in Premiere

Make your edits freely. The reimport system detects these change types:

| Edit Type | Detection | Auto-Apply |
|-----------|-----------|------------|
| Trim (in/out points) | Compares src frames | Yes |
| Reorder (move clips) | Compares timeline position | Yes |
| Delete clips | Missing clip_id | Yes |
| Add new clips | No `video_os` marker | No (warning) |
| Edit/delete/add title generators | Marked canonical generator comparison | No (blocks apply) |
| Add/delete/change simple transitions | Marked track and endpoint identity comparison | No (blocks apply) |

**Important:** Do not remove or modify the `video_os:` marker comments. They are the roundtrip anchor.

## 4. Export from Premiere

1. Select the sequence in the Timeline
2. **File > Export > Final Cut Pro XML...**
3. Save as `.xml`
4. Use this file for reimport

## 5. Reimport into Video OS

### Dry Run (preview changes)

```bash
npx tsx scripts/import-premiere-xml.ts <project-path> --xml <edited.xml> --dry-run
```

Shows a human-readable diff report without modifying any files.

### JSON Output (for programmatic use)

```bash
npx tsx scripts/import-premiere-xml.ts <project-path> --xml <edited.xml> --dry-run --json
```

Outputs a structured JSON diff summary:

```json
{
  "sequence_name": "Mountain Reset",
  "total_clips_in_xml": 14,
  "mapped_clips": 13,
  "unmapped_clips": 1,
  "total_diffs": 3,
  "by_kind": { "trim_changed": 2, "deleted": 1 },
  "diffs": [ ... ]
}
```

### Apply Changes

```bash
npx tsx scripts/import-premiere-xml.ts <project-path> --xml <edited.xml> --receipt <receipt.json> --apply
```

This will:
1. Create a backup at `timeline.json.bak`
2. Apply trim, reorder, and delete changes
3. Skip unmapped clips with a warning

## Limitations & Known Issues

### Unmapped Clips

Clips added in Premiere without `video_os` markers cannot be auto-imported. They appear in the diff report as `added_unmapped`. To incorporate them, manually add corresponding entries to the timeline.

### Frame Precision

Time conversion between microseconds (timeline.json) and frames (FCP7 XML) introduces up to 1-frame tolerance due to rounding. The diff detector accounts for this.

### NTSC Frame Rates

29.97fps (30000/1001) and 23.976fps (24000/1001) are correctly handled with `<ntsc>TRUE</ntsc>` and appropriate timebase values.

### Non-ASCII Paths

Japanese and other non-ASCII characters in file paths are percent-encoded in `<pathurl>`. Premiere decodes these on import. If relinking is needed, use the original file names.

### ASCII Clip IDs

FCP7 XML `clipitem/@id` attributes are restricted to ASCII. Non-ASCII characters in clip IDs are hex-encoded (e.g., CJK characters become `xNNNN`).

### Text Overlays

Canonical overlay export is currently blocked because no registered preset is exactly representable by the emitted Outline Text parameters. A receipt-bound manifest still supports fail-closed review of previously produced marked generators: any returned title change, deletion, malformed marker/shape, duplicate, or unmapped generator is report-only and blocks apply before backup or timeline writes, including an overlay-only sequence whose sole generator is missing or malformed. Legacy `--titles` / `--auto-titles` generators are export-only and never apply to canonical O1. This fixture-backed contract is not Premiere hardware proof.

### Audio Levels

Audio-track gain and fade policy is exported as exactly one Audio Levels (`audiolevels`) filter with exactly one `level` parameter. Import accepts only finite linear gain in the 0..4 range, either as a static value or as strictly ordered, unique keyframes within the clip duration that form the supported gain plus fade-in/fade-out shapes. Duplicate effects or parameters, extra parameters, invalid identities or shapes, non-finite/out-of-range values, and ambiguous keyframes are structured unsupported edits that block apply.

If the reference timeline requires exported gain or fades and a returned mapped audio clip has no Audio Levels filter, import reports `audiolevels_filter_missing` and blocks before backup or write. It never interprets disappearance as an intentional policy deletion. With a valid filter still present, gain/fade changes remain diffable and applicable alongside trim changes.

No visual effect, Motion, Opacity, Crop, Lumetri, keying, speed/time-remap, nested/compound replacement, or arbitrary audio effect is native roundtrip support. Mapped direct effects reject apply; unmapped additions remain report-only/manual.

For the closed static treatment subset (`zoom`, pixel crop/position, brightness/contrast/saturation), run `export-premiere-xml.ts --preflight --json`. A treated project returns exit 2 until the operator explicitly supplies `--bake-visual-effects`. The exporter then requires exact source-ledger/source-map/source-media-manifest/live-file provenance and cleared rights/privacy, and writes a video-only H.264 CRF 14 near-lossless replacement under the fixed `09_output/premiere-bakes` cache. XML labels it `[BAKED]`, markers declare `representation:baked_visual` and `effect_editable:false`, while canonical audio continues to reference original media independently. Unsupported, malformed, duplicate, overlapping, no-op, animated, HDR/VFR/rotated/alpha, or unverified input blocks; it is never silently omitted.

The authoritative export is the generation named by `09_output/premiere-exports/CURRENT.json`, containing immutable XML, receipt v2, bake index, READY, manifests, and media. Import validates that complete chain before diff. Baked unchanged, same-track reorder, and delete are accepted; trim, track move, relink/source replacement, speed/rate, filter, and marker mutation block before backup/write. `hardware_verified` remains false: local fixtures do not prove Premiere behavior, human acceptance, rights clearance, or release readiness.

### Simple Transitions

Returned transition identity is the named video track plus marked `from_clip_id` and `to_clip_id`. Added, deleted, effect, duration, alignment, identity, orphan, duplicate, and unknown-effect cases are structured report-only edits. Any such edit blocks apply before backup or timeline writes; an unknown effect is never defaulted to Cross Dissolve. Unchanged transitions survive supported clip/audio apply unchanged. Source-handle authority is not available, so the Premiere profile remains `report_only`. The rich fixture is explicitly synthetic and is not Premiere or hardware proof.

### Empty Tracks

Empty audio tracks (e.g., A2, A3 with no clips) are exported as empty `<track>` elements. Premiere may collapse or ignore them.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Media offline after import | Path mismatch | Relink via File > Link Media |
| Markers not visible | Panel hidden | Window > Markers |
| "No changes detected" but edits were made | Edits within 1-frame tolerance | Verify frame-level changes exceed tolerance |
| XML import fails | Non-ASCII in id attributes | Update to latest export script |
| Diff report shows unexpected changes | Premiere modified timecodes | Compare with `--dry-run --json` output |

## Premiere Plugin (Auto-Reload)

The `premiere-plugin/` directory contains a UXP file-watcher plugin that automatically reimports the XML when the file changes. See `premiere-plugin/README.md` for setup.
