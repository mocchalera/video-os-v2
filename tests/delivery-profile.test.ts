import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  computeDeliveryProfileHash,
  generateDeliveryProfileChecks,
  isP4bDeliveryProfilesEnabled,
  loadDeliveryProfiles,
  validateProfile,
  type DeliveryProfile,
} from "../runtime/artifacts/p4b-delivery-profile.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const FIXTURE_DIR = path.resolve("tests/fixtures/delivery_profiles");
const SCHEMA_PATH = path.resolve("schemas/delivery-profile.schema.json");

const validFixtures = [
  "valid_youtube_16x9_public.yaml",
  "valid_shorts_9x16_public.yaml",
  "valid_instagram_reel_9x16_external.yaml",
  "valid_internal_review_strict.yaml",
  "valid_client_handoff_external.yaml",
];

function readProfile(fileName: string): DeliveryProfile {
  return parseYaml(fs.readFileSync(path.join(FIXTURE_DIR, fileName), "utf-8")) as DeliveryProfile;
}

function schemaValidator(): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8")));
}

function makeProfile(overrides: Partial<DeliveryProfile> = {}): DeliveryProfile {
  const profile = readProfile("valid_youtube_16x9_public.yaml");
  return { ...profile, ...overrides };
}

function makeProjectWithProfiles(profiles: DeliveryProfile[]): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4b-delivery-profile-"));
  const profileDir = path.join(projectDir, "07_package/delivery_profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  profiles.forEach((profile, index) => {
    fs.writeFileSync(path.join(profileDir, `${index + 1}-${profile.profile_id}.yaml`), stringifyYaml(profile));
  });
  return projectDir;
}

function matchingTimeline(): Record<string, unknown> {
  return {
    version: "tl_fixture_001",
    project_id: "delivery-fixture",
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
  };
}

function matchingPackageManifest(): Record<string, unknown> {
  return {
    artifacts: {
      final_video: { path: "07_package/video/final.mp4", sha256: "sha256:" + "a".repeat(64) },
      captions: [{ kind: "speech", delivery: "vtt", path: "07_package/captions/speech.vtt", sha256: "sha256:" + "b".repeat(64) }],
      qa_report: { path: "07_package/qa-report.json", sha256: "sha256:" + "c".repeat(64) },
    },
  };
}

function matchingQaReport(): Record<string, unknown> {
  return {
    passed: true,
    metrics: {
      integrated_lufs: -14,
      true_peak_dbtp: -1.2,
    },
  };
}

afterEach(() => {
  delete process.env.ENABLE_P4B_DELIVERY_PROFILES;
});

describe("P4b delivery profile schema and runtime checks", () => {
  it.each(validFixtures)("accepts valid fixture %s", (fixture) => {
    const validate = schemaValidator();
    const profile = readProfile(fixture);

    expect(validate(profile), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateProfile(profile).valid).toBe(true);
  });

  it.each([
    "invalid_missing_platform.yaml",
    "invalid_aspect_ratio_format.yaml",
  ])("rejects invalid fixture %s", (fixture) => {
    const validate = schemaValidator();
    const profile = readProfile(fixture);

    expect(validate(profile) && validateProfile(profile).valid).toBe(false);
  });

  it.each([
    "edge_calibrated_confidence_required.yaml",
    "edge_caption_burned_with_sidecar.yaml",
  ])("keeps edge fixture schema-valid: %s", (fixture) => {
    const validate = schemaValidator();
    const profile = readProfile(fixture);

    expect(validate(profile), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validateProfile(profile).valid).toBe(true);
  });

  it("emits runtime warnings for burned_in captions with a sidecar format", () => {
    const result = validateProfile(readProfile("edge_caption_burned_with_sidecar.yaml"));
    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("burned_in"))).toBe(true);
  });

  it("computes deterministic yaml-to-normalized-json-v1 hashes with created_at excluded", () => {
    const profile = readProfile("valid_youtube_16x9_public.yaml");
    const later = { ...profile, created_at: "2026-04-28T00:00:00Z" };

    expect(computeDeliveryProfileHash(profile)).toBe(computeDeliveryProfileHash(later));
    expect(computeDeliveryProfileHash(profile)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("validates profile_id prefix, platform, release_mode, and aspect_ratio enums", () => {
    expect(validateProfile(makeProfile({ profile_id: "BAD_001" })).valid).toBe(false);
    expect(validateProfile(makeProfile({ platform: "vimeo" as DeliveryProfile["platform"] })).valid).toBe(false);
    expect(validateProfile(makeProfile({ release_mode: "partner" as DeliveryProfile["release_mode"] })).valid).toBe(false);
    expect(validateProfile({
      ...makeProfile(),
      video_constraints: { ...makeProfile().video_constraints, aspect_ratio: "2:1" as DeliveryProfile["video_constraints"]["aspect_ratio"] },
    }).valid).toBe(false);
  });

  it("validates duration min <= max", () => {
    const result = validateProfile({
      ...makeProfile(),
      duration_constraints: { min_seconds: 90, max_seconds: 20 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("min_seconds"))).toBe(true);
  });

  it("validates caption mode and sidecar_format consistency", () => {
    expect(validateProfile({
      ...makeProfile(),
      caption_constraints: { mode: "sidecar", sidecar_format: null, language_required: ["ja"] },
    }).valid).toBe(false);
    expect(validateProfile({
      ...makeProfile(),
      caption_constraints: { mode: "none", sidecar_format: "srt", language_required: [] },
    }).valid).toBe(false);
  });

  it("loads multiple delivery_profiles from a project directory", () => {
    const projectDir = makeProjectWithProfiles([
      readProfile("valid_youtube_16x9_public.yaml"),
      readProfile("valid_internal_review_strict.yaml"),
    ]);

    const result = loadDeliveryProfiles(projectDir);
    expect(result.profiles).toHaveLength(2);
    expect(result.malformed).toHaveLength(0);
  });

  it("returns pass checks when a profile matches timeline, package manifest, captions, and QA metrics", () => {
    const checks = generateDeliveryProfileChecks({
      projectDir: "/tmp/p4b-pass",
      timeline: matchingTimeline(),
      packageManifest: matchingPackageManifest(),
      packageQaReport: matchingQaReport(),
      captionArtifacts: [{ path: "07_package/captions/speech.vtt", format: "vtt" }],
      profiles: [readProfile("valid_youtube_16x9_public.yaml")],
      expectedReleaseMode: "public",
    });

    expect(checks.every((check) => check.category === "delivery_profile")).toBe(true);
    expect(checks.some((check) => check.status === "pass")).toBe(true);
    expect(checks.every((check) => check.status !== "fail")).toBe(true);
  });

  it("returns fatal when no public/external profile exists for a public workflow", () => {
    const checks = generateDeliveryProfileChecks({
      projectDir: "/tmp/p4b-absent",
      timeline: matchingTimeline(),
      packageManifest: matchingPackageManifest(),
      packageQaReport: matchingQaReport(),
      captionArtifacts: [],
      profiles: [readProfile("valid_internal_review_strict.yaml")],
      expectedReleaseMode: "public",
    });

    expect(checks).toContainEqual(expect.objectContaining({
      check_id: "RSCHK_delivery_profile_required_absent",
      severity: "fatal",
      status: "fail",
    }));
  });

  it("escalates mismatches as blocker for public/external and warning for internal profiles", () => {
    const publicChecks = generateDeliveryProfileChecks({
      projectDir: "/tmp/p4b-public",
      timeline: { ...matchingTimeline(), sequence: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, output_aspect_ratio: "9:16" } },
      packageManifest: matchingPackageManifest(),
      packageQaReport: { passed: true, metrics: { integrated_lufs: -24, true_peak_dbtp: -0.5 } },
      captionArtifacts: [],
      profiles: [readProfile("valid_youtube_16x9_public.yaml")],
      expectedReleaseMode: "public",
    });
    const internalChecks = generateDeliveryProfileChecks({
      projectDir: "/tmp/p4b-internal",
      timeline: { ...matchingTimeline(), sequence: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, output_aspect_ratio: "9:16" } },
      packageManifest: matchingPackageManifest(),
      packageQaReport: { passed: true, metrics: { integrated_lufs: -24, true_peak_dbtp: -0.5 } },
      captionArtifacts: [],
      profiles: [readProfile("valid_internal_review_strict.yaml")],
      expectedReleaseMode: "internal",
    });

    expect(publicChecks.some((check) => check.severity === "blocker" && check.status === "fail")).toBe(true);
    expect(internalChecks.some((check) => check.severity === "warning" && check.status === "fail")).toBe(true);
  });

  it("keeps the P4b feature flag off by default", () => {
    expect(isP4bDeliveryProfilesEnabled()).toBe(false);
  });
});
