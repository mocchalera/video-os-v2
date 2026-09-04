import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  applyRhythmSyncSnaps,
  loadMusicAssetWords,
  loadRhythmEventGrid,
  snapshotTranscriptsDirectory,
  measureTimelineIntegrity,
  recomputeRhythmParityAndIntegrity,
  rhythmFramesToUs,
  secondsToRhythmFrame,
  usToRhythmFrame,
  type RhythmEventGrid,
} from "../runtime/compiler/rhythm-sync.js";
import { computeMediaHeadSourceHash } from "../runtime/media/bgm-analyzer.js";
import type { AssembledTimeline, TimelineClip } from "../runtime/compiler/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Helpers ─────────────────────────────────────────────────────────

function makeClip(
  clipId: string,
  start: number,
  duration: number,
  options: { fps?: number; beatId?: string; mediaKind?: string; metadata?: Record<string, unknown> } = {},
): TimelineClip {
  const fps = options.fps ?? 30;
  return {
    clip_id: clipId,
    segment_id: `SEG_${clipId}`,
    asset_id: `AST_${clipId}`,
    src_in_us: Math.round(start * (1_000_000 / fps)),
    src_out_us: Math.round((start + duration) * (1_000_000 / fps)),
    timeline_in_frame: start,
    timeline_duration_frames: duration,
    role: "hero",
    motivation: "test",
    beat_id: options.beatId ?? "b01",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    ...(options.mediaKind ? { media_kind: options.mediaKind as TimelineClip["media_kind"] } : {}),
    metadata: options.metadata,
  };
}

function makeTimeline(clips: TimelineClip[]): AssembledTimeline {
  return {
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips }],
      audio: [],
    },
    markers: clips
      .map((clip) => ({
        frame: clip.timeline_in_frame,
        kind: "beat" as const,
        label: `${clip.beat_id}: ${clip.beat_id}`,
      }))
      .filter((marker, index, all) => all.findIndex((m) => m.label === marker.label) === index),
  };
}

const MUSIC_ASSET = "AST_MUSIC";

function wordEvent(frame: number, word = "orbit", fps = 30): { frame: number; time_sec: number; us: number; kind: "word_start"; word: string; asset_id: string; confidence: number; provenance: "transcript_word_start" } {
  return { frame, time_sec: frame / fps, us: Math.round(frame * (1_000_000 / fps)), kind: "word_start", word, confidence: 1, provenance: "transcript_word_start", asset_id: MUSIC_ASSET };
}

function onsetEvent(frame: number, fps = 30) {
  return { frame, time_sec: frame / fps, us: Math.round(frame * (1_000_000 / fps)), kind: "onset" as const, strength: 0.9, confidence: 0.9, provenance: "measured_onset" as const };
}

function downbeatEvent(frame: number, fps = 30) {
  return { frame, time_sec: frame / fps, us: Math.round(frame * (1_000_000 / fps)), kind: "downbeat" as const, strength: 0.9, confidence: 0.9, provenance: "measured_downbeat" as const };
}

function makeGrid(overrides: Partial<RhythmEventGrid> = {}): RhythmEventGrid {
  return {
    events: [],
    majorSections: [],
    status: "ready",
    sources: { bgm_analysis: true, word_timestamps: true, beat_count: 2, word_count: 1, section_count: 1 },
    degraded_reasons: [],
    evidence: { binding: "bound", binding_failures: [] },
    ...overrides,
  };
}

function chorusSection(id = "S2", startFrame = 3136, endFrame = 3600, fps = 30) {
  return {
    id,
    label: "chorus",
    start_frame: startFrame,
    end_frame: endFrame,
    start_sec: startFrame / fps,
    end_sec: endFrame / fps,
    hard_snap: true,
  };
}

function apply(timeline: AssembledTimeline, grid: RhythmEventGrid, overrides: Partial<Parameters<typeof applyRhythmSyncSnaps>[1]> = {}) {
  return applyRhythmSyncSnaps(timeline, {
    mode: "auto",
    grid,
    fpsNum: 30,
    fpsDen: 1,
    searchWindowSec: 1.5,
    maxShiftFrames: 12,
    parityMaxOffsetFrames: 2,
    minDurationFrames: 12,
    parityGate: "enforce",
    ...overrides,
  });
}

// ── AC1: 1-frame snap of major section starts ───────────────────────

describe("rhythm sync: AC1 section-start snap", () => {
  it("hard-snaps a late chorus cut onto the first vocal word head at 1-frame precision (Issue #35 scenario)", () => {
    // Issue numbers: chorus vocal at 104.52s, cut was at 105.97s (~1.45s late) at 30fps.
    const chorusStart = Math.round(104.52 * 30); // 3136
    const lateCut = Math.round(105.97 * 30); // 3179
    const left = makeClip("L", 0, lateCut, { beatId: "b_pre" });
    const right = makeClip("R", lateCut, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(chorusStart, "orbit")],
      majorSections: [chorusSection("S2", chorusStart, chorusStart + 464)],
    });

    const metadata = apply(timeline, grid);

    expect(metadata.enabled).toBe(true);
    expect(metadata.status).toBe("applied");
    expect(metadata.counts.hard_snapped).toBe(1);
    const snap = metadata.snaps.find((entry) => entry.status === "snapped");
    expect(snap).toBeDefined();
    expect(snap).toMatchObject({
      hard_snap: true,
      section_label: "chorus",
      target_kind: "word_start",
      target_frame: chorusStart,
      cut_frame_before: lateCut,
      cut_frame_after: chorusStart,
      shift_frames: chorusStart - lateCut,
    });
    // 1-frame precision: the cut now sits exactly on the word head.
    expect(Math.abs(snap!.cut_frame_after - snap!.target_frame!)).toBeLessThanOrEqual(1);
    // Geometry: pair-preserving shift landed the right clip on the word head.
    expect(right.timeline_in_frame).toBe(chorusStart);
    expect(left.timeline_in_frame + left.timeline_duration_frames).toBe(chorusStart);
    expect(metadata.parity.status).toBe("pass");
  });

  it("falls back to the section-head downbeat when the chorus has no word timestamps", () => {
    const chorusStart = 3136;
    const downbeat = downbeatEvent(chorusStart);
    const left = makeClip("L", 0, 3160);
    const right = makeClip("R", 3160, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [downbeat],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
      sources: { bgm_analysis: true, word_timestamps: false, beat_count: 1, word_count: 0, section_count: 1 },
    });

    const metadata = apply(timeline, grid);

    const snap = metadata.snaps.find((entry) => entry.status === "snapped");
    expect(snap).toBeDefined();
    expect(snap).toMatchObject({ target_kind: "downbeat", target_frame: chorusStart, hard_snap: true });
    expect(right.timeline_in_frame).toBe(chorusStart);
    expect(metadata.parity.status).toBe("pass");
  });

  it("snaps a break section start to the nearest onset without hard-snap priority", () => {
    const breakStart = 900;
    const left = makeClip("L", 0, 920);
    const right = makeClip("R", 920, 100, { beatId: "b_break" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [onsetEvent(breakStart)],
      majorSections: [{
        id: "S3", label: "break", start_frame: breakStart, end_frame: 1100,
        start_sec: breakStart / 30, end_sec: 1100 / 30, hard_snap: false,
      }],
    });

    const metadata = apply(timeline, grid);

    const snap = metadata.snaps.find((entry) => entry.status === "snapped");
    expect(snap).toBeDefined();
    expect(snap).toMatchObject({ section_label: "break", hard_snap: false, target_frame: breakStart, cut_frame_after: breakStart });
    expect(metadata.counts.hard_snapped).toBe(0);
    expect(metadata.counts.section_snapped).toBe(1);
  });
});

// ── AC2: Gap 0f / Overrun 0f integrity after snapping ───────────────

describe("rhythm sync: AC2 timeline integrity", () => {
  it("keeps every boundary flush and total content unchanged after multi-boundary snapping", () => {
    const before = makeTimeline([
      makeClip("A", 0, 100, { beatId: "b01" }),
      makeClip("B", 100, 100, { beatId: "b02" }),
      makeClip("C", 200, 100, { beatId: "b03" }),
    ]);
    const beforeTotal = before.tracks.video[0].clips.reduce((sum, clip) => sum + clip.timeline_duration_frames, 0);
    const grid = makeGrid({
      events: [wordEvent(90), onsetEvent(210)],
      majorSections: [chorusSection("S2", 90, 300)],
    });

    const metadata = apply(before, grid);
    const clips = before.tracks.video[0].clips;

    expect(metadata.integrity).toMatchObject({ gap_frames: 0, overrun_frames: 0, verified: true });
    // Adjacent clips stay flush: no gap, no overlap anywhere.
    for (let i = 0; i < clips.length - 1; i += 1) {
      expect(clips[i].timeline_in_frame + clips[i].timeline_duration_frames).toBe(clips[i + 1].timeline_in_frame);
    }
    const afterTotal = clips.reduce((sum, clip) => sum + clip.timeline_duration_frames, 0);
    expect(afterTotal).toBe(beforeTotal);
  });

  it("records source_range_exceeded instead of producing a negative src_in_us", () => {
    const left = makeClip("L", 0, 100);
    const right = makeClip("R", 100, 100, { beatId: "b_chorus" });
    right.src_in_us = 10; // nearly zero source head; an earlier cut would go negative
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(80)],
      majorSections: [chorusSection("S2", 80, 200)],
    });

    const metadata = apply(timeline, grid);

    const snap = metadata.snaps[0];
    expect(snap.status).toBe("skipped");
    expect(snap.skip_reason).toBe("source_range_exceeded");
    expect(right.src_in_us).toBe(10);
    expect(right.timeline_in_frame).toBe(100);
  });
});

// ── Search window and guards (fail-open, explicit skips) ────────────

describe("rhythm sync: search window and guards", () => {
  it("does not snap when the section start is beyond the ±1.5s search window and parity fails", () => {
    const chorusStart = 3136;
    const farCut = chorusStart + 70; // ~2.3s late at 30fps, outside 45-frame window
    const left = makeClip("L", 0, farCut);
    const right = makeClip("R", farCut, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(chorusStart)],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
    });

    const metadata = apply(timeline, grid);

    expect(metadata.counts.snapped).toBe(0);
    expect(right.timeline_in_frame).toBe(farCut);
    expect(metadata.degraded_reasons).toContain("section_no_boundary_in_window:S2");
    // Parity gate still evaluates the real offset: ≥2 frames at a chorus head is a fail.
    expect(metadata.parity.status).toBe("fail");
    const section = metadata.parity.sections.find((entry) => entry.section_id === "S2");
    expect(section).toMatchObject({ status: "fail", offset_frames: 70 });
  });

  it("skips a speech-protected chorus boundary and records the parity fail", () => {
    const chorusStart = 3136;
    const left = makeClip("L", 0, 3160, { metadata: { talking_head_pacing: { snapped_out: true } } });
    const right = makeClip("R", 3160, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(chorusStart)],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
    });

    const metadata = apply(timeline, grid);

    const snap = metadata.snaps.find((entry) => entry.section_label === "chorus");
    expect(snap).toMatchObject({ status: "skipped", skip_reason: "speech_protected" });
    expect(right.timeline_in_frame).toBe(3160);
    expect(metadata.parity.status).toBe("fail");
  });

  it("skips a still-image boundary", () => {
    const chorusStart = 3136;
    const left = makeClip("L", 0, 3160, { mediaKind: "image" });
    const right = makeClip("R", 3160, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(chorusStart)],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
    });

    const metadata = apply(timeline, grid);

    expect(metadata.snaps[0]).toMatchObject({ status: "skipped", skip_reason: "still_image_boundary" });
    expect(right.timeline_in_frame).toBe(3160);
  });

  it("skips a shift that would violate the minimum clip duration", () => {
    const chorusStart = 3136;
    // Cut moves 24f earlier (delta<0) → the LEFT clip shrinks from 30f to 6f < min 12f.
    const left = makeClip("L", 3130, 30);
    const right = makeClip("R", 3160, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(chorusStart)],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
    });

    const metadata = apply(timeline, grid);

    expect(metadata.snaps[0]).toMatchObject({ status: "skipped", skip_reason: "min_duration" });
    expect(left.timeline_duration_frames).toBe(30);
  });

  it("is deterministic for the same timeline and rhythm grid", () => {
    const build = () => makeTimeline([
      makeClip("A", 0, 100, { beatId: "b01" }),
      makeClip("B", 100, 100, { beatId: "b_chorus" }),
    ]);
    const grid = makeGrid({
      events: [wordEvent(90)],
      majorSections: [chorusSection("S2", 90, 200)],
    });

    const first = build();
    const second = build();
    const firstMetadata = apply(first, grid);
    const secondMetadata = apply(second, grid);

    expect(firstMetadata).toEqual(secondMetadata);
    expect(first).toEqual(second);
  });
});

// ── Parity gate semantics ───────────────────────────────────────────

describe("rhythm sync: parity gate", () => {
  it("lands exactly on the word head when the cut is 1 frame off (AC1 precision edge)", () => {
    const chorusStart = 3136;
    const left = makeClip("L", 0, chorusStart + 1);
    const right = makeClip("R", chorusStart + 1, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(chorusStart)],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
    });

    const metadata = apply(timeline, grid);

    expect(right.timeline_in_frame).toBe(chorusStart);
    expect(metadata.parity.status).toBe("pass");
    const section = metadata.parity.sections.find((entry) => entry.section_id === "S2");
    expect(section?.status).toBe("pass");
    expect(section?.offset_frames).toBeLessThanOrEqual(1);
  });

  it("warns (not fails) for a break section beyond the parity window", () => {
    const breakStart = 900;
    const left = makeClip("L", 0, 950, { metadata: { talking_head_pacing: { snapped_out: true } } });
    const right = makeClip("R", 950, 100, { beatId: "b_break" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [onsetEvent(breakStart)],
      majorSections: [{
        id: "S3", label: "break", start_frame: breakStart, end_frame: 1100,
        start_sec: breakStart / 30, end_sec: 1100 / 30, hard_snap: false,
      }],
    });

    const metadata = apply(timeline, grid);

    expect(metadata.parity.status).toBe("warning");
    expect(metadata.parity.sections[0]).toMatchObject({ status: "warning", offset_frames: 50 });
  });

  it("degrades parity when no rhythm event evidences the section start", () => {
    const left = makeClip("L", 0, 3160);
    const right = makeClip("R", 3160, 100);
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [onsetEvent(100)],
      majorSections: [chorusSection("S2", 3136, 3600)],
    });

    const metadata = apply(timeline, grid);

    expect(metadata.parity.status).toBe("degraded");
    expect(metadata.parity.sections[0]).toMatchObject({ status: "degraded", reason: "no_rhythm_event_at_section_start" });
    expect(metadata.degraded_reasons).toContain("section_start_unverified:S2");
    expect(metadata.snaps[0]).toMatchObject({
      section_id: "S2",
      cut_frame_before: 3160,
      cut_frame_after: 3160,
      target_frame: 100,
      target_kind: "onset",
      target_provenance: "measured_onset",
      target_confidence: 0.9,
      decision: "rejected",
      reason: "outside_tolerance",
      skip_reason: "outside_tolerance",
      tolerance_frames: 45,
    });
  });
});

// ── Fail-open modes ─────────────────────────────────────────────────

describe("rhythm sync: fail-open modes", () => {
  it("mode off leaves geometry untouched and records disabled", () => {
    const left = makeClip("L", 0, 100);
    const right = makeClip("R", 100, 100);
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({ events: [wordEvent(90)], majorSections: [chorusSection("S2", 90, 200)] });

    const metadata = apply(timeline, grid, { mode: "off" });

    expect(metadata).toMatchObject({ enabled: false, status: "disabled", disabled_reason: "configured_off" });
    expect(metadata.snaps).toEqual([]);
    expect(left.timeline_duration_frames).toBe(100);
  });

  it("auto mode with an unavailable grid degrades explicitly without touching geometry", () => {
    const left = makeClip("L", 0, 100);
    const right = makeClip("R", 100, 100);
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [],
      majorSections: [],
      status: "unavailable",
      sources: { bgm_analysis: false, word_timestamps: false, beat_count: 0, word_count: 0, section_count: 0 },
      degraded_reasons: ["bgm_analysis_missing_or_not_ready"],
    });

    const metadata = apply(timeline, grid);

    expect(metadata).toMatchObject({
      enabled: false,
      status: "degraded",
      disabled_reason: "no_rhythm_events",
    });
    expect(metadata.degraded_reasons).toContain("bgm_analysis_missing_or_not_ready");
    expect(metadata.integrity.verified).toBe(false);
    expect(left.timeline_duration_frames).toBe(100);
    expect(right.timeline_in_frame).toBe(100);
  });
});

// ── Beat marker coherence ───────────────────────────────────────────

describe("rhythm sync: beat markers", () => {
  it("moves the right-side beat marker to the snapped cut frame", () => {
    const left = makeClip("A", 0, 100, { beatId: "b01" });
    const right = makeClip("B", 100, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(90)],
      majorSections: [chorusSection("S2", 90, 200)],
    });

    apply(timeline, grid);

    const marker = timeline.markers.find((entry) => entry.label.startsWith("b_chorus"));
    expect(marker?.frame).toBe(90);
  });
});

// ── Event grid loader (word evidence soundness) ─────────────────────

describe("rhythm sync: event grid loader", () => {
  const TMP_ROOT = path.join("tests", "tmp_rhythm_sync_loader");

  afterAll(() => {
    // Task-owned files must be absent after the tests (tracked and ignored).
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    expect(fs.existsSync(TMP_ROOT)).toBe(false);
  });

  function writeProjectfiles(files: Record<string, unknown>): string {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    // Fixture media so fail-closed source-hash binding can verify.
    fs.mkdirSync(path.join(TMP_ROOT, "02_media"), { recursive: true });
    fs.writeFileSync(path.join(TMP_ROOT, "02_media/bgm.wav"), "fake-pcm-bytes-v1");
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(TMP_ROOT, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(content, null, 2), "utf-8");
    }
    return TMP_ROOT;
  }

  const MEDIA_HASH = createHash("sha256").update("fake-pcm-bytes-v1").digest("hex").slice(0, 16);
  const bgmAnalysis = (assetId: string) => ({
    version: "1",
    project_id: "rhythm-test",
    analysis_status: "ready",
    music_asset: { asset_id: assetId, path: "02_media/bgm.wav", source_hash: MEDIA_HASH },
    bpm: 120,
    meter: "4/4",
    duration_sec: 30,
    beats_sec: [2, 4, 6, 10],
    downbeats_sec: [4],
    sections: [
      { id: "S1", label: "verse", start_sec: 0, end_sec: 10, energy: 0.4 },
      { id: "S2", label: "chorus", start_sec: 10, end_sec: 20, energy: 0.9 },
    ],
    provenance: { detector: "fixture", sample_rate_hz: 44100 },
  });

  it("loads word events only from the music asset transcript (other assets are not timeline evidence)", () => {
    const project = writeProjectfiles({
      "03_analysis/bgm_analysis.json": bgmAnalysis("AST_MUSIC"),
      "03_analysis/transcripts/TR_AST_MUSIC.json": {
        project_id: "rhythm-test",
        artifact_version: "analysis-v1",
        transcript_ref: "TR_AST_MUSIC",
        asset_id: "AST_MUSIC",
        word_timing_mode: "word",
        items: [{
          speaker: "V", start_us: 10_000_000, end_us: 12_000_000, text: "go orbit",
          words: [
            { word: "go", start_us: 10_400_000, end_us: 10_600_000 },
            { word: "orbit", start_us: 10_800_000, end_us: 11_400_000 },
            // Schema-valid but extraction-filtered: empty word / end before start.
            { word: "", start_us: 10_450_000, end_us: 11_000_000 },
            { word: "worse", start_us: 11_500_000, end_us: 11_400_000 },
          ],
        }],
      },
      "03_analysis/transcripts/TR_AST_OTHER.json": {
        project_id: "rhythm-test",
        artifact_version: "analysis-v1",
        transcript_ref: "TR_AST_OTHER",
        asset_id: "AST_OTHER",
        items: [{
          speaker: "S", start_us: 3_000_000, end_us: 4_000_000, text: "not the song",
          words: [{ word: "noise", start_us: 3_100_000, end_us: 3_400_000 }],
        }],
      },
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.status).toBe("ready");
    expect(grid.sources.word_timestamps).toBe(true);
    const wordEvents = grid.events.filter((event) => event.kind === "word_start");
    expect(wordEvents.map((event) => event.word)).toEqual(["go", "orbit"]);
    expect(wordEvents.every((event) => event.asset_id === "AST_MUSIC")).toBe(true);
    expect(wordEvents[0].frame).toBe(Math.round(10_400_000 * 30 / 1_000_000)); // 312
    // Beat events from bgm analysis are present with section membership.
    expect(grid.events.filter((event) => event.kind === "downbeat").length).toBe(1);
    const chorusBeat = grid.events.find((event) => event.frame === 300); // 10s beat at chorus start? 10*30
    expect(chorusBeat?.section_label).toBe("chorus");
    expect(grid.majorSections.map((section) => section.label)).toEqual(["chorus"]);
    expect(grid.majorSections[0].hard_snap).toBe(true);
    expect(grid.majorSections[0].start_frame).toBe(300);
  });

  it("degrades explicitly when bgm analysis is missing or not ready", () => {
    const project = writeProjectfiles({});
    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });
    expect(grid.status).toBe("unavailable");
    expect(grid.degraded_reasons).toContain("bgm_analysis_missing_or_not_ready");
    expect(grid.events).toEqual([]);
    expect(grid.majorSections).toEqual([]);
  });

  it("records the missing word-timestamp evidence for the music asset", () => {
    const project = writeProjectfiles({
      "03_analysis/bgm_analysis.json": bgmAnalysis("AST_MUSIC"),
    });
    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });
    expect(grid.sources.word_timestamps).toBe(false);
    expect(grid.degraded_reasons).toContain("no_word_timestamps_for_music_asset");
  });

  it("returns no words for a transcript whose asset id mismatches the file name", () => {
    const project = writeProjectfiles({
      "03_analysis/transcripts/TR_AST_MUSIC.json": {
        project_id: "rhythm-test",
        artifact_version: "analysis-v1",
        transcript_ref: "TR_AST_MUSIC",
        asset_id: "AST_SOMETHING_ELSE",
        items: [{ speaker: "S", start_us: 0, end_us: 1_000_000, text: "mismatch", words: [{ word: "x", start_us: 0, end_us: 100_000 }] }],
      },
    });
    // Snapshot-first projection: the only public word helper never re-opens
    // a transcript path; words come from the immutable entry snapshot.
    expect(loadMusicAssetWords(snapshotTranscriptsDirectory(project), "AST_MUSIC", { projectId: "rhythm-test" })).toEqual([]);
  });

  it("measures gap and overrun between consecutive clips", () => {
    const tracks = [{
      track_id: "V1", kind: "video" as const,
      clips: [
        makeClip("A", 0, 100),
        makeClip("B", 105, 100), // 5f gap
        makeClip("C", 200, 100), // flush
        makeClip("D", 295, 100), // 5f overrun (overlap)
      ],
    }];
    expect(measureTimelineIntegrity(tracks as never)).toEqual({
      gap_frames: 5,
      overrun_frames: 10,
      boundary_count: 3,
    });
  });
});

// ── Primary V1 scope (two-video-track counterexample) ────────────────

describe("rhythm sync: primary V1 scope", () => {
  it("ignores overlay-track cuts for snapping and parity (two-track counterexample)", () => {
    const chorusStart = 3136;
    const lateV1Cut = chorusStart + 70; // outside the 45f window; V1 parity fails
    const v1Left = makeClip("V1L", 0, lateV1Cut, { beatId: "b_pre" });
    const v1Right = makeClip("V1R", lateV1Cut, 100, { beatId: "b_chorus" });
    // Overlay cut sits nearly on the chorus start: if secondary tracks were
    // parity evidence, the section would fake a pass.
    const overlayLeft = makeClip("V2L", 0, chorusStart + 5, { beatId: "b_pre" });
    const overlayRight = makeClip("V2R", chorusStart + 5, 100, { beatId: "b_overlay" });
    const timeline: AssembledTimeline = {
      tracks: {
        video: [
          { track_id: "V1", kind: "video", clips: [v1Left, v1Right] },
          { track_id: "V2", kind: "video", clips: [overlayLeft, overlayRight] },
        ],
        audio: [],
      },
      markers: [],
    };
    const grid = makeGrid({
      events: [wordEvent(chorusStart)],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
    });

    const metadata = apply(timeline, grid);

    // Parity is measured on V1 only: the well-placed overlay cut must not
    // fake alignment. The V1 cut is 70f past the section start → fail.
    expect(metadata.parity.status).toBe("fail");
    const section = metadata.parity.sections.find((entry) => entry.section_id === "S2");
    expect(section).toMatchObject({ status: "fail", offset_frames: 70, cut_frame: lateV1Cut });

    // Pass 2 never moves secondary tracks; overlay geometry is untouched.
    expect(overlayLeft.timeline_in_frame + overlayLeft.timeline_duration_frames).toBe(chorusStart + 5);
    expect(overlayRight.timeline_in_frame).toBe(chorusStart + 5);
    // And no snap result references the overlay track.
    expect(metadata.snaps.every((snap) => snap.track_id === "V1")).toBe(true);
    expect(metadata.integrity).toMatchObject({ gap_frames: 0, overrun_frames: 0, verified: true });
  });
});

// ── Section-target selection: nearest downbeat ±1.5s, word-start semantics ──

describe("rhythm sync: section target selection", () => {
  it("prefers a strong measured onset over a nearer downbeat", () => {
    const chorusStart = 3136;
    const nearDownbeatBefore = downbeatEvent(chorusStart - 10);
    const nearOnsetAfter = onsetEvent(chorusStart + 3);
    const left = makeClip("L", 0, chorusStart);
    const right = makeClip("R", chorusStart, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [nearDownbeatBefore, nearOnsetAfter],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
      sources: { bgm_analysis: true, word_timestamps: false, beat_count: 2, word_count: 0, section_count: 1 },
    });

    const metadata = apply(timeline, grid, {
      sourceDurations: new Map([["AST_L", 10_000_000_000]]),
    });

    const snap = metadata.snaps.find((entry) => entry.status === "snapped");
    expect(snap).toBeDefined();
    // The onset is a stronger measured cue tier than a downbeat, even though
    // the downbeat is closer. The positive source extension is bounded above.
    expect(snap).toMatchObject({ target_kind: "onset", target_frame: chorusStart + 3 });
    expect(right.timeline_in_frame).toBe(chorusStart + 3);
  });

  it("never selects a word that starts before the section start as the first vocal", () => {
    const chorusStart = 3136;
    // A word head 3f before the section start is tagged to the previous
    // section by the loader (sectionOf assigns by word start time).
    const preSectionWord = { ...wordEvent(chorusStart - 3, "late"), section_id: "S1", section_label: "verse" };
    const sectionDownbeat = { ...downbeatEvent(chorusStart), section_id: "S2", section_label: "chorus" };
    const left = makeClip("L", 0, chorusStart + 5);
    const right = makeClip("R", chorusStart + 5, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [preSectionWord, sectionDownbeat],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
      sources: { bgm_analysis: true, word_timestamps: true, beat_count: 1, word_count: 1, section_count: 1 },
    });

    const metadata = apply(timeline, grid);

    const snap = metadata.snaps.find((entry) => entry.status === "snapped");
    expect(snap).toBeDefined();
    // Word-head semantics: a word beginning before the section start belongs
    // to the previous phrase; the Hard Snap falls to the section downbeat.
    expect(snap).toMatchObject({ target_kind: "downbeat", target_frame: chorusStart });
  });
});

// ── Close-readiness MVP cue policy and decision receipts ────────────

describe("rhythm sync: MVP cue policy", () => {
  it("records selected provenance, confidence, tolerance, and pre/post delta", () => {
    const left = makeClip("L", 0, 100);
    const right = makeClip("R", 100, 100);
    const timeline = makeTimeline([left, right]);
    const metadata = apply(timeline, makeGrid({ events: [onsetEvent(106)], majorSections: [] }), {
      sourceDurations: new Map([[left.asset_id, 10_000_000_000]]),
    });

    expect(metadata.snaps[0]).toMatchObject({
      cut_frame_before: 100,
      cut_frame_after: 106,
      target_frame: 106,
      target_kind: "onset",
      target_provenance: "measured_onset",
      target_confidence: 0.9,
      tolerance_frames: 12,
      shift_frames: 6,
      decision: "snap_applied",
      reason: "selected_cue_within_tolerance",
    });
    expect(metadata.integrity).toMatchObject({ gap_frames: 0, overrun_frames: 0, verified: true });
  });

  it("retains the original boundary and records a truthful low-confidence rejection", () => {
    const left = makeClip("L", 0, 100);
    const right = makeClip("R", 100, 100);
    const timeline = makeTimeline([left, right]);
    const lowConfidenceDownbeat = {
      ...downbeatEvent(100),
      strength: 0.2,
      confidence: 0.2,
    };
    const metadata = apply(timeline, makeGrid({ events: [lowConfidenceDownbeat], majorSections: [] }));

    expect(metadata.snaps[0]).toMatchObject({
      cut_frame_before: 100,
      cut_frame_after: 100,
      target_frame: 100,
      target_kind: "downbeat",
      target_provenance: "measured_downbeat",
      target_confidence: 0.2,
      tolerance_frames: 12,
      shift_frames: 0,
      decision: "rejected",
      reason: "low_confidence_below_threshold",
      skip_reason: "low_confidence",
    });
    expect(metadata.counts.skipped_no_event).toBe(1);
    expect(right.timeline_in_frame).toBe(100);
  });

  it("records the candidate when a section cue is 46 frames outside its tolerance", () => {
    const sectionStart = 100;
    const outsideCue = sectionStart + 46;
    const left = makeClip("L", 0, sectionStart);
    const right = makeClip("R", sectionStart, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const metadata = apply(timeline, makeGrid({
      events: [onsetEvent(outsideCue)],
      majorSections: [{
        id: "S2",
        label: "chorus",
        start_frame: sectionStart,
        end_frame: 400,
        start_sec: sectionStart / 30,
        end_sec: 400 / 30,
        hard_snap: true,
      }],
    }));

    expect(right.timeline_in_frame).toBe(sectionStart);
    expect(metadata.snaps[0]).toMatchObject({
      section_id: "S2",
      cut_frame_before: sectionStart,
      cut_frame_after: sectionStart,
      target_frame: outsideCue,
      target_kind: "onset",
      target_provenance: "measured_onset",
      target_confidence: 0.9,
      tolerance_frames: 45,
      shift_frames: 46,
      decision: "rejected",
      reason: "outside_tolerance",
      skip_reason: "outside_tolerance",
    });
    expect(metadata.parity.sections[0]).toMatchObject({
      status: "degraded",
      reason: "no_rhythm_event_at_section_start",
    });
  });

  it("gives authored lyric onset priority over a closer measured onset", () => {
    const left = makeClip("L", 0, 100);
    const right = makeClip("R", 100, 100);
    const timeline = makeTimeline([left, right]);
    const authored = { ...wordEvent(105, "authored phrase"), provenance: "authored_lyric" as const };
    const metadata = apply(timeline, makeGrid({
      events: [onsetEvent(102), authored],
      majorSections: [chorusSection("S2", 100, 400)],
    }), {
      sourceDurations: new Map([[left.asset_id, 10_000_000_000]]),
    });

    const snap = metadata.snaps.find((entry) => entry.status === "snapped");
    expect(snap).toMatchObject({
      target_frame: 105,
      target_kind: "word_start",
      target_provenance: "authored_lyric",
      target_confidence: 1,
    });
    expect(right.timeline_in_frame).toBe(105);
  });

  it("fails closed on an explicitly locked boundary", () => {
    const left = makeClip("L", 0, 100, { metadata: { boundary_locked: true } });
    const right = makeClip("R", 100, 100);
    const timeline = makeTimeline([left, right]);
    const metadata = apply(timeline, makeGrid({ events: [wordEvent(90)], majorSections: [] }));

    expect(metadata.snaps[0]).toMatchObject({
      status: "skipped",
      decision: "retained",
      reason: "locked_boundary",
      skip_reason: "locked_boundary",
    });
    expect(metadata.counts.skipped_locked_boundary).toBe(1);
    expect(right.timeline_in_frame).toBe(100);
  });

  it("fails closed on a neighboring collision instead of adding another overrun", () => {
    const a = makeClip("A", 0, 100);
    const b = makeClip("B", 100, 100);
    const c = makeClip("C", 190, 100); // existing B→C overrun
    const timeline = makeTimeline([a, b, c]);
    const metadata = apply(timeline, makeGrid({ events: [onsetEvent(90)], majorSections: [] }));

    expect(metadata.snaps[0]).toMatchObject({
      left_clip_id: "A",
      right_clip_id: "B",
      status: "skipped",
      decision: "retained",
      reason: "neighbor_collision",
      skip_reason: "neighbor_collision",
    });
    expect(metadata.counts.skipped_neighbor_collision).toBe(1);
    expect(b.timeline_in_frame).toBe(100);
    expect(metadata.integrity.overrun_frames).toBe(10);
  });
});

// ── Positive source-out bounds ───────────────────────────────────────

describe("rhythm sync: positive source-out bound", () => {
  const chorusStart = 3136;

  function rightwardCase(): { timeline: AssembledTimeline; grid: RhythmEventGrid; left: TimelineClip; right: TimelineClip } {
    // Cut 30f BEFORE the section start → the snap extends the LEFT clip's
    // src_out by +30 frames (~1s).
    const left = makeClip("L", 0, chorusStart);
    const right = makeClip("R", chorusStart, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(chorusStart + 30, "orbit")],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
    });
    return { timeline, grid, left, right };
  }

  it("skips a rightward shift when the left clip's source duration is unknown (fail-open)", () => {
    const { timeline, grid, left, right } = rightwardCase();

    const metadata = apply(timeline, grid);

    expect(metadata.snaps[0]).toMatchObject({ status: "skipped", skip_reason: "source_range_exceeded" });
    expect(metadata.degraded_reasons).toContain("source_duration_unknown:AST_L");
    expect(left.src_out_us).toBe(Math.round(chorusStart * (1_000_000 / 30)));
    expect(right.timeline_in_frame).toBe(chorusStart);
  });

  it("skips an extension that would push src_out past the known media end", () => {
    const { timeline, grid, left } = rightwardCase();
    const tooShort = left.src_out_us + 100_000; // +30f needs ~1_000_000µs

    const metadata = apply(timeline, grid, { sourceDurations: new Map([["AST_L", tooShort]]) });

    expect(metadata.snaps[0]).toMatchObject({ status: "skipped", skip_reason: "source_range_exceeded" });
    expect(metadata.degraded_reasons).toContain("source_out_exceeds_media:AST_L");
    expect(left.src_out_us).toBeLessThanOrEqual(tooShort);
  });

  it("snaps when the extension stays within the known media duration", () => {
    const { timeline, grid, left, right } = rightwardCase();
    const duration = left.src_out_us + 2_000_000;

    const metadata = apply(timeline, grid, { sourceDurations: new Map([["AST_L", duration]]) });

    const snap = metadata.snaps.find((entry) => entry.status === "snapped");
    expect(snap).toBeDefined();
    expect(right.timeline_in_frame).toBe(chorusStart + 30);
    expect(left.src_out_us).toBeLessThanOrEqual(duration);
    expect(metadata.counts.snapped).toBe(1);
  });
});

// ── Zero-snap degradation and counter consistency ────────────────────

describe("rhythm sync: zero-snap degradation", () => {
  it("degrades with an explicit reason when no snap could be applied, keeping counters consistent", () => {
    const chorusStart = 3136;
    const left = makeClip("L", 0, 3160, { metadata: { talking_head_pacing: { snapped_out: true } } });
    const right = makeClip("R", 3160, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(chorusStart)],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
    });

    const metadata = apply(timeline, grid);

    expect(metadata.counts.snapped).toBe(0);
    expect(metadata.status).toBe("degraded");
    expect(metadata.degraded_reasons).toContain("no_snaps_applied");
    // Counters stay consistent: skipped equals the sum of its reasons.
    expect(metadata.counts.skipped).toBe(
      metadata.counts.skipped_speech_protected +
      metadata.counts.skipped_still_image +
      metadata.counts.skipped_min_duration +
      metadata.counts.skipped_source_range +
      metadata.counts.skipped_max_shift +
      metadata.counts.skipped_no_event +
      metadata.counts.skipped_locked_boundary +
      metadata.counts.skipped_neighbor_collision,
    );
    // Degradation never masks the measured parity verdict.
    expect(metadata.parity.status).toBe("fail");
  });
});

// ── Parity recompute after post-snap geometry passes ─────────────────

describe("rhythm sync: parity recompute after geometry passes", () => {
  it("re-measures parity and integrity from post-hold geometry (apex freeze ripple)", () => {
    const chorusStart = 3136;
    const left = makeClip("L", 0, 3160);
    const right = makeClip("R", 3160, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(chorusStart)],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
    });

    const metadata = apply(timeline, grid);
    expect(metadata.parity.status).toBe("pass");
    expect(metadata.parity.sections[0]).toMatchObject({ offset_frames: 0 });

    // Simulate an apex freeze hold on the left clip: it grows by 10 frames
    // and every later clip ripples +10 (as applyApexFreezeHolds does).
    left.timeline_duration_frames += 10;
    right.timeline_in_frame += 10;

    recomputeRhythmParityAndIntegrity(metadata, timeline);

    const section = metadata.parity.sections.find((entry) => entry.section_id === "S2");
    expect(section).toMatchObject({ status: "fail", offset_frames: 10, cut_frame: chorusStart + 10 });
    expect(metadata.parity.status).toBe("fail");
    // The timeline is still flush: Gap 0f / Overrun 0f preserved.
    expect(metadata.integrity).toMatchObject({ gap_frames: 0, overrun_frames: 0, verified: true });
    expect(metadata.parity_recomputed_after_geometry_passes).toBe(true);
  });

  it("measures the acceptance offset against the actual section start, not the snap target", () => {
    const chorusStart = 3136;
    const left = makeClip("L", 0, chorusStart);
    const right = makeClip("R", chorusStart, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordEvent(chorusStart + 30, "orbit")],
      majorSections: [chorusSection("S2", chorusStart, 3600)],
    });

    // The cut lands exactly on the word head (the snap did its job), but the
    // vocal head itself sits 30f after the section start: parity must report
    // the honest 30f offset against the section start, not a fake pass.
    const metadata = apply(timeline, grid, {
      sourceDurations: new Map([["AST_L", left.src_out_us + 5_000_000]]),
    });

    const section = metadata.parity.sections.find((entry) => entry.section_id === "S2");
    expect(section).toMatchObject({
      status: "fail",
      section_start_frame: chorusStart,
      target_frame: chorusStart + 30,
      target_offset_frames: 30,
      offset_frames: 30,
      cut_frame: chorusStart + 30,
    });
    expect(metadata.parity.status).toBe("fail");
  });
});

// ── Rational fps math (hostile 30000/1001) ───────────────────────────

describe("rhythm sync: rational fps math (hostile 30000/1001)", () => {
  const FPS = { num: 30000, den: 1001 };
  // 29.97fps: one frame ≈ 33366.67µs — naive 1e6/fpsNum math drifts here.
  const usOf = (frames: number) => Math.round(frames * 1_000_000 * FPS.den / FPS.num);

  it("maps 1s to 30 frames and ±1.5s to 45 frames at 30000/1001", () => {
    expect(secondsToRhythmFrame(1, FPS.num, FPS.den)).toBe(30);
    expect(usToRhythmFrame(1_000_000, FPS.num, FPS.den)).toBe(30);
    expect(secondsToRhythmFrame(1.5, FPS.num, FPS.den)).toBe(45);
    // Frame→µs round trip is frame-exact, not the naive 1e6/30000=33333µs.
    expect(rhythmFramesToUs(30, FPS.num, FPS.den)).toBe(1_001_000);
  });

  it("hard-snaps a chorus cut onto a word head at 1s with frame- and µs-exact source shifts", () => {
    // Chorus + first vocal at 1s (frame 30); cut sits at 2s (frame 60).
    const wordHead = {
      frame: 30, time_sec: 1, us: 1_000_000,
      kind: "word_start" as const, word: "orbit", asset_id: "AST_MUSIC",
    };
    const left = makeClip("L", 0, 60, { beatId: "b_pre" });
    const right = makeClip("R", 60, 100, { beatId: "b_chorus" });
    left.src_in_us = 0;
    left.src_out_us = usOf(60);
    right.src_in_us = usOf(60);
    right.src_out_us = usOf(160);
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordHead],
      majorSections: [{
        id: "S2", label: "chorus",
        start_frame: 30, end_frame: 600, start_sec: 1, end_sec: 20, hard_snap: true,
      }],
    });

    const metadata = apply(timeline, grid, { fpsNum: FPS.num, fpsDen: FPS.den });

    const snap = metadata.snaps.find((entry) => entry.status === "snapped");
    expect(snap).toBeDefined();
    expect(snap).toMatchObject({ target_frame: 30, cut_frame_before: 60, cut_frame_after: 30, shift_frames: -30 });
    // The right clip's source head lands on frame 30 exactly (1_001_000µs);
    // naive 1e6/fpsNum math would leave it at 1_002_000µs — a 1ms drift.
    expect(right.timeline_in_frame).toBe(30);
    expect(right.src_in_us).toBe(usOf(30));
    expect(metadata.parity.status).toBe("pass");
    expect(metadata.parity.sections[0]).toMatchObject({ status: "pass", section_start_frame: 30, cut_frame: 30, offset_frames: 0 });
    expect(metadata.integrity).toMatchObject({ gap_frames: 0, overrun_frames: 0, verified: true });
  });

  it("keeps ±1.5s honest: a boundary 46 frames (1.53s) away is outside the window", () => {
    const wordHead = {
      frame: 30, time_sec: 1, us: 1_000_000,
      kind: "word_start" as const, word: "orbit", asset_id: "AST_MUSIC",
    };
    const left = makeClip("L", 0, 76, { beatId: "b_pre" });
    const right = makeClip("R", 76, 100, { beatId: "b_chorus" });
    const timeline = makeTimeline([left, right]);
    const grid = makeGrid({
      events: [wordHead],
      majorSections: [{
        id: "S2", label: "chorus",
        start_frame: 30, end_frame: 600, start_sec: 1, end_sec: 20, hard_snap: true,
      }],
    });

    const metadata = apply(timeline, grid, { fpsNum: FPS.num, fpsDen: FPS.den });

    // 46 frames = 1.5349s at 29.97fps: beyond ±1.5s, so nothing snaps and the
    // honest section-start offset is measured and fails the parity window.
    expect(metadata.counts.snapped).toBe(0);
    expect(right.timeline_in_frame).toBe(76);
    expect(metadata.degraded_reasons).toContain("section_no_boundary_in_window:S2");
    expect(metadata.parity.status).toBe("fail");
    expect(metadata.parity.sections[0]).toMatchObject({ status: "fail", section_start_frame: 30, cut_frame: 76, offset_frames: 46 });
  });
});

// ── Evidence binding: foreign/tampered artifacts are rejected ────────

describe("rhythm sync: evidence binding", () => {
  const TMP_ROOT = path.join("tests", "tmp_rhythm_sync_binding");
  // Fixed fixture media content → deterministic analyzer head-hash.
  const FIXTURE_MEDIA = "fake-pcm-bytes-v1";
  const FIXTURE_MEDIA_HASH = createHash("sha256").update(FIXTURE_MEDIA).digest("hex").slice(0, 16);

  afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  function writeProjectFiles(files: Record<string, unknown>): string {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    // Fixture media is always present so hash-matching fixtures can bind.
    fs.mkdirSync(path.join(TMP_ROOT, "02_media"), { recursive: true });
    fs.writeFileSync(path.join(TMP_ROOT, "02_media/bgm.wav"), FIXTURE_MEDIA);
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(TMP_ROOT, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const raw = typeof content === "string" ? content : JSON.stringify(content, null, 2);
      fs.writeFileSync(target, raw, "utf-8");
    }
    return TMP_ROOT;
  }

  function sha256File(filePath: string): string {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  }

  const bgm = (overrides: Record<string, unknown> = {}) => ({
    version: "1",
    project_id: "rhythm-test",
    analysis_status: "ready",
    music_asset: {
      asset_id: "AST_MUSIC",
      path: "02_media/bgm.wav",
      source_hash: FIXTURE_MEDIA_HASH,
    },
    bpm: 120,
    meter: "4/4",
    duration_sec: 30,
    beats_sec: [2, 4, 6],
    downbeats_sec: [4],
    sections: [
      { id: "S1", label: "verse", start_sec: 0, end_sec: 10, energy: 0.4 },
      { id: "S2", label: "chorus", start_sec: 10, end_sec: 20, energy: 0.9 },
    ],
    provenance: { detector: "fixture-detector", sample_rate_hz: 44100 },
    ...overrides,
  });

  const transcript = (overrides: Record<string, unknown> = {}) => ({
    project_id: "rhythm-test",
    artifact_version: "analysis-v1",
    transcript_ref: "TR_AST_MUSIC",
    asset_id: "AST_MUSIC",
    word_timing_mode: "word",
    items: [{ speaker: "V", start_us: 10_000_000, end_us: 11_000_000, text: "orbit", words: [{ word: "orbit", start_us: 10_000_000, end_us: 10_500_000 }] }],
    ...overrides,
  });

  it("rejects bgm evidence stamped with a foreign project id", () => {
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm({ project_id: "another-project" }),
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.status).toBe("unavailable");
    expect(grid.sources.bgm_analysis).toBe(false);
    expect(grid.events).toEqual([]);
    expect(grid.majorSections).toEqual([]);
    expect(grid.degraded_reasons).toContain("bgm_analysis_project_id_mismatch");
    expect(grid.evidence).toMatchObject({ binding: "degraded", project_id: "another-project" });
    expect(grid.evidence.binding_failures).toContain("bgm_analysis_project_id_mismatch");
  });

  it("rejects bgm evidence whose recorded source hash disagrees with the media on disk", () => {
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm({ music_asset: { asset_id: "AST_MUSIC", path: "02_media/bgm.wav", source_hash: "0123456789abcdef" } }),
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.status).toBe("unavailable");
    expect(grid.degraded_reasons).toContain("bgm_music_source_hash_mismatch");
    expect(grid.evidence.binding).toBe("degraded");
    expect(grid.sources.bgm_analysis).toBe(false);
    expect(grid.events).toEqual([]);
  });

  it("binds matching evidence and stamps artifact path/origin/source/detector provenance", () => {
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm(),
      "03_analysis/transcripts/TR_AST_MUSIC.json": transcript(),
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.status).toBe("ready");
    expect(grid.evidence.binding).toBe("bound");
    expect(grid.evidence.binding_failures).toEqual([]);
    expect(grid.evidence).toMatchObject({
      project_id: "rhythm-test",
      bgm_artifact_path: "03_analysis/bgm_analysis.json",
      bgm_artifact_origin: "primary",
      bgm_source_sha256: FIXTURE_MEDIA_HASH,
      bgm_detector: "fixture-detector",
      bgm_sample_rate_hz: 44100,
      transcript_asset_id: "AST_MUSIC",
    });
    expect(grid.evidence.bgm_artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(grid.evidence.transcript_artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The stamped provenance flows through the snap pass into the metadata.
    const left = makeClip("L", 0, 200);
    const right = makeClip("R", 200, 100);
    const timeline = makeTimeline([left, right]);
    const metadata = apply(timeline, grid);
    expect(metadata.evidence_provenance).toEqual(grid.evidence);
  });

  it("snapshots canonical authored lyric line starts and exposes their identity", () => {
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm(),
    });
    const lyricPath = path.join(project, "01_intent/lyrics.lrc");
    const lyricBytes = "[00:10.00] authored phrase\n[00:12.00] next phrase\n";
    fs.mkdirSync(path.dirname(lyricPath), { recursive: true });
    fs.writeFileSync(lyricPath, lyricBytes, "utf8");

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });
    const authored = grid.events.find((event) => event.provenance === "authored_lyric");
    expect(authored).toMatchObject({
      frame: 300,
      kind: "word_start",
      word: "authored phrase",
      confidence: 1,
      asset_id: MUSIC_ASSET,
    });
    expect(grid.sources).toMatchObject({ authored_lyric: true, authored_lyric_count: 2 });
    expect(grid.evidence).toMatchObject({
      authored_lyric_artifact_path: "01_intent/lyrics.lrc",
      authored_lyric_artifact_sha256: createHash("sha256").update(lyricBytes).digest("hex"),
    });
  });

  it("does not revive untyped downbeats_sec from an admitted M2 artifact", () => {
    const project = writeProjectFiles({});
    const sourceHash = createHash("sha256").update("fake-pcm-bytes-v1").digest("hex");
    const measuredCue = (time_sec: number, strength = 0.9) => ({
      time_sec,
      strength,
      evidence_classification: "measured" as const,
    });
    const m2Bgm = {
      version: "1",
      project_id: "rhythm-test",
      analysis_status: "ready",
      music_asset: {
        asset_id: "AST_MUSIC",
        path: "02_media/bgm.wav",
        source_hash: sourceHash,
        source_content_sha256: sourceHash,
      },
      bpm: 120,
      meter: "unknown",
      duration_sec: 30,
      beats_sec: [10],
      // This untyped projection has no per-cue confidence and must not be
      // promoted by rhythm-sync once the M2 contract is in force.
      downbeats_sec: [10],
      beats: [measuredCue(10)],
      onsets: [measuredCue(10.1)],
      sections: [{
        id: "S2", label: "chorus", start_sec: 10, end_sec: 20, energy: 0.9,
        evidence_classification: "measured" as const,
      }],
      provenance: {
        detector: "fixture",
        backend_name: "fixture",
        backend_version: "1",
        input_sample_rate_hz: 16_000,
        processing_sample_rate_hz: 16_000,
        hop_length_samples: 512,
        window_length_samples: 1024,
        time_unit: "seconds" as const,
        evidence_classification: "measured" as const,
        measurement_status: "complete" as const,
        tempo_confidence: 0.9,
        fallback_used: false,
        source_content_sha256: sourceHash,
      },
    };
    fs.mkdirSync(path.join(project, "03_analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(project, "03_analysis/bgm_analysis.json"),
      JSON.stringify(m2Bgm, null, 2),
      "utf8",
    );

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });
    expect(grid.evidence.binding).toBe("bound");
    expect(grid.events.some((event) => event.kind === "onset")).toBe(true);
    expect(grid.events.some((event) => event.kind === "downbeat")).toBe(false);
  });

  it("rejects bgm evidence when the recorded music media is missing (source unverifiable)", () => {
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm({
        music_asset: { asset_id: "AST_MUSIC", path: "02_media/missing.wav", source_hash: FIXTURE_MEDIA_HASH },
      }),
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    // Fail-closed: unverifiable identity means the evidence is NOT adopted.
    expect(grid.status).toBe("unavailable");
    expect(grid.sources.bgm_analysis).toBe(false);
    expect(grid.events).toEqual([]);
    expect(grid.evidence.binding).toBe("degraded");
    expect(grid.degraded_reasons).toContain("bgm_music_source_unverifiable");
  });

  it("rejects bgm evidence with a missing project id (fail-closed)", () => {
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm({ project_id: undefined }),
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.status).toBe("unavailable");
    expect(grid.sources.bgm_analysis).toBe(false);
    expect(grid.events).toEqual([]);
    expect(grid.majorSections).toEqual([]);
    expect(grid.degraded_reasons).toContain("bgm_project_id_missing");
    expect(grid.evidence.binding).toBe("degraded");
    expect(grid.evidence.binding_failures).toContain("bgm_project_id_missing");
  });

  it("rejects bgm evidence with a missing source hash (fail-closed)", () => {
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm({
        music_asset: { asset_id: "AST_MUSIC", path: "02_media/bgm.wav", source_hash: undefined },
      }),
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.status).toBe("unavailable");
    expect(grid.sources.bgm_analysis).toBe(false);
    expect(grid.events).toEqual([]);
    expect(grid.degraded_reasons).toContain("bgm_source_hash_missing");
    expect(grid.evidence.binding).toBe("degraded");
  });

  it("rejects word timestamps with a missing transcript project id (fail-closed)", () => {
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm(),
      "03_analysis/transcripts/TR_AST_MUSIC.json": transcript({ project_id: undefined }),
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.sources.word_timestamps).toBe(false);
    expect(grid.sources.word_count).toBe(0);
    // A missing project_id is a CANONICAL transcript.schema.json failure
    // (required field) — recorded with deterministic schema failure details.
    expect(grid.degraded_reasons.some((reason) => reason.startsWith("transcript_schema_invalid:") && reason.includes("project_id"))).toBe(true);
    expect(grid.evidence.binding).toBe("degraded");
    expect(grid.evidence.transcripts?.[0]?.failures.every((failure) => failure.startsWith("transcript_schema_invalid:"))).toBe(true);
    // BGM beats stay bound, but the grid must never claim "ready" while the
    // transcript identity failed.
    expect(grid.status).not.toBe("ready");
    expect(grid.status).toBe("partial");
  });

  it("rejects word timestamps with a missing transcript asset id (fail-closed)", () => {
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm(),
      "03_analysis/transcripts/TR_AST_MUSIC.json": transcript({ asset_id: undefined }),
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.sources.word_timestamps).toBe(false);
    // A missing asset_id is a CANONICAL transcript.schema.json failure
    // (required field) — recorded with deterministic schema failure details.
    expect(grid.degraded_reasons.some((reason) => reason.startsWith("transcript_schema_invalid:") && reason.includes("asset_id"))).toBe(true);
    expect(grid.evidence.binding).toBe("degraded");
  });

  it("rejects schema-invalid music transcripts via the canonical transcript.schema.json authority", () => {
    // artifact_version missing: canonical schema failure, never projected.
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm(),
      "03_analysis/transcripts/TR_AST_MUSIC.json": transcript({ artifact_version: undefined }),
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.sources.word_timestamps).toBe(false);
    expect(grid.sources.word_count).toBe(0);
    expect(grid.evidence.binding).toBe("degraded");
    const record = grid.evidence.transcripts?.find((entry) => entry.path === "03_analysis/transcripts/TR_AST_MUSIC.json");
    expect(record).toBeDefined();
    expect(record?.binding).toBe("degraded");
    expect(record?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.failures.length).toBeGreaterThan(0);
    for (const failure of record?.failures ?? []) {
      expect(failure.startsWith("transcript_schema_invalid:")).toBe(true);
    }
    expect(grid.degraded_reasons.some((reason) => reason.startsWith("transcript_schema_invalid:"))).toBe(true);
    // The schema failure itself is the reason words were not consumed.
    expect(grid.degraded_reasons).not.toContain("no_word_timestamps_for_music_asset");
  });

  it("records the legacy fallback actually consumed when the primary is stale (single truth)", () => {
    // Stale/unready primary + valid legacy fallback: provenance must record
    // the fallback path/hash — never fake the primary artifact's SHA.
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm({ analysis_status: "failed" }),
      "07_package/audio/bgm-analysis.json": bgm(),
      "03_analysis/transcripts/TR_AST_MUSIC.json": transcript(),
    });
    const legacySha = sha256File(path.join(project, "07_package/audio/bgm-analysis.json"));
    const primarySha = sha256File(path.join(project, "03_analysis/bgm_analysis.json"));

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.status).toBe("ready");
    expect(grid.evidence.binding).toBe("bound");
    expect(grid.evidence.bgm_artifact_origin).toBe("legacy_fallback");
    expect(grid.evidence.bgm_artifact_path).toBe("07_package/audio/bgm-analysis.json");
    expect(grid.evidence.bgm_artifact_sha256).toBe(legacySha);
    // Never stamp the primary SHA when the fallback was consumed.
    expect(grid.evidence.bgm_artifact_sha256).not.toBe(primarySha);
    expect(grid.events.length).toBeGreaterThan(0);
  });

  it("rejects a music transcript stamped with a foreign project id", () => {
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm(),
      "03_analysis/transcripts/TR_AST_MUSIC.json": transcript({ project_id: "another-project" }),
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.sources.word_timestamps).toBe(false);
    // The project mismatch carries the deterministic detail after the rule
    // (the same central authority failure repository validation reports).
    expect(grid.degraded_reasons.some((reason) => reason.startsWith("transcript_project_id_mismatch:"))).toBe(true);
    expect(grid.evidence.binding).toBe("degraded");
  });

  it("filters malformed section entries explicitly", () => {
    const project = writeProjectFiles({
      "03_analysis/bgm_analysis.json": bgm({
        sections: [
          { id: "S1", label: "verse", start_sec: 0, end_sec: 10 },
          { id: "S2", label: "chorus", start_sec: "not-a-number", end_sec: 20 },
          null,
        ],
      }),
    });

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test" });

    expect(grid.majorSections).toEqual([]);
    expect(grid.degraded_reasons).toContain("bgm_malformed_sections_filtered");
    expect(grid.degraded_reasons).toContain("no_major_sections_in_bgm_analysis");
    // Malformed entries are a parsing degradation — identity still binds.
    expect(grid.evidence.binding).toBe("bound");
  });
});
