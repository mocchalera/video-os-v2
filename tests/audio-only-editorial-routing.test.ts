import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeCandidateMediaCapabilities } from "../runtime/artifacts/candidate-media-materialization.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import { summarizeCandidateMedia } from "../runtime/artifacts/source-media-capabilities.js";
import { applyDurationAdjust } from "../runtime/compiler/duration-adjust.js";
import { applyPatch } from "../runtime/compiler/patch.js";
import { resolve } from "../runtime/compiler/resolve.js";
import type { Candidate, SelectsCandidates, TimelineIR } from "../runtime/compiler/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("audio-only editorial routing", () => {
  it("materializes rejected audio source truth while preserving grounded editorial rationale", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "eye-070b2a-"));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis", "assets.json"), JSON.stringify({
      items: [{ asset_id: "AST_AUDIO", audio_stream: { codec_name: "aac" } }],
    }));
    const candidate = audioCandidate({
      role: "reject",
      why_it_matches: "The complete assertion directly supports the brief.",
      motif_tags: ["warm_voice"],
      trim_hint: { preferred_duration_us: 1_500_000, rationale: "Hold the final audible cadence." },
    });
    const selects: SelectsCandidates = { version: "1", project_id: "audio", candidates: [candidate] };

    materializeCandidateMediaCapabilities(projectDir, selects, [{
      segment_id: "SEG_AUDIO", transcript_excerpt: "This is the complete assertion.",
    }]);

    expect(selects.source_media?.mode).toBe("audio_only");
    expect(candidate.why_it_matches).toContain("directly supports the brief");
    expect(candidate.why_it_matches).toContain("Transcript: This is the complete assertion.");
    expect(candidate.motif_tags).toContain("warm_voice");
    expect(candidate.trim_hint).toMatchObject({ preferred_duration_us: 1_500_000, rationale: "Hold the final audible cadence." });
    expect(summarizeCandidateMedia([candidate]).audio_only_candidate_count).toBe(1);
  });

  it("routes inserted audio support to A3, music to A2, and rejects audio replacement on V1", () => {
    const timeline = minimalTimeline();
    const support = audioCandidate({ segment_id: "SEG_ROOM", role: "support", audio_role: "ambient" });
    const music = audioCandidate({ segment_id: "SEG_MUSIC", role: "support", audio_role: "music" });
    const result = applyPatch(timeline, {
      timeline_version: "1",
      operations: [
        { op: "insert_segment", with_segment_id: "SEG_ROOM", reason: "room tone", new_duration_frames: 12 },
        { op: "insert_segment", with_segment_id: "SEG_MUSIC", reason: "story music", new_duration_frames: 24 },
        { op: "replace_segment", target_clip_id: "V1_1", with_segment_id: "SEG_ROOM", reason: "invalid cross-kind" },
      ],
    }, [support, music]);

    expect(result.timeline.tracks.audio.find((track) => track.track_id === "A3")?.clips[0]).toMatchObject({
      segment_id: "SEG_ROOM", media_kind: "audio", audio_role: "ambient",
    });
    expect(result.timeline.tracks.audio.find((track) => track.track_id === "A2")?.clips[0]).toMatchObject({
      segment_id: "SEG_MUSIC", media_kind: "audio", audio_role: "music",
    });
    expect(result.errors[0]?.message).toContain("source lacks video capability");
  });

  it("allows an audiovisual dialogue candidate to replace an A1 clip", () => {
    const timeline = minimalTimeline();
    timeline.tracks.audio[0].clips = [audioClip("A1_DIALOGUE", "SEG_OLD", 0, 24, "dialogue")];
    const audiovisualDialogue = audioCandidate({
      candidate_id: "cand_interview",
      segment_id: "SEG_INTERVIEW",
      asset_id: "AST_INTERVIEW",
      media_kind: "video",
      source_capabilities: { has_video: true, has_audio: true },
      role: "dialogue",
      audio_role: "dialogue",
    });

    const result = applyPatch(timeline, {
      timeline_version: "1",
      operations: [{
        op: "replace_segment",
        target_clip_id: "A1_DIALOGUE",
        with_segment_id: "SEG_INTERVIEW",
        reason: "use stronger interview line",
      }],
    }, [audiovisualDialogue]);

    expect(result.errors).toEqual([]);
    expect(result.appliedOps).toBe(1);
    expect(result.timeline.tracks.audio[0].clips[0]).toMatchObject({
      segment_id: "SEG_INTERVIEW",
      media_kind: "video",
      source_capabilities: { has_video: true, has_audio: true },
      audio_role: "dialogue",
    });
  });

  it("drops pure-audio overfill from the real track and never blindly extends dialogue", () => {
    const timeline = minimalTimeline();
    timeline.tracks.video = [];
    timeline.tracks.audio[0].clips = [audioClip("A1_DIALOGUE", "SEG_AUDIO", 0, 40, "dialogue")];
    timeline.tracks.audio[2].clips = [audioClip("A3_ROOM", "SEG_ROOM", 40, 40, "ambient")];
    const overfill = applyDurationAdjust(timeline as never, [], [
      audioCandidate(), audioCandidate({ segment_id: "SEG_ROOM", audio_role: "ambient" }),
    ], strictPolicy(1), 24, 1);
    expect(overfill.clip_drops).toBeGreaterThan(0);
    expect(timeline.tracks.audio.flatMap((track) => track.clips).some((clip) => clip.clip_id === "A3_ROOM")).toBe(false);

    const dialogueOnly = minimalTimeline();
    dialogueOnly.tracks.video = [];
    dialogueOnly.tracks.audio[0].clips = [audioClip("A1_DIALOGUE", "SEG_AUDIO", 0, 12, "dialogue")];
    const before = dialogueOnly.tracks.audio[0].clips[0].timeline_duration_frames;
    const underfill = applyDurationAdjust(dialogueOnly as never, [], [audioCandidate({ src_out_us: 10_000_000 })], strictPolicy(2), 24, 1);
    expect(underfill.extensions).toBe(0);
    expect(dialogueOnly.tracks.audio[0].clips[0].timeline_duration_frames).toBe(before);
  });

  it("accepts a black-canvas-ready pure-audio timeline contract with no video clips", () => {
    const timeline = minimalTimeline();
    timeline.tracks.video = [{ track_id: "V1", kind: "video", clips: [] }];
    timeline.tracks.audio[0].clips = [audioClip("A1_DIALOGUE", "SEG_AUDIO", 0, 48, "dialogue")];
    expect(() => validateArtifact(timeline, "timeline-ir.schema.json")).not.toThrow();
    expect(timeline.sequence).toMatchObject({ width: 1920, height: 1080, fps_num: 24, fps_den: 1 });
  });

  it("counts selected source music as program content without counting a generated BGM bed", () => {
    const timeline = minimalTimeline();
    timeline.tracks.video = [];
    timeline.tracks.audio[0].clips = [audioClip("A1_DIALOGUE", "SEG_AUDIO", 0, 24, "dialogue")];
    timeline.tracks.audio[1].clips = [
      audioClip("A2_PROGRAM", "SEG_MUSIC", 0, 48, "music"),
      {
        ...audioClip("A2_BGM", "SEG_BGM", 0, 240, "music"),
        role: "bgm",
        motivation: "background music bed",
      },
    ];

    const report = resolve(timeline as never, 48, [], strictPolicy(2), 24, 1);
    expect(report.total_frames).toBe(48);
    expect(report.content_frames).toBe(72);
  });

});

function audioCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    candidate_id: "cand_audio",
    segment_id: "SEG_AUDIO",
    asset_id: "AST_AUDIO",
    src_in_us: 0,
    src_out_us: 2_000_000,
    role: "dialogue",
    why_it_matches: "grounded audio",
    risks: [],
    confidence: 0.9,
    media_kind: "audio",
    source_capabilities: { has_video: false, has_audio: true },
    audio_role: "dialogue",
    ...overrides,
  };
}

function audioClip(id: string, segmentId: string, frame: number, duration: number, audioRole: "dialogue" | "ambient" | "music") {
  const role = audioRole === "dialogue" ? "dialogue" : audioRole === "music" ? "support" : "texture";
  const candidate = audioCandidate({ segment_id: segmentId, audio_role: audioRole, role });
  return {
    clip_id: id, segment_id: segmentId, asset_id: candidate.asset_id, src_in_us: 0, src_out_us: duration * 1_000_000 / 24,
    timeline_in_frame: frame, timeline_duration_frames: duration, role: candidate.role, motivation: "authored audio selection",
    beat_id: "b01", fallback_segment_ids: [], confidence: 1, quality_flags: [], media_kind: "audio" as const,
    source_capabilities: candidate.source_capabilities, audio_role: audioRole,
  };
}

function strictPolicy(targetSec: number) {
  return { mode: "strict" as const, source: "explicit_brief" as const, target_source: "explicit_brief" as const,
    target_duration_sec: targetSec, min_duration_sec: targetSec, max_duration_sec: targetSec,
    hard_gate: true, protect_vlm_peaks: true };
}

function minimalTimeline(): TimelineIR {
  return {
    version: "1", project_id: "audio", created_at: "2026-07-20T00:00:00Z",
    sequence: { name: "audio", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0, sample_rate: 48_000 },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [{
        clip_id: "V1_1", segment_id: "SEG_VIDEO", asset_id: "AST_VIDEO", src_in_us: 0, src_out_us: 1_000_000,
        timeline_in_frame: 0, timeline_duration_frames: 24, role: "hero", motivation: "legacy video",
        beat_id: "b01", fallback_segment_ids: [], confidence: 1, quality_flags: [],
      }] }],
      audio: [
        { track_id: "A1", kind: "audio", clips: [] },
        { track_id: "A2", kind: "audio", clips: [] },
        { track_id: "A3", kind: "audio", clips: [] },
      ],
    }, transitions: [], markers: [],
    provenance: { brief_path: "01_intent/creative_brief.yaml", selects_path: "04_plan/selects_candidates.yaml", blueprint_path: "04_plan/edit_blueprint.yaml", compiler_version: "test" },
  };
}
