import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectSourceFiles,
  collectSourceDiscovery,
  resolveProjectDir,
  runProjectPipeline,
  type ProjectPipelineDeps,
  type ProjectPipelineOptions,
} from "../runtime/pipeline/executor.js";
import type { BuildFootageDbResult } from "../runtime/artifacts/footage-db-builder.js";
import { runPreflight } from "../runtime/preflight.js";
import { discoverRequestedSources } from "../runtime/media/source-discovery.js";
import { loadBlueprint } from "../runtime/artifacts/loaders.js";
import { readPipelineTimings } from "../runtime/progress.js";
import { readProjectState } from "../runtime/state/reconcile.js";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.ENABLE_P1_MANIFEST_COVERAGE;
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

function writeReviewablePreview(
  projectDir: string,
  options: { preview?: string | null; parityPass?: boolean } = {},
): void {
  fs.mkdirSync(path.join(projectDir, "09_output"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "06_review"), { recursive: true });
  if (options.preview !== null) {
    fs.writeFileSync(path.join(projectDir, "09_output", "rough-cut.mp4"), options.preview ?? "preview");
  }
  fs.writeFileSync(path.join(projectDir, "09_output", "render-report.json"), JSON.stringify({
    expected_rendered_sec: 1,
    actual_rendered_sec: 1,
    parity_delta_sec: 0,
    parity_tolerance_sec: 0.05,
    parity_pass: options.parityPass ?? true,
  }));
  fs.writeFileSync(path.join(projectDir, "06_review", "editorial_pipeline_status.json"), JSON.stringify({
    version: "1",
    preview: {
      status: "available",
      artifact_path: "09_output/rough-cut.mp4",
      render_skipped: false,
    },
  }));
}

function writePipelineTimingsWithReceipt(projectDir: string, receipt: Record<string, unknown>): void {
  const timingsDir = path.join(projectDir, "03_analysis");
  fs.mkdirSync(timingsDir, { recursive: true });
  fs.writeFileSync(path.join(timingsDir, "pipeline-timings.json"), JSON.stringify({
    version: 1,
    project_id: path.basename(projectDir),
    updated_at: "2026-08-26T00:00:00.000Z",
    runs: [],
    first_preview_sla: receipt,
  }));
}

describe("project pipeline executor", () => {
  it.each([
    [600_000, "passed"],
    [600_001, "missed"],
  ] as const)("records first-preview SLA only at the valid render boundary at %dms", async (completedAtMs, status) => {
    const projectDir = makeTempProject(`executor-sla-${completedAtMs}`);
    let now = 0;
    const result = await runProjectPipeline({
      ...baseOptions(projectDir),
      skipAnalyze: true,
      skipFootageDb: true,
      skipQa: true,
    }, {
      now: () => now,
      runEditorialPipeline: async (options) => {
        now = completedAtMs;
        writeReviewablePreview(projectDir);
        options.onFirstPreviewReady?.();
      },
    } as ProjectPipelineDeps & { now: () => number });

    expect(result.success).toBe(true);
    expect(result.firstPreviewSla).toMatchObject({
      version: 1,
      original_started_at_ms: 0,
      deadline_at_ms: 600_000,
      eligible: true,
      status,
      completed_at_ms: completedAtMs,
      preview_artifact_path: "09_output/rough-cut.mp4",
    });
    expect(readPipelineTimings(projectDir)?.first_preview_sla).toEqual(result.firstPreviewSla);
  });

  it.each([
    ["parity failure", { parityPass: false }],
    ["missing preview", { preview: null }],
    ["empty preview", { preview: "" }],
  ] as const)("keeps an actual renderer-format %s out of SLA PASS", async (_name, previewOptions) => {
    const projectDir = makeTempProject(`executor-sla-render-report-${_name.replaceAll(" ", "-")}`);
    let now = 0;
    const result = await runProjectPipeline({
      ...baseOptions(projectDir),
      skipAnalyze: true,
      skipFootageDb: true,
      skipQa: true,
    }, {
      now: () => now,
      runEditorialPipeline: async (options) => {
        now = 100;
        writeReviewablePreview(projectDir, previewOptions);
        options.onFirstPreviewReady?.();
      },
    });

    expect(result.success).toBe(true);
    expect(result.firstPreviewSla).toMatchObject({
      eligible: true,
      status: "hold",
      reason: "preview_missing",
    });
  });

  it("does not let artifacts written after the render-terminal callback create a stale SLA PASS", async () => {
    const projectDir = makeTempProject("executor-sla-stale-render-callback");
    let now = 0;
    const result = await runProjectPipeline({
      ...baseOptions(projectDir),
      skipAnalyze: true,
      skipFootageDb: true,
      skipQa: true,
    }, {
      now: () => now,
      runEditorialPipeline: async (options) => {
        now = 100;
        options.onFirstPreviewReady?.();
        writeReviewablePreview(projectDir);
      },
    });

    expect(result.success).toBe(true);
    expect(result.firstPreviewSla).toMatchObject({ status: "hold", reason: "preview_missing" });
  });

  it("anchors a fresh SLA to invocation time before project initialization", async () => {
    const parentDir = makeTempProject("executor-sla-init-parent");
    const sourceDir = path.join(parentDir, "source");
    const projectDir = path.join(parentDir, "fresh-project");
    fs.mkdirSync(sourceDir, { recursive: true });
    let now = 0;
    let receivedDeadline: number | undefined;
    const result = await runProjectPipeline({
      ...baseOptions(projectDir),
      sourceDir,
      skipAnalyze: true,
      skipFootageDb: true,
      skipQa: true,
    }, {
      now: () => now,
      initProject: () => {
        now = 700_000;
        fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
        return { projectDir };
      },
      runEditorialPipeline: async (options) => {
        receivedDeadline = options.firstPreviewDeadlineAtMs;
        writeReviewablePreview(projectDir);
        options.onFirstPreviewReady?.();
      },
    });

    expect(receivedDeadline).toBe(600_000);
    expect(result.firstPreviewSla).toMatchObject({
      original_started_at_ms: 0,
      deadline_at_ms: 600_000,
      status: "missed",
      completed_at_ms: 700_000,
    });
  });

  it("restores the original cold deadline on resume instead of granting another 600 seconds", async () => {
    const projectDir = makeTempProject("executor-sla-resume");
    let now = 0;
    const interrupted = await runProjectPipeline(baseOptions(projectDir), {
      now: () => now,
      runAnalyze: async () => {
        now = 100;
        throw new Error("controlled interruption");
      },
      buildFootageDb: async (options) => fakeFootageDbResult(options.projectDir),
      runEditorialPipeline: async () => undefined,
    });
    expect(interrupted.success).toBe(false);
    expect(readPipelineTimings(projectDir)?.first_preview_sla).toMatchObject({
      original_started_at_ms: 0,
      deadline_at_ms: 600_000,
      status: "hold",
      reason: "pipeline_failed",
      ended_at_ms: 100,
    });

    now = 700_000;
    let receivedDeadline: number | undefined;
    const resumed = await runProjectPipeline({
      ...baseOptions(projectDir),
      from: "compile",
      skipQa: true,
    }, {
      now: () => now,
      runEditorialPipeline: async (options) => {
        receivedDeadline = options.firstPreviewDeadlineAtMs;
        writeReviewablePreview(projectDir);
        options.onFirstPreviewReady?.();
      },
    } as ProjectPipelineDeps & { now: () => number });

    expect(resumed.success).toBe(true);
    expect(receivedDeadline).toBe(600_000);
    expect(resumed.firstPreviewSla).toMatchObject({
      original_started_at_ms: 0,
      deadline_at_ms: 600_000,
      eligible: true,
      status: "missed",
      completed_at_ms: 700_000,
    });
  });

  it("closes a running first-preview receipt when the pipeline fails before preview", async () => {
    const projectDir = makeTempProject("executor-sla-terminal-failure");
    let now = 0;
    const result = await runProjectPipeline(baseOptions(projectDir), {
      now: () => now,
      runAnalyze: async () => {
        now = 123;
        throw new Error("controlled terminal failure");
      },
      runEditorialPipeline: async () => undefined,
    });

    expect(result.success).toBe(false);
    expect(result.firstPreviewSla).toMatchObject({
      eligible: true,
      status: "hold",
      reason: "pipeline_failed",
      ended_at_ms: 123,
    });
    expect(result.firstPreviewSla.completed_at_ms).toBeUndefined();
    expect(readPipelineTimings(projectDir)?.first_preview_sla).toEqual(result.firstPreviewSla);
  });

  it.each([
    ["passed", 100, 200],
    ["missed", 700_000, 700_100],
  ] as const)(
    "closes a previously %s first-preview receipt when a later pipeline stage fails",
    async (_previousStatus, completedAtMs, failedAtMs) => {
      const projectDir = makeTempProject(`executor-sla-post-preview-failure-${_previousStatus}`);
      let now = 0;
      const result = await runProjectPipeline({
        ...baseOptions(projectDir),
        skipAnalyze: true,
        skipFootageDb: true,
      }, {
        now: () => now,
        runEditorialPipeline: async (options) => {
          now = completedAtMs;
          writeReviewablePreview(projectDir);
          options.onFirstPreviewReady?.();
          now = failedAtMs;
          throw new Error("controlled post-preview failure");
        },
      });

      expect(result.success).toBe(false);
      expect(result.firstPreviewSla).toEqual({
        version: 1,
        original_started_at_ms: 0,
        deadline_at_ms: 600_000,
        eligible: true,
        status: "hold",
        reason: "pipeline_failed",
        completed_at_ms: completedAtMs,
        preview_artifact_path: "09_output/rough-cut.mp4",
        ended_at_ms: failedAtMs,
      });
      expect(readPipelineTimings(projectDir)?.first_preview_sla).toEqual(result.firstPreviewSla);
    },
  );

  it("keeps legacy resume functional without making a cold SLA claim", async () => {
    const projectDir = makeTempProject("executor-sla-legacy-resume");
    let now = 700_000;
    const result = await runProjectPipeline({
      ...baseOptions(projectDir),
      from: "compile",
      skipQa: true,
    }, {
      now: () => now,
      runEditorialPipeline: async (options) => {
        writeReviewablePreview(projectDir);
        options.onFirstPreviewReady?.();
      },
    } as ProjectPipelineDeps & { now: () => number });

    expect(result.success).toBe(true);
    expect(result.firstPreviewSla).toMatchObject({
      eligible: false,
      status: "not_eligible",
      reason: "legacy_resume_without_checkpoint",
    });
  });

  it.each([
    ["missing version", { original_started_at_ms: 0, deadline_at_ms: 600_000, eligible: true, status: "running" }],
    ["missing start", { version: 1, deadline_at_ms: 600_000, eligible: true, status: "running" }],
    ["non-finite start", { version: 1, original_started_at_ms: "Infinity", deadline_at_ms: 600_000, eligible: true, status: "running" }],
    ["reversed deadline", { version: 1, original_started_at_ms: 700_000, deadline_at_ms: 600_000, eligible: true, status: "running" }],
    ["wrong budget", { version: 1, original_started_at_ms: 0, deadline_at_ms: 599_999, eligible: true, status: "running" }],
    ["inconsistent eligibility", { version: 1, original_started_at_ms: 0, deadline_at_ms: 600_000, eligible: false, status: "running" }],
  ])("keeps a resume with a %s receipt functional but not SLA-eligible", async (_name, receipt) => {
    const projectDir = makeTempProject(`executor-sla-invalid-${_name.replaceAll(" ", "-")}`);
    writePipelineTimingsWithReceipt(projectDir, receipt);
    let now = 100;
    const result = await runProjectPipeline({
      ...baseOptions(projectDir),
      from: "compile",
      skipQa: true,
    }, {
      now: () => now,
      runEditorialPipeline: async (options) => {
        writeReviewablePreview(projectDir);
        options.onFirstPreviewReady?.();
      },
    });

    expect(result.success).toBe(true);
    expect(result.firstPreviewSla).toMatchObject({
      eligible: false,
      status: "not_eligible",
      reason: "invalid_resume_checkpoint",
    });
  });

  it("keeps missing and explicitly skipped previews out of SLA PASS", async () => {
    for (const skipRender of [false, true]) {
      const projectDir = makeTempProject(`executor-sla-no-preview-${skipRender}`);
      if (!skipRender) writeReviewablePreview(projectDir);
      let now = 0;
      const result = await runProjectPipeline({
        ...baseOptions(projectDir),
        skipAnalyze: true,
        skipFootageDb: true,
        skipRender,
        skipQa: true,
      }, {
        now: () => now,
        runEditorialPipeline: async () => {
          now = 100;
        },
      });

      expect(result.success).toBe(true);
      expect(result.firstPreviewSla).toMatchObject(skipRender
        ? { eligible: false, status: "not_eligible", reason: "render_skipped" }
        : { eligible: true, status: "hold", reason: "preview_missing" });
    }
  });

  it.each([
    [236_600, false],
    [236_601, true],
  ])("reserves compile/render and switches to the schema-valid rough blueprint at %dms", async (elapsedMs, expectedSkipFine) => {
    const projectDir = makeTempProject(`executor-first-preview-${elapsedMs}`);
    let now = 0;
    let fineProviderCalls = 0;
    let receivedBudget: Record<string, unknown> | undefined;
    let receivedAnalyzeBudget: Record<string, unknown> | undefined;
    const result = await runProjectPipeline({
      ...baseOptions(projectDir),
      skipFootageDb: true,
      skipQa: true,
    }, {
      now: () => now,
      runAnalyze: async (_projectDir, analyzeOptions) => {
        receivedAnalyzeBudget = analyzeOptions as unknown as Record<string, unknown>;
        fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
        fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });
        fs.writeFileSync(
          path.join(projectDir, "03_analysis", "segments.json"),
          JSON.stringify({ items: Array.from({ length: 13 }, (_, index) => ({ segment_id: `SEG_${index}` })) }),
        );
        fs.copyFileSync(
          path.resolve("projects/demo/04_plan/edit_blueprint.yaml"),
          path.join(projectDir, "04_plan/edit_blueprint.yaml"),
        );
        now = elapsedMs;
        return { success: true };
      },
      runEditorialPipeline: async (options) => {
        receivedBudget = options as unknown as Record<string, unknown>;
        if (!options.skipFine) fineProviderCalls += 1;
        expect(() => loadBlueprint(path.join(projectDir, "04_plan/edit_blueprint.yaml"))).not.toThrow();
      },
    } as ProjectPipelineDeps & { now: () => number });

    expect(result.success).toBe(true);
    expect(receivedAnalyzeBudget?.firstPreviewDeadlineAtMs).toBe(600_000);
    expect(receivedAnalyzeBudget?.firstPreviewCompileRenderReserveMs).toBe(41_800);
    expect(receivedBudget?.firstPreviewDeadlineAtMs).toBe(600_000);
    expect(receivedBudget?.firstPreviewCompileRenderReserveMs).toBe(63_400);
    expect(receivedBudget?.firstPreviewFineEstimateMs).toBe(48_000);
    expect(receivedBudget?.firstPreviewFineProviderBudgetMs).toBe(300_000);
    expect(receivedBudget?.skipFine).toBe(expectedSkipFine);
    expect(fineProviderCalls).toBe(expectedSkipFine ? 0 : 1);
  });

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

  it("stops after analyze when canonical coverage still has a blocked required lane", async () => {
    const projectDir = makeTempProject("executor-analysis-blocked");
    const calls: string[] = [];
    const result = await runProjectPipeline(baseOptions(projectDir), {
      runAnalyze: async () => {
        calls.push("analyze");
        fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
        fs.writeFileSync(
          path.join(projectDir, "03_analysis", "analysis_coverage_report.json"),
          JSON.stringify({
            summary: {
              status: "blocked",
              required_lane_count: 3,
              ready_lane_count: 2,
              blocked_lane_count: 1,
              partial_lane_count: 0,
            },
          }),
        );
        return { success: true };
      },
      buildFootageDb: async (options) => {
        calls.push("footage");
        return fakeFootageDbResult(options.projectDir);
      },
      runEditorialPipeline: async () => {
        calls.push("editorial");
      },
    });

    expect(result.success).toBe(false);
    expect(result.failedStage).toBe("ingest");
    expect(result.message).toContain("Analysis coverage is blocked");
    expect(calls).toEqual(["analyze"]);
  });

  it("stops after analyze when ready lane coverage disagrees with the blocked canonical analysis gate", async () => {
    process.env.ENABLE_P1_MANIFEST_COVERAGE = "1";
    const projectDir = makeTempProject("executor-analysis-canonical-blocked");
    fs.cpSync(path.resolve("projects/sample"), projectDir, { recursive: true, force: true });
    const assetsPath = path.join(projectDir, "03_analysis/assets.json");
    const assets = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as {
      items: Array<Record<string, unknown>>;
    };
    for (const asset of assets.items) asset.analysis_status = "pending";
    fs.writeFileSync(assetsPath, JSON.stringify(assets, null, 2));
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/gap_report.yaml"),
      `version: "1"\nentries:\n${assets.items.map((asset) =>
        `  - stage: ingest\n    asset_id: ${String(asset.asset_id)}\n    severity: error\n    reason: canonical analysis pending\n    blocking: true\n`
      ).join("")}`,
    );
    const coverage = JSON.parse(fs.readFileSync(
      path.resolve("tests/fixtures/analysis_coverage_report/valid_ready_all_lanes.json"),
      "utf-8",
    ));
    coverage.project_id = "sample-mountain-reset";
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/analysis_coverage_report.json"),
      JSON.stringify(coverage, null, 2),
    );
    fs.writeFileSync(
      path.join(projectDir, "project_state.yaml"),
      "version: 1\nproject_id: sample-mountain-reset\ncurrent_state: intent_locked\nhistory: []\n" +
        "gates:\n  analysis_gate: blocked\n  compile_gate: open\n  planning_gate: open\n" +
        "  timeline_gate: blocked\n  review_gate: blocked\n  packaging_gate: blocked\n",
    );
    const calls: string[] = [];

    const result = await runProjectPipeline(baseOptions(projectDir), {
      runAnalyze: async () => {
        calls.push("analyze");
        return { success: true };
      },
      buildFootageDb: async (options) => {
        calls.push("footage");
        return fakeFootageDbResult(options.projectDir);
      },
      runEditorialPipeline: async () => {
        calls.push("editorial");
      },
    });

    expect(result.success).toBe(false);
    expect(result.failedStage).toBe("ingest");
    expect(result.message).toContain("Analysis gate is blocked");
    expect(calls).toEqual(["analyze"]);
    expect(readProjectState(projectDir)?.gates?.analysis_gate).toBe("blocked");
    expect(assets.items.every((asset) => asset.analysis_status === "pending")).toBe(true);
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
    expect(collectSourceFiles(path.join(projectDir, "02_media", "source")).map((file) => path.basename(file))).toEqual(["clip.mp4", "ignore.txt"]);
  });

  it("hands one precomputed discovery from full-pipeline into analyze without hashing again", async () => {
    const projectDir = makeTempProject("executor-discovery-handoff");
    const sourceDir = path.join(projectDir, "02_media", "source");
    let hashCalls = 0;
    const discoverOnce = (locators: string[]) => discoverRequestedSources(locators, {
      hashFile() {
        hashCalls += 1;
        return `sha256:${"a".repeat(64)}`;
      },
    });
    const discovery = discoverOnce([sourceDir]);
    expect(hashCalls).toBe(1);

    const preflight = runPreflight(discovery.requests.map((request) => request.lexical_path), discovery);
    expect(preflight.discovery).toBe(discovery);
    expect(hashCalls).toBe(1);
    hashCalls = 0;

    let handedDiscovery: unknown;
    const result = await runProjectPipeline(baseOptions(projectDir), {
      discoverSources: discoverOnce,
      runAnalyze: async (_projectDir, options) => {
        handedDiscovery = options.sourceDiscovery;
        expect(options.sourceFiles).toEqual([path.join(sourceDir, "clip.mp4")]);
        expect(options.sourceFiles.every((filePath) => path.isAbsolute(filePath) && fs.statSync(filePath).isFile())).toBe(true);
        return { success: true };
      },
      buildFootageDb: async (options) => fakeFootageDbResult(options.projectDir),
      runEditorialPipeline: async () => {},
    });

    expect(result.success).toBe(true);
    expect(handedDiscovery).toMatchObject({ summary: { requested: 1 } });
    expect(hashCalls).toBe(1);
  });
});
