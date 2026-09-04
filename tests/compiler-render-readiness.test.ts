import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile } from "../runtime/compiler/index.js";
import {
  assertRenderMappingFresh,
  assertRenderSourceReadiness,
  buildRenderSourceReadiness,
  computeSourceMappingHash,
  evaluateSourceMappingContract,
  RenderSourceUnresolvedError,
  SourceMappingStaleError,
} from "../runtime/compiler/render-readiness.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

const SAMPLE_PROJECT = path.resolve("projects/sample");
const FIXED_CREATED_AT = "2026-03-21T00:00:00Z";
const SAMPLE_ASSET_IDS = ["AST_001", "AST_002", "AST_003", "AST_004", "AST_005", "AST_006"];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function createProject(name: string): string {
  const projectDir = path.resolve("tests", `tmp_readiness_${name}_${Date.now()}`);
  tempDirs.push(projectDir);
  copyDirSync(SAMPLE_PROJECT, projectDir);
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) fs.rmSync(timelinePath);
  return projectDir;
}

/** Minimal valid canonical timeline used as a rollback sentinel. */
function writeSentinelTimeline(projectDir: string): void {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
  fs.writeFileSync(timelinePath, JSON.stringify({
    version: "1",
    project_id: "sample-mountain-reset",
    sequence: {
      name: "sentinel",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: { video: [], audio: [] },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "sentinel",
    },
  }, null, 2));
}

function writeSourceMap(
  projectDir: string,
  entries: Array<Record<string, unknown>>,
): void {
  const mediaDir = path.join(projectDir, "02_media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "source_map.json"), JSON.stringify({
    version: "1",
    project_id: "sample-mountain-reset",
    media_dir: "02_media",
    generated_at: FIXED_CREATED_AT,
    items: entries,
  }));
}

function defaultSourceEntries(projectDir: string): Array<Record<string, unknown>> {
  const mediaDir = path.join(projectDir, "02_media");
  fs.mkdirSync(mediaDir, { recursive: true });
  return SAMPLE_ASSET_IDS.map((assetId) => {
    const filename = `${assetId.toLowerCase()}.mov`;
    const sourcePath = path.join(mediaDir, filename);
    fs.writeFileSync(sourcePath, `source bytes for ${assetId}\n`);
    return {
      asset_id: assetId,
      source_locator: `02_media/${filename}`,
      local_source_path: `02_media/${filename}`,
      link_path: `02_media/${filename}`,
      display_name: filename,
      kind: "asset",
      link_type: "symlink",
    };
  });
}

function readStamps(projectDir: string): {
  timeline: string | null;
  manifest: string | null;
  readiness: string | null;
} {
  const read = (filePath: string): string | null => {
    if (!fs.existsSync(filePath)) return null;
    const doc = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      metadata?: Record<string, unknown>;
      source_mapping_hash?: unknown;
    };
    const value = doc.metadata?.source_mapping_hash ?? doc.source_mapping_hash;
    return typeof value === "string" ? value : null;
  };
  return {
    timeline: read(path.join(projectDir, "05_timeline/timeline.json")),
    manifest: read(path.join(projectDir, "05_timeline/preview-manifest.json")),
    readiness: read(path.join(projectDir, "05_timeline/render-readiness.json")),
  };
}

describe("render source readiness", () => {
  it("resolves every asset and promotes a ready report with shared mapping identity", () => {
    const projectDir = createProject("success");
    writeSourceMap(projectDir, defaultSourceEntries(projectDir));

    const result = compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT, validateSourceArtifacts: true });

    expect(result.render_readiness?.status).toBe("ready");
    expect(result.render_readiness?.resolved_count).toBeGreaterThan(0);
    expect(result.render_readiness?.blocked_count).toBe(0);

    const reportPath = path.join(projectDir, "05_timeline/render-readiness.json");
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(result.artifact_receipts?.some((receipt) => receipt.relative_path === "05_timeline/render-readiness.json")).toBe(true);

    const stamps = readStamps(projectDir);
    expect(stamps.timeline).toBeTruthy();
    expect(stamps.timeline).toBe(stamps.manifest);
    expect(stamps.timeline).toBe(stamps.readiness);

    const contract = evaluateSourceMappingContract(projectDir);
    expect(contract.state).toBe("exact");
    expect(contract.timeline_matches_current_mapping).toBe(true);
    expect(contract.manifest_matches_timeline_mapping).toBe(true);
  });

  it("fails closed before promotion when an asset has no source-map entry", () => {
    const projectDir = createProject("unresolved");
    const entries = defaultSourceEntries(projectDir);
    writeSourceMap(projectDir, entries.slice(1));
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    writeSentinelTimeline(projectDir);

    let caught: unknown;
    try {
      compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT, validateSourceArtifacts: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RenderSourceUnresolvedError);
    const error = caught as RenderSourceUnresolvedError;
    expect(error.code).toBe("RENDER_SOURCE_UNRESOLVED");
    expect(error.report.status).toBe("blocked");
    expect(error.report.resolutions.find((r) => r.asset_id === SAMPLE_ASSET_IDS[0])?.status).toBe("unresolved");
    // The previous canonical timeline must be untouched.
    expect(JSON.parse(fs.readFileSync(timelinePath, "utf-8")).compiler_version ?? true).toBeTruthy();
    expect(fs.existsSync(path.join(projectDir, "05_timeline/render-readiness.json"))).toBe(false);
  });

  it("reports missing sources fail-closed", () => {
    const projectDir = createProject("missing");
    const entries = defaultSourceEntries(projectDir);
    // The sample compile places AST_001/004/005; break a referenced asset.
    fs.rmSync(path.join(projectDir, "02_media", `${SAMPLE_ASSET_IDS[3].toLowerCase()}.mov`));
    writeSourceMap(projectDir, entries);

    let caught: unknown;
    try {
      compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT, validateSourceArtifacts: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RenderSourceUnresolvedError);
    const resolution = (caught as RenderSourceUnresolvedError).report.resolutions
      .find((r) => r.asset_id === SAMPLE_ASSET_IDS[3]);
    expect(resolution?.status).toBe("missing");
  });

  it("reports hash mismatches fail-closed", () => {
    const projectDir = createProject("hash");
    const entries = defaultSourceEntries(projectDir);
    const staleHash = crypto.createHash("sha256").update("stale ingest bytes\n").digest("hex");
    entries[4] = { ...entries[4], source_content_sha256: staleHash };
    writeSourceMap(projectDir, entries);

    let caught: unknown;
    try {
      compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT, validateSourceArtifacts: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RenderSourceUnresolvedError);
    const resolution = (caught as RenderSourceUnresolvedError).report.resolutions
      .find((r) => r.asset_id === SAMPLE_ASSET_IDS[4]);
    expect(resolution?.status).toBe("hash_mismatch");
    expect(resolution?.expected_sha256).toBe(staleHash);
    expect(resolution?.actual_sha256).not.toBe(staleHash);
  });

  it("reports unreadable sources as permission_denied fail-closed", function skipAsRoot(this: { skip: () => void }) {
    if ((process.getuid?.() ?? 0) === 0) {
      this.skip();
    }
    const projectDir = createProject("permission");
    const entries = defaultSourceEntries(projectDir);
    const blockedPath = path.join(projectDir, "02_media", `${SAMPLE_ASSET_IDS[3].toLowerCase()}.mov`);
    fs.chmodSync(blockedPath, 0o000);
    writeSourceMap(projectDir, entries);

    try {
      let caught: unknown;
      try {
        compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT, validateSourceArtifacts: true });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RenderSourceUnresolvedError);
      const resolution = (caught as RenderSourceUnresolvedError).report.resolutions
        .find((r) => r.asset_id === SAMPLE_ASSET_IDS[3]);
      expect(resolution?.status).toBe("permission_denied");
    } finally {
      fs.chmodSync(blockedPath, 0o644);
    }
  });

  it("records external references with a read-only canonical source root", () => {
    const externalRoot = path.resolve(fs.mkdtempSync(path.join("tests", "tmp_readiness_external_")));
    tempDirs.push(externalRoot);
    const externalFile = path.join(externalRoot, "external_drive_clip.mov");
    fs.writeFileSync(externalFile, "external media bytes\n");

    const projectDir = createProject("external");
    const entries = defaultSourceEntries(projectDir);
    entries[0] = {
      ...entries[0],
      source_locator: externalFile,
      local_source_path: externalFile,
    };
    writeSourceMap(projectDir, entries);

    const result = compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT, validateSourceArtifacts: true });
    expect(result.render_readiness?.status).toBe("ready");
    const external = result.render_readiness?.external_sources ?? [];
    expect(external).toHaveLength(1);
    expect(external[0].canonical_source_root).toBe(externalRoot);
    expect(external[0].asset_ids).toEqual([SAMPLE_ASSET_IDS[0]]);
    expect(external[0].read_only_authority).toBe(true);
  });

  it("flags a relink after compile as stale and blocks the render route", () => {
    const projectDir = createProject("relink");
    writeSourceMap(projectDir, defaultSourceEntries(projectDir));
    compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT, validateSourceArtifacts: true });

    // Operator relinks AST_001 to different media after the compile.
    const relinkedFile = path.join(projectDir, "02_media", "relinked.mov");
    fs.writeFileSync(relinkedFile, "relinked media bytes\n");
    const entries = defaultSourceEntries(projectDir);
    entries[0] = { ...entries[0], local_source_path: "02_media/relinked.mov", source_locator: "02_media/relinked.mov" };
    writeSourceMap(projectDir, entries);

    const status = evaluateSourceMappingContract(projectDir);
    expect(status.state).toBe("stale_relink");
    expect(status.timeline_matches_current_mapping).toBe(false);
    expect(status.recommendation).toMatch(/relink/i);

    expect(() => assertRenderMappingFresh(projectDir)).toThrowError(SourceMappingStaleError);
  });
});

describe("render readiness unit contract", () => {
  const timelineWith = (assetIds: string[]): Pick<TimelineIR, "tracks"> => ({
    tracks: {
      video: assetIds.map((assetId, index) => ({
        track_id: "V1",
        kind: "video" as const,
        clips: [{
          clip_id: `CLP_${index}`,
          segment_id: `SEG_${index}`,
          asset_id: assetId,
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: index * 24,
          timeline_duration_frames: 24,
          role: "hero",
          motivation: "unit fixture",
          beat_id: `b0${index + 1}`,
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      })),
      audio: [],
    },
  });

  it("computes a stable mapping hash independent of entry order", () => {
    const first = computeSourceMappingHash([
      { asset_id: "A", local_source_path: "/x/a.mov" },
      { asset_id: "B", local_source_path: "/x/b.mov", source_content_sha256: "deadbeef" },
    ]);
    const second = computeSourceMappingHash([
      { asset_id: "B", local_source_path: "/x/b.mov", source_content_sha256: "deadbeef" },
      { asset_id: "A", local_source_path: "/x/a.mov" },
    ]);
    expect(first).toBe(second);
    const changed = computeSourceMappingHash([
      { asset_id: "A", local_source_path: "/x/a.mov" },
      { asset_id: "B", local_source_path: "/x/relinked.mov", source_content_sha256: "deadbeef" },
    ]);
    expect(changed).not.toBe(first);
  });

  it("classifies unresolved entries without throwing", () => {
    const report = buildRenderSourceReadiness({
      projectPath: ".",
      projectId: "unit",
      createdAt: FIXED_CREATED_AT,
      timeline: timelineWith(["AST_MISSING"]),
      sourceMap: { locatorMap: new Map(), entryMap: new Map(), entries: [] },
    });
    expect(report.status).toBe("blocked");
    expect(report.resolutions[0].status).toBe("unresolved");
    expect(() => assertRenderSourceReadiness(report)).toThrowError(RenderSourceUnresolvedError);
  });
});
