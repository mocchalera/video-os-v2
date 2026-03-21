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
import {
  initCommand,
  isCommandError,
  draftAndPromote,
  transitionState,
  type CommandError,
  type DraftFile,
} from "./shared.js";
import type { ProjectState, GateStatus } from "../state/reconcile.js";
import { generateCandidateId } from "../compiler/candidate-ref.js";

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

export interface SelectsCandidates {
  version: string;
  project_id: string;
  created_at?: string;
  analysis_artifact_version?: string;
  selection_notes?: string[];
  candidates: SelectCandidate[];
  editorial_summary?: EditorialSummary;
}

/** The agent function signature — injectable for testing */
export interface TriageAgent {
  run(ctx: TriageAgentContext): Promise<TriageAgentResult>;
}

export interface TriageAgentContext {
  projectDir: string;
  projectId: string;
  currentState: ProjectState;
  analysisGate: GateStatus["analysis_gate"];
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

// ── Command Implementation ───────────────────────────────────────

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
  "timeline_drafted",
  "critique_ready",
];

export async function runTriage(
  projectDir: string,
  agent: TriageAgent,
  options?: { analysisOverride?: boolean },
): Promise<TriageCommandResult> {
  // 1. Init command (reconcile + state check)
  const ctx = initCommand(projectDir, "/triage", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    // Special case: if state check failed because we're at intent_locked,
    // we might need to check analysis gate more carefully
    return { success: false, error: ctx };
  }

  const { projectDir: absDir, reconcileResult, doc, preflightHashes } = ctx;
  const previousState = doc.current_state;
  const projectId = doc.project_id || "";
  const gates = reconcileResult.gates;

  // 2. Analysis gate check
  if (gates.analysis_gate === "blocked") {
    const overrideHint = options?.analysisOverride
      ? "analysis_override must be active and match the current analysis artifact_version."
      : "Run analysis first or activate a matching analysis_override for partial QC.";
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
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: "creative_brief.yaml not found. Run /intent first.",
      },
    };
  }

  // 4. Run agent (LLM or mock)
  const agentResult = await agent.run({
    projectDir: absDir,
    projectId,
    currentState: previousState,
    analysisGate: gates.analysis_gate,
  });

  // 5. If human declined candidate board, abort
  if (!agentResult.confirmed) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Human declined candidate board approval",
      },
    };
  }

  // 5.5 Canonicalize: assign candidate_id and normalize trim_hints
  canonicalizeSelects(agentResult.selects, projectId);

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
    return {
      success: false,
      error: {
        code,
        message,
        details: promoteResult.errors,
      },
    };
  }

  // 8. State transition: → selects_ready
  const updatedDoc = transitionState(
    absDir,
    doc,
    "selects_ready",
    "/triage",
    "footage-triager",
    "selects candidates finalized",
  );

  return {
    success: true,
    selects: agentResult.selects,
    previousState,
    newState: updatedDoc.current_state,
    promoted: promoteResult.promoted,
  };
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
