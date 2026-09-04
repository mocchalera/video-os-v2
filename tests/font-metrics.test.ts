import { describe, expect, it } from "vitest";
import { measureTextAdvancePx, resetFontMetricsCaches, resolveFontFaceIndex } from "../runtime/fonts/font-metrics.js";
import { resolveBundledFontPaths } from "../runtime/fonts/bundled-font.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const bundled = resolveBundledFontPaths();

describe("glyph-advance font metrics", () => {
  it("measures CJK glyphs at a full em on the bundled faces", () => {
    for (const face of [bundled.fontPath, bundled.assBoldFontPath, bundled.assHeavyFontPath]) {
      expect(measureTextAdvancePx("夜夜夜夜", face, 100)).toBeCloseTo(400, 0);
    }
  });

  it("does not collapse hostile Latin to 0.5em per character", () => {
    const wide = measureTextAdvancePx("WWWWWWWWWW", bundled.assBoldFontPath, 100);
    const narrow = measureTextAdvancePx("iiiiiiiiii", bundled.assBoldFontPath, 100);
    // the retired display-unit model claimed both were exactly 500px
    expect(wide).toBeGreaterThan(700);
    expect(narrow).toBeLessThan(450);
    expect(wide).toBeGreaterThan(narrow * 2);
  });

  it("is deterministic and cached per binary", () => {
    resetFontMetricsCaches();
    const first = measureTextAdvancePx("AVATARWORLD", bundled.assHeavyFontPath, 116);
    const second = measureTextAdvancePx("AVATARWORLD", bundled.assHeavyFontPath, 116);
    expect(first).toBe(second);
    expect(first).toBeGreaterThan(0);
  });

  it("scales linearly with font size", () => {
    const at50 = measureTextAdvancePx("夜が降る", bundled.assBoldFontPath, 50);
    const at100 = measureTextAdvancePx("夜が降る", bundled.assBoldFontPath, 100);
    expect(at100).toBeCloseTo(at50 * 2, 5);
  });

  it("throws on non-font content instead of guessing", () => {
    const broken = `${bundled.fontsDir}/OFL.txt`;
    expect(() => measureTextAdvancePx("夜", broken, 100)).toThrow();
  });
});

// ── TTC exact-face selection (Sol audit: never merge faces, never misbind) ──

interface FaceSpec {
  family: string;
  postscript: string;
  /** advance width in font units for the glyph 'W' */
  advanceW: number;
}

/**
 * Build a minimal but fully-parsed sfnt (head/maxp/hhea/hmtx/cmap/name) so
 * the metrics parser can read real advances. Glyph map: 'A'..'i' via one
 * format-4 segment, glyphId = codePoint - 0x40; 'W' (0x57) gets
 * `advanceW`, all other mapped glyphs get 600.
 */
function makeSfntFull(face: FaceSpec): Buffer {
  const upm = 1000;
  const firstCode = 0x41; // A
  const lastCode = 0x69; // i
  const numGlyphs = lastCode - firstCode + 2; // + .notdef
  const wGlyph = 0x57 - 0x40; // 'W'

  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(6, 4); // head, maxp, hhea, hmtx, cmap, name
  const dir = Buffer.alloc(16 * 6);
  let dataOffset = 12 + 16 * 6;
  const tables: Array<[string, Buffer]> = [];
  const place = (tag: string, data: Buffer): void => {
    tables.push([tag, data]);
  };

  // head
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(upm, 18);
  head.writeInt16BE(0, 20);
  place("head", head);

  // maxp
  const maxp = Buffer.alloc(6);
  maxp.writeUInt16BE(numGlyphs, 4);
  place("maxp", maxp);

  // hhea
  const hhea = Buffer.alloc(36);
  hhea.writeUInt16BE(numGlyphs, 34);
  place("hhea", hhea);

  // hmtx: glyph 0..numGlyphs-1
  const hmtx = Buffer.alloc(numGlyphs * 4);
  for (let g = 0; g < numGlyphs; g += 1) {
    hmtx.writeUInt16BE(g === wGlyph ? face.advanceW : 600, g * 4);
  }
  place("hmtx", hmtx);

  // cmap: container (version, numTables, one platform-3 record) + format 4
  const segCount = 2; // mapped segment + 0xffff terminator
  const subLength = 14 + segCount * 2 * 4 + 2;
  const cmap = Buffer.alloc(12 + subLength);
  cmap.writeUInt16BE(0, 0); // version
  cmap.writeUInt16BE(1, 2); // numTables
  cmap.writeUInt16BE(3, 4); // platformId 3
  cmap.writeUInt16BE(1, 6); // encodingId 1
  cmap.writeUInt32BE(12, 8); // subtable offset
  const sub = 12;
  cmap.writeUInt16BE(4, sub); // format 4
  cmap.writeUInt16BE(subLength, sub + 2);
  cmap.writeUInt16BE(0, sub + 4); // language
  cmap.writeUInt16BE(segCount * 2, sub + 6); // segCountX2
  cmap.writeUInt16BE(segCount * 2, sub + 8); // searchRange
  cmap.writeUInt16BE(1, sub + 10); // entrySelector
  cmap.writeUInt16BE(0, sub + 12); // rangeShift
  const endCodes = sub + 14;
  const reservedPad = endCodes + segCount * 2;
  const startCodes = reservedPad + 2;
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;
  cmap.writeUInt16BE(lastCode, endCodes);
  cmap.writeUInt16BE(0xffff, endCodes + 2);
  cmap.writeUInt16BE(0, reservedPad);
  cmap.writeUInt16BE(firstCode, startCodes);
  cmap.writeUInt16BE(0xffff, startCodes + 2);
  cmap.writeInt16BE(-0x40, idDeltas); // glyph = code - 0x40
  cmap.writeInt16BE(1, idDeltas + 2);
  cmap.writeUInt16BE(0, idRangeOffsets);
  cmap.writeUInt16BE(0, idRangeOffsets + 2);
  place("cmap", cmap);

  // name: IDs 1 (family), 6 (postscript), 16 (preferred family) UTF-16BE
  const strings: Buffer[] = [];
  const records: Array<{ platform: number; nameId: number; value: string }> = [
    { platform: 3, nameId: 1, value: face.family },
    { platform: 3, nameId: 6, value: face.postscript },
    { platform: 3, nameId: 16, value: face.family },
  ];
  let stringData = Buffer.alloc(0);
  const offsets: Array<{ record: Buffer; at: number }> = [];
  const nameCount = records.length;
  const nameHeader = Buffer.alloc(6 + 12 * nameCount);
  nameHeader.writeUInt16BE(0, 0);
  nameHeader.writeUInt16BE(nameCount, 2);
  nameHeader.writeUInt16BE(6 + 12 * nameCount, 4);
  let stringCursor = 0;
  records.forEach((entry, i) => {
    const bytes = Buffer.from(entry.value, "utf16le").swap16();
    strings.push(bytes);
    nameHeader.writeUInt16BE(entry.platform, 6 + i * 12);
    nameHeader.writeUInt16BE(1, 6 + i * 12 + 2); // encoding
    nameHeader.writeUInt16BE(0x409, 6 + i * 12 + 4); // language
    nameHeader.writeUInt16BE(entry.nameId, 6 + i * 12 + 6);
    nameHeader.writeUInt16BE(bytes.length, 6 + i * 12 + 8);
    nameHeader.writeUInt16BE(stringCursor, 6 + i * 12 + 10);
    stringCursor += bytes.length;
    void offsets;
  });
  stringData = Buffer.concat(strings);
  place("name", Buffer.concat([nameHeader, stringData]));

  // lay out tables
  for (const [tag, data] of tables) {
    const idx = tables.findIndex(([t]) => t === tag);
    dir.write(tag, idx * 16, "latin1");
    dir.writeUInt32BE(dataOffset, idx * 16 + 8);
    dir.writeUInt32BE(data.length, idx * 16 + 12);
    dataOffset += data.length;
  }
  return Buffer.concat([header, dir, ...tables.map(([, d]) => d)]);
}

function makeTtcTwoFace(faceA: Buffer, faceB: Buffer): Buffer {
  // embed each face at its new base and REBASE its absolute table offsets
  const rebase = (face: Buffer, base: number): Buffer => {
    const copy = Buffer.from(face);
    const numTables = copy.readUInt16BE(4);
    for (let i = 0; i < numTables; i += 1) {
      const rec = 12 + i * 16;
      copy.writeUInt32BE(copy.readUInt32BE(rec + 8) + base, rec + 8);
    }
    return copy;
  };
  const header = Buffer.alloc(12);
  header.write("ttcf", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(2, 8);
  const offsetA = Buffer.alloc(4);
  offsetA.writeUInt32BE(20, 0);
  const offsetB = Buffer.alloc(4);
  offsetB.writeUInt32BE(20 + faceA.length, 0);
  const rebasedA = rebase(faceA, 20);
  const rebasedB = rebase(faceB, 20 + faceA.length);
  return Buffer.concat([header, offsetA, offsetB, rebasedA, rebasedB]);
}

describe("TTC exact-face selection (W3/W6 mismatch proof)", () => {
  it("selects the exact requested face and never merges advances", () => {
    const ttcPath = path.join(os.tmpdir(), `vos-ttc-${Date.now()}.ttc`);
    const ttc = makeTtcTwoFace(
      makeSfntFull({ family: "Test Face A", postscript: "TestFaceA-W3", advanceW: 600 }),
      makeSfntFull({ family: "Test Face B", postscript: "TestFaceB-W6", advanceW: 1000 }),
    );
    fs.writeFileSync(ttcPath, ttc);
    try {
      const a = resolveFontFaceIndex(ttcPath, "Test Face A");
      const b = resolveFontFaceIndex(ttcPath, "Test Face B");
      expect(a.index).toBe(0);
      expect(b.index).toBe(1);
      expect(a.face.postScriptName).toBe("TestFaceA-W3");
      expect(b.face.postScriptName).toBe("TestFaceB-W6");
      // the same string measures differently per face: no cmap/advance merge
      const wA = measureTextAdvancePx("WWWW", ttcPath, 100, a.index);
      const wB = measureTextAdvancePx("WWWW", ttcPath, 100, b.index);
      expect(wA).toBeCloseTo(240, 0);
      expect(wB).toBeCloseTo(400, 0);
      // an unknown family never silently binds to another face
      expect(() => resolveFontFaceIndex(ttcPath, "Test Face C")).toThrow(/not found in any face/);
    } finally {
      fs.rmSync(ttcPath, { force: true });
    }
  });

  it("binds distinct faces for the real Hiragino W3/W6 pairing when installed", () => {
    const ttc = "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc";
    if (!fs.existsSync(ttc)) {
      console.warn("Hiragino TTC not present; skipping real-system face test");
      return;
    }
    const w3 = resolveFontFaceIndex(ttc, "Hiragino Mincho ProN");
    const w6 = resolveFontFaceIndex(ttc, "Hiragino Mincho ProN W6");
    expect(w3.index).not.toBe(w6.index);
    expect(w3.face.postScriptName).not.toBe(w6.face.postScriptName);
    // and measuring W3's face must not describe W6's rendering
    expect(measureTextAdvancePx("WWWW", ttc, 120, w3.index))
      .not.toBeCloseTo(measureTextAdvancePx("WWWW", ttc, 120, w6.index), 0);
  });
});
