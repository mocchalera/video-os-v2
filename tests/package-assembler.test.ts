import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { computeFileHash, reconcile } from "../runtime/state/reconcile.js";
import {
  createSourceInputAttestation,
  writeRenderFreshnessMetadata,
} from "../runtime/render/source-input-attestation.js";

const { assembleMock, renderMock, measureQaMediaMock, matchingVideoFrame } = vi.hoisted(() => ({
  assembleMock: vi.fn(),
  renderMock: vi.fn(),
  measureQaMediaMock: vi.fn(),
  matchingVideoFrame: {
    width: 1920,
    height: 1080,
    sar: "1:1",
    dar: "16:9",
    fps_num: 24,
    fps_den: 1,
    fps: 24,
  },
}));

vi.mock("../runtime/render/assembler.js", () => ({
  assembleTimelineToMp4: assembleMock,
}));

vi.mock("../runtime/render/pipeline.js", () => ({
  runRenderPipeline: renderMock,
}));

vi.mock("../runtime/packaging/qa-measure.js", () => ({
  measureQaMedia: measureQaMediaMock,
  buildQaMeasurementsFromPrecomputed: vi.fn((metrics: {
    integratedLufs?: number;
    truePeakDbtp?: number;
    videoDurationMs?: number;
    audioDurationMs?: number;
    dialogueWindowMs?: number;
    observedNonSilentMs?: number;
    videoFrame?: typeof matchingVideoFrame;
    deterministicOutputQA?: {
      status: "verified";
      duration_sec: number;
      scanned_duration_sec: number;
      width: number;
      height: number;
      issues: [];
    };
  }) => ({
    version: "1.0.0",
    measured_at: "2026-03-21T12:00:00.000Z",
    measurement_source: "precomputed",
    video_duration_ms: metrics.videoDurationMs ?? 0,
    audio_duration_ms: metrics.audioDurationMs ?? 0,
    dialogue_window_ms: metrics.dialogueWindowMs ?? metrics.audioDurationMs ?? 0,
    av_drift_ms: Math.abs((metrics.videoDurationMs ?? 0) - (metrics.audioDurationMs ?? 0)),
    loudness_integrated: metrics.integratedLufs ?? 0,
    loudness_true_peak: metrics.truePeakDbtp ?? 0,
    dialogue_occupancy: metrics.dialogueWindowMs
      ? (metrics.observedNonSilentMs ?? 0) / metrics.dialogueWindowMs
      : 0,
    observed_non_silent_ms: metrics.observedNonSilentMs ?? 0,
    silence_total_ms: metrics.dialogueWindowMs && metrics.observedNonSilentMs != null
      ? Math.max(0, metrics.dialogueWindowMs - metrics.observedNonSilentMs)
      : 0,
    video_frame: metrics.videoFrame,
    deterministic_output_qa: metrics.deterministicOutputQA ?? {
      status: "verified",
      duration_sec: (metrics.videoDurationMs ?? 0) / 1000,
      scanned_duration_sec: (metrics.videoDurationMs ?? 0) / 1000,
      width: metrics.videoFrame?.width,
      height: metrics.videoFrame?.height,
      issues: [],
    },
  })),
  writeQaMeasurements: vi.fn(),
  collectQaMeasurementWarnings: vi.fn(() => []),
}));

import { packageCommand } from "../runtime/commands/package.js";
import {
  resolveProjectRenderRoute,
  writeRenderRouteReceipt,
  type RenderRouteDecision,
} from "../runtime/render/route-resolver.js";
import { HYPERFRAMES_RENDERER_VERSION } from "../runtime/content/hyperframes-renderer.js";
import { REMOTION_RENDERER_VERSION } from "../runtime/render/remotion/render-remotion.js";

const tempDirs: string[] = [];

beforeEach(() => {
  assembleMock.mockReset();
  renderMock.mockReset();
  measureQaMediaMock.mockReset();
  measureQaMediaMock.mockResolvedValue({
    version: "1.0.0",
    measured_at: "2026-03-21T12:00:00.000Z",
    measurement_source: "media_probe",
    video_path: "/tmp/final.mp4",
    audio_path: "/tmp/final_mix.wav",
    video_duration_ms: 28000,
    audio_duration_ms: 28000,
    dialogue_window_ms: 10000,
    av_drift_ms: 0,
    loudness_integrated: -16.0,
    loudness_true_peak: -1.8,
    dialogue_occupancy: 0.85,
    observed_non_silent_ms: 8500,
    silence_total_ms: 1500,
    video_frame: matchingVideoFrame,
    deterministic_output_qa: {
      status: "verified",
      duration_sec: 28,
      scanned_duration_sec: 28,
      width: 1920,
      height: 1080,
      issues: [],
    },
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempProject(): string {
  const tmpDir = fs.mkdtempSync(path.join(path.resolve("tests"), "tmp-package-assembler-"));
  tempDirs.push(tmpDir);
  fs.cpSync(path.resolve("projects/sample"), tmpDir, { recursive: true });

  const blueprintPath = path.join(tmpDir, "04_plan/edit_blueprint.yaml");
  const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf-8")) as {
    caption_policy?: Record<string, unknown>;
  };
  blueprint.caption_policy = {
    language: "ja",
    delivery_mode: "both",
    source: "none",
    styling_class: "clean-lower-third",
  };
  fs.writeFileSync(blueprintPath, stringifyYaml(blueprint), "utf-8");

  const timelinePath = path.join(tmpDir, "05_timeline/timeline.json");
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as {
    tracks?: { video?: Array<{ clips?: Array<{ asset_id?: string }> }>; audio?: Array<{ clips?: Array<{ asset_id?: string }> }> };
    audio_mix?: { bgm_asset_id?: string };
  };
  const sourceIds = new Set([
    ...(timeline.tracks?.video ?? []).flatMap((track) => track.clips ?? []).map((clip) => clip.asset_id),
    ...(timeline.tracks?.audio ?? []).flatMap((track) => track.clips ?? []).map((clip) => clip.asset_id),
    timeline.audio_mix?.bgm_asset_id,
  ].filter((value): value is string => typeof value === "string"));
  const mediaDir = path.join(tmpDir, "02_media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const sourceItems = [...sourceIds].sort().map((assetId) => {
    const sourcePath = path.join(mediaDir, `${assetId}.bin`);
    fs.writeFileSync(sourcePath, `source:${assetId}`);
    return {
      asset_id: assetId,
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: `02_media/${assetId}.bin`,
    };
  });
  fs.writeFileSync(path.join(mediaDir, "source_map.json"), JSON.stringify({
    version: "1",
    project_id: "sample-mountain-reset",
    media_dir: "02_media",
    generated_at: "2026-07-20T00:00:00.000Z",
    items: sourceItems,
  }));
  const reviewReportPath = path.join(tmpDir, "06_review/review_report.yaml");
  const reviewPatchPath = path.join(tmpDir, "06_review/review_patch.json");
  const reviewReport = parseYaml(fs.readFileSync(reviewReportPath, "utf-8")) as Record<string, unknown>;
  reviewReport.visual_qa = {
    status: "verified",
    score: 90,
    min_score: 70,
    issues: { total: 0, critical: 0, warning: 0, info: 0 },
    issue_summaries: [],
    deterministic_scan: {
      status: "verified",
      duration_sec: 10,
      width: 1920,
      height: 1080,
      issues: [],
    },
  };
  fs.writeFileSync(reviewReportPath, stringifyYaml(reviewReport), "utf-8");

  const projectState = {
    version: 1,
    project_id: "sample-mountain-reset",
    current_state: "approved",
    gates: {
      review_gate: "open",
      analysis_gate: "ready",
      compile_gate: "open",
      planning_gate: "open",
      timeline_gate: "open",
    },
    approval_record: {
      status: "clean",
      approved_by: "operator",
      approved_at: "2026-03-21T10:00:00Z",
      artifact_versions: {
        timeline_version: computeFileHash(timelinePath),
        editorial_timeline_hash: computeFileHash(timelinePath),
        review_report_version: computeFileHash(reviewReportPath),
        review_patch_hash: computeFileHash(reviewPatchPath),
      },
    },
    handoff_resolution: {
      handoff_id: "HND_0001_20260321T100000Z",
      status: "decided",
      source_of_truth_decision: "engine_render",
      decided_by: "operator",
      decided_at: "2026-03-21T10:30:00Z",
    },
  };

  fs.writeFileSync(
    path.join(tmpDir, "project_state.yaml"),
    stringifyYaml(projectState),
    "utf-8",
  );

  return tmpDir;
}

function stubRenderOutputs(
  projectDir: string,
  assemblyPath: string,
  routeDecision: RenderRouteDecision = resolveProjectRenderRoute(projectDir),
) {
  const outputDir = path.join(projectDir, "07_package");
  const rawVideoPath = path.join(outputDir, "video", "raw_video.mp4");
  const rawDialoguePath = path.join(outputDir, "audio", "raw_dialogue.wav");
  const finalMixPath = path.join(outputDir, "audio", "final_mix.wav");
  const finalVideoPath = path.join(outputDir, "video", "final.mp4");
  const audioMixReportPath = path.join(outputDir, "logs", "audio-mix-report.json");

  for (const filePath of [assemblyPath, rawVideoPath, rawDialoguePath, finalMixPath, finalVideoPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "stub", "utf-8");
  }
  fs.mkdirSync(path.dirname(audioMixReportPath), { recursive: true });
  fs.writeFileSync(audioMixReportPath, JSON.stringify({
    version: "audio-mix-report/v1",
    has_bgm: false,
    strategy: "dialogue_only_mastering_v1",
    final_mastering: {
      loudness_target_lufs: -16,
      lra_target: 7,
      true_peak_target_dbtp: -1.5,
      premaster_measurement: {
        input_i: "-20.00",
        input_tp: "-3.00",
        input_lra: "4.00",
        input_thresh: "-30.00",
        target_offset: "0.00",
      },
    },
  }), "utf-8");
  const renderRouteReceiptPath = writeRenderRouteReceipt(outputDir, routeDecision, {
    baseAssemblyPath: assemblyPath,
    effectiveAssemblyPath: finalVideoPath,
    timelinePath: path.join(projectDir, "05_timeline", "timeline.json"),
    finalVideoPath,
    operations: [
      { id: "base_assembly", kind: "lossy_video_generation", codec: "h264" },
      ...(routeDecision.delivery.lossy_video_encode_passes > 1
        ? [{ id: "final_visual_composite", kind: "lossy_video_generation" as const, codec: "h264" }]
        : []),
      { id: "final_mux_video", kind: "stream_copy", codec: "h264" },
    ],
    measurementSource: "execution_plan",
    rendererVersions: {
      ...(routeDecision.visual_layers.some((layer) => layer.renderer === "hyperframes")
        ? { hyperframes: HYPERFRAMES_RENDERER_VERSION }
        : {}),
      ...(routeDecision.base_engine === "remotion"
        || routeDecision.visual_layers.some((layer) => layer.renderer === "remotion")
        ? { remotion: REMOTION_RENDERER_VERSION }
        : {}),
    },
  });

  return {
    baseAssemblyPath: assemblyPath,
    assemblyPath,
    rawVideoPath,
    rawDialoguePath,
    finalMixPath,
    finalVideoPath,
    sidecarPaths: [] as string[],
    logs: {},
    audioMixReportPath,
    renderRouteReceiptPath,
  };
}

function stampFreshAssembly(projectDir: string, assemblyPath: string): void {
  writeRenderFreshnessMetadata(projectDir, assemblyPath, {
    sourceInputsBefore: createSourceInputAttestation(projectDir),
  });
}

describe("package command assembler wiring", () => {
  it("keeps skipRender contract truthful for timeline-embedded A2 music", async () => {
    const projectDir = createTempProject();
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
    timeline.tracks.audio.push({
      track_id: "A2",
      kind: "audio",
      clips: [{
        ...timeline.tracks.audio[0].clips[0],
        clip_id: "ACL_EMBEDDED_BGM",
        asset_id: "AST_BGM_EMBEDDED",
        role: "music",
      }],
    });
    fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, "utf-8");
    const sourceMapPath = path.join(projectDir, "02_media/source_map.json");
    const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf-8")) as {
      items: Array<Record<string, unknown>>;
    };
    const bgmSourcePath = path.join(projectDir, "02_media/AST_BGM_EMBEDDED.bin");
    fs.writeFileSync(bgmSourcePath, "source:AST_BGM_EMBEDDED");
    sourceMap.items.push({
      asset_id: "AST_BGM_EMBEDDED",
      source_locator: bgmSourcePath,
      local_source_path: bgmSourcePath,
      link_path: "02_media/AST_BGM_EMBEDDED.bin",
    });
    fs.writeFileSync(sourceMapPath, JSON.stringify(sourceMap));
    const statePath = path.join(projectDir, "project_state.yaml");
    const state = parseYaml(fs.readFileSync(statePath, "utf-8")) as any;
    state.approval_record.artifact_versions.timeline_version = computeFileHash(timelinePath);
    state.approval_record.artifact_versions.editorial_timeline_hash = computeFileHash(timelinePath);
    fs.writeFileSync(statePath, stringifyYaml(state), "utf-8");

    const result = await packageCommand(projectDir, {
      skipRender: true,
      precomputedMetrics: {
        integratedLufs: -16,
        truePeakDbtp: -1.8,
        videoDurationMs: 28_000,
        audioDurationMs: 28_000,
        dialogueWindowMs: 10_000,
        observedNonSilentMs: 8_500,
        videoFrame: matchingVideoFrame,
      },
    });

    expect(result.success, result.error?.message).toBe(true);
    expect(JSON.parse(fs.readFileSync(
      path.join(projectDir, "07_package/logs/audio-mix-report.json"),
      "utf-8",
    ))).toMatchObject({
      has_bgm: true,
      strategy: "timeline_embedded_bgm_mastering_v1",
      bgm_ownership: { owner: "timeline_assembler", asset_ids: ["AST_BGM_EMBEDDED"] },
    });
  });

  it("measures the existing final deliverable instead of the base assembly when skipping render", async () => {
    const projectDir = createTempProject();
    const assemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");
    fs.writeFileSync(assemblyPath, "existing-assembly", "utf-8");
    stampFreshAssembly(projectDir, assemblyPath);

    const result = await packageCommand(projectDir, {
      skipRender: true,
      assemblyPath,
    });

    expect(result.success, result.error?.message).toBe(true);
    expect(measureQaMediaMock).toHaveBeenCalledWith(expect.objectContaining({
      videoPath: path.join(projectDir, "07_package/video/final.mp4"),
      audioPath: path.join(projectDir, "07_package/audio/final_mix.wav"),
      dialoguePath: path.join(projectDir, "07_package/audio/raw_dialogue.wav"),
    }));
  });

  it("refreshes outputs when the project is already packaged", async () => {
    const projectDir = createTempProject();
    const assemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");
    fs.writeFileSync(assemblyPath, "existing-assembly", "utf-8");
    stampFreshAssembly(projectDir, assemblyPath);

    renderMock.mockImplementation(async ({ assemblyPath: renderAssemblyPath }: { assemblyPath: string }) =>
      stubRenderOutputs(projectDir, renderAssemblyPath)
    );
    const metrics = {
      integratedLufs: -16.0,
      truePeakDbtp: -1.8,
      videoDurationMs: 28000,
      audioDurationMs: 28000,
      dialogueWindowMs: 10000,
      observedNonSilentMs: 8500,
      videoFrame: matchingVideoFrame,
    };

    const first = await packageCommand(projectDir, { precomputedMetrics: metrics });
    const second = await packageCommand(projectDir, { precomputedMetrics: metrics });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(renderMock).toHaveBeenCalledTimes(2);
    expect(reconcile(projectDir).reconciled_state).toBe("packaged");
  });

  it("auto-builds 05_timeline/assembly.mp4 when missing", async () => {
    const projectDir = createTempProject();
    const assemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");

    assembleMock.mockImplementation(async ({ outputPath }: { outputPath: string }) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "assembled", "utf-8");
      return {
        outputPath,
        workingDir: path.join(projectDir, ".tmp"),
        timelineDurationFrames: 0,
        videoSegmentCount: 0,
        audioClipCount: 0,
      };
    });
    renderMock.mockImplementation(async ({ assemblyPath: renderAssemblyPath }: { assemblyPath: string }) =>
      stubRenderOutputs(projectDir, renderAssemblyPath)
    );

    const result = await packageCommand(projectDir, {
      precomputedMetrics: {
        integratedLufs: -16.0,
        truePeakDbtp: -1.8,
        videoDurationMs: 28000,
        audioDurationMs: 28000,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
        videoFrame: matchingVideoFrame,
      },
    });

    expect(result.success).toBe(true);
    expect(assembleMock).toHaveBeenCalledTimes(1);
    expect(assembleMock).toHaveBeenCalledWith(expect.objectContaining({
      projectDir,
      timelinePath: path.join(projectDir, "05_timeline", "timeline.json"),
      outputPath: assemblyPath,
    }));
    expect(renderMock).toHaveBeenCalledWith(expect.objectContaining({
      assemblyPath,
    }));
    expect(result.deliverablePath).toBe(path.join(projectDir, "09_output", "final.mp4"));
    expect(fs.existsSync(path.join(projectDir, "09_output", "final.mp4"))).toBe(true);
  });

  it("reuses an existing 05_timeline/assembly.mp4", async () => {
    const projectDir = createTempProject();
    const assemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");
    fs.writeFileSync(assemblyPath, "existing-assembly", "utf-8");
    stampFreshAssembly(projectDir, assemblyPath);

    renderMock.mockImplementation(async ({ assemblyPath: renderAssemblyPath }: { assemblyPath: string }) =>
      stubRenderOutputs(projectDir, renderAssemblyPath)
    );

    const result = await packageCommand(projectDir, {
      precomputedMetrics: {
        integratedLufs: -16.0,
        truePeakDbtp: -1.8,
        videoDurationMs: 28000,
        audioDurationMs: 28000,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
        videoFrame: matchingVideoFrame,
      },
    });

    expect(result.success).toBe(true);
    expect(assembleMock).not.toHaveBeenCalled();
    expect(renderMock).toHaveBeenCalledWith(expect.objectContaining({
      assemblyPath,
    }));
    expect(result.deliverablePath).toBe(path.join(projectDir, "09_output", "final.mp4"));
    expect(fs.existsSync(path.join(projectDir, "09_output", "final.mp4"))).toBe(true);
  });

  it("checks source freshness on the hashed base assembly after HyperFrames compositing", async () => {
    const projectDir = createTempProject();
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
    const overlayClip = {
      ...timeline.tracks.video[0].clips[0],
      clip_id: "OV_SECTION",
      role: "title",
      metadata: {
        content_element: {
          version: "content-element/v1",
          element_id: "SECTION",
          kind: "template",
          template_ref: "vos:content.section-label/v1",
          template_version: "1.0.0",
          props: { title: "Section" },
          layout: {
            anchor: "top_left",
            x: 0,
            y: 0,
            scale: 1,
            rotation_deg: 0,
            opacity: 1,
            safe_area: true,
            z_index: 100,
          },
        },
      },
    };
    timeline.tracks.overlay = [{ track_id: "OV1", kind: "overlay", clips: [overlayClip] }];
    fs.writeFileSync(timelinePath, JSON.stringify(timeline), "utf-8");
    const statePath = path.join(projectDir, "project_state.yaml");
    const state = parseYaml(fs.readFileSync(statePath, "utf-8"));
    state.approval_record.artifact_versions.timeline_version = computeFileHash(timelinePath);
    state.approval_record.artifact_versions.editorial_timeline_hash = computeFileHash(timelinePath);
    fs.writeFileSync(statePath, stringifyYaml(state), "utf-8");

    const baseAssemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");
    const effectiveAssemblyPath = path.join(projectDir, "07_package", "video", "assembly.with-content.mp4");
    fs.writeFileSync(baseAssemblyPath, "base-assembly", "utf-8");
    stampFreshAssembly(projectDir, baseAssemblyPath);
    renderMock.mockImplementation(async () => ({
      ...stubRenderOutputs(projectDir, effectiveAssemblyPath),
      baseAssemblyPath,
      assemblyPath: effectiveAssemblyPath,
    }));

    const result = await packageCommand(projectDir, {
      assemblyPath: baseAssemblyPath,
      precomputedMetrics: {
        integratedLufs: -16,
        truePeakDbtp: -1.8,
        videoDurationMs: 28000,
        audioDurationMs: 28000,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
        videoFrame: matchingVideoFrame,
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an explicit runtime package assembly shortcut without source freshness metadata", async () => {
    const projectDir = createTempProject();
    const assemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");
    fs.writeFileSync(assemblyPath, "legacy-assembly", "utf-8");

    const result = await packageCommand(projectDir, {
      assemblyPath,
      precomputedMetrics: {
        integratedLufs: -16.0,
        truePeakDbtp: -1.8,
        videoDurationMs: 28000,
        audioDurationMs: 28000,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
        videoFrame: matchingVideoFrame,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("source_inputs_unverifiable");
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("auto-renders a default assembly after a used source is replaced", async () => {
    const projectDir = createTempProject();
    const assemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");
    fs.writeFileSync(assemblyPath, "existing-assembly", "utf-8");
    stampFreshAssembly(projectDir, assemblyPath);
    const sourceMap = JSON.parse(fs.readFileSync(path.join(projectDir, "02_media/source_map.json"), "utf-8"));
    const sourcePath = sourceMap.items[0].source_locator as string;
    const original = fs.readFileSync(sourcePath, "utf-8");
    fs.writeFileSync(sourcePath, original.toUpperCase());

    assembleMock.mockImplementation(async ({ outputPath }: { outputPath: string }) => {
      fs.writeFileSync(outputPath, "rerendered-assembly");
      return { outputPath, videoSegmentCount: 1, audioClipCount: 0 };
    });
    renderMock.mockImplementation(async ({ assemblyPath: renderAssemblyPath }: { assemblyPath: string }) =>
      stubRenderOutputs(projectDir, renderAssemblyPath)
    );
    const result = await packageCommand(projectDir, {
      precomputedMetrics: {
        integratedLufs: -16,
        truePeakDbtp: -1.8,
        videoDurationMs: 28000,
        audioDurationMs: 28000,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
        videoFrame: matchingVideoFrame,
      },
    });

    expect(result.success, result.error?.message).toBe(true);
    expect(assembleMock).toHaveBeenCalledTimes(1);
    expect(result.qaReport?.source_inputs_freshness).toMatchObject({ status: "fresh" });
    expect(result.packageManifest?.provenance.source_inputs_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails runtime packaging when a source changes inside assembly rendering", async () => {
    const projectDir = createTempProject();
    const sourceMap = JSON.parse(fs.readFileSync(path.join(projectDir, "02_media/source_map.json"), "utf-8"));
    const sourcePath = sourceMap.items[0].source_locator as string;
    assembleMock.mockImplementation(async ({ outputPath }: { outputPath: string }) => {
      fs.writeFileSync(outputPath, "partial-assembly");
      const original = fs.readFileSync(sourcePath, "utf-8");
      fs.writeFileSync(sourcePath, original.toUpperCase());
      return { outputPath, videoSegmentCount: 1, audioClipCount: 0 };
    });

    const result = await packageCommand(projectDir, {
      precomputedMetrics: {
        integratedLufs: -16,
        truePeakDbtp: -1.8,
        videoDurationMs: 28000,
        audioDurationMs: 28000,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
        videoFrame: matchingVideoFrame,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("source_changed_during_render");
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("routes an explicit Remotion engine through the render pipeline without FFmpeg preassembly", async () => {
    const projectDir = createTempProject();
    const assemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");

    renderMock.mockImplementation(async ({
      assemblyOutputPath,
      renderRouteDecision,
    }: {
      assemblyOutputPath: string;
      renderRouteDecision: RenderRouteDecision;
    }) =>
      stubRenderOutputs(projectDir, assemblyOutputPath, renderRouteDecision)
    );

    const result = await packageCommand(projectDir, {
      assemblyEngine: "remotion",
      precomputedMetrics: {
        integratedLufs: -16.0,
        truePeakDbtp: -1.8,
        videoDurationMs: 28000,
        audioDurationMs: 28000,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
        videoFrame: matchingVideoFrame,
      },
    });

    expect(result.success).toBe(true);
    expect(assembleMock).not.toHaveBeenCalled();
    expect(renderMock).toHaveBeenCalledWith(expect.objectContaining({
      assemblyPath: undefined,
      assemblyEngine: "remotion",
      assemblyOutputPath: assemblyPath,
      sourceMap: expect.any(Object),
    }));
  });
});
