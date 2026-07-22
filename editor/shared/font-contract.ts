/**
 * Cross-renderer font identity. Rendering code may resolve the file through
 * its own runtime, but authored artifacts use only this stable font_id.
 */
export const DEFAULT_VIDEO_FONT_ID = "noto-sans-jp" as const;

export type VideoFontId = typeof DEFAULT_VIDEO_FONT_ID;

export interface VideoFontContract {
  id: VideoFontId;
  family: string;
  filename: string;
  licenseFilename: string;
  repoRelativePath: string;
  licenseRepoRelativePath: string;
  sha256: string;
  weightRange: readonly [number, number];
  style: "normal";
  webPublicPath: string;
}

/** Serializable font-face descriptor passed into browser renderers. */
export interface VideoWebFontAsset {
  fontId: VideoFontId;
  family: string;
  webPublicPath: string;
  format: "truetype" | "woff2";
  weightRange: readonly [number, number];
  style: "normal";
}

/**
 * Static 900 face used by libass for display-heavy short captions.
 *
 * libass exposes only a boolean Bold flag in ASS styles, so it cannot select
 * weight 900 from the variable face reliably. A uniquely named static face
 * keeps exact-preview and final burn-in aligned with CSS font-weight: 900.
 */
export const ASS_HEAVY_VIDEO_FONT = {
  family: "VideoOS Noto Sans JP Black",
  filename: "VideoOSNotoSansJPBlack.ttf",
  repoRelativePath:
    "apps/macos-studio/Sources/VideoOSStudio/Resources/Fonts/VideoOSNotoSansJPBlack.ttf",
  sha256: "8161c16d66e5c2154bf3afaa665ad2dc14fa26a2f549007fed94ee92be8e9bad",
  weight: 900,
} as const;

export const DEFAULT_VIDEO_FONT: VideoFontContract = {
  id: DEFAULT_VIDEO_FONT_ID,
  family: "Noto Sans JP",
  filename: "NotoSansJP-Variable.ttf",
  licenseFilename: "OFL.txt",
  repoRelativePath:
    "apps/macos-studio/Sources/VideoOSStudio/Resources/Fonts/NotoSansJP-Variable.ttf",
  licenseRepoRelativePath:
    "apps/macos-studio/Sources/VideoOSStudio/Resources/Fonts/OFL.txt",
  sha256: "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f",
  weightRange: [100, 900],
  style: "normal",
  webPublicPath: "fonts/NotoSansJP-Variable.ttf",
};

export const DEFAULT_VIDEO_WEB_FONT_ASSET: VideoWebFontAsset = {
  fontId: DEFAULT_VIDEO_FONT.id,
  family: DEFAULT_VIDEO_FONT.family,
  webPublicPath: DEFAULT_VIDEO_FONT.webPublicPath,
  format: "truetype",
  weightRange: DEFAULT_VIDEO_FONT.weightRange,
  style: DEFAULT_VIDEO_FONT.style,
};

export function resolveVideoFont(fontId: string = DEFAULT_VIDEO_FONT_ID): VideoFontContract {
  if (fontId !== DEFAULT_VIDEO_FONT_ID) {
    throw new Error(`Unknown video font_id: ${fontId}`);
  }
  return DEFAULT_VIDEO_FONT;
}

export function videoFontFamilyStack(fontId: string = DEFAULT_VIDEO_FONT_ID): string {
  const font = resolveVideoFont(fontId);
  return `"${font.family}", sans-serif`;
}
