import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EDITORIAL_EYE_GENRES,
  EDITORIAL_EYE_MEDIA_KINDS,
  bytesSha256,
  canonicalJson,
  canonicalSha256,
  evaluateEditorialEye,
  loadEditorialEyeBaseline,
  loadEditorialEyeManifest,
  type EditorialEyeReport,
} from "../runtime/eval/editorial-eye-suite.js";
import { main, parseArgs } from "../scripts/eval.js";
import { buildContractArtifacts, writeContractArtifacts, type FixtureProbeMap } from "../scripts/eval/build-editorial-eye-benchmark-fixtures.js";
import { buildGeneratedMediaSpec, generateEditorialEyeFixtures } from "../scripts/eval/generate-editorial-eye-fixtures.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (options: Record<string, unknown>) => {
  compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown };
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "editorial-eye", "v1");
const manifestPath = path.join(fixtureRoot, "suite.json");
const labelsPath = path.join(fixtureRoot, "labels.json");
const baselinePath = path.join(fixtureRoot, "baseline-report.json");
const resultsPath = path.join(fixtureRoot, "results.json");
const generatedSpecPath = path.join(fixtureRoot, "generated-media-spec.json");
const candidateCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const baselineReportSha256 = "3adbfb07a22da0d2e9fc0a78e223121efeb964cf7a053689c134e0809053a88d";
const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, any>;
}

function committedProbeMap(): FixtureProbeMap {
  const cases = readJson(resultsPath).cases as any[];
  const probes = Object.fromEntries(EDITORIAL_EYE_MEDIA_KINDS.map((kind) => {
    const found = cases.find((item) => item.media_kind === kind)?.decoded_fixture_fingerprints;
    return [kind, found ?? { decoded_frame_sha256: "0".repeat(64), stream_topology: "video:png", duration_ms: 0, generated_bytes_sha256: "0".repeat(64) }];
  }));
  return probes as FixtureProbeMap;
}

function temporaryResult(mutate: (value: Record<string, any>) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-eye-result-"));
  temporaryRoots.push(root);
  const target = path.join(root, "results.json");
  const value = readJson(resultsPath);
  mutate(value);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

function temporaryContract(mutate: (artifacts: { suite: any; labels: any; results: any; baseline: any }) => void): { suite: string; labels: string; results: string; baseline: string; baselineSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-eye-contract-"));
  temporaryRoots.push(root);
  const artifacts = { suite: readJson(manifestPath), labels: readJson(labelsPath), results: readJson(resultsPath), baseline: readJson(baselinePath) };
  mutate(artifacts);
  const manifestSha = canonicalSha256(artifacts.suite);
  artifacts.labels.fixture_manifest_sha256 = manifestSha;
  artifacts.results.fixture_manifest_sha256 = manifestSha;
  artifacts.baseline.fixture_manifest_sha256 = manifestSha;
  artifacts.baseline.candidate_commit = artifacts.suite.baseline_commit;
  artifacts.baseline.label_version = artifacts.labels.label_version;
  artifacts.baseline.generator = artifacts.suite.generator;
  artifacts.baseline.provenance = artifacts.suite.contract_provenance;
  const paths = { suite: "", labels: "", results: "", baseline: "" };
  for (const name of ["suite", "labels", "results", "baseline"] as const) {
    const file = path.join(root, `${name === "baseline" ? "baseline-report" : name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(artifacts[name], null, 2)}\n`);
    paths[name] = file;
  }
  return { ...paths, baselineSha: bytesSha256(fs.readFileSync(paths.baseline)) };
}

function evaluate(overrides: Partial<Parameters<typeof evaluateEditorialEye>[0]> = {}): EditorialEyeReport {
  return evaluateEditorialEye({ repoRoot, manifestPath, labelsPath, baselineReportPath: baselinePath, baselineReportSha256, resultsPath, candidateCommit, ...overrides });
}

function evaluateContract(contract: ReturnType<typeof temporaryContract>): EditorialEyeReport {
  return evaluate({ manifestPath: contract.suite, labelsPath: contract.labels, baselineReportPath: contract.baseline, baselineReportSha256: contract.baselineSha, resultsPath: contract.results });
}

describe("Editorial Eye matrix and schemas", () => {
  it("validates suite, labels, results, report, and exact generated fixtures", () => {
    for (const [schemaName, fixtureName] of [
      ["editorial-eye-benchmark-suite.schema.json", "suite.json"],
      ["editorial-eye-benchmark-labels.schema.json", "labels.json"],
      ["editorial-eye-benchmark-results.schema.json", "results.json"],
      ["editorial-eye-benchmark-report.schema.json", "baseline-report.json"],
    ]) {
      const validate = new Ajv2020({ allErrors: true, strict: false }).compile(readJson(path.join(repoRoot, "schemas", schemaName)));
      expect(validate(readJson(path.join(fixtureRoot, fixtureName))), JSON.stringify(validate.errors)).toBe(true);
    }
    const built = buildContractArtifacts(committedProbeMap());
    expect(built.suite).toEqual(readJson(manifestPath));
    expect(built.labels).toEqual(readJson(labelsPath));
    expect(built.results).toEqual(readJson(resultsPath));
    expect(built.baseline).toEqual(readJson(baselinePath));
    expect(buildGeneratedMediaSpec()).toEqual(readJson(generatedSpecPath));
  });

  it("enumerates each of the 35 genre/media cells exactly once", () => {
    const { manifest } = loadEditorialEyeManifest(repoRoot, manifestPath);
    expect(manifest.cases).toHaveLength(35);
    expect(new Set(manifest.cases.map((item) => `${item.genre}:${item.media_kind}`)).size).toBe(35);
    for (const genre of EDITORIAL_EYE_GENRES) for (const kind of EDITORIAL_EYE_MEDIA_KINDS) {
      expect(manifest.cases.some((item) => item.genre === genre && item.media_kind === kind)).toBe(true);
    }
  });

  it("rejects missing and duplicate matrix cells", () => {
    const missing = temporaryContract(({ suite, labels, results }) => {
      const id = suite.cases.at(-1).case_id;
      suite.cases.pop();
      labels.automatic_ground_truth = labels.automatic_ground_truth.filter((item: any) => item.case_id !== id);
      results.cases = results.cases.filter((item: any) => item.case_id !== id);
    });
    expect(() => loadEditorialEyeManifest(repoRoot, missing.suite)).toThrow(/schema validation|exact 7x5/);
    const duplicate = temporaryContract(({ suite }) => {
      suite.cases.at(-1).genre = suite.cases[0].genre;
      suite.cases.at(-1).media_kind = suite.cases[0].media_kind;
    });
    expect(() => loadEditorialEyeManifest(repoRoot, duplicate.suite)).toThrow("duplicate matrix cell");
  });

  it("requires approval_record for blocking thresholds and approved labels, and rejects unresolved approved disagreement", () => {
    const suite = readJson(manifestPath);
    suite.gate_policy.human_accuracy.enforcement = "blocking";
    const suiteValidate = new Ajv2020({ allErrors: true, strict: false }).compile(readJson(path.join(repoRoot, "schemas", "editorial-eye-benchmark-suite.schema.json")));
    expect(suiteValidate(suite)).toBe(false);

    const labels = readJson(labelsPath);
    labels.human_evaluation.status = "approved";
    const labelsValidate = new Ajv2020({ allErrors: true, strict: false }).compile(readJson(path.join(repoRoot, "schemas", "editorial-eye-benchmark-labels.schema.json")));
    expect(labelsValidate(labels)).toBe(false);
    const unresolved = temporaryContract(({ labels: changed }) => {
      changed.human_evaluation = {
        status: "approved", approval_record: { record_id: "temp", approved_by: "reviewer", approved_at: "2026-07-20T00:00:00Z", label_version: "labels-v2" }, annotations: [],
        annotator_disagreement: [{ case_id: changed.automatic_ground_truth[0].case_id, field_or_pair_id: "primary_signal", annotator_ids: ["a", "b"], values: ["x", "y"], resolution: "unresolved" }],
      };
    });
    expect(() => evaluateContract(unresolved)).toThrow(/unresolved annotator disagreement|schema validation/);
  });

  it("binds an approved human record to the outer label version", () => {
    const mismatch = temporaryContract(({ labels }) => {
      labels.human_evaluation = {
        status: "approved",
        approval_record: { record_id: "temp", approved_by: "reviewer", approved_at: "2026-07-20T00:00:00Z", label_version: "labels-v1" },
        annotations: [],
        annotator_disagreement: [],
      };
    });
    expect(() => evaluateContract(mismatch)).toThrow("human approval_record label_version mismatch");
  });
});

describe("Editorial Eye metric adapters", () => {
  it("reports unsupported sequence cells instead of hiding them behind 100%", () => {
    const report = evaluate();
    expect(report.metrics.automatic_binary.grounded_visual_success).toEqual({ status: "measured", value: 1, numerator: 21, denominator: 21 });
    expect(report.breakdowns.by_media_kind.sequence).toEqual({ applicable: 0, unsupported: 7, unmeasured: 0, success: 0, failure: 0 });
    expect(report.regressions.filter((item) => item.media_kind === "sequence" && item.reason === "unsupported_capability")).toHaveLength(7);
    expect(report.breakdowns.metrics_by_media_kind.sequence.grounded_visual_success.status).toBe("unmeasured");
    expect(report.breakdowns.metrics_by_genre.interview_dialogue.observation_field_coverage.denominator).toBe(17);
    expect(report.verdict.status).toBe("pass");
  });

  it("rejects adversarial status/support claims and preserves unsupported-capability truth", () => {
    const sequenceSuccess = temporaryResult((results) => {
      const item = results.cases.find((entry: any) => entry.media_kind === "sequence");
      item.status = "success";
      item.supported = true;
    });
    expect(() => evaluate({ resultsPath: sequenceSuccess })).toThrow("unsupported_capability requires status=unsupported and supported=false");

    const falseSuccess = temporaryResult((results) => {
      const item = results.cases.find((entry: any) => entry.media_kind === "video");
      item.status = "success";
      item.supported = false;
    });
    expect(() => evaluate({ resultsPath: falseSuccess })).toThrow("status=success requires supported=true");

    const falseUnsupported = temporaryResult((results) => {
      const item = results.cases.find((entry: any) => entry.media_kind === "video");
      item.status = "unsupported";
      item.supported = true;
    });
    expect(() => evaluate({ resultsPath: falseUnsupported })).toThrow("status=unsupported requires supported=false");
  });

  it.each([
    ["automatic observation field", (artifacts: any) => {
      const item = artifacts.labels.automatic_ground_truth[0];
      item.observation_expected_facts.push({ ...item.observation_expected_facts[0] });
    }, "automatic labels"],
    ["automatic pair id", (artifacts: any) => {
      const item = artifacts.labels.automatic_ground_truth[0];
      item.pair_labels = [{ pair_id: "duplicate-pair", relation: "cut" }, { pair_id: "duplicate-pair", relation: "match" }];
    }, "pair ids"],
    ["result observation field", (artifacts: any) => {
      const item = artifacts.results.cases[0];
      item.observations.push({ ...item.observations[0] });
    }, "results"],
    ["result prediction pair id", (artifacts: any) => {
      const item = artifacts.results.cases[0];
      item.pair_relation_predictions = [{ pair_id: "duplicate-pair", relation: "cut", confidence: 1 }, { pair_id: "duplicate-pair", relation: "match", confidence: 1 }];
    }, "pair prediction ids"],
  ])("rejects duplicate %s before Map evaluation", (_name, mutate, message) => {
    const duplicate = temporaryContract(mutate);
    expect(() => evaluateContract(duplicate)).toThrow(message);
  });

  it("excludes audio and grounding-only evidence from visual/observation denominators while retaining counts", () => {
    expect(evaluate().metrics.automatic_binary.grounded_visual_success.denominator).toBe(21);
    const contract = temporaryContract(({ suite, results }) => {
      const item = suite.cases.find((entry: any) => entry.media_kind === "image");
      item.evidence_tier = "grounding_contract_only";
      const result = results.cases.find((entry: any) => entry.case_id === item.case_id);
      result.status = "unmeasured";
      result.supported = false;
    });
    const report = evaluateContract(contract);
    expect(report.metrics.automatic_binary.grounded_visual_success.denominator).toBe(20);
    expect(report.metrics.automatic_binary.observation_field_coverage.denominator).toBe(115);
    expect(report.breakdowns.by_media_kind.image).toMatchObject({ applicable: 6, unmeasured: 1 });
  });

  it("keeps coverage distinct from accuracy and respects observation applicability across all cells", () => {
    const missing = temporaryResult((results) => { results.cases[0].observations = results.cases[0].observations.filter((item: any) => item.field !== "stream_topology"); });
    const missingReport = evaluate({ resultsPath: missing });
    expect(missingReport.metrics.automatic_binary.observation_field_coverage).toMatchObject({ numerator: 118, denominator: 119 });
    expect(missingReport.metrics.automatic_binary.observation_agreement_accuracy).toMatchObject({ numerator: 118, denominator: 118, value: 1 });

    const wrong = temporaryResult((results) => { results.cases[0].observations.find((item: any) => item.field === "stream_topology").value = "wrong"; });
    const wrongReport = evaluate({ resultsPath: wrong });
    expect(wrongReport.metrics.automatic_binary.observation_field_coverage).toMatchObject({ numerator: 119, denominator: 119, value: 1 });
    expect(wrongReport.metrics.automatic_binary.observation_agreement_accuracy).toMatchObject({ numerator: 118, denominator: 119 });

    const disabled = temporaryContract(({ suite, results }) => {
      const item = suite.cases[0];
      item.applicability.observation_accuracy = false;
      results.cases.find((entry: any) => entry.case_id === item.case_id).observations = [];
    });
    expect(evaluateContract(disabled).metrics.automatic_binary.observation_field_coverage.denominator).toBe(115);
  });

  it("does not punish correct N/A, but counts false applicability as incorrect", () => {
    const baseline = evaluate().metrics.automatic_binary.observation_agreement_accuracy;
    expect(baseline).toMatchObject({ numerator: 119, denominator: 119 });
    const falseApplicability = temporaryResult((results) => {
      const image = results.cases.find((item: any) => item.media_kind === "image");
      const ambient = image.observations.find((item: any) => item.field === "audio_rms_db");
      Object.assign(ambient, { applicability: "applicable", value: "invented-audio", confidence: 0.99, evidence_ref: "fake" });
    });
    expect(evaluate({ resultsPath: falseApplicability }).metrics.automatic_binary.observation_agreement_accuracy).toMatchObject({ numerator: 119, denominator: 120 });
  });

  it("computes calibration bins/ECE and leaves insufficient samples unmeasured", () => {
    expect(evaluate().metrics.automatic_binary.confidence_calibration).toMatchObject({ status: "measured", sample_count: 119, ece: 0 });
    const sparse = temporaryResult((results) => {
      let remaining = 4;
      for (const item of results.cases) for (const observation of item.observations) {
        if (observation.applicability === "applicable" && remaining-- <= 0) observation.confidence = null;
      }
    });
    expect(evaluate({ resultsPath: sparse }).metrics.automatic_binary.confidence_calibration).toMatchObject({ status: "unmeasured", ece: null, sample_count: 4 });
  });

  it("keeps missing automatic and human pair predictions as explicit false negatives", () => {
    const missing = temporaryContract(({ suite, labels, results }) => {
      const target = suite.cases.find((item: any) => item.media_kind === "video");
      target.applicability.pair_relation = true;
      labels.automatic_ground_truth.find((item: any) => item.case_id === target.case_id).pair_labels = [{ pair_id: "adapter-pair", relation: "hard_cut" }];
      results.cases.find((item: any) => item.case_id === target.case_id).pair_relation_predictions = [];
    });
    const automatic = evaluateContract(missing).metrics.automatic_binary.pair_relation;
    expect(automatic.sample_count).toBe(1);
    expect(automatic.labels).toContain("__missing__");
    expect(automatic.macro_f1).toBeLessThan(1);

    const approved = temporaryContract(({ suite, labels, results }) => {
      const target = results.cases.find((item: any) => item.media_kind === "video");
      suite.cases.find((item: any) => item.case_id === target.case_id).applicability.pair_relation = true;
      const expected = labels.automatic_ground_truth.find((item: any) => item.case_id === target.case_id);
      expected.pair_labels = [{ pair_id: "adapter-pair", relation: "hard_cut" }];
      target.pair_relation_predictions = [];
      labels.human_evaluation = {
        status: "approved", approval_record: { record_id: "temp-approved", approved_by: "test-reviewer", approved_at: "2026-07-20T00:00:00Z", label_version: "labels-v2" },
        annotations: [{ case_id: target.case_id, annotator_id: "reviewer", observation_facts: expected.observation_expected_facts, pair_labels: expected.pair_labels }], annotator_disagreement: [],
      };
    });
    const human = evaluateContract(approved).metrics.human.human_f1;
    expect(human.sample_count).toBe(1);
    expect(human.labels).toContain("__missing__");
    expect(human.macro_f1).toBe(0);
    expect(human).not.toHaveProperty("numerator");
  });

  it("counts intentional jump/smash/match hard-fails as false positives", () => {
    const failed = temporaryContract(({ suite, labels, results }) => {
      const item = results.cases.find((entry: any) => entry.genre === "intentional_jump_smash_match" && entry.media_kind === "mixed");
      suite.cases.find((entry: any) => entry.case_id === item.case_id).applicability.pair_relation = true;
      const automatic = labels.automatic_ground_truth.find((entry: any) => entry.case_id === item.case_id);
      automatic.pair_labels = (["jump", "smash", "match"] as const).map((relation) => ({ pair_id: `adapter-${relation}`, relation }));
      automatic.intentional_transition_labels = (["jump", "smash", "match"] as const).map((transition) => ({ pair_id: `adapter-${transition}`, transition }));
      item.pair_relation_predictions = automatic.pair_labels.map((pair: any) => ({ ...pair, confidence: 1 }));
      item.hard_fail = { decision: true, reasons: ["incorrect_cut_rejection"] };
    });
    expect(evaluateContract(failed).metrics.automatic_binary.false_hard_fail_rate).toEqual({ status: "measured", value: 1, numerator: 3, denominator: 3 });
  });

  it("keeps human metrics unmeasured until a temporary approved artifact is supplied", () => {
    expect(evaluate().metrics.human).toMatchObject({ human_accuracy: { status: "unmeasured" }, human_f1: { status: "unmeasured" } });
    const approved = temporaryContract(({ labels, results }) => {
      const target = results.cases.find((item: any) => item.media_kind === "video");
      const expected = labels.automatic_ground_truth.find((item: any) => item.case_id === target.case_id);
      labels.human_evaluation = {
        status: "approved", approval_record: { record_id: "temp-approved", approved_by: "test-reviewer", approved_at: "2026-07-20T00:00:00Z", label_version: "labels-v2" },
        annotations: [{ case_id: target.case_id, annotator_id: "reviewer", observation_facts: expected.observation_expected_facts, pair_labels: expected.pair_labels }], annotator_disagreement: [],
      };
    });
    const metrics = evaluateContract(approved).metrics.human;
    expect(metrics.human_accuracy).toMatchObject({ status: "measured", value: 1, numerator: 4, denominator: 4 });
    expect(metrics.human_f1.status).toBe("unmeasured");
  });

  it("rejects results case-set and genre/media identity mismatches", () => {
    const missing = temporaryResult((results) => { results.cases.pop(); });
    expect(() => evaluate({ resultsPath: missing })).toThrow(/schema validation|case set mismatch/);
    const mismatched = temporaryResult((results) => { results.cases[0].genre = "quiet_documentary"; });
    expect(() => evaluate({ resultsPath: mismatched })).toThrow("results case genre/media identity mismatch");
  });

  it("requires explicit results and real-media fingerprints before any measured success", () => {
    expect(() => evaluateEditorialEye({ repoRoot, manifestPath, labelsPath, baselineReportPath: baselinePath, baselineReportSha256, candidateCommit, resultsPath: "" })).toThrow("explicit results artifact");
    const noFrame = temporaryResult((results) => {
      const video = results.cases.find((item: any) => item.media_kind === "video");
      delete video.decoded_fixture_fingerprints.decoded_frame_sha256;
    });
    expect(() => evaluate({ resultsPath: noFrame })).toThrow("visual success requires decoded_frame_sha256");
    const noRms = temporaryResult((results) => {
      const audio = results.cases.find((item: any) => item.media_kind === "audio");
      delete audio.decoded_fixture_fingerprints.audio_rms_db;
    });
    expect(() => evaluate({ resultsPath: noRms })).toThrow("audio success requires audio_rms_db");
  });

  it("does not allow degraded visual evidence to pass and emits deterministic bounded reasons", () => {
    const degraded = temporaryResult((results) => { results.cases.find((item: any) => item.media_kind === "video").degraded_reason = "fixture_decode_failed"; });
    const report = evaluate({ resultsPath: degraded });
    expect(report.verdict.status).toBe("fail");
    expect(report.regressions).toEqual([...report.regressions].sort((a, b) => a.id.localeCompare(b.id)));
    expect(report.regressions.length).toBeLessThanOrEqual(100);
    expect(report.regressions.some((item) => item.reason === "fixture_decode_failed" && item.case_id && item.genre && item.media_kind)).toBe(true);
  });
});

describe("generated media fixtures", () => {
  it("--no-write returns only the deterministic spec and creates no output root", () => {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "editorial-eye-no-write-parent-")), "output");
    temporaryRoots.push(path.dirname(root));
    expect(generateEditorialEyeFixtures({ outputRoot: root, write: false })).toEqual({ status: "spec_only", spec: buildGeneratedMediaSpec(), spec_sha256: canonicalSha256(buildGeneratedMediaSpec()) });
    expect(fs.existsSync(root)).toBe(false);
  });

  const realFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 && spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
  (realFfmpeg ? it : it.skip)("generates and probes every media kind deterministically with real ffmpeg", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-eye-media-"));
    temporaryRoots.push(parent);
    const first = generateEditorialEyeFixtures({ outputRoot: path.join(parent, "first") });
    const second = generateEditorialEyeFixtures({ outputRoot: path.join(parent, "second") });
    expect("fixtures" in first && first.status).toBe("generated");
    expect(first).toEqual(second);
    if (!("fixtures" in first)) throw new Error("expected generated fixtures");
    expect(new Set(first.fixtures.map((item) => item.media_kind))).toEqual(new Set(EDITORIAL_EYE_MEDIA_KINDS));
    expect(first.fixtures.find((item) => item.media_kind === "sequence")?.outputs).toHaveLength(3);
    expect(first.fixtures.find((item) => item.media_kind === "sequence")?.stream_topology).toContain("video");

    const probes = Object.fromEntries(first.fixtures.map(({ media_kind, decoded_frame_sha256, stream_topology, duration_ms, audio_rms_db, generated_bytes_sha256 }) => [media_kind, { decoded_frame_sha256, stream_topology, duration_ms, audio_rms_db, generated_bytes_sha256 }])) as FixtureProbeMap;
    const contractRoot = path.join(parent, "measured-contract");
    writeContractArtifacts(contractRoot, probes);
    const measured = evaluateEditorialEye({
      repoRoot,
      manifestPath: path.join(contractRoot, "suite.json"),
      labelsPath: path.join(contractRoot, "labels.json"),
      baselineReportPath: path.join(contractRoot, "baseline-report.json"),
      baselineReportSha256: bytesSha256(fs.readFileSync(path.join(contractRoot, "baseline-report.json"))),
      resultsPath: path.join(contractRoot, "results.json"),
      candidateCommit,
    });
    expect(measured.verdict.status).toBe("pass");
  }, 30_000);

  it("reports unavailable ffmpeg as degraded instead of success", () => {
    const root = path.join(os.tmpdir(), "editorial-eye-never-created", String(Date.now()));
    const result = generateEditorialEyeFixtures({ outputRoot: root, ffmpeg: "definitely-not-an-ffmpeg-binary", ffprobe: "definitely-not-an-ffprobe-binary" });
    expect(result).toMatchObject({ status: "degraded", degraded_reason: "ffmpeg_or_ffprobe_unavailable", fixtures: [] });
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe("Editorial Eye immutable CLI", () => {
  it("preserves the golden CLI and keeps legacy thresholds separate", async () => {
    expect(parseArgs(["node", "eval", "--suite", "golden", "--no-write"]).suite).toBe("golden");
    await expect(main(["node", "eval", "--suite", "editorial-eye", "--min-score", "90"])).rejects.toThrow("legacy artifact-agreement threshold");
  });

  it("binds exact baseline bytes and writes nothing in --no-write mode", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const outputRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "editorial-eye-output-")), "reports");
    temporaryRoots.push(path.dirname(outputRoot));
    const before = [manifestPath, labelsPath, baselinePath, resultsPath].map((file) => [file, bytesSha256(fs.readFileSync(file))] as const);
    expect(await main(["node", "eval", "--suite", "editorial-eye", "--manifest", manifestPath, "--labels", labelsPath, "--baseline-report", baselinePath, "--baseline-report-sha256", baselineReportSha256, "--results", resultsPath, "--candidate-commit", candidateCommit, "--output-root", outputRoot, "--no-write"])).toBe(0);
    expect(fs.existsSync(outputRoot)).toBe(false);
    for (const [file, sha] of before) expect(bytesSha256(fs.readFileSync(file))).toBe(sha);
  });

  it("never discovers dirty/latest baselines and rejects invalid locks/abbreviated SHAs", async () => {
    expect(loadEditorialEyeBaseline(repoRoot, baselinePath).report.candidate_commit).toBe("e431da43c7fe7f4f50a688c3e8fcb48b50511453");
    expect(() => loadEditorialEyeBaseline(repoRoot, "")).toThrow("--baseline-report explicit path is required");
    await expect(main(["node", "eval", "--suite", "editorial-eye", "--manifest", manifestPath, "--labels", labelsPath, "--baseline-report", baselinePath, "--baseline-report-sha256", baselineReportSha256, "--results", resultsPath, "--candidate-commit", "e431da4", "--no-write"])).rejects.toThrow("complete lowercase 40-character SHA");
    const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(process.execPath, [tsxCli, path.join(repoRoot, "scripts", "eval.ts"), "--suite", "editorial-eye", "--manifest", manifestPath, "--labels", labelsPath, "--baseline-report", baselinePath, "--baseline-report-sha256", "0".repeat(64), "--results", resultsPath, "--candidate-commit", candidateCommit, "--no-write"], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("baseline report bytes SHA mismatch");
  });
});
