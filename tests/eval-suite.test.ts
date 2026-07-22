import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveSuiteBriefAlignmentOptions,
  runGoldenEvalSuite,
  type EvalSuiteSummary,
} from "../runtime/eval/suite.js";
import type { BriefAlignmentReport } from "../runtime/eval/brief-alignment-types.js";
import type { EvalReport } from "../runtime/eval/types.js";
import {
  evaluateReviewVisualQA,
  type ReviewVisualQA,
} from "../runtime/review/visual-qa.js";
import type { MarlinQAReport } from "../runtime/eval/marlin-qa-types.js";
import { evalSuiteOptionsFromArgs, parseArgs } from "../scripts/eval.js";

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "eval-suite-"));
  write(path.join(repo, "package.json"), "{}\n");
  write(path.join(repo, "runtime/.keep"), "\n");
  return repo;
}

function makeProject(
  repo: string,
  projectId: string,
  options: {
    approved?: boolean;
    brief?: boolean;
    selects?: boolean;
    blueprint?: boolean;
    timeline?: boolean;
  } = {},
): string {
  const dir = path.join(repo, "projects", projectId);
  if (options.approved) {
    write(
      path.join(dir, "project_state.yaml"),
      'approval_record:\n  approved_by: operator\n  approved_at: "2026-07-07T00:00:00.000Z"\n',
    );
  }
  if (options.brief) write(path.join(dir, "01_intent/creative_brief.yaml"), "version: '1'\n");
  if (options.selects) write(path.join(dir, "04_plan/selects_candidates.yaml"), "version: '1'\n");
  if (options.blueprint) write(path.join(dir, "04_plan/edit_blueprint.yaml"), "version: '1'\n");
  if (options.timeline) write(path.join(dir, "05_timeline/timeline.json"), "{}\n");
  return dir;
}

function evalReport(projectId: string, score: number): EvalReport {
  return {
    version: "1",
    mode: "self",
    golden_project: projectId,
    candidate_project: `${projectId} (recompiled)`,
    evaluated_at: "2026-07-07T00:00:00.000Z",
    golden_approved_by: "operator",
    stages: {},
    llm_judge: null,
    overall_score: score,
    min_score: null,
    pass: null,
  };
}

function briefReport(projectId: string, composite: number, judgeSource: BriefAlignmentReport["judge_source"]): BriefAlignmentReport {
  return {
    version: "1",
    project: projectId,
    evaluated_at: "2026-07-07T00:00:00.000Z",
    brief_hash: "sha256:test",
    stages: {},
    composite,
    judge_source: judgeSource,
    decision_runtime: [
      {
        runtime: judgeSource === "deterministic-only" ? "deterministic" : "codex_exec",
        role: "brief-alignment-selects",
        attempted_runtimes: [
          {
            runtime: judgeSource === "deterministic-only" ? "deterministic" : "codex_exec",
            status: "success",
          },
        ],
      },
    ],
    notes: [],
  };
}

function visualQA(status: ReviewVisualQA["status"], score?: number, reason?: string): ReviewVisualQA {
  return {
    status,
    ...(reason ? { reason } : {}),
    ...(score !== undefined ? { score } : {}),
    min_score: 70,
    issues: { total: 0, critical: 0, warning: 0, info: 0 },
    issue_summaries: [],
  };
}

describe("golden eval suite", () => {
  it("discovers approved checkout-local projects for the default suite", async () => {
    const repo = makeRepo();
    try {
      makeProject(repo, "approved-local", {
        approved: true,
        brief: true,
        selects: true,
        blueprint: true,
        timeline: true,
      });
      const result = await runGoldenEvalSuite({
        repoRoot: repo,
        write: false,
        evaluateStructure: async () => evalReport("approved-local", 80),
        evaluateBrief: async () => briefReport("approved-local", 0.8, "deterministic-only"),
      });

      expect(result.summary.projects_requested).toEqual(["approved-local"]);
      expect(result.summary.projects[0].project_id).toBe("approved-local");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps the brief-alignment judge opt-in for reproducible suite runs", () => {
    expect(resolveSuiteBriefAlignmentOptions(undefined)).toEqual({ useLlm: false });
    expect(resolveSuiteBriefAlignmentOptions(false)).toEqual({ useLlm: false });
    expect(resolveSuiteBriefAlignmentOptions(true)).toEqual({ useLlm: true });
  });

  it("maps live judges and Marlin QA to explicit CLI flags", () => {
    const baseline = parseArgs(["node", "eval", "--suite", "golden", "--no-write"]);
    expect(evalSuiteOptionsFromArgs(baseline, "/repo")).toMatchObject({
      repoRoot: "/repo",
      briefAlignmentUseLlm: false,
      runMarlinQA: false,
      write: false,
    });

    const live = parseArgs([
      "node",
      "eval",
      "--suite",
      "golden",
      "--judge",
      "--marlin",
    ]);
    expect(evalSuiteOptionsFromArgs(live, "/repo")).toMatchObject({
      briefAlignmentUseLlm: true,
      runMarlinQA: true,
      write: true,
    });
  });

  it("skips live Marlin QA unless explicitly requested", async () => {
    const repo = makeRepo();
    try {
      makeProject(repo, "baseline", {
        approved: true,
        brief: true,
        selects: true,
        blueprint: true,
        timeline: true,
      });
      const result = await runGoldenEvalSuite({
        repoRoot: repo,
        projects: ["baseline"],
        write: false,
        evaluateStructure: async () => evalReport("baseline", 80),
        evaluateBrief: async () => briefReport("baseline", 0.8, "deterministic-only"),
      });

      expect(result.summary.projects[0].marlin_qa).toMatchObject({
        status: "skipped",
        reason: "live_marlin_not_requested",
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("records incompatible legacy golden timelines as an explicit skip", async () => {
    const repo = makeRepo();
    try {
      makeProject(repo, "legacy", {
        approved: true,
        brief: true,
        selects: true,
        blueprint: true,
        timeline: true,
      });
      const result = await runGoldenEvalSuite({
        repoRoot: repo,
        projects: ["legacy"],
        write: false,
        evaluateStructure: async () => {
          throw new Error("Artifact validation failed (timeline-ir.schema.json): legacy shape");
        },
        evaluateBrief: async () => briefReport("legacy", 0.7, "deterministic-only"),
      });

      expect(result.summary.projects[0].structure).toMatchObject({
        status: "skipped",
        reason: "golden_timeline_incompatible",
      });
      expect(result.summary.totals.failed_stages).toBe(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("propagates no-write to the live Marlin report boundary", async () => {
    const repo = makeRepo();
    try {
      const projectDir = makeProject(repo, "no-write", {
        brief: true,
        timeline: true,
      });
      write(path.join(projectDir, "09_output/rough-cut.mp4"), "render");
      let observedWriteReport: boolean | undefined;
      const marlinReport: MarlinQAReport = {
        version: "1",
        project_id: "no-write",
        video_path: path.join(projectDir, "09_output/rough-cut.mp4"),
        video_duration_sec: 10,
        overall_assessment: "verified",
        scene_descriptions: [],
        issues: [],
        pacing_assessment: { too_fast: false, too_slow: false, notes: "ok" },
        emotion_arc_assessment: { follows_brief: true, notes: "ok" },
        score: 90,
        visual_qa: "verified",
      };

      const result = await evaluateReviewVisualQA(projectDir, {
        repoRoot: repo,
        writeReport: false,
        runMarlinQAImpl: async (_dir, _video, _brief, options) => {
          observedWriteReport = options?.writeReport;
          return marlinReport;
        },
      });

      expect(observedWriteReport).toBe(false);
      expect(result.status).toBe("verified");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("marks canonical audio-only visual QA not applicable without calling Marlin", async () => {
    const repo = makeRepo();
    try {
      const projectDir = makeProject(repo, "audio-only", { brief: true, timeline: true });
      write(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify({
        version: "1",
        tracks: {
          video: [{ track_id: "V1", clips: [] }],
          audio: [{ track_id: "A1", clips: [{ clip_id: "ACL_1" }] }],
        },
      }));
      let calls = 0;
      const result = await evaluateReviewVisualQA(projectDir, {
        repoRoot: repo,
        runMarlinQAImpl: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      });

      expect(calls).toBe(0);
      expect(result).toMatchObject({
        status: "not_applicable",
        reason: "audio_only_timeline",
        issues: { total: 0 },
      });
      expect(result.score).toBeUndefined();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("aggregates mocked stages, writes summaries, and records skip reasons", async () => {
    const repo = makeRepo();
    try {
      makeProject(repo, "complete", {
        approved: true,
        brief: true,
        selects: true,
        blueprint: true,
        timeline: true,
      });
      makeProject(repo, "missing-golden", {
        brief: true,
        selects: true,
      });

      const result = await runGoldenEvalSuite({
        repoRoot: repo,
        outRoot: "reports/eval",
        projects: ["complete", "missing-golden"],
        now: () => new Date("2026-07-07T00:00:00.000Z"),
        evaluateStructure: async (projectDir) => evalReport(path.basename(projectDir), 82),
        evaluateBrief: async (projectDir) => briefReport(path.basename(projectDir), 0.72, "llm-assisted"),
        evaluateVisualQA: async (projectDir) =>
          path.basename(projectDir) === "complete"
            ? visualQA("verified", 75)
            : visualQA("blocked", undefined, "render_missing"),
      });

      expect(fs.existsSync(path.join(result.suiteDir, "summary.json"))).toBe(true);
      expect(fs.existsSync(path.join(result.suiteDir, "summary.md"))).toBe(true);
      expect(result.summary.projects).toHaveLength(2);
      const complete = result.summary.projects.find((project) => project.project_id === "complete");
      expect(complete?.structure.status).toBe("completed");
      expect(complete?.brief_alignment.status).toBe("completed");
      expect(complete?.marlin_qa.status).toBe("completed");
      expect(complete?.structural_alignment_score).toBe(77);

      const missing = result.summary.projects.find((project) => project.project_id === "missing-golden");
      expect(missing?.structure).toMatchObject({
        status: "skipped",
        reason: "golden_not_found_or_incomplete",
      });
      expect(missing?.marlin_qa).toMatchObject({
        status: "skipped",
        reason: "visual_qa_blocked:render_missing",
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("flags divergence warnings and reports previous-suite deltas", async () => {
    const repo = makeRepo();
    try {
      makeProject(repo, "warning-project", {
        approved: true,
        brief: true,
        selects: true,
        blueprint: true,
        timeline: true,
      });
      const previousDir = path.join(repo, "reports/eval/suite-2026-07-06T00-00-00-000Z");
      const previous: EvalSuiteSummary = {
        version: "1",
        suite: "golden",
        evaluated_at: "2026-07-06T00:00:00.000Z",
        projects_requested: ["warning-project"],
        divergence_threshold: 30,
        previous_suite: null,
        totals: { projects: 1, warnings: 0, skipped_stages: 0, failed_stages: 0 },
        projects: [
          {
            project_id: "warning-project",
            project_dir: path.join(repo, "projects/warning-project"),
            structure: { status: "completed", score: 80 },
            brief_alignment: { status: "completed", score: 80, judge_source: "llm-assisted" },
            marlin_qa: { status: "completed", score: 70 },
            structural_alignment_score: 80,
            reference_structural_alignment_score: 80,
            divergence: {
              status: "computed",
              threshold: 30,
              structural_alignment_score: 80,
              marlin_qa_score: 70,
              difference: 10,
              warning: false,
            },
          },
        ],
      };
      write(path.join(previousDir, "summary.json"), `${JSON.stringify(previous, null, 2)}\n`);

      const result = await runGoldenEvalSuite({
        repoRoot: repo,
        outRoot: "reports/eval",
        projects: ["warning-project"],
        divergenceThreshold: 30,
        now: () => new Date("2026-07-07T00:00:00.000Z"),
        evaluateStructure: async () => evalReport("warning-project", 90),
        evaluateBrief: async () => briefReport("warning-project", 0.9, "llm-assisted"),
        evaluateVisualQA: async () => visualQA("verified", 20),
      });

      const project = result.summary.projects[0];
      expect(project.divergence).toMatchObject({
        status: "computed",
        structural_alignment_score: 90,
        marlin_qa_score: 20,
        difference: 70,
        warning: true,
      });
      expect(project.divergence.previous).toEqual({
        structural_alignment_delta: 10,
        marlin_qa_delta: -50,
        difference_delta: 60,
      });
      expect(result.summary.totals.warnings).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps deterministic-only brief scores as reference values outside the primary divergence score", async () => {
    const repo = makeRepo();
    try {
      makeProject(repo, "reference-only", {
        brief: true,
        selects: true,
      });

      const result = await runGoldenEvalSuite({
        repoRoot: repo,
        outRoot: "reports/eval",
        projects: ["reference-only"],
        now: () => new Date("2026-07-07T00:00:00.000Z"),
        evaluateStructure: async () => evalReport("reference-only", 100),
        evaluateBrief: async () => briefReport("reference-only", 0.66, "deterministic-only"),
        evaluateVisualQA: async () => visualQA("verified", 10),
      });

      const project = result.summary.projects[0];
      expect(project.brief_alignment).toMatchObject({
        status: "completed",
        score: 66,
        reference_only: true,
        judge_source: "deterministic-only",
      });
      expect(project.structural_alignment_score).toBeNull();
      expect(project.reference_structural_alignment_score).toBe(66);
      expect(project.divergence).toMatchObject({
        status: "skipped",
        reason: "only_reference_alignment_score_available",
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
