import { readFileSync } from "node:fs";

type GlyphChecker = (codePoint: number) => boolean;

/**
 * Return the authored characters that resolve to glyph 0 in every supported
 * Unicode cmap subtable. This reads the bundled TTF/OTF directly, so approval
 * does not depend on a machine's installed-font fallback behavior.
 */
export function findMissingFontGlyphs(
  fontPath: string,
  values: Iterable<string>,
): string[] {
  const font = readFileSync(fontPath);
  const checkers = unicodeCmapCheckers(font);
  if (checkers.length === 0) {
    throw new Error(`font has no supported Unicode cmap table: ${fontPath}`);
  }
  const characters = new Map<number, string>();
  for (const value of values) {
    for (const character of value) {
      if (/[\r\n\t]/u.test(character)) continue;
      characters.set(character.codePointAt(0)!, character);
    }
  }
  return [...characters.entries()]
    .sort(([left], [right]) => left - right)
    .filter(([codePoint]) => !checkers.some((checker) => checker(codePoint)))
    .map(([, character]) => character);
}

function unicodeCmapCheckers(font: Buffer): GlyphChecker[] {
  if (font.length < 12) return [];
  const numTables = font.readUInt16BE(4);
  let cmapOffset: number | undefined;
  let cmapLength: number | undefined;
  for (let index = 0; index < numTables; index += 1) {
    const recordOffset = 12 + index * 16;
    if (recordOffset + 16 > font.length) break;
    if (font.toString("ascii", recordOffset, recordOffset + 4) !== "cmap") {
      continue;
    }
    cmapOffset = font.readUInt32BE(recordOffset + 8);
    cmapLength = font.readUInt32BE(recordOffset + 12);
    break;
  }
  if (
    cmapOffset === undefined ||
    cmapLength === undefined ||
    cmapOffset + cmapLength > font.length ||
    cmapOffset + 4 > font.length
  ) {
    return [];
  }

  const numSubtables = font.readUInt16BE(cmapOffset + 2);
  const checkers: GlyphChecker[] = [];
  const seenOffsets = new Set<number>();
  for (let index = 0; index < numSubtables; index += 1) {
    const recordOffset = cmapOffset + 4 + index * 8;
    if (recordOffset + 8 > cmapOffset + cmapLength) break;
    const platformId = font.readUInt16BE(recordOffset);
    const encodingId = font.readUInt16BE(recordOffset + 2);
    if (
      platformId !== 0 &&
      !(platformId === 3 && (encodingId === 1 || encodingId === 10))
    ) {
      continue;
    }
    const subtableOffset = cmapOffset + font.readUInt32BE(recordOffset + 4);
    if (
      seenOffsets.has(subtableOffset) ||
      subtableOffset + 2 > cmapOffset + cmapLength
    ) {
      continue;
    }
    seenOffsets.add(subtableOffset);
    const format = font.readUInt16BE(subtableOffset);
    const checker = format === 12
      ? format12Checker(font, subtableOffset, cmapOffset + cmapLength)
      : format === 4
      ? format4Checker(font, subtableOffset, cmapOffset + cmapLength)
      : null;
    if (checker) checkers.push(checker);
  }
  return checkers;
}

function format12Checker(
  font: Buffer,
  offset: number,
  cmapEnd: number,
): GlyphChecker | null {
  if (offset + 16 > cmapEnd) return null;
  const length = font.readUInt32BE(offset + 4);
  const tableEnd = Math.min(cmapEnd, offset + length);
  const groupCount = font.readUInt32BE(offset + 12);
  const groupsOffset = offset + 16;
  if (groupsOffset + groupCount * 12 > tableEnd) return null;

  return (codePoint: number): boolean => {
    let low = 0;
    let high = groupCount - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const groupOffset = groupsOffset + middle * 12;
      const start = font.readUInt32BE(groupOffset);
      const end = font.readUInt32BE(groupOffset + 4);
      if (codePoint < start) {
        high = middle - 1;
      } else if (codePoint > end) {
        low = middle + 1;
      } else {
        const startGlyph = font.readUInt32BE(groupOffset + 8);
        return startGlyph + codePoint - start !== 0;
      }
    }
    return false;
  };
}

function format4Checker(
  font: Buffer,
  offset: number,
  cmapEnd: number,
): GlyphChecker | null {
  if (offset + 14 > cmapEnd) return null;
  const length = font.readUInt16BE(offset + 2);
  const tableEnd = Math.min(cmapEnd, offset + length);
  const segmentCount = font.readUInt16BE(offset + 6) / 2;
  const endCodeOffset = offset + 14;
  const startCodeOffset = endCodeOffset + segmentCount * 2 + 2;
  const deltaOffset = startCodeOffset + segmentCount * 2;
  const rangeOffset = deltaOffset + segmentCount * 2;
  if (
    !Number.isInteger(segmentCount) ||
    segmentCount <= 0 ||
    rangeOffset + segmentCount * 2 > tableEnd
  ) {
    return null;
  }

  return (codePoint: number): boolean => {
    if (codePoint > 0xffff) return false;
    for (let index = 0; index < segmentCount; index += 1) {
      const end = font.readUInt16BE(endCodeOffset + index * 2);
      if (codePoint > end) continue;
      const start = font.readUInt16BE(startCodeOffset + index * 2);
      if (codePoint < start) return false;
      const delta = font.readInt16BE(deltaOffset + index * 2);
      const rangeEntryOffset = rangeOffset + index * 2;
      const glyphRangeOffset = font.readUInt16BE(rangeEntryOffset);
      if (glyphRangeOffset === 0) {
        return ((codePoint + delta) & 0xffff) !== 0;
      }
      const glyphOffset =
        rangeEntryOffset +
        glyphRangeOffset +
        (codePoint - start) * 2;
      if (glyphOffset + 2 > tableEnd) return false;
      const glyph = font.readUInt16BE(glyphOffset);
      return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
    }
    return false;
  };
}
