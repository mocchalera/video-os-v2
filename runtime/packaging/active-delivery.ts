import * as fs from "node:fs";
import * as path from "node:path";
import { validateAgainstSchema } from "../commands/shared.js";
import { computeSha256 } from "./manifest.js";

export const ACTIVE_DELIVERY_RELATIVE_PATH = "07_package/active_delivery.json";
export const CAPTION_FINALIZE_ROOT_RELATIVE_PATH = "07_package/caption-finalize";

export interface ActiveDeliveryArtifact {
  path: string;
  sha256: string;
  size_bytes?: number;
  mtime_ms?: number;
}

export interface ActiveDelivery {
  version: "active-delivery/v1";
  project_id: string;
  generation_id: string;
  generation_path: string;
  activated_at: string;
  approval_intent: ActiveDeliveryArtifact;
  inputs: {
    approval_sha256: string;
    timeline_sha256: string;
    final_render_approval_sha256?: string;
    generation_key: string;
  };
  artifacts: {
    caption_ass: ActiveDeliveryArtifact;
    caption_srt: ActiveDeliveryArtifact;
    final_video: ActiveDeliveryArtifact;
    qa_report: ActiveDeliveryArtifact;
    package_manifest: ActiveDeliveryArtifact;
    preview: ActiveDeliveryArtifact;
    preview_receipt: ActiveDeliveryArtifact;
    receipt: ActiveDeliveryArtifact;
  };
}

export interface DeliveryArtifactPaths {
  source: "active_delivery" | "legacy";
  activeDelivery?: ActiveDelivery;
  captionApprovalPath: string;
  captionAssPath: string;
  captionSrtPath: string;
  finalVideoPath: string;
  qaReportPath: string;
  packageManifestPath: string;
  previewPath: string;
  previewReceiptPath?: string;
  receiptPath?: string;
  finalMixPath: string;
  packageFinalVideoPath: string;
}

export interface ResolveActiveDeliveryOptions {
  verifyHashes?: boolean;
}

export class InvalidActiveDeliveryPointerError extends Error {
  readonly code = "INVALID_ACTIVE_DELIVERY_POINTER" as const;

  constructor(pointerPath: string) {
    super(`active delivery pointer is present but invalid: ${pointerPath}`);
    this.name = "InvalidActiveDeliveryPointerError";
  }
}

export function activeDeliveryPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), ACTIVE_DELIVERY_RELATIVE_PATH);
}

export function resolveDeliveryArtifactPaths(
  projectDir: string,
  options: ResolveActiveDeliveryOptions = {},
): DeliveryArtifactPaths {
  const absProject = path.resolve(projectDir);
  const active = readActiveDelivery(absProject, options);
  if (active) {
    const generationDir = resolveProjectRelativePath(absProject, active.generation_path);
    return {
      source: "active_delivery",
      activeDelivery: active,
      captionApprovalPath: resolveIntentPath(absProject, active.approval_intent),
      captionAssPath: resolveArtifactPath(absProject, generationDir, active.artifacts.caption_ass),
      captionSrtPath: resolveArtifactPath(absProject, generationDir, active.artifacts.caption_srt),
      finalVideoPath: resolveArtifactPath(absProject, generationDir, active.artifacts.final_video),
      qaReportPath: resolveArtifactPath(absProject, generationDir, active.artifacts.qa_report),
      packageManifestPath: resolveArtifactPath(absProject, generationDir, active.artifacts.package_manifest),
      previewPath: resolveArtifactPath(absProject, generationDir, active.artifacts.preview),
      previewReceiptPath: resolveArtifactPath(absProject, generationDir, active.artifacts.preview_receipt),
      receiptPath: resolveArtifactPath(absProject, generationDir, active.artifacts.receipt),
      finalMixPath: path.join(generationDir, "audio", "final_mix.wav"),
      packageFinalVideoPath: path.join(generationDir, "video", "final.mp4"),
    };
  }

  const pointerPath = activeDeliveryPath(absProject);
  if (fs.existsSync(pointerPath)) throw new InvalidActiveDeliveryPointerError(pointerPath);

  return {
    source: "legacy",
    captionApprovalPath: path.join(absProject, "07_package", "caption_approval.json"),
    captionAssPath: path.join(absProject, "07_package", "captions", "speech.ass"),
    captionSrtPath: path.join(absProject, "07_package", "captions", "speech.approved.srt"),
    finalVideoPath: path.join(absProject, "09_output", "final.mp4"),
    qaReportPath: path.join(absProject, "07_package", "qa-report.json"),
    packageManifestPath: path.join(absProject, "07_package", "package_manifest.json"),
    previewPath: path.join(absProject, "09_output", "final.mp4"),
    finalMixPath: path.join(absProject, "07_package", "audio", "final_mix.wav"),
    packageFinalVideoPath: path.join(absProject, "07_package", "video", "final.mp4"),
  };
}

export function readActiveDelivery(
  projectDir: string,
  options: ResolveActiveDeliveryOptions = {},
): ActiveDelivery | null {
  const absProject = path.resolve(projectDir);
  const pointerPath = activeDeliveryPath(absProject);
  if (!fs.existsSync(pointerPath)) return null;

  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  } catch {
    return null;
  }
  const validation = validateAgainstSchema(value, "active-delivery.schema.json");
  if (!validation.valid) return null;

  const active = value as ActiveDelivery;
  let generationDir: string;
  try {
    generationDir = resolveProjectRelativePath(absProject, active.generation_path);
    const expectedRoot = path.join(absProject, CAPTION_FINALIZE_ROOT_RELATIVE_PATH, "generations");
    assertContained(expectedRoot, generationDir);
    const artifacts = [
      active.artifacts.caption_ass,
      active.artifacts.caption_srt,
      active.artifacts.final_video,
      active.artifacts.qa_report,
      active.artifacts.package_manifest,
      active.artifacts.preview,
      active.artifacts.preview_receipt,
      active.artifacts.receipt,
    ];
    for (const artifact of artifacts) {
      const artifactPath = resolveArtifactPath(absProject, generationDir, artifact);
      if (!fs.existsSync(artifactPath)) return null;
      if (options.verifyHashes && computeSha256(artifactPath) !== artifact.sha256) return null;
    }
    const intentPath = resolveIntentPath(absProject, active.approval_intent);
    if (!fs.existsSync(intentPath)) return null;
    if (options.verifyHashes && computeSha256(intentPath) !== active.approval_intent.sha256) return null;
  } catch {
    return null;
  }
  return active;
}

function resolveIntentPath(projectDir: string, artifact: ActiveDeliveryArtifact): string {
  const resolved = resolveProjectRelativePath(projectDir, artifact.path);
  assertContained(path.join(projectDir, CAPTION_FINALIZE_ROOT_RELATIVE_PATH, "intents"), resolved);
  return resolved;
}

function resolveArtifactPath(
  projectDir: string,
  generationDir: string,
  artifact: ActiveDeliveryArtifact,
): string {
  const resolved = resolveProjectRelativePath(projectDir, artifact.path);
  assertContained(generationDir, resolved);
  return resolved;
}

function resolveProjectRelativePath(projectDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("active delivery paths must be relative");
  const resolved = path.resolve(projectDir, relativePath);
  assertContained(projectDir, resolved);
  return resolved;
}

function assertContained(parent: string, candidate: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`path escapes active delivery root: ${candidate}`);
}
