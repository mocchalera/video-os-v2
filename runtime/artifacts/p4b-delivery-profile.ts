import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import { computeNormalizedJsonHash } from "./p1-manifest-coverage.js";
import { validateAgainstSchema } from "../commands/shared.js";
import type { ReleaseSafetyCheck } from "./p4a-release-safety.js";

export type DeliveryPlatform =
  | "youtube"
  | "shorts"
  | "instagram_reel"
  | "instagram_feed"
  | "tiktok"
  | "internal_review"
  | "client_handoff"
  | "custom";

export type DeliveryReleaseMode = "public" | "external" | "internal";

export interface DeliveryProfile {
  version: string;
  project_id: string;
  artifact_version: "delivery-profile-v1";
  created_at: string;
  profile_id: string;
  profile_name: string;
  platform: DeliveryPlatform;
  release_mode: DeliveryReleaseMode;
  video_constraints: {
    aspect_ratio: "16:9" | "9:16" | "1:1" | "4:5" | "21:9" | "custom";
    resolution: { width: number; height: number };
    frame_rate_mode: "cfr_29.97" | "cfr_30" | "cfr_24" | "cfr_25" | "cfr_60" | "vfr_disallowed" | "custom";
    color_space: "rec709" | "sRGB" | "rec2020" | "custom";
  };
  audio_constraints: {
    loudness_lufs: number;
    true_peak_dbtp: number;
    sample_rate_hz: number;
    channel_layout: "stereo" | "mono" | "5.1" | "custom";
  };
  caption_constraints: {
    mode: "burned_in" | "sidecar" | "both" | "none";
    sidecar_format: "srt" | "vtt" | "scc" | null;
    language_required: string[];
  };
  duration_constraints: {
    min_seconds: number | null;
    max_seconds: number | null;
  };
  file_naming: {
    pattern: string;
    allowed_extensions: string[];
  };
  metadata_requirements: {
    title_required: boolean;
    description_required: boolean;
    tags_required: boolean;
    thumbnail_required: boolean;
    custom_fields: Array<{
      field_id: string;
      label: string;
      required: boolean;
      type: "string" | "number" | "boolean" | "url" | "date" | "custom";
    }>;
  };
  privacy_strictness: "strict_public" | "external" | "internal_only";
  rights_strictness: "strict_public" | "external" | "internal_only";
  requires_calibrated_confidence?: boolean;
  provenance: {
    producer: "operator-command" | "/package";
    inputs: Array<{ path: string; hash: string | null; required?: boolean }>;
    hash_policy: {
      algorithm: "sha256";
      canonicalization: "yaml-to-normalized-json-v1";
      excluded_fields: string[];
    };
  };
}

export interface DeliveryProfileValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface LoadedDeliveryProfile {
  path: string;
  hash: string;
  profile: DeliveryProfile;
  warnings: string[];
}

export interface MalformedDeliveryProfile {
  path: string;
  hash: string | null;
  errors: string[];
  warnings: string[];
}

export interface LoadDeliveryProfilesResult {
  profiles: LoadedDeliveryProfile[];
  malformed: MalformedDeliveryProfile[];
}

export interface CaptionArtifact {
  path: string;
  format?: string | null;
}

export interface GenerateDeliveryProfileChecksOptions {
  projectDir: string;
  timeline?: unknown;
  packageManifest?: unknown;
  packageQaReport?: unknown;
  captionArtifacts?: CaptionArtifact[];
  profiles: Array<DeliveryProfile | LoadedDeliveryProfile>;
  malformed?: MalformedDeliveryProfile[];
  expectedReleaseMode?: DeliveryReleaseMode;
}

const DELIVERY_PROFILE_DIR = "07_package/delivery_profiles";
const PUBLIC_OR_EXTERNAL = new Set<DeliveryReleaseMode>(["public", "external"]);

export function isP4bDeliveryProfilesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.ENABLE_P4B_DELIVERY_PROFILES ?? "");
}

export function parseCanonicalDeliveryProfileYaml(raw: string): unknown {
  rejectYamlAnchorsAndAliases(raw);
  return parseYaml(raw);
}

export function computeDeliveryProfileHash(profile: unknown): string {
  return computeNormalizedJsonHash(profile, ["created_at"]);
}

export function validateProfile(profile: unknown): DeliveryProfileValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const schema = validateAgainstSchema(profile, "delivery-profile.schema.json");
  if (!schema.valid) errors.push(...schema.errors);

  const data = profile as Partial<DeliveryProfile>;
  const duration = data.duration_constraints;
  if (
    typeof duration?.min_seconds === "number" &&
    typeof duration.max_seconds === "number" &&
    duration.min_seconds > duration.max_seconds
  ) {
    errors.push("duration_constraints.min_seconds must be <= max_seconds");
  }

  const caption = data.caption_constraints;
  if (caption?.mode === "sidecar" || caption?.mode === "both") {
    if (!caption.sidecar_format) errors.push(`caption_constraints.sidecar_format is required when mode=${caption.mode}`);
  }
  if (caption?.mode === "none" && caption.sidecar_format !== null) {
    errors.push("caption_constraints.sidecar_format must be null when mode=none");
  }
  if (caption?.mode === "burned_in" && caption.sidecar_format) {
    warnings.push("caption_constraints.mode=burned_in includes sidecar_format; runtime treats this as advisory sidecar output");
  }
  if (data.requires_calibrated_confidence === true) {
    warnings.push("requires_calibrated_confidence is recorded for P4c; calibration is not evaluated in P4b");
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function loadDeliveryProfiles(projectPath: string): LoadDeliveryProfilesResult {
  const dir = path.join(projectPath, DELIVERY_PROFILE_DIR);
  if (!fs.existsSync(dir)) return { profiles: [], malformed: [] };
  const profiles: LoadedDeliveryProfile[] = [];
  const malformed: MalformedDeliveryProfile[] = [];
  for (const file of fs.readdirSync(dir).filter((item) => /\.ya?ml$/i.test(item)).sort()) {
    const filePath = path.join(dir, file);
    let hash: string | null = null;
    try {
      hash = sha256File(filePath);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = parseCanonicalDeliveryProfileYaml(raw) as DeliveryProfile;
      const validation = validateProfile(parsed);
      if (validation.valid) {
        profiles.push({ path: filePath, hash, profile: parsed, warnings: validation.warnings });
      } else {
        malformed.push({ path: filePath, hash, errors: validation.errors, warnings: validation.warnings });
      }
    } catch (err) {
      malformed.push({
        path: filePath,
        hash,
        errors: [err instanceof Error ? err.message : String(err)],
        warnings: [],
      });
    }
  }
  return { profiles, malformed };
}

export function readDeliveryProfileStatus(projectPath: string): {
  enabled: boolean;
  directory: string;
  count: number;
  malformed_count: number;
  profiles: Array<{ profile_id: string; profile_name: string; platform: string; release_mode: string; path: string }>;
  malformed: Array<{ path: string; errors: string[] }>;
} {
  const loaded = loadDeliveryProfiles(projectPath);
  return {
    enabled: true,
    directory: path.join(projectPath, DELIVERY_PROFILE_DIR),
    count: loaded.profiles.length,
    malformed_count: loaded.malformed.length,
    profiles: loaded.profiles.map((item) => ({
      profile_id: item.profile.profile_id,
      profile_name: item.profile.profile_name,
      platform: item.profile.platform,
      release_mode: item.profile.release_mode,
      path: item.path,
    })),
    malformed: loaded.malformed.map((item) => ({ path: item.path, errors: item.errors })),
  };
}

export function generateDeliveryProfileChecks(options: GenerateDeliveryProfileChecksOptions): ReleaseSafetyCheck[] {
  const profiles = options.profiles.map(unwrapProfile);
  const malformed = options.malformed ?? [];
  const checks: ReleaseSafetyCheck[] = [];

  for (const item of malformed) {
    checks.push(makeCheck(
      "RSCHK_delivery_profile_malformed",
      "fatal",
      "fail",
      `delivery profile malformed: ${item.errors.join("; ")}`,
      [{ path: item.path, hash: item.hash, required: true }],
    ));
  }

  const expectedReleaseMode = options.expectedReleaseMode ?? "public";
  const releaseProfiles = profiles.filter((item) => item.profile.release_mode === expectedReleaseMode);
  if (PUBLIC_OR_EXTERNAL.has(expectedReleaseMode) && releaseProfiles.length === 0) {
    checks.push(makeCheck(
      "RSCHK_delivery_profile_required_absent",
      "fatal",
      "fail",
      `no ${expectedReleaseMode} delivery profile found`,
      [{ path: path.join(options.projectDir, DELIVERY_PROFILE_DIR), hash: null, required: true }],
    ));
  }

  const profilesToEvaluate = releaseProfiles.length > 0 ? releaseProfiles : profiles;
  for (const item of profilesToEvaluate) {
    checks.push(...checksForProfile(options, item));
  }

  if (checks.length === 0) {
    checks.push(makeCheck(
      "RSCHK_delivery_profile_optional_absent",
      "info",
      "pass",
      "no internal delivery profile configured; public/external release was not requested",
      [{ path: path.join(options.projectDir, DELIVERY_PROFILE_DIR), hash: null, required: false }],
    ));
  }
  return checks;
}

function checksForProfile(
  options: GenerateDeliveryProfileChecksOptions,
  item: { profile: DeliveryProfile; path: string; hash: string | null; warnings: string[] },
): ReleaseSafetyCheck[] {
  const profile = item.profile;
  const refs = [{ path: item.path, hash: item.hash, required: true }];
  const checks: ReleaseSafetyCheck[] = [
    makeCheck(
      `RSCHK_delivery_profile_${slug(profile.profile_id)}_loaded`,
      "info",
      "pass",
      `${profile.profile_name} loaded for platform=${profile.platform} release_mode=${profile.release_mode}`,
      refs,
    ),
  ];
  for (const warning of item.warnings) {
    checks.push(makeCheck(
      `RSCHK_delivery_profile_${slug(profile.profile_id)}_warning_${checks.length}`,
      "warning",
      "fail",
      warning,
      refs,
    ));
  }

  checks.push(checkVideo(profile, item, options));
  checks.push(checkDuration(profile, item, options.timeline));
  checks.push(checkAudio(profile, item, options.packageQaReport));
  checks.push(checkCaptions(profile, item, options.packageManifest, options.captionArtifacts ?? []));
  checks.push(checkFileNaming(profile, item, options.packageManifest));
  return checks;
}

function checkVideo(
  profile: DeliveryProfile,
  item: { path: string; hash: string | null },
  options: GenerateDeliveryProfileChecksOptions,
): ReleaseSafetyCheck {
  const sequence = (options.timeline as { sequence?: Record<string, unknown> } | undefined)?.sequence;
  const failures: string[] = [];
  if (!sequence) {
    failures.push("timeline.sequence missing");
  } else {
    const width = sequence.width;
    const height = sequence.height;
    const aspect = typeof sequence.output_aspect_ratio === "string"
      ? sequence.output_aspect_ratio
      : typeof width === "number" && typeof height === "number"
        ? ratioFromDimensions(width, height)
        : undefined;
    if (profile.video_constraints.aspect_ratio !== "custom" && aspect !== profile.video_constraints.aspect_ratio) {
      failures.push(`aspect_ratio expected=${profile.video_constraints.aspect_ratio} actual=${aspect ?? "unknown"}`);
    }
    if (typeof width === "number" && width !== profile.video_constraints.resolution.width) {
      failures.push(`resolution.width expected=${profile.video_constraints.resolution.width} actual=${width}`);
    }
    if (typeof height === "number" && height !== profile.video_constraints.resolution.height) {
      failures.push(`resolution.height expected=${profile.video_constraints.resolution.height} actual=${height}`);
    }
    const fps = readFps(sequence);
    if (!frameRateMatches(profile.video_constraints.frame_rate_mode, fps)) {
      failures.push(`frame_rate_mode expected=${profile.video_constraints.frame_rate_mode} actual=${fps?.toFixed(3) ?? "unknown"}`);
    }
  }
  return profileCheck(profile, item, "video", failures.length === 0, failures.join("; ") || "timeline video constraints match");
}

function checkDuration(
  profile: DeliveryProfile,
  item: { path: string; hash: string | null },
  timeline: unknown,
): ReleaseSafetyCheck {
  const duration = timelineDurationSeconds(timeline);
  const failures: string[] = [];
  if (duration == null) {
    failures.push("timeline duration unavailable");
  } else {
    const min = profile.duration_constraints.min_seconds;
    const max = profile.duration_constraints.max_seconds;
    if (typeof min === "number" && duration < min) failures.push(`duration expected>=${min}s actual=${duration.toFixed(3)}s`);
    if (typeof max === "number" && duration > max) failures.push(`duration expected<=${max}s actual=${duration.toFixed(3)}s`);
  }
  return profileCheck(profile, item, "duration", failures.length === 0, failures.join("; ") || "duration constraints match");
}

function checkAudio(
  profile: DeliveryProfile,
  item: { path: string; hash: string | null },
  packageQaReport: unknown,
): ReleaseSafetyCheck {
  const metrics = (packageQaReport as { metrics?: Record<string, unknown> } | undefined)?.metrics;
  const failures: string[] = [];
  const lufs = metrics?.integrated_lufs;
  const peak = metrics?.true_peak_dbtp;
  if (typeof lufs === "number" && Math.abs(lufs - profile.audio_constraints.loudness_lufs) > 1) {
    failures.push(`loudness_lufs expected=${profile.audio_constraints.loudness_lufs} actual=${lufs}`);
  }
  if (typeof peak === "number" && peak > profile.audio_constraints.true_peak_dbtp) {
    failures.push(`true_peak_dbtp max=${profile.audio_constraints.true_peak_dbtp} actual=${peak}`);
  }
  if (!metrics) failures.push("package QA metrics missing");
  return profileCheck(profile, item, "audio", failures.length === 0, failures.join("; ") || "package QA audio metrics match");
}

function checkCaptions(
  profile: DeliveryProfile,
  item: { path: string; hash: string | null },
  packageManifest: unknown,
  captionArtifacts: CaptionArtifact[],
): ReleaseSafetyCheck {
  const failures: string[] = [];
  const mode = profile.caption_constraints.mode;
  const sidecarFormat = profile.caption_constraints.sidecar_format;
  const manifestCaptions = ((packageManifest as { artifacts?: { captions?: unknown[] } } | undefined)?.artifacts?.captions ?? [])
    .filter((caption): caption is Record<string, unknown> => !!caption && typeof caption === "object");
  const hasSidecar = !!sidecarFormat && (
    captionArtifacts.some((artifact) => artifact.format === sidecarFormat || artifact.path.endsWith(`.${sidecarFormat}`)) ||
    manifestCaptions.some((caption) => caption.delivery === sidecarFormat || (typeof caption.path === "string" && caption.path.endsWith(`.${sidecarFormat}`)))
  );
  if ((mode === "sidecar" || mode === "both") && !hasSidecar) {
    failures.push(`caption sidecar required format=${sidecarFormat ?? "unknown"}`);
  }
  if (mode === "none" && (captionArtifacts.length > 0 || manifestCaptions.length > 0)) {
    failures.push("caption artifacts present while profile requires none");
  }
  return profileCheck(profile, item, "captions", failures.length === 0, failures.join("; ") || "caption constraints match");
}

function checkFileNaming(
  profile: DeliveryProfile,
  item: { path: string; hash: string | null },
  packageManifest: unknown,
): ReleaseSafetyCheck {
  const finalVideo = (packageManifest as { artifacts?: { final_video?: { path?: unknown } } } | undefined)?.artifacts?.final_video?.path;
  if (typeof finalVideo !== "string") {
    return profileCheck(profile, item, "file_naming", false, "package_manifest.artifacts.final_video.path missing");
  }
  const ext = path.extname(finalVideo);
  const ok = profile.file_naming.allowed_extensions.includes(ext);
  return profileCheck(
    profile,
    item,
    "file_naming",
    ok,
    ok ? "final video extension is allowed" : `final video extension ${ext || "none"} not in ${profile.file_naming.allowed_extensions.join(",")}`,
  );
}

function profileCheck(
  profile: DeliveryProfile,
  item: { path: string; hash: string | null },
  suffix: string,
  passed: boolean,
  message: string,
): ReleaseSafetyCheck {
  return makeCheck(
    `RSCHK_delivery_profile_${slug(profile.profile_id)}_${suffix}`,
    passed ? "info" : severityFor(profile),
    passed ? "pass" : "fail",
    `${profile.profile_id}: ${message}`,
    [{ path: item.path, hash: item.hash, required: true }],
  );
}

function severityFor(profile: DeliveryProfile): "warning" | "blocker" {
  return profile.release_mode === "internal" ? "warning" : "blocker";
}

function makeCheck(
  checkId: string,
  severity: ReleaseSafetyCheck["severity"],
  status: ReleaseSafetyCheck["status"],
  message: string,
  artifactRefs: ReleaseSafetyCheck["artifact_refs"],
): ReleaseSafetyCheck {
  return {
    check_id: checkId,
    category: "delivery_profile",
    severity,
    status,
    message,
    artifact_refs: artifactRefs,
  };
}

function unwrapProfile(input: DeliveryProfile | LoadedDeliveryProfile): {
  profile: DeliveryProfile;
  path: string;
  hash: string | null;
  warnings: string[];
} {
  if ("profile" in input) {
    return { profile: input.profile, path: input.path, hash: input.hash, warnings: input.warnings };
  }
  return { profile: input, path: `${DELIVERY_PROFILE_DIR}/${input.profile_id}.yaml`, hash: computeDeliveryProfileHash(input), warnings: validateProfile(input).warnings };
}

function readFps(sequence: Record<string, unknown>): number | null {
  const fpsNum = sequence.fps_num;
  const fpsDen = sequence.fps_den;
  return typeof fpsNum === "number" && typeof fpsDen === "number" && fpsDen !== 0 ? fpsNum / fpsDen : null;
}

function frameRateMatches(mode: DeliveryProfile["video_constraints"]["frame_rate_mode"], fps: number | null): boolean {
  if (mode === "custom" || mode === "vfr_disallowed") return true;
  if (fps == null) return false;
  const expected: Record<string, number> = {
    "cfr_29.97": 29.97,
    cfr_30: 30,
    cfr_24: 24,
    cfr_25: 25,
    cfr_60: 60,
  };
  return Math.abs(fps - expected[mode]) < 0.02;
}

function timelineDurationSeconds(timeline: unknown): number | null {
  const doc = timeline as { sequence?: Record<string, unknown>; tracks?: Record<string, unknown[]> } | undefined;
  const fps = doc?.sequence ? readFps(doc.sequence) : null;
  if (!fps) return null;
  let maxFrame = 0;
  for (const trackList of Object.values(doc?.tracks ?? {})) {
    if (!Array.isArray(trackList)) continue;
    for (const track of trackList) {
      const clips = (track as { clips?: unknown[] }).clips;
      if (!Array.isArray(clips)) continue;
      for (const clip of clips) {
        const item = clip as { timeline_in_frame?: unknown; timeline_duration_frames?: unknown };
        if (typeof item.timeline_in_frame === "number" && typeof item.timeline_duration_frames === "number") {
          maxFrame = Math.max(maxFrame, item.timeline_in_frame + item.timeline_duration_frames);
        }
      }
    }
  }
  return maxFrame / fps;
}

function ratioFromDimensions(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function sha256File(filePath: string): string {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function rejectYamlAnchorsAndAliases(raw: string): void {
  if (/(^|[\s[{,])&[A-Za-z0-9_-]+/.test(raw) || /(^|[\s[{,])\*[A-Za-z0-9_-]+/.test(raw)) {
    throw new Error("YAML anchors and aliases are not allowed in delivery_profile.yaml");
  }
  if (/![A-Za-z]/.test(raw)) {
    throw new Error("YAML custom tags are not allowed in delivery_profile.yaml");
  }
}
