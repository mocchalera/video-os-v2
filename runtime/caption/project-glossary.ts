import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { GlossarySource } from "./editorial.js";

export interface CaptionGlossaryTerm {
  canonical: string;
  variants?: string[];
}

export interface CaptionGlossaryDocument {
  version?: string;
  terms?: CaptionGlossaryTerm[];
  project_names?: string[];
  brand_terms?: string[];
  corrections?: Array<{ from: string; to: string }>;
}

export interface LoadedCaptionGlossary {
  sourcePath?: string;
  sources: GlossarySource;
}

const GLOSSARY_FILENAMES = [
  "caption_glossary.yaml",
  "caption-glossary.yaml",
  "caption_glossary.yml",
  "caption-glossary.yml",
  "caption_glossary.json",
  "caption-glossary.json",
];

export function loadProjectCaptionGlossary(projectDir: string): LoadedCaptionGlossary {
  const intentDir = path.join(projectDir, "01_intent");
  const sourcePath = GLOSSARY_FILENAMES
    .map((name) => path.join(intentDir, name))
    .find((candidate) => fs.existsSync(candidate));

  if (!sourcePath) return { sources: {} };

  const raw = fs.readFileSync(sourcePath, "utf-8");
  const document = (sourcePath.endsWith(".json")
    ? JSON.parse(raw)
    : parseYaml(raw)) as CaptionGlossaryDocument;
  const terms = Array.isArray(document.terms) ? document.terms : [];
  const corrections = [
    ...(document.corrections ?? []),
    ...terms.flatMap((term) =>
      (term.variants ?? []).map((variant) => ({ from: variant, to: term.canonical }))
    ),
  ]
    .filter((entry) => entry.from && entry.to && entry.from !== entry.to)
    .sort((a, b) => b.from.length - a.from.length);

  return {
    sourcePath,
    sources: {
      projectNames: [
        ...(document.project_names ?? []),
        ...terms.map((term) => term.canonical),
      ],
      brandTerms: document.brand_terms ?? [],
      operatorCorrections: corrections,
    },
  };
}

export function mergeGlossarySources(
  base: GlossarySource,
  override?: GlossarySource,
): GlossarySource {
  if (!override) return base;
  return {
    mustInclude: [...(base.mustInclude ?? []), ...(override.mustInclude ?? [])],
    projectNames: [...(base.projectNames ?? []), ...(override.projectNames ?? [])],
    brandTerms: [...(base.brandTerms ?? []), ...(override.brandTerms ?? [])],
    operatorCorrections: [
      ...(base.operatorCorrections ?? []),
      ...(override.operatorCorrections ?? []),
    ],
  };
}
