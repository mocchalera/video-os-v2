import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeVideoStreamHash } from "../media/video-stream-hash.js";
import { computeSha256 } from "../packaging/manifest.js";
import {
  finishDialogueAudio,
  type AudioFinishExec,
  type AudioFinishRunReport,
} from "./finish-runner.js";
import type { ResolvedAudioFinishPolicy } from "./dialogue-finishing.js";

export const AUDIO_FINISH_REMUX_VERSION = "audio-finish-remux-receipt/v1" as const;

export interface AudioFinishRemuxReceipt {
  version: typeof AUDIO_FINISH_REMUX_VERSION;
  key: string;
  created_at: string;
  source: {
    path: string;
    sha256: string;
    video_stream_sha256: string;
  };
  policy: ResolvedAudioFinishPolicy;
  mastered_audio: {
    path: string;
    sha256: string;
  };
  output: {
    path: string;
    sha256: string;
    video_stream_sha256: string;
  };
  audio_finish_report: AudioFinishRunReport;
  verification: {
    video_stream_preserved: true;
  };
}

export interface AudioFinishRemuxResult {
  reused: boolean;
  outputDir: string;
  outputPath: string;
  masteredAudioPath: string;
  receiptPath: string;
  receipt: AudioFinishRemuxReceipt;
}

export type RemuxExec = (
  command: string,
  args: string[],
  options: { maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export function buildVideoPreservingRemuxArgs(
  sourceVideoPath: string,
  masteredAudioPath: string,
  outputPath: string,
): string[] {
  return [
    "-y",
    "-i", path.resolve(sourceVideoPath),
    "-i", path.resolve(masteredAudioPath),
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-map_metadata", "0",
    "-map_chapters", "0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-movflags", "+faststart",
    path.resolve(outputPath),
  ];
}

export async function finishAndRemuxVideo(input: {
  sourceVideoPath: string;
  outputRoot: string;
  policy: ResolvedAudioFinishPolicy;
  createdAt?: string;
  ffmpegBin?: string;
  audioExecFileImpl?: AudioFinishExec;
  remuxExecFileImpl?: RemuxExec;
  videoStreamHasher?: (filePath: string) => string;
}): Promise<AudioFinishRemuxResult> {
  const sourceVideoPath = path.resolve(input.sourceVideoPath);
  if (!fs.existsSync(sourceVideoPath)) {
    throw new Error(`audio finish remux source is missing: ${sourceVideoPath}`);
  }
  const sourceSha256 = computeSha256(sourceVideoPath);
  const key = crypto.createHash("sha256").update(JSON.stringify({
    version: AUDIO_FINISH_REMUX_VERSION,
    source_sha256: sourceSha256,
    policy: input.policy,
  })).digest("hex").slice(0, 24);
  const outputDir = path.join(path.resolve(input.outputRoot), key);
  const outputPath = path.join(outputDir, "final.mp4");
  const masteredAudioPath = path.join(outputDir, "mastered.wav");
  const receiptPath = path.join(outputDir, "audio-finish-remux-receipt.json");
  const existing = readReusableReceipt(receiptPath, sourceSha256, input.policy);
  if (existing) {
    return {
      reused: true,
      outputDir,
      outputPath,
      masteredAudioPath,
      receiptPath,
      receipt: existing,
    };
  }

  if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const ffmpegBin = input.ffmpegBin ?? "ffmpeg";
  const videoStreamHasher = input.videoStreamHasher ?? computeVideoStreamHash;
  const sourceVideoStreamSha256 = videoStreamHasher(sourceVideoPath);
  const finishReport = await finishDialogueAudio({
    inputPath: sourceVideoPath,
    outputPath: masteredAudioPath,
    policy: input.policy,
    ffmpegBin,
    execFileImpl: input.audioExecFileImpl,
  });
  await runRemux(
    input.remuxExecFileImpl ?? execFile,
    ffmpegBin,
    buildVideoPreservingRemuxArgs(sourceVideoPath, masteredAudioPath, outputPath),
  );
  if (!fs.existsSync(outputPath)) throw new Error("audio finish remux output is missing");
  const outputVideoStreamSha256 = videoStreamHasher(outputPath);
  if (outputVideoStreamSha256 !== sourceVideoStreamSha256) {
    fs.rmSync(outputPath, { force: true });
    throw new Error("audio finish remux changed the video stream");
  }

  const receipt: AudioFinishRemuxReceipt = {
    version: AUDIO_FINISH_REMUX_VERSION,
    key,
    created_at: input.createdAt ?? new Date().toISOString(),
    source: {
      path: sourceVideoPath,
      sha256: sourceSha256,
      video_stream_sha256: sourceVideoStreamSha256,
    },
    policy: input.policy,
    mastered_audio: {
      path: masteredAudioPath,
      sha256: computeSha256(masteredAudioPath),
    },
    output: {
      path: outputPath,
      sha256: computeSha256(outputPath),
      video_stream_sha256: outputVideoStreamSha256,
    },
    audio_finish_report: finishReport,
    verification: {
      video_stream_preserved: true,
    },
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return {
    reused: false,
    outputDir,
    outputPath,
    masteredAudioPath,
    receiptPath,
    receipt,
  };
}

function readReusableReceipt(
  receiptPath: string,
  sourceSha256: string,
  policy: ResolvedAudioFinishPolicy,
): AudioFinishRemuxReceipt | null {
  if (!fs.existsSync(receiptPath)) return null;
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as AudioFinishRemuxReceipt;
    if (
      receipt.version !== AUDIO_FINISH_REMUX_VERSION
      || receipt.source.sha256 !== sourceSha256
      || JSON.stringify(receipt.policy) !== JSON.stringify(policy)
      || receipt.verification.video_stream_preserved !== true
    ) return null;
    if (
      !fs.existsSync(receipt.mastered_audio.path)
      || !fs.existsSync(receipt.output.path)
      || computeSha256(receipt.mastered_audio.path) !== receipt.mastered_audio.sha256
      || computeSha256(receipt.output.path) !== receipt.output.sha256
    ) return null;
    return receipt;
  } catch {
    return null;
  }
}

function runRemux(
  runner: RemuxExec,
  command: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    runner(command, args, { maxBuffer: 50 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`audio finish remux failed: ${stderr || error.message}`));
        return;
      }
      resolve();
    });
  });
}
