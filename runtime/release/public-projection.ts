import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { devNull } from "node:os";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { parse as parseYaml } from "yaml";

export const PUBLIC_PROJECTION_VERIFIER_VERSION = "public-projection-verifier/v1";
export const PUBLIC_PROJECTION_COMMIT_AUTHOR_NAME = "Video OS Public Projection";
export const PUBLIC_PROJECTION_COMMIT_AUTHOR_EMAIL =
  "public-projection@video-os.invalid";
export const PUBLIC_PROJECTION_COMMIT_TIMESTAMP = "0 +0000";
export const PUBLIC_PROJECTION_CANDIDATE_BRANCH_PREFIX = "public-candidate/";
export const REQUIRED_PUBLIC_BOUNDARY_JOBS = [
  "node-runtime",
  "schema-contract",
  "speech-led-contract",
  "event-recap-contract",
  "repo-hygiene",
  "editor-server",
  "agent-definitions",
  "macos-studio",
  "render-integration",
] as const;

type GitMode = "100644" | "100755" | "120000";
type PublicPathType = "regular_file" | "symlink";
type JsonRecord = Record<string, unknown>;

export interface PublicProjectionPolicy {
  version: "public-projection-policy/v1";
  verifier_version: "public-projection-verifier/v1";
  include: Array<{ pattern: string }>;
  exclude: Array<{ pattern: string; reason: string }>;
  transforms: Array<{
    pattern: string;
    transform_id: "redact-local-user-paths-v1";
  }>;
  secret_scan: {
    approved_producers: Array<{
      producer_id: string;
      wrapper_version: string;
      wrapper_sha256: string;
      verifier_sha256: string;
      key_id: string;
    }>;
    approved_scanners: Array<{
      name: string;
      version: string;
      binary_sha256: string;
      rules_sha256: string;
    }>;
  };
}

export interface PublicPathLedgerEntry {
  path_b64: string;
  path: string;
  type: PublicPathType;
  mode: GitMode;
  sha256: string;
  target_b64?: string;
  source: {
    path_b64: string;
    transform_id: string | null;
  };
}

export interface ProjectionPolicyLedgerEntry {
  path_b64: string;
  path: string;
  source_type: PublicPathType;
  source_mode: GitMode;
  source_sha256: string;
  decision: "include" | "exclude" | "transform";
  reason: string | null;
  transform_id: string | null;
  public_sha256: string | null;
}

export interface ProjectionGenerationSnapshot {
  version: "public-projection-generation/v1";
  source: {
    repository_identity_sha256: string;
    commit_sha: string;
    tree_sha: string;
    dirty: false;
  };
  policy: {
    sha256: string;
    verifier_version: "public-projection-verifier/v1";
  };
  policy_ledger: ProjectionPolicyLedgerEntry[];
  public_path_ledger: PublicPathLedgerEntry[];
  public_path_ledger_sha256: string;
  public_payload_sha256: string;
}

export interface PublicProjectionScanAttestation {
  version: "public-projection-scan-attestation/v1";
  producer: {
    producer_id: string;
    wrapper_version: string;
    wrapper_sha256: string;
    verifier_sha256: string;
    key_id: string;
  };
  scanner: {
    name: string;
    version: string;
    binary_sha256: string;
    rules_sha256: string;
  };
  target_payload_sha256: string;
  result: {
    status: "clean" | "findings" | "error";
    exit_code: number;
    finding_count: number;
  };
}

interface AttestationVerificationIdentity {
  verifier_id: string;
  producer_id: string;
  key_id: string;
}

export type AttestationVerification =
  | AttestationVerificationIdentity & {
    mechanism: "detached-signature";
  }
  | AttestationVerificationIdentity & {
    mechanism: "approved-wrapper-execution-receipt";
  };

export type AttestationVerificationEvidence =
  | {
    mechanism: "detached-signature";
    bytes: Buffer;
  }
  | {
    mechanism: "approved-wrapper-execution-receipt";
    bytes: Buffer;
  };

export interface ApprovedAttestationVerifier {
  verify(input: {
    attestation: PublicProjectionScanAttestation;
    attestationBytes: Buffer;
    verificationEvidence: AttestationVerificationEvidence;
    /** Backward-compatible alias for existing exact-signature verifier adapters. */
    signatureBytes: Buffer;
    approvedProducer: PublicProjectionPolicy["secret_scan"]["approved_producers"][number];
  }): AttestationVerification;
}

interface PublicProjectionSecretScanCommon {
  attestation: PublicProjectionScanAttestation;
  attestation_sha256: string;
}

export type PublicProjectionSecretScan =
  | PublicProjectionSecretScanCommon & {
    detached_signature_b64: string;
    verification: Extract<AttestationVerification, { mechanism: "detached-signature" }>;
  }
  | PublicProjectionSecretScanCommon & {
    approved_wrapper_execution_receipt_b64: string;
    verification: Extract<
      AttestationVerification,
      { mechanism: "approved-wrapper-execution-receipt" }
    >;
  };

export interface PublicProjectionReceipt extends Omit<ProjectionGenerationSnapshot, "version"> {
  version: "public-projection-receipt/v1";
  secret_scan: PublicProjectionSecretScan;
}

export interface PromotionDestination {
  provider: "github";
  repository_id: string;
  repository_full_name: string;
  branch: string;
}

export type CiJobResult =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "neutral"
  | "timed_out"
  | "action_required"
  | "stale";

export interface PromotionCiEvidence {
  version: "public-ci-evidence/v1";
  repository: Omit<PromotionDestination, "branch">;
  workflow: {
    path: string;
    blob_sha: string;
  };
  run: {
    id: string;
    attempt: number;
    event: string;
    head_sha: string;
    head_branch: string;
    url: string;
    conclusion: CiJobResult;
  };
  required_jobs: Array<{ name: string; result: CiJobResult }>;
  product_gate: { name: "product-gate"; result: CiJobResult };
}

export interface PromotionApprovalScope {
  operation: "push-exact-projection";
  event: string;
  workflow_path: string;
}

export interface PromotionApprovalReceiptV1 {
  version: "promotion-approval-receipt/v1";
  approval_id: string;
  approver: { identity: string };
  approved_at: string;
  stage_a_receipt_sha256: string;
  destination: PromotionDestination;
  operation_scope: PromotionApprovalScope;
  cockpit_source: {
    task_id: string;
    event_id: string;
  };
}

export interface ExternalSignedPromotionApprovalReceipt {
  version: "external-signed-promotion-approval/v1";
  approval_id: string;
  approver: { identity: string };
  approved_at: string;
  stage_a_receipt_sha256: string;
  destination: PromotionDestination;
  operation_scope: PromotionApprovalScope;
}

export type PromotionApprovalReceipt =
  | PromotionApprovalReceiptV1
  | ExternalSignedPromotionApprovalReceipt;

export interface EvidenceVerification {
  mechanism:
    | "provider-api-execution-receipt"
    | "cockpit-approval-event"
    | "detached-signature";
  verifier_id: string;
  evidence_sha256: string;
}

export interface TrustedEvidenceVerifier<T> {
  verify(bytes: Buffer): {
    evidence: T;
    verification: EvidenceVerification;
  };
}

export interface PromotionEnvelope {
  // This v1 contract is still pre-production while the production Stage A
  // scanner allowlists are empty. Trusted Stage A verification is mandatory
  // before the first production envelope can exist.
  version: "promotion-envelope/v1";
  stage_a_receipt_sha256: string;
  stage_a_public_path_ledger_sha256: string;
  stage_a_verification: EvidenceVerification;
  public_commit_sha: string;
  public_tree_sha: string;
  public_path_count: number;
  destination: PromotionDestination;
  workflow: {
    path: string;
    blob_sha: string;
  };
  ci: PromotionCiEvidence & { verification: EvidenceVerification };
  approval: PromotionApprovalReceipt & { verification: EvidenceVerification };
}

export class PublicProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicProjectionError";
  }
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalPublicProjectionCommitMessage(
  stageAReceiptSha256: string,
): string {
  assertSha256(stageAReceiptSha256, "Stage A receipt digest");
  return [
    "Video OS public projection",
    "",
    `Stage-A-Receipt-SHA256: ${stageAReceiptSha256}`,
    "",
  ].join("\n");
}

export function canonicalPublicProjectionCandidateBranch(commitSha: string): string {
  assertGitObjectId(commitSha, "public candidate commit SHA");
  return `${PUBLIC_PROJECTION_CANDIDATE_BRANCH_PREFIX}${commitSha}`;
}

interface SafeOutputPathInspection {
  resolvedPath: string;
  exists: boolean;
  stat: fs.Stats | null;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function lexicalCommonAncestor(left: string, right: string): string {
  let candidate = path.resolve(left);
  const resolvedRight = path.resolve(right);
  while (!isWithinRoot(candidate, resolvedRight)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return parent;
    candidate = parent;
  }
  return candidate;
}

function lstatOptional(target: string): fs.Stats | null {
  return fs.lstatSync(target, { throwIfNoEntry: false }) ?? null;
}

export function inspectSafeOutputPath(options: {
  outputPath: string;
  protectedRoot: string;
  label: string;
}): SafeOutputPathInspection {
  const resolvedPath = path.resolve(options.outputPath);
  const protectedPath = path.resolve(options.protectedRoot);
  const protectedStat = lstatOptional(protectedPath);
  if (!protectedStat) throw new PublicProjectionError(`${options.label} protected root does not exist`);
  const protectedCanonical = fs.realpathSync(protectedPath);
  const common = lexicalCommonAncestor(protectedPath, resolvedPath);
  const relativeParts = path.relative(common, resolvedPath).split(path.sep).filter(Boolean);
  let cursor = common;
  for (const part of relativeParts) {
    cursor = path.join(cursor, part);
    const stat = lstatOptional(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new PublicProjectionError(`${options.label} path contains a symbolic link: ${cursor}`);
    }
  }

  const stat = lstatOptional(resolvedPath);
  if (stat?.isSymbolicLink()) {
    throw new PublicProjectionError(`${options.label} path is a symbolic link`);
  }

  let existingAncestor = stat ? resolvedPath : path.dirname(resolvedPath);
  while (!lstatOptional(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new PublicProjectionError(`${options.label} has no existing filesystem ancestor`);
    }
    existingAncestor = parent;
  }
  const ancestorStat = lstatOptional(existingAncestor);
  if (ancestorStat?.isSymbolicLink()) {
    throw new PublicProjectionError(`${options.label} parent is a symbolic link`);
  }
  const ancestorCanonical = fs.realpathSync(existingAncestor);
  const canonicalCandidate = stat
    ? fs.realpathSync(resolvedPath)
    : path.resolve(ancestorCanonical, path.relative(existingAncestor, resolvedPath));
  if (isWithinRoot(protectedCanonical, canonicalCandidate)) {
    throw new PublicProjectionError(
      `${options.label} must remain outside canonical protected root ${protectedCanonical}`,
    );
  }
  return { resolvedPath, exists: stat !== null, stat };
}

function ensureSafeOutputDirectory(options: {
  outputPath: string;
  protectedRoot: string;
  label: string;
  mode: number;
}): string {
  const initial = inspectSafeOutputPath(options);
  if (initial.exists) {
    if (!initial.stat?.isDirectory()) {
      throw new PublicProjectionError(`${options.label} must be a real directory`);
    }
    return initial.resolvedPath;
  }
  const missing: string[] = [];
  let cursor = initial.resolvedPath;
  while (!lstatOptional(cursor)) {
    missing.unshift(cursor);
    cursor = path.dirname(cursor);
  }
  for (const directory of missing) {
    fs.mkdirSync(directory, { mode: options.mode });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new PublicProjectionError(`${options.label} directory creation crossed a symbolic link`);
    }
  }
  const verified = inspectSafeOutputPath(options);
  if (!verified.stat?.isDirectory()) {
    throw new PublicProjectionError(`${options.label} must be a real directory`);
  }
  return verified.resolvedPath;
}

export function writeExclusiveOutputFile(options: {
  outputPath: string;
  protectedRoot: string;
  label: string;
  bytes: Buffer;
  mode: number;
}): string {
  const inspected = inspectSafeOutputPath(options);
  if (inspected.exists) {
    throw new PublicProjectionError(`${options.label} already exists`);
  }
  ensureSafeOutputDirectory({
    outputPath: path.dirname(inspected.resolvedPath),
    protectedRoot: options.protectedRoot,
    label: `${options.label} parent`,
    mode: 0o700,
  });
  inspectSafeOutputPath(options);
  const parentPath = path.dirname(inspected.resolvedPath);
  const leaf = path.basename(inspected.resolvedPath);
  const directoryFlags = fs.constants.O_RDONLY
    | fs.constants.O_DIRECTORY
    | fs.constants.O_NOFOLLOW;
  const parentDescriptor = fs.openSync(parentPath, directoryFlags);
  const containerPath = path.dirname(parentPath);
  let containerDescriptor: number | undefined;
  try {
    containerDescriptor = fs.openSync(containerPath, directoryFlags);
    const parent = fs.fstatSync(parentDescriptor, { bigint: true });
    const container = fs.fstatSync(containerDescriptor, { bigint: true });
    const nominalParent = fs.lstatSync(parentPath, { bigint: true });
    if (
      !parent.isDirectory()
      || !container.isDirectory()
      || !nominalParent.isDirectory()
      || nominalParent.isSymbolicLink()
      || nominalParent.dev !== parent.dev
      || nominalParent.ino !== parent.ino
    ) {
      throw new PublicProjectionError(`${options.label} parent must be a stable real directory`);
    }
    const run = spawnSync(process.execPath, [
      "-e",
      EXCLUSIVE_OUTPUT_WORKER_SOURCE,
      leaf,
      parentPath,
      parent.dev.toString(),
      parent.ino.toString(),
      container.dev.toString(),
      container.ino.toString(),
      container.ctimeNs.toString(),
      String(options.mode),
    ], {
      cwd: parentPath,
      input: options.bytes,
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PUBLIC_PROJECTION_OUTPUT_WORKER: "1" },
    });
    if (run.status !== 0) {
      const stderr = run.stderr?.toString("utf8").trim();
      const failure = stderr || run.error?.message || run.signal || "unknown worker failure";
      throw new PublicProjectionError(
        `${options.label} anchored output failed: ${failure}`,
      );
    }
  } finally {
    if (containerDescriptor !== undefined) fs.closeSync(containerDescriptor);
    fs.closeSync(parentDescriptor);
  }
  return inspected.resolvedPath;
}

const EXCLUSIVE_OUTPUT_WORKER_SOURCE = String.raw`
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");

const [
  leaf,
  nominalParent,
  expectedParentDev,
  expectedParentIno,
  expectedContainerDev,
  expectedContainerIno,
  expectedContainerCtimeNs,
  modeText,
] = process.argv.slice(1);
const directoryFlags = fs.constants.O_RDONLY
  | fs.constants.O_DIRECTORY
  | fs.constants.O_NOFOLLOW;
const outputFlags = fs.constants.O_RDWR
  | fs.constants.O_CREAT
  | fs.constants.O_EXCL
  | fs.constants.O_NOFOLLOW;
let parentDescriptor;
let containerDescriptor;
let tempDescriptor;
let tempLeaf;
let tempDev;
let tempIno;
let finalDev;
let finalIno;

function sameIdentity(stat, dev, ino) {
  return stat.dev.toString() === dev && stat.ino.toString() === ino;
}

function isValidLeaf(value) {
  return Boolean(value)
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\");
}

function assertStableParent() {
  const parent = fs.fstatSync(parentDescriptor, { bigint: true });
  const container = fs.fstatSync(containerDescriptor, { bigint: true });
  const nominal = fs.lstatSync(nominalParent, { bigint: true });
  if (
    !parent.isDirectory()
    || !container.isDirectory()
    || !nominal.isDirectory()
    || nominal.isSymbolicLink()
    || !sameIdentity(parent, expectedParentDev, expectedParentIno)
    || !sameIdentity(nominal, expectedParentDev, expectedParentIno)
    || !sameIdentity(container, expectedContainerDev, expectedContainerIno)
    || container.ctimeNs.toString() !== expectedContainerCtimeNs
  ) {
    throw new Error("output parent changed during anchored creation");
  }
}

function unlinkAnchoredEntryIfIdentity(name, dev, ino) {
  if (!name || dev === undefined || ino === undefined) return;
  const current = fs.lstatSync(name, { bigint: true, throwIfNoEntry: false });
  if (current && !current.isDirectory() && sameIdentity(current, dev, ino)) {
    fs.unlinkSync(name);
  }
}

function unlinkTaskCreatedAliases(dev, ino) {
  if (dev === undefined || ino === undefined) return;
  for (const name of fs.readdirSync(".")) {
    const current = fs.lstatSync(name, { bigint: true, throwIfNoEntry: false });
    if (current?.isFile() && sameIdentity(current, dev, ino)) {
      fs.unlinkSync(name);
    }
  }
}

function descriptorHasExactBytes(expectedBytes) {
  const actual = Buffer.alloc(expectedBytes.length);
  let offset = 0;
  while (offset < actual.length) {
    const read = fs.readSync(
      tempDescriptor,
      actual,
      offset,
      actual.length - offset,
      offset,
    );
    if (read <= 0) return false;
    offset += read;
  }
  return actual.equals(expectedBytes);
}

function assertTempState(label, expectedNlink, expectedSize, expectedMode, expectedBytes) {
  const descriptor = fs.fstatSync(tempDescriptor, { bigint: true });
  const named = fs.lstatSync(tempLeaf, { bigint: true });
  if (
    !descriptor.isFile()
    || !named.isFile()
    || !sameIdentity(descriptor, tempDev, tempIno)
    || !sameIdentity(named, tempDev, tempIno)
    || descriptor.nlink !== expectedNlink
    || named.nlink !== expectedNlink
    || descriptor.size !== expectedSize
    || named.size !== expectedSize
    || (expectedBytes !== undefined && !descriptorHasExactBytes(expectedBytes))
    || (
      expectedMode !== undefined
      && (
        (descriptor.mode & 0o777n) !== expectedMode
        || (named.mode & 0o777n) !== expectedMode
      )
    )
  ) {
    throw new Error(label);
  }
}

function assertPublishedState(expectedNlink, expectedSize, expectedMode, expectedBytes) {
  const descriptor = fs.fstatSync(tempDescriptor, { bigint: true });
  const source = tempLeaf === undefined
    ? undefined
    : fs.lstatSync(tempLeaf, { bigint: true });
  const published = fs.lstatSync(leaf, { bigint: true });
  if (
    !descriptor.isFile()
    || (source !== undefined && !source.isFile())
    || !published.isFile()
    || !sameIdentity(descriptor, tempDev, tempIno)
    || (source !== undefined && !sameIdentity(source, tempDev, tempIno))
    || !sameIdentity(published, tempDev, tempIno)
    || descriptor.nlink !== expectedNlink
    || (source !== undefined && source.nlink !== expectedNlink)
    || published.nlink !== expectedNlink
    || descriptor.size !== expectedSize
    || (source !== undefined && source.size !== expectedSize)
    || published.size !== expectedSize
    || !descriptorHasExactBytes(expectedBytes)
    || (descriptor.mode & 0o777n) !== expectedMode
    || (source !== undefined && (source.mode & 0o777n) !== expectedMode)
    || (published.mode & 0o777n) !== expectedMode
  ) {
    throw new Error(
      "published output failed inode, link-count, exact-bytes, size, or mode verification",
    );
  }
}

try {
  if (!isValidLeaf(leaf)) {
    throw new Error("output leaf is invalid");
  }
  const mode = Number(modeText);
  if (!Number.isInteger(mode) || mode < 0 || (mode & ~0o777) !== 0) {
    throw new Error("output mode is invalid");
  }
  const bytes = fs.readFileSync(0);
  parentDescriptor = fs.openSync(".", directoryFlags);
  containerDescriptor = fs.openSync("..", directoryFlags);
  assertStableParent();

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = ".public-projection-"
      + process.pid
      + "-"
      + crypto.randomBytes(16).toString("hex")
      + ".tmp";
    if (!isValidLeaf(candidate)) throw new Error("temporary output leaf is invalid");
    try {
      tempDescriptor = fs.openSync(candidate, outputFlags, 0o600);
      tempLeaf = candidate;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (tempDescriptor === undefined || tempLeaf === undefined) {
    throw new Error("could not allocate a unique temporary output leaf");
  }
  const opened = fs.fstatSync(tempDescriptor, { bigint: true });
  if (!opened.isFile() || opened.size !== 0n || opened.nlink !== 1n) {
    throw new Error("temporary output descriptor is not a new regular file");
  }
  tempDev = opened.dev.toString();
  tempIno = opened.ino.toString();
  assertTempState(
    "temporary output failed create identity or link-count verification",
    1n,
    0n,
    undefined,
    undefined,
  );
  /* exclusive-temp-create-checkpoint */
  assertTempState(
    "temporary output changed after creation",
    1n,
    0n,
    undefined,
    undefined,
  );
  assertStableParent();

  let offset = 0;
  while (offset < bytes.length) {
    const length = Math.min(4096, bytes.length - offset);
    const written = fs.writeSync(tempDescriptor, bytes, offset, length, null);
    if (written <= 0) throw new Error("temporary output write made no progress");
    offset += written;
    /* exclusive-temp-write-checkpoint */
  }
  const written = fs.fstatSync(tempDescriptor, { bigint: true });
  if (
    !written.isFile()
    || !sameIdentity(written, tempDev, tempIno)
    || written.nlink !== 1n
    || written.size !== BigInt(bytes.length)
  ) {
    throw new Error("temporary output descriptor failed link-count or exact-size verification");
  }
  fs.fchmodSync(tempDescriptor, mode);
  fs.fsyncSync(tempDescriptor);
  assertTempState(
    "temporary output failed durable identity, link-count, size, or mode verification",
    1n,
    BigInt(bytes.length),
    BigInt(mode),
    bytes,
  );
  assertStableParent();

  assertTempState(
    "temporary output changed before atomic publish",
    1n,
    BigInt(bytes.length),
    BigInt(mode),
    bytes,
  );
  /* exclusive-pre-publish-checkpoint */
  fs.linkSync(tempLeaf, leaf);
  const linkedFinal = fs.lstatSync(leaf, { bigint: true });
  finalDev = linkedFinal.dev.toString();
  finalIno = linkedFinal.ino.toString();
  assertPublishedState(2n, BigInt(bytes.length), BigInt(mode), bytes);
  /* exclusive-publish-checkpoint */
  assertPublishedState(2n, BigInt(bytes.length), BigInt(mode), bytes);
  fs.unlinkSync(tempLeaf);
  tempLeaf = undefined;
  assertPublishedState(1n, BigInt(bytes.length), BigInt(mode), bytes);
  assertStableParent();
} catch (error) {
  if (tempDescriptor !== undefined) {
    fs.closeSync(tempDescriptor);
    tempDescriptor = undefined;
  }
  unlinkAnchoredEntryIfIdentity(leaf, finalDev, finalIno);
  unlinkTaskCreatedAliases(tempDev, tempIno);
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (tempDescriptor !== undefined) fs.closeSync(tempDescriptor);
  if (containerDescriptor !== undefined) fs.closeSync(containerDescriptor);
  if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
}
`;

function canonicalize(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PublicProjectionError("Canonical JSON rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const result: JsonRecord = {};
    for (const key of Object.keys(value as JsonRecord).sort()) {
      const entry = (value as JsonRecord)[key];
      if (entry === undefined) throw new PublicProjectionError(`Canonical JSON rejects undefined at ${key}`);
      result[key] = canonicalize(entry);
    }
    return result;
  }
  throw new PublicProjectionError(`Canonical JSON rejects ${typeof value}`);
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalize(value))}\n`, "utf8");
}

function canonicalJson(value: unknown): string {
  return canonicalJsonBytes(value).toString("utf8");
}

function assertCanonicalJsonBytes<T>(bytes: Buffer, label: string): T {
  let parsed: T;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    throw new PublicProjectionError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!bytes.equals(canonicalJsonBytes(parsed))) {
    throw new PublicProjectionError(`${label} bytes are not canonical JSON with one trailing newline`);
  }
  return parsed;
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new PublicProjectionError(`${label} must be a lowercase SHA-256`);
}

function assertGitObjectId(value: string, label: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new PublicProjectionError(`${label} must be a full Git object ID`);
  }
}

function gitBuffer(repo: string, args: string[]): Buffer {
  const safeArgs = ["--no-replace-objects", ...args];
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = devNull;
  try {
    return execFileSync("git", safeArgs, {
      cwd: repo,
      env,
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const details = error as { stderr?: Buffer; message?: string };
    const stderr = details.stderr?.toString("utf8").trim();
    throw new PublicProjectionError(`git ${safeArgs.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function gitText(repo: string, args: string[]): string {
  return gitBuffer(repo, args).toString("utf8").trim();
}

function optionalGitText(repo: string, args: string[]): string | null {
  try {
    return gitText(repo, args);
  } catch {
    return null;
  }
}

interface SourceIdentity {
  repository_identity_sha256: string;
  commit_sha: string;
  tree_sha: string;
  dirty: false;
}

function inspectCleanSource(sourceRoot: string): SourceIdentity {
  if (!fs.statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new PublicProjectionError("Source repository does not exist");
  }
  const dirty = gitBuffer(sourceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (dirty.length !== 0) throw new PublicProjectionError("Source worktree is dirty");
  const commitSha = gitText(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const treeSha = gitText(sourceRoot, ["rev-parse", `${commitSha}^{tree}`]);
  assertGitObjectId(commitSha, "source commit SHA");
  assertGitObjectId(treeSha, "source tree SHA");
  const remote = optionalGitText(sourceRoot, ["config", "--get", "remote.origin.url"]);
  const roots = gitText(sourceRoot, ["rev-list", "--max-parents=0", "--all"])
    .split(/\n/)
    .filter(Boolean)
    .sort();
  const repositoryIdentitySha256 = sha256Hex(canonicalJsonBytes({
    remote_url_sha256: remote ? sha256Hex(remote) : null,
    root_commits: roots,
  }));
  return {
    repository_identity_sha256: repositoryIdentitySha256,
    commit_sha: commitSha,
    tree_sha: treeSha,
    dirty: false,
  };
}

function readPolicy(policyPath: string): { policy: PublicProjectionPolicy; bytes: Buffer; sha256: string } {
  const bytes = fs.readFileSync(policyPath);
  let value: unknown;
  try {
    value = parseYaml(bytes.toString("utf8"));
  } catch (error) {
    throw new PublicProjectionError(
      `Projection policy is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertPolicy(value);
  return { policy: value, bytes, sha256: sha256Hex(bytes) };
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PublicProjectionError(`${label} must be a non-empty string`);
  }
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicProjectionError(`${label} must be an object`);
  }
  const actual = Object.keys(value as JsonRecord).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new PublicProjectionError(`${label} has unexpected keys or missing required keys`);
  }
}

function assertPolicy(value: unknown): asserts value is PublicProjectionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicProjectionError("Projection policy must be an object");
  }
  const policy = value as Partial<PublicProjectionPolicy>;
  assertExactKeys(
    policy,
    ["version", "verifier_version", "include", "exclude", "transforms", "secret_scan"],
    "Projection policy",
  );
  if (policy.version !== "public-projection-policy/v1") {
    throw new PublicProjectionError("Unsupported projection policy version");
  }
  if (policy.verifier_version !== PUBLIC_PROJECTION_VERIFIER_VERSION) {
    throw new PublicProjectionError("Projection policy verifier version mismatch");
  }
  for (const key of ["include", "exclude", "transforms"] as const) {
    if (!Array.isArray(policy[key])) throw new PublicProjectionError(`Projection policy ${key} must be an array`);
  }
  if (!policy.secret_scan || !Array.isArray(policy.secret_scan.approved_producers)
    || !Array.isArray(policy.secret_scan.approved_scanners)) {
    throw new PublicProjectionError("Projection policy secret_scan approvals are required");
  }
  assertExactKeys(policy.secret_scan, ["approved_producers", "approved_scanners"], "secret_scan policy");
  for (const item of policy.include ?? []) {
    assertExactKeys(item, ["pattern"], "include rule");
    assertNonEmptyString(item.pattern, "include pattern");
  }
  for (const item of policy.exclude ?? []) {
    assertExactKeys(item, ["pattern", "reason"], "exclude rule");
    assertNonEmptyString(item.pattern, "exclude pattern");
    assertNonEmptyString(item.reason, "exclude reason");
  }
  for (const item of policy.transforms ?? []) {
    assertExactKeys(item, ["pattern", "transform_id"], "transform rule");
    assertNonEmptyString(item.pattern, "transform pattern");
    if (item.transform_id !== "redact-local-user-paths-v1") {
      throw new PublicProjectionError(`Unknown projection transform: ${String(item.transform_id)}`);
    }
  }
  for (const producer of policy.secret_scan.approved_producers) {
    assertExactKeys(
      producer,
      ["producer_id", "wrapper_version", "wrapper_sha256", "verifier_sha256", "key_id"],
      "approved producer",
    );
    assertNonEmptyString(producer.producer_id, "approved producer ID");
    assertNonEmptyString(producer.wrapper_version, "approved wrapper version");
    assertSha256(producer.wrapper_sha256, "approved wrapper digest");
    assertSha256(producer.verifier_sha256, "approved verifier digest");
    assertNonEmptyString(producer.key_id, "approved producer key ID");
  }
  for (const scanner of policy.secret_scan.approved_scanners) {
    assertExactKeys(
      scanner,
      ["name", "version", "binary_sha256", "rules_sha256"],
      "approved scanner",
    );
    assertNonEmptyString(scanner.name, "approved scanner name");
    assertNonEmptyString(scanner.version, "approved scanner version");
    assertSha256(scanner.binary_sha256, "approved scanner binary digest");
    assertSha256(scanner.rules_sha256, "approved scanner rules digest");
  }
}

interface GitTreeEntry {
  pathBytes: Buffer;
  displayPath: string;
  mode: GitMode;
  type: PublicPathType;
  objectId: string;
  content: Buffer;
}

function displayPath(pathBytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(pathBytes);
  } catch {
    return `[base64:${pathBytes.toString("base64")}]`;
  }
}

function validateGitPath(pathBytes: Buffer): void {
  if (pathBytes.length === 0 || pathBytes.includes(0)) {
    throw new PublicProjectionError("Git path is empty or contains NUL");
  }
  if (pathBytes[0] === 0x2f) throw new PublicProjectionError("Absolute Git paths are not allowed");
  const parts = pathBytes.toString("latin1").split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new PublicProjectionError(`Unsafe Git path: ${displayPath(pathBytes)}`);
  }
}

function parseGitTree(repo: string, commit: string): GitTreeEntry[] {
  const output = gitBuffer(repo, ["ls-tree", "-rz", "--full-tree", commit]);
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0) {
      if (index > start) records.push(output.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== output.length) throw new PublicProjectionError("git ls-tree output was not NUL terminated");
  const entries = records.map((record): GitTreeEntry => {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new PublicProjectionError("Malformed git ls-tree record");
    const header = record.subarray(0, tab).toString("ascii").split(" ");
    if (header.length !== 3) throw new PublicProjectionError("Malformed git ls-tree header");
    const [rawMode, objectType, objectId] = header;
    if (rawMode === "160000" || objectType === "commit") {
      throw new PublicProjectionError("Gitlink/submodule mode 160000 is not allowed");
    }
    if (objectType !== "blob") throw new PublicProjectionError(`Unsupported Git object type ${objectType}`);
    if (rawMode !== "100644" && rawMode !== "100755" && rawMode !== "120000") {
      throw new PublicProjectionError(`Unsupported Git mode ${rawMode}`);
    }
    const pathBytes = Buffer.from(record.subarray(tab + 1));
    validateGitPath(pathBytes);
    const content = gitBuffer(repo, ["cat-file", "blob", objectId]);
    return {
      pathBytes,
      displayPath: displayPath(pathBytes),
      mode: rawMode,
      type: rawMode === "120000" ? "symlink" : "regular_file",
      objectId,
      content,
    };
  });
  return entries.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
}

function globRegex(pattern: string): RegExp {
  if (pattern.includes("\0")) throw new PublicProjectionError("Policy glob contains NUL");
  const bytes = Buffer.from(pattern, "utf8").toString("latin1");
  let source = "^";
  for (let index = 0; index < bytes.length; index += 1) {
    const char = bytes[index];
    if (char === "*") {
      if (bytes[index + 1] === "*") {
        index += 1;
        if (bytes[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "s");
}

function matches(pattern: string, pathBytes: Buffer): boolean {
  return globRegex(pattern).test(pathBytes.toString("latin1"));
}

function validateSymlinkTarget(entryPath: Buffer, target: Buffer): void {
  let targetText: string;
  try {
    targetText = new TextDecoder("utf-8", { fatal: true }).decode(target);
  } catch {
    throw new PublicProjectionError(`Symlink target for ${displayPath(entryPath)} is not valid UTF-8`);
  }
  if (targetText.length === 0 || targetText.startsWith("/") || targetText.includes("\0")) {
    throw new PublicProjectionError(`Symlink target for ${displayPath(entryPath)} is absolute or empty`);
  }
  const parentParts = entryPath.toString("utf8").split("/").slice(0, -1);
  for (const part of targetText.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parentParts.length === 0) {
        throw new PublicProjectionError(`Symlink target for ${displayPath(entryPath)} escapes staging`);
      }
      parentParts.pop();
    } else {
      parentParts.push(part);
    }
  }
}

function applyTransform(transformId: string, content: Buffer, display: string): Buffer {
  if (transformId !== "redact-local-user-paths-v1") {
    throw new PublicProjectionError(`Unknown projection transform ${transformId}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new PublicProjectionError(`Transform ${transformId} cannot process non-UTF-8 path ${display}`);
  }
  return Buffer.from(text.replaceAll(/\/Users\/[^/\s)>\]]+\//g, "/Users/operator/"), "utf8");
}

interface ComputedProjection extends ProjectionGenerationSnapshot {
  materialized: Array<{ pathBytes: Buffer; content: Buffer; mode: GitMode; type: PublicPathType }>;
}

function computeProjection(sourceRoot: string, policyPath: string): ComputedProjection {
  const source = inspectCleanSource(sourceRoot);
  const { policy, sha256: policySha256 } = readPolicy(policyPath);
  const sourceEntries = parseGitTree(sourceRoot, source.commit_sha);
  const publicEntries: PublicPathLedgerEntry[] = [];
  const policyLedger: ProjectionPolicyLedgerEntry[] = [];
  const materialized: ComputedProjection["materialized"] = [];

  for (const entry of sourceEntries) {
    const excluded = policy.exclude.find((rule) => matches(rule.pattern, entry.pathBytes));
    const transforms = policy.transforms.filter((rule) => matches(rule.pattern, entry.pathBytes));
    const included = policy.include.some((rule) => matches(rule.pattern, entry.pathBytes));
    if (transforms.length > 1) {
      throw new PublicProjectionError(`Multiple transforms match ${entry.displayPath}`);
    }
    if (!excluded && !included) {
      throw new PublicProjectionError(`Source path is not covered by projection policy: ${entry.displayPath}`);
    }
    const sourceHash = sha256Hex(entry.content);
    if (excluded) {
      policyLedger.push({
        path_b64: entry.pathBytes.toString("base64"),
        path: entry.displayPath,
        source_type: entry.type,
        source_mode: entry.mode,
        source_sha256: sourceHash,
        decision: "exclude",
        reason: excluded.reason,
        transform_id: null,
        public_sha256: null,
      });
      continue;
    }
    const transformId = transforms[0]?.transform_id ?? null;
    if (entry.type === "symlink") {
      if (transformId) throw new PublicProjectionError(`Transforms cannot target symlink ${entry.displayPath}`);
      validateSymlinkTarget(entry.pathBytes, entry.content);
    }
    const publicContent = transformId
      ? applyTransform(transformId, entry.content, entry.displayPath)
      : entry.content;
    const publicHash = sha256Hex(publicContent);
    const ledgerEntry: PublicPathLedgerEntry = {
      path_b64: entry.pathBytes.toString("base64"),
      path: entry.displayPath,
      type: entry.type,
      mode: entry.mode,
      sha256: publicHash,
      ...(entry.type === "symlink" ? { target_b64: publicContent.toString("base64") } : {}),
      source: {
        path_b64: entry.pathBytes.toString("base64"),
        transform_id: transformId,
      },
    };
    publicEntries.push(ledgerEntry);
    policyLedger.push({
      path_b64: entry.pathBytes.toString("base64"),
      path: entry.displayPath,
      source_type: entry.type,
      source_mode: entry.mode,
      source_sha256: sourceHash,
      decision: transformId ? "transform" : "include",
      reason: null,
      transform_id: transformId,
      public_sha256: publicHash,
    });
    materialized.push({
      pathBytes: entry.pathBytes,
      content: publicContent,
      mode: entry.mode,
      type: entry.type,
    });
  }
  assertCanonicalLedger(publicEntries);
  const publicPathLedgerSha256 = sha256Hex(canonicalJsonBytes(publicEntries));
  const publicPayloadSha256 = sha256Hex(canonicalJsonBytes(publicEntries.map(publicIdentity)));
  return {
    version: "public-projection-generation/v1",
    source,
    policy: {
      sha256: policySha256,
      verifier_version: PUBLIC_PROJECTION_VERIFIER_VERSION,
    },
    policy_ledger: policyLedger,
    public_path_ledger: publicEntries,
    public_path_ledger_sha256: publicPathLedgerSha256,
    public_payload_sha256: publicPayloadSha256,
    materialized,
  };
}

function absoluteBuffer(root: string, relativePath: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${path.resolve(root)}${path.sep}`), relativePath]);
}

function materializeProjection(
  outputRoot: string,
  protectedSourceRoot: string,
  projection: ComputedProjection,
): void {
  const resolvedOutput = ensureSafeOutputDirectory({
    outputPath: outputRoot,
    protectedRoot: protectedSourceRoot,
    label: "Projection output",
    mode: 0o755,
  });
  const existing = fs.lstatSync(resolvedOutput);
  if (existing && fs.readdirSync(resolvedOutput).length !== 0) {
    throw new PublicProjectionError("Projection output directory must be new and empty");
  }
  const directories = new Set<string>([Buffer.from(resolvedOutput).toString("base64")]);
  for (const entry of projection.materialized) {
    for (let index = 0; index < entry.pathBytes.length; index += 1) {
      if (entry.pathBytes[index] !== 0x2f) continue;
      const parent = absoluteBuffer(resolvedOutput, entry.pathBytes.subarray(0, index));
      fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
      directories.add(parent.toString("base64"));
    }
    const destination = absoluteBuffer(resolvedOutput, entry.pathBytes);
    if (entry.type === "symlink") {
      fs.symlinkSync(entry.content, destination);
    } else {
      fs.writeFileSync(destination, entry.content, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
  }
  for (const entry of projection.materialized) {
    if (entry.type === "regular_file") {
      fs.chmodSync(absoluteBuffer(resolvedOutput, entry.pathBytes), entry.mode === "100755" ? 0o555 : 0o444);
    }
  }
  const sortedDirectories = [...directories]
    .map((encoded) => Buffer.from(encoded, "base64"))
    .sort((left, right) => right.length - left.length);
  for (const directory of sortedDirectories) fs.chmodSync(directory, 0o555);
}

export function generatePublicProjection(options: {
  sourceRoot: string;
  outputRoot: string;
  policyPath: string;
}): ProjectionGenerationSnapshot {
  const source = path.resolve(options.sourceRoot);
  const output = path.resolve(options.outputRoot);
  if (output === source || output.startsWith(`${source}${path.sep}`)) {
    throw new PublicProjectionError("Projection output must be outside the source worktree");
  }
  const projection = computeProjection(source, options.policyPath);
  materializeProjection(output, source, projection);
  const { materialized: _materialized, ...snapshot } = projection;
  return snapshot;
}

interface StagingInspection {
  identities: Array<Omit<PublicPathLedgerEntry, "source">>;
  public_payload_sha256: string;
}

function joinRaw(root: Buffer, name: Buffer): Buffer {
  return Buffer.concat([root, Buffer.from("/"), name]);
}

function inspectStaging(stagingRoot: string): StagingInspection {
  const root = path.resolve(stagingRoot);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PublicProjectionError("Staging root must be a real directory");
  }
  if ((rootStat.mode & 0o222) !== 0) {
    throw new PublicProjectionError("Staging state changed: directory . is writable");
  }
  const identities: StagingInspection["identities"] = [];
  const walk = (absolute: Buffer, relative: Buffer): void => {
    const names = fs.readdirSync(absolute, { encoding: "buffer" }).sort(Buffer.compare);
    for (const name of names) {
      const childAbsolute = joinRaw(absolute, name);
      const childRelative = relative.length === 0 ? name : joinRaw(relative, name);
      validateGitPath(childRelative);
      const stat = fs.lstatSync(childAbsolute);
      if (stat.isDirectory()) {
        if ((stat.mode & 0o222) !== 0) {
          throw new PublicProjectionError(
            `Staging state changed: directory ${displayPath(childRelative)} is writable`,
          );
        }
        walk(childAbsolute, childRelative);
      } else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(childAbsolute, { encoding: "buffer" });
        validateSymlinkTarget(childRelative, target);
        identities.push({
          path_b64: childRelative.toString("base64"),
          path: displayPath(childRelative),
          type: "symlink",
          mode: "120000",
          sha256: sha256Hex(target),
          target_b64: target.toString("base64"),
        });
      } else if (stat.isFile()) {
        const mode: GitMode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
        identities.push({
          path_b64: childRelative.toString("base64"),
          path: displayPath(childRelative),
          type: "regular_file",
          mode,
          sha256: sha256Hex(fs.readFileSync(childAbsolute)),
        });
      } else {
        throw new PublicProjectionError(`Unsupported staging path type: ${displayPath(childRelative)}`);
      }
    }
  };
  walk(Buffer.from(root), Buffer.alloc(0));
  identities.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path_b64, "base64"), Buffer.from(right.path_b64, "base64"))
  );
  return {
    identities,
    public_payload_sha256: sha256Hex(canonicalJsonBytes(identities)),
  };
}

function publicIdentity(
  entry: PublicPathLedgerEntry,
): Omit<PublicPathLedgerEntry, "source"> {
  return {
    path_b64: entry.path_b64,
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    sha256: entry.sha256,
    ...(entry.target_b64 === undefined ? {} : { target_b64: entry.target_b64 }),
  };
}

function assertCanonicalLedger(entries: PublicPathLedgerEntry[]): void {
  const seen = new Set<string>();
  let previous: Buffer | null = null;
  for (const entry of entries) {
    assertExactKeys(
      entry,
      entry.type === "symlink"
        ? ["path_b64", "path", "type", "mode", "sha256", "target_b64", "source"]
        : ["path_b64", "path", "type", "mode", "sha256", "source"],
      "Public path ledger entry",
    );
    assertExactKeys(entry.source, ["path_b64", "transform_id"], "Public path source mapping");
    const raw = Buffer.from(entry.path_b64, "base64");
    if (raw.toString("base64") !== entry.path_b64) {
      throw new PublicProjectionError("Public path ledger contains invalid path_b64");
    }
    validateGitPath(raw);
    if (seen.has(entry.path_b64)) throw new PublicProjectionError("Public path ledger contains duplicate path");
    if (previous && Buffer.compare(previous, raw) >= 0) {
      throw new PublicProjectionError("Public path ledger is not in canonical byte order");
    }
    seen.add(entry.path_b64);
    previous = raw;
    assertSha256(entry.sha256, "public path content SHA-256");
    if (entry.type === "symlink") {
      if (entry.mode !== "120000" || entry.target_b64 === undefined) {
        throw new PublicProjectionError("Symlink ledger entry has invalid mode or target");
      }
      const target = Buffer.from(entry.target_b64, "base64");
      if (target.toString("base64") !== entry.target_b64 || sha256Hex(target) !== entry.sha256) {
        throw new PublicProjectionError("Symlink ledger target/hash mismatch");
      }
      validateSymlinkTarget(raw, target);
    } else if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new PublicProjectionError("Regular-file ledger entry has invalid mode");
    }
  }
}

function assertSnapshotCurrent(options: {
  sourceRoot: string;
  stagingRoot: string;
  policyPath: string;
  snapshot: ProjectionGenerationSnapshot;
}): void {
  const recomputed = computeProjection(options.sourceRoot, options.policyPath);
  if (canonicalJson(recomputed.source) !== canonicalJson(options.snapshot.source)) {
    throw new PublicProjectionError("Source identity changed after projection generation");
  }
  if (canonicalJson(recomputed.policy) !== canonicalJson(options.snapshot.policy)) {
    throw new PublicProjectionError("Projection policy changed after projection generation");
  }
  if (canonicalJson(recomputed.policy_ledger) !== canonicalJson(options.snapshot.policy_ledger)
    || canonicalJson(recomputed.public_path_ledger) !== canonicalJson(options.snapshot.public_path_ledger)) {
    throw new PublicProjectionError("Source/policy projection changed after generation");
  }
  const staging = inspectStaging(options.stagingRoot);
  const expectedIdentities = options.snapshot.public_path_ledger.map(publicIdentity);
  if (canonicalJson(staging.identities) !== canonicalJson(expectedIdentities)
    || staging.public_payload_sha256 !== options.snapshot.public_payload_sha256) {
    throw new PublicProjectionError("Immutable staging payload changed after scan");
  }
  const ledgerHash = sha256Hex(canonicalJsonBytes(options.snapshot.public_path_ledger));
  if (ledgerHash !== options.snapshot.public_path_ledger_sha256) {
    throw new PublicProjectionError("Public path ledger hash mismatch");
  }
}

function assertAttestation(
  value: unknown,
  policy: PublicProjectionPolicy,
  targetPayloadSha256: string,
): {
  attestation: PublicProjectionScanAttestation;
  approvedProducer: PublicProjectionPolicy["secret_scan"]["approved_producers"][number];
} {
  if (!value || typeof value !== "object") throw new PublicProjectionError("Scan attestation must be an object");
  const attestation = value as PublicProjectionScanAttestation;
  assertExactKeys(
    attestation,
    ["version", "producer", "scanner", "target_payload_sha256", "result"],
    "Scan attestation",
  );
  assertExactKeys(
    attestation.producer,
    ["producer_id", "wrapper_version", "wrapper_sha256", "verifier_sha256", "key_id"],
    "Scan producer",
  );
  assertExactKeys(
    attestation.scanner,
    ["name", "version", "binary_sha256", "rules_sha256"],
    "Scan scanner",
  );
  assertExactKeys(attestation.result, ["status", "exit_code", "finding_count"], "Scan result");
  if (attestation.version !== "public-projection-scan-attestation/v1") {
    throw new PublicProjectionError("Unsupported scan attestation version");
  }
  const approvedProducer = policy.secret_scan.approved_producers.find((candidate) =>
    candidate.producer_id === attestation.producer?.producer_id
    && candidate.wrapper_version === attestation.producer?.wrapper_version
    && candidate.wrapper_sha256 === attestation.producer?.wrapper_sha256
    && candidate.verifier_sha256 === attestation.producer?.verifier_sha256
    && candidate.key_id === attestation.producer?.key_id
  );
  if (!approvedProducer) throw new PublicProjectionError("Scan attestation producer is not approved");
  const approvedScanner = policy.secret_scan.approved_scanners.find((candidate) =>
    candidate.name === attestation.scanner?.name
    && candidate.version === attestation.scanner?.version
    && candidate.binary_sha256 === attestation.scanner?.binary_sha256
    && candidate.rules_sha256 === attestation.scanner?.rules_sha256
  );
  if (!approvedScanner) throw new PublicProjectionError("Scan attestation scanner identity is not approved");
  assertSha256(attestation.scanner.binary_sha256, "scanner binary digest");
  assertSha256(attestation.scanner.rules_sha256, "scanner rules digest");
  if (attestation.target_payload_sha256 !== targetPayloadSha256) {
    throw new PublicProjectionError("Scan attestation target payload does not match immutable staging");
  }
  if (attestation.result?.exit_code !== 0) throw new PublicProjectionError("Secret scan exit code is non-zero");
  if (attestation.result?.finding_count !== 0) throw new PublicProjectionError("Secret scan reported findings");
  if (attestation.result?.status !== "clean") throw new PublicProjectionError("Secret scan result is not clean");
  return { attestation, approvedProducer };
}

function assertVerification(
  verification: AttestationVerification,
  attestation: PublicProjectionScanAttestation,
  expectedMechanism: AttestationVerification["mechanism"],
): void {
  if (!verification || typeof verification !== "object") {
    throw new PublicProjectionError("Attestation verifier did not return a trusted verification receipt");
  }
  assertExactKeys(
    verification,
    ["mechanism", "verifier_id", "producer_id", "key_id"],
    "Attestation verification",
  );
  if (verification.mechanism !== expectedMechanism) {
    throw new PublicProjectionError(
      "Attestation verification mechanism does not match the exclusive evidence route",
    );
  }
  assertNonEmptyString(verification.verifier_id, "attestation verifier ID");
  if (verification.producer_id !== attestation.producer.producer_id
    || verification.key_id !== attestation.producer.key_id) {
    throw new PublicProjectionError("Attestation verification identity mismatch");
  }
}

type PublicProjectionReceiptBuildOptions = {
  sourceRoot: string;
  stagingRoot: string;
  policyPath: string;
  generationSnapshot: ProjectionGenerationSnapshot;
  attestationBytes: Buffer;
  attestationVerifier: ApprovedAttestationVerifier;
} & (
  | {
    signatureBytes: Buffer;
    verificationEvidence?: never;
  }
  | {
    signatureBytes?: never;
    verificationEvidence: AttestationVerificationEvidence;
  }
);

export function buildPublicProjectionReceipt(
  options: PublicProjectionReceiptBuildOptions,
): PublicProjectionReceipt {
  if (options.signatureBytes && options.verificationEvidence) {
    throw new PublicProjectionError("Stage A verification evidence routes are mutually exclusive");
  }
  const verificationEvidence: AttestationVerificationEvidence = options.verificationEvidence ?? {
    mechanism: "detached-signature",
    bytes: options.signatureBytes ?? Buffer.alloc(0),
  };
  if (verificationEvidence.bytes.length === 0) {
    throw new PublicProjectionError(
      verificationEvidence.mechanism === "detached-signature"
        ? "Detached scan signature is required"
        : "Approved wrapper execution receipt is required",
    );
  }
  assertSnapshotCurrent({
    sourceRoot: options.sourceRoot,
    stagingRoot: options.stagingRoot,
    policyPath: options.policyPath,
    snapshot: options.generationSnapshot,
  });
  const { policy } = readPolicy(options.policyPath);
  const parsedAttestation = assertCanonicalJsonBytes<unknown>(options.attestationBytes, "Scan attestation");
  const { attestation, approvedProducer } = assertAttestation(
    parsedAttestation,
    policy,
    options.generationSnapshot.public_payload_sha256,
  );
  const verification = options.attestationVerifier.verify({
    attestation,
    attestationBytes: options.attestationBytes,
    verificationEvidence,
    signatureBytes: verificationEvidence.bytes,
    approvedProducer,
  });
  assertVerification(verification, attestation, verificationEvidence.mechanism);
  assertSnapshotCurrent({
    sourceRoot: options.sourceRoot,
    stagingRoot: options.stagingRoot,
    policyPath: options.policyPath,
    snapshot: options.generationSnapshot,
  });
  const { version: _generationVersion, ...snapshot } = options.generationSnapshot;
  const secretScanCommon = {
    attestation,
    attestation_sha256: sha256Hex(options.attestationBytes),
  };
  const secretScan: PublicProjectionSecretScan = verification.mechanism === "detached-signature"
    ? {
      ...secretScanCommon,
      detached_signature_b64: verificationEvidence.bytes.toString("base64"),
      verification,
    }
    : {
      ...secretScanCommon,
      approved_wrapper_execution_receipt_b64: verificationEvidence.bytes.toString("base64"),
      verification,
    };
  return {
    version: "public-projection-receipt/v1",
    ...snapshot,
    secret_scan: secretScan,
  };
}

function receiptSnapshot(receipt: PublicProjectionReceipt): ProjectionGenerationSnapshot {
  return {
    version: "public-projection-generation/v1",
    source: receipt.source,
    policy: receipt.policy,
    policy_ledger: receipt.policy_ledger,
    public_path_ledger: receipt.public_path_ledger,
    public_path_ledger_sha256: receipt.public_path_ledger_sha256,
    public_payload_sha256: receipt.public_payload_sha256,
  };
}

function assertReceiptCore(receipt: PublicProjectionReceipt): void {
  assertExactKeys(
    receipt,
    [
      "version",
      "source",
      "policy",
      "policy_ledger",
      "public_path_ledger",
      "public_path_ledger_sha256",
      "public_payload_sha256",
      "secret_scan",
    ],
    "Stage A receipt",
  );
  if (receipt.version !== "public-projection-receipt/v1") {
    throw new PublicProjectionError("Unsupported Stage A receipt version");
  }
  assertExactKeys(
    receipt.source,
    ["repository_identity_sha256", "commit_sha", "tree_sha", "dirty"],
    "Stage A source",
  );
  assertExactKeys(receipt.policy, ["sha256", "verifier_version"], "Stage A policy");
  if (receipt.source?.dirty !== false) throw new PublicProjectionError("Stage A source must be clean");
  assertSha256(receipt.source?.repository_identity_sha256, "source repository identity");
  assertGitObjectId(receipt.source?.commit_sha, "source commit SHA");
  assertGitObjectId(receipt.source?.tree_sha, "source tree SHA");
  assertSha256(receipt.policy?.sha256, "policy SHA-256");
  if (receipt.policy.verifier_version !== PUBLIC_PROJECTION_VERIFIER_VERSION) {
    throw new PublicProjectionError("Stage A verifier version mismatch");
  }
  if (!Array.isArray(receipt.policy_ledger)) throw new PublicProjectionError("Stage A policy ledger is missing");
  for (const entry of receipt.policy_ledger) {
    assertExactKeys(
      entry,
      [
        "path_b64",
        "path",
        "source_type",
        "source_mode",
        "source_sha256",
        "decision",
        "reason",
        "transform_id",
        "public_sha256",
      ],
      "Stage A policy ledger entry",
    );
  }
  assertCanonicalLedger(receipt.public_path_ledger ?? []);
  const ledgerHash = sha256Hex(canonicalJsonBytes(receipt.public_path_ledger));
  if (ledgerHash !== receipt.public_path_ledger_sha256) {
    throw new PublicProjectionError("Stage A public path ledger hash mismatch");
  }
  const payloadHash = sha256Hex(canonicalJsonBytes(receipt.public_path_ledger.map(publicIdentity)));
  if (payloadHash !== receipt.public_payload_sha256) {
    throw new PublicProjectionError("Stage A public payload hash mismatch");
  }
  const mechanism = receipt.secret_scan?.verification?.mechanism;
  if (
    mechanism !== "detached-signature"
    && mechanism !== "approved-wrapper-execution-receipt"
  ) throw new PublicProjectionError("Unsupported attestation verification mechanism");
  const evidenceKey = mechanism === "detached-signature"
    ? "detached_signature_b64"
    : "approved_wrapper_execution_receipt_b64";
  assertExactKeys(
    receipt.secret_scan,
    ["attestation", "attestation_sha256", evidenceKey, "verification"],
    "Stage A secret scan exclusive evidence",
  );
  const attestationBytes = canonicalJsonBytes(receipt.secret_scan.attestation);
  if (sha256Hex(attestationBytes) !== receipt.secret_scan.attestation_sha256) {
    throw new PublicProjectionError("Stage A scan attestation hash mismatch");
  }
  const evidenceBase64 = receipt.secret_scan[evidenceKey];
  assertNonEmptyString(evidenceBase64, "Stage A verification evidence");
  const evidence = Buffer.from(evidenceBase64, "base64");
  if (
    evidence.length === 0
    || evidence.toString("base64") !== evidenceBase64
  ) throw new PublicProjectionError("Stage A verification evidence is missing or invalid");
  const scanPolicy: PublicProjectionPolicy = {
    version: "public-projection-policy/v1",
    verifier_version: PUBLIC_PROJECTION_VERIFIER_VERSION,
    include: [],
    exclude: [],
    transforms: [],
    secret_scan: {
      approved_producers: [receipt.secret_scan.attestation.producer],
      approved_scanners: [receipt.secret_scan.attestation.scanner],
    },
  };
  assertAttestation(receipt.secret_scan.attestation, scanPolicy, receipt.public_payload_sha256);
  assertVerification(receipt.secret_scan.verification, receipt.secret_scan.attestation, mechanism);
}

export function verifyPublicProjectionReceipt(options: {
  sourceRoot: string;
  stagingRoot: string;
  policyPath: string;
  receiptBytes: Buffer;
  attestationVerifier: ApprovedAttestationVerifier;
}): PublicProjectionReceipt {
  const receipt = assertCanonicalJsonBytes<PublicProjectionReceipt>(
    options.receiptBytes,
    "Stage A receipt",
  );
  assertReceiptCore(receipt);
  const verificationEvidence: AttestationVerificationEvidence =
    "detached_signature_b64" in receipt.secret_scan
      ? {
        mechanism: "detached-signature",
        bytes: Buffer.from(receipt.secret_scan.detached_signature_b64, "base64"),
      }
      : {
        mechanism: "approved-wrapper-execution-receipt",
        bytes: Buffer.from(
          receipt.secret_scan.approved_wrapper_execution_receipt_b64,
          "base64",
        ),
      };
  const rebuilt = buildPublicProjectionReceipt({
    sourceRoot: options.sourceRoot,
    stagingRoot: options.stagingRoot,
    policyPath: options.policyPath,
    generationSnapshot: receiptSnapshot(receipt),
    attestationBytes: canonicalJsonBytes(receipt.secret_scan.attestation),
    verificationEvidence,
    attestationVerifier: options.attestationVerifier,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(receipt)) {
    throw new PublicProjectionError("Stage A receipt does not match recomputed source/policy/staging/scan state");
  }
  return receipt;
}

function exactPublicCommit(publicRepository: string, commit: string): string {
  assertGitObjectId(commit, "full exact public commit SHA");
  const resolved = gitText(publicRepository, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (resolved !== commit) throw new PublicProjectionError("Full exact public commit did not resolve to itself");
  return resolved;
}

function assertCanonicalPublicCommit(
  publicRepository: string,
  commit: string,
  treeSha: string,
  stageAReceiptSha256: string,
): void {
  const identity = `${PUBLIC_PROJECTION_COMMIT_AUTHOR_NAME} <${PUBLIC_PROJECTION_COMMIT_AUTHOR_EMAIL}> ${PUBLIC_PROJECTION_COMMIT_TIMESTAMP}`;
  const expected = Buffer.from([
    `tree ${treeSha}`,
    `author ${identity}`,
    `committer ${identity}`,
    "",
    canonicalPublicProjectionCommitMessage(stageAReceiptSha256),
  ].join("\n"), "utf8");
  const rawCommit = gitBuffer(publicRepository, ["cat-file", "commit", commit]);
  if (!rawCommit.equals(expected)) {
    throw new PublicProjectionError(
      "Exact public commit must be an isolated root commit with canonical metadata bound to the Stage A receipt",
    );
  }
}

function commitPublicLedger(publicRepository: string, commit: string): {
  treeSha: string;
  identities: Array<Omit<PublicPathLedgerEntry, "source">>;
} {
  const treeSha = gitText(publicRepository, ["rev-parse", `${commit}^{tree}`]);
  assertGitObjectId(treeSha, "public tree SHA");
  const entries = parseGitTree(publicRepository, commit);
  const identities = entries.map((entry): Omit<PublicPathLedgerEntry, "source"> => ({
    path_b64: entry.pathBytes.toString("base64"),
    path: entry.displayPath,
    type: entry.type,
    mode: entry.mode,
    sha256: sha256Hex(entry.content),
    ...(entry.type === "symlink" ? { target_b64: entry.content.toString("base64") } : {}),
  }));
  return { treeSha, identities };
}

function compareCommitLedger(
  stageAEntries: PublicPathLedgerEntry[],
  commitEntries: Array<Omit<PublicPathLedgerEntry, "source">>,
): void {
  const expected = stageAEntries.map(publicIdentity);
  const expectedByPath = new Map(expected.map((entry) => [entry.path_b64, entry]));
  const actualByPath = new Map(commitEntries.map((entry) => [entry.path_b64, entry]));
  for (const entry of expected) {
    const actual = actualByPath.get(entry.path_b64);
    if (!actual) throw new PublicProjectionError(`Public path ledger missing ${entry.path}`);
    if (entry.type !== actual.type) throw new PublicProjectionError(`Public path ledger type mismatch at ${entry.path}`);
    if (entry.mode !== actual.mode) throw new PublicProjectionError(`Public path ledger mode mismatch at ${entry.path}`);
    if (entry.sha256 !== actual.sha256) throw new PublicProjectionError(`Public path ledger content mismatch at ${entry.path}`);
    if (entry.target_b64 !== actual.target_b64) {
      throw new PublicProjectionError(`Public path ledger symlink target mismatch at ${entry.path}`);
    }
  }
  for (const entry of commitEntries) {
    if (!expectedByPath.has(entry.path_b64)) {
      throw new PublicProjectionError(`Public path ledger has extra commit path ${entry.path}`);
    }
  }
}

export function verifyCanonicalPublicProjectionCommit(options: {
  stageAReceiptBytes: Buffer;
  publicRepository: string;
  exactPublicCommit: string;
}): {
  receipt: PublicProjectionReceipt;
  publicCommitSha: string;
  publicTreeSha: string;
  publicPathCount: number;
} {
  const receipt = assertCanonicalJsonBytes<PublicProjectionReceipt>(
    options.stageAReceiptBytes,
    "Stage A receipt",
  );
  assertReceiptCore(receipt);
  const commit = exactPublicCommit(options.publicRepository, options.exactPublicCommit);
  const { treeSha, identities } = commitPublicLedger(options.publicRepository, commit);
  compareCommitLedger(receipt.public_path_ledger, identities);
  assertCanonicalPublicCommit(
    options.publicRepository,
    commit,
    treeSha,
    sha256Hex(options.stageAReceiptBytes),
  );
  return {
    receipt,
    publicCommitSha: commit,
    publicTreeSha: treeSha,
    publicPathCount: identities.length,
  };
}

function assertDestination(destination: PromotionDestination): void {
  assertExactKeys(
    destination,
    ["provider", "repository_id", "repository_full_name", "branch"],
    "Promotion destination",
  );
  if (destination?.provider !== "github") throw new PublicProjectionError("Unsupported destination provider");
  assertNonEmptyString(destination.repository_id, "destination repository ID");
  if (!/^[^/\s]+\/[^/\s]+$/.test(destination.repository_full_name ?? "")) {
    throw new PublicProjectionError("Destination repository full name must be owner/repository");
  }
  assertNonEmptyString(destination.branch, "destination branch");
}

function assertEvidenceVerificationShape(
  verification: EvidenceVerification,
  label: string,
  expectedMechanism?: EvidenceVerification["mechanism"],
): void {
  if (!verification || typeof verification !== "object") {
    throw new PublicProjectionError(`${label} lacks a trusted verification receipt`);
  }
  assertExactKeys(
    verification,
    ["mechanism", "verifier_id", "evidence_sha256"],
    `${label} verification`,
  );
  if (
    verification.mechanism !== "provider-api-execution-receipt"
    && verification.mechanism !== "cockpit-approval-event"
    && verification.mechanism !== "detached-signature"
  ) throw new PublicProjectionError(`${label} uses an unsupported trust mechanism`);
  if (expectedMechanism && verification.mechanism !== expectedMechanism) {
    throw new PublicProjectionError(
      `${label} verification mechanism must be ${expectedMechanism}`,
    );
  }
  assertNonEmptyString(verification.verifier_id, `${label} verifier ID`);
  assertSha256(verification.evidence_sha256, `${label} evidence digest`);
}

function assertEvidenceVerification(
  bytes: Buffer,
  verification: EvidenceVerification,
  label: string,
  expectedMechanism: EvidenceVerification["mechanism"],
): void {
  assertEvidenceVerificationShape(verification, label, expectedMechanism);
  if (verification.evidence_sha256 !== sha256Hex(bytes)) {
    throw new PublicProjectionError(`${label} verification digest mismatch`);
  }
}

function assertExactObject(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) throw new PublicProjectionError(`${label} mismatch`);
}

function assertCiEvidence(
  ci: PromotionCiEvidence,
  destination: PromotionDestination,
  commit: string,
  workflowPath: string,
  workflowBlobSha: string,
  approval: PromotionApprovalReceipt,
): void {
  assertExactKeys(
    ci,
    ["version", "repository", "workflow", "run", "required_jobs", "product_gate"],
    "CI evidence",
  );
  assertExactKeys(
    ci.repository,
    ["provider", "repository_id", "repository_full_name"],
    "CI repository",
  );
  assertExactKeys(ci.workflow, ["path", "blob_sha"], "CI workflow");
  assertExactKeys(
    ci.run,
    ["id", "attempt", "event", "head_sha", "head_branch", "url", "conclusion"],
    "CI run",
  );
  assertExactKeys(ci.product_gate, ["name", "result"], "CI product-gate");
  if (ci?.version !== "public-ci-evidence/v1") throw new PublicProjectionError("Unsupported CI evidence version");
  assertExactObject(ci.repository, {
    provider: destination.provider,
    repository_id: destination.repository_id,
    repository_full_name: destination.repository_full_name,
  }, "CI repository identity");
  if (ci.workflow?.path !== workflowPath) throw new PublicProjectionError("CI workflow path mismatch");
  if (ci.workflow?.blob_sha !== workflowBlobSha) throw new PublicProjectionError("CI workflow blob SHA mismatch");
  assertNonEmptyString(ci.run?.id, "CI run ID");
  if (!Number.isSafeInteger(ci.run?.attempt) || ci.run.attempt < 1) {
    throw new PublicProjectionError("CI run attempt must be a positive integer");
  }
  if (ci.run.head_sha !== commit) throw new PublicProjectionError("CI head SHA mismatch");
  if (ci.run.head_branch !== canonicalPublicProjectionCandidateBranch(commit)) {
    throw new PublicProjectionError("CI head branch is not the canonical exact-commit candidate branch");
  }
  if (ci.run.event !== approval.operation_scope.event) throw new PublicProjectionError("CI event is outside approval scope");
  const runUrl = new URL(ci.run.url);
  const expectedRunPath = `/${destination.repository_full_name}/actions/runs/${ci.run.id}`;
  const expectedAttemptPath = `${expectedRunPath}/attempts/${ci.run.attempt}`;
  if (
    runUrl.protocol !== "https:"
    || runUrl.hostname !== "github.com"
    || runUrl.search !== ""
    || runUrl.hash !== ""
    || (runUrl.pathname !== expectedRunPath && runUrl.pathname !== expectedAttemptPath)
  ) {
    throw new PublicProjectionError("CI run URL is not a canonical GitHub Actions run URL");
  }
  if (ci.run.conclusion !== "success") throw new PublicProjectionError("CI run conclusion is not success");
  if (!Array.isArray(ci.required_jobs)) {
    throw new PublicProjectionError("CI required jobs must be an array");
  }
  const expectedJobs = new Set<string>(REQUIRED_PUBLIC_BOUNDARY_JOBS);
  const seen = new Set<string>();
  for (const job of ci.required_jobs ?? []) {
    assertExactKeys(job, ["name", "result"], "CI required job");
    if (seen.has(job.name)) throw new PublicProjectionError(`CI required jobs contain duplicate ${job.name}`);
    seen.add(job.name);
    if (!expectedJobs.has(job.name)) throw new PublicProjectionError(`CI required jobs contain extra ${job.name}`);
    if (job.result !== "success") throw new PublicProjectionError(`CI required job ${job.name} is ${job.result}`);
  }
  for (const name of expectedJobs) {
    if (!seen.has(name)) throw new PublicProjectionError(`CI required job is missing: ${name}`);
  }
  if (ci.product_gate?.name !== "product-gate" || ci.product_gate.result !== "success") {
    throw new PublicProjectionError("CI product-gate is not success");
  }
}

export function isRfc3339DateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
    value,
  );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (
    month < 1
    || month > 12
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day < 1 || day > daysInMonth[month - 1]) return false;
  return Number.isFinite(Date.parse(value));
}

export function approvalVerificationMechanism(
  approval: PromotionApprovalReceipt,
): EvidenceVerification["mechanism"] {
  return approval.version === "external-signed-promotion-approval/v1"
    ? "detached-signature"
    : "cockpit-approval-event";
}

function assertApprovalCore(
  approval: PromotionApprovalReceipt,
  stageAReceiptSha256: string,
  destination: PromotionDestination,
  workflowPath: string,
): void {
  assertExactKeys(approval.approver, ["identity"], "Promotion approver");
  assertExactKeys(
    approval.operation_scope,
    ["operation", "event", "workflow_path"],
    "Promotion approval scope",
  );
  assertNonEmptyString(approval.approval_id, "approval ID");
  assertNonEmptyString(approval.approver?.identity, "human approver identity");
  if (typeof approval.approved_at !== "string" || !isRfc3339DateTime(approval.approved_at)) {
    throw new PublicProjectionError(
      "Approval time must use the supported RFC 3339 subset with seconds 00 through 59",
    );
  }
  if (approval.stage_a_receipt_sha256 !== stageAReceiptSha256) {
    throw new PublicProjectionError("Approval Stage A SHA mismatch");
  }
  assertExactObject(approval.destination, destination, "Approval destination");
  if (approval.operation_scope?.operation !== "push-exact-projection") {
    throw new PublicProjectionError("Approval operation scope is ambiguous or overbroad");
  }
  assertNonEmptyString(approval.operation_scope.event, "approval event scope");
  if (approval.operation_scope.workflow_path !== workflowPath) {
    throw new PublicProjectionError("Approval workflow scope mismatch");
  }
}

function assertApproval(
  approval: PromotionApprovalReceipt,
  stageAReceiptSha256: string,
  destination: PromotionDestination,
  workflowPath: string,
): void {
  if (approval?.version === "external-signed-promotion-approval/v1") {
    assertExactKeys(
      approval,
      [
        "version",
        "approval_id",
        "approver",
        "approved_at",
        "stage_a_receipt_sha256",
        "destination",
        "operation_scope",
      ],
      "Promotion approval",
    );
    assertApprovalCore(approval, stageAReceiptSha256, destination, workflowPath);
    if (approval.approver.identity.startsWith("cockpit:")) {
      throw new PublicProjectionError("External signed approval must not use a Cockpit identity");
    }
    return;
  }
  assertExactKeys(
    approval,
    [
      "version",
      "approval_id",
      "approver",
      "approved_at",
      "stage_a_receipt_sha256",
      "destination",
      "operation_scope",
      "cockpit_source",
    ],
    "Promotion approval",
  );
  if (approval?.version !== "promotion-approval-receipt/v1") {
    throw new PublicProjectionError("Unsupported approval receipt version");
  }
  assertExactKeys(approval.cockpit_source, ["task_id", "event_id"], "Cockpit approval source");
  assertApprovalCore(approval, stageAReceiptSha256, destination, workflowPath);
  assertNonEmptyString(approval.cockpit_source?.task_id, "durable Cockpit task reference");
  assertNonEmptyString(approval.cockpit_source?.event_id, "durable Cockpit event reference");
}

function assertPromotionEnvelopeShape(envelope: PromotionEnvelope): void {
  assertExactKeys(
    envelope,
    [
      "version",
      "stage_a_receipt_sha256",
      "stage_a_public_path_ledger_sha256",
      "stage_a_verification",
      "public_commit_sha",
      "public_tree_sha",
      "public_path_count",
      "destination",
      "workflow",
      "ci",
      "approval",
    ],
    "Promotion envelope",
  );
  if (envelope.version !== "promotion-envelope/v1") {
    throw new PublicProjectionError("Unsupported promotion envelope version");
  }
  assertSha256(envelope.stage_a_receipt_sha256, "Stage A receipt digest");
  assertSha256(
    envelope.stage_a_public_path_ledger_sha256,
    "Stage A public path ledger digest",
  );
  assertEvidenceVerificationShape(
    envelope.stage_a_verification,
    "Stage A receipt evidence",
    "detached-signature",
  );
  assertGitObjectId(envelope.public_commit_sha, "public commit SHA");
  assertGitObjectId(envelope.public_tree_sha, "public tree SHA");
  if (!Number.isSafeInteger(envelope.public_path_count) || envelope.public_path_count < 1) {
    throw new PublicProjectionError("Promotion envelope public path count must be a positive integer");
  }
  assertDestination(envelope.destination);
  assertExactKeys(envelope.workflow, ["path", "blob_sha"], "Promotion envelope workflow");
  assertNonEmptyString(envelope.workflow.path, "promotion envelope workflow path");
  validateGitPath(Buffer.from(envelope.workflow.path, "utf8"));
  assertGitObjectId(envelope.workflow.blob_sha, "promotion envelope workflow blob SHA");

  const { verification: approvalVerification, ...approval } = envelope.approval;
  const approvalKeys = approval.version === "external-signed-promotion-approval/v1"
    ? [
      "version",
      "approval_id",
      "approver",
      "approved_at",
      "stage_a_receipt_sha256",
      "destination",
      "operation_scope",
      "verification",
    ]
    : [
      "version",
      "approval_id",
      "approver",
      "approved_at",
      "stage_a_receipt_sha256",
      "destination",
      "operation_scope",
      "cockpit_source",
      "verification",
    ];
  assertExactKeys(envelope.approval, approvalKeys, "Promotion envelope approval");
  assertEvidenceVerificationShape(
    approvalVerification,
    "Approval evidence",
    approvalVerificationMechanism(approval),
  );
  assertApproval(
    approval,
    envelope.stage_a_receipt_sha256,
    envelope.destination,
    envelope.workflow.path,
  );

  assertExactKeys(
    envelope.ci,
    [
      "version",
      "repository",
      "workflow",
      "run",
      "required_jobs",
      "product_gate",
      "verification",
    ],
    "Promotion envelope CI",
  );
  const { verification: ciVerification, ...ci } = envelope.ci;
  assertEvidenceVerificationShape(
    ciVerification,
    "CI evidence",
    "provider-api-execution-receipt",
  );
  assertCiEvidence(
    ci,
    envelope.destination,
    envelope.public_commit_sha,
    envelope.workflow.path,
    envelope.workflow.blob_sha,
    approval,
  );
}

export function buildPromotionEnvelope(options: {
  stageAReceiptBytes: Buffer;
  stageAReceiptVerifier: TrustedEvidenceVerifier<PublicProjectionReceipt>;
  publicRepository: string;
  exactPublicCommit: string;
  destination: PromotionDestination;
  workflowPath: string;
  workflowBlobSha: string;
  ciEvidenceBytes: Buffer;
  approvalReceiptBytes: Buffer;
  ciEvidenceVerifier: TrustedEvidenceVerifier<PromotionCiEvidence>;
  approvalReceiptVerifier: TrustedEvidenceVerifier<PromotionApprovalReceipt>;
}): PromotionEnvelope {
  const stageA = assertCanonicalJsonBytes<PublicProjectionReceipt>(
    options.stageAReceiptBytes,
    "Stage A receipt",
  );
  assertReceiptCore(stageA);
  if (!options.stageAReceiptVerifier || typeof options.stageAReceiptVerifier.verify !== "function") {
    throw new PublicProjectionError("Stage A receipt lacks an independent trusted verifier");
  }
  const stageAVerified = options.stageAReceiptVerifier.verify(options.stageAReceiptBytes);
  assertEvidenceVerification(
    options.stageAReceiptBytes,
    stageAVerified.verification,
    "Stage A receipt evidence",
    "detached-signature",
  );
  assertExactObject(stageAVerified.evidence, stageA, "Trusted Stage A receipt");
  const stageAReceiptSha256 = sha256Hex(options.stageAReceiptBytes);
  assertDestination(options.destination);
  assertNonEmptyString(options.workflowPath, "workflow path");
  validateGitPath(Buffer.from(options.workflowPath, "utf8"));
  assertGitObjectId(options.workflowBlobSha, "workflow blob SHA");
  const commit = exactPublicCommit(options.publicRepository, options.exactPublicCommit);
  const { treeSha, identities } = commitPublicLedger(options.publicRepository, commit);
  compareCommitLedger(stageA.public_path_ledger, identities);
  assertCanonicalPublicCommit(
    options.publicRepository,
    commit,
    treeSha,
    stageAReceiptSha256,
  );

  const actualWorkflowBlob = gitText(options.publicRepository, [
    "rev-parse",
    "--verify",
    `${commit}:${options.workflowPath}`,
  ]);
  if (actualWorkflowBlob !== options.workflowBlobSha) {
    throw new PublicProjectionError("Workflow blob SHA does not match exact public commit");
  }

  const approvalVerified = options.approvalReceiptVerifier.verify(options.approvalReceiptBytes);
  assertEvidenceVerification(
    options.approvalReceiptBytes,
    approvalVerified.verification,
    "Approval evidence",
    approvalVerificationMechanism(approvalVerified.evidence),
  );
  assertApproval(
    approvalVerified.evidence,
    stageAReceiptSha256,
    options.destination,
    options.workflowPath,
  );
  const ciVerified = options.ciEvidenceVerifier.verify(options.ciEvidenceBytes);
  assertEvidenceVerification(
    options.ciEvidenceBytes,
    ciVerified.verification,
    "CI evidence",
    "provider-api-execution-receipt",
  );
  assertCiEvidence(
    ciVerified.evidence,
    options.destination,
    commit,
    options.workflowPath,
    options.workflowBlobSha,
    approvalVerified.evidence,
  );

  return {
    version: "promotion-envelope/v1",
    stage_a_receipt_sha256: stageAReceiptSha256,
    stage_a_public_path_ledger_sha256: stageA.public_path_ledger_sha256,
    stage_a_verification: stageAVerified.verification,
    public_commit_sha: commit,
    public_tree_sha: treeSha,
    public_path_count: identities.length,
    destination: options.destination,
    workflow: {
      path: options.workflowPath,
      blob_sha: options.workflowBlobSha,
    },
    ci: {
      ...ciVerified.evidence,
      verification: ciVerified.verification,
    },
    approval: {
      ...approvalVerified.evidence,
      verification: approvalVerified.verification,
    },
  };
}

export function verifyPromotionEnvelope(
  options: Parameters<typeof buildPromotionEnvelope>[0] & { envelopeBytes: Buffer },
): PromotionEnvelope {
  const envelope = assertCanonicalJsonBytes<PromotionEnvelope>(
    options.envelopeBytes,
    "Promotion envelope",
  );
  assertPromotionEnvelopeShape(envelope);
  const rebuilt = buildPromotionEnvelope(options);
  if (canonicalJson(envelope) !== canonicalJson(rebuilt)) {
    throw new PublicProjectionError("Promotion envelope does not match trusted exact-commit inputs");
  }
  return envelope;
}
