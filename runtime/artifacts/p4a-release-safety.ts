import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { computeNormalizedJsonHash } from "./p1-manifest-coverage.js";
import { validateAgainstSchema } from "../commands/shared.js";
import {
  generateDeliveryProfileChecks,
  isP4bDeliveryProfilesEnabled,
  loadDeliveryProfiles,
  type CaptionArtifact,
  type DeliveryReleaseMode,
} from "./p4b-delivery-profile.js";

export type ReleaseSafetyMode = "dry_run" | "report_only" | "enforce";
export type ReleaseSafetyProducer = "/package" | "/render";
export type ReleaseSafetyCategory =
  | "editorial_review"
  | "schema_validation"
  | "technical_qa"
  | "delivery_profile"
  | "rights"
  | "privacy"
  | "source_of_truth"
  | "caption_audio"
  | "music_audio"
  | "package_completeness"
  | "source_manifest";

export interface ReleaseSafetyArtifactRef {
  path: string;
  hash: string | null;
  required?: boolean;
}

export interface ReleaseSafetyCheck {
  check_id: string;
  category: ReleaseSafetyCategory;
  severity: "info" | "warning" | "blocker" | "fatal";
  status: "pass" | "fail" | "not_evaluated" | "waived";
  message: string;
  artifact_refs: ReleaseSafetyArtifactRef[];
}

export interface ReleaseSafetyWaiver {
  waiver_id: string;
  approved_by: string;
  approved_at: string;
  scope: string;
  reason: string;
  expires_at?: string | null;
  applies_to_artifact_hash?: string | null;
}

export interface ReleaseSafetyReport {
  version: "1.0.0";
  project_id: string;
  artifact_version: "release-safety-v1";
  created_at: string;
  base_timeline_version: string;
  source_of_truth: "engine_render" | "nle_finishing";
  mode: ReleaseSafetyMode;
  summary: {
    status: "pass" | "blocked" | "pass_with_waiver" | "not_evaluated";
    fatal_count: number;
    blocker_count: number;
    warning_count: number;
    waived_count: number;
  };
  checks: ReleaseSafetyCheck[];
  waivers: ReleaseSafetyWaiver[];
  provenance: {
    producer: ReleaseSafetyProducer;
    inputs: ReleaseSafetyArtifactRef[];
    hash_policy: {
      algorithm: "sha256";
      canonicalization: "yaml-to-normalized-json-v1";
      excluded_fields: string[];
    };
  };
}

export interface BuildReleaseSafetyReportOptions {
  projectDir: string;
  producer: ReleaseSafetyProducer;
  mode?: ReleaseSafetyMode;
  createdAt?: string;
  sourceOfTruth?: "engine_render" | "nle_finishing";
  waivers?: ReleaseSafetyWaiver[];
}

export interface ReleaseSafetyPreflightResult {
  exitCode: 0;
  report: ReleaseSafetyReport;
  reportPath?: string;
}

interface ArtifactInput {
  relPath: string;
  schemaFile?: string;
  format: "json" | "yaml" | "jsonl";
  required: boolean;
}

const INPUTS: ArtifactInput[] = [
  { relPath: "05_timeline/timeline.json", schemaFile: "timeline-ir.schema.json", format: "json", required: true },
  { relPath: "06_review/review_report.yaml", schemaFile: "review-report.schema.json", format: "yaml", required: false },
  { relPath: "07_package/package_manifest.json", schemaFile: "package-manifest.schema.json", format: "json", required: false },
  { relPath: "07_package/caption_approval.json", schemaFile: "caption-approval.schema.json", format: "json", required: false },
  { relPath: "07_package/music_cues.json", schemaFile: "music-cues.schema.json", format: "json", required: false },
  { relPath: "02_media/source_media_manifest.json", schemaFile: "source-media-manifest.schema.json", format: "json", required: false },
  { relPath: "03_analysis/analysis_coverage_report.json", schemaFile: "analysis-coverage-report.schema.json", format: "json", required: false },
  { relPath: "03_analysis/audio_story_graph.json", schemaFile: "audio-story-graph.schema.json", format: "json", required: false },
  { relPath: "03_analysis/continuity_graph.json", schemaFile: "continuity-graph.schema.json", format: "json", required: false },
  { relPath: "03_analysis/editorial_preference_memory.jsonl", schemaFile: "editorial-preference-memory-entry.schema.json", format: "jsonl", required: false },
  { relPath: "07_package/qa-report.json", schemaFile: "package-qa-report.schema.json", format: "json", required: false },
];

export function isP4aReleaseSafetyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.ENABLE_P4A_RELEASE_SAFETY ?? "");
}

export function getReleaseSafetyMode(env: NodeJS.ProcessEnv = process.env): ReleaseSafetyMode {
  const raw = env.RELEASE_SAFETY_MODE ?? "dry_run";
  if (raw === "dry_run" || raw === "report_only" || raw === "enforce") return raw;
  throw new Error(`Invalid RELEASE_SAFETY_MODE: ${raw}`);
}

export function runReleaseSafetyPreflight(
  options: BuildReleaseSafetyReportOptions,
): ReleaseSafetyPreflightResult {
  const mode = options.mode ?? getReleaseSafetyMode();
  if (mode === "report_only") {
    // TODO(P4b): implement report_only escalation without blocking package/render.
    throw new Error("not_implemented_in_p4a");
  }
  if (mode === "enforce") {
    // TODO(P4c): implement enforce mode and package/render blocking behavior.
    throw new Error("not_implemented_in_p4a");
  }
  const report = buildReleaseSafetyReport({ ...options, mode });
  return { exitCode: 0, report };
}

export function buildReleaseSafetyReport(
  options: BuildReleaseSafetyReportOptions,
): ReleaseSafetyReport {
  const projectDir = path.resolve(options.projectDir);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const artifacts = readArtifacts(projectDir);
  const timeline = artifacts.get("05_timeline/timeline.json")?.data as Record<string, unknown> | undefined;
  const projectId = typeof timeline?.project_id === "string"
    ? timeline.project_id
    : path.basename(projectDir);
  const baseTimelineVersion = typeof timeline?.version === "string" ? timeline.version : "unknown";
  const sourceOfTruth = options.sourceOfTruth ?? inferSourceOfTruth(projectDir);
  const mode = options.mode ?? "dry_run";

  const checks: ReleaseSafetyCheck[] = [
    ...checkEditorialReview(projectDir, artifacts),
    checkSchemaValidation(projectDir, artifacts),
    checkTechnicalQa(projectDir, artifacts),
    ...checkDeliveryProfile(projectDir, artifacts),
    checkRights(projectDir, artifacts),
    checkPrivacy(projectDir, artifacts),
    checkSourceOfTruth(projectDir, sourceOfTruth),
    checkCaptionAudio(projectDir, artifacts),
    checkMusicAudio(projectDir, artifacts),
    checkPackageCompleteness(projectDir, artifacts),
    checkSourceManifest(projectDir, artifacts),
  ];
  const waivers = options.waivers ?? [];
  const waivedChecks = applyWaivers(checks, waivers);

  return {
    version: "1.0.0",
    project_id: projectId,
    artifact_version: "release-safety-v1",
    created_at: createdAt,
    base_timeline_version: baseTimelineVersion,
    source_of_truth: sourceOfTruth,
    mode,
    summary: summarize(waivedChecks),
    checks: waivedChecks,
    waivers,
    provenance: {
      producer: options.producer,
      inputs: INPUTS.map((input) => artifactRef(projectDir, input.relPath, input.required)),
      hash_policy: {
        algorithm: "sha256",
        canonicalization: "yaml-to-normalized-json-v1",
        excluded_fields: ["created_at"],
      },
    },
  };
}

export function writeReleaseSafetyReport(projectDir: string, report: ReleaseSafetyReport): string {
  const outputPath = path.join(projectDir, "07_package/release_safety_report.yaml");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, stringifyYaml(report), "utf-8");
  return outputPath;
}

export function readReleaseSafetySummary(projectDir: string): {
  path: string;
  mode?: string;
  summary?: ReleaseSafetyReport["summary"];
  valid: boolean;
  error?: string;
} | undefined {
  const reportPath = path.join(projectDir, "07_package/release_safety_report.yaml");
  if (!fs.existsSync(reportPath)) return undefined;
  try {
    const parsed = parseCanonicalYaml(fs.readFileSync(reportPath, "utf-8")) as Partial<ReleaseSafetyReport>;
    return { path: reportPath, mode: parsed.mode, summary: parsed.summary, valid: true };
  } catch (err) {
    return { path: reportPath, valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function computeReleaseSafetyReportHash(report: unknown): string {
  return computeNormalizedJsonHash(report, ["created_at"]);
}

export function parseCanonicalYaml(raw: string): unknown {
  rejectYamlAnchorsAndAliases(raw);
  return parseYaml(raw);
}

export function validateReleaseSafetyReportIntegrity(data: unknown): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  const report = data as Partial<ReleaseSafetyReport>;
  const checkIds = new Set<string>();
  const waiverIds = new Set<string>();
  for (const check of report.checks ?? []) {
    if (!check.check_id?.startsWith("RSCHK_")) violations.push(`invalid check_id ${check.check_id}`);
    if (checkIds.has(check.check_id)) violations.push(`duplicate check_id ${check.check_id}`);
    checkIds.add(check.check_id);
  }
  for (const waiver of report.waivers ?? []) {
    if (!waiver.waiver_id?.startsWith("RSWVR_")) violations.push(`invalid waiver_id ${waiver.waiver_id}`);
    if (waiverIds.has(waiver.waiver_id)) violations.push(`duplicate waiver_id ${waiver.waiver_id}`);
    waiverIds.add(waiver.waiver_id);
  }
  const unwaivedFatal = (report.checks ?? []).some((check) =>
    check.severity === "fatal" && check.status === "fail"
  );
  if (report.mode === "enforce" && report.summary?.status === "pass" && unwaivedFatal) {
    violations.push("enforce mode cannot pass with an unwaived fatal check");
  }
  if (report.summary?.status === "pass" && (report.summary.fatal_count > 0 || report.summary.blocker_count > 0)) {
    violations.push("summary pass cannot include fatal or blocker counts");
  }
  return { valid: violations.length === 0, violations };
}

export function waiverMatchesCheck(waiver: ReleaseSafetyWaiver, check: ReleaseSafetyCheck): boolean {
  const scope = waiver.scope.toLowerCase();
  if (scope.includes(check.check_id.toLowerCase())) return true;
  if (scope === check.category.toLowerCase()) return true;
  if (scope.startsWith(`${check.category.toLowerCase()}:`)) return true;
  if (check.message.toLowerCase().includes(scope)) return true;
  if (scope.startsWith("creative_override:")) {
    const beat = scope.slice("creative_override:".length);
    return check.category === "editorial_review" && check.message.toLowerCase().includes(beat);
  }
  return check.artifact_refs.some((ref) =>
    ref.path.toLowerCase().includes(scope) ||
    (!!ref.hash && ref.hash === waiver.applies_to_artifact_hash)
  );
}

function readArtifacts(projectDir: string): Map<string, { data: unknown; hash: string }> {
  const artifacts = new Map<string, { data: unknown; hash: string }>();
  for (const input of INPUTS) {
    const filePath = path.join(projectDir, input.relPath);
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      let data: unknown;
      if (input.format === "yaml") data = parseCanonicalYaml(raw);
      else if (input.format === "json") data = JSON.parse(raw);
      else data = raw.split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
      artifacts.set(input.relPath, { data, hash: sha256File(filePath) });
    } catch {
      artifacts.set(input.relPath, { data: null, hash: sha256File(filePath) });
    }
  }
  return artifacts;
}

function checkEditorialReview(
  projectDir: string,
  artifacts: Map<string, { data: unknown; hash: string }>,
): ReleaseSafetyCheck[] {
  const relPath = "06_review/review_report.yaml";
  const artifact = artifacts.get(relPath);
  const ref = artifactRef(projectDir, relPath, false);
  if (!artifact) return [check("editorial_review", "info", "pass", "RSCHK_editorial_review_missing", "review_report.yaml absent; no fatal review findings available", [ref])];
  const report = artifact.data as { fatal_issues?: Array<{ summary?: string; affected_beat_ids?: string[] }> };
  const fatalIssues = Array.isArray(report.fatal_issues) ? report.fatal_issues : [];
  if (fatalIssues.length === 0) {
    return [check("editorial_review", "info", "pass", "RSCHK_editorial_review_clean", "review_report.yaml has no fatal issues", [ref])];
  }
  return fatalIssues.map((issue, index) => {
    const beats = Array.isArray(issue.affected_beat_ids) ? issue.affected_beat_ids.join(",") : "unknown";
    return check(
      "editorial_review",
      "fatal",
      "fail",
      `RSCHK_editorial_review_fatal_${index + 1}`,
      `${issue.summary ?? "fatal review issue"} beat_refs=${beats}`,
      [ref],
    );
  });
}

function checkSchemaValidation(
  projectDir: string,
  artifacts: Map<string, { data: unknown; hash: string }>,
): ReleaseSafetyCheck {
  const failures: string[] = [];
  for (const input of INPUTS) {
    if (!input.schemaFile || input.format === "jsonl") continue;
    const artifact = artifacts.get(input.relPath);
    if (!artifact) continue;
    try {
      const result = validateAgainstSchema(artifact.data, input.schemaFile);
      if (!result.valid) failures.push(`${input.relPath}: ${result.errors.join("; ")}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${input.relPath}: schema validation unavailable: ${message}`);
    }
  }
  return check(
    "schema_validation",
    failures.length > 0 ? "warning" : "info",
    failures.length > 0 ? "fail" : "pass",
    "RSCHK_schema_validation",
    failures.length > 0 ? `schema validation warnings: ${failures.join(" | ")}` : "available artifacts passed schema validation",
    INPUTS.map((input) => artifactRef(projectDir, input.relPath, input.required)),
  );
}

function checkTechnicalQa(projectDir: string, artifacts: Map<string, { data: unknown; hash: string }>): ReleaseSafetyCheck {
  const relPath = "07_package/qa-report.json";
  const artifact = artifacts.get(relPath);
  if (!artifact) {
    return check("technical_qa", "warning", "fail", "RSCHK_technical_qa_missing", "qa-report.json is absent in dry_run", [artifactRef(projectDir, relPath, false)]);
  }
  const qa = artifact.data as { passed?: boolean };
  return check("technical_qa", qa.passed === false ? "blocker" : "info", qa.passed === false ? "fail" : "pass", "RSCHK_technical_qa", qa.passed === false ? "package QA failed" : "package QA passed or is advisory", [artifactRef(projectDir, relPath, false)]);
}

function checkDeliveryProfile(projectDir: string, artifacts: Map<string, { data: unknown; hash: string }>): ReleaseSafetyCheck[] {
  if (!isP4bDeliveryProfilesEnabled()) {
    return [check("delivery_profile", "info", "not_evaluated", "RSCHK_delivery_profile_p4b", "delivery profile enforcement is deferred to P4b", [{ path: path.join(projectDir, "07_package/delivery_profiles/default.yaml"), hash: null, required: false }])];
  }
  const loaded = loadDeliveryProfiles(projectDir);
  const packageManifest = artifacts.get("07_package/package_manifest.json")?.data;
  return generateDeliveryProfileChecks({
    projectDir,
    timeline: artifacts.get("05_timeline/timeline.json")?.data,
    packageManifest,
    packageQaReport: artifacts.get("07_package/qa-report.json")?.data,
    captionArtifacts: captionArtifactsFromManifest(packageManifest),
    profiles: loaded.profiles,
    malformed: loaded.malformed,
    expectedReleaseMode: expectedReleaseModeFromProfiles(loaded.profiles.map((item) => item.profile)),
  });
}

function captionArtifactsFromManifest(packageManifest: unknown): CaptionArtifact[] {
  const captions = (packageManifest as { artifacts?: { captions?: unknown[] } } | undefined)?.artifacts?.captions ?? [];
  return captions
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      path: typeof item.path === "string" ? item.path : "",
      format: typeof item.delivery === "string"
        ? item.delivery
        : typeof item.kind === "string"
          ? item.kind
          : null,
    }));
}

function expectedReleaseModeFromProfiles(profiles: Array<{ release_mode?: DeliveryReleaseMode }>): DeliveryReleaseMode {
  if (profiles.some((profile) => profile.release_mode === "public")) return "public";
  if (profiles.some((profile) => profile.release_mode === "external")) return "external";
  return "public";
}

function checkRights(projectDir: string, artifacts: Map<string, { data: unknown; hash: string }>): ReleaseSafetyCheck {
  const relPath = "02_media/source_media_manifest.json";
  const manifest = artifacts.get(relPath)?.data as { items?: Array<{ rights_status?: string }> } | undefined;
  const unknown = manifest?.items?.filter((item) => item.rights_status === "unknown").length ?? 0;
  const blocked = manifest?.items?.filter((item) => item.rights_status === "blocked" || item.rights_status === "restricted").length ?? 0;
  if (!manifest) return check("rights", "warning", "fail", "RSCHK_rights_manifest_missing", "source media manifest is absent; rights cannot be evaluated", [artifactRef(projectDir, relPath, false)]);
  if (blocked > 0) return check("rights", "fatal", "fail", "RSCHK_rights_blocked", `${blocked} source assets have blocked or restricted rights`, [artifactRef(projectDir, relPath, false)]);
  if (unknown > 0) return check("rights", "warning", "fail", "RSCHK_rights_unknown", `${unknown} source assets have unknown rights`, [artifactRef(projectDir, relPath, false)]);
  return check("rights", "info", "pass", "RSCHK_rights_declared", "source rights are declared", [artifactRef(projectDir, relPath, false)]);
}

function checkPrivacy(projectDir: string, artifacts: Map<string, { data: unknown; hash: string }>): ReleaseSafetyCheck {
  const manifestRel = "02_media/source_media_manifest.json";
  const continuityRel = "03_analysis/continuity_graph.json";
  const manifest = artifacts.get(manifestRel)?.data as { items?: Array<{ privacy_status?: string }> } | undefined;
  const continuity = artifacts.get(continuityRel)?.data as { entities?: Array<{ status?: string }> } | undefined;
  const blocked = manifest?.items?.filter((item) => item.privacy_status === "blocked" || item.privacy_status === "sensitive").length ?? 0;
  const unconfirmedSubjects = continuity?.entities?.filter((entity) => entity.status === "confirmed_editing_continuity").length ?? 0;
  if (blocked > 0) return check("privacy", "fatal", "fail", "RSCHK_privacy_blocked", `${blocked} source assets have blocked or sensitive privacy status`, [artifactRef(projectDir, manifestRel, false)]);
  if (unconfirmedSubjects > 0) return check("privacy", "warning", "fail", "RSCHK_privacy_unconfirmed_subjects", `${unconfirmedSubjects} continuity entities are not human_confirmed`, [artifactRef(projectDir, continuityRel, false)]);
  return check("privacy", "info", "pass", "RSCHK_privacy_review", "privacy inputs have no release blockers in dry_run", [artifactRef(projectDir, manifestRel, false), artifactRef(projectDir, continuityRel, false)]);
}

function checkSourceOfTruth(projectDir: string, sourceOfTruth: "engine_render" | "nle_finishing"): ReleaseSafetyCheck {
  return check("source_of_truth", "info", "pass", "RSCHK_source_of_truth", `source_of_truth=${sourceOfTruth}`, [artifactRef(projectDir, "project_state.yaml", false)]);
}

function checkCaptionAudio(projectDir: string, artifacts: Map<string, { data: unknown; hash: string }>): ReleaseSafetyCheck {
  const caption = artifacts.get("07_package/caption_approval.json")?.data as { base_timeline_version?: string } | undefined;
  const audio = artifacts.get("03_analysis/audio_story_graph.json")?.data;
  if (!caption) return check("caption_audio", "info", "pass", "RSCHK_caption_audio_optional", "caption approval absent; dry_run records optional caption/audio check", [artifactRef(projectDir, "07_package/caption_approval.json", false)]);
  return check("caption_audio", audio ? "info" : "warning", audio ? "pass" : "fail", "RSCHK_caption_audio_refs", audio ? "caption and audio story inputs are both present" : "caption approval present without audio_story_graph", [artifactRef(projectDir, "07_package/caption_approval.json", false), artifactRef(projectDir, "03_analysis/audio_story_graph.json", false)]);
}

function checkMusicAudio(projectDir: string, artifacts: Map<string, { data: unknown; hash: string }>): ReleaseSafetyCheck {
  const music = artifacts.get("07_package/music_cues.json")?.data;
  const audio = artifacts.get("03_analysis/audio_story_graph.json")?.data;
  if (!music) return check("music_audio", "info", "pass", "RSCHK_music_audio_optional", "music cues absent; dry_run records optional music/audio check", [artifactRef(projectDir, "07_package/music_cues.json", false)]);
  return check("music_audio", audio ? "info" : "warning", audio ? "pass" : "fail", "RSCHK_music_audio_refs", audio ? "music cues and audio story inputs are both present" : "music cues present without audio_story_graph", [artifactRef(projectDir, "07_package/music_cues.json", false), artifactRef(projectDir, "03_analysis/audio_story_graph.json", false)]);
}

function checkPackageCompleteness(projectDir: string, artifacts: Map<string, { data: unknown; hash: string }>): ReleaseSafetyCheck {
  const relPath = "07_package/package_manifest.json";
  const manifest = artifacts.get(relPath)?.data as { artifacts?: Record<string, unknown> } | undefined;
  const complete = !!manifest?.artifacts;
  return check("package_completeness", complete ? "info" : "warning", complete ? "pass" : "fail", "RSCHK_package_completeness", complete ? "package manifest has artifact inventory" : "package_manifest.json missing artifact inventory", [artifactRef(projectDir, relPath, false)]);
}

function checkSourceManifest(projectDir: string, artifacts: Map<string, { data: unknown; hash: string }>): ReleaseSafetyCheck {
  const relPath = "02_media/source_media_manifest.json";
  const manifest = artifacts.get(relPath);
  if (!manifest) return check("source_manifest", "warning", "fail", "RSCHK_source_manifest_missing", "source_media_manifest.json is absent", [artifactRef(projectDir, relPath, false)]);
  const currentHash = computeNormalizedJsonHash(manifest.data, ["created_at"]);
  const staleArtifacts = ["03_analysis/analysis_coverage_report.json", "03_analysis/audio_story_graph.json", "03_analysis/continuity_graph.json"]
    .filter((rel) => {
      const data = artifacts.get(rel)?.data as { source_media_manifest_hash?: string } | undefined;
      return data?.source_media_manifest_hash && data.source_media_manifest_hash !== currentHash;
    });
  if (staleArtifacts.length > 0) {
    return check("source_manifest", "blocker", "fail", "RSCHK_source_manifest_stale_refs", `stale source manifest hash refs: ${staleArtifacts.join(", ")}`, [artifactRef(projectDir, relPath, false), ...staleArtifacts.map((rel) => artifactRef(projectDir, rel, false))]);
  }
  return check("source_manifest", "info", "pass", "RSCHK_source_manifest_fresh", "source manifest refs are fresh", [artifactRef(projectDir, relPath, false)]);
}

function applyWaivers(checks: ReleaseSafetyCheck[], waivers: ReleaseSafetyWaiver[]): ReleaseSafetyCheck[] {
  return checks.map((check) => {
    if (check.status !== "fail") return check;
    const matched = waivers.find((waiver) => waiverMatchesCheck(waiver, check));
    return matched ? { ...check, status: "waived" } : check;
  });
}

function summarize(checks: ReleaseSafetyCheck[]): ReleaseSafetyReport["summary"] {
  const fatalCount = checks.filter((check) => check.status === "fail" && check.severity === "fatal").length;
  const blockerCount = checks.filter((check) => check.status === "fail" && check.severity === "blocker").length;
  const warningCount = checks.filter((check) => check.status === "fail" && check.severity === "warning").length;
  const waivedCount = checks.filter((check) => check.status === "waived").length;
  const notEvaluated = checks.some((check) => check.status === "not_evaluated");
  return {
    status: fatalCount > 0 || blockerCount > 0
      ? "blocked"
      : waivedCount > 0
        ? "pass_with_waiver"
        : notEvaluated
          ? "not_evaluated"
          : "pass",
    fatal_count: fatalCount,
    blocker_count: blockerCount,
    warning_count: warningCount,
    waived_count: waivedCount,
  };
}

function check(
  category: ReleaseSafetyCategory,
  severity: ReleaseSafetyCheck["severity"],
  status: ReleaseSafetyCheck["status"],
  checkId: string,
  message: string,
  artifactRefs: ReleaseSafetyArtifactRef[],
): ReleaseSafetyCheck {
  return { check_id: checkId, category, severity, status, message, artifact_refs: artifactRefs };
}

function artifactRef(projectDir: string, relPath: string, required: boolean): ReleaseSafetyArtifactRef {
  const filePath = path.join(projectDir, relPath);
  return {
    path: filePath,
    hash: fs.existsSync(filePath) ? sha256File(filePath) : null,
    required,
  };
}

function sha256File(filePath: string): string {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function inferSourceOfTruth(projectDir: string): "engine_render" | "nle_finishing" {
  const statePath = path.join(projectDir, "project_state.yaml");
  if (!fs.existsSync(statePath)) return "engine_render";
  try {
    const state = parseCanonicalYaml(fs.readFileSync(statePath, "utf-8")) as {
      handoff_resolution?: { source_of_truth_decision?: "engine_render" | "nle_finishing" };
    };
    return state.handoff_resolution?.source_of_truth_decision ?? "engine_render";
  } catch {
    return "engine_render";
  }
}

function rejectYamlAnchorsAndAliases(raw: string): void {
  if (/(^|[\s[{,])&[A-Za-z0-9_-]+/.test(raw) || /(^|[\s[{,])\*[A-Za-z0-9_-]+/.test(raw)) {
    throw new Error("YAML anchors and aliases are not allowed in release_safety_report.yaml");
  }
  if (/![A-Za-z]/.test(raw)) {
    throw new Error("YAML custom tags are not allowed in release_safety_report.yaml");
  }
}
