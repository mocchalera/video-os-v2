/**
 * /triage Command
 *
 * Wraps footage-triager agent to produce:
 * - 04_plan/selects_candidates.yaml
 *
 * Prerequisites:
 * - analysis_gate == ready (or partial_override with analysis_override)
 * - creative_brief.yaml exists
 *
 * Evidence access via media-mcp tools:
 * - project_summary, list_assets, search_segments, peek_segment
 *
 * Human confirmation: candidate board approval
 *
 * LLM agent is injectable for testability.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  initCommand,
  isCommandError,
  draftAndPromote,
  transitionState,
  type CommandError,
  type DraftFile,
} from "./shared.js";
import { ProgressTracker } from "../progress.js";
import type { ProjectState, GateStatus } from "../state/reconcile.js";
import { generateCandidateId } from "../compiler/candidate-ref.js";
import { inferAutonomyMode } from "../autonomy.js";
import { loadCreativeBrief } from "../artifacts/loaders.js";
import type { CreativeBrief, SelectsCandidates as ArtifactSelectsCandidates } from "../artifacts/types.js";
import {
  audioStoryNodesForWindow,
  computeAudioStoryGraphHash,
  isP2AudioStoryGraphEnabled,
  readAudioStoryGraph,
} from "../artifacts/p2-audio-story-graph.js";
import {
  computeContinuityGraphHash,
  continuityRisksForWindow,
  isP3ContinuityPreferenceEnabled,
  readContinuityGraph,
  type ContinuityGraph,
  type ContinuityGraphRisk,
} from "../artifacts/p3-continuity-graph.js";
import {
  hasSearchInfluence,
  isP4dSearchIndexEnabled,
  loadSearchIndexManifest,
  materializeSearchHash,
} from "../artifacts/p4d-segment-search-index.js";
import {
  enrichSelectsFromAnalysis,
  type SegmentItem as EnrichmentSegmentItem,
} from "../agents/triage-enrichment.js";
import {
  analyzeSelectionCoverage,
  type SelectionCoverageReport,
  type SelectionCoverageSegment,
} from "../eval/selection-coverage.js";

// ── Types ────────────────────────────────────────────────────────

export interface TrimHint {
  source_center_us?: number;
  preferred_duration_us?: number;
  min_duration_us?: number;
  max_duration_us?: number;
  window_start_us?: number;
  window_end_us?: number;
  interest_point_label?: string;
  interest_point_confidence?: number;
  peak_ref?: string;
  peak_type?: "action_peak" | "emotional_peak" | "visual_peak";
  center_source?: "refine_filmstrip" | "precision_dense_frames" | "precision_proxy_clip" | "interest_point_fallback" | "midpoint_fallback";
  rationale?: string;
  recommended_in_us?: number;
  recommended_out_us?: number;
}

export interface EditorialSignals {
  silence_ratio?: number;
  afterglow_score?: number;
  speech_intensity_score?: number;
  reaction_intensity_score?: number;
  authenticity_score?: number;
  surprise_signal?: number;
  hope_signal?: number;
  face_detected?: boolean;
  visual_tags?: string[];
  semantic_cluster_id?: string;
  peak_ref?: string;
  peak_strength_score?: number;
  peak_type?: "action_peak" | "emotional_peak" | "visual_peak";
  peak_source_pass?: string;
}

export interface EditorialSummary {
  dominant_visual_mode?: "talking_head" | "screen_demo" | "event_broll" | "mixed" | "unknown";
  speaker_topology?: "solo_primary" | "interviewer_guest" | "multi_speaker" | "unknown";
  motion_profile?: "low" | "medium" | "high" | "unknown";
  transcript_density?: "sparse" | "medium" | "dense" | "unknown";
}

export interface SelectCandidate {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  role: "hero" | "support" | "transition" | "texture" | "dialogue" | "reject";
  why_it_matches: string;
  risks: string[];
  confidence: number;
  audio_story_refs?: AudioStoryRef[];
  continuity_refs?: ContinuityRef[];
  semantic_rank?: number;
  quality_flags?: string[];
  evidence?: string[];
  eligible_beats?: string[];
  transcript_excerpt?: string;
  motif_tags?: string[];
  rejection_reason?: string;
  // M4.5 additive fields
  candidate_id?: string;
  utterance_ids?: string[];
  speaker_role?: "primary" | "interviewer" | "secondary" | "unknown";
  semantic_dedupe_key?: string;
  editorial_signals?: EditorialSignals;
  trim_hint?: TrimHint;
}

export interface AudioStoryRef {
  node_id: string;
  role?: "hook" | "setup" | "experience" | "payoff" | "reaction" | "closing";
  confidence?: {
    score: number;
    source: string;
    status: string;
    label?: string;
  };
  graph_hash?: string;
}

export interface ContinuityRef {
  entity_id: string;
  risk_id?: string;
  severity?: "info" | "warning" | "blocker";
  graph_hash?: string;
}

export interface SelectsCandidates {
  version: string;
  project_id: string;
  created_at?: string;
  analysis_artifact_version?: string;
  selection_notes?: string[];
  candidates: SelectCandidate[];
  editorial_summary?: EditorialSummary;
  provenance?: {
    search_index_manifest_hash?: string;
    [key: string]: unknown;
  };
}

/** The agent function signature — injectable for testing */
export interface TriageAgent {
  run(ctx: TriageAgentContext): Promise<TriageAgentResult>;
}

export interface TriageCoverageFeedback {
  round: number;
  gaps: string[];
  previous_selection_count: number;
}

export interface TriageAgentContext {
  projectDir: string;
  projectId: string;
  currentState: ProjectState;
  analysisGate: GateStatus["analysis_gate"];
  coverageFeedback?: TriageCoverageFeedback;
}

export interface TriageAgentResult {
  selects: SelectsCandidates;
  /** If false, human declined the candidate board */
  confirmed: boolean;
}

export interface TriageCommandResult {
  success: boolean;
  error?: CommandError;
  selects?: SelectsCandidates;
  previousState?: ProjectState;
  newState?: ProjectState;
  promoted?: string[];
}

export interface CoverageForcedSelectionResult {
  result: TriageAgentResult;
  coverage?: SelectionCoverageReport;
  rounds: number;
  passed: boolean;
  skipped: boolean;
}

// ── Command Implementation ───────────────────────────────────────

export const COVERAGE_MAX_ROUNDS = 2;

/**
 * Allowed start states: media_analyzed or later.
 * Design doc says "media_analyzed 以降" — but we also need to handle
 * the case where the project is already at selects_ready or beyond
 * (rerun scenario). The state machine allows this because triage is
 * re-runnable when analysis is ready.
 */
const ALLOWED_STATES: ProjectState[] = [
  "media_analyzed",
  "selects_ready",
  "blueprint_ready",
  "blocked",
  "timeline_drafted",
  "critique_ready",
  "approved",
  "packaged",
];

type CoverageLogger = (message: string) => void;

export function coveragePasses(coverage: SelectionCoverageReport): boolean {
  return !coverage.density.sparse && !coverage.cluster_coverage.some((cluster) => cluster.under_sampled);
}

export async function runCoverageForcedSelection(
  agent: TriageAgent,
  ctx: TriageAgentContext,
  brief?: CreativeBrief,
  segmentEvidence?: SelectionCoverageSegment[],
  maxRounds = COVERAGE_MAX_ROUNDS,
  log?: CoverageLogger,
): Promise<CoverageForcedSelectionResult> {
  const baseCtx: TriageAgentContext = {
    projectDir: ctx.projectDir,
    projectId: ctx.projectId,
    currentState: ctx.currentState,
    analysisGate: ctx.analysisGate,
  };
  const boundedMaxRounds = Math.max(0, Math.floor(maxRounds));

  if (!brief || !segmentEvidence) {
    log?.("[triage:coverage] coverage skipped: missing brief or segments");
    const result = await agent.run(baseCtx);
    log?.("[triage:coverage] coverage rounds=1, passed=false, final_score=n/a");
    return { result, rounds: 1, passed: false, skipped: true };
  }

  let feedback: TriageCoverageFeedback | undefined;
  let previousActiveSegmentIds: Set<string> | undefined;
  let result: TriageAgentResult | undefined;
  let finalCoverage: SelectionCoverageReport | undefined;
  let passed = false;
  let rounds = 0;

  for (let round = 0; ; round += 1) {
    const runCtx = feedback ? { ...baseCtx, coverageFeedback: feedback } : baseCtx;
    const priorResult = result;
    const priorCoverage = finalCoverage;
    try {
      result = await agent.run(runCtx);
    } catch (err) {
      // Round 0 has no prior selection to fall back to — propagate the failure.
      if (round === 0 || !priorResult) throw err;
      // A feedback round failed (e.g. the LLM returned malformed output): keep
      // the best selection so far rather than crashing the whole pipeline.
      const message = err instanceof Error ? err.message : String(err);
      log?.(
        `[triage:coverage] round=${round} re-selection failed (${message}); keeping previous round's selection`,
      );
      result = priorResult;
      finalCoverage = priorCoverage;
      passed = priorCoverage ? coveragePasses(priorCoverage) : false;
      break;
    }
    rounds = round + 1;

    if (!hasAnalyzableSelects(result.selects)) {
      log?.(`[triage:coverage] coverage skipped: unanalyzable selects at round=${round}`);
      log?.(`[triage:coverage] coverage rounds=${rounds}, passed=false, final_score=n/a`);
      return { result, rounds, passed: false, skipped: true };
    }

    const activeSegmentIds = activeSegmentIdSet(result.selects);
    finalCoverage = analyzeSelectionCoverage(
      result.selects as unknown as ArtifactSelectsCandidates,
      brief,
      segmentEvidence,
    );
    passed = coveragePasses(finalCoverage);
    log?.(
      `[triage:coverage] round=${round} score=${formatCoverageScore(finalCoverage.score)} ` +
        `gaps=${finalCoverage.gaps.length} passed=${passed}`,
    );

    if (passed) break;

    if (previousActiveSegmentIds && sameStringSets(activeSegmentIds, previousActiveSegmentIds)) {
      log?.(`[triage:coverage] no improvement at round=${round}; active_segment_ids unchanged`);
      break;
    }

    if (round >= boundedMaxRounds) break;

    previousActiveSegmentIds = activeSegmentIds;
    feedback = {
      round: round + 1,
      gaps: finalCoverage.gaps,
      previous_selection_count: finalCoverage.density.selected_count,
    };
  }

  log?.(
    `[triage:coverage] coverage rounds=${rounds}, passed=${passed}, ` +
      `final_score=${finalCoverage ? formatCoverageScore(finalCoverage.score) : "n/a"}`,
  );

  return {
    result: result!,
    coverage: finalCoverage,
    rounds,
    passed,
    skipped: false,
  };
}

export async function runTriage(
  projectDir: string,
  agent: TriageAgent,
  options?: { analysisOverride?: boolean },
): Promise<TriageCommandResult> {
  const pt = new ProgressTracker(projectDir, "triage", 4);
  // 1. Init command (reconcile + state check)
  const ctx = initCommand(projectDir, "/triage", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    // Special case: if state check failed because we're at intent_locked,
    // we might need to check analysis gate more carefully
    pt.fail("init", ctx.message);
    return { success: false, error: ctx };
  }
  pt.advance();

  const { projectDir: absDir, reconcileResult, doc, preflightHashes } = ctx;
  const previousState = doc.current_state;
  const projectId = doc.project_id || "";
  const gates = reconcileResult.gates;

  // 2. Analysis gate check
  if (gates.analysis_gate === "blocked") {
    const overrideHint = options?.analysisOverride
      ? "analysis_override must be active and match the current analysis artifact_version."
      : "Run analysis first or activate a matching analysis_override for partial QC.";
    pt.block("gate", `Analysis gate is blocked. ${overrideHint}`);
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: `Analysis gate is blocked. ${overrideHint}`,
        details: {
          analysis_gate: gates.analysis_gate,
          analysis_override_status: doc.analysis_override?.status ?? "none",
          analysis_artifact_version: preflightHashes.analysis_artifact_version ?? null,
        },
      },
    };
  }

  // partial state with no override is blocked by default
  // (partial_override means override is already active)

  // 3. Verify creative_brief.yaml exists
  const briefPath = path.join(absDir, "01_intent/creative_brief.yaml");
  if (!fs.existsSync(briefPath)) {
    pt.block("brief", "creative_brief.yaml not found. Run /intent first.");
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: "creative_brief.yaml not found. Run /intent first.",
      },
    };
  }
  const briefRaw = fs.readFileSync(briefPath, "utf-8");
  const briefContent = parseYaml(briefRaw) as {
    autonomy?: { mode?: "full" | "collaborative"; must_ask?: string[] };
  };
  const autonomyMode = inferAutonomyMode(briefContent);
  const coverageBrief = loadCoverageBrief(briefPath);
  const segmentEvidence = loadCoverageSegments(absDir);

  // 4. Run agent (LLM or mock)
  const selectionResult = await runCoverageForcedSelection(
    agent,
    {
      projectDir: absDir,
      projectId,
      currentState: previousState,
      analysisGate: gates.analysis_gate,
    },
    coverageBrief,
    segmentEvidence,
    COVERAGE_MAX_ROUNDS,
    (message) => console.log(message),
  );
  const agentResult = selectionResult.result;
  pt.advance();

  // 5. Gate 4: candidate board approval
  if (autonomyMode === "full") {
    console.log("[auto:full_autonomy] /triage auto-approved candidate board.");
  } else if (!agentResult.confirmed) {
    pt.fail("approval", "Human declined candidate board approval");
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Human declined candidate board approval",
      },
    };
  }

  // 5.5 Materialize deterministic analysis signals, then canonicalize.
  const enrichmentSegments = loadAnalysisSegments(absDir);
  if (enrichmentSegments && hasCandidateArray(agentResult.selects)) {
    agentResult.selects = enrichSelectsFromAnalysis(
      agentResult.selects as unknown as ArtifactSelectsCandidates,
      enrichmentSegments,
    ) as unknown as SelectsCandidates;
  }
  canonicalizeSelects(agentResult.selects, projectId);
  if (isP2AudioStoryGraphEnabled()) {
    materializeAudioStoryGraphRefs(absDir, agentResult.selects);
  }
  if (isP3ContinuityPreferenceEnabled()) {
    materializeContinuityRiskRefs(absDir, agentResult.selects);
  }
  if (isP4dSearchIndexEnabled() && hasSearchInfluence(agentResult.selects)) {
    const searchIndex = loadSearchIndexManifest(absDir);
    if (searchIndex.manifest) {
      materializeSearchHash(agentResult.selects as unknown as Record<string, unknown>, searchIndex.manifest.hash);
    }
  }

  // 6. Draft selects_candidates.yaml
  const drafts: DraftFile[] = [
    {
      relativePath: "04_plan/selects_candidates.yaml",
      schemaFile: "selects-candidates.schema.json",
      content: agentResult.selects,
      format: "yaml",
    },
  ];

  // 7. Validate + promote
  const promoteResult = draftAndPromote(absDir, drafts, {
    preflightHashes,
    guardKeys: ["brief_hash", "analysis_artifact_version", "selects_hash"],
  });
  if (!promoteResult.success) {
    const code = promoteResult.failure_kind === "validation"
      ? "VALIDATION_FAILED"
      : "PROMOTE_FAILED";
    const message = promoteResult.failure_kind === "concurrent_edit"
      ? `Artifact promote aborted due to concurrent edits: ${promoteResult.errors.join("; ")}`
      : promoteResult.failure_kind === "promote"
        ? `Artifact promote failed: ${promoteResult.errors.join("; ")}`
        : `Artifact validation failed: ${promoteResult.errors.join("; ")}`;
    pt.fail("promote", message);
    return {
      success: false,
      error: {
        code,
        message,
        details: promoteResult.errors,
      },
    };
  }
  pt.advance("04_plan/selects_candidates.yaml");

  // 8. State transition: → selects_ready
  const updatedDoc = transitionState(
    absDir,
    doc,
    "selects_ready",
    "/triage",
    "footage-triager",
    "selects candidates finalized",
  );
  pt.complete(["04_plan/selects_candidates.yaml"]);

  return {
    success: true,
    selects: agentResult.selects,
    previousState,
    newState: updatedDoc.current_state,
    promoted: promoteResult.promoted,
  };
}

function loadCoverageBrief(briefPath: string): CreativeBrief | undefined {
  try {
    return loadCreativeBrief(briefPath);
  } catch {
    return undefined;
  }
}

function loadCoverageSegments(projectDir: string): SelectionCoverageSegment[] | undefined {
  const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
  if (!fs.existsSync(segmentsPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return undefined;
    return parsed.items.flatMap((item): SelectionCoverageSegment[] => {
      if (!item || typeof item !== "object") return [];
      const segment = item as { segment_id?: unknown; summary?: unknown };
      if (typeof segment.segment_id !== "string" || segment.segment_id.length === 0) return [];
      return [
        {
          segment_id: segment.segment_id,
          ...(typeof segment.summary === "string" ? { summary: segment.summary } : {}),
        },
      ];
    });
  } catch {
    return undefined;
  }
}

function loadAnalysisSegments(projectDir: string): EnrichmentSegmentItem[] | undefined {
  const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
  if (!fs.existsSync(segmentsPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return undefined;
    return parsed.items.filter(isEnrichmentSegmentItem);
  } catch {
    return undefined;
  }
}

function isEnrichmentSegmentItem(item: unknown): item is EnrichmentSegmentItem {
  if (!item || typeof item !== "object") return false;
  const segment = item as {
    segment_id?: unknown;
    asset_id?: unknown;
    src_in_us?: unknown;
    src_out_us?: unknown;
    summary?: unknown;
    transcript_excerpt?: unknown;
    quality_flags?: unknown;
    tags?: unknown;
  };
  return (
    typeof segment.segment_id === "string" &&
    typeof segment.asset_id === "string" &&
    typeof segment.src_in_us === "number" &&
    typeof segment.src_out_us === "number" &&
    typeof segment.summary === "string" &&
    typeof segment.transcript_excerpt === "string" &&
    Array.isArray(segment.quality_flags) &&
    Array.isArray(segment.tags)
  );
}

function hasCandidateArray(selects: unknown): selects is { candidates: unknown[] } {
  return !!selects && typeof selects === "object" && Array.isArray((selects as { candidates?: unknown }).candidates);
}

function hasAnalyzableSelects(selects: unknown): selects is SelectsCandidates {
  if (!selects || typeof selects !== "object") return false;
  const candidates = (selects as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return false;
  return candidates.every((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const c = candidate as {
      segment_id?: unknown;
      role?: unknown;
      src_in_us?: unknown;
      src_out_us?: unknown;
    };
    return (
      typeof c.segment_id === "string" &&
      typeof c.role === "string" &&
      typeof c.src_in_us === "number" &&
      typeof c.src_out_us === "number"
    );
  });
}

function activeSegmentIdSet(selects: SelectsCandidates): Set<string> {
  const ids = new Set<string>();
  for (const candidate of selects.candidates) {
    if (candidate.role === "reject") continue;
    ids.add(candidate.segment_id);
  }
  return ids;
}

function sameStringSets(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function formatCoverageScore(score: number): string {
  return Number.isFinite(score) ? (score * 100).toFixed(1) : "n/a";
}

// ── M4.5 Canonicalization ──────────────────────────────────────────

/**
 * Assign deterministic candidate_id and normalize trim_hint
 * for all candidates. Mutates the selects in place.
 */
function canonicalizeSelects(
  selects: SelectsCandidates,
  projectId: string,
): void {
  if (!selects?.candidates || !Array.isArray(selects.candidates)) return;
  for (const c of selects.candidates) {
    // Assign candidate_id if missing
    if (!c.candidate_id) {
      c.candidate_id = generateCandidateId(projectId, c);
    }

    // Normalize trim_hint: ensure window bounds are within authored range
    if (c.trim_hint) {
      const th = c.trim_hint;
      // Clamp window to authored safety range
      if (th.window_start_us !== undefined) {
        th.window_start_us = Math.max(th.window_start_us, c.src_in_us);
      }
      if (th.window_end_us !== undefined) {
        th.window_end_us = Math.min(th.window_end_us, c.src_out_us);
      }
      // Clamp center to authored range
      if (th.source_center_us !== undefined) {
        th.source_center_us = Math.max(c.src_in_us, Math.min(th.source_center_us, c.src_out_us));
      }
      // Ensure min <= preferred <= max
      if (th.min_duration_us && th.max_duration_us && th.min_duration_us > th.max_duration_us) {
        const tmp = th.min_duration_us;
        th.min_duration_us = th.max_duration_us;
        th.max_duration_us = tmp;
      }
      if (th.preferred_duration_us) {
        if (th.min_duration_us) {
          th.preferred_duration_us = Math.max(th.preferred_duration_us, th.min_duration_us);
        }
        if (th.max_duration_us) {
          th.preferred_duration_us = Math.min(th.preferred_duration_us, th.max_duration_us);
        }
      }
    }
  }
}

export function materializeAudioStoryGraphRefs(
  projectDir: string,
  selects: SelectsCandidates,
): void {
  const graph = readAudioStoryGraph(projectDir);
  if (!graph) return;
  const graphHash = computeAudioStoryGraphHash(graph);
  let changed = false;
  for (const candidate of selects.candidates) {
    const nodes = audioStoryNodesForWindow(graph, candidate.asset_id, candidate.src_in_us, candidate.src_out_us);
    if (nodes.length === 0) continue;
    candidate.audio_story_refs = uniqueAudioStoryRefs([
      ...(candidate.audio_story_refs ?? []),
      ...nodes.map((node) => ({
        node_id: node.node_id,
        ...(node.story_role ? { role: node.story_role } : {}),
        confidence: node.confidence,
        graph_hash: graphHash,
      })),
    ]);
    changed = true;
    const salience = nodes.some((node) => ["hook", "setup", "payoff", "reaction"].includes(node.story_role ?? ""));
    if (salience) {
      candidate.confidence = Math.min(1, Number((candidate.confidence + 0.02).toFixed(4)));
    }
  }
  if (changed) ensurePlanningMinorVersion(selects);
}

export function materializeContinuityRiskRefs(
  projectDir: string,
  selects: SelectsCandidates,
): void {
  const graph = readContinuityGraph(projectDir);
  if (!graph) return;
  const graphHash = computeContinuityGraphHash(graph);
  let changed = false;
  for (const candidate of selects.candidates) {
    const risks = continuityRisksForWindow(graph, candidate.asset_id, candidate.src_in_us, candidate.src_out_us);
    if (risks.length === 0) continue;
    candidate.continuity_refs = uniqueContinuityRefs([
      ...(candidate.continuity_refs ?? []),
      ...continuityRefsForRisks(graph, risks, graphHash),
    ]);
    changed = true;
  }
  if (changed) ensurePlanningMinorVersion(selects);
}

function ensurePlanningMinorVersion(artifact: { version?: string }): void {
  if (!artifact.version) return;
  const match = artifact.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 1 && minor < 1) {
    artifact.version = "1.1.0";
  }
}

function uniqueAudioStoryRefs(refs: AudioStoryRef[]): AudioStoryRef[] {
  const seen = new Set<string>();
  const out: AudioStoryRef[] = [];
  for (const ref of refs) {
    const key = `${ref.node_id}:${ref.graph_hash ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function uniqueContinuityRefs(refs: ContinuityRef[]): ContinuityRef[] {
  const seen = new Set<string>();
  const out: ContinuityRef[] = [];
  for (const ref of refs) {
    const key = `${ref.entity_id}:${ref.risk_id ?? ""}:${ref.graph_hash ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function continuityRefsForRisks(
  graph: ContinuityGraph,
  risks: ContinuityGraphRisk[],
  graphHash: string,
): ContinuityRef[] {
  const segmentToEntities = new Map(graph.segments.map((segment) => [segment.segment_id, segment.entity_ids]));
  const refs: ContinuityRef[] = [];
  for (const risk of risks) {
    const entityIds = new Set<string>();
    for (const ref of risk.refs) {
      if (/^ENT_(SUBJECT|LOCATION|PROP|MOTIF|ACTION)_/.test(ref)) {
        entityIds.add(ref);
        continue;
      }
      for (const entityId of segmentToEntities.get(ref) ?? []) {
        entityIds.add(entityId);
      }
    }
    for (const entityId of entityIds) {
      refs.push({
        entity_id: entityId,
        risk_id: risk.risk_id,
        severity: risk.severity,
        graph_hash: graphHash,
      });
    }
  }
  return refs;
}
