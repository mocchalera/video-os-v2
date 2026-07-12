import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RunnerValidationResult {
  valid: boolean;
  violations: string[];
}

export interface SourceMediaManifestItem {
  asset_id: string;
  source_locator: string;
  filename: string;
  content_hash: string | null;
  fingerprint: string | null;
  size_bytes: number;
  mtime: string;
  media_kind: "video" | "audio" | "image" | "sequence" | "unknown";
  ingest_status: "ready" | "missing" | "stale" | "unsupported" | "excluded";
  rights_status: "unknown" | "operator_declared_ok" | "licensed" | "restricted" | "blocked";
  privacy_status: "unknown" | "operator_declared_ok" | "contains_people" | "sensitive" | "blocked";
  analysis_policy_ref: string;
  capture_started_at: string | null;
  capture_timezone: string | null;
  timecode_start: string | null;
  timecode_format: "none" | "non_drop" | "drop_frame" | "inferred" | "unknown";
  sample_rate: number | null;
  duration_us: number | null;
  frame_rate_mode: "cfr" | "vfr" | "audio_only" | "unknown";
  rotation: 0 | 90 | 180 | 270 | null;
  audio_video_offset_ms: number | null;
  clock_source: "file_metadata" | "timecode_track" | "operator_declared" | "inferred" | "unknown";
}

export interface SourceMediaManifest {
  version: "1.0.0";
  project_id: string;
  artifact_version: "manifest-v1";
  created_at: string;
  source_root: {
    locator: string;
    locator_kind: "local_path" | "symlink" | "external_drive" | "cloud_uri" | "mixed";
  };
  items: SourceMediaManifestItem[];
  provenance: {
    producer: "init-project" | "analysis-ingest" | "ingest-command";
    inputs: Array<{ path: string; hash: string }>;
    hash_policy: {
      algorithm: "sha256";
      canonicalization: "normalized-json-v1";
      excluded_fields: string[];
    };
  };
}

export interface LaneStatus {
  lane_id: string;
  status: "pending" | "ready" | "partial" | "skipped" | "failed" | "waived";
  required: boolean;
  reason?: string | null;
  consumer_impact: string;
  asset_ids: string[];
  artifact_hash?: string | null;
}

export interface AnalysisCoverageReport {
  version: "1.0.0";
  project_id: string;
  artifact_version: "analysis-v1";
  created_at: string;
  source_media_manifest_hash: string;
  summary: {
    status: "ready" | "partial_override" | "blocked";
    required_lane_count: number;
    ready_lane_count: number;
    blocked_lane_count: number;
    partial_lane_count: number;
  };
  lanes: LaneStatus[];
  assets: Array<{
    asset_id: string;
    status: "ready" | "partial" | "blocked" | "excluded";
    lanes: LaneStatus[];
  }>;
  blockers: Array<{
    blocker_id: string;
    severity: "warning" | "blocker";
    lane_id: string;
    asset_ids: string[];
    message: string;
  }>;
  overrides: Array<{
    override_id: string;
    status: "active" | "stale" | "expired";
    scope: string;
    approved_by: string;
    approved_at: string;
    expires_at?: string | null;
    applies_to_artifact_hash?: string | null;
  }>;
  provenance: {
    producer: "scripts/analyze.ts" | "analysis-pipeline";
    inputs: Array<Record<string, unknown>>;
    hash_policy: Record<string, unknown>;
  };
}

const MEDIA_EXTENSIONS = new Map<string, SourceMediaManifestItem["media_kind"]>([
  [".mov", "video"],
  [".mp4", "video"],
  [".m4v", "video"],
  [".avi", "video"],
  [".mkv", "video"],
  [".wav", "audio"],
  [".mp3", "audio"],
  [".m4a", "audio"],
  [".aac", "audio"],
  [".jpg", "image"],
  [".jpeg", "image"],
  [".png", "image"],
  [".heic", "image"],
]);

export function isP1ManifestCoverageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ENABLE_P1_MANIFEST_COVERAGE ?? env.ENABLE_P1_MANIFEST ?? "";
  return /^(1|true|yes|on)$/i.test(raw);
}

export function normalizeJsonValue(value: unknown, excludedFields: string[] = []): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item, excludedFields));
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (excludedFields.includes(key)) continue;
    result[key.normalize("NFC")] = normalizeJsonValue(source[key], excludedFields);
  }
  return result;
}

export function computeNormalizedJsonHash(value: unknown, excludedFields: string[] = []): string {
  const normalized = JSON.stringify(normalizeJsonValue(value, excludedFields));
  return `sha256:${crypto.createHash("sha256").update(normalized, "utf-8").digest("hex")}`;
}

export function validateSourceMediaManifest(data: unknown): RunnerValidationResult {
  const violations: string[] = [];
  const manifest = data as Partial<SourceMediaManifest>;
  if (!Array.isArray(manifest.items)) {
    violations.push("items must be an array");
  } else {
    manifest.items.forEach((item, index) => {
      if (!item.content_hash && !item.fingerprint) {
        violations.push(`items/${index} must have content_hash or fingerprint`);
      }
    });
  }
  return { valid: violations.length === 0, violations };
}

export function validateAnalysisCoverageReport(data: unknown): RunnerValidationResult {
  const violations: string[] = [];
  const report = data as Partial<AnalysisCoverageReport>;
  const lanes = Array.isArray(report.lanes) ? report.lanes : [];
  const sourceLane = lanes.find((lane) => lane.lane_id === "source_manifest");
  const requiredBlocked = lanes.filter((lane) =>
    lane.required && ["pending", "partial", "skipped", "failed"].includes(lane.status)
  );

  if (report.summary?.status === "ready") {
    if (!sourceLane || sourceLane.status !== "ready") {
      violations.push("ready coverage requires source_manifest lane ready");
    }
    if (requiredBlocked.length > 0) {
      violations.push("ready coverage cannot include blocked required lanes");
    }
  }

  if (report.summary?.status === "partial_override") {
    const hasActiveOverride = Array.isArray(report.overrides) &&
      report.overrides.some((override) => override.status === "active");
    if (!hasActiveOverride) {
      violations.push("partial_override coverage requires an active override");
    }
  }

  for (const lane of lanes) {
    if (lane.status === "skipped" && !lane.reason) {
      violations.push(`skipped lane ${lane.lane_id} requires reason`);
    }
  }

  return { valid: violations.length === 0, violations };
}

export interface BuildManifestOptions {
  projectDir: string;
  projectId: string;
  sourceFiles?: string[];
  sourceRoot?: string;
  sourceRootKind?: SourceMediaManifest["source_root"]["locator_kind"];
  producer?: SourceMediaManifest["provenance"]["producer"];
  createdAt?: string;
}

export function buildSourceMediaManifest(options: BuildManifestOptions): SourceMediaManifest {
  const projectDir = path.resolve(options.projectDir);
  const sourceFiles = collectSourceFiles(options.sourceFiles ?? [], options.sourceRoot);
  const sourceRoot = options.sourceRoot
    ? path.resolve(options.sourceRoot)
    : inferSourceRoot(sourceFiles, projectDir);
  const sourceRootLocator = path.relative(projectDir, sourceRoot) || ".";
  const items = sourceFiles.map((filePath) => sourceFileToManifestItem(projectDir, filePath));
  const rootHash = computeNormalizedJsonHash(sourceFiles.map((filePath) => ({
    path: path.relative(projectDir, filePath),
    hash: sha256File(filePath),
  })));

  return {
    version: "1.0.0",
    project_id: options.projectId,
    artifact_version: "manifest-v1",
    created_at: options.createdAt ?? new Date().toISOString(),
    source_root: {
      locator: sourceRootLocator,
      locator_kind: options.sourceRootKind ?? "local_path",
    },
    items,
    provenance: {
      producer: options.producer ?? "analysis-ingest",
      inputs: [{ path: sourceRootLocator, hash: rootHash }],
      hash_policy: {
        algorithm: "sha256",
        canonicalization: "normalized-json-v1",
        excluded_fields: ["created_at"],
      },
    },
  };
}

export function writeSourceMediaManifest(options: BuildManifestOptions): SourceMediaManifest {
  const manifest = buildSourceMediaManifest(options);
  const outPath = path.join(options.projectDir, "02_media/source_media_manifest.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return manifest;
}

export interface BuildCoverageOptions {
  projectId: string;
  manifest: unknown;
  createdAt?: string;
}

export function buildAnalysisCoverageReport(options: BuildCoverageOptions): AnalysisCoverageReport {
  const manifest = options.manifest as SourceMediaManifest;
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const manifestHash = computeNormalizedJsonHash(manifest, manifest.provenance?.hash_policy?.excluded_fields ?? []);
  const blockedItems = items.filter((item) => item.ingest_status === "missing" || item.ingest_status === "stale");
  const readyItems = items.filter((item) => item.ingest_status === "ready");
  const excludedItems = items.filter((item) => item.ingest_status === "excluded" || item.ingest_status === "unsupported");
  const sourceStatus: LaneStatus["status"] = blockedItems.length > 0 ? "failed" : "ready";
  const lanes: LaneStatus[] = [
    {
      lane_id: "source_manifest",
      status: sourceStatus,
      required: true,
      reason: blockedItems.length > 0 ? "manifest contains missing or stale sources" : null,
      consumer_impact: blockedItems.length > 0 ? "planning_block" : "none",
      asset_ids: items.map((item) => item.asset_id),
      artifact_hash: manifestHash,
    },
    {
      lane_id: "ffprobe",
      status: readyItems.length > 0 ? "ready" : "pending",
      required: true,
      reason: readyItems.length > 0 ? null : "no ready source items to probe",
      consumer_impact: readyItems.length > 0 ? "none" : "planning_block",
      asset_ids: readyItems.map((item) => item.asset_id),
      artifact_hash: null,
    },
  ];
  const blockers = blockedItems.map((item) => ({
    blocker_id: `COVBLK_${item.asset_id.replace(/^AST_/, "")}`,
    severity: "blocker" as const,
    lane_id: "source_manifest",
    asset_ids: [item.asset_id],
    message: `Source ${item.asset_id} is ${item.ingest_status}`,
  }));
  const requiredLanes = lanes.filter((lane) => lane.required);
  const blockedLaneCount = requiredLanes.filter((lane) => ["pending", "partial", "skipped", "failed"].includes(lane.status)).length;
  const readyLaneCount = requiredLanes.filter((lane) => lane.status === "ready").length;
  const status = blockedLaneCount > 0 ? "blocked" : "ready";

  return {
    version: "1.0.0",
    project_id: options.projectId,
    artifact_version: "analysis-v1",
    created_at: options.createdAt ?? new Date().toISOString(),
    source_media_manifest_hash: manifestHash,
    summary: {
      status,
      required_lane_count: requiredLanes.length,
      ready_lane_count: readyLaneCount,
      blocked_lane_count: blockedLaneCount,
      partial_lane_count: requiredLanes.filter((lane) => lane.status === "partial").length,
    },
    lanes,
    assets: [
      ...readyItems.map((item) => ({
        asset_id: item.asset_id,
        status: "ready" as const,
        lanes,
      })),
      ...blockedItems.map((item) => ({
        asset_id: item.asset_id,
        status: "blocked" as const,
        lanes: lanes.filter((lane) => lane.asset_ids.includes(item.asset_id)),
      })),
      ...excludedItems.map((item) => ({
        asset_id: item.asset_id,
        status: "excluded" as const,
        lanes: [],
      })),
    ],
    blockers,
    overrides: [],
    provenance: {
      producer: "scripts/analyze.ts",
      inputs: [
        {
          path: "02_media/source_media_manifest.json",
          hash: manifestHash,
        },
      ],
      hash_policy: {
        algorithm: "sha256",
        canonicalization: "normalized-json-v1",
        excluded_fields: ["created_at"],
      },
    },
  };
}

export function writeAnalysisCoverageReport(projectDir: string, report: AnalysisCoverageReport): void {
  const outPath = path.join(projectDir, "03_analysis/analysis_coverage_report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

export function readCoverageSummary(projectDir: string): {
  status: string;
  requiredLaneCount: number;
  readyLaneCount: number;
  blockedLaneCount: number;
  partialLaneCount: number;
  reportPath: string;
} | undefined {
  const reportPath = path.join(projectDir, "03_analysis/analysis_coverage_report.json");
  if (!fs.existsSync(reportPath)) return undefined;
  const report = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as AnalysisCoverageReport;
  return {
    status: report.summary.status,
    requiredLaneCount: report.summary.required_lane_count,
    readyLaneCount: report.summary.ready_lane_count,
    blockedLaneCount: report.summary.blocked_lane_count,
    partialLaneCount: report.summary.partial_lane_count,
    reportPath,
  };
}

function collectSourceFiles(sourceFiles: string[], sourceRoot?: string): string[] {
  const files = sourceFiles.length > 0
    ? sourceFiles
    : sourceRoot
      ? collectFilesRecursive(sourceRoot)
      : [];
  return files
    .map((filePath) => path.resolve(filePath))
    .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
    .sort((a, b) => a.localeCompare(b));
}

function collectFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFilesRecursive(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function inferSourceRoot(sourceFiles: string[], projectDir: string): string {
  if (sourceFiles.length === 0) return path.join(projectDir, "02_media/source");
  if (sourceFiles.length === 1) return path.dirname(sourceFiles[0]);
  return commonDir(sourceFiles.map((filePath) => path.dirname(filePath)));
}

function commonDir(dirs: string[]): string {
  const parts = dirs.map((dir) => path.resolve(dir).split(path.sep));
  const first = parts[0] ?? [];
  let end = first.length;
  for (const current of parts.slice(1)) {
    end = Math.min(end, current.length);
    for (let i = 0; i < end; i++) {
      if (first[i] !== current[i]) {
        end = i;
        break;
      }
    }
  }
  return first.slice(0, end).join(path.sep) || path.sep;
}

function sourceFileToManifestItem(projectDir: string, filePath: string): SourceMediaManifestItem {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mediaKind = MEDIA_EXTENSIONS.get(ext) ?? "unknown";
  const excluded = mediaKind === "unknown";
  const assetId = `AST_${sanitizeId(path.basename(filePath, ext))}_${sha256Text(path.relative(projectDir, filePath)).slice(0, 8)}`;

  return {
    asset_id: assetId,
    source_locator: path.relative(projectDir, filePath),
    filename: path.basename(filePath),
    content_hash: sha256File(filePath),
    fingerprint: null,
    size_bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    media_kind: mediaKind,
    ingest_status: excluded ? "excluded" : "ready",
    rights_status: "unknown",
    privacy_status: "unknown",
    analysis_policy_ref: "APOL_default",
    capture_started_at: null,
    capture_timezone: null,
    timecode_start: null,
    timecode_format: "none",
    sample_rate: mediaKind === "audio" || mediaKind === "video" ? 48000 : null,
    duration_us: null,
    frame_rate_mode: mediaKind === "audio" ? "audio_only" : "unknown",
    rotation: mediaKind === "video" || mediaKind === "image" ? 0 : null,
    audio_video_offset_ms: null,
    clock_source: "unknown",
  };
}

function sha256File(filePath: string): string {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function sanitizeId(value: string): string {
  const sanitized = value.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "source";
}
