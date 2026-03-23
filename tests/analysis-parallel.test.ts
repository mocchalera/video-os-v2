import { describe, expect, it } from "vitest";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type {
  SamplingPolicy,
  VlmPolicy,
} from "../runtime/connectors/gemini-vlm.js";
import {
  runParallelVlmAnalysis,
} from "../runtime/pipeline/vlm-analysis.js";

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
  prompt_template_id: "m2-segment-v1",
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
    duration_us: 2_000_000,
    has_transcript: false,
    transcript_ref: null,
    segments: 1,
    segment_ids: [`SEG_${assetId}_0001`],
    quality_flags: [],
    tags: [],
    source_fingerprint: `${assetId.toLowerCase()}_fingerprint`,
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
  it("limits live VLM calls while skipping cached assets", async () => {
    const assets = [
      makeAsset("AST_001", "A.mov"),
      makeAsset("AST_002", "B.mov"),
      makeAsset("AST_003", "C.mov"),
      makeAsset("AST_004", "D.mov"),
    ];
    const segments = [
      makeSegment("AST_001", "asset one"),
      makeSegment("AST_002", "asset two"),
      makeSegment("AST_003", "asset three"),
      makeSegment("AST_004", "asset four"),
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
    expect(result.summary.totalAssets).toBe(4);
    expect(result.summary.cachedAssets).toBe(1);
    expect(result.summary.analyzedAssets).toBe(3);
    expect(result.summary.failedAssets).toHaveLength(0);
    expect(statuses).toContain("AST_002:cached");
  });

  it("retries 429 responses with exponential backoff", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const result = await runParallelVlmAnalysis({
      assets: [makeAsset("AST_001", "retry.mov")],
      segments: [makeSegment("AST_001", "retry transcript")],
      vlmPolicy,
      samplingPolicy,
      minSegmentDurationUs: 750_000,
      retryPolicy: {
        initialDelayMs: 5,
        maxDelayMs: 20,
        maxRetries: 5,
      },
      sleepFn: async (delayMs) => {
        delays.push(delayMs);
      },
      vlmFn: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("Gemini API error 429: Resource exhausted");
        }
        return successResponse("retried");
      },
    });

    expect(attempts).toBe(3);
    expect(delays).toEqual([5, 10]);
    expect(result.summary.failedAssets).toHaveLength(0);
    expect(result.shards[0]?.result.success).toBe(true);
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
});
