import { describe, expect, it } from "vitest";
import {
  planClipTrims,
  type ClipTrimPlan,
} from "../runtime/agents/clip-trim-agent.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { MarlinEventsArtifact } from "../runtime/connectors/marlin-types.js";
import type { Candidate, CraftDirective, CreativeBrief } from "../runtime/compiler/types.js";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    segment_id: "SEG_001",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 10_000_000,
    role: "hero",
    why_it_matches: "test candidate",
    risks: [],
    confidence: 0.8,
    ...overrides,
  };
}

function segment(overrides: Partial<SegmentItem> = {}): SegmentItem {
  return {
    segment_id: "SEG_001",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 10_000_000,
    duration_us: 10_000_000,
    rep_frame_us: 5_000_000,
    summary: "test segment",
    transcript_excerpt: "",
    quality_flags: [],
    tags: [],
    segment_type: "shot",
    transcript_ref: null,
    confidence: {
      boundary: {
        score: 1,
        source: "test",
        status: "ready",
      },
    },
    provenance: {
      boundary: {
        stage: "test",
        method: "test",
        connector_version: "test",
        policy_hash: "test",
        request_hash: "test",
      },
    },
    ...overrides,
  };
}

function brief(overrides: Partial<CreativeBrief> & Record<string, unknown> = {}): CreativeBrief {
  return {
    version: "1",
    project_id: "trim-test",
    project: {
      id: "trim-test",
      title: "Trim Test",
      strategy: "show a warm, human moment",
    },
    message: {
      primary: "A warm human story",
    },
    emotion_curve: ["warmth"],
    ...overrides,
  } as CreativeBrief;
}

function marlinArtifact(events: MarlinEventsArtifact["items"][number]["events"]): MarlinEventsArtifact {
  return {
    project_id: "trim-test",
    artifact_version: "marlin-events-v1",
    model: {
      provider: "marlin",
      model_alias: "NemoStation/Marlin-2B",
      model_snapshot: "test",
    },
    items: [
      {
        asset_id: "AST_001",
        source_path: "media/test.mp4",
        scene: "test scene",
        events,
        find_results: [],
      },
    ],
  };
}

function eventPlan(plans: ClipTrimPlan[]): ClipTrimPlan {
  const plan = plans.find((item) => item.source === "marlin_event");
  expect(plan).toBeDefined();
  return plan!;
}

describe("planClipTrims", () => {
  it("selects a specific Marlin event range instead of the center of source", () => {
    const plans = planClipTrims(
      [candidate()],
      [segment()],
      marlinArtifact([
        {
          event_id: "MEV_AST_001_0001",
          start_us: 4_500_000,
          end_us: 6_000_000,
          description: "hand gesture during the key explanation",
          confidence: 0.86,
          source_pass: "marlin_caption",
        },
      ]),
      brief({ must_have: ["gesture"] }),
      new Map(),
    );

    const plan = eventPlan(plans);
    expect(plan.best_in_us).toBe(4_500_000);
    expect(plan.best_out_us).toBe(6_000_000);
    expect((plan.best_in_us + plan.best_out_us) / 2).not.toBe(5_000_000);
    expect(plan.technique).toBe("cut_on_action");
  });

  it("scores event descriptions by relevance to the brief", () => {
    const plans = planClipTrims(
      [candidate()],
      [segment()],
      marlinArtifact([
        {
          event_id: "MEV_AST_001_0001",
          start_us: 2_000_000,
          end_us: 4_500_000,
          description: "wide room setup before the answer",
          confidence: 0.9,
          source_pass: "marlin_caption",
        },
        {
          event_id: "MEV_AST_001_0002",
          start_us: 5_000_000,
          end_us: 7_500_000,
          description: "speaker smiles warmly after the answer",
          confidence: 0.74,
          source_pass: "marlin_caption",
        },
      ]),
      brief({ emotion_curve: ["warmth"] }),
      new Map(),
    );

    const plan = eventPlan(plans);
    expect(plan.event_id).toBe("MEV_AST_001_0002");
    expect(plan.rationale).toContain("matches warmth in brief");
  });

  it("reports beat-level craft as fallback when no Marlin events exist", () => {
    const craft = new Map<string, CraftDirective>([
      ["b01", { in_point: "peak_hold" }],
    ]);

    const plans = planClipTrims(
      [candidate({ eligible_beats: ["b01"] })],
      [segment()],
      marlinArtifact([]),
      brief(),
      craft,
    );

    expect(plans).toEqual([
      expect.objectContaining({
        segment_id: "SEG_001",
        best_in_us: 0,
        best_out_us: 10_000_000,
        source: "beat_craft_fallback",
        technique: "peak_hold",
      }),
    ]);
    expect(plans[0].rationale).toContain("fallback to beat-level craft");
  });

  it("skips very short events under 0.5s", () => {
    const plans = planClipTrims(
      [candidate()],
      [segment()],
      marlinArtifact([
        {
          event_id: "MEV_AST_001_0001",
          start_us: 2_000_000,
          end_us: 2_300_000,
          description: "brief smile",
          confidence: 0.99,
          source_pass: "marlin_caption",
        },
      ]),
      brief({ emotion_curve: ["warmth"] }),
      new Map(),
    );

    expect(plans).toEqual([]);
  });

  it("writes a rationale that names the chosen event and brief match", () => {
    const plans = planClipTrims(
      [candidate()],
      [segment()],
      marlinArtifact([
        {
          event_id: "MEV_AST_001_0001",
          start_us: 0,
          end_us: 1_500_000,
          description: "man smiles at the camera",
          confidence: 0.8,
          source_pass: "marlin_caption",
        },
      ]),
      brief({ emotion_curve: ["warmth"] }),
      new Map(),
    );

    const plan = eventPlan(plans);
    expect(plan.rationale).toContain("using event: man smiles at the camera (0-1.5s)");
    expect(plan.rationale).toContain("matches warmth in brief");
  });
});
