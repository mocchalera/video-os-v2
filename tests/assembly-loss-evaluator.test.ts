// Issue #11 Phase 2 M2A — assembly-loss evaluator targeted tests.
//
// Contract under test: pure deterministic diagnostic core. No filesystem,
// no mutation of inputs, no ranking/composite score, ambient observation-only,
// coverage failed => HOLD, optional evidence absent => fail-open unknown.
//
// Sol review f5abeb98 counterexamples covered here:
//  - M1: retention judged against the per-asset union of placed source ranges
//    (contiguous split covers a full utterance; same-source reuse shows only
//    as interior gap); speech timeline from clamped intersections of ALL
//    utterances x ALL placements.
//  - M2: kickoff identified only via creator_short_vo_broll provenance or an
//    explicit kickoff beat — never a hook/first-beat substitute; straddling
//    clips count only their pre-kickoff portion.
//  - M3: setup/payoff assembled presence requires matching timeline clips.
//  - M4: program end = max clip end; ambient aggregated as a timeline
//    interval union (overlapping duplicates not double-counted).
//  - M5: human structural diff at unmatched-occurrence duration granularity.
//  - M7: local validation rejects NaN/Infinity/negative before hashing;
//    human-reference bag order is canonicalized before hashing.

import { describe, expect, it } from "vitest";
import {
  ASSEMBLY_LOSS_EVALUATOR_VERSION,
  DEFAULT_ASR_TOLERANCE_US,
  evaluateAssemblyLoss,
} from "../runtime/eval/assembly-loss.js";
import type { AssemblyLossInput } from "../runtime/eval/assembly-loss.js";
import type {
  Beat,
  Candidate,
  ClipOutput,
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
  TrackOutput,
} from "../runtime/artifacts/types.js";

const FPS = 30;

function makeBrief(): CreativeBrief {
  return {
    version: "1",
    project_id: "p1",
    project: { id: "p1", title: "t", strategy: "s" },
    message: { primary: "m" },
    emotion_curve: [],
  };
}

function makeSelects(candidates: Candidate[]): SelectsCandidates {
  return {
    version: "1",
    project_id: "p1",
    candidates,
    coverage: {
      version: "1",
      policy: "test",
      status: "met",
      config: {} as never,
      clusters: [],
      must_have: [],
      unmet: [],
    },
  };
}

function makeBlueprint(beats: Beat[], prioritizeLines?: string[]): EditBlueprint {
  return {
    version: "1",
    project_id: "p1",
    sequence_goals: [],
    beats,
    pacing: { opening_cadence: "a", middle_cadence: "b", ending_cadence: "c" },
    music_policy: { start_sparse: true, allow_release_late: false, entry_beat: "x" },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
      ...(prioritizeLines ? { prioritize_lines: prioritizeLines } : {}),
    },
  };
}

function makeClip(partial: Partial<ClipOutput> & Pick<ClipOutput, "clip_id" | "segment_id" | "asset_id">): ClipOutput {
  const timelineIn = partial.timeline_in_frame ?? 0;
  const durationFrames = partial.timeline_duration_frames ?? FPS;
  return {
    src_in_us: 0,
    src_out_us: (durationFrames / FPS) * 1_000_000,
    timeline_in_frame: timelineIn,
    timeline_duration_frames: durationFrames,
    role: "hero",
    motivation: "",
    beat_id: "b1",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    ...partial,
  };
}

function makeTimeline(videoClips: ClipOutput[], audioClips: ClipOutput[] = []): TimelineIR {
  const videoTrack: TrackOutput = { track_id: "V1", kind: "video", clips: videoClips };
  const audioTrack: TrackOutput = { track_id: "A3", kind: "audio", role: "ambient", clips: audioClips };
  return {
    version: "1",
    project_id: "p1",
    created_at: "2026-01-01T00:00:00Z",
    sequence: { name: "seq", fps_num: 30, fps_den: 1, width: 1080, height: 1920, start_frame: 0 },
    tracks: { video: [videoTrack], audio: [audioTrack] },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

function makeInput(overrides: Partial<AssemblyLossInput> = {}): AssemblyLossInput {
  return {
    brief: makeBrief(),
    selects: makeSelects([]),
    blueprint: makeBlueprint([{ id: "b1", label: "main", target_duration_frames: FPS, required_roles: ["hero"] }]),
    timeline: makeTimeline([]),
    ...overrides,
  };
}

// One-second source utterance on asset "A" at 0..1s, selected as hero.
const UTTERANCE = { start_us: 0, end_us: 1_000_000, text: "hello world", speaker: "s0" };

function baseSetup(): {
  input: AssemblyLossInput;
} {
  const candidate: Candidate = {
    segment_id: "seg1",
    asset_id: "A",
    src_in_us: 0,
    src_out_us: 2_000_000,
    role: "hero",
    why_it_matches: "",
    risks: [],
    confidence: 1,
  };
  const beat: Beat = {
    id: "b1",
    label: "main",
    target_duration_frames: 2 * FPS,
    required_roles: ["hero"],
    story_role: "experience",
  };
  const clip = makeClip({ clip_id: "c1", segment_id: "seg1", asset_id: "A", beat_id: "b1" });
  return {
    input: makeInput({
      selects: makeSelects([candidate]),
      blueprint: makeBlueprint([beat]),
      timeline: makeTimeline([clip]),
      transcripts: [{ transcript_id: "TR_A", asset_id: "A", utterances: [UTTERANCE] }],
    }),
  };
}

describe("assembly-loss evaluator", () => {
  it("classifies full/head/tail utterance cuts against the timeline clip", () => {
    // Clip retains 0.4s..0.9s of the 0..1s utterance: head loss 0.4s (> tolerance),
    // tail loss 0.1s (< tolerance => noise, not truncation).
    const clip = makeClip({
      clip_id: "c1",
      segment_id: "seg1",
      asset_id: "A",
      src_in_us: 400_000,
      src_out_us: 900_000,
    });
    const { input } = baseSetup();
    input.timeline = makeTimeline([clip]);
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.important_utterance_retention).toMatchObject({
      available: true,
      important_count: 1,
      head_cut: 1,
    });
    expect(report.measurements.head_tail_truncation).toMatchObject({
      available: true,
      truncated_head_count: 1,
      truncated_tail_count: 0,
      total_head_loss_us: 400_000,
      total_tail_loss_us: 0,
    });

    // Tail cut: clip retains 0..0.7s.
    const tailCutClip = makeClip({
      clip_id: "c2",
      segment_id: "seg1",
      asset_id: "A",
      src_out_us: 700_000,
    });
    input.timeline = makeTimeline([tailCutClip]);
    const tailReport = evaluateAssemblyLoss(input);
    expect(tailReport.measurements.important_utterance_retention).toMatchObject({
      tail_cut: 1,
      head_cut: 0,
      full: 0,
    });
    expect(tailReport.measurements.head_tail_truncation.total_tail_loss_us).toBe(300_000);

    // Full: clip covers the entire utterance.
    input.timeline = makeTimeline([makeClip({ clip_id: "c3", segment_id: "seg1", asset_id: "A" })]);
    const fullReport = evaluateAssemblyLoss(input);
    expect(fullReport.measurements.important_utterance_retention).toMatchObject({ full: 1 });
  });

  it("judges retention against the per-asset union of placed source ranges", () => {
    const { input } = baseSetup();
    // A 0..2s utterance split across two contiguous clips 0..1s and 1..2s:
    // the union covers the whole utterance => full retention, no truncation.
    const candidate: Candidate = {
      segment_id: "seg1",
      asset_id: "A",
      src_in_us: 0,
      src_out_us: 2_000_000,
      role: "hero",
      why_it_matches: "",
      risks: [],
      confidence: 1,
    };
    input.selects = makeSelects([candidate]);
    input.transcripts = [
      { transcript_id: "TR_A", asset_id: "A", utterances: [{ start_us: 0, end_us: 2_000_000, text: "long line" }] },
    ];
    input.timeline = makeTimeline([
      makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0 }),
      makeClip({
        clip_id: "c2",
        segment_id: "s2",
        asset_id: "A",
        src_in_us: 1_000_000,
        src_out_us: 2_000_000,
        timeline_in_frame: FPS,
      }),
    ]);
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.important_utterance_retention).toMatchObject({
      full: 1,
      head_cut: 0,
      tail_cut: 0,
      missing: 0,
    });
    expect(report.measurements.head_tail_truncation).toMatchObject({
      total_head_loss_us: 0,
      total_tail_loss_us: 0,
    });
  });

  it("reports same-source reuse as retained edges with an interior gap", () => {
    const { input } = baseSetup();
    // Same asset reused non-adjacently: union [0,0.5] ∪ [1.5,2]. The 0..2s
    // utterance keeps both edges (no head/tail cut) but loses the middle 1s,
    // which must surface as interior gap — not silently as "full".
    const candidate: Candidate = {
      segment_id: "seg1",
      asset_id: "A",
      src_in_us: 0,
      src_out_us: 2_000_000,
      role: "hero",
      why_it_matches: "",
      risks: [],
      confidence: 1,
    };
    input.selects = makeSelects([candidate]);
    input.transcripts = [
      { transcript_id: "TR_A", asset_id: "A", utterances: [{ start_us: 0, end_us: 2_000_000, text: "long line" }] },
    ];
    input.timeline = makeTimeline([
      makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A", src_in_us: 0, src_out_us: 500_000, timeline_in_frame: 0 }),
      makeClip({
        clip_id: "c2",
        segment_id: "s2",
        asset_id: "A",
        src_in_us: 1_500_000,
        src_out_us: 2_000_000,
        timeline_in_frame: 15,
      }),
    ]);
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.important_utterance_retention).toMatchObject({
      full: 1,
      head_cut: 0,
      tail_cut: 0,
      total_interior_gap_us: 1_000_000,
    });
  });

  it("computes the speech timeline from clamped intersections of all utterances and placements", () => {
    const { input } = baseSetup();
    // Asset B is NOT selected by any candidate: its utterance is unimportant
    // for retention but still counts as speech for the no-speech measurement.
    input.timeline = makeTimeline([
      makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A", timeline_in_frame: 0 }),
      makeClip({
        clip_id: "c2",
        segment_id: "s2",
        asset_id: "B",
        timeline_in_frame: FPS,
        src_in_us: 0,
        src_out_us: 2_000_000,
      }),
    ]);
    input.transcripts = [
      { transcript_id: "TR_A", asset_id: "A", utterances: [UTTERANCE] },
      {
        transcript_id: "TR_B",
        asset_id: "B",
        // 1.5s utterance overlapping clip B's 2s source range. Clip B plays
        // its 2s source over 1s of timeline (scale 0.5), so the clamped
        // intersection maps to timeline 1.25s..2s.
        utterances: [{ start_us: 500_000, end_us: 2_000_000, text: "ambient talk" }],
      },
    ];
    const report = evaluateAssemblyLoss(input);
    const silent = report.measurements.silent_environmental_audio;
    expect(silent.available).toBe(true);
    // Spine 0..2s; speech 0..1s (A) + 1.25..2s (B clamped via B's scale)
    // => 0.25s without speech.
    expect(silent.no_speech_duration_sec).toBeCloseTo(0.25, 5);
    // Retention still only counts the important (selected) utterance.
    expect(report.measurements.important_utterance_retention.important_count).toBe(1);
  });

  it("counts speech when a clip starts in the middle of an utterance", () => {
    const input = makeInput({
      timeline: makeTimeline([
        makeClip({
          clip_id: "mid-utterance",
          segment_id: "s1",
          asset_id: "A",
          src_in_us: 500_000,
          src_out_us: 2_000_000,
          timeline_duration_frames: 45,
        }),
      ]),
      transcripts: [
        {
          transcript_id: "TR_A",
          asset_id: "A",
          utterances: [{ start_us: 0, end_us: 1_500_000, text: "mid-utterance" }],
        },
      ],
    });

    const silent = evaluateAssemblyLoss(input).measurements.silent_environmental_audio;
    expect(silent).toMatchObject({
      available: true,
      no_speech_duration_sec: 0.5,
      longest_no_speech_interval_sec: 0.5,
    });
  });

  it("treats touching source boundaries as zero overlap", () => {
    const endingAtUtteranceStart = makeInput({
      timeline: makeTimeline([
        makeClip({
          clip_id: "before-utterance",
          segment_id: "s1",
          asset_id: "A",
          src_in_us: 0,
          src_out_us: 1_000_000,
        }),
      ]),
      transcripts: [
        {
          transcript_id: "TR_A",
          asset_id: "A",
          utterances: [{ start_us: 1_000_000, end_us: 2_000_000, text: "after" }],
        },
      ],
    });
    expect(evaluateAssemblyLoss(endingAtUtteranceStart).measurements.silent_environmental_audio).toMatchObject({
      no_speech_duration_sec: 1,
      longest_no_speech_interval_sec: 1,
    });

    const startingAtUtteranceEnd = makeInput({
      timeline: makeTimeline([
        makeClip({
          clip_id: "after-utterance",
          segment_id: "s2",
          asset_id: "A",
          src_in_us: 1_000_000,
          src_out_us: 2_000_000,
        }),
      ]),
      transcripts: [
        {
          transcript_id: "TR_A",
          asset_id: "A",
          utterances: [{ start_us: 0, end_us: 1_000_000, text: "before" }],
        },
      ],
    });
    expect(evaluateAssemblyLoss(startingAtUtteranceEnd).measurements.silent_environmental_audio).toMatchObject({
      no_speech_duration_sec: 1,
      longest_no_speech_interval_sec: 1,
    });
  });

  it("pre-unions duplicate and overlapping utterances across three same-source placements", () => {
    const placements = [
      makeClip({
        clip_id: "p1",
        segment_id: "s1",
        asset_id: "A",
        src_in_us: 0,
        src_out_us: 1_000_000,
        timeline_in_frame: 0,
      }),
      makeClip({
        clip_id: "p2",
        segment_id: "s2",
        asset_id: "A",
        src_in_us: 500_000,
        src_out_us: 1_500_000,
        timeline_in_frame: FPS,
      }),
      makeClip({
        clip_id: "p3",
        segment_id: "s3",
        asset_id: "A",
        src_in_us: 1_500_000,
        src_out_us: 2_500_000,
        timeline_in_frame: 2 * FPS,
      }),
    ];
    const overlappingUtterances = [
      { start_us: 0, end_us: 1_200_000, text: "one" },
      { start_us: 800_000, end_us: 2_000_000, text: "two" },
      { start_us: 800_000, end_us: 2_000_000, text: "two duplicate" },
      { start_us: 1_800_000, end_us: 2_500_000, text: "three" },
    ];
    const makeSpeechInput = (utterances: typeof overlappingUtterances): AssemblyLossInput =>
      makeInput({
        timeline: makeTimeline(placements),
        transcripts: [{ transcript_id: "TR_A", asset_id: "A", utterances }],
      });

    const overlapping = evaluateAssemblyLoss(makeSpeechInput(overlappingUtterances));
    const preUnioned = evaluateAssemblyLoss(
      makeSpeechInput([{ start_us: 0, end_us: 2_500_000, text: "union" }]),
    );
    expect(overlapping.measurements.silent_environmental_audio).toEqual(
      preUnioned.measurements.silent_environmental_audio,
    );
    expect(overlapping.measurements.silent_environmental_audio).toMatchObject({
      no_speech_duration_sec: 0,
      longest_no_speech_interval_sec: 0,
    });
  });

  it("applies the explicit ASR tolerance at its boundary", () => {
    const { input } = baseSetup();
    // Head loss exactly equal to the default tolerance => measurement noise => full.
    const atTolerance = makeClip({
      clip_id: "c1",
      segment_id: "seg1",
      asset_id: "A",
      src_in_us: DEFAULT_ASR_TOLERANCE_US,
    });
    input.timeline = makeTimeline([atTolerance]);
    expect(evaluateAssemblyLoss(input).measurements.important_utterance_retention).toMatchObject({ full: 1 });

    // One microsecond beyond the tolerance => head cut.
    const beyondTolerance = makeClip({
      clip_id: "c1",
      segment_id: "seg1",
      asset_id: "A",
      src_in_us: DEFAULT_ASR_TOLERANCE_US + 1,
    });
    input.timeline = makeTimeline([beyondTolerance]);
    expect(evaluateAssemblyLoss(input).measurements.important_utterance_retention).toMatchObject({ head_cut: 1 });

    // A custom tolerance widens the noise band accordingly.
    const custom = evaluateAssemblyLoss({ ...input, asr_tolerance_us: DEFAULT_ASR_TOLERANCE_US + 10 });
    expect(custom.measurements.important_utterance_retention).toMatchObject({ full: 1 });
    expect(custom.policy.asr_tolerance_us).toBe(DEFAULT_ASR_TOLERANCE_US + 10);
    expect(custom.policy_hash).not.toBe(evaluateAssemblyLoss(input).policy_hash);
  });

  it("treats causal edges as auxiliary evidence only for setup/payoff", () => {
    const beats: Beat[] = [
      { id: "setup", label: "setup", target_duration_frames: FPS, required_roles: ["hero"], story_role: "setup" },
      { id: "payoff", label: "payoff", target_duration_frames: FPS, required_roles: ["hero"], story_role: "closing" },
    ];
    const clips = [
      makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A", beat_id: "setup", timeline_in_frame: 0 }),
      makeClip({ clip_id: "c2", segment_id: "s2", asset_id: "B", beat_id: "payoff", timeline_in_frame: FPS }),
    ];
    const input = makeInput({ blueprint: makeBlueprint(beats), timeline: makeTimeline(clips) });

    // Without any causal refs: edge evidence unavailable, order still observed ok.
    const withoutEdge = evaluateAssemblyLoss(input);
    expect(withoutEdge.measurements.setup_payoff).toEqual({
      setup_present: true,
      payoff_present: true,
      order: "ok",
      causal_edge_evidence: "unavailable",
      note: expect.stringContaining("NOT judged as absent causality"),
    });
    expect(withoutEdge.verdict).toBe("READY");

    // With an unrelated edge: evidence absent — but NOT causal absence, verdict unchanged.
    const unrelatedEdge = evaluateAssemblyLoss({
      ...input,
      causal_refs: [{ from_beat_id: "setup", to_beat_id: "setup", kind: "test" }],
    });
    expect(unrelatedEdge.measurements.setup_payoff.causal_edge_evidence).toBe("absent");
    expect(unrelatedEdge.verdict).toBe("READY");

    // Only the setup -> payoff direction counts as supporting evidence.
    const withEdge = evaluateAssemblyLoss({
      ...input,
      causal_refs: [{ from_beat_id: "setup", to_beat_id: "payoff", kind: "cause" }],
    });
    expect(withEdge.measurements.setup_payoff.causal_edge_evidence).toBe("present");

    // The reverse direction (payoff -> setup) is NOT supporting evidence.
    const reverseEdge = evaluateAssemblyLoss({
      ...input,
      causal_refs: [{ from_beat_id: "payoff", to_beat_id: "setup", kind: "reverse" }],
    });
    expect(reverseEdge.measurements.setup_payoff.causal_edge_evidence).toBe("absent");

    // Reversed order is observed as reversed (payoff clip precedes setup clip).
    const reversed = evaluateAssemblyLoss({
      ...input,
      timeline: makeTimeline([
        makeClip({ clip_id: "p0", segment_id: "s2", asset_id: "B", beat_id: "payoff", timeline_in_frame: 0 }),
        makeClip({ clip_id: "s0", segment_id: "s1", asset_id: "A", beat_id: "setup", timeline_in_frame: FPS }),
      ]),
    });
    expect(reversed.measurements.setup_payoff.order).toBe("reversed");
  });

  it("requires assembled timeline clips for setup/payoff presence", () => {
    const beats: Beat[] = [
      { id: "setup", label: "setup", target_duration_frames: FPS, required_roles: ["hero"], story_role: "setup" },
      { id: "payoff", label: "payoff", target_duration_frames: FPS, required_roles: ["hero"], story_role: "closing" },
    ];
    // Blueprint declares setup/payoff but the timeline assembles neither.
    const input = makeInput({ blueprint: makeBlueprint(beats), timeline: makeTimeline([]) });
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.setup_payoff).toMatchObject({
      setup_present: false,
      payoff_present: false,
      order: "not_observed",
    });
  });

  it("reports silent/environmental audio as observation-only and never gates the verdict", () => {
    // Two 1s clips (2s spine); speech covers only the first 1s.
    const clipA = makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A", timeline_in_frame: 0 });
    const clipB = makeClip({
      clip_id: "c2",
      segment_id: "s2",
      asset_id: "B",
      timeline_in_frame: FPS,
      src_in_us: 1_000_000,
      src_out_us: 2_000_000,
    });
    const ambient = makeClip({
      clip_id: "a1",
      segment_id: "amb1",
      asset_id: "AMB",
      timeline_in_frame: 0,
      timeline_duration_frames: 2 * FPS,
      role: "texture",
      audio_role: "ambient",
    });
    const { input } = baseSetup();
    input.timeline = makeTimeline([clipA, clipB], [ambient]);
    const report = evaluateAssemblyLoss(input);
    const silent = report.measurements.silent_environmental_audio;
    expect(silent.available).toBe(true);
    // Speech 0..1s inside a 2s spine => 1s without speech; longest gap = 1s.
    expect(silent.no_speech_duration_sec).toBeCloseTo(1, 5);
    expect(silent.longest_no_speech_interval_sec).toBeCloseTo(1, 5);
    expect(silent.ambient_audio_track_duration_sec).toBeCloseTo(2, 5);
    expect(silent.observation_only).toBe(true);
    // Observation-only: the silent stretch must not flip the verdict.
    expect(report.verdict).toBe("READY");
  });

  it("aggregates ambient/action as a timeline interval union across tracks", () => {
    const { input } = baseSetup();
    const videoTrack: TrackOutput = {
      track_id: "V1",
      kind: "video",
      clips: [makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A" })],
    };
    // Two ambient placements on DIFFERENT tracks, overlapping 0.5s:
    // union = 1.5s (not the 2.0s sum), and both contributing tracks are kept.
    const ambTrack1: TrackOutput = {
      track_id: "A3a",
      kind: "audio",
      role: "ambient",
      clips: [
        makeClip({
          clip_id: "a1",
          segment_id: "amb1",
          asset_id: "AMB",
          timeline_in_frame: 0,
          timeline_duration_frames: FPS,
          audio_role: "ambient",
        }),
      ],
    };
    const ambTrack2: TrackOutput = {
      track_id: "A3b",
      kind: "audio",
      role: "nat_sound",
      clips: [
        makeClip({
          clip_id: "a2",
          segment_id: "amb2",
          asset_id: "AMB",
          timeline_in_frame: 15,
          timeline_duration_frames: FPS,
          audio_role: "nat_sound",
        }),
      ],
    };
    input.timeline = {
      ...input.timeline,
      tracks: { ...input.timeline.tracks, video: [videoTrack], audio: [ambTrack1, ambTrack2] },
    };
    const report = evaluateAssemblyLoss(input);
    const silent = report.measurements.silent_environmental_audio;
    expect(silent.ambient_audio_track_duration_sec).toBeCloseTo(1.5, 5);
    expect(silent.ambient_sources?.length).toBe(2);
  });

  it("includes every valid clip of an ambient/nat-sound track in the union without clip audio_role", () => {
    const { input } = baseSetup();
    // Counterexample: the clip carries only role "support" (no audio_role),
    // but its TRACK is declared ambient — the 2s must count.
    input.timeline = makeTimeline(
      [makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A" })],
      [
        makeClip({
          clip_id: "a1",
          segment_id: "amb1",
          asset_id: "AMB",
          timeline_in_frame: 0,
          timeline_duration_frames: 2 * FPS,
          role: "support",
        }),
      ],
    );
    // makeTimeline's audio track already has role "ambient".
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.silent_environmental_audio.ambient_audio_track_duration_sec).toBeCloseTo(2, 5);
  });

  it("uses the maximum clip end as the program end", () => {
    const { input } = baseSetup();
    // Sorted-by-start order ends with a short clip; the program end is the
    // max end across all clips (10s), not the last clip's end (1s).
    input.timeline = makeTimeline([
      makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A", timeline_in_frame: 0, timeline_duration_frames: 10 * FPS }),
      makeClip({
        clip_id: "c2",
        segment_id: "s2",
        asset_id: "B",
        timeline_in_frame: FPS,
        src_in_us: 0,
        src_out_us: 1_000_000,
      }),
    ]);
    input.transcripts = [
      { transcript_id: "TR_A", asset_id: "A", utterances: [UTTERANCE] },
    ];
    const report = evaluateAssemblyLoss(input);
    const silent = report.measurements.silent_environmental_audio;
    expect(silent.available).toBe(true);
    // Spine 0..10s; speech 0..1s => 9s without speech, longest gap 9s.
    expect(silent.no_speech_duration_sec).toBeCloseTo(9, 5);
    expect(silent.longest_no_speech_interval_sec).toBeCloseTo(9, 5);
  });

  it("extends the no-speech spine through longer ambient audio", () => {
    const { input } = baseSetup();
    const oneSecondVideo = makeClip({
      clip_id: "video-1s",
      segment_id: "seg1",
      asset_id: "A",
      timeline_duration_frames: FPS,
    });
    const tenSecondAmbient = makeClip({
      clip_id: "ambient-10s",
      segment_id: "ambient",
      asset_id: "ROOM",
      timeline_duration_frames: 10 * FPS,
      role: "support",
      audio_role: "ambient",
    });
    input.timeline = makeTimeline([oneSecondVideo], [tenSecondAmbient]);
    input.transcripts = [
      { transcript_id: "TR_A", asset_id: "A", utterances: [UTTERANCE] },
    ];

    const silent = evaluateAssemblyLoss(input).measurements.silent_environmental_audio;
    expect(silent).toMatchObject({
      available: true,
      no_speech_duration_sec: 9,
      longest_no_speech_interval_sec: 9,
      ambient_audio_track_duration_sec: 10,
      observation_only: true,
    });
  });

  it("identifies kickoff only from provenance or an explicit kickoff beat", () => {
    // Double-hook counterexample: two hook beats and an explanation precede
    // the real kickoff. Substituting hook/first-beat must not win.
    const beats: Beat[] = [
      { id: "hook1", label: "hook", target_duration_frames: FPS, required_roles: ["hero"], story_role: "hook" },
      { id: "hook2", label: "second hook", target_duration_frames: FPS, required_roles: ["hero"], story_role: "hook" },
      { id: "expl", label: "explanation", target_duration_frames: FPS, required_roles: ["hero"] },
      { id: "kickoff", label: "kickoff", target_duration_frames: FPS, required_roles: ["hero"] },
    ];
    const clips = [
      makeClip({ clip_id: "broll", segment_id: "tex", asset_id: "T", beat_id: "expl", role: "texture", timeline_in_frame: 0 }),
      makeClip({ clip_id: "h1", segment_id: "s1", asset_id: "A", beat_id: "hook1", timeline_in_frame: FPS }),
      makeClip({ clip_id: "h2", segment_id: "s2", asset_id: "B", beat_id: "hook2", timeline_in_frame: 2 * FPS }),
      makeClip({ clip_id: "kick1", segment_id: "s3", asset_id: "C", beat_id: "kickoff", timeline_in_frame: 3 * FPS }),
    ];
    const input = makeInput({ blueprint: makeBlueprint(beats), timeline: makeTimeline(clips) });
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.kickoff_broll_before_kickoff).toMatchObject({
      available: true,
      kickoff_beat_id: "kickoff",
      kickoff_clip_id: "kick1",
      broll_clip_count: 1,
      broll_total_sec: 1,
    });
  });

  it("identifies kickoff from canonical timeline.provenance creator_short_vo_broll", () => {
    const beats: Beat[] = [
      { id: "b1", label: "body", target_duration_frames: FPS, required_roles: ["hero"] },
      { id: "b2", label: "body", target_duration_frames: FPS, required_roles: ["hero"] },
    ];
    const clips = [
      makeClip({ clip_id: "broll", segment_id: "tex", asset_id: "T", beat_id: "b1", role: "support", timeline_in_frame: 0 }),
      makeClip({
        clip_id: "anchor",
        segment_id: "s1",
        asset_id: "A",
        beat_id: "b2",
        timeline_in_frame: FPS,
        candidate_ref: "cand_9",
      }),
    ];
    const timeline = makeTimeline(clips);
    // Canonical location: TimelineIR.provenance.creator_short_vo_broll.
    timeline.provenance.creator_short_vo_broll = {
      policy: "creator-short-vo-broll/v1",
      phrase_policy: "creator-short-kickoff-phrases/v1",
      min_insert_frames: 15,
      max_insert_frames: 90,
      audio_mode: "dialogue_voice_over",
      anchor_status: "detected",
      degraded: false,
      candidate_ref: "cand_9",
    };
    const input = makeInput({ blueprint: makeBlueprint(beats), timeline });
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.kickoff_broll_before_kickoff).toMatchObject({
      available: true,
      detection_source: "creator_short_vo_broll_provenance",
      kickoff_clip_id: "anchor",
      broll_clip_count: 1,
      broll_total_sec: 1,
    });
  });

  it("does not read kickoff provenance from non-canonical timeline.metadata", () => {
    const beats: Beat[] = [
      { id: "b1", label: "body", target_duration_frames: FPS, required_roles: ["hero"] },
      { id: "b2", label: "body", target_duration_frames: FPS, required_roles: ["hero"] },
    ];
    const clips = [
      makeClip({ clip_id: "broll", segment_id: "tex", asset_id: "T", beat_id: "b1", role: "support", timeline_in_frame: 0 }),
      makeClip({
        clip_id: "anchor",
        segment_id: "s1",
        asset_id: "A",
        beat_id: "b2",
        timeline_in_frame: FPS,
        candidate_ref: "cand_9",
      }),
    ];
    const timeline = makeTimeline(clips);
    timeline.metadata = {
      creator_short_vo_broll: {
        policy: "creator-short-vo-broll/v1",
        phrase_policy: "creator-short-kickoff-phrases/v1",
        min_insert_frames: 15,
        max_insert_frames: 90,
        audio_mode: "dialogue_voice_over",
        anchor_status: "detected",
        degraded: false,
        candidate_ref: "cand_9",
      },
    };
    const input = makeInput({ blueprint: makeBlueprint(beats), timeline });
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.kickoff_broll_before_kickoff).toMatchObject({
      available: false,
      broll_clip_count: 0,
    });
  });

  it("reports kickoff as unavailable without provenance or an explicit kickoff beat", () => {
    const beats: Beat[] = [
      { id: "hook", label: "hook", target_duration_frames: FPS, required_roles: ["hero"], story_role: "hook" },
      { id: "b1", label: "body", target_duration_frames: FPS, required_roles: ["hero"] },
    ];
    const clips = [
      makeClip({ clip_id: "broll", segment_id: "tex", asset_id: "T", beat_id: "b1", role: "texture", timeline_in_frame: 0 }),
      makeClip({ clip_id: "h1", segment_id: "s1", asset_id: "A", beat_id: "hook", timeline_in_frame: FPS }),
    ];
    const input = makeInput({ blueprint: makeBlueprint(beats), timeline: makeTimeline(clips) });
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.kickoff_broll_before_kickoff).toMatchObject({
      available: false,
      broll_clip_count: 0,
    });
  });

  it("counts only the pre-kickoff portion of clips straddling the kickoff boundary", () => {
    const beats: Beat[] = [
      { id: "b1", label: "body", target_duration_frames: FPS, required_roles: ["hero"] },
      { id: "kickoff", label: "kickoff", target_duration_frames: FPS, required_roles: ["hero"] },
    ];
    const clips = [
      // Straddles the kickoff boundary at frame 15: 1.5s total, only the
      // first 0.5s lies before the kickoff clip.
      makeClip({
        clip_id: "straddle",
        segment_id: "tex",
        asset_id: "T",
        beat_id: "b1",
        role: "texture",
        timeline_in_frame: 0,
        timeline_duration_frames: FPS * 1.5,
      }),
      makeClip({ clip_id: "kick1", segment_id: "s1", asset_id: "A", beat_id: "kickoff", timeline_in_frame: 15 }),
    ];
    const input = makeInput({ blueprint: makeBlueprint(beats), timeline: makeTimeline(clips) });
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.kickoff_broll_before_kickoff).toMatchObject({
      available: true,
      kickoff_clip_id: "kick1",
      broll_clip_count: 1,
      broll_total_sec: 0.5,
    });
  });

  it("returns HOLD when selects or analysis coverage failed", () => {
    const { input } = baseSetup();
    input.selects.coverage = { ...input.selects.coverage!, status: "failed" };
    const report = evaluateAssemblyLoss(input);
    expect(report.grounding.coverage).toBe("failed");
    expect(report.verdict).toBe("HOLD");

    const analysisBlocked = evaluateAssemblyLoss({ ...baseSetup().input, analysis_coverage: { status: "blocked" } });
    expect(analysisBlocked.grounding.coverage).toBe("failed");
    expect(analysisBlocked.verdict).toBe("HOLD");
  });

  it("produces identical output and hashes for identical input", () => {
    const { input } = baseSetup();
    const a = evaluateAssemblyLoss(input);
    const b = evaluateAssemblyLoss(input);
    expect(a).toEqual(b);
    expect(a.input_hash).toBe(b.input_hash);
    expect(a.evaluator_version).toBe(ASSEMBLY_LOSS_EVALUATOR_VERSION);
  });

  it("hashes canonically regardless of key order and human-reference bag order", () => {
    const { input } = baseSetup();
    input.human_structural_reference = {
      label: "golden",
      clips: [
        { segment_id: "s2", duration_us: 1_000_000 },
        { segment_id: "s1" },
      ],
    };
    const a = evaluateAssemblyLoss(input);

    // Rebuild with genuinely different top-level key insertion order and a
    // reordered (same bag) human reference.
    const reordered: AssemblyLossInput = {
      transcripts: input.transcripts,
      timeline: input.timeline,
      blueprint: input.blueprint,
      selects: input.selects,
      brief: input.brief,
      human_structural_reference: {
        clips: [
          { segment_id: "s1" },
          { segment_id: "s2", duration_us: 1_000_000 },
        ],
        label: "golden",
      },
    };
    const b = evaluateAssemblyLoss(reordered);
    expect(b.input_hash).toBe(a.input_hash);
    expect(b).toEqual(a);
  });

  it("does not mutate inputs or canonical artifact objects", () => {
    const { input } = baseSetup();
    const before = JSON.parse(JSON.stringify({
      brief: input.brief,
      selects: input.selects,
      blueprint: input.blueprint,
      timeline: input.timeline,
      transcripts: input.transcripts,
    }));
    evaluateAssemblyLoss(input);
    const after = JSON.parse(JSON.stringify({
      brief: input.brief,
      selects: input.selects,
      blueprint: input.blueprint,
      timeline: input.timeline,
      transcripts: input.transcripts,
    }));
    expect(after).toEqual(before);
  });

  it("fails open when optional evidence is absent", () => {
    const input = makeInput();
    const report = evaluateAssemblyLoss(input);
    expect(report.verdict).toBe("READY");
    expect(report.measurements.important_utterance_retention).toMatchObject({
      available: false,
      reason: "no transcripts supplied",
    });
    expect(report.measurements.head_tail_truncation.available).toBe(false);
    expect(report.measurements.silent_environmental_audio.available).toBe(false);
    expect(report.measurements.human_structural_change).toMatchObject({
      available: false,
      reason: "no human structural reference supplied",
    });
    expect(report.measurements.wall_clock_breakdown).toBeNull();
    expect(report.grounding.selects_coverage_status).toBe("met");
  });

  it("measures human structural change as a multiset difference when supplied", () => {
    const clips = [
      makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A", timeline_in_frame: 0 }),
      makeClip({
        clip_id: "c2",
        segment_id: "s3",
        asset_id: "C",
        timeline_in_frame: FPS,
        timeline_duration_frames: 45,
        src_in_us: 1_000_000,
        src_out_us: 2_500_000,
      }),
    ];
    const input = makeInput({
      timeline: makeTimeline(clips),
      human_structural_reference: {
        label: "golden",
        clips: [
          { segment_id: "s1", duration_us: 1_000_000 },
          { segment_id: "s2", duration_us: 1_000_000 },
        ],
      },
    });
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.human_structural_change).toMatchObject({
      available: true,
      reference_label: "golden",
      // s1 kept; s2 removed; s3 added => 2 changed clips, 1.0s + 1.5s = 2.5s.
      changed_clip_count: 2,
      changed_seconds: 2.5,
    });
  });

  it("computes human structural change per unmatched occurrence duration", () => {
    const clips = [
      makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A", timeline_in_frame: 0 }),
    ];
    const input = makeInput({
      timeline: makeTimeline(clips),
      human_structural_reference: {
        label: "golden",
        clips: [
          { segment_id: "s1", duration_us: 1_000_000 },
          { segment_id: "s1", duration_us: 2_000_000 },
        ],
      },
    });
    const report = evaluateAssemblyLoss(input);
    // One s1 occurrence matched; the leftover s1 occurrence carries its own
    // 2.0s reference duration (occurrence-level, not averaged to 1.5s).
    expect(report.measurements.human_structural_change).toMatchObject({
      available: true,
      changed_clip_count: 1,
      changed_seconds: 2.0,
    });
  });

  it("reports human structural seconds as unknown when a needed reference duration is missing", () => {
    const clips = [
      makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A", timeline_in_frame: 0 }),
    ];
    const input = makeInput({
      timeline: makeTimeline(clips),
      human_structural_reference: {
        label: "golden",
        clips: [{ segment_id: "s2" }],
      },
    });
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.human_structural_change).toMatchObject({
      available: true,
      changed_clip_count: 2,
      changed_seconds: null,
    });
  });

  it("copies the supplied wall-clock breakdown instead of sharing the reference", () => {
    const wallClock = { analysis_sec: 12.5, compile_sec: 3.25 };
    const report = evaluateAssemblyLoss({ ...baseSetup().input, wall_clock_breakdown: wallClock });
    expect(report.measurements.wall_clock_breakdown).toEqual(wallClock);
    expect(report.measurements.wall_clock_breakdown).not.toBe(wallClock);
  });

  it("rejects non-finite or negative inputs before any hashing or measurement", () => {
    const { input } = baseSetup();
    input.timeline = makeTimeline([
      makeClip({
        clip_id: "bad",
        segment_id: "s1",
        asset_id: "A",
        timeline_duration_frames: Number.NaN,
      }),
    ]);
    expect(() => evaluateAssemblyLoss(input)).toThrow(/finite/);

    const negative = baseSetup().input;
    negative.timeline = makeTimeline([
      makeClip({
        clip_id: "bad",
        segment_id: "s1",
        asset_id: "A",
        src_in_us: 2_000_000,
        src_out_us: 1_000_000,
      }),
    ]);
    expect(() => evaluateAssemblyLoss(negative)).toThrow(/assembly-loss/);

    const badFps = baseSetup().input;
    badFps.timeline = {
      ...badFps.timeline,
      sequence: { ...badFps.timeline.sequence, fps_num: 0 },
    };
    expect(() => evaluateAssemblyLoss(badFps)).toThrow(/fps/);
  });

  it("rejects non-positive fps denominators, negative coordinates, and bad wall-clock values", () => {
    const zeroDen = baseSetup().input;
    zeroDen.timeline = {
      ...zeroDen.timeline,
      sequence: { ...zeroDen.timeline.sequence, fps_den: 0 },
    };
    expect(() => evaluateAssemblyLoss(zeroDen)).toThrow(/fps_den/);

    const negativeSrcIn = baseSetup().input;
    negativeSrcIn.timeline = makeTimeline([
      makeClip({ clip_id: "bad", segment_id: "s1", asset_id: "A", src_in_us: -1 }),
    ]);
    expect(() => evaluateAssemblyLoss(negativeSrcIn)).toThrow(/non-negative/);

    const negativeFrame = baseSetup().input;
    negativeFrame.timeline = makeTimeline([
      makeClip({ clip_id: "bad", segment_id: "s1", asset_id: "A", timeline_in_frame: -30 }),
    ]);
    expect(() => evaluateAssemblyLoss(negativeFrame)).toThrow(/non-negative/);

    const wallClockNaN = baseSetup().input;
    wallClockNaN.wall_clock_breakdown = { compile_sec: Number.NaN };
    expect(() => evaluateAssemblyLoss(wallClockNaN)).toThrow(/wall_clock/);

    const wallClockInfinity = baseSetup().input;
    wallClockInfinity.wall_clock_breakdown = { analysis_sec: Number.POSITIVE_INFINITY };
    expect(() => evaluateAssemblyLoss(wallClockInfinity)).toThrow(/wall_clock/);
  });

  it("keeps story role order observation honest with adjacent rank drops", () => {
    const beats: Beat[] = [
      { id: "b1", label: "body", target_duration_frames: FPS, required_roles: ["hero"], story_role: "closing" },
      { id: "b2", label: "body", target_duration_frames: FPS, required_roles: ["hero"], story_role: "setup" },
    ];
    const clips = [
      makeClip({ clip_id: "c1", segment_id: "s1", asset_id: "A", beat_id: "b1", timeline_in_frame: 0 }),
      makeClip({ clip_id: "c2", segment_id: "s2", asset_id: "B", beat_id: "b2", timeline_in_frame: FPS }),
    ];
    const input = makeInput({ blueprint: makeBlueprint(beats), timeline: makeTimeline(clips) });
    const report = evaluateAssemblyLoss(input);
    expect(report.measurements.story_role_order).toEqual({
      observed_order: ["closing", "setup"],
      adjacent_rank_drops: 1,
    });
  });
});
