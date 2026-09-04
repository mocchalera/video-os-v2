import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestAsset, type AssetItem } from "../runtime/connectors/ffprobe.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { VlmFn, VlmPolicy, SamplingPolicy } from "../runtime/connectors/gemini-vlm.js";
import { materializeCandidateMediaCapabilities } from "../runtime/artifacts/candidate-media-materialization.js";
import {
  assertProjectPlanningMediaKindsSupported,
  candidateSupportsVisual,
  candidateSupportsVideo,
  readAssetMediaCapabilities,
} from "../runtime/artifacts/source-media-capabilities.js";
import { ImageSequenceGroundingError } from "../runtime/artifacts/image-sequence-grounding.js";
import { runCanonicalCompile } from "../runtime/compiler/index.js";
import { MEDIA_KIND_REGISTRY } from "../runtime/media/media-kind-registry.js";
import { discoverRequestedSources } from "../runtime/media/source-discovery.js";
import { runPipeline, SourceReadinessError } from "../runtime/pipeline/ingest.js";
import { ingestMapWithFailures } from "../runtime/pipeline/stages/ingest-map.js";
import { runParallelVlmAnalysis, vlmReduce } from "../runtime/pipeline/stages/vlm.js";
import { sha256FileHex } from "../runtime/source-content-identity.js";
import { readValidatedStillImageFrames } from "../runtime/artifacts/still-image-grounding.js";
import { loadCompactSegmentEvidence } from "../runtime/agents/llm-triage-agent.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  addSchema(schema: object): void;
  compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vos-still-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
}

function makeFixtures(dir: string): { jpeg: string; png: string; oriented: string; alias: string } {
  const jpeg = path.join(dir, "landscape.jpg");
  const png = path.join(dir, "portrait-alpha.png");
  const base = path.join(dir, "orientation-base.jpg");
  const oriented = path.join(dir, "orientation-6.jpg");
  const alias = path.join(dir, "landscape-alias.jpeg");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x90", "-frames:v", "1", jpeg]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=red@0.0:s=60x120,format=rgba", "-frames:v", "1", png]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=120x80", "-frames:v", "1", base]);
  writeExifOrientation(base, oriented, 6);
  fs.symlinkSync(jpeg, alias);
  return { jpeg, png, oriented, alias };
}

function writeExifOrientation(input: string, output: string, orientation: number): void {
  const jpeg = fs.readFileSync(input);
  const tiff = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
    orientation, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), length, payload]);
  fs.writeFileSync(output, Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
}

function visualResponse(): string {
  return JSON.stringify({
    summary: "A static source image with a clear subject and text-free composition.",
    tags: ["static-image", "composition"],
    interest_points: [{ frame_us: 0, label: "still", confidence: 0.8 }],
    quality_flags: [],
    confidence: { summary: 0.9, tags: 0.9, quality_flags: 0.9 },
    editorial_observation: {
      visual_tags: ["static-image", "composition"],
      motion_type: "rapid",
      camera_motion_direction: "left",
      subject_motion_direction: "right",
      shot_scale: "wide",
      composition_anchor: "center",
      screen_side: "center",
      gaze_direction: "not_applicable",
      camera_axis: "unknown",
      dominant_subject_type: "object",
      dominant_colors: ["red", "blue"],
      text_presence: "absent",
      confidence: { tags: 0.9, motion: 0.9, framing: 0.8, direction: 0.8, appearance: 0.8, text: 0.8 },
    },
    visual_quality: {
      scores: { light_quality: 0.8, subject_prominence: 0.8, emotional_expression: 0.5, composition_score: 0.8, motion_quality: 0.9 },
      labels: { lighting_style: [], composition_tags: [], expression_tags: [], motion_tags: ["rapid"] },
    },
  });
}

function validateSchema(name: string, value: unknown): void {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas/analysis-common.schema.json"), "utf-8")));
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas", name), "utf-8")));
  expect(validate(value), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

describe("EYE-070C1 still-image analysis lane", () => {
  it("advertises truthful C2B and D2 render support", () => {
    expect(MEDIA_KIND_REGISTRY.image.capabilities).toEqual({
      discovery: true,
      ingest: true,
      segment: true,
      analyze: true,
      plan: true,
      compile: true,
      render: true,
    });
    expect(MEDIA_KIND_REGISTRY.image.consumerImpact).toBe("none");
    expect(MEDIA_KIND_REGISTRY.image.unsupportedReason).toBeNull();
    for (const kind of ["video", "audio"] as const) {
      expect(MEDIA_KIND_REGISTRY[kind].capabilities.render).toBe(true);
      expect(MEDIA_KIND_REGISTRY[kind].consumerImpact).toBe("none");
      expect(MEDIA_KIND_REGISTRY[kind].unsupportedReason).toBeNull();
    }
    expect(MEDIA_KIND_REGISTRY.sequence.capabilities.render).toBe(true);
    expect(MEDIA_KIND_REGISTRY.sequence.consumerImpact).toBe("none");
    expect(MEDIA_KIND_REGISTRY.sequence.unsupportedReason).toBeNull();
  });

  it("truthfully ingests JPEG/PNG, normalizes EXIF once, grounds VLM at zero, and keeps temporal lanes N/A", async () => {
    const sourceDir = tempDir("source");
    const projectDir = tempDir("project");
    const fixtures = makeFixtures(sourceDir);
    const calls: string[][] = [];
    const vlmFn: VlmFn = async (framePaths) => {
      calls.push(framePaths);
      return { rawJson: visualResponse() };
    };
    const requested = [fixtures.jpeg, fixtures.alias, fixtures.png, fixtures.oriented];
    const result = await runPipeline({
      sourceFiles: requested,
      sourceDiscovery: discoverRequestedSources(requested),
      projectDir,
      repoRoot: REPO_ROOT,
      vlmFn,
      skipStt: true,
      skipMarlin: true,
      skipAppraiser: true,
      skipBgmAnalysis: true,
    });

    expect(result.assetsJson.items).toHaveLength(3);
    expect(result.sourceLedger?.summary).toEqual({ requested: 4, ready: 4, unsupported: 0, failed: 0 });
    expect(calls).toHaveLength(3);
    for (const asset of result.assetsJson.items) {
      expect(asset.media_kind).toBe("image");
      expect(asset.duration_us).toBe(0);
      expect(asset.duration_semantics).toBe("single_frame_zero_duration");
      expect(asset.frame_rate_mode).toBe("still_image");
      expect(asset.audio_stream).toBeUndefined();
      expect(asset.still_image).toBeDefined();
      expect(path.isAbsolute(asset.still_image!.normalized_frame_path)).toBe(false);
      const framePath = path.join(projectDir, "03_analysis", asset.still_image!.normalized_frame_path);
      expect(fs.statSync(framePath).size).toBeGreaterThan(0);
      expect(sha256FileHex(framePath)).toBe(asset.still_image!.normalized_frame_content_sha256);
      const segment = result.segmentsJson.items.find((item) => item.asset_id === asset.asset_id)!;
      expect(segment).toMatchObject({
        src_in_us: 0,
        src_out_us: 1,
        duration_us: 1,
        rep_frame_us: 0,
        segment_type: "static",
        source_interval: {
          semantics: "schema_compatible_single_frame_interval",
          physical_duration_us: 0,
          schema_compatibility_epsilon_us: 1,
          editing_hold_duration_us: null,
        },
      });
      expect(segment.provenance.boundary.method).toBe("still_image_single_frame");
      expect(segment.filmstrip_path).toBeUndefined();
      expect(segment.peak_analysis).toBeUndefined();
      expect((segment as unknown as Record<string, unknown>).visual_quality).toBeUndefined();
      expect(segment.interest_points).toBeUndefined();
      expect(segment.visual_quality_measurements).toMatchObject({
        method: "ffmpeg_single_frame_signals",
        duration_us: 0,
        metrics_measured: { shake: false, sharpness: true, exposure: true },
      });
      expect(segment.editorial_observation).toMatchObject({
        motion_type: "not_applicable",
        camera_motion_direction: "not_applicable",
        subject_motion_direction: "not_applicable",
      });
      const router = segment.editorial_observation!.producer_snapshots!.media_kind_router!;
      expect(router.confidence).toBeUndefined();
      expect(router.evidence[0]).toMatchObject({ producer: "media_kind_router", evidence_type: "applicability" });
      const grounded = segment.editorial_observation!.producer_snapshots!.grounded_vlm!;
      expect(grounded.values).not.toHaveProperty("motion_type");
      expect(grounded.values).not.toHaveProperty("camera_motion_direction");
      expect(grounded.values).not.toHaveProperty("subject_motion_direction");
      expect(segment.provenance.tags).toMatchObject({
        frame_count: 1,
        sample_timestamps_us: [0],
        requested_sample_timestamps_us: [0],
        source_content_sha256: asset.source_content_sha256,
        frame_content_sha256: [asset.still_image!.normalized_frame_content_sha256],
      });
    }
    expect(readValidatedStillImageFrames(projectDir).size).toBe(3);
    expect(loadCompactSegmentEvidence(projectDir)).toHaveLength(3);

    const oriented = result.assetsJson.items.find((asset) => asset.filename === "orientation-6.jpg")!;
    expect(oriented.still_image).toMatchObject({
      source_width: 120,
      source_height: 80,
      decoded_width: 80,
      decoded_height: 120,
      source_rotation: 90,
      orientation_normalization: {
        status: "applied",
        method: "ffmpeg_explicit_transform",
        transform: "transpose_clockwise",
        orientation_source: "exif",
      },
    });
    const transparent = result.assetsJson.items.find((asset) => asset.filename === "portrait-alpha.png")!;
    expect(transparent.still_image).toMatchObject({
      source_width: 60,
      source_height: 120,
      source_has_alpha: true,
      normalized_has_alpha: true,
    });

    const sourceMapPath = path.join(projectDir, "02_media/source_map.json");
    const sourceMapText = fs.readFileSync(sourceMapPath, "utf-8");
    const sourceMap = JSON.parse(sourceMapText) as { items: Array<Record<string, unknown>> };
    expect(sourceMapText).not.toContain(sourceDir);
    expect(sourceMapText).not.toContain(projectDir);
    for (const item of sourceMap.items) {
      expect(item).toMatchObject({ media_kind: "image" });
      expect(item.source_content_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(item.source_fingerprint).toBeTruthy();
      expect(item.source_size_bytes).toBeGreaterThan(0);
      expect(item.source_mtime_ms).toBeGreaterThan(0);
      expect(path.isAbsolute(String(item.local_source_path))).toBe(false);
    }
    const capabilities = readAssetMediaCapabilities(projectDir);
    for (const asset of result.assetsJson.items) {
      expect(capabilities.get(asset.asset_id)).toEqual({
        media_kind: "image",
        source_capabilities: { has_video: true, has_audio: false },
      });
    }
    expect(result.analysisCoverageReport?.summary).toMatchObject({ status: "ready", source_counts: result.sourceLedger?.summary });
    expect(result.analysisCoverageReport?.blockers.every((blocker) =>
      blocker.severity === "warning" && blocker.message.includes("package-blocked") && blocker.message.includes("EYE-070C2B")
    )).toBe(true);
    validateSchema("assets.schema.json", result.assetsJson);
    validateSchema("segments.schema.json", result.segmentsJson);
    validateSchema("source-map.schema.json", sourceMap);
    validateSchema("source-ledger.schema.json", result.sourceLedger);
    validateSchema("source-media-manifest.schema.json", result.sourceMediaManifest);
    validateSchema("analysis-coverage-report.schema.json", result.analysisCoverageReport);

    const oldAssetIds = new Set(result.assetsJson.items.map((asset) => asset.asset_id));
    const replacement = path.join(sourceDir, "portrait-alpha.png");
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue@0.5:s=72x128,format=rgba", "-frames:v", "1", replacement]);
    const secondCalls: string[][] = [];
    const second = await runPipeline({
      sourceFiles: [replacement],
      projectDir,
      repoRoot: REPO_ROOT,
      vlmFn: async (framePaths) => {
        secondCalls.push(framePaths);
        return { rawJson: visualResponse() };
      },
      skipStt: true,
      skipMarlin: true,
      skipAppraiser: true,
      skipBgmAnalysis: true,
    });
    expect(secondCalls).toHaveLength(1);
    expect(oldAssetIds.has(second.assetsJson.items[0].asset_id)).toBe(false);
    expect(second.assetsJson.items[0].still_image).toMatchObject({ decoded_width: 72, decoded_height: 128 });
    expect(fs.readdirSync(path.join(projectDir, "03_analysis/still_frames"))).toEqual([second.assetsJson.items[0].asset_id]);
  }, 120_000);

  it("keeps corrupt/undecodable image requests failed and does not erase the ready item", async () => {
    const sourceDir = tempDir("corrupt-source");
    const projectDir = tempDir("corrupt-project");
    const ready = path.join(sourceDir, "ready.jpg");
    const corrupt = path.join(sourceDir, "corrupt.png");
    const unavailableHeic = path.join(sourceDir, "unavailable.heic");
    ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=40x30", "-frames:v", "1", ready]);
    fs.writeFileSync(corrupt, "not a png");
    fs.writeFileSync(unavailableHeic, "not a heic decoder input");
    const result = await runPipeline({
      sourceFiles: [ready, corrupt, unavailableHeic],
      projectDir,
      repoRoot: REPO_ROOT,
      skipStt: true,
      skipVlm: true,
      skipPeak: true,
      skipMarlin: true,
      skipAppraiser: true,
      skipBgmAnalysis: true,
    });
    expect(result.assetsJson.items).toHaveLength(1);
    expect(result.sourceLedger?.summary).toEqual({ requested: 3, ready: 1, unsupported: 0, failed: 2 });
    expect(result.sourceLedger?.items.filter((item) => item.status === "failed")).toEqual(expect.arrayContaining([
      expect.objectContaining({ media_kind: "image", stage: "ingest" }),
      expect.objectContaining({ media_kind: "image", stage: "ingest" }),
    ]));
    const failedIssues = result.gapReport.entries.filter((entry) => entry.source_id);
    expect(failedIssues).toHaveLength(2);
    expect(failedIssues.every((entry) => entry.severity === "error" && entry.blocking)).toBe(true);

    await expect(runPipeline({
      sourceFiles: [corrupt], projectDir: tempDir("corrupt-only"), repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipMarlin: true, skipAppraiser: true,
    })).rejects.toBeInstanceOf(SourceReadinessError);
  }, 30_000);

  it("makes a missing normalized still frame a zero-call grounded VLM gap", async () => {
    const dir = tempDir("missing-grounding");
    const source = path.join(dir, "source.jpg");
    ffmpeg(["-f", "lavfi", "-i", "color=c=yellow:s=32x24", "-frames:v", "1", source]);
    const asset: AssetItem = {
      asset_id: "AST_MISSING_STILL",
      filename: "source.jpg",
      media_kind: "image",
      duration_us: 0,
      duration_semantics: "single_frame_zero_duration",
      has_transcript: false,
      transcript_ref: null,
      segments: 1,
      segment_ids: ["SEG_AST_MISSING_STILL_0001"],
      quality_flags: [], tags: [], source_fingerprint: "fixture", contact_sheet_ids: [], analysis_status: "ready",
      source_content_sha256: sha256FileHex(source), source_size_bytes: fs.statSync(source).size, source_mtime_ms: Math.round(fs.statSync(source).mtimeMs),
      still_image: {
        normalization_producer: "ffmpeg-still-normalizer",
        normalization_producer_version: "1",
        normalized_frame_path: "still_frames/AST_MISSING_STILL/frame_0.png",
        normalized_frame_content_sha256: "0".repeat(64),
        source_width: 32, source_height: 24, decoded_width: 32, decoded_height: 24,
        source_pixel_format: "yuvj420p", normalized_pixel_format: "rgb24", source_has_alpha: false, normalized_has_alpha: false,
        source_rotation: null,
        orientation_normalization: { status: "unknown", method: "unknown", transform: "unknown", orientation_source: "unknown" },
        color_profile: { icc_profile: "unknown", color_range: null, color_space: null, color_transfer: null, color_primaries: null },
      },
    };
    const segment: SegmentItem = {
      segment_id: asset.segment_ids[0], asset_id: asset.asset_id, src_in_us: 0, src_out_us: 1, duration_us: 1, rep_frame_us: 0,
      summary: "", transcript_excerpt: "", quality_flags: [], tags: [], segment_type: "static", transcript_ref: null,
      confidence: { boundary: { score: 1, source: "still_image_single_frame", status: "ready" } },
      provenance: { boundary: { stage: "segment", method: "still_image_single_frame", connector_version: "test", policy_hash: "test", request_hash: "test" } },
    };
    const policy: VlmPolicy = {
      model_alias: "mock", model_snapshot: "mock", input_mode: "frames", response_format: "json",
      prompt_template_id: "test", max_frame_width_px: 1024, segment_visual_token_budget_max: 1000,
      segment_visual_output_tokens_max: 500, segment_visual_frame_cap: 4, parse_retry_max: 0,
    };
    const sampling: SamplingPolicy = {
      static: { sample_fps: 1 }, action: { sample_fps_default: 1, sample_fps_min: 1, sample_fps_max: 1 },
      dialogue: { sample_fps: 1 }, music_driven: { sample_fps: 1 }, general: { sample_fps: 1 },
    };
    const vlm = vi.fn<VlmFn>(async () => ({ rawJson: visualResponse() }));
    const analyzed = await runParallelVlmAnalysis({
      assets: [asset], segments: [segment], vlmPolicy: policy, samplingPolicy: sampling,
      minSegmentDurationUs: 750_000, vlmFn: vlm, sourceFileMap: new Map([[asset.asset_id, source]]), outputDir: dir,
    });
    expect(vlm).not.toHaveBeenCalled();
    expect(analyzed.shards[0].result).toMatchObject({ success: false, frame_grounding: { frame_count: 0 } });
    const reduced = vlmReduce(analyzed.shards, { project_id: "p", artifact_version: "2", items: [asset] }, { project_id: "p", artifact_version: "2", items: [segment] }, "policy", "json", path.join(dir, "segments.json"), path.join(dir, "assets.json"), false);
    expect(reduced.segments.items[0].editorial_observation).toMatchObject({ status: "skipped" });
    expect(reduced.segments.items[0].editorial_observation?.warnings.join(" ")).toContain("normalized_frame_missing_or_empty");
  });

  it("allows image planning capability but blocks ungrounded image compilation while preserving legacy fallback", async () => {
    const projectDir = tempDir("planning-block");
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis", "assets.json"), JSON.stringify({
      items: [{
        asset_id: "AST_IMAGE",
        media_kind: "image",
        video_stream: { codec_name: "png", width: 32, height: 24 },
      }],
    }));
    const imageCandidate = {
      candidate_id: "C_IMAGE",
      segment_id: "SEG_IMAGE",
      asset_id: "AST_IMAGE",
      src_in_us: 0,
      src_out_us: 1,
      role: "support",
      media_kind: "image",
      source_capabilities: { has_video: true, has_audio: false },
    };

    expect(candidateSupportsVisual(imageCandidate as never)).toBe(true);
    expect(() => assertProjectPlanningMediaKindsSupported(projectDir)).not.toThrow();
    expect(() => materializeCandidateMediaCapabilities(
      projectDir,
      { candidates: [imageCandidate as never] },
      [{ segment_id: "SEG_IMAGE", transcript_excerpt: "" }],
    )).not.toThrow();
    await expect(runCanonicalCompile({ projectPath: projectDir, createdAt: "2026-01-01T00:00:00.000Z" }))
      .rejects.toThrow(/image_qc_gate_blocked/);

    fs.writeFileSync(path.join(projectDir, "03_analysis", "assets.json"), JSON.stringify({
      items: [{ asset_id: "AST_LEGACY", video_stream: { codec_name: "h264" } }],
    }));
    expect(() => assertProjectPlanningMediaKindsSupported(projectDir)).not.toThrow();
    expect(candidateSupportsVisual({ media_kind: undefined, source_capabilities: undefined })).toBe(true);
    // Deprecated alias remains additive API compatibility only.
    expect(candidateSupportsVideo({ media_kind: undefined, source_capabilities: undefined })).toBe(true);

    const sequenceDir = tempDir("triage-evidence-sequence-block");
    fs.mkdirSync(path.join(sequenceDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(sequenceDir, "03_analysis/assets.json"), JSON.stringify({
      items: [{ asset_id: "AST_SEQUENCE", media_kind: "sequence" }],
    }));
    expect(() => loadCompactSegmentEvidence(sequenceDir)).toThrow(ImageSequenceGroundingError);
  });

  it("fails stale discovery identity and removes a frame when source bytes change during decode", async () => {
    const sourceDir = tempDir("identity-source");
    const projectDir = tempDir("identity-project");
    const source = path.join(sourceDir, "current.png");
    ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=48x32", "-frames:v", "1", source]);
    const discovered = discoverRequestedSources([source]).requests[0];
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=48x32", "-frames:v", "1", source]);

    const stale = await ingestMapWithFailures([source], {
      projectRoot: projectDir,
      policyHash: "test",
      ffmpegVersion: "test",
      sourceFacts: new Map([[source, {
        mediaKind: "image",
        contentSha256: discovered.content_hash!.slice("sha256:".length),
        sizeBytes: discovered.size_bytes!,
        mtimeMs: discovered.mtime_ms!,
      }]]),
    });
    expect(stale.shards).toEqual([]);
    expect(stale.failures[0]?.reason).toBe("source_identity_changed_since_discovery");

    await expect(ingestAsset(source, {
      projectRoot: projectDir,
      mediaKind: "image",
      afterStillImageDecode: () => {
        ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=48x32", "-frames:v", "1", source]);
      },
    })).rejects.toThrow("still_image_source_changed_during_ingest");
    const stillRoot = path.join(projectDir, "03_analysis", "still_frames");
    expect(fs.existsSync(stillRoot) ? fs.readdirSync(stillRoot) : []).toEqual([]);
  });

  it("rejects an old normalized pixel when a VLM-only run sees changed or unrecorded source identity", async () => {
    const projectDir = tempDir("vlm-identity");
    const analysisDir = path.join(projectDir, "03_analysis");
    const source = path.join(projectDir, "source.png");
    ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=36x24", "-frames:v", "1", source]);
    const asset = await ingestAsset(source, { projectRoot: projectDir, mediaKind: "image" });
    const segment: SegmentItem = {
      segment_id: `SEG_${asset.asset_id}_0001`, asset_id: asset.asset_id,
      src_in_us: 0, src_out_us: 1, duration_us: 1, rep_frame_us: 0,
      summary: "", transcript_excerpt: "", quality_flags: [], tags: [], segment_type: "static", transcript_ref: null,
      confidence: { boundary: { score: 1, source: "still_image_single_frame", status: "ready" } },
      provenance: { boundary: { stage: "segment", method: "still_image_single_frame", connector_version: "test", policy_hash: "test", request_hash: "test" } },
    };
    const policy: VlmPolicy = {
      model_alias: "mock", model_snapshot: "mock", input_mode: "frames", response_format: "json",
      prompt_template_id: "test", max_frame_width_px: 1024, segment_visual_token_budget_max: 1000,
      segment_visual_output_tokens_max: 500, segment_visual_frame_cap: 4, parse_retry_max: 0,
    };
    const sampling: SamplingPolicy = {
      static: { sample_fps: 1 }, action: { sample_fps_default: 1, sample_fps_min: 1, sample_fps_max: 1 },
      dialogue: { sample_fps: 1 }, music_driven: { sample_fps: 1 }, general: { sample_fps: 1 },
    };
    const vlm = vi.fn<VlmFn>(async () => ({ rawJson: visualResponse() }));
    const recordedSourceSha = asset.source_content_sha256!;
    const recordedFrameSha = asset.still_image!.normalized_frame_content_sha256;
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=36x24", "-frames:v", "1", source]);
    const liveSourceSha = sha256FileHex(source);

    const mismatch = await runParallelVlmAnalysis({
      assets: [asset], segments: [segment], vlmPolicy: policy, samplingPolicy: sampling,
      minSegmentDurationUs: 750_000, vlmFn: vlm, sourceFileMap: new Map([[asset.asset_id, source]]), outputDir: analysisDir,
    });
    expect(vlm).not.toHaveBeenCalled();
    expect(mismatch.shards[0].result.frame_grounding).toMatchObject({
      frame_count: 0,
      asset_source_content_sha256: recordedSourceSha,
      source_content_sha256: liveSourceSha,
      frame_extraction_failures: ["still_image_source_identity_mismatch"],
    });
    expect(recordedFrameSha).toBe(sha256FileHex(path.join(analysisDir, asset.still_image!.normalized_frame_path)));
    const reduced = vlmReduce(mismatch.shards, { project_id: "p", artifact_version: "2", items: [asset] }, { project_id: "p", artifact_version: "2", items: [segment] }, "policy", "json", path.join(analysisDir, "segments.json"), path.join(analysisDir, "assets.json"), false);
    expect(reduced.segments.items[0].editorial_observation).toMatchObject({ status: "skipped" });
    expect(reduced.segments.items[0].editorial_observation?.warnings.join(" ")).toContain("still_image_source_identity_mismatch");

    const legacyWithoutSha = structuredClone(asset);
    legacyWithoutSha.source_content_sha256 = undefined;
    const missing = await runParallelVlmAnalysis({
      assets: [legacyWithoutSha], segments: [segment], vlmPolicy: policy, samplingPolicy: sampling,
      minSegmentDurationUs: 750_000, vlmFn: vlm, sourceFileMap: new Map([[asset.asset_id, source]]), outputDir: analysisDir,
    });
    expect(missing.shards[0].result.frame_grounding).toMatchObject({
      frame_count: 0,
      frame_extraction_failures: ["still_image_asset_source_identity_missing"],
    });
    expect(vlm).not.toHaveBeenCalled();
  });
});
