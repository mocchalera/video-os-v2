import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASS_HEAVY_VIDEO_FONT,
  DEFAULT_VIDEO_FONT_ID,
  resolveVideoFont,
  type VideoFontId,
} from "../../editor/shared/font-contract.js";

export interface BundledFontPaths {
  fontId: VideoFontId;
  fontPath: string;
  assHeavyFontPath: string;
  licensePath: string;
  fontsDir: string;
}

export interface StagedBundledFontPaths extends BundledFontPaths {
  fontHref: string;
}

function candidateRepoRoots(cwd: string): string[] {
  const moduleRoot = fileURLToPath(new URL("../../", import.meta.url));
  return [...new Set([
    path.resolve(cwd),
    path.resolve(moduleRoot),
    path.resolve(moduleRoot, ".."),
  ])];
}

function resolveExistingRepoPath(repoRelativePath: string, cwd: string): string {
  for (const root of candidateRepoRoots(cwd)) {
    const candidate = path.resolve(root, repoRelativePath);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Bundled font asset is missing: ${repoRelativePath}`);
}

export function resolveBundledFontPaths(
  fontId: string = DEFAULT_VIDEO_FONT_ID,
  cwd: string = process.cwd(),
): BundledFontPaths {
  const font = resolveVideoFont(fontId);
  const fontPath = resolveExistingRepoPath(font.repoRelativePath, cwd);
  const assHeavyFontPath = resolveExistingRepoPath(
    ASS_HEAVY_VIDEO_FONT.repoRelativePath,
    cwd,
  );
  const licensePath = resolveExistingRepoPath(font.licenseRepoRelativePath, cwd);
  return {
    fontId: font.id,
    fontPath,
    assHeavyFontPath,
    licensePath,
    fontsDir: path.dirname(fontPath),
  };
}

export function verifyBundledFont(
  fontId: string = DEFAULT_VIDEO_FONT_ID,
  cwd: string = process.cwd(),
): BundledFontPaths {
  const contract = resolveVideoFont(fontId);
  const paths = resolveBundledFontPaths(fontId, cwd);
  const actualHash = createHash("sha256").update(readFileSync(paths.fontPath)).digest("hex");
  if (actualHash !== contract.sha256) {
    throw new Error(
      `Bundled font hash mismatch for ${contract.id}: expected ${contract.sha256}, got ${actualHash}`,
    );
  }
  const actualHeavyHash = createHash("sha256")
    .update(readFileSync(paths.assHeavyFontPath))
    .digest("hex");
  if (actualHeavyHash !== ASS_HEAVY_VIDEO_FONT.sha256) {
    throw new Error(
      `Bundled ASS heavy font hash mismatch: expected ${ASS_HEAVY_VIDEO_FONT.sha256}, got ${actualHeavyHash}`,
    );
  }
  const license = readFileSync(paths.licensePath, "utf8");
  if (!license.includes("SIL OPEN FONT LICENSE Version 1.1")) {
    throw new Error(`Bundled font license is invalid for ${contract.id}`);
  }
  return paths;
}

export function stageBundledFontAssets(
  destinationRoot: string,
  fontId: string = DEFAULT_VIDEO_FONT_ID,
  cwd: string = process.cwd(),
): StagedBundledFontPaths {
  const contract = resolveVideoFont(fontId);
  const source = verifyBundledFont(fontId, cwd);
  const fontsDir = path.join(destinationRoot, "fonts");
  const fontPath = path.join(fontsDir, contract.filename);
  const assHeavyFontPath = path.join(fontsDir, ASS_HEAVY_VIDEO_FONT.filename);
  const licensePath = path.join(fontsDir, contract.licenseFilename);
  mkdirSync(fontsDir, { recursive: true });
  copyFileSync(source.fontPath, fontPath);
  copyFileSync(source.assHeavyFontPath, assHeavyFontPath);
  copyFileSync(source.licensePath, licensePath);
  return {
    fontId: contract.id,
    fontPath,
    assHeavyFontPath,
    licensePath,
    fontsDir,
    fontHref: `./${contract.webPublicPath}`,
  };
}
