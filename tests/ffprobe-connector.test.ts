/**
 * Tests for runtime/connectors/ffprobe.ts — metadata extraction and ID generation.
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  parseFps,
  generateAssetId,
  computeFingerprint,
  runFfprobe,
  extractDurationUs,
  extractVideoStream,
  extractAudioStream,
  ingestAsset,
} from "../runtime/connectors/ffprobe.js";

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures/media");
const TEST_CLIP = path.join(FIXTURES_DIR, "test-clip-5s.mp4");
const SCENE_CLIP = path.join(FIXTURES_DIR, "test-scene-changes.mp4");

// ── Unit: parseFps ─────────────────────────────────────────────────

describe("parseFps", () => {
  it("parses simple integer fps", () => {
    expect(parseFps("30/1")).toEqual({ fps_num: 30, fps_den: 1 });
  });

  it("parses NTSC frame rate", () => {
    expect(parseFps("30000/1001")).toEqual({ fps_num: 30000, fps_den: 1001 });
  });

  it("reduces fraction", () => {
    expect(parseFps("60/2")).toEqual({ fps_num: 30, fps_den: 1 });
  });

  it("handles missing denominator", () => {
    expect(parseFps("25")).toEqual({ fps_num: 25, fps_den: 1 });
  });

  it("handles zero denominator gracefully", () => {
    const result = parseFps("0/0");
    expect(result.fps_num).toBe(30);
    expect(result.fps_den).toBe(1);
  });
});

// ── Unit: generateAssetId ──────────────────────────────────────────

describe("generateAssetId", () => {
  it("produces AST_ prefix with 8 uppercase hex chars", () => {
    const id = generateAssetId("abcdef1234567890");
    expect(id).toBe("AST_ABCDEF12");
  });

  it("is deterministic", () => {
    const a = generateAssetId("0123456789abcdef");
    const b = generateAssetId("0123456789abcdef");
    expect(a).toBe(b);
  });
});

// ── Unit: computeFingerprint ───────────────────────────────────────

describe("computeFingerprint", () => {
  it("returns a 40-char hex SHA1", async () => {
    const fp = await computeFingerprint(TEST_CLIP, 5_000_000, [
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "audio", codec_name: "aac" },
    ]);
    expect(fp).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is deterministic for same input", async () => {
    const streams = [
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "audio", codec_name: "aac" },
    ];
    const a = await computeFingerprint(TEST_CLIP, 5_000_000, streams);
    const b = await computeFingerprint(TEST_CLIP, 5_000_000, streams);
    expect(a).toBe(b);
  });

  it("changes when duration differs", async () => {
    const streams = [{ index: 0, codec_type: "video", codec_name: "h264" }];
    const a = await computeFingerprint(TEST_CLIP, 5_000_000, streams);
    const b = await computeFingerprint(TEST_CLIP, 6_000_000, streams);
    expect(a).not.toBe(b);
  });
});

// ── Integration: runFfprobe ────────────────────────────────────────

describe("runFfprobe", () => {
  it("returns valid ffprobe output for test clip", async () => {
    const probe = await runFfprobe(TEST_CLIP);
    expect(probe.streams).toBeDefined();
    expect(probe.format).toBeDefined();
    expect(probe.streams.length).toBeGreaterThanOrEqual(2);
  });

  it("has video and audio streams", async () => {
    const probe = await runFfprobe(TEST_CLIP);
    const video = probe.streams.find((s) => s.codec_type === "video");
    const audio = probe.streams.find((s) => s.codec_type === "audio");
    expect(video).toBeDefined();
    expect(audio).toBeDefined();
  });
});

// ── Integration: extract functions ─────────────────────────────────

describe("extractDurationUs", () => {
  it("extracts ~5s duration from test clip", async () => {
    const probe = await runFfprobe(TEST_CLIP);
    const dur = extractDurationUs(probe);
    // Should be roughly 5 seconds (±100ms)
    expect(dur).toBeGreaterThan(4_900_000);
    expect(dur).toBeLessThan(5_200_000);
  });
});

describe("extractVideoStream", () => {
  it("extracts video dimensions and fps", async () => {
    const probe = await runFfprobe(TEST_CLIP);
    const vs = extractVideoStream(probe);
    expect(vs).toBeDefined();
    expect(vs!.width).toBe(640);
    expect(vs!.height).toBe(360);
    expect(vs!.fps_num).toBeGreaterThan(0);
    expect(vs!.fps_den).toBeGreaterThan(0);
    expect(vs!.codec).toBe("h264");
  });
});

describe("extractAudioStream", () => {
  it("extracts audio sample rate and channels", async () => {
    const probe = await runFfprobe(TEST_CLIP);
    const as_ = extractAudioStream(probe);
    expect(as_).toBeDefined();
    expect(as_!.sample_rate).toBe(48000);
    expect(as_!.channels).toBeGreaterThan(0);
    expect(as_!.codec).toBe("aac");
  });
});

// ── Integration: ingestAsset ───────────────────────────────────────

describe("ingestAsset", () => {
  it("produces a valid AssetItem", async () => {
    const item = await ingestAsset(TEST_CLIP);

    expect(item.asset_id).toMatch(/^AST_[0-9A-F]{8}$/);
    expect(item.filename).toBe("test-clip-5s.mp4");
    expect(item.duration_us).toBeGreaterThan(4_900_000);
    expect(item.has_transcript).toBe(false);
    expect(item.transcript_ref).toMatch(/^TR_AST_/);
    expect(item.segments).toBe(0);
    expect(item.segment_ids).toEqual([]);
    expect(item.quality_flags).toEqual([]);
    expect(item.tags).toEqual([]);
    expect(item.source_fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(item.video_stream).toBeDefined();
    expect(item.audio_stream).toBeDefined();
    expect(item.analysis_status).toBe("pending");
    expect(item.provenance?.stage).toBe("ingest");
    expect(item.provenance?.method).toBe("ffprobe");
  });

  it("is deterministic — same file produces same asset_id", async () => {
    const a = await ingestAsset(TEST_CLIP);
    const b = await ingestAsset(TEST_CLIP);
    expect(a.asset_id).toBe(b.asset_id);
    expect(a.source_fingerprint).toBe(b.source_fingerprint);
  });

  it("rejects source_locator for sibling prefix path (proj vs proj-evil)", async () => {
    // Create a sibling directory that is a prefix match
    const projRoot = path.resolve(FIXTURES_DIR, "proj");
    const evilPath = path.resolve(FIXTURES_DIR, "proj-evil", "test-clip-5s.mp4");
    // absPath does NOT start with projRoot + sep, so source_locator should be undefined
    const item = await ingestAsset(TEST_CLIP, { projectRoot: projRoot });
    // TEST_CLIP is not under the fake projRoot, so no locator
    expect(item.source_locator).toBeUndefined();
  });

  it("sets source_locator when file is genuinely under project root", async () => {
    const projRoot = path.resolve(FIXTURES_DIR, "..");
    const item = await ingestAsset(TEST_CLIP, { projectRoot: projRoot });
    expect(item.source_locator).toBeDefined();
    expect(item.source_locator).not.toMatch(/^\.\./);
    expect(path.isAbsolute(item.source_locator!)).toBe(false);
  });
});

// ── Unit: generateAssetId collision extension ──────────────────────

describe("generateAssetId — collision extension", () => {
  it("extends suffix on collision", () => {
    const idMap = new Map<string, string>();
    const fp1 = "abcdef1200000000000000000000000000000000";
    const fp2 = "abcdef1299999999999999999999999999999999";
    const id1 = generateAssetId(fp1, idMap);
    const id2 = generateAssetId(fp2, idMap);
    // Same first 8 hex chars → collision → id2 should be longer
    expect(id1).toBe("AST_ABCDEF12");
    expect(id2.length).toBeGreaterThan(id1.length);
    expect(id2).toMatch(/^AST_ABCDEF12/);
  });

  it("returns same ID for same fingerprint (no false collision)", () => {
    const idMap = new Map<string, string>();
    const fp = "abcdef1234567890abcdef1234567890abcdef12";
    const id1 = generateAssetId(fp, idMap);
    const id2 = generateAssetId(fp, idMap);
    expect(id1).toBe(id2);
  });

  it("works without existingIds map (backwards compatible)", () => {
    const id = generateAssetId("abcdef1234567890");
    expect(id).toBe("AST_ABCDEF12");
  });
});
