import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  executeAudioRenderPlan,
} from "../runtime/audio/render-executor.js";
import {
  hashAudioRenderPlan,
  resolveAudioRenderPlan,
} from "../runtime/audio/render-plan.js";
import { resolveSharedAudioRenderPlan } from "../runtime/audio/render-route.js";
import {
  projectSfxToTimeline,
  resolveSfxCuePlan,
} from "../runtime/audio/sfx-cues.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sha256(filePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function meanVolumeDb(filePath: string, startSec: number, durationSec: number): number {
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-ss", String(startSec),
    "-t", String(durationSec),
    "-i", filePath,
    "-af", "volumedetect",
    "-f", "null",
    "-",
  ], { encoding: "utf8" });
  const match = result.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  if (!match) throw new Error(`ffmpeg volumedetect failed: ${result.stderr}`);
  return Number(match[1]);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audio-render-sfx-"));
  roots.push(root);
  const voicePath = path.join(root, "voice.wav");
  execFileSync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "aevalsrc=if(between(t\\,0.9\\,2.4)\\,0.7*sin(2*PI*1000*t)\\,0):s=48000:d=3.003",
    "-ac", "2",
    "-c:a", "pcm_s24le",
    voicePath,
  ], { stdio: "ignore" });

  const libraryRoot = path.join(root, "library");
  const audioDir = path.join(libraryRoot, "audio");
  fs.mkdirSync(audioDir, { recursive: true });
  const sfxPath = path.join(audioDir, "soft-impact.wav");
  execFileSync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "sine=frequency=330:sample_rate=48000:duration=2",
    "-ac", "2",
    "-c:a", "pcm_s24le",
    sfxPath,
  ], { stdio: "ignore" });

  const manifestPath = path.join(libraryRoot, "sfx-library.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    version: "sfx-library/v1",
    library_id: "video-os-test-sfx",
    library_version: "1.0.0",
    assets: [{
      asset_id: "sfx-soft-impact-01",
      semantic_roles: ["hook_impact", "simple_sound"],
      path: "audio/soft-impact.wav",
      content_hash: sha256(sfxPath),
      size_bytes: fs.statSync(sfxPath).size,
      duration_us: 2_000_000,
      rights: {
        status: "confirmed",
        basis: "deterministic_synthesis",
        usage_scope: "internal_audition",
        evidence_ref: "evidence:fixture-sfx-rights",
      },
      provenance: {
        origin: "deterministic_synthesis",
        source_ref: "provenance:fixture-soft-impact-v1",
        generated_at: "2026-07-28T00:00:00Z",
      },
    }],
  }, null, 2)}\n`);
  const manifestHash = sha256(manifestPath);

  const timeline: TimelineIR = {
    version: "7",
    project_id: "phase4-sfx-test",
    created_at: "2026-07-28T00:00:00Z",
    sequence: {
      name: "phase4-sfx",
      fps_num: 30_000,
      fps_den: 1_001,
      width: 1080,
      height: 1920,
      start_frame: 0,
      sample_rate: 48_000,
      timecode_format: "NDF",
    },
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "fixture",
      audio_policy: {
        mode: "ducking",
        source: "explicit_brief",
        a1_loudnorm: true,
      },
    },
    metadata: {
      audio_finish: { preset: "dialogue-clean", loudness_target_lufs: -16 },
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "V1_MAIN",
          segment_id: "SEG_MAIN",
          asset_id: "AST_VOICE",
          src_in_us: 0,
          src_out_us: 3_003_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 90,
          role: "dialogue",
          motivation: "fixture",
          beat_id: "",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }],
      audio: [{
        track_id: "A1",
        kind: "audio",
        clips: [{
          clip_id: "A1_DIALOGUE",
          segment_id: "SEG_MAIN",
          asset_id: "AST_VOICE",
          src_in_us: 0,
          src_out_us: 3_003_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 90,
          role: "dialogue",
          motivation: "fixture",
          beat_id: "",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
          audio_policy: { gain_unit: "linear", nat_gain: 1 },
        }],
      }],
      overlay: [],
    },
    transitions: [],
    markers: [],
  };
  const cuesPath = path.join(root, "sfx_cues.json");
  fs.writeFileSync(cuesPath, `${JSON.stringify({
    version: "sfx-cues/v1",
    project_id: timeline.project_id,
    base_timeline_version: timeline.version,
    timeline_fps: { num: 30_000, den: 1_001 },
    required: true,
    library: {
      manifest_path: manifestPath,
      library_id: "video-os-test-sfx",
      library_version: "1.0.0",
      manifest_hash: manifestHash,
    },
    cues: [{
      cue_id: "SFX_HOOK_000000",
      semantic_role: "hook_impact",
      asset_id: "sfx-soft-impact-01",
      trigger_frame: 0,
      duration_frames: 30,
      source_range: { in_us: 0, out_us: 2_000_000 },
      gain_db: -6,
      fade_in_ms: 10,
      fade_out_ms: 120,
      tail: { max_frames: 10, policy: "trim_or_pad_to_limit" },
      duck_group: "dialogue",
      ducking: { duck_gain_db: -18, attack_ms: 20, release_ms: 180 },
      asset_pin: {
        library_id: "video-os-test-sfx",
        library_version: "1.0.0",
        library_manifest_hash: manifestHash,
        asset_content_hash: sha256(sfxPath),
        asset_size_bytes: fs.statSync(sfxPath).size,
        rights_evidence_ref: "evidence:fixture-sfx-rights",
        provenance_ref: "provenance:fixture-soft-impact-v1",
      },
      intent: "Technical hook-impact validation.",
    }],
  }, null, 2)}\n`);
  const resolvedSfx = resolveSfxCuePlan({
    projectDir: root,
    timeline,
    cuesPath,
  });
  const projected = projectSfxToTimeline(timeline, resolvedSfx);
  const timelinePath = path.join(root, "timeline.json");
  fs.writeFileSync(timelinePath, `${JSON.stringify(projected, null, 2)}\n`);
  const plan = resolveAudioRenderPlan({
    projectDir: root,
    timelinePath,
    sfxCuesPath: cuesPath,
    sourceOverrides: { AST_VOICE: voicePath },
  });
  return { root, voicePath, sfxPath, cuesPath, timelinePath, plan };
}

describe("Phase 4 shared AudioRenderPlan SFX execution", () => {
  it("renders pinned A3 with rational timing, tail control, waveform ducking, and one mastering pass", async () => {
    const input = fixture();
    expect(input.plan.strategy).toBe("explicit_sfx_cues_v1");
    expect(input.plan.timeline.fps).toEqual({ num: 30_000, den: 1_001 });
    expect(input.plan.sfx?.cues[0]).toMatchObject({
      timeline_range: { in_frame: 0, out_frame: 40 },
      tail_processing: {
        requested_tail_frames: 10,
        applied_tail_frames: 10,
        timeline_action: "kept",
        source_action: "trimmed",
        render_duration_frames: 40,
      },
    });

    const first = await executeAudioRenderPlan({
      plan: input.plan,
      outputDir: path.join(input.root, "social"),
      workDirRoot: input.root,
      cleanupWorkDir: false,
    });
    const second = await executeAudioRenderPlan({
      plan: input.plan,
      outputDir: path.join(input.root, "final"),
      workDirRoot: input.root,
      cleanupWorkDir: false,
    });

    expect(first.planHash).toBe(hashAudioRenderPlan(input.plan));
    expect(first.planHash).toBe(second.planHash);
    expect(first.report.output?.content_hash).toBe(second.report.output?.content_hash);
    expect(sha256(first.reportPath)).toBe(sha256(second.reportPath));
    expect(first.report).toMatchObject({
      has_bgm: false,
      has_sfx: true,
      dialogue_finish_scope: "a1_only",
      mastering_count: 1,
      stems: [
        expect.objectContaining({ role: "dialogue", finish_applied: true }),
        expect.objectContaining({ role: "sfx", source_track_id: "A3", finish_applied: false }),
      ],
      execution_strategy: {
        stages: expect.arrayContaining([
          "finish_a1_only",
          "cut_a3_cues",
          "apply_sfx_gain_fades_and_tail",
          "apply_sfx_dialogue_sidechain",
          "single_final_mastering",
        ]),
      },
      sfx_cues: [expect.objectContaining({
        cue_id: "SFX_HOOK_000000",
        dialogue_overlap_frames: 40,
        tail_processing: expect.objectContaining({ applied_tail_frames: 10 }),
      })],
      sfx_sidechain_evidence: {
        per_cue: [expect.objectContaining({
          cue_id: "SFX_HOOK_000000",
          sidechain_applied: true,
        })],
      },
    });
    const a3Path = path.join(first.workDir!, "sfx-001-SFX_HOOK_000000-a3.wav");
    const beforeSpeechDb = meanVolumeDb(a3Path, 0.25, 0.25);
    const duringSpeechDb = meanVolumeDb(a3Path, 1.02, 0.2);
    expect(duringSpeechDb).toBeLessThan(beforeSpeechDb - 2);
  }, 30_000);

  it("rejects A3 asset drift before creating output artifacts", async () => {
    const input = fixture();
    fs.appendFileSync(input.sfxPath, "drift");
    const outputDir = path.join(input.root, "must-not-exist");
    await expect(executeAudioRenderPlan({
      plan: input.plan,
      outputDir,
    })).rejects.toThrow(/AUDIO_RENDER_INPUT_DRIFT/);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it("rejects sound-design decision drift before creating output artifacts", async () => {
    const input = fixture();
    const decisionPath = path.join(input.root, "sound-design-decision.json");
    fs.writeFileSync(decisionPath, "{\"version\":\"fixture\"}\n");
    input.plan.inputs.sound_design_decision_path = decisionPath;
    input.plan.inputs.sound_design_decision_content_hash = sha256(decisionPath);
    fs.appendFileSync(decisionPath, "drift");
    const outputDir = path.join(input.root, "decision-drift-must-not-exist");
    await expect(executeAudioRenderPlan({
      plan: input.plan,
      outputDir,
    })).rejects.toThrow(/AUDIO_RENDER_INPUT_DRIFT/);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it("refuses a pinned A3 timeline when sfx-cues/v1 is missing", () => {
    const input = fixture();
    fs.rmSync(input.cuesPath);
    expect(() => resolveSharedAudioRenderPlan({
      projectDir: input.root,
      timelinePath: input.timelinePath,
      sfxCuesPath: input.cuesPath,
      sourceOverrides: { AST_VOICE: input.voicePath },
    })).toThrow(/hash-pinned A3 requires an existing sfx-cues\/v1 artifact/);
  });
});
