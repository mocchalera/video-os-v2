import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_VIDEO_FONT } from "../../shared/font-contract.js";

/** Resolve the shared bundled font from source or compiled editor output. */
export function resolvePreviewBundledFontsDir(cwd: string = process.cwd()): string {
  const moduleRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const roots = [...new Set([
    path.resolve(cwd),
    path.resolve(moduleRoot),
    path.resolve(moduleRoot, ".."),
  ])];
  for (const root of roots) {
    const candidate = path.resolve(root, DEFAULT_VIDEO_FONT.repoRelativePath);
    if (existsSync(candidate)) return path.dirname(candidate);
  }
  throw new Error(`Bundled preview font is missing: ${DEFAULT_VIDEO_FONT.repoRelativePath}`);
}
