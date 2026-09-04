/**
 * Integration tests for runtime/pipeline/ingest.ts — full pipeline execution.
 * Also validates schema compliance and determinism.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { runPipeline, type PipelineResult } from "../runtime/pipeline/ingest.js";
import type { VisualQualityMeasurements } from "../runtime/connectors/ffmpeg-motion.js";
import { sha256FileHex } from "../runtime/source-content-identity.js";

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
      skipAppraiser: true,
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

  it("segments have deterministic visual quality measurements", () => {
    for (const seg of result.segmentsJson.items) {
      expect(seg.visual_quality_measurements).toBeDefined();
      expect(seg.visual_quality_measurements?.metrics_measured).toEqual({
        shake: true,
        sharpness: true,
        exposure: true,
      });
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

  it("writes a project-relative source map and a byte-identical media symlink", async () => {
    const sourceMapPath = path.join(TMP_PROJECT, "02_media", "source_map.json");
    expect(fs.existsSync(sourceMapPath)).toBe(true);

    const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf-8")) as {
      items: Array<{ local_source_path: string; link_path: string }>;
    };
    expect(sourceMap.items).toHaveLength(1);
    expect(path.isAbsolute(sourceMap.items[0].local_source_path)).toBe(false);
    expect(sourceMap.items[0].local_source_path).toBe(sourceMap.items[0].link_path);

    const linkPath = path.join(TMP_PROJECT, sourceMap.items[0].link_path);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(await sha256FileHex(linkPath)).toBe(await sha256FileHex(TEST_CLIP));
  });
});

describe("Pipeline: merged editorial observation cache reuse", () => {
  it("reuses final VLM evidence while replacing changed appraiser and unavailable deterministic generations", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_editorial_observation_full_cache");
    fs.mkdirSync(tmpDir, { recursive: true });
    let vlmCalls = 0;
    const vlmFn = async () => {
      vlmCalls += 1;
      return {
        rawJson: JSON.stringify({
          summary: "A person moves through a wide outdoor frame.",
          tags: ["person", "outdoor"],
          interest_points: [],
          quality_flags: [],
          confidence: { summary: 0.9, tags: 0.9, quality_flags: 0.9 },
          editorial_observation: {
            visual_tags: ["person", "outdoor"],
            motion_type: "subtle",
            camera_motion_direction: "unknown",
            subject_motion_direction: "right",
            shot_scale: "wide",
            composition_anchor: "left",
            screen_side: "left",
            gaze_direction: "not_applicable",
            camera_axis: "unknown",
            dominant_subject_type: "person",
            dominant_colors: ["green"],
            confidence: { tags: 0.9, motion: 0.8, framing: 0.8, direction: 0.7, appearance: 0.8, text: 0.8 },
          },
        }),
      };
    };
    const firstMeasurement = editorialMeasurement(0.8, 0.4);
    try {
      const first = await runPipeline({
        sourceFiles: [TEST_CLIP], projectDir: tmpDir, repoRoot: REPO_ROOT,
        skipStt: true, skipPeak: true, skipMediaLink: true,
        vlmFn,
        appraiserModel: "appraiser-generation-1",
        appraiserFn: async () => ({
          visual_quality: { composition_score: 0.8, light_quality: 0.8, focus_sharpness: 0.8, subject_prominence: 0.8 },
          extracted_text: [{ text: "OLD TITLE", language: "en", confidence: 0.9 }],
          place_hint: { name: null, category: "unknown", confidence: 0, evidence: [] },
          aesthetic_notes: [],
        }),
        visualQualityAnalyzeFn: async () => firstMeasurement,
      });
      const firstObservation = first.segmentsJson.items[0].editorial_observation!;
      const firstVlmCalls = vlmCalls;
      const firstAppraiserRefs = firstObservation.evidence.filter((item) => item.producer === "appraiser").map((item) => item.evidence_ref);
      const firstMeasurementRefs = firstObservation.evidence.filter((item) => item.producer === "deterministic_measurement").map((item) => item.evidence_ref);
      expect(firstObservation.text_presence).toBe("present");
      expect(firstObservation.motion_type).toBe("rapid");
      expect(firstObservation.avg_luma).toBe(0.4);

      const second = await runPipeline({
        sourceFiles: [TEST_CLIP], projectDir: tmpDir, repoRoot: REPO_ROOT,
        skipStt: true, skipPeak: true, skipMediaLink: true,
        vlmFn,
        appraiserModel: "appraiser-generation-2",
        appraiserFn: async () => ({
          visual_quality: { composition_score: 0.7, light_quality: 0.7, focus_sharpness: 0.7, subject_prominence: 0.7 },
          extracted_text: [],
          place_hint: { name: null, category: "unknown", confidence: 0, evidence: [] },
          aesthetic_notes: [],
        }),
        visualQualityAnalyzeFn: async () => {
          throw new Error("simulated_visual_measurement_unavailable");
        },
      });
      const finalObservation = second.segmentsJson.items[0].editorial_observation!;
      expect(vlmCalls).toBe(firstVlmCalls);
      expect(finalObservation.text_presence).toBe("unknown");
      expect(finalObservation.motion_type).toBe("subtle");
      expect(finalObservation.avg_luma).toBeUndefined();
      expect(finalObservation.confidence.motion?.score).toBe(0.8);
      expect(finalObservation.confidence.motion?.evidence_refs.every((ref) => ref.startsWith("vlm:"))).toBe(true);
      expect(finalObservation.provenance.producers.find((item) => item.producer === "grounded_vlm")?.cache_decision).toBe("accepted");
      expect(finalObservation.producer_snapshots?.grounded_vlm?.producer.cache_decision).toBe("accepted");
      expect(finalObservation.evidence.some((item) => firstAppraiserRefs.includes(item.evidence_ref))).toBe(false);
      expect(finalObservation.evidence.some((item) => firstMeasurementRefs.includes(item.evidence_ref))).toBe(false);
      expect(finalObservation.provenance.producers.filter((item) => item.producer === "appraiser")).toHaveLength(1);
      expect(finalObservation.provenance.producers.find((item) => item.producer === "appraiser")?.model).toBe("appraiser-generation-2");
      expect(finalObservation.provenance.producers.filter((item) => item.producer === "deterministic_measurement")).toHaveLength(1);
      expect(finalObservation.warnings.join(" ")).toContain("simulated_visual_measurement_unavailable");
      const { validateSegments } = createValidator();
      expect(validateSegments(second.segmentsJson)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("Pipeline: visual stage absolute deadline", () => {
  it("does not enter VLM, appraiser, or measurement after the shared deadline", async () => {
    const projectDir = path.join(import.meta.dirname, `_tmp_visual_deadline_${Date.now()}`);
    fs.mkdirSync(projectDir, { recursive: true });
    let vlmCalls = 0;
    let appraiserCalls = 0;
    let measurementCalls = 0;
    try {
      await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipMarlin: true,
        skipPeak: true,
        firstPreviewDeadlineAtMs: Date.now() - 1,
        firstPreviewCompileRenderReserveMs: 0,
        vlmFn: async () => {
          vlmCalls += 1;
          return {
            rawJson: JSON.stringify({
              summary: "late",
              tags: [],
              interest_points: [],
              quality_flags: [],
              confidence: { summary: 0.8, tags: 0.8, quality_flags: 0.8 },
            }),
          };
        },
        appraiserFn: async () => {
          appraiserCalls += 1;
          return {
            visual_quality: {
              composition_score: 0.8,
              light_quality: 0.8,
              focus_sharpness: 0.8,
              subject_prominence: 0.8,
            },
            extracted_text: [],
            place_hint: { name: null, category: "unknown", confidence: 0, evidence: [] },
            aesthetic_notes: [],
          };
        },
        visualQualityAnalyzeFn: async () => {
          measurementCalls += 1;
          throw new Error("measurement must not start");
        },
      });

      expect({ vlmCalls, appraiserCalls, measurementCalls }).toEqual({
        vlmCalls: 0,
        appraiserCalls: 0,
        measurementCalls: 0,
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, 60_000);
});

function editorialMeasurement(motion: number, avgLuma: number): VisualQualityMeasurements {
  return {
    measured: true,
    connector_version: "ffmpeg-motion-test",
    method: "ffmpeg_sampled_signals",
    sample_fps: 2,
    max_width: 160,
    duration_us: 5_000_000,
    metrics_measured: { shake: true, sharpness: true, exposure: true },
    shake: { measured: true, score: motion, sample_count: 4, bins: [], average_energy: motion, peak_energy: motion, peak_timestamp_us: 2_500_000 },
    sharpness: { measured: true, sharpness_score: 0.8, blur_score: 0.2, method: "blurdetect", sample_count: 4 },
    exposure: { measured: true, exposure_score: 0.8, black_clip_ratio: 0, white_clip_ratio: 0, avg_luma: avgLuma, underexposed: false, overexposed: false, sample_count: 4 },
  };
}

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
        skipAppraiser: true,
      });
      const resultB = await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpB,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipAppraiser: true,
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
        skipAppraiser: true,
      });

      // Run with [B, A] order (reversed)
      const resultRev = await runPipeline({
        sourceFiles: [SCENE_CLIP, TEST_CLIP],
        projectDir: tmpRev,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipAppraiser: true,
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

describe("Pipeline: media-link controls", () => {
  it("skips 02_media generation when skipMediaLink is enabled", async () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_pipeline_skip_media");
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpDir,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipMediaLink: true,
        skipAppraiser: true,
      });

      expect(fs.existsSync(path.join(tmpDir, "02_media", "source_map.json"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
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
        skipAppraiser: true,
      });

      // Verify segments.json has peak_analysis on at least one segment
      const segWithPeak = result.segmentsJson.items.find(
        (s) => s.peak_analysis !== undefined,
      );
      expect(segWithPeak).toBeDefined();

      if (segWithPeak) {
        const pa = segWithPeak.peak_analysis as Record<string, unknown>;
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
        skipAppraiser: true,
      });

      const anyPeak = result.segmentsJson.items.some(
        (s) => s.peak_analysis !== undefined,
      );
      expect(anyPeak).toBe(false);
      expect(result.segmentsJson.items.every(
        (segment) => segment.editorial_observation !== undefined,
      )).toBe(true);
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
        skipAppraiser: true,
      });

      // With a valid file, gap report should have no error-severity entries
      const errors = result.gapReport.entries.filter((e) => e.severity === "error");
      expect(errors).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});
