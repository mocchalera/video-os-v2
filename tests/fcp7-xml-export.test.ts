import { describe, it, expect } from "vitest";
import {
  timelineToFcp7Xml,
  dbToLinearGain,
  linearGainToDb,
} from "../runtime/handoff/fcp7-xml-export.js";
import type {
  TimelineIR,
  ClipOutput,
  TimelineTransitionOutput,
} from "../runtime/compiler/types.js";

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
  transitions?: TimelineTransitionOutput[],
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
    ...(transitions ? { transitions } : {}),
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

  it("emits a visible editorial marker with beat_id, motivation, role, and confidence", () => {
    const clip = makeClip({
      timeline_in_frame: 96,
      beat_id: "b02",
      motivation: "Bridge into the main section",
      role: "support",
      confidence: 0.87,
    });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/path/to/video.MOV"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<name>b02: Bridge into the main section</name>");
    expect(xml).toContain("<comment>support | confidence: 0.87</comment>");
    expect(xml).toContain("<in>96</in>");
    expect(xml).toContain("<out>97</out>");
  });
});

describe("transitionitem export", () => {
  it("maps crossfade_bridge to Cross Dissolve with explicit transition_frames", () => {
    const clip1 = makeClip({
      clip_id: "clip-1",
      timeline_in_frame: 0,
      timeline_duration_frames: 150,
    });
    const clip2 = makeClip({
      clip_id: "clip-2",
      asset_id: "AST_002",
      timeline_in_frame: 150,
      timeline_duration_frames: 120,
    });
    const timeline = makeTimeline(
      [[clip1, clip2]],
      [],
      [
        {
          transition_id: "tr-1",
          from_clip_id: "clip-1",
          to_clip_id: "clip-2",
          track_id: "V1",
          transition_type: "crossfade",
          applied_skill_id: "crossfade_bridge",
          transition_frames: 12,
        },
      ],
    );
    const sourceMap = new Map([
      ["AST_001", "/path/to/video1.MOV"],
      ["AST_002", "/path/to/video2.MOV"],
    ]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<transitionitem>");
    expect(xml).toContain("<name>Cross Dissolve</name>");
    expect(xml).toContain("<effectid>CrossDissolve</effectid>");
    expect(xml).toContain("<start>144</start>");
    expect(xml).toContain("<end>156</end>");
  });

  it("maps match_cut_bridge to Dip to Color and skips smash_cut_energy", () => {
    const clip1 = makeClip({
      clip_id: "clip-1",
      timeline_in_frame: 0,
      timeline_duration_frames: 90,
    });
    const clip2 = makeClip({
      clip_id: "clip-2",
      asset_id: "AST_002",
      timeline_in_frame: 90,
      timeline_duration_frames: 90,
    });
    const clip3 = makeClip({
      clip_id: "clip-3",
      asset_id: "AST_003",
      timeline_in_frame: 180,
      timeline_duration_frames: 90,
    });
    const timeline = makeTimeline(
      [[clip1, clip2, clip3]],
      [],
      [
        {
          transition_id: "tr-1",
          from_clip_id: "clip-1",
          to_clip_id: "clip-2",
          track_id: "V1",
          transition_type: "match_cut",
          applied_skill_id: "match_cut_bridge",
        },
        {
          transition_id: "tr-2",
          from_clip_id: "clip-2",
          to_clip_id: "clip-3",
          track_id: "V1",
          transition_type: "cut",
          applied_skill_id: "smash_cut_energy",
        },
      ],
    );
    const sourceMap = new Map([
      ["AST_001", "/path/to/video1.MOV"],
      ["AST_002", "/path/to/video2.MOV"],
      ["AST_003", "/path/to/video3.MOV"],
    ]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<name>Dip to Color</name>");
    expect(xml).toContain("<effectid>DipToColor</effectid>");
    expect(xml.match(/<transitionitem>/g)).toHaveLength(1);
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

// ── dB ↔ linear gain conversion ──────────────────────────────────

describe("dB ↔ linear gain conversion", () => {
  it("converts 0 dB to gain 1.0", () => {
    expect(dbToLinearGain(0)).toBeCloseTo(1.0, 10);
  });

  it("converts -6 dB to ~0.5012", () => {
    expect(dbToLinearGain(-6)).toBeCloseTo(0.501187, 4);
  });

  it("converts -12 dB to ~0.2512", () => {
    expect(dbToLinearGain(-12)).toBeCloseTo(0.251189, 4);
  });

  it("converts -20 dB to 0.1", () => {
    expect(dbToLinearGain(-20)).toBeCloseTo(0.1, 10);
  });

  it("converts +6 dB to ~1.9953", () => {
    expect(dbToLinearGain(6)).toBeCloseTo(1.99526, 3);
  });

  it("converts +12 dB to ~3.9811", () => {
    expect(dbToLinearGain(12)).toBeCloseTo(3.98107, 3);
  });

  it("roundtrips dB → linear → dB with precision", () => {
    const testValues = [-20, -12, -9, -6, -3, 0, 3, 6, 12];
    for (const db of testValues) {
      const linear = dbToLinearGain(db);
      const roundtripped = linearGainToDb(linear);
      expect(roundtripped).toBeCloseTo(db, 6);
    }
  });

  it("linearGainToDb returns -96 for gain 0 (clamped silence floor)", () => {
    expect(linearGainToDb(0)).toBe(-96);
  });

  it("linearGainToDb returns -96 for negative gain (clamped silence floor)", () => {
    expect(linearGainToDb(-1)).toBe(-96);
  });
});

// ── Audio gain export ────────────────────────────────────────────

describe("audio gain export (Audio Levels filter)", () => {
  it("emits Audio Levels filter with linear gain for bgm_gain", () => {
    const audioClip = makeClip({
      clip_id: "bgm-1",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      audio_policy: { bgm_gain: -6 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<effectid>audiolevels</effectid>");
    expect(xml).toContain("<valuemin>0</valuemin>");
    expect(xml).toContain("<valuemax>4</valuemax>");
    // -6 dB → ~0.501187
    const gainMatch = xml.match(/<value>(0\.50\d+)<\/value>/);
    expect(gainMatch).not.toBeNull();
    expect(Number(gainMatch![1])).toBeCloseTo(0.501187, 3);
  });

  it("emits Audio Levels filter with linear gain for nat_sound_gain", () => {
    const audioClip = makeClip({
      clip_id: "nat-1",
      asset_id: "AST_NAT",
      role: "nat_sound",
      beat_id: "beat-1",
      audio_policy: { nat_sound_gain: -3 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_NAT", "/media/nat.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<effectid>audiolevels</effectid>");
    // -3 dB → ~0.70795
    const gainMatch = xml.match(/<value>(0\.70\d+)<\/value>/);
    expect(gainMatch).not.toBeNull();
    expect(Number(gainMatch![1])).toBeCloseTo(0.70795, 3);
  });

  it("uses duck_music_db as fallback for bgm clips", () => {
    const audioClip = makeClip({
      clip_id: "bgm-duck",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      audio_policy: { duck_music_db: -12 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<effectid>audiolevels</effectid>");
    expect(xml).toContain("<valuemin>0</valuemin>");
    // -12 dB → ~0.251189
    const gainMatch = xml.match(/<value>(0\.25\d+)<\/value>/);
    expect(gainMatch).not.toBeNull();
  });

  it("skips Audio Levels filter when no audio_policy", () => {
    const audioClip = makeClip({
      clip_id: "no-gain",
      asset_id: "AST_PLAIN",
      role: "music",
      beat_id: "beat-plain",
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_PLAIN", "/media/plain.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).not.toContain("<effectid>audiolevels</effectid>");
  });

  it("prefers bgm_gain over duck_music_db for bgm clips", () => {
    const audioClip = makeClip({
      clip_id: "bgm-pref",
      asset_id: "AST_BGM",
      role: "bgm",
      beat_id: "beat-bgm",
      audio_policy: { bgm_gain: -6, duck_music_db: -12 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Should use -6 dB (~0.501187), not -12 dB (~0.251189)
    const gainMatch = xml.match(/<value>([\d.]+)<\/value>/);
    expect(gainMatch).not.toBeNull();
    expect(Number(gainMatch![1])).toBeCloseTo(0.501187, 3);
  });

  it("includes authoringApp attribute on parameter", () => {
    const audioClip = makeClip({
      clip_id: "auth-test",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      audio_policy: { bgm_gain: 0 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain('authoringApp="FinalCutPro"');
  });
});

// ── Fade keyframe export ─────────────────────────────────────────

describe("fade keyframe export", () => {
  it("emits fade-in keyframes for bgm clip", () => {
    const audioClip = makeClip({
      clip_id: "bgm-fade-in",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      timeline_duration_frames: 300,
      audio_policy: { bgm_gain: -6, bgm_fade_in_frames: 24 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Should have keyframes: 0→0, 24→gain
    expect(xml).toContain("<keyframe>");
    expect(xml).toContain("<when>0</when>");
    expect(xml).toContain("<when>24</when>");
    // First keyframe value = 0 (silence)
    const kfMatches = xml.match(/<keyframe>\s*<when>0<\/when>\s*<value>([\d.]+)<\/value>/);
    expect(kfMatches).not.toBeNull();
    expect(Number(kfMatches![1])).toBe(0);
  });

  it("emits fade-out keyframes for bgm clip", () => {
    const audioClip = makeClip({
      clip_id: "bgm-fade-out",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      timeline_duration_frames: 300,
      audio_policy: { bgm_gain: -6, bgm_fade_out_frames: 48 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Should have keyframes: 0→gain, 252→gain, 300→0
    expect(xml).toContain("<keyframe>");
    expect(xml).toContain("<when>252</when>"); // 300 - 48
    expect(xml).toContain("<when>300</when>");
    // Last keyframe = 0
    const lastKf = xml.match(/<when>300<\/when>\s*<value>([\d.]+)<\/value>/);
    expect(lastKf).not.toBeNull();
    expect(Number(lastKf![1])).toBe(0);
  });

  it("emits both fade-in and fade-out keyframes", () => {
    const audioClip = makeClip({
      clip_id: "bgm-both-fades",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      timeline_duration_frames: 300,
      audio_policy: {
        bgm_gain: -6,
        bgm_fade_in_frames: 24,
        bgm_fade_out_frames: 48,
      },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // 4 keyframes: 0→0, 24→gain, 252→gain, 300→0
    expect(xml).toContain("<when>0</when>");
    expect(xml).toContain("<when>24</when>");
    expect(xml).toContain("<when>252</when>");
    expect(xml).toContain("<when>300</when>");
  });

  it("uses nat_sound_fade_in/out_frames for nat_sound clips", () => {
    const audioClip = makeClip({
      clip_id: "nat-fades",
      asset_id: "AST_NAT",
      role: "nat_sound",
      beat_id: "beat-1",
      timeline_duration_frames: 200,
      audio_policy: {
        nat_sound_gain: -3,
        nat_sound_fade_in_frames: 12,
        nat_sound_fade_out_frames: 30,
      },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_NAT", "/media/nat.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<when>0</when>");
    expect(xml).toContain("<when>12</when>"); // fade in end
    expect(xml).toContain("<when>170</when>"); // 200 - 30, fade out start
    expect(xml).toContain("<when>200</when>"); // fade out end
  });

  it("falls back to generic fade_in/out_frames", () => {
    const audioClip = makeClip({
      clip_id: "generic-fade",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      timeline_duration_frames: 100,
      audio_policy: { bgm_gain: 0, fade_in_frames: 10, fade_out_frames: 15 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<when>10</when>");
    expect(xml).toContain("<when>85</when>"); // 100 - 15
    expect(xml).toContain("<when>100</when>");
  });

  it("emits fades even without explicit gain (defaults to 1.0 = 0dB)", () => {
    const audioClip = makeClip({
      clip_id: "fade-no-gain",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      timeline_duration_frames: 100,
      audio_policy: { bgm_fade_in_frames: 10 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    expect(xml).toContain("<effectid>audiolevels</effectid>");
    // Gain should be 1.0 (0 dB)
    const gainKf = xml.match(/<when>10<\/when>\s*<value>([\d.]+)<\/value>/);
    expect(gainKf).not.toBeNull();
    expect(Number(gainKf![1])).toBeCloseTo(1.0, 5);
  });
});

// ── C-02 edge case: fade frames >= clip duration ─────────────────

describe("C-02: fade keyframe edge cases", () => {
  it("clamps fade-out when fadeOutFrames >= clipDur (no negative keyframe)", () => {
    const audioClip = makeClip({
      clip_id: "bgm-oversize-fade",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      timeline_duration_frames: 20,
      audio_policy: { bgm_gain: -6, bgm_fade_out_frames: 50 }, // 50 > 20
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // No negative <when> values
    const whenValues = Array.from(xml.matchAll(/<when>(-?\d+)<\/when>/g)).map(m => Number(m[1]));
    for (const w of whenValues) {
      expect(w).toBeGreaterThanOrEqual(0);
    }
    // Last keyframe should be at clip duration
    expect(whenValues).toContain(20);
  });

  it("proportionally shrinks fades when fadeIn + fadeOut > clipDur", () => {
    const audioClip = makeClip({
      clip_id: "bgm-overlap-fades",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      timeline_duration_frames: 30,
      audio_policy: { bgm_gain: -6, bgm_fade_in_frames: 20, bgm_fade_out_frames: 20 }, // 40 > 30
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    const whenValues = Array.from(xml.matchAll(/<when>(-?\d+)<\/when>/g)).map(m => Number(m[1]));
    // All keyframe positions must be within [0, 30]
    for (const w of whenValues) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(30);
    }
    // Must have start and end keyframes
    expect(whenValues).toContain(0);
    expect(whenValues).toContain(30);
  });

  it("handles clipDur = 1 with both fades gracefully", () => {
    const audioClip = makeClip({
      clip_id: "bgm-tiny-clip",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      timeline_duration_frames: 1,
      audio_policy: { bgm_gain: 0, bgm_fade_in_frames: 10, bgm_fade_out_frames: 10 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    const whenValues = Array.from(xml.matchAll(/<when>(-?\d+)<\/when>/g)).map(m => Number(m[1]));
    for (const w of whenValues) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });
});

// ── W-04 edge case: linearGainToDb with very small gain ──────────

describe("W-04: linearGainToDb clamp edge cases", () => {
  it("returns -96 for gain = 0 (JSON-safe)", () => {
    const db = linearGainToDb(0);
    expect(db).toBe(-96);
    expect(JSON.stringify(db)).toBe("-96"); // not "null"
  });

  it("clamps extremely small positive gain to -96", () => {
    const db = linearGainToDb(1e-10);
    expect(db).toBe(-96);
  });

  it("does not clamp moderate gain", () => {
    const db = linearGainToDb(0.5);
    expect(db).toBeCloseTo(-6.0206, 2);
  });
});
