import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaSourceMapEntry } from "../runtime/media/source-map.js";

type SearchInput = Record<string, unknown>;

interface MockFootageCalls {
  search: Array<[string, SearchInput]>;
  similar: Array<[string, SearchInput]>;
  searchImpl?: (dir: string, input: SearchInput) => Promise<MockSearchResponse> | MockSearchResponse;
  similarImpl?: (dir: string, input: SearchInput) => Promise<MockSearchResponse> | MockSearchResponse;
}

interface MockSearchResponse {
  query: SearchInput;
  db_status: "ready";
  mode_used: string;
  results: Array<Record<string, unknown>>;
  warnings: string[];
}

interface ToolResponse {
  results: Array<{
    score_breakdown?: {
      e5_text?: number;
      qwen_visual?: number;
      lexical?: number;
      final: number;
    };
    matched_frame_path?: string;
    matched_embedding_type?: string;
    unavailable_channels?: string[];
  }>;
  warnings: string[];
}

let projectDir: string | null = null;

function createProject(): { projectDir: string; imagePath: string; sourceMap: Map<string, MediaSourceMapEntry> } {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-tools-visual-"));
  const imagePath = path.join(projectDir, "query-frame.jpg");
  fs.writeFileSync(imagePath, "mock image");
  return {
    projectDir,
    imagePath,
    sourceMap: new Map<string, MediaSourceMapEntry>(),
  };
}

function createFootageCalls(overrides: Partial<MockFootageCalls> = {}): MockFootageCalls {
  return {
    search: [],
    similar: [],
    ...overrides,
  };
}

function mockResponse(tool: string, input: SearchInput): MockSearchResponse {
  const hasVisualEvidence = input.mode === "visual" || input.mode === "multimodal" || Boolean(input.visual_anchor);
  return {
    query: { query: tool, ...input },
    db_status: "ready",
    mode_used: typeof input.mode === "string" ? input.mode : "hybrid",
    results: [{
      segment_id: `SEG_${tool}`,
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 1_000_000,
      duration_us: 1_000_000,
      score: 0.91,
      scores: {
        e5_text: input.query ? 0.42 : undefined,
        lexical: input.query ? 0.31 : undefined,
        qwen_visual: hasVisualEvidence ? 0.93 : undefined,
        final: 0.91,
        embedding_matches: hasVisualEvidence ? [{
          segment_embedding_id: 7,
          embedding_type: "visual_representative",
          model_id: 1,
          score: 0.93,
          source_ref: "03_analysis/frames/SEG_search/representative.jpg",
          source_timestamp_us: 2_000_000,
        }] : undefined,
        unavailable_channels: hasVisualEvidence ? ["e5_text"] : undefined,
      },
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

function emptyVisualWarning(input: SearchInput, warning: string): MockSearchResponse {
  return {
    query: input,
    db_status: "ready",
    mode_used: typeof input.mode === "string" ? input.mode : "visual",
    results: [],
    warnings: [warning],
  };
}

async function importWithMockedFootageSearch(calls: MockFootageCalls) {
  vi.resetModules();
  vi.doMock("../runtime/tools/marlin-tools.js", () => ({
    ensureMarlinWorker: async () => ({}),
    marlinAnalyzeRange: async () => ({}),
    marlinFindMoment: async () => ({}),
    marlinExtractFrame: async (_sourcePath: string, _timestampSec: number, outputPath: string) => outputPath,
  }));
  vi.doMock("../runtime/artifacts/footage-db.js", () => ({
    readFootageDbStatus: () => ({
      exists: true,
      status: "ready",
      stale_reasons: [],
      errors: [],
    }),
  }));
  vi.doMock("../runtime/artifacts/footage-db-builder.js", () => ({
    buildFootageDb: async () => ({ embedding_status: "skipped", counts: { embeddings: 0 }, warnings: [] }),
  }));
  vi.doMock("../runtime/tools/footage-search.js", () => ({
    searchFootage: async (dir: string, input: SearchInput) => {
      calls.search.push([dir, input]);
      return calls.searchImpl ? calls.searchImpl(dir, input) : mockResponse("search", input);
    },
    similarFootage: async (dir: string, input: SearchInput) => {
      calls.similar.push([dir, input]);
      return calls.similarImpl ? calls.similarImpl(dir, input) : mockResponse("similar", input);
    },
    unusedFootage: async (_dir: string, input: SearchInput) => mockResponse("unused", input),
    bestForBeat: async (_dir: string, input: SearchInput) => mockResponse("best", input),
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

describe("editorial visual search tools", () => {
  it("delegates search_footage visual image queries to footage search", async () => {
    const fixture = createProject();
    const calls = createFootageCalls();
    const { createEditorialToolkit } = await importWithMockedFootageSearch(calls);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);

    await toolkit.find((tool) => tool.name === "search_footage")?.execute({
      query: "",
      mode: "visual",
      image_query_path: fixture.imagePath,
      filters_json: JSON.stringify({ exclude_segment_ids: ["SEG_used"] }),
      visual_goal: "palette",
      limit: 4,
    });

    expect(calls.search).toEqual([[
      fixture.projectDir,
      {
        query: "",
        mode: "visual",
        filters: { exclude_segment_ids: ["SEG_used"] },
        limit: 4,
        image_query_path: fixture.imagePath,
        visual_anchor: undefined,
        visual_goal: "palette",
      },
    ]]);
  });

  it("maps flat visual_anchor params into a footage search anchor", async () => {
    const fixture = createProject();
    const calls = createFootageCalls();
    const { createEditorialToolkit } = await importWithMockedFootageSearch(calls);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);

    await toolkit.find((tool) => tool.name === "search_footage")?.execute({
      query: "",
      mode: "visual",
      visual_anchor_segment_id: "SEG_ref",
      visual_anchor_frame_type: "visual_keyframe_peak",
      limit: 3,
    });

    expect(calls.search[0][1]).toMatchObject({
      query: "",
      mode: "visual",
      visual_anchor: {
        segment_id: "SEG_ref",
        frame_type: "visual_keyframe_peak",
      },
      limit: 3,
    });
  });

  it("visual_search delegates image search and exposes visual evidence aliases", async () => {
    const fixture = createProject();
    const calls = createFootageCalls();
    const { createEditorialToolkit } = await importWithMockedFootageSearch(calls);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);

    const result = await toolkit.find((tool) => tool.name === "visual_search")?.execute({
      query_frame_path: fixture.imagePath,
      exclude_segment_ids: "SEG_a, SEG_b",
      limit: 5,
    }) as ToolResponse;

    expect(calls.search[0][1]).toMatchObject({
      query: "",
      mode: "visual",
      image_query_path: fixture.imagePath,
      filters: { exclude_segment_ids: ["SEG_a", "SEG_b"] },
      limit: 5,
    });
    expect(result.results[0].score_breakdown).toMatchObject({
      qwen_visual: 0.93,
      final: 0.91,
    });
    expect(result.results[0].matched_frame_path).toBe("03_analysis/frames/SEG_search/representative.jpg");
    expect(result.results[0].matched_embedding_type).toBe("visual_representative");
    expect(result.results[0].unavailable_channels).toEqual(["e5_text"]);
  });

  it("visual_search switches to multimodal mode when a text hint is provided", async () => {
    const fixture = createProject();
    const calls = createFootageCalls();
    const { createEditorialToolkit } = await importWithMockedFootageSearch(calls);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);

    await toolkit.find((tool) => tool.name === "visual_search")?.execute({
      query_frame_path: fixture.imagePath,
      text_hint: "warm food preparation",
      limit: 6,
    });

    expect(calls.search[0][1]).toMatchObject({
      query: "warm food preparation",
      semantic: "warm food preparation",
      mode: "multimodal",
      image_query_path: fixture.imagePath,
      limit: 6,
    });
  });

  it("similar_to uses visual_anchor search by default", async () => {
    const fixture = createProject();
    const calls = createFootageCalls();
    const { createEditorialToolkit } = await importWithMockedFootageSearch(calls);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);

    await toolkit.find((tool) => tool.name === "similar_to")?.execute({
      segment_id: "SEG_ref",
      limit: 4,
    });

    expect(calls.search[0][1]).toMatchObject({
      query: "",
      mode: "visual",
      visual_anchor: {
        segment_id: "SEG_ref",
        frame_type: "visual_representative",
      },
      visual_goal: "similarity",
      filters: { exclude_segment_ids: ["SEG_ref"] },
      limit: 4,
    });
    expect(calls.similar).toEqual([]);
  });

  it("similar_to falls back to text similarity when visual search is unavailable", async () => {
    const fixture = createProject();
    const calls = createFootageCalls({
      searchImpl: (_dir, input) => emptyVisualWarning(input, "visual search unavailable; no text fallback was usable"),
    });
    const { createEditorialToolkit } = await importWithMockedFootageSearch(calls);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);

    const result = await toolkit.find((tool) => tool.name === "similar_to")?.execute({
      segment_id: "SEG_ref",
      limit: 4,
    }) as ToolResponse;

    expect(calls.search).toHaveLength(1);
    expect(calls.similar).toEqual([[fixture.projectDir, { segment_id: "SEG_ref", limit: 4 }]]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      "visual similarity unavailable; fell back to text-based similar_to",
      "visual search unavailable; no text fallback was usable",
    ]));
  });

  it("returns graceful warnings for empty or missing visual_search image paths", async () => {
    const fixture = createProject();
    const missingPath = path.join(fixture.projectDir, "missing.jpg");
    const calls = createFootageCalls({
      searchImpl: (_dir, input) => {
        const imagePath = input.image_query_path;
        if (typeof imagePath !== "string" || imagePath.length === 0) {
          return emptyVisualWarning(input, "visual mode requires image_query_path or visual_anchor");
        }
        if (!fs.existsSync(imagePath)) {
          return emptyVisualWarning(input, `image_query_path does not exist: ${imagePath}`);
        }
        return mockResponse("search", input);
      },
    });
    const { createEditorialToolkit } = await importWithMockedFootageSearch(calls);
    const toolkit = createEditorialToolkit(fixture.projectDir, fixture.sourceMap);
    const visualSearch = toolkit.find((tool) => tool.name === "visual_search");

    const emptyResult = await visualSearch?.execute({ query_frame_path: "" }) as ToolResponse;
    const missingResult = await visualSearch?.execute({ query_frame_path: missingPath }) as ToolResponse;

    expect(emptyResult.results).toEqual([]);
    expect(emptyResult.warnings).toContain("visual mode requires image_query_path or visual_anchor");
    expect(missingResult.results).toEqual([]);
    expect(missingResult.warnings).toContain(`image_query_path does not exist: ${missingPath}`);
  });
});

describe("rough-pass visual search prompt exposure", () => {
  it("advertises visual search tools in interactive rough-pass prompts", async () => {
    const fixture = createProject();
    const { roughCutPlanning } = await import("../runtime/agents/unified-editorial-agent.js");

    const task = await roughCutPlanning(
      {
        version: "1",
        project_id: "rough-visual-tools",
        project: {
          id: "rough-visual-tools",
          title: "Rough Visual Tools",
          strategy: "message-first",
          runtime_target_sec: 12,
          duration_mode: "guide",
        },
        message: { primary: "Find warm visual tone." },
        emotion_curve: ["hook", "payoff"],
        must_have: ["warm light"],
        order_policy: "editorial",
        caption_policy: "auto",
        audio_policy: "bgm_only",
      },
      {
        project_id: "rough-visual-tools",
        artifact_version: "marlin-events-v1",
        model: { provider: "marlin", model_alias: "test", model_snapshot: "test" },
        items: [{
          asset_id: "AST_001",
          source_path: "02_media/a.mov",
          scene: "warm light on hands",
          caption: "Warm preparation scene",
          events: [{
            event_id: "MEV_001",
            start_us: 0,
            end_us: 2_000_000,
            description: "Hands move through warm light.",
            confidence: 0.9,
            source_pass: "marlin_caption",
          }],
          find_results: [],
        }],
      },
      new Map([["AST_001", "03_analysis/representative_frames/AST_001.jpg"]]),
      [{
        segment_id: "SEG_001",
        asset_id: "AST_001",
        src_in_us: 0,
        src_out_us: 3_000_000,
        duration_us: 3_000_000,
        rep_frame_us: 1_500_000,
        segment_type: "shot",
        summary: "Warm preparation detail.",
        transcript_excerpt: "",
        transcript_ref: null,
        tags: ["warm", "hands"],
        quality_flags: [],
        confidence: {
          boundary: { score: 0.9, source: "test", status: "ok" },
        },
        provenance: {
          boundary: {
            stage: "test",
            method: "manual",
            connector_version: "test",
            policy_hash: "test",
            request_hash: "test",
          },
        },
      }],
      12,
      { mode: "interactive", projectDir: fixture.projectDir },
    );

    expect(task.pass).toBe("rough");
    expect(task.prompt).toContain("## Available tools");
    expect(task.prompt).toContain("visual_search(query_frame_path, text_hint, exclude_segment_ids, limit)");
    expect(task.prompt).toContain("mood, lighting, texture, or visual tone");
    expect(task.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "search_footage",
      "similar_to",
      "best_for_beat",
      "visual_search",
    ]));
  });
});
