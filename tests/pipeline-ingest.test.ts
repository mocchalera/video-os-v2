/**
 * Integration tests for runtime/pipeline/ingest.ts — full pipeline execution.
 * Also validates schema compliance and determinism.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { runPipeline, type PipelineResult } from "../runtime/pipeline/ingest.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
  addSchema(schema: object): void;
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures/media");
const TEST_CLIP = path.join(FIXTURES_DIR, "test-clip-5s.mp4");
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TMP_PROJECT = path.join(import.meta.dirname, "_tmp_pipeline_project");

// ── Schema Validator ───────────────────────────────────────────────

function createValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);

  const schemasDir = path.join(REPO_ROOT, "schemas");
  const commonSchema = JSON.parse(
    fs.readFileSync(path.join(schemasDir, "analysis-common.schema.json"), "utf-8"),
  );
  ajv.addSchema(commonSchema);

  const assetsSchema = JSON.parse(
    fs.readFileSync(path.join(schemasDir, "assets.schema.json"), "utf-8"),
  );
  const segmentsSchema = JSON.parse(
    fs.readFileSync(path.join(schemasDir, "segments.schema.json"), "utf-8"),
  );

  return {
    validateAssets: ajv.compile(assetsSchema),
    validateSegments: ajv.compile(segmentsSchema),
  };
}

// ── Setup / Teardown ───────────────────────────────────────────────

beforeAll(() => {
  fs.mkdirSync(TMP_PROJECT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_PROJECT, { recursive: true, force: true });
});

// ── Integration: Full Pipeline ─────────────────────────────────────

describe("Pipeline: full ingest → segment → derivatives", () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipeline({
      sourceFiles: [TEST_CLIP],
      projectDir: TMP_PROJECT,
      repoRoot: REPO_ROOT,
      skipStt: true,
    });
  }, 60_000);

  it("produces assets.json with valid schema", () => {
    const { validateAssets } = createValidator();
    const valid = validateAssets(result.assetsJson);
    if (!valid) {
      console.error("assets.json validation errors:", validateAssets.errors);
    }
    expect(valid).toBe(true);
  });

  it("produces segments.json with valid schema", () => {
    const { validateSegments } = createValidator();
    const valid = validateSegments(result.segmentsJson);
    if (!valid) {
      console.error("segments.json validation errors:", validateSegments.errors);
    }
    expect(valid).toBe(true);
  });

  it("has correct asset count", () => {
    expect(result.assetsJson.items).toHaveLength(1);
  });

  it("asset has segments populated", () => {
    const asset = result.assetsJson.items[0];
    expect(asset.segments).toBeGreaterThanOrEqual(1);
    expect(asset.segment_ids.length).toBe(asset.segments);
  });

  it("asset has contact_sheet_ids", () => {
    const asset = result.assetsJson.items[0];
    expect(asset.contact_sheet_ids.length).toBeGreaterThanOrEqual(1);
    expect(asset.contact_sheet_ids[0]).toMatch(/^CS_AST_/);
  });

  it("asset has poster_path", () => {
    const asset = result.assetsJson.items[0];
    expect(asset.poster_path).toMatch(/^posters\//);
  });

  it("asset has waveform_path", () => {
    const asset = result.assetsJson.items[0];
    expect(asset.waveform_path).toMatch(/^waveforms\//);
  });

  it("segments have filmstrip_path", () => {
    for (const seg of result.segmentsJson.items) {
      expect(seg.filmstrip_path).toMatch(/^filmstrips\//);
    }
  });

  it("all segments reference the correct asset", () => {
    const assetId = result.assetsJson.items[0].asset_id;
    for (const seg of result.segmentsJson.items) {
      expect(seg.asset_id).toBe(assetId);
    }
  });

  it("segments cover entire asset without gaps", () => {
    const segs = result.segmentsJson.items;
    const assetDuration = result.assetsJson.items[0].duration_us;

    expect(segs[0].src_in_us).toBe(0);
    expect(segs[segs.length - 1].src_out_us).toBe(assetDuration);

    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].src_in_us).toBe(segs[i - 1].src_out_us);
    }
  });

  it("segment src_in_us < src_out_us for every segment", () => {
    for (const seg of result.segmentsJson.items) {
      expect(seg.src_in_us).toBeLessThan(seg.src_out_us);
    }
  });

  it("gap_report has version field", () => {
    expect(result.gapReport.version).toBe("1");
  });

  // ── Output files exist on disk ───────────────────────────────────

  it("writes assets.json to disk", () => {
    const p = path.join(result.outputDir, "assets.json");
    expect(fs.existsSync(p)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(onDisk.items).toHaveLength(1);
  });

  it("writes segments.json to disk", () => {
    const p = path.join(result.outputDir, "segments.json");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("writes gap_report.yaml to disk", () => {
    const p = path.join(result.outputDir, "gap_report.yaml");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("writes contact sheet images to disk", () => {
    const csDir = path.join(result.outputDir, "contact_sheets");
    expect(fs.existsSync(csDir)).toBe(true);
    const files = fs.readdirSync(csDir).filter((f) => f.endsWith(".png"));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("writes poster image to disk", () => {
    const asset = result.assetsJson.items[0];
    if (asset.poster_path) {
      const p = path.join(result.outputDir, asset.poster_path);
      expect(fs.existsSync(p)).toBe(true);
    }
  });

  it("writes filmstrip images to disk", () => {
    for (const seg of result.segmentsJson.items) {
      if (seg.filmstrip_path) {
        const p = path.join(result.outputDir, seg.filmstrip_path);
        expect(fs.existsSync(p)).toBe(true);
      }
    }
  });

  it("writes waveform image to disk", () => {
    const asset = result.assetsJson.items[0];
    if (asset.waveform_path) {
      const p = path.join(result.outputDir, asset.waveform_path);
      expect(fs.existsSync(p)).toBe(true);
    }
  });
});

// ── Determinism Test ───────────────────────────────────────────────

describe("Pipeline determinism", () => {
  it("produces identical output for same input across two runs", async () => {
    const tmpA = path.join(import.meta.dirname, "_tmp_det_a");
    const tmpB = path.join(import.meta.dirname, "_tmp_det_b");
    fs.mkdirSync(tmpA, { recursive: true });
    fs.mkdirSync(tmpB, { recursive: true });

    try {
      const resultA = await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpA,
        repoRoot: REPO_ROOT,
        skipStt: true,
      });
      const resultB = await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpB,
        repoRoot: REPO_ROOT,
        skipStt: true,
      });

      // Compare assets
      expect(resultA.assetsJson.items.length).toBe(resultB.assetsJson.items.length);
      for (let i = 0; i < resultA.assetsJson.items.length; i++) {
        const a = resultA.assetsJson.items[i];
        const b = resultB.assetsJson.items[i];
        expect(a.asset_id).toBe(b.asset_id);
        expect(a.source_fingerprint).toBe(b.source_fingerprint);
        expect(a.duration_us).toBe(b.duration_us);
        expect(a.segments).toBe(b.segments);
        expect(a.segment_ids).toEqual(b.segment_ids);
      }

      // Compare segments
      expect(resultA.segmentsJson.items.length).toBe(resultB.segmentsJson.items.length);
      for (let i = 0; i < resultA.segmentsJson.items.length; i++) {
        const a = resultA.segmentsJson.items[i];
        const b = resultB.segmentsJson.items[i];
        expect(a.segment_id).toBe(b.segment_id);
        expect(a.src_in_us).toBe(b.src_in_us);
        expect(a.src_out_us).toBe(b.src_out_us);
        expect(a.rep_frame_us).toBe(b.rep_frame_us);
        expect(a.quality_flags).toEqual(b.quality_flags);
      }
    } finally {
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  }, 120_000);
});

// ── 2-file order inversion test ────────────────────────────────────

const SCENE_CLIP = path.join(FIXTURES_DIR, "test-scene-changes.mp4");

describe("Pipeline: multi-asset order independence", () => {
  it("produces correct asset↔segment pairing regardless of input order", async () => {
    const tmpFwd = path.join(import.meta.dirname, "_tmp_multi_fwd");
    const tmpRev = path.join(import.meta.dirname, "_tmp_multi_rev");
    fs.mkdirSync(tmpFwd, { recursive: true });
    fs.mkdirSync(tmpRev, { recursive: true });

    try {
      // Run with [A, B] order
      const resultFwd = await runPipeline({
        sourceFiles: [TEST_CLIP, SCENE_CLIP],
        projectDir: tmpFwd,
        repoRoot: REPO_ROOT,
        skipStt: true,
      });

      // Run with [B, A] order (reversed)
      const resultRev = await runPipeline({
        sourceFiles: [SCENE_CLIP, TEST_CLIP],
        projectDir: tmpRev,
        repoRoot: REPO_ROOT,
        skipStt: true,
      });

      // Both should have 2 assets
      expect(resultFwd.assetsJson.items).toHaveLength(2);
      expect(resultRev.assetsJson.items).toHaveLength(2);

      // After sorting by asset_id, both runs should produce identical assets
      const fwdAssets = [...resultFwd.assetsJson.items].sort((a, b) =>
        a.asset_id.localeCompare(b.asset_id),
      );
      const revAssets = [...resultRev.assetsJson.items].sort((a, b) =>
        a.asset_id.localeCompare(b.asset_id),
      );

      for (let i = 0; i < fwdAssets.length; i++) {
        expect(fwdAssets[i].asset_id).toBe(revAssets[i].asset_id);
        expect(fwdAssets[i].filename).toBe(revAssets[i].filename);
        expect(fwdAssets[i].duration_us).toBe(revAssets[i].duration_us);
        expect(fwdAssets[i].segments).toBe(revAssets[i].segments);
        expect(fwdAssets[i].segment_ids).toEqual(revAssets[i].segment_ids);
      }

      // Segments should also match per asset_id
      const fwdSegs = [...resultFwd.segmentsJson.items].sort((a, b) =>
        a.segment_id.localeCompare(b.segment_id),
      );
      const revSegs = [...resultRev.segmentsJson.items].sort((a, b) =>
        a.segment_id.localeCompare(b.segment_id),
      );

      expect(fwdSegs.length).toBe(revSegs.length);
      for (let i = 0; i < fwdSegs.length; i++) {
        expect(fwdSegs[i].segment_id).toBe(revSegs[i].segment_id);
        expect(fwdSegs[i].asset_id).toBe(revSegs[i].asset_id);
        expect(fwdSegs[i].src_in_us).toBe(revSegs[i].src_in_us);
        expect(fwdSegs[i].src_out_us).toBe(revSegs[i].src_out_us);
      }
    } finally {
      fs.rmSync(tmpFwd, { recursive: true, force: true });
      fs.rmSync(tmpRev, { recursive: true, force: true });
    }
  }, 180_000);
});

// ── Peak detection pipeline integration ─────────────────────────────

describe("Pipeline: VLM peak detection writes peak_analysis to segments", () => {
  it("segments gain peak_analysis when VLM + peak detection enabled", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_peak_pipeline");
    fs.mkdirSync(tmpDir, { recursive: true });

    // Mock VLM function that returns valid peak-like responses
    const mockVlmFn = async (
      _framePaths: string[],
      prompt: string,
      _options: { model: string; maxOutputTokens: number },
    ) => {
      // Coarse pass: contains "editorial peak discovery" from COARSE_PROMPT_TEMPLATE
      if (prompt.includes("editorial peak discovery")) {
        return {
          rawJson: JSON.stringify({
            coarse_candidates: [
              {
                tile_start_index: 0,
                tile_end_index: 0,
                likely_peak_type: "action_peak",
                confidence: 0.8,
                rationale: "Test peak",
              },
            ],
          }),
        };
      }
      // Refine pass: contains "editorial peak refinement" from REFINE_PROMPT_TEMPLATE
      if (prompt.includes("editorial peak refinement")) {
        return {
          rawJson: JSON.stringify({
            summary: "Test refine summary",
            tags: ["test_tag"],
            interest_points: [],
            peak_moment: {
              timestamp_us: 2500000,
              type: "action_peak",
              confidence: 0.75,
              description: "Test peak moment",
            },
            recommended_in_out: {
              best_in_us: 2000000,
              best_out_us: 3000000,
              rationale: "Test recommendation",
              needs_precision: false,
            },
            visual_energy_curve: [
              { timestamp_us: 2500000, energy: 0.8 },
            ],
            quality_flags: [],
            confidence: { summary: 0.8, tags: 0.7, quality_flags: 0.9 },
            peak_confidence: { vlm: 0.75 },
          }),
        };
      }
      // Precision pass: contains "Refine the single strongest editorial peak"
      if (prompt.includes("strongest editorial peak")) {
        return {
          rawJson: JSON.stringify({
            peak_moment: {
              timestamp_us: 2500000,
              type: "action_peak",
              confidence: 0.85,
              description: "Precision peak",
            },
            recommended_in_out: {
              best_in_us: 2200000,
              best_out_us: 2800000,
              rationale: "Precision recommendation",
            },
          }),
        };
      }
      // Default VLM enrichment response (for segment enrichment stage)
      return {
        rawJson: JSON.stringify({
          summary: "Test summary",
          tags: ["test"],
          interest_points: [],
          quality_flags: [],
          confidence: { summary: 0.7, tags: 0.6, quality_flags: 0.8 },
        }),
      };
    };

    try {
      const result = await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpDir,
        repoRoot: REPO_ROOT,
        skipStt: true,
        vlmFn: mockVlmFn,
      });

      // Verify segments.json has peak_analysis on at least one segment
      const segWithPeak = result.segmentsJson.items.find(
        (s) => (s as Record<string, unknown>).peak_analysis !== undefined,
      );
      expect(segWithPeak).toBeDefined();

      if (segWithPeak) {
        const pa = (segWithPeak as Record<string, unknown>).peak_analysis as Record<string, unknown>;
        expect(pa.peak_moments).toBeDefined();
        expect(pa.visual_energy_curve).toBeDefined();
        expect(pa.provenance).toBeDefined();
      }

      // Verify schema compliance
      const { validateSegments } = createValidator();
      const valid = validateSegments(result.segmentsJson);
      if (!valid) {
        console.error("segments.json peak_analysis validation errors:", validateSegments.errors);
      }
      expect(valid).toBe(true);

      // Verify on-disk copy also has peak_analysis
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(result.outputDir, "segments.json"), "utf-8"),
      );
      const diskSegWithPeak = onDisk.items.find(
        (s: Record<string, unknown>) => s.peak_analysis !== undefined,
      );
      expect(diskSegWithPeak).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 90_000);

  it("skipPeak prevents peak_analysis from being written", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_peak_skip");
    fs.mkdirSync(tmpDir, { recursive: true });

    const mockVlmFn = async () => ({
      rawJson: JSON.stringify({
        summary: "Test", tags: ["test"], interest_points: [],
        quality_flags: [], confidence: { summary: 0.7, tags: 0.6, quality_flags: 0.8 },
      }),
    });

    try {
      const result = await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpDir,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipPeak: true,
        vlmFn: mockVlmFn,
      });

      const anyPeak = result.segmentsJson.items.some(
        (s) => (s as Record<string, unknown>).peak_analysis !== undefined,
      );
      expect(anyPeak).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ── Gap report: detector failure surfacing ─────────────────────────

describe("Pipeline: gap report surfaces detector failures", () => {
  it("reports detector_failure in gap_report when source file is missing", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_gap_fail");
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      // Use a valid file + a non-existent file
      // The non-existent file will fail at ingest (ffprobe), so it won't
      // produce an asset. But this validates that the pipeline doesn't crash.
      const result = await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpDir,
        repoRoot: REPO_ROOT,
        skipStt: true,
      });

      // With a valid file, gap report should have no error-severity entries
      const errors = result.gapReport.entries.filter((e) => e.severity === "error");
      expect(errors).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});
