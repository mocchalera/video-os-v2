#!/usr/bin/env tsx
/**
 * CLI entry point for the editorial agreement eval harness.
 *
 * Usage:
 *   npx tsx scripts/eval.ts --list
 *   npx tsx scripts/eval.ts --self projects/fumoto-growth
 *   npx tsx scripts/eval.ts --all [--min-score 80]
 *   npx tsx scripts/eval.ts --candidate <dir> --golden <dir> [--judge]
 *
 * Core logic lives in runtime/eval/. This file is a thin CLI adapter.
 */

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local", quiet: true });
dotenvConfig({ quiet: true });

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  discoverGoldenProjects,
  evaluateCandidateAgainstGolden,
  renderMarkdownReport,
  selfEvaluateGolden,
  type EvalReport,
} from "../runtime/eval/index.js";
import {
  runGoldenEvalSuite,
  type RunEvalSuiteOptions,
} from "../runtime/eval/suite.js";
import {
  canonicalJson,
  evaluateEditorialEye,
  writeEditorialEyeReport,
} from "../runtime/eval/editorial-eye-suite.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

const USAGE = `Usage: npx tsx scripts/eval.ts <mode> [options]

Modes (choose one):
  --list                       List discovered golden projects
  --self <project-dir>         Recompile a golden's inputs and compare to its approved timeline
  --all                        Run --self across every discovered golden
  --candidate <dir> --golden <dir>
                               Compare a candidate run against a golden project
  --suite golden               Run the integrated golden regression suite
  --suite editorial-eye        Run the immutable Editorial Eye v1 benchmark contract

Options:
  --judge                      Also run the Gemini LLM judge (needs GEMINI_API_KEY)
  --marlin                     Run live Marlin visual QA for suite projects with fresh renders
  --projects <a,b,c>           Override suite projects (default: discover approved local projects)
  --divergence-threshold <n>   Suite WARNING threshold for structure/video divergence (default: 30)
  --min-score <n>              Exit non-zero when any overall score falls below n (0-100)
  --out <dir>                  Report output directory (default: reports/eval)
  --manifest <path>            Editorial Eye suite manifest (required)
  --labels <path>              Editorial Eye labels (required)
  --baseline-report <path>     Explicit immutable baseline report (required; never auto-discovered)
  --baseline-report-sha256 <h> Trusted SHA-256 lock for exact baseline report bytes (required)
  --results <path>             Explicit measured case results (required; never inferred from suite)
  --candidate-commit <sha>     Complete candidate commit SHA (required)
  --output-root <dir>          Editorial Eye report root (default: reports/editorial-eye)
  --no-write                   Print to stdout only, write no report files
  --help, -h                   Show this help`;

export interface EvalCliArgs {
  help: boolean;
  list: boolean;
  all: boolean;
  self: string | null;
  candidate: string | null;
  golden: string | null;
  suite: "golden" | "editorial-eye" | null;
  manifest: string | null;
  labels: string | null;
  baselineReport: string | null;
  baselineReportSha256: string | null;
  results: string | null;
  candidateCommit: string | null;
  outputRoot: string;
  projects: string[] | null;
  divergenceThreshold: number;
  judge: boolean;
  marlin: boolean;
  minScore: number | null;
  out: string;
  write: boolean;
}

export function parseArgs(argv: string[]): EvalCliArgs {
  const args: EvalCliArgs = {
    help: false,
    list: false,
    all: false,
    self: null,
    candidate: null,
    golden: null,
    suite: null,
    manifest: null,
    labels: null,
    baselineReport: null,
    baselineReportSha256: null,
    results: null,
    candidateCommit: null,
    outputRoot: "reports/editorial-eye",
    projects: null,
    divergenceThreshold: 30,
    judge: false,
    marlin: false,
    minScore: null,
    out: "reports/eval",
    write: true,
  };

  const takeValue = (flag: string, i: number, list: string[]): string => {
    const next = list[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return next;
  };

  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--all":
        args.all = true;
        break;
      case "--self":
        args.self = takeValue(arg, i, rest);
        i += 1;
        break;
      case "--candidate":
        args.candidate = takeValue(arg, i, rest);
        i += 1;
        break;
      case "--golden":
        args.golden = takeValue(arg, i, rest);
        i += 1;
        break;
      case "--suite": {
        const value = takeValue(arg, i, rest);
        if (value !== "golden" && value !== "editorial-eye") {
          throw new Error(`Invalid --suite: ${value} (expected golden or editorial-eye)`);
        }
        args.suite = value;
        i += 1;
        break;
      }
      case "--projects": {
        const value = takeValue(arg, i, rest);
        args.projects = value.split(",").map((item) => item.trim()).filter(Boolean);
        i += 1;
        break;
      }
      case "--divergence-threshold": {
        const raw = takeValue(arg, i, rest);
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          throw new Error(`Invalid --divergence-threshold: ${raw} (expected 0-100)`);
        }
        args.divergenceThreshold = value;
        i += 1;
        break;
      }
      case "--judge":
        args.judge = true;
        break;
      case "--marlin":
        args.marlin = true;
        break;
      case "--min-score": {
        const raw = takeValue(arg, i, rest);
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          throw new Error(`Invalid --min-score: ${raw} (expected 0-100)`);
        }
        args.minScore = value;
        i += 1;
        break;
      }
      case "--out":
        args.out = takeValue(arg, i, rest);
        i += 1;
        break;
      case "--manifest":
        args.manifest = takeValue(arg, i, rest);
        i += 1;
        break;
      case "--labels":
        args.labels = takeValue(arg, i, rest);
        i += 1;
        break;
      case "--baseline-report":
        args.baselineReport = takeValue(arg, i, rest);
        i += 1;
        break;
      case "--baseline-report-sha256":
        args.baselineReportSha256 = takeValue(arg, i, rest);
        i += 1;
        break;
      case "--results":
        args.results = takeValue(arg, i, rest);
        i += 1;
        break;
      case "--candidate-commit":
        args.candidateCommit = takeValue(arg, i, rest);
        i += 1;
        break;
      case "--output-root":
        args.outputRoot = takeValue(arg, i, rest);
        i += 1;
        break;
      case "--no-write":
        args.write = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return args;
}

export function evalSuiteOptionsFromArgs(
  args: EvalCliArgs,
  root: string = repoRoot,
): RunEvalSuiteOptions {
  return {
    repoRoot: root,
    outRoot: args.out,
    projects: args.projects ?? undefined,
    divergenceThreshold: args.divergenceThreshold,
    briefAlignmentUseLlm: args.judge,
    runMarlinQA: args.marlin,
    write: args.write,
  };
}

function writeReports(report: EvalReport, outDir: string): { jsonPath: string; mdPath: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = report.evaluated_at.replace(/[:.]/g, "-");
  const base = `${report.mode}-${report.candidate_project.replace(/[^\w-]+/g, "_")}-${stamp}`;
  const jsonPath = path.join(outDir, `${base}.json`);
  const mdPath = path.join(outDir, `${base}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, renderMarkdownReport(report));
  return { jsonPath, mdPath };
}

function printSummaryLine(report: EvalReport): void {
  const verdict = report.pass === null ? "" : report.pass ? "  PASS" : "  FAIL";
  const stages = Object.entries(report.stages)
    .map(([name, s]) => `${name}=${(s.score * 100).toFixed(0)}`)
    .join(" ");
  console.log(
    `  ${report.golden_project.padEnd(42)} ${String(report.overall_score).padStart(5)} / 100  (${stages})${verdict}`,
  );
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const outDir = path.resolve(repoRoot, args.out);

  if (args.suite === "editorial-eye") {
    if (args.minScore !== null) {
      throw new Error("--min-score is a legacy artifact-agreement threshold and does not apply to --suite editorial-eye");
    }
    const missing = [
      ["--manifest", args.manifest],
      ["--labels", args.labels],
      ["--baseline-report", args.baselineReport],
      ["--baseline-report-sha256", args.baselineReportSha256],
      ["--results", args.results],
      ["--candidate-commit", args.candidateCommit],
    ].filter(([, value]) => !value).map(([flag]) => flag);
    if (missing.length > 0) throw new Error(`Editorial Eye requires explicit ${missing.join(", ")}`);
    const report = evaluateEditorialEye({
      repoRoot,
      manifestPath: path.resolve(args.manifest!),
      labelsPath: path.resolve(args.labels!),
      baselineReportPath: path.resolve(args.baselineReport!),
      baselineReportSha256: args.baselineReportSha256!,
      candidateCommit: args.candidateCommit!,
      resultsPath: path.resolve(args.results!),
    });
    console.log(canonicalJson(report));
    if (args.write) {
      const reportPath = writeEditorialEyeReport(report, path.resolve(repoRoot, args.outputRoot));
      console.error(`Editorial Eye report: ${path.relative(repoRoot, reportPath)}`);
    }
    return report.verdict.status === "pass" ? 0 : 1;
  }

  if (args.list) {
    const goldens = discoverGoldenProjects(repoRoot);
    if (goldens.length === 0) {
      console.log("No golden projects found (need approval_record in project_state.yaml).");
      return 0;
    }
    console.log("Golden projects:");
    for (const g of goldens) {
      console.log(
        `  ${g.project_id.padEnd(42)} tier=${g.tier.padEnd(6)} approved_by=${g.approved_by}`,
      );
    }
    return 0;
  }

  const reports: EvalReport[] = [];

  if (args.suite === "golden") {
    const result = await runGoldenEvalSuite(evalSuiteOptionsFromArgs(args));
    console.log("\nEval suite results:");
    for (const project of result.summary.projects) {
      const divergence = project.divergence.status === "computed"
        ? `${project.divergence.difference?.toFixed(1)}${project.divergence.warning ? " WARNING" : ""}`
        : `skipped(${project.divergence.reason})`;
      const structure = project.structural_alignment_score === null
        ? "—"
        : project.structural_alignment_score.toFixed(1);
      const marlin = project.marlin_qa.score === null ? "—" : project.marlin_qa.score.toFixed(1);
      console.log(
        `  ${project.project_id.padEnd(24)} structure/alignment=${structure.padStart(5)}  marlin=${marlin.padStart(5)}  divergence=${divergence}`,
      );
    }
    if (result.markdownPath) {
      console.log(`    summary: ${path.relative(repoRoot, result.markdownPath)}`);
    }
    return result.summary.totals.failed_stages > 0 ? 1 : 0;
  } else if (args.candidate || args.golden) {
    if (!args.candidate || !args.golden) {
      throw new Error("--candidate and --golden must be used together");
    }
    const report = await evaluateCandidateAgainstGolden(
      path.resolve(args.candidate),
      path.resolve(args.golden),
      { judge: args.judge, minScore: args.minScore },
    );
    reports.push(report);
  } else if (args.self) {
    const { report } = await selfEvaluateGolden(path.resolve(args.self), {
      judge: args.judge,
      minScore: args.minScore,
    });
    reports.push(report);
  } else if (args.all) {
    const goldens = discoverGoldenProjects(repoRoot);
    if (goldens.length === 0) {
      console.log("No golden projects found — nothing to evaluate.");
      return 0;
    }
    for (const g of goldens) {
      try {
        const { report } = await selfEvaluateGolden(g.project_dir, {
          judge: args.judge,
          minScore: args.minScore,
        });
        reports.push(report);
      } catch (err) {
        console.error(`  ${g.project_id}: eval failed — ${(err as Error).message}`);
      }
    }
  } else {
    console.log(USAGE);
    return 1;
  }

  console.log("\nEditorial agreement results:");
  for (const report of reports) {
    printSummaryLine(report);
    if (args.write) {
      const { mdPath } = writeReports(report, outDir);
      console.log(`    report: ${path.relative(repoRoot, mdPath)}`);
    }
  }

  const failed = reports.filter((r) => r.pass === false);
  if (failed.length > 0) {
    console.error(`\n${failed.length} run(s) below --min-score ${args.minScore}.`);
    return 1;
  }
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`eval failed: ${(err as Error).message}`);
      process.exitCode = 1;
    });
}
