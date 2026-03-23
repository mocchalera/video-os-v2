import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  parseValidationCliArgs,
  validateProject,
  type ValidationResult,
} from "../scripts/validate-schemas.js";

const SAMPLE_PROJECT = "projects/sample";

// ── Helper: create a temp project by copying the sample and applying patches ──

function createTempProject(
  name: string,
  patches: Record<string, unknown>,
): string {
  const tmpDir = path.resolve(`test-fixtures-${name}-${Date.now()}`);
  copyDirSync(path.resolve(SAMPLE_PROJECT), tmpDir);

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
  return tmpDir;
}

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

// ── Tests ───────────────────────────────────────────────────────────

describe("validate-schemas", () => {
  const tempDirs: string[] = [];
  afterAll(() => tempDirs.forEach(removeDirSync));

  // ── 1. Sample project passes all validation ──────────────────────

  describe("sample project", () => {
    it("passes all schema and runner-level checks", () => {
      const result = validateProject(SAMPLE_PROJECT);

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.compile_gate).toBe("open");
      expect(result.artifacts_checked).toBeGreaterThanOrEqual(5);
      expect(result.gate2_timeline_valid).toBe(true);
      expect(result.gate3_no_fatal_reviews).toBe(true);
    });
  });

  // ── 2. src_in_us < src_out_us invariant ──────────────────────────

  describe("src_in_us < src_out_us", () => {
    it("detects violation when src_in_us >= src_out_us in selects_candidates", () => {
      const selects = parseYaml(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "04_plan/selects_candidates.yaml"),
          "utf-8",
        ),
      );

      selects.candidates[0].src_in_us = 9999999;
      selects.candidates[0].src_out_us = 1000000;

      const tmp = createTempProject("time-inv", {
        "04_plan/selects_candidates.yaml": selects,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.valid).toBe(false);
      const timeViolations = result.violations.filter(
        (v) => v.rule === "src_in_us_lt_src_out_us",
      );
      expect(timeViolations.length).toBeGreaterThanOrEqual(1);
      expect(timeViolations[0].message).toContain("src_in_us");
    });

    it("detects violation when src_in_us equals src_out_us", () => {
      const selects = parseYaml(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "04_plan/selects_candidates.yaml"),
          "utf-8",
        ),
      );

      selects.candidates[1].src_in_us = 5000000;
      selects.candidates[1].src_out_us = 5000000;

      const tmp = createTempProject("time-eq", {
        "04_plan/selects_candidates.yaml": selects,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.valid).toBe(false);
      const timeViolations = result.violations.filter(
        (v) => v.rule === "src_in_us_lt_src_out_us",
      );
      expect(timeViolations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 3. Referential integrity ─────────────────────────────────────

  describe("referential integrity", () => {
    it("detects non-existent segment_id reference", () => {
      const selects = parseYaml(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "04_plan/selects_candidates.yaml"),
          "utf-8",
        ),
      );

      selects.candidates[0].segment_id = "SEG_NONEXISTENT";

      const tmp = createTempProject("bad-seg", {
        "04_plan/selects_candidates.yaml": selects,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.valid).toBe(false);
      const segViolations = result.violations.filter(
        (v) => v.rule === "segment_id_exists",
      );
      expect(segViolations.length).toBeGreaterThanOrEqual(1);
      expect(segViolations[0].message).toContain("SEG_NONEXISTENT");
    });

    it("detects non-existent asset_id reference", () => {
      const selects = parseYaml(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "04_plan/selects_candidates.yaml"),
          "utf-8",
        ),
      );

      selects.candidates[0].asset_id = "AST_FAKE";

      const tmp = createTempProject("bad-ast", {
        "04_plan/selects_candidates.yaml": selects,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.valid).toBe(false);
      const astViolations = result.violations.filter(
        (v) => v.rule === "asset_id_exists",
      );
      expect(astViolations.length).toBeGreaterThanOrEqual(1);
      expect(astViolations[0].message).toContain("AST_FAKE");
    });
  });

  // ── 4. Required roles coverage ───────────────────────────────────

  describe("required roles coverage", () => {
    it("detects uncovered required role in a beat", () => {
      const selects = parseYaml(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "04_plan/selects_candidates.yaml"),
          "utf-8",
        ),
      );

      selects.candidates = selects.candidates.filter(
        (c: Record<string, unknown>) => c.role !== "hero",
      );

      const tmp = createTempProject("no-hero", {
        "04_plan/selects_candidates.yaml": selects,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.valid).toBe(false);
      const roleViolations = result.violations.filter(
        (v) => v.rule === "required_roles_covered",
      );
      expect(roleViolations.length).toBeGreaterThanOrEqual(1);
      expect(roleViolations[0].message).toContain("hero");
    });
  });

  // ── 5. Compile gate (blocker check) ──────────────────────────────

  describe("compile gate", () => {
    it("returns blocked when unresolved_blockers has status: blocker", () => {
      const blockers = {
        version: "1",
        project_id: "sample-mountain-reset",
        blockers: [
          {
            id: "BLK_001",
            question: "Missing music license",
            status: "blocker",
            why_it_matters: "Cannot compile without cleared audio",
            allowed_temporary_assumption: null,
          },
        ],
      };

      const tmp = createTempProject("blocked", {
        "01_intent/unresolved_blockers.yaml": blockers,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.compile_gate).toBe("blocked");
      const gateViolations = result.violations.filter(
        (v) => v.rule === "compile_gate",
      );
      expect(gateViolations.length).toBe(1);
    });

    it("returns open when blockers are resolved or hypothesis", () => {
      const blockers = {
        version: "1",
        project_id: "sample-mountain-reset",
        blockers: [
          {
            id: "BLK_001",
            question: "Was the music cleared?",
            status: "resolved",
            why_it_matters: "Need cleared audio",
            allowed_temporary_assumption: "Using temp track",
          },
          {
            id: "BLK_002",
            question: "Color grading approach?",
            status: "hypothesis",
            why_it_matters: "Affects mood",
            allowed_temporary_assumption: "Cool tones for now",
          },
        ],
      };

      const tmp = createTempProject("not-blocked", {
        "01_intent/unresolved_blockers.yaml": blockers,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.compile_gate).toBe("open");
      const gateViolations = result.violations.filter(
        (v) => v.rule === "compile_gate",
      );
      expect(gateViolations).toHaveLength(0);
    });
  });

  // ── 6. Timeline clip time check (versioned files) ─────────────────

  describe("timeline clip src_in_us < src_out_us", () => {
    it("detects violation in versioned timeline clips", () => {
      const timeline = {
        version: "1",
        project_id: "sample-mountain-reset",
        sequence: {
          name: "test",
          fps_num: 24,
          fps_den: 1,
          width: 1920,
          height: 1080,
          start_frame: 0,
        },
        tracks: {
          video: [
            {
              track_id: "V1",
              kind: "video",
              clips: [
                {
                  clip_id: "CLP_001",
                  segment_id: "SEG_0025",
                  asset_id: "AST_005",
                  src_in_us: 8000000,
                  src_out_us: 2000000, // violation: in > out
                  timeline_in_frame: 0,
                  timeline_duration_frames: 48,
                  role: "hero",
                  motivation: "test clip",
                },
              ],
            },
          ],
          audio: [],
        },
        provenance: {
          brief_path: "01_intent/creative_brief.yaml",
          blueprint_path: "04_plan/edit_blueprint.yaml",
          selects_path: "04_plan/selects_candidates.yaml",
        },
      };

      const tmp = createTempProject("tl-bad-time", {
        "05_timeline/v001.timeline.json": timeline,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.valid).toBe(false);
      const tlTimeViolations = result.violations.filter(
        (v) =>
          v.rule === "src_in_us_lt_src_out_us" &&
          v.artifact.startsWith("05_timeline/"),
      );
      expect(tlTimeViolations.length).toBeGreaterThanOrEqual(1);
      expect(tlTimeViolations[0].message).toContain("CLP_001");
    });
  });

  // ── 7. FATAL 1: canonical timeline.json validation (Gate 2) ──────

  describe("Gate 2 — timeline.json", () => {
    it("validates canonical timeline.json with schema", () => {
      const validTimeline = {
        version: "1",
        project_id: "sample-mountain-reset",
        sequence: {
          name: "main",
          fps_num: 24,
          fps_den: 1,
          width: 1920,
          height: 1080,
          start_frame: 0,
        },
        tracks: {
          video: [
            {
              track_id: "V1",
              kind: "video",
              clips: [
                {
                  clip_id: "CLP_001",
                  segment_id: "SEG_0025",
                  asset_id: "AST_005",
                  src_in_us: 0,
                  src_out_us: 5000000,
                  timeline_in_frame: 0,
                  timeline_duration_frames: 120,
                  role: "hero",
                  motivation: "Opening shot",
                },
              ],
            },
          ],
          audio: [],
        },
        provenance: {
          brief_path: "01_intent/creative_brief.yaml",
          blueprint_path: "04_plan/edit_blueprint.yaml",
          selects_path: "04_plan/selects_candidates.yaml",
        },
      };

      const tmp = createTempProject("tl-valid", {
        "05_timeline/timeline.json": validTimeline,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.gate2_timeline_valid).toBe(true);
      const tlViolations = result.violations.filter(
        (v) => v.artifact === "05_timeline/timeline.json",
      );
      expect(tlViolations).toHaveLength(0);
    });

    it("detects invalid canonical timeline.json and sets gate2 false", () => {
      // Missing required fields → schema violation
      const invalidTimeline = {
        version: "1",
        project_id: "sample-mountain-reset",
        // missing sequence, tracks, provenance
      };

      const tmp = createTempProject("tl-invalid", {
        "05_timeline/timeline.json": invalidTimeline,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.gate2_timeline_valid).toBe(false);
      const tlViolations = result.violations.filter(
        (v) => v.artifact === "05_timeline/timeline.json" && v.rule === "schema",
      );
      expect(tlViolations.length).toBeGreaterThanOrEqual(1);
    });

    it("detects src_in_us >= src_out_us in canonical timeline.json", () => {
      const timeline = {
        version: "1",
        project_id: "sample-mountain-reset",
        sequence: {
          name: "main",
          fps_num: 24,
          fps_den: 1,
          width: 1920,
          height: 1080,
          start_frame: 0,
        },
        tracks: {
          video: [
            {
              track_id: "V1",
              kind: "video",
              clips: [
                {
                  clip_id: "CLP_BAD",
                  segment_id: "SEG_0025",
                  asset_id: "AST_005",
                  src_in_us: 9000000,
                  src_out_us: 1000000,
                  timeline_in_frame: 0,
                  timeline_duration_frames: 48,
                  role: "hero",
                  motivation: "bad clip",
                },
              ],
            },
          ],
          audio: [],
        },
        provenance: {
          brief_path: "01_intent/creative_brief.yaml",
          blueprint_path: "04_plan/edit_blueprint.yaml",
          selects_path: "04_plan/selects_candidates.yaml",
        },
      };

      const tmp = createTempProject("tl-bad-clip", {
        "05_timeline/timeline.json": timeline,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.gate2_timeline_valid).toBe(false);
      const clipViolations = result.violations.filter(
        (v) =>
          v.artifact === "05_timeline/timeline.json" &&
          v.rule === "src_in_us_lt_src_out_us",
      );
      expect(clipViolations.length).toBe(1);
      expect(clipViolations[0].message).toContain("CLP_BAD");
    });

    it("gate2 defaults to true when timeline.json does not exist", () => {
      // Sample project has no 05_timeline/timeline.json
      const result = validateProject(SAMPLE_PROJECT);
      expect(result.gate2_timeline_valid).toBe(true);
    });
  });

  // ── 8. FATAL 2: review_report / review_patch (Gate 3) ────────────

  describe("Gate 3 — review artifacts", () => {
    it("passes when review_report has no fatal_issues", () => {
      const report = {
        version: "1",
        project_id: "sample-mountain-reset",
        timeline_version: "v001",
        summary_judgment: {
          status: "approved",
          rationale: "Looks good",
        },
        strengths: [{ summary: "Good pacing" }],
        weaknesses: [],
        fatal_issues: [],
        warnings: [],
        mismatches_to_brief: [],
        mismatches_to_blueprint: [],
        recommended_next_pass: {
          goal: "Polish",
          actions: ["Color grade"],
        },
      };

      const tmp = createTempProject("review-pass", {
        "06_review/review_report.yaml": report,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.gate3_no_fatal_reviews).toBe(true);
      const gate3Violations = result.violations.filter(
        (v) => v.rule === "gate3_fatal_review",
      );
      expect(gate3Violations).toHaveLength(0);
    });

    it("blocks when review_report has fatal_issues", () => {
      const report = {
        version: "1",
        project_id: "sample-mountain-reset",
        timeline_version: "v001",
        summary_judgment: {
          status: "blocked",
          rationale: "Critical audio sync issue",
        },
        strengths: [],
        weaknesses: [],
        fatal_issues: [
          {
            summary: "Audio is 2s out of sync",
            severity: "fatal",
          },
        ],
        warnings: [],
        mismatches_to_brief: [],
        mismatches_to_blueprint: [],
        recommended_next_pass: {
          goal: "Fix audio sync",
          actions: ["Re-align audio tracks"],
        },
      };

      const tmp = createTempProject("review-fatal", {
        "06_review/review_report.yaml": report,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.gate3_no_fatal_reviews).toBe(false);
      const gate3Violations = result.violations.filter(
        (v) => v.rule === "gate3_fatal_review",
      );
      expect(gate3Violations.length).toBe(1);
      expect(gate3Violations[0].message).toContain("fatal");
    });

    it("validates review_patch.json schema", () => {
      const patch = {
        timeline_version: "v001",
        operations: [
          {
            op: "trim_segment",
            target_clip_id: "CLP_001",
            new_src_in_us: 0,
            new_src_out_us: 3000000,
            reason: "Remove dead air",
          },
        ],
      };

      const tmp = createTempProject("review-patch-valid", {
        "06_review/review_patch.json": patch,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const patchViolations = result.violations.filter(
        (v) => v.artifact === "06_review/review_patch.json",
      );
      expect(patchViolations).toHaveLength(0);
    });

    it("detects invalid review_patch.json", () => {
      const invalidPatch = {
        // missing timeline_version and operations
        junk: true,
      };

      const tmp = createTempProject("review-patch-bad", {
        "06_review/review_patch.json": invalidPatch,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const patchViolations = result.violations.filter(
        (v) =>
          v.artifact === "06_review/review_patch.json" && v.rule === "schema",
      );
      expect(patchViolations.length).toBeGreaterThanOrEqual(1);
    });

    it("gate3 defaults to true when 06_review does not exist", () => {
      const result = validateProject(SAMPLE_PROJECT);
      expect(result.gate3_no_fatal_reviews).toBe(true);
    });
  });

  // ── 9. WARNING 1: error handling for malformed input ──────────────

  describe("error handling", () => {
    it("reports malformed YAML as parse_error violation (no exception)", () => {
      const tmp = createTempProject("bad-yaml", {
        "04_plan/selects_candidates.yaml": "{{{{not: valid: yaml: [[[",
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.valid).toBe(false);
      const parseErrors = result.violations.filter(
        (v) => v.rule === "parse_error",
      );
      expect(parseErrors.length).toBeGreaterThanOrEqual(1);
      expect(parseErrors[0].artifact).toBe("04_plan/selects_candidates.yaml");
    });

    it("reports broken JSON as parse_error violation (no exception)", () => {
      const tmp = createTempProject("bad-json", {
        "05_timeline/timeline.json": "{not valid json!!!}",
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.valid).toBe(false);
      const parseErrors = result.violations.filter(
        (v) =>
          v.rule === "parse_error" &&
          v.artifact === "05_timeline/timeline.json",
      );
      expect(parseErrors.length).toBe(1);
    });

    it("reports broken JSON in versioned timeline as parse_error", () => {
      const tmp = createTempProject("bad-tl-json", {
        "05_timeline/v001.timeline.json": "NOT JSON {{{",
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.valid).toBe(false);
      const parseErrors = result.violations.filter(
        (v) =>
          v.rule === "parse_error" &&
          v.artifact === "05_timeline/v001.timeline.json",
      );
      expect(parseErrors.length).toBe(1);
    });

    it("handles schema-invalid shape without throwing TypeError", () => {
      // candidates as object instead of array → should not crash
      const tmp = createTempProject("bad-shape", {
        "04_plan/selects_candidates.yaml": {
          version: "1",
          project_id: "sample-mountain-reset",
          candidates: { not_an_array: true },
        },
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      // Should have schema violations but not throw
      expect(result.valid).toBe(false);
      const schemaErrors = result.violations.filter(
        (v) => v.rule === "schema" && v.artifact === "04_plan/selects_candidates.yaml",
      );
      expect(schemaErrors.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 10. WARNING 2: uncertainty_register blocker semantics ─────────

  describe("uncertainty_register blocker warning", () => {
    it("emits warning when uncertainty_register has blocker entries", () => {
      const register = {
        version: "1",
        project_id: "sample-mountain-reset",
        uncertainties: [
          {
            id: "UNC_001",
            type: "audio",
            question: "Is the music licensed?",
            status: "blocker",
            evidence: ["No license found"],
            alternatives: [
              { label: "Use royalty-free", description: "Find alternative" },
            ],
            escalation_required: true,
          },
        ],
      };

      const tmp = createTempProject("unc-blocker", {
        "04_plan/uncertainty_register.yaml": register,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const warnings = result.violations.filter(
        (v) => v.rule === "uncertainty_blocker_warning",
      );
      expect(warnings.length).toBe(1);
      expect(warnings[0].message).toContain("WARNING");
      // compile_gate should remain open (uncertainty_register doesn't block Gate 1)
      expect(result.compile_gate).toBe("open");
    });

    it("no warning when uncertainty_register has no blocker entries", () => {
      const register = {
        version: "1",
        project_id: "sample-mountain-reset",
        uncertainties: [
          {
            id: "UNC_001",
            type: "audio",
            question: "Is the music licensed?",
            status: "monitoring",
            evidence: ["Checking"],
            alternatives: [
              { label: "Wait", description: "Await response" },
            ],
            escalation_required: false,
          },
        ],
      };

      const tmp = createTempProject("unc-no-blocker", {
        "04_plan/uncertainty_register.yaml": register,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const warnings = result.violations.filter(
        (v) => v.rule === "uncertainty_blocker_warning",
      );
      expect(warnings).toHaveLength(0);
    });
  });

  // ── 11. Manual-render / lenient profiles ─────────────────────────

  describe("profile handling", () => {
    it("parses --profile from CLI args", () => {
      expect(
        parseValidationCliArgs(["--profile", "manual-render", "projects/sample"]),
      ).toEqual({
        profile: "manual-render",
        projectPaths: ["projects/sample"],
      });

      expect(
        parseValidationCliArgs(["--profile=lenient", "projects/sample"]),
      ).toEqual({
        profile: "lenient",
        projectPaths: ["projects/sample"],
      });
    });

    it("standard profile rejects manual-render-only timeline fields", () => {
      const timeline = {
        version: "1",
        project_id: "sample-mountain-reset",
        sequence: {
          name: "main",
          fps_num: 24,
          fps_den: 1,
          width: 1920,
          height: 1080,
          start_frame: 0,
        },
        tracks: {
          video: [],
          audio: [],
        },
        provenance: {
          brief_path: "01_intent/creative_brief.yaml",
          blueprint_path: "04_plan/edit_blueprint.yaml",
          selects_path: "04_plan/selects_candidates.yaml",
        },
        manual_render: {
          spec_path: "manual_render/reedit_spec_full_song.json",
        },
      };

      const tmp = createTempProject("profile-standard-manual", {
        "05_timeline/timeline.json": timeline,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      expect(result.valid).toBe(false);
      const tlViolations = result.violations.filter(
        (v) => v.artifact === "05_timeline/timeline.json" && v.rule === "schema",
      );
      expect(tlViolations.length).toBeGreaterThanOrEqual(1);
      expect(
        tlViolations.some((v) =>
          (v.details as { params?: { additionalProperty?: string } } | undefined)
            ?.params?.additionalProperty === "manual_render"),
      ).toBe(true);
    });

    it("manual-render profile accepts manual-render timeline fields", () => {
      const timeline = {
        version: "1",
        project_id: "sample-mountain-reset",
        sequence: {
          name: "main",
          fps_num: 24,
          fps_den: 1,
          width: 1920,
          height: 1080,
          start_frame: 0,
        },
        tracks: {
          video: [],
          audio: [
            {
              track_id: "A1",
              kind: "audio",
              clips: [
                {
                  clip_id: "ACL_001",
                  segment_id: "SEG_0025",
                  asset_id: "AST_005",
                  src_in_us: 0,
                  src_out_us: 3000000,
                  timeline_in_frame: 0,
                  timeline_duration_frames: 72,
                  role: "nat_sound",
                  motivation: "manual render audio bed",
                  audio_policy: {
                    nat_gain: 0.9,
                  },
                },
                {
                  clip_id: "ACL_002",
                  segment_id: "manual:bgm",
                  asset_id: "AST_BGM_001",
                  src_in_us: 0,
                  src_out_us: 3000000,
                  timeline_in_frame: 0,
                  timeline_duration_frames: 72,
                  role: "bgm",
                  motivation: "manual render music bed",
                  audio_policy: {
                    bgm_gain: -4,
                  },
                },
              ],
            },
          ],
        },
        audio_mix: {
          nat_sound_gain: 0.9,
          bgm_gain: -4,
        },
        provenance: {
          brief_path: "01_intent/creative_brief.yaml",
          blueprint_path: "04_plan/edit_blueprint.yaml",
          selects_path: "04_plan/selects_candidates.yaml",
          manual_render_spec_path: "manual_render/reedit_spec_full_song.json",
          render_profile: "manual-render",
        },
        manual_render: {
          spec_path: "manual_render/reedit_spec_full_song.json",
          render_script_path: "manual_render/render_from_spec.py",
        },
      };

      const tmp = createTempProject("profile-manual-render", {
        "05_timeline/timeline.json": timeline,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp, { profile: "manual-render" });

      expect(result.valid).toBe(true);
      expect(result.error_count).toBe(0);
      const tlViolations = result.violations.filter(
        (v) => v.artifact === "05_timeline/timeline.json",
      );
      expect(tlViolations).toHaveLength(0);
    });

    it("lenient profile downgrades validation failures to warnings", () => {
      const tmp = createTempProject("profile-lenient", {
        "05_timeline/timeline.json": {
          version: "1",
          project_id: "sample-mountain-reset",
        },
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp, { profile: "lenient" });

      expect(result.valid).toBe(true);
      expect(result.error_count).toBe(0);
      expect(result.warning_count).toBeGreaterThan(0);
      expect(result.violations.every((v) => v.severity === "warning")).toBe(true);
      expect(result.gate2_timeline_valid).toBe(false);
    });
  });

  // ── 12. Generated artifact compatibility ─────────────────────────

  describe("generated artifact compatibility", () => {
    it("accepts generated source_map entries", () => {
      const tmp = createTempProject("generated-source-map", {
        "02_media/source_map.json": {
          version: "1",
          project_id: "sample-mountain-reset",
          media_dir: "02_media",
          generated_at: "2026-03-23T00:00:00Z",
          items: [
            {
              asset_id: "GFX_CAPTION_BAND_01",
              source_locator: "/tmp/generated/caption-band.png",
              local_source_path: "/tmp/generated/caption-band.png",
              link_path: "02_media/caption-band.png",
              display_name: "caption_band",
              kind: "asset",
              link_type: "generated",
            },
          ],
        },
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);
      const sourceMapViolations = result.violations.filter(
        (v) => v.artifact === "02_media/source_map.json",
      );
      expect(sourceMapViolations).toHaveLength(0);
    });

    it("accepts transcript diarization summaries", () => {
      const tmp = createTempProject("transcript-diarization", {
        "03_analysis/transcripts/TR_AST_999.json": {
          project_id: "sample-mountain-reset",
          artifact_version: "2.0.0",
          transcript_ref: "TR_AST_999",
          asset_id: "AST_999",
          items: [
            {
              item_id: "TRI_AST_999_0001",
              speaker: "S1",
              start_us: 0,
              end_us: 1200000,
              text: "test",
            },
          ],
          analysis_status: "ready",
          word_timing_mode: "word",
          diarization: {
            provider: "pyannote",
            speaker_count: 1,
            turn_count: 2,
          },
        },
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);
      const transcriptViolations = result.violations.filter(
        (v) => v.artifact === "03_analysis/transcripts/TR_AST_999.json",
      );
      expect(transcriptViolations).toHaveLength(0);
    });

    it("validates rokutaro-growth-20260323 manual artifacts in standard profile", () => {
      const result = validateProject("projects/rokutaro-growth-20260323");

      expect(result.valid).toBe(true);
      expect(result.error_count).toBe(0);
      expect(result.violations).toHaveLength(0);
    });
  });
});
