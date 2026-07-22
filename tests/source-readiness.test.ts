import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { buildSourceLedger } from "../runtime/artifacts/source-ledger.js";
import { discoverRequestedSources } from "../runtime/media/source-discovery.js";
import {
  SourceReadinessError,
  persistSourceReadinessArtifacts,
} from "../runtime/pipeline/source-readiness.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vos-source-readiness-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function artifactPaths(projectDir: string): {
  assetsPath: string;
  segmentsPath: string;
  gapReportPath: string;
} {
  const analysisDir = path.join(projectDir, "03_analysis");
  fs.mkdirSync(analysisDir, { recursive: true });
  return {
    assetsPath: path.join(analysisDir, "assets.json"),
    segmentsPath: path.join(analysisDir, "segments.json"),
    gapReportPath: path.join(analysisDir, "gap_report.yaml"),
  };
}

describe("source readiness artifact persistence", () => {
  it("publishes ledger, manifest, and coverage without replacing active analysis artifacts", () => {
    const projectDir = createProject("continue");
    const paths = artifactPaths(projectDir);
    const sentinels = {
      assetsPath: "active assets\n",
      segmentsPath: "active segments\n",
      gapReportPath: "active gaps\n",
    } as const;
    for (const [key, value] of Object.entries(sentinels)) fs.writeFileSync(paths[key as keyof typeof paths], value);
    const ledger = buildSourceLedger(
      "source-ready-project",
      discoverRequestedSources([]),
      new Map(),
      "2026-07-22T00:00:00.000Z",
      projectDir,
    );

    const result = persistSourceReadinessArtifacts({
      projectDir,
      projectId: "source-ready-project",
      ledger,
      assets: [],
      ...paths,
      writeEmptyAnalysis: false,
    });

    expect(result.manifest.project_id).toBe("source-ready-project");
    expect(result.coverage.summary.source_counts).toEqual(ledger.summary);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/source_ledger.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "02_media/source_media_manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/analysis_coverage_report.json"))).toBe(true);
    for (const [key, value] of Object.entries(sentinels)) {
      expect(fs.readFileSync(paths[key as keyof typeof paths], "utf-8")).toBe(value);
    }
  });

  it("replaces analysis artifacts with the canonical empty gate result by default", () => {
    const projectDir = createProject("blocked");
    const paths = artifactPaths(projectDir);
    const missingSource = path.join(projectDir, "01_source", "missing.mp4");
    const ledger = buildSourceLedger(
      "source-blocked-project",
      discoverRequestedSources([missingSource]),
      new Map(),
      "2026-07-22T00:00:00.000Z",
      projectDir,
    );

    persistSourceReadinessArtifacts({
      projectDir,
      projectId: "source-blocked-project",
      ledger,
      assets: [],
      ...paths,
    });

    expect(JSON.parse(fs.readFileSync(paths.assetsPath, "utf-8"))).toEqual({
      project_id: "source-blocked-project",
      artifact_version: "2.0.0",
      items: [],
    });
    expect(JSON.parse(fs.readFileSync(paths.segmentsPath, "utf-8"))).toEqual({
      project_id: "source-blocked-project",
      artifact_version: "2.0.0",
      items: [],
    });
    const gapReport = parseYaml(fs.readFileSync(paths.gapReportPath, "utf-8")) as {
      entries: Array<{ source_id: string; blocking: boolean }>;
    };
    expect(gapReport.entries).toHaveLength(1);
    expect(gapReport.entries[0]).toMatchObject({
      source_id: ledger.items[0].source_id,
      blocking: true,
    });
  });

  it("retains the public structured readiness error contract", () => {
    const ledger = buildSourceLedger(
      "source-error-project",
      discoverRequestedSources([]),
      new Map(),
      "2026-07-22T00:00:00.000Z",
    );
    const error = new SourceReadinessError("No requested source inputs were provided.", ledger);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SourceReadinessError");
    expect(error.code).toBe("SOURCE_READINESS_FAILED");
    expect(error.sourceLedger).toBe(ledger);
  });
});
