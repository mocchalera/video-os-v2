import * as fs from "node:fs";
import * as path from "node:path";
import { compile, type CompileResult } from "../../compiler/index.js";
import { loadSourceMap } from "../../media/source-map.js";
import { generateTimelineOverview } from "../../preview/timeline-overview.js";
import { renderPreviewSegment } from "../../preview/segment-renderer.js";
import { validateAgainstSchema } from "../shared.js";
import type {
  ReviewPreflightResult,
  ReviewPreflightStep,
} from "./index.js";

export async function runReviewExistingTimelinePreflight(
  projectDir: string,
  createdAt: string,
  skipPreview: boolean,
): Promise<{
  compileResult: CompileResult;
  timelineJson: unknown;
  timelineVersion: string;
  preflight: ReviewPreflightResult;
}> {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  if (!fs.existsSync(timelinePath)) {
    throw new Error("timeline.json not found");
  }

  const timelineJson = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
  const timelineVersion = (timelineJson as { version?: string }).version ?? "unknown";
  const compileResult = buildCompileResultFromExistingTimeline(projectDir, timelineJson);
  const preflight = await generateReviewPreviewAndQc(
    projectDir,
    createdAt,
    timelineJson,
    timelineVersion,
    skipPreview,
  );

  return {
    compileResult,
    timelineJson,
    timelineVersion,
    preflight,
  };
}

export async function runReviewPreflight(
  projectDir: string,
  createdAt: string,
  skipPreview: boolean,
): Promise<{
  compileResult: CompileResult;
  timelineJson: unknown;
  timelineVersion: string;
  preflight: ReviewPreflightResult;
}> {
  const steps: ReviewPreflightStep[] = [];
  const gapReport: string[] = [];

  const compileResult = compile({
    projectPath: projectDir,
    createdAt,
  });
  steps.push({
    step: "compile",
    status: "completed",
    detail: "Compiled timeline.json deterministically from canonical artifacts.",
    artifactPath: compileResult.outputPath,
  });

  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const timelineJson = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
  const timelineVersion = (timelineJson as { version?: string }).version ?? "unknown";
  const preflight = await generateReviewPreviewAndQc(
    projectDir,
    createdAt,
    timelineJson,
    timelineVersion,
    skipPreview,
  );
  steps.push(...preflight.steps);
  gapReport.push(...preflight.gapReport);

  return {
    compileResult,
    timelineJson,
    timelineVersion,
    preflight: {
      steps,
      gapReport,
      previewPath: preflight.previewPath,
      overviewPath: preflight.overviewPath,
      qcSummaryPath: preflight.qcSummaryPath,
    },
  };
}

export async function generateReviewPreviewAndQc(
  projectDir: string,
  createdAt: string,
  timelineJson: unknown,
  timelineVersion: string,
  skipPreview: boolean,
): Promise<ReviewPreflightResult> {
  const steps: ReviewPreflightStep[] = [];
  const gapReport: string[] = [];
  let previewPath: string | undefined;
  let overviewPath: string | undefined;

  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");

  if (!skipPreview) {
    const sourceMap = loadSourceMap(projectDir);
    const overviewTarget = path.join(projectDir, "05_timeline/timeline-overview.png");
    if (!fs.existsSync(overviewTarget)) {
      try {
        const overview = await generateTimelineOverview({
          projectDir,
          timelinePath,
          sourceMap,
        });
        overviewPath = overview.outputPath;
      } catch (err) {
        gapReport.push(
          `timeline-overview.png generation failed (degraded): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      overviewPath = overviewTarget;
    }

    const previewTarget = path.join(projectDir, "05_timeline/preview-first30s.mp4");
    try {
      const previewResult = await renderPreviewSegment({
        projectDir,
        timelinePath,
        sourceMap,
        firstNSec: 30,
        outputPath: previewTarget,
      });
      previewPath = previewResult.outputPath;
      steps.push({
        step: "preview",
        status: "completed",
        detail: `Rendered preview-first30s.mp4 (${previewResult.clipCount} clips, ${previewResult.durationSec.toFixed(1)}s).`,
        artifactPath: previewResult.outputPath,
      });
    } catch (err) {
      gapReport.push(
        `preview render failed (degraded review): ${err instanceof Error ? err.message : String(err)}`,
      );
      steps.push({
        step: "preview",
        status: "skipped",
        detail: `Preview render failed (degraded): ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    gapReport.push("preview generation skipped via --skip-preview");
    steps.push({
      step: "preview",
      status: "skipped",
      detail: "Preview generation skipped via --skip-preview.",
    });
  }

  const qcValidation = validateAgainstSchema(timelineJson, "timeline-ir.schema.json");
  const qcSummaryPath = path.join(projectDir, "05_timeline/review-qc-summary.json");
  fs.writeFileSync(
    qcSummaryPath,
    JSON.stringify({
      version: "1",
      created_at: createdAt,
      timeline_path: "05_timeline/timeline.json",
      preview_path: previewPath ? path.relative(projectDir, previewPath) : null,
      overview_path: overviewPath ? path.relative(projectDir, overviewPath) : null,
      schema_valid: qcValidation.valid,
      errors: qcValidation.errors,
      gap_report: gapReport,
    }, null, 2),
    "utf-8",
  );
  if (!qcValidation.valid) {
    throw new Error(`QC schema validation failed: ${qcValidation.errors.join("; ")}`);
  }
  steps.push({
    step: "qc",
    status: "completed",
    detail: "QC completed via schema validation and summary emission.",
    artifactPath: qcSummaryPath,
  });

  return {
    steps,
    gapReport,
    previewPath,
    overviewPath,
    qcSummaryPath,
  };
}

export function buildCompileResultFromExistingTimeline(
  projectDir: string,
  timelineJson: unknown,
): CompileResult {
  const timeline = timelineJson as CompileResult["timeline"];
  return {
    timeline,
    outputPath: path.join(projectDir, "05_timeline/timeline.json"),
    otioPath: path.join(projectDir, "05_timeline/timeline.otio"),
    previewManifestPath: path.join(projectDir, "05_timeline/preview-manifest.json"),
    resolution: {
      resolved_overlaps: 0,
      resolved_duplicates: 0,
      resolved_invalid_ranges: 0,
      duration_fit: true,
      total_frames: 0,
      target_frames: 0,
    },
  };
}
