import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { inspectFinalRenderReviewPack } from "./final-render-review-pack.js";

export const FINAL_RENDER_APPROVAL_VERSION = "final-render-approval/v1" as const;
export const FINAL_RENDER_APPROVAL_RELATIVE_PATH = "06_review/final-render-approval.json";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type FinalRenderChecklistDecision = "approved" | "not_applicable";
export type FinalRenderAudioDecision = "preserve" | "dialogue-clean" | "loudness-only";

export interface FinalRenderAudioChecklist {
  decision: FinalRenderAudioDecision;
  preview_reviewed: boolean;
  preview_path?: string;
  preview_sha256?: string;
  bgm: "none" | "approved";
}

export interface FinalRenderChecklist {
  captions: FinalRenderChecklistDecision;
  caption_typography: FinalRenderChecklistDecision;
  section_titles: FinalRenderChecklistDecision;
  visual_preview?: {
    reviewed: boolean;
    manifest_path?: string;
    manifest_sha256?: string;
  };
  audio: FinalRenderAudioChecklist;
  output_spec: "approved";
}

export interface FinalRenderApprovalBindings {
  creative_brief_sha256: string;
  timeline_sha256: string;
  caption_approval_sha256: string | null;
  music_cues_sha256: string | null;
}

export interface FinalRenderApproval {
  version: typeof FINAL_RENDER_APPROVAL_VERSION;
  project_id: string;
  approved_by: string;
  approved_at: string;
  checklist: FinalRenderChecklist;
  bindings: FinalRenderApprovalBindings;
  approval_key: string;
}

export interface FinalRenderApprovalInspection {
  status: "ready" | "missing" | "invalid" | "stale";
  ready: boolean;
  path: string;
  sha256?: string;
  approval?: FinalRenderApproval;
  issues: string[];
}

export interface FinalRenderApprovalPaths {
  approvalPath?: string;
  creativeBriefPath?: string;
  timelinePath?: string;
  captionApprovalPath?: string;
  musicCuesPath?: string;
}

export function finalRenderApprovalPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), FINAL_RENDER_APPROVAL_RELATIVE_PATH);
}

export function approveFinalRenderChecklist(
  projectDir: string,
  input: {
    approvedBy: string;
    approvedAt?: string;
    checklist: FinalRenderChecklist;
    paths?: FinalRenderApprovalPaths;
  },
): FinalRenderApproval {
  const absProject = path.resolve(projectDir);
  const approvedBy = input.approvedBy.trim();
  if (!approvedBy) throw new Error("approvedBy is required");
  const approvedAt = input.approvedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(approvedAt))) throw new Error("approvedAt must be a valid ISO date");
  assertChecklistComplete(absProject, input.checklist);
  assertChecklistMatchesProject(absProject, input.checklist, input.paths);
  const bindings = computeFinalRenderApprovalBindings(absProject, input.paths);
  const projectId = readProjectId(absProject, input.paths);
  const approvalKey = computeFinalRenderApprovalKey({
    project_id: projectId,
    checklist: input.checklist,
    bindings,
  });
  const approval: FinalRenderApproval = {
    version: FINAL_RENDER_APPROVAL_VERSION,
    project_id: projectId,
    approved_by: approvedBy,
    approved_at: approvedAt,
    checklist: input.checklist,
    bindings,
    approval_key: approvalKey,
  };
  const outputPath = path.resolve(
    input.paths?.approvalPath ?? finalRenderApprovalPath(absProject),
  );
  assertProjectContained(absProject, outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
  return approval;
}

export function inspectFinalRenderApproval(
  projectDir: string,
  paths: FinalRenderApprovalPaths = {},
): FinalRenderApprovalInspection {
  const absProject = path.resolve(projectDir);
  const approvalPath = path.resolve(paths.approvalPath ?? finalRenderApprovalPath(absProject));
  if (!fs.existsSync(approvalPath)) {
    return {
      status: "missing",
      ready: false,
      path: approvalPath,
      issues: ["final render approval is missing"],
    };
  }

  let approval: FinalRenderApproval;
  try {
    approval = JSON.parse(fs.readFileSync(approvalPath, "utf8")) as FinalRenderApproval;
  } catch {
    return {
      status: "invalid",
      ready: false,
      path: approvalPath,
      issues: ["final render approval is malformed"],
    };
  }

  const structuralIssues = validateApprovalShape(absProject, approval);
  if (structuralIssues.length > 0) {
    return {
      status: "invalid",
      ready: false,
      path: approvalPath,
      sha256: hashFile(approvalPath),
      approval,
      issues: structuralIssues,
    };
  }

  let currentBindings: FinalRenderApprovalBindings;
  let currentProjectId: string;
  try {
    currentBindings = computeFinalRenderApprovalBindings(absProject, paths);
    currentProjectId = readProjectId(absProject, paths);
  } catch (error) {
    return {
      status: "invalid",
      ready: false,
      path: approvalPath,
      sha256: hashFile(approvalPath),
      approval,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }

  const staleIssues: string[] = [];
  if (approval.project_id !== currentProjectId) {
    staleIssues.push(`project_id expected=${currentProjectId} approved=${approval.project_id}`);
  }
  for (const key of Object.keys(currentBindings) as Array<keyof FinalRenderApprovalBindings>) {
    if (approval.bindings[key] !== currentBindings[key]) {
      staleIssues.push(`${key} expected=${currentBindings[key] ?? "null"} approved=${approval.bindings[key] ?? "null"}`);
    }
  }
  try {
    assertChecklistMatchesProject(absProject, approval.checklist, paths);
  } catch (error) {
    staleIssues.push(error instanceof Error ? error.message : String(error));
  }
  const expectedKey = computeFinalRenderApprovalKey({
    project_id: approval.project_id,
    checklist: approval.checklist,
    bindings: approval.bindings,
  });
  if (approval.approval_key !== expectedKey) {
    staleIssues.push(`approval_key expected=${expectedKey} approved=${approval.approval_key}`);
  }
  if (approval.checklist.audio.preview_path && approval.checklist.audio.preview_sha256) {
    try {
      const previewPath = resolveProjectRelative(absProject, approval.checklist.audio.preview_path);
      if (!fs.existsSync(previewPath)) {
        staleIssues.push(`audio preview is missing: ${approval.checklist.audio.preview_path}`);
      } else {
        const previewHash = hashFile(previewPath);
        if (previewHash !== approval.checklist.audio.preview_sha256) {
          staleIssues.push(
            `audio preview hash expected=${previewHash} approved=${approval.checklist.audio.preview_sha256}`,
          );
        }
      }
    } catch (error) {
      staleIssues.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (
    approval.checklist.visual_preview?.manifest_path
    && approval.checklist.visual_preview.manifest_sha256
  ) {
    try {
      const manifestPath = resolveProjectRelative(
        absProject,
        approval.checklist.visual_preview.manifest_path,
      );
      if (!fs.existsSync(manifestPath)) {
        staleIssues.push(
          `visual review manifest is missing: ${approval.checklist.visual_preview.manifest_path}`,
        );
      } else {
        const manifestHash = hashFile(manifestPath);
        if (manifestHash !== approval.checklist.visual_preview.manifest_sha256) {
          staleIssues.push(
            `visual review manifest hash expected=${manifestHash} approved=${approval.checklist.visual_preview.manifest_sha256}`,
          );
        }
        const reviewPack = inspectFinalRenderReviewPack(
          absProject,
          approval.checklist.visual_preview.manifest_path,
        );
        staleIssues.push(...reviewPack.issues.map((issue) => `visual review pack: ${issue}`));
      }
    } catch (error) {
      staleIssues.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (staleIssues.length > 0) {
    return {
      status: "stale",
      ready: false,
      path: approvalPath,
      sha256: hashFile(approvalPath),
      approval,
      issues: staleIssues,
    };
  }
  return {
    status: "ready",
    ready: true,
    path: approvalPath,
    sha256: hashFile(approvalPath),
    approval,
    issues: [],
  };
}

export function assertFinalRenderApprovalCurrent(
  projectDir: string,
  paths: FinalRenderApprovalPaths = {},
): FinalRenderApprovalInspection & { status: "ready"; ready: true; approval: FinalRenderApproval; sha256: string } {
  const inspection = inspectFinalRenderApproval(projectDir, paths);
  if (
    inspection.status !== "ready"
    || !inspection.approval
    || !inspection.sha256
  ) {
    throw new Error(
      `final render approval is ${inspection.status}: ${inspection.issues.join("; ")}`,
    );
  }
  return inspection as FinalRenderApprovalInspection & {
    status: "ready";
    ready: true;
    approval: FinalRenderApproval;
    sha256: string;
  };
}

export function computeFinalRenderApprovalBindings(
  projectDir: string,
  paths: FinalRenderApprovalPaths = {},
): FinalRenderApprovalBindings {
  const absProject = path.resolve(projectDir);
  const creativeBriefPath = path.resolve(
    paths.creativeBriefPath ?? path.join(absProject, "01_intent", "creative_brief.yaml"),
  );
  const timelinePath = path.resolve(
    paths.timelinePath ?? path.join(absProject, "05_timeline", "timeline.json"),
  );
  const captionApprovalPath = path.resolve(
    paths.captionApprovalPath ?? path.join(absProject, "07_package", "caption_approval.json"),
  );
  const musicCuesPath = path.resolve(
    paths.musicCuesPath ?? path.join(absProject, "07_package", "music_cues.json"),
  );
  for (const requiredPath of [creativeBriefPath, timelinePath]) {
    assertProjectContained(absProject, requiredPath);
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`final render binding input is missing: ${projectRelative(absProject, requiredPath)}`);
    }
  }
  return {
    creative_brief_sha256: hashFile(creativeBriefPath),
    timeline_sha256: hashFile(timelinePath),
    caption_approval_sha256: fs.existsSync(captionApprovalPath) ? hashFile(captionApprovalPath) : null,
    music_cues_sha256: fs.existsSync(musicCuesPath) ? hashFile(musicCuesPath) : null,
  };
}

export function computeFinalRenderApprovalKey(input: {
  project_id: string;
  checklist: FinalRenderChecklist;
  bindings: FinalRenderApprovalBindings;
}): string {
  return hashBytes(canonicalJson(input));
}

function assertChecklistComplete(
  projectDir: string,
  checklist: FinalRenderChecklist,
  verifyArtifacts = true,
): void {
  const approvalValues = [
    checklist.captions,
    checklist.caption_typography,
    checklist.section_titles,
  ];
  if (approvalValues.some((value) => value !== "approved" && value !== "not_applicable")) {
    throw new Error("caption and section checklist entries must be approved or not_applicable");
  }
  if (checklist.output_spec !== "approved") {
    throw new Error("output_spec must be approved");
  }
  if (!["preserve", "dialogue-clean", "loudness-only"].includes(checklist.audio.decision)) {
    throw new Error(`unsupported audio decision: ${String(checklist.audio.decision)}`);
  }
  if (!["none", "approved"].includes(checklist.audio.bgm)) {
    throw new Error(`unsupported BGM decision: ${String(checklist.audio.bgm)}`);
  }
  if (checklist.audio.decision !== "preserve") {
    if (
      checklist.audio.preview_reviewed !== true
      || !checklist.audio.preview_path
      || !SHA256_PATTERN.test(checklist.audio.preview_sha256 ?? "")
    ) {
      throw new Error("audio preview must be reviewed and hash-bound before dialogue processing");
    }
    if (verifyArtifacts) {
      const previewPath = resolveProjectRelative(projectDir, checklist.audio.preview_path);
      if (!fs.existsSync(previewPath)) throw new Error(`audio preview is missing: ${checklist.audio.preview_path}`);
      if (hashFile(previewPath) !== checklist.audio.preview_sha256) {
        throw new Error("audio preview hash does not match the reviewed artifact");
      }
    }
  }
  const visualReviewRequired = approvalValues.includes("approved");
  if (visualReviewRequired) {
    if (
      checklist.visual_preview?.reviewed !== true
      || !checklist.visual_preview.manifest_path
      || !SHA256_PATTERN.test(checklist.visual_preview.manifest_sha256 ?? "")
    ) {
      throw new Error(
        "a current visual review pack must be reviewed and hash-bound before approving captions or section titles",
      );
    }
    if (verifyArtifacts) {
      const manifestPath = resolveProjectRelative(
        projectDir,
        checklist.visual_preview.manifest_path,
      );
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`visual review manifest is missing: ${checklist.visual_preview.manifest_path}`);
      }
      if (hashFile(manifestPath) !== checklist.visual_preview.manifest_sha256) {
        throw new Error("visual review manifest hash does not match the reviewed artifact");
      }
      const reviewPack = inspectFinalRenderReviewPack(
        projectDir,
        checklist.visual_preview.manifest_path,
      );
      if (!reviewPack.ready) {
        throw new Error(`visual review pack is stale or invalid: ${reviewPack.issues.join("; ")}`);
      }
    }
  }
}

function assertChecklistMatchesProject(
  projectDir: string,
  checklist: FinalRenderChecklist,
  paths: FinalRenderApprovalPaths = {},
): void {
  const timelinePath = path.resolve(
    paths.timelinePath ?? path.join(projectDir, "05_timeline", "timeline.json"),
  );
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as {
    metadata?: { audio_finish?: { preset?: unknown } };
    tracks?: { audio?: Array<{ track_id?: unknown; clips?: Array<{ role?: unknown }> }> };
  };
  const preset = timeline.metadata?.audio_finish?.preset;
  const currentAudioDecision: FinalRenderAudioDecision =
    preset === "dialogue-clean" || preset === "loudness-only"
      ? preset
      : "preserve";
  if (checklist.audio.decision !== currentAudioDecision) {
    throw new Error(
      `audio decision does not match timeline.metadata.audio_finish: approved=${checklist.audio.decision} current=${currentAudioDecision}`,
    );
  }
  const timelineHasBgm = (timeline.tracks?.audio ?? []).some((track) => {
    const clips = track.clips ?? [];
    return clips.length > 0 && (
      track.track_id === "A2"
      || clips.some((clip) => clip.role === "bgm" || clip.role === "music")
    );
  });
  const musicCuesPath = path.resolve(
    paths.musicCuesPath ?? path.join(projectDir, "07_package", "music_cues.json"),
  );
  const currentBgm = timelineHasBgm || fs.existsSync(musicCuesPath);
  if ((checklist.audio.bgm === "approved") !== currentBgm) {
    throw new Error(
      `BGM decision does not match current render inputs: approved=${checklist.audio.bgm} current=${currentBgm ? "approved" : "none"}`,
    );
  }
}

function validateApprovalShape(projectDir: string, approval: FinalRenderApproval): string[] {
  const issues: string[] = [];
  if (approval.version !== FINAL_RENDER_APPROVAL_VERSION) issues.push("final render approval version is invalid");
  if (typeof approval.project_id !== "string" || approval.project_id.trim().length === 0) {
    issues.push("final render approval project_id is missing");
  }
  if (typeof approval.approved_by !== "string" || approval.approved_by.trim().length === 0) {
    issues.push("final render approval approved_by is missing");
  }
  if (typeof approval.approved_at !== "string" || !Number.isFinite(Date.parse(approval.approved_at))) {
    issues.push("final render approval approved_at is invalid");
  }
  if (!approval.checklist || !approval.bindings) {
    issues.push("final render approval checklist or bindings are missing");
    return issues;
  }
  if (!SHA256_PATTERN.test(approval.approval_key ?? "")) {
    issues.push("final render approval key is invalid");
  }
  for (const [key, value] of Object.entries(approval.bindings)) {
    if (value !== null && !SHA256_PATTERN.test(String(value))) {
      issues.push(`final render approval binding ${key} is invalid`);
    }
  }
  try {
    assertChecklistComplete(projectDir, approval.checklist, false);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return issues;
}

function readProjectId(projectDir: string, paths: FinalRenderApprovalPaths = {}): string {
  const timelinePath = path.resolve(
    paths.timelinePath ?? path.join(projectDir, "05_timeline", "timeline.json"),
  );
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as { project_id?: unknown };
  if (typeof timeline.project_id === "string" && timeline.project_id.trim()) {
    return timeline.project_id.trim();
  }
  const briefPath = path.resolve(
    paths.creativeBriefPath ?? path.join(projectDir, "01_intent", "creative_brief.yaml"),
  );
  const brief = parseYaml(fs.readFileSync(briefPath, "utf8")) as {
    project_id?: unknown;
    project?: { id?: unknown };
  };
  const candidate = typeof brief.project_id === "string"
    ? brief.project_id
    : typeof brief.project?.id === "string"
      ? brief.project.id
      : "";
  if (!candidate.trim()) throw new Error("final render approval project_id could not be resolved");
  return candidate.trim();
}

function hashFile(filePath: string): string {
  return hashBytes(fs.readFileSync(filePath));
}

function hashBytes(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function resolveProjectRelative(projectDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("final render approval paths must be project-relative");
  const resolved = path.resolve(projectDir, relativePath);
  assertProjectContained(projectDir, resolved);
  return resolved;
}

function assertProjectContained(projectDir: string, candidate: string): void {
  const relative = path.relative(path.resolve(projectDir), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`final render approval path escapes project root: ${candidate}`);
}

function projectRelative(projectDir: string, filePath: string): string {
  return path.relative(projectDir, filePath).split(path.sep).join("/");
}
