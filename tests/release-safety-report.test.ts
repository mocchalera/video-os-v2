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

afterEach(() => {
  delete process.env.ENABLE_P4A_RELEASE_SAFETY;
  delete process.env.ENABLE_P4B_DELIVERY_PROFILES;
  delete process.env.RELEASE_SAFETY_MODE;
});

describe("P4a release_safety_report", () => {
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
    expect(before).toBe("68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100");
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
