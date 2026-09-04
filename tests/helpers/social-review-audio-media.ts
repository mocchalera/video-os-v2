import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type ReviewAudioMismatchKind =
  | "near-tone"
  | "truncated"
  | "near-speech"
  | "level-plus-1.5db"
  | "stereo-swap"
  | "duration-300ms"
  | "level-minus-6db"
  | "envelope-change"
  | "offset-50ms";

export function writeReviewAudioIdentityMedia(input: {
  root: string;
  kind: ReviewAudioMismatchKind;
  durationSeconds?: number;
}): {
  outputAudioPath: string;
  mismatchedAudioPath: string;
  matchingVideoPath: string;
  mismatchedVideoPath: string;
} {
  const duration = input.durationSeconds ?? 1;
  fs.mkdirSync(input.root, { recursive: true });
  const outputAudioPath = path.join(input.root, "mastered.wav");
  const mismatchedAudioPath = path.join(input.root, "mismatched.wav");
  const matchingVideoPath = path.join(input.root, "matching.mp4");
  const mismatchedVideoPath = path.join(input.root, "mismatched.mp4");
  const speech = `0.12*(sin(2*PI*180*t)+0.6*sin(2*PI*420*t)+0.3*sin(2*PI*900*t))`;
  let outputSource = `sine=frequency=440:sample_rate=48000:duration=${duration}`;
  let mismatchedSource = outputSource;
  let mismatchedFilter: string | undefined;
  switch (input.kind) {
    case "near-tone":
      mismatchedSource = `sine=frequency=450:sample_rate=48000:duration=${duration}`;
      break;
    case "truncated":
      mismatchedSource = `sine=frequency=440:sample_rate=48000:duration=${duration - 0.05}`;
      break;
    case "near-speech":
      outputSource = `aevalsrc=${speech}*if(lt(mod(t\\,0.7)\\,0.5)\\,1\\,0):s=48000:d=${duration}`;
      mismatchedSource = `aevalsrc=0.12*(sin(2*PI*180*t)+0.6*sin(2*PI*420*t+0.8)+0.3*sin(2*PI*900*t))*if(lt(mod(t\\,0.7)\\,0.5)\\,1\\,0):s=48000:d=${duration}`;
      break;
    case "level-plus-1.5db":
      mismatchedFilter = "volume=1.188502";
      break;
    case "stereo-swap":
      outputSource = `aevalsrc=0.2*sin(2*PI*220*t)|0.2*sin(2*PI*700*t):s=48000:d=${duration}`;
      mismatchedSource = `aevalsrc=0.2*sin(2*PI*700*t)|0.2*sin(2*PI*220*t):s=48000:d=${duration}`;
      break;
    case "duration-300ms":
      mismatchedSource = `sine=frequency=440:sample_rate=48000:duration=${duration - 0.3}`;
      break;
    case "level-minus-6db":
      mismatchedFilter = "volume=0.501187";
      break;
    case "envelope-change":
      outputSource = `aevalsrc=${speech}*if(lt(mod(t\\,0.4)\\,0.3)\\,1\\,0):s=48000:d=${duration}`;
      mismatchedSource = `aevalsrc=${speech}*if(lt(mod(t\\,0.4)\\,0.2)\\,1\\,0):s=48000:d=${duration}`;
      break;
    case "offset-50ms":
      outputSource = `aevalsrc=${speech}*if(between(t\\,0.1\\,${duration - 0.2})\\,1\\,0):s=48000:d=${duration}`;
      mismatchedSource = `aevalsrc=${speech}*if(between(t\\,0.15\\,${duration - 0.15})\\,1\\,0):s=48000:d=${duration}`;
      break;
  }
  const forceStereo = input.kind === "stereo-swap" ? [] : ["-ac", "2"];
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", outputSource, ...forceStereo, "-y", outputAudioPath,
  ]);
  const mismatchedArgs = ["-v", "error", "-f", "lavfi", "-i", mismatchedSource];
  if (mismatchedFilter) mismatchedArgs.push("-af", mismatchedFilter);
  execFileSync("ffmpeg", [...mismatchedArgs, ...forceStereo, "-y", mismatchedAudioPath]);
  for (const [audioPath, videoPath] of [
    [outputAudioPath, matchingVideoPath],
    [mismatchedAudioPath, mismatchedVideoPath],
  ] as const) {
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", `color=c=black:s=64x64:r=25:d=${duration}`,
      "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k", "-t", String(duration), "-y", videoPath,
    ]);
  }
  return { outputAudioPath, mismatchedAudioPath, matchingVideoPath, mismatchedVideoPath };
}
