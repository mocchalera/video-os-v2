import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { materializeFileSync } from "../filesystem/materialize-file.js";
import { computeVideoStreamHash } from "../media/video-stream-hash.js";
import type { CaptionApproval } from "./approval.js";
import { writeApprovedCaptionDeliveryArtifacts } from "./delivery-artifacts.js";
import { packageCommand, type PackageCommandOptions } from "../commands/package.js";
import { validateAgainstSchema } from "../commands/shared.js";
import {
  ACTIVE_DELIVERY_RELATIVE_PATH,
  CAPTION_FINALIZE_ROOT_RELATIVE_PATH,
  activeDeliveryPath,
  readActiveDelivery,
  type ActiveDelivery,
  type ActiveDeliveryArtifact,
} from "../packaging/active-delivery.js";
import { computeSha256 } from "../packaging/manifest.js";
import {
  verifyPackageGeneration,
  type PackageVerificationPaths,
  type PackageVerificationResult,
} from "../packaging/package-verification.js";
import { createSourceInputAttestation } from "../render/source-input-attestation.js";
import { stageDirectRenderOutput } from "../render/direct-render-staging.js";
import { stageBundledFontAssets, type StagedBundledFontPaths } from "../fonts/bundled-font.js";
import { resolveCaptionStylePreset } from "../../editor/shared/caption-style-tokens.js";
import type { CaptionFontContract } from "./font-contract.js";
import { inspectCaptionFontContract } from "./font-contract.js";
import { assertCaptionApprovalCurrent } from "./review-service.js";
import { assertFinalRenderApprovalCurrent } from "../packaging/final-render-approval.js";

export const CAPTION_FINALIZE_CONTRACT_VERSION = "v4" as const;

export interface CaptionFinalizeOptions {
  approvalPath?: string;
  suppliedFinalPath?: string;
  suppliedFinalReceiptPath?: string;
  createdAt?: string;
  packageOptions?: Pick<
    PackageCommandOptions,
    "assemblyPath" | "assemblyEngine" | "renderRouteDecision" | "skipRender" | "precomputedMetrics"
  >;
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
  videoStreamHasher?: (filePath: string) => string;
}

export type CaptionFinalizeStageRunner = (context: CaptionFinalizeStageContext) => Promise<void>;

export interface CaptionFinalizePreflightResult {
  version: string;
  decision: string;
  issues: string[];
}

export interface CaptionFinalizeDependencies {
  stageRunner?: CaptionFinalizeStageRunner;
  packageVerifier?: (
    projectDir: string,
    paths: PackageVerificationPaths,
  ) => PackageVerificationResult;
  packagePreflight?: (
    projectDir: string,
    paths: { captionApprovalPath: string; qaReportPath: string; packageManifestPath: string },
  ) => CaptionFinalizePreflightResult | Promise<CaptionFinalizePreflightResult>;
  activate?: (pointerPath: string, active: ActiveDelivery) => void;
  videoStreamHasher?: (filePath: string) => string;
}

export interface CaptionFinalizeReceipt {
  version:
    | "caption-finalize-receipt/v1"
    | "caption-finalize-receipt/v2"
    | "caption-finalize-receipt/v3"
    | "caption-finalize-receipt/v4";
  project_id: string;
  generation_id: string;
  generation_key: string;
  approval_sha256: string;
  timeline_sha256: string;
  final_render_approval_sha256?: string;
  created_at: string;
  font_contract?: CaptionFontContract;
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

export async function runCaptionFinalize(
  projectDir: string,
  options: CaptionFinalizeOptions = {},
  dependencies: CaptionFinalizeDependencies = {},
): Promise<CaptionFinalizeResult> {
  const absProject = path.resolve(projectDir);
  assertSuppliedFinalOptions(options);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const timelinePath = path.join(absProject, "05_timeline", "timeline.json");
  const approvalSourcePath = path.resolve(
    options.approvalPath ?? path.join(absProject, "07_package", "caption_approval.json"),
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
  const generationKey = computeGenerationKey(absProject, {
    approvalSha256,
    timelineSha256,
    finalRenderApprovalSha256: finalRenderApproval.sha256,
    suppliedFinalPath: options.suppliedFinalPath,
    suppliedFinalReceiptPath: options.suppliedFinalReceiptPath,
    fontPrimarySha256: verifiedFont.primary.sha256,
    fontAssBoldSha256: verifiedFont.ass_bold.sha256,
    fontAssHeavySha256: verifiedFont.ass_heavy.sha256,
    fontSelectedFamily: verifiedFont.selected_family,
    fontSelectedRole: verifiedFont.selected_asset.role,
    fontSelectedSha256: verifiedFont.selected_asset.sha256,
  });
  const generationId = generationKey.slice("sha256:".length, "sha256:".length + 24);
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
      dependencies,
    });
    if (existing) {
      const active = buildActiveDelivery(absProject, existing, approvalIntentPath, createdAt);
      const current = readActiveDelivery(absProject, { verifyHashes: true });
      if (current?.generation_id !== generationId) {
        (dependencies.activate ?? atomicActivate)(activeDeliveryPath(absProject), active);
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
    await (dependencies.stageRunner ?? defaultCaptionFinalizeStageRunner)({
      projectDir: absProject,
      generationDir,
      generationId,
      approvalIntentPath,
      approval,
      timeline,
      createdAt,
      options,
      stagedFont,
      videoStreamHasher: dependencies.videoStreamHasher,
    });
    writePreviewArtifacts(generationDir, createdAt, approvalSha256, timelineSha256, stagedFont);

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
      dependencies,
      stagedFont,
    });
    const active = buildActiveDelivery(absProject, receipt, approvalIntentPath, createdAt);
    (dependencies.activate ?? atomicActivate)(activeDeliveryPath(absProject), active);
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
  );

  let suppliedFinalPath: string | undefined;
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
    const staged = stageDirectRenderOutput(
      context.options.suppliedFinalPath,
      context.generationDir,
      context.createdAt,
    );
    assertValid(
      "direct render staging receipt",
      staged.receipt,
      "direct-render-staging-receipt.schema.json",
    );
    suppliedFinalPath = staged.stagedPath;
  }
  const result = await packageCommand(context.projectDir, {
    ...context.options.packageOptions,
    ...(suppliedFinalPath ? { suppliedFinalPath } : {}),
    createdAt: context.createdAt,
    commandName: "caption-finalize",
    actorName: "caption-finalize",
    allowedStates: ["approved", "packaged"],
    deliveryOutputDir: context.generationDir,
    captionApprovalPath: context.approvalIntentPath,
    captionFontsDir: context.stagedFont.fontsDir,
    deferActivation: true,
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
  dependencies: CaptionFinalizeDependencies;
  stagedFont: StagedBundledFontPaths;
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
  const packageVerification = (input.dependencies.packageVerifier ?? verifyPackageGeneration)(
    input.projectDir,
    verificationPaths,
  );
  if (!packageVerification.ready) {
    throw new Error(`caption-finalize package verification failed: ${packageVerification.issues.join("; ")}`);
  }
  const preflight = await (input.dependencies.packagePreflight ?? defaultPackagePreflight)(
    input.projectDir,
    {
      captionApprovalPath: input.approvalIntentPath,
      qaReportPath: paths.qa,
      packageManifestPath: paths.manifest,
    },
  );
  if (preflight.version !== "package-preflight/v2" || preflight.decision !== "ready_to_run") {
    throw new Error(
      `caption-finalize package-preflight/v2 failed: version=${preflight.version} decision=${preflight.decision} ${preflight.issues.join("; ")}`,
    );
  }

  const artifacts = artifactHashes(input.projectDir, input.approvalIntentPath, paths);
  const receipt: CaptionFinalizeReceipt = {
    version: "caption-finalize-receipt/v4",
    project_id: input.projectId,
    generation_id: input.generationId,
    generation_key: input.generationKey,
    approval_sha256: input.approvalSha256,
    timeline_sha256: input.timelineSha256,
    final_render_approval_sha256: input.finalRenderApprovalSha256,
    created_at: input.createdAt,
    font_contract: fontContractFromPaths(input.projectDir, paths),
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
  dependencies: CaptionFinalizeDependencies;
}): Promise<CaptionFinalizeReceipt | null> {
  const paths = generationPaths(input.generationDir);
  if (!fs.existsSync(paths.receipt)) return null;
  try {
    const receipt = readJson<CaptionFinalizeReceipt>(paths.receipt, "caption-finalize receipt");
    assertValid("caption-finalize receipt", receipt, "caption-finalize-receipt.schema.json");
    if (
      receipt.version !== "caption-finalize-receipt/v4"
      || receipt.generation_key !== input.generationKey
      || receipt.approval_sha256 !== input.approvalSha256
      || receipt.timeline_sha256 !== input.timelineSha256
      || receipt.final_render_approval_sha256 !== input.finalRenderApprovalSha256
    ) return null;
    const stagedFont = fontContractFromPaths(input.projectDir, paths);
    if (
      !isDeepStrictEqual(receipt.font_contract, stagedFont)
      || !fontContractMatchesCurrent(stagedFont, input.verifiedFont)
    ) return null;
    for (const artifact of Object.values(receipt.artifacts)) {
      const filePath = path.resolve(input.projectDir, artifact.path);
      if (!fs.existsSync(filePath) || computeSha256(filePath) !== artifact.sha256) return null;
    }
    const verified = await verifyAndReadExisting(input.projectDir, input.generationDir, input.approvalIntentPath, input.dependencies);
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
  if (hasFinal !== hasReceipt) {
    throw new Error(
      "--supplied-final and --supplied-final-receipt must be provided together",
    );
  }
}

function verifySuppliedFinalProvenance(
  context: CaptionFinalizeStageContext,
): SuppliedFinalProvenanceReceipt {
  const suppliedFinalPath = context.options.suppliedFinalPath;
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
  if (
    (
      sourceReceipt.version !== "caption-finalize-receipt/v3"
      && sourceReceipt.version !== "caption-finalize-receipt/v4"
    )
    || sourceReceipt.verification.qa_passed !== true
    || sourceReceipt.verification.package_ready !== true
    || sourceReceipt.verification.package_preflight_decision !== "ready_to_run"
  ) {
    throw new Error("supplied final receipt is not a verified v3/v4 generation");
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
  const hashVideoStream = context.videoStreamHasher ?? computeVideoStreamHash;
  const baseVideoStreamSha256 = hashVideoStream(sourceFinalPath);
  const suppliedVideoStreamSha256 = hashVideoStream(suppliedFinalPath);
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
  return resolved;
}

export { computeVideoStreamHash } from "../media/video-stream-hash.js";

async function verifyAndReadExisting(
  projectDir: string,
  generationDir: string,
  approvalIntentPath: string,
  dependencies: CaptionFinalizeDependencies,
): Promise<boolean> {
  const paths = generationPaths(generationDir);
  const verification = (dependencies.packageVerifier ?? verifyPackageGeneration)(projectDir, {
    qaReportPath: paths.qa,
    packageManifestPath: paths.manifest,
    finalVideoPath: paths.finalVideo,
    captionApprovalPath: approvalIntentPath,
    allowApprovedState: true,
  });
  if (!verification.ready) return false;
  const preflight = await (dependencies.packagePreflight ?? defaultPackagePreflight)(projectDir, {
    captionApprovalPath: approvalIntentPath,
    qaReportPath: paths.qa,
    packageManifestPath: paths.manifest,
  });
  return preflight.version === "package-preflight/v2" && preflight.decision === "ready_to_run";
}

async function defaultPackagePreflight(
  projectDir: string,
  paths: { captionApprovalPath: string; qaReportPath: string; packageManifestPath: string },
): Promise<CaptionFinalizePreflightResult> {
  const { buildPackagePreflight } = await import("../../scripts/package.js");
  return buildPackagePreflight(projectDir, {}, paths);
}

function writePreviewArtifacts(
  generationDir: string,
  createdAt: string,
  approvalSha256: string,
  timelineSha256: string,
  stagedFont: StagedBundledFontPaths,
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
    },
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

export function computeGenerationKey(
  projectDir: string,
  input: {
    approvalSha256: string;
    timelineSha256: string;
    finalRenderApprovalSha256: string;
    suppliedFinalPath?: string;
    suppliedFinalReceiptPath?: string;
    fontPrimarySha256: string;
    fontAssBoldSha256: string;
    fontAssHeavySha256: string;
    fontSelectedFamily: string;
    fontSelectedRole: "primary" | "ass_bold" | "ass_heavy";
    fontSelectedSha256: string;
  },
): string {
  let sourceInputsHash = "unavailable";
  try {
    sourceInputsHash = createSourceInputAttestation(projectDir).source_inputs_hash;
  } catch {
    // The package/preflight verifier remains authoritative. The timeline and
    // supplied final hash still make the retry key deterministic for fixtures.
  }
  const suppliedFinalSha256 = input.suppliedFinalPath && fs.existsSync(input.suppliedFinalPath)
    ? computeSha256(input.suppliedFinalPath)
    : "";
  const suppliedFinalReceiptSha256 = input.suppliedFinalReceiptPath
      && fs.existsSync(input.suppliedFinalReceiptPath)
    ? computeSha256(input.suppliedFinalReceiptPath)
    : "";
  const musicPath = path.join(projectDir, "07_package", "music_cues.json");
  const musicSha256 = fs.existsSync(musicPath) ? computeSha256(musicPath) : "";
  const digest = crypto.createHash("sha256").update(JSON.stringify({
    caption_finalize_contract: CAPTION_FINALIZE_CONTRACT_VERSION,
    approval: input.approvalSha256,
    timeline: input.timelineSha256,
    final_render_approval: input.finalRenderApprovalSha256,
    font_primary: input.fontPrimarySha256,
    font_ass_bold: input.fontAssBoldSha256,
    font_ass_heavy: input.fontAssHeavySha256,
    font_selected_family: input.fontSelectedFamily,
    font_selected_role: input.fontSelectedRole,
    font_selected: input.fontSelectedSha256,
    sourceInputsHash,
    suppliedFinalSha256,
    suppliedFinalReceiptSha256,
    musicSha256,
  })).digest("hex");
  return `sha256:${digest}`;
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
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as {
      generation_id?: unknown;
      generation_path?: unknown;
    };
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
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
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
