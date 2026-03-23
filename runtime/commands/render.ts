import * as fs from "node:fs";
import * as path from "node:path";
import {
  packageCommand,
  type PackageCommandOptions,
  type PackageCommandResult,
} from "./package.js";
import { ProgressTracker } from "../progress.js";

export interface RenderCommandResult extends PackageCommandResult {
  progressPath?: string;
}

export async function runRender(
  projectDir: string,
  options?: PackageCommandOptions,
): Promise<RenderCommandResult> {
  const pt = new ProgressTracker(projectDir, "render", 2);
  const result = await packageCommand(projectDir, {
    ...options,
    commandName: "/render",
    actorName: "render-video",
    allowedStates: ["approved", "packaged"],
  });

  if (!result.success) {
    if (result.error) {
      pt.fail("render", result.error.message);
      return { ...result, progressPath: pt.filePath };
    }
    return result;
  }

  pt.advance("07_package/qa-report.json");
  pt.complete(collectRenderArtifacts(projectDir));
  return { ...result, progressPath: pt.filePath };
}

function collectRenderArtifacts(projectDir: string): string[] {
  return [
    "07_package/qa-report.json",
    "07_package/package_manifest.json",
    "07_package/video/final.mp4",
    "07_package/audio/final_mix.wav",
  ].filter((relativePath) => fs.existsSync(path.join(projectDir, relativePath)));
}
