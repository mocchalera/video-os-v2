import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import type { VisualQualityMeasurements } from "../runtime/connectors/ffmpeg-motion.js";
import {
  normalizeVlmOutput,
  type SamplingPolicy,
  type VlmFn,
  type VlmPolicy,
} from "../runtime/connectors/gemini-vlm.js";
import {
  deterministicObservationContribution,
  removeEditorialObservationProducer,
  reduceEditorialObservation,
  type ObservationContribution,
} from "../runtime/pipeline/stages/editorial-observation.js";
import {
  computeVlmCachePolicyHash,
  hydrateCachedVlmSegments,
  runParallelVlmAnalysis,
  vlmReduce,
} from "../runtime/pipeline/stages/vlm.js";
import { mergeAppraiserVisualQuality } from "../runtime/pipeline/stages/appraiser.js";
import { runVisualQualityMeasurementStage } from "../runtime/pipeline/stages/visual-quality.js";
import { SourceContentIdentityCache } from "../runtime/source-content-identity.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: unknown };
  addSchema(schema: object): void;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_FIXTURE = path.join(import.meta.dirname, "fixtures/media/test-clip-5s.mp4");
const OUTPUT_DIR = path.join(import.meta.dirname, "_tmp_editorial_observation");

const policy: VlmPolicy = {
  model_alias: "mock-grounded-vlm",
  model_snapshot: "mock-runtime-v1",
  input_mode: "frame_bundle_plus_text_context",
  response_format: "json_schema_v1",
  prompt_template_id: "m2-segment-grounded-v3",
  max_frame_width_px: 320,
  segment_visual_token_budget_max: 4096,
  segment_visual_output_tokens_max: 512,
  segment_visual_frame_cap: 8,
  parse_retry_max: 0,
};

const sampling: SamplingPolicy = {
  static: { sample_fps: 0.5 },
  action: { sample_fps_default: 1, sample_fps_min: 1, sample_fps_max: 1 },
  dialogue: { sample_fps: 0.5 },
  music_driven: { sample_fps: 1 },
  general: { sample_fps: 1 },
};

function segment(overrides: Partial<SegmentItem> = {}): SegmentItem {
  return {
    segment_id: "SEG_EYE_010A_0001",
    asset_id: "AST_EYE_010A",
    src_in_us: 0,
    src_out_us: 5_000_000,
    duration_us: 5_000_000,
    rep_frame_us: 2_500_000,
    summary: "",
    transcript_excerpt: "",
    quality_flags: [],
    tags: [],
    segment_type: "general",
    transcript_ref: null,
    confidence: { boundary: { score: 1, source: "fixture", status: "ready" } },
    provenance: {
      boundary: {
        stage: "segment",
        method: "fixture",
        connector_version: "fixture",
        policy_hash: "fixture",
        request_hash: "fixture",
      },
    },
    ...overrides,
  };
}

const asset: AssetItem = {
  asset_id: "AST_EYE_010A",
  filename: "test-clip-5s.mp4",
  duration_us: 5_000_000,
  has_transcript: false,
  transcript_ref: null,
  segments: 1,
  segment_ids: ["SEG_EYE_010A_0001"],
  quality_flags: [],
  tags: [],
  source_fingerprint: "fixture",
  contact_sheet_ids: [],
  analysis_status: "pending",
};

function mockGroundedVlm(options: {
  subjectMotionDirection?: "left" | "right";
  textPresence?: "present" | "absent";
} = {}): VlmFn {
  return async (framePaths) => {
    expect(framePaths.length).toBeGreaterThan(0);
    for (const framePath of framePaths) {
      expect(path.isAbsolute(framePath)).toBe(true);
      expect(fs.existsSync(framePath)).toBe(true);
      expect(fs.statSync(framePath).size).toBeGreaterThan(0);
    }
    return {
      rawJson: JSON.stringify({
        summary: "A subject crosses a bright outdoor frame.",
        tags: ["outdoor", "person"],
        interest_points: [],
        quality_flags: [],
        confidence: { summary: 0.9, tags: 0.9, quality_flags: 0.9 },
        editorial_observation: {
          visual_tags: ["outdoor", "person"],
          motion_type: "continuous",
          camera_motion_direction: "unknown",
          subject_motion_direction: options.subjectMotionDirection ?? "right",
          shot_scale: "wide",
          composition_anchor: "left",
          screen_side: "left",
          gaze_direction: "not_applicable",
          camera_axis: "unknown",
          dominant_subject_type: "person",
          dominant_colors: ["green", "blue"],
          text_presence: options.textPresence ?? "absent",
          confidence: {
            tags: 0.9,
            motion: 0.8,
            framing: 0.85,
            direction: 0.7,
            appearance: 0.8,
            text: 0.75,
          },
        },
        visual_quality: {
          scores: {
            light_quality: 0.8,
            subject_prominence: 0.7,
            emotional_expression: 0.5,
            composition_score: 0.8,
            motion_quality: 0.8,
          },
          labels: { lighting_style: [], composition_tags: [], expression_tags: [], motion_tags: [] },
        },
      }),
    };
  };
}

function createValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schemasDir = path.join(REPO_ROOT, "schemas");
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemasDir, "analysis-common.schema.json"), "utf8")));
  return ajv.compile(JSON.parse(fs.readFileSync(path.join(schemasDir, "segments.schema.json"), "utf8")));
}

beforeAll(() => fs.mkdirSync(OUTPUT_DIR, { recursive: true }));
afterAll(() => fs.rmSync(OUTPUT_DIR, { recursive: true, force: true }));

describe("EYE-010A editorial observation contract", () => {
  it("keeps legacy segment fixtures valid and rejects corrupt closed-enum values", () => {
    const validate = createValidator();
    const legacy = { project_id: "eye", artifact_version: "1", items: [segment()] };
    expect(validate(legacy)).toBe(true);
    const corrupt = structuredClone(legacy);
    corrupt.items[0].editorial_observation = reduceEditorialObservation(
      corrupt.items[0],
      undefined,
      [groundedContribution("center" as never)],
    );
    corrupt.items[0].editorial_observation.camera_motion_direction = "center" as never;
    expect(validate(corrupt)).toBe(false);
  });

  it("produces grounded observation evidence with absolute existing non-empty frames without peak analysis", async () => {
    const live = segment();
    const result = await runParallelVlmAnalysis({
      assets: [asset],
      segments: [live],
      vlmPolicy: policy,
      samplingPolicy: sampling,
      minSegmentDurationUs: 100_000,
      vlmFn: mockGroundedVlm(),
      sourceFileMap: new Map([[asset.asset_id, SOURCE_FIXTURE]]),
      outputDir: OUTPUT_DIR,
      policyHash: computeVlmCachePolicyHash(policy, sampling, 100_000),
      sourceIdentityCache: new SourceContentIdentityCache(),
    });
    const documents = vlmReduce(
      result.shards,
      { project_id: "eye", artifact_version: "1", items: [asset] },
      { project_id: "eye", artifact_version: "1", items: [live] },
      "policy",
      policy.response_format,
      path.join(OUTPUT_DIR, "segments.json"),
      path.join(OUTPUT_DIR, "assets.json"),
      false,
    );
    await runVisualQualityMeasurementStage({
      segmentsJson: documents.segments,
      sourceFileMap: new Map([[asset.asset_id, SOURCE_FIXTURE]]),
      segmentsOutputPath: path.join(OUTPUT_DIR, "segments.json"),
      policyHash: "policy",
    });
    const observation = documents.segments.items[0].editorial_observation!;
    expect(observation.status).toBe("ready");
    expect(documents.segments.items[0].peak_analysis).toBeUndefined();
    expect(observation.camera_motion_direction).toBe("unknown");
    expect(observation.provenance).toMatchObject({
      asset_id: asset.asset_id,
      segment_id: live.segment_id,
      segment_src_in_us: 0,
      segment_src_out_us: 5_000_000,
    });
    const producer = observation.provenance.producers[0];
    expect(producer).toMatchObject({
      producer: "grounded_vlm",
      model: policy.model_alias,
      runtime: policy.model_snapshot,
    });
    expect(producer.actual_verified_frame_count).toBe(
      observation.evidence.filter((item) => item.producer === "grounded_vlm").length,
    );
    expect(producer.prompt_hash).toBeTruthy();
    expect(producer.source_content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(producer.cache_identity).toBeTruthy();
    for (const evidence of observation.evidence.filter((item) => item.producer === "grounded_vlm")) {
      expect(evidence.evidence_ref).toBeTruthy();
      expect(path.isAbsolute(evidence.artifact_ref!)).toBe(true);
      expect(fs.statSync(evidence.artifact_ref!).size).toBeGreaterThan(0);
    }
    expect(createValidator()(documents.segments)).toBe(true);
  });

  it("retains a visible skipped gap and never calls VLM when zero frames verify", async () => {
    let calls = 0;
    const live = segment();
    const result = await runParallelVlmAnalysis({
      assets: [asset],
      segments: [live],
      vlmPolicy: policy,
      samplingPolicy: sampling,
      minSegmentDurationUs: 100_000,
      vlmFn: async () => { calls += 1; throw new Error("must_not_call"); },
      sourceFileMap: new Map([[asset.asset_id, path.join(OUTPUT_DIR, "missing.mp4")]]),
      outputDir: OUTPUT_DIR,
      policyHash: "policy",
    });
    vlmReduce(
      result.shards,
      { project_id: "eye", artifact_version: "1", items: [asset] },
      { project_id: "eye", artifact_version: "1", items: [live] },
      "policy",
      policy.response_format,
      "unused",
      "unused",
      false,
    );
    expect(calls).toBe(0);
    expect(live.editorial_observation?.status).toBe("skipped");
    expect(live.editorial_observation?.warnings[0]).toContain("grounded_vlm_gap");
    expect(live.editorial_observation?.provenance.producers[0].actual_verified_frame_count).toBe(0);
  });

  it("keeps producer disagreement and evidence instead of averaging it away", () => {
    const live = segment();
    const vlm = groundedContribution("rapid");
    const deterministic = deterministicObservationContribution({
      segment: live,
      sourcePath: SOURCE_FIXTURE,
      requestHash: "measure",
      measurements: {
        measured: true,
        connector_version: "ffmpeg-motion-test",
        method: "ffmpeg_sampled_signals",
        sample_fps: 2,
        max_width: 160,
        duration_us: 5_000_000,
        metrics_measured: { shake: true, sharpness: false, exposure: true },
        shake: { measured: true, score: 0, sample_count: 4, bins: [], average_energy: 0, peak_energy: 0, peak_timestamp_us: 0 },
        exposure: { measured: true, exposure_score: 1, black_clip_ratio: 0, white_clip_ratio: 0, avg_luma: 0.42, underexposed: false, overexposed: false, sample_count: 4 },
      },
    });
    const observation = reduceEditorialObservation(live, undefined, [vlm, deterministic]);
    expect(observation.motion_type).toBe("static");
    expect(observation.avg_luma).toBe(0.42);
    expect(observation.warnings.some((warning) => warning.startsWith("producer_disagreement:motion_type"))).toBe(true);
    expect(observation.evidence.map((item) => item.producer)).toEqual(expect.arrayContaining(["grounded_vlm", "deterministic_measurement"]));
  });

  it("binds confidence to selected field owners and falls back with producer replacement", () => {
    const live = segment();
    const vlmRef = "vlm:confidence:new";
    const appraiserRef = "appraiser:confidence:old";
    const observation = reduceEditorialObservation(live, undefined, [
      {
        status: "partial",
        values: { text_presence: "present" },
        confidence: { text: { score: 0.75, evidence_refs: [vlmRef] } },
        evidence: [{ evidence_ref: vlmRef, producer: "grounded_vlm", evidence_type: "verified_frame", fields: ["text_presence"], artifact_ref: SOURCE_FIXTURE }],
        producer: { producer: "grounded_vlm", producer_version: "new", model: "new", runtime: "new", prompt_hash: "new", actual_verified_frame_count: 1, evidence_refs: [vlmRef] },
      },
      {
        status: "partial",
        values: { text_presence: "absent" },
        confidence: { text: { score: 0.9, evidence_refs: [appraiserRef] } },
        evidence: [{ evidence_ref: appraiserRef, producer: "appraiser", evidence_type: "appraiser_frame", fields: ["text_presence"], artifact_ref: SOURCE_FIXTURE }],
        producer: { producer: "appraiser", producer_version: "old", model: "old", runtime: "old", prompt_hash: "old", actual_verified_frame_count: 1, evidence_refs: [appraiserRef] },
      },
    ]);
    expect(observation.text_presence).toBe("present");
    expect(observation.confidence.text).toEqual({ score: 0.75, evidence_refs: [vlmRef] });
    const withoutVlm = removeEditorialObservationProducer(observation, "grounded_vlm")!;
    expect(withoutVlm.text_presence).toBe("absent");
    expect(withoutVlm.confidence.text).toEqual({ score: 0.9, evidence_refs: [appraiserRef] });
    expect(withoutVlm.evidence.some((item) => item.evidence_ref === appraiserRef)).toBe(true);
  });

  it("uses the conservative minimum confidence across all selected owners in a group", () => {
    const vlmRef = "vlm:appearance";
    const measurementRef = "measurement:appearance";
    const observation = reduceEditorialObservation(segment(), undefined, [
      {
        status: "partial",
        values: { dominant_colors: ["green"] },
        confidence: { appearance: { score: 0.8, evidence_refs: [vlmRef] } },
        evidence: [{ evidence_ref: vlmRef, producer: "grounded_vlm", evidence_type: "verified_frame", fields: ["dominant_colors"], artifact_ref: SOURCE_FIXTURE }],
        producer: { producer: "grounded_vlm", producer_version: "vlm", actual_verified_frame_count: 1, evidence_refs: [vlmRef] },
      },
      {
        status: "partial",
        values: { avg_luma: 0.4 },
        confidence: { appearance: { score: 1, evidence_refs: [measurementRef] } },
        evidence: [{ evidence_ref: measurementRef, producer: "deterministic_measurement", evidence_type: "deterministic_measurement", fields: ["avg_luma"], artifact_ref: SOURCE_FIXTURE }],
        producer: { producer: "deterministic_measurement", producer_version: "ffmpeg", actual_verified_frame_count: 1, evidence_refs: [measurementRef] },
      },
    ]);
    expect(observation.dominant_colors).toEqual(["green"]);
    expect(observation.avg_luma).toBe(0.4);
    expect(observation.confidence.appearance).toEqual({
      score: 0.8,
      evidence_refs: [measurementRef, vlmRef],
    });
    const missingOwnerConfidence = reduceEditorialObservation(segment(), observation, [{
      status: "partial",
      values: { dominant_colors: ["green"] },
      evidence: [{ evidence_ref: "vlm:appearance:new", producer: "grounded_vlm", evidence_type: "verified_frame", fields: ["dominant_colors"], artifact_ref: SOURCE_FIXTURE }],
      producer: { producer: "grounded_vlm", producer_version: "vlm-new", actual_verified_frame_count: 1, evidence_refs: ["vlm:appearance:new"] },
    }]);
    expect(missingOwnerConfidence.confidence.appearance).toBeUndefined();
  });

  it("replaces changed deterministic values, refs, and provenance without retaining the old generation", () => {
    const live = segment();
    const oldContribution = deterministicObservationContribution({
      segment: live,
      measurements: deterministicMeasurement(0.8, 0.4, "old"),
      sourcePath: SOURCE_FIXTURE,
      requestHash: "old-measurement",
    });
    const oldObservation = reduceEditorialObservation(live, undefined, [oldContribution]);
    const nextContribution = deterministicObservationContribution({
      segment: live,
      measurements: deterministicMeasurement(0, 0.7, "new"),
      sourcePath: SOURCE_FIXTURE,
      requestHash: "new-measurement",
    });
    const next = reduceEditorialObservation(live, oldObservation, [nextContribution]);
    expect(next.motion_type).toBe("static");
    expect(next.avg_luma).toBe(0.7);
    expect(next.evidence.some((item) => item.evidence_ref.includes("old-measurement"))).toBe(false);
    expect(next.confidence.motion?.evidence_refs).toEqual(["measurement:SEG_EYE_010A_0001:new-measurement"]);
    expect(next.provenance.producers.filter((item) => item.producer === "deterministic_measurement")).toEqual([
      expect.objectContaining({ producer_version: "new", cache_identity: "new-measurement" }),
    ]);
  });

  it("does not convert static/title-card motion or no-face facts into low visual quality", () => {
    const current = {
      scores: { motion_quality: 0.9, emotional_expression: 0.8 },
      labels: { lighting_style: [], composition_tags: ["title_card"], expression_tags: [], motion_tags: ["static"] },
    };
    const merged = mergeAppraiserVisualQuality(
      current,
      { composition_score: 0.9, light_quality: 0.9, focus_sharpness: 0.9, subject_prominence: 0.9 },
      {
        measured: true,
        connector_version: "test",
        method: "ffmpeg_sampled_signals",
        sample_fps: 2,
        max_width: 160,
        duration_us: 1_000_000,
        metrics_measured: { shake: true, sharpness: false, exposure: false },
        shake: { measured: true, score: 0, sample_count: 2, bins: [], average_energy: 0, peak_energy: 0, peak_timestamp_us: 0 },
      },
    );
    expect(merged.scores.motion_quality).toBe(0.9);
    expect(merged.score_measurements?.motion_quality).toMatchObject({ measured: false });
  });

  it("normalizes unknown directions without phrase inference and preserves Marlin-owned summary scope", () => {
    const normalized = normalizeVlmOutput({
      editorial_observation: {
        camera_motion_direction: "camera moves kind of left",
        subject_motion_direction: "unknown",
        confidence: { direction: 0.73 },
      },
    }, 0, 1_000_000);
    expect(normalized.editorial_observation?.values.camera_motion_direction).toBe("unknown");
    expect(normalized.editorial_observation?.values.subject_motion_direction).toBe("unknown");
    expect(normalized.editorial_observation?.values.motion_type).toBeUndefined();
    expect(normalized.editorial_observation?.confidence).toEqual({ direction: 0.73 });

    const verifiedFramePath = path.join(OUTPUT_DIR, "arbitrary-valid-frame-name.jpg");
    fs.writeFileSync(verifiedFramePath, "verified-frame");

    const live = segment({
      summary: "Asset-scoped Marlin scene summary",
      provenance: {
        ...segment().provenance,
        summary: { method: "marlin_reporter", prompt_template_id: "marlin-caption-v1" },
      },
    });
    const shard = {
      segment_id: live.segment_id,
      result: {
        success: true,
        output: {
          summary: "VLM segment summary",
          tags: [],
          interest_points: [],
          quality_flags: [],
          confidence: { summary: 1, tags: 1, quality_flags: 1 },
          editorial_observation: normalized.editorial_observation,
        },
        prompt_hash: "prompt",
        model_alias: "mock",
        model_snapshot: "runtime",
        frame_grounding: {
          frame_count: 1,
          verified_frame_paths: [verifiedFramePath],
          sample_timestamps_us: [500_000],
          requested_sample_timestamps_us: [500_000],
          frame_cache_version: "v1",
          frame_producer_version: "v1",
          frame_cache_hits: 0,
        },
      },
    };
    vlmReduce([shard], { project_id: "eye", artifact_version: "1", items: [asset] }, { project_id: "eye", artifact_version: "1", items: [live] }, "policy", "json", "unused", "unused", false);
    expect(live.summary).toBe("Asset-scoped Marlin scene summary");
    expect(live.editorial_observation?.camera_motion_direction).toBe("unknown");
    expect(live.editorial_observation?.shot_scale).toBeUndefined();
    expect(live.editorial_observation?.confidence.direction?.score).toBe(0.73);
    expect(live.editorial_observation?.confidence.direction?.evidence_refs).toHaveLength(1);
    expect(live.editorial_observation?.confidence.framing).toBeUndefined();
    expect(live.editorial_observation?.status).toBe("partial");
  });

  it("accepts arbitrary valid frame names and rejects missing, relative, empty, nonexistent, and non-integer timestamp evidence", () => {
    const emptyPath = path.join(OUTPUT_DIR, "500000-empty.jpg");
    const arbitraryValidPath = path.join(OUTPUT_DIR, "not-a-timestamp-name.jpg");
    fs.writeFileSync(emptyPath, "");
    fs.writeFileSync(arbitraryValidPath, "frame");
    const accepted = segment({ segment_id: "SEG_arbitrary_name" });
    vlmReduce(
      [successfulManualShard(accepted.segment_id, [arbitraryValidPath])],
      { project_id: "eye", artifact_version: "1", items: [asset] },
      { project_id: "eye", artifact_version: "1", items: [accepted] },
      "policy", "json", "unused", "unused", false,
    );
    expect(accepted.editorial_observation?.motion_type).toBe("continuous");

    const cases: Array<{ label: string; paths?: string[]; timestampUs?: number }> = [
      { label: "missing_paths" },
      { label: "relative_path", paths: ["500000.jpg"] },
      { label: "empty_path", paths: [emptyPath] },
      { label: "nonexistent_path", paths: [path.join(OUTPUT_DIR, "500000-missing.jpg")] },
      { label: "non_integer_timestamp", paths: [arbitraryValidPath], timestampUs: 500_000.5 },
    ];
    for (const testCase of cases) {
      const live = segment({ segment_id: `SEG_${testCase.label}` });
      const shard = successfulManualShard(live.segment_id, testCase.paths, testCase.timestampUs);
      vlmReduce(
        [shard],
        { project_id: "eye", artifact_version: "1", items: [asset] },
        { project_id: "eye", artifact_version: "1", items: [live] },
        "policy", "json", "unused", "unused", false,
      );
      expect(live.editorial_observation?.status, testCase.label).toBe("skipped");
      expect(live.editorial_observation?.motion_type, testCase.label).toBeUndefined();
      expect(live.editorial_observation?.warnings.join(" "), testCase.label).toContain("grounded_vlm_gap");
      expect(live.editorial_observation?.provenance.producers[0].actual_verified_frame_count, testCase.label).toBe(0);
    }
  });

  it("reuses EYE-004-compatible cached observation provenance", async () => {
    const first = segment();
    const policyHash = computeVlmCachePolicyHash(policy, sampling, 100_000);
    const sourceIdentityCache = new SourceContentIdentityCache();
    const result = await runParallelVlmAnalysis({
      assets: [asset], segments: [first], vlmPolicy: policy, samplingPolicy: sampling,
      minSegmentDurationUs: 100_000, vlmFn: mockGroundedVlm(),
      sourceFileMap: new Map([[asset.asset_id, SOURCE_FIXTURE]]), outputDir: OUTPUT_DIR,
      policyHash, sourceIdentityCache,
    });
    vlmReduce(result.shards, { project_id: "eye", artifact_version: "1", items: [asset] }, { project_id: "eye", artifact_version: "1", items: [first] }, policyHash, policy.response_format, "unused", "unused", false);
    const current = segment();
    const accepted = hydrateCachedVlmSegments({
      currentSegments: [current], cachedSegments: [first], vlmPolicy: policy, policyHash,
      samplingPolicy: sampling, minSegmentDurationUs: 100_000,
      sourceFileMap: new Map([[asset.asset_id, SOURCE_FIXTURE]]), outputDir: OUTPUT_DIR,
      sourceIdentityCache,
    });
    expect(accepted.has(current.segment_id)).toBe(true);
    expect(current.editorial_observation?.provenance.producers.find((item) => item.producer === "grounded_vlm")?.cache_decision).toBe("accepted");
    expect(current.editorial_observation?.producer_snapshots?.grounded_vlm?.producer.cache_decision).toBe("accepted");

    const tampered = structuredClone(first);
    const tamperedProducer = tampered.editorial_observation!.provenance.producers.find(
      (item) => item.producer === "grounded_vlm",
    )!;
    tamperedProducer.source_content_sha256 = "0".repeat(64);
    const rejectedCurrent = segment();
    const rejected = hydrateCachedVlmSegments({
      currentSegments: [rejectedCurrent], cachedSegments: [tampered], vlmPolicy: policy, policyHash,
      samplingPolicy: sampling, minSegmentDurationUs: 100_000,
      sourceFileMap: new Map([[asset.asset_id, SOURCE_FIXTURE]]), outputDir: OUTPUT_DIR,
      sourceIdentityCache,
    });
    expect(rejected.has(rejectedCurrent.segment_id)).toBe(false);
    expect(rejectedCurrent.editorial_observation).toBeUndefined();
  });

  it("replaces stale grounded VLM values, refs, provenance, and disagreements after cache invalidation and live analysis", async () => {
    const oldPolicyHash = computeVlmCachePolicyHash(policy, sampling, 100_000, "old");
    const newPolicyHash = computeVlmCachePolicyHash(policy, sampling, 100_000, "new");
    const sourceIdentityCache = new SourceContentIdentityCache();
    const old = segment();
    const oldRun = await runParallelVlmAnalysis({
      assets: [asset], segments: [old], vlmPolicy: policy, samplingPolicy: sampling,
      minSegmentDurationUs: 100_000,
      vlmFn: mockGroundedVlm({ subjectMotionDirection: "left", textPresence: "absent" }),
      sourceFileMap: new Map([[asset.asset_id, SOURCE_FIXTURE]]), outputDir: OUTPUT_DIR,
      policyHash: oldPolicyHash, sourceIdentityCache,
    });
    vlmReduce(oldRun.shards, { project_id: "eye", artifact_version: "1", items: [asset] }, { project_id: "eye", artifact_version: "1", items: [old] }, oldPolicyHash, policy.response_format, "unused", "unused", false);
    old.editorial_observation = reduceEditorialObservation(old, old.editorial_observation, [{
      status: "partial",
      values: { text_presence: "present" },
      confidence: { text: { score: 0.6, evidence_refs: ["appraiser:old"] } },
      evidence: [{ evidence_ref: "appraiser:old", producer: "appraiser", evidence_type: "appraiser_frame", fields: ["text_presence"], artifact_ref: SOURCE_FIXTURE }],
      producer: { producer: "appraiser", producer_version: "old", model: "old", runtime: "old", prompt_hash: "old", actual_verified_frame_count: 1, evidence_refs: ["appraiser:old"] },
    }]);
    const oldGroundedRefs = old.editorial_observation.evidence
      .filter((item) => item.producer === "grounded_vlm")
      .map((item) => item.evidence_ref);
    const oldCacheIdentity = old.editorial_observation.provenance.producers.find(
      (item) => item.producer === "grounded_vlm",
    )!.cache_identity;
    expect(old.editorial_observation.subject_motion_direction).toBe("left");
    expect(old.editorial_observation.warnings.some((warning) => warning.includes("producer_disagreement"))).toBe(true);

    const current = structuredClone(old);
    const accepted = hydrateCachedVlmSegments({
      currentSegments: [current], cachedSegments: [old], vlmPolicy: policy, policyHash: newPolicyHash,
      samplingPolicy: sampling, minSegmentDurationUs: 100_000,
      sourceFileMap: new Map([[asset.asset_id, SOURCE_FIXTURE]]), outputDir: OUTPUT_DIR,
      sourceIdentityCache,
    });
    expect(accepted.size).toBe(0);
    expect(current.editorial_observation).toBeUndefined();

    const freshRun = await runParallelVlmAnalysis({
      assets: [asset], segments: [current], vlmPolicy: policy, samplingPolicy: sampling,
      minSegmentDurationUs: 100_000,
      vlmFn: mockGroundedVlm({ subjectMotionDirection: "right", textPresence: "present" }),
      sourceFileMap: new Map([[asset.asset_id, SOURCE_FIXTURE]]), outputDir: OUTPUT_DIR,
      policyHash: newPolicyHash, sourceIdentityCache,
    });
    vlmReduce(freshRun.shards, { project_id: "eye", artifact_version: "1", items: [asset] }, { project_id: "eye", artifact_version: "1", items: [current] }, newPolicyHash, policy.response_format, "unused", "unused", false);
    const finalObservation = current.editorial_observation!;
    const finalGrounded = finalObservation.provenance.producers.filter((item) => item.producer === "grounded_vlm");
    expect(finalObservation.subject_motion_direction).toBe("right");
    expect(finalObservation.text_presence).toBe("present");
    expect(finalGrounded).toHaveLength(1);
    expect(finalGrounded[0].cache_identity).not.toBe(oldCacheIdentity);
    expect(finalObservation.evidence.some((item) => oldGroundedRefs.includes(item.evidence_ref))).toBe(false);
    expect(Object.values(finalObservation.confidence).flatMap((item) => item?.evidence_refs ?? []).some((ref) => oldGroundedRefs.includes(ref))).toBe(false);
    expect(finalObservation.warnings.some((warning) => warning.includes("kept=\"absent\""))).toBe(false);
  });
});

function successfulManualShard(segmentId: string, verifiedFramePaths?: string[], timestampUs = 500_000) {
  return {
    segment_id: segmentId,
    result: {
      success: true,
      output: {
        summary: "manual",
        tags: [],
        interest_points: [],
        quality_flags: [],
        confidence: { summary: 1, tags: 1, quality_flags: 1 },
        editorial_observation: {
          values: { motion_type: "continuous" as const },
          confidence: { motion: 0.9 },
        },
      },
      prompt_hash: "manual-prompt",
      model_alias: "manual-model",
      model_snapshot: "manual-runtime",
      frame_grounding: {
        frame_count: 1,
        ...(verifiedFramePaths ? { verified_frame_paths: verifiedFramePaths } : {}),
        sample_timestamps_us: [timestampUs],
        requested_sample_timestamps_us: [timestampUs],
        frame_cache_version: "v1",
        frame_producer_version: "v1",
        frame_cache_hits: 0,
      },
    },
  };
}

function groundedContribution(motionType: "rapid" | "static"): ObservationContribution {
  return {
    status: "ready",
    values: { motion_type: motionType },
    confidence: { motion: { score: 0.8, evidence_refs: ["vlm:frame"] } },
    evidence: [{ evidence_ref: "vlm:frame", producer: "grounded_vlm", evidence_type: "verified_frame", fields: ["motion_type"], artifact_ref: SOURCE_FIXTURE }],
    producer: { producer: "grounded_vlm", producer_version: "test", model: "test", runtime: "test", prompt_hash: "test", actual_verified_frame_count: 1, evidence_refs: ["vlm:frame"] },
  };
}

function deterministicMeasurement(
  motion: number,
  avgLuma: number,
  connectorVersion: string,
): VisualQualityMeasurements {
  return {
    measured: true,
    connector_version: connectorVersion,
    method: "ffmpeg_sampled_signals",
    sample_fps: 2,
    max_width: 160,
    duration_us: 5_000_000,
    metrics_measured: { shake: true, sharpness: false, exposure: true },
    shake: { measured: true, score: motion, sample_count: 4, bins: [], average_energy: motion, peak_energy: motion, peak_timestamp_us: 0 },
    exposure: { measured: true, exposure_score: 1, black_clip_ratio: 0, white_clip_ratio: 0, avg_luma: avgLuma, underexposed: false, overexposed: false, sample_count: 4 },
  };
}
