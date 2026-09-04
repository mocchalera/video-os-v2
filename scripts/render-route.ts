#!/usr/bin/env npx tsx
/**
 * Read-only render-route preflight.
 *
 * Usage:
 *   npm run render-route -- projects/<project-id>
 *   npm run render-route -- projects/<project-id> --assembly-engine remotion --json
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildExternalRenderRouteReceipt,
  resolveProjectRenderRoute,
  type ExternalRouteMetadata,
  type AssemblyEngineRequest,
  type RenderRouteDecision,
  type RenderRouteReceipt,
} from "../runtime/render/route-resolver.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

const USAGE = [
  "Usage: npm run render-route -- <project-path> [options]",
  "",
  "Options:",
  "  --assembly-engine <auto|ffmpeg|remotion>  Preview an engine request (default: auto)",
  "  --route-kind <supplied_final|external_manual_nle>  Read a metadata-only external route",
  "  --metadata <file>                          External route metadata fixture (JSON)",
  "  --write-receipt <file>                     Write the resolved receipt JSON",
  "  --json                                     Print machine-readable JSON",
].join("\n");

export interface RenderRouteCliArgs {
  projectDir: string;
  assemblyEngine: AssemblyEngineRequest;
  routeKind?: "supplied_final" | "external_manual_nle";
  metadataPath?: string;
  writeReceiptPath?: string;
  json: boolean;
}

export function parseRenderRouteArgs(argv: string[]): RenderRouteCliArgs {
  const args = argv.slice(2);
  let projectDir = "";
  let assemblyEngine: AssemblyEngineRequest = "auto";
  let routeKind: RenderRouteCliArgs["routeKind"];
  let metadataPath: string | undefined;
  let writeReceiptPath: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--route-kind" && index + 1 < args.length) {
      const value = args[++index];
      if (value !== "supplied_final" && value !== "external_manual_nle") {
        throw new Error(`Invalid --route-kind: ${value}`);
      }
      routeKind = value;
      continue;
    }
    if (arg === "--metadata" && index + 1 < args.length) {
      metadataPath = path.resolve(args[++index]);
      continue;
    }
    if (arg === "--write-receipt" && index + 1 < args.length) {
      writeReceiptPath = path.resolve(args[++index]);
      continue;
    }
    if (arg === "--assembly-engine" && index + 1 < args.length) {
      const value = args[++index];
      if (value !== "auto" && value !== "ffmpeg" && value !== "remotion") {
        throw new Error(`Invalid --assembly-engine: ${value}`);
      }
      assemblyEngine = value;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
    if (projectDir) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    projectDir = arg;
  }

  if (!projectDir) throw new Error("<project-path> is required");
  if (routeKind && !metadataPath) throw new Error("--route-kind requires --metadata");
  if (metadataPath && !routeKind) throw new Error("--metadata requires --route-kind");
  return { projectDir: path.resolve(projectDir), assemblyEngine, routeKind, metadataPath, writeReceiptPath, json };
}

export function formatRenderRoute(decision: RenderRouteDecision | RenderRouteReceipt): string {
  const layers = decision.visual_layers.map((layer) =>
    `${layer.renderer}:${layer.mode}:${layer.composite_stage}` +
    (layer.embedded_in_base ? ":embedded" : ""),
  );
  return [
    ...("route_evidence" in decision && decision.route_evidence
      ? [`Route: ${decision.route_evidence.route_kind} / ${decision.route_evidence.status}`]
      : []),
    `Base: ${decision.base_engine}`,
    `Visual layers: ${layers.length > 0 ? layers.join(" + ") : "none"}`,
    `Captions: ${decision.caption_layer.engine}`,
    `Delivery: ${decision.delivery.compositor}/${decision.delivery.video_encoder} ` +
      `(${decision.delivery.lossy_video_encode_passes} lossy video encode)`,
    `Genre/style: ${decision.genre} / ${decision.style_family}`,
    ...decision.reasons.map((reason) => `- ${reason}`),
  ].join("\n");
}

export function runRenderRouteCli(argv = process.argv): RenderRouteDecision | RenderRouteReceipt {
  const args = parseRenderRouteArgs(argv);
  let decision: RenderRouteDecision | RenderRouteReceipt;
  if (args.metadataPath) {
    const metadata = JSON.parse(fs.readFileSync(args.metadataPath, "utf8")) as ExternalRouteMetadata;
    if (metadata.route_kind !== args.routeKind) throw new Error("external_route_metadata_route_kind_mismatch");
    decision = buildExternalRenderRouteReceipt(metadata);
    const validation = validateAgainstSchema(decision, "render-route-receipt.schema.json");
    if (!validation.valid) throw new Error(`render_route_receipt_schema_invalid: ${validation.errors.join("; ")}`);
    if (args.writeReceiptPath) {
      fs.mkdirSync(path.dirname(args.writeReceiptPath), { recursive: true });
      fs.writeFileSync(args.writeReceiptPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    }
  } else {
    decision = resolveProjectRenderRoute(args.projectDir, args.assemblyEngine);
  }
  console.log(args.json ? JSON.stringify(decision, null, 2) : formatRenderRoute(decision));
  return decision;
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  try {
    runRenderRouteCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
