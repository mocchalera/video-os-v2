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
  validateAgainstSchema,
  type CommandContext,
  type CommandError,
} from "./shared.js";
import type { ProjectState, ProjectStateDoc } from "../state/reconcile.js";
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
import { buildTimelineOffsetMapFromTimeline } from "../compiler/timeline-offset-engine.js";
import { getLayoutPolicy, checkCps } from "../caption/line-breaker.js";
import {
  loadProjectCaptionGlossary,
  mergeGlossarySources,
} from "../caption/project-glossary.js";
import {
  applyCaptionSemanticTiming,
  type CaptionTimingReport,
  type RevealClipContext,
  type RevealTranscriptItem,
} from "../caption/semantic-timing.js";
import { planSocialHookOverlay } from "../caption/social-finishing.js";
import {
  finalizeCaptionDraftTiming,
  validateFinalCaptionInvariants,
  type FinalCaptionInvariantIssue,
} from "../caption/final-invariants.js";
import { projectCaptionEntry } from "../caption/projection.js";
import {
  buildAuthoredCaptionArtifacts,
  buildAuthoredCaptionApproval,
  buildAuthoredProjectionReceipt,
  hashAuthoredTextAuthority,
  hashAuthoredTimingAuthority,
  readAuthoredCaptionStatus,
  serializeAuthoredJson,
  sha256Bytes,
  authoredReviewIsCurrent,
  type AuthoredCaptionPreview,
} from "../caption/authored-lyrics.js";

// ── Types ────────────────────────────────────────────────────────

const V2_CAPTION_DRAFT_VERSION = "caption-draft/v2";

export interface CaptionCommandResult {
  success: boolean;
  error?: CommandError;
  captionSource?: CaptionSource;
  captionDraft?: CaptionDraft;
  editorialReport?: EditorialReport;
  captionTimingReport?: CaptionTimingReport;
  /** @deprecated Use approveCaptions() for approval. Always undefined from captionCommand(). */
  captionApproval?: CaptionApproval;
  /** @deprecated Use approveCaptions() for timeline projection. Always undefined from captionCommand(). */
  timelineUpdated?: boolean;
  /** Authored route preview; approval remains a separate explicit command. */
  authoredPreview?: AuthoredCaptionPreview;
}

export interface CaptionCommandOptions {
  /** Explicit source override for the public authored-lyrics route. */
  source?: CaptionPolicy["source"];
  /** Authored lyric body file; required when source is authored. */
  lyricsPath?: string;
  /** Deterministic timing evidence/plan; required when source is authored. */
  timingPlanPath?: string;
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

export interface CaptionRetimeResult {
  success: boolean;
  error?: CommandError;
  captionDraft?: CaptionDraft;
  captionTimingReport?: CaptionTimingReport;
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
  authoredPreview?: AuthoredCaptionPreview;
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
  const allowedStates: ProjectState[] = options?.source === "authored"
    ? ["blueprint_ready", "timeline_drafted", "approved", "critique_ready", "packaged"]
    : ["approved", "critique_ready", "packaged"];
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
  const briefPath = path.join(absDir, "01_intent/creative_brief.yaml");
  const brief = fs.existsSync(briefPath)
    ? parseYaml(fs.readFileSync(briefPath, "utf-8"))
    : {};

  const captionPolicy = blueprint.caption_policy ?? (options?.source === "authored"
    ? {
        language: "en",
        delivery_mode: "burn_in",
        source: "authored" as const,
        styling_class: "default",
      }
    : undefined);
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
  const timelineOffsetMap = buildTimelineOffsetMapFromTimeline(timeline);

  // Issue #41 is an explicit public route. It bypasses transcript editorial
  // generation entirely so STT/music evidence can never become body text.
  if (options?.source === "authored") {
    if (!options.lyricsPath || !options.timingPlanPath) {
      return {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "authored captions require --lyrics PATH and --timing-plan PATH",
        },
      };
    }
    try {
      const projectId = doc.project_id || timeline.project_id || "unknown";
      const baseTimelineVersion = timeline.version || "1";
      const authoredPolicy: CaptionPolicy = { ...captionPolicy, source: "authored" };
      const artifacts = buildAuthoredCaptionArtifacts({
        projectDir: absDir,
        lyricsPath: options.lyricsPath,
        timingPlanPath: options.timingPlanPath,
        timeline,
        captionPolicy: authoredPolicy,
        projectId,
        baseTimelineVersion,
        baseTimelineHash: sha256Bytes(fs.readFileSync(timelinePath)),
        nextCommand: `npm run caption -- approve --project ${absDir} --approved-by <human>`,
        maxCps: resolvedCaptionMaxCps(authoredPolicy),
      });
      assertCaptionDraftSchema(artifacts.captionDraft);
      const sourceSchema = validateAgainstSchema(artifacts.captionSource, "authored-caption-source.schema.json");
      if (!sourceSchema.valid) throw new Error(`authored caption source schema validation failed: ${sourceSchema.errors.join("; ")}`);
      const previewSchema = validateAgainstSchema(artifacts.preview, "authored-caption-preview.schema.json");
      if (!previewSchema.valid) throw new Error(`authored caption preview schema validation failed: ${previewSchema.errors.join("; ")}`);
      const packageDir = path.join(absDir, "07_package");
      fs.mkdirSync(packageDir, { recursive: true });
      atomicWriteJson(path.join(packageDir, "caption_source.json"), artifacts.captionSource);
      atomicWriteJson(path.join(packageDir, "caption_draft.json"), artifacts.captionDraft);
      atomicWriteJson(path.join(packageDir, "caption_preview.json"), artifacts.preview);
      return {
        success: true,
        captionSource: artifacts.captionSource,
        captionDraft: artifacts.captionDraft,
        authoredPreview: artifacts.preview,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

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
  const projectGlossary = loadProjectCaptionGlossary(absDir);
  const glossarySources = mergeGlossarySources(
    projectGlossary.sources,
    options?.glossarySources,
  );

  const generatedCaptionSource = generateCaptionSource(
    timeline,
    transcripts,
    captionPolicy,
    projectId,
    baseTimelineVersion,
    {
      excludeSpeakers: options?.excludeSpeakers,
      removeFillers: options?.removeFillers,
      autoLineBreak: true,
      maxCharsPerCaption: resolvedCaptionMaxChars(captionPolicy),
      maxCps: resolvedCaptionMaxCps(captionPolicy),
      minCaptionDurationMs: captionPolicy.styling_class === "longform-event" ? 400 : undefined,
      operatorCorrections: glossarySources.operatorCorrections,
      protectedTerms: buildGlossary(glossarySources),
      timelineOffsetMap,
    },
  );
  // The production command always wires the canonical Offset Engine. Keep the
  // direct segmenter API's 1.0 legacy output untouched, but mark this generated
  // draft path as v2 so its provenance contract is enforced end-to-end.
  const captionSource: CaptionSource = {
    ...generatedCaptionSource,
    version: V2_CAPTION_DRAFT_VERSION,
  };

  // 5. Add text overlays if provided
  const overlayInputs = planSocialHookOverlay({
    brief,
    overlays: options?.overlayInputs,
    fps: timeline.sequence.fps_num / timeline.sequence.fps_den,
    width: timeline.sequence.width,
    height: timeline.sequence.height,
  });
  if (overlayInputs.length > 0) {
    captionSource.text_overlays = buildTextOverlays(overlayInputs);
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
      packageDir, projectId, { ...options, glossarySources },
    );
  }

  // Sync path: no editorial, build draft with timing + readiness gate
  const { draft, timingReport } = buildPassthroughDraft(
    captionSource,
    captionPolicy,
    timeline,
    transcripts,
  );
  assertCaptionDraftSchema(draft);
  fs.writeFileSync(
    path.join(packageDir, "caption_draft.json"),
    JSON.stringify(draft, null, 2),
    "utf-8",
  );

  if (timingReport) {
    fs.writeFileSync(
      path.join(packageDir, "caption_timing_report.json"),
      JSON.stringify(timingReport, null, 2),
      "utf-8",
    );
  }

  return { success: true, captionSource, captionDraft: draft, captionTimingReport: timingReport };
}

/**
 * Recompute timing for an existing caption draft without regenerating text or
 * reconciling the editorial project state. This is the safe repair route when
 * word timestamps are backfilled after human text review has already begun.
 */
export function retimeCaptionDraft(projectDir: string): CaptionRetimeResult {
  const absDir = path.resolve(projectDir);
  const draftPath = path.join(absDir, "07_package", "caption_draft.json");
  const timelinePath = path.join(absDir, "05_timeline", "timeline.json");
  if (!fs.existsSync(draftPath) || !fs.existsSync(timelinePath)) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "caption_draft.json and timeline.json are required for caption retiming",
      },
    };
  }

  try {
    const draft = JSON.parse(fs.readFileSync(draftPath, "utf-8")) as CaptionDraft;
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as TimelineIR;
    const transcripts = new Map<string, TranscriptArtifact>();
    const transcriptDir = path.join(absDir, "03_analysis", "transcripts");
    if (fs.existsSync(transcriptDir)) {
      for (const file of fs.readdirSync(transcriptDir)) {
        if (!file.startsWith("TR_") || !file.endsWith(".json")) continue;
        const transcript = JSON.parse(
          fs.readFileSync(path.join(transcriptDir, file), "utf-8"),
        ) as TranscriptArtifact;
        transcripts.set(transcript.asset_id, transcript);
      }
    }

    const workingDraft: CaptionDraft = {
      ...draft,
      speech_captions: draft.speech_captions.map((entry) => structuredClone(entry)),
      draft_status: "ready_for_human_approval",
    };
    const timedDraft = applyCaptionWordTiming(workingDraft, draft.caption_policy, timeline, transcripts);
    const timingResult = applyCaptionSemanticTimingPhase(
      timedDraft,
      draft.caption_policy,
      timeline,
      transcripts,
    );
    const finalized = finalizeCaptionDraftTiming(
      timingResult.draft,
      timeline.sequence.fps_num / timeline.sequence.fps_den,
      draft.caption_policy.language,
    );
    const finalDraft = ensureV2CaptionTiming(finalized.draft, timeline);
    assertCaptionDraftSchema(finalDraft);
    applyReadinessGate(
      finalDraft,
      draft.caption_policy,
      timingResult.report,
      timeline.sequence.fps_num / timeline.sequence.fps_den,
      finalized.issues,
    );

    atomicWriteJson(draftPath, finalDraft);
    if (timingResult.report) {
      atomicWriteJson(
        path.join(absDir, "07_package", "caption_timing_report.json"),
        timingResult.report,
      );
    }
    return {
      success: true,
      captionDraft: finalDraft,
      captionTimingReport: timingResult.report,
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
}

function assertCaptionDraftSchema(draft: CaptionDraft): void {
  const result = validateAgainstSchema(draft, "caption-draft.schema.json");
  if (!result.valid) throw new Error(`caption_draft schema validation failed: ${result.errors.join("; ")}`);
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
  // Authored captions are approved before review, while the legacy transcript
  // route retains its existing post-review state contract. The early probe is
  // read-only and only chooses the command's state allowlist.
  const projectRoot = path.resolve(projectDir);
  let authoredRoute = false;
  try {
    const blueprintPath = path.join(projectRoot, "04_plan/edit_blueprint.yaml");
    if (fs.existsSync(blueprintPath)) {
      const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf-8")) as { caption_policy?: { source?: string } };
      authoredRoute = blueprint.caption_policy?.source === "authored";
    }
    const draftPath = path.join(projectRoot, "07_package/caption_draft.json");
    if (fs.existsSync(draftPath)) {
      const draft = JSON.parse(fs.readFileSync(draftPath, "utf-8")) as CaptionDraft;
      authoredRoute = authoredRoute || !!draft.text_authority || !!draft.timing_authority;
    }
  } catch {
    // initCommand below returns the canonical validation/state error.
  }
  const allowedStates: ProjectState[] = authoredRoute
    ? ["blueprint_ready", "timeline_drafted", "approved", "critique_ready", "packaged"]
    : ["approved", "critique_ready", "packaged"];
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
  const draftSchema = validateAgainstSchema(draft, "caption-draft.schema.json");
  if (!draftSchema.valid) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `Caption draft validation failed: ${draftSchema.errors.join("; ")}`,
      },
    };
  }
  const timelinePath = path.join(absDir, "05_timeline/timeline.json");
  if (!fs.existsSync(timelinePath)) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "timeline.json not found; final caption invariants cannot be verified",
      },
    };
  }
  const approvalTimeline: TimelineIR = JSON.parse(
    fs.readFileSync(timelinePath, "utf-8"),
  );
  const approvalFps =
    approvalTimeline.sequence.fps_num / approvalTimeline.sequence.fps_den;
  const finalInvariantIssues = validateFinalCaptionInvariants(
    draft.speech_captions,
    approvalFps,
    draft.caption_policy.language,
  ).filter((issue) => issue.severity === "block");
  if (finalInvariantIssues.length > 0) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message:
          "Final caption invariants failed: " +
          finalInvariantIssues.map((issue) => issue.message).join("; "),
      },
    };
  }

  const authored = !!draft.text_authority && !!draft.timing_authority;

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

  if (authored || captionSource.caption_policy.source === "authored") {
    return approveAuthoredCaptions(absDir, doc, draft, captionSource, approvalTimeline, options);
  }

  const approvedBy = options.approvedBy;
  const approvedAt = options.approvedAt || new Date().toISOString();

  // Build approval from draft entries
  const approvalSource: CaptionSource = {
    ...captionSource,
    speech_captions: draft.speech_captions.map((entry) => projectCaptionEntry({
      ...entry,
      timeline_in_frame: entry.timing?.timelineInFrame ?? entry.timeline_in_frame,
      timeline_duration_frames: entry.timing?.timelineDurationFrames ?? entry.timeline_duration_frames,
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

  // Project captions into the canonical timeline even after packaging. This
  // invalidates downstream receipts naturally and avoids moving manifests out
  // of the way merely to make a caption-only correction.
  let timelineUpdated = false;
  if (doc.current_state === "approved" || doc.current_state === "packaged") {
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

function approveAuthoredCaptions(
  absDir: string,
  doc: Pick<ProjectStateDoc, "current_state" | "approval_record">,
  draft: CaptionDraft,
  captionSource: CaptionSource,
  approvalTimeline: TimelineIR,
  options: ApproveCaptionsOptions,
): ApproveCaptionsResult {
  if (authoredReviewIsCurrent(absDir)) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "caption projection rejected: current review-ready artifacts would become stale",
      },
    };
  }
  if ((doc.current_state === "approved" || doc.current_state === "packaged") &&
    (doc.approval_record?.status === "clean" || doc.approval_record?.status === "creative_override")) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `caption projection rejected: current review approval (${doc.approval_record.status}) would become stale`,
      },
    };
  }
  if (!draft.text_authority || !draft.timing_authority || !captionSource.text_authority || !captionSource.timing_authority) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "authored caption source/draft must carry separate text_authority and timing_authority",
      },
    };
  }
  if (hashAuthoredTextAuthority(draft.text_authority) !== hashAuthoredTextAuthority(captionSource.text_authority) ||
    hashAuthoredTimingAuthority(draft.timing_authority) !== hashAuthoredTimingAuthority(captionSource.timing_authority)) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "caption_source.json and caption_draft.json authority hashes differ; regenerate the authored draft",
      },
    };
  }
  const authoredLines = draft.text_authority.lines.filter((line) => line.text.length > 0);
  const authoredEntries = [...draft.speech_captions].sort((left, right) =>
    (left.line_id ?? "").localeCompare(right.line_id ?? ""));
  if (authoredEntries.length !== authoredLines.length || authoredLines.some((line, index) => {
    const entry = authoredEntries[index];
    return !entry || entry.line_id !== line.line_id || entry.cue_id !== `AC_${String(line.line_number).padStart(4, "0")}` || entry.text !== line.text;
  })) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "authored caption draft text differs from the authored lyric body; authored text cannot be machine-edited",
      },
    };
  }

  const resolveInput = (storedPath: string): string => path.isAbsolute(storedPath) ? storedPath : path.resolve(absDir, storedPath);
  try {
    const currentTextHash = sha256Bytes(fs.readFileSync(resolveInput(draft.text_authority.source_path)));
    const currentTimingHash = sha256Bytes(fs.readFileSync(resolveInput(draft.timing_authority.source_path)));
    if (currentTextHash !== draft.text_authority.source_sha256 || currentTimingHash !== draft.timing_authority.source_sha256) {
      return {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: currentTextHash !== draft.text_authority.source_sha256
            ? "authored lyric bytes changed since draft; regenerate before approval"
            : "timing plan bytes changed since draft; regenerate before approval",
        },
      };
    }
  } catch (error) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `authored source inputs could not be re-read: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  const approvedAt = options.approvedAt || new Date().toISOString();
  const approval = buildAuthoredCaptionApproval(captionSource, draft, options.approvedBy, approvedAt);
  const approvalHash = sha256Bytes(serializeAuthoredJson(approval));
  const fps = approvalTimeline.sequence.fps_num / approvalTimeline.sequence.fps_den;
  const projectedTimeline = projectCaptionsToTimeline(approvalTimeline, approval, fps) as TimelineIR;
  const projectedTimelineHash = sha256Bytes(serializeAuthoredJson(projectedTimeline));
  const previewPath = path.join(absDir, "07_package/caption_preview.json");
  const preview = fs.existsSync(previewPath)
    ? JSON.parse(fs.readFileSync(previewPath, "utf-8")) as AuthoredCaptionPreview
    : undefined;
  const currentBaseTimelineHash = sha256Bytes(fs.readFileSync(path.join(absDir, "05_timeline/timeline.json")));
  if (!preview ||
    preview.base_timeline_hash !== currentBaseTimelineHash ||
    preview.projected_timeline_hash !== projectedTimelineHash ||
    hashAuthoredTextAuthority(preview.text_authority) !== hashAuthoredTextAuthority(draft.text_authority) ||
    hashAuthoredTimingAuthority(preview.timing_authority) !== hashAuthoredTimingAuthority(draft.timing_authority)) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "authored caption approval requires a current preapproval preview; regenerate the draft preview",
      },
    };
  }
  const receipt = buildAuthoredProjectionReceipt(
    draft.project_id,
    preview.base_timeline_hash,
    projectedTimelineHash,
    approval,
    approvalHash,
  );
  const approvalSchema = validateAgainstSchema(approval, "caption-approval.schema.json");
  if (!approvalSchema.valid) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `Authored caption approval validation failed: ${approvalSchema.errors.join("; ")}`,
      },
    };
  }
  const receiptSchema = validateAgainstSchema(receipt, "authored-caption-projection.schema.json");
  if (!receiptSchema.valid) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `Authored caption projection receipt validation failed: ${receiptSchema.errors.join("; ")}`,
      },
    };
  }

  const promoteResult = draftAndPromote(absDir, [
    {
      relativePath: "07_package/caption_approval.json",
      schemaFile: "caption-approval.schema.json",
      content: approval,
      format: "json",
    },
    {
      relativePath: "05_timeline/timeline.json",
      schemaFile: "timeline-ir.schema.json",
      content: projectedTimeline,
      format: "json",
    },
    {
      relativePath: "07_package/caption_projection_receipt.json",
      schemaFile: "authored-caption-projection.schema.json",
      content: receipt,
      format: "json",
    },
  ]);
  if (!promoteResult.success) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `Authored caption approval/projection failed: ${promoteResult.errors.join("; ")}`,
      },
    };
  }
  return {
    success: true,
    captionApproval: approval,
    timelineUpdated: true,
    authoredPreview: preview,
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
  const timedDraft = applyCaptionWordTiming(draft, captionPolicy, timeline, transcripts);
  const timingResult = applyCaptionSemanticTimingPhase(timedDraft, captionPolicy, timeline, transcripts);
  const finalized = finalizeCaptionDraftTiming(
    timingResult.draft,
    timeline.sequence.fps_num / timeline.sequence.fps_den,
    captionPolicy.language,
  );
  const finalDraft = ensureV2CaptionTiming(finalized.draft, timeline);
  assertCaptionDraftSchema(finalDraft);

  // Apply readiness gate
  applyReadinessGate(
    finalDraft,
    captionPolicy,
    timingResult.report,
    timeline.sequence.fps_num / timeline.sequence.fps_den,
    finalized.issues,
  );

  // Write draft and report
  fs.writeFileSync(
    path.join(packageDir, "caption_draft.json"),
    JSON.stringify(finalDraft, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(packageDir, "caption_editorial_report.json"),
    JSON.stringify(report, null, 2),
    "utf-8",
  );
  if (timingResult.report) {
    fs.writeFileSync(
      path.join(packageDir, "caption_timing_report.json"),
      JSON.stringify(timingResult.report, null, 2),
      "utf-8",
    );
  }

  return {
    success: true,
    captionSource,
    captionDraft: finalDraft,
    editorialReport: report,
    captionTimingReport: timingResult.report,
  };
}

// ── Timing Phase (F2) ───────────────────────────────────────────

/**
 * Apply word-level timing remap to draft entries.
 * Updates each entry with timing metadata (source, confidence, sourceWordRefs).
 */
export function applyCaptionWordTiming(
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
        word_timing_mode: item.word_timing_mode ?? tr.word_timing_mode,
      });
    }
  }

  if (itemsWithWords.size === 0) {
    return draft;
  }

  const offsetMap = buildTimelineOffsetMapFromTimeline(timeline);

  // Build clip contexts from timeline
  const clips: ClipContext[] = [];
  const audioTracks = timeline.tracks?.audio ?? [];
  const hasCanonicalA1 = audioTracks.some(
    (track) => track.track_id === "A1" && (track.clips?.length ?? 0) > 0,
  );
  const timingTracks = hasCanonicalA1
    ? audioTracks.filter((track) => track.track_id === "A1")
    : [
        ...(timeline.tracks?.video ?? []),
        ...audioTracks,
      ];
  for (const track of timingTracks) {
    for (const clip of track.clips ?? []) {
      // Compiler timelines identify dialogue authority by the canonical A1
      // track while individual clips retain their editorial role (commonly
      // "nat_sound"). Legacy timelines without A1 still use clip roles.
      if (hasCanonicalA1 || clip.role === "A1" || clip.role === "dialogue") {
        clips.push({
          clipId: clip.clip_id,
          assetId: clip.asset_id,
          srcInUs: clip.src_in_us ?? 0,
          srcOutUs: clip.src_out_us ?? (clip.src_in_us ?? 0) + 1_000_000,
          timelineInFrame: clip.timeline_in_frame,
          timelineDurationFrames: clip.timeline_duration_frames,
          segmentId: clip.segment_id,
          trackId: track.track_id,
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

  const timingResults = batchWordRemap(captionInputs, clips, itemsWithWords, fps, offsetMap);

  // Apply timing results to draft entries
  const timedEntries = draft.speech_captions.map((entry) => {
    const timing = timingResults.get(entry.caption_id);
    if (!timing) return entry;

    const timingFallback = timing.timingSource === "clip_item_remap" || timing.timingSource === "offset_map_fallback";
    const preservedWordTiming = timingFallback
      && entry.timing?.sourceWordRefs?.length
      ? entry.timing
      : undefined;

    return {
      ...entry,
      timeline_in_frame: timing.timelineInFrame,
      timeline_duration_frames: timing.timelineDurationFrames,
      timing: {
        // Keep the v1 source label for exact word-aligned projections while
        // exposing the v2 authority and offset-map fingerprint below. This
        // preserves existing artifact consumers without weakening A1 timing
        // authority or allowing the legacy clip remap to win.
        source: preservedWordTiming?.source
          ?? (timing.timingSource === "offset_map" ? "word_remap" : timing.timingSource),
        confidence: preservedWordTiming?.confidence ?? timing.timingConfidence,
        sourceWordRefs: preservedWordTiming?.sourceWordRefs ?? timing.sourceWordRefs,
        triggeredFallback: preservedWordTiming?.triggeredFallback
          ?? timingFallback,
        timelineInFrame: timing.timelineInFrame,
        timelineDurationFrames: timing.timelineDurationFrames,
        clipMapRefs: timing.clipMapRefs,
        authority: timing.authority,
        offsetMapFingerprint: timing.offsetMapFingerprint ?? offsetMap.fingerprint,
        stale: false,
      },
    };
  });

  return {
    ...draft,
    speech_captions: timedEntries,
  };
}

// ── Semantic speech timing phase ───────────────────────────────

export function applyCaptionSemanticTimingPhase(
  draft: CaptionDraft,
  captionPolicy: CaptionPolicy,
  timeline: TimelineIR,
  transcripts: Map<string, TranscriptArtifact>,
  offsetMap = buildTimelineOffsetMapFromTimeline(timeline),
): { draft: CaptionDraft; report?: CaptionTimingReport } {
  const semanticTiming = captionPolicy.semantic_timing
    ?? { mode: captionPolicy.source === "transcript" ? "speech_sync" as const : "off" as const };
  if (semanticTiming.mode === "off") {
    return { draft };
  }

  const transcriptItems = new Map<string, RevealTranscriptItem>();
  for (const transcript of transcripts.values()) {
    for (const item of transcript.items ?? []) {
      transcriptItems.set(item.item_id, {
        item_id: item.item_id,
        start_us: item.start_us,
        end_us: item.end_us,
        text: item.text,
        words: item.words,
        word_timing_mode: item.word_timing_mode ?? transcript.word_timing_mode,
      });
    }
  }

  const audioTracks = timeline.tracks?.audio ?? [];
  const preferredTracks = audioTracks.some((track) => track.track_id === "A1")
    ? audioTracks.filter((track) => track.track_id === "A1")
    : audioTracks;
  const clips: RevealClipContext[] = preferredTracks.flatMap((track) =>
    (track.clips ?? []).map((clip) => ({
      segment_id: clip.segment_id,
      asset_id: clip.asset_id,
      src_in_us: clip.src_in_us ?? 0,
      src_out_us: clip.src_out_us ?? (clip.src_in_us ?? 0) + 1_000_000,
      timeline_in_frame: clip.timeline_in_frame,
      timeline_duration_frames: clip.timeline_duration_frames,
    }))
  );
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  const result = applyCaptionSemanticTiming({
    captions: draft.speech_captions,
    policy: semanticTiming,
    transcriptItems,
    clips,
    fps,
    offsetMap,
  });
  return {
    draft: { ...draft, speech_captions: result.captions },
    report: result.report,
  };
}

// ── Readiness Gate ───────────────────────────────────────────────

/** Minimum timing confidence for ready_for_human_approval */
const MIN_TIMING_CONFIDENCE = 0.75;

function resolvedCaptionMaxCps(captionPolicy: CaptionPolicy): number | undefined {
  if (captionPolicy.styling_class === "longform-event") return 15;
  if (
    /(?:sns-vertical|speaker-separated.*outline|outline.*speaker-separated|social-short)/i.test(
      captionPolicy.styling_class,
    )
  ) {
    return 16;
  }
  return undefined;
}

function resolvedCaptionMaxChars(captionPolicy: CaptionPolicy): number | undefined {
  if (captionPolicy.styling_class === "longform-event") return 30;
  if (
    /(?:sns-vertical|speaker-separated.*outline|social-short)/i.test(
      captionPolicy.styling_class,
    )
  ) {
    return 26;
  }
  return undefined;
}

/**
 * Apply readiness gate: checks timing, layout, and density.
 * Modifies draft_status to "needs_operator_fix" if gate fails.
 */
function applyReadinessGate(
  draft: CaptionDraft,
  captionPolicy: CaptionPolicy,
  timingReport?: CaptionTimingReport,
  fps = 24,
  finalInvariantIssues: FinalCaptionInvariantIssue[] = [],
): void {
  const language = captionPolicy.language;
  const baseLayout = getLayoutPolicy(language, captionPolicy.styling_class);
  const styleMaxCps = resolvedCaptionMaxCps(captionPolicy);
  const layout = styleMaxCps === undefined
    ? baseLayout
    : { ...baseLayout, maxCps: styleMaxCps };

  let hasFailure = false;

  if (timingReport?.issues.some((issue) => issue.severity === "block")) {
    hasFailure = true;
  }
  if (finalInvariantIssues.some((issue) => issue.severity === "block")) {
    hasFailure = true;
  }

  for (const entry of draft.speech_captions) {
    // Check timing confidence
    if (entry.timing && entry.timing.confidence < MIN_TIMING_CONFIDENCE) {
      hasFailure = true;
    }

    // Check CPS (checkCps takes durationMs)
    const durationMs = (entry.timeline_duration_frames / fps) * 1000;
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
): { draft: CaptionDraft; timingReport?: CaptionTimingReport } {
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
  const timedDraft = applyCaptionWordTiming(draft, captionPolicy, timeline, transcripts);
  const timingResult = applyCaptionSemanticTimingPhase(timedDraft, captionPolicy, timeline, transcripts);
  const finalized = finalizeCaptionDraftTiming(
    timingResult.draft,
    timeline.sequence.fps_num / timeline.sequence.fps_den,
    captionPolicy.language,
  );
  const finalDraft = ensureV2CaptionTiming(finalized.draft, timeline);

  // Apply readiness gate
  applyReadinessGate(
    finalDraft,
    captionPolicy,
    timingResult.report,
    timeline.sequence.fps_num / timeline.sequence.fps_den,
    finalized.issues,
  );

  return { draft: finalDraft, timingReport: timingResult.report };
}

function ensureV2CaptionTiming(draft: CaptionDraft, timeline: TimelineIR): CaptionDraft {
  if (draft.version !== V2_CAPTION_DRAFT_VERSION) return draft;
  const offsetMap = buildTimelineOffsetMapFromTimeline(timeline);
  return {
    ...draft,
    speech_captions: draft.speech_captions.map((entry) => ({
      ...entry,
      timing: {
        source: entry.timing?.source ?? "offset_map_fallback",
        confidence: entry.timing?.confidence ?? 0,
        sourceWordRefs: entry.timing?.sourceWordRefs ?? [],
        clipMapRefs: entry.timing?.clipMapRefs ?? [],
        authority: entry.timing?.authority ?? offsetMap.dialogue_authority,
        offsetMapFingerprint: entry.timing?.offsetMapFingerprint ?? offsetMap.fingerprint,
        stale: entry.timing?.stale ?? false,
        triggeredFallback: entry.timing?.triggeredFallback ?? true,
        timelineInFrame: entry.timing?.timelineInFrame ?? entry.timeline_in_frame,
        timelineDurationFrames: entry.timing?.timelineDurationFrames ?? entry.timeline_duration_frames,
      },
    })),
  };
}
