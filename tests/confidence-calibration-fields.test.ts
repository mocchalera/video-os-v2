import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateProject } from "../scripts/validate-schemas.js";

let suiteWorkspace: string | undefined;

function makeProject(prefix: string, files: Record<string, unknown>): string {
  if (!suiteWorkspace) throw new Error("P4c confidence test workspace is not initialized");
  const dir = fs.mkdtempSync(path.join(suiteWorkspace, `${prefix}-`));
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
  }
  return dir;
}

function minimalAssets(confidence: Record<string, unknown>): Record<string, unknown> {
  return {
    project_id: "p4c-confidence",
    artifact_version: "assets-v1",
    items: [{
      asset_id: "AST_confidence_001",
      filename: "clip.mp4",
      duration_us: 1000000,
      has_transcript: false,
      transcript_ref: null,
      segments: 0,
      segment_ids: [],
      quality_flags: [],
      tags: [],
      confidence,
    }],
  };
}

describe("P4c confidence-record optional calibration fields", () => {
  beforeAll(() => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "p4c-confidence-tests-"));
    try {
      fs.cpSync(path.resolve("schemas"), path.join(workspace, "schemas"), { recursive: true });
      suiteWorkspace = workspace;
    } catch (error) {
      fs.rmSync(workspace, { recursive: true, force: true });
      throw error;
    }
  });

  afterAll(() => {
    if (suiteWorkspace) fs.rmSync(suiteWorkspace, { recursive: true, force: true });
  });

  it("keeps existing confidence-record fixtures valid when calibration fields are absent", () => {
    const projectDir = makeProject("legacy", {
      "03_analysis/assets.json": minimalAssets({
        score: 0.85,
        source: "ffprobe",
        status: "confirmed",
        label: "legacy confidence",
      }),
    });

    const result = validateProject(projectDir);
    expect(result.violations.filter((violation) => violation.artifact === "03_analysis/assets.json")).toHaveLength(0);
  });

  it("accepts confidence-record with additive calibration fields", () => {
    const projectDir = makeProject("calibrated", {
      "03_analysis/assets.json": minimalAssets({
        score: 0.85,
        source: "ffprobe",
        status: "calibrated",
        label: "calibrated confidence",
        calibration_model_id: "CALMOD_baseline_v1",
        calibrated_score: 0.82,
        confidence_bucket: "high",
        expected_error_rate: 0.18,
        eval_set_id: "EVALSET_smoke",
      }),
    });

    const result = validateProject(projectDir);
    expect(result.violations.filter((violation) => violation.artifact === "03_analysis/assets.json")).toHaveLength(0);
  });

  it("does not require new calibration fields", () => {
    const projectDir = makeProject("missing-fields", {
      "03_analysis/assets.json": minimalAssets({
        score: 0.5,
        source: "manual",
        status: "raw",
      }),
    });

    const result = validateProject(projectDir);
    expect(result.violations.filter((violation) => violation.artifact === "03_analysis/assets.json")).toHaveLength(0);
  });
});
