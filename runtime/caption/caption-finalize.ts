import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { materializeFileSync } from "../filesystem/materialize-file.js";
import { computeVideoStreamHash } from "../media/video-stream-hash.js";
import type { CaptionApproval } from "./approval.js";
import { writeApprovedCaptionDeliveryArtifacts } from "./delivery-artifacts.js";
import {
  loadApprovedAuthoredLyricLineInputs,
  writeApprovedAuthoredLyricTypographyDeliveryArtifacts,
  writeLyricTypographyDeliveryArtifacts,
  type ApprovedAuthoredLyricLineInputs,
  type LyricDeliveryOptions,
} from "./lyric-delivery.js";
import { readAuthoredCaptionIdentity } from "./authored-lyrics.js";
import { resolveLyricFontBindings, type LyricTypographyAuthority } from "./lyric-typography.js";
import {
  buildGenerationKeyInputs,
  recomputeCurrentGenerationKeyInputs,
  recomputeRouteEvidence,
  buildLyricRequestArtifact,
  CAPTION_FINALIZE_CONTRACT_VERSION,
  canonicalLyricFaceIdentity,
  canonicalLyricOptionsDigest,
  computeGenerationKey,
  generationIdFromKey,
  generationKeyFromInputs,
  LYRIC_REQUEST_RELATIVE_PATH,
  LYRIC_SCRIPT_RELATIVE_PATH,
  type CanonicalLyricOptions,
  type CaptionGenerationKeyInputs,
  type LyricRequestArtifact,
} from "./generation-identity.js";

export {
  buildGenerationKeyInputs,
  CAPTION_FINALIZE_CONTRACT_VERSION,
  computeGenerationKey,
  generationKeyFromInputs,
};
export type { CaptionGenerationKeyInputs, LyricRequestArtifact };
import {
  packageCaptionFinalizeGeneration,
  type PackageCommandOptions,
} from "../commands/package.js";
import { parseJsonRejectDuplicateKeys, validateAgainstSchema } from "../commands/shared.js";
import {
  ACTIVE_DELIVERY_RELATIVE_PATH,
  CAPTION_FINALIZE_ROOT_RELATIVE_PATH,
  activeDeliveryPath,
  deriveDeliveryIdentityAnchors,
  readActiveDeliveryStrict,
  type ActiveDelivery,
  type ActiveDeliveryArtifact,
} from "../packaging/active-delivery.js";
import { computeSha256 } from "../packaging/manifest.js";
import {
  verifyPackageGeneration,
  type PackageVerificationPaths,
} from "../packaging/package-verification.js";
import { buildFreshGenerationPackagePreflight } from "../packaging/package-preflight-core.js";
import { createSourceInputAttestation } from "../render/source-input-attestation.js";
import { stageDirectRenderOutput } from "../render/direct-render-staging.js";
import { stageBundledFontAssets, type StagedBundledFontPaths } from "../fonts/bundled-font.js";
import { resolveCaptionStylePreset } from "../../editor/shared/caption-style-tokens.js";
import type { CaptionFontContract } from "./font-contract.js";
import { inspectCaptionFontContract } from "./font-contract.js";
import { assertCaptionApprovalCurrent } from "./review-service.js";
import { assertFinalRenderApprovalCurrent } from "../packaging/final-render-approval.js";
import {
  resolveCanonicalCaptionVisualTreatmentInput,
  shouldPreflightCanonicalCaptionVisualTreatment,
} from "../render/canonical-render-input.js";
import type { CaptionVisualTreatmentInput } from "./visual-treatment.js";

/** Lyric delivery contract recorded in v5 receipts (Issue 36 follow-up). */
export interface LyricFinalizeContract {
  /** Which canonical authority supplied the lyric plan inputs. */
  source_kind: "lrc_script" | "authored_caption_approval";
  /** SHA-256 of the lyric script content baked into an LRC generation. */
  script_sha256?: string;
  /** The canonical options object the digest is derived from (auditable). */
  canonical_options: CanonicalLyricOptions;
  /** SHA-256 of the canonical lyric options JSON (sections, motion, bounds). */
  options_digest: string;
  reduced_motion: boolean;
  tail_sec: number;
  max_per_char_sec: number;
  max_hold_sec: number;
  video_duration_sec?: number;
  /** #41 approval/timing/body binding for authored-caption generations. */
  authority?: LyricTypographyAuthority;
  /**
   * Exact face bindings used for measurement AND rendering: family,
   * PostScript name, face index inside the binary, binary path, and binary
   * hash. The written lyric plan and the staged font copies must match.
   */
  faces: Array<{
    role: "verse" | "chorus" | "punk";
    family: string;
    postscript_name: string;
    face_index: number;
    font_path: string;
    font_sha256: string;
  }>;
}


/**
 * Derive the rendered video duration from the timeline (video clips span)
 * so lyric cues can be clamped to the real deliverable length.
 */
export function resolveTimelineVideoDurationSec(
  timeline: Record<string, unknown>,
): number | undefined {
  try {
    const sequence = timeline.sequence as { fps_num?: number; fps_den?: number } | undefined;
    const tracks = timeline.tracks as { video?: Array<{ timeline_in_frame?: number; timeline_duration_frames?: number }> } | undefined;
    if (!sequence?.fps_num || !sequence?.fps_den || !Array.isArray(tracks?.video)) return undefined;
    const fps = sequence.fps_num / sequence.fps_den;
    if (!(fps > 0)) return undefined;
    let maxFrame = 0;
    for (const clip of tracks.video) {
      if (typeof clip?.timeline_in_frame !== "number" || typeof clip?.timeline_duration_frames !== "number") continue;
      maxFrame = Math.max(maxFrame, clip.timeline_in_frame + clip.timeline_duration_frames);
    }
    return maxFrame > 0 ? maxFrame / fps : undefined;
  } catch {
    return undefined;
  }
}

export interface CaptionFinalizeOptions {
  approvalPath?: string;
  suppliedFinalPath?: string;
  suppliedFinalReceiptPath?: string;
  createdAt?: string;
  /** Bound OUTPUT render-route receipt for supplied-final finalization. */
  renderRouteReceiptPath?: string;
  packageOptions?: Pick<
    PackageCommandOptions,
    "assemblyPath" | "assemblyEngine" | "skipRender" | "precomputedMetrics"
  >;
  typographyPolicyPath?: string;
  visualTreatmentPatchPath?: string;
  /**
   * Optional LRC-style lyric script (Issue 36). When set, the default stage
   * runner additionally plans the lyric telops and writes the burn-ready
   * `captions/lyrics.ass` + `captions/lyric-typography-plan.json` into the
   * generation directory. Delivery fails closed on lyric plan violations.
   */
  lyricScriptPath?: string;
  /**
   * Lyric delivery options: explicit sections, reduced motion, staccato
   * bounds, tail, and video duration. Content + options hash into the
   * generation key, so stale or altered lyrics can never reuse a generation.
   */
  lyricOptions?: LyricDeliveryOptions;
}

export interface CaptionFinalizeStageContext {
  projectDir: string;
  generationDir: string;
  generationId: string;
  approvalIntentPath: string;
  approval: CaptionApproval;
  timeline: Record<string, unknown>;
  createdAt: string;
  options: CaptionFinalizeOptions;
  stagedFont: StagedBundledFontPaths;
  captionVisualTreatmentInput?: CaptionVisualTreatmentInput;
  /** Derived plan inputs from the approved #41 authored authority. */
  authoredLyricInputs?: ApprovedAuthoredLyricLineInputs;
  /** Derived video duration for lyric cue clamping (when lyric delivery runs). */
  lyricVideoDurationSec?: number;
  /** The generation key this stage runner is materializing. */
  generationKey: string;
}

export type CaptionFinalizeStageRunner = (context: CaptionFinalizeStageContext) => Promise<void>;

export interface CaptionFinalizePreflightResult {
  version: string;
  decision: string;
  issues: string[];
}

export interface CaptionFinalizeDependencies {
  stageRunner?: CaptionFinalizeStageRunner;
}

export interface CaptionFinalizeReceipt {
  version:
    | "caption-finalize-receipt/v1"
    | "caption-finalize-receipt/v2"
    | "caption-finalize-receipt/v3"
    | "caption-finalize-receipt/v4"
    | "caption-finalize-receipt/v5";
  project_id: string;
  generation_id: string;
  generation_key: string;
  approval_sha256: string;
  timeline_sha256: string;
  final_render_approval_sha256?: string;
  caption_visual_treatment?: {
    status: CaptionVisualTreatmentInput["status"];
    approval_hash: string;
    visual_treatment_patch_hash: string | null;
    typography_policy_hash: string;
    text_timing_hash: string;
    capability_hash: string;
    resolved_input_hash: string;
    applied_caption_ids: string[];
    degraded_reasons: Array<{ caption_id: string; reason: string }>;
    blocked_reasons: Array<{ caption_id: string; reason: string }>;
  };
  created_at: string;
  font_contract?: CaptionFontContract;
  /** Explicit lyric mode: "present" requires contract + all three artifacts. */
  lyric_delivery: "present" | "absent";
  /** OUTPUT route evidence: recomputed from staged render-route bytes. */
  route_evidence: { route_kind: "engine_render" | "supplied_final" | "external_manual_nle"; render_route_receipt_sha256: string };
  /**
   * The exact generation-key input object (v5). Strict boundaries recompute
   * the key from these inputs after substituting the externally anchored
   * fields with CURRENT canonical hashes — an arbitrary or self-rehashed
   * generation key cannot pass.
   */
  generation_key_inputs?: CaptionGenerationKeyInputs;
  /** Present when the generation includes lyric typography delivery. */
  lyric_contract?: LyricFinalizeContract;
  artifacts: Record<string, ActiveDeliveryArtifact>;
  verification: {
    qa_passed: true;
    package_ready: true;
    package_preflight_version: "package-preflight/v2";
    package_preflight_decision: "ready_to_run";
  };
}

export interface CaptionFinalizeResult {
  success: true;
  reused: boolean;
  generationId: string;
  generationDir: string;
  activeDeliveryPath: string;
  activeDelivery: ActiveDelivery;
  receipt: CaptionFinalizeReceipt;
}

interface GenerationPaths {
  ass: string;
  srt: string;
  finalVideo: string;
  qa: string;
  manifest: string;
  preview: string;
  previewReceipt: string;
  receipt: string;
  fontManifest?: string;
  fontPrimary?: string;
  fontAssBold?: string;
  fontAssHeavy?: string;
  suppliedFinalProvenance?: string;
  lyricsAss?: string;
  lyricPlan?: string;
  lyricScript?: string;
}

interface PreparedCanonicalLyricInputs {
  request: LyricRequestArtifact;
  requestBytes: string;
  requestSha256: string;
  canonicalRequestPath: string;
  canonicalScriptPath: string;
  lyricScriptSourcePath?: string;
  lyricScriptBytes?: Buffer;
  copyScriptAfterIdentity: boolean;
  writeRequestAfterIdentity: boolean;
  lyricContract?: LyricFinalizeContract;
  authoredLyricInputs?: ApprovedAuthoredLyricLineInputs;
  lyricInputDigest?: string;
}

interface SuppliedFinalProvenanceReceipt {
  version: "supplied-final-provenance/v1";
  source_receipt_path: string;
  source_receipt_sha256: string;
  base_final_path: string;
  base_final_sha256: string;
  supplied_final_path: string;
  supplied_final_sha256: string;
  caption_ass_sha256: string;
  font_family: string;
  font_sha256: string;
  video_stream_sha256: string;
  verified_at: string;
}

function normalizeCaptionFinalizeDependencies(raw: unknown): CaptionFinalizeDependencies {
  if (raw == null) return {};
  if (typeof raw !== "object") {
    throw new Error("caption-finalize dependencies must be an object");
  }
  const value = raw as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("caption-finalize dependencies must be a plain object");
  }
  const allowed = new Set(["stageRunner"]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(`caption-finalize dependency ${String(key)} is not an authorized runtime seam`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(`caption-finalize dependency ${key} must be a data property`);
    }
  }
  const stageRunner = Object.prototype.hasOwnProperty.call(value, "stageRunner")
    ? value.stageRunner
    : undefined;
  if (stageRunner === undefined) return {};
  if (typeof stageRunner !== "function") {
    throw new Error("caption-finalize dependency stageRunner must be a function");
  }
  return { stageRunner: stageRunner as CaptionFinalizeStageRunner };
}

function sha256Text(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sha256Bytes(value: Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function resolveTimelineFps(timeline: Record<string, unknown>): number {
  const sequence = timeline.sequence as { fps_num?: unknown; fps_den?: unknown } | undefined;
  const fpsNum = sequence?.fps_num;
  const fpsDen = sequence?.fps_den;
  if (typeof fpsNum !== "number" || typeof fpsDen !== "number" || !Number.isFinite(fpsNum)
    || !Number.isFinite(fpsDen) || fpsNum <= 0 || fpsDen <= 0) {
    throw new Error("authored lyric typography requires a finite timeline frame rate");
  }
  const fps = fpsNum / fpsDen;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error("authored lyric typography requires a positive timeline frame rate");
  }
  return fps;
}

function prepareCanonicalLyricInputs(
  projectDir: string,
  options: CaptionFinalizeOptions,
  approval: CaptionApproval,
  timeline: Record<string, unknown>,
  approvalSha256: string,
  timelineSha256: string,
): PreparedCanonicalLyricInputs {
  const canonicalRequestPath = path.join(projectDir, LYRIC_REQUEST_RELATIVE_PATH);
  const canonicalScriptPath = path.join(projectDir, LYRIC_SCRIPT_RELATIVE_PATH);
  let lyricScriptSourcePath: string | undefined;
  let lyricScriptBytes: Buffer | undefined;
  let copyScriptAfterIdentity = false;
  let lyricContract: LyricFinalizeContract | undefined;
  let authoredLyricInputs: ApprovedAuthoredLyricLineInputs | undefined;
  const hasAuthoredAuthority = approval.text_authority !== undefined || approval.timing_authority !== undefined;

  if (options.lyricScriptPath) {
    if (hasAuthoredAuthority) {
      throw new Error("an approved authored caption cannot be combined with a separate lyric script authority");
    }
    lyricScriptSourcePath = resolveProjectArtifactPath(
      projectDir,
      options.lyricScriptPath,
      "lyric script",
    );
    lyricScriptBytes = fs.readFileSync(lyricScriptSourcePath);
    const sourceScriptSha = sha256Bytes(lyricScriptBytes);
    if (fs.existsSync(canonicalScriptPath)) {
      if (computeSha256(canonicalScriptPath) !== sourceScriptSha) {
        throw new Error(
          `canonical lyric script ${canonicalScriptPath} exists with different content; resolve the conflict before finalizing`,
        );
      }
    } else {
      copyScriptAfterIdentity = true;
    }
    const canonicalOptions: CanonicalLyricOptions = {
      reducedMotion: options.lyricOptions?.reducedMotion ?? false,
      sections: options.lyricOptions?.sections ?? [],
      staccatoMaxHoldSec: options.lyricOptions?.staccato?.maxHoldSec ?? null,
      staccatoMaxPerCharSec: options.lyricOptions?.staccato?.maxPerCharSec ?? null,
      tailSec: options.lyricOptions?.tailSec ?? null,
      videoDurationSec: options.lyricOptions?.videoDurationSec ?? null,
      positioning: options.lyricOptions?.positioning ?? "poster_boundary_cross",
    };
    lyricContract = {
      source_kind: "lrc_script",
      script_sha256: sourceScriptSha,
      canonical_options: canonicalOptions,
      options_digest: canonicalLyricOptionsDigest(canonicalOptions),
      reduced_motion: Boolean(options.lyricOptions?.reducedMotion),
      tail_sec: options.lyricOptions?.tailSec ?? 4,
      max_per_char_sec: options.lyricOptions?.staccato?.maxPerCharSec ?? 0.5,
      max_hold_sec: options.lyricOptions?.staccato?.maxHoldSec
        ?? options.lyricOptions?.staccato?.maxPerCharSec ?? 0.5,
      ...(options.lyricOptions?.videoDurationSec !== undefined
        ? { video_duration_sec: options.lyricOptions.videoDurationSec }
        : {}),
      // Exact face bindings resolved with the same probe the production lyric
      // planner uses. Missing capabilities remain a fail-open diagnostic in
      // the planner, but never become an unbound rendering claim.
      faces: (["verse", "chorus", "punk"] as const).map((role) => {
        const binding = resolveLyricFontBindings()[role];
        return {
          role,
          family: binding.family,
          postscript_name: binding.postscript_name ?? "",
          face_index: binding.face_index ?? -1,
          font_path: binding.font_path ?? "",
          font_sha256: binding.font_sha256 ?? "",
        };
      }),
    };
  } else if (hasAuthoredAuthority) {
    const authoredIdentity = readAuthoredCaptionIdentity(projectDir);
    if (!authoredIdentity
      || authoredIdentity.caption_approval_sha256 !== approvalSha256
      || authoredIdentity.timeline_sha256 !== timelineSha256) {
      throw new Error("approved authored caption projection is stale or not bound to the current timeline");
    }
    authoredLyricInputs = loadApprovedAuthoredLyricLineInputs({
      approval,
      fps: resolveTimelineFps(timeline),
      approvalSha256,
      timelineSha256,
      ...(options.lyricOptions?.sections ? { sections: options.lyricOptions.sections } : {}),
    });
    const canonicalOptions: CanonicalLyricOptions = {
      reducedMotion: options.lyricOptions?.reducedMotion ?? false,
      sections: options.lyricOptions?.sections ?? [],
      staccatoMaxHoldSec: options.lyricOptions?.staccato?.maxHoldSec ?? null,
      staccatoMaxPerCharSec: options.lyricOptions?.staccato?.maxPerCharSec ?? null,
      tailSec: options.lyricOptions?.tailSec ?? null,
      videoDurationSec: options.lyricOptions?.videoDurationSec ?? null,
      positioning: options.lyricOptions?.positioning ?? "poster_boundary_cross",
    };
    lyricContract = {
      source_kind: "authored_caption_approval",
      canonical_options: canonicalOptions,
      options_digest: canonicalLyricOptionsDigest(canonicalOptions),
      reduced_motion: Boolean(options.lyricOptions?.reducedMotion),
      tail_sec: options.lyricOptions?.tailSec ?? 4,
      max_per_char_sec: options.lyricOptions?.staccato?.maxPerCharSec ?? 0.5,
      max_hold_sec: options.lyricOptions?.staccato?.maxHoldSec
        ?? options.lyricOptions?.staccato?.maxPerCharSec ?? 0.5,
      ...(options.lyricOptions?.videoDurationSec !== undefined
        ? { video_duration_sec: options.lyricOptions.videoDurationSec }
        : {}),
      authority: authoredLyricInputs.authority,
      faces: ( ["verse", "chorus", "punk"] as const).map((role) => {
        const binding = resolveLyricFontBindings()[role];
        return {
          role,
          family: binding.family,
          postscript_name: binding.postscript_name ?? "",
          face_index: binding.face_index ?? -1,
          font_path: binding.font_path ?? "",
          font_sha256: binding.font_sha256 ?? "",
        };
      }),
    };
  }

  const request = buildLyricRequestArtifact(
    lyricContract ? "present" : "absent",
    lyricContract?.canonical_options,
  );
  const requestBytes = `${JSON.stringify(request, null, 2)}\n`;
  let requestSha256 = sha256Text(requestBytes);
  let writeRequestAfterIdentity = true;
  if (fs.existsSync(canonicalRequestPath)) {
    const existing = readJson<LyricRequestArtifact>(canonicalRequestPath, "canonical lyric request");
    writeRequestAfterIdentity = !isDeepStrictEqual(existing, request);
    if (!writeRequestAfterIdentity) requestSha256 = computeSha256(canonicalRequestPath);
  }
  const lyricInputDigest = lyricContract
    ? lyricContract.source_kind === "authored_caption_approval"
      ? sha256Text(JSON.stringify({
          source_kind: lyricContract.source_kind,
          approval: approvalSha256,
          timeline: timelineSha256,
          text_authority_sha256: lyricContract.authority?.text_authority_sha256,
          timing_authority_sha256: lyricContract.authority?.timing_authority_sha256,
          options_digest: lyricContract.options_digest,
        }))
      : sha256Text(JSON.stringify({
          source_kind: lyricContract.source_kind,
          script_sha256: lyricContract.script_sha256,
          options_digest: lyricContract.options_digest,
        }))
    : undefined;
  return {
    request,
    requestBytes,
    requestSha256,
    canonicalRequestPath,
    canonicalScriptPath,
    ...(lyricScriptSourcePath ? { lyricScriptSourcePath } : {}),
    ...(lyricScriptBytes ? { lyricScriptBytes } : {}),
    copyScriptAfterIdentity,
    writeRequestAfterIdentity,
    ...(lyricContract ? { lyricContract } : {}),
    ...(authoredLyricInputs ? { authoredLyricInputs } : {}),
    ...(lyricInputDigest ? { lyricInputDigest } : {}),
  };
}

function persistCanonicalLyricInputs(prepared: PreparedCanonicalLyricInputs): void {
  if (prepared.copyScriptAfterIdentity) {
    if (!prepared.lyricScriptSourcePath) {
      throw new Error("lyric script source is missing after identity derivation");
    }
    fs.mkdirSync(path.dirname(prepared.canonicalScriptPath), { recursive: true });
    fs.writeFileSync(
      prepared.canonicalScriptPath,
      prepared.lyricScriptBytes ?? fs.readFileSync(prepared.lyricScriptSourcePath),
    );
  }
  if (prepared.writeRequestAfterIdentity) {
    fs.mkdirSync(path.dirname(prepared.canonicalRequestPath), { recursive: true });
    fs.writeFileSync(prepared.canonicalRequestPath, prepared.requestBytes, "utf8");
  }
}

function validateSuppliedFinalInputsBeforeIdentity(
  projectDir: string,
  options: CaptionFinalizeOptions,
): void {
  if (!options.suppliedFinalPath) return;
  const suppliedFinalPath = resolveProjectArtifactPath(
    projectDir,
    options.suppliedFinalPath,
    "supplied final",
  );
  const inputReceiptPath = resolveProjectArtifactPath(
    projectDir,
    options.suppliedFinalReceiptPath!,
    "supplied final receipt",
  );
  const routeReceiptPath = resolveProjectArtifactPath(
    projectDir,
    options.renderRouteReceiptPath!,
    "render route receipt",
  );
  const inputReceipt = readJson<CaptionFinalizeReceipt>(inputReceiptPath, "supplied final receipt");
  assertValid("supplied final receipt", inputReceipt, "caption-finalize-receipt.schema.json");
  if (
    inputReceipt.version !== "caption-finalize-receipt/v5"
    || inputReceipt.verification.qa_passed !== true
    || inputReceipt.verification.package_ready !== true
    || inputReceipt.verification.package_preflight_decision !== "ready_to_run"
  ) {
    throw new Error("supplied final receipt is not a verified v5 generation");
  }
  const canonicalApprovalPath = path.join(projectDir, "07_package", "caption_approval.json");
  const canonicalTimelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const canonicalFinalRenderApprovalPath = path.join(
    projectDir,
    "06_review",
    "final-render-approval.json",
  );
  const canonicalApproval = readJson<{ project_id?: unknown }>(
    canonicalApprovalPath,
    "canonical caption approval",
  );
  if (inputReceipt.project_id !== canonicalApproval.project_id
    || inputReceipt.approval_sha256 !== computeSha256(canonicalApprovalPath)
    || inputReceipt.timeline_sha256 !== computeSha256(canonicalTimelinePath)
    || inputReceipt.final_render_approval_sha256 !== computeSha256(canonicalFinalRenderApprovalPath)) {
    throw new Error("supplied final receipt is not bound to the current canonical approval/timeline");
  }
  const routeReceipt = readJson<{
    receipt_version?: unknown;
    route_evidence?: { route_kind?: unknown };
    outputs?: { final_video?: { path?: unknown; sha256?: unknown } };
  }>(routeReceiptPath, "supplied final render-route receipt");
  assertValid("supplied final render-route receipt", routeReceipt, "render-route-receipt.schema.json");
  if (routeReceipt.receipt_version !== "render-route-receipt/v3"
    || routeReceipt.route_evidence?.route_kind !== "supplied_final") {
    throw new Error("supplied final render-route receipt must claim route_kind=supplied_final");
  }
  const output = routeReceipt.outputs?.final_video;
  if (typeof output?.sha256 !== "string" || output.sha256 !== computeSha256(suppliedFinalPath)) {
    throw new Error("supplied final render-route receipt does not bind the supplied final bytes");
  }
  if (typeof output.path === "string") {
    const routeOutputPath = path.isAbsolute(output.path)
      ? path.resolve(output.path)
      : path.resolve(path.dirname(routeReceiptPath), output.path);
    if (routeOutputPath !== suppliedFinalPath) {
      throw new Error("supplied final render-route receipt output path does not match the supplied final");
    }
  }
}

export async function runCaptionFinalize(
  projectDir: string,
  options: CaptionFinalizeOptions = {},
  rawDependencies: unknown = {},
): Promise<CaptionFinalizeResult> {
  const absProject = path.resolve(projectDir);
  const dependencies = normalizeCaptionFinalizeDependencies(rawDependencies);
  assertSuppliedFinalOptions(options);
  validateSuppliedFinalInputsBeforeIdentity(absProject, options);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const timelinePath = path.join(absProject, "05_timeline", "timeline.json");
  const approvalSourcePath = resolveProjectArtifactPath(
    absProject,
    options.approvalPath ?? path.join(absProject, "07_package", "caption_approval.json"),
    "caption approval",
  );
  const timeline = readJson<Record<string, unknown>>(timelinePath, "timeline");
  const approval = readJson<CaptionApproval>(approvalSourcePath, "caption approval");
  assertValid("caption approval", approval, "caption-approval.schema.json");
  assertValid("timeline", timeline, "timeline-ir.schema.json");
  if (approval.approval.status !== "approved") {
    throw new Error(`caption approval status must be approved, got ${approval.approval.status}`);
  }
  if (
    typeof approval.approval.approved_by !== "string"
    || approval.approval.approved_by.trim().length === 0
    || typeof approval.approval.approved_at !== "string"
    || !Number.isFinite(Date.parse(approval.approval.approved_at))
  ) {
    throw new Error("caption approval must include a human approved_by and valid approved_at");
  }
  const timelineProjectId = typeof timeline.project_id === "string" ? timeline.project_id : "";
  if (!timelineProjectId || timelineProjectId !== approval.project_id) {
    throw new Error(`caption approval project_id mismatch: timeline=${timelineProjectId || "-"} approval=${approval.project_id}`);
  }
  const timelineVersion = typeof timeline.version === "string" ? timeline.version : "";
  if (!timelineVersion || approval.base_timeline_version !== timelineVersion) {
    throw new Error(
      `caption approval is stale: timeline=${timelineVersion || "-"} approval=${approval.base_timeline_version}`,
    );
  }

  const approvalSha256 = computeSha256(approvalSourcePath);
  const timelineSha256 = computeSha256(timelinePath);
  const reviewProvenance = [
    approval.approval.base_caption_draft_hash,
    approval.approval.caption_review_patch_hash,
    approval.approval.validation_hash,
  ];
  if (reviewProvenance.some((value) => value !== undefined)) {
    if (!reviewProvenance.every((value) => typeof value === "string")) {
      throw new Error("caption approval review provenance is incomplete");
    }
    try {
      assertCaptionApprovalCurrent(absProject, approval);
    } catch (error) {
      throw new Error(`caption approval is stale or invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // This check intentionally happens after the caption approval's own
  // diagnostics, but before generation setup or renderer invocation. A
  // missing/stale human checklist must not consume a long-form render merely
  // to fail at package verification later.
  const finalRenderApproval = assertFinalRenderApprovalCurrent(absProject, {
    captionApprovalPath: approvalSourcePath,
  });
  let captionVisualTreatmentInput: CaptionVisualTreatmentInput | undefined;
  if (shouldPreflightCanonicalCaptionVisualTreatment(absProject, {
    typographyPolicyPath: options.typographyPolicyPath,
    visualTreatmentPatchPath: options.visualTreatmentPatchPath,
    approval: approval.approval,
  })) {
    captionVisualTreatmentInput = resolveCanonicalCaptionVisualTreatmentInput(absProject, {
      approvalPath: approvalSourcePath,
      typographyPolicyPath: options.typographyPolicyPath ?? "04_plan/typography_policy.json",
      visualTreatmentPatchPath: options.visualTreatmentPatchPath,
    });
    if (captionVisualTreatmentInput.status === "blocked" || captionVisualTreatmentInput.status === "human_hold") {
      throw new Error(`caption-finalize visual-treatment input is not renderable: ${captionVisualTreatmentInput.status}`);
    }
  }
  const verifiedFont = inspectCaptionFontContract(approval.caption_policy.styling_class);
  if (
    verifiedFont.status !== "ready"
    || verifiedFont.fallback_used
    || !verifiedFont.primary
    || !verifiedFont.ass_bold
    || !verifiedFont.ass_heavy
    || !verifiedFont.selected_family
    || !verifiedFont.selected_asset
  ) {
    throw new Error(`caption-finalize font contract is not ready: ${verifiedFont.diagnostics.map((entry) => entry.message).join("; ")}`);
  }
  // Derive all lyric identity material in memory first. Canonical request and
  // script writes happen only after source attestation, external route
  // validation, and generation-key calculation have succeeded.
  const preparedLyric = prepareCanonicalLyricInputs(
    absProject,
    options,
    approval,
    timeline,
    approvalSha256,
    timelineSha256,
  );
  const { lyricContract, lyricInputDigest } = preparedLyric;

  const generationKeyInputs = buildGenerationKeyInputs(absProject, {
    approvalSha256,
    timelineSha256,
    finalRenderApprovalSha256: finalRenderApproval.sha256,
    lyricRequestSha256: preparedLyric.requestSha256,
    ...(lyricContract
      ? { lyricFaceIdentity: canonicalLyricFaceIdentity(lyricContract.faces) }
      : {}),

    suppliedFinalPath: options.suppliedFinalPath,
    suppliedFinalReceiptPath: options.suppliedFinalReceiptPath,
    suppliedFinalRouteReceiptPath: options.renderRouteReceiptPath,
    fontPrimarySha256: verifiedFont.primary.sha256,
    fontAssBoldSha256: verifiedFont.ass_bold.sha256,
    fontAssHeavySha256: verifiedFont.ass_heavy.sha256,
    fontSelectedFamily: verifiedFont.selected_family,
    fontSelectedRole: verifiedFont.selected_asset.role,
    fontSelectedSha256: verifiedFont.selected_asset.sha256,
    ...(lyricInputDigest ? { lyricInputDigest } : {}),
  });
  const generationKey = generationKeyFromInputs(generationKeyInputs);
  const generationId = generationKey.slice("sha256:".length, "sha256:".length + 24);
  persistCanonicalLyricInputs(preparedLyric);
  const rootDir = path.join(absProject, CAPTION_FINALIZE_ROOT_RELATIVE_PATH);
  const intentDir = path.join(rootDir, "intents");
  const generationsDir = path.join(rootDir, "generations");
  const generationDir = path.join(generationsDir, generationId);
  const lockDir = path.join(rootDir, "locks", `${generationId}.lock`);
  fs.mkdirSync(intentDir, { recursive: true });
  fs.mkdirSync(generationsDir, { recursive: true });
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  const approvalIntentPath = path.join(intentDir, `${approvalSha256.slice("sha256:".length)}.json`);
  persistImmutableIntent(approvalSourcePath, approvalIntentPath, approvalSha256);
  acquireLock(lockDir);
  try {
    const existing = await validateCompletedGeneration({
      projectDir: absProject,
      generationDir,
      approvalIntentPath,
      approvalSha256,
      timelineSha256,
      finalRenderApprovalSha256: finalRenderApproval.sha256,
      generationKey,
      verifiedFont,
      ...(lyricContract ? { expectedLyricContract: lyricContract } : {}),
    });
    if (existing) {
      const active = buildActiveDelivery(absProject, existing, approvalIntentPath, createdAt);
      let current: ActiveDelivery | null = null;
      try {
        current = readActiveDeliveryStrict(absProject);
      } catch {
        // an invalid pointer never protects a generation from recreation
        current = null;
      }
      if (current?.generation_id !== generationId) {
        atomicActivate(activeDeliveryPath(absProject), active);
      }
      return {
        success: true,
        reused: true,
        generationId,
        generationDir,
        activeDeliveryPath: activeDeliveryPath(absProject),
        activeDelivery: current?.generation_id === generationId ? current : active,
        receipt: existing,
      };
    }

    if (fs.existsSync(generationDir)) {
      if (activePointerMayReferenceGeneration(absProject, generationId)) {
        throw new Error(
          `caption-finalize refuses to replace generation referenced by the active pointer: ${generationId}`,
        );
      }
      fs.rmSync(generationDir, { recursive: true, force: true });
    }
    fs.mkdirSync(generationDir, { recursive: true });
    const style = resolveCaptionStylePreset(approval.caption_policy.styling_class);
    const stagedFont = stageBundledFontAssets(
      generationDir,
      style.fontId,
      process.cwd(),
      {
        family: verifiedFont.selected_family,
        role: verifiedFont.selected_asset.role,
        weight: verifiedFont.selected_asset.weight,
      },
    );
    assertValid(
      "font staging manifest",
      readJson(stagedFont.manifestPath, "font staging manifest"),
      "font-staging-manifest.schema.json",
    );
    const stageContext: CaptionFinalizeStageContext = {
      projectDir: absProject,
      generationDir,
      generationId,
      generationKey,
      approvalIntentPath,
      approval,
      timeline,
      createdAt,
      options,
      stagedFont,
      captionVisualTreatmentInput,
      ...(preparedLyric.authoredLyricInputs
        ? { authoredLyricInputs: preparedLyric.authoredLyricInputs }
        : {}),
      ...(lyricContract
        ? { lyricVideoDurationSec: options.lyricOptions?.videoDurationSec
          ?? resolveTimelineVideoDurationSec(timeline) }
        : {}),
    };
    await (dependencies.stageRunner ?? defaultCaptionFinalizeStageRunner)(stageContext);
    // The stage runner is only a rendering seam. Supplied-final provenance is
    // an authority decision and is re-verified by the core after the seam
    // returns, so a custom runner cannot bypass the built-in stream/font/
    // caption binding checks.
    if (options.suppliedFinalPath) {
      verifySuppliedFinalProvenance(stageContext);
    }
    writePreviewArtifacts(generationDir, createdAt, approvalSha256, timelineSha256, stagedFont, captionVisualTreatmentInput);

    const receipt = await verifyAndWriteReceipt({
      projectDir: absProject,
      generationDir,
      approvalIntentPath,
      projectId: approval.project_id,
      generationId,
      generationKey,
      approvalSha256,
      timelineSha256,
      finalRenderApprovalSha256: finalRenderApproval.sha256,
      createdAt,
      stagedFont,
      captionVisualTreatmentInput,
      lyricContract,
      generationKeyInputs,
    });
    const active = buildActiveDelivery(absProject, receipt, approvalIntentPath, createdAt);
    atomicActivate(activeDeliveryPath(absProject), active);
    return {
      success: true,
      reused: false,
      generationId,
      generationDir,
      activeDeliveryPath: activeDeliveryPath(absProject),
      activeDelivery: active,
      receipt,
    };
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

export async function defaultCaptionFinalizeStageRunner(
  context: CaptionFinalizeStageContext,
): Promise<void> {
  const approvalCopyPath = path.join(context.generationDir, "caption_approval.json");
  fs.copyFileSync(context.approvalIntentPath, approvalCopyPath);
  writeApprovedCaptionDeliveryArtifacts(
    context.approval,
    context.timeline as Parameters<typeof writeApprovedCaptionDeliveryArtifacts>[1],
    context.generationDir,
    context.captionVisualTreatmentInput,
  );
  if (context.options.lyricScriptPath) {
    writeLyricTypographyDeliveryArtifacts({
      // Render the exact script bytes that were included in the generation
      // identity, not a path that may have changed after preflight.
      lyricScriptPath: path.join(context.projectDir, LYRIC_SCRIPT_RELATIVE_PATH),
      outputDir: context.generationDir,
      // bound face binaries are staged into the generation fonts dir so the
      // production compositor's fontsdir serves the exact measured faces
      fontsDir: context.stagedFont.fontsDir,
      options: {
        ...context.options.lyricOptions,
        videoDurationSec: context.lyricVideoDurationSec
          ?? context.options.lyricOptions?.videoDurationSec,
      },
    });
  } else if (context.authoredLyricInputs) {
    writeApprovedAuthoredLyricTypographyDeliveryArtifacts({
      authoredInputs: context.authoredLyricInputs,
      outputDir: context.generationDir,
      options: context.options.lyricOptions,
      fontsDir: context.stagedFont.fontsDir,
    });
  }

  if (context.options.renderRouteReceiptPath) {
    const routeReceiptPath = resolveProjectArtifactPath(
      context.projectDir,
      context.options.renderRouteReceiptPath,
      "render route receipt",
    );
    const stagedRouteReceiptPath = path.join(context.generationDir, "logs", "render-route.json");
    fs.mkdirSync(path.dirname(stagedRouteReceiptPath), { recursive: true });
    fs.copyFileSync(routeReceiptPath, stagedRouteReceiptPath);
  }
  if (context.options.suppliedFinalPath) {
    const provenance = verifySuppliedFinalProvenance(context);
    const provenancePath = path.join(
      context.generationDir,
      "staging",
      "supplied-final-provenance.json",
    );
    fs.mkdirSync(path.dirname(provenancePath), { recursive: true });
    fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
    assertValid(
      "supplied final provenance",
      provenance,
      "supplied-final-provenance.schema.json",
    );
    const suppliedFinalPath = resolveProjectArtifactPath(
      context.projectDir,
      context.options.suppliedFinalPath,
      "supplied final",
    );
    const staged = stageDirectRenderOutput(
      suppliedFinalPath,
      context.generationDir,
      context.createdAt,
    );
    assertValid(
      "direct render staging receipt",
      staged.receipt,
      "direct-render-staging-receipt.schema.json",
    );
    // bind the INPUT caption-finalize receipt into the generation (distinct
    // from the output render-route receipt) for identity recomputation
    if (context.options.suppliedFinalReceiptPath) {
      const inputReceiptCopy = path.join(context.generationDir, "staging", "input-caption-receipt.json");
      fs.copyFileSync(
        resolveProjectArtifactPath(
          context.projectDir,
          context.options.suppliedFinalReceiptPath,
          "supplied final receipt",
        ),
        inputReceiptCopy,
      );
    }
  }
  const result = await packageCaptionFinalizeGeneration(context.projectDir, {
    ...context.options.packageOptions,
    createdAt: context.createdAt,
  });
  if (!result.success) {
    const details = result.error?.details ? ` details=${JSON.stringify(result.error.details)}` : "";
    throw new Error(`caption-finalize package stage failed: ${result.error?.message ?? "unknown error"}${details}`);
  }
}

async function verifyAndWriteReceipt(input: {
  projectDir: string;
  generationDir: string;
  approvalIntentPath: string;
  projectId: string;
  generationId: string;
  generationKey: string;
  approvalSha256: string;
  timelineSha256: string;
  finalRenderApprovalSha256: string;
  createdAt: string;
  stagedFont: StagedBundledFontPaths;
  captionVisualTreatmentInput?: CaptionVisualTreatmentInput;
  lyricContract?: LyricFinalizeContract;
  generationKeyInputs?: CaptionGenerationKeyInputs;
}): Promise<CaptionFinalizeReceipt> {
  const paths = generationPaths(input.generationDir, input.stagedFont);
  for (const [name, filePath] of Object.entries(paths)) {
    if (name === "receipt") continue;
    if (!filePath) continue;
    if (!fs.existsSync(filePath)) throw new Error(`caption-finalize stage missing ${name}: ${filePath}`);
  }
  const qa = readJson<{ passed?: boolean; checks?: Array<{ passed?: boolean }> }>(paths.qa, "QA report");
  assertValid("QA report", qa, "package-qa-report.schema.json");
  if (qa.passed !== true || !qa.checks?.length || qa.checks.some((check) => check.passed !== true)) {
    throw new Error("caption-finalize QA report did not pass every check");
  }
  const manifest = readJson<unknown>(paths.manifest, "package manifest");
  assertValid("package manifest", manifest, "package-manifest.schema.json");

  const verificationPaths: PackageVerificationPaths = {
    qaReportPath: paths.qa,
    packageManifestPath: paths.manifest,
    finalVideoPath: paths.finalVideo,
    captionApprovalPath: input.approvalIntentPath,
    allowApprovedState: true,
  };
  const packageVerification = verifyPackageGeneration(input.projectDir, verificationPaths);
  if (!packageVerification.ready) {
    throw new Error(`caption-finalize package verification failed: ${packageVerification.issues.join("; ")}`);
  }
  const preflight = await defaultPackagePreflight(input.projectDir, input.generationDir);
  if (preflight.version !== "package-preflight/v2" || preflight.decision !== "ready_to_run") {
    throw new Error(
      `caption-finalize package-preflight/v2 failed: version=${preflight.version} decision=${preflight.decision} ${preflight.issues.join("; ")}`,
    );
  }

  const artifacts = artifactHashes(input.projectDir, input.approvalIntentPath, paths);
  // Lyric identity binding: direct LRC delivery binds a script copy, while
  // authored delivery binds the plan to the #41 authority without copying it.
  if (input.lyricContract) {
    const shippedScript = artifacts.lyric_script;
    if (input.lyricContract.source_kind !== "authored_caption_approval") {
      if (!shippedScript || shippedScript.sha256 !== input.lyricContract.script_sha256) {
        throw new Error("lyric contract script_sha256 does not match the shipped lyric script artifact");
      }
    } else if (shippedScript || !input.lyricContract.authority) {
      throw new Error("authored lyric delivery must bind authority without a duplicate lyric script artifact");
    }
    const lyricPlan = readJson<{
      authority?: LyricTypographyAuthority;
      fonts: Record<string, { font_path?: string; face_index?: number; postscript_name?: string; font_sha256?: string }>;
    }>(
      paths.lyricPlan!,
      "lyric typography plan",
    );
    if (input.lyricContract.source_kind === "authored_caption_approval"
      && !isDeepStrictEqual(lyricPlan.authority, input.lyricContract.authority)) {
      throw new Error("authored lyric plan authority does not match the caption-finalize contract");
    }
    const stagedDir = path.join(input.generationDir, "fonts");
    for (const face of input.lyricContract.faces) {
      const planFont = lyricPlan.fonts[face.role];
      if (planFont.font_path !== face.font_path
        || planFont.face_index !== face.face_index
        || (planFont.postscript_name ?? "") !== face.postscript_name
        || planFont.font_sha256 !== face.font_sha256) {
        throw new Error(`lyric plan font binding mismatch for role ${face.role}: plan does not match the lyric contract`);
      }
      if (!face.font_path) continue;
      // the staged copy libass will load is byte-identical to the bound binary
      const candidates = fs.readdirSync(stagedDir).filter((name) => name.startsWith(`lyrics-${face.role}.`));
      if (candidates.length !== 1) {
        throw new Error(`lyric face for role ${face.role} is not staged exactly once in the generation fonts dir`);
      }
      const stagedHash = computeSha256(path.join(stagedDir, candidates[0]));
      if (stagedHash !== face.font_sha256) {
        throw new Error(`staged lyric font hash mismatch for role ${face.role}: rendering font differs from the measured font`);
      }
    }
  }
  const receipt: CaptionFinalizeReceipt = {
    version: "caption-finalize-receipt/v5",
    project_id: input.projectId,
    generation_id: input.generationId,
    generation_key: input.generationKey,
    approval_sha256: input.approvalSha256,
    timeline_sha256: input.timelineSha256,
    final_render_approval_sha256: input.finalRenderApprovalSha256,
    created_at: input.createdAt,
    font_contract: fontContractFromPaths(input.projectDir, paths),
    // explicit discriminator: lyric artifacts and contract are mutually
    // required when "present" and forbidden when "absent"
    lyric_delivery: input.lyricContract ? "present" : "absent",
    route_evidence: recomputeRouteEvidence(input.generationDir),
    ...(input.lyricContract ? { lyric_contract: input.lyricContract } : {}),
    ...(input.generationKeyInputs ? { generation_key_inputs: input.generationKeyInputs } : {}),
    ...(input.captionVisualTreatmentInput ? {
      caption_visual_treatment: {
        status: input.captionVisualTreatmentInput.status,
        approval_hash: input.captionVisualTreatmentInput.approval_hash,
        visual_treatment_patch_hash: input.captionVisualTreatmentInput.visual_treatment_patch_hash,
        typography_policy_hash: input.captionVisualTreatmentInput.typography_policy_hash,
        text_timing_hash: input.captionVisualTreatmentInput.text_timing_hash,
        capability_hash: input.captionVisualTreatmentInput.capability_hash,
        resolved_input_hash: input.captionVisualTreatmentInput.input_hash,
        applied_caption_ids: input.captionVisualTreatmentInput.applied_caption_ids,
        degraded_reasons: input.captionVisualTreatmentInput.degraded_reasons,
        blocked_reasons: input.captionVisualTreatmentInput.blocked_reasons,
      },
    } : {}),
    artifacts,
    verification: {
      qa_passed: true,
      package_ready: true,
      package_preflight_version: "package-preflight/v2",
      package_preflight_decision: "ready_to_run",
    },
  };
  assertValid("caption-finalize receipt", receipt, "caption-finalize-receipt.schema.json");
  fs.writeFileSync(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

async function validateCompletedGeneration(input: {
  projectDir: string;
  generationDir: string;
  approvalIntentPath: string;
  approvalSha256: string;
  timelineSha256: string;
  finalRenderApprovalSha256: string;
  generationKey: string;
  verifiedFont: CaptionFontContract;
  /** Expected current lyric contract; reuse must match exactly. */
  expectedLyricContract?: LyricFinalizeContract;
}): Promise<CaptionFinalizeReceipt | null> {
  const paths = generationPaths(input.generationDir);
  if (!fs.existsSync(paths.receipt)) return null;
  try {
    const receipt = readJson<CaptionFinalizeReceipt>(paths.receipt, "caption-finalize receipt");
    assertValid("caption-finalize receipt", receipt, "caption-finalize-receipt.schema.json");
    if (
      // downgrade prevention: only the current full-identity receipt opens reuse
      (receipt.version !== "caption-finalize-receipt/v5")
      || receipt.generation_key !== input.generationKey
      || receipt.approval_sha256 !== input.approvalSha256
      || receipt.timeline_sha256 !== input.timelineSha256
      || receipt.final_render_approval_sha256 !== input.finalRenderApprovalSha256
    ) return null;
    // Recompute every generation-key input from current canonical sources and
    // generation-local evidence before reuse. The recorded key is comparison
    // evidence only; matching the caller's precomputed key is insufficient.
    if (!receipt.generation_key_inputs) return null;
    const anchors = deriveDeliveryIdentityAnchors(input.projectDir);
    const recomputed = recomputeCurrentGenerationKeyInputs({
      projectDir: input.projectDir,
      generationDir: input.generationDir,
      anchors,
      expectedProjectId: anchors.expectedProjectId,
      lyricDeliveryMode: receipt.lyric_delivery,
      lyricContract: receipt.lyric_contract,
      persistedInputs: receipt.generation_key_inputs,
    });
    const recomputedKey = generationKeyFromInputs(recomputed.inputs);
    if (recomputedKey !== receipt.generation_key
      || recomputedKey !== input.generationKey
      || generationIdFromKey(recomputedKey) !== receipt.generation_id
      || receipt.route_evidence.route_kind !== recomputed.routeEvidence.route_kind
      || receipt.route_evidence.render_route_receipt_sha256 !== recomputed.routeEvidence.render_route_receipt_sha256) {
      return null;
    }
    // lyric contract must match the CURRENT expectation exactly: a reused
    // generation never serves lyrics that differ from the present request
    if (input.expectedLyricContract) {
      if (!receipt.lyric_contract
        || !isDeepStrictEqual(receipt.lyric_contract, input.expectedLyricContract)
        || receipt.lyric_delivery !== "present") return null;
    } else if (receipt.lyric_contract || receipt.lyric_delivery === "present") {
      return null;
    }
    const stagedFont = fontContractFromPaths(input.projectDir, paths);
    if (
      !isDeepStrictEqual(receipt.font_contract, stagedFont)
      || !fontContractMatchesCurrent(stagedFont, input.verifiedFont)
    ) return null;
    for (const artifact of Object.values(receipt.artifacts)) {
      const filePath = path.resolve(input.projectDir, artifact.path);
      if (!fs.existsSync(filePath) || computeSha256(filePath) !== artifact.sha256) return null;
    }
    const verified = await verifyAndReadExisting(input.projectDir, input.generationDir, input.approvalIntentPath);
    return verified ? receipt : null;
  } catch {
    return null;
  }
}

function fontContractMatchesCurrent(
  staged: CaptionFontContract,
  current: CaptionFontContract,
): boolean {
  return staged.status === "ready"
    && current.status === "ready"
    && !staged.fallback_used
    && !current.fallback_used
    && staged.font_id === current.font_id
    && staged.family === current.family
    && staged.primary?.sha256 === current.primary?.sha256
    && staged.ass_bold?.family === current.ass_bold?.family
    && staged.ass_bold?.sha256 === current.ass_bold?.sha256
    && staged.ass_heavy?.family === current.ass_heavy?.family
    && staged.ass_heavy?.sha256 === current.ass_heavy?.sha256
    && staged.selected_family === current.selected_family
    && staged.selected_asset?.role === current.selected_asset?.role
    && staged.selected_asset?.family === current.selected_asset?.family
    && staged.selected_asset?.sha256 === current.selected_asset?.sha256
    && staged.selected_asset?.weight === current.selected_asset?.weight;
}

function assertSuppliedFinalOptions(options: CaptionFinalizeOptions): void {
  const hasFinal = typeof options.suppliedFinalPath === "string";
  const hasReceipt = typeof options.suppliedFinalReceiptPath === "string";
  const hasRouteReceipt = typeof options.renderRouteReceiptPath === "string";
  if (hasFinal !== hasReceipt) {
    throw new Error(
      "--supplied-final and --supplied-final-receipt must be provided together",
    );
  }
  if (hasFinal !== hasRouteReceipt) {
    throw new Error(
      "--supplied-final and --render-route-receipt must be provided together",
    );
  }
}

function verifySuppliedFinalProvenance(
  context: CaptionFinalizeStageContext,
): SuppliedFinalProvenanceReceipt {
  const suppliedFinalPath = context.options.suppliedFinalPath
    ? resolveProjectArtifactPath(context.projectDir, context.options.suppliedFinalPath, "supplied final")
    : undefined;
  const sourceReceiptPath = context.options.suppliedFinalReceiptPath;
  if (!suppliedFinalPath || !sourceReceiptPath) {
    throw new Error("supplied final provenance inputs are incomplete");
  }
  const receiptPath = resolveProjectArtifactPath(
    context.projectDir,
    sourceReceiptPath,
    "supplied final receipt",
  );
  const sourceReceipt = readJson<CaptionFinalizeReceipt>(
    receiptPath,
    "supplied final receipt",
  );
  assertValid(
    "supplied final receipt",
    sourceReceipt,
    "caption-finalize-receipt.schema.json",
  );
  if (sourceReceipt.project_id !== context.approval.project_id) {
    throw new Error("supplied final receipt belongs to a different project");
  }
  if (sourceReceipt.approval_sha256 !== computeSha256(context.approvalIntentPath)) {
    throw new Error("supplied final receipt approval does not match the current approval");
  }
  const currentTimelinePath = path.join(context.projectDir, "05_timeline", "timeline.json");
  if (sourceReceipt.timeline_sha256 !== computeSha256(currentTimelinePath)) {
    throw new Error("supplied final receipt timeline does not match the current timeline");
  }
  const currentFinalRenderApprovalPath = path.join(
    context.projectDir,
    "06_review",
    "final-render-approval.json",
  );
  if (sourceReceipt.final_render_approval_sha256 !== computeSha256(currentFinalRenderApprovalPath)) {
    throw new Error("supplied final receipt final-render approval does not match the current approval");
  }
  // downgrade prevention: ONLY the current v5 input receipt proves provenance
  if (
    sourceReceipt.version !== "caption-finalize-receipt/v5"
    || sourceReceipt.verification.qa_passed !== true
    || sourceReceipt.verification.package_ready !== true
    || sourceReceipt.verification.package_preflight_decision !== "ready_to_run"
  ) {
    throw new Error("supplied final receipt is not a verified v5 generation");
  }
  const sourceAss = sourceReceipt.artifacts.caption_ass;
  const sourceFinal = sourceReceipt.artifacts.final_video;
  if (!sourceAss || !sourceFinal || !sourceReceipt.font_contract) {
    throw new Error("supplied final receipt is missing caption, video, or font provenance");
  }
  const sourceAssPath = resolveProjectArtifactPath(
    context.projectDir,
    sourceAss.path,
    "supplied final caption",
  );
  const sourceFinalPath = resolveProjectArtifactPath(
    context.projectDir,
    sourceFinal.path,
    "supplied final base video",
  );
  if (
    computeSha256(sourceAssPath) !== sourceAss.sha256
    || computeSha256(sourceFinalPath) !== sourceFinal.sha256
  ) {
    throw new Error("supplied final provenance generation artifacts are stale");
  }
  const currentAssPath = path.join(context.generationDir, "captions", "speech.ass");
  const currentAssSha256 = computeSha256(currentAssPath);
  if (currentAssSha256 !== sourceAss.sha256) {
    throw new Error("supplied final captions do not match the current approved ASS");
  }
  const currentFont = fontContractFromPaths(
    context.projectDir,
    generationPaths(context.generationDir, context.stagedFont),
  );
  if (!fontContractMatchesCurrent(sourceReceipt.font_contract, currentFont)) {
    throw new Error("supplied final font provenance does not match the current font contract");
  }
  const baseVideoStreamSha256 = computeVideoStreamHash(sourceFinalPath);
  const suppliedVideoStreamSha256 = computeVideoStreamHash(suppliedFinalPath);
  if (baseVideoStreamSha256 !== suppliedVideoStreamSha256) {
    throw new Error(
      "supplied final video stream differs from its caption/font provenance generation",
    );
  }
  return {
    version: "supplied-final-provenance/v1",
    source_receipt_path: projectRelative(context.projectDir, receiptPath),
    source_receipt_sha256: computeSha256(receiptPath),
    base_final_path: projectRelative(context.projectDir, sourceFinalPath),
    base_final_sha256: sourceFinal.sha256,
    supplied_final_path: projectRelative(context.projectDir, suppliedFinalPath),
    supplied_final_sha256: computeSha256(suppliedFinalPath),
    caption_ass_sha256: currentAssSha256,
    font_family: currentFont.selected_family!,
    font_sha256: currentFont.selected_asset!.sha256,
    video_stream_sha256: suppliedVideoStreamSha256,
    verified_at: context.createdAt,
  };
}

function resolveProjectArtifactPath(
  projectDir: string,
  artifactPath: string,
  label: string,
): string {
  const projectRoot = path.resolve(projectDir);
  const resolved = path.resolve(projectRoot, artifactPath);
  if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`${label} escaped the project directory`);
  }
  if (!fs.existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`);
  const projectReal = fs.realpathSync(projectRoot);
  const resolvedReal = fs.realpathSync(resolved);
  if (resolvedReal !== projectReal && !resolvedReal.startsWith(`${projectReal}${path.sep}`)) {
    throw new Error(`${label} escaped the project directory through a symlink`);
  }
  return resolved;
}

export { computeVideoStreamHash } from "../media/video-stream-hash.js";

async function verifyAndReadExisting(
  projectDir: string,
  generationDir: string,
  approvalIntentPath: string,
): Promise<boolean> {
  const paths = generationPaths(generationDir);
  const verification = verifyPackageGeneration(projectDir, {
    qaReportPath: paths.qa,
    packageManifestPath: paths.manifest,
    finalVideoPath: paths.finalVideo,
    captionApprovalPath: approvalIntentPath,
    allowApprovedState: true,
  });
  if (!verification.ready) return false;
  const preflight = await defaultPackagePreflight(projectDir, generationDir);
  return preflight.version === "package-preflight/v2" && preflight.decision === "ready_to_run";
}

/**
 * The finalize's own preflight evidence: the fresh-generation composite
 * (packageCaptionFinalizeGeneration) writes its preflight result into the
 * generation logs; the receipt verification reads it — the pointer is never
 * consulted for the fresh generation.
 */
async function defaultPackagePreflight(
  projectDir: string,
  generationDir: string,
): Promise<ReturnType<typeof buildFreshGenerationPackagePreflight>> {
  return buildFreshGenerationPackagePreflight(projectDir, generationDir);
}
function writePreviewArtifacts(
  generationDir: string,
  createdAt: string,
  approvalSha256: string,
  timelineSha256: string,
  stagedFont: StagedBundledFontPaths,
  captionVisualTreatmentInput?: CaptionVisualTreatmentInput,
): void {
  const paths = generationPaths(generationDir, stagedFont);
  fs.mkdirSync(path.dirname(paths.preview), { recursive: true });
  materializeFileSync(paths.finalVideo, paths.preview);
  const finalIdentity = fileIdentity(paths.finalVideo);
  const previewIdentity = fileIdentity(paths.preview);
  const receipt = {
    version: "caption-finalize-preview-receipt/v2",
    source_final_path: paths.finalVideo,
    source_final_sha256: computeSha256(paths.finalVideo),
    source_final_size_bytes: finalIdentity.size_bytes,
    source_final_mtime_ms: finalIdentity.mtime_ms,
    preview_path: paths.preview,
    preview_sha256: computeSha256(paths.preview),
    preview_size_bytes: previewIdentity.size_bytes,
    preview_mtime_ms: previewIdentity.mtime_ms,
    approval_sha256: approvalSha256,
    timeline_sha256: timelineSha256,
    font_manifest_sha256: computeSha256(paths.fontManifest!),
    ...(captionVisualTreatmentInput ? {
      caption_visual_treatment: {
        resolved_input_hash: captionVisualTreatmentInput.input_hash,
        approval_hash: captionVisualTreatmentInput.approval_hash,
        visual_treatment_patch_hash: captionVisualTreatmentInput.visual_treatment_patch_hash,
        typography_policy_hash: captionVisualTreatmentInput.typography_policy_hash,
        text_timing_hash: captionVisualTreatmentInput.text_timing_hash,
        capability_hash: captionVisualTreatmentInput.capability_hash,
      },
    } : {}),
    created_at: createdAt,
  };
  assertValid("caption-finalize preview receipt", receipt, "caption-finalize-preview-receipt.schema.json");
  fs.writeFileSync(paths.previewReceipt, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function buildActiveDelivery(
  projectDir: string,
  receipt: CaptionFinalizeReceipt,
  approvalIntentPath: string,
  activatedAt: string,
): ActiveDelivery {
  const active: ActiveDelivery = {
    version: "active-delivery/v1",
    project_id: receipt.project_id,
    generation_id: receipt.generation_id,
    generation_path: `${CAPTION_FINALIZE_ROOT_RELATIVE_PATH}/generations/${receipt.generation_id}`,
    activated_at: activatedAt,
    approval_intent: artifact(projectDir, approvalIntentPath),
    inputs: {
      approval_sha256: receipt.approval_sha256,
      timeline_sha256: receipt.timeline_sha256,
      ...(receipt.final_render_approval_sha256
        ? { final_render_approval_sha256: receipt.final_render_approval_sha256 }
        : {}),
      generation_key: receipt.generation_key,
    },
    artifacts: {
      caption_ass: receipt.artifacts.caption_ass,
      caption_srt: receipt.artifacts.caption_srt,
      final_video: receipt.artifacts.final_video,
      qa_report: receipt.artifacts.qa_report,
      package_manifest: receipt.artifacts.package_manifest,
      preview: receipt.artifacts.preview,
      preview_receipt: receipt.artifacts.preview_receipt,
      receipt: artifact(projectDir, path.join(
        projectDir,
        CAPTION_FINALIZE_ROOT_RELATIVE_PATH,
        "generations",
        receipt.generation_id,
        "caption-finalize-receipt.json",
      )),
      ...(receipt.artifacts.lyrics_ass && receipt.artifacts.lyric_plan ? {
        lyrics_ass: receipt.artifacts.lyrics_ass,
        lyric_plan: receipt.artifacts.lyric_plan,
        ...(receipt.artifacts.lyric_script ? { lyric_script: receipt.artifacts.lyric_script } : {}),
      } : {}),
    },
    lyric_delivery: receipt.lyric_delivery,
    ...(receipt.lyric_contract ? { lyric_contract: receipt.lyric_contract } : {}),
  };
  assertValid("active delivery", active, "active-delivery.schema.json");
  return active;
}

function artifactHashes(
  projectDir: string,
  approvalIntentPath: string,
  paths: GenerationPaths,
): Record<string, ActiveDeliveryArtifact> {
  return {
    approval_intent: artifact(projectDir, approvalIntentPath),
    caption_ass: artifact(projectDir, paths.ass),
    caption_srt: artifact(projectDir, paths.srt),
    final_video: artifact(projectDir, paths.finalVideo, true),
    qa_report: artifact(projectDir, paths.qa),
    package_manifest: artifact(projectDir, paths.manifest),
    preview: artifact(projectDir, paths.preview, true),
    preview_receipt: artifact(projectDir, paths.previewReceipt),
    ...(paths.fontManifest && paths.fontPrimary && paths.fontAssBold && paths.fontAssHeavy ? {
      font_manifest: artifact(projectDir, paths.fontManifest),
      font_primary: artifact(projectDir, paths.fontPrimary),
      font_ass_bold: artifact(projectDir, paths.fontAssBold),
      font_ass_heavy: artifact(projectDir, paths.fontAssHeavy),
    } : {}),
    ...(paths.suppliedFinalProvenance ? {
      supplied_final_provenance: artifact(projectDir, paths.suppliedFinalProvenance),
    } : {}),
    ...(paths.lyricsAss && paths.lyricPlan ? {
      lyrics_ass: artifact(projectDir, paths.lyricsAss),
      lyric_plan: artifact(projectDir, paths.lyricPlan),
      ...(paths.lyricScript ? { lyric_script: artifact(projectDir, paths.lyricScript) } : {}),
    } : {}),
  };
}

function artifact(
  projectDir: string,
  filePath: string,
  includeFileIdentity = false,
): ActiveDeliveryArtifact {
  return {
    path: projectRelative(projectDir, filePath),
    sha256: computeSha256(filePath),
    ...(includeFileIdentity ? fileIdentity(filePath) : {}),
  };
}

function fileIdentity(filePath: string): Pick<ActiveDeliveryArtifact, "size_bytes" | "mtime_ms"> {
  const stat = fs.statSync(filePath);
  return { size_bytes: stat.size, mtime_ms: Math.round(stat.mtimeMs) };
}

function generationPaths(
  generationDir: string,
  stagedFont?: StagedBundledFontPaths,
): GenerationPaths {
  const suppliedFinalProvenance = path.join(
    generationDir,
    "staging",
    "supplied-final-provenance.json",
  );
  const discovered = stagedFont ? {
    manifest: stagedFont.manifestPath,
    primary: stagedFont.fontPath,
    assBold: stagedFont.assBoldFontPath,
    assHeavy: stagedFont.assHeavyFontPath,
  } : resolveStagedFontManifestPaths(generationDir);
  return {
    ass: path.join(generationDir, "captions", "speech.ass"),
    srt: path.join(generationDir, "captions", "speech.approved.srt"),
    finalVideo: path.join(generationDir, "video", "final.mp4"),
    qa: path.join(generationDir, "qa-report.json"),
    manifest: path.join(generationDir, "package_manifest.json"),
    preview: path.join(generationDir, "preview", "final.mp4"),
    previewReceipt: path.join(generationDir, "preview", "receipt.json"),
    receipt: path.join(generationDir, "caption-finalize-receipt.json"),
    fontManifest: discovered?.manifest,
    fontPrimary: discovered?.primary,
    fontAssBold: discovered?.assBold,
    fontAssHeavy: discovered?.assHeavy,
    suppliedFinalProvenance: fs.existsSync(suppliedFinalProvenance)
      ? suppliedFinalProvenance
      : undefined,
    // Lyric delivery artifacts (present only in lyric generations).
    lyricsAss: fs.existsSync(path.join(generationDir, "captions", "lyrics.ass"))
      ? path.join(generationDir, "captions", "lyrics.ass")
      : undefined,
    lyricPlan: fs.existsSync(path.join(generationDir, "captions", "lyric-typography-plan.json"))
      ? path.join(generationDir, "captions", "lyric-typography-plan.json")
      : undefined,
    lyricScript: fs.existsSync(path.join(generationDir, "captions", "lyrics.lrc"))
      ? path.join(generationDir, "captions", "lyrics.lrc")
      : undefined,
  };
}

function fontContractFromPaths(projectDir: string, paths: GenerationPaths): CaptionFontContract {
  if (!paths.fontManifest || !paths.fontPrimary || !paths.fontAssBold || !paths.fontAssHeavy) {
    throw new Error("caption-finalize staged font paths are missing");
  }
  const manifest = readJson<{
    version: string;
    font_id: string;
    family: string;
    selected_family?: string;
    selected_asset?: {
      role: "primary" | "ass_bold" | "ass_heavy";
      family: string;
      path: string;
      sha256: string;
      weight: number;
    };
    fallback_used: boolean;
    assets: Array<{ role: string; path: string; sha256: string; family?: string }>;
  }>(paths.fontManifest, "font staging manifest");
  const primary = manifest.assets.find((asset) => asset.role === "primary");
  const bold = manifest.assets.find((asset) => asset.role === "ass_bold");
  const heavy = manifest.assets.find((asset) => asset.role === "ass_heavy");
  const selected = manifest.selected_asset;
  const selectedEntry = selected && manifest.assets.find((asset) => asset.role === selected.role);
  const selectedPath = selected?.role === "ass_bold"
    ? paths.fontAssBold
    : selected?.role === "ass_heavy"
      ? paths.fontAssHeavy
      : paths.fontPrimary;
  if (
    manifest.version !== "font-staging-manifest/v3"
    || !primary
    || !bold
    || !heavy
    || !selected
    || !selectedEntry
    || !manifest.selected_family
    || manifest.fallback_used
    || selected.family !== manifest.selected_family
    || selected.path !== selectedEntry.path
    || selected.sha256 !== selectedEntry.sha256
    || computeSha256(paths.fontPrimary) !== primary.sha256
    || computeSha256(paths.fontAssBold) !== bold.sha256
    || computeSha256(paths.fontAssHeavy) !== heavy.sha256
    || computeSha256(selectedPath) !== selected.sha256
  ) {
    throw new Error("caption-finalize font contract is incomplete, stale, or uses fallback");
  }
  return {
    status: "ready",
    font_id: manifest.font_id,
    family: manifest.selected_family,
    fallback_used: false,
    primary: { path: projectRelative(projectDir, paths.fontPrimary), sha256: primary.sha256 },
    ass_bold: {
      family: bold.family ?? "VideoOS Noto Sans JP Bold",
      path: projectRelative(projectDir, paths.fontAssBold),
      sha256: bold.sha256,
    },
    ass_heavy: {
      family: heavy.family ?? "VideoOS Noto Sans JP Black",
      path: projectRelative(projectDir, paths.fontAssHeavy),
      sha256: heavy.sha256,
    },
    selected_family: manifest.selected_family,
    selected_asset: {
      role: selected.role,
      family: selected.family,
      path: projectRelative(projectDir, selectedPath),
      sha256: selected.sha256,
      weight: selected.weight,
    },
    diagnostics: [],
  };
}

export function resolveStagedFontManifestPaths(generationDir: string): {
  manifest: string;
  primary: string;
  assBold: string;
  assHeavy: string;
} | undefined {
  const manifest = path.join(generationDir, "font-manifest.json");
  if (!fs.existsSync(manifest)) return undefined;
  const value = readJson<{ assets?: Array<{ role?: string; path?: string }> }>(manifest, "font staging manifest");
  const primary = value.assets?.find((asset) => asset.role === "primary")?.path;
  const assBold = value.assets?.find((asset) => asset.role === "ass_bold")?.path;
  const assHeavy = value.assets?.find((asset) => asset.role === "ass_heavy")?.path;
  if (!primary || !assBold || !assHeavy) return undefined;
  return {
    manifest,
    primary: safeGenerationAssetPath(generationDir, primary),
    assBold: safeGenerationAssetPath(generationDir, assBold),
    assHeavy: safeGenerationAssetPath(generationDir, assHeavy),
  };
}

function safeGenerationAssetPath(generationDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("font manifest asset path must be relative");
  const resolved = path.resolve(generationDir, relativePath);
  const root = `${path.resolve(generationDir)}${path.sep}`;
  if (!resolved.startsWith(root)) throw new Error("font manifest asset escaped generation directory");
  return resolved;
}

function persistImmutableIntent(sourcePath: string, intentPath: string, expectedHash: string): void {
  if (fs.existsSync(intentPath)) {
    if (computeSha256(intentPath) !== expectedHash) {
      throw new Error(`immutable caption approval intent hash mismatch: ${intentPath}`);
    }
    return;
  }
  const tempPath = `${intentPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.copyFileSync(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
  if (computeSha256(tempPath) !== expectedHash) {
    fs.rmSync(tempPath, { force: true });
    throw new Error("caption approval intent copy hash mismatch");
  }
  fs.chmodSync(tempPath, 0o444);
  try {
    fs.linkSync(tempPath, intentPath);
  } catch (error) {
    if (!fs.existsSync(intentPath) || computeSha256(intentPath) !== expectedHash) throw error;
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  fs.chmodSync(intentPath, 0o444);
}

function acquireLock(lockDir: string): void {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`caption-finalize generation is already running: ${path.basename(lockDir, ".lock")}`);
    }
    throw error;
  }
}

function activePointerMayReferenceGeneration(projectDir: string, generationId: string): boolean {
  const pointerPath = activeDeliveryPath(projectDir);
  if (!fs.existsSync(pointerPath)) return false;
  try {
    const pointer = parseJsonRejectDuplicateKeys<{
      generation_id?: unknown;
      generation_path?: unknown;
    }>(fs.readFileSync(pointerPath, "utf8"), pointerPath);
    if (typeof pointer.generation_id !== "string" || typeof pointer.generation_path !== "string") {
      return true;
    }
    return pointer.generation_id === generationId
      || pointer.generation_path === `${CAPTION_FINALIZE_ROOT_RELATIVE_PATH}/generations/${generationId}`;
  } catch {
    return true;
  }
}

function atomicActivate(pointerPath: string, active: ActiveDelivery): void {
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  const tempPath = `${pointerPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const contents = `${JSON.stringify(active, null, 2)}\n`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx", 0o644);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, pointerPath);
    const dirFd = fs.openSync(path.dirname(pointerPath), "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
  }
}

function readJson<T>(filePath: string, label: string): T {
  if (!fs.existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  try {
    return parseJsonRejectDuplicateKeys<T>(fs.readFileSync(filePath, "utf8"), label);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertValid(label: string, value: unknown, schema: string): void {
  const validation = validateAgainstSchema(value, schema);
  if (!validation.valid) throw new Error(`${label} schema validation failed: ${validation.errors.join("; ")}`);
}

function projectRelative(projectDir: string, filePath: string): string {
  const relative = path.relative(path.resolve(projectDir), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`caption-finalize artifact escaped project root: ${filePath}`);
  }
  return relative.split(path.sep).join("/");
}

export { ACTIVE_DELIVERY_RELATIVE_PATH };
