/**
 * Compile-level fixture tests for the primary audio coverage invariant
 * (Issue #6 P0 remainder).
 *
 * Fixture shape: three 96-frame beats pinned by candidate_plan. Beat b02 uses
 * a silent video source (has_audio: false), so the compiler generates no A1
 * mirror over [96, 192) while V1 stays continuous. Rendering that hole would
 * produce silent audio, so compile must fail closed with PRIMARY_AUDIO_GAP
 * unless the silence is explicitly authorized.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compile } from "../runtime/compiler/index.js";
import { PrimaryAudioGapError } from "../runtime/compiler/errors.js";

const SAMPLE_PROJECT = path.resolve("projects/sample");
const FIXED_CREATED_AT = "2026-03-21T00:00:00Z";
const AUDIO_GAP_OPERATION = {
  operation_id: "OP_PRIMARY_AUDIO_SILENCE",
  type: "gap" as const,
  track_id: "A1",
  start_frame: 96,
  duration_frames: 96,
  authority: "operator" as const,
  reason: "fixture intentionally keeps silent audio under the silent b-roll beat",
};

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeDirSync(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface VideoCandidateOverride {
  candidate_id: string;
  segment_id: string;
  asset_id: string;
  eligible_beat: string;
  source_capabilities: { has_video: boolean; has_audio: boolean };
}

function createPrimaryAudioProject(): string {
  const tmpDir = path.join("tests", `tmp_primary_audio_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  copyDirSync(SAMPLE_PROJECT, tmpDir);
  for (const file of ["timeline.json", "preview-manifest.json"]) {
    const artifact = path.join(tmpDir, "05_timeline", file);
    if (fs.existsSync(artifact)) fs.unlinkSync(artifact);
  }

  const candidates: VideoCandidateOverride[] = [
    {
      candidate_id: "cand_talk_a",
      segment_id: "SEG_TALK_A",
      asset_id: "AST_TALK_A",
      eligible_beat: "b01",
      source_capabilities: { has_video: true, has_audio: true },
    },
    {
      candidate_id: "cand_silent_b",
      segment_id: "SEG_SILENT_B",
      asset_id: "AST_SILENT_B",
      eligible_beat: "b02",
      source_capabilities: { has_video: true, has_audio: false },
    },
    {
      candidate_id: "cand_talk_c",
      segment_id: "SEG_TALK_C",
      asset_id: "AST_TALK_C",
      eligible_beat: "b03",
      source_capabilities: { has_video: true, has_audio: true },
    },
  ];

  const selects = {
    version: "1",
    project_id: "sample-mountain-reset",
    source_media: {
      mode: "video",
      media_kinds: ["video"],
      visual_candidate_count: 3,
      audio_only_candidate_count: 0,
    },
    candidates: candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      segment_id: candidate.segment_id,
      asset_id: candidate.asset_id,
      src_in_us: 0,
      src_out_us: 6_000_000,
      role: "hero",
      why_it_matches: `Grounded visual source for ${candidate.eligible_beat}.`,
      risks: [],
      confidence: 0.9,
      quality_flags: [],
      eligible_beats: [candidate.eligible_beat],
      media_kind: "video",
      source_capabilities: candidate.source_capabilities,
    })),
  };
  fs.writeFileSync(path.join(tmpDir, "04_plan/selects_candidates.yaml"), stringifyYaml(selects), "utf-8");

  const blueprint = {
    version: "1",
    project_id: "sample-mountain-reset",
    source_media: selects.source_media,
    sequence_goals: ["Keep a continuous visual program with declared primary audio."],
    beats: candidates.map((candidate) => ({
      id: candidate.eligible_beat,
      label: `${candidate.eligible_beat} program`,
      target_duration_frames: 96,
      required_roles: ["hero"],
      candidate_plan: { primary_candidate_ref: candidate.candidate_id, fallback_candidate_refs: [] },
      craft: { rhythm: "steady" },
    })),
    pacing: { opening_cadence: "steady", middle_cadence: "steady", ending_cadence: "breath" },
    music_policy: { start_sparse: false, allow_release_late: false },
    dialogue_policy: { preserve_natural_breath: false },
    transition_policy: { prefer_match_texture_over_flashy_fx: true },
    ending_policy: { should_feel: "resolved" },
    rejection_rules: ["Reject ungrounded sources."],
    duration_policy: {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 12,
      min_duration_sec: 0,
      max_duration_sec: null,
      hard_gate: false,
      protect_vlm_peaks: false,
    },
    timeline_order: "editorial",
    track_layout: "single",
    active_editing_skills: ["human_golden_order"],
  };
  fs.writeFileSync(path.join(tmpDir, "04_plan/edit_blueprint.yaml"), stringifyYaml(blueprint), "utf-8");

  fs.writeFileSync(path.join(tmpDir, "03_analysis/segments.json"), JSON.stringify({
    project_id: "sample-mountain-reset",
    artifact_version: "analysis-v1",
    items: candidates.map((candidate) => ({
      segment_id: candidate.segment_id,
      asset_id: candidate.asset_id,
      src_in_us: 0,
      src_out_us: 6_000_000,
      summary: "",
      transcript_excerpt: "",
      quality_flags: [],
      tags: [],
    })),
  }, null, 2));

  return tmpDir;
}

function compileFixture(overrides?: {
  timelineOperations?: Array<Record<string, unknown>>;
  audioMixPolicy?: Record<string, unknown>;
}): string {
  const projectDir = createPrimaryAudioProject();
  if (overrides?.timelineOperations || overrides?.audioMixPolicy) {
    const blueprintPath = path.join(projectDir, "04_plan/edit_blueprint.yaml");
    const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf-8")) as Record<string, unknown>;
    if (overrides.timelineOperations) blueprint.timeline_operations = overrides.timelineOperations;
    if (overrides.audioMixPolicy) blueprint.audio_mix_policy = overrides.audioMixPolicy;
    fs.writeFileSync(blueprintPath, stringifyYaml(blueprint), "utf-8");
  }
  return projectDir;
}

describe("primary audio coverage invariant (compile level)", () => {
  it("fails closed on an unintended primary-audio gap and reports full operator detail", () => {
    const projectDir = compileFixture();
    try {
      let caught: unknown;
      try {
        compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PrimaryAudioGapError);
      const error = caught as PrimaryAudioGapError;
      expect(error.code).toBe("PRIMARY_AUDIO_GAP");
      expect(error.message).toContain("A1 frames 96-192 duration=96f previous=");
      expect(error.gaps).toEqual([expect.objectContaining({
        track_id: "A1",
        start_frame: 96,
        end_frame: 192,
        duration_frames: 96,
        previous_clip: expect.objectContaining({ beat_id: "b01" }),
        next_clip: expect.objectContaining({ beat_id: "b03" }),
        previous_beat_id: "b01",
        next_beat_id: "b03",
        recommended_fix: expect.stringContaining("silence/ambient-continuation"),
      })]);
    } finally {
      removeDirSync(projectDir);
    }
  });

  it("succeeds when the silent range carries an explicit authority-bearing silence operation", () => {
    const projectDir = compileFixture({ timelineOperations: [AUDIO_GAP_OPERATION] });
    try {
      const result = compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT });
      expect(result.timeline.tracks.video.find((track) => track.track_id === "V1")?.clips.map((clip) => clip.beat_id))
        .toEqual(["b01", "b02", "b03"]);
      expect(result.timeline.metadata?.timeline_operations).toEqual([AUDIO_GAP_OPERATION]);
    } finally {
      removeDirSync(projectDir);
    }
  });

  it("succeeds under an explicit primary-audio mix policy that authorizes sparse coverage", () => {
    const projectDir = compileFixture({
      audioMixPolicy: {
        policy: "primary-audio-mix/v1",
        mode: "selective_authorization",
        authority: "operator",
        reason: "music bed is planned to carry the silent b-roll beat in finishing",
      },
    });
    try {
      const result = compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT });
      // A declared mix policy waives the invariant, so the resolution carries
      // no primary-audio gap diagnostics at all.
      expect(result.resolution.audio_gap_details).toBeUndefined();
      expect(result.resolution.audio_gap_frames).toBeUndefined();
      expect(fs.existsSync(path.join(projectDir, "05_timeline/timeline.json"))).toBe(true);
    } finally {
      removeDirSync(projectDir);
    }
  });

  it("rejects a malformed primary-audio mix policy instead of silently waiving", () => {
    const projectDir = compileFixture({
      audioMixPolicy: {
        policy: "primary-audio-mix/v1",
        mode: "selective_authorization",
        authority: "operator",
      },
    });
    try {
      expect(() => compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT }))
        .toThrow(/invalid_audio_mix_policy.*reason/);
    } finally {
      removeDirSync(projectDir);
    }
  });

  it("waives the invariant under the explicit bgm_only brief mix policy", () => {
    const projectDir = compileFixture();
    try {
      const briefPath = path.join(projectDir, "01_intent/creative_brief.yaml");
      const brief = parseYaml(fs.readFileSync(briefPath, "utf-8")) as Record<string, unknown>;
      fs.writeFileSync(briefPath, stringifyYaml({ ...brief, audio_policy: "bgm_only" }), "utf-8");
      const result = compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT });
      // bgm_only skips original-audio mirrors entirely; the waiver keeps the
      // compile valid without any per-range operation.
      expect(result.timeline.tracks.audio.find((track) => track.track_id === "A1")?.clips).toEqual([]);
    } finally {
      removeDirSync(projectDir);
    }
  });
});
