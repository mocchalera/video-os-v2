import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertImageSequenceGrounding } from "../runtime/artifacts/image-sequence-grounding.js";
import { runPipeline } from "../runtime/pipeline/ingest.js";
import { loadSourceMap } from "../runtime/media/source-map.js";
import { assembleTimelineToMp4 } from "../runtime/render/assembler.js";
import { renderPreviewSegment } from "../runtime/preview/segment-renderer.js";
import {
  assessRenderArtifactFreshness,
  createSourceInputAttestation,
  writeRenderFreshnessMetadata,
} from "../runtime/render/source-input-attestation.js";
import {
  materializeVerifiedStillSnapshots,
  resolveCanonicalRenderInputs,
} from "../runtime/render/canonical-render-input.js";
import { stageSourceMapForRemotion } from "../runtime/render/remotion/render-remotion.js";
import { ensureFreshAssembly } from "../scripts/package.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vos-sequence-d2-${label}-`));
  dirs.push(dir);
  return dir;
}

function frameCount(filePath: string): number {
  const output = execFileSync("ffprobe", [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", filePath,
  ], { encoding: "utf8" }).trim();
  return Number(output);
}

function timeline(assetId: string) {
  return {
    version: "1",
    project_id: "sequence-d2",
    created_at: "2026-07-21T00:00:00.000Z",
    sequence: {
      name: "sequence-d2",
      fps_num: 24,
      fps_den: 1,
      width: 96,
      height: 54,
      start_frame: 0,
      letterbox_policy: "none",
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "CLP_SEQUENCE",
          segment_id: "SEG_SEQUENCE",
          asset_id: assetId,
          media_kind: "sequence",
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 24,
          role: "hero",
          motivation: "grounded image sequence",
          beat_id: "B01",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
          captions: [{ in_frame: 2, out_frame: 12, text: "sequence", style: "simple-shadow" }],
        }],
      }],
      audio: [],
    },
    markers: [],
    provenance: { brief_path: "", blueprint_path: "", selects_path: "", compiler_version: "test" },
  };
}

describe("EYE-070D2 grounded image-sequence render and freshness", () => {
  it("renders the verified proxy through FFmpeg, preview, Remotion staging, package reuse, and two-layer freshness", async () => {
    const sourceDir = tempDir("source");
    const projectDir = tempDir("project");
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=96x54:r=24:d=1",
      "-frames:v", "24", path.join(sourceDir, "shot_%04d.png"),
    ]);
    const result = await runPipeline({
      sourceFiles: [sourceDir],
      projectDir,
      repoRoot: REPO_ROOT,
      skipStt: true,
      skipVlm: true,
      skipPeak: true,
      skipMarlin: true,
      skipAppraiser: true,
      skipBgmAnalysis: true,
    });
    const asset = result.assetsJson.items[0];
    expect(asset.media_kind).toBe("sequence");
    assertImageSequenceGrounding(projectDir);

    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    const timelineDoc = timeline(asset.asset_id);
    fs.writeFileSync(timelinePath, JSON.stringify(timelineDoc));

    const canonical = resolveCanonicalRenderInputs(timelineDoc as never, { projectDir, timelinePath });
    expect(canonical.byAssetId.get(asset.asset_id)).toMatchObject({
      relationship: "normalized_image_sequence_proxy",
      originalFrameSetContentSha256: asset.image_sequence?.frame_set_content_sha256,
      frameCount: 24,
      renderInputContentSha256: asset.image_sequence?.analysis_proxy_content_sha256,
    });
    const attestation = createSourceInputAttestation(projectDir);
    expect(attestation).toMatchObject({ status: "verified", source_input_count: 1 });
    expect(attestation.source_inputs[0]).toMatchObject({
      media_kind: "sequence",
      content_sha256: asset.image_sequence?.frame_set_content_sha256,
      render_input_identity: {
        relationship: "normalized_image_sequence_proxy",
        content_sha256: asset.image_sequence?.analysis_proxy_content_sha256,
        frame_count: 24,
      },
    });

    const assemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");
    await assembleTimelineToMp4({ projectDir, timelinePath, outputPath: assemblyPath, includeAudio: false });
    expect(frameCount(assemblyPath)).toBe(24);
    writeRenderFreshnessMetadata(projectDir, assemblyPath);
    expect(assessRenderArtifactFreshness(projectDir, assemblyPath).status).toBe("fresh");
    expect((await ensureFreshAssembly(projectDir)).action).toBe("reused");

    const preview = await renderPreviewSegment({
      projectDir,
      timelinePath,
      sourceMap: loadSourceMap(projectDir),
      outputPath: path.join(projectDir, "05_timeline", "preview.mp4"),
    });
    expect(frameCount(preview.outputPath)).toBe(24);

    const snapshots = materializeVerifiedStillSnapshots(canonical);
    let stagedSource = "";
    const staged = stageSourceMapForRemotion(
      { [asset.asset_id]: loadSourceMap(projectDir).entryMap.get(asset.asset_id)!.source_locator },
      timelinePath,
      timelineDoc as never,
      snapshots,
      (phase, source) => { if (phase === "before") stagedSource = source; },
    );
    try {
      expect(stagedSource).toBe(snapshots.byAssetId.get(asset.asset_id)?.renderInputPath);
      expect(stagedSource).not.toBe(canonical.byAssetId.get(asset.asset_id)?.renderInputPath);
      expect(fs.existsSync(stagedSource)).toBe(true);
    } finally {
      fs.rmSync(staged.publicDir, { recursive: true, force: true });
      snapshots.dispose();
    }
    expect(fs.existsSync(stagedSource)).toBe(false);

    const originalFrame = path.join(sourceDir, "shot_0012.png");
    const originalBytes = fs.readFileSync(originalFrame);
    fs.writeFileSync(originalFrame, "changed-original-frame");
    expect(assessRenderArtifactFreshness(projectDir, assemblyPath)).toMatchObject({
      status: "stale",
      reason: "image_sequence_frame_hash_mismatch",
    });
    fs.writeFileSync(originalFrame, originalBytes);
    expect(assessRenderArtifactFreshness(projectDir, assemblyPath).status).toBe("fresh");

    const proxyPath = path.join(projectDir, "03_analysis", asset.image_sequence!.analysis_proxy_path);
    const proxyBytes = fs.readFileSync(proxyPath);
    fs.writeFileSync(proxyPath, "changed-analysis-proxy");
    expect(assessRenderArtifactFreshness(projectDir, assemblyPath)).toMatchObject({
      status: "stale",
      reason: "image_sequence_proxy_hash_mismatch",
    });
    fs.writeFileSync(proxyPath, proxyBytes);
    expect(assessRenderArtifactFreshness(projectDir, assemblyPath).status).toBe("fresh");
  }, 60_000);
});
