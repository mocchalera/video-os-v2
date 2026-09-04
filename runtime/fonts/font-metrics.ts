/**
 * Real glyph-advance text measurement from installed font binaries (Issue 36
 * follow-up: replaces the naive 0.5em-per-Latin display-unit model whenever
 * the resolved font binary is available).
 *
 * Parses the sfnt tables needed for horizontal advance measurement:
 * - `head`  -> unitsPerEm
 * - `maxp`  -> numGlyphs (bounds checks)
 * - `cmap`  -> code point to glyph id (formats 0, 4, 12; platform 0/3)
 * - `hhea`  -> numberOfHMetrics
 * - `hmtx`  -> per-glyph advance width
 *
 * TTF, OTF, and TTC collections are supported. TTC faces are parsed
 * SEPARATELY: measurements always come from one exact face (selected by
 * index) and cmaps from multiple faces are NEVER merged — a W3 face's
 * advances must not silently describe a W6 face's rendering. Every parse
 * failure throws — callers must fail open to the display-unit estimate
 * rather than guessing. Results are cached per (binary, face index).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface FontFaceInfo {
  index: number;
  /** Normalized family names (name IDs 1 and 16) of this exact face. */
  familyNames: string[];
  /** PostScript name (name ID 6) of this exact face, when present. */
  postScriptName?: string;
}

interface FontMetrics {
  unitsPerEm: number;
  numGlyphs: number;
  numberOfHMetrics: number;
  /** glyph id -> advance width (font units) */
  advances: number[];
  /** code point -> glyph id */
  cmap: Map<number, number>;
  notdefAdvance: number;
}

const metricsCache = new Map<string, FontMetrics>();
const facesCache = new Map<string, FontFaceInfo[]>();

/** SHA-256 of a font binary (identity evidence for plan/receipt binding). */
export function hashFontFile(filePath: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
}

/** Reset the metrics caches (tests). */
export function resetFontMetricsCaches(): void {
  metricsCache.clear();
  facesCache.clear();
}

function faceOffsets(buffer: Buffer, filePath: string): number[] {
  if (buffer.length < 12) throw new Error(`font too small: ${filePath}`);
  const tag = buffer.subarray(0, 4).toString("latin1");
  if (tag !== "ttcf") return [0];
  const numFonts = buffer.readUInt32BE(8);
  if (numFonts <= 0 || numFonts > 64) throw new Error(`unreasonable ttc font count: ${filePath}`);
  const offsets: number[] = [];
  for (let i = 0; i < numFonts; i += 1) offsets.push(buffer.readUInt32BE(12 + i * 4));
  return offsets;
}

/**
 * Enumerate the faces of a font binary with per-face identity (families and
 * PostScript name). Never merges faces: each entry describes exactly one
 * face of the collection.
 */
export function listFontFaces(filePath: string): FontFaceInfo[] {
  const cached = facesCache.get(filePath);
  if (cached) return cached;
  const buffer = readFileSync(filePath);
  const faces = faceOffsets(buffer, filePath).map((offset, index) => {
    const tables = readTableDirectory(buffer, offset, filePath);
    const nameRecords = readNameRecords(buffer, offset, tables, filePath);
    const familyNames = [
      ...new Set(nameRecords
        .filter((record) => record.nameId === 1 || record.nameId === 16)
        .map((record) => record.value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase())),
    ];
    const postScript = nameRecords.find((record) => record.nameId === 6)?.value;
    return { index, familyNames, ...(postScript ? { postScriptName: postScript } : {}) };
  });
  facesCache.set(filePath, faces);
  return faces;
}

/**
 * Resolve the exact face index of `family` inside a font binary. Throws when
 * no face carries the family — callers must not guess a face.
 */
export function resolveFontFaceIndex(filePath: string, family: string): { index: number; face: FontFaceInfo } {
  const normalized = family.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const faces = listFontFaces(filePath);
  const face = faces.find((candidate) => candidate.familyNames.includes(normalized));
  if (!face) {
    throw new Error(`family ${family} not found in any face of ${filePath} (${faces.length} faces)`);
  }
  return { index: face.index, face };
}

function loadFontMetrics(filePath: string, faceIndex: number): FontMetrics {
  const cacheKey = `${filePath}#${faceIndex}`;
  const cached = metricsCache.get(cacheKey);
  if (cached) return cached;
  const buffer = readFileSync(filePath);
  const offsets = faceOffsets(buffer, filePath);
  if (faceIndex < 0 || faceIndex >= offsets.length) {
    throw new Error(`face index ${faceIndex} out of range for ${filePath} (${offsets.length} faces)`);
  }
  const metrics = parseSingleFont(buffer, offsets[faceIndex], filePath);
  metricsCache.set(cacheKey, metrics);
  return metrics;
}

function readTableDirectory(
  buffer: Buffer,
  offset: number,
  filePath: string,
): Map<string, { offset: number; length: number }> {
  const numTables = buffer.readUInt16BE(offset + 4);
  if (numTables <= 0 || numTables > 512) throw new Error(`unreasonable table count: ${filePath}`);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i += 1) {
    const record = offset + 12 + i * 16;
    if (record + 16 > buffer.length) throw new Error(`truncated table directory: ${filePath}`);
    const tag = buffer.toString("latin1", record, record + 4);
    tables.set(tag, { offset: buffer.readUInt32BE(record + 8), length: buffer.readUInt32BE(record + 12) });
  }
  return tables;
}

function parseSingleFont(buffer: Buffer, offset: number, filePath: string): FontMetrics {
  const tables = readTableDirectory(buffer, offset, filePath);
  for (const required of ["head", "maxp", "hhea", "hmtx", "cmap"]) {
    if (!tables.has(required)) throw new Error(`missing ${required} table: ${filePath}`);
  }

  const head = tables.get("head")!;
  const unitsPerEm = buffer.readUInt16BE(head.offset + 18);
  if (unitsPerEm <= 0) throw new Error(`invalid unitsPerEm: ${filePath}`);

  const maxp = tables.get("maxp")!;
  const numGlyphs = buffer.readUInt16BE(maxp.offset + 4);

  const hhea = tables.get("hhea")!;
  const numberOfHMetrics = buffer.readUInt16BE(hhea.offset + 34);
  if (numberOfHMetrics <= 0 || numberOfHMetrics > numGlyphs + 1) {
    throw new Error(`invalid numberOfHMetrics: ${filePath}`);
  }

  const hmtx = tables.get("hmtx")!;
  const advances: number[] = [];
  for (let i = 0; i < numGlyphs; i += 1) {
    if (i < numberOfHMetrics) {
      const entry = hmtx.offset + i * 4;
      if (entry + 4 > buffer.length) throw new Error(`truncated hmtx: ${filePath}`);
      advances.push(buffer.readUInt16BE(entry));
    } else {
      // Monotone: glyphs beyond numberOfHMetrics repeat the last advance.
      const last = hmtx.offset + (numberOfHMetrics - 1) * 4;
      advances.push(buffer.readUInt16BE(last));
    }
  }

  const cmapOffset = resolveCmapSubtable(buffer, tables.get("cmap")!, filePath);
  const cmap = parseCmapSubtable(buffer, cmapOffset, filePath);
  return { unitsPerEm, numGlyphs, numberOfHMetrics, advances, cmap, notdefAdvance: advances[0] ?? 0 };
}

interface NameRecord {
  nameId: number;
  value: string;
}

function readNameRecords(
  buffer: Buffer,
  faceOffset: number,
  tables: Map<string, { offset: number; length: number }>,
  filePath: string,
): NameRecord[] {
  const nameTable = tables.get("name");
  if (!nameTable) throw new Error(`no name table: ${filePath}`);
  // The directory entry offset is face-relative per the OpenType spec but
  // absolute-from-file-start for Apple-built TTC files. Validate both
  // candidates against the name-table header and use whichever parses.
  const seen = new Set<number>();
  for (const tableStart of [faceOffset + nameTable.offset, nameTable.offset]) {
    if (seen.has(tableStart)) continue;
    seen.add(tableStart);
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
  throw new Error(`no valid name table: ${filePath}`);
}

function parseNameRecords(buffer: Buffer, nameTableOffset: number, count: number): NameRecord[] {
  const stringOffset = nameTableOffset + buffer.readUInt16BE(nameTableOffset + 4);
  const records: NameRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const record = nameTableOffset + 6 + i * 12;
    if (record + 12 > buffer.length) throw new Error("truncated name record");
    const platformId = buffer.readUInt16BE(record);
    const nameId = buffer.readUInt16BE(record + 6);
    const length = buffer.readUInt16BE(record + 8);
    const offsetInTable = buffer.readUInt16BE(record + 10);
    if (nameId !== 1 && nameId !== 6 && nameId !== 16) continue;
    const start = stringOffset + offsetInTable;
    if (start + length > buffer.length) throw new Error("truncated name string");
    const raw = buffer.subarray(start, start + length);
    records.push({ nameId, value: decodeNameString(raw, platformId) });
  }
  return records;
}

function decodeNameString(raw: Buffer, platformId: number): string {
  if (platformId === 0 || platformId === 3) {
    const copy = Buffer.from(raw);
    copy.swap16();
    return copy.toString("utf16le");
  }
  // Legacy Mac Roman; good enough for the ASCII family names we match.
  return raw.toString("latin1");
}

/** Pick the best Unicode subtable: 12 > 4 > 0 (platform 0/3 only). */
function resolveCmapSubtable(
  buffer: Buffer,
  cmap: { offset: number; length: number },
  filePath: string,
): number {
  const numTables = buffer.readUInt16BE(cmap.offset + 2);
  let best: { rank: number; offset: number } | undefined;
  for (let i = 0; i < numTables; i += 1) {
    const record = cmap.offset + 4 + i * 8;
    if (record + 8 > buffer.length) throw new Error(`truncated cmap records: ${filePath}`);
    const platformId = buffer.readUInt16BE(record);
    const subOffset = cmap.offset + buffer.readUInt32BE(record + 4);
    if (platformId !== 0 && platformId !== 3) continue;
    const format = buffer.readUInt16BE(subOffset);
    const rank = format === 12 ? 3 : format === 4 ? 2 : format === 0 ? 1 : 0;
    if (rank === 0) continue;
    if (!best || rank > best.rank) best = { rank, offset: subOffset };
  }
  if (!best) throw new Error(`no supported cmap subtable: ${filePath}`);
  return best.offset;
}

function parseCmapSubtable(buffer: Buffer, subOffset: number, filePath: string): Map<number, number> {
  const format = buffer.readUInt16BE(subOffset);
  const map = new Map<number, number>();
  if (format === 4) {
    const segCountX2 = buffer.readUInt16BE(subOffset + 6);
    const segCount = segCountX2 / 2;
    const endCodes = subOffset + 14;
    const startCodes = endCodes + segCountX2 + 2;
    const idDeltas = startCodes + segCountX2;
    const idRangeOffsets = idDeltas + segCountX2;
    for (let seg = 0; seg < segCount; seg += 1) {
      const end = buffer.readUInt16BE(endCodes + seg * 2);
      const start = buffer.readUInt16BE(startCodes + seg * 2);
      const delta = buffer.readInt16BE(idDeltas + seg * 2);
      const rangeOffset = buffer.readUInt16BE(idRangeOffsets + seg * 2);
      for (let codePoint = start; codePoint <= end && codePoint !== 0xffff; codePoint += 1) {
        let glyphId: number;
        if (rangeOffset === 0) {
          glyphId = (codePoint + delta) & 0xffff;
        } else {
          const glyphAddr = idRangeOffsets + seg * 2 + rangeOffset + (codePoint - start) * 2;
          if (glyphAddr + 2 > buffer.length) throw new Error(`truncated cmap glyph id: ${filePath}`);
          glyphId = buffer.readUInt16BE(glyphAddr);
          if (glyphId !== 0) glyphId = (glyphId + delta) & 0xffff;
        }
        if (glyphId !== 0) map.set(codePoint, glyphId);
      }
    }
    return map;
  }
  if (format === 12) {
    const numGroups = buffer.readUInt32BE(subOffset + 12);
    for (let group = 0; group < numGroups; group += 1) {
      const record = subOffset + 16 + group * 12;
      if (record + 12 > buffer.length) throw new Error(`truncated cmap group: ${filePath}`);
      const startCharCode = buffer.readUInt32BE(record);
      const endCharCode = buffer.readUInt32BE(record + 4);
      const startGlyphId = buffer.readUInt32BE(record + 8);
      if (endCharCode - startCharCode > 1_000_000) throw new Error(`unreasonable cmap group: ${filePath}`);
      for (let codePoint = startCharCode; codePoint <= endCharCode; codePoint += 1) {
        map.set(codePoint, startGlyphId + (codePoint - startCharCode));
      }
    }
    return map;
  }
  if (format === 0) {
    for (let codePoint = 0; codePoint < 256; codePoint += 1) {
      const glyphId = buffer.readUInt8(subOffset + 6 + codePoint);
      if (glyphId !== 0) map.set(codePoint, glyphId);
    }
    return map;
  }
  throw new Error(`unsupported cmap format ${format}: ${filePath}`);
}

/**
 * Measure `text` advance width in px at `fontSizePx` using ONE exact face.
 * Characters absent from the face resolve to the .notdef advance (never
 * silently narrowed). Deterministic and cached per (binary, face index).
 */
export function measureTextAdvancePx(
  text: string,
  fontPath: string,
  fontSizePx: number,
  faceIndex = 0,
): number {
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) {
    throw new Error(`fontSizePx must be positive: ${fontSizePx}`);
  }
  const metrics = loadFontMetrics(fontPath, faceIndex);
  let units = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    const glyphId = metrics.cmap.get(codePoint) ?? 0;
    const advance = glyphId < metrics.advances.length
      ? metrics.advances[glyphId]!
      : metrics.notdefAdvance;
    units += advance;
  }
  return (units / metrics.unitsPerEm) * fontSizePx;
}
