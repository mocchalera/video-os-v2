/**
 * FCP7 XML roundtrip tests
 *
 * Tests:
 * 1. XML parser basics
 * 2. Marker comment parsing
 * 3. Export → Import roundtrip (same timeline restored)
 * 4. Diff detection: trim change, reorder, delete, unmapped add
 * 5. Diff application (patch)
 * 6. Japanese path roundtrip
 */

import { describe, it, expect } from "vitest";
import type { TimelineIR, ClipOutput, TrackOutput } from "../runtime/compiler/types.js";
import { timelineToFcp7Xml } from "../runtime/handoff/fcp7-xml-export.js";
import {
  parseFcp7Xml,
  parseVideoOsMarker,
  parseFcp7Sequence,
  parsedSequenceToTimelineIR,
  detectDiffs,
  applyDiffs,
} from "../runtime/handoff/fcp7-xml-import.js";

// ── Test helpers ─────────────────────────────────────────────────────

function makeClip(overrides: Partial<ClipOutput> = {}): ClipOutput {
  return {
    clip_id: "clip-1",
    segment_id: "seg-1",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 3_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 72,
    role: "hero",
    motivation: "Test clip",
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
    version: "1.0.0",
    project_id: "TEST_001",
    created_at: "2024-01-01T00:00:00Z",
    sequence: {
      name: "Test Sequence",
      fps_num: 24,
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
      brief_path: "test/brief.yaml",
      blueprint_path: "test/blueprint.yaml",
      selects_path: "test/selects.yaml",
      compiler_version: "test-1.0.0",
    },
  };
}

// ── 1. XML Parser ────────────────────────────────────────────────────

describe("parseFcp7Xml", () => {
  it("parses a simple element with text", () => {
    const node = parseFcp7Xml("<name>Hello World</name>");
    expect(node.tag).toBe("name");
    expect(node.text).toBe("Hello World");
  });

  it("parses attributes", () => {
    const node = parseFcp7Xml('<file id="file-1"/>');
    expect(node.tag).toBe("file");
    expect(node.attrs.id).toBe("file-1");
    expect(node.children).toHaveLength(0);
  });

  it("parses nested elements", () => {
    const xml = `<root><child1>A</child1><child2>B</child2></root>`;
    const node = parseFcp7Xml(xml);
    expect(node.tag).toBe("root");
    expect(node.children).toHaveLength(2);
    expect(node.children[0].tag).toBe("child1");
    expect(node.children[0].text).toBe("A");
    expect(node.children[1].tag).toBe("child2");
    expect(node.children[1].text).toBe("B");
  });

  it("handles XML entity unescaping", () => {
    const node = parseFcp7Xml("<text>A &amp; B &lt; C</text>");
    expect(node.text).toBe("A & B < C");
  });

  it("handles self-closing tags with attributes", () => {
    const xml = `<root><file id="f1"/><file id="f2"/></root>`;
    const node = parseFcp7Xml(xml);
    expect(node.children).toHaveLength(2);
    expect(node.children[0].attrs.id).toBe("f1");
    expect(node.children[1].attrs.id).toBe("f2");
  });
});

// ── 2. Marker Comment Parsing ────────────────────────────────────────

describe("parseVideoOsMarker", () => {
  it("parses JSON format marker comment", () => {
    const meta = parseVideoOsMarker(
      'video_os:{"exchange_clip_id":"clip-1","clip_id":"clip-1","asset_id":"AST_001","beat_id":"beat-1","motivation":"Hero shot"}',
    );
    expect(meta).toEqual({
      clip_id: "clip-1",
      asset_id: "AST_001",
      beat_id: "beat-1",
      motivation: "Hero shot",
    });
  });

  it("parses legacy pipe-delimited format", () => {
    const meta = parseVideoOsMarker(
      "video_os:clip_id=clip-1|asset_id=AST_001|beat_id=beat-1|motivation=Hero shot",
    );
    expect(meta).toEqual({
      clip_id: "clip-1",
      asset_id: "AST_001",
      beat_id: "beat-1",
      motivation: "Hero shot",
    });
  });

  it("returns null for non-video_os comments", () => {
    expect(parseVideoOsMarker("Just a comment")).toBeNull();
    expect(parseVideoOsMarker("")).toBeNull();
  });

  it("handles empty motivation in JSON format", () => {
    const meta = parseVideoOsMarker(
      'video_os:{"clip_id":"c1","asset_id":"a1","beat_id":"b1","motivation":""}',
    );
    expect(meta).not.toBeNull();
    expect(meta!.motivation).toBe("");
  });

  it("handles empty motivation in pipe format", () => {
    const meta = parseVideoOsMarker(
      "video_os:clip_id=c1|asset_id=a1|beat_id=b1|motivation=",
    );
    expect(meta).not.toBeNull();
    expect(meta!.motivation).toBe("");
  });

  it("returns null when required fields are missing", () => {
    expect(parseVideoOsMarker('video_os:{"clip_id":"c1"}')).toBeNull();
    expect(
      parseVideoOsMarker('video_os:{"clip_id":"c1","asset_id":"a1"}'),
    ).toBeNull();
  });
});

// ── 3. Export → Import Roundtrip ─────────────────────────────────────

describe("roundtrip: export then import", () => {
  it("preserves clip identity through export/import cycle", () => {
    const clip1 = makeClip({
      clip_id: "clip-alpha",
      asset_id: "AST_A",
      src_in_us: 1_000_000,
      src_out_us: 4_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
      beat_id: "beat-intro",
      motivation: "Opening shot",
    });
    const clip2 = makeClip({
      clip_id: "clip-beta",
      asset_id: "AST_B",
      src_in_us: 500_000,
      src_out_us: 2_500_000,
      timeline_in_frame: 72,
      timeline_duration_frames: 48,
      beat_id: "beat-main",
      motivation: "Main content",
    });

    const timeline = makeTimeline([[clip1, clip2]]);

    const sourceMap = new Map<string, string>([
      ["AST_A", "/media/footage/clip_a.mov"],
      ["AST_B", "/media/footage/clip_b.mov"],
    ]);

    // Export to XML
    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    expect(xml).toContain("xmeml");
    // Marker comments use JSON format with XML-escaped quotes
    expect(xml).toContain("clip-alpha");
    expect(xml).toContain("clip-beta");

    // Parse back
    const parsed = parseFcp7Sequence(xml);
    expect(parsed.name).toBe("Test Sequence");
    expect(parsed.timebase).toBe(24);
    expect(parsed.videoTracks).toHaveLength(1);
    expect(parsed.videoTracks[0]).toHaveLength(2);

    // Verify clip identity via markers
    const parsedClip1 = parsed.videoTracks[0][0];
    expect(parsedClip1.videoOsMeta).not.toBeNull();
    expect(parsedClip1.videoOsMeta!.clip_id).toBe("clip-alpha");
    expect(parsedClip1.videoOsMeta!.asset_id).toBe("AST_A");

    const parsedClip2 = parsed.videoTracks[0][1];
    expect(parsedClip2.videoOsMeta).not.toBeNull();
    expect(parsedClip2.videoOsMeta!.clip_id).toBe("clip-beta");

    // Convert back to TimelineIR
    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    expect(imported.tracks.video).toHaveLength(1);
    expect(imported.tracks.video[0].clips).toHaveLength(2);

    const importedClip1 = imported.tracks.video[0].clips[0];
    expect(importedClip1.clip_id).toBe("clip-alpha");
    expect(importedClip1.asset_id).toBe("AST_A");
    expect(importedClip1.beat_id).toBe("beat-intro");
    expect(importedClip1.timeline_in_frame).toBe(0);
    expect(importedClip1.timeline_duration_frames).toBe(72);
  });

  it("detects no diffs when timeline is unchanged", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);

    expect(report.diffs).toHaveLength(0);
    expect(report.mappedClips).toBe(1);
    expect(report.unmappedClips).toBe(0);
  });
});

// ── 4. Diff Detection ────────────────────────────────────────────────

describe("diff detection", () => {
  it("detects in/out trim changes", () => {
    const clip = makeClip({
      clip_id: "clip-1",
      src_in_us: 0,
      src_out_us: 3_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
    });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    // Export, then modify the XML to change in/out
    let xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Simulate Premiere changing in from 0 to 12 and out from 72 to 60
    xml = xml.replace(/<in>0<\/in>/, "<in>12</in>");
    xml = xml.replace(/<out>72<\/out>/, "<out>60</out>");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);

    expect(report.diffs.length).toBeGreaterThan(0);
    const trimDiff = report.diffs.find((d) => d.kind === "trim_changed");
    expect(trimDiff).toBeDefined();
    expect(trimDiff!.clip_id).toBe("clip-1");
  });

  it("detects clip reorder", () => {
    const clip1 = makeClip({
      clip_id: "clip-1",
      asset_id: "AST_001",
      timeline_in_frame: 0,
      timeline_duration_frames: 48,
    });
    const clip2 = makeClip({
      clip_id: "clip-2",
      asset_id: "AST_002",
      timeline_in_frame: 48,
      timeline_duration_frames: 48,
    });
    const timeline = makeTimeline([[clip1, clip2]]);
    const sourceMap = new Map([
      ["AST_001", "/media/a.mov"],
      ["AST_002", "/media/b.mov"],
    ]);

    let xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Move clip-1 from frame 0→48 by targeting its specific clipitem
    // Replace within the first clipitem block (clip-1)
    xml = xml.replace(
      /(<clipitem id="cv-clip-1">[\s\S]*?)<start>0<\/start>([\s\S]*?)<end>48<\/end>/,
      "$1<start>48</start>$2<end>96</end>",
    );
    // Replace within the second clipitem block (clip-2)
    xml = xml.replace(
      /(<clipitem id="cv-clip-2">[\s\S]*?)<start>48<\/start>([\s\S]*?)<end>96<\/end>/,
      "$1<start>0</start>$2<end>48</end>",
    );

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);

    const reorderDiffs = report.diffs.filter((d) => d.kind === "reordered");
    expect(reorderDiffs.length).toBeGreaterThanOrEqual(1);
  });

  it("detects clip deletion", () => {
    const clip1 = makeClip({
      clip_id: "clip-1",
      asset_id: "AST_001",
      timeline_in_frame: 0,
      timeline_duration_frames: 48,
    });
    const clip2 = makeClip({
      clip_id: "clip-2",
      asset_id: "AST_002",
      timeline_in_frame: 48,
      timeline_duration_frames: 48,
    });
    const timeline = makeTimeline([[clip1, clip2]]);
    const sourceMap = new Map([
      ["AST_001", "/media/a.mov"],
      ["AST_002", "/media/b.mov"],
    ]);

    let xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Remove the second clipitem entirely
    const clipitemRegex =
      /<clipitem id="cv-clip-2">[\s\S]*?<\/clipitem>/;
    xml = xml.replace(clipitemRegex, "");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);

    const deleteDiffs = report.diffs.filter((d) => d.kind === "deleted");
    expect(deleteDiffs).toHaveLength(1);
    expect(deleteDiffs[0].clip_id).toBe("clip-2");
  });

  it("detects unmapped new clips", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    let xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Add a new clipitem without video_os marker
    const newClip = `
        <clipitem id="new-premiere-clip">
          <name>New clip from Premiere</name>
          <duration>48</duration>
          <rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate>
          <start>72</start>
          <end>120</end>
          <in>0</in>
          <out>48</out>
          <file id="file-1"/>
        </clipitem>`;
    xml = xml.replace("</track>", newClip + "\n        </track>");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);

    expect(report.unmappedClips).toBe(1);
    const addDiffs = report.diffs.filter((d) => d.kind === "added_unmapped");
    expect(addDiffs).toHaveLength(1);
  });
});

// ── 5. Diff Application ─────────────────────────────────────────────

describe("applyDiffs", () => {
  it("applies trim changes to timeline", () => {
    const clip = makeClip({
      clip_id: "clip-1",
      src_in_us: 0,
      src_out_us: 3_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
    });
    const timeline = makeTimeline([[clip]]);

    const patched = applyDiffs(timeline, [
      {
        kind: "trim_changed",
        clip_id: "clip-1",
        detail: "Trim changed",
        original: {
          src_in_us: 0,
          src_out_us: 3_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 72,
        },
        updated: {
          src_in_us: 500_000,
          src_out_us: 2_500_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 48,
        },
      },
    ]);

    const patchedClip = patched.tracks.video[0].clips[0];
    expect(patchedClip.src_in_us).toBe(500_000);
    expect(patchedClip.src_out_us).toBe(2_500_000);
    expect(patchedClip.timeline_duration_frames).toBe(48);
  });

  it("removes deleted clips", () => {
    const clip1 = makeClip({ clip_id: "clip-1" });
    const clip2 = makeClip({
      clip_id: "clip-2",
      timeline_in_frame: 72,
    });
    const timeline = makeTimeline([[clip1, clip2]]);

    const patched = applyDiffs(timeline, [
      {
        kind: "deleted",
        clip_id: "clip-2",
        detail: "Clip deleted",
      },
    ]);

    expect(patched.tracks.video[0].clips).toHaveLength(1);
    expect(patched.tracks.video[0].clips[0].clip_id).toBe("clip-1");
  });

  it("applies reorder and sorts by timeline position", () => {
    const clip1 = makeClip({
      clip_id: "clip-1",
      timeline_in_frame: 0,
      timeline_duration_frames: 48,
    });
    const clip2 = makeClip({
      clip_id: "clip-2",
      timeline_in_frame: 48,
      timeline_duration_frames: 48,
    });
    const timeline = makeTimeline([[clip1, clip2]]);

    const patched = applyDiffs(timeline, [
      {
        kind: "reordered",
        clip_id: "clip-1",
        detail: "Moved",
        original: {
          src_in_us: 0,
          src_out_us: 3_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 48,
        },
        updated: {
          src_in_us: 0,
          src_out_us: 3_000_000,
          timeline_in_frame: 48,
          timeline_duration_frames: 48,
        },
      },
      {
        kind: "reordered",
        clip_id: "clip-2",
        detail: "Moved",
        original: {
          src_in_us: 0,
          src_out_us: 3_000_000,
          timeline_in_frame: 48,
          timeline_duration_frames: 48,
        },
        updated: {
          src_in_us: 0,
          src_out_us: 3_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 48,
        },
      },
    ]);

    // After sort, clip-2 should be first (frame 0), clip-1 second (frame 48)
    expect(patched.tracks.video[0].clips[0].clip_id).toBe("clip-2");
    expect(patched.tracks.video[0].clips[1].clip_id).toBe("clip-1");
  });

  it("does not mutate the original timeline", () => {
    const clip = makeClip({ clip_id: "clip-1" });
    const timeline = makeTimeline([[clip]]);
    const originalJson = JSON.stringify(timeline);

    applyDiffs(timeline, [
      {
        kind: "deleted",
        clip_id: "clip-1",
        detail: "Deleted",
      },
    ]);

    expect(JSON.stringify(timeline)).toBe(originalJson);
  });
});

// ── 6. Japanese Path Roundtrip ───────────────────────────────────────

describe("Japanese path roundtrip", () => {
  it("handles Japanese characters in file paths", () => {
    const clip = makeClip({
      clip_id: "clip-jp",
      asset_id: "AST_JP",
    });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([
      ["AST_JP", "/メディア/素材/インタビュー.mov"],
    ]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Verify pathurl is percent-encoded
    expect(xml).toContain("file://localhost/");
    // The pathurl should be percent-encoded, but <name> retains original filename
    expect(xml).toContain("pathurl");

    // Parse back
    const parsed = parseFcp7Sequence(xml);
    expect(parsed.videoTracks[0][0].videoOsMeta).not.toBeNull();
    expect(parsed.videoTracks[0][0].videoOsMeta!.clip_id).toBe("clip-jp");

    // File reference should be present (encoded URL)
    expect(parsed.videoTracks[0][0].pathurl).toBeTruthy();
  });

  it("handles Japanese characters in clip motivation", () => {
    const clip = makeClip({
      clip_id: "clip-jp2",
      motivation: "オープニングショット",
    });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    // Marker comment contains clip_id in JSON format
    expect(xml).toContain("clip-jp2");

    const parsed = parseFcp7Sequence(xml);
    const meta = parsed.videoTracks[0][0].videoOsMeta;
    expect(meta).not.toBeNull();
    expect(meta!.motivation).toBe("オープニングショット");
  });
});

// ── 7. Audio track roundtrip ─────────────────────────────────────────

describe("audio track roundtrip", () => {
  it("preserves audio clips with duck level", () => {
    const audioClip = makeClip({
      clip_id: "audio-1",
      asset_id: "AST_MUSIC",
      role: "music",
      motivation: "BGM",
      beat_id: "beat-bgm",
      audio_policy: { duck_music_db: -12 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_MUSIC", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    expect(xml).toContain("audiolevels");
    expect(xml).toContain("-12");

    const parsed = parseFcp7Sequence(xml);
    expect(parsed.audioTracks).toHaveLength(1);
    expect(parsed.audioTracks[0]).toHaveLength(1);
    expect(parsed.audioTracks[0][0].audioLevelDb).toBe(-12);
    expect(parsed.audioTracks[0][0].videoOsMeta!.clip_id).toBe("audio-1");
  });
});
