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
npx tsx scripts/import-premiere-xml.ts <project-path> --xml <edited.xml>
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

Text overlays exported via `--titles` or `--auto-titles` use FCP7's Outline Text generator. In Premiere, they appear on a dedicated V-Title track. Font rendering may differ between Premiere versions.

### Audio Levels

`duck_music_db` values from `audio_policy` are exported as Audio Levels filter parameters and preserved through roundtrip.

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
