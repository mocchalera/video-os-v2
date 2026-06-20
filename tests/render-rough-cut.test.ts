import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildHardCutGroupFfmpegArgs,
  buildRenderGroups,
  buildRenderClips,
  buildXfadeFilterGraph,
  computeRenderDurationAccounting,
  extractCrossfadeTransitions,
  extractVideoClips,
  findBgmCandidates,
  generateSourceMapFromAssets,
  selectBgmCandidate,
  validateRenderDurationAccounting,
  writeConcatList,
  type BgmCandidate,
  type RenderClip,
} from "../scripts/render-rough-cut.js";
import { applyAdaptiveTrim } from "../runtime/compiler/trim.js";
import type {
  Candidate,
  EditBlueprint,
  NormalizedBeat,
  TimelineClip as CompilerTimelineClip,
} from "../runtime/compiler/types.js";
import { loadSourceMap } from "../runtime/media/source-map.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempProject(name: string): string {
  const tmpDir = path.resolve(`tests/tmp_render_rough_cut_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  tempDirs.push(tmpDir);
  return tmpDir;
}

describe("generateSourceMapFromAssets", () => {
  it("creates 02_media/source_map.json by matching assets.json filenames", () => {
    const projectDir = createTempProject("source_map");
    const mediaDir = path.join(projectDir, "02_media");
    const analysisDir = path.join(projectDir, "03_analysis");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, "clip_a.MOV"), "video-a");
    fs.writeFileSync(path.join(mediaDir, "clip_b.mp4"), "video-b");
    fs.writeFileSync(path.join(mediaDir, "unmatched.mov"), "unused");
    fs.writeFileSync(
      path.join(analysisDir, "assets.json"),
      JSON.stringify({
        project_id: "test-project",
        items: [
          { asset_id: "AST_001", filename: "clip_a.mov", display_name: "Clip A" },
          { asset_id: "AST_002", filename: "clip_b.MP4" },
          { asset_id: "AST_003", filename: "missing.mov" },
        ],
      }),
      "utf-8",
    );

    const doc = generateSourceMapFromAssets(projectDir);

    expect(doc.items).toHaveLength(2);
    expect(doc.items.map((item) => item.asset_id)).toEqual(["AST_001", "AST_002"]);
    expect(doc.items[0]).toMatchObject({
      asset_id: "AST_001",
      display_name: "Clip A",
      kind: "asset",
      link_path: "02_media/clip_a.MOV",
    });

    const loaded = loadSourceMap(projectDir);
    expect(loaded.entryMap.get("AST_002")?.source_locator).toBe(path.join(mediaDir, "clip_b.mp4"));
  });
});

describe("BGM selection", () => {
  it("probes bgm files and selects the closest candidate that is not shorter", async () => {
    const projectDir = createTempProject("bgm");
    const mediaDir = path.join(projectDir, "02_media");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, "bgm_short.mp3"), "short");
    fs.writeFileSync(path.join(mediaDir, "bgm_exact.wav"), "exact");
    fs.writeFileSync(path.join(mediaDir, "bgm_long.mp3"), "long");
    fs.writeFileSync(path.join(mediaDir, "theme.mp3"), "ignored");

    const durations = new Map([
      [path.join(mediaDir, "bgm_short.mp3"), 9],
      [path.join(mediaDir, "bgm_exact.wav"), 12],
      [path.join(mediaDir, "bgm_long.mp3"), 20],
    ]);
    const candidates = await findBgmCandidates(projectDir, async (filePath) => durations.get(filePath) ?? 0);

    expect(candidates.map((candidate) => path.basename(candidate.path))).toEqual([
      "bgm_exact.wav",
      "bgm_long.mp3",
      "bgm_short.mp3",
    ]);
    expect(selectBgmCandidate(candidates, 11)?.path).toBe(path.join(mediaDir, "bgm_exact.wav"));
    expect(selectBgmCandidate(candidates, 13)?.path).toBe(path.join(mediaDir, "bgm_long.mp3"));
    expect(selectBgmCandidate(candidates, 21)).toBeUndefined();
  });
});

describe("timeline clip extraction", () => {
  it("extracts video clips in timeline order across tracks", () => {
    const timeline = {
      sequence: { fps_num: 24, fps_den: 1 },
      tracks: {
        video: [
          {
            clips: [
              { clip_id: "late", asset_id: "AST_003", src_in_us: 3_000_000, src_out_us: 4_000_000, timeline_in_frame: 48, timeline_duration_frames: 24 },
              { clip_id: "first-v1", asset_id: "AST_001", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 24 },
            ],
          },
          {
            clips: [
              { clip_id: "first-v2", asset_id: "AST_002", src_in_us: 1_000_000, src_out_us: 3_000_000, timeline_in_frame: 0, timeline_duration_frames: 48 },
              { clip_id: "invalid", asset_id: "AST_004", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 1, timeline_duration_frames: 0 },
            ],
          },
        ],
        audio: [
          {
            clips: [
              { clip_id: "audio", asset_id: "AST_A", src_in_us: 0, timeline_in_frame: 0, timeline_duration_frames: 24 },
            ],
          },
        ],
      },
    };

    expect(extractVideoClips(timeline).map((clip) => clip.clip_id)).toEqual([
      "first-v1",
      "first-v2",
      "late",
    ]);
  });

  it("builds render clips from timeline clips and source_map entries", () => {
    const projectDir = createTempProject("render_clips");
    const sourcePath = path.join(projectDir, "source.mov");
    fs.writeFileSync(sourcePath, "source");

    const warnings: string[] = [];
    const renderClips = buildRenderClips(
      [
        { clip_id: "c1", asset_id: "AST_001", src_in_us: 1_500_000, src_out_us: 4_000_000, timeline_in_frame: 12, timeline_duration_frames: 48 },
        { clip_id: "missing", asset_id: "AST_404", src_in_us: 0, src_out_us: 1_000_000, timeline_duration_frames: 24 },
      ],
      new Map([
        [
          "AST_001",
          {
            asset_id: "AST_001",
            source_locator: sourcePath,
            local_source_path: sourcePath,
            link_path: "source.mov",
          },
        ],
      ]),
      24,
      (message) => warnings.push(message),
    );

    expect(renderClips).toEqual([
      {
        clipId: "c1",
        assetId: "AST_001",
        sourcePath,
        startSec: 1.5,
        durationSec: 2,
        timelineInFrame: 12,
        timelineDurationSec: 2,
        sourceRangeDurationSec: 2.5,
        timelineOutFrame: 60,
      },
    ]);
    expect(warnings[0]).toContain("missing source_map entry");
  });

  it("clamps render duration to the source in/out range", () => {
    const projectDir = createTempProject("render_clips_clamp");
    const sourcePath = path.join(projectDir, "source.mov");
    fs.writeFileSync(sourcePath, "source");

    const renderClips = buildRenderClips(
      [
        {
          clip_id: "c1",
          asset_id: "AST_001",
          src_in_us: 2_000_000,
          src_out_us: 7_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 240,
        },
      ],
      new Map([
        [
          "AST_001",
          {
            asset_id: "AST_001",
            source_locator: sourcePath,
            local_source_path: sourcePath,
            link_path: "source.mov",
          },
        ],
      ]),
      24,
    );

    expect(renderClips[0].durationSec).toBe(5);
  });

  it("keeps render duration aligned when adaptive trim shortens a source range", () => {
    const projectDir = createTempProject("adaptive_trim_render");
    const sourcePath = path.join(projectDir, "source.mov");
    fs.writeFileSync(sourcePath, "source");

    const candidate: Candidate = {
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 10_000_000,
      role: "hero",
      why_it_matches: "test",
      risks: [],
      confidence: 0.9,
      trim_hint: {
        source_center_us: 5_000_000,
        preferred_duration_us: 5_000_000,
      },
    };
    const clip: CompilerTimelineClip = {
      clip_id: "c1",
      segment_id: candidate.segment_id,
      asset_id: candidate.asset_id,
      src_in_us: candidate.src_in_us,
      src_out_us: candidate.src_out_us,
      timeline_in_frame: 0,
      timeline_duration_frames: 240,
      role: "hero",
      motivation: "test",
      beat_id: "B01",
      fallback_segment_ids: [],
      confidence: 0.9,
      quality_flags: [],
    };
    const blueprint = { trim_policy: { mode: "adaptive" } } as EditBlueprint;
    const beat: NormalizedBeat = {
      beat_id: "B01",
      label: "Beat 1",
      target_duration_frames: 240,
      required_roles: ["hero"],
      preferred_roles: [],
      purpose: "test",
    };

    applyAdaptiveTrim([clip], [candidate], blueprint, [beat], 1_000_000 / 24);

    expect(clip.src_in_us).toBe(2_500_000);
    expect(clip.src_out_us).toBe(7_500_000);
    expect(clip.timeline_duration_frames).toBe(120);

    const renderClips = buildRenderClips(
      [clip],
      new Map([
        [
          "AST_001",
          {
            asset_id: "AST_001",
            source_locator: sourcePath,
            local_source_path: sourcePath,
            link_path: "source.mov",
          },
        ],
      ]),
      24,
    );

    expect(renderClips[0]).toMatchObject({
      startSec: 2.5,
      durationSec: 5,
    });
  });
});

describe("writeConcatList", () => {
  it("writes ffmpeg concat list entries with absolute escaped paths", () => {
    const projectDir = createTempProject("concat");
    const listPath = path.join(projectDir, "concat.txt");
    const clipA = path.join(projectDir, "clip one.mp4");
    const clipB = path.join(projectDir, "clip's two.mp4");

    writeConcatList(listPath, [clipA, clipB]);

    expect(fs.readFileSync(listPath, "utf-8")).toBe(
      [
        `file '${clipA}'`,
        `file '${clipB.replace(/'/g, "'\\''")}'`,
        "",
      ].join("\n"),
    );
  });

  it("selects undefined for an empty BGM candidate list", () => {
    const candidates: BgmCandidate[] = [];
    expect(selectBgmCandidate(candidates, 10)).toBeUndefined();
  });
});

describe("crossfade render planning", () => {
  it("extracts crossfade transitions by destination clip id", () => {
    const timeline = {
      sequence: { fps_num: 24, fps_den: 1 },
      transitions: [
        {
          transition_id: "TR_001",
          from_clip_id: "clip_a",
          to_clip_id: "clip_b",
          track_id: "V1",
          transition_type: "crossfade",
          transition_params: { crossfade_sec: 0.5 },
        },
        {
          transition_id: "TR_002",
          from_clip_id: "clip_b",
          to_clip_id: "clip_c",
          track_id: "V1",
          transition_type: "cut",
        },
      ],
    };

    const transitions = extractCrossfadeTransitions(timeline, 24);

    expect(transitions.get("clip_b")).toEqual({
      fromClipId: "clip_a",
      toClipId: "clip_b",
      durationSec: 0.5,
    });
    expect(transitions.has("clip_c")).toBe(false);
  });

  it("groups hard cuts and separates adjacent clips that need xfade", () => {
    const clips: RenderClip[] = [
      renderClip("clip_a", 2),
      renderClip("clip_b", 3),
      renderClip("clip_c", 4),
    ];
    const transitions = new Map([
      ["clip_c", { fromClipId: "clip_b", toClipId: "clip_c", durationSec: 0.5 }],
    ]);

    const groups = buildRenderGroups(clips, ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4"], transitions);

    expect(groups).toEqual([
      { clipPaths: ["/tmp/a.mp4", "/tmp/b.mp4"], durationSec: 5 },
      {
        clipPaths: ["/tmp/c.mp4"],
        durationSec: 4,
        transitionIn: { fromClipId: "clip_b", toClipId: "clip_c", durationSec: 0.5 },
      },
    ]);
  });

  it("builds an iterative xfade filter graph with cumulative offsets", () => {
    const graph = buildXfadeFilterGraph([
      { path: "/tmp/a.mp4", durationSec: 2 },
      {
        path: "/tmp/b.mp4",
        durationSec: 3,
        transitionIn: { fromClipId: "a", toClipId: "b", durationSec: 0.5 },
      },
      {
        path: "/tmp/c.mp4",
        durationSec: 4,
        transitionIn: { fromClipId: "b", toClipId: "c", durationSec: 0.5 },
      },
    ]);

    expect(graph?.outputLabel).toBe("vout");
    expect(graph?.xfadeCount).toBe(2);
    expect(graph?.durationSec).toBe(8);
    expect(graph?.filterComplex).toContain("[0:v]settb=AVTB,setpts=PTS-STARTPTS[v0]");
    expect(graph?.filterComplex).toContain("[v0][v1]xfade=transition=fade:duration=0.5:offset=1.5[xf1]");
    expect(graph?.filterComplex).toContain("[xf1][v2]xfade=transition=fade:duration=0.5:offset=4[vout]");
  });
});

describe("duration accounting", () => {
  it("computes collapsed gaps, source clamps, and crossfade overlap", () => {
    const clips: RenderClip[] = [
      renderClip("clip_a", 2, 0, 2, 2),
      renderClip("clip_b", 2.8, 72, 3, 2.8),
      renderClip("clip_c", 4, 144, 4, 4),
    ];
    const transitions = new Map([
      ["clip_c", { fromClipId: "clip_b", toClipId: "clip_c", durationSec: 0.5 }],
    ]);
    const groups = buildRenderGroups(clips, ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4"], transitions);

    const accounting = computeRenderDurationAccounting(clips, groups, 24);

    expect(accounting).toEqual({
      timeline_span_sec: 10,
      timeline_content_sec: 9,
      gap_sec: 1,
      gap_count: 1,
      crossfade_overlap_sec: 0.5,
      source_clamp_sec: 0.2,
      expected_rendered_sec: 8.3,
    });
  });

  it("sets expected rendered duration to content minus crossfade overlaps and source clamps", () => {
    const clips: RenderClip[] = [
      renderClip("clip_a", 1.75, 0, 2, 1.75),
      renderClip("clip_b", 2, 48, 2, 2),
    ];
    const groups = buildRenderGroups(
      clips,
      ["/tmp/a.mp4", "/tmp/b.mp4"],
      new Map([["clip_b", { fromClipId: "clip_a", toClipId: "clip_b", durationSec: 0.25 }]]),
    );

    const accounting = computeRenderDurationAccounting(clips, groups, 24);

    expect(accounting.timeline_content_sec).toBe(4);
    expect(accounting.source_clamp_sec).toBe(0.25);
    expect(accounting.crossfade_overlap_sec).toBe(0.25);
    expect(accounting.expected_rendered_sec).toBe(3.5);
  });

  it("passes duration parity when actual duration is within threshold", () => {
    const warnings: string[] = [];

    const accounting = validateRenderDurationAccounting(
      {
        timeline_span_sec: 10,
        timeline_content_sec: 9,
        gap_sec: 1,
        gap_count: 1,
        crossfade_overlap_sec: 0.5,
        source_clamp_sec: 0.2,
        expected_rendered_sec: 8.3,
      },
      8,
      (message) => warnings.push(message),
    );

    expect(accounting.actual_rendered_sec).toBe(8);
    expect(accounting.parity_delta_sec).toBe(-0.3);
    expect(accounting.parity_pass).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("warns when duration parity diverges beyond threshold", () => {
    const warnings: string[] = [];

    const accounting = validateRenderDurationAccounting(
      {
        timeline_span_sec: 10,
        timeline_content_sec: 9,
        gap_sec: 1,
        gap_count: 1,
        crossfade_overlap_sec: 0.5,
        source_clamp_sec: 0.2,
        expected_rendered_sec: 8.3,
      },
      7,
      (message) => warnings.push(message),
    );

    expect(accounting.actual_rendered_sec).toBe(7);
    expect(accounting.parity_delta_sec).toBe(-1.3);
    expect(accounting.parity_pass).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("render duration parity delta -1.300s exceeds 0.500s");
  });
});

describe("hard-cut group concat command", () => {
  it("re-encodes groups that will feed an xfade graph", () => {
    const args = buildHardCutGroupFfmpegArgs("/tmp/list.txt", "/tmp/group.mp4", {
      fps: 24,
      normalizeTimestamps: true,
    });

    expect(args).toContain("-c:v");
    expect(args).toContain("libx264");
    expect(args).toContain("-crf");
    expect(args).toContain("18");
    expect(args).toContain("-pix_fmt");
    expect(args).toContain("yuv420p");
    expect(args).toContain("-r");
    expect(args[args.indexOf("-r") + 1]).toBe("24");
    expect(args).toContain("-an");
    expect(args.join(" ")).not.toContain("-c copy");
  });

  it("keeps copy concat for hard-cut-only renders", () => {
    const args = buildHardCutGroupFfmpegArgs("/tmp/list.txt", "/tmp/group.mp4", {
      fps: 24,
      normalizeTimestamps: false,
    });

    expect(args).toEqual([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "/tmp/list.txt",
      "-c",
      "copy",
      "/tmp/group.mp4",
    ]);
  });
});

function renderClip(
  clipId: string,
  durationSec: number,
  timelineInFrame = 0,
  timelineDurationSec = durationSec,
  sourceRangeDurationSec = durationSec,
): RenderClip {
  return {
    clipId,
    assetId: `AST_${clipId}`,
    sourcePath: `/tmp/${clipId}.mov`,
    startSec: 0,
    durationSec,
    timelineInFrame,
    timelineDurationSec,
    sourceRangeDurationSec,
    timelineOutFrame: timelineInFrame + Math.round(timelineDurationSec * 24),
  };
}
