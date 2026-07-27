import * as fs from "node:fs";
import * as path from "node:path";
import { materializeFileSync } from "../filesystem/materialize-file.js";

export const PUBLISHED_OUTPUT_DIR = "09_output";
export const PUBLISHED_FINAL_VIDEO = "final.mp4";

export interface PublishedFinalVideo {
  path: string;
  relativePath: string;
}

export function getPublishedFinalVideoPath(projectDir: string): PublishedFinalVideo {
  const relativePath = path.join(PUBLISHED_OUTPUT_DIR, PUBLISHED_FINAL_VIDEO);
  return {
    path: path.join(projectDir, relativePath),
    relativePath,
  };
}

export function publishFinalVideo(projectDir: string, sourcePath: string): PublishedFinalVideo {
  const published = getPublishedFinalVideoPath(projectDir);
  fs.mkdirSync(path.dirname(published.path), { recursive: true });

  if (path.resolve(sourcePath) !== path.resolve(published.path)) {
    materializeFileSync(sourcePath, published.path);
  }

  return published;
}
