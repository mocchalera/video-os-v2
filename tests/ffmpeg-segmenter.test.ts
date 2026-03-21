/**
 * Tests for runtime/connectors/ffmpeg-segmenter.ts — shot boundary detection.
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  mergeCutCandidates,
  buildSegments,
  computeQualityFlags,
  computeRepFrame,
  generateSegmentId,
  detectSceneBoundaries,
  segmentAsset,
  type QualityThresholds,
  type TimeRange,
  type SignalStats,
  type AudioStats,
} from "../runtime/connectors/ffmpeg-segmenter.js";
import { ingestAsset } from "../runtime/connectors/ffprobe.js";

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures/media");
const TEST_CLIP = path.join(FIXTURES_DIR, "test-clip-5s.mp4");
const SCENE_CLIP = path.join(FIXTURES_DIR, "test-scene-changes.mp4");

const DEFAULT_THRESHOLDS: QualityThresholds = {
  scene_threshold: 0.30,
  min_segment_duration_us: 750_000,
  merge_gap_us: 200_000,
  blackdetect_pic_th: 0.98,
  blackdetect_pix_th: 0.10,
  blackdetect_duration_s: 0.15,
  silencedetect_noise_db: -35,
  silencedetect_duration_s: 0.35,
  freezedetect_noise_db: -50,
  freezedetect_duration_s: 0.50,
};

// ── Unit: generateSegmentId ────────────────────────────────────────

describe("generateSegmentId", () => {
  it("produces SEG_<asset_id>_<ordinal_4>", () => {
    expect(generateSegmentId("AST_ABCDEF12", 1)).toBe("SEG_AST_ABCDEF12_0001");
    expect(generateSegmentId("AST_ABCDEF12", 42)).toBe("SEG_AST_ABCDEF12_0042");
  });
});

// ── Unit: mergeCutCandidates ───────────────────────────────────────

describe("mergeCutCandidates", () => {
  it("returns empty for no candidates", () => {
    expect(mergeCutCandidates([], 200_000)).toEqual([]);
  });

  it("does not merge distant candidates", () => {
    const candidates = [
      { pts_us: 1_000_000, score: 0.5 },
      { pts_us: 3_000_000, score: 0.6 },
    ];
    const merged = mergeCutCandidates(candidates, 200_000);
    expect(merged).toHaveLength(2);
  });

  it("merges close candidates keeping higher score", () => {
    const candidates = [
      { pts_us: 1_000_000, score: 0.5 },
      { pts_us: 1_100_000, score: 0.8 },
    ];
    const merged = mergeCutCandidates(candidates, 200_000);
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(0.8);
  });
});

// ── Unit: buildSegments ────────────────────────────────────────────

describe("buildSegments", () => {
  it("returns single segment for no cut points", () => {
    const segs = buildSegments([], 5_000_000, 750_000);
    expect(segs).toHaveLength(1);
    expect(segs[0].src_in_us).toBe(0);
    expect(segs[0].src_out_us).toBe(5_000_000);
  });

  it("creates N+1 segments for N cuts", () => {
    const cuts = [
      { pts_us: 2_000_000, score: 0.5 },
      { pts_us: 4_000_000, score: 0.6 },
    ];
    const segs = buildSegments(cuts, 5_000_000, 750_000);
    expect(segs).toHaveLength(3);
    expect(segs[0].src_in_us).toBe(0);
    expect(segs[0].src_out_us).toBe(2_000_000);
    expect(segs[1].src_in_us).toBe(2_000_000);
    expect(segs[1].src_out_us).toBe(4_000_000);
    expect(segs[2].src_in_us).toBe(4_000_000);
    expect(segs[2].src_out_us).toBe(5_000_000);
  });

  it("merges short segments", () => {
    const cuts = [
      { pts_us: 100_000, score: 0.5 },  // creates 100ms first segment
      { pts_us: 3_000_000, score: 0.6 },
    ];
    // 100ms < 750ms min → should be merged
    const segs = buildSegments(cuts, 5_000_000, 750_000);
    expect(segs.every((s) => s.src_out_us - s.src_in_us >= 750_000)).toBe(true);
  });

  it("handles zero duration", () => {
    const segs = buildSegments([], 0, 750_000);
    expect(segs).toHaveLength(0);
  });
});

// ── Unit: computeQualityFlags ──────────────────────────────────────

describe("computeQualityFlags", () => {
  it("returns empty for clean segment", () => {
    const flags = computeQualityFlags(0, 5_000_000, [], [], [], 750_000);
    expect(flags).toEqual([]);
  });

  it("detects black_segment when >50% black", () => {
    const blackRegions: TimeRange[] = [{ start_us: 0, end_us: 3_000_000 }];
    const flags = computeQualityFlags(0, 5_000_000, blackRegions, [], [], 750_000);
    expect(flags).toContain("black_segment");
  });

  it("does not flag black_segment when <50% black", () => {
    const blackRegions: TimeRange[] = [{ start_us: 0, end_us: 1_000_000 }];
    const flags = computeQualityFlags(0, 5_000_000, blackRegions, [], [], 750_000);
    expect(flags).not.toContain("black_segment");
  });

  it("detects frozen_frame when >50% frozen", () => {
    const frozenRegions: TimeRange[] = [{ start_us: 0, end_us: 4_000_000 }];
    const flags = computeQualityFlags(0, 5_000_000, [], frozenRegions, [], 750_000);
    expect(flags).toContain("frozen_frame");
  });

  it("detects near_silent when >80% silent", () => {
    const silenceRegions: TimeRange[] = [{ start_us: 0, end_us: 4_500_000 }];
    const flags = computeQualityFlags(0, 5_000_000, [], [], silenceRegions, 750_000);
    expect(flags).toContain("near_silent");
  });

  it("detects very_short_segment", () => {
    const flags = computeQualityFlags(0, 500_000, [], [], [], 750_000);
    expect(flags).toContain("very_short_segment");
  });
});

// ── Unit: computeRepFrame ──────────────────────────────────────────

describe("computeRepFrame", () => {
  it("returns midpoint for clean segment", () => {
    const rep = computeRepFrame(0, 4_000_000, [], []);
    expect(rep).toBe(2_000_000);
  });

  it("avoids black region at midpoint", () => {
    const blackRegions: TimeRange[] = [{ start_us: 1_500_000, end_us: 2_500_000 }];
    const rep = computeRepFrame(0, 4_000_000, blackRegions, []);
    // Should not be in the black region
    expect(rep < 1_500_000 || rep > 2_500_000).toBe(true);
  });
});

// ── Integration: detectSceneBoundaries ─────────────────────────────

describe("detectSceneBoundaries", () => {
  it("detects scene changes in test-scene-changes.mp4", async () => {
    const candidates = await detectSceneBoundaries(SCENE_CLIP, 0.30);
    // The red→blue→green clip should have at least 1 scene change
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("returns PTS in microseconds", async () => {
    const candidates = await detectSceneBoundaries(SCENE_CLIP, 0.30);
    if (candidates.length > 0) {
      expect(candidates[0].pts_us).toBeGreaterThan(0);
      expect(Number.isInteger(candidates[0].pts_us)).toBe(true);
    }
  });
});

// ── Integration: segmentAsset ──────────────────────────────────────

describe("segmentAsset", () => {
  it("produces valid segments for test clip", async () => {
    const asset = await ingestAsset(TEST_CLIP);
    const result = await segmentAsset(TEST_CLIP, asset, DEFAULT_THRESHOLDS);
    const segments = result.segments;

    expect(result.detectorFailures).toHaveLength(0);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    for (const seg of segments) {
      expect(seg.segment_id).toMatch(/^SEG_AST_/);
      expect(seg.asset_id).toBe(asset.asset_id);
      expect(seg.src_in_us).toBeGreaterThanOrEqual(0);
      expect(seg.src_out_us).toBeGreaterThan(seg.src_in_us);
      expect(seg.duration_us).toBe(seg.src_out_us - seg.src_in_us);
      expect(seg.rep_frame_us).toBeGreaterThanOrEqual(seg.src_in_us);
      expect(seg.rep_frame_us).toBeLessThanOrEqual(seg.src_out_us);
      expect(seg.summary).toBe("");
      expect(seg.transcript_excerpt).toBe("");
      expect(typeof seg.segment_type).toBe("string");
      expect(seg.confidence.boundary.source).toBe("ffmpeg_scene_detect");
      expect(seg.confidence.boundary.status).toBe("ready");
      expect(seg.provenance.boundary.stage).toBe("segment");
    }
  });

  it("is deterministic — same input produces same segments", async () => {
    const asset = await ingestAsset(TEST_CLIP);
    const a = (await segmentAsset(TEST_CLIP, asset, DEFAULT_THRESHOLDS)).segments;
    const b = (await segmentAsset(TEST_CLIP, asset, DEFAULT_THRESHOLDS)).segments;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].segment_id).toBe(b[i].segment_id);
      expect(a[i].src_in_us).toBe(b[i].src_in_us);
      expect(a[i].src_out_us).toBe(b[i].src_out_us);
    }
  });

  it("segments cover the entire asset duration without gaps", async () => {
    const asset = await ingestAsset(TEST_CLIP);
    const segments = (await segmentAsset(TEST_CLIP, asset, DEFAULT_THRESHOLDS)).segments;

    expect(segments[0].src_in_us).toBe(0);
    expect(segments[segments.length - 1].src_out_us).toBe(asset.duration_us);

    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].src_in_us).toBe(segments[i - 1].src_out_us);
    }
  });
});

// ── Detector failure path ──────────────────────────────────────────

describe("segmentAsset — detector failure", () => {
  it("returns empty segments and detectorFailures for non-existent file", async () => {
    const fakeAsset = {
      asset_id: "AST_DEADBEEF",
      filename: "nonexistent.mp4",
      duration_us: 5_000_000,
      has_transcript: false,
      transcript_ref: null,
      segments: 0,
      segment_ids: [],
      quality_flags: [],
      tags: [],
      source_fingerprint: "0".repeat(40),
      video_stream: { width: 640, height: 360, fps_num: 30, fps_den: 1, codec: "h264" },
      contact_sheet_ids: [],
      analysis_status: "pending",
    };
    const result = await segmentAsset("/no/such/file.mp4", fakeAsset, DEFAULT_THRESHOLDS);

    // Scene detector should have failed → no segments produced
    expect(result.segments).toHaveLength(0);
    // Should report at least scene_detect failure
    expect(result.detectorFailures.length).toBeGreaterThan(0);
    expect(result.detectorFailures.some((f) => f.includes("scene_detect"))).toBe(true);
  });
});

// ── Signalstats / astats quality flags ─────────────────────────────

describe("computeQualityFlags — signalstats/astats", () => {
  it("flags underexposed when avgY < 30", () => {
    const sigStats: SignalStats = { avgY: 20, maxY: 100 };
    const flags = computeQualityFlags(
      0, 5_000_000, [], [], [], 750_000, sigStats, null,
    );
    expect(flags).toContain("underexposed");
  });

  it("does not flag underexposed when avgY >= 30", () => {
    const sigStats: SignalStats = { avgY: 128, maxY: 200 };
    const flags = computeQualityFlags(
      0, 5_000_000, [], [], [], 750_000, sigStats, null,
    );
    expect(flags).not.toContain("underexposed");
  });

  it("flags minor_highlight_clip when maxY >= 255", () => {
    const sigStats: SignalStats = { avgY: 128, maxY: 255 };
    const flags = computeQualityFlags(
      0, 5_000_000, [], [], [], 750_000, sigStats, null,
    );
    expect(flags).toContain("minor_highlight_clip");
  });

  it("flags clipped_audio when peakLevel >= 0.99", () => {
    const audioStats: AudioStats = { peakLevel: 1.0 };
    const flags = computeQualityFlags(
      0, 5_000_000, [], [], [], 750_000, null, audioStats,
    );
    expect(flags).toContain("clipped_audio");
  });

  it("does not flag clipped_audio when peakLevel < 0.99", () => {
    const audioStats: AudioStats = { peakLevel: 0.5 };
    const flags = computeQualityFlags(
      0, 5_000_000, [], [], [], 750_000, null, audioStats,
    );
    expect(flags).not.toContain("clipped_audio");
  });
});
