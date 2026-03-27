/**
 * Review & Patch API routes (Phase 2b-1).
 *
 * GET  /api/projects/:id/ai/review-report  — Return review_report.yaml as JSON
 * GET  /api/projects/:id/ai/review-patch   — Return review_patch.json (with safety filter)
 * POST /api/projects/:id/ai/patches/apply  — Apply selected patch operations (server authoritative)
 */

import Ajv from "ajv";
import { Router } from "express";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import { computeTimelineRevision, normalizeTimelineServer } from "./timeline.js";
import { getTimelineValidator } from "../middleware/validation.js";
import { validateTimeline } from "../../shared/timeline-validation.js";
import {
  safeProjectDir,
  acquireProjectLock,
  releaseProjectLock,
  getProjectLockKind,
  atomicWriteFileSync,
} from "../utils.js";
import { getReconcileStatus } from "../services/reconcile-status.js";
import type { NotifyWriteFn } from "./timeline.js";

// ── Helpers ──────────────────────────────────────────────────────────

function fileRevision(content: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 16);
  return `sha256:${hash}`;
}

// ── Patch schema validator (lazy) ────────────────────────────────────

let cachedPatchValidate: ReturnType<Ajv["compile"]> | null = null;

function getPatchValidator(): ReturnType<Ajv["compile"]> | null {
  if (cachedPatchValidate) return cachedPatchValidate;

  const schemaPath = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "schemas",
    "review-patch.schema.json",
  );
  if (!fs.existsSync(schemaPath)) return null;

  try {
    const schemaText = fs.readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(schemaText);
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedPatchValidate = ajv.compile(schema);
    return cachedPatchValidate;
  } catch {
    return null;
  }
}

// ── Safety filter ────────────────────────────────────────────────────

interface PatchOp {
  op: string;
  target_clip_id?: string;
  with_segment_id?: string;
  reason?: string;
  [key: string]: unknown;
}

interface PatchDoc {
  timeline_version: string;
  operations: PatchOp[];
}

interface FilteredOp extends PatchOp {
  /** Index of this operation in the original patch.operations array. */
  original_index: number;
}

interface FilteredPatchDoc {
  timeline_version: string;
  operations: FilteredOp[];
}

interface SafetyResult {
  safe: boolean;
  rejected_ops: number[];
  filtered_patch: FilteredPatchDoc;
}

const OPS_REQUIRING_TARGET = new Set([
  "replace_segment",
  "trim_segment",
  "move_segment",
  "remove_segment",
  "change_audio_policy",
]);

function validatePatchSafety(patch: PatchDoc): SafetyResult {
  const rejected: number[] = [];
  const accepted: FilteredOp[] = [];

  for (let i = 0; i < patch.operations.length; i++) {
    const op = patch.operations[i];
    // Reject ops missing required target_clip_id
    if (OPS_REQUIRING_TARGET.has(op.op) && !op.target_clip_id) {
      rejected.push(i);
      continue;
    }
    // Reject replace/insert without with_segment_id
    if (
      (op.op === "replace_segment" || op.op === "insert_segment") &&
      !op.with_segment_id
    ) {
      rejected.push(i);
      continue;
    }
    accepted.push({ ...op, original_index: i });
  }

  return {
    safe: rejected.length === 0,
    rejected_ops: rejected,
    filtered_patch: {
      timeline_version: patch.timeline_version,
      operations: accepted,
    },
  };
}

// ── Timeline clip finder ─────────────────────────────────────────────

interface TrackData {
  track_id: string;
  clips: Array<Record<string, unknown>>;
}

interface TracksData {
  video: TrackData[];
  audio: TrackData[];
}

function findClipInTimeline(
  tracks: TracksData,
  clipId: string,
): { track: TrackData; clipIndex: number; clip: Record<string, unknown> } | null {
  for (const group of [tracks.video, tracks.audio]) {
    for (const track of group) {
      const idx = track.clips.findIndex((c) => c.clip_id === clipId);
      if (idx !== -1) {
        return { track, clipIndex: idx, clip: track.clips[idx] };
      }
    }
  }
  return null;
}

// ── Schema-compliant operation applicator ─────────────────────────────
// Uses target_clip_id / with_segment_id / new_src_in_us / reason etc.
// per review-patch.schema.json. Future: import runtime/compiler/patch.ts.

function applyOperation(
  timeline: Record<string, unknown>,
  op: PatchOp,
): boolean {
  const tracks = timeline.tracks as TracksData;

  switch (op.op) {
    case "replace_segment": {
      if (!op.target_clip_id || !op.with_segment_id) return false;

      const found = findClipInTimeline(tracks, op.target_clip_id);
      if (!found) return false;

      const clip = found.clip;
      clip.segment_id = op.with_segment_id;
      if (op.new_src_in_us != null) clip.src_in_us = op.new_src_in_us;
      if (op.new_src_out_us != null) clip.src_out_us = op.new_src_out_us;
      if (op.with_candidate_ref != null) clip.candidate_ref = op.with_candidate_ref;
      clip.motivation = `[patch] ${op.reason ?? "replace_segment"}`;
      if (op.confidence != null) clip.confidence = op.confidence;
      if (op.role != null) clip.role = op.role;
      return true;
    }

    case "trim_segment": {
      if (!op.target_clip_id) return false;

      const found = findClipInTimeline(tracks, op.target_clip_id);
      if (!found) return false;

      const clip = found.clip;
      if (op.new_src_in_us != null) clip.src_in_us = op.new_src_in_us;
      if (op.new_src_out_us != null) clip.src_out_us = op.new_src_out_us;
      if (op.new_timeline_in_frame != null) clip.timeline_in_frame = op.new_timeline_in_frame;
      if (op.new_duration_frames != null) clip.timeline_duration_frames = op.new_duration_frames;
      clip.motivation = `[patch:trim] ${op.reason ?? "trim_segment"}`;
      return true;
    }

    case "move_segment": {
      if (!op.target_clip_id) return false;

      const found = findClipInTimeline(tracks, op.target_clip_id);
      if (!found) return false;

      const clip = found.clip;
      if (op.new_timeline_in_frame != null) clip.timeline_in_frame = op.new_timeline_in_frame;
      if (op.new_duration_frames != null) clip.timeline_duration_frames = op.new_duration_frames;
      clip.motivation = `[patch:move] ${op.reason ?? "move_segment"}`;
      return true;
    }

    case "insert_segment": {
      // insert requires with_segment_id; target track is inferred from role
      if (!op.with_segment_id) return false;

      const role = (op.role as string) ?? "support";
      const isAudio = role === "dialogue" || role === "music" || role === "bgm";
      const trackGroup = isAudio ? tracks.audio : tracks.video;
      const track = trackGroup[0];
      if (!track) return false;

      // Generate clip_id
      let maxNum = 0;
      for (const group of [tracks.video, tracks.audio]) {
        for (const t of group) {
          for (const c of t.clips) {
            const m = String(c.clip_id ?? "").match(/^CLP_(\d+)$/);
            if (m) {
              const n = parseInt(m[1], 10);
              if (n > maxNum) maxNum = n;
            }
          }
        }
      }
      const newClipId = `CLP_${String(maxNum + 1).padStart(4, "0")}`;

      track.clips.push({
        clip_id: newClipId,
        segment_id: op.with_segment_id,
        asset_id: "",
        src_in_us: op.new_src_in_us ?? 0,
        src_out_us: op.new_src_out_us ?? 1000000,
        timeline_in_frame: op.new_timeline_in_frame ?? 0,
        timeline_duration_frames: op.new_duration_frames ?? 24,
        role,
        motivation: `[patch:insert] ${op.reason ?? "insert_segment"}`,
        beat_id: op.beat_id ?? "",
        confidence: op.confidence ?? 0.5,
      });

      track.clips.sort((a, b) => {
        const diff = (a.timeline_in_frame as number) - (b.timeline_in_frame as number);
        if (diff !== 0) return diff;
        return String(a.clip_id).localeCompare(String(b.clip_id));
      });

      return true;
    }

    case "remove_segment": {
      if (!op.target_clip_id) return false;

      const found = findClipInTimeline(tracks, op.target_clip_id);
      if (!found) return false;

      found.track.clips.splice(found.clipIndex, 1);
      return true;
    }

    case "change_audio_policy": {
      if (!op.target_clip_id) return false;

      const found = findClipInTimeline(tracks, op.target_clip_id);
      if (!found) return false;

      if (op.audio_policy) {
        found.clip.audio_policy = {
          ...((found.clip.audio_policy as Record<string, unknown>) ?? {}),
          ...(op.audio_policy as Record<string, unknown>),
        };
      }
      return true;
    }

    case "add_marker":
    case "add_note": {
      const markers = (timeline.markers ?? []) as Array<Record<string, unknown>>;
      markers.push({
        frame: op.new_timeline_in_frame ?? 0,
        kind: op.op === "add_marker" ? "review" : "note",
        label: op.label ?? op.reason ?? "",
      });
      timeline.markers = markers;
      return true;
    }

    default:
      return false;
  }
}

// ── Router ───────────────────────────────────────────────────────────

export function createReviewRouter(
  projectsDir: string,
  notifyWrite?: NotifyWriteFn,
): Router {
  const router = Router();

  // GET /api/projects/:id/ai/review-report
  router.get("/:id/ai/review-report", (req, res) => {
    const projDir = safeProjectDir(projectsDir, req.params.id);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const reportPath = path.join(projDir, "06_review", "review_report.yaml");

    if (!fs.existsSync(reportPath)) {
      res.json({ exists: false, data: null });
      return;
    }

    try {
      const content = fs.readFileSync(reportPath, "utf-8");
      const data = yaml.load(content);
      res.json({
        exists: true,
        revision: fileRevision(content),
        data,
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to read review report",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/projects/:id/ai/review-patch
  router.get("/:id/ai/review-patch", (req, res) => {
    const projDir = safeProjectDir(projectsDir, req.params.id);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const patchPath = path.join(projDir, "06_review", "review_patch.json");

    if (!fs.existsSync(patchPath)) {
      res.json({ exists: false, data: null });
      return;
    }

    try {
      const content = fs.readFileSync(patchPath, "utf-8");
      const data = JSON.parse(content) as PatchDoc;

      // Schema validate (修正8)
      const validate = getPatchValidator();
      if (validate && !validate(data)) {
        res.status(422).json({
          error: "Review patch failed schema validation",
          details: validate.errors?.map((e) => ({
            path: e.instancePath,
            message: e.message,
          })),
        });
        return;
      }

      // Safety filter
      const safety = validatePatchSafety(data);

      res.json({
        exists: true,
        revision: fileRevision(content),
        data,
        safety,
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to read review patch",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/projects/:id/ai/context (修正R2-3)
  router.get("/:id/ai/context", (req, res) => {
    const projDir = safeProjectDir(projectsDir, req.params.id);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    try {
      // Timeline revision
      const timelinePath = path.join(projDir, "05_timeline", "timeline.json");
      let timelineRevision: string | null = null;
      let timelineVersion: string | null = null;
      if (fs.existsSync(timelinePath)) {
        const content = fs.readFileSync(timelinePath, "utf-8");
        timelineRevision = computeTimelineRevision(content);
        try {
          const tl = JSON.parse(content);
          timelineVersion = tl.version ?? null;
        } catch { /* ignore */ }
      }

      // Blueprint
      const blueprintPath = path.join(projDir, "04_plan", "edit_blueprint.yaml");
      let blueprint: { exists: boolean; revision?: string; data: unknown } = { exists: false, data: null };
      if (fs.existsSync(blueprintPath)) {
        const content = fs.readFileSync(blueprintPath, "utf-8");
        const data = yaml.load(content);
        blueprint = { exists: true, revision: fileRevision(content), data };
      }

      // Review report
      const reportPath = path.join(projDir, "06_review", "review_report.yaml");
      let reviewReport: { exists: boolean; revision?: string; data: unknown } = { exists: false, data: null };
      if (fs.existsSync(reportPath)) {
        const content = fs.readFileSync(reportPath, "utf-8");
        const data = yaml.load(content);
        reviewReport = { exists: true, revision: fileRevision(content), data };
      }

      // Review patch (with safety filter)
      const patchPath = path.join(projDir, "06_review", "review_patch.json");
      let reviewPatch: { exists: boolean; revision?: string; data: unknown; safety?: SafetyResult } = { exists: false, data: null };
      if (fs.existsSync(patchPath)) {
        const content = fs.readFileSync(patchPath, "utf-8");
        const data = JSON.parse(content) as PatchDoc;
        const safety = validatePatchSafety(data);
        reviewPatch = { exists: true, revision: fileRevision(content), data, safety };
      }

      // Reconcile status
      let status: { currentState: string; staleArtifacts: string[]; gates: Record<string, string> } | undefined;
      try {
        status = getReconcileStatus(projDir);
      } catch {
        // Non-fatal
      }

      res.json({
        project_id: req.params.id,
        timeline_revision: timelineRevision,
        timeline_version: timelineVersion,
        artifacts: {
          blueprint,
          review_report: reviewReport,
          review_patch: reviewPatch,
        },
        ...(status ? { status } : {}),
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to read AI context",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/projects/:id/ai/blueprint (修正R2-3)
  router.get("/:id/ai/blueprint", (req, res) => {
    const projDir = safeProjectDir(projectsDir, req.params.id);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const blueprintPath = path.join(projDir, "04_plan", "edit_blueprint.yaml");

    if (!fs.existsSync(blueprintPath)) {
      res.json({ exists: false, data: null });
      return;
    }

    try {
      const content = fs.readFileSync(blueprintPath, "utf-8");
      const data = yaml.load(content);
      res.json({
        exists: true,
        revision: fileRevision(content),
        data,
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to read blueprint",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /api/projects/:id/ai/patches/apply
  router.post("/:id/ai/patches/apply", (req, res) => {
    const projectId = req.params.id;
    const projDir = safeProjectDir(projectsDir, projectId);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const timelinePath = path.join(projDir, "05_timeline", "timeline.json");
    const patchPath = path.join(projDir, "06_review", "review_patch.json");

    // Validate request body
    const { base_timeline_revision, operation_indexes } = req.body as {
      base_timeline_revision?: string;
      operation_indexes?: number[];
    };

    if (!base_timeline_revision) {
      res.status(400).json({ error: "base_timeline_revision is required" });
      return;
    }

    if (
      !operation_indexes ||
      !Array.isArray(operation_indexes) ||
      operation_indexes.length === 0
    ) {
      res.status(400).json({ error: "operation_indexes must be a non-empty array" });
      return;
    }

    // Per-project filesystem advisory lock
    const existingLock = getProjectLockKind(projectId, projDir);
    if (existingLock) {
      res.status(423).json({
        error: "Project is locked",
        lock_kind: existingLock,
      });
      return;
    }

    if (!acquireProjectLock(projectId, "patching", projDir)) {
      res.status(423).json({ error: "Project is locked", lock_kind: "patching" });
      return;
    }

    try {
      // Check timeline exists
      if (!fs.existsSync(timelinePath)) {
        res.status(404).json({ error: "Timeline not found" });
        return;
      }

      // Check patch exists
      if (!fs.existsSync(patchPath)) {
        res.status(404).json({ error: "Review patch not found" });
        return;
      }

      // Revision check
      const timelineContent = fs.readFileSync(timelinePath, "utf-8");
      const currentRevision = computeTimelineRevision(timelineContent);
      if (base_timeline_revision !== currentRevision) {
        res.status(409).json({
          error: "Timeline revision mismatch",
          current_revision: currentRevision,
          client_revision: base_timeline_revision,
        });
        return;
      }

      // Load timeline and patch
      const timeline = JSON.parse(timelineContent);
      const patchContent = fs.readFileSync(patchPath, "utf-8");
      const patch = JSON.parse(patchContent) as PatchDoc;

      // Schema validate patch (修正8)
      const validate = getPatchValidator();
      if (validate && !validate(patch)) {
        res.status(422).json({
          error: "Review patch failed schema validation",
          details: validate.errors?.map((e) => ({
            path: e.instancePath,
            message: e.message,
          })),
        });
        return;
      }

      // Safety re-check
      const safety = validatePatchSafety(patch);
      const operations = patch.operations ?? [];

      // Validate operation_indexes
      const invalidIndexes = operation_indexes.filter(
        (i) => i < 0 || i >= operations.length,
      );
      if (invalidIndexes.length > 0) {
        res.status(400).json({
          error: "Invalid operation indexes",
          invalid: invalidIndexes,
          total_operations: operations.length,
        });
        return;
      }

      // Reject indexes that failed safety
      const safetyRejectedSet = new Set(safety.rejected_ops);

      // Apply selected operations
      const appliedOps: number[] = [];
      const rejectedOps: number[] = [];

      for (const idx of operation_indexes) {
        if (safetyRejectedSet.has(idx)) {
          rejectedOps.push(idx);
          continue;
        }
        const op = operations[idx];
        const applied = applyOperation(timeline, op);
        if (applied) {
          appliedOps.push(idx);
        } else {
          rejectedOps.push(idx);
        }
      }

      // Timeline schema validation after patch application (修正R2-1)
      const timelineValidate = getTimelineValidator();
      if (!timelineValidate(timeline)) {
        res.status(422).json({
          error: "Patched timeline failed schema validation",
          details: timelineValidate.errors?.map((e) => ({
            path: e.instancePath,
            message: e.message,
          })),
        });
        return;
      }

      // Server normalization: clip sort + timeline_duration_frames recalculation (修正R2-final)
      const normalized = normalizeTimelineServer(timeline);

      // Shared overlap & structural validation (client/server parity)
      const overlapIssues = validateTimeline(normalized);
      if (overlapIssues.length > 0) {
        res.status(400).json({
          error: "Patched timeline failed overlap/structural validation",
          details: overlapIssues.map((i) => ({ path: i.path, message: i.message })),
        });
        return;
      }

      // Backup and save (atomic: temp + rename)
      fs.copyFileSync(timelinePath, `${timelinePath}.bak`);
      const newContent = JSON.stringify(normalized, null, 2);
      atomicWriteFileSync(timelinePath, newContent);
      const newRevision = computeTimelineRevision(newContent);

      // Reconcile project state after patch apply
      let status: { currentState: string; staleArtifacts: string[]; gates: Record<string, string> } | undefined;
      try {
        status = getReconcileStatus(projDir);
      } catch {
        // Non-fatal
      }

      res.json({
        ok: true,
        timeline_revision_before: currentRevision,
        timeline_revision_after: newRevision,
        applied_operation_indexes: appliedOps,
        rejected_operations: rejectedOps,
        timeline: normalized,
        ...(status ? { status } : {}),
      });

      // Notify WatchHub of patch-apply mutation
      notifyWrite?.(projectId, "timeline.changed", "patch-apply");
    } catch (err) {
      res.status(500).json({
        error: "Failed to apply patch",
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      releaseProjectLock(projectId, projDir);
    }
  });

  // GET /api/projects/:id/ai/alternatives/:clipId
  // Returns ranked alternative candidates for a given clip from selects_candidates.yaml
  router.get("/:id/ai/alternatives/:clipId", (req, res) => {
    const projDir = safeProjectDir(projectsDir, req.params.id as string);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const clipId = req.params.clipId as string;

    // Load timeline to find the current clip
    const timelinePath = path.join(projDir, "05_timeline", "timeline.json");
    if (!fs.existsSync(timelinePath)) {
      res.status(404).json({ error: "Timeline not found" });
      return;
    }

    // Load selects_candidates
    const selectsPath = path.join(projDir, "04_plan", "selects_candidates.yaml");
    if (!fs.existsSync(selectsPath)) {
      res.json({ clip_id: clipId, alternatives: [] });
      return;
    }

    try {
      const timelineContent = fs.readFileSync(timelinePath, "utf-8");
      const timeline = JSON.parse(timelineContent);
      const tracks = timeline.tracks as TracksData;

      // Find the target clip
      const found = findClipInTimeline(tracks, clipId);
      if (!found) {
        res.status(404).json({ error: "Clip not found", clip_id: clipId });
        return;
      }

      const clip = found.clip;
      const clipSegmentId = clip.segment_id as string;
      const clipRole = (clip.role as string) ?? "";
      const clipBeatId = (clip.beat_id as string) ?? "";
      const clipCandidateRef = (clip.candidate_ref as string) ?? "";
      const clipFallbacks = (clip.fallback_segment_ids as string[]) ?? [];

      // Load selects
      const selectsContent = fs.readFileSync(selectsPath, "utf-8");
      const selectsData = yaml.load(selectsContent) as {
        candidates?: Array<{
          segment_id: string;
          asset_id: string;
          src_in_us: number;
          src_out_us: number;
          role: string;
          why_it_matches?: string;
          risks?: string[];
          confidence: number;
          semantic_rank?: number;
          quality_flags?: string[];
          eligible_beats?: string[];
          trim_hint?: { source_center_us: number; preferred_duration_us: number };
        }>;
      };

      const candidates = selectsData?.candidates ?? [];

      // Compute current clip duration for short-clip exclusion
      const clipDurationUs = (clip.src_out_us as number) - (clip.src_in_us as number);
      const minCandidateDurationUs = clipDurationUs * 0.5;

      // Exclude current clip's segment, reject role, and too-short candidates
      const eligible = candidates.filter((c) => {
        if (c.segment_id === clipSegmentId) return false;
        if (c.role === "reject") return false;
        // Exclude candidates whose duration < 50% of current clip
        const candidateDuration = c.src_out_us - c.src_in_us;
        if (candidateDuration < minCandidateDurationUs) return false;
        return true;
      });

      // Ranking per design doc section 4-4
      interface RankedCandidate {
        segment_id: string;
        asset_id: string;
        src_in_us: number;
        src_out_us: number;
        role: string;
        why_it_matches?: string;
        risks?: string[];
        confidence: number;
        semantic_rank?: number;
        quality_flags?: string[];
        eligible_beats?: string[];
        trim_hint?: { source_center_us: number; preferred_duration_us: number };
        rank_reason: string;
        rank_priority: number;
        thumbnail_url: string;
      }

      const ranked: RankedCandidate[] = eligible.map((c) => {
        let priority = 5;
        let reason = "fallback";

        // 1. candidate_ref match
        if (clipCandidateRef && c.segment_id === clipCandidateRef) {
          priority = 1;
          reason = "candidate_ref_match";
        }
        // 2. fallback_segment_ids
        else if (clipFallbacks.includes(c.segment_id)) {
          priority = 2;
          reason = "fallback_segment";
        }
        // 3. eligible_beats contains current beat
        else if (clipBeatId && c.eligible_beats?.includes(clipBeatId)) {
          priority = 3;
          reason = "eligible_beat_match";
        }
        // 4. same role
        else if (clipRole && c.role === clipRole) {
          priority = 4;
          reason = "same_role";
        }

        // Build thumbnail URL (matches GET /api/projects/:id/thumbnail/:assetId)
        const frameUs = c.trim_hint?.source_center_us ?? Math.round((c.src_in_us + c.src_out_us) / 2);
        const thumbnailUrl = `/api/projects/${req.params.id as string}/thumbnail/${encodeURIComponent(c.asset_id)}?frame_us=${frameUs}&width=160&height=90`;

        return {
          segment_id: c.segment_id,
          asset_id: c.asset_id,
          src_in_us: c.src_in_us,
          src_out_us: c.src_out_us,
          role: c.role,
          why_it_matches: c.why_it_matches,
          risks: c.risks,
          confidence: c.confidence,
          semantic_rank: c.semantic_rank,
          quality_flags: c.quality_flags,
          eligible_beats: c.eligible_beats,
          trim_hint: c.trim_hint,
          rank_reason: reason,
          rank_priority: priority,
          thumbnail_url: thumbnailUrl,
        };
      });

      // Sort by priority asc, then semantic_rank asc, then confidence desc
      ranked.sort((a, b) => {
        if (a.rank_priority !== b.rank_priority) return a.rank_priority - b.rank_priority;
        const aRank = a.semantic_rank ?? 999;
        const bRank = b.semantic_rank ?? 999;
        if (aRank !== bRank) return aRank - bRank;
        return b.confidence - a.confidence;
      });

      res.json({
        clip_id: clipId,
        current_segment_id: clipSegmentId,
        alternatives: ranked,
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to compute alternatives",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
