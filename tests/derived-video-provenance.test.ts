import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  buildDerivedVideoProvenance,
  verifyDerivedVideoProvenance,
} from "../runtime/packaging/derived-video-provenance.js";
import { buildNleFinishingManifest } from "../runtime/packaging/manifest.js";
import { createSourceInputAttestation } from "../runtime/render/source-input-attestation.js";
import { sha256FileHex } from "../runtime/source-content-identity.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sha(filePath: string): string {
  return `sha256:${sha256FileHex(filePath)}`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeProject(options: { renderedSource?: boolean; withAttestation?: boolean } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "derived-video-provenance-"));
  tempDirs.push(projectDir);
  const sourcePath = options.renderedSource
    ? path.join(projectDir, "07_package/video/base.mp4")
    : path.join(projectDir, "02_media/source.mp4");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "clean-source-bytes");
  const sourceHash = sha256FileHex(sourcePath);
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  writeJson(timelinePath, {
    version: "1",
    project_id: "short-project",
    sequence: { fps_num: 30, fps_den: 1, width: 1080, height: 1920 },
    tracks: {
      video: [{ track_id: "V1", clips: [{ clip_id: "V1", asset_id: "AST_A" }] }],
      audio: [{ track_id: "A1", clips: [{ clip_id: "A1", asset_id: "AST_A" }] }],
    },
  });
  writeJson(path.join(projectDir, "03_analysis/assets.json"), {
    items: [{
      asset_id: "AST_A",
      duration_us: 44_000_000,
      video_stream: { width: 1920, height: 1080 },
      audio_stream: { channels: 2, sample_rate: 48_000, codec: "aac" },
    }],
  });
  const sourceMapEntry: Record<string, unknown> = {
    asset_id: "AST_A",
    source_locator: sourcePath,
    local_source_path: sourcePath,
    link_path: path.relative(projectDir, sourcePath),
    media_kind: "video",
    source_content_sha256: sourceHash,
    source_origin: options.renderedSource ? "rendered_output" : "original_source",
  };
  if (options.withAttestation) {
    const evidencePath = path.join(projectDir, "06_review/clean-base-review.json");
    writeJson(evidencePath, {
      review: "full-duration visual review",
      subject: `sha256:${sourceHash}`,
      captions_burned_in: false,
    });
    const attestationPath = path.join(
      projectDir,
      "03_analysis/clean-base-attestations/AST_A.json",
    );
    writeJson(attestationPath, {
      version: "clean-base-attestation/v1",
      subject: { content_sha256: `sha256:${sourceHash}` },
      claim: "caption_free_clean_base",
      verification: {
        method: "human_full_duration_visual_review",
        coverage: "full_duration",
        producer_id: "render-pipeline",
        verifier_id: "reviewer-1",
        verifier_type: "human",
        verified_at: "2026-07-25T00:00:00.000Z",
        evidence: {
          path: path.relative(projectDir, evidencePath),
          sha256: sha(evidencePath),
        },
      },
    });
    sourceMapEntry.clean_base_attestation = {
      path: path.relative(projectDir, attestationPath),
      sha256: sha(attestationPath),
    };
  }
  writeJson(path.join(projectDir, "02_media/source_map.json"), {
    version: "1",
    project_id: "short-project",
    media_dir: "02_media",
    generated_at: "2026-07-25T00:00:00.000Z",
    items: [sourceMapEntry],
  });
  const captionPath = path.join(projectDir, "07_package/caption_approval.json");
  const routePath = path.join(projectDir, "07_package/logs/render-route.json");
  const finalPath = path.join(projectDir, "07_package/video/final.mp4");
  writeJson(captionPath, { approved: true });
  writeJson(routePath, { receipt_version: "render-route-receipt/v3" });
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, "final-video-bytes");
  return { projectDir, sourcePath, timelinePath, captionPath, routePath, finalPath };
}

describe("derived-video-provenance/v1", () => {
  it("deterministically binds clean source technical truth through final output", () => {
    const fixture = makeProject();
    const options = {
      projectDir: fixture.projectDir,
      projectId: "short-project",
      producer: "engine_render" as const,
      timelinePath: fixture.timelinePath,
      finalVideoPath: fixture.finalPath,
      captionMode: "burn_in" as const,
      captionApprovalPath: fixture.captionPath,
      renderRouteReceiptPath: fixture.routePath,
      createdAt: "2026-07-25T00:00:00.000Z",
    };
    const first = buildDerivedVideoProvenance(options);
    const second = buildDerivedVideoProvenance(options);
    expect(second).toEqual(first);
    expect(first.source_inputs).toMatchObject({
      attestation_status: "verified",
      items: [{
        asset_id: "AST_A",
        source_origin: "original_source",
        caption_cleanliness: "original_source",
        technical: {
          metadata_status: "complete",
          duration_us: 44_000_000,
          dimensions: { width: 1920, height: 1080 },
          audio_layout: {
            kind: "channels",
            channels: 2,
            sample_rate: 48_000,
            codec: "aac",
          },
        },
      }],
    });
    expect(first.transformation_chain.chain_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.final_output.sha256).toBe(sha(fixture.finalPath));
    expect(validateAgainstSchema(first, "derived-video-provenance.schema.json"))
      .toEqual({ valid: true, errors: [] });

    const provenancePath = path.join(fixture.projectDir, "07_package/derived-video-provenance.json");
    writeJson(provenancePath, first);
    expect(verifyDerivedVideoProvenance({
      projectDir: fixture.projectDir,
      provenancePath,
      expectedFinalVideoPath: fixture.finalPath,
    })).toEqual({ valid: true, errors: [] });

    fs.writeFileSync(fixture.finalPath, "tampered-final-video");
    expect(verifyDerivedVideoProvenance({
      projectDir: fixture.projectDir,
      provenancePath,
      expectedFinalVideoPath: fixture.finalPath,
    })).toMatchObject({ valid: false });
  });

  it("blocks a known rendered source until an independent clean-base review is hash-bound", () => {
    const blocked = makeProject({ renderedSource: true });
    expect(() => createSourceInputAttestation(blocked.projectDir))
      .toThrow("rendered_source_requires_clean_base_attestation");

    const allowed = makeProject({ renderedSource: true, withAttestation: true });
    expect(createSourceInputAttestation(allowed.projectDir).status).toBe("verified");
    const provenance = buildDerivedVideoProvenance({
      projectDir: allowed.projectDir,
      projectId: "short-project",
      producer: "engine_render",
      timelinePath: allowed.timelinePath,
      finalVideoPath: allowed.finalPath,
      captionMode: "burn_in",
      captionApprovalPath: allowed.captionPath,
      renderRouteReceiptPath: allowed.routePath,
      createdAt: "2026-07-25T00:00:00.000Z",
    });
    expect(provenance.source_inputs.items[0]).toMatchObject({
      source_origin: "verified_caption_free_proxy",
      caption_cleanliness: "independently_attested_caption_free",
      generated_output_detected: true,
    });

    const sourceMapPath = path.join(allowed.projectDir, "02_media/source_map.json");
    const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf8"));
    sourceMap.items[0].clean_base_attestation.sha256 = `sha256:${"0".repeat(64)}`;
    writeJson(sourceMapPath, sourceMap);
    expect(() => createSourceInputAttestation(allowed.projectDir))
      .toThrow("clean_base_attestation_hash_mismatch");
  });

  it("upgrades new package manifests with the hash-bound provenance artifact", () => {
    const fixture = makeProject();
    const provenancePath = path.join(fixture.projectDir, "07_package/derived-video-provenance.json");
    writeJson(provenancePath, buildDerivedVideoProvenance({
      projectDir: fixture.projectDir,
      projectId: "short-project",
      producer: "nle_finishing",
      timelinePath: fixture.timelinePath,
      finalVideoPath: fixture.finalPath,
      captionMode: "none",
      handoffId: "HND_1",
      createdAt: "2026-07-25T00:00:00.000Z",
    }));
    const qaPath = path.join(fixture.projectDir, "07_package/qa-report.json");
    writeJson(qaPath, { passed: true });
    const manifest = buildNleFinishingManifest({
      projectId: "short-project",
      baseTimelineVersion: "1",
      editorialTimelineHash: crypto.createHash("sha256").update("timeline").digest("hex"),
      outputDir: path.join(fixture.projectDir, "07_package"),
      handoffId: "HND_1",
      captionPolicy: { source: "none", delivery_mode: "sidecar" },
      finalVideoPath: fixture.finalPath,
      qaReportPath: qaPath,
      derivedVideoProvenancePath: provenancePath,
      createdAt: "2026-07-25T00:00:00.000Z",
    });
    expect(manifest).toMatchObject({
      version: "1.1.0",
      artifacts: {
        derived_video_provenance: {
          sha256: sha(provenancePath),
        },
      },
    });
    expect(validateAgainstSchema(manifest, "package-manifest.schema.json"))
      .toEqual({ valid: true, errors: [] });
  });
});
