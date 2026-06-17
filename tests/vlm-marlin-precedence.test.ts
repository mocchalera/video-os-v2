import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { AssetsJson, SegmentsJson } from "../runtime/pipeline/pipeline-types.js";
import { vlmReduce, type VlmShard } from "../runtime/pipeline/stages/vlm.js";

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "video-os-vlm-marlin-"));
}

function makeAsset(): AssetItem {
  return {
    asset_id: "AST_001",
    filename: "clip.mp4",
    duration_us: 5_000_000,
    has_transcript: false,
    transcript_ref: null,
    segments: 1,
    segment_ids: ["SEG_001"],
    quality_flags: [],
    tags: [],
    source_fingerprint: "fingerprint",
    contact_sheet_ids: [],
    analysis_status: "ready",
  };
}

function makeSegment(overrides: Partial<SegmentItem> = {}): SegmentItem {
  return {
    segment_id: "SEG_001",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 5_000_000,
    duration_us: 5_000_000,
    rep_frame_us: 2_500_000,
    summary: "Previous summary",
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
    ...overrides,
  };
}

function makeShard(summary: string): VlmShard {
  return {
    segment_id: "SEG_001",
    result: {
      success: true,
      prompt_hash: "abcd1234abcd1234",
      model_alias: "gemini-2.5-flash-lite",
      model_snapshot: "gemini-test",
      output: {
        summary,
        tags: ["gemini_appraisal"],
        interest_points: [
          { frame_us: 2_000_000, label: "gemini visual note", confidence: 0.7 },
        ],
        quality_flags: ["minor_highlight_clip"],
        confidence: { summary: 0.6, tags: 0.7, quality_flags: 0.8 },
        visual_quality: {
          scores: {
            light_quality: 0.6,
            subject_prominence: 0.7,
            emotional_expression: 0.4,
            composition_score: 0.8,
            motion_quality: 0.5,
          },
          labels: {
            lighting_style: ["mixed"],
            composition_tags: ["balanced"],
            expression_tags: [],
            motion_tags: ["steady"],
          },
        },
      },
    },
  };
}

function reduceOnce(segment: SegmentItem): SegmentItem {
  const projectDir = makeTempProject();
  try {
    const assets: AssetsJson = {
      project_id: "vlm-marlin",
      artifact_version: "2.0.0",
      items: [makeAsset()],
    };
    const segments: SegmentsJson = {
      project_id: "vlm-marlin",
      artifact_version: "2.0.0",
      items: [segment],
    };
    const result = vlmReduce(
      [makeShard("Gemini generic person holding an object.")],
      assets,
      segments,
      "policyhash",
      "json_schema_v1",
      path.join(projectDir, "segments.json"),
      path.join(projectDir, "assets.json"),
    );
    return result.segments.items[0];
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

describe("vlmReduce Marlin summary precedence", () => {
  it("does not overwrite a Marlin-owned summary while keeping Gemini appraisal fields", () => {
    const segment = makeSegment({
      summary: "Soba noodles being prepared beside a grape vineyard.",
      tags: ["soba_noodles"],
      interest_points: [
        { frame_us: 1_500_000, label: "action_peak: noodles are prepared", confidence: 0.9 },
      ],
      confidence: {
        boundary: { score: 1, source: "test", status: "ready" },
        summary: { score: 0.9, source: "marlin-2b", status: "ready" },
      },
      provenance: {
        boundary: {
          stage: "segment",
          method: "test",
          connector_version: "test",
          policy_hash: "policy",
          request_hash: "request",
        },
        summary: {
          stage: "marlin",
          method: "marlin_reporter",
          connector_version: "marlin-local-v1",
          policy_hash: "marlin-policy",
          request_hash: "marlin-request",
          model_alias: "marlin-2b",
          model_snapshot: "test",
          prompt_template_id: "marlin-caption-v1",
        },
      },
    });

    const reduced = reduceOnce(segment);

    expect(reduced.summary).toBe("Soba noodles being prepared beside a grape vineyard.");
    expect(reduced.tags).toEqual(expect.arrayContaining(["soba_noodles", "gemini_appraisal"]));
    expect(reduced.quality_flags).toContain("minor_highlight_clip");
    expect(reduced.interest_points?.map((point) => point.label)).toEqual(
      expect.arrayContaining(["action_peak: noodles are prepared", "gemini visual note"]),
    );
    expect((reduced as SegmentItem & { visual_quality?: unknown }).visual_quality).toBeDefined();
    expect(reduced.confidence.summary?.source).toBe("marlin-2b");
    expect(reduced.provenance.summary?.method).toBe("marlin_reporter");
    expect(reduced.provenance.tags?.stage).toBe("vlm");
  });

  it("uses Gemini summary when no Marlin-owned summary exists", () => {
    const reduced = reduceOnce(makeSegment({ tags: ["existing_tag"] }));

    expect(reduced.summary).toBe("Gemini generic person holding an object.");
    expect(reduced.tags).toEqual(expect.arrayContaining(["existing_tag", "gemini_appraisal"]));
    expect(reduced.confidence.summary?.source).toBe("gemini-2.5-flash-lite");
    expect(reduced.provenance.summary?.stage).toBe("vlm");
  });
});
