import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASS_HEAVY_VIDEO_FONT,
  DEFAULT_VIDEO_FONT,
  DEFAULT_VIDEO_FONT_ID,
  resolveVideoFont,
} from "../editor/shared/font-contract.js";
import { DEFAULT_CAPTION_STYLE_PRESET } from "../editor/shared/caption-style-tokens.js";
import { resolvePreviewBundledFontsDir } from "../editor/server/services/font-assets.js";
import { generateHyperFramesHTML } from "../runtime/content/hyperframes-html.js";
import { writeHyperFramesProject } from "../runtime/content/hyperframes-project.js";
import {
  resolveBundledFontPaths,
  stageBundledFontAssets,
  verifyBundledFont,
} from "../runtime/fonts/bundled-font.js";
import {
  canonicalizeWebFontText,
  prepareWebFontAsset,
  stageWebFontAssets,
  webFontSubsetCacheKey,
} from "../runtime/fonts/web-font-subset.js";
import { remotionDesignTokens } from "../runtime/render/remotion/styles/design-tokens.js";

describe("bundled video font contract", () => {
  it("pins Noto Sans JP by font_id and rejects unknown font IDs", () => {
    expect(DEFAULT_VIDEO_FONT).toMatchObject({
      id: "noto-sans-jp",
      family: "Noto Sans JP",
      weightRange: [100, 900],
    });
    expect(resolveVideoFont(DEFAULT_VIDEO_FONT_ID)).toBe(DEFAULT_VIDEO_FONT);
    expect(() => resolveVideoFont("remote-font")).toThrow("Unknown video font_id");
  });

  it("canonicalizes composition characters independently of authoring order", () => {
    const left = canonicalizeWebFontText(["経営AI", "会社"]);
    const right = canonicalizeWebFontText(["社会", "IA営経"]);
    expect(left).toBe(right);
    expect(webFontSubsetCacheKey(left)).toBe(webFontSubsetCacheKey(right));
    for (const character of "経営会社AI") expect(left).toContain(character);
    expect(left).toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });

  it("fails open to the canonical TTF when the local subsetter is unavailable", () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "vos-font-fallback-"));
    try {
      const prepared = prepareWebFontAsset(["経営者"], {
        cacheDir,
        subsetterBin: path.join(cacheDir, "missing-pyftsubset"),
      });
      expect(prepared).toMatchObject({
        mode: "full_fallback",
        format: "truetype",
        filename: DEFAULT_VIDEO_FONT.filename,
        sha256: DEFAULT_VIDEO_FONT.sha256,
      });
      expect(prepared.fallbackReason).toContain("unavailable or failed");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  const hasPyftsubset = spawnSync("pyftsubset", ["--help"], { encoding: "utf8" }).status === 0;
  it.runIf(hasPyftsubset)("generates and reuses a small standalone WOFF2 subset", () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "vos-font-subset-cache-"));
    const stageDir = mkdtempSync(path.join(tmpdir(), "vos-font-subset-stage-"));
    try {
      const first = prepareWebFontAsset(["経営者本人がAIを使う意味"], { cacheDir });
      const second = prepareWebFontAsset(["意味う使をIAが人本者営経"], { cacheDir });
      expect(first).toMatchObject({ mode: "subset", format: "woff2", cacheHit: false });
      expect(second).toMatchObject({ mode: "subset", format: "woff2", cacheHit: true });
      expect(second.sha256).toBe(first.sha256);
      expect(statSync(first.fontPath).size).toBeLessThan(250_000);

      const corrupted = readFileSync(first.fontPath);
      corrupted[corrupted.length - 1] ^= 0xff;
      writeFileSync(first.fontPath, corrupted);
      const repaired = prepareWebFontAsset(["経営者本人がAIを使う意味"], { cacheDir });
      expect(repaired).toMatchObject({ mode: "subset", cacheHit: false, sha256: first.sha256 });

      const staged = stageWebFontAssets(stageDir, ["経営者本人がAIを使う意味"], { cacheDir });
      expect(staged.fontHref).toMatch(/^\.\/fonts\/noto-sans-jp-[a-f0-9]{20}\.woff2$/);
      expect(readFileSync(staged.fontPath).subarray(0, 4).toString("ascii")).toBe("wOF2");
      expect(readFileSync(staged.licensePath, "utf8")).toContain("SIL OPEN FONT LICENSE");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(stageDir, { recursive: true, force: true });
    }
  });

  it.runIf(hasPyftsubset)("writes HyperFrames HTML against its composition subset", () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "vos-font-hyperframes-"));
    try {
      const written = writeHyperFramesProject(projectDir, {
        composition_id: "font_subset",
        width: 1920,
        height: 1080,
        fps: 30,
        duration_frames: 30,
        elements: [],
      });
      const html = readFileSync(written.htmlPath, "utf8");
      expect(written.font.mode).toBe("subset");
      expect(html).toContain(`url("./fonts/${written.font.filename}") format("woff2")`);
      expect(html).not.toContain(DEFAULT_VIDEO_FONT.filename);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("ships the pinned binary and OFL license with the declared hash", () => {
    const paths = verifyBundledFont();
    const actualHash = createHash("sha256")
      .update(readFileSync(paths.fontPath))
      .digest("hex");
    expect(actualHash).toBe(DEFAULT_VIDEO_FONT.sha256);
    const actualHeavyHash = createHash("sha256")
      .update(readFileSync(paths.assHeavyFontPath))
      .digest("hex");
    expect(actualHeavyHash).toBe(ASS_HEAVY_VIDEO_FONT.sha256);
    expect(readFileSync(paths.licensePath, "utf8")).toContain(
      "SIL OPEN FONT LICENSE Version 1.1",
    );
  });

  it("stages the same font and license for browser renderers", () => {
    const target = mkdtempSync(path.join(tmpdir(), "vos-font-stage-"));
    try {
      const staged = stageBundledFontAssets(target);
      expect(staged.fontHref).toBe("./fonts/NotoSansJP-Variable.ttf");
      expect(createHash("sha256").update(readFileSync(staged.fontPath)).digest("hex"))
        .toBe(DEFAULT_VIDEO_FONT.sha256);
      expect(createHash("sha256").update(readFileSync(staged.assHeavyFontPath)).digest("hex"))
        .toBe(ASS_HEAVY_VIDEO_FONT.sha256);
      expect(readFileSync(staged.licensePath, "utf8")).toContain("SIL OPEN FONT LICENSE");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("uses one family in caption, Remotion, and HyperFrames contracts", () => {
    expect(DEFAULT_CAPTION_STYLE_PRESET).toMatchObject({
      fontId: "noto-sans-jp",
      fontFamily: "Noto Sans JP",
    });
    expect(remotionDesignTokens.fontFamilies.heading).toBe('"Noto Sans JP", sans-serif');
    expect(remotionDesignTokens.fontFamilies.body).toBe('"Noto Sans JP", sans-serif');

    const html = generateHyperFramesHTML({
      composition_id: "font_contract",
      width: 1920,
      height: 1080,
      fps: 30,
      duration_frames: 30,
      elements: [],
    });
    expect(html).toContain('font-family: "Noto Sans JP"');
    expect(html).toContain('url("./fonts/NotoSansJP-Variable.ttf")');
    expect(html).not.toContain("Arial Unicode MS");
    expect(resolveBundledFontPaths().fontsDir).toContain("Resources/Fonts");
    expect(resolvePreviewBundledFontsDir()).toBe(resolveBundledFontPaths().fontsDir);
  });
});
