import { describe, expect, it } from "vitest";
import type { TimelineIR } from "../runtime/compiler/types.js";
import type { AudioEventsArtifact } from "../runtime/artifacts/audio-events.js";
import {
  evaluateSpeechCadenceQA,
} from "../runtime/review/speech-cadence-qa.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

function socialBrief(): unknown {
  return {
    project: { format: "social_vertical", runtime_target_sec: 45 },
    editorial: {
      distribution_channel: "shorts",
      aspect_ratio: "9:16",
      hook_priority: "aggressive",
    },
    must_have: ["冒頭0〜2秒で結論を先出し"],
  };
}

function timeline(
  metadata: Record<string, unknown> = {},
): TimelineIR {
  const clip = {
    clip_id: "CLIP_001",
    segment_id: "SEG_001",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 3_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 90,
    role: "dialogue",
    motivation: "speech",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    metadata,
  };
  return {
    version: "1",
    project_id: "cadence-fixture",
    created_at: "2026-07-25T00:00:00Z",
    sequence: {
      fps_num: 30_000,
      fps_den: 1_001,
      width: 1080,
      height: 1920,
      pixel_aspect: "1:1",
      audio_sample_rate_hz: 48_000,
      channel_layout: "stereo",
      start_timecode: "00:00:00:00",
      drop_frame: false,
      letterbox_policy: "none",
    },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [clip] }],
      audio: [{ track_id: "A1", kind: "audio", clips: [structuredClone(clip)] }],
    },
    transitions: [],
    markers: [],
    provenance: {},
  } as unknown as TimelineIR;
}

function events(
  ranges: Array<[string, number, number]>,
): AudioEventsArtifact {
  return {
    project_id: "cadence-fixture",
    artifact_version: "analysis-v1",
    items: ranges.map(([eventID, startUs, endUs]) => ({
      event_id: eventID,
      asset_id: "AST_001",
      type: "silence",
      start_us: startUs,
      end_us: endUs,
      label: "ffmpeg silencedetect interval",
      confidence: {
        score: 1,
        source: "ffmpeg_silencedetect",
        status: "ready",
      },
      provenance: {
        stage: "audio_events",
        method: "ffmpeg_silencedetect",
        connector_version: "test",
        policy_hash: "test",
        request_hash: "test",
      },
    })),
  };
}

describe("waveform-grounded social speech cadence QA", () => {
  it("maps excessive source silence to exact rational timeline review ranges", () => {
    const inputTimeline = timeline();
    const before = structuredClone(inputTimeline);
    const first = evaluateSpeechCadenceQA({
      timeline: inputTimeline,
      brief: socialBrief(),
      audioEvents: events([
        ["AE_HEAD", 0, 400_000],
        ["AE_INTERNAL", 1_000_000, 1_800_000],
        ["AE_TAIL", 2_500_000, 3_000_000],
      ]),
    });
    const second = evaluateSpeechCadenceQA({
      timeline: structuredClone(inputTimeline),
      brief: socialBrief(),
      audioEvents: events([
        ["AE_HEAD", 0, 400_000],
        ["AE_INTERNAL", 1_000_000, 1_800_000],
        ["AE_TAIL", 2_500_000, 3_000_000],
      ]),
    });

    expect(inputTimeline).toEqual(before);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: "speech-cadence-qa/v1",
      status: "review_required",
      mode: "aggressive",
      checked_clip_count: 1,
      thresholds: {
        head_silence_max_ms: 350,
        internal_silence_max_ms: 600,
        tail_silence_max_ms: 350,
      },
    });
    expect(first.review_items.map((item) => item.code)).toEqual([
      "excessive_head_silence",
      "excessive_internal_silence",
      "excessive_tail_silence",
    ]);
    expect(first.review_items).toEqual([
      expect.objectContaining({
        issue_id: expect.stringMatching(/^CADENCEQA_[A-F0-9]{16}$/),
        clip_id: "CLIP_001",
        silence_event_id: "AE_HEAD",
        source_start_us: 0,
        source_end_us: 400_000,
        timeline_start_frame: 0,
        timeline_end_frame: 12,
        start_timecode: "00:00:00.000",
        end_timecode: "00:00:00.400",
        duration_ms: 400,
        suggested_action: "trim_in",
        title_ja: "発話前の間が長い",
      }),
      expect.objectContaining({
        silence_event_id: "AE_INTERNAL",
        timeline_start_frame: 30,
        timeline_end_frame: 54,
        start_timecode: "00:00:01.001",
        end_timecode: "00:00:01.802",
        duration_ms: 801,
        suggested_action: "jump_cut",
      }),
      expect.objectContaining({
        silence_event_id: "AE_TAIL",
        timeline_start_frame: 75,
        timeline_end_frame: 90,
        start_timecode: "00:00:02.503",
        end_timecode: "00:00:03.003",
        duration_ms: 501,
        suggested_action: "trim_out",
      }),
    ]);
  });

  it("does not flag the exact tail range retained by canonical cut-breath treatment", () => {
    const result = evaluateSpeechCadenceQA({
      timeline: timeline({
        cut_breath_treatment: {
          extended_frames: 15,
          audio_fade_out_frames: 5,
          next_speech_intrusion: false,
          clamped_before_next_speech: false,
        },
      }),
      brief: socialBrief(),
      audioEvents: events([["AE_TAIL", 2_500_000, 3_000_000]]),
    });

    expect(result).toMatchObject({
      status: "verified",
      intentional_hold_count: 1,
      review_items: [],
    });
  });

  it("reports missing waveform evidence as incomplete and skips non-social work", () => {
    expect(evaluateSpeechCadenceQA({
      timeline: timeline(),
      brief: socialBrief(),
    })).toMatchObject({
      status: "incomplete",
      review_items: [],
      reason: expect.stringContaining("audio_events"),
    });

    expect(evaluateSpeechCadenceQA({
      timeline: timeline(),
      brief: {
        project: { format: "lecture", runtime_target_sec: 600 },
        editorial: { distribution_channel: "presentation" },
      },
    })).toMatchObject({
      status: "not_applicable",
      mode: "off",
      review_items: [],
    });
  });

  it("is accepted by the package QA schema as a review-only metric", () => {
    const result = evaluateSpeechCadenceQA({
      timeline: timeline(),
      brief: socialBrief(),
      audioEvents: events([]),
    });
    expect(validateAgainstSchema({
      version: "1.0.0",
      project_id: "cadence-fixture",
      source_of_truth: "engine_render",
      qa_profile: "engine_render",
      passed: true,
      checks: [],
      metrics: { speech_cadence_qa: result },
      artifacts: {},
    }, "package-qa-report.schema.json")).toEqual({
      valid: true,
      errors: [],
    });
  });
});
