import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  buildPublicProjectionReceipt,
  canonicalJsonBytes,
  canonicalPublicProjectionCandidateBranch,
  sha256Hex,
  verifyCanonicalPublicProjectionCommit,
  type PromotionApprovalReceipt,
  type PublicProjectionPolicy,
} from "../runtime/release/public-projection.js";
import {
  approvalChoice,
  createCockpitApprovalEventVerifier,
  createGitHubProviderEvidenceVerifier,
  createGitHubProviderExecutionReceipt,
  createPromotionApprovalReceiptFromCockpit,
  fixedPublicPromotionDestination,
  readPublicPromotionTrustConfig,
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

  it("binds durable Cockpit user approval to the exact request and event time", () => {
    const config = readPublicPromotionTrustConfig();
    const request: PromotionApprovalRequest = {
      version: "public-promotion-approval-request/v1",
      stage_a_receipt_sha256: "d".repeat(64),
      destination: fixedPublicPromotionDestination(),
      operation_scope: {
        operation: "push-exact-projection",
        event: "push",
        workflow_path: config.workflow.path,
      },
    };
    const event = {
      event: "cockpit.ask.resolved",
      version: 1,
      ask_id: "ask_public_123",
      answered_by: "user",
      resolved_at: "2026-08-18T12:34:56.000Z",
      answers: [{ type: "choice", value: approvalChoice(request) }],
    } as const;
    const reader: CockpitTaskReader = () => ({
      id: "task_public_123",
      conversation: [{ role: "user", text: JSON.stringify(event) }],
    });
    const approval = createPromotionApprovalReceiptFromCockpit({
      request,
      taskId: "task_public_123",
      askId: event.ask_id,
      reader,
    });
    expect(createCockpitApprovalEventVerifier(reader).verify(
      canonicalJsonBytes(approval),
    ).evidence).toEqual(approval);

    const tampered: PromotionApprovalReceipt = structuredClone(approval);
    tampered.approved_at = "2026-08-18T12:34:57.000Z";
    expect(() => createCockpitApprovalEventVerifier(reader).verify(
      canonicalJsonBytes(tampered),
    )).toThrow(/time.*durable event/i);
  });

  it("keeps private signing keys absent and production Stage B fail-closed", () => {
    const tracked = git(path.resolve("."), [
      "ls-files", "--cached", "--others", "--exclude-standard", "-z",
    ]).split("\0").filter(Boolean);
    const marker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    for (const relative of tracked) {
      const absolute = path.resolve(relative);
      if (fs.lstatSync(absolute).isFile()) {
        expect(fs.readFileSync(absolute, "utf8"), relative).not.toContain(marker);
      }
    }
    expect(readPublicPromotionTrustConfig().stage_a_authentication).toEqual({
      configured: false,
      key_id: null,
      public_key_path: null,
      public_key_sha256: null,
    });
    const paths = repositorySecretScanPaths();
    expect(sha256Hex(fs.readFileSync(paths.scannerPath))).toMatch(/^[0-9a-f]{64}$/);
    const productionPolicy = parseYaml(
      fs.readFileSync("runtime/release/public-projection-policy.yaml", "utf8"),
    ) as PublicProjectionPolicy;
    expect(() => assertPolicyApprovesRepositorySecretScan(productionPolicy, paths)).not.toThrow();
  });
});
