import { describe, expect, it } from "vitest";
import { assemble } from "../runtime/compiler/assemble.js";
import { compactGuideSingleTrackGaps } from "../runtime/compiler/index.js";
import { compactTrimmedClipsWithinBeats } from "../runtime/compiler/trim.js";
import type {
  Candidate,
  DurationPolicy,
  NormalizedData,
  RankedCandidateTable,
  ScoredCandidate,
  ScoringParams,
  TimelineClip,
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
  it("routes pure audio dialogue, selected music, and texture without creating V1 clips", () => {
    const normalized = makeNormalized(30);
    const table: RankedCandidateTable = new Map([["b01", [
      score("speech", "AST_S", "dialogue", 1, "b01", undefined, audio("dialogue")),
      score("music", "AST_M", "support", 0.9, "b01", undefined, audio("music")),
      score("room", "AST_R", "texture", 0.8, "b01", undefined, audio("ambient")),
    ]]]);
    const assembled = assemble(normalized, table, params, 1, 1, guidePolicy, { audioPolicy: "bgm_only" });

    expect(assembled.tracks.video.flatMap((track) => track.clips)).toEqual([]);
    expect(assembled.tracks.audio.find((track) => track.track_id === "A1")?.clips.map((clip) => clip.segment_id)).toEqual(["speech"]);
    expect(assembled.tracks.audio.find((track) => track.track_id === "A2")?.clips.map((clip) => clip.segment_id)).toEqual(["music"]);
    expect(assembled.tracks.audio.find((track) => track.track_id === "A3")?.clips.map((clip) => clip.segment_id)).toEqual(["room"]);
  });

  it("compacts post-trim V1 gaps within each beat without crossing beat boundaries", () => {
    const beats = makeNormalizedWithBeats([
      { beat_id: "b01", target_duration_frames: 100 },
      { beat_id: "b02", target_duration_frames: 50 },
    ]).beats;
    const clips = [
      clip("C1", "b01", 0, 30),
      clip("C2", "b01", 50, 20),
      clip("C3", "b01", 90, 5),
      clip("C4", "b02", 100, 10),
    ];

    compactTrimmedClipsWithinBeats(clips, beats, [
      { frame: 0, kind: "beat", label: "b01: Hook" },
      { frame: 100, kind: "beat", label: "b02: Close" },
    ]);

    expect(clips.map((item) => item.timeline_in_frame)).toEqual([0, 30, 50, 100]);
  });

  it("compacts final guide single-track gaps across beat boundaries and syncs mirrors", () => {
    const beats = makeNormalizedWithBeats([
      { beat_id: "b01", target_duration_frames: 100 },
      { beat_id: "b02", target_duration_frames: 80 },
      { beat_id: "b03", target_duration_frames: 60 },
    ]).beats;
    const v1Clips = [
      { ...clip("C1", "b01", 0, 30), candidate_ref: "ref_1" },
      { ...clip("C2", "b02", 100, 20), candidate_ref: "ref_2" },
      { ...clip("C3", "b03", 180, 10), candidate_ref: "ref_3" },
    ];
    const a1Clips = v1Clips.map((videoClip, index) => ({
      ...videoClip,
      clip_id: `A${index + 1}`,
      role: "nat_sound" as const,
      motivation: "original clip audio",
    }));
    const assembled = {
      tracks: {
        video: [
          { track_id: "V1", kind: "video" as const, clips: v1Clips },
          { track_id: "V2", kind: "video" as const, clips: [] },
        ],
        audio: [
          { track_id: "A1", kind: "audio" as const, clips: a1Clips },
          { track_id: "A2", kind: "audio" as const, clips: [] },
        ],
      },
      markers: [
        { frame: 0, kind: "beat" as const, label: "b01: Hook" },
        { frame: 100, kind: "beat" as const, label: "b02: Body" },
        { frame: 180, kind: "beat" as const, label: "b03: Close" },
      ],
    };

    compactGuideSingleTrackGaps(assembled, beats);

    expect(v1Clips.map((item) => item.timeline_in_frame)).toEqual([0, 30, 50]);
    expect(a1Clips.map((item) => item.timeline_in_frame)).toEqual([0, 30, 50]);
    expect(assembled.markers.map((item) => item.frame)).toEqual([0, 30, 50]);
  });

  it("retimes multiple authored mixed-audio placements to compacted beat markers in order", () => {
    const beats = makeNormalizedWithBeats([
      { beat_id: "b01", target_duration_frames: 100 },
      { beat_id: "b02", target_duration_frames: 100 },
    ]).beats;
    const visual = [clip("V1_A", "b01", 0, 20), clip("V1_B", "b02", 100, 20)];
    const authored = [
      { ...clip("A3_1", "b02", 105, 5), media_kind: "audio" as const, source_capabilities: { has_video: false, has_audio: true }, audio_role: "ambient" as const, motivation: "authored audio selection" },
      { ...clip("A3_2", "b02", 115, 6), media_kind: "audio" as const, source_capabilities: { has_video: false, has_audio: true }, audio_role: "ambient" as const, motivation: "authored audio selection" },
    ];
    const assembled = {
      tracks: {
        video: [{ track_id: "V1", kind: "video" as const, clips: visual }],
        audio: [{ track_id: "A3", kind: "audio" as const, clips: authored }],
      },
      markers: [
        { frame: 0, kind: "beat" as const, label: "b01: Hook" },
        { frame: 100, kind: "beat" as const, label: "b02: Close" },
      ],
    };
    compactGuideSingleTrackGaps(assembled, beats);
    expect(visual.map((item) => item.timeline_in_frame)).toEqual([0, 20]);
    expect(authored.map((item) => item.timeline_in_frame)).toEqual([20, 25]);
  });

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

  it("honors exact candidate_plan order and permits explicit cross-beat reprises", () => {
    const normalized = makeNormalizedWithBeats([
      { beat_id: "b01", target_duration_frames: 20 },
      { beat_id: "b02", target_duration_frames: 30 },
    ]);
    normalized.beats[0].candidate_plan = {
      primary_candidate_ref: "seg_b",
      fallback_candidate_refs: ["seg_a"],
    };
    normalized.beats[1].candidate_plan = {
      primary_candidate_ref: "seg_a",
      fallback_candidate_refs: ["seg_b", "seg_c"],
    };
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_a", "AST_A", "support", 1.0, "b01", "cluster_a"),
          score("seg_b", "AST_B", "hero", 0.1, "b01", "cluster_b"),
        ],
      ],
      [
        "b02",
        [
          score("seg_c", "AST_C", "texture", 1.0, "b02", "cluster_c"),
          score("seg_b", "AST_B", "hero", 0.9, "b02", "cluster_b"),
          score("seg_a", "AST_A", "support", 0.1, "b02", "cluster_a"),
          score("seg_unplanned", "AST_X", "support", 9.0, "b02", "cluster_x"),
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
      { audioPolicy: "ducking", exactCandidatePlanOrder: true },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    const a1 = assembled.tracks.audio.find((track) => track.track_id === "A1")!;
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual([
      "seg_b",
      "seg_a",
      "seg_a",
      "seg_b",
      "seg_c",
    ]);
    expect(v1.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 10, 20, 30, 40]);
    expect(v1.clips.some((clip) => clip.segment_id === "seg_unplanned")).toBe(false);
    expect(a1.clips).toHaveLength(v1.clips.length);
    expect(a1.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 10, 20, 30, 40]);
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

  it("single mode uses dialogue as V1 program video when no visual role candidate exists", () => {
    const normalized = makeNormalized(30);
    const table: RankedCandidateTable = new Map([
      ["b01", [score("seg_dialogue", "AST_TALK", "dialogue", 0.9)]],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "ducking" },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    const a1 = assembled.tracks.audio.find((track) => track.track_id === "A1")!;

    expect(v1.clips.map((clip) => clip.segment_id)).toEqual(["seg_dialogue"]);
    expect(v1.clips[0]).toMatchObject({
      role: "dialogue",
      timeline_in_frame: 0,
      timeline_duration_frames: 10,
      src_in_us: 0,
      src_out_us: 10_000_000,
    });
    expect(a1.clips).toHaveLength(1);
    expect(a1.clips[0]).toMatchObject({
      role: "nat_sound",
      motivation: "original clip audio",
      timeline_in_frame: v1.clips[0].timeline_in_frame,
      timeline_duration_frames: v1.clips[0].timeline_duration_frames,
      src_in_us: v1.clips[0].src_in_us,
      src_out_us: v1.clips[0].src_out_us,
    });
  });

  it("single mode mirrors selected dialogue audio instead of placing unselected dialogue on A1", () => {
    const normalized = makeNormalized(10);
    const selected = score("seg_selected_dialogue", "AST_TALK", "dialogue", 1.0);
    selected.candidate.src_in_us = 18_000_000;
    selected.candidate.src_out_us = 28_000_000;
    const rejected = score("seg_rejected_dialogue", "AST_TALK", "dialogue", 0.8);
    rejected.candidate.src_in_us = 0;
    rejected.candidate.src_out_us = 10_000_000;
    const table: RankedCandidateTable = new Map([
      ["b01", [selected, rejected]],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "ducking" },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    const a1 = assembled.tracks.audio.find((track) => track.track_id === "A1")!;

    expect(v1.clips.map((clip) => clip.segment_id)).toEqual(["seg_selected_dialogue"]);
    expect(a1.clips).toHaveLength(1);
    expect(a1.clips[0]).toMatchObject({
      segment_id: "seg_selected_dialogue",
      role: "nat_sound",
      motivation: "original clip audio",
      timeline_in_frame: v1.clips[0].timeline_in_frame,
      timeline_duration_frames: v1.clips[0].timeline_duration_frames,
      src_in_us: 18_000_000,
      src_out_us: 28_000_000,
    });
    expect(a1.clips.some((clip) => clip.segment_id === "seg_rejected_dialogue")).toBe(false);
  });

  it("uses a competitive support candidate as V1 bridge when dialogue would repeat the previous asset", () => {
    const normalized = makeNormalizedWithBeats([
      { beat_id: "b01", target_duration_frames: 10 },
      { beat_id: "b02", target_duration_frames: 20 },
    ]);
    const table: RankedCandidateTable = new Map([
      ["b01", [score("seg_hook_dialogue", "AST_A", "dialogue", 0.9, "b01")]],
      [
        "b02",
        [
          score("seg_value_dialogue", "AST_A", "dialogue", 1.0, "b02"),
          score("seg_value_support", "AST_B", "support", 0.4, "b02"),
        ],
      ],
    ]);
    table.get("b02")![1].candidate.evidence = ["visual_variety"];

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "ducking" },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual([
      "seg_hook_dialogue",
      "seg_value_support",
      "seg_value_dialogue",
    ]);
    expect(v1.clips.map((clip) => clip.asset_id)).toEqual(["AST_A", "AST_B", "AST_A"]);
    expect(v1.clips.slice(1).every((clip, index) =>
      clip.asset_id !== v1.clips[index].asset_id
    )).toBe(true);
  });

  it("scales a single over-cap beat before placing clips", () => {
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
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual(["seg_hero", "seg_support", "seg_texture"]);
    expect(v1.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 10, 20]);
    expect(v1.clips.map((clip) => clip.timeline_duration_frames)).toEqual([10, 10, 5]);
    expect(Math.max(...v1.clips.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames))).toBeLessThanOrEqual(25);
    expect(logs).toEqual([]);
  });

  it("proportionally distributes maxDurationFrames across beats before placement", () => {
    const normalized = makeNormalizedWithBeats([
      { beat_id: "b01", target_duration_frames: 100 },
      { beat_id: "b02", target_duration_frames: 100 },
      { beat_id: "b03", target_duration_frames: 100 },
    ]);
    const table: RankedCandidateTable = new Map([
      ["b01", [score("seg_b01", "AST_A", "support", 0.9, "b01")]],
      ["b02", [score("seg_b02", "AST_B", "support", 0.9, "b02")]],
      ["b03", [score("seg_b03", "AST_C", "support", 0.9, "b03")]],
    ]);
    const logs: string[] = [];

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only", maxDurationFrames: 180, log: (message) => logs.push(message) },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    expect(v1.clips.map((clip) => clip.beat_id)).toEqual(["b01", "b02", "b03"]);
    expect(v1.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 60, 120]);
    expect(Math.max(...v1.clips.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames))).toBeLessThanOrEqual(180);
    expect(logs).toEqual([]);
  });

  it("reserves capped candidates so early beats cannot consume later beats entirely", () => {
    const normalized = makeNormalizedWithBeats([
      { beat_id: "b01", target_duration_frames: 100 },
      { beat_id: "b02", target_duration_frames: 100 },
      { beat_id: "b03", target_duration_frames: 100 },
    ]);
    const table: RankedCandidateTable = new Map([
      [
        "b01",
        [
          score("seg_b03", "AST_C", "support", 1.0, "b01"),
          score("seg_b02", "AST_B", "support", 0.9, "b01"),
          score("seg_b01", "AST_A", "support", 0.8, "b01"),
        ],
      ],
      [
        "b02",
        [
          score("seg_b03", "AST_C", "support", 1.0, "b02"),
          score("seg_b02", "AST_B", "support", 0.9, "b02"),
        ],
      ],
      ["b03", [score("seg_b03", "AST_C", "support", 1.0, "b03")]],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only", maxDurationFrames: 90 },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    expect(v1.clips.map((clip) => clip.beat_id)).toEqual(["b01", "b02", "b03"]);
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual(["seg_b01", "seg_b02", "seg_b03"]);
  });

  it("does not reserve shared candidates when maxDurationFrames exceeds total beat frames", () => {
    const normalized = makeNormalizedWithBeats([
      { beat_id: "b01", target_duration_frames: 10 },
      { beat_id: "b02", target_duration_frames: 10 },
    ]);
    const table: RankedCandidateTable = new Map([
      ["b01", [score("seg_shared", "AST_A", "support", 1.0, "b01")]],
      [
        "b02",
        [
          score("seg_shared", "AST_A", "support", 1.0, "b02"),
          score("seg_b02", "AST_B", "support", 0.8, "b02"),
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
      { audioPolicy: "bgm_only", maxDurationFrames: 100 },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    expect(v1.clips.map((clip) => clip.beat_id)).toEqual(["b01", "b02"]);
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual(["seg_shared", "seg_b02"]);
  });

  it("single guide fill places unused candidates on V1 within remaining beat budget", () => {
    const normalized = makeNormalized(25);
    const table: RankedCandidateTable = new Map([
      ["b01", [score("seg_primary", "AST_A", "support", 0.9, "b01")]],
      ["unused_pool", [score("seg_unused", "AST_B", "texture", 0.8, "unused_pool")]],
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
    expect(v1.clips.map((clip) => clip.segment_id)).toEqual(["seg_primary", "seg_unused"]);
    expect(v1.clips.map((clip) => clip.timeline_in_frame)).toEqual([0, 10]);
    expect(v1.clips.map((clip) => clip.timeline_duration_frames)).toEqual([10, 10]);
    expect(Math.max(...v1.clips.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames))).toBeLessThanOrEqual(25);
  });

  it("keeps a final beat clip when breath rhythm would otherwise exceed the duration cap", () => {
    const normalized = makeNormalizedWithBeats([
      { beat_id: "b01", target_duration_frames: 100 },
      { beat_id: "b02_closing", target_duration_frames: 100 },
    ]);
    normalized.beats[1].craft = { rhythm: "breath" };
    const table: RankedCandidateTable = new Map([
      ["b01", [score("seg_b01", "AST_A", "support", 0.9, "b01")]],
      ["b02_closing", [score("seg_b02", "AST_B", "support", 0.9, "b02_closing")]],
    ]);

    const assembled = assemble(
      normalized,
      table,
      params,
      1,
      1,
      guidePolicy,
      { audioPolicy: "bgm_only", maxDurationFrames: 20 },
    );

    const v1 = assembled.tracks.video.find((track) => track.track_id === "V1")!;
    expect(v1.clips.map((clip) => clip.beat_id)).toEqual(["b01", "b02_closing"]);
    expect(Math.max(...v1.clips.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames))).toBe(20);
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
  role: "hero" | "support" | "texture" | "dialogue",
  candidateScore: number,
  beatId = "b01",
  semanticClusterId?: string,
  overrides: Partial<Candidate> = {},
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
      ...overrides,
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

function audio(audioRole: Candidate["audio_role"]): Partial<Candidate> {
  return {
    media_kind: "audio",
    source_capabilities: { has_video: false, has_audio: true },
    audio_role: audioRole,
  };
}

function clip(
  clipId: string,
  beatId: string,
  timelineInFrame: number,
  durationFrames: number,
): TimelineClip {
  return {
    clip_id: clipId,
    segment_id: clipId,
    asset_id: `AST_${clipId}`,
    src_in_us: 0,
    src_out_us: durationFrames * 1_000_000,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: durationFrames,
    role: "support",
    motivation: "test",
    beat_id: beatId,
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  };
}
