/**
 * M4 E2E Test — Packaging Pipeline
 *
 * Fixture-based integration tests for the full M4 packaging flow:
 *   captionCommand → packageCommand
 *
 * Exercises both engine_render and nle_finishing paths, QA gating,
 * state transitions, and error conditions.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { captionCommand } from "../runtime/commands/caption.js";
import { packageCommand } from "../runtime/commands/package.js";
import {
  computeFileHash,
  reconcile,
  type ProjectStateDoc,
} from "../runtime/state/reconcile.js";

// ── Temp dir management ──────────────────────────────────────────

const SAMPLE_PROJECT = "projects/sample";
const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
});

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Write project_state.yaml with an approval_record whose artifact_versions
 * match the current on-disk artifact hashes so that reconcile accepts the
 * approved state without invalidation.
 */
function stampApprovedState(
  projectDir: string,
  opts: {
    currentState: string;
    sourceOfTruth: string;
    includeHandoff: boolean;
    includeApproval: boolean;
  },
): void {
  const hashIfExists = (p: string) =>
    fs.existsSync(p) ? computeFileHash(p) : undefined;

  const timelineHash = hashIfExists(
    path.join(projectDir, "05_timeline/timeline.json"),
  );
  const reviewReportHash = hashIfExists(
    path.join(projectDir, "06_review/review_report.yaml"),
  );
  const reviewPatchHash = hashIfExists(
    path.join(projectDir, "06_review/review_patch.json"),
  );

  const projectState: Record<string, unknown> = {
    version: 1,
    project_id: "sample-mountain-reset",
    current_state: opts.currentState,
    gates: {
      review_gate: "open",
      analysis_gate: "ready",
      compile_gate: "open",
      planning_gate: "open",
      timeline_gate: "open",
    },
  };

  if (opts.includeApproval) {
    projectState.approval_record = {
      status: "clean",
      approved_by: "operator",
      approved_at: "2026-03-21T10:00:00Z",
      artifact_versions: {
        ...(timelineHash ? { timeline_version: timelineHash } : {}),
        ...(timelineHash ? { editorial_timeline_hash: timelineHash } : {}),
        ...(reviewReportHash
          ? { review_report_version: reviewReportHash }
          : {}),
        ...(reviewPatchHash
          ? { review_patch_hash: reviewPatchHash }
          : {}),
      },
    };
  }

  if (opts.includeHandoff) {
    projectState.handoff_resolution = {
      handoff_id: "HND_0001_20260321T100000Z",
      status: "decided",
      source_of_truth_decision: opts.sourceOfTruth,
      decided_by: "operator",
      decided_at: "2026-03-21T10:30:00Z",
    };
  }

  fs.writeFileSync(
    path.join(projectDir, "project_state.yaml"),
    stringifyYaml(projectState),
    "utf-8",
  );
}

// ── M4 Project Factory ──────────────────────────────────────────

function createM4Project(
  name: string,
  opts?: {
    sourceOfTruth?: "engine_render" | "nle_finishing";
    currentState?: string;
    includeHandoff?: boolean;
    includeApproval?: boolean;
    captionSource?: "transcript" | "authored" | "none";
  },
): string {
  const tmpDir = path.resolve(`test-fixtures-m4-${name}-${Date.now()}`);
  copyDirSync(path.resolve(SAMPLE_PROJECT), tmpDir);
  tempDirs.push(tmpDir);

  const sourceOfTruth = opts?.sourceOfTruth ?? "engine_render";
  const currentState = opts?.currentState ?? "approved";
  const includeHandoff = opts?.includeHandoff ?? true;
  const includeApproval = opts?.includeApproval ?? true;
  const captionSrc = opts?.captionSource ?? "none";

  // 1. Set caption_policy in blueprint
  const blueprintPath = path.join(tmpDir, "04_plan/edit_blueprint.yaml");
  const blueprintRaw = fs.readFileSync(blueprintPath, "utf-8");
  const blueprint = parseYaml(blueprintRaw) as Record<string, unknown>;
  blueprint.caption_policy = {
    language: "ja",
    delivery_mode: "both",
    source: captionSrc,
    styling_class: "clean-lower-third",
  };
  fs.writeFileSync(blueprintPath, stringifyYaml(blueprint), "utf-8");

  // 2. Write project_state.yaml
  stampApprovedState(tmpDir, {
    currentState,
    sourceOfTruth,
    includeHandoff,
    includeApproval,
  });

  // 3. Ensure transcripts directory exists
  fs.mkdirSync(path.join(tmpDir, "03_analysis/transcripts"), {
    recursive: true,
  });

  return tmpDir;
}

/**
 * After captionCommand modifies the timeline, re-stamp approval so
 * reconcile sees matching hashes and stays in approved state.
 */
function restampApproval(
  projectDir: string,
  sourceOfTruth: string,
): void {
  stampApprovedState(projectDir, {
    currentState: "approved",
    sourceOfTruth,
    includeHandoff: true,
    includeApproval: true,
  });
}

// ── Caption Command E2E ──────────────────────────────────────────

describe("M4 E2E: captionCommand", () => {
  it("generates caption_source.json with draftOnly", () => {
    const projDir = createM4Project("caption-draft", {
      captionSource: "transcript",
    });
    const result = captionCommand(projDir, { draftOnly: true });

    expect(result.success).toBe(true);
    expect(result.captionSource).toBeDefined();
    expect(result.captionSource!.caption_policy.source).toBe("transcript");

    // Verify file was written
    const captionSourcePath = path.join(
      projDir,
      "07_package/caption_source.json",
    );
    expect(fs.existsSync(captionSourcePath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(captionSourcePath, "utf-8"));
    expect(written.project_id).toBe("sample-mountain-reset");
    expect(written.caption_policy).toBeDefined();
    expect(written.caption_policy.source).toBe("transcript");
  });

  it("generates caption_approval.json for source=none policy", () => {
    const projDir = createM4Project("caption-approval-none", {
      captionSource: "none",
    });
    const result = captionCommand(projDir, {
      approvedBy: "test-operator",
      approvedAt: "2026-03-21T11:00:00Z",
    });

    expect(result.success).toBe(true);
    expect(result.captionApproval).toBeDefined();
    expect(result.captionApproval!.approval.status).toBe("approved");
    expect(result.captionApproval!.approval.approved_by).toBe("test-operator");

    // Verify caption_approval.json was written
    const approvalPath = path.join(
      projDir,
      "07_package/caption_approval.json",
    );
    expect(fs.existsSync(approvalPath)).toBe(true);

    // Verify timeline was updated
    expect(result.timelineUpdated).toBe(true);
  });
});

// ── Package Command E2E ──────────────────────────────────────────

describe("M4 E2E: packageCommand", () => {
  it("engine_render path: QA passes, transitions to packaged", async () => {
    const projDir = createM4Project("pkg-engine", {
      sourceOfTruth: "engine_render",
      captionSource: "none",
    });

    // Run caption command
    const capResult = captionCommand(projDir, {
      approvedBy: "operator",
      approvedAt: "2026-03-21T11:00:00Z",
    });
    expect(capResult.success).toBe(true);

    // Re-stamp approval after caption projection changes timeline hash
    restampApproval(projDir, "engine_render");

    const result = await packageCommand(projDir, {
      skipRender: true,
      precomputedMetrics: {
        integratedLufs: -16.0,
        truePeakDbtp: -1.8,
        videoDurationMs: 30000,
        audioDurationMs: 30005,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
      },
      createdAt: "2026-03-21T12:00:00Z",
    });

    // All QA checks pass and command succeeds
    expect(result.success).toBe(true);
    expect(result.sourceOfTruth).toBe("engine_render");
    expect(result.qaReport).toBeDefined();
    expect(result.qaReport!.passed).toBe(true);
    expect(result.qaReport!.source_of_truth).toBe("engine_render");
    expect(result.qaReport!.metrics.integrated_lufs).toBe(-16.0);
    expect(result.qaReport!.metrics.true_peak_dbtp).toBe(-1.8);
    expect(result.stateTransitioned).toBe(true);

    // State transitioned to packaged
    const stateRaw = fs.readFileSync(
      path.join(projDir, "project_state.yaml"),
      "utf-8",
    );
    const finalState = parseYaml(stateRaw) as { current_state: string };
    expect(finalState.current_state).toBe("packaged");

    // QA report and manifest written to disk
    expect(fs.existsSync(path.join(projDir, "07_package/qa-report.json"))).toBe(true);
    expect(fs.existsSync(path.join(projDir, "07_package/package_manifest.json"))).toBe(true);
  });

  it("nle_finishing path: QA passes, transitions to packaged", async () => {
    const projDir = createM4Project("pkg-nle", {
      sourceOfTruth: "nle_finishing",
      captionSource: "none",
    });

    // Create mock final video for NLE supplied_export_probe_valid
    const videoDir = path.join(projDir, "07_package/video");
    fs.mkdirSync(videoDir, { recursive: true });
    fs.writeFileSync(
      path.join(videoDir, "final.mp4"),
      "mock-nle-video-data",
      "utf-8",
    );

    // Run caption command
    const capResult = captionCommand(projDir, {
      approvedBy: "operator",
      approvedAt: "2026-03-21T11:00:00Z",
    });
    expect(capResult.success).toBe(true);

    // Re-stamp approval
    restampApproval(projDir, "nle_finishing");

    const result = await packageCommand(projDir, {
      skipRender: true,
      precomputedMetrics: {
        integratedLufs: -16.0,
        truePeakDbtp: -1.8,
        videoDurationMs: 30000,
        audioDurationMs: 30002,
      },
      createdAt: "2026-03-21T12:00:00Z",
    });

    expect(result.success).toBe(true);
    expect(result.sourceOfTruth).toBe("nle_finishing");
    expect(result.qaReport).toBeDefined();
    expect(result.qaReport!.qa_profile).toBe("nle_finishing");
    expect(result.qaReport!.passed).toBe(true);
    expect(result.qaReport!.metrics.integrated_lufs).toBe(-16.0);
    expect(result.stateTransitioned).toBe(true);

    // State transitioned to packaged
    const stateRaw = fs.readFileSync(
      path.join(projDir, "project_state.yaml"),
      "utf-8",
    );
    const finalState = parseYaml(stateRaw) as { current_state: string };
    expect(finalState.current_state).toBe("packaged");
  });

  it("fails if QA fails (bad LUFS)", async () => {
    const projDir = createM4Project("pkg-qa-fail", {
      captionSource: "none",
    });

    // Run caption command
    const capResult = captionCommand(projDir, {
      approvedBy: "operator",
      approvedAt: "2026-03-21T11:00:00Z",
    });
    expect(capResult.success).toBe(true);

    // Re-stamp approval
    restampApproval(projDir, "engine_render");

    const result = await packageCommand(projDir, {
      skipRender: true,
      precomputedMetrics: {
        integratedLufs: -20.0, // Way below -17.0 threshold
        truePeakDbtp: -1.8,
        videoDurationMs: 30000,
        audioDurationMs: 30005,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(result.qaReport).toBeDefined();
    expect(result.qaReport!.passed).toBe(false);

    // Loudness check specifically failed
    const loudnessCheck = result.qaReport!.checks.find(
      (c) => c.name === "loudness_target_valid",
    );
    expect(loudnessCheck).toBeDefined();
    expect(loudnessCheck!.passed).toBe(false);

    // State should NOT have transitioned to packaged
    const stateRaw = fs.readFileSync(
      path.join(projDir, "project_state.yaml"),
      "utf-8",
    );
    const finalState = parseYaml(stateRaw) as { current_state: string };
    expect(finalState.current_state).toBe("approved");
  });

  it("fails if not approved state", async () => {
    // Remove approval_record so reconcile computes state as critique_ready
    const projDir = createM4Project("pkg-wrong-state", {
      currentState: "critique_ready",
      includeApproval: false,
    });

    const result = await packageCommand(projDir, { skipRender: true });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("STATE_CHECK_FAILED");
    expect(result.error!.message).toContain("approved");
  });

  it("fails without handoff_resolution (Gate 10)", async () => {
    const projDir = createM4Project("pkg-no-handoff", {
      includeHandoff: false,
    });

    const result = await packageCommand(projDir, { skipRender: true });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("GATE_CHECK_FAILED");
    expect(result.error!.message).toContain("Gate 10");
  });
});

// ── Full Pipeline E2E ────────────────────────────────────────────

describe("M4 E2E: full pipeline", () => {
  it("captionCommand then packageCommand on the same project", async () => {
    const projDir = createM4Project("full-pipeline", {
      sourceOfTruth: "engine_render",
      captionSource: "none",
    });

    // Step 1: Run caption command
    const captionResult = captionCommand(projDir, {
      approvedBy: "operator",
      approvedAt: "2026-03-21T11:00:00Z",
    });
    expect(captionResult.success).toBe(true);
    expect(captionResult.captionApproval).toBeDefined();
    expect(captionResult.timelineUpdated).toBe(true);

    // Verify caption artifacts
    expect(
      fs.existsSync(path.join(projDir, "07_package/caption_source.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(projDir, "07_package/caption_approval.json")),
    ).toBe(true);

    // Re-stamp approval after caption projection changes timeline hash
    restampApproval(projDir, "engine_render");

    // Step 2: Run package command
    const packageResult = await packageCommand(projDir, {
      skipRender: true,
      precomputedMetrics: {
        integratedLufs: -15.9,
        truePeakDbtp: -1.8,
        videoDurationMs: 30000,
        audioDurationMs: 30008,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8200,
      },
      createdAt: "2026-03-21T12:00:00Z",
    });

    // Pipeline completes successfully and transitions to packaged
    expect(packageResult.success).toBe(true);
    expect(packageResult.sourceOfTruth).toBe("engine_render");
    expect(packageResult.qaReport).toBeDefined();
    expect(packageResult.qaReport!.passed).toBe(true);
    expect(packageResult.stateTransitioned).toBe(true);

    // Verify QA report written to disk
    const qaReportPath = path.join(projDir, "07_package/qa-report.json");
    expect(fs.existsSync(qaReportPath)).toBe(true);

    const qaReport = JSON.parse(
      fs.readFileSync(qaReportPath, "utf-8"),
    );
    expect(qaReport.source_of_truth).toBe("engine_render");
    expect(qaReport.metrics.integrated_lufs).toBe(-15.9);
    expect(qaReport.metrics.dialogue_occupancy_ratio).toBe(0.82);

    // Human-readable QA report also written
    expect(
      fs.existsSync(path.join(projDir, "07_package/qa-report.md")),
    ).toBe(true);

    // Package manifest written
    expect(
      fs.existsSync(path.join(projDir, "07_package/package_manifest.json")),
    ).toBe(true);

    // State is packaged
    const stateRaw = fs.readFileSync(
      path.join(projDir, "project_state.yaml"),
      "utf-8",
    );
    const finalState = parseYaml(stateRaw) as { current_state: string };
    expect(finalState.current_state).toBe("packaged");

    // Verify caption source matches project
    const captionSource = JSON.parse(
      fs.readFileSync(
        path.join(projDir, "07_package/caption_source.json"),
        "utf-8",
      ),
    );
    expect(captionSource.project_id).toBe("sample-mountain-reset");
    expect(captionSource.caption_policy.source).toBe("none");
  });
});

// ── Packaged State Resume + Invalidation ─────────────────────────

describe("M4 E2E: packaged state reconcile", () => {
  it("reconcile preserves packaged state when artifacts are intact", async () => {
    const projDir = createM4Project("packaged-resume", {
      sourceOfTruth: "engine_render",
      captionSource: "none",
    });

    // Run full pipeline to reach packaged
    captionCommand(projDir, {
      approvedBy: "operator",
      approvedAt: "2026-03-21T11:00:00Z",
    });
    restampApproval(projDir, "engine_render");

    const pkgResult = await packageCommand(projDir, {
      skipRender: true,
      precomputedMetrics: {
        integratedLufs: -16.0,
        truePeakDbtp: -1.8,
        videoDurationMs: 30000,
        audioDurationMs: 30005,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
      },
      createdAt: "2026-03-21T12:00:00Z",
    });
    expect(pkgResult.success).toBe(true);

    // Now reconcile — should stay packaged
    const result = reconcile(projDir, "test", "resume");
    expect(result.reconciled_state).toBe("packaged");
    expect(result.self_healed).toBe(false);
  });

  it("reconcile falls back to approved when qa_report is removed", async () => {
    const projDir = createM4Project("packaged-invalidate", {
      sourceOfTruth: "engine_render",
      captionSource: "none",
    });

    // Run full pipeline to reach packaged
    captionCommand(projDir, {
      approvedBy: "operator",
      approvedAt: "2026-03-21T11:00:00Z",
    });
    restampApproval(projDir, "engine_render");

    const pkgResult = await packageCommand(projDir, {
      skipRender: true,
      precomputedMetrics: {
        integratedLufs: -16.0,
        truePeakDbtp: -1.8,
        videoDurationMs: 30000,
        audioDurationMs: 30005,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
      },
      createdAt: "2026-03-21T12:00:00Z",
    });
    expect(pkgResult.success).toBe(true);

    // Remove qa_report to simulate invalidation
    fs.unlinkSync(path.join(projDir, "07_package/qa-report.json"));

    // Reconcile should fall back to approved
    const result = reconcile(projDir, "test", "resume");
    expect(result.reconciled_state).toBe("approved");
    expect(result.self_healed).toBe(true);
  });

  it("reconcile falls back to approved when source_of_truth_decision changes", async () => {
    const projDir = createM4Project("packaged-sot-change", {
      sourceOfTruth: "engine_render",
      captionSource: "none",
    });

    // Run full pipeline to reach packaged
    captionCommand(projDir, {
      approvedBy: "operator",
      approvedAt: "2026-03-21T11:00:00Z",
    });
    restampApproval(projDir, "engine_render");

    const pkgResult = await packageCommand(projDir, {
      skipRender: true,
      precomputedMetrics: {
        integratedLufs: -16.0,
        truePeakDbtp: -1.8,
        videoDurationMs: 30000,
        audioDurationMs: 30005,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
      },
      createdAt: "2026-03-21T12:00:00Z",
    });
    expect(pkgResult.success).toBe(true);

    // Verify packaged first
    const preResult = reconcile(projDir, "test", "pre-check");
    expect(preResult.reconciled_state).toBe("packaged");

    // Now change source_of_truth_decision from engine_render → nle_finishing
    const stateRaw = fs.readFileSync(
      path.join(projDir, "project_state.yaml"),
      "utf-8",
    );
    const stateDoc = parseYaml(stateRaw) as Record<string, unknown>;
    (stateDoc.handoff_resolution as Record<string, unknown>).source_of_truth_decision = "nle_finishing";
    fs.writeFileSync(
      path.join(projDir, "project_state.yaml"),
      stringifyYaml(stateDoc),
      "utf-8",
    );

    // Reconcile should detect mismatch and fall back to approved
    const result = reconcile(projDir, "test", "resume");
    expect(result.reconciled_state).toBe("approved");
    expect(result.self_healed).toBe(true);
    expect(result.stale_artifacts).toContain("qa_report");
    expect(result.stale_artifacts).toContain("package_manifest");
  });
});

// ── Render Pipeline Wiring ────────────────────────────────────────

describe("M4 E2E: render pipeline wiring", () => {
  it("engine_render without skipRender requires assemblyPath and calls render pipeline", async () => {
    const projDir = createM4Project("render-no-skip", {
      sourceOfTruth: "engine_render",
      captionSource: "none",
    });

    // Run caption command
    captionCommand(projDir, {
      approvedBy: "operator",
      approvedAt: "2026-03-21T11:00:00Z",
    });
    restampApproval(projDir, "engine_render");

    // Call packageCommand WITHOUT skipRender — no assembly.mp4 exists
    // so the render pipeline should fail with a clear error
    const result = await packageCommand(projDir, {
      precomputedMetrics: {
        integratedLufs: -16.0,
        truePeakDbtp: -1.8,
        videoDurationMs: 30000,
        audioDurationMs: 30005,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // The error should come from the render pipeline, not from completeness check
    expect(result.error!.message).toContain("Render pipeline failed");
  });

  it("engine_render without skipRender with explicit assemblyPath attempts render", async () => {
    const projDir = createM4Project("render-with-assembly", {
      sourceOfTruth: "engine_render",
      captionSource: "none",
    });

    // Run caption command
    captionCommand(projDir, {
      approvedBy: "operator",
      approvedAt: "2026-03-21T11:00:00Z",
    });
    restampApproval(projDir, "engine_render");

    // Create a fake assembly file — render pipeline will try ffmpeg and fail
    const assemblyPath = path.join(projDir, "05_timeline/assembly.mp4");
    fs.writeFileSync(assemblyPath, "not-a-real-mp4", "utf-8");

    const result = await packageCommand(projDir, {
      assemblyPath,
      precomputedMetrics: {
        integratedLufs: -16.0,
        truePeakDbtp: -1.8,
        videoDurationMs: 30000,
        audioDurationMs: 30005,
        dialogueWindowMs: 10000,
        observedNonSilentMs: 8500,
      },
    });

    // Should fail because ffmpeg can't process a fake mp4
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("Render pipeline failed");
  });
});
