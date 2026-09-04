import * as fs from "node:fs";
import * as path from "node:path";
import {
  packageRenderCommand,
  type PackageCommandOptions,
  type PackageCommandResult,
} from "./package.js";
import { resolveDeliveryArtifactPathsStrict } from "../packaging/active-delivery.js";
import { ProgressTracker } from "../progress.js";

export interface RenderCommandResult extends PackageCommandResult {
  progressPath?: string;
}

export async function runRender(
  projectDir: string,
  options?: PackageCommandOptions,
): Promise<RenderCommandResult> {
  // Authority FIRST: resolve the strict current pointer/identity before any
  // progress file, then install the signal coordinator before the async
  // package/render route can create assembler children.
  const resolvedDelivery = resolveDeliveryArtifactPathsStrict(path.resolve(projectDir));
  void resolvedDelivery;
  const pt = new ProgressTracker(projectDir, "render", 2);
  let result: PackageCommandResult;
  try {
    result = await packageRenderCommand(projectDir, options);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    pt.fail("render", message);
    throw error;
  }

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
    "09_output/final.mp4",
    "07_package/qa-report.json",
    "07_package/package_manifest.json",
    "07_package/video/final.mp4",
    "07_package/audio/final_mix.wav",
  ].filter((relativePath) => fs.existsSync(path.join(projectDir, relativePath)));
}
