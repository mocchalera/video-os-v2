import { createHash } from "node:crypto";
import * as path from "node:path";
import type { DiscoveredSourceRequest, SourceDiscoveryResult } from "./source-discovery.js";

export const IMAGE_SEQUENCE_GROUPING_PRODUCER = "image-sequence-grouper" as const;
export const IMAGE_SEQUENCE_GROUPING_PRODUCER_VERSION = "1" as const;

export interface ImageSequencePolicy {
  fps_num: number;
  fps_den: number;
  minimum_frame_count: number;
}

export interface ImageSequenceFrame {
  frame_number: number;
  source_id: string;
  canonical_path: string;
  content_sha256: string;
  size_bytes: number;
  mtime_ms: number;
}

export interface ImageSequenceGroup {
  group_id: string;
  grouping_producer: typeof IMAGE_SEQUENCE_GROUPING_PRODUCER;
  grouping_producer_version: typeof IMAGE_SEQUENCE_GROUPING_PRODUCER_VERSION;
  grouping_root: string;
  directory_path: string;
  filename_prefix: string;
  extension: string;
  padding: number;
  pattern_basename: string;
  pattern_path: string;
  start_number: number;
  end_number: number;
  frame_count: number;
  fps_num: number;
  fps_den: number;
  duration_us: number;
  frame_set_content_sha256: string;
  frames: ImageSequenceFrame[];
  status: "candidate" | "failed";
  reason: string | null;
}

export interface ImageSequenceGroupingResult {
  groups: ImageSequenceGroup[];
  member_group_by_canonical_path: Map<string, ImageSequenceGroup>;
}

interface ParsedFrameName {
  prefix: string;
  digits: string;
  extension: string;
}

const DEFAULT_POLICY: ImageSequencePolicy = {
  fps_num: 24,
  fps_den: 1,
  minimum_frame_count: 2,
};
const IMAGE_SEQUENCE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

export function resolveImageSequencePolicy(policy: Record<string, unknown>): ImageSequencePolicy {
  const configured = record(policy.image_sequence);
  const frameRate = record(configured?.frame_rate);
  const normalizedFrameRate = normalizeRational(
    positiveInteger(frameRate?.fps_num, DEFAULT_POLICY.fps_num),
    positiveInteger(frameRate?.fps_den, DEFAULT_POLICY.fps_den),
  );
  return {
    fps_num: normalizedFrameRate.num,
    fps_den: normalizedFrameRate.den,
    minimum_frame_count: Math.max(2, positiveInteger(configured?.minimum_frame_count, DEFAULT_POLICY.minimum_frame_count)),
  };
}

export function groupImageSequenceRequests(
  discovery: SourceDiscoveryResult,
  policy: ImageSequencePolicy,
): ImageSequenceGroupingResult {
  const buckets = new Map<string, Map<string, { request: DiscoveredSourceRequest; parsed: ParsedFrameName }>>();
  for (const request of discovery.requests) {
    if (
      request.disposition !== "candidate" ||
      request.media_kind !== "image" ||
      !request.canonical_path ||
      !request.content_hash?.startsWith("sha256:") ||
      request.size_bytes === null ||
      request.mtime_ms === null ||
      !request.sequence_grouping_root
    ) continue;
    const parsed = parseFrameName(path.basename(request.canonical_path));
    if (!parsed || !IMAGE_SEQUENCE_EXTENSIONS.has(parsed.extension.toLowerCase())) continue;
    const key = JSON.stringify([
      path.dirname(request.canonical_path).normalize("NFC"),
      parsed.prefix.normalize("NFC"),
      parsed.digits.length,
      parsed.extension.normalize("NFC"),
      path.resolve(request.sequence_grouping_root),
    ]);
    const bucket = buckets.get(key) ?? new Map<string, { request: DiscoveredSourceRequest; parsed: ParsedFrameName }>();
    const canonicalPath = path.resolve(request.canonical_path);
    // Discovery keeps every requested alias for the source ledger, while a
    // logical sequence may contain each physical frame only once.
    if (!bucket.has(canonicalPath)) bucket.set(canonicalPath, { request, parsed });
    buckets.set(key, bucket);
  }

  const groups: ImageSequenceGroup[] = [];
  const memberGroupByCanonicalPath = new Map<string, ImageSequenceGroup>();
  for (const bucket of buckets.values()) {
    if (bucket.size < policy.minimum_frame_count) continue;
    const sorted = [...bucket.values()].sort((a, b) =>
      Number(a.parsed.digits) - Number(b.parsed.digits) ||
      binaryCompare(a.request.canonical_path!, b.request.canonical_path!)
    );
    const first = sorted[0];
    const frames: ImageSequenceFrame[] = sorted.map(({ request, parsed }) => ({
      frame_number: Number(parsed.digits),
      source_id: request.source_id,
      canonical_path: request.canonical_path!,
      content_sha256: request.content_hash!.slice("sha256:".length),
      size_bytes: request.size_bytes!,
      mtime_ms: request.mtime_ms!,
    }));
    const startNumber = frames[0].frame_number;
    const endNumber = frames[frames.length - 1].frame_number;
    const missing = missingFrameNumbers(frames);
    const duplicate = duplicateFrameNumbers(frames);
    const frameSetContentSha256 = computeImageSequenceFrameSetContentSha256(frames);
    const identity = hashNormalized({
      identity_version: "image-sequence-group-v1",
      frame_set_content_sha256: frameSetContentSha256,
      fps_num: policy.fps_num,
      fps_den: policy.fps_den,
      prefix: first.parsed.prefix.normalize("NFC"),
      extension: first.parsed.extension.toLowerCase(),
      padding: first.parsed.digits.length,
      directory_path: path.dirname(first.request.canonical_path!).normalize("NFC"),
    });
    const patternBasename = `${first.parsed.prefix}%0${first.parsed.digits.length}d${first.parsed.extension}`;
    const reason = first.parsed.prefix.includes("%")
      ? "image_sequence_pattern_contains_percent"
      : duplicate.length > 0
        ? `image_sequence_duplicate_frame_numbers:${duplicate.join(",")}`
        : missing.length > 0
          ? `image_sequence_missing_frames:${missing.join(",")}`
          : null;
    const group: ImageSequenceGroup = {
      group_id: `SEQ_${identity.slice(0, 16).toUpperCase()}`,
      grouping_producer: IMAGE_SEQUENCE_GROUPING_PRODUCER,
      grouping_producer_version: IMAGE_SEQUENCE_GROUPING_PRODUCER_VERSION,
      grouping_root: path.resolve(first.request.sequence_grouping_root!),
      directory_path: path.dirname(first.request.canonical_path!),
      filename_prefix: first.parsed.prefix,
      extension: first.parsed.extension.toLowerCase(),
      padding: first.parsed.digits.length,
      pattern_basename: patternBasename,
      pattern_path: path.join(path.dirname(first.request.canonical_path!), patternBasename),
      start_number: startNumber,
      end_number: endNumber,
      frame_count: frames.length,
      fps_num: policy.fps_num,
      fps_den: policy.fps_den,
      duration_us: Math.round(frames.length * 1_000_000 * policy.fps_den / policy.fps_num),
      frame_set_content_sha256: frameSetContentSha256,
      frames,
      status: reason ? "failed" : "candidate",
      reason,
    };
    groups.push(group);
    for (const frame of frames) memberGroupByCanonicalPath.set(path.resolve(frame.canonical_path), group);
  }

  groups.sort((a, b) => binaryCompare(a.pattern_path, b.pattern_path));
  const deduplicatedGroups = [...new Map(groups.map((group) => [group.group_id, group])).values()];
  memberGroupByCanonicalPath.clear();
  for (const group of deduplicatedGroups) {
    for (const frame of group.frames) memberGroupByCanonicalPath.set(path.resolve(frame.canonical_path), group);
  }
  return { groups: deduplicatedGroups, member_group_by_canonical_path: memberGroupByCanonicalPath };
}

export function computeImageSequenceFrameSetContentSha256(
  frames: Pick<ImageSequenceFrame, "frame_number" | "content_sha256" | "size_bytes">[],
): string {
  return hashNormalized({
    identity_version: "image-sequence-frame-set-v1",
    frames: frames.map((frame) => ({
      frame_number: frame.frame_number,
      content_sha256: frame.content_sha256,
      size_bytes: frame.size_bytes,
    })),
  });
}

function parseFrameName(filename: string): ParsedFrameName | null {
  const extension = path.extname(filename);
  const stem = filename.slice(0, -extension.length);
  const match = /^(.*?)(\d+)$/u.exec(stem);
  if (!match || !extension || !Number.isSafeInteger(Number(match[2]))) return null;
  return { prefix: match[1], digits: match[2], extension };
}

function missingFrameNumbers(frames: ImageSequenceFrame[]): number[] {
  const missing: number[] = [];
  const ordered = [...new Set(frames.map((frame) => frame.frame_number))].sort((a, b) => a - b);
  for (let index = 1; index < ordered.length && missing.length < 100; index++) {
    const firstMissing = ordered[index - 1] + 1;
    const lastMissing = Math.min(ordered[index] - 1, firstMissing + (99 - missing.length));
    for (let frame = firstMissing; frame <= lastMissing; frame++) missing.push(frame);
  }
  return missing;
}

function duplicateFrameNumbers(frames: ImageSequenceFrame[]): number[] {
  const counts = new Map<number, number>();
  for (const frame of frames) counts.set(frame.frame_number, (counts.get(frame.frame_number) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([frame]) => frame).sort((a, b) => a - b);
}

function hashNormalized(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeRational(num: number, den: number): { num: number; den: number } {
  let a = num;
  let b = den;
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return { num: num / a, den: den / a };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function binaryCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
