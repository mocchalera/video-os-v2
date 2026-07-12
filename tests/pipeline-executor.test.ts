import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectSourceFiles,
  resolveProjectDir,
  runProjectPipeline,
  type ProjectPipelineDeps,
  type ProjectPipelineOptions,
} from "../runtime/pipeline/executor.js";
import type { BuildFootageDbResult } from "../runtime/artifacts/footage-db-builder.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vos-${name}-`));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "02_media", "source"), { recursive: true });
  fs.writeFileSync(path.join(dir, "02_media", "source", "clip.mp4"), "");
  return dir;
}

function baseOptions(projectDir: string): ProjectPipelineOptions {
  return {
    project: projectDir,
    skipAnalyze: false,
    skipFootageDb: false,
    skipRender: false,
    skipQa: false,
  };
}

function fakeFootageDbResult(projectDir: string): BuildFootageDbResult {
  return {
    db_path: path.join(projectDir, "03_analysis", "search", "footage.db"),
    report_path: path.join(projectDir, "03_analysis", "search", "footage-db-report.json"),
    artifact_version: "footage-db-v1",
    schema_version: "1",
    counts: {
      assets: 0,
      segments: 0,
      fts_rows: 0,
      marlin_events: 0,
      transcript_segments: 0,
      asset_technical_metadata: 0,
      segment_visual_profiles: 0,
      segment_audio_profiles: 0,
      segment_logging_profiles: 0,
      metadata_fts_rows: 0,
      embeddings: 0,
    },
    embedding_status: "skipped",
    warnings: [],
    source_hashes: {},
  };
}

describe("project pipeline executor", () => {
  it("runs analyze, footage DB, and editorial through injected runtime dependencies", async () => {
    const projectDir = makeTempProject("executor-full");
    const calls: string[] = [];
    const deps: ProjectPipelineDeps = {
      runAnalyze: async (_projectDir, options) => {
        calls.push(`analyze:${path.basename(options.sourceFiles[0] ?? "")}:${Boolean(options.stageProgress)}`);
        return { success: true };
      },
      buildFootageDb: async (options) => {
        calls.push(`footage:${options.embeddingPolicy}:${options.qwen3vlEnabled === false}:${options.clapAudioEnabled === false}`);
        return fakeFootageDbResult(options.projectDir);
      },
      runEditorialPipeline: async (options) => {
        calls.push(`editorial:${options.skipRender}:${options.qa}:${Boolean(options.stageProgress)}`);
      },
    };

    const result = await runProjectPipeline({
      ...baseOptions(projectDir),
      qwen3vlEnabled: false,
      clapAudioEnabled: false,
    }, deps);

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      "analyze:clip.mp4:true",
      "footage:auto:true:true",
      "editorial:false:true:true",
    ]);
    expect(fs.existsSync(path.join(projectDir, "03_analysis", "pipeline-timings.json"))).toBe(true);
  });

  it("respects skip flags and leaves the CLI out of orchestration", async () => {
    const projectDir = makeTempProject("executor-skip");
    const calls: string[] = [];
    const deps: ProjectPipelineDeps = {
      runAnalyze: async () => {
        calls.push("analyze");
        return { success: true };
      },
      buildFootageDb: async (options) => {
        calls.push("footage");
        return fakeFootageDbResult(options.projectDir);
      },
      runEditorialPipeline: async (options) => {
        calls.push(`editorial:${options.skipRender}:${options.qa}:${options.skipQa}`);
      },
    };

    const result = await runProjectPipeline({
      ...baseOptions(projectDir),
      skipAnalyze: true,
      skipFootageDb: true,
      skipRender: true,
      skipQa: true,
    }, deps);

    expect(result.success).toBe(true);
    expect(calls).toEqual(["editorial:true:false:true"]);
  });

  it("wraps dependency failures with the current full-pipeline stage", async () => {
    const projectDir = makeTempProject("executor-fail");
    const deps: ProjectPipelineDeps = {
      runAnalyze: async () => ({ success: true }),
      buildFootageDb: async () => {
        throw new Error("embedding unavailable");
      },
      runEditorialPipeline: async () => {},
    };

    const result = await runProjectPipeline({
      ...baseOptions(projectDir),
      skipAnalyze: true,
    }, deps);

    expect(result.success).toBe(false);
    expect(result.failedStage).toBe("embeddings");
    expect(result.message).toContain("Failed stage: embeddings");
    expect(result.message).toContain("npm run full-pipeline");
    expect(result.message).toContain("embedding unavailable");
  });

  it("keeps project and source-file resolution deterministic", () => {
    const projectDir = makeTempProject("executor-files");
    fs.writeFileSync(path.join(projectDir, "02_media", "source", "ignore.txt"), "");

    expect(resolveProjectDir("demo")).toBe(path.resolve("projects", "demo"));
    expect(collectSourceFiles(path.join(projectDir, "02_media", "source")).map((file) => path.basename(file))).toEqual(["clip.mp4"]);
  });
});
