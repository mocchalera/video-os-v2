import { useEffect, useState } from "react";
import {
  cancelRender,
  continueRender,
  delayRender,
  staticFile,
} from "remotion";
import {
  DEFAULT_VIDEO_WEB_FONT_ASSET,
  type VideoWebFontAsset,
} from "../../../../editor/shared/font-contract.js";

const bundledFontLoads = new Map<string, Promise<void>>();

function ensureBundledFontLoaded(asset: VideoWebFontAsset): Promise<void> {
  const existing = bundledFontLoads.get(asset.webPublicPath);
  if (existing) return existing;
  const pending = (async () => {
    const face = new FontFace(
      asset.family,
      `url("${staticFile(asset.webPublicPath)}") format("${asset.format}")`,
      {
        style: asset.style,
        weight: `${asset.weightRange[0]} ${asset.weightRange[1]}`,
      },
    );
    const loaded = await face.load();
    (document.fonts as FontFaceSet & { add(font: FontFace): void }).add(loaded);
    await document.fonts.ready;
  })();
  bundledFontLoads.set(asset.webPublicPath, pending);
  return pending;
}

/** Blocks frame capture until the repository-bundled font is ready. */
export function BundledFontGate({
  asset = DEFAULT_VIDEO_WEB_FONT_ASSET,
}: { asset?: VideoWebFontAsset }) {
  const [handle] = useState(() => delayRender(`Load ${asset.fontId}`));

  useEffect(() => {
    ensureBundledFontLoaded(asset)
      .then(() => continueRender(handle))
      .catch((error: unknown) => {
        cancelRender(error instanceof Error ? error : new Error(String(error)));
      });
  }, [asset, handle]);

  return null;
}
