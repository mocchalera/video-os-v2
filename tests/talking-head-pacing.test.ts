import { describe, it, expect, beforeEach } from "vitest";
import {
  snapRangeToUtteranceBoundaries,
  utteranceBoundaryTimestamps,
  applyUtteranceSnap,
  type UtteranceSpan,
} from "../runtime/compiler/trim.js";
import {
  loadSkills,
  clearSkillCache,
  activateSkills,
  getUtteranceSnapConfig,
} from "../runtime/editorial/skill-registry.js";
import type { TimelineClip, EditBlueprint, Candidate } from "../runtime/compiler/types.js";

/**
 * talking_head_pacing — increment 1: utterance-boundary snapping.
 *
 * Cuts in a dialogue digest must land on phrase boundaries, not mid-word. The
 * compiler snaps each clip's in/out to the nearest transcript utterance edge
 * within a tolerance, which is exactly what makes the review metric
 * audio.speech_cut pass. These tests pin the pure snap math, the skill wiring,
 * and the cross-check against the review guard. Filler excision / pause
 * tightening are a separate (deferred) increment that needs within-beat IR.
 */

// review's audio.speech_cut guard, mirrored here so the contract test proves a
// snapped clip no longer trips it.
const SPEECH_CUT_GUARD_US = 80_000;
function boundaryInsideUtterance(boundaryUs: number, u: UtteranceSpan): boolean {
  return boundaryUs > u.start_us + SPEECH_CUT_GUARD_US && boundaryUs < u.end_us - SPEECH_CUT_GUARD_US;
}

// Contiguous interview utterances (same shape as 03_analysis/transcripts items).
const UTTERANCES: UtteranceSpan[] = [
  { start_us: 0, end_us: 5_460_000 },
  { start_us: 5_460_000, end_us: 8_340_000 },
  { start_us: 8_340_000, end_us: 17_400_000 },
  { start_us: 17_400_000, end_us: 19_760_000 },
];

function makeClip(overrides: Partial<TimelineClip>): TimelineClip {
  return {
    clip_id: "C1",
    segment_id: "S1",
    asset_id: "AST_TALK",
    src_in_us: 0,
    src_out_us: 1_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 24,
    role: "dialogue",
    motivation: "test",
    beat_id: "B1",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    ...overrides,
  } as TimelineClip;
}

describe("utteranceBoundaryTimestamps", () => {
  it("returns sorted, de-duplicated edges and drops zero/negative spans", () => {
    const ts = utteranceBoundaryTimestamps([
      { start_us: 5_460_000, end_us: 8_340_000 },
      { start_us: 0, end_us: 5_460_000 }, // shares the 5_460_000 edge
      { start_us: 100, end_us: 100 }, // zero-length, dropped
      { start_us: 900, end_us: 500 }, // inverted, dropped
    ]);
    expect(ts).toEqual([0, 5_460_000, 8_340_000]);
  });
});

describe("snapRangeToUtteranceBoundaries", () => {
  const TOL = 700_000;

  it("snaps a mid-utterance in-point to the nearest edge within tolerance", () => {
    // in at 5_200_000 is 260ms before the 5_460_000 edge → snaps to it.
    const r = snapRangeToUtteranceBoundaries(5_200_000, 8_100_000, UTTERANCES, TOL);
    expect(r).not.toBeNull();
    expect(r!.src_in_us).toBe(5_460_000);
    expect(r!.snapped_in).toBe(true);
  });

  it("snaps the out-point to the nearest edge within tolerance", () => {
    // out at 8_100_000 is 240ms before 8_340_000 → snaps forward to it.
    const r = snapRangeToUtteranceBoundaries(0, 8_100_000, UTTERANCES, TOL);
    expect(r).not.toBeNull();
    expect(r!.src_out_us).toBe(8_340_000);
    expect(r!.snapped_out).toBe(true);
  });

  it("leaves a boundary untouched when no edge is within tolerance", () => {
    // in at 3_000_000 — nearest edges (0, 5_460_000) are >700ms away.
    const r = snapRangeToUtteranceBoundaries(3_000_000, 8_340_000, UTTERANCES, TOL);
    // out already on an edge → only difference would be the in; in cannot snap.
    expect(r).toBeNull();
  });

  it("returns null when both boundaries already sit on edges", () => {
    expect(snapRangeToUtteranceBoundaries(5_460_000, 8_340_000, UTTERANCES, TOL)).toBeNull();
  });

  it("never produces an inverted or sub-guard clip", () => {
    // Probe a range of in/out positions; any snap must keep a valid duration.
    for (let inUs = 0; inUs <= 19_000_000; inUs += 137_000) {
      const r = snapRangeToUtteranceBoundaries(inUs, inUs + 200_000, UTTERANCES, TOL);
      if (r) {
        expect(r.src_out_us).toBeGreaterThan(r.src_in_us);
        expect(r.src_out_us - r.src_in_us).toBeGreaterThan(SPEECH_CUT_GUARD_US * 2);
      }
    }
  });

  it("will not snap onto an edge that an overlapping utterance still covers", () => {
    // Overlapping STT utterances: B starts before A ends. The edge B.start is
    // inside A, so it is NOT a clean target; only A.start (clean) qualifies.
    const overlap: UtteranceSpan[] = [
      { start_us: 0, end_us: 3_000_000 }, // A
      { start_us: 2_500_000, end_us: 6_000_000 }, // B — overlaps A
    ];
    // in at 2_600_000 sits inside both A and B. B.start (2_500_000) and A.end
    // (3_000_000) are each still inside the other utterance, so both are
    // rejected; A.start (0) is the only clean edge but is >700ms away. out sits
    // on B.end (already clean), isolating the in-boundary.
    expect(snapRangeToUtteranceBoundaries(2_600_000, 6_000_000, overlap, 700_000)).toBeNull();
    // Widen tolerance so the clean edge A.start becomes reachable.
    const wide = snapRangeToUtteranceBoundaries(2_600_000, 6_000_000, overlap, 3_000_000);
    expect(wide!.src_in_us).toBe(0); // snapped to the only clean edge, not B.start
    expect(boundaryInsideUtterance(wide!.src_in_us, overlap[0])).toBe(false);
    expect(boundaryInsideUtterance(wide!.src_in_us, overlap[1])).toBe(false);
  });

  it("is deterministic", () => {
    const a = snapRangeToUtteranceBoundaries(5_200_000, 8_100_000, UTTERANCES, TOL);
    const b = snapRangeToUtteranceBoundaries(5_200_000, 8_100_000, UTTERANCES, TOL);
    expect(a).toEqual(b);
  });

  it("snapped boundaries clear the review speech-cut guard", () => {
    // A clip that originally cuts mid-utterance on both ends.
    const inUs = 5_300_000; // inside utterance[1] (5.46M–8.34M)? no — inside [0,5.46M]
    const outUs = 17_000_000; // inside utterance[2] (8.34M–17.4M)
    const before = { in: inUs, out: outUs };
    // The out-point is clearly mid-utterance before snapping.
    expect(UTTERANCES.some((u) => boundaryInsideUtterance(before.out, u))).toBe(true);

    const r = snapRangeToUtteranceBoundaries(inUs, outUs, UTTERANCES, 700_000);
    expect(r).not.toBeNull();
    // After snapping, neither boundary lands inside any utterance.
    expect(UTTERANCES.some((u) => boundaryInsideUtterance(r!.src_in_us, u))).toBe(false);
    expect(UTTERANCES.some((u) => boundaryInsideUtterance(r!.src_out_us, u))).toBe(false);
  });
});

describe("applyUtteranceSnap", () => {
  const utteranceMap = new Map<string, UtteranceSpan[]>([["AST_TALK", UTTERANCES]]);

  it("snaps only clips whose asset has a transcript and records provenance", () => {
    const dialogue = makeClip({ clip_id: "C1", asset_id: "AST_TALK", src_in_us: 5_200_000, src_out_us: 8_100_000 });
    const broll = makeClip({ clip_id: "C2", asset_id: "AST_BROLL", src_in_us: 5_200_000, src_out_us: 8_100_000 });

    const count = applyUtteranceSnap([dialogue, broll], utteranceMap, 700_000, ["utterance_boundary_snapped"]);

    expect(count).toBe(1);
    expect(dialogue.src_in_us).toBe(5_460_000);
    expect(dialogue.src_out_us).toBe(8_340_000);
    const meta = (dialogue.metadata as Record<string, unknown>).talking_head_pacing as Record<string, unknown>;
    expect(meta.snapped_in).toBe(true);
    expect(meta.snapped_out).toBe(true);
    expect(meta.tolerance_us).toBe(700_000);
    expect(meta.tags).toEqual(["utterance_boundary_snapped"]);

    // B-roll with no transcript is untouched.
    expect(broll.src_in_us).toBe(5_200_000);
    expect(broll.metadata).toBeUndefined();
  });

  it("leaves clips untouched when nothing snaps", () => {
    const aligned = makeClip({ src_in_us: 5_460_000, src_out_us: 8_340_000 });
    const count = applyUtteranceSnap([aligned], utteranceMap, 700_000);
    expect(count).toBe(0);
    expect(aligned.metadata).toBeUndefined();
  });
});

describe("talking_head_pacing skill wiring", () => {
  beforeEach(() => clearSkillCache());

  it("loads as an active registry skill (graduated from _deferred)", () => {
    const skill = loadSkills().get("talking_head_pacing");
    expect(skill).toBeDefined();
    expect(skill!.status).toBe("active");
    expect(skill!.effects.utterance_boundary_snap).toBe(true);
  });

  it("getUtteranceSnapConfig returns tolerance + tags when active, null otherwise", () => {
    const active = getUtteranceSnapConfig(["talking_head_pacing"]);
    expect(active).not.toBeNull();
    expect(active!.toleranceUs).toBe(700_000);
    expect(active!.metadataTags).toContain("utterance_boundary_snapped");

    expect(getUtteranceSnapConfig(["axis_hold_dialogue"])).toBeNull();
    expect(getUtteranceSnapConfig([])).toBeNull();
  });

  it("activates when listed in a blueprint's active_editing_skills", () => {
    const blueprint = {
      active_editing_skills: ["talking_head_pacing"],
    } as unknown as EditBlueprint;
    const active = activateSkills(blueprint, [] as Candidate[]);
    expect(active).toContain("talking_head_pacing");
  });
});
