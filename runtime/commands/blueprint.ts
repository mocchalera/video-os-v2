/**
 * /blueprint Command
 *
 * Wraps blueprint-planner agent to produce:
 * - 04_plan/edit_blueprint.yaml
 * - 04_plan/uncertainty_register.yaml
 *
 * Planning flow (design doc):
 * 1. brief / selects / STYLE synthesis
 * 2. sequence goals + beat candidates generation
 * 3. preference interview (autonomy branching)
 * 4. beat proposal readback
 * 5. uncertainty extraction
 * 6. schema validate and promote
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
import type { ProjectState, GateStatus } from "../state/reconcile.js";

// ── Types ────────────────────────────────────────────────────────

export interface ConfirmedPreferences {
  mode: "full" | "collaborative";
  source: "human_confirmed" | "ai_autonomous";
  duration_target_sec: number;
  confirmed_at: string;
  structure_choice?: string;
  pacing_notes?: string;
}

export interface Beat {
  id: string;
  label: string;
  purpose?: string;
  target_duration_frames: number;
  required_roles: Array<"hero" | "support" | "transition" | "texture" | "dialogue">;
  preferred_roles?: Array<"hero" | "support" | "transition" | "texture" | "dialogue">;
  notes?: string;
}

export interface EditBlueprint {
  version?: string;
  project_id?: string;
  created_at?: string;
  sequence_goals: string[];
  beats: Beat[];
  pacing: {
    opening_cadence: string;
    middle_cadence: string;
    ending_cadence: string;
    max_shot_length_frames?: number;
    confirmed_preferences?: ConfirmedPreferences;
  };
  music_policy: {
    start_sparse: boolean;
    allow_release_late: boolean;
    entry_beat: string;
    avoid_anthemic_lift?: boolean;
    permitted_energy_curve?: string;
  };
  caption_policy?: {
    language: string;
    delivery_mode: "burn_in" | "sidecar" | "both";
    source: "transcript" | "authored" | "none";
    styling_class: string;
  };
  dialogue_policy: {
    preserve_natural_breath: boolean;
    avoid_wall_to_wall_voiceover: boolean;
    prioritize_lines?: string[];
  };
  transition_policy: {
    prefer_match_texture_over_flashy_fx: boolean;
    allow_hard_cuts?: boolean;
    avoid_speed_ramps?: boolean;
  };
  ending_policy: {
    should_feel: string;
    final_line_strategy?: string;
    avoid_cta?: boolean;
    final_hold_min_frames?: number;
  };
  rejection_rules: string[];
}

export interface Uncertainty {
  id: string;
  type: "message" | "structure" | "coverage" | "pacing" | "audio" | "music" | "ending" | "brand" | "continuity" | "technical" | "legal" | "other";
  question: string;
  status: "open" | "monitoring" | "resolved" | "waived" | "blocker";
  evidence: string[];
  alternatives: Array<{ label: string; description: string; impact?: string }>;
  escalation_required: boolean;
  resolution_note?: string;
}

export interface UncertaintyRegister {
  version: string;
  project_id: string;
  created_at?: string;
  uncertainties: Uncertainty[];
}

/** The agent function signature — injectable for testing */
export interface BlueprintAgent {
  run(ctx: BlueprintAgentContext): Promise<BlueprintAgentResult>;
}

export interface BlueprintAgentContext {
  projectDir: string;
  projectId: string;
  currentState: ProjectState;
  autonomyMode: "full" | "collaborative";
  briefContent: unknown;
  blockersContent: unknown;
  selectsContent: unknown;
  styleContent: string | null;
}

export interface BlueprintAgentResult {
  blueprint: EditBlueprint;
  uncertaintyRegister: UncertaintyRegister;
  /** If false, human declined the beat proposal readback */
  confirmed: boolean;
}

export interface BlueprintCommandResult {
  success: boolean;
  error?: CommandError;
  blueprint?: EditBlueprint;
  uncertaintyRegister?: UncertaintyRegister;
  previousState?: ProjectState;
  newState?: ProjectState;
  promoted?: string[];
  planningBlocked?: boolean;
}

// ── Command Implementation ───────────────────────────────────────

/**
 * Allowed start state: selects_ready.
 * Also re-runnable from blueprint_ready and beyond.
 */
const ALLOWED_STATES: ProjectState[] = [
  "selects_ready",
  "blueprint_ready",
  "blocked",
  "timeline_drafted",
  "critique_ready",
];

function inferAutonomyMode(
  briefContent: {
    autonomy?: { mode?: "full" | "collaborative"; must_ask?: string[] };
  },
): "full" | "collaborative" {
  if (briefContent.autonomy?.mode) {
    return briefContent.autonomy.mode;
  }
  return (briefContent.autonomy?.must_ask?.length ?? 0) === 0 ? "full" : "collaborative";
}

function validateConfirmedPreferences(
  blueprint: EditBlueprint,
  autonomyMode: "full" | "collaborative",
): string[] {
  const prefs = blueprint.pacing?.confirmed_preferences;
  if (!prefs) {
    return ["pacing.confirmed_preferences is required"];
  }

  const expectedSource = autonomyMode === "full" ? "ai_autonomous" : "human_confirmed";
  const errors: string[] = [];
  if (prefs.mode !== autonomyMode) {
    errors.push(`pacing.confirmed_preferences.mode must be "${autonomyMode}"`);
  }
  if (prefs.source !== expectedSource) {
    errors.push(`pacing.confirmed_preferences.source must be "${expectedSource}"`);
  }
  if (typeof prefs.duration_target_sec !== "number" || prefs.duration_target_sec <= 0) {
    errors.push("pacing.confirmed_preferences.duration_target_sec must be > 0");
  }
  if (typeof prefs.confirmed_at !== "string" || prefs.confirmed_at.length === 0) {
    errors.push("pacing.confirmed_preferences.confirmed_at is required");
  }
  return errors;
}

export async function runBlueprint(
  projectDir: string,
  agent: BlueprintAgent,
): Promise<BlueprintCommandResult> {
  // 1. Init command (reconcile + state check)
  const ctx = initCommand(projectDir, "/blueprint", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    return { success: false, error: ctx };
  }

  const { projectDir: absDir, reconcileResult, doc, preflightHashes } = ctx;
  const previousState = doc.current_state;
  const projectId = doc.project_id || "";

  // 2. Read creative_brief.yaml to determine autonomy mode
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
  const briefRaw = fs.readFileSync(briefPath, "utf-8");
  const briefContent = parseYaml(briefRaw) as {
    autonomy?: { mode?: "full" | "collaborative"; must_ask?: string[] };
    project?: { runtime_target_sec?: number };
  };

  const autonomyMode = inferAutonomyMode(briefContent);

  const blockersPath = path.join(absDir, "01_intent/unresolved_blockers.yaml");
  if (!fs.existsSync(blockersPath)) {
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: "unresolved_blockers.yaml not found. Run /intent first.",
      },
    };
  }
  const blockersRaw = fs.readFileSync(blockersPath, "utf-8");
  const blockersContent = parseYaml(blockersRaw);

  // 3. Read selects_candidates.yaml
  const selectsPath = path.join(absDir, "04_plan/selects_candidates.yaml");
  if (!fs.existsSync(selectsPath)) {
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: "selects_candidates.yaml not found. Run /triage first.",
      },
    };
  }
  const selectsRaw = fs.readFileSync(selectsPath, "utf-8");
  const selectsContent = parseYaml(selectsRaw);

  // 4. Read optional STYLE.md
  const stylePath = path.join(absDir, "STYLE.md");
  const styleContent = fs.existsSync(stylePath)
    ? fs.readFileSync(stylePath, "utf-8")
    : null;

  // 5. Run agent (LLM or mock)
  const agentResult = await agent.run({
    projectDir: absDir,
    projectId,
    currentState: previousState,
    autonomyMode,
    briefContent,
    blockersContent,
    selectsContent,
    styleContent,
  });

  // 6. If human declined beat proposal readback, abort
  if (!agentResult.confirmed) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Human declined beat proposal readback",
      },
    };
  }

  const confirmedPreferenceErrors = validateConfirmedPreferences(
    agentResult.blueprint,
    autonomyMode,
  );
  if (confirmedPreferenceErrors.length > 0) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `Blueprint preference contract failed: ${confirmedPreferenceErrors.join("; ")}`,
        details: confirmedPreferenceErrors,
      },
    };
  }

  // 7. Draft both artifacts
  const drafts: DraftFile[] = [
    {
      relativePath: "04_plan/edit_blueprint.yaml",
      schemaFile: "edit-blueprint.schema.json",
      content: agentResult.blueprint,
      format: "yaml",
    },
    {
      relativePath: "04_plan/uncertainty_register.yaml",
      schemaFile: "uncertainty-register.schema.json",
      content: agentResult.uncertaintyRegister,
      format: "yaml",
    },
  ];

  // 8. Validate + promote (both must be valid)
  const promoteResult = draftAndPromote(absDir, drafts, {
    preflightHashes,
    guardKeys: [
      "brief_hash",
      "blockers_hash",
      "selects_hash",
      "style_hash",
      "blueprint_hash",
      "uncertainty_hash",
    ],
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

  // 9. Planning blocker check: if uncertainty_register has status:blocker → blocked
  const hasPlanningBlocker = agentResult.uncertaintyRegister.uncertainties.some(
    (u) => u.status === "blocker",
  );
  const hasCompileBlocker = reconcileResult.gates.compile_gate === "blocked";

  const targetState: ProjectState = hasPlanningBlocker || hasCompileBlocker
    ? "blocked"
    : "blueprint_ready";
  const note = hasPlanningBlocker || hasCompileBlocker
    ? "blueprint finalized with unresolved blockers"
    : "blueprint and uncertainty register finalized";

  // 10. State transition
  const updatedDoc = transitionState(
    absDir,
    doc,
    targetState,
    "/blueprint",
    "blueprint-planner",
    note,
  );

  return {
    success: true,
    blueprint: agentResult.blueprint,
    uncertaintyRegister: agentResult.uncertaintyRegister,
    previousState,
    newState: updatedDoc.current_state,
    promoted: promoteResult.promoted,
    planningBlocked: hasPlanningBlocker || hasCompileBlocker,
  };
}
