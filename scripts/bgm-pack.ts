#!/usr/bin/env npx tsx

import { pathToFileURL } from "node:url";
import { buildBgmCatalog } from "../runtime/music/catalog.js";
import { findPackManifestPaths, packSearchRoots, verifyPack, type PackRegistryOptions } from "../runtime/music/pack-registry.js";
import { packIssue, type BgmPackIssue, type PackVerification } from "../runtime/music/pack-types.js";

const USAGE = [
  "Usage: npx tsx scripts/bgm-pack.ts list [--root <directory>] [--json]",
  "       npx tsx scripts/bgm-pack.ts verify [--pack <pack-id>] [--root <directory>] [--json]",
  "",
  "Read-only commands only. Pack installation is not implemented by this CLI.",
].join("\n");

export interface BgmPackCliArgs {
  command: "list" | "verify";
  root?: string;
  packId?: string;
  json: boolean;
}

export interface BgmPackCliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export const BGM_PACK_CLI_EXIT = {
  ok: 0,
  usage: 2,
  notFound: 3,
  verificationFailed: 4,
  internal: 5,
} as const;

export function parseBgmPackArgs(argv: string[]): BgmPackCliArgs {
  const args = argv.slice(2);
  const command = args.shift();
  if (command !== "list" && command !== "verify") throw new Error(USAGE);
  let root: string | undefined;
  let packId: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root" && args[index + 1]) root = args[++index];
    else if (arg === "--pack" && args[index + 1]) packId = args[++index];
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    else throw new Error(`Unknown or incomplete argument: ${arg}\n${USAGE}`);
  }
  if (command === "list" && packId) throw new Error(`--pack is only valid with verify.\n${USAGE}`);
  if (packId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packId)) throw new Error(USAGE);
  return { command, root, packId, json };
}

function registryOptions(args: BgmPackCliArgs): PackRegistryOptions {
  if (!args.root) return {};
  return { searchRoots: [{ source: "project_override", priority: 0, path: args.root }] };
}

function writeJson(io: BgmPackCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function packSummary(verification: PackVerification): Record<string, unknown> {
  return {
    pack_id: verification.manifest?.pack_id ?? verification.pack_ref,
    pack_version: verification.manifest?.pack_version,
    title: verification.manifest?.title,
    ok: verification.ok,
    manifest_hash: verification.manifest_hash,
    files_checked: verification.files_checked,
    bytes_checked: verification.bytes_checked,
    issues: verification.issues,
  };
}

function noPackIssue(packId?: string, severity: "error" | "warning" = "error"): BgmPackIssue {
  return packIssue("BGM_PACK_NOT_FOUND", "No matching BGM pack is installed in the configured directories.", {
    affectedRef: packId ?? "bgm-pack",
    suggestedAction: "Install the pack or configure VIDEO_OS_BGM_PACK_DIR.",
    severity,
  });
}

function verificationFailureExit(issues: BgmPackIssue[]): number {
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.some((issue) => issue.code !== "BGM_PACK_INCOMPATIBLE" && issue.code !== "BGM_PACK_NOT_FOUND")) {
    return BGM_PACK_CLI_EXIT.verificationFailed;
  }
  if (errors.some((issue) => issue.code === "BGM_PACK_INCOMPATIBLE")) return BGM_PACK_CLI_EXIT.usage;
  if (errors.some((issue) => issue.code === "BGM_PACK_NOT_FOUND")) return BGM_PACK_CLI_EXIT.notFound;
  return BGM_PACK_CLI_EXIT.ok;
}

export async function runBgmPackCli(
  argv: string[] = process.argv,
  io: BgmPackCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const jsonRequested = argv.includes("--json");
  let args: BgmPackCliArgs;
  try {
    args = parseBgmPackArgs(argv);
  } catch {
    const payload = {
      ok: false,
      command: "usage",
      issues: [packIssue("BGM_PACK_INCOMPATIBLE", "Invalid BGM pack CLI arguments.", {
        affectedRef: "bgm-pack-cli",
        suggestedAction: "Use the documented list or verify command syntax.",
      })],
    };
    if (jsonRequested) writeJson(io, payload);
    else io.stderr.write(`${USAGE}\n`);
    return BGM_PACK_CLI_EXIT.usage;
  }

  try {
    if (args.command === "list") {
      const catalog = buildBgmCatalog(registryOptions(args));
      const packs = catalog.packs.map((pack) => ({
        pack_id: pack.manifest.pack_id,
        pack_version: pack.manifest.pack_version,
        title: pack.manifest.title,
        source: pack.source,
        ok: pack.verification.ok,
        manifest_hash: pack.manifest_hash,
        issue_count: pack.verification.issues.length,
      }));
      const tracks = catalog.tracks.map((entry) => ({
        track_id: entry.track.track_id,
        title: entry.track.title,
        pack_id: entry.pack_id,
        pack_version: entry.pack_version,
        family: entry.track.family,
        intensity: entry.track.intensity,
        duration_us: entry.track.duration_us,
        content_hash: entry.track.full_mix.content_hash,
      }));
      const warnings = catalog.packs.length === 0 && catalog.warnings.length === 0
        ? [noPackIssue(undefined, "warning")]
        : catalog.warnings;
      const failureExit = verificationFailureExit(catalog.warnings);
      const payload = { ok: failureExit === BGM_PACK_CLI_EXIT.ok, command: "list", packs, tracks, warnings };
      if (args.json) writeJson(io, payload);
      else io.stdout.write(`BGM packs: ${packs.length}; verified tracks: ${tracks.length}\n`);
      return failureExit;
    }

    const options = registryOptions(args);
    const verifications = packSearchRoots(options)
      .flatMap((root) => findPackManifestPaths(root.path))
      .map((manifestPath) => verifyPack(manifestPath));
    const matching = args.packId
      ? verifications.filter((entry) => (entry.manifest?.pack_id ?? entry.pack_ref) === args.packId)
      : verifications;
    const issues = matching.length === 0 ? [noPackIssue(args.packId)] : matching.flatMap((entry) => entry.issues);
    const ok = matching.length > 0 && matching.every((entry) => entry.ok);
    const payload = {
      ok,
      command: "verify",
      packs: matching.map(packSummary),
      issues,
    };
    if (args.json) writeJson(io, payload);
    else io.stdout.write(ok ? `Verified ${matching.length} BGM pack(s).\n` : `BGM pack verification failed (${issues.length} issue(s)).\n`);
    if (matching.length === 0) return BGM_PACK_CLI_EXIT.notFound;
    return ok ? BGM_PACK_CLI_EXIT.ok : verificationFailureExit(issues);
  } catch {
    const payload = {
      ok: false,
      command: args.command,
      issues: [packIssue("BGM_PACK_INCOMPATIBLE", "BGM pack command failed unexpectedly.", {
        affectedRef: args.packId ?? "bgm-pack",
        suggestedAction: "Retry after checking the local pack installation and runtime bundle.",
      })],
    };
    if (args.json) writeJson(io, payload);
    else io.stderr.write("BGM pack command failed unexpectedly.\n");
    return BGM_PACK_CLI_EXIT.internal;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  process.exitCode = await runBgmPackCli(process.argv);
}
