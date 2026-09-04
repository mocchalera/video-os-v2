import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  buildPublicProjectionReceipt,
  canonicalJsonBytes,
  canonicalPublicProjectionCandidateBranch,
  isRfc3339DateTime,
  sha256Hex,
  verifyCanonicalPublicProjectionCommit,
  type PromotionApprovalReceipt,
  type PublicProjectionPolicy,
} from "../runtime/release/public-projection.js";
import {
  COCKPIT_ASK_AUTHENTICATED_SURFACE_BLOCKER_CODE,
  COCKPIT_ASK_RESOLVED_AT_BLOCKER_CODE,
  COCKPIT_ASK_RESOLVED_V1_KEYS,
  COCKPIT_ASK_RESOLVED_V2_KEYS,
  CockpitAskAuthenticatedSurfaceUnavailableError,
  CockpitAskResolvedAtUnavailableError,
  approvalChoice,
  createCockpitApprovalEventVerifier,
  createGitHubProviderEvidenceVerifier,
  createGitHubProviderExecutionReceipt,
  createPromotionApprovalReceiptFromCockpit,
  fixedPublicPromotionDestination,
  readPublicPromotionTrustConfig,
  unconfiguredStageASignatureHandoff,
  type CockpitAskResolvedV1Event,
  type CockpitAskResolvedV2Event,
  type CockpitAuthenticatedAskResolutionReader,
  type CockpitTaskReader,
  type GitHubApi,
  type PromotionApprovalRequest,
} from "../runtime/release/public-promotion-adapters.js";
import {
  createBoundRepositorySecretScanVerifier,
  assertPolicyApprovesRepositorySecretScan,
  repositorySecretScanPaths,
  runRepositorySecretScanner,
} from "../runtime/release/public-projection-secret-scan.js";
import {
  parsePublicPromotionArgs,
  preparePublicPromotion,
} from "../scripts/public-promotion.js";
import {
  commitAll,
  git,
  makeWritable,
  tempRoot,
} from "./helpers/public-projection-fixtures.js";

const WORKFLOW_BLOB = "b".repeat(40);
const LARGE_PUBLIC_BLOB_BYTES = 12 * 1024 * 1024 + 17;

function createSource(
  root: string,
  options: { largeBlobBytes?: number } = {},
): { source: string; commit: string } {
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "runtime", "release"), { recursive: true });
  fs.mkdirSync(path.join(source, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(source, "README.md"), "safe public fixture\n");
  fs.writeFileSync(path.join(source, ".gitignore"), ".claude/\n");
  fs.writeFileSync(
    path.join(source, ".claude", "agents", "blueprint-planner.md"),
    "ignored but source-tracked public fixture\n",
  );
  if (options.largeBlobBytes !== undefined) {
    fs.writeFileSync(
      path.join(source, ".claude", "agents", "large-public.bin"),
      Buffer.alloc(options.largeBlobBytes, 0),
    );
  }
  fs.copyFileSync(
    path.resolve("runtime/release/public-projection-policy.yaml"),
    path.join(source, "runtime", "release", "public-projection-policy.yaml"),
  );
  git(source, ["init"]);
  git(source, ["config", "user.name", "Public Promotion Test"]);
  git(source, ["config", "user.email", "public-promotion@example.invalid"]);
  const forcedPaths = [".claude/agents/blueprint-planner.md"];
  if (options.largeBlobBytes !== undefined) forcedPaths.push(".claude/agents/large-public.bin");
  git(source, ["add", "-f", ...forcedPaths]);
  return { source, commit: commitAll(source, "safe source") };
}

function githubApi(commit: string): GitHubApi {
  const destination = fixedPublicPromotionDestination();
  const jobs = [
    "node-runtime",
    "schema-contract",
    "speech-led-contract",
    "event-recap-contract",
    "repo-hygiene",
    "editor-server",
    "agent-definitions",
    "macos-studio",
    "render-integration",
    "product-gate",
  ].map((name, index) => ({ id: index + 1, name, conclusion: "success" }));
  return (endpoint) => {
    if (endpoint === `repos/${destination.repository_full_name}`) {
      return { id: Number(destination.repository_id), full_name: destination.repository_full_name };
    }
    if (endpoint === `repos/${destination.repository_full_name}/actions/runs/987654321`) {
      return {
        id: 987654321,
        path: ".github/workflows/ci.yml",
        repository: { id: Number(destination.repository_id), full_name: destination.repository_full_name },
        run_attempt: 1,
        event: "push",
        head_sha: commit,
        head_branch: canonicalPublicProjectionCandidateBranch(commit),
        html_url: `https://github.com/${destination.repository_full_name}/actions/runs/987654321`,
        conclusion: "success",
      };
    }
    if (endpoint === `repos/${destination.repository_full_name}/actions/runs/987654321/jobs?filter=latest&per_page=100`) {
      return { total_count: jobs.length, jobs };
    }
    throw new Error(`unexpected GitHub endpoint ${endpoint}`);
  };
}

function promotionRequest(): PromotionApprovalRequest {
  const config = readPublicPromotionTrustConfig();
  return {
    version: "public-promotion-approval-request/v1",
    stage_a_receipt_sha256: "d".repeat(64),
    destination: fixedPublicPromotionDestination(),
    operation_scope: {
      operation: "push-exact-projection",
      event: "push",
      workflow_path: config.workflow.path,
    },
  };
}

function conversationReader(
  taskId: string,
  conversation: Array<{ role: string; text: string; kind?: string; source?: string }>,
): CockpitTaskReader {
  return () => ({ id: taskId, conversation });
}

function authenticatedAskReader(
  taskId: string,
  askId: string,
  event: CockpitAskResolvedV1Event | CockpitAskResolvedV2Event,
  surface: "first-party-structured-event" | "authenticated-execution-receipt" = "first-party-structured-event",
): CockpitAuthenticatedAskResolutionReader {
  return () => ({ surface, task_id: taskId, ask_id: askId, event });
}

function expectSurfaceBlocker(
  run: () => unknown,
  askId: string,
  taskId: string,
): void {
  try {
    run();
    throw new Error("expected typed authenticated-surface blocker");
  } catch (error) {
    expect(error).toBeInstanceOf(CockpitAskAuthenticatedSurfaceUnavailableError);
    const blocker = (error as CockpitAskAuthenticatedSurfaceUnavailableError).blocker;
    expect(blocker).toMatchObject({
      version: "cockpit-ask-authenticated-surface-unavailable/v1",
      code: COCKPIT_ASK_AUTHENTICATED_SURFACE_BLOCKER_CODE,
      ask_id: askId,
      task_id: taskId,
    });
    expect(blocker.required_surface).toMatch(/never conversation text/i);
  }
}

describe("safe OSS public-promotion path", () => {
  it("prepares a scanned Stage A and exact parentless candidate without pushing", () => {
    const root = fs.realpathSync(tempRoot("public-promotion-prepare"));
    const { source, commit } = createSource(root, { largeBlobBytes: LARGE_PUBLIC_BLOB_BYTES });
    const staging = path.join(root, "staging");
    const evidenceDirectory = path.join(root, "private-evidence");
    const publicRepository = path.join(root, "public-repository");

    expect(git(source, [
      "ls-files", "--error-unmatch", ".claude/agents/blueprint-planner.md",
    ])).toBe(".claude/agents/blueprint-planner.md");
    expect(git(source, [
      "check-ignore", "--no-index", ".claude/agents/blueprint-planner.md",
    ])).toBe(".claude/agents/blueprint-planner.md");

    const result = preparePublicPromotion({
      command: "prepare",
      source,
      sourceCommit: commit,
      staging,
      evidenceDirectory,
      publicRepository,
    });

    expect(result).toMatchObject({
      source_commit: commit,
      candidate_branch: canonicalPublicProjectionCandidateBranch(result.public_commit_sha),
      push_performed: false,
      main_update_status: "not-attempted",
    });
    const stageABytes = fs.readFileSync(path.join(evidenceDirectory, "stage-a-receipt.json"));
    expect(sha256Hex(stageABytes)).toBe(result.stage_a_receipt_sha256);
    expect(verifyCanonicalPublicProjectionCommit({
      stageAReceiptBytes: stageABytes,
      publicRepository,
      exactPublicCommit: result.public_commit_sha,
    }).publicCommitSha).toBe(result.public_commit_sha);
    expect(git(publicRepository, ["rev-list", "--parents", "-n", "1", result.public_commit_sha]).split(" ")).toHaveLength(1);
    const publicPaths = git(publicRepository, ["ls-tree", "-r", "--name-only", result.public_commit_sha]);
    expect(publicPaths).toContain(".claude/agents/blueprint-planner.md");
    expect(git(publicRepository, [
      "show", `${result.public_commit_sha}:.claude/agents/blueprint-planner.md`,
    ])).toBe("ignored but source-tracked public fixture");
    expect(git(publicRepository, [
      "cat-file", "-s", `${result.public_commit_sha}:.claude/agents/large-public.bin`,
    ])).toBe(String(LARGE_PUBLIC_BLOB_BYTES));
    expect(publicPaths).not.toMatch(/receipt|private-evidence|generation\.json/);
    expect(() => parsePublicPromotionArgs(["push"])).toThrow(/never pushes/i);
  }, 30_000);

  it("rejects an output hidden beneath the source through a symlink alias", () => {
    const root = fs.realpathSync(tempRoot("public-promotion-root-alias"));
    const { source, commit } = createSource(root);
    const sourceAlias = path.join(root, "source-alias");
    fs.symlinkSync(source, sourceAlias, "dir");

    expect(() => preparePublicPromotion({
      command: "prepare",
      source: sourceAlias,
      sourceCommit: commit,
      staging: path.join(source, "hidden-staging"),
      evidenceDirectory: path.join(root, "private-evidence"),
      publicRepository: path.join(root, "public-repository"),
    })).toThrow(/must be disjoint/i);
    expect(fs.existsSync(path.join(source, "hidden-staging"))).toBe(false);
    expect(git(source, ["status", "--porcelain=v1"])).toBe("");
  });

  it("rejects scanner receipt tampering, target mismatch, and post-scan staging drift", () => {
    const root = fs.realpathSync(tempRoot("public-promotion-tamper"));
    const { source, commit } = createSource(root);
    const staging = path.join(root, "staging");
    const evidenceDirectory = path.join(root, "private-evidence");
    const publicRepository = path.join(root, "public-repository");
    preparePublicPromotion({
      command: "prepare",
      source,
      sourceCommit: commit,
      staging,
      evidenceDirectory,
      publicRepository,
    });
    const generationSnapshot = JSON.parse(
      fs.readFileSync(path.join(evidenceDirectory, "generation.json"), "utf8"),
    );
    const attestationBytes = fs.readFileSync(path.join(evidenceDirectory, "scan-attestation.json"));
    const executionReceiptBytes = fs.readFileSync(
      path.join(evidenceDirectory, "scan-execution-receipt.json"),
    );
    const policyPath = path.join(source, "runtime", "release", "public-projection-policy.yaml");
    const build = (receiptBytes: Buffer, scanBytes: Buffer = Buffer.from(attestationBytes)) => buildPublicProjectionReceipt({
      sourceRoot: source,
      stagingRoot: staging,
      policyPath,
      generationSnapshot,
      attestationBytes: scanBytes,
      verificationEvidence: {
        mechanism: "approved-wrapper-execution-receipt",
        bytes: receiptBytes,
      },
      attestationVerifier: createBoundRepositorySecretScanVerifier({ stagingRoot: staging }),
    });

    const tamperedReceipt = JSON.parse(executionReceiptBytes.toString("utf8"));
    tamperedReceipt.scan_result.target_payload_sha256 = "0".repeat(64);
    expect(() => build(canonicalJsonBytes(tamperedReceipt))).toThrow(/bind|target|rerun/i);

    const tamperedAttestation = JSON.parse(attestationBytes.toString("utf8"));
    tamperedAttestation.target_payload_sha256 = "0".repeat(64);
    expect(() => build(executionReceiptBytes, canonicalJsonBytes(tamperedAttestation))).toThrow(/target payload/i);

    makeWritable(staging);
    fs.appendFileSync(path.join(staging, "README.md"), "drift\n");
    expect(() => build(executionReceiptBytes)).toThrow(/staging (?:payload|state) changed|immutable staging/i);
  });

  it("reports hashed findings without disclosing matched secret bytes", () => {
    const root = fs.realpathSync(tempRoot("public-secret-scanner"));
    const staging = path.join(root, "staging");
    fs.mkdirSync(staging);
    const marker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    fs.writeFileSync(path.join(staging, "credential.txt"), `${marker}\nnot-a-real-key\n`);
    fs.chmodSync(path.join(staging, "credential.txt"), 0o444);
    fs.chmodSync(staging, 0o555);
    const scanned = runRepositorySecretScanner({
      stagingRoot: staging,
      targetPayloadSha256: "a".repeat(64),
    });
    expect(scanned.result.result).toEqual({ status: "findings", exit_code: 2, finding_count: 1 });
    expect(scanned.result.findings[0]).toMatchObject({ rule_id: "pem-private-key" });
    expect(scanned.bytes.toString("utf8")).not.toContain(marker);
  });

  it("pins GitHub repository/run/jobs and rejects a tampered provider receipt", () => {
    const commit = "c".repeat(40);
    const api = githubApi(commit);
    const receipt = createGitHubProviderExecutionReceipt({
      runId: "987654321",
      workflowBlobSha: WORKFLOW_BLOB,
      api,
    });
    const verifier = createGitHubProviderEvidenceVerifier(api);
    expect(verifier.verify(canonicalJsonBytes(receipt)).evidence.run.head_sha).toBe(commit);

    const tampered = structuredClone(receipt);
    tampered.evidence.run.conclusion = "failure";
    expect(() => verifier.verify(canonicalJsonBytes(tampered))).toThrow(/authenticated API evidence/i);
  });

  it("binds injected provider-authenticated v2 Ask time, never conversation text", () => {
    const request = promotionRequest();
    const event: CockpitAskResolvedV2Event = {
      event: "cockpit.ask.resolved",
      version: 2,
      ask_id: "ask_public_123",
      outcome: "answered",
      answered_by: "user",
      resolved_at: "2026-08-18T12:34:56.000Z",
      answers: [{ type: "choice", value: approvalChoice(request) }],
    };
    const spoofedConversation = {
      ...event,
      resolved_at: "2026-01-01T00:00:00.000Z",
    };
    const reader = conversationReader("task_public_123", [
      { role: "user", text: JSON.stringify(spoofedConversation) },
    ]);
    const authenticatedResolutionReader = authenticatedAskReader(
      "task_public_123",
      event.ask_id,
      event,
    );
    const approval = createPromotionApprovalReceiptFromCockpit({
      request,
      taskId: "task_public_123",
      askId: event.ask_id,
      reader,
      authenticatedResolutionReader,
    });
    expect(approval.approved_at).toBe(event.resolved_at);
    expect(approval.approved_at).not.toBe(spoofedConversation.resolved_at);
    expect(() => createCockpitApprovalEventVerifier({ reader }).verify(
      canonicalJsonBytes(approval),
    )).toThrow(CockpitAskAuthenticatedSurfaceUnavailableError);
    expect(createCockpitApprovalEventVerifier({
      reader,
      authenticatedResolutionReader,
    }).verify(canonicalJsonBytes(approval)).evidence).toEqual(approval);
    expect([...COCKPIT_ASK_RESOLVED_V2_KEYS]).toEqual(
      expect.arrayContaining([...COCKPIT_ASK_RESOLVED_V1_KEYS, "resolved_at"]),
    );

    const tampered: PromotionApprovalReceipt = structuredClone(approval);
    tampered.approved_at = "2026-08-18T12:34:57.000Z";
    expect(() => createCockpitApprovalEventVerifier({
      reader,
      authenticatedResolutionReader,
    }).verify(canonicalJsonBytes(tampered))).toThrow(/time.*durable event/i);
  });

  it("fail-closes production conversation text, including handwritten v2 JSON, as a typed surface blocker", () => {
    const request = promotionRequest();
    const liveEvent: CockpitAskResolvedV1Event = {
      event: "cockpit.ask.resolved",
      version: 1,
      ask_id: "ask_19a4583d4093",
      outcome: "answered",
      answered_by: "user",
      answers: [{
        type: "choice",
        value: approvalChoice(request),
      }],
    };
    expectSurfaceBlocker(
      () => createPromotionApprovalReceiptFromCockpit({
        request,
        taskId: "4ee461ea",
        askId: liveEvent.ask_id,
        reader: conversationReader("4ee461ea", [
          { role: "user", text: JSON.stringify(liveEvent) },
        ]),
      }),
      liveEvent.ask_id,
      "4ee461ea",
    );

    const handwrittenV2: CockpitAskResolvedV2Event = {
      ...liveEvent,
      version: 2,
      resolved_at: "2026-08-18T12:34:56.000Z",
    };
    expectSurfaceBlocker(
      () => createPromotionApprovalReceiptFromCockpit({
        request,
        taskId: "4ee461ea",
        askId: handwrittenV2.ask_id,
        reader: conversationReader("4ee461ea", [
          { role: "user", text: JSON.stringify(handwrittenV2) },
        ]),
      }),
      handwrittenV2.ask_id,
      "4ee461ea",
    );

    expectSurfaceBlocker(
      () => createPromotionApprovalReceiptFromCockpit({
        request,
        taskId: "4ee461ea",
        askId: liveEvent.ask_id,
        reader: conversationReader("4ee461ea", [
          { role: "user", text: "I approve this public promotion." },
        ]),
      }),
      liveEvent.ask_id,
      "4ee461ea",
    );

    expectSurfaceBlocker(
      () => createPromotionApprovalReceiptFromCockpit({
        request,
        taskId: "4ee461ea",
        askId: handwrittenV2.ask_id,
        reader: conversationReader("4ee461ea", [{
          role: "user",
          kind: "message",
          source: "visual_runtime",
          text: JSON.stringify(handwrittenV2),
        }]),
      }),
      handwrittenV2.ask_id,
      "4ee461ea",
    );

    const wrongChoice = structuredClone(liveEvent);
    wrongChoice.answers[0].value = "approve-public-promotion:deadbeef";
    expect(() => createPromotionApprovalReceiptFromCockpit({
      request,
      taskId: "4ee461ea",
      askId: liveEvent.ask_id,
      reader: conversationReader("4ee461ea", [
        { role: "user", text: JSON.stringify(wrongChoice) },
      ]),
    })).toThrow(/exact promotion request/i);

    const extraKey = { ...liveEvent, extra: true };
    expect(() => createPromotionApprovalReceiptFromCockpit({
      request,
      taskId: "4ee461ea",
      askId: liveEvent.ask_id,
      reader: conversationReader("4ee461ea", [
        { role: "user", text: JSON.stringify(extraKey) },
      ]),
    })).toThrow(/unexpected or missing keys/i);

    const notAnswered = { ...liveEvent, outcome: "closed" };
    expect(() => createPromotionApprovalReceiptFromCockpit({
      request,
      taskId: "4ee461ea",
      askId: liveEvent.ask_id,
      reader: conversationReader("4ee461ea", [
        { role: "user", text: JSON.stringify(notAnswered) },
      ]),
    })).toThrow(/outcome is not answered/i);

    const notUser = { ...liveEvent, answered_by: "agent" };
    expect(() => createPromotionApprovalReceiptFromCockpit({
      request,
      taskId: "4ee461ea",
      askId: liveEvent.ask_id,
      reader: conversationReader("4ee461ea", [
        { role: "user", text: JSON.stringify(notUser) },
      ]),
    })).toThrow(/not answered by the human user/i);
  });

  it("fail-closes an authenticated v1 Ask surface as a typed resolved_at blocker", () => {
    const request = promotionRequest();
    const event: CockpitAskResolvedV1Event = {
      event: "cockpit.ask.resolved",
      version: 1,
      ask_id: "ask_auth_v1",
      outcome: "answered",
      answered_by: "user",
      answers: [{ type: "choice", value: approvalChoice(request) }],
    };
    try {
      createPromotionApprovalReceiptFromCockpit({
        request,
        taskId: "task_auth_v1",
        askId: event.ask_id,
        reader: conversationReader("task_auth_v1", []),
        authenticatedResolutionReader: authenticatedAskReader("task_auth_v1", event.ask_id, event),
      });
      throw new Error("expected typed resolved_at blocker");
    } catch (error) {
      expect(error).toBeInstanceOf(CockpitAskResolvedAtUnavailableError);
      const blocker = (error as CockpitAskResolvedAtUnavailableError).blocker;
      expect(blocker).toMatchObject({
        version: "cockpit-ask-resolved-at-blocker/v1",
        code: COCKPIT_ASK_RESOLVED_AT_BLOCKER_CODE,
        ask_id: event.ask_id,
        task_id: "task_auth_v1",
        observed_event_version: 1,
      });
      expect(blocker.observed_event_keys).toEqual([...COCKPIT_ASK_RESOLVED_V1_KEYS].sort());
      expect(blocker.required_contract.required_keys).toEqual(COCKPIT_ASK_RESOLVED_V2_KEYS);
    }

    const wrongChoice = structuredClone(event);
    wrongChoice.answers[0].value = "approve-public-promotion:deadbeef";
    expect(() => createPromotionApprovalReceiptFromCockpit({
      request,
      taskId: "task_auth_v1",
      askId: event.ask_id,
      reader: conversationReader("task_auth_v1", []),
      authenticatedResolutionReader: authenticatedAskReader("task_auth_v1", event.ask_id, wrongChoice),
    })).toThrow(/exact promotion request/i);

    const extraKey = { ...event, extra: true } as unknown as CockpitAskResolvedV1Event;
    expect(() => createPromotionApprovalReceiptFromCockpit({
      request,
      taskId: "task_auth_v1",
      askId: event.ask_id,
      reader: conversationReader("task_auth_v1", []),
      authenticatedResolutionReader: authenticatedAskReader("task_auth_v1", event.ask_id, extraKey),
    })).toThrow(/unexpected or missing keys/i);

    expect(() => createPromotionApprovalReceiptFromCockpit({
      request,
      taskId: "task_auth_v1",
      askId: event.ask_id,
      reader: conversationReader("task_auth_v1", []),
      authenticatedResolutionReader: authenticatedAskReader("other_task", event.ask_id, event),
    })).toThrow(/does not bind the exact Ask/i);

    expect(() => createPromotionApprovalReceiptFromCockpit({
      request,
      taskId: "task_auth_v1",
      askId: event.ask_id,
      reader: conversationReader("task_auth_v1", []),
      authenticatedResolutionReader: authenticatedAskReader("task_auth_v1", "ask_other", event),
    })).toThrow(/does not bind the exact Ask/i);
  });

  it("rejects invalid calendar dates on the shared RFC 3339 contract", () => {
    const request = promotionRequest();
    for (const resolvedAt of ["2026-02-30T00:00:00Z", "2026-02-99T00:00:00Z", "2025-02-29T00:00:00Z"]) {
      expect(isRfc3339DateTime(resolvedAt), resolvedAt).toBe(false);
      const event: CockpitAskResolvedV2Event = {
        event: "cockpit.ask.resolved",
        version: 2,
        ask_id: "ask_calendar",
        outcome: "answered",
        answered_by: "user",
        resolved_at: resolvedAt,
        answers: [{ type: "choice", value: approvalChoice(request) }],
      };
      expect(() => createPromotionApprovalReceiptFromCockpit({
        request,
        taskId: "task_calendar",
        askId: event.ask_id,
        reader: conversationReader("task_calendar", []),
        authenticatedResolutionReader: authenticatedAskReader("task_calendar", event.ask_id, event),
      })).toThrow(/supported RFC 3339 subset/i);
    }
    expect(isRfc3339DateTime("2024-02-29T23:59:59Z")).toBe(true);
    expect(isRfc3339DateTime("2026-08-18T12:34:56.000Z")).toBe(true);
  });

  it("keeps private signing keys absent and production Stage B fail-closed", () => {
    const scanRoot = fs.realpathSync(tempRoot("public-secret-repository-scan"));
    const tracked = git(path.resolve("."), [
      "ls-files", "--cached", "--others", "--exclude-standard", "-z",
    ]).split("\0").filter(Boolean);
    const marker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    for (const relative of tracked) {
      const source = path.resolve(relative);
      const stat = fs.lstatSync(source);
      if (!stat.isFile()) continue;
      const snapshot = path.join(scanRoot, relative);
      fs.mkdirSync(path.dirname(snapshot), { recursive: true });
      fs.copyFileSync(source, snapshot);
      expect(fs.readFileSync(snapshot, "utf8"), relative).not.toContain(marker);
    }
    expect(readPublicPromotionTrustConfig().stage_a_authentication).toEqual({
      configured: false,
      key_id: null,
      public_key_path: null,
      public_key_sha256: null,
    });
    expect(unconfiguredStageASignatureHandoff()).toMatchObject({
      version: "stage-a-signature-handoff/v1",
      configured: false,
      private_key_policy: "never-generate-store-or-commit",
    });
    const paths = repositorySecretScanPaths();
    expect(sha256Hex(fs.readFileSync(paths.scannerPath))).toMatch(/^[0-9a-f]{64}$/);
    const productionPolicy = parseYaml(
      fs.readFileSync("runtime/release/public-projection-policy.yaml", "utf8"),
    ) as PublicProjectionPolicy;
    expect(() => assertPolicyApprovesRepositorySecretScan(productionPolicy, paths)).not.toThrow();
  });
});
