import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateProject } from "../scripts/validate-schemas.js";

const tempDirs: string[] = [];

function makeProject(prefix: string, files: Record<string, unknown>): string {
  const tmpRoot = path.resolve("tmp/p4c-confidence-tests");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
  tempDirs.push(dir);
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
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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
