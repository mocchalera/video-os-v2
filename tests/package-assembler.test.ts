import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { computeFileHash } from "../runtime/state/reconcile.js";

const { assembleMock, renderMock } = vi.hoisted(() => ({
  assembleMock: vi.fn(),
  renderMock: vi.fn(),
}));

vi.mock("../runtime/render/assembler.js", () => ({
  assembleTimelineToMp4: assembleMock,
}));

vi.mock("../runtime/render/pipeline.js", () => ({
  runRenderPipeline: renderMock,
}));

import { packageCommand } from "../runtime/commands/package.js";

const tempDirs: string[] = [];

beforeEach(() => {
  assembleMock.mockReset();
  renderMock.mockReset();
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
      },
    });

    expect(result.success).toBe(true);
    expect(assembleMock).not.toHaveBeenCalled();
    expect(renderMock).toHaveBeenCalledWith(expect.objectContaining({
      assemblyPath,
    }));
  });
});
