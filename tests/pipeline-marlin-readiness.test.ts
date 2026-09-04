import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { MarlinFn } from "../runtime/connectors/marlin-types.js";
import type { VlmFn } from "../runtime/connectors/gemini-vlm.js";
import type { VisualQualityMeasurements } from "../runtime/connectors/ffmpeg-motion.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import { runPipeline, SourceReadinessError } from "../runtime/pipeline/ingest.js";
import type { PipelineStageProgress } from "../runtime/progress.js";
import {
  sha256FileHex,
  SourceContentIdentityCache,
  SourceContentIntegrityError,
} from "../runtime/source-content-identity.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MEDIA_DIR = path.join(import.meta.dirname, "fixtures/media");
const SOURCES = [
  path.join(MEDIA_DIR, "test-clip-5s.mp4"),
  path.join(MEDIA_DIR, "test-scene-changes.mp4"),
];
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempProject(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eye-002-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function mutableSources(projectDir: string): [string, string] {
  const sourceDir = path.join(projectDir, "source");
  fs.mkdirSync(sourceDir, { recursive: true });
  const sourceA = path.join(sourceDir, "a.mp4");
  const sourceB = path.join(sourceDir, "b.mp4");
  fs.copyFileSync(SOURCES[0], sourceA);
  fs.copyFileSync(SOURCES[1], sourceB);
  return [sourceA, sourceB];
}

function changeSourceContentAndMtime(sourcePath: string): void {
  fs.appendFileSync(sourcePath, "eye-002-current-source-change");
  const changedTime = new Date(Date.now() + 2_000);
  fs.utimesSync(sourcePath, changedTime, changedTime);
}

function successfulMarlin(scene = "current marlin scene"): MarlinFn {
  return {
    async caption() {
      return { scene, caption: scene, events: [{ start: 1, end: 2, description: "event", confidence: 0.8 }] };
    },
    async find(_videoPath, query) {
      return { query, span: [1, 2], format_ok: true, confidence: 0.7 };
    },
  };
}

function staleMarlinArtifact(projectDir: string): string {
  return JSON.stringify({
    project_id: path.basename(projectDir),
    artifact_version: "1.0.0",
    model: { provider: "marlin", model_alias: "stale", model_snapshot: "stale" },
    items: [],
  });
}

function downstreamVlm(calls: { vlm: number; peak: number }): VlmFn {
  return async (_frames, prompt) => {
    if (prompt.includes("asset overview contact sheet")) {
      calls.peak += 1;
      return { rawJson: JSON.stringify({ coarse_candidates: [] }) };
    }
    calls.vlm += 1;
    return {
      rawJson: JSON.stringify({
        summary: "Grounded downstream summary.",
        tags: ["downstream_vlm"],
        interest_points: [],
        quality_flags: [],
        confidence: { summary: 0.8, tags: 0.8, quality_flags: 0.8 },
      }),
    };
  };
}

function measurement(): VisualQualityMeasurements {
  return {
    measured: true,
    connector_version: "eye-002-test",
    method: "ffmpeg_sampled_signals",
    sample_fps: 1,
    max_width: 160,
    duration_us: 1_000_000,
    metrics_measured: { shake: false, sharpness: false, exposure: false },
  };
}

function appraiserResult() {
  return {
    visual_quality: {
      composition_score: 0.8,
      light_quality: 0.8,
      focus_sharpness: 0.8,
      subject_prominence: 0.8,
    },
    extracted_text: [],
    place_hint: { name: null, category: "unknown", confidence: 0, evidence: [] },
    aesthetic_notes: [],
  };
}

describe("EYE-002 Marlin degraded readiness", () => {
  it("fails open after a partial checkpoint on the normal path and runs every downstream stage", async () => {
    const projectDir = tempProject("normal-partial");
    const analysisDir = path.join(projectDir, "03_analysis");
    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, "marlin_events.json"), staleMarlinArtifact(projectDir));
    let captions = 0;
    const marlinFn: MarlinFn = {
      async caption() {
        captions += 1;
        if (captions === 2) {
          throw new Error(`worker timeout for /private/source/secret-name.mov`);
        }
        return { scene: "first-asset-scene", events: [{ start: 1, end: 2, description: "first event" }] };
      },
      async find(_videoPath, query) {
        return { query, span: [1, 2], format_ok: true };
      },
    };
    const calls = { vlm: 0, peak: 0, appraiser: 0, visual: 0 };
    const marlinProgress = { complete: 0, fail: 0 };
    const stageProgress: PipelineStageProgress = {
      beginStage(stage) {
        return {
          complete() { if (stage === "marlin") marlinProgress.complete += 1; },
          fail() { if (stage === "marlin") marlinProgress.fail += 1; },
          skip() {},
        };
      },
      async track(_stage, fn) { return await fn(); },
    };

    const result = await runPipeline({
      sourceFiles: SOURCES,
      projectDir,
      repoRoot: REPO_ROOT,
      noCache: true,
      skipStt: true,
      skipMediaLink: true,
      skipBgmAnalysis: true,
      marlinFn,
      vlmFn: downstreamVlm(calls),
      appraiserFn: async () => { calls.appraiser += 1; return appraiserResult(); },
      visualQualityAnalyzeFn: async () => { calls.visual += 1; return measurement(); },
      stageProgress,
    });

    expect(captions).toBe(2);
    expect(calls.vlm).toBeGreaterThan(0);
    expect(calls.peak).toBeGreaterThan(0);
    expect(calls.appraiser).toBeGreaterThan(0);
    expect(calls.visual).toBeGreaterThan(0);
    expect(marlinProgress).toEqual({ complete: 1, fail: 0 });
    expect(result.assetsJson.items).toHaveLength(2);
    expect(result.segmentsJson.items.length).toBeGreaterThan(0);
    expect(result.analysisReadiness).toEqual({
      overall: "partial",
      stages: {
        marlin: {
          status: "partial",
          reason: "marlin_worker_timeout",
          affectedCapabilities: [
            "marlin_scene_reporting",
            "marlin_event_detection",
            "marlin_temporal_peak_evidence",
          ],
        },
      },
    });
    expect(fs.existsSync(path.join(analysisDir, "marlin_events.json"))).toBe(false);
    const segmentsText = fs.readFileSync(path.join(analysisDir, "segments.json"), "utf-8");
    expect(segmentsText).not.toContain("first-asset-scene");
    expect(segmentsText).not.toContain("marlin_reporter");

    const gap = parseYaml(fs.readFileSync(path.join(analysisDir, "gap_report.yaml"), "utf-8")) as {
      entries: Array<Record<string, unknown>>;
    };
    const marlinGap = gap.entries.find((entry) => entry.stage === "marlin");
    expect(marlinGap).toMatchObject({
      severity: "warning",
      blocking: false,
      retriable: true,
      issue: "marlin_failed: marlin_worker_timeout",
      affected_capabilities: [
        "marlin_scene_reporting",
        "marlin_event_detection",
        "marlin_temporal_peak_evidence",
      ],
    });
    expect(JSON.stringify(marlinGap)).not.toContain(projectDir);
    expect(JSON.stringify(marlinGap)).not.toContain("secret-name.mov");
  }, 180_000);

  it("fails open on the all-cached path and preserves its downstream compatibility route", async () => {
    const projectDir = tempProject("all-cached");
    await runPipeline({
      sourceFiles: [SOURCES[0]], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipMarlin: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
    });
    fs.writeFileSync(path.join(projectDir, "03_analysis/marlin_events.json"), staleMarlinArtifact(projectDir));
    const calls = { vlm: 0, peak: 0, appraiser: 0, visual: 0 };
    const log = vi.spyOn(console, "log");
    const result = await runPipeline({
      sourceFiles: [SOURCES[0]], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipMediaLink: true, skipBgmAnalysis: true,
      marlinFn: { ...successfulMarlin(), caption: async () => { throw new Error("model_not_found"); } },
      vlmFn: downstreamVlm(calls),
      appraiserFn: async () => { calls.appraiser += 1; return appraiserResult(); },
      visualQualityAnalyzeFn: async () => { calls.visual += 1; return measurement(); },
    });

    expect(log.mock.calls.some(([message]) => String(message).includes("[cache hit]"))).toBe(true);
    expect(result.analysisReadiness.overall).toBe("partial");
    expect(result.analysisReadiness.stages.marlin.reason).toBe("marlin_model_unavailable");
    expect(result.gapReport.entries.some((entry) => entry.stage === "marlin")).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/marlin_events.json"))).toBe(false);
    expect(calls.vlm).toBeGreaterThan(0);
    expect(calls.appraiser).toBeGreaterThan(0);
    expect(calls.visual).toBeGreaterThan(0);
  }, 180_000);

  it("reports success and both skip modes without degrading overall readiness", async () => {
    const projectDir = tempProject("success-skip");
    const common = {
      sourceFiles: [SOURCES[0]], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
    };
    const success = await runPipeline({ ...common, marlinFn: successfulMarlin() });
    const artifactPath = path.join(projectDir, "03_analysis/marlin_events.json");
    expect(success.analysisReadiness).toEqual({
      overall: "ready",
      stages: { marlin: { status: "ready", affectedCapabilities: [] } },
    });
    expect(fs.existsSync(artifactPath)).toBe(true);

    const skipped = await runPipeline({ ...common, skipMarlin: true, marlinFn: successfulMarlin() });
    expect(skipped.analysisReadiness.overall).toBe("ready");
    expect(skipped.analysisReadiness.stages.marlin).toEqual({
      status: "skipped", reason: "marlin_skipped_by_request", affectedCapabilities: [],
    });
    expect(fs.existsSync(artifactPath)).toBe(true);

    const noWorker = await runPipeline(common);
    expect(noWorker.analysisReadiness.overall).toBe("ready");
    expect(noWorker.analysisReadiness.stages.marlin).toEqual({
      status: "skipped", reason: "marlin_worker_not_configured", affectedCapabilities: [],
    });
    expect(noWorker.gapReport.entries.some((entry) => entry.stage === "marlin")).toBe(false);
  }, 180_000);

  it("publishes only current-source Marlin state after an A+B to A-only successful run", async () => {
    const projectDir = tempProject("source-set-success");
    const common = {
      projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
    };
    const first = await runPipeline({ ...common, sourceFiles: SOURCES, marlinFn: successfulMarlin("first run") });
    const assetA = first.assetsJson.items.find((asset) => asset.filename === path.basename(SOURCES[0]))!;
    const assetB = first.assetsJson.items.find((asset) => asset.filename === path.basename(SOURCES[1]))!;

    const second = await runPipeline({
      ...common, sourceFiles: [SOURCES[0]], marlinFn: successfulMarlin("current A only"),
    });
    const artifact = JSON.parse(fs.readFileSync(path.join(second.outputDir, "marlin_events.json"), "utf-8"));
    const rollback = JSON.parse(fs.readFileSync(path.join(second.outputDir, "marlin_rollback.json"), "utf-8"));

    expect(second.analysisReadiness.stages.marlin.status).toBe("ready");
    expect(artifact.items.map((item: { asset_id: string }) => item.asset_id)).toEqual([assetA.asset_id]);
    expect(artifact.items.map((item: { asset_id: string }) => item.asset_id)).not.toContain(assetB.asset_id);
    expect(second.segmentsJson.items.every((segment) => segment.asset_id === assetA.asset_id)).toBe(true);
    expect(rollback.segments.map((entry: { segment_id: string }) => entry.segment_id).sort()).toEqual(
      second.segmentsJson.items.map((segment) => segment.segment_id).sort(),
    );
    expect(JSON.stringify(rollback)).not.toContain(assetB.asset_id);
  }, 180_000);

  it("degrades without resurrecting B after an A+B success and A-only failure", async () => {
    const projectDir = tempProject("source-set-failure");
    const common = {
      projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
    };
    const first = await runPipeline({ ...common, sourceFiles: SOURCES, marlinFn: successfulMarlin("first run") });
    const assetA = first.assetsJson.items.find((asset) => asset.filename === path.basename(SOURCES[0]))!;
    const assetB = first.assetsJson.items.find((asset) => asset.filename === path.basename(SOURCES[1]))!;

    const failed = await runPipeline({
      ...common,
      sourceFiles: [SOURCES[0]],
      marlinFn: { ...successfulMarlin(), caption: async () => { throw new Error("worker timeout"); } },
    });

    expect(failed.analysisReadiness.overall).toBe("partial");
    expect(failed.segmentsJson.items.every((segment) => segment.asset_id === assetA.asset_id)).toBe(true);
    expect(failed.segmentsJson.items.some((segment) => segment.asset_id === assetB.asset_id)).toBe(false);
    expect(JSON.stringify(failed.segmentsJson)).not.toContain("marlin_reporter");
    expect(JSON.stringify(failed.segmentsJson)).not.toContain("first run");
    expect(fs.existsSync(path.join(failed.outputDir, "marlin_events.json"))).toBe(false);
    expect(fs.existsSync(path.join(failed.outputDir, "marlin_rollback.json"))).toBe(false);
  }, 180_000);

  it("reanalyzes after source replacement with a completely new segment-id set", async () => {
    const projectDir = tempProject("source-replacement");
    const common = {
      projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
    };
    const first = await runPipeline({
      ...common, sourceFiles: [SOURCES[0]], marlinFn: successfulMarlin("old source"),
    });
    const oldSegmentIds = new Set(first.segmentsJson.items.map((segment) => segment.segment_id));

    const replacement = await runPipeline({
      ...common, sourceFiles: [SOURCES[1]], marlinFn: successfulMarlin("replacement source"),
    });
    const artifact = JSON.parse(fs.readFileSync(path.join(replacement.outputDir, "marlin_events.json"), "utf-8"));
    const rollback = JSON.parse(fs.readFileSync(path.join(replacement.outputDir, "marlin_rollback.json"), "utf-8"));
    const replacementIds = replacement.segmentsJson.items.map((segment) => segment.segment_id);

    expect(replacement.analysisReadiness.stages.marlin.status).toBe("ready");
    expect(replacementIds.every((segmentId) => !oldSegmentIds.has(segmentId))).toBe(true);
    expect(artifact.items.map((item: { asset_id: string }) => item.asset_id)).toEqual([
      replacement.assetsJson.items[0].asset_id,
    ]);
    expect(rollback.segments.map((entry: { segment_id: string }) => entry.segment_id).sort()).toEqual(
      [...replacementIds].sort(),
    );
    expect(JSON.stringify(replacement.segmentsJson)).toContain("replacement source");
    expect(JSON.stringify(replacement.segmentsJson)).not.toContain("old source");
  }, 180_000);

  it("removes Marlin evidence from both new and cached segments on a mixed-cache failure", async () => {
    const projectDir = tempProject("mixed-cache-failure");
    const [sourceA, sourceB] = mutableSources(projectDir);
    const baseOptions = {
      projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipMediaLink: true, skipBgmAnalysis: true,
    };
    await runPipeline({
      ...baseOptions,
      sourceFiles: [sourceA, sourceB],
      skipVlm: true, skipPeak: true, skipAppraiser: true,
      marlinFn: successfulMarlin("old mixed-cache scene"),
    });
    changeSourceContentAndMtime(sourceA);
    const calls = { vlm: 0, peak: 0, appraiser: 0, visual: 0 };
    const log = vi.spyOn(console, "log");

    const failed = await runPipeline({
      ...baseOptions,
      sourceFiles: [sourceA, sourceB],
      marlinFn: { ...successfulMarlin(), caption: async () => { throw new Error("worker timeout"); } },
      vlmFn: downstreamVlm(calls),
      appraiserFn: async () => { calls.appraiser += 1; return appraiserResult(); },
      visualQualityAnalyzeFn: async () => { calls.visual += 1; return measurement(); },
    });

    expect(log.mock.calls.some(([message]) => String(message).includes("[cache] 1 cached, 1 new"))).toBe(true);
    expect(failed.analysisReadiness.overall).toBe("partial");
    expect(failed.assetsJson.items).toHaveLength(2);
    expect(new Set(failed.segmentsJson.items.map((segment) => segment.asset_id))).toEqual(
      new Set(failed.assetsJson.items.map((asset) => asset.asset_id)),
    );
    expect(JSON.stringify(failed.segmentsJson)).not.toContain("marlin_reporter");
    expect(JSON.stringify(failed.segmentsJson)).not.toContain("old mixed-cache scene");
    expect(fs.existsSync(path.join(failed.outputDir, "marlin_events.json"))).toBe(false);
    expect(fs.existsSync(path.join(failed.outputDir, "marlin_rollback.json"))).toBe(false);
    expect(calls.vlm).toBeGreaterThan(0);
    expect(calls.peak).toBeGreaterThan(0);
    expect(calls.appraiser).toBeGreaterThan(0);
    expect(calls.visual).toBeGreaterThan(0);
  }, 180_000);

  it("publishes matching current Marlin evidence for both new and cached assets", async () => {
    const projectDir = tempProject("mixed-cache-success");
    const [sourceA, sourceB] = mutableSources(projectDir);
    const common = {
      projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
    };
    await runPipeline({
      ...common,
      sourceFiles: [sourceA, sourceB],
      marlinFn: successfulMarlin("old mixed-cache scene"),
    });
    changeSourceContentAndMtime(sourceA);
    const log = vi.spyOn(console, "log");

    const succeeded = await runPipeline({
      ...common,
      sourceFiles: [sourceA, sourceB],
      marlinFn: successfulMarlin("current mixed-cache scene"),
    });
    const artifact = JSON.parse(fs.readFileSync(path.join(succeeded.outputDir, "marlin_events.json"), "utf-8"));
    const artifactAssetIds = artifact.items.map((item: { asset_id: string }) => item.asset_id).sort();
    const currentAssetIds = succeeded.assetsJson.items.map((asset) => asset.asset_id).sort();

    expect(log.mock.calls.some(([message]) => String(message).includes("[cache] 1 cached, 1 new"))).toBe(true);
    expect(succeeded.analysisReadiness.stages.marlin.status).toBe("ready");
    expect(artifactAssetIds).toEqual(currentAssetIds);
    expect(new Set(succeeded.segmentsJson.items.map((segment) => segment.asset_id))).toEqual(new Set(currentAssetIds));
    for (const segment of succeeded.segmentsJson.items) {
      expect(segment.summary).toBe("current mixed-cache scene");
      expect(segment.provenance.summary?.method).toBe("marlin_reporter");
    }
    expect(JSON.stringify(succeeded.segmentsJson)).not.toContain("old mixed-cache scene");
  }, 180_000);

  it("rolls back prior successful Marlin fields on a later all-cached failure without removing other evidence", async () => {
    const projectDir = tempProject("prior-success-failure");
    const common = {
      sourceFiles: [SOURCES[0]], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
    };
    const seed = await runPipeline({ ...common, skipMarlin: true });
    const segmentsPath = path.join(seed.outputDir, "segments.json");
    const base = JSON.parse(fs.readFileSync(segmentsPath, "utf-8"));
    const baseSegment = base.items[0];
    baseSegment.summary = "base non-Marlin summary";
    baseSegment.tags = ["base_tag"];
    baseSegment.interest_points = [{ frame_us: 250_000, label: "base interest", confidence: 0.6 }];
    baseSegment.confidence.summary = { score: 0.6, source: "base-producer", status: "partial" };
    const baseSummaryProvenance = {
      stage: "vlm",
      method: "grounded_vlm",
      connector_version: "test-base-v1",
      policy_hash: "test-base-policy",
      request_hash: "test-base-request",
      model_alias: "base-model",
    };
    baseSegment.provenance.summary = baseSummaryProvenance;
    baseSegment.peak_analysis = {
      peak_moments: [{ peak_ref: "BASE_PEAK", timestamp_us: 500_000, type: "visual_peak", confidence: 0.6, description: "base peak", source_pass: "fallback" }],
      recommended_in_out: { best_in_us: 0, best_out_us: 1_000_000, rationale: "base", source_pass: "fallback" },
      visual_energy_curve: [],
      support_signals: { motion_support_score: 0.6, audio_support_score: 0, fused_peak_score: 0.6 },
      provenance: {
        coarse_prompt_template_id: "test-base-coarse",
        refine_prompt_template_id: "test-base-refine",
        precision_mode: "degraded_motion_audio",
        fusion_version: "base",
        support_signal_version: "test-base-support",
      },
    };
    expect(() => validateArtifact(base, "segments.schema.json")).not.toThrow();
    fs.writeFileSync(segmentsPath, JSON.stringify(base, null, 2));

    const successful = await runPipeline({ ...common, marlinFn: successfulMarlin("successful stale scene") });
    expect(JSON.stringify(successful.segmentsJson)).toContain("marlin_reporter");
    expect(fs.existsSync(path.join(seed.outputDir, "marlin_rollback.json"))).toBe(true);

    const enriched = JSON.parse(fs.readFileSync(segmentsPath, "utf-8"));
    enriched.items[0].tags.push("later_non_marlin_tag");
    enriched.items[0].interest_points.push({ frame_us: 750_000, label: "later non-Marlin interest", confidence: 0.9 });
    fs.writeFileSync(segmentsPath, JSON.stringify(enriched, null, 2));

    const failed = await runPipeline({
      ...common,
      marlinFn: { ...successfulMarlin(), caption: async () => { throw new Error("worker timeout"); } },
    });
    const restored = failed.segmentsJson.items[0] as unknown as Record<string, any>;
    expect(failed.analysisReadiness.overall).toBe("partial");
    expect(restored.summary).toBe("base non-Marlin summary");
    expect(restored.confidence.summary).toEqual({ score: 0.6, source: "base-producer", status: "partial" });
    expect(restored.provenance.summary).toEqual(baseSummaryProvenance);
    expect(restored.tags).toEqual(expect.arrayContaining(["base_tag", "later_non_marlin_tag"]));
    expect(restored.tags).not.toContain("successful_stale_scene");
    expect(restored.interest_points).toEqual(expect.arrayContaining([
      { frame_us: 250_000, label: "base interest", confidence: 0.6 },
      { frame_us: 750_000, label: "later non-Marlin interest", confidence: 0.9 },
    ]));
    expect(restored.peak_analysis.provenance.precision_mode).toBe("degraded_motion_audio");
    expect(JSON.stringify(restored)).not.toContain("marlin_reporter");
    expect(JSON.stringify(restored)).not.toContain("successful stale scene");
    expect(fs.existsSync(path.join(seed.outputDir, "marlin_events.json"))).toBe(false);
    expect(fs.existsSync(path.join(seed.outputDir, "marlin_rollback.json"))).toBe(false);
  }, 180_000);

  it("scrubs legacy Marlin provenance and artifact-identifiable additions when no rollback sidecar exists", async () => {
    const projectDir = tempProject("legacy-no-rollback");
    const common = {
      sourceFiles: [SOURCES[0]], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
    };
    const success = await runPipeline({ ...common, marlinFn: successfulMarlin("legacy marlin scene") });
    const segmentsPath = path.join(success.outputDir, "segments.json");
    const rollbackPath = path.join(success.outputDir, "marlin_rollback.json");
    fs.rmSync(rollbackPath);
    const legacy = JSON.parse(fs.readFileSync(segmentsPath, "utf-8"));
    legacy.items[0].tags.push("non_marlin_tag");
    legacy.items[0].interest_points.push({ frame_us: 900_000, label: "non-Marlin interest", confidence: 0.9 });
    fs.writeFileSync(segmentsPath, JSON.stringify(legacy, null, 2));

    const failed = await runPipeline({
      ...common,
      marlinFn: { ...successfulMarlin(), caption: async () => { throw new Error("worker timeout"); } },
    });
    const segment = failed.segmentsJson.items[0] as unknown as Record<string, any>;
    expect(failed.analysisReadiness.overall).toBe("partial");
    expect(segment.summary).toBe("");
    expect(segment.confidence.summary).toBeUndefined();
    expect(segment.provenance.summary).toBeUndefined();
    expect(segment.peak_analysis).toBeUndefined();
    expect(segment.tags).toContain("non_marlin_tag");
    expect(segment.tags).not.toContain("legacy_marlin_scene");
    expect(segment.interest_points).toContainEqual({ frame_us: 900_000, label: "non-Marlin interest", confidence: 0.9 });
    expect(JSON.stringify(segment)).not.toContain("marlin_reporter");
    expect(fs.existsSync(path.join(success.outputDir, "marlin_events.json"))).toBe(false);
  }, 180_000);

  it("treats a rollback segment-set mismatch as stale and reanalyzes current segments", async () => {
    const projectDir = tempProject("rollback-mismatch");
    const common = {
      sourceFiles: [SOURCES[0]], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
    };
    const success = await runPipeline({ ...common, marlinFn: successfulMarlin() });
    fs.writeFileSync(path.join(success.outputDir, "marlin_rollback.json"), JSON.stringify({
      version: "1",
      segments: [{
        segment_id: "SEG_NOT_CURRENT",
        summary: { present: false },
        confidence_summary: { present: false },
        provenance_summary: { present: false },
        peak_analysis: { present: false },
        added_tags: [],
        added_interest_points: [],
      }],
    }));
    let marlinCalls = 0;
    const rerun = await runPipeline({
      ...common,
      marlinFn: {
        async caption() { marlinCalls += 1; return {}; },
        async find() { marlinCalls += 1; return {}; },
      },
    });
    const rollback = JSON.parse(fs.readFileSync(path.join(rerun.outputDir, "marlin_rollback.json"), "utf-8"));
    expect(rerun.analysisReadiness.stages.marlin.status).toBe("ready");
    expect(marlinCalls).toBeGreaterThan(0);
    expect(rollback.segments.map((entry: { segment_id: string }) => entry.segment_id).sort()).toEqual(
      rerun.segmentsJson.items.map((segment) => segment.segment_id).sort(),
    );
    expect(JSON.stringify(rollback)).not.toContain("SEG_NOT_CURRENT");
  }, 180_000);

  it("keeps malformed internal rollback structure as a hard failure", async () => {
    const projectDir = tempProject("rollback-malformed");
    const common = {
      sourceFiles: [SOURCES[0]], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
    };
    const success = await runPipeline({ ...common, marlinFn: successfulMarlin() });
    fs.writeFileSync(path.join(success.outputDir, "marlin_rollback.json"), JSON.stringify({
      version: "1",
      segments: [{ segment_id: success.segmentsJson.items[0].segment_id }],
    }));
    let marlinCalls = 0;

    await expect(runPipeline({
      ...common,
      marlinFn: {
        async caption() { marlinCalls += 1; return {}; },
        async find() { marlinCalls += 1; return {}; },
      },
    })).rejects.toThrow("marlin_rollback_artifact_malformed");
    expect(marlinCalls).toBe(0);
  }, 180_000);

  it("keeps a segments parse/write failure hard and restores the canonical snapshot", async () => {
    const projectDir = tempProject("malformed-segments");
    let segmentsPath = "";
    const seed = await runPipeline({
      sourceFiles: [SOURCES[0]], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipMarlin: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
    });
    segmentsPath = path.join(seed.outputDir, "segments.json");
    const original = fs.readFileSync(segmentsPath, "utf-8");
    const corruptingMarlin: MarlinFn = {
      async caption() {
        fs.writeFileSync(segmentsPath, "{not-json");
        return { scene: "must-not-commit" };
      },
      async find(_videoPath, query) { return { query, span: null, format_ok: true }; },
    };

    await expect(runPipeline({
      sourceFiles: [SOURCES[0]], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true, marlinFn: corruptingMarlin,
    })).rejects.toThrow("canonical_artifact_corrupt");
    expect(JSON.parse(fs.readFileSync(segmentsPath, "utf-8"))).toEqual(JSON.parse(original));
  }, 180_000);

  it("keeps source readiness failures hard before the optional Marlin boundary", async () => {
    const projectDir = tempProject("source-hard");
    let marlinCalls = 0;
    await expect(runPipeline({
      sourceFiles: [path.join(projectDir, "missing-source.mp4")],
      projectDir,
      repoRoot: REPO_ROOT,
      skipStt: true,
      skipVlm: true,
      skipPeak: true,
      skipAppraiser: true,
      marlinFn: {
        async caption() { marlinCalls += 1; return {}; },
        async find() { marlinCalls += 1; return {}; },
      },
    })).rejects.toBeInstanceOf(SourceReadinessError);
    expect(marlinCalls).toBe(0);
  });

  it.each(["content_changed", "disappeared"] as const)(
    "keeps source integrity hard when a ready source is %s before Marlin",
    async (mode) => {
      const projectDir = tempProject(`source-integrity-${mode}`);
      const sourcePath = path.join(projectDir, "current-source.mp4");
      fs.copyFileSync(SOURCES[0], sourcePath);
      let hashReads = 0;
      const identityCache = new class extends SourceContentIdentityCache {
        private mutated = false;
        override assertExpected(filePath: string, expectedSha256: string) {
          if (!this.mutated) {
            this.mutated = true;
            if (mode === "content_changed") {
              fs.appendFileSync(filePath, "changed-after-ingest");
            } else {
              fs.rmSync(filePath);
            }
          }
          return super.assertExpected(filePath, expectedSha256);
        }
      }((filePath) => { hashReads += 1; return sha256FileHex(filePath); });
      let marlinCalls = 0;

      await expect(runPipeline({
        sourceFiles: [sourcePath], projectDir, repoRoot: REPO_ROOT,
        skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
        skipMediaLink: true, skipBgmAnalysis: true,
        sourceIdentityCache: identityCache,
        marlinFn: {
          async caption() { marlinCalls += 1; return {}; },
          async find() { marlinCalls += 1; return {}; },
        },
      })).rejects.toBeInstanceOf(SourceContentIntegrityError);
      expect(hashReads).toBe(mode === "content_changed" ? 1 : 0);
      expect(marlinCalls).toBe(0);
    },
    180_000,
  );

  it("reuses the EYE-003 full hash when source stat is unchanged before Marlin", async () => {
    const projectDir = tempProject("source-integrity-unchanged");
    const sourcePath = path.join(projectDir, "unchanged-source.mp4");
    fs.copyFileSync(SOURCES[0], sourcePath);
    let hashReads = 0;
    const identityCache = new SourceContentIdentityCache((filePath) => {
      hashReads += 1;
      return sha256FileHex(filePath);
    });

    const result = await runPipeline({
      sourceFiles: [sourcePath], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipPeak: true, skipAppraiser: true,
      skipMediaLink: true, skipBgmAnalysis: true,
      sourceIdentityCache: identityCache,
      marlinFn: successfulMarlin(),
    });
    expect(result.analysisReadiness.stages.marlin.status).toBe("ready");
    expect(hashReads).toBe(0);
  }, 180_000);
});
