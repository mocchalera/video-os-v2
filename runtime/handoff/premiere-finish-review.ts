import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants, lstatSync, openSync, closeSync, fstatSync, realpathSync, readFileSync, accessSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { ClipOutput, TimelineIR } from "../compiler/types.js";
import { resolveFcp7AudioLevelsEmissionDecision } from "./fcp7-xml-export.js";
import {
  classifyPremiereVideoTreatments,
  encodePremiereTimelineIdentity,
  parsePremiereTimelineIdentity,
  samePremiereTimelineIdentity,
  type PremiereBakePreflightStatus,
  type PremiereTimelineIdentity,
  type PremiereTreatmentClassification,
} from "./premiere-effect-bake.js";

const require = createRequire(import.meta.url);
type Validate = ((value: unknown) => boolean) & { errors?: unknown };
const Ajv2020 = require("ajv/dist/2020") as new (options: Record<string, unknown>) => {
  compile(schema: object): Validate;
};
const addFormats = require("ajv-formats") as (ajv: InstanceType<typeof Ajv2020>) => void;

const REVIEW_VERSION = "premiere-finish-review/v2" as const;
const PROFILE_ID = "adobe_premiere_fcp7xml_v1" as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PREFLIGHT_STATUSES = new Set<PremiereBakePreflightStatus>([
  "native", "bake_required", "reusable", "busy", "stale", "conflict",
  "unsupported", "source_unverified", "rights_privacy_blocked",
]);
const HARD_STATUSES = new Set<PremiereBakePreflightStatus>([
  "busy", "conflict", "unsupported", "source_unverified", "rights_privacy_blocked",
]);

export type PremiereFinishReviewErrorCode =
  | "invalid_projection"
  | "unsupported_profile"
  | "duplicate_target"
  | "tool_unavailable"
  | "preflight_contract_error"
  | "timeline_revision_changed";

export class PremiereFinishReviewError extends Error {
  constructor(readonly code: PremiereFinishReviewErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "PremiereFinishReviewError";
  }
}

export interface PremiereFinishReviewTextItem {
  kind: "text";
  target: { track_id: string; clip_id: string; overlay_id: string };
  source: {
    role: "title";
    text: string;
    styling_class: string;
    writing_mode: string | null;
    anchor: string | null;
    authored_source: string | null;
    timeline_in_frame: number;
    timeline_duration_frames: number;
  };
  status: "blocked";
  raw_status: "report_only";
  reason_code: "profile_text_export_blocked";
  action_code: "review_text_then_wait_for_full_handoff";
}

export interface PremiereFinishReviewTransitionItem {
  kind: "transition";
  target: { transition_id: string; track_id: string; from_clip_id: string; to_clip_id: string };
  source: {
    transition_type: string;
    transition_frames: number | null;
    applied_skill_id: string | null;
    degraded_from_skill_id: string | null;
    confidence: number | null;
  };
  status: "report_only" | "unsupported";
  raw_status: "allowed_type_report_only" | "type_not_allowed";
  reason_code: "profile_transition_report_only" | "transition_type_not_allowed";
  action_code: "review_transition_then_wait_for_full_handoff" | "change_or_remove_transition";
}

type AudioPolicyProjection = {
  mode: string | null;
  gain_unit: string | null;
  duck_music_db: number | null;
  nat_gain: number | null;
  nat_sound_gain: number | null;
  bgm_gain: number | null;
  a1_loudnorm: boolean | null;
  preserve_nat_sound: boolean | null;
  fade_in_frames: number | null;
  fade_out_frames: number | null;
  nat_sound_fade_in_frames: number | null;
  nat_sound_fade_out_frames: number | null;
  bgm_fade_in_frames: number | null;
  bgm_fade_out_frames: number | null;
};

export interface PremiereFinishReviewAudioItem {
  kind: "audio";
  target: { track_id: string; clip_id: string; effect_id: "audiolevels" };
  source: { audio_policy: AudioPolicyProjection };
  status: "provisional_roundtrip";
  raw_status: "provisional_roundtrip";
  reason_code: "profile_audiolevels_provisional";
  action_code: "review_audio_levels_then_wait_for_full_handoff";
}

export interface PremiereFinishReviewVisualItem {
  kind: "visual_effect";
  target: { track_id: string; clip_id: string; effect_ids: string[] | null };
  status: "native" | "bake_required" | "ready" | "stale" | "busy" | "conflict" | "source_unverified" | "rights_privacy_blocked" | "unsupported" | "error";
  raw_status: PremiereBakePreflightStatus | "error";
  reason: string | null;
  action_code: "none" | "consent_required_but_execution_blocked" | "reuse_available_but_execution_blocked" | "rebake_required_but_execution_blocked" | "retry_after_busy" | "resolve_conflict" | "verify_source" | "resolve_rights_privacy" | "remove_or_replace_effect" | "inspect_error";
  request_sha256: string | null;
}

export type PremiereFinishReviewSurface =
  | PremiereFinishReviewTextItem
  | PremiereFinishReviewTransitionItem
  | PremiereFinishReviewAudioItem
  | PremiereFinishReviewVisualItem;

export interface PremiereFinishReviewProjection {
  version: typeof REVIEW_VERSION;
  project_id: string;
  profile_id: typeof PROFILE_ID;
  base_timeline_sha256: string;
  hardware_verified: false;
  surfaces: PremiereFinishReviewSurface[];
}

export interface PremierePreflightChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface PremierePreflightInvocation {
  executable: string;
  args: readonly [string, string, "--preflight", "--json", "--expected-timeline-sha256", string, "--expected-timeline-identity-json", string];
  cwd: string;
}

export interface PremiereFinishReviewOptions {
  repoRoot?: string;
  preflightRunner?: (invocation: PremierePreflightInvocation) => PremierePreflightChildResult;
  beforeSecondTimelineRead?: () => void;
}

interface PinnedTimeline {
  bytes: Buffer;
  timeline: TimelineIR;
  sha256: string;
  identity: TimelineIdentity;
}

interface TimelineIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface StrictPreflightItem {
  clip_id: string;
  track_id: string;
  status: PremiereBakePreflightStatus;
  reason: string | null;
  request_sha256: string | null;
}

interface PremiereProfile {
  profile_id: string;
  surfaces: {
    text_overlay: { mode: string; export_mode?: string };
    simple_transition: { mode: string; allowed_types?: string[] };
    audio_levels: { mode: string; allowed_effect_ids?: string[] };
    visual_effect_bake: { mode: string; hardware_verified: boolean };
  };
}

function fail(code: PremiereFinishReviewErrorCode, detail: string): never {
  throw new PremiereFinishReviewError(code, detail);
}

function exactObject(value: unknown, allowed: readonly string[], required: readonly string[], detail: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("preflight_contract_error", `${detail} must be object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(record, key))) {
    fail("preflight_contract_error", `${detail} fields are not exact`);
  }
  return record;
}

function nonempty(value: unknown, code: PremiereFinishReviewErrorCode, detail: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(code, `${detail} must be nonempty string`);
  return value;
}

function nullableString(value: unknown, code: PremiereFinishReviewErrorCode, detail: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(code, `${detail} must be string or null`);
  return value;
}

function utf8Compare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function compareTuple(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const order = utf8Compare(left[index], right[index]);
    if (order !== 0) return order;
  }
  return 0;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(input as object).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))) {
        output[key] = normalize((input as Record<string, unknown>)[key]);
      }
      return output;
    }
    if (typeof input === "number" && !Number.isFinite(input)) fail("preflight_contract_error", "receipt contains non-finite number");
    return Object.is(input, -0) ? 0 : input;
  };
  return JSON.stringify(normalize(value));
}

interface StrictReceiptExpectation {
  variant: "source_ffprobe" | "ffmpeg_version";
  operationOrdinal: 0 | 1;
  preflightRunId: string;
  evaluationOrdinal: number;
  evaluationSha256: string;
  trackId: string;
  clipId: string;
}

function strictEvaluationReceipt(value: unknown, expected: StrictReceiptExpectation, detail: string): { sha256: string; childPid: number } {
  const receipt = exactObject(value, [
    "variant", "binding", "executable_realpath", "argv", "child_pid", "parent_pid", "exit_code", "signal",
    "stdout_sha256", "stderr_sha256", "receipt_sha256",
  ], [
    "variant", "binding", "executable_realpath", "argv", "child_pid", "parent_pid", "exit_code", "signal",
    "stdout_sha256", "stderr_sha256", "receipt_sha256",
  ], detail);
  const binding = exactObject(receipt.binding, [
    "preflight_run_id", "wrapper2_pid", "evaluation_ordinal", "track_id", "clip_id", "evaluation_sha256",
    "request_sha256", "ready_cache_generation_id", "operation_ordinal",
  ], [
    "preflight_run_id", "wrapper2_pid", "evaluation_ordinal", "track_id", "clip_id", "evaluation_sha256",
    "request_sha256", "ready_cache_generation_id", "operation_ordinal",
  ], `${detail}.binding`);
  const expectedArgv = expected.variant === "source_ffprobe"
    ? ["-v", "error", "-show_format", "-show_streams", "-of", "json", "file:/dev/fd/3"]
    : ["-version"];
  const executable = receipt.executable_realpath;
  const childPid = receipt.child_pid, parentPid = receipt.parent_pid;
  if (receipt.variant !== expected.variant
    || binding.preflight_run_id !== expected.preflightRunId || binding.evaluation_ordinal !== expected.evaluationOrdinal
    || binding.track_id !== expected.trackId || binding.clip_id !== expected.clipId || binding.evaluation_sha256 !== expected.evaluationSha256
    || binding.request_sha256 !== null || binding.ready_cache_generation_id !== null || binding.operation_ordinal !== expected.operationOrdinal
    || typeof binding.wrapper2_pid !== "number" || !Number.isSafeInteger(binding.wrapper2_pid) || binding.wrapper2_pid <= 0
    || typeof executable !== "string" || !path.isAbsolute(executable) || path.normalize(executable) !== executable || /[\0\r\n]/.test(executable)
    || path.basename(executable) !== (expected.variant === "source_ffprobe" ? "ffprobe" : "ffmpeg")
    || canonicalJson(receipt.argv) !== canonicalJson(expectedArgv)
    || typeof childPid !== "number" || !Number.isSafeInteger(childPid) || childPid <= 0
    || typeof parentPid !== "number" || !Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid !== binding.wrapper2_pid || childPid === parentPid
    || receipt.exit_code !== 0 || receipt.signal !== null
    || typeof receipt.stdout_sha256 !== "string" || !SHA256.test(receipt.stdout_sha256)
    || typeof receipt.stderr_sha256 !== "string" || !SHA256.test(receipt.stderr_sha256)
    || typeof receipt.receipt_sha256 !== "string" || !SHA256.test(receipt.receipt_sha256)) {
    fail("preflight_contract_error", `${detail} links are invalid`);
  }
  const body = { ...receipt };
  delete body.receipt_sha256;
  if (sha256(Buffer.from(canonicalJson(body))) !== receipt.receipt_sha256) fail("preflight_contract_error", `${detail} SHA is invalid`);
  return { sha256: receipt.receipt_sha256, childPid };
}

function assertNoSymlinkComponents(absolutePath: string): void {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const part of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail("invalid_projection", `${current} must not be a symlink`);
  }
}

function canonicalDirectory(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  assertNoSymlinkComponents(resolved);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid_projection", "project must be a real directory");
  if (realpathSync(resolved) !== resolved) fail("invalid_projection", "project canonical path mismatch");
  return resolved;
}

function identityOf(stat: ReturnType<typeof fstatSync>): TimelineIdentity {
  const value = stat as unknown as {
    dev: bigint; ino: bigint; mode: bigint; nlink: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint;
  };
  return {
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function sameIdentity(left: TimelineIdentity, right: TimelineIdentity): boolean {
  return (Object.keys(left) as Array<keyof TimelineIdentity>).every((key) => left[key] === right[key]);
}

function wireIdentity(identity: TimelineIdentity): PremiereTimelineIdentity {
  if (identity.mode > BigInt(Number.MAX_SAFE_INTEGER) || identity.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("invalid_projection", "timeline identity exceeds safe JSON integer range");
  }
  return parsePremiereTimelineIdentity({
    dev: String(identity.dev),
    ino: String(identity.ino),
    mode: Number(identity.mode),
    nlink: Number(identity.nlink),
    size: Number(identity.size),
    mtime_ns: String(identity.mtimeNs),
    ctime_ns: String(identity.ctimeNs),
  });
}

function readPinnedTimeline(timelinePath: string, validateTimeline: Validate): PinnedTimeline {
  assertNoSymlinkComponents(timelinePath);
  const fd = openSync(timelinePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) fail("invalid_projection", "timeline must be regular nlink=1");
    const bytes = readFileSync(fd);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("invalid_projection", "timeline JSON is malformed");
    }
    if (!validateTimeline(parsed)) fail("invalid_projection", `timeline schema mismatch: ${JSON.stringify(validateTimeline.errors ?? [])}`);
    return { bytes, timeline: parsed as TimelineIR, sha256: sha256(bytes), identity: identityOf(stat as never) };
  } finally {
    closeSync(fd);
  }
}

function currentTimelineIdentity(timelinePath: string): { identity: TimelineIdentity; sha256: string } {
  assertNoSymlinkComponents(timelinePath);
  const fd = openSync(timelinePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) fail("timeline_revision_changed", "timeline is no longer regular nlink=1");
    return { identity: identityOf(stat as never), sha256: sha256(readFileSync(fd)) };
  } finally {
    closeSync(fd);
  }
}

function findRepoRoot(explicit?: string): string {
  if (explicit) return canonicalDirectory(explicit);
  let candidate = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (lstatSync(path.join(candidate, "package.json"), { throwIfNoEntry: false })?.isFile()
      && lstatSync(path.join(candidate, "runtime", "nle-profiles", "premiere-v1.yaml"), { throwIfNoEntry: false })?.isFile()) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) fail("tool_unavailable", "repository root not found");
    candidate = parent;
  }
}

function validators(repoRoot: string): { timeline: Validate; profile: Validate } {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const timelineSchema = JSON.parse(readFileSync(path.join(repoRoot, "schemas", "timeline-ir.schema.json"), "utf8")) as object;
  const profileSchema = JSON.parse(readFileSync(path.join(repoRoot, "schemas", "nle-capability-profile.schema.json"), "utf8")) as object;
  return { timeline: ajv.compile(timelineSchema), profile: ajv.compile(profileSchema) };
}

function loadProfile(repoRoot: string, validate: Validate): PremiereProfile {
  const profilePath = path.join(repoRoot, "runtime", "nle-profiles", "premiere-v1.yaml");
  const value = parseYaml(readFileSync(profilePath, "utf8")) as unknown;
  if (!validate(value)) fail("unsupported_profile", `profile schema mismatch: ${JSON.stringify(validate.errors ?? [])}`);
  const profile = value as PremiereProfile;
  const transition = profile.surfaces.simple_transition;
  const audio = profile.surfaces.audio_levels;
  const text = profile.surfaces.text_overlay;
  const visual = profile.surfaces.visual_effect_bake;
  if (profile.profile_id !== PROFILE_ID
    || text.mode !== "report_only" || text.export_mode !== "blocked"
    || transition.mode !== "report_only" || !Array.isArray(transition.allowed_types)
    || audio.mode !== "provisional_roundtrip" || JSON.stringify(audio.allowed_effect_ids) !== '["audiolevels"]'
    || visual.mode !== "derived_video_replacement" || visual.hardware_verified !== false) {
    fail("unsupported_profile", "Premiere finish surface tuple is unsupported");
  }
  return profile;
}

function localExecutable(repoRoot: string, relative: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(path.join(repoRoot, relative));
    const rel = path.relative(path.join(repoRoot, "node_modules"), resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) fail("tool_unavailable", `${relative} escapes node_modules`);
    const stat = lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("tool_unavailable", `${relative} is not a regular file`);
    accessSync(resolved, fsConstants.X_OK);
  } catch (error) {
    if (error instanceof PremiereFinishReviewError) throw error;
    fail("tool_unavailable", `${relative} is unavailable`);
  }
  return resolved;
}

function defaultPreflightRunner(invocation: PremierePreflightInvocation): PremierePreflightChildResult {
  const result = spawnSync(invocation.executable, [...invocation.args], {
    cwd: invocation.cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function strictTimelineIdentity(value: unknown, detail: string): PremiereTimelineIdentity {
  try {
    return parsePremiereTimelineIdentity(value);
  } catch {
    fail("preflight_contract_error", `${detail} is invalid`);
  }
}

function strictPreflight(
  result: PremierePreflightChildResult,
  expectedProjectId: string,
  expectedTimelineSha256: string,
  expectedTimelineIdentity: PremiereTimelineIdentity,
): StrictPreflightItem[] {
  if (result.error || result.signal || result.status === null || ![0, 1, 2].includes(result.status)) {
    fail("preflight_contract_error", "preflight did not return a supported numeric exit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail("preflight_contract_error", "preflight stdout is not exactly one JSON object");
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && (parsed as Record<string, unknown>).status === "timeline_revision_mismatch") {
    const mismatch = exactObject(parsed, [
      "version", "project_id", "status", "expected_timeline_sha256", "observed_timeline_sha256",
      "expected_timeline_identity", "observed_timeline_identity", "hardware_verified", "items",
    ], [
      "version", "project_id", "status", "expected_timeline_sha256", "observed_timeline_sha256",
      "expected_timeline_identity", "observed_timeline_identity", "hardware_verified", "items",
    ], "timeline revision mismatch");
    const mismatchExpectedIdentity = strictTimelineIdentity(mismatch.expected_timeline_identity, "expected timeline identity");
    const observedIdentity = mismatch.observed_timeline_identity === null
      ? null
      : strictTimelineIdentity(mismatch.observed_timeline_identity, "observed timeline identity");
    if (result.status !== 1 || mismatch.version !== "premiere-preflight-revision/v1"
      || mismatch.project_id !== expectedProjectId || mismatch.status !== "timeline_revision_mismatch"
      || mismatch.expected_timeline_sha256 !== expectedTimelineSha256
      || mismatch.observed_timeline_sha256 !== null && (typeof mismatch.observed_timeline_sha256 !== "string" || !SHA256.test(mismatch.observed_timeline_sha256))
      || !samePremiereTimelineIdentity(mismatchExpectedIdentity, expectedTimelineIdentity)
      || mismatch.hardware_verified !== false || !Array.isArray(mismatch.items) || mismatch.items.length !== 0
      || mismatch.observed_timeline_identity !== null && observedIdentity === null) {
      fail("preflight_contract_error", "timeline revision mismatch contract is invalid");
    }
    fail("timeline_revision_changed", "preflight child used a different timeline revision");
  }
  const root = exactObject(parsed, [
    "mode", "project_id", "hardware_verified", "clips", "child_used_timeline_sha256", "child_used_timeline_identity",
  ], [
    "mode", "project_id", "hardware_verified", "clips", "child_used_timeline_sha256", "child_used_timeline_identity",
  ], "preflight");
  if (root.mode !== "preflight" || root.project_id !== expectedProjectId || root.hardware_verified !== false || !Array.isArray(root.clips)) {
    fail("preflight_contract_error", "preflight root contract mismatch");
  }
  if (typeof root.child_used_timeline_sha256 !== "string" || !SHA256.test(root.child_used_timeline_sha256)) {
    fail("preflight_contract_error", "child-used timeline SHA is invalid");
  }
  const childUsedIdentity = strictTimelineIdentity(root.child_used_timeline_identity, "child-used timeline identity");
  if (root.child_used_timeline_sha256 !== expectedTimelineSha256
    || !samePremiereTimelineIdentity(childUsedIdentity, expectedTimelineIdentity)) {
    fail("timeline_revision_changed", "preflight child-used timeline revision differs from outer-before revision");
  }
  const targets = new Set<string>();
  const evaluationOrdinals = new Set<number>(), evaluationShas = new Set<string>(), receiptShas = new Set<string>(), requestShas = new Set<string>();
  let associationRunId: string | null = null;
  const items = root.clips.map((value, index): StrictPreflightItem => {
    const item = exactObject(value, ["clip_id", "track_id", "status", "reason", "request_sha256", "evaluation_association"], ["clip_id", "track_id", "status"], `preflight.clips[${index}]`);
    const clipId = nonempty(item.clip_id, "preflight_contract_error", "clip_id");
    const trackId = nonempty(item.track_id, "preflight_contract_error", "track_id");
    if (typeof item.status !== "string" || !PREFLIGHT_STATUSES.has(item.status as PremiereBakePreflightStatus)) fail("preflight_contract_error", "unknown preflight status");
    const target = `${trackId}\0${clipId}`;
    if (targets.has(target)) fail("duplicate_target", "duplicate visual target");
    targets.add(target);
    let request: string | null = null;
    if (item.request_sha256 !== undefined) {
      if (typeof item.request_sha256 !== "string" || !SHA256.test(item.request_sha256)) fail("preflight_contract_error", "request_sha256 is invalid");
      request = item.request_sha256;
    }
    if (request !== null && item.evaluation_association === undefined) fail("preflight_contract_error", "request-bearing item requires evaluation association");
    if (request === null && item.evaluation_association !== undefined) fail("preflight_contract_error", "association requires request_sha256");
    if (item.evaluation_association !== undefined) {
      const association = exactObject(item.evaluation_association, [
        "version", "preflight_run_id", "evaluation_ordinal", "track_id", "clip_id", "discovery_sha256",
        "ffmpeg_discovery_receipt_sha256", "ffprobe_discovery_receipt_sha256", "evaluation_sha256",
        "source_probe_invocation_receipt", "source_probe_broker_invocation_receipt_sha256",
        "ffmpeg_version_invocation_receipt", "broker_invocation_receipt_sha256", "ffmpeg_version_sha256", "request_sha256",
      ], [
        "version", "preflight_run_id", "evaluation_ordinal", "track_id", "clip_id", "discovery_sha256",
        "ffmpeg_discovery_receipt_sha256", "ffprobe_discovery_receipt_sha256", "evaluation_sha256",
        "source_probe_invocation_receipt", "source_probe_broker_invocation_receipt_sha256",
        "ffmpeg_version_invocation_receipt", "broker_invocation_receipt_sha256", "ffmpeg_version_sha256", "request_sha256",
      ], `preflight.clips[${index}].evaluation_association`);
      if (association.version !== "premiere-effect-bake-evaluation-association/v1"
        || association.track_id !== trackId || association.clip_id !== clipId || association.request_sha256 !== request
        || typeof association.preflight_run_id !== "string" || !association.preflight_run_id
        || typeof association.evaluation_ordinal !== "number" || !Number.isSafeInteger(association.evaluation_ordinal) || association.evaluation_ordinal <= 0
        || [association.discovery_sha256, association.ffmpeg_discovery_receipt_sha256, association.ffprobe_discovery_receipt_sha256,
          association.evaluation_sha256, association.broker_invocation_receipt_sha256, association.ffmpeg_version_sha256]
          .some((hash) => typeof hash !== "string" || !SHA256.test(hash))) {
        fail("preflight_contract_error", "evaluation association is invalid");
      }
      const preflightRunId = association.preflight_run_id as string, evaluationOrdinal = association.evaluation_ordinal as number;
      const evaluationSha = association.evaluation_sha256 as string;
      if (associationRunId !== null && associationRunId !== preflightRunId) fail("preflight_contract_error", "cross-item preflight run relabeling");
      associationRunId = preflightRunId;
      const expectedReceipt = { preflightRunId, evaluationOrdinal, evaluationSha256: evaluationSha, trackId, clipId };
      const sourceReceipt = strictEvaluationReceipt(association.source_probe_invocation_receipt, { ...expectedReceipt, variant: "source_ffprobe", operationOrdinal: 0 }, `preflight.clips[${index}].evaluation_association.source_probe_invocation_receipt`);
      const versionReceipt = strictEvaluationReceipt(association.ffmpeg_version_invocation_receipt, { ...expectedReceipt, variant: "ffmpeg_version", operationOrdinal: 1 }, `preflight.clips[${index}].evaluation_association.ffmpeg_version_invocation_receipt`);
      if (association.source_probe_broker_invocation_receipt_sha256 !== sourceReceipt.sha256
        || association.broker_invocation_receipt_sha256 !== versionReceipt.sha256 || sourceReceipt.childPid === versionReceipt.childPid
        || evaluationOrdinals.has(evaluationOrdinal) || evaluationShas.has(evaluationSha)
        || receiptShas.has(sourceReceipt.sha256) || receiptShas.has(versionReceipt.sha256) || requestShas.has(request!)) {
        fail("preflight_contract_error", "evaluation association is reused or cross-linked");
      }
      evaluationOrdinals.add(evaluationOrdinal); evaluationShas.add(evaluationSha); requestShas.add(request!);
      receiptShas.add(sourceReceipt.sha256); receiptShas.add(versionReceipt.sha256);
    }
    let reason: string | null = null;
    if (item.reason !== undefined) {
      if (typeof item.reason !== "string") fail("preflight_contract_error", "reason must be string when present");
      reason = item.reason;
    }
    return { clip_id: clipId, track_id: trackId, status: item.status as PremiereBakePreflightStatus, reason, request_sha256: request };
  });
  const expectedExit = items.some((item) => HARD_STATUSES.has(item.status))
    ? 1
    : items.some((item) => item.status === "bake_required" || item.status === "stale") ? 2 : 0;
  if (result.status !== expectedExit) fail("preflight_contract_error", `exit ${result.status} does not match status aggregate ${expectedExit}`);
  return items;
}

function textItems(timeline: TimelineIR): PremiereFinishReviewTextItem[] {
  const seen = new Set<string>();
  const items: PremiereFinishReviewTextItem[] = [];
  for (const track of timeline.tracks.overlay ?? []) for (const clip of track.clips) {
    const raw = clip.metadata?.overlay;
    if (clip.role !== "title" || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const overlay = raw as Record<string, unknown>;
    const target = {
      track_id: nonempty(track.track_id, "invalid_projection", "text track_id"),
      clip_id: nonempty(clip.clip_id, "invalid_projection", "text clip_id"),
      overlay_id: nonempty(overlay.overlay_id, "invalid_projection", "overlay_id"),
    };
    const key = [target.track_id, target.clip_id, target.overlay_id].join("\0");
    if (seen.has(key)) fail("duplicate_target", "duplicate text target");
    seen.add(key);
    if (typeof overlay.text !== "string") fail("invalid_projection", "overlay text must be string");
    const styling = nonempty(overlay.styling_class, "invalid_projection", "styling_class");
    if (!Number.isSafeInteger(clip.timeline_in_frame) || clip.timeline_in_frame < 0
      || !Number.isSafeInteger(clip.timeline_duration_frames) || clip.timeline_duration_frames <= 0) {
      fail("invalid_projection", "text timeline range is invalid");
    }
    items.push({
      kind: "text", target,
      source: {
        role: "title", text: overlay.text, styling_class: styling,
        writing_mode: nullableString(overlay.writing_mode, "invalid_projection", "writing_mode"),
        anchor: nullableString(overlay.anchor, "invalid_projection", "anchor"),
        authored_source: nullableString(overlay.source, "invalid_projection", "source"),
        timeline_in_frame: clip.timeline_in_frame,
        timeline_duration_frames: clip.timeline_duration_frames,
      },
      status: "blocked", raw_status: "report_only",
      reason_code: "profile_text_export_blocked",
      action_code: "review_text_then_wait_for_full_handoff",
    });
  }
  return items.sort((a, b) => compareTuple([a.target.track_id, a.target.clip_id, a.target.overlay_id], [b.target.track_id, b.target.clip_id, b.target.overlay_id]));
}

function transitionItems(timeline: TimelineIR, allowedTypes: readonly string[]): PremiereFinishReviewTransitionItem[] {
  const seen = new Set<string>();
  const items = (timeline.transitions ?? []).map((transition): PremiereFinishReviewTransitionItem => {
    const target = {
      transition_id: nonempty(transition.transition_id, "invalid_projection", "transition_id"),
      track_id: nonempty(transition.track_id, "invalid_projection", "transition track_id"),
      from_clip_id: nonempty(transition.from_clip_id, "invalid_projection", "from_clip_id"),
      to_clip_id: nonempty(transition.to_clip_id, "invalid_projection", "to_clip_id"),
    };
    const key = [target.track_id, target.transition_id, target.from_clip_id, target.to_clip_id].join("\0");
    if (seen.has(key)) fail("duplicate_target", "duplicate transition target");
    seen.add(key);
    const allowed = allowedTypes.includes(nonempty(transition.transition_type, "invalid_projection", "transition_type"));
    const nullableFinite = (value: number | undefined, label: string): number | null => {
      if (value === undefined) return null;
      if (!Number.isFinite(value)) fail("invalid_projection", `${label} must be finite`);
      return value;
    };
    return {
      kind: "transition", target,
      source: {
        transition_type: transition.transition_type,
        transition_frames: transition.transition_frames ?? null,
        applied_skill_id: transition.applied_skill_id ?? null,
        degraded_from_skill_id: transition.degraded_from_skill_id ?? null,
        confidence: nullableFinite(transition.confidence, "confidence"),
      },
      status: allowed ? "report_only" : "unsupported",
      raw_status: allowed ? "allowed_type_report_only" : "type_not_allowed",
      reason_code: allowed ? "profile_transition_report_only" : "transition_type_not_allowed",
      action_code: allowed ? "review_transition_then_wait_for_full_handoff" : "change_or_remove_transition",
    };
  });
  return items.sort((a, b) => compareTuple([a.target.track_id, a.target.transition_id, a.target.from_clip_id, a.target.to_clip_id], [b.target.track_id, b.target.transition_id, b.target.from_clip_id, b.target.to_clip_id]));
}

function audioPolicy(clip: ClipOutput): AudioPolicyProjection {
  const policy = clip.audio_policy;
  const number = (key: keyof NonNullable<ClipOutput["audio_policy"]>): number | null => {
    const value = policy?.[key];
    return typeof value === "number" ? value : null;
  };
  return {
    mode: policy?.mode ?? null,
    gain_unit: policy?.gain_unit ?? null,
    duck_music_db: number("duck_music_db"), nat_gain: number("nat_gain"),
    nat_sound_gain: number("nat_sound_gain"), bgm_gain: number("bgm_gain"),
    a1_loudnorm: policy?.a1_loudnorm ?? null,
    preserve_nat_sound: policy?.preserve_nat_sound ?? null,
    fade_in_frames: number("fade_in_frames"), fade_out_frames: number("fade_out_frames"),
    nat_sound_fade_in_frames: number("nat_sound_fade_in_frames"),
    nat_sound_fade_out_frames: number("nat_sound_fade_out_frames"),
    bgm_fade_in_frames: number("bgm_fade_in_frames"),
    bgm_fade_out_frames: number("bgm_fade_out_frames"),
  };
}

function audioItems(timeline: TimelineIR): PremiereFinishReviewAudioItem[] {
  const seen = new Set<string>();
  const items: PremiereFinishReviewAudioItem[] = [];
  for (const track of timeline.tracks.audio) for (const clip of track.clips) {
    if (!resolveFcp7AudioLevelsEmissionDecision(clip, timeline.audio_mix)) continue;
    const target = { track_id: nonempty(track.track_id, "invalid_projection", "audio track_id"), clip_id: nonempty(clip.clip_id, "invalid_projection", "audio clip_id"), effect_id: "audiolevels" as const };
    const key = [target.track_id, target.clip_id, target.effect_id].join("\0");
    if (seen.has(key)) fail("duplicate_target", "duplicate audio target");
    seen.add(key);
    items.push({
      kind: "audio", target, source: { audio_policy: audioPolicy(clip) },
      status: "provisional_roundtrip", raw_status: "provisional_roundtrip",
      reason_code: "profile_audiolevels_provisional",
      action_code: "review_audio_levels_then_wait_for_full_handoff",
    });
  }
  return items.sort((a, b) => compareTuple([a.target.track_id, a.target.clip_id, a.target.effect_id], [b.target.track_id, b.target.clip_id, b.target.effect_id]));
}

const VISUAL_MAPPING = {
  native: ["native", "none"],
  bake_required: ["bake_required", "consent_required_but_execution_blocked"],
  reusable: ["ready", "reuse_available_but_execution_blocked"],
  stale: ["stale", "rebake_required_but_execution_blocked"],
  busy: ["busy", "retry_after_busy"],
  conflict: ["conflict", "resolve_conflict"],
  source_unverified: ["source_unverified", "verify_source"],
  rights_privacy_blocked: ["rights_privacy_blocked", "resolve_rights_privacy"],
  unsupported: ["unsupported", "remove_or_replace_effect"],
} as const;

function effectIds(classification: PremiereTreatmentClassification): string[] | null {
  if (classification.status === "native") return [];
  if (classification.status === "blocked") return null;
  const treatment = classification.treatment;
  const present = new Set<string>();
  if (treatment.transform.zoom !== 1) present.add("transform.zoom");
  if (treatment.transform.crop !== null) present.add("transform.crop");
  if (treatment.transform.position !== null && (treatment.transform.position.x !== 0 || treatment.transform.position.y !== 0)) present.add("transform.position");
  for (const effect of treatment.effects) present.add(`effect.${effect.type}`);
  return ["transform.zoom", "transform.crop", "transform.position", "effect.eq", "effect.brightness", "effect.contrast", "effect.saturation"].filter((id) => present.has(id));
}

function visualItems(timeline: TimelineIR, preflight: StrictPreflightItem[]): PremiereFinishReviewVisualItem[] {
  const classifications = classifyPremiereVideoTreatments(timeline);
  const byTarget = new Map<string, PremiereTreatmentClassification>();
  for (const classification of classifications) {
    const key = `${classification.track_id}\0${classification.clip_id}`;
    if (byTarget.has(key)) fail("duplicate_target", "duplicate classifier target");
    byTarget.set(key, classification);
  }
  if (byTarget.size !== preflight.length) fail("preflight_contract_error", "preflight/classifier cardinality mismatch");
  const items = preflight.map((item): PremiereFinishReviewVisualItem => {
    const key = `${item.track_id}\0${item.clip_id}`;
    const classification = byTarget.get(key);
    if (!classification) fail("preflight_contract_error", "preflight target is not in pinned timeline");
    byTarget.delete(key);
    if (classification.status === "native" && item.status !== "native") fail("preflight_contract_error", "native classifier status mismatch");
    if (classification.status === "blocked" && item.status !== "unsupported") fail("preflight_contract_error", "blocked classifier status mismatch");
    if (classification.status === "bake_required" && item.status === "native") fail("preflight_contract_error", "treated classifier status mismatch");
    const [status, action] = VISUAL_MAPPING[item.status];
    return {
      kind: "visual_effect",
      target: { track_id: item.track_id, clip_id: item.clip_id, effect_ids: effectIds(classification) },
      status, raw_status: item.status, reason: item.reason, action_code: action,
      request_sha256: item.request_sha256,
    };
  });
  if (byTarget.size !== 0) fail("preflight_contract_error", "pinned timeline target missing from preflight");
  return items.sort((a, b) => compareTuple([a.target.track_id, a.target.clip_id], [b.target.track_id, b.target.clip_id]));
}

export function projectPremiereFinishReview(
  projectPath: string,
  options: PremiereFinishReviewOptions = {},
): PremiereFinishReviewProjection {
  const repoRoot = findRepoRoot(options.repoRoot);
  const project = canonicalDirectory(projectPath);
  const timelinePath = path.join(project, "05_timeline", "timeline.json");
  const validate = validators(repoRoot);
  const profile = loadProfile(repoRoot, validate.profile);
  const pinned = readPinnedTimeline(timelinePath, validate.timeline);
  const projectId = nonempty(pinned.timeline.project_id, "invalid_projection", "project_id");
  const expectedTimelineIdentity = wireIdentity(pinned.identity);

  const tsx = localExecutable(repoRoot, "node_modules/.bin/tsx");
  const exportScript = path.join(repoRoot, "scripts", "export-premiere-xml.ts");
  const scriptStat = lstatSync(exportScript);
  if (!scriptStat.isFile() || scriptStat.isSymbolicLink() || scriptStat.nlink !== 1) fail("tool_unavailable", "preflight script is not regular nlink=1");
  const invocation: PremierePreflightInvocation = {
    executable: tsx,
    args: [
      exportScript, project, "--preflight", "--json",
      "--expected-timeline-sha256", pinned.sha256,
      "--expected-timeline-identity-json", encodePremiereTimelineIdentity(expectedTimelineIdentity),
    ],
    cwd: repoRoot,
  };
  const child = (options.preflightRunner ?? defaultPreflightRunner)(invocation);
  const preflight = strictPreflight(child, projectId, pinned.sha256, expectedTimelineIdentity);
  options.beforeSecondTimelineRead?.();
  const after = currentTimelineIdentity(timelinePath);
  if (!sameIdentity(pinned.identity, after.identity) || pinned.sha256 !== after.sha256) {
    fail("timeline_revision_changed", "timeline identity or SHA changed during preflight");
  }

  const surfaces: PremiereFinishReviewSurface[] = [
    ...textItems(pinned.timeline),
    ...transitionItems(pinned.timeline, profile.surfaces.simple_transition.allowed_types ?? []),
    ...audioItems(pinned.timeline),
    ...visualItems(pinned.timeline, preflight),
  ];
  return {
    version: REVIEW_VERSION,
    project_id: projectId,
    profile_id: PROFILE_ID,
    base_timeline_sha256: pinned.sha256,
    hardware_verified: false,
    surfaces,
  };
}
