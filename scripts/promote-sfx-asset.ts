#!/usr/bin/env npx tsx

import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifact } from "../runtime/artifacts/loaders.js";
import {
  promoteSfxAsset,
  type PromoteSfxAssetOptions,
  type SfxPromotionResult,
} from "../runtime/audio/sfx-promotion.js";
import type {
  SfxLibraryScope,
  SfxRightsStatus,
  SfxReviewStatus,
} from "../runtime/audio/sfx-library.js";

export const SFX_PROMOTION_USAGE = [
  "Usage: npm run sfx:promote -- --asset-id <id> --scope <repo_common|project_local> [options]",
  "",
  "Validate an existing manifest or promote one explicitly authorized local source.",
  "Missing or ambiguous rights/provenance returns an explicit HOLD and writes nothing.",
  "The command never changes the source path and never overwrites an output.",
  "",
  "Options:",
  "  --asset-id <id>             Stable asset ID",
  "  --scope <scope>             repo_common or project_local",
  "  --source <path>             Authorized source file for validate-only or promotion",
  "  --manifest <path>           Existing manifest to validate without media writes",
  "  --destination <directory>   Destination asset directory",
  "  --output-manifest <path>    New manifest path for promotion",
  "  --project <directory>       Project root for project_local",
  "  --repo-root <directory>     Repository root for repo_common",
  "  --repo-sfx-root <directory> Explicit SFX authority root for repo_common",
  "  --rights-status <status>    cleared or confirmed are selectable; default unknown",
  "  --rights-evidence <ref>     Evidence reference",
  "  --provenance-ref <ref>      Provenance reference",
  "  --provenance-origin <kind>  deterministic_synthesis, recorded_local, or licensed_local",
  "  --usage-scope <scope>       internal_audition, project_render, commercial, or public_release",
  "  --review-status <status>    approved, pending, rejected, unreviewed, or hold",
  "  --verified-at <timestamp>   Rights verification timestamp",
  "  --permitted-derivatives <list> Comma-separated permitted derivative scopes",
  "  --validate-only             Validate and never write/copy",
  "  --dry-run                   Alias for --validate-only",
  "  --json                      Emit machine-readable result",
  "  --help                      Show this help",
].join("\n");

export interface PromoteSfxAssetCliArgs extends PromoteSfxAssetOptions {
  json: boolean;
  help: boolean;
}

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(flag + " requires a value");
  return value;
}

export function parsePromoteSfxAssetArgs(argv: string[]): PromoteSfxAssetCliArgs {
  const values = argv.slice(2);
  let assetId: string | undefined;
  let scope: SfxLibraryScope | undefined;
  let sourcePath: string | undefined;
  let manifestPath: string | undefined;
  let destinationDir: string | undefined;
  let outputManifestPath: string | undefined;
  let projectDir: string | undefined;
  let repoRoot: string | undefined;
  let repoSfxRoot: string | undefined;
  let rightsStatus: SfxRightsStatus | undefined;
  let rightsEvidenceRef: string | null | undefined;
  let provenanceRef: string | null | undefined;
  let provenanceOrigin: PromoteSfxAssetOptions["provenanceOrigin"];
  let usageScope: PromoteSfxAssetOptions["usageScope"];
  let reviewStatus: SfxReviewStatus | undefined;
  let verifiedAt: string | undefined;
  let permittedDerivatives: string[] | undefined;
  let validateOnly = false;
  let json = false;
  let help = false;
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--asset-id") assetId = required(values, ++index, arg);
    else if (arg === "--scope") scope = required(values, ++index, arg) as SfxLibraryScope;
    else if (arg === "--source") sourcePath = required(values, ++index, arg);
    else if (arg === "--manifest") manifestPath = required(values, ++index, arg);
    else if (arg === "--destination") destinationDir = required(values, ++index, arg);
    else if (arg === "--output-manifest") outputManifestPath = required(values, ++index, arg);
    else if (arg === "--project") projectDir = required(values, ++index, arg);
    else if (arg === "--repo-root") repoRoot = required(values, ++index, arg);
    else if (arg === "--repo-sfx-root") repoSfxRoot = required(values, ++index, arg);
    else if (arg === "--rights-status") rightsStatus = required(values, ++index, arg) as SfxRightsStatus;
    else if (arg === "--rights-evidence") rightsEvidenceRef = required(values, ++index, arg);
    else if (arg === "--provenance-ref") provenanceRef = required(values, ++index, arg);
    else if (arg === "--provenance-origin") provenanceOrigin = required(values, ++index, arg) as PromoteSfxAssetOptions["provenanceOrigin"];
    else if (arg === "--usage-scope") usageScope = required(values, ++index, arg) as PromoteSfxAssetOptions["usageScope"];
    else if (arg === "--review-status") reviewStatus = required(values, ++index, arg) as SfxReviewStatus;
    else if (arg === "--verified-at") verifiedAt = required(values, ++index, arg);
    else if (arg === "--permitted-derivatives") {
      permittedDerivatives = required(values, ++index, arg).split(",").map((item) => item.trim()).filter(Boolean);
    }
    else if (arg === "--validate-only" || arg === "--dry-run") validateOnly = true;
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error("unknown argument: " + arg);
  }
  if (help) {
    return {
      assetId: assetId ?? "help",
      scope: scope ?? "project_local",
      validateOnly,
      json,
      help,
      ...(sourcePath ? { sourcePath: path.resolve(sourcePath) } : {}),
    };
  }
  if (!assetId || !scope || !["repo_common", "project_local"].includes(scope)) {
    throw new Error("asset ID and a valid scope are required");
  }
  return {
    assetId,
    scope,
    validateOnly,
    json,
    help,
    ...(sourcePath ? { sourcePath: path.resolve(sourcePath) } : {}),
    ...(manifestPath ? { manifestPath: path.resolve(manifestPath) } : {}),
    ...(destinationDir ? { destinationDir: path.resolve(destinationDir) } : {}),
    ...(outputManifestPath ? { outputManifestPath: path.resolve(outputManifestPath) } : {}),
    ...(projectDir ? { projectDir: path.resolve(projectDir) } : {}),
    ...(repoRoot ? { repoRoot: path.resolve(repoRoot) } : {}),
    ...(repoSfxRoot ? { repoSfxRoot: path.resolve(repoSfxRoot) } : {}),
    ...(rightsStatus ? { rightsStatus } : {}),
    ...(rightsEvidenceRef !== undefined ? { rightsEvidenceRef } : {}),
    ...(provenanceRef !== undefined ? { provenanceRef } : {}),
    ...(provenanceOrigin ? { provenanceOrigin } : {}),
    ...(usageScope ? { usageScope } : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(permittedDerivatives ? { permittedDerivatives } : {}),
  };
}

export function runPromoteSfxAsset(
  args: PromoteSfxAssetCliArgs,
): SfxPromotionResult {
  const output = promoteSfxAsset(args);
  return validateArtifact<SfxPromotionResult>(output, "sfx-promotion-result.schema.json");
}

export function main(argv: string[] = process.argv): number {
  const json = argv.includes("--json");
  try {
    const args = parsePromoteSfxAssetArgs(argv);
    if (args.help) {
      process.stdout.write(SFX_PROMOTION_USAGE + "\n");
      return 0;
    }
    const output = runPromoteSfxAsset(args);
    if (json) process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    else process.stdout.write(output.status + ": " + output.reason + "\n");
    return output.status === "HOLD" ? 3 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(JSON.stringify({
        version: "sfx-promotion-result/v1",
        command: "sfx-promote",
        status: "HOLD",
        scope: "project_local",
        asset_id: "invalid",
        wrote_files: false,
        reason: message,
        media_validation: {
          performed: false,
          available: false,
          decode: "not_run",
        },
      }) + "\n");
    } else {
      process.stderr.write(SFX_PROMOTION_USAGE + "\n" + message + "\n");
    }
    return 2;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) process.exitCode = main();
