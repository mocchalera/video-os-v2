import * as fs from "node:fs";
import * as path from "node:path";
import { validateArtifact } from "../artifacts/loaders.js";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import { resolveContentTemplate } from "../content/template-registry.js";
import { captionApprovalBindingHash } from "./visual-treatment.js";
import type { CaptionApproval } from "./approval.js";

export type CaptionEditRoute =
  | "caption_review_patch"
  | "caption_visual_treatment"
  | "timeline_review_patch";

export interface CaptionEditRouteReceipt {
  version: "caption-edit-route/v1";
  instruction: string;
  normalized_instruction: string;
  status: "routed" | "hold" | "degraded";
  route: CaptionEditRoute | null;
  reason_codes: string[];
  matched_facets: string[];
  evidence_status: "not_required" | "available" | "subject_evidence_required";
  verified: boolean;
  artifacts_to_write: string[];
  owner_boundary: {
    speech_caption: "caption-review-finalize+ffmpeg-libass";
    graphical_content: "registered-content-element+remotion";
    duplicate_semantic_owner: "reject";
  };
}

export interface CaptionEditProjectState {
  project_id: string;
  project_dir: string;
  timeline_hash: string | null;
  caption_draft: "present" | "missing";
  caption_draft_hash: string | null;
  caption_approval: "approved" | "stale" | "missing";
  caption_approval_hash: string | null;
  caption_approval_binding_hash: string | null;
  initialize_commands: string[];
  project_local_script_count: 0;
}

const OWNER_BOUNDARY: CaptionEditRouteReceipt["owner_boundary"] = {
  speech_caption: "caption-review-finalize+ffmpeg-libass",
  graphical_content: "registered-content-element+remotion",
  duplicate_semantic_owner: "reject",
};

const ROUTE_ARTIFACTS: Record<CaptionEditRoute, string[]> = {
  caption_review_patch: ["07_package/caption_review_patch.json"],
  caption_visual_treatment: [
    "07_package/caption_visual_treatment_patch.json",
    "07_package/caption_visual_treatment_preapproval_input.json",
    "07_package/caption_visual_treatment_preapproval_receipt.json",
  ],
  timeline_review_patch: ["06_review/review_patch.json"],
};

function normalizeInstruction(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function has(value: string, pattern: RegExp): boolean {
  return pattern.test(value);
}

export function routeCaptionEditInstruction(
  instruction: string,
  options: { subjectEvidence?: boolean } = {},
): CaptionEditRouteReceipt {
  const normalized = normalizeInstruction(instruction);
  if (!normalized) throw new Error("caption edit instruction is required");
  const matched = new Map<CaptionEditRoute, string[]>();
  const add = (route: CaptionEditRoute, facet: string) => {
    const values = matched.get(route) ?? [];
    if (!values.includes(facet)) values.push(facet);
    matched.set(route, values);
  };

  if (has(normalized, /(誤字|脱字|文言|本文|表記|漢字|句読点|改行|テキスト|text|字幕.*(?:直|修正|変更|差し替え))/i)) {
    add("caption_review_patch", "text");
  }
  if (has(normalized, /(タイミング|同期|字幕.*(?:早|遅)|表示.*(?:早|遅)|timing|sync)/i)) {
    add("caption_review_patch", "timing");
  }
  if (has(normalized, /(字幕|テロップ|冒頭|顔|被写体).*(大き|小さ|特大|二段|2段|サイズ|位置|上へ|下へ|階層|強調|アニメ|style|size|rect|hierarchy|emphasis|animation)|(?:大き|小さ|特大|二段|2段|サイズ|位置|上へ|下へ|階層|強調|アニメ).*(字幕|テロップ)|顔の下へ/i)) {
    add("caption_visual_treatment", "visual_treatment");
  }
  if (has(normalized, /(shot order|ショット.*順|カット.*順|順番.*(?:ショット|カット)|trim|トリム|crop|クロップ|画角|audio|音声|bgm|尺を|短く|長く)/i)) {
    add("timeline_review_patch", "timeline_edit");
  }

  const routes = [...matched.keys()];
  if (routes.length > 1) {
    return validateArtifact<CaptionEditRouteReceipt>({
      version: "caption-edit-route/v1",
      instruction,
      normalized_instruction: normalized,
      status: "hold",
      route: null,
      reason_codes: ["mixed_artifact_routes"],
      matched_facets: [...new Set(routes.flatMap((route) => matched.get(route) ?? []))].sort(),
      evidence_status: "not_required",
      verified: false,
      artifacts_to_write: [],
      owner_boundary: OWNER_BOUNDARY,
    }, "caption-edit-route.schema.json");
  }
  if (routes.length === 0) {
    return validateArtifact<CaptionEditRouteReceipt>({
      version: "caption-edit-route/v1",
      instruction,
      normalized_instruction: normalized,
      status: "degraded",
      route: null,
      reason_codes: ["instruction_not_representable"],
      matched_facets: [],
      evidence_status: "not_required",
      verified: false,
      artifacts_to_write: [],
      owner_boundary: OWNER_BOUNDARY,
    }, "caption-edit-route.schema.json");
  }

  const route = routes[0];
  const faceRelative = route === "caption_visual_treatment" && has(normalized, /(顔|被写体).*(下|上|横|避け|位置)|顔の下へ/i);
  const titleLike = route === "caption_visual_treatment" && has(normalized, /(冒頭|特大|二段|2段|タイトル|フック)/i);
  const evidenceAvailable = options.subjectEvidence === true;
  const reasonCodes = [`matched_${route}`];
  if (titleLike) reasonCodes.push("graphical_owner_preflight_required");
  if (faceRelative && !evidenceAvailable) reasonCodes.push("subject_evidence_required");
  return validateArtifact<CaptionEditRouteReceipt>({
    version: "caption-edit-route/v1",
    instruction,
    normalized_instruction: normalized,
    status: faceRelative && !evidenceAvailable ? "degraded" : "routed",
    route,
    reason_codes: reasonCodes,
    matched_facets: matched.get(route) ?? [],
    evidence_status: faceRelative ? (evidenceAvailable ? "available" : "subject_evidence_required") : "not_required",
    verified: !faceRelative || evidenceAvailable,
    artifacts_to_write: faceRelative && !evidenceAvailable ? [] : ROUTE_ARTIFACTS[route],
    owner_boundary: OWNER_BOUNDARY,
  }, "caption-edit-route.schema.json");
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function artifactHash(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return computeNormalizedJsonHash(readJson(filePath));
}

export function inspectCaptionEditProject(projectDir: string, reviewer: string): CaptionEditProjectState {
  const absolute = path.resolve(projectDir);
  const timelinePath = path.join(absolute, "05_timeline/timeline.json");
  if (!fs.existsSync(timelinePath)) throw new Error(`canonical timeline is required: ${timelinePath}`);
  const timeline = readJson(timelinePath) as { project_id?: string };
  const draftPath = path.join(absolute, "07_package/caption_draft.json");
  const approvalPath = path.join(absolute, "07_package/caption_approval.json");
  const approval = fs.existsSync(approvalPath)
    ? readJson(approvalPath) as CaptionApproval
    : null;
  const initializeCommands: string[] = [];
  if (!fs.existsSync(draftPath)) {
    initializeCommands.push(`npx tsx scripts/caption-review.ts prepare --project ${absolute}`);
  }
  if (!fs.existsSync(path.join(absolute, "07_package/caption_review_patch.json"))) {
    initializeCommands.push(`npx tsx scripts/caption-review.ts init --project ${absolute} --reviewer ${reviewer}`);
  }
  if (approval?.approval.status !== "approved") {
    initializeCommands.push(`npx tsx scripts/caption-review.ts approve --project ${absolute} --reviewer ${reviewer}`);
  }
  return {
    project_id: timeline.project_id ?? path.basename(absolute),
    project_dir: absolute,
    timeline_hash: artifactHash(timelinePath),
    caption_draft: fs.existsSync(draftPath) ? "present" : "missing",
    caption_draft_hash: artifactHash(draftPath),
    caption_approval: approval === null ? "missing" : approval.approval.status === "approved" ? "approved" : "stale",
    caption_approval_hash: artifactHash(approvalPath),
    caption_approval_binding_hash: approval === null ? null : captionApprovalBindingHash(approval),
    initialize_commands: initializeCommands,
    project_local_script_count: 0,
  };
}

export interface CaptionOwnerBoundaryInput {
  captions: Array<{ caption_id: string; text: string; start_frame: number; end_frame: number }>;
  content: Array<{
    element_id: string;
    template_ref: string;
    props: Record<string, unknown>;
    start_frame: number;
    end_frame: number;
  }>;
}

function semanticText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function assertCaptionContentOwnerBoundary(input: CaptionOwnerBoundaryInput): void {
  for (const element of input.content) {
    const manifest = resolveContentTemplate(element.template_ref);
    if (!manifest) {
      throw new Error(`graphical content ${element.element_id} must use a registered content template`);
    }
    const text = element.props[manifest.accessibility_label_prop];
    if (typeof text !== "string" || !text.trim()) continue;
    for (const caption of input.captions) {
      const overlaps = caption.start_frame < element.end_frame && element.start_frame < caption.end_frame;
      if (overlaps && semanticText(caption.text) === semanticText(text)) {
        throw new Error(
          `duplicate semantic owner: speech caption ${caption.caption_id} and graphical content ${element.element_id} render the same text`,
        );
      }
    }
  }
}
