import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClipOutput, TimelineIR } from "../compiler/types.js";
import { buildVideoClipFilterString } from "../../editor/shared/filtergraph.js";
import type { RenderEffectSpec, RenderVideoClip } from "../../editor/shared/render-spec.js";
import {
  PREMIERE_PREFLIGHT_BROKER_POLICY_VERSION,
  type PremierePreflightDiscoveryBinding,
  type PremierePreflightEvaluationBinding,
  type PremierePreflightExecutableIdentity,
  type PremierePreflightInvocationReceipt,
  type PremierePreflightProcessBroker,
  type PremierePreflightToolDiscoveryReceipt,
} from "./premiere-preflight-process-broker.js";

export const VISUAL_TREATMENT_VERSION = "premiere-visual-treatment/v1" as const;
export const BAKE_MANIFEST_VERSION = "premiere-effect-bake-manifest/v1" as const;
export const BAKE_INDEX_VERSION = "premiere-effect-bake-index/v1" as const;

const SHA = /^sha256:[0-9a-f]{64}$/;
const EFFECT_TYPES = new Set(["eq", "brightness", "contrast", "saturation"]);
const COMPONENTS = ["brightness", "contrast", "saturation", "gamma"] as const;
const BAKE_ROOT = path.join("09_output", "premiere-bakes");

export type PremiereBakePreflightStatus =
  | "native"
  | "bake_required"
  | "reusable"
  | "busy"
  | "stale"
  | "conflict"
  | "unsupported"
  | "source_unverified"
  | "rights_privacy_blocked";

export interface PremiereBakePreflightItem {
  clip_id: string;
  track_id: string;
  status: PremiereBakePreflightStatus;
  reason?: string;
  request_sha256?: string;
  evaluation_association?: PremiereEffectBakeEvaluationAssociation;
}

export interface PremiereEffectBakeEvaluationAssociation {
  version: "premiere-effect-bake-evaluation-association/v1";
  preflight_run_id: string;
  evaluation_ordinal: number;
  track_id: string;
  clip_id: string;
  discovery_sha256: string;
  ffmpeg_discovery_receipt_sha256: string;
  ffprobe_discovery_receipt_sha256: string;
  evaluation_sha256: string;
  source_probe_invocation_receipt: PremierePreflightInvocationReceipt;
  source_probe_broker_invocation_receipt_sha256: string;
  ffmpeg_version_invocation_receipt: PremierePreflightInvocationReceipt;
  broker_invocation_receipt_sha256: string;
  ffmpeg_version_sha256: string;
  request_sha256: string;
}

export type NormalizedEffect = {
  type: "eq" | "brightness" | "contrast" | "saturation";
  params: Record<string, number>;
};

export interface PremiereVisualTreatment {
  version: typeof VISUAL_TREATMENT_VERSION;
  transform: {
    zoom: number;
    crop: { x: number; y: number; width: number; height: number } | null;
    position: { x: number; y: number } | null;
  };
  effects: NormalizedEffect[];
}

export interface PremiereBakedRepresentation {
  representation: "baked_visual";
  clip_id: string;
  canonical_asset_id: string;
  derived_asset_id: string;
  bake_request_id: string;
  manifest_path: string;
  manifest_sha256: string;
  media_path: string;
  media_sha256: string;
  media_video_stream_sha256: string;
  absolute_media_path: string;
  timeline_track_id: string;
  source_in_us: number;
  source_out_us: number;
  timeline_duration_frames: number;
  fps_num: number;
  fps_den: number;
  effect_editable: false;
}

export type PremiereTreatmentClassification =
  | { status: "native"; clip_id: string; track_id: string; clip: ClipOutput }
  | { status: "bake_required"; clip_id: string; track_id: string; clip: ClipOutput; treatment: PremiereVisualTreatment }
  | { status: "blocked"; clip_id: string; track_id: string; clip: ClipOutput; reason: string; detail: string };

export interface BakeIndexEntry {
  clip_id: string;
  canonical_asset_id: string;
  derived_asset_id: string;
  bake_request_id: string;
  manifest_path: string;
  manifest_sha256: string;
  media_path: string;
  media_sha256: string;
  media_video_stream_sha256: string;
}

export interface PremiereEffectBakeIndex {
  version: typeof BAKE_INDEX_VERSION;
  project_id: string;
  base_timeline_sha256: string;
  entries: BakeIndexEntry[];
}

export interface PremiereNormalizedProbe {
  format: {
    format_name: string; duration: string; start_time: string; size: string; bit_rate: string;
  };
  video: {
    index: number; codec_name: string; codec_tag_string: string; profile: string | null; level: number | null;
    width: number; height: number; sample_aspect_ratio: string; display_aspect_ratio: string;
    r_frame_rate: string; avg_frame_rate: string; time_base: string; start_pts: string; duration_ts: string; nb_frames: string;
    pix_fmt: string; field_order: string; color_range: string; color_space: string; color_transfer: string; color_primaries: string;
    chroma_location: string; rotation: number; has_alpha: boolean; tags_json: string; side_data_json: string; disposition_json: string;
  };
  stream_count: number;
}

export interface PremierePacketFrameEvidence {
  frame_count: number; packet_count: number; ticks_per_frame: string;
  first_pts: "0"; first_dts: "0"; last_pts: string; last_dts: string; final_end: string;
  packet_timing_sha256: string; frame_timing_sha256: string;
}

interface SourceIdentity {
  dev: number; ino: number; size: number; mode: number; mtime_ms: number; ctime_ms: number; nlink: 1;
}

interface SourceAuthority {
  source: string; source_id: string; source_origin: "original_source" | "verified_caption_free_proxy";
  rights_status: "operator_declared_ok" | "licensed"; privacy_status: "operator_declared_ok";
  fd: number; stat: fs.Stats; identity: SourceIdentity; hash: string;
  mapPath: string; ledgerPath: string; manifestPath: string;
  authorityHashes: { source_map: string; source_ledger: string; source_media_manifest: string };
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function exactObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, "must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("|") !== [...keys].sort().join("|")) fail(code, "fields are not exact");
  return record;
}

function finite(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(code, "must be finite number");
  return Object.is(value, -0) ? 0 : value;
}

function ranged(value: unknown, min: number, max: number, code: string): number {
  const number = finite(value, code);
  if (number < min || number > max) fail(code, `must be in [${min},${max}]`);
  return number;
}

function safeInteger(value: unknown, code: string): number {
  const number = finite(value, code);
  if (!Number.isSafeInteger(number)) fail(code, "must be a safe integer");
  return number;
}

function renderSixDecimals(value: number): string {
  const rendered = value.toFixed(6);
  if (Number(rendered) === 0) return "0";
  return rendered.replace(/0+$/, "").replace(/\.$/, "");
}

function rendererTurnsIdentity(component: string, value: number): boolean {
  const identity = component === "brightness" ? 0 : 1;
  return renderSixDecimals(value) === renderSixDecimals(identity);
}

export function hasDeclaredPremiereVisualTreatment(clip: ClipOutput): boolean {
  const metadata = clip.metadata;
  return !!metadata && ["zoom", "crop", "position", "render"].some((key) => Object.hasOwn(metadata, key));
}

export function normalizePremiereVisualTreatment(
  clip: ClipOutput,
  width: number,
  height: number,
): PremiereVisualTreatment {
  const metadata = clip.metadata;
  if (!metadata || !hasDeclaredPremiereVisualTreatment(clip)) fail("visual_bake_missing", "no treatment declared");
  const allowedMetadata = new Set(["zoom", "crop", "position", "render"]);
  const treatmentKeys = Object.keys(metadata).filter((key) => allowedMetadata.has(key));
  if (treatmentKeys.length === 0) fail("visual_bake_missing", "no treatment declared");

  const zoom = Object.hasOwn(metadata, "zoom")
    ? ranged(metadata.zoom, 1, 4, "visual_bake_zoom_invalid")
    : 1;
  let crop: PremiereVisualTreatment["transform"]["crop"] = null;
  if (Object.hasOwn(metadata, "crop")) {
    const raw = exactObject(metadata.crop, ["x", "y", "width", "height"], "visual_bake_crop_invalid");
    crop = {
      x: safeInteger(raw.x, "visual_bake_crop_invalid"),
      y: safeInteger(raw.y, "visual_bake_crop_invalid"),
      width: safeInteger(raw.width, "visual_bake_crop_invalid"),
      height: safeInteger(raw.height, "visual_bake_crop_invalid"),
    };
    if (crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 ||
        crop.x + crop.width > width || crop.y + crop.height > height) {
      fail("visual_bake_crop_invalid", "crop is outside output sequence pixels");
    }
  }
  let position: PremiereVisualTreatment["transform"]["position"] = null;
  if (Object.hasOwn(metadata, "position")) {
    const raw = exactObject(metadata.position, ["x", "y"], "visual_bake_position_invalid");
    position = { x: safeInteger(raw.x, "visual_bake_position_invalid"), y: safeInteger(raw.y, "visual_bake_position_invalid") };
    if (position.x < -width || position.x > width || position.y < -height || position.y > height) {
      fail("visual_bake_position_invalid", "position is outside output-sequence bounds");
    }
  }

  const effects: NormalizedEffect[] = [];
  if (Object.hasOwn(metadata, "render")) {
    const render = exactObject(metadata.render, ["effects"], "visual_bake_render_invalid");
    if (!Array.isArray(render.effects) || render.effects.length === 0) fail("visual_bake_declared_noop", "render.effects must be non-empty");
    const rawTypes: string[] = [];
    const eqComponents = new Set<string>();
    const standalone = new Set<string>();
    const parsed = render.effects.map((entry, index) => {
      const raw = exactObject(entry, ["type", "params"], "visual_bake_effect_invalid");
      if (typeof raw.type !== "string") fail("visual_bake_effect_invalid", `effects[${index}].type must be string`);
      if (!raw.params || typeof raw.params !== "object" || Array.isArray(raw.params)) fail("visual_bake_effect_invalid", `effects[${index}].params must be object`);
      const params = raw.params as Record<string, unknown>;
      rawTypes.push(raw.type);
      if (raw.type === "eq") for (const component of COMPONENTS) if (Object.hasOwn(params, component)) eqComponents.add(component);
      if (COMPONENTS.includes(raw.type as typeof COMPONENTS[number])) standalone.add(raw.type);
      return { type: raw.type, params, index };
    });
    const duplicate = rawTypes.find((type, index) => rawTypes.indexOf(type) !== index);
    if (duplicate) fail("visual_bake_repeated_effect_type", `repeated effect type: ${duplicate}`);
    const overlap = COMPONENTS.find((component) => eqComponents.has(component) && standalone.has(component));
    if (overlap) fail("visual_bake_effect_component_overlap", `eq and standalone ${overlap} overlap`);

    for (const { type, params, index } of parsed) {
      if (!EFFECT_TYPES.has(type)) fail("visual_bake_unsupported", `unsupported effect type: ${type}`);
      if (type === "eq") {
        const allowed = ["contrast", "brightness", "saturation"];
        if (Object.keys(params).length === 0 || Object.keys(params).some((key) => !allowed.includes(key))) {
          fail("visual_bake_unsupported", `unsupported eq parameter at ${index}`);
        }
        const normalized: Record<string, number> = {};
        for (const key of allowed) {
          if (!Object.hasOwn(params, key)) continue;
          normalized[key] = ranged(params[key], key === "brightness" ? -1 : 0, key === "saturation" ? 3 : key === "contrast" ? 4 : 1, "visual_bake_effect_invalid");
          if (rendererTurnsIdentity(key, normalized[key])) fail("visual_bake_declared_noop", `${key} renders as identity at six decimals`);
        }
        if (Object.entries(normalized).every(([key, value]) => value === (key === "brightness" ? 0 : 1))) {
          fail("visual_bake_declared_noop", "eq is identity-only");
        }
        effects.push({ type: "eq", params: normalized });
      } else {
        const canonical = type;
        const keys = Object.keys(params);
        if (keys.length !== 1 || (keys[0] !== "value" && keys[0] !== canonical)) {
          fail("visual_bake_effect_invalid", `${type} requires exactly value or ${canonical}`);
        }
        const value = ranged(params[keys[0]], type === "brightness" ? -1 : 0, type === "saturation" ? 3 : type === "contrast" ? 4 : 1, "visual_bake_effect_invalid");
        if (rendererTurnsIdentity(type, value)) fail("visual_bake_declared_noop", `${type} renders as identity at six decimals`);
        effects.push({ type: type as NormalizedEffect["type"], params: { [canonical]: value } });
      }
    }
  }
  if (zoom === 1 && crop === null && (position === null || (position.x === 0 && position.y === 0)) && effects.length === 0) {
    fail("visual_bake_declared_noop", "declared treatment has no non-no-op operation");
  }
  return { version: VISUAL_TREATMENT_VERSION, transform: { zoom, crop, position }, effects };
}

export function classifyPremiereVideoTreatments(timeline: TimelineIR): PremiereTreatmentClassification[] {
  const result: PremiereTreatmentClassification[] = [];
  const clipIds = new Set<string>();
  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) {
      if (clipIds.has(clip.clip_id)) {
        result.push({ status: "blocked", clip_id: clip.clip_id, track_id: track.track_id, clip, reason: "visual_bake_duplicate_clip_id", detail: "clip_id is not unique" });
        continue;
      }
      clipIds.add(clip.clip_id);
      if (!hasDeclaredPremiereVisualTreatment(clip)) {
        result.push({ status: "native", clip_id: clip.clip_id, track_id: track.track_id, clip });
        continue;
      }
      try {
        result.push({ status: "bake_required", clip_id: clip.clip_id, track_id: track.track_id, clip, treatment: normalizePremiereVisualTreatment(clip, timeline.sequence.width, timeline.sequence.height) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const [reason] = message.split(":", 1);
        result.push({ status: "blocked", clip_id: clip.clip_id, track_id: track.track_id, clip, reason, detail: message });
      }
    }
  }
  return result;
}

function normalizeJson(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical_json_non_finite", "non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))) {
      output[key] = normalizeJson((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function sha256Prefixed(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function bindPremiereEffectBakeRequestSha(baseRequestSha256: string, evaluationSha256: string): string {
  if (!SHA.test(baseRequestSha256) || !SHA.test(evaluationSha256)) fail("visual_bake_cache_corrupt", "request/evaluation SHA invalid");
  return baseRequestSha256;
}

function immutable<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

export interface PremiereEffectBakeDiscoveryBody {
  domain: "premiere-effect-bake-discovery/v1";
  project_id: string;
  timeline_sha256: string;
  profile_id: "adobe_premiere_fcp7xml_v1";
  broker_policy_version: typeof PREMIERE_PREFLIGHT_BROKER_POLICY_VERSION;
  required_tools: readonly ["ffmpeg", "ffprobe"];
}

interface PremiereEffectBakeDiscovery {
  body: Readonly<PremiereEffectBakeDiscoveryBody>;
  sha256: string;
}

function buildPremiereEffectBakeDiscovery(timeline: TimelineIR, rawTimeline: Buffer): PremiereEffectBakeDiscovery {
  const body = immutable({
    domain: "premiere-effect-bake-discovery/v1" as const,
    project_id: timeline.project_id,
    timeline_sha256: sha256Prefixed(rawTimeline),
    profile_id: "adobe_premiere_fcp7xml_v1" as const,
    broker_policy_version: PREMIERE_PREFLIGHT_BROKER_POLICY_VERSION,
    required_tools: immutable(["ffmpeg", "ffprobe"] as const),
  }) as Readonly<PremiereEffectBakeDiscoveryBody>;
  return immutable({ body, sha256: sha256Prefixed(canonicalJson(body)) });
}

export interface PremiereEffectBakeEvaluationBody {
  domain: "premiere-effect-bake-evaluation/v2";
  preflight_run_id: string;
  discovery_sha256: string;
  ffmpeg_discovery_receipt_sha256: string;
  ffprobe_discovery_receipt_sha256: string;
  ffmpeg_executable_identity: PremierePreflightExecutableIdentity;
  ffprobe_executable_identity: PremierePreflightExecutableIdentity;
  evaluation_ordinal: number;
  track_id: string;
  clip_id: string;
  source_id: string;
  source_locator_sha256: string;
  source_content_sha256: string;
  source_stat: SourceIdentity;
  timeline_sha256: string;
  effect_treatment: PremiereVisualTreatment;
  classification_result: "bake_required";
  classifier_version: typeof VISUAL_TREATMENT_VERSION;
  profile_id: "adobe_premiere_fcp7xml_v1";
}

export interface PremiereTimelineIdentity {
  dev: string;
  ino: string;
  mode: number;
  nlink: 1;
  size: number;
  mtime_ns: string;
  ctime_ns: string;
}

export interface PremiereRevisionBoundTimeline {
  fd: number;
  rawTimeline: Buffer;
  parsedTimeline: unknown;
  sha256: string;
  identity: PremiereTimelineIdentity;
}

export class PremiereTimelineRevisionMismatch extends Error {
  constructor(
    readonly projectId: string,
    readonly expectedSha256: string,
    readonly observedSha256: string | null,
    readonly expectedIdentity: PremiereTimelineIdentity,
    readonly observedIdentity: PremiereTimelineIdentity | null,
  ) {
    super("timeline_revision_mismatch");
    this.name = "PremiereTimelineRevisionMismatch";
  }
}

const TIMELINE_IDENTITY_KEYS = ["dev", "ino", "mode", "nlink", "size", "mtime_ns", "ctime_ns"] as const;
const NONNEGATIVE_INTEGER_STRING = /^(?:0|[1-9][0-9]*)$/;

export function parsePremiereTimelineIdentity(value: unknown): PremiereTimelineIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_preflight_contract", "timeline identity must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("|") !== [...TIMELINE_IDENTITY_KEYS].sort().join("|")) {
    fail("invalid_preflight_contract", "timeline identity fields are not exact");
  }
  if (typeof record.dev !== "string" || !NONNEGATIVE_INTEGER_STRING.test(record.dev)
    || typeof record.ino !== "string" || !NONNEGATIVE_INTEGER_STRING.test(record.ino)
    || typeof record.mtime_ns !== "string" || !NONNEGATIVE_INTEGER_STRING.test(record.mtime_ns)
    || typeof record.ctime_ns !== "string" || !NONNEGATIVE_INTEGER_STRING.test(record.ctime_ns)
    || typeof record.mode !== "number" || !Number.isSafeInteger(record.mode) || record.mode < 0
    || record.nlink !== 1
    || typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0) {
    fail("invalid_preflight_contract", "timeline identity values are invalid");
  }
  return {
    dev: record.dev,
    ino: record.ino,
    mode: record.mode,
    nlink: 1,
    size: record.size,
    mtime_ns: record.mtime_ns,
    ctime_ns: record.ctime_ns,
  };
}

export function encodePremiereTimelineIdentity(identity: PremiereTimelineIdentity): string {
  const parsed = parsePremiereTimelineIdentity(identity);
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}

export function decodePremiereTimelineIdentity(encoded: string): PremiereTimelineIdentity {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.includes("=")) {
    fail("invalid_preflight_contract", "timeline identity encoding is invalid");
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) fail("invalid_preflight_contract", "timeline identity encoding is non-canonical");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid_preflight_contract")) throw error;
    fail("invalid_preflight_contract", "timeline identity JSON is malformed");
  }
  const identity = parsePremiereTimelineIdentity(parsed);
  if (encodePremiereTimelineIdentity(identity) !== encoded) fail("invalid_preflight_contract", "timeline identity JSON is non-canonical");
  return identity;
}

export function premiereTimelineIdentityFromStat(stat: fs.BigIntStats): PremiereTimelineIdentity {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)
    || stat.mode > BigInt(Number.MAX_SAFE_INTEGER)) fail("invalid_preflight_contract", "timeline must be regular nlink=1 with safe identity values");
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: Number(stat.mode),
    nlink: 1,
    size: Number(stat.size),
    mtime_ns: String(stat.mtimeNs),
    ctime_ns: String(stat.ctimeNs),
  };
}

export function samePremiereTimelineIdentity(left: PremiereTimelineIdentity, right: PremiereTimelineIdentity): boolean {
  return TIMELINE_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function assertCanonicalPreflightTimeline(projectPath: string, timelinePath: string): void {
  const project = path.resolve(projectPath);
  const projectStat = fs.lstatSync(project);
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink() || fs.realpathSync(project) !== project) {
    fail("invalid_preflight_contract", "project path must be canonical and non-symlinked");
  }
  const relative = path.relative(project, timelinePath);
  if (relative !== path.join("05_timeline", "timeline.json")) fail("invalid_preflight_contract", "timeline path is not canonical");
  let cursor = path.parse(project).root;
  for (const component of project.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail("invalid_preflight_contract", "project contains a symlink component");
  }
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail("invalid_preflight_contract", "timeline contains a symlink component");
  }
}

export function openPremiereRevisionBoundTimeline(options: {
  projectPath: string;
  expectedSha256: string;
  expectedIdentity: PremiereTimelineIdentity;
}): PremiereRevisionBoundTimeline {
  if (!SHA.test(options.expectedSha256)) fail("invalid_preflight_contract", "expected timeline SHA is invalid");
  const expectedIdentity = parsePremiereTimelineIdentity(options.expectedIdentity);
  const timelinePath = path.join(options.projectPath, "05_timeline", "timeline.json");
  assertCanonicalPreflightTimeline(options.projectPath, timelinePath);
  const fd = fs.openSync(timelinePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    const observedIdentity = premiereTimelineIdentityFromStat(before);
    const rawTimeline = fs.readFileSync(fd);
    const after = premiereTimelineIdentityFromStat(fs.fstatSync(fd, { bigint: true }));
    const observedSha256 = sha256Prefixed(rawTimeline);
    let parsedTimeline: unknown;
    try {
      parsedTimeline = JSON.parse(rawTimeline.toString("utf8"));
    } catch {
      fail("invalid_preflight_contract", "timeline JSON is malformed");
    }
    const projectId = parsedTimeline && typeof parsedTimeline === "object" && !Array.isArray(parsedTimeline)
      && typeof (parsedTimeline as Record<string, unknown>).project_id === "string"
      ? (parsedTimeline as Record<string, string>).project_id
      : "";
    if (!samePremiereTimelineIdentity(observedIdentity, after)
      || !samePremiereTimelineIdentity(expectedIdentity, observedIdentity)
      || options.expectedSha256 !== observedSha256) {
      throw new PremiereTimelineRevisionMismatch(projectId, options.expectedSha256, observedSha256, expectedIdentity, observedIdentity);
    }
    return { fd, rawTimeline, parsedTimeline, sha256: observedSha256, identity: observedIdentity };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function hashFileDescriptor(fd: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (count === 0) break;
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  return `sha256:${hash.digest("hex")}`;
}

function checkedRegular(file: string): fs.Stats {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("baked_media_unverified", `${file} must be regular nlink=1`);
  return stat;
}

function sourceIdentity(stat: fs.Stats, code = "visual_bake_source_unverified"): SourceIdentity {
  if (!stat.isFile() || stat.nlink !== 1) fail(code, "descriptor must be regular nlink=1");
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs, nlink: 1 };
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode &&
    left.mtime_ms === right.mtime_ms && left.ctime_ms === right.ctime_ms && left.nlink === right.nlink;
}

function assertNoSymlinkBelow(root: string, file: string, code: string): void {
  const rootPath = path.resolve(root), filePath = path.resolve(file);
  const rootStat = fs.lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(code, "declared source root must be a real directory");
  const relative = path.relative(rootPath, filePath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(code, "source is outside declared source root");
  const rootReal = fs.realpathSync(rootPath);
  let cursor = rootPath;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail(code, `symlink component rejected: ${cursor}`);
  }
  if (fs.realpathSync(filePath) !== path.join(rootReal, relative)) fail(code, "source parent identity changed");
}

function hashRegularFile(file: string, code: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(code, `${file} must be regular nlink=1`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { return hashFileDescriptor(fd); } finally { fs.closeSync(fd); }
}

function executable(name: "ffmpeg" | "ffprobe"): string {
  const resolved = execFileSync("which", [name], { encoding: "utf8" }).trim();
  const real = fs.realpathSync(resolved);
  checkedRegular(real);
  return real;
}

function runDescriptorTool(binary: string, args: string[], fd: number): string {
  const child = spawnSync(binary, args.map((arg) => arg.replace("<SOURCE_FD>", "3")), {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe", fd],
  });
  if (child.status !== 0) fail("visual_bake_tool_failed", `${path.basename(binary)}: ${child.stderr}`);
  return child.stdout ?? "";
}

function readJson(file: string, code: string): Record<string, unknown> {
  try {
    checkedRegular(file);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${file} must contain object`);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(code)) throw error;
    fail(code, `cannot read ${file}`);
  }
}

function uniqueBy(items: Record<string, unknown>[], key: string, code: string): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const id = item[key];
    if (typeof id !== "string" || !id || map.has(id)) fail(code, `${key} missing or duplicate`);
    map.set(id, item);
  }
  return map;
}

function rejectDuplicateValues(items: Record<string, unknown>[], key: string, code: string): void {
  const values = items.map((item) => item[key]).filter((value): value is string => typeof value === "string" && value.length > 0);
  if (new Set(values).size !== values.length) fail(code, `${key} is not one-to-one`);
}

function resolveLocator(projectPath: string, documentPath: string, value: unknown): string {
  if (typeof value !== "string" || !value) fail("visual_bake_source_unverified", "source locator missing");
  if (path.isAbsolute(value)) return path.resolve(value);
  const projectRelative = path.resolve(projectPath, value);
  if (fs.existsSync(projectRelative)) return projectRelative;
  return path.resolve(path.dirname(documentPath), value);
}

function verifyProxyAttestation(projectPath: string, map: Record<string, unknown>, sourceHash: string): void {
  const ref = exactObject(map.clean_base_attestation, ["path", "sha256"], "visual_bake_source_unverified");
  if (typeof ref.path !== "string" || path.isAbsolute(ref.path) || unsafeRelative(ref.path) || typeof ref.sha256 !== "string" || !SHA.test(ref.sha256)) fail("visual_bake_source_unverified", "proxy attestation reference invalid");
  const attestationPath = path.resolve(projectPath, ref.path);
  if (!attestationPath.startsWith(`${projectPath}${path.sep}`)) fail("visual_bake_source_unverified", "proxy attestation escaped project root");
  assertNoSymlinkBelow(projectPath, attestationPath, "visual_bake_source_unverified");
  if (hashRegularFile(attestationPath, "visual_bake_source_unverified") !== ref.sha256) fail("visual_bake_source_unverified", "proxy attestation hash mismatch");
  const attestation = readJson(attestationPath, "visual_bake_source_unverified");
  exactObject(attestation, ["version", "subject", "claim", "verification"], "visual_bake_source_unverified");
  const subject = exactObject(attestation.subject, ["content_sha256"], "visual_bake_source_unverified");
  const verification = exactObject(attestation.verification, ["method", "coverage", "producer_id", "verifier_id", "verifier_type", "verified_at", "evidence"], "visual_bake_source_unverified");
  const evidence = exactObject(verification.evidence, ["path", "sha256"], "visual_bake_source_unverified");
  if (attestation.version !== "clean-base-attestation/v1" || attestation.claim !== "caption_free_clean_base" || subject.content_sha256 !== sourceHash || verification.method !== "human_full_duration_visual_review" || verification.coverage !== "full_duration" || verification.verifier_type !== "human" || typeof verification.producer_id !== "string" || !verification.producer_id || typeof verification.verifier_id !== "string" || !verification.verifier_id || verification.producer_id === verification.verifier_id || typeof verification.verified_at !== "string" || !Number.isFinite(Date.parse(verification.verified_at)) || typeof evidence.path !== "string" || path.isAbsolute(evidence.path) || unsafeRelative(evidence.path) || typeof evidence.sha256 !== "string" || !SHA.test(evidence.sha256)) fail("visual_bake_source_unverified", "proxy attestation does not bind an independent full-duration review");
  const evidencePath = path.resolve(projectPath, evidence.path);
  if (!evidencePath.startsWith(`${projectPath}${path.sep}`)) fail("visual_bake_source_unverified", "proxy evidence escaped project root");
  assertNoSymlinkBelow(projectPath, evidencePath, "visual_bake_source_unverified");
  if (hashRegularFile(evidencePath, "visual_bake_source_unverified") !== evidence.sha256) fail("visual_bake_source_unverified", "proxy evidence hash mismatch");
}

function loadSourceAuthority(projectPath: string, timeline: TimelineIR, clip: ClipOutput, explicitMap?: string): SourceAuthority {
  const mapPath = explicitMap ? path.resolve(explicitMap) : path.join(projectPath, "02_media", "source_map.json");
  const ledgerPath = path.join(projectPath, "03_analysis", "source_ledger.json");
  const manifestPath = path.join(projectPath, "02_media", "source_media_manifest.json");
  for (const authorityPath of [mapPath, ledgerPath, manifestPath]) assertNoSymlinkBelow(projectPath, authorityPath, "visual_bake_source_unverified");
  const authorityHashes = { source_map: hashRegularFile(mapPath, "visual_bake_source_unverified"), source_ledger: hashRegularFile(ledgerPath, "visual_bake_source_unverified"), source_media_manifest: hashRegularFile(manifestPath, "visual_bake_source_unverified") };
  const mapDoc = readJson(mapPath, "visual_bake_source_unverified");
  const ledger = readJson(ledgerPath, "visual_bake_source_unverified");
  const manifest = readJson(manifestPath, "visual_bake_source_unverified");
  for (const doc of [mapDoc, ledger, manifest]) if (doc.project_id !== timeline.project_id) fail("visual_bake_source_unverified", "project_id mismatch");
  if (!Array.isArray(mapDoc.items) || !Array.isArray(ledger.items) || !Array.isArray(manifest.items)) fail("visual_bake_source_unverified", "authority items missing");
  const mapItems = mapDoc.items as Record<string, unknown>[], ledgerItems = ledger.items as Record<string, unknown>[], manifestItems = manifest.items as Record<string, unknown>[];
  const maps = uniqueBy(mapItems, "asset_id", "visual_bake_source_unverified");
  const ledgers = uniqueBy(ledgerItems, "canonical_asset_id", "visual_bake_source_unverified");
  const manifests = uniqueBy(manifestItems, "asset_id", "visual_bake_source_unverified");
  for (const [items, keys] of [[mapItems, ["source_locator"]], [ledgerItems, ["source_id", "canonical_locator"]], [manifestItems, ["source_id", "source_locator"]]] as const) for (const key of keys) rejectDuplicateValues(items, key, "visual_bake_source_unverified");
  const map = maps.get(clip.asset_id), ledgerItem = ledgers.get(clip.asset_id), declaration = manifests.get(clip.asset_id);
  if (!map || !ledgerItem || !declaration || ledgerItem.status !== "ready" || declaration.ingest_status !== "ready") fail("visual_bake_source_unverified", `incomplete authority for ${clip.asset_id}`);
  const sourceId = ledgerItem.source_id;
  if (typeof sourceId !== "string" || declaration.source_id !== sourceId || ledgerItem.canonical_request_source_id !== sourceId) fail("visual_bake_source_unverified", "asset/source identity join mismatch");
  const contentHash = ledgerItem.content_hash, fingerprint = ledgerItem.fingerprint, sizeBytes = ledgerItem.size_bytes;
  if (typeof contentHash !== "string" || !SHA.test(contentHash) || typeof fingerprint !== "string" || !fingerprint || !Number.isSafeInteger(sizeBytes)) fail("visual_bake_source_unverified", "source ledger identity incomplete");
  const mapContentHash = typeof map.source_content_sha256 === "string" && /^[0-9a-f]{64}$/.test(map.source_content_sha256) ? `sha256:${map.source_content_sha256}` : "";
  if (declaration.content_hash !== contentHash || declaration.fingerprint !== fingerprint || declaration.size_bytes !== sizeBytes || mapContentHash !== contentHash || map.source_fingerprint !== fingerprint || map.source_size_bytes !== sizeBytes) fail("visual_bake_source_unverified", "source hash/fingerprint/size join mismatch");
  if (declaration.mtime !== ledgerItem.mtime) fail("visual_bake_source_unverified", "source mtime join mismatch");
  if (map.source_origin !== "original_source" && map.source_origin !== "verified_caption_free_proxy") fail("visual_bake_source_unverified", "source_origin is missing or unsupported");
  if (declaration.rights_status !== "operator_declared_ok" && declaration.rights_status !== "licensed") fail("visual_bake_rights_privacy_blocked", "rights are not cleared");
  if (declaration.privacy_status !== "operator_declared_ok") fail("visual_bake_rights_privacy_blocked", "privacy is not cleared");
  const source = resolveLocator(projectPath, ledgerPath, ledgerItem.canonical_locator);
  const mapSource = resolveLocator(projectPath, mapPath, map.source_locator), manifestSource = resolveLocator(projectPath, manifestPath, declaration.source_locator);
  if (fs.realpathSync(mapSource) !== fs.realpathSync(source) || fs.realpathSync(manifestSource) !== fs.realpathSync(source)) fail("visual_bake_source_unverified", "source locator join mismatch");
  const sourceRoot = exactObject(manifest.source_root, ["locator", "locator_kind"], "visual_bake_source_unverified");
  if (sourceRoot.locator_kind !== "local_path" && sourceRoot.locator_kind !== "external_drive") fail("visual_bake_source_unverified", "source root is not a directly verifiable filesystem root");
  const sourceRootPath = resolveLocator(projectPath, manifestPath, sourceRoot.locator);
  assertNoSymlinkBelow(sourceRootPath, source, "visual_bake_source_unverified");
  const before = fs.lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("visual_bake_source_unverified", "source must be regular nlink=1");
  const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd), identity = sourceIdentity(stat);
    if (!sameIdentity(sourceIdentity(before), identity)) fail("visual_bake_source_unverified", "source changed while opening");
    const hash = hashFileDescriptor(fd);
    if (contentHash !== hash || sizeBytes !== stat.size || map.source_mtime_ms !== stat.mtimeMs || declaration.mtime !== new Date(stat.mtimeMs).toISOString()) fail("visual_bake_source_unverified", "live source identity mismatch");
    if (map.source_origin === "verified_caption_free_proxy") verifyProxyAttestation(projectPath, map, hash);
    const authorityHashesAfter = { source_map: hashRegularFile(mapPath, "visual_bake_source_unverified"), source_ledger: hashRegularFile(ledgerPath, "visual_bake_source_unverified"), source_media_manifest: hashRegularFile(manifestPath, "visual_bake_source_unverified") };
    if (canonicalJson(authorityHashesAfter) !== canonicalJson(authorityHashes)) fail("visual_bake_source_unverified", "source authority documents changed during validation");
    return {
      source, source_id: sourceId, source_origin: map.source_origin, rights_status: declaration.rights_status,
      privacy_status: declaration.privacy_status, fd, stat, identity, hash, mapPath, ledgerPath, manifestPath,
      authorityHashes,
    };
  } catch (error) { fs.closeSync(fd); throw error; }
}

function sourceAuthority(projectPath: string, timeline: TimelineIR, clip: ClipOutput, explicitMap?: string): SourceAuthority {
  try { return loadSourceAuthority(projectPath, timeline, clip, explicitMap); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("visual_bake_")) throw error;
    fail("visual_bake_source_unverified", "source authority access failed");
  }
}

function verifySourceStable(authority: SourceAuthority): void {
  try {
    const authorityHashes = { source_map: hashRegularFile(authority.mapPath, "visual_bake_source_unverified"), source_ledger: hashRegularFile(authority.ledgerPath, "visual_bake_source_unverified"), source_media_manifest: hashRegularFile(authority.manifestPath, "visual_bake_source_unverified") };
    if (canonicalJson(authorityHashes) !== canonicalJson(authority.authorityHashes)) fail("visual_bake_source_unverified", "source authority documents changed during render");
    const descriptorAfter = sourceIdentity(fs.fstatSync(authority.fd));
    if (!sameIdentity(authority.identity, descriptorAfter) || hashFileDescriptor(authority.fd) !== authority.hash) fail("visual_bake_source_unverified", "source descriptor changed during render");
    const reopen = fs.openSync(authority.source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const reopenedIdentity = sourceIdentity(fs.fstatSync(reopen));
      if (!sameIdentity(authority.identity, reopenedIdentity) || hashFileDescriptor(reopen) !== authority.hash) fail("visual_bake_source_unverified", "source path changed during render");
    } finally { fs.closeSync(reopen); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("visual_bake_source_unverified")) throw error;
    fail("visual_bake_source_unverified", "source stability verification failed");
  }
}

function parseRatio(value: unknown, code: string): [number, number] {
  if (typeof value !== "string" || !/^\d+\/\d+$/.test(value)) fail(code, "invalid rational");
  const [num, den] = value.split("/").map(Number);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) fail(code, "invalid rational");
  return [num, den];
}

function sameRatio(left: [number, number], right: [number, number]): boolean {
  return BigInt(left[0]) * BigInt(right[1]) === BigInt(right[0]) * BigInt(left[1]);
}

function textField(value: unknown, label: string, code: string): string {
  if (typeof value !== "string" || !value) fail(code, `${label} missing`);
  return value;
}

function normalizeProbe(rawProbe: Record<string, unknown>, code: string): PremiereNormalizedProbe {
  const streams = rawProbe.streams as Record<string, unknown>[];
  const videos = streams?.filter((stream) => stream.codec_type === "video") ?? [];
  if (videos.length !== 1) fail(code, "media must have exactly one video stream");
  const raw = videos[0], format = rawProbe.format as Record<string, unknown> | undefined;
  if (!format) fail(code, "probe format missing");
  const rotationRaw = (raw.tags as Record<string, unknown> | undefined)?.rotate;
  const sideData = Array.isArray(raw.side_data_list) ? raw.side_data_list : [];
  const sideRotation = sideData.map((item) => (item as Record<string, unknown>).rotation).find((value) => value !== undefined);
  const rotation = Number(rotationRaw ?? sideRotation ?? 0);
  if (!Number.isFinite(rotation)) fail(code, "rotation invalid");
  return {
    format: {
      format_name: textField(format.format_name, "format_name", code), duration: textField(format.duration, "duration", code),
      start_time: textField(format.start_time, "start_time", code), size: textField(format.size, "size", code), bit_rate: textField(format.bit_rate, "bit_rate", code),
    },
    video: {
      index: safeInteger(raw.index, code), codec_name: textField(raw.codec_name, "codec_name", code), codec_tag_string: String(raw.codec_tag_string ?? ""),
      profile: typeof raw.profile === "string" ? raw.profile : null, level: typeof raw.level === "number" && Number.isSafeInteger(raw.level) ? raw.level : null,
      width: safeInteger(raw.width, code), height: safeInteger(raw.height, code), sample_aspect_ratio: textField(raw.sample_aspect_ratio, "sample_aspect_ratio", code),
      display_aspect_ratio: textField(raw.display_aspect_ratio, "display_aspect_ratio", code), r_frame_rate: textField(raw.r_frame_rate, "r_frame_rate", code),
      avg_frame_rate: textField(raw.avg_frame_rate, "avg_frame_rate", code), time_base: textField(raw.time_base, "time_base", code), start_pts: String(raw.start_pts ?? ""),
      duration_ts: String(raw.duration_ts ?? ""), nb_frames: String(raw.nb_frames ?? ""), pix_fmt: textField(raw.pix_fmt, "pix_fmt", code),
      field_order: textField(raw.field_order, "field_order", code), color_range: textField(raw.color_range, "color_range", code), color_space: textField(raw.color_space, "color_space", code),
      color_transfer: textField(raw.color_transfer, "color_transfer", code), color_primaries: textField(raw.color_primaries, "color_primaries", code),
      chroma_location: textField(raw.chroma_location, "chroma_location", code), rotation, has_alpha: /(^|a)(yuva|rgba|argb|bgra|abgr|gbrap)/.test(String(raw.pix_fmt)),
      tags_json: canonicalJson(raw.tags ?? {}), side_data_json: canonicalJson(sideData), disposition_json: canonicalJson(raw.disposition ?? {}),
    },
    stream_count: streams.length,
  };
}

function validateSourceProbe(raw: string): PremiereNormalizedProbe {
  try {
    const probe = normalizeProbe(JSON.parse(raw) as Record<string, unknown>, "visual_bake_source_unverified");
    const video = probe.video;
    const tuple = [video.color_primaries, video.color_transfer, video.color_space, video.color_range].join("/");
    if (tuple !== "bt709/bt709/bt709/tv" && tuple !== "bt709/bt709/bt709/pc") fail("visual_bake_source_unverified", `unsupported color tuple ${tuple}`);
    if (!["yuv420p", "yuv422p", "yuv444p", "nv12"].includes(String(video.pix_fmt))) fail("visual_bake_source_unverified", "unsupported pixel format");
    if (video.chroma_location !== "left" && video.chroma_location !== "center") fail("visual_bake_source_unverified", "unsupported chroma location");
    if (video.sample_aspect_ratio !== "1:1") fail("visual_bake_source_unverified", "non-square SAR");
    const avg = parseRatio(video.avg_frame_rate, "visual_bake_source_unverified"), real = parseRatio(video.r_frame_rate, "visual_bake_source_unverified");
    if (!sameRatio(avg, real)) fail("visual_bake_source_unverified", "VFR source");
    for (const [label, value, allowZero] of [["start_pts", video.start_pts, true], ["duration_ts", video.duration_ts, false], ["nb_frames", video.nb_frames, false]] as const) if (!/^-?[0-9]+$/.test(value) || !allowZero && BigInt(value) <= 0n) fail("visual_bake_source_unverified", `${label} is missing or invalid`);
    if (!Number.isFinite(Number(probe.format.duration)) || Number(probe.format.duration) <= 0 || !Number.isFinite(Number(probe.format.start_time)) || !Number.isSafeInteger(Number(probe.format.size)) || Number(probe.format.size) <= 0 || !Number.isSafeInteger(Number(probe.format.bit_rate)) || Number(probe.format.bit_rate) <= 0) fail("visual_bake_source_unverified", "source container timing/size/bitrate is invalid");
    if (video.rotation !== 0 || video.has_alpha) fail("visual_bake_source_unverified", "rotation or alpha is unsupported");
    return probe;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("visual_bake_source_unverified")) throw error;
    fail("visual_bake_source_unverified", "source probe failed");
  }
}

function probeSource(ffprobe: string, fd: number): PremiereNormalizedProbe {
  return validateSourceProbe(runDescriptorTool(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", "file:/dev/fd/<SOURCE_FD>"], fd));
}

function expectedSharedFiltergraph(treatment: PremiereVisualTreatment, timeline: TimelineIR): string {
  const { width, height } = timeline.sequence;
  const { zoom, crop, position } = treatment.transform;
  const filters: string[] = [];
  let positionConsumed = false;
  if (zoom <= 1) {
    filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`);
  } else {
    const scaledWidth = Math.round(width * zoom), scaledHeight = Math.round(height * zoom);
    const positionX = crop ? 0 : Math.round(position?.x ?? 0), positionY = crop ? 0 : Math.round(position?.y ?? 0);
    filters.push(
      `scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}:max(0\\,min(iw-${width}\\,(iw-${width})/2-${positionX})):max(0\\,min(ih-${height}\\,(ih-${height})/2-${positionY}))`,
    );
    positionConsumed = !crop && position !== null;
  }
  if (crop) filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`, `scale=${width}:${height}`);
  if (!positionConsumed && position && (position.x !== 0 || position.y !== 0)) {
    filters.push(
      `pad=${width + Math.abs(position.x) * 2}:${height + Math.abs(position.y) * 2}:${Math.abs(position.x) + position.x}:${Math.abs(position.y) + position.y}:black`,
      `crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`,
    );
  }
  for (const effect of treatment.effects) {
    const ordered = effect.type === "eq" ? ["contrast", "brightness", "saturation"] : [effect.type];
    const parts = ordered.filter((key) => Object.hasOwn(effect.params, key)).map((key) => `${key}=${renderSixDecimals(effect.params[key])}`);
    if (!parts.length) fail("visual_bake_renderer_contract_mismatch", `${effect.type} produced no effective filter`);
    filters.push(`eq=${parts.join(":")}`);
  }
  filters.push("format=yuv420p", "setsar=1");
  return filters.join(",");
}

export function buildPremiereBakeFiltergraph(treatment: PremiereVisualTreatment, timeline: TimelineIR, clip: ClipOutput, inputRange: "tv" | "pc"): string {
  const renderClip: RenderVideoClip = {
    clipId: clip.clip_id, assetId: clip.asset_id, sourcePath: "<SOURCE>", timelineInFrame: clip.timeline_in_frame,
    durationFrames: clip.timeline_duration_frames, sourceInSec: clip.src_in_us / 1e6, sourceOutSec: clip.src_out_us / 1e6,
    transform: { mode: "cover", zoom: treatment.transform.zoom, anchor: "center", ...(treatment.transform.crop ? { crop: treatment.transform.crop } : {}), ...(treatment.transform.position ? { position: treatment.transform.position } : {}) },
    effects: treatment.effects as RenderEffectSpec[],
  };
  const shared = buildVideoClipFilterString(renderClip, timeline.sequence);
  const expected = expectedSharedFiltergraph(treatment, timeline);
  if (shared !== expected) fail("visual_bake_renderer_contract_mismatch", "shared filtergraph differs from the accepted S4A contract");
  return `${shared},colorspace=ispace=bt709:itrc=bt709:iprimaries=bt709:irange=${inputRange}:space=bt709:trc=bt709:primaries=bt709:range=tv:format=yuv420p:fast=0,setsar=1`;
}

export function buildPremiereBakeFfmpegArgv(clip: ClipOutput, timeline: TimelineIR, graph: string, output = "<STAGED_OUTPUT>"): string[] {
  const fps = `${timeline.sequence.fps_num}/${timeline.sequence.fps_den || 1}`;
  return ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", (clip.src_in_us / 1e6).toFixed(6), "-to", (clip.src_out_us / 1e6).toFixed(6), "-i", "file:/dev/fd/<SOURCE_FD>", "-map", "0:v:0", "-vf", graph, "-an", "-r", fps, "-fps_mode", "cfr", "-frames:v", String(clip.timeline_duration_frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-threads:v", "1", "-x264-params", "threads=1:lookahead_threads=1:sliced_threads=0:sync-lookahead=0:bframes=0", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_trc", "bt709", "-color_primaries", "bt709", "-map_metadata", "-1", "-map_chapters", "-1", "-metadata", "creation_time=1970-01-01T00:00:00Z", "-metadata:s:v:0", "encoder=video-os-s4a-v1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-movflags", "+faststart+disable_chpl", "-f", "mp4", output];
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const fd = fs.openSync(temp, "r"); fs.fsyncSync(fd); fs.closeSync(fd);
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), "r"); fs.fsyncSync(dir); fs.closeSync(dir);
}

interface BakeClaimContext { path: string; id: string; requestSha256: string; }

function fsyncDir(dir: string): void { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function ensureRealDirectoryTree(root: string, target: string, code: string): void {
  const resolvedRoot = path.resolve(root), resolvedTarget = path.resolve(target), relative = path.relative(resolvedRoot, resolvedTarget);
  const rootStat = fs.lstatSync(resolvedRoot); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(code, "directory root is not a real directory");
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(code, "directory target escaped root");
  let cursor = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor);
    const stat = fs.lstatSync(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code, "directory path contains non-directory or symlink");
  }
}
function directoryIdentity(dir: string, code: string): { dev: number; ino: number } {
  const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code, "publication parent is not a real directory");
  return { dev: stat.dev, ino: stat.ino };
}
function assertDirectoryIdentity(dir: string, expected: { dev: number; ino: number }, code: string): void {
  const actual = directoryIdentity(dir, code); if (actual.dev !== expected.dev || actual.ino !== expected.ino) fail(code, "publication parent identity changed");
}
function bootIdentity(): string {
  if (fs.existsSync("/proc/sys/kernel/random/boot_id")) {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); if (value) return value;
  }
  const sysctl = process.platform === "darwin" ? "/usr/sbin/sysctl" : "sysctl";
  const result = spawnSync(sysctl, ["-n", "kern.boottime"], { encoding: "utf8" });
  const value = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!value) fail("visual_bake_claim_corrupt", "cannot establish host boot identity");
  return value;
}
function currentHostId(): string { return sha256Prefixed(`${os.hostname()}\0${bootIdentity()}`); }
function processStartId(pid: number): string | undefined {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const started = result.status === 0 ? result.stdout.trim() : "";
  return started ? sha256Prefixed(`${currentHostId()}\0${pid}\0${started}`) : undefined;
}

function readClosedClaim(file: string, requestSha256: string): Record<string, unknown> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail("visual_bake_claim_corrupt", "claim must be mode 0600 regular nlink=1");
  const claim = readJson(file, "visual_bake_claim_corrupt");
  exactObject(claim, ["version", "claim_id", "request_sha256", "invocation_id", "host_id", "pid", "process_start_id", "created_at"], "visual_bake_claim_corrupt");
  if (claim.version !== "premiere-bake-claim/v1" || claim.request_sha256 !== requestSha256 || typeof claim.claim_id !== "string" || !SHA.test(claim.claim_id) || typeof claim.invocation_id !== "string" || !claim.invocation_id || typeof claim.host_id !== "string" || !SHA.test(claim.host_id) || typeof claim.pid !== "number" || !Number.isSafeInteger(claim.pid) || claim.pid <= 0 || typeof claim.process_start_id !== "string" || !SHA.test(claim.process_start_id) || typeof claim.created_at !== "string" || !Number.isFinite(Date.parse(claim.created_at))) fail("visual_bake_claim_corrupt", "claim fields invalid");
  return claim;
}

function inspectBakeClaim(requestDir: string, requestSha256: string): "none" | "busy" | "stale" | "conflict" {
  const file = path.join(requestDir, "CLAIM.json");
  if (!fs.existsSync(file)) return "none";
  try {
    const existing = readClosedClaim(file, requestSha256);
    if (existing.host_id !== currentHostId()) return "busy";
    return processStartId(existing.pid as number) === existing.process_start_id ? "busy" : "stale";
  } catch { return "conflict"; }
}

function recoverCompletedBakeClaim(requestDir: string, claimPath: string, claim: Record<string, unknown>, requestSha256: string): boolean {
  const releasePath = path.join(requestDir, "claims", "releases", `${String(claim.claim_id).slice(7)}.json`);
  if (!fs.existsSync(releasePath)) return false;
  const release = readJson(releasePath, "visual_bake_claim_corrupt");
  exactObject(release, ["version", "claim_id", "request_sha256", "request_ready_sha256", "released_at"], "visual_bake_claim_corrupt");
  const readyPath = path.join(requestDir, "READY.json");
  if (release.version !== "premiere-bake-claim-release/v1" || release.claim_id !== claim.claim_id || release.request_sha256 !== requestSha256 || typeof release.request_ready_sha256 !== "string" || !SHA.test(release.request_ready_sha256) || !fs.existsSync(readyPath) || hashRegularFile(readyPath, "visual_bake_claim_corrupt") !== release.request_ready_sha256 || typeof release.released_at !== "string" || !Number.isFinite(Date.parse(release.released_at))) fail("visual_bake_claim_corrupt", "claim release does not bind exact ready request");
  if (readClosedClaim(claimPath, requestSha256).claim_id !== claim.claim_id) fail("visual_bake_claim_corrupt", "claim ownership changed during release recovery");
  fs.unlinkSync(claimPath); fsyncDir(requestDir);
  return true;
}

function acquireBakeClaim(requestDir: string, requestSha256: string): BakeClaimContext {
  ensureRealDirectoryTree(requestDir, path.join(requestDir, "claims", "abandoned"), "visual_bake_claim_corrupt");
  ensureRealDirectoryTree(requestDir, path.join(requestDir, "claims", "releases"), "visual_bake_claim_corrupt");
  const file = path.join(requestDir, "CLAIM.json");
  if (fs.existsSync(file)) {
    const existing = readClosedClaim(file, requestSha256);
    if (!recoverCompletedBakeClaim(requestDir, file, existing, requestSha256)) {
      if (existing.host_id !== currentHostId()) fail("visual_bake_busy", "foreign-host bake claim exists");
      if (processStartId(existing.pid as number) === existing.process_start_id) fail("visual_bake_busy", "active bake claim exists");
      const abandoned = path.join(requestDir, "claims", "abandoned", `${String(existing.claim_id).slice(7)}.${randomUUID()}.json`);
      fs.renameSync(file, abandoned); fsyncDir(path.dirname(abandoned)); fsyncDir(requestDir);
    }
  }
  const invocation = randomUUID(), id = sha256Prefixed(`${requestSha256}\0${invocation}`);
  const startId = processStartId(process.pid);
  if (!startId) fail("visual_bake_claim_corrupt", "cannot establish current process start identity");
  const value = { version: "premiere-bake-claim/v1", claim_id: id, request_sha256: requestSha256, invocation_id: invocation, host_id: currentHostId(), pid: process.pid, process_start_id: startId, created_at: new Date().toISOString() };
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("visual_bake_busy", "competing bake claim exists"); throw error; }
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fsyncDir(requestDir);
  return { path: file, id, requestSha256 };
}

function claimStillOwned(claim: BakeClaimContext): boolean {
  try { return readClosedClaim(claim.path, claim.requestSha256).claim_id === claim.id; } catch { return false; }
}

function releaseBakeClaim(requestDir: string, claim: BakeClaimContext, successful: boolean): void {
  if (!claimStillOwned(claim)) return;
  let releaseError: unknown;
  try { if (successful) atomicJson(path.join(requestDir, "claims", "releases", `${claim.id.slice(7)}.json`), { version: "premiere-bake-claim-release/v1", claim_id: claim.id, request_sha256: claim.requestSha256, request_ready_sha256: hashRegularFile(path.join(requestDir, "READY.json"), "visual_bake_cache_corrupt"), released_at: new Date().toISOString() }); }
  catch (error) { releaseError = error; }
  finally { if (claimStillOwned(claim)) { fs.unlinkSync(claim.path); fsyncDir(requestDir); } }
  if (releaseError) throw releaseError;
}

function recoverReadyBakeClaim(context: BakeRequestContext): void {
  const claimPath = path.join(context.requestDir, "CLAIM.json");
  if (!fs.existsSync(claimPath)) return;
  const existing = readClosedClaim(claimPath, context.requestSha);
  if (recoverCompletedBakeClaim(context.requestDir, claimPath, existing, context.requestSha)) return;
  if (existing.host_id !== currentHostId()) fail("visual_bake_busy", "foreign-host bake claim exists beside READY");
  if (processStartId(existing.pid as number) === existing.process_start_id) fail("visual_bake_busy", "active bake claim exists beside READY");
  const claim = { path: claimPath, id: existing.claim_id as string, requestSha256: context.requestSha };
  releaseBakeClaim(context.requestDir, claim, true);
}

function integerString(value: unknown, code: string): string {
  const text = String(value ?? "");
  if (!/^-?[0-9]+$/.test(text)) fail(code, "timing integer missing");
  return text;
}

function validateOutput(ffprobe: string, file: string, frames: number, fpsNum: number, fpsDen: number, width: number, height: number): { probe: PremiereNormalizedProbe; streamHash: string; packetEvidence: PremierePacketFrameEvidence; fileHash: string } {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("visual_bake_output_unverified", "output must be regular nlink=1");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const identity = sourceIdentity(fs.fstatSync(fd), "visual_bake_output_unverified");
    if (!sameIdentity(sourceIdentity(before, "visual_bake_output_unverified"), identity)) fail("visual_bake_output_unverified", "output changed while opening");
    const fileHash = hashFileDescriptor(fd);
    const rawProbe = JSON.parse(runDescriptorTool(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", "file:/dev/fd/<SOURCE_FD>"], fd)) as Record<string, unknown>;
    const probe = normalizeProbe(rawProbe, "visual_bake_output_unverified");
    const video = probe.video;
    const outputAverage = parseRatio(video.avg_frame_rate, "visual_bake_output_unverified"), outputReal = parseRatio(video.r_frame_rate, "visual_bake_output_unverified");
    if (probe.stream_count !== 1 || !probe.format.format_name.split(",").includes("mp4") || video.codec_name !== "h264" || video.codec_tag_string !== "avc1" || video.width !== width || video.height !== height || video.pix_fmt !== "yuv420p" || video.sample_aspect_ratio !== "1:1" || video.field_order !== "progressive" || video.rotation !== 0 || video.has_alpha || [video.color_primaries, video.color_transfer, video.color_space, video.color_range].join("/") !== "bt709/bt709/bt709/tv" || !sameRatio(outputAverage, [fpsNum, fpsDen]) || !sameRatio(outputReal, [fpsNum, fpsDen])) fail("visual_bake_output_unverified", "output topology/color/rate mismatch");
    const packets = (JSON.parse(runDescriptorTool(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts,dts,duration", "-of", "json", "file:/dev/fd/<SOURCE_FD>"], fd)).packets ?? []) as Record<string, unknown>[];
    const decodedFrames = (JSON.parse(runDescriptorTool(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=pts,pkt_dts,duration,pkt_duration", "-of", "json", "file:/dev/fd/<SOURCE_FD>"], fd)).frames ?? []) as Record<string, unknown>[];
    if (packets.length !== frames || decodedFrames.length !== frames) fail("visual_bake_output_unverified", "packet/frame count mismatch");
    const [tbNum, tbDen] = parseRatio(video.time_base, "visual_bake_output_unverified");
    const numerator = BigInt(fpsDen) * BigInt(tbDen), denominator = BigInt(fpsNum) * BigInt(tbNum);
    if (numerator % denominator !== 0n) fail("visual_bake_output_unverified", "non-integral ticks per frame");
    const ticks = numerator / denominator;
    if (video.start_pts !== "0" || video.nb_frames !== String(frames) || video.duration_ts !== (BigInt(frames) * ticks).toString() || Number(probe.format.start_time) !== 0) fail("visual_bake_output_unverified", "output probe timing mismatch");
    const packetRows: string[] = [], frameRows: string[] = [];
    packets.forEach((packet, index) => {
      const expected = BigInt(index) * ticks;
      const pts = integerString(packet.pts, "visual_bake_output_unverified"), dts = integerString(packet.dts, "visual_bake_output_unverified"), duration = integerString(packet.duration, "visual_bake_output_unverified");
      if (BigInt(pts) !== expected || BigInt(dts) !== expected || BigInt(duration) !== ticks) fail("visual_bake_output_unverified", "packet timing mismatch");
      packetRows.push(`${pts}/${dts}/${duration}`);
    });
    decodedFrames.forEach((frame, index) => {
      const expected = BigInt(index) * ticks;
      const pts = integerString(frame.pts, "visual_bake_output_unverified"), dts = integerString(frame.pkt_dts, "visual_bake_output_unverified"), duration = integerString(frame.duration ?? frame.pkt_duration, "visual_bake_output_unverified");
      if (BigInt(pts) !== expected || BigInt(dts) !== expected || BigInt(duration) !== ticks) fail("visual_bake_output_unverified", "frame timing mismatch");
      frameRows.push(`${pts}/${dts}/${duration}`);
    });
    const streamHashRaw = runDescriptorTool(executable("ffmpeg"), ["-v", "error", "-i", "file:/dev/fd/<SOURCE_FD>", "-map", "0:v:0", "-c", "copy", "-f", "hash", "-hash", "sha256", "-"], fd).trim();
    const streamHashMatch = streamHashRaw.match(/^SHA256=([0-9a-f]{64})$/i);
    if (!streamHashMatch) fail("visual_bake_output_unverified", "video stream hash output malformed");
    const descriptorAfter = sourceIdentity(fs.fstatSync(fd), "visual_bake_output_unverified");
    if (!sameIdentity(identity, descriptorAfter) || hashFileDescriptor(fd) !== fileHash) fail("visual_bake_output_unverified", "output changed during verification");
    const reopen = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try { if (!sameIdentity(identity, sourceIdentity(fs.fstatSync(reopen), "visual_bake_output_unverified")) || hashFileDescriptor(reopen) !== fileHash) fail("visual_bake_output_unverified", "output path changed during verification"); } finally { fs.closeSync(reopen); }
    const last = BigInt(frames - 1) * ticks;
    return { probe, streamHash: `sha256:${streamHashMatch[1]!.toLowerCase()}`, fileHash, packetEvidence: { frame_count: frames, packet_count: frames, ticks_per_frame: ticks.toString(), first_pts: "0", first_dts: "0", last_pts: last.toString(), last_dts: last.toString(), final_end: (BigInt(frames) * ticks).toString(), packet_timing_sha256: sha256Prefixed(packetRows.join("\n")), frame_timing_sha256: sha256Prefixed(frameRows.join("\n")) } };
  } finally { fs.closeSync(fd); }
}

async function validateOutputBrokered(
  options: BrokeredPreflightOptions,
  context: BakeRequestContext,
  file: string,
  generationId: string,
  frames: number,
  fpsNum: number,
  fpsDen: number,
  width: number,
  height: number,
): Promise<{ probe: PremiereNormalizedProbe; streamHash: string; packetEvidence: PremierePacketFrameEvidence; fileHash: string }> {
  if (!context.evaluationSha || !context.evaluationOrdinal || !context.evaluationAssociation) fail("visual_bake_cache_corrupt", "broker association missing");
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("visual_bake_output_unverified", "output must be regular nlink=1");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const binding = (operationOrdinal: number): PremierePreflightEvaluationBinding => brokerBinding(
    options,
    context.evaluationOrdinal!,
    context.classification,
    context.evaluationSha!,
    operationOrdinal,
    context.requestSha,
    generationId,
  );
  try {
    const identity = sourceIdentity(fs.fstatSync(fd), "visual_bake_output_unverified");
    if (!sameIdentity(sourceIdentity(before, "visual_bake_output_unverified"), identity)) fail("visual_bake_output_unverified", "output changed while opening");
    const fileHash = hashFileDescriptor(fd);
    const metadataResult = await options.broker.run({ kind: "ready_cache_ffprobe", media_path: file, media_fd: fd, probe_mode: "output_metadata" }, binding(2));
    const packetsResult = await options.broker.run({ kind: "ready_cache_ffprobe", media_path: file, media_fd: fd, probe_mode: "packet_timing" }, binding(3));
    const framesResult = await options.broker.run({ kind: "ready_cache_ffprobe", media_path: file, media_fd: fd, probe_mode: "frame_timing" }, binding(4));
    const streamResult = await options.broker.run({ kind: "ready_cache_stream_hash", media_path: file, media_fd: fd }, binding(5));
    for (const result of [metadataResult, packetsResult, framesResult, streamResult]) {
      if (result.receipt.exit_code !== 0 || result.receipt.signal !== null) fail("visual_bake_output_unverified", result.stderr || "READY validator failed");
    }
    const rawProbe = JSON.parse(metadataResult.stdout) as Record<string, unknown>;
    const probe = normalizeProbe(rawProbe, "visual_bake_output_unverified"), video = probe.video;
    const outputAverage = parseRatio(video.avg_frame_rate, "visual_bake_output_unverified"), outputReal = parseRatio(video.r_frame_rate, "visual_bake_output_unverified");
    if (probe.stream_count !== 1 || !probe.format.format_name.split(",").includes("mp4") || video.codec_name !== "h264" || video.codec_tag_string !== "avc1" || video.width !== width || video.height !== height || video.pix_fmt !== "yuv420p" || video.sample_aspect_ratio !== "1:1" || video.field_order !== "progressive" || video.rotation !== 0 || video.has_alpha || [video.color_primaries, video.color_transfer, video.color_space, video.color_range].join("/") !== "bt709/bt709/bt709/tv" || !sameRatio(outputAverage, [fpsNum, fpsDen]) || !sameRatio(outputReal, [fpsNum, fpsDen])) fail("visual_bake_output_unverified", "output topology/color/rate mismatch");
    const packets = (JSON.parse(packetsResult.stdout).packets ?? []) as Record<string, unknown>[];
    const decodedFrames = (JSON.parse(framesResult.stdout).frames ?? []) as Record<string, unknown>[];
    if (packets.length !== frames || decodedFrames.length !== frames) fail("visual_bake_output_unverified", "packet/frame count mismatch");
    const [tbNum, tbDen] = parseRatio(video.time_base, "visual_bake_output_unverified"), numerator = BigInt(fpsDen) * BigInt(tbDen), denominator = BigInt(fpsNum) * BigInt(tbNum);
    if (numerator % denominator !== 0n) fail("visual_bake_output_unverified", "non-integral ticks per frame");
    const ticks = numerator / denominator;
    if (video.start_pts !== "0" || video.nb_frames !== String(frames) || video.duration_ts !== (BigInt(frames) * ticks).toString() || Number(probe.format.start_time) !== 0) fail("visual_bake_output_unverified", "output probe timing mismatch");
    const packetRows: string[] = [], frameRows: string[] = [];
    packets.forEach((packet, index) => {
      const expected = BigInt(index) * ticks, pts = integerString(packet.pts, "visual_bake_output_unverified"), dts = integerString(packet.dts, "visual_bake_output_unverified"), duration = integerString(packet.duration, "visual_bake_output_unverified");
      if (BigInt(pts) !== expected || BigInt(dts) !== expected || BigInt(duration) !== ticks) fail("visual_bake_output_unverified", "packet timing mismatch");
      packetRows.push(`${pts}/${dts}/${duration}`);
    });
    decodedFrames.forEach((frame, index) => {
      const expected = BigInt(index) * ticks, pts = integerString(frame.pts, "visual_bake_output_unverified"), dts = integerString(frame.pkt_dts, "visual_bake_output_unverified"), duration = integerString(frame.duration ?? frame.pkt_duration, "visual_bake_output_unverified");
      if (BigInt(pts) !== expected || BigInt(dts) !== expected || BigInt(duration) !== ticks) fail("visual_bake_output_unverified", "frame timing mismatch");
      frameRows.push(`${pts}/${dts}/${duration}`);
    });
    const streamHashMatch = streamResult.stdout.trim().match(/^SHA256=([0-9a-f]{64})$/i);
    if (!streamHashMatch) fail("visual_bake_output_unverified", "video stream hash output malformed");
    if (!sameIdentity(identity, sourceIdentity(fs.fstatSync(fd), "visual_bake_output_unverified")) || hashFileDescriptor(fd) !== fileHash) fail("visual_bake_output_unverified", "output changed during verification");
    const reopen = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try { if (!sameIdentity(identity, sourceIdentity(fs.fstatSync(reopen), "visual_bake_output_unverified")) || hashFileDescriptor(reopen) !== fileHash) fail("visual_bake_output_unverified", "output path changed during verification"); } finally { fs.closeSync(reopen); }
    const last = BigInt(frames - 1) * ticks;
    return { probe, streamHash: `sha256:${streamHashMatch[1]!.toLowerCase()}`, fileHash, packetEvidence: { frame_count: frames, packet_count: frames, ticks_per_frame: ticks.toString(), first_pts: "0", first_dts: "0", last_pts: last.toString(), last_dts: last.toString(), final_end: (BigInt(frames) * ticks).toString(), packet_timing_sha256: sha256Prefixed(packetRows.join("\n")), frame_timing_sha256: sha256Prefixed(frameRows.join("\n")) } };
  } finally { fs.closeSync(fd); }
}

type BakeClassification = Extract<PremiereTreatmentClassification, { status: "bake_required" }>;
interface BakeRequestContext {
  projectPath: string; classification: BakeClassification; authority: SourceAuthority; sourceProbe: PremiereNormalizedProbe;
  ffmpeg: string; ffprobe: string; request: Record<string, unknown>; requestSha: string; digest: string;
  bakeId: string; derivedAsset: string; requestDir: string; filtergraph: string;
  evaluationSha?: string;
  evaluationOrdinal?: number;
  evaluationAssociation?: PremiereEffectBakeEvaluationAssociation;
}

function normalizedFfmpegVersion(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/[\t\n\f\v ]+$/g, "");
  if (!normalized) fail("visual_bake_tool_failed", "ffmpeg version output is empty");
  return `${normalized}\n`;
}

function projectRelative(projectPath: string, target: string, code: string): string {
  const relative = path.relative(projectPath, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(code, "authority path must be project-relative");
  return relative.split(path.sep).join("/");
}

function completeBakeRequestContext(
  options: { projectPath: string; timeline: TimelineIR; rawTimeline: Buffer; sourceMapPath?: string },
  classification: BakeClassification,
  ffmpeg: string,
  ffprobe: string,
  authority: SourceAuthority,
  sourceProbe: PremiereNormalizedProbe,
  ffmpegVersion: string,
): BakeRequestContext {
  const inputRange = sourceProbe.video.color_range as "tv" | "pc";
  const filtergraph = buildPremiereBakeFiltergraph(classification.treatment, options.timeline, classification.clip, inputRange);
  const request: Record<string, unknown> = {
      version: "premiere-effect-bake-request/v1", renderer_contract_version: "6", project_id: options.timeline.project_id,
      base_timeline_sha256: sha256Prefixed(options.rawTimeline), clip_id: classification.clip_id, track_id: classification.track_id,
      asset_id: classification.clip.asset_id, source_id: authority.source_id, source_locator: authority.source,
      source_origin: authority.source_origin, rights_status: authority.rights_status, privacy_status: authority.privacy_status,
      source_in_us: classification.clip.src_in_us, source_out_us: classification.clip.src_out_us,
      timeline_duration_frames: classification.clip.timeline_duration_frames, source_sha256: authority.hash, source_identity: authority.identity,
      source_probe: sourceProbe, treatment: classification.treatment,
      scaled_dimensions: { width: Math.round(options.timeline.sequence.width * classification.treatment.transform.zoom), height: Math.round(options.timeline.sequence.height * classification.treatment.transform.zoom) },
      sequence: { width: options.timeline.sequence.width, height: options.timeline.sequence.height, fps_num: options.timeline.sequence.fps_num, fps_den: options.timeline.sequence.fps_den || 1 },
      filtergraph, ffmpeg_argv: buildPremiereBakeFfmpegArgv(classification.clip, options.timeline, filtergraph), ffmpeg_path: ffmpeg,
      ffmpeg_sha256: sha256Prefixed(fs.readFileSync(ffmpeg)), ffmpeg_version: ffmpegVersion, ffmpeg_version_sha256: sha256Prefixed(ffmpegVersion),
      policy: { codec: "h264", crf: 14, preset: "veryfast", threads: 1, bframes: 0, color: "bt709_limited", sar: "1:1", topology: "video_only" },
      authority_paths: { source_map: projectRelative(options.projectPath, authority.mapPath, "visual_bake_source_unverified"), source_ledger: projectRelative(options.projectPath, authority.ledgerPath, "visual_bake_source_unverified"), source_media_manifest: projectRelative(options.projectPath, authority.manifestPath, "visual_bake_source_unverified") },
      authority_hashes: authority.authorityHashes,
  };
  const requestSha = sha256Prefixed(`premiere-effect-bake-request/v1\0${canonicalJson(request)}`), digest = requestSha.slice(7);
  return { projectPath: options.projectPath, classification, authority, sourceProbe, ffmpeg, ffprobe, request, requestSha, digest, bakeId: `VBK_${digest.slice(0, 24).toUpperCase()}`, derivedAsset: `AST_BAKE_${digest.slice(0, 24).toUpperCase()}`, requestDir: path.join(options.projectPath, BAKE_ROOT, "requests", digest), filtergraph };
}

function buildBakeRequestContext(options: { projectPath: string; timeline: TimelineIR; rawTimeline: Buffer; sourceMapPath?: string }, classification: BakeClassification, ffmpeg: string, ffprobe: string): BakeRequestContext {
  const authority = sourceAuthority(options.projectPath, options.timeline, classification.clip, options.sourceMapPath);
  try {
    const sourceProbe = probeSource(ffprobe, authority.fd);
    const ffmpegVersion = execFileSync(ffmpeg, ["-version"], { encoding: "utf8" });
    return completeBakeRequestContext(options, classification, ffmpeg, ffprobe, authority, sourceProbe, ffmpegVersion);
  } catch (error) { fs.closeSync(authority.fd); throw error; }
}

function fixedArtifact(root: string, target: string, code: string): fs.Stats {
  const resolvedRoot = path.resolve(root), resolved = path.resolve(target), relative = path.relative(resolvedRoot, resolved);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(code, "fixed root must be a real directory");
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(code, "artifact escaped fixed root");
  let cursor = resolvedRoot;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail(code, "artifact path contains symlink");
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.nlink !== 1) fail(code, "artifact must be regular nlink=1");
  return stat;
}

function exactBakeManifest(value: Record<string, unknown>, context: BakeRequestContext): { output: Record<string, unknown>; manifestPath?: string } {
  exactObject(value, ["version", "project_id", "bake_id", "request_sha256", "request", "derived_asset_id", "derived_media_kind", "representation", "effect_editable", "generated_content", "output"], "visual_bake_cache_corrupt");
  if (value.version !== BAKE_MANIFEST_VERSION || value.project_id !== context.request.project_id || value.bake_id !== context.bakeId || value.request_sha256 !== context.requestSha || value.derived_asset_id !== context.derivedAsset || value.derived_media_kind !== "premiere_visual_effect_bake" || value.representation !== "baked_visual" || value.effect_editable !== false || value.generated_content !== false || canonicalJson(value.request) !== canonicalJson(context.request)) fail("visual_bake_cache_corrupt", "manifest identity/request mismatch");
  const output = exactObject(value.output, ["path", "sha256", "video_stream_sha256", "probe", "packet_frame_evidence"], "visual_bake_cache_corrupt");
  if (typeof output.path !== "string" || typeof output.sha256 !== "string" || !SHA.test(output.sha256) || typeof output.video_stream_sha256 !== "string" || !SHA.test(output.video_stream_sha256)) fail("visual_bake_cache_corrupt", "manifest output invalid");
  return { output };
}

function validateReadyCache(context: BakeRequestContext): PremiereBakedRepresentation | undefined {
  const requestReadyPath = path.join(context.requestDir, "READY.json");
  if (!fs.existsSync(requestReadyPath)) return undefined;
  fixedArtifact(context.requestDir, requestReadyPath, "visual_bake_cache_corrupt");
  const requestReady = readJson(requestReadyPath, "visual_bake_cache_corrupt");
  exactObject(requestReady, ["version", "request_sha256", "generation_path", "generation_ready_sha256"], "visual_bake_cache_corrupt");
  if (requestReady.version !== "premiere-bake-request-ready/v1" || requestReady.request_sha256 !== context.requestSha || typeof requestReady.generation_path !== "string" || typeof requestReady.generation_ready_sha256 !== "string" || !SHA.test(requestReady.generation_ready_sha256)) fail("visual_bake_cache_corrupt", "request READY invalid");
  const generationDir = path.resolve(context.projectPath, requestReady.generation_path);
  const generationsRoot = path.join(context.requestDir, "generations");
  if (path.dirname(generationDir) !== generationsRoot) fail("visual_bake_cache_corrupt", "request READY generation is outside fixed request root");
  const readyGenerations = fs.readdirSync(generationsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && fs.existsSync(path.join(generationsRoot, entry.name, "READY.json")));
  if (readyGenerations.length !== 1 || path.join(generationsRoot, readyGenerations[0].name) !== generationDir) fail("visual_bake_cache_corrupt", "request must bind exactly one ready generation");
  const names = fs.readdirSync(generationDir).sort();
  if (names.join("|") !== "READY.json|clip.mp4|manifest.json") fail("visual_bake_cache_corrupt", "generation contents are not exact");
  const generationReadyPath = path.join(generationDir, "READY.json"), manifestPath = path.join(generationDir, "manifest.json"), mediaPath = path.join(generationDir, "clip.mp4");
  for (const file of [generationReadyPath, manifestPath, mediaPath]) fixedArtifact(generationsRoot, file, "visual_bake_cache_corrupt");
  if (hashRegularFile(generationReadyPath, "visual_bake_cache_corrupt") !== requestReady.generation_ready_sha256) fail("visual_bake_cache_corrupt", "generation READY hash mismatch");
  const generationReady = readJson(generationReadyPath, "visual_bake_cache_corrupt");
  exactObject(generationReady, ["version", "request_sha256", "output_sha256", "manifest_sha256"], "visual_bake_cache_corrupt");
  const manifestSha = hashRegularFile(manifestPath, "visual_bake_cache_corrupt");
  if (generationReady.version !== "premiere-bake-generation-ready/v1" || generationReady.request_sha256 !== context.requestSha || generationReady.manifest_sha256 !== manifestSha) fail("visual_bake_cache_corrupt", "generation READY invalid");
  const manifest = readJson(manifestPath, "visual_bake_cache_corrupt"), { output } = exactBakeManifest(manifest, context);
  const expectedMediaPath = projectRelative(context.projectPath, mediaPath, "visual_bake_cache_corrupt");
  if (output.path !== expectedMediaPath || path.basename(generationDir) !== String(output.sha256).slice(7) || generationReady.output_sha256 !== output.sha256) fail("visual_bake_cache_corrupt", "generation/media path mismatch");
  const sequence = context.request.sequence as Record<string, number>;
  const verified = validateOutput(context.ffprobe, mediaPath, context.classification.clip.timeline_duration_frames, sequence.fps_num, sequence.fps_den, sequence.width, sequence.height);
  if (verified.fileHash !== output.sha256 || verified.streamHash !== output.video_stream_sha256 || canonicalJson(verified.probe) !== canonicalJson(output.probe) || canonicalJson(verified.packetEvidence) !== canonicalJson(output.packet_frame_evidence)) fail("visual_bake_cache_corrupt", "cached media evidence mismatch");
  verifySourceStable(context.authority);
  return { representation: "baked_visual", clip_id: context.classification.clip_id, canonical_asset_id: context.classification.clip.asset_id, derived_asset_id: context.derivedAsset, bake_request_id: context.requestSha, manifest_path: projectRelative(context.projectPath, manifestPath, "visual_bake_cache_corrupt"), manifest_sha256: manifestSha, media_path: expectedMediaPath, media_sha256: verified.fileHash, media_video_stream_sha256: verified.streamHash, absolute_media_path: mediaPath, timeline_track_id: context.classification.track_id, source_in_us: context.classification.clip.src_in_us, source_out_us: context.classification.clip.src_out_us, timeline_duration_frames: context.classification.clip.timeline_duration_frames, fps_num: sequence.fps_num, fps_den: sequence.fps_den, effect_editable: false };
}

function assertEvaluationAssociation(context: BakeRequestContext): PremiereEffectBakeEvaluationAssociation {
  const association = context.evaluationAssociation;
  if (!association || !context.evaluationSha || !context.evaluationOrdinal
    || association.evaluation_sha256 !== context.evaluationSha
    || association.evaluation_ordinal !== context.evaluationOrdinal
    || association.track_id !== context.classification.track_id
    || association.clip_id !== context.classification.clip_id
    || association.request_sha256 !== context.requestSha
    || association.source_probe_broker_invocation_receipt_sha256 !== association.source_probe_invocation_receipt.receipt_sha256
    || association.source_probe_invocation_receipt.variant !== "source_ffprobe"
    || association.source_probe_invocation_receipt.binding.evaluation_sha256 !== context.evaluationSha
    || association.source_probe_invocation_receipt.binding.request_sha256 !== null
    || association.source_probe_invocation_receipt.binding.operation_ordinal !== 0
    || association.broker_invocation_receipt_sha256 !== association.ffmpeg_version_invocation_receipt.receipt_sha256
    || association.ffmpeg_version_invocation_receipt.variant !== "ffmpeg_version"
    || association.ffmpeg_version_invocation_receipt.binding.evaluation_sha256 !== context.evaluationSha
    || association.ffmpeg_version_invocation_receipt.binding.request_sha256 !== null
    || association.ffmpeg_version_invocation_receipt.binding.operation_ordinal !== 1
    || association.ffmpeg_version_sha256 !== context.request.ffmpeg_version_sha256) {
    fail("visual_bake_cache_corrupt", "evaluation/request association invalid");
  }
  return association;
}

async function validateReadyCacheBrokered(options: BrokeredPreflightOptions, context: BakeRequestContext): Promise<PremiereBakedRepresentation | undefined> {
  assertEvaluationAssociation(context);
  const requestReadyPath = path.join(context.requestDir, "READY.json");
  if (!fs.existsSync(requestReadyPath)) return undefined;
  fixedArtifact(context.requestDir, requestReadyPath, "visual_bake_cache_corrupt");
  const requestReady = readJson(requestReadyPath, "visual_bake_cache_corrupt");
  exactObject(requestReady, ["version", "request_sha256", "generation_path", "generation_ready_sha256"], "visual_bake_cache_corrupt");
  if (requestReady.version !== "premiere-bake-request-ready/v1" || requestReady.request_sha256 !== context.requestSha || typeof requestReady.generation_path !== "string" || typeof requestReady.generation_ready_sha256 !== "string" || !SHA.test(requestReady.generation_ready_sha256)) fail("visual_bake_cache_corrupt", "request READY invalid");
  const generationDir = path.resolve(context.projectPath, requestReady.generation_path), generationsRoot = path.join(context.requestDir, "generations");
  if (path.dirname(generationDir) !== generationsRoot) fail("visual_bake_cache_corrupt", "request READY generation is outside fixed request root");
  const readyGenerations = fs.readdirSync(generationsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && fs.existsSync(path.join(generationsRoot, entry.name, "READY.json")));
  if (readyGenerations.length !== 1 || path.join(generationsRoot, readyGenerations[0].name) !== generationDir) fail("visual_bake_cache_corrupt", "request must bind exactly one ready generation");
  if (fs.readdirSync(generationDir).sort().join("|") !== "READY.json|clip.mp4|manifest.json") fail("visual_bake_cache_corrupt", "generation contents are not exact");
  const generationReadyPath = path.join(generationDir, "READY.json"), manifestPath = path.join(generationDir, "manifest.json"), mediaPath = path.join(generationDir, "clip.mp4");
  for (const file of [generationReadyPath, manifestPath, mediaPath]) fixedArtifact(generationsRoot, file, "visual_bake_cache_corrupt");
  if (hashRegularFile(generationReadyPath, "visual_bake_cache_corrupt") !== requestReady.generation_ready_sha256) fail("visual_bake_cache_corrupt", "generation READY hash mismatch");
  const generationReady = readJson(generationReadyPath, "visual_bake_cache_corrupt");
  exactObject(generationReady, ["version", "request_sha256", "output_sha256", "manifest_sha256"], "visual_bake_cache_corrupt");
  const manifestSha = hashRegularFile(manifestPath, "visual_bake_cache_corrupt");
  if (generationReady.version !== "premiere-bake-generation-ready/v1" || generationReady.request_sha256 !== context.requestSha || generationReady.manifest_sha256 !== manifestSha) fail("visual_bake_cache_corrupt", "generation READY invalid");
  const manifest = readJson(manifestPath, "visual_bake_cache_corrupt"), { output } = exactBakeManifest(manifest, context), expectedMediaPath = projectRelative(context.projectPath, mediaPath, "visual_bake_cache_corrupt");
  if (output.path !== expectedMediaPath || path.basename(generationDir) !== String(output.sha256).slice(7) || generationReady.output_sha256 !== output.sha256) fail("visual_bake_cache_corrupt", "generation/media path mismatch");
  const sequence = context.request.sequence as Record<string, number>, generationId = `sha256:${path.basename(generationDir)}`;
  if (!SHA.test(generationId)) fail("visual_bake_cache_corrupt", "generation identity invalid");
  const verified = await validateOutputBrokered(options, context, mediaPath, generationId, context.classification.clip.timeline_duration_frames, sequence.fps_num, sequence.fps_den, sequence.width, sequence.height);
  if (verified.fileHash !== output.sha256 || verified.streamHash !== output.video_stream_sha256 || canonicalJson(verified.probe) !== canonicalJson(output.probe) || canonicalJson(verified.packetEvidence) !== canonicalJson(output.packet_frame_evidence)) fail("visual_bake_cache_corrupt", "cached media evidence mismatch");
  verifySourceStable(context.authority);
  return { representation: "baked_visual", clip_id: context.classification.clip_id, canonical_asset_id: context.classification.clip.asset_id, derived_asset_id: context.derivedAsset, bake_request_id: context.requestSha, manifest_path: projectRelative(context.projectPath, manifestPath, "visual_bake_cache_corrupt"), manifest_sha256: manifestSha, media_path: expectedMediaPath, media_sha256: verified.fileHash, media_video_stream_sha256: verified.streamHash, absolute_media_path: mediaPath, timeline_track_id: context.classification.track_id, source_in_us: context.classification.clip.src_in_us, source_out_us: context.classification.clip.src_out_us, timeline_duration_frames: context.classification.clip.timeline_duration_frames, fps_num: sequence.fps_num, fps_den: sequence.fps_den, effect_editable: false };
}

function renderAndPublishBake(context: BakeRequestContext): PremiereBakedRepresentation {
  ensureRealDirectoryTree(context.projectPath, context.requestDir, "visual_bake_cache_conflict");
  const claim = acquireBakeClaim(context.requestDir, context.requestSha);
  let successful = false;
  const stagingRoot = path.join(context.projectPath, BAKE_ROOT, "staging"), staging = path.join(stagingRoot, String(readClosedClaim(claim.path, context.requestSha).invocation_id));
  try {
    const afterAcquire = validateReadyCache(context); if (afterAcquire) { successful = true; return afterAcquire; }
    ensureRealDirectoryTree(context.projectPath, stagingRoot, "visual_bake_cache_conflict"); fs.mkdirSync(staging, { recursive: false });
    const stagedMedia = path.join(staging, "clip.mp4");
    verifySourceStable(context.authority);
    const render = spawnSync(context.ffmpeg, buildPremiereBakeFfmpegArgv(context.classification.clip, { sequence: context.request.sequence } as TimelineIR, context.filtergraph, stagedMedia).map((arg) => arg.replace("<SOURCE_FD>", "3")), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", context.authority.fd] });
    if (render.status !== 0) fail("visual_bake_render_failed", render.stderr ?? "ffmpeg failed");
    verifySourceStable(context.authority);
    const sequence = context.request.sequence as Record<string, number>;
    const verified = validateOutput(context.ffprobe, stagedMedia, context.classification.clip.timeline_duration_frames, sequence.fps_num, sequence.fps_den, sequence.width, sequence.height);
    const generationDir = path.join(context.requestDir, "generations", verified.fileHash.slice(7));
    ensureRealDirectoryTree(context.requestDir, path.dirname(generationDir), "visual_bake_cache_conflict");
    const generationsIdentity = directoryIdentity(path.dirname(generationDir), "visual_bake_cache_conflict");
    const finalMedia = path.join(generationDir, "clip.mp4"), finalManifest = path.join(generationDir, "manifest.json");
    const manifest = { version: BAKE_MANIFEST_VERSION, project_id: context.request.project_id, bake_id: context.bakeId, request_sha256: context.requestSha, request: context.request, derived_asset_id: context.derivedAsset, derived_media_kind: "premiere_visual_effect_bake", representation: "baked_visual", effect_editable: false, generated_content: false, output: { path: projectRelative(context.projectPath, finalMedia, "visual_bake_cache_corrupt"), sha256: verified.fileHash, video_stream_sha256: verified.streamHash, probe: verified.probe, packet_frame_evidence: verified.packetEvidence } };
    atomicJson(path.join(staging, "manifest.json"), manifest); fsyncDir(staging);
    if (fs.existsSync(generationDir)) {
      const names = fs.readdirSync(generationDir).sort().join("|");
      if (names !== "clip.mp4|manifest.json" && names !== "READY.json|clip.mp4|manifest.json") fail("visual_bake_cache_conflict", "orphan generation contents are not exact");
      for (const [existing, staged] of [[finalMedia, stagedMedia], [finalManifest, path.join(staging, "manifest.json")]] as const) if (hashRegularFile(existing, "visual_bake_cache_conflict") !== hashRegularFile(staged, "visual_bake_cache_conflict")) fail("visual_bake_cache_conflict", "orphan generation differs from deterministic render");
      fs.rmSync(staging, { recursive: true, force: true });
    } else fs.renameSync(staging, generationDir);
    fsyncDir(path.dirname(generationDir)); assertDirectoryIdentity(path.dirname(generationDir), generationsIdentity, "visual_bake_cache_conflict");
    for (const file of [finalMedia, finalManifest]) fixedArtifact(path.dirname(generationDir), file, "visual_bake_cache_corrupt");
    const manifestSha = hashRegularFile(finalManifest, "visual_bake_cache_corrupt");
    const generationIdentity = directoryIdentity(generationDir, "visual_bake_cache_conflict");
    const generationReadyPath = path.join(generationDir, "READY.json"), generationReady = { version: "premiere-bake-generation-ready/v1", request_sha256: context.requestSha, output_sha256: verified.fileHash, manifest_sha256: manifestSha };
    if (fs.existsSync(generationReadyPath)) {
      const existingReady = readJson(generationReadyPath, "visual_bake_cache_conflict"); exactObject(existingReady, Object.keys(generationReady), "visual_bake_cache_conflict");
      if (canonicalJson(existingReady) !== canonicalJson(generationReady)) fail("visual_bake_cache_conflict", "orphan generation READY mismatch");
    } else atomicJson(generationReadyPath, generationReady);
    assertDirectoryIdentity(generationDir, generationIdentity, "visual_bake_cache_conflict");
    const requestIdentity = directoryIdentity(context.requestDir, "visual_bake_cache_conflict");
    atomicJson(path.join(context.requestDir, "READY.json"), { version: "premiere-bake-request-ready/v1", request_sha256: context.requestSha, generation_path: projectRelative(context.projectPath, generationDir, "visual_bake_cache_corrupt"), generation_ready_sha256: hashRegularFile(generationReadyPath, "visual_bake_cache_corrupt") });
    assertDirectoryIdentity(context.requestDir, requestIdentity, "visual_bake_cache_conflict");
    const result = validateReadyCache(context); if (!result) fail("visual_bake_cache_corrupt", "published request is not reusable");
    successful = true; return result;
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    releaseBakeClaim(context.requestDir, claim, successful);
  }
}

function preflightErrorStatus(error: unknown): PremiereBakePreflightStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("visual_bake_rights_privacy_blocked")) return "rights_privacy_blocked";
  if (message.startsWith("visual_bake_source_unverified")) return "source_unverified";
  if (["visual_bake_unsupported", "visual_bake_declared_noop", "visual_bake_effect_invalid", "visual_bake_transform_invalid", "visual_bake_renderer_contract_mismatch"].some((code) => message.startsWith(code))) return "unsupported";
  return "conflict";
}

export function preflightPremiereEffectBakes(options: { projectPath: string; timeline: TimelineIR; rawTimeline: Buffer; sourceMapPath?: string }): PremiereBakePreflightItem[] {
  const projectPath = fs.realpathSync(options.projectPath), classifications = classifyPremiereVideoTreatments(options.timeline);
  const ffmpeg = classifications.some((item) => item.status === "bake_required") ? executable("ffmpeg") : "";
  const ffprobe = classifications.some((item) => item.status === "bake_required") ? executable("ffprobe") : "";
  return classifications.map((classification) => {
    if (classification.status === "native") return { clip_id: classification.clip_id, track_id: classification.track_id, status: "native" };
    if (classification.status === "blocked") return { clip_id: classification.clip_id, track_id: classification.track_id, status: "unsupported", reason: classification.detail };
    let context: BakeRequestContext | undefined;
    try {
      context = buildBakeRequestContext({ ...options, projectPath }, classification, ffmpeg, ffprobe);
      const reusable = validateReadyCache(context);
      const claimStatus = inspectBakeClaim(context.requestDir, context.requestSha);
      if (reusable) return { clip_id: classification.clip_id, track_id: classification.track_id, status: claimStatus === "none" ? "reusable" : claimStatus, request_sha256: context.requestSha };
      return { clip_id: classification.clip_id, track_id: classification.track_id, status: claimStatus === "none" ? "bake_required" : claimStatus, request_sha256: context.requestSha };
    } catch (error) {
      return { clip_id: classification.clip_id, track_id: classification.track_id, status: preflightErrorStatus(error), reason: error instanceof Error ? error.message : String(error), ...(context ? { request_sha256: context.requestSha } : {}) };
    } finally { if (context) fs.closeSync(context.authority.fd); }
  });
}

interface BrokeredPreflightOptions {
  projectPath: string;
  timeline: TimelineIR;
  rawTimeline: Buffer;
  sourceMapPath?: string;
  broker: PremierePreflightProcessBroker;
  preflightRunId: string;
  wrapper2Pid: number;
}

function discoveryBinding(
  options: BrokeredPreflightOptions,
  discoverySha256: string,
  tool: "ffmpeg" | "ffprobe",
  discoveryOrdinal: 0 | 1,
): PremierePreflightDiscoveryBinding {
  return {
    preflight_run_id: options.preflightRunId,
    wrapper2_pid: options.wrapper2Pid,
    discovery_sha256: discoverySha256,
    tool,
    discovery_ordinal: discoveryOrdinal,
  };
}

function brokerBinding(
  options: BrokeredPreflightOptions,
  evaluationOrdinal: number,
  classification: BakeClassification,
  evaluationSha256: string,
  operationOrdinal: number,
  requestSha256: string | null = null,
  readyCacheGenerationId: string | null = null,
): PremierePreflightEvaluationBinding {
  return {
    preflight_run_id: options.preflightRunId,
    wrapper2_pid: options.wrapper2Pid,
    evaluation_ordinal: evaluationOrdinal,
    track_id: classification.track_id,
    clip_id: classification.clip_id,
    evaluation_sha256: evaluationSha256,
    request_sha256: requestSha256,
    ready_cache_generation_id: readyCacheGenerationId,
    operation_ordinal: operationOrdinal,
  };
}

async function buildBrokeredBakeRequestContext(
  options: BrokeredPreflightOptions,
  classification: BakeClassification,
  evaluationOrdinal: number,
  discoverySha256: string,
  ffmpegReceipt: PremierePreflightToolDiscoveryReceipt,
  ffprobeReceipt: PremierePreflightToolDiscoveryReceipt,
): Promise<BakeRequestContext> {
  const authority = sourceAuthority(options.projectPath, options.timeline, classification.clip, options.sourceMapPath);
  try {
    const evaluationBody = immutable({
      domain: "premiere-effect-bake-evaluation/v2" as const,
      preflight_run_id: options.preflightRunId,
      discovery_sha256: discoverySha256,
      ffmpeg_discovery_receipt_sha256: ffmpegReceipt.broker_invocation_receipt_sha256,
      ffprobe_discovery_receipt_sha256: ffprobeReceipt.broker_invocation_receipt_sha256,
      ffmpeg_executable_identity: ffmpegReceipt.executable_identity,
      ffprobe_executable_identity: ffprobeReceipt.executable_identity,
      evaluation_ordinal: evaluationOrdinal,
      track_id: classification.track_id,
      clip_id: classification.clip_id,
      source_id: authority.source_id,
      source_locator_sha256: sha256Prefixed(authority.source),
      source_content_sha256: authority.hash,
      source_stat: immutable({ ...authority.identity }),
      timeline_sha256: sha256Prefixed(options.rawTimeline),
      effect_treatment: classification.treatment,
      classification_result: "bake_required" as const,
      classifier_version: VISUAL_TREATMENT_VERSION,
      profile_id: "adobe_premiere_fcp7xml_v1" as const,
    }) as Readonly<PremiereEffectBakeEvaluationBody>;
    const evaluationSha = sha256Prefixed(canonicalJson(evaluationBody));
    const probeResult = await options.broker.run(
      { kind: "source_ffprobe", source_path: authority.source, source_fd: authority.fd },
      brokerBinding(options, evaluationOrdinal, classification, evaluationSha, 0),
    );
    if (probeResult.receipt.exit_code !== 0 || probeResult.receipt.signal !== null) fail("visual_bake_source_unverified", `ffprobe: ${probeResult.stderr}`);
    const sourceProbe = validateSourceProbe(probeResult.stdout);
    const versionResult = await options.broker.run(
      { kind: "ffmpeg_version" },
      brokerBinding(options, evaluationOrdinal, classification, evaluationSha, 1),
    );
    if (versionResult.receipt.exit_code !== 0 || versionResult.receipt.signal !== null) fail("visual_bake_tool_failed", `ffmpeg: ${versionResult.stderr}`);
    const ffmpegVersion = normalizedFfmpegVersion(versionResult.stdout);
    const base = completeBakeRequestContext(options, classification, ffmpegReceipt.executable_realpath, ffprobeReceipt.executable_realpath, authority, sourceProbe, ffmpegVersion);
    const requestSha = bindPremiereEffectBakeRequestSha(base.requestSha, evaluationSha), digest = base.digest;
    const association = immutable({
      version: "premiere-effect-bake-evaluation-association/v1" as const,
      preflight_run_id: options.preflightRunId,
      evaluation_ordinal: evaluationOrdinal,
      track_id: classification.track_id,
      clip_id: classification.clip_id,
      discovery_sha256: discoverySha256,
      ffmpeg_discovery_receipt_sha256: ffmpegReceipt.broker_invocation_receipt_sha256,
      ffprobe_discovery_receipt_sha256: ffprobeReceipt.broker_invocation_receipt_sha256,
      evaluation_sha256: evaluationSha,
      source_probe_invocation_receipt: probeResult.receipt,
      source_probe_broker_invocation_receipt_sha256: probeResult.receipt.receipt_sha256,
      ffmpeg_version_invocation_receipt: versionResult.receipt,
      broker_invocation_receipt_sha256: versionResult.receipt.receipt_sha256,
      ffmpeg_version_sha256: sha256Prefixed(ffmpegVersion),
      request_sha256: requestSha,
    }) as PremiereEffectBakeEvaluationAssociation;
    return {
      ...base,
      requestSha,
      digest,
      bakeId: `VBK_${digest.slice(0, 24).toUpperCase()}`,
      derivedAsset: `AST_BAKE_${digest.slice(0, 24).toUpperCase()}`,
      requestDir: path.join(options.projectPath, BAKE_ROOT, "requests", digest),
      evaluationSha,
      evaluationOrdinal,
      evaluationAssociation: association,
    };
  } catch (error) {
    fs.closeSync(authority.fd);
    throw error;
  }
}

async function brokeredHostId(options: BrokeredPreflightOptions, binding: PremierePreflightEvaluationBinding): Promise<string> {
  let boot = "";
  if (fs.existsSync("/proc/sys/kernel/random/boot_id")) boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!boot) {
    const result = await options.broker.run({ kind: "sysctl_exact_if_reachable" }, binding);
    if (result.receipt.exit_code !== 0 || result.receipt.signal !== null) fail("visual_bake_claim_corrupt", "cannot establish host boot identity");
    boot = result.stdout.trim();
  }
  if (!boot) fail("visual_bake_claim_corrupt", "cannot establish host boot identity");
  return sha256Prefixed(`${os.hostname()}\0${boot}`);
}

async function inspectBakeClaimBrokered(
  options: BrokeredPreflightOptions,
  context: BakeRequestContext,
  evaluationOrdinal: number,
): Promise<"none" | "busy" | "stale" | "conflict"> {
  const file = path.join(context.requestDir, "CLAIM.json");
  if (!fs.existsSync(file)) return "none";
  try {
    const existing = readClosedClaim(file, context.requestSha);
    const hostId = await brokeredHostId(options, brokerBinding(options, evaluationOrdinal, context.classification, context.evaluationSha!, 6, context.requestSha));
    if (existing.host_id !== hostId) return "busy";
    const pid = existing.pid as number;
    const result = await options.broker.run({ kind: "ps_exact_if_reachable", pid }, brokerBinding(options, evaluationOrdinal, context.classification, context.evaluationSha!, 7, context.requestSha));
    const started = result.receipt.exit_code === 0 && result.receipt.signal === null ? result.stdout.trim() : "";
    const processId = started ? sha256Prefixed(`${hostId}\0${pid}\0${started}`) : undefined;
    return processId === existing.process_start_id ? "busy" : "stale";
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("forbidden_process")) throw error;
    return "conflict";
  }
}

export async function preflightPremiereEffectBakesBrokered(options: BrokeredPreflightOptions): Promise<PremiereBakePreflightItem[]> {
  const projectPath = fs.realpathSync(options.projectPath), classifications = classifyPremiereVideoTreatments(options.timeline);
  const brokerOptions = { ...options, projectPath };
  const hasBake = classifications.some((item) => item.status === "bake_required");
  let discoverySha = "";
  let ffmpegReceipt: PremierePreflightToolDiscoveryReceipt | undefined, ffprobeReceipt: PremierePreflightToolDiscoveryReceipt | undefined;
  if (hasBake) {
    const discovery = buildPremiereEffectBakeDiscovery(options.timeline, options.rawTimeline);
    discoverySha = discovery.sha256;
    ffmpegReceipt = (await options.broker.run({ kind: "which_ffmpeg" }, discoveryBinding(brokerOptions, discoverySha, "ffmpeg", 0))).receipt;
    ffprobeReceipt = (await options.broker.run({ kind: "which_ffprobe" }, discoveryBinding(brokerOptions, discoverySha, "ffprobe", 1))).receipt;
  }

  const items: PremiereBakePreflightItem[] = [];
  for (let index = 0; index < classifications.length; index++) {
    const classification = classifications[index];
    if (classification.status === "native") {
      items.push({ clip_id: classification.clip_id, track_id: classification.track_id, status: "native" });
      continue;
    }
    if (classification.status === "blocked") {
      items.push({ clip_id: classification.clip_id, track_id: classification.track_id, status: "unsupported", reason: classification.detail });
      continue;
    }
    let context: BakeRequestContext | undefined;
    try {
      if (!ffmpegReceipt || !ffprobeReceipt) fail("visual_bake_tool_failed", "required discovery receipts are unavailable");
      context = await buildBrokeredBakeRequestContext(brokerOptions, classification, index + 1, discoverySha, ffmpegReceipt, ffprobeReceipt);
      const reusable = await validateReadyCacheBrokered(brokerOptions, context);
      const claimStatus = await inspectBakeClaimBrokered(brokerOptions, context, index + 1);
      items.push({
        clip_id: classification.clip_id,
        track_id: classification.track_id,
        status: reusable ? claimStatus === "none" ? "reusable" : claimStatus : claimStatus === "none" ? "bake_required" : claimStatus,
        request_sha256: context.requestSha,
        evaluation_association: assertEvaluationAssociation(context),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("forbidden_process")) throw error;
      items.push({ clip_id: classification.clip_id, track_id: classification.track_id, status: preflightErrorStatus(error), reason: error instanceof Error ? error.message : String(error), ...(context ? { request_sha256: context.requestSha, evaluation_association: context.evaluationAssociation } : {}) });
    } finally {
      if (context) fs.closeSync(context.authority.fd);
    }
  }
  return items;
}

export function preparePremiereEffectBakes(options: { projectPath: string; timeline: TimelineIR; rawTimeline: Buffer; sourceMapPath?: string }): { representations: Map<string, PremiereBakedRepresentation>; index: PremiereEffectBakeIndex; cache_results: unknown[] } {
  const projectPath = fs.realpathSync(options.projectPath), classifications = classifyPremiereVideoTreatments(options.timeline);
  const blocked = classifications.find((entry) => entry.status === "blocked"); if (blocked?.status === "blocked") fail(blocked.reason, blocked.detail);
  const ffmpeg = executable("ffmpeg"), ffprobe = executable("ffprobe"), baseTimelineSha256 = sha256Prefixed(options.rawTimeline);
  const representations = new Map<string, PremiereBakedRepresentation>(), cacheResults: unknown[] = [];
  for (const classification of classifications) {
    if (classification.status !== "bake_required") continue;
    const context = buildBakeRequestContext({ ...options, projectPath }, classification, ffmpeg, ffprobe);
    try {
      let representation = validateReadyCache(context), status = "reused";
      if (representation) recoverReadyBakeClaim(context);
      else { representation = renderAndPublishBake(context); status = "rendered"; }
      representations.set(classification.clip_id, representation);
      cacheResults.push({ clip_id: classification.clip_id, status, request_sha256: context.requestSha, media_sha256: representation.media_sha256 });
    } finally { fs.closeSync(context.authority.fd); }
  }
  const entries = [...representations.values()].sort((a, b) => Buffer.from(a.clip_id).compare(Buffer.from(b.clip_id))).map(({ absolute_media_path: _absolute, timeline_track_id: _track, source_in_us: _in, source_out_us: _out, timeline_duration_frames: _duration, fps_num: _fpsNum, fps_den: _fpsDen, effect_editable: _editable, representation: _representation, ...entry }) => entry);
  for (const key of ["clip_id", "canonical_asset_id", "derived_asset_id", "bake_request_id", "manifest_path", "manifest_sha256", "media_path", "media_sha256", "media_video_stream_sha256"] as const) if (new Set(entries.map((entry) => entry[key])).size !== entries.length) fail("visual_bake_index_conflict", `duplicate index ${key}`);
  return { representations, index: { version: BAKE_INDEX_VERSION, project_id: options.timeline.project_id, base_timeline_sha256: baseTimelineSha256, entries }, cache_results: cacheResults };
}

export interface PremiereBakeArtifactExpectation {
  clip_id: string; canonical_asset_id: string; derived_asset_id: string; bake_request_id: string;
  manifest_path: string; manifest_sha256: string; media_path: string; media_sha256: string; media_video_stream_sha256: string;
}

function validateStoredRequest(projectPath: string, request: Record<string, unknown>, requestSha: string): BakeRequestContext {
  exactObject(request, ["version", "renderer_contract_version", "project_id", "base_timeline_sha256", "clip_id", "track_id", "asset_id", "source_id", "source_locator", "source_origin", "rights_status", "privacy_status", "source_in_us", "source_out_us", "timeline_duration_frames", "source_sha256", "source_identity", "source_probe", "treatment", "scaled_dimensions", "sequence", "filtergraph", "ffmpeg_argv", "ffmpeg_path", "ffmpeg_sha256", "ffmpeg_version", "ffmpeg_version_sha256", "policy", "authority_paths", "authority_hashes"], "baked_media_unverified");
  if (request.version !== "premiere-effect-bake-request/v1" || request.renderer_contract_version !== "6" || typeof request.project_id !== "string" || !request.project_id || typeof request.clip_id !== "string" || !request.clip_id || typeof request.track_id !== "string" || !request.track_id || typeof request.asset_id !== "string" || !request.asset_id || typeof request.source_id !== "string" || !request.source_id || typeof request.source_locator !== "string" || !path.isAbsolute(request.source_locator) || typeof request.base_timeline_sha256 !== "string" || !SHA.test(request.base_timeline_sha256) || typeof request.source_sha256 !== "string" || !SHA.test(request.source_sha256) || request.rights_status !== "operator_declared_ok" && request.rights_status !== "licensed" || request.privacy_status !== "operator_declared_ok" || request.source_origin !== "original_source" && request.source_origin !== "verified_caption_free_proxy") fail("baked_media_unverified", "stored request identity/authority invalid");
  const sourceInUs = safeInteger(request.source_in_us, "baked_media_unverified"), sourceOutUs = safeInteger(request.source_out_us, "baked_media_unverified"), durationFrames = safeInteger(request.timeline_duration_frames, "baked_media_unverified");
  if (sourceInUs < 0 || sourceOutUs <= sourceInUs || durationFrames <= 0) fail("baked_media_unverified", "stored request timing invalid");
  if (sha256Prefixed(`premiere-effect-bake-request/v1\0${canonicalJson(request)}`) !== requestSha) fail("baked_media_unverified", "stored request digest mismatch");
  const sequence = exactObject(request.sequence, ["width", "height", "fps_num", "fps_den"], "baked_media_unverified");
  const sequenceWidth = safeInteger(sequence.width, "baked_media_unverified"), sequenceHeight = safeInteger(sequence.height, "baked_media_unverified");
  const sequenceFpsNum = safeInteger(sequence.fps_num, "baked_media_unverified"), sequenceFpsDen = safeInteger(sequence.fps_den, "baked_media_unverified");
  if (sequenceWidth <= 0 || sequenceHeight <= 0 || sequenceFpsNum <= 0 || sequenceFpsDen <= 0) fail("baked_media_unverified", "stored sequence values invalid");
  const scaledDimensions = exactObject(request.scaled_dimensions, ["width", "height"], "baked_media_unverified");
  for (const key of ["width", "height"] as const) if (typeof scaledDimensions[key] !== "number" || !Number.isSafeInteger(scaledDimensions[key]) || scaledDimensions[key] <= 0) fail("baked_media_unverified", `stored scaled dimension ${key} invalid`);
  const policy = exactObject(request.policy, ["codec", "crf", "preset", "threads", "bframes", "color", "sar", "topology"], "baked_media_unverified");
  if (canonicalJson(policy) !== canonicalJson({ codec: "h264", crf: 14, preset: "veryfast", threads: 1, bframes: 0, color: "bt709_limited", sar: "1:1", topology: "video_only" })) fail("baked_media_unverified", "stored encoder policy mismatch");
  const authorityPaths = exactObject(request.authority_paths, ["source_map", "source_ledger", "source_media_manifest"], "baked_media_unverified"), authorityHashes = exactObject(request.authority_hashes, ["source_map", "source_ledger", "source_media_manifest"], "baked_media_unverified");
  for (const key of ["source_map", "source_ledger", "source_media_manifest"] as const) {
    if (typeof authorityPaths[key] !== "string" || unsafeRelative(authorityPaths[key] as string) || typeof authorityHashes[key] !== "string" || !SHA.test(authorityHashes[key] as string)) fail("baked_media_unverified", "stored authority reference invalid");
    if (hashRegularFile(path.resolve(projectPath, authorityPaths[key] as string), "baked_media_unverified") !== authorityHashes[key]) fail("baked_media_unverified", "stored authority hash mismatch");
  }
  const treatmentRecord = exactObject(request.treatment, ["version", "transform", "effects"], "baked_media_unverified");
  const transform = exactObject(treatmentRecord.transform, ["zoom", "crop", "position"], "baked_media_unverified");
  if (!Array.isArray(treatmentRecord.effects)) fail("baked_media_unverified", "stored treatment effects invalid");
  const metadata: Record<string, unknown> = { zoom: transform.zoom };
  if (transform.crop !== null) metadata.crop = transform.crop;
  if (transform.position !== null) metadata.position = transform.position;
  if (treatmentRecord.effects.length) metadata.render = { effects: treatmentRecord.effects };
  const clip: ClipOutput = {
    clip_id: textField(request.clip_id, "clip_id", "baked_media_unverified"), segment_id: `stored-bake:${requestSha}`,
    asset_id: textField(request.asset_id, "asset_id", "baked_media_unverified"), src_in_us: sourceInUs, src_out_us: sourceOutUs,
    timeline_in_frame: 0, timeline_duration_frames: durationFrames, role: "primary", motivation: "stored Premiere bake validation",
    beat_id: "stored-bake", fallback_segment_ids: [], confidence: 1, quality_flags: [], metadata,
  };
  const timeline: TimelineIR = {
    version: "1", project_id: textField(request.project_id, "project_id", "baked_media_unverified"), created_at: "1970-01-01T00:00:00.000Z",
    sequence: { name: "Stored Premiere bake", width: sequenceWidth, height: sequenceHeight, fps_num: sequenceFpsNum, fps_den: sequenceFpsDen, start_frame: 0 },
    tracks: { video: [], audio: [] }, markers: [],
    provenance: { brief_path: "stored-bake", blueprint_path: "stored-bake", selects_path: "stored-bake", compiler_version: "stored-bake-validation" },
  };
  const normalizedTreatment = normalizePremiereVisualTreatment(clip, sequenceWidth, sequenceHeight);
  if (canonicalJson(normalizedTreatment) !== canonicalJson(request.treatment)) fail("baked_media_unverified", "stored treatment normalization mismatch");
  if (scaledDimensions.width !== Math.round(sequenceWidth * normalizedTreatment.transform.zoom) || scaledDimensions.height !== Math.round(sequenceHeight * normalizedTreatment.transform.zoom)) fail("baked_media_unverified", "stored scaled dimensions mismatch");
  const authority = sourceAuthority(projectPath, timeline, clip, path.resolve(projectPath, authorityPaths.source_map as string));
  try {
    const sourceProbe = probeSource(executable("ffprobe"), authority.fd);
    const identity = exactObject(request.source_identity, ["dev", "ino", "size", "mode", "mtime_ms", "ctime_ms", "nlink"], "baked_media_unverified");
    const liveAuthorityPaths = { source_map: projectRelative(projectPath, authority.mapPath, "baked_media_unverified"), source_ledger: projectRelative(projectPath, authority.ledgerPath, "baked_media_unverified"), source_media_manifest: projectRelative(projectPath, authority.manifestPath, "baked_media_unverified") };
    if (canonicalJson(identity) !== canonicalJson(authority.identity) || canonicalJson(authorityPaths) !== canonicalJson(liveAuthorityPaths) || canonicalJson(authorityHashes) !== canonicalJson(authority.authorityHashes) || request.source_id !== authority.source_id || request.source_locator !== authority.source || request.source_origin !== authority.source_origin || request.rights_status !== authority.rights_status || request.privacy_status !== authority.privacy_status || request.source_sha256 !== authority.hash || canonicalJson(request.source_probe) !== canonicalJson(sourceProbe)) fail("baked_media_unverified", "stored source evidence mismatch");
    const ffmpeg = executable("ffmpeg"), ffprobe = executable("ffprobe"), ffmpegVersion = execFileSync(ffmpeg, ["-version"], { encoding: "utf8" });
    if (request.ffmpeg_path !== ffmpeg || request.ffmpeg_sha256 !== sha256Prefixed(fs.readFileSync(ffmpeg)) || request.ffmpeg_version !== ffmpegVersion || request.ffmpeg_version_sha256 !== sha256Prefixed(ffmpegVersion)) fail("baked_media_unverified", "stored FFmpeg authority mismatch");
    const filtergraph = buildPremiereBakeFiltergraph(normalizedTreatment, timeline, clip, sourceProbe.video.color_range as "tv" | "pc");
    if (request.filtergraph !== filtergraph || canonicalJson(request.ffmpeg_argv) !== canonicalJson(buildPremiereBakeFfmpegArgv(clip, timeline, filtergraph))) fail("baked_media_unverified", "stored effective render contract mismatch");
    const digest = requestSha.slice(7);
    return { projectPath, classification: { status: "bake_required", clip_id: request.clip_id as string, track_id: request.track_id as string, clip, treatment: normalizedTreatment }, authority, sourceProbe, ffmpeg, ffprobe, request, requestSha, digest, bakeId: `VBK_${digest.slice(0, 24).toUpperCase()}`, derivedAsset: `AST_BAKE_${digest.slice(0, 24).toUpperCase()}`, requestDir: path.join(projectPath, BAKE_ROOT, "requests", digest), filtergraph };
  } catch (error) { fs.closeSync(authority.fd); throw error; }
}

function unsafeRelative(value: string): boolean {
  try { const decoded = decodeURIComponent(value); return !value || value.includes("\0") || path.isAbsolute(value) || decoded.split(/[\\/]/).includes(".."); } catch { return true; }
}

export function validatePremiereBakeArtifactGraph(projectPathInput: string, expected: PremiereBakeArtifactExpectation, expectedBaseTimelineSha256?: string, expectedProjectId?: string): PremiereBakedRepresentation {
  const projectPath = fs.realpathSync(projectPathInput);
  for (const hash of [expected.bake_request_id, expected.manifest_sha256, expected.media_sha256, expected.media_video_stream_sha256]) if (!SHA.test(hash)) fail("baked_media_unverified", "artifact expectation hash invalid");
  const requestDir = path.join(projectPath, BAKE_ROOT, "requests", expected.bake_request_id.slice(7)), generationDir = path.join(requestDir, "generations", expected.media_sha256.slice(7));
  const manifestPath = path.join(generationDir, "manifest.json"), mediaPath = path.join(generationDir, "clip.mp4");
  if (expected.manifest_path !== projectRelative(projectPath, manifestPath, "baked_media_unverified") || expected.media_path !== projectRelative(projectPath, mediaPath, "baked_media_unverified")) fail("baked_media_unverified", "artifact paths are outside fixed ready roots");
  fixedArtifact(path.join(projectPath, BAKE_ROOT), manifestPath, "baked_media_unverified");
  if (hashRegularFile(manifestPath, "baked_media_unverified") !== expected.manifest_sha256) fail("baked_media_unverified", "manifest hash mismatch");
  const manifest = readJson(manifestPath, "baked_media_unverified"), request = manifest.request as Record<string, unknown>;
  if (!request || typeof request !== "object" || Array.isArray(request) || manifest.request_sha256 !== expected.bake_request_id || expectedProjectId && (manifest.project_id !== expectedProjectId || request.project_id !== expectedProjectId)) fail("baked_media_unverified", "manifest request missing or project identity mismatch");
  if (expectedBaseTimelineSha256 && request.base_timeline_sha256 !== expectedBaseTimelineSha256) fail("baked_media_unverified", "bake request base timeline mismatch");
  const context = validateStoredRequest(projectPath, request, expected.bake_request_id);
  try {
    const representation = validateReadyCache(context);
    if (!representation || representation.clip_id !== expected.clip_id || representation.canonical_asset_id !== expected.canonical_asset_id || representation.derived_asset_id !== expected.derived_asset_id || representation.manifest_sha256 !== expected.manifest_sha256 || representation.media_sha256 !== expected.media_sha256 || representation.media_video_stream_sha256 !== expected.media_video_stream_sha256) fail("baked_media_unverified", "artifact graph does not match receipt/index");
    return representation;
  } finally { fs.closeSync(context.authority.fd); }
}

export function assertPremiereVideoRepresentations(timeline: TimelineIR, representations?: Map<string, PremiereBakedRepresentation>): void {
  for (const classification of classifyPremiereVideoTreatments(timeline)) {
    if (classification.status === "blocked") fail(classification.reason, classification.detail);
    if (classification.status === "bake_required" && !representations?.has(classification.clip_id)) fail("visual_bake_representation_required", `treated clip ${classification.clip_id} has no verified baked representation`);
  }
}
