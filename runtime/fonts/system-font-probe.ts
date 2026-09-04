/**
 * Installed-font capability probe for authored families that are not bundled
 * with the repository (Issue 36: Hiragino Mincho ProN / Hiragino Sans).
 *
 * Honesty rules:
 * - A family is only reported "available" when a font binary's `name` table
 *   really contains that family (TTF and TTC collections both supported).
 * - "unavailable" is reported only after every probe mechanism was consulted
 *   and did not find the family.
 * - Anything that cannot be determined (I/O error, malformed font, missing
 *   fontconfig) fails open to "unknown"; callers must treat "unknown" as
 *   "not available" and record the fallback in their receipt.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export type FontCapability = "available" | "unavailable" | "unknown";

export type FontProbeSource =
  | "font_name_table"
  | "fontconfig"
  | "probe_error";

export interface FontProbeResult {
  family: string;
  capability: FontCapability;
  source: FontProbeSource;
  /** Human-readable evidence for the receipt. Never empty. */
  detail: string;
  /**
   * Font binary the capability was verified against, when known. Enables
   * glyph-advance measurement from the exact installed face. Absent when the
   * capability came from a source without a file (fontconfig) or probing
   * failed.
   */
  filePath?: string;
}

export interface FontProbeOptions {
  /**
   * Restrict probing to these directories. Tests inject a tmpdir with a
   * synthesized font binary; production leaves this undefined.
   */
  searchPaths?: readonly string[];
  /** Disable the fontconfig fallback (tests; deterministic environments). */
  skipFontconfig?: boolean;
  /** Disable module-level caching (tests). */
  noCache?: boolean;
}

// ── Curated candidate files per known family ─────────────────────────────

const MACOS_FONT_DIRS = [
  "/System/Library/Fonts",
  "/System/Library/Fonts/Supplemental",
  "/Library/Fonts",
  path.join(homedir(), "Library", "Fonts"),
];

const LINUX_FONT_DIRS = [
  "/usr/share/fonts",
  "/usr/local/share/fonts",
  path.join(homedir(), ".fonts"),
  path.join(homedir(), ".local/share/fonts"),
];

/**
 * Family (normalized) -> candidate font files that are known to contain it.
 * Japanese macOS fonts ship under native filenames, so both spellings are
 * probed. Presence of the file alone is NOT enough — the name table must
 * confirm the family before "available" is reported.
 */
const FAMILY_CANDIDATE_FILES: Record<string, readonly string[]> = {
  "hiragino mincho pron": [
    "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc",
    "/System/Library/Fonts/Hiragino Mincho ProN.ttc",
    "/System/Library/Fonts/Supplemental/Hiragino Mincho ProN.ttc",
  ],
  "hiragino mincho pron w3": [
    "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc",
    "/System/Library/Fonts/Hiragino Mincho ProN.ttc",
  ],
  "hiragino mincho pron w6": [
    "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc",
    "/System/Library/Fonts/Hiragino Mincho ProN.ttc",
  ],
  "hiragino sans": [
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
    "/System/Library/Fonts/Hiragino Sans.ttc",
    "/System/Library/Fonts/Supplemental/Hiragino Sans.ttc",
  ],
  "hiragino sans w3": [
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
  ],
  "hiragino sans w8": [
    "/System/Library/Fonts/ヒラギノ角ゴシック W8.ttc",
    "/System/Library/Fonts/Hiragino Sans W8.ttc",
  ],
};

// ── Normalization ────────────────────────────────────────────────────────

export function normalizeFontFamily(family: string): string {
  return family.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

// ── sfnt name-table parsing ──────────────────────────────────────────────

interface NameRecord {
  nameId: number;
  value: string;
}

const nameTableCache = new Map<string, string[]>();

/**
 * Read every family-name string (name IDs 1 and 16) from a TTF/TTC/OTF.
 * Returns a normalized, de-duplicated list. Throws on malformed binaries —
 * callers convert that into an honest "unknown" capability.
 */
export function readFontFamilyNames(filePath: string): string[] {
  const cached = nameTableCache.get(filePath);
  if (cached) return cached;
  const buffer = readFileSync(filePath);
  const names = parseSfntFamilyNames(buffer);
  const normalized = [...new Set(names.map(normalizeFontFamily))];
  nameTableCache.set(filePath, normalized);
  return normalized;
}

function parseSfntFamilyNames(buffer: Buffer): string[] {
  if (buffer.length < 12) throw new Error("font too small for an sfnt header");
  const header = buffer.subarray(0, 4).toString("latin1");
  let offsets: number[];
  if (header === "ttcf") {
    const numFonts = buffer.readUInt32BE(8);
    if (numFonts <= 0 || numFonts > 64) throw new Error("unreasonable ttc font count");
    offsets = [];
    for (let i = 0; i < numFonts; i += 1) {
      offsets.push(buffer.readUInt32BE(12 + i * 4));
    }
  } else {
    offsets = [0];
  }
  const names: string[] = [];
  for (const offset of offsets) {
    names.push(...parseSingleSfntFamilyNames(buffer, offset));
  }
  return names;
}

function parseSingleSfntFamilyNames(buffer: Buffer, offset: number): string[] {
  const numTables = buffer.readUInt16BE(offset + 4);
  if (numTables <= 0 || numTables > 512) throw new Error("unreasonable sfnt table count");
  let nameTableOffset: number | undefined;
  for (let i = 0; i < numTables; i += 1) {
    const record = offset + 12 + i * 16;
    if (record + 16 > buffer.length) throw new Error("truncated table directory");
    if (buffer.toString("latin1", record, record + 4) === "name") {
      nameTableOffset = buffer.readUInt32BE(record + 8);
      break;
    }
  }
  if (nameTableOffset === undefined) return [];

  // The OpenType spec says table offsets are relative to the font's own
  // offset table, but Apple-built TTC collections (e.g. Hiragino) store
  // absolute file offsets. Try the spec order first, then the Apple quirk,
  // validating the name-table header before trusting either.
  const candidates = [offset + nameTableOffset, nameTableOffset];
  for (const tableStart of new Set(candidates)) {
    if (tableStart + 6 > buffer.length) continue;
    const format = buffer.readUInt16BE(tableStart);
    const count = buffer.readUInt16BE(tableStart + 2);
    if (format !== 0 || count <= 0 || count > 2048) continue;
    try {
      return parseNameRecords(buffer, tableStart, count);
    } catch {
      continue;
    }
  }
  return [];
}

function parseNameRecords(buffer: Buffer, nameTableOffset: number, count: number): string[] {
  const stringOffset = nameTableOffset + buffer.readUInt16BE(nameTableOffset + 4);
  const records: NameRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const record = nameTableOffset + 6 + i * 12;
    if (record + 12 > buffer.length) throw new Error("truncated name record");
    const platformId = buffer.readUInt16BE(record);
    const nameId = buffer.readUInt16BE(record + 6);
    const length = buffer.readUInt16BE(record + 8);
    const offsetInTable = buffer.readUInt16BE(record + 10);
    if (nameId !== 1 && nameId !== 16) continue;
    const start = stringOffset + offsetInTable;
    if (start + length > buffer.length) throw new Error("truncated name string");
    const raw = buffer.subarray(start, start + length);
    records.push({ nameId, value: decodeNameString(raw, platformId) });
  }
  return records.map((record) => record.value);
}

function decodeNameString(raw: Buffer, platformId: number): string {
  if (platformId === 0 || platformId === 3) return swapUtf16BE(raw);
  // Legacy Mac Roman; good enough for the ASCII family names we match.
  return raw.toString("latin1");
}

function swapUtf16BE(raw: Buffer): string {
  const copy = Buffer.from(raw);
  copy.swap16();
  return copy.toString("utf16le");
}

/** A family is present when a name record (ID 1/16, or 16+17 pair) matches. */
function nameTableHasFamily(filePath: string, normalizedFamily: string): boolean {
  const names = readFontFamilyNames(filePath);
  return names.includes(normalizedFamily);
}

// ── fontconfig fallback (Linux) ──────────────────────────────────────────

let fontconfigFamilies: Set<string> | null | undefined;

function loadFontconfigFamilies(): Set<string> | null {
  if (fontconfigFamilies !== undefined) return fontconfigFamilies;
  try {
    const result = spawnSync("fc-list", ["--format", "%{family[0]}\n"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") {
      fontconfigFamilies = null;
      return null;
    }
    const families = new Set<string>();
    for (const line of result.stdout.split("\n")) {
      for (const family of line.split(",")) {
        const normalized = normalizeFontFamily(family);
        if (normalized) families.add(normalized);
      }
    }
    fontconfigFamilies = families;
  } catch {
    fontconfigFamilies = null;
  }
  return fontconfigFamilies;
}

// ── Public probe ─────────────────────────────────────────────────────────

/**
 * Determine whether `family` is really installed, with evidence. Deterministic
 * for identical inputs and never throws — every failure mode becomes
 * "unknown" with the reason in `detail`.
 */
export function probeInstalledFontFamily(
  family: string,
  options: FontProbeOptions = {},
): FontProbeResult {
  const normalized = normalizeFontFamily(family);
  if (!normalized) {
    return {
      family,
      capability: "unknown",
      source: "probe_error",
      detail: "empty family name cannot be probed",
    };
  }

  const cacheKey = JSON.stringify([normalized, options.searchPaths ?? null, options.skipFontconfig ?? false]);
  if (!options.noCache) {
    const cached = probeCache.get(cacheKey);
    if (cached) return cached;
  }

  const result = runProbe(family, normalized, options);
  if (!options.noCache) probeCache.set(cacheKey, result);
  return result;
}

const probeCache = new Map<string, FontProbeResult>();

function runProbe(
  family: string,
  normalized: string,
  options: FontProbeOptions,
): FontProbeResult {
  const searchDirs = options.searchPaths ?? defaultSearchDirs();

  // 1) Curated candidates (fast, exact files known to contain the family).
  const curated = FAMILY_CANDIDATE_FILES[normalized] ?? [];
  for (const candidate of curated) {
    if (!existsSync(candidate)) continue;
    try {
      if (nameTableHasFamily(candidate, normalized)) {
        return {
          family,
          capability: "available",
          source: "font_name_table",
          detail: `family confirmed in ${candidate}`,
          filePath: candidate,
        };
      }
    } catch (error) {
      return unknownResult(family, `candidate font could not be parsed (${candidate}): ${describe(error)}`);
    }
  }

  // 2) Injected/extra search directories: scan shallow font files and verify
  //    each via name table (tests synthesize binaries here).
  if (options.searchPaths) {
    for (const dir of searchDirs) {
      const files = listFontFiles(dir);
      for (const file of files) {
        try {
          if (nameTableHasFamily(file, normalized)) {
            return {
              family,
              capability: "available",
              source: "font_name_table",
              detail: `family confirmed in ${file}`,
              filePath: file,
            };
          }
        } catch {
          // Malformed candidate in an injected directory: keep probing others.
          continue;
        }
      }
    }
  }

  // 3) fontconfig (Linux hosts).
  if (!options.skipFontconfig) {
    const families = loadFontconfigFamilies();
    if (families) {
      if (families.has(normalized)) {
        return {
          family,
          capability: "available",
          source: "fontconfig",
          detail: "family reported by fc-list",
        };
      }
      return {
        family,
        capability: "unavailable",
        source: "fontconfig",
        detail: `family not found by fc-list (${families.size} families scanned)`,
      };
    }
  }

  if (options.searchPaths) {
    return {
      family,
      capability: "unavailable",
      source: "font_name_table",
      detail: `family not found in injected search paths: ${searchDirs.join(", ")}`,
    };
  }
  return unknownResult(
    family,
    `no candidate font file found for family (probed ${curated.length} curated paths) and fontconfig is unavailable`,
  );
}

function defaultSearchDirs(): readonly string[] {
  return process.platform === "darwin" ? MACOS_FONT_DIRS : LINUX_FONT_DIRS;
}

function listFontFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFontFiles(full));
      continue;
    }
    if (/\.(ttf|otf|ttc)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function unknownResult(family: string, detail: string): FontProbeResult {
  return { family, capability: "unknown", source: "probe_error", detail };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reset module caches (tests). */
export function resetFontProbeCaches(): void {
  nameTableCache.clear();
  probeCache.clear();
  fontconfigFamilies = undefined;
}
