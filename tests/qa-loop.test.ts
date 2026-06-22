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
import { runQALoop, type QALoopOptions } from "../runtime/eval/qa-loop.js";
import type { QAIssue } from "../runtime/eval/qa-issue-detector.js";
import type { QAFix } from "../runtime/eval/qa-fix-proposer.js";

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
    items: [
      segment("SEG_A"),
      segment("SEG_B"),
      segment("SEG_R"),
      segment("SEG_X"),
    ],
  });
  writeJson(path.join(projectDir, "05_timeline", "timeline.json"), timeline);
  writeFile(path.join(projectDir, "09_output", "rough-cut.mp4"), "render-0");

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
    segment_type: "shot",
    transcript_ref: null,
    confidence: { boundary: { score: 1, source: "test", status: "ok" } },
    provenance: { boundary: { stage: "test", method: "test", connector_version: "test", policy_hash: "test", request_hash: "test" } },
  };
}

function marlin(score: number, withIssue = true): MarlinQAReport {
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

describe("runQALoop", () => {
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
    expect(result.reports).toHaveLength(3);
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

    const index = JSON.parse(
      fs.readFileSync(path.join(project.projectDir, "06_review", "qa-improvement-index.json"), "utf-8"),
    ) as { convergence_reason: string; iterations: Array<{ path: string; iteration: number }> };
    expect(index.convergence_reason).toBe("no_issues");
    expect(index.iterations).toEqual([
      { path: "06_review/qa-improvement-report-iter1.json", iteration: 1 },
    ]);
  });

  it("stops early when score drops below the quality floor", async () => {
    const project = makeProject();
    const opts = loopOptions([0.8, 0.7], { qualityFloor: 0.75 });

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    expect(result.iterations).toBe(2);
    expect(result.convergence_reason).toBe("quality_floor");
    expect(result.fixes_applied_total).toBe(1);
    expect(result.final_score).toBe(0.7);
  });

  it("stops early when score does not improve", async () => {
    const project = makeProject();
    const opts = loopOptions([0.8, 0.8]);

    const result = await runQALoop(
      project.projectDir,
      project.brief,
      project.selects,
      project.blueprint,
      project.timeline,
      opts,
    );

    expect(result.iterations).toBe(2);
    expect(result.convergence_reason).toBe("no_improvement");
    expect(result.fixes_applied_total).toBe(1);
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

    expect(result.fixes_applied_total).toBeGreaterThan(0);
    expect(opts.compile).toHaveBeenCalled();
    expect(opts.render).not.toHaveBeenCalled();
    expect(opts.runMarlinQA).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(project.projectDir, "09_output", "rough-cut-iter1.mp4"))).toBe(false);
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

  it("writes an ordered QA improvement index with timeline hashes", async () => {
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
    ) as { total_issues: number; issues: QAIssue[] };

    expect(index).toMatchObject({
      version: "1",
      project_id: "qa-loop-fixture",
      run_id: "2026-06-20T00:00:00.000Z",
      convergence_reason: "score_plateau",
      iterations: [
        { path: "06_review/qa-improvement-report-iter1.json", iteration: 1 },
        { path: "06_review/qa-improvement-report-iter2.json", iteration: 2 },
      ],
    });
    expect(index.base_timeline_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(index.result_timeline_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(index.result_timeline_hash).not.toBe(index.base_timeline_hash);
    expect(secondReport.total_issues).toBeGreaterThan(0);
    expect(secondReport.issues.length).toBe(secondReport.total_issues);
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
