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
  sha256Hex,
  type CiJobResult,
  type PromotionApprovalReceipt,
  type PromotionCiEvidence,
  type PromotionDestination,
  type PublicProjectionReceipt,
  type TrustedEvidenceVerifier,
} from "./public-projection.js";

interface PublicPromotionTrustConfig {
  version: "public-promotion-trust/v1";
  destination: PromotionDestination;
  workflow: {
    path: string;
    candidate_branch_prefix: string;
  };
  stage_a_authentication: {
    configured: boolean;
    key_id: string | null;
    public_key_path: string | null;
    public_key_sha256: string | null;
  };
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

export interface CockpitApprovalEvent {
  event: "cockpit.ask.resolved";
  version: 1;
  ask_id: string;
  answered_by: "user";
  resolved_at: string;
  answers: Array<{ type: "choice"; value: string }>;
}

export interface CockpitTaskSnapshot {
  id: string;
  conversation: Array<{ role: string; text: string }>;
}

export type GitHubApi = (endpoint: string) => unknown;
export type CockpitTaskReader = (taskId: string) => CockpitTaskSnapshot;

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
    ["version", "destination", "workflow", "stage_a_authentication"],
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
  exactKeys(
    config.stage_a_authentication,
    ["configured", "key_id", "public_key_path", "public_key_sha256"],
    "Stage A authentication trust",
  );
  if (config.version !== "public-promotion-trust/v1"
    || config.destination.provider !== "github"
    || config.destination.repository_id !== "1188541623"
    || config.destination.repository_full_name !== "mocchalera/video-os-v2"
    || config.destination.branch !== "main"
    || config.workflow.path !== ".github/workflows/ci.yml"
    || config.workflow.candidate_branch_prefix !== PUBLIC_PROJECTION_CANDIDATE_BRANCH_PREFIX) {
    throw new PublicProjectionError("public promotion destination/workflow trust root mismatch");
  }
  const stageA = config.stage_a_authentication;
  if (stageA.configured !== true && stageA.configured !== false) {
    throw new PublicProjectionError("Stage A authentication configured flag is invalid");
  }
  if (!stageA.configured) {
    if (stageA.key_id !== null || stageA.public_key_path !== null || stageA.public_key_sha256 !== null) {
      throw new PublicProjectionError("unconfigured Stage A authentication must not carry a partial trust root");
    }
  } else if (
    typeof stageA.key_id !== "string"
    || stageA.key_id.length === 0
    || typeof stageA.public_key_path !== "string"
    || !/^\.\/trust\/[a-zA-Z0-9._-]+\.pem$/.test(stageA.public_key_path)
    || typeof stageA.public_key_sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(stageA.public_key_sha256)
  ) {
    throw new PublicProjectionError("configured Stage A authentication trust root is invalid");
  }
  return config;
}

export function fixedPublicPromotionDestination(): PromotionDestination {
  return structuredClone(readPublicPromotionTrustConfig().destination);
}

export function configuredStageATrustRoot(): StageASignatureTrustRoot {
  const config = readPublicPromotionTrustConfig().stage_a_authentication;
  if (!config.configured || config.key_id === null || config.public_key_path === null
    || config.public_key_sha256 === null) {
    throw new PublicProjectionError(
      "Stage B blocked: no custodian-approved Stage A public signing key is configured",
    );
  }
  assertSha(config.public_key_sha256, "Stage A public key digest");
  const publicKeyPath = fileURLToPath(new URL(config.public_key_path, import.meta.url));
  if (sha256Hex(fs.readFileSync(publicKeyPath)) !== config.public_key_sha256) {
    throw new PublicProjectionError("Stage A public signing key digest does not match fixed trust root");
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

export function createStageAReceiptSignatureVerifier(
  trustRoot: StageASignatureTrustRoot,
  signaturePath: string,
): TrustedEvidenceVerifier<PublicProjectionReceipt> {
  assertSha(trustRoot.publicKeySha256, "Stage A public key digest");
  return {
    verify(bytes) {
      const evidence = parseCanonical<PublicProjectionReceipt>(bytes, "Stage A receipt");
      const publicKey = fs.realpathSync(trustRoot.publicKeyPath);
      if (sha256Hex(fs.readFileSync(publicKey)) !== trustRoot.publicKeySha256) {
        throw new PublicProjectionError("Stage A public key trust root changed");
      }
      const signature = fs.readFileSync(signaturePath);
      if (signature.length === 0) throw new PublicProjectionError("Stage A detached signature is empty");
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "videoos-stage-a-verify-"));
      const signatureLeaf = path.join(temporaryRoot, "signature.bin");
      try {
        fs.writeFileSync(signatureLeaf, signature, { flag: "wx", mode: 0o400 });
        const openssl = findExecutable("openssl", trustRoot.opensslPath);
        const verified = spawnSync(openssl, [
          "pkeyutl", "-verify", "-pubin", "-inkey", publicKey, "-rawin", "-sigfile", signatureLeaf,
        ], {
          input: bytes,
          encoding: "buffer",
          env: { LANG: "C", LC_ALL: "C" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (verified.status !== 0) throw new PublicProjectionError("Stage A detached signature verification failed");
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
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

function defaultCockpitTaskReader(taskId: string): CockpitTaskSnapshot {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new PublicProjectionError("Cockpit task ID is invalid");
  const cockpit = findExecutable("cockpit");
  const output = execFileSync(cockpit, ["task", "get", taskId, "--turns", "200", "--max-lines", "2000"], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const response = JSON.parse(output) as { ok?: unknown; data?: CockpitTaskSnapshot };
  if (response.ok !== true || response.data?.id !== taskId || !Array.isArray(response.data.conversation)) {
    throw new PublicProjectionError("Cockpit task query did not return the exact durable task");
  }
  return response.data;
}

export function createPromotionApprovalReceiptFromCockpit(options: {
  request: PromotionApprovalRequest;
  taskId: string;
  askId: string;
  reader?: CockpitTaskReader;
}): PromotionApprovalReceipt {
  const reader = options.reader ?? defaultCockpitTaskReader;
  const task = reader(options.taskId);
  const matching: CockpitApprovalEvent[] = [];
  for (const item of task.conversation) {
    if (item.role !== "user") continue;
    try {
      const event = JSON.parse(item.text) as CockpitApprovalEvent;
      if (event.event === "cockpit.ask.resolved" && event.ask_id === options.askId) matching.push(event);
    } catch {
      // Ordinary user messages are not approval events.
    }
  }
  if (matching.length !== 1) throw new PublicProjectionError("Cockpit durable approval event is missing or ambiguous");
  const event = matching[0];
  exactKeys(event, ["event", "version", "ask_id", "answered_by", "resolved_at", "answers"], "Cockpit approval event");
  if (event.version !== 1 || event.answered_by !== "user") {
    throw new PublicProjectionError("Cockpit approval event was not answered by the human user");
  }
  if (event.answers.length !== 1 || event.answers[0].type !== "choice"
    || event.answers[0].value !== approvalChoice(options.request)) {
    throw new PublicProjectionError("Cockpit approval event does not bind the exact promotion request");
  }
  return {
    version: "promotion-approval-receipt/v1",
    approval_id: event.ask_id,
    approver: { identity: "cockpit:user" },
    approved_at: event.resolved_at,
    stage_a_receipt_sha256: options.request.stage_a_receipt_sha256,
    destination: options.request.destination,
    operation_scope: options.request.operation_scope,
    cockpit_source: { task_id: options.taskId, event_id: event.ask_id },
  };
}

export function createCockpitApprovalEventVerifier(
  reader: CockpitTaskReader = defaultCockpitTaskReader,
): TrustedEvidenceVerifier<PromotionApprovalReceipt> {
  return {
    verify(bytes) {
      const approval = parseCanonical<PromotionApprovalReceipt>(bytes, "Cockpit approval receipt");
      const task = reader(approval.cockpit_source.task_id);
      const events: CockpitApprovalEvent[] = [];
      for (const item of task.conversation) {
        if (item.role !== "user") continue;
        try {
          const event = JSON.parse(item.text) as CockpitApprovalEvent;
          if (event.event === "cockpit.ask.resolved" && event.ask_id === approval.cockpit_source.event_id) {
            events.push(event);
          }
        } catch {
          // Ordinary user messages are not approval events.
        }
      }
      if (events.length !== 1) throw new PublicProjectionError("Cockpit durable approval event is missing or ambiguous");
      const event = events[0];
      exactKeys(event, ["event", "version", "ask_id", "answered_by", "resolved_at", "answers"], "Cockpit approval event");
      if (event.version !== 1 || event.answered_by !== "user" || event.ask_id !== approval.approval_id
        || event.ask_id !== approval.cockpit_source.event_id) {
        throw new PublicProjectionError("Cockpit approval was not answered by the human user for the exact Ask");
      }
      if (event.resolved_at !== approval.approved_at) {
        throw new PublicProjectionError("Cockpit approval time is not bound to the durable event");
      }
      if (event.answers.length !== 1
        || event.answers[0].type !== "choice"
        || event.answers[0].value !== approvalChoice(approvalRequestFromReceipt(approval))) {
        throw new PublicProjectionError("Cockpit approval choice does not bind the exact promotion request");
      }
      if (approval.approver.identity !== "cockpit:user") {
        throw new PublicProjectionError("Cockpit approval identity is not the authenticated human user");
      }
      return {
        evidence: approval,
        verification: {
          mechanism: "cockpit-approval-event",
          verifier_id: "cockpit-task-history/v1",
          evidence_sha256: sha256Hex(bytes),
        },
      };
    },
  };
}
