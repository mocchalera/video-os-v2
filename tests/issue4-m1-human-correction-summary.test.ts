import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { buildApprovalRecord } from "../runtime/commands/review/index.js";
import {
  buildProductOutcomeMetrics,
  computeProductOutcomeMetricsHash,
  deriveHumanCorrectionSummary,
  type HumanCorrectionSummaryInput,
  type HumanNotesDoc,
  type TimelineDoc,
} from "../runtime/eval/product-outcome-metrics.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { createReviewRoundProject, runReviewRound, sha } from "./helpers/review-round-project.js";

const PROJECT_ID = "issue4-m1-media-free";
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Issue #4 M1 human correction summary", () => {
  it("projects an agent cut through human edit/approval from a media-free fixture", () => {
    const input = mediaFreeFixture();
    const metric = deriveHumanCorrectionSummary(input);

    expect(metric.status).toBe("measured");
    expect(metric.value).toMatchObject({
      project_id: PROJECT_ID,
      base_timeline: {
        path: "05_timeline/timeline.json",
        version: "agent-v1",
        sha256: hash("a"),
      },
      approved_timeline: {
        path: "05_timeline/approved.timeline.json",
        version: "approved-v1",
        sha256: hash("b"),
      },
      human_notes: {
        path: "06_review/human_notes.yaml",
        sha256: hash("c"),
      },
      review_generation: {
        generation_id: hash("d"),
        review_identity: hash("e"),
      },
      review_round: {
        round_index: 1,
        round_identity: hash("f"),
      },
      human_revision_diff: {
        path: "07_handoff/HND_ISSUE4/human_revision_diff.yaml",
        sha256: hash("g"),
        version: 2,
      },
      corrections: [
        { note_id: "NOTE_1", reason: "identity_confusion", domain: "shot", stable_clip_ref: "clip:clip_alpha" },
        { note_id: "NOTE_2", reason: "intent_mismatch", domain: "caption", stable_clip_ref: "unknown" },
        { note_id: "NOTE_3", reason: "chronology_context_confusion", domain: "unknown", stable_clip_ref: "unknown" },
      ],
      counts: {
        correction_count: 3,
        trim_delta_us: 300000,
        cut_delta: -1,
        base_video_clip_count: 2,
        approved_video_clip_count: 1,
        by_reason: {
          identity_confusion: 1,
          intent_mismatch: 1,
          chronology_context_confusion: 1,
        },
        by_domain: { shot: 1, caption: 1, unknown: 1 },
        by_operation: { trim: 1, simple_transition: 1, unmapped: 1 },
      },
      completeness: "complete",
    });
  });

  it("uses the real immutable artifact loader, approval binding route, and ledger projection", async () => {
    const project = createReviewRoundProject({ projectId: "issue4-m1-real-fixture" });
    tempDirs.push(project.root);
    const round = await runReviewRound(project, { decision: "approve" });
    const generationDir = path.join(
      project.root,
      "09_output/social-review/generations",
      round.generationId.slice("sha256:".length),
    );
    const outputPath = `09_output/social-review/generations/${round.generationId.slice("sha256:".length)}/review.mp4`;
    const receiptPath = `09_output/social-review/generations/${round.generationId.slice("sha256:".length)}/review-ready-receipt.json`;
    const receiptSha256 = sha(fs.readFileSync(path.join(project.root, receiptPath)));

    writeFixture(project.root, "06_review/human_notes.yaml", stringifyYaml({
      version: 1,
      project_id: project.projectId,
      notes: [{
        id: "NOTE_REAL_1",
        timestamp: "2026-09-02T00:01:00.000Z",
        reviewer: "operator",
        observation: "The shot needs a shorter opening.",
        severity: "suggestion",
        correction_reason: "intent_mismatch",
        domain: "shot",
        clip_ids: ["CLP_1"],
      }],
    }));
    writeFixture(project.root, "07_handoff/HND_ISSUE4_REAL/human_revision_diff.yaml", stringifyYaml({
      version: 2,
      project_id: project.projectId,
      handoff_id: "HND_ISSUE4_REAL",
      base_timeline_version: round.timelineVersion,
      capability_profile_id: "media-free-fixture",
      status: "review_required",
      summary: { trim: 1 },
      operations: [{
        operation_id: "OP_REAL_TRIM",
        type: "trim",
        target: { exchange_clip_id: "EX_CLP_1" },
        delta: { in_us: 100000, out_us: -50000 },
      }],
      identity: {
        base_timeline: {
          path: "05_timeline/timeline.json",
          version: round.timelineVersion,
          sha256: round.timelineSha256,
        },
        review_generation: {
          generation_id: round.generationId,
          review_identity: round.reviewIdentity,
          output: { path: outputPath, sha256: round.outputSha256 },
          review_ready_receipt: { path: receiptPath, sha256: receiptSha256 },
        },
        review_round: { round_index: round.roundIndex, round_identity: round.roundIdentity },
      },
    }));

    const beforeApproval = buildProductOutcomeMetrics(project.root, "2026-09-02T00:02:00.000Z");
    expect(beforeApproval.metrics.review_rounds.status).toBe("measured");
    expect(beforeApproval.metrics.human_correction_summary.status).toBe("unavailable");
    expect(beforeApproval.metrics.human_correction_summary.limitations[0]).toContain("approved timeline snapshot");

    const approvalRecord = buildApprovalRecord("clean", project.root, "operator");
    const binding = approvalRecord.artifact_versions?.human_correction_approval;
    expect(binding).toBeDefined();
    const approvalState = {
      version: 1,
      project_id: project.projectId,
      current_state: "approved",
      approval_record: approvalRecord,
    };
    expect(validateAgainstSchema(approvalState, "project-state.schema.json")).toEqual({ valid: true, errors: [] });
    writeFixture(project.root, "project_state.yaml", stringifyYaml(approvalState));

    const measured = buildProductOutcomeMetrics(project.root, "2026-09-02T00:02:00.000Z");
    expect(measured.metrics.human_correction_summary.status).toBe("measured");
    expect(measured.metrics.human_correction_summary.value).toMatchObject({
      project_id: project.projectId,
      review_round: { round_index: round.roundIndex, round_identity: round.roundIdentity },
      human_revision_diff: { path: "07_handoff/HND_ISSUE4_REAL/human_revision_diff.yaml", version: 2 },
      corrections: [{ note_id: "NOTE_REAL_1", reason: "intent_mismatch", domain: "shot" }],
    });

    const mixedBinding = structuredClone(binding!);
    mixedBinding.review_round.round_identity = sha("different-round");
    writeFixture(project.root, "project_state.yaml", stringifyYaml({
      version: 1,
      project_id: project.projectId,
      current_state: "approved",
      approval_record: { status: "clean", artifact_versions: { human_correction_approval: mixedBinding } },
    }));
    const mixed = buildProductOutcomeMetrics(project.root, "2026-09-02T00:02:00.000Z");
    expect(mixed.metrics.human_correction_summary.status).toBe("unavailable");
    expect(mixed.metrics.human_correction_summary.limitations[0]).toContain("Approval round identity");
  });

  it("rejects timeline symlinks and a captured timeline swap at build level", () => {
    const symlinkProject = timelineLoaderFixture("issue4-m1-symlink");
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue4-m1-external-"));
    tempDirs.push(symlinkProject, externalDir);
    const externalTimeline = path.join(externalDir, "timeline.json");
    fs.writeFileSync(externalTimeline, fs.readFileSync(path.join(symlinkProject, "05_timeline/timeline.json")));
    fs.unlinkSync(path.join(symlinkProject, "05_timeline/timeline.json"));
    fs.symlinkSync(externalTimeline, path.join(symlinkProject, "05_timeline/timeline.json"));
    expect(() => buildProductOutcomeMetrics(symlinkProject)).toThrow(/immutable inspection|symlink|namespace/i);

    const approvedSymlinkProject = timelineLoaderFixture("issue4-m1-approved-symlink");
    const approvedExternal = path.join(externalDir, "approved.timeline.json");
    fs.writeFileSync(approvedExternal, fs.readFileSync(path.join(approvedSymlinkProject, "05_timeline/approved.timeline.json")));
    fs.unlinkSync(path.join(approvedSymlinkProject, "05_timeline/approved.timeline.json"));
    fs.symlinkSync(approvedExternal, path.join(approvedSymlinkProject, "05_timeline/approved.timeline.json"));
    const approvedSymlinkReport = buildProductOutcomeMetrics(approvedSymlinkProject);
    expect(approvedSymlinkReport.metrics.human_correction_summary.status).toBe("unavailable");
    expect(approvedSymlinkReport.degraded_run_flags.some((flag) => flag.code === "malformed_approved_timeline")).toBe(true);

    const swappedProject = timelineLoaderFixture("issue4-m1-swap");
    const replacement = JSON.stringify({
      version: "approved-v2",
      project_id: PROJECT_ID,
      sequence: { fps_num: 30, fps_den: 1 },
      tracks: { video: [] },
    });
    const swappedPath = path.join(swappedProject, "05_timeline/approved.timeline.json");
    const swappedReport = buildProductOutcomeMetrics(swappedProject, "2026-09-02T00:00:00.000Z", {
      onTimelineCaptured: ({ path: capturedPath }) => {
        if (capturedPath !== "05_timeline/approved.timeline.json") return;
        const temporary = `${swappedPath}.replacement`;
        fs.writeFileSync(temporary, replacement);
        fs.renameSync(temporary, swappedPath);
      },
    });
    expect(swappedReport.metrics.human_correction_summary.status).toBe("unavailable");
    expect(swappedReport.metrics.human_correction_summary.limitations[0]).toContain("immutable revalidation");
  });

  it.each([
    ["foreign notes", (input: HumanCorrectionSummaryInput) => { input.humanNotes!.data.project_id = "foreign-project"; }],
    ["foreign base timeline", (input: HumanCorrectionSummaryInput) => { input.baseTimeline.data.project_id = "foreign-project"; }],
    ["unbound approved timeline", (input: HumanCorrectionSummaryInput) => { input.approvedTimeline = null; }],
    ["stale approval", (input: HumanCorrectionSummaryInput) => { input.approvalRecord!.artifact_versions!.human_correction_approval!.human_notes.sha256 = hash("z"); }],
    ["mixed approval round", (input: HumanCorrectionSummaryInput) => { input.approvalRecord!.artifact_versions!.human_correction_approval!.review_round.round_identity = hash("r2"); }],
    ["mixed approval diff", (input: HumanCorrectionSummaryInput) => { input.approvalRecord!.artifact_versions!.human_correction_approval!.human_revision_diff.sha256 = hash("r2-diff"); }],
    ["unbound review round", (input: HumanCorrectionSummaryInput) => { input.reviewRound = null; }],
    ["incomplete diff selection", (input: HumanCorrectionSummaryInput) => { input.revisionDiffSelectionComplete = false; }],
    ["unstable timeline snapshot", (input: HumanCorrectionSummaryInput) => { input.timelineIntegrityComplete = false; }],
  ])("rejects %s instead of promoting it to a measured summary", (_label, mutate) => {
    const input = mediaFreeFixture();
    mutate(input);

    const metric = deriveHumanCorrectionSummary(input);
    expect(metric.status).toBe("unavailable");
    expect(metric.value).toBeNull();
  });

  it("keeps the summary and product report hash deterministic and validates the schema", () => {
    const input = mediaFreeFixture();
    const first = deriveHumanCorrectionSummary(input);
    const second = deriveHumanCorrectionSummary(input);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(computeProductOutcomeMetricsHash({
      created_at: "2026-09-02T00:00:00.000Z",
      report_id: "POM_aaaaaaaaaaaaaaaa",
      metrics: { human_correction_summary: first },
    })).toBe(computeProductOutcomeMetricsHash({
      created_at: "2026-09-03T00:00:00.000Z",
      report_id: "POM_bbbbbbbbbbbbbbbb",
      metrics: { human_correction_summary: second },
    }));

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue4-m1-schema-"));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "05_timeline/timeline.json"),
      JSON.stringify(input.baseTimeline.data),
      "utf8",
    );
    const report = buildProductOutcomeMetrics(projectDir, "2026-09-02T00:00:00.000Z");
    report.metrics.human_correction_summary = first;
    expect(validateAgainstSchema(report, "product-outcome-metrics.schema.json")).toEqual({
      valid: true,
      errors: [],
    });

    const legacy = structuredClone(report) as unknown as {
      version: string;
      metrics: Record<string, unknown>;
    };
    legacy.version = "1.0.0";
    delete legacy.metrics.human_correction_summary;
    expect(validateAgainstSchema(legacy, "product-outcome-metrics.schema.json")).toEqual({
      valid: true,
      errors: [],
    });

    const incompleteNew = structuredClone(report) as unknown as {
      version: string;
      metrics: Record<string, unknown>;
    };
    delete incompleteNew.metrics.human_correction_summary;
    expect(validateAgainstSchema(incompleteNew, "product-outcome-metrics.schema.json").valid).toBe(false);
  });
});

function mediaFreeFixture(): HumanCorrectionSummaryInput {
  const baseTimeline: TimelineDoc = {
    version: "agent-v1",
    project_id: PROJECT_ID,
    sequence: { fps_num: 30, fps_den: 1 },
    tracks: {
      video: [{ clips: [
        { clip_id: "clip_alpha", segment_id: "segment_alpha", asset_id: "asset_a", timeline_in_frame: 0, timeline_duration_frames: 30 },
        { clip_id: "clip_beta", segment_id: "segment_beta", asset_id: "asset_b", timeline_in_frame: 30, timeline_duration_frames: 30 },
      ] }],
    },
  };
  const approvedTimeline: TimelineDoc = {
    ...baseTimeline,
    version: "approved-v1",
    tracks: {
      video: [{ clips: [
        { clip_id: "clip_alpha", segment_id: "segment_alpha", asset_id: "asset_a", timeline_in_frame: 0, timeline_duration_frames: 30 },
      ] }],
    },
  };
  const humanNotes: HumanNotesDoc = {
    version: 1,
    project_id: PROJECT_ID,
    notes: [
      {
        id: "NOTE_2",
        timestamp: "2026-09-02T00:01:00.000Z",
        reviewer: "operator",
        observation: "The caption intent does not fit the brief.",
        severity: "suggestion",
        correction_reason: "intent_mismatch",
        domain: "caption",
        clip_refs: ["clip:missing_caption"],
      },
      {
        id: "NOTE_1",
        timestamp: "2026-09-02T00:00:30.000Z",
        reviewer: "operator",
        observation: "The subject identity is unclear.",
        severity: "concern",
        correction_reason: "identity_confusion",
        domain: "shot",
        clip_ids: ["clip_alpha"],
      },
      {
        id: "NOTE_3",
        timestamp: "2026-09-02T00:01:30.000Z",
        reviewer: "operator",
        observation: "The chronology needs more context.",
        severity: "observation",
        correction_reason: "chronology_context_confusion",
      },
    ],
  };
  const generationId = hash("d");
  const reviewIdentity = hash("e");
  const roundIdentity = hash("f");
  const round: HumanCorrectionSummaryInput["reviewRound"] = {
    round_index: 1,
    round_identity: roundIdentity,
    review_identity: reviewIdentity,
    generation_id: generationId,
    timeline: { path: "05_timeline/timeline.json", version: "agent-v1", hash: hash("a") },
    output: {
      path: `09_output/social-review/generations/${generationId.slice("sha256:".length)}/review.mp4`,
      sha256: hash("h"),
    },
    qa_receipt: {
      path: `09_output/social-review/generations/${generationId.slice("sha256:".length)}/review-qa-receipt.json`,
      sha256: hash("i"),
      status: "pass",
    },
    review_ready_receipt: {
      path: `09_output/social-review/generations/${generationId.slice("sha256:".length)}/review-ready-receipt.json`,
      sha256: hash("j"),
    },
    ask: {
      event_identity: hash("k"),
      event_path: "06_review/review-rounds/ask.json",
      ask_id: "ASK_1",
      ask_payload_sha256: hash("l"),
    },
    response: {
      event_identity: hash("m"),
      event_path: "06_review/review-rounds/response.json",
      decision: "approve",
      response_sha256: hash("n"),
      artifact: {
        path: `06_review/review-round-responses/${hash("o").slice("sha256:".length)}.json`,
        sha256: hash("o"),
      },
    },
  };
  const diffDocument: Record<string, unknown> = {
    version: 2,
    project_id: PROJECT_ID,
    handoff_id: "HND_ISSUE4",
    base_timeline_version: "agent-v1",
    capability_profile_id: "media-free-fixture",
    status: "review_required",
    summary: { trim: 1, simple_transition: 1, unmapped: 1 },
    operations: [
      {
        operation_id: "OP_TRIM",
        type: "trim",
        target: { exchange_clip_id: "EX_ALPHA" },
        delta: { in_us: 100000, out_us: -200000 },
      },
      {
        operation_id: "OP_TRANSITION",
        type: "simple_transition",
        target: { exchange_clip_id: "EX_ALPHA" },
      },
    ],
    unmapped_edits: [{
      classification: "ambiguous_mapping",
      item_ref: "clip:missing",
      review_required: true,
      reason: "fixture remains ambiguous",
    }],
    identity: {
      base_timeline: { path: "05_timeline/timeline.json", version: "agent-v1", sha256: hash("a") },
      review_generation: {
        generation_id: generationId,
        review_identity: reviewIdentity,
        output: {
          path: `09_output/social-review/generations/${generationId.slice("sha256:".length)}/review.mp4`,
          sha256: hash("h"),
        },
        review_ready_receipt: {
          path: `09_output/social-review/generations/${generationId.slice("sha256:".length)}/review-ready-receipt.json`,
          sha256: hash("j"),
        },
      },
      review_round: { round_index: 1, round_identity: roundIdentity },
    },
  };
  return {
    projectId: PROJECT_ID,
    baseTimeline: {
      path: "05_timeline/timeline.json",
      version: "agent-v1",
      sha256: hash("a"),
      data: baseTimeline,
    },
    approvedTimeline: {
      path: "05_timeline/approved.timeline.json",
      version: "approved-v1",
      sha256: hash("b"),
      data: approvedTimeline,
    },
    humanNotes: {
      path: "06_review/human_notes.yaml",
      sha256: hash("c"),
      data: humanNotes,
    },
    approvalRecord: {
      status: "clean",
      approved_by: "operator",
      approved_at: "2026-09-02T00:02:00.000Z",
      artifact_versions: {
        timeline_version: hash("b"),
        base_timeline_version: "approved-v1",
        editorial_timeline_hash: hash("b"),
        human_notes_hash: hash("c"),
        human_correction_approval: {
          version: "human-correction-approval/v1",
          approved_timeline: {
            path: "05_timeline/approved.timeline.json",
            version: "approved-v1",
            sha256: hash("b"),
          },
          human_notes: { path: "06_review/human_notes.yaml", sha256: hash("c") },
          review_generation: {
            generation_id: generationId,
            review_identity: reviewIdentity,
            output: round.output,
            review_ready_receipt: round.review_ready_receipt,
          },
          review_round: { round_index: 1, round_identity: roundIdentity },
          human_revision_diff: {
            path: "07_handoff/HND_ISSUE4/human_revision_diff.yaml",
            sha256: hash("g"),
            version: 2,
          },
        },
      },
    },
    reviewRound: round,
    revisionDiff: {
      relativePath: "07_handoff/HND_ISSUE4/human_revision_diff.yaml",
      absolutePath: "/media-free-fixture/07_handoff/HND_ISSUE4/human_revision_diff.yaml",
      sha256: hash("g"),
      document: diffDocument,
      round: { round_index: 1, round_identity: roundIdentity, generation_id: generationId },
    },
    revisionDiffSelectionComplete: true,
    timelineIntegrityComplete: true,
  };
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function writeFixture(projectDir: string, relativePath: string, bytes: string): void {
  const target = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, "utf8");
}

function timelineLoaderFixture(label: string): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const timeline: TimelineDoc = {
    version: "agent-v1",
    project_id: PROJECT_ID,
    sequence: { fps_num: 30, fps_den: 1 },
    tracks: { video: [{ clips: [] }] },
  };
  const approved: TimelineDoc = { ...timeline, version: "approved-v1" };
  writeFixture(projectDir, "05_timeline/timeline.json", JSON.stringify(timeline));
  writeFixture(projectDir, "05_timeline/approved.timeline.json", JSON.stringify(approved));
  tempDirs.push(projectDir);
  return projectDir;
}
