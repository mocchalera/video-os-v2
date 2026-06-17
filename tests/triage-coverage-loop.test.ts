import { describe, expect, it } from "vitest";
import type { CreativeBrief } from "../runtime/artifacts/types.js";
import {
  coveragePasses,
  runCoverageForcedSelection,
  type SelectCandidate,
  type SelectsCandidates,
  type TriageAgent,
  type TriageAgentContext,
} from "../runtime/commands/triage.js";
import type { SelectionCoverageSegment } from "../runtime/eval/selection-coverage.js";

function brief(): CreativeBrief {
  return {
    version: "1",
    project_id: "p",
    project: {
      id: "p",
      title: "coverage fixture",
      strategy: "test breadth selection",
      runtime_target_sec: 32,
    },
    message: { primary: "show the full rescue pattern" },
    emotion_curve: ["setup", "tension", "release"],
    must_have: [],
  } as CreativeBrief;
}

function segments(): SelectionCoverageSegment[] {
  return [
    segment("SEG_001", "A rescue team crosses the snowy ridge with ropes before the evacuation."),
    segment("SEG_002", "A rescue team crosses the snowy ridge with ropes before the evacuation."),
    segment("SEG_003", "A rescue team crosses the snowy ridge with ropes before the evacuation."),
    segment("SEG_004", "A rescue team crosses the snowy ridge with ropes before the evacuation."),
    segment("SEG_005", "A medic checks the radio and confirms weather conditions."),
    segment("SEG_006", "The subject smiles after reaching the warm cabin."),
  ];
}

function segment(segmentId: string, summary: string): SelectionCoverageSegment {
  return { segment_id: segmentId, summary };
}

function candidate(segmentId: string, role: SelectCandidate["role"] = "support"): SelectCandidate {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 5_000_000,
    role,
    why_it_matches: `covers ${segmentId}`,
    risks: [],
    confidence: 0.8,
  };
}

function selects(segmentIds: string[]): SelectsCandidates {
  return {
    version: "1",
    project_id: "p",
    candidates: segmentIds.map((segmentId, index) =>
      candidate(segmentId, index === 0 ? "hero" : "support"),
    ),
  };
}

function alignedSelects(): SelectsCandidates {
  const output = selects(["SEG_001", "SEG_002", "SEG_003", "SEG_005"]);
  const storyRoles: Array<SelectCandidate["story_role"]> = ["hook", "setup", "experience", "closing"];
  const beats = ["setup", "tension", "tension", "release"];
  output.candidates = output.candidates.map((item, index) => ({
    ...item,
    story_role: storyRoles[index],
    eligible_beats: [beats[index]],
    evidence: [beats[index]],
    editorial_signals: { peak_strength_score: 0.7 },
  }));
  return output;
}

function context(): TriageAgentContext {
  return {
    projectDir: "/tmp/video-os-coverage-loop",
    projectId: "p",
    currentState: "media_analyzed",
    analysisGate: "ready",
  };
}

describe("runCoverageForcedSelection", () => {
  it("feeds coverage gaps back and accepts the improved breadth selection", async () => {
    const calls: TriageAgentContext[] = [];
    const agent: TriageAgent = {
      async run(ctx) {
        calls.push(copyContext(ctx));
        return {
          selects: ctx.coverageFeedback
            ? alignedSelects()
            : selects(["SEG_001"]),
          confirmed: true,
        };
      },
    };

    const result = await runCoverageForcedSelection(agent, context(), brief(), segments());

    expect(calls).toHaveLength(2);
    expect(calls[0].coverageFeedback).toBeUndefined();
    expect(calls[1].coverageFeedback).toMatchObject({
      round: 1,
      previous_selection_count: 1,
    });
    expect(calls[1].coverageFeedback?.gaps.some((gap) => gap.startsWith("selection sparse:"))).toBe(true);
    expect(calls[1].coverageFeedback?.brief_alignment_gaps?.some((gap) => gap.axis === "narrative_structure")).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.rounds).toBe(2);
    expect(result.passed).toBe(true);
    expect(result.coverage && coveragePasses(result.coverage)).toBe(true);
    expect(result.result.selects.candidates.map((c) => c.segment_id)).toEqual([
      "SEG_001",
      "SEG_002",
      "SEG_003",
      "SEG_005",
    ]);
  });

  it("stops early when the active segment set does not improve", async () => {
    const calls: TriageAgentContext[] = [];
    const agent: TriageAgent = {
      async run(ctx) {
        calls.push(copyContext(ctx));
        return { selects: selects(["SEG_001"]), confirmed: true };
      },
    };

    const result = await runCoverageForcedSelection(agent, context(), brief(), segments(), 5);

    expect(calls).toHaveLength(2);
    expect(result.skipped).toBe(false);
    expect(result.rounds).toBe(2);
    expect(result.passed).toBe(false);
    expect(result.coverage && coveragePasses(result.coverage)).toBe(false);
  });

  it("keeps coverage failing until candidate count reaches the target-runtime minimum", async () => {
    const calls: TriageAgentContext[] = [];
    const agent: TriageAgent = {
      async run(ctx) {
        calls.push(copyContext(ctx));
        return { selects: alignedSelects(), confirmed: true };
      },
    };
    const longBrief = {
      ...brief(),
      project: {
        ...brief().project,
        runtime_target_sec: 80,
      },
    } as CreativeBrief;

    const result = await runCoverageForcedSelection(agent, context(), longBrief, segments());

    expect(calls).toHaveLength(2);
    expect(calls[1].coverageFeedback?.gaps).toContain("insufficient clip count for target runtime");
    expect(calls[1].coverageFeedback?.cut_count_feedback).toBe(
      "only 4 candidates selected but target runtime 80s requires at least 10 clips. Select more clips from diverse segments.",
    );
    expect(calls[1].coverageFeedback?.brief_alignment_gaps?.some((gap) => gap.axis === "minimum_cut_count")).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.coverage && coveragePasses(result.coverage, 10)).toBe(false);
  });

  it("skips the loop when coverage inputs are unavailable", async () => {
    const calls: TriageAgentContext[] = [];
    const agent: TriageAgent = {
      async run(ctx) {
        calls.push(copyContext(ctx));
        return { selects: selects(["SEG_001"]), confirmed: true };
      },
    };

    const result = await runCoverageForcedSelection(agent, context(), undefined, segments());

    expect(calls).toHaveLength(1);
    expect(calls[0].coverageFeedback).toBeUndefined();
    expect(result.skipped).toBe(true);
    expect(result.rounds).toBe(1);
    expect(result.coverage).toBeUndefined();
  });

  it("keeps the previous selection when a feedback round fails instead of crashing", async () => {
    let callCount = 0;
    const agent: TriageAgent = {
      async run(ctx) {
        callCount += 1;
        if (ctx.coverageFeedback) {
          throw new Error("LLM triage response was not valid JSON after retry");
        }
        return { selects: selects(["SEG_001"]), confirmed: true }; // sparse round 0
      },
    };

    const result = await runCoverageForcedSelection(agent, context(), brief(), segments());

    expect(callCount).toBe(2); // round 0 ok, round 1 throws -> caught
    expect(result.skipped).toBe(false);
    expect(result.result.selects.candidates.map((c) => c.segment_id)).toEqual(["SEG_001"]); // round 0 kept
    expect(result.coverage).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it("propagates a round-0 failure (no prior selection to keep)", async () => {
    const agent: TriageAgent = {
      async run() {
        throw new Error("LLM unavailable");
      },
    };
    await expect(runCoverageForcedSelection(agent, context(), brief(), segments())).rejects.toThrow(
      "LLM unavailable",
    );
  });
});

function copyContext(ctx: TriageAgentContext): TriageAgentContext {
  return {
    ...ctx,
    coverageFeedback: ctx.coverageFeedback
      ? {
          ...ctx.coverageFeedback,
          gaps: [...ctx.coverageFeedback.gaps],
          cut_count_feedback: ctx.coverageFeedback.cut_count_feedback,
          brief_alignment_gaps: ctx.coverageFeedback.brief_alignment_gaps
            ? ctx.coverageFeedback.brief_alignment_gaps.map((gap) => ({ ...gap }))
            : undefined,
        }
      : undefined,
  };
}
