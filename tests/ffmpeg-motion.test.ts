import { describe, expect, it, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  analyzeSegmentVisualQuality,
  failedVisualQualityMeasurement,
  type ExecFileLike,
  type VisualQualityMeasurements,
} from "../runtime/connectors/ffmpeg-motion.js";
import { applyQualityGateToSelects } from "../runtime/editorial/quality-gate.js";
import type { Candidate } from "../runtime/artifacts/types.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { SegmentsJson } from "../runtime/pipeline/pipeline-types.js";
import { runVisualQualityMeasurementStage } from "../runtime/pipeline/stages/visual-quality.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-ffmpeg-motion-"));
  tempDirs.push(dir);
  return dir;
}

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ffit = ffmpegAvailable() ? it : it.skip;

function makeVideo(filePath: string, filter: string, source = "testsrc2=d=1.5:s=160x90:r=12"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  execFileSync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-f", "lavfi",
    "-i", source,
    "-vf", filter,
    "-pix_fmt", "yuv420p",
    filePath,
  ], { stdio: "ignore" });
}

describe("ffmpeg visual quality measurements", () => {
  ffit("measures higher shake on a moving crop than a static crop", async () => {
    const dir = makeTempDir();
    const stable = path.join(dir, "stable.mp4");
    const shaky = path.join(dir, "shaky.mp4");
    const source = "smptebars=d=1.5:s=224x126:r=12";

    makeVideo(stable, "crop=160:90:32:18", source);
    makeVideo(shaky, "crop=160:90:32+18*sin(t*25):18+12*sin(t*31)", source);

    const stableResult = await analyzeSegmentVisualQuality(stable, 0, 1_500_000, { sampleFps: 6 });
    const shakyResult = await analyzeSegmentVisualQuality(shaky, 0, 1_500_000, { sampleFps: 6 });

    expect(stableResult.shake?.score).toBeDefined();
    expect(shakyResult.shake?.score).toBeDefined();
    expect(shakyResult.shake!.score).toBeGreaterThan(stableResult.shake!.score + 0.05);
    expect(shakyResult.metrics_measured.shake).toBe(true);
  }, 60_000);

  ffit("measures lower sharpness on a blurred synthetic clip", async () => {
    const dir = makeTempDir();
    const sharp = path.join(dir, "sharp.mp4");
    const blurred = path.join(dir, "blurred.mp4");

    makeVideo(sharp, "format=yuv420p");
    makeVideo(blurred, "gblur=sigma=5,format=yuv420p");

    const sharpResult = await analyzeSegmentVisualQuality(sharp, 0, 1_500_000, { sampleFps: 4 });
    const blurredResult = await analyzeSegmentVisualQuality(blurred, 0, 1_500_000, { sampleFps: 4 });

    expect(sharpResult.sharpness?.sharpness_score).toBeDefined();
    expect(blurredResult.sharpness?.sharpness_score).toBeDefined();
    expect(blurredResult.sharpness!.blur_score).toBeGreaterThan(sharpResult.sharpness!.blur_score);
    expect(blurredResult.sharpness!.sharpness_score).toBeLessThan(sharpResult.sharpness!.sharpness_score);
  }, 60_000);

  ffit("measures black crush and blown highlights from luma ratios", async () => {
    const dir = makeTempDir();
    const black = path.join(dir, "black.mp4");
    const white = path.join(dir, "white.mp4");

    makeVideo(black, "format=yuv420p", "color=black:d=1.5:s=160x90:r=12");
    makeVideo(white, "format=yuv420p", "color=white:d=1.5:s=160x90:r=12");

    const blackResult = await analyzeSegmentVisualQuality(black, 0, 1_500_000, { sampleFps: 4 });
    const whiteResult = await analyzeSegmentVisualQuality(white, 0, 1_500_000, { sampleFps: 4 });

    expect(blackResult.exposure?.black_clip_ratio).toBeGreaterThan(0.9);
    expect(blackResult.exposure?.underexposed).toBe(true);
    expect(blackResult.exposure?.white_clip_ratio).toBeLessThan(0.1);
    expect(whiteResult.exposure?.white_clip_ratio).toBeGreaterThan(0.9);
    expect(whiteResult.exposure?.overexposed).toBe(true);
    expect(whiteResult.exposure?.black_clip_ratio).toBeLessThan(0.1);
  }, 60_000);

  it("fails open when ffmpeg is unavailable", async () => {
    const unavailable: ExecFileLike = (_command, _args, _options, callback) => {
      const error = new Error("spawn ffmpeg ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      callback(error, "", "");
    };

    const result = await analyzeSegmentVisualQuality("/tmp/missing.mp4", 0, 1_000_000, {
      execFileImpl: unavailable,
    });

    expect(result.measured).toBe(false);
    expect(result.metrics_measured).toEqual({
      shake: false,
      sharpness: false,
      exposure: false,
    });
    expect(result.shake).toBeUndefined();
    expect(result.sharpness).toBeUndefined();
    expect(result.exposure).toBeUndefined();
    expect(result.failure_reason).toContain("ENOENT");
  });

  ffit("default quality gate rejects synthetic shake, blur, black crush, and blown highlights", async () => {
    const dir = makeTempDir();
    const stable = path.join(dir, "stable.mp4");
    const shaky = path.join(dir, "shaky.mp4");
    const blurred = path.join(dir, "blurred.mp4");
    const black = path.join(dir, "black.mp4");
    const white = path.join(dir, "white.mp4");
    const source = "smptebars=d=1.5:s=320x180:r=12";

    makeVideo(stable, "crop=160:90:80:45", source);
    makeVideo(shaky, "crop=160:90:80+60*sin(t*25):45+35*sin(t*31)", source);
    makeVideo(blurred, "gblur=sigma=5,format=yuv420p");
    makeVideo(black, "format=yuv420p", "color=black:d=1.5:s=160x90:r=12");
    makeVideo(white, "format=yuv420p", "color=white:d=1.5:s=160x90:r=12");

    const measurements = new Map([
      ["SEG_STABLE", await analyzeSegmentVisualQuality(stable, 0, 1_500_000, { sampleFps: 4 })],
      ["SEG_SHAKY", await analyzeSegmentVisualQuality(shaky, 0, 1_500_000, { sampleFps: 4 })],
      ["SEG_BLUR", await analyzeSegmentVisualQuality(blurred, 0, 1_500_000, { sampleFps: 4 })],
      ["SEG_BLACK", await analyzeSegmentVisualQuality(black, 0, 1_500_000, { sampleFps: 4 })],
      ["SEG_WHITE", await analyzeSegmentVisualQuality(white, 0, 1_500_000, { sampleFps: 4 })],
    ]);
    const candidates = [...measurements.keys()].map((segmentId) => gateCandidate(segmentId));
    const gated = applyQualityGateToSelects(
      { version: "1", project_id: "ffmpeg-motion-gate", candidates },
      [...measurements.entries()].map(([segment_id, visual_quality_measurements]) => ({
        segment_id,
        asset_id: "AST_GATE",
        tags: ["shared_cluster"],
        quality_flags: [],
        visual_quality_measurements,
      })),
    );

    const decisionBySegment = new Map(gated.candidates.map((candidate) => [
      candidate.segment_id,
      candidate.quality_gate?.decision,
    ]));
    expect(decisionBySegment.get("SEG_STABLE")).toBe("pass");
    expect(decisionBySegment.get("SEG_SHAKY")).toBe("reject");
    expect(decisionBySegment.get("SEG_BLUR")).toBe("reject");
    expect(decisionBySegment.get("SEG_BLACK")).toBe("reject");
    expect(decisionBySegment.get("SEG_WHITE")).toBe("reject");
  }, 60_000);
});

describe("visual quality measurement stage", () => {
  it("writes measurement status and provenance to segments.json", async () => {
    const dir = makeTempDir();
    const analysisDir = path.join(dir, "03_analysis");
    fs.mkdirSync(analysisDir, { recursive: true });
    const segmentsPath = path.join(analysisDir, "segments.json");
    const segment = makeSegment();
    const segmentsJson: SegmentsJson = {
      project_id: "ffmpeg-motion-stage",
      artifact_version: "2.0.0",
      items: [segment],
    };

    const measurement: VisualQualityMeasurements = {
      measured: true,
      connector_version: "ffmpeg-motion-test",
      method: "ffmpeg_sampled_signals",
      sample_fps: 2,
      max_width: 160,
      duration_us: 1_000_000,
      metrics_measured: { shake: true, sharpness: true, exposure: true },
      shake: {
        measured: true,
        score: 0.4,
        sample_count: 2,
        bins: [{ start_us: 0, end_us: 1_000_000, energy: 0.4 }],
        average_energy: 0.4,
        peak_energy: 0.4,
        peak_timestamp_us: 500_000,
      },
      sharpness: {
        measured: true,
        sharpness_score: 0.8,
        blur_score: 0.2,
        blur_mean: 4,
        method: "blurdetect",
        sample_count: 2,
      },
      exposure: {
        measured: true,
        exposure_score: 0.9,
        black_clip_ratio: 0.05,
        white_clip_ratio: 0.01,
        avg_luma: 120,
        underexposed: false,
        overexposed: false,
        sample_count: 2,
      },
    };

    const result = await runVisualQualityMeasurementStage({
      segmentsJson,
      sourceFileMap: new Map([["AST_001", "/tmp/source.mp4"]]),
      segmentsOutputPath: segmentsPath,
      policyHash: "policy",
      analyzeFn: async () => measurement,
    });

    expect(result.summary.measuredSegments).toBe(1);
    const written = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as SegmentsJson;
    expect(written.items[0].visual_quality_measurements?.measured).toBe(true);
    expect(written.items[0].confidence.visual_quality_measurements?.status).toBe("ready");
    expect(written.items[0].provenance.visual_quality_measurements?.method).toBe("ffmpeg_sampled_signals");
  });

  it("writes measured:false when the source file is unavailable", async () => {
    const dir = makeTempDir();
    const segmentsPath = path.join(dir, "segments.json");
    const segmentsJson: SegmentsJson = {
      project_id: "ffmpeg-motion-stage",
      artifact_version: "2.0.0",
      items: [makeSegment()],
    };

    const result = await runVisualQualityMeasurementStage({
      segmentsJson,
      sourceFileMap: new Map(),
      segmentsOutputPath: segmentsPath,
      policyHash: "policy",
    });

    expect(result.summary.failedSegments).toHaveLength(1);
    expect(result.segmentsJson.items[0].visual_quality_measurements?.measured).toBe(false);
    expect(result.segmentsJson.items[0].visual_quality_measurements?.metrics_measured).toEqual({
      shake: false,
      sharpness: false,
      exposure: false,
    });
  });

  it.each([
    { concurrency: 1, expectedMax: 1 },
    { concurrency: 99, expectedMax: 3 },
  ])("bounds work by asset and preserves output order at concurrency=$concurrency", async ({ concurrency, expectedMax }) => {
    const dir = makeTempDir();
    const segmentsPath = path.join(dir, "segments.json");
    const items = [
      { ...makeSegment(), segment_id: "SEG_A_1", asset_id: "AST_A" },
      { ...makeSegment(), segment_id: "SEG_A_2", asset_id: "AST_A" },
      { ...makeSegment(), segment_id: "SEG_B_1", asset_id: "AST_B" },
      { ...makeSegment(), segment_id: "SEG_C_1", asset_id: "AST_C" },
    ];
    const segmentsJson: SegmentsJson = {
      project_id: "visual-quality-bounds",
      artifact_version: "2.0.0",
      items,
    };
    let active = 0;
    let maxActive = 0;
    const activeByAsset = new Map<string, number>();
    let sameAssetOverlap = false;

    const result = await runVisualQualityMeasurementStage({
      segmentsJson,
      sourceFileMap: new Map([
        ["AST_A", "/tmp/a.mp4"],
        ["AST_B", "/tmp/b.mp4"],
        ["AST_C", "/tmp/c.mp4"],
      ]),
      segmentsOutputPath: segmentsPath,
      policyHash: "policy",
      concurrency,
      analyzeFn: async (_sourcePath, current) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const assetActive = (activeByAsset.get(current.asset_id) ?? 0) + 1;
        activeByAsset.set(current.asset_id, assetActive);
        sameAssetOverlap ||= assetActive > 1;
        await new Promise((resolve) => setTimeout(resolve, current.asset_id === "AST_A" ? 8 : 2));
        active -= 1;
        activeByAsset.set(current.asset_id, assetActive - 1);
        return successfulMeasurement();
      },
    });

    expect(maxActive).toBe(expectedMax);
    expect(sameAssetOverlap).toBe(false);
    expect(result.segmentsJson.items.map((item) => item.segment_id)).toEqual([
      "SEG_A_1", "SEG_A_2", "SEG_B_1", "SEG_C_1",
    ]);
    expect(result.summary.measuredSegments).toBe(4);
  });

  it("isolates failures while keeping other asset measurements", async () => {
    const dir = makeTempDir();
    const segmentsPath = path.join(dir, "segments.json");
    const segmentsJson: SegmentsJson = {
      project_id: "visual-quality-failure",
      artifact_version: "2.0.0",
      items: [
        { ...makeSegment(), segment_id: "SEG_GOOD", asset_id: "AST_GOOD" },
        { ...makeSegment(), segment_id: "SEG_BAD", asset_id: "AST_BAD" },
      ],
    };

    const result = await runVisualQualityMeasurementStage({
      segmentsJson,
      sourceFileMap: new Map([
        ["AST_GOOD", "/tmp/good.mp4"],
        ["AST_BAD", "/tmp/bad.mp4"],
      ]),
      segmentsOutputPath: segmentsPath,
      policyHash: "policy",
      concurrency: 2,
      analyzeFn: async (_sourcePath, current) => {
        if (current.asset_id === "AST_BAD") throw new Error("controlled failure");
        return successfulMeasurement();
      },
    });

    expect(result.summary.measuredSegments).toBe(1);
    expect(result.summary.failedSegments).toEqual([
      expect.objectContaining({ segment_id: "SEG_BAD", error: "controlled failure" }),
    ]);
  });

  it("stops new assets at the deadline and prevents late canonical mutation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const dir = makeTempDir();
      const segmentsPath = path.join(dir, "segments.json");
      const segmentsJson: SegmentsJson = {
        project_id: "visual-quality-deadline",
        artifact_version: "2.0.0",
        items: Array.from({ length: 4 }, (_, index) => ({
          ...makeSegment(),
          segment_id: `SEG_${index}`,
          asset_id: `AST_${index}`,
        })),
      };
      fs.writeFileSync(segmentsPath, JSON.stringify(segmentsJson, null, 2), "utf-8");
      let calls = 0;
      let completed = 0;
      let resolveCallsStarted!: () => void;
      const callsStarted = new Promise<void>((resolve) => {
        resolveCallsStarted = resolve;
      });
      let releaseAnalysis!: () => void;
      const lateAnalysis = new Promise<void>((resolve) => {
        releaseAnalysis = resolve;
      });

      const resultPromise = runVisualQualityMeasurementStage({
        segmentsJson,
        sourceFileMap: new Map(segmentsJson.items.map((item) => [item.asset_id, `/tmp/${item.asset_id}.mp4`])),
        segmentsOutputPath: segmentsPath,
        policyHash: "policy",
        concurrency: 2,
        deadlineAtMs: 5,
        analyzeFn: async () => {
          calls += 1;
          if (calls === 2) resolveCallsStarted();
          await lateAnalysis;
          completed += 1;
          return successfulMeasurement();
        },
      });

      // Both workers have entered before the controlled clock reaches the
      // deadline; the test never relies on wall-clock scheduling for that.
      await callsStarted;
      now = 5;
      await vi.advanceTimersByTimeAsync(5);
      const result = await resultPromise;

      expect(calls).toBe(2);
      expect(result.summary.timedOut).toBe(true);
      expect(result.summary.measuredSegments).toBe(0);
      expect(result.summary.skippedSegments).toBe(4);
      releaseAnalysis();
      await Promise.resolve();
      await Promise.resolve();
      expect(completed).toBe(2);
      expect(calls).toBe(2);
      const written = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as SegmentsJson;
      expect(written.items.every((item) => item.visual_quality_measurements === undefined)).toBe(true);
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

function successfulMeasurement(): VisualQualityMeasurements {
  return {
    measured: true,
    connector_version: "ffmpeg-motion-test",
    method: "ffmpeg_sampled_signals",
    sample_fps: 2,
    max_width: 160,
    duration_us: 1_000_000,
    metrics_measured: { shake: true, sharpness: true, exposure: true },
    shake: {
      measured: true,
      score: 0.4,
      sample_count: 2,
      bins: [{ start_us: 0, end_us: 1_000_000, energy: 0.4 }],
      average_energy: 0.4,
      peak_energy: 0.4,
      peak_timestamp_us: 500_000,
    },
    sharpness: {
      measured: true,
      sharpness_score: 0.8,
      blur_score: 0.2,
      blur_mean: 4,
      method: "blurdetect",
      sample_count: 2,
    },
    exposure: {
      measured: true,
      exposure_score: 0.9,
      black_clip_ratio: 0.05,
      white_clip_ratio: 0.01,
      avg_luma: 120,
      underexposed: false,
      overexposed: false,
      sample_count: 2,
    },
  };
}

function makeSegment(): SegmentItem {
  return {
    segment_id: "SEG_001",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 1_000_000,
    duration_us: 1_000_000,
    rep_frame_us: 500_000,
    summary: "",
    transcript_excerpt: "",
    quality_flags: [],
    tags: [],
    segment_type: "general",
    transcript_ref: null,
    confidence: {
      boundary: { score: 1, source: "test", status: "ready" },
    },
    provenance: {
      boundary: {
        stage: "segment",
        method: "test",
        connector_version: "test",
        policy_hash: "policy",
        request_hash: "request",
      },
    },
  };
}

function gateCandidate(segmentId: string): Candidate {
  return {
    segment_id: segmentId,
    asset_id: "AST_GATE",
    src_in_us: 0,
    src_out_us: 1_500_000,
    role: "support",
    why_it_matches: `quality gate fixture ${segmentId}`,
    risks: [],
    confidence: 0.8,
  };
}
