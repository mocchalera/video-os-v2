import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { runAnalyze, type AnalyzeRunner } from "../runtime/commands/analyze.js";
import { runTriage, type TriageAgent } from "../runtime/commands/triage.js";
import {
  runBlueprint,
  type BlueprintAgent,
  type EditBlueprint,
  type UncertaintyRegister,
} from "../runtime/commands/blueprint.js";
import { runCompilePhase } from "../runtime/commands/compile.js";
import { runReview, type ReviewAgent, type ReviewReport, type ReviewPatch } from "../runtime/commands/review.js";
import { runRender } from "../runtime/commands/render.js";
import { runFullPipeline, type FullPipelineDeps } from "../runtime/commands/full-pipeline.js";
import { readProgress } from "../runtime/progress.js";
import {
  writeProjectState,
  readProjectState,
  computeFileHash,
  type ProjectStateDoc,
} from "../runtime/state/reconcile.js";

const SAMPLE_PROJECT = "projects/sample";
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
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

function createProject(
  name: string,
  opts?: {
    copySample?: boolean;
    state?: ProjectStateDoc["current_state"];
    patches?: Record<string, unknown>;
    removals?: string[];
  },
): string {
  const tmpDir = path.resolve(`test-fixtures-phase-${name}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  tempDirs.push(tmpDir);

  if (opts?.copySample !== false) {
    copyDirSync(path.resolve(SAMPLE_PROJECT), tmpDir);
  }

  for (const rel of opts?.removals ?? []) {
    const abs = path.join(tmpDir, rel);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
    }
  }

  for (const [rel, value] of Object.entries(opts?.patches ?? {})) {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (typeof value === "string") {
      fs.writeFileSync(abs, value, "utf-8");
    } else if (path.extname(rel) === ".json") {
      fs.writeFileSync(abs, JSON.stringify(value, null, 2), "utf-8");
    } else {
      fs.writeFileSync(abs, stringifyYaml(value), "utf-8");
    }
  }

  const stateDoc: ProjectStateDoc = {
    version: 1,
    project_id: "sample-mountain-reset",
    current_state: opts?.state ?? "intent_pending",
    history: [],
  };
  writeProjectState(tmpDir, stateDoc);
  return tmpDir;
}

function makeBlueprint(): EditBlueprint {
  return {
    version: "1",
    project_id: "sample-mountain-reset",
    sequence_goals: ["Hook", "Build", "Resolve"],
    beats: [
      {
        id: "B01",
        label: "hook",
        target_duration_frames: 96,
        required_roles: ["hero"],
      },
      {
        id: "B02",
        label: "body",
        target_duration_frames: 144,
        required_roles: ["dialogue", "support"],
      },
    ],
    pacing: {
      opening_cadence: "brisk",
      middle_cadence: "measured",
      ending_cadence: "calm",
      confirmed_preferences: {
        mode: "full",
        source: "ai_autonomous",
        duration_target_sec: 12,
        confirmed_at: "2026-03-23T00:00:00Z",
      },
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "B02",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
    },
    ending_policy: {
      should_feel: "resolved",
    },
    rejection_rules: ["Avoid redundant coverage"],
  };
}

function makeUncertaintyRegister(): UncertaintyRegister {
  return {
    version: "1",
    project_id: "sample-mountain-reset",
    uncertainties: [],
  };
}

function makeReviewReport(): ReviewReport {
  return {
    version: "1",
    project_id: "sample-mountain-reset",
    timeline_version: "1",
    summary_judgment: {
      status: "needs_revision",
      rationale: "Minor tightening needed.",
    },
    strengths: [{ summary: "Narrative flow is clear." }],
    weaknesses: [{ summary: "Hook runs a little long." }],
    fatal_issues: [],
    warnings: [],
    mismatches_to_brief: [],
    mismatches_to_blueprint: [],
    recommended_next_pass: {
      goal: "Tighten the opening beat.",
      actions: ["Trim the first shot slightly."],
    },
  };
}

function makeReviewPatch(operations: ReviewPatch["operations"] = []): ReviewPatch {
  return {
    timeline_version: "1",
    operations,
  };
}

function createIntentAgent() {
  return {
    async run(ctx: { projectId: string }) {
      return {
        brief: {
          version: "1",
          project_id: ctx.projectId,
          project: {
            id: ctx.projectId,
            title: "Phase Test",
            strategy: "Keep it simple",
            runtime_target_sec: 12,
          },
          message: { primary: "A small moment matters." },
          audience: { primary: "Test audience" },
          emotion_curve: ["curiosity", "warmth"],
          must_have: ["opening detail"],
          must_avoid: ["flashy FX"],
          autonomy: {
            mode: "full" as const,
            may_decide: ["pacing"],
            must_ask: ["final title"],
          },
          resolved_assumptions: ["Sample media is valid"],
        },
        blockers: {
          version: "1",
          project_id: ctx.projectId,
          blockers: [],
        },
        confirmed: true,
      };
    },
  };
}

function createTriageAgent(): TriageAgent {
  return {
    async run(ctx) {
      return {
        selects: {
          version: "1",
          project_id: ctx.projectId,
          candidates: [
            {
              segment_id: "SEG_0001",
              asset_id: "AST_001",
              src_in_us: 0,
              src_out_us: 3_000_000,
              role: "hero",
              why_it_matches: "Strong opening image",
              risks: [],
              confidence: 0.9,
            },
          ],
        },
        confirmed: true,
      };
    },
  };
}

function createBlueprintAgent(): BlueprintAgent {
  return {
    async run() {
      return {
        blueprint: makeBlueprint(),
        uncertaintyRegister: makeUncertaintyRegister(),
        confirmed: true,
      };
    },
  };
}

function createReviewAgent(patchOps: ReviewPatch["operations"] = []): ReviewAgent {
  return {
    async run() {
      return {
        report: makeReviewReport(),
        patch: makeReviewPatch(patchOps),
      };
    },
  };
}

function createAnalyzeRunner(): AnalyzeRunner {
  return {
    async run(ctx) {
      copyDirSync(
        path.resolve(SAMPLE_PROJECT, "03_analysis"),
        path.join(ctx.projectDir, "03_analysis"),
      );
    },
  };
}

function stampApprovedState(projectDir: string): void {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const reviewReportPath = path.join(projectDir, "06_review/review_report.yaml");
  const reviewPatchPath = path.join(projectDir, "06_review/review_patch.json");

  fs.writeFileSync(
    reviewReportPath,
    stringifyYaml(makeReviewReport()),
    "utf-8",
  );
  fs.writeFileSync(
    reviewPatchPath,
    JSON.stringify(makeReviewPatch(), null, 2),
    "utf-8",
  );

  writeProjectState(projectDir, {
    version: 1,
    project_id: "sample-mountain-reset",
    current_state: "approved",
    approval_record: {
      status: "clean",
      approved_by: "operator",
      approved_at: "2026-03-23T10:00:00Z",
      artifact_versions: {
        timeline_version: computeFileHash(timelinePath),
        editorial_timeline_hash: computeFileHash(timelinePath),
        review_report_version: computeFileHash(reviewReportPath),
        review_patch_hash: computeFileHash(reviewPatchPath),
      },
    },
    handoff_resolution: {
      handoff_id: "HND_001",
      status: "decided",
      source_of_truth_decision: "engine_render",
      decided_by: "operator",
      decided_at: "2026-03-23T10:00:00Z",
    },
    history: [],
  });
}

describe("phase commands", () => {
  it("analyze phase requires source files", async () => {
    const tmpDir = createProject("analyze-empty", { copySample: false });

    const result = await runAnalyze(
      tmpDir,
      { sourceFiles: [] },
      createAnalyzeRunner(),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("GATE_CHECK_FAILED");
    expect(readProgress(tmpDir)?.status).toBe("blocked");
  });

  it("triage phase errors when analysis is not ready", async () => {
    const intentData = await createIntentAgent().run({ projectId: "sample-mountain-reset" });
    const tmpDir = createProject("triage-missing-analysis", {
      copySample: false,
      state: "intent_locked",
      patches: {
        "01_intent/creative_brief.yaml": intentData.brief,
        "01_intent/unresolved_blockers.yaml": intentData.blockers,
      },
    });

    const result = await runTriage(tmpDir, createTriageAgent());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("STATE_CHECK_FAILED");
  });

  it("blueprint phase errors when selects are missing", async () => {
    const tmpDir = createProject("blueprint-missing-selects", {
      copySample: false,
      state: "selects_ready",
    });
    const intentData = await createIntentAgent().run({ projectId: "sample-mountain-reset" });
    fs.mkdirSync(path.join(tmpDir, "01_intent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/creative_brief.yaml"),
      stringifyYaml(intentData.brief),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/unresolved_blockers.yaml"),
      stringifyYaml(intentData.blockers),
      "utf-8",
    );

    const result = await runBlueprint(tmpDir, createBlueprintAgent());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("STATE_CHECK_FAILED");
  });

  it("compile phase errors when upstream blockers are unresolved", () => {
    const tmpDir = createProject("compile-blocked", {
      state: "blocked",
      patches: {
        "01_intent/unresolved_blockers.yaml": {
          version: "1",
          project_id: "sample-mountain-reset",
          blockers: [
            {
              id: "BLK_001",
              question: "Blocked",
              status: "blocker",
              why_it_matters: "Hard stop",
              allowed_temporary_assumption: null,
            },
          ],
        },
      },
    });

    const result = runCompilePhase(tmpDir);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("GATE_CHECK_FAILED");
    expect(readProgress(tmpDir)?.phase).toBe("compile");
  });

  it("review phase errors when compile has not been run in strict mode", async () => {
    const tmpDir = createProject("review-needs-compile", {
      state: "blueprint_ready",
      removals: [
        "05_timeline/timeline.json",
        "05_timeline/timeline.otio",
        "05_timeline/preview-manifest.json",
        "06_review/review_report.yaml",
        "06_review/review_patch.json",
      ],
    });

    const result = await runReview(tmpDir, createReviewAgent(), {
      requireCompiledTimeline: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("GATE_CHECK_FAILED");
    expect(result.error?.message).toContain("run /compile");
  });

  it("render phase errors when project is not approved", async () => {
    const tmpDir = createProject("render-not-approved", {
      state: "critique_ready",
    });

    const result = await runRender(tmpDir, {
      skipRender: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("STATE_CHECK_FAILED");
  });

  it("full-pipeline resumes from compile with --from", async () => {
    const tmpDir = createProject("from-compile", {
      state: "blueprint_ready",
      removals: [
        "05_timeline/timeline.json",
        "05_timeline/timeline.otio",
        "05_timeline/preview-manifest.json",
        "06_review/review_report.yaml",
        "06_review/review_patch.json",
      ],
    });

    const deps: FullPipelineDeps = {
      intentAgent: createIntentAgent(),
      triageAgent: createTriageAgent(),
      blueprintAgent: createBlueprintAgent(),
      reviewAgent: createReviewAgent(),
      analyzeRunner: createAnalyzeRunner(),
    };

    const result = await runFullPipeline(tmpDir, deps, {
      from: "compile",
      target: "roughcut",
    });

    expect(result.success).toBe(true);
    expect(result.completedPhases).toEqual(["compile", "review"]);
    expect(fs.existsSync(path.join(tmpDir, "05_timeline/timeline.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "06_review/review_report.yaml"))).toBe(true);
    expect(readProgress(tmpDir)?.phase).toBe("review");
  });

  it("full-pipeline --from review errors when compile prerequisites are missing", async () => {
    const tmpDir = createProject("from-review-error", {
      state: "blueprint_ready",
      removals: [
        "05_timeline/timeline.json",
        "05_timeline/timeline.otio",
        "05_timeline/preview-manifest.json",
        "06_review/review_report.yaml",
        "06_review/review_patch.json",
      ],
    });

    const deps: FullPipelineDeps = {
      intentAgent: createIntentAgent(),
      triageAgent: createTriageAgent(),
      blueprintAgent: createBlueprintAgent(),
      reviewAgent: createReviewAgent(),
      analyzeRunner: createAnalyzeRunner(),
    };

    const result = await runFullPipeline(tmpDir, deps, {
      from: "review",
      target: "roughcut",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("GATE_CHECK_FAILED");
    expect(result.error?.message).toContain("run /compile");
  });

  it("render phase updates packaged state and progress on success", async () => {
    const tmpDir = createProject("render-success", {
      state: "approved",
    });
    stampApprovedState(tmpDir);

    const result = await runRender(tmpDir, {
      skipRender: true,
      precomputedMetrics: {
        integratedLufs: -16,
        truePeakDbtp: -1.8,
        videoDurationMs: 10_000,
        audioDurationMs: 10_000,
        dialogueWindowMs: 10_000,
        observedNonSilentMs: 8_000,
      },
    });

    expect(result.success).toBe(true);
    expect(readProjectState(tmpDir)?.current_state).toBe("packaged");
    expect(readProgress(tmpDir)?.phase).toBe("render");
    expect(readProgress(tmpDir)?.status).toBe("completed");
  });
});
