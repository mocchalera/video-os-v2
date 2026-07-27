import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  ASS_BOLD_VIDEO_FONT,
  ASS_HEAVY_VIDEO_FONT,
  resolveVideoFont,
} from "../../editor/shared/font-contract.js";
import { hasCaptionStylePreset, resolveCaptionStylePreset } from "../../editor/shared/caption-style-tokens.js";
import { verifyBundledFont } from "../fonts/bundled-font.js";

export interface CaptionFontContract {
  status: "ready" | "blocked";
  font_id: string;
  family: string;
  fallback_used: boolean;
  primary?: { path: string; sha256: string };
  ass_bold?: { family: string; path: string; sha256: string };
  ass_heavy?: { family: string; path: string; sha256: string };
  selected_family?: string;
  selected_asset?: {
    role: "primary" | "ass_bold" | "ass_heavy";
    family: string;
    path: string;
    sha256: string;
    weight: number;
  };
  diagnostics: Array<{ code: string; message: string }>;
}

function fileHash(filePath: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
}

/** Fail-closed identity shared by review, ASS generation, and final rendering. */
export function inspectCaptionFontContract(
  stylingClass: string,
  cwd: string = process.cwd(),
): CaptionFontContract {
  const style = resolveCaptionStylePreset(stylingClass);
  if (!hasCaptionStylePreset(stylingClass)) {
    return {
      status: "blocked",
      font_id: style.fontId,
      family: style.fontFamily,
      fallback_used: true,
      diagnostics: [{ code: "unknown_caption_style", message: `Unknown styling_class requires fallback: ${stylingClass}` }],
    };
  }
  try {
    const declared = resolveVideoFont(style.fontId);
    const selectsVerifiedBold = style.fontFamily === ASS_BOLD_VIDEO_FONT.family
      && style.assFontFamily === ASS_BOLD_VIDEO_FONT.family
      && style.fontWeight === ASS_BOLD_VIDEO_FONT.weight
      && style.assSynthesizeBold === false;
    const selectsVerifiedHeavy = style.fontFamily === ASS_HEAVY_VIDEO_FONT.family
      && style.assFontFamily === ASS_HEAVY_VIDEO_FONT.family
      && style.fontWeight === ASS_HEAVY_VIDEO_FONT.weight
      && style.assSynthesizeBold === false;
    if (
      style.fontFamily !== declared.family
      && !selectsVerifiedBold
      && !selectsVerifiedHeavy
    ) {
      throw new Error(`style family ${style.fontFamily} does not match ${declared.family}`);
    }
    if (style.fontWeight >= 700 && !selectsVerifiedBold && !selectsVerifiedHeavy) {
      throw new Error(
        `ASS weight ${style.fontWeight} requires a verified uniquely named static family`,
      );
    }
    const verified = verifyBundledFont(style.fontId, cwd);
    const selectedAsset = selectsVerifiedBold ? {
      role: "ass_bold" as const,
      family: ASS_BOLD_VIDEO_FONT.family,
      path: verified.assBoldFontPath,
      sha256: fileHash(verified.assBoldFontPath),
      weight: ASS_BOLD_VIDEO_FONT.weight,
    } : selectsVerifiedHeavy ? {
      role: "ass_heavy" as const,
      family: ASS_HEAVY_VIDEO_FONT.family,
      path: verified.assHeavyFontPath,
      sha256: fileHash(verified.assHeavyFontPath),
      weight: ASS_HEAVY_VIDEO_FONT.weight,
    } : {
      role: "primary" as const,
      family: declared.family,
      path: verified.fontPath,
      sha256: fileHash(verified.fontPath),
      weight: style.fontWeight,
    };
    return {
      status: "ready",
      font_id: style.fontId,
      family: style.fontFamily,
      fallback_used: false,
      primary: { path: verified.fontPath, sha256: fileHash(verified.fontPath) },
      ass_bold: {
        family: ASS_BOLD_VIDEO_FONT.family,
        path: verified.assBoldFontPath,
        sha256: fileHash(verified.assBoldFontPath),
      },
      ass_heavy: {
        family: ASS_HEAVY_VIDEO_FONT.family,
        path: verified.assHeavyFontPath,
        sha256: fileHash(verified.assHeavyFontPath),
      },
      selected_family: selectedAsset.family,
      selected_asset: selectedAsset,
      diagnostics: [],
    };
  } catch (error) {
    return {
      status: "blocked",
      font_id: style.fontId,
      family: style.fontFamily,
      fallback_used: true,
      diagnostics: [{
        code: "font_unavailable",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

export function assertCaptionFontContractReady(
  stylingClass: string,
  cwd: string = process.cwd(),
): CaptionFontContract {
  const contract = inspectCaptionFontContract(stylingClass, cwd);
  if (contract.status !== "ready") {
    const message = contract.diagnostics.map((diagnostic) => diagnostic.message).join("; ")
      || "caption font contract is not ready";
    throw new Error(`caption_font_contract_not_ready: ${message}`);
  }
  return contract;
}

/**
 * Stable receipt projection of the semantic font oracle. Asset identities stay
 * hash-bound while checkout-specific absolute prefixes are removed.
 */
export function captionFontContractForReceipt(
  stylingClass: string,
  cwd: string = process.cwd(),
): CaptionFontContract {
  const contract = assertCaptionFontContractReady(stylingClass, cwd);
  const relative = (filePath: string): string =>
    path.relative(cwd, filePath).split(path.sep).join("/");
  return {
    ...contract,
    ...(contract.primary
      ? { primary: { ...contract.primary, path: relative(contract.primary.path) } }
      : {}),
    ...(contract.ass_bold
      ? { ass_bold: { ...contract.ass_bold, path: relative(contract.ass_bold.path) } }
      : {}),
    ...(contract.ass_heavy
      ? { ass_heavy: { ...contract.ass_heavy, path: relative(contract.ass_heavy.path) } }
      : {}),
    ...(contract.selected_asset
      ? {
          selected_asset: {
            ...contract.selected_asset,
            path: relative(contract.selected_asset.path),
          },
        }
      : {}),
  };
}
