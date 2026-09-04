#!/usr/bin/env npx tsx
/**
 * Owner-operated OTIO handoff import.
 *
 * This command composes the existing importer, diff analyzer, and canonical
 * diff writer for exactly one handoff session. It never applies an NLE edit
 * and never writes 05_timeline/timeline.json.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  parseJsonRejectDuplicateKeys,
  validateAgainstSchema,
} from "../runtime/commands/shared.js";
import {
  deriveReviewRoundsMetric,
  inspectImmutableYamlFile,
  listRevisionDiffCandidates,
  resolveCanonicalDiffIdentity,
  type ReviewRoundEvidence,
} from "../runtime/eval/review-rounds.js";
import {
  analyzeDiffs,
  checkCanonicalHumanRevisionDiffCompatibility,
  validateHumanRevisionDiff,
  writeCanonicalHumanRevisionDiff,
  type DiffAnalysisInput,
  type HumanRevisionDiff,
  type HumanRevisionDiffIdentity,
  type HumanRevisionDiffV2,
} from "../runtime/handoff/diff.js";
import {
  executeHandoffImport,
  type HandoffImportInput,
  type HandoffImportResult,
  type ImportError,
  type RoundtripImportReport,
} from "../runtime/handoff/import/index.js";
import type { NleCapabilityProfile } from "../runtime/handoff/bridge-contract.js";

const HANDOFF_MANIFEST_NAME = "handoff_manifest.yaml";
const EXPORTED_OTIO_NAME = "handoff_timeline.otio";
const REPORT_NAME = "roundtrip_import_report.yaml";
const DIFF_NAME = "human_revision_diff.yaml";
const CANONICAL_TIMELINE_PATH = "05_timeline/timeline.json";
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

const USAGE = [
  "Usage: npx tsx scripts/handoff-import.ts <project-path> --manifest <handoff_manifest.yaml> --imported-otio <imported_handoff.otio> --profile <nle-profile.yaml> [--exported-otio <handoff_timeline.otio>] [--output-dir <dir>] [--identity <identity.json|yaml>] [--python <path>] [--check] [--json]",
  "",
  "  --check       Validate and analyze without writing the report or canonical diff",
  "  --identity    Optional identity-bound review-round identity; otherwise use the latest verified round",
].join("\n");

export interface HandoffImportCliArgs {
  projectPath?: string;
  manifestPath?: string;
  importedOtioPath?: string;
  exportedOtioPath?: string;
  profilePath?: string;
  outputDir?: string;
  identityPath?: string;
  pythonPath?: string;
  check: boolean;
  jsonOutput: boolean;
  help: boolean;
}

export class HandoffImportCliError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HandoffImportCliError";
    this.code = code;
    this.details = details;
  }
}

export interface HandoffImportCliResult {
  ok: true;
  mode: "check" | "write";
  project_id: string;
  handoff_id: string;
  report_path: string;
  canonical_diff_path: string;
  report_written: boolean;
  canonical_diff_written: boolean;
  review_required: boolean;
  import_status: RoundtripImportReport["status"];
  diff_status: HumanRevisionDiff["status"];
  operation_count: number;
  unmapped_edit_count: number;
}

export interface HandoffImportCliDependencies {
  /** Internal test seam; production uses the existing importer unchanged. */
  executeImport?: typeof executeHandoffImport;
  /** Internal test seam; production uses the existing diff analyzer unchanged. */
  analyze?: typeof analyzeDiffs;
  /** Internal test seam; production uses the existing canonical writer unchanged. */
  writeCanonical?: typeof writeCanonicalHumanRevisionDiff;
  /** Internal test seam; production uses the canonical writer's compatibility check. */
  checkCanonical?: typeof checkCanonicalHumanRevisionDiffCompatibility;
  /** Internal test seam for media-free CLI tests; production uses the fixed resolver. */
  validateCanonicalIdentity?: typeof resolveCanonicalDiffIdentity;
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
  sha256: string;
  stat: FileStatSnapshot;
  parentStat: FileStatSnapshot;
  containmentRoot?: string;
}

interface TimelineSnapshot extends SafeFileSnapshot {
  projectId: string;
  version: string;
}

interface Preflight {
  projectRoot: string;
  manifestPath: string;
  importedOtioPath: string;
  exportedOtioPath: string;
  profilePath: string;
  outputDir: string;
  sessionDir: string;
  manifest: Record<string, unknown> & {
    project_id: string;
    handoff_id: string;
    base_timeline: { path: string; version: string; hash: string };
    capability_profile: { profile_id: string };
  };
  profile: NleCapabilityProfile;
  timeline: TimelineSnapshot;
  identity: HumanRevisionDiffIdentity;
  inputSnapshots: SafeFileSnapshot[];
  canonicalDiffPath: string;
  reportPath: string;
}

function fail(code: string, message: string, details?: unknown): never {
  throw new HandoffImportCliError(code, message, details);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
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

function isContained(projectRoot: string, absolutePath: string): boolean {
  const relative = path.relative(projectRoot, absolutePath);
  return relative.length > 0
    && !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`);
}

function assertContainedLexicalPath(projectRoot: string, candidate: string, label: string): string {
  if (candidate.includes("\\")) {
    fail("PATH_ESCAPE", `${label} contains a backslash path alias: ${candidate}`);
  }
  const absolutePath = path.resolve(candidate);
  if (!isContained(projectRoot, absolutePath)) {
    fail("PATH_ESCAPE", `${label} escapes the project root: ${candidate}`);
  }
  return absolutePath;
}

function assertRealDirectoryNamespace(
  projectRoot: string,
  absolutePath: string,
  label: string,
  allowMissing: boolean,
): void {
  if (absolutePath === projectRoot) return;
  if (!isContained(projectRoot, absolutePath)) {
    fail("PATH_ESCAPE", `${label} escapes the project root: ${absolutePath}`);
  }

  const relative = path.relative(projectRoot, absolutePath);
  let current = projectRoot;
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
    if (real !== current || !isContained(projectRoot, real)) {
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
  if (containmentRoot) {
    const root = fs.realpathSync(path.resolve(containmentRoot));
    assertRealDirectoryNamespace(root, path.dirname(resolved), `${label} parent`, false);
  }

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
  if (containmentRoot && !isContained(fs.realpathSync(path.resolve(containmentRoot)), real)) {
    fail("PATH_ESCAPE", `${label} resolves outside the project: ${resolved}`);
  }

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
    sha256: hashBytes(bytes),
    stat: before,
    parentStat: parentBefore,
    ...(containmentRoot ? { containmentRoot: fs.realpathSync(path.resolve(containmentRoot)) } : {}),
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

function parseTimeline(snapshot: SafeFileSnapshot, projectRoot: string): TimelineSnapshot {
  let timeline: unknown;
  try {
    timeline = parseJsonRejectDuplicateKeys(snapshot.bytes.toString("utf8"), "canonical timeline");
  } catch (error) {
    fail("SCHEMA_INVALID", "canonical timeline is not valid JSON", error);
  }
  if (!timeline || typeof timeline !== "object" || Array.isArray(timeline)) {
    fail("SCHEMA_INVALID", "canonical timeline must be a JSON object");
  }
  validateSchemaOrFail(timeline, "timeline-ir.schema.json", "canonical timeline");
  const document = timeline as { project_id?: unknown; version?: unknown };
  if (typeof document.project_id !== "string" || document.project_id.length === 0
    || typeof document.version !== "string" || document.version.length === 0) {
    fail("SCHEMA_INVALID", "canonical timeline must contain non-empty project_id and version strings");
  }
  const expectedPath = path.join(projectRoot, CANONICAL_TIMELINE_PATH);
  if (snapshot.absolutePath !== expectedPath) {
    fail("PATH_INVALID", `canonical timeline must be ${CANONICAL_TIMELINE_PATH}`);
  }
  return {
    ...snapshot,
    projectId: document.project_id,
    version: document.version,
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail("IDENTITY_UNBOUND", `${label} is missing`);
  return value;
}

function requireHash(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!SHA256.test(result)) fail("IDENTITY_INVALID", `${label} is not a sha256 identity`);
  return result;
}

function validateIdentityShape(value: unknown): HumanRevisionDiffIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("IDENTITY_UNBOUND", "identity-bound canonical output requires a mapping identity");
  }
  const identity = value as Record<string, unknown>;
  if ("version" in identity && (identity.version === 1 || identity.version === "1")) {
    fail("V1_IDENTITY", "version 1 identity/diff is never canonical output");
  }
  const base = identity.base_timeline;
  const generation = identity.review_generation;
  const round = identity.review_round;
  if (!base || typeof base !== "object" || Array.isArray(base)
    || !generation || typeof generation !== "object" || Array.isArray(generation)
    || !round || typeof round !== "object" || Array.isArray(round)) {
    fail("IDENTITY_UNBOUND", "identity must bind base timeline, review generation, and review round");
  }
  const baseRecord = base as Record<string, unknown>;
  const generationRecord = generation as Record<string, unknown>;
  const roundRecord = round as Record<string, unknown>;
  const basePath = requireString(baseRecord.path, "identity.base_timeline.path");
  if (basePath !== CANONICAL_TIMELINE_PATH) {
    fail("PATH_INVALID", `identity base timeline path is not canonical: ${basePath}`);
  }
  const generationId = requireHash(generationRecord.generation_id, "identity.review_generation.generation_id");
  const generationDir = `09_output/social-review/generations/${generationId.slice("sha256:".length)}`;
  const output = generationRecord.output;
  const receipt = generationRecord.review_ready_receipt;
  if (!output || typeof output !== "object" || Array.isArray(output)
    || !receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    fail("IDENTITY_UNBOUND", "identity review generation output and receipt bindings are required");
  }
  const outputRecord = output as Record<string, unknown>;
  const receiptRecord = receipt as Record<string, unknown>;
  if (outputRecord.path !== `${generationDir}/review.mp4`) {
    fail("PATH_INVALID", "identity review output path is not canonical");
  }
  if (receiptRecord.path !== `${generationDir}/review-ready-receipt.json`) {
    fail("PATH_INVALID", "identity review-ready receipt path is not canonical");
  }
  const roundIndex = roundRecord.round_index;
  if (typeof roundIndex !== "number" || !Number.isInteger(roundIndex) || roundIndex < 1) {
    fail("IDENTITY_UNBOUND", "identity.review_round.round_index must be a positive integer");
  }
  return {
    base_timeline: {
      path: basePath,
      version: requireString(baseRecord.version, "identity.base_timeline.version"),
      sha256: requireHash(baseRecord.sha256, "identity.base_timeline.sha256"),
    },
    review_generation: {
      generation_id: generationId,
      review_identity: requireHash(generationRecord.review_identity, "identity.review_generation.review_identity"),
      output: {
        path: requireString(outputRecord.path, "identity.review_generation.output.path"),
        sha256: requireHash(outputRecord.sha256, "identity.review_generation.output.sha256"),
      },
      review_ready_receipt: {
        path: requireString(receiptRecord.path, "identity.review_generation.review_ready_receipt.path"),
        sha256: requireHash(receiptRecord.sha256, "identity.review_generation.review_ready_receipt.sha256"),
      },
    },
    review_round: {
      round_index: roundIndex,
      round_identity: requireHash(roundRecord.round_identity, "identity.review_round.round_identity"),
    },
  };
}

function identityFromRound(round: ReviewRoundEvidence): HumanRevisionDiffIdentity {
  return validateIdentityShape({
    base_timeline: {
      path: round.timeline.path,
      version: round.timeline.version,
      sha256: round.timeline.hash,
    },
    review_generation: {
      generation_id: round.generation_id,
      review_identity: round.review_identity,
      output: round.output,
      review_ready_receipt: round.review_ready_receipt,
    },
    review_round: {
      round_index: round.round_index,
      round_identity: round.round_identity,
    },
  });
}

function readExplicitIdentity(snapshot: SafeFileSnapshot): HumanRevisionDiffIdentity {
  const document = parseYamlObject(snapshot.bytes, "identity input");
  if (document.version === 1) fail("V1_IDENTITY", "version 1 identity/diff is never canonical output");
  const candidate = document.identity ?? document;
  return validateIdentityShape(candidate);
}

function deriveLatestIdentity(projectRoot: string, projectId: string, timeline: TimelineSnapshot): HumanRevisionDiffIdentity {
  const derivation = deriveReviewRoundsMetric({
    projectDir: projectRoot,
    projectId,
    timeline: { path: CANONICAL_TIMELINE_PATH, version: timeline.version, hash: timeline.sha256 },
    askPointer: null,
    responsePointer: null,
    revisionDiffCandidates: [],
  });
  if (derivation.metric.status !== "measured" || !derivation.metric.value || derivation.metric.value.rounds.length === 0) {
    fail(
      "IDENTITY_UNBOUND",
      `no verified review round can bind canonical output: ${derivation.metric.limitations[0] ?? "review history unavailable"}`,
    );
  }
  const rounds = [...derivation.metric.value.rounds].sort(
    (left, right) => right.round_index - left.round_index || left.round_identity.localeCompare(right.round_identity, "en"),
  );
  return identityFromRound(rounds[0]!);
}

function assertIdentityMatchesTimeline(
  identity: HumanRevisionDiffIdentity,
  timeline: TimelineSnapshot,
  manifest: { project_id: string; base_timeline: { version: string; hash: string } },
): void {
  if (identity.base_timeline.path !== CANONICAL_TIMELINE_PATH
    || identity.base_timeline.version !== timeline.version
    || identity.base_timeline.sha256 !== timeline.sha256
    || identity.base_timeline.version !== manifest.base_timeline.version
    || identity.base_timeline.sha256 !== manifest.base_timeline.hash) {
    fail("TIMELINE_MISMATCH", "identity base timeline does not match the manifest and canonical timeline");
  }
  if (manifest.project_id !== timeline.projectId) {
    fail("PROJECT_MISMATCH", "manifest project identity does not match canonical timeline");
  }
}

function assertManifestSession(
  projectRoot: string,
  manifestPath: string,
  handoffId: string,
): string {
  if (!SAFE_SEGMENT.test(handoffId)) {
    fail("PATH_INVALID", `handoff_id is not a safe single path segment: ${handoffId}`);
  }
  if (path.basename(manifestPath) !== HANDOFF_MANIFEST_NAME) {
    fail("PATH_INVALID", `manifest filename must be ${HANDOFF_MANIFEST_NAME}`);
  }
  const sessionDir = path.dirname(manifestPath);
  assertRealDirectoryNamespace(projectRoot, sessionDir, "handoff session", false);
  const relativeSession = path.relative(projectRoot, sessionDir).split(path.sep).join("/");
  const expected = `exports/handoffs/${handoffId}`;
  if (relativeSession !== expected) {
    fail("PATH_INVALID", `manifest is not bound to its canonical handoff session: ${relativeSession}`);
  }
  return sessionDir;
}

function assertSessionFile(sessionDir: string, absolutePath: string, label: string): void {
  if (path.dirname(absolutePath) !== sessionDir) {
    fail("PATH_ESCAPE", `${label} must be a direct artifact of the handoff session: ${absolutePath}`);
  }
}

function assertOutputDirectory(projectRoot: string, sessionDir: string, outputDir: string): void {
  if (!isContained(projectRoot, outputDir)) fail("PATH_ESCAPE", `output directory escapes the project: ${outputDir}`);
  if (!isContained(sessionDir, outputDir) && outputDir !== sessionDir) {
    fail("PATH_ESCAPE", `output directory escapes the handoff session: ${outputDir}`);
  }
  assertRealDirectoryNamespace(projectRoot, outputDir, "output", true);
  let outputStats: fs.Stats | undefined;
  try {
    outputStats = fs.lstatSync(outputDir);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      fail("PATH_INVALID", `output is not statable: ${outputDir}`, error);
    }
  }
  if (outputStats && (outputStats.isSymbolicLink() || !outputStats.isDirectory())) {
    fail("PATH_INVALID", `output is not a real directory: ${outputDir}`);
  }
  assertRealDirectoryNamespace(projectRoot, path.join(outputDir, "normalized"), "normalization output", true);
  assertPlannedFileSlot(path.join(outputDir, REPORT_NAME), "roundtrip import report", projectRoot);
}

function assertPlannedFileSlot(absolutePath: string, label: string, projectRoot: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    fail("PATH_INVALID", `${label} is not statable: ${absolutePath}`, error);
  }
  if (stats.isSymbolicLink()) fail("PATH_SYMLINK", `${label} is a symlink: ${absolutePath}`);
  if (!stats.isFile()) fail("PATH_INVALID", `${label} is not a regular file: ${absolutePath}`);
  safeFileSnapshot(absolutePath, label, projectRoot);
}

function assertRevisionDiffCandidates(
  projectRoot: string,
  handoffId: string,
  projectId?: string,
  expectedIdentity?: HumanRevisionDiffIdentity,
): void {
  for (const searchRoot of ["exports/handoffs", "07_handoff"]) {
    assertRealDirectoryNamespace(
      projectRoot,
      path.join(projectRoot, searchRoot),
      "human_revision_diff discovery root",
      true,
    );
  }
  const discoveryErrors: string[] = [];
  let candidates: string[];
  try {
    candidates = listRevisionDiffCandidates(projectRoot, (_code, message, evidence) => {
      discoveryErrors.push(`${message}${evidence.length > 0 ? ` [${evidence.join(", ")}]` : ""}`);
    });
  } catch (error) {
    fail("DIFF_CANDIDATE_INVALID", "human_revision_diff discovery failed closed", error);
  }
  if (discoveryErrors.length > 0) {
    fail("PATH_SYMLINK", "human_revision_diff discovery found a symlink or path escape", discoveryErrors);
  }
  const target = `07_handoff/${handoffId}/${DIFF_NAME}`;
  if (candidates.length > 1) {
    fail("MULTIPLE_DIFF_CANDIDATES", `multiple human_revision_diff candidates exist: ${candidates.join(", ")}`, candidates);
  }
  if (candidates.length === 1 && candidates[0] !== target) {
    fail("DIFF_CANDIDATE_INVALID", `foreign human_revision_diff candidate exists: ${candidates[0]}`);
  }
  if (candidates[0] !== target) return;

  const existing = inspectImmutableYamlFile(projectRoot, target);
  if ("error" in existing) fail("DIFF_CANDIDATE_INVALID", `existing canonical diff failed immutable inspection: ${existing.error}`);
  validateSchemaOrFail(existing.document, "human-revision-diff.schema.json", "existing canonical human_revision_diff");
  const document = existing.document as Record<string, unknown>;
  if (document.version !== 2) fail("V1_IDENTITY", "version 1 human_revision_diff is never canonical output");
  if (typeof document.project_id !== "string") fail("DIFF_CANDIDATE_INVALID", "existing canonical diff has no project identity");
  if (projectId && document.project_id !== projectId) fail("DIFF_CANDIDATE_INVALID", "existing canonical diff project identity does not match the handoff");
  if (document.handoff_id !== handoffId) fail("DIFF_CANDIDATE_INVALID", "existing canonical diff handoff identity does not match its folder");
  if (!document.identity || typeof document.identity !== "object" || Array.isArray(document.identity)) {
    fail("IDENTITY_UNBOUND", "existing canonical diff lacks identity bindings");
  }
  if (expectedIdentity) {
    const existingIdentity = validateIdentityShape(document.identity);
    if (JSON.stringify(existingIdentity) !== JSON.stringify(expectedIdentity)) {
      fail("IDENTITY_MISMATCH", "existing canonical diff identity is stale or foreign to this handoff");
    }
  }
}

function assertImportResult(result: HandoffImportResult, preflight: Preflight, outputDir: string): SafeFileSnapshot {
  validateSchemaOrFail(result.report, "roundtrip-import-report.schema.json", "roundtrip import report");
  if (result.report.project_id !== preflight.manifest.project_id
    || result.report.handoff_id !== preflight.manifest.handoff_id
    || result.report.base_timeline.version !== preflight.manifest.base_timeline.version
    || result.report.base_timeline.hash !== preflight.manifest.base_timeline.hash
    || result.report.capability_profile_id !== preflight.profile.profile_id) {
    fail("PROJECT_MISMATCH", "roundtrip import report identity does not match the handoff inputs");
  }
  if (!result.normalizedImport
    || typeof result.normalizedImport !== "object"
    || !Array.isArray(result.normalizedImport.clips)) {
    fail("SCHEMA_INVALID", "normalized imported OTIO result is not a typed clip document");
  }
  if (!result.normalizedExport
    || typeof result.normalizedExport !== "object"
    || !Array.isArray(result.normalizedExport.clips)) {
    fail("SCHEMA_INVALID", "normalized exported OTIO result is not a typed clip document");
  }
  if (!Array.isArray(result.mappedClips)
    || !result.oneToMany
    || !Array.isArray(result.oneToMany.oneToOne)
    || !Array.isArray(result.oneToMany.splitEntries)
    || !Array.isArray(result.oneToMany.duplicateEntries)
    || !Array.isArray(result.oneToMany.ambiguousEntries)
    || !Array.isArray(result.unmappedClips)) {
    fail("SCHEMA_INVALID", "normalized import mapping result is incomplete");
  }
  if (result.normalizedImport.project_id !== preflight.manifest.project_id
    || result.normalizedImport.handoff_id !== preflight.manifest.handoff_id
    || result.normalizedImport.timeline_version !== preflight.manifest.base_timeline.version) {
    fail("PROJECT_MISMATCH", "normalized imported OTIO metadata does not match the handoff session");
  }
  if (result.normalizedExport.project_id !== preflight.manifest.project_id
    || result.normalizedExport.handoff_id !== preflight.manifest.handoff_id
    || result.normalizedExport.timeline_version !== preflight.manifest.base_timeline.version) {
    fail("PROJECT_MISMATCH", "normalized exported OTIO metadata does not match the handoff session");
  }
  const expectedReportPath = path.resolve(outputDir, REPORT_NAME);
  if (path.resolve(result.reportPath) !== expectedReportPath) {
    fail("PATH_INVALID", `import report was not written to the planned output: ${result.reportPath}`);
  }
  const reportFile = safeFileSnapshot(
    result.reportPath,
    "roundtrip import report",
    outputDir === preflight.outputDir ? preflight.projectRoot : undefined,
  );
  const persistedReport = parseYamlObject(reportFile.bytes, "roundtrip import report");
  validateSchemaOrFail(persistedReport, "roundtrip-import-report.schema.json", "persisted roundtrip import report");
  return reportFile;
}

function mappingRequiresReview(result: HandoffImportResult): boolean {
  return result.mappedClips.some((mapping) => mapping.confidence === "provisional")
    || result.oneToMany.ambiguousEntries.length > 0
    || result.report.mapping_summary.provisional_matches > 0
    || result.report.mapping_summary.ambiguous_one_to_many_items > 0;
}

function buildDiffInput(
  result: HandoffImportResult,
  preflight: Preflight,
): DiffAnalysisInput {
  return {
    projectId: preflight.manifest.project_id,
    handoffId: preflight.manifest.handoff_id,
    baseTimelineVersion: preflight.manifest.base_timeline.version,
    capabilityProfileId: preflight.profile.profile_id,
    profile: preflight.profile,
    exportedClips: result.normalizedExport!.clips,
    oneToOne: result.oneToMany.oneToOne,
    oneToMany: result.oneToMany,
    unmappedClips: result.unmappedClips,
    importReport: result.report,
    identity: preflight.identity,
  };
}

function parseValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) fail("USAGE", `${option} requires a value\n${USAGE}`);
  return value;
}

function stripProcessPrefix(argv: string[]): string[] {
  const first = argv[0] ?? "";
  const second = argv[1] ?? "";
  if ((path.basename(first) === "node" || first === process.execPath)
    && (second.endsWith(".ts") || second.endsWith(".js") || second.includes("handoff-import"))) {
    return argv.slice(2);
  }
  return argv;
}

export function parseArgs(argv: string[]): HandoffImportCliArgs {
  const args = stripProcessPrefix(argv);
  const parsed: HandoffImportCliArgs = { check: false, jsonOutput: false, help: false };
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
      parsed.projectPath = parseValue(args, ++index, arg);
      continue;
    }
    if (arg === "--manifest" || arg === "--handoff-manifest") {
      parsed.manifestPath = parseValue(args, ++index, arg);
      continue;
    }
    if (arg === "--imported-otio" || arg === "--imported") {
      parsed.importedOtioPath = parseValue(args, ++index, arg);
      continue;
    }
    if (arg === "--exported-otio" || arg === "--exported") {
      parsed.exportedOtioPath = parseValue(args, ++index, arg);
      continue;
    }
    if (arg === "--profile") {
      parsed.profilePath = parseValue(args, ++index, arg);
      continue;
    }
    if (arg === "--output-dir") {
      parsed.outputDir = parseValue(args, ++index, arg);
      continue;
    }
    if (arg === "--identity") {
      parsed.identityPath = parseValue(args, ++index, arg);
      continue;
    }
    if (arg === "--python" || arg === "--python-path") {
      parsed.pythonPath = parseValue(args, ++index, arg);
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
  if (!parsed.projectPath || !parsed.manifestPath || !parsed.importedOtioPath || !parsed.profilePath) {
    fail("USAGE", `project path, --manifest, --imported-otio, and --profile are required\n${USAGE}`);
  }
  return parsed;
}

function resolveProjectRoot(projectPath: string): string {
  const lexical = path.resolve(projectPath);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(lexical);
  } catch (error) {
    fail("PROJECT_NOT_FOUND", `project is not statable: ${lexical}`, error);
  }
  if (!stats.isDirectory()) fail("PROJECT_INVALID", `project is not a directory: ${lexical}`);
  try {
    return fs.realpathSync(lexical);
  } catch (error) {
    fail("PROJECT_INVALID", `project is not resolvable: ${lexical}`, error);
  }
}

function preflightArgs(
  args: HandoffImportCliArgs,
  identityValidator: typeof resolveCanonicalDiffIdentity = resolveCanonicalDiffIdentity,
): Preflight {
  const projectRoot = resolveProjectRoot(args.projectPath!);
  const manifestPath = assertContainedLexicalPath(projectRoot, args.manifestPath!, "manifest");
  const manifestFile = safeFileSnapshot(manifestPath, "handoff manifest", projectRoot);
  const manifestDocument = parseYamlObject(manifestFile.bytes, "handoff manifest");
  validateSchemaOrFail(manifestDocument, "handoff-manifest.schema.json", "handoff manifest");
  const manifest = manifestDocument as Preflight["manifest"];
  const sessionDir = assertManifestSession(projectRoot, manifestPath, manifest.handoff_id);

  const timelinePath = path.join(projectRoot, CANONICAL_TIMELINE_PATH);
  const timelineFile = safeFileSnapshot(timelinePath, "canonical timeline", projectRoot);
  const timeline = parseTimeline(timelineFile, projectRoot);
  if (manifest.project_id !== timeline.projectId) fail("PROJECT_MISMATCH", "manifest project identity does not match canonical timeline");
  if (manifest.base_timeline.path !== CANONICAL_TIMELINE_PATH) fail("PATH_INVALID", "manifest base timeline path is not canonical");
  if (manifest.base_timeline.version !== timeline.version || manifest.base_timeline.hash !== timeline.sha256) {
    fail("TIMELINE_MISMATCH", "manifest base timeline version/hash does not match canonical timeline");
  }

  const profilePath = path.resolve(args.profilePath!);
  const profileFile = safeFileSnapshot(profilePath, "capability profile");
  const profileDocument = parseYamlObject(profileFile.bytes, "capability profile");
  validateSchemaOrFail(profileDocument, "nle-capability-profile.schema.json", "capability profile");
  const profile = profileDocument as unknown as NleCapabilityProfile;
  if (manifest.capability_profile.profile_id !== profile.profile_id) {
    fail("PROJECT_MISMATCH", "capability profile identity does not match the handoff manifest");
  }

  const importedOtioPath = assertContainedLexicalPath(projectRoot, args.importedOtioPath!, "imported OTIO");
  assertSessionFile(sessionDir, importedOtioPath, "imported OTIO");
  const importedFile = safeFileSnapshot(importedOtioPath, "imported OTIO", projectRoot);

  const exportedOtioPath = assertContainedLexicalPath(
    projectRoot,
    args.exportedOtioPath ?? path.join(sessionDir, EXPORTED_OTIO_NAME),
    "exported OTIO",
  );
  assertSessionFile(sessionDir, exportedOtioPath, "exported OTIO");
  const exportedFile = safeFileSnapshot(exportedOtioPath, "exported OTIO", projectRoot);

  const outputDir = path.resolve(args.outputDir ?? sessionDir);
  assertOutputDirectory(projectRoot, sessionDir, outputDir);
  const reportPath = path.join(outputDir, REPORT_NAME);
  const canonicalDiffPath = `07_handoff/${manifest.handoff_id}/${DIFF_NAME}`;

  let identity: HumanRevisionDiffIdentity;
  let identityFile: SafeFileSnapshot | undefined;
  if (args.identityPath) {
    const identityPath = assertContainedLexicalPath(projectRoot, args.identityPath, "identity input");
    identityFile = safeFileSnapshot(identityPath, "identity input", projectRoot);
    identity = readExplicitIdentity(identityFile);
  } else {
    identity = deriveLatestIdentity(projectRoot, manifest.project_id, timeline);
  }
  assertIdentityMatchesTimeline(identity, timeline, manifest);

  try {
    identityValidator(projectRoot, manifest.project_id, identity);
  } catch (error) {
    fail("IDENTITY_MISMATCH", `identity does not resolve to a verified review round: ${error instanceof Error ? error.message : String(error)}`, error);
  }

  assertRevisionDiffCandidates(projectRoot, manifest.handoff_id, manifest.project_id, identity);
  return {
    projectRoot,
    manifestPath,
    importedOtioPath,
    exportedOtioPath,
    profilePath,
    outputDir,
    sessionDir,
    manifest,
    profile,
    timeline,
    identity,
    inputSnapshots: [manifestFile, timelineFile, profileFile, importedFile, exportedFile, ...(identityFile ? [identityFile] : [])],
    canonicalDiffPath,
    reportPath,
  };
}

function importErrorResult(value: HandoffImportResult | { error: ImportError }): value is { error: ImportError } {
  return "error" in value;
}

function mainErrorMessage(error: unknown): string {
  if (error instanceof HandoffImportCliError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function runHandoffImportCli(
  argv: string[],
  dependencies: HandoffImportCliDependencies = {},
): HandoffImportCliResult {
  const args = parseArgs(argv);
  if (args.help) fail("USAGE", USAGE);
  const execute = dependencies.executeImport ?? executeHandoffImport;
  const analyze = dependencies.analyze ?? analyzeDiffs;
  const writer = dependencies.writeCanonical ?? writeCanonicalHumanRevisionDiff;
  const checkCanonical = dependencies.checkCanonical ?? checkCanonicalHumanRevisionDiffCompatibility;
  const identityValidator = dependencies.validateCanonicalIdentity ?? resolveCanonicalDiffIdentity;
  const preflight = preflightArgs(args, identityValidator);

  let temporaryOutputDir: string | undefined;
  const outputDir = args.check
    ? (temporaryOutputDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "handoff-import-check-"))))
    : preflight.outputDir;

  try {
    const importInput: HandoffImportInput = {
      manifestPath: preflight.manifestPath,
      importedOtioPath: preflight.importedOtioPath,
      exportedOtioPath: preflight.exportedOtioPath,
      profilePath: preflight.profilePath,
      outputDir,
      pythonPath: args.pythonPath,
    };
    let imported: HandoffImportResult | { error: ImportError };
    try {
      imported = execute(importInput);
    } catch (error) {
      fail("IMPORT_FAILED", `handoff import failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    if (importErrorResult(imported)) {
      fail(imported.error.code, imported.error.message, imported.error.details);
    }

    for (const snapshot of preflight.inputSnapshots) assertSnapshotUnchanged(snapshot, path.basename(snapshot.absolutePath));
    assertSnapshotUnchanged(preflight.timeline, "canonical timeline");
    const reportSnapshot = assertImportResult(imported, preflight, outputDir);
    if (imported.report.status === "failed") {
      fail("IMPORT_FAILED", "handoff import report is failed; canonical human_revision_diff publication is blocked");
    }

    let diff: HumanRevisionDiff;
    try {
      diff = analyze(buildDiffInput(imported, preflight));
      validateHumanRevisionDiff(diff);
    } catch (error) {
      fail("SCHEMA_INVALID", `analyzed human_revision_diff is invalid: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    validateSchemaOrFail(diff, "human-revision-diff.schema.json", "analyzed human_revision_diff");
    if (diff.version !== 2) {
      fail("V1_IDENTITY", "analyzed version 1 human_revision_diff is never canonical output");
    }
    const identityBoundDiff = diff as HumanRevisionDiffV2;
    if (diff.project_id !== preflight.manifest.project_id
      || diff.handoff_id !== preflight.manifest.handoff_id
      || diff.base_timeline_version !== preflight.manifest.base_timeline.version
      || JSON.stringify(identityBoundDiff.identity) !== JSON.stringify(preflight.identity)) {
      fail("IDENTITY_MISMATCH", "analyzed diff identity does not match the guarded handoff identity");
    }

    for (const snapshot of preflight.inputSnapshots) assertSnapshotUnchanged(snapshot, path.basename(snapshot.absolutePath));
    assertSnapshotUnchanged(preflight.timeline, "canonical timeline");
    assertSnapshotUnchanged(reportSnapshot, "roundtrip import report");
    assertRevisionDiffCandidates(
      preflight.projectRoot,
      preflight.manifest.handoff_id,
      preflight.manifest.project_id,
      preflight.identity,
    );
    try {
      identityValidator(preflight.projectRoot, preflight.manifest.project_id, preflight.identity);
    } catch (error) {
      fail("IDENTITY_MISMATCH", `identity changed or no longer resolves before publication: ${error instanceof Error ? error.message : String(error)}`, error);
    }

    if (mappingRequiresReview(imported)) {
      fail("IMPORT_MAPPING_REVIEW_REQUIRED", "canonical diff publication is blocked because import mapping is provisional or ambiguous");
    }

    if (args.check) {
      try {
        checkCanonical(preflight.projectRoot, {
          handoffId: preflight.manifest.handoff_id,
          diff,
        });
      } catch (error) {
        fail("CANONICAL_WRITE_FAILED", `canonical human_revision_diff is not compatible with the planned output: ${error instanceof Error ? error.message : String(error)}`, error);
      }
      return {
        ok: true,
        mode: "check",
        project_id: preflight.manifest.project_id,
        handoff_id: preflight.manifest.handoff_id,
        report_path: path.relative(preflight.projectRoot, preflight.reportPath).split(path.sep).join("/"),
        canonical_diff_path: preflight.canonicalDiffPath,
        report_written: false,
        canonical_diff_written: false,
        review_required: imported.reviewRequired,
        import_status: imported.report.status,
        diff_status: diff.status,
        operation_count: diff.operations?.length ?? 0,
        unmapped_edit_count: diff.unmapped_edits?.length ?? 0,
      };
    }

    let written: ReturnType<typeof writeCanonicalHumanRevisionDiff>;
    try {
      written = writer(preflight.projectRoot, { handoffId: preflight.manifest.handoff_id, diff });
    } catch (error) {
      fail("CANONICAL_WRITE_FAILED", `canonical human_revision_diff was not published: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    if (written.relativePath !== preflight.canonicalDiffPath) {
      fail("PATH_INVALID", `canonical writer returned an unexpected path: ${written.relativePath}`);
    }
    assertSnapshotUnchanged(preflight.timeline, "canonical timeline");
    return {
      ok: true,
      mode: "write",
      project_id: preflight.manifest.project_id,
      handoff_id: preflight.manifest.handoff_id,
      report_path: path.relative(preflight.projectRoot, preflight.reportPath).split(path.sep).join("/"),
      canonical_diff_path: preflight.canonicalDiffPath,
      report_written: true,
      canonical_diff_written: true,
      review_required: imported.reviewRequired,
      import_status: imported.report.status,
      diff_status: diff.status,
      operation_count: diff.operations?.length ?? 0,
      unmapped_edit_count: diff.unmapped_edits?.length ?? 0,
    };
  } finally {
    if (temporaryOutputDir) fs.rmSync(temporaryOutputDir, { recursive: true, force: true });
  }
}

export function main(argv = process.argv): void {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const result = runHandoffImportCli(argv);
    if (parsed.jsonOutput) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Imported ${result.handoff_id}: ${result.import_status}; diff ${result.diff_status}\n`);
      process.stdout.write(`Report: ${result.report_path}\n`);
      process.stdout.write(`Canonical diff${result.mode === "check" ? " (planned)" : ""}: ${result.canonical_diff_path}\n`);
    }
  } catch (error) {
    process.stderr.write(`${mainErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) main();
