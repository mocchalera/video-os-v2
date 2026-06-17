import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { MarlinFn } from "../runtime/connectors/marlin-types.js";
import {
  extractTagsFromScene,
  loadMarlinAssetInputs,
  runMarlinAnalysis,
} from "../runtime/pipeline/stages/marlin.js";
import { materializePeakSignalsFromSegments } from "../runtime/artifacts/peak-materialization.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  addSchema(schema: object): unknown;
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function createMarlinEventsValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas/marlin-events.schema.json"), "utf-8"));
  return ajv.compile(schema);
}

function createSegmentsValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const common = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas/analysis-common.schema.json"), "utf-8"));
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas/segments.schema.json"), "utf-8"));
  ajv.addSchema(common);
  return ajv.compile(schema);
}

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "video-os-marlin-stage-"));
}

describe("Marlin analysis stage", () => {
  it("loads asset inputs from assets.json source locators", () => {
    const projectDir = makeTempProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "02_media/source"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/assets.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "2.0.0",
        items: [
          {
            asset_id: "AST_A",
            filename: "clip-a.mp4",
            source_locator: "02_media/source/clip-a.mp4",
          },
        ],
      }),
    );

    const inputs = loadMarlinAssetInputs(projectDir, ["fallback.mp4"]);

    expect(inputs).toEqual([
      {
        assetId: "AST_A",
        sourcePath: path.join(projectDir, "02_media/source/clip-a.mp4"),
      },
    ]);
  });

  it("limits asset inputs to explicitly provided source files when they match assets", () => {
    const projectDir = makeTempProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "media"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/assets.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "2.0.0",
        items: [
          {
            asset_id: "AST_A",
            filename: "clip-a.mp4",
            source_locator: "media/clip-a.mp4",
          },
          {
            asset_id: "AST_B",
            filename: "clip-b.mp4",
            source_locator: "media/clip-b.mp4",
          },
        ],
      }),
    );

    const inputs = loadMarlinAssetInputs(projectDir, ["media/clip-b.mp4"]);

    expect(inputs).toEqual([
      {
        assetId: "AST_B",
        sourcePath: path.join(projectDir, "media/clip-b.mp4"),
      },
    ]);
  });

  it("writes schema-valid marlin_events.json from caption and find passes", async () => {
    const projectDir = makeTempProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/assets.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "2.0.0",
        items: [
          {
            asset_id: "AST_INTERVIEW",
            filename: "interview.mp4",
            source_locator: "media/interview.mp4",
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/segments.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "2.0.0",
        items: [
          {
            segment_id: "SEG_INTERVIEW_0001",
            asset_id: "AST_INTERVIEW",
            src_in_us: 0,
            src_out_us: 8_000_000,
            summary: "Interview answer",
            transcript_excerpt: "",
            quality_flags: [],
            tags: [],
          },
        ],
      }),
    );

    const calls: string[] = [];
    const marlinFn: MarlinFn = {
      async caption(videoPath) {
        calls.push(`caption:${path.basename(videoPath)}`);
        return {
          scene: "Soba noodles being prepared beside a grape vineyard.",
          caption: "The subject pauses, smiles, and delivers the key point.",
          events: [
            {
              start: 3,
              end: 5.5,
              description: "The speaker smiles before the main answer.",
              confidence: 0.74,
            },
          ],
        };
      },
      async find(videoPath, event) {
        calls.push(`find:${path.basename(videoPath)}:${event}`);
        return {
          query: event,
          span: [3.25, 5],
          format_ok: true,
          confidence: 0.66,
        };
      },
    };

    const outputPath = await runMarlinAnalysis({
      projectDir,
      projectId: "marlin-fixture",
      sourceFiles: ["media/interview.mp4"],
      marlinFn,
      model: {
        provider: "marlin",
        model_alias: "NemoStation/Marlin-2B",
        model_snapshot: "test",
      },
      queries: ["best reaction"],
    });

    const artifact = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as unknown;
    const validate = createMarlinEventsValidator();

    expect(validate(artifact), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(calls).toEqual(["caption:interview.mp4", "find:interview.mp4:best reaction"]);
    expect((artifact as { items: Array<{ asset_id: string; source_path: string }> }).items[0]).toMatchObject({
      asset_id: "AST_INTERVIEW",
      source_path: "media/interview.mp4",
    });

    const segments = JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis/segments.json"), "utf-8")) as {
      items: Array<{
        summary: string;
        tags: string[];
        confidence?: { summary?: { source: string; status: string } };
        provenance?: { summary?: Record<string, string> };
        peak_analysis?: {
          peak_moments: Array<{ source_pass: string; peak_ref: string }>;
          recommended_in_out: { source_pass: string };
        };
        interest_points?: Array<{ label: string }>;
      }>;
    };
    const validateSegments = createSegmentsValidator();

    expect(validateSegments(segments), JSON.stringify(validateSegments.errors, null, 2)).toBe(true);
    expect(segments.items[0].summary).toBe("Soba noodles being prepared beside a grape vineyard.");
    expect(segments.items[0].tags).toEqual(expect.arrayContaining(["soba_noodles", "grape_vineyard"]));
    expect(segments.items[0].confidence?.summary).toMatchObject({
      source: "marlin-2b",
      status: "ready",
    });
    expect(segments.items[0].provenance?.summary).toMatchObject({
      stage: "marlin",
      method: "marlin_reporter",
      model_alias: "marlin-2b",
      prompt_template_id: "marlin-caption-v1",
    });
    expect(segments.items[0].peak_analysis?.peak_moments[0]).toMatchObject({
      source_pass: "marlin_caption",
      peak_ref: "MEV_AST_INTERVIEW_0001",
    });
    expect(segments.items[0].interest_points?.[0].label).toContain("emotional_peak");
  });

  it("extracts compact Marlin scene tags from common local concepts", () => {
    expect(extractTagsFromScene("A grape vineyard with rows of vines.")).toContain("grape_vineyard");
    expect(extractTagsFromScene("Soba noodles being prepared at a counter.")).toContain("soba_noodles");
    expect(extractTagsFromScene("A traditional wooden building beside a lane.")).toContain("traditional_building");
  });

  it("materializes segment peak_analysis into candidate trim and scoring hints", () => {
    const projectDir = makeTempProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/segments.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "2.0.0",
        items: [
          {
            segment_id: "SEG_INTERVIEW_0001",
            asset_id: "AST_INTERVIEW",
            src_in_us: 0,
            src_out_us: 8_000_000,
            summary: "Interview answer",
            transcript_excerpt: "",
            quality_flags: [],
            tags: [],
            peak_analysis: {
              peak_moments: [
                {
                  peak_ref: "MEV_AST_INTERVIEW_0001",
                  timestamp_us: 4_250_000,
                  type: "emotional_peak",
                  confidence: 0.74,
                  description: "The speaker smiles before the main answer.",
                  source_pass: "marlin_caption",
                },
              ],
              recommended_in_out: {
                best_in_us: 2_500_000,
                best_out_us: 6_000_000,
                rationale: "Marlin temporal semantic event overlapped this segment.",
                source_pass: "marlin_caption",
              },
              visual_energy_curve: [],
              support_signals: {
                motion_support_score: 0.5,
                audio_support_score: 0,
                fused_peak_score: 0.74,
              },
              provenance: {
                coarse_prompt_template_id: "marlin-caption-find-v1",
                refine_prompt_template_id: "marlin-caption-find-v1",
                precision_mode: "marlin_temporal_semantics",
                fusion_version: "marlin-segment-peak-v1",
                support_signal_version: "marlin-confidence-v1",
              },
            },
          },
        ],
      }),
    );
    const selects: {
      candidates: Array<{
        segment_id: string;
        asset_id: string;
        src_in_us: number;
        src_out_us: number;
        confidence: number;
        editorial_signals?: Record<string, unknown>;
        trim_hint?: Record<string, unknown>;
      }>;
    } = {
      candidates: [
        {
          segment_id: "SEG_INTERVIEW_0001",
          asset_id: "AST_INTERVIEW",
          src_in_us: 0,
          src_out_us: 8_000_000,
          confidence: 0.8,
        },
      ],
    };

    expect(materializePeakSignalsFromSegments(projectDir, selects)).toBe(true);
    expect(selects.candidates[0].editorial_signals).toMatchObject({
      peak_ref: "MEV_AST_INTERVIEW_0001",
      peak_strength_score: 0.74,
      peak_type: "emotional_peak",
      peak_source_pass: "marlin_caption",
    });
    expect(selects.candidates[0].trim_hint).toMatchObject({
      source_center_us: 4_250_000,
      recommended_in_us: 2_500_000,
      recommended_out_us: 6_000_000,
      center_source: "precision_proxy_clip",
      peak_ref: "MEV_AST_INTERVIEW_0001",
    });
  });
});
