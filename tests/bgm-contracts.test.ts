import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import { validateProject } from "../runtime/validation/schema-validator.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const FIXTURE_DIR = path.resolve("tests/fixtures/bgm_contracts");
const tempDirs: string[] = [];

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readYaml(filePath: string): unknown {
  return parseYaml(fs.readFileSync(filePath, "utf8"));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compileSchema(schemaFile: string): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(readJson(path.resolve("schemas", schemaFile)) as object);
}

function expectValid(schemaFile: string, data: unknown): void {
  const validate = compileSchema(schemaFile);
  expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

function expectInvalid(schemaFile: string, data: unknown): void {
  const validate = compileSchema(schemaFile);
  expect(validate(data)).toBe(false);
  expect(validate.errors?.length).toBeGreaterThan(0);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("BGM Core v1 contracts", () => {
  it("accepts the metadata-only two-track pack fixture", () => {
    const pack = readJson(path.join(FIXTURE_DIR, "valid_two_track_pack.json")) as {
      tracks: unknown[];
      catalog_license: string;
      default_content_license: string;
    };

    expectValid("bgm-pack-manifest.schema.json", pack);
    expect(pack.tracks).toHaveLength(2);
    expect(pack.catalog_license).toBe("CC0-1.0");
    expect(pack.default_content_license).toBe("CC0-1.0");
  });

  it("rejects traversal refs and incomplete editorial axes", () => {
    expectInvalid(
      "bgm-pack-manifest.schema.json",
      readJson(path.join(FIXTURE_DIR, "invalid_empty_pack.json")),
    );

    const traversal = clone(readJson(path.join(FIXTURE_DIR, "valid_two_track_pack.json"))) as {
      tracks: Array<{ full_mix: { path: string }; axes: Record<string, unknown> }>;
    };
    traversal.tracks[0].full_mix.path = "../outside.wav";
    expectInvalid("bgm-pack-manifest.schema.json", traversal);

    for (const unsafePath of ["C:/outside.wav", "audio//track.wav", "audio/track.wav/", "audio/\u0001track.wav"]) {
      const unsafe = clone(readJson(path.join(FIXTURE_DIR, "valid_two_track_pack.json"))) as {
        tracks: Array<{ full_mix: { path: string } }>;
      };
      unsafe.tracks[0].full_mix.path = unsafePath;
      expectInvalid("bgm-pack-manifest.schema.json", unsafe);
    }

    const incompleteAxes = clone(readJson(path.join(FIXTURE_DIR, "valid_two_track_pack.json"))) as {
      tracks: Array<{ axes: Record<string, unknown> }>;
    };
    delete incompleteAxes.tracks[0].axes.speech_friendliness;
    expectInvalid("bgm-pack-manifest.schema.json", incompleteAxes);

    const analyzedSource = clone(readJson(path.join(FIXTURE_DIR, "valid_two_track_pack.json"))) as {
      tracks: Array<{ axes: { energy: { source: string } } }>;
    };
    analyzedSource.tracks[0].axes.energy.source = "analyzed";
    expectInvalid("bgm-pack-manifest.schema.json", analyzedSource);

    const embeddedArchiveReceipt = clone(readJson(path.join(FIXTURE_DIR, "valid_two_track_pack.json"))) as Record<string, unknown>;
    embeddedArchiveReceipt.archive_sha256 = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    expectInvalid("bgm-pack-manifest.schema.json", embeddedArchiveReceipt);
  });

  it("accepts degraded track analysis while rejecting invalid hashes and scores", () => {
    const analysis = readJson(path.join(FIXTURE_DIR, "valid_track_analysis.json"));
    expectValid("bgm-track-analysis.schema.json", analysis);

    const badHash = clone(analysis) as { input_content_hash: string };
    badHash.input_content_hash = "sha256:not-a-hash";
    expectInvalid("bgm-track-analysis.schema.json", badHash);

    const badScore = clone(analysis) as { spectrum: { speech_band_masking_score: number } };
    badScore.spectrum.speech_band_masking_score = 1.1;
    expectInvalid("bgm-track-analysis.schema.json", badScore);

    const authoredAnalysisAxis = clone(analysis) as {
      semantics: { editorial_axes: { energy: { source: string } } };
    };
    authoredAnalysisAxis.semantics.editorial_axes.energy.source = "authored";
    expectInvalid("bgm-track-analysis.schema.json", authoredAnalysisAxis);

    const unsafeEmbedding = clone(analysis) as {
      semantics: {
        status: string;
        clap_embedding: unknown;
        degraded_reasons: string[];
      };
    };
    unsafeEmbedding.semantics.status = "degraded";
    unsafeEmbedding.semantics.clap_embedding = {
      path: "/tmp/private.embedding",
      content_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      dimensions: 512,
      model_revision: "test",
    };
    unsafeEmbedding.semantics.degraded_reasons = ["embedding path test"];
    expectInvalid("bgm-track-analysis.schema.json", unsafeEmbedding);

    const inconsistentReady = clone(analysis) as { status: string; degraded_reasons: string[] };
    inconsistentReady.status = "ready";
    inconsistentReady.degraded_reasons = [];
    expectInvalid("bgm-track-analysis.schema.json", inconsistentReady);

    const unstableHashPolicy = clone(analysis) as { hash_policy: { excluded_fields: string[] } };
    unstableHashPolicy.hash_policy.excluded_fields = ["created_at", "analysis_hash"];
    expectInvalid("bgm-track-analysis.schema.json", unstableHashPolicy);
  });

  it("requires non-null core measurements when track analysis is ready", () => {
    const ready = clone(readJson(path.join(FIXTURE_DIR, "valid_track_analysis.json"))) as any;
    ready.status = "ready";
    ready.degraded_reasons = [];
    ready.semantics.status = "ready";
    ready.semantics.clap_embedding = {
      path: "embeddings/synthetic-calm-low-01.bin",
      content_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      dimensions: 512,
      model_revision: "clap-test-v1",
    };
    ready.semantics.mood_scores = [{ label: "calm", score: 0.9 }];
    ready.semantics.genre_scores = [{ label: "corporate", score: 0.8 }];
    ready.semantics.degraded_reasons = [];
    ready.analyzers = ready.analyzers.map((analyzer: any) => ({
      ...analyzer,
      model_revision: analyzer.model_revision ?? "deterministic-test",
      status: "ready",
    }));
    expectValid("bgm-track-analysis.schema.json", ready);

    for (const [section, field] of [
      ["loudness", "integrated_lufs"],
      ["loudness", "loudness_range_lu"],
      ["loudness", "true_peak_dbtp"],
      ["tempo", "bpm"],
      ["tempo", "meter"],
    ] as const) {
      const missingMeasurement = clone(ready);
      missingMeasurement[section][field] = null;
      expectInvalid("bgm-track-analysis.schema.json", missingMeasurement);
    }
  });

  it("accepts an explainable metadata fallback selection", () => {
    const selection = readJson(path.join(FIXTURE_DIR, "valid_selection.json"));
    expectValid("bgm-selection.schema.json", selection);
    expectInvalid(
      "bgm-selection.schema.json",
      readJson(path.join(FIXTURE_DIR, "invalid_locked_selection.json")),
    );

    const unlocked = clone(selection) as { mode: string; operator_override: null };
    unlocked.mode = "operator_locked";
    expectInvalid("bgm-selection.schema.json", unlocked);

    const extraScore = clone(selection) as {
      candidates: Array<{ score_breakdown: Record<string, number> }>;
    };
    extraScore.candidates[0].score_breakdown.unversioned_bonus = 1;
    expectInvalid("bgm-selection.schema.json", extraScore);

    const excessSemanticWeight = clone(selection) as {
      candidates: Array<{ score_breakdown: { semantic_fit: number } }>;
    };
    excessSemanticWeight.candidates[0].score_breakdown.semantic_fit = 30.1;
    expectInvalid("bgm-selection.schema.json", excessSemanticWeight);

    const rankedWithRejection = clone(selection) as {
      candidates: Array<{ rejection_reasons: string[] }>;
    };
    rankedWithRejection.candidates[0].rejection_reasons = ["cannot reject a ranked candidate"];
    expectInvalid("bgm-selection.schema.json", rankedWithRejection);

    const rejectedWithRank = clone(selection) as {
      candidates: Array<{ rank: number | null }>;
    };
    rejectedWithRank.candidates[1].rank = 2;
    expectInvalid("bgm-selection.schema.json", rejectedWithRank);
  });

  it("enforces auto thresholds for semantic and deterministic fallback strategies", () => {
    const available = clone(readJson(path.join(FIXTURE_DIR, "valid_selection.json"))) as any;
    available.mode = "auto";
    available.scoring_strategy.auto_minimum_score = 70;
    available.scoring_strategy.auto_minimum_margin = 8;
    available.semantic_channel = { status: "available", model_revision: "clap-test-v1", warnings: [] };
    available.redistribution_trace = {
      applied: false,
      source_component: "semantic_fit",
      source_weight: 30,
      reason: null,
      allocations: [],
    };
    available.selected.score = 70;
    available.top_two_margin = 8;
    expectValid("bgm-selection.schema.json", available);

    const belowSemanticThreshold = clone(available);
    belowSemanticThreshold.selected.score = 69.9;
    expectInvalid("bgm-selection.schema.json", belowSemanticThreshold);

    const fallback = clone(readJson(path.join(FIXTURE_DIR, "valid_selection.json"))) as any;
    fallback.mode = "auto";
    fallback.selected.score = 78;
    fallback.top_two_margin = 12;
    expectValid("bgm-selection.schema.json", fallback);

    const belowFallbackMargin = clone(fallback);
    belowFallbackMargin.top_two_margin = 11.9;
    expectInvalid("bgm-selection.schema.json", belowFallbackMargin);
  });

  it("accepts a hash-bound permissive rights register and rejects unknown status values", () => {
    const rights = readYaml(path.join(FIXTURE_DIR, "valid_rights_register.yaml"));
    expectValid("rights-license-register.schema.json", rights);

    const invalid = clone(rights) as { items: Array<{ rights_status: string }> };
    invalid.items[0].rights_status = "assumed_ok";
    expectInvalid("rights-license-register.schema.json", invalid);

    const unverifiedLicensed = clone(rights) as any;
    unverifiedLicensed.items[0].integrity = {
      status: "unverified",
      verified_hash: null,
      verified_at: null,
    };
    expectInvalid("rights-license-register.schema.json", unverifiedLicensed);

    const incompleteSimilarityReview = clone(rights) as any;
    incompleteSimilarityReview.items[0].similarity_review = {
      status: "passed",
      reviewer_ref: null,
      reviewed_at: null,
    };
    expectInvalid("rights-license-register.schema.json", incompleteSimilarityReview);

    const absolutePrivateRef = clone(rights) as any;
    absolutePrivateRef.items[0].source_ref = "/Users/operator/private/receipt.pdf";
    expectInvalid("rights-license-register.schema.json", absolutePrivateRef);

    const emptyScope = clone(rights) as any;
    emptyScope.items[0].license.permitted_scopes = [];
    expectInvalid("rights-license-register.schema.json", emptyScope);

    const unclearedGeneratedTrack = clone(rights) as any;
    unclearedGeneratedTrack.items[0].generator = {
      tool: "synthetic-generator",
      model_revision: "test-v1",
      account_tier_at_creation: "unknown",
      paid_tier_confirmed: false,
      terms_revision: "test-terms",
    };
    expectInvalid("rights-license-register.schema.json", unclearedGeneratedTrack);
  });

  it("leaves hash equality, expiry, and requested-scope decisions to the contextual runtime gate", () => {
    const rights = clone(readYaml(path.join(FIXTURE_DIR, "valid_rights_register.yaml"))) as any;
    rights.items[0].integrity.verified_hash =
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    rights.items[0].expires_at = "2020-01-01T00:00:00.000Z";
    rights.items[0].license.permitted_scopes = ["preview_internal"];

    // JSON Schema guarantees shape only. Cross-field content-hash equality,
    // current-time expiry, and requested delivery scope require runtime context.
    expectValid("rights-license-register.schema.json", rights);
  });

  it("registers selection and rights artifacts as optional project contracts", () => {
    const root = fs.mkdtempSync(path.resolve("tests/.tmp-bgm-contracts-"));
    tempDirs.push(root);
    const projectDir = path.join(root, "demo");
    fs.cpSync(path.resolve("projects/demo"), projectDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, "07_package"), { recursive: true });

    fs.writeFileSync(
      path.join(projectDir, "04_plan/bgm_selection.json"),
      JSON.stringify(readJson(path.join(FIXTURE_DIR, "valid_selection.json")), null, 2),
    );
    fs.writeFileSync(
      path.join(projectDir, "07_package/rights_license_register.yaml"),
      fs.readFileSync(path.join(FIXTURE_DIR, "valid_rights_register.yaml")),
    );

    const valid = validateProject(projectDir);
    expect(valid.violations.filter((violation) =>
      violation.artifact === "04_plan/bgm_selection.json"
      || violation.artifact === "07_package/rights_license_register.yaml"
    )).toEqual([]);

    const invalidSelection = readJson(path.join(FIXTURE_DIR, "valid_selection.json")) as { version: string };
    invalidSelection.version = "2.0.0";
    fs.writeFileSync(
      path.join(projectDir, "04_plan/bgm_selection.json"),
      JSON.stringify(invalidSelection, null, 2),
    );

    const invalid = validateProject(projectDir);
    expect(invalid.violations.some((violation) =>
      violation.artifact === "04_plan/bgm_selection.json" && violation.rule === "schema"
    )).toBe(true);
  });
});
