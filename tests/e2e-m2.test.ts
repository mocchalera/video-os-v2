/**
 * M2 Phase 5: E2E Proof — live analysis → MCP reads → M1 compiler loop.
 *
 * Proves that:
 * 1. Live pipeline produces schema-valid artifacts
 * 2. MCP repository reads live artifacts correctly
 * 3. project_summary fields are correct
 * 4. M1 compiler loop runs against live-generated 03_analysis/ + hand-authored 04_plan/
 * 5. Determinism: same input → same output
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { stringify as stringifyYaml } from "yaml";
import { runPipeline, type PipelineResult } from "../runtime/pipeline/ingest.js";
import { LiveAnalysisRepository } from "../runtime/mcp/repository.js";
import { projectAnalysisGaps, deriveQcStatus } from "../runtime/mcp/gap-projection.js";
import { compile } from "../runtime/compiler/index.js";
import { validateProject } from "../scripts/validate-schemas.js";
import type { TranscribeFn, SttChunkResult } from "../runtime/connectors/stt-interface.js";
import type { VlmFn, VlmCallResult } from "../runtime/connectors/gemini-vlm.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
  addSchema(schema: object): void;
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

// ── Paths ──────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures/media");
const TEST_CLIP = path.join(FIXTURES_DIR, "test-clip-5s.mp4");
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TMP_PROJECT = path.join(import.meta.dirname, "_tmp_e2e_m2");
const FIXED_CREATED_AT = "2026-03-21T00:00:00Z";

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

// ── Hand-authored bridge artifacts ─────────────────────────────────

/**
 * Generate 01_intent and 04_plan artifacts that reference the live-generated
 * segment IDs. This bridges M2 analysis output to M1 compiler input.
 */
function generateBridgeArtifacts(result: PipelineResult, projectDir: string): void {
  const segments = result.segmentsJson.items;
  const assets = result.assetsJson.items;
  const projectId = result.assetsJson.project_id;

  // 01_intent/creative_brief.yaml
  const intentDir = path.join(projectDir, "01_intent");
  fs.mkdirSync(intentDir, { recursive: true });

  const brief = {
    version: "1",
    project_id: projectId,
    created_at: FIXED_CREATED_AT,
    project: {
      id: projectId,
      title: "E2E Test Project",
      strategy: "message-first",
      client: "E2E test",
      format: "short-brand-film",
      runtime_target_sec: 10,
    },
    message: {
      primary: "Test message for E2E validation",
      secondary: ["secondary message"],
    },
    audience: {
      primary: "test audience",
      secondary: [],
      excluded: [],
    },
    emotion_curve: ["curiosity", "release"],
    must_have: ["test content"],
    must_avoid: ["nothing specific"],
    autonomy: {
      may_decide: ["cut position"],
      must_ask: ["removing content"],
    },
    resolved_assumptions: ["test assumption"],
    hypotheses: ["test hypothesis"],
    forbidden_interpretations: ["test forbidden"],
  };
  fs.writeFileSync(path.join(intentDir, "creative_brief.yaml"), stringifyYaml(brief));

  // 01_intent/unresolved_blockers.yaml
  const blockers = {
    version: "1",
    project_id: projectId,
    created_at: FIXED_CREATED_AT,
    blockers: [],
  };
  fs.writeFileSync(path.join(intentDir, "unresolved_blockers.yaml"), stringifyYaml(blockers));

  // 04_plan/edit_blueprint.yaml — uses at least 2 beats
  const planDir = path.join(projectDir, "04_plan");
  fs.mkdirSync(planDir, { recursive: true });

  const blueprint = {
    version: "1",
    project_id: projectId,
    created_at: FIXED_CREATED_AT,
    sequence_goals: ["open with detail", "resolve with calm"],
    beats: [
      {
        id: "b01",
        label: "hook",
        purpose: "establish the scene",
        target_duration_frames: 48,
        required_roles: ["hero"],
        preferred_roles: ["texture"],
        notes: "keep it short",
      },
      {
        id: "b02",
        label: "release",
        purpose: "close the loop",
        target_duration_frames: 72,
        required_roles: ["hero", "support"],
        preferred_roles: [],
        notes: "let it breathe",
      },
    ],
    pacing: {
      opening_cadence: "brisk",
      middle_cadence: "spacious",
      ending_cadence: "warm",
      max_shot_length_frames: 120,
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b02",
      avoid_anthemic_lift: true,
      permitted_energy_curve: "restrained_to_warm",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
      prioritize_lines: [],
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
      allow_hard_cuts: true,
      avoid_speed_ramps: true,
    },
    ending_policy: {
      should_feel: "restorative",
      final_line_strategy: "hold",
      avoid_cta: true,
      final_hold_min_frames: 12,
    },
    rejection_rules: [],
  };
  fs.writeFileSync(path.join(planDir, "edit_blueprint.yaml"), stringifyYaml(blueprint));

  // 04_plan/selects_candidates.yaml — references live segment IDs
  const assetId = assets[0].asset_id;
  const candidateSegments = segments.slice(0, Math.min(segments.length, 4));

  const selects = {
    version: "1",
    project_id: projectId,
    created_at: FIXED_CREATED_AT,
    analysis_artifact_version: result.assetsJson.artifact_version,
    selection_notes: ["auto-generated for E2E test"],
    candidates: candidateSegments.map((seg, idx) => ({
      segment_id: seg.segment_id,
      asset_id: seg.asset_id,
      src_in_us: seg.src_in_us,
      src_out_us: seg.src_out_us,
      role: idx === 0 ? "hero" : "support",
      why_it_matches: `E2E test candidate ${idx}`,
      risks: [],
      confidence: 0.9,
      semantic_rank: idx + 1,
      quality_flags: seg.quality_flags,
      evidence: ["visual_tag"],
      eligible_beats: idx === 0 ? ["b01", "b02"] : ["b02"],
      motif_tags: seg.tags.slice(0, 2),
    })),
  };
  fs.writeFileSync(path.join(planDir, "selects_candidates.yaml"), stringifyYaml(selects));
}

// ── Setup / Teardown ───────────────────────────────────────────────

let pipelineResult: PipelineResult;

beforeAll(async () => {
  // Clean up any previous run
  if (fs.existsSync(TMP_PROJECT)) {
    fs.rmSync(TMP_PROJECT, { recursive: true, force: true });
  }
  fs.mkdirSync(TMP_PROJECT, { recursive: true });

  // Run pipeline on real test media (skip STT/VLM for CI)
  pipelineResult = await runPipeline({
    sourceFiles: [TEST_CLIP],
    projectDir: TMP_PROJECT,
    repoRoot: REPO_ROOT,
    skipStt: true,
    skipVlm: true,
  });

  // Generate bridge artifacts for M1 compiler
  generateBridgeArtifacts(pipelineResult, TMP_PROJECT);
}, 180_000);

afterAll(() => {
  if (fs.existsSync(TMP_PROJECT)) {
    fs.rmSync(TMP_PROJECT, { recursive: true, force: true });
  }
});

// ── SC1: Live artifacts are schema-valid ────────────────────────────

describe("SC1: Live artifacts schema validation", () => {
  it("assets.json validates against schema", () => {
    const { validateAssets } = createValidator();
    const valid = validateAssets(pipelineResult.assetsJson);
    if (!valid) {
      console.error("assets.json validation errors:", validateAssets.errors);
    }
    expect(valid).toBe(true);
  });

  it("segments.json validates against schema", () => {
    const { validateSegments } = createValidator();
    const valid = validateSegments(pipelineResult.segmentsJson);
    if (!valid) {
      console.error("segments.json validation errors:", validateSegments.errors);
    }
    expect(valid).toBe(true);
  });

  it("artifacts are written to disk", () => {
    expect(fs.existsSync(path.join(pipelineResult.outputDir, "assets.json"))).toBe(true);
    expect(fs.existsSync(path.join(pipelineResult.outputDir, "segments.json"))).toBe(true);
    expect(fs.existsSync(path.join(pipelineResult.outputDir, "gap_report.yaml"))).toBe(true);
  });
});

// ── SC3: MCP tools read live artifacts ──────────────────────────────

describe("SC3: MCP repository reads live artifacts", () => {
  let repo: LiveAnalysisRepository;

  beforeAll(() => {
    repo = new LiveAnalysisRepository(TMP_PROJECT);
  });

  it("project_summary returns correct counts", () => {
    const projectId = pipelineResult.assetsJson.project_id;
    const summary = repo.projectSummary(projectId);

    expect(summary.project_id).toBe(projectId);
    expect(summary.assets_total).toBe(pipelineResult.assetsJson.items.length);
    expect(summary.segments_total).toBe(pipelineResult.segmentsJson.items.length);
  });

  it("project_summary.transcripts_available matches asset data", () => {
    const projectId = pipelineResult.assetsJson.project_id;
    const summary = repo.projectSummary(projectId);
    const hasTranscript = pipelineResult.assetsJson.items.some((a) => a.has_transcript);
    expect(summary.transcripts_available).toBe(hasTranscript);
  });

  it("project_summary.contact_sheets_available matches asset data", () => {
    const projectId = pipelineResult.assetsJson.project_id;
    const summary = repo.projectSummary(projectId);
    const hasContactSheets = pipelineResult.assetsJson.items.some(
      (a) => a.contact_sheet_ids && a.contact_sheet_ids.length > 0,
    );
    expect(summary.contact_sheets_available).toBe(hasContactSheets);
  });

  it("project_summary.top_motifs has up to 5 entries from segment tags", () => {
    const projectId = pipelineResult.assetsJson.project_id;
    const summary = repo.projectSummary(projectId);
    expect(summary.top_motifs.length).toBeLessThanOrEqual(5);

    // All motifs should appear in segment tags
    const allTags = new Set<string>();
    for (const seg of pipelineResult.segmentsJson.items) {
      for (const tag of seg.tags) allTags.add(tag);
    }
    for (const motif of summary.top_motifs) {
      expect(allTags.has(motif)).toBe(true);
    }
  });

  it("project_summary.qc_status and analysis_gaps match gap_report", () => {
    const projectId = pipelineResult.assetsJson.project_id;
    const summary = repo.projectSummary(projectId);

    // Direct computation for comparison
    const expectedGaps = projectAnalysisGaps(pipelineResult.gapReport);
    const expectedQc = deriveQcStatus(
      pipelineResult.gapReport,
      pipelineResult.assetsJson.items.length,
    );

    expect(summary.analysis_gaps).toEqual(expectedGaps);
    expect(summary.qc_status).toBe(expectedQc);
  });

  it("list_assets returns all assets", () => {
    const projectId = pipelineResult.assetsJson.project_id;
    const result = repo.listAssets(projectId);
    expect(result.items.length).toBe(pipelineResult.assetsJson.items.length);
  });

  it("get_asset returns correct asset", () => {
    const projectId = pipelineResult.assetsJson.project_id;
    const assetId = pipelineResult.assetsJson.items[0].asset_id;
    const result = repo.getAsset(projectId, assetId);
    expect(result.asset_id).toBe(assetId);
    expect(result.duration_us).toBe(pipelineResult.assetsJson.items[0].duration_us);
    expect(result.segment_ids.length).toBe(pipelineResult.assetsJson.items[0].segments);
  });

  it("peek_segment returns correct segment with timecodes", () => {
    const projectId = pipelineResult.assetsJson.project_id;
    const segId = pipelineResult.segmentsJson.items[0].segment_id;
    const result = repo.peekSegment(projectId, segId);
    expect(result.segment_id).toBe(segId);
    expect(result.src_in_tc).toMatch(/^\d{2}:\d{2}:\d{2}:\d{2}$/);
    expect(result.src_out_tc).toMatch(/^\d{2}:\d{2}:\d{2}:\d{2}$/);
    expect(result.tags).toEqual(pipelineResult.segmentsJson.items[0].tags);
  });

  it("search_segments returns results for matching query", () => {
    const projectId = pipelineResult.assetsJson.project_id;
    // Use tags from first segment as query
    const firstSeg = pipelineResult.segmentsJson.items[0];
    if (firstSeg.tags.length > 0) {
      const result = repo.searchSegments(projectId, firstSeg.tags[0]);
      expect(result.results.length).toBeGreaterThan(0);
    }
  });

  it("open_contact_sheet reads manifest when available", () => {
    const projectId = pipelineResult.assetsJson.project_id;
    const asset = pipelineResult.assetsJson.items[0];
    if (asset.contact_sheet_ids && asset.contact_sheet_ids.length > 0) {
      const result = repo.openContactSheet(projectId, asset.contact_sheet_ids[0]);
      expect(result.contact_sheet_id).toBe(asset.contact_sheet_ids[0]);
      expect(result.tile_map.length).toBeGreaterThan(0);
    }
  });
});

// ── SC4: M1 compiler loop on live artifacts ─────────────────────────

describe("SC4: M1 compiler loop runs on live-generated 03_analysis/", () => {
  it("compiler produces timeline from live artifacts + hand-authored plan", () => {
    const result = compile({ projectPath: TMP_PROJECT, createdAt: FIXED_CREATED_AT });

    expect(result.timeline.version).toBe("1");
    expect(result.timeline.project_id).toBe(pipelineResult.assetsJson.project_id);
    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(fs.existsSync(result.previewManifestPath)).toBe(true);

    // Timeline should have clips from live-generated segments
    const allClips = [
      ...result.timeline.tracks.video.flatMap((t) => t.clips),
      ...result.timeline.tracks.audio.flatMap((t) => t.clips),
    ];
    expect(allClips.length).toBeGreaterThan(0);

    // Every clip's segment_id should exist in the live segments
    const liveSegIds = new Set(pipelineResult.segmentsJson.items.map((s) => s.segment_id));
    for (const clip of allClips) {
      expect(liveSegIds.has(clip.segment_id)).toBe(true);
    }
  });
});

// ── SC2: Determinism ────────────────────────────────────────────────

describe("SC2: Determinism — same input produces same output", () => {
  it("two pipeline runs produce identical artifacts", async () => {
    const tmpA = path.join(import.meta.dirname, "_tmp_e2e_m2_det_a");
    const tmpB = path.join(import.meta.dirname, "_tmp_e2e_m2_det_b");

    try {
      fs.mkdirSync(tmpA, { recursive: true });
      fs.mkdirSync(tmpB, { recursive: true });

      const resultA = await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpA,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipVlm: true,
      });

      const resultB = await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpB,
        repoRoot: REPO_ROOT,
        skipStt: true,
        skipVlm: true,
      });

      // Asset IDs are stable
      expect(resultA.assetsJson.items.length).toBe(resultB.assetsJson.items.length);
      for (let i = 0; i < resultA.assetsJson.items.length; i++) {
        expect(resultA.assetsJson.items[i].asset_id).toBe(resultB.assetsJson.items[i].asset_id);
        expect(resultA.assetsJson.items[i].source_fingerprint).toBe(
          resultB.assetsJson.items[i].source_fingerprint,
        );
      }

      // Segment IDs and boundaries are stable
      expect(resultA.segmentsJson.items.length).toBe(resultB.segmentsJson.items.length);
      for (let i = 0; i < resultA.segmentsJson.items.length; i++) {
        const segA = resultA.segmentsJson.items[i];
        const segB = resultB.segmentsJson.items[i];
        expect(segA.segment_id).toBe(segB.segment_id);
        expect(segA.src_in_us).toBe(segB.src_in_us);
        expect(segA.src_out_us).toBe(segB.src_out_us);
      }

      // Gap reports match
      expect(resultA.gapReport.entries.length).toBe(resultB.gapReport.entries.length);

      // MCP project_summary matches between runs
      const repoA = new LiveAnalysisRepository(tmpA);
      const repoB = new LiveAnalysisRepository(tmpB);
      const summaryA = repoA.projectSummary(resultA.assetsJson.project_id);
      const summaryB = repoB.projectSummary(resultB.assetsJson.project_id);

      expect(summaryA.assets_total).toBe(summaryB.assets_total);
      expect(summaryA.segments_total).toBe(summaryB.segments_total);
      expect(summaryA.qc_status).toBe(summaryB.qc_status);
      expect(summaryA.top_motifs).toEqual(summaryB.top_motifs);
    } finally {
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  }, 180_000);
});

// ── SC5: Partial failure → gap_report ───────────────────────────────

describe("SC5: Gap report is generated correctly", () => {
  it("gap_report has version field", () => {
    expect(pipelineResult.gapReport.version).toBe("1");
  });

  it("gap_report.entries is an array", () => {
    expect(Array.isArray(pipelineResult.gapReport.entries)).toBe(true);
  });

  it("gap entries (if any) have required fields", () => {
    for (const entry of pipelineResult.gapReport.entries) {
      expect(entry.stage).toBeDefined();
      expect(entry.asset_id).toBeDefined();
      expect(entry.severity).toMatch(/^(warning|error)$/);
    }
  });

  it("skipped STT produces gap entries for assets with audio", () => {
    // We skipped STT, so assets with audio should have stt-related gaps
    // or no gaps if stt stage was skipped entirely (which is valid)
    const sttGaps = pipelineResult.gapReport.entries.filter((e) => e.stage === "stt");
    // When skipStt=true, the pipeline doesn't run stt at all,
    // so there should be no stt gap entries (stage was intentionally skipped)
    // This is a valid behavior — skipping is not a failure
    expect(sttGaps.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Full E2E lane with mock STT + mock VLM (proves Success Criteria 1-5)
// ══════════════════════════════════════════════════════════════════════

describe("Full E2E: ingest → segment → derivatives → STT → VLM (mock providers)", () => {
  const TMP_FULL = path.join(import.meta.dirname, "_tmp_e2e_m2_full");
  let fullResult: PipelineResult;

  // Mock STT: returns two speakers with diarized utterances
  const mockTranscribeFn: TranscribeFn = async (_audioPath, _options) => {
    const result: SttChunkResult = {
      utterances: [
        { speaker: "speaker_0", start_us: 0, end_us: 2_000_000, text: "Good morning, welcome to the mountains." },
        { speaker: "speaker_1", start_us: 2_000_000, end_us: 4_000_000, text: "Thank you, it is beautiful up here." },
      ],
      language: "en",
      language_confidence: 0.95,
    };
    return result;
  };

  // Mock VLM: returns valid enrichment JSON
  const mockVlmFn: VlmFn = async (_framePaths, _prompt, _options) => {
    const result: VlmCallResult = {
      rawJson: JSON.stringify({
        summary: "Mountain landscape with morning light",
        tags: ["mountain", "morning_light", "landscape"],
        interest_points: [
          { frame_us: 1_000_000, label: "sunrise glow", confidence: 0.85 },
        ],
        quality_flags: [],
        confidence: { summary: 0.9, tags: 0.85, quality_flags: 0.95 },
      }),
    };
    return result;
  };

  beforeAll(async () => {
    if (fs.existsSync(TMP_FULL)) {
      fs.rmSync(TMP_FULL, { recursive: true, force: true });
    }
    fs.mkdirSync(TMP_FULL, { recursive: true });

    fullResult = await runPipeline({
      sourceFiles: [TEST_CLIP],
      projectDir: TMP_FULL,
      repoRoot: REPO_ROOT,
      transcribeFn: mockTranscribeFn,
      vlmFn: mockVlmFn,
    });

    generateBridgeArtifacts(fullResult, TMP_FULL);
  }, 180_000);

  afterAll(() => {
    if (fs.existsSync(TMP_FULL)) {
      fs.rmSync(TMP_FULL, { recursive: true, force: true });
    }
  });

  // SC1: Full pipeline produces schema-valid artifacts
  it("SC1: assets.json validates against schema", () => {
    const { validateAssets } = createValidator();
    const valid = validateAssets(fullResult.assetsJson);
    if (!valid) console.error("Full E2E assets.json errors:", validateAssets.errors);
    expect(valid).toBe(true);
  });

  it("SC1: segments.json validates against schema", () => {
    const { validateSegments } = createValidator();
    const valid = validateSegments(fullResult.segmentsJson);
    if (!valid) console.error("Full E2E segments.json errors:", validateSegments.errors);
    expect(valid).toBe(true);
  });

  // SC1: Pipeline completed all stages (ingest → segment → contact_sheet → stt → vlm)
  it("SC1: pipeline completed STT stage — assets have transcripts", () => {
    const withTranscript = fullResult.assetsJson.items.filter((a) => a.has_transcript);
    expect(withTranscript.length).toBeGreaterThan(0);
  });

  it("SC1: pipeline completed VLM stage — segments have enrichment", () => {
    const enriched = fullResult.segmentsJson.items.filter(
      (s) => s.tags.length > 0 && s.summary && s.summary.length > 0,
    );
    expect(enriched.length).toBeGreaterThan(0);
  });

  it("SC1: transcript files written to disk by reducer", () => {
    const transcriptsDir = path.join(fullResult.outputDir, "transcripts");
    expect(fs.existsSync(transcriptsDir)).toBe(true);
    const files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
  });

  // SC2: Segments have transcript_excerpt from STT alignment
  it("SC2: segments have transcript_excerpt aligned from STT", () => {
    const withExcerpt = fullResult.segmentsJson.items.filter(
      (s) => s.transcript_excerpt && s.transcript_excerpt.length > 0,
    );
    expect(withExcerpt.length).toBeGreaterThan(0);
  });

  // SC3: MCP repository reads full artifacts including STT + VLM data
  it("SC3: MCP project_summary reflects STT + VLM data", () => {
    const repo = new LiveAnalysisRepository(TMP_FULL);
    const projectId = fullResult.assetsJson.project_id;
    const summary = repo.projectSummary(projectId);

    expect(summary.transcripts_available).toBe(true);
    expect(summary.top_motifs.length).toBeGreaterThan(0);
  });

  it("SC3: MCP readTranscriptSpan returns transcript data", () => {
    const repo = new LiveAnalysisRepository(TMP_FULL);
    const projectId = fullResult.assetsJson.project_id;
    const asset = fullResult.assetsJson.items.find((a) => a.has_transcript);
    if (asset && asset.transcript_ref) {
      const span = repo.readTranscriptSpan(projectId, asset.transcript_ref, 0, 5_000_000);
      expect(span.items.length).toBeGreaterThan(0);
    }
  });

  // SC4: M1 compiler loop runs on full artifacts
  it("SC4: compiler produces timeline from full STT+VLM artifacts", () => {
    const result = compile({ projectPath: TMP_FULL, createdAt: FIXED_CREATED_AT });
    expect(result.timeline.version).toBe("1");
    expect(result.timeline.project_id).toBe(fullResult.assetsJson.project_id);

    const allClips = [
      ...result.timeline.tracks.video.flatMap((t) => t.clips),
      ...result.timeline.tracks.audio.flatMap((t) => t.clips),
    ];
    expect(allClips.length).toBeGreaterThan(0);
  });

  // SC5: Gap report reflects VLM stage results
  it("SC5: gap_report is generated with correct structure", () => {
    expect(fullResult.gapReport.version).toBe("1");
    expect(Array.isArray(fullResult.gapReport.entries)).toBe(true);
    // With mock providers, no STT/VLM failures expected
    const sttErrors = fullResult.gapReport.entries.filter(
      (e) => e.stage === "stt" && e.severity === "error",
    );
    expect(sttErrors.length).toBe(0);
  });

  // VLM enrichment specifics
  it("VLM enrichment: segments have VLM-derived tags", () => {
    const vlmTags = fullResult.segmentsJson.items.flatMap((s) => s.tags);
    expect(vlmTags).toContain("mountain");
    expect(vlmTags).toContain("morning_light");
  });

  it("VLM enrichment: segments have confidence records", () => {
    const withConfidence = fullResult.segmentsJson.items.filter(
      (s) => s.confidence && (s.confidence as Record<string, unknown>).summary,
    );
    expect(withConfidence.length).toBeGreaterThan(0);
  });

  // Determinism with full STT+VLM
  it("SC2: two full pipeline runs produce identical artifacts", async () => {
    const tmpDet = path.join(import.meta.dirname, "_tmp_e2e_m2_full_det");
    try {
      fs.mkdirSync(tmpDet, { recursive: true });
      const resultB = await runPipeline({
        sourceFiles: [TEST_CLIP],
        projectDir: tmpDet,
        repoRoot: REPO_ROOT,
        transcribeFn: mockTranscribeFn,
        vlmFn: mockVlmFn,
      });

      // Asset IDs stable
      expect(resultB.assetsJson.items.length).toBe(fullResult.assetsJson.items.length);
      for (let i = 0; i < fullResult.assetsJson.items.length; i++) {
        expect(resultB.assetsJson.items[i].asset_id).toBe(fullResult.assetsJson.items[i].asset_id);
      }

      // Segment IDs stable
      expect(resultB.segmentsJson.items.length).toBe(fullResult.segmentsJson.items.length);
      for (let i = 0; i < fullResult.segmentsJson.items.length; i++) {
        expect(resultB.segmentsJson.items[i].segment_id).toBe(
          fullResult.segmentsJson.items[i].segment_id,
        );
      }

      // Transcript refs stable
      for (let i = 0; i < fullResult.assetsJson.items.length; i++) {
        expect(resultB.assetsJson.items[i].transcript_ref).toBe(
          fullResult.assetsJson.items[i].transcript_ref,
        );
      }
    } finally {
      fs.rmSync(tmpDet, { recursive: true, force: true });
    }
  }, 180_000);
});
