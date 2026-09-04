import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { MEDIA_KIND_REGISTRY } from "../runtime/media/media-kind-registry.js";
import {
  groupImageSequenceRequests,
  resolveImageSequencePolicy,
} from "../runtime/media/image-sequence.js";
import { discoverRequestedSources } from "../runtime/media/source-discovery.js";
import { runPipeline, SourceReadinessError } from "../runtime/pipeline/ingest.js";
import { sha256FileHex } from "../runtime/source-content-identity.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  addSchema(schema: object): void;
  compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vos-sequence-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function makePngSequence(dir: string, frameCount = 12): void {
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=s=96x54:r=24:d=${frameCount / 24}`,
    "-frames:v", String(frameCount),
    path.join(dir, "shot_%04d.png"),
  ]);
}

function makeJpegSequence(dir: string, frameCount = 12): void {
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=s=96x54:r=24:d=${frameCount / 24}`,
    "-frames:v", String(frameCount),
    path.join(dir, "shot_%04d.jpg"),
  ]);
}

function visualResponse(): string {
  return JSON.stringify({
    summary: "A short numbered image sequence with visible temporal change.",
    tags: ["image-sequence", "motion"],
    interest_points: [{ frame_us: 250_000, label: "sequence midpoint", confidence: 0.8 }],
    quality_flags: [],
    confidence: { summary: 0.9, tags: 0.9, quality_flags: 0.9 },
    editorial_observation: {
      visual_tags: ["image-sequence", "motion"],
      motion_type: "continuous",
      camera_motion_direction: "unknown",
      subject_motion_direction: "right",
      shot_scale: "wide",
      composition_anchor: "center",
      screen_side: "center",
      gaze_direction: "not_applicable",
      camera_axis: "unknown",
      dominant_subject_type: "object",
      dominant_colors: ["blue", "red"],
      text_presence: "absent",
      confidence: { tags: 0.9, motion: 0.8, framing: 0.8, direction: 0.7, appearance: 0.8, text: 0.8 },
    },
    visual_quality: {
      scores: { light_quality: 0.8, subject_prominence: 0.8, emotional_expression: 0.5, composition_score: 0.8, motion_quality: 0.8 },
      labels: { lighting_style: [], composition_tags: [], expression_tags: [], motion_tags: ["continuous"] },
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

describe("EYE-070D1 image-sequence grouping", () => {
  it("groups only strict numbered frames reached through an explicit directory scan", () => {
    const sourceDir = tempDir("group");
    makePngSequence(sourceDir);
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=32x32",
      "-frames:v", "1", path.join(sourceDir, "cover.png"),
    ]);

    const policy = resolveImageSequencePolicy({});
    expect(resolveImageSequencePolicy({
      image_sequence: { frame_rate: { fps_num: 48, fps_den: 2 }, minimum_frame_count: 1 },
    })).toEqual({ fps_num: 24, fps_den: 1, minimum_frame_count: 2 });
    const discovery = discoverRequestedSources([sourceDir]);
    const grouped = groupImageSequenceRequests(discovery, policy);

    expect(policy).toEqual({ fps_num: 24, fps_den: 1, minimum_frame_count: 2 });
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups[0]).toMatchObject({
      pattern_basename: "shot_%04d.png",
      start_number: 1,
      end_number: 12,
      frame_count: 12,
      fps_num: 24,
      fps_den: 1,
      duration_us: 500_000,
      status: "candidate",
      reason: null,
    });
    expect(grouped.groups[0].frame_set_content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(grouped.member_group_by_canonical_path.size).toBe(12);
    expect(discovery.requests.find((request) => request.lexical_path.endsWith("cover.png"))?.sequence_grouping_root).toBe(sourceDir);

    const explicitFiles = discoverRequestedSources(
      discovery.requests
        .filter((request) => request.lexical_path.includes("shot_"))
        .map((request) => request.lexical_path),
    );
    expect(groupImageSequenceRequests(explicitFiles, policy).groups).toEqual([]);

    const explicitPlusDirectory = discoverRequestedSources([
      path.join(sourceDir, "shot_0001.png"),
      sourceDir,
    ]);
    expect(groupImageSequenceRequests(explicitPlusDirectory, policy)).toMatchObject({
      groups: [{ frame_count: 12, status: "candidate" }],
    });

    const duplicatedDirectory = discoverRequestedSources([sourceDir, sourceDir]);
    const duplicatedDirectoryGrouping = groupImageSequenceRequests(duplicatedDirectory, policy);
    expect(duplicatedDirectory.requests).toHaveLength(26);
    expect(duplicatedDirectoryGrouping).toMatchObject({
      groups: [{ frame_count: 12, status: "candidate", reason: null }],
    });
    expect(duplicatedDirectoryGrouping.member_group_by_canonical_path.size).toBe(12);
  });

  it("classifies a gap as a failed sequence instead of silently truncating image2", () => {
    const sourceDir = tempDir("gap");
    makePngSequence(sourceDir);
    fs.rmSync(path.join(sourceDir, "shot_0006.png"));

    const grouped = groupImageSequenceRequests(
      discoverRequestedSources([sourceDir]),
      resolveImageSequencePolicy({ image_sequence: { frame_rate: { fps_num: 24, fps_den: 1 } } }),
    );

    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups[0]).toMatchObject({
      frame_count: 11,
      status: "failed",
      reason: "image_sequence_missing_frames:6",
    });
  });

  it("changes the ordered frame-set identity when one source frame changes", () => {
    const sourceDir = tempDir("identity");
    makePngSequence(sourceDir);
    const policy = resolveImageSequencePolicy({});
    const first = groupImageSequenceRequests(discoverRequestedSources([sourceDir]), policy).groups[0];

    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=96x54",
      "-frames:v", "1", path.join(sourceDir, "shot_0007.png"),
    ]);
    const second = groupImageSequenceRequests(discoverRequestedSources([sourceDir]), policy).groups[0];

    expect(second.frame_set_content_sha256).not.toBe(first.frame_set_content_sha256);
    expect(second.group_id).not.toBe(first.group_id);
  });
});

describe("EYE-070D1 image-sequence ingest and analysis", () => {
  it("preserves duplicate locator aliases in the ledger without duplicating logical sequence frames", async () => {
    const sourceDir = tempDir("pipeline-duplicate-locator-source");
    const projectDir = tempDir("pipeline-duplicate-locator-project");
    makePngSequence(sourceDir, 3);

    const result = await runPipeline({
      sourceFiles: [sourceDir, sourceDir],
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
    expect(result.assetsJson.items[0]).toMatchObject({
      media_kind: "sequence",
      image_sequence: { frame_count: 3 },
    });
    expect(result.sourceLedger?.summary).toEqual({ requested: 6, ready: 6, unsupported: 0, failed: 0 });
    expect(result.sourceLedger?.items).toHaveLength(6);
    expect(new Set(result.sourceLedger?.items.map((item) => item.canonical_asset_id))).toEqual(
      new Set([result.assetsJson.items[0].asset_id]),
    );
    expect(result.mediaSourceMap?.items[0].image_sequence?.frames).toHaveLength(3);
  }, 30_000);

  it("normalizes a complete 24fps image2 set into one D2-ready grounded temporal asset", async () => {
    const sourceDir = tempDir("pipeline-source");
    const projectDir = tempDir("pipeline-project");
    makePngSequence(sourceDir);
    const groundedCalls: string[][] = [];

    const result = await runPipeline({
      sourceFiles: [sourceDir],
      projectDir,
      repoRoot: REPO_ROOT,
      skipStt: true,
      vlmFn: async (framePaths) => {
        groundedCalls.push(framePaths);
        return { rawJson: visualResponse() };
      },
      skipPeak: true,
      skipMarlin: true,
      skipAppraiser: true,
      skipBgmAnalysis: true,
    });

    expect(result.assetsJson.items).toHaveLength(1);
    const asset = result.assetsJson.items[0];
    expect(asset).toMatchObject({
      media_kind: "sequence",
      duration_us: 500_000,
      duration_semantics: "physical_media_duration",
      frame_rate_mode: "cfr",
      video_stream: { width: 96, height: 54, fps_num: 24, fps_den: 1, codec: "ffv1" },
      image_sequence: {
        pattern_basename: "shot_%04d.png",
        start_number: 1,
        end_number: 12,
        frame_count: 12,
        fps_num: 24,
        fps_den: 1,
        analysis_proxy_frame_count: 12,
      },
    });
    expect(asset.image_sequence?.frame_content_sha256).toHaveLength(12);
    const proxyPath = path.join(projectDir, "03_analysis", asset.image_sequence!.analysis_proxy_path);
    expect(fs.statSync(proxyPath).size).toBeGreaterThan(0);
    expect(sha256FileHex(proxyPath)).toBe(asset.image_sequence?.analysis_proxy_content_sha256);
    expect(asset.source_content_sha256).toBe(asset.image_sequence?.analysis_proxy_content_sha256);
    expect(result.segmentsJson.items.some((segment) => segment.asset_id === asset.asset_id)).toBe(true);
    expect(groundedCalls).toHaveLength(1);
    expect(groundedCalls[0].length).toBeGreaterThan(0);
    expect(groundedCalls[0].every((framePath) => fs.statSync(framePath).size > 0)).toBe(true);
    expect(result.segmentsJson.items[0].editorial_observation).toMatchObject({
      status: "ready",
    });
    expect(result.segmentsJson.items[0].editorial_observation?.producer_snapshots?.grounded_vlm).toMatchObject({
      status: "ready",
      values: { motion_type: "continuous" },
    });
    expect(result.sourceLedger?.summary).toEqual({ requested: 12, ready: 12, unsupported: 0, failed: 0 });
    expect(new Set(result.sourceLedger?.items.map((item) => item.canonical_asset_id))).toEqual(new Set([asset.asset_id]));
    expect(result.sourceLedger?.items.every((item) =>
      item.media_kind === "sequence" && item.consumer_impact === "none"
    )).toBe(true);
    expect(result.sourceMediaManifest?.items.every((item) =>
      item.media_kind === "sequence" && item.duration_us === 500_000 && item.frame_rate_mode === "cfr"
    )).toBe(true);
    expect(result.analysisCoverageReport?.lanes.find((lane) => lane.lane_id === "source_manifest")).toMatchObject({
      status: "ready",
      consumer_impact: "none",
    });
    expect(result.analysisCoverageReport?.lanes.find((lane) => lane.lane_id === "segments")?.status).toBe("ready");
    expect(result.analysisCoverageReport?.lanes.find((lane) => lane.lane_id === "vlm_tags")?.status).toBe("ready");
    expect(MEDIA_KIND_REGISTRY.sequence.capabilities).toEqual({
      discovery: true,
      ingest: true,
      segment: true,
      analyze: true,
      plan: true,
      compile: true,
      render: true,
    });
    expect(MEDIA_KIND_REGISTRY.sequence.consumerImpact).toBe("none");
    const sequenceSource = result.mediaSourceMap?.items.find((item) => item.asset_id === asset.asset_id);
    expect(sequenceSource?.image_sequence).toMatchObject({
      frame_set_content_sha256: asset.image_sequence?.frame_set_content_sha256,
      frame_count: 12,
    });
    expect(sequenceSource?.image_sequence?.frames).toHaveLength(12);
    expect(sequenceSource?.image_sequence?.frames.every((frame) =>
      !path.isAbsolute(frame.frame_link_path) &&
      fs.lstatSync(path.join(projectDir, frame.frame_link_path)).isSymbolicLink()
    )).toBe(true);
    validateSchema("assets.schema.json", result.assetsJson);
    validateSchema("segments.schema.json", result.segmentsJson);
    validateSchema("source-ledger.schema.json", result.sourceLedger);
    validateSchema("source-media-manifest.schema.json", result.sourceMediaManifest);
    validateSchema("analysis-coverage-report.schema.json", result.analysisCoverageReport);
    validateSchema("source-map.schema.json", result.mediaSourceMap);

    groundedCalls.splice(0);
    const cached = await runPipeline({
      sourceFiles: [sourceDir], projectDir, repoRoot: REPO_ROOT,
      vlmFn: async (framePaths) => {
        groundedCalls.push(framePaths);
        return { rawJson: visualResponse() };
      },
      skipStt: true, skipPeak: true, skipMarlin: true, skipAppraiser: true, skipBgmAnalysis: true,
    });
    expect(cached.assetsJson.items[0].asset_id).toBe(asset.asset_id);
    expect(cached.assetsJson.items[0].image_sequence?.frame_set_content_sha256).toBe(asset.image_sequence?.frame_set_content_sha256);
    expect(cached.mediaSourceMap?.items[0].image_sequence?.frames).toHaveLength(12);
    expect(groundedCalls).toHaveLength(0);

    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=96x54",
      "-frames:v", "1", path.join(sourceDir, "shot_0007.png"),
    ]);
    groundedCalls.splice(0);
    const changed = await runPipeline({
      sourceFiles: [sourceDir], projectDir, repoRoot: REPO_ROOT,
      vlmFn: async (framePaths) => {
        groundedCalls.push(framePaths);
        return { rawJson: visualResponse() };
      },
      skipStt: true, skipPeak: true, skipMarlin: true, skipAppraiser: true, skipBgmAnalysis: true,
    });
    expect(changed.assetsJson.items[0].asset_id).not.toBe(asset.asset_id);
    expect(changed.assetsJson.items[0].image_sequence?.frame_set_content_sha256).not.toBe(asset.image_sequence?.frame_set_content_sha256);
    expect(groundedCalls).toHaveLength(1);
    expect(fs.existsSync(path.dirname(proxyPath))).toBe(false);
  }, 120_000);

  it("fails the whole sequence before image2 when a frame number is missing", async () => {
    const sourceDir = tempDir("pipeline-gap-source");
    const projectDir = tempDir("pipeline-gap-project");
    makePngSequence(sourceDir);
    fs.rmSync(path.join(sourceDir, "shot_0006.png"));

    await expect(runPipeline({
      sourceFiles: [sourceDir], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipMarlin: true, skipAppraiser: true,
    })).rejects.toBeInstanceOf(SourceReadinessError);
    const ledger = JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis/source_ledger.json"), "utf-8")) as {
      summary: { requested: number; ready: number; failed: number };
      items: Array<{ media_kind: string; reason: string | null }>;
    };
    expect(ledger.summary).toMatchObject({ requested: 11, ready: 0, failed: 11 });
    expect(ledger.items.every((item) =>
      item.media_kind === "sequence" && item.reason === "image_sequence_missing_frames:6"
    )).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/image_sequences"))).toBe(false);
  }, 30_000);

  it("normalizes a complete JPEG sequence through the same logical-asset contract", async () => {
    const sourceDir = tempDir("jpeg-source");
    const projectDir = tempDir("jpeg-project");
    makeJpegSequence(sourceDir);

    const result = await runPipeline({
      sourceFiles: [sourceDir], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipMarlin: true, skipAppraiser: true,
    });
    expect(result.assetsJson.items).toHaveLength(1);
    expect(result.assetsJson.items[0]).toMatchObject({
      media_kind: "sequence",
      duration_us: 500_000,
      image_sequence: { pattern_basename: "shot_%04d.jpg", frame_count: 12, analysis_proxy_frame_count: 12 },
    });
  }, 30_000);

  it("keeps a non-numbered still as a separate image asset in a mixed directory", async () => {
    const sourceDir = tempDir("mixed-source");
    const projectDir = tempDir("mixed-project");
    makePngSequence(sourceDir);
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=yellow:s=48x48",
      "-frames:v", "1", path.join(sourceDir, "cover.png"),
    ]);

    const result = await runPipeline({
      sourceFiles: [sourceDir], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipMarlin: true, skipAppraiser: true,
    });
    expect(result.assetsJson.items.map((asset) => asset.media_kind).sort()).toEqual(["image", "sequence"]);
    expect(result.sourceLedger?.summary).toEqual({ requested: 13, ready: 13, unsupported: 0, failed: 0 });
    expect(result.sourceLedger?.items.filter((item) => item.media_kind === "sequence")).toHaveLength(12);
    expect(result.sourceLedger?.items.filter((item) => item.media_kind === "image")).toHaveLength(1);
  }, 30_000);

  it("ingests dimension-incompatible auto-detected IMG stills independently", async () => {
    const sourceDir = tempDir("numbered-stills-source");
    const projectDir = tempDir("numbered-stills-project");
    const fixtures = [
      { filename: "IMG_9630.png", size: "601x1067", color: "red" },
      { filename: "IMG_9631.png", size: "1080x1920", color: "green" },
      { filename: "IMG_9632.png", size: "1080x1920", color: "blue" },
    ];
    for (const fixture of fixtures) {
      execFileSync("ffmpeg", [
        "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${fixture.color}:s=${fixture.size}`,
        "-frames:v", "1", path.join(sourceDir, fixture.filename),
      ]);
    }

    const result = await runPipeline({
      sourceFiles: [sourceDir], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipMarlin: true, skipAppraiser: true,
      skipBgmAnalysis: true,
    });

    expect(result.assetsJson.items).toHaveLength(3);
    expect(result.assetsJson.items.every((asset) =>
      asset.media_kind === "image" && asset.still_image !== undefined && asset.image_sequence === undefined
    )).toBe(true);
    expect(result.sourceLedger?.summary).toEqual({ requested: 3, ready: 3, unsupported: 0, failed: 0 });
    expect(result.sourceLedger?.items.map((item) => item.requested_locator)).toEqual(
      fixtures.map((fixture) => `external://${fixture.filename}`),
    );
    expect(result.sourceLedger?.items.map((item) => item.content_hash)).toEqual(
      fixtures.map((fixture) => `sha256:${sha256FileHex(path.join(sourceDir, fixture.filename))}`),
    );
    expect(result.sourceMediaManifest?.items.every((item) =>
      item.media_kind === "image" && item.ingest_status === "ready" && item.reason === null
    )).toBe(true);
    expect(result.analysisCoverageReport?.lanes.find((lane) => lane.lane_id === "source_manifest")).toMatchObject({
      status: "ready",
      consumer_impact: "none",
    });
    validateSchema("assets.schema.json", result.assetsJson);
    validateSchema("source-ledger.schema.json", result.sourceLedger);
    validateSchema("source-media-manifest.schema.json", result.sourceMediaManifest);
    validateSchema("analysis-coverage-report.schema.json", result.analysisCoverageReport);
  }, 30_000);

  it("fails a corrupt numbered frame as a sequence ingest error and removes the staged proxy", async () => {
    const sourceDir = tempDir("corrupt-source");
    const projectDir = tempDir("corrupt-project");
    makePngSequence(sourceDir);
    fs.writeFileSync(path.join(sourceDir, "shot_0007.png"), "not a png");

    await expect(runPipeline({
      sourceFiles: [sourceDir], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipMarlin: true, skipAppraiser: true,
    })).rejects.toBeInstanceOf(SourceReadinessError);
    const ledger = JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis/source_ledger.json"), "utf-8")) as {
      items: Array<{ media_kind: string; reason: string | null }>;
    };
    expect(ledger.items.every((item) => item.media_kind === "sequence")).toBe(true);
    expect(ledger.items[0].reason).toBe("image_sequence_decode_failed:7");
    const sequenceRoot = path.join(projectDir, "03_analysis/image_sequences");
    expect(!fs.existsSync(sequenceRoot) || fs.readdirSync(sequenceRoot).length === 0).toBe(true);
  }, 30_000);

  it("falls back a dimension-incompatible auto-detected sequence to independent stills", async () => {
    const sourceDir = tempDir("dimensions-source");
    const projectDir = tempDir("dimensions-project");
    makePngSequence(sourceDir);
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=purple:s=48x48",
      "-frames:v", "1", path.join(sourceDir, "shot_0007.png"),
    ]);

    const result = await runPipeline({
      sourceFiles: [sourceDir], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipMarlin: true, skipAppraiser: true,
      skipBgmAnalysis: true,
    });
    expect(result.assetsJson.items).toHaveLength(12);
    expect(result.assetsJson.items.every((item) =>
      item.media_kind === "image" && item.still_image !== undefined && item.image_sequence === undefined
    )).toBe(true);
    expect(result.sourceLedger?.summary).toEqual({ requested: 12, ready: 12, unsupported: 0, failed: 0 });
    expect(result.sourceLedger?.items.every((item) => item.media_kind === "image" && item.reason === null)).toBe(true);
    expect(result.analysisCoverageReport?.lanes.find((lane) => lane.lane_id === "source_manifest")).toMatchObject({
      status: "ready",
      consumer_impact: "none",
    });
  }, 30_000);
});
