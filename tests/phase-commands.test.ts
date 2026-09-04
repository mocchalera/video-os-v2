import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { runAnalyze, type AnalyzeRunner } from "../runtime/commands/analyze.js";
import { buildSourceLedger } from "../runtime/artifacts/source-ledger.js";
import { computeNormalizedJsonHash } from "../runtime/artifacts/p1-manifest-coverage.js";
import { discoverRequestedSources } from "../runtime/media/source-discovery.js";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
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
import { runStatus } from "../runtime/commands/status.js";
import { readProgress } from "../runtime/progress.js";
import { approveFinalRenderChecklist } from "../runtime/packaging/final-render-approval.js";
import {
  writeProjectState,
  readProjectState,
  computeFileHash,
  type ProjectStateDoc,
} from "../runtime/state/reconcile.js";

const SAMPLE_PROJECT = "projects/sample";
const tempDirs: string[] = [];
const MATCHING_VIDEO_FRAME = {
  width: 1920,
  height: 1080,
  sar: "1:1",
  dar: "16:9",
  fps_num: 24,
  fps_den: 1,
  fps: 24,
};

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
  materializeTimelineSources(tmpDir);

  const stateDoc: ProjectStateDoc = {
    version: 1,
    project_id: "sample-mountain-reset",
    current_state: opts?.state ?? "intent_pending",
    history: [],
  };
  writeProjectState(tmpDir, stateDoc);
  return tmpDir;
}

function materializeTimelineSources(projectDir: string): void {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const assetIds = new Set<string>();
  if (fs.existsSync(timelinePath)) {
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as {
      tracks?: {
        video?: Array<{ clips?: Array<{ asset_id?: string }> }>;
        audio?: Array<{ clips?: Array<{ asset_id?: string }> }>;
      };
      audio_mix?: { bgm_asset_id?: string };
    };
    for (const assetId of [
      ...(timeline.tracks?.video ?? []).flatMap((track) => track.clips ?? []).map((clip) => clip.asset_id),
      ...(timeline.tracks?.audio ?? []).flatMap((track) => track.clips ?? []).map((clip) => clip.asset_id),
      timeline.audio_mix?.bgm_asset_id,
    ]) {
      if (typeof assetId === "string") assetIds.add(assetId);
    }
  } else {
    const selectsPath = path.join(projectDir, "04_plan/selects_candidates.yaml");
    if (fs.existsSync(selectsPath)) {
      const selects = parseYaml(fs.readFileSync(selectsPath, "utf8")) as {
        candidates?: Array<{ asset_id?: unknown }>;
      };
      for (const candidate of selects.candidates ?? []) {
        if (typeof candidate.asset_id === "string") assetIds.add(candidate.asset_id);
      }
    }
  }
  if (assetIds.size === 0) return;
  const mediaDir = path.join(projectDir, "02_media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const items = [...assetIds].sort().map((assetId) => {
    const sourcePath = path.join(mediaDir, `${assetId}.bin`);
    fs.writeFileSync(sourcePath, `source:${assetId}`);
    return {
      asset_id: assetId,
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: `02_media/${assetId}.bin`,
    };
  });
  fs.writeFileSync(path.join(mediaDir, "source_map.json"), JSON.stringify({
    version: "1",
    project_id: "sample-mountain-reset",
    media_dir: "02_media",
    generated_at: "2026-07-22T00:00:00Z",
    items,
  }));
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
    version: "2",
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
    editorial_judgments: [
      {
        observation: "The opening beat holds a wide establishing view before the subject enters.",
        inference: "The delay before the subject appears weakens the opening engagement.",
        editorial_intent: "Trim the opening so the hook arrives earlier.",
        evidence: [
          { kind: "artifact_ref" as const, ref: "01_intent/creative_brief.yaml" },
        ],
        confidence: 0.6,
        confidence_basis: "measured" as const,
      },
    ],
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
      const segments = JSON.parse(
        fs.readFileSync(path.resolve(SAMPLE_PROJECT, "03_analysis/segments.json"), "utf-8"),
      ) as {
        items?: Array<{
          segment_id: string;
          asset_id: string;
          src_in_us: number;
          src_out_us: number;
          summary?: string;
          tags?: string[];
        }>;
      };
      return {
        selects: {
          version: "1",
          project_id: ctx.projectId,
          candidates: (segments.items ?? []).map((segment, index) => ({
            segment_id: segment.segment_id,
            asset_id: segment.asset_id,
            src_in_us: segment.src_in_us,
            src_out_us: segment.src_out_us,
            role: index === 0 ? "hero" as const : "support" as const,
            why_it_matches: `${segment.summary ?? segment.segment_id}; opening detail`,
            risks: [],
            confidence: 0.9,
            evidence: ["opening detail", ...(segment.tags ?? [])],
          })),
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
      const discovery = discoverRequestedSources(ctx.sourceFiles);
      const assets = JSON.parse(fs.readFileSync(path.join(ctx.projectDir, "03_analysis/assets.json"), "utf-8")) as { items: AssetItem[] };
      const asset = assets.items[0];
      const outcomes = new Map(discovery.requests.flatMap((request) =>
        request.canonical_path && asset
          ? [[request.canonical_path, { canonicalPath: request.canonical_path, asset }] as const]
          : []
      ));
      return {
        sourceLedger: buildSourceLedger(ctx.projectId, discovery, outcomes, undefined, ctx.projectDir),
      };
    },
  };
}

function stampApprovedState(projectDir: string): void {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const reviewReportPath = path.join(projectDir, "06_review/review_report.yaml");
  const reviewPatchPath = path.join(projectDir, "06_review/review_patch.json");

  fs.writeFileSync(
    reviewReportPath,
    stringifyYaml({
      ...makeReviewReport(),
      visual_qa: {
        status: "verified",
        score: 90,
        min_score: 70,
        issues: { total: 0, critical: 0, warning: 0, info: 0 },
        issue_summaries: [],
        deterministic_scan: {
          status: "verified",
          duration_sec: 10,
          scanned_duration_sec: 10,
          width: 1920,
          height: 1080,
          issues: [],
        },
      },
    }),
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

function approveCurrentFinalRender(projectDir: string): void {
  approveFinalRenderChecklist(projectDir, {
    approvedBy: "operator",
    approvedAt: "2026-03-23T10:00:00Z",
    checklist: {
      captions: "not_applicable",
      caption_typography: "not_applicable",
      section_titles: "not_applicable",
      audio: {
        decision: "preserve",
        preview_reviewed: false,
        bgm: "none",
      },
      output_spec: "approved",
    },
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

  it("full-pipeline cannot enter editorial phases when ready coverage masks invalid segments", async () => {
    const tmpDir = createProject("pipeline-invalid-analysis", {
      state: "media_analyzed",
      removals: ["04_plan", "05_timeline", "06_review"],
      patches: {
        "03_analysis/analysis_coverage_report.json": JSON.parse(fs.readFileSync(
          path.resolve("tests/fixtures/analysis_coverage_report/valid_ready_all_lanes.json"),
          "utf-8",
        )),
      },
    });
    const segmentsPath = path.join(tmpDir, "03_analysis/segments.json");
    const segments = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as Record<string, unknown>;
    segments.invalid_cached_shape = true;
    fs.writeFileSync(segmentsPath, JSON.stringify(segments, null, 2), "utf-8");
    let triageCalls = 0;
    const triageAgent = createTriageAgent();
    const deps: FullPipelineDeps = {
      intentAgent: createIntentAgent(),
      triageAgent: {
        async run(ctx) {
          triageCalls += 1;
          return triageAgent.run(ctx);
        },
      },
      blueprintAgent: createBlueprintAgent(),
      reviewAgent: createReviewAgent(),
      analyzeRunner: createAnalyzeRunner(),
    };

    const previous = process.env.ENABLE_P1_MANIFEST_COVERAGE;
    process.env.ENABLE_P1_MANIFEST_COVERAGE = "1";
    try {
      const result = await runFullPipeline(tmpDir, deps, { from: "triage", target: "roughcut" });
      expect(result.success).toBe(false);
      expect(result.completedPhases).toEqual([]);
      expect(triageCalls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ENABLE_P1_MANIFEST_COVERAGE;
      else process.env.ENABLE_P1_MANIFEST_COVERAGE = previous;
    }
  });

  it("full-pipeline blocks Gate 1 before triage when one asset has no canonical segments", async () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve("tests/fixtures/source_media_manifest/valid_minimal.json"),
      "utf-8",
    )) as {
      project_id: string;
      provenance: { hash_policy: { excluded_fields: string[] } };
    };
    const coverage = JSON.parse(fs.readFileSync(
      path.resolve("tests/fixtures/analysis_coverage_report/valid_ready_all_lanes.json"),
      "utf-8",
    )) as { project_id: string; source_media_manifest_hash: string };
    manifest.project_id = "sample-mountain-reset";
    coverage.project_id = "sample-mountain-reset";
    coverage.source_media_manifest_hash = computeNormalizedJsonHash(
      manifest,
      manifest.provenance.hash_policy.excluded_fields,
    );
    const tmpDir = createProject("pipeline-incomplete-analysis", {
      state: "media_analyzed",
      removals: [
        "03_analysis/audio_story_graph.json",
        "03_analysis/continuity_graph.json",
        "04_plan",
        "05_timeline",
        "06_review",
      ],
      patches: {
        "02_media/source_media_manifest.json": manifest,
        "03_analysis/analysis_coverage_report.json": coverage,
      },
    });
    const segmentsPath = path.join(tmpDir, "03_analysis/segments.json");
    const segments = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
      items: Array<{ asset_id: string }>;
    };
    segments.items = segments.items.filter((segment) => segment.asset_id !== "AST_001");
    fs.writeFileSync(segmentsPath, JSON.stringify(segments, null, 2), "utf-8");
    const state = readProjectState(tmpDir)!;
    state.analysis_override = {
      status: "active",
      approved_by: "operator",
      approved_at: "2026-08-25T00:00:00Z",
      artifact_version: "analysis-v1",
    };
    writeProjectState(tmpDir, state);

    let triageCalls = 0;
    const triageAgent = createTriageAgent();
    const deps: FullPipelineDeps = {
      intentAgent: createIntentAgent(),
      triageAgent: {
        async run(ctx) {
          triageCalls += 1;
          return triageAgent.run(ctx);
        },
      },
      blueprintAgent: createBlueprintAgent(),
      reviewAgent: createReviewAgent(),
      analyzeRunner: createAnalyzeRunner(),
    };

    const previous = process.env.ENABLE_P1_MANIFEST_COVERAGE;
    process.env.ENABLE_P1_MANIFEST_COVERAGE = "1";
    try {
      const status = runStatus(tmpDir);
      const result = await runFullPipeline(tmpDir, deps, { from: "triage", target: "roughcut" });
      expect(status.gates?.analysis_gate).toBe("blocked");
      expect(result.success).toBe(false);
      expect(result.completedPhases).toEqual([]);
      expect(triageCalls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ENABLE_P1_MANIFEST_COVERAGE;
      else process.env.ENABLE_P1_MANIFEST_COVERAGE = previous;
    }
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

  it("compile phase errors when upstream blockers are unresolved", async () => {
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

    const result = await runCompilePhase(tmpDir);

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
    approveCurrentFinalRender(tmpDir);

    const result = await runRender(tmpDir, {
      skipRender: true,
      precomputedMetrics: {
        integratedLufs: -16,
        truePeakDbtp: -1.8,
        videoDurationMs: 10_000,
        audioDurationMs: 10_000,
        dialogueWindowMs: 10_000,
        observedNonSilentMs: 8_000,
        videoFrame: MATCHING_VIDEO_FRAME,
      },
    });

    expect(result.success).toBe(true);
    expect(readProjectState(tmpDir)?.current_state).toBe("packaged");
    expect(readProgress(tmpDir)?.phase).toBe("render");
    expect(readProgress(tmpDir)?.status).toBe("completed");
  });

  it("render phase blocks before package writes when final approval is missing", async () => {
    const tmpDir = createProject("render-missing-final-approval", {
      state: "approved",
    });
    stampApprovedState(tmpDir);

    const result = await runRender(tmpDir, {
      skipRender: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: "GATE_CHECK_FAILED",
    });
    expect(result.error?.message).toContain("Final render approval is missing");
  });

  it("render phase closes progress when packaging throws", async () => {
    const tmpDir = createProject("render-malformed-timeline", {
      state: "approved",
    });
    stampApprovedState(tmpDir);
    approveCurrentFinalRender(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "05_timeline/timeline.json"), "{ malformed timeline", "utf-8");

    await expect(runRender(tmpDir)).rejects.toThrow(/JSON|Unexpected token/);
    expect(readProgress(tmpDir)).toMatchObject({
      phase: "render",
      status: "failed",
      errors: [{ stage: "render" }],
    });
    expect(readProgress(tmpDir)?.errors[0]?.message.length).toBeLessThanOrEqual(1000);
  });
});
