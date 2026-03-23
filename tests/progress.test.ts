/**
 * Tests for runtime/progress.ts — ProgressTracker and readProgress.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  ProgressTracker,
  readProgress,
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
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────

describe("ProgressTracker", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(TMP_DIR, `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(projectDir, { recursive: true });
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
