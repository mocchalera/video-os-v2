import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { computeFileHash, reconcile } from "../runtime/state/reconcile.js";

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
  })),
  writeQaMeasurements: vi.fn(),
  collectQaMeasurementWarnings: vi.fn(() => []),
}));

import { packageCommand } from "../runtime/commands/package.js";

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
  const reviewReportPath = path.join(tmpDir, "06_review/review_report.yaml");
  const reviewPatchPath = path.join(tmpDir, "06_review/review_patch.json");
  const reviewReport = parseYaml(fs.readFileSync(reviewReportPath, "utf-8")) as Record<string, unknown>;
  reviewReport.visual_qa = {
    status: "verified",
    score: 90,
    min_score: 70,
    issues: { total: 0, critical: 0, warning: 0, info: 0 },
    issue_summaries: [],
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

function stubRenderOutputs(projectDir: string, assemblyPath: string) {
  const outputDir = path.join(projectDir, "07_package");
  const rawVideoPath = path.join(outputDir, "video", "raw_video.mp4");
  const rawDialoguePath = path.join(outputDir, "audio", "raw_dialogue.wav");
  const finalMixPath = path.join(outputDir, "audio", "final_mix.wav");
  const finalVideoPath = path.join(outputDir, "video", "final.mp4");

  for (const filePath of [assemblyPath, rawVideoPath, rawDialoguePath, finalMixPath, finalVideoPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "stub", "utf-8");
  }

  return {
    assemblyPath,
    rawVideoPath,
    rawDialoguePath,
    finalMixPath,
    finalVideoPath,
    sidecarPaths: [] as string[],
    logs: {},
  };
}

describe("package command assembler wiring", () => {
  it("refreshes outputs when the project is already packaged", async () => {
    const projectDir = createTempProject();
    const assemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");
    fs.writeFileSync(assemblyPath, "existing-assembly", "utf-8");

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
});
