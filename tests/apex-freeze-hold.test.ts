import { describe, expect, it } from "vitest";
import {
  applyApexFreezeHolds,
  materializeCandidatePlanFreezeHolds,
} from "../runtime/compiler/apex-freeze-hold.js";
import { assertSameSourceTalkCutsSynchronized } from "../runtime/compiler/av-sync.js";
import { buildTimelineIR } from "../runtime/compiler/export.js";
import type { AssembledTimeline, Candidate, EditBlueprint, TimelineClip } from "../runtime/compiler/types.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import { getApexFreezeHoldConfig } from "../runtime/editorial/skill-registry.js";
import {
  buildAudioTrimArgs,
  buildVideoTrimArgs,
  getTimelineDurationFrames,
} from "../runtime/render/assembler.js";

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    clip_id: "V_FREEZE",
    segment_id: "SEG_FREEZE",
    asset_id: "AST_FREEZE",
    src_in_us: 0,
    src_out_us: 2_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 60,
    role: "dialogue",
    motivation: "authored apex",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    media_kind: "video",
    source_capabilities: { has_video: true, has_audio: true },
    candidate_ref: "CAND_FREEZE",
    ...overrides,
  };
}

const candidate: Candidate = {
  segment_id: "SEG_FREEZE",
  candidate_id: "CAND_FREEZE",
  asset_id: "AST_FREEZE",
  src_in_us: 0,
  src_out_us: 2_000_000,
  role: "dialogue",
  why_it_matches: "authored apex",
  risks: [],
  confidence: 1,
  media_kind: "video",
  source_capabilities: { has_video: true, has_audio: true },
  freeze_frame_hold: { source_time_us: 1_000_000 },
};

describe("apex freeze hold", () => {
  it("resolves provisional fps-based defaults, ripples total duration, and keeps same-source A/V synchronized", () => {
    const video = clip();
    const audio = clip({ clip_id: "A_FREEZE", role: "nat_sound", motivation: "original clip audio" });
    const after = clip({
      clip_id: "V_AFTER",
      segment_id: "SEG_AFTER",
      asset_id: "AST_AFTER",
      candidate_ref: "CAND_AFTER",
      src_in_us: 2_000_000,
      src_out_us: 4_000_000,
      timeline_in_frame: 60,
      beat_id: "b02",
    });
    const bgm = clip({
      clip_id: "A_BGM",
      segment_id: "SEG_BGM",
      asset_id: "AST_BGM",
      candidate_ref: undefined,
      src_out_us: 4_000_000,
      timeline_duration_frames: 120,
      role: "bgm",
      motivation: "background music bed",
    });
    const assembled: AssembledTimeline = {
      tracks: {
        video: [{ track_id: "V1", kind: "video", clips: [video, after] }],
        audio: [
          { track_id: "A1", kind: "audio", clips: [audio] },
          { track_id: "A2", kind: "audio", clips: [bgm] },
        ],
      },
      markers: [
        { frame: 0, kind: "beat", label: "b01: Apex" },
        { frame: 60, kind: "beat", label: "b02: After" },
      ],
    };
    const config = getApexFreezeHoldConfig(["apex_freeze_hold"], 30, 1)!;

    expect(config).toEqual({
      policy: "apex-freeze-hold/v1",
      minHoldFrames: 30,
      defaultHoldFrames: 33,
      maxHoldFrames: 36,
    });
    expect(applyApexFreezeHolds(assembled, [candidate], config)).toEqual({
      applied_clip_ids: ["A_FREEZE", "V_FREEZE"],
      total_added_frames: 33,
    });
    expect(video.timeline_duration_frames).toBe(93);
    expect(audio.timeline_duration_frames).toBe(93);
    expect(after.timeline_in_frame).toBe(93);
    expect(bgm.timeline_duration_frames).toBe(153);
    expect(assembled.markers[1].frame).toBe(93);
    expect(getTimelineDurationFrames(buildTimelineIR(assembled, {
      projectId: "freeze-test",
      projectTitle: "Freeze Test",
      projectPath: ".",
      createdAt: "2026-08-20T00:00:00.000Z",
      briefRelPath: "01_intent/creative_brief.yaml",
      blueprintRelPath: "04_plan/edit_blueprint.yaml",
      selectsRelPath: "04_plan/selects_candidates.yaml",
      fpsNum: 30,
      fpsDen: 1,
    }))).toBe(153);
    expect(() => assertSameSourceTalkCutsSynchronized(assembled)).not.toThrow();
  });

  it("exports schema-valid authored hold metadata and builds video/audio hold filtergraphs", () => {
    const assembled: AssembledTimeline = {
      tracks: {
        video: [{ track_id: "V1", kind: "video", clips: [clip()] }],
        audio: [{ track_id: "A1", kind: "audio", clips: [clip({ clip_id: "A_FREEZE", role: "nat_sound", motivation: "original clip audio" })] }],
      },
      markers: [],
    };
    applyApexFreezeHolds(
      assembled,
      [{ ...candidate, freeze_frame_hold: { source_time_us: 1_000_000, hold_frames: 36 } }],
      getApexFreezeHoldConfig(["apex_freeze_hold"], 30, 1),
    );
    const timeline = buildTimelineIR(assembled, {
      projectId: "freeze-test",
      projectTitle: "Freeze Test",
      projectPath: ".",
      createdAt: "2026-08-20T00:00:00.000Z",
      briefRelPath: "01_intent/creative_brief.yaml",
      blueprintRelPath: "04_plan/edit_blueprint.yaml",
      selectsRelPath: "04_plan/selects_candidates.yaml",
      fpsNum: 30,
      fpsDen: 1,
    });
    const roundTrip = JSON.parse(JSON.stringify(timeline)) as typeof timeline;

    expect(roundTrip.tracks.video[0].clips[0].freeze_frame_hold).toMatchObject({
      source_time_us: 1_000_000,
      hold_frames: 36,
      hold_source: "candidate_override",
      policy: "apex-freeze-hold/v1",
    });
    expect(() => validateArtifact(roundTrip, "timeline-ir.schema.json")).not.toThrow();

    const videoArgs = buildVideoTrimArgs(
      "/tmp/source.mov", "/tmp/video.mp4", 0, 2, 1080, 1920, 30,
      undefined, undefined, 3.2, "30/1", 96,
      { sourceTimeSec: 1, holdFrames: 36 },
    );
    expect(videoArgs[videoArgs.indexOf("-vf") + 1]).toContain("loop=loop=36:size=1:start=30");

    const audioArgs = buildAudioTrimArgs(
      "/tmp/source.mov", "/tmp/audio.wav", 0, 2, 48_000, 2,
      undefined, undefined, 30, "nat", undefined,
      { sourceTimeSec: 1, holdFrames: 36, timelineDurationSec: 3.2 },
    );
    const graph = audioArgs[audioArgs.indexOf("-filter_complex") + 1];
    expect(graph).toContain("anullsrc=r=48000:cl=stereo:d=1.2");
    expect(graph).toContain("concat=n=3:v=0:a=1");
  });

  it("scopes candidate-plan authorship to its beat when a candidate is reused", () => {
    const unannotated = { ...candidate, freeze_frame_hold: undefined };
    const planHolds = materializeCandidatePlanFreezeHolds({
      beats: [{
        id: "b01",
        label: "apex",
        purpose: "hold only this placement",
        target_duration_frames: 60,
        required_roles: ["dialogue"],
        candidate_plan: {
          primary_candidate_ref: "CAND_FREEZE",
          freeze_frame_hold: { source_time_us: 1_000_000 },
        },
        craft: {},
      }],
    } satisfies Pick<EditBlueprint, "beats">, [unannotated]);
    const first = clip();
    const reused = clip({ clip_id: "V_REUSED", timeline_in_frame: 60, beat_id: "b02" });
    const assembled: AssembledTimeline = {
      tracks: { video: [{ track_id: "V1", kind: "video", clips: [first, reused] }], audio: [] },
      markers: [],
    };

    applyApexFreezeHolds(
      assembled,
      [unannotated],
      getApexFreezeHoldConfig(["apex_freeze_hold"], 30, 1),
      planHolds,
    );

    expect(first.freeze_frame_hold?.hold_frames).toBe(33);
    expect(reused.freeze_frame_hold).toBeUndefined();
    expect(reused.timeline_in_frame).toBe(93);
    expect(unannotated.freeze_frame_hold).toBeUndefined();
  });
});
