import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import type { AssetsJson } from "../runtime/pipeline/pipeline-types.js";
import { restoreSourceFileMap } from "../runtime/pipeline/source-file-map.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function tempProject(label: string): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `source-file-map-${label}-`));
  tempDirs.push(projectDir);
  return projectDir;
}

function touch(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, filePath);
  return filePath;
}

function assetsJson(overrides: Partial<AssetItem>): AssetsJson {
  return {
    project_id: "source-file-map-test",
    artifact_version: "1",
    items: [{
      asset_id: "AST_001",
      filename: "clip.mov",
      duration_us: 1_000_000,
      has_transcript: false,
      transcript_ref: null,
      segments: 1,
      segment_ids: ["SEG_AST_001_0001"],
      quality_flags: [],
      tags: [],
      source_fingerprint: "source-file-map-test",
      contact_sheet_ids: [],
      analysis_status: "complete",
      ...overrides,
    }],
  };
}

function writeSourceMap(
  projectDir: string,
  localSourcePath: string,
  sourceLocator: string,
): void {
  const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");
  fs.mkdirSync(path.dirname(sourceMapPath), { recursive: true });
  fs.writeFileSync(sourceMapPath, JSON.stringify({
    version: "1",
    project_id: "source-file-map-test",
    media_dir: "02_media",
    generated_at: "2026-07-22T00:00:00.000Z",
    items: [{
      asset_id: "AST_001",
      source_locator: sourceLocator,
      local_source_path: localSourcePath,
      link_path: "02_media/clip.mov",
    }],
  }));
}

describe("restoreSourceFileMap", () => {
  it("uses the first existing candidate in the persisted-to-layout priority order", () => {
    const projectDir = tempProject("priority");
    const mapLocal = touch(path.join(projectDir, "candidates", "map-local.mov"));
    const mapLocator = touch(path.join(projectDir, "candidates", "map-locator.mov"));
    const assetLocator = touch(path.join(projectDir, "candidates", "asset-locator.mov"));
    const sequenceProxy = touch(path.join(projectDir, "03_analysis", "sequence", "proxy.mov"));
    const inputBasename = touch(path.join(projectDir, "external", "clip.mov"));
    const projectRoot = touch(path.join(projectDir, "clip.mov"));
    const sourcesFallback = touch(path.join(projectDir, "00_sources", "clip.mov"));
    const mediaFallback = touch(path.join(projectDir, "02_media", "clip.mov"));
    writeSourceMap(projectDir, mapLocal, mapLocator);
    const assets = assetsJson({
      source_locator: assetLocator,
      image_sequence: {
        analysis_proxy_path: "sequence/proxy.mov",
      } as AssetItem["image_sequence"],
    });
    const candidates = [
      mapLocal,
      mapLocator,
      assetLocator,
      sequenceProxy,
      inputBasename,
      projectRoot,
      sourcesFallback,
      mediaFallback,
    ];

    for (const [index, expected] of candidates.entries()) {
      expect(restoreSourceFileMap(projectDir, assets, [inputBasename]).get("AST_001")).toBe(expected);
      if (index < candidates.length - 1) fs.rmSync(expected);
    }
  });

  it("returns the first candidate and warns when no candidate exists", () => {
    const projectDir = tempProject("missing");
    const missingLocal = path.join(projectDir, "missing", "source.mov");
    const missingLocator = path.join(projectDir, "missing", "locator.mov");
    writeSourceMap(projectDir, missingLocal, missingLocator);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = restoreSourceFileMap(projectDir, assetsJson({}), []);

    expect(result.get("AST_001")).toBe(missingLocal);
    expect(warn).toHaveBeenCalledWith(
      "[pipeline] --vlm-only: source file not found for AST_001; source-dependent fallbacks may be skipped",
    );
  });
});
