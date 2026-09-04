import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateArtifact } from "./loaders.js";

export const DEGRADED_OUTPUT_WRITER_TOOL = "video-os-project-output-writer/v1" as const;
export const DEGRADED_REPLACED_COMMAND = "npx tsx scripts/caption-review.ts visual-author-preview --project <project>" as const;
export const DEGRADED_REPLACED_CAPABILITY = "caption-visual-treatment-preview/v1" as const;
const MAX_RECEIPT_AGE_MS = 15 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

export interface DegradedRouteReceipt {
  version: "degraded-route-receipt/v1";
  project_id: string;
  replaced_canonical: { command: typeof DEGRADED_REPLACED_COMMAND; capability: typeof DEGRADED_REPLACED_CAPABILITY };
  reason: string;
  input: { path: string; sha256: string };
  output: { path: string; sha256: string };
  actor: { name: string; tool: typeof DEGRADED_OUTPUT_WRITER_TOOL };
  created_at: string;
  scope: "review_only_degraded";
  production_approval: { status: "unchanged"; path: "07_package/caption_approval.json"; sha256: string };
}

interface ApprovalIdentity {
  project_id: string;
  approval: { status: "approved" | "stale"; approved_by?: string; approved_at?: string };
}

function containedPath(projectDir: string, relativePath: string, label: string): string {
  if (path.isAbsolute(relativePath)) throw new Error(`${label} path must be project-relative`);
  const root = path.resolve(projectDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} path is not contained in the project`);
  }
  assertNoSymlinkComponents(root, resolved, label);
  return resolved;
}

function assertNoSymlinkComponents(root: string, candidate: string, label: string): void {
  let cursor = root;
  for (const component of path.relative(root, candidate).split(path.sep)) {
    cursor = path.join(cursor, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} path contains a symlink`);
  }
}

function fileHash(filePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function requireRegularFile(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}

function validateReceipt(options: {
  projectDir: string;
  outputPath: string;
  payloadPath: string;
  receiptPath?: string;
  now?: string;
}): DegradedRouteReceipt {
  if (!options.receiptPath) throw new Error("degraded-route receipt is required before a noncanonical project output write");
  const projectDir = path.resolve(options.projectDir);
  const outputPath = path.resolve(options.outputPath);
  const outputRoot = path.join(projectDir, "09_output");
  if (!outputPath.startsWith(`${outputRoot}${path.sep}`)) throw new Error("degraded output must be contained in project 09_output");
  assertNoSymlinkComponents(projectDir, outputPath, "degraded output");
  const receiptPath = path.resolve(options.receiptPath);
  if (!receiptPath.startsWith(`${projectDir}${path.sep}`)) throw new Error("degraded-route receipt must be contained in the project");
  assertNoSymlinkComponents(projectDir, receiptPath, "degraded-route receipt");
  requireRegularFile(receiptPath, "degraded-route receipt");

  let receipt: DegradedRouteReceipt;
  try {
    receipt = validateArtifact<DegradedRouteReceipt>(JSON.parse(fs.readFileSync(receiptPath, "utf8")), "degraded-route-receipt.schema.json");
  } catch (error) {
    throw new Error(`degraded-route receipt schema validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (receipt.replaced_canonical.command !== DEGRADED_REPLACED_COMMAND
    || receipt.replaced_canonical.capability !== DEGRADED_REPLACED_CAPABILITY) {
    throw new Error("degraded-route receipt canonical command or capability is not registered");
  }
  if (receipt.actor.tool !== DEGRADED_OUTPUT_WRITER_TOOL) throw new Error("degraded-route receipt producer tool is not registered");

  const inputPath = containedPath(projectDir, receipt.input.path, "input");
  const receiptOutputPath = containedPath(projectDir, receipt.output.path, "output");
  if (receiptOutputPath !== outputPath) throw new Error("degraded-route receipt output identity mismatch");
  requireRegularFile(inputPath, "degraded input");
  requireRegularFile(options.payloadPath, "degraded output payload");
  if (fileHash(inputPath) !== receipt.input.sha256) throw new Error("degraded-route receipt input hash is stale");
  if (fileHash(options.payloadPath) !== receipt.output.sha256) throw new Error("degraded-route receipt output hash is stale");

  const approvalPath = containedPath(projectDir, receipt.production_approval.path, "production approval");
  requireRegularFile(approvalPath, "production approval");
  const approval = validateArtifact<ApprovalIdentity>(JSON.parse(fs.readFileSync(approvalPath, "utf8")), "caption-approval.schema.json");
  if (approval.approval.status !== "approved") throw new Error("production caption approval is not approved");
  if (receipt.project_id !== approval.project_id) throw new Error("degraded-route receipt project identity mismatch");
  if (!approval.approval.approved_by || receipt.actor.name !== approval.approval.approved_by) {
    throw new Error("degraded-route receipt actor is not bound to the production approval reviewer");
  }
  const approvalHash = fileHash(approvalPath);
  if (receipt.production_approval.sha256 !== approvalHash) throw new Error("degraded-route receipt production approval hash is stale");

  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  const createdMs = Date.parse(receipt.created_at);
  const approvedMs = Date.parse(approval.approval.approved_at ?? "");
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) throw new Error("degraded-route receipt timestamp is invalid");
  if (createdMs > nowMs + MAX_FUTURE_SKEW_MS) throw new Error("degraded-route receipt timestamp is in the future");
  if (createdMs < nowMs - MAX_RECEIPT_AGE_MS) throw new Error("degraded-route receipt timestamp is too old");
  if (Number.isFinite(approvedMs) && createdMs < approvedMs) throw new Error("degraded-route receipt predates production approval");
  return receipt;
}

/** Post-write verification for callers that need to re-audit an existing review-only output. */
export function verifyDegradedProjectOutput(options: {
  projectDir: string;
  outputPath: string;
  receiptPath?: string;
  now?: string;
}): DegradedRouteReceipt {
  return validateReceipt({ ...options, payloadPath: path.resolve(options.outputPath) });
}

/**
 * The production degraded escape hatch. Receipt, producer, approval, source,
 * destination and freshness are checked before the first destination write.
 */
export function publishDegradedProjectOutput(options: {
  projectDir: string;
  sourcePath: string;
  outputPath: string;
  receiptPath?: string;
  now?: string;
}): DegradedRouteReceipt {
  const sourcePath = path.resolve(options.sourcePath);
  requireRegularFile(sourcePath, "degraded output source");
  const outputPath = path.resolve(options.outputPath);
  if (fs.existsSync(outputPath)) throw new Error("degraded review-only output already exists; version the output before publishing");
  const receipt = validateReceipt({
    projectDir: options.projectDir,
    outputPath,
    payloadPath: sourcePath,
    receiptPath: options.receiptPath,
    now: options.now,
  });
  const approvalPath = path.join(path.resolve(options.projectDir), receipt.production_approval.path);
  const approvalHashBefore = fileHash(approvalPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, fs.readFileSync(sourcePath), { flag: "wx" });
  fs.renameSync(temporary, outputPath);
  if (fileHash(approvalPath) !== approvalHashBefore) {
    fs.unlinkSync(outputPath);
    throw new Error("production approval changed during degraded output publication");
  }
  return receipt;
}
