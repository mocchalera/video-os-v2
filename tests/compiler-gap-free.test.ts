import { describe, expect, it } from "vitest";
import { buildTimelineIR } from "../runtime/compiler/export.js";
import { findPrimaryAudioGaps, findPrimaryVideoGaps, validatePrimaryAudioMixPolicy } from "../runtime/compiler/coverage.js";
import { GapFreeTimelineError, PrimaryAudioGapError } from "../runtime/compiler/errors.js";
import type { AssembledTimeline, TimelineClip } from "../runtime/compiler/types.js";

function clip(
  clipId: string,
  beatId: string,
  timelineInFrame: number,
  timelineDurationFrames: number,
): TimelineClip {
  return {
    clip_id: clipId,
    segment_id: `SEG_${clipId}`,
    asset_id: `AST_${clipId}`,
    src_in_us: 0,
    src_out_us: timelineDurationFrames * 1_000_000 / 30,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: timelineDurationFrames,
    role: "hero",
    motivation: "gap fixture",
    beat_id: beatId,
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  };
}

function audioClip(
  clipId: string,
  beatId: string,
  timelineInFrame: number,
  timelineDurationFrames: number,
  role: TimelineClip["role"] = "nat_sound",
): TimelineClip {
  return {
    ...clip(clipId, beatId, timelineInFrame, timelineDurationFrames),
    role,
    motivation: role === "nat_sound" ? "original clip audio" : "authored program audio",
  };
}

function timeline(): AssembledTimeline {
  return {
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [
          clip("CLP_PREV", "b01", 0, 100),
          clip("CLP_NEXT", "b02", 165, 1_485),
        ],
      }],
      audio: [],
    },
    markers: [],
    operations: [],
  };
}

/** Visual program with continuous V1 but a mirrored A1 hole in [100, 165). */
function mixedProgramTimeline(): AssembledTimeline {
  const input = timeline();
  input.tracks.video[0].clips = [
    clip("CLP_A", "b01", 0, 100),
    clip("CLP_B", "b02", 100, 100),
    clip("CLP_C", "b03", 200, 100),
  ];
  input.tracks.audio = [{
    track_id: "A1",
    kind: "audio",
    clips: [
      audioClip("ACL_A", "b01", 0, 100),
      // CLP_B is a silent source: no mirror exists over [100, 200).
      audioClip("ACL_C", "b03", 200, 100),
    ],
  }];
  return input;
}

describe("primary video gap-free invariant", () => {
  it("returns the 65-frame internal gap with neighboring clips and beats", () => {
    const gaps = findPrimaryVideoGaps(timeline(), 1_650);
    expect(gaps).toEqual([expect.objectContaining({
      track_id: "V1",
      start_frame: 100,
      end_frame: 165,
      duration_frames: 65,
      previous_clip: expect.objectContaining({ clip_id: "CLP_PREV", beat_id: "b01" }),
      next_clip: expect.objectContaining({ clip_id: "CLP_NEXT", beat_id: "b02" }),
      recommended_fix: expect.stringContaining("approved clip"),
    })]);
    expect(() => { throw new GapFreeTimelineError(gaps); }).toThrow(
      /V1 frames 100-165 duration=65f previous=CLP_PREV next=CLP_NEXT beats=b01 -> b02/,
    );
  });

  it("accepts only an explicit authority-bearing operation for an intentional gap", () => {
    const input = timeline();
    input.operations = [{
      operation_id: "OP_SILENCE_001",
      type: "gap",
      track_id: "V1",
      start_frame: 100,
      duration_frames: 65,
      authority: "operator",
      reason: "intentional room-tone pause before the closing beat",
    }];
    expect(findPrimaryVideoGaps(input, 1_650)).toEqual([]);

    const output = buildTimelineIR(input, {
      projectId: "gap-fixture",
      projectTitle: "Gap fixture",
      projectPath: ".",
      createdAt: "2026-08-21T00:00:00Z",
      briefRelPath: "01_intent/creative_brief.yaml",
      blueprintRelPath: "04_plan/edit_blueprint.yaml",
      selectsRelPath: "04_plan/selects_candidates.yaml",
    });
    expect(output.metadata?.timeline_operations).toEqual(input.operations);
  });
});

describe("primary audio gap-free invariant", () => {
  it("returns the silent interval under picture with neighbors, beats, and an audio-specific fix", () => {
    const gaps = findPrimaryAudioGaps(mixedProgramTimeline(), 300);
    expect(gaps).toEqual([expect.objectContaining({
      track_id: "A1",
      start_frame: 100,
      end_frame: 200,
      duration_frames: 100,
      previous_clip: expect.objectContaining({ clip_id: "ACL_A", beat_id: "b01" }),
      next_clip: expect.objectContaining({ clip_id: "ACL_C", beat_id: "b03" }),
      previous_beat_id: "b01",
      next_beat_id: "b03",
      recommended_fix: expect.stringContaining("silence/ambient-continuation"),
    })]);
    expect(() => { throw new PrimaryAudioGapError(gaps); }).toThrow(
      /A1 frames 100-200 duration=100f previous=ACL_A next=ACL_C beats=b01 -> b03/,
    );
    expect(new PrimaryAudioGapError(gaps).code).toBe("PRIMARY_AUDIO_GAP");
  });

  it("exempts only an explicit authority-bearing operation on the primary audio track", () => {
    const authorized = mixedProgramTimeline();
    authorized.operations = [{
      operation_id: "OP_AUDIO_SILENCE_001",
      type: "ambient_continuation",
      track_id: "A1",
      start_frame: 100,
      duration_frames: 100,
      authority: "human_golden_order",
      reason: "room tone continues under the intentional picture hold",
    }];
    expect(findPrimaryAudioGaps(authorized, 300)).toEqual([]);

    // A valid operation on a different track does not authorize the A1 hole.
    const wrongTrack = mixedProgramTimeline();
    wrongTrack.operations = [{ ...authorized.operations[0], operation_id: "OP_V2", track_id: "V2" }];
    expect(findPrimaryAudioGaps(wrongTrack, 300)).toHaveLength(1);
  });

  it("treats the union of authored lanes as the program when there is no picture", () => {
    const audioLed: AssembledTimeline = {
      tracks: {
        video: [],
        audio: [
          { track_id: "A1", kind: "audio", clips: [audioClip("ACL_VO", "b01", 0, 50, "dialogue")] },
          { track_id: "A2", kind: "audio", clips: [] },
          { track_id: "A3", kind: "audio", clips: [audioClip("ACL_ROOM", "b02", 150, 150, "texture")] },
        ],
      },
      markers: [],
      operations: [],
    };
    const gaps = findPrimaryAudioGaps(audioLed, 300);
    expect(gaps).toEqual([expect.objectContaining({
      track_id: "A1",
      start_frame: 50,
      end_frame: 150,
      duration_frames: 100,
    })]);

    // Continuous authored coverage across lanes leaves no gap.
    audioLed.tracks.audio[2]!.clips = [audioClip("ACL_MUSIC", "b01", 50, 250, "support")];
    expect(findPrimaryAudioGaps(audioLed, 300)).toEqual([]);
  });

  it("does not invent a primary lane for timelines that declare no audio tracks", () => {
    expect(findPrimaryAudioGaps(timeline(), 1_650)).toEqual([]);
  });

  it("validates the explicit primary-audio mix policy fail-closed", () => {
    expect(validatePrimaryAudioMixPolicy({
      policy: "primary-audio-mix/v1",
      mode: "selective_authorization",
      authority: "operator",
      reason: "music bed carries the program audio",
    }).valid).toBe(true);

    const invalid = validatePrimaryAudioMixPolicy({
      policy: "primary-audio-mix/v1",
      mode: "selective_authorization",
      authority: "operator",
      reason: " ",
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toContain("reason must be non-empty");

    expect(validatePrimaryAudioMixPolicy({
      policy: "primary-audio-mix/v1",
      mode: "wall_to_wall" as never,
      authority: "operator",
      reason: "wrong mode",
    }).valid).toBe(false);
  });
});
