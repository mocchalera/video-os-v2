import { describe, it, expect, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createRequire } from "node:module";
import {
  reconcile,
  snapshotArtifacts,
  reconstructState,
  detectInvalidation,
  readProjectState,
  writeProjectState,
  computeFileHash,
  type ProjectStateDoc,
  type ArtifactHashes,
  type ApprovalRecord,
} from "../runtime/state/reconcile.js";
import { createHistoryEntry, appendHistory } from "../runtime/state/history.js";

// ── AJV setup ──────────────────────────────────────────────────────

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

// ── Temp dir management ────────────────────────────────────────────

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

function removeDirSync(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function createTempProject(name: string, patches?: Record<string, unknown>): string {
  const tmpDir = path.resolve(`test-fixtures-state-${name}-${Date.now()}`);
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

afterAll(() => tempDirs.forEach(removeDirSync));

// ══════════════════════════════════════════════════════════════════
// 1. project-state.schema.json validation
// ══════════════════════════════════════════════════════════════════

describe("project-state.schema.json", () => {
  const validate = createValidator("project-state.schema.json");

  it("validates minimal template doc", () => {
    const doc = {
      version: 1,
      project_id: "",
      current_state: "intent_pending",
      history: [],
    };
    expect(validate(doc)).toBe(true);
  });

  it("validates full doc with all fields", () => {
    const doc: ProjectStateDoc = {
      version: "1",
      project_id: "test-project",
      current_state: "blueprint_ready",
      last_updated: "2026-03-21T00:00:00Z",
      last_agent: "reconcile",
      last_command: "/status",
      last_runtime: "claude-code",
      artifact_hashes: {
        brief_hash: "abc123",
        blockers_hash: "def456",
        selects_hash: "ghi789",
        blueprint_hash: "jkl012",
        timeline_version: "mno345",
        style_hash: "pqr678",
        human_notes_hash: "stu901",
      },
      approval_record: {
        status: "pending",
        approved_by: "operator",
        approved_at: "2026-03-21T00:00:00Z",
        artifact_versions: {
          timeline_version: "mno345",
          review_report_version: "v001",
          style_hash: "pqr678",
        },
      },
      analysis_override: {
        status: "none",
      },
      gates: {
        analysis_gate: "ready",
        compile_gate: "open",
        planning_gate: "open",
        timeline_gate: "open",
        review_gate: "blocked",
      },
      resume: {
        pending_human_step: "pacing_confirmation",
        pending_questions: ["confirm duration?"],
        resume_command: "/plan --resume",
      },
      history: [
        {
          from_state: "intent_pending",
          to_state: "intent_locked",
          trigger: "/intent",
          actor: "intent-interviewer",
          timestamp: "2026-03-21T00:00:00Z",
          note: "brief finalized",
        },
      ],
    };
    expect(validate(doc)).toBe(true);
  });

  it("rejects invalid current_state", () => {
    const doc = {
      version: 1,
      project_id: "test",
      current_state: "invalid_state",
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects invalid approval_record.status", () => {
    const doc = {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      approval_record: { status: "bad_status" },
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects invalid analysis_override.status", () => {
    const doc = {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      analysis_override: { status: "invalid" },
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects additional properties", () => {
    const doc = {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      unknown_field: true,
    };
    expect(validate(doc)).toBe(false);
  });

  it("validates template project_state.yaml", () => {
    const raw = fs.readFileSync("projects/_template/project_state.yaml", "utf-8");
    const doc = parseYaml(raw);
    expect(validate(doc)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. human-notes.schema.json validation
// ══════════════════════════════════════════════════════════════════

describe("human-notes.schema.json", () => {
  const validate = createValidator("human-notes.schema.json");

  it("validates empty notes template", () => {
    const doc = {
      version: 1,
      project_id: "",
      notes: [],
    };
    expect(validate(doc)).toBe(true);
  });

  it("validates template human_notes.yaml", () => {
    const raw = fs.readFileSync("projects/_template/06_review/human_notes.yaml", "utf-8");
    const doc = parseYaml(raw);
    expect(validate(doc)).toBe(true);
  });

  it("validates note with all fields", () => {
    const doc = {
      version: "1",
      project_id: "test",
      notes: [
        {
          id: "HN_001",
          timestamp: "2026-03-21T00:00:00Z",
          reviewer: "editor",
          observation: "The opening shot feels too abrupt",
          severity: "concern",
          directive_type: "trim_segment",
          clip_ids: ["CL_001"],
          clip_refs: ["SEG_0012"],
          approved_segment_ids: ["SEG_0015"],
          timeline_in_frame: 0,
          timeline_us: 0,
          timeline_tc: "00:00:00:00",
        },
      ],
    };
    expect(validate(doc)).toBe(true);
  });

  it("validates note with only required fields", () => {
    const doc = {
      version: 1,
      project_id: "test",
      notes: [
        {
          id: "HN_001",
          timestamp: "2026-03-21T00:00:00Z",
          reviewer: "editor",
          observation: "Looks good overall",
          severity: "observation",
        },
      ],
    };
    expect(validate(doc)).toBe(true);
  });

  it("rejects invalid severity", () => {
    const doc = {
      version: 1,
      project_id: "test",
      notes: [
        {
          id: "HN_001",
          timestamp: "2026-03-21T00:00:00Z",
          reviewer: "editor",
          observation: "test",
          severity: "critical",
        },
      ],
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects invalid directive_type", () => {
    const doc = {
      version: 1,
      project_id: "test",
      notes: [
        {
          id: "HN_001",
          timestamp: "2026-03-21T00:00:00Z",
          reviewer: "editor",
          observation: "test",
          severity: "observation",
          directive_type: "explode_segment",
        },
      ],
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects missing required fields", () => {
    const doc = {
      version: 1,
      project_id: "test",
      notes: [
        {
          id: "HN_001",
          // missing timestamp, reviewer, observation, severity
        },
      ],
    };
    expect(validate(doc)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. Additive schema updates — backwards compatibility
// ══════════════════════════════════════════════════════════════════

describe("additive schema updates", () => {
  describe("creative-brief.schema.json with autonomy.mode", () => {
    const validate = createValidator("creative-brief.schema.json");

    it("sample project brief passes without mode (backwards compat)", () => {
      const raw = fs.readFileSync(
        path.resolve(SAMPLE_PROJECT, "01_intent/creative_brief.yaml"),
        "utf-8",
      );
      const doc = parseYaml(raw);
      expect(validate(doc)).toBe(true);
    });

    it("accepts brief with autonomy.mode = full", () => {
      const raw = fs.readFileSync(
        path.resolve(SAMPLE_PROJECT, "01_intent/creative_brief.yaml"),
        "utf-8",
      );
      const doc = parseYaml(raw) as Record<string, Record<string, unknown>>;
      doc.autonomy.mode = "full";
      expect(validate(doc)).toBe(true);
    });

    it("accepts brief with autonomy.mode = collaborative", () => {
      const raw = fs.readFileSync(
        path.resolve(SAMPLE_PROJECT, "01_intent/creative_brief.yaml"),
        "utf-8",
      );
      const doc = parseYaml(raw) as Record<string, Record<string, unknown>>;
      doc.autonomy.mode = "collaborative";
      expect(validate(doc)).toBe(true);
    });

    it("rejects invalid autonomy.mode", () => {
      const raw = fs.readFileSync(
        path.resolve(SAMPLE_PROJECT, "01_intent/creative_brief.yaml"),
        "utf-8",
      );
      const doc = parseYaml(raw) as Record<string, Record<string, unknown>>;
      doc.autonomy.mode = "semi_auto";
      expect(validate(doc)).toBe(false);
    });
  });

  describe("edit-blueprint.schema.json with confirmed_preferences", () => {
    const validate = createValidator("edit-blueprint.schema.json");

    it("sample project blueprint passes without confirmed_preferences (backwards compat)", () => {
      const raw = fs.readFileSync(
        path.resolve(SAMPLE_PROJECT, "04_plan/edit_blueprint.yaml"),
        "utf-8",
      );
      const doc = parseYaml(raw);
      expect(validate(doc)).toBe(true);
    });

    it("accepts blueprint with confirmed_preferences", () => {
      const raw = fs.readFileSync(
        path.resolve(SAMPLE_PROJECT, "04_plan/edit_blueprint.yaml"),
        "utf-8",
      );
      const doc = parseYaml(raw) as Record<string, Record<string, unknown>>;
      doc.pacing.confirmed_preferences = {
        mode: "collaborative",
        source: "human_confirmed",
        duration_target_sec: 28,
        confirmed_at: "2026-03-21T00:00:00Z",
        structure_choice: "4-beat arc",
        pacing_notes: "keep it spacious",
      };
      expect(validate(doc)).toBe(true);
    });

    it("accepts blueprint with confirmed_preferences minimal required", () => {
      const raw = fs.readFileSync(
        path.resolve(SAMPLE_PROJECT, "04_plan/edit_blueprint.yaml"),
        "utf-8",
      );
      const doc = parseYaml(raw) as Record<string, Record<string, unknown>>;
      doc.pacing.confirmed_preferences = {
        mode: "full",
        source: "ai_autonomous",
        duration_target_sec: 30,
        confirmed_at: "2026-03-21T00:00:00Z",
      };
      expect(validate(doc)).toBe(true);
    });

    it("rejects invalid source in confirmed_preferences", () => {
      const raw = fs.readFileSync(
        path.resolve(SAMPLE_PROJECT, "04_plan/edit_blueprint.yaml"),
        "utf-8",
      );
      const doc = parseYaml(raw) as Record<string, Record<string, unknown>>;
      doc.pacing.confirmed_preferences = {
        mode: "full",
        source: "robot_decided",
        duration_target_sec: 30,
        confirmed_at: "2026-03-21T00:00:00Z",
      };
      expect(validate(doc)).toBe(false);
    });

    it("rejects confirmed_preferences missing required fields", () => {
      const raw = fs.readFileSync(
        path.resolve(SAMPLE_PROJECT, "04_plan/edit_blueprint.yaml"),
        "utf-8",
      );
      const doc = parseYaml(raw) as Record<string, Record<string, unknown>>;
      doc.pacing.confirmed_preferences = {
        mode: "full",
        // missing source, duration_target_sec, confirmed_at
      };
      expect(validate(doc)).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. State Reconcile Engine
// ══════════════════════════════════════════════════════════════════

describe("state reconcile", () => {
  describe("snapshotArtifacts", () => {
    it("detects all artifacts in sample project", () => {
      const snapshot = snapshotArtifacts(path.resolve(SAMPLE_PROJECT));
      expect(snapshot.exists.brief).toBe(true);
      expect(snapshot.exists.blockers).toBe(true);
      expect(snapshot.exists.selects).toBe(true);
      expect(snapshot.exists.blueprint).toBe(true);
      expect(snapshot.exists.timeline).toBe(true);
      expect(snapshot.hashes.brief_hash).toBeTruthy();
      expect(snapshot.hashes.selects_hash).toBeTruthy();
      expect(snapshot.hashes.timeline_version).toBeTruthy();
      expect(snapshot.hashes.analysis_artifact_version).toBe("analysis-v1");
    });

    it("reports missing artifacts", () => {
      const tmpDir = createTempProject("sparse");
      // Remove selects
      fs.rmSync(path.join(tmpDir, "04_plan/selects_candidates.yaml"));
      const snapshot = snapshotArtifacts(tmpDir);
      expect(snapshot.exists.selects).toBe(false);
      expect(snapshot.hashes.selects_hash).toBeUndefined();
    });
  });

  describe("reconstructState", () => {
    it("returns intent_pending when no brief", () => {
      const snapshot = {
        exists: { brief: false, blockers: false, selects: false, blueprint: false, timeline: false, review_report: false, review_patch: false },
        hashes: {},
      };
      expect(reconstructState(snapshot)).toBe("intent_pending");
    });

    it("returns intent_locked when brief+blockers but no selects", () => {
      const snapshot = {
        exists: { brief: true, blockers: true, selects: false, blueprint: false, timeline: false, review_report: false, review_patch: false },
        hashes: {},
      };
      expect(reconstructState(snapshot)).toBe("intent_locked");
    });

    it("returns selects_ready when selects but no blueprint", () => {
      const snapshot = {
        exists: { brief: true, blockers: true, selects: true, blueprint: false, timeline: false, review_report: false, review_patch: false },
        hashes: {},
      };
      expect(reconstructState(snapshot)).toBe("selects_ready");
    });

    it("returns blueprint_ready when blueprint but no timeline", () => {
      const snapshot = {
        exists: { brief: true, blockers: true, selects: true, blueprint: true, timeline: false, review_report: false, review_patch: false },
        hashes: {},
      };
      expect(reconstructState(snapshot)).toBe("blueprint_ready");
    });

    it("returns timeline_drafted when timeline but no review", () => {
      const snapshot = {
        exists: { brief: true, blockers: true, selects: true, blueprint: true, timeline: true, review_report: false, review_patch: false },
        hashes: {},
      };
      expect(reconstructState(snapshot)).toBe("timeline_drafted");
    });

    it("returns critique_ready when review exists but no approval", () => {
      const snapshot = {
        exists: { brief: true, blockers: true, selects: true, blueprint: true, timeline: true, review_report: true, review_patch: true },
        hashes: { timeline_version: "abc", review_report_version: "def", review_patch_hash: "ghi" },
      };
      expect(reconstructState(snapshot)).toBe("critique_ready");
    });

    it("returns approved when approval_record matches", () => {
      const snapshot = {
        exists: { brief: true, blockers: true, selects: true, blueprint: true, timeline: true, review_report: true, review_patch: true },
        hashes: { timeline_version: "abc", review_report_version: "def", review_patch_hash: "ghi" },
      };
      const approval: ApprovalRecord = {
        status: "clean",
        artifact_versions: {
          timeline_version: "abc",
          review_report_version: "def",
          review_patch_hash: "ghi",
        },
      };
      expect(reconstructState(snapshot, approval)).toBe("approved");
    });

    it("returns critique_ready when approval versions mismatch", () => {
      const snapshot = {
        exists: { brief: true, blockers: true, selects: true, blueprint: true, timeline: true, review_report: true, review_patch: true },
        hashes: { timeline_version: "abc", review_report_version: "def", review_patch_hash: "ghi" },
      };
      const approval: ApprovalRecord = {
        status: "clean",
        artifact_versions: {
          timeline_version: "OLD",
          review_report_version: "def",
        },
      };
      expect(reconstructState(snapshot, approval)).toBe("critique_ready");
    });
  });

  describe("detectInvalidation", () => {
    it("returns no invalidation for identical hashes", () => {
      const hashes: ArtifactHashes = {
        brief_hash: "abc",
        selects_hash: "def",
        blueprint_hash: "ghi",
      };
      const result = detectInvalidation(hashes, hashes);
      expect(result.stale_artifacts).toHaveLength(0);
      expect(result.lowest_fallback).toBeNull();
      expect(result.approval_stale).toBe(false);
    });

    it("returns no invalidation when old hashes are undefined", () => {
      const newHashes: ArtifactHashes = {
        brief_hash: "abc",
      };
      const result = detectInvalidation(undefined, newHashes);
      expect(result.stale_artifacts).toHaveLength(0);
    });

    it("detects brief change invalidation", () => {
      const oldHashes: ArtifactHashes = { brief_hash: "old" };
      const newHashes: ArtifactHashes = { brief_hash: "new" };
      const result = detectInvalidation(oldHashes, newHashes);
      expect(result.stale_artifacts).toContain("selects");
      expect(result.stale_artifacts).toContain("blueprint");
      expect(result.stale_artifacts).toContain("timeline");
      expect(result.lowest_fallback).toBe("intent_locked");
      expect(result.approval_stale).toBe(true);
    });

    it("detects selects change invalidation", () => {
      const oldHashes: ArtifactHashes = { selects_hash: "old" };
      const newHashes: ArtifactHashes = { selects_hash: "new" };
      const result = detectInvalidation(oldHashes, newHashes);
      expect(result.stale_artifacts).toContain("blueprint");
      expect(result.stale_artifacts).toContain("timeline");
      expect(result.lowest_fallback).toBe("selects_ready");
    });

    it("detects style change invalidation", () => {
      const oldHashes: ArtifactHashes = { style_hash: "old" };
      const newHashes: ArtifactHashes = { style_hash: "new" };
      const result = detectInvalidation(oldHashes, newHashes);
      expect(result.stale_artifacts).toContain("blueprint");
      expect(result.lowest_fallback).toBe("selects_ready");
    });

    it("detects human_notes change invalidation", () => {
      const oldHashes: ArtifactHashes = { human_notes_hash: "old" };
      const newHashes: ArtifactHashes = { human_notes_hash: "new" };
      const result = detectInvalidation(oldHashes, newHashes);
      expect(result.stale_artifacts).toContain("review_report");
      expect(result.stale_artifacts).toContain("review_patch");
      expect(result.lowest_fallback).toBe("timeline_drafted");
    });

    it("detects timeline change invalidation", () => {
      const oldHashes: ArtifactHashes = { timeline_version: "old" };
      const newHashes: ArtifactHashes = { timeline_version: "new" };
      const result = detectInvalidation(oldHashes, newHashes);
      expect(result.stale_artifacts).toContain("review_report");
      expect(result.stale_artifacts).toContain("review_patch");
      expect(result.lowest_fallback).toBe("timeline_drafted");
    });

    it("uses lowest fallback when multiple artifacts changed", () => {
      const oldHashes: ArtifactHashes = {
        brief_hash: "old_brief",
        blueprint_hash: "old_bp",
      };
      const newHashes: ArtifactHashes = {
        brief_hash: "new_brief",
        blueprint_hash: "new_bp",
      };
      const result = detectInvalidation(oldHashes, newHashes);
      // brief fallback is intent_locked (idx 1), blueprint is blueprint_ready (idx 4)
      // should pick intent_locked as lowest
      expect(result.lowest_fallback).toBe("intent_locked");
    });
  });

  describe("reconcile (full integration)", () => {
    it("reconciles sample project to critique_ready", () => {
      const tmpDir = createTempProject("reconcile-full");
      // Write initial project_state.yaml
      writeProjectState(tmpDir, {
        version: 1,
        project_id: "sample-mountain-reset",
        current_state: "intent_pending",
        history: [],
      });
      const result = reconcile(tmpDir);
      // Sample project has brief, blockers, selects, blueprint, timeline,
      // review_report, review_patch — so it should reach critique_ready
      expect(result.reconciled_state).toBe("critique_ready");
      expect(result.self_healed).toBe(true);
      expect(result.history_appended.length).toBeGreaterThan(0);
    });

    it("reconciles to media_analyzed when brief+blockers+analysis exist", () => {
      const tmpDir = createTempProject("reconcile-intent");
      // Remove everything after intent (keep 03_analysis from sample)
      fs.rmSync(path.join(tmpDir, "04_plan"), { recursive: true });
      fs.rmSync(path.join(tmpDir, "05_timeline"), { recursive: true });
      fs.rmSync(path.join(tmpDir, "06_review"), { recursive: true });

      writeProjectState(tmpDir, {
        version: 1,
        project_id: "test",
        current_state: "intent_pending",
        history: [],
      });

      const result = reconcile(tmpDir);
      // Sample project has 03_analysis → analysis ready → media_analyzed
      expect(result.reconciled_state).toBe("media_analyzed");
    });

    it("reconciles to intent_locked when only brief+blockers exist (no analysis)", () => {
      const tmpDir = createTempProject("reconcile-intent-no-analysis");
      // Remove everything after intent INCLUDING analysis
      fs.rmSync(path.join(tmpDir, "03_analysis"), { recursive: true });
      fs.rmSync(path.join(tmpDir, "04_plan"), { recursive: true });
      fs.rmSync(path.join(tmpDir, "05_timeline"), { recursive: true });
      fs.rmSync(path.join(tmpDir, "06_review"), { recursive: true });

      writeProjectState(tmpDir, {
        version: 1,
        project_id: "test",
        current_state: "intent_pending",
        history: [],
      });

      const result = reconcile(tmpDir);
      expect(result.reconciled_state).toBe("intent_locked");
    });

    it("reconciles to blueprint_ready when no timeline", () => {
      const tmpDir = createTempProject("reconcile-bp");
      fs.rmSync(path.join(tmpDir, "05_timeline"), { recursive: true });
      fs.rmSync(path.join(tmpDir, "06_review"), { recursive: true });

      writeProjectState(tmpDir, {
        version: 1,
        project_id: "test",
        current_state: "intent_pending",
        history: [],
      });

      const result = reconcile(tmpDir);
      expect(result.reconciled_state).toBe("blueprint_ready");
    });

    it("self-heals when persisted state is ahead of artifacts", () => {
      const tmpDir = createTempProject("self-heal");
      // Remove timeline but state says timeline_drafted
      fs.rmSync(path.join(tmpDir, "05_timeline"), { recursive: true });
      fs.rmSync(path.join(tmpDir, "06_review"), { recursive: true });

      writeProjectState(tmpDir, {
        version: 1,
        project_id: "test",
        current_state: "timeline_drafted",
        history: [],
      });

      const result = reconcile(tmpDir);
      expect(result.persisted_state).toBe("timeline_drafted");
      expect(result.reconciled_state).toBe("blueprint_ready");
      expect(result.self_healed).toBe(true);
    });

    it("restores blocked when blueprint exists and compile gate is blocked", () => {
      const tmpDir = createTempProject("blocked-resume", {
        "01_intent/unresolved_blockers.yaml": {
          version: "1",
          project_id: "test",
          blockers: [
            {
              id: "BLK_001",
              question: "Need rights approval?",
              status: "blocker",
              why_it_matters: "Cannot ship without approval",
              allowed_temporary_assumption: null,
            },
          ],
        },
      });

      writeProjectState(tmpDir, {
        version: 1,
        project_id: "test",
        current_state: "blocked",
        history: [],
      });

      const result = reconcile(tmpDir);
      expect(result.gates.compile_gate).toBe("blocked");
      expect(result.reconciled_state).toBe("blocked");
    });

    it("detects invalidation from hash changes", () => {
      const tmpDir = createTempProject("invalidation");

      // First reconcile to establish baseline hashes
      writeProjectState(tmpDir, {
        version: 1,
        project_id: "test",
        current_state: "critique_ready",
        history: [],
      });
      const first = reconcile(tmpDir);
      writeProjectState(tmpDir, first.doc);

      // Modify brief
      const briefPath = path.join(tmpDir, "01_intent/creative_brief.yaml");
      const brief = fs.readFileSync(briefPath, "utf-8");
      fs.writeFileSync(briefPath, brief + "\n# modified\n", "utf-8");

      // Second reconcile should detect brief change
      const second = reconcile(tmpDir);
      expect(second.stale_artifacts).toContain("selects");
      expect(second.stale_artifacts).toContain("blueprint");
      expect(second.stale_artifacts).toContain("timeline");
    });

    it("marks approval_record stale on artifact change", () => {
      const tmpDir = createTempProject("approval-stale");

      // Write state with approval
      const snapshot = snapshotArtifacts(path.resolve(tmpDir));
      writeProjectState(tmpDir, {
        version: 1,
        project_id: "test",
        current_state: "approved",
        artifact_hashes: snapshot.hashes,
        approval_record: {
          status: "clean",
          approved_by: "operator",
          approved_at: "2026-03-21T00:00:00Z",
          artifact_versions: {
            timeline_version: snapshot.hashes.timeline_version,
            review_report_version: snapshot.hashes.review_report_version,
          },
        },
        history: [],
      });

      // Modify brief to trigger invalidation
      const briefPath = path.join(tmpDir, "01_intent/creative_brief.yaml");
      const brief = fs.readFileSync(briefPath, "utf-8");
      fs.writeFileSync(briefPath, brief + "\n# changed\n", "utf-8");

      const result = reconcile(tmpDir);
      expect(result.doc.approval_record?.status).toBe("stale");
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. State History
// ══════════════════════════════════════════════════════════════════

describe("state history", () => {
  it("creates a history entry with timestamp", () => {
    const entry = createHistoryEntry(
      "intent_pending",
      "intent_locked",
      "/intent",
      "intent-interviewer",
      "brief finalized",
    );
    expect(entry.from_state).toBe("intent_pending");
    expect(entry.to_state).toBe("intent_locked");
    expect(entry.trigger).toBe("/intent");
    expect(entry.actor).toBe("intent-interviewer");
    expect(entry.note).toBe("brief finalized");
    expect(entry.timestamp).toBeTruthy();
  });

  it("creates entry without note", () => {
    const entry = createHistoryEntry("a", "b", "trigger", "actor");
    expect(entry.note).toBeUndefined();
  });

  it("appends to history immutably", () => {
    const original = [
      createHistoryEntry("a", "b", "t1", "actor1"),
    ];
    const newEntry = createHistoryEntry("b", "c", "t2", "actor2");
    const updated = appendHistory(original, newEntry);
    expect(updated).toHaveLength(2);
    expect(original).toHaveLength(1); // immutable
    expect(updated[1].to_state).toBe("c");
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. Gate computation
// ══════════════════════════════════════════════════════════════════

describe("gate computation via reconcile", () => {
  it("computes compile_gate = open for sample project", () => {
    const tmpDir = createTempProject("gates-open");
    writeProjectState(tmpDir, {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    });
    const result = reconcile(tmpDir);
    expect(result.gates.compile_gate).toBe("open");
  });

  it("computes compile_gate = blocked when blocker exists", () => {
    const tmpDir = createTempProject("gates-blocked", {
      "01_intent/unresolved_blockers.yaml": {
        version: "1",
        project_id: "test",
        blockers: [
          { id: "BLK_001", description: "critical issue", status: "blocker" },
        ],
      },
    });
    writeProjectState(tmpDir, {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    });
    const result = reconcile(tmpDir);
    expect(result.gates.compile_gate).toBe("blocked");
  });

  it("computes planning_gate = blocked when uncertainty blocker exists", () => {
    const tmpDir = createTempProject("planning-blocked", {
      "04_plan/uncertainty_register.yaml": {
        version: "1",
        project_id: "test",
        uncertainties: [
          {
            id: "U_001",
            description: "blocking issue",
            status: "blocker",
            escalation_required: true,
            source: "planner",
            first_surfaced: "2026-03-21T00:00:00Z",
          },
        ],
      },
    });
    writeProjectState(tmpDir, {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    });
    const result = reconcile(tmpDir);
    expect(result.gates.planning_gate).toBe("blocked");
  });

  it("computes analysis_gate = ready when analysis artifacts exist", () => {
    const tmpDir = createTempProject("analysis-ready");
    writeProjectState(tmpDir, {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    });
    const result = reconcile(tmpDir);
    // Sample project has 03_analysis/assets.json and segments.json
    expect(result.gates.analysis_gate).toBe("ready");
  });

  it("keeps analysis_gate blocked for qc_status partial without matching override", () => {
    const tmpDir = createTempProject("analysis-partial-blocked", {
      "03_analysis/gap_report.yaml": {
        version: "1",
        entries: [
          {
            stage: "transcript",
            asset_id: "AST_001",
            severity: "warning",
            reason: "Transcript cleanup pending",
          },
        ],
      },
    });
    fs.rmSync(path.join(tmpDir, "04_plan"), { recursive: true });
    fs.rmSync(path.join(tmpDir, "05_timeline"), { recursive: true });
    fs.rmSync(path.join(tmpDir, "06_review"), { recursive: true });

    writeProjectState(tmpDir, {
      version: 1,
      project_id: "test",
      current_state: "intent_locked",
      history: [],
    });

    const result = reconcile(tmpDir);
    expect(result.gates.analysis_gate).toBe("blocked");
    expect(result.reconciled_state).toBe("intent_locked");
  });

  it("opens partial_override only when override artifact_version matches", () => {
    const tmpDir = createTempProject("analysis-partial-override", {
      "03_analysis/gap_report.yaml": {
        version: "1",
        entries: [
          {
            stage: "transcript",
            asset_id: "AST_001",
            severity: "warning",
            reason: "Transcript cleanup pending",
          },
        ],
      },
    });
    fs.rmSync(path.join(tmpDir, "04_plan"), { recursive: true });
    fs.rmSync(path.join(tmpDir, "05_timeline"), { recursive: true });
    fs.rmSync(path.join(tmpDir, "06_review"), { recursive: true });

    writeProjectState(tmpDir, {
      version: 1,
      project_id: "test",
      current_state: "intent_locked",
      analysis_override: {
        status: "active",
        approved_by: "operator",
        approved_at: "2026-03-21T00:00:00Z",
        artifact_version: "analysis-v1",
      },
      history: [],
    });

    const result = reconcile(tmpDir);
    expect(result.gates.analysis_gate).toBe("partial_override");
    expect(result.reconciled_state).toBe("media_analyzed");
  });

  it("computes review_gate from review_report", () => {
    const tmpDir = createTempProject("review-gate");
    writeProjectState(tmpDir, {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    });
    const result = reconcile(tmpDir);
    // Sample project review_report has no fatal_issues (empty array)
    expect(result.gates.review_gate).toBe("open");
  });
});

// ══════════════════════════════════════════════════════════════════
// 7. Read / Write project_state.yaml
// ══════════════════════════════════════════════════════════════════

describe("readProjectState / writeProjectState", () => {
  it("round-trips project state", () => {
    const tmpDir = createTempProject("roundtrip");
    const original: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "blueprint_ready",
      artifact_hashes: {
        brief_hash: "abc",
        selects_hash: "def",
      },
      approval_record: {
        status: "pending",
      },
      history: [
        {
          from_state: "intent_pending",
          to_state: "intent_locked",
          trigger: "/intent",
          actor: "test",
          timestamp: "2026-03-21T00:00:00Z",
        },
      ],
    };
    writeProjectState(tmpDir, original);
    const loaded = readProjectState(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.current_state).toBe("blueprint_ready");
    expect(loaded!.artifact_hashes?.brief_hash).toBe("abc");
    expect(loaded!.approval_record?.status).toBe("pending");
    expect(loaded!.history).toHaveLength(1);
  });

  it("returns null for missing project_state.yaml", () => {
    const tmpDir = createTempProject("no-state");
    // sample project doesn't have project_state.yaml
    const loaded = readProjectState(tmpDir);
    expect(loaded).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// 8. computeFileHash
// ══════════════════════════════════════════════════════════════════

describe("computeFileHash", () => {
  it("produces consistent hash for same content", () => {
    const filePath = path.resolve(SAMPLE_PROJECT, "01_intent/creative_brief.yaml");
    const hash1 = computeFileHash(filePath);
    const hash2 = computeFileHash(filePath);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16);
  });

  it("produces different hash for different content", () => {
    const tmpDir = createTempProject("hash-diff");
    const file1 = path.join(tmpDir, "01_intent/creative_brief.yaml");
    const file2 = path.join(tmpDir, "01_intent/unresolved_blockers.yaml");
    const hash1 = computeFileHash(file1);
    const hash2 = computeFileHash(file2);
    expect(hash1).not.toBe(hash2);
  });
});
