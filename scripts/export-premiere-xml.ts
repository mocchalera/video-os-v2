#!/usr/bin/env npx tsx
/**
 * CLI: Export timeline.json to Premiere Pro XML (FCP7 format)
 *
 * Usage:
 *   npx tsx scripts/export-premiere-xml.ts <project-path> [--source-map <source-map.json>]
 *
 * The source map JSON accepts:
 * - legacy maps: { "AST_31A9CDC2": "/path/to/file.MOV", ... }
 * - 02_media/source_map.json
 * - handoff manifests with source_map[]
 *
 * If --source-map is not provided, the script will first look for
 * 02_media/source_map.json, then fall back to older 03_analysis heuristics.
 *
 * Output: <project-path>/09_output/<project_id>_premiere.xml
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { TimelineIR } from "../runtime/compiler/types.js";
import {
  timelineToFcp7Xml,
  type TextOverlay,
} from "../runtime/handoff/fcp7-xml-export.js";
import { loadSourceMap, type LoadedSourceMap } from "../runtime/media/source-map.js";
import {
  createPremiereRoundtripReceipt,
  createPremiereRoundtripReceiptV2,
  createBakedClipMaps,
  derivePremiereRoundtripId,
  derivePremiereRoundtripIdV2,
  derivePremiereExportGenerationId,
  sha256Prefixed,
} from "../runtime/handoff/premiere-roundtrip-receipt.js";
import {
  classifyPremiereVideoTreatments,
  decodePremiereTimelineIdentity,
  openPremiereRevisionBoundTimeline,
  preflightPremiereEffectBakes,
  preflightPremiereEffectBakesBrokered,
  preparePremiereEffectBakes,
  PremiereTimelineRevisionMismatch,
  type PremiereTimelineIdentity,
  type PremiereEffectBakeIndex,
} from "../runtime/handoff/premiere-effect-bake.js";
import { PremierePreflightProcessBroker } from "../runtime/handoff/premiere-preflight-process-broker.js";

const require = createRequire(import.meta.url);
type Validate = ((value: unknown) => boolean) & { errors?: unknown };
const Ajv2020 = require("ajv/dist/2020") as new (options: Record<string, unknown>) => { compile(schema: object): Validate };
const addFormats = require("ajv-formats") as (ajv: InstanceType<typeof Ajv2020>) => void;

// ── Arg parsing ─────────────────────────────────────────────────────

const USAGE = `Usage: npx tsx scripts/export-premiere-xml.ts <project-path> [options]
Options:
  --source-map <file>  Asset ID → file path mapping
  --titles <file>      Text overlay definitions (JSON)
  --auto-titles        Generate overlays from timeline markers
  --preflight          Read-only visual-effect bake readiness check
  --bake-visual-effects  Explicitly render non-editable visual-effect replacements
  --json               Emit one JSON result document
  --expected-timeline-sha256 <sha256:...>  Required with --preflight --json
  --expected-timeline-identity-json <base64url>  Required with --preflight --json
  --help, -h           Show this help`;

export function parseArgs(argv: string[]): {
  projectPath: string;
  sourceMapPath?: string;
  titlesPath?: string;
  autoTitles: boolean;
  preflight: boolean;
  bakeVisualEffects: boolean;
  jsonOutput: boolean;
  expectedTimelineSha256?: string;
  expectedTimelineIdentity?: PremiereTimelineIdentity;
} {
  const args = argv.slice(2);
  let projectPath: string | undefined;
  let sourceMapPath: string | undefined;
  let titlesPath: string | undefined;
  let autoTitles = false;
  let preflight = false;
  let bakeVisualEffects = false;
  let jsonOutput = false;
  let expectedTimelineSha256: string | undefined;
  let expectedTimelineIdentity: PremiereTimelineIdentity | undefined;
  let expectedTimelineIdentityEncoded: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--source-map" && i + 1 < args.length) {
      sourceMapPath = args[++i];
    } else if (arg === "--titles" && i + 1 < args.length) {
      titlesPath = args[++i];
    } else if (arg === "--auto-titles") {
      autoTitles = true;
    } else if (arg === "--preflight") {
      preflight = true;
    } else if (arg === "--bake-visual-effects") {
      bakeVisualEffects = true;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--expected-timeline-sha256" && i + 1 < args.length) {
      if (expectedTimelineSha256 !== undefined) throw new Error("invalid_preflight_contract: duplicate expected timeline SHA flag");
      expectedTimelineSha256 = args[++i];
    } else if (arg === "--expected-timeline-identity-json" && i + 1 < args.length) {
      if (expectedTimelineIdentityEncoded !== undefined) throw new Error("invalid_preflight_contract: duplicate expected timeline identity flag");
      expectedTimelineIdentityEncoded = args[++i];
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (!projectPath) {
      projectPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!projectPath) {
    throw new Error("Error: <project-path> is required");
  }

  if (preflight && bakeVisualEffects) throw new Error("--preflight and --bake-visual-effects cannot be combined");
  const revisionBound = preflight && jsonOutput;
  if (revisionBound) {
    if (!expectedTimelineSha256 || !/^sha256:[0-9a-f]{64}$/.test(expectedTimelineSha256) || !expectedTimelineIdentityEncoded) {
      throw new Error("invalid_preflight_contract: --preflight --json requires exact expected timeline SHA and identity flags");
    }
    expectedTimelineIdentity = decodePremiereTimelineIdentity(expectedTimelineIdentityEncoded);
  } else if (expectedTimelineSha256 !== undefined || expectedTimelineIdentityEncoded !== undefined) {
    throw new Error("invalid_preflight_contract: expected timeline revision flags require --preflight --json");
  }
  return { projectPath: path.resolve(projectPath), sourceMapPath, titlesPath, autoTitles, preflight, bakeVisualEffects, jsonOutput, expectedTimelineSha256, expectedTimelineIdentity };
}

// ── Source map resolution ───────────────────────────────────────────

function resolveSourceMap(
  projectPath: string,
  sourceMapPath?: string,
): { locatorMap: Map<string, string>; displayNameMap: Map<string, string> } {
  if (sourceMapPath && !fs.existsSync(path.resolve(sourceMapPath))) {
    throw new Error(`source map not found: ${path.resolve(sourceMapPath)}`);
  }

  const loaded = loadSourceMap(projectPath, sourceMapPath);

  // Build display name map from source map entries
  const displayNameMap = new Map<string, string>();
  for (const entry of loaded.entries) {
    if (entry.display_name) {
      displayNameMap.set(entry.asset_id, entry.display_name);
    }
  }

  if (loaded.locatorMap.size > 0) {
    return { locatorMap: loaded.locatorMap, displayNameMap };
  }

  const map = new Map<string, string>();

  // Try to auto-resolve from analysis directory
  const analysisDir = path.join(projectPath, "03_analysis");
  if (fs.existsSync(analysisDir)) {
    // Look for asset manifest or analysis files
    const files = fs.readdirSync(analysisDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(analysisDir, file), "utf-8"),
          );
          if (data.asset_id && data.source_path) {
            map.set(data.asset_id, data.source_path);
          }
        } catch {
          // Skip unparseable files
        }
      }
    }
  }

  return { locatorMap: map, displayNameMap };
}

// ── Main ────────────────────────────────────────────────────────────

// ── Title overlay resolution ────────────────────────────────────────

function resolveTextOverlays(
  timeline: TimelineIR,
  titlesPath?: string,
  autoTitles?: boolean,
): TextOverlay[] {
  // Explicit titles file takes priority
  if (titlesPath) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(titlesPath), "utf-8"));
    const items: TextOverlay[] = Array.isArray(raw) ? raw : raw.overlays ?? [];
    return items;
  }

  // Auto-generate from timeline markers (beat markers → lower-third labels)
  if (autoTitles && timeline.markers.length > 0) {
    const fps = timeline.sequence.fps_num / (timeline.sequence.fps_den || 1);
    const defaultDurFrames = Math.round(5 * fps); // 5 seconds

    const overlays: TextOverlay[] = timeline.markers
      .filter((m) => m.kind === "beat" || m.kind === "note")
      .map((m) => {
        // Strip "b01: " prefix from beat labels if present
        const text = m.label.replace(/^b\d+:\s*/, "");
        return {
          startFrame: m.frame,
          durationFrames: defaultDurFrames,
          text,
          fontSize: 36,
          position: "lower-third" as const,
        };
      });

    return overlays;
  }

  return [];
}

function resolveOutputPaths(
  projectPath: string,
  projectId: string,
): { outputDir: string; outputPath: string; receiptPath: string } {
  if (
    !projectId ||
    projectId === "." ||
    projectId === ".." ||
    /[/\\]/.test(projectId)
  ) {
    throw new Error(`unsafe project_id for Premiere output: ${projectId}`);
  }
  const outputDir = path.resolve(projectPath, "09_output");
  const outputPath = path.resolve(outputDir, `${projectId}_premiere.xml`);
  const receiptPath = path.resolve(
    outputDir,
    `${projectId}_premiere.roundtrip.json`,
  );
  if (
    path.dirname(outputPath) !== outputDir ||
    path.dirname(receiptPath) !== outputDir
  ) {
    throw new Error(`Premiere output path escapes 09_output: ${projectId}`);
  }
  return { outputDir, outputPath, receiptPath };
}

function writeFsync(file: string, data: string | Buffer, mode = 0o600): void {
  fs.writeFileSync(file, data, { mode });
  const fd = fs.openSync(file, "r"); fs.fsyncSync(fd); fs.closeSync(fd);
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); fs.closeSync(fd);
}

function ensureExportDirectoryTree(root: string, target: string): void {
  const resolvedRoot = path.resolve(root), resolvedTarget = path.resolve(target), relative = path.relative(resolvedRoot, resolvedTarget);
  const rootStat = fs.lstatSync(resolvedRoot); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("premiere_export_conflict: directory root is not real");
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("premiere_export_conflict: directory target escaped root");
  let cursor = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try { fs.mkdirSync(cursor); } catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("premiere_export_conflict: directory path contains symlink or non-directory");
  }
}

function exportDirectoryIdentity(dir: string): { dev: number; ino: number } {
  const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("premiere_export_conflict: publication parent is not real"); return { dev: stat.dev, ino: stat.ino };
}

function assertExportDirectoryIdentity(dir: string, expected: { dev: number; ino: number }): void {
  const actual = exportDirectoryIdentity(dir); if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("premiere_export_conflict: publication parent identity changed");
}

interface ExportClaimContext { root: string; path: string; id: string; projectId: string; baseTimelineSha256: string; invocationId: string; }

function exportBootIdentity(): string {
  if (fs.existsSync("/proc/sys/kernel/random/boot_id")) { const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); if (value) return value; }
  const result = spawnSync(process.platform === "darwin" ? "/usr/sbin/sysctl" : "sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }), value = result.status === 0 ? result.stdout.trim() : "";
  if (!value) throw new Error("premiere_export_claim_corrupt: cannot establish host boot identity");
  return value;
}
function exportHostId(): string { return sha256Prefixed(`${os.hostname()}\0${exportBootIdentity()}`); }
function exportProcessStartId(pid: number): string | undefined {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const started = result.status === 0 ? result.stdout.trim() : "";
  return started ? sha256Prefixed(`${exportHostId()}\0${pid}\0${started}`) : undefined;
}

function readExportClaim(file: string): Record<string, unknown> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error("premiere_export_claim_corrupt: claim must be mode 0600 regular nlink=1");
  let value: unknown; try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("premiere_export_claim_corrupt: claim is malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("premiere_export_claim_corrupt: claim must be object");
  const claim = value as Record<string, unknown>, fields = ["version", "claim_id", "project_id", "base_timeline_sha256", "invocation_id", "host_id", "pid", "process_start_id", "created_at"];
  if (Object.keys(claim).sort().join("|") !== fields.sort().join("|") || claim.version !== "premiere-export-claim/v1" || typeof claim.claim_id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(claim.claim_id) || typeof claim.project_id !== "string" || typeof claim.base_timeline_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(claim.base_timeline_sha256) || typeof claim.invocation_id !== "string" || !claim.invocation_id || typeof claim.host_id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(claim.host_id) || typeof claim.pid !== "number" || !Number.isSafeInteger(claim.pid) || claim.pid <= 0 || typeof claim.process_start_id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(claim.process_start_id) || typeof claim.created_at !== "string" || !Number.isFinite(Date.parse(claim.created_at))) throw new Error("premiere_export_claim_corrupt: claim fields invalid");
  return claim;
}

function recoverCompletedExportClaim(projectPath: string, root: string, claimPath: string, claim: Record<string, unknown>): boolean {
  const releasePath = path.join(root, "claims", "releases", `${String(claim.claim_id).slice(7)}.json`);
  if (!fs.existsSync(releasePath)) return false;
  const stat = fs.lstatSync(releasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("premiere_export_claim_corrupt: release must be regular nlink=1");
  let release: Record<string, unknown>; try { release = JSON.parse(fs.readFileSync(releasePath, "utf8")); } catch { throw new Error("premiere_export_claim_corrupt: release is malformed"); }
  const fields = ["version", "claim_id", "current_sha256", "compatibility_xml_sha256", "compatibility_receipt_sha256", "released_at"];
  if (!release || typeof release !== "object" || Array.isArray(release) || Object.keys(release).sort().join("|") !== fields.sort().join("|") || release.version !== "premiere-export-claim-release/v1" || release.claim_id !== claim.claim_id || typeof release.current_sha256 !== "string" || typeof release.compatibility_xml_sha256 !== "string" || typeof release.compatibility_receipt_sha256 !== "string" || ![release.current_sha256, release.compatibility_xml_sha256, release.compatibility_receipt_sha256].every((value) => /^sha256:[0-9a-f]{64}$/.test(String(value))) || typeof release.released_at !== "string" || !Number.isFinite(Date.parse(release.released_at))) throw new Error("premiere_export_claim_corrupt: release fields invalid");
  const projectId = String(claim.project_id), current = path.join(root, "CURRENT.json"), compatibilityXml = path.join(projectPath, "09_output", `${projectId}_premiere.xml`), compatibilityReceipt = path.join(projectPath, "09_output", `${projectId}_premiere.roundtrip.json`);
  for (const [file, expected] of [[current, release.current_sha256], [compatibilityXml, release.compatibility_xml_sha256], [compatibilityReceipt, release.compatibility_receipt_sha256]] as const) {
    const fileStat = fs.lstatSync(file); if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1 || sha256Prefixed(fs.readFileSync(file)) !== expected) throw new Error("premiere_export_claim_corrupt: release artifact mismatch");
  }
  if (readExportClaim(claimPath).claim_id !== claim.claim_id) throw new Error("premiere_export_claim_corrupt: claim ownership changed during release recovery");
  fs.unlinkSync(claimPath); fsyncDir(root);
  return true;
}

function acquireExportClaim(projectPath: string, projectId: string, baseTimelineSha256: string): ExportClaimContext {
  const root = path.join(projectPath, "09_output", "premiere-exports"), claimPath = path.join(root, "CLAIM.json");
  ensureExportDirectoryTree(projectPath, root); ensureExportDirectoryTree(root, path.join(root, "claims", "abandoned")); ensureExportDirectoryTree(root, path.join(root, "claims", "releases")); ensureExportDirectoryTree(root, path.join(root, "staging"));
  if (fs.existsSync(claimPath)) {
    const existing = readExportClaim(claimPath);
    if (existing.project_id !== projectId) throw new Error("premiere_export_claim_corrupt: project identity mismatch");
    if (!recoverCompletedExportClaim(projectPath, root, claimPath, existing)) {
      if (existing.host_id !== exportHostId()) throw new Error("premiere_export_busy: foreign-host export claim exists");
      if (exportProcessStartId(existing.pid as number) === existing.process_start_id) throw new Error("premiere_export_busy: active export claim exists");
      const abandoned = path.join(root, "claims", "abandoned", `${String(existing.claim_id).slice(7)}.${process.pid}.${Date.now()}.json`);
      fs.renameSync(claimPath, abandoned); fsyncDir(path.dirname(abandoned)); fsyncDir(root);
    }
  }
  const invocationId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`, id = sha256Prefixed(`${projectId}\0${baseTimelineSha256}\0${invocationId}`);
  const processStartId = exportProcessStartId(process.pid);
  if (!processStartId) throw new Error("premiere_export_claim_corrupt: cannot establish current process start identity");
  const claim = { version: "premiere-export-claim/v1", claim_id: id, project_id: projectId, base_timeline_sha256: baseTimelineSha256, invocation_id: invocationId, host_id: exportHostId(), pid: process.pid, process_start_id: processStartId, created_at: new Date().toISOString() };
  const rootIdentity = exportDirectoryIdentity(root);
  let fd: number; try { fd = fs.openSync(claimPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("premiere_export_busy: competing export claim exists"); throw error; }
  try { fs.writeFileSync(fd, `${JSON.stringify(claim)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fsyncDir(root); assertExportDirectoryIdentity(root, rootIdentity);
  return { root, path: claimPath, id, projectId, baseTimelineSha256, invocationId };
}

function releaseExportClaim(claim: ExportClaimContext, successful: boolean, release?: Record<string, unknown>): void {
  if (!fs.existsSync(claim.path)) return;
  let current: Record<string, unknown>; try { current = readExportClaim(claim.path); } catch { return; }
  if (current.claim_id !== claim.id) return;
  let releaseError: unknown;
  try { if (successful && release) { const releasePath = path.join(claim.root, "claims", "releases", `${claim.id.slice(7)}.json`), releaseParent = exportDirectoryIdentity(path.dirname(releasePath)); writeFsync(releasePath, `${JSON.stringify(release)}\n`); fsyncDir(path.dirname(releasePath)); assertExportDirectoryIdentity(path.dirname(releasePath), releaseParent); } }
  catch (error) { releaseError = error; }
  finally { if (fs.existsSync(claim.path)) { const latest = readExportClaim(claim.path); if (latest.claim_id === claim.id) { fs.unlinkSync(claim.path); fsyncDir(claim.root); } } }
  if (releaseError) throw releaseError;
}

function publishExportGeneration(args: {
  projectPath: string; projectId: string; baseTimelineSha256: string; roundtripId: string;
  generationId: string; xml: Buffer; receipt: object; bakeIndex: PremiereEffectBakeIndex; claim: ExportClaimContext;
}): { generation_dir: string; xml_path: string; receipt_path: string; bake_index_path: string; ready_path: string; current_path: string } {
  const root = args.claim.root, claimId = args.claim.id, invocation = args.claim.invocationId;
  const staging = path.join(root, "staging", invocation);
  const generation = path.join(root, "generations", args.generationId.slice(7));
  const xmlName = `${args.projectId}_premiere.xml`, receiptName = `${args.projectId}_premiere.roundtrip.json`;
  try {
    ensureExportDirectoryTree(root, path.dirname(generation));
    let reusedGenerationIdentity: { dev: number; ino: number } | undefined;
    if (!fs.existsSync(generation)) {
      const generationsIdentity = exportDirectoryIdentity(path.dirname(generation));
      fs.mkdirSync(staging, { recursive: false });
      writeFsync(path.join(staging, xmlName), args.xml);
      writeFsync(path.join(staging, receiptName), `${JSON.stringify(args.receipt, null, 2)}\n`);
      writeFsync(path.join(staging, "bake-index.json"), `${JSON.stringify(args.bakeIndex, null, 2)}\n`);
      fsyncDir(staging); fs.renameSync(staging, generation); fsyncDir(path.dirname(generation)); assertExportDirectoryIdentity(path.dirname(generation), generationsIdentity);
    } else {
      reusedGenerationIdentity = exportDirectoryIdentity(generation);
      const expected = [[xmlName, sha256Prefixed(args.xml)], [receiptName, sha256Prefixed(`${JSON.stringify(args.receipt, null, 2)}\n`)], ["bake-index.json", sha256Prefixed(`${JSON.stringify(args.bakeIndex, null, 2)}\n`)]] as const;
      for (const [name, hash] of expected) { const file = path.join(generation, name), stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || sha256Prefixed(fs.readFileSync(file)) !== hash) throw new Error("premiere_export_generation_conflict"); }
    }
    const ready = { version: "premiere-export-ready/v1", project_id: args.projectId, base_timeline_sha256: args.baseTimelineSha256, roundtrip_id: args.roundtripId, export_generation_id: args.generationId, xml: { path: path.relative(args.projectPath, path.join(generation, xmlName)).split(path.sep).join("/"), sha256: sha256Prefixed(args.xml) }, receipt: { path: path.relative(args.projectPath, path.join(generation, receiptName)).split(path.sep).join("/"), sha256: sha256Prefixed(fs.readFileSync(path.join(generation, receiptName))) }, bake_index: { path: path.relative(args.projectPath, path.join(generation, "bake-index.json")).split(path.sep).join("/"), sha256: sha256Prefixed(fs.readFileSync(path.join(generation, "bake-index.json"))) }, hardware_verified: false };
    const readyPath = path.join(generation, "READY.json");
    if (fs.existsSync(readyPath)) { const readyStat = fs.lstatSync(readyPath); if (!readyStat.isFile() || readyStat.isSymbolicLink() || readyStat.nlink !== 1) throw new Error("premiere_export_generation_conflict: READY is not regular nlink=1"); const existingReady = JSON.parse(fs.readFileSync(readyPath, "utf8")); if (JSON.stringify(existingReady) !== JSON.stringify(ready)) throw new Error("premiere_export_generation_conflict"); }
    else { const generationIdentity = exportDirectoryIdentity(generation); writeFsync(readyPath, `${JSON.stringify(ready, null, 2)}\n`); assertExportDirectoryIdentity(generation, generationIdentity); }
    if (fs.readdirSync(generation).sort().join("|") !== ["READY.json", "bake-index.json", receiptName, xmlName].sort().join("|")) throw new Error("premiere_export_generation_conflict: generation contents are not exact");
    if (reusedGenerationIdentity) assertExportDirectoryIdentity(generation, reusedGenerationIdentity);
    fsyncDir(generation);
    const current = { version: "premiere-export-current/v1", project_id: args.projectId, base_timeline_sha256: args.baseTimelineSha256, roundtrip_id: args.roundtripId, export_generation_id: args.generationId, ready_path: path.relative(args.projectPath, readyPath).split(path.sep).join("/"), ready_sha256: sha256Prefixed(fs.readFileSync(readyPath)), xml: ready.xml, receipt: ready.receipt, bake_index: ready.bake_index, published_at: new Date().toISOString() };
    const rootIdentity = exportDirectoryIdentity(root), currentTemp = path.join(root, `CURRENT.json.tmp.${invocation}`); writeFsync(currentTemp, `${JSON.stringify(current, null, 2)}\n`); if (reusedGenerationIdentity) assertExportDirectoryIdentity(generation, reusedGenerationIdentity); fs.renameSync(currentTemp, path.join(root, "CURRENT.json")); fsyncDir(root); assertExportDirectoryIdentity(root, rootIdentity);
    const output = path.join(args.projectPath, "09_output"); ensureExportDirectoryTree(args.projectPath, output);
    for (const [name, source] of [[xmlName, path.join(generation, xmlName)], [receiptName, path.join(generation, receiptName)]] as const) { const outputIdentity = exportDirectoryIdentity(output), temp = path.join(output, `${name}.tmp.${invocation}`); writeFsync(temp, fs.readFileSync(source)); fs.renameSync(temp, path.join(output, name)); fsyncDir(output); assertExportDirectoryIdentity(output, outputIdentity); }
    releaseExportClaim(args.claim, true, { version: "premiere-export-claim-release/v1", claim_id: claimId, current_sha256: sha256Prefixed(fs.readFileSync(path.join(root, "CURRENT.json"))), compatibility_xml_sha256: sha256Prefixed(fs.readFileSync(path.join(output, xmlName))), compatibility_receipt_sha256: sha256Prefixed(fs.readFileSync(path.join(output, receiptName))), released_at: new Date().toISOString() });
    return { generation_dir: generation, xml_path: path.join(generation, xmlName), receipt_path: path.join(generation, receiptName), bake_index_path: path.join(generation, "bake-index.json"), ready_path: readyPath, current_path: path.join(root, "CURRENT.json") };
  } catch (error) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  let liveClaim: ExportClaimContext | undefined;
  let revisionTimelineFd: number | undefined;
  try {
    const {
      projectPath: requestedProjectPath, sourceMapPath, titlesPath, autoTitles, preflight,
      bakeVisualEffects, jsonOutput, expectedTimelineSha256, expectedTimelineIdentity,
    } = parseArgs(process.argv);
    const revisionBound = preflight && jsonOutput;
    const projectPath = revisionBound ? requestedProjectPath : fs.realpathSync(requestedProjectPath);

    // Read timeline.json
    const timelinePath = path.join(projectPath, "05_timeline", "timeline.json");
    let rawTimeline: Buffer;
    let timeline: TimelineIR;
    let childUsedTimelineSha256: string | undefined;
    let childUsedTimelineIdentity: PremiereTimelineIdentity | undefined;
    if (revisionBound) {
      let pinned;
      try {
        pinned = openPremiereRevisionBoundTimeline({
          projectPath,
          expectedSha256: expectedTimelineSha256!,
          expectedIdentity: expectedTimelineIdentity!,
        });
      } catch (error) {
        if (error instanceof PremiereTimelineRevisionMismatch) {
          console.log(JSON.stringify({
            version: "premiere-preflight-revision/v1",
            project_id: error.projectId,
            status: "timeline_revision_mismatch",
            expected_timeline_sha256: error.expectedSha256,
            observed_timeline_sha256: error.observedSha256,
            expected_timeline_identity: error.expectedIdentity,
            observed_timeline_identity: error.observedIdentity,
            hardware_verified: false,
            items: [],
          }));
          process.exitCode = 1;
          return;
        }
        throw error;
      }
      revisionTimelineFd = pinned.fd;
      rawTimeline = pinned.rawTimeline;
      timeline = pinned.parsedTimeline as TimelineIR;
      childUsedTimelineSha256 = pinned.sha256;
      childUsedTimelineIdentity = pinned.identity;
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
      const validateTimeline = ajv.compile(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "schemas", "timeline-ir.schema.json"), "utf8")) as object);
      if (!validateTimeline(timeline)) throw new Error(`invalid_preflight_contract: timeline schema mismatch: ${JSON.stringify(validateTimeline.errors ?? [])}`);
    } else {
      if (!fs.existsSync(timelinePath)) {
        console.error(`timeline.json not found: ${timelinePath}`);
        process.exitCode = 1;
        return;
      }
      rawTimeline = fs.readFileSync(timelinePath);
      timeline = JSON.parse(rawTimeline.toString("utf-8")) as TimelineIR;
    }
    const { outputPath } = resolveOutputPaths(
      projectPath,
      timeline.project_id,
    );
    const classifications = classifyPremiereVideoTreatments(timeline);
    const bakeRequired = classifications.filter((entry) => entry.status === "bake_required");
    const hardStatuses = new Set(["busy", "conflict", "unsupported", "source_unverified", "rights_privacy_blocked"]);
    if (preflight) {
      const preflightRunId = randomUUID();
      const preflightItems = jsonOutput
        ? await preflightPremiereEffectBakesBrokered({
          projectPath,
          timeline,
          rawTimeline,
          sourceMapPath,
          broker: new PremierePreflightProcessBroker({
            cwd: path.resolve(import.meta.dirname, ".."),
            preflight_run_id: preflightRunId,
            wrapper2_pid: process.pid,
          }),
          preflightRunId,
          wrapper2Pid: process.pid,
        })
        : preflightPremiereEffectBakes({ projectPath, timeline, rawTimeline, sourceMapPath });
      const hardPreflight = preflightItems.find((item) => hardStatuses.has(item.status));
      const result = {
        mode: "preflight", project_id: timeline.project_id, hardware_verified: false, clips: preflightItems,
        ...(revisionBound ? {
          child_used_timeline_sha256: childUsedTimelineSha256,
          child_used_timeline_identity: childUsedTimelineIdentity,
        } : {}),
      };
      if (jsonOutput) console.log(JSON.stringify(result)); else console.log(JSON.stringify(result, null, 2));
      if (hardPreflight) process.exitCode = 1;
      else if (preflightItems.some((item) => item.status === "bake_required" || item.status === "stale")) process.exitCode = 2;
      return;
    }
    const blocked = classifications.find((entry) => entry.status === "blocked");
    if (blocked?.status === "blocked") throw new Error(blocked.detail);
    if (bakeRequired.length && !bakeVisualEffects) {
      const result = { mode: "export", project_id: timeline.project_id, exported: false, reason: "visual_bake_consent_required", hardware_verified: false, clips: classifications.map((entry) => ({ clip_id: entry.clip_id, track_id: entry.track_id, status: entry.status })) };
      if (jsonOutput) console.log(JSON.stringify(result)); else console.error(`visual_bake_consent_required: ${bakeRequired.length} clip(s) require --bake-visual-effects`);
      process.exitCode = 2; return;
    }
    const preflightItems = preflightPremiereEffectBakes({ projectPath, timeline, rawTimeline, sourceMapPath });
    const hardPreflight = preflightItems.find((item) => hardStatuses.has(item.status));
    if (hardPreflight) throw new Error(`${hardPreflight.status}: ${hardPreflight.reason ?? hardPreflight.clip_id}`);
    const baseTimelineSha256 = sha256Prefixed(rawTimeline);
    liveClaim = acquireExportClaim(projectPath, timeline.project_id, baseTimelineSha256);
    const lockedRawTimeline = fs.readFileSync(timelinePath);
    if (sha256Prefixed(lockedRawTimeline) !== baseTimelineSha256) throw new Error("premiere_export_conflict: timeline changed before claim");
    const lockedPreflight = preflightPremiereEffectBakes({ projectPath, timeline, rawTimeline: lockedRawTimeline, sourceMapPath });
    const lockedHard = lockedPreflight.find((item) => hardStatuses.has(item.status));
    if (lockedHard) throw new Error(`${lockedHard.status}: ${lockedHard.reason ?? lockedHard.clip_id}`);
    if (!jsonOutput) console.log(`Timeline: ${timeline.sequence.name}`);

    // Resolve source map
    const { locatorMap: sourceMap, displayNameMap } = resolveSourceMap(projectPath, sourceMapPath);
    if (sourceMap.size === 0) {
      throw new Error("No source map entries found. Cannot produce valid Premiere XML without media references. Use --source-map <file.json> or generate 02_media/source_map.json via scripts/analyze.ts.");
    } else {
      if (!jsonOutput) console.log(`  Source map: ${sourceMap.size} entries`);
    }

    // Resolve text overlays
    const textOverlays = resolveTextOverlays(timeline, titlesPath, autoTitles);

    // Export
    const prepared = bakeRequired.length ? preparePremiereEffectBakes({ projectPath, timeline, rawTimeline: lockedRawTimeline, sourceMapPath }) : { representations: new Map(), index: { version: "premiere-effect-bake-index/v1" as const, project_id: timeline.project_id, base_timeline_sha256: baseTimelineSha256, entries: [] }, cache_results: [] };
    const maps = createBakedClipMaps(timeline, prepared.representations);
    const bakeIndexRaw = Buffer.from(`${JSON.stringify(prepared.index, null, 2)}\n`);
    const roundtripId = maps.length ? derivePremiereRoundtripIdV2(timeline.project_id, baseTimelineSha256, sha256Prefixed(bakeIndexRaw), maps) : derivePremiereRoundtripId(timeline.project_id, baseTimelineSha256);
    const xml = timelineToFcp7Xml(timeline, {
      sourceMap,
      textOverlays,
      legacyTitlesRequested: Boolean(titlesPath || autoTitles),
      assetDisplayNameMap: displayNameMap.size > 0 ? displayNameMap : undefined,
      projectId: timeline.project_id,
      roundtripId,
      videoRepresentations: prepared.representations,
    });
    const rawXml = Buffer.from(xml, "utf-8");
    const generationId = derivePremiereExportGenerationId(timeline.project_id, baseTimelineSha256, roundtripId, sha256Prefixed(rawXml), sha256Prefixed(bakeIndexRaw));
    const generationBase = `09_output/premiere-exports/generations/${generationId.slice(7)}`;
    const receipt = maps.length ? createPremiereRoundtripReceiptV2({ projectId: timeline.project_id, rawTimeline, rawExportedXml: rawXml, exportedXmlPath: `${generationBase}/${path.basename(outputPath)}`, bakeIndex: prepared.index, bakeIndexPath: `${generationBase}/bake-index.json`, bakedClipMaps: maps }) : createPremiereRoundtripReceipt(timeline.project_id, rawTimeline, path.basename(outputPath), rawXml);
    const published = publishExportGeneration({ projectPath, projectId: timeline.project_id, baseTimelineSha256, roundtripId, generationId, xml: rawXml, receipt, bakeIndex: prepared.index, claim: liveClaim });
    liveClaim = undefined;
    const result = { mode: "export", exported: true, project_id: timeline.project_id, roundtrip_id: roundtripId, export_generation_id: generationId, hardware_verified: false, generation: published, cache_results: prepared.cache_results };
    if (jsonOutput) console.log(JSON.stringify(result)); else { console.log(`Exported: ${published.xml_path}`); console.log(`Receipt: ${published.receipt_path}`); }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[export-premiere-xml] ${message}`);
    console.error(USAGE);
    process.exitCode = 1;
  } finally {
    if (liveClaim) releaseExportClaim(liveClaim, false);
    if (revisionTimelineFd !== undefined) fs.closeSync(revisionTimelineFd);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  void main();
}
