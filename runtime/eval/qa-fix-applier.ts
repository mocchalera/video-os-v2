import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Candidate,
  ClipOutput,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
  TrimHint,
} from "../artifacts/types.js";
import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import { generateCandidateId, getCandidateRef } from "../compiler/candidate-ref.js";
import { primaryVideoClips } from "./qa-issue-detector.js";
import type { QAFix } from "./qa-fix-proposer.js";
import {
  defaultDiscoveryContract,
  existingEligibleCandidate,
  replacementIsExcluded,
  validateExternalReplacement,
  normalizeQASnapshotString,
  QA_FIX_SNAPSHOT_LIMITS,
  type CanonicalReplacement,
  type CanonicalSegment,
  type QADiscoveryContract,
} from "./qa-source-discovery.js";

export interface ApplyResult {
  applied: QAFix[];
  skipped: QAFix[];
  selects_modified: boolean;
  blueprint_modified: boolean;
  timeline_changed?: boolean;
  warnings: string[];
  modified_beat_ids: string[];
}

export interface ApplyFixesOptions {
  dryRun?: boolean;
  projectDir?: string;
  segmentIds?: Iterable<string>;
  segments?: Array<Pick<SegmentItem, "segment_id" | "asset_id" | "src_in_us" | "src_out_us"> & Partial<SegmentItem> & { trim_hint?: TrimHint }>;
  recompile?: (selects: SelectsCandidates, blueprint: EditBlueprint) => TimelineIR;
  discovery?: QADiscoveryContract;
}

interface SegmentIndex {
  byId: Map<string, SegmentLike>;
}

interface SegmentLike {
  segment_id: string;
  asset_id?: string;
  src_in_us?: number;
  src_out_us?: number;
  summary?: string;
  transcript_excerpt?: string;
  quality_flags?: string[];
  tags?: string[];
  trim_hint?: TrimHint;
}

type ReorderPayload = {
  candidate_order?: string[];
  candidate_refs?: string[];
  reorder?: { candidate_refs?: string[]; candidate_order?: string[] };
  before_segment_id?: string;
  after_segment_id?: string;
};

type TrimPayload = {
  trim_hint?: TrimHint;
  new_trim_hint?: TrimHint;
  recommended_in_us?: number;
  recommended_out_us?: number;
  preferred_duration_us?: number;
};

export function applyFixes(
  fixes: QAFix[],
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  timeline: TimelineIR,
  opts: ApplyFixesOptions = {},
): ApplyResult {
  const workingSelects = opts.dryRun ? structuredClone(selects) : selects;
  const workingBlueprint = opts.dryRun ? structuredClone(blueprint) : blueprint;
  const segmentIndex = buildSegmentIndex(opts);
  const discovery = opts.discovery ?? defaultDiscoveryContract(selects.project_id);

  const result: ApplyResult = {
    applied: [],
    skipped: [],
    selects_modified: false,
    blueprint_modified: false,
    timeline_changed: false,
    warnings: [],
    modified_beat_ids: [],
  };
  const modifiedBeatIds = new Set<string>();

  if (
    timeline.project_id !== selects.project_id
    || blueprint.project_id !== selects.project_id
    || discovery.projectId !== selects.project_id
  ) {
    result.skipped = [...fixes];
    result.warnings.push("Skipped batch: timeline/selects/blueprint/discovery project_id mismatch");
    return result;
  }

  if (!preflightExternalFixes(fixes, workingSelects, workingBlueprint, timeline, discovery, opts, segmentIndex, result)) {
    result.skipped = [...fixes];
    return result;
  }

  for (const fix of fixes) {
    const applied = applyOneFix(fix, workingSelects, workingBlueprint, timeline, segmentIndex, discovery, opts, result, modifiedBeatIds);
    if (applied) {
      result.applied.push(fix);
    } else {
      result.skipped.push(fix);
    }
  }

  result.modified_beat_ids = [...modifiedBeatIds].sort((a, b) => a.localeCompare(b));
  verifyTimelineChange(timeline, workingSelects, workingBlueprint, opts, result);
  return result;
}

function preflightExternalFixes(
  fixes: QAFix[],
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  timeline: TimelineIR,
  discovery: QADiscoveryContract,
  opts: ApplyFixesOptions,
  segmentIndex: SegmentIndex,
  result: ApplyResult,
): boolean {
  const seen = new Set<string>();
  for (const fix of fixes) {
    if (fix.fix_type !== "swap" && fix.fix_type !== "insert") continue;
    const segmentId = fix.replacement?.segment_id;
    if (!segmentId) continue;
    const eligible = existingEligibleCandidate(selects, segmentId, fix.target_beat_id);
    const external = Boolean(fix.replacement?.snapshot) || !eligible;
    if (!external) continue;
    if (seen.has(segmentId)) {
      result.warnings.push(`Skipped batch: duplicate external replacement ${segmentId}`);
      return false;
    }
    seen.add(segmentId);
    const targetClip = clipForFix(fix, timeline);
    if (!targetClip || targetClip.beat_id !== fix.target_beat_id) {
      result.warnings.push(`Skipped batch: ${fix.issue_id} target clip/beat mismatch`);
      return false;
    }
    if (!blueprint.beats.some((beat) => beat.id === fix.target_beat_id)) {
      result.warnings.push(`Skipped batch: ${fix.issue_id} target beat is absent from blueprint`);
      return false;
    }
    if (fix.fix_type === "swap" && !candidateForSegment(selects, targetClip.segment_id)) {
      result.warnings.push(`Skipped batch: ${fix.issue_id} target candidate is missing`);
      return false;
    }
    if (!prepareReplacement(fix, selects, timeline, fix.target_beat_id, discovery, opts, segmentIndex, result)) {
      result.warnings.push("External replacement preflight failed; no fixes were applied");
      return false;
    }
  }
  return true;
}

function applyOneFix(
  fix: QAFix,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  timeline: TimelineIR,
  segmentIndex: SegmentIndex,
  discovery: QADiscoveryContract,
  opts: ApplyFixesOptions,
  result: ApplyResult,
  modifiedBeatIds: Set<string>,
): boolean {
  const beatId = resolveTargetBeatId(fix, timeline);
  if (!beatId) {
    result.warnings.push(`Skipped ${fix.issue_id}: target beat could not be resolved`);
    return false;
  }

  const beat = blueprint.beats.find((item) => item.id === beatId);
  if (!beat) {
    result.warnings.push(`Skipped ${fix.issue_id}: target beat not found in blueprint: ${beatId}`);
    return false;
  }

  switch (fix.fix_type) {
    case "swap":
      return applySwap(fix, selects, beat, timeline, segmentIndex, discovery, opts, result, modifiedBeatIds);
    case "reorder":
      return applyReorder(fix, beat, timeline, result, modifiedBeatIds);
    case "trim":
      return applyTrim(fix, selects, timeline, result, modifiedBeatIds, beatId);
    case "insert":
      return applyInsert(fix, selects, beat, timeline, segmentIndex, discovery, opts, result, modifiedBeatIds);
    case "remove":
      return applyRemove(fix, selects, beat, timeline, result, modifiedBeatIds, beatId);
    default:
      result.warnings.push(`Skipped ${fix.issue_id}: unsupported fix type ${(fix as { fix_type?: string }).fix_type}`);
      return false;
  }
}

function applySwap(
  fix: QAFix,
  selects: SelectsCandidates,
  beat: EditBlueprint["beats"][number],
  timeline: TimelineIR,
  segmentIndex: SegmentIndex,
  discovery: QADiscoveryContract,
  opts: ApplyFixesOptions,
  result: ApplyResult,
  modifiedBeatIds: Set<string>,
): boolean {
  const replacementId = fix.replacement?.segment_id;
  if (!replacementId) {
    result.warnings.push(`Skipped ${fix.issue_id}: swap fix is missing replacement.segment_id`);
    return false;
  }
  const targetClip = clipForFix(fix, timeline);
  if (!targetClip) {
    result.warnings.push(`Skipped ${fix.issue_id}: target clip not found: ${fix.target_clip_id}`);
    return false;
  }
  if (targetClip.beat_id !== beat.id) {
    result.warnings.push(`Skipped ${fix.issue_id}: target clip beat ${targetClip.beat_id} does not match fix beat ${beat.id}`);
    return false;
  }

  const targetCandidate = candidateForSegment(selects, targetClip.segment_id);
  if (!targetCandidate) {
    result.warnings.push(`Skipped ${fix.issue_id}: target candidate not found for segment: ${targetClip.segment_id}`);
    return false;
  }
  if (targetSegmentUsedInOtherBeats(timeline, targetClip.segment_id, beat.id)) {
    result.warnings.push(`Skipped ${fix.issue_id}: target segment is used by another beat and cannot be safely swapped: ${targetClip.segment_id}`);
    return false;
  }

  const prepared = prepareReplacement(fix, selects, timeline, beat.id, discovery, opts, segmentIndex, result);
  if (!prepared) return false;

  const oldRefs = refsForCandidate(targetCandidate);
  const oldPrimarySegmentId = targetClip.segment_id;
  const oldPrimaryCandidate = structuredClone(targetCandidate);
  const replacementCandidate = prepared.candidate;
  const replacementSegment = prepared.canonical?.segment ?? segmentIndex.byId.get(replacementId);
  const nextCandidate = buildReplacementCandidate({
    projectId: selects.project_id,
    targetCandidate,
    replacementCandidate,
    replacementSegment,
    fix,
    beatId: beat.id,
  });

  Object.keys(targetCandidate).forEach((key) => {
    delete (targetCandidate as unknown as Record<string, unknown>)[key];
  });
  Object.assign(targetCandidate, nextCandidate);
  result.selects_modified = true;

  if (!candidateForSegment(selects, oldPrimarySegmentId)) {
    selects.candidates.push(oldPrimaryCandidate);
  }

  if (updateBeatPlanForSwap(beat, oldRefs, replacementId, oldPrimarySegmentId)) {
    result.blueprint_modified = true;
  }
  modifiedBeatIds.add(beat.id);
  return true;
}

function applyReorder(
  fix: QAFix,
  beat: EditBlueprint["beats"][number],
  timeline: TimelineIR,
  result: ApplyResult,
  modifiedBeatIds: Set<string>,
): boolean {
  const plan = beat.candidate_plan;
  if (!plan) {
    result.warnings.push(`Skipped ${fix.issue_id}: beat has no candidate_plan to reorder: ${beat.id}`);
    return false;
  }
  const fallbackRefs = plan.fallback_candidate_refs ?? [];
  if (fallbackRefs.length === 0) {
    result.warnings.push(`Skipped ${fix.issue_id}: beat candidate_plan has no fallbacks to reorder: ${beat.id}`);
    return false;
  }

  const desired = explicitReorderRefs(fix);
  const nextFallbacks = desired.length > 0
    ? mergeExplicitOrder(desired, fallbackRefs)
    : fallbackReorder(fix, timeline, fallbackRefs);
  if (nextFallbacks.length === 0 || arraysEqual(fallbackRefs, nextFallbacks)) {
    result.warnings.push(`Skipped ${fix.issue_id}: reorder produced no candidate_plan change`);
    return false;
  }

  plan.fallback_candidate_refs = nextFallbacks;
  result.blueprint_modified = true;
  modifiedBeatIds.add(beat.id);
  return true;
}

function applyTrim(
  fix: QAFix,
  selects: SelectsCandidates,
  timeline: TimelineIR,
  result: ApplyResult,
  modifiedBeatIds: Set<string>,
  beatId: string,
): boolean {
  const targetClip = clipForFix(fix, timeline);
  if (!targetClip) {
    result.warnings.push(`Skipped ${fix.issue_id}: target clip not found: ${fix.target_clip_id}`);
    return false;
  }
  if (targetClip.beat_id !== beatId) {
    result.warnings.push(`Skipped ${fix.issue_id}: target clip beat ${targetClip.beat_id} does not match fix beat ${beatId}`);
    return false;
  }
  const candidate = candidateForSegment(selects, targetClip.segment_id);
  if (!candidate) {
    result.warnings.push(`Skipped ${fix.issue_id}: target candidate not found for trim: ${targetClip.segment_id}`);
    return false;
  }

  const nextTrimHint = {
    ...(candidate.trim_hint ?? {}),
    ...computedTrimHint(fix, candidate, targetClip, timeline),
  };
  if (JSON.stringify(candidate.trim_hint ?? {}) === JSON.stringify(nextTrimHint)) {
    result.warnings.push(`Skipped ${fix.issue_id}: trim hint was unchanged for ${candidate.segment_id}`);
    return false;
  }

  candidate.trim_hint = nextTrimHint;
  if (isMicroClipIssue(fix)) {
    candidate.quality_flags = includeValue(candidate.quality_flags, "qa_micro_clip_trim");
  }
  result.selects_modified = true;
  modifiedBeatIds.add(beatId);
  return true;
}

function applyInsert(
  fix: QAFix,
  selects: SelectsCandidates,
  beat: EditBlueprint["beats"][number],
  timeline: TimelineIR,
  segmentIndex: SegmentIndex,
  discovery: QADiscoveryContract,
  opts: ApplyFixesOptions,
  result: ApplyResult,
  modifiedBeatIds: Set<string>,
): boolean {
  const replacementId = fix.replacement?.segment_id;
  if (!replacementId) {
    result.warnings.push(`Skipped ${fix.issue_id}: insert fix is missing replacement.segment_id`);
    return false;
  }
  const targetClip = clipForFix(fix, timeline);
  if (!targetClip || targetClip.beat_id !== beat.id) {
    result.warnings.push(`Skipped ${fix.issue_id}: target clip/beat mismatch`);
    return false;
  }
  const prepared = prepareReplacement(fix, selects, timeline, beat.id, discovery, opts, segmentIndex, result);
  if (!prepared) return false;

  let changed = false;
  if (!candidateForSegment(selects, replacementId)) {
    const segment = prepared.canonical?.segment;
    if (!segment) {
      result.warnings.push(`Skipped ${fix.issue_id}: cannot materialize inserted candidate without complete canonical metadata: ${replacementId}`);
      return false;
    }
    selects.candidates.push(candidateFromSegment(selects.project_id, segment, fix, beat.id));
    result.selects_modified = true;
    changed = true;
  }

  const plan = ensureCandidatePlan(beat);
  const fallbackRefs = plan.fallback_candidate_refs ?? [];
  if (!plan.primary_candidate_ref || beatHasOpenCapacity(beat, timeline)) {
    const previousPrimary = plan.primary_candidate_ref;
    plan.primary_candidate_ref = replacementId;
    plan.fallback_candidate_refs = [
      ...(previousPrimary && previousPrimary !== replacementId ? [previousPrimary] : []),
      ...fallbackRefs,
    ].filter((ref, index, refs) => ref !== replacementId && refs.indexOf(ref) === index);
    result.blueprint_modified = true;
    changed = true;
  } else if (plan.primary_candidate_ref === replacementId) {
    const nextFallbacks = fallbackRefs.filter((ref) => ref !== replacementId);
    if (!arraysEqual(fallbackRefs, nextFallbacks)) {
      plan.fallback_candidate_refs = nextFallbacks;
      result.blueprint_modified = true;
      changed = true;
    }
  } else if (fallbackRefs[0] !== replacementId) {
    plan.fallback_candidate_refs = [replacementId, ...fallbackRefs.filter((ref) => ref !== replacementId)];
    result.blueprint_modified = true;
    changed = true;
  }

  if (!changed) {
    result.warnings.push(`Skipped ${fix.issue_id}: insert was already present in selects and candidate_plan`);
    return false;
  }
  modifiedBeatIds.add(beat.id);
  return true;
}

function applyRemove(
  fix: QAFix,
  selects: SelectsCandidates,
  beat: EditBlueprint["beats"][number],
  timeline: TimelineIR,
  result: ApplyResult,
  modifiedBeatIds: Set<string>,
  beatId: string,
): boolean {
  const targetClip = clipForFix(fix, timeline);
  if (!targetClip) {
    result.warnings.push(`Skipped ${fix.issue_id}: target clip not found: ${fix.target_clip_id}`);
    return false;
  }
  if (targetClip.beat_id !== beatId) {
    result.warnings.push(`Skipped ${fix.issue_id}: target clip beat ${targetClip.beat_id} does not match fix beat ${beatId}`);
    return false;
  }
  const candidate = candidateForSegment(selects, targetClip.segment_id);
  if (!candidate) {
    result.warnings.push(`Skipped ${fix.issue_id}: target candidate not found for remove: ${targetClip.segment_id}`);
    return false;
  }

  let changed = false;
  if (candidate.role !== "reject") {
    candidate.role = "reject";
    result.selects_modified = true;
    changed = true;
  }

  if (removeBeatPlanRefs(beat, refsForCandidate(candidate))) {
    result.blueprint_modified = true;
    changed = true;
  }

  if (!changed) {
    result.warnings.push(`Skipped ${fix.issue_id}: remove produced no artifact change`);
    return false;
  }
  modifiedBeatIds.add(beat.id);
  return true;
}

function buildReplacementCandidate(input: {
  projectId: string;
  targetCandidate: Candidate;
  replacementCandidate?: Candidate;
  replacementSegment?: SegmentLike;
  fix: QAFix;
  beatId: string;
}): Candidate {
  const { projectId, targetCandidate, replacementCandidate, replacementSegment, fix, beatId } = input;
  const segmentId = fix.replacement?.segment_id ?? replacementCandidate?.segment_id ?? replacementSegment?.segment_id ?? targetCandidate.segment_id;
  const role = targetCandidate.role === "reject"
    ? replacementCandidate?.role && replacementCandidate.role !== "reject"
      ? replacementCandidate.role
      : "support"
    : targetCandidate.role;
  const base: Candidate = {
    ...targetCandidate,
    ...(replacementCandidate ?? {}),
    segment_id: segmentId,
    asset_id: replacementCandidate?.asset_id ?? replacementSegment?.asset_id ?? targetCandidate.asset_id,
    src_in_us: replacementCandidate?.src_in_us ?? replacementSegment?.src_in_us ?? targetCandidate.src_in_us,
    src_out_us: replacementCandidate?.src_out_us ?? replacementSegment?.src_out_us ?? targetCandidate.src_out_us,
    role,
    story_role: targetCandidate.story_role ?? replacementCandidate?.story_role,
    why_it_matches: replacementCandidate?.why_it_matches
      ?? discoveryWhy(fix, replacementSegment?.summary),
    risks: replacementCandidate?.risks ? [...replacementCandidate.risks] : [...(targetCandidate.risks ?? [])],
    confidence: replacementCandidate?.confidence ?? fix.replacement?.search_score ?? targetCandidate.confidence,
    quality_flags: replacementCandidate?.quality_flags ?? replacementSegment?.quality_flags ?? [],
    evidence: uniqueStrings([
      ...(replacementCandidate?.evidence ?? []),
      ...(targetCandidate.evidence ?? []),
      ...discoveryEvidence(fix),
    ]),
    eligible_beats: includeBeat(replacementCandidate?.eligible_beats ?? targetCandidate.eligible_beats, beatId),
    transcript_excerpt: replacementCandidate?.transcript_excerpt ?? replacementSegment?.transcript_excerpt ?? targetCandidate.transcript_excerpt,
  };
  const trimHint = replacementCandidate?.trim_hint ?? replacementSegment?.trim_hint;
  if (trimHint) {
    base.trim_hint = { ...trimHint };
  } else {
    delete base.trim_hint;
  }
  base.candidate_id = generateCandidateId(projectId, base);
  return base;
}

function candidateFromSegment(
  projectId: string,
  segment: CanonicalSegment,
  fix: QAFix,
  beatId: string,
): Candidate {
  const candidate: Candidate = {
    segment_id: segment.segment_id,
    asset_id: segment.asset_id,
    src_in_us: segment.src_in_us,
    src_out_us: segment.src_out_us,
    role: "support",
    why_it_matches: discoveryWhy(fix, segment.summary),
    risks: [],
    confidence: fix.replacement?.search_score ?? 0.5,
    quality_flags: segment.quality_flags ?? [],
    evidence: discoveryEvidence(fix),
    eligible_beats: [beatId],
    transcript_excerpt: segment.transcript_excerpt,
  };
  candidate.candidate_id = generateCandidateId(projectId, candidate);
  return candidate;
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function computedTrimHint(
  fix: QAFix,
  candidate: Candidate,
  targetClip: ClipOutput,
  timeline: TimelineIR,
): TrimHint {
  const payload = fix as QAFix & TrimPayload;
  const authored = payload.new_trim_hint ?? payload.trim_hint;
  if (authored) return concreteTrimHint(authored, candidate);

  const sourceStart = candidate.src_in_us;
  const sourceEnd = candidate.src_out_us;
  const sourceDuration = Math.max(1, sourceEnd - sourceStart);
  const fps = timeline.sequence.fps_den > 0 ? timeline.sequence.fps_num / timeline.sequence.fps_den : 24;
  const clipStartSec = targetClip.timeline_in_frame / fps;
  const clipDurationSec = Math.max(0.001, targetClip.timeline_duration_frames / fps);
  const issueTimestamp = fix.issue?.timestamp_sec ?? clipStartSec + clipDurationSec / 2;
  const localRatio = clamp01((issueTimestamp - clipStartSec) / clipDurationSec);
  const sourceCenter = Math.round(sourceStart + sourceDuration * localRatio);
  const preferredDuration = clampInteger(
    payload.preferred_duration_us ?? Math.round(sourceDuration * 0.85),
    Math.min(1_000_000, sourceDuration),
    sourceDuration,
  );
  const half = Math.floor(preferredDuration / 2);
  const recommendedIn = clampInteger(payload.recommended_in_us ?? sourceCenter - half, sourceStart, sourceEnd - 1);
  const recommendedOut = clampInteger(payload.recommended_out_us ?? recommendedIn + preferredDuration, recommendedIn + 1, sourceEnd);

  return {
    source_center_us: sourceCenter,
    preferred_duration_us: preferredDuration,
    window_start_us: sourceStart,
    window_end_us: sourceEnd,
    recommended_in_us: recommendedIn,
    recommended_out_us: recommendedOut,
    rationale: `QA trim for ${fix.issue_id}`,
  };
}

function buildSegmentIndex(opts: ApplyFixesOptions): SegmentIndex {
  const byId = new Map<string, SegmentLike>();

  if (opts.segments) {
    for (const segment of opts.segments) {
      byId.set(segment.segment_id, segment);
    }
  }
  if (opts.segmentIds) {
    for (const segmentId of opts.segmentIds) {
      if (!byId.has(segmentId)) byId.set(segmentId, { segment_id: segmentId });
    }
  }
  if (opts.projectDir) {
    const segmentsPath = path.join(opts.projectDir, "03_analysis", "segments.json");
    if (fs.existsSync(segmentsPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as unknown;
        const items = Array.isArray(parsed)
          ? parsed
          : Array.isArray((parsed as { items?: unknown }).items)
            ? (parsed as { items: unknown[] }).items
            : [];
        for (const item of items) {
          const segment = item as SegmentLike;
          if (typeof segment.segment_id === "string" && segment.segment_id.length > 0) {
            byId.set(segment.segment_id, segment);
          }
        }
      } catch {
        // Canonical external materialization is rejected by snapshot validation.
      }
    }
  }

  return { byId };
}

function prepareReplacement(
  fix: QAFix,
  selects: SelectsCandidates,
  timeline: TimelineIR,
  beatId: string,
  discovery: QADiscoveryContract,
  opts: ApplyFixesOptions,
  segmentIndex: SegmentIndex,
  result: ApplyResult,
): { candidate?: Candidate; canonical?: CanonicalReplacement } | null {
  const segmentId = fix.replacement?.segment_id;
  if (!segmentId) return null;
  if (replacementIsExcluded(segmentId, timeline, selects, discovery)) {
    result.warnings.push(`Skipped ${fix.issue_id}: replacement is used, rejected, or duplicated: ${segmentId}`);
    return null;
  }
  const snapshot = fix.replacement?.snapshot;
  if (snapshot) {
    if (!opts.projectDir) {
      result.warnings.push(`Skipped ${fix.issue_id}: external replacement requires projectDir`);
      return null;
    }
    const canonical = validateExternalReplacement({
      projectDir: opts.projectDir,
      snapshot,
      segmentId,
      contract: discovery,
      targetClipId: fix.target_clip_id,
      targetBeatId: beatId,
      searchMode: fix.replacement!.search_mode,
      searchScore: fix.replacement!.search_score,
      reason: fix.replacement!.reason,
    });
    if (!canonical) {
      result.warnings.push(`Skipped ${fix.issue_id}: external replacement failed canonical snapshot validation: ${segmentId}`);
      return null;
    }
    return { canonical };
  }
  const candidate = existingEligibleCandidate(selects, segmentId, beatId);
  if (candidate) return { candidate };
  if (segmentIndex.byId.has(segmentId)) {
    result.warnings.push(`Skipped ${fix.issue_id}: external segment requires a canonical proposal snapshot: ${segmentId}`);
  } else {
    result.warnings.push(`Skipped ${fix.issue_id}: replacement segment_id not found in eligible selects: ${segmentId}`);
  }
  return null;
}

function discoveryWhy(fix: QAFix, summary?: string): string {
  const replacement = fix.replacement;
  return [
    `QA ${normalizeQASnapshotString(fix.issue_id, QA_FIX_SNAPSHOT_LIMITS.array_item_chars)}`,
    replacement ? normalizeQASnapshotString(replacement.reason, QA_FIX_SNAPSHOT_LIMITS.reason_chars) : undefined,
    replacement ? `search_score=${safeSearchScore(replacement.search_score)}` : undefined,
    `target_beat=${normalizeQASnapshotString(fix.target_beat_id, QA_FIX_SNAPSHOT_LIMITS.array_item_chars)}`,
    replacement?.snapshot?.canonical_source_ref,
    replacement?.snapshot?.summary
      ?? (summary ? normalizeQASnapshotString(summary, QA_FIX_SNAPSHOT_LIMITS.summary_chars) : undefined),
  ].filter(Boolean).join(" | ");
}

function discoveryEvidence(fix: QAFix): string[] {
  const replacement = fix.replacement;
  return [
    `qa_issue:${normalizeQASnapshotString(fix.issue_id, QA_FIX_SNAPSHOT_LIMITS.array_item_chars)}`,
    ...(replacement ? [
      `search_reason:${normalizeQASnapshotString(replacement.reason, QA_FIX_SNAPSHOT_LIMITS.reason_chars)}`,
      `search_score:${safeSearchScore(replacement.search_score)}`,
    ] : []),
    `target_beat:${normalizeQASnapshotString(fix.target_beat_id, QA_FIX_SNAPSHOT_LIMITS.array_item_chars)}`,
    ...(replacement?.snapshot ? [`canonical_source:${replacement.snapshot.canonical_source_ref}`] : []),
  ];
}

function safeSearchScore(score: number): string {
  return Number.isFinite(score) ? String(Math.round(score * 1_000) / 1_000) : "invalid";
}

function resolveTargetBeatId(fix: QAFix, timeline: TimelineIR): string | undefined {
  if (fix.target_beat_id) return fix.target_beat_id;
  if (fix.issue?.beat_id) return fix.issue.beat_id;
  return clipForFix(fix, timeline)?.beat_id;
}

function clipForFix(fix: QAFix, timeline: TimelineIR) {
  return primaryVideoClips(timeline).find((clip) => clip.clip_id === fix.target_clip_id);
}

function candidateForSegment(selects: SelectsCandidates, segmentId: string): Candidate | undefined {
  return selects.candidates.find((candidate) => candidate.segment_id === segmentId);
}

function refsForCandidate(candidate: Candidate): Set<string> {
  return new Set([candidate.segment_id, candidate.candidate_id, getCandidateRef(candidate)].filter((value): value is string => Boolean(value)));
}

function ensureCandidatePlan(beat: EditBlueprint["beats"][number]) {
  beat.candidate_plan ??= {};
  return beat.candidate_plan;
}

function updateBeatPlanForSwap(
  beat: EditBlueprint["beats"][number],
  oldRefs: Set<string>,
  replacementRef: string,
  oldPrimaryRef: string,
): boolean {
  const plan = ensureCandidatePlan(beat);
  const beforePrimary = plan.primary_candidate_ref;
  const beforeFallbacks = plan.fallback_candidate_refs ?? [];
  const nextFallbacks = [
    oldPrimaryRef,
    ...beforeFallbacks.filter((ref) => ref !== replacementRef && ref !== oldPrimaryRef && !oldRefs.has(ref)),
  ];

  plan.primary_candidate_ref = replacementRef;
  plan.fallback_candidate_refs = nextFallbacks.filter((ref, index, refs) => refs.indexOf(ref) === index);

  return beforePrimary !== plan.primary_candidate_ref || !arraysEqual(beforeFallbacks, plan.fallback_candidate_refs);
}

function removeBeatPlanRefs(beat: EditBlueprint["beats"][number], refs: Set<string>): boolean {
  const plan = beat.candidate_plan;
  if (!plan) return false;
  let changed = false;
  if (plan.primary_candidate_ref && refs.has(plan.primary_candidate_ref)) {
    delete plan.primary_candidate_ref;
    changed = true;
  }
  if (plan.fallback_candidate_refs) {
    const next = plan.fallback_candidate_refs.filter((ref) => !refs.has(ref));
    if (!arraysEqual(plan.fallback_candidate_refs, next)) {
      plan.fallback_candidate_refs = next;
      changed = true;
    }
  }
  return changed;
}

function explicitReorderRefs(fix: QAFix): string[] {
  const payload = fix as QAFix & ReorderPayload;
  return payload.candidate_order
    ?? payload.candidate_refs
    ?? payload.reorder?.candidate_order
    ?? payload.reorder?.candidate_refs
    ?? [];
}

function mergeExplicitOrder(desired: string[], existing: string[]): string[] {
  const existingSet = new Set(existing);
  const ordered = desired.filter((ref, index, refs) => existingSet.has(ref) && refs.indexOf(ref) === index);
  return [...ordered, ...existing.filter((ref) => !ordered.includes(ref))];
}

function fallbackReorder(fix: QAFix, timeline: TimelineIR, existing: string[]): string[] {
  const targetSegment = clipForFix(fix, timeline)?.segment_id;
  const replacementId = fix.replacement?.segment_id;
  const payload = fix as QAFix & ReorderPayload;
  if (replacementId && existing.includes(replacementId)) {
    return [replacementId, ...existing.filter((ref) => ref !== replacementId)];
  }
  if (targetSegment && payload.before_segment_id && existing.includes(targetSegment) && existing.includes(payload.before_segment_id)) {
    return moveBefore(existing, targetSegment, payload.before_segment_id);
  }
  if (targetSegment && payload.after_segment_id && existing.includes(targetSegment) && existing.includes(payload.after_segment_id)) {
    return moveAfter(existing, targetSegment, payload.after_segment_id);
  }
  return existing;
}

function beatHasOpenCapacity(beat: EditBlueprint["beats"][number], timeline: TimelineIR): boolean {
  const usedFrames = primaryVideoClips(timeline)
    .filter((clip) => clip.beat_id === beat.id)
    .reduce((sum, clip) => sum + Math.max(0, clip.timeline_duration_frames), 0);
  return usedFrames > 0 && usedFrames < beat.target_duration_frames;
}

function moveBefore(refs: string[], moving: string, anchor: string): string[] {
  const without = refs.filter((ref) => ref !== moving);
  const index = without.indexOf(anchor);
  if (index < 0) return refs;
  return [...without.slice(0, index), moving, ...without.slice(index)];
}

function moveAfter(refs: string[], moving: string, anchor: string): string[] {
  const without = refs.filter((ref) => ref !== moving);
  const index = without.indexOf(anchor);
  if (index < 0) return refs;
  return [...without.slice(0, index + 1), moving, ...without.slice(index + 1)];
}

function targetSegmentUsedInOtherBeats(timeline: TimelineIR, segmentId: string, beatId: string): boolean {
  return primaryVideoClips(timeline).some((clip) => clip.segment_id === segmentId && clip.beat_id !== beatId);
}

function includeBeat(values: string[] | undefined, beatId: string): string[] {
  const next = values ? [...values] : [];
  if (!next.includes(beatId)) next.push(beatId);
  return next;
}

function includeValue(values: string[] | undefined, value: string): string[] {
  const next = values ? [...values] : [];
  if (!next.includes(value)) next.push(value);
  return next;
}

function concreteTrimHint(hint: TrimHint, candidate: Candidate): TrimHint {
  const next: TrimHint = { ...hint };
  const sourceDuration = Math.max(1, candidate.src_out_us - candidate.src_in_us);
  if (next.preferred_duration_us === undefined) {
    if (next.recommended_in_us !== undefined && next.recommended_out_us !== undefined && next.recommended_out_us > next.recommended_in_us) {
      next.preferred_duration_us = next.recommended_out_us - next.recommended_in_us;
    } else {
      next.preferred_duration_us = sourceDuration;
    }
  }
  next.preferred_duration_us = clampInteger(next.preferred_duration_us, 1, sourceDuration);
  return next;
}

function isMicroClipIssue(fix: QAFix): boolean {
  return fix.issue?.type === "micro_clip" || fix.issue?.source_category === "micro_clip";
}

function verifyTimelineChange(
  timeline: TimelineIR,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  opts: ApplyFixesOptions,
  result: ApplyResult,
): void {
  if (!opts.recompile || result.applied.length === 0) return;
  try {
    const nextTimeline = opts.recompile(selects, blueprint);
    result.timeline_changed = !arraysEqual(timelineClipSignature(timeline), timelineClipSignature(nextTimeline));
    if (!result.timeline_changed) {
      result.warnings.push("Applied fixes did not change the compiled timeline clip list");
    }
  } catch (error) {
    result.warnings.push(`Applied fixes could not be verified against a recompiled timeline: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function timelineClipSignature(timeline: TimelineIR): string[] {
  return (timeline.tracks.video ?? [])
    .flatMap((track) =>
      track.clips.map((clip) => [
        track.track_id,
        clip.beat_id,
        clip.segment_id,
        clip.asset_id,
        clip.src_in_us,
        clip.src_out_us,
        clip.timeline_in_frame,
        clip.timeline_duration_frames,
      ].join(":"))
    )
    .sort((left, right) => left.localeCompare(right));
}

function arraysEqual(left: string[] = [], right: string[] = []): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampInteger(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  return Math.max(min, Math.min(max, rounded));
}
