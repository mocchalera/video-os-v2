import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fineCutRefinement,
  formatFineFrameReferences,
  formatRoughFrameReferences,
  roughCutPlanning,
} from "../runtime/agents/unified-editorial-agent.js";
import { getCandidateRef } from "../runtime/compiler/candidate-ref.js";
import type { CreativeBrief } from "../runtime/artifacts/types.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { MarlinEventsArtifact } from "../runtime/connectors/marlin-types.js";
import type { KeyFrame } from "../runtime/pipeline/stages/craft-frames.js";
import type {
  AudioRetrievalEvidence,
  VisualRetrievalEvidence,
} from "../runtime/agents/visual-retrieval-evidence.js";
import { parseArgs } from "../scripts/editorial-pipeline.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: Array<{ instancePath: string; message?: string }> | null };
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

let previousGeminiKey: string | undefined;

function createValidator(schemaFile: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(path.resolve("schemas", schemaFile), "utf-8")) as object;
  return ajv.compile(schema);
}

function brief(): CreativeBrief {
  return {
    version: "1",
    project_id: "unified-test",
    project: {
      id: "unified-test",
      title: "Unified Editorial Fixture",
      strategy: "message-first",
      runtime_target_sec: 24,
      duration_mode: "guide",
    },
    message: {
      primary: "Show a confident handoff from setup to payoff.",
      secondary: ["clear action", "warm ending"],
    },
    emotion_curve: ["hook", "setup", "payoff"],
    must_have: ["hands preparing", "person smiling"],
    order_policy: "editorial",
    caption_policy: "auto",
    audio_policy: "bgm_only",
    context_knowledge: {
      key_items: [
        {
          name: "栗きんとん",
          description: "Chestnut confection",
          significance: "Small round objects handled with tongs are chestnuts, not insects.",
        },
      ],
      terminology: [
        {
          term: "栗",
          meaning: "Chestnuts - the small round objects being handled are NOT insects",
        },
      ],
    },
  };
}

function segment(overrides: Partial<SegmentItem>): SegmentItem {
  return {
    segment_id: "SEG_001",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 4_000_000,
    duration_us: 4_000_000,
    rep_frame_us: 2_000_000,
    summary: "Hands prepare the object on a table.",
    transcript_excerpt: "",
    quality_flags: [],
    tags: ["hands", "setup"],
    segment_type: "shot",
    transcript_ref: null,
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
    ...overrides,
  };
}

function segments(): SegmentItem[] {
  return [
    segment({
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 4_000_000,
      summary: "Hands prepare the product with clear action.",
      tags: ["hands", "setup"],
    }),
    segment({
      segment_id: "SEG_002",
      asset_id: "AST_002",
      src_in_us: 1_000_000,
      src_out_us: 5_000_000,
      summary: "A person smiles after seeing the finished result.",
      tags: ["smile", "payoff"],
      transcript_excerpt: "It looks good.",
    }),
    segment({
      segment_id: "SEG_003",
      asset_id: "AST_003",
      src_in_us: 500_000,
      src_out_us: 3_500_000,
      summary: "Wide texture shot bridges the action.",
      tags: ["texture", "transition"],
    }),
  ];
}

function marlinEvents(): MarlinEventsArtifact {
  return {
    project_id: "unified-test",
    artifact_version: "1",
    model: {
      provider: "marlin",
      model_alias: "marlin-test",
      model_snapshot: "test",
      inference_mode: "mock",
    },
    items: [
      {
        asset_id: "AST_001",
        source_path: "ast001.mov",
        scene: "Hands prepare the product on a table.",
        events: [
          {
            event_id: "evt_setup",
            start_us: 700_000,
            end_us: 2_800_000,
            description: "Hands move through the clearest preparation action.",
            confidence: 0.88,
            source_pass: "marlin_caption",
          },
        ],
        find_results: [],
      },
      {
        asset_id: "AST_002",
        source_path: "ast002.mov",
        scene: "A person smiles at the final result.",
        events: [
          {
            event_id: "evt_smile",
            start_us: 1_600_000,
            end_us: 4_200_000,
            description: "Person smiles and nods after seeing the result.",
            confidence: 0.92,
            source_pass: "marlin_caption",
          },
        ],
        find_results: [],
      },
      {
        asset_id: "AST_003",
        source_path: "ast003.mov",
        scene: "Wide environmental texture bridge.",
        events: [
          {
            event_id: "evt_bridge",
            start_us: 800_000,
            end_us: 2_400_000,
            description: "Wide bridge shot holds steady.",
            confidence: 0.72,
            source_pass: "marlin_caption",
          },
        ],
        find_results: [],
      },
    ],
  };
}

function representativeFrames(): Map<string, string> {
  return new Map([
    ["AST_001", "03_analysis/representative_frames/AST_001.jpg"],
    ["AST_002", "03_analysis/representative_frames/AST_002.jpg"],
    ["AST_003", "03_analysis/representative_frames/AST_003.jpg"],
  ]);
}

function keyFrames(): Map<string, KeyFrame[]> {
  return new Map([
    ["SEG_001", [
      { timestamp_us: 700_000, path: "03_analysis/craft_frames/SEG_001_in.jpg", label: "in", source: "in_out" },
      { timestamp_us: 1_700_000, path: "03_analysis/craft_frames/SEG_001_peak.jpg", label: "peak", source: "marlin_event" },
      { timestamp_us: 2_800_000, path: "03_analysis/craft_frames/SEG_001_out.jpg", label: "out", source: "in_out" },
    ]],
    ["SEG_002", [
      { timestamp_us: 1_600_000, path: "03_analysis/craft_frames/SEG_002_in.jpg", label: "in", source: "in_out" },
      { timestamp_us: 3_000_000, path: "03_analysis/craft_frames/SEG_002_peak.jpg", label: "peak", source: "marlin_event" },
      { timestamp_us: 4_200_000, path: "03_analysis/craft_frames/SEG_002_out.jpg", label: "out", source: "in_out" },
    ]],
  ]);
}

function visualSearchInput(query: string, limit = 8) {
  return {
    query,
    semantic: query,
    mode: "hybrid" as const,
    limit,
  };
}

function visualEvidence(): VisualRetrievalEvidence[] {
  return [
    {
      query_id: "must_have_01",
      source: "brief.must_have",
      query: "warm natural light",
      search_input: visualSearchInput("warm natural light"),
      mode: "hybrid",
      results: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 4_000_000,
          summary: "Warm light on hands preparing the product.",
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
          tags: ["warm", "hands"],
        },
      ],
      warnings: [],
    },
  ];
}

function audioEvidence(): AudioRetrievalEvidence[] {
  return [
    {
      query_id: "must_have_02",
      source: "brief.must_have",
      query: "quiet room tone",
      channel: "audio",
      search_input: visualSearchInput("quiet room tone"),
      mode: "hybrid",
      results: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 4_000_000,
          summary: "Quiet room tone under soft handling sounds.",
          score: 0.84,
          score_breakdown: {
            audio_similarity: 0.812,
            qwen_text: 0.79,
            e5_text: 0.78,
            lexical: 0.3,
            final: 0.84,
          },
          matched_audio_ref: "03_analysis/audio/SEG_001/representative.wav",
          matched_embedding_type: "audio_representative",
          tags: ["quiet"],
        },
      ],
      warnings: [],
    },
  ];
}

function extractVisualEvidenceJson(prompt: string): Record<string, unknown> {
  const sectionStart = prompt.indexOf("## Visual Retrieval Evidence (Qwen3-VL)");
  expect(sectionStart).toBeGreaterThanOrEqual(0);
  const section = prompt.slice(sectionStart);
  const match = section.match(/```json\n([\s\S]*?)\n```/);
  expect(match?.[1]).toBeTruthy();
  return JSON.parse(match?.[1] ?? "{}") as Record<string, unknown>;
}

function extractAudioEvidenceJson(prompt: string): Record<string, unknown> {
  const sectionStart = prompt.indexOf("## Audio Retrieval Evidence (CLAP)");
  expect(sectionStart).toBeGreaterThanOrEqual(0);
  const section = prompt.slice(sectionStart);
  const match = section.match(/```json\n([\s\S]*?)\n```/);
  expect(match?.[1]).toBeTruthy();
  return JSON.parse(match?.[1] ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  previousGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  if (previousGeminiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = previousGeminiKey;
  }
});

describe("unified editorial agent", () => {
  it("rough pass returns schema-valid selects and blueprint without an API key", async () => {
    const result = await roughCutPlanning(
      brief(),
      marlinEvents(),
      representativeFrames(),
      segments(),
      24,
    );

    const validateSelects = createValidator("selects-candidates.schema.json");
    const validateBlueprint = createValidator("edit-blueprint.schema.json");
    expect(validateSelects(result.selects), JSON.stringify(validateSelects.errors, null, 2)).toBe(true);
    expect(validateBlueprint(result.blueprint), JSON.stringify(validateBlueprint.errors, null, 2)).toBe(true);
    expect(result.selects.candidates.length).toBeGreaterThan(0);
    expect(result.blueprint.beats.length).toBeGreaterThan(0);
  });

  it("fine pass returns a schema-valid refined blueprint and per-clip trim hints", async () => {
    const rough = await roughCutPlanning(
      brief(),
      marlinEvents(),
      representativeFrames(),
      segments(),
      24,
    );

    const refined = await fineCutRefinement(
      brief(),
      rough.selects,
      rough.blueprint,
      marlinEvents(),
      keyFrames(),
      24,
    );

    const validateBlueprint = createValidator("edit-blueprint.schema.json");
    const validateSelects = createValidator("selects-candidates.schema.json");
    expect(validateBlueprint(refined), JSON.stringify(validateBlueprint.errors, null, 2)).toBe(true);
    expect(validateSelects(rough.selects), JSON.stringify(validateSelects.errors, null, 2)).toBe(true);
    expect(refined.beats.every((beat) => beat.craft?.in_point && beat.craft.out_point && beat.craft.rhythm)).toBe(true);
    expect(rough.selects.candidates.some((candidate) => candidate.trim_hint?.recommended_in_us !== undefined)).toBe(true);
  });

  it("fine pass does not introduce candidates outside pass 1 selection", async () => {
    const rough = await roughCutPlanning(
      brief(),
      marlinEvents(),
      representativeFrames(),
      segments(),
      24,
    );
    const allowed = new Set(rough.selects.candidates.map((candidate) => getCandidateRef(candidate)));
    const dirtyBlueprint = {
      ...rough.blueprint,
      beats: rough.blueprint.beats.map((beat, index) => index === 0
        ? {
          ...beat,
          candidate_plan: {
            primary_candidate_ref: "not-selected",
            fallback_candidate_refs: [getCandidateRef(rough.selects.candidates[0])],
          },
        }
        : beat),
    };

    const refined = await fineCutRefinement(
      brief(),
      rough.selects,
      dirtyBlueprint,
      marlinEvents(),
      keyFrames(),
      24,
    );

    for (const beat of refined.beats) {
      const refs = [
        beat.candidate_plan?.primary_candidate_ref,
        ...(beat.candidate_plan?.fallback_candidate_refs ?? []),
      ].filter((ref): ref is string => Boolean(ref));
      expect(refs.every((ref) => allowed.has(ref))).toBe(true);
      expect(refs).not.toContain("not-selected");
    }
  });

  it("headless fallback is text-only and graceful when no API key is configured", async () => {
    await expect(roughCutPlanning(
      brief(),
      marlinEvents(),
      representativeFrames(),
      segments(),
      null,
    )).resolves.toMatchObject({
      selects: { project_id: "unified-test" },
      blueprint: { project_id: "unified-test" },
    });
  });

  it("interactive rough pass returns prompt and absolute frame refs without calling Gemini", async () => {
    const geminiCalls: string[] = [];
    vi.resetModules();
    vi.doMock("../runtime/connectors/gemini-json.js", () => ({
      callGeminiJson: async (prompt: string) => {
        geminiCalls.push(prompt);
        return "{}";
      },
    }));

    try {
      process.env.GEMINI_API_KEY = "test-key-that-should-not-be-used";
      const mod = await import("../runtime/agents/unified-editorial-agent.js");
      const projectDir = path.resolve("tmp", "unified-editorial-agent");
      const task = await mod.roughCutPlanning(
        brief(),
        marlinEvents(),
        representativeFrames(),
        segments(),
        24,
        { mode: "interactive", projectDir },
      );

      expect(geminiCalls).toHaveLength(0);
      expect(task.mode).toBe("interactive");
      expect(task.pass).toBe("rough");
      expect(task.prompt).toContain("## Representative frames for rough pass");
      expect(task.prompt).toContain(path.resolve(projectDir, "03_analysis/representative_frames/AST_001.jpg"));
      expect(task.frame_refs.length).toBe(3);
      expect(task.frame_refs.every((ref) => path.isAbsolute(ref.path))).toBe(true);
    } finally {
      vi.doUnmock("../runtime/connectors/gemini-json.js");
      vi.resetModules();
    }
  });

  it("interactive fine pass advertises optional inspection and footage search tools", async () => {
    const rough = await roughCutPlanning(
      brief(),
      marlinEvents(),
      representativeFrames(),
      segments(),
      24,
    );
    const projectDir = path.resolve("tmp", "unified-editorial-agent");

    const task = await fineCutRefinement(
      brief(),
      rough.selects,
      rough.blueprint,
      marlinEvents(),
      keyFrames(),
      24,
      { mode: "interactive", projectDir },
    );

    expect(task.pass).toBe("fine");
    expect(task.prompt).toContain("## Available tools");
    expect(task.prompt).toContain("analyze_clip_range(asset_id, start_sec, end_sec)");
    expect(task.prompt).toContain("find_moment(asset_id, query)");
    expect(task.prompt).toContain("extract_frame(asset_id, timestamp_sec)");
    expect(task.prompt).toContain("search_footage(query, mode, filters_json, limit, image_query_path, visual_anchor_segment_id, visual_anchor_frame_type, visual_goal)");
    expect(task.prompt).toContain("visual_search(query_frame_path, text_hint, exclude_segment_ids, limit)");
    expect(task.prompt).toContain("mode=visual and image_query_path");
    expect(task.prompt).toContain("best_for_beat(beat_purpose, emotion, exclude_segment_ids, limit)");
    expect(task.prompt).toContain("cite the query, result segment_id, evidence_refs, and key_frame_path");
    expect(task.tools?.map((tool) => tool.name)).toEqual([
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
  });

  it("headless mode calls Gemini when an API key is configured", async () => {
    const geminiCalls: string[] = [];
    vi.resetModules();
    vi.doMock("../runtime/connectors/gemini-json.js", () => ({
      callGeminiJson: async (prompt: string) => {
        geminiCalls.push(prompt);
        return "{}";
      },
    }));

    try {
      process.env.GEMINI_API_KEY = "test-key";
      const mod = await import("../runtime/agents/unified-editorial-agent.js");
      const result = await mod.roughCutPlanning(
        brief(),
        marlinEvents(),
        representativeFrames(),
        segments(),
        24,
        { mode: "headless" },
      );

      expect(geminiCalls).toHaveLength(1);
      expect(geminiCalls[0]).toContain("Pass 1 is rough-cut planning");
      expect(geminiCalls[0]).toContain('"context_knowledge"');
      expect(geminiCalls[0]).toContain("Chestnuts - the small round objects being handled are NOT insects");
      expect(result.selects.project_id).toBe("unified-test");
      expect(result.blueprint.project_id).toBe("unified-test");
    } finally {
      vi.doUnmock("../runtime/connectors/gemini-json.js");
      vi.resetModules();
    }
  });

  it("rough prompt includes JSON-formatted visual retrieval evidence when provided", async () => {
    const geminiCalls: string[] = [];
    vi.resetModules();
    vi.doMock("../runtime/connectors/gemini-json.js", () => ({
      callGeminiJson: async (prompt: string) => {
        geminiCalls.push(prompt);
        return "{}";
      },
    }));

    try {
      process.env.GEMINI_API_KEY = "test-key";
      const mod = await import("../runtime/agents/unified-editorial-agent.js");
      await mod.roughCutPlanning(
        brief(),
        marlinEvents(),
        representativeFrames(),
        segments(),
        24,
        { mode: "headless", visualEvidence: visualEvidence() },
      );

      expect(geminiCalls).toHaveLength(1);
      expect(geminiCalls[0]).toContain("## Visual Retrieval Evidence (Qwen3-VL)");
      const payload = extractVisualEvidenceJson(geminiCalls[0]);
      const entries = payload.visual_retrieval_evidence as Array<Record<string, unknown>>;
      const result = (entries[0].results as Array<Record<string, unknown>>)[0];
      expect(entries[0].query_id).toBe("must_have_01");
      expect(result).toMatchObject({
        segment_id: "SEG_001",
        asset_id: "AST_001",
        src_in_us: 0,
        src_out_us: 4_000_000,
        scores: {
          qwen_visual: 0.852,
          qwen_text: 0.831,
          e5_text: 0.82,
          final: 0.867,
        },
        matched_frame_path: "03_analysis/frames/SEG_001/representative.jpg",
      });
      expect(geminiCalls[0].indexOf("## Visual Retrieval Evidence (Qwen3-VL)"))
        .toBeLessThan(geminiCalls[0].indexOf("## All Marlin asset reports plus representative frames"));
    } finally {
      vi.doUnmock("../runtime/connectors/gemini-json.js");
      vi.resetModules();
    }
  });

  it("rough prompt includes JSON-formatted audio retrieval evidence after visual evidence", async () => {
    const geminiCalls: string[] = [];
    vi.resetModules();
    vi.doMock("../runtime/connectors/gemini-json.js", () => ({
      callGeminiJson: async (prompt: string) => {
        geminiCalls.push(prompt);
        return "{}";
      },
    }));

    try {
      process.env.GEMINI_API_KEY = "test-key";
      const mod = await import("../runtime/agents/unified-editorial-agent.js");
      await mod.roughCutPlanning(
        brief(),
        marlinEvents(),
        representativeFrames(),
        segments(),
        24,
        { mode: "headless", visualEvidence: visualEvidence(), audioEvidence: audioEvidence() },
      );

      expect(geminiCalls).toHaveLength(1);
      expect(geminiCalls[0]).toContain("## Audio Retrieval Evidence (CLAP)");
      const payload = extractAudioEvidenceJson(geminiCalls[0]);
      const entries = payload.audio_retrieval_evidence as Array<Record<string, unknown>>;
      const result = (entries[0].results as Array<Record<string, unknown>>)[0];
      expect(entries[0].query_id).toBe("must_have_02");
      expect(result).toMatchObject({
        segment_id: "SEG_001",
        asset_id: "AST_001",
        scores: {
          audio_similarity: 0.812,
          qwen_text: 0.79,
          e5_text: 0.78,
          final: 0.84,
        },
        matched_audio_ref: "03_analysis/audio/SEG_001/representative.wav",
      });
      expect(geminiCalls[0].indexOf("## Visual Retrieval Evidence (Qwen3-VL)"))
        .toBeLessThan(geminiCalls[0].indexOf("## Audio Retrieval Evidence (CLAP)"));
      expect(geminiCalls[0].indexOf("## Audio Retrieval Evidence (CLAP)"))
        .toBeLessThan(geminiCalls[0].indexOf("## All Marlin asset reports plus representative frames"));
    } finally {
      vi.doUnmock("../runtime/connectors/gemini-json.js");
      vi.resetModules();
    }
  });

  it("rough prompt without retrieval evidence is unchanged for empty evidence", async () => {
    const geminiCalls: string[] = [];
    vi.resetModules();
    vi.doMock("../runtime/connectors/gemini-json.js", () => ({
      callGeminiJson: async (prompt: string) => {
        geminiCalls.push(prompt);
        return "{}";
      },
    }));

    try {
      process.env.GEMINI_API_KEY = "test-key";
      const mod = await import("../runtime/agents/unified-editorial-agent.js");
      await mod.roughCutPlanning(
        brief(),
        marlinEvents(),
        representativeFrames(),
        segments(),
        24,
        { mode: "headless" },
      );
      await mod.roughCutPlanning(
        brief(),
        marlinEvents(),
        representativeFrames(),
        segments(),
        24,
        { mode: "headless", visualEvidence: [], audioEvidence: [] },
      );

      expect(geminiCalls).toHaveLength(2);
      expect(geminiCalls[0]).not.toContain("## Visual Retrieval Evidence (Qwen3-VL)");
      expect(geminiCalls[0]).not.toContain("## Audio Retrieval Evidence (CLAP)");
      expect(geminiCalls[1]).toBe(geminiCalls[0]);
    } finally {
      vi.doUnmock("../runtime/connectors/gemini-json.js");
      vi.resetModules();
    }
  });

  it("enriches selected candidate evidence when a segment matches visual retrieval", async () => {
    const rough = await roughCutPlanning(
      brief(),
      marlinEvents(),
      representativeFrames(),
      segments(),
      24,
      { mode: "headless", visualEvidence: visualEvidence() },
    );

    expect(rough.selects.candidates.find((candidate) => candidate.segment_id === "SEG_001")?.evidence).toContain(
      "Qwen visual retrieval: query=must_have_01 qwen_visual=0.852 final=0.867 matched_frame=03_analysis/frames/SEG_001/representative.jpg",
    );
  });

  it("enriches selected candidate evidence when a segment matches audio retrieval", async () => {
    const rough = await roughCutPlanning(
      brief(),
      marlinEvents(),
      representativeFrames(),
      segments(),
      24,
      { mode: "headless", audioEvidence: audioEvidence() },
    );

    expect(rough.selects.candidates.find((candidate) => candidate.segment_id === "SEG_001")?.evidence).toContain(
      "CLAP audio retrieval: query=must_have_02 audio_similarity=0.812 final=0.840 matched_embedding=audio_representative matched_audio=03_analysis/audio/SEG_001/representative.wav",
    );
  });

  it("skips visual retrieval enrichment when no selected candidate matches", async () => {
    const baseline = await roughCutPlanning(
      brief(),
      marlinEvents(),
      representativeFrames(),
      segments(),
      24,
    );
    const rough = await roughCutPlanning(
      brief(),
      marlinEvents(),
      representativeFrames(),
      segments(),
      24,
      {
        mode: "headless",
        visualEvidence: [
          {
            ...visualEvidence()[0],
            results: [
              {
                ...visualEvidence()[0].results[0],
                segment_id: "SEG_NOT_SELECTED",
                asset_id: "AST_NOT_SELECTED",
              },
            ],
          },
        ],
      },
    );

    expect(rough.selects.candidates.map((candidate) => candidate.evidence)).toEqual(
      baseline.selects.candidates.map((candidate) => candidate.evidence),
    );
  });

  it("adds only one visual retrieval enrichment when the same segment appears in multiple queries", async () => {
    const duplicateEvidence: VisualRetrievalEvidence[] = [
      ...visualEvidence(),
      {
        ...visualEvidence()[0],
        query_id: "policy_hint_01",
        source: "brief.editorial.policy_hint",
        query: "soft texture",
        search_input: visualSearchInput("soft texture"),
        results: [
          {
            ...visualEvidence()[0].results[0],
            score: 0.91,
            score_breakdown: {
              qwen_visual: 0.88,
              qwen_text: 0.84,
              e5_text: 0.86,
              lexical: 0.4,
              final: 0.91,
            },
          },
        ],
      },
    ];

    const rough = await roughCutPlanning(
      brief(),
      marlinEvents(),
      representativeFrames(),
      segments(),
      24,
      { mode: "headless", visualEvidence: duplicateEvidence },
    );

    const evidence = rough.selects.candidates.find((candidate) => candidate.segment_id === "SEG_001")?.evidence ?? [];
    const retrievalLines = evidence.filter((line) => line.startsWith("Qwen visual retrieval:"));
    expect(retrievalLines).toEqual([
      "Qwen visual retrieval: query=policy_hint_01 qwen_visual=0.880 final=0.910 matched_frame=03_analysis/frames/SEG_001/representative.jpg",
    ]);
  });

  it("formats rough and fine frame references for repo-side agents", async () => {
    const projectDir = path.resolve("tmp", "unified-editorial-agent");
    const roughMarkdown = formatRoughFrameReferences({
      marlinEvents: marlinEvents(),
      representativeFrames: representativeFrames(),
      projectDir,
    });

    expect(roughMarkdown).toContain(`Asset AST_001: ${path.resolve(projectDir, "03_analysis/representative_frames/AST_001.jpg")}`);
    expect(roughMarkdown).toContain('Marlin: "Hands prepare the product on a table."');

    const rough = await roughCutPlanning(
      brief(),
      marlinEvents(),
      representativeFrames(),
      segments(),
      24,
    );
    const fineMarkdown = formatFineFrameReferences({
      selects: rough.selects,
      marlinEvents: marlinEvents(),
      keyFrames: keyFrames(),
      projectDir,
    });

    expect(fineMarkdown).toContain("## Key frames for clip");
    expect(fineMarkdown).toContain(`IN:   ${path.resolve(projectDir, "03_analysis/craft_frames/SEG_001_in.jpg")} (0.7s)`);
    expect(fineMarkdown).toContain("-> Suggest in/out adjustment if any frame shows camera issues.");
  });

  it("parses --skip-fine for rough-pass-only CLI runs", () => {
    const args = parseArgs(["node", "script", "--project", "projects/demo", "--skip-fine", "--skip-render"]);

    expect(args.projectDir.endsWith(path.join("projects", "demo"))).toBe(true);
    expect(args.skipFine).toBe(true);
    expect(args.skipRender).toBe(true);
  });
});
