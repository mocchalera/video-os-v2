import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyCutBeatQuantize,
  loadBeatSyncGridFromProject,
  type BeatSyncGrid,
} from "../runtime/compiler/beat-sync.js";
import { enrichMusicCuesWithBeatGrid, validateMusicCues, type MusicCuesDoc } from "../runtime/audio/music-cues.js";
import type { AssembledTimeline, TimelineClip } from "../runtime/compiler/types.js";

const TMP_ROOT = path.join("tests", "tmp_beat_sync_quantize");

afterEach(() => {
  if (fs.existsSync(TMP_ROOT)) {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

function makeClip(
  clipId: string,
  start: number,
  duration: number,
  metadata?: Record<string, unknown>,
): TimelineClip {
  return {
    clip_id: clipId,
    segment_id: `SEG_${clipId}`,
    asset_id: `AST_${clipId}`,
    src_in_us: Math.round(start * (1_000_000 / 24)),
    src_out_us: Math.round((start + duration) * (1_000_000 / 24)),
    timeline_in_frame: start,
    timeline_duration_frames: duration,
    role: "hero",
    motivation: "test",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    metadata,
  };
}

function makeTimeline(clips: TimelineClip[]): AssembledTimeline {
  return {
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips }],
      audio: [],
    },
    markers: [],
  };
}

function apply(
  timeline: AssembledTimeline,
  grid: BeatSyncGrid,
  overrides: Partial<Parameters<typeof applyCutBeatQuantize>[1]> = {},
) {
  return applyCutBeatQuantize(timeline, {
    mode: "auto",
    grid,
    fpsNum: 24,
    maxShiftFrames: 12,
    minDurationFrames: 12,
    ...overrides,
  });
}

describe("cut beat quantize", () => {
  it("moves an adjacent cut boundary onto the nearest beat grid", () => {
    const left = makeClip("L", 0, 50);
    const right = makeClip("R", 50, 50);
    const timeline = makeTimeline([left, right]);

    const result = apply(timeline, { frames: [48], source: "music_cues" });

    expect(result?.counts.quantized).toBe(1);
    expect(left.timeline_duration_frames).toBe(48);
    expect(right.timeline_in_frame).toBe(48);
    expect(right.timeline_duration_frames).toBe(52);
    expect(result?.boundaries[0]).toMatchObject({
      cut_frame_before: 50,
      cut_frame_after: 48,
      shift_frames: -2,
      status: "quantized",
    });
  });

  it("leaves a boundary untouched when the nearest grid exceeds max_shift_frames", () => {
    const left = makeClip("L", 0, 50);
    const right = makeClip("R", 50, 50);
    const timeline = makeTimeline([left, right]);

    const result = apply(timeline, { frames: [80], source: "music_cues" });

    expect(result?.counts.quantized).toBe(0);
    expect(result?.counts.max_shift_exceeded).toBe(1);
    expect(left.timeline_duration_frames).toBe(50);
    expect(right.timeline_in_frame).toBe(50);
    expect(result?.boundaries[0].skip_reason).toBe("max_shift_exceeded");
  });

  it("skips a cut protected by talking_head_pacing speech-boundary snap", () => {
    const left = makeClip("L", 0, 50, {
      talking_head_pacing: { snapped_out: true },
    });
    const right = makeClip("R", 50, 50);
    const timeline = makeTimeline([left, right]);

    const result = apply(timeline, { frames: [48], source: "music_cues" });

    expect(result?.counts.quantized).toBe(0);
    expect(result?.counts.speech_protected).toBe(1);
    expect(left.timeline_duration_frames).toBe(50);
    expect(right.timeline_in_frame).toBe(50);
    expect(result?.boundaries[0].skip_reason).toBe("speech_protected");
  });

  it("skips a shift that would violate the minimum clip duration", () => {
    const left = makeClip("L", 0, 15);
    const right = makeClip("R", 15, 40);
    const timeline = makeTimeline([left, right]);

    const result = apply(timeline, { frames: [8], source: "music_cues" });

    expect(result?.counts.quantized).toBe(0);
    expect(result?.counts.min_duration).toBe(1);
    expect(left.timeline_duration_frames).toBe(15);
    expect(right.timeline_in_frame).toBe(15);
    expect(result?.boundaries[0].skip_reason).toBe("min_duration");
  });

  it("is deterministic for the same timeline and beat grid", () => {
    const build = () => makeTimeline([
      makeClip("A", 0, 50),
      makeClip("B", 50, 50),
      makeClip("C", 100, 50),
    ]);
    const grid: BeatSyncGrid = { frames: [48, 102], source: "music_cues" };

    const first = build();
    const second = build();
    const firstResult = apply(first, grid);
    const secondResult = apply(second, grid);

    expect(firstResult).toEqual(secondResult);
    expect(first).toEqual(second);
  });

  it("stays absent in auto mode when no beat grid is available", () => {
    const timeline = makeTimeline([makeClip("L", 0, 50), makeClip("R", 50, 50)]);
    const result = applyCutBeatQuantize(timeline, {
      mode: "auto",
      fpsNum: 24,
      maxShiftFrames: 12,
      minDurationFrames: 12,
    });

    expect(result).toBeUndefined();
    expect(timeline.tracks.video[0].clips[0].timeline_duration_frames).toBe(50);
  });
});

describe("music cue beat grid contract", () => {
  it("loads beat grid frames from additive music_cues beat_sync data", () => {
    const projectDir = path.join(TMP_ROOT, "music-cues-grid");
    const cuesPath = path.join(projectDir, "07_package", "music_cues.json");
    fs.mkdirSync(path.dirname(cuesPath), { recursive: true });
    fs.writeFileSync(
      cuesPath,
      JSON.stringify({
        version: "1",
        project_id: "test",
        base_timeline_version: "1",
        music_asset: { asset_id: "MUSIC", path: "bgm.wav", source_hash: "sha256:test" },
        cues: [{
          cue_id: "MC_0001",
          track_id: "A2",
          entry_window: { earliest_frame: 96, latest_frame: 144 },
          entry_frame: 120,
          exit_frame: 240,
          fade_in_ms: 100,
          fade_out_ms: 100,
          ducking: { base_gain_db: -16, duck_gain_db: -24, attack_ms: 80, release_ms: 180 },
          beat_sync: { enabled: true, beats_sec: [0, 0.5, 1] },
        }],
      }, null, 2),
      "utf-8",
    );

    const grid = loadBeatSyncGridFromProject(projectDir, 24);

    expect(grid).toEqual({ frames: [120, 132, 144], source: "music_cues" });
  });

  it("enriches music cues with BGM analysis grid without breaking validation", () => {
    const doc: MusicCuesDoc = {
      version: "1",
      project_id: "test",
      base_timeline_version: "1",
      music_asset: { asset_id: "MUSIC", path: "bgm.wav", source_hash: "sha256:test" },
      cues: [{
        cue_id: "MC_0001",
        track_id: "A2",
        entry_window: { earliest_frame: 96, latest_frame: 144 },
        entry_frame: 120,
        exit_frame: 240,
        fade_in_ms: 100,
        fade_out_ms: 100,
        ducking: { base_gain_db: -16, duck_gain_db: -24, attack_ms: 80, release_ms: 180 },
      }],
    };

    const enriched = enrichMusicCuesWithBeatGrid(doc, {
      bpm: 120,
      meter: "4/4",
      beats_sec: [0, 0.5, 1],
      downbeats_sec: [0],
      provenance: { detector: "test_detector" },
    });

    expect(enriched.cues[0].beat_sync).toMatchObject({
      enabled: true,
      align: "both",
      bpm: 120,
      meter: "4/4",
      beats_sec: [0, 0.5, 1],
      downbeats_sec: [0],
      grid_source: "test_detector",
    });
    expect(validateMusicCues(enriched).valid).toBe(true);
  });
});
