import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_PROJECTION_CANDIDATE_BRANCH_PREFIX,
  PublicProjectionError,
  canonicalJsonBytes,
  canonicalPublicProjectionCandidateBranch,
  isRfc3339DateTime,
  sha256Hex,
  type CiJobResult,
  type ExternalSignedPromotionApprovalReceipt,
  type PromotionApprovalReceipt,
  type PromotionApprovalReceiptV1,
  type PromotionCiEvidence,
  type PromotionDestination,
  type PublicProjectionReceipt,
  type TrustedEvidenceVerifier,
} from "./public-projection.js";

interface PublicPromotionAuthenticationTrust {
  configured: boolean;
  key_id: string | null;
  public_key_path: string | null;
  public_key_sha256: string | null;
}

interface PublicPromotionTrustConfig {
  version: "public-promotion-trust/v1";
  destination: PromotionDestination;
  workflow: {
    path: string;
    candidate_branch_prefix: string;
  };
  stage_a_authentication: PublicPromotionAuthenticationTrust;
  approval_authentication: PublicPromotionAuthenticationTrust;
}

export interface StageASignatureTrustRoot {
  keyId: string;
  publicKeyPath: string;
  publicKeySha256: string;
  opensslPath?: string;
}

export interface GitHubProviderExecutionReceipt {
  version: "github-provider-api-execution-receipt/v1";
  repository_id: string;
  repository_full_name: string;
  run_id: string;
  evidence: PromotionCiEvidence;
}

export interface PromotionApprovalRequest {
  version: "public-promotion-approval-request/v1";
  stage_a_receipt_sha256: string;
  destination: PromotionDestination;
  operation_scope: PromotionApprovalReceipt["operation_scope"];
}

export const COCKPIT_ASK_RESOLVED_V1_KEYS = [
  "answers",
  "answered_by",
  "ask_id",
  "event",
  "outcome",
  "version",
] as const;

export const COCKPIT_ASK_RESOLVED_V2_KEYS = [
  "answers",
  "answered_by",
  "ask_id",
  "event",
  "outcome",
  "resolved_at",
  "version",
] as const;

export const COCKPIT_ASK_RESOLVED_AT_BLOCKER_CODE = "cockpit_ask_resolved_at_unavailable" as const;

export const COCKPIT_ASK_AUTHENTICATED_SURFACE_BLOCKER_CODE =
  "cockpit_ask_authenticated_surface_unavailable" as const;

export const COCKPIT_ASK_TIME_QUERY_SURFACES = [
  {
    command: "cockpit help ask",
    result: "documents cockpit.ask.resolved v1 as event,version,ask_id,outcome,answers without resolved_at",
  },
  {
    command: "cockpit ask get <askId>",
    result: "unknown option; no resolved-Ask query surface",
  },
  {
    command: "cockpit ask list",
    result: "open Asks only; answered Asks are not returned",
  },
  {
    command: "cockpit task get <taskId>",
    result:
      "conversation items expose kind, role, source, and unauthenticated text only; conversation text is never an approval-receipt source",
  },
] as const;

export interface CockpitAskResolvedV1Event {
  event: "cockpit.ask.resolved";
  version: 1;
  ask_id: string;
  outcome: "answered";
  answered_by: "user";
  answers: Array<{ type: "choice"; value: string }>;
}

export interface CockpitAskResolvedV2Event extends Omit<CockpitAskResolvedV1Event, "version"> {
  version: 2;
  resolved_at: string;
}

export type CockpitApprovalEvent = CockpitAskResolvedV1Event | CockpitAskResolvedV2Event;

export interface CockpitAskResolvedAtBlocker {
  version: "cockpit-ask-resolved-at-blocker/v1";
  code: typeof COCKPIT_ASK_RESOLVED_AT_BLOCKER_CODE;
  ask_id: string;
  task_id: string;
  observed_event_version: 1;
  observed_event_keys: string[];
  required_contract: {
    event: "cockpit.ask.resolved";
    version: 2;
    required_keys: typeof COCKPIT_ASK_RESOLVED_V2_KEYS;
    resolved_at: "RFC3339 seconds 00-59 from a provider-authenticated Cockpit Ask resolution surface";
  };
  queried_first_party_surfaces: typeof COCKPIT_ASK_TIME_QUERY_SURFACES;
  cockpit_change_required:
    "Emit cockpit.ask.resolved version 2 with the v1 keys plus authenticatable resolved_at on a first-party structured event surface or authenticated execution receipt. Do not derive time from conversation text, task createdAt, lastActivityAt, lastSeenAt, conversation order, filesystem mtime, or wall clock.";
}

export class CockpitAskResolvedAtUnavailableError extends PublicProjectionError {
  readonly blocker: CockpitAskResolvedAtBlocker;

  constructor(blocker: CockpitAskResolvedAtBlocker) {
    super(
      `Cockpit Ask resolved_at is unavailable (${blocker.code}): the provider-authenticated Ask surface exposed cockpit.ask.resolved v1 without an authenticatable resolution timestamp`,
    );
    this.name = "CockpitAskResolvedAtUnavailableError";
    this.blocker = blocker;
  }
}

export interface CockpitAskAuthenticatedSurfaceBlocker {
  version: "cockpit-ask-authenticated-surface-unavailable/v1";
  code: typeof COCKPIT_ASK_AUTHENTICATED_SURFACE_BLOCKER_CODE;
  ask_id: string;
  task_id: string;
  required_surface:
    "first-party structured cockpit.ask.resolved v2 event or authenticated execution receipt, never conversation text";
  required_contract: CockpitAskResolvedAtBlocker["required_contract"];
  queried_first_party_surfaces: typeof COCKPIT_ASK_TIME_QUERY_SURFACES;
  cockpit_change_required:
    "Expose a provider-authenticated first-party structured Ask resolution surface or authenticated execution receipt. Current cockpit task get conversation text, including hand-written cockpit.ask.resolved JSON with resolved_at and kind/source labels, is not that surface.";
}

export class CockpitAskAuthenticatedSurfaceUnavailableError extends PublicProjectionError {
  readonly blocker: CockpitAskAuthenticatedSurfaceBlocker;

  constructor(blocker: CockpitAskAuthenticatedSurfaceBlocker) {
    super(
      `Cockpit provider-authenticated Ask event surface is unavailable (${blocker.code}): current cockpit task get conversation text cannot mint an approval receipt`,
    );
    this.name = "CockpitAskAuthenticatedSurfaceUnavailableError";
    this.blocker = blocker;
  }
}

export interface StageASignatureHandoff {
  version: "stage-a-signature-handoff/v1";
  configured: false;
  private_key_policy: "never-generate-store-or-commit";
  required_from_external_custodian: readonly [
    "public key PEM",
    "public key SHA-256",
    "key_id",
    "detached signature over the exact Stage A receipt bytes, kept outside the repository",
  ];
  repository_steps_after_receipt: readonly [
    "place only the public key at runtime/release/trust/<key_id>.pem",
    "set stage_a_authentication.configured true with key_id, ./trust/<key_id>.pem, and public_key_sha256",
    "run scripts/verify-promotion-envelope.ts with --stage-a-signature pointing outside the repository",
  ];
  blocked_reason: "Stage B blocked: no custodian-approved Stage A public signing key is configured";
}

export interface ApprovalSignatureHandoff {
  version: "approval-signature-handoff/v1";
  configured: false;
  private_key_policy: "never-generate-store-or-commit";
  required_from_external_custodian: readonly [
    "public key PEM",
    "public key SHA-256",
    "key_id",
    "detached signature over the exact canonical external-signed-promotion-approval/v1 bytes, kept outside the repository",
  ];
  repository_steps_after_receipt: readonly [
    "place only the public key at runtime/release/trust/<key_id>.pem",
    "set approval_authentication.configured true with key_id, ./trust/<key_id>.pem, and public_key_sha256",
    "run scripts/record-signed-public-promotion-approval.ts with --approval and --signature pointing outside the repository",
    "run scripts/verify-promotion-envelope.ts with --approval-signature pointing outside the repository",
  ];
  blocked_reason: "Approval blocked: no custodian-approved approval public signing key is configured";
}

export const EXTERNAL_SIGNED_PROMOTION_APPROVAL_KEYS = [
  "approval_id",
  "approved_at",
  "approver",
  "destination",
  "operation_scope",
  "stage_a_receipt_sha256",
  "version",
] as const;

export interface CockpitConversationItem {
  role: string;
  text: string;
  kind?: string;
  source?: string;
}

export interface CockpitTaskSnapshot {
  id: string;
  conversation: CockpitConversationItem[];
}

export type CockpitAuthenticatedAskSurface =
  | "first-party-structured-event"
  | "authenticated-execution-receipt";

export interface CockpitAuthenticatedAskResolution {
  surface: CockpitAuthenticatedAskSurface;
  task_id: string;
  ask_id: string;
  event: CockpitApprovalEvent;
}

export type GitHubApi = (endpoint: string) => unknown;
export type CockpitTaskReader = (taskId: string) => CockpitTaskSnapshot;
export type CockpitAuthenticatedAskResolutionReader = (
  taskId: string,
  askId: string,
) => CockpitAuthenticatedAskResolution | null;

const TRUST_CONFIG_PATH = fileURLToPath(new URL("./public-promotion-trust.json", import.meta.url));

function exactKeys(value: unknown, expected: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicProjectionError(`${label} must be an object`);
  }
  if (Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")) {
    throw new PublicProjectionError(`${label} has unexpected or missing keys`);
  }
}

function parseCanonical<T>(bytes: Buffer, label: string): T {
  let parsed: T;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new PublicProjectionError(`${label} is not valid JSON`);
  }
  if (!bytes.equals(canonicalJsonBytes(parsed))) {
    throw new PublicProjectionError(`${label} is not canonical JSON`);
  }
  return parsed;
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new PublicProjectionError(`${label} must be a lowercase SHA-256`);
  }
}

function assertObjectId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new PublicProjectionError(`${label} must be a full Git object ID`);
  }
}

export function readPublicPromotionTrustConfig(): PublicPromotionTrustConfig {
  const bytes = fs.readFileSync(TRUST_CONFIG_PATH);
  const config = JSON.parse(bytes.toString("utf8")) as PublicPromotionTrustConfig;
  if (!bytes.equals(Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8"))) {
    throw new PublicProjectionError("public promotion trust config formatting changed");
  }
  exactKeys(
    config,
    ["version", "destination", "workflow", "stage_a_authentication", "approval_authentication"],
    "public promotion trust config",
  );
  exactKeys(
    config.destination,
    ["provider", "repository_id", "repository_full_name", "branch"],
    "public promotion destination trust",
  );
  exactKeys(
    config.workflow,
    ["path", "candidate_branch_prefix"],
    "public promotion workflow trust",
  );
  assertAuthenticationTrust(config.stage_a_authentication, "Stage A");
  assertAuthenticationTrust(config.approval_authentication, "approval");
  if (config.version !== "public-promotion-trust/v1"
    || config.destination.provider !== "github"
    || config.destination.repository_id !== "1188541623"
    || config.destination.repository_full_name !== "mocchalera/video-os-v2"
    || config.destination.branch !== "main"
    || config.workflow.path !== ".github/workflows/ci.yml"
    || config.workflow.candidate_branch_prefix !== PUBLIC_PROJECTION_CANDIDATE_BRANCH_PREFIX) {
    throw new PublicProjectionError("public promotion destination/workflow trust root mismatch");
  }
  return config;
}

function assertAuthenticationTrust(value: PublicPromotionAuthenticationTrust, label: string): void {
  exactKeys(
    value,
    ["configured", "key_id", "public_key_path", "public_key_sha256"],
    `${label} authentication trust`,
  );
  if (value.configured !== true && value.configured !== false) {
    throw new PublicProjectionError(`${label} authentication configured flag is invalid`);
  }
  if (!value.configured) {
    if (value.key_id !== null || value.public_key_path !== null || value.public_key_sha256 !== null) {
      throw new PublicProjectionError(`unconfigured ${label} authentication must not carry a partial trust root`);
    }
    return;
  }
  if (
    typeof value.key_id !== "string"
    || value.key_id.length === 0
    || typeof value.public_key_path !== "string"
    || !/^\.\/trust\/[a-zA-Z0-9._-]+\.pem$/.test(value.public_key_path)
    || typeof value.public_key_sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.public_key_sha256)
  ) {
    throw new PublicProjectionError(`configured ${label} authentication trust root is invalid`);
  }
}

export function fixedPublicPromotionDestination(): PromotionDestination {
  return structuredClone(readPublicPromotionTrustConfig().destination);
}

export function unconfiguredStageASignatureHandoff(): StageASignatureHandoff {
  const config = readPublicPromotionTrustConfig().stage_a_authentication;
  if (config.configured) {
    throw new PublicProjectionError("Stage A authentication is already configured");
  }
  return {
    version: "stage-a-signature-handoff/v1",
    configured: false,
    private_key_policy: "never-generate-store-or-commit",
    required_from_external_custodian: [
      "public key PEM",
      "public key SHA-256",
      "key_id",
      "detached signature over the exact Stage A receipt bytes, kept outside the repository",
    ],
    repository_steps_after_receipt: [
      "place only the public key at runtime/release/trust/<key_id>.pem",
      "set stage_a_authentication.configured true with key_id, ./trust/<key_id>.pem, and public_key_sha256",
      "run scripts/verify-promotion-envelope.ts with --stage-a-signature pointing outside the repository",
    ],
    blocked_reason: "Stage B blocked: no custodian-approved Stage A public signing key is configured",
  };
}

export function configuredStageATrustRoot(): StageASignatureTrustRoot {
  return configuredSignatureTrustRoot(
    readPublicPromotionTrustConfig().stage_a_authentication,
    unconfiguredStageASignatureHandoff().blocked_reason,
    "Stage A",
  );
}

export function unconfiguredApprovalSignatureHandoff(): ApprovalSignatureHandoff {
  const config = readPublicPromotionTrustConfig().approval_authentication;
  if (config.configured) {
    throw new PublicProjectionError("approval authentication is already configured");
  }
  return {
    version: "approval-signature-handoff/v1",
    configured: false,
    private_key_policy: "never-generate-store-or-commit",
    required_from_external_custodian: [
      "public key PEM",
      "public key SHA-256",
      "key_id",
      "detached signature over the exact canonical external-signed-promotion-approval/v1 bytes, kept outside the repository",
    ],
    repository_steps_after_receipt: [
      "place only the public key at runtime/release/trust/<key_id>.pem",
      "set approval_authentication.configured true with key_id, ./trust/<key_id>.pem, and public_key_sha256",
      "run scripts/record-signed-public-promotion-approval.ts with --approval and --signature pointing outside the repository",
      "run scripts/verify-promotion-envelope.ts with --approval-signature pointing outside the repository",
    ],
    blocked_reason: "Approval blocked: no custodian-approved approval public signing key is configured",
  };
}

export function configuredApprovalTrustRoot(): StageASignatureTrustRoot {
  return configuredSignatureTrustRoot(
    readPublicPromotionTrustConfig().approval_authentication,
    unconfiguredApprovalSignatureHandoff().blocked_reason,
    "approval",
  );
}

function configuredSignatureTrustRoot(
  config: PublicPromotionAuthenticationTrust,
  unconfiguredReason: string,
  label: string,
): StageASignatureTrustRoot {
  if (!config.configured || config.key_id === null || config.public_key_path === null
    || config.public_key_sha256 === null) {
    throw new PublicProjectionError(unconfiguredReason);
  }
  assertSha(config.public_key_sha256, `${label} public key digest`);
  const publicKeyPath = fileURLToPath(new URL(config.public_key_path, import.meta.url));
  if (sha256Hex(fs.readFileSync(publicKeyPath)) !== config.public_key_sha256) {
    throw new PublicProjectionError(`${label} public signing key digest does not match fixed trust root`);
  }
  return {
    keyId: config.key_id,
    publicKeyPath,
    publicKeySha256: config.public_key_sha256,
  };
}

function findExecutable(name: string, explicit?: string): string {
  if (explicit) return fs.realpathSync(explicit);
  if (!/^[a-z0-9-]+$/.test(name)) throw new PublicProjectionError("executable name is invalid");
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const resolved = fs.realpathSync(candidate);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // Continue to the next fixed PATH entry.
    }
  }
  throw new PublicProjectionError(`${name} is not available`);
}

function verifyDetachedPublicKeySignature(options: {
  bytes: Buffer;
  signaturePath: string;
  trustRoot: StageASignatureTrustRoot;
  label: string;
}): void {
  assertSha(options.trustRoot.publicKeySha256, `${options.label} public key digest`);
  const publicKey = fs.realpathSync(options.trustRoot.publicKeyPath);
  if (sha256Hex(fs.readFileSync(publicKey)) !== options.trustRoot.publicKeySha256) {
    throw new PublicProjectionError(`${options.label} public key trust root changed`);
  }
  const signature = fs.readFileSync(options.signaturePath);
  if (signature.length === 0) throw new PublicProjectionError(`${options.label} detached signature is empty`);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "videoos-detached-verify-"));
  const signatureLeaf = path.join(temporaryRoot, "signature.bin");
  try {
    fs.writeFileSync(signatureLeaf, signature, { flag: "wx", mode: 0o400 });
    const openssl = findExecutable("openssl", options.trustRoot.opensslPath);
    const verified = spawnSync(openssl, [
      "pkeyutl", "-verify", "-pubin", "-inkey", publicKey, "-rawin", "-sigfile", signatureLeaf,
    ], {
      input: options.bytes,
      encoding: "buffer",
      env: { LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (verified.status !== 0) {
      throw new PublicProjectionError(`${options.label} detached signature verification failed`);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function createStageAReceiptSignatureVerifier(
  trustRoot: StageASignatureTrustRoot,
  signaturePath: string,
): TrustedEvidenceVerifier<PublicProjectionReceipt> {
  return {
    verify(bytes) {
      const evidence = parseCanonical<PublicProjectionReceipt>(bytes, "Stage A receipt");
      verifyDetachedPublicKeySignature({
        bytes,
        signaturePath,
        trustRoot,
        label: "Stage A",
      });
      return {
        evidence,
        verification: {
          mechanism: "detached-signature",
          verifier_id: `openssl-stage-a:${trustRoot.keyId}:${trustRoot.publicKeySha256}`,
          evidence_sha256: sha256Hex(bytes),
        },
      };
    },
  };
}

function defaultGitHubApi(endpoint: string): unknown {
  const gh = findExecutable("gh");
  const output = execFileSync(gh, ["api", "-H", "Accept: application/vnd.github+json", endpoint], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output) as unknown;
}

function jobResult(value: unknown, label: string): CiJobResult {
  const allowed: CiJobResult[] = [
    "success", "failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", "stale",
  ];
  if (typeof value !== "string" || !allowed.includes(value as CiJobResult)) {
    throw new PublicProjectionError(`${label} has no supported completed conclusion`);
  }
  return value as CiJobResult;
}

export function observeGitHubCiEvidence(options: {
  runId: string;
  workflowBlobSha: string;
  api?: GitHubApi;
}): PromotionCiEvidence {
  if (!/^[1-9][0-9]*$/.test(options.runId)) throw new PublicProjectionError("GitHub run ID is invalid");
  assertObjectId(options.workflowBlobSha, "workflow blob SHA");
  const api = options.api ?? defaultGitHubApi;
  const config = readPublicPromotionTrustConfig();
  const repository = api(`repos/${config.destination.repository_full_name}`) as Record<string, unknown>;
  const run = api(`repos/${config.destination.repository_full_name}/actions/runs/${options.runId}`) as Record<string, unknown>;
  const jobsResponse = api(
    `repos/${config.destination.repository_full_name}/actions/runs/${options.runId}/jobs?filter=latest&per_page=100`,
  ) as { total_count?: unknown; jobs?: unknown };
  if (String(repository.id) !== config.destination.repository_id
    || repository.full_name !== config.destination.repository_full_name) {
    throw new PublicProjectionError("GitHub API repository identity mismatch");
  }
  if (String(run.id) !== options.runId || run.path !== config.workflow.path) {
    throw new PublicProjectionError("GitHub workflow run identity/path mismatch");
  }
  const runRepository = run.repository as Record<string, unknown> | undefined;
  if (String(runRepository?.id) !== config.destination.repository_id
    || runRepository?.full_name !== config.destination.repository_full_name) {
    throw new PublicProjectionError("GitHub run repository binding mismatch");
  }
  if (!Array.isArray(jobsResponse.jobs)
    || jobsResponse.total_count !== jobsResponse.jobs.length
    || jobsResponse.jobs.length > 100) {
    throw new PublicProjectionError("GitHub jobs response is incomplete or paginated");
  }
  const jobs = jobsResponse.jobs as Array<Record<string, unknown>>;
  const byName = new Map<string, CiJobResult>();
  for (const job of jobs) {
    if (typeof job.name !== "string" || byName.has(job.name)) {
      throw new PublicProjectionError("GitHub jobs contain a missing or duplicate name");
    }
    byName.set(job.name, jobResult(job.conclusion, `GitHub job ${job.name}`));
  }
  const boundaryNames = [
    "node-runtime", "schema-contract", "speech-led-contract", "event-recap-contract",
    "repo-hygiene", "editor-server", "agent-definitions", "macos-studio", "render-integration",
  ];
  const allowedNames = new Set([...boundaryNames, "product-gate"]);
  for (const name of byName.keys()) if (!allowedNames.has(name)) throw new PublicProjectionError(`GitHub run has extra job ${name}`);
  const headSha = String(run.head_sha ?? "");
  assertObjectId(headSha, "GitHub run head SHA");
  const headBranch = String(run.head_branch ?? "");
  if (headBranch !== canonicalPublicProjectionCandidateBranch(headSha)) {
    throw new PublicProjectionError("GitHub run is not on the canonical exact-commit candidate branch");
  }
  return {
    version: "public-ci-evidence/v1",
    repository: {
      provider: "github",
      repository_id: config.destination.repository_id,
      repository_full_name: config.destination.repository_full_name,
    },
    workflow: { path: config.workflow.path, blob_sha: options.workflowBlobSha },
    run: {
      id: options.runId,
      attempt: Number(run.run_attempt),
      event: String(run.event ?? ""),
      head_sha: headSha,
      head_branch: headBranch,
      url: String(run.html_url ?? ""),
      conclusion: jobResult(run.conclusion, "GitHub workflow run"),
    },
    required_jobs: boundaryNames.map((name) => ({
      name: name as PromotionCiEvidence["required_jobs"][number]["name"],
      result: byName.get(name) ?? (() => { throw new PublicProjectionError(`GitHub run is missing job ${name}`); })(),
    })),
    product_gate: {
      name: "product-gate",
      result: byName.get("product-gate") ?? (() => { throw new PublicProjectionError("GitHub run is missing product-gate"); })(),
    },
  };
}

export function createGitHubProviderExecutionReceipt(options: {
  runId: string;
  workflowBlobSha: string;
  api?: GitHubApi;
}): GitHubProviderExecutionReceipt {
  const config = readPublicPromotionTrustConfig();
  return {
    version: "github-provider-api-execution-receipt/v1",
    repository_id: config.destination.repository_id,
    repository_full_name: config.destination.repository_full_name,
    run_id: options.runId,
    evidence: observeGitHubCiEvidence(options),
  };
}

export function createGitHubProviderEvidenceVerifier(
  api?: GitHubApi,
): TrustedEvidenceVerifier<PromotionCiEvidence> {
  return {
    verify(bytes) {
      const receipt = parseCanonical<GitHubProviderExecutionReceipt>(bytes, "GitHub provider execution receipt");
      exactKeys(receipt, ["version", "repository_id", "repository_full_name", "run_id", "evidence"], "GitHub provider execution receipt");
      const config = readPublicPromotionTrustConfig();
      if (receipt.version !== "github-provider-api-execution-receipt/v1"
        || receipt.repository_id !== config.destination.repository_id
        || receipt.repository_full_name !== config.destination.repository_full_name
        || receipt.run_id !== receipt.evidence.run.id) {
        throw new PublicProjectionError("GitHub provider execution receipt trust binding mismatch");
      }
      const observed = observeGitHubCiEvidence({
        runId: receipt.run_id,
        workflowBlobSha: receipt.evidence.workflow.blob_sha,
        api,
      });
      if (!canonicalJsonBytes(observed).equals(canonicalJsonBytes(receipt.evidence))) {
        throw new PublicProjectionError("GitHub provider execution receipt does not match authenticated API evidence");
      }
      return {
        evidence: observed,
        verification: {
          mechanism: "provider-api-execution-receipt",
          verifier_id: `github-api:${config.destination.repository_id}`,
          evidence_sha256: sha256Hex(bytes),
        },
      };
    },
  };
}

export function approvalRequestFromReceipt(
  receipt: PromotionApprovalReceipt,
): PromotionApprovalRequest {
  return {
    version: "public-promotion-approval-request/v1",
    stage_a_receipt_sha256: receipt.stage_a_receipt_sha256,
    destination: receipt.destination,
    operation_scope: receipt.operation_scope,
  };
}

export function approvalChoice(request: PromotionApprovalRequest): string {
  return `approve-public-promotion:${sha256Hex(canonicalJsonBytes(request))}`;
}

export function createExternalSignedPromotionApproval(options: {
  request: PromotionApprovalRequest;
  approvalId: string;
  approverIdentity: string;
  approvedAt: string;
}): ExternalSignedPromotionApprovalReceipt {
  exactKeys(
    options.request,
    ["version", "stage_a_receipt_sha256", "destination", "operation_scope"],
    "Promotion approval request",
  );
  exactKeys(
    options.request.destination,
    ["provider", "repository_id", "repository_full_name", "branch"],
    "Promotion approval request destination",
  );
  exactKeys(
    options.request.operation_scope,
    ["operation", "event", "workflow_path"],
    "Promotion approval request operation scope",
  );
  if (options.request.version !== "public-promotion-approval-request/v1") {
    throw new PublicProjectionError("Promotion approval request version is unsupported");
  }
  const destination = fixedPublicPromotionDestination();
  const workflowPath = readPublicPromotionTrustConfig().workflow.path;
  if (
    options.request.destination.provider !== destination.provider
    || options.request.destination.repository_id !== destination.repository_id
    || options.request.destination.repository_full_name !== destination.repository_full_name
    || options.request.destination.branch !== destination.branch
  ) {
    throw new PublicProjectionError("Promotion approval request destination does not match fixed trust");
  }
  if (
    options.request.operation_scope.operation !== "push-exact-projection"
    || options.request.operation_scope.event !== "push"
    || options.request.operation_scope.workflow_path !== workflowPath
  ) {
    throw new PublicProjectionError("Promotion approval request operation scope does not match fixed trust");
  }
  if (typeof options.approvalId !== "string" || options.approvalId.length === 0) {
    throw new PublicProjectionError("External signed approval ID is invalid");
  }
  if (typeof options.approverIdentity !== "string" || options.approverIdentity.length === 0) {
    throw new PublicProjectionError("External signed approval requires a human approver identity");
  }
  if (options.approverIdentity.startsWith("cockpit:")) {
    throw new PublicProjectionError("External signed approval must not use a Cockpit identity");
  }
  if (typeof options.approvedAt !== "string" || !isRfc3339DateTime(options.approvedAt)) {
    throw new PublicProjectionError(
      "Approval time must use the supported RFC 3339 subset with seconds 00 through 59",
    );
  }
  assertSha(options.request.stage_a_receipt_sha256, "Approval Stage A SHA");
  return {
    version: "external-signed-promotion-approval/v1",
    approval_id: options.approvalId,
    approver: { identity: options.approverIdentity },
    approved_at: options.approvedAt,
    stage_a_receipt_sha256: options.request.stage_a_receipt_sha256,
    destination: structuredClone(destination),
    operation_scope: {
      operation: "push-exact-projection",
      event: "push",
      workflow_path: workflowPath,
    },
  };
}

export function parseExternalSignedPromotionApproval(
  bytes: Buffer,
  request?: PromotionApprovalRequest,
): ExternalSignedPromotionApprovalReceipt {
  const approval = parseCanonical<ExternalSignedPromotionApprovalReceipt>(
    bytes,
    "external signed promotion approval",
  );
  exactKeys(approval, [...EXTERNAL_SIGNED_PROMOTION_APPROVAL_KEYS], "external signed promotion approval");
  if (approval.version !== "external-signed-promotion-approval/v1") {
    throw new PublicProjectionError("Approval receipt is not an external signed promotion approval");
  }
  exactKeys(approval.approver, ["identity"], "Promotion approver");
  exactKeys(
    approval.operation_scope,
    ["operation", "event", "workflow_path"],
    "Promotion approval scope",
  );
  exactKeys(
    approval.destination,
    ["provider", "repository_id", "repository_full_name", "branch"],
    "Promotion destination",
  );
  const expected = createExternalSignedPromotionApproval({
    request: request ?? {
      version: "public-promotion-approval-request/v1",
      stage_a_receipt_sha256: approval.stage_a_receipt_sha256,
      destination: approval.destination,
      operation_scope: approval.operation_scope,
    },
    approvalId: approval.approval_id,
    approverIdentity: approval.approver.identity,
    approvedAt: approval.approved_at,
  });
  if (!canonicalJsonBytes(expected).equals(canonicalJsonBytes(approval))) {
    throw new PublicProjectionError("External signed approval does not match the exact promotion request");
  }
  return approval;
}

export function createApprovalReceiptSignatureVerifier(
  trustRoot: StageASignatureTrustRoot,
  signaturePath: string,
  request?: PromotionApprovalRequest,
): TrustedEvidenceVerifier<PromotionApprovalReceipt> {
  return {
    verify(bytes) {
      const evidence = parseExternalSignedPromotionApproval(bytes, request);
      verifyDetachedPublicKeySignature({
        bytes,
        signaturePath,
        trustRoot,
        label: "approval",
      });
      return {
        evidence,
        verification: {
          mechanism: "detached-signature",
          verifier_id: `openssl-approval:${trustRoot.keyId}:${trustRoot.publicKeySha256}`,
          evidence_sha256: sha256Hex(bytes),
        },
      };
    },
  };
}

function asCockpitTaskSnapshot(taskId: string, data: unknown): CockpitTaskSnapshot {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new PublicProjectionError("Cockpit task query did not return the exact durable task");
  }
  const record = data as Record<string, unknown>;
  if (record.id !== taskId || !Array.isArray(record.conversation)) {
    throw new PublicProjectionError("Cockpit task query did not return the exact durable task");
  }
  return {
    id: taskId,
    conversation: record.conversation.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new PublicProjectionError("Cockpit task conversation item is invalid");
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry.role !== "string" || typeof entry.text !== "string") {
        throw new PublicProjectionError("Cockpit task conversation item is invalid");
      }
      const snapshot: CockpitConversationItem = {
        role: entry.role,
        text: entry.text,
      };
      if (typeof entry.kind === "string") snapshot.kind = entry.kind;
      if (typeof entry.source === "string") snapshot.source = entry.source;
      return snapshot;
    }),
  };
}

function defaultCockpitTaskReader(taskId: string): CockpitTaskSnapshot {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new PublicProjectionError("Cockpit task ID is invalid");
  const cockpit = findExecutable("cockpit");
  const output = execFileSync(cockpit, ["task", "get", taskId, "--turns", "200", "--max-lines", "2000"], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const response = JSON.parse(output) as { ok?: unknown; data?: unknown };
  if (response.ok !== true) {
    throw new PublicProjectionError("Cockpit task query did not return the exact durable task");
  }
  return asCockpitTaskSnapshot(taskId, response.data);
}

function defaultCockpitAuthenticatedAskResolutionReader(
  _taskId: string,
  _askId: string,
): CockpitAuthenticatedAskResolution | null {
  return null;
}

function matchingAskEvents(task: CockpitTaskSnapshot, askId: string): unknown[] {
  const matching: unknown[] = [];
  for (const item of task.conversation) {
    if (item.role !== "user") continue;
    try {
      const event = JSON.parse(item.text) as { event?: unknown; ask_id?: unknown };
      if (event.event === "cockpit.ask.resolved" && event.ask_id === askId) matching.push(event);
    } catch {
      // Ordinary user messages are not approval events.
    }
  }
  return matching;
}

function cockpitAskAuthenticatedSurfaceBlocker(options: {
  askId: string;
  taskId: string;
}): CockpitAskAuthenticatedSurfaceBlocker {
  return {
    version: "cockpit-ask-authenticated-surface-unavailable/v1",
    code: COCKPIT_ASK_AUTHENTICATED_SURFACE_BLOCKER_CODE,
    ask_id: options.askId,
    task_id: options.taskId,
    required_surface:
      "first-party structured cockpit.ask.resolved v2 event or authenticated execution receipt, never conversation text",
    required_contract: {
      event: "cockpit.ask.resolved",
      version: 2,
      required_keys: COCKPIT_ASK_RESOLVED_V2_KEYS,
      resolved_at: "RFC3339 seconds 00-59 from a provider-authenticated Cockpit Ask resolution surface",
    },
    queried_first_party_surfaces: COCKPIT_ASK_TIME_QUERY_SURFACES,
    cockpit_change_required:
      "Expose a provider-authenticated first-party structured Ask resolution surface or authenticated execution receipt. Current cockpit task get conversation text, including hand-written cockpit.ask.resolved JSON with resolved_at and kind/source labels, is not that surface.",
  };
}

function closedKeySet(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join("\n");
}

function expectedKeySet(keys: readonly string[]): string {
  return [...keys].sort().join("\n");
}

function cockpitAskResolvedAtBlocker(options: {
  askId: string;
  taskId: string;
  observedKeys: string[];
}): CockpitAskResolvedAtBlocker {
  return {
    version: "cockpit-ask-resolved-at-blocker/v1",
    code: COCKPIT_ASK_RESOLVED_AT_BLOCKER_CODE,
    ask_id: options.askId,
    task_id: options.taskId,
    observed_event_version: 1,
    observed_event_keys: [...options.observedKeys].sort(),
    required_contract: {
      event: "cockpit.ask.resolved",
      version: 2,
      required_keys: COCKPIT_ASK_RESOLVED_V2_KEYS,
      resolved_at: "RFC3339 seconds 00-59 from a provider-authenticated Cockpit Ask resolution surface",
    },
    queried_first_party_surfaces: COCKPIT_ASK_TIME_QUERY_SURFACES,
    cockpit_change_required:
      "Emit cockpit.ask.resolved version 2 with the v1 keys plus authenticatable resolved_at on a first-party structured event surface or authenticated execution receipt. Do not derive time from conversation text, task createdAt, lastActivityAt, lastSeenAt, conversation order, filesystem mtime, or wall clock.",
  };
}

function bindExactCockpitAskEvent(
  event: unknown,
  expectedAskId: string,
  expectedChoice: string,
): { kind: "v1"; event: CockpitAskResolvedV1Event } | { kind: "v2"; event: CockpitAskResolvedV2Event } {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new PublicProjectionError("Cockpit approval event must be an object");
  }
  const record = event as Record<string, unknown>;
  const keys = closedKeySet(record);
  const v1 = expectedKeySet(COCKPIT_ASK_RESOLVED_V1_KEYS);
  const v2 = expectedKeySet(COCKPIT_ASK_RESOLVED_V2_KEYS);
  if (keys !== v1 && keys !== v2) {
    throw new PublicProjectionError("Cockpit approval event has unexpected or missing keys");
  }
  if (record.event !== "cockpit.ask.resolved") {
    throw new PublicProjectionError("Cockpit approval event is not cockpit.ask.resolved");
  }
  if (record.ask_id !== expectedAskId) {
    throw new PublicProjectionError("Cockpit approval event does not bind the exact Ask");
  }
  if (record.answered_by !== "user") {
    throw new PublicProjectionError("Cockpit approval event was not answered by the human user");
  }
  if (record.outcome !== "answered") {
    throw new PublicProjectionError("Cockpit approval event outcome is not answered");
  }
  if (!Array.isArray(record.answers) || record.answers.length !== 1) {
    throw new PublicProjectionError("Cockpit approval event does not bind the exact promotion request");
  }
  exactKeys(record.answers[0], ["type", "value"], "Cockpit approval answer");
  if (record.answers[0].type !== "choice" || record.answers[0].value !== expectedChoice) {
    throw new PublicProjectionError("Cockpit approval event does not bind the exact promotion request");
  }
  if (keys === v1) {
    if (record.version !== 1) {
      throw new PublicProjectionError("Cockpit approval event version is not the observed v1 contract");
    }
    return { kind: "v1", event: record as unknown as CockpitAskResolvedV1Event };
  }
  if (record.version !== 2) {
    throw new PublicProjectionError("Cockpit approval event version is not the required v2 contract");
  }
  if (typeof record.resolved_at !== "string" || !isRfc3339DateTime(record.resolved_at)) {
    throw new PublicProjectionError(
      "Cockpit approval time must use the supported RFC 3339 subset with seconds 00 through 59",
    );
  }
  return { kind: "v2", event: record as unknown as CockpitAskResolvedV2Event };
}

function requireAuthenticatedAskResolution(options: {
  taskId: string;
  askId: string;
  expectedChoice: string;
  conversationEvents: unknown[];
  authenticatedResolutionReader: CockpitAuthenticatedAskResolutionReader;
}): CockpitAskResolvedV2Event {
  if (options.conversationEvents.length > 1) {
    throw new PublicProjectionError("Cockpit durable approval event is missing or ambiguous");
  }
  const authenticated = options.authenticatedResolutionReader(options.taskId, options.askId);
  if (authenticated === null) {
    if (options.conversationEvents.length === 1) {
      bindExactCockpitAskEvent(options.conversationEvents[0], options.askId, options.expectedChoice);
    }
    throw new CockpitAskAuthenticatedSurfaceUnavailableError(cockpitAskAuthenticatedSurfaceBlocker({
      askId: options.askId,
      taskId: options.taskId,
    }));
  }
  if (
    authenticated.surface !== "first-party-structured-event"
    && authenticated.surface !== "authenticated-execution-receipt"
  ) {
    throw new PublicProjectionError("Cockpit authenticated Ask surface is not recognized");
  }
  if (authenticated.task_id !== options.taskId || authenticated.ask_id !== options.askId) {
    throw new PublicProjectionError("Cockpit approval event does not bind the exact Ask");
  }
  const bound = bindExactCockpitAskEvent(authenticated.event, options.askId, options.expectedChoice);
  if (bound.kind === "v1") {
    throw new CockpitAskResolvedAtUnavailableError(cockpitAskResolvedAtBlocker({
      askId: options.askId,
      taskId: options.taskId,
      observedKeys: Object.keys(bound.event),
    }));
  }
  return bound.event;
}

export function createPromotionApprovalReceiptFromCockpit(options: {
  request: PromotionApprovalRequest;
  taskId: string;
  askId: string;
  reader?: CockpitTaskReader;
  authenticatedResolutionReader?: CockpitAuthenticatedAskResolutionReader;
}): PromotionApprovalReceiptV1 {
  const reader = options.reader ?? defaultCockpitTaskReader;
  const authenticatedResolutionReader =
    options.authenticatedResolutionReader ?? defaultCockpitAuthenticatedAskResolutionReader;
  const task = reader(options.taskId);
  if (task.id !== options.taskId) {
    throw new PublicProjectionError("Cockpit task query did not return the exact durable task");
  }
  const bound = requireAuthenticatedAskResolution({
    taskId: options.taskId,
    askId: options.askId,
    expectedChoice: approvalChoice(options.request),
    conversationEvents: matchingAskEvents(task, options.askId),
    authenticatedResolutionReader,
  });
  return {
    version: "promotion-approval-receipt/v1",
    approval_id: bound.ask_id,
    approver: { identity: "cockpit:user" },
    approved_at: bound.resolved_at,
    stage_a_receipt_sha256: options.request.stage_a_receipt_sha256,
    destination: options.request.destination,
    operation_scope: options.request.operation_scope,
    cockpit_source: { task_id: options.taskId, event_id: bound.ask_id },
  };
}

export function createCockpitApprovalEventVerifier(options: {
  reader?: CockpitTaskReader;
  authenticatedResolutionReader?: CockpitAuthenticatedAskResolutionReader;
} = {}): TrustedEvidenceVerifier<PromotionApprovalReceipt> {
  const reader = options.reader ?? defaultCockpitTaskReader;
  const authenticatedResolutionReader =
    options.authenticatedResolutionReader ?? defaultCockpitAuthenticatedAskResolutionReader;
  return {
    verify(bytes) {
      const approval = parseCanonical<PromotionApprovalReceiptV1>(bytes, "Cockpit approval receipt");
      if (approval.version !== "promotion-approval-receipt/v1" || !("cockpit_source" in approval)) {
        throw new PublicProjectionError("Cockpit approval verifier does not accept an external signed approval");
      }
      const task = reader(approval.cockpit_source.task_id);
      if (task.id !== approval.cockpit_source.task_id) {
        throw new PublicProjectionError("Cockpit task query did not return the exact durable task");
      }
      const bound = requireAuthenticatedAskResolution({
        taskId: approval.cockpit_source.task_id,
        askId: approval.cockpit_source.event_id,
        expectedChoice: approvalChoice(approvalRequestFromReceipt(approval)),
        conversationEvents: matchingAskEvents(task, approval.cockpit_source.event_id),
        authenticatedResolutionReader,
      });
      if (bound.ask_id !== approval.approval_id || bound.ask_id !== approval.cockpit_source.event_id) {
        throw new PublicProjectionError("Cockpit approval was not answered by the human user for the exact Ask");
      }
      if (bound.resolved_at !== approval.approved_at) {
        throw new PublicProjectionError("Cockpit approval time is not bound to the durable event");
      }
      if (approval.approver.identity !== "cockpit:user") {
        throw new PublicProjectionError("Cockpit approval identity is not the authenticated human user");
      }
      return {
        evidence: approval,
        verification: {
          mechanism: "cockpit-approval-event",
          verifier_id: "cockpit-authenticated-ask-resolution/v1",
          evidence_sha256: sha256Hex(bytes),
        },
      };
    },
  };
}
