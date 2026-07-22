import * as fs from "node:fs";
import * as path from "node:path";
import type { AssetItem } from "../connectors/ffprobe.js";
import { MEDIA_KIND_REGISTRY, type ConsumerImpact, type MediaKind } from "../media/media-kind-registry.js";
import type { DiscoveredSourceRequest, SourceDiscoveryResult } from "../media/source-discovery.js";
import { atomicWriteJson } from "../pipeline/stages/_util.js";

export const SOURCE_LEDGER_RELATIVE_PATH = "03_analysis/source_ledger.json";

export interface SourceLedgerItem {
  source_id: string;
  requested_locator: string;
  canonical_locator: string | null;
  media_kind: MediaKind;
  status: "ready" | "unsupported" | "failed";
  stage: string;
  reason: string | null;
  consumer_impact: ConsumerImpact;
  content_hash: string | null;
  fingerprint: string | null;
  canonical_asset_id: string | null;
  size_bytes: number | null;
  mtime: string | null;
  canonical_request_source_id: string | null;
}

export interface SourceLedger {
  version: "1.0.0";
  artifact_version: "source-ledger-v1";
  project_id: string;
  created_at: string;
  hidden_sidecar_policy: string;
  summary: {
    requested: number;
    ready: number;
    unsupported: number;
    failed: number;
  };
  items: SourceLedgerItem[];
}

export interface SourceIngestOutcome {
  canonicalPath: string;
  asset?: AssetItem;
  mediaKind?: MediaKind;
  error?: string;
}

export function buildSourceLedger(
  projectId: string,
  discovery: SourceDiscoveryResult,
  outcomes: Map<string, SourceIngestOutcome> = new Map(),
  createdAt = new Date().toISOString(),
  projectDir?: string,
): SourceLedger {
  const items = discovery.requests.map((request) => ledgerItemFromRequest(request, outcomes, projectDir));
  const ledger: SourceLedger = {
    version: "1.0.0",
    artifact_version: "source-ledger-v1",
    project_id: projectId,
    created_at: createdAt,
    hidden_sidecar_policy: discovery.hidden_policy,
    summary: summarize(items),
    items,
  };
  assertSourceLedgerEquation(ledger);
  return ledger;
}

export function validateSourceLedger(value: unknown): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  if (!value || typeof value !== "object") return { valid: false, violations: ["ledger must be an object"] };
  const ledger = value as Partial<SourceLedger>;
  if (!Array.isArray(ledger.items)) violations.push("items must be an array");
  const summary = ledger.summary;
  if (!summary) {
    violations.push("summary is required");
  } else if (summary.requested !== summary.ready + summary.unsupported + summary.failed) {
    violations.push("summary.requested must equal ready + unsupported + failed");
  }
  if (Array.isArray(ledger.items) && summary) {
    const actual = summarize(ledger.items);
    for (const key of ["requested", "ready", "unsupported", "failed"] as const) {
      if (summary[key] !== actual[key]) violations.push(`summary.${key} does not match items`);
    }
    for (const [index, item] of ledger.items.entries()) {
      if (item.status === "ready" && (!item.canonical_asset_id || !item.fingerprint)) {
        violations.push(`items/${index} ready requires canonical_asset_id and fingerprint`);
      }
    }
  }
  return { valid: violations.length === 0, violations };
}

export function validateSourceLedgerArtifact(
  value: unknown,
  schemaValidator: ((value: unknown) => boolean) & { errors?: unknown[] | null },
): { valid: boolean; violations: string[]; schemaErrors: unknown[] } {
  const schemaValid = schemaValidator(value);
  const runtime = validateSourceLedger(value);
  return {
    valid: schemaValid && runtime.valid,
    violations: runtime.violations,
    schemaErrors: schemaValid ? [] : [...(schemaValidator.errors ?? [])],
  };
}

export function assertSourceLedgerEquation(ledger: SourceLedger): void {
  const validation = validateSourceLedger(ledger);
  if (!validation.valid) throw new Error(`Invalid source ledger: ${validation.violations.join("; ")}`);
}

export function writeSourceLedger(projectDir: string, ledger: SourceLedger): string {
  assertSourceLedgerEquation(ledger);
  const outputPath = path.join(projectDir, SOURCE_LEDGER_RELATIVE_PATH);
  atomicWriteJson(outputPath, ledger);
  return outputPath;
}

export function readSourceLedger(projectDir: string): SourceLedger | undefined {
  const filePath = path.join(projectDir, SOURCE_LEDGER_RELATIVE_PATH);
  if (!fs.existsSync(filePath)) return undefined;
  const ledger = JSON.parse(fs.readFileSync(filePath, "utf-8")) as SourceLedger;
  assertSourceLedgerEquation(ledger);
  return ledger;
}

function ledgerItemFromRequest(
  request: DiscoveredSourceRequest,
  outcomes: Map<string, SourceIngestOutcome>,
  projectDir?: string,
): SourceLedgerItem {
  const outcome = request.canonical_path ? outcomes.get(request.canonical_path) : undefined;
  const status = request.disposition === "unsupported"
    ? "unsupported"
    : request.disposition === "failed" || !outcome?.asset
      ? "failed"
      : "ready";
  const rawReason = status === "ready"
    ? request.reason
    : request.reason ?? outcome?.error ?? "ingest_not_completed";
  const reason = redactArtifactReason(rawReason, request, projectDir);
  const mediaKind = outcome?.asset?.media_kind ?? outcome?.mediaKind ?? request.media_kind;
  return {
    source_id: request.source_id,
    requested_locator: artifactLocator(request.requested_locator, projectDir),
    canonical_locator: request.canonical_path ? artifactLocator(request.canonical_path, projectDir) : null,
    media_kind: mediaKind,
    status,
    stage: status === "ready" ? "ingest" : request.disposition === "candidate" ? "ingest" : request.stage,
    reason,
    consumer_impact: status === "ready"
      ? MEDIA_KIND_REGISTRY[mediaKind].consumerImpact
      : status === "unsupported"
        ? request.consumer_impact
        : "planning_block",
    content_hash: request.content_hash,
    fingerprint: outcome?.asset?.source_fingerprint ?? null,
    canonical_asset_id: outcome?.asset?.asset_id ?? null,
    size_bytes: request.size_bytes,
    mtime: request.mtime,
    canonical_request_source_id: request.canonical_request_source_id,
  };
}

function redactArtifactReason(
  reason: string | null,
  request: DiscoveredSourceRequest,
  projectDir?: string,
): string | null {
  if (!reason) return reason;
  let redacted = reason;
  const paths = [request.canonical_path, request.lexical_path, request.requested_locator]
    .filter((value): value is string => !!value && path.isAbsolute(value))
    .sort((a, b) => b.length - a.length);
  for (const absolutePath of paths) {
    redacted = redacted.split(absolutePath).join(artifactLocator(absolutePath, projectDir));
  }
  return redacted;
}

function artifactLocator(locator: string, projectDir?: string): string {
  if (locator.startsWith("external://")) return locator;
  if (!projectDir && !path.isAbsolute(locator)) return path.normalize(locator).split(path.sep).join("/");
  const absolute = path.isAbsolute(locator)
    ? path.resolve(locator)
    : path.resolve(projectDir ?? process.cwd(), locator);
  if (projectDir) {
    const relative = path.relative(path.resolve(projectDir), absolute);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      return (relative || ".").split(path.sep).join("/");
    }
  }
  return `external://${path.basename(absolute)}`;
}

function summarize(items: SourceLedgerItem[]): SourceLedger["summary"] {
  return {
    requested: items.length,
    ready: items.filter((item) => item.status === "ready").length,
    unsupported: items.filter((item) => item.status === "unsupported").length,
    failed: items.filter((item) => item.status === "failed").length,
  };
}
