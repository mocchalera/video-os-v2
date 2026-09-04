import { describe, expect, it } from "vitest";
import { buildLyricMvTimelineMetadata, DEFAULT_LYRIC_MV_THRESHOLDS } from "../runtime/compiler/lyric-mv.js";
import {
  evaluateLyricMvCadence,
  type LyricMvCadenceComponent,
} from "../runtime/review/lyric-mv-cadence.js";
import {
  computeReviewMetrics,
  type ReviewMetricsInputs,
} from "../runtime/review/metrics.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import type {
  CreativeBrief,
  EditBlueprint,
  StillImageTimelineMetadata,
  TimelineClip,
  TimelineIR,
} from "../runtime/compiler/types.js";
import type { BgmAnalysis } from "../runtime/compiler/transition-types.js";

function still(
  durationFrames: number,
  overrides: Partial<StillImageTimelineMetadata> = {},
): StillImageTimelineMetadata {
  return {
    hold_frames: durationFrames,
    min_hold_frames: 48,
    max_hold_frames: 960,
    hold_source: "candidate_override",
    policy_clamp: "none",
    source_still_id: "still-a",
    still_instance_id: `instance-${durationFrames}`,
    reuse: "unique",
    motion_mode: "static",
    fit_mode: "cover",
    background: "black",
    ...overrides,
  };
}

function clip(
  clipId: string,
  startFrame: number,
  durationFrames: number,
  overrides: Partial<TimelineClip> = {},
): TimelineClip {
  return {
    clip_id: clipId,
    segment_id: `${clipId}-SEG`,
    asset_id: "asset-still-a",
    src_in_us: 0,
    src_out_us: 1,
    timeline_in_frame: startFrame,
    timeline_duration_frames: durationFrames,
    role: "hero",
    motivation: "Issue 43 M2 fixture",
    beat_id: clipId,
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    media_kind: "image",
    still_image: still(durationFrames, { still_instance_id: `${clipId}-instance` }),
    ...overrides,
  };
}

function lyricTimeline(): TimelineIR {
  const clips = [
    clip("C1", 0, 48),
    clip("C2", 48, 48, {
      still_image: still(48, {
        still_instance_id: "instance-c2",
        motion_mode: "camera_motion",
        camera_motion: {
          preset: "push_in",
          easing: "linear",
          intensity: 0.1,
          frame_count: 48,
          policy: "still-camera-motion/v1",
        },
      }),
      captions: [{ text: "first line", in_frame: 52, out_frame: 80, style: "simple-shadow" }],
    }),
    clip("C3", 96, 384, {
      still_image: still(384, {
        still_instance_id: "instance-c3-long",
        hold: {
          unit: "section_boundary",
          section_id: "S2",
          boundary: "end",
          reason: "hold the chorus image through its section landing",
        },
        hold_resolution: {
          unit: "section_boundary",
          requested_frames: 384,
          resolved_frames: 384,
          section_id: "S2",
          boundary: "end",
          boundary_frame: 480,
          status: "resolved",
        },
      }),
    }),
    clip("C4", 480, 48, {
      captions: [{ text: "second line", in_frame: 490, out_frame: 515, style: "simple-shadow" }],
    }),
    clip("C5", 528, 48, {
      still_image: still(48, {
        still_instance_id: "instance-c5",
        motion_mode: "camera_motion",
        parallax: { amount: 0.03, axis: "horizontal" },
      }),
    }),
    clip("C6", 576, 48, {
      still_image: still(48, { still_instance_id: "instance-c6" }),
    }),
  ];
  return {
    version: "1",
    project_id: "issue43-m2",
    created_at: "2026-09-01T00:00:00.000Z",
    sequence: { name: "Issue 43 lyric MV", fps_num: 24, fps_den: 1, width: 1080, height: 1920, start_frame: 0 },
    tracks: { video: [{ track_id: "V1", kind: "video", clips }], audio: [] },
    markers: [],
    transitions: [
      { transition_id: "T1", from_clip_id: "C1", to_clip_id: "C2", track_id: "V1", transition_type: "crossfade", transition_frames: 4 },
      { transition_id: "T2", from_clip_id: "C2", to_clip_id: "C3", track_id: "V1", transition_type: "crossfade", transition_frames: 4 },
      { transition_id: "T3", from_clip_id: "C3", to_clip_id: "C4", track_id: "V1", transition_type: "crossfade", transition_frames: 4 },
      { transition_id: "T4", from_clip_id: "C4", to_clip_id: "C5", track_id: "V1", transition_type: "crossfade", transition_frames: 4 },
      { transition_id: "T5", from_clip_id: "C5", to_clip_id: "C6", track_id: "V1", transition_type: "crossfade", transition_frames: 4 },
    ],
    metadata: {
      lyric_mv: {
        version: "lyric-mv/v1",
        profile_id: "lyric_mv",
        thresholds: DEFAULT_LYRIC_MV_THRESHOLDS,
        music_sections: [
          { id: "S1", label: "verse", start_frame: 0, end_frame: 96, evidence_classification: "measured" },
          { id: "S2", label: "chorus", start_frame: 96, end_frame: 480, evidence_classification: "measured" },
          { id: "S3", label: "outro", start_frame: 480, end_frame: 624, evidence_classification: "measured" },
        ],
        music_events: [
          { kind: "section_start", frame: 0, section_id: "S1", provenance: "fixture section" },
          { kind: "onset", frame: 48, section_id: "S1", provenance: "fixture onset" },
          { kind: "section_start", frame: 96, section_id: "S2", provenance: "fixture section" },
          { kind: "onset", frame: 192, section_id: "S2", provenance: "fixture onset" },
          { kind: "onset", frame: 288, section_id: "S2", provenance: "fixture onset" },
          { kind: "onset", frame: 384, section_id: "S2", provenance: "fixture onset" },
          { kind: "section_start", frame: 480, section_id: "S3", provenance: "fixture section" },
          { kind: "onset", frame: 528, section_id: "S3", provenance: "fixture onset" },
          { kind: "onset", frame: 576, section_id: "S3", provenance: "fixture onset" },
        ],
      },
    },
    provenance: { brief_path: "brief.yaml", blueprint_path: "blueprint.yaml", selects_path: "selects.yaml", compiler_version: "test" },
  };
}

describe("Issue #43 M2 composite lyric_mv cadence", () => {
  it("reports each cadence component, static regions, and an intentional section-boundary hold", () => {
    const report = evaluateLyricMvCadence(lyricTimeline());

    expect(report.status).toBe("warn");
    expect(report.composite.gaps_over_max).toEqual([]);
    expect(report.composite.event_frames).toContain(480);
    expect(report.long_holds).toEqual([expect.objectContaining({
      clip_id: "C3",
      duration_frames: 384,
      section_id: "S2",
      status: "intentional",
    })]);
    for (const component of [
      "background_cut",
      "caption_cue",
      "in_frame_motion",
      "music_section",
      "music_onset",
      "transition",
    ] as LyricMvCadenceComponent[]) {
      expect(report.component_breakdown[component].event_count, component).toBeGreaterThan(0);
    }
    expect(report.static_regions.total_count).toBeGreaterThan(0);
    expect(report.static_regions.changed_count).toBeGreaterThan(0);
    expect(report.static_regions.fully_static_count).toBeGreaterThan(0);
    expect(report.static_regions.regions.some((region) => region.changed_by.includes("caption_cue"))).toBe(true);
    expect(report.static_regions.regions.some((region) => region.changed_by.includes("in_frame_motion"))).toBe(true);
    expect(report.static_regions.regions.some((region) => region.changed_by.includes("music_onset"))).toBe(true);
  });

  it("fails an unexplained long hold while skipping the talking-head max-shot failure", () => {
    const timeline = lyricTimeline();
    const longClip = timeline.tracks.video[0].clips[2];
    longClip.still_image = still(384, { still_instance_id: "instance-c3-unexplained" });
    const report = evaluateLyricMvCadence(timeline);
    expect(report.status).toBe("fail");
    expect(report.long_holds[0]).toMatchObject({
      clip_id: "C3",
      status: "missing_reason_and_section_binding",
    });

    const metrics = computeReviewMetrics({
      timeline,
      brief: { project: { id: "issue43-m2", strategy: "lyric_mv" } } as CreativeBrief,
      blueprint: {
        project_id: "issue43-m2",
        beats: [{ id: "b01", label: "hook", target_duration_frames: 48, required_roles: ["hero"] }],
        pacing: { opening_cadence: "steady", middle_cadence: "steady", ending_cadence: "steady", max_shot_length_frames: 144 },
      } as EditBlueprint,
    } as ReviewMetricsInputs);
    const maxShot = metrics.checks.find((check) => check.id === "rhythm.max_shot_length");
    const composite = metrics.checks.find((check) => check.id === "rhythm.lyric_mv_composite_cadence");
    expect(maxShot?.status).toBe("skipped");
    expect(composite?.status).toBe("fail");
    expect(validateAgainstSchema(metrics, "review-metrics.schema.json")).toMatchObject({ valid: true, errors: [] });
  });

  it("projects measured section and onset evidence to exact rational-rate frame boundaries", () => {
    const analysis = {
      version: "1",
      project_id: "issue43-m2",
      analysis_status: "ready",
      music_asset: { asset_id: "AST_BGM", path: "02_media/song.wav", source_hash: "source" },
      bpm: 120,
      meter: "4/4",
      duration_sec: 20,
      beats_sec: [0, 2, 4.6, 8],
      downbeats_sec: [0, 4.6],
      sections: [{ id: "S2", label: "chorus", start_sec: 4.6, end_sec: 16.25, energy: 0.9, evidence_classification: "measured" }],
      onsets: [{ time_sec: 4.6, strength: 0.8, evidence_classification: "measured" }],
      provenance: { detector: "fixture", evidence_classification: "measured" },
    } as BgmAnalysis;
    const metadata = buildLyricMvTimelineMetadata(DEFAULT_LYRIC_MV_THRESHOLDS, analysis, 30000, 1001);
    const expectedStart = Math.round(4.6 * 30000 / 1001);
    const expectedEnd = Math.round(16.25 * 30000 / 1001);
    expect(metadata.music_sections[0]).toMatchObject({ start_frame: expectedStart, end_frame: expectedEnd });
    expect(metadata.music_events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "section_start", frame: expectedStart, section_id: "S2", evidence_classification: "measured" }),
      expect.objectContaining({ kind: "onset", frame: expectedStart, evidence_classification: "measured" }),
    ]));
    expect(metadata.version).toBe("lyric-mv/v1");
  });
});
