import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateArtifact } from "../artifacts/loaders.js";
import { atomicWriteJson } from "../pipeline/stages/_util.js";

export interface TechnicalShortlistCandidate {
  batch: number;
  filename: string;
  duration_sec: number;
  measured_bpm: number;
  normalized_bpm: number;
  technical_score: number;
  sha256: string;
  suno_comment: string;
}

export interface TechnicalShortlistTrack {
  working_title: string;
  target_bpm: number;
  target_duration_sec: number;
  shortlist: TechnicalShortlistCandidate[];
  note: string;
}

export interface TechnicalShortlist {
  version: "technical-shortlist/v1";
  created_at: string;
  candidate_count: number;
  method: { duration: string; tempo: string; warning: string };
  tracks: Record<string, TechnicalShortlistTrack>;
}

interface CoreCatalogTrack {
  id: string;
  family: string;
  energy: "low" | "high";
  working_title: string;
  use_cases: string[];
  bpm: number;
  structure_90_150s?: { target_duration_seconds?: number };
}

interface CoreCatalog {
  schema_version: string;
  pack_id: string;
  tracks: CoreCatalogTrack[];
}

export interface ShortlistReview {
  musical_fit: "pending" | "approved" | "rejected";
  dialogue_bed: "pending" | "passed" | "failed";
  artifact_quality: "pending" | "passed" | "failed";
  originality: "pending" | "passed" | "concern";
  rights: "pending" | "operator_declared_ok" | "licensed" | "blocked";
  reviewer_ref: string | null;
  reviewed_at: string | null;
  notes: string[];
}

export interface ShortlistReviewCandidate {
  candidate_id: string;
  technical_rank: number;
  batch: number;
  filename: string;
  source_ref: string;
  content_hash: string;
  size_bytes: number | null;
  source_verified: boolean;
  target_duration_sec: number;
  duration_sec: number;
  target_bpm: number;
  measured_bpm: number;
  normalized_bpm: number;
  technical_score: number;
  source_comment: string;
  recommended_for_audition: boolean;
  review: ShortlistReview;
  promotion_eligible: boolean;
}

export interface ShortlistReviewTrack {
  track_id: string;
  working_title: string;
  family: string;
  intensity: "low" | "high";
  use_cases: string[];
  note: string;
  candidates: ShortlistReviewCandidate[];
}

export interface ShortlistIssue {
  code: string;
  severity: "error" | "warning";
  affected_ref: string;
  message: string;
  suggested_action: string;
}

export interface BgmShortlistReviewQueue {
  version: "1.0.0";
  artifact_kind: "bgm-shortlist-review";
  created_at: string;
  source: {
    shortlist_hash: string;
    shortlist_created_at: string;
    candidate_count_considered: number;
    method_warning: string;
  };
  catalog: {
    pack_id: string;
    schema_version: string;
    content_hash: string;
  };
  status: "ready_for_musical_review" | "blocked";
  counts: {
    tracks: number;
    shortlisted_candidates: number;
    source_verified: number;
    promotion_eligible: number;
    errors: number;
    warnings: number;
  };
  tracks: ShortlistReviewTrack[];
  issues: ShortlistIssue[];
}

export interface ShortlistImportOptions {
  shortlistPath: string;
  catalogPath: string;
  batchRoots?: ReadonlyMap<number, string> | Record<number, string>;
  existingReviewPath?: string;
}

export interface ShortlistImportResult {
  ok: boolean;
  artifact: BgmShortlistReviewQueue;
  resolved_paths: Map<string, string>;
}

export interface ShortlistReviewUpdateOptions {
  reviewPath: string;
  candidateId: string;
  review: ShortlistReview;
}

export interface ShortlistReviewUpdateResult {
  artifact: BgmShortlistReviewQueue;
  candidate: ShortlistReviewCandidate;
}

export class BgmShortlistReviewError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BgmShortlistReviewError";
    this.code = code;
  }
}

function sha256Bytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  code: string,
  severity: ShortlistIssue["severity"],
  affectedRef: string,
  message: string,
  suggestedAction: string,
): ShortlistIssue {
  return { code, severity, affected_ref: affectedRef, message, suggested_action: suggestedAction };
}

function safeFilename(filename: string): boolean {
  return filename.length > 0
    && filename !== "."
    && filename !== ".."
    && !filename.includes("/")
    && !filename.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(filename);
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function normalizedFamily(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function batchRootEntries(batchRoots: ShortlistImportOptions["batchRoots"]): Array<[number, string]> {
  if (!batchRoots) return [];
  if (batchRoots instanceof Map) return [...batchRoots.entries()];
  return Object.entries(batchRoots).map(([batch, root]) => [Number(batch), root]);
}

/**
 * Infer the production workspaces used by the supplied aggregate shortlist.
 * Batch 1 is `<name>`, batch 2 `<name>-1`, batch 3 `<name>-2`, and so on.
 */
export function inferShortlistBatchRoots(shortlistPath: string, batchNumbers: Iterable<number>): Map<number, string> {
  const aggregateBatchDirectory = path.dirname(path.dirname(path.resolve(shortlistPath)));
  const parent = path.dirname(aggregateBatchDirectory);
  const aggregateName = path.basename(aggregateBatchDirectory);
  const suffix = aggregateName.match(/-(\d+)$/);
  const baseName = suffix ? aggregateName.slice(0, -suffix[0].length) : aggregateName;
  const roots = new Map<number, string>();
  for (const batch of [...new Set(batchNumbers)].sort((left, right) => left - right)) {
    if (!Number.isSafeInteger(batch) || batch < 1) continue;
    roots.set(batch, path.join(parent, batch === 1 ? baseName : `${baseName}-${batch - 1}`));
  }
  return roots;
}

function resolveBatchRoots(options: ShortlistImportOptions, batches: number[]): Map<number, string> {
  const inferred = inferShortlistBatchRoots(options.shortlistPath, batches);
  for (const [batch, root] of batchRootEntries(options.batchRoots)) {
    if (Number.isSafeInteger(batch) && batch > 0) inferred.set(batch, path.resolve(root));
  }
  return inferred;
}

function readShortlist(filePath: string): { value: TechnicalShortlist; bytes: Buffer } {
  const bytes = fs.readFileSync(filePath);
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  return { value: validateArtifact<TechnicalShortlist>(parsed, "bgm-technical-shortlist.schema.json"), bytes };
}

function readCatalog(filePath: string): { value: CoreCatalog; bytes: Buffer } {
  const bytes = fs.readFileSync(filePath);
  const parsed = parseYaml(bytes.toString("utf8")) as unknown;
  if (!isRecord(parsed) || typeof parsed.schema_version !== "string" || typeof parsed.pack_id !== "string" || !Array.isArray(parsed.tracks)) {
    throw new Error("Core BGM catalog is malformed.");
  }
  const tracks = parsed.tracks.filter(isRecord).map((track): CoreCatalogTrack => {
    if (typeof track.id !== "string" || typeof track.family !== "string"
      || (track.energy !== "low" && track.energy !== "high")
      || typeof track.working_title !== "string" || !Array.isArray(track.use_cases)
      || !track.use_cases.every((item) => typeof item === "string")
      || typeof track.bpm !== "number") {
      throw new Error("Core BGM catalog track is malformed.");
    }
    return track as unknown as CoreCatalogTrack;
  });
  return { value: { schema_version: parsed.schema_version, pack_id: parsed.pack_id, tracks }, bytes };
}

function emptyReview(): ShortlistReview {
  return {
    musical_fit: "pending",
    dialogue_bed: "pending",
    artifact_quality: "pending",
    originality: "pending",
    rights: "pending",
    reviewer_ref: null,
    reviewed_at: null,
    notes: [],
  };
}

function eligible(review: ShortlistReview, sourceVerified: boolean): boolean {
  return sourceVerified
    && review.musical_fit === "approved"
    && review.dialogue_bed === "passed"
    && review.artifact_quality === "passed"
    && review.originality === "passed"
    && (review.rights === "operator_declared_ok" || review.rights === "licensed");
}

function existingReviews(filePath: string | undefined): Map<string, { hash: string; review: ShortlistReview }> {
  const reviews = new Map<string, { hash: string; review: ShortlistReview }>();
  if (!filePath || !fs.existsSync(filePath)) return reviews;
  const artifact = validateArtifact<BgmShortlistReviewQueue>(
    JSON.parse(fs.readFileSync(filePath, "utf8")),
    "bgm-shortlist-review.schema.json",
  );
  for (const track of artifact.tracks) {
    for (const candidate of track.candidates) {
      reviews.set(candidate.candidate_id, { hash: candidate.content_hash, review: candidate.review });
    }
  }
  return reviews;
}

function resolveSource(
  batchRoots: Map<number, string>,
  trackId: string,
  candidate: TechnicalShortlistCandidate,
  issues: ShortlistIssue[],
): { verified: boolean; size: number | null; absolutePath?: string } {
  const sourceRef = `batch:${candidate.batch}/input/${candidate.filename}`;
  if (!safeFilename(candidate.filename)) {
    issues.push(issue(
      "BGM_SHORTLIST_SOURCE_UNSAFE", "error", sourceRef,
      "Candidate filename is not a safe single path component.",
      "Regenerate the shortlist without path separators or control characters.",
    ));
    return { verified: false, size: null };
  }
  const batchRoot = batchRoots.get(candidate.batch);
  if (!batchRoot || !fs.existsSync(batchRoot)) {
    issues.push(issue(
      "BGM_SHORTLIST_BATCH_MISSING", "error", `batch:${candidate.batch}`,
      "The referenced generation batch directory is unavailable.",
      "Provide the matching --batch-root mapping or restore the private batch.",
    ));
    return { verified: false, size: null };
  }
  const inputRoot = path.resolve(batchRoot, "input");
  const audioPath = path.resolve(inputRoot, candidate.filename);
  if (!contained(inputRoot, audioPath) || !fs.existsSync(audioPath)) {
    issues.push(issue(
      "BGM_SHORTLIST_SOURCE_MISSING", "error", sourceRef,
      "The shortlisted source audio is missing from its declared batch.",
      "Restore the original download without renaming it or correct the batch mapping.",
    ));
    return { verified: false, size: null };
  }
  let realInputRoot: string;
  let realAudioPath: string;
  try {
    realInputRoot = fs.realpathSync(inputRoot);
    realAudioPath = fs.realpathSync(audioPath);
  } catch {
    return { verified: false, size: null };
  }
  if (!contained(realInputRoot, realAudioPath) || !fs.statSync(realAudioPath).isFile()) {
    issues.push(issue(
      "BGM_SHORTLIST_SOURCE_UNSAFE", "error", sourceRef,
      "The shortlisted source resolves outside its private batch or is not a regular file.",
      "Replace it with the original regular-file download inside the batch input directory.",
    ));
    return { verified: false, size: null };
  }
  const actualHash = sha256File(realAudioPath);
  const expectedHash = `sha256:${candidate.sha256}`;
  if (actualHash !== expectedHash) {
    issues.push(issue(
      "BGM_SHORTLIST_HASH_MISMATCH", "error", `${trackId}:${sourceRef}`,
      "The shortlisted source audio does not match its declared SHA-256.",
      "Restore the original download or regenerate the shortlist from the current bytes.",
    ));
    return { verified: false, size: fs.statSync(realAudioPath).size, absolutePath: realAudioPath };
  }
  return { verified: true, size: fs.statSync(realAudioPath).size, absolutePath: realAudioPath };
}

function sortIssues(issues: ShortlistIssue[]): ShortlistIssue[] {
  return issues.sort((left, right) => left.severity.localeCompare(right.severity)
    || left.code.localeCompare(right.code)
    || left.affected_ref.localeCompare(right.affected_ref));
}

function parseCandidateSourceRef(candidate: ShortlistReviewCandidate): { batch: number; filename: string } {
  const match = candidate.source_ref.match(/^batch:([1-9][0-9]*)\/input\/([^/\\]+)$/);
  if (!match || !safeFilename(match[2])) {
    throw new BgmShortlistReviewError(
      "BGM_SHORTLIST_SOURCE_UNSAFE",
      "Candidate source reference is not a safe private-batch path.",
    );
  }
  const batch = Number(match[1]);
  if (batch !== candidate.batch || match[2] !== candidate.filename) {
    throw new BgmShortlistReviewError(
      "BGM_SHORTLIST_SOURCE_UNSAFE",
      "Candidate source reference does not match its declared batch and filename.",
    );
  }
  return { batch, filename: match[2] };
}

export function verifyReviewCandidateSource(
  reviewPath: string,
  candidate: ShortlistReviewCandidate,
): string {
  const source = parseCandidateSourceRef(candidate);
  const batchRoot = inferShortlistBatchRoots(reviewPath, [source.batch]).get(source.batch);
  if (!batchRoot) {
    throw new BgmShortlistReviewError("BGM_SHORTLIST_BATCH_MISSING", "Candidate batch cannot be resolved.");
  }
  const inputRoot = path.resolve(batchRoot, "input");
  const candidatePath = path.resolve(inputRoot, source.filename);
  if (!contained(inputRoot, candidatePath) || !fs.existsSync(candidatePath)) {
    throw new BgmShortlistReviewError(
      "BGM_SHORTLIST_SOURCE_MISSING",
      "Candidate source audio is unavailable in its declared private batch.",
    );
  }
  const realInputRoot = fs.realpathSync(inputRoot);
  const realCandidatePath = fs.realpathSync(candidatePath);
  if (!contained(realInputRoot, realCandidatePath) || !fs.statSync(realCandidatePath).isFile()) {
    throw new BgmShortlistReviewError(
      "BGM_SHORTLIST_SOURCE_UNSAFE",
      "Candidate source resolves outside its private batch or is not a regular file.",
    );
  }
  if (sha256File(realCandidatePath) !== candidate.content_hash) {
    throw new BgmShortlistReviewError(
      "BGM_SHORTLIST_HASH_MISMATCH",
      "Candidate source audio no longer matches the reviewed SHA-256.",
    );
  }
  return realCandidatePath;
}

function validateReviewState(review: ShortlistReview): void {
  const candidateArtifact: BgmShortlistReviewQueue = {
    version: "1.0.0",
    artifact_kind: "bgm-shortlist-review",
    created_at: "2026-01-01T00:00:00.000Z",
    source: {
      shortlist_hash: `sha256:${"0".repeat(64)}`,
      shortlist_created_at: "2026-01-01T00:00:00.000Z",
      candidate_count_considered: 1,
      method_warning: "Technical review is not acceptance.",
    },
    catalog: {
      pack_id: "review-validation",
      schema_version: "1.0",
      content_hash: `sha256:${"0".repeat(64)}`,
    },
    status: "ready_for_musical_review",
    counts: {
      tracks: 1,
      shortlisted_candidates: 1,
      source_verified: 1,
      promotion_eligible: 0,
      errors: 0,
      warnings: 0,
    },
    tracks: [{
      track_id: "review-validation-low-01",
      working_title: "Review validation",
      family: "review_validation",
      intensity: "low",
      use_cases: ["validation"],
      note: "Review state validation only.",
      candidates: [{
        candidate_id: `review-validation-low-01--b1--${"0".repeat(12)}`,
        technical_rank: 1,
        batch: 1,
        filename: "validation.wav",
        source_ref: "batch:1/input/validation.wav",
        content_hash: `sha256:${"0".repeat(64)}`,
        size_bytes: 1,
        source_verified: true,
        target_duration_sec: 1,
        duration_sec: 1,
        target_bpm: 60,
        measured_bpm: 60,
        normalized_bpm: 60,
        technical_score: 0,
        source_comment: "Review state validation only.",
        recommended_for_audition: true,
        review,
        promotion_eligible: false,
      }],
    }],
    issues: [],
  };
  validateArtifact<BgmShortlistReviewQueue>(candidateArtifact, "bgm-shortlist-review.schema.json");
}

export function updateBgmShortlistReview(options: ShortlistReviewUpdateOptions): ShortlistReviewUpdateResult {
  validateReviewState(options.review);
  const reviewPath = path.resolve(options.reviewPath);
  const artifact = validateArtifact<BgmShortlistReviewQueue>(
    JSON.parse(fs.readFileSync(reviewPath, "utf8")),
    "bgm-shortlist-review.schema.json",
  );
  const matches = artifact.tracks.flatMap((track) => track.candidates)
    .filter((candidate) => candidate.candidate_id === options.candidateId);
  if (matches.length !== 1) {
    throw new BgmShortlistReviewError(
      "BGM_SHORTLIST_CANDIDATE_NOT_FOUND",
      "The requested candidate ID is missing or ambiguous in the review queue.",
    );
  }
  const candidate = matches[0];
  verifyReviewCandidateSource(reviewPath, candidate);
  candidate.source_verified = true;
  candidate.review = options.review;
  candidate.promotion_eligible = eligible(options.review, true);

  const allCandidates = artifact.tracks.flatMap((track) => track.candidates);
  artifact.counts.source_verified = allCandidates.filter((item) => item.source_verified).length;
  artifact.counts.promotion_eligible = allCandidates.filter((item) => item.promotion_eligible).length;
  artifact.counts.errors = artifact.issues.filter((item) => item.severity === "error").length;
  artifact.counts.warnings = artifact.issues.filter((item) => item.severity === "warning").length;
  artifact.status = artifact.counts.errors === 0 ? "ready_for_musical_review" : "blocked";
  validateArtifact<BgmShortlistReviewQueue>(artifact, "bgm-shortlist-review.schema.json");
  atomicWriteJson(reviewPath, artifact);
  return { artifact, candidate };
}

export function buildBgmShortlistReviewQueue(options: ShortlistImportOptions): ShortlistImportResult {
  const shortlist = readShortlist(path.resolve(options.shortlistPath));
  const catalog = readCatalog(path.resolve(options.catalogPath));
  const batches = Object.values(shortlist.value.tracks).flatMap((track) => track.shortlist.map((candidate) => candidate.batch));
  const batchRoots = resolveBatchRoots(options, batches);
  const priorReviews = existingReviews(options.existingReviewPath);
  const catalogTracks = new Map(catalog.value.tracks.map((track) => [track.id, track]));
  const shortlistTrackIds = Object.keys(shortlist.value.tracks).sort();
  const issues: ShortlistIssue[] = [];
  const resolvedPaths = new Map<string, string>();
  const candidateIds = new Set<string>();
  const tracks: ShortlistReviewTrack[] = [];

  for (const trackId of shortlistTrackIds) {
    const sourceTrack = shortlist.value.tracks[trackId];
    const catalogTrack = catalogTracks.get(trackId);
    if (!catalogTrack) {
      issues.push(issue(
        "BGM_SHORTLIST_TRACK_UNKNOWN", "error", trackId,
        "The shortlist track ID is not present in the Core v1 catalog.",
        "Correct the track ID or update the versioned catalog before review.",
      ));
    }
    if (catalogTrack && catalogTrack.working_title !== sourceTrack.working_title) {
      issues.push(issue(
        "BGM_SHORTLIST_TITLE_MISMATCH", "warning", trackId,
        "The shortlist working title differs from the Core v1 catalog.",
        "Confirm the intended catalog slot before approving a candidate.",
      ));
    }
    if (catalogTrack && Math.abs(catalogTrack.bpm - sourceTrack.target_bpm) > 0.01) {
      issues.push(issue(
        "BGM_SHORTLIST_TARGET_MISMATCH", "warning", trackId,
        "The shortlist target BPM differs from the Core v1 catalog.",
        "Confirm which target is authoritative before promotion.",
      ));
    }
    const candidates = sourceTrack.shortlist.map((candidate, index): ShortlistReviewCandidate => {
      const candidateId = `${trackId}--b${candidate.batch}--${candidate.sha256.slice(0, 12)}`;
      if (candidateIds.has(candidateId)) {
        issues.push(issue(
          "BGM_SHORTLIST_DUPLICATE_CANDIDATE", "error", candidateId,
          "The shortlist contains a duplicate candidate identity.",
          "Deduplicate the shortlist by track, batch, and SHA-256.",
        ));
      }
      candidateIds.add(candidateId);
      const source = resolveSource(batchRoots, trackId, candidate, issues);
      if (source.absolutePath) resolvedPaths.set(candidateId, source.absolutePath);
      const prior = priorReviews.get(candidateId);
      const review = prior?.hash === `sha256:${candidate.sha256}` ? prior.review : emptyReview();
      return {
        candidate_id: candidateId,
        technical_rank: index + 1,
        batch: candidate.batch,
        filename: candidate.filename,
        source_ref: `batch:${candidate.batch}/input/${candidate.filename}`,
        content_hash: `sha256:${candidate.sha256}`,
        size_bytes: source.size,
        source_verified: source.verified,
        target_duration_sec: sourceTrack.target_duration_sec,
        duration_sec: candidate.duration_sec,
        target_bpm: sourceTrack.target_bpm,
        measured_bpm: candidate.measured_bpm,
        normalized_bpm: candidate.normalized_bpm,
        technical_score: candidate.technical_score,
        source_comment: candidate.suno_comment,
        recommended_for_audition: true,
        review,
        promotion_eligible: eligible(review, source.verified),
      };
    });
    tracks.push({
      track_id: trackId,
      working_title: catalogTrack?.working_title ?? sourceTrack.working_title,
      family: normalizedFamily(catalogTrack?.family ?? trackId.split("-").slice(0, -2).join(" ")),
      intensity: catalogTrack?.energy ?? (trackId.includes("-high-") ? "high" : "low"),
      use_cases: [...new Set(catalogTrack?.use_cases ?? [])].sort(),
      note: sourceTrack.note,
      candidates,
    });
  }

  for (const catalogTrack of catalog.value.tracks) {
    if (!shortlist.value.tracks[catalogTrack.id]) {
      issues.push(issue(
        "BGM_SHORTLIST_TRACK_MISSING", "warning", catalogTrack.id,
        "The Core v1 catalog slot has no technical shortlist.",
        "Generate or restore candidates before considering the Core Pack complete.",
      ));
    }
  }

  sortIssues(issues);
  const candidates = tracks.flatMap((track) => track.candidates);
  const errors = issues.filter((item) => item.severity === "error").length;
  const warnings = issues.length - errors;
  const artifact: BgmShortlistReviewQueue = {
    version: "1.0.0",
    artifact_kind: "bgm-shortlist-review",
    created_at: shortlist.value.created_at,
    source: {
      shortlist_hash: sha256Bytes(shortlist.bytes),
      shortlist_created_at: shortlist.value.created_at,
      candidate_count_considered: shortlist.value.candidate_count,
      method_warning: shortlist.value.method.warning,
    },
    catalog: {
      pack_id: catalog.value.pack_id,
      schema_version: catalog.value.schema_version,
      content_hash: sha256Bytes(catalog.bytes),
    },
    status: errors === 0 ? "ready_for_musical_review" : "blocked",
    counts: {
      tracks: tracks.length,
      shortlisted_candidates: candidates.length,
      source_verified: candidates.filter((candidate) => candidate.source_verified).length,
      promotion_eligible: candidates.filter((candidate) => candidate.promotion_eligible).length,
      errors,
      warnings,
    },
    tracks,
    issues,
  };
  validateArtifact<BgmShortlistReviewQueue>(artifact, "bgm-shortlist-review.schema.json");
  return { ok: errors === 0, artifact, resolved_paths: resolvedPaths };
}

export function writeBgmShortlistReviewQueue(outputPath: string, artifact: BgmShortlistReviewQueue): void {
  validateArtifact<BgmShortlistReviewQueue>(artifact, "bgm-shortlist-review.schema.json");
  atomicWriteJson(path.resolve(outputPath), artifact);
}
