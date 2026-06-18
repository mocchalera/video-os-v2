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

async function importWithMockedMarlinTools(calls: MockCalls) {
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
  return import("../runtime/tools/editorial-tools.js");
}

afterEach(() => {
  vi.doUnmock("../runtime/tools/marlin-tools.js");
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
});
