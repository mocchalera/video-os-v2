import { describe, it, expect } from "vitest";
import { timelineToFcp7Xml } from "../runtime/handoff/fcp7-xml-export.js";
import type { TimelineIR, ClipOutput, TrackOutput } from "../runtime/compiler/types.js";

// ── Test Helpers ──────────────────────────────────────────────────

function makeClip(overrides: Partial<ClipOutput> = {}): ClipOutput {
  return {
    clip_id: "clip-1",
    segment_id: "seg-1",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 5_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 150,
    role: "hero",
    motivation: "Opening shot",
    beat_id: "beat-1",
    fallback_segment_ids: [],
    confidence: 0.9,
    quality_flags: [],
    ...overrides,
  };
}

function makeTimeline(
  videoClips: ClipOutput[][],
  audioClips: ClipOutput[][] = [],
): TimelineIR {
  return {
    version: "1",
    project_id: "PROJ_TEST",
    created_at: "2025-01-01T00:00:00Z",
    sequence: {
      name: "Test Sequence",
      fps_num: 30,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
      timecode_format: "NDF",
    },
    tracks: {
      video: videoClips.map((clips, i) => ({
        track_id: `V${i + 1}`,
        kind: "video" as const,
        clips,
      })),
      audio: audioClips.map((clips, i) => ({
        track_id: `A${i + 1}`,
        kind: "audio" as const,
        clips,
      })),
    },
    markers: [],
    provenance: {
      brief_path: "01_brief/creative_brief.yaml",
      blueprint_path: "02_blueprint/edit_blueprint.yaml",
      selects_path: "03_analysis/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

// ── FATAL 1: File inline definition ──────────────────────────────

describe("FATAL 1: <file> inline definition on first use", () => {
  it("emits full <file> definition on first use (not empty reference)", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // First use must include <pathurl> and <media> inside <file>
    expect(xml).toContain("<file id=");
    expect(xml).toContain("<pathurl>file://localhost/path/to/video.MOV</pathurl>");
    expect(xml).toContain("<name>video.MOV</name>");
    // Must NOT have empty self-closing file as first occurrence
    const fileRefPattern = /<file id="file-1"\/>/;
    const fileDefPattern = /<file id="file-1">/;
    const fileDefIndex = xml.indexOf('<file id="file-1">');
    const fileRefIndex = xml.indexOf('<file id="file-1"/>');
    // The full definition must appear first
    expect(fileDefIndex).toBeGreaterThan(-1);
    if (fileRefIndex > -1) {
      expect(fileRefIndex).toBeGreaterThan(fileDefIndex);
    }
  });

  it("emits back-reference only on subsequent uses of same asset", () => {
    const clip1 = makeClip({ clip_id: "clip-1", timeline_in_frame: 0, timeline_duration_frames: 150 });
    const clip2 = makeClip({ clip_id: "clip-2", timeline_in_frame: 150, timeline_duration_frames: 150 });
    const timeline = makeTimeline([[clip1, clip2]]);
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Count occurrences of full file definition vs back-reference
    const fullDefs = xml.match(/<file id="file-1">/g);
    const backRefs = xml.match(/<file id="file-1"\/>/g);

    expect(fullDefs).toHaveLength(1); // Only one full definition
    expect(backRefs).toHaveLength(1); // One back-reference for second clip
  });

  it("defines separate files for different asset_ids", () => {
    const clip1 = makeClip({ clip_id: "clip-1", asset_id: "AST_001", timeline_in_frame: 0 });
    const clip2 = makeClip({ clip_id: "clip-2", asset_id: "AST_002", timeline_in_frame: 150 });
    const timeline = makeTimeline([[clip1, clip2]]);
    const sourceMap = new Map([
      ["AST_001", "/path/to/video1.MOV"],
      ["AST_002", "/path/to/video2.MOV"],
    ]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain('<file id="file-1">');
    expect(xml).toContain('<file id="file-2">');
    expect(xml).toContain("video1.MOV");
    expect(xml).toContain("video2.MOV");
  });

  it("handles asset used in video then audio (file defined in video, referenced in audio)", () => {
    const vClip = makeClip({ clip_id: "cv-1", asset_id: "AST_001" });
    const aClip = makeClip({ clip_id: "ca-1", asset_id: "AST_001" });
    const timeline = makeTimeline([[vClip]], [[aClip]]);
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Full definition should appear once (in video track)
    const fullDefs = xml.match(/<file id="file-1">/g);
    const backRefs = xml.match(/<file id="file-1"\/>/g);
    expect(fullDefs).toHaveLength(1);
    expect(backRefs).toHaveLength(1); // Audio track uses back-reference
  });
});

// ── W3: NTSC handling for 29.97fps ───────────────────────────────

describe("W3: NTSC frame rate handling", () => {
  it("emits ntsc=TRUE and timebase=30 for 29.97fps (30000/1001)", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    timeline.sequence.fps_num = 30000;
    timeline.sequence.fps_den = 1001;
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<timebase>30</timebase>");
    expect(xml).toContain("<ntsc>TRUE</ntsc>");
    expect(xml).not.toContain("<ntsc>FALSE</ntsc>");
  });

  it("emits ntsc=TRUE and timebase=24 for 23.976fps (24000/1001)", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    timeline.sequence.fps_num = 24000;
    timeline.sequence.fps_den = 1001;
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<timebase>24</timebase>");
    expect(xml).toContain("<ntsc>TRUE</ntsc>");
  });

  it("emits ntsc=FALSE and timebase=24 for exact 24fps", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    timeline.sequence.fps_num = 24;
    timeline.sequence.fps_den = 1;
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<timebase>24</timebase>");
    expect(xml).toContain("<ntsc>FALSE</ntsc>");
  });

  it("emits ntsc=FALSE and timebase=30 for exact 30fps", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    timeline.sequence.fps_num = 30;
    timeline.sequence.fps_den = 1;
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<timebase>30</timebase>");
    expect(xml).toContain("<ntsc>FALSE</ntsc>");
  });
});

// ── W4 + W6: Marker payload as JSON with exchange_clip_id ────────

describe("W4 + W6: Marker JSON payload with exchange_clip_id", () => {
  it("embeds JSON-encoded marker comment with video_os prefix", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Should contain video_os: prefix followed by JSON
    expect(xml).toContain("video_os:");
    // Should contain JSON keys
    expect(xml).toContain("&quot;clip_id&quot;");
    expect(xml).toContain("&quot;asset_id&quot;");
    expect(xml).toContain("&quot;beat_id&quot;");
    expect(xml).toContain("&quot;motivation&quot;");
  });

  it("includes exchange_clip_id derived from projectId:timelineVersion:clipId", () => {
    const clip = makeClip({ clip_id: "CLIP_42" });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, {
      sourceMap,
      projectId: "PROJ_X",
      timelineVersion: "v3",
    });

    // exchange_clip_id should be PROJ_X:v3:CLIP_42
    expect(xml).toContain("PROJ_X:v3:CLIP_42");
  });

  it("falls back to clip_id as exchange_clip_id when projectId is not provided", () => {
    const clip = makeClip({ clip_id: "CLIP_42" });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // exchange_clip_id should just be the clip_id
    expect(xml).toContain("&quot;exchange_clip_id&quot;:&quot;CLIP_42&quot;");
  });

  it("does not use pipe-delimited format", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Old format used |= separators — ensure they're gone
    expect(xml).not.toContain("clip_id=clip-1|");
    expect(xml).not.toContain("|asset_id=");
  });
});

// ── W2: Asset duration from assetDurationMap ─────────────────────

describe("W2: File duration from assetDurationMap", () => {
  it("uses assetDurationMap for <file> <duration> when provided", () => {
    const clip = makeClip({ src_out_us: 5_000_000 });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);
    // Asset total duration is 60 seconds = 1800 frames at 30fps
    const assetDurationMap = new Map([["AST_001", 60_000_000]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap, assetDurationMap });

    // The <file> <duration> should be 1800 (60s * 30fps), not 150 (5s * 30fps)
    // File definition duration
    const fileMatch = xml.match(/<file id="file-1">\s*[\s\S]*?<duration>(\d+)<\/duration>/);
    expect(fileMatch).not.toBeNull();
    expect(Number(fileMatch![1])).toBe(1800);
  });

  it("falls back to src_out_us when assetDurationMap is not provided", () => {
    const clip = makeClip({ src_out_us: 5_000_000 });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // File duration should be based on src_out_us = 5s * 30fps = 150
    const fileMatch = xml.match(/<file id="file-1">\s*[\s\S]*?<duration>(\d+)<\/duration>/);
    expect(fileMatch).not.toBeNull();
    expect(Number(fileMatch![1])).toBe(150);
  });
});

// ── Structural sanity ────────────────────────────────────────────

describe("FCP7 XML structural correctness", () => {
  it("produces valid xmeml v5 structure", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<!DOCTYPE xmeml>");
    expect(xml).toContain('<xmeml version="5">');
    expect(xml).toContain("</xmeml>");
    expect(xml).toContain("<sequence>");
    expect(xml).toContain("</sequence>");
    expect(xml).toContain("<timecode>");
    expect(xml).toContain("<displayformat>NDF</displayformat>");
  });

  it("produces DF displayformat when timecode_format is DF", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    timeline.sequence.timecode_format = "DF";
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<displayformat>DF</displayformat>");
  });
});
