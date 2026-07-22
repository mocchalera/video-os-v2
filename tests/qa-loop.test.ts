import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "../runtime/artifacts/types.js";
import type { BriefAlignmentAxis, BriefAlignmentReport, StageResult } from "../runtime/eval/brief-alignment-types.js";
import type { MarlinQAReport } from "../runtime/eval/marlin-qa-types.js";
import {
  QATransactionRestoreError,
  runQALoop,
  type QALoopOptions,
} from "../runtime/eval/qa-loop.js";
import type { QAIssue } from "../runtime/eval/qa-issue-detector.js";
import { proposeFixes, type QAFix } from "../runtime/eval/qa-fix-proposer.js";
import type { FootageSearchResult, SearchFootageInput } from "../runtime/tools/footage-search.js";
import type { ReviewMetricsArtifact, ReviewMetricsInputs } from "../runtime/review/metrics.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(): {
  projectDir: string;
  brief: CreativeBrief;
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
  timeline: TimelineIR;
} {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-qa-loop-"));
  tempDirs.push(projectDir);
  const brief = creativeBrief();
  const selects = selectsFixture();
  const blueprint = blueprintFixture();
  const timeline = timelineFixture();

  writeYaml(path.join(projectDir, "01_intent", "creative_brief.yaml"), brief);
  writeYaml(path.join(projectDir, "04_plan", "selects_candidates.yaml"), selects);
  writeYaml(path.join(projectDir, "04_plan", "edit_blueprint.yaml"), blueprint);
  writeJson(path.join(projectDir, "03_analysis", "segments.json"), {
    project_id: "qa-loop-fixture",
    artifact_version: "1",
    items: [
      segment("SEG_A"),
      segment("SEG_B"),
      segment("SEG_R"),
      segment("SEG_X"),
    ],
  });
  writeFile(path.join(projectDir, "source.mov"), "media");
  writeJson(path.join(projectDir, "03_analysis", "assets.json"), {
    project_id: "qa-loop-fixture",
    artifact_version: "1",
    items: ["SEG_A", "SEG_B", "SEG_R", "SEG_X"].map((segmentId) => ({
      asset_id: `AST_${segmentId}`,
      source_locator: "source.mov",
    })),
  });
  writeJson(path.join(projectDir, "05_timeline", "timeline.json"), timeline);
  writeJson(path.join(projectDir, "05_timeline", "adjacency_analysis.json"), {
    version: "2",
    project_id: "qa-loop-fixture",
    pairs: [],
  });
  writeFile(path.join(projectDir, "09_output", "rough-cut.mp4"), "render-0");
  writeJson(path.join(projectDir, "09_output", "render-report.json"), { iteration: 0 });

  return { projectDir, brief, selects, blueprint, timeline };
}

function creativeBrief(): CreativeBrief {
  return {
    version: "1",
    project_id: "qa-loop-fixture",
    project: {
      id: "qa-loop-fixture",
      title: "QA Loop Fixture",
      strategy: "fixture",
      runtime_target_sec: 10,
    },
    message: { primary: "fixture" },
    emotion_curve: ["start", "finish"],
  };
}

function selectsFixture(): SelectsCandidates {
  return {
    version: "1",
    project_id: "qa-loop-fixture",
    candidates: [
      candidate("SEG_A"),
      candidate("SEG_B"),
      candidate("SEG_R"),
    ],
  };
}

function candidate(segmentId: string): SelectsCandidates["candidates"][number] {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 5_000_000,
    role: "support",
    why_it_matches: `candidate ${segmentId}`,
    risks: [],
    confidence: 0.7,
    eligible_beats: ["b1"],
    evidence: [segmentId],
  };
}

function blueprintFixture(): EditBlueprint {
  return {
    version: "1",
    project_id: "qa-loop-fixture",
    sequence_goals: ["fixture"],
    beats: [
      {
        id: "b1",
        label: "Beat 1",
        target_duration_frames: 120,
        required_roles: ["support"],
        candidate_plan: {
          primary_candidate_ref: "SEG_A",
          fallback_candidate_refs: ["SEG_B", "SEG_R"],
        },
      },
    ],
    pacing: {
      opening_cadence: "steady",
      middle_cadence: "steady",
      ending_cadence: "steady",
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b1",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
    },
  };
}

function timelineFixture(segmentId = "SEG_A"): TimelineIR {
  return {
    version: "1",
    project_id: "qa-loop-fixture",
    created_at: "2026-06-20T00:00:00.000Z",
    sequence: {
      name: "qa-loop-fixture",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [
        {
          track_id: "V1",
          kind: "video",
          clips: [
            {
              clip_id: "CLP_A",
              segment_id: segmentId,
              asset_id: `AST_${segmentId}`,
              src_in_us: 0,
              src_out_us: 5_000_000,
              timeline_in_frame: 0,
              timeline_duration_frames: 120,
              role: "support",
              motivation: "fixture",
              beat_id: "b1",
              fallback_segment_ids: [],
              confidence: 0.7,
              quality_flags: [],
            },
          ],
        },
      ],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "",
      blueprint_path: "",
      selects_path: "",
      compiler_version: "test",
    },
  };
}

function segment(segmentId: string) {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 6_000_000,
    duration_us: 6_000_000,
    rep_frame_us: 3_000_000,
    summary: `segment ${segmentId}`,
    transcript_excerpt: "",
    quality_flags: [],
    tags: [],
    visual_quality: { scores: { composition_score: 0.8, motion_quality: 0.9 } },
    segment_type: "shot",
    transcript_ref: null,
    confidence: { boundary: { score: 1, source: "test", status: "ok" } },
    provenance: { boundary: { stage: "test", method: "test", connector_version: "test", policy_hash: "test", request_hash: "test" } },
  };
}

function externalSearchResult(): FootageSearchResult {
  return {
    segment_id: "SEG_X",
    asset_id: "AST_SEG_X",
    src_in_us: 0,
    src_out_us: 6_000_000,
    duration_us: 6_000_000,
    score: 0.9,
    scores: { final: 0.9, quality: 0.85 },
    match_reason: "external canonical repair",
    summary: "search summary",
    tags: [],
    quality_flags: [],
    quality: { composition_score: 0.99 },
    evidence_refs: [{ field: "summary", value: "search match", source_refs: ["03_analysis/segments.json"] }],
  };
}

function marlin(score: number, withIssue = true, overrides: Partial<MarlinQAReport> = {}): MarlinQAReport {
  return {
    version: "1",
    project_id: "qa-loop-fixture",
    video_path: "09_output/rough-cut.mp4",
    video_duration_sec: 10,
    overall_assessment: "fixture",
    scene_descriptions: [],
    issues: withIssue
      ? [
          {
            timestamp_sec: 1,
            duration_sec: 1,
            category: "camera_shake",
            severity: "warning",
            description: "Camera shakes.",
            suggestion: "Replace.",
          },
        ]
      : [],
    pacing_assessment: { too_fast: false, too_slow: false, notes: "" },
    emotion_arc_assessment: { follows_brief: true, notes: "" },
    score,
    ...overrides,
  };
}

function alignment(score: number, lowMustHave = false): BriefAlignmentReport {
  const axes = Object.fromEntries(
    ([
      "intent_message_alignment",
      "must_have_coverage",
      "emotion_curve_alignment",
      "narrative_structure",
      "pacing_coherence",
      "visual_variety_and_focus",
    ] as BriefAlignmentAxis[]).map((axisName) => [
      axisName,
      {
        score: lowMustHave && axisName === "must_have_coverage" ? 0.3 : score,
        confidence: 0.8,
        judge_source: "deterministic",
        evidence: ["fixture"],
        gaps: lowMustHave && axisName === "must_have_coverage" ? ["must_have 'bridge' has no matching candidate evidence"] : [],
      },
    ]),
  ) as StageResult["axes"];
  return {
    version: "1",
    project: "qa-loop-fixture",
    evaluated_at: "2026-06-20T00:00:00.000Z",
    brief_hash: "sha256:test",
    stages: {
      selects: { score, axes },
      blueprint: { score, axes },
    },
    composite: score,
    notes: [],
  };
}

function advisoryReviewMetrics(): ReviewMetricsArtifact {
  const zero = { pass: 0, warn: 0, fail: 0, skipped: 0 };
  return {
    version: "2",
    project_id: "qa-loop-fixture",
    timeline_version: "1",
    summary: {
      total_checks: 1,
      by_status: { ...zero, fail: 1 },
      by_tier: {
        emotion: { ...zero },
        story: { ...zero },
        rhythm: { ...zero },
        eye_trace: { ...zero },
        plane_2d: { ...zero, fail: 1 },
        space_3d: { ...zero },
        audio: { ...zero },
      },
    },
    checks: [{
      id: "plane_2d.framing_jump",
      tier: "plane_2d",
      status: "fail",
      measured: {
        violations: [{
          pair_id: "V1:b1->b2",
          left_clip_id: "CLP_A",
          right_clip_id: "CLP_B",
          relationship: "risky_jump",
          outcome: "violation",
          description: "Advisory framing jump.",
        }],
        warnings: [],
      },
      threshold: { advisory: true },
      evidence: ["fixture"],
    }],
  };
}

function trimFix(issue: QAIssue, iteration = 1): QAFix {
  return {
    issue_id: issue.issue_id,
    issue,
    fix_type: "trim",
    target_clip_id: issue.clip_id ?? "CLP_A",
    target_beat_id: issue.beat_id ?? "b1",
    expected_improvement: 0.4,
    risk: "low",
    trim_hint: {
      source_center_us: 1_000_000 + iteration * 100_000,
      preferred_duration_us: 4_000_000 - iteration * 100_000,
      window_start_us: 0,
      window_end_us: 5_000_000,
      recommended_in_us: iteration * 100_000,
      recommended_out_us: 4_500_000,
      rationale: `fixture trim ${iteration}`,
    },
  } as QAFix & { trim_hint: Record<string, unknown> };
}

function swapFix(issue: QAIssue): QAFix {
  return {
    issue_id: issue.issue_id,
    issue,
    fix_type: "swap",
    target_clip_id: issue.clip_id ?? "CLP_A",
    target_beat_id: issue.beat_id ?? "b1",
    replacement: {
      segment_id: "SEG_R",
      search_mode: "visual",
      search_score: 0.9,
      reason: "transaction fixture replacement",
    },
    expected_improvement: 0.4,
    risk: "low",
  };
}

function loopOptions(scores: number[], opts: Partial<QALoopOptions> = {}): QALoopOptions {
  let qaIndex = 0;
  let alignIndex = 0;
  return {
    runMarlinQA: vi.fn(async () => marlin(scores[Math.min(qaIndex++, scores.length - 1)] * 100)),
    runBriefAlignment: vi.fn(async () => alignment(scores[Math.min(alignIndex++, scores.length - 1)])),
    proposeFixes: vi.fn(async (issues: QAIssue[], _timeline, _selects, _projectDir, iteration: number) =>
      issues.slice(0, 1).map((issueItem: QAIssue) => trimFix(issueItem, iteration))
    ),
    compile: vi.fn((_projectDir, _selects, _blueprint, iteration) => ({
      ...timelineFixture(),
      version: String(iteration + 1),
    })),
    render: vi.fn(async (projectDir, _timeline, iteration) => {
      const output = path.join(projectDir, "09_output", "rough-cut.mp4");
      writeFile(output, `render-${iteration}`);
      return output;
    }),
    now: () => new Date("2026-06-20T00:00:00.000Z"),
    ...opts,
  };
}

function transactionLoopOptions(scores: number[], opts: Partial<QALoopOptions> = {}): QALoopOptions {
  return loopOptions(scores, {
    maxIterations: 1,
    proposeFixes: vi.fn(async (issues: QAIssue[]) => issues.slice(0, 1).map(swapFix)),
    compile: vi.fn((projectDir) => {
      writeJson(path.join(projectDir, "05_timeline", "adjacency_analysis.json"), {
        version: "2",
        project_id: "qa-loop-fixture",
        pairs: [{ candidate: "SEG_R" }],
      });
      return { ...timelineFixture("SEG_R"), version: "2" };
    }),
    render: vi.fn(async (projectDir, _timeline, iteration) => {
      const output = path.join(projectDir, "09_output", "rough-cut.mp4");
      writeFile(output, `render-${iteration}`);
      writeJson(path.join(projectDir, "09_output", "render-report.json"), { iteration });
      return output;
    }),
    ...opts,
  });
}

const canonicalArtifactPaths = [
  "04_plan/selects_candidates.yaml",
  "04_plan/edit_blueprint.yaml",
  "05_timeline/timeline.json",
  "05_timeline/adjacency_analysis.json",
  "09_output/rough-cut.mp4",
  "09_output/render-report.json",
] as const;

function captureCanonicalArtifacts(projectDir: string): Map<string, Buffer> {
  return new Map(canonicalArtifactPaths.map((relativePath) => [
    relativePath,
    fs.readFileSync(path.join(projectDir, relativePath)),
  ]));
}

function expectCanonicalArtifactsToEqual(projectDir: string, expected: Map<string, Buffer>): void {
  for (const relativePath of canonicalArtifactPaths) {
    expect(fs.readFileSync(path.join(projectDir, relativePath)).equals(expected.get(relativePath)!)).toBe(true);
  }
}

function transactionTempDirs(): Set<string> {
  return new Set(
    fs.readdirSync(os.tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("video-os-qa-transaction-"))
      .map((entry) => path.join(os.tmpdir(), entry.name)),
  );
}

function expectNoNewTransactionTempDirs(before: Set<string>): void {
  expect([...transactionTempDirs()].filter((dir) => !before.has(dir))).toEqual([]);
}

describe("runQALoop", () => {
  it("treats canonical audio-only visual QA as not applicable while continuing alignment and review metrics", async () => {
    const project = makeProject();
    const visualClip = project.timeline.tracks.video[0].clips[0];
    project.timeline.tracks.video = [{ track_id: "V1", kind: "video", clips: [] }];
    project.timeline.tracks.audio = [{
      track_id: "A1",
      kind: "audio",
      clips: [{ ...visualClip, clip_id: "ACL_A", role: "dialogue" }],
    }];
    writeJson(path.join(project.projectDir, "05_timeline", "timeline.json"), project.timeline);
    const runMarlinQA = vi.fn(async () => marlin(100, false));
    const runBriefAlignment = vi.fn(async () => alignment(0.82));
    const evaluateReviewMetrics = vi.fn(() => advisoryReviewMetrics());

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      {
        maxIterations: 1,
        runMarlinQA,
        runBriefAlignment,
        evaluateReviewMetrics,
        proposeFixes: vi.fn(async () => []),
      },
    );

    expect(runMarlinQA).not.toHaveBeenCalled();
    expect(runBriefAlignment).toHaveBeenCalledTimes(1);
    expect(evaluateReviewMetrics).toHaveBeenCalledTimes(1);
    expect(result.initial_score).toBe(0.82);
    expect(result.final_score).toBe(0.82);
    expect(result.visual_qa).toEqual({
      status: "not_applicable",
      reason: "audio_only_timeline",
    });
    expect(result.reports[0]).toMatchObject({
      visual_qa: "not_applicable",
      visual_qa_reason: "audio_only_timeline",
      evaluation_status: "available",
    });
    expect(result.reports[0].issues.some((issue) =>
      issue.source_category?.startsWith("visual_qa_")
    )).toBe(false);
  });

  it("computes injected review metrics for the current timeline and surfaces advisory issues without scoring or proposing", async () => {
    const project = makeProject();
    const first = project.timeline.tracks.video[0].clips[0];
    project.timeline.tracks.video[0].clips.push({
      ...structuredClone(first),
      clip_id: "CLP_B",
      segment_id: "SEG_B",
      asset_id: "AST_SEG_B",
      timeline_in_frame: 120,
      beat_id: "b2",
    });
    writeJson(path.join(project.projectDir, "05_timeline", "timeline.json"), project.timeline);
    const evaluateReviewMetrics = vi.fn((_inputs: ReviewMetricsInputs, _iteration: number) =>
      advisoryReviewMetrics());
    const propose = vi.fn(async () => [] as QAFix[]);
    const opts = loopOptions([0.8], {
      maxIterations: 1,
      runMarlinQA: vi.fn(async () => marlin(80, false)),
      runBriefAlignment: vi.fn(async () => alignment(0.8)),
      evaluateReviewMetrics,
      proposeFixes: propose,
    });

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    expect(evaluateReviewMetrics).toHaveBeenCalledTimes(1);
    expect(evaluateReviewMetrics.mock.calls[0][0].timeline).toBe(project.timeline);
    expect(result.initial_score).toBe(0.8);
    expect(result.final_score).toBe(0.8);
    expect(result.fixes_applied_total).toBe(0);
    expect(propose).not.toHaveBeenCalled();
    expect(result.reports.every((report) => report.issues.some((issue) =>
      issue.source === "review_metrics" &&
      issue.source_category === "plane_2d.framing_jump" &&
      issue.fixable === false &&
      issue.adjacent_clip_ids?.before === "CLP_A" &&
      issue.adjacent_clip_ids?.after === "CLP_B"
    ))).toBe(true);
  });

  it("runs at most 3 applied iterations and records final scores", async () => {
    const project = makeProject();
    const opts = loopOptions([0.8, 0.82, 0.84, 0.86]);

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    expect(result.iterations).toBe(3);
    expect(result.convergence_reason).toBe("max_iterations");
    expect(result.fixes_applied_total).toBe(3);
    expect(result.initial_score).toBe(0.8);
    expect(result.final_score).toBe(0.86);
    expect(opts.compile).toHaveBeenCalledTimes(3);
    expect(opts.render).toHaveBeenCalledTimes(3);
    expect(result.reports).toHaveLength(4);
  });

  it("stops early when no fixable issues remain", async () => {
    const project = makeProject();
    const opts = loopOptions([0.9], {
      runMarlinQA: vi.fn(async () => marlin(90, false)),
      runBriefAlignment: vi.fn(async () => alignment(0.9)),
    });

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    expect(result.iterations).toBe(1);
    expect(result.convergence_reason).toBe("no_fixable_issues");
    expect(result.fixes_applied_total).toBe(0);
    expect(opts.proposeFixes).not.toHaveBeenCalled();

    const report = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, "06_review", "qa-improvement-report-iter1.json"), "utf-8"),
    ) as { visual_qa: string; overall_qa_score: number; total_issues: number };
    expect(report).toMatchObject({
      visual_qa: "verified",
      overall_qa_score: 90,
      total_issues: 0,
    });

    const index = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, "06_review", "qa-improvement-index.json"), "utf-8"),
    ) as { convergence_reason: string; iterations: Array<{ path: string; iteration: number }> };
    expect(index.convergence_reason).toBe("no_issues");
    expect(index.iterations).toEqual([
      { path: "06_review/qa-improvement-report-iter1.json", iteration: 1 },
      { path: "06_review/qa-improvement-report-iter2.json", iteration: 2 },
    ]);
  });

  it("stops early when score drops below the quality floor", async () => {
    const project = makeProject();
    const opts = loopOptions([0.8, 0.7, 0.8], { qualityFloor: 0.75 });

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    expect(result.iterations).toBe(1);
    expect(result.convergence_reason).toBe("quality_floor");
    expect(result.fixes_applied_total).toBe(0);
    expect(result.final_score).toBe(0.8);
  });

  it("stops early when score does not improve", async () => {
    const project = makeProject();
    const opts = loopOptions([0.8, 0.8, 0.8]);

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    expect(result.iterations).toBe(1);
    expect(result.convergence_reason).toBe("no_improvement");
    expect(result.fixes_applied_total).toBe(0);
    expect(opts.proposeFixes).toHaveBeenCalledTimes(1);
  });

  it("backs up iteration artifacts before modification and writes per-iteration reports", async () => {
    const project = makeProject();
    const opts = loopOptions([0.8, 0.8]);

    await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    expect(fs.existsSync(path.join(project.projectDir, "04_plan", "selects_candidates-iter1.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(project.projectDir, "05_timeline", "timeline-iter1.json"))).toBe(true);
    expect(fs.existsSync(path.join(project.projectDir, "09_output", "rough-cut-iter1.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(project.projectDir, "06_review", "qa-improvement-report-iter1.json"))).toBe(true);
    expect(fs.existsSync(path.join(project.projectDir, "06_review", "qa-improvement-index.json"))).toBe(true);
  });

  it("supports skip-render mode with compile only", async () => {
    const project = makeProject();
    const opts = loopOptions([0.6, 0.7], {
      skipRender: true,
      runBriefAlignment: vi.fn(async (_projectDir, _brief, _timeline, iteration) => alignment(iteration === 1 ? 0.6 : 0.7, true)),
    });

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    expect(result.fixes_applied_total).toBe(0);
    expect(opts.compile).not.toHaveBeenCalled();
    expect(opts.render).not.toHaveBeenCalled();
    expect(opts.runMarlinQA).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(project.projectDir, "09_output", "rough-cut-iter1.mp4"))).toBe(false);
  });

  it("records blocked visual QA instead of a passing placeholder when the render is missing", async () => {
    const project = makeProject();
    fs.rmSync(path.join(project.projectDir, "09_output", "rough-cut.mp4"));
    const proposeFixes = vi.fn(async () => []);
    const opts: QALoopOptions = {
      runBriefAlignment: vi.fn(async () => alignment(1)),
      proposeFixes,
      now: () => new Date("2026-06-20T00:00:00.000Z"),
    };

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    const report = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, "06_review", "qa-improvement-report-iter1.json"), "utf-8"),
    ) as {
      total_issues: number;
      fixable_issues: number;
      overall_qa_score: number;
      visual_qa: string;
      visual_qa_reason: string;
      issues: QAIssue[];
    };
    const index = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, "06_review", "qa-improvement-index.json"), "utf-8"),
    ) as { convergence_reason: string };

    expect(result.convergence_reason).toBe("no_fixable_issues");
    expect(result.final_score).toBe(0.45);
    expect(result.warnings).toEqual([
      expect.stringContaining("Marlin QA skipped because rendered video was not found"),
    ]);
    expect(proposeFixes).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      total_issues: 1,
      fixable_issues: 0,
      overall_qa_score: 0,
      visual_qa: "blocked",
      visual_qa_reason: "render_missing",
    });
    expect(report.issues[0]).toMatchObject({
      fixable: false,
      source: "marlin_qa",
      source_category: "visual_qa_blocked",
    });
    expect(index.convergence_reason).toBe("no_fixable_issues");
  });

  it("does not treat mock Marlin QA reports as passing visual QA", async () => {
    const project = makeProject();
    const proposeFixes = vi.fn(async () => []);
    const opts = loopOptions([1], {
      runMarlinQA: vi.fn(async () => marlin(100, false, {
        mock: true,
        visual_qa: "unverified",
        visual_qa_reason: "mock_marlin",
      })),
      runBriefAlignment: vi.fn(async () => alignment(1)),
      proposeFixes,
    });

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    const report = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, "06_review", "qa-improvement-report-iter1.json"), "utf-8"),
    ) as {
      total_issues: number;
      overall_qa_score: number;
      visual_qa: string;
      visual_qa_reason: string;
      visual_qa_mock: boolean;
      issues: QAIssue[];
    };

    expect(result.convergence_reason).toBe("no_fixable_issues");
    expect(result.final_score).toBe(0.45);
    expect(result.warnings).toEqual([
      "Marlin QA did not produce verified visual QA: unverified",
    ]);
    expect(proposeFixes).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      total_issues: 1,
      overall_qa_score: 0,
      visual_qa: "unverified",
      visual_qa_reason: "mock_marlin",
      visual_qa_mock: true,
    });
    expect(report.issues[0]).toMatchObject({
      fixable: false,
      source: "marlin_qa",
      source_category: "visual_qa_mock",
    });
  });

  it("records blocked visual QA when Marlin cannot run", async () => {
    const project = makeProject();
    const opts: QALoopOptions = {
      runMarlinQA: vi.fn(async () => {
        throw new Error("model cache missing");
      }),
      runBriefAlignment: vi.fn(async () => alignment(1)),
      now: () => new Date("2026-06-20T00:00:00.000Z"),
    };

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    const report = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, "06_review", "qa-improvement-report-iter1.json"), "utf-8"),
    ) as {
      overall_qa_score: number;
      visual_qa: string;
      visual_qa_reason: string;
      issues: QAIssue[];
    };

    expect(result.convergence_reason).toBe("no_fixable_issues");
    expect(result.warnings).toEqual([
      "Marlin QA blocked because Marlin was unavailable: model cache missing",
    ]);
    expect(report).toMatchObject({
      overall_qa_score: 0,
      visual_qa: "blocked",
      visual_qa_reason: "marlin_unavailable",
    });
    expect(report.issues[0]).toMatchObject({
      fixable: false,
      source_category: "visual_qa_blocked",
    });
  });

  it("persists updated YAML and final report scores", async () => {
    const project = makeProject();
    const opts = loopOptions([0.75, 0.82]);

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
      );

    const nextSelects = parseYaml(
      fs.readFileSync(path.join(project.projectDir, "04_plan", "selects_candidates.yaml"), "utf-8"),
    ) as SelectsCandidates;
    const report = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, "06_review", "qa-improvement-report-iter1.json"), "utf-8"),
    ) as { iteration: number; proposed_fixes: number };

    expect(nextSelects.candidates[0].trim_hint).toBeDefined();
    expect(report).toMatchObject({ iteration: 1, proposed_fixes: 1 });
    expect(result.initial_score).toBe(0.75);
    expect(result.final_score).toBe(0.82);
  });

  it("uses only initial and accepted candidate evaluations for the final report and index", async () => {
    const project = makeProject();
    const opts = loopOptions([0.8, 0.82, 0.1], { maxIterations: 1 });

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    const index = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, "06_review", "qa-improvement-index.json"), "utf-8"),
    ) as {
      version: string;
      project_id: string;
      run_id: string;
      base_timeline_hash: string;
      result_timeline_hash: string;
      convergence_reason: string;
      iterations: Array<{ path: string; iteration: number }>;
    };
    const secondReport = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, "06_review", "qa-improvement-report-iter2.json"), "utf-8"),
    ) as { total_issues: number; issues: QAIssue[]; timeline_hash: string; overall_qa_score: number };

    expect(index).toMatchObject({
      version: "1",
      project_id: "qa-loop-fixture",
      run_id: "2026-06-20T00:00:00.000Z",
      convergence_reason: "max_iterations",
      iterations: [
        { path: "06_review/qa-improvement-report-iter1.json", iteration: 1 },
        { path: "06_review/qa-improvement-report-iter2.json", iteration: 2 },
      ],
    });
    expect(index.base_timeline_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(index.result_timeline_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(index.result_timeline_hash).not.toBe(index.base_timeline_hash);
    expect(secondReport.timeline_hash).toBe(index.result_timeline_hash);
    expect(secondReport.overall_qa_score).toBe(82);
    expect(secondReport.total_issues).toBeGreaterThan(0);
    expect(secondReport.issues.length).toBe(secondReport.total_issues);
    expect(result.final_score).toBe(0.82);
    expect(opts.runMarlinQA).toHaveBeenCalledTimes(2);
    expect(opts.runBriefAlignment).toHaveBeenCalledTimes(2);
  });

  const rollbackCases: Array<[string, () => QALoopOptions]> = [
    ["score decrease", () => transactionLoopOptions([0.8, 0.7, 0.8], { qualityFloor: 0 })],
    ["flat score", () => transactionLoopOptions([0.8, 0.8, 0.8])],
    ["quality floor failure", () => transactionLoopOptions([0.8, 0.7, 0.8], { qualityFloor: 0.75 })],
    ["unavailable post-fix evaluation", () => {
      let marlinCall = 0;
      const reports = [
        marlin(80),
        marlin(0, true, { visual_qa: "blocked", visual_qa_reason: "marlin_unavailable" }),
        marlin(80),
      ];
      return transactionLoopOptions([0.8, 0.8, 0.8], {
        runMarlinQA: vi.fn(async () => reports[Math.min(marlinCall++, reports.length - 1)]),
      });
    }],
    ["compile exception", () => transactionLoopOptions([0.8, 0.8], {
      compile: vi.fn(() => {
        throw new Error("compile fixture failure");
      }),
    })],
    ["render exception", () => transactionLoopOptions([0.8, 0.8], {
      render: vi.fn(async (projectDir) => {
        writeFile(path.join(projectDir, "09_output", "rough-cut.mp4"), "partial-render");
        writeJson(path.join(projectDir, "09_output", "render-report.json"), { partial: true });
        throw new Error("render fixture failure");
      }),
    })],
  ];

  it.each(rollbackCases)("restores every canonical artifact and live object after %s", async (_name, makeOptions) => {
    const project = makeProject();
    const tempDirsBefore = transactionTempDirs();
    const artifactsBefore = captureCanonicalArtifacts(project.projectDir);
    const selectsBefore = structuredClone(project.selects);
    const blueprintBefore = structuredClone(project.blueprint);
    const timelineBefore = structuredClone(project.timeline);

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      makeOptions(),
    );

    expectCanonicalArtifactsToEqual(project.projectDir, artifactsBefore);
    expect(project.selects).toEqual(selectsBefore);
    expect(project.blueprint).toEqual(blueprintBefore);
    expect(project.timeline).toEqual(timelineBefore);
    expect(result.fixes_applied_total).toBe(0);
    expect(result.reports[0].fixes[0]).toMatchObject({ disposition: "rolled_back" });
    const index = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, "06_review", "qa-improvement-index.json"), "utf-8"),
    ) as { result_timeline_hash: string; iterations: Array<{ path: string }> };
    const finalReportRef = index.iterations.at(-1)!;
    const finalReport = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, finalReportRef.path), "utf-8"),
    ) as { timeline_hash: string };
    expect(finalReport.timeline_hash).toBe(index.result_timeline_hash);
    expectNoNewTransactionTempDirs(tempDirsBefore);
  });

  it("removes candidate adjacency_analysis on rollback when it was absent at transaction start", async () => {
    const project = makeProject();
    const adjacencyPath = path.join(project.projectDir, "05_timeline", "adjacency_analysis.json");
    fs.rmSync(adjacencyPath);
    const tempDirsBefore = transactionTempDirs();

    await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      transactionLoopOptions([0.8, 0.8]),
    );

    expect(fs.existsSync(adjacencyPath)).toBe(false);
    expectNoNewTransactionTempDirs(tempDirsBefore);
  });

  it("commits canonical artifacts and live objects only after measured improvement", async () => {
    const project = makeProject();
    const tempDirsBefore = transactionTempDirs();
    const artifactsBefore = captureCanonicalArtifacts(project.projectDir);

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      transactionLoopOptions([0.8, 0.82, 0.82]),
    );

    for (const relativePath of canonicalArtifactPaths) {
      expect(fs.readFileSync(path.join(project.projectDir, relativePath)).equals(artifactsBefore.get(relativePath)!)).toBe(false);
    }
    expect(project.selects.candidates[0].segment_id).toBe("SEG_R");
    expect(project.blueprint.beats[0].candidate_plan?.primary_candidate_ref).toBe("SEG_R");
    expect(project.timeline.version).toBe("2");
    expect(result.fixes_applied_total).toBe(1);
    expect(result.reports[0].fixes[0]).toMatchObject({ disposition: "applied" });
    expectNoNewTransactionTempDirs(tempDirsBefore);
  });

  it("runs external search through proposal, materialization, compile, render, evaluation, and commits only the improvement", async () => {
    const project = makeProject();
    project.selects.candidates = project.selects.candidates.filter((candidateItem) => candidateItem.segment_id !== "SEG_X");
    writeYaml(path.join(project.projectDir, "04_plan", "selects_candidates.yaml"), project.selects);
    const search = vi.fn(async (_projectDir: string, input: SearchFootageInput) => ({
      query: input,
      db_status: "ready" as const,
      mode_used: input.mode ?? "hybrid",
      results: [externalSearchResult()],
      warnings: [],
    }));
    const opts = loopOptions([0.8, 0.82, 0.82], {
      maxIterations: 1,
      proposeFixes: vi.fn(async (issues, currentTimeline, currentSelects, projectDir, _iteration, discovery) =>
        proposeFixes(issues, currentTimeline, currentSelects, projectDir, { search, discovery })
      ),
      compile: vi.fn((projectDir, currentSelects) => {
        const materialized = (currentSelects as SelectsCandidates).candidates.find((candidateItem) => candidateItem.segment_id === "SEG_X");
        expect(materialized).toMatchObject({
          asset_id: "AST_SEG_X",
          src_in_us: 0,
          src_out_us: 6_000_000,
          eligible_beats: ["b1"],
        });
        expect(materialized?.candidate_id).toMatch(/^cand_/);
        writeJson(path.join(projectDir, "05_timeline", "adjacency_analysis.json"), {
          version: "2",
          project_id: "qa-loop-fixture",
          pairs: [{ candidate: "SEG_X" }],
        });
        return { ...timelineFixture("SEG_X"), version: "2" };
      }),
      render: vi.fn(async (projectDir, _timeline, iteration) => {
        writeFile(path.join(projectDir, "09_output", "rough-cut.mp4"), `external-render-${iteration}`);
        writeJson(path.join(projectDir, "09_output", "render-report.json"), { iteration, segment_id: "SEG_X" });
        return path.join(projectDir, "09_output", "rough-cut.mp4");
      }),
    });

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    expect(search).toHaveBeenCalled();
    expect(project.selects.candidates[0].segment_id).toBe("SEG_X");
    expect(project.blueprint.beats[0].candidate_plan?.primary_candidate_ref).toBe("SEG_X");
    expect(project.timeline.tracks.video[0].clips[0].segment_id).toBe("SEG_X");
    expect(fs.readFileSync(path.join(project.projectDir, "09_output", "rough-cut.mp4"), "utf-8")).toBe("external-render-1");
    expect(result.fixes_applied_total).toBe(1);
    expect(result.improvement).toBe(0.02);
  });

  it.each(["non-improvement", "render exception"] as const)("rolls back an external discovery transaction after %s", async (failure) => {
    const project = makeProject();
    const artifactsBefore = captureCanonicalArtifacts(project.projectDir);
    const selectsBefore = structuredClone(project.selects);
    const blueprintBefore = structuredClone(project.blueprint);
    const timelineBefore = structuredClone(project.timeline);
    const search = vi.fn(async (_projectDir: string, input: SearchFootageInput) => ({
      query: input,
      db_status: "ready" as const,
      mode_used: input.mode ?? "hybrid",
      results: [externalSearchResult()],
      warnings: [],
    }));
    const opts = loopOptions([0.8, 0.8, 0.8], {
      maxIterations: 1,
      proposeFixes: vi.fn(async (issues, currentTimeline, currentSelects, projectDir, _iteration, discovery) =>
        proposeFixes(issues, currentTimeline, currentSelects, projectDir, { search, discovery })
      ),
      compile: vi.fn((projectDir) => {
        writeJson(path.join(projectDir, "05_timeline", "adjacency_analysis.json"), { project_id: "qa-loop-fixture", pairs: [{ candidate: "SEG_X" }] });
        return { ...timelineFixture("SEG_X"), version: "2" };
      }),
      render: vi.fn(async (projectDir) => {
        writeFile(path.join(projectDir, "09_output", "rough-cut.mp4"), "partial-external-render");
        writeJson(path.join(projectDir, "09_output", "render-report.json"), { partial: true });
        if (failure === "render exception") throw new Error("external render failed");
        return path.join(projectDir, "09_output", "rough-cut.mp4");
      }),
    });

    const result = await runQALoop(project.projectDir, project.brief, project.selects, project.blueprint, project.timeline, opts);

    expectCanonicalArtifactsToEqual(project.projectDir, artifactsBefore);
    expect(project.selects).toEqual(selectsBefore);
    expect(project.blueprint).toEqual(blueprintBefore);
    expect(project.timeline).toEqual(timelineBefore);
    expect(result.fixes_applied_total).toBe(0);
  });

  it("snapshots a large canonical render in the disk-backed transaction temp dir", async () => {
    const project = makeProject();
    const renderPath = path.join(project.projectDir, "09_output", "rough-cut.mp4");
    const largeRender = Buffer.alloc(16 * 1024 * 1024, 0x5a);
    fs.writeFileSync(renderPath, largeRender);
    const tempDirsBefore = transactionTempDirs();
    let observedBackupSize = 0;
    const opts = transactionLoopOptions([0.8, 0.8], {
      render: vi.fn(async (projectDir) => {
        const activeTempDirs = [...transactionTempDirs()].filter((dir) => !tempDirsBefore.has(dir));
        const renderBackup = activeTempDirs
          .flatMap((dir) => fs.readdirSync(dir).map((name) => path.join(dir, name)))
          .find((filePath) => filePath.endsWith("rough-cut.mp4"));
        observedBackupSize = renderBackup ? fs.statSync(renderBackup).size : 0;
        writeFile(path.join(projectDir, "09_output", "rough-cut.mp4"), "candidate-render");
        return path.join(projectDir, "09_output", "rough-cut.mp4");
      }),
    });

    await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    expect(observedBackupSize).toBe(largeRender.byteLength);
    expect(fs.readFileSync(renderPath).equals(largeRender)).toBe(true);
    expectNoNewTransactionTempDirs(tempDirsBefore);
  });

  it("removes canonical render artifacts that were originally absent when rolling back", async () => {
    const project = makeProject();
    const renderPath = path.join(project.projectDir, "09_output", "rough-cut.mp4");
    const renderReportPath = path.join(project.projectDir, "09_output", "render-report.json");
    fs.rmSync(renderPath);
    fs.rmSync(renderReportPath);
    const tempDirsBefore = transactionTempDirs();

    await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      transactionLoopOptions([0.8, 0.8]),
    );

    expect(fs.existsSync(renderPath)).toBe(false);
    expect(fs.existsSync(renderReportPath)).toBe(false);
    expectNoNewTransactionTempDirs(tempDirsBefore);
  });

  it("throws a hard failure when canonical restoration itself fails", async () => {
    const project = makeProject();
    const tempDirsBefore = transactionTempDirs();
    const selectsPath = path.join(project.projectDir, "04_plan", "selects_candidates.yaml");
    const opts = transactionLoopOptions([0.8, 0.8], {
      render: vi.fn(async () => {
        fs.rmSync(selectsPath);
        fs.mkdirSync(selectsPath);
        throw new Error("render fixture failure before broken restore");
      }),
    });

    await expect(runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    )).rejects.toBeInstanceOf(QATransactionRestoreError);
    expectNoNewTransactionTempDirs(tempDirsBefore);
  });
});

function writeYaml(filePath: string, data: unknown): void {
  writeFile(filePath, stringifyYaml(data));
}

function writeJson(filePath: string, data: unknown): void {
  writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}
