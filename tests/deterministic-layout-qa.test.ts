import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateDeterministicLayoutQA,
  type RenderLayoutSnapshot,
} from "../runtime/review/deterministic-layout-qa.js";
import { findMissingFontGlyphs } from "../runtime/fonts/font-glyph-coverage.js";
import { inspectCaptionFontContract } from "../runtime/caption/font-contract.js";
import { buildRenderLayoutSnapshot } from "../runtime/review/render-layout-snapshot.js";
import type { CaptionApproval } from "../runtime/caption/approval.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

interface FixtureCase {
  id: string;
  expected_status: "verified" | "blocked";
  expected_issue_codes: string[];
  snapshot?: RenderLayoutSnapshot;
  patch?: {
    layer_id: string;
    bounds?: { x: number; y: number; width: number; height: number };
    start_frame?: number;
    font?: RenderLayoutSnapshot["layers"][number]["font"];
  };
  append_layer?: RenderLayoutSnapshot["layers"][number];
  ending_patch?: Partial<RenderLayoutSnapshot["ending"]>;
}

interface FixtureDocument {
  version: "layout-qa-fixtures/v1";
  cases: FixtureCase[];
}

function loadCases(): FixtureCase[] {
  const fixturePath = path.join(
    process.cwd(),
    "tests/fixtures/layout-qa/cases.json",
  );
  const document = JSON.parse(
    fs.readFileSync(fixturePath, "utf8"),
  ) as FixtureDocument;
  expect(document.version).toBe("layout-qa-fixtures/v1");
  return document.cases;
}

function materializeCases(cases: FixtureCase[]): Array<{
  fixture: FixtureCase;
  snapshot: RenderLayoutSnapshot;
}> {
  const clean = cases.find((fixture) => fixture.snapshot)?.snapshot;
  if (!clean) throw new Error("layout QA fixtures require a base snapshot");

  return cases.map((fixture) => {
    const snapshot = structuredClone(fixture.snapshot ?? clean);
    if (fixture.patch) {
      const layer = snapshot.layers.find(
        (candidate) => candidate.layer_id === fixture.patch!.layer_id,
      );
      if (!layer) throw new Error(`Unknown fixture layer ${fixture.patch.layer_id}`);
      if (fixture.patch.bounds) layer.bounds = fixture.patch.bounds;
      if (fixture.patch.start_frame !== undefined) {
        layer.start_frame = fixture.patch.start_frame;
      }
      if (fixture.patch.font) layer.font = fixture.patch.font;
    }
    if (fixture.append_layer) {
      snapshot.layers.push(structuredClone(fixture.append_layer));
    }
    if (fixture.ending_patch) {
      snapshot.ending = { ...snapshot.ending, ...fixture.ending_patch };
    }
    return { fixture, snapshot };
  });
}

describe("deterministic caption and CTA layout QA", () => {
  for (const { fixture, snapshot } of materializeCases(loadCases())) {
    it(fixture.id, () => {
      const result = evaluateDeterministicLayoutQA(snapshot);
      expect(result.status).toBe(fixture.expected_status);
      expect(result.issues.map((issue) => issue.code)).toEqual(
        fixture.expected_issue_codes,
      );
      expect(result.review_items.map((item) => item.code)).toEqual(
        fixture.expected_issue_codes,
      );
      expect(result.review_items).toEqual(
        result.review_items.length === 0
          ? []
          : expect.arrayContaining([
            expect.objectContaining({
              issue_id: expect.stringMatching(/^LAYOUTQA_[A-F0-9]{16}$/),
              severity: "blocking",
              title_ja: expect.any(String),
              remediation_ja: expect.any(String),
              layer_ids: expect.any(Array),
            }),
          ]),
      );
    });
  }

  it("fails closed when renderer evidence is incomplete", () => {
    const clean = loadCases().find((fixture) => fixture.snapshot)?.snapshot;
    const snapshot = structuredClone(clean!);
    snapshot.layers[0].font = undefined;

    const result = evaluateDeterministicLayoutQA(snapshot);

    expect(result.status).toBe("incomplete");
    expect(result.issues.map((issue) => issue.code)).toContain(
      "renderer_evidence_incomplete",
    );
    expect(result.review_items).toEqual([
      expect.objectContaining({
        code: "renderer_evidence_incomplete",
        title_ja: "レイアウト検証証拠が不足",
      }),
    ]);
  });

  it("projects exact frame and rational-time ranges with deterministic remediation", () => {
    const clean = loadCases().find((fixture) => fixture.snapshot)?.snapshot;
    const snapshot = structuredClone(clean!);
    snapshot.frame.fps_num = 30_000;
    snapshot.frame.fps_den = 1_001;
    snapshot.layers.find((layer) => layer.layer_id === "CTA_1")!.start_frame = 60;

    const first = evaluateDeterministicLayoutQA(snapshot);
    const second = evaluateDeterministicLayoutQA(structuredClone(snapshot));

    expect(first.review_items).toEqual(second.review_items);
    expect(first.review_items).toEqual([
      expect.objectContaining({
        code: "caption_visual_collision",
        layer_ids: ["CAP_1", "CTA_1"],
        start_frame: 60,
        end_frame: 90,
        start_timecode: "00:00:02.002",
        end_timecode: "00:00:03.003",
        title_ja: "字幕と画面テキストが衝突",
        remediation_ja: expect.stringContaining("表示区間"),
      }),
    ]);
    expect(validateAgainstSchema({
      version: "1",
      project_id: "layout-review-projection",
      source_of_truth: "engine_render",
      qa_profile: "engine_render",
      passed: false,
      checks: [{
        name: "caption_visual_collision_absent",
        passed: false,
        details: first.issues[0].detail,
      }],
      metrics: { deterministic_layout_qa: first },
      artifacts: {},
    }, "package-qa-report.schema.json")).toEqual({
      valid: true,
      errors: [],
    });
    const legacyResult = {
      ...first,
      version: "deterministic-layout-qa/v1",
    } as Record<string, unknown>;
    delete legacyResult.review_items;
    expect(validateAgainstSchema({
      version: "1",
      project_id: "layout-review-projection-legacy",
      source_of_truth: "engine_render",
      qa_profile: "engine_render",
      passed: false,
      checks: [{
        name: "caption_visual_collision_absent",
        passed: false,
        details: first.issues[0].detail,
      }],
      metrics: { deterministic_layout_qa: legacyResult },
      artifacts: {},
    }, "package-qa-report.schema.json")).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("checks authored characters against the exact bundled caption face", () => {
    const font = inspectCaptionFontContract("sns-vertical-outline");
    expect(font.status).toBe("ready");
    expect(font.selected_asset).toBeDefined();

    const missing = findMissingFontGlyphs(
      font.selected_asset!.path,
      ["人の主体性", "🦄"],
    );

    expect(missing).not.toContain("主");
    expect(missing).toContain("🦄");
  });

  it("builds approval-grade evidence from canonical captions and CTA intent", () => {
    const approval: CaptionApproval = {
      version: "caption-source/v1",
      project_id: "layout-test",
      base_timeline_version: "timeline-v1",
      caption_policy: {
        language: "ja",
        delivery_mode: "burn_in",
        source: "transcript",
        styling_class: "sns-vertical-outline",
      },
      speech_captions: [{
        caption_id: "CAP_1",
        asset_id: "AST_1",
        segment_id: "SEG_1",
        timeline_in_frame: 0,
        timeline_duration_frames: 90,
        text: "人の主体性",
        transcript_ref: "TR_1",
        transcript_item_ids: ["T1"],
        source: "transcript",
        styling_class: "sns-vertical-outline",
        metrics: { cps: 4, dwell_ms: 3000 },
      }],
      text_overlays: [],
      approval: { status: "approved" },
    };
    const timeline = {
      sequence: {
        width: 1080,
        height: 1920,
        fps_num: 30,
        fps_den: 1,
      },
      tracks: {
        video: [{
          clips: [{
            clip_id: "V1",
            timeline_in_frame: 0,
            timeline_duration_frames: 150,
            media_kind: "video",
          }],
        }],
        overlay: [{
          clips: [{
            clip_id: "CTA_1",
            timeline_in_frame: 90,
            timeline_duration_frames: 60,
            content_element: {
              template_ref: "vos:content.cta-card/v1",
            },
          }],
        }],
      },
    };

    const snapshot = buildRenderLayoutSnapshot(timeline, approval);
    const result = evaluateDeterministicLayoutQA(snapshot);

    expect(snapshot.ending).toEqual({
      final_frame_state: "meaningful_end_card",
      end_card_layer_id: "CTA_1",
    });
    expect(result).toMatchObject({ status: "verified", issues: [] });
  });

  it("accepts an explicitly authored still without normalizing a video freeze", () => {
    const approval: CaptionApproval = {
      version: "caption-source/v1",
      project_id: "layout-still-test",
      base_timeline_version: "timeline-v1",
      caption_policy: {
        language: "ja",
        delivery_mode: "burn_in",
        source: "transcript",
        styling_class: "sns-vertical-outline",
      },
      speech_captions: [],
      text_overlays: [],
      approval: { status: "approved" },
    };
    const timeline = {
      sequence: {
        width: 1080,
        height: 1920,
        fps_num: 30,
        fps_den: 1,
      },
      tracks: {
        video: [{
          clips: [{
            clip_id: "V_STILL",
            timeline_in_frame: 0,
            timeline_duration_frames: 90,
            media_kind: "image",
          }],
        }],
      },
    };

    const snapshot = buildRenderLayoutSnapshot(timeline, approval);
    const result = evaluateDeterministicLayoutQA(snapshot);

    expect(snapshot.ending.final_frame_state).toBe("intentional_still");
    expect(result).toMatchObject({ status: "verified", issues: [] });
  });

  it("marks layout QA not applicable only for a canonical empty timeline", () => {
    const approval: CaptionApproval = {
      version: "caption-source/v1",
      project_id: "layout-empty-test",
      base_timeline_version: "timeline-v1",
      caption_policy: {
        language: "ja",
        delivery_mode: "burn_in",
        source: "none",
        styling_class: "clean-lower-third",
      },
      speech_captions: [],
      text_overlays: [],
      approval: { status: "approved" },
    };
    const timeline = {
      sequence: {
        width: 1920,
        height: 1080,
        fps_num: 24,
        fps_den: 1,
      },
      tracks: {
        video: [],
        overlay: [],
      },
    };

    const snapshot = buildRenderLayoutSnapshot(timeline, approval);
    const result = evaluateDeterministicLayoutQA(snapshot);

    expect(snapshot).toMatchObject({
      frame: { total_frames: 0 },
      layers: [],
      ending: { final_frame_state: "not_applicable" },
    });
    expect(result).toMatchObject({ status: "verified", issues: [] });

    const invalid = structuredClone(snapshot);
    invalid.frame.total_frames = 1;
    expect(evaluateDeterministicLayoutQA(invalid).issues).toEqual([
      expect.objectContaining({ code: "final_frame_state_invalid" }),
    ]);
  });
});
