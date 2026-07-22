import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  computeReviewMetrics,
  loadReviewMetricsInputs,
  type ReviewMetricId,
  type ReviewMetricsInputs,
} from "../runtime/review/metrics.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "../runtime/compiler/types.js";
import type {
  AdjacencyAnalysis,
  CutRelationAxis,
  CutRelationResult,
  CutRelationSignal,
} from "../runtime/compiler/transition-types.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const demoDir = path.join(repoRoot, "projects/demo");

describe("review metrics", () => {
  it("computes schema-valid metrics from projects/demo artifacts", () => {
    const metrics = computeReviewMetrics(loadReviewMetricsInputs(demoDir));
    const validation = validateAgainstSchema(metrics, "review-metrics.schema.json");

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(metrics.project_id).toBe("sample-mountain-reset");
    expect(metrics.version).toBe("2");
    expect(metrics.summary.total_checks).toBe(16);
    expect(metrics.checks.map((item) => item.id)).toEqual([
      "rhythm.beat_duration_deviation",
      "rhythm.max_shot_length",
      "rhythm.cadence_distribution",
      "story.required_roles",
      "story.chronology",
      "story.dialogue_completeness",
      "emotion.peak_retention",
      "emotion.hook_density",
      "eye_trace.same_asset_adjacency",
      "eye_trace.attention_jump",
      "eye_trace.motion_flow",
      "plane_2d.framing_jump",
      "plane_2d.luma_color_jump",
      "space_3d.direction_axis",
      "plane_2d.motif_overuse",
      "audio.speech_cut",
    ]);
    expect(metrics.summary.by_tier.space_3d).toEqual({ pass: 0, warn: 0, fail: 0, skipped: 1 });
  });

  it("keeps a legacy v1 review metrics artifact schema-valid", () => {
    const current = computeReviewMetrics(loadReviewMetricsInputs(demoDir));
    const legacy = structuredClone(current) as Record<string, any>;
    legacy.version = "1";
    legacy.checks = legacy.checks.filter((item: { id: ReviewMetricId }) => ![
      "eye_trace.attention_jump",
      "eye_trace.motion_flow",
      "plane_2d.framing_jump",
      "plane_2d.luma_color_jump",
      "space_3d.direction_axis",
    ].includes(item.id));
    legacy.summary.total_checks = legacy.checks.length;
    delete legacy.summary.by_tier.space_3d;

    const validation = validateAgainstSchema(legacy, "review-metrics.schema.json");
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  const scenarios: Array<{
    id: ReviewMetricId;
    mutate: (inputs: ReviewMetricsInputs) => void;
  }> = [
    {
      id: "rhythm.beat_duration_deviation",
      mutate: (inputs) => {
        inputs.timeline!.markers = [
          { frame: 0, kind: "beat", label: "b01: hook" },
          { frame: 160, kind: "beat", label: "b02: middle" },
          { frame: 208, kind: "beat", label: "b03: end" },
        ];
      },
    },
    {
      id: "rhythm.max_shot_length",
      mutate: (inputs) => {
        inputs.timeline!.tracks.video[0].clips[0].timeline_duration_frames = 200;
      },
    },
    {
      id: "rhythm.cadence_distribution",
      mutate: (inputs) => {
        const clips = inputs.timeline!.tracks.video[0].clips;
        clips[0].timeline_duration_frames = 120;
        clips[1].timeline_duration_frames = 24;
        clips[2].timeline_duration_frames = 24;
      },
    },
    {
      id: "story.required_roles",
      mutate: (inputs) => {
        inputs.timeline!.tracks.audio[0].clips = [];
      },
    },
    {
      id: "story.chronology",
      mutate: (inputs) => {
        inputs.brief!.order_policy = "chronological";
        const clips = inputs.timeline!.tracks.video[0].clips;
        clips[0].asset_id = "AST_CHRON";
        clips[0].src_in_us = 4_000_000;
        clips[0].src_out_us = 6_000_000;
        clips[1].asset_id = "AST_CHRON";
        clips[1].src_in_us = 1_000_000;
        clips[1].src_out_us = 3_000_000;
      },
    },
    {
      id: "story.dialogue_completeness",
      mutate: (inputs) => {
        inputs.transcripts![0].items![0].text = "判断の質も";
      },
    },
    {
      id: "emotion.peak_retention",
      mutate: (inputs) => {
        inputs.timeline!.tracks.video[0].clips[0].src_out_us = 500_000;
      },
    },
    {
      id: "emotion.hook_density",
      mutate: (inputs) => {
        const peak = inputs.segments!.items![0].peak_analysis!.peak_moments![0];
        peak.confidence = 0.1;
      },
    },
    {
      id: "eye_trace.same_asset_adjacency",
      mutate: (inputs) => {
        inputs.timeline!.tracks.video[0].clips[1].asset_id = "AST_A";
      },
    },
    {
      id: "plane_2d.motif_overuse",
      mutate: (inputs) => {
        for (const candidate of inputs.selects!.candidates!.slice(0, 3)) {
          candidate.motif_tags = ["repeat"];
        }
      },
    },
    {
      id: "audio.speech_cut",
      mutate: (inputs) => {
        const dialogue = inputs.timeline!.tracks.audio[0].clips[0];
        dialogue.src_in_us = 500_000;
        dialogue.src_out_us = 1_500_000;
      },
    },
  ];

  for (const scenario of scenarios) {
    it(`detects ${scenario.id} as fail for a synthetic violation`, () => {
      const inputs = syntheticInputs();
      scenario.mutate(inputs);

      const metrics = computeReviewMetrics(inputs);
      const validation = validateAgainstSchema(metrics, "review-metrics.schema.json");
      const item = metrics.checks.find((check) => check.id === scenario.id);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
      expect(item).toBeDefined();
      expect(item?.status).toBe("fail");
      expect(item?.evidence.length).toBeGreaterThan(0);
    });
  }

  it("does not flag exact utterance edges inside adjacent STT overlap as speech cuts", () => {
    const inputs = syntheticInputs();
    const dialogue = inputs.timeline!.tracks.audio[0].clips[0];
    dialogue.src_in_us = 100_000;
    dialogue.src_out_us = 1_900_000;
    inputs.transcripts![0].items = [
      {
        speaker: "S1",
        start_us: 100_000,
        end_us: 1_900_000,
        text: "First overlapping utterance.",
      },
      {
        speaker: "S1",
        start_us: 1_500_000,
        end_us: 2_500_000,
        text: "Second overlapping utterance.",
      },
    ];

    const metrics = computeReviewMetrics(inputs);
    const speechCut = metrics.checks.find((check) => check.id === "audio.speech_cut");

    expect(speechCut?.status).toBe("pass");
  });

  it("excludes declared ending tail frames from beat pacing deviation", () => {
    const inputs = syntheticInputs();
    const ending = inputs.timeline!.tracks.video[0].clips.at(-1)!;
    ending.timeline_duration_frames += 24;
    ending.metadata = {
      ending_treatment: {
        extended_frames: 24,
        audio_fade_out_frames: 24,
        video_fade_out_frames: 12,
        video_fade_color: "black",
      },
    };

    const metrics = computeReviewMetrics(inputs);
    const pacing = metrics.checks.find((check) => check.id === "rhythm.beat_duration_deviation");

    expect(pacing?.status).toBe("pass");
    expect(pacing?.measured).toMatchObject({
      max_deviation_pct: 0,
      beats: expect.arrayContaining([
        expect.objectContaining({
          beat_id: "b03",
          actual_frames: 72,
          pacing_frames: 48,
          ending_treatment_frames: 24,
          deviation_pct: 0,
        }),
      ]),
    });
  });

  it("does not treat visual-only transcript support clips as audible speech cuts", () => {
    const inputs = syntheticInputs();
    const support = inputs.timeline!.tracks.video[0].clips[1];
    support.src_in_us = 500_000;
    support.src_out_us = 1_500_000;
    inputs.transcripts!.push({
      project_id: "synthetic-review-metrics",
      artifact_version: "analysis-v1",
      transcript_ref: "TR_AST_B",
      asset_id: "AST_B",
      items: [
        {
          speaker: "S1",
          start_us: 100_000,
          end_us: 1_900_000,
          text: "Visual-only support source has transcript but no audible program clip.",
        },
      ],
    });

    const metrics = computeReviewMetrics(inputs);
    const speechCut = metrics.checks.find((check) => check.id === "audio.speech_cut");

    expect(speechCut?.status).toBe("pass");
    expect(speechCut?.measured).toMatchObject({ checked_clip_count: 1 });
  });

  it("does not require segment-level peaks outside the selected candidate source range", () => {
    const inputs = syntheticInputs();
    const hook = inputs.timeline!.tracks.video[0].clips[0];
    const hookCandidate = inputs.selects!.candidates![0];
    hook.src_in_us = 10_000_000;
    hook.src_out_us = 12_000_000;
    hook.candidate_ref = "legacy:SEG_HOOK:10000000:12000000";
    hookCandidate.src_in_us = 10_000_000;
    hookCandidate.src_out_us = 12_000_000;

    const metrics = computeReviewMetrics(inputs);
    const peakRetention = metrics.checks.find((check) => check.id === "emotion.peak_retention");

    expect(peakRetention?.status).toBe("pass");
    expect(peakRetention?.measured).toMatchObject({
      evaluated_strong_peaks: 0,
      discarded_strong_peaks: [],
    });
  });

  it("uses timeline clip metadata peak signals for hook density", () => {
    const inputs = syntheticInputs();
    const peak = inputs.segments!.items![0].peak_analysis!.peak_moments![0];
    peak.confidence = 0.1;
    inputs.timeline!.tracks.video[0].clips[0].metadata = {
      editorial: {
        peak: {
          primary_peak_ref: "LOCAL_HOOK",
          peak_type: "emotional_peak",
          peak_confidence: 0.9,
        },
      },
    };

    const metrics = computeReviewMetrics(inputs);
    const hookDensity = metrics.checks.find((check) => check.id === "emotion.hook_density");

    expect(hookDensity?.status).toBe("pass");
    expect(hookDensity?.measured).toMatchObject({
      high_signal_clip_ids: ["CLP_HOOK"],
    });
  });

  it("evaluates a two-beat Japanese cadence policy without requiring a middle section", () => {
    const inputs = syntheticInputs();
    inputs.blueprint!.beats = [
      { ...inputs.blueprint!.beats[0], story_role: "hook" },
      { ...inputs.blueprint!.beats[2], story_role: "closing" },
    ];
    inputs.blueprint!.pacing.opening_cadence = "すぐ本題へ入り、前置きを置かない。";
    inputs.blueprint!.pacing.ending_cadence = "言い切った後に余韻を残す。";
    const clips = inputs.timeline!.tracks.video[0].clips;
    inputs.timeline!.tracks.video[0].clips = [clips[0], {
      ...clips[2],
      timeline_duration_frames: 72,
    }];

    const metrics = computeReviewMetrics(inputs);
    const cadence = metrics.checks.find((check) => check.id === "rhythm.cadence_distribution");

    expect(cadence?.status).toBe("pass");
    expect(cadence?.measured).toMatchObject({
      average_shot_length_frames: {
        opening: 48,
        middle: null,
        ending: 72,
      },
      section_clip_counts: {
        opening: 1,
        middle: 0,
        ending: 1,
      },
      cadence_rank: {
        opening: 1,
        ending: 3,
      },
    });
  });

  it("fails a two-beat cadence when a spacious ending is materially shorter than a brisk opening", () => {
    const inputs = syntheticInputs();
    inputs.blueprint!.beats = [
      { ...inputs.blueprint!.beats[0], story_role: "hook" },
      { ...inputs.blueprint!.beats[2], story_role: "closing" },
    ];
    inputs.blueprint!.pacing.opening_cadence = "すぐ本題へ入る。";
    inputs.blueprint!.pacing.ending_cadence = "余韻を残して自然に閉じる。";
    const clips = inputs.timeline!.tracks.video[0].clips;
    inputs.timeline!.tracks.video[0].clips = [clips[0], {
      ...clips[2],
      timeline_duration_frames: 24,
    }];

    const metrics = computeReviewMetrics(inputs);
    const cadence = metrics.checks.find((check) => check.id === "rhythm.cadence_distribution");

    expect(cadence?.status).toBe("fail");
    expect(cadence?.evidence[0]).toContain("ending: average 24f should not be shorter than opening 48f");
  });

  it("uses transcript-led editorial signals for hook density", () => {
    const inputs = syntheticInputs();
    inputs.segments!.items![0].peak_analysis!.peak_moments![0].confidence = 0.1;
    inputs.selects!.candidates![0].editorial_signals = {
      speech_intensity_score: 0.86,
      authenticity_score: 0.91,
      surprise_signal: 0.92,
    };

    const metrics = computeReviewMetrics(inputs);
    const hookDensity = metrics.checks.find((check) => check.id === "emotion.hook_density");

    expect(hookDensity?.status).toBe("pass");
    expect(hookDensity?.measured).toMatchObject({
      hook_density: 1,
      high_signal_clip_ids: ["CLP_HOOK"],
    });
    expect(hookDensity?.evidence[0]).toContain("editorial signal");
  });

  it("warns for unavoidable same-asset adjacency when selected candidates expose only one asset", () => {
    const inputs = syntheticInputs();
    const clips = inputs.timeline!.tracks.video[0].clips;
    clips[1].asset_id = "AST_A";
    clips[2].asset_id = "AST_A";
    for (const candidate of inputs.selects!.candidates!) {
      candidate.asset_id = "AST_A";
    }

    const metrics = computeReviewMetrics(inputs);
    const check = metrics.checks.find((item) => item.id === "eye_trace.same_asset_adjacency");

    expect(check?.status).toBe("warn");
    expect(check?.measured).toMatchObject({
      v1_asset_ids: ["AST_A"],
      selected_candidate_asset_ids: ["AST_A"],
    });
    expect(check?.evidence[0]).toContain("Selected candidates expose only 1 unique asset");
  });

  it("passes a same-asset adjacency that has an explicit punch-in treatment", () => {
    const inputs = syntheticInputs();
    const clips = inputs.timeline!.tracks.video[0].clips;
    clips[1].asset_id = "AST_A";
    clips[1].metadata = {
      zoom: 1.08,
      editorial: {
        camera_move: {
          type: "punch_in",
          scale: 1.08,
          reason: "same_asset_jump_cut",
        },
      },
    };
    for (const candidate of inputs.selects!.candidates!) {
      candidate.asset_id = "AST_A";
    }

    const metrics = computeReviewMetrics(inputs);
    const check = metrics.checks.find((item) => item.id === "eye_trace.same_asset_adjacency");

    expect(check?.status).toBe("pass");
    expect(check?.measured).toMatchObject({
      untreated_same_asset_pairs: [],
      visually_differentiated_pairs: [{
        left_clip_id: clips[0].clip_id,
        right_clip_id: clips[1].clip_id,
        treatment: "punch_in",
      }],
    });
    expect(check?.evidence[0]).toContain("visually differentiated");
  });

  it("fails same-asset adjacency when the selected pool offers alternative assets", () => {
    const inputs = syntheticInputs();
    inputs.timeline!.tracks.video[0].clips[1].asset_id = "AST_A";

    const metrics = computeReviewMetrics(inputs);
    const check = metrics.checks.find((item) => item.id === "eye_trace.same_asset_adjacency");

    expect(check?.status).toBe("fail");
    expect(check?.measured).toMatchObject({
      selected_candidate_asset_ids: ["AST_A", "AST_B", "AST_C", "AST_D"],
    });
  });

  it("accepts intentional continuity repetition for longform reduction", () => {
    const inputs = syntheticInputs();
    inputs.brief!.longform = { mode: "reduction" };
    inputs.timeline!.tracks.video[0].clips[1].asset_id = "AST_A";
    for (const candidate of inputs.selects!.candidates!.slice(0, 3)) {
      candidate.motif_tags = ["chapter_01"];
    }

    const metrics = computeReviewMetrics(inputs);
    const adjacency = metrics.checks.find((item) => item.id === "eye_trace.same_asset_adjacency");
    const motif = metrics.checks.find((item) => item.id === "plane_2d.motif_overuse");

    expect(adjacency?.status).toBe("pass");
    expect(adjacency?.threshold).toMatchObject({ longform_continuity_allowed: true });
    expect(motif?.status).toBe("pass");
    expect(motif?.threshold).toMatchObject({
      allow_intentional_repetition: true,
      longform_continuity_allowed: true,
    });
  });

  it("passes all five relation metrics only for fully covered continuous bound pairs", () => {
    const inputs = syntheticInputs();
    inputs.adjacency = adjacencyFor(inputs, [cutRelation("continuous"), cutRelation("continuous")]);

    const metrics = computeReviewMetrics(inputs);
    for (const id of relationMetricIds) {
      const item = metrics.checks.find((check) => check.id === id);
      expect(item?.status, id).toBe("pass");
      expect(item?.measured).toMatchObject({
        total_pairs: 2,
        evaluated_pairs: 2,
        unknown_pairs: 0,
        intentional_pairs: 0,
        risky_pairs: 0,
        violations: [],
        warnings: [],
        binding: { status: "bound", mode: "clip_ids" },
      });
      expect(item?.threshold).toMatchObject({
        advisory: true,
        policy_source: "runtime/compiler/cut-relation.ts:CUT_RELATION_THRESHOLDS",
        canonical_relation_source: "05_timeline/adjacency_analysis.json:pairs[].cut_relation",
        profile_brief_signal: { threshold_override_applied: false },
      });
    }
  });

  it("does not fail intentional hard contrast in relation metrics or same-asset adjacency", () => {
    const inputs = syntheticInputs();
    inputs.timeline!.tracks.video[0].clips[1].asset_id = "AST_A";
    inputs.adjacency = adjacencyFor(inputs, [
      cutRelation("intentional_contrast", {
        majorAxes: ["shot_scale", "composition", "gaze_axis", "motion_flow", "luma", "dominant_color", "text_presence"],
        intentional: true,
      }),
      cutRelation("continuous"),
    ]);

    const metrics = computeReviewMetrics(inputs);
    for (const id of [...relationMetricIds, "eye_trace.same_asset_adjacency"] as ReviewMetricId[]) {
      expect(metrics.checks.find((check) => check.id === id)?.status, id).not.toBe("fail");
    }
    expect(metrics.checks.find((check) => check.id === "eye_trace.same_asset_adjacency")?.measured)
      .toMatchObject({
        untreated_same_asset_pairs: [],
        intentional_pairs: [expect.objectContaining({
          left_clip_id: "CLP_HOOK",
          right_clip_id: "CLP_MID",
          relationship: "intentional_contrast",
          explicit_intent_evidence: [expect.objectContaining({ source: "beat_craft", intent: "hard_cut" })],
        })],
      });
  });

  it("fails only mapped axes for accidental risky major jumps and retains deterministic pair evidence", () => {
    const inputs = syntheticInputs();
    inputs.adjacency = adjacencyFor(inputs, [
      cutRelation("risky_jump", { majorAxes: ["shot_scale", "gaze_axis"] }),
      cutRelation("continuous"),
    ]);

    const first = computeReviewMetrics(inputs);
    const second = computeReviewMetrics(structuredClone(inputs));
    expect(second).toEqual(first);
    expect(first.checks.find((check) => check.id === "plane_2d.framing_jump")?.status).toBe("fail");
    expect(first.checks.find((check) => check.id === "space_3d.direction_axis")?.status).toBe("fail");
    expect(first.checks.find((check) => check.id === "eye_trace.motion_flow")?.status).toBe("pass");
    expect(first.checks.find((check) => check.id === "plane_2d.framing_jump")?.measured).toMatchObject({
      risky_pairs: 1,
      violations: [expect.objectContaining({
        pair_id: "V1:b01->b02",
        left_clip_id: "CLP_HOOK",
        right_clip_id: "CLP_MID",
        left_ref: "CLP_HOOK",
        right_ref: "CLP_MID",
        relationship: "risky_jump",
        axis_signals: [expect.objectContaining({
          axis_id: "shot_scale",
          coverage: "known",
          major_discontinuity: true,
          reason_codes: ["fixture_major"],
        })],
      })],
    });
  });

  it("uses ordered legacy refs for binding while keeping legacy v1 and v2 adjacency schema-valid", () => {
    const inputs = syntheticInputs();
    const legacy = adjacencyFor(inputs, [cutRelation("continuous"), cutRelation("continuous")], { legacy: true });
    inputs.adjacency = legacy;
    const metrics = computeReviewMetrics(inputs);
    expect(metrics.checks.find((check) => check.id === "eye_trace.motion_flow")?.measured)
      .toMatchObject({ binding: { status: "bound", mode: "legacy_refs" } });

    for (const version of ["1", "2"] as const) {
      const validation = validateAgainstSchema({ ...legacy, version }, "adjacency-analysis.schema.json");
      expect(validation.valid, `${version}: ${validation.errors.join("; ")}`).toBe(true);
    }
  });

  it.each([false, true])("skips project-mismatched adjacency in %s legacy mode", (legacy) => {
    const inputs = syntheticInputs();
    inputs.adjacency = adjacencyFor(
      inputs,
      [cutRelation("risky_jump", { majorAxes: ["shot_scale"] }), cutRelation("continuous")],
      { legacy, projectId: "another-project" },
    );

    const metrics = computeReviewMetrics(inputs);
    for (const id of relationMetricIds) {
      expect(metrics.checks.find((check) => check.id === id)).toMatchObject({
        status: "skipped",
        measured: {
          violations: [],
          binding: {
            status: "mismatch",
            reason_codes: ["adjacency_timeline_mismatch", "project_id_mismatch"],
          },
        },
      });
    }
  });

  it.each([
    ["pair_count_mismatch", (adjacency: AdjacencyAnalysis) => adjacency.pairs.pop()],
    ["candidate_ref_mismatch", (adjacency: AdjacencyAnalysis) => {
      adjacency.pairs[0].right_candidate_ref = "SEG_STALE";
    }],
    ["clip_id_mismatch", (adjacency: AdjacencyAnalysis) => {
      adjacency.pairs[0].right_clip_id = "CLP_STALE";
    }],
  ] as const)("skips stale %s without attributing its risky finding to the current timeline", (reason, mutate) => {
    const inputs = syntheticInputs();
    inputs.adjacency = adjacencyFor(inputs, [
      cutRelation("risky_jump", { majorAxes: ["shot_scale"] }),
      cutRelation("continuous"),
    ]);
    mutate(inputs.adjacency);

    const metrics = computeReviewMetrics(inputs);
    const framing = metrics.checks.find((check) => check.id === "plane_2d.framing_jump");
    expect(framing).toMatchObject({
      status: "skipped",
      measured: {
        violations: [],
        binding: {
          status: "mismatch",
          reason_codes: ["adjacency_timeline_mismatch", reason],
        },
      },
    });
  });

  it("warns for partial relation pair coverage and never evidence-free passes", () => {
    const inputs = syntheticInputs();
    inputs.adjacency = adjacencyFor(inputs, [cutRelation("continuous"), undefined]);

    const metrics = computeReviewMetrics(inputs);
    for (const id of relationMetricIds) {
      expect(metrics.checks.find((check) => check.id === id)).toMatchObject({
        status: "warn",
        measured: { total_pairs: 2, evaluated_pairs: 1, unknown_pairs: 1 },
      });
    }
  });

  it("skips wholly missing relations and warns for unknown or low axis coverage", () => {
    const missing = syntheticInputs();
    missing.adjacency = adjacencyFor(missing, [undefined, undefined]);
    const missingMetrics = computeReviewMetrics(missing);
    expect(relationMetricIds.map((id) =>
      missingMetrics.checks.find((check) => check.id === id)?.status)).toEqual([
      "skipped", "skipped", "skipped", "skipped", "skipped",
    ]);

    const partial = syntheticInputs();
    partial.adjacency = adjacencyFor(partial, [
      cutRelation("unknown", { coverage: { motion_flow: "low_confidence" } }),
      cutRelation("continuous"),
    ]);
    const partialMetrics = computeReviewMetrics(partial);
    expect(partialMetrics.checks.find((check) => check.id === "eye_trace.motion_flow"))
      .toMatchObject({ status: "warn", measured: { unknown_pairs: 1 } });
    expect(partialMetrics.checks.find((check) => check.id === "eye_trace.motion_flow")?.status).not.toBe("pass");
  });

});

const relationMetricIds = [
  "eye_trace.attention_jump",
  "eye_trace.motion_flow",
  "plane_2d.framing_jump",
  "plane_2d.luma_color_jump",
  "space_3d.direction_axis",
] as const satisfies readonly ReviewMetricId[];

const cutRelationAxes: CutRelationAxis[] = [
  "shot_scale",
  "composition",
  "gaze_axis",
  "motion_flow",
  "luma",
  "dominant_color",
  "asset_identity",
  "visual_coherence",
  "visual_tags",
  "subject_type",
  "text_presence",
  "story_boundary",
];

function cutRelation(
  relationship: CutRelationResult["relationship"],
  options: {
    majorAxes?: CutRelationAxis[];
    coverage?: Partial<Record<CutRelationAxis, CutRelationSignal["coverage"]>>;
    intentional?: boolean;
  } = {},
): CutRelationResult {
  const signals = Object.fromEntries(cutRelationAxes.map((axis) => {
    const coverage = options.coverage?.[axis] ?? "known";
    const major = options.majorAxes?.includes(axis) === true;
    return [axis, {
      coverage,
      evaluation: coverage === "known" ? (major ? "contrast" : "match") : "unknown",
      major_discontinuity: major,
      raw: { left: `${axis}:left`, right: `${axis}:right` },
      raw_coverage: { left: "known", right: "known", pair: "known" },
      source_refs: { left: [`left:${axis}`], right: [`right:${axis}`] },
      confidence: { left: 0.9, right: 0.9 },
      reason_codes: [major ? "fixture_major" : coverage === "known" ? "fixture_match" : "fixture_partial"],
    } satisfies CutRelationSignal];
  })) as Record<CutRelationAxis, CutRelationSignal>;
  const comparable = cutRelationAxes.filter((axis) => signals[axis].coverage === "known");
  const low = cutRelationAxes.filter((axis) => signals[axis].coverage === "low_confidence");
  const missing = cutRelationAxes.filter((axis) => signals[axis].coverage === "missing");
  const unknown = cutRelationAxes.filter((axis) => signals[axis].coverage === "unknown");
  const notApplicable = cutRelationAxes.filter((axis) => signals[axis].coverage === "not_applicable");
  return {
    relationship,
    confidence: 0.9,
    coverage: {
      total_axes: cutRelationAxes.length,
      comparable_axes: comparable.length,
      comparable_axis_ids: comparable,
      missing_axis_ids: missing,
      unknown_axis_ids: unknown,
      not_applicable_axis_ids: notApplicable,
      low_confidence_axis_ids: low,
    },
    reason_codes: [relationship === "intentional_contrast"
      ? "explicit_pair_intent_present"
      : relationship === "risky_jump"
        ? "measured_contrast_without_explicit_intent"
        : relationship === "continuous"
          ? "sufficient_continuity_evidence"
          : "mixed_or_ambiguous_evidence"],
    explicit_intent_evidence: options.intentional
      ? [{ source: "beat_craft", source_ref: "04_plan/edit_blueprint.yaml#beats/b01/craft/transition_out", intent: "hard_cut" }]
      : [],
    signals,
  };
}

function adjacencyFor(
  inputs: ReviewMetricsInputs,
  relations: Array<CutRelationResult | undefined>,
  options: { legacy?: boolean; projectId?: string } = {},
): AdjacencyAnalysis {
  const clips = inputs.timeline!.tracks.video[0].clips;
  return {
    version: "2",
    project_id: options.projectId ?? inputs.timeline!.project_id,
    pairs: clips.slice(0, -1).map((left, index) => {
      const right = clips[index + 1];
      return {
        pair_id: `V1:${left.beat_id}->${right.beat_id}`,
        ...(!options.legacy ? { left_clip_id: left.clip_id, right_clip_id: right.clip_id } : {}),
        left_candidate_ref: left.clip_id,
        right_candidate_ref: right.clip_id,
        selected_skill_id: null,
        selected_skill_score: 0,
        min_score_threshold: 0.3,
        transition_type: "cut" as const,
        confidence: 0,
        below_threshold: false,
        evidence: {},
        degraded_from_skill_id: null,
        ...(relations[index] ? { cut_relation: relations[index] } : {}),
      };
    }),
  };
}

function syntheticInputs(): ReviewMetricsInputs {
  return structuredClone({
    timeline: syntheticTimeline(),
    blueprint: syntheticBlueprint(),
    brief: syntheticBrief(),
    selects: syntheticSelects(),
    segments: syntheticSegments(),
    transcripts: syntheticTranscripts(),
  });
}

function syntheticTimeline(): TimelineIR {
  return {
    version: "1",
    project_id: "synthetic-review-metrics",
    created_at: "2026-06-12T00:00:00Z",
    sequence: {
      name: "Synthetic",
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
            clip("CLP_HOOK", "SEG_HOOK", "AST_A", 0, 2_000_000, 0, 48, "hero", "b01"),
            clip("CLP_MID", "SEG_MID", "AST_B", 0, 2_000_000, 48, 48, "support", "b02"),
            clip("CLP_END", "SEG_END", "AST_C", 0, 2_000_000, 96, 48, "transition", "b03"),
          ],
        },
      ],
      audio: [
        {
          track_id: "A1",
          kind: "audio",
          clips: [
            clip("CLP_DIALOGUE", "SEG_SPEECH", "AST_D", 0, 2_000_000, 96, 48, "dialogue", "b03"),
          ],
        },
      ],
    },
    markers: [
      { frame: 0, kind: "beat", label: "b01: hook" },
      { frame: 48, kind: "beat", label: "b02: middle" },
      { frame: 96, kind: "beat", label: "b03: end" },
    ],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

function syntheticBlueprint(): EditBlueprint {
  return {
    version: "1",
    project_id: "synthetic-review-metrics",
    sequence_goals: ["exercise deterministic metrics"],
    beats: [
      {
        id: "b01",
        label: "hook",
        target_duration_frames: 48,
        required_roles: ["hero"],
        story_role: "hook",
      },
      {
        id: "b02",
        label: "middle",
        target_duration_frames: 48,
        required_roles: ["support"],
        story_role: "experience",
      },
      {
        id: "b03",
        label: "ending",
        target_duration_frames: 48,
        required_roles: ["transition", "dialogue"],
        story_role: "closing",
      },
    ],
    pacing: {
      opening_cadence: "brisk",
      middle_cadence: "spacious",
      ending_cadence: "warm",
      max_shot_length_frames: 96,
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b03",
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
    rejection_rules: ["avoid repeated motifs"],
    dedupe_rules: {
      allow_intentional_repetition: false,
    },
    quality_targets: {
      duration_pacing_tolerance_pct: 10,
      hook_density_min: 0.5,
    },
  };
}

function syntheticBrief(): CreativeBrief {
  return {
    version: "1",
    project_id: "synthetic-review-metrics",
    project: {
      id: "synthetic-review-metrics",
      title: "Synthetic",
      strategy: "test",
      runtime_target_sec: 6,
    },
    message: {
      primary: "Test deterministic checks.",
    },
    emotion_curve: ["hook", "middle", "end"],
    order_policy: "editorial",
  };
}

function syntheticSelects(): SelectsCandidates {
  return {
    version: "1",
    project_id: "synthetic-review-metrics",
    candidates: [
      candidate("SEG_HOOK", "AST_A", "hero", ["hook"]),
      candidate("SEG_MID", "AST_B", "support", ["middle"]),
      candidate("SEG_END", "AST_C", "transition", ["ending"]),
      candidate("SEG_SPEECH", "AST_D", "dialogue", ["speech"]),
    ],
  };
}

function syntheticSegments() {
  const segment = (segment_id: string, asset_id: string, src_in_us = 0, src_out_us = 2_000_000) => ({
    segment_id,
    asset_id,
    src_in_us,
    src_out_us,
    summary: segment_id,
    transcript_excerpt: "",
    quality_flags: [],
    tags: [],
  });

  return {
    project_id: "synthetic-review-metrics",
    artifact_version: "analysis-v1",
    items: [
      {
        ...segment("SEG_HOOK", "AST_A"),
        peak_analysis: {
          peak_moments: [
            {
              peak_ref: "PK_HOOK",
              timestamp_us: 1_000_000,
              type: "emotional_peak",
              confidence: 0.9,
              description: "strong hook peak",
              source_pass: "test",
            },
          ],
          support_signals: {
            motion_support_score: 0.9,
            audio_support_score: 0.2,
            fused_peak_score: 0.9,
          },
        },
      },
      segment("SEG_MID", "AST_B"),
      segment("SEG_END", "AST_C"),
      {
        ...segment("SEG_SPEECH", "AST_D"),
        transcript_excerpt: "The complete utterance.",
      },
    ],
  };
}

function syntheticTranscripts() {
  return [
    {
      project_id: "synthetic-review-metrics",
      artifact_version: "analysis-v1",
      transcript_ref: "TR_AST_D",
      asset_id: "AST_D",
      items: [
        {
          speaker: "S1",
          start_us: 100_000,
          end_us: 1_900_000,
          text: "The complete utterance.",
        },
      ],
    },
  ];
}

function clip(
  clip_id: string,
  segment_id: string,
  asset_id: string,
  src_in_us: number,
  src_out_us: number,
  timeline_in_frame: number,
  timeline_duration_frames: number,
  role: "hero" | "support" | "transition" | "dialogue",
  beat_id: string,
) {
  return {
    clip_id,
    segment_id,
    asset_id,
    src_in_us,
    src_out_us,
    timeline_in_frame,
    timeline_duration_frames,
    role,
    motivation: `synthetic ${clip_id}`,
    beat_id,
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    candidate_ref: `legacy:${segment_id}:0:2000000`,
  };
}

function candidate(
  segment_id: string,
  asset_id: string,
  role: "hero" | "support" | "transition" | "dialogue",
  motif_tags: string[],
) {
  return {
    segment_id,
    asset_id,
    src_in_us: 0,
    src_out_us: 2_000_000,
    role,
    why_it_matches: `synthetic ${segment_id}`,
    risks: [],
    confidence: 1,
    motif_tags,
    quality_flags: [],
  };
}
