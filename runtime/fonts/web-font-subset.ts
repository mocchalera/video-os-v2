import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_VIDEO_FONT,
  DEFAULT_VIDEO_FONT_ID,
  type VideoFontId,
  type VideoWebFontAsset,
} from "../../editor/shared/font-contract.js";
import { verifyBundledFont } from "./bundled-font.js";

export const WEB_FONT_SUBSET_VERSION = "web-font-subset/v1" as const;

// Covers CSS-generated labels and text-transform without carrying the CJK font.
const WEB_FONT_BASELINE_TEXT = Array.from(
  { length: 0x7f - 0x20 },
  (_, index) => String.fromCodePoint(0x20 + index),
).join("") + "\u00a0\u3000";

export interface WebFontSubsetOptions {
  cwd?: string;
  cacheDir?: string;
  subsetterBin?: string;
}

export interface PreparedWebFontAsset extends VideoWebFontAsset {
  fontPath: string;
  licensePath: string;
  filename: string;
  sha256: string;
  sourceSha256: string;
  characterCount: number;
  mode: "subset" | "full_fallback";
  cacheKey: string;
  cacheHit: boolean;
  fallbackReason?: string;
}

export interface StagedWebFontAsset extends PreparedWebFontAsset {
  fontsDir: string;
  fontHref: string;
  manifestPath: string;
}

interface WebFontSubsetCacheRecord {
  version: typeof WEB_FONT_SUBSET_VERSION;
  cache_key: string;
  source_sha256: string;
  output_sha256: string;
  character_count: number;
  filename: string;
}

function sha256Buffer(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultCacheDir(): string {
  if (process.env.VOS_FONT_SUBSET_CACHE_DIR) {
    return path.resolve(process.env.VOS_FONT_SUBSET_CACHE_DIR);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "video-os", "font-subsets");
  }
  return path.join(
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
    "video-os",
    "font-subsets",
  );
}

/** Produces one stable, code-point-sorted character set for a composition. */
export function canonicalizeWebFontText(values: Iterable<string>): string {
  const codePoints = new Set<number>();
  for (const value of [WEB_FONT_BASELINE_TEXT, ...values]) {
    for (const character of value) codePoints.add(character.codePointAt(0)!);
  }
  return [...codePoints]
    .sort((left, right) => left - right)
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join("");
}

/** Recursively collects authored strings without serializing object keys. */
export function collectWebFontStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectWebFontStrings(entry, output);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectWebFontStrings(entry, output);
    }
  }
  return output;
}

export function webFontSubsetCacheKey(
  text: string,
  fontId: VideoFontId = DEFAULT_VIDEO_FONT_ID,
): string {
  return sha256Buffer([
    WEB_FONT_SUBSET_VERSION,
    fontId,
    DEFAULT_VIDEO_FONT.sha256,
    [...text].map((character) => character.codePointAt(0)!.toString(16)).join(","),
  ].join("\n"));
}

function unicodeFileContents(text: string): string {
  return [...text]
    .map((character) => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
    .join("\n");
}

function validWoff2(filePath: string): boolean {
  if (!existsSync(filePath) || statSync(filePath).size < 4) return false;
  return readFileSync(filePath).subarray(0, 4).toString("ascii") === "wOF2";
}

function readValidCacheRecord(
  fontPath: string,
  metadataPath: string,
  cacheKey: string,
  characterCount: number,
): WebFontSubsetCacheRecord | null {
  if (!validWoff2(fontPath) || !existsSync(metadataPath)) return null;
  try {
    const record = JSON.parse(readFileSync(metadataPath, "utf8")) as WebFontSubsetCacheRecord;
    const actualHash = sha256Buffer(readFileSync(fontPath));
    if (
      record.version !== WEB_FONT_SUBSET_VERSION ||
      record.cache_key !== cacheKey ||
      record.source_sha256 !== DEFAULT_VIDEO_FONT.sha256 ||
      record.output_sha256 !== actualHash ||
      record.character_count !== characterCount ||
      record.filename !== path.basename(fontPath)
    ) return null;
    return record;
  } catch {
    return null;
  }
}

function fullFontFallback(
  text: string,
  cacheKey: string,
  reason: string,
  cwd?: string,
): PreparedWebFontAsset {
  const source = verifyBundledFont(DEFAULT_VIDEO_FONT_ID, cwd);
  return {
    fontId: DEFAULT_VIDEO_FONT.id,
    family: DEFAULT_VIDEO_FONT.family,
    webPublicPath: DEFAULT_VIDEO_FONT.webPublicPath,
    format: "truetype",
    weightRange: DEFAULT_VIDEO_FONT.weightRange,
    style: DEFAULT_VIDEO_FONT.style,
    fontPath: source.fontPath,
    licensePath: source.licensePath,
    filename: DEFAULT_VIDEO_FONT.filename,
    sha256: DEFAULT_VIDEO_FONT.sha256,
    sourceSha256: DEFAULT_VIDEO_FONT.sha256,
    characterCount: [...text].length,
    mode: "full_fallback",
    cacheKey,
    cacheHit: false,
    fallbackReason: reason,
  };
}

/**
 * Builds or reuses a standalone WOFF2 subset. FontTools is an optional local
 * accelerator: absence or failure preserves correctness by returning the
 * canonical full TTF.
 */
export function prepareWebFontAsset(
  values: Iterable<string>,
  options: WebFontSubsetOptions = {},
): PreparedWebFontAsset {
  const text = canonicalizeWebFontText(values);
  const cacheKey = webFontSubsetCacheKey(text);
  const filename = `${DEFAULT_VIDEO_FONT.id}-${cacheKey.slice(0, 20)}.woff2`;
  const cacheDir = path.resolve(options.cacheDir ?? defaultCacheDir());
  const cachedPath = path.join(cacheDir, filename);
  const cachedMetadataPath = `${cachedPath}.json`;
  const source = verifyBundledFont(DEFAULT_VIDEO_FONT_ID, options.cwd);
  const characterCount = [...text].length;
  const cachedRecord = readValidCacheRecord(
    cachedPath,
    cachedMetadataPath,
    cacheKey,
    characterCount,
  );

  if (cachedRecord) {
    return {
      fontId: DEFAULT_VIDEO_FONT.id,
      family: DEFAULT_VIDEO_FONT.family,
      webPublicPath: `fonts/${filename}`,
      format: "woff2",
      weightRange: DEFAULT_VIDEO_FONT.weightRange,
      style: DEFAULT_VIDEO_FONT.style,
      fontPath: cachedPath,
      licensePath: source.licensePath,
      filename,
      sha256: cachedRecord.output_sha256,
      sourceSha256: DEFAULT_VIDEO_FONT.sha256,
      characterCount,
      mode: "subset",
      cacheKey,
      cacheHit: true,
    };
  }

  mkdirSync(cacheDir, { recursive: true });
  const workDir = mkdtempSync(path.join(cacheDir, ".building-"));
  const unicodePath = path.join(workDir, "unicodes.txt");
  const outputPath = path.join(workDir, filename);
  const outputMetadataPath = `${outputPath}.json`;
  writeFileSync(unicodePath, unicodeFileContents(text), "utf8");

  try {
    const subsetterBin = options.subsetterBin ?? process.env.VOS_PYFTSUBSET_BIN ?? "pyftsubset";
    const result = spawnSync(subsetterBin, [
      source.fontPath,
      `--unicodes-file=${unicodePath}`,
      `--output-file=${outputPath}`,
      "--flavor=woff2",
      "--layout-features=*",
      "--glyph-names",
      "--symbol-cmap",
      "--legacy-cmap",
      "--notdef-glyph",
      "--notdef-outline",
      "--recommended-glyphs",
      "--name-IDs=*",
      "--name-legacy",
      "--name-languages=*",
      "--no-recalc-timestamp",
    ], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });

    if (result.error || result.status !== 0 || !validWoff2(outputPath)) {
      const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
      return fullFontFallback(text, cacheKey, `pyftsubset unavailable or failed: ${detail}`, options.cwd);
    }

    const outputSha256 = sha256Buffer(readFileSync(outputPath));
    const cacheRecord: WebFontSubsetCacheRecord = {
      version: WEB_FONT_SUBSET_VERSION,
      cache_key: cacheKey,
      source_sha256: DEFAULT_VIDEO_FONT.sha256,
      output_sha256: outputSha256,
      character_count: characterCount,
      filename,
    };
    writeFileSync(outputMetadataPath, `${JSON.stringify(cacheRecord, null, 2)}\n`, "utf8");

    try {
      renameSync(outputPath, cachedPath);
      renameSync(outputMetadataPath, cachedMetadataPath);
    } catch (error) {
      if (!readValidCacheRecord(cachedPath, cachedMetadataPath, cacheKey, characterCount)) throw error;
    }
    const finalRecord = readValidCacheRecord(
      cachedPath,
      cachedMetadataPath,
      cacheKey,
      characterCount,
    );
    if (!finalRecord) throw new Error(`Generated font subset cache failed verification: ${cachedPath}`);

    return {
      fontId: DEFAULT_VIDEO_FONT.id,
      family: DEFAULT_VIDEO_FONT.family,
      webPublicPath: `fonts/${filename}`,
      format: "woff2",
      weightRange: DEFAULT_VIDEO_FONT.weightRange,
      style: DEFAULT_VIDEO_FONT.style,
      fontPath: cachedPath,
      licensePath: source.licensePath,
      filename,
      sha256: finalRecord.output_sha256,
      sourceSha256: DEFAULT_VIDEO_FONT.sha256,
      characterCount,
      mode: "subset",
      cacheKey,
      cacheHit: false,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function stageWebFontAssets(
  destinationRoot: string,
  values: Iterable<string>,
  options: WebFontSubsetOptions = {},
): StagedWebFontAsset {
  const prepared = prepareWebFontAsset(values, options);
  const fontsDir = path.join(destinationRoot, "fonts");
  const licensesDir = path.join(destinationRoot, "licenses");
  const fontPath = path.join(fontsDir, prepared.filename);
  const licensePath = path.join(licensesDir, DEFAULT_VIDEO_FONT.licenseFilename);
  const extension = path.extname(prepared.filename).toLowerCase();
  if (!new Set([".ttf", ".otf", ".woff", ".woff2"]).has(extension)) {
    throw new Error(`Font staging refused non-font asset: ${prepared.filename}`);
  }
  mkdirSync(fontsDir, { recursive: true });
  mkdirSync(licensesDir, { recursive: true });
  copyFileSync(prepared.fontPath, fontPath);
  copyFileSync(prepared.licensePath, licensePath);
  const manifestPath = path.join(destinationRoot, "font-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    version: "font-staging-manifest/v1",
    font_id: prepared.fontId,
    family: prepared.family,
    fallback_used: prepared.mode === "full_fallback",
    diagnostics: prepared.fallbackReason ? [{ code: "subset_fallback", message: prepared.fallbackReason }] : [],
    assets: [{ role: "web", path: path.relative(destinationRoot, fontPath), sha256: `sha256:${prepared.sha256}` }],
    license: path.relative(destinationRoot, licensePath),
  }, null, 2)}\n`, "utf8");
  return {
    ...prepared,
    webPublicPath: `fonts/${prepared.filename}`,
    fontPath,
    licensePath,
    fontsDir,
    fontHref: `./fonts/${prepared.filename}`,
    manifestPath,
  };
}
