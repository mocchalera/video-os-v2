/**
 * M4 Audio Pipeline Tests
 *
 * Tests for:
 * - Music cues validation (validateMusicCues)
 * - A2 track clip building (buildA2TrackClips)
 * - Timeline projection (projectMusicToTimeline)
 * - Ducking filter generation (buildDuckingFilter)
 * - Fade filter generation (buildFadeFilter)
 * - Loudnorm mastering args (buildLoudnormPass1Args, buildLoudnormPass2Args)
 * - Loudnorm output parsing (parseLoudnormOutput)
 * - Speech interval extraction (extractSpeechIntervals)
 */

import { describe, it, expect } from "vitest";
import {
  validateMusicCues,
  buildA2TrackClips,
  projectMusicToTimeline,
  type MusicCuesDoc,
  type MusicCue,
} from "../runtime/audio/music-cues.js";
import {
  buildDuckingFilter,
  buildFadeFilter,
  type SpeechInterval,
} from "../runtime/audio/ducking.js";
import {
  buildLoudnormPass1Args,
  parseLoudnormOutput,
  buildLoudnormPass2Args,
  DEFAULT_MASTERING,
  type LoudnormMeasurement,
  type MasteringDefaults,
} from "../runtime/audio/mastering.js";
import { extractSpeechIntervals } from "../runtime/audio/mixer.js";

// ── Mock Data ──────────────────────────────────────────────────────

function makeMockCue(overrides?: Partial<MusicCue>): MusicCue {
  return {
    cue_id: "MC_0001",
    track_id: "A2",
    entry_window: { earliest_frame: 96, latest_frame: 144 },
    entry_frame: 120,
    exit_frame: 864,
    fade_in_ms: 400,
    fade_out_ms: 900,
    ducking: {
      base_gain_db: -16,
      duck_gain_db: -24,
      attack_ms: 80,
      release_ms: 180,
    },
    ...overrides,
  };
}

function makeMockDoc(overrides?: Partial<MusicCuesDoc>): MusicCuesDoc {
  return {
    version: "1",
    project_id: "test",
    base_timeline_version: "5",
    music_asset: {
      asset_id: "MUSIC_001",
      path: "inputs/music/theme.wav",
      source_hash: "sha256:abc123",
    },
    cues: [makeMockCue()],
    ...overrides,
  };
}

const mockLoudnormStderr = `
frame=    0 fps=0.0 q=0.0 size=N/A time=00:00:00.00 bitrate=N/A speed=N/A
[Parsed_loudnorm_0 @ 0x7f9a1c004a80]
{
	"input_i" : "-18.42",
	"input_tp" : "-0.93",
	"input_lra" : "6.10",
	"input_thresh" : "-28.57",
	"target_offset" : "0.38"
}
size=N/A time=00:01:30.00 bitrate=N/A speed=1200x
`;

// ── Music Cues Validation Tests ────────────────────────────────────

describe("validateMusicCues", () => {
  it("valid cues pass validation", () => {
    const doc = makeMockDoc();
    const result = validateMusicCues(doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("entry_frame below earliest_frame fails", () => {
    const doc = makeMockDoc({
      cues: [makeMockCue({ entry_frame: 50 })], // earliest_frame is 96
    });
    const result = validateMusicCues(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("entry_frame") && e.includes("earliest_frame"))).toBe(true);
  });

  it("entry_frame above latest_frame fails", () => {
    const doc = makeMockDoc({
      cues: [makeMockCue({ entry_frame: 200 })], // latest_frame is 144
    });
    const result = validateMusicCues(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("entry_frame") && e.includes("latest_frame"))).toBe(true);
  });

  it("exit_frame <= entry_frame fails", () => {
    const doc = makeMockDoc({
      cues: [makeMockCue({ entry_frame: 120, exit_frame: 120 })],
    });
    const result = validateMusicCues(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exit_frame") && e.includes("entry_frame"))).toBe(true);
  });

  it("exit_frame < entry_frame also fails", () => {
    const doc = makeMockDoc({
      cues: [makeMockCue({ entry_frame: 120, exit_frame: 50 })],
    });
    const result = validateMusicCues(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exit_frame"))).toBe(true);
  });

  it("negative fade_in_ms fails", () => {
    const doc = makeMockDoc({
      cues: [makeMockCue({ fade_in_ms: -100 })],
    });
    const result = validateMusicCues(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fade_in_ms"))).toBe(true);
  });

  it("negative fade_out_ms fails", () => {
    const doc = makeMockDoc({
      cues: [makeMockCue({ fade_out_ms: -50 })],
    });
    const result = validateMusicCues(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fade_out_ms"))).toBe(true);
  });

  it("empty cues array triggers 'at least one cue' error", () => {
    const doc = makeMockDoc({ cues: [] });
    const result = validateMusicCues(doc);
    // The implementation requires at least one cue
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("at least one cue"))).toBe(true);
  });

  it("duck_gain_db > base_gain_db fails", () => {
    const doc = makeMockDoc({
      cues: [
        makeMockCue({
          ducking: { base_gain_db: -24, duck_gain_db: -16, attack_ms: 80, release_ms: 180 },
        }),
      ],
    });
    const result = validateMusicCues(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duck_gain_db"))).toBe(true);
  });
});

// ── A2 Track Building Tests ────────────────────────────────────────

describe("buildA2TrackClips", () => {
  it("single cue produces clip with correct timeline positions", () => {
    const doc = makeMockDoc();
    const clips = buildA2TrackClips(doc);
    expect(clips).toHaveLength(1);

    const clip = clips[0];
    expect(clip.timeline_in_frame).toBe(120);
    expect(clip.timeline_duration_frames).toBe(864 - 120); // exit - entry = 744
    expect(clip.clip_id).toBe("A2_MC_0001");
    expect(clip.segment_id).toBe("MC_0001");
    expect(clip.asset_id).toBe("MUSIC_001");
  });

  it("multiple cues produce multiple clips", () => {
    const doc = makeMockDoc({
      cues: [
        makeMockCue({ cue_id: "MC_0001" }),
        makeMockCue({ cue_id: "MC_0002", entry_frame: 1000, exit_frame: 2000 }),
      ],
    });
    const clips = buildA2TrackClips(doc);
    expect(clips).toHaveLength(2);
    expect(clips[0].clip_id).toBe("A2_MC_0001");
    expect(clips[1].clip_id).toBe("A2_MC_0002");
    expect(clips[1].timeline_in_frame).toBe(1000);
    expect(clips[1].timeline_duration_frames).toBe(1000);
  });

  it("clip has music_cue metadata", () => {
    const doc = makeMockDoc();
    const clips = buildA2TrackClips(doc);
    const clip = clips[0];
    expect(clip.metadata).toBeDefined();
    expect(clip.metadata.music_cue).toBeDefined();
    expect(clip.metadata.music_cue.cue_id).toBe("MC_0001");
    expect(clip.metadata.music_cue.entry_frame).toBe(120);
    expect(clip.metadata.music_cue.exit_frame).toBe(864);
    expect(clip.metadata.music_cue.fade_in_ms).toBe(400);
    expect(clip.metadata.music_cue.fade_out_ms).toBe(900);
    expect(clip.metadata.music_cue.ducking).toEqual({
      base_gain_db: -16,
      duck_gain_db: -24,
      attack_ms: 80,
      release_ms: 180,
    });
  });

  it("role is 'music'", () => {
    const doc = makeMockDoc();
    const clips = buildA2TrackClips(doc);
    expect(clips[0].role).toBe("music");
  });

  it("motivation is 'background_music'", () => {
    const doc = makeMockDoc();
    const clips = buildA2TrackClips(doc);
    expect(clips[0].motivation).toBe("background_music");
  });
});

// ── Timeline Projection Tests ──────────────────────────────────────

describe("projectMusicToTimeline", () => {
  const baseTimeline = {
    version: "5",
    tracks: {
      video: [{ track_id: "V1", clips: [] }],
      audio: [{ track_id: "A1", kind: "audio", role: "dialogue", clips: [] }],
    },
  };

  it("A2 track added to timeline", () => {
    const doc = makeMockDoc();
    const result = projectMusicToTimeline(baseTimeline, doc, 24);

    const a2Track = result.tracks.audio.find((t: any) => t.track_id === "A2");
    expect(a2Track).toBeDefined();
    expect(a2Track.kind).toBe("audio");
    expect(a2Track.role).toBe("music");
    expect(a2Track.clips).toHaveLength(1);
  });

  it("does not mutate original timeline", () => {
    const doc = makeMockDoc();
    const original = JSON.parse(JSON.stringify(baseTimeline));
    projectMusicToTimeline(baseTimeline, doc, 24);

    expect(baseTimeline).toEqual(original);
  });

  it("existing audio tracks preserved", () => {
    const doc = makeMockDoc();
    const result = projectMusicToTimeline(baseTimeline, doc, 24);

    // A1 track should still be present
    const a1Track = result.tracks.audio.find((t: any) => t.track_id === "A1");
    expect(a1Track).toBeDefined();
    expect(a1Track.role).toBe("dialogue");

    // Both A1 and A2 should exist
    expect(result.tracks.audio.length).toBe(2);
  });

  it("clips have src_in_us / src_out_us computed from fps", () => {
    const doc = makeMockDoc();
    const fps = 24;
    const result = projectMusicToTimeline(baseTimeline, doc, fps);
    const a2Track = result.tracks.audio.find((t: any) => t.track_id === "A2");
    const clip = a2Track.clips[0];

    const usPerFrame = 1_000_000 / fps;
    expect(clip.src_in_us).toBe(Math.round(120 * usPerFrame));
    expect(clip.src_out_us).toBe(Math.round(864 * usPerFrame));
  });

  it("handles timeline with no existing tracks", () => {
    const emptyTimeline = { version: "5" };
    const doc = makeMockDoc();
    const result = projectMusicToTimeline(emptyTimeline, doc, 24);

    expect(result.tracks).toBeDefined();
    expect(result.tracks.audio).toBeDefined();
    expect(result.tracks.audio).toHaveLength(1);
    expect(result.tracks.audio[0].track_id).toBe("A2");
  });
});

// ── Ducking Filter Tests ───────────────────────────────────────────

describe("buildDuckingFilter", () => {
  const cue = makeMockCue();
  const fps = 24;

  it("no speech intervals produces base gain only", () => {
    const filter = buildDuckingFilter(cue, [], fps);
    expect(filter).toBe(`volume=${cue.ducking.base_gain_db}dB`);
  });

  it("one speech interval produces volume dip during speech", () => {
    // Speech interval that overlaps with the cue's range
    // Cue runs from frame 120..864 at 24fps = 5000ms..36000ms
    const speechIntervals: SpeechInterval[] = [
      { start_ms: 8000, end_ms: 12000 },
    ];
    const filter = buildDuckingFilter(cue, speechIntervals, fps);

    // Should contain volume expression with ducking
    expect(filter).toContain("volume=");
    expect(filter).toContain("eval=frame");
  });

  it("filter string contains volume keyword", () => {
    const speechIntervals: SpeechInterval[] = [
      { start_ms: 6000, end_ms: 10000 },
    ];
    const filter = buildDuckingFilter(cue, speechIntervals, fps);
    expect(filter).toContain("volume");
  });

  it("speech interval outside cue range returns base gain", () => {
    // Cue runs from frame 120..864 at 24fps = 5000ms..36000ms
    // Speech is entirely outside
    const speechIntervals: SpeechInterval[] = [
      { start_ms: 0, end_ms: 1000 },
    ];
    const filter = buildDuckingFilter(cue, speechIntervals, fps);
    expect(filter).toBe(`volume=${cue.ducking.base_gain_db}dB`);
  });

  it("multiple speech intervals produce filter with multiple between() calls", () => {
    const speechIntervals: SpeechInterval[] = [
      { start_ms: 6000, end_ms: 8000 },
      { start_ms: 15000, end_ms: 20000 },
    ];
    const filter = buildDuckingFilter(cue, speechIntervals, fps);
    expect(filter).toContain("volume=");
    // Multiple between() for multiple intervals
    const betweenCount = (filter.match(/between\(/g) || []).length;
    expect(betweenCount).toBeGreaterThanOrEqual(2);
  });
});

// ── Fade Filter Tests ──────────────────────────────────────────────

describe("buildFadeFilter", () => {
  it("fade in + fade out produces filter with both afade directives", () => {
    const filter = buildFadeFilter(400, 900, 31000);
    expect(filter).toContain("afade=t=in");
    expect(filter).toContain("afade=t=out");
    // Should be comma-separated
    expect(filter).toContain(",");
  });

  it("zero fade_in produces only fade out", () => {
    const filter = buildFadeFilter(0, 900, 31000);
    expect(filter).not.toContain("afade=t=in");
    expect(filter).toContain("afade=t=out");
  });

  it("zero fade_out produces only fade in", () => {
    const filter = buildFadeFilter(400, 0, 31000);
    expect(filter).toContain("afade=t=in");
    expect(filter).not.toContain("afade=t=out");
  });

  it("both zero produces empty string", () => {
    const filter = buildFadeFilter(0, 0, 31000);
    expect(filter).toBe("");
  });

  it("fade in duration appears in seconds", () => {
    const filter = buildFadeFilter(400, 0, 31000);
    // 400ms = 0.4s
    expect(filter).toContain("d=0.4000");
  });

  it("fade out start time is totalDuration - fadeOut", () => {
    const filter = buildFadeFilter(0, 900, 10000);
    // totalDuration = 10s, fadeOut = 0.9s => st = 9.1s
    expect(filter).toContain("st=9.1000");
    expect(filter).toContain("d=0.9000");
  });
});

// ── Mastering Tests ────────────────────────────────────────────────

describe("buildLoudnormPass1Args", () => {
  it("contains loudnorm in the filter argument", () => {
    const args = buildLoudnormPass1Args("input.wav");
    expect(args.some((a) => a.includes("loudnorm"))).toBe(true);
  });

  it("uses default values: -16 LUFS, LRA 7, TP -1.5", () => {
    const args = buildLoudnormPass1Args("input.wav");
    const filterArg = args.find((a) => a.includes("loudnorm"))!;
    expect(filterArg).toContain("I=-16");
    expect(filterArg).toContain("LRA=7");
    expect(filterArg).toContain("TP=-1.5");
  });

  it("includes print_format=json", () => {
    const args = buildLoudnormPass1Args("input.wav");
    const filterArg = args.find((a) => a.includes("loudnorm"))!;
    expect(filterArg).toContain("print_format=json");
  });

  it("includes -f null - for null output", () => {
    const args = buildLoudnormPass1Args("input.wav");
    expect(args).toContain("-f");
    expect(args).toContain("null");
    expect(args).toContain("-");
  });

  it("includes input path", () => {
    const args = buildLoudnormPass1Args("path/to/input.wav");
    expect(args).toContain("path/to/input.wav");
    expect(args[args.indexOf("path/to/input.wav") - 1]).toBe("-i");
  });

  it("custom mastering defaults are used", () => {
    const custom: MasteringDefaults = {
      loudness_target_lufs: -14,
      lra_target: 9,
      true_peak_target_dbtp: -2.0,
    };
    const args = buildLoudnormPass1Args("input.wav", custom);
    const filterArg = args.find((a) => a.includes("loudnorm"))!;
    expect(filterArg).toContain("I=-14");
    expect(filterArg).toContain("LRA=9");
    expect(filterArg).toContain("TP=-2");
  });
});

describe("parseLoudnormOutput", () => {
  it("extracts values from mock ffmpeg stderr", () => {
    const measurement = parseLoudnormOutput(mockLoudnormStderr);
    expect(measurement.input_i).toBe("-18.42");
    expect(measurement.input_tp).toBe("-0.93");
    expect(measurement.input_lra).toBe("6.10");
    expect(measurement.input_thresh).toBe("-28.57");
    expect(measurement.target_offset).toBe("0.38");
  });

  it("throws when no JSON block is found", () => {
    expect(() => parseLoudnormOutput("no json here")).toThrow(
      "Could not find loudnorm JSON",
    );
  });

  it("returns all fields as strings", () => {
    const measurement = parseLoudnormOutput(mockLoudnormStderr);
    expect(typeof measurement.input_i).toBe("string");
    expect(typeof measurement.input_tp).toBe("string");
    expect(typeof measurement.input_lra).toBe("string");
    expect(typeof measurement.input_thresh).toBe("string");
    expect(typeof measurement.target_offset).toBe("string");
  });
});

describe("buildLoudnormPass2Args", () => {
  const measurement: LoudnormMeasurement = {
    input_i: "-18.42",
    input_tp: "-0.93",
    input_lra: "6.10",
    input_thresh: "-28.57",
    target_offset: "0.38",
  };

  it("includes measured values in filter string", () => {
    const args = buildLoudnormPass2Args("in.wav", "out.wav", measurement);
    const filterArg = args.find((a) => a.includes("loudnorm"))!;
    expect(filterArg).toContain("measured_I=-18.42");
    expect(filterArg).toContain("measured_LRA=6.10");
    expect(filterArg).toContain("measured_TP=-0.93");
    expect(filterArg).toContain("measured_thresh=-28.57");
    expect(filterArg).toContain("offset=0.38");
  });

  it("includes linear=true for highest quality", () => {
    const args = buildLoudnormPass2Args("in.wav", "out.wav", measurement);
    const filterArg = args.find((a) => a.includes("loudnorm"))!;
    expect(filterArg).toContain("linear=true");
  });

  it("includes input and output paths", () => {
    const args = buildLoudnormPass2Args("in.wav", "out.wav", measurement);
    expect(args).toContain("in.wav");
    expect(args).toContain("out.wav");
  });

  it("includes -y for overwrite", () => {
    const args = buildLoudnormPass2Args("in.wav", "out.wav", measurement);
    expect(args[0]).toBe("-y");
  });

  it("uses default mastering targets", () => {
    const args = buildLoudnormPass2Args("in.wav", "out.wav", measurement);
    const filterArg = args.find((a) => a.includes("loudnorm"))!;
    expect(filterArg).toContain("I=-16");
    expect(filterArg).toContain("LRA=7");
    expect(filterArg).toContain("TP=-1.5");
  });

  it("custom mastering defaults are used", () => {
    const custom: MasteringDefaults = {
      loudness_target_lufs: -14,
      lra_target: 9,
      true_peak_target_dbtp: -2.0,
    };
    const args = buildLoudnormPass2Args("in.wav", "out.wav", measurement, custom);
    const filterArg = args.find((a) => a.includes("loudnorm"))!;
    expect(filterArg).toContain("I=-14");
    expect(filterArg).toContain("LRA=9");
    expect(filterArg).toContain("TP=-2");
  });
});

describe("DEFAULT_MASTERING", () => {
  it("has expected default values", () => {
    expect(DEFAULT_MASTERING.loudness_target_lufs).toBe(-16);
    expect(DEFAULT_MASTERING.lra_target).toBe(7);
    expect(DEFAULT_MASTERING.true_peak_target_dbtp).toBe(-1.5);
  });
});

// ── Mixer Tests ────────────────────────────────────────────────────

describe("extractSpeechIntervals", () => {
  it("A1 clips at 24fps produce correct ms intervals", () => {
    const a1Clips = [
      { timeline_in_frame: 0, timeline_duration_frames: 48 }, // 0-2000ms
    ];
    const intervals = extractSpeechIntervals(a1Clips, 24);
    expect(intervals).toHaveLength(1);

    // frame 0 at 24fps = 0ms, 48 frames at 24fps = 2000ms
    expect(intervals[0].start_ms).toBeCloseTo(0, 5);
    expect(intervals[0].end_ms).toBeCloseTo(2000, 5);
  });

  it("multiple clips produce multiple intervals", () => {
    const a1Clips = [
      { timeline_in_frame: 0, timeline_duration_frames: 24 },   // 0-1000ms
      { timeline_in_frame: 72, timeline_duration_frames: 48 },  // 3000-5000ms
    ];
    const intervals = extractSpeechIntervals(a1Clips, 24);
    expect(intervals).toHaveLength(2);

    expect(intervals[0].start_ms).toBeCloseTo(0, 5);
    expect(intervals[0].end_ms).toBeCloseTo(1000, 5);
    expect(intervals[1].start_ms).toBeCloseTo(3000, 5);
    expect(intervals[1].end_ms).toBeCloseTo(5000, 5);
  });

  it("different fps values produce correct results", () => {
    const a1Clips = [
      { timeline_in_frame: 30, timeline_duration_frames: 60 },
    ];
    const intervals = extractSpeechIntervals(a1Clips, 30);
    // 30 frames at 30fps = 1000ms start, 60 frames at 30fps = 2000ms duration
    expect(intervals[0].start_ms).toBeCloseTo(1000, 5);
    expect(intervals[0].end_ms).toBeCloseTo(3000, 5);
  });

  it("empty clips array produces empty intervals", () => {
    const intervals = extractSpeechIntervals([], 24);
    expect(intervals).toHaveLength(0);
  });
});
