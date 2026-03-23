import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Mock child_process before imports ───────────────────────────────

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  extractVideoClips,
  filterByBeat,
  filterByDuration,
  buildClipExtractArgs,
  buildConcatFileContent,
  defaultOutputPath,
  renderPreviewSegment,
} from "../runtime/preview/segment-renderer.js";

import {
  clipMidpointSec,
  buildFrameExtractArgs,
  buildHstackFilter,
  buildContactSheetArgs,
  generateTimelineOverview,
} from "../runtime/preview/timeline-overview.js";

import type { LoadedSourceMap } from "../runtime/media/source-map.js";

// ── Fixtures ────────────────────────────────────────────────────────

const SAMPLE_TIMELINE = {
  version: "1",
  project_id: "test-project",
  created_at: "2026-03-21T00:00:00Z",
  sequence: {
    name: "Test",
    fps_num: 24,
    fps_den: 1,
    width: 1920,
    height: 1080,
    start_frame: 0,
  },
  tracks: {
    video: [
      {
        track_id: "V1",
        kind: "video",
        clips: [
          {
            clip_id: "CLP_0001",
            segment_id: "SEG_001",
            asset_id: "AST_001",
            src_in_us: 1_000_000,
            src_out_us: 5_000_000,
            timeline_in_frame: 0,
            timeline_duration_frames: 96,
            beat_id: "b01",
            role: "hero",
            motivation: "test",
            fallback_segment_ids: [],
            confidence: 0.9,
            quality_flags: [],
          },
          {
            clip_id: "CLP_0002",
            segment_id: "SEG_002",
            asset_id: "AST_002",
            src_in_us: 2_000_000,
            src_out_us: 8_000_000,
            timeline_in_frame: 96,
            timeline_duration_frames: 144,
            beat_id: "b02",
            role: "hero",
            motivation: "test",
            fallback_segment_ids: [],
            confidence: 0.85,
            quality_flags: [],
          },
          {
            clip_id: "CLP_0003",
            segment_id: "SEG_003",
            asset_id: "AST_001",
            src_in_us: 10_000_000,
            src_out_us: 15_000_000,
            timeline_in_frame: 240,
            timeline_duration_frames: 120,
            beat_id: "b03",
            role: "hero",
            motivation: "test",
            fallback_segment_ids: [],
            confidence: 0.88,
            quality_flags: [],
          },
        ],
      },
      {
        track_id: "V2",
        kind: "video",
        clips: [
          {
            clip_id: "CLP_0004",
            segment_id: "SEG_004",
            asset_id: "AST_003",
            src_in_us: 0,
            src_out_us: 3_000_000,
            timeline_in_frame: 0,
            timeline_duration_frames: 72,
            beat_id: "b01",
            role: "texture",
            motivation: "test",
            fallback_segment_ids: [],
            confidence: 0.8,
            quality_flags: [],
          },
        ],
      },
    ],
    audio: [
      { track_id: "A1", kind: "audio", clips: [] },
    ],
  },
  markers: [
    { frame: 0, kind: "beat", label: "b01: hook" },
    { frame: 96, kind: "beat", label: "b02: settle" },
    { frame: 240, kind: "beat", label: "b03: climb" },
  ],
  provenance: {
    brief_path: "01_intent/creative_brief.yaml",
    blueprint_path: "04_plan/edit_blueprint.yaml",
    selects_path: "04_plan/selects_candidates.yaml",
    compiler_version: "1.0.0",
  },
};

function createMockSourceMap(basePath: string): LoadedSourceMap {
  const entries = [
    {
      asset_id: "AST_001",
      source_locator: path.join(basePath, "media", "ast_001.mov"),
      local_source_path: path.join(basePath, "media", "ast_001.mov"),
      link_path: "02_media/ast_001.mov",
    },
    {
      asset_id: "AST_002",
      source_locator: path.join(basePath, "media", "ast_002.mov"),
      local_source_path: path.join(basePath, "media", "ast_002.mov"),
      link_path: "02_media/ast_002.mov",
    },
  ];

  return {
    locatorMap: new Map(entries.map((e) => [e.asset_id, e.source_locator])),
    entryMap: new Map(entries.map((e) => [e.asset_id, e])),
    entries,
  };
}

// ── Segment Renderer Unit Tests ─────────────────────────────────────

describe("segment-renderer", () => {
  describe("extractVideoClips", () => {
    it("extracts only V1 clips sorted by timeline position", () => {
      const clips = extractVideoClips(SAMPLE_TIMELINE);
      expect(clips).toHaveLength(3);
      expect(clips[0].clip_id).toBe("CLP_0001");
      expect(clips[1].clip_id).toBe("CLP_0002");
      expect(clips[2].clip_id).toBe("CLP_0003");
    });

    it("returns empty array when no video tracks exist", () => {
      const timeline = {
        ...SAMPLE_TIMELINE,
        tracks: { video: [], audio: [] },
      };
      expect(extractVideoClips(timeline)).toEqual([]);
    });
  });

  describe("filterByBeat", () => {
    it("filters clips by beat ID", () => {
      const clips = extractVideoClips(SAMPLE_TIMELINE);
      const b01 = filterByBeat(clips, "b01");
      expect(b01).toHaveLength(1);
      expect(b01[0].beat_id).toBe("b01");

      const b02 = filterByBeat(clips, "b02");
      expect(b02).toHaveLength(1);
      expect(b02[0].clip_id).toBe("CLP_0002");
    });

    it("returns empty array for non-existent beat", () => {
      const clips = extractVideoClips(SAMPLE_TIMELINE);
      expect(filterByBeat(clips, "b99")).toEqual([]);
    });
  });

  describe("filterByDuration", () => {
    it("returns all clips within the first N seconds", () => {
      const clips = extractVideoClips(SAMPLE_TIMELINE);
      // 96 frames at 24fps = 4 seconds. First 5 seconds should include b01 only.
      const filtered = filterByDuration(clips, 5, 24, 1);
      expect(filtered).toHaveLength(2); // CLP_0001 (0-96) and CLP_0002 (96-240, truncated at 120)
      expect(filtered[0].clip_id).toBe("CLP_0001");
      expect(filtered[1].clip_id).toBe("CLP_0002");
    });

    it("truncates clips that extend beyond the duration limit", () => {
      const clips = extractVideoClips(SAMPLE_TIMELINE);
      // 5 seconds = 120 frames at 24fps
      const filtered = filterByDuration(clips, 5, 24, 1);
      // CLP_0002 starts at frame 96, maxFrame=120, so trimmed to 24 frames
      expect(filtered[1].timeline_duration_frames).toBe(24);
    });

    it("returns empty array when no clips are within the limit", () => {
      const clips = [
        { ...extractVideoClips(SAMPLE_TIMELINE)[2], timeline_in_frame: 1000 },
      ];
      expect(filterByDuration(clips, 1, 24, 1)).toEqual([]);
    });
  });

  describe("buildClipExtractArgs", () => {
    it("constructs correct ffmpeg args for 720p extraction", () => {
      const args = buildClipExtractArgs(
        "/path/to/source.mov",
        1_000_000,
        5_000_000,
        "/path/to/output.mp4",
      );

      expect(args).toContain("-y");
      expect(args).toContain("-ss");
      expect(args[args.indexOf("-ss") + 1]).toBe("1.000000");
      expect(args).toContain("-t");
      expect(args[args.indexOf("-t") + 1]).toBe("4.000000");
      expect(args).toContain("-vf");
      expect(args[args.indexOf("-vf") + 1]).toBe("scale=-2:720");
      expect(args).toContain("-preset");
      expect(args[args.indexOf("-preset") + 1]).toBe("ultrafast");
      expect(args).toContain("-crf");
      expect(args[args.indexOf("-crf") + 1]).toBe("28");
      expect(args).toContain("-an");
      expect(args[args.length - 1]).toBe("/path/to/output.mp4");
    });
  });

  describe("buildConcatFileContent", () => {
    it("generates correct concat demuxer format", () => {
      const content = buildConcatFileContent([
        "/tmp/clip_0000.mp4",
        "/tmp/clip_0001.mp4",
      ]);
      expect(content).toBe(
        "file '/tmp/clip_0000.mp4'\nfile '/tmp/clip_0001.mp4'",
      );
    });

    it("escapes single quotes in paths", () => {
      const content = buildConcatFileContent(["/tmp/it's.mp4"]);
      expect(content).toBe("file '/tmp/it'\\''s.mp4'");
    });
  });

  describe("defaultOutputPath", () => {
    it("uses beat name when beatId is provided", () => {
      const p = defaultOutputPath("/project", "b01");
      expect(p).toBe(path.join("/project", "05_timeline", "preview-b01.mp4"));
    });

    it("uses duration when firstNSec is provided", () => {
      const p = defaultOutputPath("/project", undefined, 30);
      expect(p).toBe(path.join("/project", "05_timeline", "preview-first30s.mp4"));
    });

    it("uses 'full' when neither filter is provided", () => {
      const p = defaultOutputPath("/project");
      expect(p).toBe(path.join("/project", "05_timeline", "preview-full.mp4"));
    });
  });
});

// ── Segment Renderer Integration Test ───────────────────────────────

describe("renderPreviewSegment integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-preview-"));
    execFileMock.mockReset();
    execFileMock.mockImplementation((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      const outputPath = args[args.length - 1];
      if (typeof outputPath === "string" && !outputPath.startsWith("-")) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "stub-video", "utf-8");
      }
      cb(null, "", "");
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupProject(): { timelinePath: string; sourceMap: LoadedSourceMap } {
    const timelineDir = path.join(tmpDir, "05_timeline");
    fs.mkdirSync(timelineDir, { recursive: true });
    const timelinePath = path.join(timelineDir, "timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(SAMPLE_TIMELINE, null, 2), "utf-8");

    // Create mock media files
    const mediaDir = path.join(tmpDir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, "ast_001.mov"), "stub", "utf-8");
    fs.writeFileSync(path.join(mediaDir, "ast_002.mov"), "stub", "utf-8");

    const sourceMap = createMockSourceMap(tmpDir);
    return { timelinePath, sourceMap };
  }

  it("renders a full preview with all V1 clips", async () => {
    const { timelinePath, sourceMap } = setupProject();

    const result = await renderPreviewSegment({
      projectDir: tmpDir,
      timelinePath,
      sourceMap,
    });

    expect(result.clipCount).toBe(3);
    expect(result.durationSec).toBeCloseTo(15, 0); // (96+144+120)/24 = 15
    expect(result.outputPath).toContain("preview-full.mp4");
    // ffmpeg called 3 times for clip extraction + 1 for concat
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("renders a beat-specific preview", async () => {
    const { timelinePath, sourceMap } = setupProject();

    const result = await renderPreviewSegment({
      projectDir: tmpDir,
      timelinePath,
      sourceMap,
      beatId: "b02",
    });

    expect(result.clipCount).toBe(1);
    expect(result.outputPath).toContain("preview-b02.mp4");
    // Single clip — 1 extraction call, no concat
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("renders a time-limited preview", async () => {
    const { timelinePath, sourceMap } = setupProject();

    const result = await renderPreviewSegment({
      projectDir: tmpDir,
      timelinePath,
      sourceMap,
      firstNSec: 5,
    });

    expect(result.clipCount).toBe(2);
    expect(result.outputPath).toContain("preview-first5s.mp4");
  });

  it("throws when beat ID is not found", async () => {
    const { timelinePath, sourceMap } = setupProject();

    await expect(
      renderPreviewSegment({
        projectDir: tmpDir,
        timelinePath,
        sourceMap,
        beatId: "b99",
      }),
    ).rejects.toThrow("No clips found for beat: b99");
  });

  it("throws when source file is missing from source map", async () => {
    const { timelinePath } = setupProject();

    const emptySourceMap: LoadedSourceMap = {
      locatorMap: new Map(),
      entryMap: new Map(),
      entries: [],
    };

    await expect(
      renderPreviewSegment({
        projectDir: tmpDir,
        timelinePath,
        sourceMap: emptySourceMap,
      }),
    ).rejects.toThrow("Source file not found for asset AST_001");
  });
});

// ── Timeline Overview Unit Tests ────────────────────────────────────

describe("timeline-overview", () => {
  describe("clipMidpointSec", () => {
    it("computes the midpoint of a clip's source range", () => {
      expect(clipMidpointSec(1_000_000, 5_000_000)).toBe(3.0);
      expect(clipMidpointSec(0, 10_000_000)).toBe(5.0);
    });
  });

  describe("buildFrameExtractArgs", () => {
    it("constructs correct ffmpeg args for thumbnail extraction", () => {
      const args = buildFrameExtractArgs("/source.mov", 3.5, 180, "/out.png");

      expect(args).toContain("-y");
      expect(args).toContain("-ss");
      expect(args[args.indexOf("-ss") + 1]).toBe("3.500000");
      expect(args).toContain("-vframes");
      expect(args[args.indexOf("-vframes") + 1]).toBe("1");
      expect(args).toContain("-vf");
      expect(args[args.indexOf("-vf") + 1]).toBe("scale=-2:180");
      expect(args[args.length - 1]).toBe("/out.png");
    });
  });

  describe("buildHstackFilter", () => {
    it("returns simple scale for single image", () => {
      expect(buildHstackFilter(1, 180)).toBe("[0:v]scale=-2:180[out]");
    });

    it("generates correct hstack filter for multiple images", () => {
      const filter = buildHstackFilter(3, 180);
      expect(filter).toContain("[0:v]scale=-2:180[s0]");
      expect(filter).toContain("[1:v]scale=-2:180[s1]");
      expect(filter).toContain("[2:v]scale=-2:180[s2]");
      expect(filter).toContain("[s0][s1][s2]hstack=inputs=3[out]");
    });
  });

  describe("buildContactSheetArgs", () => {
    it("constructs correct ffmpeg args for contact sheet assembly", () => {
      const args = buildContactSheetArgs(
        ["/a.png", "/b.png"],
        180,
        "/out.png",
      );

      expect(args).toContain("-y");
      expect(args).toContain("-i");
      expect(args[args.indexOf("-i") + 1]).toBe("/a.png");
      expect(args).toContain("-filter_complex");
      expect(args).toContain("-map");
      expect(args[args.indexOf("-map") + 1]).toBe("[out]");
      expect(args[args.length - 1]).toBe("/out.png");
    });
  });
});

// ── Timeline Overview Integration Test ──────────────────────────────

describe("generateTimelineOverview integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-overview-"));
    execFileMock.mockReset();
    execFileMock.mockImplementation((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      const outputPath = args[args.length - 1];
      if (typeof outputPath === "string" && !outputPath.startsWith("-")) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "stub-image", "utf-8");
      }
      cb(null, "", "");
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates an overview image from V1 clips", async () => {
    const timelineDir = path.join(tmpDir, "05_timeline");
    fs.mkdirSync(timelineDir, { recursive: true });
    const timelinePath = path.join(timelineDir, "timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(SAMPLE_TIMELINE, null, 2), "utf-8");

    const mediaDir = path.join(tmpDir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, "ast_001.mov"), "stub", "utf-8");
    fs.writeFileSync(path.join(mediaDir, "ast_002.mov"), "stub", "utf-8");

    const sourceMap = createMockSourceMap(tmpDir);

    const result = await generateTimelineOverview({
      projectDir: tmpDir,
      timelinePath,
      sourceMap,
    });

    expect(result.clipCount).toBe(3);
    expect(result.outputPath).toContain("timeline-overview.png");
    expect(fs.existsSync(result.outputPath)).toBe(true);

    // 3 frame extractions + 1 hstack assembly
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("supports custom output path", async () => {
    const timelineDir = path.join(tmpDir, "05_timeline");
    fs.mkdirSync(timelineDir, { recursive: true });
    const timelinePath = path.join(timelineDir, "timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(SAMPLE_TIMELINE, null, 2), "utf-8");

    const mediaDir = path.join(tmpDir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, "ast_001.mov"), "stub", "utf-8");
    fs.writeFileSync(path.join(mediaDir, "ast_002.mov"), "stub", "utf-8");

    const sourceMap = createMockSourceMap(tmpDir);
    const customPath = path.join(tmpDir, "custom-overview.png");

    const result = await generateTimelineOverview({
      projectDir: tmpDir,
      timelinePath,
      sourceMap,
      outputPath: customPath,
    });

    expect(result.outputPath).toBe(customPath);
    expect(fs.existsSync(customPath)).toBe(true);
  });

  it("throws when no video clips exist", async () => {
    const timelineDir = path.join(tmpDir, "05_timeline");
    fs.mkdirSync(timelineDir, { recursive: true });
    const timelinePath = path.join(timelineDir, "timeline.json");

    const emptyTimeline = {
      ...SAMPLE_TIMELINE,
      tracks: { video: [{ track_id: "V1", kind: "video", clips: [] }], audio: [] },
    };
    fs.writeFileSync(timelinePath, JSON.stringify(emptyTimeline, null, 2), "utf-8");

    await expect(
      generateTimelineOverview({
        projectDir: tmpDir,
        timelinePath,
        sourceMap: createMockSourceMap(tmpDir),
      }),
    ).rejects.toThrow("No video clips found in V1 track");
  });

  it("skips clips without source files and succeeds with partial results", async () => {
    const timelineDir = path.join(tmpDir, "05_timeline");
    fs.mkdirSync(timelineDir, { recursive: true });
    const timelinePath = path.join(timelineDir, "timeline.json");

    // Timeline with only AST_001 clips (AST_002 won't have source)
    const partialTimeline = {
      ...SAMPLE_TIMELINE,
      tracks: {
        ...SAMPLE_TIMELINE.tracks,
        video: [
          {
            track_id: "V1",
            kind: "video",
            clips: [SAMPLE_TIMELINE.tracks.video[0].clips[0]], // Only AST_001
          },
        ],
      },
    };
    fs.writeFileSync(timelinePath, JSON.stringify(partialTimeline, null, 2), "utf-8");

    const mediaDir = path.join(tmpDir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, "ast_001.mov"), "stub", "utf-8");

    const sourceMap = createMockSourceMap(tmpDir);

    const result = await generateTimelineOverview({
      projectDir: tmpDir,
      timelinePath,
      sourceMap,
    });

    expect(result.clipCount).toBe(1);
    // Single clip: 1 extraction, no hstack needed (just copy)
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
