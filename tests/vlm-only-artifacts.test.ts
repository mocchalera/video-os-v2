import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ContactSheetManifest } from "../runtime/connectors/ffmpeg-derivatives.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import { computeCacheHash, type CacheManifestEntry } from "../runtime/pipeline/analysis-cache.js";
import type { AssetsJson, SegmentsJson } from "../runtime/pipeline/pipeline-types.js";
import {
  buildManifestEntriesFromExistingAssets,
  loadExistingDerivativeResults,
  preserveVlmOnlySegmentFields,
} from "../runtime/pipeline/analysis-artifact-restoration.js";
import { SourceContentIdentityCache } from "../runtime/source-content-identity.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vlm-only-artifacts-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function write(filePath: string, content = filePath): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function asset(assetId: string, overrides: Partial<AssetItem> = {}): AssetItem {
  return {
    asset_id: assetId,
    filename: `${assetId}.mov`,
    duration_us: 1_000_000,
    has_transcript: false,
    transcript_ref: null,
    segments: 1,
    segment_ids: [`SEG_${assetId}_001`],
    quality_flags: [],
    tags: [],
    source_fingerprint: `${assetId}-fingerprint`,
    contact_sheet_ids: [],
    analysis_status: "complete",
    ...overrides,
  };
}

function segment(
  segmentId: string,
  assetId: string,
  overrides: Partial<SegmentItem> = {},
): SegmentItem {
  return {
    segment_id: segmentId,
    asset_id: assetId,
    src_in_us: 0,
    src_out_us: 1_000_000,
    duration_us: 1_000_000,
    rep_frame_us: 500_000,
    summary: "original summary",
    transcript_excerpt: "original transcript",
    quality_flags: [],
    tags: ["original"],
    segment_type: "shot",
    transcript_ref: null,
    confidence: {
      boundary: { score: 1, source: "segmenter", status: "complete" },
    },
    provenance: {
      boundary: {
        stage: "segment",
        method: "test",
        connector_version: "1",
        policy_hash: "policy",
        request_hash: "request",
      },
    },
    ...overrides,
  };
}

describe("loadExistingDerivativeResults", () => {
  it("restores only derivative files that still exist", () => {
    const outputDir = tempDir("derivatives");
    const contactSheet: ContactSheetManifest = {
      contact_sheet_id: "CS_AST_001_01",
      asset_id: "AST_001",
      image_path: "contact_sheets/CS_AST_001_01.png",
      mode: "shot_keyframes",
      tile_map: [],
    };
    write(path.join(outputDir, "contact_sheets", "CS_AST_001_01.json"), JSON.stringify(contactSheet));
    write(path.join(outputDir, contactSheet.image_path));
    write(path.join(outputDir, "posters/AST_001.jpg"));
    write(path.join(outputDir, "waveforms/AST_001.png"));
    write(path.join(outputDir, "filmstrips/SEG_AST_001_001.jpg"));
    const assetsJson: AssetsJson = {
      project_id: "test",
      artifact_version: "2.0.0",
      items: [asset("AST_001", {
        contact_sheet_ids: [contactSheet.contact_sheet_id],
        poster_path: "posters/AST_001.jpg",
        waveform_path: "waveforms/AST_001.png",
      })],
    };
    const segmentsJson: SegmentsJson = {
      project_id: "test",
      artifact_version: "2.0.0",
      items: [segment("SEG_AST_001_001", "AST_001", {
        filmstrip_path: "filmstrips/SEG_AST_001_001.jpg",
      })],
    };

    expect(loadExistingDerivativeResults(assetsJson, segmentsJson, outputDir).get("AST_001")).toEqual({
      contactSheets: [contactSheet],
      posterPath: "posters/AST_001.jpg",
      waveformPath: "waveforms/AST_001.png",
      filmstripPaths: new Map([["SEG_AST_001_001", "filmstrips/SEG_AST_001_001.jpg"]]),
    });
  });

  it("drops missing derivatives and reports each degraded fallback", () => {
    const outputDir = tempDir("missing-derivatives");
    const contactSheet: ContactSheetManifest = {
      contact_sheet_id: "CS_AST_001_01",
      asset_id: "AST_001",
      image_path: "contact_sheets/missing.png",
      mode: "shot_keyframes",
      tile_map: [],
    };
    write(path.join(outputDir, "contact_sheets", "CS_AST_001_01.json"), JSON.stringify(contactSheet));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const assetsJson: AssetsJson = {
      project_id: "test",
      artifact_version: "2.0.0",
      items: [asset("AST_001", {
        contact_sheet_ids: [contactSheet.contact_sheet_id, "CS_MISSING"],
        poster_path: "posters/missing.jpg",
        waveform_path: "waveforms/missing.png",
      })],
    };
    const segmentsJson: SegmentsJson = {
      project_id: "test",
      artifact_version: "2.0.0",
      items: [segment("SEG_AST_001_001", "AST_001", {
        filmstrip_path: "filmstrips/missing.jpg",
      })],
    };

    expect(loadExistingDerivativeResults(assetsJson, segmentsJson, outputDir).get("AST_001")).toEqual({
      contactSheets: [],
      posterPath: null,
      waveformPath: null,
      filmstripPaths: new Map(),
    });
    expect(warn).toHaveBeenCalledTimes(5);
  });
});

describe("preserveVlmOnlySegmentFields", () => {
  it("replaces VLM-owned fields while retaining non-VLM editorial state", () => {
    const original = segment("SEG_AST_001_001", "AST_001", {
      filmstrip_path: "filmstrips/original.jpg",
      transcript_excerpt: "keep this transcript",
      peak_analysis: {
        peak_moments: [],
        visual_energy_curve: [],
        provenance: { precision_mode: "degraded_ffmpeg_signals" },
      } as unknown as SegmentItem["peak_analysis"],
    });
    const next = segment("SEG_AST_001_001", "AST_001", {
      summary: "new grounded summary",
      tags: ["new", "grounded"],
      transcript_excerpt: "do not adopt",
      filmstrip_path: "filmstrips/do-not-adopt.jpg",
      confidence: {
        boundary: { score: 1, source: "segmenter", status: "complete" },
        summary: { score: 0.9, source: "vlm", status: "complete" },
      },
      provenance: {
        boundary: original.provenance.boundary,
        summary: { method: "grounded_vlm" },
      },
    });
    const result = preserveVlmOnlySegmentFields(
      { project_id: "test", artifact_version: "2.0.0", items: [next] },
      { project_id: "test", artifact_version: "2.0.0", items: [original] },
    ).items[0];

    expect(result.summary).toBe("new grounded summary");
    expect(result.tags).toEqual(["new", "grounded"]);
    expect(result.confidence.summary?.source).toBe("vlm");
    expect(result.provenance.summary?.method).toBe("grounded_vlm");
    expect(result.transcript_excerpt).toBe("keep this transcript");
    expect(result.filmstrip_path).toBe("filmstrips/original.jpg");
    expect(result.peak_analysis).toEqual(original.peak_analysis);
  });
});

describe("buildManifestEntriesFromExistingAssets", () => {
  it("recomputes live identities, retains previous missing entries, and skips unknown missing sources", () => {
    const root = tempDir("manifest");
    const liveSource = write(path.join(root, "live.mov"), "live source bytes");
    const previous: CacheManifestEntry = {
      hash: "previous-hash",
      asset_id: "AST_PREVIOUS",
      cached_at: "2026-01-01T00:00:00.000Z",
      source_path: path.join(root, "missing-previous.mov"),
      source_content_sha256: "previous-source-hash",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const identityCache = new SourceContentIdentityCache();

    const entries = buildManifestEntriesFromExistingAssets(
      [
        asset("AST_LIVE"),
        asset("AST_PREVIOUS"),
        asset("AST_UNKNOWN"),
      ],
      new Map([["AST_LIVE", liveSource]]),
      [previous],
      identityCache,
    );

    const identity = identityCache.resolve(liveSource);
    expect(entries[0]).toMatchObject({
      asset_id: "AST_LIVE",
      source_path: liveSource,
      source_content_sha256: identity.sha256,
      hash: computeCacheHash(liveSource, identity.sizeBytes, 1_000_000, identity.sha256),
    });
    expect(entries[1]).toMatchObject({
      ...previous,
      cached_at: expect.not.stringMatching(/^2026-01-01/),
    });
    expect(entries.map((entry) => entry.asset_id)).toEqual(["AST_LIVE", "AST_PREVIOUS"]);
    expect(warn).toHaveBeenCalledWith(
      "[cache] --vlm-only: cache manifest entry skipped for AST_UNKNOWN; source file unavailable",
    );
  });
});
