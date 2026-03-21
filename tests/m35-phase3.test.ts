/**
 * M3.5 Phase 3: Import Path Tests
 *
 * Tests for:
 * - Stable ID mapping (exact, fallback, provisional, unmapped)
 * - Split detection (1 clip → 2 clips with same exchange_clip_id, non-overlapping)
 * - Duplicate detection (overlapping source ranges)
 * - Ambiguous one-to-many detection
 * - Unmapped edit detection (new clip without exchange_clip_id)
 * - Lossy item detection (capability profile based)
 * - Base timeline hash mismatch
 * - Gate 9 (unmapped → review_required)
 * - Import report schema validation
 * - Import status determination
 * - Offline import orchestration (no bridge required)
 * - Python bridge import (conditional: skip if opentimelineio not installed)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import { createRequire } from "node:module";
import {
  mapClips,
  normalizeOneToMany,
  classifyOneToMany,
  detectLossyItems,
  evaluateGate9,
  determineImportStatus,
  buildImportReport,
  executeHandoffImport,
  executeOfflineImport,
  type NormalizedClip,
  type ClipMapping,
  type RoundtripImportReport,
} from "../runtime/handoff/import.js";
import {
  BRIDGE_VERSION,
  evaluateFingerprintMismatch,
  type BridgeFingerprint,
  type NleCapabilityProfile,
} from "../runtime/handoff/bridge-contract.js";
import { sha256, type HandoffManifest } from "../runtime/handoff/export.js";

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
const HANDOFF_ID = "HND_5_20260321T120000Z";
const PROFILE_ID = "davinci_resolve_otio_v1";

function makeFingerprint(overrides?: Partial<BridgeFingerprint>): BridgeFingerprint {
  return {
    bridge_version: BRIDGE_VERSION,
    python_version: "3.11.0",
    opentimelineio_version: "0.17.0",
    bridge_script_hash: "sha256:abc123",
    loaded_adapter_modules: [],
    ...overrides,
  };
}

function makeManifest(overrides?: Partial<HandoffManifest>): HandoffManifest {
  return {
    version: 1,
    project_id: PROJECT_ID,
    handoff_id: HANDOFF_ID,
    exported_at: "2026-03-21T10:30:00Z",
    base_timeline: {
      path: "05_timeline/timeline.json",
      version: TIMELINE_VERSION,
      hash: "sha256:aabbcc",
      sequence: { fps_num: 24, fps_den: 1, width: 1920, height: 1080 },
    },
    approval_snapshot: {
      status: "clean",
      approved_by: "operator",
      approved_at: "2026-03-21T10:20:00Z",
    },
    capability_profile: { profile_id: PROFILE_ID },
    bridge: makeFingerprint(),
    source_map: [
      {
        asset_id: "AST_001",
        source_locator: "media/interview_a.mov",
      },
    ],
    ...overrides,
  } as HandoffManifest;
}

function makeProfile(): NleCapabilityProfile {
  return {
    version: 1,
    profile_id: PROFILE_ID,
    nle: {
      vendor: "Blackmagic Design",
      product: "DaVinci Resolve",
      version_range: ">=19",
    },
    otio: {
      interchange_format: "otio",
      metadata_namespace: "video_os",
    },
    stable_id: {
      primary_paths: {
        clip: "metadata.video_os.exchange_clip_id",
        track: "metadata.video_os.exchange_track_id",
      },
      fallback_paths: ["clip.name"],
      require_exact_metadata: true,
    },
    surfaces: {
      trim: { mode: "verified_roundtrip", tolerance_frames: 1 },
      reorder: {
        mode: "verified_roundtrip",
        detect_after: "ripple_normalized_peer_order",
      },
      enable_disable: { mode: "verified_roundtrip" },
      track_move: { mode: "provisional_roundtrip" },
      track_reorder: { mode: "report_only" },
      simple_transition: {
        mode: "provisional_roundtrip",
        allowed_types: ["dissolve", "wipe"],
      },
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
  };
}

function makeClip(
  clipId: string,
  overrides?: Partial<NormalizedClip>,
): NormalizedClip {
  return {
    exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:${clipId}`,
    clip_id: clipId,
    track_id: "V1",
    asset_id: "AST_001",
    segment_id: "SEG_001",
    src_in_us: 0,
    src_out_us: 1_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 24,
    ...overrides,
  };
}

function createExecuteHandoffImportFixture(options?: {
  timelineContent?: string;
  manifestHash?: string;
  manifestOverrides?: Partial<HandoffManifest>;
  importedOtioContent?: string;
  exportedOtioContent?: string;
  profile?: NleCapabilityProfile;
}) {
  const projectDir = fs.mkdtempSync(path.join("/tmp", "m35-phase3-import-"));
  const sessionDir = path.join(projectDir, "exports", "handoffs", HANDOFF_ID);
  const timelineDir = path.join(projectDir, "05_timeline");
  const outputDir = path.join(sessionDir, "import-output");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(timelineDir, { recursive: true });

  const timelineContent =
    options?.timelineContent ??
    JSON.stringify({ version: 1, project_id: PROJECT_ID, clips: [] }, null, 2);
  fs.writeFileSync(path.join(timelineDir, "timeline.json"), timelineContent, "utf-8");

  const baseManifest = makeManifest();
  const manifestOverrides = options?.manifestOverrides;
  const manifest: HandoffManifest = {
    ...baseManifest,
    ...manifestOverrides,
    base_timeline: {
      ...baseManifest.base_timeline,
      ...manifestOverrides?.base_timeline,
      path: "05_timeline/timeline.json",
      hash: options?.manifestHash ?? sha256(timelineContent),
    },
  };

  const manifestPath = path.join(sessionDir, "handoff_manifest.yaml");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  const profilePath = path.join(projectDir, "resolve-v1.yaml");
  fs.writeFileSync(
    profilePath,
    JSON.stringify(options?.profile ?? makeProfile(), null, 2),
    "utf-8",
  );

  const importedOtioPath = path.join(sessionDir, "imported_handoff.otio");
  fs.writeFileSync(
    importedOtioPath,
    options?.importedOtioContent ?? "not-an-otio-file",
    "utf-8",
  );

  const exportedOtioPath = path.join(sessionDir, "handoff_timeline.otio");
  fs.writeFileSync(
    exportedOtioPath,
    options?.exportedOtioContent ?? "not-an-otio-file",
    "utf-8",
  );

  return {
    projectDir,
    sessionDir,
    manifest,
    manifestPath,
    profilePath,
    importedOtioPath,
    exportedOtioPath,
    outputDir,
    cleanup() {
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("M3.5 Phase 3: Import Path", () => {
  // ── Stable ID Mapping ──────────────────────────────────────────

  describe("mapClips — Stable ID Mapping", () => {
    it("maps clips by exact exchange_clip_id", () => {
      const exported = [makeClip("CLP_001"), makeClip("CLP_002")];
      const imported = [makeClip("CLP_001"), makeClip("CLP_002")];

      const result = mapClips(exported, imported, PROJECT_ID, TIMELINE_VERSION);

      expect(result.mapped).toHaveLength(2);
      expect(result.unmapped).toHaveLength(0);
      expect(result.mapped[0].confidence).toBe("exact");
      expect(result.mapped[1].confidence).toBe("exact");
    });

    it("maps clips by clip_id + timeline_version fallback", () => {
      const exported = [makeClip("CLP_001")];
      // Imported clip lost exchange_clip_id but has clip_id
      const imported = [
        makeClip("CLP_001", { exchange_clip_id: "" }),
      ];

      const result = mapClips(exported, imported, PROJECT_ID, TIMELINE_VERSION);

      expect(result.mapped).toHaveLength(1);
      expect(result.mapped[0].confidence).toBe("fallback");
      expect(result.mapped[0].exportedExchangeClipId).toBe(
        `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
      );
    });

    it("upgrades fallback to provisional when stable metadata was dropped", () => {
      const exported = [makeClip("CLP_001")];
      const imported = [
        makeClip("CLP_001", {
          exchange_clip_id: "",
          metadata_lost: true,
        }),
      ];

      const result = mapClips(exported, imported, PROJECT_ID, TIMELINE_VERSION);

      expect(result.mapped).toHaveLength(1);
      expect(result.mapped[0].confidence).toBe("provisional");
    });

    it("maps clips by human-readable name fallback", () => {
      const exported = [makeClip("CLP_001")];
      const imported = [
        makeClip("CLP_001", {
          exchange_clip_id: "",
          clip_id: "",
          name: "CLP_001 SEG_001",
        }),
      ];

      const result = mapClips(exported, imported, PROJECT_ID, TIMELINE_VERSION);

      expect(result.mapped).toHaveLength(1);
      expect(result.mapped[0].confidence).toBe("fallback");
    });

    it("maps clips by source signature as provisional", () => {
      const exported = [
        makeClip("CLP_001", {
          asset_id: "AST_X",
          src_in_us: 5000,
          src_out_us: 10000,
        }),
      ];
      const imported = [
        makeClip("CLP_001", {
          exchange_clip_id: "",
          clip_id: "",
          asset_id: "AST_X",
          src_in_us: 5000,
          src_out_us: 10000,
        }),
      ];

      const result = mapClips(exported, imported, PROJECT_ID, TIMELINE_VERSION);

      expect(result.mapped).toHaveLength(1);
      expect(result.mapped[0].confidence).toBe("provisional");
    });

    it("reports unmapped clips (no matching ID)", () => {
      const exported = [makeClip("CLP_001")];
      const imported = [
        makeClip("CLP_NEW", {
          exchange_clip_id: "",
          clip_id: "CLP_NEW",
          asset_id: "AST_NEW",
          src_in_us: 99000,
          src_out_us: 100000,
        }),
      ];

      const result = mapClips(exported, imported, PROJECT_ID, TIMELINE_VERSION);

      expect(result.mapped).toHaveLength(0);
      expect(result.unmapped).toHaveLength(1);
      expect(result.unmapped[0].clip_id).toBe("CLP_NEW");
    });

    it("handles mixed mapping confidence levels", () => {
      const exported = [
        makeClip("CLP_001"),
        makeClip("CLP_002"),
        makeClip("CLP_003", {
          asset_id: "AST_SIG",
          src_in_us: 50000,
          src_out_us: 60000,
        }),
      ];
      const imported = [
        // exact
        makeClip("CLP_001"),
        // fallback (lost exchange id)
        makeClip("CLP_002", { exchange_clip_id: "" }),
        // provisional (signature only)
        makeClip("CLP_003", {
          exchange_clip_id: "",
          clip_id: "",
          asset_id: "AST_SIG",
          src_in_us: 50000,
          src_out_us: 60000,
        }),
        // unmapped
        makeClip("CLP_NEW", {
          exchange_clip_id: "",
          clip_id: "CLP_NEW",
          asset_id: "AST_UNKNOWN",
        }),
      ];

      const result = mapClips(exported, imported, PROJECT_ID, TIMELINE_VERSION);

      expect(result.mapped).toHaveLength(3);
      expect(result.unmapped).toHaveLength(1);

      const exact = result.mapped.filter((m) => m.confidence === "exact");
      const fallback = result.mapped.filter((m) => m.confidence === "fallback");
      const provisional = result.mapped.filter(
        (m) => m.confidence === "provisional",
      );

      expect(exact).toHaveLength(1);
      expect(fallback).toHaveLength(1);
      expect(provisional).toHaveLength(1);
    });

    it("handles empty input", () => {
      const result = mapClips([], [], PROJECT_ID, TIMELINE_VERSION);
      expect(result.mapped).toHaveLength(0);
      expect(result.unmapped).toHaveLength(0);
    });
  });

  // ── Split Detection ────────────────────────────────────────────

  describe("normalizeOneToMany — Split Detection", () => {
    it("detects split: 1 clip → 2 non-overlapping clips", () => {
      const parentId = `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_003`;
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_003", {
            src_in_us: 0,
            src_out_us: 500_000,
            timeline_in_frame: 0,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
        {
          imported: makeClip("CLP_003", {
            src_in_us: 500_000,
            src_out_us: 1_000_000,
            timeline_in_frame: 12,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
      ];

      const result = normalizeOneToMany(mappings);

      expect(result.oneToOne).toHaveLength(0);
      expect(result.splitEntries).toHaveLength(1);
      expect(result.duplicateEntries).toHaveLength(0);

      const split = result.splitEntries[0];
      expect(split.parent_exchange_clip_id).toBe(parentId);
      expect(split.child_ids).toEqual([`${parentId}#S01`, `${parentId}#S02`]);
      expect(split.review_required).toBe(true);
    });

    it("detects split: 1 clip → 3 non-overlapping clips", () => {
      const parentId = `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_005`;
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_005", {
            src_in_us: 0,
            src_out_us: 300_000,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
        {
          imported: makeClip("CLP_005", {
            src_in_us: 300_000,
            src_out_us: 600_000,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
        {
          imported: makeClip("CLP_005", {
            src_in_us: 600_000,
            src_out_us: 1_000_000,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
      ];

      const result = normalizeOneToMany(mappings);

      expect(result.splitEntries).toHaveLength(1);
      expect(result.splitEntries[0].child_ids).toHaveLength(3);
      expect(result.splitEntries[0].child_ids[2]).toBe(`${parentId}#S03`);
    });

    it("sorts split children by src_in_us → timeline_in_frame", () => {
      const parentId = `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_010`;
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_010", {
            src_in_us: 500_000,
            src_out_us: 1_000_000,
            timeline_in_frame: 24,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
        {
          imported: makeClip("CLP_010", {
            src_in_us: 0,
            src_out_us: 500_000,
            timeline_in_frame: 0,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
      ];

      const result = normalizeOneToMany(mappings);

      expect(result.splitEntries).toHaveLength(1);
      // First child should be the one with smaller src_in_us
      expect(result.splitEntries[0].child_ids[0]).toBe(`${parentId}#S01`);
    });
  });

  // ── Duplicate Detection ────────────────────────────────────────

  describe("normalizeOneToMany — Duplicate Detection", () => {
    it("detects duplicate: 2 clips with overlapping source ranges", () => {
      const parentId = `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_008`;
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_008", {
            src_in_us: 0,
            src_out_us: 1_000_000,
            timeline_in_frame: 0,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
        {
          imported: makeClip("CLP_008", {
            src_in_us: 0,
            src_out_us: 1_000_000,
            timeline_in_frame: 48,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
      ];

      const result = normalizeOneToMany(mappings);

      expect(result.duplicateEntries).toHaveLength(1);
      expect(result.splitEntries).toHaveLength(0);

      const dup = result.duplicateEntries[0];
      expect(dup.parent_exchange_clip_id).toBe(parentId);
      expect(dup.retained_exchange_clip_id).toBe(parentId);
      expect(dup.copy_ids).toEqual([`${parentId}#D01`]);
      expect(dup.provenance.basis).toBe("duplicate_metadata_collision");
      expect(dup.review_required).toBe(true);
    });

    it("detects duplicate with partial overlap", () => {
      const parentId = `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_009`;
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_009", {
            src_in_us: 0,
            src_out_us: 700_000,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
        {
          imported: makeClip("CLP_009", {
            src_in_us: 500_000,
            src_out_us: 1_000_000,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
      ];

      const result = normalizeOneToMany(mappings);
      expect(result.duplicateEntries).toHaveLength(1);
    });
  });

  // ── Ambiguous One-to-Many ──────────────────────────────────────

  describe("normalizeOneToMany — Ambiguous Detection", () => {
    it("detects ambiguous when mix of overlap and non-overlap", () => {
      const parentId = `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_020`;
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_020", {
            src_in_us: 0,
            src_out_us: 400_000,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
        {
          imported: makeClip("CLP_020", {
            src_in_us: 300_000,
            src_out_us: 700_000,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
        {
          imported: makeClip("CLP_020", {
            src_in_us: 800_000,
            src_out_us: 1_000_000,
          }),
          exportedExchangeClipId: parentId,
          confidence: "exact",
        },
      ];

      const result = normalizeOneToMany(mappings);
      expect(result.ambiguousEntries).toHaveLength(1);

      const entry = result.ambiguousEntries[0];
      expect(entry.parent_exchange_clip_id).toBe(parentId);
      expect(entry.candidates).toHaveLength(3);
      expect(entry.review_required).toBe(true);
    });
  });

  // ── classifyOneToMany ──────────────────────────────────────────

  describe("classifyOneToMany", () => {
    it("returns 'split' for non-overlapping ranges", () => {
      const sorted: ClipMapping[] = [
        {
          imported: makeClip("A", { src_in_us: 0, src_out_us: 500_000 }),
          exportedExchangeClipId: "parent",
          confidence: "exact",
        },
        {
          imported: makeClip("A", { src_in_us: 500_000, src_out_us: 1_000_000 }),
          exportedExchangeClipId: "parent",
          confidence: "exact",
        },
      ];
      expect(classifyOneToMany(sorted)).toBe("split");
    });

    it("returns 'duplicate' for fully overlapping ranges", () => {
      const sorted: ClipMapping[] = [
        {
          imported: makeClip("A", { src_in_us: 0, src_out_us: 1_000_000 }),
          exportedExchangeClipId: "parent",
          confidence: "exact",
        },
        {
          imported: makeClip("A", { src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 48 }),
          exportedExchangeClipId: "parent",
          confidence: "exact",
        },
      ];
      expect(classifyOneToMany(sorted)).toBe("duplicate");
    });

    it("returns 'ambiguous' for mixed overlap/non-overlap", () => {
      const sorted: ClipMapping[] = [
        {
          imported: makeClip("A", { src_in_us: 0, src_out_us: 600_000 }),
          exportedExchangeClipId: "parent",
          confidence: "exact",
        },
        {
          imported: makeClip("A", { src_in_us: 400_000, src_out_us: 800_000 }),
          exportedExchangeClipId: "parent",
          confidence: "exact",
        },
        {
          imported: makeClip("A", { src_in_us: 900_000, src_out_us: 1_200_000 }),
          exportedExchangeClipId: "parent",
          confidence: "exact",
        },
      ];
      expect(classifyOneToMany(sorted)).toBe("ambiguous");
    });
  });

  // ── One-to-one passthrough ─────────────────────────────────────

  describe("normalizeOneToMany — one-to-one passthrough", () => {
    it("passes 1:1 mappings through to oneToOne", () => {
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_001"),
          exportedExchangeClipId: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
          confidence: "exact",
        },
        {
          imported: makeClip("CLP_002"),
          exportedExchangeClipId: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_002`,
          confidence: "fallback",
        },
      ];

      const result = normalizeOneToMany(mappings);

      expect(result.oneToOne).toHaveLength(2);
      expect(result.splitEntries).toHaveLength(0);
      expect(result.duplicateEntries).toHaveLength(0);
      expect(result.ambiguousEntries).toHaveLength(0);
    });
  });

  // ── Unmapped Edit Detection ────────────────────────────────────

  describe("Unmapped Edit Detection", () => {
    it("detects unmapped clips from mapClips output", () => {
      const exported = [makeClip("CLP_001")];
      const imported = [
        makeClip("CLP_001"),
        makeClip("CLP_NEW", {
          exchange_clip_id: "",
          clip_id: "CLP_NEW",
          asset_id: "AST_NEW",
          src_in_us: 2_000_000,
          src_out_us: 3_000_000,
        }),
      ];

      const result = mapClips(exported, imported, PROJECT_ID, TIMELINE_VERSION);

      expect(result.mapped).toHaveLength(1);
      expect(result.unmapped).toHaveLength(1);
      expect(result.unmapped[0].clip_id).toBe("CLP_NEW");
    });
  });

  // ── Lossy Item Detection ───────────────────────────────────────

  describe("detectLossyItems", () => {
    const profile = makeProfile();

    it("does not flag lossy surfaces without imported evidence", () => {
      const result = detectLossyItems(profile, [], [], [], [], []);

      expect(result.lossyItems).toHaveLength(0);
      expect(result.unsupportedItems).toHaveLength(0);
    });

    it("flags lossy evidence on imported mapped clips only when present", () => {
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_001", {
            effect_names: ["Glow"],
            vendor_metadata_keys: ["color.grade"],
          }),
          exportedExchangeClipId: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
          confidence: "exact",
        },
        {
          imported: makeClip("CLP_002", {
            track_kind: "audio",
            track_vendor_metadata_keys: ["fairlight.eq"],
          }),
          exportedExchangeClipId: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_002`,
          confidence: "exact",
        },
      ];

      const result = detectLossyItems(profile, mappings, [], [], [], []);

      const classifications = result.lossyItems.map((i) => i.classification);
      expect(classifications).toContain("plugin_effect");
      expect(classifications).toContain("color_finish");
      expect(classifications).toContain("advanced_audio_finish");
    });

    it("flags vendor-only metadata as unsupported", () => {
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_003", {
            vendor_metadata_keys: ["vendor.magic_blob"],
          }),
          exportedExchangeClipId: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_003`,
          confidence: "exact",
        },
      ];

      const result = detectLossyItems(profile, mappings, [], [], [], []);

      expect(result.unsupportedItems).toHaveLength(1);
      expect(result.unsupportedItems[0].classification).toBe("unknown_vendor_extension");
    });

    it("flags unmapped clips as missing_stable_id", () => {
      const unmapped = [makeClip("CLP_LOST", { exchange_clip_id: "" })];
      const result = detectLossyItems(profile, [], unmapped, [], [], []);

      expect(result.unmappedItems).toHaveLength(1);
      expect(result.unmappedItems[0].classification).toBe("missing_stable_id");
    });

    it("flags mapped clips that dropped stable metadata", () => {
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_001", {
            exchange_clip_id: "",
            metadata_lost: true,
          }),
          exportedExchangeClipId: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
          confidence: "provisional",
        },
      ];

      const result = detectLossyItems(profile, mappings, [], [], [], []);

      expect(result.droppedStableMetadataCount).toBe(1);
      expect(result.unmappedItems).toHaveLength(1);
      expect(result.unmappedItems[0].classification).toBe("missing_stable_id");
      expect(result.unmappedItems[0].item_ref).toBe(
        `clip:${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
      );
    });

    it("flags split items in unmapped", () => {
      const splitEntries = [
        {
          parent_exchange_clip_id: "proj:5:CLP_003",
          child_ids: ["proj:5:CLP_003#S01", "proj:5:CLP_003#S02"],
          review_required: true,
        },
      ];
      const result = detectLossyItems(profile, [], [], splitEntries, [], []);

      expect(result.unmappedItems).toHaveLength(1);
      expect(result.unmappedItems[0].classification).toBe("split_clip");
    });

    it("flags duplicate items in unmapped", () => {
      const dupEntries = [
        {
          parent_exchange_clip_id: "proj:5:CLP_008",
          retained_exchange_clip_id: "proj:5:CLP_008",
          copy_ids: ["proj:5:CLP_008#D01"],
          provenance: { basis: "duplicate_metadata_collision" },
          review_required: true,
        },
      ];
      const result = detectLossyItems(profile, [], [], [], dupEntries, []);

      expect(result.unmappedItems).toHaveLength(1);
      expect(result.unmappedItems[0].classification).toBe("duplicated_clip");
    });

    it("flags ambiguous items in unmapped", () => {
      const ambEntries = [
        {
          parent_exchange_clip_id: "proj:5:CLP_020",
          candidates: ["proj:5:CLP_020#A01", "proj:5:CLP_020#A02"],
          reason: "test",
          review_required: true,
        },
      ];
      const result = detectLossyItems(profile, [], [], [], [], ambEntries);

      expect(result.unmappedItems).toHaveLength(1);
      expect(result.unmappedItems[0].classification).toBe("ambiguous_one_to_many");
    });
  });

  // ── Gate 9: Review Required ────────────────────────────────────

  describe("evaluateGate9", () => {
    const profile = makeProfile();

    it("returns true when unmapped clips exist", () => {
      const result = evaluateGate9([], [makeClip("LOST")], [], [], [], profile);
      expect(result).toBe(true);
    });

    it("returns true when provisional mapping exists", () => {
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_001"),
          exportedExchangeClipId: "x",
          confidence: "provisional",
        },
      ];
      const result = evaluateGate9(mappings, [], [], [], [], profile);
      expect(result).toBe(true);
    });

    it("returns true when split entries exist", () => {
      const splits = [
        {
          parent_exchange_clip_id: "x",
          child_ids: ["x#S01", "x#S02"],
          review_required: true,
        },
      ];
      const result = evaluateGate9([], [], splits, [], [], profile);
      expect(result).toBe(true);
    });

    it("returns true when duplicate entries exist", () => {
      const dups = [
        {
          parent_exchange_clip_id: "x",
          retained_exchange_clip_id: "x",
          copy_ids: ["x#D01"],
          provenance: { basis: "test" },
          review_required: true,
        },
      ];
      const result = evaluateGate9([], [], [], dups, [], profile);
      expect(result).toBe(true);
    });

    it("returns true when ambiguous entries exist", () => {
      const ambs = [
        {
          parent_exchange_clip_id: "x",
          candidates: ["a", "b"],
          reason: "test",
          review_required: true,
        },
      ];
      const result = evaluateGate9([], [], [], [], ambs, profile);
      expect(result).toBe(true);
    });

    it("returns true when stable metadata was dropped", () => {
      const result = evaluateGate9([], [], [], [], [], profile, {
        droppedStableMetadataCount: 1,
      });
      expect(result).toBe(true);
    });

    it("returns true when lossy or unsupported evidence exists", () => {
      expect(
        evaluateGate9([], [], [], [], [], profile, {
          lossyCount: 1,
        }),
      ).toBe(true);
      expect(
        evaluateGate9([], [], [], [], [], profile, {
          unsupportedCount: 1,
        }),
      ).toBe(true);
    });

    it("returns false when all mappings are exact and no issues", () => {
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_001"),
          exportedExchangeClipId: "x",
          confidence: "exact",
        },
      ];
      const result = evaluateGate9(mappings, [], [], [], [], profile);
      expect(result).toBe(false);
    });

    it("returns false for fallback mappings without policy trigger", () => {
      const mappings: ClipMapping[] = [
        {
          imported: makeClip("CLP_001"),
          exportedExchangeClipId: "x",
          confidence: "fallback",
        },
      ];
      const result = evaluateGate9(mappings, [], [], [], [], profile);
      expect(result).toBe(false);
    });
  });

  // ── Import Status Determination ────────────────────────────────

  describe("determineImportStatus", () => {
    it("returns 'success' for clean import", () => {
      expect(determineImportStatus(false, 0, 10, "ok")).toBe("success");
    });

    it("returns 'partial' when review required", () => {
      expect(determineImportStatus(true, 2, 10, "ok")).toBe("partial");
    });

    it("returns 'partial' for bridge patch-only diff", () => {
      expect(determineImportStatus(false, 0, 10, "partial")).toBe("partial");
    });

    it("returns 'failed' for bridge major/minor diff", () => {
      expect(determineImportStatus(false, 0, 10, "failed")).toBe("failed");
    });

    it("returns 'failed' when no clips imported", () => {
      expect(determineImportStatus(false, 0, 0, "ok")).toBe("failed");
    });

    it("returns 'failed' when all clips unmapped", () => {
      expect(determineImportStatus(true, 5, 5, "ok")).toBe("failed");
    });
  });

  // ── Import Report Schema Validation ────────────────────────────

  describe("Import Report — Schema Validation", () => {
    const validate = createValidator("roundtrip-import-report.schema.json");

    it("validates a success report", () => {
      const report: RoundtripImportReport = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        imported_at: "2026-03-21T12:05:00Z",
        capability_profile_id: PROFILE_ID,
        status: "success",
        base_timeline: {
          version: TIMELINE_VERSION,
          hash: "sha256:aabbcc",
        },
        bridge: makeFingerprint(),
        mapping_summary: {
          exported_clip_count: 5,
          imported_clip_count: 5,
          exact_matches: 5,
          fallback_matches: 0,
          provisional_matches: 0,
          split_items: 0,
          duplicate_id_items: 0,
          ambiguous_one_to_many_items: 0,
          unmapped_items: 0,
        },
      };

      const valid = validate(report);
      if (!valid) {
        console.error("Schema errors:", validate.errors);
      }
      expect(valid).toBe(true);
    });

    it("validates a partial report with one-to-many and loss", () => {
      const report: RoundtripImportReport = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        imported_at: "2026-03-21T12:05:00Z",
        capability_profile_id: PROFILE_ID,
        status: "partial",
        base_timeline: {
          version: TIMELINE_VERSION,
          hash: "sha256:aabbcc",
        },
        bridge: makeFingerprint(),
        mapping_summary: {
          exported_clip_count: 24,
          imported_clip_count: 26,
          exact_matches: 22,
          fallback_matches: 1,
          provisional_matches: 1,
          split_items: 1,
          duplicate_id_items: 1,
          ambiguous_one_to_many_items: 0,
          unmapped_items: 3,
        },
        one_to_many_items: {
          split_entries: [
            {
              parent_exchange_clip_id: `${PROJECT_ID}:5:CLP_003`,
              child_ids: [
                `${PROJECT_ID}:5:CLP_003#S01`,
                `${PROJECT_ID}:5:CLP_003#S02`,
              ],
              review_required: true,
            },
          ],
          duplicate_entries: [
            {
              parent_exchange_clip_id: `${PROJECT_ID}:5:CLP_008`,
              retained_exchange_clip_id: `${PROJECT_ID}:5:CLP_008`,
              copy_ids: [`${PROJECT_ID}:5:CLP_008#D01`],
              provenance: { basis: "duplicate_metadata_collision" },
              review_required: true,
            },
          ],
        },
        loss_summary: {
          review_required: true,
          lossy_items: [
            {
              classification: "color_finish",
              item_ref: "surface:color_finish",
              reason: "capability profile marks color_finish as lossy",
            },
          ],
          unmapped_items: [
            {
              classification: "split_clip",
              item_ref: `clip:${PROJECT_ID}:5:CLP_003`,
              reason: "one-to-many stable ID cannot be auto-reduced to a single canonical diff operation",
            },
            {
              classification: "missing_stable_id",
              item_ref: "clip@track=V1,index=0",
              reason: "imported clip has no matching exchange_clip_id in exported base",
            },
          ],
        },
        notes: ["No canonical artifact was mutated."],
      };

      const valid = validate(report);
      if (!valid) {
        console.error("Schema errors:", validate.errors);
      }
      expect(valid).toBe(true);
    });

    it("validates a failed report", () => {
      const report: RoundtripImportReport = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        imported_at: "2026-03-21T12:05:00Z",
        capability_profile_id: PROFILE_ID,
        status: "failed",
        base_timeline: {
          version: TIMELINE_VERSION,
          hash: "sha256:aabbcc",
        },
        bridge: makeFingerprint(),
        mapping_summary: {
          exported_clip_count: 10,
          imported_clip_count: 0,
          exact_matches: 0,
          fallback_matches: 0,
          provisional_matches: 0,
          split_items: 0,
          duplicate_id_items: 0,
          ambiguous_one_to_many_items: 0,
          unmapped_items: 0,
        },
      };

      const valid = validate(report);
      expect(valid).toBe(true);
    });

    it("rejects report with invalid status", () => {
      const report = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        imported_at: "2026-03-21T12:05:00Z",
        capability_profile_id: PROFILE_ID,
        status: "invalid_status",
        base_timeline: {
          version: TIMELINE_VERSION,
          hash: "sha256:aabbcc",
        },
        bridge: makeFingerprint(),
        mapping_summary: {
          exported_clip_count: 0,
          imported_clip_count: 0,
        },
      };

      expect(validate(report)).toBe(false);
    });

    it("rejects report without required fields", () => {
      const report = {
        version: 1,
        project_id: PROJECT_ID,
        // missing handoff_id, imported_at, etc.
      };

      expect(validate(report)).toBe(false);
    });

    it("rejects report with invalid handoff_id pattern", () => {
      const report = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: "INVALID_ID",
        imported_at: "2026-03-21T12:05:00Z",
        capability_profile_id: PROFILE_ID,
        status: "success",
        base_timeline: { version: "5", hash: "sha256:abc" },
        bridge: makeFingerprint(),
        mapping_summary: { exported_clip_count: 0, imported_clip_count: 0 },
      };

      expect(validate(report)).toBe(false);
    });

    it("rejects report with invalid hash pattern", () => {
      const report = {
        version: 1,
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        imported_at: "2026-03-21T12:05:00Z",
        capability_profile_id: PROFILE_ID,
        status: "success",
        base_timeline: { version: "5", hash: "md5:abc" },
        bridge: makeFingerprint(),
        mapping_summary: { exported_clip_count: 0, imported_clip_count: 0 },
      };

      expect(validate(report)).toBe(false);
    });
  });

  // ── Build Import Report ────────────────────────────────────────

  describe("buildImportReport", () => {
    const manifest = makeManifest();
    const profile = makeProfile();
    const fingerprint = makeFingerprint();

    it("builds a success report for clean 1:1 mapping", () => {
      const exported = [makeClip("CLP_001"), makeClip("CLP_002")];
      const mapped: ClipMapping[] = [
        {
          imported: makeClip("CLP_001"),
          exportedExchangeClipId: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
          confidence: "exact",
        },
        {
          imported: makeClip("CLP_002"),
          exportedExchangeClipId: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_002`,
          confidence: "exact",
        },
      ];
      const oneToMany = normalizeOneToMany(mapped);

      const report = buildImportReport(
        manifest,
        profile,
        fingerprint,
        exported,
        mapped,
        oneToMany,
        [],
        false,
        "success",
        "2026-03-21T12:05:00Z",
      );

      expect(report.status).toBe("success");
      expect(report.mapping_summary.exact_matches).toBe(2);
      expect(report.mapping_summary.unmapped_items).toBe(0);
      expect(report.project_id).toBe(PROJECT_ID);
      expect(report.handoff_id).toBe(HANDOFF_ID);
    });

    it("builds a partial report with unmapped items", () => {
      const exported = [makeClip("CLP_001")];
      const unmapped = [makeClip("CLP_NEW", { exchange_clip_id: "" })];
      const mapped: ClipMapping[] = [
        {
          imported: makeClip("CLP_001"),
          exportedExchangeClipId: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
          confidence: "exact",
        },
      ];
      const oneToMany = normalizeOneToMany(mapped);

      const report = buildImportReport(
        manifest,
        profile,
        fingerprint,
        exported,
        mapped,
        oneToMany,
        unmapped,
        true,
        "partial",
        "2026-03-21T12:05:00Z",
      );

      expect(report.status).toBe("partial");
      expect(report.mapping_summary.unmapped_items).toBe(1);
      expect(report.loss_summary).toBeDefined();
      expect(report.loss_summary!.review_required).toBe(true);
    });

    it("includes NLE session when provided", () => {
      const exported = [makeClip("CLP_001")];
      const mapped: ClipMapping[] = [
        {
          imported: makeClip("CLP_001"),
          exportedExchangeClipId: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
          confidence: "exact",
        },
      ];
      const oneToMany = normalizeOneToMany(mapped);

      const report = buildImportReport(
        manifest,
        profile,
        fingerprint,
        exported,
        mapped,
        oneToMany,
        [],
        false,
        "success",
        "2026-03-21T12:05:00Z",
        {
          vendor: "Blackmagic Design",
          product: "DaVinci Resolve",
          observed_version: "19.0.1",
        },
      );

      expect(report.nle_session).toBeDefined();
      expect(report.nle_session!.vendor).toBe("Blackmagic Design");
    });

    it("built report passes schema validation", () => {
      const validate = createValidator("roundtrip-import-report.schema.json");
      const exported = [makeClip("CLP_001")];
      const mapped: ClipMapping[] = [
        {
          imported: makeClip("CLP_001"),
          exportedExchangeClipId: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
          confidence: "exact",
        },
      ];
      const oneToMany = normalizeOneToMany(mapped);

      const report = buildImportReport(
        manifest,
        profile,
        fingerprint,
        exported,
        mapped,
        oneToMany,
        [],
        false,
        "success",
        "2026-03-21T12:05:00Z",
      );

      const valid = validate(report);
      if (!valid) {
        console.error("Schema errors:", validate.errors);
      }
      expect(valid).toBe(true);
    });
  });

  // ── Offline Import Orchestration ───────────────────────────────

  describe("executeOfflineImport", () => {
    it("returns success for perfect round-trip", () => {
      const manifest = makeManifest();
      const profile = makeProfile();
      const fingerprint = makeFingerprint();
      const clips = [makeClip("CLP_001"), makeClip("CLP_002"), makeClip("CLP_003")];

      const result = executeOfflineImport({
        manifest,
        profile,
        exportedClips: clips,
        importedClips: clips,
        bridgeFingerprint: fingerprint,
      });

      expect(result.reviewRequired).toBe(false);
      expect(result.report.status).toBe("success");
      expect(result.report.mapping_summary.exact_matches).toBe(3);
      expect(result.report.mapping_summary.unmapped_items).toBe(0);
    });

    it("returns partial when unmapped clips exist", () => {
      const manifest = makeManifest();
      const profile = makeProfile();
      const fingerprint = makeFingerprint();
      const exported = [makeClip("CLP_001")];
      const imported = [
        makeClip("CLP_001"),
        makeClip("CLP_NEW", {
          exchange_clip_id: "",
          clip_id: "CLP_NEW",
          asset_id: "AST_NEW",
          src_in_us: 5_000_000,
          src_out_us: 6_000_000,
        }),
      ];

      const result = executeOfflineImport({
        manifest,
        profile,
        exportedClips: exported,
        importedClips: imported,
        bridgeFingerprint: fingerprint,
      });

      expect(result.reviewRequired).toBe(true);
      expect(result.report.status).toBe("partial");
      expect(result.report.mapping_summary.unmapped_items).toBe(1);
    });

    it("returns partial when split detected", () => {
      const manifest = makeManifest();
      const profile = makeProfile();
      const fingerprint = makeFingerprint();
      const exported = [makeClip("CLP_001")];
      const exchangeId = `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`;
      const imported = [
        makeClip("CLP_001", { src_in_us: 0, src_out_us: 500_000 }),
        makeClip("CLP_001", { src_in_us: 500_000, src_out_us: 1_000_000, timeline_in_frame: 12 }),
      ];

      const result = executeOfflineImport({
        manifest,
        profile,
        exportedClips: exported,
        importedClips: imported,
        bridgeFingerprint: fingerprint,
      });

      expect(result.reviewRequired).toBe(true);
      expect(result.report.status).toBe("partial");
      expect(result.report.mapping_summary.split_items).toBe(1);
      expect(result.report.one_to_many_items).toBeDefined();
      expect(result.report.one_to_many_items!.split_entries).toHaveLength(1);
    });

    it("returns partial when duplicate detected", () => {
      const manifest = makeManifest();
      const profile = makeProfile();
      const fingerprint = makeFingerprint();
      const exported = [makeClip("CLP_001")];
      const imported = [
        makeClip("CLP_001", { timeline_in_frame: 0 }),
        makeClip("CLP_001", { timeline_in_frame: 48 }),
      ];

      const result = executeOfflineImport({
        manifest,
        profile,
        exportedClips: exported,
        importedClips: imported,
        bridgeFingerprint: fingerprint,
      });

      expect(result.reviewRequired).toBe(true);
      expect(result.report.mapping_summary.duplicate_id_items).toBe(1);
    });

    it("returns partial for provisional mapping", () => {
      const manifest = makeManifest();
      const profile = makeProfile();
      const fingerprint = makeFingerprint();
      const exported = [
        makeClip("CLP_001", {
          asset_id: "AST_X",
          src_in_us: 5000,
          src_out_us: 10000,
        }),
      ];
      const imported = [
        makeClip("CLP_001", {
          exchange_clip_id: "",
          clip_id: "",
          asset_id: "AST_X",
          src_in_us: 5000,
          src_out_us: 10000,
        }),
      ];

      const result = executeOfflineImport({
        manifest,
        profile,
        exportedClips: exported,
        importedClips: imported,
        bridgeFingerprint: fingerprint,
      });

      expect(result.reviewRequired).toBe(true);
      expect(result.report.mapping_summary.provisional_matches).toBe(1);
    });

    it("returns partial and records missing_stable_id when metadata was dropped but fallback matched", () => {
      const manifest = makeManifest();
      const profile = makeProfile();
      const fingerprint = makeFingerprint();
      const exported = [makeClip("CLP_001")];
      const imported = [
        makeClip("CLP_001", {
          exchange_clip_id: "",
          metadata_lost: true,
        }),
      ];

      const result = executeOfflineImport({
        manifest,
        profile,
        exportedClips: exported,
        importedClips: imported,
        bridgeFingerprint: fingerprint,
      });

      expect(result.reviewRequired).toBe(true);
      expect(result.report.mapping_summary.provisional_matches).toBe(1);
      expect(result.report.loss_summary?.unmapped_items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            classification: "missing_stable_id",
            item_ref: `clip:${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
          }),
        ]),
      );
    });

    it("returns failed when no clips imported", () => {
      const manifest = makeManifest();
      const profile = makeProfile();
      const fingerprint = makeFingerprint();
      const exported = [makeClip("CLP_001")];

      const result = executeOfflineImport({
        manifest,
        profile,
        exportedClips: exported,
        importedClips: [],
        bridgeFingerprint: fingerprint,
      });

      expect(result.report.status).toBe("failed");
    });

    it("report from offline import passes schema validation", () => {
      const validate = createValidator("roundtrip-import-report.schema.json");
      const manifest = makeManifest();
      const profile = makeProfile();
      const fingerprint = makeFingerprint();
      const clips = [makeClip("CLP_001"), makeClip("CLP_002")];

      const result = executeOfflineImport({
        manifest,
        profile,
        exportedClips: clips,
        importedClips: clips,
        bridgeFingerprint: fingerprint,
        importedAt: "2026-03-21T12:05:00Z",
      });

      const valid = validate(result.report);
      if (!valid) {
        console.error("Schema errors:", validate.errors);
      }
      expect(valid).toBe(true);
    });

    it("partial report with split/dup/unmapped passes schema validation", () => {
      const validate = createValidator("roundtrip-import-report.schema.json");
      const manifest = makeManifest();
      const profile = makeProfile();
      const fingerprint = makeFingerprint();
      const exported = [
        makeClip("CLP_001"),
        makeClip("CLP_002"),
        makeClip("CLP_003"),
      ];
      const imported = [
        // CLP_001: exact 1:1
        makeClip("CLP_001"),
        // CLP_002: split → two non-overlapping
        makeClip("CLP_002", {
          src_in_us: 0,
          src_out_us: 500_000,
        }),
        makeClip("CLP_002", {
          src_in_us: 500_000,
          src_out_us: 1_000_000,
          timeline_in_frame: 12,
        }),
        // CLP_003: duplicate
        makeClip("CLP_003", { timeline_in_frame: 0 }),
        makeClip("CLP_003", { timeline_in_frame: 48 }),
        // New clip: unmapped
        makeClip("CLP_NEW", {
          exchange_clip_id: "",
          clip_id: "CLP_NEW",
          asset_id: "AST_NEW",
          src_in_us: 9_000_000,
          src_out_us: 10_000_000,
        }),
      ];

      const result = executeOfflineImport({
        manifest,
        profile,
        exportedClips: exported,
        importedClips: imported,
        bridgeFingerprint: fingerprint,
        importedAt: "2026-03-21T12:05:00Z",
      });

      expect(result.reviewRequired).toBe(true);
      expect(result.report.status).toBe("partial");

      const valid = validate(result.report);
      if (!valid) {
        console.error("Schema errors:", JSON.stringify(validate.errors, null, 2));
      }
      expect(valid).toBe(true);
    });
  });

  // ── Base Timeline Hash Mismatch ────────────────────────────────

  describe("executeHandoffImport — real path", () => {
    it("rejects a base timeline hash mismatch before bridge normalization", () => {
      const fixture = createExecuteHandoffImportFixture({
        timelineContent: JSON.stringify({ version: 1, project_id: PROJECT_ID, cuts: [1] }, null, 2),
        manifestHash: "sha256:different",
      });

      try {
        const result = executeHandoffImport({
          manifestPath: fixture.manifestPath,
          importedOtioPath: fixture.importedOtioPath,
          profilePath: fixture.profilePath,
          outputDir: fixture.outputDir,
        });

        expect("error" in result).toBe(true);
        if (!("error" in result)) {
          throw new Error("Expected executeHandoffImport to fail");
        }

        expect(result.error.code).toBe("BASE_HASH_MISMATCH");
        expect(result.error.details).toEqual(
          expect.objectContaining({
            expectedHash: "sha256:different",
            actualHash: sha256(
              JSON.stringify({ version: 1, project_id: PROJECT_ID, cuts: [1] }, null, 2),
            ),
          }),
        );
      } finally {
        fixture.cleanup();
      }
    });

    it("returns bridge failure details with request context on the real import path", () => {
      const fixture = createExecuteHandoffImportFixture();

      try {
        const result = executeHandoffImport({
          manifestPath: fixture.manifestPath,
          importedOtioPath: fixture.importedOtioPath,
          profilePath: fixture.profilePath,
          outputDir: fixture.outputDir,
          pythonPath: "/definitely/missing/python3",
        });

        expect("error" in result).toBe(true);
        if (!("error" in result)) {
          throw new Error("Expected executeHandoffImport to fail");
        }

        expect(result.error.code).toBe("BRIDGE_FAILED");
        expect(result.error.details).toEqual(
          expect.objectContaining({
            request_context: expect.objectContaining({
              command: "import_otio",
              input_path: fixture.importedOtioPath,
            }),
            stderr: expect.any(String),
            timed_out: false,
          }),
        );
      } finally {
        fixture.cleanup();
      }
    });
  });

  // ── Bridge Fingerprint Mismatch ────────────────────────────────

  describe("Bridge Fingerprint in Import Context", () => {
    it("ok for identical fingerprints", () => {
      const fp = makeFingerprint();
      expect(evaluateFingerprintMismatch(fp, fp)).toBe("ok");
    });

    it("partial for patch-only OTIO version diff", () => {
      const expected = makeFingerprint({ opentimelineio_version: "0.17.0" });
      const actual = makeFingerprint({ opentimelineio_version: "0.17.1" });
      expect(evaluateFingerprintMismatch(expected, actual)).toBe("partial");
    });

    it("failed for bridge version diff", () => {
      const expected = makeFingerprint({ bridge_version: "1.0.0" });
      const actual = makeFingerprint({ bridge_version: "2.0.0" });
      expect(evaluateFingerprintMismatch(expected, actual)).toBe("failed");
    });

    it("failed for OTIO major version diff", () => {
      const expected = makeFingerprint({ opentimelineio_version: "0.17.0" });
      const actual = makeFingerprint({ opentimelineio_version: "1.0.0" });
      expect(evaluateFingerprintMismatch(expected, actual)).toBe("failed");
    });
  });

  // ── Python Bridge Import (conditional) ─────────────────────────

  describe("Python Bridge Import (conditional)", () => {
    // Check if Python + OTIO available
    const hasPython = (() => {
      try {
        const r = child_process.spawnSync("python3", ["-c", "import opentimelineio"], {
          encoding: "utf-8",
          timeout: 5000,
        });
        return r.status === 0;
      } catch {
        return false;
      }
    })();

    const conditionalIt = hasPython ? it : it.skip;

    conditionalIt("import_otio command returns normalized data", () => {
      // This test requires Python + opentimelineio installed
      // It tests the bridge subprocess integration
      const bridgeScript = path.resolve("runtime/handoff/otio-bridge.py");

      // First we need an OTIO file. We'll create one via export then import it.
      const tmpDir = fs.mkdtempSync("/tmp/m35-phase3-bridge-");

      try {
        // Create a minimal bridge input for export
        const bridgeInput = {
          project_id: PROJECT_ID,
          timeline_version: TIMELINE_VERSION,
          handoff_id: HANDOFF_ID,
          capability_profile_id: PROFILE_ID,
          approval_status: "clean",
          sequence: { fps_num: 24, fps_den: 1, width: 1920, height: 1080 },
          tracks: {
            video: [
              {
                track_id: "V1",
                exchange_track_id: `${PROJECT_ID}:${TIMELINE_VERSION}:V1`,
                kind: "video",
                clips: [
                  {
                    clip_id: "CLP_001",
                    exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
                    track_id: "V1",
                    segment_id: "SEG_001",
                    asset_id: "AST_001",
                    beat_id: "BEAT_001",
                    role: "primary",
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    timeline_in_frame: 0,
                    timeline_duration_frames: 24,
                    source_locator: "media/test.mov",
                    capability_profile_id: PROFILE_ID,
                  },
                ],
              },
            ],
            audio: [],
          },
          markers: [],
        };

        const inputPath = path.join(tmpDir, "bridge_input.json");
        const otioPath = path.join(tmpDir, "test.otio");
        const normalizedPath = path.join(tmpDir, "normalized.json");
        fs.writeFileSync(inputPath, JSON.stringify(bridgeInput));

        // Export first
        const exportReq = {
          request_id: "test_export",
          command: "export_otio",
          input_path: inputPath,
          output_path: otioPath,
          options: { normalized_output_path: normalizedPath },
          expected_bridge_version: BRIDGE_VERSION,
        };

        const exportResult = child_process.spawnSync(
          "python3",
          [bridgeScript],
          {
            input: JSON.stringify(exportReq),
            encoding: "utf-8",
            timeout: 10000,
          },
        );
        expect(exportResult.status).toBe(0);
        expect(fs.existsSync(otioPath)).toBe(true);

        // Now import
        const importOutputPath = path.join(tmpDir, "imported.json");
        const importReq = {
          request_id: "test_import",
          command: "import_otio",
          input_path: otioPath,
          output_path: importOutputPath,
          options: {},
          expected_bridge_version: BRIDGE_VERSION,
        };

        const importResult = child_process.spawnSync(
          "python3",
          [bridgeScript],
          {
            input: JSON.stringify(importReq),
            encoding: "utf-8",
            timeout: 10000,
          },
        );

        expect(importResult.status).toBe(0);
        const response = JSON.parse(importResult.stdout);
        expect(response.ok).toBe(true);
        expect(response.payload_path).toBe(importOutputPath);

        // Verify the normalized data
        const normalized = JSON.parse(fs.readFileSync(importOutputPath, "utf-8"));
        expect(normalized.clips).toHaveLength(1);
        expect(normalized.clips[0].exchange_clip_id).toBe(
          `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
        );
        expect(normalized.split_duplicate_hints).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    conditionalIt("import_otio keeps clips whose exchange_clip_id was dropped", () => {
      const bridgeScript = path.resolve("runtime/handoff/otio-bridge.py");
      const tmpDir = fs.mkdtempSync("/tmp/m35-phase3-metadata-loss-");

      try {
        const bridgeInput = {
          project_id: PROJECT_ID,
          timeline_version: TIMELINE_VERSION,
          handoff_id: HANDOFF_ID,
          capability_profile_id: PROFILE_ID,
          approval_status: "clean",
          sequence: { fps_num: 24, fps_den: 1, width: 1920, height: 1080 },
          tracks: {
            video: [
              {
                track_id: "V1",
                exchange_track_id: `${PROJECT_ID}:${TIMELINE_VERSION}:V1`,
                kind: "video",
                clips: [
                  {
                    clip_id: "CLP_001",
                    exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
                    track_id: "V1",
                    segment_id: "SEG_001",
                    asset_id: "AST_001",
                    beat_id: "BEAT_001",
                    role: "primary",
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    timeline_in_frame: 0,
                    timeline_duration_frames: 24,
                    source_locator: "media/test.mov",
                    capability_profile_id: PROFILE_ID,
                  },
                ],
              },
            ],
            audio: [],
          },
          markers: [],
        };

        const inputPath = path.join(tmpDir, "bridge_input.json");
        const otioPath = path.join(tmpDir, "metadata-loss.otio");
        fs.writeFileSync(inputPath, JSON.stringify(bridgeInput), "utf-8");

        const exportReq = {
          request_id: "test_export",
          command: "export_otio",
          input_path: inputPath,
          output_path: otioPath,
          options: {},
          expected_bridge_version: BRIDGE_VERSION,
        };
        const exportResult = child_process.spawnSync("python3", [bridgeScript], {
          input: JSON.stringify(exportReq),
          encoding: "utf-8",
          timeout: 10000,
        });

        expect(exportResult.status).toBe(0);

        const otioJson = JSON.parse(fs.readFileSync(otioPath, "utf-8"));
        const stripExchangeClipId = (node: unknown): boolean => {
          if (Array.isArray(node)) {
            for (const entry of node) {
              if (stripExchangeClipId(entry)) return true;
            }
            return false;
          }
          if (!node || typeof node !== "object") {
            return false;
          }
          const record = node as Record<string, unknown>;
          const metadata = record.metadata;
          if (metadata && typeof metadata === "object") {
            const videoOs = (metadata as Record<string, unknown>).video_os;
            if (videoOs && typeof videoOs === "object" && "exchange_clip_id" in videoOs) {
              delete (videoOs as Record<string, unknown>).exchange_clip_id;
              return true;
            }
          }
          for (const value of Object.values(record)) {
            if (stripExchangeClipId(value)) return true;
          }
          return false;
        };

        expect(stripExchangeClipId(otioJson)).toBe(true);
        fs.writeFileSync(otioPath, JSON.stringify(otioJson, null, 2), "utf-8");

        const importOutputPath = path.join(tmpDir, "imported.json");
        const importReq = {
          request_id: "test_import",
          command: "import_otio",
          input_path: otioPath,
          output_path: importOutputPath,
          options: {},
          expected_bridge_version: BRIDGE_VERSION,
        };
        const importResult = child_process.spawnSync("python3", [bridgeScript], {
          input: JSON.stringify(importReq),
          encoding: "utf-8",
          timeout: 10000,
        });

        expect(importResult.status).toBe(0);
        const normalized = JSON.parse(fs.readFileSync(importOutputPath, "utf-8"));
        expect(normalized.clips).toHaveLength(1);
        expect(normalized.clips[0].exchange_clip_id).toBe("");
        expect(normalized.clips[0].metadata_lost).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    conditionalIt("import_otio detects split hints", () => {
      const bridgeScript = path.resolve("runtime/handoff/otio-bridge.py");
      const tmpDir = fs.mkdtempSync("/tmp/m35-phase3-split-");

      try {
        // Create bridge input with 2 clips sharing the same exchange_clip_id
        // (simulating what happens when NLE splits a clip)
        const bridgeInput = {
          project_id: PROJECT_ID,
          timeline_version: TIMELINE_VERSION,
          handoff_id: HANDOFF_ID,
          capability_profile_id: PROFILE_ID,
          approval_status: "clean",
          sequence: { fps_num: 24, fps_den: 1, width: 1920, height: 1080 },
          tracks: {
            video: [
              {
                track_id: "V1",
                exchange_track_id: `${PROJECT_ID}:${TIMELINE_VERSION}:V1`,
                kind: "video",
                clips: [
                  {
                    clip_id: "CLP_001",
                    exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
                    track_id: "V1",
                    segment_id: "SEG_001",
                    asset_id: "AST_001",
                    beat_id: "BEAT_001",
                    role: "primary",
                    src_in_us: 0,
                    src_out_us: 500_000,
                    timeline_in_frame: 0,
                    timeline_duration_frames: 12,
                    source_locator: "media/test.mov",
                    capability_profile_id: PROFILE_ID,
                  },
                  {
                    clip_id: "CLP_001",
                    exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:CLP_001`,
                    track_id: "V1",
                    segment_id: "SEG_001",
                    asset_id: "AST_001",
                    beat_id: "BEAT_001",
                    role: "primary",
                    src_in_us: 500_000,
                    src_out_us: 1_000_000,
                    timeline_in_frame: 12,
                    timeline_duration_frames: 12,
                    source_locator: "media/test.mov",
                    capability_profile_id: PROFILE_ID,
                  },
                ],
              },
            ],
            audio: [],
          },
          markers: [],
        };

        const inputPath = path.join(tmpDir, "bridge_input.json");
        const otioPath = path.join(tmpDir, "split_test.otio");
        fs.writeFileSync(inputPath, JSON.stringify(bridgeInput));

        // Export
        const exportReq = {
          request_id: "test_export",
          command: "export_otio",
          input_path: inputPath,
          output_path: otioPath,
          options: {},
          expected_bridge_version: BRIDGE_VERSION,
        };
        child_process.spawnSync("python3", [bridgeScript], {
          input: JSON.stringify(exportReq),
          encoding: "utf-8",
          timeout: 10000,
        });

        // Import
        const importOutputPath = path.join(tmpDir, "imported.json");
        const importReq = {
          request_id: "test_import",
          command: "import_otio",
          input_path: otioPath,
          output_path: importOutputPath,
          options: {},
          expected_bridge_version: BRIDGE_VERSION,
        };
        const importResult = child_process.spawnSync(
          "python3",
          [bridgeScript],
          {
            input: JSON.stringify(importReq),
            encoding: "utf-8",
            timeout: 10000,
          },
        );

        expect(importResult.status).toBe(0);
        const normalized = JSON.parse(fs.readFileSync(importOutputPath, "utf-8"));

        // Should detect split hint
        expect(normalized.split_duplicate_hints.one_to_many_candidates).toHaveLength(1);
        expect(normalized.split_duplicate_hints.one_to_many_candidates[0].likely_type).toBe("split");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── End-to-end Integration (offline) ───────────────────────────

  describe("End-to-end Offline Import Integration", () => {
    it("full round-trip: export clips → same clips imported → success", () => {
      const validate = createValidator("roundtrip-import-report.schema.json");
      const manifest = makeManifest();
      const profile = makeProfile();
      const fingerprint = makeFingerprint();

      const clips = [
        makeClip("CLP_001", {
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 24,
        }),
        makeClip("CLP_002", {
          src_in_us: 1_000_000,
          src_out_us: 2_000_000,
          timeline_in_frame: 24,
          timeline_duration_frames: 24,
        }),
        makeClip("CLP_003", {
          src_in_us: 2_000_000,
          src_out_us: 3_000_000,
          timeline_in_frame: 48,
          timeline_duration_frames: 24,
        }),
      ];

      const result = executeOfflineImport({
        manifest,
        profile,
        exportedClips: clips,
        importedClips: clips,
        bridgeFingerprint: fingerprint,
        importedAt: "2026-03-21T12:05:00Z",
      });

      expect(result.reviewRequired).toBe(false);
      expect(result.report.status).toBe("success");
      expect(result.report.mapping_summary.exact_matches).toBe(3);
      expect(validate(result.report)).toBe(true);
    });

    it("full round-trip with edits: trim + split + new clip → partial", () => {
      const validate = createValidator("roundtrip-import-report.schema.json");
      const manifest = makeManifest();
      const profile = makeProfile();
      const fingerprint = makeFingerprint();

      const exported = [
        makeClip("CLP_001", {
          src_in_us: 0,
          src_out_us: 1_000_000,
        }),
        makeClip("CLP_002", {
          src_in_us: 1_000_000,
          src_out_us: 2_000_000,
        }),
        makeClip("CLP_003", {
          src_in_us: 2_000_000,
          src_out_us: 3_000_000,
        }),
      ];

      const imported = [
        // CLP_001: trimmed (src changed)
        makeClip("CLP_001", {
          src_in_us: 100_000,
          src_out_us: 900_000,
        }),
        // CLP_002: split into 2
        makeClip("CLP_002", {
          src_in_us: 1_000_000,
          src_out_us: 1_500_000,
          timeline_in_frame: 24,
        }),
        makeClip("CLP_002", {
          src_in_us: 1_500_000,
          src_out_us: 2_000_000,
          timeline_in_frame: 36,
        }),
        // CLP_003: unchanged
        makeClip("CLP_003", {
          src_in_us: 2_000_000,
          src_out_us: 3_000_000,
        }),
        // New clip added by editor
        makeClip("CLP_NEW", {
          exchange_clip_id: "",
          clip_id: "CLP_NEW",
          asset_id: "AST_NEW",
          src_in_us: 5_000_000,
          src_out_us: 6_000_000,
        }),
      ];

      const result = executeOfflineImport({
        manifest,
        profile,
        exportedClips: exported,
        importedClips: imported,
        bridgeFingerprint: fingerprint,
        importedAt: "2026-03-21T12:05:00Z",
      });

      expect(result.reviewRequired).toBe(true);
      expect(result.report.status).toBe("partial");
      expect(result.report.mapping_summary.split_items).toBe(1);
      expect(result.report.mapping_summary.unmapped_items).toBe(1);
      expect(result.report.mapping_summary.exact_matches).toBe(2); // CLP_001 + CLP_003

      const valid = validate(result.report);
      if (!valid) {
        console.error("Schema errors:", JSON.stringify(validate.errors, null, 2));
      }
      expect(valid).toBe(true);
    });
  });
});
