/**
 * /caption Command
 *
 * Generates caption artifacts with editorial pipeline:
 * 1. Read caption_policy from blueprint
 * 2. Generate caption_source.json from transcripts (raw + cleanup)
 * 3. Run LLM editorial → caption_draft.json (injectable, fail-open)
 * 4. If approval mode: create caption_approval.json (human-only)
 * 5. Project approved captions into timeline.json
 *
 * Artifact chain: caption_source.json → caption_draft.json → caption_approval.json
 * caption_approval.json is human-approved only; machine never writes it directly.
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
import {
  generateCaptionSource,
  type CaptionPolicy,
  type CaptionSource,
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
  type EditorialJudge,
  type EditorialReport,
  type GlossarySource,
  buildGlossary,
} from "../caption/editorial.js";

// ── Types ────────────────────────────────────────────────────────

export interface CaptionCommandResult {
  success: boolean;
  error?: CommandError;
  captionSource?: CaptionSource;
  captionDraft?: CaptionDraft;
  captionApproval?: CaptionApproval;
  editorialReport?: EditorialReport;
  timelineUpdated?: boolean;
}

export interface CaptionCommandOptions {
  approvedBy?: string;
  approvedAt?: string;
  overlayInputs?: TextOverlayInput[];
  /** If true, only generate source + draft, no approval/projection. */
  draftOnly?: boolean;
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
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));

  // 3. Read transcripts if source=transcript
  const transcripts = new Map<string, any>();
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
    // Async path: run editorial then continue
    return runEditorialAndFinish(
      absDir, doc, captionSource, captionPolicy, timeline, timelinePath,
      packageDir, projectId, options,
    );
  }

  // Sync path: no editorial, write draft as-is
  const draft = buildPassthroughDraft(captionSource);
  fs.writeFileSync(
    path.join(packageDir, "caption_draft.json"),
    JSON.stringify(draft, null, 2),
    "utf-8",
  );

  if (options?.draftOnly) {
    return { success: true, captionSource, captionDraft: draft };
  }

  // 8. Handle approval + projection
  return finishApprovalAndProjection(
    absDir, doc, captionSource, draft, captionPolicy, timeline, timelinePath,
    packageDir, options,
  );
}

// ── Internal helpers ─────────────────────────────────────────────

async function runEditorialAndFinish(
  absDir: string,
  doc: any,
  captionSource: CaptionSource,
  captionPolicy: CaptionPolicy,
  timeline: any,
  timelinePath: string,
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

  // Write draft and report
  fs.writeFileSync(
    path.join(packageDir, "caption_draft.json"),
    JSON.stringify(draft, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(packageDir, "caption_editorial_report.json"),
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  if (options?.draftOnly) {
    return {
      success: true,
      captionSource,
      captionDraft: draft,
      editorialReport: report,
    };
  }

  return finishApprovalAndProjection(
    absDir, doc, captionSource, draft, captionPolicy, timeline, timelinePath,
    packageDir, options, report,
  );
}

function finishApprovalAndProjection(
  absDir: string,
  doc: any,
  captionSource: CaptionSource,
  draft: CaptionDraft,
  captionPolicy: CaptionPolicy,
  timeline: any,
  timelinePath: string,
  packageDir: string,
  options?: CaptionCommandOptions,
  editorialReport?: EditorialReport,
): CaptionCommandResult {
  // Create approval from draft (not from source)
  const approvedBy = options?.approvedBy || "operator";
  const approvedAt = options?.approvedAt || new Date().toISOString();

  // Build approval from draft entries (preserving editorial metadata)
  const approvalSource: CaptionSource = {
    ...captionSource,
    speech_captions: draft.speech_captions.map((entry) => ({
      caption_id: entry.caption_id,
      asset_id: entry.asset_id,
      segment_id: entry.segment_id,
      timeline_in_frame: entry.timeline_in_frame,
      timeline_duration_frames: entry.timeline_duration_frames,
      text: entry.text,
      transcript_ref: entry.transcript_ref,
      transcript_item_ids: entry.transcript_item_ids,
      source: entry.source,
      styling_class: entry.styling_class,
      metrics: entry.metrics,
    })),
  };

  const approval = createDraftApproval(approvalSource, approvedBy, approvedAt);

  // Write approval via draft/promote
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
      captionSource,
      captionDraft: draft,
      editorialReport,
      error: {
        code: "VALIDATION_FAILED",
        message: `Caption approval validation failed: ${promoteResult.errors.join("; ")}`,
      },
    };
  }

  // Project captions into timeline (if approved state)
  let timelineUpdated = false;
  if (doc.current_state === "approved") {
    const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
    const updatedTimeline = projectCaptionsToTimeline(timeline, approval, fps);

    fs.writeFileSync(timelinePath, JSON.stringify(updatedTimeline, null, 2), "utf-8");
    timelineUpdated = true;
  }

  return {
    success: true,
    captionSource,
    captionDraft: draft,
    captionApproval: approval,
    editorialReport,
    timelineUpdated,
  };
}

/**
 * Build a passthrough draft (no editorial) from caption source.
 */
function buildPassthroughDraft(source: CaptionSource): CaptionDraft {
  return {
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
}
