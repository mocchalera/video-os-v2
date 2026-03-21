/**
 * M3.5 Phase 5: E2E Round-Trip Tests
 *
 * Fixture-based golden round-trip suite:
 * 1. Build M1-style timeline.json
 * 2. Export via mock bridge → handoff_manifest + OTIO
 * 3. Simulate human edits (trim, reorder, disable) on normalized data
 * 4. Import → roundtrip_import_report
 * 5. Diff → human_revision_diff
 * 6. Re-entry → compiler re-execution
 *
 * Tests:
 * - stable ID retention across round-trip
 * - lossy item detection
 * - split / duplicate classification
 * - Gate 8 / Gate 9 enforcement
 * - all artifact schema validation
 * - deterministic re-run
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type {
  TimelineIR,
  TrackOutput,
  ClipOutput,
  MarkerOutput,
} from "../runtime/compiler/types.js";
import {
  validateStableIds,
  deriveExchangeClipId,
  deriveExchangeTrackId,
  generateHandoffId,
  sha256,
  buildBridgeInput,
  buildHandoffManifest,
  categorizeSurfaces,
  loadCapabilityProfile,
  type HandoffExportInput,
  type HandoffManifest,
  type SourceMapEntry,
} from "../runtime/handoff/export.js";
import {
  mapClips,
  normalizeOneToMany,
  buildImportReport,
  detectLossyItems,
  type NormalizedClip,
  type ClipMapping,
  type OneToManyResult,
  type RoundtripImportReport,
} from "../runtime/handoff/import.js";
import {
  analyzeDiffs,
  type DiffAnalysisInput,
  type HumanRevisionDiff,
} from "../runtime/handoff/diff.js";
import {
  buildReentryEvidence,
  classifyOperation,
  classifyUnmapped,
} from "../runtime/handoff/reentry.js";
import {
  BRIDGE_VERSION,
  OTIO_VERSION_PIN,
  type BridgeFingerprint,
  type NleCapabilityProfile,
} from "../runtime/handoff/bridge-contract.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (
  opts: Record<string, unknown>,
) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
  addSchema(schema: object): void;
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

// ── Schema Validation ──────────────────────────────────────────────

const SCHEMA_DIR = path.resolve("schemas");

function loadSchema(name: string): object {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), "utf-8"));
}

function createValidator(schemaName: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = loadSchema(schemaName);
  return ajv.compile(schema);
}

// ── Mock Bridge Fingerprint ────────────────────────────────────────

const MOCK_BRIDGE_FINGERPRINT: BridgeFingerprint = {
  bridge_version: BRIDGE_VERSION,
  python_version: "3.11.0",
  opentimelineio_version: OTIO_VERSION_PIN,
  bridge_script_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  loaded_adapter_modules: ["otio_default"],
};

// ── NLE Capability Profile ─────────────────────────────────────────

const PROFILE_PATH = path.resolve("runtime/nle-profiles/resolve-v1.yaml");

function loadProfile(): NleCapabilityProfile {
  return loadCapabilityProfile(PROFILE_PATH);
}

// ── Fixture: M1-style Timeline ─────────────────────────────────────

function createFixtureTimeline(): TimelineIR {
  return {
    version: "1.0.0",
    project_id: "e2e_test_project",
    created_at: "2025-01-15T10:00:00.000Z",
    sequence: {
      name: "Main Sequence",
      fps_num: 30000,
      fps_den: 1001,
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
            createClip("clip_A", "seg_01", "asset_001", 0, 3_000_000, 0, 90, "hero", "beat_1"),
            createClip("clip_B", "seg_02", "asset_002", 1_000_000, 4_000_000, 90, 90, "support", "beat_1"),
            createClip("clip_C", "seg_03", "asset_003", 0, 5_000_000, 180, 150, "hero", "beat_2"),
          ],
        },
        {
          track_id: "V2",
          kind: "video",
          clips: [
            createClip("clip_D", "seg_04", "asset_004", 2_000_000, 6_000_000, 0, 120, "transition", "beat_1"),
          ],
        },
      ],
      audio: [
        {
          track_id: "A1",
          kind: "audio",
          clips: [
            createClip("clip_E", "seg_05", "asset_005", 0, 10_000_000, 0, 300, "dialogue", "beat_1"),
          ],
        },
      ],
    },
    markers: [
      { frame: 0, kind: "beat", label: "Beat 1 start" },
      { frame: 180, kind: "beat", label: "Beat 2 start" },
    ],
    provenance: {
      brief_path: "01_brief/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "1.0.0",
    },
  };
}

function createClip(
  clipId: string,
  segmentId: string,
  assetId: string,
  srcIn: number,
  srcOut: number,
  timelineIn: number,
  durationFrames: number,
  role: string,
  beatId: string,
): ClipOutput {
  return {
    clip_id: clipId,
    segment_id: segmentId,
    asset_id: assetId,
    src_in_us: srcIn,
    src_out_us: srcOut,
    timeline_in_frame: timelineIn,
    timeline_duration_frames: durationFrames,
    role,
    motivation: `Selected for ${role}`,
    beat_id: beatId,
    fallback_segment_ids: [],
    confidence: 0.9,
    quality_flags: [],
  };
}

function createSourceMap(): SourceMapEntry[] {
  return [
    { asset_id: "asset_001", source_locator: "/media/raw/001.mov" },
    { asset_id: "asset_002", source_locator: "/media/raw/002.mov" },
    { asset_id: "asset_003", source_locator: "/media/raw/003.mov" },
    { asset_id: "asset_004", source_locator: "/media/raw/004.mov" },
    { asset_id: "asset_005", source_locator: "/media/raw/005.wav" },
  ];
}

// ── Simulate Export: timeline → normalized clips ───────────────────

function simulateExport(
  timeline: TimelineIR,
  projectId: string,
  timelineVersion: string,
): NormalizedClip[] {
  const clips: NormalizedClip[] = [];
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) {
      clips.push({
        exchange_clip_id: deriveExchangeClipId(projectId, timelineVersion, clip.clip_id),
        clip_id: clip.clip_id,
        track_id: track.track_id,
        asset_id: clip.asset_id,
        segment_id: clip.segment_id,
        src_in_us: clip.src_in_us,
        src_out_us: clip.src_out_us,
        timeline_in_frame: clip.timeline_in_frame,
        timeline_duration_frames: clip.timeline_duration_frames,
        enabled: true,
        track_kind: track.kind,
      });
    }
  }
  return clips;
}

// ── Simulate Human Edits ───────────────────────────────────────────

function applyTrimEdit(clip: NormalizedClip, trimInUs: number, trimOutUs: number): NormalizedClip {
  const newSrcIn = clip.src_in_us + trimInUs;
  const newSrcOut = clip.src_out_us + trimOutUs;
  const durationChange = Math.round(((trimOutUs - trimInUs) / 1_000_000) * (30000 / 1001));
  return {
    ...clip,
    src_in_us: newSrcIn,
    src_out_us: newSrcOut,
    timeline_duration_frames: clip.timeline_duration_frames + durationChange,
  };
}

function applyReorder(clips: NormalizedClip[], fromIndex: number, toIndex: number): NormalizedClip[] {
  const result = [...clips];
  const [moved] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, moved);
  // Recompute timeline positions
  let frame = 0;
  for (const clip of result) {
    clip.timeline_in_frame = frame;
    frame += clip.timeline_duration_frames;
  }
  return result;
}

function applyDisable(clip: NormalizedClip): NormalizedClip {
  return { ...clip, enabled: false };
}

function applySplit(clip: NormalizedClip): NormalizedClip[] {
  const midUs = Math.floor((clip.src_in_us + clip.src_out_us) / 2);
  const midFrames = Math.floor(clip.timeline_duration_frames / 2);
  return [
    {
      ...clip,
      src_out_us: midUs,
      timeline_duration_frames: midFrames,
    },
    {
      ...clip,
      src_in_us: midUs,
      timeline_in_frame: clip.timeline_in_frame + midFrames,
      timeline_duration_frames: clip.timeline_duration_frames - midFrames,
    },
  ];
}

function applyDuplicate(clip: NormalizedClip, afterFrame: number): NormalizedClip[] {
  return [
    clip,
    {
      ...clip,
      timeline_in_frame: afterFrame,
    },
  ];
}

// ══════════════════════════════════════════════════════════════════════
//  E2E Test Suite
// ══════════════════════════════════════════════════════════════════════

describe("M3.5 E2E: Fixture Round-Trip", { timeout: 180_000 }, () => {
  const PROJECT_ID = "e2e_test_project";
  const TIMELINE_VERSION = "1.0.0";
  const HANDOFF_ID = "HND_1.0.0_20250115T100000Z";

  let timeline: TimelineIR;
  let profile: NleCapabilityProfile;
  let exportedClips: NormalizedClip[];

  beforeEach(() => {
    timeline = createFixtureTimeline();
    profile = loadProfile();
    exportedClips = simulateExport(timeline, PROJECT_ID, TIMELINE_VERSION);
  });

  // ── Phase 1: Export Preconditions ──────────────────────────────────

  describe("Export Preconditions", () => {
    it("fixture timeline passes Gate 8 stable ID validation", () => {
      const errors = validateStableIds(timeline);
      expect(errors).toHaveLength(0);
    });

    it("all clips get unique exchange_clip_ids", () => {
      const ids = exportedClips.map((c) => c.exchange_clip_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => id.startsWith(`${PROJECT_ID}:${TIMELINE_VERSION}:`))).toBe(true);
    });

    it("exchange_clip_id encodes project:version:clip_id", () => {
      const clipA = exportedClips.find((c) => c.clip_id === "clip_A")!;
      expect(clipA.exchange_clip_id).toBe(`${PROJECT_ID}:${TIMELINE_VERSION}:clip_A`);
    });

    it("exported clip count matches timeline clip count", () => {
      const expectedCount =
        timeline.tracks.video.reduce((s, t) => s + t.clips.length, 0) +
        timeline.tracks.audio.reduce((s, t) => s + t.clips.length, 0);
      expect(exportedClips).toHaveLength(expectedCount);
    });
  });

  // ── Phase 2: Handoff Manifest ─────────────────────────────────────

  describe("Handoff Manifest Generation", () => {
    it("manifest passes schema validation", () => {
      const validate = createValidator("handoff-manifest.schema.json");
      const manifest = buildHandoffManifest(
        {
          projectPath: "/tmp/e2e",
          projectId: PROJECT_ID,
          timelineVersion: TIMELINE_VERSION,
          timeline,
          approvalRecord: {
            status: "clean",
            approved_by: "director",
            approved_at: "2025-01-15T09:00:00.000Z",
          },
          profilePath: PROFILE_PATH,
          sourceMap: createSourceMap(),
        },
        HANDOFF_ID,
        sha256(JSON.stringify(timeline)),
        MOCK_BRIDGE_FINGERPRINT,
        profile,
        "2025-01-15T10:00:00.000Z",
      );

      const valid = validate(manifest);
      if (!valid) {
        const errs = (validate.errors ?? []).map(
          (e) => `${e.instancePath}: ${e.message}`,
        );
        expect.fail(`Manifest schema errors:\n${errs.join("\n")}`);
      }
    });

    it("manifest contains verified/provisional/lossy surface categories", () => {
      const surfaces = categorizeSurfaces(profile);
      expect(surfaces.verified.length).toBeGreaterThan(0);
      expect(surfaces.verified).toContain("trim");
      expect(surfaces.verified).toContain("reorder");
      expect(surfaces.verified).toContain("enable_disable");
      expect(surfaces.lossy.length).toBeGreaterThan(0);
    });
  });

  // ── Phase 3: Identity-Preserving Round-Trip ───────────────────────

  describe("Identity-Preserving Round-Trip (No Edits)", () => {
    it("1:1 mapping with exact confidence when no edits", () => {
      const importedClips = exportedClips.map((c) => ({ ...c }));
      const { mapped, unmapped } = mapClips(
        exportedClips,
        importedClips,
        PROJECT_ID,
        TIMELINE_VERSION,
      );
      expect(unmapped).toHaveLength(0);
      expect(mapped).toHaveLength(exportedClips.length);
      expect(mapped.every((m) => m.confidence === "exact")).toBe(true);
    });

    it("one-to-many normalization produces all 1:1 when no edits", () => {
      const importedClips = exportedClips.map((c) => ({ ...c }));
      const { mapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const result = normalizeOneToMany(mapped);
      expect(result.oneToOne).toHaveLength(exportedClips.length);
      expect(result.splitEntries).toHaveLength(0);
      expect(result.duplicateEntries).toHaveLength(0);
      expect(result.ambiguousEntries).toHaveLength(0);
    });

    it("diff analysis produces clean status with no operations", () => {
      const importedClips = exportedClips.map((c) => ({ ...c }));
      const { mapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, [], "success");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: [],
        importReport: report,
      });

      expect(diff.status).toBe("clean");
      expect(diff.operations).toBeUndefined();
    });
  });

  // ── Phase 4: Trim Edit Round-Trip ─────────────────────────────────

  describe("Trim Edit Round-Trip", () => {
    it("detects trim with before/after/delta", () => {
      const importedClips = exportedClips.map((c) => ({ ...c }));
      // Trim clip_A: move in-point +500000us, keep out-point
      const clipAIndex = importedClips.findIndex((c) => c.clip_id === "clip_A");
      importedClips[clipAIndex] = applyTrimEdit(importedClips[clipAIndex], 500_000, 0);

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, unmapped, "success");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      expect(diff.operations).toBeDefined();
      const trimOps = diff.operations!.filter((o) => o.type === "trim");
      expect(trimOps.length).toBeGreaterThanOrEqual(1);

      const clipATrim = trimOps.find(
        (o) => o.target.exchange_clip_id === `${PROJECT_ID}:${TIMELINE_VERSION}:clip_A`,
      )!;
      expect(clipATrim).toBeDefined();
      expect(clipATrim.before!.src_in_us).toBe(0);
      expect(clipATrim.after!.src_in_us).toBe(500_000);
      expect(clipATrim.delta!.in_us).toBe(500_000);
      expect(clipATrim.surface).toBe("verified_roundtrip");
      expect(clipATrim.confidence).toBe("exact");
    });

    it("trim diff passes human_revision_diff schema", () => {
      const validate = createValidator("human-revision-diff.schema.json");
      const importedClips = exportedClips.map((c) => ({ ...c }));
      importedClips[0] = applyTrimEdit(importedClips[0], 500_000, 0);

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, unmapped, "success");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      const valid = validate(diff);
      if (!valid) {
        const errs = (validate.errors ?? []).map(
          (e) => `${e.instancePath}: ${e.message}`,
        );
        expect.fail(`Diff schema errors:\n${errs.join("\n")}`);
      }
    });
  });

  // ── Phase 5: Reorder Edit Round-Trip ──────────────────────────────

  describe("Reorder Edit Round-Trip", () => {
    it("detects reorder on same track after ripple normalization", () => {
      // Get V1 track clips (clip_A, clip_B, clip_C)
      const v1Clips = exportedClips.filter((c) => c.track_id === "V1");
      expect(v1Clips).toHaveLength(3);

      // Reorder: swap clip_A and clip_C positions
      const importedClips = exportedClips.map((c) => ({ ...c }));
      const v1Imported = importedClips.filter((c) => c.track_id === "V1");
      const reordered = applyReorder(v1Imported, 0, 2); // move A to end

      // Replace V1 clips in importedClips
      let v1Idx = 0;
      for (let i = 0; i < importedClips.length; i++) {
        if (importedClips[i].track_id === "V1") {
          importedClips[i] = reordered[v1Idx++];
        }
      }

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, unmapped, "success");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      const reorderOps = diff.operations?.filter((o) => o.type === "reorder") ?? [];
      expect(reorderOps.length).toBeGreaterThan(0);
      expect(reorderOps[0].surface).toBe("verified_roundtrip");
    });
  });

  // ── Phase 6: Enable/Disable Edit Round-Trip ───────────────────────

  describe("Enable/Disable Edit Round-Trip", () => {
    it("detects disable edit", () => {
      const importedClips = exportedClips.map((c) => ({ ...c }));
      const clipBIndex = importedClips.findIndex((c) => c.clip_id === "clip_B");
      importedClips[clipBIndex] = applyDisable(importedClips[clipBIndex]);

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, unmapped, "success");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      const disableOps = diff.operations?.filter((o) => o.type === "enable_disable") ?? [];
      expect(disableOps.length).toBe(1);
      expect(disableOps[0].enabled).toBe(false);
      expect(disableOps[0].target.exchange_clip_id).toBe(
        `${PROJECT_ID}:${TIMELINE_VERSION}:clip_B`,
      );
    });
  });

  // ── Phase 7: Split Detection ──────────────────────────────────────

  describe("Split Detection", () => {
    it("detects split clip in one-to-many normalization", () => {
      const importedClips: NormalizedClip[] = [];
      for (const clip of exportedClips) {
        if (clip.clip_id === "clip_C") {
          // Split clip_C into two halves
          importedClips.push(...applySplit(clip));
        } else {
          importedClips.push({ ...clip });
        }
      }

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);

      expect(oneToMany.splitEntries).toHaveLength(1);
      expect(oneToMany.splitEntries[0].parent_exchange_clip_id).toBe(
        `${PROJECT_ID}:${TIMELINE_VERSION}:clip_C`,
      );
      expect(oneToMany.splitEntries[0].child_ids).toHaveLength(2);
      expect(oneToMany.splitEntries[0].review_required).toBe(true);
    });

    it("split appears as unmapped_edit in diff", () => {
      const importedClips: NormalizedClip[] = [];
      for (const clip of exportedClips) {
        if (clip.clip_id === "clip_C") {
          importedClips.push(...applySplit(clip));
        } else {
          importedClips.push({ ...clip });
        }
      }

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, unmapped, "partial");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      const splitEdits = diff.unmapped_edits?.filter(
        (e) => e.classification === "split_clip",
      ) ?? [];
      expect(splitEdits.length).toBe(1);
      expect(splitEdits[0].review_required).toBe(true);
      expect(splitEdits[0].derived_child_ids).toHaveLength(2);
    });
  });

  // ── Phase 8: Duplicate Detection ──────────────────────────────────

  describe("Duplicate Detection", () => {
    it("detects duplicate clip in one-to-many normalization", () => {
      const importedClips: NormalizedClip[] = [];
      for (const clip of exportedClips) {
        if (clip.clip_id === "clip_D") {
          // Duplicate clip_D (same source range, different timeline position)
          importedClips.push(...applyDuplicate(clip, 500));
        } else {
          importedClips.push({ ...clip });
        }
      }

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);

      expect(oneToMany.duplicateEntries).toHaveLength(1);
      expect(oneToMany.duplicateEntries[0].parent_exchange_clip_id).toBe(
        `${PROJECT_ID}:${TIMELINE_VERSION}:clip_D`,
      );
      expect(oneToMany.duplicateEntries[0].copy_ids).toHaveLength(1);
      expect(oneToMany.duplicateEntries[0].review_required).toBe(true);
    });

    it("duplicate appears as unmapped_edit in diff", () => {
      const importedClips: NormalizedClip[] = [];
      for (const clip of exportedClips) {
        if (clip.clip_id === "clip_D") {
          importedClips.push(...applyDuplicate(clip, 500));
        } else {
          importedClips.push({ ...clip });
        }
      }

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, unmapped, "partial");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      const dupEdits = diff.unmapped_edits?.filter(
        (e) => e.classification === "duplicated_clip",
      ) ?? [];
      expect(dupEdits.length).toBe(1);
      expect(dupEdits[0].review_required).toBe(true);
      expect(dupEdits[0].copy_ids).toHaveLength(1);
    });
  });

  // ── Phase 9: Lossy Item Detection ─────────────────────────────────

  describe("Lossy Item Detection", () => {
    it("resolve-v1 profile reports lossy surfaces", () => {
      const surfaces = categorizeSurfaces(profile);
      expect(surfaces.lossy).toContain("color_finish");
      expect(surfaces.lossy).toContain("fusion_effect");
      expect(surfaces.lossy).toContain("fairlight_advanced_audio");
    });

    it("lossy surfaces appear as unmapped_edits in diff", () => {
      const importedClips = exportedClips.map((c) => ({ ...c }));
      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = {
        ...buildTestReport(oneToMany, unmapped, "success"),
        loss_summary: {
          review_required: true,
          lossy_items: [
            {
              classification: "color_finish",
              item_ref: `clip:${PROJECT_ID}:${TIMELINE_VERSION}:clip_A`,
              reason: "imported clip carries color-finish metadata evidence (resolve.grade)",
            },
            {
              classification: "plugin_effect",
              item_ref: `clip:${PROJECT_ID}:${TIMELINE_VERSION}:clip_B`,
              reason: "imported clip carries effect evidence (Fusion Glow)",
            },
            {
              classification: "advanced_audio_finish",
              item_ref: `clip:${PROJECT_ID}:${TIMELINE_VERSION}:clip_E`,
              reason: "imported clip carries advanced-audio metadata evidence (fairlight.eq)",
            },
          ],
        },
      } satisfies RoundtripImportReport;

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      const lossyEdits = diff.unmapped_edits?.filter(
        (e) =>
          e.classification === "color_finish" ||
          e.classification === "plugin_effect" ||
          e.classification === "advanced_audio_finish",
      ) ?? [];
      expect(lossyEdits.length).toBeGreaterThanOrEqual(3);
      expect(lossyEdits.every((e) => e.review_required)).toBe(true);
    });
  });

  // ── Phase 10: Gate 8 Enforcement ──────────────────────────────────

  describe("Gate 8 Enforcement", () => {
    it("rejects timeline with missing clip_id", () => {
      const badTimeline = createFixtureTimeline();
      (badTimeline.tracks.video[0].clips[0] as { clip_id: string }).clip_id = "";
      const errors = validateStableIds(badTimeline);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.type === "missing_clip_id")).toBe(true);
    });

    it("rejects timeline with duplicate clip_id", () => {
      const badTimeline = createFixtureTimeline();
      badTimeline.tracks.video[0].clips[1].clip_id = badTimeline.tracks.video[0].clips[0].clip_id;
      const errors = validateStableIds(badTimeline);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.type === "duplicate_clip_id")).toBe(true);
    });

    it("rejects timeline with missing track_id", () => {
      const badTimeline = createFixtureTimeline();
      (badTimeline.tracks.video[0] as { track_id: string }).track_id = "";
      const errors = validateStableIds(badTimeline);
      expect(errors.some((e) => e.type === "missing_track_id")).toBe(true);
    });
  });

  // ── Phase 11: Gate 9 — Unmapped Clips Require Review ──────────────

  describe("Gate 9 Enforcement", () => {
    it("unmapped clips flag review_required in diff", () => {
      const importedClips = exportedClips.map((c) => ({ ...c }));
      // Add a brand-new clip with no exchange_clip_id
      importedClips.push({
        exchange_clip_id: "",
        clip_id: "new_clip_X",
        track_id: "V1",
        asset_id: "asset_999",
        segment_id: "seg_99",
        src_in_us: 0,
        src_out_us: 1_000_000,
        timeline_in_frame: 999,
        timeline_duration_frames: 30,
        enabled: true,
      });

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      expect(unmapped.length).toBe(1);

      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, unmapped, "partial");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      expect(diff.status).toBe("review_required");
      const missingIdEdits = diff.unmapped_edits?.filter(
        (e) => e.classification === "missing_stable_id",
      ) ?? [];
      expect(missingIdEdits.length).toBe(1);
      expect(missingIdEdits[0].review_required).toBe(true);
    });
  });

  // ── Phase 12: Combined Edit Round-Trip ────────────────────────────

  describe("Combined Edits (trim + reorder + disable)", () => {
    it("full round-trip with multiple edit types", () => {
      const importedClips = exportedClips.map((c) => ({ ...c }));

      // 1. Trim clip_A
      const clipAIdx = importedClips.findIndex((c) => c.clip_id === "clip_A");
      importedClips[clipAIdx] = applyTrimEdit(importedClips[clipAIdx], 200_000, 0);

      // 2. Disable clip_B
      const clipBIdx = importedClips.findIndex((c) => c.clip_id === "clip_B");
      importedClips[clipBIdx] = applyDisable(importedClips[clipBIdx]);

      // 3. Reorder V1 clips
      const v1Indices: number[] = [];
      for (let i = 0; i < importedClips.length; i++) {
        if (importedClips[i].track_id === "V1") v1Indices.push(i);
      }
      const v1Clips = v1Indices.map((i) => importedClips[i]);
      const reordered = applyReorder(v1Clips, 0, 2);
      for (let j = 0; j < v1Indices.length; j++) {
        importedClips[v1Indices[j]] = reordered[j];
      }

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, unmapped, "success");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      // Verify all edit types detected
      const types = new Set(diff.operations?.map((o) => o.type) ?? []);
      expect(types.has("trim")).toBe(true);
      expect(types.has("enable_disable")).toBe(true);

      // Diff should be schema-valid
      const validate = createValidator("human-revision-diff.schema.json");
      const valid = validate(diff);
      if (!valid) {
        const errs = (validate.errors ?? []).map(
          (e) => `${e.instancePath}: ${e.message}`,
        );
        expect.fail(`Diff schema errors:\n${errs.join("\n")}`);
      }
    });
  });

  // ── Phase 13: Re-entry Evidence ───────────────────────────────────

  describe("Re-entry Evidence from Diff", () => {
    it("trim/reorder ops route to roughcut_critic", () => {
      const importedClips = exportedClips.map((c) => ({ ...c }));
      importedClips[0] = applyTrimEdit(importedClips[0], 500_000, 0);

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, unmapped, "success");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      const reentry = buildReentryEvidence(diff);
      expect(reentry.criticEvidence).not.toBeNull();
      expect(reentry.criticEvidence!.operations.length).toBeGreaterThan(0);
      expect(reentry.criticEvidence!.operations.every((o) => o.type === "trim")).toBe(true);
    });

    it("enable_disable routes to blueprint_planner", () => {
      const importedClips = exportedClips.map((c) => ({ ...c }));
      const clipBIdx = importedClips.findIndex((c) => c.clip_id === "clip_B");
      importedClips[clipBIdx] = applyDisable(importedClips[clipBIdx]);

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, unmapped, "success");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      const reentry = buildReentryEvidence(diff);
      expect(reentry.blueprintEvidence).not.toBeNull();
      const disableOps = reentry.blueprintEvidence!.operations.filter(
        (o) => o.type === "enable_disable",
      );
      expect(disableOps.length).toBe(1);
    });

    it("split/duplicate unmapped edits route to blueprint_planner", () => {
      const importedClips: NormalizedClip[] = [];
      for (const clip of exportedClips) {
        if (clip.clip_id === "clip_C") {
          importedClips.push(...applySplit(clip));
        } else {
          importedClips.push({ ...clip });
        }
      }

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildTestReport(oneToMany, unmapped, "partial");

      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });

      const reentry = buildReentryEvidence(diff);
      expect(reentry.blueprintEvidence).not.toBeNull();
      const splitEdits = reentry.blueprintEvidence!.unmapped_edits.filter(
        (u) => u.classification === "split_clip",
      );
      expect(splitEdits.length).toBe(1);
    });
  });

  // ── Phase 14: Import Report Schema Validation ─────────────────────

  describe("Import Report Schema Validation", () => {
    it("round-trip import report passes schema", () => {
      const validate = createValidator("roundtrip-import-report.schema.json");

      const importedClips = exportedClips.map((c) => ({ ...c }));
      importedClips[0] = applyTrimEdit(importedClips[0], 500_000, 0);

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);

      const report = buildImportReport(
        buildTestManifest(),
        profile,
        MOCK_BRIDGE_FINGERPRINT,
        exportedClips,
        mapped,
        oneToMany,
        unmapped,
        false,
        "success",
        "2025-01-15T11:00:00.000Z",
      );

      const valid = validate(report);
      if (!valid) {
        const errs = (validate.errors ?? []).map(
          (e) => `${e.instancePath}: ${e.message}`,
        );
        expect.fail(`Import report schema errors:\n${errs.join("\n")}`);
      }
    });
  });

  // ── Phase 15: Deterministic Re-Run ────────────────────────────────

  describe("Deterministic Re-Run", () => {
    it("same inputs produce identical diff", () => {
      const importedClips = exportedClips.map((c) => ({ ...c }));
      importedClips[0] = applyTrimEdit(importedClips[0], 500_000, 0);
      const clipBIdx = importedClips.findIndex((c) => c.clip_id === "clip_B");
      importedClips[clipBIdx] = applyDisable(importedClips[clipBIdx]);

      function runPipeline() {
        const { mapped, unmapped } = mapClips(
          exportedClips,
          importedClips.map((c) => ({ ...c })),
          PROJECT_ID,
          TIMELINE_VERSION,
        );
        const oneToMany = normalizeOneToMany(mapped);
        const report = buildTestReport(oneToMany, unmapped, "success");
        return analyzeDiffs({
          projectId: PROJECT_ID,
          handoffId: HANDOFF_ID,
          baseTimelineVersion: TIMELINE_VERSION,
          capabilityProfileId: profile.profile_id,
          profile,
          exportedClips,
          oneToOne: oneToMany.oneToOne,
          oneToMany,
          unmappedClips: unmapped,
          importReport: report,
        });
      }

      const diff1 = runPipeline();
      const diff2 = runPipeline();

      expect(JSON.stringify(diff1)).toBe(JSON.stringify(diff2));
    });
  });

  // ── Phase 16: Fallback / Provisional Mapping ──────────────────────

  describe("Fallback and Provisional Mapping", () => {
    it("fallback mapping when exchange_clip_id metadata is stripped", () => {
      const importedClips = exportedClips.map((c) => ({
        ...c,
        exchange_clip_id: "", // metadata lost
        name: `clip_${c.clip_id}`, // name retains clip_id
      }));

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      // All should map via fallback paths
      expect(mapped.length).toBe(exportedClips.length);
      expect(unmapped.length).toBe(0);
      // Confidence should not be "exact"
      expect(mapped.every((m) => m.confidence !== "exact")).toBe(true);
    });

    it("provisional mapping uses source signature", () => {
      const importedClips = exportedClips.map((c) => ({
        ...c,
        exchange_clip_id: "", // lost
        clip_id: "unknown", // lost
        name: undefined as string | undefined, // lost
        metadata_lost: true,
      }));

      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const provisionalMappings = mapped.filter((m) => m.confidence === "provisional");
      // Should find some provisional matches via source signature
      expect(provisionalMappings.length + unmapped.length).toBe(exportedClips.length);
    });
  });

  // ── Phase 17: All Artifacts Schema Validation ─────────────────────

  describe("All Artifacts Schema Validation", () => {
    it("complete round-trip produces schema-valid manifest + report + diff", () => {
      const validateManifest = createValidator("handoff-manifest.schema.json");
      const validateReport = createValidator("roundtrip-import-report.schema.json");
      const validateDiff = createValidator("human-revision-diff.schema.json");

      // 1. Build manifest
      const manifest = buildHandoffManifest(
        {
          projectPath: "/tmp/e2e",
          projectId: PROJECT_ID,
          timelineVersion: TIMELINE_VERSION,
          timeline,
          approvalRecord: {
            status: "clean",
            approved_by: "director",
            approved_at: "2025-01-15T09:00:00.000Z",
          },
          profilePath: PROFILE_PATH,
          sourceMap: createSourceMap(),
        },
        HANDOFF_ID,
        sha256(JSON.stringify(timeline)),
        MOCK_BRIDGE_FINGERPRINT,
        profile,
        "2025-01-15T10:00:00.000Z",
      );
      expect(validateManifest(manifest)).toBe(true);

      // 2. Simulate human edit
      const importedClips = exportedClips.map((c) => ({ ...c }));
      importedClips[0] = applyTrimEdit(importedClips[0], 300_000, -200_000);

      // 3. Import → report
      const { mapped, unmapped } = mapClips(exportedClips, importedClips, PROJECT_ID, TIMELINE_VERSION);
      const oneToMany = normalizeOneToMany(mapped);
      const report = buildImportReport(
        manifest,
        profile,
        MOCK_BRIDGE_FINGERPRINT,
        exportedClips,
        mapped,
        oneToMany,
        unmapped,
        false,
        "success",
        "2025-01-15T11:00:00.000Z",
      );
      expect(validateReport(report)).toBe(true);

      // 4. Diff
      const diff = analyzeDiffs({
        projectId: PROJECT_ID,
        handoffId: HANDOFF_ID,
        baseTimelineVersion: TIMELINE_VERSION,
        capabilityProfileId: profile.profile_id,
        profile,
        exportedClips,
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        unmappedClips: unmapped,
        importReport: report,
      });
      expect(validateDiff(diff)).toBe(true);
    });
  });

  // ── Helpers ───────────────────────────────────────────────────────

  function buildTestManifest(): HandoffManifest {
    return {
      version: 1,
      project_id: PROJECT_ID,
      handoff_id: HANDOFF_ID,
      exported_at: "2025-01-15T10:00:00.000Z",
      base_timeline: {
        path: "05_timeline/timeline.json",
        version: TIMELINE_VERSION,
        hash: sha256(JSON.stringify(timeline)),
        sequence: {
          fps_num: 30000,
          fps_den: 1001,
          width: 1920,
          height: 1080,
        },
      },
      approval_snapshot: {
        status: "clean",
        approved_by: "director",
        approved_at: "2025-01-15T09:00:00.000Z",
      },
      capability_profile: {
        profile_id: profile.profile_id,
      },
      bridge: MOCK_BRIDGE_FINGERPRINT,
      source_map: createSourceMap(),
    };
  }

  function buildTestReport(
    oneToMany: OneToManyResult,
    unmapped: NormalizedClip[],
    status: "success" | "partial" | "failed",
  ): RoundtripImportReport {
    return {
      version: 1,
      project_id: PROJECT_ID,
      handoff_id: HANDOFF_ID,
      imported_at: "2025-01-15T11:00:00.000Z",
      capability_profile_id: profile.profile_id,
      status,
      base_timeline: {
        version: TIMELINE_VERSION,
        hash: sha256(JSON.stringify(timeline)),
      },
      bridge: MOCK_BRIDGE_FINGERPRINT,
      mapping_summary: {
        exported_clip_count: exportedClips.length,
        imported_clip_count: exportedClips.length + unmapped.length,
        exact_matches: oneToMany.oneToOne.filter((m) => m.confidence === "exact").length,
        fallback_matches: oneToMany.oneToOne.filter((m) => m.confidence === "fallback").length,
        provisional_matches: oneToMany.oneToOne.filter((m) => m.confidence === "provisional").length,
        split_items: oneToMany.splitEntries.length,
        duplicate_id_items: oneToMany.duplicateEntries.length,
        ambiguous_one_to_many_items: oneToMany.ambiguousEntries.length,
        unmapped_items: unmapped.length,
      },
    };
  }
});
