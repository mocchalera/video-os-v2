import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { compile } from "../runtime/compiler/index.js";
import { buildRenderSourceReadiness } from "../runtime/compiler/render-readiness.js";
import { loadSourceMap } from "../runtime/media/source-map.js";

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
  const blueprintPath = path.join(project, "04_plan", "edit_blueprint.yaml");
  const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf8")) as Record<string, unknown>;
  blueprint.timeline_operations = [{
    operation_id: "OP_SFX_FIXTURE_TAIL",
    type: "gap",
    track_id: "V1",
    start_frame: 720,
    duration_frames: 119,
    authority: "operator",
    reason: "fixture intentionally leaves the unselected tail outside the authored visual clips",
  }, {
    operation_id: "OP_SFX_FIXTURE_TAIL_A1",
    type: "ambient_continuation",
    track_id: "A1",
    start_frame: 720,
    duration_frames: 119,
    authority: "operator",
    reason: "fixture keeps room tone across the intentionally unused audio tail",
  }];
  fs.writeFileSync(blueprintPath, stringifyYaml(blueprint));
  return project;
}

function writeSourceMap(project: string): void {
  const mediaDir = path.join(project, "02_media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const items = ["AST_001", "AST_002", "AST_003", "AST_004", "AST_005", "AST_006"].map((assetId) => {
    const filename = `${assetId.toLowerCase()}.mov`;
    fs.writeFileSync(path.join(mediaDir, filename), `compiler source fixture ${assetId}\n`);
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
  fs.writeFileSync(path.join(mediaDir, "source_map.json"), JSON.stringify({
    version: "1",
    project_id: "sample-mountain-reset",
    media_dir: "02_media",
    generated_at: CREATED_AT,
    items,
  }));
}

function writeSfxArtifacts(
  project: string,
  options: { libraryRoot?: string; scope?: "repo_common" | "project_local" } = {},
): { sourcePath: string; manifestPath: string } {
  const libraryRoot = options.libraryRoot ?? path.join(project, "07_package", "fixture-sfx");
  const scope = options.scope ?? "project_local";
  const audioDir = path.join(libraryRoot, "audio");
  fs.mkdirSync(audioDir, { recursive: true });
  const sourcePath = path.join(audioDir, "simple.wav");
  fs.writeFileSync(sourcePath, "deterministic-compiler-sfx-fixture");
  const manifestPath = path.join(libraryRoot, "sfx-library.json");
  const manifest = {
    version: "sfx-library/v1",
    library_id: "compiler-test-sfx",
    library_version: "1.0.0",
    scope,
    review_status: "approved",
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
        usage_scope: "project_render",
        evidence_ref: "evidence:compiler-fixture-rights",
        verified_at: "2026-08-21T00:00:00Z",
        permitted_derivatives: ["project_render"],
      },
      provenance: {
        origin: "deterministic_synthesis",
        source_ref: "provenance:compiler-fixture-sfx-v1",
        generated_at: "2026-07-28T00:00:00Z",
        status: "verified",
        evidence_ref: "evidence:compiler-fixture-provenance",
      },
      review_status: "approved",
    }],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.mkdirSync(path.join(project, "07_package"), { recursive: true });
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
        scope,
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
  return { sourcePath, manifestPath };
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
          rights_status: "confirmed",
          provenance_status: "verified",
          review_status: "approved",
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

  it("uses the validated repo-common SFX authority for public readiness and rejects drift", () => {
    const project = copyProject();
    writeSourceMap(project);
    const repoSfxRoot = path.join(path.dirname(project), "repo-common-sfx");
    const fixture = writeSfxArtifacts(project, {
      libraryRoot: repoSfxRoot,
      scope: "repo_common",
    });
    const canonicalRepoSfxRoot = fs.realpathSync(repoSfxRoot);
    const canonicalSourcePath = fs.realpathSync(fixture.sourcePath);

    const compileOptions = {
      projectPath: project,
      createdAt: CREATED_AT,
      repoRoot: path.resolve("."),
      repoSfxRoot,
      fpsNum: 30_000,
      fpsDen: 1_001,
      validateSourceArtifacts: true,
    } as const;
    const result = compile(compileOptions);
    expect(result.render_readiness?.status).toBe("ready");
    expect(result.render_readiness?.resolutions).toContainEqual(expect.objectContaining({
      asset_id: "sfx-simple-01",
      status: "resolved",
      source_path: canonicalSourcePath,
      expected_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(result.render_readiness?.external_sources).toContainEqual(expect.objectContaining({
      canonical_source_root: canonicalRepoSfxRoot,
      asset_ids: ["sfx-simple-01"],
      read_only_authority: true,
    }));

    const sfxClip = result.timeline.tracks.audio
      .find((track) => track.track_id === "A3")?.clips
      .find((clip) => clip.asset_id === "sfx-simple-01");
    expect(sfxClip).toBeDefined();
    const pinnedHash = hashFile(fixture.sourcePath);
    const manifestHash = hashFile(fixture.manifestPath);
    const formalSfxSources = new Map([[
      sfxClip!.clip_id,
      {
        cue_id: "SFX_SIMPLE_000000",
        asset_id: "sfx-simple-01",
        semantic_role: "simple_sound",
        source_path: canonicalSourcePath,
        expected_sha256: pinnedHash,
        authority_root: canonicalRepoSfxRoot,
        sfx_asset: {
          asset_id: "sfx-simple-01",
          source_path: canonicalSourcePath,
          library_id: "compiler-test-sfx",
          library_version: "1.0.0",
          library_manifest_hash: manifestHash,
          library_scope: "repo_common" as const,
          asset_content_hash: pinnedHash,
        },
      },
    ]]);

    const ordinaryTimeline = structuredClone(result.timeline);
    const ordinaryClip = ordinaryTimeline.tracks.audio
      .find((track) => track.track_id === "A3")?.clips
      .find((clip) => clip.clip_id === sfxClip!.clip_id);
    expect(ordinaryClip).toBeDefined();
    ordinaryClip!.metadata = undefined;
    const ordinaryReadiness = buildRenderSourceReadiness({
      projectPath: project,
      projectId: ordinaryTimeline.project_id,
      createdAt: CREATED_AT,
      timeline: ordinaryTimeline,
      sourceMap: loadSourceMap(project),
      formalSfxSources,
    });
    expect(ordinaryReadiness.resolutions).toContainEqual(expect.objectContaining({
      asset_id: "sfx-simple-01",
      status: "unresolved",
      issue: "no source-map entry for asset",
    }));

    fs.appendFileSync(fixture.sourcePath, "tampered\n");

    const formalReadiness = buildRenderSourceReadiness({
      projectPath: project,
      projectId: result.timeline.project_id,
      createdAt: CREATED_AT,
      timeline: result.timeline,
      sourceMap: loadSourceMap(project),
      formalSfxSources,
    });
    expect(formalReadiness.resolutions).toContainEqual(expect.objectContaining({
      asset_id: "sfx-simple-01",
      status: "hash_mismatch",
    }));
    expect(() => compile(compileOptions)).toThrow(/SFX_LIBRARY_DRIFT/);
  });
});
