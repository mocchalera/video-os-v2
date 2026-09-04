/**
 * Tests for interrupted-run recovery:
 * - runtime/progress.ts closeStaleRunningProgress / tracker.abort
 * - runtime/state/recovery.ts recoverInterruptedProject
 *
 * Acceptance criteria from GitHub Issue #5 P0:
 * - an interrupted run never leaves progress.json "running"
 * - validated selects + blueprint recover to blueprint_ready without re-triage
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ProgressTracker,
  closeActiveTrackersOnSignal,
  closeStaleRunningProgress,
  readProgress,
} from "../runtime/progress.js";
import { recoverInterruptedProject } from "../runtime/state/recovery.js";

const TMP_DIR = path.join(import.meta.dirname, "_tmp_state_recovery_test");

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function makeProjectDir(name: string): string {
  const dir = path.join(TMP_DIR, `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeProgressFile(projectDir: string, status: string, ownerPid?: number): void {
  const now = new Date().toISOString();
  const report = {
    project_id: path.basename(projectDir),
    command: "editorial-pipeline",
    phase: "analyze",
    stage: "triage",
    status,
    started_at: now,
    updated_at: now,
    completed: 1,
    total: 6,
    eta_sec: null,
    artifacts_created: [],
    errors: [],
    ...(ownerPid !== undefined ? { pid: ownerPid } : {}),
  };
  fs.writeFileSync(path.join(projectDir, "progress.json"), JSON.stringify(report, null, 2));
}

describe("closeStaleRunningProgress", () => {
  it("closes a running report owned by a dead process as aborted", () => {
    const dir = makeProjectDir("stale");
    writeProgressFile(dir, "running", 999_999_999);

    expect(closeStaleRunningProgress(dir)).toBe(true);

    const report = readProgress(dir)!;
    expect(report.status).toBe("aborted");
    expect(report.errors.some((e) => e.stage === "recovery")).toBe(true);
  });

  it("leaves a running report whose owning process is alive", () => {
    const dir = makeProjectDir("live");
    writeProgressFile(dir, "running", process.pid);

    expect(closeStaleRunningProgress(dir)).toBe(false);
    expect(readProgress(dir)!.status).toBe("running");
  });

  it("ignores reports that are not running", () => {
    const dir = makeProjectDir("done");
    writeProgressFile(dir, "failed", 999_999_999);

    expect(closeStaleRunningProgress(dir)).toBe(false);
    expect(readProgress(dir)!.status).toBe("failed");
  });

  it("returns false when no progress file exists", () => {
    const dir = makeProjectDir("empty");
    expect(closeStaleRunningProgress(dir)).toBe(false);
  });
});

describe("ProgressTracker abort paths", () => {
  it("abort() sets status to aborted so a signal never leaves running behind", () => {
    const dir = makeProjectDir("abort");
    const tracker = new ProgressTracker(dir, "triage", 2);
    tracker.abort("process", "received SIGINT; closing progress as aborted");

    const report = readProgress(dir)!;
    expect(report.status).toBe("aborted");
    expect(report.pid).toBe(process.pid);
  });

  it("closeActiveTrackersOnSignal closes all live trackers of this process", () => {
    const dirA = makeProjectDir("sig_a");
    const dirB = makeProjectDir("sig_b");
    new ProgressTracker(dirA, "triage", 1);
    new ProgressTracker(dirB, "triage", 1);

    const closed = closeActiveTrackersOnSignal("SIGTERM");
    expect(closed).toBeGreaterThanOrEqual(2);
    expect(readProgress(dirA)!.status).toBe("aborted");
    expect(readProgress(dirB)!.status).toBe("aborted");
  });
});

describe("recoverInterruptedProject", () => {
  function seedValidatedArtifacts(dir: string): void {
    fs.mkdirSync(path.join(dir, "01_intent"), { recursive: true });
    fs.mkdirSync(path.join(dir, "04_plan"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "01_intent/creative_brief.yaml"),
      "project_id: recovery-proj\ngoal: test\n",
    );
    fs.writeFileSync(
      path.join(dir, "01_intent/unresolved_blockers.yaml"),
      "blockers: []\n",
    );
    fs.writeFileSync(
      path.join(dir, "04_plan/selects_candidates.yaml"),
      "version: '1'\nproject_id: recovery-proj\ncandidates:\n  - segment_id: SEG_0001\n    asset_id: ASSET_0001\n",
    );
    fs.writeFileSync(
      path.join(dir, "04_plan/edit_blueprint.yaml"),
      "version: '2'\nproject_id: recovery-proj\nbeats: []\n",
    );
  }

  it("closes stale running progress and reconciles blueprint_ready without re-triage", () => {
    const dir = makeProjectDir("recover");
    seedValidatedArtifacts(dir);
    writeProgressFile(dir, "running", 999_999_999);

    const result = recoverInterruptedProject(dir, "test-actor");

    expect(result.progress_closed).toBe(true);
    expect(result.reconciled_state).toBe("blueprint_ready");
    expect(result.persisted_state).toBe("blueprint_ready");

    const report = readProgress(dir)!;
    expect(report.status).toBe("aborted");

    // project_state.yaml was persisted with the recovered state.
    const stateDoc = fs.readFileSync(path.join(dir, "project_state.yaml"), "utf-8");
    expect(stateDoc).toContain("blueprint_ready");
  });

  it("is safe on a healthy project: live runs and consistent states are untouched", () => {
    const dir = makeProjectDir("healthy");
    seedValidatedArtifacts(dir);
    // Simulate a healthy prior state doc via one recovery pass first.
    recoverInterruptedProject(dir, "seed");

    const result = recoverInterruptedProject(dir, "check");

    expect(result.self_healed).toBe(false);
    expect(result.persisted_state).toBe("blueprint_ready");
    expect(result.progress_closed).toBe(false);
  });
});
