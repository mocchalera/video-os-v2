import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaSourceMapEntry } from "../runtime/media/source-map.js";

interface MockCalls {
  ensure: string[];
  analyze: Array<[string, number, number]>;
  find: Array<[string, string]>;
  extract: Array<[string, number, string]>;
}

interface MockFootageCalls {
  status: string[];
  build: Array<Record<string, unknown>>;
  search: Array<[string, Record<string, unknown>]>;
  similar: Array<[string, Record<string, unknown>]>;
  unused: Array<[string, Record<string, unknown>]>;
  best: Array<[string, Record<string, unknown>]>;
  statusValue?: "ready" | "missing" | "stale" | "malformed";
  buildError?: Error;
}

let projectDir: string | null = null;

function createProject(): { projectDir: string; sourcePath: string; sourceMap: Map<string, MediaSourceMapEntry> } {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-tools-"));
  const sourcePath = path.join(projectDir, "02_media", "source.mp4");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "mock video");
  const sourceMap = new Map<string, MediaSourceMapEntry>([
    ["AST_001", {
      asset_id: "AST_001",
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: "02_media/source.mp4",
    }],
  ]);
  return { projectDir, sourcePath, sourceMap };
}

function mockResponse(tool: string, input: Record<string, unknown>) {
  return {
    query: { query: tool, ...input },
    db_status: "ready",
    mode_used: "hybrid",
    results: [{
      segment_id: `SEG_${tool}`,
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 1_000_000,
      duration_us: 1_000_000,
      score: 1,
      scores: { final: 1 },
      match_reason: `${tool} mock`,
      summary: `${tool} summary`,
      key_frame_path: "frames/mock.jpg",
      tags: [],
      quality_flags: [],
      evidence_refs: [{ field: "summary", value: `${tool} evidence` }],
    }],
    warnings: [],
  };
}

function createFootageCalls(overrides: Partial<MockFootageCalls> = {}): MockFootageCalls {
  return {
    status: [],
    build: [],
    search: [],
    similar: [],
    unused: [],
    best: [],
    statusValue: "ready",
    ...overrides,
  };
}

async function importWithMockedMarlinTools(calls: MockCalls, footageCalls = createFootageCalls()) {
  vi.resetModules();
  vi.doMock("../runtime/tools/marlin-tools.js", () => ({
    ensureMarlinWorker: async (dir: string) => {
      calls.ensure.push(dir);
      return {};
    },
    marlinAnalyzeRange: async (sourcePath: string, startSec: number, endSec: number) => {
      calls.analyze.push([sourcePath, startSec, endSec]);
      return { scene: "mock scene", events: [] };
    },
    marlinFindMoment: async (sourcePath: string, query: string) => {
      calls.find.push([sourcePath, query]);
      return { span: [1, 2], confidence: 0.9, description: "mock find" };
    },
    marlinExtractFrame: async (sourcePath: string, timestampSec: number, outputPath: string) => {
      calls.extract.push([sourcePath, timestampSec, outputPath]);
      return outputPath;
    },
  }));
  vi.doMock("../runtime/artifacts/footage-db.js", () => ({
    readFootageDbStatus: (dir: string) => {
      footageCalls.status.push(dir);
      return {
        exists: footageCalls.statusValue !== "missing",
        status: footageCalls.statusValue ?? "ready",
        stale_reasons: [],
        errors: [],
      };
    },
  }));
  vi.doMock("../runtime/artifacts/footage-db-builder.js", () => ({
    buildFootageDb: async (options: Record<string, unknown>) => {
      footageCalls.build.push(options);
      if (footageCalls.buildError) throw footageCalls.buildError;
      return { embedding_status: "skipped", counts: { embeddings: 0 }, warnings: [] };
    },
  }));
  vi.doMock("../runtime/tools/footage-search.js", () => ({
    searchFootage: async (dir: string, input: Record<string, unknown>) => {
      footageCalls.search.push([dir, input]);
      return mockResponse("search", input);
    },
    similarFootage: async (dir: string, input: Record<string, unknown>) => {
      footageCalls.similar.push([dir, input]);
      return mockResponse("similar", input);
    },
    unusedFootage: async (dir: string, input: Record<string, unknown>) => {
      footageCalls.unused.push([dir, input]);
      return mockResponse("unused", input);
    },
    bestForBeat: async (dir: string, input: Record<string, unknown>) => {
      footageCalls.best.push([dir, input]);
      return mockResponse("best", input);
    },
  }));
  return import("../runtime/tools/editorial-tools.js");
}

afterEach(() => {
  vi.doUnmock("../runtime/tools/marlin-tools.js");
  vi.doUnmock("../runtime/artifacts/footage-db.js");
  vi.doUnmock("../runtime/artifacts/footage-db-builder.js");
  vi.doUnmock("../runtime/tools/footage-search.js");
  vi.resetModules();
  if (projectDir) {
    fs.rmSync(projectDir, { recursive: true, force: true });
    projectDir = null;
  }
});

describe("editorial tool registry", () => {
  it("creates the expected tool set", async () => {
    const calls: MockCalls = { ensure: [], analyze: [], find: [], extract: [] };
    const { projectDir, sourceMap } = createProject();
    const { createEditorialToolkit } = await importWithMockedMarlinTools(calls);

    const toolkit = createEditorialToolkit(projectDir, sourceMap);

    expect(toolkit.map((tool) => tool.name)).toEqual([
      "analyze_clip_range",
      "find_moment",
      "extract_frame",
      "compare_frames",
      "search_footage",
      "visual_search",
      "similar_to",
      "unused_footage",
      "best_for_beat",
    ]);
    expect(toolkit.every((tool) => typeof tool.execute === "function")).toBe(true);
  });

  it("resolves asset_id to source path before calling Marlin find", async () => {
    const calls: MockCalls = { ensure: [], analyze: [], find: [], extract: [] };
    const fixture = createProject();
    const { createEditorialToolkit } = await importWithMockedMarlinTools(calls);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);

    const result = await toolkit.find((tool) => tool.name === "find_moment")?.execute({
      asset_id: "AST_001",
      query: "hand gesture",
    });

    expect(result).toMatchObject({ span: [1, 2], confidence: 0.9 });
    expect(calls.ensure).toEqual([fixture.projectDir]);
    expect(calls.find).toEqual([[fixture.sourcePath, "hand gesture"]]);
  });

  it("extracts two resolved frames for compare_frames", async () => {
    const calls: MockCalls = { ensure: [], analyze: [], find: [], extract: [] };
    const fixture = createProject();
    const { createEditorialToolkit } = await importWithMockedMarlinTools(calls);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);

    const result = await toolkit.find((tool) => tool.name === "compare_frames")?.execute({
      asset_id: "AST_001",
      timestamp_a_sec: 1.25,
      timestamp_b_sec: "2.5",
    });

    expect(result).toMatchObject({
      asset_id: "AST_001",
      frames: [
        { label: "a", timestamp_sec: 1.25 },
        { label: "b", timestamp_sec: 2.5 },
      ],
    });
    expect(calls.extract).toHaveLength(2);
    expect(calls.extract[0][0]).toBe(fixture.sourcePath);
    expect(calls.extract[0][2]).toContain(path.join("03_analysis", "editorial_tool_frames"));
    expect(calls.extract[1][0]).toBe(fixture.sourcePath);
  });

  it("throws clearly for unknown asset ids", async () => {
    const calls: MockCalls = { ensure: [], analyze: [], find: [], extract: [] };
    const fixture = createProject();
    const { createEditorialToolkit } = await importWithMockedMarlinTools(calls);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);

    await expect(toolkit[0].execute({
      asset_id: "AST_MISSING",
      start_sec: 0,
      end_sec: 1,
    })).rejects.toThrow("Unknown asset_id");
  });

  it("executes footage search tools with expected parameters", async () => {
    const calls: MockCalls = { ensure: [], analyze: [], find: [], extract: [] };
    const footage = createFootageCalls();
    const fixture = createProject();
    const { createEditorialToolkit } = await importWithMockedMarlinTools(calls, footage);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);

    await toolkit.find((tool) => tool.name === "search_footage")?.execute({
      query: "warm food",
      mode: "text",
      filters: { place_hint_category: "market" },
      limit: 4,
    });
    await toolkit.find((tool) => tool.name === "similar_to")?.execute({
      segment_id: "SEG_food",
      use_visual: false,
      limit: 3,
    });
    await toolkit.find((tool) => tool.name === "unused_footage")?.execute({
      exclude_segment_ids: ["SEG_food"],
      min_quality: 0.7,
      limit: 2,
    });
    await toolkit.find((tool) => tool.name === "best_for_beat")?.execute({
      beat_purpose: "show warm preparation",
      emotion: "calm",
      exclude_segment_ids: ["SEG_food"],
      limit: 1,
    });

    expect(footage.search).toEqual([[
      fixture.projectDir,
      {
        query: "warm food",
        mode: "text",
        filters: { place_hint_category: "market" },
        limit: 4,
      },
    ]]);
    expect(footage.similar).toEqual([[fixture.projectDir, { segment_id: "SEG_food", limit: 3 }]]);
    expect(footage.unused).toEqual([[
      fixture.projectDir,
      { selected_segment_ids: ["SEG_food"], min_quality: 0.7, limit: 2 },
    ]]);
    expect(footage.best).toEqual([[
      fixture.projectDir,
      {
        beat_purpose: "show warm preparation",
        required_visuals: ["calm"],
        avoid_segment_ids: ["SEG_food"],
        limit: 1,
      },
    ]]);
    expect(footage.build).toHaveLength(0);
  });

  it("attempts a DB build for missing footage DB and still returns fallback search results", async () => {
    const calls: MockCalls = { ensure: [], analyze: [], find: [], extract: [] };
    const footage = createFootageCalls({
      statusValue: "missing",
      buildError: new Error("missing source artifacts"),
    });
    const fixture = createProject();
    const { createEditorialToolkit } = await importWithMockedMarlinTools(calls, footage);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);

    const result = await toolkit.find((tool) => tool.name === "search_footage")?.execute({
      query: "warm food",
      limit: 4,
    }) as { warnings: string[]; results: Array<{ key_frame_path?: string }> };

    expect(footage.build).toHaveLength(1);
    expect(footage.build[0]).toMatchObject({ projectDir: fixture.projectDir, embeddingPolicy: "auto" });
    expect(footage.search).toHaveLength(1);
    expect(result.warnings[0]).toContain("build failed");
    expect(result.results[0].key_frame_path).toBe("frames/mock.jpg");
  });
});
