import * as fs from "node:fs";
import * as path from "node:path";
import { materializeFileSync } from "../filesystem/materialize-file.js";
import { computeSha256 } from "../packaging/manifest.js";

export interface DirectRenderStagingReceipt {
  version: "direct-render-staging-receipt/v1";
  source_path: string;
  source_sha256: string;
  staged_path: string;
  staged_sha256: string;
  staged_at: string;
}

export interface DirectRenderRepairPlan {
  version: "direct-render-repair-plan/v1";
  dry_run: boolean;
  source_path: string;
  source_exists: boolean;
  would_stage_path: string;
  would_write_receipt: string;
  canonical_overwrite_allowed: false;
}

export function stageDirectRenderOutput(
  sourcePath: string,
  generationDir: string,
  createdAt = new Date().toISOString(),
): { stagedPath: string; receiptPath: string; receipt: DirectRenderStagingReceipt } {
  const source = path.resolve(sourcePath);
  if (!fs.existsSync(source)) throw new Error(`direct render output not found: ${source}`);
  const stagingDir = path.join(generationDir, "staging");
  fs.mkdirSync(stagingDir, { recursive: true });
  const stagedPath = path.join(stagingDir, "direct-render.mp4");
  if (path.resolve(stagedPath) === source) {
    throw new Error("direct render source must be outside its receipt-backed staging output");
  }
  materializeFileSync(source, stagedPath);
  const sourceSha256 = computeSha256(source);
  const stagedSha256 = computeSha256(stagedPath);
  if (sourceSha256 !== stagedSha256) throw new Error("direct render staging hash mismatch");
  const receipt: DirectRenderStagingReceipt = {
    version: "direct-render-staging-receipt/v1",
    source_path: source,
    source_sha256: sourceSha256,
    staged_path: stagedPath,
    staged_sha256: stagedSha256,
    staged_at: createdAt,
  };
  const receiptPath = path.join(stagingDir, "direct-render-receipt.json");
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { stagedPath, receiptPath, receipt };
}

export function buildDirectRenderRepairPlan(
  projectDir: string,
  sourcePath = path.join(path.resolve(projectDir), "09_output", "final.mp4"),
): DirectRenderRepairPlan {
  const source = path.resolve(sourcePath);
  const repairRoot = path.join(
    path.resolve(projectDir),
    "07_package",
    "caption-finalize",
    "repair-staging",
  );
  return {
    version: "direct-render-repair-plan/v1",
    dry_run: true,
    source_path: source,
    source_exists: fs.existsSync(source),
    would_stage_path: path.join(repairRoot, "direct-render.mp4"),
    would_write_receipt: path.join(repairRoot, "direct-render-receipt.json"),
    canonical_overwrite_allowed: false,
  };
}
