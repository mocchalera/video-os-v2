/**
 * /status Command
 *
 * Reconciles project_state.yaml and returns current status:
 * - Current state
 * - Gate statuses
 * - Stale artifact detection
 * - Next command recommendation
 *
 * State is never changed by /status (read-only).
 */

import {
  initCommand,
  isCommandError,
  type CommandError,
} from "./shared.js";
import type { ProjectState, GateStatus, ReconcileResult } from "../state/reconcile.js";

// ── Types ────────────────────────────────────────────────────────

export interface StatusResult {
  success: boolean;
  error?: CommandError;
  currentState?: ProjectState;
  gates?: GateStatus;
  staleArtifacts?: string[];
  selfHealed?: boolean;
  previousState?: ProjectState;
  nextCommand?: string;
  nextCommandReason?: string;
}

// ── Next Command Recommendation ──────────────────────────────────

function recommendNextCommand(
  state: ProjectState,
  gates: GateStatus,
  staleArtifacts: string[],
): { command: string; reason: string } {
  // If downstream artifacts are stale, recommend re-running the relevant command
  if (staleArtifacts.includes("selects") || staleArtifacts.includes("blueprint")) {
    if (staleArtifacts.includes("selects")) {
      return { command: "/triage", reason: "selects are stale due to upstream changes" };
    }
    return { command: "/blueprint", reason: "blueprint is stale due to upstream changes" };
  }

  switch (state) {
    case "intent_pending":
      return { command: "/intent", reason: "project needs creative brief" };
    case "intent_locked":
      if (gates.analysis_gate === "ready" || gates.analysis_gate === "partial_override") {
        return { command: "/triage", reason: "analysis ready — select footage candidates" };
      }
      return { command: "run analysis", reason: "analysis gate is blocked — run media analysis first" };
    case "media_analyzed":
      return { command: "/triage", reason: "media analyzed — select footage candidates" };
    case "selects_ready":
      return { command: "/blueprint", reason: "selects ready — create edit blueprint" };
    case "blueprint_ready":
      return { command: "/review", reason: "blueprint ready — compile timeline and review" };
    case "blocked":
      if (gates.compile_gate === "blocked") {
        return { command: "resolve blockers", reason: "compile gate blocked — resolve unresolved_blockers" };
      }
      if (gates.planning_gate === "blocked") {
        return { command: "resolve uncertainties", reason: "planning gate blocked — resolve uncertainty_register" };
      }
      return { command: "resolve blockers", reason: "project is blocked" };
    case "timeline_drafted":
      return { command: "/review", reason: "timeline drafted — run review" };
    case "critique_ready":
      return { command: "/export or apply patch", reason: "review complete — export or apply patch and re-review" };
    case "approved":
      return { command: "/export", reason: "project approved — export deliverables" };
    case "packaged":
      return { command: "done", reason: "project is packaged" };
    default:
      return { command: "/status", reason: "unknown state" };
  }
}

// ── Command Implementation ───────────────────────────────────────

export function runStatus(projectDir: string): StatusResult {
  // /status is allowed from any state
  const ctx = initCommand(projectDir, "/status", []);
  if (isCommandError(ctx)) {
    return { success: false, error: ctx };
  }

  const { reconcileResult, doc } = ctx;
  const { command, reason } = recommendNextCommand(
    reconcileResult.reconciled_state,
    reconcileResult.gates,
    reconcileResult.stale_artifacts,
  );

  return {
    success: true,
    currentState: reconcileResult.reconciled_state,
    gates: reconcileResult.gates,
    staleArtifacts: reconcileResult.stale_artifacts,
    selfHealed: reconcileResult.self_healed,
    previousState: reconcileResult.persisted_state,
    nextCommand: command,
    nextCommandReason: reason,
  };
}
