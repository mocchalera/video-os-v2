import { describe, expect, it } from "vitest";
import { assemble } from "../runtime/compiler/assemble.js";
import type {
  NormalizedData,
  RankedCandidateTable,
  ScoredCandidate,
  ScoringParams,
} from "../runtime/compiler/types.js";

const params: ScoringParams = {
  motif_reuse_max: 3,
  adjacency_penalty: 0,
  beat_alignment_tolerance_frames: 24,
  duration_fit_tolerance_frames: 12,
  quality_flag_penalty: 0,
};

describe("chronological peak regression", () => {
  it("keeps final V1 chronology after peak-boosted hero selection", () => {
    const normalized: NormalizedData = {
      project_id: "family",
      project_title: "Family",
      total_duration_frames: 300,
      role_quotas: { hero: 2, support: 1, transition: 0, texture: 0, dialogue: 0 },
      beats: [
        { beat_id: "b2019", label: "2019", target_duration_frames: 100, required_roles: ["support"], preferred_roles: [], purpose: "start" },
        { beat_id: "b2022", label: "2022", target_duration_frames: 100, required_roles: ["hero"], preferred_roles: [], purpose: "middle" },
        { beat_id: "b2026", label: "2026", target_duration_frames: 100, required_roles: ["hero"], preferred_roles: [], purpose: "end" },
      ],
    };
    const table: RankedCandidateTable = new Map([
      ["b2019", [score("seg_2019", "AST_2019", "support", 0, 100)]],
      ["b2022", [score("seg_2022_peak", "AST_2022", "hero", 0.95, 100)]],
      ["b2026", [score("seg_2026_peak", "AST_2026", "hero", 0.9, 100)]],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      30,
      1,
      undefined,
      {
        timelineOrder: "chronological",
        beatOrder: normalized.beats.map((beat) => beat.beat_id),
        audioPolicy: "ducking",
      },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    const v2 = assembled.tracks.video.find((track) => track.track_id === "V2")!;
    expect(v2.clips).toHaveLength(0);
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual([
      "seg_2019",
      "seg_2022_peak",
      "seg_2026_peak",
    ]);
    expect(v1.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 100, 200]);
  });
});

function score(
  segmentId: string,
  assetId: string,
  role: "hero" | "support",
  peakStrength: number,
  durationFrames: number,
): ScoredCandidate {
  return {
    beat_id: "",
    score: 1 + peakStrength,
    candidate: {
      segment_id: segmentId,
      asset_id: assetId,
      src_in_us: 0,
      src_out_us: durationFrames * 33_333,
      role,
      why_it_matches: segmentId,
      risks: [],
      confidence: 0.9,
      semantic_rank: 1,
      peak_signals: peakStrength > 0 ? { motion: peakStrength } : undefined,
    },
    breakdown: {
      semantic_rank_score: 1,
      quality_penalty: 0,
      duration_fit_score: 1,
      motif_reuse_penalty: 0,
      adjacency_penalty: 0,
      peak_priority_bonus: peakStrength,
    },
  };
}
