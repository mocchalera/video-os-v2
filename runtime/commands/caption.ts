/**
 * /caption Command
 *
 * Generates caption artifacts with editorial pipeline:
 * 1. Read caption_policy from blueprint
 * 2. Generate caption_source.json from transcripts (raw + cleanup)
 * 3. Run LLM editorial → caption_draft.json (injectable, fail-open)
 * 4. Apply word-level timing remap → timing metadata in draft
 * 5. Validate readiness gate (layout, density, timing)
 *
 * Artifact chain: caption_source.json → caption_draft.json
 * caption_approval.json is human-approved only; machine NEVER generates it.
 * Use approveCaptions() after human approval to create caption_approval.json.
 *
 * Allowed start states: approved (for full workflow), critique_ready (for draft only).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  initCommand,
  isCommandError,
  draftAndPromote,
  type CommandContext,
  type CommandError,
} from "./shared.js";
import type { ProjectState } from "../state/reconcile.js";
import type { TimelineIR } from "../artifacts/types.js";
import {
  generateCaptionSource,
  type CaptionPolicy,
  type CaptionSource,
  type TranscriptArtifact,
} from "../caption/segmenter.js";
import { buildTextOverlays, type TextOverlayInput } from "../caption/overlay.js";
import {
  createDraftApproval,
  projectCaptionsToTimeline,
  type CaptionApproval,
} from "../caption/approval.js";
import {
  runEditorial,
  type CaptionDraft,
  type CaptionDraftEntry,
  type EditorialJudge,
  type EditorialReport,
  type GlossarySource,
  buildGlossary,
} from "../caption/editorial.js";
import {
  batchWordRemap,
  type TranscriptItemWithWords,
  type ClipContext,
  type TimingRemapResult,
} from "../caption/word-remap.js";
import { getLayoutPolicy, checkCps } from "../caption/line-breaker.js";

// ── Types ────────────────────────────────────────────────────────

export interface CaptionCommandResult {
  success: boolean;
  error?: CommandError;
  captionSource?: CaptionSource;
  captionDraft?: CaptionDraft;
  editorialReport?: EditorialReport;
  /** @deprecated Use approveCaptions() for approval. Always undefined from captionCommand(). */
  captionApproval?: CaptionApproval;
  /** @deprecated Use approveCaptions() for timeline projection. Always undefined from captionCommand(). */
  timelineUpdated?: boolean;
}

export interface CaptionCommandOptions {
  overlayInputs?: TextOverlayInput[];
  /** @deprecated No longer used — captionCommand always produces draft only. Use approveCaptions() for approval. */
  draftOnly?: boolean;
  /** @deprecated Approval params belong in approveCaptions(). Kept for backward compat but ignored. */
  approvedBy?: string;
  /** @deprecated Approval params belong in approveCaptions(). Kept for backward compat but ignored. */
  approvedAt?: string;
  /** If true, enable LLM editorial. Default: true when judge is provided. */
  editorialEnabled?: boolean;
  /** Injectable LLM editorial judge. If omitted, editorial is skipped. */
  editorialJudge?: EditorialJudge;
  /** Glossary sources for editorial */
  glossarySources?: GlossarySource;
  /** Speaker keys to exclude from captions */
  excludeSpeakers?: string[];
  /** If true, remove filler words from captions. Default: false. */
  removeFillers?: boolean;
}

export interface ApproveCaptionsOptions {
  approvedBy: string;
  approvedAt?: string;
}

export interface ApproveCaptionsResult {
  success: boolean;
  error?: CommandError;
  captionApproval?: CaptionApproval;
  timelineUpdated?: boolean;
}

// ── Command ─────────────────────────────────────────────────────

export function captionCommand(
  projectDir: string,
  options?: CaptionCommandOptions,
): CaptionCommandResult;
export async function captionCommand(
  projectDir: string,
  options?: CaptionCommandOptions,
): Promise<CaptionCommandResult>;
export function captionCommand(
  projectDir: string,
  options?: CaptionCommandOptions,
): CaptionCommandResult | Promise<CaptionCommandResult> {
  const allowedStates: ProjectState[] = ["approved", "critique_ready"];
  const ctx = initCommand(projectDir, "caption", allowedStates);
  if (isCommandError(ctx)) {
    return { success: false, error: ctx };
  }

  const { projectDir: absDir, doc } = ctx;

  // 1. Read caption_policy from blueprint
  const blueprintPath = path.join(absDir, "04_plan/edit_blueprint.yaml");
  if (!fs.existsSync(blueprintPath)) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "edit_blueprint.yaml not found",
      },
    };
  }

  const blueprint = parseYaml(
    fs.readFileSync(blueprintPath, "utf-8"),
  ) as { caption_policy?: CaptionPolicy };

  const captionPolicy = blueprint.caption_policy;
  if (!captionPolicy) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "caption_policy not found in edit_blueprint.yaml (required for M4 packaging)",
      },
    };
  }

  // 2. Read timeline
  const timelinePath = path.join(absDir, "05_timeline/timeline.json");
  if (!fs.existsSync(timelinePath)) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "timeline.json not found",
      },
    };
  }
  const timeline: TimelineIR = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));

  // 3. Read transcripts if source=transcript
  const transcripts = new Map<string, TranscriptArtifact>();
  if (captionPolicy.source === "transcript") {
    const transcriptDir = path.join(absDir, "03_analysis/transcripts");
    if (fs.existsSync(transcriptDir)) {
      for (const file of fs.readdirSync(transcriptDir)) {
        if (file.startsWith("TR_") && file.endsWith(".json")) {
          const tr = JSON.parse(
            fs.readFileSync(path.join(transcriptDir, file), "utf-8"),
          );
          transcripts.set(tr.asset_id, tr);
        }
      }
    }
  }

  // 4. Generate caption source (with cleanup + line-breaking)
  const projectId = doc.project_id || timeline.project_id || "unknown";
  const baseTimelineVersion = timeline.version || "1";

  const captionSource = generateCaptionSource(
    timeline,
    transcripts,
    captionPolicy,
    projectId,
    baseTimelineVersion,
    {
      excludeSpeakers: options?.excludeSpeakers,
      removeFillers: options?.removeFillers,
      autoLineBreak: true,
    },
  );

  // 5. Add text overlays if provided
  if (options?.overlayInputs && options.overlayInputs.length > 0) {
    captionSource.text_overlays = buildTextOverlays(options.overlayInputs);
  }

  // 6. Write caption_source.json
  const packageDir = path.join(absDir, "07_package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "caption_source.json"),
    JSON.stringify(captionSource, null, 2),
    "utf-8",
  );

  // 7. Run editorial if judge is provided
  const wantsEditorial = options?.editorialEnabled !== false && !!options?.editorialJudge;

  if (wantsEditorial && options?.editorialJudge) {
    // Async path: run editorial then finish draft
    return runEditorialAndFinishDraft(
      absDir, captionSource, captionPolicy, timeline, transcripts,
      packageDir, projectId, options,
    );
  }

  // Sync path: no editorial, build draft with timing + readiness gate
  const draft = buildPassthroughDraft(captionSource, captionPolicy, timeline, transcripts);
  fs.writeFileSync(
    path.join(packageDir, "caption_draft.json"),
    JSON.stringify(draft, null, 2),
    "utf-8",
  );

  return { success: true, captionSource, captionDraft: draft };
}

// ── Separate approval command (human-only) ──────────────────────

/**
 * Approve captions from an existing caption_draft.json.
 * This is the ONLY way to create caption_approval.json — requires explicit human action.
 */
export function approveCaptions(
  projectDir: string,
  options: ApproveCaptionsOptions,
): ApproveCaptionsResult {
  const allowedStates: ProjectState[] = ["approved", "critique_ready"];
  const ctx = initCommand(projectDir, "caption-approve", allowedStates);
  if (isCommandError(ctx)) {
    return { success: false, error: ctx };
  }

  const { projectDir: absDir, doc } = ctx;
  const packageDir = path.join(absDir, "07_package");

  // Read existing draft
  const draftPath = path.join(packageDir, "caption_draft.json");
  if (!fs.existsSync(draftPath)) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "caption_draft.json not found. Run /caption first.",
      },
    };
  }
  const draft: CaptionDraft = JSON.parse(fs.readFileSync(draftPath, "utf-8"));

  // Reject if draft is not ready for approval
  if (draft.draft_status !== "ready_for_human_approval") {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `Draft status is "${draft.draft_status}" — must be "ready_for_human_approval"`,
      },
    };
  }

  // Read caption_source for building approval
  const sourcePath = path.join(packageDir, "caption_source.json");
  if (!fs.existsSync(sourcePath)) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "caption_source.json not found. Run /caption first.",
      },
    };
  }
  const captionSource: CaptionSource = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));

  const approvedBy = options.approvedBy;
  const approvedAt = options.approvedAt || new Date().toISOString();

  // Build approval from draft entries
  const approvalSource: CaptionSource = {
    ...captionSource,
    speech_captions: draft.speech_captions.map((entry) => ({
      caption_id: entry.caption_id,
      asset_id: entry.asset_id,
      segment_id: entry.segment_id,
      timeline_in_frame: entry.timing?.timelineInFrame ?? entry.timeline_in_frame,
      timeline_duration_frames: entry.timing?.timelineDurationFrames ?? entry.timeline_duration_frames,
      text: entry.text,
      transcript_ref: entry.transcript_ref,
      transcript_item_ids: entry.transcript_item_ids,
      source: entry.source,
      styling_class: entry.styling_class,
      metrics: entry.metrics,
    })),
  };

  const approval = createDraftApproval(approvalSource, approvedBy, approvedAt);

  const promoteResult = draftAndPromote(absDir, [
    {
      relativePath: "07_package/caption_approval.json",
      schemaFile: "caption-approval.schema.json",
      content: approval,
      format: "json",
    },
  ]);

  if (!promoteResult.success) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `Caption approval validation failed: ${promoteResult.errors.join("; ")}`,
      },
    };
  }

  // Project captions into timeline (if approved state)
  let timelineUpdated = false;
  if (doc.current_state === "approved") {
    const timelinePath = path.join(absDir, "05_timeline/timeline.json");
    if (fs.existsSync(timelinePath)) {
      const timeline: TimelineIR = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
      const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
      const updatedTimeline = projectCaptionsToTimeline(timeline, approval, fps);
      fs.writeFileSync(timelinePath, JSON.stringify(updatedTimeline, null, 2), "utf-8");
      timelineUpdated = true;
    }
  }

  return {
    success: true,
    captionApproval: approval,
    timelineUpdated,
  };
}

// ── Internal helpers ─────────────────────────────────────────────

async function runEditorialAndFinishDraft(
  absDir: string,
  captionSource: CaptionSource,
  captionPolicy: CaptionPolicy,
  timeline: TimelineIR,
  transcripts: Map<string, TranscriptArtifact>,
  packageDir: string,
  projectId: string,
  options: CaptionCommandOptions,
): Promise<CaptionCommandResult> {
  const glossary = options.glossarySources
    ? buildGlossary(options.glossarySources)
    : [];

  const { draft, report } = await runEditorial(captionSource, {
    judge: options.editorialJudge!,
    glossary,
  });

  // Apply timing phase to editorial draft
  const timedDraft = applyTimingPhase(draft, captionPolicy, timeline, transcripts);

  // Apply readiness gate
  applyReadinessGate(timedDraft, captionPolicy);

  // Write draft and report
  fs.writeFileSync(
    path.join(packageDir, "caption_draft.json"),
    JSON.stringify(timedDraft, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(packageDir, "caption_editorial_report.json"),
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  return {
    success: true,
    captionSource,
    captionDraft: timedDraft,
    editorialReport: report,
  };
}

// ── Timing Phase (F2) ───────────────────────────────────────────

/**
 * Apply word-level timing remap to draft entries.
 * Updates each entry with timing metadata (source, confidence, sourceWordRefs).
 */
function applyTimingPhase(
  draft: CaptionDraft,
  captionPolicy: CaptionPolicy,
  timeline: TimelineIR,
  transcripts: Map<string, TranscriptArtifact>,
): CaptionDraft {
  if (captionPolicy.source !== "transcript" || draft.speech_captions.length === 0) {
    return draft;
  }

  // Build items-with-words map from transcripts
  const itemsWithWords = new Map<string, TranscriptItemWithWords>();
  for (const [, tr] of transcripts) {
    if (!tr.items) continue;
    for (const item of tr.items) {
      itemsWithWords.set(item.item_id, {
        item_id: item.item_id,
        start_us: item.start_us,
        end_us: item.end_us,
        text: item.text,
        words: item.words,
        word_timing_mode: item.word_timing_mode,
      });
    }
  }

  if (itemsWithWords.size === 0) {
    return draft;
  }

  // Build clip contexts from timeline
  const clips: ClipContext[] = [];
  const allTracks = [
    ...(timeline.tracks?.video ?? []),
    ...(timeline.tracks?.audio ?? []),
  ];
  for (const track of allTracks) {
    for (const clip of track.clips ?? []) {
      if (clip.role === "A1" || clip.role === "dialogue") {
        clips.push({
          clipId: clip.clip_id,
          assetId: clip.asset_id,
          srcInUs: clip.src_in_us ?? 0,
          srcOutUs: clip.src_out_us ?? (clip.src_in_us ?? 0) + 1_000_000,
          timelineInFrame: clip.timeline_in_frame,
          timelineDurationFrames: clip.timeline_duration_frames,
        });
      }
    }
  }

  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;

  // Batch remap
  const captionInputs = draft.speech_captions.map((entry) => ({
    captionId: entry.caption_id,
    text: entry.text,
    transcriptItemIds: entry.transcript_item_ids ?? [],
    timelineInFrame: entry.timeline_in_frame,
    timelineDurationFrames: entry.timeline_duration_frames,
  }));

  const timingResults = batchWordRemap(captionInputs, clips, itemsWithWords, fps);

  // Apply timing results to draft entries
  const timedEntries = draft.speech_captions.map((entry) => {
    const timing = timingResults.get(entry.caption_id);
    if (!timing) return entry;

    return {
      ...entry,
      timeline_in_frame: timing.timelineInFrame,
      timeline_duration_frames: timing.timelineDurationFrames,
      timing: {
        source: timing.timingSource,
        confidence: timing.timingConfidence,
        sourceWordRefs: timing.sourceWordRefs,
        triggeredFallback: timing.timingSource === "clip_item_remap",
        timelineInFrame: timing.timelineInFrame,
        timelineDurationFrames: timing.timelineDurationFrames,
      },
    };
  });

  return {
    ...draft,
    speech_captions: timedEntries,
  };
}

// ── Readiness Gate ───────────────────────────────────────────────

/** Minimum timing confidence for ready_for_human_approval */
const MIN_TIMING_CONFIDENCE = 0.75;

/**
 * Apply readiness gate: checks timing, layout, and density.
 * Modifies draft_status to "needs_operator_fix" if gate fails.
 */
function applyReadinessGate(
  draft: CaptionDraft,
  captionPolicy: CaptionPolicy,
): void {
  const language = captionPolicy.language;
  const layout = getLayoutPolicy(language);

  let hasFailure = false;

  for (const entry of draft.speech_captions) {
    // Check timing confidence
    if (entry.timing && entry.timing.confidence < MIN_TIMING_CONFIDENCE) {
      hasFailure = true;
    }

    // Check CPS (checkCps takes durationMs)
    const durationMs = (entry.timeline_duration_frames / 24) * 1000; // approximate
    if (durationMs > 0) {
      const cpsResult = checkCps(entry.text, durationMs, layout);
      if (!cpsResult.withinLimit) {
        hasFailure = true;
      }
    }

    // Check line length
    const lines = entry.text.split("\n");
    for (const line of lines) {
      if (line.length > layout.maxCharsPerLine) {
        hasFailure = true;
      }
    }
  }

  if (hasFailure && draft.degraded_count === 0) {
    // Only downgrade if not already degraded (editorial failures take priority)
    draft.draft_status = "needs_operator_fix";
  }
}

/**
 * Build a passthrough draft (no editorial) from caption source.
 * Includes timing phase and readiness gate.
 */
function buildPassthroughDraft(
  source: CaptionSource,
  captionPolicy: CaptionPolicy,
  timeline: TimelineIR,
  transcripts: Map<string, TranscriptArtifact>,
): CaptionDraft {
  const draft: CaptionDraft = {
    version: source.version,
    project_id: source.project_id,
    base_timeline_version: source.base_timeline_version,
    caption_policy: source.caption_policy,
    speech_captions: source.speech_captions.map((sc) => ({
      ...sc,
      editorial: {
        sourceText: sc.text,
        operations: [],
        glossaryHits: [],
        confidence: 1.0,
        status: "clean" as const,
      },
    })),
    text_overlays: source.text_overlays,
    draft_status: "ready_for_human_approval",
    degraded_count: 0,
  };

  // Apply timing phase
  const timedDraft = applyTimingPhase(draft, captionPolicy, timeline, transcripts);

  // Apply readiness gate
  applyReadinessGate(timedDraft, captionPolicy);

  return timedDraft;
}
