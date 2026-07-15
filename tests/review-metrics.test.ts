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

const repoRoot = path.resolve(import.meta.dirname, "..");
const demoDir = path.join(repoRoot, "projects/demo");

describe("review metrics", () => {
  it("computes schema-valid metrics from projects/demo artifacts", () => {
    const metrics = computeReviewMetrics(loadReviewMetricsInputs(demoDir));
    const validation = validateAgainstSchema(metrics, "review-metrics.schema.json");

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(metrics.project_id).toBe("sample-mountain-reset");
    expect(metrics.summary.total_checks).toBe(11);
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
      "plane_2d.motif_overuse",
      "audio.speech_cut",
    ]);
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

  it.each([
    "ax1-komatsu-testimonial-d4892",
    "ax1-female-testimonial-d4892",
  ])("classifies the %s human golden without false failures", (projectId) => {
    const metrics = computeReviewMetrics(loadReviewMetricsInputs(path.join(repoRoot, "projects", projectId)));
    const hookDensity = metrics.checks.find((check) => check.id === "emotion.hook_density");
    const adjacency = metrics.checks.find((check) => check.id === "eye_trace.same_asset_adjacency");
    const cadence = metrics.checks.find((check) => check.id === "rhythm.cadence_distribution");
    const validation = validateAgainstSchema(metrics, "review-metrics.schema.json");

    expect(hookDensity?.status).toBe("pass");
    expect(adjacency?.status).toBe("warn");
    expect(cadence?.status).toBe("pass");
    expect(metrics.summary.by_status.fail).toBe(0);
    expect(validation.valid).toBe(true);
  });
});

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
