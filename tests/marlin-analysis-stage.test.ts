import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { MarlinFn } from "../runtime/connectors/marlin-types.js";
import { parseArgs as parseMarlinEvaluateArgs, runMarlinEvaluate } from "../scripts/marlin-evaluate.js";
import {
  applyMarlinEventsToSegments,
  computeMarlinChunkBoundaries,
  createMarlinFnFromEnvironment,
  extractTagsFromScene,
  loadMarlinAssetInputs,
  runMarlinAnalysis,
  selectMarlinAssetInputsForRun,
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
const MODEL = {
  provider: "marlin",
  model_alias: "NemoStation/Marlin-2B",
  model_snapshot: "test",
} as const;

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

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const fxit = ffmpegAvailable() ? it : it.skip;

function makeVideo(filePath: string, seconds: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi",
    "-i", `testsrc2=d=${seconds}:s=160x90:r=10`,
    "-pix_fmt", "yuv420p",
    filePath,
  ], { stdio: "ignore" });
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

  it("loads asset inputs from source_map entries when assets omit source locators", () => {
    const projectDir = makeTempProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/assets.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "2.0.0",
        items: [
          {
            asset_id: "AST_A",
            filename: "C0004.MP4",
          },
          {
            asset_id: "AST_B",
            filename: "D5053.MP4",
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(projectDir, "02_media/source_map.json"),
      JSON.stringify({
        version: "1",
        project_id: "marlin-fixture",
        media_dir: "02_media",
        generated_at: "2026-06-23T00:00:00.000Z",
        items: [
          {
            asset_id: "AST_A",
            source_locator: "04-jan-clip.mp4",
            local_source_path: "04-jan-clip.mp4",
            link_path: "02_media/04-jan-clip.mp4",
            kind: "asset",
          },
          {
            asset_id: "AST_B",
            source_locator: "08-jun-a-man-and-a.mp4",
            local_source_path: "08-jun-a-man-and-a.mp4",
            link_path: "02_media/08-jun-a-man-and-a.mp4",
            kind: "asset",
          },
        ],
      }),
    );

    const inputs = loadMarlinAssetInputs(projectDir, ["02_media/08-jun-a-man-and-a.mp4"]);

    expect(inputs).toEqual([
      {
        assetId: "AST_B",
        sourcePath: path.join(projectDir, "02_media/08-jun-a-man-and-a.mp4"),
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

  it("passes request timeout overrides to the local worker client", () => {
    const projectDir = makeTempProject();
    const marlinFn = createMarlinFnFromEnvironment(projectDir, REPO_ROOT, {
      requestTimeoutMs: 120_000,
    });

    const workerOptions = (marlinFn as unknown as {
      options?: { cwd?: string; requestTimeoutMs?: number };
    }).options;

    expect(workerOptions).toMatchObject({
      cwd: REPO_ROOT,
      requestTimeoutMs: 120_000,
    });
  });

  it("selects unevaluated Marlin inputs for bounded follow-up runs", () => {
    const projectDir = makeTempProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    const outputPath = path.join(projectDir, "03_analysis/marlin_events.json");
    fs.writeFileSync(
      outputPath,
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "marlin-events-v1",
        model: MODEL,
        items: [
          {
            asset_id: "AST_A",
            source_path: "media/a.mp4",
            scene: "done",
            events: [],
            find_results: [],
          },
        ],
      }),
    );

    const selected = selectMarlinAssetInputsForRun(
      [
        { assetId: "AST_A", sourcePath: path.join(projectDir, "media/a.mp4") },
        { assetId: "AST_B", sourcePath: path.join(projectDir, "media/b.mp4") },
        { assetId: "AST_C", sourcePath: path.join(projectDir, "media/c.mp4") },
      ],
      { outputPath, skipExisting: true, maxSources: 1 },
    );

    expect(selected).toEqual([
      { assetId: "AST_B", sourcePath: path.join(projectDir, "media/b.mp4") },
    ]);
  });

  it("computes deterministic Marlin chunk boundaries with overlap", () => {
    expect(computeMarlinChunkBoundaries(65, 30, 5)).toEqual([
      { index: 0, startSec: 0, endSec: 30 },
      { index: 1, startSec: 25, endSec: 55 },
      { index: 2, startSec: 50, endSec: 65 },
    ]);
    expect(() => computeMarlinChunkBoundaries(65, 30, 30)).toThrow(
      "--chunk-overlap-seconds must be smaller than --chunk-seconds",
    );
  });

  it("parses request timeout overrides from the marlin evaluation CLI", () => {
    expect(
      parseMarlinEvaluateArgs([
        "node",
        "scripts/marlin-evaluate.ts",
        "--project",
        "projects/demo",
        "--request-timeout-ms",
        "900000",
        "--max-sources=2",
        "--skip-existing",
        "--caption-only",
        "--chunk-seconds",
        "30",
        "--chunk-overlap-seconds=5",
        "--max-chunks=2",
      ]),
    ).toMatchObject({
      projectDir: "projects/demo",
      requestTimeoutMs: 900_000,
      maxSources: 2,
      skipExisting: true,
      captionOnly: true,
      chunkSeconds: 30,
      chunkOverlapSeconds: 5,
      maxChunks: 2,
    });

    expect(
      parseMarlinEvaluateArgs([
        "node",
        "scripts/marlin-evaluate.ts",
        "--project",
        "projects/demo",
        "--timeout-ms=600000",
      ]),
    ).toMatchObject({
      projectDir: "projects/demo",
      requestTimeoutMs: 600_000,
      captionOnly: false,
    });

    expect(() =>
      parseMarlinEvaluateArgs([
        "node",
        "scripts/marlin-evaluate.ts",
        "--project",
        "projects/demo",
        "--request-timeout-ms",
        "0",
      ]),
    ).toThrow("--request-timeout-ms requires a positive integer value");
  });

  it("treats skip-existing with no remaining inputs as a no-op", async () => {
    const projectDir = makeTempProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/assets.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "2.0.0",
        items: [
          {
            asset_id: "AST_A",
            filename: "a.mp4",
            source_locator: "media/a.mp4",
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/marlin_events.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "marlin-events-v1",
        model: MODEL,
        items: [
          {
            asset_id: "AST_A",
            source_path: "media/a.mp4",
            scene: "already done",
            events: [],
            find_results: [],
          },
        ],
      }),
    );

    const previousMock = process.env.VOS_MARLIN_MOCK;
    try {
      const result = await runMarlinEvaluate({
        projectDir,
        repoRoot: REPO_ROOT,
        sourceFiles: ["media/a.mp4"],
        mock: true,
        skipExisting: true,
        captionOnly: false,
      });

      expect(result.sourceCount).toBe(0);
      const artifact = JSON.parse(fs.readFileSync(result.outputPath, "utf-8"));
      expect(artifact.items.map((item: { asset_id: string }) => item.asset_id)).toEqual(["AST_A"]);
    } finally {
      if (previousMock === undefined) {
        delete process.env.VOS_MARLIN_MOCK;
      } else {
        process.env.VOS_MARLIN_MOCK = previousMock;
      }
    }
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

  it("can skip Marlin find queries for caption-only long source chunks", async () => {
    const projectDir = makeTempProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/assets.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "2.0.0",
        items: [
          {
            asset_id: "AST_LONG_SOURCE",
            filename: "long.mp4",
            source_locator: "media/long.mp4",
          },
        ],
      }),
    );

    let findCount = 0;
    const marlinFn: MarlinFn = {
      async caption() {
        return {
          scene: "A long source with multiple documentary moments.",
          caption: "The camera follows the subject through the scene.",
          events: [
            {
              start: 12,
              end: 18,
              description: "The subject reaches the key visual moment.",
              confidence: 0.72,
            },
          ],
        };
      },
      async find(_videoPath, event) {
        findCount += 1;
        return {
          query: event,
          span: [12, 18],
          format_ok: true,
          confidence: 0.5,
        };
      },
    };

    const outputPath = await runMarlinAnalysis({
      projectDir,
      projectId: "marlin-fixture",
      sourceFiles: ["media/long.mp4"],
      marlinFn,
      model: MODEL,
      queries: ["slow query"],
      captionOnly: true,
    });

    const artifact = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    expect(findCount).toBe(0);
    expect(artifact.items[0]).toMatchObject({
      asset_id: "AST_LONG_SOURCE",
      find_results: [],
    });
    expect(artifact.items[0].events).toHaveLength(1);
  });

  fxit("can checkpoint a bounded chunk from a long source asset", async () => {
    const projectDir = makeTempProject();
    const sourcePath = path.join(projectDir, "media/long.mp4");
    makeVideo(sourcePath, 4);
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/assets.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "2.0.0",
        items: [
          {
            asset_id: "AST_LONG_SOURCE",
            filename: "long.mp4",
            source_locator: "media/long.mp4",
          },
        ],
      }),
    );

    const captionInputs: string[] = [];
    const marlinFn: MarlinFn = {
      async caption(videoPath) {
        captionInputs.push(videoPath);
        return {
          scene: `Chunk scene ${captionInputs.length}`,
          caption: `Chunk caption ${captionInputs.length}`,
          events: [
            {
              start: 0.2,
              end: 0.7,
              description: `Chunk event ${captionInputs.length}`,
              confidence: 0.7,
            },
          ],
        };
      },
      async find(_videoPath, event) {
        return {
          query: event,
          span: [0.2, 0.7],
          format_ok: true,
          confidence: 0.5,
        };
      },
    };

    const outputPath = await runMarlinAnalysis({
      projectDir,
      projectId: "marlin-fixture",
      sourceFiles: ["media/long.mp4"],
      marlinFn,
      model: MODEL,
      queries: ["slow query"],
      captionOnly: true,
      chunkSeconds: 2,
      maxChunks: 1,
    });

    const artifact = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    expect(captionInputs).toHaveLength(1);
    expect(captionInputs[0]).toContain(path.join(".marlin-proxy-cache", "ranges"));
    expect(artifact.items[0]).toMatchObject({
      asset_id: "AST_LONG_SOURCE",
      source_path: "media/long.mp4",
      scene: "Chunk scene 1",
      caption: "Chunk caption 1",
      find_results: [],
    });
    expect(artifact.items[0].events[0]).toMatchObject({
      event_id: "MEV_AST_LONG_SOURCE_C0001_0001",
      start_us: 200_000,
      end_us: 700_000,
      chunk_index: 0,
    });
  }, 30_000);

  fxit("skip-existing with chunking continues past completed short assets", async () => {
    const projectDir = makeTempProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    makeVideo(path.join(projectDir, "media/a.mp4"), 1);
    makeVideo(path.join(projectDir, "media/b.mp4"), 1);
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/assets.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "2.0.0",
        items: [
          {
            asset_id: "AST_A",
            filename: "a.mp4",
            source_locator: "media/a.mp4",
          },
          {
            asset_id: "AST_B",
            filename: "b.mp4",
            source_locator: "media/b.mp4",
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/marlin_events.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "marlin-events-v1",
        model: MODEL,
        items: [
          {
            asset_id: "AST_A",
            source_path: "media/a.mp4",
            scene: "existing A",
            caption: "existing A caption",
            events: [],
            find_results: [],
          },
        ],
      }),
    );

    const captionInputs: string[] = [];
    const marlinFn: MarlinFn = {
      async caption(videoPath) {
        captionInputs.push(videoPath);
        return {
          scene: "new B",
          caption: "new B caption",
          events: [
            {
              start: 0.1,
              end: 0.4,
              description: "new B event",
              confidence: 0.7,
            },
          ],
        };
      },
      async find() {
        throw new Error("caption-only test should not call find");
      },
    };

    const outputPath = await runMarlinAnalysis({
      projectDir,
      projectId: "marlin-fixture",
      sourceFiles: [],
      marlinFn,
      model: MODEL,
      skipExisting: true,
      maxSources: 1,
      captionOnly: true,
      chunkSeconds: 30,
      chunkOverlapSeconds: 3,
      maxChunks: 2,
    });

    const artifact = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as {
      items: Array<{ asset_id: string; scene: string }>;
    };
    expect(captionInputs).toHaveLength(1);
    expect(artifact.items.map((item) => item.asset_id).sort()).toEqual(["AST_A", "AST_B"]);
    expect(artifact.items.find((item) => item.asset_id === "AST_A")?.scene).toBe("existing A");
    expect(artifact.items.find((item) => item.asset_id === "AST_B")?.scene).toBe("new B");
  }, 30_000);

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

  it("replaces degraded fallback peaks with Marlin temporal semantic peaks", () => {
    const projectDir = makeTempProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/segments.json"),
      JSON.stringify({
        project_id: "marlin-fixture",
        artifact_version: "2.0.0",
        items: [
          {
            segment_id: "SEG_ACTION_0001",
            asset_id: "AST_ACTION",
            src_in_us: 0,
            src_out_us: 10_000_000,
            summary: "Fallback summary",
            transcript_excerpt: "",
            quality_flags: [],
            tags: [],
            peak_analysis: {
              peak_moments: [
                {
                  peak_ref: "PK_SEG_ACTION_0001_degraded",
                  timestamp_us: 5_000_000,
                  type: "action_peak",
                  confidence: 0.99,
                  description: "degraded fallback peak from local motion/audio/speech heuristics",
                  source_pass: "degraded_ffmpeg_signals",
                },
              ],
              visual_energy_curve: [],
              support_signals: {
                motion_support_score: 1,
                audio_support_score: 0,
                fused_peak_score: 1,
              },
              provenance: {
                coarse_prompt_template_id: "degraded-fallback",
                refine_prompt_template_id: "degraded-fallback",
                precision_mode: "never",
                fusion_version: "degraded-peak-fusion-v1",
                support_signal_version: "ffmpeg-sad-rms-v1",
              },
            },
          },
        ],
      }),
    );

    const changed = applyMarlinEventsToSegments(projectDir, {
      project_id: "marlin-fixture",
      artifact_version: "marlin-events-v1",
      model: MODEL,
      items: [
        {
          asset_id: "AST_ACTION",
          source_path: "media/action.mp4",
          scene: "A cook lifts fried food from hot oil and places it on a rack.",
          caption: "A cook lifts fried food from hot oil.",
          events: [
            {
              event_id: "MEV_AST_ACTION_0001",
              start_us: 2_000_000,
              end_us: 4_000_000,
              description: "The cook lifts fried food from hot oil.",
              confidence: 0.64,
              source_pass: "marlin_caption",
            },
          ],
          find_results: [],
        },
      ],
    });

    const segments = JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis/segments.json"), "utf-8")) as {
      items: Array<{
        peak_analysis?: {
          peak_moments?: Array<{ peak_ref?: string; source_pass?: string }>;
          provenance?: { precision_mode?: string };
        };
      }>;
    };

    expect(changed).toBe(true);
    expect(segments.items[0].peak_analysis?.provenance?.precision_mode).toBe("marlin_temporal_semantics");
    expect(segments.items[0].peak_analysis?.peak_moments?.[0]).toMatchObject({
      peak_ref: "MEV_AST_ACTION_0001",
      source_pass: "marlin_caption",
    });
  });
});
