import { describe, expect, it } from "vitest";
import {
  buildAudioFinishApplyFilter,
  buildAudioFinishMeasurementFilter,
  resolveAudioFinishPolicy,
} from "../runtime/audio/dialogue-finishing.js";
import { applyPatch, type ReviewPatch } from "../runtime/compiler/patch.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

describe("interview dialogue finishing", () => {
  it("builds the dialogue-clean measurement and measured apply chains", () => {
    const policy = resolveAudioFinishPolicy({ preset: "dialogue-clean" })!;
    const measurement = buildAudioFinishMeasurementFilter(policy);
    const apply = buildAudioFinishApplyFilter(policy, {
      input_i: "-33.37",
      input_tp: "-13.77",
      input_lra: "6.90",
      input_thresh: "-44.07",
      target_offset: "-0.27",
    });

    expect(measurement).toContain("highpass=f=70:p=2");
    expect(measurement).toContain("afftdn=nr=8:nf=-50:tn=1");
    expect(measurement).toContain("acompressor=");
    expect(measurement).toContain("loudnorm=I=-16:LRA=7:TP=-1.8:print_format=json");
    expect(apply).toContain("measured_I=-33.37");
    expect(apply).toContain("measured_TP=-13.77");
    expect(apply).toContain("offset=-0.27:linear=true");
  });

  it("keeps the loudness-only preset free of cleanup and compression", () => {
    const policy = resolveAudioFinishPolicy({
      preset: "loudness-only",
      loudness_target_lufs: -14,
      true_peak_target_dbtp: -2,
    })!;
    const filter = buildAudioFinishMeasurementFilter(policy);

    expect(filter).toBe("loudnorm=I=-14:LRA=7:TP=-2:print_format=json");
    expect(filter).not.toContain("afftdn");
    expect(filter).not.toContain("acompressor");
  });

  it("applies visual transform and global audio finish through review patch", () => {
    const timeline = makeTimeline();
    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        {
          op: "change_visual_transform",
          target_clip_id: "V1_1",
          visual_transform: {
            zoom: 1.15,
            position: { x: -144, y: -39 },
          },
          reason: "larger balanced interview portrait",
          confidence: 0.95,
        },
        {
          op: "change_audio_finish",
          audio_finish: {
            preset: "dialogue-clean",
            loudness_target_lufs: -16,
          },
          reason: "make dialogue easier to hear",
        },
      ],
    };

    const result = applyPatch(timeline, patch, [], 120);

    expect(result.errors).toEqual([]);
    expect(result.appliedOps).toBe(2);
    expect(result.timeline.tracks.video[0].clips[0].metadata).toMatchObject({
      zoom: 1.15,
      position: { x: -144, y: -39 },
      interview_finish: {
        reason: "larger balanced interview portrait",
        confidence: 0.95,
      },
    });
    expect(result.timeline.metadata?.audio_finish).toEqual({
      preset: "dialogue-clean",
      loudness_target_lufs: -16,
    });
  });

  it("rejects visual transforms on audio-only clips", () => {
    const result = applyPatch(makeTimeline(), {
      timeline_version: "1",
      operations: [{
        op: "change_visual_transform",
        target_clip_id: "A1_1",
        visual_transform: { zoom: 1.1 },
        reason: "invalid target",
      }],
    }, [], 120);

    expect(result.appliedOps).toBe(0);
    expect(result.errors[0]?.message).toBe("Visual transforms require a video clip");
  });
});

function makeTimeline(): TimelineIR {
  const clip = {
    clip_id: "V1_1",
    segment_id: "SEG_1",
    asset_id: "AST_1",
    src_in_us: 0,
    src_out_us: 5_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 120,
    role: "dialogue",
    motivation: "interview",
    beat_id: "B1",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  };
  return {
    version: "1",
    project_id: "interview-finish-test",
    created_at: "2026-07-15T00:00:00Z",
    sequence: {
      name: "Interview finish",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [clip] }],
      audio: [{
        track_id: "A1",
        kind: "audio",
        clips: [{ ...clip, clip_id: "A1_1", role: "nat_sound" }],
      }],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}
