import * as fs from "node:fs";
import * as path from "node:path";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import { validateAgainstSchema } from "../commands/shared.js";
import { computeSha256 } from "../packaging/manifest.js";
import {
  loadPlatformSafeZoneProfile,
  verifyPlatformScreenshotEvidence,
  type SafeZoneRegressionReceipt,
} from "../platform/safe-zone-profile.js";
import type { RenderRouteReceipt } from "../render/route-resolver.js";

export const PRIVATE_PILOT_MANIFEST_VERSION = "private-pilot-manifest/v1" as const;
export const PRIVATE_PILOT_RECEIPT_VERSION = "private-pilot-gate-receipt/v1" as const;
export const PRIVATE_PILOT_MANIFEST_RELATIVE_PATH = "07_package/private-pilot/manifest.json";

export const PRIVATE_PILOT_GATES = [
  "agent_qa",
  "human_visual_audio",
  "nle_handoff",
  "platform_preview",
] as const;
export const PRIVATE_PILOT_AGENT_QA_DOMAINS = [
  "schema",
  "timing",
  "caption",
  "safe-zone",
  "audio",
  "SFX",
  "route",
  "accessibility",
] as const;

export type PrivatePilotGate = (typeof PRIVATE_PILOT_GATES)[number];
export type PrivatePilotAgentQaDomain = (typeof PRIVATE_PILOT_AGENT_QA_DOMAINS)[number];
export type PrivatePilotFreshnessStatus = "fresh" | "stale" | "unknown" | "mismatched";

export interface PrivatePilotArtifactRef {
  path: string;
  sha256: string;
}

export interface PrivatePilotManifest {
  version: typeof PRIVATE_PILOT_MANIFEST_VERSION;
  pilot_id: string;
  project_id: string;
  created_at: string;
  receipts: Array<PrivatePilotArtifactRef & { gate: PrivatePilotGate }>;
  provenance: {
    producer: string;
    method: string;
    synthetic_fixture: boolean;
    inputs: PrivatePilotArtifactRef[];
  };
  public_promotion: "out_of_scope";
}

export interface PrivatePilotGateReceipt {
  version: typeof PRIVATE_PILOT_RECEIPT_VERSION;
  pilot_id: string;
  project_id: string;
  gate: PrivatePilotGate;
  requirement: "required" | "not_required";
  status:
    | "missing"
    | "pending"
    | "passed"
    | "approved"
    | "confirmed"
    | "not_required"
    | "failed"
    | "rejected"
    | "stale"
    | "mismatched";
  decision: "hold" | "pass" | "approve" | "reject" | "not_required";
  evidence: {
    record_type: PrivatePilotGate;
    summary: string;
    recorded_at: string;
    recorded_by: string;
    artifacts: PrivatePilotArtifactRef[];
    checks?: Array<{ id: PrivatePilotAgentQaDomain; status: "pass" | "fail" | "not_run"; details: string }>;
    human_review?: {
      reviewed: boolean;
      reviewer: string;
      visual: boolean;
      audio: boolean;
      decision: "approved" | "pending" | "rejected";
    };
    handoff?: {
      confirmation: "confirmed" | "pending" | "rejected" | "not_required";
      route_kind: "canonical_engine_render" | "supplied_final" | "external_manual_nle" | "not_applicable";
      artifacts: PrivatePilotArtifactRef[];
    };
    platform_preview?: {
      platform: "instagram" | "tiktok" | "youtube_shorts" | "fixture";
      surface: "organic" | "ads" | "fixture";
      profile_id: string;
      profile: PrivatePilotArtifactRef;
      profile_evidence_status: "verified" | "partial" | "unavailable" | "stale";
      profile_supersession_state: "active" | "stale" | "superseded" | "deprecated";
      current_profile: boolean;
      human_preview: boolean;
      safe_zone_receipt: PrivatePilotArtifactRef;
    };
  };
  provenance: {
    producer: string;
    method: string;
    captured_at: string;
    inputs: PrivatePilotArtifactRef[];
    profile?: PrivatePilotArtifactRef;
    synthetic_fixture: boolean;
  };
  freshness: {
    status: PrivatePilotFreshnessStatus;
    checked_at: string;
    input_fingerprint: string;
    valid_until?: string;
    reason: string;
  };
}

export interface PrivatePilotGateEvaluation {
  gate: PrivatePilotGate;
  ready: boolean;
  status: PrivatePilotGateReceipt["status"] | "missing";
  decision: PrivatePilotGateReceipt["decision"] | "missing";
  freshness: PrivatePilotFreshnessStatus | "missing";
  receipt_path?: string;
  issues: string[];
}

export interface PrivatePilotEvaluation {
  version: "private-pilot-evaluation/v1";
  ready: boolean;
  decision: "ready" | "hold";
  project_id?: string;
  pilot_id?: string;
  synthetic_fixture: boolean;
  manifest_path: string;
  manifest_sha256?: string;
  gates: Record<PrivatePilotGate, PrivatePilotGateEvaluation>;
  reasons: string[];
  public_promotion: "out_of_scope";
}

export interface EvaluatePrivatePilotOptions {
  manifestPath?: string;
  now?: Date;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function emptyGateEvaluation(gate: PrivatePilotGate, issue: string): PrivatePilotGateEvaluation {
  return {
    gate,
    ready: false,
    status: "missing",
    decision: "missing",
    freshness: "missing",
    issues: [issue],
  };
}

function emptyGates(issue: string): Record<PrivatePilotGate, PrivatePilotGateEvaluation> {
  return Object.fromEntries(PRIVATE_PILOT_GATES.map((gate) => [gate, emptyGateEvaluation(gate, issue)])) as Record<PrivatePilotGate, PrivatePilotGateEvaluation>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function resolveContainedPath(projectDir: string, referencedPath: string): string | null {
  const root = path.resolve(projectDir);
  const candidate = path.resolve(root, referencedPath);
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(candidate)) return candidate;

  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  const realRelative = path.relative(realRoot, realCandidate);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return null;
  return realCandidate;
}

function verifyArtifactRefs(
  projectDir: string,
  refs: PrivatePilotArtifactRef[],
  label: string,
): string[] {
  const issues: string[] = [];
  for (const ref of refs) {
    if (!SHA256.test(ref.sha256)) {
      issues.push(`${label}: invalid sha256 for ${ref.path}`);
      continue;
    }
    const resolved = resolveContainedPath(projectDir, ref.path);
    if (!resolved) {
      issues.push(`${label}: artifact escapes project root: ${ref.path}`);
      continue;
    }
    if (!fs.existsSync(resolved)) {
      issues.push(`${label}: artifact is missing: ${ref.path}`);
      continue;
    }
    let actual: string;
    try {
      actual = computeSha256(resolved);
    } catch (error) {
      issues.push(`${label}: artifact is unreadable: ${ref.path} (${errorMessage(error)})`);
      continue;
    }
    if (actual !== ref.sha256) {
      issues.push(`${label}: hash mismatch for ${ref.path}: declared=${ref.sha256} actual=${actual}`);
    }
  }
  return issues;
}

export function computePrivatePilotInputFingerprint(refs: PrivatePilotArtifactRef[]): string {
  return computeNormalizedJsonHash(
    refs
      .map((ref) => ({ path: ref.path, sha256: ref.sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function manifestPathFor(projectDir: string, manifestPath?: string): string {
  return path.resolve(projectDir, manifestPath ?? PRIVATE_PILOT_MANIFEST_RELATIVE_PATH);
}

function manifestResult(
  manifestPath: string,
  issue: string,
  extras: Partial<PrivatePilotEvaluation> = {},
): PrivatePilotEvaluation {
  return {
    version: "private-pilot-evaluation/v1",
    ready: false,
    decision: "hold",
    synthetic_fixture: extras.synthetic_fixture ?? false,
    manifest_path: manifestPath,
    gates: emptyGates(issue),
    reasons: [issue],
    public_promotion: "out_of_scope",
    ...extras,
  };
}

function receiptRefPath(projectDir: string, ref: PrivatePilotArtifactRef): string | null {
  return resolveContainedPath(projectDir, ref.path);
}

function artifactRefsMatch(left: unknown, right: PrivatePilotArtifactRef): boolean {
  return isRecord(left)
    && left.path === right.path
    && left.sha256 === right.sha256;
}

function isPilotCommonInput(
  manifest: PrivatePilotManifest,
  receipt: PrivatePilotGateReceipt,
  ref: unknown,
): boolean {
  if (!isRecord(ref) || typeof ref.path !== "string" || typeof ref.sha256 !== "string") return false;
  return manifest.provenance.inputs.some((input) => input.path === ref.path && input.sha256 === ref.sha256)
    && receipt.provenance.inputs.some((input) => input.path === ref.path && input.sha256 === ref.sha256);
}

function hasConfirmedBoundRouteReceipt(
  projectDir: string,
  manifest: PrivatePilotManifest,
  receipt: PrivatePilotGateReceipt,
  handoff: NonNullable<PrivatePilotGateReceipt["evidence"]["handoff"]>,
): boolean {
  for (const artifact of handoff.artifacts) {
    const artifactPath = receiptRefPath(projectDir, artifact);
    if (!artifactPath || !fs.existsSync(artifactPath)) continue;

    let routeRaw: unknown;
    try {
      routeRaw = readJson(artifactPath);
    } catch {
      continue;
    }
    const routeValidation = validateAgainstSchema(routeRaw, "render-route-receipt.schema.json");
    if (!routeValidation.valid || !isRecord(routeRaw)) continue;

    const routeReceipt = routeRaw as unknown as RenderRouteReceipt;
    const routeEvidence = routeReceipt.route_evidence;
    if (!routeEvidence) continue;
    if (routeReceipt.receipt_version !== "render-route-receipt/v3") continue;
    if (routeEvidence.route_kind !== "supplied_final" && routeEvidence.route_kind !== "external_manual_nle") continue;
    if (routeEvidence.ownership === "canonical" || routeEvidence.canonical_claim !== false) continue;
    if (
      routeEvidence.handoff.required !== true
      || routeEvidence.handoff.status !== "confirmed"
      || routeEvidence.handoff.human_approval_status !== "approved"
      || routeEvidence.handoff.artifacts.length < 1
    ) continue;
    if (!artifactRefsMatch(routeReceipt.inputs.timeline, routeEvidence.source_identity.timeline)) continue;
    if (!isPilotCommonInput(manifest, receipt, routeEvidence.source_identity.timeline)) continue;

    return true;
  }
  return false;
}

function verifyPlatformSafeZoneReceipt(
  projectDir: string,
  receiptRef: PrivatePilotArtifactRef,
  profile: ReturnType<typeof loadPlatformSafeZoneProfile>["profile"],
  profileHash: string,
): string[] {
  const receiptPath = receiptRefPath(projectDir, receiptRef);
  if (!receiptPath || !fs.existsSync(receiptPath)) return [];
  try {
    const raw = readJson(receiptPath);
    if (!isRecord(raw)) return ["platform preview safe-zone receipt is not an object"];
    const receipt = raw as Partial<SafeZoneRegressionReceipt>;
    const issues: string[] = [];
    if (receipt.version !== "platform-safe-zone-qa/v1") issues.push("platform preview safe-zone receipt version is invalid");
    if (receipt.profile_id !== profile.profile_id) issues.push(`platform preview safe-zone profile_id mismatch: receipt=${String(receipt.profile_id ?? "missing")} profile=${profile.profile_id}`);
    if (receipt.profile_hash !== profileHash) issues.push(`platform preview safe-zone profile_hash mismatch: receipt=${String(receipt.profile_hash ?? "missing")} profile=${profileHash}`);
    if (!Array.isArray(receipt.checks)) issues.push("platform preview safe-zone receipt checks are missing");
    if (!(["pass", "degraded", "human_hold"] as const).includes(receipt.status as "pass" | "degraded" | "human_hold")) {
      issues.push(`platform preview safe-zone receipt status is invalid: ${String(receipt.status ?? "missing")}`);
    }
    const expectedHumanPreviewRequired = receipt.status !== "pass" || profile.fallback.human_preview_required;
    if (receipt.human_preview_required !== expectedHumanPreviewRequired) {
      issues.push("platform preview safe-zone receipt human_preview_required is inconsistent with its status/profile");
    }
    if (receipt.status === "pass" && (profile.evidence_status !== "verified" || profile.geometry.status !== "verified" || profile.geometry.safe_regions.unknown || profile.geometry.ui_regions.unknown)) {
      issues.push("platform preview safe-zone receipt cannot claim pass for an unverified/unknown profile");
    }
    const { receipt_hash: declaredReceiptHash, ...unsignedReceipt } = raw;
    if (declaredReceiptHash !== computeNormalizedJsonHash(unsignedReceipt)) {
      issues.push("platform preview safe-zone receipt_hash does not match receipt content");
    }
    return issues;
  } catch (error) {
    return [`platform preview safe-zone receipt is unreadable: ${errorMessage(error)}`];
  }
}

function verifyPlatformPreviewReferences(
  projectDir: string,
  preview: PrivatePilotGateReceipt["evidence"]["platform_preview"],
): string[] {
  if (!preview) return [];
  const profilePath = receiptRefPath(projectDir, preview.profile);
  if (!profilePath || !fs.existsSync(profilePath)) return [];
  try {
    const loaded = loadPlatformSafeZoneProfile(profilePath);
    verifyPlatformScreenshotEvidence(loaded.profile, projectDir);
    const issues: string[] = [];
    if (loaded.profile.profile_id !== preview.profile_id) {
      issues.push(`platform preview profile_id mismatch: preview=${preview.profile_id} profile=${loaded.profile.profile_id}`);
    }
    if (loaded.profile.platform !== preview.platform) {
      issues.push(`platform preview platform mismatch: preview=${preview.platform} profile=${loaded.profile.platform}`);
    }
    if (loaded.profile.surface !== preview.surface) {
      issues.push(`platform preview surface mismatch: preview=${preview.surface} profile=${loaded.profile.surface}`);
    }
    if (loaded.profile.evidence_status !== preview.profile_evidence_status) {
      issues.push(`platform preview evidence_status mismatch: preview=${preview.profile_evidence_status} profile=${loaded.profile.evidence_status}`);
    }
    if (loaded.profile.supersession.state !== preview.profile_supersession_state) {
      issues.push(`platform preview supersession mismatch: preview=${preview.profile_supersession_state} profile=${loaded.profile.supersession.state}`);
    }
    const current = loaded.profile.evidence_status !== "stale" && loaded.profile.supersession.state === "active";
    if (preview.current_profile && !current) {
      issues.push(`platform preview current_profile mismatch: receipt=true profile_current=${current}`);
    }
    issues.push(...verifyPlatformSafeZoneReceipt(projectDir, preview.safe_zone_receipt, loaded.profile, loaded.hash));
    return issues;
  } catch (error) {
    return [`platform preview profile contract invalid: ${errorMessage(error)}`];
  }
}

function evaluateReceipt(
  projectDir: string,
  manifest: PrivatePilotManifest,
  receipt: PrivatePilotGateReceipt,
  receiptPath: string,
  now: Date,
): PrivatePilotGateEvaluation {
  const issues: string[] = [];
  const gate = receipt.gate;

  if (receipt.version !== PRIVATE_PILOT_RECEIPT_VERSION) {
    issues.push(`receipt version is not ${PRIVATE_PILOT_RECEIPT_VERSION}`);
  }
  if (receipt.project_id !== manifest.project_id) {
    issues.push(`project_id mismatch: manifest=${manifest.project_id} receipt=${receipt.project_id}`);
  }
  if (receipt.pilot_id !== manifest.pilot_id) {
    issues.push(`pilot_id mismatch: manifest=${manifest.pilot_id} receipt=${receipt.pilot_id}`);
  }
  if (receipt.provenance.synthetic_fixture !== manifest.provenance.synthetic_fixture) {
    issues.push("synthetic_fixture provenance does not match manifest");
  }
  if (!receipt.provenance.synthetic_fixture && receipt.evidence.recorded_by === "synthetic-fixture") {
    issues.push("synthetic-fixture evidence cannot be used as a real pilot receipt");
  }

  issues.push(...verifyArtifactRefs(projectDir, receipt.provenance.inputs, `${gate} provenance.inputs`));
  issues.push(...verifyArtifactRefs(projectDir, receipt.evidence.artifacts, `${gate} evidence.artifacts`));
  if (receipt.provenance.profile) {
    issues.push(...verifyArtifactRefs(projectDir, [receipt.provenance.profile], `${gate} provenance.profile`));
  }
  for (const manifestInput of manifest.provenance.inputs) {
    const receiptInput = receipt.provenance.inputs.find((candidate) => candidate.path === manifestInput.path);
    if (!receiptInput || receiptInput.sha256 !== manifestInput.sha256) {
      issues.push(`${gate} provenance.inputs does not match manifest provenance.inputs for ${manifestInput.path}`);
    }
  }

  const expectedFingerprint = computePrivatePilotInputFingerprint(receipt.provenance.inputs);
  if (receipt.freshness.input_fingerprint !== expectedFingerprint) {
    issues.push(`${gate} freshness input_fingerprint does not match provenance.inputs`);
  }
  if (receipt.freshness.status !== "fresh") {
    issues.push(`${gate} evidence is ${receipt.freshness.status}; fresh evidence is required`);
  }
  if (receipt.freshness.valid_until && Date.parse(receipt.freshness.valid_until) <= now.getTime()) {
    issues.push(`${gate} evidence freshness expired at ${receipt.freshness.valid_until}`);
  }

  switch (gate) {
    case "agent_qa":
      if (receipt.status !== "passed" || receipt.decision !== "pass") {
        issues.push(`agent QA must independently declare status=passed and decision=pass; got ${receipt.status}/${receipt.decision}`);
      }
      {
        const checkIds = receipt.evidence.checks?.map((check) => check.id) ?? [];
        const missingDomains = PRIVATE_PILOT_AGENT_QA_DOMAINS.filter((domain) => !checkIds.includes(domain));
        const unexpectedDomains = checkIds.filter((id) => !PRIVATE_PILOT_AGENT_QA_DOMAINS.includes(id));
        if (checkIds.length !== PRIVATE_PILOT_AGENT_QA_DOMAINS.length || new Set(checkIds).size !== checkIds.length || missingDomains.length > 0 || unexpectedDomains.length > 0) {
          issues.push(`agent QA evidence must cover exactly these domains: ${PRIVATE_PILOT_AGENT_QA_DOMAINS.join(", ")}; missing=${missingDomains.join(",") || "none"} unexpected=${unexpectedDomains.join(",") || "none"}`);
        }
      }
      if (!receipt.evidence.checks?.length || receipt.evidence.checks.some((check) => check.status !== "pass")) {
        issues.push("agent QA evidence must contain only passing deterministic checks");
      }
      break;
    case "human_visual_audio": {
      const review = receipt.evidence.human_review;
      if (receipt.status !== "approved" || receipt.decision !== "approve") {
        issues.push(`human visual/audio approval must independently declare status=approved and decision=approve; got ${receipt.status}/${receipt.decision}`);
      }
      if (!review?.reviewed || !review.visual || !review.audio || review.decision !== "approved") {
        issues.push("human visual/audio evidence must record reviewed=true, visual=true, audio=true, decision=approved");
      }
      break;
    }
    case "nle_handoff": {
      const handoff = receipt.evidence.handoff;
      if (handoff?.artifacts) {
        issues.push(...verifyArtifactRefs(projectDir, handoff.artifacts, `${gate} handoff.artifacts`));
      }
      if (receipt.requirement === "not_required") {
        if (receipt.status !== "not_required" || receipt.decision !== "not_required" || handoff?.confirmation !== "not_required" || handoff.route_kind !== "not_applicable") {
          issues.push("NLE not-required must be explicit in requirement, status, decision, confirmation, and route_kind");
        }
      } else {
        if (receipt.status !== "confirmed" || receipt.decision !== "pass") {
          issues.push(`required NLE handoff must independently declare status=confirmed and decision=pass; got ${receipt.status}/${receipt.decision}`);
        }
        if (handoff?.confirmation !== "confirmed" || !handoff?.artifacts?.length || handoff.route_kind === "not_applicable" || handoff.route_kind === "canonical_engine_render") {
          issues.push("required NLE handoff must have confirmed handoff evidence and a supplied/external route");
        }
        for (const artifact of handoff?.artifacts ?? []) {
          if (!receipt.evidence.artifacts.some((evidenceArtifact) => evidenceArtifact.path === artifact.path && evidenceArtifact.sha256 === artifact.sha256)) {
            issues.push(`required NLE handoff artifact is not identity-bound to evidence.artifacts: ${artifact.path}`);
          }
        }
        if (
          handoff
          && !hasConfirmedBoundRouteReceipt(projectDir, manifest, receipt, handoff)
        ) {
          issues.push("required NLE handoff must include a valid render-route-receipt/v3 artifact with confirmed supplied/external handoff identity bound to pilot common inputs");
        }
      }
      break;
    }
    case "platform_preview": {
      const preview = receipt.evidence.platform_preview;
      if (receipt.status !== "approved" || receipt.decision !== "approve") {
        issues.push(`platform preview must independently declare status=approved and decision=approve; got ${receipt.status}/${receipt.decision}`);
      }
      if (!preview?.current_profile || !preview.human_preview) {
        issues.push("platform preview requires a current delivery profile and human preview; safe-zone automation alone cannot pass");
      }
      if (preview) {
        if (!receipt.provenance.profile || receipt.provenance.profile.path !== preview.profile.path) {
          issues.push("platform preview provenance.profile must identify the current profile artifact");
        }
        if (receipt.provenance.profile && receipt.provenance.profile.sha256 !== preview.profile.sha256) {
          issues.push("platform preview provenance.profile must match the preview profile hash");
        }
        issues.push(...verifyArtifactRefs(projectDir, [preview.profile, preview.safe_zone_receipt], "platform preview profile/safe-zone evidence"));
        issues.push(...verifyPlatformPreviewReferences(projectDir, preview));
      }
      break;
    }
  }

  return {
    gate,
    ready: issues.length === 0,
    status: receipt.status,
    decision: receipt.decision,
    freshness: receipt.freshness.status,
    receipt_path: receiptPath,
    issues,
  };
}

function evaluateManifestInputs(projectDir: string, manifest: PrivatePilotManifest): string[] {
  return verifyArtifactRefs(projectDir, manifest.provenance.inputs, "manifest provenance.inputs");
}

export function evaluatePrivatePilot(
  projectDir: string,
  options: EvaluatePrivatePilotOptions = {},
): PrivatePilotEvaluation {
  const absProjectDir = path.resolve(projectDir);
  const requestedManifestPath = manifestPathFor(absProjectDir, options.manifestPath);
  const manifestPath = resolveContainedPath(absProjectDir, requestedManifestPath);
  if (!manifestPath) {
    return manifestResult(requestedManifestPath, `private pilot manifest escapes project root: ${requestedManifestPath}`);
  }
  if (!fs.existsSync(manifestPath)) {
    return manifestResult(manifestPath, `private pilot manifest is missing: ${manifestPath}`);
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = readJson(manifestPath);
  } catch (error) {
    return manifestResult(manifestPath, `private pilot manifest is unreadable: ${errorMessage(error)}`);
  }
  const manifestValidation = validateAgainstSchema(manifestRaw, "private-pilot-manifest.schema.json");
  if (!manifestValidation.valid) {
    return manifestResult(
      manifestPath,
      `private pilot manifest schema invalid: ${manifestValidation.errors.join("; ")}`,
    );
  }
  const manifest = manifestRaw as PrivatePilotManifest;
  const manifestSha256 = computeSha256(manifestPath);
  const gates = emptyGates("private pilot gate receipt is missing");
  const reasons = evaluateManifestInputs(absProjectDir, manifest);
  const seen = new Set<PrivatePilotGate>();
  const now = options.now ?? new Date();

  for (const receiptRef of manifest.receipts) {
    if (seen.has(receiptRef.gate)) {
      reasons.push(`duplicate private pilot receipt for gate ${receiptRef.gate}`);
      continue;
    }
    seen.add(receiptRef.gate);
    const receiptPath = receiptRefPath(absProjectDir, receiptRef);
    if (!receiptPath) {
      gates[receiptRef.gate] = emptyGateEvaluation(receiptRef.gate, `receipt escapes project root: ${receiptRef.path}`);
      reasons.push(`${receiptRef.gate}: receipt escapes project root`);
      continue;
    }
    if (!fs.existsSync(receiptPath)) {
      gates[receiptRef.gate] = emptyGateEvaluation(receiptRef.gate, `receipt is missing: ${receiptRef.path}`);
      reasons.push(`${receiptRef.gate}: receipt is missing`);
      continue;
    }
    let actualReceiptHash: string;
    try {
      actualReceiptHash = computeSha256(receiptPath);
    } catch (error) {
      const issue = `receipt is unreadable: ${errorMessage(error)}`;
      gates[receiptRef.gate] = {
        ...emptyGateEvaluation(receiptRef.gate, issue),
        receipt_path: receiptPath,
      };
      reasons.push(`${receiptRef.gate}: ${issue}`);
      continue;
    }
    if (actualReceiptHash !== receiptRef.sha256) {
      const issue = `receipt hash mismatch: declared=${receiptRef.sha256} actual=${actualReceiptHash}`;
      gates[receiptRef.gate] = {
        ...emptyGateEvaluation(receiptRef.gate, issue),
        receipt_path: receiptPath,
      };
      reasons.push(`${receiptRef.gate}: ${issue}`);
      continue;
    }

    let receiptRaw: unknown;
    try {
      receiptRaw = readJson(receiptPath);
    } catch (error) {
      const issue = `receipt is unreadable: ${errorMessage(error)}`;
      gates[receiptRef.gate] = {
        ...emptyGateEvaluation(receiptRef.gate, issue),
        receipt_path: receiptPath,
      };
      reasons.push(`${receiptRef.gate}: ${issue}`);
      continue;
    }
    const receiptValidation = validateAgainstSchema(receiptRaw, "private-pilot-gate-receipt.schema.json");
    if (!receiptValidation.valid || !isRecord(receiptRaw)) {
      const issue = `receipt schema invalid: ${receiptValidation.errors.join("; ")}`;
      gates[receiptRef.gate] = {
        ...emptyGateEvaluation(receiptRef.gate, issue),
        receipt_path: receiptPath,
      };
      reasons.push(`${receiptRef.gate}: ${issue}`);
      continue;
    }
    const receipt = receiptRaw as unknown as PrivatePilotGateReceipt;
    if (receipt.gate !== receiptRef.gate) {
      const issue = `receipt gate mismatch: manifest=${receiptRef.gate} receipt=${receipt.gate}`;
      gates[receiptRef.gate] = {
        ...emptyGateEvaluation(receiptRef.gate, issue),
        receipt_path: receiptPath,
      };
      reasons.push(`${receiptRef.gate}: ${issue}`);
      continue;
    }
    const evaluation = evaluateReceipt(absProjectDir, manifest, receipt, receiptPath, now);
    gates[receiptRef.gate] = evaluation;
    reasons.push(...evaluation.issues.map((issue) => `${receiptRef.gate}: ${issue}`));
  }

  for (const gate of PRIVATE_PILOT_GATES) {
    if (!seen.has(gate)) reasons.push(`${gate}: receipt is missing from manifest`);
  }

  const ready = PRIVATE_PILOT_GATES.every((gate) => gates[gate].ready) && reasons.length === 0;
  return {
    version: "private-pilot-evaluation/v1",
    ready,
    decision: ready ? "ready" : "hold",
    project_id: manifest.project_id,
    pilot_id: manifest.pilot_id,
    synthetic_fixture: manifest.provenance.synthetic_fixture,
    manifest_path: manifestPath,
    manifest_sha256: manifestSha256,
    gates,
    reasons,
    public_promotion: "out_of_scope",
  };
}

export function assertPrivatePilotReady(
  projectDir: string,
  options: EvaluatePrivatePilotOptions = {},
): PrivatePilotEvaluation & { ready: true; decision: "ready" } {
  const evaluation = evaluatePrivatePilot(projectDir, options);
  if (!evaluation.ready) {
    throw new Error(`private pilot is on HOLD: ${evaluation.reasons.join("; ")}`);
  }
  return evaluation as PrivatePilotEvaluation & { ready: true; decision: "ready" };
}
