/**
 * Projection manifest assembly, staleness evaluation, and review-receipt
 * binding (P2 manifest-level scope).
 *
 * Approval is bound to canonical artifact hashes, not to the HTML itself.
 * When any bound input changes, the projection becomes STALE and must not
 * be approved; receipts bound to stale hashes are invalid.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256FileHash } from "./hashes.js";
import type {
  ArtifactInputRecord,
  ArtifactRole,
  ProjectionManifest,
  ProjectionStatus,
  ReceiptStatus,
  ReviewReceipt,
  StalenessCheckResult,
} from "./types.js";

export function projectionDirPath(projectDir: string, projectionId: string): string {
  return path.join(projectDir, "04_plan", "review-projections", projectionId);
}

export function buildApprovalIdentity(manifest: Omit<ProjectionManifest, "approval_identity">): {
  artifact_hashes: Record<string, string | null>;
  delivery_hash: string;
  beat_count: number;
  total_frames: number;
} {
  return {
    artifact_hashes: { ...manifest.artifact_hashes },
    delivery_hash: deliveryIdentityHash(manifest.delivery.profiles.map((profile) => profile.hash)),
    beat_count: manifest.beat_count,
    total_frames: manifest.total_frames,
  };
}

/** Combined identity of selected delivery profiles (order-independent). */
export function deliveryIdentityHash(profileHashes: string[]): string {
  if (profileHashes.length === 0) return "source-aspect:no-delivery-profile";
  const digest = createHash("sha256").update([...profileHashes].sort().join("\n")).digest("hex");
  return `sha256:${digest}`;
}

// ── Staleness ───────────────────────────────────────────────────────

export interface ManifestReadResult {
  manifest: ProjectionManifest | null;
  error: string | null;
}

export function readProjectionManifest(projectionDir: string): ManifestReadResult {
  const manifestPath = path.join(projectionDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return { manifest: null, error: `manifest.json not found in ${projectionDir}` };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ProjectionManifest;
    if (manifest.version !== "editorial-storyboard-projection/v1") {
      return { manifest: null, error: `unsupported projection version: ${String(manifest.version)}` };
    }
    return { manifest, error: null };
  } catch (error) {
    return { manifest: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Recompute current hashes of every recorded input and compare with the
 * manifest. Missing required inputs make the projection INVALID; changed
 * hashes make it STALE.
 */
export function evaluateStaleness(options: {
  projectDir: string;
  manifest: ProjectionManifest;
}): StalenessCheckResult {
  const manifest = options.manifest;
  const staleInputs: StalenessCheckResult["stale_inputs"] = [];
  const missingInputs: StalenessCheckResult["missing_inputs"] = [];

  if (!Array.isArray(manifest.inputs) || manifest.inputs.length === 0) {
    return {
      status: "INVALID",
      approval_allowed: false,
      stale_inputs: [],
      missing_inputs: [{ role: "timeline", path: "<manifest inputs missing>" }],
      receipt_status: "invalid",
      receipt_detail: "manifest required canonical inputs are missing",
      regenerate_command: manifest.regenerate_command,
    };
  }

  for (const input of manifest.inputs ?? []) {
    const absPath = resolveInputAbsPath(options.projectDir, input);
    if (!absPath || !fs.existsSync(absPath)) {
      missingInputs.push({ role: input.role, path: input.path });
      continue;
    }
    if (input.hash === null) continue;
    const actual = sha256FileHash(absPath);
    if (actual !== input.hash) {
      staleInputs.push({ role: input.role, path: input.path, expected_hash: input.hash, actual_hash: actual });
    }
  }

  let status: ProjectionStatus = "CURRENT";
  const requiredMissing = missingInputs.filter((entry) =>
    (manifest.inputs ?? []).some((input) => input.role === entry.role && input.path === entry.path && input.required),
  );
  const incompleteCanonicalInputs = Object.entries(manifest.artifact_hashes ?? {}).some(([role, hash]) =>
    role !== "policies" && hash !== null && !manifest.inputs.some((input) => input.role === role && input.hash === hash));
  if (requiredMissing.length > 0 || incompleteCanonicalInputs || (manifest.invalid ?? []).length > 0) {
    status = "INVALID";
  } else if (staleInputs.length > 0) {
    status = "STALE";
  }

  const receipt = evaluateReceiptBinding(options.projectDir, manifest);
  const receiptStatus = receipt.status;

  const approvalAllowed =
    status === "CURRENT" &&
    (manifest.invalid ?? []).length === 0 &&
    (receiptStatus === "no_receipt" || receiptStatus === "valid");

  return {
    status,
    approval_allowed: approvalAllowed,
    stale_inputs: staleInputs,
    missing_inputs: missingInputs,
    receipt_status: receiptStatus,
    receipt_detail: receipt.detail,
    regenerate_command: manifest.regenerate_command,
  };
}

/**
 * P2 (manifest level): a review receipt is only meaningful while the
 * canonical hashes it was bound to are unchanged. A receipt whose bound
 * hashes differ from the manifest's approval identity is STALE and can no
 * longer approve anything.
 */
export function evaluateReceiptBinding(
  projectDir: string,
  manifest: ProjectionManifest,
): { status: ReceiptStatus; detail: string } {
  const receiptPath = path.join(projectDir, "04_plan", "review-projections", manifest.projection_id, "review-receipt.json");
  if (!fs.existsSync(receiptPath)) {
    return { status: "no_receipt", detail: "no review receipt recorded for this projection" };
  }
  let receipt: ReviewReceipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as ReviewReceipt;
  } catch (error) {
    return {
      status: "invalid",
      detail: `review receipt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (receipt.version !== "editorial-review-receipt/v1" || typeof receipt.approved !== "boolean") {
    return { status: "invalid", detail: "review receipt does not match editorial-review-receipt/v1" };
  }
  if (receipt.projection_id !== manifest.projection_id) {
    return { status: "invalid", detail: `receipt projection_id ${receipt.projection_id} does not match ${manifest.projection_id}` };
  }

  // Re-derive current hashes to catch drift since generation.
  const currentHashes: Record<string, string | null> = {};
  for (const [role, hash] of Object.entries(manifest.artifact_hashes)) {
    const input = (manifest.inputs ?? []).find((candidate) => candidate.role === role);
    const absPath = input ? resolveInputAbsPath(projectDir, input) : null;
    currentHashes[role] = absPath && fs.existsSync(absPath) ? sha256FileHash(absPath) : null;
  }

  const bound = receipt.bound_artifact_hashes ?? {};
  const drifted = Object.keys(currentHashes).filter(
    (role) => (bound[role] ?? null) !== null && bound[role] !== currentHashes[role],
  );
  if (drifted.length > 0) {
    return {
      status: "stale",
      detail: `receipt is bound to outdated artifact hashes (${drifted.join(", ")}); re-review required`,
    };
  }
  if ((receipt.bound_delivery_hash ?? "") !== manifest.approval_identity?.delivery_hash) {
    return { status: "stale", detail: "receipt delivery hash differs from the projection's approval identity" };
  }
  return {
    status: "valid",
    detail: receipt.approved
      ? "receipt is bound to the current canonical hashes"
      : "receipt exists but is not marked approved",
  };
}

function resolveInputAbsPath(projectDir: string, input: ArtifactInputRecord): string | null {
  // Policy records encode "refKey:path"; strip the key prefix.
  const relPath = input.role === "policy" ? input.path.replace(/^[^:]+:/, "") : input.path;
  if (path.isAbsolute(relPath)) return relPath;
  return path.join(projectDir, relPath);
}
