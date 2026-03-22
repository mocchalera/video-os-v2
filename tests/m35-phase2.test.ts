/**
 * M3.5 Phase 2: Export Path Tests
 *
 * Tests for:
 * - Gate 8: stable ID validation (missing/duplicate IDs)
 * - Exchange ID derivation
 * - Handoff ID generation
 * - Capability profile loading and surface categorization
 * - Bridge input building
 * - Handoff manifest building and schema validation
 * - SHA-256 hashing
 * - Python bridge invocation (conditional: skip if opentimelineio not installed)
 * - Export readback validation (conditional)
 * - Full export orchestration (conditional)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import { createRequire } from "node:module";
import type { TimelineIR, TrackOutput, ClipOutput } from "../runtime/compiler/types.js";
import {
  validateStableIds,
  deriveExchangeClipId,
  deriveExchangeTrackId,
  generateHandoffId,
  loadCapabilityProfile,
  categorizeSurfaces,
  sha256,
  buildBridgeInput,
  buildHandoffManifest,
  type HandoffExportInput,
  type SourceMapEntry,
  type Gate8ValidationError,
} from "../runtime/handoff/export.js";
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

// ── Helpers ────────────────────────────────────────────────────────

function createValidator(schemaName: string) {
  const raw = fs.readFileSync(path.resolve("schemas", schemaName), "utf-8");
  const schema = JSON.parse(raw);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function makeClip(overrides: Partial<ClipOutput> = {}): ClipOutput {
  return {
    clip_id: "CLP_001",
    segment_id: "SEG_001",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 2000000,
    timeline_in_frame: 0,
    timeline_duration_frames: 48,
    role: "hero",
    motivation: "test",
    beat_id: "beat_1",
    fallback_segment_ids: [],
    confidence: 0.9,
    quality_flags: [],
    ...overrides,
  };
}

function makeTrack(
  id: string,
  kind: "video" | "audio",
  clips: ClipOutput[],
): TrackOutput {
  return { track_id: id, kind, clips };
}

function makeTimeline(
  videoTracks: TrackOutput[] = [],
  audioTracks: TrackOutput[] = [],
): TimelineIR {
  return {
    version: "1",
    project_id: "test-project",
    created_at: "2026-03-21T10:00:00Z",
    sequence: {
      name: "Test Sequence",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: { video: videoTracks, audio: audioTracks },
    markers: [],
    provenance: {
      brief_path: "01_brief/brief.yaml",
      blueprint_path: "03_blueprint/edit_blueprint.yaml",
      selects_path: "02_selects/selects_candidates.yaml",
      compiler_version: "1.0.0",
    },
  };
}

const PROFILE_PATH = path.resolve("runtime/nle-profiles/resolve-v1.yaml");

// ═══════════════════════════════════════════════════════════════════
// 1. Gate 8: Stable ID Validation
// ═══════════════════════════════════════════════════════════════════

describe("Gate 8: stable ID validation", () => {
  it("passes for timeline with valid IDs", () => {
    const timeline = makeTimeline(
      [makeTrack("V1", "video", [makeClip({ clip_id: "CLP_001" })])],
      [makeTrack("A1", "audio", [makeClip({ clip_id: "CLP_002" })])],
    );
    const errors = validateStableIds(timeline);
    expect(errors).toHaveLength(0);
  });

  it("passes for empty timeline (no tracks)", () => {
    const timeline = makeTimeline([], []);
    const errors = validateStableIds(timeline);
    expect(errors).toHaveLength(0);
  });

  it("detects missing track_id", () => {
    const timeline = makeTimeline([
      makeTrack("", "video", [makeClip()]),
    ]);
    const errors = validateStableIds(timeline);
    expect(errors.some((e) => e.type === "missing_track_id")).toBe(true);
  });

  it("detects duplicate track_id within same group", () => {
    const timeline = makeTimeline([
      makeTrack("V1", "video", [makeClip({ clip_id: "CLP_001" })]),
      makeTrack("V1", "video", [makeClip({ clip_id: "CLP_002" })]),
    ]);
    const errors = validateStableIds(timeline);
    expect(errors.some((e) => e.type === "duplicate_track_id")).toBe(true);
  });

  it("detects duplicate track_id across video and audio", () => {
    const timeline = makeTimeline(
      [makeTrack("T1", "video", [makeClip({ clip_id: "CLP_001" })])],
      [makeTrack("T1", "audio", [makeClip({ clip_id: "CLP_002" })])],
    );
    const errors = validateStableIds(timeline);
    expect(errors.some((e) => e.type === "duplicate_track_id")).toBe(true);
  });

  it("detects missing clip_id", () => {
    const timeline = makeTimeline([
      makeTrack("V1", "video", [makeClip({ clip_id: "" })]),
    ]);
    const errors = validateStableIds(timeline);
    expect(errors.some((e) => e.type === "missing_clip_id")).toBe(true);
  });

  it("detects duplicate clip_id across tracks", () => {
    const timeline = makeTimeline(
      [makeTrack("V1", "video", [makeClip({ clip_id: "CLP_001" })])],
      [makeTrack("A1", "audio", [makeClip({ clip_id: "CLP_001" })])],
    );
    const errors = validateStableIds(timeline);
    expect(errors.some((e) => e.type === "duplicate_clip_id")).toBe(true);
  });

  it("detects missing segment_id", () => {
    const timeline = makeTimeline([
      makeTrack("V1", "video", [makeClip({ segment_id: "" })]),
    ]);
    const errors = validateStableIds(timeline);
    expect(errors.some((e) => e.type === "missing_segment_id")).toBe(true);
  });

  it("detects missing asset_id", () => {
    const timeline = makeTimeline([
      makeTrack("V1", "video", [makeClip({ asset_id: "" })]),
    ]);
    const errors = validateStableIds(timeline);
    expect(errors.some((e) => e.type === "missing_asset_id")).toBe(true);
  });

  it("reports multiple errors at once", () => {
    const timeline = makeTimeline([
      makeTrack("", "video", [
        makeClip({ clip_id: "", segment_id: "", asset_id: "" }),
      ]),
    ]);
    const errors = validateStableIds(timeline);
    // Should have: missing_track_id, missing_clip_id, missing_segment_id, missing_asset_id
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it("includes location info in errors", () => {
    const timeline = makeTimeline([
      makeTrack("V1", "video", [
        makeClip({ clip_id: "CLP_001" }),
        makeClip({ clip_id: "" }),
      ]),
    ]);
    const errors = validateStableIds(timeline);
    const clipError = errors.find((e) => e.type === "missing_clip_id");
    expect(clipError).toBeDefined();
    expect(clipError!.location).toContain("video[0].clips[1]");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Exchange ID Derivation
// ═══════════════════════════════════════════════════════════════════

describe("exchange ID derivation", () => {
  it("derives exchange_clip_id as project:version:clip_id", () => {
    expect(deriveExchangeClipId("proj-a", "5", "CLP_003")).toBe(
      "proj-a:5:CLP_003",
    );
  });

  it("derives exchange_track_id as project:version:track_id", () => {
    expect(deriveExchangeTrackId("proj-a", "5", "V1")).toBe("proj-a:5:V1");
  });

  it("handles special characters in project_id", () => {
    expect(deriveExchangeClipId("my-brand-film", "1", "CLP_001")).toBe(
      "my-brand-film:1:CLP_001",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Handoff ID Generation
// ═══════════════════════════════════════════════════════════════════

describe("handoff ID generation", () => {
  it("generates HND_ prefix with timeline version", () => {
    const id = generateHandoffId("5", "20260321T103000Z");
    expect(id).toBe("HND_5_20260321T103000Z");
  });

  it("matches HND_ pattern from schema", () => {
    const id = generateHandoffId("0001", "20260321T103000Z");
    expect(id).toMatch(/^HND_.+$/);
  });

  it("generates unique timestamp when none provided", () => {
    const id1 = generateHandoffId("1");
    expect(id1).toMatch(/^HND_1_/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Capability Profile Loading
// ═══════════════════════════════════════════════════════════════════

describe("capability profile loading", () => {
  it("loads resolve-v1.yaml", () => {
    const profile = loadCapabilityProfile(PROFILE_PATH);
    expect(profile.profile_id).toBe("davinci_resolve_otio_v1");
    expect(profile.nle.vendor).toBe("Blackmagic Design");
  });

  it("categorizes surfaces correctly", () => {
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const surfaces = categorizeSurfaces(profile);

    expect(surfaces.verified).toContain("trim");
    expect(surfaces.verified).toContain("reorder");
    expect(surfaces.verified).toContain("enable_disable");

    expect(surfaces.provisional).toContain("track_move");
    expect(surfaces.provisional).toContain("simple_transition");
    expect(surfaces.provisional).toContain("timeline_marker_add");

    expect(surfaces.report_only).toContain("track_reorder");
    expect(surfaces.report_only).toContain("clip_marker_add");
    expect(surfaces.report_only).toContain("note_text_add");

    expect(surfaces.lossy).toContain("color_finish");
    expect(surfaces.lossy).toContain("fusion_effect");
    expect(surfaces.lossy).toContain("fairlight_advanced_audio");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. SHA-256 Hashing
// ═══════════════════════════════════════════════════════════════════

describe("sha256 hashing", () => {
  it("produces sha256: prefixed hash", () => {
    const hash = sha256("test content");
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
  });

  it("differs for different content", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Bridge Input Building
// ═══════════════════════════════════════════════════════════════════

describe("bridge input building", () => {
  function makeExportInput(): HandoffExportInput {
    return {
      projectPath: "/tmp/test-project",
      projectId: "test-project",
      timelineVersion: "1",
      timeline: makeTimeline(
        [
          makeTrack("V1", "video", [
            makeClip({ clip_id: "CLP_001", asset_id: "AST_001" }),
          ]),
        ],
        [
          makeTrack("A1", "audio", [
            makeClip({ clip_id: "CLP_002", asset_id: "AST_002" }),
          ]),
        ],
      ),
      approvalRecord: {
        status: "clean",
        approved_by: "operator",
        approved_at: "2026-03-21T10:00:00Z",
      },
      profilePath: PROFILE_PATH,
      sourceMap: [
        { asset_id: "AST_001", source_locator: "media/clip_a.mov" },
        { asset_id: "AST_002", source_locator: "media/clip_b.wav" },
      ],
    };
  }

  it("builds bridge input with exchange IDs", () => {
    const input = makeExportInput();
    const bridgeInput = buildBridgeInput(input);

    expect(bridgeInput.project_id).toBe("test-project");
    expect(bridgeInput.timeline_version).toBe("1");
    expect(bridgeInput.capability_profile_id).toBe("davinci_resolve_otio_v1");

    const videoTrack = bridgeInput.tracks.video[0];
    expect(videoTrack.exchange_track_id).toBe("test-project:1:V1");
    expect(videoTrack.clips[0].exchange_clip_id).toBe(
      "test-project:1:CLP_001",
    );
  });

  it("resolves source locators from source map", () => {
    const input = makeExportInput();
    const bridgeInput = buildBridgeInput(input);

    expect(bridgeInput.tracks.video[0].clips[0].source_locator).toBe(
      "media/clip_a.mov",
    );
    expect(bridgeInput.tracks.audio[0].clips[0].source_locator).toBe(
      "media/clip_b.wav",
    );
  });

  it("sets sequence from timeline", () => {
    const input = makeExportInput();
    const bridgeInput = buildBridgeInput(input);

    expect(bridgeInput.sequence.fps_num).toBe(24);
    expect(bridgeInput.sequence.fps_den).toBe(1);
    expect(bridgeInput.sequence.width).toBe(1920);
    expect(bridgeInput.sequence.height).toBe(1080);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Handoff Manifest Building + Schema Validation
// ═══════════════════════════════════════════════════════════════════

describe("handoff manifest building", () => {
  const validate = createValidator("handoff-manifest.schema.json");

  function makeExportInput(): HandoffExportInput {
    return {
      projectPath: "/tmp/test-project",
      projectId: "test-project",
      timelineVersion: "1",
      timeline: makeTimeline(
        [makeTrack("V1", "video", [makeClip()])],
        [],
      ),
      approvalRecord: {
        status: "clean",
        approved_by: "operator",
        approved_at: "2026-03-21T10:00:00Z",
      },
      profilePath: PROFILE_PATH,
      sourceMap: [
        { asset_id: "AST_001", source_locator: "media/clip_a.mov" },
      ],
    };
  }

  const bridgeFingerprint: BridgeFingerprint = {
    bridge_version: "1.0.0",
    python_version: "3.11.8",
    opentimelineio_version: "0.17.0",
    bridge_script_hash: "sha256:abc123def456",
    loaded_adapter_modules: [],
  };

  it("builds schema-valid manifest", () => {
    const input = makeExportInput();
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const manifest = buildHandoffManifest(
      input,
      "HND_1_20260321T100000Z",
      "sha256:abc123",
      bridgeFingerprint,
      profile,
      "2026-03-21T10:00:00Z",
    );

    expect(validate(manifest)).toBe(true);
  });

  it("includes correct handoff_id", () => {
    const input = makeExportInput();
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const manifest = buildHandoffManifest(
      input,
      "HND_1_20260321T100000Z",
      "sha256:abc123",
      bridgeFingerprint,
      profile,
      "2026-03-21T10:00:00Z",
    );

    expect(manifest.handoff_id).toBe("HND_1_20260321T100000Z");
    expect(manifest.version).toBe(1);
  });

  it("includes base_timeline info", () => {
    const input = makeExportInput();
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const manifest = buildHandoffManifest(
      input,
      "HND_1_20260321T100000Z",
      "sha256:abc123",
      bridgeFingerprint,
      profile,
      "2026-03-21T10:00:00Z",
    );

    expect(manifest.base_timeline.version).toBe("1");
    expect(manifest.base_timeline.hash).toBe("sha256:abc123");
    expect(manifest.base_timeline.sequence.fps_num).toBe(24);
  });

  it("includes approval snapshot", () => {
    const input = makeExportInput();
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const manifest = buildHandoffManifest(
      input,
      "HND_1_20260321T100000Z",
      "sha256:abc123",
      bridgeFingerprint,
      profile,
      "2026-03-21T10:00:00Z",
    );

    expect(manifest.approval_snapshot.status).toBe("clean");
    expect(manifest.approval_snapshot.approved_by).toBe("operator");
  });

  it("includes bridge fingerprint", () => {
    const input = makeExportInput();
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const manifest = buildHandoffManifest(
      input,
      "HND_1_20260321T100000Z",
      "sha256:abc123",
      bridgeFingerprint,
      profile,
      "2026-03-21T10:00:00Z",
    );

    expect(manifest.bridge.bridge_version).toBe("1.0.0");
    expect(manifest.bridge.opentimelineio_version).toBe("0.17.0");
  });

  it("includes capability profile ref", () => {
    const input = makeExportInput();
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const manifest = buildHandoffManifest(
      input,
      "HND_1_20260321T100000Z",
      "sha256:abc123",
      bridgeFingerprint,
      profile,
      "2026-03-21T10:00:00Z",
    );

    expect(manifest.capability_profile.profile_id).toBe(
      "davinci_resolve_otio_v1",
    );
  });

  it("includes NLE session info", () => {
    const input = makeExportInput();
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const manifest = buildHandoffManifest(
      input,
      "HND_1_20260321T100000Z",
      "sha256:abc123",
      bridgeFingerprint,
      profile,
      "2026-03-21T10:00:00Z",
    );

    expect(manifest.nle_session?.vendor).toBe("Blackmagic Design");
    expect(manifest.nle_session?.product).toBe("DaVinci Resolve");
  });

  it("includes categorized surfaces", () => {
    const input = makeExportInput();
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const manifest = buildHandoffManifest(
      input,
      "HND_1_20260321T100000Z",
      "sha256:abc123",
      bridgeFingerprint,
      profile,
      "2026-03-21T10:00:00Z",
    );

    expect(manifest.verified_roundtrip_surfaces).toContain("trim");
    expect(manifest.provisional_roundtrip_surfaces).toContain("track_move");
    expect(manifest.report_only_surfaces).toContain("track_reorder");
    expect(manifest.lossy_surfaces).toContain("color_finish");
  });

  it("includes source map", () => {
    const input = makeExportInput();
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const manifest = buildHandoffManifest(
      input,
      "HND_1_20260321T100000Z",
      "sha256:abc123",
      bridgeFingerprint,
      profile,
      "2026-03-21T10:00:00Z",
    );

    expect(manifest.source_map).toHaveLength(1);
    expect(manifest.source_map[0].asset_id).toBe("AST_001");
  });

  it("includes review_bundle_ref when provided", () => {
    const input = makeExportInput();
    input.reviewBundleRef = { export_manifest_path: "exports/review/manifest.yaml" };
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const manifest = buildHandoffManifest(
      input,
      "HND_1_20260321T100000Z",
      "sha256:abc123",
      bridgeFingerprint,
      profile,
      "2026-03-21T10:00:00Z",
    );

    expect(manifest.review_bundle_ref?.export_manifest_path).toBe(
      "exports/review/manifest.yaml",
    );
    expect(validate(manifest)).toBe(true);
  });

  it("produces valid manifest for creative_override approval", () => {
    const input = makeExportInput();
    input.approvalRecord.status = "creative_override";
    const profile = loadCapabilityProfile(PROFILE_PATH);
    const manifest = buildHandoffManifest(
      input,
      "HND_1_20260321T100000Z",
      "sha256:abc123",
      bridgeFingerprint,
      profile,
      "2026-03-21T10:00:00Z",
    );

    expect(manifest.approval_snapshot.status).toBe("creative_override");
    expect(validate(manifest)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Python Bridge — Conditional Tests
// ═══════════════════════════════════════════════════════════════════

function isOtioAvailable(): boolean {
  try {
    const result = child_process.spawnSync(
      "python3",
      ["-c", "import opentimelineio; print(opentimelineio.__version__)"],
      { encoding: "utf-8", timeout: 10_000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

const otioAvailable = isOtioAvailable();

describe("Python OTIO bridge", () => {
  const bridgeScriptPath = path.resolve("runtime/handoff/otio-bridge.py");

  it("bridge script exists", () => {
    expect(fs.existsSync(bridgeScriptPath)).toBe(true);
  });

  it("bridge script is valid Python syntax", () => {
    const result = child_process.spawnSync(
      "python3",
      ["-m", "py_compile", bridgeScriptPath],
      { encoding: "utf-8", timeout: 10_000 },
    );
    expect(result.status).toBe(0);
  });

  it.skipIf(!otioAvailable)(
    "bridge returns fingerprint for export command",
    () => {
      // Create a minimal bridge input file
      const tmpDir = fs.mkdtempSync(path.join("/tmp", "otio-bridge-test-"));
      const inputPath = path.join(tmpDir, "bridge_input.json");
      const outputPath = path.join(tmpDir, "test_output.otio");

      const bridgeInput = {
        project_id: "test-project",
        timeline_version: "1",
        handoff_id: "HND_1_20260321T100000Z",
        capability_profile_id: "test",
        approval_status: "clean",
        sequence: { name: "Test", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
        tracks: {
          video: [
            {
              track_id: "V1",
              exchange_track_id: "test-project:1:V1",
              kind: "video",
              clips: [
                {
                  clip_id: "CLP_001",
                  exchange_clip_id: "test-project:1:CLP_001",
                  track_id: "V1",
                  segment_id: "SEG_001",
                  asset_id: "AST_001",
                  beat_id: "beat_1",
                  role: "hero",
                  src_in_us: 0,
                  src_out_us: 2000000,
                  timeline_in_frame: 0,
                  timeline_duration_frames: 48,
                  capability_profile_id: "test",
                },
              ],
            },
          ],
          audio: [],
        },
        markers: [],
      };

      fs.writeFileSync(inputPath, JSON.stringify(bridgeInput, null, 2), "utf-8");

      const request = {
        request_id: "test-001",
        command: "export_otio",
        input_path: inputPath,
        output_path: outputPath,
        options: {},
        expected_bridge_version: "1.0.0",
      };

      const result = child_process.spawnSync(
        "python3",
        [bridgeScriptPath],
        {
          input: JSON.stringify(request),
          encoding: "utf-8",
          timeout: 30_000,
        },
      );

      expect(result.status).toBe(0);

      const response = JSON.parse(result.stdout);
      expect(response.ok).toBe(true);
      expect(response.bridge.bridge_version).toBe("1.0.0");
      expect(response.bridge.python_version).toBeTruthy();
      expect(response.bridge.opentimelineio_version).toBeTruthy();
      expect(response.bridge.bridge_script_hash).toMatch(/^sha256:/);

      // Verify .otio file was created
      expect(fs.existsSync(outputPath)).toBe(true);

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true });
    },
  );

  it.skipIf(!otioAvailable)(
    "bridge normalize extracts exchange_clip_ids",
    () => {
      // First, export an OTIO
      const tmpDir = fs.mkdtempSync(path.join("/tmp", "otio-bridge-norm-"));
      const inputPath = path.join(tmpDir, "bridge_input.json");
      const otioPath = path.join(tmpDir, "test.otio");
      const normalizedPath = path.join(tmpDir, "normalized.json");

      const bridgeInput = {
        project_id: "test-project",
        timeline_version: "2",
        handoff_id: "HND_2_20260321T100000Z",
        capability_profile_id: "test",
        approval_status: "clean",
        sequence: { name: "Test", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
        tracks: {
          video: [
            {
              track_id: "V1",
              exchange_track_id: "test-project:2:V1",
              kind: "video",
              clips: [
                {
                  clip_id: "CLP_A",
                  exchange_clip_id: "test-project:2:CLP_A",
                  track_id: "V1",
                  segment_id: "SEG_A",
                  asset_id: "AST_A",
                  beat_id: "beat_1",
                  role: "hero",
                  src_in_us: 1000000,
                  src_out_us: 3000000,
                  timeline_in_frame: 0,
                  timeline_duration_frames: 48,
                  capability_profile_id: "test",
                },
                {
                  clip_id: "CLP_B",
                  exchange_clip_id: "test-project:2:CLP_B",
                  track_id: "V1",
                  segment_id: "SEG_B",
                  asset_id: "AST_B",
                  beat_id: "beat_2",
                  role: "support",
                  src_in_us: 5000000,
                  src_out_us: 8000000,
                  timeline_in_frame: 48,
                  timeline_duration_frames: 72,
                  capability_profile_id: "test",
                },
              ],
            },
          ],
          audio: [],
        },
        markers: [],
      };

      fs.writeFileSync(inputPath, JSON.stringify(bridgeInput), "utf-8");

      // Export
      const exportReq = {
        request_id: "export-001",
        command: "export_otio",
        input_path: inputPath,
        output_path: otioPath,
        options: {},
        expected_bridge_version: "1.0.0",
      };

      child_process.spawnSync("python3", [bridgeScriptPath], {
        input: JSON.stringify(exportReq),
        encoding: "utf-8",
        timeout: 30_000,
      });

      expect(fs.existsSync(otioPath)).toBe(true);

      // Normalize / readback
      const normReq = {
        request_id: "norm-001",
        command: "normalize_otio",
        input_path: otioPath,
        output_path: normalizedPath,
        options: {},
        expected_bridge_version: "1.0.0",
      };

      const normResult = child_process.spawnSync(
        "python3",
        [bridgeScriptPath],
        {
          input: JSON.stringify(normReq),
          encoding: "utf-8",
          timeout: 30_000,
        },
      );

      expect(normResult.status).toBe(0);
      const normResponse = JSON.parse(normResult.stdout);
      expect(normResponse.ok).toBe(true);

      // Read normalized output and verify clip IDs
      const normalized = JSON.parse(fs.readFileSync(normalizedPath, "utf-8"));
      expect(normalized.exchange_clip_ids).toContain("test-project:2:CLP_A");
      expect(normalized.exchange_clip_ids).toContain("test-project:2:CLP_B");
      expect(normalized.clip_count).toBe(2);

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true });
    },
  );

  it.skipIf(!otioAvailable)(
    "bridge rejects version mismatch",
    () => {
      const request = {
        request_id: "test-ver",
        command: "export_otio",
        input_path: "/tmp/dummy.json",
        output_path: "/tmp/dummy.otio",
        options: {},
        expected_bridge_version: "99.0.0",
      };

      const result = child_process.spawnSync(
        "python3",
        [bridgeScriptPath],
        {
          input: JSON.stringify(request),
          encoding: "utf-8",
          timeout: 10_000,
        },
      );

      expect(result.status).not.toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.ok).toBe(false);
    },
  );

  it("bridge reports error for invalid JSON input", () => {
    const result = child_process.spawnSync(
      "python3",
      [bridgeScriptPath],
      {
        input: "not json",
        encoding: "utf-8",
        timeout: 10_000,
      },
    );

    expect(result.status).not.toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. Bridge Fingerprint — Script Hash
// ═══════════════════════════════════════════════════════════════════

describe("bridge fingerprint", () => {
  it("bridge script has a stable sha256 hash", () => {
    const bridgeScriptPath = path.resolve("runtime/handoff/otio-bridge.py");
    const content = fs.readFileSync(bridgeScriptPath, "utf-8");
    const hash = sha256(content);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("bridge version matches contract constant", () => {
    const bridgeScriptPath = path.resolve("runtime/handoff/otio-bridge.py");
    const content = fs.readFileSync(bridgeScriptPath, "utf-8");
    expect(content).toContain(`BRIDGE_VERSION = "${BRIDGE_VERSION}"`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 10. Export Readback — Structural Tests
// ═══════════════════════════════════════════════════════════════════

describe("export readback validation (structural)", () => {
  it.skipIf(!otioAvailable)(
    "readback detects retained stable IDs after export",
    async () => {
      const { validateReadback } = await import("../runtime/handoff/export.js");
      const bridgeScriptPath = path.resolve("runtime/handoff/otio-bridge.py");

      // Create a temp dir and export an OTIO
      const tmpDir = fs.mkdtempSync(path.join("/tmp", "readback-test-"));
      const inputPath = path.join(tmpDir, "bridge_input.json");
      const otioPath = path.join(tmpDir, "test.otio");
      const normalizedPath = path.join(tmpDir, "normalized.json");

      const bridgeInput = {
        project_id: "rb-test",
        timeline_version: "1",
        handoff_id: "HND_1_TEST",
        capability_profile_id: "test",
        approval_status: "clean",
        sequence: { name: "Test", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
        tracks: {
          video: [
            {
              track_id: "V1",
              exchange_track_id: "rb-test:1:V1",
              kind: "video",
              clips: [
                {
                  clip_id: "CLP_RB1",
                  exchange_clip_id: "rb-test:1:CLP_RB1",
                  track_id: "V1",
                  segment_id: "SEG_RB1",
                  asset_id: "AST_RB1",
                  beat_id: "beat_1",
                  role: "hero",
                  src_in_us: 0,
                  src_out_us: 2000000,
                  timeline_in_frame: 0,
                  timeline_duration_frames: 48,
                  capability_profile_id: "test",
                },
              ],
            },
          ],
          audio: [],
        },
        markers: [],
      };

      fs.writeFileSync(inputPath, JSON.stringify(bridgeInput), "utf-8");

      // Export
      const exportReq = {
        request_id: "rb-export",
        command: "export_otio",
        input_path: inputPath,
        output_path: otioPath,
        options: { normalized_output_path: normalizedPath },
        expected_bridge_version: "1.0.0",
      };

      const exportResult = child_process.spawnSync(
        "python3",
        [bridgeScriptPath],
        {
          input: JSON.stringify(exportReq),
          encoding: "utf-8",
          timeout: 30_000,
        },
      );
      expect(exportResult.status).toBe(0);

      // Now validate readback
      const readback = validateReadback(
        otioPath,
        ["rb-test:1:CLP_RB1"],
        { bridgeScriptPath },
      );

      expect(readback.valid).toBe(true);
      expect(readback.retainedClipIds).toContain("rb-test:1:CLP_RB1");
      expect(readback.missingClipIds).toHaveLength(0);

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true });
    },
  );
});
