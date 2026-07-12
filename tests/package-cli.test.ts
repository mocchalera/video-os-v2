import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  assessAssemblyFreshness,
  buildPackagePreflight,
  ensureFreshAssembly,
  formatPreflightReport,
  parseArgs,
} from "../scripts/package.js";
import { computeFileHash } from "../runtime/state/reconcile.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempProject(prefix: string): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(projectDir);
  return projectDir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeYaml(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(value), "utf-8");
}

function writeMinimalTimeline(projectDir: string, version = "1"): string {
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  writeJson(timelinePath, {
    version,
    project_id: "package-cli-test",
    created_at: "2026-03-24T00:00:00Z",
    sequence: {
      name: "Package CLI Test",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  });
  return timelinePath;
}

function writeGate10Project(projectDir: string, visualQaStatus: "verified" | "stale" = "verified"): void {
  const timelinePath = writeMinimalTimeline(projectDir);
  writeYaml(path.join(projectDir, "01_intent", "creative_brief.yaml"), {
    version: "1",
    project_id: "package-cli-test",
    project: {
      id: "package-cli-test",
      title: "Package CLI Test",
      runtime_target_sec: 10,
    },
    autonomy: {
      mode: "full",
      may_decide: ["render"],
      must_ask: [],
    },
  });
  writeYaml(path.join(projectDir, "04_plan", "edit_blueprint.yaml"), {
    version: "1",
    project_id: "package-cli-test",
    caption_policy: {
      language: "ja",
      delivery_mode: "both",
      source: "none",
      styling_class: "clean-lower-third",
    },
  });
  writeYaml(path.join(projectDir, "06_review", "review_report.yaml"), {
    version: "1",
    project_id: "package-cli-test",
    visual_qa: {
      status: visualQaStatus,
      ...(visualQaStatus === "verified" ? { score: 90 } : { reason: "render_timeline_hash_mismatch" }),
      min_score: 70,
      issues: { total: 0, critical: 0, warning: 0, info: 0 },
      issue_summaries: [],
    },
  });
  writeYaml(path.join(projectDir, "project_state.yaml"), {
    version: 1,
    project_id: "package-cli-test",
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
      approved_at: "2026-03-24T00:00:00Z",
      artifact_versions: {
        timeline_version: computeFileHash(timelinePath),
        editorial_timeline_hash: computeFileHash(timelinePath),
      },
    },
    handoff_resolution: {
      handoff_id: "HND_TEST",
      status: "decided",
      source_of_truth_decision: "engine_render",
      decided_by: "operator",
      decided_at: "2026-03-24T00:00:00Z",
    },
  });
}

describe("package CLI argument parsing", () => {
  it("parses packageCommand-facing options and assertions", () => {
    expect(parseArgs([
      "node",
      "scripts/package.ts",
      "projects/demo",
      "--source-of-truth",
      "engine_render",
      "--autonomy-mode",
      "full",
      "--skip-render",
      "--no-assembly",
      "--assembly-path",
      "05_timeline/assembly.mp4",
      "--supplied-final",
      "07_package/video/final.mp4",
      "--created-at",
      "2026-03-24T00:00:00Z",
      "--json",
    ])).toEqual({
      projectDir: "projects/demo",
      sourceOfTruth: "engine_render",
      autonomyMode: "full",
      skipRender: true,
      noAssembly: true,
      assemblyPath: "05_timeline/assembly.mp4",
      suppliedFinalPath: "07_package/video/final.mp4",
      createdAt: "2026-03-24T00:00:00Z",
      json: true,
    });
  });
});

describe("package CLI assembly freshness", () => {
  it("generates missing assembly.mp4 and marks stale when the timeline hash changes", async () => {
    const projectDir = createTempProject("video-os-package-cli-");
    const timelinePath = writeMinimalTimeline(projectDir, "1");
    const assemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");
    const assemble = vi.fn(async ({ outputPath }: { outputPath?: string }) => {
      if (!outputPath) throw new Error("outputPath missing");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "assembly-v1", "utf-8");
      return {
        outputPath,
        workingDir: path.join(projectDir, ".tmp"),
        timelineDurationFrames: 24,
        videoSegmentCount: 1,
        audioClipCount: 0,
      };
    });

    const generated = await ensureFreshAssembly(projectDir, {
      createdAt: "2026-03-24T00:00:00Z",
      assembleTimelineToMp4Impl: assemble,
    });

    expect(generated.action).toBe("generated");
    expect(generated.previousReason).toBe("assembly_missing");
    expect(assemble).toHaveBeenCalledWith(expect.objectContaining({
      projectDir,
      timelinePath,
      outputPath: assemblyPath,
    }));
    expect(fs.existsSync(path.join(projectDir, "05_timeline", "render-report.json"))).toBe(true);
    expect(assessAssemblyFreshness(projectDir).status).toBe("fresh");

    writeMinimalTimeline(projectDir, "2");
    const stale = assessAssemblyFreshness(projectDir);
    expect(stale.status).toBe("stale");
    expect(stale.reason).toBe("render_timeline_hash_mismatch");
  });
});

describe("package CLI Gate 10 preflight", () => {
  it("allows an already-packaged project to be packaged again", () => {
    const projectDir = createTempProject("video-os-package-preflight-");
    writeGate10Project(projectDir);
    const statePath = path.join(projectDir, "project_state.yaml");
    const state = parseYaml(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    state.current_state = "packaged";
    writeYaml(statePath, state);

    const preflight = buildPackagePreflight(projectDir, {
      sourceOfTruth: "engine_render",
      autonomyMode: "full",
    });

    expect(preflight.ok).toBe(true);
    expect(preflight.issues).toEqual([]);
  });

  it("prints a human-readable visual_qa blocker with next action", () => {
    const projectDir = createTempProject("video-os-package-preflight-");
    writeGate10Project(projectDir, "stale");

    const preflight = buildPackagePreflight(projectDir, {
      sourceOfTruth: "engine_render",
      autonomyMode: "full",
    });
    const report = formatPreflightReport(preflight);

    expect(preflight.ok).toBe(false);
    expect(preflight.issues).toContain('review_report.visual_qa.status must be "verified", got "stale"');
    expect(report).toContain("Status: BLOCKED");
    expect(report).toContain("Run /review with --render");
  });
});
