#!/usr/bin/env npx tsx
/**
 * CLI entry point for final packaging.
 *
 * Usage:
 *   npx tsx scripts/package.ts <project-path> [options]
 *   npm run package -- <project-path> [options]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  packageCommand,
  type PackageCommandOptions,
  type PackageCommandResult,
} from "../runtime/commands/package.js";
import {
  readCreativeBriefAutonomyMode,
  type AutonomyMode,
} from "../runtime/autonomy.js";
import {
  checkGate10,
  type SourceOfTruth,
} from "../runtime/packaging/gate10.js";
import {
  assembleTimelineToMp4,
  type AssemblerOptions,
  type AssemblyResult,
} from "../runtime/render/assembler.js";
import {
  resolveProjectRenderRoute,
  type AssemblyEngineRequest,
} from "../runtime/render/route-resolver.js";
import {
  computeFileHash,
  readProjectState,
  type ProjectStateDoc,
} from "../runtime/state/reconcile.js";
import {
  timelineHasVisualClips,
  type ReviewVisualQAGateReport,
} from "../runtime/review/visual-qa.js";
import {
  assessRenderArtifactFreshness,
  createSourceInputAttestation,
  writeRenderFreshnessMetadata,
  type SourceInputAttestationStatus,
} from "../runtime/render/source-input-attestation.js";
import { assessMusicAssetEligibility } from "../runtime/music/asset-eligibility.js";
import {
  verifyExistingPackage,
  type PackageVerificationResult,
} from "../runtime/packaging/package-verification.js";
import { resolveDeliveryArtifactPaths } from "../runtime/packaging/active-delivery.js";
import { inspectFinalRenderApproval } from "../runtime/packaging/final-render-approval.js";
import { assertNoLegacyClipCaptionsForPackage } from "../runtime/render/legacy-caption-guard.js";
import { assertCaptionFontContractReady } from "../runtime/caption/font-contract.js";

const USAGE = [
  "Usage: npx tsx scripts/package.ts <project-path> [options]",
  "       npm run package -- <project-path> [options]",
  "",
  "Options:",
  "  --source-of-truth <engine_render|nle_finishing>  Assert the Gate 10 source-of-truth decision",
  "  --autonomy-mode <full|collaborative>             Assert the creative brief autonomy mode",
  "  --skip-render                                    Skip the final render pipeline",
  "  --no-assembly                                    Do not auto-generate 05_timeline/assembly.mp4",
  "  --assembly-path <path>                           Use a supplied assembly.mp4 path",
  "  --assembly-engine <auto|ffmpeg|remotion>         Select assembly engine (default: auto)",
  "  --supplied-final <path>                          Use a supplied final.mp4 for nle_finishing",
  "  --created-at <iso-date>                          Timestamp override",
  "  --preflight-only                                 Evaluate Gate 10 without writing project artifacts",
  "  --verify-existing                                Verify an existing package without writing project artifacts",
  "  --json                                           Print packageCommand result as JSON",
].join("\n");

export interface PackageCliArgs {
  projectDir: string;
  sourceOfTruth?: SourceOfTruth;
  autonomyMode?: AutonomyMode;
  skipRender: boolean;
  noAssembly: boolean;
  assemblyPath?: string;
  assemblyEngine?: AssemblyEngineRequest;
  suppliedFinalPath?: string;
  createdAt?: string;
  preflightOnly: boolean;
  verifyExisting: boolean;
  json: boolean;
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

export type AssemblyFreshnessStatus =
  | "fresh"
  | "missing"
  | "missing_timeline"
  | "stale";

export interface AssemblyFreshness {
  status: AssemblyFreshnessStatus;
  reason?: string;
  assemblyPath: string;
  timelinePath: string;
  timelineHash?: string;
  timelineVersion?: string;
  assemblyHash?: string;
  metaPath?: string;
  sourceInputsHash?: string;
  sourceInputsStatus?: SourceInputAttestationStatus;
  sourceInputWarnings?: string[];
}

export interface EnsureAssemblyResult {
  action: "reused" | "generated";
  freshness: AssemblyFreshness;
  previousStatus?: AssemblyFreshnessStatus;
  previousReason?: string;
  metaPath?: string;
}

export function parseArgs(argv: string[]): PackageCliArgs {
  const args = argv.slice(2);
  let projectDir = "";
  let sourceOfTruth: SourceOfTruth | undefined;
  let autonomyMode: AutonomyMode | undefined;
  let skipRender = false;
  let noAssembly = false;
  let assemblyPath: string | undefined;
  let assemblyEngine: AssemblyEngineRequest | undefined;
  let suppliedFinalPath: string | undefined;
  let createdAt: string | undefined;
  let preflightOnly = false;
  let verifyExisting = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--project" && i + 1 < args.length) {
      projectDir = args[++i];
    } else if ((arg === "--source-of-truth" || arg === "--source_of_truth") && i + 1 < args.length) {
      sourceOfTruth = parseSourceOfTruth(args[++i]);
    } else if ((arg === "--autonomy-mode" || arg === "--autonomy") && i + 1 < args.length) {
      autonomyMode = parseAutonomyMode(args[++i]);
    } else if (arg === "--skip-render") {
      skipRender = true;
    } else if (arg === "--no-assembly") {
      noAssembly = true;
    } else if ((arg === "--assembly-path" || arg === "--assembly") && i + 1 < args.length) {
      assemblyPath = args[++i];
    } else if (arg === "--assembly-engine" && i + 1 < args.length) {
      assemblyEngine = parseAssemblyEngine(args[++i]);
    } else if ((arg === "--supplied-final" || arg === "--supplied-final-path" || arg === "--final") && i + 1 < args.length) {
      suppliedFinalPath = args[++i];
    } else if (arg === "--created-at" && i + 1 < args.length) {
      createdAt = args[++i];
    } else if (arg === "--preflight-only") {
      preflightOnly = true;
    } else if (arg === "--verify-existing") {
      verifyExisting = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    } else if (!projectDir) {
      projectDir = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!projectDir) {
    throw new Error("<project-path> is required");
  }
  if (assemblyPath && assemblyEngine) {
    throw new Error("--assembly-path and --assembly-engine cannot be used together");
  }
  if (noAssembly && assemblyEngine) {
    throw new Error("--no-assembly and --assembly-engine cannot be used together");
  }
  if (preflightOnly && verifyExisting) {
    throw new Error("--preflight-only and --verify-existing cannot be used together");
  }

  return {
    projectDir,
    sourceOfTruth,
    autonomyMode,
    skipRender,
    noAssembly,
    assemblyPath,
    assemblyEngine,
    suppliedFinalPath,
    createdAt,
    preflightOnly,
    verifyExisting,
    json,
  };
}

export function buildPackagePreflight(
  projectDir: string,
  args: Pick<PackageCliArgs, "sourceOfTruth" | "autonomyMode"> = {},
  artifactPaths?: PackagePreflightArtifactPaths,
): PackagePreflight {
  const absDir = path.resolve(projectDir);
  const resolvedDelivery = resolveDeliveryArtifactPaths(absDir, { verifyHashes: true });
  const deliveryPaths = artifactPaths ?? {
    captionApprovalPath: resolvedDelivery.captionApprovalPath,
    qaReportPath: resolvedDelivery.qaReportPath,
    packageManifestPath: resolvedDelivery.packageManifestPath,
  };
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
    import("../runtime/compiler/types.js").TimelineIR
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
  const projectIdentity = resolvePackagePreflightProjectIdentity(absDir, {
    timeline,
    state: doc,
  }, deliveryPaths);
  issues.push(...identityIssues(projectIdentity));
  const finalRenderApproval = inspectFinalRenderApproval(absDir, {
    ...(deliveryPaths.finalRenderApprovalPath
      ? { approvalPath: deliveryPaths.finalRenderApprovalPath }
      : {}),
    captionApprovalPath: deliveryPaths.captionApprovalPath,
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

export function formatPreflightReport(preflight: PackagePreflight): string {
  const lines = [
    "[package] Gate 10 preflight",
    `Project: ${preflight.projectDir}`,
    `Project identity: ${preflight.project_identity.status}`
      + (preflight.project_identity.project_id ? ` (${preflight.project_identity.project_id})` : ""),
    `Autonomy mode: ${preflight.autonomyMode ?? "unresolved"}`,
    `Source of truth: ${preflight.sourceOfTruth ?? "unresolved"}`,
    `Visual QA: ${preflight.visualQaSummary}`,
    `Status: ${preflight.ok ? "OK" : "BLOCKED"}`,
  ];

  if (!preflight.ok) {
    lines.push("", "Missing or stale prerequisites:");
    for (const issue of preflight.issues) {
      lines.push(`- ${issue}`);
    }
    lines.push("", "Next steps:");
    for (const step of preflight.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

export function defaultAssemblyPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), "05_timeline", "assembly.mp4");
}

export function assessAssemblyFreshness(
  projectDir: string,
  assemblyPath = defaultAssemblyPath(projectDir),
): AssemblyFreshness {
  const assessed = assessRenderArtifactFreshness(projectDir, assemblyPath);
  return {
    status: assessed.status,
    ...(assessed.reason
      ? { reason: assessed.reason === "render_missing" ? "assembly_missing" : assessed.reason }
      : {}),
    assemblyPath: assessed.artifactPath,
    timelinePath: assessed.timelinePath,
    ...(assessed.timelineHash ? { timelineHash: assessed.timelineHash } : {}),
    ...(assessed.timelineVersion ? { timelineVersion: assessed.timelineVersion } : {}),
    ...(assessed.artifactHash ? { assemblyHash: assessed.artifactHash } : {}),
    ...(assessed.metaPath ? { metaPath: assessed.metaPath } : {}),
    ...(assessed.sourceInputsHash ? { sourceInputsHash: assessed.sourceInputsHash } : {}),
    ...(assessed.sourceInputsStatus ? { sourceInputsStatus: assessed.sourceInputsStatus } : {}),
    ...(assessed.sourceInputWarnings ? { sourceInputWarnings: assessed.sourceInputWarnings } : {}),
  };
}

export async function ensureFreshAssembly(
  projectDir: string,
  options: {
    assemblyPath?: string;
    createdAt?: string;
    assembleTimelineToMp4Impl?: (options: AssemblerOptions) => Promise<AssemblyResult>;
  } = {},
): Promise<EnsureAssemblyResult> {
  const absDir = path.resolve(projectDir);
  const assemblyPath = options.assemblyPath ?? defaultAssemblyPath(absDir);
  const before = assessAssemblyFreshness(absDir, assemblyPath);

  if (before.status === "fresh") {
    return {
      action: "reused",
      freshness: before,
      metaPath: before.metaPath,
    };
  }

  if (before.status === "missing_timeline") {
    throw new Error("Cannot assemble 05_timeline/assembly.mp4 because 05_timeline/timeline.json is missing.");
  }

  const assemble = options.assembleTimelineToMp4Impl ?? assembleTimelineToMp4;
  const sourceInputsBefore = createSourceInputAttestation(absDir, {
    timelinePath: before.timelinePath,
  });
  await assemble({
    projectDir: absDir,
    timelinePath: before.timelinePath,
    outputPath: assemblyPath,
    legacyCaptionMode: "reject",
  });
  const metaPath = writeRenderFreshnessMetadata(absDir, assemblyPath, {
    createdAt: options.createdAt,
    sourceInputsBefore,
  });
  const after = assessAssemblyFreshness(absDir, assemblyPath);
  if (after.status !== "fresh") {
    throw new Error(
      `Assembly was generated but is not fresh: ${after.reason ?? after.status}`,
    );
  }

  return {
    action: "generated",
    freshness: after,
    previousStatus: before.status,
    previousReason: before.reason,
    metaPath,
  };
}

export function formatAssemblyResult(result: EnsureAssemblyResult): string {
  if (result.action === "reused") {
    return `[package] Assembly fresh: ${result.freshness.assemblyPath}`;
  }
  return [
    `[package] Assembly generated: ${result.freshness.assemblyPath}`,
    `Reason: ${result.previousReason ?? result.previousStatus ?? "unknown"}`,
    `Metadata: ${result.metaPath ?? "not written"}`,
  ].join("\n");
}

export async function runPackageCli(argv: string[] = process.argv): Promise<number> {
  let args: PackageCliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`[package] ${errorMessage(err)}`);
    console.error(USAGE);
    return 1;
  }

  const absDir = path.resolve(args.projectDir);
  if (args.verifyExisting) {
    const verification = verifyExistingPackage(absDir);
    if (args.json) {
      console.log(JSON.stringify(verification, null, 2));
    } else {
      console.log(formatPackageVerification(verification));
    }
    return verification.ready ? 0 : 1;
  }
  const preflight = buildPackagePreflight(absDir, args);
  if (args.preflightOnly) {
    if (args.json) {
      console.log(JSON.stringify(preflight, null, 2));
    } else {
      console.log(formatPreflightReport(preflight));
    }
    return preflight.decision === "ready_to_run" ? 0 : 1;
  }

  const output = args.json ? console.error : console.log;
  output(formatPreflightReport(preflight));
  if (!preflight.ok) {
    return 1;
  }

  const options: PackageCommandOptions = {
    skipRender: args.skipRender,
    projectId: preflight.projectId,
    ...(args.createdAt ? { createdAt: args.createdAt } : {}),
  };

  if (args.suppliedFinalPath) {
    options.suppliedFinalPath = resolveCliPath(args.suppliedFinalPath, absDir);
  }

  if (preflight.sourceOfTruth === "engine_render") {
    const defaultAssembly = defaultAssemblyPath(absDir);
    if (args.assemblyPath) {
      options.assemblyPath = resolveCliPath(args.assemblyPath, absDir);
    } else if (args.noAssembly) {
      options.assemblyPath = defaultAssembly;
      output(`[package] Assembly auto-generation disabled: ${defaultAssembly}`);
    } else {
      try {
        const route = resolveProjectRenderRoute(absDir, args.assemblyEngine ?? "auto");
        options.renderRouteDecision = route;
        output(
          `[package] Render route: assembly=${route.assembly_engine} ` +
          `hyperframes=${route.hyperframes_overlay ? "on" : "off"} ` +
          `style=${route.style_family}`,
        );
        if (route.assembly_engine === "remotion") {
          options.assemblyEngine = "remotion";
        } else {
          const assembly = await ensureFreshAssembly(absDir, {
            assemblyPath: defaultAssembly,
            createdAt: args.createdAt,
          });
          options.assemblyPath = assembly.freshness.assemblyPath;
          output(formatAssemblyResult(assembly));
        }
      } catch (err) {
        console.error(`[package] Assembly generation failed: ${errorMessage(err)}`);
        console.error("- Run /review --render first if visual QA is stale or missing.");
        console.error("- Remove --no-assembly, or fix timeline/source media and retry packaging.");
        return 1;
      }
    }
  }

  const result = await packageCommand(absDir, options);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.success) {
    console.log(formatSuccess(result));
  } else {
    console.error(formatFailure(result));
  }

  return result.success ? 0 : 1;
}

export function formatPackageVerification(result: PackageVerificationResult): string {
  const lines = [
    `[package] Existing package: ${result.readinessLabel}`,
    `Project: ${result.projectDir}`,
  ];
  for (const check of result.checks) {
    lines.push(`- ${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.details}`);
  }
  return lines.join("\n");
}

function parseSourceOfTruth(value: string): SourceOfTruth {
  if (value === "engine_render" || value === "nle_finishing") {
    return value;
  }
  throw new Error(`--source-of-truth must be engine_render or nle_finishing, got ${value}`);
}

function parseAutonomyMode(value: string): AutonomyMode {
  if (value === "full" || value === "collaborative") {
    return value;
  }
  throw new Error(`--autonomy-mode must be full or collaborative, got ${value}`);
}

function parseAssemblyEngine(value: string): AssemblyEngineRequest {
  if (value === "auto" || value === "ffmpeg" || value === "remotion") {
    return value;
  }
  throw new Error(`--assembly-engine must be auto, ffmpeg, or remotion, got ${value}`);
}

function readStateForPreflight(projectDir: string, issues: string[]): ProjectStateDoc | null {
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

function readAutonomyForPreflight(projectDir: string, issues: string[]): AutonomyMode | undefined {
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
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
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

function readReviewReport(
  projectDir: string,
  issues: string[],
): ReviewVisualQAGateReport | null {
  const reportPath = path.join(projectDir, "06_review", "review_report.yaml");
  if (!fs.existsSync(reportPath)) {
    return null;
  }
  try {
    return parseYaml(fs.readFileSync(reportPath, "utf-8")) as ReviewVisualQAGateReport;
  } catch (err) {
    issues.push(`06_review/review_report.yaml could not be parsed: ${errorMessage(err)}`);
    return null;
  }
}

function readOptionalJson<T = Record<string, unknown>>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function resolvePackagePreflightProjectIdentity(
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

function identitySource(
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

function readIdentityJson(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

function identityIssues(identity: PackagePreflightProjectIdentity): string[] {
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

function issueCode(message: string): string {
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
  if (message.includes("visual_qa")) return "PACKAGE_PREFLIGHT_VISUAL_QA_BLOCKED";
  if (message.includes("caption_approval")) return "PACKAGE_PREFLIGHT_CAPTION_APPROVAL_STALE";
  if (message.includes("music_cues")) return "PACKAGE_PREFLIGHT_MUSIC_CUES_INVALID";
  if (message.includes("source_of_truth") || message.includes("handoff_resolution")) {
    return "PACKAGE_PREFLIGHT_SOURCE_OF_TRUTH_UNRESOLVED";
  }
  return "PACKAGE_PREFLIGHT_GATE10_BLOCKED";
}

function nextActionForPreflight(
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

function inferSourceOfTruth(
  doc: ProjectStateDoc,
  autonomyMode: AutonomyMode,
): SourceOfTruth | undefined {
  const decision = doc.handoff_resolution?.source_of_truth_decision;
  if (decision === "engine_render" || decision === "nle_finishing") {
    return decision;
  }
  return autonomyMode === "full" ? "engine_render" : undefined;
}

function summarizeVisualQA(report: ReviewVisualQAGateReport | null): string {
  if (!report?.visual_qa) {
    return report?.visual_qa_waiver ? "waived" : "missing";
  }
  const visual = report.visual_qa;
  const score = typeof visual.score === "number" ? ` score=${visual.score}/${visual.min_score}` : "";
  const reason = visual.reason ? ` reason=${visual.reason}` : "";
  return `status=${visual.status}${score}${reason}`;
}

function nextStepsForIssues(issues: string[]): string[] {
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

function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function resolveCliPath(inputPath: string, projectDir: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  const cwdPath = path.resolve(inputPath);
  if (fs.existsSync(cwdPath)) return cwdPath;
  return path.resolve(projectDir, inputPath);
}

function formatSuccess(result: PackageCommandResult): string {
  return [
    "[package] Complete",
    `Source of truth: ${result.sourceOfTruth ?? "unknown"}`,
    `Deliverable: ${result.deliverablePath ?? "not published"}`,
    `Manifest: ${result.packageManifest ? "07_package/package_manifest.json" : "not written"}`,
    `QA: ${result.qaReport?.passed ? "passed" : "unknown"}`,
  ].join("\n");
}

function formatFailure(result: PackageCommandResult): string {
  const lines = [
    `[package] Failed: ${result.error?.message ?? "Unknown error"}`,
    "Next steps:",
  ];
  for (const step of nextStepsForFailure(result)) {
    lines.push(`- ${step}`);
  }
  return lines.join("\n");
}

function nextStepsForFailure(result: PackageCommandResult): string[] {
  const message = result.error?.message ?? "";
  const details = JSON.stringify(result.error?.details ?? "");
  const combined = `${message}\n${details}`;

  if (combined.includes("visual_qa")) {
    return ["Run /review with --render, then rerun package."];
  }
  if (combined.includes("Assembly file not found") || combined.includes("assembly.mp4")) {
    return ["Rerun without --no-assembly, or create a fresh 05_timeline/assembly.mp4 first."];
  }
  if (combined.includes("Render pipeline failed")) {
    return ["Check the assembly/source media render error, then rerun package."];
  }
  if (combined.includes("QA checks failed")) {
    return ["Open 07_package/qa-report.md, fix failed checks, then rerun package."];
  }
  if (combined.includes("current_state") || combined.includes("approval_record")) {
    return ["Run /review and approve the rough cut before packaging."];
  }
  return ["Fix the reported packaging error, then rerun package."];
}

function toProjectRelative(filePath: string): string {
  const parts = filePath.split(path.sep);
  const marker = parts.findIndex((part) => /^\d{2}_/.test(part));
  return marker >= 0 ? parts.slice(marker).join("/") : filePath;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runPackageCli().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(`[package] ${errorMessage(err)}`);
    process.exitCode = 1;
  });
}
