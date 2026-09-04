import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { validateArtifact } from "../artifacts/loaders.js";
import {
  getSfxAssetHoldReason,
  getSfxLibraryHoldReason,
  assertSfxAssetSelectable,
  assertSfxScopeAuthority,
  loadSfxLibraryManifest,
  type SfxLibraryAsset,
  type SfxLibraryScope,
  type SfxRightsStatus,
  type SfxReviewStatus,
} from "./sfx-library.js";
import { hashFile } from "./sfx-cues.js";

export type SfxPromotionStatus = "HOLD" | "validated" | "promoted";

export interface PromoteSfxAssetOptions {
  assetId: string;
  scope: SfxLibraryScope;
  sourcePath?: string;
  manifestPath?: string;
  destinationDir?: string;
  outputManifestPath?: string;
  projectDir?: string;
  repoRoot?: string;
  repoSfxRoot?: string;
  rightsStatus?: SfxRightsStatus;
  rightsEvidenceRef?: string | null;
  provenanceRef?: string | null;
  provenanceOrigin?: SfxLibraryAsset["provenance"]["origin"];
  reviewStatus?: SfxReviewStatus;
  usageScope?: SfxLibraryAsset["rights"]["usage_scope"];
  permittedDerivatives?: string[];
  verifiedAt?: string;
  semanticRoles?: SfxLibraryAsset["semantic_roles"];
  category?: string;
  semanticIntent?: string;
  validateOnly?: boolean;
  now?: Date;
}

export interface SfxPromotionResult {
  version: "sfx-promotion-result/v1";
  command: "sfx-promote";
  status: SfxPromotionStatus;
  scope: SfxLibraryScope;
  asset_id: string;
  wrote_files: boolean;
  reason: string;
  source_hash?: string;
  source_size_bytes?: number;
  manifest_path?: string;
  manifest_hash?: string;
  asset_path?: string;
  rights_status?: SfxRightsStatus;
  rights_evidence_ref?: string | null;
  provenance_ref?: string | null;
  media_validation: {
    performed: boolean;
    available: boolean;
    decode: "not_run" | "metadata_only" | "decoded" | "optional_tool_unavailable";
  };
}

function result(
  options: PromoteSfxAssetOptions,
  status: SfxPromotionStatus,
  reason: string,
  extra: Partial<SfxPromotionResult> = {},
): SfxPromotionResult {
  return {
    version: "sfx-promotion-result/v1",
    command: "sfx-promote",
    status,
    scope: options.scope,
    asset_id: options.assetId,
    wrote_files: false,
    reason,
    media_validation: {
      performed: false,
      available: false,
      decode: "not_run",
    },
    ...extra,
  };
}

function contained(root: string, child: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(".." + path.sep)
    && !path.isAbsolute(relative);
}

function assertSafeOutput(root: string, outputPath: string): void {
  const lexicalRoot = path.resolve(root);
  const resolvedRoot = fs.realpathSync(lexicalRoot);
  const resolvedOutput = path.resolve(outputPath);
  if (!contained(lexicalRoot, resolvedOutput)) {
    throw new Error("promotion output must be contained by the selected scope root");
  }
  if (fs.existsSync(resolvedOutput)) {
    throw new Error("promotion output already exists; refusing to overwrite: " + resolvedOutput);
  }
  let ancestor = path.dirname(resolvedOutput);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = fs.realpathSync(ancestor);
  const ancestorRelative = path.relative(resolvedRoot, realAncestor);
  if (
    ancestorRelative === ".."
    || ancestorRelative.startsWith(".." + path.sep)
    || path.isAbsolute(ancestorRelative)
  ) {
    throw new Error("promotion output resolves through a symlink outside the selected scope root");
  }
}

function scopeRoot(options: PromoteSfxAssetOptions): string {
  if (options.scope === "project_local") {
    if (!options.projectDir) throw new Error("project_local requires --project");
    return path.resolve(options.projectDir);
  }
  if (!options.repoSfxRoot) throw new Error("repo_common requires an explicit repo SFX root");
  return path.resolve(options.repoSfxRoot);
}

function defaultDestination(options: PromoteSfxAssetOptions): string {
  return options.destinationDir
    ? path.resolve(options.destinationDir)
    : options.scope === "project_local"
      ? path.join(scopeRoot(options), "07_package", "sfx")
      : path.join(scopeRoot(options), "resources", "sfx");
}

function defaultManifestPath(options: PromoteSfxAssetOptions, assetId: string): string {
  return options.outputManifestPath
    ? path.resolve(options.outputManifestPath)
    : path.join(defaultDestination(options), "sfx-library-" + assetId + ".json");
}

function sourceExtension(sourcePath: string): string {
  const extension = path.extname(sourcePath).toLowerCase();
  return /^[.][a-z0-9]{1,8}$/u.test(extension) ? extension : ".audio";
}

function ensureDirectory(directory: string, created: string[]): void {
  const missing: string[] = [];
  let current = path.resolve(directory);
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const item of missing.reverse()) {
    fs.mkdirSync(item);
    created.push(item);
  }
}

function removeEmptyDirectories(directories: string[]): void {
  for (const directory of [...directories].reverse()) {
    try {
      if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    } catch {
      // Cleanup is best effort; never remove a non-empty or pre-existing directory.
    }
  }
}

function validRightsForPromotion(
  options: PromoteSfxAssetOptions,
): { status: SfxRightsStatus; evidence: string; provenance: string } | { hold: string } {
  const status = options.rightsStatus ?? "unknown";
  if (status !== "cleared" && status !== "confirmed") {
    return { hold: "rights_status_" + status };
  }
  const evidence = options.rightsEvidenceRef?.trim();
  if (!evidence) return { hold: "rights_evidence_missing" };
  const provenance = options.provenanceRef?.trim();
  if (!provenance) return { hold: "provenance_missing" };
  if (!options.verifiedAt || !Number.isFinite(Date.parse(options.verifiedAt))) {
    return { hold: "rights_verified_at_missing_or_invalid" };
  }
  const derivatives = options.permittedDerivatives ?? [];
  if (!derivatives.includes("project_render")) return { hold: "permitted_derivatives_missing" };
  const usage = Array.isArray(options.usageScope)
    ? options.usageScope
    : [options.usageScope ?? "project_render"];
  if (!usage.some((scope) => scope === "project_render" || scope === "commercial" || scope === "public_release")) {
    return { hold: "usage_scope_internal_audition_only" };
  }
  const origin = options.provenanceOrigin;
  if (!origin) return { hold: "provenance_origin_missing" };
  if (![
    "existing_generated_local",
    "deterministic_synthesis",
    "recorded_local",
    "licensed_local",
  ].includes(origin)) {
    return { hold: "provenance_origin_unknown" };
  }
  if (options.reviewStatus !== "approved") return { hold: "review_status_not_approved" };
  return { status, evidence, provenance };
}

function loadExistingAsset(
  options: PromoteSfxAssetOptions,
): { asset: SfxLibraryAsset; manifestPath: string } | SfxPromotionResult | undefined {
  if (!options.manifestPath) return undefined;
  const loaded = loadSfxLibraryManifest(options.manifestPath, { verifyAssets: true });
  const asset = loaded.manifest.assets.find((candidate) => candidate.asset_id === options.assetId);
  if (!asset) {
    return result(options, "HOLD", "asset_not_found_in_manifest", {
      manifest_path: loaded.manifest_path,
    });
  }
  return { asset, manifestPath: loaded.manifest_path };
}

export function promoteSfxAsset(
  options: PromoteSfxAssetOptions,
): SfxPromotionResult {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(options.assetId)) {
    return result(options, "HOLD", "invalid_asset_id");
  }
  const existing = loadExistingAsset(options);
  if (existing && "status" in existing) return existing;

  if (existing) {
    const loaded = loadSfxLibraryManifest(existing.manifestPath, { verifyAssets: false });
    const libraryHold = getSfxLibraryHoldReason(loaded.manifest);
    if (libraryHold) {
      return result(options, "HOLD", libraryHold, {
        manifest_path: existing.manifestPath,
        manifest_hash: loaded.manifest_hash,
        rights_status: existing.asset.rights.status,
        rights_evidence_ref: existing.asset.rights.evidence_ref,
        provenance_ref: existing.asset.provenance.source_ref,
      });
    }
    try {
      assertSfxScopeAuthority(loaded, options.scope, {
        ...(options.scope === "project_local"
          ? { projectRoot: options.projectDir }
          : { repoSfxRoot: options.repoSfxRoot }),
      });
      assertSfxAssetSelectable(existing.asset, options.now ?? new Date(), "promotion");
    } catch (error) {
      return result(options, "HOLD", error instanceof Error ? error.message : String(error), {
        manifest_path: existing.manifestPath,
        manifest_hash: loaded.manifest_hash,
      });
    }
    const holdReason = getSfxAssetHoldReason(existing.asset, options.now ?? new Date());
    if (holdReason) {
      return result(options, "HOLD", holdReason, {
        manifest_path: existing.manifestPath,
        manifest_hash: loaded.manifest_hash,
        rights_status: existing.asset.rights.status,
        rights_evidence_ref: existing.asset.rights.evidence_ref,
        provenance_ref: existing.asset.provenance.source_ref,
        media_validation: {
          performed: false,
          available: false,
          decode: "metadata_only",
        },
      });
    }
    return result(options, options.validateOnly ? "validated" : "HOLD",
      options.validateOnly ? "existing_manifest_validated_without_media" : "output_required_for_promotion", {
        manifest_path: existing.manifestPath,
        manifest_hash: loaded.manifest_hash,
        rights_status: existing.asset.rights.status,
        rights_evidence_ref: existing.asset.rights.evidence_ref,
        provenance_ref: existing.asset.provenance.source_ref,
        media_validation: {
          performed: false,
          available: false,
          decode: "metadata_only",
        },
      });
  }

  const rights = validRightsForPromotion(options);
  if ("hold" in rights) {
    return result(options, "HOLD", rights.hold, {
      rights_status: options.rightsStatus ?? "unknown",
      rights_evidence_ref: options.rightsEvidenceRef ?? null,
      provenance_ref: options.provenanceRef ?? null,
    });
  }

  if (!options.sourcePath) {
    return result(options, "HOLD", "source_missing_for_validation_or_promotion", {
      rights_status: rights.status,
      rights_evidence_ref: rights.evidence,
      provenance_ref: rights.provenance,
    });
  }
  const sourcePath = path.resolve(options.sourcePath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    return result(options, "HOLD", "authorized_source_missing", {
      rights_status: rights.status,
      rights_evidence_ref: rights.evidence,
      provenance_ref: rights.provenance,
    });
  }
  const sourceHash = hashFile(sourcePath);
  const sourceSize = fs.statSync(sourcePath).size;
  let durationUs: number;
  let sampleRateHz: number;
  let channels: number;
  try {
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-show_format", "-show_streams", "-print_format", "json", sourcePath,
    ], { encoding: "utf8" })) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; sample_rate?: string; channels?: number; duration?: string }>;
    };
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    durationUs = Math.round(Number(probe.format?.duration ?? audio?.duration ?? "NaN") * 1_000_000);
    sampleRateHz = Number(audio?.sample_rate ?? "NaN");
    channels = Number(audio?.channels ?? "NaN");
    if (!Number.isFinite(durationUs) || durationUs <= 0 || !Number.isInteger(sampleRateHz) || sampleRateHz <= 0
      || !Number.isInteger(channels) || channels <= 0) throw new Error("decode_metadata_incomplete");
  } catch (error) {
    return result(options, "HOLD", "media_decode_or_measurement_unavailable: " + (error instanceof Error ? error.message : String(error)), {
      source_hash: sourceHash,
      source_size_bytes: sourceSize,
      rights_status: rights.status,
      rights_evidence_ref: rights.evidence,
      provenance_ref: rights.provenance,
      media_validation: { performed: true, available: false, decode: "optional_tool_unavailable" },
    });
  }
  try {
    execFileSync("ffmpeg", [
      "-v", "error", "-xerror", "-i", sourcePath, "-map", "0:a:0", "-f", "null", "-",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return result(options, "HOLD", "media_full_decode_unavailable: " + (error instanceof Error ? error.message : String(error)), {
      source_hash: sourceHash,
      source_size_bytes: sourceSize,
      rights_status: rights.status,
      rights_evidence_ref: rights.evidence,
      provenance_ref: rights.provenance,
      media_validation: { performed: true, available: false, decode: "optional_tool_unavailable" },
    });
  }
  const mediaValidation = { performed: true, available: true, decode: "decoded" as const };
  if (options.validateOnly) {
    return result(options, "validated", "source_and_rights_validated_without_writes", {
      source_hash: sourceHash,
      source_size_bytes: sourceSize,
      rights_status: rights.status,
      rights_evidence_ref: rights.evidence,
      provenance_ref: rights.provenance,
      media_validation: mediaValidation,
    });
  }

  let root: string;
  try {
    root = scopeRoot(options);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return result(options, "HOLD", "scope_authority_root_missing", {
        source_hash: sourceHash,
        source_size_bytes: sourceSize,
        rights_status: rights.status,
        rights_evidence_ref: rights.evidence,
        provenance_ref: rights.provenance,
        media_validation: mediaValidation,
      });
    }
  } catch (error) {
    return result(options, "HOLD", "scope_authority_invalid: " + (error instanceof Error ? error.message : String(error)), {
      source_hash: sourceHash,
      source_size_bytes: sourceSize,
      rights_status: rights.status,
      rights_evidence_ref: rights.evidence,
      provenance_ref: rights.provenance,
      media_validation: mediaValidation,
    });
  }
  const destinationDir = defaultDestination(options);
  const outputManifestPath = defaultManifestPath(options, options.assetId);
  const outputAssetPath = path.join(
    destinationDir,
    "assets",
    options.assetId + sourceExtension(sourcePath),
  );
  const manifest: SfxLibraryManifestForPromotion = {
    version: "sfx-library/v1",
    library_id: options.scope === "project_local" ? "project-local-sfx" : "repository-common-sfx",
    library_version: "1.0.0",
    scope: options.scope,
    review_status: "approved",
    assets: [{
      asset_id: options.assetId,
      semantic_roles: options.semanticRoles ?? ["simple_sound"],
      path: path.relative(path.dirname(outputManifestPath), outputAssetPath).split(path.sep).join("/"),
      content_hash: sourceHash,
      size_bytes: sourceSize,
      duration_us: durationUs,
      format: sourceExtension(sourcePath).slice(1),
      sample_rate_hz: sampleRateHz,
      channels,
      decode_status: "decoded",
      ...(options.category ? { category: options.category } : {}),
      ...(options.semanticIntent ? { semantic_intent: options.semanticIntent } : {}),
      rights: {
        status: rights.status,
        basis: "operator_declared",
        usage_scope: options.usageScope ?? "project_render",
        evidence_ref: rights.evidence,
        verified_at: options.verifiedAt,
        permitted_derivatives: options.permittedDerivatives,
      },
      provenance: {
        origin: options.provenanceOrigin!,
        source_ref: rights.provenance,
        evidence_ref: rights.provenance,
        generated_at: null,
        status: "verified",
      },
      review_status: "approved",
    }],
  };
  let stageRoot: string | undefined;
  let assetPlaced = false;
  let manifestPlaced = false;
  const createdDirectories: string[] = [];
  try {
    assertSafeOutput(root, outputManifestPath);
    assertSafeOutput(root, outputAssetPath);
    if (
      path.resolve(outputManifestPath) === path.resolve(outputAssetPath)
      || path.resolve(outputManifestPath) === path.resolve(sourcePath)
      || path.resolve(outputAssetPath) === path.resolve(sourcePath)
    ) {
      throw new Error("promotion output collides with the source or another output");
    }
    const validated = validateArtifact<SfxLibraryManifestForPromotion>(manifest, "sfx-library.schema.json");
    assertSfxAssetSelectable(validated.assets[0], options.now ?? new Date(), "promotion");
    ensureDirectory(path.dirname(outputAssetPath), createdDirectories);
    ensureDirectory(path.dirname(outputManifestPath), createdDirectories);
    stageRoot = fs.mkdtempSync(path.join(path.dirname(outputAssetPath), ".sfx-promotion-"));
    const stagedAsset = path.join(stageRoot, "asset" + sourceExtension(sourcePath));
    const stagedManifest = path.join(stageRoot, "manifest.json");
    fs.copyFileSync(sourcePath, stagedAsset, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(stagedManifest, JSON.stringify(validated, null, 2) + "\n", { flag: "wx" });
    fs.linkSync(stagedAsset, outputAssetPath);
    assetPlaced = true;
    fs.linkSync(stagedManifest, outputManifestPath);
    manifestPlaced = true;
    if (hashFile(outputAssetPath) !== sourceHash || fs.statSync(outputAssetPath).size !== sourceSize) {
      throw new Error("post-write media hash verification failed");
    }
    fs.rmSync(stageRoot, { recursive: true, force: true });
  } catch (error) {
    if (assetPlaced) fs.rmSync(outputAssetPath, { force: true });
    if (manifestPlaced) fs.rmSync(outputManifestPath, { force: true });
    if (stageRoot) fs.rmSync(stageRoot, { recursive: true, force: true });
    removeEmptyDirectories(createdDirectories);
    return result(options, "HOLD", "promotion_validation_or_write_failed: " + (error instanceof Error ? error.message : String(error)), {
      source_hash: sourceHash,
      source_size_bytes: sourceSize,
      rights_status: rights.status,
      rights_evidence_ref: rights.evidence,
      provenance_ref: rights.provenance,
      media_validation: mediaValidation,
    });
  }
  return result(options, "promoted", "source_promoted_with_hash_pinned_manifest", {
    wrote_files: true,
    source_hash: sourceHash,
    source_size_bytes: sourceSize,
    manifest_path: outputManifestPath,
    manifest_hash: hashFile(outputManifestPath),
    asset_path: outputAssetPath,
    rights_status: rights.status,
    rights_evidence_ref: rights.evidence,
    provenance_ref: rights.provenance,
    media_validation: mediaValidation,
  });
}

interface SfxLibraryManifestForPromotion {
  version: "sfx-library/v1";
  library_id: string;
  library_version: string;
  scope: SfxLibraryScope;
  review_status: "approved";
  assets: SfxLibraryAsset[];
}
