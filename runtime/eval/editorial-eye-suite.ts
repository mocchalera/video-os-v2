import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (options: Record<string, unknown>) => {
  compile(schema: object): AjvValidate;
};

type AjvValidate = ((value: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};

export const EDITORIAL_EYE_SUITE_ID = "editorial-eye-v1" as const;
export const EDITORIAL_EYE_SUITE_VERSION = "1.0.0" as const;
export const EDITORIAL_EYE_GENRES = [
  "interview_dialogue",
  "quiet_documentary",
  "product_detail",
  "action_event",
  "vertical_social_montage",
  "chronological_longform",
  "intentional_jump_smash_match",
] as const;
export const EDITORIAL_EYE_MEDIA_KINDS = ["video", "audio", "image", "sequence", "mixed"] as const;

export type EditorialEyeGenre = typeof EDITORIAL_EYE_GENRES[number];
export type EditorialEyeMediaKind = typeof EDITORIAL_EYE_MEDIA_KINDS[number];
export type EditorialEyeEvidenceTier = "real_generated_pixel_audio" | "grounding_contract_only" | "unsupported_capability";
export type EditorialEyeCaseStatus = "success" | "failure" | "unsupported" | "unmeasured";
export type ObservationApplicability = "applicable" | "not_applicable";

export interface EditorialEyeGeneratorIdentity {
  id: string;
  version: string;
  fixture_set_id: string;
}

export interface EditorialEyeProvenance {
  environment: Record<string, string | number | boolean | null>;
  models: Array<{ id: string; version: string }>;
  degraded: string[];
}

export interface EditorialEyeCaseInput {
  status: EditorialEyeCaseStatus;
  supported: boolean;
  grounded_frame_count: number;
  ground_truth_ids?: string[];
  observations?: EditorialEyeObservation[];
  pair_relation_predictions?: EditorialEyePairPrediction[];
  hard_fail: { decision: boolean; reasons: string[] };
  degraded_reason?: string;
  decoded_fixture_fingerprints?: EditorialEyeFixtureFingerprints;
}

export interface EditorialEyeObservation {
  field: string;
  value: string | number | boolean | null;
  evidence_ref: string | null;
  confidence: number | null;
  applicability: ObservationApplicability;
}

export interface EditorialEyePairPrediction {
  pair_id: string;
  relation: string;
  confidence: number | null;
}

export interface EditorialEyeFixtureFingerprints {
  decoded_frame_sha256?: string;
  stream_topology?: string;
  duration_ms?: number;
  audio_rms_db?: number;
  generated_bytes_sha256?: string;
}

export interface EditorialEyeSuiteCase {
  case_id: string;
  genre: EditorialEyeGenre;
  media_kind: EditorialEyeMediaKind;
  fixture_id: string;
  evidence_tier: EditorialEyeEvidenceTier;
  required_lanes: string[];
  genre_intent: string;
  applicability: {
    grounded_visual_accuracy: boolean;
    observation_accuracy: boolean;
    pair_relation: boolean;
    human_accuracy: boolean;
  };
}

export interface EditorialEyeSuiteManifest {
  artifact_version: "editorial-eye-benchmark-suite/v1";
  suite_id: typeof EDITORIAL_EYE_SUITE_ID;
  version: typeof EDITORIAL_EYE_SUITE_VERSION;
  baseline_commit: string;
  generator: EditorialEyeGeneratorIdentity;
  contract_provenance: EditorialEyeProvenance;
  cases: EditorialEyeSuiteCase[];
  gate_policy: {
    grounded_visual_success: { gate_id: "grounded_visual_success"; blocking: true };
    human_accuracy: {
      metric_id: "human_accuracy" | "human_f1";
      enforcement: "advisory" | "blocking";
      threshold: number;
      approval_record?: Record<string, unknown>;
    };
    reserved_gate_ids?: Array<"source_freshness" | "rollback" | "preference_isolation">;
  };
}

export interface ExpectedObservation {
  field: string;
  value: string | number | boolean | null;
  applicability: ObservationApplicability;
}

export interface EditorialEyeAutomaticLabel {
  case_id: string;
  ground_truth_ids: string[];
  observation_expected_facts?: ExpectedObservation[];
  pair_labels?: Array<{ pair_id: string; relation: string }>;
  intentional_transition_labels?: Array<{ pair_id: string; transition: "jump" | "smash" | "match" }>;
}

export interface EditorialEyeLabels {
  artifact_version: "editorial-eye-benchmark-labels/v1";
  suite_id: typeof EDITORIAL_EYE_SUITE_ID;
  suite_version: typeof EDITORIAL_EYE_SUITE_VERSION;
  label_version: string;
  fixture_manifest_sha256: string;
  automatic_ground_truth: EditorialEyeAutomaticLabel[];
  human_evaluation: {
    status: "unapproved" | "approved";
    approval_record?: Record<string, unknown>;
    annotations: Array<{
      case_id: string;
      annotator_id: string;
      labels?: string[];
      observation_facts?: ExpectedObservation[];
      pair_labels?: Array<{ pair_id: string; relation: string }>;
    }>;
    annotator_disagreement: Array<{
      case_id: string;
      field_or_pair_id: string;
      annotator_ids: string[];
      values: string[];
      resolution: "unresolved" | "resolved";
    }>;
  };
}

export interface EditorialEyeResultCase extends EditorialEyeCaseInput {
  case_id: string;
  genre: EditorialEyeGenre;
  media_kind: EditorialEyeMediaKind;
}

export interface EditorialEyeResultInput {
  artifact_version: "editorial-eye-benchmark-results/v1";
  suite_id: typeof EDITORIAL_EYE_SUITE_ID;
  suite_version: typeof EDITORIAL_EYE_SUITE_VERSION;
  fixture_manifest_sha256: string;
  label_version: string;
  generator: EditorialEyeGeneratorIdentity;
  provenance: EditorialEyeProvenance;
  cases: EditorialEyeResultCase[];
}

export interface EditorialEyeMetric {
  status: "measured" | "unmeasured";
  value: number | null;
  numerator: number;
  denominator: number;
}

export interface EditorialEyeCalibration {
  status: "measured" | "unmeasured";
  ece: number | null;
  sample_count: number;
  minimum_sample_count: number;
  bins: Array<{ lower: number; upper: number; count: number; mean_confidence: number | null; accuracy: number | null }>;
}

export interface EditorialEyeRelationMetrics {
  status: "measured" | "unmeasured";
  macro_f1: number | null;
  sample_count: number;
  labels: string[];
  confusion_matrix: Record<string, Record<string, number>>;
}

export interface EditorialEyeBreakdownCount {
  applicable: number;
  unsupported: number;
  unmeasured: number;
  success: number;
  failure: number;
}

export interface EditorialEyeAutomaticMetrics {
  grounded_visual_success: EditorialEyeMetric;
  observation_field_coverage: EditorialEyeMetric;
  observation_agreement_accuracy: EditorialEyeMetric;
  confidence_calibration: EditorialEyeCalibration;
  pair_relation: EditorialEyeRelationMetrics;
  false_hard_fail_rate: EditorialEyeMetric;
}

export interface EditorialEyeGate {
  gate_id: "grounded_visual_success" | "human_accuracy" | "human_f1" | "source_freshness" | "rollback" | "preference_isolation";
  namespace: "automatic_binary" | "human";
  status: "measured" | "unmeasured";
  blocking: boolean;
  passed: boolean | null;
  details: string[];
}

export interface EditorialEyeReport {
  artifact_version: "editorial-eye-benchmark-report/v1";
  suite_id: typeof EDITORIAL_EYE_SUITE_ID;
  suite_version: typeof EDITORIAL_EYE_SUITE_VERSION;
  baseline_commit: string;
  candidate_commit: string;
  baseline_report_sha256: string | null;
  fixture_manifest_sha256: string;
  label_version: string;
  generator: EditorialEyeGeneratorIdentity;
  provenance: EditorialEyeProvenance;
  metrics: {
    automatic_binary: EditorialEyeAutomaticMetrics;
    human: { human_accuracy: EditorialEyeMetric; human_f1: EditorialEyeRelationMetrics };
    legacy_artifact_agreement?: { status: "measured" | "unmeasured"; score: number | null };
  };
  breakdowns: {
    by_genre: Record<EditorialEyeGenre, EditorialEyeBreakdownCount>;
    by_media_kind: Record<EditorialEyeMediaKind, EditorialEyeBreakdownCount>;
    metrics_by_genre: Record<EditorialEyeGenre, EditorialEyeAutomaticMetrics>;
    metrics_by_media_kind: Record<EditorialEyeMediaKind, EditorialEyeAutomaticMetrics>;
  };
  binary_gates: EditorialEyeGate[];
  regressions: Array<{
    id: string;
    severity: "advisory" | "blocking";
    message: string;
    case_id?: string;
    genre?: EditorialEyeGenre;
    media_kind?: EditorialEyeMediaKind;
    reason?: string;
  }>;
  resources: { model_runs: number; generated_media_bytes: number; wall_time_ms: number };
  verdict: { status: "pass" | "fail"; blocking_failures: string[] };
}

export class EditorialEyeIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorialEyeIdentityError";
  }
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortCanonical(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

export function canonicalSha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function bytesSha256(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function loadStructuredFile(filePath: string): { value: unknown; bytes: Buffer } {
  const bytes = fs.readFileSync(filePath);
  const raw = bytes.toString("utf8");
  try {
    const ext = path.extname(filePath).toLowerCase();
    return { value: ext === ".yaml" || ext === ".yml" ? parseYaml(raw) : JSON.parse(raw), bytes };
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function schemaValidator(repoRoot: string, schemaName: string): AjvValidate {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas", schemaName), "utf8")) as object;
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema);
}

function validateSchema(repoRoot: string, schemaName: string, value: unknown, label: string): void {
  const validate = schemaValidator(repoRoot, schemaName);
  if (validate(value)) return;
  const details = (validate.errors ?? []).map((item) => `${item.instancePath || "/"} ${item.message ?? "invalid"}`).join("; ");
  throw new Error(`${label} failed schema validation: ${details}`);
}

function assertExactIdentity(label: string, actual: unknown, expected: unknown): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new EditorialEyeIdentityError(`${label} mismatch`);
}

function assertUniqueKeys<T>(items: T[], keyOf: (item: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) throw new Error(`${label} contains duplicate ${key}`);
    seen.add(key);
  }
}

function assertExactMatrix(cases: EditorialEyeSuiteCase[]): void {
  const expected = new Set(EDITORIAL_EYE_GENRES.flatMap((genre) => EDITORIAL_EYE_MEDIA_KINDS.map((kind) => `${genre}:${kind}`)));
  const seen = new Set<string>();
  for (const item of cases) {
    const cell = `${item.genre}:${item.media_kind}`;
    if (seen.has(cell)) throw new Error(`manifest contains duplicate matrix cell ${cell}`);
    seen.add(cell);
    if (item.media_kind === "sequence" && item.evidence_tier !== "unsupported_capability") {
      throw new Error(`sequence cell ${item.case_id} must remain an unsupported capability`);
    }
  }
  const missing = [...expected].filter((cell) => !seen.has(cell));
  const extra = [...seen].filter((cell) => !expected.has(cell));
  if (cases.length !== expected.size || missing.length || extra.length) {
    throw new Error(`manifest must contain exact 7x5 Editorial Eye matrix; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}`);
  }
}

export function loadEditorialEyeManifest(repoRoot: string, manifestPath: string): { manifest: EditorialEyeSuiteManifest; sha256: string } {
  const { value } = loadStructuredFile(manifestPath);
  validateSchema(repoRoot, "editorial-eye-benchmark-suite.schema.json", value, "manifest");
  const manifest = value as EditorialEyeSuiteManifest;
  const ids = manifest.cases.map((item) => item.case_id);
  if (new Set(ids).size !== ids.length) throw new Error("manifest contains duplicate case_id values");
  assertExactMatrix(manifest.cases);
  return { manifest, sha256: canonicalSha256(manifest) };
}

export function loadEditorialEyeLabels(repoRoot: string, labelsPath: string, manifestSha256: string): EditorialEyeLabels {
  const { value } = loadStructuredFile(labelsPath);
  validateSchema(repoRoot, "editorial-eye-benchmark-labels.schema.json", value, "labels");
  const labels = value as EditorialEyeLabels;
  if (labels.fixture_manifest_sha256 !== manifestSha256) throw new EditorialEyeIdentityError("labels fixture_manifest_sha256 mismatch");
  for (const item of labels.automatic_ground_truth) {
    assertUniqueKeys(item.observation_expected_facts ?? [], (fact) => fact.field, `automatic labels ${item.case_id} observation fields`);
    assertUniqueKeys(item.pair_labels ?? [], (pair) => pair.pair_id, `automatic labels ${item.case_id} pair ids`);
    assertUniqueKeys(item.intentional_transition_labels ?? [], (transition) => transition.pair_id, `automatic labels ${item.case_id} intentional transition ids`);
  }
  for (const annotation of labels.human_evaluation.annotations) {
    assertUniqueKeys(annotation.observation_facts ?? [], (fact) => fact.field, `human annotation ${annotation.case_id}/${annotation.annotator_id} observation fields`);
    assertUniqueKeys(annotation.pair_labels ?? [], (pair) => pair.pair_id, `human annotation ${annotation.case_id}/${annotation.annotator_id} pair ids`);
  }
  if (labels.human_evaluation.status === "approved" && labels.human_evaluation.approval_record?.label_version !== labels.label_version) {
    throw new EditorialEyeIdentityError("human approval_record label_version mismatch");
  }
  if (labels.human_evaluation.status === "approved" && labels.human_evaluation.annotator_disagreement.some((item) => item.resolution === "unresolved")) {
    throw new Error("approved human labels cannot contain unresolved annotator disagreement");
  }
  return labels;
}

export function loadEditorialEyeResults(repoRoot: string, resultsPath: string): EditorialEyeResultInput {
  const { value } = loadStructuredFile(resultsPath);
  validateSchema(repoRoot, "editorial-eye-benchmark-results.schema.json", value, "results");
  const results = value as EditorialEyeResultInput;
  for (const item of results.cases) {
    assertUniqueKeys(item.observations ?? [], (observation) => observation.field, `results ${item.case_id} observation fields`);
    assertUniqueKeys(item.pair_relation_predictions ?? [], (prediction) => prediction.pair_id, `results ${item.case_id} pair prediction ids`);
  }
  return results;
}

export function loadEditorialEyeBaseline(repoRoot: string, baselineReportPath: string): { report: EditorialEyeReport; sha256: string } {
  if (!baselineReportPath.trim()) throw new EditorialEyeIdentityError("--baseline-report explicit path is required");
  const { value, bytes } = loadStructuredFile(baselineReportPath);
  validateSchema(repoRoot, "editorial-eye-benchmark-report.schema.json", value, "baseline report");
  return { report: value as EditorialEyeReport, sha256: bytesSha256(bytes) };
}

function unmeasuredMetric(): EditorialEyeMetric {
  return { status: "unmeasured", value: null, numerator: 0, denominator: 0 };
}

function ratioMetric(numerator: number, denominator: number): EditorialEyeMetric {
  return denominator === 0 ? unmeasuredMetric() : { status: "measured", value: numerator / denominator, numerator, denominator };
}

function equalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function applicableAutomatic(item: EditorialEyeSuiteCase): boolean {
  return item.evidence_tier === "real_generated_pixel_audio";
}

function visualApplicable(item: EditorialEyeSuiteCase): boolean {
  return applicableAutomatic(item) && item.media_kind !== "audio" && item.applicability.grounded_visual_accuracy;
}

function calculateCalibration(samples: Array<{ confidence: number; correct: boolean }>, minimum = 5): EditorialEyeCalibration {
  const bins = Array.from({ length: 5 }, (_, index) => ({ lower: index / 5, upper: (index + 1) / 5, count: 0, mean_confidence: null as number | null, accuracy: null as number | null }));
  for (const bin of bins) {
    const members = samples.filter(({ confidence }) => confidence >= bin.lower && (confidence < bin.upper || (bin.upper === 1 && confidence === 1)));
    bin.count = members.length;
    if (members.length) {
      bin.mean_confidence = members.reduce((sum, item) => sum + item.confidence, 0) / members.length;
      bin.accuracy = members.filter((item) => item.correct).length / members.length;
    }
  }
  if (samples.length < minimum) return { status: "unmeasured", ece: null, sample_count: samples.length, minimum_sample_count: minimum, bins };
  const ece = bins.reduce((sum, bin) => sum + (bin.count / samples.length) * Math.abs((bin.accuracy ?? 0) - (bin.mean_confidence ?? 0)), 0);
  return { status: "measured", ece, sample_count: samples.length, minimum_sample_count: minimum, bins };
}

function calculateRelations(expected: Array<{ relation: string; predicted: string }>): EditorialEyeRelationMetrics {
  const labels = [...new Set(expected.flatMap((item) => [item.relation, item.predicted]))].sort();
  const matrix = Object.fromEntries(labels.map((actual) => [actual, Object.fromEntries(labels.map((predicted) => [predicted, 0]))]));
  for (const item of expected) matrix[item.relation][item.predicted] += 1;
  if (!expected.length) return { status: "unmeasured", macro_f1: null, sample_count: 0, labels, confusion_matrix: matrix };
  const f1s = labels.map((label) => {
    const tp = matrix[label][label];
    const fp = labels.reduce((sum, actual) => sum + (actual === label ? 0 : matrix[actual][label]), 0);
    const fn = labels.reduce((sum, predicted) => sum + (predicted === label ? 0 : matrix[label][predicted]), 0);
    return tp === 0 && fp + fn === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
  });
  return { status: "measured", macro_f1: f1s.reduce((sum, value) => sum + value, 0) / f1s.length, sample_count: expected.length, labels, confusion_matrix: matrix };
}

function calculateAutomaticMetrics(
  cases: EditorialEyeSuiteCase[],
  inputs: Map<string, EditorialEyeCaseInput>,
  labelsByCase: Map<string, EditorialEyeAutomaticLabel>,
): EditorialEyeAutomaticMetrics {
  const visual = cases.filter(visualApplicable);
  const grounded = visual.filter((item) => {
    const input = inputs.get(item.case_id)!;
    return input.status === "success" && input.supported && input.grounded_frame_count > 0 && !input.degraded_reason;
  });
  let expectedObservationCount = 0;
  let coveredObservationCount = 0;
  let evaluatedObservationCount = 0;
  let correctObservationCount = 0;
  const calibrationSamples: Array<{ confidence: number; correct: boolean }> = [];
  const relationSamples: Array<{ relation: string; predicted: string }> = [];
  let intentionalCount = 0;
  let falseHardFails = 0;
  for (const item of cases.filter(applicableAutomatic)) {
    const expected = labelsByCase.get(item.case_id)!;
    const input = inputs.get(item.case_id)!;
    const observed = new Map((input.observations ?? []).map((fact) => [fact.field, fact]));
    if (item.applicability.observation_accuracy) {
      for (const fact of expected.observation_expected_facts ?? []) {
        const prediction = observed.get(fact.field);
        if (fact.applicability === "not_applicable") {
          if (prediction && prediction.applicability === "applicable" && prediction.value !== null) {
            evaluatedObservationCount += 1;
            if (prediction.confidence !== null) calibrationSamples.push({ confidence: prediction.confidence, correct: false });
          }
          continue;
        }
        expectedObservationCount += 1;
        if (!prediction || prediction.applicability === "not_applicable" || prediction.value === null) continue;
        coveredObservationCount += 1;
        evaluatedObservationCount += 1;
        const correct = equalValue(prediction.value, fact.value);
        if (correct) correctObservationCount += 1;
        if (prediction.confidence !== null) calibrationSamples.push({ confidence: prediction.confidence, correct });
      }
    }
    if (item.applicability.pair_relation) {
      const predictions = new Map((input.pair_relation_predictions ?? []).map((pair) => [pair.pair_id, pair.relation]));
      for (const pair of expected.pair_labels ?? []) relationSamples.push({ relation: pair.relation, predicted: predictions.get(pair.pair_id) ?? "__missing__" });
    }
    for (const transition of expected.intentional_transition_labels ?? []) {
      intentionalCount += 1;
      if (input.hard_fail.decision) falseHardFails += 1;
    }
  }
  return {
    grounded_visual_success: ratioMetric(grounded.length, visual.length),
    observation_field_coverage: ratioMetric(coveredObservationCount, expectedObservationCount),
    observation_agreement_accuracy: ratioMetric(correctObservationCount, evaluatedObservationCount),
    confidence_calibration: calculateCalibration(calibrationSamples),
    pair_relation: calculateRelations(relationSamples),
    false_hard_fail_rate: ratioMetric(falseHardFails, intentionalCount),
  };
}

function makeBreakdowns(cases: EditorialEyeSuiteCase[], inputs: Map<string, EditorialEyeCaseInput>, labelsByCase: Map<string, EditorialEyeAutomaticLabel>): EditorialEyeReport["breakdowns"] {
  const summarize = (selected: EditorialEyeSuiteCase[]): EditorialEyeBreakdownCount => {
    const values = selected.map((item) => inputs.get(item.case_id)!);
    return {
      applicable: selected.filter(applicableAutomatic).length,
      unsupported: values.filter((item) => item.status === "unsupported").length,
      unmeasured: values.filter((item) => item.status === "unmeasured" || item.degraded_reason !== undefined).length,
      success: values.filter((item) => item.status === "success" && !item.degraded_reason).length,
      failure: values.filter((item) => item.status === "failure").length,
    };
  };
  return {
    by_genre: Object.fromEntries(EDITORIAL_EYE_GENRES.map((genre) => [genre, summarize(cases.filter((item) => item.genre === genre))])) as EditorialEyeReport["breakdowns"]["by_genre"],
    by_media_kind: Object.fromEntries(EDITORIAL_EYE_MEDIA_KINDS.map((kind) => [kind, summarize(cases.filter((item) => item.media_kind === kind))])) as EditorialEyeReport["breakdowns"]["by_media_kind"],
    metrics_by_genre: Object.fromEntries(EDITORIAL_EYE_GENRES.map((genre) => [genre, calculateAutomaticMetrics(cases.filter((item) => item.genre === genre), inputs, labelsByCase)])) as EditorialEyeReport["breakdowns"]["metrics_by_genre"],
    metrics_by_media_kind: Object.fromEntries(EDITORIAL_EYE_MEDIA_KINDS.map((kind) => [kind, calculateAutomaticMetrics(cases.filter((item) => item.media_kind === kind), inputs, labelsByCase)])) as EditorialEyeReport["breakdowns"]["metrics_by_media_kind"],
  };
}

function requireMeasuredFingerprint(item: EditorialEyeSuiteCase, input: EditorialEyeCaseInput): void {
  if (item.evidence_tier !== "real_generated_pixel_audio" || input.status !== "success") return;
  const fingerprint = input.decoded_fixture_fingerprints;
  if (!fingerprint) throw new Error(`results ${item.case_id} measured real evidence requires decoded_fixture_fingerprints`);
  if (!fingerprint.stream_topology || fingerprint.duration_ms === undefined) {
    throw new Error(`results ${item.case_id} fingerprint requires stream_topology and duration_ms`);
  }
  const visual = item.media_kind === "video" || item.media_kind === "image" || item.media_kind === "mixed";
  const audio = item.media_kind === "audio" || item.media_kind === "mixed";
  if (visual && !fingerprint.decoded_frame_sha256) throw new Error(`results ${item.case_id} visual success requires decoded_frame_sha256`);
  if (visual && !fingerprint.stream_topology.includes("video:")) throw new Error(`results ${item.case_id} visual fingerprint topology mismatch`);
  if (audio && fingerprint.audio_rms_db === undefined) throw new Error(`results ${item.case_id} audio success requires audio_rms_db`);
  if (audio && !fingerprint.stream_topology.includes("audio:")) throw new Error(`results ${item.case_id} audio fingerprint topology mismatch`);
}

function requireResultSemantics(item: EditorialEyeSuiteCase, input: EditorialEyeCaseInput): void {
  if (input.status === "success" && !input.supported) throw new Error(`results ${item.case_id} status=success requires supported=true`);
  if (input.status === "unsupported" && input.supported) throw new Error(`results ${item.case_id} status=unsupported requires supported=false`);
  if (item.evidence_tier === "unsupported_capability" && (input.status !== "unsupported" || input.supported)) {
    throw new Error(`results ${item.case_id} unsupported_capability requires status=unsupported and supported=false`);
  }
}

function unmeasuredGate(gateId: EditorialEyeGate["gate_id"]): EditorialEyeGate {
  return { gate_id: gateId, namespace: "automatic_binary", status: "unmeasured", blocking: false, passed: null, details: ["reserved_not_measured_in_v1"] };
}

export interface RunEditorialEyeOptions {
  repoRoot: string;
  manifestPath: string;
  labelsPath: string;
  baselineReportPath: string;
  baselineReportSha256: string;
  candidateCommit: string;
  resultsPath: string;
}

export function evaluateEditorialEye(options: RunEditorialEyeOptions): EditorialEyeReport {
  if (!/^[0-9a-f]{40}$/.test(options.candidateCommit)) throw new EditorialEyeIdentityError("candidate commit must be a complete lowercase 40-character SHA");
  if (!/^[0-9a-f]{64}$/.test(options.baselineReportSha256)) throw new EditorialEyeIdentityError("baseline report expected SHA must be a lowercase 64-character SHA-256");
  const { manifest, sha256: manifestSha } = loadEditorialEyeManifest(options.repoRoot, options.manifestPath);
  const labels = loadEditorialEyeLabels(options.repoRoot, options.labelsPath, manifestSha);
  const baseline = loadEditorialEyeBaseline(options.repoRoot, options.baselineReportPath);

  if (baseline.report.candidate_commit !== manifest.baseline_commit) throw new EditorialEyeIdentityError("baseline report commit identity mismatch");
  if (baseline.report.fixture_manifest_sha256 !== manifestSha) throw new EditorialEyeIdentityError("baseline report fixture_manifest_sha256 mismatch");
  if (baseline.report.label_version !== labels.label_version) throw new EditorialEyeIdentityError("baseline report label_version mismatch");
  assertExactIdentity("baseline report generator", baseline.report.generator, manifest.generator);
  assertExactIdentity("baseline report provenance", baseline.report.provenance, manifest.contract_provenance);
  if (baseline.sha256 !== options.baselineReportSha256) throw new EditorialEyeIdentityError("baseline report bytes SHA mismatch");

  const expectedCaseIds = manifest.cases.map((item) => item.case_id).sort();
  assertExactIdentity("automatic ground-truth case set", labels.automatic_ground_truth.map((item) => item.case_id).sort(), expectedCaseIds);
  if (!options.resultsPath.trim()) throw new Error("Editorial Eye evaluation requires an explicit results artifact");
  const results = loadEditorialEyeResults(options.repoRoot, options.resultsPath);
  if (results.suite_id !== manifest.suite_id || results.suite_version !== manifest.version) throw new EditorialEyeIdentityError("results suite identity mismatch");
  if (results.fixture_manifest_sha256 !== manifestSha) throw new EditorialEyeIdentityError("results fixture_manifest_sha256 mismatch");
  if (results.label_version !== labels.label_version) throw new EditorialEyeIdentityError("results label_version mismatch");
  assertExactIdentity("results generator", results.generator, manifest.generator);
  assertExactIdentity("results case set", results.cases.map((item) => item.case_id).sort(), expectedCaseIds);
  const manifestIdentities = manifest.cases.map(({ case_id, genre, media_kind }) => ({ case_id, genre, media_kind })).sort((a, b) => a.case_id.localeCompare(b.case_id));
  const resultIdentities = results.cases.map(({ case_id, genre, media_kind }) => ({ case_id, genre, media_kind })).sort((a, b) => a.case_id.localeCompare(b.case_id));
  assertExactIdentity("results case genre/media identity", resultIdentities, manifestIdentities);
  const inputs = new Map(results.cases.map(({ case_id, genre: _genre, media_kind: _kind, ...input }) => [case_id, input]));
  const candidateProvenance = results.provenance;
  for (const item of manifest.cases) {
    const input = inputs.get(item.case_id)!;
    requireResultSemantics(item, input);
    requireMeasuredFingerprint(item, input);
  }
  assertExactIdentity("candidate environment/model/degraded provenance", candidateProvenance, baseline.report.provenance);

  const labelsByCase = new Map(labels.automatic_ground_truth.map((item) => [item.case_id, item]));
  const visual = manifest.cases.filter(visualApplicable);
  const groundedSuccess = visual.filter((item) => {
    const input = inputs.get(item.case_id)!;
    return input.status === "success" && input.supported && input.grounded_frame_count > 0 && !input.degraded_reason;
  });
  const automaticMetrics = calculateAutomaticMetrics(manifest.cases, inputs, labelsByCase);
  const groundedMetric = automaticMetrics.grounded_visual_success;

  let humanAccuracy = unmeasuredMetric();
  let humanF1 = calculateRelations([]);
  if (labels.human_evaluation.status === "approved") {
    let expectedHuman = 0;
    let correctHuman = 0;
    const humanRelations: Array<{ relation: string; predicted: string }> = [];
    for (const annotation of labels.human_evaluation.annotations) {
      const input = inputs.get(annotation.case_id);
      const suiteCase = manifest.cases.find((item) => item.case_id === annotation.case_id);
      if (!input || !suiteCase?.applicability.human_accuracy) continue;
      const observed = new Map((input.observations ?? []).map((fact) => [fact.field, fact]));
      for (const fact of annotation.observation_facts ?? []) {
        const prediction = observed.get(fact.field);
        if (fact.applicability === "not_applicable") {
          if (prediction && prediction.applicability === "applicable" && prediction.value !== null) expectedHuman += 1;
          continue;
        }
        expectedHuman += 1;
        if (prediction?.applicability === "applicable" && equalValue(prediction.value, fact.value)) correctHuman += 1;
      }
      if (suiteCase.applicability.pair_relation) {
        const predicted = new Map((input.pair_relation_predictions ?? []).map((pair) => [pair.pair_id, pair.relation]));
        for (const pair of annotation.pair_labels ?? []) humanRelations.push({ relation: pair.relation, predicted: predicted.get(pair.pair_id) ?? "__missing__" });
      }
    }
    humanAccuracy = ratioMetric(correctHuman, expectedHuman);
    humanF1 = calculateRelations(humanRelations);
  }

  const failedVisual = visual.filter((item) => !groundedSuccess.includes(item));
  const groundedGate: EditorialEyeGate = {
    gate_id: "grounded_visual_success", namespace: "automatic_binary", status: groundedMetric.status, blocking: true,
    passed: groundedMetric.status === "measured" ? failedVisual.length === 0 : null,
    details: failedVisual.length ? failedVisual.map((item) => `${item.case_id}:zero_unsupported_unmeasured_or_degraded_grounding`) : [`${groundedSuccess.length}/${visual.length} applicable visual cases grounded`],
  };
  const humanPolicy = manifest.gate_policy.human_accuracy;
  const humanStatus = humanPolicy.metric_id === "human_accuracy" ? humanAccuracy.status : humanF1.status;
  const humanScalar = humanPolicy.metric_id === "human_accuracy" ? humanAccuracy.value : humanF1.macro_f1;
  const humanGate: EditorialEyeGate = {
    gate_id: humanPolicy.metric_id, namespace: "human", status: humanStatus,
    blocking: humanPolicy.enforcement === "blocking", passed: humanStatus === "measured" ? (humanScalar ?? 0) >= humanPolicy.threshold : null,
    details: [labels.human_evaluation.status === "approved" ? "approved_human_labels_evaluated" : "human_labels_unapproved"],
  };
  const regressions: EditorialEyeReport["regressions"] = [];
  for (const item of manifest.cases) {
    const input = inputs.get(item.case_id)!;
    const reason = input.degraded_reason ?? (input.status === "unsupported" ? "unsupported_capability" : input.status === "unmeasured" ? "unmeasured" : input.status === "failure" ? "failure" : null);
    if (!reason) continue;
    regressions.push({
      id: `${reason}:${item.case_id}`,
      severity: visualApplicable(item) ? "blocking" : "advisory",
      message: "Editorial Eye case did not produce a measured success",
      case_id: item.case_id, genre: item.genre, media_kind: item.media_kind, reason,
    });
  }
  for (const item of failedVisual) {
    if (regressions.some((entry) => entry.case_id === item.case_id && entry.severity === "blocking")) continue;
    regressions.push({ id: `grounded_visual_success:${item.case_id}`, severity: "blocking", message: "Applicable visual case did not produce grounded visual evidence", case_id: item.case_id, genre: item.genre, media_kind: item.media_kind, reason: "grounding_failed" });
  }
  if ((baseline.report.metrics.automatic_binary.grounded_visual_success.value ?? 0) > (groundedMetric.value ?? 0)) {
    regressions.push({ id: "grounded_visual_success:baseline_delta", severity: "blocking", message: "Grounded visual success regressed from immutable baseline", reason: "baseline_delta" });
  }
  regressions.sort((a, b) => a.id.localeCompare(b.id));
  const boundedRegressions = regressions.slice(0, 100);
  const gates = [groundedGate, humanGate, ...(manifest.gate_policy.reserved_gate_ids ?? []).map(unmeasuredGate)];
  const blockingFailures = [...gates.filter((gate) => gate.blocking && gate.passed !== true).map((gate) => gate.gate_id), ...boundedRegressions.filter((item) => item.severity === "blocking").map((item) => item.id)]
    .filter((item, index, all) => all.indexOf(item) === index);
  const report: EditorialEyeReport = {
    artifact_version: "editorial-eye-benchmark-report/v1", suite_id: EDITORIAL_EYE_SUITE_ID, suite_version: EDITORIAL_EYE_SUITE_VERSION,
    baseline_commit: manifest.baseline_commit, candidate_commit: options.candidateCommit, baseline_report_sha256: baseline.sha256,
    fixture_manifest_sha256: manifestSha, label_version: labels.label_version, generator: manifest.generator, provenance: candidateProvenance,
    metrics: {
      automatic_binary: automaticMetrics,
      human: { human_accuracy: humanAccuracy, human_f1: humanF1 },
      legacy_artifact_agreement: { status: "unmeasured", score: null },
    },
    breakdowns: makeBreakdowns(manifest.cases, inputs, labelsByCase), binary_gates: gates, regressions: boundedRegressions,
    resources: { model_runs: 0, generated_media_bytes: 0, wall_time_ms: 0 },
    verdict: { status: blockingFailures.length ? "fail" : "pass", blocking_failures: blockingFailures },
  };
  validateSchema(options.repoRoot, "editorial-eye-benchmark-report.schema.json", report, "candidate report");
  return report;
}

export function writeEditorialEyeReport(report: EditorialEyeReport, outputRoot: string): string {
  fs.mkdirSync(outputRoot, { recursive: true });
  const outputPath = path.join(outputRoot, `editorial-eye-${report.candidate_commit}.json`);
  fs.writeFileSync(outputPath, `${canonicalJson(report)}\n`);
  return outputPath;
}
