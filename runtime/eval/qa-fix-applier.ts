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

export interface ApplyResult {
  applied: QAFix[];
  skipped: QAFix[];
  selects_modified: boolean;
  blueprint_modified: boolean;
  warnings: string[];
  modified_beat_ids: string[];
}

export interface ApplyFixesOptions {
  dryRun?: boolean;
  projectDir?: string;
  segmentIds?: Iterable<string>;
  segments?: Array<Pick<SegmentItem, "segment_id" | "asset_id" | "src_in_us" | "src_out_us"> & Partial<SegmentItem>>;
}

interface SegmentIndex {
  loaded: boolean;
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

  const result: ApplyResult = {
    applied: [],
    skipped: [],
    selects_modified: false,
    blueprint_modified: false,
    warnings: [],
    modified_beat_ids: [],
  };
  const modifiedBeatIds = new Set<string>();

  for (const fix of fixes) {
    const applied = applyOneFix(fix, workingSelects, workingBlueprint, timeline, segmentIndex, result, modifiedBeatIds);
    if (applied) {
      result.applied.push(fix);
    } else {
      result.skipped.push(fix);
    }
  }

  result.modified_beat_ids = [...modifiedBeatIds].sort((a, b) => a.localeCompare(b));
  return result;
}

function applyOneFix(
  fix: QAFix,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  timeline: TimelineIR,
  segmentIndex: SegmentIndex,
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
      return applySwap(fix, selects, beat, timeline, segmentIndex, result, modifiedBeatIds);
    case "reorder":
      return applyReorder(fix, beat, timeline, result, modifiedBeatIds);
    case "trim":
      return applyTrim(fix, selects, timeline, result, modifiedBeatIds, beatId);
    case "insert":
      return applyInsert(fix, selects, beat, segmentIndex, result, modifiedBeatIds);
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
  result: ApplyResult,
  modifiedBeatIds: Set<string>,
): boolean {
  const replacementId = fix.replacement?.segment_id;
  if (!replacementId) {
    result.warnings.push(`Skipped ${fix.issue_id}: swap fix is missing replacement.segment_id`);
    return false;
  }
  if (!replacementExists(replacementId, selects, segmentIndex)) {
    result.warnings.push(`Skipped ${fix.issue_id}: replacement segment_id not found in segments/selects: ${replacementId}`);
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

  const oldRefs = refsForCandidate(targetCandidate);
  const replacementCandidate = candidateForSegment(selects, replacementId);
  const replacementSegment = segmentIndex.byId.get(replacementId);
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

  if (updateBeatPlanRefs(beat, oldRefs, replacementId)) {
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
  const existing = currentPlanRefs(plan);
  if (existing.length === 0) {
    result.warnings.push(`Skipped ${fix.issue_id}: beat candidate_plan is empty: ${beat.id}`);
    return false;
  }

  const desired = explicitReorderRefs(fix);
  const nextRefs = desired.length > 0
    ? mergeExplicitOrder(desired, existing)
    : fallbackReorder(fix, timeline, existing);
  if (nextRefs.length === 0 || arraysEqual(existing, nextRefs)) {
    result.warnings.push(`Skipped ${fix.issue_id}: reorder produced no candidate_plan change`);
    return false;
  }

  setPlanRefs(plan, nextRefs);
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
  result.selects_modified = true;
  modifiedBeatIds.add(beatId);
  return true;
}

function applyInsert(
  fix: QAFix,
  selects: SelectsCandidates,
  beat: EditBlueprint["beats"][number],
  segmentIndex: SegmentIndex,
  result: ApplyResult,
  modifiedBeatIds: Set<string>,
): boolean {
  const replacementId = fix.replacement?.segment_id;
  if (!replacementId) {
    result.warnings.push(`Skipped ${fix.issue_id}: insert fix is missing replacement.segment_id`);
    return false;
  }
  if (!replacementExists(replacementId, selects, segmentIndex)) {
    result.warnings.push(`Skipped ${fix.issue_id}: replacement segment_id not found in segments/selects: ${replacementId}`);
    return false;
  }

  let changed = false;
  if (!candidateForSegment(selects, replacementId)) {
    const segment = segmentIndex.byId.get(replacementId);
    if (!segment) {
      result.warnings.push(`Skipped ${fix.issue_id}: cannot materialize inserted candidate without segment metadata: ${replacementId}`);
      return false;
    }
    selects.candidates.push(candidateFromSegment(selects.project_id, segment, fix, beat.id));
    result.selects_modified = true;
    changed = true;
  }

  const plan = ensureCandidatePlan(beat);
  const fallbackRefs = plan.fallback_candidate_refs ?? [];
  if (plan.primary_candidate_ref !== replacementId && !fallbackRefs.includes(replacementId)) {
    plan.fallback_candidate_refs = [...fallbackRefs, replacementId];
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
      ?? replacementSegment?.summary
      ?? `QA replacement for ${targetCandidate.segment_id}`,
    risks: replacementCandidate?.risks ? [...replacementCandidate.risks] : [...(targetCandidate.risks ?? [])],
    confidence: replacementCandidate?.confidence ?? fix.replacement?.search_score ?? targetCandidate.confidence,
    quality_flags: replacementCandidate?.quality_flags ?? replacementSegment?.quality_flags ?? [],
    evidence: [
      ...(replacementCandidate?.evidence ?? []),
      ...(targetCandidate.evidence ?? []),
      `qa_fix:${fix.issue_id}`,
      ...(fix.replacement?.reason ? [fix.replacement.reason] : []),
    ],
    eligible_beats: includeBeat(replacementCandidate?.eligible_beats ?? targetCandidate.eligible_beats, beatId),
    transcript_excerpt: replacementCandidate?.transcript_excerpt ?? replacementSegment?.transcript_excerpt ?? targetCandidate.transcript_excerpt,
  };
  base.candidate_id = generateCandidateId(projectId, base);
  return base;
}

function candidateFromSegment(
  projectId: string,
  segment: SegmentLike,
  fix: QAFix,
  beatId: string,
): Candidate {
  const srcInUs = segment.src_in_us ?? 0;
  const candidate: Candidate = {
    segment_id: segment.segment_id,
    asset_id: segment.asset_id ?? `AST_${segment.segment_id}`,
    src_in_us: srcInUs,
    src_out_us: segment.src_out_us ?? srcInUs + 1_000_000,
    role: "support",
    why_it_matches: segment.summary ?? fix.replacement?.reason ?? `QA inserted candidate for ${fix.issue_id}`,
    risks: [],
    confidence: fix.replacement?.search_score ?? 0.5,
    quality_flags: segment.quality_flags ?? [],
    evidence: [`qa_fix:${fix.issue_id}`, ...(fix.replacement?.reason ? [fix.replacement.reason] : [])],
    eligible_beats: [beatId],
    transcript_excerpt: segment.transcript_excerpt,
  };
  candidate.candidate_id = generateCandidateId(projectId, candidate);
  return candidate;
}

function computedTrimHint(
  fix: QAFix,
  candidate: Candidate,
  targetClip: ClipOutput,
  timeline: TimelineIR,
): TrimHint {
  const payload = fix as QAFix & TrimPayload;
  const authored = payload.new_trim_hint ?? payload.trim_hint;
  if (authored) return authored;

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
  let loaded = false;

  if (opts.segments) {
    loaded = true;
    for (const segment of opts.segments) {
      byId.set(segment.segment_id, segment);
    }
  }
  if (opts.segmentIds) {
    loaded = true;
    for (const segmentId of opts.segmentIds) {
      if (!byId.has(segmentId)) byId.set(segmentId, { segment_id: segmentId });
    }
  }
  if (opts.projectDir) {
    const segmentsPath = path.join(opts.projectDir, "03_analysis", "segments.json");
    if (fs.existsSync(segmentsPath)) {
      loaded = true;
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
        loaded = true;
      }
    }
  }

  return { loaded, byId };
}

function replacementExists(segmentId: string, selects: SelectsCandidates, segmentIndex: SegmentIndex): boolean {
  if (segmentIndex.loaded) return segmentIndex.byId.has(segmentId);
  return Boolean(candidateForSegment(selects, segmentId));
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

function currentPlanRefs(plan: NonNullable<EditBlueprint["beats"][number]["candidate_plan"]>): string[] {
  return [
    ...(plan.primary_candidate_ref ? [plan.primary_candidate_ref] : []),
    ...(plan.fallback_candidate_refs ?? []),
  ].filter((ref, index, refs) => refs.indexOf(ref) === index);
}

function setPlanRefs(
  plan: NonNullable<EditBlueprint["beats"][number]["candidate_plan"]>,
  refs: string[],
): void {
  const deduped = refs.filter((ref, index) => refs.indexOf(ref) === index);
  plan.primary_candidate_ref = deduped[0];
  plan.fallback_candidate_refs = deduped.slice(1);
}

function updateBeatPlanRefs(beat: EditBlueprint["beats"][number], oldRefs: Set<string>, replacementRef: string): boolean {
  const plan = beat.candidate_plan;
  if (!plan) return false;
  let changed = false;
  if (plan.primary_candidate_ref && oldRefs.has(plan.primary_candidate_ref)) {
    plan.primary_candidate_ref = replacementRef;
    changed = true;
  }
  if (plan.fallback_candidate_refs) {
    const next = plan.fallback_candidate_refs.map((ref) => oldRefs.has(ref) ? replacementRef : ref);
    const deduped = next.filter((ref, index) => next.indexOf(ref) === index);
    if (!arraysEqual(plan.fallback_candidate_refs, deduped)) {
      plan.fallback_candidate_refs = deduped;
      changed = true;
    }
  }
  return changed;
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
