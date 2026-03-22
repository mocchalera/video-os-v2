/**
 * Tests for runtime/pipeline/display-name.ts — display_name generation logic.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  monthAbbrev,
  summarizeToShortName,
  generateDisplayNames,
  type DisplayNameInput,
} from "../runtime/pipeline/display-name.js";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";

// ── Schema backward compatibility ──────────────────────────────────

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
  addSchema(schema: object): void;
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

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
  return ajv.compile(assetsSchema);
}

// ── Helpers ────────────────────────────────────────────────────────

function makeAsset(id: string): AssetItem {
  return {
    asset_id: id,
    filename: `${id}.MOV`,
    duration_us: 5_000_000,
    has_transcript: false,
    transcript_ref: null,
    segments: 0,
    segment_ids: [],
    quality_flags: [],
    tags: [],
    source_fingerprint: "abc123",
    contact_sheet_ids: [],
    analysis_status: "complete",
  };
}

function makeSegment(
  assetId: string,
  segId: string,
  summary: string,
  tags: string[],
): SegmentItem {
  return {
    segment_id: segId,
    asset_id: assetId,
    src_in_us: 0,
    src_out_us: 5_000_000,
    duration_us: 5_000_000,
    rep_frame_us: 2_500_000,
    summary,
    transcript_excerpt: "",
    quality_flags: [],
    tags,
    segment_type: "action",
    transcript_ref: null,
    confidence: {
      boundary: { score: 0.9, source: "ffmpeg", status: "ready" },
    },
    provenance: {
      boundary: {
        stage: "segment",
        method: "pyscenedetect",
        connector_version: "test",
        policy_hash: "test",
        request_hash: "test",
      },
    },
  };
}

// ── Unit: monthAbbrev ──────────────────────────────────────────────

describe("monthAbbrev", () => {
  it("returns correct month abbreviations", () => {
    expect(monthAbbrev(new Date("2024-01-15"))).toBe("jan");
    expect(monthAbbrev(new Date("2024-08-01"))).toBe("aug");
    expect(monthAbbrev(new Date("2024-12-31"))).toBe("dec");
  });
});

// ── Unit: summarizeToShortName ─────────────────────────────────────

describe("summarizeToShortName", () => {
  it("converts English summary to lower_snake_case", () => {
    const result = summarizeToShortName("First wobbly ride on bicycle", []);
    expect(result).toBe("first_wobbly");
  });

  it("truncates long summaries to 15 chars max", () => {
    const result = summarizeToShortName("A very long description that goes on and on", []);
    expect(result.length).toBeLessThanOrEqual(15);
  });

  it("avoids cutting mid-word when truncating", () => {
    const result = summarizeToShortName("confident pedaling through park", []);
    // Should cut at word boundary
    expect(result).not.toMatch(/_$/);
    expect(result.length).toBeLessThanOrEqual(15);
  });

  it("falls back to tags when summary is Japanese-only", () => {
    const result = summarizeToShortName("自転車に初めて乗る練習", ["bicycle", "practice", "first"]);
    // "bicycle_practice_first" → 22 chars → truncated at word boundary
    expect(result).toMatch(/^bicycle/);
    expect(result.length).toBeLessThanOrEqual(15);
  });

  it("falls back to 'clip' when no usable text", () => {
    const result = summarizeToShortName("日本語のみ", []);
    expect(result).toBe("clip");
  });

  it("handles empty summary and empty tags", () => {
    expect(summarizeToShortName("", [])).toBe("clip");
  });

  it("strips special characters", () => {
    const result = summarizeToShortName("kid's bike! @park #fun", []);
    // "kid_s_bike_park_fun" → 19 chars → truncated at word boundary
    expect(result).toBe("kid_s_bike");
    expect(result.length).toBeLessThanOrEqual(15);
  });

  it("collapses multiple spaces/underscores", () => {
    const result = summarizeToShortName("  ride   in   park  ", []);
    expect(result).toBe("ride_in_park");
  });
});

// ── Unit: generateDisplayNames ─────────────────────────────────────

describe("generateDisplayNames", () => {
  it("assigns serial numbers sorted by creation date", () => {
    // Create temp files with known modification times
    const tmpDir = path.join(import.meta.dirname, "_tmp_display_name_test");
    fs.mkdirSync(tmpDir, { recursive: true });

    const fileA = path.join(tmpDir, "file_a.txt");
    const fileB = path.join(tmpDir, "file_b.txt");
    fs.writeFileSync(fileA, "a");
    fs.writeFileSync(fileB, "b");

    try {
      const inputs: DisplayNameInput[] = [
        {
          asset: makeAsset("AST_BBB"),
          filePath: fileB,
          segments: [makeSegment("AST_BBB", "SEG_B1", "balance practice", ["balance"])],
        },
        {
          asset: makeAsset("AST_AAA"),
          filePath: fileA,
          segments: [makeSegment("AST_AAA", "SEG_A1", "first wobbly ride", ["bicycle"])],
        },
      ];

      const result = generateDisplayNames(inputs);

      expect(result.size).toBe(2);
      // Both files created nearly simultaneously, so order by asset_id tiebreak
      const names = [...result.values()];
      expect(names[0]).toMatch(/^01_/);
      expect(names[1]).toMatch(/^02_/);

      // Check short name derivation
      for (const name of names) {
        expect(name).toMatch(/^\d{2}_[a-z]{3}_[a-z0-9_]+$/);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("combines summaries from multiple segments per asset", () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_display_name_multi");
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, "clip.txt");
    fs.writeFileSync(file, "x");

    try {
      const inputs: DisplayNameInput[] = [
        {
          asset: makeAsset("AST_001"),
          filePath: file,
          segments: [
            makeSegment("AST_001", "SEG_1", "wobbly start", ["bicycle"]),
            makeSegment("AST_001", "SEG_2", "gaining confidence", ["ride"]),
          ],
        },
      ];

      const result = generateDisplayNames(inputs);
      const name = result.get("AST_001")!;
      expect(name).toMatch(/^01_/);
      // Combined summary should produce meaningful short name
      expect(name).toMatch(/^\d{2}_[a-z]{3}_[a-z0-9_]+$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles empty inputs", () => {
    const result = generateDisplayNames([]);
    expect(result.size).toBe(0);
  });

  it("uses 'clip' fallback for assets with no VLM summaries", () => {
    const tmpDir = path.join(import.meta.dirname, "_tmp_display_name_empty");
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, "empty.txt");
    fs.writeFileSync(file, "x");

    try {
      const inputs: DisplayNameInput[] = [
        {
          asset: makeAsset("AST_001"),
          filePath: file,
          segments: [makeSegment("AST_001", "SEG_1", "", [])],
        },
      ];

      const result = generateDisplayNames(inputs);
      const name = result.get("AST_001")!;
      expect(name).toMatch(/^01_[a-z]{3}_clip$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Schema backward compatibility ──────────────────────────────────

describe("assets schema backward compatibility", () => {
  const validate = createValidator();

  it("validates asset WITHOUT display_name (backward compat)", () => {
    const data = {
      project_id: "test",
      artifact_version: "2.0.0",
      items: [
        {
          asset_id: "AST_001",
          filename: "test.mp4",
          duration_us: 5000000,
          has_transcript: false,
          transcript_ref: null,
          segments: 0,
          segment_ids: [],
          quality_flags: [],
          tags: [],
        },
      ],
    };
    const valid = validate(data);
    expect(valid).toBe(true);
  });

  it("validates asset WITH display_name", () => {
    const data = {
      project_id: "test",
      artifact_version: "2.0.0",
      items: [
        {
          asset_id: "AST_001",
          filename: "test.mp4",
          display_name: "01_aug_first_wobbly_ride",
          duration_us: 5000000,
          has_transcript: false,
          transcript_ref: null,
          segments: 0,
          segment_ids: [],
          quality_flags: [],
          tags: [],
        },
      ],
    };
    const valid = validate(data);
    expect(valid).toBe(true);
  });

  it("rejects non-string display_name", () => {
    const data = {
      project_id: "test",
      artifact_version: "2.0.0",
      items: [
        {
          asset_id: "AST_001",
          filename: "test.mp4",
          display_name: 42,
          duration_us: 5000000,
          has_transcript: false,
          transcript_ref: null,
          segments: 0,
          segment_ids: [],
          quality_flags: [],
          tags: [],
        },
      ],
    };
    const valid = validate(data);
    expect(valid).toBe(false);
  });
});
