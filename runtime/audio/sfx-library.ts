import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { validateArtifact } from "../artifacts/loaders.js";

/** Repository-common and project-local SFX share one versioned contract. */
export type SfxLibraryScope = "repo_common" | "project_local";

export type SfxSemanticRole =
  | "hook_impact"
  | "transition_accent"
  | "claim_emphasis"
  | "achievement_reveal"
  | "simple_sound";

export type SfxRightsStatus =
  | "confirmed"
  | "cleared"
  | "unknown"
  | "expired"
  | "ambiguous"
  | "blocked"
  | "hold";

export type SfxRightsBasis =
  | "local_rights_confirmation"
  | "deterministic_synthesis"
  | "licensed"
  | "operator_declared"
  | "unknown";

export type SfxUsageScope =
  | "internal_audition"
  | "project_render"
  | "commercial"
  | "public_release";

export type SfxProvenanceStatus =
  | "verified"
  | "unknown"
  | "ambiguous"
  | "hold";

export type SfxReviewStatus =
  | "approved"
  | "pending"
  | "rejected"
  | "unreviewed"
  | "hold";

export interface SfxLibraryRights {
  status: SfxRightsStatus;
  basis: SfxRightsBasis;
  usage_scope: SfxUsageScope | SfxUsageScope[];
  evidence_ref: string | null;
  owner?: string | null;
  permitted_derivatives?: string[];
  verified_at?: string | null;
  expires_at?: string | null;
  status_reason?: string;
}

export interface SfxLibraryProvenance {
  origin:
    | "existing_generated_local"
    | "deterministic_synthesis"
    | "recorded_local"
    | "licensed_local"
    | "unknown";
  source_ref: string | null;
  generation_id?: string | null;
  generated_at: string | null;
  status?: SfxProvenanceStatus;
  owner?: string | null;
  acquisition_ref?: string | null;
  evidence_ref?: string | null;
}

export interface SfxLibraryAsset {
  asset_id: string;
  semantic_roles: SfxSemanticRole[];
  /** Safe path relative to the manifest, when a local media file exists. */
  path?: string;
  /** Non-file URI or source locator retained for provenance; never rendered directly. */
  source_uri?: string | null;
  content_hash: string | null;
  size_bytes: number | null;
  duration_us: number | null;
  format?: string | null;
  sample_rate_hz?: number | null;
  channels?: number | null;
  decode_status?: "decoded" | "unavailable" | "failed" | "unknown";
  category?: string;
  semantic_intent?: string;
  rights: SfxLibraryRights;
  provenance: SfxLibraryProvenance;
  review_status?: SfxReviewStatus;
  reviewer_ref?: string | null;
  reviewed_at?: string | null;
  supersedes?: string | null;
  superseded_by?: string | null;
}

export interface SfxLibraryManifest {
  version: "sfx-library/v1";
  library_id: string;
  library_version: string;
  scope?: SfxLibraryScope;
  owner?: string | null;
  source_uri?: string | null;
  created_at?: string | null;
  review_status?: SfxReviewStatus;
  superseded_by?: string | null;
  assets: SfxLibraryAsset[];
}

export interface LoadedSfxLibraryManifest {
  manifest_path: string;
  manifest_hash: string;
  library_root: string;
  manifest: SfxLibraryManifest;
}

export interface SfxResolvedAsset {
  asset: SfxLibraryAsset;
  manifest: LoadedSfxLibraryManifest;
  sourcePath?: string;
  precedence: {
    scope: SfxLibraryScope;
    priority: number;
    manifest_path: string;
  };
}

export interface SfxLibrarySearchRoot {
  path: string;
  scope: SfxLibraryScope;
  priority: number;
  label?: string;
}

export interface SfxLibraryRegistryOptions {
  projectDir?: string;
  repoRoot?: string;
  repoSfxRoot?: string;
  searchRoots?: SfxLibrarySearchRoot[];
  manifestPaths?: string[];
  manifestName?: string;
  now?: Date;
  verifyAssets?: boolean;
}

export interface SfxLibraryRegistry {
  version: "sfx-library-registry/v1";
  manifests: Array<LoadedSfxLibraryManifest & {
    scope: SfxLibraryScope;
    priority: number;
  }>;
  assets: Map<string, SfxResolvedAsset>;
}

export interface SfxAssetSelector {
  asset_id: string;
  scope?: SfxLibraryScope;
  library_id?: string;
  library_version?: string;
  manifest_path?: string;
  path?: string;
  content_hash?: string;
}

export type SfxLibraryErrorCode =
  | "SFX_LIBRARY_INVALID"
  | "SFX_LIBRARY_MISSING"
  | "SFX_LIBRARY_UNSAFE_PATH"
  | "SFX_LIBRARY_DRIFT"
  | "SFX_LIBRARY_AMBIGUOUS"
  | "SFX_ASSET_MISSING"
  | "SFX_ASSET_UNSELECTABLE"
  | "SFX_RIGHTS_HOLD";

export class SfxLibraryContractError extends Error {
  constructor(
    readonly code: SfxLibraryErrorCode,
    message: string,
  ) {
    super(code + ": " + message);
    this.name = "SfxLibraryContractError";
  }
}

function isContained(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(".." + path.sep)
      && !path.isAbsolute(relative)
    );
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return "sha256:" + hash.digest("hex");
}

function fail(code: SfxLibraryErrorCode, message: string): never {
  throw new SfxLibraryContractError(code, message);
}

function requiredFile(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail("SFX_LIBRARY_MISSING", label + " is missing: " + resolved);
  }
  return resolved;
}

function safeAssetPath(manifestPath: string, asset: SfxLibraryAsset): string {
  if (!asset.path || asset.path.trim().length === 0) {
    fail("SFX_ASSET_MISSING", "SFX asset " + asset.asset_id + " has no local path.");
  }
  if (
    path.isAbsolute(asset.path)
    || asset.path.includes("\\")
    || asset.path.split(/[\\/]/u).some((part) => part === ".." || part === ".")
    || /[\u0000-\u001F\u007F]/u.test(asset.path)
  ) {
    fail(
      "SFX_LIBRARY_UNSAFE_PATH",
      "SFX asset " + asset.asset_id + " path must be a safe relative path.",
    );
  }
  const root = fs.realpathSync(path.dirname(manifestPath));
  const candidate = path.resolve(root, asset.path);
  if (!isContained(root, candidate)) {
    fail(
      "SFX_LIBRARY_UNSAFE_PATH",
      "SFX asset " + asset.asset_id + " resolves outside the library root.",
    );
  }
  return candidate;
}

function verifyAssetFile(
  loaded: LoadedSfxLibraryManifest,
  asset: SfxLibraryAsset,
  options: { allowMissing?: boolean } = {},
): string | undefined {
  if (!asset.path) return undefined;
  const candidate = safeAssetPath(loaded.manifest_path, asset);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    if (options.allowMissing) return undefined;
    fail("SFX_ASSET_MISSING", "SFX asset " + asset.asset_id + " is missing: " + candidate);
  }
  const real = fs.realpathSync(candidate);
  if (!isContained(loaded.library_root, real)) {
    fail(
      "SFX_LIBRARY_UNSAFE_PATH",
      "SFX asset " + asset.asset_id + " resolves through a symlink outside the library root.",
    );
  }
  if (asset.content_hash !== null) {
    const actualHash = hashFile(real);
    if (asset.content_hash !== actualHash) {
      fail(
        "SFX_LIBRARY_DRIFT",
        asset.asset_id + ".content_hash expected=" + asset.content_hash + " actual=" + actualHash,
      );
    }
  }
  const size = fs.statSync(real).size;
  if (asset.size_bytes !== null && asset.size_bytes !== size) {
    fail(
      "SFX_LIBRARY_DRIFT",
      asset.asset_id + ".size_bytes expected=" + String(asset.size_bytes) + " actual=" + String(size),
    );
  }
  return real;
}

function assertUniqueAssetIds(manifest: SfxLibraryManifest): void {
  const ids = new Set<string>();
  for (const asset of manifest.assets) {
    if (ids.has(asset.asset_id)) {
      fail("SFX_LIBRARY_AMBIGUOUS", "duplicate asset_id in manifest: " + asset.asset_id);
    }
    ids.add(asset.asset_id);
  }
}

export function loadSfxLibraryManifest(
  manifestPath: string,
  options: { verifyAssets?: boolean; allowMissingAssets?: boolean } = {},
): LoadedSfxLibraryManifest {
  const resolvedPath = requiredFile(manifestPath, "SFX library manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    fail(
      "SFX_LIBRARY_INVALID",
      "cannot parse " + resolvedPath + ": "
        + (error instanceof Error ? error.message : String(error)),
    );
  }
  const manifest = validateArtifact<SfxLibraryManifest>(parsed, "sfx-library.schema.json");
  assertUniqueAssetIds(manifest);
  const loaded: LoadedSfxLibraryManifest = {
    manifest_path: resolvedPath,
    manifest_hash: hashFile(resolvedPath),
    library_root: fs.realpathSync(path.dirname(resolvedPath)),
    manifest,
  };
  if (options.verifyAssets) {
    for (const asset of manifest.assets) {
      if (!asset.path) continue;
      const hold = getSfxAssetHoldReason(asset);
      const sourcePath = verifyAssetFile(loaded, asset, {
        allowMissing: hold !== undefined || options.allowMissingAssets === true,
      });
      if (!hold && !sourcePath) {
        verifyAssetFile(loaded, asset, { allowMissing: false });
      }
    }
  } else {
    for (const asset of manifest.assets) {
      if (asset.path) {
        verifyAssetFile(loaded, asset, {
          allowMissing: options.allowMissingAssets !== false,
        });
      }
    }
  }
  return loaded;
}

/** Returns a machine-readable reason; no legal conclusion is inferred. */
export function getSfxAssetHoldReason(
  asset: SfxLibraryAsset,
  now = new Date(),
): string | undefined {
  if (!asset.path) return "source_path_missing";
  if (asset.content_hash === null || asset.size_bytes === null || asset.duration_us === null) {
    return "content_pin_missing";
  }
  if (asset.rights.status !== "confirmed" && asset.rights.status !== "cleared") {
    return "rights_status_" + asset.rights.status;
  }
  if (asset.rights.basis === "unknown") return "rights_basis_unknown";
  if (!asset.rights.evidence_ref || asset.rights.evidence_ref.trim().length === 0) {
    return "rights_evidence_missing";
  }
  if (
    asset.rights.expires_at
    && Number.isFinite(Date.parse(asset.rights.expires_at))
    && Date.parse(asset.rights.expires_at) <= now.getTime()
  ) {
    return "rights_evidence_expired";
  }
  if (asset.rights.expires_at && !Number.isFinite(Date.parse(asset.rights.expires_at))) {
    return "rights_expiry_invalid";
  }
  if (asset.provenance.status !== "verified") {
    return asset.provenance.status
      ? "provenance_status_" + asset.provenance.status
      : "provenance_status_missing";
  }
  if (!asset.provenance.source_ref || asset.provenance.source_ref.trim().length === 0) {
    return "provenance_missing";
  }
  if (asset.provenance.origin === "unknown") return "provenance_origin_unknown";
  if (asset.provenance.evidence_ref === undefined || !asset.provenance.evidence_ref?.trim()) {
    return "provenance_evidence_missing";
  }
  if (!asset.rights.verified_at || !Number.isFinite(Date.parse(asset.rights.verified_at))) {
    return "rights_verified_at_missing_or_invalid";
  }
  if (!Array.isArray(asset.rights.permitted_derivatives) || asset.rights.permitted_derivatives.length === 0) {
    return "permitted_derivatives_missing";
  }
  if (asset.review_status !== "approved") {
    return asset.review_status
      ? "review_status_" + asset.review_status
      : "review_status_missing";
  }
  if (asset.superseded_by) return "asset_superseded";
  return undefined;
}

export function getSfxLibraryHoldReason(
  manifest: SfxLibraryManifest,
): string | undefined {
  if (manifest.review_status !== "approved") {
    return manifest.review_status
      ? "library_review_status_" + manifest.review_status
      : "library_review_status_missing";
  }
  if (manifest.superseded_by) return "library_superseded";
  return undefined;
}

export function assertSfxAssetSelectable(
  asset: SfxLibraryAsset,
  now = new Date(),
  operation: "formal_render" | "promotion" | "internal_audition" = "formal_render",
): void {
  const reason = getSfxAssetHoldReason(asset, now);
  if (reason) {
    fail(
      "SFX_RIGHTS_HOLD",
      "asset " + asset.asset_id + " cannot be selected/rendered: " + reason,
    );
  }
  const usageScopes = Array.isArray(asset.rights.usage_scope)
    ? asset.rights.usage_scope
    : [asset.rights.usage_scope];
  if (operation !== "internal_audition" && usageScopes.includes("internal_audition")
    && !usageScopes.some((scope) => scope !== "internal_audition")) {
    fail("SFX_RIGHTS_HOLD", "asset " + asset.asset_id + " is restricted to internal_audition");
  }
  const requiredDerivative = operation === "internal_audition" ? "internal_audition" : "project_render";
  if (!asset.rights.permitted_derivatives?.includes(requiredDerivative)) {
    fail(
      "SFX_RIGHTS_HOLD",
      "asset " + asset.asset_id + " lacks permitted derivative " + requiredDerivative,
    );
  }
  if (operation !== "internal_audition" && !usageScopes.some((scope) =>
    scope === "project_render" || scope === "commercial" || scope === "public_release")) {
    fail("SFX_RIGHTS_HOLD", "asset " + asset.asset_id + " usage scope does not permit formal use");
  }
}

export function assertSfxScopeAuthority(
  loaded: LoadedSfxLibraryManifest,
  scope: SfxLibraryScope,
  options: { projectRoot?: string; repoSfxRoot?: string },
): void {
  if (loaded.manifest.scope !== undefined && loaded.manifest.scope !== scope) {
    fail(
      "SFX_LIBRARY_DRIFT",
      "manifest scope expected=" + scope + " actual=" + String(loaded.manifest.scope),
    );
  }
  const authorityRoot = scope === "project_local" ? options.projectRoot : options.repoSfxRoot;
  if (!authorityRoot) {
    fail("SFX_LIBRARY_UNSAFE_PATH", scope + " requires an explicit authority root");
  }
  const realAuthorityRoot = fs.realpathSync(path.resolve(authorityRoot));
  const realManifest = fs.realpathSync(loaded.manifest_path);
  if (!isContained(realAuthorityRoot, realManifest)) {
    fail("SFX_LIBRARY_UNSAFE_PATH", "SFX manifest escapes its " + scope + " authority root");
  }
  for (const asset of loaded.manifest.assets) {
    if (!asset.path) continue;
    const sourcePath = resolveSfxAssetSource(loaded, asset, { allowMissing: true });
    if (sourcePath && !isContained(realAuthorityRoot, fs.realpathSync(sourcePath))) {
      fail("SFX_LIBRARY_UNSAFE_PATH", "SFX asset escapes its " + scope + " authority root");
    }
  }
}

export function resolveSfxAssetSource(
  loaded: LoadedSfxLibraryManifest,
  asset: SfxLibraryAsset,
  options: { allowMissing?: boolean } = {},
): string | undefined {
  return verifyAssetFile(loaded, asset, options);
}

function candidateManifestPaths(
  rootPath: string,
  manifestName: string,
): string[] {
  const resolved = path.resolve(rootPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return [resolved];
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return [];
  const found: string[] = [];
  const names = new Set([manifestName, "sfx-library.json", "sfx-library.v1.json"]);
  const visit = (directory: string, depth: number): void => {
    if (depth > 2) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && names.has(entry.name)) found.push(entryPath);
      else if (entry.isDirectory()) visit(entryPath, depth + 1);
    }
  };
  visit(resolved, 0);
  return [...new Set(found)].sort((left, right) => left.localeCompare(right, "en"));
}

function defaultSearchRoots(options: SfxLibraryRegistryOptions): SfxLibrarySearchRoot[] {
  const roots: SfxLibrarySearchRoot[] = [];
  if (options.projectDir) {
    roots.push({
      path: path.join(options.projectDir, "07_package", "sfx"),
      scope: "project_local",
      priority: 0,
      label: "project-local",
    });
    roots.push({
      path: options.projectDir,
      scope: "project_local",
      priority: 0,
      label: "project-local-root",
    });
  }
  if (options.repoRoot) {
    roots.push({
      path: path.join(options.repoRoot, "resources", "sfx"),
      scope: "repo_common",
      priority: 10,
      label: "repository-common",
    });
    roots.push({
      path: path.join(options.repoRoot, "sfx-library"),
      scope: "repo_common",
      priority: 10,
      label: "repository-common-library",
    });
  }
  return roots;
}

export function loadSfxLibraryRegistry(
  options: SfxLibraryRegistryOptions = {},
): SfxLibraryRegistry {
  const manifestEntries: Array<LoadedSfxLibraryManifest & {
    scope: SfxLibraryScope;
    priority: number;
  }> = [];
  const seenManifests = new Set<string>();
  const explicitPaths = options.manifestPaths ?? [];
  const roots = options.searchRoots ?? defaultSearchRoots(options);
  for (const manifestPath of explicitPaths) {
    const loaded = loadSfxLibraryManifest(manifestPath, {
      verifyAssets: options.verifyAssets,
      allowMissingAssets: true,
    });
    const explicitScope = loaded.manifest.scope ?? "repo_common";
    assertSfxScopeAuthority(loaded, explicitScope, {
      ...(explicitScope === "project_local"
        ? { projectRoot: options.projectDir }
        : { repoSfxRoot: options.repoSfxRoot }),
    });
    if (!seenManifests.has(loaded.manifest_path)) {
      seenManifests.add(loaded.manifest_path);
      manifestEntries.push({
        ...loaded,
        scope: loaded.manifest.scope ?? "repo_common",
        priority: loaded.manifest.scope === "project_local" ? 0 : 10,
      });
    }
  }
  for (const root of roots) {
    for (const manifestPath of candidateManifestPaths(
      root.path,
      options.manifestName ?? "sfx-library.json",
    )) {
      const loaded = loadSfxLibraryManifest(manifestPath, {
        verifyAssets: options.verifyAssets,
        allowMissingAssets: true,
      });
      if (loaded.manifest.scope && loaded.manifest.scope !== root.scope) {
        fail(
          "SFX_LIBRARY_INVALID",
          loaded.manifest_path + " declares scope=" + loaded.manifest.scope
            + " but was discovered as " + root.scope,
        );
      }
      assertSfxScopeAuthority(loaded, root.scope, {
        ...(root.scope === "project_local"
          ? { projectRoot: options.projectDir }
          : { repoSfxRoot: options.repoSfxRoot }),
      });
      if (seenManifests.has(loaded.manifest_path)) continue;
      seenManifests.add(loaded.manifest_path);
      manifestEntries.push({ ...loaded, scope: root.scope, priority: root.priority });
    }
  }
  manifestEntries.sort((left, right) =>
    left.priority - right.priority
    || left.manifest_path.localeCompare(right.manifest_path, "en")
  );
  const assets = new Map<string, SfxResolvedAsset>();
  const selectedPriority = new Map<string, number>();
  for (const manifest of manifestEntries) {
    for (const asset of manifest.manifest.assets) {
      const prior = selectedPriority.get(asset.asset_id);
      if (prior !== undefined && prior === manifest.priority) {
        fail(
          "SFX_LIBRARY_AMBIGUOUS",
          "asset_id " + asset.asset_id
            + " is provided by multiple manifests at priority " + String(manifest.priority),
        );
      }
      if (prior !== undefined && prior < manifest.priority) continue;
      const sourcePath = resolveSfxAssetSource(manifest, asset, { allowMissing: true });
      selectedPriority.set(asset.asset_id, manifest.priority);
      assets.set(asset.asset_id, {
        asset,
        manifest,
        ...(sourcePath ? { sourcePath } : {}),
        precedence: {
          scope: manifest.scope,
          priority: manifest.priority,
          manifest_path: manifest.manifest_path,
        },
      });
    }
  }
  return { version: "sfx-library-registry/v1", manifests: manifestEntries, assets };
}

export function resolveSfxAssetFromRegistry(
  registry: SfxLibraryRegistry,
  selector: SfxAssetSelector,
): SfxResolvedAsset {
  const resolved = registry.assets.get(selector.asset_id);
  if (!resolved) fail("SFX_ASSET_MISSING", "unknown SFX asset: " + selector.asset_id);
  const { asset, manifest } = resolved;
  if (selector.scope && resolved.precedence.scope !== selector.scope) {
    fail(
      "SFX_LIBRARY_AMBIGUOUS",
      "asset " + selector.asset_id + " is not in requested scope " + selector.scope,
    );
  }
  const expectedManifestPath = selector.manifest_path
    ? path.resolve(selector.manifest_path)
    : undefined;
  for (const [label, expected, actual] of [
    ["library_id", selector.library_id, manifest.manifest.library_id],
    ["library_version", selector.library_version, manifest.manifest.library_version],
    ["manifest_path", expectedManifestPath, manifest.manifest_path],
    ["path", selector.path, asset.path ?? asset.source_uri],
    ["content_hash", selector.content_hash, asset.content_hash],
  ] as Array<[string, unknown, unknown]>) {
    if (expected !== undefined && expected !== actual) {
      fail(
        "SFX_LIBRARY_DRIFT",
        label + " expected=" + String(expected) + " actual=" + String(actual),
      );
    }
  }
  const libraryHold = getSfxLibraryHoldReason(manifest.manifest);
  if (libraryHold) {
    fail(
      "SFX_RIGHTS_HOLD",
      "SFX library cannot be selected: " + libraryHold,
    );
  }
  assertSfxAssetSelectable(asset);
  const sourcePath = resolveSfxAssetSource(manifest, asset, { allowMissing: true });
  return sourcePath ? { ...resolved, sourcePath } : resolved;
}

export const resolveSfxLibraryRegistry = loadSfxLibraryRegistry;
export const resolveSfxAsset = resolveSfxAssetFromRegistry;
export const loadSfxLibrary = loadSfxLibraryManifest;
export const inspectSfxLibraryRegistry = loadSfxLibraryRegistry;
export const resolveSfxLibraryAsset = resolveSfxAssetFromRegistry;
