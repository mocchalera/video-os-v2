/**
 * M3 E2E Test — Full Command Flow
 *
 * Exercises the complete M3 editorial loop using mock agents:
 *   /intent → /triage → /blueprint → /review → /export
 *
 * Verifications:
 * - State transitions follow the state machine
 * - All artifacts are schema-valid
 * - Export manifest is correct
 * - /status returns correct recommendations at each stage
 * - project_state.yaml history records all transitions
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createRequire } from "node:module";

import { writeProjectState, readProjectState, type ProjectStateDoc } from "../runtime/state/reconcile.js";
import { runIntent, type IntentAgent } from "../runtime/commands/intent.js";
import { runTriage, type TriageAgent } from "../runtime/commands/triage.js";
import { runBlueprint, type BlueprintAgent, type EditBlueprint, type UncertaintyRegister } from "../runtime/commands/blueprint.js";
import { runReview, type ReviewAgent, type ReviewReport, type ReviewPatch } from "../runtime/commands/review.js";
import { runStatus } from "../runtime/commands/status.js";
import { runExport } from "../runtime/commands/export.js";

// ── AJV setup ────────────────────────────────────────────────────

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

const tempDirs: string[] = [];
const SAMPLE_PROJECT = "projects/sample";

afterAll(() => {
  for (const d of tempDirs) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

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

/**
 * Creates a fresh project with analysis artifacts pre-populated
 * (simulating M2 pipeline completion) and state at media_analyzed.
 */
function createE2EProject(name: string): string {
  const tmpDir = path.resolve(`test-fixtures-e2e-m3-${name}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Pre-populate a schema-valid M2 analysis fixture.
  copyDirSync(
    path.resolve(SAMPLE_PROJECT, "03_analysis"),
    path.join(tmpDir, "03_analysis"),
  );

  // Initialize project_state.yaml at intent_pending
  // (reconcile will self-heal to media_analyzed because analysis exists)
  const stateDoc: ProjectStateDoc = {
    version: 1,
    project_id: "e2e-test",
    current_state: "intent_pending",
    history: [],
  };
  writeProjectState(tmpDir, stateDoc);

  tempDirs.push(tmpDir);
  return tmpDir;
}

// ── Mock Agent Factories ─────────────────────────────────────────

function createE2EIntentAgent(): IntentAgent {
  return {
    async run(ctx) {
      return {
        brief: {
          project_id: ctx.projectId,
          project: {
            id: ctx.projectId,
            title: "E2E Test Film",
            strategy: "Short documentary about morning mountain ritual",
            runtime_target_sec: 30,
          },
          message: {
            primary: "Stillness is its own kind of strength",
          },
          audience: {
            primary: "Outdoor enthusiasts aged 25-45",
          },
          emotion_curve: ["curiosity", "grounding", "warmth"],
          must_have: ["morning light", "hands detail"],
          must_avoid: ["triumphal framing"],
          autonomy: {
            mode: "full" as const,
            may_decide: ["pacing", "b-roll choice"],
            must_ask: ["final line replacement"],
          },
          resolved_assumptions: ["All footage is 4K"],
        },
        blockers: {
          version: "1",
          project_id: ctx.projectId,
          blockers: [
            {
              id: "BLK_001",
              question: "Music rights confirmed?",
              status: "hypothesis" as const,
              why_it_matters: "Determines if we can use licensed track",
              allowed_temporary_assumption: "Use library music as fallback",
            },
          ],
        },
        confirmed: true,
      };
    },
  };
}

function createE2ETriageAgent(): TriageAgent {
  return {
    async run(ctx) {
      return {
        selects: {
          version: "1",
          project_id: ctx.projectId,
          candidates: [
            {
              segment_id: "SEG_0001",
              asset_id: "AST_001",
              src_in_us: 0,
              src_out_us: 5000000,
              role: "hero" as const,
              why_it_matches: "Morning hands detail — establishes intimate ritual",
              risks: [],
              confidence: 0.92,
              evidence: ["visual_tag: hands"],
              eligible_beats: ["B01"],
            },
            {
              segment_id: "SEG_0002",
              asset_id: "AST_001",
              src_in_us: 5000000,
              src_out_us: 10000000,
              role: "dialogue" as const,
              why_it_matches: "Spoken thesis about stillness",
              risks: [],
              confidence: 0.95,
              evidence: ["transcript"],
              eligible_beats: ["B02"],
            },
            {
              segment_id: "SEG_0003",
              asset_id: "AST_001",
              src_in_us: 10000000,
              src_out_us: 15000000,
              role: "support" as const,
              why_it_matches: "Trail movement builds forward motion",
              risks: ["slight wind"],
              confidence: 0.85,
              evidence: ["contact_sheet"],
              eligible_beats: ["B02", "B03"],
            },
            {
              segment_id: "SEG_0004",
              asset_id: "AST_001",
              src_in_us: 15000000,
              src_out_us: 20000000,
              role: "texture" as const,
              why_it_matches: "Breath and release for ending",
              risks: [],
              confidence: 0.88,
              evidence: ["visual_tag: breath"],
              eligible_beats: ["B03"],
            },
          ],
        },
        confirmed: true,
      };
    },
  };
}

function createE2EBlueprintAgent(): BlueprintAgent {
  return {
    async run(ctx) {
      const blueprint: EditBlueprint = {
        sequence_goals: ["Open on tactile ritual", "Build grounding", "Resolve with warmth"],
        beats: [
          {
            id: "B01",
            label: "hook",
            purpose: "Establish intimate morning detail",
            target_duration_frames: 96,
            required_roles: ["hero", "texture"],
          },
          {
            id: "B02",
            label: "settle",
            purpose: "Connect ritual to spoken articulation",
            target_duration_frames: 216,
            required_roles: ["support", "dialogue"],
          },
          {
            id: "B03",
            label: "release",
            purpose: "Land the message with calm release",
            target_duration_frames: 168,
            required_roles: ["hero", "texture"],
          },
        ],
        pacing: {
          opening_cadence: "brisk",
          middle_cadence: "spacious",
          ending_cadence: "warm",
          confirmed_preferences: {
            mode: "full",
            source: "ai_autonomous",
            duration_target_sec: 30,
            confirmed_at: "2026-03-21T10:00:00Z",
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
          should_feel: "restorative stillness",
        },
        rejection_rules: ["No footage below 1080p"],
      };

      const uncertaintyRegister: UncertaintyRegister = {
        version: "1",
        project_id: ctx.projectId,
        uncertainties: [
          {
            id: "UNC_001",
            type: "coverage",
            question: "Is 4 segments enough for 3 beats?",
            status: "open",
            evidence: ["only 4 candidate segments"],
            alternatives: [
              { label: "Extend segments", description: "Use longer duration from existing" },
            ],
            escalation_required: false,
          },
        ],
      };

      return {
        blueprint,
        uncertaintyRegister,
        confirmed: true,
      };
    },
  };
}

function createE2EReviewAgent(opts?: { withFatal?: boolean }): ReviewAgent {
  return {
    async run(ctx) {
      const report: ReviewReport = {
        version: "1",
        project_id: ctx.projectId,
        timeline_version: ctx.timelineVersion,
        summary_judgment: {
          status: opts?.withFatal ? "blocked" : "needs_revision",
          rationale: opts?.withFatal
            ? "Critical brief requirement missing."
            : "Solid structure; minor trim and wind issues.",
          confidence: 0.82,
        },
        strengths: [
          { summary: "Beat boundaries are well-placed." },
        ],
        weaknesses: [
          { summary: "Hook hero has minor highlight clipping.", affected_clip_ids: ["CLP_0001"] },
        ],
        fatal_issues: opts?.withFatal
          ? [{
              summary: "Must-have 'morning light' is missing from timeline.",
              severity: "fatal" as const,
              evidence: ["brief.must_have[0]"],
            }]
          : [],
        warnings: [
          { summary: "Wind quality flag in B03.", severity: "warning" as const },
        ],
        mismatches_to_brief: [],
        mismatches_to_blueprint: [],
        recommended_next_pass: {
          goal: "Tighten hook and review wind.",
          actions: ["Trim CLP_0001", "Check wind in B03"],
        },
      };

      const patch: ReviewPatch = {
        timeline_version: ctx.timelineVersion,
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
            new_timeline_in_frame: 120,
            reason: "Audio QA for wind in B03",
            confidence: 0.9,
          },
        ],
      };

      return { report, patch };
    },
  };
}

// ══════════════════════════════════════════════════════════════════
// M3 E2E: Full Command Flow (happy path — approved)
// ══════════════════════════════════════════════════════════════════

describe("M3 E2E: full command flow", () => {
  it("runs intent → triage → blueprint → review → export and reaches approved", async () => {
    const projectDir = createE2EProject("happy-path");

    // ── Step 0: /status at initial state ──────────────────────
    const status0 = runStatus(projectDir);
    expect(status0.success).toBe(true);
    // With analysis artifacts present, reconcile should self-heal
    // past intent_pending. The exact state depends on what artifacts exist.
    // At minimum, analysis is detected.

    // ── Step 1: /intent ──────────────────────────────────────
    const intentResult = await runIntent(projectDir, createE2EIntentAgent());
    expect(intentResult.success).toBe(true);
    expect(intentResult.newState).toBe("intent_locked");

    // Verify brief schema
    const briefPath = path.join(projectDir, "01_intent/creative_brief.yaml");
    expect(fs.existsSync(briefPath)).toBe(true);
    const briefData = parseYaml(fs.readFileSync(briefPath, "utf-8"));
    const briefValidator = createValidator("creative-brief.schema.json");
    expect(briefValidator(briefData)).toBe(true);

    // Verify blockers schema
    const blockersPath = path.join(projectDir, "01_intent/unresolved_blockers.yaml");
    expect(fs.existsSync(blockersPath)).toBe(true);
    const blockersData = parseYaml(fs.readFileSync(blockersPath, "utf-8"));
    const blockersValidator = createValidator("unresolved-blockers.schema.json");
    expect(blockersValidator(blockersData)).toBe(true);

    // /status after intent
    const status1 = runStatus(projectDir);
    expect(status1.success).toBe(true);
    // After intent with analysis present, reconcile should detect media_analyzed
    expect(["media_analyzed", "intent_locked"]).toContain(status1.currentState);

    // ── Step 2: /triage ──────────────────────────────────────
    // After /intent, reconcile detects analysis → media_analyzed
    const triageResult = await runTriage(projectDir, createE2ETriageAgent());
    expect(triageResult.success).toBe(true);
    expect(triageResult.newState).toBe("selects_ready");

    // Verify selects schema
    const selectsPath = path.join(projectDir, "04_plan/selects_candidates.yaml");
    expect(fs.existsSync(selectsPath)).toBe(true);
    const selectsData = parseYaml(fs.readFileSync(selectsPath, "utf-8"));
    const selectsValidator = createValidator("selects-candidates.schema.json");
    expect(selectsValidator(selectsData)).toBe(true);

    // /status after triage
    const status2 = runStatus(projectDir);
    expect(status2.success).toBe(true);
    expect(status2.currentState).toBe("selects_ready");
    expect(status2.nextCommand).toBe("/blueprint");

    // ── Step 3: /blueprint ───────────────────────────────────
    const blueprintResult = await runBlueprint(projectDir, createE2EBlueprintAgent(), { iterativeEngine: false });
    expect(blueprintResult.success).toBe(true);
    expect(blueprintResult.newState).toBe("blueprint_ready");
    expect(blueprintResult.planningBlocked).toBe(false);

    // Verify blueprint schema
    const blueprintPath = path.join(projectDir, "04_plan/edit_blueprint.yaml");
    expect(fs.existsSync(blueprintPath)).toBe(true);
    const blueprintData = parseYaml(fs.readFileSync(blueprintPath, "utf-8"));
    const blueprintValidator = createValidator("edit-blueprint.schema.json");
    expect(blueprintValidator(blueprintData)).toBe(true);

    // Verify uncertainty register schema
    const uncPath = path.join(projectDir, "04_plan/uncertainty_register.yaml");
    expect(fs.existsSync(uncPath)).toBe(true);
    const uncData = parseYaml(fs.readFileSync(uncPath, "utf-8"));
    const uncValidator = createValidator("uncertainty-register.schema.json");
    expect(uncValidator(uncData)).toBe(true);

    // /status after blueprint
    const status3 = runStatus(projectDir);
    expect(status3.success).toBe(true);
    expect(status3.currentState).toBe("blueprint_ready");
    expect(status3.nextCommand).toBe("/review");

    // ── Step 4: /review (no fatal issues → approved) ─────────
    const reviewResult = await runReview(
      projectDir,
      createE2EReviewAgent({ withFatal: false }),
      {
        createdAt: "2026-03-21T12:00:00Z",
        operatorAccept: async () => ({ accepted: true, approvedBy: "operator@e2e" }),
      },
    );
    expect(reviewResult.success).toBe(true);
    expect(reviewResult.newState).toBe("approved");
    expect(reviewResult.approvalRecord).toBeDefined();
    expect(reviewResult.approvalRecord!.status).toBe("clean");

    // Verify review report schema
    const reportPath = path.join(projectDir, "06_review/review_report.yaml");
    expect(fs.existsSync(reportPath)).toBe(true);
    const reportData = parseYaml(fs.readFileSync(reportPath, "utf-8"));
    const reportValidator = createValidator("review-report.schema.json");
    expect(reportValidator(reportData)).toBe(true);

    // Verify review patch schema
    const patchPath = path.join(projectDir, "06_review/review_patch.json");
    expect(fs.existsSync(patchPath)).toBe(true);
    const patchData = JSON.parse(fs.readFileSync(patchPath, "utf-8"));
    const patchValidator = createValidator("review-patch.schema.json");
    expect(patchValidator(patchData)).toBe(true);

    // Verify timeline was compiled (existence + basic structure;
    // full schema is validated in M1 compiler tests)
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    expect(fs.existsSync(timelinePath)).toBe(true);
    const timelineData = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
    expect(timelineData.version).toBeDefined();
    expect(timelineData.tracks).toBeDefined();

    // /status after review
    const status4 = runStatus(projectDir);
    expect(status4.success).toBe(true);
    expect(status4.currentState).toBe("approved");
    expect(status4.nextCommand).toBe("/export");

    // ── Step 5: /export ──────────────────────────────────────
    const exportResult = runExport(projectDir, {
      exportedAt: "2026-03-21T13:00:00Z",
    });
    expect(exportResult.success).toBe(true);
    expect(exportResult.manifest).toBeDefined();

    const manifest = exportResult.manifest!;
    expect(manifest.project_id).toBe("e2e-test");
    expect(manifest.current_state).toBe("approved");
    expect(manifest.approval_status).toBe("clean");
    expect(manifest.analysis_override_status).toBe("clean");
    expect(manifest.exported_at).toBe("2026-03-21T13:00:00Z");
    expect(manifest.included_files.length).toBeGreaterThanOrEqual(3); // timeline, report, patch

    // Verify manifest was written
    const manifestPath = path.join(projectDir, "07_export/export_manifest.yaml");
    expect(fs.existsSync(manifestPath)).toBe(true);

    // Verify state did NOT change after export
    const status5 = runStatus(projectDir);
    expect(status5.currentState).toBe("approved");

    // ── Verify full history ──────────────────────────────────
    const finalDoc = readProjectState(projectDir)!;
    expect(finalDoc.history).toBeDefined();
    const history = finalDoc.history!;

    // History should record all transitions
    const transitions = history.map((h) => `${h.from_state}→${h.to_state}`);
    // The exact initial state after reconcile varies, but we expect at least
    // these key transitions in order:
    expect(transitions).toContain("intent_pending→intent_locked"); // first reconcile self-heal may prepend entries
    expect(transitions).toContain("media_analyzed→selects_ready");
    expect(transitions).toContain("selects_ready→blueprint_ready");

    // The final two transitions should be blueprint_ready→approved
    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition).toBe("blueprint_ready→approved");

    // Verify triggers are recorded
    const triggerSet = new Set(history.map((h) => h.trigger));
    expect(triggerSet.has("/intent")).toBe(true);
    expect(triggerSet.has("/triage")).toBe(true);
    expect(triggerSet.has("/blueprint")).toBe(true);
    expect(triggerSet.has("/review")).toBe(true);
  }, 180_000);
});

// ══════════════════════════════════════════════════════════════════
// M3 E2E: Fatal issues → critique_ready
// ══════════════════════════════════════════════════════════════════

describe("M3 E2E: fatal issues path", () => {
  it("review with fatal issues → critique_ready, then export succeeds", async () => {
    const projectDir = createE2EProject("fatal-path");

    // Fast-forward: intent → triage → blueprint
    await runIntent(projectDir, createE2EIntentAgent());
    await runTriage(projectDir, createE2ETriageAgent());
    await runBlueprint(projectDir, createE2EBlueprintAgent(), { iterativeEngine: false });

    // Review with fatal issues
    const reviewResult = await runReview(
      projectDir,
      createE2EReviewAgent({ withFatal: true }),
      { createdAt: "2026-03-21T12:00:00Z" },
    );
    expect(reviewResult.success).toBe(true);
    expect(reviewResult.newState).toBe("critique_ready");

    // /status at critique_ready
    const status = runStatus(projectDir);
    expect(status.currentState).toBe("critique_ready");
    expect(status.nextCommand).toBe("/export or apply patch");

    // /export should work from critique_ready
    const exportResult = runExport(projectDir, {
      exportedAt: "2026-03-21T13:00:00Z",
    });
    expect(exportResult.success).toBe(true);
    expect(exportResult.manifest!.current_state).toBe("critique_ready");
    expect(exportResult.manifest!.approval_status).toBe("pending");

    // State unchanged
    const postExportStatus = runStatus(projectDir);
    expect(postExportStatus.currentState).toBe("critique_ready");
  }, 180_000);
});

// ══════════════════════════════════════════════════════════════════
// M3 E2E: Creative override → approved
// ══════════════════════════════════════════════════════════════════

describe("M3 E2E: creative override path", () => {
  it("review with fatal + creative override → approved", async () => {
    const projectDir = createE2EProject("override-path");

    // Fast-forward: intent → triage → blueprint
    await runIntent(projectDir, createE2EIntentAgent());
    await runTriage(projectDir, createE2ETriageAgent());
    await runBlueprint(projectDir, createE2EBlueprintAgent(), { iterativeEngine: false });

    // Review with fatal issues but creative override
    const reviewResult = await runReview(
      projectDir,
      createE2EReviewAgent({ withFatal: true }),
      {
        createdAt: "2026-03-21T12:00:00Z",
        creativeOverride: true,
        approvedBy: "operator@e2e",
        overrideReason: "Client signed off on missing morning light",
      },
    );
    expect(reviewResult.success).toBe(true);
    expect(reviewResult.newState).toBe("approved");
    expect(reviewResult.approvalRecord).toBeDefined();
    expect(reviewResult.approvalRecord!.status).toBe("creative_override");

    // Export should show creative_override
    const exportResult = runExport(projectDir, {
      exportedAt: "2026-03-21T13:00:00Z",
    });
    expect(exportResult.success).toBe(true);
    expect(exportResult.manifest!.approval_status).toBe("creative_override");

    // Verify history records the override
    const doc = readProjectState(projectDir)!;
    const overrideEntry = doc.history!.find((h) =>
      h.note?.includes("creative override"),
    );
    expect(overrideEntry).toBeDefined();
  }, 180_000);
});

// ══════════════════════════════════════════════════════════════════
// /export command unit tests
// ══════════════════════════════════════════════════════════════════

describe("/export command", () => {
  it("rejects from invalid state (intent_pending)", () => {
    const tmpDir = path.resolve(`test-fixtures-e2e-m3-export-bad-state-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    writeProjectState(tmpDir, {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    });
    tempDirs.push(tmpDir);

    const result = runExport(tmpDir);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("STATE_CHECK_FAILED");
  });

  it("rejects from blueprint_ready", () => {
    const tmpDir = path.resolve(`test-fixtures-e2e-m3-export-blueprint-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Need brief + selects + blueprint for reconcile to confirm blueprint_ready
    fs.mkdirSync(path.join(tmpDir, "01_intent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/creative_brief.yaml"),
      stringifyYaml({
        project: { title: "T", strategy: "S", runtime_target_sec: 10 },
        message: { primary: "P" },
        audience: { primary: "A" },
        emotion_curve: ["x"],
        must_have: ["y"],
        must_avoid: ["z"],
        autonomy: { may_decide: [], must_ask: [] },
        resolved_assumptions: [],
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/unresolved_blockers.yaml"),
      stringifyYaml({ version: "1", project_id: "test", blockers: [] }),
      "utf-8",
    );
    fs.mkdirSync(path.join(tmpDir, "04_plan"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "04_plan/selects_candidates.yaml"),
      stringifyYaml({
        version: "1",
        project_id: "test",
        candidates: [{
          segment_id: "S1", asset_id: "A1", src_in_us: 0, src_out_us: 1000000,
          role: "hero", why_it_matches: "x", risks: [], confidence: 0.9,
        }],
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "04_plan/edit_blueprint.yaml"),
      stringifyYaml({
        sequence_goals: ["x"],
        beats: [{ id: "B1", label: "b1", target_duration_frames: 72, required_roles: ["hero"] }],
        pacing: { opening_cadence: "x", middle_cadence: "x", ending_cadence: "x" },
        music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "B1" },
        dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
        transition_policy: { prefer_match_texture_over_flashy_fx: true },
        ending_policy: { should_feel: "calm" },
        rejection_rules: [],
      }),
      "utf-8",
    );

    writeProjectState(tmpDir, {
      version: 1,
      project_id: "test",
      current_state: "blueprint_ready",
      history: [],
    });
    tempDirs.push(tmpDir);

    const result = runExport(tmpDir);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("STATE_CHECK_FAILED");
  });

  it("includes STYLE.md in bundle when present", async () => {
    const projectDir = createE2EProject("export-with-style");

    // Write STYLE.md
    fs.writeFileSync(
      path.join(projectDir, "STYLE.md"),
      "# Style\n\nBrisk pacing, warm earth tones.\n",
      "utf-8",
    );

    // Fast-forward to approved
    await runIntent(projectDir, createE2EIntentAgent());
    await runTriage(projectDir, createE2ETriageAgent());
    await runBlueprint(projectDir, createE2EBlueprintAgent(), { iterativeEngine: false });
    await runReview(
      projectDir,
      createE2EReviewAgent(),
      {
        createdAt: "2026-03-21T12:00:00Z",
        operatorAccept: async () => ({ accepted: true, approvedBy: "operator@e2e" }),
      },
    );

    const result = runExport(projectDir, {
      exportedAt: "2026-03-21T13:00:00Z",
    });
    expect(result.success).toBe(true);

    // STYLE.md should be in included_files
    const stylePaths = result.manifest!.included_files.filter(
      (f) => f.path === "STYLE.md",
    );
    expect(stylePaths).toHaveLength(1);
    expect(stylePaths[0].size_bytes).toBeGreaterThan(0);
  }, 180_000);

  it("does not change state (read-only)", async () => {
    const projectDir = createE2EProject("export-readonly");

    // Fast-forward to approved
    await runIntent(projectDir, createE2EIntentAgent());
    await runTriage(projectDir, createE2ETriageAgent());
    await runBlueprint(projectDir, createE2EBlueprintAgent(), { iterativeEngine: false });
    await runReview(
      projectDir,
      createE2EReviewAgent(),
      {
        createdAt: "2026-03-21T12:00:00Z",
        operatorAccept: async () => ({ accepted: true, approvedBy: "operator@e2e" }),
      },
    );

    const beforeDoc = readProjectState(projectDir)!;
    const beforeHistoryLen = beforeDoc.history?.length ?? 0;

    runExport(projectDir, { exportedAt: "2026-03-21T13:00:00Z" });

    const afterDoc = readProjectState(projectDir)!;
    expect(afterDoc.current_state).toBe("approved");
    // History should not grow (no state transition in export)
    expect(afterDoc.history?.length ?? 0).toBe(beforeHistoryLen);
  }, 180_000);
});

// ══════════════════════════════════════════════════════════════════
// Export manifest content validation
// ══════════════════════════════════════════════════════════════════

describe("export manifest content", () => {
  it("contains correct artifact_hashes for all included files", async () => {
    const projectDir = createE2EProject("manifest-hashes");

    // Fast-forward to approved
    await runIntent(projectDir, createE2EIntentAgent());
    await runTriage(projectDir, createE2ETriageAgent());
    await runBlueprint(projectDir, createE2EBlueprintAgent(), { iterativeEngine: false });
    await runReview(
      projectDir,
      createE2EReviewAgent(),
      {
        createdAt: "2026-03-21T12:00:00Z",
        operatorAccept: async () => ({ accepted: true, approvedBy: "operator@e2e" }),
      },
    );

    const result = runExport(projectDir, {
      exportedAt: "2026-03-21T13:00:00Z",
    });
    const manifest = result.manifest!;

    // Every included file should have a matching hash in artifact_hashes
    for (const file of manifest.included_files) {
      expect(manifest.artifact_hashes[file.path]).toBe(file.hash);
    }

    // timeline_version and review_report_version should not be "unknown"
    expect(manifest.timeline_version).not.toBe("unknown");
    expect(manifest.review_report_version).not.toBe("unknown");
  }, 180_000);

  it("manifest YAML is parseable and round-trips correctly", async () => {
    const projectDir = createE2EProject("manifest-yaml");

    // Fast-forward to approved
    await runIntent(projectDir, createE2EIntentAgent());
    await runTriage(projectDir, createE2ETriageAgent());
    await runBlueprint(projectDir, createE2EBlueprintAgent(), { iterativeEngine: false });
    await runReview(
      projectDir,
      createE2EReviewAgent(),
      {
        createdAt: "2026-03-21T12:00:00Z",
        operatorAccept: async () => ({ accepted: true, approvedBy: "operator@e2e" }),
      },
    );

    runExport(projectDir, { exportedAt: "2026-03-21T13:00:00Z" });

    const manifestPath = path.join(projectDir, "07_export/export_manifest.yaml");
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;

    // Key fields present
    expect(parsed.project_id).toBe("e2e-test");
    expect(parsed.current_state).toBe("approved");
    expect(parsed.approval_status).toBe("clean");
    expect(parsed.analysis_override_status).toBe("clean");
    expect(parsed.included_files).toBeDefined();
    expect(parsed.artifact_hashes).toBeDefined();
  }, 180_000);
});
