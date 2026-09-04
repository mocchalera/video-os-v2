import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateAgainstSchema } from "../commands/shared.js";
import type { TimelineIR } from "../compiler/types.js";
import { fcp7ClipItemId, fcp7TextGeneratorItemId } from "./fcp7-xml-export.js";
import { classifyPremiereVideoTreatments, canonicalJson, validatePremiereBakeArtifactGraph, type PremiereBakedRepresentation, type PremiereEffectBakeIndex } from "./premiere-effect-bake.js";
import { parseFcp7Sequence, type ParsedFcp7Sequence } from "./fcp7-xml-import.js";
import { validatePremiereExportIdentity } from "./premiere-export-identity.js";

export const PREMIERE_ROUNDTRIP_RECEIPT_VERSION = "premiere-roundtrip-receipt/v1" as const;
export const PREMIERE_ROUNDTRIP_RECEIPT_V2_VERSION = "premiere-roundtrip-receipt/v2" as const;
const SHA = /^sha256:[0-9a-f]{64}$/;

export interface PremiereTextOverlayManifestEntry {
  xml_generator_id: string; clip_id: string; overlay_id: string; text: string;
  start_frame: number; end_frame: number; duration_frames: number; font_size: number;
  color: [number, number, number]; alpha: number; origin: [number, number];
}

export interface PremiereRoundtripReceiptV1 {
  version: typeof PREMIERE_ROUNDTRIP_RECEIPT_VERSION;
  project_id: string; roundtrip_id: string; base_timeline_sha256: string;
  exported_xml_filename: string; exported_xml_sha256: string;
  text_overlay_manifest?: PremiereTextOverlayManifestEntry[];
}

export interface PremiereBakedClipMap {
  clip_id: string; xml_clipitem_id: string; timeline_track_id: string;
  canonical_asset_id: string; derived_asset_id: string; bake_request_id: string;
  manifest_path: string; manifest_sha256: string; media_path: string; media_sha256: string;
  media_video_stream_sha256: string; timeline_duration_frames: number; xml_in_frame: 0;
  xml_out_frame: number; fps_num: number; fps_den: number; source_in_us: number;
  source_out_us: number; source_time_den: number; source_out_residual_num: number;
}

export interface PremiereRoundtripReceiptV2 {
  version: typeof PREMIERE_ROUNDTRIP_RECEIPT_V2_VERSION;
  project_id: string; roundtrip_id: string; export_generation_id: string;
  base_timeline_sha256: string;
  readonly exported_xml_filename?: never;
  readonly exported_xml_sha256?: never;
  exported_xml: { path: string; sha256: string };
  bake_index: { path: string; sha256: string };
  baked_clip_maps: PremiereBakedClipMap[];
  text_overlay_manifest?: PremiereTextOverlayManifestEntry[];
}

export type PremiereRoundtripReceipt = PremiereRoundtripReceiptV1 | PremiereRoundtripReceiptV2;
export interface PremiereRoundtripValidation { provided: true; valid: boolean; error?: string }

export function sha256Prefixed(raw: string | Buffer): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export function derivePremiereRoundtripId(projectId: string, baseTimelineSha256: string): string {
  return sha256Prefixed(`premiere-roundtrip/v1\n${projectId}\n${baseTimelineSha256}`);
}

export function derivePremiereRoundtripIdV2(projectId: string, baseTimelineSha256: string, bakeIndexSha256: string, maps: readonly PremiereBakedClipMap[]): string {
  const identity = sha256Prefixed(canonicalJson([...maps].sort(mapOrder)));
  return sha256Prefixed(Buffer.concat([Buffer.from("premiere-roundtrip/v2\0"), Buffer.from(canonicalJson({ project_id: projectId, base_timeline_sha256: baseTimelineSha256, bake_index_sha256: bakeIndexSha256, maps_identity_sha256: identity }))]));
}

export function derivePremiereExportGenerationId(projectId: string, baseTimelineSha256: string, roundtripId: string, xmlSha256: string, bakeIndexSha256: string): string {
  return sha256Prefixed(Buffer.concat([Buffer.from("premiere-export-generation/v1\0"), Buffer.from(canonicalJson({ project_id: projectId, base_timeline_sha256: baseTimelineSha256, roundtrip_id: roundtripId, exported_xml_sha256: xmlSha256, bake_index_sha256: bakeIndexSha256 }))]));
}

function textManifestFromXml(rawXml: Buffer): PremiereTextOverlayManifestEntry[] {
  const xml = rawXml.toString("utf8");
  if (!xml.includes("<generatoritem")) return [];
  return parseFcp7Sequence(xml).textOverlayGenerators.filter((item) => item.status === "exact").map((item) => ({
    xml_generator_id: item.xmlGeneratorId, clip_id: item.clipId!, overlay_id: item.overlayId!, text: item.text!,
    start_frame: item.startFrame!, end_frame: item.endFrame!, duration_frames: item.durationFrames!, font_size: item.fontSize!, color: item.color!, alpha: item.alpha!, origin: item.origin!,
  }));
}

export function createPremiereRoundtripReceipt(projectId: string, rawTimeline: Buffer, exportedXmlFilename: string, rawExportedXml: Buffer): PremiereRoundtripReceiptV1 {
  const base = sha256Prefixed(rawTimeline), manifest = textManifestFromXml(rawExportedXml);
  return { version: PREMIERE_ROUNDTRIP_RECEIPT_VERSION, project_id: projectId, roundtrip_id: derivePremiereRoundtripId(projectId, base), base_timeline_sha256: base, exported_xml_filename: exportedXmlFilename, exported_xml_sha256: sha256Prefixed(rawExportedXml), ...(manifest.length ? { text_overlay_manifest: manifest } : {}) };
}

export function createBakedClipMaps(timeline: TimelineIR, representations: Map<string, PremiereBakedRepresentation>): PremiereBakedClipMap[] {
  const maps: PremiereBakedClipMap[] = [];
  for (const track of timeline.tracks.video) for (const clip of track.clips) {
    const baked = representations.get(clip.clip_id); if (!baked) continue;
    const fpsNum = timeline.sequence.fps_num, fpsDen = timeline.sequence.fps_den || 1;
    const residual = BigInt(clip.src_out_us) * BigInt(fpsNum) - (BigInt(clip.src_in_us) * BigInt(fpsNum) + BigInt(clip.timeline_duration_frames) * 1_000_000n * BigInt(fpsDen));
    const value = Number(residual); if (!Number.isSafeInteger(value)) throw new Error("source_out_residual_num is not safe integer");
    maps.push({ clip_id: clip.clip_id, xml_clipitem_id: fcp7ClipItemId("cv", clip.clip_id), timeline_track_id: track.track_id, canonical_asset_id: clip.asset_id, derived_asset_id: baked.derived_asset_id, bake_request_id: baked.bake_request_id, manifest_path: baked.manifest_path, manifest_sha256: baked.manifest_sha256, media_path: baked.media_path, media_sha256: baked.media_sha256, media_video_stream_sha256: baked.media_video_stream_sha256, timeline_duration_frames: clip.timeline_duration_frames, xml_in_frame: 0, xml_out_frame: clip.timeline_duration_frames, fps_num: fpsNum, fps_den: fpsDen, source_in_us: clip.src_in_us, source_out_us: clip.src_out_us, source_time_den: fpsNum, source_out_residual_num: value });
  }
  return maps.sort(mapOrder);
}

export function createPremiereRoundtripReceiptV2(args: { projectId: string; rawTimeline: Buffer; rawExportedXml: Buffer; exportedXmlPath: string; bakeIndex: PremiereEffectBakeIndex; bakeIndexPath: string; bakedClipMaps: PremiereBakedClipMap[] }): PremiereRoundtripReceiptV2 {
  const base = sha256Prefixed(args.rawTimeline), xmlSha = sha256Prefixed(args.rawExportedXml), indexRaw = Buffer.from(`${JSON.stringify(args.bakeIndex, null, 2)}\n`), indexSha = sha256Prefixed(indexRaw);
  const roundtrip = derivePremiereRoundtripIdV2(args.projectId, base, indexSha, args.bakedClipMaps);
  const generation = derivePremiereExportGenerationId(args.projectId, base, roundtrip, xmlSha, indexSha);
  const text = textManifestFromXml(args.rawExportedXml);
  return { version: PREMIERE_ROUNDTRIP_RECEIPT_V2_VERSION, project_id: args.projectId, roundtrip_id: roundtrip, export_generation_id: generation, base_timeline_sha256: base, exported_xml: { path: args.exportedXmlPath, sha256: xmlSha }, bake_index: { path: args.bakeIndexPath, sha256: indexSha }, baked_clip_maps: [...args.bakedClipMaps].sort(mapOrder), ...(text.length ? { text_overlay_manifest: text } : {}) };
}

function mapOrder(a: PremiereBakedClipMap, b: PremiereBakedClipMap): number { return Buffer.from(a.clip_id).compare(Buffer.from(b.clip_id)) || Buffer.from(a.xml_clipitem_id).compare(Buffer.from(b.xml_clipitem_id)); }
function exact(record: Record<string, unknown>, fields: readonly string[], label: string): void { if (Object.keys(record).sort().join("|") !== [...fields].sort().join("|")) throw new Error(`${label} fields are not exact`); }
function nonempty(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !value) throw new Error(`${label} must be non-empty string`); }
function hash(value: unknown, label: string): asserts value is string { nonempty(value, label); if (!SHA.test(value)) throw new Error(`${label} must be sha256`); }
function safeInteger(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be safe integer`); return value; }

function parseTextManifest(value: unknown): PremiereTextOverlayManifestEntry[] {
  if (!Array.isArray(value)) throw new Error("receipt text_overlay_manifest must be an array");
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`receipt text_overlay_manifest[${index}] must be object`);
    const entry = raw as Record<string, unknown>;
    exact(entry, ["xml_generator_id", "clip_id", "overlay_id", "text", "start_frame", "end_frame", "duration_frames", "font_size", "color", "alpha", "origin"], `receipt text_overlay_manifest[${index}]`);
    for (const key of ["xml_generator_id", "clip_id", "overlay_id"] as const) nonempty(entry[key], key);
    if (typeof entry.text !== "string") throw new Error("receipt overlay text must be string");
    for (const key of ["start_frame", "end_frame", "duration_frames", "font_size", "alpha"] as const) if (!Number.isSafeInteger(entry[key])) throw new Error(`receipt overlay ${key} invalid`);
    if (!Array.isArray(entry.color) || entry.color.length !== 3 || entry.color.some((v) => !Number.isSafeInteger(v))) throw new Error("receipt overlay color invalid");
    if (!Array.isArray(entry.origin) || entry.origin.length !== 2 || entry.origin.some((v) => typeof v !== "number" || !Number.isFinite(v))) throw new Error("receipt overlay origin invalid");
    const id = `${entry.clip_id}\0${entry.overlay_id}`; if (ids.has(id)) throw new Error("receipt text_overlay_manifest contains duplicate identity"); ids.add(id);
    return entry as unknown as PremiereTextOverlayManifestEntry;
  });
}

function parseMap(raw: unknown, index: number): PremiereBakedClipMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`baked_clip_maps[${index}] must be object`);
  const map = raw as Record<string, unknown>;
  const fields = ["clip_id", "xml_clipitem_id", "timeline_track_id", "canonical_asset_id", "derived_asset_id", "bake_request_id", "manifest_path", "manifest_sha256", "media_path", "media_sha256", "media_video_stream_sha256", "timeline_duration_frames", "xml_in_frame", "xml_out_frame", "fps_num", "fps_den", "source_in_us", "source_out_us", "source_time_den", "source_out_residual_num"];
  exact(map, fields, `baked_clip_maps[${index}]`);
  for (const key of ["clip_id", "xml_clipitem_id", "timeline_track_id", "canonical_asset_id", "derived_asset_id", "manifest_path", "media_path"] as const) nonempty(map[key], key);
  for (const key of ["bake_request_id", "manifest_sha256", "media_sha256", "media_video_stream_sha256"] as const) hash(map[key], key);
  const timelineDurationFrames = safeInteger(map.timeline_duration_frames, "timeline_duration_frames");
  const xmlInFrame = safeInteger(map.xml_in_frame, "xml_in_frame");
  const xmlOutFrame = safeInteger(map.xml_out_frame, "xml_out_frame");
  const fpsNum = safeInteger(map.fps_num, "fps_num");
  const fpsDen = safeInteger(map.fps_den, "fps_den");
  const sourceInUs = safeInteger(map.source_in_us, "source_in_us");
  const sourceOutUs = safeInteger(map.source_out_us, "source_out_us");
  const sourceTimeDen = safeInteger(map.source_time_den, "source_time_den");
  const sourceOutResidualNum = safeInteger(map.source_out_residual_num, "source_out_residual_num");
  if (timelineDurationFrames <= 0 || xmlInFrame !== 0 || xmlOutFrame !== timelineDurationFrames || fpsNum <= 0 || fpsDen <= 0 || sourceTimeDen !== fpsNum) throw new Error("baked clip rational fields invalid");
  for (const key of ["manifest_path", "media_path"] as const) if (unsafePath(map[key] as string)) throw new Error(`${key} is unsafe`);
  const residual = BigInt(sourceOutUs) * BigInt(fpsNum) - (BigInt(sourceInUs) * BigInt(fpsNum) + BigInt(timelineDurationFrames) * 1_000_000n * BigInt(fpsDen));
  if (residual !== BigInt(sourceOutResidualNum)) throw new Error("baked clip source_out_residual_num reconstruction mismatch");
  return map as unknown as PremiereBakedClipMap;
}

function unsafePath(value: string): boolean { try { const decoded = decodeURIComponent(value); return !value || value.includes("\0") || path.isAbsolute(value) || decoded.split(/[\\/]/).includes(".."); } catch { return true; } }

export function parsePremiereRoundtripReceipt(raw: string): PremiereRoundtripReceipt {
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error("receipt is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("receipt must be a JSON object");
  const record = value as Record<string, unknown>; nonempty(record.version, "receipt version");
  if (record.version === PREMIERE_ROUNDTRIP_RECEIPT_VERSION) {
    exact(record, [...["version", "project_id", "roundtrip_id", "base_timeline_sha256", "exported_xml_filename", "exported_xml_sha256"], ...(Object.hasOwn(record, "text_overlay_manifest") ? ["text_overlay_manifest"] : [])], "receipt");
    for (const key of ["project_id", "roundtrip_id", "base_timeline_sha256", "exported_xml_filename", "exported_xml_sha256"] as const) nonempty(record[key], key);
    for (const key of ["roundtrip_id", "base_timeline_sha256", "exported_xml_sha256"] as const) hash(record[key], key);
    if (unsafePath(record.exported_xml_filename as string) || /[/\\]/.test(record.exported_xml_filename as string)) throw new Error("exported_xml_filename must be a filename");
    if (Object.hasOwn(record, "text_overlay_manifest")) record.text_overlay_manifest = parseTextManifest(record.text_overlay_manifest);
    const receipt = record as unknown as PremiereRoundtripReceiptV1;
    if (receipt.roundtrip_id !== derivePremiereRoundtripId(receipt.project_id, receipt.base_timeline_sha256)) throw new Error("receipt roundtrip_id does not match project and base");
    return receipt;
  }
  if (record.version === PREMIERE_ROUNDTRIP_RECEIPT_V2_VERSION) {
    exact(record, [...["version", "project_id", "roundtrip_id", "export_generation_id", "base_timeline_sha256", "exported_xml", "bake_index", "baked_clip_maps"], ...(Object.hasOwn(record, "text_overlay_manifest") ? ["text_overlay_manifest"] : [])], "receipt");
    nonempty(record.project_id, "project_id"); for (const key of ["roundtrip_id", "export_generation_id", "base_timeline_sha256"] as const) hash(record[key], key);
    for (const key of ["exported_xml", "bake_index"] as const) { if (!record[key] || typeof record[key] !== "object" || Array.isArray(record[key])) throw new Error(`${key} invalid`); const ref = record[key] as Record<string, unknown>; exact(ref, ["path", "sha256"], key); nonempty(ref.path, `${key}.path`); hash(ref.sha256, `${key}.sha256`); if (unsafePath(ref.path)) throw new Error(`${key}.path unsafe`); }
    if (!Array.isArray(record.baked_clip_maps)) throw new Error("baked_clip_maps must be array");
    record.baked_clip_maps = record.baked_clip_maps.map(parseMap);
    const maps = record.baked_clip_maps as PremiereBakedClipMap[];
    if (maps.some((map, index) => index > 0 && mapOrder(maps[index - 1], map) >= 0)) throw new Error("baked_clip_maps are not uniquely sorted");
    for (const key of ["clip_id", "xml_clipitem_id", "canonical_asset_id", "derived_asset_id", "bake_request_id", "manifest_path", "manifest_sha256", "media_path", "media_sha256", "media_video_stream_sha256"] as const) { const values = maps.map((map) => map[key]); if (new Set(values).size !== values.length) throw new Error(`duplicate baked map ${key}`); }
    if (Object.hasOwn(record, "text_overlay_manifest")) record.text_overlay_manifest = parseTextManifest(record.text_overlay_manifest);
    const receipt = record as unknown as PremiereRoundtripReceiptV2;
    if (receipt.roundtrip_id !== derivePremiereRoundtripIdV2(receipt.project_id, receipt.base_timeline_sha256, receipt.bake_index.sha256, receipt.baked_clip_maps)) throw new Error("receipt v2 roundtrip_id mismatch");
    return receipt;
  }
  throw new Error("unsupported receipt version");
}

function validateTextManifest(receipt: PremiereRoundtripReceipt, reference: TimelineIR): void {
  const expected = new Set((reference.tracks.overlay ?? []).flatMap((track) => track.clips.map((clip) => `${clip.clip_id}\0${(clip.metadata?.overlay as Record<string, unknown> | undefined)?.overlay_id ?? ""}`)));
  const actual = receipt.text_overlay_manifest ?? [];
  if (actual.length !== expected.size) throw new Error("receipt text_overlay_manifest does not match reference overlays");
  for (const entry of actual) if (!expected.has(`${entry.clip_id}\0${entry.overlay_id}`) || entry.xml_generator_id !== fcp7TextGeneratorItemId(entry.clip_id, entry.overlay_id)) throw new Error("receipt text_overlay_manifest identity mismatch");
}

function validateArtifact(projectPath: string, fixedRoot: string, relative: string, expected: string): string {
  if (unsafePath(relative)) throw new Error("baked_media_unverified: unsafe artifact path");
  const root = fs.realpathSync(projectPath), absolute = path.resolve(root, relative);
  const allowedRoot = path.resolve(root, fixedRoot);
  if (!absolute.startsWith(`${allowedRoot}${path.sep}`)) throw new Error("baked_media_unverified: fixed-root escape");
  let cursor = root;
  for (const component of path.relative(root, absolute).split(path.sep)) { cursor = path.join(cursor, component); if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("baked_media_unverified: artifact path contains symlink"); }
  const stat = fs.lstatSync(absolute); if (!stat.isFile() || stat.nlink !== 1) throw new Error("baked_media_unverified: artifact is not regular nlink=1");
  if (sha256Prefixed(fs.readFileSync(absolute)) !== expected) throw new Error("baked_media_unverified: artifact hash mismatch");
  return absolute;
}

function validateFixedFile(projectPath: string, fixedRoot: string, relative: string): string {
  if (unsafePath(relative)) throw new Error("baked_media_unverified: unsafe artifact path");
  const root = fs.realpathSync(projectPath), absolute = path.resolve(root, relative), allowedRoot = path.resolve(root, fixedRoot);
  if (!absolute.startsWith(`${allowedRoot}${path.sep}`)) throw new Error("baked_media_unverified: fixed-root escape");
  let cursor = root;
  for (const component of path.relative(root, absolute).split(path.sep)) { cursor = path.join(cursor, component); if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("baked_media_unverified: artifact path contains symlink"); }
  const stat = fs.lstatSync(absolute); if (!stat.isFile() || stat.nlink !== 1) throw new Error("baked_media_unverified: artifact is not regular nlink=1");
  return absolute;
}

function parseClosedJson(file: string, fields: readonly string[], label: string, optionalFields: readonly string[] = []): Record<string, unknown> {
  let value: unknown; try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`baked_media_unverified: ${label} malformed`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`baked_media_unverified: ${label} must be object`);
  const record = value as Record<string, unknown>; try { exact(record, [...fields, ...optionalFields].filter((field, index, all) => all.indexOf(field) === index), label); } catch (error) { throw new Error(`baked_media_unverified: ${error instanceof Error ? error.message : String(error)}`); }
  return record;
}

function exactArtifactRef(value: unknown, label: string): { path: string; sha256: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`baked_media_unverified: ${label} invalid`);
  const ref = value as Record<string, unknown>; exact(ref, ["path", "sha256"], label); nonempty(ref.path, `${label}.path`); hash(ref.sha256, `${label}.sha256`);
  if (unsafePath(ref.path)) throw new Error(`baked_media_unverified: ${label}.path unsafe`);
  return { path: ref.path, sha256: ref.sha256 };
}

function exactExportIdentityRef(value: unknown, label: string): { path: string; sha256: string; identity_hash: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`baked_media_unverified: ${label} invalid`);
  const ref = value as Record<string, unknown>;
  exact(ref, ["path", "sha256", "identity_hash"], label);
  nonempty(ref.path, `${label}.path`);
  hash(ref.sha256, `${label}.sha256`);
  hash(ref.identity_hash, `${label}.identity_hash`);
  if (unsafePath(ref.path)) throw new Error(`baked_media_unverified: ${label}.path unsafe`);
  return { path: ref.path, sha256: ref.sha256, identity_hash: ref.identity_hash };
}

function validateExportIdentityChain(
  projectPath: string,
  generationRoot: string,
  identityRef: { path: string; sha256: string; identity_hash: string },
  xmlPath: string,
  expectedProjectId: string,
): void {
  const identityPath = validateArtifact(projectPath, generationRoot, identityRef.path, identityRef.sha256);
  const raw = fs.readFileSync(identityPath, "utf8");
  let identity: unknown;
  try {
    identity = JSON.parse(raw);
  } catch {
    throw new Error("baked_media_unverified: export identity sidecar malformed");
  }
  const schema = validateAgainstSchema(identity, "premiere-export-identity.schema.json");
  if (!schema.valid) throw new Error(`baked_media_unverified: export identity schema invalid: ${schema.errors.join("; ")}`);
  const runtime = validatePremiereExportIdentity(identity);
  if (!runtime.valid) throw new Error(`baked_media_unverified: export identity invalid: ${runtime.errors.join("; ")}`);
  const value = identity as { project_id?: unknown; export_identity_hash?: unknown };
  if (value.project_id !== expectedProjectId || value.export_identity_hash !== identityRef.identity_hash) {
    throw new Error("baked_media_unverified: export identity project/hash mismatch");
  }
  const marker = /<!-- Video OS v2 \| export_identity: (sha256:[0-9a-f]{64}) -->/.exec(fs.readFileSync(xmlPath, "utf8"));
  if (!marker || marker[1] !== identityRef.identity_hash) {
    throw new Error("baked_media_unverified: XML export_identity marker mismatch");
  }
}

function validateClosedIndex(index: Record<string, unknown>, receipt: PremiereRoundtripReceiptV2, expectedProjectId: string): PremiereEffectBakeIndex {
  exact(index, ["version", "project_id", "base_timeline_sha256", "entries"], "bake index");
  if (index.version !== "premiere-effect-bake-index/v1" || index.project_id !== expectedProjectId || index.base_timeline_sha256 !== receipt.base_timeline_sha256 || !Array.isArray(index.entries)) throw new Error("baked_media_unverified: bake index identity invalid");
  const entries = index.entries as Record<string, unknown>[];
  const fields = ["clip_id", "canonical_asset_id", "derived_asset_id", "bake_request_id", "manifest_path", "manifest_sha256", "media_path", "media_sha256", "media_video_stream_sha256"];
  for (const [entryIndex, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("baked_media_unverified: bake index entry invalid");
    exact(entry, fields, `bake index entry ${entryIndex}`);
    for (const key of ["clip_id", "canonical_asset_id", "derived_asset_id", "manifest_path", "media_path"] as const) nonempty(entry[key], key);
    for (const key of ["bake_request_id", "manifest_sha256", "media_sha256", "media_video_stream_sha256"] as const) hash(entry[key], key);
    if (unsafePath(entry.manifest_path as string) || unsafePath(entry.media_path as string)) throw new Error("baked_media_unverified: bake index path unsafe");
    if (entryIndex > 0 && Buffer.from(String(entries[entryIndex - 1].clip_id)).compare(Buffer.from(String(entry.clip_id))) >= 0) throw new Error("baked_media_unverified: bake index is not uniquely sorted");
  }
  for (const key of fields) if (new Set(entries.map((entry) => entry[key])).size !== entries.length) throw new Error(`baked_media_unverified: duplicate bake index ${key}`);
  return index as unknown as PremiereEffectBakeIndex;
}

function validateExportArtifactGraph(projectPath: string, receipt: PremiereRoundtripReceiptV2, expectedProjectId: string): PremiereEffectBakeIndex {
  const exportRoot = "09_output/premiere-exports", generationRoot = `${exportRoot}/generations/${receipt.export_generation_id.slice(7)}`;
  const currentPath = validateFixedFile(projectPath, exportRoot, `${exportRoot}/CURRENT.json`);
  const current = parseClosedJson(currentPath, ["version", "project_id", "base_timeline_sha256", "roundtrip_id", "export_generation_id", "ready_path", "ready_sha256", "xml", "receipt", "bake_index", "published_at"], "CURRENT", ["export_identity"]);
  if (current.version !== "premiere-export-current/v1" || current.project_id !== expectedProjectId || current.base_timeline_sha256 !== receipt.base_timeline_sha256 || current.roundtrip_id !== receipt.roundtrip_id || current.export_generation_id !== receipt.export_generation_id || typeof current.ready_path !== "string" || typeof current.ready_sha256 !== "string" || !SHA.test(current.ready_sha256) || typeof current.published_at !== "string" || !Number.isFinite(Date.parse(current.published_at))) throw new Error("baked_media_unverified: CURRENT identity invalid");
  const expectedReadyPath = `${generationRoot}/READY.json`;
  if (current.ready_path !== expectedReadyPath) throw new Error("baked_media_unverified: CURRENT ready path mismatch");
  const readyPath = validateArtifact(projectPath, exportRoot, current.ready_path, current.ready_sha256);
  const ready = parseClosedJson(readyPath, ["version", "project_id", "base_timeline_sha256", "roundtrip_id", "export_generation_id", "xml", "receipt", "bake_index", "hardware_verified"], "export READY", ["export_identity"]);
  if (ready.version !== "premiere-export-ready/v1" || ready.project_id !== expectedProjectId || ready.base_timeline_sha256 !== receipt.base_timeline_sha256 || ready.roundtrip_id !== receipt.roundtrip_id || ready.export_generation_id !== receipt.export_generation_id || ready.hardware_verified !== false) throw new Error("baked_media_unverified: export READY identity invalid");
  const currentXml = exactArtifactRef(current.xml, "CURRENT.xml"), currentReceipt = exactArtifactRef(current.receipt, "CURRENT.receipt"), currentIndex = exactArtifactRef(current.bake_index, "CURRENT.bake_index");
  const readyXml = exactArtifactRef(ready.xml, "READY.xml"), readyReceipt = exactArtifactRef(ready.receipt, "READY.receipt"), readyIndex = exactArtifactRef(ready.bake_index, "READY.bake_index");
  if (canonicalJson(currentXml) !== canonicalJson(readyXml) || canonicalJson(currentReceipt) !== canonicalJson(readyReceipt) || canonicalJson(currentIndex) !== canonicalJson(readyIndex) || canonicalJson(readyXml) !== canonicalJson(receipt.exported_xml) || canonicalJson(readyIndex) !== canonicalJson(receipt.bake_index)) throw new Error("baked_media_unverified: CURRENT/READY/receipt refs disagree");
  const currentIdentity = current.export_identity == null ? null : exactExportIdentityRef(current.export_identity, "CURRENT.export_identity");
  const readyIdentity = ready.export_identity == null ? null : exactExportIdentityRef(ready.export_identity, "READY.export_identity");
  if (Boolean(currentIdentity) !== Boolean(readyIdentity) || (currentIdentity && readyIdentity && canonicalJson(currentIdentity) !== canonicalJson(readyIdentity))) throw new Error("baked_media_unverified: CURRENT/READY export identity refs disagree");
  const xmlPath = validateArtifact(projectPath, generationRoot, readyXml.path, readyXml.sha256), receiptPath = validateArtifact(projectPath, generationRoot, readyReceipt.path, readyReceipt.sha256), indexPath = validateArtifact(projectPath, generationRoot, readyIndex.path, readyIndex.sha256);
  const expectedIdentityPath = `${generationRoot}/${expectedProjectId}_premiere.export-identity.json`;
  if (readyXml.path !== `${generationRoot}/${expectedProjectId}_premiere.xml` || readyReceipt.path !== `${generationRoot}/${expectedProjectId}_premiere.roundtrip.json` || readyIndex.path !== `${generationRoot}/bake-index.json` || path.dirname(xmlPath) !== path.dirname(readyPath) || path.dirname(receiptPath) !== path.dirname(readyPath) || path.dirname(indexPath) !== path.dirname(readyPath)) throw new Error("baked_media_unverified: export artifacts are not the fixed selected generation files");
  if (currentIdentity && readyIdentity && readyIdentity.path !== expectedIdentityPath) throw new Error("baked_media_unverified: export identity path mismatch");
  if (fs.readdirSync(path.dirname(readyPath)).sort().join("|") !== ["READY.json", "bake-index.json", ...(readyIdentity ? [`${expectedProjectId}_premiere.export-identity.json`] : []), `${expectedProjectId}_premiere.roundtrip.json`, `${expectedProjectId}_premiere.xml`].sort().join("|")) throw new Error("baked_media_unverified: export generation contents are not exact");
  if (readyIdentity) validateExportIdentityChain(projectPath, generationRoot, readyIdentity, xmlPath, expectedProjectId);
  else if (/<!-- Video OS v2 \| export_identity: sha256:[0-9a-f]{64} -->/.test(fs.readFileSync(xmlPath, "utf8"))) {
    throw new Error("baked_media_unverified: XML export identity marker has no sidecar");
  }
  const storedReceipt = parsePremiereRoundtripReceipt(fs.readFileSync(receiptPath, "utf8"));
  if (canonicalJson(storedReceipt) !== canonicalJson(receipt)) throw new Error("baked_media_unverified: selected receipt differs from supplied receipt");
  const index = validateClosedIndex(parseClosedJson(indexPath, ["version", "project_id", "base_timeline_sha256", "entries"], "bake index"), receipt, expectedProjectId);
  return index;
}

function validateLegacyExportIdentityGraph(
  projectPath: string,
  receipt: PremiereRoundtripReceiptV1,
  expectedProjectId: string,
): void {
  const exportRoot = "09_output/premiere-exports";
  const currentPath = path.join(projectPath, exportRoot, "CURRENT.json");
  // Older v1 import callers may provide only a project timeline and a
  // returned XML/receipt. The immutable graph is present only for exports
  // published by the generation-based exporter; preserve that legacy API
  // when no published CURRENT exists.
  if (!fs.existsSync(currentPath)) return;
  const validatedCurrentPath = validateFixedFile(projectPath, exportRoot, `${exportRoot}/CURRENT.json`);
  const current = parseClosedJson(
    validatedCurrentPath,
    ["version", "project_id", "base_timeline_sha256", "roundtrip_id", "export_generation_id", "ready_path", "ready_sha256", "xml", "receipt", "bake_index", "published_at"],
    "CURRENT",
    ["export_identity"],
  );
  if (current.version !== "premiere-export-current/v1"
    || current.project_id !== expectedProjectId
    || current.base_timeline_sha256 !== receipt.base_timeline_sha256
    || current.roundtrip_id !== receipt.roundtrip_id
    || typeof current.export_generation_id !== "string"
    || !SHA.test(current.export_generation_id)
    || typeof current.ready_path !== "string"
    || typeof current.ready_sha256 !== "string"
    || !SHA.test(current.ready_sha256)
    || typeof current.published_at !== "string"
    || !Number.isFinite(Date.parse(current.published_at))) {
    throw new Error("baked_media_unverified: CURRENT identity invalid");
  }
  const generationRoot = `${exportRoot}/generations/${current.export_generation_id.slice(7)}`;
  if (current.ready_path !== `${generationRoot}/READY.json`) throw new Error("baked_media_unverified: CURRENT ready path mismatch");
  const readyPath = validateArtifact(projectPath, exportRoot, current.ready_path, current.ready_sha256);
  const ready = parseClosedJson(
    readyPath,
    ["version", "project_id", "base_timeline_sha256", "roundtrip_id", "export_generation_id", "xml", "receipt", "bake_index", "hardware_verified"],
    "export READY",
    ["export_identity"],
  );
  if (ready.version !== "premiere-export-ready/v1"
    || ready.project_id !== expectedProjectId
    || ready.base_timeline_sha256 !== receipt.base_timeline_sha256
    || ready.roundtrip_id !== receipt.roundtrip_id
    || ready.export_generation_id !== current.export_generation_id
    || ready.hardware_verified !== false) {
    throw new Error("baked_media_unverified: export READY identity invalid");
  }
  const currentXml = exactArtifactRef(current.xml, "CURRENT.xml");
  const currentReceipt = exactArtifactRef(current.receipt, "CURRENT.receipt");
  const currentIndex = exactArtifactRef(current.bake_index, "CURRENT.bake_index");
  const readyXml = exactArtifactRef(ready.xml, "READY.xml");
  const readyReceipt = exactArtifactRef(ready.receipt, "READY.receipt");
  const readyIndex = exactArtifactRef(ready.bake_index, "READY.bake_index");
  if (canonicalJson(currentXml) !== canonicalJson(readyXml)
    || canonicalJson(currentReceipt) !== canonicalJson(readyReceipt)
    || canonicalJson(currentIndex) !== canonicalJson(readyIndex)) {
    throw new Error("baked_media_unverified: CURRENT/READY refs disagree");
  }
  if (readyXml.path !== `${generationRoot}/${expectedProjectId}_premiere.xml`
    || readyReceipt.path !== `${generationRoot}/${expectedProjectId}_premiere.roundtrip.json`
    || readyIndex.path !== `${generationRoot}/bake-index.json`
    || path.basename(readyXml.path) !== receipt.exported_xml_filename
    || readyXml.sha256 !== receipt.exported_xml_sha256) {
    throw new Error("baked_media_unverified: legacy export refs disagree with receipt");
  }
  const xmlPath = validateArtifact(projectPath, generationRoot, readyXml.path, readyXml.sha256);
  validateArtifact(projectPath, generationRoot, readyReceipt.path, readyReceipt.sha256);
  validateArtifact(projectPath, generationRoot, readyIndex.path, readyIndex.sha256);
  const currentIdentity = current.export_identity == null ? null : exactExportIdentityRef(current.export_identity, "CURRENT.export_identity");
  const readyIdentity = ready.export_identity == null ? null : exactExportIdentityRef(ready.export_identity, "READY.export_identity");
  if (Boolean(currentIdentity) !== Boolean(readyIdentity)
    || (currentIdentity && readyIdentity && canonicalJson(currentIdentity) !== canonicalJson(readyIdentity))) {
    throw new Error("baked_media_unverified: CURRENT/READY export identity refs disagree");
  }
  const expectedIdentityPath = `${generationRoot}/${expectedProjectId}_premiere.export-identity.json`;
  if (readyIdentity && readyIdentity.path !== expectedIdentityPath) throw new Error("baked_media_unverified: export identity path mismatch");
  const expectedFiles = ["READY.json", "bake-index.json", `${expectedProjectId}_premiere.roundtrip.json`, `${expectedProjectId}_premiere.xml`, ...(readyIdentity ? [`${expectedProjectId}_premiere.export-identity.json`] : [])];
  if (fs.readdirSync(path.dirname(readyPath)).sort().join("|") !== expectedFiles.sort().join("|")) throw new Error("baked_media_unverified: export generation contents are not exact");
  if (readyIdentity) {
    validateExportIdentityChain(projectPath, generationRoot, readyIdentity, xmlPath, expectedProjectId);
  } else if (/<!-- Video OS v2 \| export_identity: sha256:[0-9a-f]{64} -->/.test(fs.readFileSync(xmlPath, "utf8"))) {
    throw new Error("baked_media_unverified: XML export identity marker has no sidecar");
  }
}

export function validatePremiereRoundtripApply(receipt: PremiereRoundtripReceipt, expectedProjectId: string, rawTimeline: Buffer, parsed: ParsedFcp7Sequence, reference: TimelineIR, allowBlockedTextOverlayReportWithoutSessionMarker = false, projectPath?: string): void {
  if (receipt.project_id !== expectedProjectId) throw new Error(`receipt project_id mismatch: expected ${expectedProjectId}, got ${receipt.project_id}`);
  if (receipt.base_timeline_sha256 !== sha256Prefixed(rawTimeline)) throw new Error("receipt base timeline hash mismatch");
  const treated = classifyPremiereVideoTreatments(reference).filter((item) => item.status !== "native");
  const bakedMarkers = parsed.videoTracks.flat().filter((clip) => clip.videoOsMeta?.representation === "baked_visual");
  if ((treated.length || bakedMarkers.length) && receipt.version !== PREMIERE_ROUNDTRIP_RECEIPT_V2_VERSION) throw new Error("baked_media_unverified: receipt v2 required for treated base or baked marker");
  validateTextManifest(receipt, reference);

  const clips = [...parsed.videoTracks.flat(), ...parsed.audioTracks.flat()];
  const baseIds = new Set([...reference.tracks.video.flatMap((track) => track.clips.map((clip) => fcp7ClipItemId("cv", clip.clip_id))), ...reference.tracks.audio.flatMap((track) => track.clips.map((clip) => fcp7ClipItemId("ca", clip.clip_id)))]);
  const missing = clips.find((clip) => !clip.videoOsMeta && baseIds.has(clip.xmlClipId)); if (missing) throw new Error(`base FCP7 clip ${missing.xmlClipId} is missing its video_os marker block`);
  if (clips.some((clip) => clip.videoOsMarkerMalformed)) throw new Error("XML contains malformed video_os marker");
  const seenMappedClipIds = new Set<string>(), seenMappedXmlIds = new Set<string>();
  for (const [kind, tracks] of [["cv", parsed.videoTracks], ["ca", parsed.audioTracks]] as const) for (const clip of tracks.flat()) {
    if ((clip.videoOsMarkers?.length ?? (clip.videoOsMeta ? 1 : 0)) > 1) throw new Error("XML contains duplicate video_os markers");
    const meta = clip.videoOsMeta; if (!meta) continue;
    if (seenMappedClipIds.has(meta.clip_id) || seenMappedXmlIds.has(clip.xmlClipId)) throw new Error("XML contains duplicate mapped clip identity");
    seenMappedClipIds.add(meta.clip_id); seenMappedXmlIds.add(clip.xmlClipId);
    if (clip.xmlClipId !== fcp7ClipItemId(kind, meta.clip_id)) throw new Error("XML mapped clip ID was remapped");
    const canonical = (kind === "cv" ? reference.tracks.video : reference.tracks.audio).flatMap((track) => track.clips).find((item) => item.clip_id === meta.clip_id);
    if (canonical && canonical.asset_id !== meta.asset_id) throw new Error("XML mapped asset identity conflicts with base");
  }
  const mapped = clips.flatMap((clip) => clip.videoOsMarkers ?? (clip.videoOsMeta ? [clip.videoOsMeta] : []));
  const generatorIds = parsed.textOverlayGenerators.filter((item) => item.status === "exact" && item.roundtripId).map((item) => item.roundtripId!);
  if (!mapped.length && !generatorIds.length) { if (allowBlockedTextOverlayReportWithoutSessionMarker && (receipt.text_overlay_manifest?.length ?? 0) > 0) return; throw new Error("XML has no mapped video_os markers for roundtrip_id validation"); }
  const ids = new Set<string>(); for (const meta of mapped) {
    if (meta.roundtrip_id_malformed) throw new Error("XML contains malformed video_os roundtrip_id");
    if (!meta.roundtrip_id) throw new Error("XML mapped video_os marker is missing roundtrip_id");
    if (!SHA.test(meta.roundtrip_id)) throw new Error("XML contains malformed video_os roundtrip_id");
    ids.add(meta.roundtrip_id);
  } for (const id of generatorIds) ids.add(id);
  if (ids.size !== 1) throw new Error("XML contains mixed video_os roundtrip_id values"); if ([...ids][0] !== receipt.roundtrip_id) throw new Error("XML video_os roundtrip_id does not match receipt");

  if (receipt.version === PREMIERE_ROUNDTRIP_RECEIPT_V2_VERSION) {
    if (!projectPath) throw new Error("baked_media_unverified: project path required for receipt v2");
    const index = validateExportArtifactGraph(projectPath, receipt, expectedProjectId);
    if (receipt.baked_clip_maps.length !== treated.length || index.entries.length !== treated.length) throw new Error("baked_media_unverified: treated clip coverage mismatch");
    for (const map of receipt.baked_clip_maps) {
      const classification = treated.find((item) => item.clip_id === map.clip_id);
      if (!classification || classification.status !== "bake_required" || classification.track_id !== map.timeline_track_id || classification.clip.asset_id !== map.canonical_asset_id || classification.clip.src_in_us !== map.source_in_us || classification.clip.src_out_us !== map.source_out_us || classification.clip.timeline_duration_frames !== map.timeline_duration_frames || reference.sequence.fps_num !== map.fps_num || (reference.sequence.fps_den || 1) !== map.fps_den) throw new Error("baked_media_unverified: receipt map does not match treated base clip");
      const entry = index.entries.find((item) => item.clip_id === map.clip_id); if (!entry || entry.bake_request_id !== map.bake_request_id || entry.manifest_sha256 !== map.manifest_sha256 || entry.media_sha256 !== map.media_sha256) throw new Error("baked_media_unverified: index map mismatch");
      const overlap = { clip_id: map.clip_id, canonical_asset_id: map.canonical_asset_id, derived_asset_id: map.derived_asset_id, bake_request_id: map.bake_request_id, manifest_path: map.manifest_path, manifest_sha256: map.manifest_sha256, media_path: map.media_path, media_sha256: map.media_sha256, media_video_stream_sha256: map.media_video_stream_sha256 };
      if (canonicalJson(entry) !== canonicalJson(overlap)) throw new Error("baked_media_unverified: receipt/index overlap mismatch");
      const artifact = validatePremiereBakeArtifactGraph(projectPath, overlap, receipt.base_timeline_sha256, expectedProjectId);
      if (artifact.timeline_track_id !== map.timeline_track_id || artifact.source_in_us !== map.source_in_us || artifact.source_out_us !== map.source_out_us || artifact.timeline_duration_frames !== map.timeline_duration_frames || artifact.fps_num !== map.fps_num || artifact.fps_den !== map.fps_den || artifact.effect_editable !== false) throw new Error("baked_media_unverified: receipt map does not match baked request");
      const returned = parsed.videoTracks.flatMap((track, trackIndex) => track.map((clip) => ({ clip, trackIndex }))).find(({ clip }) => clip.videoOsMeta?.clip_id === map.clip_id);
      if (!returned) continue;
      const meta = returned.clip.videoOsMeta!;
      if (returned.clip.xmlClipId !== map.xml_clipitem_id || meta.representation !== "baked_visual" || meta.bake_request_id !== map.bake_request_id || meta.derived_asset_id !== map.derived_asset_id || meta.manifest_sha256 !== map.manifest_sha256 || meta.output_sha256 !== map.media_sha256 || meta.effect_editable !== false) throw new Error("baked_media_edit: baked identity changed");
      const expectedTrack = reference.tracks.video.findIndex((track) => track.track_id === map.timeline_track_id); if (returned.trackIndex !== expectedTrack) throw new Error("baked_media_edit: track_move");
      if (returned.clip.srcInFrame !== 0 || returned.clip.srcOutFrame !== map.timeline_duration_frames || returned.clip.timelineEndFrame - returned.clip.timelineInFrame !== map.timeline_duration_frames) throw new Error("baked_media_edit: trim");
      let decoded: string; try { decoded = decodeURIComponent(returned.clip.pathurl).replace(/^file:\/\/localhost/, ""); } catch { throw new Error("baked_media_edit: relink"); }
      const expectedMedia = path.resolve(projectPath, map.media_path); if (path.resolve(decoded) !== expectedMedia) throw new Error("baked_media_edit: relink");
      const signals = returned.clip.unsupportedEditSignals ?? [], signal = signals[0];
      const expectedNtsc = map.fps_den === 1001, expectedTimebase = expectedNtsc ? Math.round(map.fps_num / 1000) : map.fps_num;
      if (signals.length !== 1 || !signal || signal.kind !== "rate" || signal.rateIndex !== 0 || signal.timebase !== String(expectedTimebase) || signal.ntsc !== (expectedNtsc ? "TRUE" : "FALSE") || parsed.timebase !== expectedTimebase || parsed.ntsc !== expectedNtsc) throw new Error("baked_media_edit: filter_speed_or_rate");
    }
    const expectedGeneration = derivePremiereExportGenerationId(receipt.project_id, receipt.base_timeline_sha256, receipt.roundtrip_id, receipt.exported_xml.sha256, receipt.bake_index.sha256);
    if (receipt.export_generation_id !== expectedGeneration) throw new Error("baked_media_unverified: export_generation_id mismatch");
  } else {
    // Keep the original v1 apply API usable for callers that only have the
    // parsed XML/receipt. When a project root is available, validate the
    // immutable CURRENT/READY/generation identity chain as well.
    if (projectPath) validateLegacyExportIdentityGraph(projectPath, receipt, expectedProjectId);
  }
}
