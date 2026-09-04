/**
 * Tests for runtime/progress.ts — ProgressTracker and readProgress.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  ProgressTracker,
  PipelineStageProgressTracker,
  appendPipelineTimingRun,
  estimatePipelineStages,
  estimateFirstPreviewStageBudget,
  formatPipelineProgress,
  readPipelineTimings,
  readProgress,
  closeActiveTrackersOnSignal,
  type ProgressReport,
  type ProgressPhase,
} from "../runtime/progress.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const TMP_DIR = path.join(import.meta.dirname, "_tmp_progress_test");
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// ── Schema Validator ───────────────────────────────────────────────

function createProgressValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "schemas/progress.schema.json"), "utf-8"),
  );
  return ajv.compile(schema);
}

// ── Setup / Teardown ───────────────────────────────────────────────

beforeAll(() => {
  // sweep residue from any previously interrupted run before recreating
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  closeActiveTrackersOnSignal("SIGTERM");
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────

describe("ProgressTracker", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(TMP_DIR, `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    closeActiveTrackersOnSignal("SIGTERM");
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("creates progress.json on construction", () => {
    new ProgressTracker(projectDir, "analysis", 10);
    const progressPath = path.join(projectDir, "progress.json");
    expect(fs.existsSync(progressPath)).toBe(true);
  });

  it("initializes with correct fields", () => {
    const pt = new ProgressTracker(projectDir, "analysis", 10);
    const snap = pt.snapshot();

    expect(snap.project_id).toBe(path.basename(projectDir));
    expect(snap.phase).toBe("analysis");
    expect(snap.gate).toBe(1);
    expect(snap.status).toBe("running");
    expect(snap.completed).toBe(0);
    expect(snap.total).toBe(10);
    expect(snap.artifacts_created).toEqual([]);
    expect(snap.errors).toEqual([]);
    expect(snap.started_at).toBeTruthy();
    expect(snap.updated_at).toBeTruthy();
  });

  it("maps phases to correct gate numbers", () => {
    const gateMap: Record<ProgressPhase, number> = {
      intent: 0,
      analysis: 1,
      triage: 2,
      blueprint: 3,
      compile: 4,
      review: 5,
      render: 6,
      package: 7,
    };

    for (const [phase, gate] of Object.entries(gateMap)) {
      const dir = path.join(projectDir, `gate_${phase}`);
      fs.mkdirSync(dir, { recursive: true });
      const pt = new ProgressTracker(dir, phase as ProgressPhase, 1);
      expect(pt.snapshot().gate).toBe(gate);
    }
  });

  it("advance() increments completed count", () => {
    const pt = new ProgressTracker(projectDir, "compile", 5);
    pt.advance();
    pt.advance();
    expect(pt.snapshot().completed).toBe(2);
  });

  it("advance() with artifact name tracks artifacts_created", () => {
    const pt = new ProgressTracker(projectDir, "compile", 3);
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), "{}\n");
    fs.writeFileSync(path.join(projectDir, "timeline.otio"), "otio\n");
    pt.advance("timeline.json");
    pt.advance("timeline.otio");
    const snap = pt.snapshot();
    expect(snap.artifacts_created).toEqual(["timeline.json", "timeline.otio"]);
  });

  it("advance() does not exceed total", () => {
    const pt = new ProgressTracker(projectDir, "compile", 2);
    pt.advance();
    pt.advance();
    pt.advance(); // should clamp
    expect(pt.snapshot().completed).toBe(2);
  });

  it("complete() sets status and maxes out progress", () => {
    const pt = new ProgressTracker(projectDir, "analysis", 10);
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), "{}\n");
    fs.writeFileSync(path.join(projectDir, "03_analysis/segments.json"), "{}\n");
    pt.advance();
    pt.complete(["assets.json", "segments.json"]);
    const snap = pt.snapshot();

    expect(snap.status).toBe("completed");
    expect(snap.completed).toBe(10);
    expect(snap.eta_sec).toBe(0);
    expect(snap.artifacts_created).toContain("assets.json");
    expect(snap.artifacts_created).toContain("segments.json");
  });

  it("complete() deduplicates artifacts", () => {
    const pt = new ProgressTracker(projectDir, "analysis", 5);
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), "{}\n");
    fs.writeFileSync(path.join(projectDir, "03_analysis/segments.json"), "{}\n");
    pt.advance("assets.json");
    pt.complete(["assets.json", "segments.json"]);
    const snap = pt.snapshot();
    const assetCount = snap.artifacts_created.filter((a) => a === "assets.json").length;
    expect(assetCount).toBe(1);
  });

  it("fail() sets status to failed and records error", () => {
    const pt = new ProgressTracker(projectDir, "compile", 3);
    pt.advance();
    pt.fail("validation", "Schema mismatch");
    const snap = pt.snapshot();

    expect(snap.status).toBe("failed");
    expect(snap.errors).toHaveLength(1);
    expect(snap.errors[0].stage).toBe("validation");
    expect(snap.errors[0].message).toBe("Schema mismatch");
    expect(snap.errors[0].retriable).toBe(false);
  });

  it("block() sets status to blocked", () => {
    const pt = new ProgressTracker(projectDir, "review", 5);
    pt.block("gate_check", "Compile gate blocked");
    expect(pt.snapshot().status).toBe("blocked");
  });

  it("recordError() adds errors without changing status", () => {
    const pt = new ProgressTracker(projectDir, "analysis", 5);
    pt.recordError("stt", "Transcription timeout", true);
    const snap = pt.snapshot();

    expect(snap.status).toBe("running");
    expect(snap.errors).toHaveLength(1);
    expect(snap.errors[0].retriable).toBe(true);
  });

  it("setTotal() updates total count", () => {
    const pt = new ProgressTracker(projectDir, "analysis", 5);
    pt.setTotal(12);
    expect(pt.snapshot().total).toBe(12);
  });

  it("eta_sec is null initially, calculated after advances", () => {
    const pt = new ProgressTracker(projectDir, "analysis", 10);
    expect(pt.snapshot().eta_sec).toBeNull();
    pt.advance();
    // After at least one advance, eta should be a number (may be 0 if very fast)
    expect(pt.snapshot().eta_sec).not.toBeNull();
  });

  it("persists to disk and is readable via readProgress()", () => {
    const pt = new ProgressTracker(projectDir, "compile", 3);
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), "{}\n");
    pt.advance("timeline.json");

    const report = readProgress(projectDir);
    expect(report).not.toBeNull();
    expect(report!.phase).toBe("compile");
    expect(report!.completed).toBe(1);
    expect(report!.artifacts_created).toEqual(["timeline.json"]);
  });

  it("readProgress() returns null for missing progress.json", () => {
    const emptyDir = path.join(TMP_DIR, "empty_project");
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(readProgress(emptyDir)).toBeNull();
  });

  it("output validates against progress.schema.json", () => {
    const validate = createProgressValidator();
    const pt = new ProgressTracker(projectDir, "analysis", 6);
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), "{}\n");
    fs.writeFileSync(path.join(projectDir, "03_analysis/segments.json"), "{}\n");
    fs.writeFileSync(path.join(projectDir, "03_analysis/gap_report.yaml"), "version: 1\n");
    pt.advance("assets.json");
    pt.recordError("vlm", "Rate limit hit", true);
    pt.advance("segments.json");
    pt.complete(["gap_report.yaml"]);

    const report = readProgress(projectDir);
    const valid = validate(report);
    if (!valid) {
      console.error("progress.json validation errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });

  it("does not report missing artifacts and records a hash for verified files", () => {
    const pt = new ProgressTracker(projectDir, "compile", 2);
    pt.advance("missing.json");
    expect(pt.snapshot().artifacts_created).toEqual([]);
    fs.writeFileSync(path.join(projectDir, "verified.json"), "verified\n");
    expect(pt.registerArtifact("verified.json")).toBe(true);
    expect(pt.snapshot().artifact_hashes?.["verified.json"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("multiple trackers for same project overwrite progress.json", () => {
    const pt1 = new ProgressTracker(projectDir, "analysis", 5);
    pt1.complete();

    const pt2 = new ProgressTracker(projectDir, "compile", 3);
    pt2.advance();
    const report = readProgress(projectDir);
    expect(report!.phase).toBe("compile");
    expect(report!.status).toBe("running");
    expect(report!.completed).toBe(1);
  });

  it("updated_at changes on each operation", () => {
    const pt = new ProgressTracker(projectDir, "analysis", 5);
    const t0 = pt.snapshot().updated_at;
    // Small delay to ensure different timestamp
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    pt.advance();
    const t1 = pt.snapshot().updated_at;
    expect(t1).not.toBe(t0);
  });
});

describe("pipeline stage timings", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(TMP_DIR, `timings_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    closeActiveTrackersOnSignal("SIGTERM");
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("appends pipeline timing runs under 03_analysis", () => {
    appendPipelineTimingRun(projectDir, {
      run_id: "run_a",
      project_id: path.basename(projectDir),
      entrypoint: "editorial-pipeline",
      started_at: "2026-07-07T00:00:00.000Z",
      completed_at: "2026-07-07T00:01:00.000Z",
      status: "completed",
      segment_count: 12,
      stages: [
        {
          stage: "triage",
          status: "completed",
          started_at: "2026-07-07T00:00:00.000Z",
          ended_at: "2026-07-07T00:01:00.000Z",
          duration_ms: 60_000,
        },
      ],
    });
    appendPipelineTimingRun(projectDir, {
      run_id: "run_b",
      project_id: path.basename(projectDir),
      entrypoint: "editorial-pipeline",
      started_at: "2026-07-07T00:02:00.000Z",
      completed_at: "2026-07-07T00:03:00.000Z",
      status: "completed",
      stages: [],
    });

    const doc = readPipelineTimings(projectDir);
    expect(doc?.runs.map((run) => run.run_id)).toEqual(["run_a", "run_b"]);
    expect(fs.existsSync(path.join(projectDir, "03_analysis", "pipeline-timings.json"))).toBe(true);
  });

  it("uses historical timings before segment-count fallback", () => {
    appendPipelineTimingRun(projectDir, {
      run_id: "run_history",
      project_id: path.basename(projectDir),
      entrypoint: "full-pipeline",
      started_at: "2026-07-07T00:00:00.000Z",
      completed_at: "2026-07-07T00:02:00.000Z",
      status: "completed",
      stages: [
        {
          stage: "triage",
          status: "completed",
          started_at: "2026-07-07T00:00:00.000Z",
          ended_at: "2026-07-07T00:02:00.000Z",
          duration_ms: 120_000,
        },
      ],
    });

    const estimates = estimatePipelineStages(readPipelineTimings(projectDir), ["triage", "compile"], {
      segmentCount: 10,
    });
    expect(estimates.get("triage")).toEqual({ estimatedMs: 120_000, source: "history" });
    expect(estimates.get("compile")?.source).toBe("segments");
    expect(estimates.get("compile")?.estimatedMs).toBeGreaterThan(0);
  });

  it("reserves the 13-segment compile/render estimate before optional fine planning", () => {
    const budget = estimateFirstPreviewStageBudget(projectDir, 13, true);
    expect(budget).toEqual({
      fineEstimateMs: 48_000,
      compileRenderReserveMs: 63_400,
    });
  });

  it("formats running progress with ETA and total", () => {
    expect(formatPipelineProgress({
      stageIndex: 3,
      totalStages: 9,
      stage: "triage",
      status: "running",
      elapsedMs: 92_000,
      estimatedRemainingMs: 240_000,
      estimatedTotalMs: 420_000,
    })).toBe("[3/9] triage 実行中... 経過 1m32s / 推定残り ~4m (全体 ~7m)");
  });

  it("tracks a stage, prints progress, and persists duration", () => {
    let now = 0;
    const chunks: string[] = [];
    const tracker = new PipelineStageProgressTracker({
      projectDir,
      entrypoint: "editorial-pipeline",
      stages: ["triage", "compile"],
      segmentCount: 3,
      now: () => now,
      output: {
        write(chunk: string) {
          chunks.push(chunk);
        },
      },
    });

    const stage = tracker.beginStage("triage");
    now = 92_000;
    stage.complete();
    tracker.finish("completed");

    const doc = readPipelineTimings(projectDir);
    expect(doc?.runs).toHaveLength(1);
    expect(doc?.runs[0].stages[0]).toMatchObject({
      stage: "triage",
      status: "completed",
      duration_ms: 92_000,
    });
    expect(chunks.join("")).toContain("[1/2] triage 実行中...");
    expect(chunks.join("")).toContain("[1/2] triage 完了");
  });
});
