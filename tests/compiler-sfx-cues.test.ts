import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { compile } from "../runtime/compiler/index.js";

const roots: string[] = [];
const SAMPLE_PROJECT = path.resolve("projects/sample");
const CREATED_AT = "2026-07-28T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function hashFile(filePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function copyProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-sfx-cues-"));
  roots.push(root);
  const project = path.join(root, "sample");
  fs.cpSync(SAMPLE_PROJECT, project, { recursive: true });
  fs.rmSync(path.join(project, "05_timeline", "timeline.json"), { force: true });
  return project;
}

function writeSfxArtifacts(project: string): void {
  const libraryRoot = path.join(project, "07_package", "fixture-sfx");
  const audioDir = path.join(libraryRoot, "audio");
  fs.mkdirSync(audioDir, { recursive: true });
  const sourcePath = path.join(audioDir, "simple.wav");
  fs.writeFileSync(sourcePath, "deterministic-compiler-sfx-fixture");
  const manifestPath = path.join(libraryRoot, "sfx-library.json");
  const manifest = {
    version: "sfx-library/v1",
    library_id: "compiler-test-sfx",
    library_version: "1.0.0",
    assets: [{
      asset_id: "sfx-simple-01",
      semantic_roles: ["simple_sound"],
      path: "audio/simple.wav",
      content_hash: hashFile(sourcePath),
      size_bytes: fs.statSync(sourcePath).size,
      duration_us: 1_000_000,
      rights: {
        status: "confirmed",
        basis: "deterministic_synthesis",
        usage_scope: "internal_audition",
        evidence_ref: "evidence:compiler-fixture-rights",
      },
      provenance: {
        origin: "deterministic_synthesis",
        source_ref: "provenance:compiler-fixture-sfx-v1",
        generated_at: "2026-07-28T00:00:00Z",
      },
    }],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestHash = hashFile(manifestPath);
  fs.writeFileSync(
    path.join(project, "07_package", "sfx_cues.json"),
    `${JSON.stringify({
      version: "sfx-cues/v1",
      project_id: "sample-mountain-reset",
      base_timeline_version: "1",
      timeline_fps: { num: 30_000, den: 1_001 },
      required: true,
      library: {
        manifest_path: manifestPath,
        library_id: manifest.library_id,
        library_version: manifest.library_version,
        manifest_hash: manifestHash,
      },
      cues: [{
        cue_id: "SFX_SIMPLE_000000",
        semantic_role: "simple_sound",
        asset_id: "sfx-simple-01",
        trigger_frame: 0,
        duration_frames: 15,
        source_range: { in_us: 0, out_us: 600_000 },
        gain_db: -18,
        fade_in_ms: 5,
        fade_out_ms: 100,
        tail: { max_frames: 5, policy: "trim_or_pad_to_limit" },
        duck_group: "none",
        ducking: { duck_gain_db: -24, attack_ms: 10, release_ms: 120 },
        asset_pin: {
          library_id: manifest.library_id,
          library_version: manifest.library_version,
          library_manifest_hash: manifestHash,
          asset_content_hash: manifest.assets[0].content_hash,
          asset_size_bytes: manifest.assets[0].size_bytes,
          rights_evidence_ref: manifest.assets[0].rights.evidence_ref,
          provenance_ref: manifest.assets[0].provenance.source_ref,
        },
        intent: "formal simple_sound compiler fixture",
      }],
    }, null, 2)}\n`,
  );
}

describe("compiler formal A3 SFX connection", () => {
  it("projects hash-pinned sfx-cues/v1 through compile and stays idempotent", () => {
    const project = copyProject();
    writeSfxArtifacts(project);
    const first = compile({
      projectPath: project,
      createdAt: CREATED_AT,
      repoRoot: path.resolve("."),
      fpsNum: 30_000,
      fpsDen: 1_001,
    });
    const second = compile({
      projectPath: project,
      createdAt: CREATED_AT,
      repoRoot: path.resolve("."),
      fpsNum: 30_000,
      fpsDen: 1_001,
    });
    const a3 = first.timeline.tracks.audio.find((track) => track.track_id === "A3");
    expect(a3?.clips).toHaveLength(1);
    expect(a3?.clips[0]).toMatchObject({
      clip_id: "A3_SFX_SIMPLE_000000",
      role: "sfx",
      audio_role: "sfx",
      timeline_in_frame: 0,
      timeline_duration_frames: 20,
      metadata: {
        sfx_cue: {
          semantic_role: "simple_sound",
          dialogue_finish_applied: false,
        },
        sfx_asset: {
          library_id: "compiler-test-sfx",
          asset_content_hash: expect.stringMatching(/^sha256:/),
        },
      },
    });
    expect(first.timeline).toEqual(second.timeline);
  });

  it("keeps original_only output unchanged even when an SFX artifact exists", () => {
    const project = copyProject();
    const briefPath = path.join(project, "01_intent", "creative_brief.yaml");
    const brief = parseYaml(fs.readFileSync(briefPath, "utf8")) as Record<string, unknown>;
    brief.audio_policy = "original_only";
    fs.writeFileSync(briefPath, stringifyYaml(brief));
    const baseline = compile({
      projectPath: project,
      createdAt: CREATED_AT,
      repoRoot: path.resolve("."),
      fpsNum: 30_000,
      fpsDen: 1_001,
    });
    writeSfxArtifacts(project);
    const withSfxArtifact = compile({
      projectPath: project,
      createdAt: CREATED_AT,
      repoRoot: path.resolve("."),
      fpsNum: 30_000,
      fpsDen: 1_001,
    });
    expect(withSfxArtifact.timeline).toEqual(baseline.timeline);
    expect(withSfxArtifact.timeline.tracks.audio.some(
      (track) => track.track_id === "A3" && track.clips.some((clip) => clip.role === "sfx"),
    )).toBe(false);
  });
});
