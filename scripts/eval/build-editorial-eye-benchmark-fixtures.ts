#!/usr/bin/env tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  EDITORIAL_EYE_GENRES,
  EDITORIAL_EYE_MEDIA_KINDS,
  canonicalJson,
  canonicalSha256,
  type EditorialEyeAutomaticLabel,
  type EditorialEyeGenre,
  type EditorialEyeMediaKind,
  type EditorialEyeReport,
  type EditorialEyeResultCase,
  type EditorialEyeSuiteCase,
  type EditorialEyeSuiteManifest,
} from "../../runtime/eval/editorial-eye-suite.js";

export interface FixtureProbe {
  decoded_frame_sha256?: string;
  stream_topology: string;
  duration_ms: number;
  audio_rms_db?: number;
  generated_bytes_sha256?: string;
}

export type FixtureProbeMap = Record<EditorialEyeMediaKind, FixtureProbe>;

export const FIXTURE_BASELINE_COMMIT = "e431da43c7fe7f4f50a688c3e8fcb48b50511453";

const GENRE_INTENTS: Record<EditorialEyeGenre, string> = {
  interview_dialogue: "Preserve speaker continuity, response timing, and conversational clarity.",
  quiet_documentary: "Respect stillness, room tone, and observational pacing.",
  product_detail: "Keep the product legible and detail changes spatially coherent.",
  action_event: "Track action peaks without losing event causality.",
  vertical_social_montage: "Deliver an immediate vertical hook with readable rhythmic progression.",
  chronological_longform: "Preserve chronology and long-form temporal orientation.",
  intentional_jump_smash_match: "Recognize intentional jump, smash, and match transitions without false hard-fails.",
};

function caseId(genre: EditorialEyeGenre, mediaKind: EditorialEyeMediaKind): string {
  return `${genre}--${mediaKind}`;
}

function expectedFacts(mediaKind: EditorialEyeMediaKind, probe: FixtureProbe) {
  if (mediaKind === "sequence") return [];
  const audio = mediaKind === "audio" || mediaKind === "mixed";
  const visual = mediaKind === "video" || mediaKind === "image" || mediaKind === "mixed";
  return [
    { field: "stream_topology", value: probe.stream_topology, applicability: "applicable" as const },
    { field: "duration_ms", value: probe.duration_ms, applicability: "applicable" as const },
    { field: "audio_present", value: audio, applicability: "applicable" as const },
    { field: "decoded_frame_sha256", value: visual ? probe.decoded_frame_sha256 ?? null : null, applicability: visual ? "applicable" as const : "not_applicable" as const },
    { field: "audio_rms_db", value: audio ? probe.audio_rms_db ?? null : null, applicability: audio ? "applicable" as const : "not_applicable" as const },
  ];
}

function observations(mediaKind: EditorialEyeMediaKind, probe: FixtureProbe) {
  return expectedFacts(mediaKind, probe).map((fact) => ({
    field: fact.field,
    value: fact.value,
    evidence_ref: fact.applicability === "applicable" ? `generated-${mediaKind}#${fact.field}` : null,
    confidence: fact.applicability === "applicable" ? 1 : null,
    applicability: fact.applicability,
  }));
}

function buildCase(genre: EditorialEyeGenre, mediaKind: EditorialEyeMediaKind): EditorialEyeSuiteCase {
  const unsupported = mediaKind === "sequence";
  const visual = mediaKind === "video" || mediaKind === "image" || mediaKind === "mixed";
  return {
    case_id: caseId(genre, mediaKind), genre, media_kind: mediaKind, fixture_id: `generated-${mediaKind}`,
    evidence_tier: unsupported ? "unsupported_capability" : "real_generated_pixel_audio",
    required_lanes: mediaKind === "mixed" ? ["visual_grounding", "audio_analysis"] : mediaKind === "audio" ? ["audio_analysis"] : mediaKind === "sequence" ? ["sequence_pipeline"] : ["visual_grounding"],
    genre_intent: GENRE_INTENTS[genre],
    applicability: { grounded_visual_accuracy: visual && !unsupported, observation_accuracy: !unsupported, pair_relation: false, human_accuracy: !unsupported },
  };
}

export function buildContractArtifacts(probes: FixtureProbeMap) {
  const cases = EDITORIAL_EYE_GENRES.flatMap((genre) => EDITORIAL_EYE_MEDIA_KINDS.map((kind) => buildCase(genre, kind)));
  const generator = { id: "editorial-eye-lavfi-fixtures", version: "1.0.0", fixture_set_id: "editorial-eye-v1-7x5" };
  const provenance = { environment: { execution: "deterministic_generated_contract", platform: "portable", benchmark_scope: "metric_adapter_oracle_not_pipeline_or_model_quality" }, models: [], degraded: [] };
  const suite: EditorialEyeSuiteManifest = {
    artifact_version: "editorial-eye-benchmark-suite/v1", suite_id: "editorial-eye-v1", version: "1.0.0", baseline_commit: FIXTURE_BASELINE_COMMIT,
    generator, contract_provenance: provenance, cases,
    gate_policy: { grounded_visual_success: { gate_id: "grounded_visual_success", blocking: true }, human_accuracy: { metric_id: "human_accuracy", enforcement: "advisory", threshold: 0.8 }, reserved_gate_ids: ["source_freshness", "rollback", "preference_isolation"] },
  };
  const manifestSha = canonicalSha256(suite);
  const automatic: EditorialEyeAutomaticLabel[] = cases.map((item) => ({
    case_id: item.case_id, ground_truth_ids: item.media_kind === "sequence" ? [] : [`generated-${item.media_kind}--probe`], observation_expected_facts: expectedFacts(item.media_kind, probes[item.media_kind]),
    pair_labels: [], intentional_transition_labels: [],
  }));
  const labels = {
    artifact_version: "editorial-eye-benchmark-labels/v1", suite_id: "editorial-eye-v1", suite_version: "1.0.0", label_version: "labels-v2", fixture_manifest_sha256: manifestSha,
    automatic_ground_truth: automatic, human_evaluation: { status: "unapproved", annotations: [], annotator_disagreement: [] },
  };
  const resultCases: EditorialEyeResultCase[] = cases.map((item) => {
    const unsupported = item.media_kind === "sequence";
    const visual = item.media_kind === "video" || item.media_kind === "image" || item.media_kind === "mixed";
    if (!probes[item.media_kind]) throw new Error(`generated fixture probe missing for ${item.media_kind}`);
    return {
      case_id: item.case_id, genre: item.genre, media_kind: item.media_kind,
      status: unsupported ? "unsupported" : "success", supported: !unsupported, grounded_frame_count: visual ? (item.media_kind === "image" ? 1 : 2) : 0,
      ground_truth_ids: unsupported ? [] : [`generated-${item.media_kind}--probe`], observations: unsupported ? [] : observations(item.media_kind, probes[item.media_kind]),
      pair_relation_predictions: [], hard_fail: { decision: false, reasons: [] },
      ...(unsupported ? {} : { decoded_fixture_fingerprints: probes[item.media_kind] }),
    };
  });
  const results = { artifact_version: "editorial-eye-benchmark-results/v1", suite_id: "editorial-eye-v1", suite_version: "1.0.0", fixture_manifest_sha256: manifestSha, label_version: "labels-v2", generator, provenance, cases: resultCases };
  const counts = { applicable: 4, unsupported: 1, unmeasured: 0, success: 4, failure: 0 };
  const mediaCounts = (kind: EditorialEyeMediaKind) => kind === "sequence" ? { applicable: 0, unsupported: 7, unmeasured: 0, success: 0, failure: 0 } : { applicable: 7, unsupported: 0, unmeasured: 0, success: 7, failure: 0 };
  const calibrationBins = Array.from({ length: 5 }, (_, index) => ({ lower: index / 5, upper: (index + 1) / 5, count: index === 4 ? 119 : 0, mean_confidence: index === 4 ? 1 : null, accuracy: index === 4 ? 1 : null }));
  const ratio = (numerator: number, denominator: number) => denominator ? { status: "measured" as const, value: numerator / denominator, numerator, denominator } : { status: "unmeasured" as const, value: null, numerator: 0, denominator: 0 };
  const calibration = (sampleCount: number) => ({
    status: sampleCount >= 5 ? "measured" as const : "unmeasured" as const,
    ece: sampleCount >= 5 ? 0 : null,
    sample_count: sampleCount,
    minimum_sample_count: 5,
    bins: Array.from({ length: 5 }, (_, index) => ({ lower: index / 5, upper: (index + 1) / 5, count: index === 4 ? sampleCount : 0, mean_confidence: index === 4 && sampleCount ? 1 : null, accuracy: index === 4 && sampleCount ? 1 : null })),
  });
  const relation = (continuous: number, transitionEach: number) => {
    const labels = [...(continuous ? ["continuous"] : []), ...(transitionEach ? ["jump", "match", "smash"] : [])];
    return labels.length ? {
      status: "measured" as const, macro_f1: 1, sample_count: continuous + transitionEach * 3, labels,
      confusion_matrix: Object.fromEntries(labels.map((actual) => [actual, Object.fromEntries(labels.map((predicted) => [predicted, actual === predicted ? (actual === "continuous" ? continuous : transitionEach) : 0]))])),
    } : { status: "unmeasured" as const, macro_f1: null, sample_count: 0, labels: [], confusion_matrix: {} };
  };
  const groupMetrics = (grounded: number, groundedDenominator: number, observationCount: number, pairContinuous: number, pairTransitions: number, intentional: number) => ({
    grounded_visual_success: ratio(grounded, groundedDenominator),
    observation_field_coverage: ratio(observationCount, observationCount),
    observation_agreement_accuracy: ratio(observationCount, observationCount),
    confidence_calibration: calibration(observationCount),
    pair_relation: relation(pairContinuous, pairTransitions),
    false_hard_fail_rate: ratio(0, intentional),
  });
  const unsupportedRegressions = cases.filter((item) => item.media_kind === "sequence").map((item) => ({ id: `unsupported_capability:${item.case_id}`, severity: "advisory" as const, message: "Editorial Eye case did not produce a measured success", case_id: item.case_id, genre: item.genre, media_kind: item.media_kind, reason: "unsupported_capability" })).sort((a, b) => a.id.localeCompare(b.id));
  const baseline: EditorialEyeReport = {
    artifact_version: "editorial-eye-benchmark-report/v1", suite_id: "editorial-eye-v1", suite_version: "1.0.0", baseline_commit: FIXTURE_BASELINE_COMMIT, candidate_commit: FIXTURE_BASELINE_COMMIT, baseline_report_sha256: null,
    fixture_manifest_sha256: manifestSha, label_version: "labels-v2", generator, provenance,
    metrics: {
      automatic_binary: {
        grounded_visual_success: { status: "measured", value: 1, numerator: 21, denominator: 21 }, observation_field_coverage: { status: "measured", value: 1, numerator: 119, denominator: 119 },
        observation_agreement_accuracy: { status: "measured", value: 1, numerator: 119, denominator: 119 }, confidence_calibration: { status: "measured", ece: 0, sample_count: 119, minimum_sample_count: 5, bins: calibrationBins },
        pair_relation: { status: "unmeasured", macro_f1: null, sample_count: 0, labels: [], confusion_matrix: {} }, false_hard_fail_rate: { status: "unmeasured", value: null, numerator: 0, denominator: 0 },
      },
      human: { human_accuracy: { status: "unmeasured", value: null, numerator: 0, denominator: 0 }, human_f1: { status: "unmeasured", macro_f1: null, sample_count: 0, labels: [], confusion_matrix: {} } },
      legacy_artifact_agreement: { status: "unmeasured", score: null },
    },
    breakdowns: {
      by_genre: Object.fromEntries(EDITORIAL_EYE_GENRES.map((genre) => [genre, counts])) as EditorialEyeReport["breakdowns"]["by_genre"],
      by_media_kind: Object.fromEntries(EDITORIAL_EYE_MEDIA_KINDS.map((kind) => [kind, mediaCounts(kind)])) as EditorialEyeReport["breakdowns"]["by_media_kind"],
      metrics_by_genre: Object.fromEntries(EDITORIAL_EYE_GENRES.map((genre) => [genre, groupMetrics(3, 3, 17, 0, 0, 0)])) as EditorialEyeReport["breakdowns"]["metrics_by_genre"],
      metrics_by_media_kind: {
        video: groupMetrics(7, 7, 28, 0, 0, 0),
        audio: groupMetrics(0, 0, 28, 0, 0, 0),
        image: groupMetrics(7, 7, 28, 0, 0, 0),
        sequence: groupMetrics(0, 0, 0, 0, 0, 0),
        mixed: groupMetrics(7, 7, 35, 0, 0, 0),
      },
    },
    binary_gates: [
      { gate_id: "grounded_visual_success", namespace: "automatic_binary", status: "measured", blocking: true, passed: true, details: ["21/21 applicable visual cases grounded"] },
      { gate_id: "human_accuracy", namespace: "human", status: "unmeasured", blocking: false, passed: null, details: ["human_labels_unapproved"] },
      ...(["source_freshness", "rollback", "preference_isolation"] as const).map((gate_id) => ({ gate_id, namespace: "automatic_binary" as const, status: "unmeasured" as const, blocking: false, passed: null, details: ["reserved_not_measured_in_v1"] })),
    ],
    regressions: unsupportedRegressions, resources: { model_runs: 0, generated_media_bytes: 0, wall_time_ms: 0 }, verdict: { status: "pass", blocking_failures: [] },
  };
  return { suite, labels, results, baseline, manifestSha };
}

export function probesFromGeneratedMediaManifest(manifestPath: string): FixtureProbeMap {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { status?: string; fixtures?: Array<FixtureProbe & { media_kind: EditorialEyeMediaKind }> };
  if (manifest.status !== "generated") throw new Error("generated media manifest must have status=generated");
  const probes = Object.fromEntries((manifest.fixtures ?? []).map(({ media_kind, decoded_frame_sha256, stream_topology, duration_ms, audio_rms_db, generated_bytes_sha256 }) => [media_kind, { decoded_frame_sha256, stream_topology, duration_ms, audio_rms_db, generated_bytes_sha256 }])) as FixtureProbeMap;
  for (const kind of EDITORIAL_EYE_MEDIA_KINDS) if (!probes[kind]) throw new Error(`generated media manifest missing ${kind}`);
  return probes;
}

export function writeContractArtifacts(outputRoot: string, probes: FixtureProbeMap): { manifestSha: string; files: string[] } {
  const artifacts = buildContractArtifacts(probes);
  fs.mkdirSync(outputRoot, { recursive: true });
  const entries = [["suite.json", artifacts.suite], ["labels.json", artifacts.labels], ["results.json", artifacts.results], ["baseline-report.json", artifacts.baseline]] as const;
  const files: string[] = [];
  for (const [name, value] of entries) {
    const target = path.join(outputRoot, name);
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    files.push(target);
  }
  return { manifestSha: artifacts.manifestSha, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputIndex = process.argv.indexOf("--output-root");
  const outputRoot = outputIndex >= 0 && process.argv[outputIndex + 1] ? path.resolve(process.argv[outputIndex + 1]) : path.resolve(import.meta.dirname, "../../tests/fixtures/editorial-eye/v1");
  const manifestIndex = process.argv.indexOf("--generated-media-manifest");
  const generatedManifest = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : undefined;
  if (!generatedManifest) throw new Error("--generated-media-manifest is required; contract fixtures cannot claim measured evidence without real probes");
  console.log(canonicalJson(writeContractArtifacts(outputRoot, probesFromGeneratedMediaManifest(path.resolve(generatedManifest)))));
}
