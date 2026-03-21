/**
 * Tests for runtime/connectors/ffmpeg-derivatives.ts — poster selection, derivatives.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  selectPosterSegment,
  generatePoster,
  generateFilmstrip,
  generateAllDerivatives,
} from "../runtime/connectors/ffmpeg-derivatives.js";
import { ingestAsset, type AssetItem } from "../runtime/connectors/ffprobe.js";
import { segmentAsset, type SegmentItem, type QualityThresholds } from "../runtime/connectors/ffmpeg-segmenter.js";

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures/media");
const TEST_CLIP = path.join(FIXTURES_DIR, "test-clip-5s.mp4");

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

// ── Unit: selectPosterSegment ──────────────────────────────────────

describe("selectPosterSegment", () => {
  it("prefers non-rejected segments over rejected ones", () => {
    const segments: SegmentItem[] = [
      makeSegment({ src_in_us: 0, src_out_us: 2_000_000, quality_flags: ["black_segment"], rep_frame_us: 1_000_000 }),
      makeSegment({ src_in_us: 2_000_000, src_out_us: 5_000_000, quality_flags: [], rep_frame_us: 3_500_000 }),
    ];
    const result = selectPosterSegment(segments, 5_000_000);
    expect(result.rep_frame_us).toBe(3_500_000);
  });

  it("falls back to asset midpoint when ALL segments are hard-rejected", () => {
    const segments: SegmentItem[] = [
      makeSegment({ src_in_us: 0, src_out_us: 2_000_000, quality_flags: ["black_segment"], rep_frame_us: 1_000_000 }),
      makeSegment({ src_in_us: 2_000_000, src_out_us: 5_000_000, quality_flags: ["frozen_frame"], rep_frame_us: 3_500_000 }),
    ];
    const result = selectPosterSegment(segments, 10_000_000);
    // Should be asset midpoint (10_000_000 / 2 = 5_000_000), not any segment rep_frame
    expect(result.rep_frame_us).toBe(5_000_000);
  });

  it("falls back to asset midpoint when segments array is empty", () => {
    const result = selectPosterSegment([], 6_000_000);
    expect(result.rep_frame_us).toBe(3_000_000);
  });

  it("prefers longer duration among non-rejected", () => {
    const segments: SegmentItem[] = [
      makeSegment({ src_in_us: 0, src_out_us: 1_000_000, quality_flags: [], rep_frame_us: 500_000, duration_us: 1_000_000 }),
      makeSegment({ src_in_us: 1_000_000, src_out_us: 5_000_000, quality_flags: [], rep_frame_us: 3_000_000, duration_us: 4_000_000 }),
    ];
    const result = selectPosterSegment(segments, 5_000_000);
    expect(result.rep_frame_us).toBe(3_000_000);
  });
});

// ── Integration: derivative determinism ────────────────────────────

describe("Derivative determinism", () => {
  const TMP_A = path.join(import.meta.dirname, "_tmp_deriv_a");
  const TMP_B = path.join(import.meta.dirname, "_tmp_deriv_b");

  beforeAll(() => {
    fs.mkdirSync(TMP_A, { recursive: true });
    fs.mkdirSync(TMP_B, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TMP_A, { recursive: true, force: true });
    fs.rmSync(TMP_B, { recursive: true, force: true });
  });

  it("generates identical derivative paths for same input across two runs", async () => {
    const asset = await ingestAsset(TEST_CLIP);
    const result = await segmentAsset(TEST_CLIP, asset, DEFAULT_THRESHOLDS);
    const segments = result.segments;

    const derivsA = await generateAllDerivatives(TEST_CLIP, asset, segments, TMP_A);
    const derivsB = await generateAllDerivatives(TEST_CLIP, asset, segments, TMP_B);

    // Contact sheets
    expect(derivsA.contactSheets.length).toBe(derivsB.contactSheets.length);
    for (let i = 0; i < derivsA.contactSheets.length; i++) {
      expect(derivsA.contactSheets[i].contact_sheet_id).toBe(derivsB.contactSheets[i].contact_sheet_id);
      expect(derivsA.contactSheets[i].image_path).toBe(derivsB.contactSheets[i].image_path);
    }

    // Poster path
    expect(derivsA.posterPath).toBe(derivsB.posterPath);

    // Filmstrip paths
    expect(derivsA.filmstripPaths.size).toBe(derivsB.filmstripPaths.size);
    for (const [segId, pathA] of derivsA.filmstripPaths) {
      expect(derivsB.filmstripPaths.get(segId)).toBe(pathA);
    }

    // Waveform path
    expect(derivsA.waveformPath).toBe(derivsB.waveformPath);
  }, 60_000);
});

// ── Helper ─────────────────────────────────────────────────────────

function makeSegment(overrides: Partial<SegmentItem> & {
  src_in_us: number;
  src_out_us: number;
  quality_flags: string[];
  rep_frame_us: number;
}): SegmentItem {
  return {
    segment_id: `SEG_TEST_${String(overrides.src_in_us).padStart(4, "0")}`,
    asset_id: "AST_TEST0000",
    src_in_us: overrides.src_in_us,
    src_out_us: overrides.src_out_us,
    duration_us: overrides.duration_us ?? (overrides.src_out_us - overrides.src_in_us),
    rep_frame_us: overrides.rep_frame_us,
    summary: "",
    transcript_excerpt: "",
    quality_flags: overrides.quality_flags,
    tags: [],
    segment_type: "general",
    transcript_ref: null,
    confidence: {
      boundary: { score: 0.8, source: "ffmpeg_scene_detect", status: "ready" },
    },
    provenance: {
      boundary: {
        stage: "segment",
        method: "ffmpeg_scene_detect",
        connector_version: "test",
        policy_hash: "test",
        request_hash: "test",
      },
    },
  };
}
