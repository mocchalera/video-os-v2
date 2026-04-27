import * as fs from "node:fs";
import * as path from "node:path";
import { computeNormalizedJsonHash } from "./p1-manifest-coverage.js";
import { computePreferenceMemoryHash } from "./p3-preference-memory.js";
import { validateAgainstSchema } from "../commands/shared.js";
import type { ReleaseSafetyCheck } from "./p4a-release-safety.js";

export type SearchTokenizer = "japanese_morpheme" | "english_word" | "raw_token" | "id_only";
export type SearchAutonomyMode = "full" | "interactive";

export interface SearchIndexInputs {
  source_media_manifest_hash: string;
  assets_hash: string;
  segments_hash: string;
  transcripts_hashes: string[];
  audio_story_graph_hash: string | null;
  continuity_graph_hash: string | null;
  editorial_preference_memory_hash: string | null;
  coverage_report_hash: string;
}

export interface SegmentSearchIndexManifest {
  version: string;
  project_id: string;
  artifact_version: "search-index-v1";
  created_at: string;
  index_id: string;
  inputs: SearchIndexInputs;
  structure: Array<{
    field: string;
    source_prefix: string;
    indexed: boolean;
    tokenizer: SearchTokenizer;
  }>;
  text_index: { path: string; hash: string };
  vector_shards: Array<{
    shard_id: string;
    path: string;
    embedding_model_id: string;
    dimension: number;
    hash: string | null;
    optional: boolean;
  }>;
  provenance: ArtifactProvenance;
}

export interface SegmentTextIndex {
  version: string;
  project_id: string;
  artifact_version: "text-index-v1";
  created_at: string;
  index_id: string;
  segments: Array<{
    segment_id: string;
    asset_id: string;
    normalized_text: string;
    token_refs: Array<{ token: string; source_field: string; source_id: string }>;
    source_artifact_ref: { path: string; hash: string; type: "transcript" | "audio_story_node" | "continuity_entity" };
  }>;
  provenance: ArtifactProvenance;
}

export interface ArtifactProvenance {
  producer: "scripts/rebuild-segment-search-index.ts";
  inputs: Array<{ path: string; hash: string; required?: boolean }>;
  hash_policy: {
    algorithm: "sha256";
    canonicalization: "normalized-json-v1";
    excluded_fields: string[];
  };
}

export interface LoadedSearchIndexManifest {
  path: string;
  hash: string;
  manifest: SegmentSearchIndexManifest;
}

export interface LoadedTextIndex {
  path: string;
  hash: string;
  index: SegmentTextIndex;
}

export interface MalformedSearchArtifact {
  path: string;
  hash: string | null;
  errors: string[];
}

export interface LoadSearchIndexManifestResult {
  manifest: LoadedSearchIndexManifest | null;
  malformed: MalformedSearchArtifact[];
}

export interface LoadTextIndexResult {
  index: LoadedTextIndex | null;
  malformed: MalformedSearchArtifact[];
}

const MANIFEST_REL_PATH = "03_analysis/search/segment_search_index_manifest.json";
const TEXT_INDEX_REL_PATH = "03_analysis/search/segment_text_index.json";
const ZERO_HASH = `sha256:${"0".repeat(64)}`;

const INPUT_PATHS = {
  source_media_manifest_hash: "02_media/source_media_manifest.json",
  assets_hash: "03_analysis/assets.json",
  segments_hash: "03_analysis/segments.json",
  audio_story_graph_hash: "03_analysis/audio_story_graph.json",
  continuity_graph_hash: "03_analysis/continuity_graph.json",
  editorial_preference_memory_hash: "03_analysis/editorial_preference_memory.jsonl",
  coverage_report_hash: "03_analysis/analysis_coverage_report.json",
} as const;

export function isP4dSearchIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.ENABLE_P4D_SEARCH_INDEX ?? "");
}

export function getSearchIndexAutonomyMode(env: NodeJS.ProcessEnv = process.env): SearchAutonomyMode {
  const raw = env.SEARCH_INDEX_AUTONOMY ?? "interactive";
  if (raw === "full" || raw === "interactive") return raw;
  throw new Error(`Invalid SEARCH_INDEX_AUTONOMY: ${raw}`);
}

export function computeSearchIndexManifestHash(manifest: unknown): string {
  return computeNormalizedJsonHash(manifest, ["created_at"]);
}

export function computeSegmentTextIndexHash(index: unknown): string {
  return computeNormalizedJsonHash(index, ["created_at"]);
}

export function loadSearchIndexManifest(
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadSearchIndexManifestResult {
  const manifestPath = path.join(projectPath, MANIFEST_REL_PATH);
  if (!isP4dSearchIndexEnabled(env)) return { manifest: null, malformed: [] };
  if (!fs.existsSync(manifestPath)) return { manifest: null, malformed: [] };
  let hash: string | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as SegmentSearchIndexManifest;
    hash = computeSearchIndexManifestHash(parsed);
    const schema = validateAgainstSchema(parsed, "segment-search-index-manifest.schema.json");
    if (!schema.valid) {
      return { manifest: null, malformed: [{ path: manifestPath, hash, errors: schema.errors }] };
    }
    return { manifest: { path: manifestPath, hash, manifest: parsed }, malformed: [] };
  } catch (err) {
    return { manifest: null, malformed: [{ path: manifestPath, hash, errors: [errorMessage(err)] }] };
  }
}

export function loadTextIndex(
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadTextIndexResult {
  const indexPath = path.join(projectPath, TEXT_INDEX_REL_PATH);
  if (!isP4dSearchIndexEnabled(env)) return { index: null, malformed: [] };
  if (!fs.existsSync(indexPath)) return { index: null, malformed: [] };
  let hash: string | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as SegmentTextIndex;
    hash = computeSegmentTextIndexHash(parsed);
    const schema = validateAgainstSchema(parsed, "segment-text-index.schema.json");
    const refs = validateTextIndexAssetRefs(parsed, currentAssetIds(projectPath));
    const errors = [...schema.errors, ...refs.violations];
    if (!schema.valid || !refs.valid) {
      return { index: null, malformed: [{ path: indexPath, hash, errors }] };
    }
    return { index: { path: indexPath, hash, index: parsed }, malformed: [] };
  } catch (err) {
    return { index: null, malformed: [{ path: indexPath, hash, errors: [errorMessage(err)] }] };
  }
}

export function currentSearchIndexInputHashes(projectDir: string): SearchIndexInputs {
  return {
    source_media_manifest_hash: canonicalJsonFileHash(path.join(projectDir, INPUT_PATHS.source_media_manifest_hash)) ?? ZERO_HASH,
    assets_hash: canonicalJsonFileHash(path.join(projectDir, INPUT_PATHS.assets_hash)) ?? ZERO_HASH,
    segments_hash: canonicalJsonFileHash(path.join(projectDir, INPUT_PATHS.segments_hash)) ?? ZERO_HASH,
    transcripts_hashes: transcriptHashes(projectDir),
    audio_story_graph_hash: canonicalJsonFileHash(path.join(projectDir, INPUT_PATHS.audio_story_graph_hash)),
    continuity_graph_hash: canonicalJsonFileHash(path.join(projectDir, INPUT_PATHS.continuity_graph_hash)),
    editorial_preference_memory_hash: preferenceMemoryHash(path.join(projectDir, INPUT_PATHS.editorial_preference_memory_hash)),
    coverage_report_hash: canonicalJsonFileHash(path.join(projectDir, INPUT_PATHS.coverage_report_hash)) ?? ZERO_HASH,
  };
}

export function searchIndexStaleReasons(
  manifestInput: SegmentSearchIndexManifest | Record<string, unknown>,
  current: SearchIndexInputs | Record<string, unknown>,
): string[] {
  const manifest = manifestInput as Partial<SegmentSearchIndexManifest>;
  const inputs = manifest.inputs as Partial<SearchIndexInputs> | undefined;
  if (!inputs) return ["manifest inputs missing"];
  const reasons: string[] = [];
  for (const key of [
    "source_media_manifest_hash",
    "assets_hash",
    "segments_hash",
    "audio_story_graph_hash",
    "continuity_graph_hash",
    "editorial_preference_memory_hash",
    "coverage_report_hash",
  ] as const) {
    if (inputs[key] !== (current as SearchIndexInputs)[key]) {
      reasons.push(`${key}: manifest=${inputs[key] ?? "null"} current=${(current as SearchIndexInputs)[key] ?? "null"}`);
    }
  }
  const expectedTranscripts = [...(inputs.transcripts_hashes ?? [])].sort();
  const currentTranscripts = [...((current as SearchIndexInputs).transcripts_hashes ?? [])].sort();
  if (JSON.stringify(expectedTranscripts) !== JSON.stringify(currentTranscripts)) {
    reasons.push(`transcripts_hashes: manifest=${expectedTranscripts.join(",")} current=${currentTranscripts.join(",")}`);
  }
  return reasons;
}

export function isSearchIndexStale(
  manifest: SegmentSearchIndexManifest,
  current: SearchIndexInputs,
): boolean {
  return searchIndexStaleReasons(manifest, current).length > 0;
}

export function materializeSearchHash(selectsCandidates: Record<string, unknown>, searchManifestHash: string): void {
  const current = selectsCandidates.provenance;
  const provenance = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  provenance.search_index_manifest_hash = searchManifestHash;
  selectsCandidates.provenance = provenance;
  ensurePlanningMinorVersion(selectsCandidates);
}

export function hasSearchInfluence(selectsCandidates: { candidates?: unknown[] }): boolean {
  return (selectsCandidates.candidates ?? []).some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const item = candidate as Record<string, unknown>;
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    return evidence.some((entry) => typeof entry === "string" && /\bsearch\b|segment_text_index|text match/i.test(entry));
  });
}

export function generateSearchStaleCheck(
  manifestInput: SegmentSearchIndexManifest | Record<string, unknown>,
  current: SearchIndexInputs | Record<string, unknown>,
  autonomyMode: SearchAutonomyMode = "interactive",
  projectDir = "",
): ReleaseSafetyCheck | null {
  const reasons = searchIndexStaleReasons(manifestInput, current);
  if (reasons.length === 0) return null;
  const manifestPath = projectDir ? path.join(projectDir, MANIFEST_REL_PATH) : MANIFEST_REL_PATH;
  return {
    check_id: "RSCHK_source_manifest_search_index_stale",
    category: "source_manifest",
    severity: autonomyMode === "full" ? "blocker" : "warning",
    status: "fail",
    message: `segment search index stale: ${reasons.join("; ")}`,
    artifact_refs: [
      { path: manifestPath, hash: computeSearchIndexManifestHash(manifestInput), required: false },
    ],
  };
}

export function validateTextIndexAssetRefs(
  indexInput: SegmentTextIndex | Record<string, unknown>,
  assetIds: Set<string>,
): { valid: boolean; violations: string[] } {
  const index = indexInput as Partial<SegmentTextIndex>;
  const violations: string[] = [];
  for (const segment of index.segments ?? []) {
    if (!assetIds.has(segment.asset_id)) {
      violations.push(`text index segment ${segment.segment_id} references missing asset_id ${segment.asset_id}`);
    }
  }
  return { valid: violations.length === 0, violations };
}

export function readSearchIndexStatus(projectDir: string): {
  enabled: boolean;
  exists: boolean;
  path: string;
  index_id?: string;
  hash?: string;
  stale?: boolean;
  stale_reasons?: string[];
  valid?: boolean;
  errors?: string[];
} {
  const manifestPath = path.join(projectDir, MANIFEST_REL_PATH);
  const loaded = loadSearchIndexManifest(projectDir);
  if (loaded.manifest) {
    const reasons = searchIndexStaleReasons(loaded.manifest.manifest, currentSearchIndexInputHashes(projectDir));
    return {
      enabled: true,
      exists: true,
      path: loaded.manifest.path,
      index_id: loaded.manifest.manifest.index_id,
      hash: loaded.manifest.hash,
      stale: reasons.length > 0,
      stale_reasons: reasons,
      valid: true,
    };
  }
  if (loaded.malformed.length > 0) {
    return {
      enabled: true,
      exists: true,
      path: manifestPath,
      valid: false,
      errors: loaded.malformed.flatMap((item) => item.errors),
    };
  }
  return { enabled: true, exists: false, path: manifestPath };
}

export function searchIndexInputRefs(projectDir: string, current: SearchIndexInputs): Array<{ path: string; hash: string; required: boolean }> {
  const refs: Array<{ path: string; hash: string | null; required: boolean }> = [
    { path: INPUT_PATHS.source_media_manifest_hash, hash: current.source_media_manifest_hash, required: true },
    { path: INPUT_PATHS.assets_hash, hash: current.assets_hash, required: true },
    { path: INPUT_PATHS.segments_hash, hash: current.segments_hash, required: true },
    { path: INPUT_PATHS.coverage_report_hash, hash: current.coverage_report_hash, required: true },
    { path: INPUT_PATHS.audio_story_graph_hash, hash: current.audio_story_graph_hash, required: false },
    { path: INPUT_PATHS.continuity_graph_hash, hash: current.continuity_graph_hash, required: false },
    { path: INPUT_PATHS.editorial_preference_memory_hash, hash: current.editorial_preference_memory_hash, required: false },
  ];
  return refs
    .filter((ref): ref is { path: string; hash: string; required: boolean } => typeof ref.hash === "string")
    .map((ref) => ({ ...ref, path: path.relative(projectDir, path.join(projectDir, ref.path)) || ref.path }));
}

function currentAssetIds(projectDir: string): Set<string> {
  const assetIds = new Set<string>();
  const assets = readJson(path.join(projectDir, INPUT_PATHS.assets_hash));
  const items = arrayFrom(assets, "items", "assets");
  for (const item of items) {
    if (typeof item.asset_id === "string") assetIds.add(item.asset_id);
  }
  const segments = readJson(path.join(projectDir, INPUT_PATHS.segments_hash));
  for (const item of arrayFrom(segments, "items", "segments")) {
    if (typeof item.asset_id === "string") assetIds.add(item.asset_id);
  }
  return assetIds;
}

function transcriptHashes(projectDir: string): string[] {
  const transcriptsDir = path.join(projectDir, "03_analysis/transcripts");
  if (!fs.existsSync(transcriptsDir)) return [];
  return fs.readdirSync(transcriptsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => canonicalJsonFileHash(path.join(transcriptsDir, file)) ?? ZERO_HASH);
}

function canonicalJsonFileHash(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return computeNormalizedJsonHash(JSON.parse(fs.readFileSync(filePath, "utf-8")), ["created_at"]);
  } catch {
    return ZERO_HASH;
  }
}

function preferenceMemoryHash(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return computePreferenceMemoryHash(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return ZERO_HASH;
  }
}

function readJson(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function arrayFrom(data: Record<string, unknown> | null, ...keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = data?.[key];
    if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }
  return [];
}

function ensurePlanningMinorVersion(artifact: Record<string, unknown>): void {
  if (typeof artifact.version !== "string") return;
  const match = artifact.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 1 && minor < 1) artifact.version = "1.1.0";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
