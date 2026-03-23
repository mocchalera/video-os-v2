/**
 * Premiere Roundtrip E2E Tests
 *
 * Tests the full export→import cycle using the demo project's real timeline.json.
 * Validates FCP7 XML structure, roundtrip fidelity, diff detection for each
 * edit type, and metadata/display-name enhancements.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TimelineIR } from "../runtime/compiler/types.js";
import {
  timelineToFcp7Xml,
  type Fcp7ExportOptions,
} from "../runtime/handoff/fcp7-xml-export.js";
import {
  parseFcp7Xml,
  parseFcp7Sequence,
  parsedSequenceToTimelineIR,
  detectDiffs,
  applyDiffs,
  type ImportDiffReport,
} from "../runtime/handoff/fcp7-xml-import.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const DEMO_PROJECT_PATH = path.resolve(__dirname, "../projects/demo");
const DEMO_TIMELINE_PATH = path.join(
  DEMO_PROJECT_PATH,
  "05_timeline",
  "timeline.json",
);
const DEMO_ASSETS_PATH = path.join(
  DEMO_PROJECT_PATH,
  "03_analysis",
  "assets.json",
);

let demoTimeline: TimelineIR;
let demoSourceMap: Map<string, string>;
let demoDisplayNameMap: Map<string, string>;
let exportedXml: string;

interface AssetManifest {
  items: Array<{
    asset_id: string;
    filename: string;
  }>;
}

beforeAll(() => {
  // Load demo timeline
  if (!fs.existsSync(DEMO_TIMELINE_PATH)) {
    throw new Error(`Demo timeline not found: ${DEMO_TIMELINE_PATH}`);
  }
  demoTimeline = JSON.parse(fs.readFileSync(DEMO_TIMELINE_PATH, "utf-8"));

  // Build source map from assets.json (synthetic paths since real media not in repo)
  const assetsJson: AssetManifest = JSON.parse(
    fs.readFileSync(DEMO_ASSETS_PATH, "utf-8"),
  );
  demoSourceMap = new Map<string, string>();
  demoDisplayNameMap = new Map<string, string>();

  for (const item of assetsJson.items) {
    const syntheticPath = `/media/mountain-reset/${item.filename}`;
    demoSourceMap.set(item.asset_id, syntheticPath);
    // Derive display name from filename (strip extension, replace underscores)
    const stem = item.filename.replace(/\.[^.]+$/, "");
    const display = stem.replace(/_/g, " ").replace(/^ast \d+ /, "");
    demoDisplayNameMap.set(item.asset_id, display);
  }

  // Export once for reuse across tests
  exportedXml = timelineToFcp7Xml(demoTimeline, {
    sourceMap: demoSourceMap,
    assetDisplayNameMap: demoDisplayNameMap,
    projectId: demoTimeline.project_id,
  });
});

// ── 1. Export: XML Structure Validation ────────────────────────────────

describe("E2E: XML export structure (demo project)", () => {
  it("produces valid xmeml v5 document", () => {
    expect(exportedXml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(exportedXml).toContain("<!DOCTYPE xmeml>");
    expect(exportedXml).toContain('<xmeml version="5">');
    expect(exportedXml).toContain("</xmeml>");
  });

  it("includes Video OS metadata comment", () => {
    expect(exportedXml).toMatch(
      /<!-- Video OS v2 \| project: sample-mountain-reset \| generated: .+ \| compiler: .+ -->/,
    );
  });

  it("contains the correct sequence name", () => {
    expect(exportedXml).toContain("<name>Mountain Reset</name>");
  });

  it("contains correct frame rate", () => {
    expect(exportedXml).toContain("<timebase>24</timebase>");
    expect(exportedXml).toContain("<ntsc>FALSE</ntsc>");
  });

  it("contains correct resolution", () => {
    expect(exportedXml).toContain("<width>1920</width>");
    expect(exportedXml).toContain("<height>1080</height>");
  });

  it("contains all video clips from both tracks", () => {
    const v1Clips = demoTimeline.tracks.video[0].clips;
    const v2Clips = demoTimeline.tracks.video[1].clips;
    for (const clip of [...v1Clips, ...v2Clips]) {
      expect(exportedXml).toContain(`cv-${clip.clip_id}`);
    }
  });

  it("contains all audio clips", () => {
    const a1Clips = demoTimeline.tracks.audio[0].clips;
    for (const clip of a1Clips) {
      expect(exportedXml).toContain(`ca-${clip.clip_id}`);
    }
  });

  it("contains video_os marker comments with JSON payload for each clip", () => {
    const allClipIds = [
      ...demoTimeline.tracks.video.flatMap((t) => t.clips),
      ...demoTimeline.tracks.audio.flatMap((t) => t.clips),
    ].map((c) => c.clip_id);

    for (const clipId of allClipIds) {
      // Marker comment is XML-escaped: &quot; instead of "
      expect(exportedXml).toContain(`&quot;clip_id&quot;:&quot;${clipId}&quot;`);
    }
  });

  it("uses display names for clip names when assetDisplayNameMap provided", () => {
    // Verify that at least some display names appear in clip <name> elements
    expect(exportedXml).toContain("cabin interview");
    expect(exportedXml).toContain("trail walk");
  });

  it("encodes file paths as file:// URLs", () => {
    const pathUrlMatches = exportedXml.match(/<pathurl>file:\/\/localhost\/.+<\/pathurl>/g);
    expect(pathUrlMatches).not.toBeNull();
    expect(pathUrlMatches!.length).toBeGreaterThan(0);
  });

  it("uses file back-references for duplicate asset_ids", () => {
    // AST_005 appears in multiple clips; only first should have full <file> definition
    const fullFileMatches = exportedXml.match(/<file id="[^"]+">[\s\S]*?<\/file>/g) ?? [];
    const backRefMatches = exportedXml.match(/<file id="[^"]+"\/>/g) ?? [];

    // Must have at least one back-reference since assets are reused
    expect(backRefMatches.length).toBeGreaterThan(0);
    // Total file elements = full definitions + back-references
    expect(fullFileMatches.length + backRefMatches.length).toBeGreaterThan(
      fullFileMatches.length,
    );
  });

  it("is parseable by the XML parser", () => {
    expect(() => parseFcp7Xml(exportedXml)).not.toThrow();
  });
});

// ── 2. Export→Import Roundtrip Fidelity ──────────────────────────────

describe("E2E: roundtrip fidelity (demo project)", () => {
  it("parses back to correct sequence metadata", () => {
    const parsed = parseFcp7Sequence(exportedXml);
    expect(parsed.name).toBe("Mountain Reset");
    expect(parsed.timebase).toBe(24);
    expect(parsed.ntsc).toBe(false);
    expect(parsed.width).toBe(1920);
    expect(parsed.height).toBe(1080);
  });

  it("preserves all video tracks and clip count", () => {
    const parsed = parseFcp7Sequence(exportedXml);
    expect(parsed.videoTracks).toHaveLength(2);
    expect(parsed.videoTracks[0]).toHaveLength(
      demoTimeline.tracks.video[0].clips.length,
    );
    expect(parsed.videoTracks[1]).toHaveLength(
      demoTimeline.tracks.video[1].clips.length,
    );
  });

  it("preserves audio tracks (non-empty ones)", () => {
    const parsed = parseFcp7Sequence(exportedXml);
    // Only A1 has clips; empty tracks A2/A3 produce zero-clip tracks
    const nonEmptyAudio = parsed.audioTracks.filter((t) => t.length > 0);
    expect(nonEmptyAudio).toHaveLength(1);
    expect(nonEmptyAudio[0]).toHaveLength(
      demoTimeline.tracks.audio[0].clips.length,
    );
  });

  it("preserves clip identity via video_os markers", () => {
    const parsed = parseFcp7Sequence(exportedXml);

    for (const track of parsed.videoTracks) {
      for (const clip of track) {
        expect(clip.videoOsMeta).not.toBeNull();
        expect(clip.videoOsMeta!.clip_id).toBeTruthy();
        expect(clip.videoOsMeta!.asset_id).toBeTruthy();
        expect(clip.videoOsMeta!.beat_id).toBeTruthy();
      }
    }
  });

  it("converts back to TimelineIR with matching clip_ids", () => {
    const parsed = parseFcp7Sequence(exportedXml);
    const imported = parsedSequenceToTimelineIR(parsed, demoTimeline);

    const originalVideoIds = demoTimeline.tracks.video
      .flatMap((t) => t.clips)
      .map((c) => c.clip_id)
      .sort();
    const importedVideoIds = imported.tracks.video
      .flatMap((t) => t.clips)
      .map((c) => c.clip_id)
      .sort();

    expect(importedVideoIds).toEqual(originalVideoIds);
  });

  it("detects zero diffs on unmodified roundtrip", () => {
    const parsed = parseFcp7Sequence(exportedXml);
    const report = detectDiffs(parsed, demoTimeline);

    expect(report.diffs).toHaveLength(0);
    expect(report.unmappedClips).toBe(0);
    expect(report.mappedClips).toBeGreaterThan(0);
  });

  it("preserves timeline positions within 1-frame tolerance", () => {
    const parsed = parseFcp7Sequence(exportedXml);
    const imported = parsedSequenceToTimelineIR(parsed, demoTimeline);

    for (const [trackIdx, track] of imported.tracks.video.entries()) {
      const origTrack = demoTimeline.tracks.video[trackIdx];
      for (const [clipIdx, clip] of track.clips.entries()) {
        const orig = origTrack.clips[clipIdx];
        expect(clip.timeline_in_frame).toBe(orig.timeline_in_frame);
        expect(clip.timeline_duration_frames).toBe(
          orig.timeline_duration_frames,
        );
      }
    }
  });
});

// ── 3. Diff Detection: Each Edit Type ────────────────────────────────

describe("E2E: diff detection — trim changes (demo project)", () => {
  it("detects src_in/src_out trim change on a real clip", () => {
    let xml = exportedXml;

    // Modify CLP_0001's in/out (first clip in V1)
    // Original: src_in_us=1400000 → Math.round(1.4*24)=34 frames, src_out_us=6000000 → 144 frames
    // Change in from 34 to 48, out from 144 to 130
    xml = xml.replace(
      /(<clipitem id="cv-CLP_0001">[\s\S]*?)<in>34<\/in>([\s\S]*?)<out>144<\/out>/,
      "$1<in>48</in>$2<out>130</out>",
    );

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, demoTimeline);

    const trimDiffs = report.diffs.filter((d) => d.kind === "trim_changed");
    const clp0001Diff = trimDiffs.find((d) => d.clip_id === "CLP_0001");
    expect(clp0001Diff).toBeDefined();
    expect(clp0001Diff!.updated).toBeDefined();
  });
});

describe("E2E: diff detection — reorder (demo project)", () => {
  it("detects clip position change", () => {
    let xml = exportedXml;

    // Move CLP_0008 from timeline_in_frame=312 to 400
    // Original: <start>312</start><end>452</end>
    xml = xml.replace(
      /(<clipitem id="cv-CLP_0008">[\s\S]*?)<start>312<\/start>([\s\S]*?)<end>452<\/end>/,
      "$1<start>400</start>$2<end>540</end>",
    );

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, demoTimeline);

    const reorderDiffs = report.diffs.filter((d) => d.kind === "reordered");
    const clp0008Diff = reorderDiffs.find((d) => d.clip_id === "CLP_0008");
    expect(clp0008Diff).toBeDefined();
  });
});

describe("E2E: diff detection — deletion (demo project)", () => {
  it("detects clip removal", () => {
    let xml = exportedXml;

    // Remove CLP_0012 (third clip in V1)
    xml = xml.replace(/<clipitem id="cv-CLP_0012">[\s\S]*?<\/clipitem>/, "");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, demoTimeline);

    const deleteDiffs = report.diffs.filter((d) => d.kind === "deleted");
    expect(deleteDiffs.some((d) => d.clip_id === "CLP_0012")).toBe(true);
  });

  it("detects multiple clip deletions", () => {
    let xml = exportedXml;

    // Remove CLP_0001 and CLP_0008
    xml = xml.replace(/<clipitem id="cv-CLP_0001">[\s\S]*?<\/clipitem>/, "");
    xml = xml.replace(/<clipitem id="cv-CLP_0008">[\s\S]*?<\/clipitem>/, "");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, demoTimeline);

    const deletedIds = report.diffs
      .filter((d) => d.kind === "deleted")
      .map((d) => d.clip_id);
    expect(deletedIds).toContain("CLP_0001");
    expect(deletedIds).toContain("CLP_0008");
  });
});

describe("E2E: diff detection — unmapped clips (demo project)", () => {
  it("detects new clips added without video_os markers", () => {
    let xml = exportedXml;

    // Add a new clipitem without video_os marker in first video track
    const newClip = `
        <clipitem id="premiere-new-01">
          <name>New clip from editor</name>
          <duration>48</duration>
          <rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate>
          <start>700</start>
          <end>748</end>
          <in>0</in>
          <out>48</out>
          <file id="file-1"/>
        </clipitem>`;

    // Insert before first </track>
    xml = xml.replace("</track>", newClip + "\n        </track>");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, demoTimeline);

    expect(report.unmappedClips).toBeGreaterThanOrEqual(1);
    const addDiffs = report.diffs.filter((d) => d.kind === "added_unmapped");
    expect(addDiffs.length).toBeGreaterThanOrEqual(1);
  });
});

// ── 4. Diff Application ──────────────────────────────────────────────

describe("E2E: diff application (demo project)", () => {
  it("applies trim change and verifies patched timeline", () => {
    let xml = exportedXml;

    // Trim CLP_0001: change in from 34→48, out from 144→130
    xml = xml.replace(
      /(<clipitem id="cv-CLP_0001">[\s\S]*?)<in>34<\/in>([\s\S]*?)<out>144<\/out>/,
      "$1<in>48</in>$2<out>130</out>",
    );

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, demoTimeline);
    const applicableDiffs = report.diffs.filter(
      (d) => d.kind !== "added_unmapped",
    );

    const patched = applyDiffs(demoTimeline, applicableDiffs);
    const patchedClip = patched.tracks.video[0].clips.find(
      (c) => c.clip_id === "CLP_0001",
    );
    expect(patchedClip).toBeDefined();
    // The updated values should differ from original
    expect(patchedClip!.src_in_us).not.toBe(demoTimeline.tracks.video[0].clips[0].src_in_us);
  });

  it("applies deletion and removes clip from patched timeline", () => {
    let xml = exportedXml;
    xml = xml.replace(/<clipitem id="cv-CLP_0012">[\s\S]*?<\/clipitem>/, "");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, demoTimeline);
    const applicableDiffs = report.diffs.filter(
      (d) => d.kind !== "added_unmapped",
    );

    const patched = applyDiffs(demoTimeline, applicableDiffs);
    const allClipIds = patched.tracks.video
      .flatMap((t) => t.clips)
      .map((c) => c.clip_id);
    expect(allClipIds).not.toContain("CLP_0012");
  });

  it("does not mutate the original demo timeline", () => {
    const before = JSON.stringify(demoTimeline);

    let xml = exportedXml;
    xml = xml.replace(/<clipitem id="cv-CLP_0012">[\s\S]*?<\/clipitem>/, "");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, demoTimeline);
    applyDiffs(
      demoTimeline,
      report.diffs.filter((d) => d.kind !== "added_unmapped"),
    );

    expect(JSON.stringify(demoTimeline)).toBe(before);
  });
});

// ── 5. Export without display names (fallback) ────────────────────────

describe("E2E: export without assetDisplayNameMap", () => {
  it("falls back to motivation for clip names", () => {
    const xmlNoDisplayNames = timelineToFcp7Xml(demoTimeline, {
      sourceMap: demoSourceMap,
    });

    // First clip's motivation should appear as the name
    const firstClip = demoTimeline.tracks.video[0].clips[0];
    expect(xmlNoDisplayNames).toContain(firstClip.motivation);
  });
});

// ── 6. Multi-track consistency ────────────────────────────────────────

describe("E2E: multi-track roundtrip consistency", () => {
  it("preserves track assignment through roundtrip", () => {
    const parsed = parseFcp7Sequence(exportedXml);
    const imported = parsedSequenceToTimelineIR(parsed, demoTimeline);

    // V1 track should have same clips
    const origV1Ids = demoTimeline.tracks.video[0].clips
      .map((c) => c.clip_id)
      .sort();
    const importedV1Ids = imported.tracks.video[0].clips
      .map((c) => c.clip_id)
      .sort();
    expect(importedV1Ids).toEqual(origV1Ids);

    // V2 track should have same clips
    const origV2Ids = demoTimeline.tracks.video[1].clips
      .map((c) => c.clip_id)
      .sort();
    const importedV2Ids = imported.tracks.video[1].clips
      .map((c) => c.clip_id)
      .sort();
    expect(importedV2Ids).toEqual(origV2Ids);
  });

  it("diff report counts match total clip count", () => {
    const parsed = parseFcp7Sequence(exportedXml);
    const report = detectDiffs(parsed, demoTimeline);

    const totalClipsInTimeline =
      demoTimeline.tracks.video.reduce((n, t) => n + t.clips.length, 0) +
      demoTimeline.tracks.audio.reduce((n, t) => n + t.clips.length, 0);

    expect(report.mappedClips).toBe(totalClipsInTimeline);
    expect(report.totalClipsInXml).toBe(totalClipsInTimeline);
  });
});

// ── 7. Edge cases with real data ─────────────────────────────────────

describe("E2E: edge cases with demo data", () => {
  it("handles clips with non-zero src_in_us", () => {
    // CLP_0001 has src_in_us=1400000 (not zero)
    const parsed = parseFcp7Sequence(exportedXml);
    const clip = parsed.videoTracks[0].find(
      (c) => c.videoOsMeta?.clip_id === "CLP_0001",
    );
    expect(clip).toBeDefined();
    expect(clip!.srcInFrame).toBeGreaterThan(0);
  });

  it("handles multiple clips from same asset on different tracks", () => {
    // AST_003 appears in CLP_0002 (V2) and CLP_0004 (V2)
    const parsed = parseFcp7Sequence(exportedXml);
    const ast003Clips = [
      ...parsed.videoTracks.flat(),
      ...parsed.audioTracks.flat(),
    ].filter((c) => c.videoOsMeta?.asset_id === "AST_003");

    expect(ast003Clips.length).toBeGreaterThanOrEqual(2);
    // All should have valid markers
    for (const clip of ast003Clips) {
      expect(clip.videoOsMeta).not.toBeNull();
    }
  });

  it("preserves beat_id through roundtrip", () => {
    const parsed = parseFcp7Sequence(exportedXml);
    const imported = parsedSequenceToTimelineIR(parsed, demoTimeline);

    for (const track of imported.tracks.video) {
      for (const clip of track.clips) {
        const orig = demoTimeline.tracks.video
          .flatMap((t) => t.clips)
          .find((c) => c.clip_id === clip.clip_id);
        expect(orig).toBeDefined();
        expect(clip.beat_id).toBe(orig!.beat_id);
      }
    }
  });

  it("preserves role and metadata through roundtrip", () => {
    const parsed = parseFcp7Sequence(exportedXml);
    const imported = parsedSequenceToTimelineIR(parsed, demoTimeline);

    for (const track of imported.tracks.video) {
      for (const clip of track.clips) {
        const orig = demoTimeline.tracks.video
          .flatMap((t) => t.clips)
          .find((c) => c.clip_id === clip.clip_id);
        expect(orig).toBeDefined();
        expect(clip.role).toBe(orig!.role);
        expect(clip.segment_id).toBe(orig!.segment_id);
        expect(clip.confidence).toBe(orig!.confidence);
      }
    }
  });
});
