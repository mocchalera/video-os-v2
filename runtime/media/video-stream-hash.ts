import { spawnSync } from "node:child_process";
import * as path from "node:path";

export function computeVideoStreamHash(filePath: string): string {
  const result = spawnSync("ffmpeg", [
    "-v", "error",
    "-i", path.resolve(filePath),
    "-map", "0:v:0",
    "-c", "copy",
    "-f", "streamhash",
    "-hash", "sha256",
    "-",
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `could not hash video stream: ${result.stderr.trim() || "ffmpeg failed"}`,
    );
  }
  const match = result.stdout.match(/SHA256=([a-f0-9]{64})/i);
  if (!match) throw new Error("could not parse video stream hash");
  return `sha256:${match[1].toLowerCase()}`;
}
