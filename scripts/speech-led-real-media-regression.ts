#!/usr/bin/env npx tsx
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { loadCreativeBrief } from "../runtime/artifacts/loaders.js";
import {
  evaluateSpeechLedArtifactContract,
  evaluateSpeechLedRealMediaRegression,
  formatSpeechLedGateReport,
} from "../runtime/eval/speech-led-product-regression.js";
import { runMarlinQA } from "../runtime/eval/marlin-qa.js";
import { marlinModelFromEnvironment } from "../runtime/pipeline/stages/marlin.js";
import { renderRoughCut } from "./render-rough-cut.js";

const USAGE = [
  "Usage: npx tsx scripts/speech-led-real-media-regression.ts --project <dir> [options]",
  "",
  "Options:",
  "  --output-dir <dir>  Gate and Marlin report directory (default: reports/eval/speech-led-real-media)",
  "  --min-score <0-100> Minimum verified Marlin score (default: 70)",
].join("\n");

interface Args {
  projectDir: string;
  outputDir: string;
  minScore: number;
}

export function parseArgs(argv: string[] = process.argv): Args {
  const args = argv.slice(2);
  let projectDir = "";
  let outputDir = path.resolve("reports/eval/speech-led-real-media");
  let minScore = 70;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    if (arg === "--project" || arg === "-p") {
      projectDir = args[++index] ?? "";
      continue;
    }
    if (arg === "--output-dir") {
      outputDir = path.resolve(args[++index] ?? "");
      continue;
    }
    if (arg === "--min-score") {
      minScore = Number(args[++index]);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }

  if (!projectDir) throw new Error(USAGE);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) {
    throw new Error("--min-score must be between 0 and 100");
  }
  return { projectDir: path.resolve(projectDir), outputDir, minScore };
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let parsed: Args;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }

  fs.mkdirSync(parsed.outputDir, { recursive: true });
  const artifactReport = evaluateSpeechLedArtifactContract(parsed.projectDir);
  writeJson(path.join(parsed.outputDir, "artifact-contract.json"), artifactReport);
  console.log(formatSpeechLedGateReport(artifactReport));
  if (!artifactReport.passed) return 1;

  const repoRoot = process.cwd();
  const model = marlinModelFromEnvironment(parsed.projectDir, repoRoot);
  if (model.inference_mode !== "live") {
    writeFailure(parsed.outputDir, artifactReport.project_id,
      `Marlin must use live inference, got ${model.inference_mode}`);
    console.error("[speech-led-regression] FAIL: live Marlin inference is required");
    return 1;
  }

  try {
    const outputPath = path.join(parsed.outputDir, "rough-cut.mp4");
    const render = await renderRoughCut({
      projectPath: parsed.projectDir,
      outputPath,
      noAudio: false,
    });
    const brief = loadCreativeBrief(
      path.join(parsed.projectDir, "01_intent", "creative_brief.yaml"),
    );
    let marlinReportPath = "";
    const marlin = await runMarlinQA(parsed.projectDir, render.outputPath, brief, {
      repoRoot,
      reportDir: parsed.outputDir,
      onReportPath: (writtenPath) => {
        marlinReportPath = writtenPath;
      },
    });
    const report = evaluateSpeechLedRealMediaRegression(artifactReport, {
      video_exists: fs.existsSync(render.outputPath),
      render_duration_sec: render.durationSec,
      render_parity_pass: render.durationAccounting.parity_pass === true,
      marlin_report: marlin,
      min_score: parsed.minScore,
    });
    writeJson(path.join(parsed.outputDir, "real-media-gate.json"), {
      ...report,
      evidence: {
        video_path: path.relative(parsed.outputDir, render.outputPath),
        marlin_report_path: marlinReportPath
          ? path.relative(parsed.outputDir, marlinReportPath)
          : null,
      },
    });
    console.log(formatSpeechLedGateReport(report));
    return report.passed ? 0 : 1;
  } catch (error) {
    writeFailure(parsed.outputDir, artifactReport.project_id, errorMessage(error));
    console.error(`[speech-led-regression] FAIL: ${errorMessage(error)}`);
    return 1;
  }
}

function writeFailure(outputDir: string, projectId: string, error: string): void {
  writeJson(path.join(outputDir, "real-media-failure.json"), {
    version: "speech-led-product-regression/v1",
    mode: "real_media",
    project_id: projectId,
    passed: false,
    error,
  });
}

function writeJson(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isDirectRun = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
