import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  parseGeneratePublicProjectionArgs,
  runGeneratePublicProjection,
} from "../../scripts/generate-public-projection.js";
import {
  finalizePublicProjectionReceiptWithApprovedVerifier,
  parseFinalizePublicProjectionArgs,
} from "../../scripts/finalize-public-projection-receipt.js";
import {
  parseVerifyPublicProjectionArgs,
} from "../../scripts/verify-public-projection.js";
import {
  parseVerifyPromotionEnvelopeArgs,
  verifyPromotionEnvelopeWithTrustedVerifiers,
} from "../../scripts/verify-promotion-envelope.js";
import {
  PUBLIC_PROJECTION_COMMIT_AUTHOR_EMAIL,
  PUBLIC_PROJECTION_COMMIT_AUTHOR_NAME,
  PUBLIC_PROJECTION_COMMIT_TIMESTAMP,
  REQUIRED_PUBLIC_BOUNDARY_JOBS,
  buildPromotionEnvelope,
  buildPublicProjectionReceipt,
  canonicalPublicProjectionCandidateBranch,
  canonicalPublicProjectionCommitMessage,
  canonicalJsonBytes,
  generatePublicProjection,
  sha256Hex,
  verifyPromotionEnvelope,
  verifyPublicProjectionReceipt,
  writeExclusiveOutputFile,
  type ApprovedAttestationVerifier,
  type PromotionApprovalReceipt,
  type PromotionCiEvidence,
  type PromotionDestination,
  type PublicProjectionPolicy,
  type PublicProjectionReceipt,
  type PublicProjectionScanAttestation,
  type TrustedEvidenceVerifier,
} from "../../runtime/release/public-projection.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (options: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: unknown[] | null;
  };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);
const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

export function makeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) {
      try {
        fs.chmodSync(path.join(entry.parentPath, entry.name), entry.isDirectory() ? 0o755 : 0o644);
      } catch {
        // Best effort cleanup for deliberately immutable fixtures.
      }
    }
  }
  fs.chmodSync(root, 0o755);
}

export function makeDirectoriesWritable(root: string): void {
  fs.chmodSync(root, 0o755);
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o755);
  }
}

export function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `videoos-${label}-`));
  tmpRoots.push(root);
  return root;
}

export function git(
  cwd: string,
  args: string[],
  input?: Buffer | string,
  envOverrides: Record<string, string> = {},
): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Public Projection Test",
      GIT_AUTHOR_EMAIL: "projection-test@example.invalid",
      GIT_COMMITTER_NAME: "Public Projection Test",
      GIT_COMMITTER_EMAIL: "projection-test@example.invalid",
      ...envOverrides,
    },
  }).trim();
}

export function commitAll(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

export function commitAllAsRoot(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  const tree = git(repo, ["write-tree"]);
  const commit = git(repo, ["commit-tree", tree, "-m", message]);
  git(repo, ["reset", "--hard", commit]);
  return commit;
}

export function commitAllAsCanonicalPublicRoot(
  repo: string,
  stageAReceiptSha256: string,
): string {
  git(repo, ["add", "-A"]);
  const tree = git(repo, ["write-tree"]);
  const identityEnv = {
    GIT_AUTHOR_NAME: PUBLIC_PROJECTION_COMMIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: PUBLIC_PROJECTION_COMMIT_AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: `@${PUBLIC_PROJECTION_COMMIT_TIMESTAMP}`,
    GIT_COMMITTER_NAME: PUBLIC_PROJECTION_COMMIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: PUBLIC_PROJECTION_COMMIT_AUTHOR_EMAIL,
    GIT_COMMITTER_DATE: `@${PUBLIC_PROJECTION_COMMIT_TIMESTAMP}`,
  };
  const commit = git(
    repo,
    ["commit-tree", tree, "-F", "-"],
    canonicalPublicProjectionCommitMessage(stageAReceiptSha256),
    identityEnv,
  );
  git(repo, ["reset", "--hard", commit]);
  return commit;
}

export function policy(): PublicProjectionPolicy {
  return {
    version: "public-projection-policy/v1",
    verifier_version: "public-projection-verifier/v1",
    include: [
      { pattern: "README.md" },
      { pattern: "bin/**" },
      { pattern: "docs-link" },
      { pattern: ".github/**" },
    ],
    exclude: [{ pattern: "private/**", reason: "private test material" }],
    transforms: [],
    secret_scan: {
      approved_producers: [{
        producer_id: "test-only-scanner-wrapper",
        wrapper_version: "1.0.0-test",
        wrapper_sha256: SHA_A,
        verifier_sha256: SHA_B,
        key_id: "test-only-ed25519",
      }],
      approved_scanners: [{
        name: "fixture-secret-scanner",
        version: "1.0.0-test",
        binary_sha256: SHA_A,
        rules_sha256: SHA_B,
      }],
    },
  };
}

export interface StageAFixture {
  root: string;
  source: string;
  staging: string;
  policyPath: string;
  snapshot: ReturnType<typeof generatePublicProjection>;
  attestation: PublicProjectionScanAttestation;
  attestationBytes: Buffer;
  signatureBytes: Buffer;
  verifier: ApprovedAttestationVerifier;
  receipt: PublicProjectionReceipt;
  receiptBytes: Buffer;
}

export function stageAFixture(): StageAFixture {
  const root = tempRoot("stage-a");
  const source = path.join(root, "source");
  const staging = path.join(root, "public-staging");
  const policyPath = path.join(root, "public-projection-policy.yaml");
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.mkdirSync(path.join(source, "private"), { recursive: true });
  fs.mkdirSync(path.join(source, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(source, "README.md"), "public fixture\n");
  fs.writeFileSync(path.join(source, "bin", "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(source, "private", "local.txt"), "not public\n");
  fs.writeFileSync(path.join(source, ".github", "workflows", "ci.yml"), "name: ci\n");
  fs.symlinkSync("README.md", path.join(source, "docs-link"));
  git(source, ["init"]);
  git(source, ["config", "user.name", "Public Projection Test"]);
  git(source, ["config", "user.email", "projection-test@example.invalid"]);
  commitAll(source, "fixture source");
  fs.writeFileSync(policyPath, stringifyYaml(policy()));

  const snapshot = generatePublicProjection({ sourceRoot: source, outputRoot: staging, policyPath });
  const attestation: PublicProjectionScanAttestation = {
    version: "public-projection-scan-attestation/v1",
    producer: {
      producer_id: "test-only-scanner-wrapper",
      wrapper_version: "1.0.0-test",
      wrapper_sha256: SHA_A,
      verifier_sha256: SHA_B,
      key_id: "test-only-ed25519",
    },
    scanner: {
      name: "fixture-secret-scanner",
      version: "1.0.0-test",
      binary_sha256: SHA_A,
      rules_sha256: SHA_B,
    },
    target_payload_sha256: snapshot.public_payload_sha256,
    result: { status: "clean", exit_code: 0, finding_count: 0 },
  };
  const attestationBytes = canonicalJsonBytes(attestation);
  const signatureBytes = Buffer.from(`test-signature:${sha256Hex(attestationBytes)}`, "utf8");
  const verifier: ApprovedAttestationVerifier = {
    verify(input) {
      expect(input.signatureBytes.toString("utf8")).toBe(
        `test-signature:${sha256Hex(input.attestationBytes)}`,
      );
      return {
        mechanism: "detached-signature",
        verifier_id: "test-only-signature-verifier",
        producer_id: input.attestation.producer.producer_id,
        key_id: input.attestation.producer.key_id,
      };
    },
  };
  const receipt = buildPublicProjectionReceipt({
    sourceRoot: source,
    stagingRoot: staging,
    policyPath,
    generationSnapshot: snapshot,
    attestationBytes,
    signatureBytes,
    attestationVerifier: verifier,
  });
  const receiptBytes = canonicalJsonBytes(receipt);
  return {
    root,
    source,
    staging,
    policyPath,
    snapshot,
    attestation,
    attestationBytes,
    signatureBytes,
    verifier,
    receipt,
    receiptBytes,
  };
}

export function wrapperStageAReceipt(fixture: StageAFixture): {
  receipt: PublicProjectionReceipt;
  receiptBytes: Buffer;
  verifier: ApprovedAttestationVerifier;
} {
  const executionReceiptBytes = Buffer.from(
    `test-wrapper-execution:${sha256Hex(fixture.attestationBytes)}`,
    "utf8",
  );
  const verifier: ApprovedAttestationVerifier = {
    verify(input) {
      expect(input.verificationEvidence).toEqual({
        mechanism: "approved-wrapper-execution-receipt",
        bytes: executionReceiptBytes,
      });
      return {
        mechanism: "approved-wrapper-execution-receipt",
        verifier_id: "test-only-wrapper-receipt-verifier",
        producer_id: input.attestation.producer.producer_id,
        key_id: input.attestation.producer.key_id,
      };
    },
  };
  const receipt = buildPublicProjectionReceipt({
    sourceRoot: fixture.source,
    stagingRoot: fixture.staging,
    policyPath: fixture.policyPath,
    generationSnapshot: fixture.snapshot,
    attestationBytes: fixture.attestationBytes,
    verificationEvidence: {
      mechanism: "approved-wrapper-execution-receipt",
      bytes: executionReceiptBytes,
    },
    attestationVerifier: verifier,
  });
  return { receipt, receiptBytes: canonicalJsonBytes(receipt), verifier };
}

export function createOutputSymlinkAttack(
  root: string,
  protectedRoot: string,
  variant: "root" | "parent" | "dangling",
): string {
  const attackRoot = path.join(root, `output-${variant}`);
  if (variant === "root") {
    const protectedEntry = fs.lstatSync(protectedRoot).isDirectory()
      ? path.join(protectedRoot, fs.readdirSync(protectedRoot)[0])
      : protectedRoot;
    fs.symlinkSync(protectedEntry, attackRoot);
    return attackRoot;
  }
  if (variant === "parent") {
    fs.symlinkSync(protectedRoot, attackRoot, "dir");
    return path.join(attackRoot, "escaped-output");
  }
  fs.symlinkSync(path.join(root, "missing-output-target"), attackRoot);
  return attackRoot;
}

function installExclusiveOutputWorkerInjection(
  marker: string,
  replacement: string,
): { restore(): void; wasTriggered(): boolean } {
  const mutableChildProcess = require_("node:child_process") as typeof import("node:child_process");
  const originalSpawnSync = mutableChildProcess.spawnSync;
  let triggered = false;
  mutableChildProcess.spawnSync = ((
    command: string,
    args?: readonly string[],
    spawnOptions?: import("node:child_process").SpawnSyncOptions,
  ) => {
    const effectiveArgs = args ? [...args] : undefined;
    if (
      !triggered
      && effectiveArgs?.[0] === "-e"
      && effectiveArgs[1]?.includes(marker)
      && spawnOptions?.env?.PUBLIC_PROJECTION_OUTPUT_WORKER === "1"
    ) {
      effectiveArgs[1] = effectiveArgs[1].replace(marker, replacement);
      triggered = true;
    }
    return originalSpawnSync(command, effectiveArgs, spawnOptions);
  }) as typeof mutableChildProcess.spawnSync;
  syncBuiltinESMExports();
  return {
    restore() {
      mutableChildProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
    },
    wasTriggered() {
      return triggered;
    },
  };
}

export function installExclusiveOutputAbaAttack(options: {
  nominalParent: string;
  movedParent: string;
  protectedRoot: string;
}): { restore(): void; wasTriggered(): boolean } {
  const attack = [
    `fs.renameSync(${JSON.stringify(options.nominalParent)}, ${JSON.stringify(options.movedParent)});`,
    `fs.symlinkSync(${JSON.stringify(options.protectedRoot)}, ${JSON.stringify(options.nominalParent)}, "dir");`,
    `fs.unlinkSync(${JSON.stringify(options.nominalParent)});`,
    `fs.renameSync(${JSON.stringify(options.movedParent)}, ${JSON.stringify(options.nominalParent)});`,
  ].join("\n");
  return installExclusiveOutputWorkerInjection(
    "/* exclusive-temp-create-checkpoint */",
    attack,
  );
}

export function installExclusiveOutputForcedTermination(): {
  restore(): void;
  wasTriggered(): boolean;
} {
  return installExclusiveOutputWorkerInjection(
    "/* exclusive-temp-write-checkpoint */",
    'process.kill(process.pid, "SIGKILL");',
  );
}

export function installExclusiveOutputPostPublishTermination(): {
  restore(): void;
  wasTriggered(): boolean;
} {
  return installExclusiveOutputWorkerInjection(
    "/* exclusive-publish-checkpoint */",
    'process.kill(process.pid, "SIGKILL");',
  );
}

export function installExclusiveOutputAdditionalHardlink(aliasLeaf: string): {
  restore(): void;
  wasTriggered(): boolean;
} {
  return installExclusiveOutputWorkerInjection(
    "/* exclusive-temp-create-checkpoint */",
    `fs.linkSync(tempLeaf, ${JSON.stringify(aliasLeaf)});`,
  );
}

export function installExclusiveOutputForeignTempReplacement(bytes: string): {
  restore(): void;
  wasTriggered(): boolean;
} {
  return installExclusiveOutputWorkerInjection(
    "/* exclusive-pre-publish-checkpoint */",
    [
      "fs.unlinkSync(tempLeaf);",
      `fs.writeFileSync(tempLeaf, ${JSON.stringify(bytes)}, { mode: 0o600 });`,
    ].join("\n"),
  );
}

export function schemaValidator(schemaName: string): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  const schema = JSON.parse(
    fs.readFileSync(path.resolve("schemas", schemaName), "utf8"),
  ) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

export interface StageBFixture extends StageAFixture {
  publicRepo: string;
  publicCommit: string;
  publicTree: string;
  workflowPath: string;
  workflowBlobSha: string;
  destination: PromotionDestination;
  ciEvidence: PromotionCiEvidence;
  approval: PromotionApprovalReceipt;
  ciBytes: Buffer;
  approvalBytes: Buffer;
  stageAVerifier: TrustedEvidenceVerifier<PublicProjectionReceipt>;
  ciVerifier: TrustedEvidenceVerifier<PromotionCiEvidence>;
  approvalVerifier: TrustedEvidenceVerifier<PromotionApprovalReceipt>;
}

export function signedEvidence<T>(payload: T, signer: string): Buffer {
  const payloadBytes = canonicalJsonBytes(payload);
  return canonicalJsonBytes({
    payload,
    signer,
    signature: sha256Hex(Buffer.concat([Buffer.from(`test-key:${signer}:`), payloadBytes])),
  });
}

export function evidenceVerifier<T>(signer: string): TrustedEvidenceVerifier<T> {
  return {
    verify(bytes) {
      const container = JSON.parse(bytes.toString("utf8")) as {
        payload?: T;
        signer?: string;
        signature?: string;
      };
      if (container.signer !== signer || container.payload === undefined) {
        throw new Error(`untrusted ${signer} evidence`);
      }
      const expected = sha256Hex(Buffer.concat([
        Buffer.from(`test-key:${signer}:`),
        canonicalJsonBytes(container.payload),
      ]));
      if (container.signature !== expected) throw new Error(`invalid ${signer} evidence signature`);
      return {
        evidence: container.payload,
        verification: {
          mechanism: signer === "cockpit"
            ? "cockpit-approval-event"
            : "provider-api-execution-receipt",
          verifier_id: `test-only-${signer}-verifier`,
          evidence_sha256: sha256Hex(bytes),
        },
      };
    },
  };
}

export function exactCanonicalEvidenceVerifier<T>(
  expectedBytes: Buffer,
  verifierId: string,
): TrustedEvidenceVerifier<T> {
  return {
    verify(bytes) {
      if (!bytes.equals(expectedBytes)) throw new Error(`untrusted ${verifierId} evidence`);
      return {
        evidence: JSON.parse(bytes.toString("utf8")) as T,
        verification: {
          mechanism: "detached-signature",
          verifier_id: verifierId,
          evidence_sha256: sha256Hex(bytes),
        },
      };
    },
  };
}

export function stageBFixture(): StageBFixture {
  const fixture = stageAFixture();
  const publicRepo = path.join(fixture.root, "public-repository");
  fs.cpSync(fixture.staging, publicRepo, {
    recursive: true,
    dereference: false,
    preserveTimestamps: false,
    verbatimSymlinks: true,
  });
  makeDirectoriesWritable(publicRepo);
  git(publicRepo, ["init"]);
  git(publicRepo, ["config", "user.name", "Public Projection Test"]);
  git(publicRepo, ["config", "user.email", "projection-test@example.invalid"]);
  const publicCommit = commitAllAsCanonicalPublicRoot(
    publicRepo,
    sha256Hex(fixture.receiptBytes),
  );
  const publicTree = git(publicRepo, ["rev-parse", `${publicCommit}^{tree}`]);
  const workflowPath = ".github/workflows/ci.yml";
  const workflowBlobSha = git(publicRepo, ["rev-parse", `${publicCommit}:${workflowPath}`]);
  const destination: PromotionDestination = {
    provider: "github",
    repository_id: "123456789",
    repository_full_name: "video-os/roughcut-agent",
    branch: "main",
  };
  const ciEvidence: PromotionCiEvidence = {
    version: "public-ci-evidence/v1",
    repository: {
      provider: destination.provider,
      repository_id: destination.repository_id,
      repository_full_name: destination.repository_full_name,
    },
    workflow: { path: workflowPath, blob_sha: workflowBlobSha },
    run: {
      id: "987654321",
      attempt: 1,
      event: "push",
      head_sha: publicCommit,
      head_branch: canonicalPublicProjectionCandidateBranch(publicCommit),
      url: "https://github.com/video-os/roughcut-agent/actions/runs/987654321",
      conclusion: "success",
    },
    required_jobs: REQUIRED_PUBLIC_BOUNDARY_JOBS.map((name) => ({ name, result: "success" })),
    product_gate: { name: "product-gate", result: "success" },
  };
  const stageAReceiptSha256 = sha256Hex(fixture.receiptBytes);
  const approval: PromotionApprovalReceipt = {
    version: "promotion-approval-receipt/v1",
    approval_id: "cockpit-approval-123",
    approver: { identity: "human:test-operator" },
    approved_at: "2026-07-27T00:00:00.000Z",
    stage_a_receipt_sha256: stageAReceiptSha256,
    destination: structuredClone(destination),
    operation_scope: {
      operation: "push-exact-projection",
      event: "push",
      workflow_path: workflowPath,
    },
    cockpit_source: {
      task_id: "task-public-projection-test",
      event_id: "cockpit-approval-event-123",
    },
  };
  const ciBytes = signedEvidence(ciEvidence, "github-provider");
  const approvalBytes = signedEvidence(approval, "cockpit");
  return {
    ...fixture,
    publicRepo,
    publicCommit,
    publicTree,
    workflowPath,
    workflowBlobSha,
    destination,
    ciEvidence,
    approval,
    ciBytes,
    approvalBytes,
    stageAVerifier: exactCanonicalEvidenceVerifier(
      fixture.receiptBytes,
      "test-only-stage-a-finalizer",
    ),
    ciVerifier: evidenceVerifier("github-provider"),
    approvalVerifier: evidenceVerifier("cockpit"),
  };
}

export function promotionOptions(fixture: StageBFixture) {
  return {
    stageAReceiptBytes: fixture.receiptBytes,
    stageAReceiptVerifier: fixture.stageAVerifier,
    publicRepository: fixture.publicRepo,
    exactPublicCommit: fixture.publicCommit,
    destination: fixture.destination,
    workflowPath: fixture.workflowPath,
    workflowBlobSha: fixture.workflowBlobSha,
    ciEvidenceBytes: fixture.ciBytes,
    approvalReceiptBytes: fixture.approvalBytes,
    ciEvidenceVerifier: fixture.ciVerifier,
    approvalReceiptVerifier: fixture.approvalVerifier,
  };
}

export function resignCi(fixture: StageBFixture, patch: (evidence: PromotionCiEvidence) => void): void {
  patch(fixture.ciEvidence);
  fixture.ciBytes = signedEvidence(fixture.ciEvidence, "github-provider");
}

export function resignApproval(
  fixture: StageBFixture,
  patch: (approval: PromotionApprovalReceipt) => void,
): void {
  patch(fixture.approval);
  fixture.approvalBytes = signedEvidence(fixture.approval, "cockpit");
}
