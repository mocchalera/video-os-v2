#!/usr/bin/env tsx
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  computeConfidenceCalibrationReportHash,
  isP4cConfidenceCalibrationEnabled,
  validateConfidenceCalibrationReportIntegrity,
  type ConfidenceCalibrationReport,
} from "../runtime/artifacts/p4c-confidence-calibration.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

interface Args {
  project?: string;
  evalSet?: string;
  calibrationModel?: string;
  output?: string;
}

const ARTIFACT_PATHS: Record<string, string> = {
  audio_story_graph_version: "03_analysis/audio_story_graph.json",
  continuity_graph_version: "03_analysis/continuity_graph.json",
  assets_version: "03_analysis/assets.json",
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--project") {
      args.project = value;
      i += 1;
    } else if (arg === "--eval-set") {
      args.evalSet = value;
      i += 1;
    } else if (arg === "--calibration-model") {
      args.calibrationModel = value;
      i += 1;
    } else if (arg === "--output") {
      args.output = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function main(): void {
  if (!isP4cConfidenceCalibrationEnabled()) {
    throw new Error("ENABLE_P4C_CONFIDENCE_CALIBRATION must be true to run confidence calibration eval");
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.project || !args.evalSet || !args.calibrationModel || !args.output) usage(1);
  if (!/^EVALSET_[A-Za-z0-9_-]+$/.test(args.evalSet)) throw new Error("--eval-set must start with EVALSET_");
  if (!/^CALMOD_[A-Za-z0-9_-]+$/.test(args.calibrationModel)) throw new Error("--calibration-model must start with CALMOD_");

  const projectDir = path.resolve(args.project);
  const report = buildReport(projectDir, args.evalSet, args.calibrationModel);
  const schema = validateAgainstSchema(report, "confidence-calibration-report.schema.json");
  const integrity = validateConfidenceCalibrationReportIntegrity(report);
  if (!schema.valid || !integrity.valid) {
    throw new Error([...schema.errors, ...integrity.violations].join("; "));
  }

  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  process.stdout.write(JSON.stringify({
    output: outputPath,
    report_id: report.report_id,
    hash: computeConfidenceCalibrationReportHash(report),
  }) + "\n");
}

function buildReport(projectDir: string, evalSetId: string, calibrationModelId: string): ConfidenceCalibrationReport {
  const artifactVersions = Object.fromEntries(
    Object.entries(ARTIFACT_PATHS).map(([key, relPath]) => {
      const filePath = path.join(projectDir, relPath);
      return [key, {
        version: readArtifactVersion(filePath),
        hash: fs.existsSync(filePath) ? sha256File(filePath) : `sha256:${"0".repeat(64)}`,
      }];
    }),
  );
  const sampleCount = Object.values(artifactVersions).filter((ref) => ref.hash !== `sha256:${"0".repeat(64)}`).length;
  const observed = sampleCount > 0 ? 0.8 : 0.5;
  return {
    version: "1.0.0",
    project_id: readProjectId(projectDir),
    artifact_version: "calibration-report-v1",
    created_at: new Date().toISOString(),
    report_id: `CALRPT_${evalSetId.replace(/^EVALSET_/, "")}_${Date.now()}`,
    eval_set_id: evalSetId,
    calibration_model_id: calibrationModelId,
    artifact_versions: artifactVersions,
    metrics: {
      boundary_error_seconds: 0,
      tag_precision: observed,
      tag_recall: observed,
      peak_timestamp_error_seconds: 0,
      speaker_attribution_accuracy: observed,
      continuity_match_precision: observed,
      release_safety_false_negative_rate: 0,
    },
    buckets: [{ bucket: "high", sample_count: sampleCount, observed_accuracy: observed, expected_accuracy: observed }],
    failures: [],
    recommendations: ["Placeholder eval: replace with ground-truth-backed calibration in P5."],
    provenance: {
      producer: "scripts/eval-confidence-calibration.ts",
      inputs: Object.entries(ARTIFACT_PATHS)
        .map(([, relPath]) => path.join(projectDir, relPath))
        .filter((filePath) => fs.existsSync(filePath))
        .map((filePath) => ({ path: path.relative(projectDir, filePath), hash: sha256File(filePath), required: false })),
      hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: ["created_at"] },
    },
  };
}

function readProjectId(projectDir: string): string {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) {
    try {
      const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as { project_id?: unknown };
      if (typeof timeline.project_id === "string") return timeline.project_id;
    } catch {
      return path.basename(projectDir);
    }
  }
  return path.basename(projectDir);
}

function readArtifactVersion(filePath: string): string {
  if (!fs.existsSync(filePath)) return "missing";
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { artifact_version?: unknown; version?: unknown };
    if (typeof data.artifact_version === "string") return data.artifact_version;
    if (typeof data.version === "string") return data.version;
  } catch {
    return "unknown";
  }
  return "unknown";
}

function sha256File(filePath: string): string {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function usage(code: number): never {
  const message = "Usage: tsx scripts/eval-confidence-calibration.ts --project <path> --eval-set <EVALSET_id> --calibration-model <CALMOD_id> --output <path>";
  if (code === 0) {
    process.stdout.write(`${message}\n`);
    process.exit(0);
  }
  throw new Error(message);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
