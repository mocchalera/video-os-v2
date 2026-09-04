import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { loadVideoReasoningLocalVerification } from "../runtime/artifacts/loaders.js";
import {
  normalizeVideoReasoningEvidence,
  VIDEO_REASONING_EVIDENCE_ARTIFACT_VERSION,
} from "../runtime/analysis/video-reasoning-evidence.js";
import {
  assertVideoReasoningLocalVerificationIntegrity,
  extractDenseFrames,
  planDenseFrameTimestamps,
  validateVideoReasoningLocalVerificationIntegrity,
  verifyVideoReasoningLocally,
  VIDEO_REASONING_LOCAL_VERIFICATION_ARTIFACT_VERSION,
  VIDEO_REASONING_LOCAL_VERIFICATION_SCHEMA_FILE,
  type DenseFrameRunnerRequest,
  type LocalFrameAssessment,
} from "../runtime/analysis/video-reasoning-local-verification.js";
import {
  computePromptHash,
  computeVideoReasoningRequestHash,
  VIDEO_REASONING_CONTRACT_VERSION,
  VIDEO_REASONING_RESPONSE_SCHEMA_VERSION,
  type VideoReasoningDiagnostic,
  type VideoReasoningRequest,
  type VideoReasoningResult,
} from "../runtime/connectors/video-reasoning-types.js";

const SOURCE_DURATION_US = 10_000_000;
const EFFECTIVE_RANGE_US = [2_000_000, 8_000_000] as const;
const CANDIDATE_RANGE_US = [3_000_000, 5_000_000] as const;
const SOURCE_HASH = "a".repeat(64);
const SUBMITTED_HASH = "b".repeat(64);
type M3bOptionKeys = keyof Parameters<typeof verifyVideoReasoningLocally>[1];
const M3B_HAS_NO_PADDING_OVERRIDE: "localVerificationWindowPaddingUs" extends M3bOptionKeys ? false : true = true;

function requestFor(
  sourceHash: string,
  effectiveRange: readonly [number, number] = EFFECTIVE_RANGE_US,
): VideoReasoningRequest {
  return {
    task: "moment_refine",
    model: "gemini-3.7-flash",
    prompt: "Find the clearest reveal and return bounded evidence.",
    source: {
      assetId: "AST_001",
      sourceContentSha256: sourceHash,
      submittedMediaContentSha256: SUBMITTED_HASH,
      sourceDurationUs: SOURCE_DURATION_US,
      rangeUs: [...effectiveRange],
    },
    input: { kind: "provider_uri", uri: "gs://example/m3b-proxy.mp4", mimeType: "video/mp4" },
    privacy: "bounded_derivative",
    consent: { approved: true, scope: "bounded_derivative" },
    budget: { maxRequests: 1, maxUploadedDurationUs: 6_000_000 },
  };
}

function diagnosticFor(request: VideoReasoningRequest): VideoReasoningDiagnostic {
  const range = request.source.rangeUs ?? [0, request.source.sourceDurationUs];
  return {
    provider: "gemini",
    connectorVersion: "gemini-agentic-video-v1.1",
    contractVersion: VIDEO_REASONING_CONTRACT_VERSION,
    responseSchemaVersion: VIDEO_REASONING_RESPONSE_SCHEMA_VERSION,
    requestHash: computeVideoReasoningRequestHash(request, range),
    promptHash: computePromptHash(request.prompt),
    sourceAssetId: request.source.assetId,
    sourceContentSha256: request.source.sourceContentSha256,
    submittedMediaContentSha256: request.source.submittedMediaContentSha256 ?? request.source.sourceContentSha256,
    sourceRangeUs: [...range],
    inputKind: request.input.kind,
    mimeType: request.input.mimeType,
    model: request.model,
    task: request.task,
    processingRequested: "agentic",
    storeRequested: false,
    agenticUsed: true,
    processingCallCount: 1,
    processingResultCount: 1,
    matchedProcessingPairCount: 1,
    submitted: true,
    outcome: "completed",
    errorCode: "none",
    elapsedMs: 12,
    providerRequestId: "interaction-123",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

function providerFor(
  sourceHash = SOURCE_HASH,
  candidateRange: readonly [number, number] = CANDIDATE_RANGE_US,
  effectiveRange: readonly [number, number] = EFFECTIVE_RANGE_US,
) {
  const request = requestFor(sourceHash, effectiveRange);
  const result: VideoReasoningResult = {
    outcome: "completed",
    summary: "This provider summary must not enter the local artifact.",
    observations: [{
      startUs: candidateRange[0],
      endUs: candidateRange[1],
      label: "clear_reveal",
      rationale: "The subject turns and the object becomes readable.",
      confidence: 0.9,
      localVerification: "not_run",
    }],
    diagnostic: diagnosticFor(request),
  };
  return normalizeVideoReasoningEvidence(request, result);
}

async function withSource<T>(callback: (sourcePath: string, tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = fs.mkdtempSync(path.join("/tmp", "vos-m3b-test-"));
  const sourcePath = path.join(tempDir, "source.synthetic");
  fs.writeFileSync(sourcePath, "synthetic source bytes\n");
  try {
    return await callback(sourcePath, tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeFrame(request: DenseFrameRunnerRequest): void {
  fs.writeFileSync(request.output_path, `frame at ${request.timestamp_us}`);
}

function canonicalJsonForId(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value) as string;
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForId).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonForId(record[key])}`).join(",")}}`;
  }
  throw new Error("unsupported test identity value");
}

function recomputeArtifactId(artifact: { artifact_id: string }): string {
  const { artifact_id: _artifactId, ...body } = artifact;
  return `VLRV_${crypto.createHash("sha256").update(canonicalJsonForId(body), "utf8").digest("hex")}`;
}

describe("M3b local timestamp/frame verification", () => {
  it("produces a source-bound strict artifact without promoting decoded frames", async () => {
    await withSource(async (sourcePath, tempDir) => {
      const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
      const provider = providerFor(sourceHash);
      const timelinePath = path.join(tempDir, "timeline.json");
      fs.writeFileSync(timelinePath, "{\"version\":\"untouched\"}\n");
      const timelineBefore = fs.readFileSync(timelinePath);
      const artifact = await verifyVideoReasoningLocally(provider, {
        sourcePath,
        runner: async (request) => writeFrame(request),
        assessor: (input): LocalFrameAssessment => {
          expect(input.provider_requested_range_us).toEqual([...EFFECTIVE_RANGE_US]);
          expect(input.provider_candidate_range_us).toEqual([...CANDIDATE_RANGE_US]);
          expect(input.local_verification_window_us).toEqual([2_500_000, 5_500_000]);
          expect(input.frame_timestamps_us.length).toBe(8);
          expect(input.frame_timestamps_us.every((timestamp) => timestamp >= 2_500_000 && timestamp < 5_500_000)).toBe(true);
          expect(input.frame_timestamps_us.some((timestamp) => timestamp < CANDIDATE_RANGE_US[0])).toBe(true);
          expect(input.frame_timestamps_us.some((timestamp) => timestamp >= CANDIDATE_RANGE_US[1])).toBe(true);
          expect(input.frame_paths.every((framePath) => fs.existsSync(framePath))).toBe(true);
          return {
            outcome: "confirmed",
            local_verified_range_us: [3_200_000, 4_800_000],
            rationale_code: "local_motion_confirmed",
            evidence_codes: ["subject_turn", "object_readable"],
          };
        },
      });

      expect(artifact.artifact_version).toBe(VIDEO_REASONING_LOCAL_VERIFICATION_ARTIFACT_VERSION);
      expect(artifact.verification_status).toBe("verified");
      expect(artifact.extraction).toMatchObject({ tool: "ffmpeg", status: "complete", requested_frame_count: 8, decoded_frame_count: 8, failed_frame_count: 0 });
      expect(artifact.records[0]).toMatchObject({
        provider_observation_id: provider.observations[0].observation_id,
        asset_id: "AST_001",
        source_content_sha256: sourceHash,
        source_duration_us: SOURCE_DURATION_US,
        effective_source_range_us: [...EFFECTIVE_RANGE_US],
        provider_requested_range_us: [...EFFECTIVE_RANGE_US],
        provider_candidate_range_us: [...CANDIDATE_RANGE_US],
        local_verification_window_us: [2_500_000, 5_500_000],
        local_verified_range_us: [3_200_000, 4_800_000],
        outcome: "confirmed",
      });
      expect(artifact.records[0].local_frame_timestamps_us.every((timestamp) => timestamp >= 2_500_000 && timestamp < 5_500_000)).toBe(true);
      expect(artifact.records[0].local_frame_timestamps_us).not.toEqual(artifact.records[0].provider_candidate_range_us);
      expect(provider).toMatchObject({
        artifact_version: VIDEO_REASONING_EVIDENCE_ARTIFACT_VERSION,
        local_verification: { status: "not_run", records: [] },
      });
      expect(JSON.stringify(artifact)).not.toContain(sourcePath);
      expect(JSON.stringify(artifact)).not.toContain("clearest reveal");
      expect(JSON.stringify(artifact)).not.toContain("gs://example");
      expect(fs.readFileSync(timelinePath)).toEqual(timelineBefore);
      expect(validateAgainstSchema(artifact, VIDEO_REASONING_LOCAL_VERIFICATION_SCHEMA_FILE)).toEqual({ valid: true, errors: [] });
      expect(validateVideoReasoningLocalVerificationIntegrity(artifact, provider)).toEqual({ valid: true, errors: [] });
      expect(validateVideoReasoningLocalVerificationIntegrity(artifact, undefined as never).errors).toContain("provider artifact is required for source-bound local verification");
      expect(validateAgainstSchema({ ...artifact, unexpected: true }, VIDEO_REASONING_LOCAL_VERIFICATION_SCHEMA_FILE).valid).toBe(false);

      const artifactPath = path.join(tempDir, "local-verification.json");
      fs.writeFileSync(artifactPath, JSON.stringify(artifact));
      expect(loadVideoReasoningLocalVerification(artifactPath, provider)).toEqual(artifact);
      expect(() => loadVideoReasoningLocalVerification(artifactPath, undefined as never)).toThrow(/provider artifact is required/);
    });
  });

  it("keeps M3b v1 window and frame timestamps derivable without a padding override", async () => {
    expect(M3B_HAS_NO_PADDING_OVERRIDE).toBe(true);
    await withSource(async (sourcePath, tempDir) => {
      const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
      const provider = providerFor(sourceHash);
      const artifact = await verifyVideoReasoningLocally(provider, { sourcePath, runner: writeFrame });

      const widerWindow = structuredClone(artifact);
      widerWindow.records[0].local_verification_window_us = [2_000_000, 8_000_000];
      widerWindow.artifact_id = recomputeArtifactId(widerWindow);
      const widerErrors = validateVideoReasoningLocalVerificationIntegrity(widerWindow, provider).errors.join(" ");
      expect(widerErrors).toMatch(/local_verification_window_us derived value mismatch/);
      expect(widerErrors).not.toContain("artifact_id content mismatch");
      const widerPath = path.join(tempDir, "wider-window.json");
      fs.writeFileSync(widerPath, JSON.stringify(widerWindow));
      expect(() => loadVideoReasoningLocalVerification(widerPath, provider)).toThrow(/derived value mismatch/);

      const nonPlan = structuredClone(artifact);
      nonPlan.records[0].local_frame_timestamps_us[0] = 2_800_000;
      nonPlan.artifact_id = recomputeArtifactId(nonPlan);
      const nonPlanErrors = validateVideoReasoningLocalVerificationIntegrity(nonPlan, provider).errors.join(" ");
      expect(nonPlanErrors).toMatch(/not an ordered subset of deterministic plan/);
      expect(nonPlanErrors).not.toContain("artifact_id content mismatch");
      const nonPlanPath = path.join(tempDir, "non-plan-frame.json");
      fs.writeFileSync(nonPlanPath, JSON.stringify(nonPlan));
      expect(() => loadVideoReasoningLocalVerification(nonPlanPath, provider)).toThrow(/deterministic plan/);
    });
  });

  it("freezes assessor input and keeps the artifact bound to the provider snapshot", async () => {
    await withSource(async (sourcePath) => {
      const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
      const provider = providerFor(sourceHash);
      let mutationFailures = 0;
      const artifact = await verifyVideoReasoningLocally(provider, {
        sourcePath,
        runner: writeFrame,
        assessor: (input): LocalFrameAssessment => {
          const mutations: Array<() => void> = [
            () => { input.provider_observation.label = "mutated"; },
            () => { input.provider_observation.provider_range_us[0] = 1_000_000; },
            () => { input.source.asset_id = "AST_MUTATED"; },
            () => { input.provider_candidate_range_us[0] = 1_000_000; },
            () => { input.local_verification_window_us[0] = 1_000_000; },
          ];
          for (const mutate of mutations) {
            expect(mutate).toThrow();
            mutationFailures += 1;
          }
          return {
            outcome: "confirmed",
            local_verified_range_us: [3_200_000, 4_800_000],
            rationale_code: "local_motion_confirmed",
            evidence_codes: ["subject_turn"],
          };
        },
      });

      expect(mutationFailures).toBe(5);
      expect(provider.observations[0]).toMatchObject({
        label: "clear_reveal",
        provider_range_us: [...CANDIDATE_RANGE_US],
      });
      expect(artifact.records[0]).toMatchObject({
        provider_observation_id: provider.observations[0].observation_id,
        asset_id: provider.source.asset_id,
        source_content_sha256: sourceHash,
        provider_requested_range_us: [...EFFECTIVE_RANGE_US],
        provider_candidate_range_us: [...CANDIDATE_RANGE_US],
        local_verification_window_us: [2_500_000, 5_500_000],
      });
      expect(validateVideoReasoningLocalVerificationIntegrity(artifact, provider)).toEqual({ valid: true, errors: [] });

      const invalidAssessor = await verifyVideoReasoningLocally(provider, {
        sourcePath,
        runner: writeFrame,
        assessor: (input) => {
          input.source.asset_id = "AST_MUTATED";
          return {
            outcome: "confirmed",
            local_verified_range_us: [3_200_000, 4_800_000],
            rationale_code: "local_motion_confirmed",
            evidence_codes: ["subject_turn"],
          };
        },
      });
      expect(invalidAssessor.records[0]).toMatchObject({ outcome: "inconclusive", rationale_code: "assessor_failed", local_verified_range_us: null });
      expect(validateVideoReasoningLocalVerificationIntegrity(invalidAssessor, provider)).toEqual({ valid: true, errors: [] });
    });
  });

  it("plans deterministic bounded midpoint timestamps and rejects invalid ranges", () => {
    const first = planDenseFrameTimestamps(EFFECTIVE_RANGE_US, { frameCount: 4 });
    expect(first).toEqual([2_750_000, 4_250_000, 5_750_000, 7_250_000]);
    expect(planDenseFrameTimestamps(EFFECTIVE_RANGE_US, { frameCount: 4 })).toEqual(first);
    expect(planDenseFrameTimestamps([0, 1], { frameCount: 32 })).toEqual([0]);
    expect(() => planDenseFrameTimestamps([-1, 10] as readonly [number, number])).toThrow();
    expect(() => planDenseFrameTimestamps([10, 10] as readonly [number, number])).toThrow();
    expect(() => planDenseFrameTimestamps(EFFECTIVE_RANGE_US, { frameCount: 33 })).toThrow();
  });

  it("clamps candidate context at source boundaries and uses a half-open local window", async () => {
    await withSource(async (sourcePath) => {
      const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
      const head = await verifyVideoReasoningLocally(
        providerFor(sourceHash, [0, 1_000_000], [0, 6_000_000]),
        {
          sourcePath,
          runner: writeFrame,
          assessor: (input) => {
            expect(input.local_verification_window_us).toEqual([0, 1_500_000]);
            expect(input.frame_timestamps_us.every((timestamp) => timestamp >= 0 && timestamp < 1_500_000)).toBe(true);
            expect(input.frame_timestamps_us.some((timestamp) => timestamp >= 1_000_000)).toBe(true);
            return {
              outcome: "confirmed",
              local_verified_range_us: [250_000, 750_000],
              rationale_code: "local_head_confirmed",
              evidence_codes: ["subject_visible"],
            };
          },
        },
      );
      expect(head.records[0].local_verification_window_us).toEqual([0, 1_500_000]);

      const tail = await verifyVideoReasoningLocally(
        providerFor(sourceHash, [9_000_000, SOURCE_DURATION_US], [4_000_000, SOURCE_DURATION_US]),
        {
          sourcePath,
          runner: writeFrame,
          assessor: (input) => {
            expect(input.local_verification_window_us).toEqual([8_500_000, SOURCE_DURATION_US]);
            expect(input.frame_timestamps_us.every((timestamp) => timestamp >= 8_500_000 && timestamp < SOURCE_DURATION_US)).toBe(true);
            expect(input.frame_timestamps_us).not.toContain(SOURCE_DURATION_US);
            expect(input.frame_timestamps_us.some((timestamp) => timestamp < 9_000_000)).toBe(true);
            return {
              outcome: "confirmed",
              local_verified_range_us: [9_200_000, 9_800_000],
              rationale_code: "local_tail_confirmed",
              evidence_codes: ["subject_visible"],
            };
          },
        },
      );
      expect(tail.records[0].local_verification_window_us).toEqual([8_500_000, SOURCE_DURATION_US]);
    });
  });

  it("rejects duplicate/out-of-bound extraction timestamps before invoking FFmpeg", async () => {
    await withSource(async (sourcePath, tempDir) => {
      const runner = async () => writeFrame({} as DenseFrameRunnerRequest);
      await expect(extractDenseFrames(sourcePath, [1, 1], { outputDir: tempDir, runner })).rejects.toThrow(/duplicate/);
      await expect(extractDenseFrames(sourcePath, [Number.MAX_SAFE_INTEGER + 1], { outputDir: tempDir, runner })).rejects.toThrow(/timestamp/);
    });
  });

  it("fails open for missing FFmpeg and decode failure without semantic confirmation", async () => {
    await withSource(async (sourcePath) => {
      const provider = providerFor(crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"));
      const missing = await verifyVideoReasoningLocally(provider, {
        sourcePath,
        runner: () => {
          throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
        },
      });
      expect(missing.verification_status).toBe("unavailable");
      expect(missing.records[0]).toMatchObject({ outcome: "inconclusive", frame_extraction_status: "unavailable" });
      expect(missing.records[0].frame_extraction_failure_codes).toContain("ffmpeg_unavailable");

      const decodeFailure = await verifyVideoReasoningLocally(provider, {
        sourcePath,
        runner: () => undefined,
      });
      expect(decodeFailure.verification_status).toBe("unavailable");
      expect(decodeFailure.records[0].outcome).toBe("inconclusive");
      expect(decodeFailure.records[0].frame_extraction_failure_codes).toContain("frame_not_decoded");
      expect(decodeFailure.records[0].frame_extraction_failure_codes).toContain("insufficient_frames");

      let attempts = 0;
      const partial = await verifyVideoReasoningLocally(provider, {
        sourcePath,
        runner: (request) => {
          attempts += 1;
          if (attempts % 2 === 0) throw new Error("decode failed");
          writeFrame(request);
        },
      });
      expect(partial.extraction.status).toBe("partial");
      expect(partial.records[0].frame_extraction_status).toBe("partial");
      const expectedPlan = planDenseFrameTimestamps([2_500_000, 5_500_000], { frameCount: 8 });
      expect(partial.records[0].local_frame_timestamps_us).toEqual(expectedPlan
        .filter((_timestamp, index) => index % 2 === 0));
    });
  });

  it("keeps decode-only evidence inconclusive and records explicit adjusted/rejected assessor outcomes", async () => {
    await withSource(async (sourcePath) => {
      const provider = providerFor(crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"));
      const decodedOnly = await verifyVideoReasoningLocally(provider, { sourcePath, runner: writeFrame });
      expect(decodedOnly.verification_status).toBe("inconclusive");
      expect(decodedOnly.records[0]).toMatchObject({ outcome: "inconclusive", local_verified_range_us: null, rationale_code: "assessor_not_provided" });

      const adjusted = await verifyVideoReasoningLocally(provider, {
        sourcePath,
        runner: writeFrame,
        assessor: () => ({ outcome: "adjusted", local_verified_range_us: [3_100_000, 4_600_000], rationale_code: "local_boundary_adjusted", evidence_codes: ["cut_boundary"] }),
      });
      expect(adjusted.verification_status).toBe("verified");
      expect(adjusted.records[0]).toMatchObject({ outcome: "adjusted", local_verified_range_us: [3_100_000, 4_600_000] });

      const unobservedAdjusted = await verifyVideoReasoningLocally(provider, {
        sourcePath,
        runner: writeFrame,
        assessor: () => ({ outcome: "adjusted", local_verified_range_us: [6_000_000, 7_000_000], rationale_code: "local_unobserved_adjustment", evidence_codes: ["cut_boundary"] }),
      });
      expect(unobservedAdjusted).toMatchObject({ verification_status: "inconclusive" });
      expect(unobservedAdjusted.records[0]).toMatchObject({ outcome: "inconclusive", local_verified_range_us: null, rationale_code: "assessor_invalid" });

      const rejected = await verifyVideoReasoningLocally(provider, {
        sourcePath,
        runner: writeFrame,
        assessor: () => ({ outcome: "rejected", rationale_code: "local_subject_absent", evidence_codes: ["subject_absent"] }),
      });
      expect(rejected.verification_status).toBe("verified");
      expect(rejected.records[0]).toMatchObject({ outcome: "rejected", local_verified_range_us: null });
    });
  });

  it("rejects source-hash and provider-observation binding mismatches", async () => {
    await withSource(async (sourcePath, tempDir) => {
      const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
      const provider = providerFor(sourceHash);
      const otherPath = path.join(tempDir, "changed.synthetic");
      fs.writeFileSync(otherPath, "changed source bytes\n");
      await expect(verifyVideoReasoningLocally(provider, { sourcePath: otherPath, runner: writeFrame })).rejects.toThrow(/source_content_identity_mismatch/);

      const artifact = await verifyVideoReasoningLocally(provider, { sourcePath, runner: writeFrame });
      const tampered = structuredClone(artifact);
      tampered.records[0].provider_candidate_range_us = [1_000_000, 9_000_000];
      expect(validateVideoReasoningLocalVerificationIntegrity(tampered, provider).errors.join(" ")).toMatch(/provider_candidate_range_us/);
      tampered.records[0].provider_candidate_range_us = [3_100_000, 5_100_000];
      expect(validateVideoReasoningLocalVerificationIntegrity(tampered, provider).errors.join(" ")).toMatch(/provider observation mismatch/);
      tampered.records[0].provider_candidate_range_us = [...CANDIDATE_RANGE_US];
      tampered.records[0].local_frame_timestamps_us[0] = tampered.records[0].local_verification_window_us[1];
      expect(validateVideoReasoningLocalVerificationIntegrity(tampered, provider).errors.join(" ")).toMatch(/outside local verification window/);
      tampered.records[0].local_frame_timestamps_us[0] = artifact.records[0].local_frame_timestamps_us[0];
      tampered.records[0].provider_observation_id = `VREO_${"c".repeat(64)}`;
      expect(validateVideoReasoningLocalVerificationIntegrity(tampered, provider).valid).toBe(false);
      expect(() => assertVideoReasoningLocalVerificationIntegrity(tampered, provider)).toThrow(/not bound/);
      tampered.records[0].provider_observation_id = provider.observations[0].observation_id;
      tampered.source.source_content_sha256 = "d".repeat(64);
      expect(validateVideoReasoningLocalVerificationIntegrity(tampered, provider).errors.join(" ")).toMatch(/source_content_sha256/);
    });
  });

  it("rejects a complete extraction summary that has partial frame counts", async () => {
    await withSource(async (sourcePath, tempDir) => {
      const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
      const provider = providerFor(sourceHash);
      const artifact = await verifyVideoReasoningLocally(provider, {
        sourcePath,
        framesPerObservation: 9,
        runner: writeFrame,
        assessor: () => ({
          outcome: "confirmed",
          local_verified_range_us: [3_200_000, 4_800_000],
          rationale_code: "local_motion_confirmed",
          evidence_codes: ["subject_turn"],
        }),
      });
      const tampered = structuredClone(artifact);
      tampered.records[0].local_frame_timestamps_us.pop();
      tampered.records[0].frame_extraction_status = "complete";
      tampered.records[0].frame_extraction_failure_codes = [];
      tampered.extraction.decoded_frame_count = 8;
      tampered.extraction.failed_frame_count = 1;
      tampered.extraction.status = "complete";
      tampered.extraction.failure_codes = [];
      const artifactPath = path.join(tempDir, "partial-as-complete.json");
      fs.writeFileSync(artifactPath, JSON.stringify(tampered));

      expect(() => loadVideoReasoningLocalVerification(artifactPath, provider)).toThrow(/complete extraction is inconsistent/);
    });
  });

  it("keeps caller-owned output sentinels when a run-owned decode lane fails", async () => {
    await withSource(async (sourcePath, tempDir) => {
      const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
      const provider = providerFor(sourceHash);
      const outputDir = path.join(tempDir, "caller-output");
      const firstTimestamp = planDenseFrameTimestamps([2_500_000, 5_500_000], { frameCount: 8 })[0];
      const sentinel = path.join(outputDir, "observation-00", `frame-000-${firstTimestamp}.jpg`);
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, "caller sentinel");

      const artifact = await verifyVideoReasoningLocally(provider, {
        sourcePath,
        outputDir,
        runner: () => {
          throw new Error("decode failed");
        },
      });

      expect(artifact.records[0]).toMatchObject({ outcome: "inconclusive", frame_extraction_status: "unavailable" });
      expect(fs.readFileSync(sentinel, "utf8")).toBe("caller sentinel");
      expect(fs.existsSync(path.join(outputDir, "observation-00"))).toBe(true);
      expect(fs.readdirSync(outputDir).filter((entry) => entry.startsWith(".vos-local-verification-")).length).toBe(0);
    });
  });

  it("keeps an empty provider result explicitly unavailable", async () => {
    await withSource(async (sourcePath) => {
      const request = requestFor(crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"));
      const emptyProvider = normalizeVideoReasoningEvidence(request, {
        outcome: "failed",
        summary: "No provider observations.",
        observations: [],
        diagnostic: {
          ...diagnosticFor(request),
          outcome: "failed",
          errorCode: "provider_response_invalid",
          submitted: false,
          agenticUsed: false,
          processingCallCount: 0,
          processingResultCount: 0,
          matchedProcessingPairCount: 0,
        },
      });
      const artifact = await verifyVideoReasoningLocally(emptyProvider, { sourcePath, runner: writeFrame });
      expect(artifact).toMatchObject({ verification_status: "unavailable", records: [], extraction: { status: "unavailable", failure_codes: ["no_provider_observations"] } });
    });
  });
});
