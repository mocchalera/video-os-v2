import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { validateProject } from "../scripts/validate-schemas.js";
import { resolvePolicy, deepMerge as productionDeepMerge } from "../runtime/policy-resolver.js";

const SAMPLE_PROJECT = "projects/sample";

// ── Helper: deep merge for policy tests ─────────────────────────────

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Helper: temp project creation ───────────────────────────────────

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

function createTempProject(
  name: string,
  patches: Record<string, unknown>,
): string {
  const tmpDir = path.resolve(`test-fixtures-m2-${name}-${Date.now()}`);
  copyDirSync(path.resolve(SAMPLE_PROJECT), tmpDir);

  for (const [relPath, content] of Object.entries(patches)) {
    const absPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    if (typeof content === "string") {
      fs.writeFileSync(absPath, content, "utf-8");
    } else {
      const ext = path.extname(relPath);
      if (ext === ".json") {
        fs.writeFileSync(absPath, JSON.stringify(content, null, 2), "utf-8");
      } else {
        fs.writeFileSync(absPath, stringifyYaml(content), "utf-8");
      }
    }
  }
  return tmpDir;
}

function removeDirSync(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ── Load defaults for policy tests ──────────────────────────────────

function loadDefaults(): Record<string, unknown> {
  const raw = fs.readFileSync(
    path.resolve("runtime/analysis-defaults.yaml"),
    "utf-8",
  );
  return parseYaml(raw) as Record<string, unknown>;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("M2 Phase 1 — analysis schemas", () => {
  const tempDirs: string[] = [];
  afterAll(() => tempDirs.forEach(removeDirSync));

  // ── 1. Fixture backward compatibility ─────────────────────────────

  describe("fixture backward compatibility", () => {
    it("sample project assets.json validates against assets schema", () => {
      const result = validateProject(SAMPLE_PROJECT);

      const assetViolations = result.violations.filter(
        (v) => v.artifact === "03_analysis/assets.json",
      );
      expect(assetViolations).toHaveLength(0);
    });

    it("sample project segments.json validates against segments schema", () => {
      const result = validateProject(SAMPLE_PROJECT);

      const segViolations = result.violations.filter(
        (v) => v.artifact === "03_analysis/segments.json",
      );
      expect(segViolations).toHaveLength(0);
    });

    it("sample project transcripts validate against transcript schema", () => {
      const result = validateProject(SAMPLE_PROJECT);

      const trViolations = result.violations.filter(
        (v) => v.artifact.startsWith("03_analysis/transcripts/"),
      );
      expect(trViolations).toHaveLength(0);
    });

    it("sample project still passes all validation with new schemas", () => {
      const result = validateProject(SAMPLE_PROJECT);

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.compile_gate).toBe("open");
      // Should now include analysis artifacts too
      expect(result.artifacts_checked).toBeGreaterThanOrEqual(8);
    });
  });

  // ── 2. Assets schema validation ───────────────────────────────────

  describe("assets schema", () => {
    it("accepts asset with new optional fields (live profile)", () => {
      const liveAssets = {
        project_id: "test-live",
        artifact_version: "analysis-v2",
        items: [
          {
            asset_id: "AST_001",
            filename: "test.mov",
            role_guess: "interview",
            duration_us: 60000000,
            has_transcript: true,
            transcript_ref: "TR_AST_001",
            segments: 2,
            segment_ids: ["SEG_0001", "SEG_0002"],
            quality_flags: [],
            tags: ["test"],
            source_fingerprint: "sha256:abc123",
            video_stream: {
              width: 1920,
              height: 1080,
              fps_num: 24,
              fps_den: 1,
              codec: "h264",
            },
            audio_stream: {
              sample_rate: 48000,
              channels: 2,
              codec: "aac",
            },
            contact_sheet_ids: ["CS_001"],
            poster_path: "posters/AST_001.jpg",
            waveform_path: "waveforms/AST_001.png",
            analysis_status: "ready",
            provenance: {
              stage: "ingest.reduce",
              method: "ffprobe",
              connector_version: "1.0.0",
              policy_hash: "sha256:def456",
              request_hash: "sha256:ghi789",
              ffmpeg_version: "6.1",
            },
          },
        ],
      };

      const tmp = createTempProject("live-assets", {
        "03_analysis/assets.json": liveAssets,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const assetViolations = result.violations.filter(
        (v) => v.artifact === "03_analysis/assets.json",
      );
      expect(assetViolations).toHaveLength(0);
    });

    it("rejects asset with unknown field", () => {
      const assets = JSON.parse(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "03_analysis/assets.json"),
          "utf-8",
        ),
      );
      assets.items[0].unknown_field = "should fail";

      const tmp = createTempProject("bad-asset-field", {
        "03_analysis/assets.json": assets,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "03_analysis/assets.json" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects asset missing required field", () => {
      const assets = {
        project_id: "test",
        artifact_version: "analysis-v1",
        items: [
          {
            asset_id: "AST_001",
            filename: "test.mov",
            // missing duration_us and other required fields
          },
        ],
      };

      const tmp = createTempProject("asset-missing-req", {
        "03_analysis/assets.json": assets,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "03_analysis/assets.json" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects invalid analysis_status value", () => {
      const assets = JSON.parse(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "03_analysis/assets.json"),
          "utf-8",
        ),
      );
      assets.items[0].analysis_status = "invalid_status";

      const tmp = createTempProject("bad-analysis-status", {
        "03_analysis/assets.json": assets,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "03_analysis/assets.json" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 3. Segments schema validation ─────────────────────────────────

  describe("segments schema", () => {
    it("accepts segment with new optional fields (live profile)", () => {
      const liveSegments = {
        project_id: "test-live",
        artifact_version: "analysis-v2",
        items: [
          {
            segment_id: "SEG_0001",
            asset_id: "AST_001",
            src_in_us: 0,
            src_out_us: 5000000,
            summary: "test segment",
            transcript_excerpt: "hello world",
            quality_flags: [],
            tags: ["test"],
            duration_us: 5000000,
            rep_frame_us: 2500000,
            segment_type: "dialogue",
            interest_points: [{ frame_us: 2500000, label: "cut", confidence: 0.9 }],
            filmstrip_path: "filmstrips/SEG_0001.jpg",
            transcript_ref: "TR_AST_001",
            confidence: {
              boundary: { score: 0.95, source: "ffmpeg", status: "confirmed" },
              summary: { score: 0.80, source: "vlm", status: "provisional" },
            },
            provenance: {
              boundary: {
                stage: "segment.map",
                method: "scene_detect",
                connector_version: "1.0.0",
                policy_hash: "sha256:abc",
                request_hash: "sha256:def",
                ffmpeg_version: "6.1",
              },
            },
          },
        ],
      };

      const tmp = createTempProject("live-segments", {
        "03_analysis/segments.json": liveSegments,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const segViolations = result.violations.filter(
        (v) => v.artifact === "03_analysis/segments.json",
      );
      expect(segViolations).toHaveLength(0);
    });

    it("rejects invalid segment_type value", () => {
      const segments = JSON.parse(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "03_analysis/segments.json"),
          "utf-8",
        ),
      );
      segments.items[0].segment_type = "invalid_type";

      const tmp = createTempProject("bad-seg-type", {
        "03_analysis/segments.json": segments,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "03_analysis/segments.json" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 4. Segment src_in_us < src_out_us runner check ────────────────

  describe("segment src_in_us < src_out_us", () => {
    it("detects violation when src_in_us >= src_out_us in segments", () => {
      const segments = JSON.parse(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "03_analysis/segments.json"),
          "utf-8",
        ),
      );
      segments.items[0].src_in_us = 9999999;
      segments.items[0].src_out_us = 1000000;

      const tmp = createTempProject("seg-time-inv", {
        "03_analysis/segments.json": segments,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const timeViolations = result.violations.filter(
        (v) =>
          v.rule === "src_in_us_lt_src_out_us" &&
          v.artifact === "03_analysis/segments.json",
      );
      expect(timeViolations.length).toBeGreaterThanOrEqual(1);
      expect(timeViolations[0].message).toContain("SEG_0001");
    });

    it("passes when all segments have valid time ranges", () => {
      const result = validateProject(SAMPLE_PROJECT);

      const timeViolations = result.violations.filter(
        (v) =>
          v.rule === "src_in_us_lt_src_out_us" &&
          v.artifact === "03_analysis/segments.json",
      );
      expect(timeViolations).toHaveLength(0);
    });
  });

  // ── 5. Transcript schema validation ───────────────────────────────

  describe("transcript schema", () => {
    it("accepts transcript with new optional fields (live profile)", () => {
      const liveTranscript = {
        project_id: "test-live",
        artifact_version: "analysis-v2",
        transcript_ref: "TR_AST_001",
        asset_id: "AST_001",
        language: "en",
        language_confidence: 0.98,
        analysis_status: "ready",
        word_timing_mode: "word",
        provenance: {
          stage: "stt.map",
          method: "whisper",
          connector_version: "1.0.0",
          policy_hash: "sha256:abc",
          request_hash: "sha256:def",
          model_alias: "gpt-4o-transcribe-diarize",
          model_snapshot: "2025-03-01",
        },
        items: [
          {
            speaker: "S1",
            start_us: 6600000,
            end_us: 10700000,
            text: "I came up here to get quiet again.",
            item_id: "UTT_001",
            speaker_key: "speaker_0",
            speaker_confidence: 0.92,
            confidence: 0.95,
            words: [
              { word: "I", start_us: 6600000, end_us: 6700000, confidence: 0.99 },
              { word: "came", start_us: 6700000, end_us: 6900000, confidence: 0.97 },
            ],
          },
        ],
      };

      const tmp = createTempProject("live-transcript", {
        "03_analysis/transcripts/TR_AST_001.json": liveTranscript,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const trViolations = result.violations.filter(
        (v) => v.artifact === "03_analysis/transcripts/TR_AST_001.json",
      );
      expect(trViolations).toHaveLength(0);
    });

    it("rejects transcript missing required root fields", () => {
      const badTranscript = {
        project_id: "test",
        artifact_version: "analysis-v1",
        // missing transcript_ref, asset_id, items
      };

      const tmp = createTempProject("bad-transcript", {
        "03_analysis/transcripts/TR_BAD.json": badTranscript,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) =>
          v.artifact === "03_analysis/transcripts/TR_BAD.json" &&
          v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects transcript item missing required fields", () => {
      const badTranscript = {
        project_id: "test",
        artifact_version: "analysis-v1",
        transcript_ref: "TR_BAD",
        asset_id: "AST_001",
        items: [
          {
            speaker: "S1",
            // missing start_us, end_us, text
          },
        ],
      };

      const tmp = createTempProject("bad-tr-item", {
        "03_analysis/transcripts/TR_BAD.json": badTranscript,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) =>
          v.artifact === "03_analysis/transcripts/TR_BAD.json" &&
          v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 6. Analysis policy schema validation ──────────────────────────

  describe("analysis policy schema", () => {
    it("validates the default policy from runtime/analysis-defaults.yaml", () => {
      const defaults = loadDefaults();

      const tmp = createTempProject("policy-defaults", {
        "analysis_policy.yaml": defaults,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const policyViolations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml",
      );
      expect(policyViolations).toHaveLength(0);
    });

    it("partial override missing root fields is accepted (merged from defaults)", () => {
      // After the FATAL fix, a partial override with missing root fields
      // is merged with defaults — the result is valid.
      const tmp = createTempProject("policy-partial-root", {
        "analysis_policy.yaml": { parallelism: { vlm_jobs: 4 } },
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml",
      );
      expect(violations).toHaveLength(0);
    });

    it("rejects override that introduces invalid nested value", () => {
      // Override vlm.model_alias with empty string — still invalid after merge
      const tmp = createTempProject("policy-bad-vlm-alias", {
        "analysis_policy.yaml": { vlm: { model_alias: "" } },
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects policy with additional unknown root field", () => {
      const defaults = loadDefaults();
      (defaults as Record<string, unknown>).unknown_section = { key: "value" };

      const tmp = createTempProject("policy-extra-field", {
        "analysis_policy.yaml": defaults,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 7. Policy merge tests ─────────────────────────────────────────

  describe("policy merge", () => {
    it("deep merges defaults with project override", () => {
      const defaults = loadDefaults();
      const override: Record<string, unknown> = {
        vlm: {
          model_snapshot: "gemini-2.0-flash-20250301",
        },
        parallelism: {
          vlm_jobs: 4,
        },
      };

      const merged = deepMerge(defaults, override);
      const vlm = merged.vlm as Record<string, unknown>;
      const parallelism = merged.parallelism as Record<string, unknown>;

      // Overridden values
      expect(vlm.model_snapshot).toBe("gemini-2.0-flash-20250301");
      expect(parallelism.vlm_jobs).toBe(4);

      // Non-overridden values preserved
      expect(vlm.model_alias).toBe("gemini-2.0-flash");
      expect(parallelism.ffmpeg_jobs).toBe(4);
      expect(parallelism.stt_jobs).toBe(2);
    });

    it("merged policy validates against schema", () => {
      const defaults = loadDefaults();
      const override: Record<string, unknown> = {
        vlm: {
          model_snapshot: "gemini-2.0-flash-20250301",
        },
        stt: {
          model_snapshot: "gpt-4o-transcribe-20250301",
        },
      };

      const merged = deepMerge(defaults, override);

      const tmp = createTempProject("policy-merged", {
        "analysis_policy.yaml": merged,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const policyViolations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml",
      );
      expect(policyViolations).toHaveLength(0);
    });

    it("override replaces arrays entirely (no array merge)", () => {
      const defaults = loadDefaults();
      const override: Record<string, unknown> = {
        cache: {
          request_hash_fields: ["model_snapshot", "prompt_hash"],
        },
      };

      const merged = deepMerge(defaults, override);
      const cache = merged.cache as Record<string, unknown>;
      const fields = cache.request_hash_fields as string[];

      expect(fields).toEqual(["model_snapshot", "prompt_hash"]);
    });
  });

  // ── 8. Shared $defs cross-reference validation ────────────────────

  describe("analysis-common $ref resolution", () => {
    it("provenance-record rejects unknown fields via additionalProperties", () => {
      const assets = JSON.parse(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "03_analysis/assets.json"),
          "utf-8",
        ),
      );
      assets.items[0].provenance = {
        stage: "ingest.reduce",
        method: "ffprobe",
        connector_version: "1.0.0",
        policy_hash: "sha256:abc",
        request_hash: "sha256:def",
        unknown_prov_field: "should fail",
      };

      const tmp = createTempProject("bad-provenance", {
        "03_analysis/assets.json": assets,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "03_analysis/assets.json" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("confidence-record validates correct data", () => {
      const assets = JSON.parse(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "03_analysis/assets.json"),
          "utf-8",
        ),
      );
      assets.items[0].confidence = {
        score: 0.85,
        source: "ffprobe",
        status: "confirmed",
        label: "high quality",
      };

      const tmp = createTempProject("good-confidence", {
        "03_analysis/assets.json": assets,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "03_analysis/assets.json" && v.rule === "schema",
      );
      expect(violations).toHaveLength(0);
    });

    it("confidence-record rejects score out of range", () => {
      const assets = JSON.parse(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "03_analysis/assets.json"),
          "utf-8",
        ),
      );
      assets.items[0].confidence = {
        score: 1.5, // out of range
        source: "ffprobe",
        status: "confirmed",
      };

      const tmp = createTempProject("bad-confidence-score", {
        "03_analysis/assets.json": assets,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "03_analysis/assets.json" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 9. FATAL fix: policy resolver + partial override ──────────────

  describe("policy resolver (FATAL fix)", () => {
    it("partial override is accepted after merge with defaults", () => {
      // A partial override only sets parallelism.vlm_jobs — this should
      // merge with defaults and pass schema validation.
      const tmp = createTempProject("partial-override", {
        "analysis_policy.yaml": { parallelism: { vlm_jobs: 4 } },
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const policyViolations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml",
      );
      expect(policyViolations).toHaveLength(0);
    });

    it("partial override with vlm.model_snapshot is accepted", () => {
      const tmp = createTempProject("partial-vlm-snap", {
        "analysis_policy.yaml": {
          vlm: { model_snapshot: "gemini-2.0-flash-20250301" },
          stt: { model_snapshot: "gpt-4o-transcribe-20250301" },
        },
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const policyViolations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml",
      );
      expect(policyViolations).toHaveLength(0);
    });

    it("production resolvePolicy returns merged result", () => {
      const tmp = createTempProject("resolver-unit", {
        "analysis_policy.yaml": { parallelism: { vlm_jobs: 8 } },
      });
      tempDirs.push(tmp);

      const { resolved, hasOverride } = resolvePolicy(tmp);

      expect(hasOverride).toBe(true);
      const par = resolved.parallelism as Record<string, unknown>;
      expect(par.vlm_jobs).toBe(8);
      expect(par.ffmpeg_jobs).toBe(4); // from defaults
      expect(par.stt_jobs).toBe(2); // from defaults
    });

    it("production resolvePolicy returns defaults when no override", () => {
      const tmp = createTempProject("resolver-no-override", {});
      tempDirs.push(tmp);

      const { resolved, hasOverride } = resolvePolicy(tmp);

      expect(hasOverride).toBe(false);
      expect(resolved.version).toBe("1");
      expect(resolved.policy_name).toBe("m2-canonical-defaults");
    });

    it("production deepMerge matches test deepMerge", () => {
      const defaults = loadDefaults();
      const override = {
        vlm: { model_snapshot: "snap1" },
        parallelism: { vlm_jobs: 16 },
      };

      const testMerged = deepMerge(defaults, override);
      const prodMerged = productionDeepMerge(defaults, override);

      expect(prodMerged).toEqual(testMerged);
    });

    it("invalid override value still fails after merge", () => {
      // Override vlm.input_mode with an invalid enum value
      const tmp = createTempProject("bad-override-enum", {
        "analysis_policy.yaml": {
          vlm: { input_mode: "invalid_mode" },
        },
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 10. W1: policy vocabulary / typo rejection ────────────────────

  describe("policy vocabulary (W1 fix)", () => {
    it("rejects typo field in sampling sub-object", () => {
      const defaults = loadDefaults();
      const sampling = defaults.sampling as Record<string, unknown>;
      const action = sampling.action as Record<string, unknown>;
      (action as Record<string, unknown>).sample_fps_typo = 999;

      const tmp = createTempProject("policy-sampling-typo", {
        "analysis_policy.yaml": defaults,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects typo field in classification sub-object", () => {
      const defaults = loadDefaults();
      const cls = defaults.classification as Record<string, unknown>;
      const dialogue = cls.dialogue as Record<string, unknown>;
      (dialogue as Record<string, unknown>).words_per_second_typo = 2.0;

      const tmp = createTempProject("policy-cls-typo", {
        "analysis_policy.yaml": defaults,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects invalid vlm.input_mode value", () => {
      const defaults = loadDefaults();
      const vlm = defaults.vlm as Record<string, unknown>;
      vlm.input_mode = "raw_video_upload";

      const tmp = createTempProject("policy-bad-input-mode", {
        "analysis_policy.yaml": defaults,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects invalid stt.chunking_strategy value", () => {
      const defaults = loadDefaults();
      const stt = defaults.stt as Record<string, unknown>;
      stt.chunking_strategy = "server_side_v1";

      const tmp = createTempProject("policy-bad-chunking", {
        "analysis_policy.yaml": defaults,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects invalid stt.speaker_normalization value", () => {
      const defaults = loadDefaults();
      const stt = defaults.stt as Record<string, unknown>;
      stt.speaker_normalization = "random_assign_v1";

      const tmp = createTempProject("policy-bad-speaker-norm", {
        "analysis_policy.yaml": defaults,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "analysis_policy.yaml" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 11. W2: interest_points contract ──────────────────────────────

  describe("interest_points contract (W2 fix)", () => {
    it("rejects interest_points with wrong shape", () => {
      const segments = JSON.parse(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "03_analysis/segments.json"),
          "utf-8",
        ),
      );
      segments.items[0].interest_points = [
        { totally: "wrong", outside: true },
      ];

      const tmp = createTempProject("bad-interest-points", {
        "03_analysis/segments.json": segments,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "03_analysis/segments.json" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects interest_points missing required field", () => {
      const segments = JSON.parse(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "03_analysis/segments.json"),
          "utf-8",
        ),
      );
      segments.items[0].interest_points = [
        { frame_us: 2500000, label: "cut" }, // missing confidence
      ];

      const tmp = createTempProject("ip-missing-confidence", {
        "03_analysis/segments.json": segments,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "03_analysis/segments.json" && v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("accepts valid interest_points", () => {
      const segments = JSON.parse(
        fs.readFileSync(
          path.resolve(SAMPLE_PROJECT, "03_analysis/segments.json"),
          "utf-8",
        ),
      );
      segments.items[0].interest_points = [
        { frame_us: 2500000, label: "cut", confidence: 0.9 },
      ];

      const tmp = createTempProject("good-interest-points", {
        "03_analysis/segments.json": segments,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.artifact === "03_analysis/segments.json" && v.rule === "schema",
      );
      expect(violations).toHaveLength(0);
    });
  });

  // ── 12. W3: transcript live-profile + path invariants ─────────────

  describe("transcript live-profile (W3 fix)", () => {
    it("rejects live transcript (analysis_status: ready) without word_timing_mode", () => {
      const badTranscript = {
        project_id: "test",
        artifact_version: "analysis-v2",
        transcript_ref: "TR_AST_001",
        asset_id: "AST_001",
        analysis_status: "ready",
        // missing word_timing_mode — required when analysis_status is ready
        items: [
          { speaker: "S1", start_us: 0, end_us: 1000000, text: "hello" },
        ],
      };

      const tmp = createTempProject("live-no-wtm", {
        "03_analysis/transcripts/TR_AST_001.json": badTranscript,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) =>
          v.artifact === "03_analysis/transcripts/TR_AST_001.json" &&
          v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects live transcript (analysis_status: partial) without word_timing_mode", () => {
      const badTranscript = {
        project_id: "test",
        artifact_version: "analysis-v2",
        transcript_ref: "TR_AST_001",
        asset_id: "AST_001",
        analysis_status: "partial",
        items: [
          { speaker: "S1", start_us: 0, end_us: 1000000, text: "hello" },
        ],
      };

      const tmp = createTempProject("partial-no-wtm", {
        "03_analysis/transcripts/TR_AST_001.json": badTranscript,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) =>
          v.artifact === "03_analysis/transcripts/TR_AST_001.json" &&
          v.rule === "schema",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("accepts transcript without analysis_status (no word_timing_mode required)", () => {
      const transcript = {
        project_id: "test",
        artifact_version: "analysis-v1",
        transcript_ref: "TR_AST_001",
        asset_id: "AST_001",
        items: [
          { speaker: "S1", start_us: 0, end_us: 1000000, text: "hello" },
        ],
      };

      const tmp = createTempProject("no-status-no-wtm", {
        "03_analysis/transcripts/TR_AST_001.json": transcript,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) =>
          v.artifact === "03_analysis/transcripts/TR_AST_001.json" &&
          v.rule === "schema",
      );
      expect(violations).toHaveLength(0);
    });

    it("accepts live transcript with word_timing_mode present", () => {
      const transcript = {
        project_id: "test",
        artifact_version: "analysis-v2",
        transcript_ref: "TR_AST_001",
        asset_id: "AST_001",
        analysis_status: "ready",
        word_timing_mode: "word",
        items: [
          { speaker: "S1", start_us: 0, end_us: 1000000, text: "hello" },
        ],
      };

      const tmp = createTempProject("live-with-wtm", {
        "03_analysis/transcripts/TR_AST_001.json": transcript,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) =>
          v.artifact === "03_analysis/transcripts/TR_AST_001.json" &&
          v.rule === "schema",
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("transcript path invariants (W3 fix)", () => {
    it("detects transcript_ref mismatch with filename", () => {
      const badTranscript = {
        project_id: "test",
        artifact_version: "analysis-v1",
        transcript_ref: "TR_AST_999", // mismatch: file is TR_AST_001.json
        asset_id: "AST_001",
        items: [
          { speaker: "S1", start_us: 0, end_us: 1000000, text: "hello" },
        ],
      };

      const tmp = createTempProject("tr-ref-mismatch", {
        "03_analysis/transcripts/TR_AST_001.json": badTranscript,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.rule === "transcript_ref_matches_filename",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("detects asset_id mismatch with filename", () => {
      const badTranscript = {
        project_id: "test",
        artifact_version: "analysis-v1",
        transcript_ref: "TR_AST_001",
        asset_id: "AST_999", // mismatch: file is TR_AST_001.json
        items: [
          { speaker: "S1", start_us: 0, end_us: 1000000, text: "hello" },
        ],
      };

      const tmp = createTempProject("asset-id-mismatch", {
        "03_analysis/transcripts/TR_AST_001.json": badTranscript,
      });
      tempDirs.push(tmp);

      const result = validateProject(tmp);

      const violations = result.violations.filter(
        (v) => v.rule === "asset_id_matches_filename",
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("passes when filename matches transcript_ref and asset_id", () => {
      const result = validateProject(SAMPLE_PROJECT);

      const violations = result.violations.filter(
        (v) =>
          v.rule === "transcript_ref_matches_filename" ||
          v.rule === "asset_id_matches_filename",
      );
      expect(violations).toHaveLength(0);
    });
  });
});
