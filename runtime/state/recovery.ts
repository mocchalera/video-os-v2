/**
 * Recovery for interrupted editorial runs.
 *
 * A run killed by SIGINT/SIGTERM/provider crash cannot close its own
 * progress.json or advance project_state.yaml. This module closes the stale
 * running report as aborted and lets artifact-driven state reconciliation
 * restore the correct state — without re-running any analysis or triage.
 */

import { closeStaleRunningProgress } from "../progress.js";
import {
  reconcile,
  writeProjectState,
  type ProjectState,
} from "./reconcile.js";

export interface InterruptedRunRecoveryResult {
  /** True when a stale running progress.json was closed as aborted. */
  progress_closed: boolean;
  /** State implied purely by validated canonical artifacts. */
  reconciled_state: ProjectState;
  /** State persisted back to project_state.yaml. */
  persisted_state: ProjectState;
  /** True when reconciliation changed the persisted current_state. */
  self_healed: boolean;
  previous_state?: ProjectState;
}

/**
 * Recover an interrupted project:
 * 1. Close progress.json if it is still "running" for a dead process.
 * 2. Reconcile project_state.yaml from validated canonical artifacts
 *    (e.g. validated selects + blueprint ⇒ blueprint_ready, no re-triage).
 *
 * Safe to call on healthy projects: live runs (same or other alive pids) are
 * never touched and reconciliation is idempotent.
 */
export function recoverInterruptedProject(
  projectDir: string,
  actor = "state-reconciler",
): InterruptedRunRecoveryResult {
  const progressClosed = closeStaleRunningProgress(projectDir);
  const result = reconcile(projectDir, actor, "recover-interrupted-project");
  const previousState = result.doc.current_state;
  result.doc.last_agent = actor;
  result.doc.last_command = "recover-interrupted-project";
  writeProjectState(projectDir, result.doc);
  return {
    progress_closed: progressClosed,
    reconciled_state: result.reconciled_state,
    persisted_state: result.doc.current_state,
    self_healed: previousState !== result.reconciled_state,
    ...(previousState !== result.reconciled_state ? { previous_state: previousState } : {}),
  };
}
