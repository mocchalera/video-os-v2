import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateArtifact } from "../runtime/artifacts/loaders.js";
import {
  checkSfxMixPolicy,
} from "../runtime/packaging/qa.js";
import type { AudioMixReport } from "../runtime/audio/mixer.js";
import { executeAudioRenderPlan } from "../runtime/audio/render-executor.js";
import {
  hashAudioRenderPlan,
  resolveAudioRenderPlan,
} from "../runtime/audio/render-plan.js";
import {
  loadSfxLibraryManifest,
  loadSfxLibraryRegistry,
  resolveSfxAssetFromRegistry,
} from "../runtime/audio/sfx-library.js";
import { promoteSfxAsset } from "../runtime/audio/sfx-promotion.js";
import {
  projectSfxToTimeline,
  resolveSfxCuePlan,
  type SfxCuesDoc,
} from "../runtime/audio/sfx-cues.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function hashBytes(value: Buffer | string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function timeline(): TimelineIR {
  return {
    version: "7",
    project_id: "rfa-022-registry-test",
    created_at: "2026-08-21T00:00:00.000Z",
    sequence: {
      name: "registry",
      fps_num: 30,
      fps_den: 1,
      width: 1080,
      height: 1920,
      start_frame: 0,
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "V1_MAIN",
          segment_id: "SEG_MAIN",
          asset_id: "AST_MAIN",
          src_in_us: 0,
          src_out_us: 2_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 60,
          role: "hero",
          motivation: "fixture",
          beat_id: "",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "brief.yaml",
      blueprint_path: "blueprint.yaml",
      selects_path: "selects.yaml",
      compiler_version: "rfa-022-test",
      audio_policy: { mode: "ducking", source: "explicit_brief" },
    },
  };
}

function writeManifest(
  root: string,
  options: {
    libraryId: string;
    scope?: "repo_common" | "project_local";
    assetId?: string;
    status?: "confirmed" | "cleared" | "unknown" | "expired" | "ambiguous";
    pathValue?: string;
    contentHash?: string | null;
    sizeBytes?: number | null;
    durationUs?: number | null;
    provenanceStatus?: "verified" | "unknown" | "ambiguous";
    provenanceOrigin?: "deterministic_synthesis" | "unknown";
    reviewStatus?: "approved" | "pending";
    expiresAt?: string | null;
  },
): { manifestPath: string; assetPath: string; manifest: any } {
  const assetId = options.assetId ?? "sfx-impact";
  const assetPath = path.join(root, "audio", "impact.wav");
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  if (!fs.existsSync(assetPath)) fs.writeFileSync(assetPath, "metadata-only-sfx");
  const bytes = fs.readFileSync(assetPath);
  const manifest = {
    version: "sfx-library/v1",
    library_id: options.libraryId,
    library_version: "1.0.0",
    ...(options.scope ? { scope: options.scope } : {}),
    review_status: "approved",
    assets: [{
      asset_id: assetId,
      semantic_roles: ["hook_impact", "simple_sound"],
      path: options.pathValue ?? "audio/impact.wav",
      content_hash: options.contentHash === undefined ? hashBytes(bytes) : options.contentHash,
      size_bytes: options.sizeBytes === undefined ? bytes.length : options.sizeBytes,
      duration_us: options.durationUs === undefined ? 600_000 : options.durationUs,
      rights: {
        status: options.status ?? "confirmed",
        basis: "deterministic_synthesis",
        usage_scope: "project_render",
        evidence_ref: "evidence:rfa-022-test",
        verified_at: "2026-08-21T00:00:00Z",
        permitted_derivatives: ["project_render"],
        ...(options.expiresAt !== undefined ? { expires_at: options.expiresAt } : {}),
      },
      provenance: {
        origin: options.provenanceOrigin ?? "deterministic_synthesis",
        source_ref: "provenance:rfa-022-test",
        generated_at: "2026-08-21T00:00:00Z",
        status: options.provenanceStatus ?? "verified",
        evidence_ref: "evidence:rfa-022-provenance",
      },
      review_status: options.reviewStatus ?? "approved",
    }],
  };
  const manifestPath = path.join(root, "sfx-library.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifestPath, assetPath, manifest };
}

function writeCues(
  root: string,
  currentTimeline: TimelineIR,
  manifestPath: string,
  manifest: Record<string, any>,
): string {
  const cues: SfxCuesDoc = {
    version: "sfx-cues/v1",
    project_id: currentTimeline.project_id,
    base_timeline_version: currentTimeline.version,
    timeline_fps: { num: 30, den: 1 },
    required: true,
    library: {
      manifest_path: manifestPath,
      library_id: manifest.library_id as string,
      library_version: manifest.library_version as string,
      manifest_hash: hashBytes(fs.readFileSync(manifestPath)),
      ...(manifest.scope ? { scope: manifest.scope } : {}),
    },
    cues: [{
      cue_id: "SFX_HOOK_000000",
      semantic_role: "hook_impact",
      asset_id: manifest.assets[0].asset_id,
      trigger_frame: 4,
      duration_frames: 12,
      source_range: { in_us: 0, out_us: 600_000 },
      gain_db: -18,
      fade_in_ms: 5,
      fade_out_ms: 30,
      tail: { max_frames: 4, policy: "trim_or_pad_to_limit" },
      duck_group: "none",
      ducking: { duck_gain_db: -18, attack_ms: 10, release_ms: 120 },
      asset_pin: {
        library_id: manifest.library_id,
        library_version: manifest.library_version,
        library_manifest_hash: hashBytes(fs.readFileSync(manifestPath)),
        asset_content_hash: manifest.assets[0].content_hash,
        asset_size_bytes: manifest.assets[0].size_bytes,
        rights_evidence_ref: manifest.assets[0].rights.evidence_ref,
        provenance_ref: manifest.assets[0].provenance.source_ref,
      },
      intent: "semantic hook accent",
    }],
  } as SfxCuesDoc;
  const cuesPath = path.join(root, "sfx_cues.json");
  fs.writeFileSync(cuesPath, JSON.stringify(cues, null, 2) + "\n");
  return cuesPath;
}

describe("RFA-022 canonical SFX registry and promotion", () => {
  it("validates HOLD/cleared rights states and rejects invalid state values", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-022-schema-"));
    roots.push(root);
    const hold = writeManifest(root, {
      libraryId: "hold-library",
      status: "unknown",
      contentHash: null,
      sizeBytes: null,
      durationUs: null,
      provenanceStatus: "unknown",
    });
    expect(() => loadSfxLibraryManifest(hold.manifestPath)).not.toThrow();
    const invalid = JSON.parse(fs.readFileSync(hold.manifestPath, "utf8"));
    invalid.assets[0].rights.status = "maybe";
    expect(() => validateArtifact(invalid, "sfx-library.schema.json")).toThrow();
    delete invalid.assets[0].path;
    invalid.assets[0].source_uri = null;
    invalid.assets[0].rights.status = "unknown";
    expect(() => validateArtifact(invalid, "sfx-library.schema.json")).toThrow();
    const holdRegistry = loadSfxLibraryRegistry({ manifestPaths: [hold.manifestPath], repoSfxRoot: root });
    expect(() => resolveSfxAssetFromRegistry(holdRegistry, {
      asset_id: "sfx-impact",
    })).toThrow(/SFX_RIGHTS_HOLD/);
    const incomplete = writeManifest(root + "-incomplete", { libraryId: "incomplete-library" });
    const incompleteJson = JSON.parse(fs.readFileSync(incomplete.manifestPath, "utf8"));
    delete incompleteJson.assets[0].provenance.status;
    delete incompleteJson.assets[0].rights.verified_at;
    delete incompleteJson.assets[0].rights.permitted_derivatives;
    delete incompleteJson.assets[0].review_status;
    delete incompleteJson.review_status;
    fs.writeFileSync(incomplete.manifestPath, JSON.stringify(incompleteJson, null, 2) + "\n");
    const incompleteRegistry = loadSfxLibraryRegistry({
      manifestPaths: [incomplete.manifestPath],
      repoSfxRoot: root + "-incomplete",
    });
    expect(() => resolveSfxAssetFromRegistry(incompleteRegistry, { asset_id: "sfx-impact" }))
      .toThrow(/SFX_RIGHTS_HOLD/);
    const expired = writeManifest(root + "-expired", {
      libraryId: "expired-library",
      status: "confirmed",
      expiresAt: "2020-01-01T00:00:00Z",
    });
    const loaded = loadSfxLibraryManifest(expired.manifestPath);
    expect(loaded.manifest.assets[0].rights.expires_at).toBe("2020-01-01T00:00:00Z");
  });

  it("uses project-local precedence and fails duplicate same-priority IDs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-022-registry-"));
    roots.push(root);
    const common = path.join(root, "common");
    const local = path.join(root, "local");
    const duplicate = path.join(root, "duplicate");
    const commonFixture = writeManifest(common, { libraryId: "common-library", scope: "repo_common" });
    const localFixture = writeManifest(local, { libraryId: "local-library", scope: "project_local" });
    const registry = loadSfxLibraryRegistry({
      searchRoots: [
        { path: commonFixture.manifestPath, scope: "repo_common", priority: 10 },
        { path: localFixture.manifestPath, scope: "project_local", priority: 0 },
      ],
      projectDir: root,
      repoSfxRoot: root,
      verifyAssets: true,
    });
    expect(registry.assets.get("sfx-impact")?.manifest.manifest.library_id).toBe("local-library");
    expect(resolveSfxAssetFromRegistry(registry, {
      asset_id: "sfx-impact",
      scope: "project_local",
      content_hash: hashBytes("metadata-only-sfx"),
    }).precedence.priority).toBe(0);
    const duplicateA = writeManifest(duplicate + "-a", { libraryId: "duplicate-a" });
    const duplicateB = writeManifest(duplicate + "-b", { libraryId: "duplicate-b" });
    expect(() => loadSfxLibraryRegistry({
      searchRoots: [
        { path: duplicateA.manifestPath, scope: "repo_common", priority: 10 },
        { path: duplicateB.manifestPath, scope: "repo_common", priority: 10 },
      ],
      repoSfxRoot: root,
    })).toThrow(/SFX_LIBRARY_AMBIGUOUS/);
  });

  it("rejects traversal, symlink escape, and stale or mismatched hashes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-022-paths-"));
    roots.push(root);
    const traversal = writeManifest(path.join(root, "traversal"), {
      libraryId: "traversal-library",
      pathValue: "../outside.wav",
    });
    expect(() => loadSfxLibraryManifest(traversal.manifestPath)).toThrow();

    const stale = writeManifest(path.join(root, "stale"), { libraryId: "stale-library" });
    fs.appendFileSync(stale.assetPath, "-stale");
    expect(() => loadSfxLibraryRegistry({
      manifestPaths: [stale.manifestPath],
      repoSfxRoot: root,
      verifyAssets: true,
    })).toThrow(/SFX_LIBRARY_DRIFT/);

    const mismatch = writeManifest(path.join(root, "mismatch"), {
      libraryId: "mismatch-library",
      contentHash: hashBytes("different"),
    });
    expect(() => loadSfxLibraryRegistry({
      manifestPaths: [mismatch.manifestPath],
      repoSfxRoot: root,
    })).toThrow(/SFX_LIBRARY_DRIFT/);

    const outside = path.join(root, "outside.wav");
    fs.writeFileSync(outside, "outside");
    const escaped = writeManifest(path.join(root, "escaped"), { libraryId: "escaped-library" });
    fs.rmSync(escaped.assetPath);
    fs.symlinkSync(outside, escaped.assetPath);
    expect(() => loadSfxLibraryRegistry({
      manifestPaths: [escaped.manifestPath],
      repoSfxRoot: root,
    })).toThrow(/SFX_LIBRARY_UNSAFE_PATH/);

    const projectRoot = path.join(root, "project");
    fs.mkdirSync(projectRoot, { recursive: true });
    const external = writeManifest(path.join(root, "external-project"), {
      libraryId: "external-project-library",
      scope: "project_local",
    });
    const externalCues = writeCues(path.join(root, "external-project"), timeline(), external.manifestPath, external.manifest);
    expect(() => loadSfxLibraryRegistry({
      manifestPaths: [external.manifestPath],
      projectDir: projectRoot,
    })).toThrow(/SFX_LIBRARY_UNSAFE_PATH/);
    expect(() => resolveSfxCuePlan({
      projectDir: projectRoot,
      timeline: timeline(),
      cuesPath: externalCues,
    })).toThrow(/SFX_LIBRARY_UNSAFE_PATH/);

    const commonRoot = path.join(root, "common-sfx");
    const common = writeManifest(commonRoot, {
      libraryId: "common-sfx-library",
      scope: "repo_common",
    });
    const commonRegistry = loadSfxLibraryRegistry({
      manifestPaths: [common.manifestPath],
      repoSfxRoot: commonRoot,
    });
    expect(resolveSfxAssetFromRegistry(commonRegistry, {
      asset_id: "sfx-impact",
      scope: "repo_common",
    }).precedence.scope).toBe("repo_common");
    const commonCues = writeCues(commonRoot, timeline(), common.manifestPath, common.manifest);
    const commonPlan = resolveSfxCuePlan({
      projectDir: projectRoot,
      repoSfxRoot: commonRoot,
      timeline: timeline(),
      cuesPath: commonCues,
    });
    const commonTimelinePath = path.join(projectRoot, "timeline.json");
    fs.writeFileSync(commonTimelinePath, JSON.stringify(projectSfxToTimeline(timeline(), commonPlan)) + "\n");
    const commonRenderPlan = resolveAudioRenderPlan({
      projectDir: projectRoot,
      repoSfxRoot: commonRoot,
      timelinePath: commonTimelinePath,
      sfxCuesPath: commonCues,
    });
    expect(commonPlan.library.scope).toBe("repo_common");
    expect(commonRenderPlan.sfx?.library?.manifest_path).toBe(common.manifestPath);
  });

  it("returns HOLD for missing evidence, validates without media, and promotes only with explicit evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-022-promotion-"));
    roots.push(root);
    const noEvidence = promoteSfxAsset({
      assetId: "sfx-hold",
      scope: "project_local",
      sourcePath: path.join(root, "source.wav"),
      projectDir: root,
      validateOnly: true,
    });
    expect(noEvidence.status).toBe("HOLD");
    expect(noEvidence.wrote_files).toBe(false);

    const source = path.join(root, "source.wav");
    fs.writeFileSync(source, "metadata-only-source");
    const validated = promoteSfxAsset({
      assetId: "sfx-validated",
      scope: "project_local",
      sourcePath: source,
      projectDir: root,
      rightsStatus: "cleared",
      rightsEvidenceRef: "evidence:rfa-022-authorized",
      provenanceRef: "provenance:rfa-022-source",
      provenanceOrigin: "deterministic_synthesis",
      reviewStatus: "approved",
      verifiedAt: "2026-08-21T00:00:00Z",
      permittedDerivatives: ["project_render"],
      validateOnly: true,
    });
    expect(validated).toMatchObject({ status: "HOLD", wrote_files: false });
    expect(fs.existsSync(path.join(root, "07_package"))).toBe(false);

    const missingOrigin = promoteSfxAsset({
      assetId: "sfx-missing-origin",
      scope: "project_local",
      sourcePath: source,
      projectDir: root,
      rightsStatus: "cleared",
      rightsEvidenceRef: "evidence:rfa-022-authorized",
      provenanceRef: "provenance:rfa-022-source",
      verifiedAt: "2026-08-21T00:00:00Z",
      permittedDerivatives: ["project_render"],
      validateOnly: true,
    });
    expect(missingOrigin).toMatchObject({ status: "HOLD", reason: "provenance_origin_missing", wrote_files: false });

    const validAudio = path.join(root, "valid.mp3");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", validAudio], { stdio: "ignore" });
    const promoted = promoteSfxAsset({
      assetId: "sfx-promoted",
      scope: "project_local",
      sourcePath: validAudio,
      projectDir: root,
      rightsStatus: "cleared",
      rightsEvidenceRef: "evidence:rfa-022-authorized",
      provenanceRef: "provenance:rfa-022-source",
      provenanceOrigin: "deterministic_synthesis",
      reviewStatus: "approved",
      verifiedAt: "2026-08-21T00:00:00Z",
      permittedDerivatives: ["project_render"],
    });
    expect(promoted).toMatchObject({ status: "promoted", wrote_files: true, media_validation: { decode: "decoded" } });
    expect(promoted.asset_path && fs.existsSync(promoted.asset_path)).toBe(true);
    expect(promoted.asset_path && hashBytes(fs.readFileSync(promoted.asset_path))).toBe(promoted.source_hash);

    const corrupted = path.join(root, "corrupted-middle.mp3");
    const corruptedBytes = fs.readFileSync(validAudio);
    corruptedBytes.fill(0, Math.floor(corruptedBytes.length * 0.35), Math.floor(corruptedBytes.length * 0.65));
    fs.writeFileSync(corrupted, corruptedBytes);
    const corruptedResult = promoteSfxAsset({
      assetId: "sfx-corrupted",
      scope: "project_local",
      sourcePath: corrupted,
      projectDir: root,
      rightsStatus: "cleared",
      rightsEvidenceRef: "evidence:rfa-022-authorized",
      provenanceRef: "provenance:rfa-022-source",
      provenanceOrigin: "deterministic_synthesis",
      reviewStatus: "approved",
      verifiedAt: "2026-08-21T00:00:00Z",
      permittedDerivatives: ["project_render"],
    });
    expect(corruptedResult.status).toBe("HOLD");
    expect(corruptedResult.wrote_files).toBe(false);

    const samePathResult = promoteSfxAsset({
      assetId: "sfx-same-path",
      scope: "project_local",
      sourcePath: validAudio,
      projectDir: root,
      destinationDir: path.join(root, "same-path"),
      outputManifestPath: path.join(root, "same-path", "assets", "sfx-same-path.mp3"),
      rightsStatus: "cleared",
      rightsEvidenceRef: "evidence:rfa-022-authorized",
      provenanceRef: "provenance:rfa-022-source",
      provenanceOrigin: "deterministic_synthesis",
      reviewStatus: "approved",
      verifiedAt: "2026-08-21T00:00:00Z",
      permittedDerivatives: ["project_render"],
    });
    expect(samePathResult).toMatchObject({ status: "HOLD", wrote_files: false });
    expect(fs.existsSync(path.join(root, "same-path"))).toBe(false);

    const stale = writeManifest(path.join(root, "existing"), { libraryId: "existing-library" });
    fs.appendFileSync(stale.assetPath, "-stale");
    expect(() => promoteSfxAsset({
      assetId: "sfx-impact",
      scope: "project_local",
      manifestPath: stale.manifestPath,
      projectDir: root,
      validateOnly: true,
    })).toThrow(/SFX_LIBRARY_DRIFT/);
  });

  it("propagates clear metadata through A3 projection and render-plan QA while HOLD stays non-renderable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-022-chain-"));
    roots.push(root);
    const currentTimeline = timeline();
    const fixture = writeManifest(root, {
      libraryId: "chain-library",
      scope: "project_local",
      provenanceStatus: "verified",
      reviewStatus: "approved",
    });
    const cuesPath = writeCues(root, currentTimeline, fixture.manifestPath, fixture.manifest);
    const plan = resolveSfxCuePlan({
      projectDir: root,
      timeline: currentTimeline,
      cuesPath,
    });
    const projected = projectSfxToTimeline(currentTimeline, plan);
    expect(projected.tracks.audio.find((track) => track.track_id === "A3")?.clips[0].metadata).toMatchObject({
      sfx_asset: {
        library_scope: "project_local",
        rights_status: "confirmed",
        provenance_status: "verified",
        review_status: "approved",
      },
    });
    const timelinePath = path.join(root, "timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(projected, null, 2) + "\n");
    const renderPlan = resolveAudioRenderPlan({
      projectDir: root,
      timelinePath,
      sfxCuesPath: cuesPath,
    });
    expect(renderPlan.sfx?.cues[0].pins).toMatchObject({
      asset_content_hash: fixture.manifest.assets[0].content_hash,
      rights_status: "confirmed",
      provenance_status: "verified",
      review_status: "approved",
    });
    expect(renderPlan.scene_audio_policy?.timing).toMatchObject({
      picture_timing_immutable: true,
      dialogue_timing_immutable: true,
      caption_timing_immutable: true,
      audio_displacement_frames: 0,
    });
    expect(renderPlan.final_mastering.count).toBe(1);

    const actual = renderPlan.sfx!.cues[0];
    const report = {
      version: "audio-mix-report/v2",
      project_id: renderPlan.project_id,
      plan_hash: hashAudioRenderPlan(renderPlan),
      has_bgm: false,
      has_sfx: true,
      strategy: "shared_audio_render_plan_v1",
      mastering_count: 1,
      final_mastering: {
        applied: true,
        loudness_target_lufs: -16,
        lra_target: 7,
        true_peak_target_dbtp: -1.5,
        premaster_measurement: null,
        output_measurement: { input_tp: "-2" },
      },
      stems: [{ stem_id: "sfx", role: "sfx", source_track_id: "A3", content_hash: actual.pins.asset_content_hash, size_bytes: actual.pins.asset_size_bytes, finish_applied: false }],
      sfx_cues: [{
        cue_id: actual.cue_id,
        semantic_role: actual.semantic_role,
        asset_id: actual.asset_id,
        timeline_range: actual.timeline_range,
        source_range_us: actual.source_range_us,
        dialogue_overlap_frames: actual.dialogue_overlap_frames,
        applied: actual.applied,
        tail_processing: actual.tail_processing,
        pins: actual.pins,
        rendered_content_hash: actual.pins.asset_content_hash,
        a3_output_content_hash: actual.pins.asset_content_hash,
        peak_dbtp: null,
        headroom_db: null,
      }],
      sfx_sidechain_evidence: {
        detector: "dialogue_waveform_rms",
        dialogue_stem_content_hash: actual.pins.asset_content_hash,
        threshold: 0.03,
        per_cue: [{
          cue_id: actual.cue_id,
          duck_group: "none",
          ratio: 1,
          attack_ms: actual.applied.attack_ms,
          release_ms: actual.applied.release_ms,
          requested_duck_gain_db: actual.applied.duck_gain_db,
          dialogue_overlap_frames: 0,
          sidechain_applied: false,
          a3_output_content_hash: actual.pins.asset_content_hash,
        }],
      },
    } as unknown as AudioMixReport;
    expect(checkSfxMixPolicy(report, JSON.parse(fs.readFileSync(cuesPath, "utf8")))).toMatchObject({
      passed: true,
    });

    const heldManifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
    heldManifest.assets[0].rights.status = "unknown";
    fs.writeFileSync(fixture.manifestPath, JSON.stringify(heldManifest, null, 2) + "\n");
    const heldCues = JSON.parse(fs.readFileSync(cuesPath, "utf8"));
    heldCues.library.manifest_hash = hashBytes(fs.readFileSync(fixture.manifestPath));
    heldCues.cues[0].asset_pin.library_manifest_hash = heldCues.library.manifest_hash;
    fs.writeFileSync(cuesPath, JSON.stringify(heldCues, null, 2) + "\n");
    const heldPlan = resolveAudioRenderPlan({
      projectDir: root,
      timelinePath,
      sfxCuesPath: cuesPath,
    });
    expect(heldPlan.sfx).toBeUndefined();
    expect(heldPlan.sfx_hold?.reason).toMatch(/rights_status_unknown/);
    expect(heldPlan.scene_audio_policy?.sfx.outcome).toBe("human_hold");
    expect(checkSfxMixPolicy({ ...report, sfx_hold: { code: "SFX_SELECTION_HOLD", reason: "rights_status_unknown" } }, undefined).passed)
      .toBe(false);
    const heldOutputDir = path.join(root, "held-render-output");
    await expect(executeAudioRenderPlan({
      plan: { sfx_hold: { code: "SFX_SELECTION_HOLD", reason: "rights_status_unknown" } } as any,
      outputDir: heldOutputDir,
    })).rejects.toThrow(/HOLD/);
    expect(fs.existsSync(heldOutputDir)).toBe(false);
  });

  it("reprojects all formal SFX cues while retaining authored ambient clips", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-022-reprojection-"));
    roots.push(root);
    const currentTimeline = timeline();
    const fixture = writeManifest(root, { libraryId: "reprojection-library", scope: "project_local" });
    const cuesPath = writeCues(root, currentTimeline, fixture.manifestPath, fixture.manifest);
    const plan = resolveSfxCuePlan({ projectDir: root, timeline: currentTimeline, cuesPath });
    const base = {
      segment_id: "SEG_AUDIO",
      asset_id: "AST_AUDIO",
      src_in_us: 0,
      src_out_us: 300_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 9,
      motivation: "fixture",
      beat_id: "",
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
    };
    const withExisting = {
      ...currentTimeline,
      tracks: {
        ...currentTimeline.tracks,
        audio: [{
          track_id: "A3",
          kind: "audio" as const,
          clips: [
            { ...base, clip_id: "A3_OLD", role: "sfx", metadata: { sfx_cue: { cue_id: "SFX_OLD" } } },
            { ...base, clip_id: "A3_EMPTY_MARKER", role: "sfx", metadata: { sfx_cue: {} } },
            { ...base, clip_id: "A3_AMBIENT", role: "ambient", audio_role: "ambient" as const },
          ],
        }],
      },
    };
    const projected = projectSfxToTimeline(withExisting, plan);
    const clips = projected.tracks.audio.find((track) => track.track_id === "A3")?.clips ?? [];
    expect(clips.some((clip) => clip.metadata?.sfx_cue && (clip.metadata.sfx_cue as { cue_id: string }).cue_id === "SFX_OLD")).toBe(false);
    expect(clips.some((clip) => clip.clip_id === "A3_EMPTY_MARKER")).toBe(false);
    expect(clips.some((clip) => clip.clip_id === "A3_AMBIENT")).toBe(true);
    expect(clips.some((clip) => clip.clip_id === "A3_SFX_HOOK_000000")).toBe(true);
  });

  it("rejects held SFX evidence in both audio-mix-report schema versions", () => {
    const hold = { code: "SFX_SELECTION_HOLD", reason: "rights evidence is incomplete" };
    const validV1 = {
      version: "audio-mix-report/v1",
      has_bgm: false,
      strategy: "dialogue_only_mastering_v1",
      final_mastering: {},
      sfx_hold: hold,
    };
    expect(() => validateArtifact({ ...validV1, has_sfx: true }, "audio-mix-report.schema.json")).toThrow();
    expect(() => validateArtifact({ ...validV1, sfx_cues: [] }, "audio-mix-report.schema.json")).toThrow();
    expect(() => validateArtifact(validV1, "audio-mix-report.schema.json")).not.toThrow();

    const validV2 = {
      version: "audio-mix-report/v2",
      project_id: "held-sfx",
      plan_hash: hashBytes("plan"),
      has_bgm: false,
      strategy: "shared_audio_render_plan_v1",
      input_hashes: { timeline: hashBytes("timeline"), dialogue_sources: [], cue_sources: [] },
      output: { content_hash: hashBytes("output"), size_bytes: 1, sample_rate_hz: 48000, channels: 1 },
      stems: [{ stem_id: "A1", role: "dialogue", source_track_id: "A1", content_hash: hashBytes("a1"), size_bytes: 1, finish_applied: false }],
      cues: [],
      dialogue_finish_scope: "none",
      mastering_count: 0,
      execution_strategy: {
        id: "shared_audio_render_plan_executor_v1",
        stages: ["extract_a1_stem", "single_final_mastering"],
        deterministic_input_order: [],
      },
      final_mastering: {
        applied: false,
        loudness_target_lufs: -16,
        lra_target: 7,
        true_peak_target_dbtp: -1.5,
        premaster_measurement: null,
        output_measurement: null,
      },
      warnings: [],
      sfx_hold: hold,
    };
    expect(() => validateArtifact({ ...validV2, has_sfx: true }, "audio-mix-report.schema.json")).toThrow();
    expect(() => validateArtifact({ ...validV2, sfx_cues: [] }, "audio-mix-report.schema.json")).toThrow();
    expect(() => validateArtifact(validV2, "audio-mix-report.schema.json")).not.toThrow();
  });

  it("keeps promotion result status, writes, media, and evidence consistent", () => {
    const promoted = {
      version: "sfx-promotion-result/v1",
      command: "sfx-promote",
      status: "promoted",
      scope: "project_local",
      asset_id: "sfx-promoted",
      wrote_files: true,
      reason: "promoted",
      source_hash: hashBytes("source"),
      source_size_bytes: 6,
      manifest_path: "/project/sfx-library.json",
      manifest_hash: hashBytes("manifest"),
      asset_path: "/project/assets/sfx.mp3",
      rights_status: "cleared",
      rights_evidence_ref: "evidence:authorized",
      provenance_ref: "provenance:source",
      media_validation: { performed: true, available: true, decode: "decoded" },
    };
    expect(() => validateArtifact(promoted, "sfx-promotion-result.schema.json")).not.toThrow();
    expect(() => validateArtifact({ ...promoted, wrote_files: false }, "sfx-promotion-result.schema.json")).toThrow();
    expect(() => validateArtifact({ ...promoted, provenance_ref: null }, "sfx-promotion-result.schema.json")).toThrow();
    expect(() => validateArtifact({ ...promoted, status: "HOLD", wrote_files: true }, "sfx-promotion-result.schema.json")).toThrow();
  });
});
