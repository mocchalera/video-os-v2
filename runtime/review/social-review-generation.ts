import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateArtifact } from "../artifacts/loaders.js";
import {
  hashRenderLayoutSnapshot,
  type DeterministicLayoutQAResult,
  type RenderLayoutSnapshot,
} from "./deterministic-layout-qa.js";
import type { DeterministicOutputQAResult } from "./deterministic-output-qa.js";
import { DEFAULT_MASTERING, type MasteringDefaults } from "../audio/mastering.js";
import {
  hashAudioRenderPlan,
  type AudioRenderPlan,
} from "../audio/render-plan.js";
import {
  audioDeliveryProfileContentHash,
  loadAudioDeliveryProfile,
} from "../audio/delivery-profile.js";
import {
  parseSubjectOccupancyTrack,
  subjectOccupancyArtifactHash,
  subjectOccupancyPayloadHash,
} from "./subject-occupancy.js";
import {
  parseVerticalCompositionPolicy,
  verticalCompositionPolicyContentHash,
} from "../visual/vertical-composition.js";
import {
  audioReportFromReceipt,
  verifySocialReviewAudioReceipt,
  type SocialReviewAudioReceipt,
} from "./social-review-audio.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
export const SOCIAL_REVIEW_GENERATION_VERSION = "social-review-generation/v1" as const;

export interface GenerationInputFile {
  logical_path: string;
  locator: string;
  sha256: string;
}

export interface GenerationInputSource {
  logicalPath: string;
  filePath: string;
}

export interface BoundGenerationArtifact {
  path: string;
  sha256: string;
}

export interface SocialReviewGenerationInput {
  projectDir: string;
  projectId: string;
  canonicalTimelineHash: string;
  acceptedPatchHash: string;
  derivedMappingReceiptHash: string;
  reviewTimelineHash: string;
  captionTextTimingHash: string;
  visualTreatmentHash: string;
  contentPlanHash: string;
  audioPlanHash: string;
  rendererCapabilityHash: string;
  subjectOccupancyPayloadHash?: string;
  verticalCompositionPolicyHash?: string;
  sourceInputAttestation: unknown;
  files: Array<string | GenerationInputSource>;
}

export interface SocialReviewGeneration {
  version: typeof SOCIAL_REVIEW_GENERATION_VERSION;
  project_id: string;
  project_dir: string;
  generation_id: string;
  generation_dir: string;
  output_path: string;
  receipt_path: string;
  inputs: ReviewGenerationHashes;
  input_files: GenerationInputFile[];
  source_input_attestation: unknown;
}

export interface ReviewGenerationHashes {
  canonical_timeline_sha256: string;
  accepted_patch_sha256: string;
  derived_mapping_receipt_sha256: string;
  review_timeline_sha256: string;
  caption_text_timing_sha256: string;
  visual_treatment_sha256: string;
  content_plan_sha256: string;
  audio_plan_sha256: string;
  renderer_capability_sha256: string;
  subject_occupancy_payload_sha256: string;
  vertical_composition_policy_sha256: string;
  source_input_attestation_sha256: string;
}

export interface SocialReviewQA {
  output: DeterministicOutputQAResult;
  layout: DeterministicLayoutQAResult;
  audio: { status: "verified" | "blocked" | "incomplete"; evidence: BoundGenerationArtifact | null };
  layers: { status: "verified" | "blocked" | "incomplete"; evidence: BoundGenerationArtifact[] };
  layout_evidence?: {
    snapshot: BoundGenerationArtifact;
    subject_occupancy: BoundGenerationArtifact | null;
    vertical_composition_policy: BoundGenerationArtifact | null;
  };
}

export interface SocialReviewGenerationReceipt {
  version: "social-review-generation-receipt/v1";
  project_id: string;
  generation_id: string;
  inputs: ReviewGenerationHashes;
  input_files: GenerationInputFile[];
  output: { path: string; sha256: string };
  qa: SocialReviewQA;
  qa_artifact: { path: string; sha256: string };
  audio_mastering_receipt: BoundGenerationArtifact | null;
  render_report: BoundGenerationArtifact;
  source_input_attestation: BoundGenerationArtifact;
  review_ready: boolean;
  review_only: true;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256File(filePath: string): string {
  return sha256Bytes(fs.readFileSync(filePath));
}

export function hashCanonical(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

export function deriveSocialReviewGenerationId(
  projectId: string,
  inputs: ReviewGenerationHashes,
  inputFiles: GenerationInputFile[],
): string {
  return hashCanonical({
    version: SOCIAL_REVIEW_GENERATION_VERSION,
    project_id: projectId,
    inputs,
    input_files: inputFiles,
  });
}

function requireHash(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} must be a sha256 identity`);
  return value;
}

function projectLocator(projectDir: string, filePath: string): string {
  const root = path.resolve(projectDir);
  const resolved = path.resolve(filePath);
  return resolved.startsWith(`${root}${path.sep}`)
    ? `project:${path.relative(root, resolved).split(path.sep).join("/")}`
    : `file:${resolved}`;
}

function resolveInputLocator(projectDir: string, locator: string): string {
  const root = path.resolve(projectDir);
  const resolved = locator.startsWith("project:")
    ? path.resolve(root, locator.slice("project:".length))
    : locator.startsWith("file:") ? path.resolve(locator.slice("file:".length)) : "";
  if (!resolved || (locator.startsWith("project:") && !resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`invalid generation input locator: ${locator}`);
  }
  if (!fs.statSync(resolved).isFile()) throw new Error(`generation input is not a file: ${locator}`);
  return resolved;
}

function normalizeInputSource(projectDir: string, source: string | GenerationInputSource): GenerationInputFile {
  const logicalPath = typeof source === "string" ? source : source.logicalPath;
  if (!logicalPath || path.isAbsolute(logicalPath) || logicalPath.split(/[\\/]/).includes("..")) {
    throw new Error(`generation input logical path must be relative: ${logicalPath}`);
  }
  const filePath = typeof source === "string" ? path.resolve(projectDir, source) : path.resolve(source.filePath);
  const locator = projectLocator(projectDir, filePath);
  return {
    logical_path: logicalPath.split(path.sep).join("/"),
    locator,
    sha256: sha256File(resolveInputLocator(projectDir, locator)),
  };
}

export function captureSocialReviewGeneration(input: SocialReviewGenerationInput): SocialReviewGeneration {
  const projectDir = path.resolve(input.projectDir);
  const inputs: ReviewGenerationHashes = {
    canonical_timeline_sha256: requireHash(input.canonicalTimelineHash, "canonical timeline hash"),
    accepted_patch_sha256: requireHash(input.acceptedPatchHash, "accepted patch hash"),
    derived_mapping_receipt_sha256: requireHash(input.derivedMappingReceiptHash, "derived mapping receipt hash"),
    review_timeline_sha256: requireHash(input.reviewTimelineHash, "review timeline hash"),
    caption_text_timing_sha256: requireHash(input.captionTextTimingHash, "caption text/timing hash"),
    visual_treatment_sha256: requireHash(input.visualTreatmentHash, "visual treatment hash"),
    content_plan_sha256: requireHash(input.contentPlanHash, "content plan hash"),
    audio_plan_sha256: requireHash(input.audioPlanHash, "audio plan hash"),
    renderer_capability_sha256: requireHash(input.rendererCapabilityHash, "renderer capability hash"),
    subject_occupancy_payload_sha256: requireHash(
      input.subjectOccupancyPayloadHash ?? hashCanonical({ status: "not_provided" }),
      "subject occupancy payload hash",
    ),
    vertical_composition_policy_sha256: requireHash(
      input.verticalCompositionPolicyHash ?? hashCanonical({ status: "not_provided" }),
      "vertical composition policy hash",
    ),
    source_input_attestation_sha256: hashCanonical(input.sourceInputAttestation),
  };
  const inputFiles = input.files.map((source) => normalizeInputSource(projectDir, source))
    .sort((left, right) => left.logical_path.localeCompare(right.logical_path, "en"));
  if (new Set(inputFiles.map((entry) => entry.logical_path)).size !== inputFiles.length) {
    throw new Error("duplicate generation input logical path");
  }
  const generationId = deriveSocialReviewGenerationId(input.projectId, inputs, inputFiles);
  const generationDir = path.join(projectDir, "09_output", "social-review", "generations", generationId.slice(7));
  return {
    version: SOCIAL_REVIEW_GENERATION_VERSION,
    project_id: input.projectId,
    project_dir: projectDir,
    generation_id: generationId,
    generation_dir: generationDir,
    output_path: path.join(generationDir, "review.mp4"),
    receipt_path: path.join(generationDir, "review-ready-receipt.json"),
    inputs,
    input_files: inputFiles,
    source_input_attestation: input.sourceInputAttestation,
  };
}

export function assertGenerationInputsUnchanged(generation: SocialReviewGeneration): void {
  for (const entry of generation.input_files) {
    const current = sha256File(resolveInputLocator(generation.project_dir, entry.locator));
    if (current !== entry.sha256) {
      throw new Error(`generation input logical path changed while rendering: ${entry.logical_path}`);
    }
  }
}

function resolveProjectArtifact(projectDir: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`artifact path must be project-relative: ${relativePath}`);
  const root = fs.realpathSync(path.resolve(projectDir));
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`artifact path escapes project: ${relativePath}`);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new Error(`artifact is missing or not a file: ${relativePath}`);
  }
  if (!real.startsWith(`${root}${path.sep}`)) throw new Error(`artifact realpath escapes project: ${relativePath}`);
  if (!fs.statSync(real).isFile()) throw new Error(`artifact is missing or not a file: ${relativePath}`);
  return real;
}

function resolveGenerationArtifact(generation: SocialReviewGeneration, artifact: BoundGenerationArtifact, label: string): string {
  let resolved: string;
  try {
    resolved = resolveProjectArtifact(generation.project_dir, artifact.path);
  } catch (error) {
    throw new Error(`${label} missing: ${error instanceof Error ? error.message : String(error)}`);
  }
  const generationRoot = fs.realpathSync(generation.generation_dir);
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(`${generationRoot}${path.sep}`)) throw new Error(`${label} escapes generation directory`);
  if (sha256File(real) !== artifact.sha256) throw new Error(`${label} hash mismatch`);
  return real;
}

function resolveCanonicalGenerationReceipt(generation: SocialReviewGeneration): string {
  const expectedLexical = path.join(generation.generation_dir, "review-ready-receipt.json");
  if (path.resolve(generation.receipt_path) !== path.resolve(expectedLexical)) {
    throw new Error("generation receipt path is not the canonical receipt path");
  }
  let real: string;
  try {
    real = fs.realpathSync(expectedLexical);
  } catch {
    throw new Error("generation receipt is missing from the canonical receipt path");
  }
  const generationRoot = fs.realpathSync(generation.generation_dir);
  if (real !== path.join(generationRoot, "review-ready-receipt.json") || !fs.lstatSync(expectedLexical).isFile()) {
    throw new Error("generation receipt symlink or escape from the canonical generation path is forbidden");
  }
  return real;
}

export function bindGenerationArtifact(generation: SocialReviewGeneration, filePath: string): BoundGenerationArtifact {
  const resolved = path.resolve(filePath);
  const generationRoot = fs.realpathSync(generation.generation_dir);
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(`${generationRoot}${path.sep}`) || !fs.statSync(real).isFile()) {
    throw new Error("generation evidence must be a file contained within the generation directory");
  }
  return {
    path: path.relative(generation.project_dir, resolved).split(path.sep).join("/"),
    sha256: sha256File(real),
  };
}

function sourceInputAttestationPath(generation: SocialReviewGeneration): string {
  return path.join(generation.generation_dir, "source-input-attestation.json");
}

function missingEvidenceHash(): string {
  return hashCanonical({ status: "not_provided" });
}

function hasReadyCollisionEvidence(qa: SocialReviewQA): boolean {
  return Boolean(
    qa.layout.subject_collision_binding &&
      qa.layout_evidence?.snapshot &&
      qa.layout_evidence.subject_occupancy &&
      qa.layout_evidence.vertical_composition_policy,
  );
}

function isReviewReadyQa(qa: SocialReviewQA): boolean {
  return qa.output.status === "verified"
    && qa.layout.status === "verified"
    && qa.audio.status === "verified"
    && qa.layers.status === "verified"
    && qa.output.scans?.decode.status === "complete"
    && qa.output.scans?.black.status === "complete"
    && qa.output.scans?.freeze.status === "complete"
    && qa.output.scans?.layout_inset.status === "complete"
    && hasReadyCollisionEvidence(qa);
}

function currentAudioPolicyProfileHash(generation: SocialReviewGeneration): string | null {
  const entries = generation.input_files.filter((entry) => entry.logical_path === "audio/delivery-profile");
  if (entries.length > 1) throw new Error("canonical audio delivery profile input is ambiguous");
  if (entries.length === 0) return null;
  const entry = entries[0]!;
  const profilePath = resolveInputLocator(generation.project_dir, entry.locator);
  const loaded = loadAudioDeliveryProfile(profilePath);
  if (loaded.hash !== entry.sha256) throw new Error("canonical audio delivery profile source hash mismatch");
  return audioDeliveryProfileContentHash(loaded.profile);
}

function currentAudioPlanBinding(generation: SocialReviewGeneration): {
  sharedAudioPlanHash: string | null;
  policy: MasteringDefaults;
  policyProfileHash: string | null;
} {
  const entries = generation.input_files.filter((entry) => entry.logical_path === "audio/shared-render-plan");
  if (entries.length > 1) throw new Error("canonical shared audio render plan input is ambiguous");
  if (entries.length === 0) {
    if (currentAudioPolicyProfileHash(generation) !== null) {
      throw new Error("canonical audio delivery profile requires a shared audio render plan source");
    }
    return { sharedAudioPlanHash: null, policy: DEFAULT_MASTERING, policyProfileHash: null };
  }
  const entry = entries[0]!;
  const planPath = resolveInputLocator(generation.project_dir, entry.locator);
  const canonicalPlanPath = path.join(generation.project_dir, "07_package", "audio-render-plan.json");
  if (entry.locator !== "project:07_package/audio-render-plan.json"
    || path.resolve(planPath) !== path.resolve(canonicalPlanPath)
    || fs.lstatSync(canonicalPlanPath).isSymbolicLink()) {
    throw new Error("canonical shared audio render plan must use the current project artifact");
  }
  if (sha256File(planPath) !== entry.sha256) {
    throw new Error("canonical shared audio render plan source hash mismatch");
  }
  const generationRoot = fs.realpathSync(generation.generation_dir);
  const planRealPath = fs.realpathSync(planPath);
  if (planRealPath.startsWith(`${generationRoot}${path.sep}`)) {
    throw new Error("canonical shared audio render plan source cannot be generation-local");
  }
  const plan = validateArtifact<AudioRenderPlan>(
    JSON.parse(fs.readFileSync(planRealPath, "utf8")),
    "audio-render-plan.schema.json",
  );
  if (plan.project_id !== generation.project_id) {
    throw new Error("canonical shared audio render plan project binding mismatch");
  }
  const preservingMusicMaster = plan.strategy === "music_master"
    && plan.music_master?.audio_decision === "preserve";
  if (preservingMusicMaster) {
    if (plan.final_mastering.count !== 0 || plan.final_mastering.stage !== "not_applied"
      || plan.final_mastering.owner !== "shared_audio_render_plan") {
      throw new Error("canonical music_master preserve audio plan must record zero mastering passes");
    }
  } else if (plan.final_mastering.count !== 1 || plan.final_mastering.stage !== "after_mix"
    || plan.final_mastering.owner !== "shared_audio_render_plan"
    || plan.strategy === "legacy_embedded_bgm" || plan.strategy === "original_passthrough") {
    throw new Error("canonical social-review audio plan must apply shared mastering exactly once");
  }
  const policyProfileHash = currentAudioPolicyProfileHash(generation);
  if ((plan.audio_delivery_profile?.profile_hash ?? null) !== policyProfileHash) {
    throw new Error("canonical shared audio plan/profile source binding mismatch");
  }
  return {
    sharedAudioPlanHash: hashAudioRenderPlan(plan),
    policy: {
      loudness_target_lufs: plan.final_mastering.loudness_target_lufs,
      lra_target: plan.final_mastering.lra_target,
      true_peak_target_dbtp: plan.final_mastering.true_peak_target_dbtp,
    },
    policyProfileHash,
  };
}

function verifyQaEvidence(generation: SocialReviewGeneration, qa: SocialReviewQA, options: { historical?: boolean } = {}): void {
  const identityFailures = new Set([
    "subject_occupancy_generation_mismatch",
    "layout_snapshot_generation_mismatch",
    "renderer_capability_hash_mismatch",
    "vertical_composition_policy_hash_mismatch",
  ]);
  const identityFailure = qa.layout.review_items.find((item) =>
    item.reason && identityFailures.has(item.reason)
  );
  if (identityFailure) {
    throw new Error(
      `layout collision mixed-generation evidence rejected before write: ${identityFailure.reason}`,
    );
  }
  const collision = qa.layout.subject_collision_binding;
  if (qa.layout.status === "verified") {
    if (!collision) {
      throw new Error("verified layout requires subject collision binding");
    }
    if (!qa.layout_evidence?.snapshot) {
      throw new Error("verified layout snapshot evidence is missing");
    }
    if (!qa.layout_evidence.subject_occupancy) {
      throw new Error("verified layout subject occupancy evidence is missing");
    }
    if (!qa.layout_evidence.vertical_composition_policy) {
      throw new Error("verified layout vertical composition policy evidence is missing");
    }
    if (generation.inputs.subject_occupancy_payload_sha256 === missingEvidenceHash()) {
      throw new Error("verified layout cannot use not_provided subject occupancy identity");
    }
    if (generation.inputs.vertical_composition_policy_sha256 === missingEvidenceHash()) {
      throw new Error("verified layout cannot use not_provided vertical composition policy identity");
    }
  }
  if (collision) {
    if (!qa.layout_evidence?.subject_occupancy ||
      !qa.layout_evidence.vertical_composition_policy) {
      throw new Error("layout collision bound evidence is missing");
    }
    if (collision.generation_id !== generation.generation_id) {
      throw new Error("layout collision generation identity mismatch");
    }
    if (collision.renderer_capability_sha256 !==
      generation.inputs.renderer_capability_sha256) {
      throw new Error("layout collision renderer capability mismatch");
    }
    if (collision.subject_occupancy_payload_sha256 !==
      generation.inputs.subject_occupancy_payload_sha256) {
      throw new Error("layout collision subject occupancy payload mismatch");
    }
    if (collision.policy_sha256 !==
      generation.inputs.vertical_composition_policy_sha256) {
      throw new Error("layout collision policy hash mismatch");
    }
    if (qa.layout.snapshot_sha256 !== collision.snapshot_sha256) {
      throw new Error("layout collision snapshot hash mismatch");
    }
    const snapshotPath = resolveGenerationArtifact(
      generation,
      qa.layout_evidence.snapshot,
      "layout snapshot evidence",
    );
    const subjectPath = resolveGenerationArtifact(
      generation,
      qa.layout_evidence.subject_occupancy,
      "subject occupancy evidence",
    );
    const policyPath = resolveGenerationArtifact(
      generation,
      qa.layout_evidence.vertical_composition_policy,
      "vertical composition policy evidence",
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as RenderLayoutSnapshot;
    const subject = parseSubjectOccupancyTrack(JSON.parse(fs.readFileSync(subjectPath, "utf8")));
    const policy = parseVerticalCompositionPolicy(JSON.parse(fs.readFileSync(policyPath, "utf8")));
    if (snapshot.binding?.generation_id !== generation.generation_id ||
      snapshot.binding.renderer_capability_sha256 !==
        generation.inputs.renderer_capability_sha256) {
      throw new Error("layout snapshot generation or renderer binding mismatch");
    }
    if (subject.generation_id !== generation.generation_id) {
      throw new Error("subject occupancy generation binding mismatch");
    }
    if (collision.platform_geometry_status !== "measured" ||
      policy.platform_geometry?.status !== "measured") {
      throw new Error("verified layout requires measured platform geometry evidence");
    }
    if (path.isAbsolute(collision.policy_ref) ||
      collision.policy_ref.split(/[\\/]/).includes("..")) {
      throw new Error("layout collision policy reference must be project-contained");
    }
    if (hashRenderLayoutSnapshot(snapshot) !== collision.snapshot_sha256 ||
      subjectOccupancyArtifactHash(subject) !== collision.subject_occupancy_sha256 ||
      subjectOccupancyPayloadHash(subject) !== collision.subject_occupancy_payload_sha256 ||
      verticalCompositionPolicyContentHash(policy) !== collision.policy_sha256) {
      throw new Error("layout collision bound evidence hash mismatch");
    }
  }
  if (qa.layout_evidence) {
    resolveGenerationArtifact(generation, qa.layout_evidence.snapshot, "layout snapshot evidence");
  }
  if (qa.audio.status === "verified") {
    if (!qa.audio.evidence) throw new Error("audio evidence missing");
    const audioEvidencePath = resolveGenerationArtifact(generation, qa.audio.evidence, "audio evidence");
    if (fs.realpathSync(audioEvidencePath) !== fs.realpathSync(path.join(generation.generation_dir, "audio-mastering-receipt.json"))) {
      throw new Error("verified audio evidence must be the canonical mastering receipt");
    }
    const audioReceipt = JSON.parse(fs.readFileSync(audioEvidencePath, "utf8")) as SocialReviewAudioReceipt;
    if (options.historical === true) {
      // Historical rounds must not depend on the current project audio plan;
      // the generation ID rederivation already commits the audio plan hash.
      verifySocialReviewAudioReceipt(audioReceipt, {
        generationId: generation.generation_id,
        projectDir: generation.project_dir,
        expectedAudioPlanHash: generation.inputs.audio_plan_sha256,
        reviewVideoPath: generation.output_path,
      });
    } else {
      const currentAudio = currentAudioPlanBinding(generation);
      verifySocialReviewAudioReceipt(audioReceipt, {
        generationId: generation.generation_id,
        projectDir: generation.project_dir,
        expectedAudioPlanHash: generation.inputs.audio_plan_sha256,
        expectedSharedAudioPlanHash: currentAudio.sharedAudioPlanHash,
        reviewVideoPath: generation.output_path,
        expectedPolicy: currentAudio.policy,
        expectedPolicyProfileHash: currentAudio.policyProfileHash,
      });
    }
    const generationRoot = fs.realpathSync(generation.generation_dir);
    for (const artifact of [audioReceipt.input_audio, audioReceipt.output_audio]) {
      if (!artifact) continue;
      const real = fs.realpathSync(path.resolve(fs.realpathSync(generation.project_dir), artifact.path));
      if (!real.startsWith(`${generationRoot}${path.sep}`)) {
        throw new Error("audio mastering input/output evidence escapes generation directory");
      }
    }
  } else if (qa.audio.evidence !== null) {
    resolveGenerationArtifact(generation, qa.audio.evidence, "audio evidence");
  }
  for (const evidence of qa.layers.evidence) resolveGenerationArtifact(generation, evidence, "layer evidence");
  if (qa.layers.status === "verified" && qa.layers.evidence.length === 0) {
    throw new Error("layer evidence missing");
  }
}

export function buildReviewReadyReceipt(
  generation: SocialReviewGeneration,
  outputPath: string,
  qa: SocialReviewQA,
  renderReportPath: string,
): SocialReviewGenerationReceipt {
  if (path.resolve(outputPath) !== path.resolve(generation.output_path)) {
    throw new Error("generation output path is not the immutable generation artifact");
  }
  assertGenerationInputsUnchanged(generation);
  verifyQaEvidence(generation, qa);
  const reviewReady = isReviewReadyQa(qa);
  const qaArtifactPath = path.join(generation.generation_dir, "qa-results.json");
  writeImmutableJson(qaArtifactPath, qa, "QA results");
  return {
    version: "social-review-generation-receipt/v1",
    project_id: generation.project_id,
    generation_id: generation.generation_id,
    inputs: generation.inputs,
    input_files: generation.input_files,
    output: {
      path: path.relative(generation.project_dir, outputPath).split(path.sep).join("/"),
      sha256: sha256File(outputPath),
    },
    qa,
    qa_artifact: {
      path: path.relative(generation.project_dir, qaArtifactPath).split(path.sep).join("/"),
      sha256: sha256File(qaArtifactPath),
    },
    audio_mastering_receipt: qa.audio.evidence,
    render_report: bindGenerationArtifact(generation, renderReportPath),
    source_input_attestation: bindGenerationArtifact(generation, sourceInputAttestationPath(generation)),
    review_ready: reviewReady,
    review_only: true,
  };
}

export function verifyReviewReadyReceipt(
  generation: SocialReviewGeneration,
  receipt: SocialReviewGenerationReceipt,
  options: { assertInputsUnchanged?: boolean; historical?: boolean } = {},
): void {
  exactKeys(receipt as unknown as Record<string, unknown>, ["audio_mastering_receipt", "generation_id", "input_files", "inputs", "output", "project_id", "qa", "qa_artifact", "render_report", "review_only", "review_ready", "source_input_attestation", "version"], "review-ready receipt");
  exactKeys(receipt.inputs as unknown as Record<string, unknown>, ["accepted_patch_sha256", "audio_plan_sha256", "canonical_timeline_sha256", "caption_text_timing_sha256", "content_plan_sha256", "derived_mapping_receipt_sha256", "renderer_capability_sha256", "review_timeline_sha256", "source_input_attestation_sha256", "subject_occupancy_payload_sha256", "vertical_composition_policy_sha256", "visual_treatment_sha256"], "generation inputs");
  exactKeys(receipt.output as unknown as Record<string, unknown>, ["path", "sha256"], "generation output");
  exactKeys(receipt.qa_artifact as unknown as Record<string, unknown>, ["path", "sha256"], "QA artifact");
  if (receipt.audio_mastering_receipt) {
    exactKeys(receipt.audio_mastering_receipt as unknown as Record<string, unknown>, ["path", "sha256"], "audio mastering receipt artifact");
  }
  exactKeys(receipt.render_report as unknown as Record<string, unknown>, ["path", "sha256"], "render report artifact");
  exactKeys(receipt.source_input_attestation as unknown as Record<string, unknown>, ["path", "sha256"], "source input attestation artifact");
  validateArtifact<SocialReviewGenerationReceipt>(receipt, "social-review-generation-receipt.schema.json");
  if (receipt.version !== "social-review-generation-receipt/v1") throw new Error("receipt version mismatch");
  const derivedGenerationId = deriveSocialReviewGenerationId(receipt.project_id, receipt.inputs, receipt.input_files);
  if (receipt.project_id !== generation.project_id || receipt.generation_id !== generation.generation_id
    || receipt.generation_id !== derivedGenerationId) {
    throw new Error("generation identity mismatch in review-ready receipt");
  }
  if (canonicalJson(receipt.inputs) !== canonicalJson(generation.inputs)
    || canonicalJson(receipt.input_files) !== canonicalJson(generation.input_files)) {
    throw new Error("generation inputs mismatch in review-ready receipt");
  }
  const expectedPath = path.relative(generation.project_dir, generation.output_path).split(path.sep).join("/");
  const verifiedOutputPath = resolveGenerationArtifact(generation, receipt.output, "output review video");
  if (receipt.output.path !== expectedPath || sha256File(verifiedOutputPath) !== receipt.output.sha256) {
    throw new Error("output bytes/hash mismatch in review-ready receipt");
  }
  const qaArtifactPath = resolveGenerationArtifact(generation, receipt.qa_artifact, "QA results artifact");
  const expectedQaPath = path.relative(generation.project_dir, path.join(generation.generation_dir, "qa-results.json")).split(path.sep).join("/");
  if (receipt.qa_artifact.path !== expectedQaPath) throw new Error("QA results artifact path mismatch");
  if (sha256File(qaArtifactPath) !== receipt.qa_artifact.sha256) throw new Error("QA results artifact hash mismatch");
  const boundQa = JSON.parse(fs.readFileSync(qaArtifactPath, "utf8")) as SocialReviewQA;
  if (canonicalJson(boundQa) !== canonicalJson(receipt.qa)) throw new Error("receipt QA results mismatch bound QA artifact");
  verifyQaEvidence(generation, receipt.qa, { historical: options.historical === true });
  if (canonicalJson(receipt.audio_mastering_receipt) !== canonicalJson(receipt.qa.audio.evidence)) {
    throw new Error("review receipt audio mastering binding mismatch");
  }
  const audioReceipt = receipt.audio_mastering_receipt
    ? JSON.parse(fs.readFileSync(resolveGenerationArtifact(
        generation,
        receipt.audio_mastering_receipt,
        "audio mastering receipt",
      ), "utf8")) as SocialReviewAudioReceipt
    : null;
  const renderReportPath = resolveGenerationArtifact(generation, receipt.render_report, "render report");
  const expectedRenderReportPath = path.join(generation.generation_dir, "social-review-report.json");
  if (fs.realpathSync(renderReportPath) !== fs.realpathSync(expectedRenderReportPath)) throw new Error("render report artifact path mismatch");
  const renderReport = JSON.parse(fs.readFileSync(renderReportPath, "utf8")) as { audio_mastering?: unknown };
  if (canonicalJson(renderReport.audio_mastering) !== canonicalJson(
    audioReceipt ? audioReportFromReceipt(audioReceipt) : null,
  )) {
    throw new Error("render report audio values must derive from the bound measurement receipt");
  }
  const attestationPath = resolveGenerationArtifact(generation, receipt.source_input_attestation, "source input attestation");
  const attestation = JSON.parse(fs.readFileSync(attestationPath, "utf8")) as unknown;
  if (hashCanonical(attestation) !== receipt.inputs.source_input_attestation_sha256
    || canonicalJson(attestation) !== canonicalJson(generation.source_input_attestation)) {
    throw new Error("source input attestation mismatch");
  }
  const shouldBeReady = isReviewReadyQa(receipt.qa);
  if (receipt.review_ready !== shouldBeReady || receipt.review_only !== true) {
    throw new Error("review-ready state does not match QA results");
  }
  if (options.assertInputsUnchanged !== false) {
    assertGenerationInputsUnchanged(generation);
  }
}

function exactKeys(record: Record<string, unknown>, expected: string[], label: string): void {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function writeImmutableJson(filePath: string, value: unknown, label: string): void {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(filePath)) {
    if (fs.readFileSync(filePath, "utf8") !== bytes) throw new Error(`immutable generation ${label} overwrite refused`);
    return;
  }
  fs.writeFileSync(filePath, bytes, { encoding: "utf8", flag: "wx" });
}

export function writeReviewReadyReceipt(generation: SocialReviewGeneration, receipt: SocialReviewGenerationReceipt): void {
  verifyReviewReadyReceipt(generation, receipt);
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  if (fs.existsSync(generation.receipt_path)) {
    if (fs.readFileSync(generation.receipt_path, "utf8") !== bytes) throw new Error("immutable generation receipt overwrite refused");
    return;
  }
  const temporary = `${generation.receipt_path}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, generation.receipt_path);
}

export function prepareImmutableGeneration(generation: SocialReviewGeneration): { status: "owner" | "reused"; receipt?: SocialReviewGenerationReceipt } {
  fs.mkdirSync(path.dirname(generation.generation_dir), { recursive: true });
  try {
    fs.mkdirSync(generation.generation_dir);
    writeImmutableJson(sourceInputAttestationPath(generation), generation.source_input_attestation, "source input attestation");
    return { status: "owner" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!fs.existsSync(generation.output_path) || !fs.existsSync(generation.receipt_path)) {
    throw new Error("immutable generation claim already exists and is incomplete");
  }
  let receipt: SocialReviewGenerationReceipt;
  try {
    receipt = JSON.parse(fs.readFileSync(generation.receipt_path, "utf8")) as SocialReviewGenerationReceipt;
  } catch {
    throw new Error("immutable generation overwrite refused: receipt is unreadable");
  }
  verifyReviewReadyReceipt(generation, receipt);
  if (!receipt.review_ready) throw new Error("blocked or incomplete generation cannot be reused as review-ready");
  return { status: "reused", receipt };
}

interface LatestPointer {
  version: "social-review-latest/v1";
  project_id: string;
  generation_id: string;
  receipt_path: string;
  receipt_sha256: string;
  output_path: string;
  output_sha256: string;
}

export function promoteLatestGeneration(generation: SocialReviewGeneration, receipt: SocialReviewGenerationReceipt): LatestPointer {
  let receiptPath = resolveCanonicalGenerationReceipt(generation);
  verifyReviewReadyReceipt(generation, receipt);
  if (!receipt.review_ready) throw new Error("review_ready=true is required for latest promotion");
  const pointer: LatestPointer = {
    version: "social-review-latest/v1",
    project_id: generation.project_id,
    generation_id: generation.generation_id,
    receipt_path: path.relative(generation.project_dir, generation.receipt_path).split(path.sep).join("/"),
    receipt_sha256: sha256File(receiptPath),
    output_path: receipt.output.path,
    output_sha256: receipt.output.sha256,
  };
  const pointerPath = path.join(generation.project_dir, "09_output", "social-review", "latest.json");
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  const temporary = `${pointerPath}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    receiptPath = resolveCanonicalGenerationReceipt(generation);
    verifyReviewReadyReceipt(generation, receipt);
    if (sha256File(receiptPath) !== pointer.receipt_sha256) {
      throw new Error("review-ready receipt changed during latest promotion");
    }
    fs.renameSync(temporary, pointerPath);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  return pointer;
}

export function verifyLatestGeneration(projectDir: string): LatestPointer {
  const root = fs.realpathSync(path.resolve(projectDir));
  const pointerPath = path.join(root, "09_output", "social-review", "latest.json");
  const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as LatestPointer;
  const exactKeys = ["generation_id", "output_path", "output_sha256", "project_id", "receipt_path", "receipt_sha256", "version"];
  if (Object.keys(pointer).sort().join("\0") !== exactKeys.sort().join("\0") || pointer.version !== "social-review-latest/v1") {
    throw new Error("stale latest pointer: invalid contract");
  }
  if (!SHA256.test(pointer.generation_id)) throw new Error("stale latest pointer: invalid generation identity");
  let receiptPath: string;
  try {
    receiptPath = resolveProjectArtifact(root, pointer.receipt_path);
  } catch (error) {
    throw new Error(`stale latest pointer: receipt is not canonical or contained: ${error instanceof Error ? error.message : String(error)}`);
  }
  const outputPath = resolveProjectArtifact(root, pointer.output_path);
  const expectedGenerationDir = path.join(root, "09_output", "social-review", "generations", pointer.generation_id.slice(7));
  const generationRoot = fs.realpathSync(expectedGenerationDir);
  const receiptLexical = path.resolve(root, pointer.receipt_path);
  if (receiptPath !== path.join(generationRoot, "review-ready-receipt.json") || !fs.lstatSync(receiptLexical).isFile()
    || !outputPath.startsWith(`${generationRoot}${path.sep}`)) {
    throw new Error("stale latest pointer: review video or receipt escapes generation directory");
  }
  if (sha256File(receiptPath) !== pointer.receipt_sha256 || sha256File(outputPath) !== pointer.output_sha256) {
    throw new Error("stale latest pointer: bound artifact hash mismatch");
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as SocialReviewGenerationReceipt;
  if (receipt.generation_id !== pointer.generation_id || receipt.output.sha256 !== pointer.output_sha256) {
    throw new Error("stale latest pointer: receipt identity mismatch");
  }
  const generationDir = expectedGenerationDir;
  const attestationPath = resolveProjectArtifact(root, receipt.source_input_attestation.path);
  const generation: SocialReviewGeneration = {
    version: SOCIAL_REVIEW_GENERATION_VERSION,
    project_id: receipt.project_id,
    project_dir: root,
    generation_id: receipt.generation_id,
    generation_dir: generationDir,
    output_path: outputPath,
    receipt_path: receiptPath,
    inputs: receipt.inputs,
    input_files: receipt.input_files,
    source_input_attestation: JSON.parse(fs.readFileSync(attestationPath, "utf8")) as unknown,
  };
  verifyReviewReadyReceipt(generation, receipt);
  if (!receipt.review_ready) throw new Error("stale latest pointer: generation is not review-ready");
  return pointer;
}

export interface VerifiedImmutableGeneration {
  generation_id: string;
  project_id: string;
  generation_dir: string;
  receipt: SocialReviewGenerationReceipt;
  receipt_sha256: string;
  output: { path: string; sha256: string };
}

/**
 * Historical immutable generation gate (Issue #29 Phase 6 review rounds).
 *
 * Proves, for an explicit generation directory — without depending on the
 * current latest pointer or on project files that may have been superseded
 * since the generation was captured — that:
 *   - the generation directory is the canonical, project-contained,
 *     symlink-free generation root for the requested identity,
 *   - the review-ready receipt is schema-valid with exact canonical fields,
 *   - the generation ID rederives from (project_id, inputs, input_files),
 *   - the review video, QA results, render report, audio mastering receipt,
 *     and source input attestation byte/hash match their bindings,
 *   - the QA results still satisfy the review-ready contract.
 *
 * Unlike verifyLatestGeneration this gate does not require the current
 * project inputs to be unchanged; input identity is proven by the generation
 * ID rederivation. Current-generation rounds must additionally pass
 * verifyCurrentReviewReady.
 */
export function verifyImmutableGenerationIdentity(projectDirInput: string, generationId: string): VerifiedImmutableGeneration {
  const root = fs.realpathSync(path.resolve(projectDirInput));
  if (!SHA256.test(generationId)) throw new Error("generation identity must be a sha256 hash");
  const generationsRoot = path.join(root, "09_output", "social-review", "generations");
  if (!fs.existsSync(generationsRoot) || !fs.statSync(generationsRoot).isDirectory()) {
    throw new Error("generation history root is missing");
  }
  const generationsRootReal = fs.realpathSync(generationsRoot);
  const generationDir = path.join(generationsRoot, generationId.slice(7));
  if (fs.lstatSync(generationDir).isSymbolicLink()) {
    throw new Error("generation directory symlink escape is forbidden");
  }
  const generationRoot = fs.realpathSync(generationDir);
  if (generationRoot !== generationsRootReal && !generationRoot.startsWith(`${generationsRootReal}${path.sep}`)) {
    throw new Error("generation directory escapes the exact project generation root");
  }
  const receiptPath = path.join(generationDir, "review-ready-receipt.json");
  if (fs.lstatSync(receiptPath).isSymbolicLink()) {
    throw new Error("generation receipt symlink escape is forbidden");
  }
  // ONE immutable read snapshot: hash and parsed receipt come from the same
  // captured bytes, with the parent directory identity held across the read.
  const parentPath = path.dirname(receiptPath);
  const parentBefore = fs.lstatSync(parentPath);
  const receiptBytes = fs.readFileSync(receiptPath);
  const parentAfter = fs.lstatSync(parentPath);
  if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino
    || parentBefore.mode !== parentAfter.mode) {
    throw new Error("generation receipt parent directory changed during the read");
  }
  const receiptStatsAfter = fs.lstatSync(receiptPath);
  if (receiptStatsAfter.isSymbolicLink() || !receiptStatsAfter.isFile()
    || receiptStatsAfter.nlink !== 1 || receiptStatsAfter.size !== receiptBytes.length) {
    throw new Error("generation receipt changed during the read");
  }
  const receiptSha256 = `sha256:${createHash("sha256").update(receiptBytes).digest("hex")}`;
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as SocialReviewGenerationReceipt;
  const derivedGenerationId = deriveSocialReviewGenerationId(receipt.project_id, receipt.inputs, receipt.input_files);
  if (receipt.generation_id !== generationId || derivedGenerationId !== generationId) {
    throw new Error("generation identity does not rederive from the immutable receipt");
  }
  const generation: SocialReviewGeneration = {
    version: SOCIAL_REVIEW_GENERATION_VERSION,
    project_id: receipt.project_id,
    project_dir: root,
    generation_id: receipt.generation_id,
    generation_dir: generationDir,
    output_path: path.join(generationRoot, "review.mp4"),
    receipt_path: receiptPath,
    inputs: receipt.inputs,
    input_files: receipt.input_files,
    source_input_attestation: JSON.parse(
      fs.readFileSync(resolveProjectArtifact(root, receipt.source_input_attestation.path), "utf8"),
    ) as unknown,
  };
  verifyReviewReadyReceipt(generation, receipt, { assertInputsUnchanged: false, historical: true });
  if (!receipt.review_ready) throw new Error("generation is not review-ready");
  return {
    generation_id: receipt.generation_id,
    project_id: receipt.project_id,
    generation_dir: generationDir,
    receipt,
    receipt_sha256: receiptSha256,
    output: receipt.output,
  };
}
