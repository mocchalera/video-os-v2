import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { writePreviewManifest } from "../runtime/compiler/export.js";
import {
  createMediaLinks,
  loadSourceMap,
  toSafeMediaBasename,
} from "../runtime/media/source-map.js";
import { parseArgs } from "../scripts/analyze.js";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempProject(name: string): string {
  const tmpDir = path.resolve(`tests/tmp_source_map_${name}_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  tempDirs.push(tmpDir);
  return tmpDir;
}

function makeAsset(
  assetId: string,
  filename: string,
  displayName: string,
): AssetItem {
  return {
    asset_id: assetId,
    filename,
    display_name: displayName,
    duration_us: 5_000_000,
    has_transcript: false,
    transcript_ref: null,
    segments: 1,
    segment_ids: [`SEG_${assetId}_0001`],
    quality_flags: [],
    tags: [],
    source_fingerprint: `${assetId.toLowerCase()}_fingerprint`,
    contact_sheet_ids: [],
    analysis_status: "complete",
  };
}

function createValidator() {
  const schemaPath = path.resolve("schemas/source-map.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function makeTimeline(): TimelineIR {
  return {
    version: "1",
    project_id: "test-project",
    created_at: "2026-03-22T00:00:00Z",
    sequence: {
      name: "Preview Manifest Test",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [
        {
          track_id: "V1",
          kind: "video",
          clips: [
            {
              clip_id: "CLP_001",
              segment_id: "SEG_AST_001_0001",
              asset_id: "AST_001",
              src_in_us: 0,
              src_out_us: 2_000_000,
              timeline_in_frame: 0,
              timeline_duration_frames: 48,
              role: "hero",
              motivation: "test",
              beat_id: "b01",
              fallback_segment_ids: [],
              confidence: 1,
              quality_flags: [],
            },
          ],
        },
      ],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

describe("toSafeMediaBasename", () => {
  it("converts existing display_name style to hyphenated safe filenames", () => {
    expect(toSafeMediaBasename("01_jul_a_child_practicing_bicycle")).toBe(
      "01-jul-a-child-practicing-bicycle",
    );
  });

  it("preserves Japanese letters while removing unsafe punctuation", () => {
    expect(toSafeMediaBasename("初めて の 自転車 練習!")).toBe("初めて-の-自転車-練習");
  });
});

describe("createMediaLinks", () => {
  it("creates symlinks, adds duplicate suffixes, and writes source_map.json", () => {
    const projectDir = createTempProject("links");
    const sourceA = path.join(projectDir, "IMG_0001.MOV");
    const sourceB = path.join(projectDir, "IMG_0002.MOV");
    fs.writeFileSync(sourceA, "a");
    fs.writeFileSync(sourceB, "b");

    const result = createMediaLinks({
      projectPath: projectDir,
      projectId: "test-project",
      assets: [
        makeAsset("AST_001", "IMG_0001.MOV", "01_jul_a_child_practicing_bicycle"),
        makeAsset("AST_002", "IMG_0002.MOV", "01_jul_a_child_practicing_bicycle"),
      ],
      sourceFileMap: new Map([
        ["AST_001", sourceA],
        ["AST_002", sourceB],
      ]),
      generatedAt: "2026-03-22T00:00:00Z",
    });

    expect(result.doc.items).toHaveLength(2);
    expect(result.doc.items[0].link_path).toBe(
      "02_media/01-jul-a-child-practicing-bicycle.mov",
    );
    expect(result.doc.items[1].link_path).toBe(
      "02_media/01-jul-a-child-practicing-bicycle-2.mov",
    );

    const firstLink = path.join(projectDir, result.doc.items[0].link_path);
    const secondLink = path.join(projectDir, result.doc.items[1].link_path);
    expect(fs.lstatSync(firstLink).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(secondLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(firstLink)).toBe(sourceA);
    expect(fs.readlinkSync(secondLink)).toBe(sourceB);

    const onDisk = JSON.parse(fs.readFileSync(result.sourceMapPath, "utf-8"));
    expect(onDisk.items).toHaveLength(2);
  });
});

describe("source-map schema", () => {
  const validate = createValidator();

  it("validates generated source_map.json", () => {
    const projectDir = createTempProject("schema");
    const source = path.join(projectDir, "IMG_0001.MOV");
    fs.writeFileSync(source, "a");

    const result = createMediaLinks({
      projectPath: projectDir,
      projectId: "test-project",
      assets: [makeAsset("AST_001", "IMG_0001.MOV", "01_jul_a_child_practicing_bicycle")],
      sourceFileMap: new Map([["AST_001", source]]),
      generatedAt: "2026-03-22T00:00:00Z",
    });

    const valid = validate(result.doc);
    if (!valid) {
      console.error(validate.errors);
    }
    expect(valid).toBe(true);
  });
});

describe("loadSourceMap", () => {
  it("loads generated source_map.json into asset locator maps", () => {
    const projectDir = createTempProject("loader");
    const source = path.join(projectDir, "IMG_0001.MOV");
    fs.writeFileSync(source, "a");

    const result = createMediaLinks({
      projectPath: projectDir,
      projectId: "test-project",
      assets: [makeAsset("AST_001", "IMG_0001.MOV", "01_jul_a_child_practicing_bicycle")],
      sourceFileMap: new Map([["AST_001", source]]),
      generatedAt: "2026-03-22T00:00:00Z",
    });

    const loaded = loadSourceMap(projectDir);
    expect(loaded.locatorMap.get("AST_001")).toBe(
      path.join(projectDir, result.doc.items[0].link_path),
    );
    expect(loaded.entryMap.get("AST_001")?.local_source_path).toBe(source);
  });

  it("accepts legacy asset_id to path object maps", () => {
    const projectDir = createTempProject("legacy");
    const legacyMapPath = path.join(projectDir, "legacy-source-map.json");
    fs.writeFileSync(
      legacyMapPath,
      JSON.stringify({ AST_001: "/tmp/source-a.mov" }, null, 2),
      "utf-8",
    );

    const loaded = loadSourceMap(projectDir, legacyMapPath);
    expect(loaded.locatorMap.get("AST_001")).toBe("/tmp/source-a.mov");
  });
});

describe("writePreviewManifest", () => {
  it("includes 02_media locators when source_map.json is available", () => {
    const projectDir = createTempProject("preview");
    const source = path.join(projectDir, "IMG_0001.MOV");
    fs.writeFileSync(source, "a");

    createMediaLinks({
      projectPath: projectDir,
      projectId: "test-project",
      assets: [makeAsset("AST_001", "IMG_0001.MOV", "01_jul_a_child_practicing_bicycle")],
      sourceFileMap: new Map([["AST_001", source]]),
      generatedAt: "2026-03-22T00:00:00Z",
    });

    const manifestPath = writePreviewManifest(
      makeTimeline(),
      projectDir,
      loadSourceMap(projectDir),
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    expect(manifest.clips[0].source_locator).toContain("/02_media/");
    expect(manifest.clips[0].media_link_path).toBe(
      "02_media/01-jul-a-child-practicing-bicycle.mov",
    );
    expect(manifest.clips[0].local_source_path).toBe(source);
  });
});

describe("analyze parseArgs", () => {
  it("parses --skip-media-link", () => {
    const parsed = parseArgs([
      "node",
      "scripts/analyze.ts",
      "clip.mov",
      "--project",
      "projects/test",
      "--skip-media-link",
    ]);
    expect(parsed.skipMediaLink).toBe(true);
  });

  it("parses --concurrency", () => {
    const parsed = parseArgs([
      "node",
      "scripts/analyze.ts",
      "clip.mov",
      "--project",
      "projects/test",
      "--concurrency",
      "5",
    ]);
    expect(parsed.concurrency).toBe(5);
  });
});
