import { describe, expect, it } from "vitest";
import { assemble } from "../runtime/compiler/assemble.js";
import type {
  DurationPolicy,
  NormalizedData,
  RankedCandidateTable,
  ScoredCandidate,
  ScoringParams,
} from "../runtime/compiler/types.js";

const params: ScoringParams = {
  motif_reuse_max: 3,
  adjacency_penalty: 0.7,
  beat_alignment_tolerance_frames: 12,
  duration_fit_tolerance_frames: 12,
  quality_flag_penalty: 0,
};

const guidePolicy: DurationPolicy = {
  mode: "guide",
  source: "explicit_brief",
  target_source: "explicit_brief",
  target_duration_sec: 40,
  min_duration_sec: 0,
  max_duration_sec: null,
  hard_gate: false,
  protect_vlm_peaks: true,
};

describe("V1-first track layout", () => {
  it("single mode places hero/support/texture sequentially on V1 and leaves V2 empty", () => {
    const normalized = makeNormalized(40);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_texture", "AST_C", "texture", 1.0),
          score("seg_support_same_asset", "AST_A", "support", 0.9),
          score("seg_support_other_asset", "AST_B", "support", 0.3),
          score("seg_hero", "AST_A", "hero", 0.1),
        ],
      ],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only" },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    const v2 = assembled.tracks.video.find((track) => track.track_id === "V2")!;

    expect(v2.clips).toEqual([]);
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual([
      "seg_hero",
      "seg_support_other_asset",
      "seg_support_same_asset",
      "seg_texture",
    ]);
    expect(v1.clips.map((clip) => clip.role)).toEqual([
      "hero",
      "support",
      "support",
      "texture",
    ]);
    expect(v1.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 10, 20, 30]);
    expect(v1.clips.every((clip) => clip.timeline_duration_frames === 10)).toBe(true);
  });

  it("single mode does not overlap clips within a beat", () => {
    const normalized = makeNormalized(30);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_hero", "AST_A", "hero", 0.9),
          score("seg_support", "AST_B", "support", 0.8),
          score("seg_texture", "AST_C", "texture", 0.7),
        ],
      ],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only" },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    for (let i = 1; i < v1.clips.length; i += 1) {
      const prev = v1.clips[i - 1];
      const curr = v1.clips[i];
      expect(curr.timeline_in_frame).toBe(
        prev.timeline_in_frame + prev.timeline_duration_frames,
      );
    }
  });

  it("drops clips that would exceed maxDurationFrames without placing partial clips", () => {
    const normalized = makeNormalized(40);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_hero", "AST_A", "hero", 0.9),
          score("seg_support", "AST_B", "support", 0.8),
          score("seg_texture", "AST_C", "texture", 0.7),
        ],
      ],
    ]);
    const logs: string[] = [];

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only", maxDurationFrames: 25, log: (message) => logs.push(message) },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual(["seg_hero", "seg_support"]);
    expect(v1.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 10]);
    expect(v1.clips.every((clip) => clip.timeline_duration_frames === 10)).toBe(true);
    expect(Math.max(...v1.clips.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames))).toBeLessThanOrEqual(25);
    expect(logs).toEqual(["Duration cap dropped 1 clip(s) beyond 25 frames"]);
  });

  it("multi mode preserves hero on V1 and support/texture on V2", () => {
    const normalized = makeNormalized(30);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_texture", "AST_C", "texture", 0.95),
          score("seg_support", "AST_B", "support", 0.9),
          score("seg_hero", "AST_A", "hero", 0.1),
        ],
      ],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { trackLayout: "multi", audioPolicy: "bgm_only" },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    const v2 = assembled.tracks.video.find((track) => track.track_id === "V2")!;

    expect(v1.clips.map((clip) => clip.segment_id)).toEqual(["seg_hero"]);
    expect(v2.clips.map((clip) => clip.segment_id)).toEqual(["seg_texture", "seg_support"]);
    expect(v2.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 10]);
  });

  it("groups same semantic clusters together within a beat", () => {
    const normalized = makeNormalized(50);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_fishing_1", "AST_F1", "support", 1.0, "b01", "fishing"),
          score("seg_campfire", "AST_C1", "support", 0.9, "b01", "campfire"),
          score("seg_park", "AST_P1", "support", 0.8, "b01", "park"),
          score("seg_fishing_2", "AST_F2", "support", 0.7, "b01", "fishing"),
          score("seg_fishing_3", "AST_F3", "support", 0.6, "b01", "fishing"),
        ],
      ],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only" },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual([
      "seg_fishing_1",
      "seg_fishing_2",
      "seg_fishing_3",
      "seg_campfire",
      "seg_park",
    ]);
    expect(v1.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 10, 20, 30, 40]);
  });

  it("keeps score order when clips have no cluster and unique asset prefixes", () => {
    const normalized = makeNormalized(30);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_one", "ONE", "support", 1.0),
          score("seg_two", "TWO", "support", 0.9),
          score("seg_three", "THREE", "support", 0.8),
        ],
      ],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only" },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual([
      "seg_one",
      "seg_two",
      "seg_three",
    ]);
  });

  it("can skip cluster grouping for montage ordering", () => {
    const normalized = makeNormalized(40);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_fishing_1", "AST_F1", "support", 1.0, "b01", "fishing"),
          score("seg_campfire_1", "AST_C1", "support", 0.9, "b01", "campfire"),
          score("seg_fishing_2", "AST_F2", "support", 0.8, "b01", "fishing"),
          score("seg_campfire_2", "AST_C2", "support", 0.7, "b01", "campfire"),
        ],
      ],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only", clusterContinuity: false },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual([
      "seg_fishing_1",
      "seg_campfire_1",
      "seg_fishing_2",
      "seg_campfire_2",
    ]);
  });

  it("moves a matching next-beat cluster to the boundary for continuity", () => {
    const normalized = makeNormalizedWithBeats([
      { beat_id: "b01", target_duration_frames: 30 },
      { beat_id: "b02", target_duration_frames: 30 },
    ]);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_a1", "AST_A1", "support", 1.0, "b01", "A"),
          score("seg_a2", "AST_A2", "support", 0.9, "b01", "A"),
          score("seg_a3", "AST_A3", "support", 0.8, "b01", "A"),
        ],
      ],
      [
        "b02",
        [
          score("seg_b1", "AST_B1", "support", 1.0, "b02", "B"),
          score("seg_c1", "AST_C1", "support", 0.9, "b02", "C"),
          score("seg_a4", "AST_A4", "support", 0.8, "b02", "A"),
        ],
      ],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only", beatOrder: ["b01", "b02"] },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual([
      "seg_a1",
      "seg_a2",
      "seg_a3",
      "seg_a4",
      "seg_b1",
      "seg_c1",
    ]);
    expect(v1.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 10, 20, 30, 40, 50]);
  });
});

function makeNormalized(targetDurationFrames: number): NormalizedData {
  return makeNormalizedWithBeats([
    { beat_id: "b01", target_duration_frames: targetDurationFrames },
  ]);
}

function makeNormalizedWithBeats(
  beats: Array<{ beat_id: string; target_duration_frames: number }>,
): NormalizedData {
  return {
    project_id: "v1-first",
    project_title: "V1 First",
    total_duration_frames: beats.reduce((sum, beat) => sum + beat.target_duration_frames, 0),
    role_quotas: { hero: 0, support: beats.length, transition: 0, texture: 0, dialogue: 0 },
    beats: beats.map((beat, index) => ({
      beat_id: beat.beat_id,
      label: `Beat ${index + 1}`,
      target_duration_frames: beat.target_duration_frames,
      required_roles: ["hero"],
      preferred_roles: ["support", "texture"],
      purpose: "test",
    })),
  };
}

function score(
  segmentId: string,
  assetId: string,
  role: "hero" | "support" | "texture",
  candidateScore: number,
  beatId = "b01",
  semanticClusterId?: string,
): ScoredCandidate {
  return {
    beat_id: beatId,
    score: candidateScore,
    candidate: {
      segment_id: segmentId,
      asset_id: assetId,
      src_in_us: 0,
      src_out_us: 10_000_000,
      role,
      why_it_matches: segmentId,
      risks: [],
      confidence: 0.9,
      semantic_rank: 1,
      editorial_signals: semanticClusterId
        ? { semantic_cluster_id: semanticClusterId }
        : undefined,
    },
    breakdown: {
      semantic_rank_score: candidateScore,
      quality_penalty: 0,
      duration_fit_score: 1,
      motif_reuse_penalty: 0,
      adjacency_penalty: 0,
    },
  };
}
