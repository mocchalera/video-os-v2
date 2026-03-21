/**
 * M3.5 Phase 4: Diff Analyzer & M3 Re-entry Tests
 *
 * Tests for:
 * - Diff classification (each edit_type detection)
 * - Ripple shift vs reorder distinction
 * - Unmapped edit classification
 * - Summary statistics
 * - Diff → schema validation
 * - Re-entry: diff → consumer classification
 * - Re-entry: diff → compiler re-execution
 * - Approval_record invalidation
 * - Handoff_resolution update
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import {
  analyzeDiffs,
  computeRippleShifts,
  isGenuineReorder,
  type DiffAnalysisInput,
  type HumanRevisionDiff,
  type ImportedTransition,
  type ImportedMarker,
} from "../runtime/handoff/diff.js";
import {
  buildReentryEvidence,
  classifyOperation,
  classifyUnmapped,
  invalidateApproval,
  updateHandoffResolution,
  computeHash,
  executeRecompileLoop,
  type ReentryAgent,
  type CriticReentryEvidence,
  type BlueprintReentryEvidence,
} from "../runtime/handoff/reentry.js";
import type {
  NormalizedClip,
  ClipMapping,
  OneToManyResult,
  RoundtripImportReport,
} from "../runtime/handoff/import.js";
import type { NleCapabilityProfile } from "../runtime/handoff/bridge-contract.js";
import type { ProjectStateDoc } from "../runtime/state/reconcile.js";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";

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

// ── Schema Loading ──────────────────────────────────────────────────

const SCHEMA_DIR = path.resolve("schemas");

function loadSchema(name: string): object {
  const raw = fs.readFileSync(path.join(SCHEMA_DIR, name), "utf-8");
  return JSON.parse(raw);
}

function createValidator(schemaName: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = loadSchema(schemaName);
  return ajv.compile(schema);
}

// ── Test Fixtures ───────────────────────────────────────────────────

const PROJECT_ID = "test-project";
const TIMELINE_VERSION = "5";
const HANDOFF_ID = "HND_0005_20260321T120000Z";
const PROFILE_ID = "davinci_resolve_otio_v1";
const SAMPLE_PROJECT = path.resolve("projects/sample");

function makeProfile(overrides?: Partial<NleCapabilityProfile>): NleCapabilityProfile {
  return {
    version: 1,
    profile_id: PROFILE_ID,
    nle: { vendor: "Blackmagic Design", product: "DaVinci Resolve", version_range: ">=19" },
    otio: { interchange_format: "otio", metadata_namespace: "video_os" },
    stable_id: {
      primary_paths: { clip: "metadata.video_os.exchange_clip_id", track: "metadata.video_os.exchange_track_id" },
      require_exact_metadata: true,
    },
    surfaces: {
      trim: { mode: "verified_roundtrip", tolerance_frames: 1 },
      reorder: { mode: "verified_roundtrip", detect_after: "ripple_normalized_peer_order" },
      enable_disable: { mode: "verified_roundtrip" },
      track_move: { mode: "provisional_roundtrip" },
      track_reorder: { mode: "report_only" },
      simple_transition: { mode: "provisional_roundtrip", allowed_types: ["dissolve", "wipe"] },
      timeline_marker_add: { mode: "provisional_roundtrip" },
      clip_marker_add: { mode: "report_only" },
      note_text_add: { mode: "report_only" },
      color_finish: { mode: "lossy" },
      fusion_effect: { mode: "lossy" },
      fairlight_advanced_audio: { mode: "lossy" },
    },
    import_policy: {
      provisional_mapping_requires_review: true,
      unmapped_edit_requires_review: true,
      one_to_many_requires_review: true,
    },
    ...overrides,
  };
}

function makeClip(id: string, overrides?: Partial<NormalizedClip>): NormalizedClip {
  return {
    exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:${id}`,
    clip_id: id,
    track_id: "V1",
    asset_id: `AST_${id}`,
    segment_id: `SEG_${id}`,
    src_in_us: 1000000,
    src_out_us: 2000000,
    timeline_in_frame: 0,
    timeline_duration_frames: 24,
    enabled: true,
    ...overrides,
  };
}

function makeMapping(
  exported: NormalizedClip,
  imported: NormalizedClip,
  confidence: "exact" | "fallback" | "provisional" = "exact",
): ClipMapping {
  return {
    imported,
    exportedExchangeClipId: exported.exchange_clip_id,
    confidence,
  };
}

function emptyOneToMany(): OneToManyResult {
  return {
    oneToOne: [],
    splitEntries: [],
    duplicateEntries: [],
    ambiguousEntries: [],
  };
}

function makeImportReport(overrides?: Partial<RoundtripImportReport>): RoundtripImportReport {
  return {
    version: 1,
    project_id: PROJECT_ID,
    handoff_id: HANDOFF_ID,
    imported_at: "2026-03-21T12:00:00Z",
    capability_profile_id: PROFILE_ID,
    status: "success",
    base_timeline: { version: TIMELINE_VERSION, hash: "sha256:abc" },
    bridge: {
      bridge_version: "1.0.0",
      python_version: "3.11.0",
      opentimelineio_version: "0.17.0",
      bridge_script_hash: "sha256:abc",
      loaded_adapter_modules: [],
    },
    mapping_summary: {
      exported_clip_count: 0,
      imported_clip_count: 0,
      exact_matches: 0,
      fallback_matches: 0,
      provisional_matches: 0,
      split_items: 0,
      duplicate_id_items: 0,
      ambiguous_one_to_many_items: 0,
      unmapped_items: 0,
    },
    ...overrides,
  };
}

function makeDiffInput(overrides?: Partial<DiffAnalysisInput>): DiffAnalysisInput {
  return {
    projectId: PROJECT_ID,
    handoffId: HANDOFF_ID,
    baseTimelineVersion: TIMELINE_VERSION,
    capabilityProfileId: PROFILE_ID,
    profile: makeProfile(),
    exportedClips: [],
    oneToOne: [],
    oneToMany: emptyOneToMany(),
    unmappedClips: [],
    importReport: makeImportReport(),
    ...overrides,
  };
}

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

// ── Diff Classification Tests ──────────────────────────────────────

describe("M3.5 Phase 4: Diff Analyzer", () => {
  describe("trim detection", () => {
    it("detects src_in_us change as trim", () => {
      const exported = makeClip("CLP_001", {
        src_in_us: 1000000,
        src_out_us: 2000000,
        timeline_in_frame: 0,
        timeline_duration_frames: 24,
      });
      const imported = makeClip("CLP_001", {
        src_in_us: 1200000,
        src_out_us: 2000000,
        timeline_in_frame: 0,
        timeline_duration_frames: 20,
      });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      expect(result.operations).toBeDefined();
      expect(result.operations!.length).toBe(1);
      expect(result.operations![0].type).toBe("trim");
      expect(result.operations![0].delta!.in_us).toBe(200000);
      expect(result.operations![0].delta!.out_us).toBe(0);
      expect(result.operations![0].confidence).toBe("exact");
      expect(result.operations![0].surface).toBe("verified_roundtrip");
    });

    it("detects src_out_us change as trim", () => {
      const exported = makeClip("CLP_002", {
        src_in_us: 1000000,
        src_out_us: 2000000,
      });
      const imported = makeClip("CLP_002", {
        src_in_us: 1000000,
        src_out_us: 1800000,
        timeline_duration_frames: 20,
      });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      expect(result.operations).toBeDefined();
      const trimOp = result.operations!.find((o) => o.type === "trim");
      expect(trimOp).toBeDefined();
      expect(trimOp!.delta!.out_us).toBe(-200000);
    });

    it("detects both in and out change as single trim", () => {
      const exported = makeClip("CLP_003", {
        src_in_us: 1000000,
        src_out_us: 2000000,
        timeline_duration_frames: 24,
      });
      const imported = makeClip("CLP_003", {
        src_in_us: 1200000,
        src_out_us: 1800000,
        timeline_duration_frames: 16,
      });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      const trimOp = result.operations!.find((o) => o.type === "trim");
      expect(trimOp).toBeDefined();
      expect(trimOp!.delta!.in_us).toBe(200000);
      expect(trimOp!.delta!.out_us).toBe(-200000);
      expect(trimOp!.delta!.duration_frames).toBe(-8);
    });

    it("records before/after states correctly", () => {
      const exported = makeClip("CLP_004", {
        src_in_us: 5000000,
        src_out_us: 10000000,
        timeline_in_frame: 48,
        timeline_duration_frames: 120,
      });
      const imported = makeClip("CLP_004", {
        src_in_us: 5500000,
        src_out_us: 9500000,
        timeline_in_frame: 48,
        timeline_duration_frames: 96,
      });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      const trimOp = result.operations![0];
      expect(trimOp.before!.src_in_us).toBe(5000000);
      expect(trimOp.before!.src_out_us).toBe(10000000);
      expect(trimOp.after!.src_in_us).toBe(5500000);
      expect(trimOp.after!.src_out_us).toBe(9500000);
    });

    it("does not emit trim when src ranges are unchanged", () => {
      const exported = makeClip("CLP_005");
      const imported = makeClip("CLP_005");

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      expect(result.operations ?? []).toHaveLength(0);
    });
  });

  describe("enable_disable detection", () => {
    it("detects enabled → disabled change", () => {
      const exported = makeClip("CLP_010", { enabled: true });
      const imported = makeClip("CLP_010", { enabled: false });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      const enableOp = result.operations!.find((o) => o.type === "enable_disable");
      expect(enableOp).toBeDefined();
      expect(enableOp!.enabled).toBe(false);
      expect(enableOp!.surface).toBe("verified_roundtrip");
    });

    it("detects disabled → enabled change", () => {
      const exported = makeClip("CLP_011", { enabled: false });
      const imported = makeClip("CLP_011", { enabled: true });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      const enableOp = result.operations!.find((o) => o.type === "enable_disable");
      expect(enableOp).toBeDefined();
      expect(enableOp!.enabled).toBe(true);
    });

    it("does not emit enable_disable when both undefined", () => {
      const exported = makeClip("CLP_012", { enabled: undefined });
      const imported = makeClip("CLP_012", { enabled: undefined });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      const enableOp = (result.operations ?? []).find((o) => o.type === "enable_disable");
      expect(enableOp).toBeUndefined();
    });
  });

  describe("track_move detection", () => {
    it("detects track change as track_move", () => {
      const exported = makeClip("CLP_020", { track_id: "V1" });
      const imported = makeClip("CLP_020", { track_id: "V2" });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      const moveOp = result.operations!.find((o) => o.type === "track_move");
      expect(moveOp).toBeDefined();
      expect(moveOp!.from_track_id).toBe("V1");
      expect(moveOp!.to_track_id).toBe("V2");
      expect(moveOp!.surface).toBe("provisional_roundtrip");
    });

    it("does not emit track_move when track unchanged", () => {
      const exported = makeClip("CLP_021", { track_id: "V1" });
      const imported = makeClip("CLP_021", { track_id: "V1" });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      const moveOp = (result.operations ?? []).find((o) => o.type === "track_move");
      expect(moveOp).toBeUndefined();
    });

    it("classifies global track swaps as track_reorder instead of clip track_move", () => {
      const exportedA = makeClip("CLP_022", { track_id: "V1", timeline_in_frame: 0 });
      const exportedB = makeClip("CLP_023", { track_id: "V2", timeline_in_frame: 0 });
      const importedA = makeClip("CLP_022", { track_id: "V2", timeline_in_frame: 0 });
      const importedB = makeClip("CLP_023", { track_id: "V1", timeline_in_frame: 0 });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exportedA, exportedB],
        oneToOne: [
          makeMapping(exportedA, importedA),
          makeMapping(exportedB, importedB),
        ],
      }));

      expect((result.operations ?? []).filter((op) => op.type === "track_move")).toHaveLength(0);
      const trackReorder = result.unmapped_edits?.find((u) => u.classification === "track_reorder");
      expect(trackReorder).toBeDefined();
      expect(trackReorder!.item_ref).toContain("tracks:video:");
    });
  });

  describe("simple_transition detection", () => {
    it("detects dissolve transition", () => {
      const exported = makeClip("CLP_030");
      const transitions: ImportedTransition[] = [
        {
          exchange_clip_id: exported.exchange_clip_id,
          transition_type: "dissolve",
          duration_frames: 12,
        },
      ];

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, exported)],
        importedTransitions: transitions,
      }));

      const transOp = result.operations!.find((o) => o.type === "simple_transition");
      expect(transOp).toBeDefined();
      expect(transOp!.transition_type).toBe("dissolve");
      expect(transOp!.transition_duration_frames).toBe(12);
    });

    it("classifies unsupported transition types as unmapped edits", () => {
      const exported = makeClip("CLP_031");
      const transitions: ImportedTransition[] = [
        {
          exchange_clip_id: exported.exchange_clip_id,
          transition_type: "iris_wipe_custom",
          duration_frames: 6,
        },
      ];

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, exported)],
        importedTransitions: transitions,
      }));

      const transOp = (result.operations ?? []).find((o) => o.type === "simple_transition");
      expect(transOp).toBeUndefined();

      const unmapped = result.unmapped_edits?.find((u) => u.item_ref.includes("transition@clip"));
      expect(unmapped).toBeDefined();
      expect(unmapped!.classification).toBe("unknown_vendor_extension");
    });
  });

  describe("timeline_marker_add detection", () => {
    it("detects timeline-scope marker", () => {
      const markers: ImportedMarker[] = [
        { frame: 120, label: "Review point", scope: "timeline" },
      ];

      const result = analyzeDiffs(makeDiffInput({
        importedMarkers: markers,
      }));

      const markerOp = result.operations!.find((o) => o.type === "timeline_marker_add");
      expect(markerOp).toBeDefined();
      expect(markerOp!.marker_frame).toBe(120);
      expect(markerOp!.marker_label).toBe("Review point");
    });

    it("clip-scope markers go to unmapped_edits", () => {
      const markers: ImportedMarker[] = [
        {
          frame: 60,
          label: "Fix color here",
          scope: "clip",
          exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_040`,
        },
      ];

      const result = analyzeDiffs(makeDiffInput({
        importedMarkers: markers,
      }));

      const markerOp = (result.operations ?? []).find((o) => o.type === "timeline_marker_add");
      expect(markerOp).toBeUndefined();

      expect(result.unmapped_edits).toBeDefined();
      const clipMarker = result.unmapped_edits!.find((u) => u.classification === "clip_marker_add");
      expect(clipMarker).toBeDefined();
      expect(clipMarker!.review_required).toBe(true);
    });
  });

  describe("ripple shift vs reorder", () => {
    it("identifies ripple shift (not reorder) when upstream trim shifts downstream", () => {
      // Track V1: [CLP_A@0-24] [CLP_B@24-48] [CLP_C@48-72]
      // Human trims CLP_A shorter (24→20 frames), CLP_B and CLP_C shift left by 4 frames
      const exportedA = makeClip("CLP_A", { timeline_in_frame: 0, timeline_duration_frames: 24 });
      const exportedB = makeClip("CLP_B", { timeline_in_frame: 24, timeline_duration_frames: 24 });
      const exportedC = makeClip("CLP_C", { timeline_in_frame: 48, timeline_duration_frames: 24 });

      const importedA = makeClip("CLP_A", { timeline_in_frame: 0, timeline_duration_frames: 20,
        src_in_us: 1000000, src_out_us: 1833333 }); // trimmed
      const importedB = makeClip("CLP_B", { timeline_in_frame: 20, timeline_duration_frames: 24 }); // shifted -4
      const importedC = makeClip("CLP_C", { timeline_in_frame: 44, timeline_duration_frames: 24 }); // shifted -4

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exportedA, exportedB, exportedC],
        oneToOne: [
          makeMapping(exportedA, importedA),
          makeMapping(exportedB, importedB),
          makeMapping(exportedC, importedC),
        ],
      }));

      // Should have trim for CLP_A, but NO reorder for CLP_B or CLP_C
      const trimOps = result.operations!.filter((o) => o.type === "trim");
      expect(trimOps.length).toBe(1);
      expect(trimOps[0].target.clip_id).toBe("CLP_A");

      const reorderOps = (result.operations ?? []).filter((o) => o.type === "reorder");
      expect(reorderOps.length).toBe(0);
    });

    it("identifies genuine reorder (relative order changed)", () => {
      // Track V1: [CLP_A@0-24] [CLP_B@24-48] [CLP_C@48-72]
      // Human swaps CLP_B and CLP_C: [CLP_A@0-24] [CLP_C@24-48] [CLP_B@48-72]
      const exportedA = makeClip("CLP_A", { timeline_in_frame: 0, timeline_duration_frames: 24 });
      const exportedB = makeClip("CLP_B", { timeline_in_frame: 24, timeline_duration_frames: 24 });
      const exportedC = makeClip("CLP_C", { timeline_in_frame: 48, timeline_duration_frames: 24 });

      const importedA = makeClip("CLP_A", { timeline_in_frame: 0, timeline_duration_frames: 24 });
      const importedB = makeClip("CLP_B", { timeline_in_frame: 48, timeline_duration_frames: 24 }); // moved to 48
      const importedC = makeClip("CLP_C", { timeline_in_frame: 24, timeline_duration_frames: 24 }); // moved to 24

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exportedA, exportedB, exportedC],
        oneToOne: [
          makeMapping(exportedA, importedA),
          makeMapping(exportedB, importedB),
          makeMapping(exportedC, importedC),
        ],
      }));

      const reorderOps = result.operations!.filter((o) => o.type === "reorder");
      // CLP_B and CLP_C both changed relative position
      expect(reorderOps.length).toBe(2);
      const reorderedClips = reorderOps.map((o) => o.target.clip_id).sort();
      expect(reorderedClips).toEqual(["CLP_B", "CLP_C"]);
    });

    it("computeRippleShifts calculates cumulative deltas correctly", () => {
      const exportedA = makeClip("CLP_A", { timeline_in_frame: 0, timeline_duration_frames: 24 });
      const exportedB = makeClip("CLP_B", { timeline_in_frame: 24, timeline_duration_frames: 24 });
      const exportedC = makeClip("CLP_C", { timeline_in_frame: 48, timeline_duration_frames: 24 });

      // CLP_A trimmed from 24 to 20 frames, CLP_B trimmed from 24 to 18 frames
      const importedA = makeClip("CLP_A", { timeline_in_frame: 0, timeline_duration_frames: 20 });
      const importedB = makeClip("CLP_B", { timeline_in_frame: 20, timeline_duration_frames: 18 });
      const importedC = makeClip("CLP_C", { timeline_in_frame: 38, timeline_duration_frames: 24 });

      const pairs = [
        { exported: exportedA, imported: importedA, confidence: "exact" as const, mappedVia: "test" },
        { exported: exportedB, imported: importedB, confidence: "exact" as const, mappedVia: "test" },
        { exported: exportedC, imported: importedC, confidence: "exact" as const, mappedVia: "test" },
      ];

      const rippleMap = computeRippleShifts(pairs);

      // CLP_A: no upstream → ripple = 0
      expect(rippleMap.get(exportedA.exchange_clip_id)).toBe(0);
      // CLP_B: upstream = CLP_A delta = 20-24 = -4 → ripple = -4
      expect(rippleMap.get(exportedB.exchange_clip_id)).toBe(-4);
      // CLP_C: upstream = CLP_A (-4) + CLP_B (18-24 = -6) → ripple = -10
      expect(rippleMap.get(exportedC.exchange_clip_id)).toBe(-10);
    });

    it("handles trim + ripple correctly (trim detected, no false reorder)", () => {
      // Two clips: A trimmed, B ripple-shifted
      const exportedA = makeClip("CLP_A", {
        timeline_in_frame: 0, timeline_duration_frames: 30,
        src_in_us: 0, src_out_us: 1250000,
      });
      const exportedB = makeClip("CLP_B", {
        timeline_in_frame: 30, timeline_duration_frames: 30,
      });

      const importedA = makeClip("CLP_A", {
        timeline_in_frame: 0, timeline_duration_frames: 24,
        src_in_us: 0, src_out_us: 1000000, // trimmed out
      });
      const importedB = makeClip("CLP_B", {
        timeline_in_frame: 24, timeline_duration_frames: 30, // shifted -6
      });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exportedA, exportedB],
        oneToOne: [
          makeMapping(exportedA, importedA),
          makeMapping(exportedB, importedB),
        ],
      }));

      // Should have 1 trim (CLP_A), 0 reorders
      const trimOps = result.operations!.filter((o) => o.type === "trim");
      expect(trimOps.length).toBe(1);
      expect(trimOps[0].target.clip_id).toBe("CLP_A");

      const reorderOps = (result.operations ?? []).filter((o) => o.type === "reorder");
      expect(reorderOps.length).toBe(0);
    });
  });

  describe("unmapped edit classification", () => {
    it("classifies split_clip from one-to-many", () => {
      const oneToMany: OneToManyResult = {
        oneToOne: [],
        splitEntries: [{
          parent_exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_050`,
          child_ids: [`${PROJECT_ID}:${TIMELINE_VERSION}:CLP_050#S01`, `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_050#S02`],
          review_required: true,
        }],
        duplicateEntries: [],
        ambiguousEntries: [],
      };

      const result = analyzeDiffs(makeDiffInput({ oneToMany }));

      const splitEdit = result.unmapped_edits!.find((u) => u.classification === "split_clip");
      expect(splitEdit).toBeDefined();
      expect(splitEdit!.derived_child_ids).toHaveLength(2);
      expect(splitEdit!.review_required).toBe(true);
    });

    it("classifies duplicated_clip from one-to-many", () => {
      const oneToMany: OneToManyResult = {
        oneToOne: [],
        splitEntries: [],
        duplicateEntries: [{
          parent_exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_051`,
          retained_exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_051`,
          copy_ids: [`${PROJECT_ID}:${TIMELINE_VERSION}:CLP_051#D01`],
          provenance: { basis: "duplicate_metadata_collision" },
          review_required: true,
        }],
        ambiguousEntries: [],
      };

      const result = analyzeDiffs(makeDiffInput({ oneToMany }));

      const dupEdit = result.unmapped_edits!.find((u) => u.classification === "duplicated_clip");
      expect(dupEdit).toBeDefined();
      expect(dupEdit!.copy_ids).toHaveLength(1);
    });

    it("classifies ambiguous_one_to_many from one-to-many", () => {
      const oneToMany: OneToManyResult = {
        oneToOne: [],
        splitEntries: [],
        duplicateEntries: [],
        ambiguousEntries: [{
          parent_exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_052`,
          candidates: ["#A01", "#A02"],
          reason: "Cannot deterministically distinguish split from duplicate",
          review_required: true,
        }],
      };

      const result = analyzeDiffs(makeDiffInput({ oneToMany }));

      const ambigEdit = result.unmapped_edits!.find((u) => u.classification === "ambiguous_one_to_many");
      expect(ambigEdit).toBeDefined();
    });

    it("classifies missing_stable_id for unmapped clips", () => {
      const unmappedClip = makeClip("UNKNOWN", { exchange_clip_id: "" });

      const result = analyzeDiffs(makeDiffInput({
        unmappedClips: [unmappedClip],
      }));

      const missingEdit = result.unmapped_edits!.find((u) => u.classification === "missing_stable_id");
      expect(missingEdit).toBeDefined();
      expect(missingEdit!.review_required).toBe(true);
    });

    it("does not fabricate lossy unmapped edits from the profile alone", () => {
      const result = analyzeDiffs(makeDiffInput());
      expect(result.unmapped_edits ?? []).toHaveLength(0);
    });

    it("classifies lossy import evidence from the import report", () => {
      const result = analyzeDiffs(makeDiffInput({
        importReport: makeImportReport({
          loss_summary: {
            review_required: true,
            lossy_items: [
              {
                classification: "color_finish",
                item_ref: `clip:${PROJECT_ID}:${TIMELINE_VERSION}:CLP_053`,
                reason: "imported clip carries color-finish metadata evidence (resolve.grade)",
              },
              {
                classification: "plugin_effect",
                item_ref: `clip:${PROJECT_ID}:${TIMELINE_VERSION}:CLP_054`,
                reason: "imported clip carries effect evidence (Fusion Blur)",
              },
            ],
            unsupported_items: [
              {
                classification: "advanced_audio_finish",
                item_ref: `clip:${PROJECT_ID}:${TIMELINE_VERSION}:CLP_055`,
                reason: "imported clip carries advanced-audio metadata evidence (fairlight.eq)",
              },
            ],
          },
        }),
      }));

      expect(result.unmapped_edits?.find((u) => u.classification === "color_finish")).toBeDefined();
      expect(result.unmapped_edits?.find((u) => u.classification === "plugin_effect")).toBeDefined();
      expect(result.unmapped_edits?.find((u) => u.classification === "advanced_audio_finish")).toBeDefined();
    });

    it("classifies deleted exported clips without disable", () => {
      const exported = makeClip("CLP_056");
      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
      }));

      const deleted = result.unmapped_edits?.find(
        (u) => u.classification === "deleted_clip_without_disable",
      );
      expect(deleted).toBeDefined();
      expect(deleted!.item_ref).toBe(`clip:${exported.exchange_clip_id}`);
    });

    it("classifies provisional mappings as ambiguous_mapping", () => {
      const exported = makeClip("CLP_057");
      const imported = makeClip("CLP_057");
      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported, "provisional")],
      }));

      const ambiguous = result.unmapped_edits?.find((u) => u.classification === "ambiguous_mapping");
      expect(ambiguous).toBeDefined();
      expect(ambiguous!.item_ref).toBe(`clip:${exported.exchange_clip_id}`);
    });

    it("classifies note_text_add from import report evidence", () => {
      const result = analyzeDiffs(makeDiffInput({
        importReport: makeImportReport({
          loss_summary: {
            review_required: true,
            unsupported_items: [
              {
                classification: "note_text_add",
                item_ref: `note@clip=${PROJECT_ID}:${TIMELINE_VERSION}:CLP_058`,
                reason: "freeform note text body is outside the patch contract",
              },
            ],
          },
        }),
      }));

      const noteText = result.unmapped_edits?.find((u) => u.classification === "note_text_add");
      expect(noteText).toBeDefined();
    });
  });

  describe("summary statistics", () => {
    it("counts operations by type", () => {
      const exported1 = makeClip("CLP_060", { src_in_us: 1000000, src_out_us: 2000000 });
      const imported1 = makeClip("CLP_060", { src_in_us: 1200000, src_out_us: 2000000 });

      const exported2 = makeClip("CLP_061", { src_in_us: 3000000, src_out_us: 4000000, timeline_in_frame: 24 });
      const imported2 = makeClip("CLP_061", { src_in_us: 3100000, src_out_us: 4000000, timeline_in_frame: 24 });

      const exported3 = makeClip("CLP_062", { enabled: true, timeline_in_frame: 48 });
      const imported3 = makeClip("CLP_062", { enabled: false, timeline_in_frame: 48 });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported1, exported2, exported3],
        oneToOne: [
          makeMapping(exported1, imported1),
          makeMapping(exported2, imported2),
          makeMapping(exported3, imported3),
        ],
      }));

      expect(result.summary.trim).toBe(2);
      expect(result.summary.enable_disable).toBe(1);
    });

    it("counts unmapped edits in summary", () => {
      const oneToMany: OneToManyResult = {
        oneToOne: [],
        splitEntries: [{
          parent_exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_070`,
          child_ids: ["#S01"],
          review_required: true,
        }],
        duplicateEntries: [],
        ambiguousEntries: [],
      };

      const result = analyzeDiffs(makeDiffInput({ oneToMany }));

      expect(result.summary.unmapped).toBe(1);
    });

    it("returns clean status when no edits", () => {
      const profile = makeProfile({
        surfaces: {
          trim: { mode: "verified_roundtrip" },
          reorder: { mode: "verified_roundtrip" },
          enable_disable: { mode: "verified_roundtrip" },
          track_move: { mode: "provisional_roundtrip" },
          simple_transition: { mode: "provisional_roundtrip" },
          timeline_marker_add: { mode: "provisional_roundtrip" },
          // No lossy surfaces
        },
      });

      const exported = makeClip("CLP_080");
      const imported = makeClip("CLP_080");

      const result = analyzeDiffs(makeDiffInput({
        profile,
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      expect(result.status).toBe("clean");
    });

    it("returns clean when the profile is lossy but the import report has no evidence", () => {
      const result = analyzeDiffs(makeDiffInput());
      expect(result.status).toBe("clean");
    });

    it("returns review_required when unmapped edits have review_required", () => {
      const result = analyzeDiffs(makeDiffInput({
        unmappedClips: [makeClip("UNKNOWN", { exchange_clip_id: "" })],
      }));

      expect(result.status).toBe("review_required");
    });
  });

  describe("schema validation", () => {
    it("diff output validates against human-revision-diff.schema.json", () => {
      const exported = makeClip("CLP_090", {
        src_in_us: 1000000,
        src_out_us: 2000000,
        timeline_in_frame: 0,
        timeline_duration_frames: 24,
        enabled: true,
      });
      const imported = makeClip("CLP_090", {
        src_in_us: 1200000,
        src_out_us: 1800000,
        timeline_in_frame: 0,
        timeline_duration_frames: 16,
        enabled: false,
      });

      const oneToMany: OneToManyResult = {
        oneToOne: [makeMapping(exported, imported)],
        splitEntries: [{
          parent_exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_091`,
          child_ids: [`#S01`, `#S02`],
          review_required: true,
        }],
        duplicateEntries: [],
        ambiguousEntries: [],
      };

      const markers: ImportedMarker[] = [
        { frame: 120, label: "Check", scope: "timeline" },
      ];

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: oneToMany.oneToOne,
        oneToMany,
        importedMarkers: markers,
      }));

      const validate = createValidator("human-revision-diff.schema.json");
      const valid = validate(result);
      if (!valid) {
        const errors = (validate.errors ?? [])
          .map((e) => `${e.instancePath}: ${e.message}`)
          .join("\n");
        expect.fail(`Schema validation failed:\n${errors}`);
      }
    });

    it("empty diff validates against schema", () => {
      const profile = makeProfile({
        surfaces: {
          trim: { mode: "verified_roundtrip" },
          reorder: { mode: "verified_roundtrip" },
        },
      });

      const result = analyzeDiffs(makeDiffInput({ profile }));

      const validate = createValidator("human-revision-diff.schema.json");
      const valid = validate(result);
      expect(valid).toBe(true);
    });

    it("throws when runtime-generated diff violates the schema", () => {
      expect(() => analyzeDiffs(makeDiffInput({
        importedMarkers: [
          { frame: -1, label: "bad marker", scope: "timeline" },
        ],
      }))).toThrow(/schema validation failed/i);
    });
  });

  describe("confidence and mapping provenance", () => {
    it("records exact confidence and mapped_via", () => {
      const exported = makeClip("CLP_100", { src_in_us: 1000000, src_out_us: 2000000 });
      const imported = makeClip("CLP_100", { src_in_us: 1100000, src_out_us: 2000000 });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported, "exact")],
      }));

      expect(result.operations![0].confidence).toBe("exact");
      expect(result.operations![0].mapped_via).toBe("metadata.exchange_clip_id");
    });

    it("records fallback confidence", () => {
      const exported = makeClip("CLP_101", { src_in_us: 1000000, src_out_us: 2000000 });
      const imported = makeClip("CLP_101", { src_in_us: 1100000, src_out_us: 2000000 });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported, "fallback")],
      }));

      expect(result.operations![0].confidence).toBe("fallback");
      expect(result.operations![0].mapped_via).toBe("clip_id_or_name_fallback");
    });

    it("records provisional confidence", () => {
      const exported = makeClip("CLP_102", { src_in_us: 1000000, src_out_us: 2000000 });
      const imported = makeClip("CLP_102", { src_in_us: 1100000, src_out_us: 2000000 });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported, "provisional")],
      }));

      expect(result.operations![0].confidence).toBe("provisional");
      expect(result.operations![0].mapped_via).toBe("source_signature_provisional");
    });
  });

  describe("multi-type detection on single clip", () => {
    it("detects both trim and track_move on same clip", () => {
      const exported = makeClip("CLP_110", {
        track_id: "V1",
        src_in_us: 1000000,
        src_out_us: 2000000,
      });
      const imported = makeClip("CLP_110", {
        track_id: "V2",
        src_in_us: 1200000,
        src_out_us: 2000000,
      });

      const result = analyzeDiffs(makeDiffInput({
        exportedClips: [exported],
        oneToOne: [makeMapping(exported, imported)],
      }));

      const types = result.operations!.map((o) => o.type).sort();
      expect(types).toContain("trim");
      expect(types).toContain("track_move");
    });
  });
});

// ── Re-entry Bridge Tests ──────────────────────────────────────────

describe("M3.5 Phase 4: M3 Re-entry Bridge", () => {
  describe("consumer classification", () => {
    it("classifies trim as roughcut_critic", () => {
      expect(classifyOperation({ operation_id: "HRD_0001", type: "trim", target: { exchange_clip_id: "x" } }))
        .toBe("roughcut_critic");
    });

    it("classifies reorder as roughcut_critic", () => {
      expect(classifyOperation({ operation_id: "HRD_0002", type: "reorder", target: { exchange_clip_id: "x" } }))
        .toBe("roughcut_critic");
    });

    it("classifies timeline_marker_add as roughcut_critic", () => {
      expect(classifyOperation({ operation_id: "HRD_0003", type: "timeline_marker_add", target: { exchange_clip_id: "x" } }))
        .toBe("roughcut_critic");
    });

    it("classifies track_move as blueprint_planner", () => {
      expect(classifyOperation({ operation_id: "HRD_0004", type: "track_move", target: { exchange_clip_id: "x" } }))
        .toBe("blueprint_planner");
    });

    it("classifies simple_transition as blueprint_planner", () => {
      expect(classifyOperation({ operation_id: "HRD_0005", type: "simple_transition", target: { exchange_clip_id: "x" } }))
        .toBe("blueprint_planner");
    });

    it("classifies enable_disable as blueprint_planner", () => {
      expect(classifyOperation({ operation_id: "HRD_0006", type: "enable_disable", target: { exchange_clip_id: "x" } }))
        .toBe("blueprint_planner");
    });
  });

  describe("unmapped classification", () => {
    it("classifies split_clip as blueprint_planner", () => {
      expect(classifyUnmapped({
        classification: "split_clip",
        item_ref: "clip:x",
        review_required: true,
        reason: "test",
      })).toBe("blueprint_planner");
    });

    it("classifies plugin_effect as report_only", () => {
      expect(classifyUnmapped({
        classification: "plugin_effect",
        item_ref: "surface:x",
        review_required: true,
        reason: "test",
      })).toBe("report_only");
    });

    it("classifies color_finish as report_only", () => {
      expect(classifyUnmapped({
        classification: "color_finish",
        item_ref: "surface:x",
        review_required: true,
        reason: "test",
      })).toBe("report_only");
    });

    it("classifies deleted_clip_without_disable as blueprint_planner", () => {
      expect(classifyUnmapped({
        classification: "deleted_clip_without_disable",
        item_ref: "clip:x",
        review_required: true,
        reason: "test",
      })).toBe("blueprint_planner");
    });
  });

  describe("buildReentryEvidence", () => {
    it("builds critic evidence for trim ops", () => {
      const diff: HumanRevisionDiff = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        base_timeline_version: TIMELINE_VERSION,
        capability_profile_id: PROFILE_ID,
        status: "clean",
        summary: { trim: 2 },
        operations: [
          { operation_id: "HRD_0001", type: "trim", target: { exchange_clip_id: "a" } },
          { operation_id: "HRD_0002", type: "trim", target: { exchange_clip_id: "b" } },
        ],
      };

      const result = buildReentryEvidence(diff);

      expect(result.criticEvidence).not.toBeNull();
      expect(result.criticEvidence!.operations).toHaveLength(2);
      expect(result.criticEvidence!.consumer).toBe("roughcut_critic");
      expect(result.criticEvidence!.context_summary).toContain("2 trim");
    });

    it("builds blueprint evidence for track_move and unmapped", () => {
      const diff: HumanRevisionDiff = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        base_timeline_version: TIMELINE_VERSION,
        capability_profile_id: PROFILE_ID,
        status: "review_required",
        summary: { track_move: 1, unmapped: 2 },
        operations: [
          { operation_id: "HRD_0001", type: "track_move", target: { exchange_clip_id: "a" } },
        ],
        unmapped_edits: [
          { classification: "split_clip", item_ref: "clip:x", review_required: true, reason: "test" },
          { classification: "plugin_effect", item_ref: "surface:y", review_required: true, reason: "test" },
        ],
      };

      const result = buildReentryEvidence(diff);

      expect(result.blueprintEvidence).not.toBeNull();
      expect(result.blueprintEvidence!.operations).toHaveLength(1);
      expect(result.blueprintEvidence!.unmapped_edits).toHaveLength(1); // only split_clip
      expect(result.blueprintEvidence!.consumer).toBe("blueprint_planner");
    });

    it("returns null evidence when no actionable ops", () => {
      const diff: HumanRevisionDiff = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        base_timeline_version: TIMELINE_VERSION,
        capability_profile_id: PROFILE_ID,
        status: "review_required",
        summary: { unmapped: 1 },
        unmapped_edits: [
          { classification: "plugin_effect", item_ref: "surface:y", review_required: true, reason: "test" },
        ],
      };

      const result = buildReentryEvidence(diff);

      expect(result.criticEvidence).toBeNull();
      expect(result.blueprintEvidence).toBeNull();
    });
  });

  describe("approval invalidation", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m35-phase4-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("marks approval_record as stale", () => {
      const doc: ProjectStateDoc = {
        version: 1,
        project_id: PROJECT_ID,
        current_state: "approved",
        approval_record: {
          status: "clean",
          approved_by: "operator",
          approved_at: "2026-03-21T10:00:00Z",
        },
        history: [],
      };
      fs.writeFileSync(
        path.join(tmpDir, "project_state.yaml"),
        stringifyYaml(doc),
      );

      const result = invalidateApproval(tmpDir, doc, HANDOFF_ID, "test invalidation");

      expect(result.approval_record!.status).toBe("stale");
      expect(result.history!.length).toBeGreaterThan(0);
    });

    it("records invalidation in history", () => {
      const doc: ProjectStateDoc = {
        version: 1,
        project_id: PROJECT_ID,
        current_state: "approved",
        approval_record: { status: "clean" },
        history: [],
      };
      fs.writeFileSync(
        path.join(tmpDir, "project_state.yaml"),
        stringifyYaml(doc),
      );

      invalidateApproval(tmpDir, doc, HANDOFF_ID, "diff-triggered invalidation");

      const last = doc.history![doc.history!.length - 1];
      expect(last.trigger).toBe("/handoff-reentry");
      expect(last.actor).toBe("diff-analyzer");
    });
  });

  describe("handoff_resolution update", () => {
    it("creates handoff_resolution if not present", () => {
      const doc: ProjectStateDoc = {
        version: 1,
        project_id: PROJECT_ID,
        current_state: "approved",
      };

      updateHandoffResolution(doc, HANDOFF_ID, "abcdef1234567890");

      expect(doc.handoff_resolution).toBeDefined();
      expect(doc.handoff_resolution!.handoff_id).toBe(HANDOFF_ID);
      expect(doc.handoff_resolution!.status).toBe("pending");
      expect(doc.handoff_resolution!.basis_report_hashes!.human_revision_diff).toBe("abcdef1234567890");
    });

    it("updates existing handoff_resolution with diff hash", () => {
      const doc: ProjectStateDoc = {
        version: 1,
        project_id: PROJECT_ID,
        current_state: "approved",
        handoff_resolution: {
          handoff_id: HANDOFF_ID,
          status: "decided",
          source_of_truth_decision: "engine_render",
          basis_report_hashes: {
            roundtrip_import_report: "sha256:existing",
          },
        },
      };

      updateHandoffResolution(doc, HANDOFF_ID, "newdiffhash12345");

      expect(doc.handoff_resolution!.basis_report_hashes!.roundtrip_import_report).toBe("sha256:existing");
      expect(doc.handoff_resolution!.basis_report_hashes!.human_revision_diff).toBe("newdiffhash12345");
    });

    it("replaces a stale handoff_resolution from a different handoff", () => {
      const doc: ProjectStateDoc = {
        version: 1,
        project_id: PROJECT_ID,
        current_state: "approved",
        handoff_resolution: {
          handoff_id: "HND_OLD",
          status: "decided",
          source_of_truth_decision: "engine_render",
        },
      };

      updateHandoffResolution(doc, HANDOFF_ID, "freshdiffhash1234");

      expect(doc.handoff_resolution!.handoff_id).toBe(HANDOFF_ID);
      expect(doc.handoff_resolution!.status).toBe("pending");
      expect(doc.handoff_resolution!.basis_report_hashes!.human_revision_diff).toBe("freshdiffhash1234");
    });
  });

  describe("computeHash", () => {
    it("returns consistent 16-char hex hash", () => {
      const hash1 = computeHash("test content");
      const hash2 = computeHash("test content");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(16);
      expect(hash1).toMatch(/^[0-9a-f]{16}$/);
    });

    it("different content produces different hash", () => {
      const hash1 = computeHash("content A");
      const hash2 = computeHash("content B");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("executeRecompileLoop", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m35-recompile-"));
      copyDirSync(SAMPLE_PROJECT, tmpDir);

      const doc: ProjectStateDoc = {
        version: 1,
        project_id: PROJECT_ID,
        current_state: "approved",
        approval_record: {
          status: "clean",
          approved_by: "operator",
          approved_at: "2026-03-21T10:00:00Z",
        },
        history: [],
      };
      fs.writeFileSync(
        path.join(tmpDir, "project_state.yaml"),
        stringifyYaml(doc),
      );
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("keeps approval clean until a proposal artifact exists", async () => {
      const diff: HumanRevisionDiff = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        base_timeline_version: TIMELINE_VERSION,
        capability_profile_id: PROFILE_ID,
        status: "clean",
        summary: { trim: 1 },
        operations: [
          { operation_id: "HRD_0001", type: "trim", target: { exchange_clip_id: "a" } },
        ],
      };

      const result = await executeRecompileLoop({
        projectDir: tmpDir,
        diff,
      });

      expect(result.approvalInvalidated).toBe(false);
      expect(result.stateTransition).toBeUndefined();

      const persisted = parseYaml(
        fs.readFileSync(path.join(tmpDir, "project_state.yaml"), "utf-8"),
      ) as ProjectStateDoc;
      expect(persisted.approval_record!.status).toBe("clean");
      expect(persisted.current_state).toBe("approved");
      expect(persisted.handoff_resolution?.basis_report_hashes?.human_revision_diff).toBeDefined();
    });

    it("invalidates approval after critic proposal promotion and compiles from the proposal patch", async () => {
      const diff: HumanRevisionDiff = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        base_timeline_version: TIMELINE_VERSION,
        capability_profile_id: PROFILE_ID,
        status: "clean",
        summary: { trim: 1 },
        operations: [
          { operation_id: "HRD_0001", type: "trim", target: { exchange_clip_id: "a" } },
        ],
      };

      const mockAgent: ReentryAgent = {
        async applyCriticEvidence() {
          return {
            reviewPatch: {
              timeline_version: "1",
              operations: [
                {
                  op: "add_marker",
                  reason: "roundtrip review marker",
                  label: "handoff marker",
                  new_timeline_in_frame: 12,
                },
              ],
            },
          };
        },
      };

      const result = await executeRecompileLoop({
        projectDir: tmpDir,
        diff,
      }, mockAgent);

      expect(result.approvalInvalidated).toBe(true);
      expect(result.stateTransition!.to).toBe("critique_ready");
      expect(result.compileResult).toBeDefined();
      expect(result.compileResult!.timeline.version).toBe("2");
      expect(result.compileResult!.timeline.markers.some((marker) => marker.label === "handoff marker")).toBe(true);

      const persisted = parseYaml(
        fs.readFileSync(path.join(tmpDir, "project_state.yaml"), "utf-8"),
      ) as ProjectStateDoc;
      expect(persisted.approval_record!.status).toBe("stale");
      expect(persisted.current_state).toBe("critique_ready");
      expect(fs.existsSync(path.join(tmpDir, "06_review/review_patch.json"))).toBe(true);
    });

    it("transitions to blueprint_ready when a blueprint proposal is promoted", async () => {
      const diff: HumanRevisionDiff = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        base_timeline_version: TIMELINE_VERSION,
        capability_profile_id: PROFILE_ID,
        status: "review_required",
        summary: { track_move: 1 },
        operations: [
          { operation_id: "HRD_0001", type: "track_move", target: { exchange_clip_id: "a" } },
        ],
      };

      const currentBlueprint = parseYaml(
        fs.readFileSync(path.join(tmpDir, "04_plan/edit_blueprint.yaml"), "utf-8"),
      ) as Record<string, unknown>;

      const result = await executeRecompileLoop({
        projectDir: tmpDir,
        diff,
      }, {
        async applyBlueprintEvidence() {
          return {
            editBlueprint: {
              ...currentBlueprint,
              sequence_goals: ["updated through reentry proposal"],
            } as any,
          };
        },
      });

      expect(result.stateTransition!.to).toBe("blueprint_ready");
      expect(result.compileResult).toBeDefined();

      const promotedBlueprint = parseYaml(
        fs.readFileSync(path.join(tmpDir, "04_plan/edit_blueprint.yaml"), "utf-8"),
      ) as Record<string, unknown>;
      expect(promotedBlueprint.sequence_goals).toEqual(["updated through reentry proposal"]);
    });

    it("calls mock agent with evidence and promotes returned proposals", async () => {
      const criticCalls: CriticReentryEvidence[] = [];
      const blueprintCalls: BlueprintReentryEvidence[] = [];

      const mockAgent: ReentryAgent = {
        async applyCriticEvidence(evidence) {
          criticCalls.push(evidence);
          return {
            reviewPatch: {
              timeline_version: "1",
              operations: [
                {
                  op: "add_marker",
                  reason: "critic proposal",
                  label: "critic marker",
                  new_timeline_in_frame: 24,
                },
              ],
            },
          };
        },
        async applyBlueprintEvidence(evidence) {
          blueprintCalls.push(evidence);
          const blueprint = parseYaml(
            fs.readFileSync(path.join(tmpDir, "04_plan/edit_blueprint.yaml"), "utf-8"),
          ) as Record<string, unknown>;
          return {
            editBlueprint: {
              ...blueprint,
              sequence_goals: ["critic + blueprint reentry"],
            } as any,
          };
        },
      };

      const diff: HumanRevisionDiff = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        base_timeline_version: TIMELINE_VERSION,
        capability_profile_id: PROFILE_ID,
        status: "review_required",
        summary: { trim: 1, track_move: 1, unmapped: 1 },
        operations: [
          { operation_id: "HRD_0001", type: "trim", target: { exchange_clip_id: "a" } },
          { operation_id: "HRD_0002", type: "track_move", target: { exchange_clip_id: "b" } },
        ],
        unmapped_edits: [
          { classification: "split_clip", item_ref: "clip:x", review_required: true, reason: "test" },
        ],
      };

      await executeRecompileLoop(
        { projectDir: tmpDir, diff },
        mockAgent,
      );

      expect(criticCalls).toHaveLength(1);
      expect(criticCalls[0].operations).toHaveLength(1);
      expect(criticCalls[0].operations[0].type).toBe("trim");

      expect(blueprintCalls).toHaveLength(1);
      expect(blueprintCalls[0].operations).toHaveLength(1);
      expect(blueprintCalls[0].unmapped_edits).toHaveLength(1);
      expect(fs.existsSync(path.join(tmpDir, "06_review/review_patch.json"))).toBe(true);
    });

    it("updates handoff_resolution with diff hash even when no action is taken", async () => {
      const diff: HumanRevisionDiff = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        base_timeline_version: TIMELINE_VERSION,
        capability_profile_id: PROFILE_ID,
        status: "clean",
        summary: { trim: 1 },
        operations: [
          { operation_id: "HRD_0001", type: "trim", target: { exchange_clip_id: "a" } },
        ],
      };

      await executeRecompileLoop({ projectDir: tmpDir, diff });

      const persisted = parseYaml(
        fs.readFileSync(path.join(tmpDir, "project_state.yaml"), "utf-8"),
      ) as ProjectStateDoc;
      expect(persisted.handoff_resolution).toBeDefined();
      expect(persisted.handoff_resolution!.handoff_id).toBe(HANDOFF_ID);
      expect(persisted.handoff_resolution!.basis_report_hashes!.human_revision_diff).toBeDefined();
    });

    it("does not transition when no actionable ops but still persists handoff_resolution", async () => {
      const diff: HumanRevisionDiff = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        base_timeline_version: TIMELINE_VERSION,
        capability_profile_id: PROFILE_ID,
        status: "review_required",
        summary: { unmapped: 1 },
        unmapped_edits: [
          { classification: "plugin_effect", item_ref: "surface:y", review_required: true, reason: "test" },
        ],
      };

      const result = await executeRecompileLoop({ projectDir: tmpDir, diff });

      expect(result.approvalInvalidated).toBe(false);
      expect(result.stateTransition).toBeUndefined();

      const persisted = parseYaml(
        fs.readFileSync(path.join(tmpDir, "project_state.yaml"), "utf-8"),
      ) as ProjectStateDoc;
      expect(persisted.current_state).toBe("approved");
      expect(persisted.handoff_resolution?.basis_report_hashes?.human_revision_diff).toBeDefined();
    });

    it("rejects invalid diff schema before mutating runtime state", async () => {
      const invalidDiff = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        base_timeline_version: TIMELINE_VERSION,
        capability_profile_id: PROFILE_ID,
        status: "clean",
        summary: {},
        operations: [
          {
            operation_id: "HRD_0001",
            type: "timeline_marker_add",
            target: { exchange_clip_id: "a" },
            marker_frame: -5,
          },
        ],
      } as HumanRevisionDiff;

      await expect(executeRecompileLoop({ projectDir: tmpDir, diff: invalidDiff })).rejects.toThrow(
        /schema validation failed/i,
      );

      const persisted = parseYaml(
        fs.readFileSync(path.join(tmpDir, "project_state.yaml"), "utf-8"),
      ) as ProjectStateDoc;
      expect(persisted.approval_record?.status).toBe("clean");
      expect(persisted.current_state).toBe("approved");
    });
  });
});
