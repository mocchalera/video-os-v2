import * as fs from "node:fs";
import * as path from "node:path";
import {
  computeNormalizedJsonHash,
  type AnalysisCoverageReport,
  type LaneStatus,
  type SourceMediaManifest,
} from "./p1-manifest-coverage.js";
import {
  buildAudioStoryGraph,
  readAudioStoryGraph,
  writeAudioStoryGraph,
  type AudioStoryGraph,
} from "./p2-audio-story-graph.js";

interface AssetsLike {
  project_id?: string;
  items?: Array<{ asset_id?: string; filename?: string }>;
}

interface BuildProjectAudioStoryGraphOptions {
  projectDir: string;
  write?: boolean;
  createdAt?: string;
}

export interface ProjectAudioStoryGraphBuildResult {
  projectDir: string;
  projectId: string;
  graphPath: string;
  previousNodeCount: number;
  nodeCount: number;
  edgeCount: number;
  dialogueNodeCount: number;
  audioEventNodeCount: number;
  musicNodeCount: number;
  status: AudioStoryGraph["coverage"]["status"];
  missingInputs: string[];
  written: boolean;
}

export function buildProjectAudioStoryGraph(
  options: BuildProjectAudioStoryGraphOptions,
): ProjectAudioStoryGraphBuildResult {
  const projectDir = path.resolve(options.projectDir);
  const analysisDir = path.join(projectDir, "03_analysis");
  const assets = readJsonIfExists<AssetsLike>(path.join(analysisDir, "assets.json"));
  const projectId = assets?.project_id ?? path.basename(projectDir);
  const manifest = readSourceManifest(projectDir, projectId, assets);
  const currentAssetIds = new Set(((manifest as { items?: Array<{ asset_id?: string }> }).items ?? [])
    .map((item) => item.asset_id)
    .filter((assetId): assetId is string => !!assetId));
  const transcripts = readTranscriptDocuments(path.join(analysisDir, "transcripts"))
    .filter((item) => currentAssetIds.has(readAssetId(item)));
  const audioEvents = filterAudioEvents(
    readJsonIfExists(path.join(analysisDir, "audio_events.json")),
    currentAssetIds,
  );
  const bgmAnalysis = filterBgmAnalysis(
    readJsonIfExists(path.join(analysisDir, "bgm_analysis.json")),
    currentAssetIds,
  );
  const coverageReport = readCoverageReport(projectDir, projectId, manifest, transcripts, audioEvents, bgmAnalysis);
  const previous = readAudioStoryGraph(projectDir);

  const graph = buildAudioStoryGraph({
    projectId,
    manifest,
    coverageReport,
    transcripts: transcripts as never,
    audioEvents: audioEvents as never,
    bgmAnalysis: bgmAnalysis as never,
    transcriptHashes: transcripts.map((transcript) => computeNormalizedJsonHash(transcript)),
    createdAt: options.createdAt,
  });

  if (options.write !== false) {
    writeAudioStoryGraph(projectDir, graph);
  }

  return summarize(projectDir, projectId, previous, graph, options.write !== false);
}

function summarize(
  projectDir: string,
  projectId: string,
  previous: AudioStoryGraph | null,
  graph: AudioStoryGraph,
  written: boolean,
): ProjectAudioStoryGraphBuildResult {
  const dialogueNodeCount = graph.nodes.filter((node) => node.node_type === "utterance" || node.node_type === "speaker_turn").length;
  const audioEventNodeCount = graph.nodes.filter((node) => ["silence", "laughter", "applause", "impact", "ambient_shift", "emotion_lift", "emotion_drop"].includes(node.node_type)).length;
  const musicNodeCount = graph.nodes.filter((node) => node.node_type === "music_section").length;
  return {
    projectDir,
    projectId,
    graphPath: path.join(projectDir, "03_analysis/audio_story_graph.json"),
    previousNodeCount: previous?.nodes.length ?? 0,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    dialogueNodeCount,
    audioEventNodeCount,
    musicNodeCount,
    status: graph.coverage.status,
    missingInputs: graph.coverage.missing_inputs,
    written,
  };
}

function readTranscriptDocuments(transcriptDir: string): unknown[] {
  if (!fs.existsSync(transcriptDir)) return [];
  return fs.readdirSync(transcriptDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => readJsonIfExists(path.join(transcriptDir, entry)))
    .filter((item): item is unknown => item != null);
}

function readSourceManifest(projectDir: string, projectId: string, assets: AssetsLike | null): SourceMediaManifest | { source_media_manifest_hash: string; items: Array<{ asset_id?: string }> } {
  const canonicalPath = path.join(projectDir, "02_media/source_media_manifest.json");
  const canonical = readJsonIfExists<SourceMediaManifest>(canonicalPath);
  if (canonical) return canonical;
  const legacyPath = path.join(projectDir, "03_analysis/source_media_manifest.json");
  const legacy = readJsonIfExists<SourceMediaManifest>(legacyPath);
  if (legacy) return legacy;

  const items = (assets?.items ?? []).map((asset) => ({
    asset_id: asset.asset_id,
    filename: asset.filename,
  }));
  const fallbackManifest = {
    project_id: projectId,
    artifact_version: "manifest-fallback-v1",
    items,
  };
  return {
    source_media_manifest_hash: computeNormalizedJsonHash(fallbackManifest),
    items: items.map((item) => ({ asset_id: item.asset_id })),
  };
}

function readCoverageReport(
  projectDir: string,
  projectId: string,
  manifest: SourceMediaManifest | { source_media_manifest_hash: string; items: Array<{ asset_id?: string }> },
  transcripts: unknown[],
  audioEvents: unknown | null,
  bgmAnalysis: unknown | null,
): AnalysisCoverageReport | { hash: string; lanes: LaneStatus[] } {
  const reportPath = path.join(projectDir, "03_analysis/analysis_coverage_report.json");
  const report = readJsonIfExists<AnalysisCoverageReport>(reportPath);
  if (report) return report;

  const assetIds = ((manifest as { items?: Array<{ asset_id?: string }> }).items ?? [])
    .map((item) => item.asset_id)
    .filter((assetId): assetId is string => !!assetId);
  const lanes: LaneStatus[] = [
    fallbackLane("stt", transcripts.length > 0 ? "ready" : "skipped", assetIds),
    fallbackLane("audio_events", hasItems(audioEvents) ? "ready" : "skipped", assetIds),
    fallbackLane("bgm_analysis", hasMusicEvidence(bgmAnalysis) ? "ready" : "skipped", assetIds),
  ];
  const fallback = {
    project_id: projectId,
    lanes,
  };
  return {
    hash: computeNormalizedJsonHash(fallback),
    lanes,
  };
}

function fallbackLane(laneId: string, status: LaneStatus["status"], assetIds: string[]): LaneStatus {
  return {
    lane_id: laneId,
    status,
    required: false,
    reason: status === "ready" ? null : `${laneId} artifact missing`,
    consumer_impact: status === "ready" ? "none" : "planning_warn",
    asset_ids: assetIds,
    artifact_hash: null,
  };
}

function hasItems(value: unknown): boolean {
  return !!value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items) && (value as { items: unknown[] }).items.length > 0;
}

function hasMusicEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const analysis = value as { sections?: unknown[]; beats?: unknown[]; beats_sec?: unknown[] };
  return (analysis.sections?.length ?? 0) > 0 || (analysis.beats?.length ?? 0) > 0 || (analysis.beats_sec?.length ?? 0) > 0;
}

function readJsonIfExists<T = unknown>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function readAssetId(value: unknown): string {
  return value && typeof value === "object" && typeof (value as { asset_id?: unknown }).asset_id === "string"
    ? (value as { asset_id: string }).asset_id
    : "";
}

function filterAudioEvents(value: unknown | null, currentAssetIds: Set<string>): unknown | null {
  if (!value || typeof value !== "object") return value;
  const artifact = value as { items?: Array<{ asset_id?: string }> };
  if (!Array.isArray(artifact.items)) return value;
  return { ...artifact, items: artifact.items.filter((item) => !!item.asset_id && currentAssetIds.has(item.asset_id)) };
}

function filterBgmAnalysis(value: unknown | null, currentAssetIds: Set<string>): unknown | null {
  if (!value || typeof value !== "object") return value;
  const assetId = (value as { music_asset?: { asset_id?: string } }).music_asset?.asset_id;
  return assetId && (currentAssetIds.has(assetId) || assetId.startsWith("BGM_")) ? value : null;
}
