import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import {
  DEFAULT_APPRAISER_MODEL,
  buildAppraiserPrompt,
  normalizeAppraiserResult,
  parseAppraiserJson,
} from "../runtime/connectors/gemini-appraiser.js";
import {
  extractAppraiserFrame,
  runAppraiserStage,
  type AppraiserFn,
  type ExecFileLike,
} from "../runtime/pipeline/stages/appraiser.js";
import type { SegmentsJson } from "../runtime/pipeline/pipeline-types.js";
import { parseArgs } from "../scripts/analyze.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-appraiser-"));
  tempDirs.push(dir);
  return dir;
}

function makeSegment(overrides: Partial<SegmentItem> = {}): SegmentItem {
  return {
    segment_id: "SEG_0001",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 3_000_000,
    duration_us: 3_000_000,
    rep_frame_us: 1_250_000,
    summary: "Marlin: a sign stands beside a gorge overlook.",
    transcript_excerpt: "",
    quality_flags: [],
    tags: [],
    segment_type: "general",
    transcript_ref: null,
    confidence: {
      boundary: { score: 1, source: "test", status: "ready" },
    },
    provenance: {
      boundary: {
        stage: "segment",
        method: "test",
        connector_version: "test",
        policy_hash: "policy",
        request_hash: "request",
      },
    },
    ...overrides,
  };
}

function createWritingFfmpegMock(calls: string[][]): ExecFileLike {
  return (_command, args, _options, callback) => {
    calls.push(args);
    const outputPath = args[args.length - 1];
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "jpeg");
    callback(null, "", "");
  };
}

function successfulAppraiser(): AppraiserFn {
  return async () => ({
    visual_quality: {
      composition_score: 0.82,
      light_quality: 0.71,
      focus_sharpness: 0.91,
      subject_prominence: 0.64,
    },
    extracted_text: [
      { text: "Ena Gorge", language: "en", confidence: 0.93 },
    ],
    place_hint: {
      name: "Ena Gorge",
      category: "natural_landmark",
      confidence: 0.84,
      evidence: ["visible sign"],
    },
    aesthetic_notes: ["strong leading lines"],
  });
}

describe("Gemini appraiser connector", () => {
  it("defaults to Gemini Flash, not Flash Lite", () => {
    expect(DEFAULT_APPRAISER_MODEL).toBe("gemini-2.5-flash");
  });

  it("builds a prompt that includes Marlin scene context and forbids scene rewriting", () => {
    const prompt = buildAppraiserPrompt("Marlin reports a shrine gate at dusk.");

    expect(prompt).toContain("Marlin reports a shrine gate at dusk.");
    expect(prompt).toContain("Visual quality");
    expect(prompt).toContain("Text/signage");
    expect(prompt).toContain("Place identification");
    expect(prompt).toContain("Do not describe the scene or rewrite the segment summary.");
  });

  it("parses and normalizes appraiser JSON", () => {
    const parsed = parseAppraiserJson(`\`\`\`json
{
  "visual_quality": {
    "composition_score": 1.5,
    "light_quality": -1,
    "focus_sharpness": 0.8,
    "subject_prominence": 0.4
  },
  "extracted_text": [
    { "text": "  恵那峡  ", "language": "", "confidence": 2 },
    { "text": "   ", "language": "ja", "confidence": 0.5 }
  ],
  "place_hint": {
    "name": "",
    "category": "Natural Landmark",
    "confidence": -0.2,
    "evidence": [" sign ", "sign"]
  },
  "aesthetic_notes": ["golden light", "leading lines", "clear sign", "extra note"]
}
\`\`\``);
    const result = normalizeAppraiserResult(parsed);

    expect(result.visual_quality).toEqual({
      composition_score: 1,
      light_quality: 0,
      focus_sharpness: 0.8,
      subject_prominence: 0.4,
    });
    expect(result.extracted_text).toEqual([
      { text: "恵那峡", language: "unknown", confidence: 1 },
    ]);
    expect(result.place_hint).toEqual({
      name: null,
      category: "natural_landmark",
      confidence: 0,
      evidence: ["sign"],
    });
    expect(result.aesthetic_notes).toEqual(["golden light", "leading lines", "clear sign"]);
  });
});

describe("Appraiser frame extraction", () => {
  it("extracts rep_frame_us with ffmpeg and reuses a matching cached frame", async () => {
    const projectDir = makeTempDir();
    const sourcePath = path.join(projectDir, "source.mp4");
    fs.writeFileSync(sourcePath, "source");
    const outputDir = path.join(projectDir, "03_analysis");
    const calls: string[][] = [];
    const ffmpegMock = createWritingFfmpegMock(calls);

    const first = await extractAppraiserFrame({
      segment: makeSegment(),
      sourcePath,
      outputDir,
      execFileImpl: ffmpegMock,
      now: () => "2026-06-18T00:00:00.000Z",
    });
    const second = await extractAppraiserFrame({
      segment: makeSegment(),
      sourcePath,
      outputDir,
      execFileImpl: () => {
        throw new Error("ffmpeg should not be called for cached frame");
      },
    });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(first.frameRelPath).toBe("appraiser_frames/SEG_0001.jpg");
    expect(fs.existsSync(first.framePath)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "-ss",
      "1.25",
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      first.framePath,
    ]);
  });
});

describe("Appraiser pipeline stage", () => {
  it("writes visual_appraisal and updates canonical visual_quality without changing summary", async () => {
    const projectDir = makeTempDir();
    const sourcePath = path.join(projectDir, "source.mp4");
    fs.writeFileSync(sourcePath, "source");
    const outputDir = path.join(projectDir, "03_analysis");
    const segmentsPath = path.join(outputDir, "segments.json");
    const calls: string[][] = [];
    const segment = makeSegment() as SegmentItem & {
      visual_quality?: {
        scores: {
          light_quality: number;
          subject_prominence: number;
          emotional_expression: number;
          composition_score: number;
          motion_quality: number;
        };
        labels: {
          lighting_style: string[];
          composition_tags: string[];
          expression_tags: string[];
          motion_tags: string[];
        };
      };
      visual_appraisal?: unknown;
    };
    segment.visual_quality = {
      scores: {
        light_quality: 0.2,
        subject_prominence: 0.2,
        emotional_expression: 0.77,
        composition_score: 0.2,
        motion_quality: 0.2,
      },
      labels: {
        lighting_style: ["backlit"],
        composition_tags: ["wide"],
        expression_tags: [],
        motion_tags: ["steady"],
      },
    };
    const segmentsJson: SegmentsJson = {
      project_id: "appraiser-test",
      artifact_version: "2.0.0",
      items: [segment],
    };

    const summary = await runAppraiserStage({
      segmentsJson,
      sourceFileMap: new Map([["AST_001", sourcePath]]),
      outputDir,
      segmentsOutputPath: segmentsPath,
      policyHash: "policyhash",
      appraiserFn: successfulAppraiser(),
      execFileImpl: createWritingFfmpegMock(calls),
    });

    expect(summary.appraisedSegments).toBe(1);
    expect(calls).toHaveLength(1);
    expect(segment.summary).toBe("Marlin: a sign stands beside a gorge overlook.");
    expect(segment.visual_appraisal).toMatchObject({
      frame_us: 1_250_000,
      frame_path: "appraiser_frames/SEG_0001.jpg",
      extracted_text: [{ text: "Ena Gorge", language: "en", confidence: 0.93 }],
      place_hint: { name: "Ena Gorge", category: "natural_landmark", confidence: 0.84 },
      aesthetic_notes: ["strong leading lines"],
    });
    expect(segment.visual_quality?.scores).toEqual({
      light_quality: 0.71,
      subject_prominence: 0.64,
      emotional_expression: 0.77,
      composition_score: 0.82,
      motion_quality: 0.91,
    });
    const confidence = segment.confidence as Record<string, { source: string }>;
    const provenance = segment.provenance as Record<string, { stage?: string; method?: string }>;
    expect(confidence.visual_appraisal?.source).toBe("gemini-2.5-flash");
    expect(provenance.visual_appraisal?.stage).toBe("appraiser");
    expect(provenance.visual_quality?.method).toBe("gemini_single_frame_appraisal");
    expect(fs.existsSync(segmentsPath)).toBe(true);
  });

  it("honors --skip-appraiser and does not call ffmpeg or Gemini", async () => {
    const parsed = parseArgs([
      "node",
      "scripts/analyze.ts",
      "clip.mov",
      "--project",
      "projects/test",
      "--skip-appraiser",
    ]);
    expect(parsed.skipAppraiser).toBe(true);

    const projectDir = makeTempDir();
    const sourcePath = path.join(projectDir, "source.mp4");
    fs.writeFileSync(sourcePath, "source");
    const segmentsJson: SegmentsJson = {
      project_id: "appraiser-test",
      artifact_version: "2.0.0",
      items: [makeSegment()],
    };
    let appraiserCalled = false;
    const summary = await runAppraiserStage({
      segmentsJson,
      sourceFileMap: new Map([["AST_001", sourcePath]]),
      outputDir: path.join(projectDir, "03_analysis"),
      segmentsOutputPath: path.join(projectDir, "03_analysis/segments.json"),
      policyHash: "policyhash",
      skip: true,
      appraiserFn: async () => {
        appraiserCalled = true;
        return successfulAppraiser()("", "");
      },
      execFileImpl: () => {
        throw new Error("ffmpeg should not be called");
      },
    });

    expect(summary.skippedSegments).toBe(1);
    expect(appraiserCalled).toBe(false);
  });

  it("skips gracefully without GEMINI_API_KEY", async () => {
    const previousKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const projectDir = makeTempDir();
      const sourcePath = path.join(projectDir, "source.mp4");
      fs.writeFileSync(sourcePath, "source");
      const segment = makeSegment() as SegmentItem & { visual_appraisal?: unknown };
      const segmentsJson: SegmentsJson = {
        project_id: "appraiser-test",
        artifact_version: "2.0.0",
        items: [segment],
      };

      const summary = await runAppraiserStage({
        segmentsJson,
        sourceFileMap: new Map([["AST_001", sourcePath]]),
        outputDir: path.join(projectDir, "03_analysis"),
        segmentsOutputPath: path.join(projectDir, "03_analysis/segments.json"),
        policyHash: "policyhash",
        execFileImpl: () => {
          throw new Error("ffmpeg should not be called without an API key");
        },
      });

      expect(summary.skippedNoApiKey).toBe(true);
      expect(summary.skippedSegments).toBe(1);
      expect(segment.visual_appraisal).toBeUndefined();
    } finally {
      if (previousKey === undefined) {
        delete process.env.GEMINI_API_KEY;
      } else {
        process.env.GEMINI_API_KEY = previousKey;
      }
    }
  });
});
