import * as fs from "node:fs";
import * as path from "node:path";
import {
  computeNormalizedJsonHash,
  type AnalysisCoverageReport,
  type LaneStatus,
  type RunnerValidationResult,
  type SourceMediaManifest,
} from "./p1-manifest-coverage.js";
import {
  hasM2BgmProvenance,
  isBgmAnalysisAcceptedForConsumption,
} from "../media/bgm-analysis-contract.js";

type GraphStatus = "ready" | "partial" | "skipped" | "failed";
type StoryRole = "hook" | "setup" | "experience" | "payoff" | "reaction" | "closing" | null;
type AudioNodeType =
  | "utterance"
  | "speaker_turn"
  | "silence"
  | "laughter"
  | "applause"
  | "music_section"
  | "impact"
  | "ambient_shift"
  | "emotion_lift"
  | "emotion_drop";
type AudioEdgeType =
  | "precedes"
  | "responds_to"
  | "overlaps"
  | "supports_beat"
  | "contrasts_with"
  | "music_under"
  | "silence_after"
  | "payoff_for";

export interface AudioStoryGraphNode {
  node_id: string;
  node_type: AudioNodeType;
  asset_id: string;
  start_us: number;
  end_us: number;
  text?: string | null;
  story_role?: StoryRole;
  refs: {
    transcript_ref: string | null;
    speaker_ref: string | null;
    audio_event_ref: string | null;
    bgm_ref: string | null;
  };
  confidence: {
    score: number;
    source: string;
    status: string;
    label?: string;
  };
}

export interface AudioStoryGraphEdge {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  type: AudioEdgeType;
}

export interface AudioStoryGraph {
  version: "1.0.0";
  project_id: string;
  artifact_version: "analysis-v3";
  created_at: string;
  source_media_manifest_hash: string;
  inputs: {
    transcript_hashes: string[];
    audio_events_hash: string | null;
    bgm_analysis_hash: string | null;
    coverage_report_hash: string;
  };
  nodes: AudioStoryGraphNode[];
  edges: AudioStoryGraphEdge[];
  coverage: {
    status: GraphStatus;
    dialogue_lane: GraphStatus;
    audio_event_lane: GraphStatus;
    music_lane: GraphStatus;
    missing_inputs: string[];
  };
  provenance: {
    producer: "analysis-pipeline" | "blueprint-projection";
    inputs: Array<Record<string, unknown>>;
    hash_policy: {
      algorithm: "sha256";
      canonicalization: "normalized-json-v1";
      excluded_fields: string[];
    };
  };
}

interface TranscriptLike {
  transcript_ref?: string;
  asset_id?: string;
  analysis_status?: string;
  items?: Array<{
    item_id?: string;
    speaker?: string;
    speaker_key?: string;
    start_us?: number;
    end_us?: number;
    text?: string;
    confidence?: number;
  }>;
}

interface AudioEventsLike {
  items?: Array<{
    event_id?: string;
    asset_id?: string;
    type?: string;
    start_us?: number;
    end_us?: number;
    confidence?: { score?: number; source?: string; status?: string };
  }>;
}

interface BgmAnalysisLike {
  analysis_status?: string;
  music_asset?: { asset_id?: string };
  sections?: Array<{
    id?: string;
    label?: string;
    start_sec?: number;
    end_sec?: number;
    energy?: number;
  }>;
}

export interface BuildAudioStoryGraphOptions {
  projectId: string;
  manifest: SourceMediaManifest | { source_media_manifest_hash?: string; items?: Array<{ asset_id?: string }> };
  coverageReport: AnalysisCoverageReport | { hash?: string; lanes?: Array<{ lane_id?: string; status?: string; reason?: string | null }> };
  transcripts?: TranscriptLike[];
  audioEvents?: AudioEventsLike | null;
  bgmAnalysis?: BgmAnalysisLike | null;
  transcriptHashes?: string[];
  audioEventsHash?: string | null;
  bgmAnalysisHash?: string | null;
  /** True when a supplied M2 artifact was rejected by the shared contract. */
  bgmAnalysisRejected?: boolean;
  coverageReportHash?: string;
  createdAt?: string;
}

export interface ValidateAudioStoryGraphOptions {
  manifestAssetIds?: string[];
  sourceMediaManifestHash?: string;
}

export function isP2AudioStoryGraphEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.ENABLE_P2_AUDIO_STORY_GRAPH ?? "");
}

export function computeAudioStoryGraphHash(graph: unknown): string {
  const excluded = graph && typeof graph === "object"
    ? (((graph as AudioStoryGraph).provenance?.hash_policy?.excluded_fields) ?? ["created_at"])
    : ["created_at"];
  return computeNormalizedJsonHash(graph, excluded);
}

export function isAudioStoryGraphStale(graph: unknown, currentSourceMediaManifestHash: string): boolean {
  const current = (graph as Partial<AudioStoryGraph>)?.source_media_manifest_hash;
  return current !== currentSourceMediaManifestHash;
}

export function validateAudioStoryGraph(
  data: unknown,
  options: ValidateAudioStoryGraphOptions = {},
): RunnerValidationResult {
  const violations: string[] = [];
  const graph = data as Partial<AudioStoryGraph>;
  const nodeIds = new Set<string>();

  if (!Array.isArray(graph.nodes)) {
    violations.push("nodes must be an array");
  } else {
    for (const [index, node] of graph.nodes.entries()) {
      if (nodeIds.has(node.node_id)) {
        violations.push(`nodes/${index} duplicate node_id ${node.node_id}`);
      }
      nodeIds.add(node.node_id);
      if (node.end_us <= node.start_us) {
        violations.push(`nodes/${index} end_us must be greater than start_us`);
      }
      if (options.manifestAssetIds && !options.manifestAssetIds.includes(node.asset_id)) {
        violations.push(`nodes/${index} asset_id ${node.asset_id} not found in source_media_manifest`);
      }
      if (node.asset_id.startsWith("BGM_") && node.node_type !== "music_section") {
        violations.push(`nodes/${index} BGM asset_id is only valid for music_section nodes`);
      }
      if (graph.coverage?.dialogue_lane === "failed" && ["utterance", "speaker_turn"].includes(node.node_type)) {
        violations.push("failed dialogue_lane cannot contain invented dialogue nodes");
      }
    }
  }

  if (Array.isArray(graph.edges)) {
    for (const [index, edge] of graph.edges.entries()) {
      if (!nodeIds.has(edge.from_node_id)) {
        violations.push(`edges/${index} from_node_id ${edge.from_node_id} not found in nodes`);
      }
      if (!nodeIds.has(edge.to_node_id)) {
        violations.push(`edges/${index} to_node_id ${edge.to_node_id} not found in nodes`);
      }
    }
  }

  if (
    options.sourceMediaManifestHash &&
    graph.source_media_manifest_hash &&
    graph.source_media_manifest_hash !== options.sourceMediaManifestHash
  ) {
    violations.push("source_media_manifest_hash is stale");
  }

  return { valid: violations.length === 0, violations };
}

export function buildAudioStoryGraph(options: BuildAudioStoryGraphOptions): AudioStoryGraph {
  const manifestItems = Array.isArray(options.manifest.items) ? options.manifest.items : [];
  const manifestAssetIds = manifestItems
    .map((item) => item.asset_id)
    .filter((id): id is string => typeof id === "string");
  const bgmAccepted = options.bgmAnalysis == null || isBgmAnalysisAcceptedForConsumption(options.bgmAnalysis);
  const admittedBgmAnalysis = bgmAccepted ? options.bgmAnalysis : null;
  const bgmAnalysisRejected = options.bgmAnalysisRejected === true
    || Boolean(options.bgmAnalysis && hasM2BgmProvenance(options.bgmAnalysis) && !bgmAccepted);
  const bgmAssetId = admittedBgmAnalysis?.music_asset?.asset_id;
  const validationAssetIds = bgmAssetId?.startsWith("BGM_")
    ? [...manifestAssetIds, bgmAssetId]
    : manifestAssetIds;
  const manifestHash = getManifestHash(options.manifest);
  const coverageHash = options.coverageReportHash ?? getCoverageHash(options.coverageReport);
  const transcriptHashes = options.transcriptHashes ?? [];
  const nodes: AudioStoryGraphNode[] = [
    ...buildTranscriptNodes(options.transcripts ?? []),
    ...buildAudioEventNodes(options.audioEvents),
    ...buildBgmNodes(admittedBgmAnalysis),
  ];
  const sorted = sortAudioStoryGraph({
    version: "1.0.0",
    project_id: options.projectId,
    artifact_version: "analysis-v3",
    created_at: options.createdAt ?? new Date().toISOString(),
    source_media_manifest_hash: manifestHash,
    inputs: {
      transcript_hashes: transcriptHashes,
      audio_events_hash: options.audioEventsHash ?? (options.audioEvents ? computeNormalizedJsonHash(options.audioEvents) : null),
      bgm_analysis_hash: bgmAccepted
        ? options.bgmAnalysisHash ?? (admittedBgmAnalysis ? computeNormalizedJsonHash(admittedBgmAnalysis) : null)
        : null,
      coverage_report_hash: coverageHash,
    },
    nodes,
    edges: buildEdges(nodes),
    coverage: deriveGraphCoverage(options.coverageReport, nodes, bgmAnalysisRejected),
    provenance: {
      producer: "analysis-pipeline",
      inputs: [
        { path: "02_media/source_media_manifest.json", hash: manifestHash },
        { path: "03_analysis/analysis_coverage_report.json", hash: coverageHash },
      ],
      hash_policy: {
        algorithm: "sha256",
        canonicalization: "normalized-json-v1",
        excluded_fields: ["created_at"],
      },
    },
  }, manifestAssetIds);

  const integrity = validateAudioStoryGraph(sorted, {
    manifestAssetIds: validationAssetIds,
    sourceMediaManifestHash: manifestHash,
  });
  if (!integrity.valid) {
    throw new Error(`audio_story_graph validation failed: ${integrity.violations.join("; ")}`);
  }
  return sorted;
}

export function sortAudioStoryGraph(graph: AudioStoryGraph, assetOrder?: string[]): AudioStoryGraph {
  const rank = new Map((assetOrder ?? collectAssetOrder(graph.nodes)).map((assetId, index) => [assetId, index]));
  const nodes = [...graph.nodes].sort((a, b) =>
    (rank.get(a.asset_id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.asset_id) ?? Number.MAX_SAFE_INTEGER) ||
    a.start_us - b.start_us ||
    a.node_id.localeCompare(b.node_id)
  );
  const edges = [...graph.edges].sort((a, b) =>
    a.from_node_id.localeCompare(b.from_node_id) ||
    a.to_node_id.localeCompare(b.to_node_id) ||
    a.type.localeCompare(b.type) ||
    a.edge_id.localeCompare(b.edge_id)
  );
  return { ...graph, nodes, edges };
}

export function addAudioStoryGraphLaneToCoverage(
  report: AnalysisCoverageReport,
  graph: AudioStoryGraph,
): AnalysisCoverageReport {
  const artifactHash = computeAudioStoryGraphHash(graph);
  const lane: LaneStatus = {
    lane_id: "audio_story_graph",
    status: graph.coverage.status,
    required: false,
    reason: graph.coverage.status === "ready" ? null : `audio story graph ${graph.coverage.status}`,
    consumer_impact: graph.coverage.status === "ready" ? "none" : "planning_warn",
    asset_ids: Array.from(new Set(graph.nodes.map((node) => node.asset_id))).sort(),
    artifact_hash: artifactHash,
  };
  const lanes = [...report.lanes.filter((item) => item.lane_id !== "audio_story_graph"), lane];
  return {
    ...report,
    lanes,
    assets: report.assets.map((asset) => ({
      ...asset,
      lanes: [
        ...asset.lanes.filter((item) => item.lane_id !== "audio_story_graph"),
        ...(lane.asset_ids.includes(asset.asset_id) ? [lane] : []),
      ],
    })),
    provenance: {
      ...report.provenance,
      inputs: [
        ...report.provenance.inputs.filter((input) => (input as { path?: string }).path !== "03_analysis/audio_story_graph.json"),
        { path: "03_analysis/audio_story_graph.json", hash: artifactHash },
      ],
    },
  };
}

export function writeAudioStoryGraph(projectDir: string, graph: AudioStoryGraph): void {
  const outPath = path.join(projectDir, "03_analysis/audio_story_graph.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(graph, null, 2)}\n`, "utf-8");
}

export function readAudioStoryGraph(projectDir: string): AudioStoryGraph | null {
  const graphPath = path.join(projectDir, "03_analysis/audio_story_graph.json");
  if (!fs.existsSync(graphPath)) return null;
  return JSON.parse(fs.readFileSync(graphPath, "utf-8")) as AudioStoryGraph;
}

export function audioStoryNodesForWindow(
  graph: AudioStoryGraph,
  assetId: string,
  startUs: number,
  endUs: number,
): AudioStoryGraphNode[] {
  return graph.nodes.filter((node) =>
    node.asset_id === assetId &&
    node.start_us < endUs &&
    node.end_us > startUs
  );
}

function buildTranscriptNodes(transcripts: TranscriptLike[]): AudioStoryGraphNode[] {
  const nodes: AudioStoryGraphNode[] = [];
  for (const transcript of transcripts) {
    if (transcript.analysis_status === "failed") continue;
    for (const item of transcript.items ?? []) {
      if (typeof item.start_us !== "number" || typeof item.end_us !== "number" || !item.text) continue;
      const itemId = item.item_id ?? makeId(`${transcript.asset_id ?? "asset"}_${item.start_us}`);
      const speakerRef = normalizeSpeakerRef(item.speaker_key ?? item.speaker);
      nodes.push({
        node_id: `UTTREF_${makeId(itemId)}`,
        node_type: "utterance",
        asset_id: transcript.asset_id ?? "AST_unknown",
        start_us: item.start_us,
        end_us: item.end_us,
        text: item.text,
        story_role: inferStoryRole(nodes.length),
        refs: {
          transcript_ref: itemId.startsWith("UTT_") ? itemId : `UTT_${makeId(itemId)}`,
          speaker_ref: speakerRef,
          audio_event_ref: null,
          bgm_ref: null,
        },
        confidence: {
          score: typeof item.confidence === "number" ? item.confidence : 0.75,
          source: "transcript",
          status: "ready",
        },
      });
    }
  }
  return nodes;
}

function normalizeSpeakerRef(value?: string): string | null {
  if (!value) return null;
  if (/^SPK_[A-Za-z0-9_-]+$/.test(value)) return value;
  return `SPK_${makeId(value)}`;
}

function buildAudioEventNodes(audioEvents?: AudioEventsLike | null): AudioStoryGraphNode[] {
  const nodes: AudioStoryGraphNode[] = [];
  for (const event of audioEvents?.items ?? []) {
    if (
      !event.event_id ||
      !event.asset_id ||
      typeof event.start_us !== "number" ||
      typeof event.end_us !== "number"
    ) continue;
    const nodeType = mapAudioEventType(event.type);
    if (!nodeType) continue;
    nodes.push({
      node_id: `AEREF_${makeId(event.event_id)}`,
      node_type: nodeType,
      asset_id: event.asset_id,
      start_us: event.start_us,
      end_us: event.end_us,
      text: null,
      story_role: nodeType === "impact" || nodeType === "laughter" || nodeType === "applause" ? "reaction" : "experience",
      refs: {
        transcript_ref: null,
        speaker_ref: null,
        audio_event_ref: event.event_id.startsWith("AE_") ? event.event_id : `AE_${makeId(event.event_id)}`,
        bgm_ref: null,
      },
      confidence: {
        score: event.confidence?.score ?? 0.7,
        source: event.confidence?.source ?? "audio_events",
        status: event.confidence?.status ?? "ready",
      },
    });
  }
  return nodes;
}

function buildBgmNodes(bgmAnalysis?: BgmAnalysisLike | null): AudioStoryGraphNode[] {
  const assetId = bgmAnalysis?.music_asset?.asset_id;
  if (!assetId || (bgmAnalysis.analysis_status !== undefined && bgmAnalysis.analysis_status !== "ready")) return [];
  if (!isBgmAnalysisAcceptedForConsumption(bgmAnalysis)) return [];
  return (bgmAnalysis.sections ?? []).flatMap((section): AudioStoryGraphNode[] => {
    if (!section.id || typeof section.start_sec !== "number" || typeof section.end_sec !== "number") return [];
    return [{
      node_id: `BGMREF_${makeId(section.id)}`,
      node_type: "music_section",
      asset_id: assetId,
      start_us: Math.round(section.start_sec * 1_000_000),
      end_us: Math.round(section.end_sec * 1_000_000),
      text: null,
      story_role: inferMusicStoryRole(section.label),
      refs: {
        transcript_ref: null,
        speaker_ref: null,
        audio_event_ref: null,
        bgm_ref: section.id.startsWith("BGM_") ? section.id : `BGM_${makeId(section.id)}`,
      },
      confidence: {
        score: section.energy ?? 0.75,
        source: "bgm_analysis",
        status: "ready",
      },
    }];
  });
}

function buildEdges(nodes: AudioStoryGraphNode[]): AudioStoryGraphEdge[] {
  const byAsset = new Map<string, AudioStoryGraphNode[]>();
  for (const node of nodes) {
    const list = byAsset.get(node.asset_id) ?? [];
    list.push(node);
    byAsset.set(node.asset_id, list);
  }

  const edges: AudioStoryGraphEdge[] = [];
  for (const [assetId, assetNodes] of byAsset.entries()) {
    const sorted = [...assetNodes].sort((a, b) => a.start_us - b.start_us || a.node_id.localeCompare(b.node_id));
    for (let index = 0; index < sorted.length - 1; index++) {
      const from = sorted[index];
      const to = sorted[index + 1];
      edges.push({
        edge_id: `ASGEDGE_${makeId(assetId)}_${index + 1}`,
        from_node_id: from.node_id,
        to_node_id: to.node_id,
        type: from.node_type === "silence" ? "silence_after" : "precedes",
      });
    }
  }
  return edges;
}

function deriveGraphCoverage(
  coverageReport: BuildAudioStoryGraphOptions["coverageReport"],
  nodes: AudioStoryGraphNode[],
  bgmAnalysisRejected = false,
): AudioStoryGraph["coverage"] {
  const laneStatus = (laneId: string): GraphStatus => {
    const status = coverageReport.lanes?.find((lane) => lane.lane_id === laneId)?.status;
    return toGraphStatus(status);
  };
  const laneNeutral = (laneId: string): boolean => {
    const lane = coverageReport.lanes?.find((item) => item.lane_id === laneId);
    return !bgmAnalysisRejected && lane?.status === "skipped" && [
      "no_explicit_bgm_role_input",
      "not_applicable_silent_audio",
      "not_applicable_no_audio_stream",
      "stt skipped by request",
      "stt not attempted on cached run",
      "bgm analysis skipped by request",
    ].includes(lane.reason ?? "");
  };
  const dialogueLane = laneStatus("stt");
  const audioEventLane = laneStatus("audio_events");
  const musicLane = bgmAnalysisRejected ? "failed" : laneStatus("bgm_analysis");
  const statuses = [
    ...(laneNeutral("stt") ? [] : [dialogueLane]),
    ...(laneNeutral("audio_events") ? [] : [audioEventLane]),
    ...(laneNeutral("bgm_analysis") ? [] : [musicLane]),
  ];
  const status: GraphStatus = statuses.includes("failed")
    ? "partial"
    : statuses.includes("partial") || statuses.includes("skipped")
      ? "partial"
      : nodes.length === 0
        ? "skipped"
        : "ready";
  const missingInputs = [
    ...(!laneNeutral("stt") && (dialogueLane === "failed" || dialogueLane === "skipped") ? ["transcript"] : []),
    ...(!laneNeutral("audio_events") && (audioEventLane === "failed" || audioEventLane === "skipped") ? ["audio_events"] : []),
    ...(!laneNeutral("bgm_analysis") && (musicLane === "failed" || musicLane === "skipped") ? ["bgm_analysis"] : []),
  ];

  return {
    status,
    dialogue_lane: dialogueLane,
    audio_event_lane: audioEventLane,
    music_lane: musicLane,
    missing_inputs: missingInputs,
  };
}

function getManifestHash(manifest: BuildAudioStoryGraphOptions["manifest"]): string {
  const supplied = (manifest as { source_media_manifest_hash?: string }).source_media_manifest_hash;
  if (supplied) return supplied;
  return computeNormalizedJsonHash(manifest, (manifest as SourceMediaManifest).provenance?.hash_policy?.excluded_fields ?? []);
}

function getCoverageHash(report: BuildAudioStoryGraphOptions["coverageReport"]): string {
  const supplied = (report as { hash?: string }).hash;
  if (supplied) return supplied;
  const excludedFields = (report as AnalysisCoverageReport).provenance?.hash_policy?.excluded_fields;
  return computeNormalizedJsonHash(report, Array.isArray(excludedFields) ? excludedFields : []);
}

function toGraphStatus(status?: string): GraphStatus {
  if (status === "ready" || status === "partial" || status === "skipped" || status === "failed") return status;
  if (status === "waived") return "skipped";
  return "skipped";
}

function mapAudioEventType(type?: string): AudioNodeType | null {
  switch (type) {
    case "silence":
    case "laughter":
    case "applause":
    case "impact":
    case "ambient_shift":
      return type;
    case "music_onset":
    case "music_end":
      return "music_section";
    default:
      return null;
  }
}

function inferStoryRole(index: number): StoryRole {
  if (index === 0) return "setup";
  if (index === 1) return "experience";
  return "payoff";
}

function inferMusicStoryRole(label?: string): StoryRole {
  const normalized = (label ?? "").toLowerCase();
  if (normalized.includes("intro")) return "hook";
  if (normalized.includes("outro") || normalized.includes("ending")) return "closing";
  return "experience";
}

function collectAssetOrder(nodes: AudioStoryGraphNode[]): string[] {
  return Array.from(new Set(nodes.map((node) => node.asset_id))).sort();
}

function makeId(value: string): string {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "node";
}
