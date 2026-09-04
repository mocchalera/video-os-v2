/**
 * Focused M1 tests for the read-only Gemini Agentic Video connector.
 * Every provider call is mocked; no network, upload, or canonical artifact write occurs.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GEMINI_INTERACTIONS_API_REVISION,
  GEMINI_INTERACTIONS_ENDPOINT,
  VIDEO_REASONING_RESPONSE_SCHEMA,
  createGeminiAgenticVideoConnector,
  type GeminiInteractionsHttpRequest,
  type GeminiInteractionsTransport,
} from "../runtime/connectors/gemini-agentic-video.js";
import type { VideoReasoningRequest } from
  "../runtime/connectors/video-reasoning-types.js";
import {
  buildProbeRequest,
  parseArgs,
} from "../scripts/agentic-video-probe.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function makeInlineVideo(bytes = "synthetic-video-bytes"): { path: string; hash: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-video-test-"));
  tempDirs.push(dir);
  const videoPath = path.join(dir, "sample.mp4");
  fs.writeFileSync(videoPath, bytes);
  return { path: videoPath, hash: sha256(bytes) };
}

function structuredOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp_basis: "submitted_media",
    summary: "A clear reveal occurs in the submitted range.",
    observations: [
      {
        start_seconds: 1.25,
        end_seconds: 2.5,
        label: "clear_reveal",
        rationale: "The subject turns and the object becomes readable.",
        confidence: 0.84,
      },
    ],
    ...overrides,
  };
}

function interactionBody(
  output: Record<string, unknown> = structuredOutput(),
  steps: Array<Record<string, unknown>> | null = null,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id: "int_test_123",
    object: "interaction",
    model: "gemini-3.7-flash",
    status: "completed",
    steps: steps ?? [
      { type: "thought", signature: "redacted-signature" },
      { type: "processing_call", id: "process_1", signature: "redacted-signature" },
      { type: "processing_result", call_id: "process_1", signature: "redacted-signature" },
      {
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify(output) }],
      },
    ],
    usage: {
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_tokens: 15,
      total_thought_tokens: 2,
      total_tool_use_tokens: 3,
    },
    ...overrides,
  });
}

function inlineRequest(
  videoPath: string,
  hash: string,
  overrides: Partial<VideoReasoningRequest> = {},
): VideoReasoningRequest {
  return {
    task: "moment_refine",
    model: "gemini-3.7-flash",
    prompt: "Find the clearest reveal and return only the requested structure.",
    source: {
      assetId: "AST_001",
      sourceContentSha256: "a".repeat(64),
      submittedMediaContentSha256: hash,
      sourceDurationUs: 20_000_000,
      rangeUs: [5_000_000, 15_000_000],
    },
    input: {
      kind: "inline",
      path: videoPath,
      mimeType: "video/mp4",
    },
    privacy: "bounded_derivative",
    consent: { approved: true, scope: "bounded_derivative" },
    budget: { maxRequests: 1, maxInputBytes: 1024 * 1024, timeoutMs: 1_000 },
    ...overrides,
  };
}

function successTransport(captured: GeminiInteractionsHttpRequest[]): GeminiInteractionsTransport {
  return async (request) => {
    captured.push(request);
    return { status: 200, body: interactionBody() };
  };
}

describe("Gemini Agentic Video consent and request construction", () => {
  it("refuses local-only and missing-consent requests before any network call", async () => {
    const media = makeInlineVideo();
    let calls = 0;
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key",
      transport: async () => {
        calls += 1;
        return { status: 200, body: interactionBody() };
      },
    });

    const localOnly = await connector(inlineRequest(media.path, media.hash, {
      privacy: "local_only",
      consent: undefined,
    }));
    const noConsent = await connector(inlineRequest(media.path, media.hash, {
      consent: undefined,
    }));

    expect(localOnly.outcome).toBe("rejected");
    expect(localOnly.diagnostic.errorCode).toBe("local_only");
    expect(noConsent.outcome).toBe("rejected");
    expect(noConsent.diagnostic.errorCode).toBe("cloud_consent_required");
    expect(calls).toBe(0);
  });

  it("constructs one stateless inline Interactions request and normalizes range-relative seconds", async () => {
    const media = makeInlineVideo();
    const captured: GeminiInteractionsHttpRequest[] = [];
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key-never-project",
      transport: successTransport(captured),
    });

    const result = await connector(inlineRequest(media.path, media.hash));

    expect(result.outcome).toBe("completed");
    expect(result.observations).toEqual([
      {
        startUs: 6_250_000,
        endUs: 7_500_000,
        label: "clear_reveal",
        rationale: "The subject turns and the object becomes readable.",
        confidence: 0.84,
        localVerification: "not_run",
      },
    ]);
    expect(result.diagnostic.agenticUsed).toBe(true);
    expect(result.diagnostic.storeRequested).toBe(false);
    expect(result.diagnostic.matchedProcessingPairCount).toBe(1);
    expect(result.diagnostic.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      totalThoughtTokens: 2,
      totalToolUseTokens: 3,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(GEMINI_INTERACTIONS_ENDPOINT);
    expect(captured[0].headers["Api-Revision"]).toBe(GEMINI_INTERACTIONS_API_REVISION);
    expect(captured[0].headers["x-goog-api-key"]).toBe("secret-key-never-project");

    const body = JSON.parse(captured[0].body) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    expect(body.store).toBe(false);
    expect(input[0]).toMatchObject({
      type: "video",
      mime_type: "video/mp4",
      processing: "agentic",
      data: Buffer.from("synthetic-video-bytes").toString("base64"),
    });
    expect(input[0]).not.toHaveProperty("uri");
    expect(input[1]).toEqual({
      type: "text",
      text: "Find the clearest reveal and return only the requested structure.",
    });
    expect(body.response_format).toEqual({
      type: "text",
      mime_type: "application/json",
      schema: VIDEO_REASONING_RESPONSE_SCHEMA,
    });

    const projected = JSON.stringify(result);
    expect(projected).not.toContain(media.path);
    expect(projected).not.toContain("secret-key-never-project");
    expect(projected).not.toContain("Find the clearest reveal");
  });

  it("supports an existing Gemini File URI without projecting it into diagnostics", async () => {
    const providerUri = "https://generativelanguage.googleapis.com/v1beta/files/private-file-123";
    const captured: GeminiInteractionsHttpRequest[] = [];
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key",
      transport: successTransport(captured),
    });
    const request: VideoReasoningRequest = {
      task: "needle_search",
      model: "gemini-3.7-flash",
      prompt: "Find the requested moment.",
      source: {
        assetId: "AST_URI",
        sourceContentSha256: "b".repeat(64),
        submittedMediaContentSha256: "c".repeat(64),
        sourceDurationUs: 10_000_000,
      },
      input: { kind: "provider_uri", uri: providerUri, mimeType: "video/mp4" },
      privacy: "source_allowed",
      consent: { approved: true, scope: "source_allowed" },
      budget: { maxRequests: 1, timeoutMs: 1_000 },
    };

    const result = await connector(request);
    const body = JSON.parse(captured[0].body) as { input: Array<Record<string, unknown>>; store: boolean };

    expect(result.outcome).toBe("completed");
    expect(body.store).toBe(false);
    expect(body.input[0]).toMatchObject({
      type: "video",
      uri: providerUri,
      mime_type: "video/mp4",
      processing: "agentic",
    });
    expect(body.input[0]).not.toHaveProperty("data");
    expect(JSON.stringify(result)).not.toContain(providerUri);
  });

  it("rejects arbitrary HTTPS URIs and unsupported models before provider access", async () => {
    let calls = 0;
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key",
      transport: async () => {
        calls += 1;
        return { status: 200, body: interactionBody() };
      },
    });
    const base: VideoReasoningRequest = {
      task: "needle_search",
      model: "gemini-3.7-flash",
      prompt: "Find the requested moment.",
      source: {
        assetId: "AST_URI",
        sourceContentSha256: "b".repeat(64),
        sourceDurationUs: 10_000_000,
      },
      input: { kind: "provider_uri", uri: "https://example.com/private.mp4", mimeType: "video/mp4" },
      privacy: "source_allowed",
      consent: { approved: true, scope: "source_allowed" },
      budget: { maxRequests: 1 },
    };

    const badUri = await connector(base);
    const badModel = await connector({
      ...base,
      model: "gemini-2.5-flash",
      input: {
        kind: "provider_uri",
        uri: "gs://registered-bucket/video.mp4",
        mimeType: "video/mp4",
      },
    });

    expect(badUri.diagnostic.errorCode).toBe("provider_uri_not_allowed");
    expect(badModel.diagnostic.errorCode).toBe("unsupported_model");
    expect(calls).toBe(0);
  });

  it("rejects a non-full range that is not bound to distinct derivative bytes", async () => {
    const media = makeInlineVideo();
    let calls = 0;
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key",
      transport: async () => {
        calls += 1;
        return { status: 200, body: interactionBody() };
      },
    });

    const result = await connector(inlineRequest(media.path, media.hash, {
      source: {
        assetId: "AST_001",
        sourceContentSha256: media.hash,
        submittedMediaContentSha256: media.hash,
        sourceDurationUs: 20_000_000,
        rangeUs: [5_000_000, 15_000_000],
      },
    }));

    expect(result.outcome).toBe("rejected");
    expect(result.diagnostic.errorCode).toBe("invalid_request");
    expect(calls).toBe(0);
  });

  it("enforces a total serialized request ceiling after base64 expansion", async () => {
    const media = makeInlineVideo("request-size-test");
    let calls = 0;
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key",
      maxRequestBytes: 64,
      transport: async () => {
        calls += 1;
        return { status: 200, body: interactionBody() };
      },
    });

    const result = await connector(inlineRequest(media.path, media.hash));

    expect(result.outcome).toBe("rejected");
    expect(result.diagnostic.errorCode).toBe("request_too_large");
    expect(result.diagnostic.requestBytes).toBeGreaterThan(64);
    expect(calls).toBe(0);
  });
});

describe("Gemini Agentic Video fail-closed evidence and error projection", () => {
  it("does not claim agentic use without a matching processing result", async () => {
    const media = makeInlineVideo();
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key",
      transport: async () => ({
        status: 200,
        body: interactionBody(structuredOutput(), [
          { type: "processing_call", id: "process_missing" },
          {
            type: "model_output",
            content: [{ type: "text", text: JSON.stringify(structuredOutput()) }],
          },
        ]),
      }),
    });

    const result = await connector(inlineRequest(media.path, media.hash));

    expect(result.outcome).toBe("failed");
    expect(result.diagnostic.errorCode).toBe("agentic_steps_missing");
    expect(result.diagnostic.agenticUsed).toBe(false);
    expect(result.diagnostic.processingCallCount).toBe(1);
    expect(result.diagnostic.processingResultCount).toBe(0);
    expect(result.observations).toEqual([]);
  });

  it("rejects schema-shaped timestamps outside the submitted source range", async () => {
    const media = makeInlineVideo();
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key",
      transport: async () => ({
        status: 200,
        body: interactionBody(structuredOutput({
          observations: [
            {
              start_seconds: 9,
              end_seconds: 11,
              label: "outside_range",
              rationale: "The end exceeds the ten-second submitted derivative.",
              confidence: 0.7,
            },
          ],
        })),
      }),
    });

    const result = await connector(inlineRequest(media.path, media.hash));

    expect(result.outcome).toBe("failed");
    expect(result.diagnostic.errorCode).toBe("structured_output_invalid");
    expect(result.observations).toEqual([]);
  });

  it("rejects a non-completed interaction even when it contains partial output", async () => {
    const media = makeInlineVideo();
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key",
      transport: async () => ({
        status: 200,
        body: interactionBody(structuredOutput(), null, { status: "in_progress" }),
      }),
    });

    const result = await connector(inlineRequest(media.path, media.hash));

    expect(result.outcome).toBe("failed");
    expect(result.diagnostic.errorCode).toBe("interaction_incomplete");
    expect(result.observations).toEqual([]);
  });

  it("classifies a post-submit deadline as unknown and never retries", async () => {
    const media = makeInlineVideo();
    let calls = 0;
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key",
      transport: async () => {
        calls += 1;
        return new Promise<never>(() => undefined);
      },
    });

    const result = await connector(inlineRequest(media.path, media.hash, {
      budget: { maxRequests: 1, maxInputBytes: 1024 * 1024, timeoutMs: 10 },
    }));

    expect(result.outcome).toBe("unknown");
    expect(result.diagnostic.errorCode).toBe("transport_timeout_unknown");
    expect(result.diagnostic.submitted).toBe(true);
    expect(calls).toBe(1);
  });

  it("projects HTTP failures without provider bodies, prompts, keys, paths, or URIs", async () => {
    const media = makeInlineVideo();
    const leaked = [
      "API_KEY=super-secret",
      "https://upload.example/private?token=abc",
      "RAW PROVIDER FAILURE BODY",
    ].join(" ");
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "super-secret-api-key",
      transport: async () => ({ status: 403, body: leaked }),
    });

    const result = await connector(inlineRequest(media.path, media.hash));
    const projected = JSON.stringify(result);

    expect(result.outcome).toBe("failed");
    expect(result.diagnostic.errorCode).toBe("provider_http_error");
    expect(result.diagnostic.httpStatus).toBe(403);
    expect(projected).not.toContain(leaked);
    expect(projected).not.toContain("super-secret");
    expect(projected).not.toContain(media.path);
    expect(projected).not.toContain("Find the clearest reveal");
  });

  it("rejects oversized provider responses before parsing or projecting content", async () => {
    const media = makeInlineVideo();
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key",
      maxResponseBytes: 32,
      transport: async () => ({ status: 200, body: "provider-secret-".repeat(20) }),
    });

    const result = await connector(inlineRequest(media.path, media.hash));

    expect(result.outcome).toBe("failed");
    expect(result.diagnostic.errorCode).toBe("provider_response_too_large");
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("rejects an inline content hash mismatch before provider access", async () => {
    const media = makeInlineVideo();
    let calls = 0;
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "secret-key",
      transport: async () => {
        calls += 1;
        return { status: 200, body: interactionBody() };
      },
    });

    const result = await connector(inlineRequest(media.path, "0".repeat(64)));

    expect(result.outcome).toBe("rejected");
    expect(result.diagnostic.errorCode).toBe("input_content_hash_mismatch");
    expect(calls).toBe(0);
  });
});

describe("agentic-video probe CLI contract", () => {
  it("requires explicit cloud privacy and upload consent", () => {
    expect(() => parseArgs([
      "node",
      "script",
      "--video",
      "/tmp/input.mp4",
      "--asset-id",
      "AST_001",
      "--duration-us",
      "1000000",
      "--prompt",
      "Find a moment",
    ])).toThrow(/Live probe refused/);
  });

  it("requires original source identity for a non-full submitted range", () => {
    expect(() => parseArgs([
      "node",
      "script",
      "--video",
      "/tmp/input.mp4",
      "--asset-id",
      "AST_001",
      "--duration-us",
      "1000000",
      "--prompt",
      "Find a moment",
      "--range-start-us",
      "100",
      "--range-end-us",
      "900",
      "--privacy",
      "bounded_derivative",
      "--consent-cloud-upload",
    ])).toThrow(/original --source-sha256/);
  });

  it("builds a read-only inline request with computed submitted-media identity", () => {
    const media = makeInlineVideo("probe-video");
    const args = parseArgs([
      "node",
      "script",
      "--video",
      media.path,
      "--asset-id",
      "AST_PROBE",
      "--duration-us",
      "5000000",
      "--prompt",
      "Find a moment",
      "--privacy",
      "bounded_derivative",
      "--consent-cloud-upload",
    ]);

    const request = buildProbeRequest(args);

    expect(request.input).toEqual({
      kind: "inline",
      path: media.path,
      mimeType: "video/mp4",
    });
    expect(request.source.sourceContentSha256).toBe(media.hash);
    expect(request.source.submittedMediaContentSha256).toBe(media.hash);
    expect(request.consent).toEqual({ approved: true, scope: "bounded_derivative" });
    expect(request.budget?.maxRequests).toBe(1);
  });
});
