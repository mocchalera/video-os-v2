/**
 * Atomic compiler artifact finalization.
 *
 * Compile output is written below a private staging directory first. No
 * canonical timeline or preview manifest is replaced until the staged files,
 * final timeline coverage, and (when requested) source files have all been
 * validated. Existing canonical files remain restorable until the optional
 * promotion hook returns successfully.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LoadedSourceMap } from "../media/source-map.js";
import { validateArtifact } from "../artifacts/loaders.js";
import { computeFileHash16 } from "../preview/playback-contract.js";
import { findPrimaryAudioGaps, findPrimaryVideoGaps } from "./coverage.js";
import { GapFreeTimelineError, PrimaryAudioGapError } from "./errors.js";
import { resolveCoverageHorizon } from "./resolve.js";
import { writePreviewManifest, writeTimeline } from "./export.js";
import type {
  AssembledTimeline,
  CompileArtifactReceipt,
  CompilePromotionContext,
  IntentionalGapOperation,
  TimelineIR,
} from "./types.js";

export interface AtomicCompileFinalizeOptions {
  projectPath: string;
  timeline: TimelineIR;
  sourceMap: LoadedSourceMap;
  targetEndFrame: number;
  resolution: import("./resolve.js").ResolutionReport;
  duration_policy: import("./types.js").DurationPolicy;
  validateSourceArtifacts?: boolean;
  /**
   * Precomputed render source readiness (Issue #6 P1). When provided, source
   * validation reuses its per-asset findings instead of re-hashing media.
   */
  sourceReadiness?: import("./render-readiness.js").RenderSourceReadinessReport;
  /**
   * True when compile accepted a declared primary-audio mix policy; the
   * staged primary-audio coverage check is then skipped (Issue #6 P0).
   */
  primaryAudioCoverageWaived?: boolean;
  /** Additional canonical artifacts staged, validated, and promoted with the timeline. */
  extraArtifacts?: Array<{ relativePath: string; content: string }>;
  onPromoted?: (receipts: CompileArtifactReceipt[], context: CompilePromotionContext) => void;
}

export interface AtomicCompileFinalizeResult {
  outputPath: string;
  previewManifestPath: string;
  receipts: CompileArtifactReceipt[];
}

export interface ArtifactValidationDetail {
  artifact: string;
  issues: string[];
}

export class AtomicArtifactValidationError extends Error {
  readonly code = "ATOMIC_ARTIFACT_VALIDATION_FAILED" as const;
  readonly details: ArtifactValidationDetail[];

  constructor(details: ArtifactValidationDetail[]) {
    const message = details
      .flatMap((detail) => detail.issues.map((issue) => `${detail.artifact}: ${issue}`))
      .join("; ");
    super(`Atomic compile artifact validation failed: ${message}`);
    this.name = "AtomicArtifactValidationError";
    this.details = details;
  }
}

export function finalizeCompileArtifactsAtomically(
  options: AtomicCompileFinalizeOptions,
): AtomicCompileFinalizeResult {
  const projectPath = path.resolve(options.projectPath);
  const outputDir = path.join(projectPath, "05_timeline");
  fs.mkdirSync(outputDir, { recursive: true });

  const stagingDir = fs.mkdtempSync(path.join(outputDir, ".compile-staging-"));
  const stagedTimelinePath = path.join(stagingDir, "timeline.json");
  const stagedManifestPath = path.join(stagingDir, "preview-manifest.json");
  const outputPath = path.join(outputDir, "timeline.json");
  const previewManifestPath = path.join(outputDir, "preview-manifest.json");
  const stagedTargets = [
    { staged: stagedTimelinePath, target: outputPath },
    { staged: stagedManifestPath, target: previewManifestPath },
  ];
  for (const extra of options.extraArtifacts ?? []) {
    const target = path.resolve(projectPath, extra.relativePath);
    stagedTargets.push({
      staged: path.join(stagingDir, `extra-${stagedTargets.length}-${path.basename(target)}`),
      target,
    });
  }

  try {
    writeTimeline(options.timeline, projectPath, stagedTimelinePath);
    writePreviewManifest(options.timeline, projectPath, options.sourceMap, {
      outputPath: stagedManifestPath,
      timelinePath: stagedTimelinePath,
    });
    (options.extraArtifacts ?? []).forEach((extra, index) => {
      const entry = stagedTargets[2 + index];
      fs.mkdirSync(path.dirname(entry.target), { recursive: true });
      fs.writeFileSync(entry.staged, extra.content, "utf-8");
    });

    validateStagedArtifacts(options, stagedTimelinePath, stagedManifestPath);
    for (const entry of stagedTargets) verifyArtifactFile(entry.staged, projectPath);

    const backups: Array<{ target: string; backup?: string }> = [];
    let promoted = false;
    try {
      for (const entry of stagedTargets) {
        const backup = backupPathFor(entry.target);
        const hadExisting = pathExists(entry.target);
        if (hadExisting) fs.renameSync(entry.target, backup);
        backups.push({ target: entry.target, backup: hadExisting ? backup : undefined });
        fs.renameSync(entry.staged, entry.target);
      }
      promoted = true;

      const receipts = stagedTargets.map((entry) =>
        verifyArtifactFile(entry.target, projectPath),
      );
      options.onPromoted?.(receipts, {
        timeline: options.timeline,
        resolution: options.resolution,
        duration_policy: options.duration_policy,
      });
      cleanupBackups(backups);

      return {
        outputPath,
        previewManifestPath,
        receipts,
      };
    } catch (error) {
      if (promoted || backups.length > 0) rollbackPromotedFiles(backups);
      throw error;
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** Promote a generated optional artifact without exposing a partial file. */
export function promoteArtifactFileAtomically(
  stagedPath: string,
  targetPath: string,
  projectPath: string,
): CompileArtifactReceipt {
  const staged = path.resolve(stagedPath);
  const target = path.resolve(targetPath);
  const backup = backupPathFor(target);
  let hadExisting = false;

  verifyArtifactFile(staged, projectPath);
  try {
    hadExisting = pathExists(target);
    if (hadExisting) fs.renameSync(target, backup);
    fs.renameSync(staged, target);
    const receipt = verifyArtifactFile(target, projectPath);
    if (hadExisting) fs.rmSync(backup, { force: true });
    return receipt;
  } catch (error) {
    if (pathExists(target)) fs.rmSync(target, { force: true });
    if (hadExisting && pathExists(backup)) fs.renameSync(backup, target);
    throw error;
  }
}

export function verifyArtifactFile(
  filePath: string,
  projectPath: string,
): CompileArtifactReceipt {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Artifact is not a regular file: ${filePath}`);
  return {
    relative_path: path.relative(path.resolve(projectPath), filePath).split(path.sep).join("/"),
    path: filePath,
    sha256: hashFile(filePath),
    bytes: stat.size,
  };
}

function validateStagedArtifacts(
  options: AtomicCompileFinalizeOptions,
  stagedTimelinePath: string,
  stagedManifestPath: string,
): void {
  const details: ArtifactValidationDetail[] = [];
  try {
    validateArtifact(options.timeline, "timeline-ir.schema.json");
  } catch (error) {
    details.push({ artifact: "timeline.json", issues: errorDetails(error) });
  }

  const timelineOperations = readTimelineOperations(options.timeline);
  const coverageInput = {
    tracks: { video: options.timeline.tracks.video, audio: options.timeline.tracks.audio },
    markers: [],
    operations: timelineOperations,
  } as unknown as AssembledTimeline;
  const coverageEndFrame = resolveCoverageHorizon(
    coverageInput,
    options.targetEndFrame,
    options.duration_policy,
  );
  if (options.timeline.tracks.video.some((track) => track.clips.length > 0)) {
    const gaps = findPrimaryVideoGaps(coverageInput, coverageEndFrame);
    if (gaps.length > 0) throw new GapFreeTimelineError(gaps);
  }

  // Primary audio coverage invariant (Issue #6 P0): re-validate the staged
  // timeline so a late geometry pass cannot open a silent hole in the
  // primary audio program right before promotion.
  const hasPrimaryAudioProgram = options.timeline.tracks.video.some((track) => track.clips.length > 0) ||
    options.timeline.tracks.audio.some((track) => track.clips.length > 0);
  if (hasPrimaryAudioProgram && !options.primaryAudioCoverageWaived) {
    // Keep the real video tracks so the finder can tell a visual program
    // (primary lane = A1) from an audio-led program (union of authored lanes).
    const audioGaps = findPrimaryAudioGaps(coverageInput, coverageEndFrame);
    if (audioGaps.length > 0) throw new PrimaryAudioGapError(audioGaps);
  }

  try {
    const stagedTimeline = JSON.parse(fs.readFileSync(stagedTimelinePath, "utf-8")) as TimelineIR;
    if (stagedTimeline.project_id !== options.timeline.project_id) {
      details.push({ artifact: "timeline.json", issues: ["staged project_id differs from compile result"] });
    }
  } catch (error) {
    details.push({ artifact: "timeline.json", issues: [`cannot parse staged file: ${errorDetails(error).join(", ")}`] });
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(stagedManifestPath, "utf-8")) as { base_timeline_hash?: unknown };
    const expectedHash = computeFileHash16(stagedTimelinePath);
    if (manifest.base_timeline_hash !== expectedHash) {
      details.push({
        artifact: "preview-manifest.json",
        issues: [`base_timeline_hash ${String(manifest.base_timeline_hash)} does not match staged timeline ${expectedHash}`],
      });
    }
  } catch (error) {
    details.push({ artifact: "preview-manifest.json", issues: [`cannot parse staged file: ${errorDetails(error).join(", ")}`] });
  }

  if (options.validateSourceArtifacts) {
    const sourceIssues = options.sourceReadiness
      ? readinessIssues(options.sourceReadiness)
      : validateReferencedSources(options.timeline, options.sourceMap);
    if (sourceIssues.length > 0) details.push({ artifact: "source_map.json", issues: sourceIssues });
  }

  if (details.length > 0) throw new AtomicArtifactValidationError(details);
}

function readinessIssues(
  report: import("./render-readiness.js").RenderSourceReadinessReport,
): string[] {
  return report.resolutions
    .filter((resolution) => resolution.status !== "resolved")
    .map((resolution) =>
      `asset ${resolution.asset_id} ${resolution.status}` +
      (resolution.source_path ? `: ${resolution.source_path}` : "") +
      (resolution.issue ? ` (${resolution.issue})` : ""),
    );
}

function validateReferencedSources(
  timeline: TimelineIR,
  sourceMap: LoadedSourceMap,
): string[] {
  const assetIds = new Set<string>();
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) assetIds.add(clip.asset_id);
  }

  const issues: string[] = [];
  for (const assetId of assetIds) {
    const entry = sourceMap.entryMap.get(assetId);
    if (!entry) {
      issues.push(`asset ${assetId} has no source-map entry`);
      continue;
    }
    const sourcePath = entry.local_source_path || entry.source_locator;
    if (!pathExists(sourcePath)) {
      issues.push(`asset ${assetId} source does not exist: ${sourcePath}`);
      continue;
    }
    try {
      if (!fs.statSync(sourcePath).isFile()) {
        issues.push(`asset ${assetId} source is not a regular file: ${sourcePath}`);
        continue;
      }
      if (entry.source_content_sha256) {
        const expected = entry.source_content_sha256.replace(/^sha256:/, "").toLowerCase();
        const actual = hashFile(sourcePath);
        if (actual !== expected) {
          issues.push(`asset ${assetId} source hash mismatch: expected ${expected}, got ${actual}`);
        }
      }
    } catch (error) {
      issues.push(`asset ${assetId} source could not be verified: ${errorDetails(error).join(", ")}`);
    }
  }
  return issues;
}

function readTimelineOperations(timeline: TimelineIR): IntentionalGapOperation[] {
  const operations = timeline.metadata?.timeline_operations;
  return Array.isArray(operations) ? operations as IntentionalGapOperation[] : [];
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function errorDetails(error: unknown): string[] {
  if (error && typeof error === "object" && "validationErrors" in error) {
    const validationErrors = (error as { validationErrors?: unknown }).validationErrors;
    if (Array.isArray(validationErrors)) return validationErrors.map(String);
  }
  return [error instanceof Error ? error.message : String(error)];
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function backupPathFor(target: string): string {
  return `${target}.compile-backup-${process.pid}`;
}

function cleanupBackups(backups: Array<{ target: string; backup?: string }>): void {
  for (const entry of backups) {
    if (entry.backup && pathExists(entry.backup)) fs.rmSync(entry.backup, { force: true });
  }
}

function rollbackPromotedFiles(backups: Array<{ target: string; backup?: string }>): void {
  for (const entry of [...backups].reverse()) {
    if (pathExists(entry.target)) fs.rmSync(entry.target, { force: true });
    if (entry.backup && pathExists(entry.backup)) fs.renameSync(entry.backup, entry.target);
  }
}
