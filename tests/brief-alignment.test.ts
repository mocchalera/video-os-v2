import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
} from "../runtime/artifacts/types.js";
import {
  scoreMustAvoidViolations,
  scoreMustHaveCoverage,
  scoreNarrativeStructureDeterministic,
  scorePacingDeterministic,
  scoreVisualVariety,
} from "../runtime/eval/brief-alignment-deterministic.js";
import {
  buildBriefAlignmentJudgePrompt,
  parseBriefAlignmentJudgeResponse,
  runBriefAlignmentJudge,
} from "../runtime/eval/brief-alignment-judge.js";
import {
  computeBriefAlignmentComposite,
  evaluateBriefAlignment,
} from "../runtime/eval/brief-alignment.js";
import {
  BRIEF_ALIGNMENT_AXES,
  type AxisScore,
  type BriefAlignmentAxis,
  type StageResult,
} from "../runtime/eval/brief-alignment-types.js";
import type { SelectionCoverageSegment } from "../runtime/eval/selection-coverage.js";

function brief(): CreativeBrief {
  return {
    version: "1",
    project_id: "alignment-fixture",
    project: {
      id: "alignment-fixture",
      title: "Mountain learning",
      strategy: "show growth through outdoor practice",
      runtime_target_sec: 60,
      duration_mode: "strict",
    },
    message: { primary: "practice creates confidence", secondary: ["warm team support"] },
    emotion_curve: ["uncertain start", "focused practice", "quiet confidence"],
    must_have: ["rope practice", "closing smile", "BGM fade out"],
    must_avoid: ["danger panic"],
  } as CreativeBrief;
}

function segments(): SelectionCoverageSegment[] {
  return [
    { segment_id: "SEG_001", summary: "Rope practice on the trail with careful coaching." },
    { segment_id: "SEG_002", summary: "A teammate gives warm support during focused practice." },
    { segment_id: "SEG_003", summary: "Closing smile after the outdoor lesson." },
    { segment_id: "SEG_004", summary: "Wide mountain texture shot." },
  ];
}

function selects(): SelectsCandidates {
  return {
    version: "1",
    project_id: "alignment-fixture",
    candidates: [
      {
        segment_id: "SEG_001",
        asset_id: "A",
        src_in_us: 0,
        src_out_us: 8_000_000,
        role: "hero",
        why_it_matches: "Rope practice shows how practice creates confidence.",
        risks: [],
        confidence: 0.9,
        evidence: ["rope practice"],
        eligible_beats: ["hook"],
        editorial_signals: { semantic_cluster_id: "practice", peak_strength_score: 0.7 },
      },
      {
        segment_id: "SEG_003",
        asset_id: "B",
        src_in_us: 0,
        src_out_us: 7_000_000,
        role: "support",
        why_it_matches: "Closing smile lands quiet confidence with warm team support.",
        risks: [],
        confidence: 0.8,
        evidence: ["closing smile"],
        eligible_beats: ["closing"],
        editorial_signals: { semantic_cluster_id: "payoff", afterglow_score: 0.8 },
      },
      {
        segment_id: "SEG_004",
        asset_id: "C",
        src_in_us: 0,
        src_out_us: 5_000_000,
        role: "texture",
        why_it_matches: "Wide mountain shot gives visual contrast.",
        risks: [],
        confidence: 0.7,
        evidence: ["wide mountain"],
        editorial_signals: { semantic_cluster_id: "place" },
      },
    ],
  };
}

function blueprint(): EditBlueprint {
  return {
    version: "1",
    project_id: "alignment-fixture",
    sequence_goals: ["show practice creates confidence"],
    beats: [
      {
        id: "b1",
        label: "uncertain start",
        purpose: "hook the viewer with the starting uncertainty",
        target_duration_frames: 300,
        required_roles: ["hero"],
        story_role: "hook",
      },
      {
        id: "b2",
        label: "focused practice",
        purpose: "show rope practice and team support",
        target_duration_frames: 900,
        required_roles: ["support"],
        story_role: "setup",
      },
      {
        id: "b3",
        label: "confidence grows",
        purpose: "make the experience feel earned",
        target_duration_frames: 900,
        required_roles: ["support", "texture"],
        story_role: "experience",
      },
      {
        id: "b4",
        label: "quiet confidence",
        purpose: "close on the smile and emotional release",
        target_duration_frames: 300,
        required_roles: ["hero"],
        story_role: "closing",
      },
    ],
    pacing: {
      opening_cadence: "quick hook",
      middle_cadence: "measured practice rhythm",
      ending_cadence: "slow release",
      default_duration_target_sec: 60,
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b2",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
    },
    story_arc: {
      summary: "uncertain start to focused practice to quiet confidence",
      strategy: "problem_to_solution",
    },
    duration_policy: {
      mode: "strict",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 60,
      min_duration_sec: 56,
      max_duration_sec: 64,
      hard_gate: true,
      protect_vlm_peaks: true,
    },
  } as EditBlueprint;
}

function axis(score: number): AxisScore {
  return {
    score,
    confidence: 0.8,
    judge_source: "deterministic",
    evidence: ["fixture"],
    gaps: [],
  };
}

function stage(score: number): StageResult {
  const axes = Object.fromEntries(
    BRIEF_ALIGNMENT_AXES.map((axisName) => [axisName, axis(score)]),
  ) as Record<BriefAlignmentAxis, AxisScore>;
  return { score, axes };
}

describe("brief alignment deterministic scorers", () => {
  it("scores must-have coverage and ignores production directives as selection targets", () => {
    const result = scoreMustHaveCoverage(brief(), selects(), segments());
    expect(result.score).toBe(1);
    expect(result.evidence.some((item) => item.includes("production directive"))).toBe(true);
  });

  it("flags must-avoid evidence in candidate rationale/evidence", () => {
    const mutated = structuredClone(selects());
    mutated.candidates[0].why_it_matches = "This creates danger panic.";
    const result = scoreMustAvoidViolations(brief(), mutated);
    expect(result.score).toBe(0);
    expect(result.gaps[0]).toContain("danger panic");
  });

  it("scores variety, pacing, and narrative structure from contract-visible fields", () => {
    expect(scoreVisualVariety(selects(), segments()).score).toBeGreaterThan(0.7);
    expect(scorePacingDeterministic(brief(), blueprint()).score).toBeGreaterThan(0.9);
    expect(scoreNarrativeStructureDeterministic(blueprint()).score).toBeGreaterThan(0.9);
  });
});

describe("brief alignment LLM judge", () => {
  it("builds a golden-free prompt with the compact brief and artifact YAML", () => {
    const prompt = buildBriefAlignmentJudgePrompt({
      brief: brief(),
      stage: "selects",
      artifactYaml: "candidates:\n  - segment_id: SEG_001\n",
    });
    expect(prompt).toContain("Do not compare against any human golden answer");
    expect(prompt).toContain("practice creates confidence");
    expect(prompt).toContain("segment_id: SEG_001");
    expect(prompt).toContain("intent_message_alignment");
  });

  it("runs through an injected JSON caller and parses all axes", async () => {
    let capturedPrompt = "";
    const response = JSON.stringify({
      axes: Object.fromEntries(
        BRIEF_ALIGNMENT_AXES.map((axisName) => [
          axisName,
          { score: 0.8, confidence: 0.9, evidence: [`${axisName} evidence`], gaps: [] },
        ]),
      ),
      notes: ["judge note"],
    });
    const result = await runBriefAlignmentJudge(
      { brief: brief(), stage: "blueprint", artifactYaml: "beats: []" },
      {
        apiKey: "test-key",
        model: "test-model",
        callJson: async (prompt) => {
          capturedPrompt = prompt;
          return response;
        },
      },
    );
    expect(capturedPrompt).toContain("blueprint artifact YAML");
    expect(result?.model).toBe("test-model");
    expect(result?.axes.intent_message_alignment.judge_source).toBe("llm_artifact");
    expect(result?.notes).toEqual(["judge note"]);
  });

  it("routes through the editorial LLM connector and records decision_runtime", async () => {
    const result = await runBriefAlignmentJudge(
      { brief: brief(), stage: "selects", artifactYaml: "candidates: []" },
      {
        connector: {
          commandExists: (command) => command === "codex",
          env: {},
          executor: async () => ({
            stdout: `${JSON.stringify({
              type: "agent_message",
              message: JSON.stringify({
                axes: Object.fromEntries(
                  BRIEF_ALIGNMENT_AXES.map((axisName) => [
                    axisName,
                    { score: 0.7, confidence: 0.8, evidence: ["local"], gaps: [] },
                  ]),
                ),
              }),
            })}\n`,
            stderr: "",
          }),
        },
      },
    );
    expect(result?.model).toBe("codex_exec");
    expect(result?.decision_runtime?.runtime).toBe("codex_exec");
    expect(result?.decision_runtime?.attempted_runtimes).toEqual([
      { runtime: "codex_exec", status: "success" },
    ]);
  });

  it("returns null when no local or Gemini judge runtime is available", async () => {
    const result = await runBriefAlignmentJudge(
      { brief: brief(), stage: "selects", artifactYaml: "candidates: []" },
      {
        apiKey: null,
        connector: { commandExists: () => false, env: {} },
      },
    );
    expect(result).toBeNull();
  });

  it("parses missing axis fields into safe defaults", () => {
    const result = parseBriefAlignmentJudgeResponse(
      JSON.stringify({ axes: { intent_message_alignment: { score: 2, confidence: -1 } } }),
      "model",
    );
    expect(result.axes.intent_message_alignment.score).toBe(1);
    expect(result.axes.intent_message_alignment.confidence).toBe(0);
    expect(result.axes.must_have_coverage.score).toBe(0);
  });
});

describe("brief alignment orchestration", () => {
  it("renormalizes composite over present stage weights", () => {
    expect(computeBriefAlignmentComposite({ selects: stage(0.5), blueprint: stage(1) })).toBeCloseTo(0.727, 3);
    expect(computeBriefAlignmentComposite({ blueprint: stage(0.75) })).toBe(0.75);
  });

  it("degrades gracefully when optional artifacts are missing and no API key is present", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brief-alignment-"));
    try {
      fs.mkdirSync(path.join(tmp, "01_intent"), { recursive: true });
      fs.copyFileSync(
        path.resolve("projects/demo/01_intent/creative_brief.yaml"),
        path.join(tmp, "01_intent/creative_brief.yaml"),
      );
      const report = await evaluateBriefAlignment(tmp, {
        stages: ["selects", "blueprint"],
        useLlm: true,
        judge: { apiKey: null },
        evaluatedAt: "2026-06-17T00:00:00.000Z",
      });
      expect(report.stages.selects).toBeUndefined();
      expect(report.stages.blueprint).toBeUndefined();
      expect(report.composite).toBe(0);
      expect(report.notes).toContain("selects stage skipped: 04_plan/selects_candidates.yaml not found");
      expect(report.notes).toContain("blueprint stage skipped: 04_plan/edit_blueprint.yaml not found");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("tags deterministic-only composites and records deterministic runtime provenance", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brief-alignment-deterministic-only-"));
    try {
      fs.mkdirSync(path.join(tmp, "01_intent"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "04_plan"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "01_intent/creative_brief.yaml"),
        JSON.stringify({
          ...brief(),
          version: "1",
          created_at: "2026-06-17T00:00:00.000Z",
          audience: { primary: "outdoor learners" },
          autonomy: { may_decide: ["candidate order"], must_ask: [] },
          resolved_assumptions: ["Use visible practice moments."],
        }, null, 2),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(tmp, "04_plan/selects_candidates.yaml"),
        JSON.stringify(selects(), null, 2),
        "utf-8",
      );

      const report = await evaluateBriefAlignment(tmp, {
        stages: ["selects"],
        useLlm: true,
        judge: {
          apiKey: null,
          connector: { commandExists: () => false, env: {} },
        },
        evaluatedAt: "2026-06-17T00:00:00.000Z",
      });

      expect(report.composite).toBeGreaterThan(0);
      expect(report.judge_source).toBe("deterministic-only");
      expect(report.decision_runtime?.[0].runtime).toBe("deterministic");
      expect(report.notes).toContain("selects judge skipped: runtime=deterministic");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses selects story_role for narrative scoring and semantic_rank ordering", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brief-alignment-story-role-"));
    try {
      fs.mkdirSync(path.join(tmp, "01_intent"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "04_plan"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "01_intent/creative_brief.yaml"),
        JSON.stringify({
          ...brief(),
          version: "1",
          created_at: "2026-06-17T00:00:00.000Z",
          audience: { primary: "outdoor learners" },
          autonomy: { may_decide: ["candidate order"], must_ask: [] },
          resolved_assumptions: ["Use visible practice moments."],
        }, null, 2),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(tmp, "04_plan/selects_candidates.yaml"),
        JSON.stringify({
          version: "1",
          project_id: "alignment-fixture",
          candidates: [
            {
              segment_id: "SEG_HOOK",
              asset_id: "A",
              src_in_us: 0,
              src_out_us: 5_000_000,
              role: "hero",
              story_role: "hook",
              semantic_rank: 1,
              why_it_matches: "Opening uncertainty hooks the viewer.",
              risks: [],
              confidence: 0.9,
            },
            {
              segment_id: "SEG_SETUP",
              asset_id: "B",
              src_in_us: 0,
              src_out_us: 5_000_000,
              role: "support",
              story_role: "setup",
              semantic_rank: 2,
              why_it_matches: "Establishes the coaching context.",
              risks: [],
              confidence: 0.85,
            },
            {
              segment_id: "SEG_EXPERIENCE",
              asset_id: "C",
              src_in_us: 0,
              src_out_us: 5_000_000,
              role: "dialogue",
              story_role: "experience",
              semantic_rank: 3,
              why_it_matches: "Main practice experience carries the middle.",
              risks: [],
              confidence: 0.82,
            },
            {
              segment_id: "SEG_CLOSING",
              asset_id: "D",
              src_in_us: 0,
              src_out_us: 5_000_000,
              role: "texture",
              story_role: "closing",
              semantic_rank: 4,
              why_it_matches: "Closing smile provides release.",
              risks: [],
              confidence: 0.8,
            },
          ],
        }, null, 2),
        "utf-8",
      );

      const report = await evaluateBriefAlignment(tmp, {
        stages: ["selects"],
        useLlm: false,
        evaluatedAt: "2026-06-17T00:00:00.000Z",
      });

      const narrative = report.stages.selects?.axes.narrative_structure;
      expect(narrative?.confidence).toBe(0.8);
      expect(narrative?.score).toBeGreaterThan(0.9);
      expect(narrative?.evidence).toContain("story_role present on 4/4 candidates");
      expect(narrative?.evidence).toContain("story_role semantic_rank order hook -> experience -> closing confirmed");
      expect(narrative?.gaps).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
