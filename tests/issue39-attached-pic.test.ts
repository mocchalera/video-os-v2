import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { extractFrameRateMode, extractTemporalVideoStream, extractVideoStream, ingestAsset } from "../runtime/connectors/ffprobe.js";
import { compile } from "../runtime/compiler/index.js";
import { runPipeline } from "../runtime/pipeline/ingest.js";
import { hasTemporalVideo, readAssetMediaCapabilities } from "../runtime/artifacts/source-media-capabilities.js";
import { materializePeakSignalsFromSegments } from "../runtime/artifacts/peak-materialization.js";
import { applyMarlinEventsToSegments, loadMarlinAssetInputs } from "../runtime/pipeline/stages/marlin.js";
import { clearNonTemporalVisualPeakAnalysis, degradedPeakMap } from "../runtime/pipeline/stages/peak.js";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { MarlinEventsArtifact } from "../runtime/connectors/marlin-types.js";
import type { TranscribeFn } from "../runtime/connectors/stt-interface.js";
import type { VlmFn } from "../runtime/connectors/gemini-vlm.js";
import type { AppraiserFn } from "../runtime/pipeline/stages/appraiser.js";
import type { MarlinFn } from "../runtime/connectors/marlin-types.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `issue39-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function makeAttachedPicMp3(dir: string): string {
  const cover = path.join(dir, "cover.png");
  const output = path.join(dir, "voice-with-cover.mp3");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1",
    "-frames:v", "1", cover,
  ]);
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=2.4",
    "-i", cover,
    "-map", "0:a:0", "-map", "1:v:0",
    "-c:a", "libmp3lame", "-q:a", "6",
    "-c:v", "mjpeg",
    "-disposition:v:0", "attached_pic",
    "-id3v2_version", "3",
    "-metadata:s:v:0", "title=Album cover",
    "-metadata:s:v:0", "comment=Cover (front)",
    output,
  ]);
  return output;
}

function makePlainMp3(dir: string): string {
  const output = path.join(dir, "voice-without-cover.mp3");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=2.4",
    "-c:a", "libmp3lame", "-q:a", "6",
    output,
  ]);
  return output;
}

function stalePeakAnalysis() {
  return {
    peak_moments: [{
      peak_ref: "STALE_MIDPOINT",
      timestamp_us: 1_200_000,
      type: "action_peak",
      confidence: 0.9,
      description: "stale midpoint action peak",
      source_pass: "degraded_ffmpeg_signals",
    }],
    recommended_in_out: {
      best_in_us: 900_000,
      best_out_us: 1_500_000,
      rationale: "stale midpoint",
      source_pass: "degraded_ffmpeg_signals",
    },
    visual_energy_curve: [],
    support_signals: {
      motion_support_score: 0.9,
      audio_support_score: 0,
      fused_peak_score: 0.9,
    },
    provenance: {
      coarse_prompt_template_id: "stale",
      refine_prompt_template_id: "stale",
      precision_mode: "never",
      fusion_version: "stale",
      support_signal_version: "stale",
    },
  };
}

function temporalAsset(assetId: string, withAudio = false): AssetItem {
  return {
    asset_id: assetId,
    filename: `${assetId}.mp4`,
    media_kind: "video",
    duration_us: 4_000_000,
    has_transcript: false,
    transcript_ref: null,
    segments: 1,
    segment_ids: [`SEG_${assetId}`],
    quality_flags: [],
    tags: [],
    source_fingerprint: "fixture",
    contact_sheet_ids: [],
    analysis_status: "pending",
    video_stream: { width: 1280, height: 720, fps_num: 24, fps_den: 1, codec: "h264" },
    ...(withAudio ? { audio_stream: { sample_rate: 48_000, channels: 2, codec: "aac" } } : {}),
    source_capabilities: {
      has_video: true,
      has_audio: withAudio,
      has_temporal_video: true,
    },
  };
}

function temporalSegment(assetId: string, options: { measuredMotion?: boolean; audioText?: string } = {}): SegmentItem {
  return {
    segment_id: `SEG_${assetId}`,
    asset_id: assetId,
    src_in_us: 0,
    src_out_us: 4_000_000,
    duration_us: 4_000_000,
    rep_frame_us: 2_000_000,
    summary: options.audioText ?? "",
    transcript_excerpt: options.audioText ?? "",
    quality_flags: [],
    tags: [],
    segment_type: "action",
    transcript_ref: null,
    confidence: { boundary: { score: 0.99, source: "test", status: "ready" } },
    provenance: {
      boundary: {
        stage: "segment",
        method: "test",
        connector_version: "test",
        policy_hash: "test",
        request_hash: "test",
      },
    },
    ...(options.measuredMotion ? {
      visual_quality_measurements: {
        measured: false,
        connector_version: "ffmpeg-motion-test",
        method: "ffmpeg_sampled_signals" as const,
        sample_fps: 2,
        max_width: 160,
        duration_us: 4_000_000,
        metrics_measured: { shake: true, sharpness: false, exposure: false },
        shake: {
          measured: true as const,
          score: 0.6,
          sample_count: 4,
          bins: [
            { start_us: 0, end_us: 1_000_000, energy: 0.1 },
            { start_us: 1_000_000, end_us: 2_000_000, energy: 0.9 },
            { start_us: 2_000_000, end_us: 3_000_000, energy: 0.2 },
            { start_us: 3_000_000, end_us: 4_000_000, energy: 0.1 },
          ],
          average_energy: 0.325,
          peak_energy: 0.9,
          peak_timestamp_us: 1_500_000,
        },
      },
    } : {}),
  };
}

const transcribeFn: TranscribeFn = async () => ({
  utterances: [{ speaker: "speaker_0", start_us: 300_000, end_us: 1_300_000, text: "audio remains analyzable" }],
  language: "en",
});

function visualMocks() {
  const vlmFn = vi.fn<VlmFn>(async () => ({ rawJson: JSON.stringify({ summary: "unexpected visual call" }) }));
  const appraiserFn = vi.fn<AppraiserFn>(async () => ({
    visual_quality: { composition_score: 0.8, light_quality: 0.8, focus_sharpness: 0.8, subject_prominence: 0.8 },
    extracted_text: [],
    place_hint: { name: null, category: "unknown", confidence: 0, evidence: [] },
    aesthetic_notes: [],
  }));
  const marlinCaption = vi.fn(async () => ({ scene: "unexpected visual call", events: [] }));
  const marlinFind = vi.fn(async (videoPath: string, query: string) => ({ query, span: null, format_ok: true }));
  const marlinFn: MarlinFn = { caption: marlinCaption, find: marlinFind };
  const visualQualityAnalyzeFn = vi.fn(async () => { throw new Error("unexpected visual call"); });
  return { vlmFn, appraiserFn, marlinFn, marlinCaption, visualQualityAnalyzeFn };
}

describe("Issue #39 M1 attached picture source capability", () => {
  it("classifies attached_pic as non-temporal while retaining any-video metadata", () => {
    const probe = {
      streams: [
        {
          index: 0, codec_type: "audio", codec_name: "mp3", sample_rate: "16000", channels: 1,
        },
        {
          index: 1, codec_type: "video", codec_name: "mjpeg", width: 64, height: 64,
          avg_frame_rate: "90000/1", r_frame_rate: "90000/1", disposition: { attached_pic: 1 },
        },
      ],
      format: { filename: "voice-with-cover.mp3", duration: "2.4" },
    };

    expect(extractVideoStream(probe)).toBeDefined();
    expect(extractTemporalVideoStream(probe)).toBeUndefined();
    expect(extractFrameRateMode(probe)).toBe("audio_only");
  });

  it("keeps STT and audio events but does not launch visual consumers for an MP3 cover", async () => {
    const sourceDir = tempDir("source");
    const projectDir = tempDir("project");
    const source = makeAttachedPicMp3(sourceDir);
    const mocks = visualMocks();

    const result = await runPipeline({
      sourceFiles: [source],
      projectDir,
      repoRoot: REPO_ROOT,
      transcribeFn,
      skipDiarize: true,
      vlmFn: mocks.vlmFn,
      appraiserFn: mocks.appraiserFn,
      marlinFn: mocks.marlinFn,
      visualQualityAnalyzeFn: mocks.visualQualityAnalyzeFn,
      skipBgmAnalysis: true,
    });

    const asset = result.assetsJson.items[0];
    expect(asset).toBeDefined();
    expect(asset.source_capabilities).toEqual({
      has_video: true,
      has_audio: true,
      has_temporal_video: false,
    });
    expect(asset.video_stream).toBeDefined();
    expect(asset.frame_rate_mode).toBe("audio_only");
    expect(asset.contact_sheet_ids).toEqual([]);
    expect(asset.poster_path).toBeUndefined();
    expect(result.segmentsJson.items).toHaveLength(1);
    expect(result.segmentsJson.items.every((item) => item.peak_analysis === undefined)).toBe(true);
    expect(result.segmentsJson.items.flatMap((item) => item.peak_analysis?.peak_moments ?? [])).toEqual([]);
    expect(result.segmentsJson.items[0].filmstrip_path).toBeUndefined();
    expect(asset.has_transcript).toBe(true);
    expect(mocks.vlmFn).not.toHaveBeenCalled();
    expect(mocks.appraiserFn).not.toHaveBeenCalled();
    expect(mocks.marlinCaption).not.toHaveBeenCalled();
    expect(mocks.visualQualityAnalyzeFn).not.toHaveBeenCalled();
    expect(result.gapReport.entries.some((entry) => /contact|poster|filmstrip/i.test(entry.issue))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/marlin_events.json"))).toBe(false);

    const audioEvents = JSON.parse(fs.readFileSync(
      path.join(projectDir, "03_analysis/audio_events.json"),
      "utf-8",
    )) as { items: Array<{ asset_id: string }> };
    expect(audioEvents).toHaveProperty("items");
    const coverage = JSON.parse(fs.readFileSync(
      path.join(projectDir, "03_analysis/analysis_coverage_report.json"),
      "utf-8",
    )) as { assets: Array<{ asset_id: string; lanes: Array<{ lane_id: string; status: string; asset_ids: string[] }> }> };
    const visualCoverage = coverage.assets[0]?.lanes
      .filter((lane) => ["contact_sheets", "filmstrips", "visual_quality", "vlm_tags", "vlm_peaks"].includes(lane.lane_id));
    expect(visualCoverage).toHaveLength(5);
    expect(visualCoverage?.every((lane) => lane.status === "skipped" && lane.asset_ids.length === 0)).toBe(true);
    expect(coverage.assets[0]?.lanes.find((lane) => lane.lane_id === "audio_events"))
      .toMatchObject({ status: "ready", asset_ids: [asset.asset_id] });
    expect(asset.waveform_path).toMatch(/^waveforms\//);
    expect(readAssetMediaCapabilities(projectDir).get(asset.asset_id)?.source_capabilities)
      .toEqual({ has_video: false, has_audio: true });
  }, 120_000);

  it("keeps a plain MP3 out of visual peak production as a negative control", async () => {
    const sourceDir = tempDir("plain-source");
    const projectDir = tempDir("plain-project");
    const source = makePlainMp3(sourceDir);
    const mocks = visualMocks();

    const result = await runPipeline({
      sourceFiles: [source],
      projectDir,
      repoRoot: REPO_ROOT,
      transcribeFn,
      skipDiarize: true,
      vlmFn: mocks.vlmFn,
      appraiserFn: mocks.appraiserFn,
      marlinFn: mocks.marlinFn,
      visualQualityAnalyzeFn: mocks.visualQualityAnalyzeFn,
      skipBgmAnalysis: true,
    });

    const asset = result.assetsJson.items[0];
    expect(asset.source_capabilities).toEqual({
      has_video: false,
      has_audio: true,
      has_temporal_video: false,
    });
    expect(asset.video_stream).toBeUndefined();
    expect(result.segmentsJson.items).not.toHaveLength(0);
    expect(result.segmentsJson.items.every((item) => item.peak_analysis === undefined)).toBe(true);
    expect(result.segmentsJson.items.flatMap((item) => item.peak_analysis?.peak_moments ?? [])).toEqual([]);
    expect(mocks.vlmFn).not.toHaveBeenCalled();
    expect(mocks.appraiserFn).not.toHaveBeenCalled();
    expect(mocks.marlinCaption).not.toHaveBeenCalled();
    expect(mocks.visualQualityAnalyzeFn).not.toHaveBeenCalled();
  }, 120_000);

  it("scrubs audio-only stale peaks from Marlin and candidate materialization paths", async () => {
    const sourceDir = tempDir("stale-source");
    const projectDir = tempDir("stale-project");
    const source = makeAttachedPicMp3(sourceDir);
    const result = await runPipeline({
      sourceFiles: [source],
      projectDir,
      repoRoot: REPO_ROOT,
      transcribeFn,
      skipDiarize: true,
      skipVlm: true,
      skipMarlin: true,
      skipPeak: true,
      skipBgmAnalysis: true,
    });
    const asset = result.assetsJson.items[0];
    const segment = result.segmentsJson.items[0];
    const assetsPath = path.join(projectDir, "03_analysis/assets.json");
    const storedAssets = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as {
      items: Array<Record<string, unknown>>;
    };
    delete storedAssets.items[0].source_capabilities;
    fs.writeFileSync(assetsPath, JSON.stringify(storedAssets, null, 2));
    const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
    const staleSegments = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
      items: Array<Record<string, unknown>>;
    };
    staleSegments.items[0].peak_analysis = stalePeakAnalysis();
    fs.writeFileSync(segmentsPath, JSON.stringify(staleSegments, null, 2));

    const marlinArtifact: MarlinEventsArtifact = {
      project_id: result.assetsJson.project_id,
      artifact_version: "marlin-events-v1",
      model: {
        provider: "marlin",
        model_alias: "test-marlin",
        model_snapshot: "test-snapshot",
        connector_version: "test",
        inference_mode: "mock",
      },
      items: [{
        asset_id: asset.asset_id,
        source_path: source,
        scene: "A scene that must not create a visual peak for audio-only media.",
        events: [{
          event_id: "MEV_AUDIO_ONLY",
          start_us: 500_000,
          end_us: 1_000_000,
          description: "audio-only event",
          confidence: 0.9,
          source_pass: "marlin_caption",
        }],
        find_results: [],
      }],
    };
    expect(applyMarlinEventsToSegments(projectDir, marlinArtifact)).toBe(true);
    const scrubbed = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
      items: Array<{ peak_analysis?: unknown }>;
    };
    expect(scrubbed.items[0].peak_analysis).toBeUndefined();

    const staleAgain = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
      items: Array<Record<string, unknown>>;
    };
    staleAgain.items[0].peak_analysis = stalePeakAnalysis();
    fs.writeFileSync(segmentsPath, JSON.stringify(staleAgain, null, 2));
    const candidate = {
      segment_id: segment.segment_id,
      asset_id: asset.asset_id,
      src_in_us: segment.src_in_us,
      src_out_us: segment.src_out_us,
      confidence: 0.9,
      peak_signals: { motion: 0.9, audio_rms: 0 },
      editorial_signals: {
        peak_ref: "STALE_MIDPOINT",
        peak_type: "action_peak" as const,
        peak_strength_score: 0.9,
      },
      trim_hint: {
        source_center_us: 1_200_000,
        peak_ref: "STALE_MIDPOINT",
        peak_type: "action_peak" as const,
        center_source: "interest_point_fallback" as const,
      },
    };
    expect(materializePeakSignalsFromSegments(projectDir, { candidates: [candidate] })).toBe(true);
    expect(candidate.peak_signals).toBeUndefined();
    expect(candidate.editorial_signals).toBeUndefined();
    expect(candidate.trim_hint).toBeUndefined();
  }, 120_000);

  it("lets explicit audio override stale temporal metadata at every peak boundary", async () => {
    const sourceDir = tempDir("stale-metadata-source");
    const projectDir = tempDir("stale-metadata-project");
    const source = makeAttachedPicMp3(sourceDir);
    const asset = temporalAsset("AST_STALE_AUDIO", true);
    asset.media_kind = "audio";
    asset.source_capabilities = {
      has_video: true,
      has_audio: true,
      has_temporal_video: true,
    };
    const segment = temporalSegment(asset.asset_id, { measuredMotion: true });

    expect(hasTemporalVideo(asset)).toBe(false);
    expect(await degradedPeakMap(
      { project_id: "m3", artifact_version: "2.0.0", items: [asset] },
      { project_id: "m3", artifact_version: "2.0.0", items: [segment] },
      new Map([[asset.asset_id, source]]),
    )).toEqual([]);

    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), JSON.stringify({
      project_id: "m3",
      artifact_version: "2.0.0",
      items: [asset],
    }));
    expect(loadMarlinAssetInputs(projectDir, [source])).toEqual([]);

    const segments = {
      project_id: "m3",
      artifact_version: "2.0.0",
      items: [{ ...segment, peak_analysis: stalePeakAnalysis() }],
    };
    expect(clearNonTemporalVisualPeakAnalysis(
      { project_id: "m3", artifact_version: "2.0.0", items: [asset] },
      segments,
    )).toBe(1);
    expect(segments.items[0].peak_analysis).toBeUndefined();
  }, 120_000);

  it("retains a degraded peak for temporal video only with measured motion support", async () => {
    const asset = temporalAsset("AST_MEASURED_MOTION");
    const segment = temporalSegment(asset.asset_id, { measuredMotion: true });
    const shards = await degradedPeakMap(
      { project_id: "m3", artifact_version: "2.0.0", items: [asset] },
      { project_id: "m3", artifact_version: "2.0.0", items: [segment] },
      new Map(),
    );

    expect(shards).toHaveLength(1);
    expect(shards[0].peak_analysis?.peak_moments[0]).toMatchObject({
      timestamp_us: 1_500_000,
      type: "action_peak",
      source_pass: "degraded_ffmpeg_signals",
    });
    expect(shards[0].peak_analysis?.peak_moments[0].timestamp_us).not.toBe(segment.rep_frame_us);
    expect(shards[0].peak_analysis?.support_signals).toMatchObject({
      motion_support_score: 1,
      motion_support_measured: true,
      audio_support_score: 0,
    });
  });

  it("rejects uniform neutral motion instead of normalizing it into a peak", async () => {
    const asset = temporalAsset("AST_UNIFORM_MOTION");
    const segment = temporalSegment(asset.asset_id, { measuredMotion: true });
    const shake = segment.visual_quality_measurements!.shake!;
    shake.bins = shake.bins.map((bin) => ({ ...bin, energy: 0.5 }));
    shake.peak_energy = 0.5;
    shake.peak_timestamp_us = 2_000_000;

    const shards = await degradedPeakMap(
      { project_id: "m3", artifact_version: "2.0.0", items: [asset] },
      { project_id: "m3", artifact_version: "2.0.0", items: [segment] },
      new Map(),
    );

    expect(shards).toEqual([]);
  });

  it("accepts measured audio support only when it includes a local timestamp", async () => {
    const asset = temporalAsset("AST_MEASURED_AUDIO", true);
    const segment = temporalSegment(asset.asset_id);
    const measured = await degradedPeakMap(
      { project_id: "m3", artifact_version: "2.0.0", items: [asset] },
      { project_id: "m3", artifact_version: "2.0.0", items: [segment] },
      new Map([[asset.asset_id, "fixture.mp4"]]),
      { estimateAudioRms: async () => ({ score: 0.8, timestamp_us: 1_250_000 }) },
    );
    expect(measured[0].peak_analysis?.peak_moments[0]).toMatchObject({
      timestamp_us: 1_250_000,
      type: "emotional_peak",
    });
    expect(measured[0].peak_analysis?.peak_moments[0].timestamp_us).not.toBe(segment.rep_frame_us);

    const unlocalized = await degradedPeakMap(
      { project_id: "m3", artifact_version: "2.0.0", items: [asset] },
      { project_id: "m3", artifact_version: "2.0.0", items: [segment] },
      new Map([[asset.asset_id, "fixture.mp4"]]),
      { estimateAudioRms: async () => 0.8 },
    );
    expect(unlocalized).toEqual([]);

    const outOfRange = await degradedPeakMap(
      { project_id: "m3", artifact_version: "2.0.0", items: [asset] },
      { project_id: "m3", artifact_version: "2.0.0", items: [segment] },
      new Map([[asset.asset_id, "fixture.mp4"]]),
      { estimateAudioRms: async () => ({ score: 0.8, timestamp_us: -500_000 }) },
    );
    expect(outOfRange).toEqual([]);
  });

  it("does not turn boundary confidence or speech text into a zero-support temporal peak", async () => {
    const asset = temporalAsset("AST_ZERO_SUPPORT");
    const segment = temporalSegment(asset.asset_id, { audioText: "child bicycle success" });
    const shards = await degradedPeakMap(
      { project_id: "m3", artifact_version: "2.0.0", items: [asset] },
      { project_id: "m3", artifact_version: "2.0.0", items: [segment] },
      new Map(),
    );

    expect(shards).toEqual([]);
  });

  it("defaults an aspect-unspecified cover-art MP3 compile to 16:9", async () => {
    const sourceDir = tempDir("compile-source");
    const projectDir = tempDir("compile-project");
    const source = makeAttachedPicMp3(sourceDir);

    const result = await runPipeline({
      sourceFiles: [source],
      projectDir,
      projectId: "sample-mountain-reset",
      repoRoot: REPO_ROOT,
      transcribeFn,
      skipDiarize: true,
      skipVlm: true,
      skipMarlin: true,
      skipPeak: true,
      skipBgmAnalysis: true,
    });
    const asset = result.assetsJson.items[0];
    const segment = result.segmentsJson.items[0];
    expect(asset).toBeDefined();
    expect(segment).toBeDefined();

    fs.mkdirSync(path.join(projectDir, "01_intent"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });
    const brief = parseYaml(fs.readFileSync(
      path.join(REPO_ROOT, "projects/sample/01_intent/creative_brief.yaml"),
      "utf-8",
    )) as Record<string, unknown>;
    delete (brief.editorial as Record<string, unknown> | undefined)?.aspect_ratio;
    fs.writeFileSync(path.join(projectDir, "01_intent/creative_brief.yaml"), stringifyYaml(brief));

    const candidate = {
      candidate_id: "C_COVER_AUDIO",
      segment_id: segment!.segment_id,
      asset_id: asset!.asset_id,
      src_in_us: segment!.src_in_us,
      src_out_us: segment!.src_out_us,
      role: "dialogue",
      why_it_matches: "Cover-art MP3 remains grounded audio material.",
      risks: [],
      confidence: 0.9,
      quality_flags: [],
      evidence: ["transcript"],
      eligible_beats: ["b01"],
      transcript_excerpt: "audio remains analyzable",
      motif_tags: ["dialogue"],
      // Deliberately stale visual metadata: compiler must project the
      // authoritative audio capability from assets.json before filtering.
      media_kind: "video",
      source_capabilities: { has_video: true, has_audio: true },
    };
    fs.writeFileSync(path.join(projectDir, "04_plan/selects_candidates.yaml"), stringifyYaml({
      version: "1",
      project_id: "sample-mountain-reset",
      analysis_artifact_version: "analysis-v1",
      source_media: { mode: "audio_only", media_kinds: ["audio"], visual_candidate_count: 0, audio_only_candidate_count: 1 },
      candidates: [candidate],
    }));
    fs.writeFileSync(path.join(projectDir, "04_plan/edit_blueprint.yaml"), stringifyYaml({
      version: "1",
      project_id: "sample-mountain-reset",
      sequence_goals: ["Build a grounded audio story."],
      beats: [{
        id: "b01",
        label: "audio story",
        target_duration_frames: 72,
        required_roles: ["dialogue"],
        candidate_plan: { primary_candidate_ref: "C_COVER_AUDIO" },
        craft: { rhythm: "steady" },
      }],
      pacing: { opening_cadence: "steady", middle_cadence: "steady", ending_cadence: "breath" },
      music_policy: { start_sparse: false, allow_release_late: false },
      dialogue_policy: { preserve_natural_breath: false, avoid_wall_to_wall_voiceover: false },
      transition_policy: { prefer_match_texture_over_flashy_fx: true, allow_hard_cuts: true, avoid_speed_ramps: true },
      ending_policy: { should_feel: "resolved", final_audio_strategy: "fade grounded audio", tail_hold_sec: 0.5, audio_fade_out_sec: 0.5, video_fade_out_sec: 0 },
      rejection_rules: ["Reject ungrounded audio."],
      duration_policy: { mode: "guide", source: "explicit_brief", target_source: "explicit_brief", target_duration_sec: segment!.duration_us / 1_000_000, min_duration_sec: 0, max_duration_sec: null, hard_gate: false, protect_vlm_peaks: false },
      timeline_order: "editorial",
      track_layout: "single",
      active_editing_skills: ["human_golden_order"],
    }));

    const compiled = compile({
      projectPath: projectDir,
      repoRoot: REPO_ROOT,
      createdAt: "2026-08-31T00:00:00Z",
    });
    expect(compiled.timeline.sequence.width).toBe(1920);
    expect(compiled.timeline.sequence.height).toBe(1080);
    expect(compiled.timeline.sequence.output_aspect_ratio).toBe("16:9");
  }, 120_000);
});
