import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { runPipeline } from "../runtime/pipeline/ingest.js";
import { computeNormalizedJsonHash } from "../runtime/artifacts/p1-manifest-coverage.js";
import { segmentAsset, type SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import { ingestAsset } from "../runtime/connectors/ffprobe.js";
import { buildGapReport } from "../runtime/pipeline/stages/gap-report.js";
import type { TranscribeFn } from "../runtime/connectors/stt-interface.js";
import type { VlmFn } from "../runtime/connectors/gemini-vlm.js";
import type { AppraiserFn } from "../runtime/pipeline/stages/appraiser.js";
import type { MarlinFn } from "../runtime/connectors/marlin-types.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  addSchema(schema: object): void;
  compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eye-070b1-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function makeAudio(dir: string, name: string, frequency = 440): string {
  const output = path.join(dir, name);
  execFileSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=0.6",
    "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=16000:duration=1.2`,
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=0.6",
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
    "-map", "[out]", output,
  ]);
  return output;
}

function makeVideo(dir: string): string {
  const output = path.join(dir, "clip.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=24:d=2.4",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=2.4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", output,
  ]);
  return output;
}

function makeSilentAudio(dir: string, name = "silent.wav"): string {
  const output = path.join(dir, name);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=2.4", output]);
  return output;
}

function expectStableClampedSegments(segments: SegmentItem[], durationUs: number): void {
  expect(segments.length).toBeGreaterThanOrEqual(1);
  for (const [index, segment] of segments.entries()) {
    expect(segment.src_in_us).toBeGreaterThanOrEqual(0);
    expect(segment.src_out_us).toBeLessThanOrEqual(durationUs);
    expect(segment.src_out_us).toBeGreaterThan(segment.src_in_us);
    expect(segment.duration_us).toBe(segment.src_out_us - segment.src_in_us);
    expect(segment.rep_frame_us).toBeGreaterThanOrEqual(segment.src_in_us);
    expect(segment.rep_frame_us).toBeLessThanOrEqual(segment.src_out_us);
    if (index > 0) expect(segment.src_in_us).toBeGreaterThanOrEqual(segments[index - 1].src_out_us);
  }
}

const transcribeFn: TranscribeFn = async () => ({
  utterances: [{ speaker: "speaker_0", start_us: 650_000, end_us: 1_650_000, text: "truthful audio transcript" }],
  language: "en",
});

function visualMocks() {
  const vlmFn = vi.fn<VlmFn>(async () => ({
    rawJson: JSON.stringify({
      summary: "blue frame",
      tags: ["blue"],
      interest_points: [],
      quality_flags: [],
      confidence: { summary: 0.8, tags: 0.8, quality_flags: 0.8 },
    }),
  }));
  const appraiserFn = vi.fn<AppraiserFn>(async () => ({
    visual_quality: { composition_score: 0.8, light_quality: 0.8, focus_sharpness: 0.8, subject_prominence: 0.8 },
    extracted_text: [],
    place_hint: { name: null, category: "unknown", confidence: 0, evidence: [] },
    aesthetic_notes: [],
  }));
  const marlinCaption = vi.fn(async () => ({ scene: "blue frame", events: [] }));
  const marlinFind = vi.fn(async (videoPath: string, query: string) => ({ query, span: null, format_ok: true }));
  const marlinFn: MarlinFn = { caption: marlinCaption, find: marlinFind };
  const visualQualityAnalyzeFn = vi.fn(async () => { throw new Error("visual probe sentinel"); });
  return { vlmFn, appraiserFn, marlinFn, marlinCaption, visualQualityAnalyzeFn };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function validateSchema(schemaName: string, value: unknown): void {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const common = readJson<object>(path.join(REPO_ROOT, "schemas/analysis-common.schema.json"));
  ajv.addSchema(common);
  const validate = ajv.compile(readJson<object>(path.join(REPO_ROOT, "schemas", schemaName)));
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

describe("EYE-070B1 audio analysis lane", () => {
  it("runs audio-only ingest through waveform, STT, audio events, and story graph without visual/model calls", async () => {
    const sourceDir = tempDir("audio-only-source");
    const projectDir = tempDir("audio-only-project");
    const voice = makeAudio(sourceDir, "voice.wav");
    const mocks = visualMocks();
    const result = await runPipeline({
      sourceFiles: [voice], projectDir, repoRoot: REPO_ROOT, transcribeFn,
      skipDiarize: true, vlmFn: mocks.vlmFn, appraiserFn: mocks.appraiserFn,
      marlinFn: mocks.marlinFn, visualQualityAnalyzeFn: mocks.visualQualityAnalyzeFn,
      skipBgmAnalysis: false,
    });

    expect(result.assetsJson.items).toHaveLength(1);
    const asset = result.assetsJson.items[0];
    expect(asset.video_stream).toBeUndefined();
    expect(asset.frame_rate_mode).toBe("audio_only");
    expect(asset.waveform_path).toMatch(/^waveforms\//);
    const waveformPath = path.join(projectDir, "03_analysis", asset.waveform_path!);
    expect(fs.existsSync(waveformPath)).toBe(true);
    expect(fs.statSync(waveformPath).size).toBeGreaterThan(0);
    expect(asset.poster_path).toBeUndefined();
    expect(asset.contact_sheet_ids).toEqual([]);
    expect(asset.has_transcript).toBe(true);
    expect(result.segmentsJson.items.length).toBeGreaterThanOrEqual(1);
    expectStableClampedSegments(result.segmentsJson.items, asset.duration_us);
    expect(result.segmentsJson.items.some((segment) => segment.transcript_excerpt.includes("truthful audio transcript"))).toBe(true);
    expect(result.gapReport.entries.some((entry) => /scene|poster|filmstrip|contact/i.test(entry.issue))).toBe(false);
    expect(mocks.vlmFn).not.toHaveBeenCalled();
    expect(mocks.appraiserFn).not.toHaveBeenCalled();
    expect(mocks.marlinCaption).not.toHaveBeenCalled();
    expect(mocks.visualQualityAnalyzeFn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(projectDir, "03_analysis/marlin_events.json"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/bgm_analysis.json"))).toBe(false);

    const artifacts = {
      assets: result.assetsJson,
      segments: result.segmentsJson,
      audioEvents: readJson<unknown>(path.join(projectDir, "03_analysis/audio_events.json")),
      graph: readJson<{ nodes: Array<{ asset_id: string }>; inputs: { coverage_report_hash: string } }>(path.join(projectDir, "03_analysis/audio_story_graph.json")),
      coverage: readJson<unknown>(path.join(projectDir, "03_analysis/analysis_coverage_report.json")),
    };
    validateSchema("assets.schema.json", artifacts.assets);
    validateSchema("segments.schema.json", artifacts.segments);
    validateSchema("audio-events.schema.json", artifacts.audioEvents);
    validateSchema("audio-story-graph.schema.json", artifacts.graph);
    validateSchema("analysis-coverage-report.schema.json", artifacts.coverage);
    expect((artifacts.audioEvents as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);
    expect(artifacts.graph.nodes.every((node) => node.asset_id === asset.asset_id)).toBe(true);
    expect(artifacts.graph.inputs.coverage_report_hash).toBe(computeNormalizedJsonHash(artifacts.coverage, ["created_at"]));
    const audioCoverage = (artifacts.coverage as { assets: Array<{ asset_id: string; status: string; lanes: Array<{ lane_id: string; status: string; reason?: string }> }> }).assets[0];
    expect(audioCoverage.status).toBe("ready");
    expect((artifacts.coverage as { blockers: Array<{ severity: string; message: string }> }).blockers)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("package-blocked") }),
      ]));
    expect(audioCoverage.lanes.filter((lane) => ["contact_sheets", "filmstrips", "vlm_tags", "vlm_peaks"].includes(lane.lane_id)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: "skipped", reason: "not_applicable_no_video_stream" })]));
  }, 120_000);

  it("keeps fully silent audio analysis-ready with deterministic segments, STT N/A, and a usable graph", async () => {
    const sourceDir = tempDir("fully-silent-source");
    const projectDir = tempDir("fully-silent-project");
    const silent = makeSilentAudio(sourceDir);
    const stt = vi.fn<TranscribeFn>(transcribeFn);
    const first = await runPipeline({
      sourceFiles: [silent], projectDir, repoRoot: REPO_ROOT, transcribeFn: stt,
      sttStrategy: "auto", skipDiarize: true, skipVlm: true, skipAppraiser: true,
      skipMarlin: true, skipPeak: true,
    });
    const firstSegments = structuredClone(first.segmentsJson);
    expectStableClampedSegments(first.segmentsJson.items, first.assetsJson.items[0].duration_us);
    validateSchema("segments.schema.json", first.segmentsJson);
    expect(stt).not.toHaveBeenCalled();
    const firstCoverage = readJson<{ lanes: Array<{ lane_id: string; status: string; reason: string | null }> }>(path.join(projectDir, "03_analysis/analysis_coverage_report.json"));
    expect(firstCoverage.lanes.find((lane) => lane.lane_id === "stt")).toMatchObject({ status: "skipped", reason: "not_applicable_silent_audio" });
    expect(firstCoverage.lanes.find((lane) => lane.lane_id === "audio_story_graph")?.status).toBe("ready");

    const second = await runPipeline({
      sourceFiles: [silent], projectDir, repoRoot: REPO_ROOT, transcribeFn: stt,
      sttStrategy: "auto", skipDiarize: true, skipVlm: true, skipAppraiser: true,
      skipMarlin: true, skipPeak: true,
    });
    expect(second.segmentsJson).toEqual(firstSegments);
    const secondCoverage = readJson<{ lanes: Array<{ lane_id: string; status: string; reason: string | null }> }>(path.join(projectDir, "03_analysis/analysis_coverage_report.json"));
    expect(secondCoverage.lanes.find((lane) => lane.lane_id === "stt")).toMatchObject({ status: "skipped", reason: "stt not attempted on cached run" });
  }, 120_000);

  it("does not mark an all-cached default STT run failed when no current transcript evidence exists", async () => {
    const sourceDir = tempDir("cached-no-stt-source");
    const projectDir = tempDir("cached-no-stt-project");
    const voice = makeAudio(sourceDir, "voice.wav");
    await runPipeline({
      sourceFiles: [voice], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipAppraiser: true, skipMarlin: true, skipPeak: true,
    });
    await runPipeline({
      sourceFiles: [voice], projectDir, repoRoot: REPO_ROOT,
      skipVlm: true, skipAppraiser: true, skipMarlin: true, skipPeak: true,
    });
    const coverage = readJson<{ lanes: Array<{ lane_id: string; status: string; reason: string | null }> }>(path.join(projectDir, "03_analysis/analysis_coverage_report.json"));
    expect(coverage.lanes.find((lane) => lane.lane_id === "stt")).toMatchObject({
      status: "skipped",
      reason: "stt not attempted on cached run",
    });
  }, 120_000);

  it("uses a bounded full-duration fallback when audio silencedetect fails", async () => {
    const sourceDir = tempDir("audio-fallback-source");
    const valid = makeAudio(sourceDir, "original.wav");
    const asset = await ingestAsset(valid);
    const missing = path.join(sourceDir, "private-source-name.wav");
    const first = await segmentAsset(missing, asset, {
      scene_threshold: 0.3, min_segment_duration_us: 750_000, merge_gap_us: 200_000,
      blackdetect_pic_th: 0.98, blackdetect_pix_th: 0.1, blackdetect_duration_s: 0.15,
      silencedetect_noise_db: -35, silencedetect_duration_s: 0.35,
      freezedetect_noise_db: -50, freezedetect_duration_s: 0.5,
    });
    const second = await segmentAsset(missing, asset, {
      scene_threshold: 0.3, min_segment_duration_us: 750_000, merge_gap_us: 200_000,
      blackdetect_pic_th: 0.98, blackdetect_pix_th: 0.1, blackdetect_duration_s: 0.15,
      silencedetect_noise_db: -35, silencedetect_duration_s: 0.35,
      freezedetect_noise_db: -50, freezedetect_duration_s: 0.5,
    });
    expect(first.detectorFailures).toEqual(["silencedetect: detector_failed"]);
    expect(first.segments).toEqual(second.segments);
    expect(first.segments).toHaveLength(1);
    expect(first.segments[0]).toMatchObject({
      src_in_us: 0, src_out_us: asset.duration_us,
      segment_type: "general",
      confidence: { boundary: { status: "partial" } },
      provenance: { boundary: { method: "duration_fallback_after_silencedetect_failure" } },
    });
    const segmentDoc = { project_id: "fallback", artifact_version: "2.0.0", items: first.segments };
    validateSchema("segments.schema.json", segmentDoc);
    const gap = buildGapReport(
      [asset], new Map([[asset.asset_id, first.segments]]), new Map(),
      new Map([[asset.asset_id, first.detectorFailures]]),
    );
    const serializedGap = JSON.stringify(gap);
    expect(gap.entries.find((entry) => entry.stage === "segment")).toMatchObject({
      severity: "warning",
      blocking: false,
      retriable: true,
      consumer_impact: "planning_warn",
    });
    expect(serializedGap).not.toContain(sourceDir);
    expect(serializedGap).not.toContain(path.basename(missing));
  }, 30_000);

  it("routes mixed projects through visual stages for video only and keeps both sources current", async () => {
    const sourceDir = tempDir("mixed-source");
    const projectDir = tempDir("mixed-project");
    const voice = makeAudio(sourceDir, "voice.wav");
    const video = makeVideo(sourceDir);
    const mocks = visualMocks();
    const result = await runPipeline({
      sourceFiles: [video, voice], projectDir, repoRoot: REPO_ROOT, transcribeFn,
      skipDiarize: true, vlmFn: mocks.vlmFn, appraiserFn: mocks.appraiserFn,
      marlinFn: mocks.marlinFn, skipPeak: true, skipBgmAnalysis: false,
    });
    expect(result.assetsJson.items).toHaveLength(2);
    expect(new Set(result.segmentsJson.items.map((segment) => segment.asset_id))).toEqual(new Set(result.assetsJson.items.map((asset) => asset.asset_id)));
    expect(result.sourceLedger?.summary.ready).toBe(2);
    expect(result.sourceMediaManifest?.items.filter((item) => item.ingest_status === "ready")).toHaveLength(2);
    expect(mocks.vlmFn).toHaveBeenCalled();
    expect(mocks.appraiserFn).toHaveBeenCalled();
    expect(mocks.marlinCaption).toHaveBeenCalledTimes(1);
    const coverage = readJson<{ assets: Array<{ asset_id: string; status: string; lanes: Array<{ asset_ids: string[] }> }> }>(path.join(projectDir, "03_analysis/analysis_coverage_report.json"));
    const videoAsset = result.assetsJson.items.find((asset) => asset.video_stream)!;
    expect(coverage.assets.find((asset) => asset.asset_id === videoAsset.asset_id)?.status).toBe("ready");
    expect(coverage.assets.every((asset) => asset.lanes.every((lane) => lane.asset_ids.every((id) => id === asset.asset_id)))).toBe(true);
  }, 120_000);

  it("reports mixed-project visual stage failures only for the video asset", async () => {
    const sourceDir = tempDir("mixed-visual-failure-source");
    const projectDir = tempDir("mixed-visual-failure-project");
    const voice = makeAudio(sourceDir, "voice.wav");
    const video = makeVideo(sourceDir);
    const failingVlm = vi.fn<VlmFn>(async () => { throw new Error("vlm sentinel"); });
    const result = await runPipeline({
      sourceFiles: [video, voice], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, vlmFn: failingVlm, skipAppraiser: true, skipMarlin: true, skipPeak: true,
    });
    const videoId = result.assetsJson.items.find((asset) => !!asset.video_stream)!.asset_id;
    const audioId = result.assetsJson.items.find((asset) => !asset.video_stream)!.asset_id;
    const coverage = readJson<{
      lanes: Array<{ lane_id: string; status: string; asset_ids: string[] }>;
      assets: Array<{ asset_id: string; lanes: Array<{ lane_id: string; status: string; asset_ids: string[]; reason: string | null }> }>;
    }>(path.join(projectDir, "03_analysis/analysis_coverage_report.json"));
    expect(coverage.lanes.find((lane) => lane.lane_id === "vlm_tags")).toMatchObject({ status: "failed", asset_ids: [] });
    expect(coverage.assets.find((asset) => asset.asset_id === videoId)?.lanes.find((lane) => lane.lane_id === "vlm_tags"))
      .toMatchObject({ status: "failed", asset_ids: [] });
    expect(coverage.assets.find((asset) => asset.asset_id === audioId)?.lanes.find((lane) => lane.lane_id === "vlm_tags"))
      .toMatchObject({ status: "skipped", asset_ids: [], reason: "not_applicable_no_video_stream" });
  }, 120_000);

  it("removes stale audio events, transcripts, graph nodes, BGM, and Marlin artifacts across source-set changes", async () => {
    const sourceDir = tempDir("freshness-source");
    const projectDir = tempDir("freshness-project");
    const audioA = makeAudio(sourceDir, "a.wav", 330);
    const audioB = makeAudio(sourceDir, "b.wav", 660);
    const video = makeVideo(sourceDir);
    const mocks = visualMocks();
    await runPipeline({
      sourceFiles: [video, audioA, audioB], projectDir, repoRoot: REPO_ROOT, transcribeFn,
      skipDiarize: true, marlinFn: mocks.marlinFn, skipVlm: true, skipAppraiser: true, skipPeak: true,
      bgmSourceFiles: [audioB],
    });
    expect(fs.existsSync(path.join(projectDir, "03_analysis/marlin_events.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/bgm_analysis.json"))).toBe(true);
    const firstAssets = readJson<{ items: Array<{ asset_id: string; filename: string }> }>(path.join(projectDir, "03_analysis/assets.json"));
    const removedIds = new Set(firstAssets.items.filter((asset) => asset.filename !== "a.wav").map((asset) => asset.asset_id));

    const cached = await runPipeline({
      sourceFiles: [audioA], projectDir, repoRoot: REPO_ROOT, transcribeFn,
      skipDiarize: true, marlinFn: mocks.marlinFn, skipVlm: true, skipAppraiser: true, skipPeak: true,
      bgmSourceFiles: [],
    });
    const currentArtifacts = [
      readJson<{ items: Array<{ asset_id: string }> }>(path.join(projectDir, "03_analysis/segments.json")).items,
      readJson<{ items: Array<{ asset_id: string }> }>(path.join(projectDir, "03_analysis/audio_events.json")).items,
      readJson<{ nodes: Array<{ asset_id: string }> }>(path.join(projectDir, "03_analysis/audio_story_graph.json")).nodes,
    ];
    expect(currentArtifacts.flat().every((item) => !removedIds.has(item.asset_id))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/bgm_analysis.json"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/marlin_events.json"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/marlin_rollback.json"))).toBe(false);
    const currentId = cached.assetsJson.items[0].asset_id;
    const cachedEvents = readJson<{ items: Array<{ asset_id: string }> }>(path.join(projectDir, "03_analysis/audio_events.json"));
    const cachedGraph = readJson<{ nodes: Array<{ asset_id: string }>; inputs: { coverage_report_hash: string } }>(path.join(projectDir, "03_analysis/audio_story_graph.json"));
    const cachedCoverage = readJson<unknown>(path.join(projectDir, "03_analysis/analysis_coverage_report.json"));
    expect(cachedEvents.items.every((item) => item.asset_id === currentId)).toBe(true);
    expect(cachedGraph.nodes.every((node) => node.asset_id === currentId)).toBe(true);
    expect(cachedGraph.inputs.coverage_report_hash).toBe(computeNormalizedJsonHash(cachedCoverage, ["created_at"]));
  }, 120_000);

  it("treats explicit skipStt and skipBgm as neutral N/A in normal and all-cached runs", async () => {
    const sourceDir = tempDir("explicit-skip-source");
    const projectDir = tempDir("explicit-skip-project");
    const voice = makeAudio(sourceDir, "voice.wav");
    await runPipeline({
      sourceFiles: [voice], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipAppraiser: true, skipMarlin: true, skipPeak: true,
      bgmSourceFiles: [voice],
    });
    expect(fs.existsSync(path.join(projectDir, "03_analysis/bgm_analysis.json"))).toBe(true);
    for (let run = 0; run < 2; run++) {
      await runPipeline({
        sourceFiles: [voice], projectDir, repoRoot: REPO_ROOT,
        skipStt: true, skipVlm: true, skipAppraiser: true, skipMarlin: true, skipPeak: true,
        skipBgmAnalysis: true, bgmSourceFiles: [voice],
        noCache: run === 0,
      });
      const coverage = readJson<{ lanes: Array<{ lane_id: string; status: string; reason: string | null; consumer_impact: string }>; assets: Array<{ lanes: Array<{ lane_id: string; status: string }> }> }>(path.join(projectDir, "03_analysis/analysis_coverage_report.json"));
      expect(coverage.lanes.find((lane) => lane.lane_id === "stt")).toMatchObject({ status: "skipped", reason: "stt skipped by request" });
      expect(coverage.lanes.find((lane) => lane.lane_id === "bgm_analysis")).toMatchObject({ status: "skipped", reason: "bgm analysis skipped by request", consumer_impact: "none" });
      expect(coverage.assets[0].lanes.find((lane) => lane.lane_id === "bgm_analysis")?.status).toBe("skipped");
      expect(fs.existsSync(path.join(projectDir, "03_analysis/bgm_analysis.json"))).toBe(false);
      const graph = readJson<{ nodes: Array<{ node_type: string }>; coverage: { status: string; missing_inputs: string[] } }>(path.join(projectDir, "03_analysis/audio_story_graph.json"));
      expect(graph.coverage.status).toBe("ready");
      expect(graph.coverage.missing_inputs).toEqual([]);
      expect(graph.nodes.filter((node) => node.node_type === "music_section")).toHaveLength(0);
    }
  }, 120_000);

  it("does not publish a last-wins BGM artifact for multiple explicit sources", async () => {
    const sourceDir = tempDir("multi-bgm-source");
    const projectDir = tempDir("multi-bgm-project");
    const first = makeAudio(sourceDir, "first.wav", 220);
    const second = makeAudio(sourceDir, "second.wav", 440);
    await runPipeline({
      sourceFiles: [first, second], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipAppraiser: true, skipMarlin: true, skipPeak: true,
      bgmSourceFiles: [first, second],
    });
    expect(fs.existsSync(path.join(projectDir, "03_analysis/bgm_analysis.json"))).toBe(false);
    const coverage = readJson<{ lanes: Array<{ lane_id: string; status: string; asset_ids: string[] }> }>(path.join(projectDir, "03_analysis/analysis_coverage_report.json"));
    expect(coverage.lanes.find((lane) => lane.lane_id === "bgm_analysis")).toMatchObject({ status: "failed", asset_ids: [] });
  }, 120_000);

  it("accounts for an unmatched explicit BGM request without exposing its path", async () => {
    const sourceDir = tempDir("unmatched-bgm-source");
    const projectDir = tempDir("unmatched-bgm-project");
    const voice = makeAudio(sourceDir, "voice.wav");
    const unmatched = path.join(sourceDir, "private-unmatched-bgm.wav");
    await runPipeline({
      sourceFiles: [voice], projectDir, repoRoot: REPO_ROOT,
      skipStt: true, skipVlm: true, skipAppraiser: true, skipMarlin: true, skipPeak: true,
      bgmSourceFiles: [unmatched],
    });
    const coverageText = fs.readFileSync(path.join(projectDir, "03_analysis/analysis_coverage_report.json"), "utf-8");
    const coverage = JSON.parse(coverageText) as { lanes: Array<{ lane_id: string; status: string; reason: string | null }> };
    expect(coverage.lanes.find((lane) => lane.lane_id === "bgm_analysis")).toMatchObject({
      status: "failed",
      reason: "one or more explicit BGM requests did not match the current source set",
    });
    expect(coverageText).not.toContain(unmatched);
    expect(coverageText).not.toContain(path.basename(unmatched));
  }, 120_000);
});
