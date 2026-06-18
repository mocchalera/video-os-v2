import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildRenderGroups,
  buildRenderClips,
  buildXfadeFilterGraph,
  extractCrossfadeTransitions,
  extractVideoClips,
  findBgmCandidates,
  generateSourceMapFromAssets,
  selectBgmCandidate,
  writeConcatList,
  type BgmCandidate,
  type RenderClip,
} from "../scripts/render-rough-cut.js";
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
              { clip_id: "late", asset_id: "AST_003", src_in_us: 3_000_000, timeline_in_frame: 48, timeline_duration_frames: 24 },
              { clip_id: "first-v1", asset_id: "AST_001", src_in_us: 0, timeline_in_frame: 0, timeline_duration_frames: 24 },
            ],
          },
          {
            clips: [
              { clip_id: "first-v2", asset_id: "AST_002", src_in_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 48 },
              { clip_id: "invalid", asset_id: "AST_004", src_in_us: 0, timeline_in_frame: 1, timeline_duration_frames: 0 },
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
        { clip_id: "c1", asset_id: "AST_001", src_in_us: 1_500_000, timeline_in_frame: 12, timeline_duration_frames: 48 },
        { clip_id: "missing", asset_id: "AST_404", src_in_us: 0, timeline_duration_frames: 24 },
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
      },
    ]);
    expect(warnings[0]).toContain("missing source_map entry");
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

function renderClip(clipId: string, durationSec: number): RenderClip {
  return {
    clipId,
    assetId: `AST_${clipId}`,
    sourcePath: `/tmp/${clipId}.mov`,
    startSec: 0,
    durationSec,
    timelineInFrame: 0,
  };
}
