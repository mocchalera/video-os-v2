import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { packSearchRoots, verifyPack } from "./pack-registry.js";
import type {
  BgmPackDataRef,
  BgmPackErrorCode,
  BgmPackManifest,
  BgmPackTrack,
  PackVerification,
} from "./pack-types.js";

export const BGM_CANDIDATE_PACK_ID = "video-os-core-bgm-v1-candidate";
export const BGM_CANDIDATE_PACK_VERSION = "1.0.0-candidate.1";
export const BGM_PROMOTION_EXPECTED_CANDIDATES = 105;

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_CATALOG_PATH = path.join(REPOSITORY_ROOT, "docs", "bgm-pack", "core-v1", "track-catalog.yaml");
const ANALYSIS_HASH_EXCLUSIONS = ["analysis_hash", "created_at"] as const;
const EDITORIAL_AXIS_NAMES = [
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

type EditorialAxisName = (typeof EDITORIAL_AXIS_NAMES)[number];

interface CoreCatalogTrack {
  id: string;
  family: string;
  energy: "low" | "high";
  working_title: string;
  use_cases: string[];
  bpm: number;
  meter: string;
  instrumentation: string[];
  avoid: string[];
  structure_90_150s: {
    target_duration_seconds: number;
  };
}

interface LegacySection {
  id?: unknown;
  label?: unknown;
  start_sec?: unknown;
  end_sec?: unknown;
  energy?: unknown;
}

interface LegacyBeat {
  time_sec?: unknown;
  strength?: unknown;
}

interface LegacyAnalysis {
  analysis_status?: unknown;
  music_asset?: unknown;
  bpm?: unknown;
  meter?: unknown;
  duration_sec?: unknown;
  beats_sec?: unknown;
  downbeats_sec?: unknown;
  sections?: unknown;
  beats?: unknown;
  provenance?: unknown;
}

interface CandidateSourceRecord {
  public: BgmPromotionCandidate;
  audioPath: string;
  analysisPath: string;
  document: Record<string, unknown>;
  legacyAnalysis?: LegacyAnalysis;
  catalogTrack: CoreCatalogTrack;
}

interface PromotionScan {
  plan: BgmPromotionPlan;
  selected: CandidateSourceRecord[];
}

export interface BgmPromotionCandidate {
  track_id: string;
  stable_id: string;
  batch_ref: string;
  source_ref: string;
  source_content_hash: string;
  source_size_bytes: number;
  analysis_ref: string;
  analysis_content_hash: string;
  analysis_size_bytes: number;
  analysis_evidence_type: "candidate_analysis" | "batch_summary";
  generation_id: string;
  generated_at: string;
  duration_seconds: number;
  measured_bpm: number;
  normalized_bpm: number;
  technical_score: number;
  eligible: boolean;
  exclusion_reasons: string[];
}

export interface BgmPromotionSelection extends BgmPromotionCandidate {
  rank_within_family: 1;
}

export interface BgmPromotionPlan {
  version: "bgm-pack-promotion-plan/v1";
  created_at: string;
  pack_id: typeof BGM_CANDIDATE_PACK_ID;
  pack_version: typeof BGM_CANDIDATE_PACK_VERSION;
  status: "technical_candidate";
  candidate_count: number;
  family_count: number;
  catalog: {
    ref: "docs/bgm-pack/core-v1/track-catalog.yaml";
    content_hash: string;
  };
  source_integrity: {
    expected_candidates: number;
    verified_candidates: number;
    missing_files: 0;
    hash_mismatches: 0;
  };
  selection_method: {
    method_id: "core-v1-technical-fit-v1";
    eligibility: string[];
    normalized_bpm: string;
    score_formula: string;
    tie_break: string;
  };
  candidates: BgmPromotionCandidate[];
  selections: BgmPromotionSelection[];
  human_gates: Array<"musical_audition" | "dialogue_bed_review" | "artifact_review" | "originality_similarity_review">;
  release_status: "not_approved_for_external_or_public_release";
  rights_basis: "local_user_confirmation";
  rights_note: string;
}

export interface BuildBgmPromotionPlanOptions {
  sourceRoot: string;
  catalogPath?: string;
  createdAt?: string;
  expectedCandidateCount?: number;
}

export type PreviewRenderer = (
  sourcePath: string,
  outputPath: string,
  durationSeconds: number,
) => void;

export interface MaterializeBgmCandidatePackOptions extends BuildBgmPromotionPlanOptions {
  outputPath?: string;
  previewRenderer?: PreviewRenderer;
}

export interface BgmPackMaterializationResult {
  output_path: string;
  plan: BgmPromotionPlan;
  manifest: BgmPackManifest;
  verification: PackVerification;
}

export class BgmPackPromotionError extends Error {
  readonly recoverable: boolean;

  constructor(
    public readonly code: BgmPackErrorCode,
    message: string,
    public readonly affected_ref: string,
    recoverable = false,
  ) {
    super(message);
    this.name = "BgmPackPromotionError";
    this.recoverable = recoverable;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function secondsToUs(value: number): number {
  return Math.max(0, Math.round(value * 1_000_000));
}

function hashBuffer(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  try {
    let read = 0;
    do {
      read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

function normalizedJson(value: unknown, excludedFields: readonly string[], prefix = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizedJson(item, excludedFields, prefix));
  const source = record(value);
  if (!source) return value;
  const excluded = new Set(excludedFields);
  return Object.fromEntries(Object.keys(source).sort().flatMap((key) => {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (excluded.has(key) || excluded.has(fieldPath)) return [];
    return [[key, normalizedJson(source[key], excludedFields, fieldPath)]];
  }));
}

function normalizedJsonHash(value: unknown, excludedFields: readonly string[] = []): string {
  return hashBuffer(Buffer.from(JSON.stringify(normalizedJson(value, excludedFields))));
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeFilename(value: string): boolean {
  return value.length > 0
    && value === path.basename(value)
    && !value.includes("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(value)
    && value !== "."
    && value !== "..";
}

function readJsonObject(filePath: string, affectedRef: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    const value = record(parsed);
    if (value) return value;
  } catch {
    // Convert every read/parse failure into the path-free promotion contract below.
  }
  throw new BgmPackPromotionError(
    "BGM_PACK_INCOMPATIBLE",
    "Candidate analysis is not a readable JSON object.",
    affectedRef,
  );
}

function readJsonArray(filePath: string, affectedRef: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => record(item))) {
      return parsed as Record<string, unknown>[];
    }
  } catch {
    // Convert every read/parse failure into the path-free promotion contract below.
  }
  throw new BgmPackPromotionError(
    "BGM_PACK_INCOMPATIBLE",
    "Candidate batch summary is not a readable JSON object array.",
    affectedRef,
  );
}

function readCatalog(catalogPath: string): { tracks: CoreCatalogTrack[]; hash: string } {
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = fs.readFileSync(catalogPath);
    parsed = parseYaml(bytes.toString("utf8")) as unknown;
  } catch {
    throw new BgmPackPromotionError(
      "BGM_PACK_INCOMPATIBLE",
      "Core Pack catalog could not be read.",
      "core-v1-catalog",
    );
  }
  const source = record(parsed);
  const tracks = Array.isArray(source?.tracks) ? source.tracks : [];
  const normalized = tracks.map((value): CoreCatalogTrack | undefined => {
    const track = record(value);
    const structure = record(track?.structure_90_150s);
    if (
      !nonEmpty(track?.id)
      || !nonEmpty(track?.family)
      || (track?.energy !== "low" && track?.energy !== "high")
      || !nonEmpty(track?.working_title)
      || !Array.isArray(track?.use_cases)
      || !track.use_cases.every((item) => typeof item === "string")
      || !finite(track?.bpm)
      || !nonEmpty(track?.meter)
      || !Array.isArray(track?.instrumentation)
      || !track.instrumentation.every((item) => typeof item === "string")
      || !Array.isArray(track?.avoid)
      || !track.avoid.every((item) => typeof item === "string")
      || !finite(structure?.target_duration_seconds)
    ) return undefined;
    return {
      id: track.id as string,
      family: track.family as string,
      energy: track.energy as "low" | "high",
      working_title: track.working_title as string,
      use_cases: track.use_cases as string[],
      bpm: track.bpm as number,
      meter: track.meter as string,
      instrumentation: track.instrumentation as string[],
      avoid: track.avoid as string[],
      structure_90_150s: {
        target_duration_seconds: structure?.target_duration_seconds as number,
      },
    };
  });
  if (normalized.length !== 16 || normalized.some((track) => !track)) {
    throw new BgmPackPromotionError(
      "BGM_PACK_INCOMPATIBLE",
      "Core Pack catalog must contain the 16 complete family entries.",
      "core-v1-catalog",
    );
  }
  const typed = normalized as CoreCatalogTrack[];
  if (new Set(typed.map((track) => track.id)).size !== typed.length) {
    throw new BgmPackPromotionError(
      "BGM_PACK_INCOMPATIBLE",
      "Core Pack catalog contains duplicate track IDs.",
      "core-v1-catalog",
    );
  }
  return { tracks: typed, hash: hashBuffer(bytes) };
}

function generationFacts(comment: unknown, stableId: string): { id: string; createdAt: string } {
  const source = nonEmpty(comment);
  const match = source
    ? /(?:^|;\s*)created=([^;]+);\s*id=([A-Za-z0-9-]+)(?:;|$)/.exec(source)
    : null;
  if (!match || Number.isNaN(Date.parse(match[1]))) {
    throw new BgmPackPromotionError(
      "BGM_PACK_INCOMPATIBLE",
      "Candidate provenance is missing a valid generation ID or timestamp.",
      stableId,
    );
  }
  return { id: match[2], createdAt: new Date(match[1]).toISOString() };
}

function normalizedBpm(measured: number, target: number): number {
  const candidates = [0.25, 0.5, 1, 2].map((factor) => measured * factor);
  candidates.sort((left, right) => Math.abs(left - target) - Math.abs(right - target) || left - right);
  return round(candidates[0], 4);
}

function technicalScore(duration: number, targetDuration: number, bpm: number, targetBpm: number): number {
  const outOfRangeDistance = duration < 90 ? 90 - duration : duration > 180 ? duration - 180 : 0;
  return clamp(round(
    100
      - 0.45 * Math.abs(duration - targetDuration)
      - 1.2 * Math.abs(bpm - targetBpm)
      - 1.5 * outOfRangeDistance,
  ), 0, 100);
}

function discoverBatchDirectories(sourceRoot: string): string[] {
  let sourceRealPath: string;
  try {
    sourceRealPath = fs.realpathSync(sourceRoot);
  } catch {
    throw new BgmPackPromotionError(
      "BGM_PACK_NOT_FOUND",
      "Candidate source root does not exist or cannot be opened.",
      "source-root",
      true,
    );
  }
  const entries = fs.readdirSync(sourceRealPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const batches: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new BgmPackPromotionError(
        "BGM_PACK_ARCHIVE_UNSAFE",
        "Candidate source root contains a symbolic-link batch.",
        "source-root",
      );
    }
    if (!entry.isDirectory()) continue;
    const batchPath = path.join(sourceRealPath, entry.name);
    if (fs.existsSync(path.join(batchPath, "analysis")) && fs.existsSync(path.join(batchPath, "input"))) {
      batches.push(batchPath);
    }
  }
  if (batches.length === 0) {
    throw new BgmPackPromotionError(
      "BGM_PACK_NOT_FOUND",
      "No candidate batches with analysis and input directories were found.",
      "source-root",
      true,
    );
  }
  return batches;
}

function candidateFromDocument(
  document: Record<string, unknown>,
  analysisPath: string,
  batchPath: string,
  batchIndex: number,
  catalog: Map<string, CoreCatalogTrack>,
  evidenceType: BgmPromotionCandidate["analysis_evidence_type"] = "candidate_analysis",
): CandidateSourceRecord | undefined {
  const trackId = nonEmpty(document.track_id);
  const filename = nonEmpty(document.filename);
  const declaredHash = nonEmpty(document.sha256)?.toLowerCase();
  const legacy = record(document.analysis) as LegacyAnalysis | undefined;
  if (!trackId || !filename || !declaredHash) return undefined;
  const catalogTrack = catalog.get(trackId);
  if (!catalogTrack) {
    throw new BgmPackPromotionError(
      "BGM_PACK_INCOMPATIBLE",
      "Candidate analysis references a track outside the Core Pack catalog.",
      trackId,
    );
  }
  const asset = record(legacy?.music_asset);
  const candidateNumber = finite(document.candidate_number);
  const stableId = nonEmpty(asset?.asset_id)
    ?? (
      Number.isSafeInteger(candidateNumber)
      && candidateNumber !== undefined
      && candidateNumber > 0
        ? `${trackId}-batch${batchIndex}-candidate-${String(candidateNumber).padStart(2, "0")}`
        : undefined
    );
  if (!stableId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stableId)) {
    throw new BgmPackPromotionError(
      "BGM_PACK_INCOMPATIBLE",
      "Candidate analysis is missing a stable asset ID.",
      trackId,
    );
  }
  if (!safeFilename(filename)) {
    throw new BgmPackPromotionError(
      "BGM_PACK_ARCHIVE_UNSAFE",
      "Candidate filename is not a contained input member.",
      stableId,
    );
  }
  const inputRoot = fs.realpathSync(path.join(batchPath, "input"));
  const audioCandidate = path.resolve(inputRoot, filename);
  if (!isContained(inputRoot, audioCandidate) || !fs.existsSync(audioCandidate)) {
    throw new BgmPackPromotionError(
      "BGM_TRACK_MISSING",
      "Candidate source audio is missing.",
      stableId,
    );
  }
  let audioPath: string;
  try {
    audioPath = fs.realpathSync(audioCandidate);
  } catch {
    throw new BgmPackPromotionError(
      "BGM_TRACK_MISSING",
      "Candidate source audio cannot be opened.",
      stableId,
    );
  }
  if (!isContained(inputRoot, audioPath)) {
    throw new BgmPackPromotionError(
      "BGM_PACK_ARCHIVE_UNSAFE",
      "Candidate source audio resolves outside its batch input directory.",
      stableId,
    );
  }
  const declaredAssetPath = nonEmpty(asset?.path);
  if (declaredAssetPath) {
    let declaredRealPath: string;
    try {
      declaredRealPath = fs.realpathSync(declaredAssetPath);
    } catch {
      throw new BgmPackPromotionError(
        "BGM_TRACK_MISSING",
        "Candidate provenance points to a missing source audio file.",
        stableId,
      );
    }
    if (declaredRealPath !== audioPath) {
      throw new BgmPackPromotionError(
        "BGM_PACK_ARCHIVE_UNSAFE",
        "Candidate provenance path does not resolve to the contained batch input.",
        stableId,
      );
    }
  }
  const actualHash = hashFile(audioPath);
  if (actualHash !== `sha256:${declaredHash}`) {
    throw new BgmPackPromotionError(
      "BGM_TRACK_HASH_MISMATCH",
      "Candidate source audio no longer matches its recorded SHA-256.",
      stableId,
    );
  }
  const duration = finite(document.duration_sec) ?? finite(legacy?.duration_sec);
  const measured = finite(document.bpm) ?? finite(legacy?.bpm);
  if (!duration || duration <= 0 || !measured || measured <= 0) {
    throw new BgmPackPromotionError(
      "BGM_ANALYSIS_UNAVAILABLE",
      "Candidate analysis lacks positive duration or tempo facts.",
      stableId,
    );
  }
  const normalizedTempo = normalizedBpm(measured, catalogTrack.bpm);
  const generated = generationFacts(document.suno_comment, stableId);
  const analysisStats = fs.statSync(analysisPath);
  const sourceStats = fs.statSync(audioPath);
  const status = nonEmpty(document.status) ?? nonEmpty(legacy?.analysis_status);
  const duplicateOf = document.duplicate_of;
  const exclusionReasons = [
    ...(status === "ready" ? [] : [`analysis status is ${status ?? "missing"}`]),
    ...(duplicateOf === null || duplicateOf === undefined ? [] : ["candidate is marked as a duplicate"]),
  ];
  return {
    public: {
      track_id: trackId,
      stable_id: stableId,
      batch_ref: `batch:${batchIndex}`,
      source_ref: `batch:${batchIndex}/input/${filename}`,
      source_content_hash: actualHash,
      source_size_bytes: sourceStats.size,
      analysis_ref: `batch:${batchIndex}/analysis/${path.basename(analysisPath)}`,
      analysis_content_hash: hashFile(analysisPath),
      analysis_size_bytes: analysisStats.size,
      analysis_evidence_type: evidenceType,
      generation_id: generated.id,
      generated_at: generated.createdAt,
      duration_seconds: duration,
      measured_bpm: measured,
      normalized_bpm: normalizedTempo,
      technical_score: technicalScore(
        duration,
        catalogTrack.structure_90_150s.target_duration_seconds,
        normalizedTempo,
        catalogTrack.bpm,
      ),
      eligible: exclusionReasons.length === 0,
      exclusion_reasons: exclusionReasons,
    },
    audioPath,
    analysisPath,
    document,
    ...(legacy ? { legacyAnalysis: legacy } : {}),
    catalogTrack,
  };
}

function scanPromotionSources(options: BuildBgmPromotionPlanOptions): PromotionScan {
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new BgmPackPromotionError(
      "BGM_PACK_INCOMPATIBLE",
      "Promotion timestamp must be ISO-8601.",
      "created-at",
    );
  }
  const expected = options.expectedCandidateCount ?? BGM_PROMOTION_EXPECTED_CANDIDATES;
  const catalogPath = path.resolve(options.catalogPath ?? DEFAULT_CATALOG_PATH);
  const catalog = readCatalog(catalogPath);
  const byTrack = new Map(catalog.tracks.map((track) => [track.id, track]));
  const candidates: CandidateSourceRecord[] = [];
  const stableIds = new Set<string>();
  const batches = discoverBatchDirectories(options.sourceRoot);

  batches.forEach((batchPath, batchOffset) => {
    const analysisRoot = fs.realpathSync(path.join(batchPath, "analysis"));
    const summaryPath = path.join(analysisRoot, "summary.json");
    if (fs.existsSync(summaryPath)) {
      const documents = readJsonArray(summaryPath, `batch:${batchOffset + 1}/analysis/summary.json`);
      for (const document of documents) {
        const candidate = candidateFromDocument(
          document,
          summaryPath,
          batchPath,
          batchOffset + 1,
          byTrack,
          "batch_summary",
        );
        if (!candidate) {
          throw new BgmPackPromotionError(
            "BGM_PACK_INCOMPATIBLE",
            "Candidate batch summary contains an incomplete entry.",
            `batch:${batchOffset + 1}/analysis/summary.json`,
          );
        }
        if (stableIds.has(candidate.public.stable_id)) {
          throw new BgmPackPromotionError(
            "BGM_PACK_INCOMPATIBLE",
            "Candidate evidence contains a duplicate stable ID.",
            candidate.public.stable_id,
          );
        }
        stableIds.add(candidate.public.stable_id);
        candidates.push(candidate);
      }
      return;
    }
    const entries = fs.readdirSync(analysisRoot, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new BgmPackPromotionError(
          "BGM_PACK_ARCHIVE_UNSAFE",
          "Candidate analysis directory contains a symbolic-link member.",
          `batch:${batchOffset + 1}`,
        );
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
      const analysisPath = path.join(analysisRoot, entry.name);
      const document = readJsonObject(analysisPath, `batch:${batchOffset + 1}/analysis/${entry.name}`);
      const candidate = candidateFromDocument(document, analysisPath, batchPath, batchOffset + 1, byTrack);
      if (!candidate) continue;
      if (stableIds.has(candidate.public.stable_id)) {
        throw new BgmPackPromotionError(
          "BGM_PACK_INCOMPATIBLE",
          "Candidate evidence contains a duplicate stable ID.",
          candidate.public.stable_id,
        );
      }
      stableIds.add(candidate.public.stable_id);
      candidates.push(candidate);
    }
  });

  if (candidates.length !== expected) {
    throw new BgmPackPromotionError(
      "BGM_PACK_INCOMPATIBLE",
      `Candidate evidence count does not match the required ${expected}.`,
      "candidate-count",
    );
  }
  candidates.sort((left, right) =>
    left.public.track_id.localeCompare(right.public.track_id)
    || left.public.stable_id.localeCompare(right.public.stable_id));

  const selected: CandidateSourceRecord[] = [];
  for (const catalogTrack of catalog.tracks) {
    const family = candidates.filter((candidate) =>
      candidate.public.track_id === catalogTrack.id && candidate.public.eligible);
    family.sort((left, right) =>
      right.public.technical_score - left.public.technical_score
      || left.public.stable_id.localeCompare(right.public.stable_id));
    const winner = family[0];
    if (!winner) {
      throw new BgmPackPromotionError(
        "BGM_ANALYSIS_UNAVAILABLE",
        "No technically eligible candidate remains for a Core Pack family.",
        catalogTrack.id,
      );
    }
    selected.push(winner);
  }
  selected.sort((left, right) => left.public.track_id.localeCompare(right.public.track_id));

  const plan: BgmPromotionPlan = {
    version: "bgm-pack-promotion-plan/v1",
    created_at: new Date(createdAt).toISOString(),
    pack_id: BGM_CANDIDATE_PACK_ID,
    pack_version: BGM_CANDIDATE_PACK_VERSION,
    status: "technical_candidate",
    candidate_count: candidates.length,
    family_count: selected.length,
    catalog: {
      ref: "docs/bgm-pack/core-v1/track-catalog.yaml",
      content_hash: catalog.hash,
    },
    source_integrity: {
      expected_candidates: expected,
      verified_candidates: candidates.length,
      missing_files: 0,
      hash_mismatches: 0,
    },
    selection_method: {
      method_id: "core-v1-technical-fit-v1",
      eligibility: [
        "contained regular source and analysis files",
        "candidate analysis may be an individual record or an existing batch summary entry",
        "recorded SHA-256 equals current source bytes",
        "legacy analysis status is ready",
        "candidate is not marked as a duplicate",
        "positive duration and measured BPM are present",
      ],
      normalized_bpm: "choose measured BPM multiplied by 0.25, 0.5, 1, or 2 with the smallest distance to the authored target; lower normalized BPM wins an exact factor tie",
      score_formula: "clamp(100 - 0.45*abs(duration-target) - 1.2*abs(normalized_bpm-target_bpm) - 1.5*seconds_outside_90_to_180, 0, 100)",
      tie_break: "higher technical_score first; exact ties use stable_id ascending",
    },
    candidates: candidates.map((candidate) => candidate.public),
    selections: selected.map((candidate) => ({
      ...candidate.public,
      rank_within_family: 1,
    })),
    human_gates: [
      "musical_audition",
      "dialogue_bed_review",
      "artifact_review",
      "originality_similarity_review",
    ],
    release_status: "not_approved_for_external_or_public_release",
    rights_basis: "local_user_confirmation",
    rights_note: "The operator confirmed local use rights for the generated candidates. No license identifier, external URL, paid-tier fact, redistribution approval, or public-release approval is inferred.",
  };
  return { plan, selected };
}

export function buildBgmPromotionPlan(options: BuildBgmPromotionPlanOptions): BgmPromotionPlan {
  return scanPromotionSources(options).plan;
}

export function defaultBgmPromotionOutputPath(): string {
  const userRoot = packSearchRoots().find((root) => root.source === "user");
  if (!userRoot) {
    throw new BgmPackPromotionError(
      "BGM_PACK_NOT_FOUND",
      "The Video OS user Pack Registry location is unavailable.",
      "user-pack-root",
      true,
    );
  }
  return path.join(userRoot.path, BGM_CANDIDATE_PACK_ID, BGM_CANDIDATE_PACK_VERSION);
}

function realOutputCandidate(outputPath: string): string {
  const absolute = path.resolve(outputPath);
  const missing: string[] = [];
  let cursor = absolute;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const ancestor = fs.realpathSync(cursor);
  return path.resolve(ancestor, ...missing);
}

export function validateBgmPromotionOutputPath(outputPath: string, sourceRoot: string): string {
  const absolute = path.resolve(outputPath);
  const root = path.parse(absolute).root;
  if (absolute === root || path.basename(absolute) === "." || path.basename(absolute) === "..") {
    throw new BgmPackPromotionError(
      "BGM_PACK_ARCHIVE_UNSAFE",
      "Pack output must be a new, specific version directory.",
      "output",
    );
  }
  const outputCandidate = realOutputCandidate(absolute);
  const repositoryRealPath = fs.realpathSync(REPOSITORY_ROOT);
  const sourceRealPath = fs.realpathSync(sourceRoot);
  if (
    isContained(repositoryRealPath, outputCandidate)
    || isContained(sourceRealPath, outputCandidate)
    || isContained(outputCandidate, sourceRealPath)
  ) {
    throw new BgmPackPromotionError(
      "BGM_PACK_ARCHIVE_UNSAFE",
      "Pack output must remain outside the repository and candidate evidence tree.",
      "output",
    );
  }
  if (fs.existsSync(absolute)) {
    throw new BgmPackPromotionError(
      "BGM_PACK_BUSY",
      "Pack output already exists; promotion never overwrites an installed directory.",
      BGM_CANDIDATE_PACK_ID,
      true,
    );
  }
  return absolute;
}

function renderPreviewWithFfmpeg(sourcePath: string, outputPath: string, durationSeconds: number): void {
  const previewDuration = Math.min(15, durationSeconds);
  const fadeOutStart = Math.max(0, previewDuration - 0.5);
  try {
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-fflags",
      "+bitexact",
      "-i",
      sourcePath,
      "-map_metadata",
      "-1",
      "-vn",
      "-t",
      previewDuration.toFixed(6),
      "-af",
      `asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.25,afade=t=out:st=${fadeOutStart.toFixed(6)}:d=0.5`,
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "flac",
      "-compression_level",
      "8",
      "-flags:a",
      "+bitexact",
      outputPath,
    ], { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch {
    throw new BgmPackPromotionError(
      "BGM_ANALYSIS_UNAVAILABLE",
      "FFmpeg could not render the deterministic Pack preview.",
      path.basename(sourcePath),
      true,
    );
  }
}

function writeJson(filePath: string, value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  fs.writeFileSync(filePath, bytes, { flag: "wx" });
  return bytes;
}

function dataRef(relativePath: string, bytes: Buffer): BgmPackDataRef {
  return {
    path: relativePath,
    content_hash: hashBuffer(bytes),
    size_bytes: bytes.byteLength,
    format: "json",
  };
}

function familyKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s*\/\s*/g, "_")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const FAMILY_AXES: Record<string, Omit<Record<EditorialAxisName, number>, "energy">> = {
  trust_clarity: {
    valence: 0.62, tension: 0.12, warmth: 0.58, modernity: 0.55, playfulness: 0.1,
    sophistication: 0.75, organic_electronic: 0.5, density: 0.25, speech_friendliness: 0.95,
    beat_prominence: 0.45, build_strength: 0.45, ending_resolution: 0.86,
  },
  warm_human: {
    valence: 0.72, tension: 0.1, warmth: 0.9, modernity: 0.35, playfulness: 0.2,
    sophistication: 0.58, organic_electronic: 0.22, density: 0.3, speech_friendliness: 0.95,
    beat_prominence: 0.35, build_strength: 0.38, ending_resolution: 0.82,
  },
  reflective_emotional: {
    valence: 0.38, tension: 0.3, warmth: 0.75, modernity: 0.42, playfulness: 0.08,
    sophistication: 0.76, organic_electronic: 0.55, density: 0.24, speech_friendliness: 0.95,
    beat_prominence: 0.25, build_strength: 0.55, ending_resolution: 0.72,
  },
  problem_tension: {
    valence: 0.25, tension: 0.85, warmth: 0.25, modernity: 0.62, playfulness: 0.12,
    sophistication: 0.68, organic_electronic: 0.42, density: 0.35, speech_friendliness: 0.9,
    beat_prominence: 0.55, build_strength: 0.65, ending_resolution: 0.32,
  },
  future_technology: {
    valence: 0.55, tension: 0.2, warmth: 0.35, modernity: 0.95, playfulness: 0.25,
    sophistication: 0.78, organic_electronic: 0.9, density: 0.4, speech_friendliness: 0.92,
    beat_prominence: 0.6, build_strength: 0.56, ending_resolution: 0.66,
  },
  progress_uplift: {
    valence: 0.86, tension: 0.15, warmth: 0.65, modernity: 0.62, playfulness: 0.22,
    sophistication: 0.58, organic_electronic: 0.46, density: 0.35, speech_friendliness: 0.92,
    beat_prominence: 0.6, build_strength: 0.75, ending_resolution: 0.9,
  },
  premium_minimal: {
    valence: 0.5, tension: 0.15, warmth: 0.45, modernity: 0.72, playfulness: 0.08,
    sophistication: 0.95, organic_electronic: 0.65, density: 0.2, speech_friendliness: 0.95,
    beat_prominence: 0.35, build_strength: 0.45, ending_resolution: 0.86,
  },
  playful_bold: {
    valence: 0.86, tension: 0.1, warmth: 0.62, modernity: 0.68, playfulness: 0.9,
    sophistication: 0.52, organic_electronic: 0.5, density: 0.45, speech_friendliness: 0.85,
    beat_prominence: 0.7, build_strength: 0.62, ending_resolution: 0.76,
  },
};

function authoredAxes(track: CoreCatalogTrack): BgmPackTrack["axes"] {
  const key = familyKey(track.family);
  const base = FAMILY_AXES[key];
  if (!base) {
    throw new BgmPackPromotionError(
      "BGM_PACK_INCOMPATIBLE",
      "Core Pack family lacks authored editorial axes.",
      track.id,
    );
  }
  const high = track.energy === "high";
  const values: Record<EditorialAxisName, number> = {
    ...base,
    energy: high ? 0.74 : 0.3,
    density: clamp(base.density + (high ? 0.16 : 0)),
    speech_friendliness: clamp(base.speech_friendliness - (high ? 0.06 : 0)),
    beat_prominence: clamp(base.beat_prominence + (high ? 0.16 : 0)),
    build_strength: clamp(base.build_strength + (high ? 0.14 : 0)),
  };
  return Object.fromEntries(EDITORIAL_AXIS_NAMES.map((name) => [
    name,
    { value: values[name], source: "authored" },
  ])) as BgmPackTrack["axes"];
}

function analyzedAxes(): Record<string, { value: number; confidence: number; source: "analyzed" }> {
  return Object.fromEntries(EDITORIAL_AXIS_NAMES.map((name) => [
    name,
    { value: 0.5, confidence: 0, source: "analyzed" },
  ]));
}

function uniqueNumbers(values: number[], maximum: number): number[] {
  return [...new Set(values.map((value) => Math.min(maximum, Math.max(0, value))))].sort((left, right) => left - right);
}

function legacyDocument(candidate: CandidateSourceRecord): {
  document: Record<string, unknown>;
  analysis: LegacyAnalysis;
} {
  return {
    document: candidate.document,
    analysis: candidate.legacyAnalysis ?? {
      analysis_status: candidate.document.status,
      bpm: candidate.document.bpm,
      meter: candidate.document.meter,
      duration_sec: candidate.document.duration_sec,
      provenance: { detector: candidate.document.detector },
    },
  };
}

interface CanonicalAudioFacts {
  sampleRateHz: number;
  channels: number;
  codec: string;
}

function canonicalAudioFacts(candidate: CandidateSourceRecord): CanonicalAudioFacts {
  const sampleRate = finite(candidate.document.sample_rate_hz);
  const channels = finite(candidate.document.channels);
  const codec = nonEmpty(candidate.document.codec);
  if (sampleRate && sampleRate > 0 && channels && channels > 0 && codec) {
    return {
      sampleRateHz: Math.round(sampleRate),
      channels: Math.round(channels),
      codec,
    };
  }
  try {
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,sample_rate,channels",
      "-of",
      "json",
      candidate.audioPath,
    ], { encoding: "utf8", timeout: 30_000 })) as {
      streams?: Array<{ codec_name?: unknown; sample_rate?: unknown; channels?: unknown }>;
    };
    const stream = probe.streams?.[0];
    const probedRate = typeof stream?.sample_rate === "string" ? Number(stream.sample_rate) : undefined;
    const probedChannels = finite(stream?.channels);
    const probedCodec = nonEmpty(stream?.codec_name);
    if (probedRate && probedRate > 0 && probedChannels && probedChannels > 0 && probedCodec) {
      return {
        sampleRateHz: Math.round(probedRate),
        channels: Math.round(probedChannels),
        codec: probedCodec,
      };
    }
  } catch {
    // The path-free error below keeps source details out of machine-readable output.
  }
  throw new BgmPackPromotionError(
    "BGM_ANALYSIS_UNAVAILABLE",
    "Selected candidate audio facts are unavailable from evidence and FFprobe.",
    candidate.public.stable_id,
    true,
  );
}

function canonicalAnalysis(
  candidate: CandidateSourceRecord,
  fullMixHash: string,
  createdAt: string,
  audioFacts: CanonicalAudioFacts,
): Record<string, unknown> {
  const { document, analysis } = legacyDocument(candidate);
  const durationUs = secondsToUs(candidate.public.duration_seconds);
  const beats = Array.isArray(analysis.beats) ? analysis.beats.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
  const beatStrength = new Map(beats.flatMap((beat) => {
    const time = finite(beat.time_sec);
    const strength = finite(beat.strength);
    return time === undefined || strength === undefined ? [] : [[secondsToUs(time), clamp(strength)] as const];
  }));
  const beatTimes = Array.isArray(analysis.beats_sec)
    ? analysis.beats_sec.map(finite).filter((value): value is number => value !== undefined)
    : [];
  const downbeatTimes = Array.isArray(analysis.downbeats_sec)
    ? analysis.downbeats_sec.map(finite).filter((value): value is number => value !== undefined)
    : [];
  const sections = Array.isArray(analysis.sections)
    ? analysis.sections.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) as LegacySection[]
    : [];
  const canonicalSections = sections.flatMap((section, index) => {
    const start = finite(section.start_sec);
    const end = finite(section.end_sec);
    if (start === undefined || end === undefined) return [];
    const inUs = Math.min(durationUs, secondsToUs(start));
    const outUs = Math.min(durationUs, secondsToUs(end));
    if (outUs <= inUs) return [];
    return [{
      section_id: nonEmpty(section.id) ?? `S${index + 1}`,
      label: nonEmpty(section.label) ?? `section-${index + 1}`,
      in_us: inUs,
      out_us: outUs,
      energy: clamp(finite(section.energy) ?? 0.5),
    }];
  });
  const downbeatsUs = uniqueNumbers(downbeatTimes.map(secondsToUs), durationUs);
  const energyCurve = canonicalSections.flatMap((section) => [{
    at_us: section.in_us,
    value: section.energy,
  }]);
  if (canonicalSections.length > 0) {
    energyCurve.push({
      at_us: durationUs,
      value: canonicalSections[canonicalSections.length - 1].energy,
    });
  } else {
    energyCurve.push({ at_us: 0, value: 0.5 }, { at_us: durationUs, value: 0.5 });
  }
  const normalizedTempo = candidate.public.normalized_bpm;
  const sourceDetector = nonEmpty(document.detector)
    ?? nonEmpty(record(analysis.provenance)?.detector)
    ?? "legacy-unknown";
  const value: Record<string, unknown> = {
    version: "1.0.0",
    track_id: candidate.public.track_id,
    input_content_hash: fullMixHash,
    created_at: createdAt,
    status: "degraded",
    audio: {
      duration_us: durationUs,
      sample_rate_hz: audioFacts.sampleRateHz,
      channels: audioFacts.channels,
      codec: audioFacts.codec,
    },
    loudness: {
      integrated_lufs: null,
      loudness_range_lu: null,
      true_peak_dbtp: null,
      clipping_sample_count: 0,
      leading_silence_us: 0,
      trailing_silence_us: 0,
    },
    tempo: {
      bpm: normalizedTempo,
      perceived_tempo: normalizedTempo < 80 ? "slow" : normalizedTempo < 116 ? "medium" : "fast",
      meter: nonEmpty(document.meter) ?? nonEmpty(analysis.meter) ?? candidate.catalogTrack.meter,
      key: null,
      mode: null,
      confidence: beatTimes.length >= 4 ? 0.75 : 0.3,
    },
    structure: {
      beats: uniqueNumbers(beatTimes.map(secondsToUs), durationUs).map((atUs) => ({
        at_us: atUs,
        confidence: beatStrength.get(atUs) ?? 0.5,
      })),
      downbeats: downbeatsUs.map((atUs) => ({ at_us: atUs, confidence: 0.5 })),
      sections: canonicalSections,
      energy_curve: energyCurve,
      transient_density: clamp(beatTimes.length / Math.max(1, candidate.public.duration_seconds) / 4),
      safe_entry_points: uniqueNumbers([0, ...downbeatsUs], durationUs).map((atUs) => ({
        at_us: atUs,
        confidence: atUs === 0 ? 0.8 : 0.5,
      })),
      safe_exit_points: uniqueNumbers([...downbeatsUs, durationUs], durationUs).map((atUs) => ({
        at_us: atUs,
        confidence: atUs === durationUs ? 0.7 : 0.5,
      })),
      loop_candidates: [],
    },
    spectrum: {
      spectral_density: 0.5,
      speech_band_masking_score: 0.5,
    },
    semantics: {
      status: "unavailable",
      clap_embedding: null,
      mood_scores: [],
      genre_scores: [],
      editorial_axes: analyzedAxes(),
      degraded_reasons: ["Semantic analysis is unavailable in the legacy candidate evidence."],
    },
    analyzers: [
      {
        name: sourceDetector,
        version: "legacy",
        model_revision: null,
        status: "ready",
      },
      {
        name: "video-os-legacy-analysis-adapter",
        version: "1",
        model_revision: null,
        status: "degraded",
      },
      {
        name: "clap",
        version: "1",
        model_revision: null,
        status: "unavailable",
      },
    ],
    degraded_reasons: [
      `Legacy ${candidate.public.analysis_evidence_type} does not contain canonical loudness, clipping-count, silence, spectrum, key, or mode measurements; nullable values and neutral schema placeholders are retained instead of fabricating measurements.`,
      "Semantic analysis is unavailable.",
      "Musical audition, dialogue-bed review, artifact review, and originality/similarity review remain pending.",
    ],
    hash_policy: {
      algorithm: "sha256",
      canonicalization: "normalized-json-v1",
      excluded_fields: [...ANALYSIS_HASH_EXCLUSIONS],
    },
    analysis_hash: `sha256:${"0".repeat(64)}`,
  };
  value.analysis_hash = normalizedJsonHash(value, ANALYSIS_HASH_EXCLUSIONS);
  return value;
}

function rightsRegister(
  candidate: CandidateSourceRecord,
  fullMixHash: string,
  createdAt: string,
): Record<string, unknown> {
  const confirmationRef = "evidence:local-user-confirmation-2026-07-27";
  return {
    version: "1.0.0",
    project_id: BGM_CANDIDATE_PACK_ID,
    created_at: createdAt,
    items: [{
      record_id: `RIGHTS_${candidate.public.track_id.replace(/-/g, "_")}`,
      item_type: "bgm",
      asset_id: candidate.public.track_id,
      content_hash: fullMixHash,
      source_type: "user_library",
      source_ref: `provenance:${candidate.public.stable_id}`,
      contributor_declaration_id: "local-user-confirmation-2026-07-27",
      generator: {
        tool: "Suno",
        model_revision: null,
        account_tier_at_creation: null,
        paid_tier_confirmed: null,
        terms_revision: null,
      },
      creation_date: candidate.public.generated_at.slice(0, 10),
      evidence_refs: [{
        evidence_id: "local-user-confirmation-2026-07-27",
        kind: "declaration",
        locator: confirmationRef,
      }],
      license: {
        identifier: "not-specified-local-confirmation",
        text_ref: confirmationRef,
        permitted_scopes: ["preview_internal", "modification"],
        attribution_rule: "Not specified by the local confirmation; resolve before external, public, or redistributed use.",
      },
      similarity_review: {
        status: "pending",
        reviewer_ref: null,
        reviewed_at: null,
      },
      integrity: {
        status: "verified",
        verified_hash: fullMixHash,
        verified_at: createdAt,
      },
      rights_status: "operator_declared_ok",
      waivers: [],
      reviewer_ref: confirmationRef,
      reviewed_at: createdAt,
      expires_at: null,
    }],
    provenance: {
      producer: "Video OS BGM Pack promotion",
      inputs: [{
        path: `provenance:${candidate.public.stable_id}`,
        hash: candidate.public.source_content_hash,
      }],
      hash_policy: {
        algorithm: "sha256",
        canonicalization: "normalized-json-v1",
        excluded_fields: [],
      },
    },
  };
}

function useCases(values: string[]): string[] {
  const expanded = new Set<string>();
  for (const value of values) {
    const normalized = value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (normalized) expanded.add(normalized);
    for (const token of ["interview", "explainer", "documentary", "technology", "product", "event", "recruiting"]) {
      if (normalized.includes(token)) expanded.add(token);
    }
    if (normalized.includes("case_study") || normalized.includes("customer_proof")) expanded.add("case_study");
    if (normalized.includes("company") || normalized.includes("brand_overview")) expanded.add("company_story");
    if (normalized.includes("social")) expanded.add("social_hook");
  }
  return [...expanded].sort();
}

function makeTrack(
  candidate: CandidateSourceRecord,
  fullMixRef: BgmPackTrack["full_mix"],
  previewRef: BgmPackTrack["preview"],
  rightsRef: BgmPackDataRef,
  analysisRef: BgmPackDataRef,
): BgmPackTrack {
  const { analysis } = legacyDocument(candidate);
  const durationUs = secondsToUs(candidate.public.duration_seconds);
  const downbeats = Array.isArray(analysis.downbeats_sec)
    ? analysis.downbeats_sec.map(finite).filter((value): value is number => value !== undefined).map(secondsToUs)
    : [];
  return {
    track_id: candidate.public.track_id,
    title: candidate.catalogTrack.working_title,
    contributor_id: "local-user-confirmed-rights-holder",
    duration_us: durationUs,
    format: "m4a",
    full_mix: fullMixRef,
    preview: previewRef,
    rights_ref: rightsRef,
    analysis_ref: analysisRef,
    family: familyKey(candidate.catalogTrack.family),
    intensity: candidate.catalogTrack.energy,
    use_cases: useCases(candidate.catalogTrack.use_cases),
    exclusions: [...new Set(candidate.catalogTrack.avoid)].sort(),
    instruments: [...new Set(candidate.catalogTrack.instrumentation)].sort(),
    edit_points_us: uniqueNumbers([0, ...downbeats, durationUs], durationUs),
    loop_windows: [],
    axes: authoredAxes(candidate.catalogTrack),
    vocal_presence: "none",
  };
}

export function materializeBgmCandidatePack(
  options: MaterializeBgmCandidatePackOptions,
): BgmPackMaterializationResult {
  const scan = scanPromotionSources(options);
  const outputPath = validateBgmPromotionOutputPath(
    options.outputPath ?? defaultBgmPromotionOutputPath(),
    options.sourceRoot,
  );
  const parent = path.dirname(outputPath);
  fs.mkdirSync(parent, { recursive: true });
  const tempName = `.${path.basename(outputPath)}.tmp-${process.pid}-${createHash("sha256")
    .update(`${scan.plan.created_at}:${fs.realpathSync(options.sourceRoot)}`)
    .digest("hex")
    .slice(0, 12)}`;
  const tempPath = path.join(parent, tempName);
  if (fs.existsSync(tempPath)) {
    throw new BgmPackPromotionError(
      "BGM_PACK_BUSY",
      "A promotion staging directory already exists.",
      BGM_CANDIDATE_PACK_ID,
      true,
    );
  }

  const previewRenderer = options.previewRenderer ?? renderPreviewWithFfmpeg;
  let activated = false;
  try {
    for (const directory of ["audio", "previews", "analysis", "rights", "provenance"]) {
      fs.mkdirSync(path.join(tempPath, directory), { recursive: true });
    }
    const planRelativePath = "provenance/promotion-plan.json";
    const planBytes = writeJson(path.join(tempPath, planRelativePath), scan.plan);
    const provenanceRef = dataRef(planRelativePath, planBytes);
    const tracks: BgmPackTrack[] = [];

    for (const candidate of scan.selected) {
      const fullRelativePath = `audio/${candidate.public.track_id}.m4a`;
      const previewRelativePath = `previews/${candidate.public.track_id}-preview.flac`;
      const analysisRelativePath = `analysis/${candidate.public.track_id}.json`;
      const rightsRelativePath = `rights/${candidate.public.track_id}.json`;
      const fullPath = path.join(tempPath, fullRelativePath);
      const previewPath = path.join(tempPath, previewRelativePath);
      fs.copyFileSync(candidate.audioPath, fullPath, fs.constants.COPYFILE_EXCL);
      const copiedHash = hashFile(fullPath);
      const copiedStats = fs.statSync(fullPath);
      if (
        copiedHash !== candidate.public.source_content_hash
        || copiedStats.size !== candidate.public.source_size_bytes
      ) {
        throw new BgmPackPromotionError(
          "BGM_TRACK_HASH_MISMATCH",
          "Copied full mix no longer matches its verified source.",
          candidate.public.track_id,
        );
      }
      previewRenderer(candidate.audioPath, previewPath, candidate.public.duration_seconds);
      if (!fs.existsSync(previewPath) || !fs.statSync(previewPath).isFile()) {
        throw new BgmPackPromotionError(
          "BGM_TRACK_MISSING",
          "Preview renderer did not produce the required file.",
          candidate.public.track_id,
        );
      }
      const previewStats = fs.statSync(previewPath);
      const audioFacts = canonicalAudioFacts(candidate);
      const fullMixRef: BgmPackTrack["full_mix"] = {
        path: fullRelativePath,
        content_hash: copiedHash,
        size_bytes: copiedStats.size,
        format: "m4a",
      };
      const previewRef: BgmPackTrack["preview"] = {
        path: previewRelativePath,
        content_hash: hashFile(previewPath),
        size_bytes: previewStats.size,
        format: "flac",
      };
      const analysisBytes = writeJson(
        path.join(tempPath, analysisRelativePath),
        canonicalAnalysis(candidate, copiedHash, scan.plan.created_at, audioFacts),
      );
      const rightsBytes = writeJson(
        path.join(tempPath, rightsRelativePath),
        rightsRegister(candidate, copiedHash, scan.plan.created_at),
      );
      tracks.push(makeTrack(
        candidate,
        fullMixRef,
        previewRef,
        dataRef(rightsRelativePath, rightsBytes),
        dataRef(analysisRelativePath, analysisBytes),
      ));
    }

    const manifest: BgmPackManifest = {
      version: "1.0.0",
      pack_id: BGM_CANDIDATE_PACK_ID,
      pack_version: BGM_CANDIDATE_PACK_VERSION,
      title: "Video OS Core BGM v1 — Technical Candidate Pack",
      created_at: scan.plan.created_at,
      catalog_license: "private-candidate-catalog-not-for-redistribution",
      default_content_license: "not-specified-local-confirmation",
      compatible_video_os: {
        contract_min: "0.1.0",
        contract_max: "0.1.0",
      },
      tracks: tracks.sort((left, right) => left.track_id.localeCompare(right.track_id)),
      provenance: {
        producer: "Video OS deterministic BGM Pack promotion",
        source_type: "user_library",
        evidence_refs: [planRelativePath],
        evidence_assets: [provenanceRef],
      },
      hash_policy: {
        algorithm: "sha256",
        canonicalization: "normalized-json-v1",
        excluded_fields: [],
      },
    };
    writeJson(path.join(tempPath, "pack-manifest.json"), manifest);
    const stagingVerification = verifyPack(tempPath);
    if (!stagingVerification.ok || stagingVerification.issues.length > 0) {
      throw new BgmPackPromotionError(
        "BGM_PACK_INCOMPATIBLE",
        "Materialized candidate Pack failed Registry verification.",
        BGM_CANDIDATE_PACK_ID,
      );
    }
    fs.renameSync(tempPath, outputPath);
    activated = true;
    const verification = verifyPack(outputPath);
    if (!verification.ok || verification.issues.length > 0) {
      throw new BgmPackPromotionError(
        "BGM_PACK_INCOMPATIBLE",
        "Activated candidate Pack failed Registry verification.",
        BGM_CANDIDATE_PACK_ID,
      );
    }
    return {
      output_path: outputPath,
      plan: scan.plan,
      manifest,
      verification,
    };
  } catch (error) {
    if (!activated && fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { recursive: true, force: true });
    }
    throw error;
  }
}
