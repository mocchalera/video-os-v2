#!/usr/bin/env npx tsx
import { readFileSync, writeFileSync } from "fs";
import { parse, stringify } from "yaml";
import { enrichSelectsFromAnalysis, refineClusters } from "../runtime/agents/triage-enrichment.js";

async function main() {
  const project = process.argv[2] ?? "projects/ena-promo-ai";
  const selectsPath = `${project}/04_plan/selects_candidates.yaml`;
  const segmentsPath = `${project}/03_analysis/segments.json`;
  const assetsPath = `${project}/03_analysis/assets.json`;

  const selects = parse(readFileSync(selectsPath, "utf-8"));
  const segments = JSON.parse(readFileSync(segmentsPath, "utf-8")).items;

  let assets: Array<{ asset_id: string; display_name?: string; filename?: string }> = [];
  try {
    const assetsDoc = JSON.parse(readFileSync(assetsPath, "utf-8"));
    assets = assetsDoc.items ?? assetsDoc.assets ?? [];
  } catch {}

  const enriched = enrichSelectsFromAnalysis(selects, segments);
  const refined = await refineClusters(enriched, segments, { assets, projectDir: project });
  writeFileSync(selectsPath, stringify(refined));

  const clusters: Record<string, number> = {};
  for (const c of refined.candidates) {
    const cl = c.editorial_signals?.semantic_cluster_id ?? "?";
    clusters[cl ?? "?"] = (clusters[cl ?? "?"] || 0) + 1;
  }
  console.log(JSON.stringify(clusters, null, 2));
}
main();
