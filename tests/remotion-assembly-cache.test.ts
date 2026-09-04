import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
vi.mock("@remotion/bundler", () => ({
  bundle: vi.fn(async () => {
    throw new Error("remotion-cache-miss-render-path");
  }),
}));
import {
  createRemotionAssemblyFingerprint,
  readValidRemotionAssemblyCache,
  readValidRemotionLayerCache,
  renderRemotionAssembly,
  stageSourceMapForRemotion,
} from "../runtime/render/remotion/render-remotion.js";

function sealLayerReceipt<T extends Record<string, unknown>>(receipt: T): T & { receipt_payload_sha256: string } {
  return {
    ...receipt,
    receipt_payload_sha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex"),
  };
}
import { materializeVerifiedStillSnapshots } from "../runtime/render/canonical-render-input.js";
import {
  REMOTION_OVERLAY_CAPABILITY_VERSION,
  remotionCapabilityIdentityHash,
} from "../runtime/render/remotion/overlay-capability.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

const CAPABILITY_SHA = remotionCapabilityIdentityHash();

function timeline(): TimelineIR {
  return {
    version: "1",
    project_id: "cache-test",
    created_at: "2026-07-18T00:00:00Z",
    sequence: { fps_num: 30, fps_den: 1, width: 1080, height: 1920, pixel_aspect: "1:1", audio_sample_rate_hz: 48000, channel_layout: "stereo", start_timecode: "00:00:00:00", drop_frame: false, letterbox_policy: "none" },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [{ clip_id: "C1", asset_id: "A1", segment_id: "S1", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 30, role: "dialogue", captions: [{ text: "old", in_frame: 0, out_frame: 30, style: "simple-shadow" }] }] }],
      audio: [{ track_id: "A1", kind: "audio", clips: [{ clip_id: "A1C1", asset_id: "A1", segment_id: "S1", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 30, role: "dialogue" }] }],
    },
    transitions: [],
    markers: [],
  } as unknown as TimelineIR;
}

describe("Remotion base assembly fingerprint", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores speech-caption-only changes but invalidates on picture changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-cache-"));
    dirs.push(dir);
    const source = path.join(dir, "source.mp4");
    const timelinePath = path.join(dir, "timeline.json");
    fs.writeFileSync(source, "source");
    const first = timeline();
    const fingerprint = createRemotionAssemblyFingerprint(first, { A1: source }, timelinePath);
    first.tracks.video[0].clips[0].captions = [{ text: "new", in_frame: 0, out_frame: 30, style: "simple-shadow" }];
    expect(createRemotionAssemblyFingerprint(first, { A1: source }, timelinePath)).toBe(fingerprint);
    first.tracks.video[0].clips[0].timeline_duration_frames = 29;
    expect(createRemotionAssemblyFingerprint(first, { A1: source }, timelinePath)).not.toBe(fingerprint);
  });

  it("excludes separate Remotion overlays from the base cache but binds base-frame treatments", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-base-split-"));
    dirs.push(dir);
    const source = path.join(dir, "source.mp4");
    const timelinePath = path.join(dir, "timeline.json");
    fs.writeFileSync(source, "source");
    const first = timeline();
    const fingerprint = createRemotionAssemblyFingerprint(first, { A1: source }, timelinePath);
    const overlayClip = (requiresBaseFrame: boolean) => ({
      clip_id: "TITLE",
      asset_id: "A1",
      segment_id: "S1",
      src_in_us: 0,
      src_out_us: 1_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 30,
      role: "title",
      metadata: {
        content_element: {
          version: "content-element/v1",
          element_id: "TITLE",
          kind: "template",
          template_ref: "vos:content.title-card/v1",
          template_version: "1.0.0",
          props: { title: "Title" },
          layout: {
            anchor: "center",
            x: 0,
            y: 0,
            scale: 1,
            rotation_deg: 0,
            opacity: 1,
            safe_area: true,
            z_index: 100,
          },
          renderer_hint: "remotion",
          creative_recipe: {
            version: "creative-recipe/v1",
            reuse_scope: "brand",
            authoring_surface: "typed_component",
            layer_mode: "alpha_overlay",
            composite_stage: "under_caption",
            requires_base_frame: requiresBaseFrame,
          },
        },
      },
    });
    (first.tracks as TimelineIR["tracks"] & {
      overlay: TimelineIR["tracks"]["video"];
    }).overlay = [{
      track_id: "O1",
      kind: "overlay",
      clips: [overlayClip(false)],
    }] as unknown as TimelineIR["tracks"]["video"];
    expect(createRemotionAssemblyFingerprint(first, { A1: source }, timelinePath))
      .toBe(fingerprint);

    (first.tracks as TimelineIR["tracks"] & {
      overlay: TimelineIR["tracks"]["video"];
    }).overlay[0].clips = [overlayClip(true)] as unknown as TimelineIR["tracks"]["video"][number]["clips"];
    expect(createRemotionAssemblyFingerprint(first, { A1: source }, timelinePath))
      .not.toBe(fingerprint);
  });

  it("requires a v2 receipt with the exact full output hash and size", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-receipt-"));
    dirs.push(dir);
    const output = path.join(dir, "assembly.mp4");
    const receiptPath = `${output}.remotion-cache.json`;
    const fingerprint = "f".repeat(64);
    const result = {
      assemblyPath: output, durationInFrames: 10, fps: 24, width: 64, height: 64,
      assemblyCacheHit: false,
      font: { mode: "bundled", format: "woff2", sha256: "a", sourceSha256: "b", sizeBytes: 1, characterCount: 1, cacheHit: false },
    } as const;
    const writeReceipt = (
      version: string,
      contentSha256: string,
      sizeBytes: number,
      capability: { capability_version?: string; capability_sha256?: string } = {
        capability_version: "remotion-overlay-capability/v1",
        capability_sha256: CAPABILITY_SHA,
      },
      resolvedLayout: unknown[] = [],
    ) => {
      fs.writeFileSync(receiptPath, JSON.stringify({
        version, fingerprint, ...capability, resolved_layout: resolvedLayout,
        output: { contentSha256, sizeBytes }, result,
      }));
    };
    const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

    fs.writeFileSync(output, "ORIGINAL");
    writeReceipt("remotion-assembly-cache/v2", hash("ORIGINAL"), 8);
    expect(readValidRemotionAssemblyCache(output, receiptPath, fingerprint)).toMatchObject(result);
    writeReceipt("remotion-assembly-cache/v2", hash("ORIGINAL"), 8, undefined, [
      { element_id: "TITLE", clip_id: "TITLE", layout: { anchor: "center" } },
    ]);
    expect(readValidRemotionAssemblyCache(output, receiptPath, fingerprint)).toMatchObject(result);

    // Receipts predating the Issue #15 capability identity must not be
    // accepted as cache hits.
    fs.writeFileSync(receiptPath, JSON.stringify({
      version: "remotion-assembly-cache/v2", fingerprint,
      output: { contentSha256: hash("ORIGINAL"), sizeBytes: 8 }, result,
    }));
    expect(readValidRemotionAssemblyCache(output, receiptPath, fingerprint)).toBeUndefined();
    fs.writeFileSync(receiptPath, JSON.stringify({
      version: "remotion-assembly-cache/v2", fingerprint,
      capability_version: REMOTION_OVERLAY_CAPABILITY_VERSION,
      capability_sha256: CAPABILITY_SHA,
      output: { contentSha256: hash("ORIGINAL"), sizeBytes: 8 }, result,
    }));
    expect(readValidRemotionAssemblyCache(output, receiptPath, fingerprint)).toBeUndefined();
    writeReceipt("remotion-assembly-cache/v2", hash("ORIGINAL"), 8, {
      capability_version: REMOTION_OVERLAY_CAPABILITY_VERSION,
      capability_sha256: "0".repeat(64),
    });
    expect(readValidRemotionAssemblyCache(output, receiptPath, fingerprint)).toBeUndefined();

    fs.writeFileSync(output, "FORGED!!");
    expect(readValidRemotionAssemblyCache(output, receiptPath, fingerprint)).toBeUndefined();
    writeReceipt("remotion-assembly-cache/v2", "0".repeat(64), 8);
    expect(readValidRemotionAssemblyCache(output, receiptPath, fingerprint)).toBeUndefined();
    fs.writeFileSync(output, "x");
    expect(readValidRemotionAssemblyCache(output, receiptPath, fingerprint)).toBeUndefined();
    fs.writeFileSync(output, Buffer.alloc(0));
    expect(readValidRemotionAssemblyCache(output, receiptPath, fingerprint)).toBeUndefined();
    fs.writeFileSync(output, "ORIGINAL");
    writeReceipt("remotion-assembly-cache/v1", hash("ORIGINAL"), 8);
    expect(readValidRemotionAssemblyCache(output, receiptPath, fingerprint)).toBeUndefined();
  });

  it("rejects a capability-complete legacy receipt without resolved layout at the actual entrypoint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-entrypoint-cache-"));
    dirs.push(dir);
    const timelinePath = path.join(dir, "05_timeline", "timeline.json");
    const output = path.join(dir, "assembly.mp4");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    const actualTimeline = timeline();
    actualTimeline.tracks.video[0].clips = [];
    actualTimeline.tracks.audio[0].clips = [];
    fs.writeFileSync(timelinePath, JSON.stringify(actualTimeline));
    const fingerprint = createRemotionAssemblyFingerprint(actualTimeline, {}, timelinePath);
    const result = {
      assemblyPath: output, durationInFrames: 0, fps: 24, fpsNum: 24, fpsDen: 1, width: 64, height: 64,
      assemblyCacheHit: false,
      font: { mode: "bundled", format: "woff2", sha256: "a", sourceSha256: "b", sizeBytes: 1, characterCount: 1, cacheHit: false },
    } as const;
    fs.writeFileSync(output, "ORIGINAL");
    fs.writeFileSync(`${output}.remotion-cache.json`, JSON.stringify({
      version: "remotion-assembly-cache/v2",
      fingerprint,
      capability_version: REMOTION_OVERLAY_CAPABILITY_VERSION,
      capability_sha256: CAPABILITY_SHA,
      output: {
        contentSha256: createHash("sha256").update("ORIGINAL").digest("hex"),
        sizeBytes: 8,
      },
      result,
    }));

    await expect(renderRemotionAssembly({
      timelinePath,
      sourceMap: {},
      outputPath: output,
    })).rejects.toThrow("remotion-cache-miss-render-path");
  });

  it("rejects Remotion alpha-layer reuse when the live media contract drifts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-layer-reuse-"));
    dirs.push(dir);
    const overlayPath = path.join(dir, "overlay.webm");
    const receiptPath = path.join(dir, "receipt.json");
    const fingerprint = "f".repeat(64);
    const media = {
      version: "alpha-layer-media/v1" as const,
      codec_name: "vp9",
      pixel_format: "yuva420p",
      alpha_mode: "1",
      has_alpha: true,
      width: 640,
      height: 360,
      fps_num: 30,
      fps_den: 1,
      duration_frames: 30,
      time_base: "1/1000",
      audio_stream_count: 0,
    };
    fs.writeFileSync(overlayPath, "overlay");
    const result = {
      overlayPath,
      receiptPath,
      durationInFrames: 30,
      fps: 30,
      fpsNum: 30,
      fpsDen: 1,
      width: 640,
      height: 360,
      elementCount: 1,
      layerCacheHit: false,
      font: {
        mode: "bundled",
        format: "woff2",
        sha256: "a",
        sourceSha256: "b",
        sizeBytes: 1,
        characterCount: 1,
        cacheHit: false,
      },
    } as const;
    fs.writeFileSync(receiptPath, JSON.stringify(sealLayerReceipt({
      version: "remotion-layer-receipt/v3",
      state: "complete",
      complete: true,
      renderer: "remotion",
      renderer_version: "4.0.452",
      fingerprint,
      overlay_sha256: createHash("sha256").update("overlay").digest("hex"),
      media,
      result,
    })));
    const input = {
      overlayPath,
      receiptPath,
      fingerprint,
      expected: {
        width: 640,
        height: 360,
        fpsNum: 30,
        fpsDen: 1,
        durationFrames: 30,
      },
    };
    await expect(readValidRemotionLayerCache({
      ...input,
      probeAlphaLayerImpl: async () => media,
    })).resolves.toMatchObject(result);
    await expect(readValidRemotionLayerCache({
      ...input,
      probeAlphaLayerImpl: async () => ({ ...media, has_alpha: false }),
    })).resolves.toBeUndefined();
  });

  it("fails closed for partial, stale, tampered, wrong-generation, missing, zero-byte, and escaped layer cache", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-layer-fail-closed-"));
    dirs.push(dir);
    const cacheRoot = path.join(dir, "cache");
    fs.mkdirSync(cacheRoot);
    const overlayPath = path.join(cacheRoot, "element.webm");
    const receiptPath = path.join(cacheRoot, "element.json");
    const fingerprint = "f".repeat(64);
    const generationId = `sha256:${"1".repeat(64)}`;
    const bundleIdentity = "b".repeat(64);
    const capabilitySha256 = "c".repeat(64);
    const media = {
      version: "alpha-layer-media/v1" as const,
      codec_name: "vp9",
      pixel_format: "yuva420p",
      alpha_mode: "1",
      has_alpha: true,
      width: 640,
      height: 360,
      fps_num: 30,
      fps_den: 1,
      duration_frames: 30,
      time_base: "1/1000",
      audio_stream_count: 0,
    };
    const result = {
      overlayPath, receiptPath, durationInFrames: 30, fps: 30, fpsNum: 30, fpsDen: 1,
      width: 640, height: 360, elementCount: 1, layerCacheHit: false,
      font: { mode: "bundled", format: "woff2", sha256: "a", sourceSha256: "b", sizeBytes: 1, characterCount: 1, cacheHit: false },
    } as const;
    const validReceipt = () => ({
      version: "remotion-layer-receipt/v3",
      state: "complete",
      complete: true,
      renderer: "remotion",
      renderer_version: "4.0.452",
      capability_sha256: capabilitySha256,
      bundle_identity: bundleIdentity,
      generation_id: generationId,
      fingerprint,
      overlay_sha256: createHash("sha256").update("overlay").digest("hex"),
      media,
      result,
    });
    const restore = () => {
      fs.writeFileSync(overlayPath, "overlay");
      fs.writeFileSync(receiptPath, JSON.stringify(sealLayerReceipt(validReceipt())));
    };
    restore();
    const input = {
      overlayPath,
      receiptPath,
      fingerprint,
      cacheRoot,
      expectedGenerationId: generationId,
      expectedBundleIdentity: bundleIdentity,
      expectedCapabilitySha256: capabilitySha256,
      expected: { width: 640, height: 360, fpsNum: 30, fpsDen: 1, durationFrames: 30 },
      probeAlphaLayerImpl: async () => media,
    };
    await expect(readValidRemotionLayerCache(input)).resolves.toMatchObject(result);

    for (const mutate of [
      (receipt: ReturnType<typeof validReceipt>) => { receipt.state = "partial"; },
      (receipt: ReturnType<typeof validReceipt>) => { receipt.complete = false; },
      (receipt: ReturnType<typeof validReceipt>) => { receipt.renderer_version = "4.0.453"; },
      (receipt: ReturnType<typeof validReceipt>) => { receipt.generation_id = `sha256:${"2".repeat(64)}`; },
      (receipt: ReturnType<typeof validReceipt>) => { receipt.capability_sha256 = "d".repeat(64); },
      (receipt: ReturnType<typeof validReceipt>) => { receipt.bundle_identity = "e".repeat(64); },
    ]) {
      const receipt = validReceipt();
      mutate(receipt);
      fs.writeFileSync(receiptPath, JSON.stringify(sealLayerReceipt(receipt)));
      await expect(readValidRemotionLayerCache(input)).resolves.toBeUndefined();
    }

    restore();
    fs.appendFileSync(receiptPath, "x");
    await expect(readValidRemotionLayerCache(input)).resolves.toBeUndefined();
    restore();
    const oneByteReceiptTamper = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    oneByteReceiptTamper.result.elementCount = 2;
    fs.writeFileSync(receiptPath, JSON.stringify(oneByteReceiptTamper));
    await expect(readValidRemotionLayerCache(input)).resolves.toBeUndefined();
    restore();
    fs.writeFileSync(overlayPath, "overlaz");
    await expect(readValidRemotionLayerCache(input)).resolves.toBeUndefined();
    restore();
    fs.writeFileSync(overlayPath, "");
    await expect(readValidRemotionLayerCache(input)).resolves.toBeUndefined();
    restore();
    fs.rmSync(overlayPath);
    await expect(readValidRemotionLayerCache(input)).resolves.toBeUndefined();

    const outsidePath = path.join(dir, "outside.webm");
    const outsideReceipt = path.join(dir, "outside.json");
    fs.writeFileSync(outsidePath, "overlay");
    fs.writeFileSync(outsideReceipt, JSON.stringify(sealLayerReceipt(validReceipt())));
    await expect(readValidRemotionLayerCache({
      ...input,
      overlayPath: outsidePath,
      receiptPath: outsideReceipt,
    })).resolves.toBeUndefined();
  });

  it("materializes collision-free private snapshots and disposes them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-snapshot-unit-"));
    dirs.push(dir);
    const source = path.join(dir, "frame.png");
    fs.writeFileSync(source, "verified-frame");
    const contentSha256 = createHash("sha256").update("verified-frame").digest("hex");
    const input = (assetId: string) => ({
      assetId, mediaKind: "image" as const, originalSourcePath: source,
      originalContentSha256: contentSha256, renderInputPath: source,
      renderInputContentSha256: contentSha256, relationship: "normalized_still_frame" as const,
      analysisPath: "03_analysis/frame.png", normalizationProducer: "ffmpeg-still-normalizer",
      normalizationProducerVersion: "1",
    });
    const snapshots = materializeVerifiedStillSnapshots({
      projectDir: dir,
      byAssetId: new Map([["A/B", input("A/B")], ["A_B", input("A_B")]]),
      imageAssetIds: new Set(["A/B", "A_B"]), sequenceAssetIds: new Set(),
    });
    const paths = [...snapshots.byAssetId.values()].map((entry) => entry.renderInputPath);
    expect(new Set(paths).size).toBe(2);
    expect(paths.every((entry) => fs.readFileSync(entry, "utf8") === "verified-frame")).toBe(true);
    expect(fs.statSync(snapshots.snapshotRoot).mode & 0o777).toBe(0o700);
    snapshots.dispose();
    expect(fs.existsSync(snapshots.snapshotRoot)).toBe(false);
  });

  it("stages sanitize-colliding asset IDs at distinct URLs with distinct bytes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-stage-collision-"));
    dirs.push(dir);
    const first = path.join(dir, "first.bin");
    const second = path.join(dir, "second.bin");
    const timelinePath = path.join(dir, "05_timeline", "timeline.json");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(first, "first-bytes");
    fs.writeFileSync(second, "second-bytes");
    const staged = stageSourceMapForRemotion(
      { "A/B": first, A_B: second },
      timelinePath,
      timeline(),
      { projectDir: dir, byAssetId: new Map(), imageAssetIds: new Set(), sequenceAssetIds: new Set() },
    );
    try {
      expect(staged.sourceMap["A/B"]).not.toBe(staged.sourceMap.A_B);
      const stagedFile = (assetId: "A/B" | "A_B") => path.join(
        staged.publicDir,
        staged.sourceMap[assetId].replace(/^\/public\//, ""),
      );
      expect(fs.readFileSync(stagedFile("A/B"), "utf8")).toBe("first-bytes");
      expect(fs.readFileSync(stagedFile("A_B"), "utf8")).toBe("second-bytes");
    } finally {
      fs.rmSync(staged.publicDir, { recursive: true, force: true });
    }
  });

  it("blocks a normalized-frame swap during snapshot copy and cleans the temp root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-snapshot-swap-"));
    dirs.push(dir);
    const source = path.join(dir, "frame.png");
    fs.writeFileSync(source, "verified-frame");
    const contentSha256 = createHash("sha256").update("verified-frame").digest("hex");
    expect(() => materializeVerifiedStillSnapshots({
      projectDir: dir,
      byAssetId: new Map([["AST", {
        assetId: "AST", mediaKind: "image", originalSourcePath: source,
        originalContentSha256: contentSha256, renderInputPath: source,
        renderInputContentSha256: contentSha256, relationship: "normalized_still_frame",
      }]]),
      imageAssetIds: new Set(["AST"]), sequenceAssetIds: new Set(),
    }, {
      tempRoot: dir,
      copyFileImpl: (copySource, destination) => {
        fs.writeFileSync(copySource, "forged-during-copy");
        try {
          fs.copyFileSync(copySource, destination);
        } finally {
          fs.writeFileSync(copySource, "verified-frame");
        }
      },
    })).toThrow("still_image_snapshot_hash_mismatch");
    expect(fs.readdirSync(dir).filter((entry) => entry.startsWith("vos-still-render-inputs-"))).toEqual([]);
  });
});
