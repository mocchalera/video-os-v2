import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { ingestAsset } from "../runtime/connectors/ffprobe.js";
import { computeMediaSourceHash } from "../runtime/media/bgm-analyzer.js";
import { normalize } from "../runtime/compiler/normalize.js";
import { runCanonicalCompile } from "../runtime/compiler/index.js";
import { loadRhythmEvidenceSnapshot } from "../runtime/compiler/rhythm-sync.js";
import { buildVideoAssemblyPlan } from "../runtime/render/assembler.js";
import { assembleTimelineToMp4 } from "../runtime/render/assembler.js";
import { computeReviewMetrics, type ReviewMetricsInputs } from "../runtime/review/metrics.js";
import { evaluateLyricMvCadence } from "../runtime/review/lyric-mv-cadence.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import type { CreativeBrief, EditBlueprint, TimelineIR } from "../runtime/compiler/types.js";

const PILOT_CREATED_AT = "2026-09-01T00:00:00.000Z";
const pilotDirs: string[] = [];
const ISSUE43_TEST_STILL_CAMERA = {
  pythonBinary: process.execPath,
  workerPath: path.resolve("tests/fixtures/still-camera-test-worker.mjs"),
};

afterEach(() => {
  for (const dir of pilotDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sourceMapEntry(
  projectDir: string,
  assetId: string,
  sourcePath: string,
  mediaKind: "image" | "audio",
  sourceHash?: string,
) {
  return {
    asset_id: assetId,
    source_locator: path.relative(projectDir, sourcePath).split(path.sep).join("/"),
    local_source_path: sourcePath,
    link_path: path.relative(projectDir, sourcePath).split(path.sep).join("/"),
    media_kind: mediaKind,
    ...(sourceHash ? { source_content_sha256: sourceHash } : {}),
  };
}

function groundedStillSegment(
  projectDir: string,
  asset: AssetItem,
  segmentId: string,
): Record<string, unknown> {
  const framePath = path.join(projectDir, "03_analysis", asset.still_image!.normalized_frame_path);
  const frameHash = asset.still_image!.normalized_frame_content_sha256;
  const sourceHash = asset.source_content_sha256!;
  const evidenceRef = `issue43-pilot:${asset.asset_id}:verified-frame`;
  const cacheIdentity = `issue43-pilot-cache:${asset.asset_id}`;
  const producer = {
    producer: "grounded_vlm",
    actual_verified_frame_count: 1,
    source_content_sha256: sourceHash,
    cache_identity: cacheIdentity,
    evidence_refs: [evidenceRef],
  };
  const evidence = {
    producer: "grounded_vlm",
    evidence_type: "verified_frame",
    evidence_ref: evidenceRef,
    artifact_ref: framePath,
    fields: ["frame_content_sha256"],
  };
  return {
    segment_id: segmentId,
    asset_id: asset.asset_id,
    media_kind: "image",
    src_in_us: 0,
    src_out_us: 1,
    source_interval: { semantics: "schema_compatible_single_frame_interval" },
    summary: `Issue 43 pilot still ${asset.asset_id}`,
    transcript_excerpt: "",
    quality_flags: [],
    tags: ["lyric_mv", "still"],
    provenance: {
      boundary: {
        stage: "segment",
        method: "still_image_single_frame",
        connector_version: "issue43-pilot",
        policy_hash: "issue43-pilot",
        request_hash: "issue43-pilot",
      },
      tags: {
        source_content_sha256: sourceHash,
        frame_content_sha256: [frameHash],
        frame_count: 1,
        cache_identity: cacheIdentity,
      },
    },
    editorial_observation: {
      status: "ready",
      warnings: [],
      provenance: { producers: [producer] },
      evidence: [evidence],
      producer_snapshots: {
        grounded_vlm: { producer, evidence: [evidence] },
      },
    },
  };
}

function stillIntent(
  sourceIndex: number,
  instanceId: string,
  hold: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source_still_id: `still-${sourceIndex + 1}`,
    still_instance_id: instanceId,
    reuse: "unique",
    hold,
    fit_mode: "cover",
    background: "black",
    ...overrides,
  };
}

function buildPilotBrief(): Record<string, unknown> {
  return {
    version: "1",
    project_id: "issue43-lyric-mv-pilot",
    created_at: PILOT_CREATED_AT,
    project: {
      id: "issue43-lyric-mv-pilot",
      title: "Issue 43 lyric MV pilot",
      strategy: "lyric_mv",
      runtime_target_sec: 28,
    },
    message: { primary: "A full-song lyric MV with intentional still-image reuse." },
    emotion_curve: ["quiet", "lift", "release"],
    editorial: { aspect_ratio: "9:16", profile_hint: "lyric_mv", allow_inference: true },
    audio_policy: "bgm_only",
    caption_policy: "auto",
    still_image_intent: {
      min_hold_sec: 2,
      default_hold_sec: 4,
      max_hold_sec: 20,
      motion_mode: "static",
      fit_mode: "cover",
      background: "black",
    },
  };
}

function buildPilotBlueprint(): Record<string, unknown> {
  const beats = [
    {
      id: "b01",
      label: "verse-1",
      target_duration_frames: 48,
      required_roles: ["hero"],
      candidate_plan: {
        primary_candidate_ref: "pilot-c1",
        still_image: stillIntent(0, "pilot-instance-a-1", { unit: "frames", value: 48 }, {
          transform: { crop: { x: 0, y: 0, width: 0.9, height: 0.9 }, zoom: 1.02 },
        }),
      },
    },
    {
      id: "b02",
      label: "verse-2",
      target_duration_frames: 48,
      required_roles: ["hero"],
      candidate_plan: {
        primary_candidate_ref: "pilot-c2",
        still_image: stillIntent(1, "pilot-instance-b-1", { unit: "seconds", value: 2 }, {
          transform: { crop: { x: 0.05, y: 0, width: 0.85, height: 0.95 }, pan: { x: 0.05, y: 0 } },
        }),
      },
    },
    {
      id: "b03",
      label: "chorus-long-hold",
      target_duration_frames: 384,
      required_roles: ["hero"],
      candidate_plan: {
        primary_candidate_ref: "pilot-c3",
        still_image: stillIntent(2, "pilot-instance-c-chorus", {
          unit: "section_boundary",
          section_id: "S2",
          boundary: "end",
          reason: "hold the chorus still through its section boundary",
        }, {
          motion_mode: "subtle_ken_burns",
          camera_motion: { preset: "push_in", easing: "linear", intensity: 0.06, parallax: { amount: 0.02, axis: "horizontal" } },
          ken_burns: { preset: "push_in", easing: "linear", intensity: 0.06 },
          transform: { crop: { x: 0.1, y: 0.05, width: 0.78, height: 0.9 }, zoom: 1.12, anchor: { x: 0.55, y: 0.45 } },
          parallax: { amount: 0.02, axis: "horizontal" },
        }),
      },
    },
    {
      id: "b04",
      label: "post-chorus",
      target_duration_frames: 48,
      required_roles: ["hero"],
      candidate_plan: {
        primary_candidate_ref: "pilot-c4",
        still_image: stillIntent(3, "pilot-instance-d-1", { unit: "beats", value: 1 }, {
          transform: { crop: { x: 0, y: 0.08, width: 0.9, height: 0.82 }, scale: 1.02 },
        }),
      },
    },
    {
      id: "b05",
      label: "bridge",
      target_duration_frames: 48,
      required_roles: ["hero"],
      candidate_plan: {
        primary_candidate_ref: "pilot-c5",
        still_image: stillIntent(4, "pilot-instance-e-1", { unit: "frames", value: 48 }, {
          transform: { crop: { x: 0.08, y: 0.08, width: 0.82, height: 0.82 }, zoom: 1.04 },
        }),
      },
    },
    {
      id: "b06",
      label: "outro-1",
      target_duration_frames: 48,
      required_roles: ["hero"],
      candidate_plan: {
        primary_candidate_ref: "pilot-c6",
        still_image: stillIntent(5, "pilot-instance-f-1", { unit: "seconds", value: 2 }, {
          transform: { crop: { x: 0.12, y: 0, width: 0.75, height: 0.95 }, pan: { x: -0.04, y: 0 } },
          parallax: { amount: 0.025, axis: "vertical" },
        }),
      },
    },
    {
      id: "b07",
      label: "outro-reprise",
      target_duration_frames: 48,
      required_roles: ["hero"],
      candidate_plan: {
        primary_candidate_ref: "pilot-c7-reuse-a",
        still_image: stillIntent(0, "pilot-instance-a-2", { unit: "frames", value: 48 }, {
          reuse: "intentional",
          transform: { crop: { x: 0.22, y: 0.12, width: 0.62, height: 0.7 }, zoom: 1.22, pan: { x: 0.16, y: -0.08 }, anchor: { x: 0.65, y: 0.42 } },
          parallax: { amount: 0.035, axis: "both" },
        }),
      },
    },
  ];
  return {
    version: "1",
    project_id: "issue43-lyric-mv-pilot",
    created_at: PILOT_CREATED_AT,
    source_media: { mode: "mixed", media_kinds: ["image", "audio"], visual_candidate_count: 7, audio_only_candidate_count: 0 },
    sequence_goals: ["Keep lyric captions and music sections legible while reusing six still sources."],
    beats,
    pacing: { opening_cadence: "music-led", middle_cadence: "section-led", ending_cadence: "resolving", max_shot_length_frames: 144 },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b03",
      bgm_asset_id: "AST_PILOT_BGM",
      bgm_segment_id: "SEG_PILOT_BGM",
      bgm_duration_sec: 28,
    },
    caption_policy: { language: "en", delivery_mode: "burn_in", source: "authored", styling_class: "simple-shadow" },
    dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
    transition_policy: { prefer_match_texture_over_flashy_fx: true, allow_hard_cuts: true, avoid_speed_ramps: true },
    ending_policy: { should_feel: "resolving", final_hold_min_frames: 24 },
    rejection_rules: ["Reject unexplained long holds and unmarked duplicate still instances."],
    duration_policy: {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 28,
      min_duration_sec: 19.6,
      max_duration_sec: 36.4,
      hard_gate: false,
      protect_vlm_peaks: true,
    },
    timeline_order: "editorial",
    track_layout: "single",
    active_editing_skills: ["human_golden_order"],
  };
}

function buildPilotCandidates(assetByIndex: AssetItem[]): Record<string, unknown>[] {
  const refs = [
    ["pilot-c1", 0, "b01"],
    ["pilot-c2", 1, "b02"],
    ["pilot-c3", 2, "b03"],
    ["pilot-c4", 3, "b04"],
    ["pilot-c5", 4, "b05"],
    ["pilot-c6", 5, "b06"],
    ["pilot-c7-reuse-a", 0, "b07"],
  ] as const;
  return refs.map(([candidateId, index, beatId], rank) => {
    const asset = assetByIndex[index];
    return {
      candidate_id: candidateId,
      segment_id: `SEG_STILL_${index + 1}`,
      asset_id: asset.asset_id,
      src_in_us: 0,
      src_out_us: 1,
      role: "hero",
      why_it_matches: `Canonical Issue 43 still source ${index + 1}`,
      risks: [],
      confidence: 0.98,
      semantic_rank: rank + 1,
      eligible_beats: [beatId],
      evidence: ["grounded_frame", "pilot_fixture"],
      media_kind: "image",
      source_capabilities: { has_video: true, has_audio: false },
      still_image: {
        source_still_id: `still-${index + 1}`,
        still_instance_id: candidateId,
        ...(candidateId === "pilot-c7-reuse-a" ? { reuse: "intentional" } : {}),
      },
    };
  });
}

async function createPilotProject(): Promise<{
  projectDir: string;
  brief: CreativeBrief;
  blueprint: EditBlueprint;
  assets: AssetItem[];
}> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-issue43-lyric-pilot-"));
  pilotDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "02_media", "stills"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "03_analysis", "transcripts"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });

  const colors = ["red", "blue", "green", "yellow", "magenta", "cyan"];
  const assets: AssetItem[] = [];
  const sourceMapItems: Record<string, unknown>[] = [];
  const segments: Record<string, unknown>[] = [];
  for (const [index, color] of colors.entries()) {
    const sourcePath = path.join(projectDir, "02_media", "stills", `still-${index + 1}.png`);
    ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=64x96`, "-frames:v", "1", "-y", sourcePath]);
    const asset = await ingestAsset(sourcePath, { projectRoot: projectDir, mediaKind: "image", ffmpegVersion: "issue43-pilot" });
    const segmentId = `SEG_STILL_${index + 1}`;
    asset.segment_ids = [segmentId];
    asset.segments = 1;
    asset.analysis_status = "ready";
    assets.push(asset);
    sourceMapItems.push(sourceMapEntry(projectDir, asset.asset_id, sourcePath, "image", asset.source_content_sha256));
    segments.push(groundedStillSegment(projectDir, asset, segmentId));
  }

  const bgmPath = path.join(projectDir, "02_media", "song.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=28", "-c:a", "pcm_s16le", "-y", bgmPath]);
  const bgmSourceHash = computeMediaSourceHash(bgmPath);
  sourceMapItems.push(sourceMapEntry(projectDir, "AST_PILOT_BGM", bgmPath, "audio", bgmSourceHash));

  writeJson(path.join(projectDir, "03_analysis", "assets.json"), {
    project_id: "issue43-lyric-mv-pilot",
    artifact_version: "analysis-v1",
    items: assets,
  });
  writeJson(path.join(projectDir, "03_analysis", "segments.json"), {
    project_id: "issue43-lyric-mv-pilot",
    artifact_version: "analysis-v1",
    items: segments,
  });
  writeJson(path.join(projectDir, "02_media", "source_map.json"), {
    version: "1",
    project_id: "issue43-lyric-mv-pilot",
    media_dir: "02_media",
    generated_at: PILOT_CREATED_AT,
    items: sourceMapItems,
  });

  const beatsSec = Array.from({ length: 14 }, (_, index) => index * 2);
  writeJson(path.join(projectDir, "03_analysis", "bgm_analysis.json"), {
    version: "1",
    project_id: "issue43-lyric-mv-pilot",
    analysis_status: "ready",
    music_asset: {
      asset_id: "AST_PILOT_BGM",
      path: "02_media/song.wav",
      source_hash: bgmSourceHash,
      source_content_sha256: bgmSourceHash,
    },
    bpm: 30,
    meter: "4/4",
    duration_sec: 28,
    beats_sec: beatsSec,
    downbeats_sec: [0, 4, 8, 12, 16, 20, 24, 28],
    beats: beatsSec.map((time_sec) => ({ time_sec, strength: 0.8, evidence_classification: "measured" })),
    sections: [
      { id: "S1", label: "verse", start_sec: 0, end_sec: 4, energy: 0.35, evidence_classification: "measured" },
      { id: "S2", label: "chorus", start_sec: 4, end_sec: 20, energy: 0.9, evidence_classification: "measured" },
      { id: "S3", label: "outro", start_sec: 20, end_sec: 28, energy: 0.45, evidence_classification: "measured" },
    ],
    onsets: beatsSec.map((time_sec) => ({ time_sec, strength: 0.8, evidence_classification: "measured" })),
    provenance: {
      detector: "issue43-pilot",
      backend_name: "issue43-pilot",
      backend_version: "1",
      input_sample_rate_hz: 48000,
      processing_sample_rate_hz: 48000,
      hop_length_samples: 512,
      window_length_samples: 1024,
      time_unit: "seconds",
      evidence_classification: "measured",
      measurement_status: "complete",
      tempo_confidence: 1,
      fallback_used: false,
      source_content_sha256: bgmSourceHash,
    },
  });

  const brief = buildPilotBrief() as CreativeBrief;
  const blueprint = buildPilotBlueprint() as EditBlueprint;
  const candidates = buildPilotCandidates(assets);
  fs.writeFileSync(path.join(projectDir, "01_intent/creative_brief.yaml"), stringifyYaml(brief), "utf8");
  fs.writeFileSync(path.join(projectDir, "04_plan/edit_blueprint.yaml"), stringifyYaml(blueprint), "utf8");
  fs.writeFileSync(path.join(projectDir, "04_plan/selects_candidates.yaml"), stringifyYaml({
    version: "1",
    project_id: "issue43-lyric-mv-pilot",
    source_media: { mode: "mixed", media_kinds: ["image", "audio"], visual_candidate_count: 7, audio_only_candidate_count: 0 },
    editorial_summary: { dominant_visual_mode: "mixed", motion_profile: "low", transcript_density: "sparse" },
    candidates,
  }), "utf8");
  fs.writeFileSync(path.join(projectDir, "01_intent/lyrics.lrc"), [
    "[00:00.00]quiet in the first light",
    "[00:04.00]let the chorus breathe",
    "[00:08.00]hold the image through the turn",
    "[00:20.00]carry the light home",
  ].join("\n") + "\n", "utf8");
  return { projectDir, brief, blueprint, assets };
}

function ffprobeFrameCount(outputPath: string): number {
  const raw = execFileSync("ffprobe", [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", outputPath,
  ], { encoding: "utf8" }).trim();
  return Number(raw);
}

describe("Issue #43 executable six-source-still lyric_mv pilot", () => {
  it("preserves normalize/compile/render hold boundaries and is review-ready without a shot waiver", async () => {
    const fixture = await createPilotProject();
    const normalized = normalize(fixture.brief, fixture.blueprint);
    expect(normalized.beats.find((beat) => beat.beat_id === "b03")?.candidate_plan?.still_image?.hold)
      .toMatchObject({ unit: "section_boundary", section_id: "S2", boundary: "end" });
    const rhythmSnapshot = loadRhythmEvidenceSnapshot(fixture.projectDir, {
      projectId: "issue43-lyric-mv-pilot",
      repoRoot: path.resolve("."),
    });
    expect(rhythmSnapshot.bgmBound).toBe(true);
    expect(rhythmSnapshot.bgm?.analysis.sections.map((section) => section.id)).toContain("S2");

    const compiled = await runCanonicalCompile({
      projectPath: fixture.projectDir,
      createdAt: PILOT_CREATED_AT,
      repoRoot: path.resolve("."),
    });
    const timeline = compiled.timeline;
    const v1 = timeline.tracks.video.find((track) => track.track_id === "V1")!.clips;
    expect(v1).toHaveLength(7);
    expect(new Set(v1.map((clip) => clip.asset_id))).toHaveLength(6);
    const reused = v1.filter((clip) => clip.asset_id === v1[0].asset_id);
    expect(reused).toHaveLength(2);
    expect(reused[0].still_image?.source_still_id).toBe(reused[1].still_image?.source_still_id);
    expect(reused[0].still_image?.still_instance_id).not.toBe(reused[1].still_image?.still_instance_id);
    expect(reused[0].still_image?.transform).not.toEqual(reused[1].still_image?.transform);
    expect(reused[1].still_image?.reuse).toBe("intentional");

    const longHold = v1.find((clip) => clip.beat_id === "b03")!;
    expect(longHold.timeline_in_frame).toBe(96);
    expect(longHold.timeline_duration_frames).toBe(384);
    expect(longHold.still_image).toMatchObject({
      hold: { unit: "section_boundary", section_id: "S2", boundary: "end", reason: "hold the chorus still through its section boundary" },
      hold_resolution: { unit: "section_boundary", requested_frames: 384, resolved_frames: 384, boundary_frame: 480, status: "resolved" },
    });
    const lyricMetadata = timeline.metadata?.lyric_mv as Record<string, any>;
    expect(lyricMetadata).toMatchObject({ version: "lyric-mv/v1", profile_id: "lyric_mv" });
    expect(lyricMetadata.music_sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "S2", start_frame: 96, end_frame: 480 }),
    ]));
    expect(validateAgainstSchema(timeline, "timeline-ir.schema.json")).toMatchObject({ valid: true, errors: [] });

    const plan = buildVideoAssemblyPlan(timeline, new Set(fixture.assets.map((asset) => asset.asset_id)));
    const longPlan = plan.find((entry) => entry.clip_id === longHold.clip_id)!;
    expect(longPlan.still?.hold_resolution).toMatchObject({
      unit: "section_boundary", resolved_frames: 384, boundary_frame: 480,
    });

    // Keep final compile at the canonical 1080x1920 vertical dimensions, but
    // use a bounded 64x96 render projection for executable receipt evidence.
    // It carries the exact compiled clip geometry and canonical still metadata.
    const renderTimeline = structuredClone(timeline);
    renderTimeline.sequence.width = 64;
    renderTimeline.sequence.height = 96;
    const renderTimelinePath = path.join(fixture.projectDir, "05_timeline/pilot-render-timeline.json");
    const renderOutputPath = path.join(fixture.projectDir, "05_timeline/pilot-assembly.mp4");
    writeJson(renderTimelinePath, renderTimeline);
    const render = await assembleTimelineToMp4({
      projectDir: fixture.projectDir,
      timelinePath: renderTimelinePath,
      outputPath: renderOutputPath,
      includeAudio: false,
      stillCamera: ISSUE43_TEST_STILL_CAMERA,
    });
    expect(fs.existsSync(render.outputPath)).toBe(true);
    expect(ffprobeFrameCount(render.outputPath)).toBe(672);
    expect(render.still_camera_motion).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clip_id: longHold.clip_id,
        still_instance_id: longHold.still_image?.still_instance_id,
        duration_frames: 384,
        hold: expect.objectContaining({ unit: "section_boundary", resolved_frames: 384, boundary_frame: 480 }),
      }),
    ]));

    const cadence = evaluateLyricMvCadence(timeline);
    expect(cadence.status).not.toBe("fail");
    expect(cadence.composite.gaps_over_max).toEqual([]);
    expect(cadence.long_holds).toEqual(expect.arrayContaining([
      expect.objectContaining({ clip_id: longHold.clip_id, status: "intentional", section_id: "S2" }),
    ]));
    for (const component of ["background_cut", "caption_cue", "in_frame_motion", "music_section", "music_onset", "transition"]) {
      expect(cadence.component_breakdown[component as keyof typeof cadence.component_breakdown].event_count).toBeGreaterThan(0);
    }

    const metrics = computeReviewMetrics({
      timeline,
      brief: fixture.brief,
      blueprint: fixture.blueprint,
    } as ReviewMetricsInputs);
    const metricsValidation = validateAgainstSchema(metrics, "review-metrics.schema.json");
    expect(metricsValidation).toMatchObject({ valid: true, errors: [] });
    expect(metrics.checks.find((check) => check.id === "rhythm.max_shot_length")?.status).toBe("skipped");
    const compositeCheck = metrics.checks.find((check) => check.id === "rhythm.lyric_mv_composite_cadence");
    expect(compositeCheck?.status).not.toBe("fail");
    expect(compositeCheck?.measured).toMatchObject({
      component_breakdown: expect.objectContaining({
        caption_cue: expect.objectContaining({ event_count: expect.any(Number) }),
        in_frame_motion: expect.objectContaining({ event_count: expect.any(Number) }),
        music_section: expect.objectContaining({ event_count: expect.any(Number) }),
        music_onset: expect.objectContaining({ event_count: expect.any(Number) }),
      }),
      static_regions: expect.objectContaining({
        fully_static_count: expect.any(Number),
        changed_count: expect.any(Number),
      }),
    });
    expect(timeline.metadata?.timeline_operations).toBeUndefined();
  }, 120_000);
});
