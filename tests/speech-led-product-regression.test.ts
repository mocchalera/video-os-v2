import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import type { MarlinQAReport } from "../runtime/eval/marlin-qa-types.js";
import {
  evaluateSpeechLedArtifactContract,
  evaluateSpeechLedRealMediaRegression,
} from "../runtime/eval/speech-led-product-regression.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectId = "speech-led-contract-fixture";

describe("speech-led product regression", () => {
  it("validates a media-free canonical artifact contract without promoting a visual QA waiver", () => {
    const projectDir = createContractFixture();
    const report = evaluateSpeechLedArtifactContract(projectDir);

    expect(report.passed).toBe(true);
    expect(report.duration_sec).toBe(90);
    expect(report.visual_qa_status).toBe("blocked");
    expect(report.checks.find((check) => check.id === "visual_qa_state_is_explicit")).toMatchObject({
      passed: true,
      detail: expect.stringContaining("does not promote a waiver to verified"),
    });
  });

  it("fails the fast contract when the product profile, duration, or human approval drifts", () => {
    const projectDir = createContractFixture();
    const briefPath = path.join(projectDir, "01_intent", "creative_brief.yaml");
    const brief = readYamlRecord(briefPath);
    (brief.editorial as Record<string, unknown>).profile_hint = "event-recap";
    writeYaml(briefPath, brief);

    const blueprintPath = path.join(projectDir, "04_plan", "edit_blueprint.yaml");
    const blueprint = readYamlRecord(blueprintPath);
    (blueprint.caption_policy as Record<string, unknown>).styling_class = "cinematic";
    writeYaml(blueprintPath, blueprint);

    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const timeline = readJsonRecord(timelinePath);
    const videoTracks = (timeline.tracks as { video: Array<{ clips: Array<Record<string, unknown>> }> }).video;
    const lastClip = videoTracks[0].clips.at(-1)!;
    lastClip.timeline_duration_frames = 59 * 24 - Number(lastClip.timeline_in_frame);
    writeJson(timelinePath, timeline);

    const statePath = path.join(projectDir, "project_state.yaml");
    const state = readYamlRecord(statePath);
    (state.approval_record as Record<string, unknown>).approved_by = "roughcut-critic";
    writeYaml(statePath, state);

    const report = evaluateSpeechLedArtifactContract(projectDir);
    expect(report.passed).toBe(false);
    expect(failedCheckIds(report)).toEqual(expect.arrayContaining([
      "profile_interview_highlight",
      "speech_caption_style_readable",
      "timeline_duration_in_product_range",
      "operator_approved",
    ]));
  });

  it("passes real-media evidence only for a current, verified, non-mock Marlin result", () => {
    const artifactReport = evaluateSpeechLedArtifactContract(createContractFixture());
    const report = evaluateSpeechLedRealMediaRegression(artifactReport, {
      video_exists: true,
      render_duration_sec: 90,
      render_parity_pass: true,
      marlin_report: marlinReport(),
      min_score: 70,
    });

    expect(report.passed).toBe(true);
    expect(report.marlin_status).toBe("verified");
  });

  it.each([
    ["blocked/unavailable", { visual_qa: "blocked" as const, visual_qa_reason: "marlin_unavailable" }],
    ["unverified", { visual_qa: "unverified" as const, visual_qa_reason: "model_output_unverified" }],
    ["mock", { visual_qa: "verified" as const, mock: true }],
  ])("fails real-media evidence for %s visual QA", (_label, overrides) => {
    const artifactReport = evaluateSpeechLedArtifactContract(createContractFixture());
    const report = evaluateSpeechLedRealMediaRegression(artifactReport, {
      video_exists: true,
      render_duration_sec: 90,
      render_parity_pass: true,
      marlin_report: marlinReport(overrides),
    });

    expect(report.passed).toBe(false);
    expect(failedCheckIds(report)).toEqual(expect.arrayContaining(["marlin_visual_qa_verified"]));
  });

  it("fails real-media evidence when render parity or Marlin score is below the product gate", () => {
    const artifactReport = evaluateSpeechLedArtifactContract(createContractFixture());
    const report = evaluateSpeechLedRealMediaRegression(artifactReport, {
      video_exists: true,
      render_duration_sec: 90,
      render_parity_pass: false,
      marlin_report: marlinReport({ score: 69 }),
      min_score: 70,
    });

    expect(report.passed).toBe(false);
    expect(failedCheckIds(report)).toEqual(expect.arrayContaining([
      "render_duration_parity",
      "marlin_score_meets_threshold",
    ]));
  });
});

function createContractFixture(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "speech-led-contract-"));
  for (const relativeDir of ["01_intent", "04_plan", "05_timeline", "06_review"]) {
    fs.mkdirSync(path.join(projectDir, relativeDir), { recursive: true });
  }

  const brief = readYamlRecord(path.join(repoRoot, "projects/demo/01_intent/creative_brief.yaml"));
  brief.project_id = projectId;
  const project = brief.project as Record<string, unknown>;
  project.id = projectId;
  project.runtime_target_sec = 90;
  project.duration_mode = "guide";
  brief.order_policy = "editorial";
  brief.caption_policy = "manual";
  brief.editorial = {
    distribution_channel: "event_recap",
    aspect_ratio: "16:9",
    embed_context: "standalone",
    hook_priority: "balanced",
    credibility_bias: "high",
    profile_hint: "interview-highlight",
    policy_hint: "interview",
    allow_inference: false,
  };
  writeYaml(path.join(projectDir, "01_intent/creative_brief.yaml"), brief);

  const blueprint = readYamlRecord(path.join(repoRoot, "projects/demo/04_plan/edit_blueprint.yaml"));
  blueprint.project_id = projectId;
  blueprint.timeline_order = "editorial";
  blueprint.caption_policy = {
    language: "ja",
    delivery_mode: "burn_in",
    source: "transcript",
    styling_class: "clean-lower-third",
  };
  blueprint.resolved_profile = {
    id: "interview-highlight",
    source: "explicit_hint",
    rationale: "Synthetic contract-only fixture",
  };
  writeYaml(path.join(projectDir, "04_plan/edit_blueprint.yaml"), blueprint);

  const timeline = readJsonRecord(path.join(repoRoot, "projects/demo/05_timeline/timeline.json"));
  timeline.project_id = projectId;
  const videoTracks = (timeline.tracks as { video: Array<{ clips: Array<Record<string, unknown>> }> }).video;
  const lastClip = videoTracks[0].clips.at(-1)!;
  lastClip.timeline_duration_frames = 90 * 24 - Number(lastClip.timeline_in_frame);
  writeJson(path.join(projectDir, "05_timeline/timeline.json"), timeline);

  const review = readYamlRecord(path.join(repoRoot, "projects/demo/06_review/review_report.yaml"));
  review.project_id = projectId;
  review.timeline_version = String(timeline.version);
  review.summary_judgment = {
    status: "approved",
    rationale: "Contract-only operator-approved artifact fixture.",
    confidence: 1,
  };
  review.fatal_issues = [];
  review.visual_qa = {
    status: "blocked",
    reason: "real_media_runs_only_on_explicit_or_scheduled_runner",
    min_score: 70,
    issues: { total: 0, critical: 0, warning: 0, info: 0 },
    issue_summaries: [],
  };
  review.visual_qa_waiver = true;
  review.visual_qa_waiver_reason = "Contract fixture has no media; this waiver is not real-media success evidence.";
  writeYaml(path.join(projectDir, "06_review/review_report.yaml"), review);

  writeYaml(path.join(projectDir, "project_state.yaml"), {
    version: 1,
    project_id: projectId,
    current_state: "packaged",
    updated_at: "2026-07-10T00:00:00Z",
    approval_record: {
      status: "clean",
      approved_by: "operator",
      approved_at: "2026-07-10T00:00:00Z",
    },
    handoff_resolution: {
      handoff_id: "HND_speech_led_contract_fixture",
      status: "decided",
      source_of_truth_decision: "engine_render",
      decided_by: "operator",
      decided_at: "2026-07-10T00:00:00Z",
    },
    gates: {
      analysis_gate: "ready",
      compile_gate: "open",
      planning_gate: "open",
      timeline_gate: "open",
      review_gate: "open",
      packaging_gate: "open",
    },
    history: [],
  });

  return projectDir;
}

function marlinReport(overrides: Partial<MarlinQAReport> = {}): MarlinQAReport {
  return {
    version: "1",
    project_id: projectId,
    video_path: "09_output/rough-cut.mp4",
    video_duration_sec: 90,
    overall_assessment: "Speech-led rough cut is visually coherent.",
    scene_descriptions: [],
    issues: [],
    pacing_assessment: { too_fast: false, too_slow: false, notes: "Balanced." },
    emotion_arc_assessment: { follows_brief: true, notes: "Matches brief." },
    score: 88,
    visual_qa: "verified",
    mock: false,
    ...overrides,
  };
}

function failedCheckIds(report: { checks: Array<{ id: string; passed: boolean }> }): string[] {
  return report.checks.filter((check) => !check.passed).map((check) => check.id);
}

function readYamlRecord(filePath: string): Record<string, unknown> {
  return parseYaml(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

function writeYaml(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, stringifyYaml(value), "utf-8");
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
