import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type {
  SamplingPolicy,
  VlmPolicy,
} from "../runtime/connectors/gemini-vlm.js";
import {
  computePromptHash,
  VLM_CONNECTOR_VERSION,
} from "../runtime/connectors/gemini-vlm.js";
import {
  hydrateCachedVlmSegments,
  runParallelVlmAnalysis,
  withRateLimitRetry,
  VLM_M2_MAX_PROVIDER_REQUESTS,
} from "../runtime/pipeline/vlm-analysis.js";
import { buildGapReport } from "../runtime/pipeline/stages/gap-report.js";

const SOURCE_FIXTURE = path.join(import.meta.dirname, "fixtures/media/test-clip-5s.mp4");
const FRAME_OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "videoos-editorial-eye-parallel-"));

afterAll(() => {
  fs.rmSync(FRAME_OUTPUT_DIR, { recursive: true, force: true });
});

function groundingOptions(assets: AssetItem[]) {
  return {
    sourceFileMap: new Map(assets.map((asset) => [asset.asset_id, SOURCE_FIXTURE])),
    outputDir: FRAME_OUTPUT_DIR,
  };
}

const samplingPolicy: SamplingPolicy = {
  static: { sample_fps: 0.5 },
  action: { sample_fps_default: 4, sample_fps_min: 3, sample_fps_max: 5 },
  dialogue: { sample_fps: 0.5 },
  music_driven: { sample_fps: 1 },
  general: { sample_fps: 1 },
};

const vlmPolicy: VlmPolicy = {
  model_alias: "gemini-2.0-flash",
  model_snapshot: "gemini-2.0-flash-202603",
  input_mode: "frame_bundle_plus_text_context",
  response_format: "json_schema_v1",
  prompt_template_id: "m2-segment-grounded-v3",
  max_frame_width_px: 1024,
  segment_visual_token_budget_max: 8192,
  segment_visual_output_tokens_max: 512,
  segment_visual_frame_cap: 90,
  parse_retry_max: 0,
};

function makeAsset(assetId: string, filename: string): AssetItem {
  return {
    asset_id: assetId,
    filename,
    media_kind: "video",
    duration_us: 2_000_000,
    has_transcript: false,
    transcript_ref: null,
    segments: 1,
    segment_ids: [`SEG_${assetId}_0001`],
    quality_flags: [],
    tags: [],
    source_fingerprint: `${assetId.toLowerCase()}_fingerprint`,
    source_capabilities: {
      has_video: true,
      has_audio: false,
      has_temporal_video: true,
    },
    contact_sheet_ids: [],
    analysis_status: "pending",
  };
}

function makeSegment(assetId: string, transcriptExcerpt: string): SegmentItem {
  return {
    segment_id: `SEG_${assetId}_0001`,
    asset_id: assetId,
    src_in_us: 0,
    src_out_us: 2_000_000,
    duration_us: 2_000_000,
    rep_frame_us: 1_000_000,
    summary: "",
    transcript_excerpt: transcriptExcerpt,
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
        policy_hash: "test",
        request_hash: "test",
      },
    },
  };
}

function successResponse(summary: string) {
  return {
    rawJson: JSON.stringify({
      summary,
      tags: ["test"],
      interest_points: [],
      quality_flags: [],
      confidence: { summary: 0.9, tags: 0.8, quality_flags: 0.7 },
    }),
  };
}

describe("runParallelVlmAnalysis", () => {
  it("does not dispatch VLM when the visual deadline is already expired", async () => {
    const assets = [makeAsset("AST_EXPIRED", "expired.mov")];
    let calls = 0;
    const result = await runParallelVlmAnalysis({
      assets,
      segments: [makeSegment("AST_EXPIRED", "expired")],
      vlmPolicy,
      samplingPolicy,
      minSegmentDurationUs: 750_000,
      deadlineAtMs: Date.now() - 1,
      ...groundingOptions(assets),
      vlmFn: async () => {
        calls += 1;
        return successResponse("late");
      },
    } as Parameters<typeof runParallelVlmAnalysis>[0] & { deadlineAtMs: number });

    expect(calls).toBe(0);
    expect(result.shards).toEqual([]);
  });

  it("returns at the visual deadline without publishing late VLM shards", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const assets = [makeAsset("AST_SLOW", "slow.mov")];
      const common = {
        assets,
        segments: [makeSegment("AST_SLOW", "slow")],
        vlmPolicy,
        samplingPolicy,
        minSegmentDurationUs: 750_000,
        ...groundingOptions(assets),
      };
      await runParallelVlmAnalysis({
        ...common,
        vlmFn: async () => successResponse("warm cache"),
      });
      let calls = 0;
      let completed = 0;
      let releaseLateVlm!: () => void;
      const lateVlm = new Promise<void>((resolve) => {
        releaseLateVlm = resolve;
      });
      let resolveCallStarted!: () => void;
      const callStarted = new Promise<void>((resolve) => {
        resolveCallStarted = resolve;
      });
      const resultPromise = runParallelVlmAnalysis({
        ...common,
        deadlineAtMs: 5,
        vlmFn: async () => {
          calls += 1;
          resolveCallStarted();
          await lateVlm;
          completed += 1;
          return successResponse("late");
        },
      } as Parameters<typeof runParallelVlmAnalysis>[0] & { deadlineAtMs: number });

      await callStarted;
      now = 5;
      await vi.advanceTimersByTimeAsync(5);
      const result = await resultPromise;
      expect(calls).toBe(1);
      expect(result.shards).toEqual([]);
      releaseLateVlm();
      await Promise.resolve();
      expect(completed).toBe(1);
      expect(result.shards).toEqual([]);
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects text-only cached VLM output that has no grounded frame provenance", () => {
    const current = makeSegment("AST_CACHE", "");
    const cached = makeSegment("AST_CACHE", "");
    cached.summary = "text-only cached summary";
    cached.tags = ["cached"];
    cached.quality_flags = ["blurry"];
    const ungroundedProvenance = {
      stage: "vlm",
      method: "gemini_frame_bundle",
      connector_version: VLM_CONNECTOR_VERSION,
      policy_hash: "policy",
      request_hash: "old-text-only",
      model_snapshot: vlmPolicy.model_snapshot,
      prompt_template_id: "m2-segment-grounded-v3",
      prompt_hash: computePromptHash(),
      response_format: vlmPolicy.response_format,
    };
    cached.provenance.summary = ungroundedProvenance;
    cached.provenance.tags = ungroundedProvenance;
    cached.provenance.quality_flags = ungroundedProvenance;

    const hydrated = hydrateCachedVlmSegments({
      currentSegments: [current],
      cachedSegments: [cached],
      vlmPolicy,
      policyHash: "policy",
    });

    expect(hydrated.size).toBe(0);
    expect(current.summary).toBe("");
    expect(current.tags).toEqual([]);
  });

  it("limits live VLM calls while skipping cached assets", async () => {
    const assets = [
      makeAsset("AST_001", "A.mov"),
      makeAsset("AST_002", "B.mov"),
      makeAsset("AST_003", "C.mov"),
      makeAsset("AST_004", "D.mov"),
    ];
    const segments = [
      makeSegment("AST_001", "AST_001"),
      makeSegment("AST_002", "AST_002"),
      makeSegment("AST_003", "AST_003"),
      makeSegment("AST_004", "AST_004"),
    ];

    let inFlight = 0;
    let maxInFlight = 0;
    let callCount = 0;
    const statuses: string[] = [];

    const result = await runParallelVlmAnalysis({
      assets,
      segments,
      vlmPolicy,
      samplingPolicy,
      minSegmentDurationUs: 750_000,
      concurrency: 2,
      cachedSegmentIds: new Set(["SEG_AST_002_0001"]),
      reporter: {
        onAssetProgress(event) {
          statuses.push(`${event.assetId}:${event.status}`);
        },
      },
      ...groundingOptions(assets),
      vlmFn: async () => {
        callCount += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return successResponse("ok");
      },
    });

    expect(callCount).toBe(3);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(result.shards).toHaveLength(3);
    expect(result.shards.map((shard) => shard.segment_id)).toEqual([
      "SEG_AST_001_0001",
      "SEG_AST_003_0001",
      "SEG_AST_004_0001",
    ]);
    expect(result.summary.totalAssets).toBe(4);
    expect(result.summary.cachedAssets).toBe(1);
    expect(result.summary.analyzedAssets).toBe(3);
    expect(result.summary.failedAssets).toHaveLength(0);
    expect(statuses).toContain("AST_002:cached");
  });

  it("keeps the general 429 retry helper behavior unchanged", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const result = await withRateLimitRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("Gemini API error 429: Resource exhausted");
      }
      return "retried";
    }, {
      initialDelayMs: 5,
      maxDelayMs: 20,
      maxRetries: 5,
    }, async (delayMs) => {
      delays.push(delayMs);
    });

    expect(attempts).toBe(3);
    expect(delays).toEqual([5, 10]);
    expect(result).toBe("retried");
  });

  it("caps M2 provider requests at two and returns transport provenance", async () => {
    const policy = { ...vlmPolicy, parse_retry_max: 1 };
    const successAsset = makeAsset("AST_M2_SUCCESS", "m2-success.mov");
    const successDelays: number[] = [];
    let successfulCalls = 0;
    const recovered = await runParallelVlmAnalysis({
      assets: [successAsset],
      segments: [makeSegment(successAsset.asset_id, "m2 transport retry")],
      vlmPolicy: policy,
      samplingPolicy,
      minSegmentDurationUs: 750_000,
      retryPolicy: { initialDelayMs: 5, maxDelayMs: 20, maxRetries: 5 },
      sleepFn: async (delayMs) => { successDelays.push(delayMs); },
      ...groundingOptions([successAsset]),
      vlmFn: async () => {
        successfulCalls += 1;
        if (successfulCalls === 1) {
          throw new Error("Gemini API error 429: Resource exhausted");
        }
        return successResponse("recovered");
      },
    });

    expect(VLM_M2_MAX_PROVIDER_REQUESTS).toBe(2);
    expect(successfulCalls).toBe(VLM_M2_MAX_PROVIDER_REQUESTS);
    expect(successDelays).toEqual([]);
    expect(recovered.shards[0]?.result).toMatchObject({
      success: true,
      attempt_count: VLM_M2_MAX_PROVIDER_REQUESTS,
      retry_reason: "call_failure",
    });
    expect(recovered.shards[0]?.result.parse_diagnostics).toEqual([
      expect.objectContaining({
        attempt_outcome: "call_failure",
        error_code: "vlm_call_failed",
      }),
    ]);

    const failureAsset = makeAsset("AST_M2_FAILURE", "m2-failure.mov");
    const failureDelays: number[] = [];
    let failedCalls = 0;
    const exhausted = await runParallelVlmAnalysis({
      assets: [failureAsset],
      segments: [makeSegment(failureAsset.asset_id, "m2 transport failure")],
      vlmPolicy: policy,
      samplingPolicy,
      minSegmentDurationUs: 750_000,
      retryPolicy: { initialDelayMs: 5, maxDelayMs: 20, maxRetries: 5 },
      sleepFn: async (delayMs) => { failureDelays.push(delayMs); },
      ...groundingOptions([failureAsset]),
      vlmFn: async () => {
        failedCalls += 1;
        throw new Error("Gemini API error 429: Resource exhausted");
      },
    });

    expect(failedCalls).toBe(VLM_M2_MAX_PROVIDER_REQUESTS);
    expect(failureDelays).toEqual([]);
    expect(exhausted.shards[0]?.result).toMatchObject({
      success: false,
      attempt_count: VLM_M2_MAX_PROVIDER_REQUESTS,
      retry_reason: "call_failure",
    });
    expect(exhausted.shards[0]?.result.parse_diagnostics).toHaveLength(
      VLM_M2_MAX_PROVIDER_REQUESTS,
    );
    expect(exhausted.shards[0]?.result.parse_diagnostics?.every((item) =>
      item.attempt_outcome === "call_failure" && item.error_code === "vlm_call_failed",
    )).toBe(true);
  });

  it("continues after per-asset failures and reports only failed assets", async () => {
    const assets = [
      makeAsset("AST_001", "one.mov"),
      makeAsset("AST_002", "two.mov"),
      makeAsset("AST_003", "three.mov"),
    ];
    const segments = [
      makeSegment("AST_001", "alpha transcript"),
      makeSegment("AST_002", "beta transcript"),
      makeSegment("AST_003", "gamma transcript"),
    ];
    const failures: string[] = [];

    const result = await runParallelVlmAnalysis({
      assets,
      segments,
      vlmPolicy,
      samplingPolicy,
      minSegmentDurationUs: 750_000,
      concurrency: 3,
      reporter: {
        onAssetFailure(failure) {
          failures.push(failure.assetId);
        },
      },
      ...groundingOptions(assets),
      vlmFn: async (_framePaths, prompt) => {
        if (prompt.includes("beta transcript")) {
          throw new Error("Gemini API error 500: provider error");
        }
        return successResponse("ok");
      },
    });

    expect(result.shards).toHaveLength(3);
    expect(result.summary.analyzedAssets).toBe(3);
    expect(result.summary.failedAssets).toHaveLength(1);
    expect(result.summary.failedAssets[0]?.assetId).toBe("AST_002");
    expect(result.summary.failedAssets[0]?.error).toContain("SEG_AST_002_0001");
    expect(failures).toEqual(["AST_002"]);
    expect(result.shards.filter((shard) => shard.result.success)).toHaveLength(2);
    expect(result.shards.filter((shard) => !shard.result.success)).toHaveLength(1);
  });

  it("grounds every mock input in an absolute non-empty frame extracted by real ffmpeg", async () => {
    const assets = [makeAsset("AST_REAL", "fixture.mp4")];
    const received: string[][] = [];

    const result = await runParallelVlmAnalysis({
      assets,
      segments: [makeSegment("AST_REAL", "visual fixture")],
      vlmPolicy,
      samplingPolicy,
      minSegmentDurationUs: 750_000,
      ...groundingOptions(assets),
      vlmFn: async (framePaths) => {
        received.push(framePaths);
        return successResponse("grounded");
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0].length).toBeGreaterThan(0);
    for (const framePath of received[0]) {
      expect(path.isAbsolute(framePath)).toBe(true);
      expect(fs.statSync(framePath).size).toBeGreaterThan(0);
    }
    expect(result.shards[0].result.frame_grounding?.frame_count).toBe(received[0].length);
    expect(result.shards[0].result.frame_grounding?.sample_timestamps_us).toHaveLength(
      received[0].length,
    );
  });

  it("reuses only verified non-empty frames from the versioned cache", async () => {
    const assets = [makeAsset("AST_CACHE_REAL", "fixture.mp4")];
    const baseOptions = {
      assets,
      segments: [makeSegment("AST_CACHE_REAL", "cache fixture")],
      vlmPolicy,
      samplingPolicy,
      minSegmentDurationUs: 750_000,
      ...groundingOptions(assets),
    };
    await runParallelVlmAnalysis({
      ...baseOptions,
      vlmFn: async () => successResponse("initial"),
    });

    const cached = await runParallelVlmAnalysis({
      ...baseOptions,
      frameExecFileImpl: (_command, _args, _options, callback) => {
        callback(new Error("ffmpeg should not run for verified cache"), "", "");
      },
      vlmFn: async () => successResponse("cached"),
    });
    const grounding = cached.shards[0].result.frame_grounding;
    expect(grounding?.frame_count).toBeGreaterThan(0);
    expect(grounding?.frame_cache_hits).toBe(grounding?.frame_count);
    expect(grounding?.frame_extraction_failures).toBeUndefined();
  });

  it("does not call VLM when extraction yields zero frames and emits a VLM gap", async () => {
    const asset = makeAsset("AST_MISSING", "missing.mp4");
    const segment = makeSegment("AST_MISSING", "must not become text-only");
    let callCount = 0;
    const result = await runParallelVlmAnalysis({
      assets: [asset],
      segments: [segment],
      vlmPolicy,
      samplingPolicy,
      minSegmentDurationUs: 750_000,
      sourceFileMap: new Map([[asset.asset_id, path.join(FRAME_OUTPUT_DIR, "missing.mp4")]]),
      outputDir: FRAME_OUTPUT_DIR,
      vlmFn: async () => {
        callCount += 1;
        return successResponse("should not run");
      },
    });

    expect(callCount).toBe(0);
    expect(result.shards[0].result.success).toBe(false);
    expect(result.shards[0].result.error).toContain("vlm_frame_extraction_failed");
    expect(result.shards[0].result.frame_grounding?.frame_count).toBe(0);

    const gapReport = buildGapReport(
      [asset],
      new Map([[asset.asset_id, [segment]]]),
      new Map(),
      new Map(),
      undefined,
      result.shards,
    );
    expect(gapReport.entries.some((entry) =>
      entry.stage === "vlm" && entry.issue.includes("vlm_frame_extraction_failed")
    )).toBe(true);
  });
});
