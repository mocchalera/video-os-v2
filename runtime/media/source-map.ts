import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AssetItem } from "../connectors/ffprobe.js";
import { resolveBgmAnalysisPath } from "./bgm-analyzer.js";

export const MEDIA_DIR_NAME = "02_media";
export const SOURCE_MAP_FILE_NAME = "source_map.json";

export interface MediaSourceMapEntry {
  asset_id: string;
  source_locator: string;
  local_source_path: string;
  link_path: string;
  display_name?: string;
  kind?: "asset" | "bgm";
  link_type?: "symlink";
}

export interface MediaSourceMapDoc {
  version: "1";
  project_id: string;
  media_dir: string;
  generated_at: string;
  items: MediaSourceMapEntry[];
}

export interface LoadedSourceMap {
  filePath?: string;
  locatorMap: Map<string, string>;
  entryMap: Map<string, MediaSourceMapEntry>;
  entries: MediaSourceMapEntry[];
}

interface MediaLinkPlan {
  assetId?: string;
  displayName?: string;
  sourcePath: string;
  linkPath: string;
  sourceLocator: string;
  kind: "asset" | "bgm";
}

export interface CreateMediaLinksOptions {
  projectPath: string;
  projectId: string;
  assets: AssetItem[];
  sourceFileMap: Map<string, string>;
  generatedAt?: string;
}

export interface CreateMediaLinksResult {
  doc: MediaSourceMapDoc;
  sourceMapPath: string;
  warnings: string[];
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function toPosixRel(projectPath: string, targetPath: string): string {
  return path.relative(projectPath, targetPath).split(path.sep).join("/");
}

function normalizeExt(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function normalizeFallbackStem(fallbackStem: string): string {
  const safe = fallbackStem
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/gu, "-")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/gu, "")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return safe || "asset";
}

export function toSafeMediaBasename(
  displayName: string,
  fallbackStem = "asset",
): string {
  const safe = displayName
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/gu, "-")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/gu, "")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

  return safe || normalizeFallbackStem(fallbackStem);
}

function allocateUniqueFilename(
  dirCounts: Map<string, number>,
  stem: string,
  ext: string,
): string {
  const count = (dirCounts.get(stem) ?? 0) + 1;
  dirCounts.set(stem, count);
  return count === 1 ? `${stem}${ext}` : `${stem}-${count}${ext}`;
}

function ensureSymlink(linkPath: string, targetPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });

  if (fs.existsSync(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite non-symlink media entry: ${linkPath}`);
    }

    const currentTarget = fs.readlinkSync(linkPath);
    if (currentTarget === targetPath) {
      return;
    }
    fs.unlinkSync(linkPath);
  }

  fs.symlinkSync(targetPath, linkPath);
}

function removeStaleSymlink(linkPath: string): void {
  if (!fs.existsSync(linkPath)) return;
  const stat = fs.lstatSync(linkPath);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(linkPath);
  }
}

function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function resolveSourceMapCandidatePath(
  projectPath: string,
  sourceMapPath?: string,
): string {
  if (sourceMapPath) return path.resolve(sourceMapPath);
  return path.join(projectPath, MEDIA_DIR_NAME, SOURCE_MAP_FILE_NAME);
}

function resolveLocatorPath(
  projectPath: string,
  sourceMapFilePath: string,
  locator?: string,
  linkPath?: string,
): string | undefined {
  if (locator) {
    if (path.isAbsolute(locator)) return locator;

    const nextToMap = path.resolve(path.dirname(sourceMapFilePath), locator);
    if (fs.existsSync(nextToMap)) return nextToMap;

    return path.resolve(projectPath, locator);
  }

  if (!linkPath) return undefined;
  return path.resolve(projectPath, linkPath);
}

function normalizeLoadedEntry(
  projectPath: string,
  sourceMapFilePath: string,
  entry: Partial<MediaSourceMapEntry> & { asset_id: string },
): MediaSourceMapEntry | undefined {
  const sourceLocator = resolveLocatorPath(
    projectPath,
    sourceMapFilePath,
    typeof entry.source_locator === "string" ? entry.source_locator : undefined,
    typeof entry.link_path === "string" ? entry.link_path : undefined,
  );
  if (!sourceLocator) return undefined;

  return {
    asset_id: entry.asset_id,
    source_locator: sourceLocator,
    local_source_path: typeof entry.local_source_path === "string"
      ? (path.isAbsolute(entry.local_source_path)
          ? entry.local_source_path
          : path.resolve(path.dirname(sourceMapFilePath), entry.local_source_path))
      : sourceLocator,
    link_path: typeof entry.link_path === "string"
      ? entry.link_path
      : toPosixRel(projectPath, sourceLocator),
    ...(typeof entry.display_name === "string" ? { display_name: entry.display_name } : {}),
    ...(entry.kind === "asset" || entry.kind === "bgm" ? { kind: entry.kind } : {}),
    ...(entry.link_type === "symlink" ? { link_type: "symlink" as const } : {}),
  };
}

export function loadSourceMap(
  projectPath: string,
  sourceMapPath?: string,
): LoadedSourceMap {
  const resolvedPath = resolveSourceMapCandidatePath(projectPath, sourceMapPath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      filePath: sourceMapPath ? resolvedPath : undefined,
      locatorMap: new Map(),
      entryMap: new Map(),
      entries: [],
    };
  }

  const raw = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as unknown;
  const entries: MediaSourceMapEntry[] = [];

  if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { items?: unknown[] }).items)
  ) {
    for (const item of (raw as { items: Array<Record<string, unknown>> }).items) {
      if (!item || typeof item.asset_id !== "string") continue;
      const normalized = normalizeLoadedEntry(projectPath, resolvedPath, {
        asset_id: item.asset_id,
        source_locator: typeof item.source_locator === "string" ? item.source_locator : undefined,
        local_source_path: typeof item.local_source_path === "string" ? item.local_source_path : undefined,
        link_path: typeof item.link_path === "string" ? item.link_path : undefined,
        display_name: typeof item.display_name === "string" ? item.display_name : undefined,
        kind: item.kind === "asset" || item.kind === "bgm" ? item.kind : undefined,
        link_type: item.link_type === "symlink" ? "symlink" : undefined,
      });
      if (normalized) entries.push(normalized);
    }
  } else if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { source_map?: unknown[] }).source_map)
  ) {
    for (const item of (raw as { source_map: Array<Record<string, unknown>> }).source_map) {
      if (!item || typeof item.asset_id !== "string" || typeof item.source_locator !== "string") continue;
      const normalized = normalizeLoadedEntry(projectPath, resolvedPath, {
        asset_id: item.asset_id,
        source_locator: item.source_locator,
        local_source_path: typeof item.local_source_path === "string" ? item.local_source_path : undefined,
      });
      if (normalized) entries.push(normalized);
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [assetId, locator] of Object.entries(raw)) {
      if (typeof locator !== "string") continue;
      const normalized = normalizeLoadedEntry(projectPath, resolvedPath, {
        asset_id: assetId,
        source_locator: locator,
      });
      if (normalized) entries.push(normalized);
    }
  }

  return {
    filePath: resolvedPath,
    locatorMap: new Map(entries.map((entry) => [entry.asset_id, entry.source_locator])),
    entryMap: new Map(entries.map((entry) => [entry.asset_id, entry])),
    entries,
  };
}

function looksLikeMediaPath(value: string): boolean {
  return /\.(aac|aif|aiff|flac|m4a|mp3|mov|mp4|mxf|wav)$/i.test(value.trim());
}

function findBgmPathInObject(
  value: unknown,
  inAudioContext = false,
): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    const nextAudioContext = inAudioContext || lowerKey === "bgm" || lowerKey === "music" || lowerKey === "audio";

    if (typeof child === "string") {
      const directKeyMatch = lowerKey === "bgm_path" ||
        lowerKey === "bgmpath" ||
        lowerKey === "music_path" ||
        lowerKey === "musicpath";
      const contextualPath = nextAudioContext &&
        (lowerKey === "path" || lowerKey === "file" || lowerKey === "file_path" || lowerKey === "filepath");
      if ((directKeyMatch || contextualPath) && looksLikeMediaPath(child)) {
        return child;
      }
      continue;
    }

    const nested = findBgmPathInObject(child, nextAudioContext);
    if (nested) return nested;
  }

  return undefined;
}

function findBgmAssetIdInObject(
  value: unknown,
  inAudioContext = false,
): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    const nextAudioContext = inAudioContext || lowerKey === "bgm" || lowerKey === "music" || lowerKey === "audio";

    if (typeof child === "string") {
      if (nextAudioContext && (lowerKey === "asset_id" || lowerKey === "assetid")) {
        return child;
      }
      continue;
    }

    const nested = findBgmAssetIdInObject(child, nextAudioContext);
    if (nested) return nested;
  }

  return undefined;
}

function discoverBgmPlan(projectPath: string): MediaLinkPlan | undefined {
  const briefPath = path.join(projectPath, "01_intent", "creative_brief.yaml");
  const bgmAnalysisPath = resolveBgmAnalysisPath(projectPath);

  let briefPathValue: string | undefined;
  let briefAssetId: string | undefined;
  if (fs.existsSync(briefPath)) {
    try {
      const brief = parseYaml(fs.readFileSync(briefPath, "utf-8")) as unknown;
      briefPathValue = findBgmPathInObject(brief);
      briefAssetId = findBgmAssetIdInObject(brief);
    } catch {
      // Best-effort probe only.
    }
  }

  const bgmAnalysis = readJsonIfExists<{
    music_asset?: { asset_id?: string; path?: string };
  }>(bgmAnalysisPath);
  const bgmSourcePath = bgmAnalysis?.music_asset?.path ?? briefPathValue;
  const bgmAssetId = bgmAnalysis?.music_asset?.asset_id ?? briefAssetId;

  if (!bgmSourcePath) return undefined;

  const resolvedSourcePath = path.isAbsolute(bgmSourcePath)
    ? bgmSourcePath
    : path.resolve(projectPath, bgmSourcePath);
  const displayName = path.parse(resolvedSourcePath).name || "bgm";
  const mediaDir = path.join(projectPath, MEDIA_DIR_NAME, "bgm");
  const fileName = allocateUniqueFilename(
    new Map(),
    toSafeMediaBasename(displayName, bgmAssetId ?? "bgm"),
    normalizeExt(resolvedSourcePath),
  );
  const sourceLocator = path.join(mediaDir, fileName);

  return {
    assetId: bgmAssetId,
    displayName,
    sourcePath: resolvedSourcePath,
    linkPath: sourceLocator,
    sourceLocator,
    kind: "bgm",
  };
}

export function createMediaLinks(
  opts: CreateMediaLinksOptions,
): CreateMediaLinksResult {
  const projectPath = path.resolve(opts.projectPath);
  const mediaDir = path.join(projectPath, MEDIA_DIR_NAME);
  const sourceMapPath = path.join(mediaDir, SOURCE_MAP_FILE_NAME);
  const warnings: string[] = [];

  fs.mkdirSync(mediaDir, { recursive: true });

  const rootNameCounts = new Map<string, number>();
  const plans: MediaLinkPlan[] = [];

  for (const asset of opts.assets) {
    const sourcePath = opts.sourceFileMap.get(asset.asset_id);
    if (!sourcePath) continue;

    const displayName = asset.display_name ?? path.parse(asset.filename).name ?? asset.asset_id;
    const stem = toSafeMediaBasename(displayName, `asset-${asset.asset_id}`);
    const fileName = allocateUniqueFilename(rootNameCounts, stem, normalizeExt(sourcePath));
    const sourceLocator = path.join(mediaDir, fileName);

    plans.push({
      assetId: asset.asset_id,
      displayName,
      sourcePath,
      linkPath: sourceLocator,
      sourceLocator,
      kind: "asset",
    });
  }

  const bgmPlan = discoverBgmPlan(projectPath);
  if (bgmPlan) {
    if (!fs.existsSync(bgmPlan.sourcePath)) {
      warnings.push(`BGM source missing, skipped: ${bgmPlan.sourcePath}`);
    } else {
      plans.push(bgmPlan);
      if (!bgmPlan.assetId) {
        warnings.push("BGM symlink created without asset_id; source_map.json entry was skipped.");
      }
    }
  }

  const previous = loadSourceMap(projectPath);

  for (const plan of plans) {
    if (!fs.existsSync(plan.sourcePath)) {
      warnings.push(`Source missing, skipped: ${plan.sourcePath}`);
      continue;
    }
    ensureSymlink(plan.linkPath, plan.sourcePath);
  }

  const docItems: MediaSourceMapEntry[] = plans
    .filter((plan): plan is MediaLinkPlan & { assetId: string } => !!plan.assetId && fs.existsSync(plan.sourcePath))
    .map((plan) => ({
      asset_id: plan.assetId,
      source_locator: plan.sourceLocator,
      local_source_path: plan.sourcePath,
      link_path: toPosixRel(projectPath, plan.linkPath),
      ...(plan.displayName ? { display_name: plan.displayName } : {}),
      kind: plan.kind,
      link_type: "symlink",
    }));

  const nextDoc: MediaSourceMapDoc = {
    version: "1",
    project_id: opts.projectId,
    media_dir: MEDIA_DIR_NAME,
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    items: docItems,
  };

  const nextLinkPaths = new Set(nextDoc.items.map((item) => item.link_path));
  for (const prevEntry of previous.entries) {
    if (nextLinkPaths.has(prevEntry.link_path)) continue;
    if (!prevEntry.link_path.startsWith(`${MEDIA_DIR_NAME}/`)) continue;
    removeStaleSymlink(path.resolve(projectPath, prevEntry.link_path));
  }

  atomicWriteJson(sourceMapPath, nextDoc);

  return {
    doc: nextDoc,
    sourceMapPath,
    warnings,
  };
}
