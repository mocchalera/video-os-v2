/**
 * M3.5 Phase 1: Contracts And Bridge Boundary
 *
 * Tests for:
 * - New schemas (handoff-manifest, roundtrip-import-report, human-revision-diff, nle-capability-profile)
 * - Bridge contract types and fingerprint mismatch policy
 * - NLE capability profile validation (resolve-v1.yaml)
 * - project_state.yaml additive update backward compatibility
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { createRequire } from "node:module";
import {
  evaluateFingerprintMismatch,
  BRIDGE_VERSION,
  OTIO_VERSION_PIN,
  BridgeError,
  type BridgeFingerprint,
  type BridgeRequest,
  type NleCapabilityProfile,
  type HandoffResolution,
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

// ── Minimal Valid Fixtures ──────────────────────────────────────────

function minimalHandoffManifest() {
  return {
    version: 1,
    project_id: "test-project",
    handoff_id: "HND_0001_20260321T100000Z",
    exported_at: "2026-03-21T10:00:00Z",
    base_timeline: {
      path: "05_timeline/timeline.json",
      version: "1",
      hash: "sha256:abc123",
      sequence: { fps_num: 24, fps_den: 1, width: 1920, height: 1080 },
    },
    approval_snapshot: {
      status: "clean",
      approved_by: "operator",
      approved_at: "2026-03-21T09:50:00Z",
    },
    capability_profile: {
      profile_id: "davinci_resolve_otio_v1",
      path: "runtime/nle-profiles/resolve-v1.yaml",
    },
    bridge: {
      bridge_version: "1.0.0",
      python_version: "3.11.8",
      opentimelineio_version: "0.17.0",
      bridge_script_hash: "sha256:def456",
      loaded_adapter_modules: [],
    },
    source_map: [
      {
        asset_id: "AST_001",
        source_locator: "media/source/clip_a.mov",
      },
    ],
  };
}

function minimalImportReport() {
  return {
    version: 1,
    project_id: "test-project",
    handoff_id: "HND_0001_20260321T100000Z",
    imported_at: "2026-03-21T12:00:00Z",
    capability_profile_id: "davinci_resolve_otio_v1",
    status: "success",
    base_timeline: {
      version: "1",
      hash: "sha256:abc123",
    },
    bridge: {
      bridge_version: "1.0.0",
      python_version: "3.11.8",
      opentimelineio_version: "0.17.0",
      bridge_script_hash: "sha256:def456",
      loaded_adapter_modules: [],
    },
    mapping_summary: {
      exported_clip_count: 10,
      imported_clip_count: 10,
      exact_matches: 10,
    },
  };
}

function minimalHumanRevisionDiff() {
  return {
    version: 1,
    project_id: "test-project",
    handoff_id: "HND_0001_20260321T100000Z",
    base_timeline_version: "1",
    capability_profile_id: "davinci_resolve_otio_v1",
    status: "clean",
    summary: {
      trim: 0,
      reorder: 0,
      enable_disable: 0,
      unmapped: 0,
    },
  };
}

function minimalCapabilityProfile() {
  return {
    version: 1,
    profile_id: "test_nle_v1",
    nle: {
      vendor: "Test Vendor",
      product: "Test NLE",
      version_range: ">=1",
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
      require_exact_metadata: true,
    },
    surfaces: {
      trim: { mode: "verified_roundtrip" },
    },
    import_policy: {
      provisional_mapping_requires_review: true,
      unmapped_edit_requires_review: true,
      one_to_many_requires_review: true,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. handoff-manifest.schema.json
// ═══════════════════════════════════════════════════════════════════

describe("handoff-manifest schema", () => {
  const validate = createValidator("handoff-manifest.schema.json");

  it("accepts minimal valid manifest", () => {
    const data = minimalHandoffManifest();
    expect(validate(data)).toBe(true);
  });

  it("accepts manifest with all optional fields", () => {
    const data = {
      ...minimalHandoffManifest(),
      nle_session: {
        vendor: "Blackmagic Design",
        product: "DaVinci Resolve",
        expected_version: "19.x",
      },
      verified_roundtrip_surfaces: ["trim", "reorder"],
      provisional_roundtrip_surfaces: ["track_move"],
      report_only_surfaces: ["track_reorder"],
      lossy_surfaces: ["color_finish"],
      review_bundle_ref: { export_manifest_path: "exports/review/manifest.yaml" },
      notes: ["Test note"],
    };
    expect(validate(data)).toBe(true);
  });

  it("rejects missing required fields", () => {
    const data = { version: 1, project_id: "test" };
    expect(validate(data)).toBe(false);
  });

  it("rejects invalid handoff_id pattern", () => {
    const data = { ...minimalHandoffManifest(), handoff_id: "INVALID_001" };
    expect(validate(data)).toBe(false);
  });

  it("rejects invalid version", () => {
    const data = { ...minimalHandoffManifest(), version: 2 };
    expect(validate(data)).toBe(false);
  });

  it("rejects invalid approval status", () => {
    const data = minimalHandoffManifest();
    data.approval_snapshot.status = "pending" as "clean";
    expect(validate(data)).toBe(false);
  });

  it("rejects invalid hash prefix", () => {
    const data = minimalHandoffManifest();
    data.base_timeline.hash = "md5:abc";
    expect(validate(data)).toBe(false);
  });

  it("rejects additional properties at root", () => {
    const data = { ...minimalHandoffManifest(), extra_field: true };
    expect(validate(data)).toBe(false);
  });

  it("rejects additional properties in source_map entry", () => {
    const data = minimalHandoffManifest();
    (data.source_map[0] as Record<string, unknown>).extra = true;
    expect(validate(data)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. roundtrip-import-report.schema.json
// ═══════════════════════════════════════════════════════════════════

describe("roundtrip-import-report schema", () => {
  const validate = createValidator("roundtrip-import-report.schema.json");

  it("accepts minimal valid report", () => {
    const data = minimalImportReport();
    expect(validate(data)).toBe(true);
  });

  it("accepts report with full loss_summary", () => {
    const data = {
      ...minimalImportReport(),
      status: "partial",
      loss_summary: {
        review_required: true,
        lossy_items: [
          { classification: "color_finish", item_ref: "clip:CLP_001", reason: "lossy surface" },
        ],
        unmapped_items: [
          { classification: "missing_stable_id", item_ref: "clip@track=V1,index=3", reason: "dropped metadata" },
        ],
        unsupported_items: [
          { classification: "plugin_effect", item_ref: "effect@clip=CLP_002", reason: "outside allowlist" },
        ],
      },
    };
    expect(validate(data)).toBe(true);
  });

  it("accepts report with one_to_many_items", () => {
    const data = {
      ...minimalImportReport(),
      status: "partial",
      one_to_many_items: {
        split_entries: [
          {
            parent_exchange_clip_id: "proj:1:CLP_001",
            child_ids: ["proj:1:CLP_001#S01", "proj:1:CLP_001#S02"],
            review_required: true,
          },
        ],
        duplicate_entries: [
          {
            parent_exchange_clip_id: "proj:1:CLP_002",
            retained_exchange_clip_id: "proj:1:CLP_002",
            copy_ids: ["proj:1:CLP_002#D01"],
            provenance: { basis: "duplicate_metadata_collision" },
            review_required: true,
          },
        ],
      },
    };
    expect(validate(data)).toBe(true);
  });

  it("rejects invalid status", () => {
    const data = { ...minimalImportReport(), status: "unknown" };
    expect(validate(data)).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { mapping_summary: _, ...rest } = minimalImportReport();
    expect(validate(rest)).toBe(false);
  });

  it("rejects invalid classification in loss item", () => {
    const data = {
      ...minimalImportReport(),
      loss_summary: {
        review_required: true,
        lossy_items: [
          { classification: "invalid_type", item_ref: "clip:CLP_001", reason: "test" },
        ],
      },
    };
    expect(validate(data)).toBe(false);
  });

  it("rejects additional properties at root", () => {
    const data = { ...minimalImportReport(), extra: true };
    expect(validate(data)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. human-revision-diff.schema.json
// ═══════════════════════════════════════════════════════════════════

describe("human-revision-diff schema", () => {
  const validate = createValidator("human-revision-diff.schema.json");

  it("accepts minimal valid diff", () => {
    const data = minimalHumanRevisionDiff();
    expect(validate(data)).toBe(true);
  });

  it("accepts diff with trim operation", () => {
    const data = {
      ...minimalHumanRevisionDiff(),
      status: "review_required",
      summary: { trim: 1, reorder: 0, enable_disable: 0, unmapped: 0 },
      operations: [
        {
          operation_id: "HRD_0001",
          type: "trim",
          target: {
            exchange_clip_id: "proj:1:CLP_003",
            clip_id: "CLP_003",
            segment_id: "SEG_001",
            asset_id: "AST_001",
            track_id: "V1",
          },
          before: { src_in_us: 11200000, src_out_us: 15850000, timeline_in_frame: 48, timeline_duration_frames: 36 },
          after: { src_in_us: 11400000, src_out_us: 15400000, timeline_in_frame: 48, timeline_duration_frames: 32 },
          delta: { in_us: 200000, out_us: -450000, duration_frames: -4 },
          mapped_via: "metadata.exchange_clip_id",
          confidence: "exact",
          surface: "verified_roundtrip",
        },
      ],
    };
    expect(validate(data)).toBe(true);
  });

  it("accepts diff with unmapped edits", () => {
    const data = {
      ...minimalHumanRevisionDiff(),
      status: "review_required",
      summary: { trim: 0, reorder: 0, enable_disable: 0, unmapped: 2 },
      unmapped_edits: [
        {
          classification: "split_clip",
          item_ref: "clip:proj:1:CLP_008",
          derived_child_ids: ["proj:1:CLP_008#S01", "proj:1:CLP_008#S02"],
          review_required: true,
          reason: "one-to-many stable ID requires human restructuring",
        },
        {
          classification: "plugin_effect",
          item_ref: "effect@clip=proj:1:CLP_009",
          review_required: true,
          reason: "outside capability profile allowlist",
        },
      ],
    };
    expect(validate(data)).toBe(true);
  });

  it("accepts all operation types", () => {
    const opTypes = ["trim", "reorder", "enable_disable", "track_move", "simple_transition", "timeline_marker_add"];
    for (const opType of opTypes) {
      const data = {
        ...minimalHumanRevisionDiff(),
        operations: [
          {
            operation_id: "HRD_0001",
            type: opType,
            target: { exchange_clip_id: "proj:1:CLP_001" },
          },
        ],
      };
      expect(validate(data)).toBe(true);
    }
  });

  it("rejects invalid operation type", () => {
    const data = {
      ...minimalHumanRevisionDiff(),
      operations: [
        {
          operation_id: "HRD_0001",
          type: "invalid_op",
          target: { exchange_clip_id: "proj:1:CLP_001" },
        },
      ],
    };
    expect(validate(data)).toBe(false);
  });

  it("rejects invalid status", () => {
    const data = { ...minimalHumanRevisionDiff(), status: "invalid" };
    expect(validate(data)).toBe(false);
  });

  it("rejects invalid unmapped classification", () => {
    const data = {
      ...minimalHumanRevisionDiff(),
      unmapped_edits: [
        { classification: "invalid_class", item_ref: "x", review_required: true, reason: "test" },
      ],
    };
    expect(validate(data)).toBe(false);
  });

  it("rejects additional properties at root", () => {
    const data = { ...minimalHumanRevisionDiff(), extra: true };
    expect(validate(data)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. nle-capability-profile.schema.json
// ═══════════════════════════════════════════════════════════════════

describe("nle-capability-profile schema", () => {
  const validate = createValidator("nle-capability-profile.schema.json");

  it("accepts minimal valid profile", () => {
    const data = minimalCapabilityProfile();
    expect(validate(data)).toBe(true);
  });

  it("accepts full Resolve-like profile", () => {
    const data = {
      version: 1,
      profile_id: "davinci_resolve_otio_v1",
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
    };
    expect(validate(data)).toBe(true);
  });

  it("validates resolve-v1.yaml against schema", () => {
    const raw = fs.readFileSync(
      path.resolve("runtime/nle-profiles/resolve-v1.yaml"),
      "utf-8",
    );
    const profile = parseYaml(raw);
    expect(validate(profile)).toBe(true);
  });

  it("rejects invalid surface mode", () => {
    const data = minimalCapabilityProfile();
    data.surfaces.trim = { mode: "invalid_mode" as "verified_roundtrip" };
    expect(validate(data)).toBe(false);
  });

  it("rejects invalid interchange_format", () => {
    const data = minimalCapabilityProfile();
    (data.otio as Record<string, unknown>).interchange_format = "aaf";
    expect(validate(data)).toBe(false);
  });

  it("rejects missing required import_policy fields", () => {
    const data = minimalCapabilityProfile();
    (data as Record<string, unknown>).import_policy = { provisional_mapping_requires_review: true };
    expect(validate(data)).toBe(false);
  });

  it("rejects additional properties at root", () => {
    const data = { ...minimalCapabilityProfile(), extra: true };
    expect(validate(data)).toBe(false);
  });

  it("rejects additional properties in surfaces", () => {
    const data = minimalCapabilityProfile();
    (data.surfaces as Record<string, unknown>).unknown_surface = { mode: "lossy" };
    expect(validate(data)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Bridge Contract Types
// ═══════════════════════════════════════════════════════════════════

describe("bridge contract", () => {
  describe("constants", () => {
    it("exports BRIDGE_VERSION", () => {
      expect(BRIDGE_VERSION).toBe("1.0.0");
    });

    it("exports OTIO_VERSION_PIN", () => {
      expect(OTIO_VERSION_PIN).toBe("0.17.0");
    });
  });

  describe("BridgeError", () => {
    it("creates error with code and message", () => {
      const err = new BridgeError("TIMEOUT", "Bridge timed out after 30s");
      expect(err.code).toBe("TIMEOUT");
      expect(err.message).toContain("TIMEOUT");
      expect(err.message).toContain("Bridge timed out after 30s");
      expect(err.name).toBe("BridgeError");
      expect(err.stderr).toBe("");
      expect(err.request).toBeNull();
    });

    it("creates error with stderr and request", () => {
      const request: BridgeRequest = {
        request_id: "test-123",
        command: "export_otio",
        input_path: "/tmp/in.json",
        output_path: "/tmp/out.otio",
        options: {},
        expected_bridge_version: "1.0.0",
      };
      const err = new BridgeError("NON_ZERO_EXIT", "Process exited with 1", "traceback...", request);
      expect(err.stderr).toBe("traceback...");
      expect(err.request).toBe(request);
    });

    it("is instanceof Error", () => {
      const err = new BridgeError("PROTOCOL_ERROR", "bad json");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("evaluateFingerprintMismatch", () => {
    const base: BridgeFingerprint = {
      bridge_version: "1.0.0",
      python_version: "3.11.8",
      opentimelineio_version: "0.17.0",
      bridge_script_hash: "sha256:abc",
      loaded_adapter_modules: [],
    };

    it("returns ok for identical fingerprints", () => {
      expect(evaluateFingerprintMismatch(base, { ...base })).toBe("ok");
    });

    it("returns failed for bridge_version mismatch", () => {
      expect(
        evaluateFingerprintMismatch(base, { ...base, bridge_version: "2.0.0" }),
      ).toBe("failed");
    });

    it("returns failed for OTIO major version mismatch", () => {
      expect(
        evaluateFingerprintMismatch(base, { ...base, opentimelineio_version: "1.0.0" }),
      ).toBe("failed");
    });

    it("returns failed for OTIO minor version mismatch", () => {
      expect(
        evaluateFingerprintMismatch(base, { ...base, opentimelineio_version: "0.18.0" }),
      ).toBe("failed");
    });

    it("returns partial for OTIO patch-only version mismatch", () => {
      expect(
        evaluateFingerprintMismatch(base, { ...base, opentimelineio_version: "0.17.1" }),
      ).toBe("partial");
    });

    it("returns failed for unparseable version", () => {
      expect(
        evaluateFingerprintMismatch(base, { ...base, opentimelineio_version: "unknown" }),
      ).toBe("failed");
    });

    it("ignores python_version and script_hash differences", () => {
      expect(
        evaluateFingerprintMismatch(base, {
          ...base,
          python_version: "3.12.0",
          bridge_script_hash: "sha256:different",
        }),
      ).toBe("ok");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Resolve v1 Profile Content Assertions
// ═══════════════════════════════════════════════════════════════════

describe("resolve-v1 profile content", () => {
  const raw = fs.readFileSync(
    path.resolve("runtime/nle-profiles/resolve-v1.yaml"),
    "utf-8",
  );
  const profile = parseYaml(raw) as NleCapabilityProfile;

  it("has correct profile_id", () => {
    expect(profile.profile_id).toBe("davinci_resolve_otio_v1");
  });

  it("targets DaVinci Resolve >=19", () => {
    expect(profile.nle.vendor).toBe("Blackmagic Design");
    expect(profile.nle.product).toBe("DaVinci Resolve");
    expect(profile.nle.version_range).toBe(">=19");
  });

  it("uses video_os metadata namespace", () => {
    expect(profile.otio.metadata_namespace).toBe("video_os");
  });

  it("has verified_roundtrip surfaces", () => {
    expect(profile.surfaces.trim.mode).toBe("verified_roundtrip");
    expect(profile.surfaces.reorder.mode).toBe("verified_roundtrip");
    expect(profile.surfaces.enable_disable.mode).toBe("verified_roundtrip");
  });

  it("has provisional_roundtrip surfaces", () => {
    expect(profile.surfaces.track_move.mode).toBe("provisional_roundtrip");
    expect(profile.surfaces.simple_transition.mode).toBe("provisional_roundtrip");
    expect(profile.surfaces.timeline_marker_add.mode).toBe("provisional_roundtrip");
  });

  it("has report_only surfaces", () => {
    expect(profile.surfaces.track_reorder.mode).toBe("report_only");
    expect(profile.surfaces.clip_marker_add.mode).toBe("report_only");
    expect(profile.surfaces.note_text_add.mode).toBe("report_only");
  });

  it("has lossy surfaces", () => {
    expect(profile.surfaces.color_finish.mode).toBe("lossy");
    expect(profile.surfaces.fusion_effect.mode).toBe("lossy");
    expect(profile.surfaces.fairlight_advanced_audio.mode).toBe("lossy");
  });

  it("requires exact metadata", () => {
    expect(profile.stable_id.require_exact_metadata).toBe(true);
  });

  it("has conservative import policy", () => {
    expect(profile.import_policy.provisional_mapping_requires_review).toBe(true);
    expect(profile.import_policy.unmapped_edit_requires_review).toBe(true);
    expect(profile.import_policy.one_to_many_requires_review).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. project_state.yaml Backward Compatibility
// ═══════════════════════════════════════════════════════════════════

describe("project-state schema backward compatibility", () => {
  const validate = createValidator("project-state.schema.json");

  it("accepts existing project_state without handoff_resolution", () => {
    const data = {
      version: 1,
      project_id: "test",
      current_state: "approved",
      approval_record: {
        status: "clean",
        approved_by: "operator",
        approved_at: "2026-03-21T10:00:00Z",
        artifact_versions: {
          timeline_version: "1",
          review_report_version: "1",
        },
      },
    };
    expect(validate(data)).toBe(true);
  });

  it("accepts project_state with handoff_resolution", () => {
    const data = {
      version: 1,
      project_id: "test",
      current_state: "approved",
      handoff_resolution: {
        handoff_id: "HND_0001_20260321T100000Z",
        status: "decided",
        source_of_truth_decision: "engine_render",
        decided_by: "operator",
        decided_at: "2026-03-21T12:20:00Z",
        basis_report_hashes: {
          roundtrip_import_report: "sha256:abc123",
          human_revision_diff: "sha256:def456",
        },
      },
    };
    expect(validate(data)).toBe(true);
  });

  it("accepts pending handoff_resolution", () => {
    const data = {
      version: 1,
      project_id: "test",
      current_state: "approved",
      handoff_resolution: {
        handoff_id: "HND_0001_20260321T100000Z",
        status: "pending",
      },
    };
    expect(validate(data)).toBe(true);
  });

  it("rejects invalid handoff_resolution status", () => {
    const data = {
      version: 1,
      project_id: "test",
      current_state: "approved",
      handoff_resolution: {
        handoff_id: "HND_0001_20260321T100000Z",
        status: "invalid",
      },
    };
    expect(validate(data)).toBe(false);
  });

  it("rejects invalid source_of_truth_decision", () => {
    const data = {
      version: 1,
      project_id: "test",
      current_state: "approved",
      handoff_resolution: {
        handoff_id: "HND_0001_20260321T100000Z",
        status: "decided",
        source_of_truth_decision: "invalid_decision",
      },
    };
    expect(validate(data)).toBe(false);
  });

  it("rejects invalid handoff_id pattern", () => {
    const data = {
      version: 1,
      project_id: "test",
      current_state: "approved",
      handoff_resolution: {
        handoff_id: "INVALID",
        status: "pending",
      },
    };
    expect(validate(data)).toBe(false);
  });

  it("still validates all existing states", () => {
    const states = [
      "intent_pending", "intent_locked", "media_analyzed", "selects_ready",
      "blueprint_ready", "blocked", "timeline_drafted", "critique_ready",
      "approved", "packaged",
    ];
    for (const state of states) {
      const data = { version: 1, project_id: "test", current_state: state };
      expect(validate(data)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Bridge Contract Type Safety
// ═══════════════════════════════════════════════════════════════════

describe("bridge contract type safety", () => {
  it("HandoffResolution type matches schema shape", () => {
    const resolution: HandoffResolution = {
      handoff_id: "HND_0001_20260321T100000Z",
      status: "decided",
      source_of_truth_decision: "engine_render",
      decided_by: "operator",
      decided_at: "2026-03-21T12:20:00Z",
      basis_report_hashes: {
        roundtrip_import_report: "sha256:abc",
        human_revision_diff: "sha256:def",
      },
    };
    expect(resolution.status).toBe("decided");
    expect(resolution.source_of_truth_decision).toBe("engine_render");
  });

  it("NleCapabilityProfile type matches schema shape", () => {
    const profile: NleCapabilityProfile = {
      version: 1,
      profile_id: "test",
      nle: { vendor: "V", product: "P", version_range: ">=1" },
      otio: { interchange_format: "otio", metadata_namespace: "video_os" },
      stable_id: {
        primary_paths: { clip: "a", track: "b" },
        require_exact_metadata: true,
      },
      surfaces: {
        trim: { mode: "verified_roundtrip" },
      },
      import_policy: {
        provisional_mapping_requires_review: true,
        unmapped_edit_requires_review: true,
        one_to_many_requires_review: true,
      },
    };
    expect(profile.surfaces.trim.mode).toBe("verified_roundtrip");
  });
});
