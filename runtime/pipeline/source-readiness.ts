import type { AssetItem } from "../connectors/ffprobe.js";
import {
  buildAnalysisCoverageReport,
  writeAnalysisCoverageReport,
  writeSourceMediaManifest,
  type AnalysisCoverageReport,
  type SourceMediaManifest,
} from "../artifacts/p1-manifest-coverage.js";
import { writeSourceLedger, type SourceLedger } from "../artifacts/source-ledger.js";
import type { AssetsJson, SegmentsJson } from "./pipeline-types.js";
import { buildGapReport } from "./stages/gap-report.js";
import { atomicWriteJson, atomicWriteYaml } from "./stages/_util.js";

export class SourceReadinessError extends Error {
  readonly code = "SOURCE_READINESS_FAILED";

  constructor(
    message: string,
    readonly sourceLedger: SourceLedger,
  ) {
    super(message);
    this.name = "SourceReadinessError";
  }
}

export interface PersistSourceReadinessArtifactsOptions {
  projectDir: string;
  projectId: string;
  ledger: SourceLedger;
  assets: AssetItem[];
  assetsPath: string;
  segmentsPath: string;
  gapReportPath: string;
  writeEmptyAnalysis?: boolean;
}

export interface SourceReadinessArtifacts {
  manifest: SourceMediaManifest;
  coverage: AnalysisCoverageReport;
}

/**
 * Publishes the canonical source-readiness artifact set in dependency order.
 * Empty analysis artifacts are written only for hard-gated runs so successful
 * ingest can continue building the current analysis result.
 */
export function persistSourceReadinessArtifacts(
  options: PersistSourceReadinessArtifactsOptions,
): SourceReadinessArtifacts {
  writeSourceLedger(options.projectDir, options.ledger);
  const manifest = writeSourceMediaManifest({
    projectDir: options.projectDir,
    projectId: options.projectId,
    ledger: options.ledger,
    assets: options.assets,
    producer: "analysis-ingest",
  });
  const coverage = buildAnalysisCoverageReport({
    projectId: options.projectId,
    manifest,
    ledger: options.ledger,
  });
  writeAnalysisCoverageReport(options.projectDir, coverage);

  if (options.writeEmptyAnalysis ?? true) {
    atomicWriteJson(options.assetsPath, {
      project_id: options.projectId,
      artifact_version: "2.0.0",
      items: [],
    } satisfies AssetsJson);
    atomicWriteJson(options.segmentsPath, {
      project_id: options.projectId,
      artifact_version: "2.0.0",
      items: [],
    } satisfies SegmentsJson);
    atomicWriteYaml(
      options.gapReportPath,
      buildGapReport([], new Map(), new Map(), new Map(), undefined, undefined, undefined, options.ledger),
    );
  }

  return { manifest, coverage };
}
