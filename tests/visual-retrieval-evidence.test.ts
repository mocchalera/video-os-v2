import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreativeBrief } from "../runtime/artifacts/types.js";
import type { SearchFootageInput } from "../runtime/tools/footage-search.js";
import type {
  AudioRetrievalEvidence,
  AudioRetrievalResult,
  VisualRetrievalEvidence,
  VisualRetrievalResult,
} from "../runtime/agents/visual-retrieval-evidence.js";

type SearchImpl = (projectDir: string, input: SearchFootageInput) => Promise<Record<string, unknown>>;

function brief(overrides: Record<string, unknown> = {}): CreativeBrief {
  return {
    version: "1",
    project_id: "visual-test",
    project: {
      id: "visual-test",
      title: "Visual Test",
      strategy: "message-first",
      runtime_target_sec: 24,
      duration_mode: "guide",
    },
    message: { primary: "Find warm visual evidence." },
    emotion_curve: ["hook", "build", "resolve"],
    must_have: [],
    must_avoid: ["blur"],
    autonomy: { may_decide: ["pacing"], must_ask: [] },
    resolved_assumptions: ["Footage is available."],
    ...overrides,
  } as CreativeBrief;
}

function query(query_id = "must_have_01", text = "warm natural light") {
  return {
    query_id,
    source: "brief.must_have" as const,
    query: text,
  };
}

function audioQuery(query_id = "must_have_01", text = "quiet room tone") {
  return {
    query_id,
    source: "brief.must_have" as const,
    query: text,
    channel: "audio" as const,
  };
}

function searchInput(text = "warm natural light", limit = 8) {
  return {
    query: text,
    semantic: text,
    mode: "hybrid" as const,
    limit,
  };
}

function audioSearchInput(text = "quiet room tone", limit = 8) {
  return {
    query: text,
    semantic: text,
    mode: "hybrid" as const,
    limit,
  };
}

function footageResult(
  segmentId: string,
  final: number,
  qwenVisual: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 3_000_000,
    duration_us: 3_000_000,
    score: final,
    scores: {
      qwen_visual: qwenVisual,
      qwen_text: qwenVisual - 0.01,
      e5_text: final - 0.02,
      lexical: 0.4,
      final,
      embedding_matches: [
        {
          embedding_type: "visual_representative",
          model_id: 1,
          score: qwenVisual,
          source_ref: `03_analysis/frames/${segmentId}/representative.jpg`,
        },
      ],
    },
    match_reason: "Qwen visual match",
    summary: `Summary for ${segmentId}`,
    key_frame_path: `03_analysis/frames/${segmentId}/representative.jpg`,
    tags: ["warm"],
    quality_flags: [],
    evidence_refs: [],
    ...overrides,
  };
}

function audioFootageResult(
  segmentId: string,
  final: number,
  audioSimilarity: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 3_000_000,
    duration_us: 3_000_000,
    score: final,
    scores: {
      audio_similarity: audioSimilarity,
      clap_audio: audioSimilarity,
      qwen_text: final - 0.03,
      e5_text: final - 0.02,
      lexical: 0.3,
      final,
      embedding_matches: [
        {
          embedding_type: "audio_representative",
          model_id: 2,
          score: audioSimilarity,
          source_ref: `03_analysis/audio/${segmentId}/representative.wav`,
        },
      ],
    },
    match_reason: "CLAP audio match",
    summary: `Audio summary for ${segmentId}`,
    tags: ["quiet"],
    quality_flags: [],
    evidence_refs: [],
    ...overrides,
  };
}

function visualResult(overrides: Partial<VisualRetrievalResult> = {}): VisualRetrievalResult {
  return {
    segment_id: "SEG_001",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 3_000_000,
    summary: "Warm light across hands and food texture.",
    score: 0.867,
    score_breakdown: {
      qwen_visual: 0.852,
      qwen_text: 0.831,
      e5_text: 0.82,
      lexical: 0.5,
      final: 0.867,
    },
    matched_frame_path: "03_analysis/frames/SEG_001/representative.jpg",
    matched_embedding_type: "visual_representative",
    tags: ["warm"],
    ...overrides,
  };
}

function audioResult(overrides: Partial<AudioRetrievalResult> = {}): AudioRetrievalResult {
  return {
    segment_id: "SEG_001",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 3_000_000,
    summary: "Quiet room tone with soft natural ambience.",
    score: 0.83,
    score_breakdown: {
      audio_similarity: 0.812,
      qwen_text: 0.79,
      e5_text: 0.78,
      lexical: 0.3,
      final: 0.83,
    },
    matched_audio_ref: "03_analysis/audio/SEG_001/representative.wav",
    matched_embedding_type: "audio_representative",
    tags: ["quiet"],
    ...overrides,
  };
}

function evidenceEntry(overrides: Partial<VisualRetrievalEvidence> = {}): VisualRetrievalEvidence {
  return {
    query_id: "must_have_01",
    source: "brief.must_have",
    query: "warm natural light",
    search_input: searchInput("warm natural light", 8),
    mode: "hybrid",
    results: [visualResult()],
    warnings: [],
    ...overrides,
  };
}

function audioEvidenceEntry(overrides: Partial<AudioRetrievalEvidence> = {}): AudioRetrievalEvidence {
  return {
    query_id: "must_have_01",
    source: "brief.must_have",
    query: "quiet room tone",
    channel: "audio",
    search_input: audioSearchInput("quiet room tone", 8),
    mode: "hybrid",
    results: [audioResult()],
    warnings: [],
    ...overrides,
  };
}

function parsePromptJsonBlock(text: string): Record<string, unknown> {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  expect(match?.[1]).toBeTruthy();
  return JSON.parse(match?.[1] ?? "{}") as Record<string, unknown>;
}

async function importWithMockedSearch(searchImpl?: SearchImpl) {
  vi.resetModules();
  vi.doMock("../runtime/tools/footage-search.js", () => ({
    searchFootage: searchImpl ?? (async (_projectDir: string, input: SearchFootageInput) => ({
      query: input,
      db_status: "ready",
      mode_used: input.mode ?? "hybrid",
      results: [],
      warnings: [],
    })),
  }));
  return import("../runtime/agents/visual-retrieval-evidence.js");
}

afterEach(() => {
  vi.doUnmock("../runtime/tools/footage-search.js");
  vi.resetModules();
});

describe("visual retrieval evidence", () => {
  it("extracts queries from must_have items with the Qwen3-VL visual search priority prefix", async () => {
    const { extractVisualQueries } = await importWithMockedSearch();

    expect(extractVisualQueries(brief({
      must_have: [
        "hands preparing",
        "Qwen3-VL visual search priority: 温かみのある光のシーン",
      ],
    }))).toEqual([
      {
        query_id: "must_have_02",
        source: "brief.must_have",
        query: "温かみのある光のシーン",
      },
    ]);
  });

  it("ignores must_have items without the prefix", async () => {
    const { extractVisualQueries } = await importWithMockedSearch();

    expect(extractVisualQueries(brief({
      must_have: ["hands preparing", "person smiling"],
    }))).toEqual([]);
  });

  it("handles empty must_have gracefully", async () => {
    const { extractVisualQueries } = await importWithMockedSearch();

    expect(extractVisualQueries(brief({ must_have: [] }))).toEqual([]);
  });

  it("extracts visual priorities from brief.editorial.policy_hint", async () => {
    const { extractVisualQueries } = await importWithMockedSearch();

    expect(extractVisualQueries(brief({
      editorial: {
        policy_hint: [
          "Prefer quiet pacing.",
          "Qwen3-VL visual search priority: 湯気と自然光の質感",
        ].join("\n"),
      },
    }))).toEqual([
      {
        query_id: "policy_hint_02",
        source: "brief.editorial.policy_hint",
        query: "湯気と自然光の質感",
      },
    ]);
  });

  it("extracts audio queries from audio-related must_have items", async () => {
    const { extractAudioQueries } = await importWithMockedSearch();

    expect(extractAudioQueries(brief({
      must_have: [
        "動画の声・環境音のミックス",
        "Qwen3-VL visual search priority: 静かな朝の空気感",
        "hands preparing food",
      ],
    }))).toEqual([
      {
        query_id: "must_have_01",
        source: "brief.must_have",
        query: "動画の声・環境音のミックス",
        channel: "audio",
      },
      {
        query_id: "must_have_02",
        source: "brief.must_have",
        query: "静かな朝の空気感",
        channel: "audio",
      },
    ]);
  });

  it("extracts audio priorities from brief.editorial.policy_hint", async () => {
    const { extractAudioQueries } = await importWithMockedSearch();

    expect(extractAudioQueries(brief({
      editorial: {
        policy_hint: [
          "Prefer quiet pacing.",
          "Audio retrieval priority: quiet kitchen ambience",
        ].join("\n"),
      },
    }))).toEqual([
      {
        query_id: "policy_hint_01",
        source: "brief.editorial.policy_hint",
        query: "Prefer quiet pacing.",
        channel: "audio",
      },
      {
        query_id: "policy_hint_02",
        source: "brief.editorial.policy_hint",
        query: "quiet kitchen ambience",
        channel: "audio",
      },
    ]);
  });

  it("calls searchFootage with mode='hybrid'", async () => {
    const searchFootage = vi.fn(async (_projectDir: string, input: SearchFootageInput) => ({
      query: input,
      db_status: "ready",
      mode_used: input.mode ?? "hybrid",
      results: [footageResult("SEG_001", 0.86, 0.84)],
      warnings: [],
    }));
    const { runVisualRetrieval } = await importWithMockedSearch(searchFootage);

    await runVisualRetrieval("/tmp/project", [query()], { limitPerQuery: 3 });

    expect(searchFootage).toHaveBeenCalledWith("/tmp/project", {
      query: "warm natural light",
      semantic: "warm natural light",
      mode: "hybrid",
      limit: 3,
    });
  });

  it("calls searchFootage with mode='hybrid' for audio retrieval", async () => {
    const searchFootage = vi.fn(async (_projectDir: string, input: SearchFootageInput) => ({
      query: input,
      db_status: "ready",
      mode_used: input.mode ?? "hybrid",
      results: [audioFootageResult("SEG_001", 0.83, 0.81)],
      warnings: [],
    }));
    const { runAudioRetrieval } = await importWithMockedSearch(searchFootage);

    await runAudioRetrieval("/tmp/project", [audioQuery()], { limitPerQuery: 5 });

    expect(searchFootage).toHaveBeenCalledWith("/tmp/project", {
      query: "quiet room tone",
      semantic: "quiet room tone",
      mode: "hybrid",
      limit: 5,
    });
  });

  it("filters and ranks audio retrieval by audio_similarity", async () => {
    const searchFootage = vi.fn(async () => ({
      query: audioSearchInput(),
      db_status: "ready",
      mode_used: "hybrid",
      results: [
        audioFootageResult("SEG_LOW_FINAL_HIGH_AUDIO", 0.7, 0.91),
        audioFootageResult("SEG_HIGH_FINAL_LOW_AUDIO", 0.95, 0.52),
        footageResult("SEG_NO_AUDIO", 0.99, 0.94),
      ],
      warnings: [],
    }));
    const { runAudioRetrieval } = await importWithMockedSearch(searchFootage);

    const evidence = await runAudioRetrieval("/tmp/project", [audioQuery()]);

    expect(evidence[0].results.map((result) => result.segment_id)).toEqual([
      "SEG_LOW_FINAL_HIGH_AUDIO",
      "SEG_HIGH_FINAL_LOW_AUDIO",
    ]);
    expect(evidence[0].results[0].score_breakdown.audio_similarity).toBe(0.91);
  });

  it("deduplicates by segment_id and keeps the best score", async () => {
    const searchFootage = vi.fn(async (_projectDir: string, input: SearchFootageInput) => ({
      query: input,
      db_status: "ready",
      mode_used: "hybrid",
      results: input.query === "query one"
        ? [
          footageResult("SEG_DUP", 0.5, 0.49),
          footageResult("SEG_A", 0.6, 0.58),
        ]
        : [
          footageResult("SEG_DUP", 0.9, 0.88),
        ],
      warnings: [],
    }));
    const { runVisualRetrieval } = await importWithMockedSearch(searchFootage);

    const evidence = await runVisualRetrieval("/tmp/project", [
      query("must_have_01", "query one"),
      query("must_have_02", "query two"),
    ]);
    const results = evidence.flatMap((entry) => entry.results);

    expect(results.filter((result) => result.segment_id === "SEG_DUP")).toHaveLength(1);
    expect(results.find((result) => result.segment_id === "SEG_DUP")?.score_breakdown.final).toBe(0.9);
    expect(results.map((result) => result.segment_id)).toContain("SEG_A");
  });

  it("limits total injected segments to the configured cap", async () => {
    const searchFootage = vi.fn(async (_projectDir: string, input: SearchFootageInput) => ({
      query: input,
      db_status: "ready",
      mode_used: "hybrid",
      results: [
        footageResult("SEG_001", 0.91, 0.89),
        footageResult("SEG_002", 0.81, 0.79),
        footageResult("SEG_003", 0.71, 0.69),
      ],
      warnings: [],
    }));
    const { runVisualRetrieval } = await importWithMockedSearch(searchFootage);

    const evidence = await runVisualRetrieval("/tmp/project", [query()], { maxTotalResults: 2 });

    expect(evidence.flatMap((entry) => entry.results).map((result) => result.segment_id)).toEqual([
      "SEG_001",
      "SEG_002",
    ]);
  });

  it("returns empty results with a warning when search fails", async () => {
    const searchFootage = vi.fn(async () => {
      throw new Error("db unavailable");
    });
    const { runVisualRetrieval } = await importWithMockedSearch(searchFootage);

    const evidence = await runVisualRetrieval("/tmp/project", [query()]);

    expect(evidence[0].results).toEqual([]);
    expect(evidence[0].warnings).toEqual([
      "visual retrieval failed for must_have_01: db unavailable",
    ]);
  });

  it("returns empty evidence with warnings for fallback DB search responses", async () => {
    const searchFootage = vi.fn(async (_projectDir: string, input: SearchFootageInput) => ({
      query: input,
      db_status: "fallback",
      mode_used: "hybrid",
      results: [],
      warnings: ["footage search DB missing; using JSON fallback"],
    }));
    const { runVisualRetrieval } = await importWithMockedSearch(searchFootage);

    const evidence = await runVisualRetrieval("/tmp/project", [query()]);

    expect(evidence[0].results).toEqual([]);
    expect(evidence[0].warnings).toEqual([
      "footage search DB missing; using JSON fallback",
      "visual retrieval skipped non-Qwen search response: db_status=fallback",
    ]);
  });

  it("returns empty evidence with warnings for missing DB search responses", async () => {
    const searchFootage = vi.fn(async (_projectDir: string, input: SearchFootageInput) => ({
      query: input,
      db_status: "missing",
      mode_used: "hybrid",
      results: [],
      warnings: ["footage search DB missing"],
    }));
    const { runVisualRetrieval } = await importWithMockedSearch(searchFootage);

    const evidence = await runVisualRetrieval("/tmp/project", [query()]);

    expect(evidence[0].results).toEqual([]);
    expect(evidence[0].warnings).toEqual([
      "footage search DB missing",
      "visual retrieval skipped non-Qwen search response: db_status=missing",
    ]);
  });

  it("filters Qwen-unavailable rows and records a warning", async () => {
    const searchFootage = vi.fn(async (_projectDir: string, input: SearchFootageInput) => ({
      query: input,
      db_status: "ready",
      mode_used: "hybrid",
      results: [
        footageResult("SEG_NO_QWEN", 0.72, 0.7, {
          scores: {
            e5_text: 0.72,
            semantic: 0.72,
            lexical: 0.3,
            final: 0.72,
            embedding_matches: [],
          },
        }),
      ],
      warnings: [],
    }));
    const { runVisualRetrieval } = await importWithMockedSearch(searchFootage);

    const evidence = await runVisualRetrieval("/tmp/project", [query()]);

    expect(evidence[0].results).toEqual([]);
    expect(evidence[0].warnings).toContain("visual retrieval skipped results without qwen_visual scores");
  });

  it("produces JSON prompt evidence with scores and frame paths", async () => {
    const { formatEvidenceForPrompt } = await importWithMockedSearch();

    const text = formatEvidenceForPrompt([evidenceEntry()]);
    const payload = parsePromptJsonBlock(text);
    const entries = payload.visual_retrieval_evidence as Array<Record<string, unknown>>;
    const result = (entries[0].results as Array<Record<string, unknown>>)[0];

    expect(text).toContain("## Visual Retrieval Evidence (Qwen3-VL)");
    expect(text).toContain("Treat this as ranked evidence, not mandatory selection.");
    expect(entries[0].query_id).toBe("must_have_01");
    expect(result).toMatchObject({
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 3_000_000,
      summary: "Warm light across hands and food texture.",
      scores: {
        qwen_visual: 0.852,
        qwen_text: 0.831,
        e5_text: 0.82,
        final: 0.867,
      },
      matched_frame_path: "03_analysis/frames/SEG_001/representative.jpg",
      matched_embedding_type: "visual_representative",
    });
  });

  it("produces JSON audio prompt evidence with audio_similarity", async () => {
    const { formatAudioEvidenceForPrompt } = await importWithMockedSearch();

    const text = formatAudioEvidenceForPrompt([audioEvidenceEntry()]);
    const payload = parsePromptJsonBlock(text);
    const entries = payload.audio_retrieval_evidence as Array<Record<string, unknown>>;
    const result = (entries[0].results as Array<Record<string, unknown>>)[0];

    expect(text).toContain("## Audio Retrieval Evidence (CLAP)");
    expect(text).toContain("audio_similarity score");
    expect(entries[0].query_id).toBe("must_have_01");
    expect(result).toMatchObject({
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 3_000_000,
      summary: "Quiet room tone with soft natural ambience.",
      scores: {
        audio_similarity: 0.812,
        qwen_text: 0.79,
        e5_text: 0.78,
        final: 0.83,
      },
      matched_audio_ref: "03_analysis/audio/SEG_001/representative.wav",
      matched_embedding_type: "audio_representative",
    });
  });

  it("truncates and JSON-escapes query and summary text in prompt evidence", async () => {
    const { formatEvidenceForPrompt } = await importWithMockedSearch();

    const text = formatEvidenceForPrompt([
      evidenceEntry({
        query: `quoted "warm" ${"light ".repeat(60)}`,
        results: [
          visualResult({
            summary: `Line one\nquoted "texture" ${"detail ".repeat(40)}`,
          }),
        ],
      }),
    ]);
    const payload = parsePromptJsonBlock(text);
    const entries = payload.visual_retrieval_evidence as Array<Record<string, unknown>>;
    const result = (entries[0].results as Array<Record<string, unknown>>)[0];

    expect(entries[0].query).toMatch(/^quoted "warm"/);
    expect(String(entries[0].query).length).toBeLessThanOrEqual(200);
    expect(result.summary).toMatch(/^Line one quoted "texture"/);
    expect(String(result.summary).length).toBeLessThanOrEqual(120);
  });

  it("returns an empty string when no evidence is available", async () => {
    const { formatAudioEvidenceForPrompt, formatEvidenceForPrompt } = await importWithMockedSearch();

    expect(formatEvidenceForPrompt([])).toBe("");
    expect(formatEvidenceForPrompt([
      {
        query_id: "must_have_01",
        source: "brief.must_have",
        query: "warm natural light",
        search_input: searchInput(),
        mode: "hybrid",
        results: [],
        warnings: ["no qwen"],
      },
    ])).toBe("");
    expect(formatAudioEvidenceForPrompt([])).toBe("");
    expect(formatAudioEvidenceForPrompt([
      {
        query_id: "must_have_01",
        source: "brief.must_have",
        query: "quiet room tone",
        channel: "audio",
        search_input: audioSearchInput(),
        mode: "hybrid",
        results: [],
        warnings: ["no clap"],
      },
    ])).toBe("");
  });

  it("builds trace shape with search input, result counts, totals, and warnings", async () => {
    const { buildVisualRetrievalTrace } = await importWithMockedSearch();

    const trace = buildVisualRetrievalTrace("visual-test", [evidenceEntry()], "2026-06-19T00:00:00.000Z");

    expect(trace).toMatchObject({
      project_id: "visual-test",
      timestamp: "2026-06-19T00:00:00.000Z",
      total_unique_segments: 1,
      warnings: [],
      queries: [
        {
          query_id: "must_have_01",
          source: "brief.must_have",
          channel: "visual",
          query: "warm natural light",
          search_input: {
            query: "warm natural light",
            semantic: "warm natural light",
            mode: "hybrid",
            limit: 8,
          },
          result_count: 1,
        },
      ],
    });
    expect(trace.queries[0].results[0].segment_id).toBe("SEG_001");
  });

  it("builds trace entries for visual and audio retrieval evidence", async () => {
    const { buildVisualRetrievalTrace } = await importWithMockedSearch();

    const trace = buildVisualRetrievalTrace(
      "visual-test",
      [evidenceEntry(), audioEvidenceEntry()],
      "2026-06-19T00:00:00.000Z",
    );

    expect(trace.total_unique_segments).toBe(1);
    expect(trace.queries.map((entry) => ({
      query_id: entry.query_id,
      channel: entry.channel,
      result_count: entry.result_count,
    }))).toEqual([
      { query_id: "must_have_01", channel: "visual", result_count: 1 },
      { query_id: "must_have_01", channel: "audio", result_count: 1 },
    ]);
    expect(trace.queries[1].results[0]).toMatchObject({
      segment_id: "SEG_001",
      score_breakdown: {
        audio_similarity: 0.812,
      },
    });
  });

  it("aggregates trace warnings from multiple queries", async () => {
    const { buildVisualRetrievalTrace } = await importWithMockedSearch();

    const trace = buildVisualRetrievalTrace("visual-test", [
      evidenceEntry({ query_id: "must_have_01", warnings: ["fallback", "shared"] }),
      evidenceEntry({
        query_id: "must_have_02",
        query: "steam and texture",
        search_input: searchInput("steam and texture", 8),
        results: [],
        warnings: ["shared", "qwen unavailable"],
      }),
    ], "2026-06-19T00:00:00.000Z");

    expect(trace.warnings).toEqual(["fallback", "shared", "qwen unavailable"]);
  });

  it("builds selected linkage from selected candidates back to query ids and scores", async () => {
    const { buildSelectedLinkage } = await importWithMockedSearch();

    const linkage = buildSelectedLinkage({
      version: "1",
      project_id: "visual-test",
      selection_notes: [],
      editorial_summary: {
        dominant_visual_mode: "mixed",
        speaker_topology: "unknown",
        motion_profile: "medium",
        transcript_density: "sparse",
      },
      candidates: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 3_000_000,
          role: "hero",
          why_it_matches: "warm light",
          risks: [],
          confidence: 0.8,
          semantic_rank: 1,
          evidence: [],
          eligible_beats: ["b01_hook"],
          motif_tags: [],
        },
      ],
    }, [
      evidenceEntry(),
      evidenceEntry({
        query_id: "policy_hint_01",
        source: "brief.editorial.policy_hint",
        query: "steam and texture",
        search_input: searchInput("steam and texture", 8),
        results: [
          visualResult({
            score: 0.91,
            score_breakdown: {
              qwen_visual: 0.88,
              qwen_text: 0.84,
              e5_text: 0.86,
              final: 0.91,
            },
          }),
        ],
      }),
    ]);

    expect(linkage).toEqual([
      {
        segment_id: "SEG_001",
        query_ids: ["must_have_01", "policy_hint_01"],
        best_qwen_visual: 0.88,
        best_final: 0.91,
      },
    ]);
  });
});
