#!/usr/bin/env npx tsx
/**
 * Owner-operated OTIO handoff export.
 *
 * This command reads one project's canonical timeline, approval record, and
 * source map, then composes the existing handoff export orchestrator. It does
 * not edit timeline.json or import any NLE changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  parseJsonRejectDuplicateKeys,
  validateAgainstSchema,
} from "../runtime/commands/shared.js";
import { computeFileHash } from "../runtime/state/reconcile.js";
import {
  executeHandoffExport,
  sha256,
  validateStableIds,
  type ExportError,
  type HandoffExportInput,
  type HandoffExportResult,
  type HandoffManifest,
  type SourceMapEntry,
} from "../runtime/handoff/export.js";
import type { NleCapabilityProfile } from "../runtime/handoff/bridge-contract.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

const CANONICAL_TIMELINE_PATH = "05_timeline/timeline.json";
const CANONICAL_STATE_PATH = "project_state.yaml";
const CANONICAL_SOURCE_MAP_PATH = "02_media/source_map.json";
const HANDOFF_ROOT = "exports/handoffs";
const MANIFEST_NAME = "handoff_manifest.yaml";
const OTIO_NAME = "handoff_timeline.otio";
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SAFE_HANDOFF_ID = /^HND_[A-Za-z0-9._-]+$/;
const RESOLVE_PROFILE_ID = "davinci_resolve_otio_v1";

const USAGE = [
  "Usage: npx tsx scripts/handoff-export.ts --project <project-path> --profile <nle-profile.yaml> [--python <path>] [--check] [--json]",
  "",
  "  --check       Validate canonical inputs only; do not run the bridge or write the project",
  "  --python      Python executable passed to the existing OTIO bridge",
  "  --json        Print the result or structured error as JSON",
].join("\n");

export interface HandoffExportCliArgs {
  projectPath?: string;
  profilePath?: string;
  pythonPath?: string;
  check: boolean;
  jsonOutput: boolean;
  help: boolean;
}

export class HandoffExportCliError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HandoffExportCliError";
    this.code = code;
    this.details = details;
  }
}

export interface HandoffExportCliResult {
  ok: true;
  mode: "check" | "write";
  static_ready: true;
  bridge_execution: "not_run" | "executed";
  project_id: string;
  timeline_version: string;
  profile_id: string;
  source_map_entries: number;
  referenced_asset_count: number;
  output_root: string;
  handoff_id?: string;
  session_dir?: string;
  manifest_path?: string;
  otio_path?: string;
  readback_valid?: true;
}

export interface HandoffExportCliDependencies {
  /** Internal test seam; production uses executeHandoffExport unchanged. */
  executeExport?: typeof executeHandoffExport;
}

interface FileStatSnapshot {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface SafeFileSnapshot {
  absolutePath: string;
  bytes: Buffer;
  stat: FileStatSnapshot;
  parentStat: FileStatSnapshot;
  containmentRoot?: string;
}

interface CanonicalSourceMap {
  version: "1";
  project_id: string;
  media_dir: "02_media";
  generated_at: string;
  items: Array<{
    asset_id: string;
    source_locator: string;
    local_source_path: string;
    link_path: string;
    [key: string]: unknown;
  }>;
}

interface Preflight {
  projectRoot: string;
  timelinePath: string;
  statePath: string;
  sourceMapPath: string;
  profilePath: string;
  timeline: TimelineIR;
  state: Record<string, unknown>;
  approvalRecord: HandoffExportInput["approvalRecord"];
  sourceMap: CanonicalSourceMap;
  profile: NleCapabilityProfile;
  timelineSnapshot: SafeFileSnapshot;
  inputSnapshots: SafeFileSnapshot[];
  timelineHash: string;
  outputRoot: string;
  sourceMapEntries: SourceMapEntry[];
  referencedAssetIds: Set<string>;
}

function fail(code: string, message: string, details?: unknown): never {
  throw new HandoffExportCliError(code, message, details);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function statSnapshot(stats: fs.Stats): FileStatSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameStat(left: FileStatSnapshot, right: FileStatSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameNamespaceStat(left: FileStatSnapshot, right: FileStatSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function sameParentIdentity(left: FileStatSnapshot, right: FileStatSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode;
}

function isContained(projectRoot: string, candidate: string): boolean {
  const relative = path.relative(projectRoot, candidate);
  return relative.length > 0
    && !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`);
}

function assertRealDirectoryNamespace(
  projectRoot: string,
  absolutePath: string,
  label: string,
  allowMissing: boolean,
): void {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPath = path.resolve(absolutePath);
  if (resolvedPath === resolvedRoot) return;
  if (!isContained(resolvedRoot, resolvedPath)) {
    fail("PATH_ESCAPE", `${label} escapes the project root: ${resolvedPath}`);
  }

  const relative = path.relative(resolvedRoot, resolvedPath);
  let current = resolvedRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT" && allowMissing) return;
      if (errorCode(error) === "ENOENT") {
        fail("INPUT_NOT_FOUND", `${label} namespace component is missing: ${current}`);
      }
      fail("PATH_INVALID", `${label} namespace component is not statable: ${current}`, error);
    }
    if (stats.isSymbolicLink()) {
      fail("PATH_SYMLINK", `${label} namespace component is a symlink: ${current}`);
    }
    if (!stats.isDirectory()) {
      fail("PATH_INVALID", `${label} namespace component is not a directory: ${current}`);
    }
    let real: string;
    try {
      real = fs.realpathSync(current);
    } catch (error) {
      fail("PATH_INVALID", `${label} namespace component is not resolvable: ${current}`, error);
    }
    if (real !== current || !isContained(resolvedRoot, real)) {
      fail("PATH_ESCAPE", `${label} namespace component resolves outside the project: ${current}`);
    }
  }
}

function safeFileSnapshot(
  absolutePath: string,
  label: string,
  containmentRoot?: string,
): SafeFileSnapshot {
  const resolved = path.resolve(absolutePath);
  const root = containmentRoot ? fs.realpathSync(path.resolve(containmentRoot)) : undefined;
  if (root) assertRealDirectoryNamespace(root, path.dirname(resolved), `${label} parent`, false);

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch (error) {
    fail("INPUT_NOT_FOUND", `${label} is not statable: ${resolved}`, error);
  }
  if (stats.isSymbolicLink()) fail("PATH_SYMLINK", `${label} is a symlink: ${resolved}`);
  if (!stats.isFile()) fail("PATH_INVALID", `${label} is not a regular file: ${resolved}`);
  if (stats.nlink !== 1) fail("PATH_INVALID", `${label} has nlink=${stats.nlink}; hardlinks are rejected: ${resolved}`);

  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch (error) {
    fail("PATH_INVALID", `${label} is not resolvable: ${resolved}`, error);
  }
  if (real !== resolved) fail("PATH_SYMLINK", `${label} resolves through an alias: ${resolved}`);
  if (root && !isContained(root, real)) fail("PATH_ESCAPE", `${label} resolves outside the project: ${resolved}`);

  const parentPath = path.dirname(resolved);
  let parentStats: fs.Stats;
  try {
    parentStats = fs.lstatSync(parentPath);
  } catch (error) {
    fail("PATH_INVALID", `${label} parent is not statable: ${parentPath}`, error);
  }
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    fail("PATH_INVALID", `${label} parent is not a real directory: ${parentPath}`);
  }

  const before = statSnapshot(stats);
  const parentBefore = statSnapshot(parentStats);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(resolved);
  } catch (error) {
    fail("INPUT_UNREADABLE", `${label} is unreadable: ${resolved}`, error);
  }
  let afterStats: fs.Stats;
  let parentAfterStats: fs.Stats;
  try {
    afterStats = fs.lstatSync(resolved);
    parentAfterStats = fs.lstatSync(parentPath);
  } catch (error) {
    fail("INPUT_MUTATED", `${label} namespace changed during the read: ${resolved}`, error);
  }
  const after = statSnapshot(afterStats);
  const parentAfter = statSnapshot(parentAfterStats);
  if (!sameStat(before, after) || !sameNamespaceStat(parentBefore, parentAfter)) {
    fail("INPUT_MUTATED", `${label} changed during the read: ${resolved}`);
  }
  return {
    absolutePath: resolved,
    bytes,
    stat: before,
    parentStat: parentBefore,
    ...(root ? { containmentRoot: root } : {}),
  };
}

function assertSnapshotUnchanged(snapshot: SafeFileSnapshot, label: string): void {
  const current = safeFileSnapshot(snapshot.absolutePath, label, snapshot.containmentRoot);
  if (!sameStat(snapshot.stat, current.stat)
    || !sameParentIdentity(snapshot.parentStat, current.parentStat)
    || !snapshot.bytes.equals(current.bytes)) {
    fail("INPUT_MUTATED", `${label} changed after its guarded read: ${snapshot.absolutePath}`);
  }
}

function resolveProjectRoot(projectPath: string): string {
  const lexical = path.resolve(projectPath);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(lexical);
  } catch (error) {
    fail("PROJECT_NOT_FOUND", `project is not statable: ${lexical}`, error);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("PROJECT_INVALID", `project is not a real directory: ${lexical}`);
  }
  try {
    return fs.realpathSync(lexical);
  } catch (error) {
    fail("PROJECT_INVALID", `project is not resolvable: ${lexical}`, error);
  }
}

function parseYamlObject(bytes: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(bytes.toString("utf8"));
  } catch (error) {
    fail("SCHEMA_INVALID", `${label} is not valid YAML`, error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("SCHEMA_INVALID", `${label} must be a YAML mapping`);
  }
  return parsed as Record<string, unknown>;
}

function validateSchemaOrFail(document: unknown, schema: string, label: string): void {
  const validation = validateAgainstSchema(document, schema);
  if (!validation.valid) {
    fail("SCHEMA_INVALID", `${label} failed ${schema}: ${validation.errors.slice(0, 4).join("; ")}`, validation.errors);
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("SCHEMA_INVALID", `${label} must be a non-empty string`);
  }
  return value;
}

function assertSafeSegment(value: unknown, label: string, pattern = SAFE_SEGMENT): string {
  const segment = requireNonEmptyString(value, label);
  if (!pattern.test(segment)) fail("PATH_INVALID", `${label} is not a safe path segment: ${segment}`);
  return segment;
}

function parseCanonicalTimeline(snapshot: SafeFileSnapshot, projectRoot: string): TimelineIR {
  let document: unknown;
  try {
    document = parseJsonRejectDuplicateKeys(snapshot.bytes.toString("utf8"), "canonical timeline");
  } catch (error) {
    fail("SCHEMA_INVALID", "canonical timeline is not valid JSON", error);
  }
  validateSchemaOrFail(document, "timeline-ir.schema.json", "canonical timeline");
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail("SCHEMA_INVALID", "canonical timeline must be a JSON object");
  }
  const timeline = document as TimelineIR;
  if (path.resolve(snapshot.absolutePath) !== path.join(projectRoot, CANONICAL_TIMELINE_PATH)) {
    fail("PATH_INVALID", `canonical timeline must be ${CANONICAL_TIMELINE_PATH}`);
  }
  requireNonEmptyString(timeline.project_id, "canonical timeline project_id");
  const version = assertSafeSegment(timeline.version, "canonical timeline version");
  if (version !== timeline.version) fail("PATH_INVALID", "canonical timeline version is not stable");

  const stableIdErrors = validateStableIds(timeline);
  if (stableIdErrors.length > 0) {
    fail("GATE_8_FAILED", `canonical timeline has ${stableIdErrors.length} stable ID error(s)`, stableIdErrors);
  }
  return timeline;
}

function parseCanonicalSourceMap(snapshot: SafeFileSnapshot): CanonicalSourceMap {
  let document: unknown;
  try {
    document = parseJsonRejectDuplicateKeys(snapshot.bytes.toString("utf8"), "canonical source map");
  } catch (error) {
    fail("SCHEMA_INVALID", "canonical source map is not valid JSON", error);
  }
  validateSchemaOrFail(document, "source-map.schema.json", "canonical source map");
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail("SCHEMA_INVALID", "canonical source map must be a JSON object");
  }
  return document as CanonicalSourceMap;
}

function parseCanonicalProfile(snapshot: SafeFileSnapshot): NleCapabilityProfile {
  const document = parseYamlObject(snapshot.bytes, "NLE capability profile");
  validateSchemaOrFail(document, "nle-capability-profile.schema.json", "NLE capability profile");
  return document as unknown as NleCapabilityProfile;
}

function parseApprovalRecord(state: Record<string, unknown>): HandoffExportInput["approvalRecord"] {
  const approval = state.approval_record;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    fail("NOT_APPROVED", "project_state.yaml has no approval_record; approve the canonical timeline before export");
  }
  const record = approval as Record<string, unknown>;
  const status = record.status;
  if (status !== "clean" && status !== "creative_override") {
    fail("NOT_APPROVED", `project approval_record is not export-approved (status: ${String(status ?? "missing")})`);
  }
  return {
    status,
    approved_by: requireNonEmptyString(record.approved_by, "approval_record.approved_by"),
    approved_at: requireNonEmptyString(record.approved_at, "approval_record.approved_at"),
    ...(record.artifact_versions ? { artifact_versions: record.artifact_versions as HandoffExportInput["approvalRecord"]["artifact_versions"] } : {}),
  };
}

function assertApprovalBindsCurrentTimeline(
  approvalRecord: HandoffExportInput["approvalRecord"],
  timelinePath: string,
  timelineVersion: string,
): void {
  const versions = approvalRecord.artifact_versions;
  if (!versions || typeof versions.timeline_version !== "string") {
    fail("APPROVAL_STALE", "approval_record has no timeline_version binding for the canonical timeline; re-approve before export");
  }
  let currentTimelineHash: string;
  try {
    currentTimelineHash = computeFileHash(timelinePath);
  } catch (error) {
    fail("INPUT_UNREADABLE", `canonical timeline hash could not be computed: ${timelinePath}`, error);
  }
  if (versions.timeline_version !== currentTimelineHash) {
    fail("APPROVAL_STALE", "approval_record.timeline_version does not match the current canonical timeline; re-approve before export", {
      approved: versions.timeline_version,
      current: currentTimelineHash,
    });
  }
  if (versions.editorial_timeline_hash && versions.editorial_timeline_hash !== currentTimelineHash) {
    fail("APPROVAL_STALE", "approval_record.editorial_timeline_hash does not match the current canonical timeline; re-approve before export", {
      approved: versions.editorial_timeline_hash,
      current: currentTimelineHash,
    });
  }
  if (versions.base_timeline_version && versions.base_timeline_version !== timelineVersion) {
    fail("APPROVAL_STALE", "approval_record.base_timeline_version does not match the current canonical timeline version; re-approve before export", {
      approved: versions.base_timeline_version,
      current: timelineVersion,
    });
  }
}

function referencedAssetIds(timeline: TimelineIR): Set<string> {
  const ids = new Set<string>();
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) ids.add(clip.asset_id);
  }
  return ids;
}

function resolveSourceLocator(
  projectRoot: string,
  sourceMapPath: string,
  locator: string,
): string {
  if (locator.includes("\\") || locator.includes("\u0000")) {
    fail("PATH_INVALID", `source map source_locator contains an unsafe path alias: ${locator}`);
  }
  const candidates = path.isAbsolute(locator)
    ? [path.resolve(locator)]
    : [
        path.resolve(path.dirname(sourceMapPath), locator),
        path.resolve(projectRoot, locator),
      ];
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      const stats = fs.statSync(resolved);
      if (!stats.isFile()) continue;
      fs.accessSync(resolved, fs.constants.R_OK);
      const handle = fs.openSync(resolved, fs.constants.O_RDONLY);
      fs.closeSync(handle);
      return resolved;
    } catch {
      // Try the next canonical source-map resolution candidate.
    }
  }
  fail("SOURCE_NOT_READABLE", `source map entry does not resolve to a readable regular file: ${locator}`);
}

function assertSourceMapCoverage(
  projectRoot: string,
  sourceMapPath: string,
  sourceMap: CanonicalSourceMap,
  timeline: TimelineIR,
): { entries: SourceMapEntry[]; referenced: Set<string> } {
  const referenced = referencedAssetIds(timeline);
  const byAsset = new Map<string, CanonicalSourceMap["items"][number]>();
  for (const item of sourceMap.items) {
    if (byAsset.has(item.asset_id)) {
      fail("SOURCE_MAP_INVALID", `canonical source map contains duplicate asset_id: ${item.asset_id}`);
    }
    byAsset.set(item.asset_id, item);
  }

  const normalizedLocators = new Map<string, string>();
  for (const item of sourceMap.items) {
    normalizedLocators.set(item.asset_id, resolveSourceLocator(projectRoot, sourceMapPath, item.source_locator));
  }
  const entries: SourceMapEntry[] = [];
  for (const assetId of referenced) {
    const item = byAsset.get(assetId);
    if (!item) fail("SOURCE_MAP_COVERAGE", `canonical source map does not cover timeline asset_id: ${assetId}`);
  }
  for (const item of sourceMap.items) {
    entries.push({
      asset_id: item.asset_id,
      source_locator: normalizedLocators.get(item.asset_id)!,
      ...(item.local_source_path ? { local_source_path: item.local_source_path } : {}),
      ...(typeof item.relink_required === "boolean" ? { relink_required: item.relink_required } : {}),
    });
  }
  return { entries, referenced };
}

function preflightArgs(args: HandoffExportCliArgs): Preflight {
  const projectRoot = resolveProjectRoot(args.projectPath!);
  const timelinePath = path.join(projectRoot, CANONICAL_TIMELINE_PATH);
  const statePath = path.join(projectRoot, CANONICAL_STATE_PATH);
  const sourceMapPath = path.join(projectRoot, CANONICAL_SOURCE_MAP_PATH);
  assertRealDirectoryNamespace(projectRoot, path.dirname(timelinePath), "canonical timeline", false);
  assertRealDirectoryNamespace(projectRoot, path.dirname(sourceMapPath), "canonical source map", false);

  const timelineSnapshot = safeFileSnapshot(timelinePath, "canonical timeline", projectRoot);
  const stateSnapshot = safeFileSnapshot(statePath, "project state", projectRoot);
  const sourceMapSnapshot = safeFileSnapshot(sourceMapPath, "canonical source map", projectRoot);
  const profilePath = path.resolve(args.profilePath!);
  const profileSnapshot = safeFileSnapshot(profilePath, "NLE capability profile");

  const timeline = parseCanonicalTimeline(timelineSnapshot, projectRoot);
  const state = parseYamlObject(stateSnapshot.bytes, "project state");
  validateSchemaOrFail(state, "project-state.schema.json", "project state");
  if (state.project_id !== timeline.project_id) {
    fail("PROJECT_MISMATCH", "project_state.yaml project_id does not match canonical timeline project_id");
  }
  if (state.current_state !== "approved") {
    fail("NOT_APPROVED", `project_state.yaml current_state is not approved (state: ${String(state.current_state ?? "missing")})`);
  }
  const approvalRecord = parseApprovalRecord(state);
  assertApprovalBindsCurrentTimeline(approvalRecord, timelinePath, timeline.version);

  const sourceMap = parseCanonicalSourceMap(sourceMapSnapshot);
  if (sourceMap.project_id !== timeline.project_id) {
    fail("PROJECT_MISMATCH", "source_map.json project_id does not match canonical timeline project_id");
  }
  const profile = parseCanonicalProfile(profileSnapshot);
  if (profile.profile_id !== RESOLVE_PROFILE_ID
    || profile.nle.vendor !== "Blackmagic Design"
    || profile.nle.product !== "DaVinci Resolve"
    || profile.otio.interchange_format !== "otio") {
    fail("PROFILE_INVALID", `handoff-export supports only the Resolve OTIO profile ${RESOLVE_PROFILE_ID}; received ${profile.profile_id}`);
  }

  const sourceMapCoverage = assertSourceMapCoverage(projectRoot, sourceMapPath, sourceMap, timeline);
  const outputRoot = path.join(projectRoot, HANDOFF_ROOT);
  assertRealDirectoryNamespace(projectRoot, outputRoot, "handoff output root", true);

  return {
    projectRoot,
    timelinePath,
    statePath,
    sourceMapPath,
    profilePath,
    timeline,
    state,
    approvalRecord,
    sourceMap,
    profile,
    timelineSnapshot,
    inputSnapshots: [timelineSnapshot, stateSnapshot, sourceMapSnapshot, profileSnapshot],
    timelineHash: sha256(timelineSnapshot.bytes.toString("utf8")),
    outputRoot,
    sourceMapEntries: sourceMapCoverage.entries,
    referencedAssetIds: sourceMapCoverage.referenced,
  };
}

function relativeProjectPath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

function outputResult(
  preflight: Preflight,
  mode: "check" | "write",
  result?: HandoffExportResult,
): HandoffExportCliResult {
  return {
    ok: true,
    mode,
    static_ready: true,
    bridge_execution: mode === "check" ? "not_run" : "executed",
    project_id: preflight.timeline.project_id,
    timeline_version: preflight.timeline.version,
    profile_id: preflight.profile.profile_id,
    source_map_entries: preflight.sourceMap.items.length,
    referenced_asset_count: preflight.referencedAssetIds.size,
    output_root: relativeProjectPath(preflight.projectRoot, preflight.outputRoot),
    ...(result
      ? {
          handoff_id: result.handoffId,
          session_dir: relativeProjectPath(preflight.projectRoot, result.sessionDir),
          manifest_path: relativeProjectPath(preflight.projectRoot, result.manifestPath),
          otio_path: relativeProjectPath(preflight.projectRoot, result.otioPath),
          readback_valid: true as const,
        }
      : {}),
  };
}

function exportErrorResult(value: unknown): value is { error: ExportError } {
  return !!value && typeof value === "object" && "error" in value;
}

function assertExportOutput(
  preflight: Preflight,
  result: HandoffExportResult,
): void {
  const handoffId = assertSafeSegment(result.handoffId, "handoff_id", SAFE_HANDOFF_ID);
  const expectedSessionDir = path.join(preflight.outputRoot, handoffId);
  if (path.resolve(result.sessionDir) !== expectedSessionDir) {
    fail("PATH_ESCAPE", `exporter returned a handoff session outside the canonical output root: ${result.sessionDir}`);
  }
  assertRealDirectoryNamespace(preflight.projectRoot, expectedSessionDir, "handoff session", false);

  const expectedManifestPath = path.join(expectedSessionDir, MANIFEST_NAME);
  const expectedOtioPath = path.join(expectedSessionDir, OTIO_NAME);
  if (path.resolve(result.manifestPath) !== expectedManifestPath) {
    fail("PATH_INVALID", `exporter returned an unexpected manifest path: ${result.manifestPath}`);
  }
  if (path.resolve(result.otioPath) !== expectedOtioPath) {
    fail("PATH_INVALID", `exporter returned an unexpected OTIO path: ${result.otioPath}`);
  }
  const manifestFile = safeFileSnapshot(expectedManifestPath, "handoff manifest", preflight.projectRoot);
  safeFileSnapshot(expectedOtioPath, "handoff OTIO", preflight.projectRoot);

  validateSchemaOrFail(result.manifest, "handoff-manifest.schema.json", "exported handoff manifest");
  const persistedManifest = parseYamlObject(manifestFile.bytes, "persisted handoff manifest");
  validateSchemaOrFail(persistedManifest, "handoff-manifest.schema.json", "persisted handoff manifest");
  const manifest = result.manifest;
  if (manifest.project_id !== preflight.timeline.project_id
    || manifest.handoff_id !== handoffId
    || manifest.base_timeline.path !== CANONICAL_TIMELINE_PATH
    || manifest.base_timeline.version !== preflight.timeline.version
    || manifest.base_timeline.hash !== preflight.timelineHash
    || manifest.approval_snapshot.status !== preflight.approvalRecord.status
    || manifest.capability_profile.profile_id !== preflight.profile.profile_id) {
    fail("PROJECT_MISMATCH", "exported handoff manifest identity does not match guarded canonical inputs");
  }
  const persisted = persistedManifest as unknown as HandoffManifest;
  if (persisted.project_id !== manifest.project_id
    || persisted.handoff_id !== manifest.handoff_id
    || persisted.base_timeline.hash !== manifest.base_timeline.hash) {
    fail("OUTPUT_INVALID", "persisted handoff manifest does not match the exporter result");
  }
}

export function parseArgs(argv: string[]): HandoffExportCliArgs {
  const first = argv[0] ?? "";
  const second = argv[1] ?? "";
  const args = (path.basename(first) === "node" || first === process.execPath)
    && (second.endsWith(".ts") || second.endsWith(".js") || second.includes("handoff-export"))
    ? argv.slice(2)
    : argv;
  const parsed: HandoffExportCliArgs = { check: false, jsonOutput: false, help: false };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--check" || arg === "--read-only") {
      parsed.check = true;
      continue;
    }
    if (arg === "--json") {
      parsed.jsonOutput = true;
      continue;
    }
    if (arg === "--project") {
      const value = args[++index];
      if (!value || value.startsWith("--")) fail("USAGE", `--project requires a value\n${USAGE}`);
      parsed.projectPath = value;
      continue;
    }
    if (arg.startsWith("--project=")) {
      parsed.projectPath = arg.slice("--project=".length);
      if (!parsed.projectPath) fail("USAGE", `--project requires a value\n${USAGE}`);
      continue;
    }
    if (arg === "--profile") {
      const value = args[++index];
      if (!value || value.startsWith("--")) fail("USAGE", `--profile requires a value\n${USAGE}`);
      parsed.profilePath = value;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      parsed.profilePath = arg.slice("--profile=".length);
      if (!parsed.profilePath) fail("USAGE", `--profile requires a value\n${USAGE}`);
      continue;
    }
    if (arg === "--python" || arg === "--python-path") {
      const value = args[++index];
      if (!value || value.startsWith("--")) fail("USAGE", `${arg} requires a value\n${USAGE}`);
      parsed.pythonPath = value;
      continue;
    }
    if (arg.startsWith("-")) fail("USAGE", `unknown option ${arg}\n${USAGE}`);
    positional.push(arg);
  }

  if (parsed.help) return parsed;
  if (positional.length > 1) fail("USAGE", `unexpected argument ${positional[1]}\n${USAGE}`);
  if (positional[0]) {
    if (parsed.projectPath) fail("USAGE", "project path was supplied both positionally and with --project");
    parsed.projectPath = positional[0];
  }
  if (!parsed.projectPath || !parsed.profilePath) {
    fail("USAGE", `--project and --profile are required\n${USAGE}`);
  }
  return parsed;
}

export function runHandoffExportCli(
  argv: string[],
  dependencies: HandoffExportCliDependencies = {},
): HandoffExportCliResult {
  const args = parseArgs(argv);
  if (args.help) fail("USAGE", USAGE);
  const preflight = preflightArgs(args);
  if (args.check) return outputResult(preflight, "check");

  const execute = dependencies.executeExport ?? executeHandoffExport;
  const input: HandoffExportInput = {
    projectPath: preflight.projectRoot,
    projectId: preflight.timeline.project_id,
    timelineVersion: preflight.timeline.version,
    timeline: preflight.timeline,
    approvalRecord: preflight.approvalRecord,
    profilePath: preflight.profilePath,
    sourceMap: preflight.sourceMapEntries,
    ...(args.pythonPath ? { pythonPath: args.pythonPath } : {}),
  };

  let exported: HandoffExportResult | { error: ExportError };
  try {
    exported = execute(input);
  } catch (error) {
    fail("EXPORT_FAILED", `handoff export failed: ${error instanceof Error ? error.message : String(error)}. Resolve the reported bridge/export error and rerun.`, error);
  }
  if (exportErrorResult(exported)) {
    fail(exported.error.code, `${exported.error.message}. Resolve this export gate and rerun; canonical inputs were preflighted before the exporter was called.`, exported.error.details);
  }

  for (const snapshot of preflight.inputSnapshots) {
    assertSnapshotUnchanged(snapshot, path.basename(snapshot.absolutePath));
  }
  if (!exported.readbackValid) {
    fail(
      "READBACK_FAILED",
      `handoff export completed but OTIO readbackValid=false; stable IDs were not verified. Inspect ${relativeProjectPath(preflight.projectRoot, exported.otioPath)} and rerun after fixing the bridge/readback path.`,
      { handoff_id: exported.handoffId, otio_path: exported.otioPath },
    );
  }
  assertExportOutput(preflight, exported);
  return outputResult(preflight, "write", exported);
}

function errorPayload(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof HandoffExportCliError) {
    return { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) };
  }
  return { code: "EXPORT_FAILED", message: error instanceof Error ? error.message : String(error) };
}

export function main(argv = process.argv): void {
  const wantsJson = argv.includes("--json");
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const result = runHandoffExportCli(argv);
    if (args.jsonOutput) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.mode === "check") {
      process.stdout.write("Static handoff readiness: OK (bridge not run; no project writes)\n");
      process.stdout.write(`Project: ${result.project_id}, timeline: ${result.timeline_version}, profile: ${result.profile_id}\n`);
      process.stdout.write(`Output root: ${result.output_root}\n`);
    } else {
      process.stdout.write(`Exported ${result.project_id} timeline ${result.timeline_version}: ${result.handoff_id}\n`);
      process.stdout.write(`Manifest: ${result.manifest_path}\n`);
      process.stdout.write(`OTIO: ${result.otio_path}\n`);
      process.stdout.write("Readback: valid\n");
    }
  } catch (error) {
    const payload = errorPayload(error);
    if (wantsJson) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: payload }, null, 2)}\n`);
    } else {
      process.stderr.write(`${payload.code}: ${payload.message}\n`);
    }
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) main();
