import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coordinateVideoReasoning,
  type VideoReasoningCoordinatorRequest,
} from "../runtime/connectors/video-reasoning-coordinator.js";
import {
  createVideoReasoningRequestLedger,
} from "../runtime/connectors/video-reasoning-ledger.js";
import {
  computeVideoReasoningRequestHash,
  type VideoReasoningConnector,
  type VideoReasoningConnectorContext,
  type VideoReasoningRequest,
  type VideoReasoningResult,
} from "../runtime/connectors/video-reasoning-types.js";
import {
  computeGeminiFileRegistryKey,
  recordGeminiFileReady,
  recordGeminiFileRegistryEntry,
} from "../runtime/connectors/gemini-video-file-cache.js";
import type {
  VideoReasoningEvidenceArtifact,
} from "../runtime/analysis/video-reasoning-evidence.js";
import type {
  VideoReasoningLocalVerificationArtifact,
} from "../runtime/analysis/video-reasoning-local-verification.js";
import {
  routeVideoReasoningDisagreement,
  type RouteVideoReasoningDisagreementInput,
} from "../runtime/analysis/video-reasoning-disagreement-router.js";
import {
  main as cliMain,
  parseArgs as cliParseArgs,
  buildCoordinatorRequest as cliBuildRequest,
} from "../scripts/agentic-video-request.js";

describe("Issue #73 M4a: Video Reasoning Runtime Coordinator", () => {
  const tempDirs: string[] = [];
  let testDir: string;
  let testMedia: { path: string; hash: string; durationUs: number };

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-m4a-coord-"));
    tempDirs.push(dir);
    return dir;
  }

  function sha256Hex(content: string | Buffer): string {
    return createHash("sha256").update(content).digest("hex");
  }

  function makeVideoFile(dir: string, name = "sample.mp4", content = "synthetic-video-frames"): { path: string; hash: string } {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    return { path: filePath, hash: sha256Hex(content) };
  }

  beforeEach(() => {
    testDir = makeTempDir();
    const media = makeVideoFile(testDir, "original.mp4", "test-video-source-bytes");
    testMedia = {
      path: media.path,
      hash: media.hash,
      durationUs: 60_000_000,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createMockConnector(overrides: Partial<VideoReasoningResult> = {}): {
    connector: VideoReasoningConnector;
    calls: VideoReasoningRequest[];
  } {
    const calls: VideoReasoningRequest[] = [];
    const connector: VideoReasoningConnector = async (req, context) => {
      calls.push(req);
      if (context?.onBeforeSubmit) {
        await context.onBeforeSubmit();
      }
      const sourceRangeUs = req.source.rangeUs ?? [0, req.source.sourceDurationUs];
      const requestHash = computeVideoReasoningRequestHash(req, sourceRangeUs);
      const defaultResult: VideoReasoningResult = {
        outcome: "completed",
        summary: "Clear moment found.",
        observations: [
          {
            startUs: 10_000_000,
            endUs: 15_000_000,
            label: "target_moment",
            rationale: "Subject becomes clearly visible.",
            confidence: 0.9,
            localVerification: "not_run",
          },
        ],
        diagnostic: {
          provider: "gemini",
          connectorVersion: "gemini-agentic-video-v1.1",
          contractVersion: "video-reasoning/v1",
          responseSchemaVersion: "video-reasoning-response/v1",
          requestHash,
          promptHash: sha256Hex(req.prompt),
          sourceAssetId: req.source.assetId,
          sourceContentSha256: req.source.sourceContentSha256,
          submittedMediaContentSha256: req.source.submittedMediaContentSha256 ?? req.source.sourceContentSha256,
          sourceRangeUs,
          inputKind: req.input.kind,
          mimeType: req.input.mimeType,
          model: req.model,
          task: req.task,
          processingRequested: "agentic",
          storeRequested: false,
          agenticUsed: true,
          processingCallCount: 1,
          processingResultCount: 1,
          matchedProcessingPairCount: 1,
          submitted: true,
          outcome: "completed",
          errorCode: "none",
          elapsedMs: 250,
          providerRequestId: "req-provider-001",
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
          },
        },
      };

      const customDiagnostic = overrides.diagnostic;
      return {
        ...defaultResult,
        ...overrides,
        diagnostic: {
          ...defaultResult.diagnostic,
          ...customDiagnostic,
          requestHash: customDiagnostic?.requestHash ?? requestHash,
        },
      };
    };

    return { connector, calls };
  }

  describe("Contract 1: Deterministic M2 router priority and 0-cost gating", () => {
    it("never calls connector and consumes 0 paid ledger on default local_only", async () => {
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          prompt: "Find key moment.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          privacy: "local_only",
          marlin: { available: true, confidence: 0.85, coverage: 0.9, degraded: false },
        },
        { connector, ledger },
      );

      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("routed_local");
      expect(result.routeDecision.decision).toBe("local");
      expect(calls.length).toBe(0);
      expect(result.summary.route.decision).toBe("local");
      expect(result.summary.ledger.decision).toBe("not_reserved");
      expect(ledger.load().entries.length).toBe(0);
    });

    it("never calls connector and consumes 0 paid ledger when cloud consent is missing", async () => {
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find key moment.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          privacy: "bounded_derivative",
          consentCloudUpload: false, // missing operator consent
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        },
        { connector, ledger },
      );

      expect(result.ok).toBe(false);
      expect(result.routeDecision.decision).not.toBe("agentic");
      expect(calls.length).toBe(0);
      expect(ledger.load().entries.length).toBe(0);
    });

    it("never calls connector and consumes 0 paid ledger when project-scoped opt-in is missing", async () => {
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: false, // missing project opt-in gate
          prompt: "Find key moment.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          privacy: "bounded_derivative",
          consentCloudUpload: true, // operator consented, but project did not
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        },
        { connector, ledger },
      );

      expect(result.ok).toBe(false);
      expect(result.routeDecision.decision).not.toBe("agentic");
      expect(calls.length).toBe(0);
      expect(ledger.load().entries.length).toBe(0);
    });

    it("never calls connector when budget requests is exhausted (0)", async () => {
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find key moment.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          privacy: "bounded_derivative",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
          budget: {
            remainingRequests: 0,
          },
        },
        { connector, ledger },
      );

      expect(result.ok).toBe(false);
      expect(result.routeDecision.decision).not.toBe("agentic");
      expect(calls.length).toBe(0);
      expect(ledger.load().entries.length).toBe(0);
    });

    it("routes to local when provider capability is omitted (fail-closed default)", async () => {
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Check subject presence.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          privacy: "bounded_derivative",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          marlin: { available: true, confidence: 0.85, coverage: 0.9, degraded: false },
          // providerCapability is omitted! Must fail closed!
        },
        { connector, ledger },
      );

      expect(result.routeDecision.decision).toBe("local");
      expect(result.routeDecision.reasonCodes).toContain("agentic_capability_unavailable");
      expect(calls.length).toBe(0);
      expect(ledger.load().entries.length).toBe(0);
    });
  });

  describe("Contract 2: Explicit agentic route, private registry, and ledger lifecycle", () => {
    it("invokes connector exactly once, manages ledger lifecycle, and normalizes evidence", async () => {
      const derivative = makeVideoFile(testDir, "proxy.mp4", "derivative-video-bytes");
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find the strongest reveal.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            submittedMediaContentSha256: derivative.hash,
            sourceDurationUs: testMedia.durationUs,
            rangeUs: [0, 30_000_000],
          },
          input: {
            kind: "inline",
            path: derivative.path,
            mimeType: "video/mp4",
          },
          privacy: "bounded_derivative",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        },
        { connector, ledger },
      );

      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("completed");
      expect(calls.length).toBe(1);

      // Ledger check: exactly 1 entry, completed, reusable
      const entries = ledger.load().entries;
      expect(entries.length).toBe(1);
      expect(entries[0].status).toBe("completed");
      expect(entries[0].outcome).toBe("completed");
      expect(entries[0].reusable).toBe(true);
      expect(entries[0].reservation).toBe("none");

      // Evidence normalization check: M3a derived evidence artifact
      expect(result.evidenceArtifact).toBeDefined();
      expect(result.evidenceArtifact?.artifact_version).toBe("video-reasoning-evidence/v1");
      expect(result.evidenceArtifact?.authority).toBe("derived_evidence_only");
      expect(result.evidenceArtifact?.observations.length).toBe(1);

      // Check summary reflects completed state
      expect(result.summary.ledger.allowed).toBe(true);
      expect(result.summary.ledger.status).toBe("completed");
      expect(result.summary.execution?.outcome).toBe("completed");
      expect(result.summary.evidence?.observationCount).toBe(1);
    });

    it("resolves provider URI from private registry when unexpired and ready", async () => {
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);
      const providerScope = { projectId: "project-alpha", accountId: "account-alpha" } as const;
      const registryIdentity = {
        sourceContentSha256: testMedia.hash,
        submittedMediaContentSha256: testMedia.hash,
        derivative: null,
        providerScope,
        mimeType: "video/mp4",
      };

      // Record a valid ready file in the project's private registry
      recordGeminiFileReady(testDir, {
        ...registryIdentity,
        providerFileId: "files/reg-12345",
        providerUri: "https://generativelanguage.googleapis.com/v1beta/files/reg-12345",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find the strongest reveal.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          input: {
            kind: "provider_uri",
            uri: "",
            mimeType: "video/mp4",
          },
          registryLookup: {
            registryKey: computeGeminiFileRegistryKey(registryIdentity),
            provider: "gemini",
            derivativeSpec: null,
            providerScope,
          },
          privacy: "source_allowed",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        },
        { connector, ledger },
      );

      expect(result.ok).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0].input.kind).toBe("provider_uri");
      // Verify provider URI was resolved internally from registry
      expect((calls[0].input as { uri: string }).uri).toContain("files/reg-12345");

      // Verify summary does NOT disclose the provider URI
      const summaryJson = JSON.stringify(result.summary);
      expect(summaryJson).not.toContain("https://generativelanguage.googleapis.com");
      expect(summaryJson).not.toContain("files/reg-12345");
    });

    it("refuses agentic route and consumes 0 ledger when registry file is expired or missing", async () => {
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);
      const providerScope = { projectId: "project-alpha", accountId: "account-alpha" } as const;
      const registryIdentity = {
        sourceContentSha256: testMedia.hash,
        submittedMediaContentSha256: testMedia.hash,
        derivative: null,
        providerScope,
        mimeType: "video/mp4",
      };

      // Record an EXPIRED file in the private registry
      recordGeminiFileReady(testDir, {
        ...registryIdentity,
        providerFileId: "files/expired-123",
        providerUri: "https://generativelanguage.googleapis.com/v1beta/files/expired-123",
        expiresAt: new Date(Date.now() - 3600000).toISOString(), // expired 1 hour ago
      });

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find the strongest reveal.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          input: {
            kind: "provider_uri",
            uri: "",
            mimeType: "video/mp4",
          },
          registryLookup: {
            registryKey: computeGeminiFileRegistryKey(registryIdentity),
            provider: "gemini",
            derivativeSpec: null,
            providerScope,
          },
          privacy: "source_allowed",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        },
        { connector, ledger },
      );

      expect(result.ok).toBe(false);
      expect(calls.length).toBe(0);
      expect(ledger.load().entries.length).toBe(0);
    });

    it("resolves a bounded derivative only with exact key, scope, source, and submitted identity", async () => {
      const derivative = makeVideoFile(testDir, "registry-proxy.mp4", "registry-derivative-bytes");
      const providerScope = { projectId: "project-alpha", accountId: "account-alpha" } as const;
      const derivativeSpec = { profile: "proxy-v1", maxDurationUs: 30_000_000 } as const;
      const registryIdentity = {
        sourceContentSha256: testMedia.hash,
        submittedMediaContentSha256: derivative.hash,
        derivative: derivativeSpec,
        mimeType: "video/mp4",
        providerScope,
      };
      recordGeminiFileReady(testDir, {
        ...registryIdentity,
        providerUri: "https://generativelanguage.googleapis.com/v1beta/files/bounded-123",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning({
        projectDir: testDir,
        projectOptIn: true,
        prompt: "Find the strongest reveal.",
        source: {
          assetId: "AST_001",
          sourceContentSha256: testMedia.hash,
          submittedMediaContentSha256: derivative.hash,
          sourceDurationUs: testMedia.durationUs,
          rangeUs: [0, 30_000_000],
        },
        input: { kind: "provider_uri", uri: "", mimeType: "video/mp4" },
        registryLookup: {
          registryKey: computeGeminiFileRegistryKey(registryIdentity),
          provider: "gemini",
          derivativeSpec,
          providerScope,
        },
        privacy: "bounded_derivative",
        consentCloudUpload: true,
        temporalReasoningRequired: true,
        providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
      }, { connector, ledger });

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].source.submittedMediaContentSha256).toBe(derivative.hash);
    });

    it("keeps connector and paid ledger at 0 for every invalid registry binding", async () => {
      const sourceHash = testMedia.hash;
      const submittedHash = sha256Hex("matrix-derivative-bytes");
      const otherSourceHash = sha256Hex("other-source-bytes");
      const providerScope = { projectId: "project-alpha", accountId: "account-alpha" } as const;
      const otherScope = { projectId: "project-beta", accountId: "account-alpha" } as const;
      const derivativeSpec = { profile: "proxy-v1", maxDurationUs: 30_000_000 } as const;
      const otherDerivativeSpec = { profile: "proxy-v2", maxDurationUs: 30_000_000 } as const;
      const validIdentity = {
        sourceContentSha256: sourceHash,
        submittedMediaContentSha256: submittedHash,
        derivative: derivativeSpec,
        mimeType: "video/mp4",
        providerScope,
      };
      const validKey = computeGeminiFileRegistryKey(validIdentity);
      const cases = [
        { name: "missing key", lookup: { provider: "gemini", derivativeSpec, providerScope } },
        { name: "mismatched key", lookup: { registryKey: `sha256:${"f".repeat(64)}`, provider: "gemini", derivativeSpec, providerScope } },
        { name: "missing entry", lookup: { registryKey: validKey, provider: "gemini", derivativeSpec, providerScope }, record: false },
        { name: "wrong provider", lookup: { registryKey: validKey, provider: "other", derivativeSpec, providerScope } },
        { name: "missing project/account scope", lookup: { registryKey: validKey, provider: "gemini", derivativeSpec, providerScope: "project-alpha" } },
        { name: "wrong scope", lookup: { registryKey: validKey, provider: "gemini", derivativeSpec, providerScope: otherScope } },
        { name: "missing derivative", lookup: { registryKey: validKey, provider: "gemini", providerScope } },
        { name: "wrong derivative", lookup: { registryKey: validKey, provider: "gemini", derivativeSpec: otherDerivativeSpec, providerScope } },
        {
          name: "wrong submitted derivative identity",
          lookup: { registryKey: validKey, provider: "gemini", derivativeSpec, providerScope },
          requestSubmittedHash: sha256Hex("different-derivative-bytes"),
        },
        {
          name: "wrong source",
          lookup: {
            registryKey: computeGeminiFileRegistryKey({ ...validIdentity, sourceContentSha256: otherSourceHash }),
            provider: "gemini",
            derivativeSpec,
            providerScope,
          },
        },
        { name: "raw provider URI", lookup: { registryKey: validKey, provider: "gemini", derivativeSpec, providerScope }, rawUri: "gs://raw/video.mp4" },
      ] as const;

      for (const scenario of cases) {
        const projectDir = makeTempDir();
        if (!("record" in scenario) || scenario.record !== false) {
          recordGeminiFileReady(projectDir, {
            ...validIdentity,
            providerUri: "https://generativelanguage.googleapis.com/v1beta/files/matrix-123",
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          });
        }
        const { connector, calls } = createMockConnector();
        const ledger = createVideoReasoningRequestLedger(projectDir);
        const result = await coordinateVideoReasoning({
          projectDir,
          projectOptIn: true,
          prompt: "Find the strongest reveal.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: sourceHash,
            submittedMediaContentSha256: "requestSubmittedHash" in scenario
              ? scenario.requestSubmittedHash
              : submittedHash,
            sourceDurationUs: testMedia.durationUs,
            rangeUs: [0, 30_000_000],
          },
          input: { kind: "provider_uri", uri: "rawUri" in scenario ? scenario.rawUri : "", mimeType: "video/mp4" },
          registryLookup: scenario.lookup,
          privacy: "bounded_derivative",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        }, { connector, ledger });

        expect(calls, scenario.name).toHaveLength(0);
        expect(ledger.load().entries, scenario.name).toHaveLength(0);
        expect(result.summary.ledger.decision, scenario.name).toBe("not_reserved");
      }
    });

    it("rejects a project-only registry entry whose account scope normalized to unspecified", async () => {
      const derivativeHash = sha256Hex("project-only-derivative");
      const derivativeSpec = { profile: "proxy-v1", maxDurationUs: 30_000_000 } as const;
      const projectOnlyIdentity = {
        sourceContentSha256: testMedia.hash,
        submittedMediaContentSha256: derivativeHash,
        derivative: derivativeSpec,
        mimeType: "video/mp4",
        providerScope: "project-alpha",
      };
      recordGeminiFileReady(testDir, {
        ...projectOnlyIdentity,
        providerUri: "https://generativelanguage.googleapis.com/v1beta/files/project-only-123",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning({
        projectDir: testDir,
        projectOptIn: true,
        prompt: "Find the strongest reveal.",
        source: {
          assetId: "AST_001",
          sourceContentSha256: testMedia.hash,
          submittedMediaContentSha256: derivativeHash,
          sourceDurationUs: testMedia.durationUs,
          rangeUs: [0, 30_000_000],
        },
        input: { kind: "provider_uri", uri: "", mimeType: "video/mp4" },
        registryLookup: {
          registryKey: computeGeminiFileRegistryKey(projectOnlyIdentity),
          provider: "gemini",
          derivativeSpec,
          providerScope: { projectId: "project-alpha", accountId: "unspecified" },
        },
        privacy: "bounded_derivative",
        consentCloudUpload: true,
        temporalReasoningRequired: true,
        providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
      }, { connector, ledger });

      expect(result.ok).toBe(false);
      expect(result.routeDecision.decision).not.toBe("agentic");
      expect(calls).toHaveLength(0);
      expect(result.summary.ledger.decision).toBe("not_reserved");
      expect(ledger.load().entries).toHaveLength(0);
    });

    it("does not fall back from bounded derivative to an original-source registry URI", async () => {
      const derivativeHash = sha256Hex("unregistered-derivative");
      const providerScope = { projectId: "project-alpha", accountId: "account-alpha" } as const;
      const originalIdentity = {
        sourceContentSha256: testMedia.hash,
        submittedMediaContentSha256: testMedia.hash,
        derivative: null,
        mimeType: "video/mp4",
        providerScope,
      };
      recordGeminiFileReady(testDir, {
        ...originalIdentity,
        providerUri: "https://generativelanguage.googleapis.com/v1beta/files/original-123",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning({
        projectDir: testDir,
        projectOptIn: true,
        prompt: "Find the strongest reveal.",
        source: {
          assetId: "AST_001",
          sourceContentSha256: testMedia.hash,
          submittedMediaContentSha256: derivativeHash,
          sourceDurationUs: testMedia.durationUs,
          rangeUs: [0, 30_000_000],
        },
        input: { kind: "provider_uri", uri: "", mimeType: "video/mp4" },
        registryLookup: {
          registryKey: computeGeminiFileRegistryKey(originalIdentity),
          provider: "gemini",
          derivativeSpec: { profile: "proxy-v1" },
          providerScope,
        },
        privacy: "bounded_derivative",
        consentCloudUpload: true,
        temporalReasoningRequired: true,
        providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
      }, { connector, ledger });

      expect(result.ok).toBe(false);
      expect(calls).toHaveLength(0);
      expect(ledger.load().entries).toHaveLength(0);
    });

    it("prevents duplicate active paid requests via ledger", async () => {
      const derivative = makeVideoFile(testDir, "proxy.mp4", "derivative-video-bytes-2");
      const { connector, calls } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const request: VideoReasoningCoordinatorRequest = {
        projectDir: testDir,
        projectOptIn: true,
        prompt: "Find the strongest reveal.",
        source: {
          assetId: "AST_001",
          sourceContentSha256: testMedia.hash,
          submittedMediaContentSha256: derivative.hash,
          sourceDurationUs: testMedia.durationUs,
          rangeUs: [0, 30_000_000],
        },
        input: {
          kind: "inline",
          path: derivative.path,
          mimeType: "video/mp4",
        },
        privacy: "bounded_derivative",
        consentCloudUpload: true,
        temporalReasoningRequired: true,
        providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
      };

      // Run 1: completed and reusable
      const run1 = await coordinateVideoReasoning(request, { connector, ledger });
      expect(run1.ok).toBe(true);
      expect(calls.length).toBe(1);

      // Second run: ledger sees duplicate completed and blocks re-running paid call
      const run2 = await coordinateVideoReasoning(request, { connector, ledger });
      expect(run2.ok).toBe(false);
      expect(run2.outcome).toBe("ledger_blocked");
      expect(run2.summary.ledger.allowed).toBe(false);
      expect(calls.length).toBe(1); // connector was NOT called again!
    });
  });

  describe("Contract 3: Submitted boundary, normalization truth, and fail-open", () => {
    it("releases reservation on pre-submit throw without marking submitted", async () => {
      const derivative = makeVideoFile(testDir, "proxy.mp4", "derivative-presubmit-throw");
      const connector: VideoReasoningConnector = async () => {
        // Throws BEFORE calling onBeforeSubmit
        throw new Error("local payload assembly failed");
      };
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find key moment.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            submittedMediaContentSha256: derivative.hash,
            sourceDurationUs: testMedia.durationUs,
            rangeUs: [0, 30_000_000],
          },
          input: {
            kind: "inline",
            path: derivative.path,
            mimeType: "video/mp4",
          },
          privacy: "bounded_derivative",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        },
        { connector, ledger },
      );

      expect(result.ok).toBe(false);
      expect(result.outcome).toBe("rejected");

      // Ledger: reservation released, retryable true, not charged!
      const entries = ledger.load().entries;
      expect(entries.length).toBe(1);
      expect(entries[0].status).toBe("released");
      expect(entries[0].reservation).toBe("none");
      expect(entries[0].retryable).toBe(true);
    });

    it.each(["invalid_transition", "ledger_busy", "malformed_state", "not_found", "submitted"] as const)(
      "blocks transport when the submitted transition returns %s",
      async (decision) => {
        const derivative = makeVideoFile(testDir, "proxy.mp4", `derivative-${decision}`);
        const ledger = createVideoReasoningRequestLedger(testDir);
        let transportCalls = 0;
        const connector: VideoReasoningConnector = async (_request, context) => {
          await context?.onBeforeSubmit?.();
          transportCalls += 1;
          throw new Error("transport must not execute");
        };
        const submittedSpy = vi.spyOn(ledger, "recordSubmitted").mockImplementation((reference) => ({
          decision,
          action: decision === "not_found" ? "recorded" : "blocked",
          allowed: false,
          requestId: String(reference),
          ledgerPath: ledger.path,
          reason: `forced_${decision}`,
        }));
        const releaseSpy = vi.spyOn(ledger, "releaseBeforeSubmit");

        const result = await coordinateVideoReasoning({
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find key moment.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            submittedMediaContentSha256: derivative.hash,
            sourceDurationUs: testMedia.durationUs,
            rangeUs: [0, 30_000_000],
          },
          input: { kind: "inline", path: derivative.path, mimeType: "video/mp4" },
          privacy: "bounded_derivative",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        }, { connector, ledger });

        expect(submittedSpy).toHaveBeenCalledOnce();
        expect(transportCalls).toBe(0);
        expect(releaseSpy).toHaveBeenCalledOnce();
        expect(result.outcome).toBe("rejected");
        expect(result.summary.execution).toMatchObject({
          outcome: "rejected",
          errorCode: "pre_submit_error",
          submitted: false,
        });
        expect(result.summary.ledger).toMatchObject({ decision: "released", allowed: false });
        expect(ledger.load().entries).toHaveLength(1);
        expect(ledger.load().entries[0].status).toBe("released");
      },
    );

    it("reports the actual release failure without claiming the request was submitted or released", async () => {
      const derivative = makeVideoFile(testDir, "proxy.mp4", "derivative-release-failure");
      const ledger = createVideoReasoningRequestLedger(testDir);
      let transportCalls = 0;
      const connector: VideoReasoningConnector = async (_request, context) => {
        await context?.onBeforeSubmit?.();
        transportCalls += 1;
        throw new Error("transport must not execute");
      };
      vi.spyOn(ledger, "recordSubmitted").mockReturnValue({
        decision: "ledger_busy",
        action: "blocked",
        allowed: false,
        requestId: null,
        ledgerPath: ledger.path,
        reason: "private_state_busy",
      });
      vi.spyOn(ledger, "releaseBeforeSubmit").mockReturnValue({
        decision: "malformed_state",
        action: "blocked",
        allowed: false,
        requestId: null,
        ledgerPath: ledger.path,
        reason: "private_state_malformed",
      });

      const result = await coordinateVideoReasoning({
        projectDir: testDir,
        projectOptIn: true,
        prompt: "Find key moment.",
        source: {
          assetId: "AST_001",
          sourceContentSha256: testMedia.hash,
          submittedMediaContentSha256: derivative.hash,
          sourceDurationUs: testMedia.durationUs,
          rangeUs: [0, 30_000_000],
        },
        input: { kind: "inline", path: derivative.path, mimeType: "video/mp4" },
        privacy: "bounded_derivative",
        consentCloudUpload: true,
        temporalReasoningRequired: true,
        providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
      }, { connector, ledger });

      expect(transportCalls).toBe(0);
      expect(result.summary.execution?.submitted).toBe(false);
      expect(result.summary.ledger).toMatchObject({
        decision: "malformed_state",
        allowed: false,
      });
      expect(result.summary.ledger.status).toBeUndefined();
    });

    it("records unknown and retains active reservation when transport fails after onBeforeSubmit", async () => {
      const derivative = makeVideoFile(testDir, "proxy.mp4", "derivative-postsubmit-throw");
      const connector: VideoReasoningConnector = async (_req, context) => {
        // Calls onBeforeSubmit to commit submitted transition
        if (context?.onBeforeSubmit) {
          await context.onBeforeSubmit();
        }
        // Then transport crashes/times out
        throw new Error("ETIMEDOUT: network transport dropped");
      };
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find key moment.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            submittedMediaContentSha256: derivative.hash,
            sourceDurationUs: testMedia.durationUs,
            rangeUs: [0, 30_000_000],
          },
          input: {
            kind: "inline",
            path: derivative.path,
            mimeType: "video/mp4",
          },
          privacy: "bounded_derivative",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        },
        { connector, ledger },
      );

      expect(result.ok).toBe(false);
      expect(result.outcome).toBe("unknown");

      // Ledger: status unknown, reservation remains active!
      const entries = ledger.load().entries;
      expect(entries[0].status).toBe("unknown");
      expect(entries[0].outcome).toBe("unknown");
      expect(entries[0].reservation).toBe("active");
      expect(entries[0].retryable).toBe(false);
    });

    it("treats M3a normalization failure as truthful non-reusable failure (no false success)", async () => {
      const derivative = makeVideoFile(testDir, "proxy.mp4", "derivative-norm-fail");
      // Provider completes normally, but normalization throws an error
      const { connector } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const faultyNormalizer = () => {
        throw new Error("malformed observation timestamps in provider payload");
      };

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find key moment.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            submittedMediaContentSha256: derivative.hash,
            sourceDurationUs: testMedia.durationUs,
            rangeUs: [0, 30_000_000],
          },
          input: {
            kind: "inline",
            path: derivative.path,
            mimeType: "video/mp4",
          },
          privacy: "bounded_derivative",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        },
        { connector, ledger, normalizeEvidence: faultyNormalizer },
      );

      expect(result.ok).toBe(false);
      expect(result.outcome).toBe("failed");
      expect(result.evidenceArtifact).toBeUndefined();

      // Ledger must NOT be completed or reusable! Must be truthful failure!
      const entries = ledger.load().entries;
      expect(entries.length).toBe(1);
      expect(entries[0].status).toBe("failed");
      expect(entries[0].outcome).toBe("failed");
      expect(entries[0].failureClass).toBe("normalization_failed");
      expect(entries[0].reusable).toBe(false);
      expect(entries[0].retryable).toBe(true);

      // Summary must reflect failure truthfully
      expect(result.summary.execution?.outcome).toBe("failed");
      expect(result.summary.execution?.errorCode).toBe("normalization_failed");
    });
  });

  describe("Contract 4: Local verification source separation and disagreement routing", () => {
    it("reports source_unavailable when local-source path does not exist", async () => {
      const { connector } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find the strongest reveal.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          input: {
            kind: "inline",
            path: testMedia.path,
            mimeType: "video/mp4",
          },
          privacy: "source_allowed",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
          localVerification: {
            sourcePath: path.join(testDir, "non_existent_source.mp4"),
            enabled: true,
          },
        },
        { connector, ledger },
      );

      expect(result.summary.localVerification?.verificationStatus).toBe("source_unavailable");
      expect(result.summary.localVerification?.rationaleCode).toBe("source_file_missing");
      expect(result.disagreementResult?.review_required).toBe(true);
      expect(result.disagreementResult?.timeline_authority).toBe("none");
    });

    it("reports source_mismatch when local-source SHA-256 does not match sourceContentSha256", async () => {
      const wrongSource = makeVideoFile(testDir, "wrong_source.mp4", "wrong-bytes-here");
      const { connector } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find the strongest reveal.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          input: {
            kind: "inline",
            path: testMedia.path,
            mimeType: "video/mp4",
          },
          privacy: "source_allowed",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
          localVerification: {
            sourcePath: wrongSource.path, // Hash does NOT match sourceContentSha256!
            enabled: true,
          },
        },
        { connector, ledger },
      );

      expect(result.summary.localVerification?.verificationStatus).toBe("source_mismatch");
      expect(result.summary.localVerification?.rationaleCode).toBe("source_hash_mismatch");
      expect(result.disagreementResult?.review_required).toBe(true);
      expect(result.disagreementResult?.timeline_authority).toBe("none");
    });

    it("runs local verification seam when valid sourcePath and assessor are provided", async () => {
      const { connector } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const denseFrameRunner = vi.fn(async (req) => {
        fs.mkdirSync(path.dirname(req.output_path), { recursive: true });
        fs.writeFileSync(req.output_path, "fake-jpg-content");
      });

      const localFrameAssessor = vi.fn(() => ({
        outcome: "confirmed" as const,
        local_verified_range_us: [10_000_000, 15_000_000] as [number, number],
        rationale_code: "clear_visual_evidence",
        evidence_codes: ["person_enters_frame"],
      }));

      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find the strongest reveal.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          input: {
            kind: "inline",
            path: testMedia.path,
            mimeType: "video/mp4",
          },
          privacy: "source_allowed",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
          localVerification: {
            sourcePath: testMedia.path,
            enabled: true,
          },
        },
        { connector, ledger, denseFrameRunner, localFrameAssessor },
      );

      expect(result.ok).toBe(true);
      expect(result.localVerificationArtifact).toBeDefined();
      expect(result.localVerificationArtifact?.verification_status).toBe("verified");
      expect(result.disagreementResult?.timeline_authority).toBe("none");
    });

    it.each([
      {
        name: "unavailable extraction",
        outcome: "inconclusive" as const,
        frameStatus: "unavailable" as const,
        rationale: "ffmpeg_unavailable",
        expectedStatus: "unavailable" as const,
        localRange: null,
      },
      {
        name: "assessor absent",
        outcome: "inconclusive" as const,
        frameStatus: "complete" as const,
        rationale: "assessor_not_provided",
        expectedStatus: "inconclusive" as const,
        localRange: null,
      },
      {
        name: "assessor failed",
        outcome: "inconclusive" as const,
        frameStatus: "complete" as const,
        rationale: "assessor_failed",
        expectedStatus: "inconclusive" as const,
        localRange: null,
      },
      {
        name: "adjusted range",
        outcome: "adjusted" as const,
        frameStatus: "complete" as const,
        rationale: "adjusted_by_local_frames",
        expectedStatus: "supports" as const,
        localRange: [10_000_000, 14_000_000] as [number, number],
      },
    ])("maps M3b $name into the disagreement router contract", async (scenario) => {
      const { connector } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);
      let routedInput: RouteVideoReasoningDisagreementInput | undefined;

      const result = await coordinateVideoReasoning({
        projectDir: testDir,
        projectOptIn: true,
        prompt: "Find the strongest reveal.",
        source: {
          assetId: "AST_001",
          sourceContentSha256: testMedia.hash,
          sourceDurationUs: testMedia.durationUs,
        },
        input: { kind: "inline", path: testMedia.path, mimeType: "video/mp4" },
        privacy: "source_allowed",
        consentCloudUpload: true,
        temporalReasoningRequired: true,
        providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        localVerification: { sourcePath: testMedia.path, enabled: true },
      }, {
        connector,
        ledger,
        verifyLocally: async (provider): Promise<VideoReasoningLocalVerificationArtifact> => {
          const observation = provider.observations[0];
          const failureCodes = scenario.frameStatus === "unavailable" ? ["ffmpeg_unavailable" as const] : [];
          return {
            artifact_id: `VLRV_${"a".repeat(64)}`,
            artifact_version: "video-reasoning-local-verification/v1",
            artifact_kind: "derived_local_verification",
            authority: "derived_evidence_only",
            provider_evidence_artifact_id: provider.artifact_id,
            provider_evidence_artifact_sha256: "b".repeat(64),
            source: {
              asset_id: "AST_001",
              source_content_sha256: testMedia.hash,
              source_duration_us: testMedia.durationUs,
              effective_source_range_us: [0, testMedia.durationUs],
            },
            verification_status: scenario.frameStatus === "unavailable"
              ? "unavailable"
              : scenario.outcome === "adjusted" ? "verified" : "inconclusive",
            extraction: {
              tool: "ffmpeg",
              status: scenario.frameStatus,
              requested_frame_count: 3,
              decoded_frame_count: scenario.frameStatus === "unavailable" ? 0 : 3,
              failed_frame_count: scenario.frameStatus === "unavailable" ? 3 : 0,
              failure_codes: failureCodes,
            },
            records: [{
              provider_observation_id: observation.observation_id,
              asset_id: "AST_001",
              source_content_sha256: testMedia.hash,
              source_duration_us: testMedia.durationUs,
              effective_source_range_us: [0, testMedia.durationUs],
              provider_requested_range_us: [0, testMedia.durationUs],
              provider_candidate_range_us: [...observation.provider_range_us],
              local_verification_window_us: [9_500_000, 15_500_000],
              local_frame_timestamps_us: scenario.frameStatus === "unavailable" ? [] : [10_000_000, 12_000_000, 15_000_000],
              local_verified_range_us: scenario.localRange,
              outcome: scenario.outcome,
              rationale_code: scenario.rationale,
              assessor_evidence_codes: scenario.outcome === "adjusted" ? ["range_adjusted"] : [],
              planned_frame_count: 3,
              frame_extraction_status: scenario.frameStatus,
              frame_extraction_failure_codes: failureCodes,
            }],
          };
        },
        routeDisagreement: (input) => {
          routedInput = input;
          return routeVideoReasoningDisagreement(input);
        },
      });

      expect(result.ok).toBe(true);
      const localSignal = routedInput?.signals.find((signal) => signal.source === "local");
      expect(localSignal?.status).toBe(scenario.expectedStatus);
      if (scenario.localRange) expect(localSignal?.range_us).toEqual(scenario.localRange);
      expect(result.disagreementResult?.timeline_authority).toBe("none");
    });
  });

  describe("Contract 5: Canonical artifacts immutability and privacy redaction", () => {
    it("never mutates timeline.json or canonical artifacts", async () => {
      const timelinePath = path.join(testDir, "timeline.json");
      const timelineContent = JSON.stringify({ version: "timeline/v1", tracks: [] });
      fs.writeFileSync(timelinePath, timelineContent);

      const { connector } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: "Find the strongest reveal.",
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          input: {
            kind: "inline",
            path: testMedia.path,
            mimeType: "video/mp4",
          },
          privacy: "source_allowed",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        },
        { connector, ledger },
      );

      expect(fs.readFileSync(timelinePath, "utf8")).toBe(timelineContent);
    });

    it("ensures summary JSON contains no absolute paths, raw prompt, credentials, or provider URIs", async () => {
      const { connector } = createMockConnector();
      const ledger = createVideoReasoningRequestLedger(testDir);

      const secretRawPrompt = "SUPER_SECRET_RAW_PROMPT_CONTENT_XYZ";
      const result = await coordinateVideoReasoning(
        {
          projectDir: testDir,
          projectOptIn: true,
          prompt: secretRawPrompt,
          source: {
            assetId: "AST_001",
            sourceContentSha256: testMedia.hash,
            sourceDurationUs: testMedia.durationUs,
          },
          input: {
            kind: "inline",
            path: testMedia.path,
            mimeType: "video/mp4",
          },
          privacy: "source_allowed",
          consentCloudUpload: true,
          temporalReasoningRequired: true,
          providerCapability: { staticVlmAvailable: true, agenticAvailable: true, agenticModelSupported: true },
        },
        { connector, ledger },
      );

      const summaryStr = JSON.stringify(result.summary);
      expect(summaryStr).not.toContain(secretRawPrompt);
      expect(summaryStr).not.toContain(testMedia.path);
      expect(summaryStr).not.toContain("/Users/");
      expect(summaryStr).not.toContain("api_key");
      expect(summaryStr).not.toContain("https://");
    });
  });

  describe("Contract 6: CLI parsing, help, and JSON stdout purity", () => {
    it("handles --help without error and exits 0", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = await cliMain(["node", "script", "--help"]);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalled();
    });

    it("rejects invalid arguments and exits 1 without path disclosure", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const code = await cliMain(["node", "script", "--invalid-flag"]);
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[agentic-video:request] invalid arguments"),
      );
    });

    it("rejects raw --uri and requires private registry resolution", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const code = await cliMain([
        "node",
        "script",
        "--uri",
        "gs://raw-bucket/video.mp4",
        "--asset-id",
        "AST_001",
        "--duration-us",
        "1000000",
        "--prompt",
        "test",
      ]);
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[agentic-video:request] invalid arguments"),
      );
    });

    it("fails closed without synthetic capability evidence and keeps CLI stdout pure JSON", () => {
      const derivative = makeVideoFile(testDir, "cli-proxy.mp4", "cli-derivative-bytes");
      const cliArgv = [
        "node",
        "script",
        "--video",
        derivative.path,
        "--asset-id",
        "AST_PURE_JSON",
        "--duration-us",
        String(testMedia.durationUs),
        "--source-sha256",
        testMedia.hash,
        "--prompt",
        "Find key moment.",
        "--project",
        testDir,
        "--privacy",
        "bounded_derivative",
        "--project-opt-in",
        "--consent-cloud-upload",
        "--temporal-reasoning",
      ];
      const builtRequest = cliBuildRequest(cliParseArgs(cliArgv));
      expect(builtRequest.providerCapability).toBeUndefined();
      expect(builtRequest.marlin).toBeUndefined();

      const subprocess = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/agentic-video-request.ts",
          ...cliArgv.slice(2),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: process.env.PATH },
        },
      );
      const rawStdout = subprocess.stdout;

      // stdout MUST be pure JSON with NO dotenv banner or extra logs
      expect(subprocess.status).toBe(2);
      expect(rawStdout.trim().startsWith("{")).toBe(true);
      expect(rawStdout.trim().endsWith("}")).toBe(true);
      expect(rawStdout).not.toContain("[dotenv@");

      const parsed = JSON.parse(rawStdout.trim());
      expect(parsed.version).toBe("video-reasoning-coordinator-summary/v1");
      expect(parsed.assetId).toBe("AST_PURE_JSON");
      expect(parsed.route.decision).not.toBe("agentic");
      expect(parsed.ledger.decision).toBe("not_reserved");
      expect(rawStdout).not.toContain(derivative.path);
      expect(rawStdout).not.toContain("Find key moment.");
      expect(fs.existsSync(path.join(testDir, ".video-os/private-cache/agentic-request-ledger.json"))).toBe(false);
    });
  });
});
