import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseJsonRejectDuplicateKeys, validateAgainstSchema } from "../commands/shared.js";
import { computeSha256 } from "./manifest.js";
import { FINAL_RENDER_APPROVAL_RELATIVE_PATH } from "./final-render-approval.js";
import {
  generationIdFromKey,
  generationKeyFromInputs,
  recomputeCurrentGenerationKeyInputs,
  type CanonicalLyricOptions,
} from "../caption/generation-identity.js";

export const ACTIVE_DELIVERY_RELATIVE_PATH = "07_package/active_delivery.json";
export const CAPTION_FINALIZE_ROOT_RELATIVE_PATH = "07_package/caption-finalize";

export interface ActiveDeliveryArtifact {
  path: string;
  sha256: string;
  size_bytes?: number;
  mtime_ms?: number;
}

export interface ActiveDelivery {
  version: "active-delivery/v1";
  project_id: string;
  generation_id: string;
  generation_path: string;
  activated_at: string;
  approval_intent: ActiveDeliveryArtifact;
  inputs: {
    approval_sha256: string;
    timeline_sha256: string;
    final_render_approval_sha256?: string;
    generation_key: string;
  };
  artifacts: {
    caption_ass: ActiveDeliveryArtifact;
    caption_srt: ActiveDeliveryArtifact;
    final_video: ActiveDeliveryArtifact;
    qa_report: ActiveDeliveryArtifact;
    package_manifest: ActiveDeliveryArtifact;
    preview: ActiveDeliveryArtifact;
    preview_receipt: ActiveDeliveryArtifact;
    receipt: ActiveDeliveryArtifact;
  /** Lyric telop delivery (Issue 36): present in lyric generations. */
    lyrics_ass?: ActiveDeliveryArtifact;
    lyric_plan?: ActiveDeliveryArtifact;
    lyric_script?: ActiveDeliveryArtifact;
  };
  /**
   * Explicit lyric mode shared with caption-finalize-receipt/v5: "present"
   * mutually requires the lyric contract and all three artifacts; "absent"
   * forbids all of them.
   */
  lyric_delivery: "present" | "absent";
  /** Lyric contract mirrored from the receipt when lyric_delivery=present. */
  lyric_contract?: {
    source_kind?: "lrc_script" | "authored_caption_approval";
    canonical_options?: CanonicalLyricOptions;
    faces: Array<{ role: string; family: string; postscript_name: string; face_index: number; font_path: string; font_sha256: string }>;
    script_sha256?: string;
    options_digest?: string;
    authority?: {
      kind: "authored_caption_approval";
      approval_sha256: string;
      timeline_sha256: string;
      text_authority_sha256: string;
      timing_authority_sha256: string;
    };
  };
}

export interface DeliveryArtifactPaths {
  source: "active_delivery" | "legacy" | "fresh_staged";
  activeDelivery?: ActiveDelivery;
  captionApprovalPath: string;
  captionAssPath: string;
  captionSrtPath: string;
  finalVideoPath: string;
  qaReportPath: string;
  packageManifestPath: string;
  previewPath: string;
  previewReceiptPath?: string;
  receiptPath?: string;
  /** Lyric ASS from the active generation (undefined for speech-only). */
  lyricsAssPath?: string;
  finalMixPath: string;
  packageFinalVideoPath: string;
  /** Verified generation-local font dir (fresh staged generations). */
  captionFontsDir?: string;
  /** Canonical typography policy (fresh staged generations derive it). */
  typographyPolicyPath?: string;
  /** Canonical visual-treatment patch (fresh staged generations derive it). */
  visualTreatmentPatchPath?: string;
  /** Bound OUTPUT render-route receipt (fresh staged generations). */
  renderRouteReceiptPath?: string;
  /** Staged supplied final (fresh supplied-final generations). */
  suppliedFinalPath?: string;
  /** Bound INPUT caption-finalize receipt (fresh supplied-final generations). */
  suppliedFinalReceiptPath?: string;
}

export interface ResolveActiveDeliveryOptions {
  verifyHashes?: boolean;
}

export class InvalidActiveDeliveryPointerError extends Error {
  readonly code = "INVALID_ACTIVE_DELIVERY_POINTER" as const;

  constructor(pointerPath: string) {
    super(`active delivery pointer is present but invalid: ${pointerPath}`);
    this.name = "InvalidActiveDeliveryPointerError";
  }
}

export function activeDeliveryPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), ACTIVE_DELIVERY_RELATIVE_PATH);
}

function resolveDeliveryArtifactPaths(
  projectDir: string,
  options: ResolveActiveDeliveryOptions = {},
): DeliveryArtifactPaths {
  const absProject = path.resolve(projectDir);
  const active = readActiveDelivery(absProject, options);
  if (active) {
    const generationDir = resolveProjectRelativePath(absProject, active.generation_path);
    return {
      source: "active_delivery",
      activeDelivery: active,
      captionApprovalPath: resolveIntentPath(absProject, active.approval_intent),
      captionAssPath: resolveArtifactPath(absProject, generationDir, active.artifacts.caption_ass),
      captionSrtPath: resolveArtifactPath(absProject, generationDir, active.artifacts.caption_srt),
      finalVideoPath: resolveArtifactPath(absProject, generationDir, active.artifacts.final_video),
      qaReportPath: resolveArtifactPath(absProject, generationDir, active.artifacts.qa_report),
      packageManifestPath: resolveArtifactPath(absProject, generationDir, active.artifacts.package_manifest),
      previewPath: resolveArtifactPath(absProject, generationDir, active.artifacts.preview),
      previewReceiptPath: resolveArtifactPath(absProject, generationDir, active.artifacts.preview_receipt),
      receiptPath: resolveArtifactPath(absProject, generationDir, active.artifacts.receipt),
      lyricsAssPath: active.artifacts.lyrics_ass
        ? resolveArtifactPath(absProject, generationDir, active.artifacts.lyrics_ass)
        : undefined,
      finalMixPath: path.join(generationDir, "audio", "final_mix.wav"),
      packageFinalVideoPath: path.join(generationDir, "video", "final.mp4"),
    };
  }

  return legacyDeliveryPaths(absProject);
}

function legacyDeliveryPaths(absProject: string): DeliveryArtifactPaths {
  return {
    source: "legacy",
    captionApprovalPath: path.join(absProject, "07_package", "caption_approval.json"),
    captionAssPath: path.join(absProject, "07_package", "captions", "speech.ass"),
    captionSrtPath: path.join(absProject, "07_package", "captions", "speech.approved.srt"),
    finalVideoPath: path.join(absProject, "09_output", "final.mp4"),
    qaReportPath: path.join(absProject, "07_package", "qa-report.json"),
    packageManifestPath: path.join(absProject, "07_package", "package_manifest.json"),
    previewPath: path.join(absProject, "09_output", "final.mp4"),
    finalMixPath: path.join(absProject, "07_package", "audio", "final_mix.wav"),
    packageFinalVideoPath: path.join(absProject, "07_package", "video", "final.mp4"),
  };
}

function readActiveDelivery(
  projectDir: string,
  options: ResolveActiveDeliveryOptions = {},
): ActiveDelivery | null {
  const absProject = path.resolve(projectDir);
  const pointerPath = activeDeliveryPath(absProject);
  if (!fs.existsSync(pointerPath)) return null;

  let value: unknown;
  try {
    value = parseJsonRejectDuplicateKeys(fs.readFileSync(pointerPath, "utf8"), pointerPath);
  } catch {
    return null;
  }
  const validation = validateAgainstSchema(value, "active-delivery.schema.json");
  if (!validation.valid) return null;

  const active = value as ActiveDelivery;
  let generationDir: string;
  try {
    generationDir = resolveProjectRelativePath(absProject, active.generation_path);
    const expectedRoot = path.join(absProject, CAPTION_FINALIZE_ROOT_RELATIVE_PATH, "generations");
    assertContained(expectedRoot, generationDir);
    assertRealpathContained(expectedRoot, generationDir);
    const artifacts = [
      active.artifacts.caption_ass,
      active.artifacts.caption_srt,
      active.artifacts.final_video,
      active.artifacts.qa_report,
      active.artifacts.package_manifest,
      active.artifacts.preview,
      active.artifacts.preview_receipt,
      active.artifacts.receipt,
      ...(active.artifacts.lyrics_ass ? [active.artifacts.lyrics_ass] : []),
      ...(active.artifacts.lyric_plan ? [active.artifacts.lyric_plan] : []),
      ...(active.artifacts.lyric_script ? [active.artifacts.lyric_script] : []),
    ];
    for (const artifact of artifacts) {
      const artifactPath = resolveArtifactPath(absProject, generationDir, artifact);
      if (!fs.existsSync(artifactPath)) return null;
      if (options.verifyHashes && computeSha256(artifactPath) !== artifact.sha256) return null;
    }
    const intentPath = resolveIntentPath(absProject, active.approval_intent);
    if (!fs.existsSync(intentPath)) return null;
    if (options.verifyHashes && computeSha256(intentPath) !== active.approval_intent.sha256) return null;
  } catch {
    return null;
  }
  return active;
}

/**
 * UNCONDITIONAL runtime mirror of the lyric_delivery discriminator (applied
 * to pointers AND receipts before any path resolution): "present" requires
 * the lyric contract and the plan/ASS artifacts; direct LRC delivery also
 * requires its script copy, while authored delivery deliberately has no
 * second source file. "absent" forbids all lyric artifacts.
 */
function validateLyricDeliveryMode(
  doc: { lyric_delivery?: unknown; lyric_contract?: unknown; artifacts?: Record<string, unknown>; generation_key?: unknown },
  location: string,
): void {
  const isReceipt = doc.generation_key !== undefined;
  const lyricArtifacts = ["lyrics_ass", "lyric_plan", "lyric_script"] as const;
  const presentArtifacts = lyricArtifacts.filter((key) => doc.artifacts?.[key]);
  const sourceKind = (doc.lyric_contract as { source_kind?: unknown } | undefined)?.source_kind;
  const mode = doc.lyric_delivery;
  const fail = (message: string): never => {
    throw new InvalidActiveDeliveryPointerError(`${location}: ${message}`);
  };
  if (mode === "present") {
    // the contract is a receipt-level requirement; pointers bind the artifacts
    if (isReceipt && !doc.lyric_contract) {
      fail("lyric_delivery=present requires lyric_contract");
    }
    const requiredArtifacts = sourceKind === "authored_caption_approval"
      ? (["lyrics_ass", "lyric_plan"] as const)
      : lyricArtifacts;
    for (const key of requiredArtifacts) {
      if (!doc.artifacts?.[key]) {
        fail(`lyric_delivery=present requires the ${key} artifact`);
      }
    }
    if (sourceKind === "authored_caption_approval" && doc.artifacts?.lyric_script) {
      fail("authored lyric delivery forbids a duplicate lyric script artifact");
    }
  } else if (mode === "absent") {
    if (doc.lyric_contract !== undefined) {
      fail("lyric_delivery=absent forbids lyric_contract");
    }
    if (presentArtifacts.length > 0) {
      fail(`lyric_delivery=absent forbids lyric artifacts (${presentArtifacts.join(", ")})`);
    }
  } else {
    fail('lyric_delivery must be "present" or "absent"');
  }
}

/**
 * STRICT delivery resolution for burn/packaging decisions: a present-but-
 * corrupt, tampered, or incomplete pointer FAILS CLOSED instead of silently
 * falling back to the legacy layout. Returns null only when no pointer file
 * exists at all.
 */
export function readActiveDeliveryStrict(
  projectDir: string,
): ActiveDelivery | null {
  const absProject = path.resolve(projectDir);
  const pointerPath = activeDeliveryPath(absProject);
  if (!fs.existsSync(pointerPath)) return null;
  // Discriminator FIRST: parse the pointer and validate its mode BEFORE
  // resolving, reading, statting, or hashing ANY artifact path. A self-
  // rehashed inverted pointer fails with zero path/file side effects.
  let rawPointer: { lyric_delivery?: unknown; lyric_contract?: unknown; artifacts?: Record<string, unknown> };
  try {
    rawPointer = parseJsonRejectDuplicateKeys(
      fs.readFileSync(pointerPath, "utf8"),
      pointerPath,
    );
  } catch {
    throw new InvalidActiveDeliveryPointerError(pointerPath);
  }
  validateLyricDeliveryMode(rawPointer, pointerPath);
  // identity binding is DERIVED from canonical project files, never accepted
  // from callers
  const anchors = deriveDeliveryIdentityAnchors(absProject);
  const active = readActiveDelivery(absProject, { verifyHashes: true });
  if (!active) {
    throw new InvalidActiveDeliveryPointerError(pointerPath);
  }
  // bind to the current project identity
  if (active.project_id !== anchors.expectedProjectId) {
    throw new InvalidActiveDeliveryPointerError(pointerPath);
  }
  // bind to the current timeline state: a stale pointer cannot be served
  if (fs.existsSync(anchors.timelinePath)) {
    if (active.inputs.timeline_sha256 !== computeSha256(anchors.timelinePath)) {
      throw new InvalidActiveDeliveryPointerError(pointerPath);
    }
  }
  // the referenced receipt must be schema-valid, CURRENT (v5: v1-v4 legacy
  // receipts never open packaging/render/delivery), and internally consistent
  const generationDir = resolveProjectRelativePath(absProject, active.generation_path);
  const receiptPath = resolveArtifactPath(absProject, generationDir, active.artifacts.receipt);
  let receipt: ReceiptShape;
  try {
    receipt = parseJsonRejectDuplicateKeys(fs.readFileSync(receiptPath, "utf8"), receiptPath);
  } catch {
    throw new InvalidActiveDeliveryPointerError(pointerPath);
  }
  const receiptValidation = validateAgainstSchema(receipt, "caption-finalize-receipt.schema.json");
  if (!receiptValidation.valid) {
    throw new InvalidActiveDeliveryPointerError(pointerPath);
  }
  if (receipt.version !== "caption-finalize-receipt/v5") {
    throw new InvalidActiveDeliveryPointerError(`${pointerPath}: legacy receipt ${String(receipt.version)} cannot open delivery`);
  }
  const canonicalApprovalSha256 = computeSha256(anchors.approvalPath);
  if (active.approval_intent.sha256 !== canonicalApprovalSha256) {
    throw new InvalidActiveDeliveryPointerError(`${pointerPath}: approval does not match the current canonical approval`);
  }
  if (receipt.lyric_delivery !== active.lyric_delivery
    || receipt.generation_id !== active.generation_id
    || receipt.generation_key !== active.inputs.generation_key
    || receipt.project_id !== anchors.expectedProjectId
    || receipt.approval_sha256 !== active.inputs.approval_sha256
    || receipt.timeline_sha256 !== active.inputs.timeline_sha256
    || receipt.final_render_approval_sha256 !== active.inputs.final_render_approval_sha256) {
    throw new InvalidActiveDeliveryPointerError(pointerPath);
  }
  // Full identity recomputation is also enforced by this lower-level public
  // reader. Callers must not be able to use readActiveDeliveryStrict or the
  // lyric-only resolver as a weaker path around resolveDeliveryArtifactPathsStrict.
  if (!receipt.generation_key_inputs) {
    throw new InvalidActiveDeliveryPointerError(`${pointerPath}: v5 receipt lacks generation_key_inputs`);
  }
  const { inputs: recomputedInputs, routeEvidence: recomputedRoute } = recomputeCurrentGenerationKeyInputs({
    projectDir: absProject,
    generationDir,
    anchors,
    expectedProjectId: anchors.expectedProjectId,
    lyricDeliveryMode: active.lyric_delivery,
    lyricContract: receipt.lyric_contract,
    persistedInputs: receipt.generation_key_inputs,
  });
  const expectedKey = generationKeyFromInputs(recomputedInputs);
  if (expectedKey !== receipt.generation_key
    || expectedKey !== active.inputs.generation_key
    || generationIdFromKey(expectedKey) !== receipt.generation_id
    || path.basename(generationDir) !== receipt.generation_id
    || receipt.approval_sha256 !== recomputedInputs.approval
    || receipt.timeline_sha256 !== recomputedInputs.timeline
    || receipt.final_render_approval_sha256 !== recomputedInputs.final_render_approval
    || active.inputs.approval_sha256 !== recomputedInputs.approval
    || active.inputs.timeline_sha256 !== recomputedInputs.timeline
    || active.inputs.final_render_approval_sha256 !== recomputedInputs.final_render_approval
    || receipt.route_evidence?.route_kind !== recomputedRoute.route_kind
    || receipt.route_evidence?.render_route_receipt_sha256 !== recomputedRoute.render_route_receipt_sha256) {
    throw new InvalidActiveDeliveryPointerError(`${pointerPath}: recomputed identity or route evidence mismatch`);
  }
  // lyric contract mirror: canonical-JSON-normalized deep equality between
  // the pointer contract and the receipt contract (insertion-order agnostic)
  if (active.lyric_delivery === "present") {
    if (!active.lyric_contract || !receipt.lyric_contract) {
      throw new InvalidActiveDeliveryPointerError(pointerPath);
    }
    if (canonicalJson(active.lyric_contract) !== canonicalJson(receipt.lyric_contract)) {
      throw new InvalidActiveDeliveryPointerError(`${pointerPath}: lyric contract mirror mismatch`);
    }
    // The active pointer is mutable delivery metadata. Its lyric ASS hash is
    // accepted only when it agrees with the receipt artifact record, the
    // current bytes, and the plan/source binding.
    verifyLyricArtifactsBinding(absProject, generationDir, active, receipt);
  }
  return active;
}

/** Deterministic JSON: sorted keys, so equal objects compare equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Lyric ASS path for the burn chain, with strict hash verification: a
 * corrupted active generation aborts the caller rather than burning stale
 * or mismatched lyric telops.
 */
export function resolveLyricsAssPathStrict(projectDir: string): string | undefined {
  const active = readActiveDeliveryStrict(projectDir);
  if (!active?.artifacts.lyrics_ass) return undefined;
  const absProject = path.resolve(projectDir);
  const generationDir = resolveProjectRelativePath(absProject, active.generation_path);
  return resolveArtifactPath(absProject, generationDir, active.artifacts.lyrics_ass);
}

function resolveIntentPath(projectDir: string, artifact: ActiveDeliveryArtifact): string {
  const resolved = resolveProjectRelativePath(projectDir, artifact.path);
  const intentRoot = path.join(projectDir, CAPTION_FINALIZE_ROOT_RELATIVE_PATH, "intents");
  assertContained(intentRoot, resolved);
  assertRealpathContained(intentRoot, resolved);
  return resolved;
}

function resolveArtifactPath(
  projectDir: string,
  generationDir: string,
  artifact: ActiveDeliveryArtifact,
): string {
  const resolved = resolveProjectRelativePath(projectDir, artifact.path);
  assertContained(generationDir, resolved);
  assertRealpathContained(generationDir, resolved);
  return resolved;
}

function resolveProjectRelativePath(projectDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("active delivery paths must be relative");
  const resolved = path.resolve(projectDir, relativePath);
  assertContained(projectDir, resolved);
  assertRealpathContained(projectDir, resolved);
  return resolved;
}

function assertRealpathContained(parent: string, candidate: string): void {
  if (!fs.existsSync(parent) || !fs.existsSync(candidate)) return;
  const parentReal = fs.realpathSync(parent);
  const candidateReal = fs.realpathSync(candidate);
  assertContained(parentReal, candidateReal);
}

function assertContained(parent: string, candidate: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`path escapes active delivery root: ${candidate}`);
}


// ── Shared strict delivery authority (package/render boundaries) ─────────

export interface DeliveryIdentityAnchors {
  expectedProjectId: string;
  timelinePath: string;
  approvalPath: string;
  finalRenderApprovalPath: string;
}

/**
 * Derive the CURRENT identity anchors from canonical project files. Strict
 * consumers must not accept caller-supplied identity strings: the expected
 * project id, timeline hash, approval hash, and final-render-approval hash
 * always come from the project itself.
 */
export function deriveDeliveryIdentityAnchors(projectDir: string): DeliveryIdentityAnchors {
  const absDir = path.resolve(projectDir);
  const statePath = path.join(absDir, "project_state.yaml");
  if (!fs.existsSync(statePath)) {
    throw new InvalidActiveDeliveryPointerError(statePath);
  }
  let projectId: unknown;
  try {
    projectId = (parseYaml(fs.readFileSync(statePath, "utf8")) as { project_id?: unknown })?.project_id;
  } catch {
    throw new InvalidActiveDeliveryPointerError(statePath);
  }
  if (typeof projectId !== "string" || !projectId) {
    throw new InvalidActiveDeliveryPointerError(statePath);
  }
  return {
    expectedProjectId: projectId,
    timelinePath: path.join(absDir, "05_timeline", "timeline.json"),
    approvalPath: path.join(absDir, "07_package", "caption_approval.json"),
    finalRenderApprovalPath: path.join(absDir, FINAL_RENDER_APPROVAL_RELATIVE_PATH),
  };
}

/** SHA-256 of canonical JSON — identical to caption-finalize's key builder. */
function generationKeyDigest(inputs: Record<string, string>): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(inputs)).digest("hex")}`;
}

/** Re-verify the lyric binding (plan ⇔ contract ⇔ staged font copies). */
function verifyLyricContractBinding(
  generationDir: string,
  contract: {
    source_kind?: "lrc_script" | "authored_caption_approval";
    faces: Array<{ role: string; family: string; postscript_name: string; face_index: number; font_path: string; font_sha256: string }>;
    authority?: {
      kind: "authored_caption_approval";
      approval_sha256: string;
      timeline_sha256: string;
      text_authority_sha256: string;
      timing_authority_sha256: string;
    };
  },
): void {
  const planPath = path.join(generationDir, "captions", "lyric-typography-plan.json");
  const plan = parseJsonRejectDuplicateKeys<{
    fonts: Record<string, { font_path?: string; face_index?: number; postscript_name?: string; font_sha256?: string }>;
    authority?: unknown;
  }>(fs.readFileSync(planPath, "utf8"), planPath);
  if (contract.source_kind === "authored_caption_approval"
    && canonicalJson(plan.authority) !== canonicalJson(contract.authority)) {
    throw new InvalidActiveDeliveryPointerError(planPath);
  }
  if (contract.source_kind !== "authored_caption_approval" && plan.authority !== undefined) {
    throw new InvalidActiveDeliveryPointerError(planPath);
  }
  const fontsDir = path.join(generationDir, "fonts");
  for (const face of contract.faces) {
    const planFont = plan.fonts[face.role];
    if (!planFont
      || planFont.font_path !== face.font_path
      || planFont.face_index !== face.face_index
      || (planFont.postscript_name ?? "") !== face.postscript_name
      || planFont.font_sha256 !== face.font_sha256) {
      throw new InvalidActiveDeliveryPointerError(planPath);
    }
    if (!face.font_path) continue;
    const candidates = fs.readdirSync(fontsDir).filter((name) => name.startsWith(`lyrics-${face.role}.`));
    if (candidates.length !== 1) {
      throw new InvalidActiveDeliveryPointerError(fontsDir);
    }
    if (computeSha256(path.join(fontsDir, candidates[0])) !== face.font_sha256) {
      throw new InvalidActiveDeliveryPointerError(fontsDir);
    }
  }
}

/**
 * Cross-check the mutable active pointer against the caption-finalize receipt
 * and its generation-local plan/source identity. A pointer-side self-rehash
 * must never authorize changed burn-ready lyric bytes.
 */
function verifyLyricArtifactsBinding(
  projectDir: string,
  generationDir: string,
  active: ActiveDelivery,
  receipt: ReceiptShape,
): void {
  const pointerPath = activeDeliveryPath(projectDir);
  const fail = (message: string): never => {
    throw new InvalidActiveDeliveryPointerError(`${pointerPath}: ${message}`);
  };
  const receiptArtifact = (value: unknown, label: string): ActiveDeliveryArtifact => {
    if (!value || typeof value !== "object") fail(`receipt is missing ${label}`);
    const candidate = value as { path?: unknown; sha256?: unknown };
    if (typeof candidate.path !== "string" || typeof candidate.sha256 !== "string") {
      fail(`receipt ${label} artifact is malformed`);
    }
    return value as ActiveDeliveryArtifact;
  };
  const mirrorAndHash = (
    pointerArtifact: ActiveDeliveryArtifact | undefined,
    receiptValue: unknown,
    label: string,
  ): string => {
    const pointerEntry = pointerArtifact ?? fail(`active pointer is missing ${label}`);
    const receiptEntry = receiptArtifact(receiptValue, label);
    if (pointerEntry.path !== receiptEntry.path || pointerEntry.sha256 !== receiptEntry.sha256) {
      fail(`${label} pointer/receipt binding mismatch`);
    }
    const resolved = resolveArtifactPath(projectDir, generationDir, pointerEntry);
    if (computeSha256(resolved) !== receiptEntry.sha256) {
      fail(`${label} bytes do not match the caption-finalize receipt hash`);
    }
    return resolved;
  };

  const receiptArtifacts = receipt.artifacts ?? fail("receipt is missing artifacts");
  mirrorAndHash(active.artifacts.lyrics_ass, receiptArtifacts.lyrics_ass, "lyrics.ass");
  mirrorAndHash(active.artifacts.lyric_plan, receiptArtifacts.lyric_plan, "lyric plan");
  if (receipt.lyric_contract?.source_kind === "authored_caption_approval") {
    if (active.artifacts.lyric_script || receiptArtifacts.lyric_script) {
      fail("authored lyric delivery carries a duplicate lyric script");
    }
  } else {
    const scriptPath = mirrorAndHash(active.artifacts.lyric_script, receiptArtifacts.lyric_script, "lyric script");
    const scriptArtifact = receiptArtifact(receiptArtifacts.lyric_script, "lyric script");
    if (receipt.lyric_contract?.script_sha256 !== scriptArtifact.sha256
      || computeSha256(scriptPath) !== receipt.lyric_contract?.script_sha256) {
      fail("lyric script source identity does not match the receipt contract");
    }
  }
  const lyricContract = receipt.lyric_contract ?? fail("receipt is missing the lyric contract");
  // This also binds authored authority (or rejects an unexpected authority on
  // the direct LRC route) and verifies the exact staged face copies.
  verifyLyricContractBinding(generationDir, lyricContract);
}

interface ReceiptShape {
  version?: string;
  generation_id?: string;
  project_id?: string;
  generation_key_inputs?: Record<string, string>;
  generation_key?: string;
  lyric_delivery?: "present" | "absent";
  artifacts?: Record<string, unknown>;
  lyric_contract?: {
    script_sha256?: string;
    canonical_options?: CanonicalLyricOptions;
    options_digest?: string;
    source_kind?: "lrc_script" | "authored_caption_approval";
    faces: Array<{ role: string; family: string; postscript_name: string; face_index: number; font_path: string; font_sha256: string }>;
    authority?: {
      kind: "authored_caption_approval";
      approval_sha256: string;
      timeline_sha256: string;
      text_authority_sha256: string;
      timing_authority_sha256: string;
    };
  };
  caption_visual_treatment?: { resolved_input_hash?: string };
  approval_sha256?: string;
  final_render_approval_sha256?: string;
  timeline_sha256?: string;
  route_evidence?: {
    route_kind?: string;
    render_route_receipt_sha256?: string;
  };
}

/**
 * THE strict delivery authority for package and render boundaries. When no
 * pointer file exists, legacy 07_package paths are returned. When a pointer
 * exists it MUST pass: artifact hash verification, binding to the CURRENT
 * project_id / timeline hash / approval hash / final-render-approval hash
 * derived from canonical files, a schema-valid internally consistent
 * caption receipt, a recomputed generation key (anchored fields
 * substituted with current hashes), and — for lyric deliveries — the
 * plan ⇔ contract ⇔ staged-font binding. Any failure throws.
 */
export function resolveDeliveryArtifactPathsStrict(
  projectDir: string,
): DeliveryArtifactPaths {
  const absProject = path.resolve(projectDir);
  const pointerPath = activeDeliveryPath(absProject);
  if (!fs.existsSync(pointerPath)) {
    // no pointer: legacy layout, nothing to bind
    return legacyDeliveryPaths(absProject);
  }
  let anchors: DeliveryIdentityAnchors;
  let active: ActiveDelivery;
  try {
    anchors = deriveDeliveryIdentityAnchors(absProject);
    active = readActiveDeliveryStrict(absProject)!;
    if (!active) throw new Error("unreachable");
  } catch (error) {
    if (error instanceof InvalidActiveDeliveryPointerError) throw error;
    throw new InvalidActiveDeliveryPointerError(`${pointerPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!active) throw new InvalidActiveDeliveryPointerError(pointerPath);
  const generationDir = resolveProjectRelativePath(absProject, active.generation_path);
  let receipt: ReceiptShape;
  try {
    const receiptPath = resolveArtifactPath(absProject, generationDir, active.artifacts.receipt);
    receipt = parseJsonRejectDuplicateKeys<ReceiptShape>(
      fs.readFileSync(receiptPath, "utf8"),
      receiptPath,
    );

    // unconditional discriminator mirror on the receipt as well
    validateLyricDeliveryMode(receipt, receiptPath);

    // FULL identity recomputation: the complete expected generation_key_inputs
    // and key are rebuilt from CURRENT canonical project files (timeline bytes,
    // lyric input bytes, staged font binaries, music cues, source-input
    // attestation, approval/final approval). Persisted inputs are comparison
    // evidence only. An arbitrary, forged, or self-rehashed key cannot pass.
    if (receipt.version === "caption-finalize-receipt/v5") {
      if (!receipt.generation_key_inputs) throw new Error("v5 receipt lacks generation_key_inputs");
      const { inputs: recomputed } = recomputeCurrentGenerationKeyInputs({
        projectDir: absProject,
        generationDir,
        anchors,
        expectedProjectId: anchors.expectedProjectId,
        lyricDeliveryMode: receipt.lyric_delivery === "present" ? "present" : "absent",
        lyricContract: receipt.lyric_contract,
        persistedInputs: receipt.generation_key_inputs,
      });
      const expectedKey = generationKeyFromInputs(recomputed);
      const expectedGenerationId = generationIdFromKey(expectedKey);
      if (expectedKey !== receipt.generation_key || expectedKey !== active.inputs.generation_key) {
        throw new Error("recomputed generation key does not match the recorded key");
      }
      // the generation directory/id must be the canonical key-derived identifier
      if (active.generation_id !== expectedGenerationId || path.basename(generationDir) !== expectedGenerationId) {
        throw new Error("generation directory does not match the key-derived identifier");
      }
    }

    // lyric deliveries re-verify their exact-face binding at every strict read
    if (receipt.lyric_delivery === "present" && receipt.lyric_contract) {
      verifyLyricContractBinding(generationDir, receipt.lyric_contract);
    }
  } catch (error) {
    if (error instanceof InvalidActiveDeliveryPointerError) throw error;
    throw new InvalidActiveDeliveryPointerError(`${pointerPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    source: "active_delivery",
    activeDelivery: active,
    captionApprovalPath: resolveIntentPath(absProject, active.approval_intent),
    captionAssPath: resolveArtifactPath(absProject, generationDir, active.artifacts.caption_ass),
    captionSrtPath: resolveArtifactPath(absProject, generationDir, active.artifacts.caption_srt),
    finalVideoPath: resolveArtifactPath(absProject, generationDir, active.artifacts.final_video),
    qaReportPath: resolveArtifactPath(absProject, generationDir, active.artifacts.qa_report),
    packageManifestPath: resolveArtifactPath(absProject, generationDir, active.artifacts.package_manifest),
    previewPath: resolveArtifactPath(absProject, generationDir, active.artifacts.preview),
    previewReceiptPath: resolveArtifactPath(absProject, generationDir, active.artifacts.preview_receipt),
    receiptPath: resolveArtifactPath(absProject, generationDir, active.artifacts.receipt),
    lyricsAssPath: active.artifacts.lyrics_ass
      ? resolveArtifactPath(absProject, generationDir, active.artifacts.lyrics_ass)
      : undefined,
    packageFinalVideoPath: path.join(generationDir, "video", "final.mp4"),
    finalMixPath: path.join(generationDir, "audio", "final_mix.wav"),
  };
}
