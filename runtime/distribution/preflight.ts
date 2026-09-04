import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateArtifact } from "../artifacts/loaders.js";
import { canonicalJson, hashCanonical, sha256File, verifyLatestGeneration } from "../review/social-review-generation.js";
import { verifyCurrentReviewReady } from "../review/review-ready-transaction.js";
import { verifyPackageArtifactClosure } from "../packaging/package-verification.js";

export type DistributionAction = "review_share" | "external_export" | "external_upload" | "production_release" | "publication" | "public_upload";
export type DistributionAdapterKind = "connector" | "cockpit" | "cli";

export type DistributionReasonCode =
  | "REQUEST_INVALID" | "CURRENT_GENERATION_MISMATCH" | "REVIEW_STATE_MISSING" | "REVIEW_NOT_CURRENT"
  | "REVIEW_RECEIPT_INVALID" | "REVIEW_IDENTITY_MISMATCH" | "REVIEW_GATE_NOT_OPEN"
  | "QA_FAILED" | "QA_INCOMPLETE" | "DECLARED_HOLD" | "HUMAN_RESIDUAL_UNRESOLVED"
  | "GEOMETRY_UNKNOWN" | "GEOMETRY_PROVISIONAL" | "POLICY_ONLY_AS_PLATFORM_MEASURED"
  | "PACKAGE_MISSING" | "PACKAGE_EMPTY" | "PACKAGE_INVALID" | "PACKAGE_ARTIFACT_MISSING"
  | "PACKAGE_PATH_ESCAPE" | "PACKAGE_HASH_MISMATCH" | "OUTPUT_HASH_MISMATCH"
  | "PACKAGE_REVIEW_IDENTITY_MISMATCH"
  | "OVERRIDE_INVALID" | "OVERRIDE_EXPIRED" | "OVERRIDE_IDENTITY_MISMATCH" | "OVERRIDE_ACTION_FORBIDDEN";

export interface DistributionPreflightRequest {
  version: "distribution-preflight-request/v1";
  project_dir: string;
  project_id: string;
  action: DistributionAction;
  generation_id: string;
  review_identity: string;
  output: { locator: string; sha256: string };
  package: { manifest_locator: string; manifest_sha256: string };
  platform_geometry: { status: "unknown" | "provisional" | "measured"; evidence_level: "policy_only" | "platform_measured" | "human_verified" };
  declared_holds: string[];
  override_locator: string | null;
  evaluated_at: string;
}

export interface DistributionIdentity {
  project_id: string;
  generation_id: string;
  review_identity: string;
  review_receipt_sha256: string;
  output_sha256: string;
  package_manifest_sha256: string;
}

export interface DistributionReason {
  code: DistributionReasonCode;
  artifact: string;
  identity: string | null;
  overrideable: boolean;
}

export interface DistributionPreflightDecision {
  version: "distribution-preflight-decision/v1";
  decision_id: string;
  decision: "ALLOW" | "BLOCK";
  action: DistributionAction;
  identity: DistributionIdentity;
  reasons: DistributionReason[];
  override: { locator: string; sha256: string; actor: string } | null;
}

interface ReviewState {
  version: string; project_id: string; review_identity: string; generation_id: string;
  status: string; artifacts: { preview: string; qa_receipt: string; unanswered_ask: string };
  qa_receipt: { path: string; sha256: string } | null;
}

interface ReviewReceipt {
  project_id: string; review_identity: string; identity: { generation_id: string; video_sha256: string; timeline_sha256: string };
  status: "pass" | "warning" | "blocker";
  captions: { evidence_level: "policy_only" | "platform_measured" | "human_verified" };
  findings: { blockers: string[]; human_residual: string[] };
}

interface PackageManifest {
  project_id: string;
  artifacts: { final_video: { path: string; sha256: string }; qa_report: { path: string; sha256: string } };
  provenance: { editorial_timeline_hash: string };
}

interface PackageQa { project_id: string; passed: boolean; checks: Array<{ passed: boolean }>; source_inputs_freshness?: { status: string } }

interface OverrideReceipt {
  version: "distribution-review-override/v1"; actor: string; scope: "review_only_distribution";
  project_id: string; generation_id: string; review_identity: string; timeline_sha256: string; output_sha256: string;
  package_manifest_sha256: string; reason: string; issued_at: string; expires_at: string;
}

const ZERO = `sha256:${"0".repeat(64)}`;
const REASON_ORDER: DistributionReasonCode[] = [
  "REQUEST_INVALID", "CURRENT_GENERATION_MISMATCH", "REVIEW_STATE_MISSING", "REVIEW_NOT_CURRENT",
  "REVIEW_RECEIPT_INVALID", "REVIEW_IDENTITY_MISMATCH", "REVIEW_GATE_NOT_OPEN", "QA_FAILED", "QA_INCOMPLETE",
  "DECLARED_HOLD", "HUMAN_RESIDUAL_UNRESOLVED", "GEOMETRY_UNKNOWN", "GEOMETRY_PROVISIONAL",
  "POLICY_ONLY_AS_PLATFORM_MEASURED", "PACKAGE_MISSING", "PACKAGE_EMPTY", "PACKAGE_INVALID",
  "PACKAGE_ARTIFACT_MISSING", "PACKAGE_PATH_ESCAPE", "PACKAGE_HASH_MISMATCH", "OUTPUT_HASH_MISMATCH",
  "PACKAGE_REVIEW_IDENTITY_MISMATCH",
  "OVERRIDE_INVALID", "OVERRIDE_EXPIRED", "OVERRIDE_IDENTITY_MISMATCH", "OVERRIDE_ACTION_FORBIDDEN",
];
const OVERRIDEABLE = new Set<DistributionReasonCode>([
  "REVIEW_GATE_NOT_OPEN", "QA_FAILED", "QA_INCOMPLETE", "DECLARED_HOLD", "HUMAN_RESIDUAL_UNRESOLVED",
  "GEOMETRY_UNKNOWN", "GEOMETRY_PROVISIONAL", "POLICY_ONLY_AS_PLATFORM_MEASURED",
]);

function portable(locator: string): boolean { return /^project:[^/].+/.test(locator) && !locator.slice(8).split(/[\\/]/).includes(".."); }

function contained(projectDir: string, locator: string): string {
  if (!portable(locator)) throw new Error("portable project locator required");
  const root = fs.realpathSync(projectDir);
  const lexical = path.resolve(root, locator.slice("project:".length));
  if (!lexical.startsWith(`${root}${path.sep}`)) throw new Error("path escape");
  const real = fs.realpathSync(lexical);
  if (!real.startsWith(`${root}${path.sep}`) || !fs.lstatSync(lexical).isFile() || !fs.statSync(real).isFile()) throw new Error("path escape");
  return real;
}

function locatorForManifestPath(projectDir: string, manifestPath: string): string {
  const root = fs.realpathSync(projectDir);
  const absolute = path.isAbsolute(manifestPath) ? path.resolve(manifestPath) : path.resolve(root, manifestPath);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error("path escape");
  return `project:${path.relative(root, absolute).split(path.sep).join("/")}`;
}

function json<T>(file: string): T { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
function reason(code: DistributionReasonCode, artifact: string, identity: string | null = null): DistributionReason {
  return { code, artifact, identity, overrideable: OVERRIDEABLE.has(code) };
}

function parseTime(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildDecision(action: DistributionAction, identity: DistributionIdentity, reasons: DistributionReason[], override: DistributionPreflightDecision["override"]): DistributionPreflightDecision {
  const ordered = [...reasons].sort((a, b) => REASON_ORDER.indexOf(a.code) - REASON_ORDER.indexOf(b.code) || a.artifact.localeCompare(b.artifact, "en"));
  const body = { version: "distribution-preflight-decision/v1" as const, decision: ordered.length === 0 ? "ALLOW" as const : "BLOCK" as const, action, identity, reasons: ordered, override };
  const result = { ...body, decision_id: hashCanonical(body) };
  validateArtifact(result, "distribution-preflight-decision.schema.json");
  return result;
}

function validateOverride(request: DistributionPreflightRequest, identity: DistributionIdentity, timelineSha256: string | null, blocking: DistributionReason[]): { binding: DistributionPreflightDecision["override"]; errors: DistributionReason[] } {
  if (!request.override_locator) return { binding: null, errors: [] };
  if (request.action !== "review_share") return { binding: null, errors: [reason("OVERRIDE_ACTION_FORBIDDEN", request.override_locator)] };
  let file: string;
  let receipt: OverrideReceipt;
  try {
    file = contained(request.project_dir, request.override_locator);
    receipt = json(file);
    validateArtifact(receipt, "distribution-review-override.schema.json");
  } catch {
    return { binding: null, errors: [reason("OVERRIDE_INVALID", request.override_locator)] };
  }
  const now = parseTime(request.evaluated_at);
  const issued = parseTime(receipt.issued_at);
  const expires = parseTime(receipt.expires_at);
  if (now === null || issued === null || expires === null || issued > now || expires <= now || expires <= issued) {
    return { binding: null, errors: [reason("OVERRIDE_EXPIRED", request.override_locator)] };
  }
  if (receipt.scope !== "review_only_distribution" || receipt.project_id !== identity.project_id
    || receipt.generation_id !== identity.generation_id || receipt.review_identity !== identity.review_identity
    || receipt.timeline_sha256 !== timelineSha256
    || receipt.output_sha256 !== identity.output_sha256 || receipt.package_manifest_sha256 !== identity.package_manifest_sha256) {
    return { binding: null, errors: [reason("OVERRIDE_IDENTITY_MISMATCH", request.override_locator)] };
  }
  if (blocking.some((item) => !item.overrideable)) return { binding: null, errors: [] };
  return { binding: { locator: request.override_locator, sha256: sha256File(file), actor: receipt.actor }, errors: [] };
}

export function evaluateDistributionPreflight(request: DistributionPreflightRequest): DistributionPreflightDecision {
  const identity: DistributionIdentity = { project_id: request.project_id, generation_id: request.generation_id, review_identity: request.review_identity, review_receipt_sha256: ZERO, output_sha256: request.output.sha256, package_manifest_sha256: request.package.manifest_sha256 };
  const reasons: DistributionReason[] = [];
  try { validateArtifact(request, "distribution-preflight-request.schema.json"); } catch { return buildDecision(request.action, identity, [reason("REQUEST_INVALID", "request")], null); }
  const projectDir = path.resolve(request.project_dir);

  try {
    const latest = verifyLatestGeneration(projectDir);
    if (latest.project_id !== request.project_id || latest.generation_id !== request.generation_id) reasons.push(reason("CURRENT_GENERATION_MISMATCH", "project:09_output/social-review/latest.json", latest.generation_id));
  } catch { reasons.push(reason("CURRENT_GENERATION_MISMATCH", "project:09_output/social-review/latest.json", request.generation_id)); }

  let review: ReviewReceipt | null = null;
  let verifiedTimelineSha256: string | null = null;
  let verifiedGeometryEvidence: "policy_only" | "platform_measured" | "human_verified" = "policy_only";
  try {
    const statePath = contained(projectDir, "project:06_review/review-ready-state.json");
    const state = json<ReviewState>(statePath);
    validateArtifact(state, "review-ready-state.schema.json");
    if (state.status !== "ready" || Object.values(state.artifacts).some((value) => value !== "CURRENT")) reasons.push(reason("REVIEW_NOT_CURRENT", "project:06_review/review-ready-state.json", state.review_identity));
    if (state.project_id !== request.project_id || state.generation_id !== request.generation_id || state.review_identity !== request.review_identity) reasons.push(reason("REVIEW_IDENTITY_MISMATCH", "project:06_review/review-ready-state.json", state.review_identity));
    if (!state.qa_receipt) throw new Error("missing receipt");
    const receiptPath = contained(projectDir, `project:${state.qa_receipt.path}`);
    identity.review_receipt_sha256 = sha256File(receiptPath);
    if (identity.review_receipt_sha256 !== state.qa_receipt.sha256) throw new Error("receipt hash mismatch");
    review = json<ReviewReceipt>(receiptPath);
    validateArtifact(review, "review-qa-receipt.schema.json");
    if (review.project_id !== request.project_id || review.review_identity !== request.review_identity || review.identity.generation_id !== request.generation_id) reasons.push(reason("REVIEW_IDENTITY_MISMATCH", `project:${state.qa_receipt.path}`, review.review_identity));
    if (review.status === "blocker" || review.findings.blockers.length > 0) reasons.push(reason("QA_FAILED", `project:${state.qa_receipt.path}`, identity.review_receipt_sha256));
    if (!review.status || !review.findings || !review.captions) reasons.push(reason("QA_INCOMPLETE", `project:${state.qa_receipt.path}`, identity.review_receipt_sha256));
    if (review.findings.human_residual.length > 0) reasons.push(reason("HUMAN_RESIDUAL_UNRESOLVED", `project:${state.qa_receipt.path}`, identity.review_receipt_sha256));
  } catch (error) {
    reasons.push(reason(fs.existsSync(path.join(projectDir, "06_review/review-ready-state.json")) ? "REVIEW_RECEIPT_INVALID" : "REVIEW_STATE_MISSING", "project:06_review/review-ready-state.json"));
  }

  try {
    const verified = verifyCurrentReviewReady(projectDir);
    identity.review_receipt_sha256 = verified.receipt_sha256;
    review = verified.receipt;
    verifiedTimelineSha256 = verified.timeline_sha256;
    verifiedGeometryEvidence = verified.geometry_evidence_level;
    if (verified.state.project_id !== request.project_id || verified.state.generation_id !== request.generation_id || verified.state.review_identity !== request.review_identity) {
      reasons.push(reason("REVIEW_IDENTITY_MISMATCH", "project:06_review/review-ready-state.json", verified.state.review_identity));
    }
  } catch {
    reasons.push(reason("REVIEW_RECEIPT_INVALID", "project:06_review/review-ready-state.json"));
  }

  try {
    const state = parseYaml(fs.readFileSync(contained(projectDir, "project:project_state.yaml"), "utf8")) as { project_id?: string; gates?: { review_gate?: string }; review_transaction?: { review_identity?: string; status?: string } };
    validateArtifact(state, "project-state.schema.json");
    if (state.project_id !== request.project_id || state.gates?.review_gate !== "open" || state.review_transaction?.review_identity !== request.review_identity || state.review_transaction?.status !== "ready") reasons.push(reason("REVIEW_GATE_NOT_OPEN", "project:project_state.yaml", request.review_identity));
  } catch { reasons.push(reason("REVIEW_GATE_NOT_OPEN", "project:project_state.yaml", request.review_identity)); }

  if (request.declared_holds.length > 0) reasons.push(reason("DECLARED_HOLD", "request:declared_holds", hashCanonical(request.declared_holds)));
  if (request.platform_geometry.status === "unknown") reasons.push(reason("GEOMETRY_UNKNOWN", "request:platform_geometry"));
  if (request.platform_geometry.status === "provisional") reasons.push(reason("GEOMETRY_PROVISIONAL", "request:platform_geometry"));
  if (request.platform_geometry.status === "measured" && (request.platform_geometry.evidence_level === "policy_only" || review?.captions.evidence_level === "policy_only" || verifiedGeometryEvidence === "policy_only")) reasons.push(reason("POLICY_ONLY_AS_PLATFORM_MEASURED", "request:platform_geometry"));

  let manifest: PackageManifest | null = null;
  let manifestPath = "";
  try {
    manifestPath = contained(projectDir, request.package.manifest_locator);
    if (fs.statSync(manifestPath).size === 0) throw new Error("empty");
    identity.package_manifest_sha256 = sha256File(manifestPath);
    if (identity.package_manifest_sha256 !== request.package.manifest_sha256) reasons.push(reason("PACKAGE_HASH_MISMATCH", request.package.manifest_locator, identity.package_manifest_sha256));
    manifest = json<PackageManifest>(manifestPath);
    validateArtifact(manifest, "package-manifest.schema.json");
    if (manifest.project_id !== request.project_id) reasons.push(reason("PACKAGE_INVALID", request.package.manifest_locator, identity.package_manifest_sha256));
    for (const failure of verifyPackageArtifactClosure(projectDir, manifest as never)) {
      const code = failure.kind === "path_escape" ? "PACKAGE_PATH_ESCAPE"
        : failure.kind === "missing" ? "PACKAGE_ARTIFACT_MISSING"
        : failure.kind === "empty" ? "PACKAGE_EMPTY" : "PACKAGE_HASH_MISMATCH";
      reasons.push(reason(code, `project:${failure.path}`));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = !fs.existsSync(path.resolve(projectDir, request.package.manifest_locator.replace(/^project:/, ""))) ? "PACKAGE_MISSING" : message === "empty" ? "PACKAGE_EMPTY" : message.includes("escape") ? "PACKAGE_PATH_ESCAPE" : "PACKAGE_INVALID";
    reasons.push(reason(code, request.package.manifest_locator));
  }

  if (manifest) {
    try {
      const outputLocator = locatorForManifestPath(projectDir, manifest.artifacts.final_video.path);
      const outputFile = contained(projectDir, outputLocator);
      const currentOutputHash = sha256File(outputFile);
      identity.output_sha256 = currentOutputHash;
      if (outputLocator !== request.output.locator || currentOutputHash !== request.output.sha256 || currentOutputHash !== manifest.artifacts.final_video.sha256) reasons.push(reason("OUTPUT_HASH_MISMATCH", outputLocator, currentOutputHash));
      const qaLocator = locatorForManifestPath(projectDir, manifest.artifacts.qa_report.path);
      const qaFile = contained(projectDir, qaLocator);
      if (sha256File(qaFile) !== manifest.artifacts.qa_report.sha256) reasons.push(reason("PACKAGE_HASH_MISMATCH", qaLocator, sha256File(qaFile)));
      const qa = json<PackageQa>(qaFile);
      validateArtifact(qa, "package-qa-report.schema.json");
      if (qa.project_id !== request.project_id || qa.checks.some((check) => !check.passed) || qa.passed === false) reasons.push(reason("QA_FAILED", qaLocator, manifest.artifacts.qa_report.sha256));
      if (qa.checks.length === 0) reasons.push(reason("QA_INCOMPLETE", qaLocator, manifest.artifacts.qa_report.sha256));
      if (qa.source_inputs_freshness?.status === "stale") reasons.push(reason("QA_INCOMPLETE", qaLocator, manifest.artifacts.qa_report.sha256));
      for (const artifact of Object.values(manifest.artifacts)) {
        if (Array.isArray(artifact)) continue;
        const locator = locatorForManifestPath(projectDir, artifact.path);
        const file = contained(projectDir, locator);
        if (sha256File(file) !== artifact.sha256) reasons.push(reason("PACKAGE_HASH_MISMATCH", locator, sha256File(file)));
      }
      const packageTimelineHash = manifest.provenance.editorial_timeline_hash.startsWith("sha256:")
        ? manifest.provenance.editorial_timeline_hash : `sha256:${manifest.provenance.editorial_timeline_hash}`;
      if (!review || packageTimelineHash !== verifiedTimelineSha256) reasons.push(reason("PACKAGE_REVIEW_IDENTITY_MISMATCH", request.package.manifest_locator, packageTimelineHash));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      reasons.push(reason(message.includes("escape") ? "PACKAGE_PATH_ESCAPE" : "PACKAGE_ARTIFACT_MISSING", request.package.manifest_locator, identity.package_manifest_sha256));
    }
  }

  const deduped = [...new Map(reasons.map((item) => [`${item.code}\0${item.artifact}`, item])).values()];
  const override = validateOverride(request, identity, verifiedTimelineSha256, deduped);
  const withOverrideErrors = [...deduped, ...override.errors];
  const remaining = override.binding ? withOverrideErrors.filter((item) => !item.overrideable) : withOverrideErrors;
  return buildDecision(request.action, identity, remaining, override.binding);
}

export interface DistributionSender<T> { send(decision: DistributionPreflightDecision): Promise<T> }
export async function distributeThroughPreflight<T>(_adapter: DistributionAdapterKind, request: DistributionPreflightRequest, sender: DistributionSender<T>): Promise<{ decision: DistributionPreflightDecision; sent: boolean; result: T | null }> {
  const decision = evaluateDistributionPreflight(request);
  if (decision.decision === "BLOCK") return { decision, sent: false, result: null };
  return { decision, sent: true, result: await sender.send(decision) };
}

export function serializeDistributionDecision(decision: DistributionPreflightDecision): string { return `${canonicalJson(decision)}\n`; }
