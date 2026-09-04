// Assembly-loss project adapter + practical CLI — Issue #11 Phase 2 M2B.
//
// Connects the accepted pure core (M2A `evaluateAssemblyLoss`) to real
// project artifacts and produces a hash-pinned NON-canonical diagnostic
// report (`assembly-loss-report/v1`). This is NOT a new canonical artifact
// and NOT a new schema: it is a diagnostic envelope around the accepted
// core report, written under reports/eval (or --output-dir) only.
//
// Contract:
//  - Required inputs are read with the existing validated loaders:
//    01_intent/creative_brief.yaml, 04_plan/selects_candidates.yaml,
//    04_plan/edit_blueprint.yaml, 05_timeline/timeline.json.
//    Missing/malformed required inputs fail closed.
//  - 03_analysis/transcripts/TR_*.json are filename-sorted and losslessly
//    mapped (transcript_ref/asset_id/items -> transcript_id/asset_id/
//    utterances). Directory absent or 0 files => optional absent, fail-open.
//    A PRESENT but malformed transcript fails closed.
//  - The default 03_analysis/analysis_coverage_report.json is read as an
//    object when present; --analysis-coverage overrides it (explicit files
//    must exist and be well-formed: fail closed).
//  - Every input file's raw-byte SHA256 and project-relative path are
//    recorded as sorted source_artifacts at the head of the envelope.
//    Absolute paths never appear in the report.
//  - No wall clock, no RNG, no absolute paths: same input + policy =>
//    identical JSON/MD bytes and identical output paths.
//  - HOLD is a valid diagnostic (exit 0) carrying an explicit grounding
//    note; only input/IO/validation errors exit 1.
//  - Writes are atomic (temp + rename); no temp file survives a failure.
//  - The report never contains a self-hash; each completed file gets a
//    detached `<file>.sha256` sidecar ("<hex>  <basename>\n").
//  - audio_story_graph node edges are never converted into beat edges and
//    wall-clock is never inferred from execution time.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { canonicalJson } from "./editorial-eye-suite.js";
import {
  loadBlueprintData,
  validateArtifact,
} from "../artifacts/loaders.js";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "../artifacts/types.js";
import {
  ASSEMBLY_LOSS_EVALUATOR_VERSION,
  evaluateAssemblyLoss,
  type AnalysisCoverageInput,
  type AssemblyLossInput,
  type AssemblyLossReport,
  type AssemblyLossTranscript,
  type AssemblyLossUtterance,
  type CausalEdgeRef,
  type HumanStructuralReference,
  type WallClockBreakdown,
} from "./assembly-loss.js";

export const ASSEMBLY_LOSS_REPORT_KIND = "assembly-loss-report/v1" as const;

/** Explicit note attached to the envelope whenever the verdict is HOLD. */
export const ASSEMBLY_LOSS_HOLD_NOTE =
  "接地失敗下の観測であり、auto assemblyの評価としては未確定。";

// ── Types ───────────────────────────────────────────────────────────

export interface AssemblyLossSourceArtifact {
  /** Project-relative POSIX path (never absolute). */
  path: string;
  /** SHA-256 of the raw file bytes. */
  sha256: string;
}

export interface AssemblyLossProjectReport {
  report_kind: typeof ASSEMBLY_LOSS_REPORT_KIND;
  /** Always false: this envelope is a diagnostic, never a source of truth. */
  canonical: false;
  project_id: string;
  /** Sorted by path; envelope head. */
  source_artifacts: AssemblyLossSourceArtifact[];
  /** Duplicated envelope binding checked before any report consumption. */
  report_identity: {
    evaluator_version: typeof ASSEMBLY_LOSS_EVALUATOR_VERSION;
    input_hash: string;
    policy_hash: string;
    /** Hash of every report field except report_identity itself. */
    payload_hash: string;
  };
  accepted_core_report: AssemblyLossReport;
  /** Present only when the verdict is HOLD. */
  note?: string;
}

export interface LoadedProjectInputs {
  brief: CreativeBrief;
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
  timeline: TimelineIR;
  transcripts: AssemblyLossTranscript[];
  analysisCoverage: AnalysisCoverageInput | null;
  /** Parsed from the same raw Buffer hashed into sourceArtifacts when file-backed. */
  humanReference?: HumanStructuralReference | null;
  wallClock?: WallClockBreakdown | null;
  sourceArtifacts: AssemblyLossSourceArtifact[];
}

export interface BuildOptions {
  causalRefs?: CausalEdgeRef[] | null;
  humanReference?: HumanStructuralReference | null;
  wallClock?: WallClockBreakdown | null;
  asrToleranceUs?: number | null;
}

export interface WrittenOutputs {
  jsonPath: string;
  mdPath: string;
  jsonSha256Path: string;
  mdSha256Path: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function sha256Hex(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function projectRelative(projectDir: string, filePath: string): string {
  return toPosix(path.relative(path.resolve(projectDir), path.resolve(filePath)));
}

// ── Loader ──────────────────────────────────────────────────────────

const REQUIRED_ARTIFACTS = {
  brief: "01_intent/creative_brief.yaml",
  selects: "04_plan/selects_candidates.yaml",
  blueprint: "04_plan/edit_blueprint.yaml",
  timeline: "05_timeline/timeline.json",
} as const;

const TRANSCRIPTS_DIR = "03_analysis/transcripts";
const DEFAULT_COVERAGE_PATH = "03_analysis/analysis_coverage_report.json";
const TRANSCRIPT_FILENAME = /^TR_.*\.json$/;

function requireFiniteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

/**
 * Validate and losslessly map one TR_*.json transcript artifact into the
 * evaluator's transcript shape. Present-but-malformed files fail closed.
 */
function mapTranscriptFile(fileName: string, raw: string): AssemblyLossTranscript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`assembly-loss: transcript ${fileName} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`assembly-loss: transcript ${fileName} must be a JSON object`);
  }
  const value = parsed as Record<string, unknown>;
  const transcriptRef = value.transcript_ref;
  const assetId = value.asset_id;
  const items = value.items;
  if (typeof transcriptRef !== "string" || transcriptRef.length === 0) {
    throw new Error(`assembly-loss: transcript ${fileName} needs a non-empty string transcript_ref`);
  }
  if (typeof assetId !== "string" || assetId.length === 0) {
    throw new Error(`assembly-loss: transcript ${fileName} needs a non-empty string asset_id`);
  }
  if (!Array.isArray(items)) {
    throw new Error(`assembly-loss: transcript ${fileName} needs an items array`);
  }
  const utterances: AssemblyLossUtterance[] = items.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`assembly-loss: transcript ${fileName} item ${index} must be an object`);
    }
    const entry = item as Record<string, unknown>;
    const startUs = requireFiniteNonNegative(entry.start_us, `transcript ${fileName} item ${index}.start_us`);
    const endUs = requireFiniteNonNegative(entry.end_us, `transcript ${fileName} item ${index}.end_us`);
    if (endUs - startUs < 0) {
      throw new Error(`assembly-loss: transcript ${fileName} item ${index} has negative duration`);
    }
    if (typeof entry.text !== "string") {
      throw new Error(`assembly-loss: transcript ${fileName} item ${index}.text must be a string`);
    }
    const speaker = entry.speaker;
    if (speaker !== undefined && typeof speaker !== "string") {
      throw new Error(`assembly-loss: transcript ${fileName} item ${index}.speaker must be a string`);
    }
    return {
      ...(speaker !== undefined ? { speaker } : {}),
      start_us: startUs,
      end_us: endUs,
      text: entry.text,
    };
  });
  // Lossless map: transcript_ref -> transcript_id, asset_id -> asset_id,
  // items -> utterances (speaker/start_us/end_us/text preserved verbatim).
  return { transcript_id: transcriptRef, asset_id: assetId, utterances };
}

export interface LoadProjectInputsOptions {
  /** Explicit analysis-coverage JSON path; must exist and be well-formed. */
  analysisCoverageOverride?: string | null;
  humanReferenceFile?: string | null;
  wallClockFile?: string | null;
  /**
   * Injected for tests; defaults to fs.readFileSync. Every input file is
   * read EXACTLY once and the same Buffer feeds both hashing and
   * parse/validation (no double reads anywhere).
   */
  readFile?: (filePath: string) => Buffer;
}

/** Logical locator for input files that live outside the project root. */
const EXTERNAL_COVERAGE_LOCATOR = "@external/analysis-coverage";
export const HUMAN_REFERENCE_INPUT_LOCATOR = "cli-inputs/human-reference.json";
export const WALL_CLOCK_INPUT_LOCATOR = "cli-inputs/wall-clock.json";

interface FileIdentity {
  realPath: string;
  dev: number;
  ino: number;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function lstatRequired(filePath: string, label: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`assembly-loss: ${label} not found: ${filePath}`);
    }
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`assembly-loss: ${label} must not be a symlink: ${filePath}`);
  }
  return stat;
}

function assertNoSymlinkBelow(root: string, target: string, label: string): void {
  if (!isPathInside(root, target)) {
    throw new Error(`assembly-loss: ${label} escapes project root: ${target}`);
  }
  const rel = path.relative(root, target);
  let cursor = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    lstatRequired(cursor, label);
  }
}

function captureInputIdentity(
  filePath: string,
  label: string,
  projectRoot?: { lexical: string; real: string },
): FileIdentity {
  const resolved = path.resolve(filePath);
  if (projectRoot) assertNoSymlinkBelow(projectRoot.lexical, resolved, label);
  const stat = lstatRequired(resolved, label);
  if (!stat.isFile()) throw new Error(`assembly-loss: ${label} must be a regular file: ${resolved}`);
  const realPath = fs.realpathSync(resolved);
  if (projectRoot && !isPathInside(projectRoot.real, realPath)) {
    throw new Error(`assembly-loss: ${label} realpath escapes project root: ${resolved}`);
  }
  return { realPath, dev: stat.dev, ino: stat.ino };
}

function assertInputIdentityUnchanged(filePath: string, label: string, before: FileIdentity): void {
  const stat = lstatRequired(filePath, label);
  const realPath = fs.realpathSync(filePath);
  if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || realPath !== before.realPath) {
    throw new Error(`assembly-loss: ${label} path identity changed during read`);
  }
}

function sourceLocator(root: string, filePath: string): string {
  const rel = path.relative(root, path.resolve(filePath));
  // Out-of-project inputs (today: coverage overrides) never leak real
  // relative paths or ".." segments into the report.
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return EXTERNAL_COVERAGE_LOCATOR;
  }
  return toPosix(rel);
}

/**
 * Load all project inputs for the assembly-loss evaluator. Required
 * artifacts are parsed from the same raw Buffer that produced their
 * source-artifact hash and validated against the canonical schemas
 * (creative-brief / selects-candidates / edit-blueprint via
 * loadBlueprintData / timeline-ir). Transcripts follow the
 * optional-absent fail-open / present-malformed fail-closed discipline.
 * The analysis coverage report is validated against the existing
 * analysis-coverage-report schema and its summary.status is normalized
 * to the top-level status the core evaluator consumes; a present report
 * missing that shape fails closed.
 */
export function loadProjectInputs(
  projectDir: string,
  options: LoadProjectInputsOptions = {},
): LoadedProjectInputs {
  const root = path.resolve(projectDir);
  const rootStat = lstatRequired(root, "project directory");
  if (!rootStat.isDirectory()) {
    throw new Error(`assembly-loss: project directory not found: ${root}`);
  }
  const projectRoot = { lexical: root, real: fs.realpathSync(root) };
  const read = options.readFile ?? ((filePath: string): Buffer => fs.readFileSync(filePath));

  const readVerified = (
    filePath: string,
    label: string,
    confineToProject = true,
  ): Buffer => {
    const identity = captureInputIdentity(
      filePath,
      label,
      confineToProject ? projectRoot : undefined,
    );
    const bytes = read(filePath);
    assertInputIdentityUnchanged(filePath, label, identity);
    return bytes;
  };

  const sourceArtifacts: AssemblyLossSourceArtifact[] = [];
  const recordArtifact = (filePath: string, bytes: Buffer): void => {
    sourceArtifacts.push({ path: sourceLocator(root, filePath), sha256: sha256Hex(bytes) });
  };

  const briefPath = path.join(root, REQUIRED_ARTIFACTS.brief);
  const selectsPath = path.join(root, REQUIRED_ARTIFACTS.selects);
  const blueprintPath = path.join(root, REQUIRED_ARTIFACTS.blueprint);
  const timelinePath = path.join(root, REQUIRED_ARTIFACTS.timeline);
  for (const requiredPath of [briefPath, selectsPath, blueprintPath, timelinePath]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(
        `assembly-loss: required artifact not found: ${projectRelative(root, requiredPath)}`,
      );
    }
  }

  // One read per file: the same Buffer is hashed and parsed/validated.
  const briefBytes = readVerified(briefPath, REQUIRED_ARTIFACTS.brief);
  recordArtifact(briefPath, briefBytes);
  const brief = validateArtifact<CreativeBrief>(parseYaml(briefBytes.toString("utf-8")), "creative-brief.schema.json");

  const selectsBytes = readVerified(selectsPath, REQUIRED_ARTIFACTS.selects);
  recordArtifact(selectsPath, selectsBytes);
  const selects = validateArtifact<SelectsCandidates>(parseYaml(selectsBytes.toString("utf-8")), "selects-candidates.schema.json");

  const blueprintBytes = readVerified(blueprintPath, REQUIRED_ARTIFACTS.blueprint);
  recordArtifact(blueprintPath, blueprintBytes);
  const blueprint = loadBlueprintData(parseYaml(blueprintBytes.toString("utf-8")));

  const timelineBytes = readVerified(timelinePath, REQUIRED_ARTIFACTS.timeline);
  recordArtifact(timelinePath, timelineBytes);
  const timeline = validateArtifact<TimelineIR>(JSON.parse(timelineBytes.toString("utf-8")), "timeline-ir.schema.json");

  // Transcripts: filename-sorted TR_*.json. Absent dir / 0 files fail open.
  const transcripts: AssemblyLossTranscript[] = [];
  const transcriptsDir = path.join(root, TRANSCRIPTS_DIR);
  if (fs.existsSync(transcriptsDir)) {
    assertNoSymlinkBelow(root, transcriptsDir, "transcripts directory");
    const transcriptsStat = lstatRequired(transcriptsDir, "transcripts directory");
    if (!transcriptsStat.isDirectory()) {
      throw new Error(`assembly-loss: transcripts directory must be a directory: ${transcriptsDir}`);
    }
    const fileNames = fs
      .readdirSync(transcriptsDir)
      .filter((name) => TRANSCRIPT_FILENAME.test(name))
      .sort();
    for (const fileName of fileNames) {
      const filePath = path.join(transcriptsDir, fileName);
      const bytes = readVerified(filePath, `transcript ${fileName}`);
      recordArtifact(filePath, bytes);
      transcripts.push(mapTranscriptFile(fileName, bytes.toString("utf-8")));
    }
  }

  // Analysis coverage: default path when present, explicit override wins.
  // Validated against the existing analysis-coverage-report schema; the
  // core evaluator's top-level status is normalized from summary.status.
  let analysisCoverage: AnalysisCoverageInput | null = null;
  const loadCoverage = (filePath: string, label: string): AnalysisCoverageInput => {
    const resolved = path.resolve(filePath);
    const bytes = readVerified(filePath, label, isPathInside(root, resolved));
    recordArtifact(filePath, bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf-8"));
    } catch (err) {
      throw new Error(`assembly-loss: ${label} is not valid JSON: ${(err as Error).message}`);
    }
    const report = validateArtifact<Record<string, unknown>>(parsed, "analysis-coverage-report.schema.json");
    const summaryStatus = (report.summary as { status?: unknown } | undefined)?.status;
    if (typeof summaryStatus !== "string" || summaryStatus.length === 0) {
      throw new Error(`assembly-loss: ${label} is missing summary.status`);
    }
    // Normalize summary.status to the top-level status the core reads.
    return { ...report, status: summaryStatus } as AnalysisCoverageInput;
  };
  if (options.analysisCoverageOverride) {
    const overridePath = path.resolve(options.analysisCoverageOverride);
    if (!fs.existsSync(overridePath)) {
      throw new Error(`assembly-loss: --analysis-coverage file not found: ${options.analysisCoverageOverride}`);
    }
    analysisCoverage = loadCoverage(overridePath, "analysis coverage override");
  } else {
    const defaultPath = path.join(root, DEFAULT_COVERAGE_PATH);
    if (fs.existsSync(defaultPath)) {
      analysisCoverage = loadCoverage(defaultPath, "analysis coverage report");
    }
  }

  const readOptionalInputFile = (
    filePath: string | undefined | null,
    locator: string,
    label: string,
    validateShape: (value: unknown) => unknown,
  ): unknown | null => {
    if (!filePath) return null;
    const resolved = path.resolve(filePath);
    const bytes = readVerified(resolved, `${label} file`, isPathInside(root, resolved));
    sourceArtifacts.push({ path: locator, sha256: sha256Hex(bytes) });
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf-8"));
    } catch (err) {
      throw new Error(`assembly-loss: ${label} is not valid JSON: ${(err as Error).message}`);
    }
    return validateShape(parsed);
  };
  const humanReference = readOptionalInputFile(
    options.humanReferenceFile,
    HUMAN_REFERENCE_INPUT_LOCATOR,
    "human-reference",
    validateHumanReferenceShape,
  ) as HumanStructuralReference | null;
  const wallClock = readOptionalInputFile(
    options.wallClockFile,
    WALL_CLOCK_INPUT_LOCATOR,
    "wall-clock",
    validateWallClockShape,
  ) as WallClockBreakdown | null;

  sourceArtifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    brief,
    selects,
    blueprint,
    timeline,
    transcripts,
    analysisCoverage,
    humanReference,
    wallClock,
    sourceArtifacts,
  };
}

// ── Envelope builder ────────────────────────────────────────────────

export function projectIdOf(brief: CreativeBrief): string {
  const id = brief.project_id ?? brief.project?.id;
  return typeof id === "string" && id.length > 0 ? id : "unknown-project";
}

export function sanitizeProjectIdForBasename(projectId: string): string {
  const sanitized = projectId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "project";
}

export function buildAssemblyLossProjectReport(
  inputs: LoadedProjectInputs,
  options: BuildOptions = {},
): AssemblyLossProjectReport {
  const evaluatorInput: AssemblyLossInput = {
    brief: inputs.brief,
    selects: inputs.selects,
    blueprint: inputs.blueprint,
    timeline: inputs.timeline,
    transcripts: inputs.transcripts,
    analysis_coverage: inputs.analysisCoverage,
  };
  if (options.humanReference != null && inputs.humanReference != null) {
    throw new Error("assembly-loss: human reference supplied twice (inline option and file)");
  }
  if (options.wallClock != null && inputs.wallClock != null) {
    throw new Error("assembly-loss: wall clock supplied twice (inline option and file)");
  }
  const humanReference = options.humanReference ?? inputs.humanReference ?? null;
  const wallClock = options.wallClock ?? inputs.wallClock ?? null;
  if (options.causalRefs != null) evaluatorInput.causal_refs = options.causalRefs;
  if (humanReference != null) evaluatorInput.human_structural_reference = humanReference;
  if (wallClock != null) evaluatorInput.wall_clock_breakdown = wallClock;
  if (options.asrToleranceUs != null) evaluatorInput.asr_tolerance_us = options.asrToleranceUs;

  const core = evaluateAssemblyLoss(evaluatorInput);
  const report: AssemblyLossProjectReport = {
    report_kind: ASSEMBLY_LOSS_REPORT_KIND,
    canonical: false,
    project_id: projectIdOf(inputs.brief),
    source_artifacts: inputs.sourceArtifacts.map((artifact) => ({ ...artifact })),
    report_identity: {
      evaluator_version: core.evaluator_version,
      input_hash: core.input_hash,
      policy_hash: core.policy_hash,
      payload_hash: "",
    },
    accepted_core_report: core,
  };
  if (core.verdict === "HOLD") {
    report.note = ASSEMBLY_LOSS_HOLD_NOTE;
  }
  report.report_identity.payload_hash = assemblyLossPayloadHash(report);
  return report;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function assemblyLossPayloadHash(report: AssemblyLossProjectReport): string {
  const { report_identity: _identity, ...payload } = report;
  void _identity;
  return sha256Hex(canonicalJson(payload));
}

export function assertAssemblyLossReportIdentity(report: AssemblyLossProjectReport): void {
  const identity = report.report_identity;
  const core = report.accepted_core_report;
  const matches =
    identity?.evaluator_version === ASSEMBLY_LOSS_EVALUATOR_VERSION &&
    core.evaluator_version === ASSEMBLY_LOSS_EVALUATOR_VERSION &&
    identity.evaluator_version === core.evaluator_version &&
    SHA256_HEX.test(identity.input_hash) &&
    SHA256_HEX.test(identity.policy_hash) &&
    SHA256_HEX.test(identity.payload_hash) &&
    identity.input_hash === core.input_hash &&
    identity.policy_hash === core.policy_hash &&
    identity.payload_hash === assemblyLossPayloadHash(report);
  if (!matches) {
    throw new Error("assembly-loss: report identity mismatch");
  }
}

export function reportVerdict(report: AssemblyLossProjectReport): "READY" | "HOLD" {
  assertAssemblyLossReportIdentity(report);
  return report.accepted_core_report.verdict;
}

export function assemblyLossBasename(report: AssemblyLossProjectReport): string {
  assertAssemblyLossReportIdentity(report);
  return [
    "assembly-loss",
    sanitizeProjectIdForBasename(report.project_id),
    report.accepted_core_report.input_hash.slice(0, 12),
    report.accepted_core_report.policy_hash.slice(0, 12),
  ].join("-");
}

// ── Markdown rendering ──────────────────────────────────────────────

export function renderAssemblyLossMarkdown(report: AssemblyLossProjectReport): string {
  assertAssemblyLossReportIdentity(report);
  const core = report.accepted_core_report;
  const lines: string[] = [];
  lines.push(`# Assembly loss diagnostic — ${report.project_id}`);
  lines.push("");
  lines.push(`- report: \`${report.report_kind}\` (non-canonical diagnostic)`);
  lines.push(`- verdict: **${core.verdict}**`);
  lines.push(`- input_hash: \`${core.input_hash}\``);
  lines.push(`- policy_hash: \`${core.policy_hash}\``);
  lines.push(`- asr_tolerance_us: ${core.policy.asr_tolerance_us}`);
  lines.push("");
  if (report.note !== undefined) {
    lines.push(`> ${report.note}`);
    lines.push("");
  }
  lines.push("## Grounding");
  lines.push("");
  lines.push(`- coverage: ${core.grounding.coverage}`);
  lines.push(`- selects_coverage_status: ${core.grounding.selects_coverage_status ?? "null"}`);
  lines.push(`- analysis_coverage_status: ${core.grounding.analysis_coverage_status ?? "null"}`);
  for (const note of core.grounding.notes) {
    lines.push(`- note: ${note}`);
  }
  lines.push("");
  lines.push("## Source artifacts");
  lines.push("");
  lines.push("| path | sha256 |");
  lines.push("| --- | --- |");
  for (const artifact of report.source_artifacts) {
    lines.push(`| ${artifact.path} | \`${artifact.sha256}\` |`);
  }
  lines.push("");
  lines.push("## Measurements");
  lines.push("");
  lines.push("```json");
  lines.push(canonicalJson(core.measurements));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

// ── Writer ──────────────────────────────────────────────────────────

/** Injectable rename for transaction-failure tests; defaults to fs.renameSync. */
export interface WriteAssemblyLossDeps {
  renameSync?: (fromPath: string, toPath: string) => void;
  statSync?: (filePath: string) => Pick<fs.Stats, "dev">;
  /** Project boundary is required by the public CLI and rechecked before install. */
  projectDir?: string;
  /** Deterministic path-swap injection used only by adversarial tests. */
  beforeInstall?: () => void;
}

interface OutputBoundarySnapshot {
  realPath: string;
  dev: number;
  ino: number;
}

function assertNoOutputSymlinkAncestors(outputDir: string): void {
  let cursor = path.resolve(outputDir);
  while (true) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`assembly-loss: output path has a symlink ancestor: ${cursor}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function prospectiveRealPath(candidate: string): string {
  const missing: string[] = [];
  let cursor = path.resolve(candidate);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const realBase = fs.realpathSync(cursor);
  return path.join(realBase, ...missing);
}

/**
 * Refuse output locations inside the project root (including the canonical
 * artifact subtree): this diagnostic must never write canonical artifacts.
 */
export function ensureOutputDirOutsideProject(outputDir: string, projectDir: string): void {
  assertNoOutputSymlinkAncestors(outputDir);
  const resolvedOut = prospectiveRealPath(outputDir);
  const resolvedProject = fs.realpathSync(path.resolve(projectDir));
  if (isPathInside(resolvedProject, resolvedOut)) {
    throw new Error(
      `assembly-loss: --output-dir must be outside the project directory (got ${outputDir})`,
    );
  }
}

function captureOutputBoundary(outputDir: string, projectDir?: string): OutputBoundarySnapshot {
  assertNoOutputSymlinkAncestors(outputDir);
  const resolved = path.resolve(outputDir);
  const stat = lstatRequired(resolved, "output directory");
  if (!stat.isDirectory()) {
    throw new Error(`assembly-loss: output path must be a directory: ${resolved}`);
  }
  const realPath = fs.realpathSync(resolved);
  if (projectDir) {
    const projectReal = fs.realpathSync(path.resolve(projectDir));
    if (isPathInside(projectReal, realPath)) {
      throw new Error(`assembly-loss: output path resolves inside project directory: ${outputDir}`);
    }
  }
  return { realPath, dev: stat.dev, ino: stat.ino };
}

function assertOutputBoundaryUnchanged(
  outputDir: string,
  before: OutputBoundarySnapshot,
  projectDir?: string,
): void {
  const after = captureOutputBoundary(outputDir, projectDir);
  if (after.realPath !== before.realPath || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error("assembly-loss: output path identity changed before install");
  }
}

/**
 * Write JSON + MD + detached .sha256 sidecars as one local transaction:
 *  1. serialize all four payloads,
 *  2. stage all four temp files in a sibling staging directory,
 *  3. back up any existing target files (in memory),
 *  4. install via rename — on ANY install failure, remove newly installed
 *     files, restore every backup, and rethrow; no temp file survives.
 * On success no backups or temps remain.
 */
export function writeAssemblyLossOutputs(
  report: AssemblyLossProjectReport,
  outputDir: string,
  deps: WriteAssemblyLossDeps = {},
): WrittenOutputs {
  assertAssemblyLossReportIdentity(report);
  if (deps.projectDir) ensureOutputDirOutsideProject(outputDir, deps.projectDir);
  else assertNoOutputSymlinkAncestors(outputDir);
  const doRename = deps.renameSync ?? fs.renameSync.bind(fs);
  const base = assemblyLossBasename(report);

  const jsonPath = path.join(outputDir, `${base}.json`);
  const mdPath = path.join(outputDir, `${base}.md`);
  const jsonSha256Path = `${jsonPath}.sha256`;
  const mdSha256Path = `${mdPath}.sha256`;

  // Serialize fully before touching the filesystem so a serialization
  // failure cannot leave partial output behind.
  const jsonBytes = `${canonicalJson(report)}\n`;
  const mdBytes = renderAssemblyLossMarkdown(report);
  const payloads: Array<{ target: string; data: string }> = [
    { target: jsonPath, data: jsonBytes },
    { target: mdPath, data: mdBytes },
    { target: jsonSha256Path, data: `${sha256Hex(jsonBytes)}  ${base}.json\n` },
    { target: mdSha256Path, data: `${sha256Hex(mdBytes)}  ${base}.md\n` },
  ];

  fs.mkdirSync(outputDir, { recursive: true });
  const outputBoundary = captureOutputBoundary(outputDir, deps.projectDir);
  const parentDir = path.dirname(path.resolve(outputDir));
  const statSync = deps.statSync ?? fs.statSync.bind(fs);
  if (outputBoundary.dev !== statSync(parentDir).dev) {
    throw new Error(
      `assembly-loss: --output-dir must be a subdirectory on the same volume as its parent, not a volume root: ${outputDir}`,
    );
  }
  const stagingDir = fs.mkdtempSync(
    path.join(path.dirname(path.resolve(outputDir)), `.${base}-`),
  );

  const stagedTemps: Array<{ tmp: string; target: string }> = [];
  try {
    // Stage 1: all temps exist before anything is installed.
    for (const payload of payloads) {
      const tmp = path.join(
        stagingDir,
        `${path.basename(payload.target)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
      );
      fs.writeFileSync(tmp, payload.data);
      stagedTemps.push({ tmp, target: payload.target });
    }

    // Stage 2: in-memory backups of existing targets. A file that vanishes
    // between existsSync and the read (or a metadata-only entry) is simply
    // not backed up — there is nothing to restore.
    const backups = new Map<string, Buffer>();
    for (const payload of payloads) {
      if (!fs.existsSync(payload.target)) continue;
      try {
        backups.set(payload.target, fs.readFileSync(payload.target));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    // Stage 3: install; roll back completely on failure.
    const installed: string[] = [];
    try {
      deps.beforeInstall?.();
      assertAssemblyLossReportIdentity(report);
      assertOutputBoundaryUnchanged(outputDir, outputBoundary, deps.projectDir);
      for (const staged of stagedTemps) {
        assertOutputBoundaryUnchanged(outputDir, outputBoundary, deps.projectDir);
        doRename(staged.tmp, staged.target);
        installed.push(staged.target);
      }
    } catch (installErr) {
      for (const target of installed) {
        try {
          fs.unlinkSync(target);
        } catch {
          // Best-effort removal of a partially installed new file.
        }
      }
      for (const [target, bytes] of backups) {
        fs.writeFileSync(target, bytes);
      }
      throw installErr;
    }
  } finally {
    // Temp cleanup: successful renames already moved these away; failures
    // leave nothing behind.
    for (const staged of stagedTemps) {
      try {
        fs.unlinkSync(staged.tmp);
      } catch {
        // Already renamed or never created.
      }
    }
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Best-effort removal of the dedicated staging directory.
    }
  }

  return { jsonPath, mdPath, jsonSha256Path, mdSha256Path };
}

// ── CLI ─────────────────────────────────────────────────────────────

export interface AssemblyLossProjectCliArgs {
  help: boolean;
  projectDir: string | null;
  analysisCoverage: string | null;
  causalRefsJson: string | null;
  humanReferenceJson: string | null;
  wallClockJson: string | null;
  humanReferenceFile: string | null;
  wallClockFile: string | null;
  asrToleranceUs: number | null;
  outputDir: string;
  noWrite: boolean;
}

export const ASSEMBLY_LOSS_CLI_USAGE = `Usage: npx tsx scripts/eval-assembly-loss.ts <project-dir> [options]

Positional:
  <project-dir>                Project directory containing the canonical artifacts

Options:
  --analysis-coverage <path>   Override analysis coverage JSON (must be well-formed)
  --causal-refs <json>         Causal edge refs as a JSON array (auxiliary evidence only)
  --human-reference <json>     Human structural reference as a JSON object
  --human-reference-file <path> Read the human structural reference from a JSON file
                               (raw file bytes are hashed into source_artifacts)
  --wall-clock <json>          Wall-clock breakdown as a JSON object (finite, non-negative)
  --wall-clock-file <path>     Read the wall-clock breakdown from a JSON file
                               (raw file bytes are hashed into source_artifacts)
  --asr-tolerance-us <n>       ASR tolerance in microseconds (finite, non-negative)
  --output-dir <dir>           Report output directory (default: reports/eval)
  --no-write                   Evaluate and print a summary only; create nothing
  --help, -h                   Show this help`;

function parseJsonOption(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`--${label} is not valid JSON: ${(err as Error).message}`);
  }
}

function parseJsonObjectOption(raw: string, label: string): Record<string, unknown> {
  const parsed = parseJsonOption(raw, label);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Fail-closed shape validation for explicit --causal-refs (auxiliary evidence only). */
export function validateCausalRefsShape(value: unknown, label = "causal-refs"): CausalEdgeRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`--${label} must be a JSON array`);
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`--${label}[${index}] must be an object`);
    }
    const edge = item as Record<string, unknown>;
    for (const key of ["from_beat_id", "to_beat_id"] as const) {
      const id = edge[key];
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(`--${label}[${index}].${key} must be a non-empty string`);
      }
    }
    if (edge.kind !== undefined && typeof edge.kind !== "string") {
      throw new Error(`--${label}[${index}].kind must be a string`);
    }
  }
  return value as CausalEdgeRef[];
}

/** Fail-closed shape validation for the explicit --human-reference option. */
export function validateHumanReferenceShape(
  value: unknown,
  label = "human-reference",
): HumanStructuralReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`--${label} must be a JSON object`);
  }
  const ref = value as Record<string, unknown>;
  if (!Array.isArray(ref.clips)) {
    throw new Error(`--${label}.clips must be an array`);
  }
  for (const [index, item] of ref.clips.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`--${label}.clips[${index}] must be an object`);
    }
    const clip = item as Record<string, unknown>;
    if (typeof clip.segment_id !== "string" || clip.segment_id.length === 0) {
      throw new Error(`--${label}.clips[${index}].segment_id must be a non-empty string`);
    }
    if (
      clip.duration_us !== undefined &&
      (typeof clip.duration_us !== "number" || !Number.isFinite(clip.duration_us) || clip.duration_us < 0)
    ) {
      throw new Error(`--${label}.clips[${index}].duration_us must be a finite non-negative number`);
    }
  }
  if (ref.label !== undefined && typeof ref.label !== "string") {
    throw new Error(`--${label}.label must be a string`);
  }
  return value as unknown as HumanStructuralReference;
}

/** Fail-closed shape validation shared by inline and file-backed wall-clock evidence. */
export function validateWallClockShape(value: unknown, label = "wall-clock"): WallClockBreakdown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`--${label} must be a JSON object`);
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      throw new Error(`--${label}.${key} must be a finite non-negative number`);
    }
  }
  return value as WallClockBreakdown;
}

export function parseAssemblyLossProjectArgs(argv: string[]): AssemblyLossProjectCliArgs {
  const args: AssemblyLossProjectCliArgs = {
    help: false,
    projectDir: null,
    analysisCoverage: null,
    causalRefsJson: null,
    humanReferenceJson: null,
    wallClockJson: null,
    humanReferenceFile: null,
    wallClockFile: null,
    asrToleranceUs: null,
    outputDir: "reports/eval",
    noWrite: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--analysis-coverage") {
      args.analysisCoverage = value();
    } else if (arg === "--causal-refs") {
      const raw = value();
      validateCausalRefsShape(parseJsonOption(raw, "causal-refs"));
      args.causalRefsJson = raw;
    } else if (arg === "--human-reference") {
      const raw = value();
      validateHumanReferenceShape(parseJsonOption(raw, "human-reference"));
      args.humanReferenceJson = raw;
    } else if (arg === "--human-reference-file") {
      args.humanReferenceFile = value();
    } else if (arg === "--wall-clock") {
      const raw = value();
      validateWallClockShape(parseJsonObjectOption(raw, "wall-clock"));
      args.wallClockJson = raw;
    } else if (arg === "--wall-clock-file") {
      args.wallClockFile = value();
    } else if (arg === "--asr-tolerance-us") {
      const raw = value();
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--asr-tolerance-us must be a finite non-negative number (got ${raw})`);
      }
      args.asrToleranceUs = parsed;
    } else if (arg === "--output-dir") {
      args.outputDir = value();
    } else if (arg === "--no-write") {
      args.noWrite = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (args.humanReferenceJson !== null && args.humanReferenceFile !== null) {
    throw new Error("assembly-loss: --human-reference and --human-reference-file are mutually exclusive");
  }
  if (args.wallClockJson !== null && args.wallClockFile !== null) {
    throw new Error("assembly-loss: --wall-clock and --wall-clock-file are mutually exclusive");
  }

  if (!args.help) {
    if (positional.length === 0) throw new Error("Missing <project-dir> positional argument");
    if (positional.length > 1) throw new Error(`Expected exactly one <project-dir>, got ${positional.length}`);
    args.projectDir = positional[0];
  }
  return args;
}

function resolveBuildOptions(args: AssemblyLossProjectCliArgs): BuildOptions {
  const options: BuildOptions = {};
  if (args.causalRefsJson !== null) {
    options.causalRefs = validateCausalRefsShape(parseJsonOption(args.causalRefsJson, "causal-refs"));
  }
  if (args.humanReferenceJson !== null) {
    options.humanReference = validateHumanReferenceShape(
      parseJsonOption(args.humanReferenceJson, "human-reference"),
    );
  }
  if (args.wallClockJson !== null) {
    options.wallClock = parseJsonObjectOption(args.wallClockJson, "wall-clock") as WallClockBreakdown;
  }
  if (args.asrToleranceUs !== null) options.asrToleranceUs = args.asrToleranceUs;
  return options;
}

/**
 * Run the CLI and return the process exit code: 0 on success (READY or
 * HOLD — a HOLD is a valid diagnostic), 1 on input/IO/validation errors.
 */
export async function runAssemblyLossCli(argv: string[]): Promise<number> {
  let args: AssemblyLossProjectCliArgs;
  try {
    args = parseAssemblyLossProjectArgs(argv);
  } catch (err) {
    console.error(`assembly-loss: ${(err as Error).message}`);
    console.error(ASSEMBLY_LOSS_CLI_USAGE);
    return 1;
  }
  if (args.help) {
    console.log(ASSEMBLY_LOSS_CLI_USAGE);
    return 0;
  }

  try {
    const projectDir = args.projectDir;
    if (!projectDir) throw new Error("Missing <project-dir>");
    const inputs = loadProjectInputs(projectDir, {
      analysisCoverageOverride: args.analysisCoverage,
      humanReferenceFile: args.humanReferenceFile,
      wallClockFile: args.wallClockFile,
    });
    const report = buildAssemblyLossProjectReport(inputs, resolveBuildOptions(args));
    const core = report.accepted_core_report;

    console.log(`assembly-loss: project ${report.project_id}`);
    console.log(`  verdict: ${core.verdict}`);
    console.log(`  input_hash: ${core.input_hash}`);
    console.log(`  policy_hash: ${core.policy_hash}`);
    if (report.note !== undefined) {
      console.log(`  note: ${report.note}`);
    }

    if (args.noWrite) {
      console.log("  no-write: no output files created");
      return 0;
    }

    // Refuse to write anywhere inside the project root (including the
    // canonical artifact subtree) before touching the filesystem.
    ensureOutputDirOutsideProject(args.outputDir, projectDir);
    const written = writeAssemblyLossOutputs(report, args.outputDir, { projectDir });
    for (const filePath of [written.jsonPath, written.mdPath, written.jsonSha256Path, written.mdSha256Path]) {
      console.log(`  wrote: ${filePath}`);
    }
    return 0;
  } catch (err) {
    console.error(`assembly-loss: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * Entry point for scripts/eval-assembly-loss.ts. Returns the CLI exit
 * code; never calls process.exit (the caller decides how to terminate).
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return runAssemblyLossCli(argv);
}
