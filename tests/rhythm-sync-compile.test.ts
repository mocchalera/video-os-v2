import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile } from "../runtime/compiler/index.js";
import { RhythmParityGateError } from "../runtime/compiler/errors.js";
import { runPatch } from "../scripts/compile-timeline.js";
import { computeArtifactSha256 } from "../runtime/review/edit-identity.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { computeMediaHeadSourceHash, computeMediaSourceHash } from "../runtime/media/bgm-analyzer.js";
import type { TimelineIR } from "../runtime/compiler/types.js";
import { validateProject } from "../scripts/validate-schemas.js";

// Issue #35 integration: the canonical compile route must turn rhythm
// evidence (03_analysis/bgm_analysis.json + word-level music transcript)
// into snapped timeline.json geometry — not just metadata.

const SAMPLE_PROJECT = path.resolve("projects/sample");
const FIXED_CREATED_AT = "2026-08-29T00:00:00Z";
const TMP_ROOT = path.join("tests", "tmp_rhythm_compile");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function copySample(name: string): string {
  const dir = path.join(TMP_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(SAMPLE_PROJECT, dir, { recursive: true });
  const timelinePath = path.join(dir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) fs.rmSync(timelinePath);
  return dir;
}

/**
 * Write the fixture BGM media + analysis artifact. The compile route binds
 * evidence fail-closed, so the fixture media file must exist and the
 * recorded source hash must match it (analyzer head-sha256 scheme).
 */
function writeBgmAnalysis(dir: string, options: { withSections?: boolean } = {}): void {
  fs.mkdirSync(path.join(dir, "02_media"), { recursive: true });
  fs.writeFileSync(path.join(dir, "02_media/bgm-test.wav"), "fixture-bgm-media-bytes-v1");
  const bgm: Record<string, unknown> = {
    version: "1",
    project_id: "sample-mountain-reset",
    analysis_status: "ready",
    music_asset: {
      asset_id: "AST_MUSICTEST",
      path: "02_media/bgm-test.wav",
      source_hash: computeMediaHeadSourceHash(path.join(dir, "02_media/bgm-test.wav")),
    },
    bpm: 120,
    meter: "4/4",
    duration_sec: 30,
    beats_sec: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28],
    downbeats_sec: [0, 4, 8, 12, 16, 20, 24, 28],
    sections: options.withSections === false ? [] : [
      { id: "S1", label: "intro", start_sec: 0, end_sec: 4.6, energy: 0.3 },
      { id: "S2", label: "chorus", start_sec: 4.6, end_sec: 20, energy: 0.9 },
      { id: "S3", label: "outro", start_sec: 20, end_sec: 30, energy: 0.4 },
    ],
    provenance: { detector: "fixture", sample_rate_hz: 44100 },
  };
  fs.writeFileSync(path.join(dir, "03_analysis/bgm_analysis.json"), JSON.stringify(bgm, null, 2));
}

/** M2 fixture with a single typed measured cue. */
function writeLowConfidenceM2Bgm(dir: string, options: {
  cueSec?: number;
  cueStrength?: number;
  sectionStartSec?: number;
  sectionLabel?: string;
} = {}): void {
  fs.mkdirSync(path.join(dir, "02_media"), { recursive: true });
  const mediaPath = path.join(dir, "02_media/bgm-test.wav");
  fs.writeFileSync(mediaPath, "fixture-bgm-media-bytes-v1");
  const sourceHash = computeMediaSourceHash(mediaPath);
  const cueSec = options.cueSec ?? 4.25;
  const sectionStartSec = options.sectionStartSec ?? 0;
  const lowCue = {
    time_sec: cueSec,
    strength: options.cueStrength ?? 0.2,
    evidence_classification: "measured",
  };
  const bgm = {
    version: "1",
    project_id: "sample-mountain-reset",
    analysis_status: "ready",
    music_asset: {
      asset_id: "AST_MUSICTEST",
      path: "02_media/bgm-test.wav",
      source_hash: sourceHash,
      source_content_sha256: sourceHash,
    },
    bpm: 120,
    meter: "unknown",
    duration_sec: 30,
    // The legacy projection mirrors the typed cue; guarded M2 compilation
    // must admit only the typed measured event.
    beats_sec: [cueSec],
    downbeats_sec: [cueSec],
    sections: [{
      id: "S1",
      label: options.sectionLabel ?? "intro",
      start_sec: sectionStartSec,
      end_sec: 30,
      energy: 0.2,
      evidence_classification: "measured",
    }],
    beats: [lowCue],
    onsets: [lowCue],
    provenance: {
      detector: "fixture",
      backend_name: "fixture",
      backend_version: "1",
      input_sample_rate_hz: 16_000,
      processing_sample_rate_hz: 16_000,
      hop_length_samples: 512,
      window_length_samples: 1024,
      time_unit: "seconds",
      evidence_classification: "measured",
      measurement_status: "complete",
      tempo_confidence: 0.9,
      fallback_used: false,
      source_content_sha256: sourceHash,
    },
  };
  fs.writeFileSync(path.join(dir, "03_analysis/bgm_analysis.json"), JSON.stringify(bgm, null, 2));
}

function writeMusicTranscript(dir: string): void {
  const transcript = {
    project_id: "sample-mountain-reset",
    artifact_version: "analysis-v1",
    transcript_ref: "TR_AST_MUSICTEST",
    asset_id: "AST_MUSICTEST",
    word_timing_mode: "word",
    items: [{
      speaker: "VOCALS",
      start_us: 4_600_000,
      end_us: 6_000_000,
      text: "orbit tonight",
      words: [
        { word: "orbit", start_us: 4_600_000, end_us: 5_100_000 },
        { word: "tonight", start_us: 5_400_000, end_us: 5_900_000 },
      ],
    }],
  };
  fs.writeFileSync(
    path.join(dir, "03_analysis/transcripts/TR_AST_MUSICTEST.json"),
    JSON.stringify(transcript, null, 2),
  );
}

function v1Geometry(timeline: { tracks: { video: Array<{ clips: Array<{ clip_id: string; timeline_in_frame: number; timeline_duration_frames: number }> }> } }): string {
  const clips = timeline.tracks.video[0].clips;
  return clips.map((clip) => `${clip.clip_id}@${clip.timeline_in_frame}+${clip.timeline_duration_frames}`).join("|");
}

afterAll(() => {
  // Task-owned files must be absent after the tests (tracked and ignored).
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  expect(fs.existsSync(TMP_ROOT)).toBe(false);
});

describe("rhythm sync compile (Issue #35 canonical route)", () => {
  it("snaps the chorus cut onto the first vocal word head in the compiled timeline.json", () => {
    const dir = copySample("chorus-snap");
    writeBgmAnalysis(dir);
    writeMusicTranscript(dir);

    const result = compile({ projectPath: dir, createdAt: FIXED_CREATED_AT });
    const timeline = result.timeline;
    expect(timeline.metadata?.rhythm_sync).toBeDefined();
    const rhythmSync = timeline.metadata!.rhythm_sync as Record<string, any>;

    expect(rhythmSync.enabled).toBe(true);
    expect(rhythmSync.status).toBe("applied");
    expect(rhythmSync.sources).toMatchObject({ bgm_analysis: true, word_timestamps: true });
    expect(rhythmSync.counts.hard_snapped).toBe(1);

    const hardSnap = rhythmSync.snaps.find((snap: any) => snap.hard_snap);
    expect(hardSnap).toBeDefined();
    expect(hardSnap).toMatchObject({
      section_label: "chorus",
      target_kind: "word_start",
      target_word: "orbit",
      // 4.6s at 24fps = 110.4 → frame 110; the pre-snap cut was at 96 (4.0s).
      target_frame: 110,
      cut_frame_before: 96,
      cut_frame_after: 110,
      shift_frames: 14,
      status: "snapped",
    });

    // AC1: the compiled V1 geometry carries the snapped boundary.
    const clips = timeline.tracks.video[0].clips;
    const left = clips.find((clip: any) => clip.clip_id === hardSnap.left_clip_id)!;
    const right = clips.find((clip: any) => clip.clip_id === hardSnap.right_clip_id)!;
    expect(left.timeline_in_frame + left.timeline_duration_frames).toBe(110);
    expect(right.timeline_in_frame).toBe(110);

    // AC2: gap 0f / overrun 0f verified after snapping; timeline stays flush.
    expect(rhythmSync.integrity).toMatchObject({ gap_frames: 0, overrun_frames: 0, verified: true });
    for (let i = 0; i < clips.length - 1; i += 1) {
      expect(clips[i].timeline_in_frame + clips[i].timeline_duration_frames)
        .toBe(clips[i + 1].timeline_in_frame);
    }

    // Parity gate: chorus offset 0f → pass.
    expect(rhythmSync.parity.status).toBe("pass");
    expect(rhythmSync.parity.sections[0]).toMatchObject({
      section_id: "S2", label: "chorus", status: "pass", offset_frames: 0, target_frame: 110,
    });

    // Beat markers follow the snapped geometry.
    const marker = timeline.markers.find((entry: any) => entry.label.startsWith("b02"))!;
    expect(marker.frame).toBe(110);

    // Compile-level gap invariant still holds.
    expect(result.resolution.gap_frames).toBe(0);
  });

  it("carries the same ±2-frame parity contract into preview-manifest.json and beat-allocation-report.json", () => {
    const dir = copySample("preview-parity");
    writeBgmAnalysis(dir);
    writeMusicTranscript(dir);

    const result = compile({ projectPath: dir, createdAt: FIXED_CREATED_AT });
    const timelineMetadata = (result.timeline.metadata as Record<string, any>).rhythm_sync;

    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "05_timeline/preview-manifest.json"), "utf-8"),
    );
    expect(manifest.rhythm_sync).toBeDefined();
    expect(manifest.rhythm_sync).toMatchObject({
      version: "1",
      enabled: true,
      parity_status: "pass",
      parity_max_offset_frames: 2,
    });
    // Preview and final agree on the parity verdict and section offsets.
    expect(manifest.rhythm_sync.sections).toEqual(timelineMetadata.parity.sections);
    expect(manifest.rhythm_sync.integrity).toEqual(timelineMetadata.integrity);

    // The operator report keeps gap 0f after the snap (overrun semantics in
    // guide mode are pre-existing and unrelated to snapping).
    expect(result.beat_allocation_report?.gap_frames).toBe(0);
  });

  it("passes Gate 2 schema validation with rhythm metadata stamped", () => {
    const dir = copySample("schema-gate");
    writeBgmAnalysis(dir);
    writeMusicTranscript(dir);
    compile({ projectPath: dir, createdAt: FIXED_CREATED_AT });

    const validation = validateProject(dir);
    const violations = validation.violations.filter((v) => v.artifact === "05_timeline/timeline.json");
    expect(violations).toEqual([]);
    expect(validation.gate2_timeline_valid).toBe(true);
  });

  it("does not pre-quantize an M2 low-confidence cue, while route-off keeps legacy compatibility", () => {
    const guardedDir = copySample("low-confidence-prequantization-guarded");
    writeLowConfidenceM2Bgm(guardedDir);

    const guarded = compile({ projectPath: guardedDir, createdAt: FIXED_CREATED_AT });
    const guardedRhythm = guarded.timeline.metadata!.rhythm_sync as Record<string, any>;
    const guardedReceipt = guardedRhythm.snaps.find((snap: any) => snap.cut_frame_before === 96);

    expect(guardedReceipt).toMatchObject({
      cut_frame_before: 96,
      cut_frame_after: 96,
      target_frame: 102,
      target_kind: "onset",
      target_provenance: "measured_onset",
      target_confidence: 0.2,
      tolerance_frames: 12,
      decision: "rejected",
      reason: "low_confidence_below_threshold",
      skip_reason: "low_confidence",
    });
    expect(guarded.timeline.tracks.video[0].clips.some((clip: any) =>
      clip.timeline_in_frame + clip.timeline_duration_frames === 102,
    )).toBe(false);
    expect(guarded.timeline.tracks.video[0].clips.some((clip: any) =>
      clip.timeline_in_frame + clip.timeline_duration_frames === 96,
    )).toBe(true);
    expect(guarded.timeline.metadata?.beat_sync).toBeUndefined();

    const legacyDir = copySample("low-confidence-prequantization-legacy");
    writeLowConfidenceM2Bgm(legacyDir);
    const legacy = compile({
      projectPath: legacyDir,
      createdAt: FIXED_CREATED_AT,
      defaultsOverride: { rhythm_sync: { mode: "off" } },
    });
    const legacyBeatSync = legacy.timeline.metadata?.beat_sync as Record<string, any>;
    expect(legacyBeatSync).toMatchObject({ enabled: true, source: "bgm_analysis" });
    expect(legacyBeatSync.boundaries).toContainEqual(expect.objectContaining({
      cut_frame_before: 96,
      cut_frame_after: 102,
      status: "quantized",
    }));
    expect((legacy.timeline.metadata!.rhythm_sync as Record<string, any>).enabled).toBe(false);
  });

  it("keeps 45f/46f section-cue receipts on the public compile path", () => {
    const insideDir = copySample("section-cue-45f-inside");
    writeLowConfidenceM2Bgm(insideDir, {
      cueSec: 96 / 24,
      cueStrength: 0.9,
      sectionStartSec: 51 / 24,
      sectionLabel: "chorus",
    });
    const inside = compile({
      projectPath: insideDir,
      createdAt: FIXED_CREATED_AT,
      defaultsOverride: {
        rhythm_sync: { mode: "auto", search_window_sec: 45 / 24, max_shift_frames: 12, parity_max_offset_frames: 2, parity_gate: "off" },
      },
    });
    const insideRhythm = inside.timeline.metadata!.rhythm_sync as Record<string, any>;
    expect(insideRhythm.snaps.find((snap: any) => snap.cut_frame_before === 96)).toMatchObject({
      section_id: "S1",
      section_snap: true,
      tolerance_frames: 45,
      target_frame: 96,
      target_provenance: "measured_onset",
      target_confidence: 0.9,
    });

    const outsideDir = copySample("section-cue-46f-outside");
    writeLowConfidenceM2Bgm(outsideDir, {
      cueSec: 96 / 24,
      cueStrength: 0.9,
      sectionStartSec: 50 / 24,
      sectionLabel: "chorus",
    });
    const outside = compile({
      projectPath: outsideDir,
      createdAt: FIXED_CREATED_AT,
      defaultsOverride: {
        rhythm_sync: { mode: "auto", search_window_sec: 45 / 24, max_shift_frames: 12, parity_max_offset_frames: 2, parity_gate: "off" },
      },
    });
    const outsideRhythm = outside.timeline.metadata!.rhythm_sync as Record<string, any>;
    const outsideReceipt = outsideRhythm.snaps.find((snap: any) => snap.cut_frame_before === 96);
    expect(outsideReceipt).toMatchObject({
      section_id: "S1",
      section_snap: true,
      cut_frame_before: 96,
      cut_frame_after: 96,
      target_frame: 96,
      target_kind: "onset",
      target_provenance: "measured_onset",
      target_confidence: 0.9,
      tolerance_frames: 45,
      shift_frames: 0,
      decision: "rejected",
      reason: "outside_tolerance",
      skip_reason: "outside_tolerance",
    });
    expect(outsideReceipt.tolerance_frames).not.toBe(12);
  });

  it("rejects incomplete or unknown rhythm receipt fields at the timeline schema gate", () => {
    const dir = copySample("rhythm-receipt-schema-shape");
    writeBgmAnalysis(dir);
    writeMusicTranscript(dir);
    const timeline = compile({ projectPath: dir, createdAt: FIXED_CREATED_AT }).timeline;
    expect(validateAgainstSchema(timeline, "timeline-ir.schema.json").valid).toBe(true);

    const missingTarget = JSON.parse(JSON.stringify(timeline)) as TimelineIR;
    const missingRhythm = missingTarget.metadata!.rhythm_sync as Record<string, any>;
    const snap = missingRhythm.snaps.find((entry: any) => entry.decision === "snap_applied");
    expect(snap).toBeDefined();
    delete snap.target_provenance;
    expect(validateAgainstSchema(missingTarget, "timeline-ir.schema.json").valid).toBe(false);

    const unknownField = JSON.parse(JSON.stringify(timeline)) as TimelineIR;
    const unknownRhythm = unknownField.metadata!.rhythm_sync as Record<string, any>;
    unknownRhythm.snaps[0].unknown_receipt_field = true;
    expect(validateAgainstSchema(unknownField, "timeline-ir.schema.json").valid).toBe(false);
  });

  it("is deterministic across recompiles", () => {
    const dir = copySample("determinism");
    writeBgmAnalysis(dir);
    writeMusicTranscript(dir);

    const first = compile({ projectPath: dir, createdAt: FIXED_CREATED_AT });
    const second = compile({ projectPath: dir, createdAt: FIXED_CREATED_AT });
    expect(JSON.stringify(first.timeline)).toBe(JSON.stringify(second.timeline));
  });

  it("degrades explicitly without rhythm evidence and never moves geometry", () => {
    const dir = copySample("fail-open");

    const result = compile({ projectPath: dir, createdAt: FIXED_CREATED_AT });
    const rhythmSync = (result.timeline.metadata as Record<string, any>).rhythm_sync;

    expect(rhythmSync).toMatchObject({
      enabled: false,
      status: "degraded",
      disabled_reason: "no_rhythm_events",
    });
    expect(rhythmSync.degraded_reasons).toContain("bgm_analysis_missing_or_not_ready");
    expect(rhythmSync.snaps).toEqual([]);
    expect(rhythmSync.parity.status).toBe("degraded");
    expect(rhythmSync.integrity.verified).toBe(false);
  });

  it("leaves baseline geometry untouched when rhythm evidence is absent", () => {
    // Two independent compiles of the sample project without rhythm
    // artifacts: the pass must be inert, so geometries match exactly.
    const baselineDir = copySample("baseline-geometry");
    const degradedDir = copySample("degraded-geometry");

    const baseline = compile({ projectPath: baselineDir, createdAt: FIXED_CREATED_AT });
    const degraded = compile({ projectPath: degradedDir, createdAt: FIXED_CREATED_AT });

    expect(v1Geometry(degraded.timeline)).toBe(v1Geometry(baseline.timeline));
    expect(v1Geometry(baseline.timeline)).not.toBe("");
  });

  it("without word timestamps the downbeat fallback moves nothing and the honest section-start offset is stamped", () => {
    const dir = copySample("no-words");
    writeBgmAnalysis(dir);

    // Without word evidence the chorus target falls back to the 4.0s
    // downbeat (frame 96) where the cut already sits — no fabricated
    // movement. But the ACTUAL chorus start is 4.6s (frame 110): the honest
    // section-start parity is 14f → fail, so this scenario uses the
    // documented parity_gate "off" opt-out to inspect the stamped verdict
    // (with the default enforce gate this compile is blocked).
    const result = compile({
      projectPath: dir,
      createdAt: FIXED_CREATED_AT,
      defaultsOverride: {
        rhythm_sync: { mode: "auto", search_window_sec: 1.5, max_shift_frames: 12, parity_max_offset_frames: 2, parity_gate: "off" },
      },
    });
    const rhythmSync = (result.timeline.metadata as Record<string, any>).rhythm_sync;

    expect(rhythmSync.enabled).toBe(true);
    expect(rhythmSync.sources).toMatchObject({ bgm_analysis: true, word_timestamps: false });
    expect(rhythmSync.degraded_reasons).toContain("no_word_timestamps_for_music_asset");
    expect(rhythmSync.parity_gate).toBe("off");
    expect(rhythmSync.parity.status).toBe("fail");
    expect(rhythmSync.parity.sections[0]).toMatchObject({
      section_id: "S2", status: "fail", section_start_frame: 110, cut_frame: 96, offset_frames: 14,
    });
    // The chorus cut stays at 96 — no fabricated movement without word evidence.
    const hardSnaps = rhythmSync.snaps.filter((snap: any) => snap.status === "snapped");
    expect(hardSnaps).toEqual([]);
  });
});

describe("rhythm sync parity gate (Issue #35 canonical route)", () => {
  function writeFarChorusEvidence(dir: string): void {
    // Chorus starts at 6.5s (frame 156) with the first vocal exactly on it,
    // but the nearest V1 cut sits at frame 207 (51f away): the snap cannot
    // close the gap, so the parity measurement must fail.
    fs.mkdirSync(path.join(dir, "02_media"), { recursive: true });
    fs.writeFileSync(path.join(dir, "02_media/bgm-test.wav"), "fixture-bgm-media-bytes-v1");
    const bgm = {
      version: "1",
      project_id: "sample-mountain-reset",
      analysis_status: "ready",
      music_asset: {
        asset_id: "AST_MUSICTEST",
        path: "02_media/bgm-test.wav",
        source_hash: computeMediaHeadSourceHash(path.join(dir, "02_media/bgm-test.wav")),
      },
      bpm: 120,
      meter: "4/4",
      duration_sec: 30,
      beats_sec: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28],
      downbeats_sec: [0, 4, 8, 12, 16, 20, 24, 28],
      sections: [
        { id: "S1", label: "intro", start_sec: 0, end_sec: 6.5, energy: 0.3 },
        { id: "S2", label: "chorus", start_sec: 6.5, end_sec: 20, energy: 0.9 },
        { id: "S3", label: "outro", start_sec: 20, end_sec: 30, energy: 0.4 },
      ],
      provenance: { detector: "fixture", sample_rate_hz: 44100 },
    };
    fs.writeFileSync(path.join(dir, "03_analysis/bgm_analysis.json"), JSON.stringify(bgm, null, 2));
    const transcript = {
      project_id: "sample-mountain-reset",
      artifact_version: "analysis-v1",
      transcript_ref: "TR_AST_MUSICTEST",
      asset_id: "AST_MUSICTEST",
      word_timing_mode: "word",
      items: [{
        speaker: "VOCALS",
        start_us: 6_500_000,
        end_us: 7_500_000,
        text: "orbit",
        words: [{ word: "orbit", start_us: 6_500_000, end_us: 7_000_000 }],
      }],
    };
    fs.writeFileSync(
      path.join(dir, "03_analysis/transcripts/TR_AST_MUSICTEST.json"),
      JSON.stringify(transcript, null, 2),
    );
  }

  it("blocks the canonical compile when a chorus section fails parity (gate enforce default)", () => {
    const dir = copySample("parity-gate-block");
    writeFarChorusEvidence(dir);

    expect(() => compile({ projectPath: dir, createdAt: FIXED_CREATED_AT })).toThrow(RhythmParityGateError);
  });

  it("compiles with the documented parity_gate off opt-out and stamps the fail honestly", () => {
    const dir = copySample("parity-gate-off");
    writeFarChorusEvidence(dir);

    const result = compile({
      projectPath: dir,
      createdAt: FIXED_CREATED_AT,
      defaultsOverride: {
        rhythm_sync: { mode: "auto", search_window_sec: 1.5, max_shift_frames: 12, parity_max_offset_frames: 2, parity_gate: "off" },
      },
    });

    const rhythmSync = (result.timeline.metadata as Record<string, any>).rhythm_sync;
    expect(rhythmSync.parity_gate).toBe("off");
    expect(rhythmSync.parity_recomputed_after_geometry_passes).toBe(true);
    // The opt-out never launders the verdict: the chorus fail stays stamped.
    expect(rhythmSync.parity.status).toBe("fail");
    expect(rhythmSync.parity.sections[0]).toMatchObject({
      section_id: "S2",
      label: "chorus",
      status: "fail",
      section_start_frame: 156,
      offset_frames: 51,
    });
    // Integrity is still honest on the final primary V1 geometry.
    expect(rhythmSync.integrity).toMatchObject({ gap_frames: 0, overrun_frames: 0, verified: true });
  });
});

// ── Patch-route parity gate (Issue #35: final metadata reflects final cuts) ──

describe("rhythm sync parity gate after review-patch geometry mutation", () => {
  function patchClip(clipId: string, start: number, duration: number, role = "hero") {
    return {
      clip_id: clipId,
      segment_id: `SEG_${clipId}`,
      asset_id: `AST_${clipId}`,
      src_in_us: 0,
      src_out_us: duration * 40_000,
      timeline_in_frame: start,
      timeline_duration_frames: duration,
      role,
      motivation: "fixture",
      beat_id: "b1",
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
    };
  }

  function rhythmMetadata(sectionStartFrame: number, cutFrame: number) {
    return {
      version: "1" as const,
      mode: "auto" as const,
      enabled: true,
      status: "applied" as const,
      degraded_reasons: [],
      sources: { bgm_analysis: true, word_timestamps: true, beat_count: 8, word_count: 4, section_count: 1 },
      search_window_sec: 1.5,
      max_shift_frames: 12,
      parity_max_offset_frames: 2,
      parity_gate: "enforce" as const,
      fps_num: 25,
      fps_den: 1,
      evidence_provenance: {
        project_id: "patch-gate-project",
        binding: "bound" as const,
        binding_failures: [],
        bgm_artifact_sha256: "a".repeat(64),
      },
      snaps: [],
      parity: {
        status: "pass" as const,
        max_offset_frames: 2,
        sections: [{
          section_id: "S2",
          label: "chorus",
          hard_snap: true,
          section_start_frame: sectionStartFrame,
          target_frame: sectionStartFrame,
          target_kind: "word_start" as const,
          status: "pass" as const,
          offset_frames: 0,
          cut_frame: cutFrame,
        }],
      },
      integrity: { gap_frames: 0, overrun_frames: 0, boundary_count: 2, verified: true },
      counts: {
        snapped: 1, hard_snapped: 1, section_snapped: 1, unchanged: 0, skipped: 0,
        skipped_speech_protected: 0, skipped_still_image: 0, skipped_min_duration: 0,
        skipped_source_range: 0, skipped_max_shift: 0, skipped_no_event: 0,
      },
    };
  }

  function patchGateTimeline(): TimelineIR {
    return {
      version: "1",
      project_id: "patch-gate-project",
      created_at: "2026-08-29T00:00:00.000Z",
      sequence: { name: "PATCH", fps_num: 25, fps_den: 1, width: 1080, height: 1920, start_frame: 0 },
      tracks: {
        video: [{ track_id: "V1", kind: "video", clips: [
          patchClip("V1_A", 0, 100),
          patchClip("V1_B", 100, 100),
          patchClip("V1_C", 200, 200),
        ] }],
        audio: [],
      },
      markers: [],
      metadata: { rhythm_sync: rhythmMetadata(250, 250) },
      provenance: {
        brief_path: "01_intent/creative_brief.yaml",
        blueprint_path: "04_plan/edit_blueprint.yaml",
        selects_path: "04_plan/selects_candidates.yaml",
        compiler_version: "test",
      },
    };
  }

  function setupPatchProject(): string {
    const projectDir = fs.mkdtempSync(path.join(path.resolve("tests"), ".tmp-rhythm-patch-gate-"));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "06_review"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(patchGateTimeline(), null, 2));
    // Render readiness resolves every remaining asset through the source map;
    // real (tiny) media files keep the readiness gate satisfied so the test
    // exercises the rhythm parity gate, not the readiness gate.
    for (const asset of ["V1_A", "V1_B", "V1_C"]) {
      fs.writeFileSync(path.join(projectDir, `02_media/${asset}.mov`), `media-${asset}`);
    }
    fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
      version: "1",
      items: ["V1_A", "V1_B", "V1_C"].map((asset) => ({
        asset_id: `AST_${asset}`,
        source_locator: `02_media/${asset}.mov`,
        local_source_path: `02_media/${asset}.mov`,
        display_name: asset,
        kind: "asset",
      })),
    }, null, 2));
    fs.writeFileSync(path.join(projectDir, "04_plan/selects_candidates.yaml"), JSON.stringify({ candidates: [] }));
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis/segments.json"), JSON.stringify({
      project_id: "patch-gate-project",
      artifact_version: "segments-v1",
      items: ["V1_A", "V1_B", "V1_C"].map((asset) => ({
        segment_id: `SEG_${asset}`,
        asset_id: `AST_${asset}`,
        src_in_us: 0,
        src_out_us: 400_000,
        summary: `fixture segment ${asset}`,
        transcript_excerpt: "",
        quality_flags: [],
        tags: [],
      })),
    }, null, 2));
    fs.writeFileSync(path.join(projectDir, "04_plan/edit_blueprint.yaml"), JSON.stringify({
      // 300f: post-patch content (400f − 100f removed segment), so the
      // duration/gap gates pass and the test isolates the parity gate.
      beats: [{ target_duration_frames: 300 }],
    }));
    const patchPath = path.join(projectDir, "06_review/review_patch.json");
    const patch = {
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: computeArtifactSha256(timelinePath),
      status: "accepted",
      operations: [{ op: "remove_segment", target_clip_id: "V1_A", ripple: true, reason: "remove intro" }],
    };
    expect(validateAgainstSchema(patch, "review-patch.schema.json").valid).toBe(true);
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));
    return projectDir;
  }

  it("blocks runPatch when the rippled geometry breaks chorus parity (gate enforce)", async () => {
    const projectDir = setupPatchProject();
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const original = fs.readFileSync(timelinePath, "utf-8");

    // Removing V1_A ripples the remaining cuts: the chorus start (frame 250)
    // no longer sits near a V1 cut (nearest cut 100 → offset 150).
    await expect(runPatch(projectDir, path.join(projectDir, "06_review/review_patch.json")))
      .rejects.toThrow(RhythmParityGateError);
    // Fail closed: nothing promoted.
    expect(fs.readFileSync(timelinePath, "utf-8")).toBe(original);
    expect(fs.existsSync(path.join(projectDir, "05_timeline/derived-frame-mapping.json"))).toBe(false);
  });

  it("runPatch with the parity_gate off opt-out promotes and stamps the recomputed fail honestly", async () => {
    const projectDir = setupPatchProject();
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");

    await runPatch(projectDir, path.join(projectDir, "06_review/review_patch.json"), undefined, {
      defaultsOverride: { rhythm_sync: { parity_gate: "off" } },
    });

    const patched = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as TimelineIR;
    const rhythmSync = patched.metadata?.rhythm_sync as Record<string, any>;
    expect(rhythmSync.parity_gate).toBe("off");
    expect(rhythmSync.parity_recomputed_after_geometry_passes).toBe(true);
    // The opt-out never launders the verdict: the post-patch chorus fail is
    // measured against the FINAL V1 geometry and stamped.
    expect(rhythmSync.parity.status).toBe("fail");
    expect(rhythmSync.parity.sections[0]).toMatchObject({
      section_id: "S2", status: "fail", section_start_frame: 250, offset_frames: 150, cut_frame: 100,
    });
    expect(rhythmSync.integrity).toMatchObject({ gap_frames: 0, overrun_frames: 0, verified: true });
  });
});
