import * as path from "node:path";
import { validateArtifact } from "../artifacts/loaders.js";
import { atomicWriteJson } from "../pipeline/stages/_util.js";
import { buildBgmCatalog } from "./catalog.js";
import { normalizeBgmSelectionIntent } from "./selection-intent.js";
import {
  BgmSelectionInputError,
  loadProjectSelectionSources,
  prepareCatalogSelectionEvidence,
  type BgmOutputScope,
  type PreparedCatalogCandidate,
} from "./selection-project-input.js";
import {
  selectBgmDeterministically,
  type BgmScoreBreakdown,
  type BgmSelectorAnalysis,
  type BgmSelectorCandidateResult,
} from "./selector.js";
import type { PackRegistryOptions } from "./pack-registry.js";

export type { BgmOutputScope } from "./selection-project-input.js";

export interface BgmSelectionArtifactCandidate {
  track_id: string;
  content_hash: string;
  rank: number | null;
  status: "ranked" | "rejected";
  total_score: number | null;
  score_breakdown: BgmScoreBreakdown;
  rejection_reasons: string[];
  explanation: string;
}

export interface BgmSelectedTrackPin {
  pack_id: string;
  pack_version: string;
  pack_manifest_hash: string;
  track_id: string;
  full_mix_content_hash: string;
  full_mix_size_bytes: number;
  full_mix_path: string;
  analysis_content_hash: string;
  analysis_size_bytes: number;
  analysis_path: string;
  analysis_status: "ready" | "degraded" | "failed" | "unavailable";
  registry_status: "verified";
}

export interface BgmSelectionArtifact {
  version: "1.0.0";
  project_id: string;
  created_at: string;
  mode: "suggest" | "auto" | "operator_locked";
  scoring_strategy: {
    strategy_id: "bgm-score-v1";
    base_total_points: 100;
    auto_minimum_score: number;
    auto_minimum_margin: number;
  };
  redistribution_trace: {
    applied: boolean;
    source_component: "semantic_fit";
    source_weight: 30;
    reason: string | null;
    allocations: Array<{ component: string; added_points: number }>;
  };
  input_hashes: {
    creative_brief: string;
    edit_blueprint: string;
    timeline: string;
    catalog: string;
    analyses: Array<{ track_id: string; analysis_hash: string }>;
  };
  requirements: {
    families: string[];
    intensities: Array<"low" | "high">;
    use_cases: string[];
    minimum_speech_friendliness: number;
    vocal_presence_allowed: Array<"none" | "texture" | "lead" | "unknown">;
    duration_us: number;
  };
  hard_constraints: Array<{ constraint_id: string; kind: "metadata" | "rights" | "availability" | "technical"; value: unknown }>;
  candidates: BgmSelectionArtifactCandidate[];
  selected: {
    track_id: string;
    content_hash: string;
    rank: number;
    score: number;
    confidence: number;
    explanation: string;
  } | null;
  /** Additive Phase 2 pin. Legacy v1 selections remain valid without it. */
  selected_track_pin?: BgmSelectedTrackPin;
  top_two_margin: number | null;
  operator_override: {
    selected_track_id: string;
    reason: string;
    operator_ref: string;
    overridden_at: string;
  } | null;
  semantic_channel: {
    status: "available" | "degraded" | "unavailable";
    model_revision: string | null;
    warnings: string[];
  };
  usage_history_penalties: Array<{ track_id: string; usage_count_90d: number; penalty: number }>;
  warnings: string[];
}

export interface BgmSelectionIssue {
  code: "BGM_PACK_NOT_FOUND" | "BGM_SELECTION_INPUT_MISSING" | "BGM_SELECTION_INPUT_INVALID" | "BGM_SELECTION_INCONCLUSIVE";
  message: string;
  recoverable: boolean;
  affected_ref: string;
  suggested_action: string;
  severity: "error" | "warning";
}

export class BgmSelectionServiceError extends Error {
  constructor(public readonly issue: BgmSelectionIssue) {
    super(issue.message);
    this.name = "BgmSelectionServiceError";
  }
}

export interface SelectBgmForProjectOptions {
  projectPath: string;
  /** Optional immutable timeline input used by scratch/planning commands. */
  timelinePath?: string;
  requestedMode: "suggest" | "auto";
  outputScope: BgmOutputScope;
  packRoot?: string;
  writeArtifact?: boolean;
  createdAt?: string;
}

export interface ProjectBgmSelectionResult {
  ok: boolean;
  requested_mode: "suggest" | "auto";
  artifact: BgmSelectionArtifact;
  wrote_artifact: boolean;
  output_ref: "04_plan/bgm_selection.json" | null;
  issues: BgmSelectionIssue[];
}

function issue(
  code: BgmSelectionIssue["code"],
  message: string,
  affectedRef: string,
  suggestedAction: string,
): BgmSelectionIssue {
  return { code, message, recoverable: true, affected_ref: affectedRef, suggested_action: suggestedAction, severity: "error" };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function analyzedAxis(analysis: Record<string, unknown>, name: string): number | null {
  const semantics = record(analysis.semantics);
  const axes = record(semantics?.editorial_axes);
  return finite(record(axes?.[name])?.value) ?? null;
}

function meanConfidence(value: unknown): number | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const values = value.map((item) => finite(record(item)?.confidence)).filter((item): item is number => item !== undefined);
  return values.length > 0 ? values.reduce((sum, item) => sum + item, 0) / values.length : null;
}

function selectorAnalysis(candidate: PreparedCatalogCandidate): BgmSelectorAnalysis | undefined {
  const analysis = candidate.analysis;
  if (!analysis) return { status: "unavailable" };
  const status = analysis.status === "ready" || analysis.status === "degraded" || analysis.status === "failed"
    ? analysis.status
    : "unavailable";
  const audio = record(analysis.audio);
  const tempo = record(analysis.tempo);
  const structure = record(analysis.structure);
  const spectrum = record(analysis.spectrum);
  return {
    status,
    ...(typeof analysis.input_content_hash === "string" ? { input_content_hash: analysis.input_content_hash } : {}),
    duration_us: finite(audio?.duration_us),
    bpm: finite(tempo?.bpm) ?? null,
    beat_confidence: meanConfidence(structure?.beats),
    downbeat_confidence: meanConfidence(structure?.downbeats),
    speech_band_masking_score: finite(spectrum?.speech_band_masking_score) ?? null,
    speech_friendliness: analyzedAxis(analysis, "speech_friendliness"),
    energy: analyzedAxis(analysis, "energy"),
    ending_resolution: analyzedAxis(analysis, "ending_resolution"),
  };
}

function artifactCandidate(candidate: BgmSelectorCandidateResult): BgmSelectionArtifactCandidate {
  return {
    track_id: candidate.track_id,
    content_hash: candidate.content_hash,
    rank: candidate.rank,
    status: candidate.status,
    total_score: candidate.total_score,
    score_breakdown: candidate.score_breakdown,
    rejection_reasons: candidate.rejection_reasons,
    explanation: candidate.explanation,
  };
}

function selectionConfidence(score: number, margin: number | null, minimumMargin: number): number {
  const scoreConfidence = Math.min(1, Math.max(0, score / 100));
  const marginConfidence = margin === null ? 1 : Math.min(1, Math.max(0, margin / Math.max(1, minimumMargin * 2)));
  return Math.round((scoreConfidence * 0.75 + marginConfidence * 0.25) * 10_000) / 10_000;
}

function stableWarnings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.length > 0))].sort();
}

function registryOptions(projectPath: string, packRoot?: string): PackRegistryOptions {
  if (packRoot) {
    return { searchRoots: [{ source: "environment", priority: 1, path: packRoot }] };
  }
  return { projectPackDir: path.join(path.resolve(projectPath), "02_media", "bgm-packs") };
}

/**
 * Produce the explainable planning artifact only. Cue placement and A2 mutation
 * remain separate, explicit later-phase operations.
 */
export async function selectBgmForProject(options: SelectBgmForProjectOptions): Promise<ProjectBgmSelectionResult> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const now = new Date(createdAt);
  if (Number.isNaN(now.getTime())) {
    throw new BgmSelectionServiceError(issue(
      "BGM_SELECTION_INPUT_INVALID",
      "The selection timestamp is invalid.",
      "created_at",
      "Provide an ISO-8601 timestamp.",
    ));
  }
  const catalog = buildBgmCatalog(registryOptions(options.projectPath, options.packRoot));
  if (catalog.tracks.length === 0) {
    throw new BgmSelectionServiceError(issue(
      "BGM_PACK_NOT_FOUND",
      "No verified BGM track is available for selection.",
      "bgm-pack",
      "Install or configure a verified BGM pack, then retry selection.",
    ));
  }

  let sources;
  try {
    sources = loadProjectSelectionSources(options.projectPath, catalog, options.timelinePath);
  } catch (error) {
    if (error instanceof BgmSelectionInputError) {
      throw new BgmSelectionServiceError(issue(
        error.code,
        error.message,
        error.affected_ref,
        "Create or repair the canonical project artifact before selecting BGM.",
      ));
    }
    throw error;
  }
  const outputMode = options.outputScope === "commercial" ? "external" : options.outputScope;
  const normalized = normalizeBgmSelectionIntent({
    creativeBrief: sources.creative_brief,
    editBlueprint: sources.edit_blueprint,
    timeline: sources.timeline_summary,
    outputMode,
    commercial: options.outputScope === "commercial",
  });
  const evidence = prepareCatalogSelectionEvidence(catalog, {
    requiredScopes: normalized.intent.required_rights_scopes,
    requireLicensed: normalized.intent.require_licensed_rights,
    now,
  });
  const selector = selectBgmDeterministically({
    requirements: {
      families: normalized.intent.families,
      intensities: normalized.intent.intensities,
      use_cases: normalized.intent.use_cases,
      minimum_speech_friendliness: normalized.intent.minimum_speech_friendliness,
      vocal_presence_allowed: normalized.intent.vocal_presence_allowed,
      duration_us: normalized.intent.duration_us,
      target_energy: normalized.intent.target_energy,
      target_bpm: normalized.intent.target_bpm,
      speech_ratio: normalized.intent.speech_ratio,
      required_rights_scopes: normalized.intent.required_rights_scopes,
      require_licensed_rights: normalized.intent.require_licensed_rights,
      require_verified_hash: normalized.intent.require_verified_hash,
      explicit_exclusions: normalized.intent.explicit_exclusions,
    },
    candidates: evidence.candidates.map((candidate) => ({
      track: candidate.track,
      expected_content_hash: candidate.track.track.full_mix.content_hash,
      integrity_ok: candidate.integrity_ok,
      installed: candidate.installed,
      readable: candidate.readable,
      codec_supported: candidate.codec_supported,
      rights_allowed: candidate.rights_allowed,
      licensed_rights: candidate.rights.status === "licensed",
      rights_hash_verified: candidate.rights.integrity_verified && candidate.rights.content_hash_matches,
      permitted_rights_scopes: candidate.rights.permitted_scopes,
      analysis: selectorAnalysis(candidate),
      usage_count_90d: candidate.usage_count_90d,
      usage_penalty: candidate.usage_penalty,
    })),
    semantic_channel: {
      status: "unavailable",
      model_revision: null,
      warnings: ["brief-to-track CLAP comparison unavailable; metadata scoring used"],
    },
    selection_mode: options.requestedMode,
    suggestion_limit: 3,
  });

  const effectiveMode = selector.decision.mode;
  const chosen = effectiveMode === "auto" ? selector.decision.selected : null;
  const warnings = stableWarnings([
    ...normalized.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
    ...catalog.warnings.map((warning) => `${warning.code}: ${warning.message}`),
    ...evidence.warnings,
    ...selector.warnings,
    ...(options.requestedMode === "auto" && effectiveMode === "suggest" ? [`BGM_SELECTION_INCONCLUSIVE: ${selector.decision.reason}`] : []),
  ]);
  const artifact: BgmSelectionArtifact = {
    version: "1.0.0",
    project_id: sources.project_id,
    created_at: now.toISOString(),
    mode: effectiveMode,
    scoring_strategy: {
      strategy_id: selector.strategy_id,
      base_total_points: 100,
      auto_minimum_score: selector.decision.minimum_score,
      auto_minimum_margin: selector.decision.minimum_margin,
    },
    redistribution_trace: selector.redistribution_trace,
    input_hashes: {
      ...sources.input_hashes,
      analyses: evidence.analysis_hashes,
    },
    requirements: {
      families: normalized.intent.families,
      intensities: normalized.intent.intensities,
      use_cases: normalized.intent.use_cases,
      minimum_speech_friendliness: normalized.intent.minimum_speech_friendliness,
      vocal_presence_allowed: normalized.intent.vocal_presence_allowed,
      duration_us: normalized.intent.duration_us,
    },
    hard_constraints: [
      { constraint_id: "installed-pack", kind: "availability", value: true },
      { constraint_id: "verified-content-hash", kind: "technical", value: normalized.intent.require_verified_hash },
      { constraint_id: "vocal-policy", kind: "metadata", value: normalized.intent.vocal_presence_allowed },
      { constraint_id: "rights-scopes", kind: "rights", value: normalized.intent.required_rights_scopes },
      { constraint_id: "licensed-rights", kind: "rights", value: normalized.intent.require_licensed_rights },
    ],
    candidates: selector.candidates.map(artifactCandidate),
    selected: chosen && chosen.rank !== null && chosen.total_score !== null ? {
      track_id: chosen.track_id,
      content_hash: chosen.content_hash,
      rank: chosen.rank,
      score: chosen.total_score,
      confidence: selectionConfidence(chosen.total_score, selector.top_two_margin, selector.decision.minimum_margin),
      explanation: chosen.explanation,
    } : null,
    top_two_margin: selector.top_two_margin,
    operator_override: null,
    semantic_channel: {
      status: selector.semantic_channel.status,
      model_revision: selector.semantic_channel.model_revision ?? null,
      warnings: stableWarnings(selector.semantic_channel.warnings ?? []),
    },
    usage_history_penalties: evidence.candidates.map((candidate) => ({
      track_id: candidate.track.track.track_id,
      usage_count_90d: candidate.usage_count_90d,
      penalty: candidate.usage_penalty,
    })),
    warnings,
  };
  validateArtifact<BgmSelectionArtifact>(artifact, "bgm-selection.schema.json");

  const inconclusive = selector.ranked.length === 0 || (options.requestedMode === "auto" && effectiveMode !== "auto");
  const issues = inconclusive ? [issue(
    "BGM_SELECTION_INCONCLUSIVE",
    selector.decision.reason,
    "04_plan/bgm_selection.json",
    "Review the top candidates or refine the BGM intent before applying music.",
  )] : [];
  const shouldWrite = options.writeArtifact !== false && normalized.intent.bgm_enabled;
  if (shouldWrite) {
    atomicWriteJson(path.join(path.resolve(options.projectPath), "04_plan", "bgm_selection.json"), artifact);
  }
  return {
    ok: !inconclusive,
    requested_mode: options.requestedMode,
    artifact,
    wrote_artifact: shouldWrite,
    output_ref: shouldWrite ? "04_plan/bgm_selection.json" : null,
    issues,
  };
}
