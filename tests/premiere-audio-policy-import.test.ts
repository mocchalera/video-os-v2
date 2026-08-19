import { describe, expect, it } from "vitest";
import type { ClipOutput, TimelineIR } from "../runtime/compiler/types.js";
import { timelineToFcp7Xml } from "../runtime/handoff/fcp7-xml-export.js";
import { resolveAudioGain } from "../editor/shared/audio-gain.js";
import {
  applyDiffs,
  detectDiffs,
  parseFcp7Sequence,
  type ClipDiff,
} from "../runtime/handoff/fcp7-xml-import.js";

function makeClip(overrides: Partial<ClipOutput> = {}): ClipOutput {
  return {
    clip_id: "audio-1",
    segment_id: "segment-1",
    asset_id: "asset-1",
    src_in_us: 0,
    src_out_us: 5_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 120,
    role: "music",
    motivation: "Audio policy test",
    beat_id: "beat-1",
    fallback_segment_ids: [],
    confidence: 0.9,
    quality_flags: [],
    ...overrides,
  };
}

function makeTimeline(audioClip: ClipOutput, videoClip?: ClipOutput): TimelineIR {
  return {
    version: "1.0.0",
    project_id: "PREMIERE_AUDIO_POLICY_TEST",
    created_at: "2026-08-15T00:00:00Z",
    sequence: {
      name: "Premiere audio policy test",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
      timecode_format: "NDF",
    },
    tracks: {
      video: videoClip
        ? [{ track_id: "V1", kind: "video", clips: [videoClip] }]
        : [],
      audio: [{ track_id: "A1", kind: "audio", clips: [audioClip] }],
    },
    markers: [],
    provenance: {
      brief_path: "test/brief.yaml",
      blueprint_path: "test/blueprint.yaml",
      selects_path: "test/selects.yaml",
      compiler_version: "test",
    },
  };
}

function exportAndParse(timeline: TimelineIR) {
  const sourceMap = new Map<string, string>();
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) sourceMap.set(clip.asset_id, `/media/${clip.asset_id}.wav`);
  }
  return parseFcp7Sequence(timelineToFcp7Xml(timeline, { sourceMap }));
}

describe("Premiere audio policy diff/apply", () => {
  it("detects a changed BGM gain with closed policy snapshots", () => {
    const clip = makeClip({ audio_policy: { gain_unit: "db", bgm_gain: -6 } });
    const timeline = makeTimeline(clip);
    const parsed = exportAndParse(timeline);
    parsed.audioTracks[0][0].audioGainLinear = 10 ** (-12 / 20);

    const report = detectDiffs(parsed, timeline);
    const diff = report.diffs.find((item) => item.kind === "audio_policy_changed");

    expect(diff).toEqual({
      kind: "audio_policy_changed",
      clip_id: "audio-1",
      detail: expect.stringContaining("Audio policy changed"),
      original_audio_policy: { gain_unit: "db", bgm_gain: -6 },
      updated_audio_policy: { gain_unit: "db", bgm_gain: -12 },
    });
    expect(diff).not.toHaveProperty("original");
    expect(diff).not.toHaveProperty("updated");
  });

  it("detects a changed natural-sound gain with role-aware conversion", () => {
    const clip = makeClip({
      role: "nat_sound",
      audio_policy: { gain_unit: "db", nat_sound_gain: -3 },
    });
    const timeline = makeTimeline(clip);
    const parsed = exportAndParse(timeline);
    parsed.audioTracks[0][0].audioGainLinear = 10 ** (-9 / 20);

    const diff = detectDiffs(parsed, timeline).diffs.find(
      (item) => item.kind === "audio_policy_changed",
    );

    expect(diff?.updated_audio_policy).toEqual({
      gain_unit: "db",
      nat_sound_gain: -9,
    });
  });

  it("detects exact fade-in and fade-out frame changes", () => {
    const clip = makeClip({
      audio_policy: {
        gain_unit: "db",
        bgm_gain: -6,
        bgm_fade_in_frames: 12,
        bgm_fade_out_frames: 24,
      },
    });
    const timeline = makeTimeline(clip);
    const parsed = exportAndParse(timeline);
    parsed.audioTracks[0][0].fadeInFrames = 18;
    parsed.audioTracks[0][0].fadeOutFrames = 30;

    const diff = detectDiffs(parsed, timeline).diffs.find(
      (item) => item.kind === "audio_policy_changed",
    );

    expect(diff?.updated_audio_policy).toMatchObject({
      bgm_fade_in_frames: 18,
      bgm_fade_out_frames: 30,
    });
  });

  it("does not report unchanged exporter roundtrip audio", () => {
    const clip = makeClip({
      audio_policy: {
        duck_music_db: -12,
        bgm_fade_in_frames: 12,
        bgm_fade_out_frames: 24,
      },
    });
    const timeline = makeTimeline(clip);

    expect(detectDiffs(exportAndParse(timeline), timeline).diffs).toEqual([]);
  });

  it("applies audio policy only to the matching audio clip and preserves other fields", () => {
    const audioClip = makeClip({
      metadata: { keep: "audio metadata" },
      audio_policy: { gain_unit: "db", bgm_gain: -6 },
    });
    const videoClip = makeClip({
      clip_id: "video-1",
      segment_id: "video-segment",
      asset_id: "video-asset",
      role: "hero",
      metadata: { keep: "video metadata" },
    });
    const timeline = makeTimeline(audioClip, videoClip);
    const diff: ClipDiff = {
      kind: "audio_policy_changed",
      clip_id: "audio-1",
      detail: "Audio policy changed",
      original_audio_policy: { gain_unit: "db", bgm_gain: -6 },
      updated_audio_policy: { gain_unit: "db", bgm_gain: -10 },
    };

    const patched = applyDiffs(timeline, [diff]);

    expect(patched.tracks.audio[0].clips[0]).toEqual({
      ...audioClip,
      audio_policy: { gain_unit: "db", bgm_gain: -10 },
    });
    expect(patched.tracks.video[0].clips[0]).toEqual(videoClip);
    expect(timeline.tracks.audio[0].clips[0].audio_policy?.bgm_gain).toBe(-6);
  });

  it("combines trim and audio policy changes on the same clip", () => {
    const clip = makeClip({
      metadata: { preserve: "unrelated audio metadata" },
      audio_policy: { gain_unit: "db", bgm_gain: -6 },
    });
    const videoClip = makeClip({
      clip_id: "video-1",
      segment_id: "video-segment",
      asset_id: "video-asset",
      role: "hero",
    });
    const timeline = makeTimeline(clip, videoClip);
    const parsed = exportAndParse(timeline);
    parsed.audioTracks[0][0].srcInFrame = 24;
    parsed.audioTracks[0][0].srcOutFrame = 96;
    parsed.audioTracks[0][0].timelineEndFrame = 72;
    parsed.audioTracks[0][0].audioGainLinear = 10 ** (-12 / 20);

    const report = detectDiffs(parsed, timeline);
    expect(report.diffs.map((item) => item.kind).sort()).toEqual([
      "audio_policy_changed",
      "trim_changed",
    ]);

    timeline.tracks.overlay = [{ track_id: "O1", kind: "overlay", clips: [] }];
    timeline.tracks.caption = [{ track_id: "C1", kind: "caption", clips: [] }];
    timeline.transitions = [{
      transition_id: "preserved-transition",
      from_clip_id: "video-1",
      to_clip_id: "video-1",
      track_id: "V1",
      transition_type: "crossfade",
      transition_frames: 4,
    }];
    const preserved = {
      video: structuredClone(timeline.tracks.video),
      overlay: structuredClone(timeline.tracks.overlay),
      caption: structuredClone(timeline.tracks.caption),
      transitions: structuredClone(timeline.transitions),
    };

    const patched = applyDiffs(timeline, report.diffs).tracks.audio[0].clips[0];
    expect(patched).toMatchObject({
      src_in_us: 1_000_000,
      src_out_us: 4_000_000,
      timeline_duration_frames: 72,
      audio_policy: { gain_unit: "db", bgm_gain: -12 },
      metadata: { preserve: "unrelated audio metadata" },
    });
    const applied = applyDiffs(timeline, report.diffs);
    expect(applied.tracks.video).toEqual(preserved.video);
    expect(applied.tracks.overlay).toEqual(preserved.overlay);
    expect(applied.tracks.caption).toEqual(preserved.caption);
    expect(applied.transitions).toEqual(preserved.transitions);
  });

  it("does not misclassify audio metadata on a video clip", () => {
    const audioClip = makeClip({ audio_policy: { gain_unit: "db", bgm_gain: -6 } });
    const videoClip = makeClip({
      clip_id: "video-1",
      segment_id: "video-segment",
      asset_id: "video-asset",
      role: "hero",
    });
    const timeline = makeTimeline(audioClip, videoClip);
    const parsed = exportAndParse(timeline);
    parsed.videoTracks[0][0].audioGainLinear = 10 ** (-20 / 20);
    parsed.videoTracks[0][0].fadeInFrames = 20;

    expect(
      detectDiffs(parsed, timeline).diffs.filter(
        (item) => item.kind === "audio_policy_changed" && item.clip_id === "video-1",
      ),
    ).toEqual([]);
  });

  it("preserves a shared linear gain unit and unrelated role gain", () => {
    const clip = makeClip({
      audio_policy: {
        gain_unit: "linear",
        bgm_gain: 0.5,
        nat_sound_gain: 0.75,
      },
    });
    const timeline = makeTimeline(clip);
    const parsed = exportAndParse(timeline);
    parsed.audioTracks[0][0].audioGainLinear = 0.25;

    const diff = detectDiffs(parsed, timeline).diffs.find(
      (item) => item.kind === "audio_policy_changed",
    );
    expect(diff?.updated_audio_policy).toEqual({
      gain_unit: "linear",
      bgm_gain: 0.25,
      nat_sound_gain: 0.75,
    });

    const appliedPolicy = applyDiffs(timeline, diff ? [diff] : [])
      .tracks.audio[0].clips[0].audio_policy;
    expect(resolveAudioGain(appliedPolicy, "bgm").gainLinear).toBeCloseTo(0.25, 8);
    expect(resolveAudioGain(appliedPolicy, "nat_sound").gainLinear).toBeCloseTo(0.75, 8);
  });

  it("normalizes a unitless legacy policy before applying XML mute", () => {
    const clip = makeClip({
      audio_policy: {
        bgm_gain: 0.5,
        nat_sound_gain: 0.75,
      },
    });
    const timeline = makeTimeline(clip);
    const unrelatedGainBefore = resolveAudioGain(clip.audio_policy, "nat_sound").gainLinear;
    const parsed = exportAndParse(timeline);
    parsed.audioTracks[0][0].audioGainLinear = 0;

    const diff = detectDiffs(parsed, timeline).diffs.find(
      (item) => item.kind === "audio_policy_changed",
    );
    const updatedPolicy = diff?.updated_audio_policy;

    expect(updatedPolicy?.gain_unit).toBe("db");
    expect(resolveAudioGain(updatedPolicy, "bgm").gainDb).toBe(-96);
    expect(resolveAudioGain(updatedPolicy, "nat_sound").gainLinear).toBeCloseTo(
      unrelatedGainBefore,
      8,
    );
  });

  it("does not diff an exporter-clamped oversize fade-out", () => {
    const clip = makeClip({
      timeline_duration_frames: 20,
      audio_policy: {
        gain_unit: "db",
        bgm_gain: -6,
        bgm_fade_out_frames: 50,
      },
    });
    const timeline = makeTimeline(clip);

    const parsed = exportAndParse(timeline);
    expect(parsed.audioTracks[0][0].fadeOutFrames).toBe(20);
    expect(detectDiffs(parsed, timeline).diffs).toEqual([]);
  });

  it("does not diff proportionally clamped overlapping fades", () => {
    const clip = makeClip({
      timeline_duration_frames: 30,
      audio_policy: {
        gain_unit: "db",
        bgm_gain: -6,
        bgm_fade_in_frames: 20,
        bgm_fade_out_frames: 20,
      },
    });
    const timeline = makeTimeline(clip);

    const parsed = exportAndParse(timeline);
    expect(parsed.audioTracks[0][0].fadeInFrames).toBe(15);
    expect(parsed.audioTracks[0][0].fadeOutFrames).toBe(15);
    expect(detectDiffs(parsed, timeline).diffs).toEqual([]);
  });

  it("detects and applies deletion of one existing fade", () => {
    const clip = makeClip({
      audio_policy: {
        gain_unit: "db",
        bgm_gain: -6,
        bgm_fade_in_frames: 12,
        bgm_fade_out_frames: 24,
      },
    });
    const timeline = makeTimeline(clip);
    const parsed = exportAndParse(timeline);
    parsed.audioTracks[0][0].fadeInFrames = undefined;

    const diff = detectDiffs(parsed, timeline).diffs.find(
      (item) => item.kind === "audio_policy_changed",
    );
    expect(diff?.original_audio_policy).toHaveProperty("bgm_fade_in_frames", 12);
    expect(diff?.updated_audio_policy).not.toHaveProperty("bgm_fade_in_frames");
    expect(diff?.updated_audio_policy).toHaveProperty("bgm_fade_out_frames", 24);

    const appliedPolicy = applyDiffs(timeline, diff ? [diff] : [])
      .tracks.audio[0].clips[0].audio_policy;
    expect(appliedPolicy).not.toHaveProperty("bgm_fade_in_frames");
    expect(appliedPolicy).toHaveProperty("bgm_fade_out_frames", 24);
  });
});
