import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  buildProductOutcomeMetrics,
  computeProductOutcomeMetricsHash,
  writeProductOutcomeMetrics,
} from "../runtime/eval/product-outcome-metrics.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { createReviewRoundProject, runReviewRound, sha, type RoundProject } from "./helpers/review-round-project.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("product outcome metrics", () => {
  it("projects measured, estimated, and degraded outcomes from canonical artifacts", async () => {
    const projectDir = await fixtureProject(true);
    const report = buildProductOutcomeMetrics(projectDir, "2026-07-10T12:00:00.000Z");

    expect(report.metrics.time_to_first_usable_cut).toMatchObject({
      status: "measured",
      value: 120,
      unit: "seconds",
    });
    expect(report.metrics.human_intervention_minutes).toMatchObject({
      status: "estimated",
      value: 30,
      unit: "minutes",
    });
    expect(report.metrics.kept_cut_ratio).toMatchObject({
      value: 1,
      numerator: 2,
      denominator: 2,
    });
    expect(report.metrics.accepted_proposal_ratio).toMatchObject({
      value: 1,
      numerator: 1,
      denominator: 1,
    });
    expect(report.metrics.post_export_edit_distance.value).toMatchObject({
      operation_count: 2,
      unmapped_count: 1,
      changed_clip_count: 1,
      trim_delta_us: 300000,
    });
    expect(report.metrics.review_issue_density.value).toMatchObject({
      total_issues: 2,
      issues_per_minute: 6,
    });
    expect(report.metrics.rerun_duration).toMatchObject({
      status: "measured",
      value: 90,
      method: "latest_completed_pipeline_timing_run",
    });
    expect(report.metrics.rerun_cost.status).toBe("unavailable");
    expect(report.metrics.review_rounds).toMatchObject({
      status: "measured",
      value: { rounds: [{ round_index: 1 }], completeness: "complete" },
    });
    expect(report.degraded_run_flags.map((flag) => flag.code)).toEqual([
      "analysis_partial_override",
      "pipeline_stages_degraded",
      "visual_qa_waived",
    ]);
    expect(report.evidence_roles.human_preference).toEqual([
      "06_review/human_notes.yaml",
      "project_state.yaml",
    ]);
    expect(validateAgainstSchema(report, "product-outcome-metrics.schema.json")).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("reports unavailable metrics instead of inventing missing human or NLE evidence", async () => {
    const projectDir = await fixtureProject(false);
    const report = buildProductOutcomeMetrics(projectDir, "2026-07-10T12:00:00.000Z");

    expect(report.metrics.human_intervention_minutes.status).toBe("unavailable");
    expect(report.metrics.kept_cut_ratio.status).toBe("unavailable");
    expect(report.metrics.accepted_proposal_ratio.status).toBe("unavailable");
    expect(report.metrics.post_export_edit_distance.status).toBe("unavailable");
    expect(report.metrics.rerun_duration.status).toBe("unavailable");
    expect(report.metrics.review_rounds.status).toBe("unavailable");
    expect(report.metrics.review_rounds.value).toBeNull();
    expect(report.degraded_run_flags).toEqual([]);
  });

  it("keeps report identity stable across creation timestamps and writes atomically", async () => {
    const projectDir = await fixtureProject(true);
    const first = buildProductOutcomeMetrics(projectDir, "2026-07-10T12:00:00.000Z");
    const second = buildProductOutcomeMetrics(projectDir, "2026-07-11T12:00:00.000Z");

    expect(first.report_id).toBe(second.report_id);
    expect(computeProductOutcomeMetricsHash(first)).toBe(computeProductOutcomeMetricsHash(second));

    const written = writeProductOutcomeMetrics(projectDir, undefined, "2026-07-10T12:00:00.000Z");
    expect(written.outputPath).toBe(path.join(projectDir, "08_eval/product_outcome_metrics.json"));
    expect(fs.existsSync(written.outputPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(written.outputPath, "utf-8")).report_id).toBe(first.report_id);
  });
});

async function fixtureProject(withEvidence: boolean): Promise<string> {
  const project = createReviewRoundProject({ projectId: "fixture" });
  tempDirs.push(project.root);
  if (!withEvidence) {
    // Remove the baseline and progress/patch evidence so retention/rerun/proposal have no inputs.
    fs.rmSync(path.join(project.root, "05_timeline/v001.timeline.json"));
    fs.rmSync(path.join(project.root, "progress.json"));
    fs.rmSync(path.join(project.root, "06_review/review_patch.json"));
    return project.root;
  }
  // review_patch.json is a generation input; it must exist before the round
  // and remain unchanged afterwards.
  writeJson(project.root, "06_review/review_patch.json", { timeline_version: "2", operations: [] });
  const round = await runReviewRound(project, { decision: "request_changes" });
  writeEvidenceArtifacts(project, round);
  return project.root;
}

function writeEvidenceArtifacts(
  project: RoundProject,
  round: Awaited<ReturnType<typeof runReviewRound>>,
): void {
  const { root, projectId, paths } = project;
  writeYaml(root, "project_state.yaml", {
    version: 1,
    project_id: projectId,
    current_state: "review_ready",
    gates: { analysis_gate: "partial_override", review_gate: "open" },
    analysis_override: { status: "active", reason: "Optional visual lane unavailable." },
    history: [
      {
        from_state: "intent_pending",
        to_state: "intent_locked",
        actor: "status",
        trigger: "status",
        timestamp: "2026-07-10T09:00:00.000Z",
      },
      {
        from_state: "timeline_drafted",
        to_state: "approved",
        actor: "operator",
        trigger: "operator-approval",
        timestamp: "2026-07-10T09:02:00.000Z",
      },
    ],
    approval_record: { approved_by: "operator", approved_at: "2026-07-10T10:30:00.000Z" },
  });
  writeYaml(root, "06_review/human_notes.yaml", {
    version: 1,
    project_id: projectId,
    notes: [
      {
        id: "HN_1",
        timestamp: "2026-07-10T10:00:00.000Z",
        reviewer: "operator",
        observation: "Use the alternate.",
        severity: "suggestion",
        directive_type: "replace_segment",
        approved_segment_ids: ["SEG_2"],
      },
    ],
  });
  writeYaml(root, "06_review/review_report.yaml", {
    version: "1",
    project_id: projectId,
    timeline_version: round.timelineVersion,
    summary_judgment: { status: "approved", rationale: "Operator approved." },
    strengths: [],
    weaknesses: [{ summary: "Pacing" }],
    fatal_issues: [],
    warnings: [{ summary: "Visual QA unavailable", severity: "warning" }],
    mismatches_to_brief: [],
    mismatches_to_blueprint: [],
    recommended_next_pass: { goal: "Finish", actions: [], preserve: [] },
    visual_qa: {
      status: "blocked",
      reason: "Model unavailable",
      min_score: 70,
      issues: { total: 0, critical: 0, warning: 0, info: 0 },
      issue_summaries: [],
    },
    visual_qa_waiver: true,
    visual_qa_waiver_reason: "Operator watched the full video.",
  });
  writeJson(root, "06_review/review_metrics.json", { total_checks: 2 });
  writeJson(root, "progress.json", {
    project_id: projectId,
    phase: "review",
    gate: 5,
    status: "completed",
    completed: 1,
    total: 1,
    artifacts_created: [],
    errors: [],
    started_at: "2026-07-10T11:00:00.000Z",
    updated_at: "2026-07-10T11:00:10.000Z",
  });
  writeJson(root, "03_analysis/pipeline-timings.json", {
    version: 1,
    project_id: projectId,
    updated_at: "2026-07-10T11:01:30.000Z",
    runs: [{
      run_id: "RUN_1",
      project_id: projectId,
      entrypoint: "test",
      status: "completed",
      started_at: "2026-07-10T11:00:00.000Z",
      completed_at: "2026-07-10T11:01:30.000Z",
      stages: [
        { stage: "stt", status: "completed", started_at: "2026-07-10T11:00:00.000Z" },
        { stage: "marlin", status: "skipped", started_at: "2026-07-10T11:00:30.000Z" },
      ],
    }],
  });
  const generationDir = `09_output/social-review/generations/${round.generationId.slice("sha256:".length)}`;
  writeYaml(root, "07_handoff/HND_1/human_revision_diff.yaml", {
    version: 2,
    project_id: projectId,
    handoff_id: "HND_1",
    base_timeline_version: round.timelineVersion,
    capability_profile_id: "premiere",
    status: "review_required",
    summary: { trim: 1, reorder: 1, unmapped: 1 },
    operations: [{
      operation_id: "OP_1",
      type: "trim",
      target: { exchange_clip_id: "XCLIP_1" },
      delta: { in_us: 100000, out_us: -200000 },
    }],
    unmapped_edits: [{ classification: "split_clip", item_ref: "XCLIP_2", review_required: true, reason: "split" }],
    identity: {
      base_timeline: { path: "05_timeline/timeline.json", version: round.timelineVersion, sha256: round.timelineSha256 },
      review_generation: {
        generation_id: round.generationId,
        review_identity: round.reviewIdentity,
        output: { path: `${generationDir}/review.mp4`, sha256: round.outputSha256 },
        review_ready_receipt: {
          path: `${generationDir}/review-ready-receipt.json`,
          sha256: sha(fs.readFileSync(path.join(root, generationDir, "review-ready-receipt.json"))),
        },
      },
      review_round: { round_index: 1, round_identity: round.roundIdentity },
    },
  });
}

function writeJson(projectDir: string, relativePath: string, data: unknown): void {
  const outputPath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function writeYaml(projectDir: string, relativePath: string, data: unknown): void {
  const outputPath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, stringifyYaml(data), "utf-8");
}
