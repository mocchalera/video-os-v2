/**
 * /caption Command
 *
 * Generates caption source from transcripts, manages approval workflow,
 * and projects approved captions into the timeline.
 *
 * Allowed start states: approved (for full workflow), critique_ready (for draft only).
 *
 * Steps:
 * 1. Read caption_policy from blueprint
 * 2. Generate caption_source.json from transcripts
 * 3. If approval mode: create caption_approval.json
 * 4. Project captions into timeline.json
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

// ── Types ────────────────────────────────────────────────────────

export interface CaptionCommandResult {
  success: boolean;
  error?: CommandError;
  captionSource?: CaptionSource;
  captionApproval?: CaptionApproval;
  timelineUpdated?: boolean;
}

export interface CaptionCommandOptions {
  approvedBy?: string;
  approvedAt?: string;
  overlayInputs?: TextOverlayInput[];
  draftOnly?: boolean;
}

// ── Command ─────────────────────────────────────────────────────

export function captionCommand(
  projectDir: string,
  options?: CaptionCommandOptions,
): CaptionCommandResult {
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

  // 4. Generate caption source
  const projectId = doc.project_id || timeline.project_id || "unknown";
  const baseTimelineVersion = timeline.version || "1";

  const captionSource = generateCaptionSource(
    timeline,
    transcripts,
    captionPolicy,
    projectId,
    baseTimelineVersion,
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

  if (options?.draftOnly) {
    return { success: true, captionSource };
  }

  // 7. Create approval
  const approvedBy = options?.approvedBy || "operator";
  const approvedAt = options?.approvedAt || new Date().toISOString();
  const approval = createDraftApproval(captionSource, approvedBy, approvedAt);

  // 8. Write caption_approval.json via draft/promote
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
      error: {
        code: "VALIDATION_FAILED",
        message: `Caption approval validation failed: ${promoteResult.errors.join("; ")}`,
      },
    };
  }

  // 9. Project captions into timeline (if approved state)
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
    captionApproval: approval,
    timelineUpdated,
  };
}
