import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyMediaKind,
  type ConsumerImpact,
  type MediaKind,
} from "./media-kind-registry.js";
import { sha256FileUri } from "../source-content-identity.js";

export const DIRECTORY_SCAN_HIDDEN_POLICY = "exclude-dot-prefixed-files-and-directories" as const;

export type DiscoveryDisposition = "candidate" | "unsupported" | "failed";

export interface DiscoveredSourceRequest {
  source_id: string;
  requested_locator: string;
  lexical_path: string;
  canonical_path: string | null;
  media_kind: MediaKind;
  disposition: DiscoveryDisposition;
  stage: "discovery" | "capability";
  reason: string | null;
  consumer_impact: ConsumerImpact;
  content_hash: string | null;
  size_bytes: number | null;
  mtime: string | null;
  mtime_ms: number | null;
  is_symlink: boolean;
  canonical_request_source_id: string | null;
  /** Non-null only for files reached through an explicitly requested directory scan. */
  sequence_grouping_root: string | null;
}

export interface DiscoverySummary {
  requested: number;
  candidate: number;
  unsupported: number;
  failed: number;
  by_media_kind: Record<MediaKind, number>;
}

export interface SourceDiscoveryResult {
  requests: DiscoveredSourceRequest[];
  summary: DiscoverySummary;
  hidden_policy: typeof DIRECTORY_SCAN_HIDDEN_POLICY;
}

interface EnumeratedRequest {
  requestedLocator: string;
  lexicalPath: string;
  containmentRoot: string;
  forcedFailure?: string;
  sequenceGroupingRoot: string | null;
}

export interface SourceDiscoveryOptions {
  hashFile?: (filePath: string) => string;
  readDirectory?: (dirPath: string) => fs.Dirent[];
}

export function normalizeSourceLocators(locators: string[], baseDir = process.cwd()): string[] {
  return locators.map((locator) => locator.startsWith("external://")
    ? locator
    : path.isAbsolute(locator)
      ? path.normalize(locator)
      : path.resolve(baseDir, locator));
}

export function discoverRequestedSources(
  locators: string[],
  options: SourceDiscoveryOptions = {},
): SourceDiscoveryResult {
  const enumerated: EnumeratedRequest[] = [];
  for (const locator of locators) {
    if (locator.startsWith("external://")) {
      enumerated.push({
        requestedLocator: locator,
        lexicalPath: locator,
        containmentRoot: process.cwd(),
        sequenceGroupingRoot: null,
        forcedFailure: "external_locator_not_materialized",
      });
      continue;
    }
    const lexicalPath = path.resolve(locator);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(lexicalPath);
    } catch {
      // Missing explicit requests are handled below and never dropped.
    }
    const followsToDirectory = stat?.isDirectory() || (stat?.isSymbolicLink() && safeIsDirectory(lexicalPath));
    if (followsToDirectory) {
      enumerated.push(...enumerateDirectory(locator, lexicalPath, options));
    } else {
      enumerated.push({
        requestedLocator: locator,
        lexicalPath,
        containmentRoot: path.dirname(lexicalPath),
        sequenceGroupingRoot: null,
      });
    }
  }

  enumerated.sort((a, b) =>
    binaryCompare(a.lexicalPath, b.lexicalPath) || binaryCompare(a.requestedLocator, b.requestedLocator)
  );
  const sourceIdCounts = new Map<string, number>();
  const canonicalOwners = new Map<string, string>();
  const canonicalFacts = new Map<string, { contentHash: string; sizeBytes: number; mtime: string; mtimeMs: number }>();
  const requests = enumerated.map((entry) => inspectRequest(entry, sourceIdCounts, canonicalOwners, canonicalFacts, options));
  return {
    requests,
    summary: summarizeDiscovery(requests),
    hidden_policy: DIRECTORY_SCAN_HIDDEN_POLICY,
  };
}

function safeIsDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function enumerateDirectory(
  requestedRoot: string,
  root: string,
  options: SourceDiscoveryOptions,
): EnumeratedRequest[] {
  const output: EnumeratedRequest[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = (options.readDirectory ?? readDirectoryEntries)(dir)
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => binaryCompare(a.name, b.name));
    } catch (error) {
      output.push({
        requestedLocator: path.join(requestedRoot, path.relative(root, dir)),
        lexicalPath: dir,
        containmentRoot: root,
        forcedFailure: `directory_read_failed:${errorMessage(error)}`,
        sequenceGroupingRoot: root,
      });
      return;
    }
    for (const entry of entries) {
      const lexicalPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(lexicalPath);
      } else {
        output.push({
          requestedLocator: path.join(requestedRoot, path.relative(root, lexicalPath)),
          lexicalPath,
          containmentRoot: root,
          sequenceGroupingRoot: root,
        });
      }
    }
  };
  visit(root);
  return output;
}

function readDirectoryEntries(dirPath: string): fs.Dirent[] {
  return fs.readdirSync(dirPath, { withFileTypes: true });
}

function inspectRequest(
  entry: EnumeratedRequest,
  sourceIdCounts: Map<string, number>,
  canonicalOwners: Map<string, string>,
  canonicalFacts: Map<string, { contentHash: string; sizeBytes: number; mtime: string; mtimeMs: number }>,
  options: SourceDiscoveryOptions,
): DiscoveredSourceRequest {
  const sourceId = allocateSourceId(entry.requestedLocator, sourceIdCounts);
  const registration = classifyMediaKind(entry.lexicalPath);
  const base = {
    source_id: sourceId,
    requested_locator: entry.requestedLocator,
    lexical_path: entry.lexicalPath,
    media_kind: registration.kind,
    sequence_grouping_root: entry.sequenceGroupingRoot,
  };
  if (entry.forcedFailure) return failed(base, entry.forcedFailure);
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(entry.lexicalPath);
  } catch (error) {
    return failed(base, `missing_or_unreadable:${errorMessage(error)}`);
  }

  const isSymlink = lstat.isSymbolicLink();
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(entry.lexicalPath);
  } catch (error) {
    return failed(base, `broken_symlink_or_unreadable:${errorMessage(error)}`, isSymlink);
  }
  if (!isContained(entry.containmentRoot, entry.lexicalPath) || !isContained(fs.realpathSync(entry.containmentRoot), canonicalPath)) {
    return failed(base, "source_path_escapes_requested_root", isSymlink, canonicalPath);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonicalPath);
  } catch (error) {
    return failed(base, `unreadable:${errorMessage(error)}`, isSymlink, canonicalPath);
  }
  if (!stat.isFile()) {
    return failed(base, "not_a_regular_file", isSymlink, canonicalPath);
  }

  let facts = canonicalFacts.get(canonicalPath);
  if (!facts) {
    try {
      facts = {
        contentHash: (options.hashFile ?? sha256FileUri)(canonicalPath),
        sizeBytes: stat.size,
        mtime: stat.mtime.toISOString(),
        mtimeMs: Math.round(stat.mtimeMs),
      };
    } catch (error) {
      return failed(base, `content_hash_failed:${errorMessage(error)}`, isSymlink, canonicalPath);
    }
    canonicalFacts.set(canonicalPath, facts);
  }
  const canonicalOwner = canonicalOwners.get(canonicalPath) ?? null;
  if (!canonicalOwner) canonicalOwners.set(canonicalPath, sourceId);
  const common = {
    ...base,
    canonical_path: canonicalPath,
    content_hash: facts.contentHash,
    size_bytes: facts.sizeBytes,
    mtime: facts.mtime,
    mtime_ms: facts.mtimeMs,
    is_symlink: isSymlink,
    canonical_request_source_id: canonicalOwner,
  };
  if (!registration.capabilities.ingest) {
    return {
      ...common,
      disposition: "unsupported",
      stage: "capability",
      reason: registration.unsupportedReason,
      consumer_impact: registration.consumerImpact,
    };
  }
  return {
    ...common,
    disposition: "candidate",
    stage: "discovery",
    reason: registration.consumerImpact !== "none"
      ? registration.unsupportedReason
      : canonicalOwner
        ? `canonical_alias_of:${canonicalOwner}`
        : null,
    consumer_impact: registration.consumerImpact,
  };
}

function failed(
  base: {
    source_id: string;
    requested_locator: string;
    lexical_path: string;
    media_kind: MediaKind;
    sequence_grouping_root: string | null;
  },
  reason: string,
  isSymlink = false,
  canonicalPath: string | null = null,
): DiscoveredSourceRequest {
  return {
    ...base,
    canonical_path: canonicalPath,
    disposition: "failed",
    stage: "discovery",
    reason,
    consumer_impact: "planning_block",
    content_hash: null,
    size_bytes: null,
    mtime: null,
    mtime_ms: null,
    is_symlink: isSymlink,
    canonical_request_source_id: null,
    sequence_grouping_root: base.sequence_grouping_root,
  };
}

function allocateSourceId(locator: string, counts: Map<string, number>): string {
  const normalized = path.normalize(locator).normalize("NFC");
  const ordinal = counts.get(normalized) ?? 0;
  counts.set(normalized, ordinal + 1);
  const identity = ordinal === 0 ? normalized : `${normalized}\0${ordinal}`;
  return `SRC_${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16).toUpperCase()}`;
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function summarizeDiscovery(requests: DiscoveredSourceRequest[]): DiscoverySummary {
  const byMediaKind: Record<MediaKind, number> = { video: 0, audio: 0, image: 0, sequence: 0, unknown: 0 };
  for (const request of requests) byMediaKind[request.media_kind] += 1;
  return {
    requested: requests.length,
    candidate: requests.filter((request) => request.disposition === "candidate").length,
    unsupported: requests.filter((request) => request.disposition === "unsupported").length,
    failed: requests.filter((request) => request.disposition === "failed").length,
    by_media_kind: byMediaKind,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function binaryCompare(left: string, right: string): number {
  const a = left.normalize("NFC");
  const b = right.normalize("NFC");
  return a < b ? -1 : a > b ? 1 : 0;
}
