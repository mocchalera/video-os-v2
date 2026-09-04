import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  GEMINI_FILE_REGISTRY_RELATIVE_PATH,
  GEMINI_FILE_REGISTRY_VERSION,
  GeminiFileRegistryBusyError,
  computeGeminiFileRegistryKey,
  createGeminiVideoFileRegistry,
  geminiFileRegistryPath,
  inspectGeminiFileRegistry,
  loadGeminiFileRegistry,
  lookupGeminiFileRegistry,
  recordGeminiFileRegistryEntry,
  saveGeminiFileRegistry,
  type GeminiFileRegistryIdentityInput,
} from "../runtime/connectors/gemini-video-file-cache.js";
import * as ledgerApi from "../runtime/connectors/video-reasoning-ledger.js";
import {
  AGENTIC_REQUEST_LEDGER_RELATIVE_PATH,
  VIDEO_REASONING_LEDGER_VERSION,
  computeNormalizedPromptHash,
  computeVideoReasoningRequestIdentity,
  createVideoReasoningRequestLedger,
  loadVideoReasoningLedger,
  reserveVideoReasoningRequest,
  videoReasoningLedgerPath,
  type VideoReasoningRequestIdentityInput,
} from "../runtime/connectors/video-reasoning-ledger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function projectFixture(prefix = "video-reasoning-private-"): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(project);
  return project;
}

function runRepoHygiene(project: string): ReturnType<typeof spawnSync> {
  const tsxCli = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const hygieneScript = path.resolve(process.cwd(), "scripts/check-repo-hygiene.ts");
  return spawnSync(process.execPath, [tsxCli, hygieneScript], {
    cwd: project,
    encoding: "utf8",
  });
}

const NOW = "2026-09-03T00:00:00.000Z";

function fileIdentity(overrides: Partial<GeminiFileRegistryIdentityInput> = {}): GeminiFileRegistryIdentityInput {
  return {
    sourceContentSha256: "a".repeat(64),
    derivativeSpec: { profile: "proxy-v1", maxDurationUs: 30_000_000 },
    mimeType: "video/mp4",
    providerScope: { projectId: "project-alpha", accountId: "account-alpha" },
    ...overrides,
  };
}

function requestIdentity(overrides: Partial<VideoReasoningRequestIdentityInput> = {}): VideoReasoningRequestIdentityInput {
  return {
    sourceContentSha256: "b".repeat(64),
    effectiveSourceRangeUs: [1_000_000, 8_000_000],
    modelAliasOrSnapshot: "gemini-3.7-flash",
    processingMode: "agentic",
    prompt: "Find the strongest reveal.\r\nReturn bounded evidence.",
    promptContractVersion: "video-reasoning/v1",
    outputSchemaVersion: "video-reasoning-response/v1",
    ...overrides,
  };
}

describe("private Gemini File registry", () => {
  it("keeps root and nested private state files ignored after all later rules", () => {
    for (const relativePath of [
      ".video-os/private-cache/gemini-file-registry.json",
      ".video-os/private-cache/agentic-request-ledger.json",
      "projects/sample/.video-os/private-cache/gemini-file-registry.json",
      "projects/sample/.video-os/private-cache/agentic-request-ledger.json",
    ]) {
      expect(() => execFileSync("git", ["check-ignore", "-q", "--no-index", "--", relativePath], {
        cwd: process.cwd(),
      })).not.toThrow();
    }
  });

  it("rejects a tracked private-cache file through the repository hygiene guard", () => {
    const project = projectFixture("video-reasoning-hygiene-");
    const relativePath = ".video-os/private-cache/tracked-secret.json";
    fs.mkdirSync(path.join(project, path.dirname(relativePath)), { recursive: true });
    fs.writeFileSync(path.join(project, relativePath), "{}\n");
    execFileSync("git", ["init", "--quiet"], { cwd: project });
    execFileSync("git", ["add", "--", relativePath], { cwd: project });

    const result = runRepoHygiene(project);
    expect(result.status).toBe(1);
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toContain("tracked private provider state is not allowed");
  });

  it("uses a stable identity bound to source, derivative, MIME, and provider scope", () => {
    const first = computeGeminiFileRegistryKey(fileIdentity());
    const reordered = computeGeminiFileRegistryKey(fileIdentity({
      derivative: { maxDurationUs: 30_000_000, profile: "proxy-v1" },
      providerScope: { account: "account-alpha", project: "project-alpha" },
    }));

    expect(first).toBe(reordered);
    expect(computeGeminiFileRegistryKey(fileIdentity({ sourceContentSha256: "c".repeat(64) }))).not.toBe(first);
    expect(computeGeminiFileRegistryKey(fileIdentity({ derivativeSpec: { profile: "proxy-v2", maxDurationUs: 30_000_000 } }))).not.toBe(first);
    expect(computeGeminiFileRegistryKey(fileIdentity({ mimeType: "video/webm" }))).not.toBe(first);
    expect(computeGeminiFileRegistryKey(fileIdentity({
      providerScope: { projectId: "project-alpha", accountId: "account-beta" },
    }))).not.toBe(first);

    const stringScopedAccountA = computeGeminiFileRegistryKey(fileIdentity({
      providerScope: "project-alpha",
      providerAccount: "account-alpha",
    }));
    const stringScopedAccountB = computeGeminiFileRegistryKey(fileIdentity({
      providerScope: "project-alpha",
      providerAccount: "account-beta",
    }));
    expect(stringScopedAccountA).not.toBe(stringScopedAccountB);
    expect(stringScopedAccountA).toBe(computeGeminiFileRegistryKey(fileIdentity({
      providerScope: "project-alpha",
      providerProject: "project-alpha",
      providerAccount: "account-alpha",
    })));

    for (const conflicting of [
      fileIdentity({ providerScope: "project-alpha", providerProject: "project-beta" }),
      fileIdentity({ providerScope: { projectId: "project-alpha", project: "project-beta" } }),
      fileIdentity({ providerScope: { accountId: "account-alpha", account: "account-beta" } }),
      fileIdentity({ providerScope: { projectId: "project-alpha", accountId: "account-alpha" }, providerAccount: "account-beta" }),
      fileIdentity({ derivative: { profile: "proxy-v1" }, derivativeSpec: { profile: "proxy-v2" } }),
    ]) {
      expect(() => computeGeminiFileRegistryKey(conflicting)).toThrow();
    }
  });

  it("writes under the project-local private path and reuses only an unexpired ready entry", () => {
    const project = projectFixture();
    const registry = createGeminiVideoFileRegistry(project, { now: () => NOW });
    const written = registry.recordReady({
      ...fileIdentity(),
      providerFileName: "files/private-file-123",
      expiresAt: "2026-09-04T00:00:00.000Z",
      now: NOW,
    });

    expect(registry.path).toBe(path.join(project, GEMINI_FILE_REGISTRY_RELATIVE_PATH));
    expect(geminiFileRegistryPath(project)).toBe(registry.path);
    expect(written.entry.status).toBe("ready");
    expect(registry.lookup(fileIdentity())).toMatchObject({
      decision: "reuse",
      reason: "ready",
      reusable: true,
      entry: { providerFileName: "files/private-file-123" },
    });
    expect(fs.statSync(registry.path).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(loadGeminiFileRegistry(registry.path))).not.toContain("/private/");
    expect(fs.readdirSync(path.dirname(registry.path)).filter((name) => name.includes(".tmp-") || name.endsWith(".lock"))).toEqual([]);
  });

  it("misses every changed registry identity component and refuses expired or failed state", () => {
    const project = projectFixture();
    const registry = createGeminiVideoFileRegistry(project, { now: () => NOW });
    const identity = fileIdentity();
    registry.recordReady({
      ...identity,
      providerFileId: "file-123",
      expiresAt: "2026-09-02T23:59:59.000Z",
      now: NOW,
    });
    expect(registry.lookup(identity)).toMatchObject({ decision: "upload_required", reason: "state_expired" });

    for (const changed of [
      { sourceContentSha256: "c".repeat(64) },
      { derivativeSpec: { profile: "proxy-v2" } },
      { mimeType: "video/webm" },
      { providerScope: { projectId: "project-beta", accountId: "account-alpha" } },
    ]) {
      expect(registry.lookup({ ...identity, ...changed })).toMatchObject({ decision: "upload_required" });
    }

    registry.recordFailure({ ...identity, failureClass: "provider_unavailable", now: NOW });
    expect(registry.lookup(identity)).toMatchObject({ decision: "upload_required", reason: "failed" });
    registry.markUnusable({ ...identity, failureClass: "identifier_unusable", now: NOW });
    expect(registry.lookup(identity)).toMatchObject({ decision: "upload_required", reason: "unusable" });
  });

  it("fails closed on malformed private state without authorizing reuse or overwrite", () => {
    const project = projectFixture();
    const registry = createGeminiVideoFileRegistry(project, { now: () => NOW });
    const registryPath = geminiFileRegistryPath(project);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const malformed = JSON.stringify({
      version: GEMINI_FILE_REGISTRY_VERSION,
      entries: [{ rawPrompt: "must-not-be-retained" }],
    });
    fs.writeFileSync(registryPath, malformed);

    expect(registryPath).toBe(path.join(project, GEMINI_FILE_REGISTRY_RELATIVE_PATH));
    expect(registry.lookup(fileIdentity())).toMatchObject({
      decision: "blocked",
      reason: "malformed_state",
      reusable: false,
    });
    expect(inspectGeminiFileRegistry(project).state).toBe("malformed");
    expect(() => loadGeminiFileRegistry(registryPath)).toThrow();
    expect(() => registry.recordReady({
      ...fileIdentity(),
      providerFileId: "file-should-not-overwrite",
      expiresAt: "2026-09-04T00:00:00.000Z",
      now: NOW,
    })).toThrow();
    expect(fs.readFileSync(registryPath, "utf8")).toBe(malformed);
  });

  it("rejects arbitrary JSON paths instead of treating them as private project state", () => {
    const project = projectFixture();
    const arbitraryRegistryPath = path.join(project, "tracked-registry.json");
    const arbitraryLedgerPath = path.join(project, "tracked-ledger.json");

    expect(() => geminiFileRegistryPath(arbitraryRegistryPath)).toThrow();
    expect(() => loadGeminiFileRegistry(arbitraryRegistryPath)).toThrow();
    expect(() => lookupGeminiFileRegistry(arbitraryRegistryPath, fileIdentity())).toThrow();
    expect(() => saveGeminiFileRegistry(arbitraryRegistryPath, {
      version: GEMINI_FILE_REGISTRY_VERSION,
      entries: [],
    })).toThrow();
    expect(() => recordGeminiFileRegistryEntry(arbitraryRegistryPath, {
      ...fileIdentity(),
      providerFileId: "file-123",
      expiresAt: "2026-09-04T00:00:00.000Z",
      now: NOW,
    })).toThrow();

    expect(() => videoReasoningLedgerPath(arbitraryLedgerPath)).toThrow();
    expect(() => loadVideoReasoningLedger(arbitraryLedgerPath)).toThrow();
    expect(() => reserveVideoReasoningRequest(arbitraryLedgerPath, requestIdentity())).toThrow();
  });

  it("does not remove an owner registry lock when the contender and third caller are busy", () => {
    const project = projectFixture();
    const registry = createGeminiVideoFileRegistry(project, { now: () => NOW });
    const lockPath = `${registry.path}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "owner-lock\n", { mode: 0o600 });

    const record = () => registry.recordReady({
      ...fileIdentity(),
      providerFileId: "file-123",
      expiresAt: "2026-09-04T00:00:00.000Z",
      now: NOW,
    });
    expect(record).toThrow(GeminiFileRegistryBusyError);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(record).toThrow(GeminiFileRegistryBusyError);
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

describe("private video reasoning request ledger", () => {
  it("binds request identity to every required component and normalizes prompt formatting", () => {
    const first = computeVideoReasoningRequestIdentity(requestIdentity());
    const equivalent = computeVideoReasoningRequestIdentity(requestIdentity({
      prompt: "Find the strongest reveal.\nReturn bounded evidence.\n",
    }));
    expect(first.requestId).toBe(equivalent.requestId);
    expect(computeNormalizedPromptHash("e\u0301\r\n") ).toBe(computeNormalizedPromptHash("é\n"));

    const changedInputs: Array<Partial<VideoReasoningRequestIdentityInput>> = [
      { sourceContentSha256: "c".repeat(64) },
      { effectiveSourceRangeUs: [2_000_000, 8_000_000] },
      { modelAliasOrSnapshot: "gemini-3.6-flash" },
      { processingMode: "static" },
      { prompt: "Find a different moment." },
      { normalizedPromptHash: "c".repeat(64), prompt: undefined },
      { promptContractVersion: "video-reasoning/v2" },
      { outputSchemaVersion: "video-reasoning-response/v2" },
    ];
    for (const changed of changedInputs) {
      expect(computeVideoReasoningRequestIdentity({ ...requestIdentity(), ...changed }).requestId).not.toBe(first.requestId);
    }
    expect(first).not.toHaveProperty("prompt");
  });

  it("accepts equal compatibility aliases and rejects every conflicting identity alias", () => {
    const base = requestIdentity();
    const promptHash = computeNormalizedPromptHash(base.prompt!);
    const equivalent = computeVideoReasoningRequestIdentity({
      ...base,
      effectiveSourceRangeUs: [1_000_000, 8_000_000],
      sourceRangeUs: [1_000_000, 8_000_000],
      rangeUs: [1_000_000, 8_000_000],
      modelAliasOrSnapshot: "gemini-3.7-flash",
      model: "gemini-3.7-flash",
      modelAlias: "gemini-3.7-flash",
      modelSnapshot: "gemini-3.7-flash",
      processingMode: "agentic",
      processing: "agentic",
      normalizedPromptHash: promptHash,
      promptHash,
      promptContractVersion: "video-reasoning/v1",
      promptContract: "video-reasoning/v1",
      outputSchemaVersion: "video-reasoning-response/v1",
      outputSchema: "video-reasoning-response/v1",
    });
    expect(equivalent.requestId).toBe(computeVideoReasoningRequestIdentity(base).requestId);

    const conflictingAliases: Array<Partial<VideoReasoningRequestIdentityInput>> = [
      { effectiveSourceRangeUs: [1_000_000, 8_000_000], sourceRangeUs: [2_000_000, 8_000_000] },
      { modelAliasOrSnapshot: "gemini-3.7-flash", model: "gemini-3.6-flash" },
      { modelAlias: "gemini-3.7-flash", modelSnapshot: "gemini-3.6-flash" },
      { processingMode: "agentic", processing: "static" },
      { normalizedPromptHash: promptHash, promptHash: "c".repeat(64) },
      { promptContractVersion: "video-reasoning/v1", promptContract: "video-reasoning/v2" },
      { outputSchemaVersion: "video-reasoning-response/v1", outputSchema: "video-reasoning-response/v2" },
    ];
    for (const conflicting of conflictingAliases) {
      expect(() => computeVideoReasoningRequestIdentity({ ...base, ...conflicting })).toThrow();
    }
  });

  it("reserves once and returns deterministic duplicate decisions for active, submitted, and completed entries", () => {
    const project = projectFixture();
    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    const request = requestIdentity();
    const first = ledger.reserve(request);
    expect(first).toMatchObject({ decision: "reserved", action: "start", allowed: true });
    expect(ledger.reserve(request)).toMatchObject({ decision: "duplicate_active", action: "blocked", allowed: false });

    const requestId = first.requestId!;
    expect(ledger.recordSubmitted(requestId, { providerRequestId: "interaction-123" })).toMatchObject({ decision: "submitted" });
    expect(ledger.reserve(request)).toMatchObject({ decision: "duplicate_submitted", action: "blocked" });
    expect(ledger.complete(requestId)).toMatchObject({ decision: "completed", entry: { reusable: false } });
    expect(ledger.reserve(request)).toMatchObject({
      decision: "duplicate_completed",
      action: "blocked",
      allowed: false,
      reason: "completed_not_reusable",
    });

    const persisted = JSON.stringify(loadVideoReasoningLedger(ledger.path));
    expect(persisted).not.toContain("Find the strongest reveal");
    expect(persisted).not.toContain("/private/");
    expect(persisted).not.toContain("api-key");
    expect(ledger.path).toBe(path.join(project, AGENTIC_REQUEST_LEDGER_RELATIVE_PATH));
    expect(videoReasoningLedgerPath(project)).toBe(ledger.path);
    expect(loadVideoReasoningLedger(ledger.path).version).toBe(VIDEO_REASONING_LEDGER_VERSION);
  });

  it("does not expose a raw ledger save that can erase an active reservation", () => {
    const project = projectFixture();
    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    const request = requestIdentity();
    const first = ledger.reserve(request);
    expect(first).toMatchObject({ decision: "reserved", entry: { attempt: 1, status: "reserved" } });

    // The former raw replacement API is intentionally absent. An attempted
    // empty/raw save therefore cannot replace the lifecycle-owned history.
    expect(Reflect.get(ledgerApi, "saveVideoReasoningLedger")).toBeUndefined();
    expect(ledger.reserve(request)).toMatchObject({ decision: "duplicate_active", action: "blocked", allowed: false });
    expect(loadVideoReasoningLedger(ledger.path).entries).toHaveLength(1);
    expect(loadVideoReasoningLedger(ledger.path).entries[0]).toMatchObject({
      requestId: first.requestId,
      attempt: 1,
      status: "reserved",
    });
  });

  it("returns reuse only for completed results with a bounded result identity", () => {
    const project = projectFixture();
    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    const request = requestIdentity();
    const reservation = ledger.reserve(request);
    ledger.recordSubmitted(reservation.requestId!, { providerRequestId: "interaction-123" });

    expect(ledger.complete(reservation.requestId!, { reusable: true })).toMatchObject({
      decision: "invalid_request",
      allowed: false,
    });
    expect(ledger.inspect(request)).toMatchObject({ decision: "duplicate_submitted", action: "blocked" });

    const completed = ledger.complete(reservation.requestId!, {
      reusable: true,
      resultId: "result-123",
    });
    expect(completed).toMatchObject({ decision: "completed", entry: { reusable: true, resultId: "result-123" } });
    expect(ledger.reserve(request)).toMatchObject({
      decision: "duplicate_completed",
      action: "reuse",
      allowed: false,
      reason: "completed_reusable",
    });

    for (const expiresAt of ["2026-09-02T00:00:00.000Z", NOW, "2026-09-04T00:00:00.000Z"]) {
      const expiringProject = projectFixture();
      const expiringLedger = createVideoReasoningRequestLedger(expiringProject, { now: () => NOW });
      const expiringReservation = expiringLedger.reserve(requestIdentity());
      expiringLedger.recordSubmitted(expiringReservation.requestId!);
      expect(expiringLedger.complete(expiringReservation.requestId!, {
        reusable: true,
        resultId: "result-expiry-case",
        expiresAt,
      })).toMatchObject({ decision: "completed" });
      expect(expiringLedger.reserve(requestIdentity())).toMatchObject({
        decision: "duplicate_completed",
        action: expiresAt === "2026-09-04T00:00:00.000Z" ? "reuse" : "blocked",
        allowed: false,
        reason: expiresAt === "2026-09-04T00:00:00.000Z" ? "completed_reusable" : "completed_not_reusable",
      });
    }
  });

  it("records proven pre-submit release and permits a new attempt", () => {
    const project = projectFixture();
    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    const request = requestIdentity();
    const first = ledger.reserve(request);
    expect(ledger.releaseBeforeSubmit(first.requestId!, "local_preflight_failed")).toMatchObject({ decision: "released" });
    expect(ledger.inspect(request)).toMatchObject({ decision: "retry_allowed", reason: "proven_pre_submit_release" });
    const retry = ledger.reserve(request);
    expect(retry).toMatchObject({ decision: "retry_reserved", action: "retry", allowed: true, previousStatus: "released" });
    expect(retry.entry?.attempt).toBe(2);
  });

  it("keeps an unknown post-submit outcome reserved until explicit operator resolution", () => {
    const project = projectFixture();
    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    const request = requestIdentity();
    const reservation = ledger.reserve(request);
    ledger.recordSubmitted(reservation.requestId!, { providerRequestId: "interaction-unknown" });
    const unknown = ledger.recordUnknownPostSubmit(request);
    expect(unknown).toMatchObject({ decision: "unknown_recorded", allowed: true, entry: { status: "unknown", reservation: "active", retryable: false } });
    expect(ledger.reserve(request)).toMatchObject({ decision: "duplicate_unknown", action: "blocked", allowed: false });
    expect(ledger.complete(request)).toMatchObject({ decision: "operator_resolution_required", allowed: false });
    expect(ledger.fail(request, "provider_known_failure")).toMatchObject({ decision: "operator_resolution_required", allowed: false });

    const resolved = ledger.resolveUnknown(request, {
      action: "release_for_retry",
      actor: "operator-1",
      reason: "provider confirmed no request was submitted",
    });
    expect(resolved).toMatchObject({ decision: "resolved", allowed: true, entry: { status: "released", reservation: "none", retryable: true } });
    expect(ledger.reserve(request)).toMatchObject({ decision: "retry_reserved", previousStatus: "released" });
  });

  it("resolves a charged unknown request as completed but non-reusable when its result is unavailable", () => {
    const project = projectFixture();
    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    const request = requestIdentity();
    const reservation = ledger.reserve(request);
    ledger.recordSubmitted(reservation.requestId!, { providerRequestId: "interaction-charged" });
    ledger.recordUnknownPostSubmit(request);

    const resolved = ledger.resolveUnknown(request, {
      action: "mark_completed",
      actor: "operator-2",
      reason: "charged result unavailable",
      providerRequestId: "interaction-charged",
      reusable: false,
      usage: { estimatedUsd: 1.25 },
    });
    expect(resolved).toMatchObject({
      decision: "resolved",
      allowed: true,
      entry: { status: "completed", reusable: false, providerRequestId: "interaction-charged" },
    });
    expect(resolved.entry).not.toHaveProperty("resultId");
    expect(ledger.reserve(request)).toMatchObject({
      decision: "duplicate_completed",
      action: "blocked",
      allowed: false,
      reason: "completed_not_reusable",
    });
  });

  it("resolves an unknown request as reusable only with operator evidence and a bounded result identity", () => {
    const project = projectFixture();
    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    const request = requestIdentity();
    const reservation = ledger.reserve(request);
    ledger.recordSubmitted(reservation.requestId!, { providerRequestId: "interaction-recovered" });
    ledger.recordUnknownPostSubmit(request);

    expect(ledger.resolveUnknown(request, {
      action: "mark_completed",
      actor: "operator-3",
      reason: "result recovered",
      reusable: true,
    })).toMatchObject({ decision: "invalid_request", allowed: false });
    expect(ledger.reserve(request)).toMatchObject({ decision: "duplicate_unknown", action: "blocked" });

    expect(ledger.resolveUnknown(request, {
      action: "mark_completed",
      actor: "operator-3",
      reason: "malformed expiry rejected",
      resultId: "result-recovered-123",
      reusable: true,
      expiresAt: "not-a-date",
    })).toMatchObject({ decision: "invalid_request", allowed: false });
    expect(ledger.reserve(request)).toMatchObject({ decision: "duplicate_unknown", action: "blocked" });

    const resolved = ledger.resolveUnknown(request, {
      action: "mark_completed",
      actor: "operator-3",
      reason: "result recovered",
      providerRequestId: "interaction-recovered",
      resultId: "result-recovered-123",
      reusable: true,
    });
    expect(resolved).toMatchObject({
      decision: "resolved",
      allowed: true,
      entry: { status: "completed", reusable: true, resultId: "result-recovered-123" },
    });
    expect(ledger.reserve(request)).toMatchObject({
      decision: "duplicate_completed",
      action: "reuse",
      allowed: false,
      reason: "completed_reusable",
    });

    for (const expiresAt of ["2026-09-02T00:00:00.000Z", NOW, "2026-09-04T00:00:00.000Z"]) {
      const expiringProject = projectFixture();
      const expiringLedger = createVideoReasoningRequestLedger(expiringProject, { now: () => NOW });
      const expiringRequest = requestIdentity();
      const expiringReservation = expiringLedger.reserve(expiringRequest);
      expiringLedger.recordSubmitted(expiringReservation.requestId!);
      expiringLedger.recordUnknownPostSubmit(expiringRequest);
      expect(expiringLedger.resolveUnknown(expiringRequest, {
        action: "mark_completed",
        actor: "operator-4",
        reason: "operator bounded resolution",
        resultId: "result-expiry-case",
        reusable: true,
        expiresAt,
      })).toMatchObject({ decision: "resolved", entry: { status: "completed" } });
      expect(expiringLedger.reserve(expiringRequest)).toMatchObject({
        decision: "duplicate_completed",
        action: expiresAt === "2026-09-04T00:00:00.000Z" ? "reuse" : "blocked",
        allowed: false,
        reason: expiresAt === "2026-09-04T00:00:00.000Z" ? "completed_reusable" : "completed_not_reusable",
      });
    }
  });

  it("does not remove an owner ledger lock when the contender and third caller are busy", () => {
    const project = projectFixture();
    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    const lockPath = `${ledger.path}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "owner-lock\n", { mode: 0o600 });

    const contender = ledger.reserve(requestIdentity());
    expect(contender).toMatchObject({ decision: "ledger_busy", action: "blocked", allowed: false });
    expect(fs.existsSync(lockPath)).toBe(true);
    const third = ledger.reserve(requestIdentity());
    expect(third).toMatchObject({ decision: "ledger_busy", action: "blocked", allowed: false });
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("records known failures as retryable while keeping history", () => {
    const project = projectFixture();
    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    const request = requestIdentity();
    const first = ledger.reserve(request);
    ledger.recordSubmitted(first.requestId!);
    expect(ledger.fail(request, "provider_http_403")).toMatchObject({ decision: "failed", allowed: true });
    const retry = ledger.reserve(request);
    expect(retry).toMatchObject({ decision: "retry_reserved", previousStatus: "failed" });
    expect(loadVideoReasoningLedger(ledger.path).entries).toHaveLength(2);
  });

  it("fails closed on malformed state and does not authorize a reservation", () => {
    const project = projectFixture();
    const ledgerPath = videoReasoningLedgerPath(project);
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const malformed = JSON.stringify({
      version: VIDEO_REASONING_LEDGER_VERSION,
      entries: [{ rawPrompt: "do-not-store" }],
    });
    fs.writeFileSync(ledgerPath, malformed);

    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    expect(ledger.inspect(requestIdentity())).toMatchObject({ decision: "malformed_state", allowed: false });
    expect(ledger.reserve(requestIdentity())).toMatchObject({ decision: "malformed_state", allowed: false });
    expect(() => loadVideoReasoningLedger(ledgerPath)).toThrow();
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(malformed);
  });

  it("fails closed when a completed entry contains an unsupported expiry timestamp", () => {
    const project = projectFixture();
    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    const request = requestIdentity();
    const reservation = ledger.reserve(request);
    ledger.recordSubmitted(reservation.requestId!);
    ledger.complete(reservation.requestId!, { resultId: "result-123", reusable: true });
    const document = loadVideoReasoningLedger(ledger.path);
    document.entries[0].expiresAt = "not-a-date";
    fs.writeFileSync(ledger.path, `${JSON.stringify(document, null, 2)}\n`);

    expect(ledger.inspect(request)).toMatchObject({ decision: "malformed_state", action: "blocked", allowed: false });
    expect(ledger.reserve(request)).toMatchObject({ decision: "malformed_state", action: "blocked", allowed: false });
  });

  it("does not persist raw prompt, credentials, local paths, or provider error bodies", () => {
    const project = projectFixture();
    const ledger = createVideoReasoningRequestLedger(project, { now: () => NOW });
    const secretPrompt = "API_KEY=should-not-persist; /Users/operator/source.mp4; PROVIDER ERROR BODY";
    const reservation = ledger.reserve(requestIdentity({ prompt: secretPrompt }));
    expect(reservation.decision).toBe("reserved");
    const persisted = fs.readFileSync(ledger.path, "utf8");
    expect(persisted).not.toContain(secretPrompt);
    expect(persisted).not.toContain("API_KEY");
    expect(persisted).not.toContain("/Users/private-project");
    expect(persisted).toContain("normalizedPromptHash");
  });
});
