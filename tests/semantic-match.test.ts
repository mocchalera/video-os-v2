import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candidate, CreativeBrief, SelectsCandidates } from "../runtime/artifacts/types.js";
import type { SelectionCoverageSegment } from "../runtime/eval/selection-coverage.js";

function mockTransformers(vectorsByText: Record<string, number[]>): { calls: string[][] } {
  const calls: string[][] = [];
  vi.doMock("@huggingface/transformers", () => ({
    env: {
      cacheDir: null,
      allowLocalModels: true,
      allowRemoteModels: true,
    },
    pipeline: vi.fn(async () => async (texts: string | string[]) => {
      const rows = Array.isArray(texts) ? texts : [texts];
      calls.push(rows);
      const vectors = rows.map((text) => vectorsByText[text] ?? [0, 0, 1]);
      return {
        data: new Float32Array(vectors.flat()),
        dims: [vectors.length, vectors[0]?.length ?? 0],
      };
    }),
  }));
  return { calls };
}

function mockUnavailableTransformers(message = "model cache missing"): void {
  vi.doMock("@huggingface/transformers", () => ({
    env: {
      cacheDir: null,
      allowLocalModels: true,
      allowRemoteModels: true,
    },
    pipeline: vi.fn(async () => {
      throw new Error(message);
    }),
  }));
}

function brief(mustHave: string[]): CreativeBrief {
  return {
    version: "1",
    project_id: "semantic-fixture",
    project: {
      id: "semantic-fixture",
      title: "fixture",
      strategy: "test",
      runtime_target_sec: 30,
    },
    message: { primary: "camping memory" },
    emotion_curve: [],
    must_have: mustHave,
  } as CreativeBrief;
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    segment_id: "SEG_001",
    asset_id: "A",
    src_in_us: 0,
    src_out_us: 10_000_000,
    role: "hero",
    why_it_matches: "campfire scene with people around the fire",
    risks: [],
    confidence: 0.9,
    evidence: ["starry sky above the campsite"],
    ...overrides,
  };
}

function selects(candidates: Candidate[]): SelectsCandidates {
  return { version: "1", project_id: "semantic-fixture", candidates };
}

function segments(): SelectionCoverageSegment[] {
  return [{ segment_id: "SEG_001", summary: "night campsite with quiet outdoor atmosphere" }];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@huggingface/transformers");
});

describe("semantic match utilities", () => {
  it("computes cosine similarity for normalized vectors", async () => {
    const { cosineSimilarity } = await import("../runtime/eval/semantic-match.js");

    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0.6, 0.8]))).toBeCloseTo(0.6);
  });

  it("matches Japanese must_have items to English evidence with mocked multilingual vectors", async () => {
    const { calls } = mockTransformers({
      "query: 焚き火のシーン": [1, 0, 0],
      "query: 星空": [0, 1, 0],
      "passage: campfire scene with people around the fire": [0.95, 0.1, 0],
      "passage: starry sky above the campsite": [0.1, 0.95, 0],
      "passage: indoor cooking close-up": [0, 0, 1],
    });
    const { semanticMustHaveMatch } = await import("../runtime/eval/semantic-match.js");

    const result = await semanticMustHaveMatch(
      ["焚き火のシーン", "星空"],
      [
        "campfire scene with people around the fire",
        "starry sky above the campsite",
        "indoor cooking close-up",
      ],
    );

    expect(result).toEqual([
      expect.objectContaining({
        item: "焚き火のシーン",
        matched: true,
        bestMatch: expect.objectContaining({ text: "campfire scene with people around the fire" }),
      }),
      expect.objectContaining({
        item: "星空",
        matched: true,
        bestMatch: expect.objectContaining({ text: "starry sky above the campsite" }),
      }),
    ]);
    expect(calls[0]).toEqual(["query: 焚き火のシーン", "query: 星空"]);
    expect(calls[1]).toContain("passage: campfire scene with people around the fire");
  });

  it("applies the semantic threshold to the best match", async () => {
    mockTransformers({
      "query: 星空": [1, 0],
      "passage: starry sky above the campsite": [0.9, 0.1],
    });
    const { semanticMustHaveMatch } = await import("../runtime/eval/semantic-match.js");

    const matched = await semanticMustHaveMatch(["星空"], ["starry sky above the campsite"], 0.82);
    const strict = await semanticMustHaveMatch(["星空"], ["starry sky above the campsite"], 0.999);

    expect(matched[0].matched).toBe(true);
    expect(strict[0].matched).toBe(false);
    expect(strict[0].bestMatch?.score).toBeLessThan(0.999);
  });

  it("returns unmatched results when the local model is unavailable", async () => {
    mockUnavailableTransformers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { semanticMustHaveMatch } = await import("../runtime/eval/semantic-match.js");

    const result = await semanticMustHaveMatch(["星空"], ["starry sky above the campsite"]);

    expect(result).toEqual([{ item: "星空", bestMatch: null, matched: false }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("semantic must_have matching skipped"));
  });

  it("keeps the sync text matcher functional when semantic matching is skipped", async () => {
    mockUnavailableTransformers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const {
      analyzeSelectionCoverage,
      analyzeSelectionCoverageWithSemantic,
    } = await import("../runtime/eval/selection-coverage.js");

    const syncReport = analyzeSelectionCoverage(
      selects([candidate()]),
      brief(["焚き火のシーン", "星空"]),
      segments(),
    );
    const semanticReport = await analyzeSelectionCoverageWithSemantic(
      selects([candidate()]),
      brief(["焚き火のシーン", "星空"]),
      segments(),
    );

    expect(syncReport.must_have_coverage.map((item) => item.matched)).toEqual([false, false]);
    expect(semanticReport.must_have_coverage).toEqual(syncReport.must_have_coverage);
    expect(semanticReport.gaps).toEqual(syncReport.gaps);
  });
});
