import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  collectWebFontStrings,
  stageWebFontAssets,
  type StagedWebFontAsset,
} from "../fonts/web-font-subset.js";
import {
  generateHyperFramesHTML,
  type HyperFramesCompositionInput,
} from "./hyperframes-html.js";

export interface WrittenHyperFramesProject {
  projectDir: string;
  htmlPath: string;
  font: StagedWebFontAsset;
}

export function hyperFramesCompositionFontStrings(
  input: HyperFramesCompositionInput,
): string[] {
  const values = ["QUESTION"];
  for (const timed of input.elements) collectWebFontStrings(timed.element.props, values);
  return values;
}

/** Writes a self-contained, network-free HyperFrames project. */
export function writeHyperFramesProject(
  projectDir: string,
  input: HyperFramesCompositionInput,
): WrittenHyperFramesProject {
  mkdirSync(projectDir, { recursive: true });
  const font = stageWebFontAssets(projectDir, hyperFramesCompositionFontStrings(input));
  const htmlPath = path.join(projectDir, "index.html");
  writeFileSync(htmlPath, generateHyperFramesHTML(input, { fontAsset: font }), "utf8");
  return { projectDir, htmlPath, font };
}
