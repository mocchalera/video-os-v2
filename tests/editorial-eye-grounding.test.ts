import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DerivativeResults } from "../runtime/connectors/ffmpeg-derivatives.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import type { VlmFn } from "../runtime/connectors/gemini-vlm.js";
import type { PeakDetectionPolicy } from "../runtime/connectors/vlm-peak-detector.js";
import { degradedPeakMap, inspectPeakPrecisionCache, peakMap } from "../runtime/pipeline/stages/peak.js";
import { extractGroundedFrames } from "../runtime/pipeline/stages/grounded-frames.js";
import { SourceContentIdentityCache } from "../runtime/source-content-identity.js";

const SOURCE_FIXTURE = path.join(import.meta.dirname, "fixtures/media/test-clip-5s.mp4");
const OUTPUT_DIR = path.join(import.meta.dirname, "_tmp_editorial_eye_peak");
const CONTACT_SHEET_PATH = path.join(OUTPUT_DIR, "contact.jpg");
const FILMSTRIP_PATH = path.join(OUTPUT_DIR, "filmstrip.jpg");

const asset: AssetItem = {
  asset_id: "AST_EYE",
  filename: "test-clip-5s.mp4",
  duration_us: 5_000_000,
  has_transcript: false,
  transcript_ref: null,
  segments: 1,
  segment_ids: ["SEG_AST_EYE_0001"],
  quality_flags: [],
  tags: [],
  source_fingerprint: "fixture",
  contact_sheet_ids: ["CS_AST_EYE_01"],
  analysis_status: "pending",
};

const segment: SegmentItem = {
  segment_id: "SEG_AST_EYE_0001",
  asset_id: asset.asset_id,
  src_in_us: 0,
  src_out_us: 5_000_000,
  duration_us: 5_000_000,
  rep_frame_us: 2_500_000,
  summary: "",
  transcript_excerpt: "",
  quality_flags: [],
  tags: [],
  segment_type: "action",
  filmstrip_path: "filmstrip.jpg",
  transcript_ref: null,
  confidence: { boundary: { score: 0.8, source: "test", status: "ready" } },
  provenance: {
    boundary: {
      stage: "segment",
      method: "test",
      connector_version: "test",
      policy_hash: "test",
      request_hash: "test",
    },
  },
};

const derivatives: DerivativeResults = {
  contactSheets: [{
    contact_sheet_id: "CS_AST_EYE_01",
    asset_id: asset.asset_id,
    image_path: "contact.jpg",
    mode: "overview",
    tile_map: [{ tile_index: 0, rep_frame_us: 2_500_000 }],
  }],
  posterPath: null,
  filmstripPaths: new Map([[segment.segment_id, "filmstrip.jpg"]]),
  waveformPath: null,
};

const policy: PeakDetectionPolicy = {
  peak_precision_mode: "always",
  coarse_max_candidates: 3,
  refine_max_segments_per_coarse: 2,
  max_energy_curve_points: 12,
  model_alias: "mock-vlm",
  max_output_tokens: 512,
};

beforeAll(() => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const outputPath of [CONTACT_SHEET_PATH, FILMSTRIP_PATH]) {
    execFileSync("ffmpeg", [
      "-y",
      "-ss",
      "2.5",
      "-i",
      SOURCE_FIXTURE,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath,
    ], { stdio: "ignore" });
  }
});

afterAll(() => {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
});

function createPeakMock(received: Array<{ prompt: string; paths: string[] }>): VlmFn {
  return async (framePaths, prompt) => {
    received.push({ prompt, paths: framePaths });
    if (prompt.includes("editorial peak discovery")) {
      return {
        rawJson: JSON.stringify({
          coarse_candidates: [{
            tile_start_index: 0,
            tile_end_index: 0,
            likely_peak_type: "action_peak",
            confidence: 0.8,
            rationale: "fixture",
          }],
        }),
      };
    }
    if (prompt.includes("editorial peak refinement")) {
      return {
        rawJson: JSON.stringify({
          summary: "fixture refine",
          tags: ["action"],
          interest_points: [],
          peak_moment: {
            timestamp_us: 2_500_000,
            type: "action_peak",
            confidence: 0.8,
            description: "fixture peak",
          },
          recommended_in_out: {
            best_in_us: 2_000_000,
            best_out_us: 3_000_000,
            rationale: "fixture window",
            needs_precision: true,
          },
          visual_energy_curve: [],
          quality_flags: [],
          confidence: { summary: 0.8, tags: 0.8, quality_flags: 0.8 },
          peak_confidence: { vlm: 0.8 },
        }),
      };
    }
    return {
      rawJson: JSON.stringify({
        peak_moment: {
          timestamp_us: 2_500_000,
          type: "action_peak",
          confidence: 0.9,
          description: "grounded precision peak",
        },
        recommended_in_out: {
          best_in_us: 2_100_000,
          best_out_us: 2_900_000,
          rationale: "grounded precision window",
        },
      }),
    };
  };
}

describe("EYE-001 peak precision grounding", () => {
  it("bounds peak work with the configured cross-asset concurrency", async () => {
    const assets = Array.from({ length: 3 }, (_, index): AssetItem => ({
      ...asset,
      asset_id: `AST_PARALLEL_${index}`,
      segment_ids: [`SEG_AST_PARALLEL_${index}_0001`],
      contact_sheet_ids: [`CS_AST_PARALLEL_${index}_01`],
    }));
    const segments = assets.map((parallelAsset, index): SegmentItem => ({
      ...segment,
      segment_id: parallelAsset.segment_ids[0],
      asset_id: parallelAsset.asset_id,
      filmstrip_path: "filmstrip.jpg",
      segment_type: "general",
      provenance: {
        boundary: {
          stage: "segment",
          method: "test",
          connector_version: "test",
          policy_hash: "test",
          request_hash: `test-${index}`,
        },
      },
    }));
    const derivativeMap = new Map(assets.map((parallelAsset) => [
      parallelAsset.asset_id,
      {
        ...derivatives,
        contactSheets: [{
          ...derivatives.contactSheets[0],
          asset_id: parallelAsset.asset_id,
          contact_sheet_id: parallelAsset.contact_sheet_ids[0],
        }],
      },
    ]));
    const sourceFileMap = new Map(assets.map((parallelAsset) => [
      parallelAsset.asset_id,
      SOURCE_FIXTURE,
    ]));
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const delayedVlm: VlmFn = async (_paths, prompt) => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeCalls -= 1;
      if (prompt.includes("editorial peak discovery")) {
        return {
          rawJson: JSON.stringify({
            coarse_candidates: [{
              tile_start_index: 0,
              tile_end_index: 0,
              likely_peak_type: "visual_peak",
              confidence: 0.8,
              rationale: "fixture",
            }],
          }),
        };
      }
      return {
        rawJson: JSON.stringify({
          summary: "fixture refine",
          tags: ["landscape"],
          interest_points: [],
          visual_energy_curve: [],
          quality_flags: [],
          confidence: { summary: 0.8, tags: 0.8, quality_flags: 0.8 },
          peak_confidence: { vlm: 0.8 },
        }),
      };
    };

    const shards = await peakMap(
      { project_id: "parallel", artifact_version: "1", items: assets },
      { project_id: "parallel", artifact_version: "1", items: segments },
      derivativeMap,
      sourceFileMap,
      delayedVlm,
      { ...policy, peak_precision_mode: "never" },
      OUTPUT_DIR,
      undefined,
      { concurrency: 3 },
    );

    expect(shards).toHaveLength(3);
    expect(maxActiveCalls).toBe(3);
  });

  it("stops dispatching unstarted assets after the stage deadline", async () => {
    const assets = Array.from({ length: 4 }, (_, index): AssetItem => ({
      ...asset,
      asset_id: `AST_DEADLINE_${index}`,
      segment_ids: [`SEG_AST_DEADLINE_${index}_0001`],
      contact_sheet_ids: [`CS_AST_DEADLINE_${index}_01`],
    }));
    const segments = assets.map((deadlineAsset, index): SegmentItem => ({
      ...segment,
      segment_id: deadlineAsset.segment_ids[0],
      asset_id: deadlineAsset.asset_id,
      segment_type: "general",
      provenance: {
        boundary: {
          stage: "segment",
          method: "test",
          connector_version: "test",
          policy_hash: "test",
          request_hash: `deadline-${index}`,
        },
      },
    }));
    const derivativeMap = new Map(assets.map((deadlineAsset) => [
      deadlineAsset.asset_id,
      {
        ...derivatives,
        contactSheets: [{
          ...derivatives.contactSheets[0],
          asset_id: deadlineAsset.asset_id,
          contact_sheet_id: deadlineAsset.contact_sheet_ids[0],
        }],
      },
    ]));
    let calls = 0;
    let now = 0;
    let releaseVlm!: () => void;
    const vlmCompletion = new Promise<void>((resolve) => {
      releaseVlm = resolve;
    });
    const slowVlm: VlmFn = async () => {
      calls += 1;
      if (calls === 2) now = 5;
      await vlmCompletion;
      return { rawJson: JSON.stringify({ coarse_candidates: [] }) };
    };

    const run = peakMap(
      { project_id: "deadline", artifact_version: "1", items: assets },
      { project_id: "deadline", artifact_version: "1", items: segments },
      derivativeMap,
      new Map(assets.map((deadlineAsset) => [deadlineAsset.asset_id, SOURCE_FIXTURE])),
      slowVlm,
      { ...policy, peak_precision_mode: "never" },
      OUTPUT_DIR,
      undefined,
      { concurrency: 2, deadlineAtMs: 5, now: () => now },
    );

    await expect(run).rejects.toThrow("peak stage deadline exceeded");
    expect(calls).toBe(2);
    releaseVlm();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(2);
  });

  it("bounds degraded audio probes by the same peak-stage deadline", async () => {
    const assets = Array.from({ length: 4 }, (_, index): AssetItem => ({
      ...asset,
      asset_id: `AST_DEGRADED_${index}`,
      segment_ids: [`SEG_DEGRADED_${index}`],
      video_stream: { width: 1280, height: 720, fps_num: 24, fps_den: 1, codec: "h264" },
      audio_stream: { sample_rate: 48_000, channels: 2, codec: "aac" },
    }));
    const segments = assets.map((degradedAsset, index): SegmentItem => ({
      ...segment,
      segment_id: degradedAsset.segment_ids[0],
      asset_id: degradedAsset.asset_id,
      provenance: {
        boundary: {
          stage: "segment",
          method: "test",
          connector_version: "test",
          policy_hash: "test",
          request_hash: `degraded-${index}`,
        },
      },
    }));
    let audioProbeCalls = 0;
    const runDegraded = degradedPeakMap as unknown as (
      ...args: unknown[]
    ) => Promise<unknown[]>;
    for (let repetition = 0; repetition < 100; repetition += 1) {
      let now = 0;
      const shards = await runDegraded(
        { project_id: "degraded", artifact_version: "1", items: assets },
        { project_id: "degraded", artifact_version: "1", items: segments },
        new Map(assets.map((degradedAsset) => [degradedAsset.asset_id, "unused.mp4"])),
        {
          deadlineAtMs: 5,
          now: () => now,
          estimateAudioRms: async () => {
            audioProbeCalls += 1;
            now = 5;
            return 0.8;
          },
        },
      );

      expect(shards).toEqual([]);
    }
    expect(audioProbeCalls).toBe(100);
  });

  it("terminates and closes the in-flight degraded audio child at the deadline", async () => {
    const assets = Array.from({ length: 3 }, (_, index): AssetItem => ({
      ...asset,
      asset_id: `AST_AUDIO_CHILD_${index}`,
      segment_ids: [`SEG_AUDIO_CHILD_${index}`],
      video_stream: { width: 1280, height: 720, fps_num: 24, fps_den: 1, codec: "h264" },
      audio_stream: { sample_rate: 48_000, channels: 2, codec: "aac" },
    }));
    const segments = assets.map((current, index): SegmentItem => ({
      ...segment,
      segment_id: current.segment_ids[0],
      asset_id: current.asset_id,
      provenance: {
        boundary: {
          stage: "segment",
          method: "test",
          connector_version: "test",
          policy_hash: "test",
          request_hash: `audio-child-${index}`,
        },
      },
    }));
    let calls = 0;
    let killed = 0;
    let closed = 0;
    let completed = 0;
    let now = 0;
    let killSignal: string | undefined;
    let closeSignal: string | null | undefined;
    const deadlineAtMs = 5;
    let lateCompletion: (() => void) | undefined;
    const fakeExecFile = (
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls += 1;
      const child = new EventEmitter() as EventEmitter & { kill(signal?: string): boolean };
      lateCompletion = () => {
        if (killed > 0) return;
        completed += 1;
        callback(null, "", "RMS level dB: -12\n");
        closed += 1;
        child.emit("close", 0, null);
      };
      child.kill = (signal) => {
        killed += 1;
        killSignal = signal;
        now = deadlineAtMs;
        queueMicrotask(() => {
          callback(new Error("terminated"), "", "");
          closed += 1;
          closeSignal = "SIGKILL";
          child.emit("close", null, closeSignal);
        });
        return true;
      };
      return child;
    };

    const shards = await (degradedPeakMap as unknown as (...args: unknown[]) => Promise<unknown[]>)(
      { project_id: "audio-child", artifact_version: "1", items: assets },
      { project_id: "audio-child", artifact_version: "1", items: segments },
      new Map(assets.map((current) => [current.asset_id, "unused.mp4"])),
      { deadlineAtMs, now: () => now, audioRmsExecFile: fakeExecFile },
    );

    expect({ calls, killed, killSignal, closed, closeSignal, completed, now }).toEqual({
      calls: 1,
      killed: 1,
      killSignal: "SIGKILL",
      closed: 1,
      closeSignal: "SIGKILL",
      completed: 0,
      now: deadlineAtMs,
    });
    expect(shards).toEqual([]);
    now = deadlineAtMs + 80;
    lateCompletion?.();
    expect({ calls, killed, closed, completed }).toEqual({ calls: 1, killed: 1, closed: 1, completed: 0 });
  });

  it("passes only absolute existing non-empty images to coarse, refine, and precision VLM calls", async () => {
    const received: Array<{ prompt: string; paths: string[] }> = [];
    const shards = await peakMap(
      { project_id: "eye", artifact_version: "1", items: [asset] },
      { project_id: "eye", artifact_version: "1", items: [segment] },
      new Map([[asset.asset_id, derivatives]]),
      new Map([[asset.asset_id, SOURCE_FIXTURE]]),
      createPeakMock(received),
      policy,
      OUTPUT_DIR,
    );

    expect(received).toHaveLength(3);
    for (const request of received) {
      expect(request.paths.length).toBeGreaterThan(0);
      for (const framePath of request.paths) {
        expect(path.isAbsolute(framePath)).toBe(true);
        expect(fs.statSync(framePath).size).toBeGreaterThan(0);
      }
    }
    const precisionRequest = received.find((request) =>
      request.prompt.startsWith("Refine the single strongest editorial peak")
    );
    expect(precisionRequest?.paths.length).toBeGreaterThan(0);
    expect(shards[0].peak_analysis?.peak_moments[0].source_pass).toBe(
      "precision_dense_frames",
    );
    expect(shards[0].peak_analysis?.provenance.precision_frame_count).toBe(
      precisionRequest?.paths.length,
    );
  });

  it("does not call precision without source frames or label the result precision-refined", async () => {
    const received: Array<{ prompt: string; paths: string[] }> = [];
    const shards = await peakMap(
      { project_id: "eye", artifact_version: "1", items: [asset] },
      { project_id: "eye", artifact_version: "1", items: [segment] },
      new Map([[asset.asset_id, derivatives]]),
      new Map(),
      createPeakMock(received),
      policy,
      OUTPUT_DIR,
    );

    expect(received.filter((request) =>
      request.prompt.startsWith("Refine the single strongest editorial peak")
    )).toHaveLength(0);
    expect(shards[0].peak_analysis?.peak_moments[0].source_pass).toBe("refine_filmstrip");
    expect(shards[0].peak_analysis?.provenance.precision_frame_count).toBe(0);
    expect(shards[0].error).toContain("precision_frame_extraction_failed");
  });

  it("records partial precision extraction failures while using only attached frames", async () => {
    const received: Array<{ prompt: string; paths: string[] }> = [];
    const extendedSegment: SegmentItem = {
      ...segment,
      src_out_us: 10_000_000,
      duration_us: 10_000_000,
    };
    const sourceIdentityCache = new SourceContentIdentityCache();
    const shards = await peakMap(
      { project_id: "eye", artifact_version: "1", items: [asset] },
      { project_id: "eye", artifact_version: "1", items: [extendedSegment] },
      new Map([[asset.asset_id, derivatives]]),
      new Map([[asset.asset_id, SOURCE_FIXTURE]]),
      createPeakMock(received),
      policy,
      OUTPUT_DIR,
      undefined,
      { policyHash: "peak-policy", sourceIdentityCache },
    );

    const precisionRequest = received.find((request) =>
      request.prompt.startsWith("Refine the single strongest editorial peak")
    );
    expect(precisionRequest).toBeDefined();
    expect(precisionRequest!.paths.length).toBeGreaterThan(0);
    expect(precisionRequest!.paths.length).toBeLessThan(6);
    for (const framePath of precisionRequest!.paths) {
      expect(path.isAbsolute(framePath)).toBe(true);
      expect(fs.statSync(framePath).size).toBeGreaterThan(0);
    }
    const provenance = shards[0].peak_analysis!.provenance;
    expect(provenance.precision_frame_count).toBe(precisionRequest!.paths.length);
    expect(provenance.precision_sample_timestamps_us).toHaveLength(
      precisionRequest!.paths.length,
    );
    expect(provenance.precision_frame_extraction_failures!.length).toBeGreaterThan(0);
    expect(provenance.precision_failure_reason).toContain(
      "precision_frame_extraction_partial",
    );
    expect(shards[0].error).toContain("precision_frame_extraction_partial");
    const inspection = inspectPeakPrecisionCache(
      { ...extendedSegment, peak_analysis: shards[0].peak_analysis },
      {
        sourcePath: SOURCE_FIXTURE,
        sourceContentSha256: sourceIdentityCache.resolve(SOURCE_FIXTURE).sha256,
        outputDir: OUTPUT_DIR,
        policyHash: "peak-policy",
        policy,
        sourceIdentityCache,
      },
    );
    expect(inspection.accepted).toBe(true);
    const firstUsedTimestamp = provenance.precision_sample_timestamps_us![0];
    fs.rmSync(path.join(
      OUTPUT_DIR,
      "peak_precision_frames",
      asset.asset_id,
      extendedSegment.segment_id,
      `${firstUsedTimestamp}.jpg`,
    ));
    const missingFrameInspection = inspectPeakPrecisionCache(
      { ...extendedSegment, peak_analysis: shards[0].peak_analysis },
      {
        sourcePath: SOURCE_FIXTURE,
        sourceContentSha256: sourceIdentityCache.resolve(SOURCE_FIXTURE).sha256,
        outputDir: OUTPUT_DIR,
        policyHash: "peak-policy",
        policy,
        sourceIdentityCache,
      },
    );
    expect(missingFrameInspection.accepted).toBe(false);
    expect(missingFrameInspection.reasons.some((reason) =>
      reason.startsWith("verified_frame_missing:")
    )).toBe(true);
  });
});

describe("EYE-004 grounded frame cache identity", () => {
  it("invalidates on full source bytes while sharing one identity within a run", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_editorial_eye_frame_identity");
    const sourcePath = path.join(tmpDir, "source.mp4");
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.copyFileSync(SOURCE_FIXTURE, sourcePath);
    fs.appendFileSync(sourcePath, Buffer.alloc(2 * 1024 * 1024));
    const originalStat = fs.statSync(sourcePath);
    const base = {
      sourcePath,
      outputDir: tmpDir,
      namespace: "vlm_frames" as const,
      assetId: "AST_IDENTITY",
      segmentId: "SEG_AST_IDENTITY_0001",
      segmentStartUs: 0,
      segmentEndUs: 5_000_000,
      timestampsUs: [1_000_000, 3_000_000],
    };

    try {
      const runIdentity = new SourceContentIdentityCache();
      const firstIdentity = runIdentity.resolve(sourcePath);
      const first = await extractGroundedFrames({ ...base, sourceIdentityCache: runIdentity });
      const secondIdentity = runIdentity.resolve(sourcePath);
      const second = await extractGroundedFrames({ ...base, sourceIdentityCache: runIdentity });
      expect(secondIdentity).toBe(firstIdentity);
      expect(second.cacheHits).toBe(2);

      const fd = fs.openSync(sourcePath, "r+");
      try {
        fs.writeSync(fd, Buffer.from([0x7f]), 0, 1, 1 * 1024 * 1024 + 123);
      } finally {
        fs.closeSync(fd);
      }
      fs.utimesSync(sourcePath, originalStat.atime, originalStat.mtime);

      const changed = await extractGroundedFrames({
        ...base,
        sourceIdentityCache: new SourceContentIdentityCache(),
      });
      expect(changed.cacheHits).toBe(0);
      expect(changed.sourceContentSha256).not.toBe(first.sourceContentSha256);
      expect(changed.cacheDecisionReasons).toContain("source_content_mismatch");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("invalidates only the changed segment range or requested timestamps", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_editorial_eye_frame_scope");
    const identityCache = new SourceContentIdentityCache();
    const common = {
      sourcePath: SOURCE_FIXTURE,
      outputDir: tmpDir,
      namespace: "vlm_frames" as const,
      assetId: "AST_SCOPE",
      segmentStartUs: 0,
      segmentEndUs: 5_000_000,
      timestampsUs: [1_000_000, 3_000_000],
      sourceIdentityCache: identityCache,
    };
    try {
      await extractGroundedFrames({ ...common, segmentId: "SEG_SCOPE_A" });
      await extractGroundedFrames({ ...common, segmentId: "SEG_SCOPE_B" });
      const rangeChanged = await extractGroundedFrames({
        ...common,
        segmentId: "SEG_SCOPE_A",
        segmentEndUs: 4_500_000,
      });
      expect(rangeChanged.cacheHits).toBe(0);
      expect(rangeChanged.cacheDecisionReasons).toContain("segment_range_mismatch");
      const untouched = await extractGroundedFrames({ ...common, segmentId: "SEG_SCOPE_B" });
      expect(untouched.cacheHits).toBe(2);
      const timestampsChanged = await extractGroundedFrames({
        ...common,
        segmentId: "SEG_SCOPE_B",
        timestampsUs: [1_000_000, 4_000_000],
      });
      expect(timestampsChanged.cacheHits).toBe(0);
      expect(timestampsChanged.cacheDecisionReasons).toContain("requested_timestamps_mismatch");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);
});
