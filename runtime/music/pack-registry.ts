import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  SUPPORTED_BGM_AUDIO_FORMATS,
  isSha256,
  packIssue,
  type BgmAudioFormat,
  type BgmPackAssetRef,
  type BgmPackDataRef,
  type BgmPackIssue,
  type BgmPackManifest,
  type BgmPackSource,
  type BgmPackTrack,
  type InstalledBgmPack,
  type BgmPackRegistryResult,
  type PackVerification,
} from "./pack-types.js";

const MANIFEST_FILE = "pack-manifest.json";
const PACK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_CONTRACT_VERSION = "0.1.0";
const AUDIO_EXTENSIONS = new Set([".wav", ".flac", ".aif", ".aiff", ".mp3", ".m4a", ".ogg"]);
const DATA_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const EDITORIAL_AXES = [
  "energy",
  "valence",
  "tension",
  "warmth",
  "modernity",
  "playfulness",
  "sophistication",
  "organic_electronic",
  "density",
  "speech_friendliness",
  "beat_prominence",
  "build_strength",
  "ending_resolution",
] as const;
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (options: Record<string, unknown>) => {
  compile(schema: object): (data: unknown) => boolean;
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

function loadSchemaValidator(filename: string): ((data: unknown) => boolean) | undefined {
  const candidates = [
    fileURLToPath(new URL(`../../schemas/${filename}`, import.meta.url)),
    fileURLToPath(new URL(`../../../schemas/${filename}`, import.meta.url)),
    path.resolve(process.cwd(), "schemas", filename),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const schema = JSON.parse(fs.readFileSync(candidate, "utf8")) as object;
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
      return ajv.compile(schema);
    } catch {
      // Try the next source/build layout. A missing validator rejects discovered packs below.
    }
  }
  return undefined;
}

const validateManifestSchema = loadSchemaValidator("bgm-pack-manifest.schema.json");
const validateRightsSchema = loadSchemaValidator("rights-license-register.schema.json");
const validateAnalysisSchema = loadSchemaValidator("bgm-track-analysis.schema.json");

export interface PackRegistryOptions {
  searchRoots?: PackSearchRoot[];
  projectPackDir?: string;
  env?: NodeJS.ProcessEnv;
  userPackDir?: string;
  bundledPackDir?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  contractVersion?: string;
}

export interface PackSearchRoot {
  source: BgmPackSource;
  priority: number;
  path: string;
}

interface ManifestParseResult {
  manifest?: BgmPackManifest;
  issues: BgmPackIssue[];
}

interface AssetToVerify {
  trackId: string;
  label: string;
  asset: BgmPackAssetRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAudioFormat(value: unknown): value is BgmAudioFormat {
  return typeof value === "string" && (SUPPORTED_BGM_AUDIO_FORMATS as readonly string[]).includes(value);
}

function parseAssetRef(value: unknown): value is BgmPackAssetRef {
  return isRecord(value)
    && typeof value.path === "string"
    && safeRelativeRef(value.path)
    && isSha256(value.content_hash)
    && isNonNegativeInteger(value.size_bytes)
    && isAudioFormat(value.format);
}

function parseDataRef(value: unknown): value is BgmPackDataRef {
  return isRecord(value)
    && typeof value.path === "string"
    && safeRelativeRef(value.path)
    && isSha256(value.content_hash)
    && isNonNegativeInteger(value.size_bytes)
    && (value.format === "json" || value.format === "yaml");
}

function parseTrack(value: unknown): value is BgmPackTrack {
  if (!isRecord(value)) return false;
  if (
    typeof value.track_id !== "string"
    || typeof value.title !== "string"
    || typeof value.contributor_id !== "string"
    || !isNonNegativeInteger(value.duration_us)
    || value.duration_us === 0
    || !isAudioFormat(value.format)
    || !parseAssetRef(value.full_mix)
    || !parseAssetRef(value.preview)
    || !parseDataRef(value.rights_ref)
    || !parseDataRef(value.analysis_ref)
    || typeof value.family !== "string"
    || (value.intensity !== "low" && value.intensity !== "high")
    || !isStringArray(value.use_cases)
    || !isStringArray(value.exclusions)
    || !isStringArray(value.instruments)
    || !Array.isArray(value.edit_points_us)
    || !value.edit_points_us.every(isNonNegativeInteger)
    || !Array.isArray(value.loop_windows)
    || !isRecord(value.axes)
    || !["none", "texture", "lead", "unknown"].includes(String(value.vocal_presence))
  ) {
    return false;
  }

  if (value.format !== (value.full_mix as BgmPackAssetRef).format) return false;
  if (!value.loop_windows.every((window) => isRecord(window)
    && isNonNegativeInteger(window.in_us)
    && isNonNegativeInteger(window.out_us)
    && window.out_us > window.in_us
    && (window.label === undefined || typeof window.label === "string")
    && (window.max_repetitions === undefined
      || (isNonNegativeInteger(window.max_repetitions) && window.max_repetitions >= 1)))) return false;
  const trackAxes = value.axes as Record<string, unknown>;
  const axisNames = Object.keys(trackAxes);
  if (axisNames.length !== EDITORIAL_AXES.length
    || !EDITORIAL_AXES.every((axis) => {
      const descriptor = trackAxes[axis];
      return isRecord(descriptor)
        && typeof descriptor.value === "number"
        && Number.isFinite(descriptor.value)
        && descriptor.value >= 0
        && descriptor.value <= 1
        && descriptor.source === "authored";
    })) return false;

  if (value.alternate_mixes !== undefined) {
    if (!Array.isArray(value.alternate_mixes)) return false;
    for (const asset of value.alternate_mixes) {
      if (!parseAssetRef(asset) || !isRecord(asset) || typeof asset.mix_id !== "string") return false;
    }
  }
  if (value.stems !== undefined) {
    if (!Array.isArray(value.stems)) return false;
    for (const asset of value.stems) {
      if (!parseAssetRef(asset) || !isRecord(asset) || typeof asset.stem_id !== "string") return false;
    }
  }
  return true;
}

function parseManifest(data: unknown, affectedRef: string): ManifestParseResult {
  if (!isRecord(data)) {
    return {
      issues: [packIssue("BGM_PACK_INCOMPATIBLE", "Pack manifest must be a JSON object.", {
        affectedRef,
        recoverable: false,
        suggestedAction: "Replace the pack with a compatible Video OS BGM pack.",
      })],
    };
  }

  const packRef = typeof data.pack_id === "string" && data.pack_id.length > 0
    ? data.pack_id
    : affectedRef;
  if (!validateManifestSchema) {
    return {
      issues: [packIssue("BGM_PACK_INCOMPATIBLE", "Canonical BGM pack schema is unavailable in this runtime.", {
        affectedRef: packRef,
        recoverable: false,
        suggestedAction: "Restore the Video OS schema bundle before loading BGM packs.",
      })],
    };
  }
  if (!validateManifestSchema(data)) {
    return {
      issues: [packIssue("BGM_PACK_INCOMPATIBLE", "Pack manifest does not satisfy the canonical bgm-pack-manifest/v1 schema.", {
        affectedRef: packRef,
        recoverable: false,
        suggestedAction: "Validate the manifest schema and rebuild the pack.",
      })],
    };
  }
  const compatible = data.compatible_video_os;
  const provenance = data.provenance;
  const hashPolicy = data.hash_policy;
  const valid = data.version === "1.0.0"
    && typeof data.pack_id === "string"
    && data.pack_id.length > 0
    && typeof data.pack_version === "string"
    && parseSemver(data.pack_version) !== undefined
    && typeof data.title === "string"
    && typeof data.created_at === "string"
    && typeof data.catalog_license === "string"
    && typeof data.default_content_license === "string"
    && isRecord(compatible)
    && typeof compatible.contract_min === "string"
    && typeof compatible.contract_max === "string"
    && parseSemver(compatible.contract_min) !== undefined
    && parseSemver(compatible.contract_max) !== undefined
    && Array.isArray(data.tracks)
    && data.tracks.length > 0
    && data.tracks.every(parseTrack)
    && isRecord(provenance)
    && typeof provenance.producer === "string"
    && ["bundled_pack", "user_library", "project_local"].includes(String(provenance.source_type))
    && isStringArray(provenance.evidence_refs)
    && (provenance.evidence_assets === undefined
      || (Array.isArray(provenance.evidence_assets) && provenance.evidence_assets.every(parseDataRef)))
    && isRecord(hashPolicy)
    && hashPolicy.algorithm === "sha256"
    && hashPolicy.canonicalization === "normalized-json-v1"
    && isStringArray(hashPolicy.excluded_fields);

  if (!valid) {
    return {
      issues: [packIssue("BGM_PACK_INCOMPATIBLE", "Pack manifest does not satisfy the bgm-pack-manifest/v1 contract.", {
        affectedRef: packRef,
        recoverable: false,
        suggestedAction: "Validate the manifest schema and rebuild the pack.",
      })],
    };
  }

  return { manifest: data as unknown as BgmPackManifest, issues: [] };
}

interface ParsedSemver {
  core: [number, number, number];
  prerelease: string[];
}

function parseSemver(value: string): ParsedSemver | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return undefined;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    return undefined;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return left.localeCompare(right, "en", { numeric: true });
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (b.prerelease.length === 0 && a.prerelease.length > 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = a.prerelease[index];
    const rightId = b.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    if (leftId === rightId) continue;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) return Number(leftId) - Number(rightId);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftId < rightId ? -1 : 1;
  }
  return 0;
}

function contractIsCompatible(manifest: BgmPackManifest, contractVersion: string): boolean {
  return compareSemver(contractVersion, manifest.compatible_video_os.contract_min) >= 0
    && compareSemver(contractVersion, manifest.compatible_video_os.contract_max) <= 0;
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
}

function normalizedJson(value: unknown, excludedFields: readonly string[], prefix = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizedJson(item, excludedFields, prefix));
  if (!isRecord(value)) return value;
  const excluded = new Set(excludedFields);
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (excluded.has(key) || excluded.has(fieldPath)) return [];
    return [[key, normalizedJson(value[key], excludedFields, fieldPath)]];
  }));
}

function manifestContentHash(manifest: BgmPackManifest): string {
  const canonical = JSON.stringify(normalizedJson(manifest, manifest.hash_policy.excluded_fields));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeRelativeRef(ref: string): boolean {
  if (
    ref.length === 0
    || /[\u0000-\u001f\u007f]/.test(ref)
    || ref.includes("\\")
    || ref.includes(":")
    || path.posix.isAbsolute(ref)
    || path.win32.isAbsolute(ref)
  ) return false;
  const segments = ref.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  const normalized = path.normalize(ref);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

function assetExtensionSupported(asset: BgmPackAssetRef): boolean {
  const extension = path.extname(asset.path).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) return false;
  if (asset.format === "aiff") return extension === ".aif" || extension === ".aiff";
  return extension === `.${asset.format}`;
}

function dataRefExtensionSupported(ref: BgmPackDataRef): boolean {
  const extension = path.extname(ref.path).toLowerCase();
  if (!DATA_EXTENSIONS.has(extension)) return false;
  return ref.format === "json" ? extension === ".json" : extension === ".yaml" || extension === ".yml";
}

function resolveContainedFile(rootRealPath: string, ref: string): string | undefined {
  if (!safeRelativeRef(ref)) return undefined;
  const candidate = path.resolve(rootRealPath, ref);
  if (!isContained(rootRealPath, candidate) || !fs.existsSync(candidate)) return undefined;
  let realPath: string;
  try {
    realPath = fs.realpathSync(candidate);
  } catch {
    return undefined;
  }
  if (!isContained(rootRealPath, realPath)) return undefined;
  return realPath;
}

function refEscapesRoot(rootRealPath: string, ref: string): boolean {
  if (!safeRelativeRef(ref)) return true;
  const candidate = path.resolve(rootRealPath, ref);
  if (!isContained(rootRealPath, candidate)) return true;
  if (!fs.existsSync(candidate)) return false;
  try {
    return !isContained(rootRealPath, fs.realpathSync(candidate));
  } catch {
    return false;
  }
}

function manifestAssets(manifest: BgmPackManifest): AssetToVerify[] {
  const assets: AssetToVerify[] = [];
  for (const track of manifest.tracks) {
    assets.push({ trackId: track.track_id, label: "full_mix", asset: track.full_mix });
    assets.push({ trackId: track.track_id, label: "preview", asset: track.preview });
    for (const alternate of track.alternate_mixes ?? []) {
      assets.push({ trackId: track.track_id, label: `alternate_mix:${alternate.mix_id}`, asset: alternate });
    }
    for (const stem of track.stems ?? []) {
      assets.push({ trackId: track.track_id, label: `stem:${stem.stem_id}`, asset: stem });
    }
  }
  return assets;
}

function safePackRef(manifestPath: string, expectedPackId?: string): string {
  if (expectedPackId && PACK_ID_PATTERN.test(expectedPackId)) return expectedPackId;
  const basename = path.basename(path.dirname(manifestPath));
  return PACK_ID_PATTERN.test(basename) ? basename : "bgm-pack";
}

function verifyPinnedDataRef(
  packRoot: string,
  affectedRef: string,
  label: "rights" | "analysis" | "provenance",
  ref: BgmPackDataRef,
  result: PackVerification,
): string | undefined {
  if (!dataRefExtensionSupported(ref)) {
    result.issues.push(packIssue("BGM_PACK_MEMBER_UNSUPPORTED", `Track ${label} reference uses an unsupported or mismatched format.`, {
      affectedRef,
      recoverable: false,
      suggestedAction: "Use a pinned JSON or YAML data record inside the pack.",
    }));
    return undefined;
  }
  if (refEscapesRoot(packRoot, ref.path)) {
    result.issues.push(packIssue("BGM_PACK_ARCHIVE_UNSAFE", `Track ${label} record resolves outside the pack root.`, {
      affectedRef,
      recoverable: false,
      suggestedAction: "Remove the unsafe pack and reinstall it from a trusted archive.",
    }));
    return undefined;
  }
  const resolved = resolveContainedFile(packRoot, ref.path);
  if (!resolved) {
    result.issues.push(packIssue("BGM_TRACK_MISSING", `Pinned track ${label} record is missing.`, {
      affectedRef,
      recoverable: false,
      suggestedAction: "Reinstall the complete pack from a verified archive.",
    }));
    return undefined;
  }
  let stats: fs.Stats;
  let actualHash: string;
  try {
    stats = fs.statSync(resolved);
    if (!stats.isFile()) throw new Error("not_file");
    actualHash = hashFile(resolved);
  } catch {
    result.issues.push(packIssue("BGM_TRACK_MISSING", `Pinned track ${label} record could not be read.`, {
      affectedRef,
      recoverable: false,
      suggestedAction: "Check pack permissions or reinstall the complete pack.",
    }));
    return undefined;
  }
  result.files_checked += 1;
  result.bytes_checked += stats.size;
  if (stats.size !== ref.size_bytes || actualHash !== ref.content_hash.toLowerCase()) {
    // Metadata is optional at selection time, but a declared pin mismatch means the pack itself was altered.
    result.issues.push(packIssue("BGM_PACK_HASH_MISMATCH", `Pinned track ${label} content hash or byte size does not match the manifest.`, {
      affectedRef,
      recoverable: false,
      suggestedAction: "Reinstall the pack from a verified archive; do not trust the altered metadata.",
    }));
    return undefined;
  }
  return resolved;
}

function readDataArtifact(filePath: string, format: BgmPackDataRef["format"]): unknown {
  const source = fs.readFileSync(filePath, "utf8");
  return format === "json" ? JSON.parse(source) as unknown : parseYaml(source) as unknown;
}

export function verifyPack(
  packPath: string,
  options: { contractVersion?: string; expectedPackId?: string } = {},
): PackVerification {
  const requestedManifestPath = path.basename(packPath) === MANIFEST_FILE
    ? path.resolve(packPath)
    : path.resolve(packPath, MANIFEST_FILE);
  const initialRef = safePackRef(requestedManifestPath, options.expectedPackId);
  const result: PackVerification = {
    ok: false,
    pack_ref: initialRef,
    files_checked: 0,
    bytes_checked: 0,
    issues: [],
    manifest_state: "missing",
  };

  if (!fs.existsSync(requestedManifestPath)) {
    result.issues.push(packIssue("BGM_PACK_NOT_FOUND", "BGM pack manifest was not found.", {
      affectedRef: initialRef,
      suggestedAction: "Install the pack or select a configured pack directory.",
    }));
    return result;
  }
  result.manifest_state = "unreadable";

  let manifestPath: string;
  let packRoot: string;
  try {
    manifestPath = fs.realpathSync(requestedManifestPath);
    packRoot = fs.realpathSync(path.dirname(requestedManifestPath));
  } catch {
    result.issues.push(packIssue("BGM_PACK_NOT_FOUND", "BGM pack could not be opened.", {
      affectedRef: initialRef,
      suggestedAction: "Check the pack installation and filesystem permissions.",
    }));
    return result;
  }

  if (!isContained(packRoot, manifestPath)) {
    result.issues.push(packIssue("BGM_PACK_ARCHIVE_UNSAFE", "Pack manifest resolves outside the pack root.", {
      affectedRef: initialRef,
      recoverable: false,
      suggestedAction: "Remove the unsafe pack and reinstall it from a trusted archive.",
    }));
    return result;
  }

  let manifestBytes: Buffer;
  let rawManifest: unknown;
  try {
    manifestBytes = fs.readFileSync(manifestPath);
    rawManifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch {
    result.issues.push(packIssue("BGM_PACK_INCOMPATIBLE", "Pack manifest is not valid JSON.", {
      affectedRef: initialRef,
      recoverable: false,
      suggestedAction: "Validate the manifest JSON and rebuild the pack.",
    }));
    return result;
  }

  result.files_checked += 1;
  result.bytes_checked += manifestBytes.byteLength;
  result.manifest_hash = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  if (isRecord(rawManifest) && typeof rawManifest.pack_id === "string" && PACK_ID_PATTERN.test(rawManifest.pack_id)) {
    result.pack_ref = rawManifest.pack_id;
  }
  const parsed = parseManifest(rawManifest, initialRef);
  result.issues.push(...parsed.issues);
  if (!parsed.manifest) {
    result.manifest_state = "schema_invalid";
    return result;
  }

  const manifest = parsed.manifest;
  result.manifest_state = "valid";
  result.manifest = manifest;
  result.pack_ref = manifest.pack_id;
  result.manifest_hash = manifestContentHash(manifest);
  const contractVersion = options.contractVersion ?? DEFAULT_CONTRACT_VERSION;
  if (!contractIsCompatible(manifest, contractVersion)) {
    result.issues.push(packIssue("BGM_PACK_INCOMPATIBLE", "Pack contract range does not include this Video OS runtime.", {
      affectedRef: manifest.pack_id,
      recoverable: false,
      suggestedAction: "Install a pack version compatible with the current Video OS contract.",
    }));
  }

  const trackIds = new Set<string>();
  result.verified_assets = Object.fromEntries(manifest.tracks.map((track) => [track.track_id, {
    alternate_mix_paths: {},
    stem_paths: {},
  }]));
  result.verified_provenance_paths = [];
  for (const track of manifest.tracks) {
    if (trackIds.has(track.track_id)) {
      result.issues.push(packIssue("BGM_PACK_INCOMPATIBLE", "Pack contains a duplicate track ID.", {
        affectedRef: track.track_id,
        recoverable: false,
        suggestedAction: "Assign unique stable track IDs and rebuild the pack.",
      }));
    }
    trackIds.add(track.track_id);
  }

  for (const entry of manifestAssets(manifest)) {
    if (!assetExtensionSupported(entry.asset)) {
      result.issues.push(packIssue("BGM_PACK_MEMBER_UNSUPPORTED", "Track references an unsupported or mismatched audio format.", {
        affectedRef: entry.trackId,
        recoverable: false,
        suggestedAction: "Re-encode the asset to a supported format and rebuild the manifest.",
      }));
      continue;
    }
    const resolved = resolveContainedFile(packRoot, entry.asset.path);
    if (!resolved) {
      const unsafe = refEscapesRoot(packRoot, entry.asset.path);
      result.issues.push(packIssue(unsafe ? "BGM_PACK_ARCHIVE_UNSAFE" : "BGM_TRACK_MISSING", unsafe
        ? "Track asset resolves outside the pack root."
        : `Track ${entry.label} asset is missing.`, {
        affectedRef: entry.trackId,
        recoverable: !unsafe,
        suggestedAction: unsafe
          ? "Remove the unsafe pack and reinstall it from a trusted archive."
          : "Reinstall the pack or restore the missing track asset.",
      }));
      continue;
    }
    let stats: fs.Stats;
    try {
      stats = fs.statSync(resolved);
    } catch {
      result.issues.push(packIssue("BGM_TRACK_MISSING", `Track ${entry.label} asset could not be opened.`, {
        affectedRef: entry.trackId,
        suggestedAction: "Reinstall the pack or restore the track asset.",
      }));
      continue;
    }
    if (!stats.isFile()) {
      result.issues.push(packIssue("BGM_TRACK_MISSING", `Track ${entry.label} reference is not a file.`, {
        affectedRef: entry.trackId,
        suggestedAction: "Reinstall the pack or restore the track asset.",
      }));
      continue;
    }
    result.files_checked += 1;
    result.bytes_checked += stats.size;
    let actualHash: string;
    try {
      actualHash = hashFile(resolved);
    } catch {
      result.issues.push(packIssue("BGM_TRACK_MISSING", `Track ${entry.label} asset could not be read.`, {
        affectedRef: entry.trackId,
        suggestedAction: "Check the pack filesystem permissions or reinstall the pack.",
      }));
      continue;
    }
    if (stats.size !== entry.asset.size_bytes || actualHash !== entry.asset.content_hash.toLowerCase()) {
      result.issues.push(packIssue("BGM_TRACK_HASH_MISMATCH", `Track ${entry.label} content hash or byte size does not match the manifest.`, {
        affectedRef: entry.trackId,
        recoverable: false,
        suggestedAction: "Reinstall the pack from a verified archive.",
      }));
      continue;
    }
    const verified = result.verified_assets[entry.trackId];
    if (entry.label === "full_mix") verified.full_mix_path = resolved;
    else if (entry.label === "preview") verified.preview_path = resolved;
    else if (entry.label.startsWith("alternate_mix:")) verified.alternate_mix_paths[entry.label.slice(14)] = resolved;
    else if (entry.label.startsWith("stem:")) verified.stem_paths[entry.label.slice(5)] = resolved;
    }

  for (const track of manifest.tracks) {
    const verified = result.verified_assets[track.track_id];
    const rightsPath = verifyPinnedDataRef(packRoot, track.track_id, "rights", track.rights_ref, result);
    if (rightsPath) {
      verified.rights_path = rightsPath;
      let rights: unknown;
      try {
        rights = readDataArtifact(rightsPath, track.rights_ref.format);
      } catch {
        rights = undefined;
      }
      const schemaValid = rights !== undefined && validateRightsSchema?.(rights) === true;
      const matchingRights = schemaValid && isRecord(rights) && Array.isArray(rights.items)
        ? rights.items.find((item) => isRecord(item)
          && item.asset_id === track.track_id
          && item.content_hash === track.full_mix.content_hash)
        : undefined;
      if (!schemaValid || !matchingRights) {
        result.issues.push(packIssue("BGM_RIGHTS_BLOCKED", schemaValid
          ? "Rights register has no item bound to this track and full-mix content hash."
          : "Rights register is malformed or does not satisfy the canonical rights schema.", {
          affectedRef: track.track_id,
          recoverable: false,
          suggestedAction: "Repair and re-pin the rights register before using this track.",
        }));
      }
    }

    const analysisPath = verifyPinnedDataRef(packRoot, track.track_id, "analysis", track.analysis_ref, result);
    if (analysisPath) {
      verified.analysis_path = analysisPath;
      let analysis: unknown;
      try {
        analysis = readDataArtifact(analysisPath, track.analysis_ref.format);
      } catch {
        analysis = undefined;
      }
      let degradedReason: string | undefined;
      if (analysis === undefined || validateAnalysisSchema?.(analysis) !== true) {
        degradedReason = "Pinned analysis is malformed or does not satisfy the canonical analysis schema.";
      } else if (!isRecord(analysis)
        || analysis.track_id !== track.track_id
        || analysis.input_content_hash !== track.full_mix.content_hash) {
        degradedReason = "Pinned analysis identity does not match the track ID and full-mix content hash.";
      } else if (isRecord(analysis.hash_policy)
        && Array.isArray(analysis.hash_policy.excluded_fields)
        && typeof analysis.analysis_hash === "string") {
        const canonicalHash = `sha256:${createHash("sha256")
          .update(JSON.stringify(normalizedJson(analysis, analysis.hash_policy.excluded_fields.filter((item): item is string => typeof item === "string"))))
          .digest("hex")}`;
        if (canonicalHash !== analysis.analysis_hash) degradedReason = "Pinned analysis self-hash is stale or inconsistent.";
      }
      if (degradedReason) {
        result.issues.push(packIssue("BGM_ANALYSIS_UNAVAILABLE", degradedReason, {
          affectedRef: track.track_id,
          suggestedAction: "Regenerate the track analysis and update its manifest pin.",
          severity: "warning",
        }));
      }
    }
  }

  const provenanceAssets = manifest.provenance.evidence_assets ?? [];
  const provenancePaths = new Set<string>();
  for (const ref of provenanceAssets) {
    if (provenancePaths.has(ref.path)) {
      result.issues.push(packIssue("BGM_PACK_INCOMPATIBLE", "Pack contains a duplicate pinned provenance path.", {
        affectedRef: manifest.pack_id,
        recoverable: false,
        suggestedAction: "Deduplicate provenance pins and rebuild the pack.",
      }));
      continue;
    }
    provenancePaths.add(ref.path);
    const resolved = verifyPinnedDataRef(packRoot, manifest.pack_id, "provenance", ref, result);
    if (resolved) result.verified_provenance_paths.push(resolved);
  }
  if (provenanceAssets.length > 0) {
    const unpinnedRefs = manifest.provenance.evidence_refs.filter((ref) => !provenancePaths.has(ref));
    if (unpinnedRefs.length > 0) {
      result.issues.push(packIssue("BGM_PACK_INCOMPATIBLE", "Pack provenance evidence_refs include members without hash-and-size pins.", {
        affectedRef: manifest.pack_id,
        recoverable: false,
        suggestedAction: "Pin every declared provenance member and rebuild the pack.",
      }));
    }
  }

  result.ok = result.issues.every((issue) => issue.severity !== "error");
  return result;
}

function defaultUserPackDir(platform: NodeJS.Platform, homeDir: string, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", "VideoOS", "BGMPacks");
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(homeDir, "AppData", "Roaming"), "VideoOS", "BGMPacks");
  return path.join(env.XDG_DATA_HOME ?? path.join(homeDir, ".local", "share"), "video-os", "bgm-packs");
}

export function packSearchRoots(options: PackRegistryOptions = {}): PackSearchRoot[] {
  if (options.searchRoots) {
    return options.searchRoots.map((root) => ({ ...root, path: path.resolve(root.path) }));
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const bundledDefault = fileURLToPath(new URL("../../resources/bgm-packs", import.meta.url));
  const roots: Array<PackSearchRoot | undefined> = [
    options.projectPackDir ? { source: "project_override", priority: 0, path: options.projectPackDir } : undefined,
    env.VIDEO_OS_BGM_PACK_DIR ? { source: "environment", priority: 1, path: env.VIDEO_OS_BGM_PACK_DIR } : undefined,
    { source: "user", priority: 2, path: options.userPackDir ?? defaultUserPackDir(platform, homeDir, env) },
    { source: "bundled", priority: 3, path: options.bundledPackDir ?? env.VIDEO_OS_APP_BGM_PACK_DIR ?? bundledDefault },
  ];
  const seen = new Set<string>();
  return roots.filter((entry): entry is PackSearchRoot => {
    if (!entry) return false;
    const absolute = path.resolve(entry.path);
    if (seen.has(absolute)) return false;
    seen.add(absolute);
    entry.path = absolute;
    return true;
  });
}

export function findPackManifestPaths(rootPath: string, maxDepth = 2): string[] {
  const absoluteRoot = path.resolve(rootPath);
  if (!fs.existsSync(absoluteRoot)) return [];
  let rootStats: fs.Stats;
  try {
    rootStats = fs.statSync(absoluteRoot);
  } catch {
    return [];
  }
  if (rootStats.isFile()) {
    return path.basename(absoluteRoot) === MANIFEST_FILE ? [absoluteRoot] : [];
  }

  const manifests: string[] = [];
  const visit = (directory: string, depth: number): void => {
    const manifest = path.join(directory, MANIFEST_FILE);
    if (fs.existsSync(manifest)) {
      try {
        if (fs.statSync(manifest).isFile()) {
          manifests.push(manifest);
          return;
        }
      } catch {
        return;
      }
    }
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      visit(path.join(directory, entry.name), depth + 1);
    }
  };
  visit(absoluteRoot, 0);
  return manifests.sort((left, right) => left.localeCompare(right));
}

interface DiscoveredPack {
  root: PackSearchRoot;
  manifestPath: string;
  verification: PackVerification;
}

export function inspectInstalledPacks(options: PackRegistryOptions = {}): BgmPackRegistryResult {
  const discovered: DiscoveredPack[] = [];
  const contractVersion = options.contractVersion
    ?? (options.env ?? process.env).VIDEO_OS_CONTRACT_VERSION
    ?? DEFAULT_CONTRACT_VERSION;
  for (const root of packSearchRoots(options)) {
    for (const manifestPath of findPackManifestPaths(root.path)) {
      const verification = verifyPack(manifestPath, { contractVersion });
      discovered.push({ root, manifestPath, verification });
    }
  }

  discovered.sort((left, right) => left.root.priority - right.root.priority
    || left.verification.pack_ref.localeCompare(right.verification.pack_ref)
    || left.manifestPath.localeCompare(right.manifestPath));
  const selected = new Map<string, InstalledBgmPack>();
  const blockedIds = new Set<string>();
  const issues: BgmPackIssue[] = [];
  const priorities = [...new Set(discovered.map((entry) => entry.root.priority))].sort((a, b) => a - b);
  let globalFallbackBlockPriority: number | undefined;

  for (const priority of priorities) {
    if (globalFallbackBlockPriority !== undefined && priority > globalFallbackBlockPriority) continue;
    const atPriority = discovered.filter((entry) => entry.root.priority === priority);
    const unreadableProjectOverride = atPriority.filter((entry) => entry.root.source === "project_override"
      && entry.verification.manifest_state === "unreadable");
    if (unreadableProjectOverride.length > 0) {
      globalFallbackBlockPriority = priority;
      issues.push(...unreadableProjectOverride.flatMap((entry) => entry.verification.issues));
    }

    const byPackId = new Map<string, DiscoveredPack[]>();
    for (const entry of atPriority) {
      const packId = entry.verification.manifest?.pack_id ?? entry.verification.pack_ref;
      const group = byPackId.get(packId) ?? [];
      group.push(entry);
      byPackId.set(packId, group);
    }
    for (const [packId, group] of byPackId) {
      if (selected.has(packId) || blockedIds.has(packId)) continue;
      const structurallyInvalid = group.filter((entry) => !entry.verification.manifest || !entry.verification.manifest_hash);
      if (structurallyInvalid.length > 0) {
        blockedIds.add(packId);
        issues.push(...structurallyInvalid.flatMap((entry) => entry.verification.issues));
        continue;
      }
      const candidates = group.filter((entry): entry is DiscoveredPack & {
        verification: PackVerification & { manifest: BgmPackManifest; manifest_hash: string };
      } => entry.verification.manifest !== undefined && entry.verification.manifest_hash !== undefined);
      candidates.sort((left, right) => compareSemver(
        right.verification.manifest.pack_version,
        left.verification.manifest.pack_version,
      ) || left.manifestPath.localeCompare(right.manifestPath));
      const winner = candidates[0];
      selected.set(packId, {
        source: winner.root.source,
        priority: winner.root.priority,
        pack_path: path.dirname(path.resolve(winner.manifestPath)),
        manifest_path: path.resolve(winner.manifestPath),
        manifest: winner.verification.manifest,
        manifest_hash: winner.verification.manifest_hash,
        verification: winner.verification,
      });
      issues.push(...winner.verification.issues);
    }
  }

  const packs = [...selected.values()].sort((left, right) => left.manifest.pack_id.localeCompare(right.manifest.pack_id));
  return {
    packs,
    issues,
    blocked_pack_ids: [...blockedIds].sort(),
    global_fallback_blocked: globalFallbackBlockPriority !== undefined,
  };
}

export function resolveInstalledPacks(options: PackRegistryOptions = {}): InstalledBgmPack[] {
  return inspectInstalledPacks(options).packs;
}
