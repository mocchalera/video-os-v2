import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { applyPatch, type PatchOperation, type ReviewPatch } from "../compiler/patch.js";
import type { Candidate, DurationPolicy, TimelineIR } from "../compiler/types.js";

export const CANONICAL_REVIEW_BASE_TIMELINE_PATH = "05_timeline/canonical-timeline.json" as const;

export interface DerivedMappingEntity {
  semantic_anchor: string;
  kind: "clip" | "caption" | "marker";
  before: { start_frame: number; end_frame: number } | null;
  after: { start_frame: number; end_frame: number } | null;
  status: "preserved" | "moved" | "removed" | "added";
}

export interface DerivedMappingReceipt {
  version: "derived-frame-mapping/v1";
  policy: "ripple-semantic-anchor/v1";
  operations: Array<{ index: number; op: string; ripple: boolean }>;
  entities: DerivedMappingEntity[];
  mapping_sha256: string;
}

export interface ReviewEditIdentityReceipt {
  version: "review-edit-identity/v1";
  project_id: string;
  canonical_timeline: { path: string; version: string; sha256: string };
  accepted_patch: { path: string; sha256: string; version: "review-patch/v2"; status: "accepted" };
  derived_mapping: { path: string; version: "derived-frame-mapping/v1"; sha256: string };
  review_timeline: { path: string; version: string; sha256: string };
  cut_identity: string;
}

type DerivationProvenance = {
  version: "review-derivation/v1";
  canonical_timeline_sha256: string;
  canonical_timeline_path: string;
  accepted_patch_sha256: string;
  derived_mapping_sha256: string;
  derived_mapping_path: string;
  identity_receipt_path: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function computeArtifactSha256(filePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function temporalEntities(timeline: TimelineIR): Map<string, Omit<DerivedMappingEntity, "before" | "after" | "status"> & { range: { start_frame: number; end_frame: number } }> {
  const result = new Map<string, Omit<DerivedMappingEntity, "before" | "after" | "status"> & { range: { start_frame: number; end_frame: number } }>();
  const groups = [timeline.tracks.video, timeline.tracks.audio, timeline.tracks.overlay ?? [], timeline.tracks.caption ?? []];
  for (const tracks of groups) {
    for (const track of tracks) {
      for (const clip of track.clips) {
        const anchor = `clip:${track.track_id}:${clip.clip_id}`;
        result.set(anchor, {
          semantic_anchor: anchor,
          kind: "clip",
          range: { start_frame: clip.timeline_in_frame, end_frame: clip.timeline_in_frame + clip.timeline_duration_frames },
        });
        for (const [index, caption] of (clip.captions ?? []).entries()) {
          const captionAnchor = `caption:${track.track_id}:${clip.clip_id}:${index}:${hashText(caption.text)}`;
          result.set(captionAnchor, {
            semantic_anchor: captionAnchor,
            kind: "caption",
            range: { start_frame: caption.in_frame, end_frame: caption.out_frame },
          });
        }
      }
    }
  }
  for (const [index, marker] of timeline.markers.entries()) {
    const anchor = `marker:${index}:${marker.kind}:${hashText(marker.label)}`;
    result.set(anchor, {
      semantic_anchor: anchor,
      kind: "marker",
      range: { start_frame: marker.frame, end_frame: marker.frame },
    });
  }
  return result;
}

export function buildDerivedMappingReceipt(
  beforeTimeline: TimelineIR,
  afterTimeline: TimelineIR,
  operations: Array<Pick<PatchOperation, "op" | "ripple">>,
): DerivedMappingReceipt {
  const before = temporalEntities(beforeTimeline);
  const after = temporalEntities(afterTimeline);
  const anchors = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right, "en"));
  const entities: DerivedMappingEntity[] = anchors.map((anchor) => {
    const prior = before.get(anchor)?.range ?? null;
    const next = after.get(anchor)?.range ?? null;
    const status = !prior ? "added" : !next ? "removed"
      : prior.start_frame === next.start_frame && prior.end_frame === next.end_frame ? "preserved" : "moved";
    return { semantic_anchor: anchor, kind: (before.get(anchor) ?? after.get(anchor))!.kind, before: prior, after: next, status };
  });
  const payload = {
    version: "derived-frame-mapping/v1" as const,
    policy: "ripple-semantic-anchor/v1" as const,
    operations: operations.map((operation, index) => ({ index, op: operation.op, ripple: operation.ripple === true })),
    entities,
  };
  return { ...payload, mapping_sha256: hashText(canonical(payload)) };
}

export function stampReviewDerivation(
  timeline: TimelineIR,
  canonicalTimelineSha256: string,
  patchSha256: string,
  mapping: DerivedMappingReceipt,
): void {
  (timeline.provenance as TimelineIR["provenance"] & { review_derivation?: DerivationProvenance }).review_derivation = {
    version: "review-derivation/v1",
    canonical_timeline_sha256: canonicalTimelineSha256,
    canonical_timeline_path: CANONICAL_REVIEW_BASE_TIMELINE_PATH,
    accepted_patch_sha256: patchSha256,
    derived_mapping_sha256: mapping.mapping_sha256,
    derived_mapping_path: "05_timeline/derived-frame-mapping.json",
    identity_receipt_path: "05_timeline/review-edit-identity.json",
  };
}

function assertRegularProjectFile(projectDir: string, filePath: string, label: string): void {
  const resolved = resolveInside(projectDir, filePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error(`underivable review variant: ${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`underivable review variant: ${label} must be a regular project file`);
  }
}

function derivationComparableTimeline(timeline: TimelineIR): unknown {
  // Compare the persisted artifact shape. The patch applicator may carry
  // optional properties with an in-memory value of undefined, while JSON
  // persistence omits those properties; those are not derivation changes.
  const comparable = JSON.parse(JSON.stringify(timeline)) as TimelineIR;
  const provenance = comparable.provenance as TimelineIR["provenance"] & {
    review_derivation?: DerivationProvenance;
  };
  delete provenance.review_derivation;
  if (comparable.metadata) {
    // These are compiler-side receipts stamped after the pure patch result.
    // Geometry and content remain fully compared below, including every
    // overlay/content element.
    delete comparable.metadata.source_mapping_hash;
    delete comparable.metadata.rhythm_sync;
    if (Object.keys(comparable.metadata).length === 0) delete comparable.metadata;
  }
  return comparable;
}

function overlayProjection(timeline: TimelineIR): unknown {
  return (timeline.tracks.overlay ?? []).map((track) => ({
    track_id: track.track_id,
    kind: track.kind,
    clips: track.clips,
  }));
}

function loadDerivationCandidates(projectDir: string, patch: ReviewPatch): Candidate[] {
  const needsCandidates = patch.operations.some((operation) =>
    operation.op === "replace_segment" || operation.op === "insert_segment",
  );
  const selectsPath = path.join(path.resolve(projectDir), "04_plan/selects_candidates.yaml");
  if (!fs.existsSync(selectsPath)) {
    if (needsCandidates) {
      throw new Error("underivable review variant: selects_candidates.yaml is missing for candidate-based patch operations");
    }
    return [];
  }
  const parsed = parseYaml(fs.readFileSync(selectsPath, "utf8")) as { candidates?: unknown };
  if (!Array.isArray(parsed.candidates)) {
    throw new Error("underivable review variant: selects_candidates.yaml has no candidates array");
  }
  return parsed.candidates as Candidate[];
}

function loadDerivationDuration(projectDir: string): {
  targetDurationFrames?: number;
  durationPolicy?: DurationPolicy;
} {
  const blueprintPath = path.join(path.resolve(projectDir), "04_plan/edit_blueprint.yaml");
  if (!fs.existsSync(blueprintPath)) return {};
  const parsed = parseYaml(fs.readFileSync(blueprintPath, "utf8")) as {
    beats?: Array<{ target_duration_frames?: unknown }>;
    duration_policy?: DurationPolicy;
  };
  const targetDurationFrames = Array.isArray(parsed.beats)
    ? parsed.beats.reduce((sum, beat) =>
        sum + (typeof beat.target_duration_frames === "number" ? beat.target_duration_frames : 0), 0)
    : 0;
  return {
    ...(targetDurationFrames > 0 ? { targetDurationFrames } : {}),
    ...(parsed.duration_policy ? { durationPolicy: parsed.duration_policy } : {}),
  };
}

function assertPatchDerivesTimeline(input: {
  projectDir: string;
  canonicalTimeline: TimelineIR;
  reviewTimeline: TimelineIR;
  patch: ReviewPatch;
}): void {
  const candidates = loadDerivationCandidates(input.projectDir, input.patch);
  const duration = loadDerivationDuration(input.projectDir);
  const result = applyPatch(
    input.canonicalTimeline,
    input.patch,
    candidates,
    duration.targetDurationFrames,
    duration.durationPolicy,
    input.canonicalTimeline.sequence.fps_num,
    input.canonicalTimeline.sequence.fps_den,
  );
  if (result.errors.length > 0) {
    throw new Error(`underivable review variant: accepted patch cannot be re-applied (${result.errors.map((error) => error.message).join("; ")})`);
  }
  if (canonical(derivationComparableTimeline(result.timeline)) !== canonical(derivationComparableTimeline(input.reviewTimeline))) {
    if (canonical(overlayProjection(result.timeline)) !== canonical(overlayProjection(input.reviewTimeline))) {
      throw new Error("unexpressed overlay: review timeline overlay content is not derived from the accepted patch");
    }
    throw new Error("underivable review variant: review timeline does not match canonical timeline plus accepted patch");
  }
}

function resolveInside(projectDir: string, relativePath: string): string {
  const root = path.resolve(projectDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("review identity path escapes project");
  return resolved;
}

export function writeReviewEditIdentityReceipt(input: {
  projectDir: string;
  timelinePath: string;
  patchPath: string;
  mapping: DerivedMappingReceipt;
  outputPath?: string;
}): ReviewEditIdentityReceipt {
  const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8")) as TimelineIR;
  const receipt = buildReviewEditIdentityReceipt({ ...input, timeline });
  const provenance = (timeline.provenance as TimelineIR["provenance"] & { review_derivation?: DerivationProvenance }).review_derivation!;
  const outputPath = input.outputPath ?? path.join(input.projectDir, provenance.identity_receipt_path);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

export function buildReviewEditIdentityReceipt(input: {
  projectDir: string;
  timelinePath: string;
  patchPath: string;
  timeline: TimelineIR;
  mapping: DerivedMappingReceipt;
}): ReviewEditIdentityReceipt {
  const timeline = input.timeline;
  const patch = JSON.parse(fs.readFileSync(input.patchPath, "utf8")) as Record<string, unknown>;
  if (patch.patch_version !== "review-patch/v2" || patch.status !== "accepted") {
    throw new Error("review variant requires an accepted review-patch/v2 artifact");
  }
  const provenance = (timeline.provenance as TimelineIR["provenance"] & { review_derivation?: DerivationProvenance }).review_derivation;
  if (!provenance) throw new Error("underivable review timeline: review_derivation provenance is missing");
  const timelineSha = hashText(JSON.stringify(timeline, null, 2));
  const patchSha = computeArtifactSha256(input.patchPath);
  if (patchSha !== provenance.accepted_patch_sha256) throw new Error("patch hash mismatch while writing review identity");
  const receipt: ReviewEditIdentityReceipt = {
    version: "review-edit-identity/v1",
    project_id: timeline.project_id,
    canonical_timeline: {
      path: provenance.canonical_timeline_path,
      version: String(patch.timeline_version),
      sha256: provenance.canonical_timeline_sha256,
    },
    accepted_patch: {
      path: path.relative(path.resolve(input.projectDir), path.resolve(input.patchPath)).split(path.sep).join("/"),
      sha256: patchSha,
      version: "review-patch/v2",
      status: "accepted",
    },
    derived_mapping: { path: provenance.derived_mapping_path, version: input.mapping.version, sha256: input.mapping.mapping_sha256 },
    review_timeline: {
      path: path.relative(path.resolve(input.projectDir), path.resolve(input.timelinePath)).split(path.sep).join("/"),
      version: timeline.version,
      sha256: timelineSha,
    },
    cut_identity: timelineSha,
  };
  return receipt;
}

export function verifyReviewEditIdentity(input: {
  projectDir: string;
  timelinePath: string;
  requireDerived: boolean;
}): ReviewEditIdentityReceipt {
  const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8")) as TimelineIR;
  const provenance = (timeline.provenance as TimelineIR["provenance"] & { review_derivation?: DerivationProvenance }).review_derivation;
  if (!provenance) {
    throw new Error(input.requireDerived
      ? "underivable review timeline: accepted patch derivation receipt is required"
      : "review edit identity is unavailable");
  }
  const receiptPath = resolveInside(input.projectDir, provenance.identity_receipt_path);
  if (!fs.existsSync(receiptPath)) throw new Error("underivable review timeline: identity receipt is missing");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as ReviewEditIdentityReceipt;
  if (receipt.version !== "review-edit-identity/v1" || receipt.project_id !== timeline.project_id) {
    throw new Error("underivable review timeline: identity receipt is invalid");
  }
  const patchPath = resolveInside(input.projectDir, receipt.accepted_patch.path);
  if (receipt.accepted_patch.path !== "06_review/review_patch.json") {
    throw new Error("underivable review variant: accepted patch is not the canonical project artifact");
  }
  assertRegularProjectFile(input.projectDir, receipt.accepted_patch.path, "accepted patch");
  const patch = JSON.parse(fs.readFileSync(patchPath, "utf8")) as Record<string, unknown>;
  if (patch.patch_version !== "review-patch/v2" || patch.status !== "accepted") throw new Error("review variant patch is not accepted review-patch/v2");
  if (computeArtifactSha256(patchPath) !== receipt.accepted_patch.sha256 || receipt.accepted_patch.sha256 !== provenance.accepted_patch_sha256) {
    throw new Error("patch hash mismatch in review edit identity");
  }
  if (patch.base_timeline_sha256 !== receipt.canonical_timeline.sha256 || receipt.canonical_timeline.sha256 !== provenance.canonical_timeline_sha256) {
    throw new Error("canonical timeline hash mismatch in review edit identity");
  }
  if (receipt.canonical_timeline.path !== provenance.canonical_timeline_path) {
    throw new Error("canonical timeline path mismatch in review edit identity");
  }
  assertRegularProjectFile(input.projectDir, receipt.canonical_timeline.path, "canonical timeline");
  const canonicalTimelinePath = resolveInside(input.projectDir, receipt.canonical_timeline.path);
  if (computeArtifactSha256(canonicalTimelinePath) !== receipt.canonical_timeline.sha256) {
    throw new Error("canonical timeline hash mismatch in review edit identity");
  }
  const canonicalTimeline = JSON.parse(fs.readFileSync(canonicalTimelinePath, "utf8")) as TimelineIR;
  if (canonicalTimeline.version !== String(patch.timeline_version) || canonicalTimeline.project_id !== timeline.project_id) {
    throw new Error("underivable review variant: canonical timeline identity is inconsistent");
  }
  if (receipt.derived_mapping.sha256 !== provenance.derived_mapping_sha256) throw new Error("derived mapping receipt mismatch");
  const mappingPath = resolveInside(input.projectDir, receipt.derived_mapping.path);
  if (!fs.existsSync(mappingPath)) throw new Error("derived mapping receipt is missing");
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8")) as DerivedMappingReceipt;
  const mappingPayload = { version: mapping.version, policy: mapping.policy, operations: mapping.operations, entities: mapping.entities };
  if (hashText(canonical(mappingPayload)) !== mapping.mapping_sha256 || mapping.mapping_sha256 !== receipt.derived_mapping.sha256) {
    throw new Error("derived mapping receipt mismatch");
  }
  const timelineSha = computeArtifactSha256(input.timelinePath);
  if (receipt.review_timeline.sha256 !== timelineSha || receipt.cut_identity !== timelineSha) throw new Error("review timeline cut identity mismatch");
  if (path.resolve(input.projectDir, receipt.review_timeline.path) !== path.resolve(input.timelinePath)) throw new Error("review timeline path mismatch");
  assertPatchDerivesTimeline({
    projectDir: input.projectDir,
    canonicalTimeline,
    reviewTimeline: timeline,
    patch: patch as unknown as ReviewPatch,
  });
  return receipt;
}

export function resolveReviewCutIdentity(input: {
  projectDir: string;
  timelinePath: string;
  variantRequested?: boolean;
}): { mode: "derived" | "legacy_canonical"; cut_identity: string; receipt: ReviewEditIdentityReceipt | null } {
  const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8")) as TimelineIR;
  if (timeline.provenance?.review_derivation) {
    const receipt = verifyReviewEditIdentity({ projectDir: input.projectDir, timelinePath: input.timelinePath, requireDerived: true });
    return { mode: "derived", cut_identity: receipt.cut_identity, receipt };
  }
  const patchPath = path.join(input.projectDir, "06_review", "review_patch.json");
  if (fs.existsSync(patchPath)) {
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(fs.readFileSync(patchPath, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error("review variant requires an accepted review-patch/v2 artifact");
    }
    if (patch.patch_version !== "review-patch/v2" || patch.status !== "accepted") {
      throw new Error("review variant requires an accepted review-patch/v2 artifact");
    }
    throw new Error("underivable review variant: accepted patch derived mapping and cut identity receipts are required");
  }
  if (input.variantRequested) {
    throw new Error("underivable review variant: accepted patch derived mapping and cut identity receipts are required");
  }
  return { mode: "legacy_canonical", cut_identity: computeArtifactSha256(input.timelinePath), receipt: null };
}
