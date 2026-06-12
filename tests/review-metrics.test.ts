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
    expect(metrics.summary.total_checks).toBe(10);
    expect(metrics.checks.map((item) => item.id)).toEqual([
      "rhythm.beat_duration_deviation",
      "rhythm.max_shot_length",
      "rhythm.cadence_distribution",
      "story.required_roles",
      "story.chronology",
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
