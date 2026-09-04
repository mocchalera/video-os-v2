import { describe, expect, it } from "vitest";
import { applyAdaptiveTrim, type TrimRangeReport } from "../runtime/compiler/trim.js";
import type { Candidate, EditBlueprint, NormalizedBeat, TimelineClip } from "../runtime/compiler/types.js";

function blueprint(): EditBlueprint {
  return {
    version: "1",
    project_id: "duration-authority-fixture",
    sequence_goals: ["Keep the approved source range"],
    beats: [{
      id: "b01",
      label: "golden",
      target_duration_frames: 1_650,
      required_roles: ["hero"],
    }],
    pacing: {
      opening_cadence: "steady",
      middle_cadence: "steady",
      ending_cadence: "steady",
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b01",
    },
    dialogue_policy: {
      preserve_natural_breath: false,
      avoid_wall_to_wall_voiceover: true,
    },
    trim_policy: {
      mode: "adaptive",
      default_max_duration_frames: 120,
    },
    active_editing_skills: ["human_golden_order"],
  };
}

function candidate(): Candidate {
  return {
    candidate_id: "cand_golden",
    segment_id: "SEG_GOLDEN",
    asset_id: "AST_GOLDEN",
    src_in_us: 0,
    src_out_us: 55_000_000,
    role: "hero",
    why_it_matches: "authored 55 second source range",
    risks: [],
    confidence: 1,
  };
}

function clip(): TimelineClip {
  return {
    clip_id: "CLP_GOLDEN",
    segment_id: "SEG_GOLDEN",
    asset_id: "AST_GOLDEN",
    src_in_us: 0,
    src_out_us: 55_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 1_650,
    role: "hero",
    motivation: "approved authored range",
    beat_id: "b01",
    candidate_ref: "cand_golden",
    fallback_segment_ids: [],
    fallback_candidate_refs: [],
    confidence: 1,
    quality_flags: [],
  };
}

describe("strict human_golden_order trim authority", () => {
  it("does not apply an adaptive 120-frame max to an approved 1,650-frame source range", () => {
    const source = candidate();
    const timelineClip = clip();
    const report: TrimRangeReport[] = [];
    const beats: NormalizedBeat[] = [{
      beat_id: "b01",
      label: "golden",
      target_duration_frames: 1_650,
      required_roles: ["hero"],
      preferred_roles: [],
      purpose: "Keep the approved source range",
    }];

    applyAdaptiveTrim(
      [timelineClip],
      [source],
      blueprint(),
      beats,
      1_000_000 / 30,
      [],
      { preserveAuthoredRanges: true, rangeReport: report },
    );

    expect(timelineClip.src_in_us).toBe(0);
    expect(timelineClip.src_out_us).toBe(55_000_000);
    expect(timelineClip.timeline_duration_frames).toBe(1_650);
    expect(report).toEqual([expect.objectContaining({
      beat_id: "b01",
      requested: { src_in_us: 0, src_out_us: 55_000_000, duration_us: 55_000_000 },
      resolved: { src_in_us: 0, src_out_us: 55_000_000, duration_us: 55_000_000 },
      delta: { src_in_us: 0, src_out_us: 0, duration_us: 0 },
      reason: "human_golden_order_authoritative_source_range",
    })]);
  });
});
