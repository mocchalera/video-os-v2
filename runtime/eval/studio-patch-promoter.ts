import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  Candidate,
  ClipOutput,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "../artifacts/types.js";
import { buildCandidateRefMap, getCandidateRef } from "../compiler/candidate-ref.js";
import type { PatchOperation, ReviewPatch } from "../compiler/patch.js";

type StudioPatchOperation = PatchOperation & { with_candidate_ref?: string };

interface PatchHistoryIndex {
  records?: PatchHistoryRecord[];
}

interface PatchHistoryRecord {
  patch_path: string;
  timeline_backup_path: string;
}

export interface StudioPatchPromotionResult {
  applied_ops: number;
  skipped_ops: number;
  selects_modified: boolean;
  blueprint_modified: boolean;
  modified_beat_ids: string[];
  warnings: string[];
  dry_run: boolean;
}

export interface PromoteStudioPatchInput {
  patch: ReviewPatch;
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
  currentTimeline: TimelineIR;
  backupTimeline?: TimelineIR;
  dryRun?: boolean;
}

export interface PromoteStudioPatchFileOptions {
  dryRun?: boolean;
  backupTimelinePath?: string;
}

export function promoteStudioPatch(input: PromoteStudioPatchInput): {
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
  result: StudioPatchPromotionResult;
} {
  const workingSelects = input.dryRun ? structuredClone(input.selects) : input.selects;
  const workingBlueprint = input.dryRun ? structuredClone(input.blueprint) : input.blueprint;
  const result: StudioPatchPromotionResult = {
    applied_ops: 0,
    skipped_ops: 0,
    selects_modified: false,
    blueprint_modified: false,
    modified_beat_ids: [],
    warnings: [],
    dry_run: input.dryRun ?? false,
  };
  const modifiedBeatIds = new Set<string>();

  for (const op of input.patch.operations as StudioPatchOperation[]) {
    const applied = promoteOperation(
      op,
      workingSelects,
      workingBlueprint,
      input.currentTimeline,
      input.backupTimeline,
      result,
      modifiedBeatIds,
    );
    if (applied) {
      result.applied_ops += 1;
    } else {
      result.skipped_ops += 1;
    }
  }

  result.modified_beat_ids = [...modifiedBeatIds].sort((a, b) => a.localeCompare(b));
  return { selects: workingSelects, blueprint: workingBlueprint, result };
}

export function promoteStudioPatchFiles(
  projectDir: string,
  patchPath: string,
  options: PromoteStudioPatchFileOptions = {},
): StudioPatchPromotionResult {
  const absProject = path.resolve(projectDir);
  const absPatch = path.resolve(patchPath);
  const selectsPath = path.join(absProject, "04_plan", "selects_candidates.yaml");
  const blueprintPath = path.join(absProject, "04_plan", "edit_blueprint.yaml");
  const currentTimelinePath = path.join(absProject, "05_timeline", "timeline.json");

  const patch = readJSON<ReviewPatch>(absPatch);
  const selects = readYaml<SelectsCandidates>(selectsPath);
  const blueprint = readYaml<EditBlueprint>(blueprintPath);
  const currentTimeline = readJSON<TimelineIR>(currentTimelinePath);
  const backupTimelinePath = options.backupTimelinePath ?? backupTimelinePathForPatch(absProject, absPatch);
  const backupTimeline = backupTimelinePath && fs.existsSync(backupTimelinePath)
    ? readJSON<TimelineIR>(backupTimelinePath)
    : undefined;

  const promoted = promoteStudioPatch({
    patch,
    selects,
    blueprint,
    currentTimeline,
    backupTimeline,
    dryRun: options.dryRun,
  });

  if (!options.dryRun) {
    if (promoted.result.selects_modified) writeYaml(selectsPath, promoted.selects);
    if (promoted.result.blueprint_modified) writeYaml(blueprintPath, promoted.blueprint);
  }
  return promoted.result;
}

function promoteOperation(
  op: StudioPatchOperation,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  currentTimeline: TimelineIR,
  backupTimeline: TimelineIR | undefined,
  result: StudioPatchPromotionResult,
  modifiedBeatIds: Set<string>,
): boolean {
  switch (op.op) {
    case "replace_segment":
      return promoteReplaceSegment(op, selects, blueprint, currentTimeline, backupTimeline, result, modifiedBeatIds);
    case "remove_segment":
      return promoteRemoveSegment(op, selects, blueprint, currentTimeline, backupTimeline, result, modifiedBeatIds);
    default:
      result.warnings.push(`Skipped ${op.op}: promotion currently supports replace_segment and remove_segment only.`);
      return false;
  }
}

function promoteReplaceSegment(
  op: StudioPatchOperation,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  currentTimeline: TimelineIR,
  backupTimeline: TimelineIR | undefined,
  result: StudioPatchPromotionResult,
  modifiedBeatIds: Set<string>,
): boolean {
  if (!op.target_clip_id || !op.with_segment_id) {
    result.warnings.push("Skipped replace_segment: missing target_clip_id or with_segment_id.");
    return false;
  }

  const targetClip = findClip(backupTimeline, op.target_clip_id) ?? findClip(currentTimeline, op.target_clip_id);
  if (!targetClip?.beat_id) {
    result.warnings.push(`Skipped replace_segment: target clip beat could not be resolved: ${op.target_clip_id}.`);
    return false;
  }

  const beat = blueprint.beats.find((item) => item.id === targetClip.beat_id);
  if (!beat) {
    result.warnings.push(`Skipped replace_segment: beat not found in edit_blueprint.yaml: ${targetClip.beat_id}.`);
    return false;
  }

  const candidateMap = buildCandidateRefMap(selects.candidates ?? []);
  const replacementCandidate = candidateMap.get(op.with_candidate_ref ?? "") ?? candidateForSegment(selects, op.with_segment_id);
  if (!replacementCandidate) {
    result.warnings.push(`Skipped replace_segment: replacement candidate not found: ${op.with_segment_id}.`);
    return false;
  }

  const plan = ensureCandidatePlan(beat);
  const beforePrimary = plan.primary_candidate_ref;
  const beforeFallbacks = plan.fallback_candidate_refs ?? [];
  const oldPrimaryRef = beforePrimary ?? targetClip.segment_id;
  const replacementRef = op.with_candidate_ref && candidateMap.has(op.with_candidate_ref)
    ? op.with_candidate_ref
    : refForCandidate(replacementCandidate, op.with_segment_id);

  plan.primary_candidate_ref = replacementRef;
  plan.fallback_candidate_refs = [
    ...(oldPrimaryRef && oldPrimaryRef !== replacementRef ? [oldPrimaryRef] : []),
    ...beforeFallbacks,
  ].filter((ref, index, refs) => ref !== replacementRef && refs.indexOf(ref) === index);

  const changed = beforePrimary !== plan.primary_candidate_ref || !arraysEqual(beforeFallbacks, plan.fallback_candidate_refs);
  if (!changed) {
    result.warnings.push(`Skipped replace_segment: candidate_plan already promotes ${replacementRef}.`);
    return false;
  }

  result.blueprint_modified = true;
  modifiedBeatIds.add(beat.id);
  return true;
}

function promoteRemoveSegment(
  op: StudioPatchOperation,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  currentTimeline: TimelineIR,
  backupTimeline: TimelineIR | undefined,
  result: StudioPatchPromotionResult,
  modifiedBeatIds: Set<string>,
): boolean {
  if (!op.target_clip_id) {
    result.warnings.push("Skipped remove_segment: missing target_clip_id.");
    return false;
  }

  const targetClip = findClip(backupTimeline, op.target_clip_id) ?? findClip(currentTimeline, op.target_clip_id);
  if (!targetClip?.beat_id) {
    result.warnings.push(`Skipped remove_segment: target clip is not present in current timeline or backup: ${op.target_clip_id}.`);
    return false;
  }

  const beat = blueprint.beats.find((item) => item.id === targetClip.beat_id);
  if (!beat) {
    result.warnings.push(`Skipped remove_segment: beat not found in edit_blueprint.yaml: ${targetClip.beat_id}.`);
    return false;
  }

  const candidate = candidateForSegment(selects, targetClip.segment_id);
  if (!candidate) {
    result.warnings.push(`Skipped remove_segment: candidate not found for segment: ${targetClip.segment_id}.`);
    return false;
  }

  const refs = refsForCandidate(candidate);
  let changed = false;
  if (candidate.role !== "reject") {
    candidate.role = "reject";
    result.selects_modified = true;
    changed = true;
  }
  if (removeBeatPlanRefs(beat, refs)) {
    result.blueprint_modified = true;
    changed = true;
  }

  if (!changed) {
    result.warnings.push(`Skipped remove_segment: ${targetClip.segment_id} was already rejected and absent from candidate_plan.`);
    return false;
  }

  modifiedBeatIds.add(beat.id);
  return true;
}

function findClip(timeline: TimelineIR | undefined, clipID: string): ClipOutput | undefined {
  if (!timeline) return undefined;
  const tracks = [
    ...(timeline.tracks.video ?? []),
    ...(timeline.tracks.audio ?? []),
  ];
  for (const track of tracks) {
    const clip = track.clips.find((item: ClipOutput) => item.clip_id === clipID);
    if (clip) return clip;
  }
  return undefined;
}

function candidateForSegment(selects: SelectsCandidates, segmentID: string): Candidate | undefined {
  return (selects.candidates ?? []).find((candidate) => candidate.segment_id === segmentID);
}

function refForCandidate(candidate: Candidate, fallbackSegmentID: string): string {
  const ref = getCandidateRef(candidate);
  return ref.startsWith("legacy:") ? fallbackSegmentID : ref;
}

function refsForCandidate(candidate: Candidate): Set<string> {
  return new Set([
    candidate.segment_id,
    candidate.candidate_id,
    getCandidateRef(candidate),
  ].filter((value): value is string => Boolean(value)));
}

function ensureCandidatePlan(beat: EditBlueprint["beats"][number]) {
  beat.candidate_plan ??= {};
  return beat.candidate_plan;
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
    const nextFallbacks = plan.fallback_candidate_refs.filter((ref) => !refs.has(ref));
    if (!arraysEqual(plan.fallback_candidate_refs, nextFallbacks)) {
      plan.fallback_candidate_refs = nextFallbacks;
      changed = true;
    }
  }
  return changed;
}

function arraysEqual<T>(left: T[] = [], right: T[] = []): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readJSON<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function readYaml<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return parseYaml(fs.readFileSync(filePath, "utf-8")) as T;
}

function writeYaml(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, stringifyYaml(data, { lineWidth: 0 }), "utf-8");
  fs.renameSync(tempPath, filePath);
}

function backupTimelinePathForPatch(projectDir: string, patchPath: string): string | undefined {
  const indexPath = path.join(projectDir, "06_review", "patch_history", "index.json");
  if (!fs.existsSync(indexPath)) return undefined;
  const index = readJSON<PatchHistoryIndex>(indexPath);
  const relPatchPath = normalizeProjectPath(path.relative(projectDir, patchPath));
  const record = (index.records ?? []).find((item) => {
    const recorded = normalizeProjectPath(item.patch_path);
    return recorded === relPatchPath || path.resolve(projectDir, recorded) === patchPath;
  });
  return record?.timeline_backup_path
    ? path.resolve(projectDir, record.timeline_backup_path)
    : undefined;
}

function normalizeProjectPath(value: string): string {
  return value.split(path.sep).join("/");
}
