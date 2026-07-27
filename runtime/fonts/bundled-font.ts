import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASS_BOLD_VIDEO_FONT,
  ASS_HEAVY_VIDEO_FONT,
  DEFAULT_VIDEO_FONT_ID,
  resolveVideoFont,
  type VideoFontId,
} from "../../editor/shared/font-contract.js";

export interface BundledFontPaths {
  fontId: VideoFontId;
  fontPath: string;
  assBoldFontPath: string;
  assHeavyFontPath: string;
  licensePath: string;
  fontsDir: string;
}

export interface StagedBundledFontPaths extends BundledFontPaths {
  fontHref: string;
  manifestPath: string;
}

export interface BundledFontSelection {
  family: string;
  role: "primary" | "ass_bold" | "ass_heavy";
  weight: number;
}

const ALLOWED_FONT_EXTENSIONS = new Set([".ttf", ".otf", ".woff", ".woff2"]);

function assertAllowedFontAsset(filePath: string): void {
  if (!ALLOWED_FONT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    throw new Error(`Font staging refused non-font asset: ${filePath}`);
  }
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
  const assBoldFontPath = resolveExistingRepoPath(
    ASS_BOLD_VIDEO_FONT.repoRelativePath,
    cwd,
  );
  const assHeavyFontPath = resolveExistingRepoPath(
    ASS_HEAVY_VIDEO_FONT.repoRelativePath,
    cwd,
  );
  const licensePath = resolveExistingRepoPath(font.licenseRepoRelativePath, cwd);
  return {
    fontId: font.id,
    fontPath,
    assBoldFontPath,
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
  const actualBoldHash = createHash("sha256")
    .update(readFileSync(paths.assBoldFontPath))
    .digest("hex");
  if (actualBoldHash !== ASS_BOLD_VIDEO_FONT.sha256) {
    throw new Error(
      `Bundled ASS bold font hash mismatch: expected ${ASS_BOLD_VIDEO_FONT.sha256}, got ${actualBoldHash}`,
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
  requestedSelection?: BundledFontSelection,
): StagedBundledFontPaths {
  const contract = resolveVideoFont(fontId);
  const source = verifyBundledFont(fontId, cwd);
  const fontsDir = path.join(destinationRoot, "fonts");
  const licensesDir = path.join(destinationRoot, "licenses");
  const fontPath = path.join(fontsDir, contract.filename);
  const assBoldFontPath = path.join(fontsDir, ASS_BOLD_VIDEO_FONT.filename);
  const assHeavyFontPath = path.join(fontsDir, ASS_HEAVY_VIDEO_FONT.filename);
  const licensePath = path.join(licensesDir, contract.licenseFilename);
  assertAllowedFontAsset(source.fontPath);
  assertAllowedFontAsset(source.assBoldFontPath);
  assertAllowedFontAsset(source.assHeavyFontPath);
  mkdirSync(fontsDir, { recursive: true });
  mkdirSync(licensesDir, { recursive: true });
  copyFileSync(source.fontPath, fontPath);
  copyFileSync(source.assBoldFontPath, assBoldFontPath);
  copyFileSync(source.assHeavyFontPath, assHeavyFontPath);
  copyFileSync(source.licensePath, licensePath);
  const selection = requestedSelection ?? {
    family: contract.family,
    role: "primary" as const,
    weight: 400,
  };
  const selectedAsset = selection.role === "ass_bold"
    ? {
      role: "ass_bold" as const,
      family: ASS_BOLD_VIDEO_FONT.family,
      path: path.relative(destinationRoot, assBoldFontPath),
      sha256: `sha256:${ASS_BOLD_VIDEO_FONT.sha256}`,
      weight: ASS_BOLD_VIDEO_FONT.weight,
    }
    : selection.role === "ass_heavy"
    ? {
      role: "ass_heavy" as const,
      family: ASS_HEAVY_VIDEO_FONT.family,
      path: path.relative(destinationRoot, assHeavyFontPath),
      sha256: `sha256:${ASS_HEAVY_VIDEO_FONT.sha256}`,
      weight: ASS_HEAVY_VIDEO_FONT.weight,
    }
    : {
      role: "primary" as const,
      family: contract.family,
      path: path.relative(destinationRoot, fontPath),
      sha256: `sha256:${contract.sha256}`,
      weight: selection.weight,
    };
  if (selection.family !== selectedAsset.family || selection.weight !== selectedAsset.weight) {
    throw new Error(
      `Font selection does not match verified ${selection.role} asset: ${selection.family}/${selection.weight}`,
    );
  }
  const manifestPath = path.join(destinationRoot, "font-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    version: "font-staging-manifest/v3",
    font_id: contract.id,
    family: contract.family,
    selected_family: selectedAsset.family,
    selected_asset: selectedAsset,
    fallback_used: false,
    assets: [
      { role: "primary", path: path.relative(destinationRoot, fontPath), sha256: `sha256:${contract.sha256}` },
      { role: "ass_bold", family: ASS_BOLD_VIDEO_FONT.family, path: path.relative(destinationRoot, assBoldFontPath), sha256: `sha256:${ASS_BOLD_VIDEO_FONT.sha256}` },
      { role: "ass_heavy", family: ASS_HEAVY_VIDEO_FONT.family, path: path.relative(destinationRoot, assHeavyFontPath), sha256: `sha256:${ASS_HEAVY_VIDEO_FONT.sha256}` },
    ],
    license: path.relative(destinationRoot, licensePath),
  }, null, 2)}\n`, "utf8");
  return {
    fontId: contract.id,
    fontPath,
    assBoldFontPath,
    assHeavyFontPath,
    licensePath,
    fontsDir,
    fontHref: `./${contract.webPublicPath}`,
    manifestPath,
  };
}
