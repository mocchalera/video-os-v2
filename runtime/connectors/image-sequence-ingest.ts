import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  computeFingerprint,
  computeRequestHash,
  extractJpegExifRotation,
  extractRotation,
  extractVideoStream,
  generateAssetId,
  runFfprobe,
  type AssetItem,
  type FfprobeOutput,
  type ImageSequenceMetadata,
} from "./ffprobe.js";
import {
  computeImageSequenceFrameSetContentSha256,
  type ImageSequenceFrame,
  type ImageSequenceGroup,
} from "../media/image-sequence.js";
import { sha256FileHex } from "../source-content-identity.js";

export const IMAGE_SEQUENCE_NORMALIZATION_PRODUCER = "ffmpeg-image-sequence-normalizer" as const;
export const IMAGE_SEQUENCE_NORMALIZATION_PRODUCER_VERSION = "1" as const;

export async function ingestImageSequence(
  group: ImageSequenceGroup,
  opts: { projectRoot: string; policyHash: string; ffmpegVersion: string },
): Promise<{ sourceFile: string; asset: AssetItem }> {
  if (group.status !== "candidate") throw new Error(group.reason ?? "image_sequence_group_not_ready");
  const projectRoot = path.resolve(opts.projectRoot);
  const outputRelative = path.posix.join("image_sequences", group.group_id, "analysis.nut");
  const outputPath = path.join(projectRoot, "03_analysis", ...outputRelative.split("/"));
  const outputDir = path.dirname(outputPath);
  const stagingPath = path.join(outputDir, `.analysis.current-run-${process.pid}-${Date.now()}.nut`);
  fs.mkdirSync(outputDir, { recursive: true });
  cleanupStaleStagingFiles(outputDir);

  try {
    const frameProbes = await verifyFrames(group, "since_discovery");
    const sourceVideo = extractVideoStream(frameProbes[0]);
    if (!sourceVideo) throw new Error("image_sequence_decode_failed:no_decodable_video_frame");
    for (let index = 1; index < frameProbes.length; index++) {
      const video = extractVideoStream(frameProbes[index]);
      if (!video) throw new Error(`image_sequence_decode_failed:no_decodable_video_frame:${group.frames[index].frame_number}`);
      if (video.width !== sourceVideo.width || video.height !== sourceVideo.height) {
        throw new Error(`image_sequence_frame_dimensions_mismatch:${group.frames[index].frame_number}`);
      }
    }

    await execFilePromise("ffmpeg", [
      "-v", "error",
      "-xerror",
      "-y",
      "-fflags", "+bitexact",
      "-framerate", `${group.fps_num}/${group.fps_den}`,
      "-start_number", String(group.start_number),
      "-pattern_type", "sequence",
      "-i", group.pattern_path,
      "-frames:v", String(group.frame_count),
      "-an",
      "-c:v", "ffv1",
      "-level", "3",
      "-g", "1",
      "-flags:v", "+bitexact",
      "-map_metadata", "-1",
      "-f", "nut",
      stagingPath,
    ]);
    const decoded = await probeDecodedProxy(stagingPath);
    if (decoded.frameCount !== group.frame_count) {
      throw new Error(`image_sequence_decoded_frame_count_mismatch:expected=${group.frame_count}:actual=${decoded.frameCount}`);
    }
    if (decoded.fpsNum !== group.fps_num || decoded.fpsDen !== group.fps_den) {
      throw new Error(`image_sequence_decoded_frame_rate_mismatch:expected=${group.fps_num}/${group.fps_den}:actual=${decoded.fpsNum}/${decoded.fpsDen}`);
    }
    await verifyFrames(group, "during_ingest", false);
    const stagedSha256 = sha256FileHex(stagingPath);
    const existingMatches = fs.existsSync(outputPath) && sha256FileHex(outputPath) === stagedSha256;
    if (existingMatches) {
      fs.rmSync(stagingPath, { force: true });
    } else {
      fs.renameSync(stagingPath, outputPath);
    }

    const proxyProbe = await runFfprobe(outputPath);
    const proxyVideo = extractVideoStream(proxyProbe);
    if (!proxyVideo) throw new Error("image_sequence_proxy_video_stream_missing");
    const fingerprint = await computeFingerprint(outputPath, group.duration_us, proxyProbe.streams);
    const assetId = generateAssetId(fingerprint);
    const proxyStat = fs.statSync(outputPath);
    const proxySha256 = sha256FileHex(outputPath);
    const metadata: ImageSequenceMetadata = {
      grouping_producer: group.grouping_producer,
      grouping_producer_version: group.grouping_producer_version,
      normalization_producer: IMAGE_SEQUENCE_NORMALIZATION_PRODUCER,
      normalization_producer_version: IMAGE_SEQUENCE_NORMALIZATION_PRODUCER_VERSION,
      pattern_basename: group.pattern_basename,
      start_number: group.start_number,
      end_number: group.end_number,
      frame_count: group.frame_count,
      padding: group.padding,
      fps_num: group.fps_num,
      fps_den: group.fps_den,
      frame_set_content_sha256: group.frame_set_content_sha256,
      frame_content_sha256: group.frames.map((frame) => frame.content_sha256),
      analysis_proxy_path: outputRelative,
      analysis_proxy_content_sha256: proxySha256,
      analysis_proxy_frame_count: decoded.frameCount,
      source_width: sourceVideo.width,
      source_height: sourceVideo.height,
      decoded_width: proxyVideo.width,
      decoded_height: proxyVideo.height,
      normalized_pixel_format: decoded.pixelFormat,
    };
    const requestHash = computeRequestHash({
      connector_version: IMAGE_SEQUENCE_NORMALIZATION_PRODUCER_VERSION,
      ffmpeg_version: opts.ffmpegVersion,
      frame_set_content_sha256: group.frame_set_content_sha256,
      fps_num: group.fps_num,
      fps_den: group.fps_den,
    });
    return {
      sourceFile: outputPath,
      asset: {
        asset_id: assetId,
        filename: group.pattern_basename,
        media_kind: "sequence",
        duration_us: group.duration_us,
        duration_semantics: "physical_media_duration",
        has_transcript: false,
        transcript_ref: null,
        segments: 0,
        segment_ids: [],
        quality_flags: [],
        tags: [],
        source_fingerprint: fingerprint,
        source_locator: path.posix.join("03_analysis", outputRelative),
        video_stream: {
          width: proxyVideo.width,
          height: proxyVideo.height,
          fps_num: group.fps_num,
          fps_den: group.fps_den,
          codec: proxyVideo.codec,
        },
        frame_rate_mode: "cfr",
        rotation: null,
        contact_sheet_ids: [],
        analysis_status: "pending",
        source_content_sha256: proxySha256,
        source_size_bytes: proxyStat.size,
        source_mtime_ms: Math.round(proxyStat.mtimeMs),
        image_sequence: metadata,
        confidence: { score: 1, source: "image-sequence-preflight", status: "ready" },
        provenance: {
          stage: "ingest",
          method: "ffmpeg-image2-sequence-normalize",
          connector_version: IMAGE_SEQUENCE_NORMALIZATION_PRODUCER_VERSION,
          policy_hash: opts.policyHash,
          request_hash: requestHash,
          ffmpeg_version: opts.ffmpegVersion,
          source_content_sha256: proxySha256,
        },
      },
    };
  } catch (error) {
    fs.rmSync(stagingPath, { force: true });
    fs.rmSync(outputPath, { force: true });
    removeEmptyDir(outputDir);
    throw error;
  }
}

async function verifyFrames(
  group: ImageSequenceGroup,
  phase: "since_discovery" | "during_ingest",
  probeFrames = true,
): Promise<FfprobeOutput[]> {
  const current: ImageSequenceFrame[] = [];
  const probes: FfprobeOutput[] = [];
  for (const frame of group.frames) {
    let stat: fs.Stats;
    let contentSha256: string;
    try {
      stat = fs.statSync(frame.canonical_path);
      if (!stat.isFile()) throw new Error("not_regular_file");
      contentSha256 = sha256FileHex(frame.canonical_path);
    } catch {
      throw new Error(`image_sequence_frame_missing_or_unreadable:${frame.frame_number}`);
    }
    const actualMtime = Math.round(stat.mtimeMs);
    if (
      contentSha256 !== frame.content_sha256 ||
      stat.size !== frame.size_bytes ||
      (phase === "since_discovery" && actualMtime !== frame.mtime_ms)
    ) {
      throw new Error(`image_sequence_source_identity_changed_${phase}:${frame.frame_number}`);
    }
    if (probeFrames) {
      const probe = await runFfprobe(frame.canonical_path).catch(() => undefined);
      if (!probe || !extractVideoStream(probe)) {
        throw new Error(`image_sequence_decode_failed:${frame.frame_number}`);
      }
      const rotation = extractRotation(probe) ?? extractJpegExifRotation(frame.canonical_path);
      if (rotation !== null && rotation !== 0) {
        throw new Error(`image_sequence_orientation_not_supported:${frame.frame_number}:${rotation}`);
      }
      probes.push(probe);
    }
    current.push({ ...frame, content_sha256: contentSha256, size_bytes: stat.size, mtime_ms: actualMtime });
  }
  const actualFrameSet = computeImageSequenceFrameSetContentSha256(current);
  if (actualFrameSet !== group.frame_set_content_sha256) {
    throw new Error(`image_sequence_frame_set_identity_changed_${phase}`);
  }
  return probes;
}

async function probeDecodedProxy(filePath: string): Promise<{
  frameCount: number;
  fpsNum: number;
  fpsDen: number;
  pixelFormat: string;
}> {
  const { stdout } = await execFilePromise("ffprobe", [
    "-v", "error",
    "-count_frames",
    "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames,avg_frame_rate,pix_fmt",
    "-of", "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as { streams?: Array<{ nb_read_frames?: string; avg_frame_rate?: string; pix_fmt?: string }> };
  const stream = parsed.streams?.[0];
  const [fpsNumRaw, fpsDenRaw = "1"] = (stream?.avg_frame_rate ?? "0/1").split("/");
  return {
    frameCount: Number(stream?.nb_read_frames ?? 0),
    fpsNum: Number(fpsNumRaw),
    fpsDen: Number(fpsDenRaw),
    pixelFormat: stream?.pix_fmt ?? "unknown",
  };
}

function execFilePromise(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${command}_failed:${String(stderr).trim() || error.message}`));
      resolve({ stdout, stderr });
    });
  });
}

function removeEmptyDir(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // Best-effort cleanup inside the task-owned sequence analysis directory.
  }
}

function cleanupStaleStagingFiles(dir: string): void {
  const staleBeforeMs = Date.now() - 24 * 60 * 60 * 1_000;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(".analysis.current-run-") && entry.name.endsWith(".nut")) {
      const stagingPath = path.join(dir, entry.name);
      try {
        if (fs.statSync(stagingPath).mtimeMs < staleBeforeMs) fs.rmSync(stagingPath, { force: true });
      } catch {
        // Another run may have cleaned the same stale staging file.
      }
    }
  }
}
