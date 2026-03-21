# media-mcp contract

This MCP is the AI-facing evidence layer for video projects.

## Design rules

- Return stable IDs first, file paths second.
- Return machine-readable time (`*_us`, `*_frame`) first, human-readable timecode second.
- Never force the agent to read raw JSON blobs unless it asks.
- Every response should include `project_id` and `artifact_version`.
- `preview_url` / `image_path` / `waveform_path` are optional convenience fields, not primary identity.

---

## 1. `media.project_summary`

### Request
```json
{
  "project_id": "mountain-brand-film"
}
```

### Response
```json
{
  "project_id": "mountain-brand-film",
  "artifact_version": "analysis-v3",
  "assets_total": 42,
  "segments_total": 891,
  "transcripts_available": true,
  "contact_sheets_available": true,
  "qc_status": "ready",
  "top_motifs": ["morning light", "hands", "trail texture"],
  "analysis_gaps": []
}
```

---

## 2. `media.list_assets`

### Request
```json
{
  "project_id": "mountain-brand-film",
  "filter": {
    "has_transcript": true,
    "tags_any": ["interview", "b-roll"]
  },
  "limit": 50,
  "cursor": null
}
```

### Response
```json
{
  "project_id": "mountain-brand-film",
  "artifact_version": "analysis-v3",
  "items": [
    {
      "asset_id": "AST_001",
      "role_guess": "interview",
      "duration_us": 182340000,
      "segments": 17,
      "quality_flags": ["slight_wind"],
      "poster_path": "projects/.../posters/AST_001.jpg",
      "contact_sheet_ids": ["CS_AST_001_01", "CS_AST_001_02"]
    }
  ],
  "next_cursor": null
}
```

---

## 3. `media.get_asset`

### Request
```json
{
  "project_id": "mountain-brand-film",
  "asset_id": "AST_001"
}
```

### Response
```json
{
  "project_id": "mountain-brand-film",
  "artifact_version": "analysis-v3",
  "asset_id": "AST_001",
  "duration_us": 182340000,
  "video_stream": {
    "width": 3840,
    "height": 2160,
    "fps_num": 24000,
    "fps_den": 1001
  },
  "audio_stream": {
    "sample_rate": 48000,
    "channels": 2
  },
  "transcript_ref": "TR_AST_001",
  "contact_sheet_ids": ["CS_AST_001_01", "CS_AST_001_02"],
  "segment_ids": ["SEG_0001", "SEG_0002"],
  "quality_flags": ["slight_wind"]
}
```

---

## 4. `media.open_contact_sheet`

### Request
```json
{
  "project_id": "mountain-brand-film",
  "contact_sheet_id": "CS_AST_001_01"
}
```

### Response
```json
{
  "project_id": "mountain-brand-film",
  "artifact_version": "analysis-v3",
  "contact_sheet_id": "CS_AST_001_01",
  "image_path": "projects/.../contact_sheets/CS_AST_001_01.png",
  "tile_map": [
    {
      "tile_index": 0,
      "segment_id": "SEG_0001",
      "rep_frame_us": 1250000,
      "src_in_us": 1000000,
      "src_out_us": 2400000,
      "summary": "subject laces shoes"
    }
  ]
}
```

---

## 5. `media.search_segments`

### Request
```json
{
  "project_id": "mountain-brand-film",
  "query": "quiet morning preparation with hands and breath",
  "filters": {
    "exclude_quality_flags": ["out_of_focus", "black_segment"],
    "duration_max_us": 7000000
  },
  "top_k": 20
}
```

### Response
```json
{
  "project_id": "mountain-brand-film",
  "artifact_version": "analysis-v3",
  "results": [
    {
      "segment_id": "SEG_0143",
      "asset_id": "AST_007",
      "src_in_us": 11200000,
      "src_out_us": 15850000,
      "score": 0.91,
      "evidence": ["embedding", "transcript", "visual_tag"],
      "summary": "close-up of hands tightening pack strap"
    }
  ]
}
```

---

## 6. `media.peek_segment`

### Request
```json
{
  "project_id": "mountain-brand-film",
  "segment_id": "SEG_0143",
  "mode": "full"
}
```

### Response
```json
{
  "project_id": "mountain-brand-film",
  "artifact_version": "analysis-v3",
  "segment_id": "SEG_0143",
  "asset_id": "AST_007",
  "src_in_us": 11200000,
  "src_out_us": 15850000,
  "src_in_tc": "00:00:11:06",
  "src_out_tc": "00:00:15:20",
  "filmstrip_path": "projects/.../filmstrips/SEG_0143.png",
  "waveform_path": "projects/.../waveforms/SEG_0143.png",
  "transcript_excerpt": "",
  "quality_flags": [],
  "tags": ["hands", "prep", "soft_light"]
}
```

---

## 7. `media.extract_window`

### Request
```json
{
  "project_id": "mountain-brand-film",
  "asset_id": "AST_007",
  "start_us": 11200000,
  "end_us": 15850000,
  "sample_fps": 8,
  "width": 1024
}
```

### Response
```json
{
  "project_id": "mountain-brand-film",
  "artifact_version": "analysis-v3",
  "window_id": "WIN_AST_007_11200000_15850000",
  "filmstrip_path": "projects/.../windows/WIN_AST_007_11200000_15850000.png",
  "clip_proxy_path": "projects/.../windows/WIN_AST_007_11200000_15850000.mp4"
}
```

---

## 8. `media.read_transcript_span`

### Request
```json
{
  "project_id": "mountain-brand-film",
  "transcript_ref": "TR_AST_001",
  "start_us": 45000000,
  "end_us": 62000000
}
```

### Response
```json
{
  "project_id": "mountain-brand-film",
  "artifact_version": "analysis-v3",
  "items": [
    {
      "speaker": "S1",
      "start_us": 45200000,
      "end_us": 48100000,
      "text": "I come up here to breathe."
    }
  ]
}
```

---

## 9. `media.compile_timeline`

This is a deterministic engine wrapper, not an LLM tool.

### Request
```json
{
  "project_id": "mountain-brand-film",
  "blueprint_path": "projects/.../04_plan/edit_blueprint.yaml",
  "selects_path": "projects/.../04_plan/selects_candidates.yaml",
  "output_version": "v001"
}
```

### Response
```json
{
  "project_id": "mountain-brand-film",
  "timeline_path": "projects/.../05_timeline/v001.timeline.json",
  "otio_path": "projects/.../05_timeline/v001.otio",
  "preview_manifest_path": "projects/.../05_timeline/v001.preview-manifest.json"
}
```

---

## 10. `media.render_preview`

### Request
```json
{
  "project_id": "mountain-brand-film",
  "timeline_path": "projects/.../05_timeline/v001.timeline.json",
  "preset": "review-1080p"
}
```

### Response
```json
{
  "project_id": "mountain-brand-film",
  "render_path": "projects/.../05_timeline/v001.review.mp4",
  "waveform_burnin": true,
  "timecode_burnin": true
}
```

---

## 11. `media.run_qc`

### Request
```json
{
  "project_id": "mountain-brand-film",
  "target": "projects/.../05_timeline/v001.review.mp4"
}
```

### Response
```json
{
  "project_id": "mountain-brand-film",
  "qc_report_path": "projects/.../qc/v001.qc.json",
  "fatal_issues": [],
  "warnings": ["audio peak close to threshold"]
}
```
