import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCueRenderArgs,
  buildDialogueStemArgs,
  buildPremasterMixArgs,
  buildSidechainCueArgs,
  executeAudioRenderPlan,
} from "../runtime/audio/render-executor.js";
import {
  hashAudioRenderPlan,
  assertAudioRenderPlanContract,
  assertAudioRenderPlanMatchesCanonical,
  resolveAudioRenderPlan,
  type AudioRenderResolvedTrack,
} from "../runtime/audio/render-plan.js";
import { resolveSharedAudioRenderPlan } from "../runtime/audio/render-route.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
  if (match) return Number(match[1]);
  throw new Error(`ffmpeg volumedetect failed: ${result.stderr}`);
}

function fixture(options: {
  fpsNum?: number;
  fpsDen?: number;
  policy?: "ducking" | "original_only";
  cues?: Array<{ id: string; inFrame: number; outFrame: number; sourceInUs: number }>;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audio-render-plan-"));
  roots.push(root);
  const voicePath = path.join(root, "voice.wav");
  const musicPath = path.join(root, "music.m4a");
  fs.writeFileSync(voicePath, "voice-fixture");
  fs.writeFileSync(musicPath, "music-fixture");
  const fpsNum = options.fpsNum ?? 24;
  const fpsDen = options.fpsDen ?? 1;
  const cueInputs = options.cues ?? [
    { id: "MC_ONE", inFrame: 72, outFrame: 120, sourceInUs: 3_000_000 },
  ];
  const durationUs = (frames: number) => Math.round(frames * 1_000_000 * fpsDen / fpsNum);
  const musicCues = {
    version: "2.0.0",
    project_id: "phase3-test",
    base_timeline_version: "7",
    timeline_fps: { num: fpsNum, den: fpsDen },
    selection_ref: {
      path: "04_plan/bgm_selection.json",
      content_hash: `sha256:${"a".repeat(64)}`,
    },
    planning_status: "verified_with_warnings",
    music_asset: {
      asset_id: "trust-clarity-low-01",
      path: "audio/trust-clarity-low-01.m4a",
      source_hash: sha256(musicPath),
      track_id: "trust-clarity-low-01",
      pack_id: "video-os-core-bgm-v1-candidate",
      pack_version: "1.0.0-candidate.1",
      pack_manifest_hash: `sha256:${"b".repeat(64)}`,
      full_mix_content_hash: sha256(musicPath),
      full_mix_size_bytes: fs.statSync(musicPath).size,
      analysis_content_hash: `sha256:${"c".repeat(64)}`,
      analysis_size_bytes: 4004,
      analysis_status: "degraded",
      duration_us: 120_000_000,
    },
    cues: cueInputs.map((cue) => ({
      cue_id: cue.id,
      track_id: "trust-clarity-low-01",
      timeline_track_id: "A2",
      entry_window: { earliest_frame: cue.inFrame, latest_frame: cue.inFrame, basis: "semantic_anchor" },
      entry_frame: cue.inFrame,
      exit_frame: cue.outFrame,
      source_offset_us: cue.sourceInUs,
      source_range: {
        in_us: cue.sourceInUs,
        out_us: cue.sourceInUs + durationUs(cue.outFrame - cue.inFrame),
      },
      timeline_range: { in_frame: cue.inFrame, out_frame: cue.outFrame },
      section: "opening",
      phase: "dialogue-bed",
      semantic_anchor: {
        label: "assertion",
        timeline_frame: cue.inFrame,
        source_onset_us: cue.sourceInUs,
      },
      beat_alignment: {
        requested: "semantic_anchor_source_onset",
        status: "degraded",
        decision: "explicit_source_onset",
        analysis_status: "degraded",
        confidence: 0.3,
        grid_source: null,
        source_onset_us: cue.sourceInUs,
        timeline_boundaries_moved: false,
        warnings: ["fixture degraded analysis"],
      },
      fade_in_ms: 400,
      fade_out_ms: 900,
      ducking: {
        base_gain_db: -16,
        duck_gain_db: -24,
        attack_ms: 80,
        release_ms: 280,
      },
    })),
  };
  const timeline = {
    version: "7",
    project_id: "phase3-test",
    sequence: {
      name: "phase3",
      fps_num: fpsNum,
      fps_den: fpsDen,
      width: 1080,
      height: 1920,
      start_frame: 0,
      sample_rate: 48000,
      timecode_format: "NDF",
    },
    provenance: {
      generated_by: "fixture",
      compiler_version: "fixture",
      source_artifacts: {},
      audio_policy: { mode: options.policy ?? "ducking", a1_loudnorm: true },
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
          asset_id: "AST_VOICE",
          src_in_us: 0,
          src_out_us: durationUs(240),
          timeline_in_frame: 0,
          timeline_duration_frames: 240,
        }],
      }],
      audio: [
        {
          track_id: "A1",
          kind: "audio",
          clips: [{
            clip_id: "A1_DIALOGUE",
            asset_id: "AST_VOICE",
            src_in_us: 500_000,
            src_out_us: 4_500_000,
            timeline_in_frame: 24,
            timeline_duration_frames: 96,
            role: "dialogue",
            audio_policy: { gain_unit: "linear", nat_gain: 1 },
          }],
        },
        {
          track_id: "A2",
          kind: "audio",
          clips: musicCues.cues.map((cue) => ({
            clip_id: `A2_${cue.cue_id}`,
            asset_id: "trust-clarity-low-01",
            src_in_us: cue.source_range.in_us,
            src_out_us: cue.source_range.out_us,
            timeline_in_frame: cue.entry_frame,
            timeline_duration_frames: cue.exit_frame - cue.entry_frame,
            role: "music",
            metadata: {
              music_cue: {
                selected_track_id: cue.track_id,
                ...cue,
              },
              music_asset: {
                track_id: musicCues.music_asset.track_id,
                pack_id: musicCues.music_asset.pack_id,
                pack_version: musicCues.music_asset.pack_version,
                pack_manifest_hash: musicCues.music_asset.pack_manifest_hash,
                full_mix_content_hash: musicCues.music_asset.full_mix_content_hash,
                analysis_content_hash: musicCues.music_asset.analysis_content_hash,
                path: musicCues.music_asset.path,
              },
            },
          })),
        },
      ],
      overlay: [],
    },
    transitions: [],
  };
  const timelinePath = path.join(root, "timeline.json");
  const musicCuesPath = path.join(root, "music_cues.json");
  fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
  fs.writeFileSync(musicCuesPath, `${JSON.stringify(musicCues, null, 2)}\n`);
  const resolvedTrack: AudioRenderResolvedTrack = {
    track_id: "trust-clarity-low-01",
    pack_id: musicCues.music_asset.pack_id,
    pack_version: musicCues.music_asset.pack_version,
    pack_manifest_hash: musicCues.music_asset.pack_manifest_hash,
    full_mix_path: musicPath,
    full_mix_content_hash: musicCues.music_asset.full_mix_content_hash,
    full_mix_size_bytes: fs.statSync(musicPath).size,
    analysis_content_hash: musicCues.music_asset.analysis_content_hash,
    analysis_size_bytes: musicCues.music_asset.analysis_size_bytes,
    analysis_status: "degraded",
    duration_us: musicCues.music_asset.duration_us,
  };
  return { root, voicePath, musicPath, timelinePath, musicCuesPath, resolvedTrack };
}

function resolve(input = fixture()) {
  return {
    ...input,
    plan: resolveAudioRenderPlan({
      projectDir: input.root,
      timelinePath: input.timelinePath,
      musicCuesPath: input.musicCuesPath,
      sourceOverrides: { AST_VOICE: input.voicePath },
      resolveTrackImpl: () => input.resolvedTrack,
    }),
  };
}

describe("shared AudioRenderPlan resolver", () => {
  it("pins A1-only finishing and exact Phase 2 cue values in a stable target-independent plan", () => {
    const input = fixture();
    const { plan } = resolve(input);

    expect(plan).toMatchObject({
      version: "audio-render-plan/v1",
      project_id: "phase3-test",
      strategy: "explicit_music_cues_v2",
      timeline: { fps: { num: 24, den: 1 } },
      dialogue: {
        finish_scope: "a1_only",
        clips: [{ track_id: "A1", clip_id: "A1_DIALOGUE" }],
      },
      music: {
        enabled: true,
        cues: [{
          cue_id: "MC_ONE",
          timeline_range: { in_frame: 72, out_frame: 120 },
          source_range_us: { in_us: 3_000_000, out_us: 5_000_000 },
          applied: {
            base_gain_db: -16,
            duck_gain_db: -24,
            fade_in_ms: 400,
            fade_out_ms: 900,
            attack_ms: 80,
            release_ms: 280,
          },
        }],
      },
      final_mastering: { count: 1 },
    });
    expect(plan).not.toHaveProperty("sfx");
    expect(hashAudioRenderPlan(plan)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hashAudioRenderPlan(plan)).toBe(hashAudioRenderPlan(resolve(input).plan));
  });

  it("preserves rational fps and deterministically orders multiple cues", () => {
    const input = fixture({
      fpsNum: 30_000,
      fpsDen: 1_001,
      cues: [
        { id: "MC_B", inFrame: 150, outFrame: 180, sourceInUs: 8_000_000 },
        { id: "MC_A", inFrame: 30, outFrame: 90, sourceInUs: 1_000_000 },
      ],
    });
    const { plan } = resolve(input);

    expect(plan.timeline.fps).toEqual({ num: 30_000, den: 1_001 });
    expect(plan.music.cues.map((cue) => cue.cue_id)).toEqual(["MC_A", "MC_B"]);
    expect(buildSidechainCueArgs(
      plan,
      plan.music.cues[0],
      "/tmp/dialogue.wav",
      "/tmp/cue.wav",
      "/tmp/sidechain.wav",
    ).join(" ")).toContain("adelay=1001|1001");
    expect(buildPremasterMixArgs(
      plan,
      "/tmp/dialogue.wav",
      ["/tmp/a.wav", "/tmp/b.wav"],
      "/tmp/mix.wav",
    ).join(" ")).toContain("amix=inputs=3");
  });

  it("leaves original_only and legacy embedded BGM on backward-compatible strategies", () => {
    const original = fixture({ policy: "original_only" });
    const originalPlan = resolve(original).plan;
    expect(originalPlan.strategy).toBe("original_passthrough");
    expect(originalPlan.music.enabled).toBe(false);

    const legacy = fixture();
    const timeline = JSON.parse(fs.readFileSync(legacy.timelinePath, "utf8"));
    delete timeline.tracks.audio[1].clips[0].metadata;
    fs.writeFileSync(legacy.timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
    fs.rmSync(legacy.musicCuesPath);
    const legacyPlan = resolveAudioRenderPlan({
      projectDir: legacy.root,
      timelinePath: legacy.timelinePath,
      sourceOverrides: { AST_VOICE: legacy.voicePath },
    });
    expect(legacyPlan.strategy).toBe("legacy_embedded_bgm");
    expect(legacyPlan.dialogue.finish_scope).toBe("none_mixed_legacy");
  });

  it("fails closed instead of sending hash-pinned A2 through the legacy mixed-audio route", () => {
    const input = fixture();
    fs.rmSync(input.musicCuesPath);

    expect(() => resolveSharedAudioRenderPlan({
      projectDir: input.root,
      timelinePath: input.timelinePath,
      musicCuesPath: input.musicCuesPath,
      sourceOverrides: { AST_VOICE: input.voicePath },
    })).toThrow(/hash-pinned A2 requires an existing music-cues\/v2 artifact/);
  });
});

describe("shared AudioRenderPlan executor contract", () => {
  it("builds deterministic A1 extraction, exact cue gain/fades, and waveform sidechain args", () => {
    const { plan } = resolve();
    const dialogueArgs = buildDialogueStemArgs(plan, "/tmp/dialogue.wav");
    const cueArgs = buildCueRenderArgs(plan.music.cues[0], "/tmp/cue.wav");
    const sidechainArgs = buildSidechainCueArgs(
      plan,
      plan.music.cues[0],
      "/tmp/dialogue-finished.wav",
      "/tmp/cue.wav",
      "/tmp/ducked.wav",
    );

    expect(dialogueArgs.join(" ")).toContain("adelay=1000|1000");
    expect(cueArgs.join(" ")).toContain("-ss 3");
    expect(cueArgs.join(" ")).toContain("volume=-16dB");
    expect(cueArgs.join(" ")).toContain("afade=t=in:d=0.4");
    expect(cueArgs.join(" ")).toContain("afade=t=out:st=1.1:d=0.9");
    expect(sidechainArgs.join(" ")).toContain("sidechaincompress=threshold=0.03:ratio=13.00");
    expect(sidechainArgs.join(" ")).toContain("attack=80:release=280");
    expect(sidechainArgs.join(" ")).toContain("asetnsamples=n=1024:p=1[bed]");
    expect(sidechainArgs.join(" ")).toContain("[ducked]apad,atrim=end_sample=480000[out]");
    expect(sidechainArgs).toEqual(expect.arrayContaining(["-filter_complex_threads", "1"]));
  });

  it("rejects Pack/audio drift before creating outputs or invoking FFmpeg", async () => {
    const { plan, musicPath, root } = resolve();
    fs.appendFileSync(musicPath, "drift");
    const outputDir = path.join(root, "must-not-exist");

    await expect(executeAudioRenderPlan({
      plan,
      outputDir,
    })).rejects.toThrow(/AUDIO_RENDER_INPUT_DRIFT/);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it("finishes A1 only, waveform-ducks real fixture signal, and masters exactly once", async () => {
    const input = fixture({
      cues: [{ id: "MC_ONE", inFrame: 0, outFrame: 96, sourceInUs: 0 }],
    });
    execFileSync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "aevalsrc=if(between(t\\,1.5\\,3.5)\\,0.7*sin(2*PI*1000*t)\\,0):s=48000:d=5",
      "-ac", "2",
      "-c:a", "pcm_s24le",
      input.voicePath,
    ], { stdio: "ignore" });
    execFileSync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=48000:duration=5",
      "-ac", "2",
      "-c:a", "aac",
      "-b:a", "192k",
      input.musicPath,
    ], { stdio: "ignore" });
    const cues = JSON.parse(fs.readFileSync(input.musicCuesPath, "utf8"));
    cues.music_asset.source_hash = sha256(input.musicPath);
    cues.music_asset.full_mix_content_hash = sha256(input.musicPath);
    cues.music_asset.full_mix_size_bytes = fs.statSync(input.musicPath).size;
    fs.writeFileSync(input.musicCuesPath, `${JSON.stringify(cues, null, 2)}\n`);
    const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8"));
    timeline.tracks.audio[1].clips[0].metadata.music_asset.full_mix_content_hash =
      cues.music_asset.full_mix_content_hash;
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
    input.resolvedTrack.full_mix_content_hash = cues.music_asset.full_mix_content_hash;
    input.resolvedTrack.full_mix_size_bytes = cues.music_asset.full_mix_size_bytes;
    const { plan } = resolve(input);
    const outputDir = path.join(input.root, "rendered");
    const realFfmpeg = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
    const wrapperDir = path.join(input.root, "instrumented-bin");
    const ffmpegLog = path.join(input.root, "ffmpeg-args.log");
    fs.mkdirSync(wrapperDir);
    const wrapper = path.join(wrapperDir, "ffmpeg");
    fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ffmpegLog}"\nexec "${realFfmpeg}" "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}:${originalPath}`;
    let result: Awaited<ReturnType<typeof executeAudioRenderPlan>>;
    try {
      result = await executeAudioRenderPlan({
        plan,
        outputDir,
        cleanupWorkDir: false,
        workDirRoot: input.root,
        verifyPackPinsImpl: () => undefined,
      });
    } finally {
      process.env.PATH = originalPath;
    }

    const pass2Calls = fs.readFileSync(ffmpegLog, "utf8")
      .split("\n")
      .filter((line) => line.includes("linear=true"));
    expect(pass2Calls).toHaveLength(1);

    expect(result.report).toMatchObject({
      version: "audio-mix-report/v2",
      dialogue_finish_scope: "a1_only",
      mastering_count: 1,
      execution_strategy: {
        stages: expect.arrayContaining([
          "finish_a1_only",
          "waveform_sidechain_ducking",
          "single_final_mastering",
        ]),
      },
      stems: [
        expect.objectContaining({ role: "dialogue", finish_applied: true }),
        expect.objectContaining({ role: "music", finish_applied: false }),
      ],
    });
    expect(result.report.cues?.[0].applied).toEqual({
      base_gain_db: -16,
      duck_gain_db: -24,
      fade_in_ms: 400,
      fade_out_ms: 900,
      attack_ms: 80,
      release_ms: 280,
    });
    expect(result.report.final_mastering.output_measurement).toBeDefined();
    expect(result.report).not.toHaveProperty("has_sfx");
    expect(result.report.input_hashes).not.toHaveProperty("sfx_sources");
    expect(result.report).not.toHaveProperty("sfx_cues");
    const sidechainPath = path.join(
      result.workDir!,
      "001-MC_ONE-sidechain.wav",
    );
    const bedDb = meanVolumeDb(sidechainPath, 0.8, 0.4);
    const speechDb = meanVolumeDb(sidechainPath, 2.5, 0.4);
    expect(speechDb).toBeLessThan(bedDb - 2);
  }, 30_000);
});

function musicMasterFixture(options: {
  gain?: number;
  mode?: "music_master" | "original_only";
  audioDecision?: "preserve" | "mastering";
  nestedAudioDecision?: "preserve" | "mastering" | null;
  sourceContents?: string;
  sourceRef?: string;
  processingGraph?: { version: string; operations: string[] };
  nestedFields?: Record<string, unknown>;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "music-master-plan-"));
  roots.push(root);
  const musicPath = path.join(root, "full-song.wav");
  fs.writeFileSync(musicPath, options.sourceContents ?? "full-song-fixture");
  const sourceHash = sha256(musicPath);
  const timeline = {
    version: "42",
    project_id: "issue-42-still-music-master",
    sequence: {
      name: "still lyric MV",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "fixture",
      audio_policy: {
        mode: options.mode ?? "music_master",
        source: "explicit_brief",
        audio_decision: options.audioDecision ?? "preserve",
        music_master: {
          asset_id: "SONG_FULL_01",
          source_ref: options.sourceRef ?? "full-song.wav",
          source_content_hash: sourceHash,
          source_size_bytes: fs.statSync(musicPath).size,
          source_duration_us: 5_000_000,
          gain_linear: options.gain ?? 1,
          channel_layout: "stereo",
          codec: "pcm_s16le",
          ...(options.nestedAudioDecision === null
            ? {}
            : { audio_decision: options.nestedAudioDecision ?? options.audioDecision ?? "preserve" }),
          ...(options.processingGraph ? { processing_graph: options.processingGraph } : {}),
          ...(options.nestedFields ?? {}),
        },
      },
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "STILL_01",
          asset_id: "STILL_01",
          src_in_us: 0,
          src_out_us: 5_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 120,
          role: "hero",
        }],
      }],
      audio: [
        { track_id: "A1", kind: "audio", clips: [] },
        { track_id: "A2", kind: "audio", clips: [] },
        { track_id: "A3", kind: "audio", clips: [] },
      ],
    },
    markers: [],
  };
  const timelinePath = path.join(root, "timeline.json");
  fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
  return { root, musicPath, timelinePath };
}

describe("Issue #42 independent music_master preserve contract", () => {
  it("binds a still-only timeline to the full song without an A1/A2 fallback", () => {
    const input = musicMasterFixture();
    const plan = resolveAudioRenderPlan({
      projectDir: input.root,
      timelinePath: input.timelinePath,
    });

    expect(plan).toMatchObject({
      strategy: "music_master",
      timeline: { duration_frames: 120 },
      dialogue: { clips: [] },
      music: { enabled: false, cues: [] },
      music_master: {
        enabled: true,
        audio_decision: "preserve",
        input_audio_hash: sha256(input.musicPath),
        source: {
          role: "music_master",
          asset_id: "SONG_FULL_01",
          source_ref: "full-song.wav",
          gain_linear: 1,
        },
      },
      final_mastering: { count: 0, stage: "not_applied" },
    });
    expect(plan.music_master?.source.source_ref).not.toContain(input.root);
    expect(validateAgainstSchema(plan, "audio-render-plan.schema.json")).toEqual({ valid: true, errors: [] });
    expect(hashAudioRenderPlan(plan)).toBe(hashAudioRenderPlan(resolveAudioRenderPlan({
      projectDir: input.root,
      timelinePath: input.timelinePath,
    })));
    expect(resolveSharedAudioRenderPlan({
      projectDir: input.root,
      timelinePath: input.timelinePath,
    })?.strategy).toBe("music_master");
  });

  it.each([
    ["wrong fallback", { mode: "original_only" as const }, /no fallback/],
    ["gain is not unity", { gain: 0.5 }, /gain_linear=1\.0/],
  ])("fails closed for %s", (_label, options, error) => {
    const input = musicMasterFixture(options);
    expect(() => resolveAudioRenderPlan({
      projectDir: input.root,
      timelinePath: input.timelinePath,
    })).toThrow(error);
  });

  it("rejects preserve plus an explicit mastering request", () => {
    const input = musicMasterFixture();
    expect(() => resolveAudioRenderPlan({
      projectDir: input.root,
      timelinePath: input.timelinePath,
      masteringDefaults: { loudness_target_lufs: -16, lra_target: 7, true_peak_target_dbtp: -1.5 },
    })).toThrow(/cannot be combined with an explicit mastering request/);
  });

  it.each([
    ["root/nested decision conflict", { audioDecision: "mastering" as const, nestedAudioDecision: "preserve" as const }, /conflict/],
    ["nested decision missing", { audioDecision: "mastering" as const, nestedAudioDecision: null }, /missing/],
    ["unknown processing alias", { processingGraph: { version: "audio-processing-graph/v1", operations: ["normalization"] } }, /unknown|non-canonical/],
  ])("fails closed for %s", (_label, options, error) => {
    const input = musicMasterFixture(options);
    expect(() => resolveAudioRenderPlan({
      projectDir: input.root,
      timelinePath: input.timelinePath,
    })).toThrow(error);
  });

  it("accepts existing canonical nested music_master fields but rejects unknown processing controls", () => {
    const canonical = musicMasterFixture({
      processingGraph: { version: "audio-processing-graph/v1", operations: ["stream_copy"] },
    });
    const plan = resolveAudioRenderPlan({ projectDir: canonical.root, timelinePath: canonical.timelinePath });
    expect(plan.music_master?.processing_graph.operations).toEqual(["stream_copy"]);

    for (const nestedFields of [
      { normalization: { enabled: true } },
      { unknown_key: "must-not-be-ignored" },
    ]) {
      const input = musicMasterFixture({ nestedFields });
      expect(() => resolveAudioRenderPlan({
        projectDir: input.root,
        timelinePath: input.timelinePath,
      })).toThrow(/non-canonical|unknown|normalization/i);
    }
  });

  it.each([
    ["project-absolute source ref", (input: ReturnType<typeof musicMasterFixture>) => input.musicPath],
    ["path traversal source ref", () => "../full-song.wav"],
  ])("rejects %s", (_label, sourceRef) => {
    const input = musicMasterFixture();
    const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8"));
    timeline.provenance.audio_policy.music_master.source_ref = sourceRef(input);
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
    expect(() => resolveAudioRenderPlan({
      projectDir: input.root,
      timelinePath: input.timelinePath,
    })).toThrow(/project-relative|source_ref/);
  });

  it("rejects a supplied Song B plan against the canonical Song A timeline and accepts an identical plan", () => {
    const songA = musicMasterFixture();
    const canonical = resolveAudioRenderPlan({ projectDir: songA.root, timelinePath: songA.timelinePath });
    const identical = resolveAudioRenderPlan({ projectDir: songA.root, timelinePath: songA.timelinePath });
    expect(() => assertAudioRenderPlanMatchesCanonical(identical, canonical)).not.toThrow();

    const songBPath = path.join(songA.root, "song-b.wav");
    fs.writeFileSync(songBPath, "song-b");
    const songBTimelinePath = path.join(songA.root, "timeline-song-b.json");
    const songBTimeline = JSON.parse(fs.readFileSync(songA.timelinePath, "utf8"));
    songBTimeline.provenance.audio_policy.music_master.source_ref = "song-b.wav";
    songBTimeline.provenance.audio_policy.music_master.source_content_hash = sha256(songBPath);
    songBTimeline.provenance.audio_policy.music_master.source_size_bytes = fs.statSync(songBPath).size;
    fs.writeFileSync(songBTimelinePath, `${JSON.stringify(songBTimeline, null, 2)}\n`);
    const suppliedSongB = resolveAudioRenderPlan({ projectDir: songA.root, timelinePath: songBTimelinePath });
    expect(() => assertAudioRenderPlanMatchesCanonical(suppliedSongB, canonical)).toThrow(/canonical|source|identity|stale/i);
  });

  it("rejects source identity drift and a mutated processing graph", () => {
    const input = musicMasterFixture();
    const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8"));
    timeline.provenance.audio_policy.music_master.source_content_hash = `sha256:${"f".repeat(64)}`;
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
    expect(() => resolveAudioRenderPlan({
      projectDir: input.root,
      timelinePath: input.timelinePath,
    })).toThrow(/identity\/hash/);

    const clean = musicMasterFixture();
    const plan = resolveAudioRenderPlan({ projectDir: clean.root, timelinePath: clean.timelinePath });
    plan.music_master!.processing_graph.operations = ["shared_final_mastering"];
    expect(() => assertAudioRenderPlanContract(plan)).toThrow(/processing_graph/);
  });

  it("executes the still-only preserve route by stream-copy and records the same hash", async () => {
    const input = musicMasterFixture();
    execFileSync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=48000:duration=5",
      "-ac", "2",
      "-c:a", "pcm_s16le",
      input.musicPath,
    ], { stdio: "ignore" });
    const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8"));
    timeline.provenance.audio_policy.music_master.source_content_hash = sha256(input.musicPath);
    timeline.provenance.audio_policy.music_master.source_size_bytes = fs.statSync(input.musicPath).size;
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
    const plan = resolveAudioRenderPlan({ projectDir: input.root, timelinePath: input.timelinePath });
    const result = await executeAudioRenderPlan({
      plan,
      outputDir: path.join(input.root, "rendered"),
      workDirRoot: input.root,
      verifyPackPinsImpl: () => undefined,
    });

    expect(result.report.music_master).toMatchObject({
      role: "music_master",
      audio_decision: "preserve",
      source_bytes_preserved: true,
      input_audio_hash: sha256(input.musicPath),
      output_audio_hash: sha256(input.musicPath),
      processing_graph: { operations: ["stream_copy"] },
      codec: { operation: "stream_copy" },
    });
    expect(result.report.mastering_count).toBe(0);
    expect(validateAgainstSchema(result.report, "audio-mix-report.schema.json")).toEqual({ valid: true, errors: [] });
  }, 30_000);
});
