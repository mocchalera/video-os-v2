import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  createGeminiVlmFn,
  computeVlmOutputTokenBudget,
  enrichSegment,
  VLM_TRUNCATED_RESPONSE_ERROR,
  type SamplingPolicy,
  type VlmFn,
  type VlmPolicy,
} from "../runtime/connectors/gemini-vlm.js";
import {
  computeVlmCachePolicyHash,
  VLM_PARSE_FAILURE_DIAGNOSTICS_FILENAME,
  vlmReduce,
  type VlmShard,
} from "../runtime/pipeline/stages/vlm.js";
import type { AssetsJson, SegmentsJson } from "../runtime/pipeline/pipeline-types.js";
import { runPipeline } from "../runtime/pipeline/ingest.js";

const POLICY: VlmPolicy = {
  model_alias: "gemini-2.5-flash-lite",
  model_snapshot: "test-snapshot",
  input_mode: "frame_bundle_plus_text_context",
  response_format: "json_schema_v1",
  prompt_template_id: "m2-segment-grounded-v3",
  max_frame_width_px: 1024,
  segment_visual_token_budget_max: 8192,
  segment_visual_output_tokens_max: 512,
  segment_visual_frame_cap: 90,
  parse_retry_max: 1,
};

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.GEMINI_API_KEY;
const tempDirs: string[] = [];
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TEST_CLIP = path.resolve(import.meta.dirname, "fixtures/media/test-clip-5s.mp4");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalApiKey;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vlm-parse-diagnostics-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function fetchPayload(payload: unknown): void {
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;
}

function loadDefaultVlmPolicy(): VlmPolicy {
  const defaults = parseYaml(fs.readFileSync(
    path.join(REPO_ROOT, "runtime/analysis-defaults.yaml"),
    "utf-8",
  )) as { vlm: VlmPolicy };
  return defaults.vlm;
}

const CACHE_HASH_SAMPLING_POLICY: SamplingPolicy = {
  static: { sample_fps: 0.5 },
  action: { sample_fps_default: 4, sample_fps_min: 3, sample_fps_max: 5 },
  dialogue: { sample_fps: 0.5 },
  music_driven: { sample_fps: 1 },
  general: { sample_fps: 1 },
};

describe("VLM parse failure diagnostics", () => {
  it("uses a bounded dynamic budget for initial and repair calls, diagnostics, and cache identity", async () => {
    const policy = loadDefaultVlmPolicy();
    const requestCaps: number[] = [];
    process.env.GEMINI_API_KEY = "test-key";
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        generationConfig: { maxOutputTokens: number };
      };
      requestCaps.push(request.generationConfig.maxOutputTokens);
      return new Response(JSON.stringify({
        candidates: [{
          finishReason: "MAX_TOKENS",
          content: { parts: [{ text: '{"summary":"truncated"' }] },
        }],
        usageMetadata: { candidatesTokenCount: 500 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await enrichSegment(createGeminiVlmFn(), [TEST_CLIP], 0, 1, policy);
    const expectedBudget = computeVlmOutputTokenBudget(
      1,
      undefined,
      policy.segment_visual_output_tokens_max,
    );

    expect(policy.segment_visual_output_tokens_max).toBe(1024);
    expect(requestCaps).toEqual([expectedBudget, expectedBudget]);
    expect(result.error).toBe(VLM_TRUNCATED_RESPONSE_ERROR);
    expect(result.requested_output_tokens).toBe(expectedBudget);
    expect(result.finish_reason).toBe("MAX_TOKENS");
    expect(result.attempt_count).toBe(2);
    expect(result.retry_reason).toBe("truncated_json");
    expect(result.parse_diagnostics?.map((item) => item.response?.output_token_cap))
      .toEqual([expectedBudget, expectedBudget]);
    expect(result.parse_diagnostics?.every((item) => item.parse_stage === "truncated_json"))
      .toBe(true);
    expect(result.parse_diagnostics?.every((item) => item.response?.truncation_reason === "max_tokens"))
      .toBe(true);
    expect(computeVlmCachePolicyHash(
      policy,
      CACHE_HASH_SAMPLING_POLICY,
      100_000,
    )).not.toBe(computeVlmCachePolicyHash(
      { ...policy, segment_visual_output_tokens_max: 512 },
      CACHE_HASH_SAMPLING_POLICY,
      100_000,
    ));
  });

  it.each([
    ["no_json_span", "PRIVATE-NO-JSON"],
    ["json_syntax_error", '{"summary":"PRIVATE-SYNTAX",}'],
    ["schema_empty", "{}"],
  ] as const)("records bounded %s attempts without response content", async (stage, rawJson) => {
    const vlmFn: VlmFn = async () => ({ rawJson });
    const result = await enrichSegment(vlmFn, ["frame.jpg"], 0, 1, POLICY);

    expect(result.success).toBe(false);
    expect(result.parse_diagnostics).toHaveLength(2);
    expect(result.parse_diagnostics?.map((item) => item.attempt_index)).toEqual([0, 1]);
    expect(result.parse_diagnostics?.every((item) => item.attempt_outcome === "parse_failure")).toBe(true);
    expect(result.parse_diagnostics?.every((item) => item.parse_stage === stage)).toBe(true);
    expect(result.parse_diagnostics?.every((item) => item.response_scope === "candidate_text")).toBe(true);
    expect(result.parse_diagnostics?.every((item) => item.response?.output_token_cap === 512)).toBe(true);
    expect(result.parse_diagnostics?.every((item) => item.response?.text_bytes === Buffer.byteLength(rawJson))).toBe(true);
    expect(result.parse_diagnostics?.every((item) => /^[0-9a-f]{16}$/.test(item.response?.text_sha256_16 ?? ""))).toBe(true);
    expect(JSON.stringify(result.parse_diagnostics)).not.toContain("PRIVATE");
  });

  it("drops recovered initial-attempt diagnostics when the bounded repair succeeds", async () => {
    let calls = 0;
    const vlmFn: VlmFn = async () => ({
      rawJson: calls++ === 0 ? "PRIVATE-NO-JSON" : '{"summary":"ready"}',
    });
    const result = await enrichSegment(vlmFn, ["frame.jpg"], 0, 1, POLICY);

    expect(result.success).toBe(true);
    expect(result.parse_diagnostics).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("classifies a parsed type violation without retaining unknown fields", async () => {
    const rawJson = '{"summary":123,"provider_private":"PRIVATE-SCHEMA"}';
    const result = await enrichSegment(async () => ({ rawJson }), ["frame.jpg"], 0, 1, POLICY);

    expect(result.error).toBe("vlm_schema_validation_failed");
    expect(result.parse_diagnostics?.[0]).toMatchObject({
      parse_stage: "schema_invalid",
      present_top_level_keys: ["summary"],
      validation_errors: expect.arrayContaining([
        expect.objectContaining({ path: "summary", kind: "type" }),
      ]),
    });
    expect(JSON.stringify(result.parse_diagnostics)).not.toContain("provider_private");
    expect(JSON.stringify(result.parse_diagnostics)).not.toContain("PRIVATE-SCHEMA");
  });

  it("records an invalid provider envelope without retaining its body", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response("PRIVATE-INVALID-ENVELOPE", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    const result = await enrichSegment(
      createGeminiVlmFn(),
      [TEST_CLIP],
      0,
      1,
      POLICY,
    );

    expect(result.error).toBe("vlm_parse_failed");
    expect(result.parse_diagnostics?.[0]).toMatchObject({
      parse_stage: "json_syntax_error",
      response_scope: "provider_envelope",
      response: { candidate_count: null },
    });
    expect(JSON.stringify(result.parse_diagnostics)).not.toContain("PRIVATE-INVALID-ENVELOPE");
  });

  it("distinguishes no candidate and blocked no-text responses without retaining provider text", async () => {
    const frame = path.resolve(import.meta.dirname, "fixtures/media/test-clip-5s.mp4");
    fetchPayload({ promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "PRIVATE-BLOCK" } });
    const noCandidate = await enrichSegment(createGeminiVlmFn(), [frame], 0, 1, POLICY);
    expect(noCandidate.parse_diagnostics?.[0]).toMatchObject({
      parse_stage: "no_candidate",
      response_scope: "candidate_text",
      response: {
        candidate_count: 0,
        block_reason: "SAFETY",
        blocked: true,
        text_bytes: 0,
      },
    });
    expect(JSON.stringify(noCandidate.parse_diagnostics)).not.toContain("PRIVATE-BLOCK");

    fetchPayload({ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] });
    const noText = await enrichSegment(createGeminiVlmFn(), [frame], 0, 1, POLICY);
    expect(noText.parse_diagnostics?.[0]).toMatchObject({
      parse_stage: "no_text",
      response_scope: "candidate_text",
      response: {
        candidate_count: 1,
        finish_reason: "SAFETY",
        blocked: true,
        part_count: 0,
        text_part_count: 0,
      },
    });
  });

  it("captures MAX_TOKENS usage and multipart shape while excluding text and thought content", async () => {
    const frame = path.resolve(import.meta.dirname, "fixtures/media/test-clip-5s.mp4");
    fetchPayload({
      candidates: [{
        finishReason: "MAX_TOKENS",
        content: { parts: [
          { thought: true, text: "PRIVATE-THOUGHT" },
          { text: '{"summary":"PRIVATE-SECOND-PART"}' },
        ] },
      }],
      usageMetadata: { candidatesTokenCount: 512, thoughtsTokenCount: 37 },
    });
    const result = await enrichSegment(createGeminiVlmFn(), [frame], 0, 1, POLICY);
    const serialized = JSON.stringify(result.parse_diagnostics);

    expect(result.error).toBe(VLM_TRUNCATED_RESPONSE_ERROR);
    expect(result.parse_diagnostics?.[0]).toMatchObject({
      parse_stage: "truncated_json",
      response_scope: "candidate_text",
      response: {
        finish_reason: "MAX_TOKENS",
        truncation_reason: "max_tokens",
        candidates_token_count: 512,
        thoughts_token_count: 37,
        part_count: 2,
        text_part_count: 2,
        first_part_kind: "thought_text",
      },
    });
    expect(serialized).not.toContain("PRIVATE-THOUGHT");
    expect(serialized).not.toContain("PRIVATE-SECOND-PART");
  });

  it("writes a deterministic failure-only receipt and removes it on a successful cache-only reduce", () => {
    const root = tempDir("writer");
    const analysisDir = path.join(root, "03_analysis");
    fs.mkdirSync(analysisDir, { recursive: true });
    const segmentsPath = path.join(analysisDir, "segments.json");
    const assetsPath = path.join(analysisDir, "assets.json");
    const assets = {
      project_id: "diagnostic-project",
      artifact_version: "analysis-v2",
      items: [{
        asset_id: "AST_001",
        filename: "private.mov",
        duration_us: 1,
        has_transcript: false,
        transcript_ref: null,
        segments: 1,
        segment_ids: ["SEG_001"],
        quality_flags: [],
        tags: [],
        source_fingerprint: "fingerprint",
        contact_sheet_ids: [],
        analysis_status: "partial",
      }],
    } as AssetsJson;
    const segments = {
      project_id: "diagnostic-project",
      artifact_version: "analysis-v2",
      items: [{
        segment_id: "SEG_001",
        asset_id: "AST_001",
        src_in_us: 0,
        src_out_us: 1,
        duration_us: 1,
        rep_frame_us: 0,
        summary: "",
        transcript_excerpt: "",
        quality_flags: [],
        tags: [],
        segment_type: "static",
        transcript_ref: null,
        confidence: {},
        provenance: {},
      }],
    } as unknown as SegmentsJson;
    const response = {
      candidate_count: 1,
      finish_reason: "MAX_TOKENS" as const,
      block_reason: null,
      blocked: false,
      candidates_token_count: 512,
      thoughts_token_count: null,
      output_token_cap: 512,
      text_bytes: 19,
      text_sha256_16: "0123456789abcdef",
      part_count: 1,
      text_part_count: 1,
      first_part_kind: "text" as const,
      has_open_brace: true,
      ends_with_close_brace: false,
      truncation_reason: "max_tokens" as const,
    };
    const shards: VlmShard[] = [{
      segment_id: "SEG_001",
      media_kind: "image",
      result: {
        success: false,
        error: VLM_TRUNCATED_RESPONSE_ERROR,
        prompt_hash: "prompt-hash",
        model_alias: "gemini-2.5-flash-lite",
        model_snapshot: "snapshot",
        requested_output_tokens: 512,
        finish_reason: "MAX_TOKENS",
        attempt_count: 2,
        retry_reason: "truncated_json",
        parse_diagnostics: [
          { attempt_index: 1, attempt_outcome: "parse_failure", error_code: VLM_TRUNCATED_RESPONSE_ERROR, parse_stage: "truncated_json", response_scope: "candidate_text", response },
          { attempt_index: 0, attempt_outcome: "parse_failure", error_code: VLM_TRUNCATED_RESPONSE_ERROR, parse_stage: "truncated_json", response_scope: "candidate_text", response },
        ],
        frame_grounding: {
          frame_count: 1,
          sample_timestamps_us: [0],
          requested_sample_timestamps_us: [0],
          frame_cache_version: "frame-cache",
          frame_producer_version: "frame-producer",
          frame_cache_hits: 0,
          frame_content_sha256: ["a".repeat(64)],
          source_content_sha256: "b".repeat(64),
          cache_identity: "c".repeat(64),
          cache_decision: "miss",
        },
      },
    }];
    shards.push({ ...structuredClone(shards[0]), segment_id: "SEG_FOREIGN" });

    const written = vlmReduce(
      shards,
      structuredClone(assets),
      structuredClone(segments),
      "policy",
      "json_schema_v1",
      segmentsPath,
      assetsPath,
    );
    expect(written.diagnostic_persistence).toEqual({ status: "written" });
    const receiptPath = path.join(analysisDir, VLM_PARSE_FAILURE_DIAGNOSTICS_FILENAME);
    const first = fs.readFileSync(receiptPath, "utf-8");
    const parsed = JSON.parse(first) as { entries: Array<Record<string, unknown>> };
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.map((entry) => entry.attempt_index)).toEqual([0, 1]);
    expect(parsed.entries[0]).toMatchObject({
      asset_id: "AST_001",
      segment_id: "SEG_001",
      model_alias: "gemini-2.5-flash-lite",
      frame_count: 1,
      source_content_sha256: "b".repeat(64),
      cache_identity: "c".repeat(64),
      requested_output_tokens: 512,
      finish_reason: "MAX_TOKENS",
      attempt_count: 2,
      retry_reason: "truncated_json",
    });
    expect(first).not.toContain("private.mov");
    expect(first).not.toContain("frame.jpg");

    const cached = vlmReduce(
      [],
      structuredClone(assets),
      structuredClone(segments),
      "policy",
      "json_schema_v1",
      segmentsPath,
      assetsPath,
    );
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(cached.diagnostic_persistence).toEqual({ status: "removed" });
  });

  it("removes a stale two-entry receipt after fresh and --vlm-only success", async () => {
    const projectDir = tempDir("fresh-vlm-only");
    let calls = 0;
    const malformed: VlmFn = async () => {
      calls += 1;
      return { rawJson: '{"summary":"PRIVATE-TRUNCATED"' };
    };
    const common = {
      projectDir,
      repoRoot: REPO_ROOT,
      skipStt: true,
      skipPeak: true,
      skipMarlin: true,
      skipAppraiser: true,
      skipMediaLink: true,
      skipBgmAnalysis: true,
      vlmFn: malformed,
    };

    await runPipeline({ ...common, sourceFiles: [TEST_CLIP] });
    const receiptPath = path.join(projectDir, "03_analysis", VLM_PARSE_FAILURE_DIAGNOSTICS_FILENAME);
    const fresh = JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as {
      entries: Array<{ parse_stage: string; source_content_sha256: string }>;
    };
    expect(fresh.entries.length).toBeGreaterThan(0);
    expect(fresh.entries.every((entry) => entry.parse_stage === "truncated_json")).toBe(true);
    expect(fresh.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.source_content_sha256))).toBe(true);
    expect(fresh.entries).toHaveLength(2);

    const successful: VlmFn = async () => {
      calls += 1;
      return { rawJson: '{"summary":"ready"}' };
    };
    await runPipeline({
      ...common,
      sourceFiles: [TEST_CLIP],
      vlmFn: successful,
      vlmOnly: true,
    });
    expect(fs.existsSync(receiptPath)).toBe(false);

    await runPipeline({ ...common, sourceFiles: [TEST_CLIP], vlmOnly: true });
    expect((JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as { entries: unknown[] }).entries)
      .toHaveLength(2);

    await runPipeline({
      ...common,
      sourceFiles: [TEST_CLIP],
      vlmFn: successful,
      vlmOnly: true,
    });
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(calls).toBe(6);
  }, 120_000);

  it("removes a stale receipt after a successful fresh public pipeline run", async () => {
    const projectDir = tempDir("fresh-success-cleanup");
    const analysisDir = path.join(projectDir, "03_analysis");
    fs.mkdirSync(analysisDir, { recursive: true });
    const receiptPath = path.join(analysisDir, VLM_PARSE_FAILURE_DIAGNOSTICS_FILENAME);
    fs.writeFileSync(receiptPath, JSON.stringify({
      artifact_version: "vlm-parse-diagnostics-v1",
      project_id: "stale-project",
      entries: [{ attempt_index: 0 }, { attempt_index: 1 }],
    }));
    let calls = 0;
    await runPipeline({
      projectDir,
      repoRoot: REPO_ROOT,
      sourceFiles: [TEST_CLIP],
      skipStt: true,
      skipPeak: true,
      skipMarlin: true,
      skipAppraiser: true,
      skipMediaLink: true,
      skipBgmAnalysis: true,
      vlmFn: async () => {
        calls += 1;
        return { rawJson: '{"summary":"ready"}' };
      },
    });
    expect(calls).toBeGreaterThan(0);
    expect(fs.existsSync(receiptPath)).toBe(false);
  }, 120_000);

  it("keeps per-attempt parse and transport attribution without leaking the repair error", async () => {
    let calls = 0;
    const result = await enrichSegment(async () => {
      calls += 1;
      if (calls === 1) return { rawJson: "PRIVATE-NO-JSON" };
      throw new Error("PRIVATE-TRANSPORT /Users/operator/provider-body");
    }, ["frame.jpg"], 0, 1, POLICY);

    expect(calls).toBe(2);
    expect(result.error).toBe("vlm_call_failed");
    expect(result.parse_diagnostics).toEqual([
      expect.objectContaining({
        attempt_index: 0,
        attempt_outcome: "parse_failure",
        error_code: "vlm_parse_failed",
        parse_stage: "no_json_span",
      }),
      {
        attempt_index: 1,
        attempt_outcome: "call_failure",
        error_code: "vlm_call_failed",
      },
    ]);
    expect(JSON.stringify(result.parse_diagnostics)).not.toContain("PRIVATE");
    expect(JSON.stringify(result.parse_diagnostics)).not.toContain("/Users/");
  });

  it("normalizes unsafe provider numeric metadata to null on truncation", async () => {
    const frame = path.resolve(import.meta.dirname, "fixtures/media/test-clip-5s.mp4");
    fetchPayload({
      candidates: [{
        finishReason: "MAX_TOKENS",
        content: { parts: [{ text: "PRIVATE-NO-JSON" }] },
      }],
      usageMetadata: {
        candidatesTokenCount: 1e300,
        thoughtsTokenCount: Number.MAX_SAFE_INTEGER + 1,
      },
    });
    const unsafe = await enrichSegment(createGeminiVlmFn(), [frame], 0, 1, POLICY);
    expect(unsafe.error).toBe(VLM_TRUNCATED_RESPONSE_ERROR);
    expect(unsafe.parse_diagnostics?.[0]?.parse_stage).toBe("truncated_json");
    expect(unsafe.parse_diagnostics?.[0].response).toMatchObject({
      candidates_token_count: null,
      thoughts_token_count: null,
    });

    fetchPayload({
      candidates: [{
        finishReason: "MAX_TOKENS",
        content: { parts: [{ text: "PRIVATE-NO-JSON" }] },
      }],
      usageMetadata: { candidatesTokenCount: -1, thoughtsTokenCount: 37 },
    });
    const mixed = await enrichSegment(createGeminiVlmFn(), [frame], 0, 1, POLICY);
    expect(mixed.error).toBe(VLM_TRUNCATED_RESPONSE_ERROR);
    expect(mixed.parse_diagnostics?.[0].response).toMatchObject({
      candidates_token_count: null,
      thoughts_token_count: 37,
    });
  });

  it("preserves canonical VLM outcomes and emits only bounded signals on receipt write and cleanup failure", () => {
    const root = tempDir("persistence-failure");
    const analysisDir = path.join(root, "03_analysis");
    fs.mkdirSync(analysisDir, { recursive: true });
    const receiptPath = path.join(analysisDir, VLM_PARSE_FAILURE_DIAGNOSTICS_FILENAME);
    fs.mkdirSync(receiptPath);
    const segmentsPath = path.join(analysisDir, "segments.json");
    const assetsPath = path.join(analysisDir, "assets.json");
    const assets = {
      project_id: "diagnostic-project",
      artifact_version: "analysis-v2",
      items: [],
    } as unknown as AssetsJson;
    const segments = {
      project_id: "diagnostic-project",
      artifact_version: "analysis-v2",
      items: [{
        segment_id: "SEG_001",
        asset_id: "AST_001",
        src_in_us: 0,
        src_out_us: 1,
        duration_us: 1,
        rep_frame_us: 0,
        summary: "",
        transcript_excerpt: "",
        quality_flags: [],
        tags: [],
        segment_type: "static",
        transcript_ref: null,
        confidence: {},
        provenance: {},
      }],
    } as unknown as SegmentsJson;
    const response = {
      candidate_count: 1,
      finish_reason: null,
      block_reason: null,
      blocked: false,
      candidates_token_count: null,
      thoughts_token_count: null,
      output_token_cap: 512,
      text_bytes: 7,
      text_sha256_16: "0123456789abcdef",
      part_count: 1,
      text_part_count: 1,
      first_part_kind: "text" as const,
      has_open_brace: false,
      ends_with_close_brace: false,
    };
    const failedShard: VlmShard = {
      segment_id: "SEG_001",
      media_kind: "image",
      result: {
        success: false,
        error: "vlm_parse_failed",
        prompt_hash: "prompt",
        model_alias: "model",
        model_snapshot: "snapshot",
        parse_diagnostics: [{
          attempt_index: 0,
          attempt_outcome: "parse_failure",
          error_code: "vlm_parse_failed",
          parse_stage: "no_json_span",
          response_scope: "candidate_text",
          response,
        }],
      },
    };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (value?: unknown) => warnings.push(String(value));
    try {
      const writeFailed = vlmReduce(
        [failedShard],
        structuredClone(assets),
        structuredClone(segments),
        "policy",
        "json_schema_v1",
        segmentsPath,
        assetsPath,
      );
      expect(failedShard.result.error).toBe("vlm_parse_failed");
      expect(fs.existsSync(segmentsPath)).toBe(true);
      expect(fs.existsSync(assetsPath)).toBe(true);
      expect(writeFailed.diagnostic_persistence).toEqual({
        status: "write_failed",
        warning_code: "vlm_parse_diagnostic_write_failed",
      });
      expect(fs.readdirSync(analysisDir).filter((name) => name.includes(".tmp."))).toEqual([]);

      const cleanupFailed = vlmReduce(
        [],
        structuredClone(assets),
        structuredClone(segments),
        "policy",
        "json_schema_v1",
        segmentsPath,
        assetsPath,
      );
      expect(cleanupFailed.diagnostic_persistence).toEqual({
        status: "cleanup_failed",
        warning_code: "vlm_parse_diagnostic_cleanup_failed",
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([
      "[vlm] vlm_parse_diagnostic_write_failed",
      "[vlm] vlm_parse_diagnostic_cleanup_failed",
    ]);
    expect(JSON.stringify(warnings)).not.toContain(root);
    expect(JSON.stringify(warnings)).not.toContain("EISDIR");
  });
});
