#!/usr/bin/env tsx
import * as fs from "node:fs";
import * as path from "node:path";
import {
  computeSearchIndexManifestHash,
  computeSegmentTextIndexHash,
  currentSearchIndexInputHashes,
  isP4dSearchIndexEnabled,
  searchIndexInputRefs,
  type SearchTokenizer,
  type SegmentSearchIndexManifest,
  type SegmentTextIndex,
} from "../runtime/artifacts/p4d-segment-search-index.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

interface Args {
  project?: string;
  outputDir?: string;
  tokenizer?: SearchTokenizer;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--project") {
      args.project = value;
      i += 1;
    } else if (arg === "--output-dir") {
      args.outputDir = value;
      i += 1;
    } else if (arg === "--tokenizer") {
      args.tokenizer = value as SearchTokenizer;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function main(): void {
  if (!isP4dSearchIndexEnabled()) {
    throw new Error("ENABLE_P4D_SEARCH_INDEX must be true to rebuild segment search index");
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.project || !args.outputDir || !args.tokenizer) usage(1);
  if (!["japanese_morpheme", "english_word", "raw_token", "id_only"].includes(args.tokenizer)) {
    throw new Error("--tokenizer must be japanese_morpheme, english_word, raw_token, or id_only");
  }

  const projectDir = path.resolve(args.project);
  const outputDir = path.resolve(args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const indexId = `SIDX_${stableSuffix(projectDir)}`;
  const current = currentSearchIndexInputHashes(projectDir);
  const textIndex = buildTextIndex(projectDir, indexId, args.tokenizer);
  const textIndexPath = path.join(outputDir, "segment_text_index.json");
  validateOrThrow(textIndex, "segment-text-index.schema.json");
  fs.writeFileSync(textIndexPath, `${JSON.stringify(textIndex, null, 2)}\n`, "utf-8");

  const manifest = buildManifest(projectDir, indexId, args.tokenizer, current, path.relative(projectDir, textIndexPath), computeSegmentTextIndexHash(textIndex));
  validateOrThrow(manifest, "segment-search-index-manifest.schema.json");
  const manifestPath = path.join(outputDir, "segment_search_index_manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  process.stdout.write(JSON.stringify({
    manifest: manifestPath,
    text_index: textIndexPath,
    manifest_hash: computeSearchIndexManifestHash(manifest),
    text_index_hash: computeSegmentTextIndexHash(textIndex),
  }) + "\n");
}

function buildTextIndex(projectDir: string, indexId: string, tokenizer: SearchTokenizer): SegmentTextIndex {
  const projectId = readProjectId(projectDir);
  const segmentItems = readArray(path.join(projectDir, "03_analysis/segments.json"), "items", "segments");
  const transcriptsByAsset = readTranscripts(projectDir);
  const segments = segmentItems.map((segment) => {
    const segmentId = stringValue(segment.segment_id) || `SEG_${stringValue(segment.asset_id) || "unknown"}_0000`;
    const assetId = stringValue(segment.asset_id) || "AST_unknown";
    const transcriptText = transcriptsByAsset.get(assetId) ?? "";
    const rawText = [
      stringValue(segment.transcript_excerpt),
      stringValue(segment.summary),
      transcriptText,
      ...arrayStrings(segment.tags),
      ...arrayStrings(segment.visual_tags),
    ].filter(Boolean).join(" ");
    const normalizedText = normalizeIndexText(rawText);
    const tokens = tokenize(normalizedText, tokenizer);
    return {
      segment_id: segmentId,
      asset_id: assetId,
      normalized_text: normalizedText,
      token_refs: tokens.map((token) => ({
        token,
        source_field: "transcript_text",
        source_id: `TR_${assetId.replace(/^AST_/, "")}`,
      })),
      source_artifact_ref: transcriptArtifactRef(projectDir, assetId),
    };
  });
  return {
    version: "1.0.0",
    project_id: projectId,
    artifact_version: "text-index-v1",
    created_at: new Date().toISOString(),
    index_id: indexId,
    segments,
    provenance: {
      producer: "scripts/rebuild-segment-search-index.ts",
      inputs: transcriptInputRefs(projectDir),
      hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: ["created_at"] },
    },
  };
}

function buildManifest(
  projectDir: string,
  indexId: string,
  tokenizer: SearchTokenizer,
  inputs: SegmentSearchIndexManifest["inputs"],
  textIndexRelPath: string,
  textIndexHash: string,
): SegmentSearchIndexManifest {
  return {
    version: "1.0.0",
    project_id: readProjectId(projectDir),
    artifact_version: "search-index-v1",
    created_at: new Date().toISOString(),
    index_id: indexId,
    inputs,
    structure: [
      { field: "transcript_text", source_prefix: "TR_", indexed: true, tokenizer },
      { field: "visual_tags", source_prefix: "AST_", indexed: true, tokenizer: "raw_token" },
      { field: "audio_event", source_prefix: "AE_", indexed: true, tokenizer: "raw_token" },
      { field: "continuity_entity", source_prefix: "ENT_", indexed: true, tokenizer: "id_only" },
      { field: "audio_story_node", source_prefix: "ASG_", indexed: true, tokenizer: "id_only" },
    ],
    text_index: {
      path: textIndexRelPath,
      hash: textIndexHash,
    },
    vector_shards: [],
    provenance: {
      producer: "scripts/rebuild-segment-search-index.ts",
      inputs: searchIndexInputRefs(projectDir, inputs),
      hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: ["created_at"] },
    },
  };
}

function normalizeIndexText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function tokenize(value: string, tokenizer: SearchTokenizer): string[] {
  if (!value) return [];
  if (tokenizer === "id_only") return value.split(/\s+/).filter((token) => /^[A-Z]+_/.test(token));
  if (tokenizer === "raw_token") return Array.from(new Set(value.split(/\s+/).filter(Boolean)));
  if (tokenizer === "english_word") return Array.from(new Set(value.toLowerCase().match(/[a-z0-9_-]+/g) ?? []));
  return Array.from(new Set(value.split(/\s+|、|。|,|\./).filter(Boolean)));
}

function readProjectId(projectDir: string): string {
  for (const relPath of ["05_timeline/timeline.json", "03_analysis/assets.json", "02_media/source_media_manifest.json"]) {
    const data = readJson(path.join(projectDir, relPath));
    if (typeof data?.project_id === "string") return data.project_id;
  }
  return path.basename(projectDir);
}

function readTranscripts(projectDir: string): Map<string, string> {
  const result = new Map<string, string>();
  const transcriptsDir = path.join(projectDir, "03_analysis/transcripts");
  if (!fs.existsSync(transcriptsDir)) return result;
  for (const file of fs.readdirSync(transcriptsDir).filter((name) => name.endsWith(".json")).sort()) {
    const data = readJson(path.join(transcriptsDir, file));
    const assetId = stringValue(data?.asset_id) || file.replace(/\.json$/, "");
    const text = stringValue(data?.text) || readArray(path.join(transcriptsDir, file), "items")
      .map((item) => stringValue(item.text))
      .filter(Boolean)
      .join(" ");
    result.set(assetId, text);
  }
  return result;
}

function transcriptArtifactRef(projectDir: string, assetId: string): SegmentTextIndex["segments"][number]["source_artifact_ref"] {
  const relPath = `03_analysis/transcripts/${assetId}.json`;
  const filePath = path.join(projectDir, relPath);
  const actualPath = fs.existsSync(filePath)
    ? filePath
    : path.join(projectDir, "03_analysis/transcripts", `${assetId.replace(/^AST_/, "")}.json`);
  return {
    path: path.relative(projectDir, actualPath),
    hash: canonicalHashOrZero(actualPath),
    type: "transcript",
  };
}

function transcriptInputRefs(projectDir: string): Array<{ path: string; hash: string; required: boolean }> {
  const transcriptsDir = path.join(projectDir, "03_analysis/transcripts");
  if (!fs.existsSync(transcriptsDir)) return [];
  return fs.readdirSync(transcriptsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const filePath = path.join(transcriptsDir, file);
      return { path: path.relative(projectDir, filePath), hash: canonicalHashOrZero(filePath), required: false };
    });
}

function readArray(filePath: string, ...keys: string[]): Record<string, unknown>[] {
  const data = readJson(filePath);
  for (const key of keys) {
    const value = data?.[key];
    if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }
  return [];
}

function readJson(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function canonicalHashOrZero(filePath: string): string {
  const data = readJson(filePath);
  if (!data) return `sha256:${"0".repeat(64)}`;
  return computeSegmentTextIndexHash(data);
}

function validateOrThrow(value: unknown, schemaFile: string): void {
  const result = validateAgainstSchema(value, schemaFile);
  if (!result.valid) throw new Error(result.errors.join("; "));
}

function stableSuffix(value: string): string {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function usage(code: number): never {
  const message = "Usage: tsx scripts/rebuild-segment-search-index.ts --project <path> --output-dir <path> --tokenizer <name>";
  if (code === 0) {
    process.stdout.write(`${message}\n`);
    process.exit(0);
  }
  throw new Error(message);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
