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
  computeFileHash,
  readProjectState,
  type ProjectStateDoc,
} from "../runtime/state/reconcile.js";
import {
  writeRenderFreshnessMetadata,
  type ReviewVisualQAGateReport,
} from "../runtime/review/visual-qa.js";

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
  "  --supplied-final <path>                          Use a supplied final.mp4 for nle_finishing",
  "  --created-at <iso-date>                          Timestamp override",
  "  --json                                           Print packageCommand result as JSON",
].join("\n");

export interface PackageCliArgs {
  projectDir: string;
  sourceOfTruth?: SourceOfTruth;
  autonomyMode?: AutonomyMode;
  skipRender: boolean;
  noAssembly: boolean;
  assemblyPath?: string;
  suppliedFinalPath?: string;
  createdAt?: string;
  json: boolean;
}

export interface PackagePreflight {
  ok: boolean;
  projectDir: string;
  issues: string[];
  nextSteps: string[];
  sourceOfTruth?: SourceOfTruth;
  autonomyMode?: AutonomyMode;
  visualQaSummary: string;
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
}

export interface EnsureAssemblyResult {
  action: "reused" | "generated";
  freshness: AssemblyFreshness;
  previousStatus?: AssemblyFreshnessStatus;
  previousReason?: string;
  metaPath?: string;
}

interface RenderMeta {
  timeline_hash?: string;
  timeline_version?: string;
  timeline_path?: string;
  video_hash?: string;
  video_path?: string;
}

export function parseArgs(argv: string[]): PackageCliArgs {
  const args = argv.slice(2);
  let projectDir = "";
  let sourceOfTruth: SourceOfTruth | undefined;
  let autonomyMode: AutonomyMode | undefined;
  let skipRender = false;
  let noAssembly = false;
  let assemblyPath: string | undefined;
  let suppliedFinalPath: string | undefined;
  let createdAt: string | undefined;
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
    } else if ((arg === "--supplied-final" || arg === "--supplied-final-path" || arg === "--final") && i + 1 < args.length) {
      suppliedFinalPath = args[++i];
    } else if (arg === "--created-at" && i + 1 < args.length) {
      createdAt = args[++i];
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

  return {
    projectDir,
    sourceOfTruth,
    autonomyMode,
    skipRender,
    noAssembly,
    assemblyPath,
    suppliedFinalPath,
    createdAt,
    json,
  };
}

export function buildPackagePreflight(
  projectDir: string,
  args: Pick<PackageCliArgs, "sourceOfTruth" | "autonomyMode"> = {},
): PackagePreflight {
  const absDir = path.resolve(projectDir);
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

  const timeline = readJsonForPreflight<{ version?: unknown }>(timelinePath, issues);
  const currentTimelineVersion =
    typeof timeline?.version === "string" ? timeline.version : timeline ? "1" : undefined;
  const blueprint = readYamlForPreflight<{
    caption_policy?: { source?: string };
  }>(blueprintPath, issues);
  const captionApproval = readOptionalJson(path.join(absDir, "07_package", "caption_approval.json"));
  const musicCues = readOptionalJson(path.join(absDir, "07_package", "music_cues.json"));
  const reviewReport = readReviewReport(absDir, issues);
  const visualQaSummary = summarizeVisualQA(reviewReport);

  let sourceOfTruth: SourceOfTruth | undefined;
  if (doc && autonomyMode && timeline && blueprint) {
    const gate = checkGate10(doc, {
      autonomyMode,
      currentTimelineVersion,
      blueprint,
      captionApproval,
      musicCues,
      reviewReport,
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
  return {
    ok: uniqueIssues.length === 0,
    projectDir: absDir,
    issues: uniqueIssues,
    nextSteps: nextStepsForIssues(uniqueIssues),
    sourceOfTruth,
    autonomyMode,
    visualQaSummary,
  };
}

export function formatPreflightReport(preflight: PackagePreflight): string {
  const lines = [
    "[package] Gate 10 preflight",
    `Project: ${preflight.projectDir}`,
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
  const absDir = path.resolve(projectDir);
  const absAssembly = path.resolve(assemblyPath);
  const timelinePath = path.join(absDir, "05_timeline", "timeline.json");

  if (!fs.existsSync(timelinePath)) {
    return {
      status: "missing_timeline",
      reason: "timeline_missing",
      assemblyPath: absAssembly,
      timelinePath,
    };
  }

  const timeline = readJsonIfExists<{ version?: unknown }>(timelinePath);
  const timelineVersion = typeof timeline?.version === "string" ? timeline.version : "1";
  const timelineHash = computeFileHash(timelinePath);

  if (!fs.existsSync(absAssembly)) {
    return {
      status: "missing",
      reason: "assembly_missing",
      assemblyPath: absAssembly,
      timelinePath,
      timelineHash,
      timelineVersion,
    };
  }

  const assemblyHash = computeFileHash(absAssembly);
  const renderMeta = readRenderMeta(absAssembly);

  if (renderMeta.meta?.timeline_hash && renderMeta.meta.timeline_hash !== timelineHash) {
    return {
      status: "stale",
      reason: "render_timeline_hash_mismatch",
      assemblyPath: absAssembly,
      timelinePath,
      timelineHash,
      timelineVersion,
      assemblyHash,
      metaPath: renderMeta.path,
    };
  }

  if (renderMeta.meta?.video_hash && renderMeta.meta.video_hash !== assemblyHash) {
    return {
      status: "stale",
      reason: "render_video_hash_mismatch",
      assemblyPath: absAssembly,
      timelinePath,
      timelineHash,
      timelineVersion,
      assemblyHash,
      metaPath: renderMeta.path,
    };
  }

  if (!renderMeta.meta?.timeline_hash) {
    const assemblyStat = fs.statSync(absAssembly);
    const timelineStat = fs.statSync(timelinePath);
    if (assemblyStat.mtimeMs + 1 < timelineStat.mtimeMs) {
      return {
        status: "stale",
        reason: "render_older_than_timeline",
        assemblyPath: absAssembly,
        timelinePath,
        timelineHash,
        timelineVersion,
        assemblyHash,
        metaPath: renderMeta.path,
      };
    }
  }

  return {
    status: "fresh",
    assemblyPath: absAssembly,
    timelinePath,
    timelineHash,
    timelineVersion,
    assemblyHash,
    metaPath: renderMeta.path,
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
  await assemble({
    projectDir: absDir,
    timelinePath: before.timelinePath,
    outputPath: assemblyPath,
  });
  const metaPath = writeRenderFreshnessMetadata(absDir, assemblyPath, {
    createdAt: options.createdAt,
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
  const output = args.json ? console.error : console.log;
  const preflight = buildPackagePreflight(absDir, args);
  output(formatPreflightReport(preflight));
  if (!preflight.ok) {
    return 1;
  }

  const options: PackageCommandOptions = {
    skipRender: args.skipRender,
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
        const assembly = await ensureFreshAssembly(absDir, {
          assemblyPath: defaultAssembly,
          createdAt: args.createdAt,
        });
        options.assemblyPath = assembly.freshness.assemblyPath;
        output(formatAssemblyResult(assembly));
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

function readRenderMeta(videoPath: string): { path?: string; meta?: RenderMeta } {
  for (const candidate of [
    path.join(path.dirname(videoPath), "render-report.json"),
    path.join(path.dirname(videoPath), "render-meta.json"),
  ]) {
    const parsed = readJsonIfExists<RenderMeta>(candidate);
    if (parsed) return { path: candidate, meta: parsed };
  }
  return {};
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
