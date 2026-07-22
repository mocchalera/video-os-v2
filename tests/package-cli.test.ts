import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  assessAssemblyFreshness,
  buildPackagePreflight,
  ensureFreshAssembly,
  formatPreflightReport,
  parseArgs,
  runPackageCli,
} from "../scripts/package.js";
import { computeFileHash } from "../runtime/state/reconcile.js";
import { packageCommand } from "../runtime/commands/package.js";
import { ingestAsset } from "../runtime/connectors/ffprobe.js";

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
  it("packages a canonical video-only still without inventing audio artifacts or QA metrics", async () => {
    const projectDir = fs.mkdtempSync(path.resolve("tests", "tmp-package-valid-still-"));
    tempDirs.push(projectDir);
    fs.cpSync(path.resolve("projects/sample"), projectDir, { recursive: true });
    const sourcePath = path.join(projectDir, "source.png");
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x32", "-frames:v", "1", "-y", sourcePath,
    ]);
    const asset = await ingestAsset(sourcePath, {
      projectRoot: projectDir,
      mediaKind: "image",
      ffmpegVersion: "test",
    });
    writeJson(path.join(projectDir, "02_media/source_map.json"), {
      version: "1", project_id: "package-cli-test", media_dir: "02_media",
      items: [{
        asset_id: asset.asset_id,
        source_locator: sourcePath,
        local_source_path: sourcePath,
        link_path: "source.png",
        media_kind: "image",
        source_content_sha256: asset.source_content_sha256,
      }],
    });
    writeJson(path.join(projectDir, "03_analysis/assets.json"), { items: [asset] });
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    Object.assign(timeline.sequence, { width: 64, height: 64, output_aspect_ratio: "1:1" });
    timeline.tracks.video = [{ track_id: "V1", kind: "video", clips: [{
      clip_id: "CLP_IMG", segment_id: "SEG_IMG", asset_id: asset.asset_id,
      media_kind: "image", src_in_us: 0, src_out_us: 1,
      timeline_in_frame: 0, timeline_duration_frames: 12,
      role: "hero", motivation: "still",
      still_image: {
        hold_frames: 12, min_hold_frames: 1, max_hold_frames: 12,
        hold_source: "global_default", policy_clamp: "none",
        motion_mode: "static", fit_mode: "contain", background: "black",
      },
    }] }];
    timeline.tracks.audio = [];
    delete timeline.audio_mix;
    fs.writeFileSync(timelinePath, JSON.stringify(timeline));
    writeYaml(path.join(projectDir, "06_review/review_report.yaml"), {
      version: "1", project_id: timeline.project_id, fatal_issues: [],
      visual_qa: {
        status: "verified", score: 90, min_score: 70,
        issues: { total: 0, critical: 0, warning: 0, info: 0 }, issue_summaries: [],
      },
    });
    const statePath = path.join(projectDir, "project_state.yaml");
    const timelineHash = computeFileHash(timelinePath);
    const reviewReportPath = path.join(projectDir, "06_review/review_report.yaml");
    const reviewPatchPath = path.join(projectDir, "06_review/review_patch.json");
    writeYaml(statePath, {
      version: 1, project_id: timeline.project_id, current_state: "approved",
      approval_record: {
        status: "clean", approved_by: "operator", approved_at: "2026-07-20T00:00:00Z",
        artifact_versions: {
          timeline_version: timelineHash,
          editorial_timeline_hash: timelineHash,
          review_report_version: computeFileHash(reviewReportPath),
          review_patch_hash: computeFileHash(reviewPatchPath),
        },
      },
      handoff_resolution: {
        handoff_id: "HND_STILL", status: "decided", source_of_truth_decision: "engine_render",
        decided_by: "operator", decided_at: "2026-07-20T00:00:00Z",
      },
    });
    for (const staleAudioArtifact of [
      path.join(projectDir, "07_package/audio/raw_dialogue.wav"),
      path.join(projectDir, "07_package/audio/final_mix.wav"),
      path.join(projectDir, "07_package/logs/audio-mix-report.json"),
    ]) {
      fs.mkdirSync(path.dirname(staleAudioArtifact), { recursive: true });
      fs.writeFileSync(staleAudioArtifact, "stale-audio-artifact");
    }

    const result = await packageCommand(projectDir, {
      allowedStates: ["approved"],
      createdAt: "2026-07-20T00:00:00Z",
    });
    if (!result.success) throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ success: true });
    expect(result.packageManifest?.artifacts).not.toHaveProperty("raw_dialogue");
    expect(result.packageManifest?.artifacts).not.toHaveProperty("final_mix");
    expect(result.qaReport?.artifacts).not.toHaveProperty("final_mix");
    expect(result.qaReport?.artifacts).not.toHaveProperty("audio_mix_report");
    for (const name of ["dialogue_occupancy_valid", "av_drift_valid", "loudness_target_valid"]) {
      expect(result.qaReport?.checks.find((check) => check.name === name)?.details).toContain("not_applicable");
    }
    expect(fs.existsSync(path.join(projectDir, "07_package/audio/raw_dialogue.wav"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "07_package/audio/final_mix.wav"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "07_package/logs/audio-mix-report.json"))).toBe(false);
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type", "-of", "json",
      result.deliverablePath!,
    ], { encoding: "utf8" }));
    expect(probe.streams.map((stream: { codec_type: string }) => stream.codec_type)).toEqual(["video"]);
  }, 30_000);

  it("blocks an image timeline before package/render output creation", async () => {
    const projectDir = createTempProject("video-os-package-image-guard-");
    writeGate10Project(projectDir);
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    timeline.tracks.video = [{ track_id: "V1", kind: "video", clips: [{
      clip_id: "CLP_IMG", segment_id: "SEG_IMG", asset_id: "AST_IMG",
      src_in_us: 0, src_out_us: 1, timeline_in_frame: 0, timeline_duration_frames: 72,
      role: "hero", motivation: "still", media_kind: "image",
      still_image: { hold_frames: 72, min_hold_frames: 24, max_hold_frames: 240, hold_source: "global_default", policy_clamp: "none", motion_mode: "static", fit_mode: "contain", background: "black" },
    }] }];
    fs.writeFileSync(timelinePath, JSON.stringify(timeline));
    const statePath = path.join(projectDir, "project_state.yaml");
    const state = parseYaml(fs.readFileSync(statePath, "utf8")) as any;
    const timelineHash = computeFileHash(timelinePath);
    state.approval_record.artifact_versions.timeline_version = timelineHash;
    state.approval_record.artifact_versions.editorial_timeline_hash = timelineHash;
    fs.writeFileSync(statePath, stringifyYaml(state));
    await expect(packageCommand(projectDir, { skipRender: true, allowedStates: ["intent_pending", "approved"] })).rejects.toMatchObject({
      name: "CanonicalRenderInputError",
    });
    expect(fs.existsSync(path.join(projectDir, "07_package"))).toBe(false);
  });

  it("blocks a marker-stripped image from authoritative assets before package side effects", async () => {
    const projectDir = createTempProject("video-os-package-external-image-guard-");
    writeGate10Project(projectDir);
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    timeline.tracks.video = [{ track_id: "V1", kind: "video", clips: [{
      clip_id: "CLP_IMG", segment_id: "SEG_IMG", asset_id: "AST_IMG",
      src_in_us: 0, src_out_us: 1, timeline_in_frame: 0, timeline_duration_frames: 1,
      role: "hero", motivation: "stripped external still truth",
    }] }];
    fs.writeFileSync(timelinePath, JSON.stringify(timeline));
    writeJson(path.join(projectDir, "03_analysis", "assets.json"), { items: [{
      asset_id: "AST_IMG", filename: "still.jpg", media_kind: "image",
    }] });
    writeJson(path.join(projectDir, "02_media", "source_map.json"), { items: [{
      asset_id: "AST_IMG", source_locator: "02_media/still.jpg", media_kind: "image",
    }] });
    const statePath = path.join(projectDir, "project_state.yaml");
    const state = parseYaml(fs.readFileSync(statePath, "utf8")) as any;
    const timelineHash = computeFileHash(timelinePath);
    state.approval_record.artifact_versions.timeline_version = timelineHash;
    state.approval_record.artifact_versions.editorial_timeline_hash = timelineHash;
    fs.writeFileSync(statePath, stringifyYaml(state));
    const stateBefore = fs.readFileSync(statePath);

    await expect(packageCommand(projectDir, { skipRender: false, allowedStates: ["approved"] }))
      .rejects.toMatchObject({ name: "CanonicalRenderInputError", assetId: "AST_IMG" });
    expect(fs.existsSync(path.join(projectDir, "07_package"))).toBe(false);
    expect(fs.readFileSync(statePath)).toEqual(stateBefore);
  });

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
      assemblyEngine: undefined,
      suppliedFinalPath: "07_package/video/final.mp4",
      createdAt: "2026-03-24T00:00:00Z",
      preflightOnly: false,
      verifyExisting: false,
      json: true,
    });
  });

  it("parses an explicit Remotion assembly engine", () => {
    expect(parseArgs([
      "node",
      "scripts/package.ts",
      "projects/demo",
      "--assembly-engine",
      "remotion",
    ])).toMatchObject({
      projectDir: "projects/demo",
      assemblyEngine: "remotion",
    });
  });

  it("parses the capability-based auto assembly engine", () => {
    expect(parseArgs([
      "node",
      "scripts/package.ts",
      "projects/demo",
      "--assembly-engine",
      "auto",
    ])).toMatchObject({ assemblyEngine: "auto" });
  });

  it("rejects conflicting prebuilt and engine assembly routes", () => {
    expect(() => parseArgs([
      "node",
      "scripts/package.ts",
      "projects/demo",
      "--assembly-path",
      "assembly.mp4",
      "--assembly-engine",
      "remotion",
    ])).toThrow("cannot be used together");
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
  it("prints read-only preflight JSON without mutating the project", async () => {
    const projectDir = createTempProject("video-os-package-preflight-json-");
    writeGate10Project(projectDir);
    const before = snapshotProjectFiles(projectDir);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runPackageCli([
      "node",
      "scripts/package.ts",
      projectDir,
      "--preflight-only",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(snapshotProjectFiles(projectDir)).toEqual(before);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: true,
      projectId: "package-cli-test",
      currentState: "approved",
      sourceOfTruth: "engine_render",
    });
    stdout.mockRestore();
  });

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
    expect(preflight.projectId).toBe("package-cli-test");
    expect(preflight.currentState).toBe("packaged");
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

describe("package CLI existing-package verification", () => {
  it("verifies the canonical package read-only", async () => {
    const projectDir = createTempProject("video-os-package-verification-");
    const fixture = JSON.parse(fs.readFileSync(
      "apps/macos-studio/Tests/VideoOSStudioCoreTests/Fixtures/macos-studio-contract-v1.json",
      "utf8",
    )) as { packageCases: Array<{ id: string; files: Record<string, string> }> };
    const valid = fixture.packageCases.find((testCase) => testCase.id === "valid");
    if (!valid) throw new Error("valid package fixture is missing");
    for (const [relativePath, contents] of Object.entries(valid.files)) {
      const filePath = path.join(projectDir, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, "utf8");
    }
    const before = snapshotProjectFiles(projectDir);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runPackageCli([
      "node",
      "scripts/package.ts",
      projectDir,
      "--verify-existing",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(snapshotProjectFiles(projectDir)).toEqual(before);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
      ready: true,
      projectDir,
      readinessLabel: "render packaged",
    });
    stdout.mockRestore();
  });

  it("rejects combining both read-only modes", () => {
    expect(() => parseArgs([
      "node",
      "scripts/package.ts",
      "projects/demo",
      "--preflight-only",
      "--verify-existing",
    ])).toThrow("cannot be used together");
  });
});

function snapshotProjectFiles(projectDir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        snapshot[path.relative(projectDir, absolute)] = fs.readFileSync(absolute).toString("base64");
      }
    }
  };
  visit(projectDir);
  return snapshot;
}
