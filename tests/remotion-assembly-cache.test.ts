import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  createRemotionAssemblyFingerprint,
  readValidRemotionAssemblyCache,
  stageSourceMapForRemotion,
} from "../runtime/render/remotion/render-remotion.js";
import { materializeVerifiedStillSnapshots } from "../runtime/render/canonical-render-input.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

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
    const writeReceipt = (version: string, contentSha256: string, sizeBytes: number) => {
      fs.writeFileSync(receiptPath, JSON.stringify({
        version, fingerprint, output: { contentSha256, sizeBytes }, result,
      }));
    };
    const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

    fs.writeFileSync(output, "ORIGINAL");
    writeReceipt("remotion-assembly-cache/v2", hash("ORIGINAL"), 8);
    expect(readValidRemotionAssemblyCache(output, receiptPath, fingerprint)).toMatchObject(result);

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
