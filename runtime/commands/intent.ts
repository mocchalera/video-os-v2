/**
 * /intent Command
 *
 * Wraps intent-interviewer agent to produce:
 * - 01_intent/creative_brief.yaml
 * - 01_intent/unresolved_blockers.yaml
 *
 * Dialogue flow (design doc):
 * 1. purpose capture
 * 2. constraint capture
 * 3. autonomy capture
 * 4. blocker extraction
 * 5. structured readback → human confirmation
 *
 * LLM agent is injectable for testability.
 */

import {
  initCommand,
  isCommandError,
  draftAndPromote,
  transitionState,
  type CommandError,
  type DraftFile,
} from "./shared.js";
import type { ProjectState } from "../state/reconcile.js";

// ── Types ────────────────────────────────────────────────────────

export interface CreativeBrief {
  version?: string;
  project_id?: string;
  created_at?: string;
  project: {
    id?: string;
    title: string;
    strategy: string;
    client?: string;
    format?: string;
    runtime_target_sec?: number;
  };
  message: {
    primary: string;
    secondary?: string[];
  };
  audience: {
    primary: string;
    secondary?: string[];
    excluded?: string[];
  };
  emotion_curve: string[];
  must_have: string[];
  must_avoid: string[];
  autonomy: {
    mode?: "full" | "collaborative";
    may_decide: string[];
    must_ask: string[];
  };
  resolved_assumptions: string[];
  hypotheses?: string[];
  forbidden_interpretations?: string[];
}

export interface Blocker {
  id: string;
  question: string;
  status: "blocker" | "hypothesis" | "resolved" | "waived";
  why_it_matters: string;
  allowed_temporary_assumption: string | null;
}

export interface UnresolvedBlockers {
  version?: string;
  project_id?: string;
  created_at?: string;
  blockers: Blocker[];
}

/** The agent function signature — injectable for testing */
export interface IntentAgent {
  /**
   * Runs the intent interview and returns both artifacts.
   * In production, this calls an LLM. In tests, returns deterministic data.
   */
  run(ctx: IntentAgentContext): Promise<IntentAgentResult>;
}

export interface IntentAgentContext {
  projectDir: string;
  projectId: string;
  currentState: ProjectState;
}

export interface IntentAgentResult {
  brief: CreativeBrief;
  blockers: UnresolvedBlockers;
  /** If false, human declined the readback */
  confirmed: boolean;
}

export interface IntentCommandResult {
  success: boolean;
  error?: CommandError;
  brief?: CreativeBrief;
  blockers?: UnresolvedBlockers;
  previousState?: ProjectState;
  newState?: ProjectState;
  promoted?: string[];
}

// ── Command Implementation ───────────────────────────────────────

/**
 * /intent is re-runnable from any state (design: "rerun 可能").
 * When brief hash changes, downstream artifacts become stale via reconcile.
 */
const ALLOWED_STATES: ProjectState[] = []; // any state allowed

function inferAutonomyMode(brief: CreativeBrief): "full" | "collaborative" {
  if (brief.autonomy?.mode) {
    return brief.autonomy.mode;
  }
  return (brief.autonomy?.must_ask?.length ?? 1) === 0 ? "full" : "collaborative";
}

function normalizeBrief(brief: CreativeBrief): CreativeBrief {
  return {
    ...brief,
    autonomy: {
      ...(brief.autonomy ?? { may_decide: [], must_ask: [] }),
      mode: inferAutonomyMode(brief),
    },
  };
}

export async function runIntent(
  projectDir: string,
  agent: IntentAgent,
): Promise<IntentCommandResult> {
  // 1. Init command (reconcile + state check)
  const ctx = initCommand(projectDir, "/intent", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    return { success: false, error: ctx };
  }

  const { projectDir: absDir, doc, preflightHashes } = ctx;
  const previousState = doc.current_state;
  const projectId = doc.project_id || "";

  // 2. Run agent (LLM or mock)
  const agentResult = await agent.run({
    projectDir: absDir,
    projectId,
    currentState: previousState,
  });

  // 3. If human declined readback, abort
  if (!agentResult.confirmed) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Human declined brief readback confirmation",
      },
    };
  }

  const normalizedBrief = normalizeBrief(agentResult.brief);

  // 4. Draft both artifacts
  const drafts: DraftFile[] = [
    {
      relativePath: "01_intent/creative_brief.yaml",
      schemaFile: "creative-brief.schema.json",
      content: normalizedBrief,
      format: "yaml",
    },
    {
      relativePath: "01_intent/unresolved_blockers.yaml",
      schemaFile: "unresolved-blockers.schema.json",
      content: agentResult.blockers,
      format: "yaml",
    },
  ];

  // 5. Validate + promote (both must be valid per finalization rule)
  const promoteResult = draftAndPromote(absDir, drafts, {
    preflightHashes,
    guardKeys: ["brief_hash", "blockers_hash"],
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

  // 6. State transition: → intent_locked
  const updatedDoc = transitionState(
    absDir,
    doc,
    "intent_locked",
    "/intent",
    "intent-interviewer",
    "brief and blockers finalized",
  );

  return {
    success: true,
    brief: normalizedBrief,
    blockers: agentResult.blockers,
    previousState,
    newState: updatedDoc.current_state,
    promoted: promoteResult.promoted,
  };
}
