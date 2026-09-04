// Issue #34 — true A/B roll overlap transition engine (unit tests)
//
// Covers:
// - Physical overlap geometry (applyTransitionOverlaps): head extension,
//   still-image holds, explicit degradation, duration neutrality
// - Craft emission of the semantic presets (film_crossfade /
//   light_leak_flash / dreamy_focus_blur) through adjacencyDecide
// - Chorus section snap so the light-leak flash fires exactly on the chorus
//   head frame (1フレームのズレもなく)

import { describe, it, expect } from "vitest";
import type {
  Candidate,
  NormalizedBeat,
  TimelineClip,
  Track,
} from "../runtime/compiler/types.js";
import type { BgmAnalysis, TimelineTransition } from "../runtime/compiler/transition-types.js";
import { adjacencyDecide, findChorusSectionSnapTarget } from "../runtime/compiler/adjacency.js";
import {
  applyTransitionOverlaps,
} from "../runtime/compiler/transition-overlap.js";

// ── Helpers (mirroring tests/cut-transition.test.ts) ─────────────────

const makeClip = (id: string, overrides: Partial<TimelineClip> = {}): TimelineClip => ({
  clip_id: `clip_${id}`,
  segment_id: `SEG_${id}`,
  asset_id: `AST_${id}`,
  src_in_us: 0,
  src_out_us: 3_000_000,
  timeline_in_frame: 0,
  timeline_duration_frames: 72,
  role: "hero",
  motivation: "test",
  beat_id: `B${id}`,
  fallback_segment_ids: [],
  confidence: 0.8,
  quality_flags: [],
  ...overrides,
});

const makeCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  segment_id: "SEG_001",
  asset_id: "AST_001",
  src_in_us: 0,
  src_out_us: 5_000_000,
  role: "hero",
  why_it_matches: "test",
  risks: [],
  confidence: 0.9,
  ...overrides,
});

const makeBeat = (id: string, overrides: Partial<NormalizedBeat> = {}): NormalizedBeat => ({
  beat_id: id,
  label: `Beat ${id}`,
  target_duration_frames: 72,
  required_roles: ["hero"],
  preferred_roles: [],
  purpose: "test",
  ...overrides,
});

const makeBgm = (overrides: Partial<BgmAnalysis> = {}): BgmAnalysis => ({
  version: "1",
  project_id: "test",
  analysis_status: "ready",
  music_asset: { asset_id: "BGM_001", path: "bgm.mp3" },
  bpm: 120,
  meter: "4/4",
  duration_sec: 60,
  beats_sec: [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0],
  downbeats_sec: [0, 2.0, 4.0],
  sections: [{ id: "S1", label: "intro", start_sec: 0, end_sec: 60, energy: 0.5 }],
  provenance: { detector: "test", sample_rate_hz: 22050 },
  ...overrides,
});

function makeTrack(clips: TimelineClip[]): Track {
  return { track_id: "V1", kind: "video", clips };
}

// ── Physical overlap geometry ─────────────────────────────────────────

describe("applyTransitionOverlaps", () => {
  const opts = { fpsNum: 24, fpsDen: 1 };

  it("extends the incoming clip head into its source without changing program duration", () => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 24, src_in_us: 1_000_000, src_out_us: 2_000_000 });
    const b = makeClip("02", { timeline_in_frame: 24, timeline_duration_frames: 24, src_in_us: 2_000_000, src_out_us: 3_000_000 });
    const track = makeTrack([a, b]);
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_02",
      track_id: "V1",
      transition_type: "light_leak_flash" as const,
      transition_params: { crossfade_sec: 6 / 24, easing: "linear" as const },
    };

    const before = Math.max(a.timeline_in_frame + a.timeline_duration_frames, b.timeline_in_frame + b.timeline_duration_frames);
    const result = applyTransitionOverlaps(track, [transition], opts);

    expect(result.applied).toHaveLength(1);
    expect(result.degraded).toHaveLength(0);
    expect(result.applied[0]).toEqual({
      transition_id: "tr_0000",
      to_clip_id: "clip_02",
      overlap_frames: 6,
      // Seam = first frame of B's original content (chorus head).
      seam_frame: 24,
    });
    // Provenance metadata mirrors the rendered geometry exactly.
    expect(transition.metadata?.overlap_applied).toEqual({
      overlap_frames: 6,
      seam_frame: 24,
    });
    // B placed 6 frames earlier, duration extended, source head extended.
    expect(b.timeline_in_frame).toBe(18);
    expect(b.timeline_duration_frames).toBe(30);
    expect(b.src_in_us).toBe(2_000_000 - 6 * 1_000_000 / 24);
    // A untouched.
    expect(a.timeline_in_frame).toBe(0);
    expect(a.timeline_duration_frames).toBe(24);
    // Duration neutrality: max end identical (Gap 0 / Overrun 0).
    const after = Math.max(a.timeline_in_frame + a.timeline_duration_frames, b.timeline_in_frame + b.timeline_duration_frames);
    expect(after).toBe(before);
  });

  it("keeps still-image metadata consistent when extending an image clip", () => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 24 });
    const b = makeClip("02", {
      timeline_in_frame: 24,
      timeline_duration_frames: 24,
      media_kind: "image",
      still_image: {
        hold_frames: 24,
        min_hold_frames: 12,
        max_hold_frames: 48,
        hold_source: "profile_default",
        policy_clamp: "none",
        motion_mode: "static",
        fit_mode: "cover",
        background: "black",
      },
    });
    const track = makeTrack([a, b]);
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_02",
      track_id: "V1",
      transition_type: "film_crossfade" as const,
      transition_params: { crossfade_sec: 0.25 },
    };

    const result = applyTransitionOverlaps(track, [transition], opts);
    expect(result.applied).toHaveLength(1);
    expect(b.timeline_in_frame).toBe(18);
    expect(b.timeline_duration_frames).toBe(30);
    expect(b.still_image?.hold_frames).toBe(30);
    // Stills have no source range to extend.
    expect(b.src_in_us).toBe(0);
    expect(b.src_out_us).toBe(3_000_000);
  });

  it("degrades explicitly to cut when the source has no head handle", () => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 24 });
    const b = makeClip("02", {
      timeline_in_frame: 24,
      timeline_duration_frames: 24,
      src_in_us: 0, // clip starts at the head of its source: no handle
      src_out_us: 1_000_000,
    });
    const track = makeTrack([a, b]);
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_02",
      track_id: "V1",
      transition_type: "dreamy_focus_blur" as const,
      transition_params: { crossfade_sec: 0.25 },
    };

    const result = applyTransitionOverlaps(track, [transition], opts);
    expect(result.applied).toHaveLength(0);
    expect(result.degraded).toHaveLength(1);
    expect(result.degraded[0].reason).toBe("insufficient_source_head_handle");
    expect(result.degraded[0].overlap_frames_requested).toBe(6);
    // Explicit degradation — never a silent fallback.
    expect(transition.transition_type).toBe("cut");
    expect(transition.transition_params?.crossfade_sec).toBeUndefined();
    expect(transition.fallback).toEqual({
      type: "cut",
      reason: "overlap_preset_unrenderable:insufficient_source_head_handle",
    });
    expect(transition.metadata?.degraded_reason).toBe(
      "transition_overlap_insufficient_source_head_handle",
    );
    // Geometry untouched.
    expect(b.timeline_in_frame).toBe(24);
    expect(b.timeline_duration_frames).toBe(24);
  });

  it("degrades when the overlap window would exceed either clip", () => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 4 });
    const b = makeClip("02", { timeline_in_frame: 4, timeline_duration_frames: 24, src_in_us: 5_000_000 });
    const track = makeTrack([a, b]);
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_02",
      track_id: "V1",
      transition_type: "light_leak_flash" as const,
      transition_params: { crossfade_sec: 0.25 }, // 6 frames > 4
    };

    const result = applyTransitionOverlaps(track, [transition], opts);
    expect(result.degraded[0].reason).toBe("overlap_exceeds_clip_duration");
    expect(transition.transition_type).toBe("cut");
  });

  it("degrades when clips are not adjacent (gap or authored overlap)", () => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 24 });
    const b = makeClip("02", { timeline_in_frame: 30, timeline_duration_frames: 24, src_in_us: 5_000_000 });
    const track = makeTrack([a, b]);
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_02",
      track_id: "V1",
      transition_type: "film_crossfade" as const,
      transition_params: { crossfade_sec: 0.25 },
    };

    const result = applyTransitionOverlaps(track, [transition], opts);
    expect(result.degraded[0].reason).toBe("non_adjacent_placement");
    expect(transition.transition_type).toBe("cut");
  });

  it("degrades consistently when the crossfade duration is missing", () => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 24 });
    const b = makeClip("02", { timeline_in_frame: 24, timeline_duration_frames: 24, src_in_us: 2_000_000 });
    const track = makeTrack([a, b]);
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_02",
      track_id: "V1",
      transition_type: "light_leak_flash" as const,
      transition_params: {},
    };

    const result = applyTransitionOverlaps(track, [transition], opts);
    expect(result.degraded[0].reason).toBe("missing_crossfade_sec");
    // Same explicit path as every other refusal: cut + fallback + metadata.
    expect(transition.transition_type).toBe("cut");
    expect(transition.fallback).toEqual({
      type: "cut",
      reason: "overlap_preset_unrenderable:missing_crossfade_sec",
    });
    expect(transition.metadata?.degraded_reason).toBe(
      "transition_overlap_missing_crossfade_sec",
    );
    expect(b.timeline_in_frame).toBe(24);
  });

  it("degrades explicitly on a dangling clip reference", () => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 24 });
    const track = makeTrack([a]);
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_missing",
      track_id: "V1",
      transition_type: "film_crossfade" as const,
      transition_params: { crossfade_sec: 0.25 },
    };

    const result = applyTransitionOverlaps(track, [transition], opts);
    expect(result.applied).toHaveLength(0);
    expect(result.degraded[0].reason).toBe("missing_clip_reference");
    expect(transition.transition_type).toBe("cut");
    expect(transition.fallback).toEqual({
      type: "cut",
      reason: "overlap_preset_unrenderable:missing_clip_reference",
    });
    expect(transition.metadata?.degraded_reason).toBe(
      "transition_overlap_missing_clip_reference",
    );
  });

  it("degrades on speech-protected beat boundaries", () => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 24 });
    const b = makeClip("02", {
      timeline_in_frame: 24,
      timeline_duration_frames: 24,
      src_in_us: 2_000_000,
      metadata: { talking_head_pacing: { snapped_in: true } },
    });
    const track = makeTrack([a, b]);
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_02",
      track_id: "V1",
      transition_type: "dreamy_focus_blur" as const,
      transition_params: { crossfade_sec: 0.25 },
    };

    const result = applyTransitionOverlaps(track, [transition], opts);
    expect(result.applied).toHaveLength(0);
    expect(result.degraded[0].reason).toBe("speech_protected_boundary");
    expect(transition.transition_type).toBe("cut");
    expect(transition.metadata?.degraded_reason).toBe(
      "transition_overlap_speech_protected_boundary",
    );
    // Geometry untouched — the incoming clip's nat sound stays intact.
    expect(b.timeline_in_frame).toBe(24);
    expect(b.src_in_us).toBe(2_000_000);
  });

  it("strips flash provenance when a chorus transition degrades", () => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 24 });
    const b = makeClip("02", {
      timeline_in_frame: 24,
      timeline_duration_frames: 24,
      src_in_us: 0, // no head handle → degrade
      src_out_us: 1_000_000,
    });
    const track = makeTrack([a, b]);
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_02",
      track_id: "V1",
      transition_type: "light_leak_flash" as const,
      transition_params: { crossfade_sec: 0.25, easing: "linear" as const },
      metadata: {
        chorus_entry: {
          section_id: "S2",
          flash_start_frame: 24,
          flash_peak_frame: 24,
          flash_end_frame: 30,
        },
      },
    };

    const result = applyTransitionOverlaps(track, [transition], opts);
    expect(result.degraded[0].reason).toBe("insufficient_source_head_handle");
    const chorus = transition.metadata?.chorus_entry as Record<string, unknown>;
    expect(chorus.section_id).toBe("S2");
    // Provenance that would no longer be rendered is stripped.
    expect(chorus.flash_start_frame).toBeUndefined();
    expect(chorus.flash_peak_frame).toBeUndefined();
    expect(chorus.flash_end_frame).toBeUndefined();
  });

  it("records post-geometry flash provenance for applied chorus flashes", () => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 24 });
    const b = makeClip("02", { timeline_in_frame: 24, timeline_duration_frames: 24, src_in_us: 2_000_000, src_out_us: 4_000_000 });
    const track = makeTrack([a, b]);
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_02",
      track_id: "V1",
      transition_type: "light_leak_flash" as const,
      transition_params: { crossfade_sec: 0.25, easing: "linear" as const },
      metadata: { chorus_entry: { section_id: "S2", flash_start_frame: 24 } },
    };

    const result = applyTransitionOverlaps(track, [transition], opts);
    expect(result.applied).toHaveLength(1);
    // After the overlap: B [18,48), seam (chorus head) = 24, flash window
    // [18, 30) — ramp over the blend, peak on the seam, decay after.
    expect(transition.metadata?.chorus_entry).toEqual({
      section_id: "S2",
      flash_start_frame: 18,
      flash_peak_frame: 24,
      flash_end_frame: 30,
    });
  });

  it("does not touch legacy crossfade transitions", () => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 24 });
    const b = makeClip("02", { timeline_in_frame: 24, timeline_duration_frames: 24, src_in_us: 2_000_000 });
    const track = makeTrack([a, b]);
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_02",
      track_id: "V1",
      transition_type: "crossfade" as const,
      transition_params: { crossfade_sec: 0.5 },
    };

    const result = applyTransitionOverlaps(track, [transition], opts);
    expect(result.applied).toHaveLength(0);
    expect(result.degraded).toHaveLength(0);
    expect(b.timeline_in_frame).toBe(24);
    expect(transition.transition_type).toBe("crossfade");
  });
});

// ── Chained overlap guards (three clips) ──────────────────────────────
// The outgoing side of a chained transition must be validated against the
// clip's ORIGINAL content, never against the duration already extended by
// the incoming overlap — otherwise the second blend swallows the clip's own
// material and stacks on top of the first window (triple A/B/C coverage).

describe("chained overlap guards (A30 / B8 / C30)", () => {
  const makeChain = (secondCrossfadeSec: number) => {
    const a = makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 30, src_in_us: 0, src_out_us: 2_000_000 });
    const b = makeClip("02", { timeline_in_frame: 30, timeline_duration_frames: 8, src_in_us: 5_000_000, src_out_us: 6_000_000 });
    const c = makeClip("03", { timeline_in_frame: 38, timeline_duration_frames: 30, src_in_us: 5_000_000, src_out_us: 8_000_000 });
    const tr1: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "clip_01",
      to_clip_id: "clip_02",
      track_id: "V1",
      transition_type: "film_crossfade" as const,
      transition_params: { crossfade_sec: 6 / 24, easing: "linear" as const },
    };
    const tr2: TimelineTransition = {
      transition_id: "tr_0001",
      from_clip_id: "clip_02",
      to_clip_id: "clip_03",
      track_id: "V1",
      transition_type: "dreamy_focus_blur" as const,
      transition_params: { crossfade_sec: secondCrossfadeSec, easing: "linear" as const },
    };
    const track = makeTrack([a, b, c]);
    return { a, b, c, tr1, tr2, track };
  };

  const programEnd = (clips: TimelineClip[]): number =>
    Math.max(...clips.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames));

  it("degrades the chained overlap that would consume B's original content (triple coverage)", () => {
    // Overlap 6 applied to A→B; overlap 11 requested on B→C. B's ORIGINAL
    // content is 8 frames — 11 would swallow it and start the second blend
    // inside the first window.
    const { a, b, c, tr1, tr2, track } = makeChain(11 / 24);
    const result = applyTransitionOverlaps(track, [tr1, tr2], { fpsNum: 24, fpsDen: 1 });

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].transition_id).toBe("tr_0000");
    expect(result.degraded).toHaveLength(1);
    expect(result.degraded[0]).toMatchObject({
      transition_id: "tr_0001",
      to_clip_id: "clip_03",
      reason: "chained_overlap_exceeds_original_content",
      overlap_frames_requested: 11,
    });
    // Explicit degradation provenance — never a silent no-op.
    expect(tr2.transition_type).toBe("cut");
    expect(tr2.fallback).toEqual({
      type: "cut",
      reason: "overlap_preset_unrenderable:chained_overlap_exceeds_original_content",
    });
    expect(tr2.metadata?.degraded_reason).toBe(
      "transition_overlap_chained_overlap_exceeds_original_content",
    );
    // Geometry: B keeps its valid extended shape, C is untouched.
    expect(b.timeline_in_frame).toBe(24);
    expect(b.timeline_duration_frames).toBe(14);
    expect(c.timeline_in_frame).toBe(38);
    expect(c.timeline_duration_frames).toBe(30);
    // The A→B blend window [24,30) ends exactly at B's original content
    // start; the refused B→C window would have started inside it.
    expect(b.timeline_in_frame + 6).toBe(30);
    // Gap 0 / Overrun 0: program duration unchanged (68 frames).
    expect(programEnd([a, b, c])).toBe(68);
  });

  it("applies chained overlaps at the boundary without triple coverage", () => {
    // Overlap 6 then 2: the B→C window [36,38) fits inside B's exclusive
    // content [30,38) and stays disjoint from the A→B window [24,30).
    const { a, b, c, tr1, tr2, track } = makeChain(2 / 24);
    const result = applyTransitionOverlaps(track, [tr1, tr2], { fpsNum: 24, fpsDen: 1 });

    expect(result.degraded).toHaveLength(0);
    expect(result.applied).toHaveLength(2);
    expect(result.applied[1]).toEqual({
      transition_id: "tr_0001",
      to_clip_id: "clip_03",
      overlap_frames: 2,
      seam_frame: 38,
    });
    expect(b.timeline_in_frame).toBe(24);
    expect(b.timeline_duration_frames).toBe(14);
    expect(c.timeline_in_frame).toBe(36);
    expect(c.timeline_duration_frames).toBe(32);
    // Blend windows disjoint: [24,30) ∩ [36,38) = ∅.
    expect(b.timeline_in_frame + 6).toBeLessThanOrEqual(c.timeline_in_frame);
    // Gap 0 / Overrun 0.
    expect(programEnd([a, b, c])).toBe(68);
  });

  it("NTSC (30000/1001): chained boundary applies and one-frame-over degrades", () => {
    const fpsNum = 30000;
    const fpsDen = 1001;
    // crossfade durations that round to exactly 7 and 8 frames at NTSC fps.
    const sec7 = (7 * fpsDen) / fpsNum;
    const sec8 = (8 * fpsDen) / fpsNum;

    // Boundary: 7 + 7 — both fit (B original 8 > 7), windows disjoint.
    {
      const { a, b, c, tr1, tr2, track } = makeChain(sec7);
      const result = applyTransitionOverlaps(track, [tr1, tr2], { fpsNum, fpsDen });
      expect(result.degraded).toHaveLength(0);
      expect(result.applied).toHaveLength(2);
      // B head-extended by 7: [23, 38); C by 7: [31, 68).
      expect(b.timeline_in_frame).toBe(23);
      expect(b.timeline_duration_frames).toBe(15);
      expect(c.timeline_in_frame).toBe(31);
      expect(c.timeline_duration_frames).toBe(37);
      // Blend windows [23,30) and [31,38) disjoint; B's exclusive content
      // [30,38) fully covers the second window.
      expect(b.timeline_in_frame + 7).toBe(30);
      expect(c.timeline_in_frame).toBeGreaterThan(30);
      expect(programEnd([a, b, c])).toBe(68);
    }

    // Degrade: 7 then 8 — the second overlap equals B's ORIGINAL content,
    // which the extended duration (15) would have allowed through.
    {
      const { tr1, tr2, track, b, c } = makeChain(sec8);
      const result = applyTransitionOverlaps(track, [tr1, tr2], { fpsNum, fpsDen });
      expect(result.applied).toHaveLength(1);
      expect(result.degraded).toHaveLength(1);
      expect(result.degraded[0]).toMatchObject({
        transition_id: "tr_0001",
        reason: "chained_overlap_exceeds_original_content",
        overlap_frames_requested: 8,
      });
      expect(tr2.transition_type).toBe("cut");
      // C untouched; B keeps only the valid 7-frame extension.
      expect(c.timeline_in_frame).toBe(38);
      expect(c.timeline_duration_frames).toBe(30);
      expect(b.timeline_duration_frames).toBe(15);
    }
  });
});

// ── Craft emission of the semantic presets ────────────────────────────

describe("adjacencyDecide craft emission (Issue #34 presets)", () => {
  const baseOpts = (beats: NormalizedBeat[]) => ({
    activeEditingSkills: [] as string[],
    durationMode: "guide" as const,
    fpsNum: 24,
    candidates: [
      makeCandidate({ segment_id: "SEG_01", candidate_id: "cand_01", asset_id: "AST_001" }),
      makeCandidate({ segment_id: "SEG_02", candidate_id: "cand_02", asset_id: "AST_002" }),
    ],
    beats,
    transitionSkillsDir: undefined,
  });

  it("emits light_leak_flash with the preset duration and linear easing", () => {
    const v1 = makeTrack([
      makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01", asset_id: "AST_001", segment_id: "SEG_01" }),
      makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002", segment_id: "SEG_02" }),
    ]);
    const beats = [
      makeBeat("B01"),
      makeBeat("B02", { craft: { transition_in: "light_leak_flash" } }),
    ];

    const { transitions } = adjacencyDecide(v1, baseOpts(beats));
    expect(transitions).toHaveLength(1);
    const t = transitions[0];
    expect(t.transition_type).toBe("light_leak_flash");
    expect(t.transition_params?.crossfade_sec).toBe(0.2);
    expect(t.transition_params?.easing).toBe("linear");
    expect(t.applied_skill_id).toBe("craft.light_leak_flash");
  });

  it("emits dreamy_focus_blur and film_crossfade with their preset durations", () => {
    for (const [craftType, expectedSec] of [
      ["dreamy_focus_blur", 0.45],
      ["film_crossfade", 0.35],
    ] as const) {
      const v1 = makeTrack([
        makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: 72, beat_id: "B01", asset_id: "AST_001", segment_id: "SEG_01" }),
        makeClip("02", { timeline_in_frame: 72, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002", segment_id: "SEG_02" }),
      ]);
      const beats = [
        makeBeat("B01"),
        makeBeat("B02", { craft: { transition_in: craftType } }),
      ];

      const { transitions } = adjacencyDecide(v1, baseOpts(beats));
      expect(transitions).toHaveLength(1);
      expect(transitions[0].transition_type).toBe(craftType);
      expect(transitions[0].transition_params?.crossfade_sec).toBe(expectedSec);
      expect(transitions[0].transition_params?.easing).toBe("linear");
    }
  });
});

// ── Chorus section snap (サビ頭で 1フレームのズレもなく) ───────────────

describe("findChorusSectionSnapTarget", () => {
  const fps = 24;

  it("snaps to the nearest chorus section start within tolerance", () => {
    const bgm = makeBgm({
      sections: [
        { id: "S1", label: "intro", start_sec: 0, end_sec: 2.0, energy: 0.4 },
        { id: "S2", label: "chorus", start_sec: 2.0, end_sec: 5.0, energy: 0.9 },
      ],
    });
    const snap = findChorusSectionSnapTarget(Math.round(1.96 * fps), fps, bgm, 12);
    expect(snap).toBeDefined();
    expect(snap?.section_id).toBe("S2");
    expect(snap?.target_frame).toBe(Math.round(2.0 * fps));
    expect(snap?.delta_frames).toBe(Math.round(2.0 * fps) - Math.round(1.96 * fps));
  });

  it("ignores non-chorus sections", () => {
    const bgm = makeBgm({
      sections: [
        { id: "S1", label: "intro", start_sec: 0, end_sec: 2.0, energy: 0.4 },
      ],
    });
    expect(findChorusSectionSnapTarget(48, fps, bgm, 12)).toBeUndefined();
  });

  it("returns undefined when the nearest chorus start exceeds tolerance", () => {
    const bgm = makeBgm({
      sections: [
        { id: "S2", label: "chorus", start_sec: 3.0, end_sec: 5.0, energy: 0.9 },
      ],
    });
    expect(findChorusSectionSnapTarget(0, fps, bgm, 12)).toBeUndefined();
  });
});

describe("adjacencyDecide chorus snap for light_leak_flash", () => {
  it("lands the flash exactly on the chorus head frame", () => {
    const fps = 24;
    const chorusStartSec = 2.0;
    const chorusHeadFrame = Math.round(chorusStartSec * fps);
    // Cut sits 5 frames before the chorus head — within the 12-frame tolerance.
    const cutFrame = chorusHeadFrame - 5;
    const v1 = makeTrack([
      makeClip("01", { timeline_in_frame: 0, timeline_duration_frames: cutFrame, beat_id: "B01", asset_id: "AST_001", segment_id: "SEG_01", src_in_us: 500_000 }),
      makeClip("02", { timeline_in_frame: cutFrame, timeline_duration_frames: 72, beat_id: "B02", asset_id: "AST_002", segment_id: "SEG_02", src_in_us: 3_000_000 }),
    ]);
    const beats = [
      makeBeat("B01"),
      makeBeat("B02", { craft: { transition_in: "light_leak_flash" } }),
    ];

    const { transitions } = adjacencyDecide(v1, {
      activeEditingSkills: [],
      durationMode: "guide",
      fpsNum: fps,
      bgmAnalysis: makeBgm({
        sections: [
          { id: "S1", label: "intro", start_sec: 0, end_sec: chorusStartSec, energy: 0.4 },
          { id: "S2", label: "chorus", start_sec: chorusStartSec, end_sec: 5.0, energy: 0.9 },
        ],
      }),
      candidates: [
        makeCandidate({ segment_id: "SEG_01", candidate_id: "cand_01", asset_id: "AST_001" }),
        makeCandidate({ segment_id: "SEG_02", candidate_id: "cand_02", asset_id: "AST_002" }),
      ],
      beats,
      transitionSkillsDir: undefined,
    });

    expect(transitions).toHaveLength(1);
    const t = transitions[0];
    expect(t.transition_type).toBe("light_leak_flash");
    expect(t.transition_params?.cut_frame_after_snap).toBe(chorusHeadFrame);
    expect(t.transition_params?.snap_delta_frames).toBe(5);
    expect(t.transition_params?.beat_ref_sec).toBe(chorusStartSec);
    expect(t.metadata?.chorus_entry).toEqual({
      section_id: "S2",
      flash_start_frame: chorusHeadFrame,
    });
  });
});
