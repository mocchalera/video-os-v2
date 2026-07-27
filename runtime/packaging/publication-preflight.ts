import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateAgainstSchema } from "../commands/shared.js";
import { computeSha256 } from "./manifest.js";
import { resolveDeliveryArtifactPaths } from "./active-delivery.js";

export interface PublicationDestination {
  platform: "youtube" | "vimeo" | "instagram" | "tiktok" | "internal";
  visibility: "private" | "unlisted" | "public" | "workspace_only";
  account?: string;
  channel_id?: string;
  metadata_sha256?: string;
  notes?: string;
}

interface PublicationApproval {
  version: "publication-approval/v1" | "publication-approval/v2";
  project_id: string;
  canonical_video: { path: "09_output/final.mp4"; sha256: string };
  approvals: Record<"creative" | "rights" | "privacy", {
    status: "approved";
    approved_by: string;
    approved_at: string;
    scope: string;
    artifact_sha256: string;
  }>;
  destinations: PublicationDestination[];
}

export interface PublicationPreflightCheck {
  name: string;
  passed: boolean;
  details: string;
}

export interface PublicationPreflightResult {
  ready: boolean;
  project_id?: string;
  canonical_video?: { path: string; sha256: string };
  destinations?: PublicationDestination[];
  approval?: {
    version: PublicationApproval["version"];
    path: string;
    sha256: string;
  };
  checks: PublicationPreflightCheck[];
}

export interface PublicationDestinationRequest {
  platform: PublicationDestination["platform"];
  visibility: PublicationDestination["visibility"];
  channel_id?: string;
  metadata_sha256?: string;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function runPublicationPreflight(
  projectDir: string,
  requestedDestination?: PublicationDestinationRequest,
): PublicationPreflightResult {
  const absProjectDir = path.resolve(projectDir);
  const approvalPath = path.join(absProjectDir, "07_package", "publication_approval.yaml");
  const checks: PublicationPreflightCheck[] = [];
  let delivery: ReturnType<typeof resolveDeliveryArtifactPaths>;
  try {
    delivery = resolveDeliveryArtifactPaths(absProjectDir, { verifyHashes: true });
  } catch (error) {
    return {
      ready: false,
      checks: [{
        name: "active_delivery_pointer_valid",
        passed: false,
        details: error instanceof Error ? error.message : String(error),
      }],
    };
  }

  if (!fs.existsSync(approvalPath)) {
    return {
      ready: false,
      checks: [{
        name: "publication_approval_present",
        passed: false,
        details: "missing=07_package/publication_approval.yaml",
      }],
    };
  }

  let approval: PublicationApproval;
  try {
    approval = parseYaml(fs.readFileSync(approvalPath, "utf-8")) as PublicationApproval;
  } catch (error) {
    return {
      ready: false,
      checks: [{
        name: "publication_approval_schema_valid",
        passed: false,
        details: `parse_error=${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }

  const validation = validateAgainstSchema(approval, "publication-approval.schema.json");
  checks.push({
    name: "publication_approval_schema_valid",
    passed: validation.valid,
    details: validation.valid ? `schema=${approval.version}` : validation.errors.join("; "),
  });
  if (!validation.valid) return { ready: false, project_id: approval.project_id, checks };
  const approvalIdentity = {
    version: approval.version,
    path: approvalPath,
    sha256: computeSha256(approvalPath),
  };

  const canonicalPath = delivery.finalVideoPath;
  const canonicalExists = fs.existsSync(canonicalPath);
  checks.push({
    name: "canonical_video_present",
    passed: canonicalExists,
    details: `path=${path.relative(absProjectDir, canonicalPath)} source=${delivery.source}`,
  });
  if (!canonicalExists) {
    return {
      ready: false,
      project_id: approval.project_id,
      approval: approvalIdentity,
      checks,
    };
  }

  const actualSha256 = computeSha256(canonicalPath);
  checks.push({
    name: "canonical_video_hash_valid",
    passed: actualSha256 === approval.canonical_video.sha256,
    details: `approved=${approval.canonical_video.sha256} actual=${actualSha256}`,
  });

  for (const approvalKind of ["creative", "rights", "privacy"] as const) {
    const entry = approval.approvals[approvalKind];
    checks.push({
      name: `${approvalKind}_approval_bound_to_video`,
      passed: entry.artifact_sha256 === actualSha256,
      details: `approved_by=${entry.approved_by} artifact_sha256=${entry.artifact_sha256}`,
    });
  }

  const qaPath = delivery.qaReportPath;
  const qaReport = fs.existsSync(qaPath) ? readJson(qaPath) as { project_id?: string; passed?: boolean } : null;
  checks.push({
    name: "package_qa_passed",
    passed: qaReport?.passed === true,
    details: qaReport ? `passed=${String(qaReport.passed)}` : "missing=07_package/qa-report.json",
  });

  const manifestPath = delivery.packageManifestPath;
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) as {
    project_id?: string;
    artifacts?: { final_video?: { sha256?: string } };
  } : null;
  const manifestSha256 = manifest?.artifacts?.final_video?.sha256;
  checks.push({
    name: "package_manifest_bound_to_video",
    passed: manifestSha256 === actualSha256,
    details: manifestSha256
      ? `manifest=${manifestSha256} actual=${actualSha256}`
      : "missing=07_package/package_manifest.json#artifacts.final_video.sha256",
  });
  checks.push({
    name: "publication_project_identity_valid",
    passed: qaReport?.project_id === approval.project_id && manifest?.project_id === approval.project_id,
    details: `approval=${approval.project_id} qa=${qaReport?.project_id ?? "missing"} manifest=${manifest?.project_id ?? "missing"}`,
  });

  if (requestedDestination) {
    const destinationApproved = approval.destinations.some((destination) =>
      destination.platform === requestedDestination.platform &&
      destination.visibility === requestedDestination.visibility &&
      (
        requestedDestination.channel_id === undefined ||
        destination.channel_id === requestedDestination.channel_id
      ) &&
      (
        requestedDestination.metadata_sha256 === undefined ||
        destination.metadata_sha256 === requestedDestination.metadata_sha256
      )
    );
    checks.push({
      name: "destination_approved",
      passed: destinationApproved,
      details:
        `platform=${requestedDestination.platform} ` +
        `visibility=${requestedDestination.visibility} ` +
        `channel_id=${requestedDestination.channel_id ?? "not_requested"} ` +
        `metadata_sha256=${requestedDestination.metadata_sha256 ?? "not_requested"}`,
    });
  }

  return {
    ready: checks.every((check) => check.passed),
    project_id: approval.project_id,
    canonical_video: { path: canonicalPath, sha256: actualSha256 },
    destinations: approval.destinations,
    approval: approvalIdentity,
    checks,
  };
}
