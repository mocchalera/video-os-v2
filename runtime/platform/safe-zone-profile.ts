import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { validateArtifact } from "../artifacts/loaders.js";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";

export type PlatformName = "instagram" | "tiktok" | "youtube_shorts" | "fixture";
export type PlatformSurface = "organic" | "ads" | "fixture";
export type ProfileEvidenceStatus = "verified" | "partial" | "unavailable" | "stale";
export interface RegionRect { x: number; y: number; width: number; height: number }
export interface SafeZoneRegion { id: string; kind: "ui" | "safe" | "caption" | "content" | "profile_overlay"; rect: RegionRect; method: string; confidence: "high" | "medium" | "low" }
export interface PlatformSafeZoneProfile {
  version: "platform-safe-zone-profile/v1";
  profile_id: string;
  platform: PlatformName;
  surface: PlatformSurface;
  delivery_variant: string;
  evidence_status: ProfileEvidenceStatus;
  source_references: Array<{ url: string; retrieved_at: string; published_date: string | null; owner: string; evidence_kind: "official_documentation" | "current_measurement" | "synthetic_fixture" | "decision_hold"; notes?: string }>;
  measured_at: string | null;
  geometry: {
    status: "verified" | "unknown" | "stale";
    coordinate_system: "normalized_top_left" | "pixel_top_left" | "unknown";
    viewport: { status: "verified" | "unknown" | "stale"; width?: number; height?: number; pixel_density?: number; output_width?: number; output_height?: number };
    ui_regions: { unknown: boolean; regions: SafeZoneRegion[] };
    safe_regions: { unknown: boolean; regions: SafeZoneRegion[] };
    method: "measured_screenshot" | "synthetic_fixture" | "unknown";
    confidence: "high" | "medium" | "low" | "unknown";
  };
  device_evidence: { status: "verified" | "unknown" | "stale"; device?: string; os?: string; app_version?: string; app_build?: string; locale?: string; notch_or_insets?: string };
  screenshot_evidence: { status: "verified" | "unknown" | "stale"; path?: string; sha256?: string; format?: "png" | "webp" | "tiff" | "svg" | "unknown" };
  supersession: { state: "active" | "stale" | "superseded" | "deprecated"; superseded_by?: string; reason?: string };
  fallback: { mode: "safe_identity_layout" | "human_platform_preview" | "hold"; human_preview_required: boolean; reason: string };
}

export interface LoadedPlatformSafeZoneProfile { path: string; hash: string; profile: PlatformSafeZoneProfile; warnings: string[] }
export interface PlatformSafeZoneSelection { status: "verified" | "degraded" | "human_hold"; profile?: LoadedPlatformSafeZoneProfile; reason: string; human_preview_required: boolean; fallback: PlatformSafeZoneProfile["fallback"]; }
export interface SafeZoneElement { id: string; kind: "anchor" | "caption" | "content" | "profile_overlay"; rect: RegionRect }
export interface SafeZoneQaCheck { id: string; status: "pass" | "fail" | "unknown"; reason: string; element_id?: string; region_id?: string }
export interface SafeZoneRegressionReceipt { version: "platform-safe-zone-qa/v1"; profile_id: string; profile_hash: string; status: "pass" | "degraded" | "human_hold"; human_preview_required: boolean; checks: SafeZoneQaCheck[]; receipt_hash: string }

export class PlatformSafeZoneProfileError extends Error {
  constructor(public readonly issues: string[]) { super(`Platform safe-zone profile is invalid: ${issues.join("; ")}`); this.name = "PlatformSafeZoneProfileError"; }
}

export function parsePlatformSafeZoneProfile(input: unknown): PlatformSafeZoneProfile {
  try {
    const profile = structuredClone(validateArtifact<PlatformSafeZoneProfile>(input, "platform-safe-zone-profile.schema.json"));
    const issues: string[] = [];
    for (const source of profile.source_references) {
      if (!source.url.startsWith("https://")) issues.push("source_references.url must use https");
    }
    if (profile.evidence_status === "verified" && (profile.geometry.status !== "verified" || profile.geometry.safe_regions.unknown || profile.screenshot_evidence.status !== "verified" || profile.device_evidence.status !== "verified")) {
      issues.push("verified profiles require verified geometry, device, and screenshot evidence");
    }
    if (profile.evidence_status === "verified" && profile.surface !== "fixture" && profile.geometry.method !== "measured_screenshot") {
      issues.push("production verified profiles require a measured screenshot; synthetic fixture geometry is not production evidence");
    }
    if (profile.evidence_status === "verified" && profile.surface !== "fixture") {
      if (!profile.measured_at) issues.push("production verified profiles require measured_at");
      if (!profile.source_references.some((source) => source.evidence_kind === "current_measurement")) issues.push("production verified profiles require a current_measurement source reference");
      if (!profile.device_evidence.device || !profile.device_evidence.app_version || !profile.device_evidence.app_build) issues.push("production verified profiles require device, app_version, and app_build evidence");
      if (!profile.screenshot_evidence.path || !profile.screenshot_evidence.sha256 || !["png", "tiff"].includes(profile.screenshot_evidence.format ?? "")) issues.push("production verified profiles require a lossless png/tiff screenshot path and sha256");
    }
    if (profile.surface === "organic" && profile.platform === "fixture") issues.push("fixture platform cannot be registered as organic");
    if (profile.evidence_status !== "verified" && profile.geometry.safe_regions.regions.length > 0 && profile.geometry.safe_regions.unknown) {
      issues.push("unknown safe regions cannot carry measured regions");
    }
    if (issues.length > 0) throw new PlatformSafeZoneProfileError(issues);
    return profile;
  } catch (error) {
    if (error instanceof PlatformSafeZoneProfileError) throw error;
    throw new PlatformSafeZoneProfileError([error instanceof Error ? error.message : String(error)]);
  }
}

export function platformSafeZoneProfileContentHash(profile: PlatformSafeZoneProfile): string {
  return computeNormalizedJsonHash(profile);
}

export function loadPlatformSafeZoneProfile(filePath: string): LoadedPlatformSafeZoneProfile {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = path.extname(filePath).toLowerCase() === ".json" ? JSON.parse(raw) : parseYaml(raw);
  const profile = parsePlatformSafeZoneProfile(parsed);
  return { path: filePath, hash: `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`, profile, warnings: profile.evidence_status === "verified" ? [] : ["profile is not production-verified"] };
}

function walkProfiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkProfiles(entryPath);
    return /\.(yaml|yml|json)$/i.test(entry.name) ? [entryPath] : [];
  }).sort();
}

export function loadPlatformSafeZoneRegistry(rootDir: string): { profiles: LoadedPlatformSafeZoneProfile[]; malformed: Array<{ path: string; error: string }> } {
  const profiles: LoadedPlatformSafeZoneProfile[] = [];
  const malformed: Array<{ path: string; error: string }> = [];
  for (const filePath of walkProfiles(path.join(rootDir, "delivery_profiles", "platform-safe-zone"))) {
    try { profiles.push(loadPlatformSafeZoneProfile(filePath)); } catch (error) { malformed.push({ path: filePath, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { profiles, malformed };
}

export function selectPlatformSafeZoneProfile(options: { rootDir: string; platform: PlatformName; surface: PlatformSurface; variant?: string; now?: Date }): PlatformSafeZoneSelection {
  const registry = loadPlatformSafeZoneRegistry(options.rootDir);
  const candidates = registry.profiles.filter((item) => item.profile.platform === options.platform && item.profile.surface === options.surface && (!options.variant || item.profile.delivery_variant === options.variant));
  const selected = candidates.find((item) => item.profile.supersession.state === "active") ?? candidates[0];
  if (!selected) {
    const fallback: PlatformSafeZoneProfile["fallback"] = { mode: "hold", human_preview_required: true, reason: `no ${options.platform}/${options.surface} profile with evidence is registered` };
    return { status: "human_hold", reason: fallback.reason, human_preview_required: true, fallback };
  }
  const profile = selected.profile;
  if (profile.evidence_status === "verified" && profile.supersession.state === "active") return { status: "verified", profile: selected, reason: "profile evidence is current and verified", human_preview_required: profile.fallback.human_preview_required, fallback: profile.fallback };
  const stale = profile.evidence_status === "stale" || profile.geometry.status === "stale" || profile.supersession.state !== "active";
  const human = stale || profile.fallback.human_preview_required || profile.fallback.mode === "human_platform_preview" || profile.fallback.mode === "hold";
  return { status: human ? "human_hold" : "degraded", profile: selected, reason: `${profile.profile_id} is ${profile.evidence_status}/${profile.supersession.state}; measured safe zones are not trusted`, human_preview_required: human, fallback: profile.fallback };
}

function contains(outer: RegionRect, inner: RegionRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
function overlaps(left: RegionRect, right: RegionRect): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
}

export function verifyPlatformScreenshotEvidence(profile: PlatformSafeZoneProfile, rootDir: string): void {
  if (profile.screenshot_evidence.status !== "verified") return;
  const relative = profile.screenshot_evidence.path;
  if (!relative || !profile.screenshot_evidence.sha256) throw new PlatformSafeZoneProfileError(["verified screenshot evidence needs path and sha256"]);
  const target = path.resolve(rootDir, relative);
  const base = path.resolve(rootDir);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !fs.existsSync(target)) throw new PlatformSafeZoneProfileError([`screenshot evidence is missing or outside root: ${relative}`]);
  const actual = `sha256:${createHash("sha256").update(fs.readFileSync(target)).digest("hex")}`;
  if (actual !== profile.screenshot_evidence.sha256) throw new PlatformSafeZoneProfileError([`screenshot evidence hash mismatch: ${relative}`]);
}

export function runPlatformSafeZoneRegression(options: { profile: PlatformSafeZoneProfile; profileHash?: string; elements: SafeZoneElement[]; rootDir?: string }): SafeZoneRegressionReceipt {
  if (options.rootDir) verifyPlatformScreenshotEvidence(options.profile, options.rootDir);
  const profile = options.profile;
  const checks: SafeZoneQaCheck[] = [];
  if (profile.surface === "organic" && profile.platform === "fixture") checks.push({ id: "scope", status: "fail", reason: "fixture platform cannot represent an organic production surface" });
  if (profile.geometry.status !== "verified" || profile.geometry.safe_regions.unknown || profile.geometry.ui_regions.unknown) {
    for (const element of options.elements) checks.push({ id: "geometry_unknown", status: "unknown", reason: "safe-zone or UI regions are unknown; human platform preview is required", element_id: element.id });
  } else {
    for (const element of options.elements) {
      const safe = profile.geometry.safe_regions.regions.find((region) => contains(region.rect, element.rect));
      if (!safe) checks.push({ id: "safe_region_containment", status: "fail", reason: "element is outside every measured safe region", element_id: element.id });
      else checks.push({ id: "safe_region_containment", status: "pass", reason: "element is contained by a measured safe region", element_id: element.id, region_id: safe.id });
      const ui = profile.geometry.ui_regions.regions.find((region) => overlaps(region.rect, element.rect));
      if (ui) checks.push({ id: "ui_overlap", status: "fail", reason: "element overlaps a measured platform UI region", element_id: element.id, region_id: ui.id });
    }
  }
  const failed = checks.some((check) => check.status === "fail");
  const unknown = checks.some((check) => check.status === "unknown");
  const status: SafeZoneRegressionReceipt["status"] = failed ? "degraded" : unknown ? "human_hold" : "pass";
  const receipt: Omit<SafeZoneRegressionReceipt, "receipt_hash"> = { version: "platform-safe-zone-qa/v1", profile_id: profile.profile_id, profile_hash: options.profileHash ?? platformSafeZoneProfileContentHash(profile), status, human_preview_required: status !== "pass" || profile.fallback.human_preview_required, checks };
  return { ...receipt, receipt_hash: computeNormalizedJsonHash(receipt) };
}
