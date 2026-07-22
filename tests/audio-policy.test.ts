import { describe, expect, it } from "vitest";
import {
  buildAudioMixArgs,
  buildAudioTrimArgs,
  buildDuckingAudioMixFilter,
} from "../runtime/render/assembler.js";
import { compile, removeOverlappingGeneratedAudioMirrors } from "../runtime/compiler/index.js";
import type { AssembledTimeline, TimelineClip } from "../runtime/compiler/types.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("audio policy", () => {
  it("builds sidechaincompress ducking when original and BGM stems are present", () => {
    const filter = buildDuckingAudioMixFilter(
      [
        { delay_ms: 0, isBgm: false },
        { delay_ms: 0, isBgm: true },
      ],
      2,
    );

    expect(filter).toContain("sidechaincompress");
    expect(filter).toContain("[origRaw]loudnorm=I=-16:LRA=11:TP=-1.5[origMix]");
    expect(filter).toContain("[origMix]asplit=2[orig][scraw]");
    expect(filter).toContain("[scraw]lowpass=f=3000[sc]");
    expect(filter).toContain("[bgm][sc]sidechaincompress=threshold=0.05:ratio=4:attack=20:release=400:makeup=1:detection=rms");
    expect(filter).toContain("[orig][ducked]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0");
  });

  it("passes ducking plans into the ffmpeg mix args", () => {
    const args = buildAudioMixArgs(
      ["/tmp/original.wav", "/tmp/bgm.wav"],
      "/tmp/out.m4a",
      10,
      48_000,
      2,
      [0, 0],
      [
        { delay_ms: 0, isBgm: false },
        { delay_ms: 0, isBgm: true },
      ],
    );
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("sidechaincompress");
    expect(filter).toContain("loudnorm=I=-16:LRA=11:TP=-1.5");
    expect(filter).toContain("normalize=0");
  });

  it("allows A1 stem loudnorm to be disabled", () => {
    const filter = buildDuckingAudioMixFilter(
      [
        { delay_ms: 0, isBgm: false, a1_loudnorm: false },
        { delay_ms: 0, isBgm: true },
      ],
      2,
    );

    expect(filter).not.toContain("loudnorm=I=-16");
    expect(filter).toContain("[origRaw]anull[origMix]");
  });

  it("raises original audio gain before mixing", () => {
    const args = buildAudioTrimArgs(
      "/tmp/source.mov",
      "/tmp/a1.wav",
      0,
      4,
      48_000,
      2,
      { mode: "ducking", nat_gain: 1.8 },
    );

    expect(args).toContain("-af");
    expect(args[args.indexOf("-af") + 1]).toBe("volume=1.8");
  });

  it("defaults family-growth-recap briefs to ducking and emits original A1 audio", () => {
    const projectDir = makeMinimalProject();
    const result = compile({
      projectPath: projectDir,
      repoRoot: path.resolve("."),
      createdAt: "2026-04-27T00:00:00Z",
      fpsNum: 30,
    });

    expect(result.timeline.provenance.audio_policy).toEqual({
      mode: "ducking",
      source: "profile_default",
      a1_loudnorm: true,
    });
    expect(result.timeline.tracks.audio.find((track) => track.track_id === "A1")?.clips.length).toBeGreaterThan(0);
    expect(result.timeline.tracks.audio.find((track) => track.track_id === "A1")?.clips[0]).toMatchObject({
      audio_policy: { mode: "ducking", a1_loudnorm: true },
    });
    expect(result.timeline.tracks.audio.find((track) => track.track_id === "A2")?.clips[0]).toMatchObject({
      asset_id: "AST_BGM",
      role: "bgm",
      audio_policy: { mode: "ducking", gain_unit: "linear", bgm_gain: 0.25, a1_loudnorm: true },
    });

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("does not mirror original video audio over an existing dialogue clip", () => {
    const projectDir = makeMinimalProject({ includeDialogue: true });
    const result = compile({
      projectPath: projectDir,
      repoRoot: path.resolve("."),
      createdAt: "2026-04-27T00:00:00Z",
      fpsNum: 30,
    });

    const a1Clips = result.timeline.tracks.audio.find((track) => track.track_id === "A1")?.clips ?? [];
    expect(a1Clips.some((clip) => clip.role === "dialogue")).toBe(true);
    expect(a1Clips.some((clip) => clip.role === "nat_sound")).toBe(false);

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("drops generated original audio mirrors when final sync overlaps dialogue", () => {
    const assembled: AssembledTimeline = {
      tracks: {
        video: [],
        audio: [
          {
            track_id: "A1",
            kind: "audio",
            clips: [
              makeClip({
                clip_id: "CLP_DIALOGUE",
                role: "dialogue",
                motivation: "voice",
                timeline_in_frame: 600,
                timeline_duration_frames: 240,
              }),
              makeClip({
                clip_id: "ACL_MIRROR",
                role: "nat_sound",
                motivation: "original clip audio",
                timeline_in_frame: 480,
                timeline_duration_frames: 240,
              }),
            ],
          },
        ],
      },
      markers: [],
    };

    expect(removeOverlappingGeneratedAudioMirrors(assembled).sort()).toEqual(["ACL_MIRROR"]);
    expect(assembled.tracks.audio[0].clips.map((clip) => clip.clip_id)).toEqual(["CLP_DIALOGUE"]);
  });
});

function makeClip(overrides: Partial<TimelineClip>): TimelineClip {
  return {
    clip_id: "CLP_BASE",
    segment_id: "seg_1",
    asset_id: "AST_VIDEO",
    src_in_us: 0,
    src_out_us: 4000000,
    timeline_in_frame: 0,
    timeline_duration_frames: 120,
    role: "dialogue",
    motivation: "voice",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 0.9,
    quality_flags: [],
    ...overrides,
  };
}

function makeMinimalProject(options: { includeDialogue?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-audio-policy-"));
  fs.mkdirSync(path.join(dir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(dir, "03_analysis"), { recursive: true });
  fs.mkdirSync(path.join(dir, "04_plan"), { recursive: true });

  fs.writeFileSync(path.join(dir, "01_intent/creative_brief.yaml"), [
    'version: "1"',
    "project_id: audio-policy-fixture",
    "project:",
    "  id: audio-policy-fixture",
    "  title: Audio Policy Fixture",
    "  strategy: family-growth-recap",
    "  runtime_target_sec: 8",
    "message:",
    "  primary: preserve original audio",
    "audience:",
    "  primary: family",
    "emotion_curve: [start, peak, end]",
    "must_have: [voice]",
    "must_avoid: [mute]",
    "autonomy:",
    "  may_decide: []",
    "  must_ask: []",
    "resolved_assumptions: [ducking default]",
    "editorial:",
    "  profile_hint: family-growth-recap",
    "  allow_inference: true",
    "",
  ].join("\n"));

  fs.writeFileSync(path.join(dir, "04_plan/edit_blueprint.yaml"), [
    'version: "1"',
    "project_id: audio-policy-fixture",
    "sequence_goals: [test]",
    "beats:",
    "  - id: b01",
    "    label: first",
    "    target_duration_frames: 120",
    `    required_roles: [${options.includeDialogue ? "hero, dialogue" : "hero"}]`,
    "pacing:",
    "  opening_cadence: gentle",
    "  middle_cadence: gentle",
    "  ending_cadence: gentle",
    "music_policy:",
    "  start_sparse: true",
    "  allow_release_late: true",
    "  entry_beat: b01",
    "  bgm_asset_id: AST_BGM",
    "  bgm_duration_sec: 8",
    "dialogue_policy:",
    "  preserve_natural_breath: true",
    "  avoid_wall_to_wall_voiceover: true",
    "resolved_profile:",
    "  id: family-growth-recap",
    "duration_policy:",
    "  mode: guide",
    "  source: explicit_brief",
    "  target_source: explicit_brief",
    "  target_duration_sec: 8",
    "  min_duration_sec: 1",
    "  max_duration_sec: 20",
    "  hard_gate: false",
    "  protect_vlm_peaks: true",
    "",
  ].join("\n"));

  fs.writeFileSync(path.join(dir, "04_plan/selects_candidates.yaml"), [
    'version: "1"',
    "project_id: audio-policy-fixture",
    "candidates:",
    "  - segment_id: seg_1",
    "    asset_id: AST_VIDEO",
    "    src_in_us: 0",
    "    src_out_us: 4000000",
    "    role: hero",
    "    why_it_matches: peak",
    "    risks: []",
    "    confidence: 0.9",
    "    semantic_rank: 1",
    ...(options.includeDialogue ? [
      "  - segment_id: seg_2",
      "    asset_id: AST_DIALOGUE",
      "    src_in_us: 10000000",
      "    src_out_us: 14000000",
      "    role: dialogue",
      "    why_it_matches: voice",
      "    risks: []",
      "    confidence: 0.95",
      "    semantic_rank: 1",
    ] : []),
    "",
  ].join("\n"));

  fs.writeFileSync(path.join(dir, "03_analysis/assets.json"), JSON.stringify({ project_id: "audio-policy-fixture", artifact_version: "1", items: [] }, null, 2));
  return dir;
}
