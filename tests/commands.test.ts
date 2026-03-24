import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createRequire } from "node:module";

import {
  resolveProjectRoot,
  initCommand,
  isCommandError,
  validateAgainstSchema,
  draftAndPromote,
  transitionState,
  type DraftFile,
} from "../runtime/commands/shared.js";
import {
  writeProjectState,
  readProjectState,
  snapshotArtifacts,
  type ProjectStateDoc,
} from "../runtime/state/reconcile.js";
import { runIntent, type IntentAgent, type IntentAgentResult } from "../runtime/commands/intent.js";
import { runTriage, type TriageAgent, type TriageAgentResult } from "../runtime/commands/triage.js";
import { runStatus } from "../runtime/commands/status.js";
import {
  runReview,
  validatePatchSafety,
  type ReviewAgent,
  type ReviewAgentResult,
  type ReviewReport,
  type ReviewPatch,
  type HumanNotes,
} from "../runtime/commands/review.js";
import {
  runBlueprint,
  type BlueprintAgent,
  type BlueprintAgentResult,
  type EditBlueprint,
  type UncertaintyRegister,
} from "../runtime/commands/blueprint.js";

// ── AJV setup for schema validation in tests ─────────────────────

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

function createValidator(schemaFile: string) {
  const schemaPath = path.resolve("schemas", schemaFile);
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

// ── Temp dir management ──────────────────────────────────────────

const SAMPLE_PROJECT = "projects/sample";
const tempDirs: string[] = [];

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function createTempProject(name: string, patches?: Record<string, unknown>): string {
  const tmpDir = path.resolve(`test-fixtures-cmd-${name}-${Date.now()}`);
  copyDirSync(path.resolve(SAMPLE_PROJECT), tmpDir);

  if (patches) {
    for (const [relPath, content] of Object.entries(patches)) {
      const absPath = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      if (typeof content === "string") {
        fs.writeFileSync(absPath, content, "utf-8");
      } else {
        const ext = path.extname(relPath);
        if (ext === ".json") {
          fs.writeFileSync(absPath, JSON.stringify(content, null, 2), "utf-8");
        } else {
          fs.writeFileSync(absPath, stringifyYaml(content), "utf-8");
        }
      }
    }
  }

  tempDirs.push(tmpDir);
  return tmpDir;
}

/** Create a minimal project with only 01_intent and optional analysis */
function createMinimalProject(
  name: string,
  opts?: {
    withBrief?: boolean;
    withAnalysis?: boolean;
    withSelects?: boolean;
    withStyle?: boolean;
    autonomyMode?: "full" | "collaborative";
    state?: string;
    analysisOverride?: object;
  },
): string {
  const tmpDir = path.resolve(`test-fixtures-cmd-${name}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "01_intent"), { recursive: true });

  if (opts?.withBrief) {
    const brief = makeMockBrief("test-project", opts?.autonomyMode);
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/creative_brief.yaml"),
      stringifyYaml(brief),
      "utf-8",
    );
    const blockers = makeMockBlockers("test-project");
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/unresolved_blockers.yaml"),
      stringifyYaml(blockers),
      "utf-8",
    );
  }

  if (opts?.withAnalysis) {
    copyDirSync(
      path.resolve(SAMPLE_PROJECT, "03_analysis"),
      path.join(tmpDir, "03_analysis"),
    );
  }

  if (opts?.withSelects) {
    fs.mkdirSync(path.join(tmpDir, "04_plan"), { recursive: true });
    const selects = makeMockSelects("test-project");
    fs.writeFileSync(
      path.join(tmpDir, "04_plan/selects_candidates.yaml"),
      stringifyYaml(selects),
      "utf-8",
    );
  }

  if (opts?.withStyle) {
    fs.writeFileSync(
      path.join(tmpDir, "STYLE.md"),
      "# Style\n\n## Pacing\nbrisk 2-3 second cuts\n\n## Color Tone\nwarm earth tones\n",
      "utf-8",
    );
  }

  const stateDoc: ProjectStateDoc = {
    version: 1,
    project_id: "test-project",
    current_state: (opts?.state ?? "intent_pending") as ProjectStateDoc["current_state"],
    history: [],
  };
  if (opts?.analysisOverride) {
    stateDoc.analysis_override = opts.analysisOverride as ProjectStateDoc["analysis_override"];
  }
  writeProjectState(tmpDir, stateDoc);

  tempDirs.push(tmpDir);
  return tmpDir;
}

afterAll(() => {
  for (const d of tempDirs) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── Mock Data Factories ──────────────────────────────────────────

function makeMockBrief(projectId: string, autonomyMode?: "full" | "collaborative") {
  return {
    project: {
      title: "Test Project",
      strategy: "Documentary short about mountain rescue team",
      runtime_target_sec: 120,
    },
    message: {
      primary: "Courage is choosing to act when fear says stop",
    },
    audience: {
      primary: "Outdoor enthusiasts aged 25-45",
    },
    emotion_curve: ["curiosity", "tension", "awe"],
    must_have: ["summit rescue sequence"],
    must_avoid: ["graphic injury footage"],
    autonomy: {
      mode: (autonomyMode ?? "full") as "full" | "collaborative",
      may_decide: ["pacing", "music cue points"],
      must_ask: ["final title card text"],
    },
    resolved_assumptions: ["All footage is 4K or higher"],
  };
}

function makeMockBlockers(projectId: string) {
  return {
    version: "1",
    project_id: projectId,
    blockers: [
      {
        id: "BLK_001",
        question: "Should we include helicopter footage?",
        status: "hypothesis" as const,
        why_it_matters: "Sets the scale of the operation",
        allowed_temporary_assumption: "Include if available",
      },
    ],
  };
}

function makeMockSelects(projectId: string) {
  return {
    version: "1",
    project_id: projectId,
    candidates: [
      {
        segment_id: "SEG_0001",
        asset_id: "ASSET_001",
        src_in_us: 0,
        src_out_us: 5000000,
        role: "hero" as const,
        why_it_matches: "Summit approach — matches primary message about courage",
        risks: ["wind noise may require treatment"],
        confidence: 0.9,
        evidence: ["visual motif: mountain summit", "segment QC: pass"],
        quality_flags: ["4k", "stabilized"],
      },
      {
        segment_id: "SEG_0002",
        asset_id: "ASSET_001",
        src_in_us: 5000000,
        src_out_us: 8000000,
        role: "support" as const,
        why_it_matches: "Team preparation scene — builds tension",
        risks: [],
        confidence: 0.85,
      },
    ],
  };
}

function makeMockBlueprint(
  projectId: string,
  opts?: { autonomyMode?: "full" | "collaborative"; durationSec?: number },
): EditBlueprint {
  const mode = opts?.autonomyMode ?? "full";
  const durationSec = opts?.durationSec ?? 120;
  return {
    sequence_goals: ["Convey courage through mountain rescue narrative"],
    beats: [
      {
        id: "B01",
        label: "Opening — approach",
        purpose: "Establish setting and stakes",
        target_duration_frames: 720,
        required_roles: ["hero"],
      },
      {
        id: "B02",
        label: "Rising action — rescue",
        purpose: "Build tension",
        target_duration_frames: 1440,
        required_roles: ["hero", "support"],
      },
      {
        id: "B03",
        label: "Resolution — summit",
        purpose: "Emotional payoff",
        target_duration_frames: 720,
        required_roles: ["hero", "texture"],
      },
    ],
    pacing: {
      opening_cadence: "slow observational, hold shots 4+ seconds",
      middle_cadence: "accelerating, 2-3 second cuts",
      ending_cadence: "breath, final hold 3+ seconds",
      confirmed_preferences: {
        mode,
        source: mode === "full" ? "ai_autonomous" : "human_confirmed",
        duration_target_sec: durationSec,
        confirmed_at: new Date().toISOString(),
        ...(mode === "collaborative"
          ? { structure_choice: "three-act", pacing_notes: "operator prefers brisk middle" }
          : {}),
      },
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "B02",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
    },
    ending_policy: {
      should_feel: "earned stillness",
    },
    rejection_rules: ["No footage below 1080p", "No uncleared music"],
  };
}

function makeMockUncertaintyRegister(
  projectId: string,
  opts?: { withBlocker?: boolean },
): UncertaintyRegister {
  const uncertainties: UncertaintyRegister["uncertainties"] = [
    {
      id: "UNC_001",
      type: "coverage",
      question: "Do we have enough summit footage for B03?",
      status: "open",
      evidence: ["only 2 candidate segments for summit"],
      alternatives: [
        { label: "Use B-roll", description: "Fill with texture shots of mountain" },
      ],
      escalation_required: false,
    },
  ];

  if (opts?.withBlocker) {
    uncertainties.push({
      id: "UNC_002",
      type: "legal",
      question: "Music rights for rescue sequence unclear",
      status: "blocker",
      evidence: ["no license confirmation from rights holder"],
      alternatives: [
        { label: "Use library music", description: "Swap to licensed library track" },
        { label: "Wait for clearance", description: "Pause until rights confirmed" },
      ],
      escalation_required: true,
    });
  }

  return {
    version: "1",
    project_id: projectId,
    uncertainties,
  };
}

// ── Mock Agents ──────────────────────────────────────────────────

function createMockBlueprintAgent(
  overrides?: Partial<BlueprintAgentResult>,
  opts?: { autonomyMode?: "full" | "collaborative"; withBlocker?: boolean },
): BlueprintAgent {
  return {
    async run(ctx) {
      const mode = opts?.autonomyMode ?? ctx.autonomyMode;
      return {
        blueprint: makeMockBlueprint(ctx.projectId, { autonomyMode: mode }),
        uncertaintyRegister: makeMockUncertaintyRegister(ctx.projectId, {
          withBlocker: opts?.withBlocker,
        }),
        confirmed: true,
        ...overrides,
      };
    },
  };
}

function createMockIntentAgent(overrides?: Partial<IntentAgentResult>): IntentAgent {
  return {
    async run(ctx) {
      return {
        brief: makeMockBrief(ctx.projectId),
        blockers: makeMockBlockers(ctx.projectId),
        confirmed: true,
        ...overrides,
      };
    },
  };
}

function createMockTriageAgent(overrides?: Partial<TriageAgentResult>): TriageAgent {
  return {
    async run(ctx) {
      return {
        selects: makeMockSelects(ctx.projectId),
        confirmed: true,
        ...overrides,
      };
    },
  };
}

// ══════════════════════════════════════════════════════════════════
// 1. shared.ts — Command Infrastructure
// ══════════════════════════════════════════════════════════════════

describe("command shared infrastructure", () => {
  describe("resolveProjectRoot", () => {
    it("resolves absolute path", () => {
      const result = resolveProjectRoot(path.resolve(SAMPLE_PROJECT));
      expect(result).toBe(path.resolve(SAMPLE_PROJECT));
    });

    it("resolves relative path", () => {
      const result = resolveProjectRoot(SAMPLE_PROJECT);
      expect(result).toBe(path.resolve(SAMPLE_PROJECT));
    });

    it("throws on non-existent path", () => {
      expect(() => resolveProjectRoot("/nonexistent/path")).toThrow();
    });
  });

  describe("initCommand", () => {
    it("succeeds when state is in allowed list", () => {
      const tmpDir = createMinimalProject("init-ok", {
        withBrief: true,
        withAnalysis: true,
        state: "intent_locked", // reconcile will self-heal to media_analyzed
      });
      const ctx = initCommand(tmpDir, "/triage", ["media_analyzed"]);
      expect(isCommandError(ctx)).toBe(false);
      if (!isCommandError(ctx)) {
        expect(ctx.doc.current_state).toBe("media_analyzed");
      }
    });

    it("succeeds when allowed list is empty (any state)", () => {
      const tmpDir = createMinimalProject("init-any", { state: "intent_pending" });
      const ctx = initCommand(tmpDir, "/status", []);
      expect(isCommandError(ctx)).toBe(false);
    });

    it("returns error when state is not in allowed list", () => {
      const tmpDir = createMinimalProject("init-bad", { state: "intent_pending" });
      const ctx = initCommand(tmpDir, "/triage", ["media_analyzed"]);
      expect(isCommandError(ctx)).toBe(true);
      if (isCommandError(ctx)) {
        expect(ctx.code).toBe("STATE_CHECK_FAILED");
      }
    });

    it("self-heals before checking state", () => {
      // Create project with brief+blockers but state says intent_pending
      const tmpDir = createMinimalProject("init-heal", {
        withBrief: true,
        state: "intent_pending",
      });
      const ctx = initCommand(tmpDir, "/test", ["intent_locked"]);
      // After reconcile, state should be intent_locked (brief+blockers exist)
      expect(isCommandError(ctx)).toBe(false);
      if (!isCommandError(ctx)) {
        expect(ctx.doc.current_state).toBe("intent_locked");
      }
    });
  });

  describe("validateAgainstSchema", () => {
    it("validates correct brief", () => {
      const brief = makeMockBrief("test");
      const result = validateAgainstSchema(brief, "creative-brief.schema.json");
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects invalid brief", () => {
      const result = validateAgainstSchema({}, "creative-brief.schema.json");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("returns error for missing schema file", () => {
      const result = validateAgainstSchema({}, "nonexistent.schema.json");
      expect(result.valid).toBe(false);
    });
  });

  describe("draftAndPromote", () => {
    it("promotes valid artifacts atomically", () => {
      const tmpDir = createMinimalProject("promote-ok");
      const drafts: DraftFile[] = [
        {
          relativePath: "01_intent/creative_brief.yaml",
          schemaFile: "creative-brief.schema.json",
          content: makeMockBrief("test"),
          format: "yaml",
        },
      ];
      const result = draftAndPromote(tmpDir, drafts);
      expect(result.success).toBe(true);
      expect(result.promoted).toHaveLength(1);
      // Verify file exists at canonical path
      expect(fs.existsSync(path.join(tmpDir, "01_intent/creative_brief.yaml"))).toBe(true);
      // Verify draft file was cleaned up (renamed)
      expect(fs.existsSync(path.join(tmpDir, "01_intent/creative_brief.draft.yaml"))).toBe(false);
    });

    it("rejects and cleans up when validation fails", () => {
      const tmpDir = createMinimalProject("promote-fail");
      const drafts: DraftFile[] = [
        {
          relativePath: "01_intent/creative_brief.yaml",
          schemaFile: "creative-brief.schema.json",
          content: { invalid: true }, // Missing required fields
          format: "yaml",
        },
      ];
      const result = draftAndPromote(tmpDir, drafts);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Draft should be cleaned up
      expect(fs.existsSync(path.join(tmpDir, "01_intent/creative_brief.draft.yaml"))).toBe(false);
    });

    it("rejects all if ANY artifact is invalid (atomic)", () => {
      const tmpDir = createMinimalProject("promote-atomic");
      const drafts: DraftFile[] = [
        {
          relativePath: "01_intent/creative_brief.yaml",
          schemaFile: "creative-brief.schema.json",
          content: makeMockBrief("test"), // valid
          format: "yaml",
        },
        {
          relativePath: "01_intent/unresolved_blockers.yaml",
          schemaFile: "unresolved-blockers.schema.json",
          content: { invalid: true }, // invalid
          format: "yaml",
        },
      ];
      const result = draftAndPromote(tmpDir, drafts);
      expect(result.success).toBe(false);
      // Neither draft should be promoted
      expect(result.promoted).toHaveLength(0);
    });

    it("creates intermediate directories", () => {
      const tmpDir = createMinimalProject("promote-mkdir");
      // 04_plan may not exist yet
      const selectsDir = path.join(tmpDir, "04_plan");
      if (fs.existsSync(selectsDir)) fs.rmSync(selectsDir, { recursive: true });

      const drafts: DraftFile[] = [
        {
          relativePath: "04_plan/selects_candidates.yaml",
          schemaFile: "selects-candidates.schema.json",
          content: makeMockSelects("test"),
          format: "yaml",
        },
      ];
      const result = draftAndPromote(tmpDir, drafts);
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "04_plan/selects_candidates.yaml"))).toBe(true);
    });

    it("rolls back already-promoted files when a later promote step fails", () => {
      const tmpDir = createMinimalProject("promote-rollback", { withBrief: true });
      const briefPath = path.join(tmpDir, "01_intent/creative_brief.yaml");
      const blockersPath = path.join(tmpDir, "01_intent/unresolved_blockers.yaml");
      const originalBrief = fs.readFileSync(briefPath, "utf-8");
      const originalBlockers = fs.readFileSync(blockersPath, "utf-8");
      const realRenameSync = fs.renameSync;
      const drafts: DraftFile[] = [
        {
          relativePath: "01_intent/creative_brief.yaml",
          schemaFile: "creative-brief.schema.json",
          content: makeMockBrief("test", "collaborative"),
          format: "yaml",
        },
        {
          relativePath: "01_intent/unresolved_blockers.yaml",
          schemaFile: "unresolved-blockers.schema.json",
          content: makeMockBlockers("test"),
          format: "yaml",
        },
      ];

      const result = draftAndPromote(tmpDir, drafts, {
        fsOps: {
          renameSync(oldPath, newPath) {
            const from = String(oldPath);
            const to = String(newPath);
            if (from.endsWith("unresolved_blockers.draft.yaml") && to.endsWith("unresolved_blockers.yaml")) {
              throw new Error("simulated promote failure");
            }
            return realRenameSync(oldPath, newPath);
          },
        },
      });
      expect(result.success).toBe(false);
      expect(result.failure_kind).toBe("promote");

      expect(fs.readFileSync(briefPath, "utf-8")).toBe(originalBrief);
      expect(fs.readFileSync(blockersPath, "utf-8")).toBe(originalBlockers);
      expect(fs.readdirSync(path.join(tmpDir, "01_intent")).some((name) => name.includes("promote-backup"))).toBe(false);
    });

    it("aborts promote when a guarded upstream hash changes before commit", () => {
      const tmpDir = createMinimalProject("promote-concurrent", { withBrief: true });
      const briefPath = path.join(tmpDir, "01_intent/creative_brief.yaml");
      const preflightHashes = snapshotArtifacts(tmpDir).hashes;

      fs.writeFileSync(briefPath, `${fs.readFileSync(briefPath, "utf-8")}\n# concurrent edit\n`, "utf-8");

      const drafts: DraftFile[] = [
        {
          relativePath: "01_intent/unresolved_blockers.yaml",
          schemaFile: "unresolved-blockers.schema.json",
          content: makeMockBlockers("test"),
          format: "yaml",
        },
      ];

      const result = draftAndPromote(tmpDir, drafts, {
        preflightHashes,
        guardKeys: ["brief_hash"],
      });
      expect(result.success).toBe(false);
      expect(result.failure_kind).toBe("concurrent_edit");
      expect(result.errors[0]).toContain("brief_hash changed");
      expect(fs.existsSync(path.join(tmpDir, "01_intent/unresolved_blockers.draft.yaml"))).toBe(false);
    });
  });

  describe("transitionState", () => {
    it("updates state and records history", () => {
      const tmpDir = createMinimalProject("transition", { state: "intent_pending" });
      const doc = readProjectState(tmpDir)!;
      const updated = transitionState(
        tmpDir,
        doc,
        "intent_locked",
        "/intent",
        "intent-interviewer",
        "brief finalized",
      );
      expect(updated.current_state).toBe("intent_locked");
      expect(updated.last_agent).toBe("intent-interviewer");
      expect(updated.last_command).toBe("/intent");
      expect(updated.history).toBeDefined();
      expect(updated.history!.length).toBeGreaterThan(0);
      const lastEntry = updated.history![updated.history!.length - 1];
      expect(lastEntry.from_state).toBe("intent_pending");
      expect(lastEntry.to_state).toBe("intent_locked");
      expect(lastEntry.note).toBe("brief finalized");

      // Verify persisted
      const reloaded = readProjectState(tmpDir)!;
      expect(reloaded.current_state).toBe("intent_locked");
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. /intent Command
// ══════════════════════════════════════════════════════════════════

describe("/intent command", () => {
  it("produces valid creative_brief.yaml and transitions to intent_locked", async () => {
    const tmpDir = createMinimalProject("intent-ok", { state: "intent_pending" });
    const agent = createMockIntentAgent();

    const result = await runIntent(tmpDir, agent);
    expect(result.success).toBe(true);
    expect(result.newState).toBe("intent_locked");
    expect(result.previousState).toBe("intent_pending");

    // Verify artifacts exist
    expect(fs.existsSync(path.join(tmpDir, "01_intent/creative_brief.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "01_intent/unresolved_blockers.yaml"))).toBe(true);

    // Verify schema validity
    const briefRaw = fs.readFileSync(path.join(tmpDir, "01_intent/creative_brief.yaml"), "utf-8");
    const brief = parseYaml(briefRaw);
    const validate = createValidator("creative-brief.schema.json");
    expect(validate(brief)).toBe(true);
  });

  it("produces valid unresolved_blockers.yaml", async () => {
    const tmpDir = createMinimalProject("intent-blockers", { state: "intent_pending" });
    const agent = createMockIntentAgent();

    const result = await runIntent(tmpDir, agent);
    expect(result.success).toBe(true);

    const blockersRaw = fs.readFileSync(
      path.join(tmpDir, "01_intent/unresolved_blockers.yaml"),
      "utf-8",
    );
    const blockers = parseYaml(blockersRaw);
    const validate = createValidator("unresolved-blockers.schema.json");
    expect(validate(blockers)).toBe(true);
  });

  it("fails when human declines readback", async () => {
    const tmpDir = createMinimalProject("intent-decline", { state: "intent_pending" });
    const agent = createMockIntentAgent({ confirmed: false });

    const result = await runIntent(tmpDir, agent);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");

    // State should not change
    const doc = readProjectState(tmpDir)!;
    expect(doc.current_state).toBe("intent_pending");
  });

  it("fails when agent produces invalid brief", async () => {
    const tmpDir = createMinimalProject("intent-invalid", { state: "intent_pending" });
    const agent: IntentAgent = {
      async run() {
        return {
          brief: { invalid: true } as any,
          blockers: makeMockBlockers("test"),
          confirmed: true,
        };
      },
    };

    const result = await runIntent(tmpDir, agent);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
  });

  it("fails when agent produces invalid blockers (atomic: neither promotes)", async () => {
    const tmpDir = createMinimalProject("intent-bad-blockers", { state: "intent_pending" });
    const agent: IntentAgent = {
      async run() {
        return {
          brief: makeMockBrief("test"),
          blockers: { invalid: true } as any, // Invalid
          confirmed: true,
        };
      },
    };

    const result = await runIntent(tmpDir, agent);
    expect(result.success).toBe(false);
    // Neither artifact should be promoted (atomic rule)
    expect(result.promoted).toBeUndefined();
  });

  it("repairs missing autonomy.mode before promoting the brief", async () => {
    const tmpDir = createMinimalProject("intent-repair-mode", { state: "intent_pending" });
    const agent: IntentAgent = {
      async run() {
        const baseBrief = makeMockBrief("test");
        const brief = {
          ...baseBrief,
          autonomy: {
            may_decide: baseBrief.autonomy.may_decide,
            must_ask: baseBrief.autonomy.must_ask,
          },
        };
        return {
          brief,
          blockers: makeMockBlockers("test"),
          confirmed: true,
        };
      },
    };

    const result = await runIntent(tmpDir, agent);
    expect(result.success).toBe(true);
    expect(result.brief?.autonomy.mode).toBe("collaborative");

    const persisted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "01_intent/creative_brief.yaml"), "utf-8"),
    ) as { autonomy: { mode: string } };
    expect(persisted.autonomy.mode).toBe("collaborative");
  });

  it("is re-runnable from any state", async () => {
    // Create project already at selects_ready
    const tmpDir = createMinimalProject("intent-rerun", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });
    const agent = createMockIntentAgent();

    const result = await runIntent(tmpDir, agent);
    expect(result.success).toBe(true);
    expect(result.newState).toBe("intent_locked");
  });

  it("records history entry on successful transition", async () => {
    const tmpDir = createMinimalProject("intent-history", { state: "intent_pending" });
    const agent = createMockIntentAgent();

    await runIntent(tmpDir, agent);

    const doc = readProjectState(tmpDir)!;
    expect(doc.history).toBeDefined();
    // Should have at least one entry from the intent command
    const intentEntries = doc.history!.filter((h) => h.trigger === "/intent");
    expect(intentEntries.length).toBeGreaterThan(0);
    expect(intentEntries[intentEntries.length - 1].to_state).toBe("intent_locked");
  });

  it("sets last_agent and last_command", async () => {
    const tmpDir = createMinimalProject("intent-meta", { state: "intent_pending" });
    const agent = createMockIntentAgent();

    await runIntent(tmpDir, agent);

    const doc = readProjectState(tmpDir)!;
    expect(doc.last_agent).toBe("intent-interviewer");
    expect(doc.last_command).toBe("/intent");
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. /triage Command
// ══════════════════════════════════════════════════════════════════

describe("/triage command", () => {
  it("produces valid selects_candidates.yaml and transitions to selects_ready", async () => {
    const tmpDir = createMinimalProject("triage-ok", {
      withBrief: true,
      withAnalysis: true,
      state: "intent_locked", // reconcile → media_analyzed
    });
    const agent = createMockTriageAgent();

    const result = await runTriage(tmpDir, agent);
    expect(result.success).toBe(true);
    expect(result.newState).toBe("selects_ready");
    expect(result.previousState).toBe("media_analyzed");

    // Verify artifact exists
    expect(fs.existsSync(path.join(tmpDir, "04_plan/selects_candidates.yaml"))).toBe(true);

    // Verify schema validity
    const selectsRaw = fs.readFileSync(
      path.join(tmpDir, "04_plan/selects_candidates.yaml"),
      "utf-8",
    );
    const selects = parseYaml(selectsRaw);
    const validate = createValidator("selects-candidates.schema.json");
    expect(validate(selects)).toBe(true);
  });

  it("fails when state is intent_pending (state check)", async () => {
    const tmpDir = createMinimalProject("triage-bad-state", { state: "intent_pending" });
    const agent = createMockTriageAgent();

    const result = await runTriage(tmpDir, agent);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("STATE_CHECK_FAILED");
  });

  it("fails when analysis gate is blocked", async () => {
    // brief exists but NO analysis artifacts → analysis_gate = blocked
    const tmpDir = createMinimalProject("triage-no-analysis", {
      withBrief: true,
      state: "intent_locked",
    });
    const agent = createMockTriageAgent();

    const result = await runTriage(tmpDir, agent);
    expect(result.success).toBe(false);
    // Should fail at state check (intent_locked not in allowed states for triage)
    // since we need media_analyzed
    expect(result.error?.code).toBe("STATE_CHECK_FAILED");
  });

  it("succeeds with analysis_gate = ready (qc_status ready)", async () => {
    const tmpDir = createMinimalProject("triage-gate-ready", {
      withBrief: true,
      withAnalysis: true,
      state: "intent_locked", // reconcile → media_analyzed
    });
    const agent = createMockTriageAgent();

    const result = await runTriage(tmpDir, agent);
    expect(result.success).toBe(true);
  });

  it("fails when analysis_gate is blocked and no override", async () => {
    // No analysis → reconcile heals to intent_locked → state check fails
    const tmpDir = createMinimalProject("triage-gate-blocked", {
      withBrief: true,
      state: "intent_locked",
    });

    const agent = createMockTriageAgent();
    const result = await runTriage(tmpDir, agent);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("STATE_CHECK_FAILED");
  });

  it("succeeds with partial_override when qc_status is partial and override matches artifact_version", async () => {
    const tmpDir = createMinimalProject("triage-partial-override", {
      withBrief: true,
      withAnalysis: true,
      state: "intent_locked",
      analysisOverride: {
        status: "active",
        approved_by: "operator",
        approved_at: "2026-03-21T00:00:00Z",
        reason: "debug run with partial analysis",
        scope: "limited",
        artifact_version: "analysis-v1",
      },
    });
    fs.writeFileSync(
      path.join(tmpDir, "03_analysis/gap_report.yaml"),
      stringifyYaml({
        version: "1",
        entries: [
          {
            stage: "transcript",
            asset_id: "AST_001",
            severity: "warning",
            reason: "Transcript pending cleanup",
          },
        ],
      }),
      "utf-8",
    );

    const agent = createMockTriageAgent();
    const result = await runTriage(tmpDir, agent);
    expect(result.success).toBe(true);
    expect(result.newState).toBe("selects_ready");
  });

  it("fails when qc_status is partial and analysis_override is missing or stale", async () => {
    const tmpDir = createMinimalProject("triage-partial-no-override", {
      withBrief: true,
      withAnalysis: true,
      state: "intent_locked",
    });
    fs.writeFileSync(
      path.join(tmpDir, "03_analysis/gap_report.yaml"),
      stringifyYaml({
        version: "1",
        entries: [
          {
            stage: "transcript",
            asset_id: "AST_001",
            severity: "warning",
            reason: "Transcript pending cleanup",
          },
        ],
      }),
      "utf-8",
    );

    const agent = createMockTriageAgent();
    const result = await runTriage(tmpDir, agent);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("STATE_CHECK_FAILED");
  });

  it("fails when human declines candidate board", async () => {
    const tmpDir = createMinimalProject("triage-decline", {
      withBrief: true,
      withAnalysis: true,
      autonomyMode: "collaborative",
      state: "intent_locked", // reconcile → media_analyzed (analysis ready)
    });
    const agent = createMockTriageAgent({ confirmed: false });

    const result = await runTriage(tmpDir, agent);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
  });

  it("autonomy:full auto-approves candidate board even when agent confirmation is false", async () => {
    const tmpDir = createMinimalProject("triage-auto-full", {
      withBrief: true,
      withAnalysis: true,
      autonomyMode: "full",
      state: "intent_locked",
    });
    const agent = createMockTriageAgent({ confirmed: false });

    const result = await runTriage(tmpDir, agent);

    expect(result.success).toBe(true);
    expect(result.newState).toBe("selects_ready");
    expect(fs.existsSync(path.join(tmpDir, "04_plan/selects_candidates.yaml"))).toBe(true);
  });

  it("fails when agent produces invalid selects", async () => {
    const tmpDir = createMinimalProject("triage-invalid", {
      withBrief: true,
      withAnalysis: true,
      state: "intent_locked", // reconcile → media_analyzed
    });
    const agent: TriageAgent = {
      async run() {
        return {
          selects: { invalid: true } as any,
          confirmed: true,
        };
      },
    };

    const result = await runTriage(tmpDir, agent);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
  });

  it("fails when creative_brief.yaml is missing", async () => {
    const tmpDir = createMinimalProject("triage-no-brief", {
      withAnalysis: true,
      state: "media_analyzed",
    });
    // Don't add brief → will self-heal to intent_pending → state check fails
    const agent = createMockTriageAgent();

    const result = await runTriage(tmpDir, agent);
    expect(result.success).toBe(false);
  });

  it("records history entry on successful transition", async () => {
    const tmpDir = createMinimalProject("triage-history", {
      withBrief: true,
      withAnalysis: true,
      state: "intent_locked", // reconcile → media_analyzed
    });
    const agent = createMockTriageAgent();

    await runTriage(tmpDir, agent);

    const doc = readProjectState(tmpDir)!;
    const triageEntries = doc.history!.filter((h) => h.trigger === "/triage");
    expect(triageEntries.length).toBeGreaterThan(0);
    expect(triageEntries[triageEntries.length - 1].to_state).toBe("selects_ready");
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. /status Command
// ══════════════════════════════════════════════════════════════════

describe("/status command", () => {
  it("returns current state and gates", () => {
    const tmpDir = createTempProject("status-full");
    writeProjectState(tmpDir, {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    });

    const result = runStatus(tmpDir);
    expect(result.success).toBe(true);
    expect(result.currentState).toBeDefined();
    expect(result.gates).toBeDefined();
    expect(result.nextCommand).toBeDefined();
  });

  it("recommends /intent for intent_pending", () => {
    const tmpDir = createMinimalProject("status-pending", { state: "intent_pending" });

    const result = runStatus(tmpDir);
    expect(result.success).toBe(true);
    expect(result.nextCommand).toBe("/intent");
  });

  it("recommends /triage for media_analyzed with ready analysis", () => {
    const tmpDir = createMinimalProject("status-analyzed", {
      withBrief: true,
      withAnalysis: true,
      state: "intent_locked", // reconcile → media_analyzed
    });

    const result = runStatus(tmpDir);
    expect(result.success).toBe(true);
    expect(result.currentState).toBe("media_analyzed");
    expect(result.nextCommand).toBe("/triage");
  });

  it("recommends /blueprint for selects_ready", () => {
    const tmpDir = createMinimalProject("status-selects", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });

    const result = runStatus(tmpDir);
    expect(result.success).toBe(true);
    expect(result.nextCommand).toBe("/blueprint");
  });

  it("detects stale artifacts", () => {
    const tmpDir = createTempProject("status-stale");
    // Write state with old hashes
    const doc: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "critique_ready",
      artifact_hashes: {
        brief_hash: "OLD_HASH",
      },
      history: [],
    };
    writeProjectState(tmpDir, doc);

    const result = runStatus(tmpDir);
    expect(result.success).toBe(true);
    // Brief hash changed → downstream should be stale
    if (result.staleArtifacts && result.staleArtifacts.length > 0) {
      expect(result.staleArtifacts).toContain("selects");
    }
  });

  it("reports self-heal when state diverges from artifacts", () => {
    const tmpDir = createMinimalProject("status-heal", {
      withBrief: true,
      state: "blueprint_ready", // too far ahead — no blueprint exists
    });

    const result = runStatus(tmpDir);
    expect(result.success).toBe(true);
    expect(result.selfHealed).toBe(true);
    expect(result.currentState).toBe("intent_locked"); // healed back
  });

  it("does not change state", () => {
    const tmpDir = createMinimalProject("status-readonly", {
      withBrief: true,
      state: "intent_locked",
    });

    runStatus(tmpDir);
    const doc = readProjectState(tmpDir)!;
    // Status should maintain intent_locked (consistent with artifacts)
    expect(doc.current_state).toBe("intent_locked");
  });

  it("recommends analysis for intent_locked with blocked gate", () => {
    const tmpDir = createMinimalProject("status-need-analysis", {
      withBrief: true,
      state: "intent_locked",
    });

    const result = runStatus(tmpDir);
    expect(result.success).toBe(true);
    // No analysis artifacts → analysis_gate blocked → recommend analysis
    expect(result.nextCommand).toBe("run analysis");
  });

  it("recommends /triage for intent_locked with ready analysis gate", () => {
    const tmpDir = createMinimalProject("status-ready-analysis", {
      withBrief: true,
      withAnalysis: true,
      state: "intent_locked",
    });

    const result = runStatus(tmpDir);
    expect(result.success).toBe(true);
    expect(result.nextCommand).toBe("/triage");
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. Integration: Full Pipeline (intent → triage)
// ══════════════════════════════════════════════════════════════════

describe("integration: intent → triage pipeline", () => {
  it("runs intent then triage with mock agents", async () => {
    // Start from scratch with analysis already present
    const tmpDir = createMinimalProject("pipeline", {
      withAnalysis: true,
      state: "intent_pending",
    });

    // Step 1: /intent
    const intentAgent = createMockIntentAgent();
    const intentResult = await runIntent(tmpDir, intentAgent);
    expect(intentResult.success).toBe(true);
    expect(intentResult.newState).toBe("intent_locked");

    // Verify state file
    const doc = readProjectState(tmpDir)!;
    expect(doc.current_state).toBe("intent_locked");

    // Step 2: /triage — reconcile will see brief+blockers+analysis → media_analyzed
    const triageAgent = createMockTriageAgent();
    const triageResult = await runTriage(tmpDir, triageAgent);
    expect(triageResult.success).toBe(true);
    expect(triageResult.newState).toBe("selects_ready");

    // Verify final state
    const finalDoc = readProjectState(tmpDir)!;
    expect(finalDoc.current_state).toBe("selects_ready");

    // Verify history records both transitions
    const intentEntries = finalDoc.history!.filter((h) => h.trigger === "/intent");
    const triageEntries = finalDoc.history!.filter((h) => h.trigger === "/triage");
    expect(intentEntries.length).toBeGreaterThan(0);
    expect(triageEntries.length).toBeGreaterThan(0);

    // Verify all artifacts are schema-valid
    const briefValidate = createValidator("creative-brief.schema.json");
    const blockersValidate = createValidator("unresolved-blockers.schema.json");
    const selectsValidate = createValidator("selects-candidates.schema.json");

    const brief = parseYaml(fs.readFileSync(path.join(tmpDir, "01_intent/creative_brief.yaml"), "utf-8"));
    const blockers = parseYaml(fs.readFileSync(path.join(tmpDir, "01_intent/unresolved_blockers.yaml"), "utf-8"));
    const selects = parseYaml(fs.readFileSync(path.join(tmpDir, "04_plan/selects_candidates.yaml"), "utf-8"));

    expect(briefValidate(brief)).toBe(true);
    expect(blockersValidate(blockers)).toBe(true);
    expect(selectsValidate(selects)).toBe(true);
  });

  it("status reflects correct next command at each stage", async () => {
    const tmpDir = createMinimalProject("pipeline-status", {
      withAnalysis: true,
      state: "intent_pending",
    });

    // Before intent
    let status = runStatus(tmpDir);
    expect(status.nextCommand).toBe("/intent");

    // After intent — reconcile sees analysis → recommends /triage
    const intentAgent = createMockIntentAgent();
    await runIntent(tmpDir, intentAgent);

    status = runStatus(tmpDir);
    // intent_locked + analysis → reconcile → media_analyzed → /triage
    expect(status.nextCommand).toBe("/triage");

    // After triage (reconcile will self-heal to media_analyzed)
    const triageAgent = createMockTriageAgent();
    await runTriage(tmpDir, triageAgent);

    status = runStatus(tmpDir);
    expect(status.nextCommand).toBe("/blueprint");
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. /blueprint Command
// ══════════════════════════════════════════════════════════════════

describe("/blueprint command", () => {
  it("autonomy:full → no confirmed_preferences interview, blueprint generated", async () => {
    const tmpDir = createMinimalProject("blueprint-full", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      autonomyMode: "full",
      state: "selects_ready",
    });

    const agent = createMockBlueprintAgent(undefined, { autonomyMode: "full" });
    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });

    expect(result.success).toBe(true);
    expect(result.newState).toBe("blueprint_ready");
    expect(result.previousState).toBe("selects_ready");

    // confirmed_preferences should exist with ai_autonomous source
    const prefs = result.blueprint!.pacing.confirmed_preferences!;
    expect(prefs.mode).toBe("full");
    expect(prefs.source).toBe("ai_autonomous");
    expect(prefs.duration_target_sec).toBeGreaterThan(0);
    expect(prefs.confirmed_at).toBeDefined();
    // No structure_choice or pacing_notes in full mode
    expect(prefs.structure_choice).toBeUndefined();
    expect(prefs.pacing_notes).toBeUndefined();

    // Verify artifacts exist
    expect(fs.existsSync(path.join(tmpDir, "04_plan/edit_blueprint.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "04_plan/uncertainty_register.yaml"))).toBe(true);

    // Verify schema validity
    const bpRaw = fs.readFileSync(path.join(tmpDir, "04_plan/edit_blueprint.yaml"), "utf-8");
    const bp = parseYaml(bpRaw);
    const validate = createValidator("edit-blueprint.schema.json");
    expect(validate(bp)).toBe(true);
  });

  it("autonomy:collaborative → preference interview, confirmed_preferences present", async () => {
    const tmpDir = createMinimalProject("blueprint-collab", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      autonomyMode: "collaborative",
      state: "selects_ready",
    });

    const agent = createMockBlueprintAgent(undefined, { autonomyMode: "collaborative" });
    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });

    expect(result.success).toBe(true);
    expect(result.newState).toBe("blueprint_ready");

    // confirmed_preferences should exist with human_confirmed source
    const prefs = result.blueprint!.pacing.confirmed_preferences!;
    expect(prefs.mode).toBe("collaborative");
    expect(prefs.source).toBe("human_confirmed");
    expect(prefs.duration_target_sec).toBeGreaterThan(0);
    expect(prefs.structure_choice).toBe("three-act");
    expect(prefs.pacing_notes).toBe("operator prefers brisk middle");
  });

  it("planning blocker → transitions to blocked", async () => {
    const tmpDir = createMinimalProject("blueprint-blocker", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });

    const agent = createMockBlueprintAgent(undefined, { withBlocker: true });
    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });

    expect(result.success).toBe(true);
    expect(result.newState).toBe("blocked");
    expect(result.planningBlocked).toBe(true);

    // Verify uncertainty_register has blocker
    const urRaw = fs.readFileSync(
      path.join(tmpDir, "04_plan/uncertainty_register.yaml"),
      "utf-8",
    );
    const ur = parseYaml(urRaw) as UncertaintyRegister;
    expect(ur.uncertainties.some((u) => u.status === "blocker")).toBe(true);

    // Verify state is blocked
    const doc = readProjectState(tmpDir)!;
    expect(doc.current_state).toBe("blocked");
  });

  it("unresolved blockers keep /blueprint in blocked and are passed to the agent", async () => {
    const tmpDir = createMinimalProject("blueprint-compile-blocked", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/unresolved_blockers.yaml"),
      stringifyYaml({
        version: "1",
        project_id: "test-project",
        blockers: [
          {
            id: "BLK_002",
            question: "Rights approval missing?",
            status: "blocker",
            why_it_matters: "Cannot compile approved cut",
            allowed_temporary_assumption: null,
          },
        ],
      }),
      "utf-8",
    );

    let capturedBlockers: unknown = null;
    const agent: BlueprintAgent = {
      async run(ctx) {
        capturedBlockers = ctx.blockersContent;
        return {
          blueprint: makeMockBlueprint(ctx.projectId),
          uncertaintyRegister: makeMockUncertaintyRegister(ctx.projectId),
          confirmed: true,
        };
      },
    };

    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(true);
    expect(result.newState).toBe("blocked");
    expect(result.planningBlocked).toBe(true);
    expect((capturedBlockers as { blockers: Array<{ status: string }> }).blockers[0].status).toBe("blocker");
  });

  it("STYLE.md is read and passed to agent", async () => {
    const tmpDir = createMinimalProject("blueprint-style", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      withStyle: true,
      state: "selects_ready",
    });

    let capturedStyle: string | null = null;
    const agent: BlueprintAgent = {
      async run(ctx) {
        capturedStyle = ctx.styleContent;
        return {
          blueprint: makeMockBlueprint(ctx.projectId),
          uncertaintyRegister: makeMockUncertaintyRegister(ctx.projectId),
          confirmed: true,
        };
      },
    };

    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(true);
    expect(capturedStyle).not.toBeNull();
    expect(capturedStyle).toContain("brisk 2-3 second cuts");
    expect(capturedStyle).toContain("warm earth tones");
  });

  it("works without STYLE.md (styleContent is null)", async () => {
    const tmpDir = createMinimalProject("blueprint-no-style", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });

    let capturedStyle: string | null = "not-null";
    const agent: BlueprintAgent = {
      async run(ctx) {
        capturedStyle = ctx.styleContent;
        return {
          blueprint: makeMockBlueprint(ctx.projectId),
          uncertaintyRegister: makeMockUncertaintyRegister(ctx.projectId),
          confirmed: true,
        };
      },
    };

    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(true);
    expect(capturedStyle).toBeNull();
  });

  it("rejects invalid blueprint (schema validation)", async () => {
    const tmpDir = createMinimalProject("blueprint-invalid", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });

    const agent: BlueprintAgent = {
      async run(ctx) {
        return {
          blueprint: { invalid: true } as any,
          uncertaintyRegister: makeMockUncertaintyRegister(ctx.projectId),
          confirmed: true,
        };
      },
    };

    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
  });

  it("rejects invalid uncertainty_register (atomic: neither promotes)", async () => {
    const tmpDir = createMinimalProject("blueprint-invalid-ur", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });

    const agent: BlueprintAgent = {
      async run(ctx) {
        return {
          blueprint: makeMockBlueprint(ctx.projectId),
          uncertaintyRegister: { invalid: true } as any,
          confirmed: true,
        };
      },
    };

    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    // Neither artifact should be promoted
    expect(result.promoted).toBeUndefined();
  });

  it("fails when human declines beat proposal readback", async () => {
    const tmpDir = createMinimalProject("blueprint-decline", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      autonomyMode: "collaborative",
      state: "selects_ready",
    });

    const agent = createMockBlueprintAgent({ confirmed: false });
    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(result.error?.message).toContain("readback");

    // State should not change
    const doc = readProjectState(tmpDir)!;
    expect(doc.current_state).toBe("selects_ready");
  });

  it("autonomy:full skips beat proposal readback even when agent confirmation is false", async () => {
    const tmpDir = createMinimalProject("blueprint-auto-full", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      autonomyMode: "full",
      state: "selects_ready",
    });

    const agent = createMockBlueprintAgent({ confirmed: false }, { autonomyMode: "full" });
    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });

    expect(result.success).toBe(true);
    expect(result.newState).toBe("blueprint_ready");
    expect(result.blueprint!.pacing.confirmed_preferences!.source).toBe("ai_autonomous");
  });

  it("fails when state is not selects_ready", async () => {
    const tmpDir = createMinimalProject("blueprint-bad-state", {
      withBrief: true,
      state: "intent_locked",
    });

    const agent = createMockBlueprintAgent();
    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("STATE_CHECK_FAILED");
  });

  it("fails when creative_brief.yaml is missing", async () => {
    const tmpDir = createMinimalProject("blueprint-no-brief", {
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });
    // No brief → reconcile heals to intent_pending → state check fails
    const agent = createMockBlueprintAgent();
    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(false);
  });

  it("fails when selects_candidates.yaml is missing", async () => {
    const tmpDir = createMinimalProject("blueprint-no-selects", {
      withBrief: true,
      withAnalysis: true,
      state: "selects_ready",
    });
    // selects_ready state but no selects file → reconcile heals to media_analyzed → state check fails
    const agent = createMockBlueprintAgent();
    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(false);
  });

  it("records history entry on successful transition", async () => {
    const tmpDir = createMinimalProject("blueprint-history", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });

    const agent = createMockBlueprintAgent();
    await runBlueprint(tmpDir, agent, { iterativeEngine: false });

    const doc = readProjectState(tmpDir)!;
    const bpEntries = doc.history!.filter((h) => h.trigger === "/blueprint");
    expect(bpEntries.length).toBeGreaterThan(0);
    expect(bpEntries[bpEntries.length - 1].to_state).toBe("blueprint_ready");
  });

  it("sets last_agent and last_command", async () => {
    const tmpDir = createMinimalProject("blueprint-meta", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });

    const agent = createMockBlueprintAgent();
    await runBlueprint(tmpDir, agent, { iterativeEngine: false });

    const doc = readProjectState(tmpDir)!;
    expect(doc.last_agent).toBe("blueprint-planner");
    expect(doc.last_command).toBe("/blueprint");
  });

  it("validates uncertainty_register schema", async () => {
    const tmpDir = createMinimalProject("blueprint-ur-valid", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });

    const agent = createMockBlueprintAgent();
    await runBlueprint(tmpDir, agent, { iterativeEngine: false });

    const urRaw = fs.readFileSync(
      path.join(tmpDir, "04_plan/uncertainty_register.yaml"),
      "utf-8",
    );
    const ur = parseYaml(urRaw);
    const validate = createValidator("uncertainty-register.schema.json");
    expect(validate(ur)).toBe(true);
  });

  it("autonomy mode defaults to collaborative when brief lacks mode", async () => {
    const tmpDir = createMinimalProject("blueprint-no-mode", {
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });
    // Write a brief WITHOUT autonomy.mode
    const briefNoMode = {
      project: { title: "Test", strategy: "Test strategy", runtime_target_sec: 60 },
      message: { primary: "Test message" },
      audience: { primary: "Test audience" },
      emotion_curve: ["a", "b", "c"],
      must_have: ["something"],
      must_avoid: ["nothing"],
      autonomy: { may_decide: ["pacing"], must_ask: ["title"] },
      resolved_assumptions: ["assumption"],
    };
    fs.mkdirSync(path.join(tmpDir, "01_intent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/creative_brief.yaml"),
      stringifyYaml(briefNoMode),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/unresolved_blockers.yaml"),
      stringifyYaml(makeMockBlockers("test")),
      "utf-8",
    );

    let capturedMode: string | undefined;
    const agent: BlueprintAgent = {
      async run(ctx) {
        capturedMode = ctx.autonomyMode;
        return {
          blueprint: makeMockBlueprint(ctx.projectId, { autonomyMode: "collaborative" }),
          uncertaintyRegister: makeMockUncertaintyRegister(ctx.projectId),
          confirmed: true,
        };
      },
    };

    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(true);
    expect(capturedMode).toBe("collaborative");
  });

  it("autonomy mode infers full when legacy brief lacks mode and must_ask is empty", async () => {
    const tmpDir = createMinimalProject("blueprint-no-mode-full", {
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });
    const briefNoMode = {
      project: { title: "Test", strategy: "Test strategy", runtime_target_sec: 60 },
      message: { primary: "Test message" },
      audience: { primary: "Test audience" },
      emotion_curve: ["a", "b", "c"],
      must_have: ["something"],
      must_avoid: ["nothing"],
      autonomy: { may_decide: ["pacing"], must_ask: [] },
      resolved_assumptions: ["assumption"],
    };
    fs.mkdirSync(path.join(tmpDir, "01_intent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/creative_brief.yaml"),
      stringifyYaml(briefNoMode),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/unresolved_blockers.yaml"),
      stringifyYaml(makeMockBlockers("test")),
      "utf-8",
    );

    let capturedMode: string | undefined;
    const agent: BlueprintAgent = {
      async run(ctx) {
        capturedMode = ctx.autonomyMode;
        return {
          blueprint: makeMockBlueprint(ctx.projectId, { autonomyMode: "full" }),
          uncertaintyRegister: makeMockUncertaintyRegister(ctx.projectId),
          confirmed: true,
        };
      },
    };

    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(true);
    expect(capturedMode).toBe("full");
  });

  it("rejects invalid confirmed_preferences contract for collaborative mode", async () => {
    const tmpDir = createMinimalProject("blueprint-bad-prefs", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      autonomyMode: "collaborative",
      state: "selects_ready",
    });

    const agent: BlueprintAgent = {
      async run(ctx) {
        const blueprint = makeMockBlueprint(ctx.projectId, { autonomyMode: "collaborative" });
        blueprint.pacing.confirmed_preferences = {
          mode: "collaborative",
          source: "ai_autonomous",
          duration_target_sec: 120,
          confirmed_at: "2026-03-21T00:00:00Z",
        };
        return {
          blueprint,
          uncertaintyRegister: makeMockUncertaintyRegister(ctx.projectId),
          confirmed: true,
        };
      },
    };

    const result = await runBlueprint(tmpDir, agent, { iterativeEngine: false });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(result.error?.message).toContain("confirmed_preferences.source");
  });
});

// ══════════════════════════════════════════════════════════════════
// 7. Integration: Full Pipeline (intent → triage → blueprint)
// ══════════════════════════════════════════════════════════════════

describe("integration: intent → triage → blueprint pipeline", () => {
  it("runs full pipeline with mock agents", async () => {
    const tmpDir = createMinimalProject("pipeline-full", {
      withAnalysis: true,
      state: "intent_pending",
    });

    // Step 1: /intent
    const intentAgent = createMockIntentAgent();
    const intentResult = await runIntent(tmpDir, intentAgent);
    expect(intentResult.success).toBe(true);

    // Step 2: /triage
    const triageAgent = createMockTriageAgent();
    const triageResult = await runTriage(tmpDir, triageAgent);
    expect(triageResult.success).toBe(true);
    expect(triageResult.newState).toBe("selects_ready");

    // Step 3: /blueprint
    const bpAgent = createMockBlueprintAgent();
    const bpResult = await runBlueprint(tmpDir, bpAgent, { iterativeEngine: false });
    expect(bpResult.success).toBe(true);
    expect(bpResult.newState).toBe("blueprint_ready");

    // Verify final state
    const finalDoc = readProjectState(tmpDir)!;
    expect(finalDoc.current_state).toBe("blueprint_ready");

    // Verify all artifacts schema-valid
    const bpValidate = createValidator("edit-blueprint.schema.json");
    const urValidate = createValidator("uncertainty-register.schema.json");

    const bp = parseYaml(fs.readFileSync(path.join(tmpDir, "04_plan/edit_blueprint.yaml"), "utf-8"));
    const ur = parseYaml(fs.readFileSync(path.join(tmpDir, "04_plan/uncertainty_register.yaml"), "utf-8"));

    expect(bpValidate(bp)).toBe(true);
    expect(urValidate(ur)).toBe(true);

    // Verify history has all three transitions
    const history = finalDoc.history!;
    expect(history.some((h) => h.trigger === "/intent")).toBe(true);
    expect(history.some((h) => h.trigger === "/triage")).toBe(true);
    expect(history.some((h) => h.trigger === "/blueprint")).toBe(true);
  });

  it("status reflects /review after blueprint_ready", async () => {
    const tmpDir = createMinimalProject("pipeline-bp-status", {
      withBrief: true,
      withAnalysis: true,
      withSelects: true,
      state: "selects_ready",
    });

    const agent = createMockBlueprintAgent();
    await runBlueprint(tmpDir, agent, { iterativeEngine: false });

    const status = runStatus(tmpDir);
    expect(status.success).toBe(true);
    expect(status.currentState).toBe("blueprint_ready");
    // Next command after blueprint_ready should be /review
    expect(status.nextCommand).toBe("/review");
  });
});

// ══════════════════════════════════════════════════════════════════
// 8. /review Command
// ══════════════════════════════════════════════════════════════════

// ── Mock Review Data Factories ──────────────────────────────────

function makeMockReviewReport(
  projectId: string,
  overrides?: Partial<ReviewReport>,
): ReviewReport {
  return {
    version: "1",
    project_id: projectId,
    timeline_version: "1",
    summary_judgment: {
      status: "needs_revision",
      rationale: "Overall solid but hook beat could use tighter trim.",
      confidence: 0.82,
    },
    strengths: [
      { summary: "Beat boundaries are well-placed." },
    ],
    weaknesses: [
      { summary: "Hook hero has minor highlight clipping.", affected_clip_ids: ["CLP_0001"] },
    ],
    fatal_issues: [],
    warnings: [
      { summary: "Wind quality flag in b03.", severity: "warning" },
    ],
    mismatches_to_brief: [],
    mismatches_to_blueprint: [],
    recommended_next_pass: {
      goal: "Tighten hook and review wind issues.",
      actions: ["Trim CLP_0001", "Check wind in b03"],
    },
    ...overrides,
  };
}

function makeMockReviewPatch(overrides?: Partial<ReviewPatch>): ReviewPatch {
  return {
    timeline_version: "1",
    operations: [
      {
        op: "trim_segment",
        target_clip_id: "CLP_0001",
        new_src_in_us: 2000000,
        new_src_out_us: 5500000,
        reason: "Reduce highlight clipping",
        confidence: 0.85,
      },
      {
        op: "add_marker",
        new_timeline_in_frame: 312,
        reason: "Audio QA needed for wind in b03",
        confidence: 0.9,
      },
    ],
    ...overrides,
  };
}

function makeMockFatalReport(projectId: string): ReviewReport {
  return makeMockReviewReport(projectId, {
    fatal_issues: [
      {
        summary: "Must-have 'summit rescue sequence' is completely missing.",
        severity: "fatal",
        evidence: ["brief.must_have[0]"],
      },
    ],
    summary_judgment: {
      status: "blocked",
      rationale: "Critical brief requirement missing.",
      confidence: 0.95,
    },
  });
}

function createMockReviewAgent(overrides?: Partial<ReviewAgentResult>): ReviewAgent {
  return {
    async run(ctx) {
      return {
        report: makeMockReviewReport(ctx.projectId),
        patch: makeMockReviewPatch(),
        ...overrides,
      };
    },
  };
}

/** Creates a full project from the sample fixture with all prerequisites for /review */
function createReviewReadyProject(
  name: string,
  patches?: Record<string, unknown>,
): string {
  const tmpDir = createTempProject(`review-${name}`, patches);
  // The sample project has all the artifacts.
  // We need to ensure project_state.yaml is set to blueprint_ready
  writeProjectState(tmpDir, {
    version: 1,
    project_id: "sample-mountain-reset",
    current_state: "blueprint_ready",
    history: [],
  });
  return tmpDir;
}

describe("/review command", () => {
  describe("compile preflight", () => {
    it("runs compile → preview (degraded) → QC and emits preflight artifacts", async () => {
      const tmpDir = createReviewReadyProject("compile-ok");
      const agent = createMockReviewAgent();

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
      });

      expect(result.success).toBe(true);
      expect(result.compileResult).toBeDefined();
      expect(result.preflight).toBeDefined();
      expect(result.compileResult!.outputPath).toContain("timeline.json");
      expect(fs.existsSync(path.join(tmpDir, "05_timeline/timeline.json"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "05_timeline/review-qc-summary.json"))).toBe(true);
      // Preview steps: compile, preview (skipped due to no source files), qc
      expect(result.preflight!.steps.map((step) => step.step)).toEqual(["compile", "preview", "qc"]);
      // No source files in test fixture → preview degrades gracefully
      expect(result.preflight!.steps[1].status).toBe("skipped");
      // Gap report contains overview and/or preview degradation messages
      const gapJoined = result.preflight!.gapReport.join(" ");
      expect(gapJoined).toContain("degraded");
    });

    it("skips preview with skipPreview option", async () => {
      const tmpDir = createReviewReadyProject("compile-skip-preview");
      const agent = createMockReviewAgent();

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
        skipPreview: true,
      });

      expect(result.success).toBe(true);
      expect(result.preflight).toBeDefined();
      expect(result.preflight!.steps.map((step) => step.step)).toEqual(["compile", "preview", "qc"]);
      expect(result.preflight!.steps[1].status).toBe("skipped");
      expect(result.preflight!.steps[1].detail).toContain("--skip-preview");
      expect(result.preflight!.gapReport[0]).toContain("skipped via --skip-preview");
    });

    it("fails when compile cannot run (missing blueprint)", async () => {
      const tmpDir = createMinimalProject("review-no-blueprint", {
        withBrief: true,
        withAnalysis: true,
        withSelects: true,
        state: "blueprint_ready",
      });
      // No edit_blueprint.yaml → reconcile self-heals to selects_ready → state check fails
      const agent = createMockReviewAgent();

      const result = await runReview(tmpDir, agent);

      expect(result.success).toBe(false);
      // State check fails because reconcile heals to selects_ready (no blueprint file)
      expect(result.error?.code).toBe("STATE_CHECK_FAILED");
    });
  });

  describe("gate checks", () => {
    it("fails when state is intent_pending", async () => {
      const tmpDir = createMinimalProject("review-bad-state", {
        state: "intent_pending",
      });
      const agent = createMockReviewAgent();

      const result = await runReview(tmpDir, agent);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("STATE_CHECK_FAILED");
    });

    it("fails when compile_gate is blocked (unresolved blockers)", async () => {
      const tmpDir = createReviewReadyProject("review-compile-blocked", {
        "01_intent/unresolved_blockers.yaml": {
          version: "1",
          project_id: "sample-mountain-reset",
          blockers: [
            {
              id: "BLK_001",
              question: "Should we include helicopter footage?",
              status: "blocker",
              why_it_matters: "Critical",
              allowed_temporary_assumption: null,
            },
          ],
        },
      });
      const agent = createMockReviewAgent();

      const result = await runReview(tmpDir, agent);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("STATE_CHECK_FAILED");
      expect(result.error?.message).toContain("current state is \"blocked\"");
    });

    it("fails when planning_gate is blocked (uncertainty blocker)", async () => {
      const tmpDir = createReviewReadyProject("review-planning-blocked", {
        "04_plan/uncertainty_register.yaml": {
          version: "1",
          project_id: "sample-mountain-reset",
          uncertainties: [
            {
              id: "UNC_001",
              question: "Music license?",
              status: "blocker",
              impact: "Cannot proceed",
            },
          ],
        },
      });
      const agent = createMockReviewAgent();

      const result = await runReview(tmpDir, agent);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("STATE_CHECK_FAILED");
      expect(result.error?.message).toContain("current state is \"blocked\"");
    });
  });

  describe("critique flow", () => {
    it("produces valid review_report.yaml and review_patch.json", async () => {
      const tmpDir = createReviewReadyProject("critique-ok");
      const agent = createMockReviewAgent();

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
      });

      expect(result.success).toBe(true);
      expect(result.report).toBeDefined();
      expect(result.patch).toBeDefined();

      // Verify artifacts exist
      expect(fs.existsSync(path.join(tmpDir, "06_review/review_report.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "06_review/review_patch.json"))).toBe(true);

      // Verify schema validity
      const reportRaw = fs.readFileSync(
        path.join(tmpDir, "06_review/review_report.yaml"),
        "utf-8",
      );
      const report = parseYaml(reportRaw);
      const reportValidator = createValidator("review-report.schema.json");
      expect(reportValidator(report)).toBe(true);

      const patchRaw = fs.readFileSync(
        path.join(tmpDir, "06_review/review_patch.json"),
        "utf-8",
      );
      const patch = JSON.parse(patchRaw);
      const patchValidator = createValidator("review-patch.schema.json");
      expect(patchValidator(patch)).toBe(true);
    });

    it("stays at critique_ready when no fatal_issues but operator has not accepted yet", async () => {
      const tmpDir = createReviewReadyProject("no-fatal");
      const agent = createMockReviewAgent(); // report has no fatal_issues

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("critique_ready");

      const doc = readProjectState(tmpDir)!;
      expect(doc.current_state).toBe("critique_ready");
      expect(doc.approval_record).toBeUndefined();
    });

    it("transitions to approved only after explicit operator acceptance", async () => {
      const tmpDir = createReviewReadyProject("clean-accepted");
      const agent = createMockReviewAgent();

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
        operatorAccept: async () => ({ accepted: true, approvedBy: "operator" }),
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("approved");

      const doc = readProjectState(tmpDir)!;
      expect(doc.current_state).toBe("approved");
      expect(doc.approval_record?.status).toBe("clean");
      expect(doc.approval_record?.approved_by).toBe("operator");
    });

    it("autonomy:full auto-approves clean review without operator acceptance", async () => {
      const tmpDir = createReviewReadyProject("clean-auto-full");
      const briefPath = path.join(tmpDir, "01_intent/creative_brief.yaml");
      const brief = parseYaml(fs.readFileSync(briefPath, "utf-8")) as {
        autonomy?: { mode?: "full" | "collaborative" };
      };
      brief.autonomy = {
        ...(brief.autonomy ?? {}),
        mode: "full",
      };
      fs.writeFileSync(briefPath, stringifyYaml(brief), "utf-8");

      let operatorAcceptCalled = false;
      const agent = createMockReviewAgent();
      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
        operatorAccept: async () => {
          operatorAcceptCalled = true;
          return { accepted: false };
        },
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("approved");
      expect(operatorAcceptCalled).toBe(false);

      const doc = readProjectState(tmpDir)!;
      expect(doc.current_state).toBe("approved");
      expect(doc.approval_record?.status).toBe("clean");
      expect(doc.approval_record?.approved_by).toBe("auto:full_autonomy");
    });

    it("transitions to critique_ready when fatal_issues exist", async () => {
      const tmpDir = createReviewReadyProject("with-fatal");
      const agent: ReviewAgent = {
        async run(ctx) {
          return {
            report: makeMockFatalReport(ctx.projectId),
            patch: makeMockReviewPatch(),
          };
        },
      };

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("critique_ready");

      const doc = readProjectState(tmpDir)!;
      expect(doc.current_state).toBe("critique_ready");
    });
  });

  describe("creative override", () => {
    it("transitions to approved with creative_override when fatal + override", async () => {
      const tmpDir = createReviewReadyProject("creative-override");
      const agent: ReviewAgent = {
        async run(ctx) {
          return {
            report: makeMockFatalReport(ctx.projectId),
            patch: makeMockReviewPatch(),
          };
        },
      };

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
        creativeOverride: true,
        approvedBy: "director",
        overrideReason: "Artistic choice — summit sequence not needed for this cut.",
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("approved");

      const doc = readProjectState(tmpDir)!;
      expect(doc.current_state).toBe("approved");
      expect(doc.approval_record).toBeDefined();
      expect(doc.approval_record!.status).toBe("creative_override");
      expect(doc.approval_record!.approved_by).toBe("director");
      expect(doc.approval_record!.override_reason).toContain("Artistic choice");
      expect(doc.approval_record!.artifact_versions).toBeDefined();
    });

    it("fails creative override without approved_by", async () => {
      const tmpDir = createReviewReadyProject("override-no-by");
      const agent: ReviewAgent = {
        async run(ctx) {
          return {
            report: makeMockFatalReport(ctx.projectId),
            patch: makeMockReviewPatch(),
          };
        },
      };

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
        creativeOverride: true,
        // Missing approvedBy and overrideReason
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("VALIDATION_FAILED");
      expect(result.error?.message).toContain("approved_by");
    });

    it("records approval_record.artifact_versions on clean approval", async () => {
      const tmpDir = createReviewReadyProject("approval-versions");
      const agent = createMockReviewAgent();

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
        operatorAccept: async () => ({ accepted: true, approvedBy: "operator" }),
      });

      expect(result.success).toBe(true);
      expect(result.approvalRecord).toBeDefined();
      expect(result.approvalRecord!.artifact_versions).toBeDefined();
      expect(result.approvalRecord!.artifact_versions!.timeline_version).toBeDefined();
      expect(result.approvalRecord!.artifact_versions!.review_report_version).toBeDefined();
      expect(result.approvalRecord!.artifact_versions!.review_patch_hash).toBeDefined();
    });
  });

  describe("patch safety guard", () => {
    it("accepts safe operations (trim, add_marker, etc.)", () => {
      const patch: ReviewPatch = {
        timeline_version: "1",
        operations: [
          { op: "trim_segment", target_clip_id: "CLP_0001", reason: "tighten" },
          { op: "add_marker", new_timeline_in_frame: 100, reason: "review point" },
          { op: "remove_segment", target_clip_id: "CLP_0003", reason: "redundant" },
          { op: "move_segment", target_clip_id: "CLP_0002", reason: "reorder" },
          { op: "change_audio_policy", target_clip_id: "CLP_0005", reason: "duck" },
          { op: "add_note", new_timeline_in_frame: 200, reason: "follow up" },
        ],
      };

      const timeline = {
        tracks: {
          video: [{ clips: [
            { clip_id: "CLP_0001", fallback_segment_ids: [] },
            { clip_id: "CLP_0002", fallback_segment_ids: [] },
            { clip_id: "CLP_0003", fallback_segment_ids: [] },
          ] }],
          audio: [{ clips: [
            { clip_id: "CLP_0005", fallback_segment_ids: [] },
          ] }],
        },
      };

      const result = validatePatchSafety(patch, timeline, null);
      expect(result.safe).toBe(true);
      expect(result.rejectedOps).toHaveLength(0);
      expect(result.filteredPatch.operations).toHaveLength(6);
    });

    it("rejects replace_segment when source not in fallback or human notes", () => {
      const patch: ReviewPatch = {
        timeline_version: "1",
        operations: [
          {
            op: "replace_segment",
            target_clip_id: "CLP_0001",
            with_segment_id: "SEG_UNSAFE",
            reason: "swap",
          },
        ],
      };

      const timeline = {
        tracks: {
          video: [{ clips: [
            { clip_id: "CLP_0001", fallback_segment_ids: ["SEG_SAFE_A", "SEG_SAFE_B"] },
          ] }],
          audio: [],
        },
      };

      const result = validatePatchSafety(patch, timeline, null);
      expect(result.safe).toBe(false);
      expect(result.rejectedOps).toHaveLength(1);
      expect(result.rejectedOps[0].op).toBe("replace_segment");
      expect(result.filteredPatch.operations).toHaveLength(0);
    });

    it("accepts replace_segment when source is in fallback_segment_ids", () => {
      const patch: ReviewPatch = {
        timeline_version: "1",
        operations: [
          {
            op: "replace_segment",
            target_clip_id: "CLP_0001",
            with_segment_id: "SEG_SAFE_A",
            reason: "swap",
          },
        ],
      };

      const timeline = {
        tracks: {
          video: [{ clips: [
            { clip_id: "CLP_0001", fallback_segment_ids: ["SEG_SAFE_A", "SEG_SAFE_B"] },
          ] }],
          audio: [],
        },
      };

      const result = validatePatchSafety(patch, timeline, null);
      expect(result.safe).toBe(true);
      expect(result.filteredPatch.operations).toHaveLength(1);
    });

    it("accepts replace_segment when source is in human_notes approved_segment_ids", () => {
      const patch: ReviewPatch = {
        timeline_version: "1",
        operations: [
          {
            op: "replace_segment",
            target_clip_id: "CLP_0001",
            with_segment_id: "SEG_HUMAN_OK",
            reason: "human approved swap",
          },
        ],
      };

      const timeline = {
        tracks: {
          video: [{ clips: [
            { clip_id: "CLP_0001", fallback_segment_ids: [] },
          ] }],
          audio: [],
        },
      };

      const humanNotes: HumanNotes = {
        version: "1",
        project_id: "test",
        notes: [
          {
            id: "HN_001",
            timestamp: "2026-03-21T04:00:00Z",
            reviewer: "director",
            observation: "Replace CLP_0001 with the strap-tightening shot.",
            severity: "suggestion",
            directive_type: "replace_segment",
            clip_ids: ["CLP_0001"],
            approved_segment_ids: ["SEG_HUMAN_OK"],
          },
        ],
      };

      const result = validatePatchSafety(patch, timeline, humanNotes);
      expect(result.safe).toBe(true);
      expect(result.filteredPatch.operations).toHaveLength(1);
    });

    it("rejects insert_segment without human directive + anchor", () => {
      const patch: ReviewPatch = {
        timeline_version: "1",
        operations: [
          {
            op: "insert_segment",
            with_segment_id: "SEG_INSERT",
            new_timeline_in_frame: 100,
            reason: "add b-roll",
          },
        ],
      };

      const timeline = { tracks: { video: [], audio: [] } };

      const result = validatePatchSafety(patch, timeline, null);
      expect(result.safe).toBe(false);
      expect(result.rejectedOps).toHaveLength(1);
      expect(result.rejectedOps[0].op).toBe("insert_segment");
    });

    it("accepts insert_segment with human directive + anchor", () => {
      const patch: ReviewPatch = {
        timeline_version: "1",
        operations: [
          {
            op: "insert_segment",
            with_segment_id: "SEG_INSERT",
            new_timeline_in_frame: 100,
            reason: "add b-roll per director note",
          },
        ],
      };

      const timeline = { tracks: { video: [], audio: [] } };

      const humanNotes: HumanNotes = {
        version: "1",
        project_id: "test",
        notes: [
          {
            id: "HN_002",
            timestamp: "2026-03-21T04:00:00Z",
            reviewer: "director",
            observation: "Insert strap-tightening at frame 100.",
            severity: "suggestion",
            directive_type: "insert_segment",
            approved_segment_ids: ["SEG_INSERT"],
            timeline_in_frame: 100,
          },
        ],
      };

      const result = validatePatchSafety(patch, timeline, humanNotes);
      expect(result.safe).toBe(true);
      expect(result.filteredPatch.operations).toHaveLength(1);
    });

    it("rejects insert_segment when human directive exists but anchor does not match", () => {
      const patch: ReviewPatch = {
        timeline_version: "1",
        operations: [
          {
            op: "insert_segment",
            with_segment_id: "SEG_INSERT",
            new_timeline_in_frame: 120,
            reason: "insert at wrong frame",
          },
        ],
      };

      const humanNotes: HumanNotes = {
        version: "1",
        project_id: "test",
        notes: [
          {
            id: "HN_003",
            timestamp: "2026-03-21T04:00:00Z",
            reviewer: "director",
            observation: "Insert strap-tightening at frame 100.",
            severity: "suggestion",
            directive_type: "insert_segment",
            approved_segment_ids: ["SEG_INSERT"],
            timeline_in_frame: 100,
          },
        ],
      };

      const result = validatePatchSafety(patch, { tracks: { video: [], audio: [] } }, humanNotes);
      expect(result.safe).toBe(false);
      expect(result.rejectedOps).toHaveLength(1);
      expect(result.rejectedOps[0].reason).toContain("machine-readable timeline anchor");
    });

    it("filters unsafe ops and keeps safe ops in mixed patch", () => {
      const patch: ReviewPatch = {
        timeline_version: "1",
        operations: [
          { op: "trim_segment", target_clip_id: "CLP_0001", reason: "safe trim" },
          {
            op: "replace_segment",
            target_clip_id: "CLP_0001",
            with_segment_id: "SEG_UNSAFE",
            reason: "unsafe replace",
          },
          { op: "add_marker", new_timeline_in_frame: 50, reason: "safe marker" },
        ],
      };

      const timeline = {
        tracks: {
          video: [{ clips: [
            { clip_id: "CLP_0001", fallback_segment_ids: [] },
          ] }],
          audio: [],
        },
      };

      const result = validatePatchSafety(patch, timeline, null);
      expect(result.safe).toBe(false);
      expect(result.rejectedOps).toHaveLength(1);
      expect(result.filteredPatch.operations).toHaveLength(2);
      expect(result.filteredPatch.operations[0].op).toBe("trim_segment");
      expect(result.filteredPatch.operations[1].op).toBe("add_marker");
    });
  });

  describe("human_notes integration", () => {
    it("reads human_notes.yaml when present and passes to agent", async () => {
      const humanNotes: HumanNotes = {
        version: "1",
        project_id: "sample-mountain-reset",
        notes: [
          {
            id: "HN_001",
            timestamp: "2026-03-21T04:00:00Z",
            reviewer: "director",
            observation: "The hook feels too slow, tighten it.",
            severity: "concern",
            directive_type: "trim_segment",
            clip_ids: ["CLP_0001"],
          },
        ],
      };

      const tmpDir = createReviewReadyProject("human-notes", {
        "06_review/human_notes.yaml": humanNotes,
      });

      let receivedNotes: HumanNotes | null = null;
      const agent: ReviewAgent = {
        async run(ctx) {
          receivedNotes = ctx.humanNotes;
          return {
            report: makeMockReviewReport(ctx.projectId),
            patch: makeMockReviewPatch(),
          };
        },
      };

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
      });

      expect(result.success).toBe(true);
      expect(receivedNotes).not.toBeNull();
      expect(receivedNotes!.notes).toHaveLength(1);
      expect(receivedNotes!.notes[0].reviewer).toBe("director");
    });

    it("passes null humanNotes when file is absent", async () => {
      const tmpDir = createReviewReadyProject("no-human-notes");

      let receivedNotes: HumanNotes | null | undefined = undefined;
      const agent: ReviewAgent = {
        async run(ctx) {
          receivedNotes = ctx.humanNotes;
          return {
            report: makeMockReviewReport(ctx.projectId),
            patch: makeMockReviewPatch(),
          };
        },
      };

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
      });

      expect(result.success).toBe(true);
      expect(receivedNotes).toBeNull();
    });

    it("fails explicitly when human_notes.yaml is malformed", async () => {
      const tmpDir = createReviewReadyProject("bad-human-notes-parse", {
        "06_review/human_notes.yaml": "version: 1\nproject_id: bad\nnotes: [\n",
      });

      const result = await runReview(tmpDir, createMockReviewAgent(), {
        createdAt: "2026-03-21T05:00:00Z",
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("VALIDATION_FAILED");
      expect(result.error?.message).toContain("Failed to parse human_notes.yaml");
    });

    it("fails explicitly when human_notes.yaml violates schema", async () => {
      const tmpDir = createReviewReadyProject("bad-human-notes-schema", {
        "06_review/human_notes.yaml": {
          version: "1",
          project_id: "sample-mountain-reset",
          notes: [
            {
              id: "HN_BAD",
              reviewer: "director",
              observation: "Missing timestamp and severity",
            },
          ],
        },
      });

      const result = await runReview(tmpDir, createMockReviewAgent(), {
        createdAt: "2026-03-21T05:00:00Z",
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("VALIDATION_FAILED");
      expect(result.error?.message).toContain("human_notes.yaml failed schema validation");
    });

    it("passes STYLE.md content to agent when present", async () => {
      const tmpDir = createReviewReadyProject("style-md", {
        "STYLE.md": "# Style Guide\nFavor warm tones and measured pacing.",
      });

      let receivedStyle: string | null = null;
      const agent: ReviewAgent = {
        async run(ctx) {
          receivedStyle = ctx.styleMd;
          return {
            report: makeMockReviewReport(ctx.projectId),
            patch: makeMockReviewPatch(),
          };
        },
      };

      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
      });

      expect(result.success).toBe(true);
      expect(receivedStyle).toContain("warm tones");
    });
  });

  describe("history and metadata", () => {
    it("records history entry on transition to approved", async () => {
      const tmpDir = createReviewReadyProject("history-approved");
      const agent = createMockReviewAgent();

      await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
        operatorAccept: async () => ({ accepted: true, approvedBy: "operator" }),
      });

      const doc = readProjectState(tmpDir)!;
      const reviewEntries = doc.history!.filter((h) => h.trigger === "/review");
      expect(reviewEntries.length).toBeGreaterThan(0);
      expect(reviewEntries[reviewEntries.length - 1].to_state).toBe("approved");
    });

    it("records history entry on transition to critique_ready", async () => {
      const tmpDir = createReviewReadyProject("history-critique");
      const agent: ReviewAgent = {
        async run(ctx) {
          return {
            report: makeMockFatalReport(ctx.projectId),
            patch: makeMockReviewPatch(),
          };
        },
      };

      await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
      });

      const doc = readProjectState(tmpDir)!;
      const reviewEntries = doc.history!.filter((h) => h.trigger === "/review");
      expect(reviewEntries.length).toBeGreaterThan(0);
      expect(reviewEntries[reviewEntries.length - 1].to_state).toBe("critique_ready");
    });

    it("sets last_agent and last_command", async () => {
      const tmpDir = createReviewReadyProject("meta");
      const agent = createMockReviewAgent();

      await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
      });

      const doc = readProjectState(tmpDir)!;
      expect(doc.last_agent).toBe("roughcut-critic");
      expect(doc.last_command).toBe("/review");
    });
  });

  describe("re-review from critique_ready", () => {
    it("can re-run from critique_ready state", async () => {
      const tmpDir = createReviewReadyProject("re-review");

      // First review → critique_ready (fatal)
      const fatalAgent: ReviewAgent = {
        async run(ctx) {
          return {
            report: makeMockFatalReport(ctx.projectId),
            patch: makeMockReviewPatch(),
          };
        },
      };

      const first = await runReview(tmpDir, fatalAgent, {
        createdAt: "2026-03-21T05:00:00Z",
      });
      expect(first.success).toBe(true);
      expect(first.newState).toBe("critique_ready");

      // Second review from critique_ready → approved (no fatal + operator accept)
      const agent = createMockReviewAgent();
      const second = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T06:00:00Z",
        operatorAccept: async () => ({ accepted: true, approvedBy: "operator" }),
      });
      expect(second.success).toBe(true);
      expect(second.newState).toBe("approved");
    });
  });

  describe("re-review from timeline_drafted", () => {
    it("can run from timeline_drafted state", async () => {
      const tmpDir = createReviewReadyProject("from-timeline-drafted");
      // Set state to timeline_drafted
      writeProjectState(tmpDir, {
        version: 1,
        project_id: "sample-mountain-reset",
        current_state: "timeline_drafted",
        history: [],
      });

      const agent = createMockReviewAgent();
      const result = await runReview(tmpDir, agent, {
        createdAt: "2026-03-21T05:00:00Z",
        operatorAccept: async () => ({ accepted: true, approvedBy: "operator" }),
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("approved");
    });
  });
});
