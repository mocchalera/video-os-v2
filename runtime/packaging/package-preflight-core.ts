/**
 * Package preflight core (runtime). One implementation shared by the public
 * strict preflight route (scripts/package.ts buildPackagePreflight) and the
 * finalize composite's internal fresh-generation packaging. No path-override
 * bypasses exist.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { validateArtifact } from "../artifacts/loaders.js";
import { readProjectState, type ProjectStateDoc } from "../state/reconcile.js";
import { parse as parseYaml } from "yaml";
import { assertNoLegacyClipCaptionsForPackage } from "../render/legacy-caption-guard.js";
import { assertCaptionFontContractReady } from "../caption/font-contract.js";
import { assessMusicAssetEligibility } from "../music/asset-eligibility.js";
import { inspectFinalRenderApproval } from "./final-render-approval.js";
import { checkGate10, type SourceOfTruth } from "./gate10.js";
import type { AutonomyMode } from "../autonomy.js";
import type { AssemblyEngineRequest } from "../render/route-resolver.js";
import type { ReviewVisualQAGateReport } from "../review/visual-qa.js";
import { readCreativeBriefAutonomyMode } from "../autonomy.js";
import { resolveDeliveryArtifactPathsStrict } from "./active-delivery.js";
import { timelineHasVisualClips } from "../review/visual-qa.js";
import {
  loadProjectOptionalVlmCapability,
  readCurrentOptionalVlmGateContext,
  readOptionalVlmPolicy,
  type OptionalVlmPolicyArtifact,
  type OptionalVlmGateContext,
} from "../review/optional-vlm-policy.js";
import { parseJsonRejectDuplicateKeys } from "../commands/shared.js";

export function toProjectRelative(filePath: string): string {
  const parts = filePath.split(path.sep);
  const marker = parts.findIndex((part) => /^\d{2}_/.test(part));
  return marker >= 0 ? parts.slice(marker).join("/") : filePath;
}
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export interface PackagePreflight {
  version: "package-preflight/v2";
  decision: PackagePreflightDecision;
  project_identity: PackagePreflightProjectIdentity;
  structured_issues: PackagePreflightIssue[];
  next_action: PackagePreflightNextAction;
  /** @deprecated Kept for package-preflight/v1 consumers. Use decision instead. */
  ok: boolean;
  projectDir: string;
  /** @deprecated Kept for package-preflight/v1 consumers. Use structured_issues instead. */
  issues: string[];
  /** @deprecated Kept for package-preflight/v1 consumers. Use next_action instead. */
  nextSteps: string[];
  sourceOfTruth?: SourceOfTruth;
  autonomyMode?: AutonomyMode;
  projectId?: string;
  currentState?: string;
  visualQaSummary: string;
}

export interface PackagePreflightArtifactPaths {
  captionApprovalPath: string;
  qaReportPath: string;
  packageManifestPath: string;
  finalRenderApprovalPath?: string;
  /** Canonical approval used to validate the final-render approval binding. */
  finalRenderCaptionApprovalPath?: string;
}

export type PackagePreflightDecision = "ready_to_run" | "blocked";

export type PackagePreflightIdentityStatus =
  | "confirmed"
  | "inferred"
  | "unresolved"
  | "conflict";

export interface PackagePreflightIdentitySource {
  artifact: "timeline" | "state" | "qa" | "manifest";
  path: string;
  status: "present" | "missing" | "empty" | "malformed";
  project_id?: string;
}

export interface PackagePreflightIdentitySource {
  artifact: "timeline" | "state" | "qa" | "manifest";
  path: string;
  status: "present" | "missing" | "empty" | "malformed";
  project_id?: string;
}

export interface PackagePreflightIdentitySource {
  artifact: "timeline" | "state" | "qa" | "manifest";
  path: string;
  status: "present" | "missing" | "empty" | "malformed";
  project_id?: string;
}

export interface PackagePreflightProjectIdentity {
  status: PackagePreflightIdentityStatus;
  project_id?: string;
  evidence_count: number;
  sources: PackagePreflightIdentitySource[];
}

export interface PackagePreflightIssue {
  code: string;
  message: string;
}

export interface PackagePreflightNextAction {
  code: "run_package" | "resolve_project_identity" | "resolve_preflight_issues";
  message: string;
}


function buildPackagePreflightCore(
  projectDir: string,
  args: { sourceOfTruth?: SourceOfTruth; autonomyMode?: AutonomyMode },
  deliveryPaths: PackagePreflightArtifactPaths,
): PackagePreflight {
  const absDir = path.resolve(projectDir);
  // This public gate always uses the shared strict current authority for any
  // pointer consumption. The finalize transaction supplies its fresh
  // generation's artifact paths explicitly (bound by the finalize
  // capability), so it never consumes the pointer at all.
  const issues: string[] = [];
  const timelinePath = path.join(absDir, "05_timeline", "timeline.json");
  const blueprintPath = path.join(absDir, "04_plan", "edit_blueprint.yaml");

  const doc = readStateForPreflight(absDir, issues);
  if (
    doc &&
    doc.current_state !== "approved" &&
    doc.current_state !== "packaged"
  ) {
    issues.push(
      `current_state must be "approved" or "packaged", got "${doc.current_state}"`,
    );
  }
  const autonomyMode = readAutonomyForPreflight(absDir, issues);
  if (args.autonomyMode && autonomyMode && args.autonomyMode !== autonomyMode) {
    issues.push(
      `creative_brief autonomy.mode is "${autonomyMode}", not requested "${args.autonomyMode}"`,
    );
  }

  const timeline = readJsonForPreflight<
    import("../../runtime/compiler/types.js").TimelineIR
  >(timelinePath, issues);
  const currentTimelineVersion =
    typeof timeline?.version === "string" ? timeline.version : timeline ? "1" : undefined;
  const blueprint = readYamlForPreflight<{
    caption_policy?: { source?: string; styling_class?: string };
  }>(blueprintPath, issues);
  if (timeline) {
    try {
      assertNoLegacyClipCaptionsForPackage(timeline);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  const captionApproval = readOptionalJson(deliveryPaths.captionApprovalPath);
  const approvedCaptionPolicy = (
    captionApproval as { caption_policy?: { source?: string; styling_class?: string } } | null
  )?.caption_policy;
  const effectiveCaptionPolicy = approvedCaptionPolicy ?? blueprint?.caption_policy;
  if (
    effectiveCaptionPolicy?.source
    && effectiveCaptionPolicy.source !== "none"
    && effectiveCaptionPolicy.styling_class
  ) {
    try {
      assertCaptionFontContractReady(effectiveCaptionPolicy.styling_class);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  const musicCues = readOptionalJson(path.join(absDir, "07_package", "music_cues.json"));
  const musicEligibility = assessMusicAssetEligibility(absDir, musicCues);
  if (!musicEligibility.eligible && musicEligibility.message) {
    issues.push(`music_cues BGM asset is not eligible: ${musicEligibility.message}`);
  }
  const reviewReport = readReviewReport(absDir, issues);
  const visualQaSummary = summarizeVisualQA(reviewReport);
  let optionalVlmPolicy: OptionalVlmPolicyArtifact | null = null;
  if (fs.existsSync(path.join(absDir, "06_review", "optional-vlm-policy.json"))) {
    try {
      optionalVlmPolicy = readOptionalVlmPolicy(absDir);
    } catch {
      issues.push("optional_vlm_policy artifact is malformed");
    }
  }
  let optionalVlmContext: OptionalVlmGateContext | undefined;
  if (optionalVlmPolicy) {
    try {
      optionalVlmContext = readCurrentOptionalVlmGateContext(absDir);
    } catch {
      issues.push("optional_vlm_policy current review-ready identity is unavailable");
    }
  }
  const projectIdentity = resolvePackagePreflightProjectIdentity(absDir, {
    timeline,
    state: doc,
  }, deliveryPaths);
  issues.push(...identityIssues(projectIdentity));
  const finalRenderApproval = inspectFinalRenderApproval(absDir, {
    ...(deliveryPaths.finalRenderApprovalPath
      ? { approvalPath: deliveryPaths.finalRenderApprovalPath }
      : {}),
    captionApprovalPath: deliveryPaths.finalRenderCaptionApprovalPath
      ?? deliveryPaths.captionApprovalPath,
  });
  if (!finalRenderApproval.ready) {
    issues.push(
      `final_render_approval ${finalRenderApproval.status}: ${finalRenderApproval.issues.join("; ")}`,
    );
  }

  let sourceOfTruth: SourceOfTruth | undefined;
  if (doc && autonomyMode && timeline && blueprint) {
    const gate = checkGate10(doc, {
      autonomyMode,
      currentTimelineVersion,
      blueprint,
      captionApproval,
      musicCues,
      reviewReport,
      visualQaApplicable: timelineHasVisualClips(timelinePath),
      optionalVlmCapability: loadProjectOptionalVlmCapability(absDir).capability,
      optionalVlmPolicy,
      optionalVlmContext,
    });
    issues.push(...gate.errors);
    sourceOfTruth = gate.source_of_truth ?? inferSourceOfTruth(doc, autonomyMode);
  } else if (doc && autonomyMode) {
    sourceOfTruth = inferSourceOfTruth(doc, autonomyMode);
  }

  if (args.sourceOfTruth && sourceOfTruth && args.sourceOfTruth !== sourceOfTruth) {
    issues.push(
      `handoff_resolution.source_of_truth_decision is "${sourceOfTruth}", not requested "${args.sourceOfTruth}"`,
    );
  }

  const uniqueIssues = unique(issues);
  const decision: PackagePreflightDecision = uniqueIssues.length === 0
    ? "ready_to_run"
    : "blocked";
  const structuredIssues = uniqueIssues.map((message) => ({
    code: issueCode(message),
    message,
  }));
  const nextSteps = nextStepsForIssues(uniqueIssues);
  return {
    version: "package-preflight/v2",
    decision,
    project_identity: projectIdentity,
    structured_issues: structuredIssues,
    next_action: nextActionForPreflight(decision, projectIdentity, nextSteps),
    ok: decision === "ready_to_run",
    projectDir: absDir,
    issues: uniqueIssues,
    nextSteps,
    sourceOfTruth,
    autonomyMode,
    ...(projectIdentity.project_id ? { projectId: projectIdentity.project_id } : {}),
    ...(doc?.current_state ? { currentState: doc.current_state } : {}),
    visualQaSummary,
  };
}
export function parseSourceOfTruth(value: string): SourceOfTruth {
  if (value === "engine_render" || value === "nle_finishing") {
    return value;
  }
  throw new Error(`--source-of-truth must be engine_render or nle_finishing, got ${value}`);
}

export function parseAutonomyMode(value: string): AutonomyMode {
  if (value === "full" || value === "collaborative") {
    return value;
  }
  throw new Error(`--autonomy-mode must be full or collaborative, got ${value}`);
}

export function parseAssemblyEngine(value: string): AssemblyEngineRequest {
  if (value === "auto" || value === "ffmpeg" || value === "remotion") {
    return value;
  }
  throw new Error(`--assembly-engine must be auto, ffmpeg, or remotion, got ${value}`);
}

export function readStateForPreflight(projectDir: string, issues: string[]): ProjectStateDoc | null {
  try {
    const doc = readProjectState(projectDir);
    if (!doc) {
      issues.push("project_state.yaml is missing");
      return null;
    }
    return doc;
  } catch (err) {
    issues.push(`project_state.yaml could not be read: ${errorMessage(err)}`);
    return null;
  }
}

export function readAutonomyForPreflight(projectDir: string, issues: string[]): AutonomyMode | undefined {
  const briefPath = path.join(projectDir, "01_intent", "creative_brief.yaml");
  if (!fs.existsSync(briefPath)) {
    issues.push("creative_brief.yaml is missing");
    return undefined;
  }

  try {
    return readCreativeBriefAutonomyMode(projectDir) ?? undefined;
  } catch (err) {
    issues.push(`creative_brief.yaml could not be read: ${errorMessage(err)}`);
    return undefined;
  }
}

function readJsonForPreflight<T>(filePath: string, issues: string[]): T | null {
  if (!fs.existsSync(filePath)) {
    issues.push(`${toProjectRelative(filePath)} is missing`);
    return null;
  }
  try {
    return parseJsonRejectDuplicateKeys<T>(fs.readFileSync(filePath, "utf-8"), filePath);
  } catch (err) {
    issues.push(`${toProjectRelative(filePath)} could not be parsed: ${errorMessage(err)}`);
    return null;
  }
}

function readYamlForPreflight<T>(filePath: string, issues: string[]): T | null {
  if (!fs.existsSync(filePath)) {
    issues.push(`${toProjectRelative(filePath)} is missing`);
    return null;
  }
  try {
    return parseYaml(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    issues.push(`${toProjectRelative(filePath)} could not be parsed: ${errorMessage(err)}`);
    return null;
  }
}

export function readReviewReport(
  projectDir: string,
  issues: string[],
): ReviewVisualQAGateReport | null {
  const reportPath = path.join(projectDir, "06_review", "review_report.yaml");
  if (!fs.existsSync(reportPath)) {
    return null;
  }
  try {
    const report = parseYaml(fs.readFileSync(reportPath, "utf-8")) as ReviewVisualQAGateReport;
    if (report.visual_qa?.optional_vlm_classification !== undefined
      || report.visual_qa?.optional_vlm_error_code !== undefined) {
      try {
        validateArtifact(report, "review-report.schema.json");
      } catch {
        throw new Error("review_report optional VLM classification/error code is invalid");
      }
    }
    return report;
  } catch (err) {
    issues.push(`06_review/review_report.yaml could not be parsed: ${errorMessage(err)}`);
    return null;
  }
}

function readOptionalJson<T = Record<string, unknown>>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseJsonRejectDuplicateKeys<T>(fs.readFileSync(filePath, "utf-8"), filePath);
  } catch {
    return null;
  }
}

export function resolvePackagePreflightProjectIdentity(
  projectDir: string,
  parsed: {
    timeline: { project_id?: unknown } | null;
    state: ProjectStateDoc | null;
  },
  artifactPaths: Pick<PackagePreflightArtifactPaths, "qaReportPath" | "packageManifestPath">,
): PackagePreflightProjectIdentity {
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const statePath = path.join(projectDir, "project_state.yaml");
  const qaPath = path.resolve(artifactPaths.qaReportPath);
  const manifestPath = path.resolve(artifactPaths.packageManifestPath);
  const qaRelativePath = projectRelativePath(projectDir, qaPath);
  const manifestRelativePath = projectRelativePath(projectDir, manifestPath);
  const sources: PackagePreflightIdentitySource[] = [
    identitySource("timeline", "05_timeline/timeline.json", timelinePath, parsed.timeline),
    identitySource("state", "project_state.yaml", statePath, parsed.state),
    identitySource("qa", qaRelativePath, qaPath, readIdentityJson(qaPath)),
    identitySource(
      "manifest",
      manifestRelativePath,
      manifestPath,
      readIdentityJson(manifestPath),
    ),
  ];
  const evidence = sources.filter((source) => source.status === "present");
  const projectIDs = unique(evidence.flatMap((source) => (
    source.project_id ? [source.project_id] : []
  )));

  if (projectIDs.length > 1) {
    return {
      status: "conflict",
      evidence_count: evidence.length,
      sources,
    };
  }
  if (projectIDs.length === 0) {
    return {
      status: "unresolved",
      evidence_count: 0,
      sources,
    };
  }
  return {
    status: evidence.length === 1 ? "inferred" : "confirmed",
    project_id: projectIDs[0],
    evidence_count: evidence.length,
    sources,
  };
}

function projectRelativePath(projectDir: string, filePath: string): string {
  return path.relative(path.resolve(projectDir), path.resolve(filePath)).split(path.sep).join("/");
}

export function identitySource(
  artifact: PackagePreflightIdentitySource["artifact"],
  relativePath: string,
  absolutePath: string,
  value: unknown,
): PackagePreflightIdentitySource {
  if (!fs.existsSync(absolutePath)) {
    return { artifact, path: relativePath, status: "missing" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { artifact, path: relativePath, status: "malformed" };
  }
  const projectID = (value as Record<string, unknown>).project_id;
  if (typeof projectID !== "string") {
    return { artifact, path: relativePath, status: "malformed" };
  }
  const normalized = projectID.trim();
  if (!normalized) {
    return { artifact, path: relativePath, status: "empty" };
  }
  return { artifact, path: relativePath, status: "present", project_id: normalized };
}

export function readIdentityJson(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseJsonRejectDuplicateKeys<unknown>(fs.readFileSync(filePath, "utf-8"), filePath);
  } catch {
    return undefined;
  }
}

export function identityIssues(identity: PackagePreflightProjectIdentity): string[] {
  const issues = identity.sources
    .filter((source) => source.status === "malformed")
    .map((source) => `project identity artifact ${source.path} is malformed`);
  if (identity.status === "conflict") {
    const evidence = identity.sources
      .filter((source) => source.status === "present")
      .map((source) => `${source.artifact}=${source.project_id}`)
      .join(" ");
    issues.push(`project identity mismatch: ${evidence}`);
  } else if (identity.status === "unresolved") {
    issues.push("project identity could not be resolved from timeline, state, QA, or manifest");
  }
  return issues;
}

export function issueCode(message: string): string {
  if (message.startsWith("legacy_clip_captions_forbidden_in_package:")) {
    return "LEGACY_CLIP_CAPTIONS_FORBIDDEN_IN_PACKAGE";
  }
  if (message.startsWith("caption_font_contract_not_ready:")) {
    return "CAPTION_FONT_CONTRACT_NOT_READY";
  }
  if (message.startsWith("final_render_approval ")) {
    return message.startsWith("final_render_approval missing")
      ? "PACKAGE_PREFLIGHT_FINAL_RENDER_APPROVAL_MISSING"
      : "PACKAGE_PREFLIGHT_FINAL_RENDER_APPROVAL_STALE";
  }
  if (message.startsWith("project identity mismatch:")) {
    return "PACKAGE_PREFLIGHT_PROJECT_ID_MISMATCH";
  }
  if (message.startsWith("project identity could not be resolved")) {
    return "PACKAGE_PREFLIGHT_PROJECT_ID_UNRESOLVED";
  }
  if (message.startsWith("project identity artifact ")) {
    return "PACKAGE_PREFLIGHT_IDENTITY_ARTIFACT_MALFORMED";
  }
  if (message.includes("project_state.yaml is missing")) return "PACKAGE_PREFLIGHT_STATE_MISSING";
  if (message.includes("project_state.yaml could not be read")) return "PACKAGE_PREFLIGHT_STATE_INVALID";
  if (message.includes("creative_brief.yaml is missing")) return "PACKAGE_PREFLIGHT_BRIEF_MISSING";
  if (message.includes("creative_brief.yaml could not be read")) return "PACKAGE_PREFLIGHT_BRIEF_INVALID";
  if (message.includes("05_timeline/timeline.json is missing")) return "PACKAGE_PREFLIGHT_TIMELINE_MISSING";
  if (message.includes("05_timeline/timeline.json could not be parsed")) return "PACKAGE_PREFLIGHT_TIMELINE_INVALID";
  if (message.includes("04_plan/edit_blueprint.yaml is missing")) return "PACKAGE_PREFLIGHT_BLUEPRINT_MISSING";
  if (message.includes("04_plan/edit_blueprint.yaml could not be parsed")) return "PACKAGE_PREFLIGHT_BLUEPRINT_INVALID";
  if (message.includes("current_state")) return "PACKAGE_PREFLIGHT_STATE_NOT_APPROVED";
  if (message.includes("approval_record")) return "PACKAGE_PREFLIGHT_APPROVAL_REQUIRED";
  if (message.includes("optional_vlm_policy")) return "PACKAGE_PREFLIGHT_OPTIONAL_VLM_BLOCKED";
  if (message.includes("visual_qa")) return "PACKAGE_PREFLIGHT_VISUAL_QA_BLOCKED";
  if (message.includes("caption_approval")) return "PACKAGE_PREFLIGHT_CAPTION_APPROVAL_STALE";
  if (message.includes("music_cues")) return "PACKAGE_PREFLIGHT_MUSIC_CUES_INVALID";
  if (message.includes("source_of_truth") || message.includes("handoff_resolution")) {
    return "PACKAGE_PREFLIGHT_SOURCE_OF_TRUTH_UNRESOLVED";
  }
  return "PACKAGE_PREFLIGHT_GATE10_BLOCKED";
}

export function nextActionForPreflight(
  decision: PackagePreflightDecision,
  identity: PackagePreflightProjectIdentity,
  nextSteps: string[],
): PackagePreflightNextAction {
  if (decision === "ready_to_run") {
    return {
      code: "run_package",
      message: "Run package with the same project and options.",
    };
  }
  if (identity.status === "conflict" || identity.status === "unresolved") {
    return {
      code: "resolve_project_identity",
      message: "Make timeline, state, QA, and manifest project_id values agree, then rerun preflight.",
    };
  }
  return {
    code: "resolve_preflight_issues",
    message: nextSteps[0] ?? "Resolve the listed preflight issues, then rerun preflight.",
  };
}

export function inferSourceOfTruth(
  doc: ProjectStateDoc,
  autonomyMode: AutonomyMode,
): SourceOfTruth | undefined {
  const decision = doc.handoff_resolution?.source_of_truth_decision;
  if (decision === "engine_render" || decision === "nle_finishing") {
    return decision;
  }
  return autonomyMode === "full" ? "engine_render" : undefined;
}

export function summarizeVisualQA(report: ReviewVisualQAGateReport | null): string {
  if (!report?.visual_qa) {
    return report?.visual_qa_waiver ? "waived" : "missing";
  }
  const visual = report.visual_qa;
  const score = typeof visual.score === "number" ? ` score=${visual.score}/${visual.min_score}` : "";
  const reason = visual.reason ? ` reason=${visual.reason}` : "";
  return `status=${visual.status}${score}${reason}`;
}

export function nextStepsForIssues(issues: string[]): string[] {
  const steps: string[] = [];
  const joined = issues.join("\n");

  if (joined.includes("creative_brief.yaml")) {
    steps.push("Run /intent first so creative_brief.yaml exists.");
  }
  if (joined.includes("05_timeline/timeline.json")) {
    steps.push("Run /compile before packaging.");
  }
  if (joined.includes("04_plan/edit_blueprint.yaml")) {
    steps.push("Run /blueprint before packaging.");
  }
  if (joined.includes("current_state") || joined.includes("approval_record")) {
    steps.push("Run /review and approve the rough cut before packaging.");
  }
  if (joined.includes("handoff_resolution") || joined.includes("source_of_truth_decision")) {
    steps.push("Record the Gate 10 handoff decision as engine_render or nle_finishing.");
  }
  if (joined.includes("visual_qa")) {
    steps.push("Run /review with --render to create fresh F-0023 visual_qa, or add a documented waiver.");
  }
  if (joined.includes("optional_vlm_policy")) {
    steps.push("Run npm run review-policy -- evaluate --project <dir> with the current VLM result, then resolve deterministic QA or human approval pending status.");
  }
  if (joined.includes("caption_approval")) {
    steps.push("Refresh caption approval before packaging.");
  }
  if (joined.includes("music_cues")) {
    steps.push("Refresh music cues before packaging.");
  }
  if (joined.includes("final_render_approval")) {
    steps.push(
      "Review captions, typography, section titles, audio/BGM, and output spec; then refresh final-render-approval.json before packaging.",
    );
  }
  if (steps.length === 0) {
    steps.push("Fix the listed Gate 10 prerequisites, then rerun package.");
  }

  return unique(steps);
}


/**
 * The ONLY exported preflight: derives every artifact path from the strict
 * current pointer authority (canonical project files). No caller may supply
 * artifact paths, ASS paths, binding options, or internal destinations.
 */
export function buildPackagePreflightFromStrictPointer(
  projectDir: string,
  args: { sourceOfTruth?: SourceOfTruth; autonomyMode?: AutonomyMode } = {},
): PackagePreflight {
  const absDir = path.resolve(projectDir);
  const resolvedDelivery = resolveDeliveryArtifactPathsStrict(absDir);
  return buildPackagePreflightCore(absDir, args, {
    captionApprovalPath: resolvedDelivery.captionApprovalPath,
    qaReportPath: resolvedDelivery.qaReportPath,
    packageManifestPath: resolvedDelivery.packageManifestPath,
  });
}

/**
 * Fresh caption-finalize preflight. The caller supplies only a candidate
 * generation root; every artifact path is derived here and the root must be a
 * key-shaped child of the project's caption-finalize generations directory.
 */
export function buildFreshGenerationPackagePreflight(
  projectDir: string,
  generationDir: string,
): PackagePreflight {
  const absProject = path.resolve(projectDir);
  const absoluteGeneration = path.resolve(generationDir);
  const generationsRoot = path.join(
    absProject,
    "07_package",
    "caption-finalize",
    "generations",
  );
  const relative = path.relative(generationsRoot, absoluteGeneration);
  if (
    relative === ""
    || relative.startsWith("..")
    || path.isAbsolute(relative)
    || !/^[a-f0-9]{24}$/.test(path.basename(absoluteGeneration))
  ) {
    throw new Error(`fresh package preflight generation root is invalid: ${absoluteGeneration}`);
  }
  return buildPackagePreflightCore(absProject, {}, {
    captionApprovalPath: path.join(absoluteGeneration, "caption_approval.json"),
    qaReportPath: path.join(absoluteGeneration, "qa-report.json"),
    packageManifestPath: path.join(absoluteGeneration, "package_manifest.json"),
    finalRenderCaptionApprovalPath: path.join(absProject, "07_package", "caption_approval.json"),
  });
}
