import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compile } from "../runtime/compiler/index.js";
import { contentHashForJson } from "../runtime/music/cue-planner.js";
import type { MusicCuesDoc } from "../runtime/audio/music-cues.js";
import { parseArgs as parseCompileArgs } from "../scripts/compile-timeline.js";

const tempDirectories: string[] = [];
const SAMPLE_PROJECT = path.resolve("projects/sample");
const CREATED_AT = "2026-07-16T00:00:00.000Z";

afterEach(() => {
  tempDirectories.splice(0).forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

function copyProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-compiler-music-v2-"));
  tempDirectories.push(root);
  const project = path.join(root, "sample");
  fs.cpSync(SAMPLE_PROJECT, project, { recursive: true });
  fs.rmSync(path.join(project, "05_timeline", "timeline.json"), { force: true });
  return project;
}

function sha(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function writeV2MusicArtifacts(project: string, timelineTail: number): void {
  const selection = {
    version: "1.0.0",
    project_id: "sample-mountain-reset",
    created_at: CREATED_AT,
    mode: "operator_locked",
    scoring_strategy: {
      strategy_id: "bgm-score-v1",
      base_total_points: 100,
      auto_minimum_score: 78,
      auto_minimum_margin: 12,
    },
    redistribution_trace: {
      applied: true,
      source_component: "semantic_fit",
      source_weight: 30,
      reason: "fixture",
      allocations: [{ component: "speech_friendliness", added_points: 30 }],
    },
    input_hashes: {
      creative_brief: sha("1"),
      edit_blueprint: sha("2"),
      timeline: sha("3"),
      catalog: sha("4"),
      analyses: [{ track_id: "fixture-track", analysis_hash: sha("c") }],
    },
    requirements: {
      families: ["trust_clarity"],
      intensities: ["low"],
      use_cases: ["interview"],
      minimum_speech_friendliness: 0.8,
      vocal_presence_allowed: ["none"],
      duration_us: 30_000_000,
    },
    hard_constraints: [],
    candidates: [{
      track_id: "fixture-track",
      content_hash: sha("a"),
      rank: 1,
      status: "ranked",
      total_score: 90,
      score_breakdown: {
        semantic_fit: 0,
        editorial_family_arc_fit: 20,
        speech_friendliness: 15,
        energy_tempo_fit: 15,
        duration_edit_ending_fit: 10,
        beat_downbeat_confidence: 5,
        diversity_recent_use: 5,
      },
      rejection_reasons: [],
      explanation: "fixture",
    }],
    selected: {
      track_id: "fixture-track",
      content_hash: sha("a"),
      rank: 1,
      score: 90,
      confidence: 0.8,
      explanation: "explicit fixture",
    },
    selected_track_pin: {
      pack_id: "fixture-pack",
      pack_version: "1.0.0",
      pack_manifest_hash: sha("d"),
      track_id: "fixture-track",
      full_mix_content_hash: sha("a"),
      full_mix_size_bytes: 1024,
      full_mix_path: "audio/fixture.wav",
      analysis_content_hash: sha("c"),
      analysis_size_bytes: 512,
      analysis_path: "analysis/fixture.json",
      analysis_status: "degraded",
      registry_status: "verified",
    },
    top_two_margin: null,
    operator_override: {
      selected_track_id: "fixture-track",
      reason: "explicit fixture",
      operator_ref: "fixture:human",
      overridden_at: CREATED_AT,
    },
    semantic_channel: {
      status: "unavailable",
      model_revision: null,
      warnings: ["fixture"],
    },
    usage_history_penalties: [],
    warnings: ["fixture"],
  };
  fs.mkdirSync(path.join(project, "07_package"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "04_plan", "bgm_selection.json"),
    JSON.stringify(selection, null, 2),
  );
  const musicCues: MusicCuesDoc = {
    version: "2.0.0",
    project_id: "sample-mountain-reset",
    base_timeline_version: "1",
    selection_ref: {
      path: "04_plan/bgm_selection.json",
      content_hash: contentHashForJson(selection),
    },
    timeline_fps: { num: 30_000, den: 1001 },
    planning_status: "verified_with_warnings",
    warnings: ["fixture degraded analysis"],
    music_asset: {
      asset_id: "fixture-track",
      path: "audio/fixture.wav",
      source_hash: sha("a"),
      analysis_ref: "analysis/fixture.json",
      track_id: "fixture-track",
      pack_id: "fixture-pack",
      pack_version: "1.0.0",
      pack_manifest_hash: sha("d"),
      full_mix_content_hash: sha("a"),
      full_mix_size_bytes: 1024,
      analysis_content_hash: sha("c"),
      analysis_size_bytes: 512,
      analysis_status: "degraded",
      duration_us: 90_000_000,
    },
    cues: [{
      cue_id: "MC_FIXTURE",
      track_id: "fixture-track",
      timeline_track_id: "A2",
      entry_window: { earliest_frame: 72, latest_frame: 72, basis: "semantic_anchor" },
      entry_frame: 72,
      exit_frame: timelineTail,
      source_offset_us: 3_000_000,
      source_range: {
        in_us: 3_000_000,
        out_us: 3_000_000 + Math.round((timelineTail - 72) * 1_000_000 * 1001 / 30_000),
      },
      timeline_range: { in_frame: 72, out_frame: timelineTail },
      section: "opening",
      phase: "dialogue-bed",
      semantic_anchor: {
        label: "first grounded assertion",
        timeline_frame: 72,
        source_onset_us: 3_000_000,
      },
      beat_alignment: {
        requested: "semantic_anchor_source_onset",
        status: "degraded",
        decision: "explicit_source_onset",
        analysis_status: "degraded",
        confidence: 0.3,
        grid_source: null,
        source_onset_us: 3_000_000,
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
      beat_sync: { enabled: false },
    }],
  };
  fs.writeFileSync(
    path.join(project, "07_package", "music_cues.json"),
    JSON.stringify(musicCues, null, 2),
  );
}

describe("compiler music cue v2 connection", () => {
  it("accepts an exact rational fps value at the compiler CLI boundary", () => {
    expect(parseCompileArgs(["node", "compile", "projects/sample", "--fps", "30000/1001"]))
      .toMatchObject({ fpsNum: 30_000, fpsDen: 1_001 });
  });

  it("projects v2 music cues through compile, preserves pins, and is idempotent", () => {
    const project = copyProject();
    const baseline = compile({
      projectPath: project,
      createdAt: CREATED_AT,
      repoRoot: path.resolve("."),
      fpsNum: 30_000,
      fpsDen: 1001,
    });
    const tail = Math.max(...baseline.timeline.tracks.video.flatMap((track) =>
      track.clips.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames)));
    writeV2MusicArtifacts(project, tail);

    const first = compile({
      projectPath: project,
      createdAt: CREATED_AT,
      repoRoot: path.resolve("."),
      fpsNum: 30_000,
      fpsDen: 1001,
    });
    const second = compile({
      projectPath: project,
      createdAt: CREATED_AT,
      repoRoot: path.resolve("."),
      fpsNum: 30_000,
      fpsDen: 1001,
    });
    const a2 = first.timeline.tracks.audio.find((track) => track.track_id === "A2");

    expect(a2?.clips).toHaveLength(1);
    expect(a2?.clips[0]).toMatchObject({
      src_in_us: 3_000_000,
      timeline_in_frame: 72,
      role: "music",
      metadata: {
        music_asset: {
          pack_id: "fixture-pack",
          pack_manifest_hash: sha("d"),
          full_mix_content_hash: sha("a"),
          analysis_content_hash: sha("c"),
        },
      },
    });
    expect(first.timeline).toEqual(second.timeline);

    const cuePath = path.join(project, "07_package", "music_cues.json");
    const drifted = JSON.parse(fs.readFileSync(cuePath, "utf8")) as MusicCuesDoc;
    drifted.music_asset.pack_manifest_hash = sha("e");
    fs.writeFileSync(cuePath, JSON.stringify(drifted, null, 2));
    expect(() => compile({
      projectPath: project,
      createdAt: CREATED_AT,
      repoRoot: path.resolve("."),
      fpsNum: 30_000,
      fpsDen: 1001,
    })).toThrow(/pins do not match/i);
  });

  it("keeps a no-cue compile byte/semantic stable and ignores legacy cues for original_only", () => {
    const project = copyProject();
    const first = compile({ projectPath: project, createdAt: CREATED_AT, repoRoot: path.resolve(".") });
    const firstBytes = JSON.stringify(first.timeline);
    const second = compile({ projectPath: project, createdAt: CREATED_AT, repoRoot: path.resolve(".") });
    expect(JSON.stringify(second.timeline)).toBe(firstBytes);

    const briefPath = path.join(project, "01_intent", "creative_brief.yaml");
    const brief = parseYaml(fs.readFileSync(briefPath, "utf8")) as Record<string, unknown>;
    brief.audio_policy = "original_only";
    fs.writeFileSync(briefPath, stringifyYaml(brief));
    fs.mkdirSync(path.join(project, "07_package"), { recursive: true });
    const legacy: MusicCuesDoc = {
      version: "1",
      project_id: "sample-mountain-reset",
      base_timeline_version: "1",
      music_asset: { asset_id: "LEGACY", path: "audio/legacy.wav", source_hash: sha("a") },
      cues: [{
        cue_id: "MC_LEGACY",
        track_id: "A2",
        entry_window: { earliest_frame: 0, latest_frame: 0 },
        entry_frame: 0,
        exit_frame: 120,
        fade_in_ms: 0,
        fade_out_ms: 0,
        ducking: { base_gain_db: -16, duck_gain_db: -24, attack_ms: 80, release_ms: 180 },
      }],
    };
    fs.writeFileSync(
      path.join(project, "07_package", "music_cues.json"),
      JSON.stringify(legacy, null, 2),
    );

    const originalOnly = compile({ projectPath: project, createdAt: CREATED_AT, repoRoot: path.resolve(".") });
    expect(originalOnly.timeline.tracks.audio.find((track) => track.track_id === "A2")?.clips)
      .toEqual([]);
  });
});
