import * as fs from "node:fs";
import * as path from "node:path";
import { validateArtifact } from "../artifacts/loaders.js";
import {
  canonicalJson,
  hashCanonical,
  sha256File,
  verifyLatestGeneration,
  verifyReviewReadyReceipt,
  type BoundGenerationArtifact,
  type SocialReviewGeneration,
  type SocialReviewGenerationReceipt,
} from "./social-review-generation.js";

export interface ReencodeTransform {
  container: "mp4";
  video_codec: "h264";
  max_width: number;
  crf: number;
}

export interface ReencodeReceipt {
  version: "review-reencode-receipt/v1";
  generation_id: string;
  source_generation_id: string;
  source_output_sha256: string;
  source_receipt: BoundGenerationArtifact;
  transform: ReencodeTransform;
  transform_sha256: string;
  output: { path: string; sha256: string };
  review_only: true;
}

function verifyCurrentSourceGeneration(
  generation: SocialReviewGeneration,
  receipt: SocialReviewGenerationReceipt,
): BoundGenerationArtifact {
  verifyReviewReadyReceipt(generation, receipt);
  if (!receipt.review_ready) throw new Error("re-encode source generation is not review-ready");
  if (!fs.existsSync(generation.receipt_path)) throw new Error("re-encode source receipt is missing");
  const receiptArtifact = {
    path: path.relative(generation.project_dir, generation.receipt_path).split(path.sep).join("/"),
    sha256: sha256File(generation.receipt_path),
  };
  const latest = verifyLatestGeneration(generation.project_dir);
  if (latest.generation_id !== generation.generation_id
    || latest.receipt_path !== receiptArtifact.path
    || latest.receipt_sha256 !== receiptArtifact.sha256) {
    throw new Error("re-encode source generation is not the currently verified latest binding");
  }
  return receiptArtifact;
}

export interface ReencodeGeneration {
  generation_id: string;
  generation_dir: string;
  output_path: string;
  source_generation: SocialReviewGeneration;
  source_receipt: SocialReviewGenerationReceipt;
  source_receipt_artifact: BoundGenerationArtifact;
  transform: ReencodeTransform;
  transform_sha256: string;
  buildReceipt(): ReencodeReceipt;
}

function validateTransform(transform: ReencodeTransform): void {
  if (transform.container !== "mp4" || transform.video_codec !== "h264"
    || !Number.isInteger(transform.max_width) || transform.max_width <= 0
    || !Number.isInteger(transform.crf) || transform.crf < 0 || transform.crf > 51) {
    throw new Error("invalid re-encode transform conditions");
  }
}

export function buildReencodeGeneration(input: {
  sourceGeneration: SocialReviewGeneration;
  sourceReceipt: SocialReviewGenerationReceipt;
  transform: ReencodeTransform;
}): ReencodeGeneration {
  validateTransform(input.transform);
  const sourceReceiptArtifact = verifyCurrentSourceGeneration(input.sourceGeneration, input.sourceReceipt);
  if (input.sourceReceipt.generation_id !== input.sourceGeneration.generation_id
    || sha256File(input.sourceGeneration.output_path) !== input.sourceReceipt.output.sha256) {
    throw new Error("re-encode source generation hash mismatch");
  }
  const transformHash = hashCanonical(input.transform);
  const generationId = hashCanonical({
    version: "review-reencode-generation/v1",
    source_generation_id: input.sourceGeneration.generation_id,
    source_output_sha256: input.sourceReceipt.output.sha256,
    source_receipt_sha256: sourceReceiptArtifact.sha256,
    transform_sha256: transformHash,
  });
  const generationDir = path.join(input.sourceGeneration.project_dir, "09_output", "social-review", "reencodes", generationId.slice(7));
  const generation: ReencodeGeneration = {
    generation_id: generationId,
    generation_dir: generationDir,
    output_path: path.join(generationDir, "delivery.mp4"),
    source_generation: input.sourceGeneration,
    source_receipt: input.sourceReceipt,
    transform: { ...input.transform },
    transform_sha256: transformHash,
    source_receipt_artifact: sourceReceiptArtifact,
    buildReceipt() {
      const currentSourceReceipt = verifyCurrentSourceGeneration(generation.source_generation, generation.source_receipt);
      if (canonicalJson(currentSourceReceipt) !== canonicalJson(generation.source_receipt_artifact)) {
        throw new Error("re-encode source receipt identity changed during processing");
      }
      return {
        version: "review-reencode-receipt/v1",
        generation_id: generation.generation_id,
        source_generation_id: generation.source_generation.generation_id,
        source_output_sha256: generation.source_receipt.output.sha256,
        source_receipt: generation.source_receipt_artifact,
        transform: generation.transform,
        transform_sha256: generation.transform_sha256,
        output: {
          path: path.relative(generation.source_generation.project_dir, generation.output_path).split(path.sep).join("/"),
          sha256: sha256File(generation.output_path),
        },
        review_only: true,
      };
    },
  };
  return generation;
}

export function verifyReencodeGeneration(generation: ReencodeGeneration, receipt: ReencodeReceipt): void {
  const keys = Object.keys(receipt).sort().join("\0");
  if (keys !== ["generation_id", "output", "review_only", "source_generation_id", "source_output_sha256", "source_receipt", "transform", "transform_sha256", "version"].sort().join("\0")) {
    throw new Error("re-encode receipt contains unknown or missing fields");
  }
  validateArtifact<ReencodeReceipt>(receipt, "review-reencode-receipt.schema.json");
  validateTransform(receipt.transform);
  const currentSourceReceipt = verifyCurrentSourceGeneration(generation.source_generation, generation.source_receipt);
  if (canonicalJson(receipt.source_receipt) !== canonicalJson(currentSourceReceipt)
    || canonicalJson(generation.source_receipt_artifact) !== canonicalJson(currentSourceReceipt)) {
    throw new Error("re-encode source receipt identity mismatch");
  }
  if (sha256File(generation.source_generation.output_path) !== receipt.source_output_sha256
    || receipt.source_output_sha256 !== generation.source_receipt.output.sha256) {
    throw new Error("re-encode source generation hash mismatch");
  }
  if (canonicalJson(receipt.transform) !== canonicalJson(generation.transform)
    || receipt.transform_sha256 !== generation.transform_sha256
    || hashCanonical(receipt.transform) !== receipt.transform_sha256) {
    throw new Error("re-encode transform conditions mismatch");
  }
  if (receipt.generation_id !== generation.generation_id
    || receipt.source_generation_id !== generation.source_generation.generation_id
    || sha256File(generation.output_path) !== receipt.output.sha256) {
    throw new Error("re-encode generation receipt mismatch");
  }
  const expectedOutputPath = path.relative(generation.source_generation.project_dir, generation.output_path).split(path.sep).join("/");
  if (receipt.output.path !== expectedOutputPath) throw new Error("re-encode output path mismatch");
  if (receipt.review_only !== true || !fs.statSync(generation.output_path).isFile()) {
    throw new Error("re-encode output is not review-only immutable media");
  }
}

export function prepareImmutableReencode(generation: ReencodeGeneration): { status: "owner" | "reused"; receipt?: ReencodeReceipt } {
  const receiptPath = path.join(generation.generation_dir, "reencode-receipt.json");
  fs.mkdirSync(path.dirname(generation.generation_dir), { recursive: true });
  try {
    fs.mkdirSync(generation.generation_dir);
    return { status: "owner" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!fs.existsSync(generation.output_path) || !fs.existsSync(receiptPath)) {
    throw new Error("immutable re-encode overwrite refused: existing generation is incomplete");
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as ReencodeReceipt;
  verifyReencodeGeneration(generation, receipt);
  return { status: "reused", receipt };
}

export function writeReencodeReceipt(generation: ReencodeGeneration, receipt: ReencodeReceipt): string {
  verifyReencodeGeneration(generation, receipt);
  const receiptPath = path.join(generation.generation_dir, "reencode-receipt.json");
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  if (fs.existsSync(receiptPath)) {
    if (fs.readFileSync(receiptPath, "utf8") !== bytes) throw new Error("immutable re-encode receipt overwrite refused");
    return receiptPath;
  }
  fs.writeFileSync(receiptPath, bytes, { encoding: "utf8", flag: "wx" });
  return receiptPath;
}
