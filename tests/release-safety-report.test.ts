import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  buildReleaseSafetyReport,
  computeReleaseSafetyReportHash,
  isP4aReleaseSafetyEnabled,
  runReleaseSafetyPreflight,
  validateReleaseSafetyReportIntegrity,
  waiverMatchesCheck,
  writeReleaseSafetyReport,
  type ReleaseSafetyReport,
} from "../runtime/artifacts/p4a-release-safety.js";
import { runStatus } from "../runtime/commands/status.js";
import {
  EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH,
  EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH,
} from "../runtime/artifacts/p3-preference-memory.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const FIXTURE_DIR = path.resolve("tests/fixtures/release_safety_report");
const SCHEMA_PATH = path.resolve("schemas/release-safety-report.schema.json");
const DEMO_TIMELINE = path.resolve("projects/demo/05_timeline/timeline.json");

function readYaml(fileName: string): unknown {
  return parseYaml(fs.readFileSync(path.join(FIXTURE_DIR, fileName), "utf-8"));
}

function schemaValidator(): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8")));
}

function canonicalTimelineHash(): string {
  const data = JSON.parse(fs.readFileSync(DEMO_TIMELINE, "utf-8")) as Record<string, unknown>;
  delete data.created_at;
  return execFileSync("shasum", ["-a", "256"], {
    input: JSON.stringify(data),
    encoding: "utf-8",
  }).trim().split(/\s+/)[0];
}

function makeProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4a-release-safety-"));
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "06_review"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "07_package"), { recursive: true });

  fs.writeFileSync(
    path.join(projectDir, "05_timeline/timeline.json"),
    JSON.stringify({ version: "tl_fixture_001", project_id: "p4a-runtime", created_at: "2026-04-26T00:00:00Z" }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectDir, "06_review/review_report.yaml"),
    stringifyYaml({
      version: "1.0.0",
      project_id: "p4a-runtime",
      timeline_version: "tl_fixture_001",
      summary_judgment: { status: "blocked", rationale: "test" },
      strengths: [],
      weaknesses: [],
      fatal_issues: [{ summary: "Opening beat is intentionally abrupt", severity: "fatal", affected_beat_ids: ["beat_opening"] }],
      warnings: [],
      mismatches_to_brief: [],
      mismatches_to_blueprint: [],
      recommended_next_pass: { action: "revise", rationale: "test" },
    }),
  );
  fs.writeFileSync(
    path.join(projectDir, "02_media/source_media_manifest.json"),
    JSON.stringify({
      version: "1.0.0",
      project_id: "p4a-runtime",
      artifact_version: "manifest-v1",
      created_at: "2026-04-26T00:00:00Z",
      source_root: { locator: ".", locator_kind: "local_path" },
      items: [{
        asset_id: "AST_runtime_001",
        source_locator: "media/runtime.mp4",
        filename: "runtime.mp4",
        content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fingerprint: null,
        size_bytes: 10,
        mtime: "2026-04-26T00:00:00Z",
        media_kind: "video",
        ingest_status: "ready",
        rights_status: "unknown",
        privacy_status: "contains_people",
        analysis_policy_ref: "APOL_default",
        capture_started_at: null,
        capture_timezone: null,
        timecode_start: null,
        timecode_format: "none",
        sample_rate: null,
        duration_us: 1000000,
        frame_rate_mode: "cfr",
        rotation: 0,
        audio_video_offset_ms: null,
        clock_source: "file_metadata",
      }],
      provenance: {
        producer: "analysis-ingest",
        inputs: [{ path: ".", hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
        hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: ["created_at"] },
      },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectDir, "03_analysis/analysis_coverage_report.json"),
    JSON.stringify({
      version: "1.0.0",
      project_id: "p4a-runtime",
      artifact_version: "analysis-v1",
      created_at: "2026-04-26T00:00:00Z",
      source_media_manifest_hash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      summary: { status: "ready", required_lane_count: 1, ready_lane_count: 1, blocked_lane_count: 0, partial_lane_count: 0 },
      lanes: [],
      assets: [],
      blockers: [],
      overrides: [],
      provenance: { producer: "analysis-pipeline", inputs: [], hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: ["created_at"] } },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectDir, "03_analysis/audio_story_graph.json"),
    JSON.stringify({ version: "1.0.0", project_id: "p4a-runtime", source_media_manifest_hash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectDir, "03_analysis/continuity_graph.json"),
    JSON.stringify({
      version: "1.0.0",
      project_id: "p4a-runtime",
      source_media_manifest_hash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      entities: [{ entity_id: "ENT_SUBJECT_child", status: "confirmed_editing_continuity" }],
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectDir, "07_package/package_manifest.json"),
    JSON.stringify({ version: "1.0.0", project_id: "p4a-runtime", artifacts: { final_video: { path: "07_package/video/final.mp4" } } }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectDir, "project_state.yaml"),
    stringifyYaml({
      version: 1,
      project_id: "p4a-runtime",
      current_state: "approved",
      gates: {
        analysis_gate: "ready",
        compile_gate: "open",
        planning_gate: "open",
        timeline_gate: "open",
        review_gate: "open",
      },
    }),
  );
  return projectDir;
}

function writePreferenceMemory(projectDir: string, relativePath: string, projectId = "p4a-runtime", raw?: string): string {
  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, raw ?? `${JSON.stringify({
    version: "1.0.0",
    project_id: projectId,
    entry_id: `EPM_${projectId.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    created_at: "2026-04-26T00:00:00Z",
    actor: { type: "human", id: "operator" },
    source_event: { event_type: "operator_command", event_ref: "test" },
    preference_type: "pacing",
    value: { kind: "enum", data: "tight" },
    scope: "project",
    confidence: { score: 1, source: "operator", status: "ready" },
    status: "active",
    provenance: { producer: "operator-command", inputs: [], hash_policy: {} },
  })}\n`, "utf-8");
  return filePath;
}

afterEach(() => {
  delete process.env.ENABLE_P4A_RELEASE_SAFETY;
  delete process.env.ENABLE_P4B_DELIVERY_PROFILES;
  delete process.env.ENABLE_P4C_CONFIDENCE_CALIBRATION;
  delete process.env.ENABLE_P4D_SEARCH_INDEX;
  delete process.env.SEARCH_INDEX_AUTONOMY;
  delete process.env.RELEASE_SAFETY_MODE;
});

describe("P4a release_safety_report", () => {
  it("reports and validates canonical preference memory, with legacy-only fallback and canonical precedence", () => {
    const canonicalProject = makeProject();
    const canonicalPath = writePreferenceMemory(canonicalProject, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH);
    const canonicalReport = buildReleaseSafetyReport({ projectDir: canonicalProject, producer: "/package" });
    expect(canonicalReport.provenance.inputs.find((ref) => ref.path === canonicalPath)?.hash).toMatch(/^sha256:/);
    expect(canonicalReport.checks.find((check) => check.check_id === "RSCHK_schema_validation")?.message).not.toContain(EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH);

    const legacyProject = makeProject();
    const legacyPath = writePreferenceMemory(legacyProject, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH);
    const legacyReport = buildReleaseSafetyReport({ projectDir: legacyProject, producer: "/package" });
    expect(legacyReport.provenance.inputs.find((ref) => ref.path === legacyPath)?.hash).toMatch(/^sha256:/);
    expect(legacyReport.checks.find((check) => check.check_id === "RSCHK_schema_validation")?.message).not.toContain(EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH);

    const bothProject = makeProject();
    const bothCanonicalPath = writePreferenceMemory(bothProject, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH);
    const bothLegacyPath = writePreferenceMemory(bothProject, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, "p4a-runtime", "malformed\n");
    const bothReport = buildReleaseSafetyReport({ projectDir: bothProject, producer: "/package" });
    expect(bothReport.provenance.inputs.some((ref) => ref.path === bothCanonicalPath && ref.hash)).toBe(true);
    expect(bothReport.provenance.inputs.some((ref) => ref.path === bothLegacyPath)).toBe(false);
    expect(bothReport.checks.find((check) => check.check_id === "RSCHK_schema_validation")?.message).not.toContain("editorial_preference_memory.jsonl");
  });

  it.each([
    ["malformed", "malformed\n"],
    ["cross-project", undefined],
  ])("surfaces %s canonical preference memory as a schema validation failure", (kind, raw) => {
    const projectDir = makeProject();
    writePreferenceMemory(
      projectDir,
      EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH,
      kind === "cross-project" ? "another-project" : "p4a-runtime",
      raw,
    );
    const report = buildReleaseSafetyReport({ projectDir, producer: "/package" });
    const schemaCheck = report.checks.find((check) => check.check_id === "RSCHK_schema_validation");
    expect(schemaCheck?.status).toBe("fail");
    expect(schemaCheck?.message).toContain(kind === "cross-project" ? "does not match" : "line 1");
  });
  it.each([
    "valid_dry_run_missing_inputs.yaml",
    "valid_report_only_blocker.yaml",
    "valid_enforce_pass_with_waiver.yaml",
  ])("accepts valid fixture %s", (fixture) => {
    const validate = schemaValidator();
    const data = readYaml(fixture);

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateReleaseSafetyReportIntegrity(data).valid).toBe(true);
  });

  it.each([
    "invalid_enforce_blocked_summary_pass.yaml",
    "invalid_missing_base_timeline_version.yaml",
  ])("rejects invalid fixture %s", (fixture) => {
    const validate = schemaValidator();
    const data = readYaml(fixture);

    expect(validate(data) && validateReleaseSafetyReportIntegrity(data).valid).toBe(false);
  });

  it.each([
    "edge_public_unknown_rights_fatal.yaml",
    "edge_fatal_review_creative_override.yaml",
  ])("keeps edge fixture schema-valid: %s", (fixture) => {
    const validate = schemaValidator();
    const data = readYaml(fixture);

    expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("runs every dry_run check generator and writes a non-blocking report", () => {
    const projectDir = makeProject();
    const result = runReleaseSafetyPreflight({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
      waivers: [{
        waiver_id: "RSWVR_creative_override_opening",
        approved_by: "director",
        approved_at: "2026-04-26T00:10:00Z",
        scope: "creative_override:beat_opening",
        reason: "intentional",
        expires_at: null,
        applies_to_artifact_hash: null,
      }],
    });

    expect(result.exitCode).toBe(0);
    expect(new Set(result.report.checks.map((check) => check.category))).toEqual(new Set([
      "editorial_review",
      "schema_validation",
      "technical_qa",
      "delivery_profile",
      "rights",
      "privacy",
      "source_of_truth",
      "caption_audio",
      "music_audio",
      "package_completeness",
      "source_manifest",
    ]));
    expect(result.report.checks.every((check) => check.status !== "not_evaluated" || check.category === "delivery_profile")).toBe(true);
    expect(result.report.checks.some((check) => check.severity === "fatal" || check.severity === "blocker")).toBe(true);
    const outputPath = writeReleaseSafetyReport(projectDir, result.report);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("computes deterministic yaml-to-normalized-json-v1 hashes with created_at excluded", () => {
    const report = readYaml("valid_dry_run_missing_inputs.yaml") as ReleaseSafetyReport;
    const later = { ...report, created_at: "2026-04-27T00:00:00Z" };

    expect(computeReleaseSafetyReportHash(report)).toBe(computeReleaseSafetyReportHash(later));
    expect(computeReleaseSafetyReportHash(report)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("records stale artifact_refs.hash mismatches as release checks", () => {
    const projectDir = makeProject();
    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.checks.some((check) =>
      check.category === "source_manifest" &&
      check.status === "fail" &&
      check.message.includes("stale")
    )).toBe(true);
  });

  it("matches creative_override waiver scopes to fatal review checks", () => {
    const report = readYaml("edge_fatal_review_creative_override.yaml") as ReleaseSafetyReport;
    expect(waiverMatchesCheck(report.waivers[0], report.checks[0])).toBe(true);
  });

  it("keeps report_only and enforce as unimplemented P4a skeleton modes", () => {
    const projectDir = makeProject();
    expect(() => runReleaseSafetyPreflight({ projectDir, producer: "/package", mode: "report_only" }))
      .toThrow("not_implemented_in_p4a");
    expect(() => runReleaseSafetyPreflight({ projectDir, producer: "/package", mode: "enforce" }))
      .toThrow("not_implemented_in_p4a");
  });

  it("shows release safety report mode and summary in status only when enabled", () => {
    const projectDir = makeProject();
    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });
    writeReleaseSafetyReport(projectDir, report);

    expect(runStatus(projectDir).releaseSafety).toBeUndefined();
    process.env.ENABLE_P4A_RELEASE_SAFETY = "true";
    const status = runStatus(projectDir);
    expect(status.releaseSafety).toMatchObject({
      exists: true,
      mode: "dry_run",
      summary: report.summary,
      valid: true,
    });
  });

  it("keeps the P4a feature flag off by default and preserves demo timeline canonical hash", () => {
    const before = canonicalTimelineHash();

    expect(isP4aReleaseSafetyEnabled()).toBe(false);
    expect(canonicalTimelineHash()).toBe(before);
    expect(before).toBe("6d04dda3c5125310b8251801dd5258525132b1f9297bd963c5275d3565625f55");
  });

  it("keeps delivery_profile not_evaluated when the P4b flag is off", () => {
    const projectDir = makeProject();
    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      category: "delivery_profile",
      status: "not_evaluated",
      check_id: "RSCHK_delivery_profile_p4b",
    }));
  });

  it("returns real delivery_profile checks when the P4b flag is on and artifacts match", () => {
    const projectDir = makeProject();
    writeDeliveryProfileInputs(projectDir, "valid_youtube_16x9_public.yaml", { integrated_lufs: -14, true_peak_dbtp: -1.2 });
    process.env.ENABLE_P4B_DELIVERY_PROFILES = "true";

    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    const deliveryChecks = report.checks.filter((check) => check.category === "delivery_profile");
    expect(deliveryChecks.length).toBeGreaterThan(1);
    expect(deliveryChecks.every((check) => check.status !== "not_evaluated")).toBe(true);
    expect(deliveryChecks.every((check) => check.status !== "fail")).toBe(true);
  });

  it("returns fatal delivery_profile severity when public profiles are absent", () => {
    const projectDir = makeProject();
    process.env.ENABLE_P4B_DELIVERY_PROFILES = "true";

    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      category: "delivery_profile",
      check_id: "RSCHK_delivery_profile_required_absent",
      severity: "fatal",
      status: "fail",
    }));
  });

  it("returns blocker delivery_profile severity when public loudness mismatches package QA metrics", () => {
    const projectDir = makeProject();
    writeDeliveryProfileInputs(projectDir, "valid_youtube_16x9_public.yaml", { integrated_lufs: -24, true_peak_dbtp: -1.2 });
    process.env.ENABLE_P4B_DELIVERY_PROFILES = "true";

    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.checks.some((check) =>
      check.category === "delivery_profile" &&
      check.check_id.includes("audio") &&
      check.severity === "blocker" &&
      check.status === "fail"
    )).toBe(true);
  });

  it("adds a passing calibration check when required calibrated confidence has a fresh report", () => {
    const projectDir = makeProject();
    writeDeliveryProfileInputs(projectDir, "edge_calibrated_confidence_required.yaml", { integrated_lufs: -14, true_peak_dbtp: -1.2 });
    writeCalibrationReport(projectDir);
    process.env.ENABLE_P4B_DELIVERY_PROFILES = "true";
    process.env.ENABLE_P4C_CONFIDENCE_CALIBRATION = "true";

    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      category: "delivery_profile",
      check_id: "RSCHK_delivery_profile_DPROF_calibrated_confidence_confidence_calibration",
      severity: "info",
      status: "pass",
    }));
  });

  it("adds a blocker calibration check when a public or external profile requires calibration and the report is absent", () => {
    const projectDir = makeProject();
    writeDeliveryProfileInputs(projectDir, "edge_calibrated_confidence_required.yaml", { integrated_lufs: -14, true_peak_dbtp: -1.2 });
    process.env.ENABLE_P4B_DELIVERY_PROFILES = "true";
    process.env.ENABLE_P4C_CONFIDENCE_CALIBRATION = "true";

    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      category: "delivery_profile",
      check_id: "RSCHK_delivery_profile_DPROF_calibrated_confidence_confidence_calibration",
      severity: "blocker",
      status: "fail",
    }));
  });

  it("adds a warning calibration check when the calibration report artifact versions are stale", () => {
    const projectDir = makeProject();
    writeDeliveryProfileInputs(projectDir, "edge_calibrated_confidence_required.yaml", { integrated_lufs: -14, true_peak_dbtp: -1.2 });
    writeCalibrationReport(projectDir, {
      artifact_versions: {
        audio_story_graph_version: { version: "analysis-v1", hash: `sha256:${"0".repeat(64)}` },
        continuity_graph_version: { version: "analysis-v1", hash: `sha256:${"1".repeat(64)}` },
        assets_version: { version: "assets-v1", hash: `sha256:${"2".repeat(64)}` },
      },
    });
    process.env.ENABLE_P4B_DELIVERY_PROFILES = "true";
    process.env.ENABLE_P4C_CONFIDENCE_CALIBRATION = "true";

    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      category: "delivery_profile",
      check_id: "RSCHK_delivery_profile_DPROF_calibrated_confidence_confidence_calibration",
      severity: "warning",
      status: "fail",
    }));
  });

  it("keeps P4b delivery profile behavior unchanged when requires_calibrated_confidence is false", () => {
    const projectDir = makeProject();
    writeDeliveryProfileInputs(projectDir, "valid_youtube_16x9_public.yaml", { integrated_lufs: -14, true_peak_dbtp: -1.2 });
    process.env.ENABLE_P4B_DELIVERY_PROFILES = "true";

    const p4bOnly = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    }).checks.filter((check) => check.category === "delivery_profile");

    process.env.ENABLE_P4C_CONFIDENCE_CALIBRATION = "true";
    const p4cEnabled = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    }).checks.filter((check) => check.category === "delivery_profile");

    expect(p4cEnabled).toEqual(p4bOnly);
  });

  it("keeps delivery profile calibration unevaluated when the P4c flag is off", () => {
    const projectDir = makeProject();
    writeDeliveryProfileInputs(projectDir, "edge_calibrated_confidence_required.yaml", { integrated_lufs: -14, true_peak_dbtp: -1.2 });
    process.env.ENABLE_P4B_DELIVERY_PROFILES = "true";

    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.checks.some((check) => check.check_id.includes("confidence_calibration"))).toBe(false);
  });

  it("adds a blocker source_manifest check for stale search index when P4d full autonomy is enabled", () => {
    const projectDir = makeProject();
    writeStaleSearchIndexManifest(projectDir);
    process.env.ENABLE_P4D_SEARCH_INDEX = "true";
    process.env.SEARCH_INDEX_AUTONOMY = "full";

    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      category: "source_manifest",
      check_id: "RSCHK_source_manifest_search_index_stale",
      severity: "blocker",
      status: "fail",
    }));
  });

  it("adds a warning source_manifest check for stale search index in interactive mode", () => {
    const projectDir = makeProject();
    writeStaleSearchIndexManifest(projectDir);
    process.env.ENABLE_P4D_SEARCH_INDEX = "true";
    process.env.SEARCH_INDEX_AUTONOMY = "interactive";

    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      category: "source_manifest",
      check_id: "RSCHK_source_manifest_search_index_stale",
      severity: "warning",
      status: "fail",
    }));
  });

  it("does not add search stale checks when the P4d feature flag is off", () => {
    const projectDir = makeProject();
    writeStaleSearchIndexManifest(projectDir);

    const report = buildReleaseSafetyReport({
      projectDir,
      producer: "/package",
      mode: "dry_run",
      createdAt: "2026-04-26T00:00:00Z",
    });

    expect(report.checks.some((check) => check.check_id === "RSCHK_source_manifest_search_index_stale")).toBe(false);
  });
});

function writeDeliveryProfileInputs(
  projectDir: string,
  fixtureName: string,
  metrics: { integrated_lufs: number; true_peak_dbtp: number },
): void {
  fs.writeFileSync(
    path.join(projectDir, "05_timeline/timeline.json"),
    JSON.stringify({
      version: "tl_fixture_001",
      project_id: "p4a-runtime",
      created_at: "2026-04-26T00:00:00Z",
      sequence: {
        fps_num: 24,
        fps_den: 1,
        width: 1920,
        height: 1080,
        output_aspect_ratio: "16:9",
      },
      tracks: {
        video: [{ clips: [{ timeline_in_frame: 0, timeline_duration_frames: 720 }] }],
        caption: [{ clips: [{ caption_id: "CAP_001" }] }],
      },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectDir, "07_package/qa-report.json"),
    JSON.stringify({ passed: true, metrics }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectDir, "07_package/package_manifest.json"),
    JSON.stringify({
      version: "1.0.0",
      project_id: "p4a-runtime",
      artifacts: {
        final_video: { path: "07_package/video/final.mp4" },
        captions: [{ kind: "speech", delivery: "vtt", path: "07_package/captions/speech.vtt" }],
        qa_report: { path: "07_package/qa-report.json" },
      },
    }, null, 2),
  );
  const profilesDir = path.join(projectDir, "07_package/delivery_profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.copyFileSync(
    path.resolve("tests/fixtures/delivery_profiles", fixtureName),
    path.join(profilesDir, fixtureName),
  );
}

function writeCalibrationReport(projectDir: string, overrides: Record<string, unknown> = {}): void {
  const reportPath = path.join(projectDir, "08_eval/confidence_calibration_report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const assetsPath = path.join(projectDir, "03_analysis/assets.json");
  if (!fs.existsSync(assetsPath)) {
    fs.writeFileSync(assetsPath, JSON.stringify({ project_id: "p4a-runtime", artifact_version: "assets-v1", items: [] }, null, 2));
  }
  const report = {
    version: "1.0.0",
    project_id: "p4a-runtime",
    artifact_version: "calibration-report-v1",
    created_at: "2026-04-27T00:00:00Z",
    report_id: "CALRPT_release_safety",
    eval_set_id: "EVALSET_release_safety",
    calibration_model_id: "CALMOD_baseline_v1",
    artifact_versions: {
      audio_story_graph_version: { version: "analysis-v1", hash: sha256File(path.join(projectDir, "03_analysis/audio_story_graph.json")) },
      continuity_graph_version: { version: "analysis-v1", hash: sha256File(path.join(projectDir, "03_analysis/continuity_graph.json")) },
      assets_version: { version: "assets-v1", hash: sha256File(assetsPath) },
    },
    metrics: {
      boundary_error_seconds: 0.1,
      tag_precision: 0.9,
      tag_recall: 0.85,
      peak_timestamp_error_seconds: 0.2,
      speaker_attribution_accuracy: 0.92,
      continuity_match_precision: 0.88,
      release_safety_false_negative_rate: 0.01,
    },
    buckets: [{ bucket: "high", sample_count: 10, observed_accuracy: 0.82, expected_accuracy: 0.85 }],
    failures: [],
    recommendations: [],
    provenance: {
      producer: "scripts/eval-confidence-calibration.ts",
      inputs: [],
      hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: ["created_at"] },
    },
    ...overrides,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function writeStaleSearchIndexManifest(projectDir: string): void {
  fs.mkdirSync(path.join(projectDir, "03_analysis/search"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "03_analysis/search/segment_text_index.json"),
    JSON.stringify({
      version: "1.0.0",
      project_id: "p4a-runtime",
      artifact_version: "text-index-v1",
      created_at: "2026-04-27T00:00:00Z",
      index_id: "SIDX_release_safety",
      segments: [],
      provenance: {
        producer: "scripts/rebuild-segment-search-index.ts",
        inputs: [],
        hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: ["created_at"] },
      },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectDir, "03_analysis/search/segment_search_index_manifest.json"),
    JSON.stringify({
      version: "1.0.0",
      project_id: "p4a-runtime",
      artifact_version: "search-index-v1",
      created_at: "2026-04-27T00:00:00Z",
      index_id: "SIDX_release_safety",
      inputs: {
        source_media_manifest_hash: `sha256:${"0".repeat(64)}`,
        assets_hash: `sha256:${"1".repeat(64)}`,
        segments_hash: `sha256:${"2".repeat(64)}`,
        transcripts_hashes: [],
        audio_story_graph_hash: `sha256:${"3".repeat(64)}`,
        continuity_graph_hash: `sha256:${"4".repeat(64)}`,
        editorial_preference_memory_hash: null,
        coverage_report_hash: `sha256:${"5".repeat(64)}`,
      },
      structure: [
        { field: "transcript_text", source_prefix: "TR_", indexed: true, tokenizer: "japanese_morpheme" },
      ],
      text_index: {
        path: "03_analysis/search/segment_text_index.json",
        hash: `sha256:${"6".repeat(64)}`,
      },
      vector_shards: [],
      provenance: {
        producer: "scripts/rebuild-segment-search-index.ts",
        inputs: [],
        hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: ["created_at"] },
      },
    }, null, 2),
  );
}

function sha256File(filePath: string): string {
  return `sha256:${createRequire(import.meta.url)("node:crypto").createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}
