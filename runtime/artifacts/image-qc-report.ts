/**
 * Canonical Issue 37 still-image QC artifact and compile gate.
 *
 * The route is intentionally small: inspect the current generated stills,
 * retry a rejected image with concrete repair constraints at most twice, and
 * publish only bounded plain-data evidence. Issue 44 remains the source of
 * truth for optional/required visual-model classification and for the later
 * deterministic-plus-human fail-open policy.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_IMAGE_QC_MODEL,
  DEFAULT_IMAGE_QC_POLICY,
  DEFAULT_IMAGE_QC_REGENERATION_MODEL,
  IMAGE_QC_CONNECTOR_VERSION,
  IMAGE_QC_PROMPT_TEMPLATE_ID,
  IMAGE_QC_RESPONSE_FORMAT,
  buildImageQcPrompt,
  buildImageQcRegenerationPrompt,
  buildImageQcRepairPrompt,
  buildRepairConstraints,
  computeImageQcPromptHash,
  computeImageQcVerdict,
  defectsOf,
  mimeTypeForPath,
  normalizeImageQcResult,
  parseImageQcJson,
  sanitizeImageQcText,
  type ImageQcExecutionMode,
  type ImageQcExecutionResult,
  type ImageQcInspection,
  type ImageQcInspectionFn,
  type ImageQcPolicy,
  type ImageQcProviderIdentity,
  type ImageQcRegenerationFn,
  type ImageQcRepairConstraints,
} from "../connectors/image-qc-vlm.js";
import { callGeminiRawBody, extractImageFromRawBody, extractTextFromRawBody } from "../connectors/gemini-json.js";
import {
  classifyOptionalVlmResult,
  loadProjectOptionalVlmCapability,
  sanitizeOptionalVlmIdentity,
  sameOptionalUnavailableResult,
  shouldRetryOptionalVlm,
  type OptionalVlmCapability,
  type OptionalVlmCapabilityProfile,
  type OptionalVlmClassification,
  type OptionalVlmClassificationResult,
} from "../review/optional-vlm-policy.js";
import { atomicWriteJson } from "../pipeline/stages/_util.js";

export const IMAGE_QC_REPORT_VERSION = "1.2.0";
export const IMAGE_QC_ARTIFACT_VERSION = "image-qc-v3";
export const IMAGE_QC_REPORT_RELATIVE_PATH = "03_analysis/image_qc_report.json";
export const IMAGE_QC_MAX_REGENERATION_ATTEMPTS = 2;
export const IMAGE_QC_CANONICAL_PRODUCER = "analysis-pipeline";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const BARE_SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_QC_PROVIDER = "gemini";
const OPTIONAL_HANDOFF = "optional_vlm_policy" as const;

export type ImageQcReportStatus = "ready" | "blocked" | "skipped" | "partial";
export type ImageQcAssetStatus = "approved" | "rejected" | "skipped";

export interface ImageQcAttemptRegeneration {
  provider: string;
  model: string;
}

export interface ImageQcAttempt {
  attempt: number;
  provider: string;
  model: string;
  prompt_sha256: string;
  regeneration: ImageQcAttemptRegeneration | null;
  prompt_template_id: string;
  prompt_hash: string;
  repair_constraints: ImageQcRepairConstraints | null;
  inspection: ImageQcInspection;
  overall_score: number;
  verdict: "approved" | "rejected";
  rejection_reasons: string[];
  /** Hash of the actual frame bytes inspected for this attempt. */
  frame_content_sha256: string;
}

export interface ImageQcAssetReport {
  asset_id: string;
  frame_path: string;
  frame_content_sha256: string;
  inspected: boolean;
  status: ImageQcAssetStatus;
  overall_score: number | null;
  attempts: ImageQcAttempt[];
  regeneration_attempts: number;
  regeneration_providers: string[];
  regeneration_failures: string[];
  regeneration_skipped_reason: string | null;
  unavailable_reason: string | null;
}

export interface ImageQcReportProvenance {
  producer: string;
  connector_version: string;
  prompt_template_id: string;
  prompt_hash: string;
  response_format: string;
  policy_hash: string;
  brief_context_sha256: string;
  brief_available: boolean;
  inspection_provider: string;
  inspection_model: string;
  regeneration_provider: string | null;
  regeneration_model: string | null;
  execution_mode: ImageQcExecutionMode;
  /** Fixed handoff marker; no approval is implied here. */
  issue44_handoff: typeof OPTIONAL_HANDOFF | null;
}

export interface ImageQcReport {
  version: string;
  artifact_version: string;
  created_at: string;
  project_id: string;
  profile_id: string;
  capability: OptionalVlmCapability;
  outcome: OptionalVlmClassificationResult;
  policy: ImageQcPolicy;
  summary: {
    status: ImageQcReportStatus;
    image_asset_count: number;
    inspected_assets: number;
    approved_assets: number;
    rejected_assets: number;
    skipped_assets: number;
    regeneration_attempts: number;
    total_attempts: number;
  };
  assets: ImageQcAssetReport[];
  warnings: string[];
  provenance: ImageQcReportProvenance;
}

export interface RunImageQcGateOptions {
  projectDir: string;
  /** Retained for source compatibility; canonical state/assets win. */
  projectId?: string;
  now?: () => string;
  /** Deterministic test seam. Public analyze/compile routes never pass it. */
  inspectionFn?: ImageQcInspectionFn;
  /** Deterministic test seam. Public analyze/compile routes never pass it. */
  regenerationFn?: ImageQcRegenerationFn;
  /** Test-only profile fixture; production derives this from the brief/profile. */
  capabilityProfile?: OptionalVlmCapabilityProfile;
}

export interface ImageQcGateResult {
  report: ImageQcReport | null;
  reportPath: string | null;
  applicable: boolean;
}

interface JsonDocument {
  items?: unknown[];
  [key: string]: unknown;
}

interface AssetRow {
  asset_id: string;
  media_kind?: unknown;
  still_image?: Record<string, unknown>;
  [key: string]: unknown;
}

interface SegmentRow {
  asset_id?: string;
  provenance?: { tags?: Record<string, unknown> };
  [key: string]: unknown;
}

interface FrameInfo {
  relativePath: string;
  absolutePath: string;
  sha: string;
}

interface AssetInspectionResult {
  asset: ImageQcAssetReport;
  failure: OptionalVlmClassificationResult | null;
  qaFailed: boolean;
}

// ── Stable data helpers ─────────────────────────────────────────────

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export function computeImageQcPolicyHash(policy: ImageQcPolicy): string {
  return `sha256:${createHash("sha256").update(stableStringify(policy)).digest("hex")}`;
}

export function resolveCanonicalImageQcPolicy(projectDir: string): ImageQcPolicy {
  const repoRoot = findRepoRoot(path.resolve(projectDir));
  if (!repoRoot) return { ...DEFAULT_IMAGE_QC_POLICY };
  const defaultsPath = path.join(repoRoot, "runtime", "analysis-defaults.yaml");
  if (!fs.existsSync(defaultsPath)) return { ...DEFAULT_IMAGE_QC_POLICY };
  try {
    const parsed = parseYaml(fs.readFileSync(defaultsPath, "utf8")) as Record<string, unknown>;
    const raw = isRecord(parsed.image_qc) ? parsed.image_qc : {};
    const threshold = typeof raw.approve_at_or_above === "number" && Number.isFinite(raw.approve_at_or_above)
      ? Math.max(0, Math.min(1, raw.approve_at_or_above))
      : DEFAULT_IMAGE_QC_POLICY.approve_at_or_above;
    return {
      approve_at_or_above: threshold,
      max_regeneration_attempts: IMAGE_QC_MAX_REGENERATION_ATTEMPTS,
      critical_defect_rejects: raw.critical_defect_rejects !== false,
    };
  } catch {
    return { ...DEFAULT_IMAGE_QC_POLICY };
  }
}

function findRepoRoot(from: string): string | null {
  let current = path.resolve(from);
  while (true) {
    if (fs.existsSync(path.join(current, "package.json")) && fs.existsSync(path.join(current, "schemas"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readCanonicalProjectId(projectDir: string, assetsDoc: JsonDocument): string {
  try {
    const statePath = path.join(path.resolve(projectDir), "project_state.yaml");
    if (fs.existsSync(statePath)) {
      const state = parseYaml(fs.readFileSync(statePath, "utf8")) as { project_id?: unknown };
      if (typeof state.project_id === "string" && state.project_id.length > 0) return state.project_id;
    }
  } catch {
    // Assets remain the project-local fallback for lightweight analysis fixtures.
  }
  return typeof assetsDoc.project_id === "string" && assetsDoc.project_id.length > 0
    ? assetsDoc.project_id
    : path.basename(path.resolve(projectDir));
}

function readBrief(projectDir: string): { text: string; available: boolean } {
  const briefPath = path.join(path.resolve(projectDir), "01_intent", "creative_brief.yaml");
  try {
    const text = fs.readFileSync(briefPath, "utf8").trim();
    return { text, available: text.length > 0 };
  } catch {
    return { text: "", available: false };
  }
}

function readJsonDocument(filePath: string): JsonDocument {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function imageAssets(doc: JsonDocument): AssetRow[] {
  return (Array.isArray(doc.items) ? doc.items : [])
    .filter((item): item is AssetRow => isRecord(item) && typeof item.asset_id === "string" && isImageAssetRow(item as AssetRow))
    .sort((left, right) => left.asset_id.localeCompare(right.asset_id));
}

function isImageAssetRow(asset: AssetRow): boolean {
  return asset.media_kind === "image" || isRecord(asset.still_image);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bareSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function asBareSha(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/^sha256:/, "");
}

function safeIdentity(value: unknown, fallback: string): string {
  return sanitizeOptionalVlmIdentity(value, fallback);
}

function safeAssetId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

function hashText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

// ── Provider adapters ───────────────────────────────────────────────

function createGeminiInspectionFn(): ImageQcInspectionFn | undefined {
  if (!process.env.GEMINI_API_KEY) return undefined;
  return async (request): Promise<ImageQcExecutionResult> => {
    const imageData = fs.readFileSync(request.frame_path).toString("base64");
    const body = JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: mimeTypeForPath(request.frame_path), data: imageData } },
        { text: request.prompt },
      ] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 8192 },
    });
    const raw = await callGeminiRawBody(DEFAULT_IMAGE_QC_MODEL, body);
    const inspection = normalizeImageQcResult(parseImageQcJson(extractTextFromRawBody(raw)));
    return {
      inspection,
      provider: IMAGE_QC_PROVIDER,
      model: DEFAULT_IMAGE_QC_MODEL,
      prompt_sha256: hashText(request.prompt),
    };
  };
}

function createGeminiRegenerationFn(): ImageQcRegenerationFn | undefined {
  if (!process.env.GEMINI_API_KEY) return undefined;
  return async (request) => {
    const prompt = buildImageQcRegenerationPrompt(request.repair_constraints);
    const imageData = fs.readFileSync(request.frame_path).toString("base64");
    const body = JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: mimeTypeForPath(request.frame_path), data: imageData } },
        { text: prompt },
      ] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    });
    const raw = await callGeminiRawBody(DEFAULT_IMAGE_QC_REGENERATION_MODEL, body);
    const output = extractImageFromRawBody(raw);
    fs.writeFileSync(request.frame_path, Buffer.from(output.data, "base64"));
    return { provider: IMAGE_QC_PROVIDER, model: DEFAULT_IMAGE_QC_REGENERATION_MODEL };
  };
}

function unavailableOutcome(identity: ImageQcProviderIdentity): OptionalVlmClassificationResult {
  return classifyOptionalVlmResult({
    status: "unavailable_optional",
    error_code: "OPTIONAL_UNAVAILABLE",
    provider: identity.provider,
    model: identity.model,
  }, identity);
}

function failureOutcome(
  identity: ImageQcProviderIdentity,
  classification: "execution_failed" | "invalid_result",
  errorCode: "EXECUTION_ERROR" | "MALFORMED_RESPONSE",
): OptionalVlmClassificationResult {
  return classifyOptionalVlmResult({
    status: classification,
    error_code: errorCode,
    provider: identity.provider,
    model: identity.model,
  }, identity);
}

/**
 * Classify provider failures with the shared Issue 44 taxonomy while keeping
 * the original error entirely in memory.  In particular, Gemini's transport
 * reports HTTP 401/403 and model/cache failures in an Error message rather
 * than a structured result.
 */
function classifyImageQcProviderError(
  error: unknown,
  identity: ImageQcProviderIdentity,
): OptionalVlmClassificationResult {
  const message = error instanceof Error ? error.message : String(error);
  const malformed = error instanceof SyntaxError
    || /image_qc_(?:malformed|evaluable_score_missing|composition_unevaluable|anatomy_unevaluable)|(?:response|json).*(?:no text|empty|malformed|invalid)/i.test(message);
  const optionalUnavailable = /GEMINI_API_KEY environment variable is required|(?:optional\s+(?:provider|visual model)|provider)\s+(?:is\s+)?(?:not configured|missing)/i.test(message);
  if (optionalUnavailable && !malformed) return unavailableOutcome(identity);
  const record: Record<string, unknown> = {
    error_code: malformed ? "MALFORMED_RESPONSE" : undefined,
    status: malformed ? "invalid_result" : undefined,
    error: { message },
  };
  if (isRecord(error)) {
    for (const key of ["status", "statusCode", "http_status", "httpStatus", "status_code", "code"] as const) {
      const value = error[key];
      if (typeof value === "number" || typeof value === "string") record[key] = value;
    }
  }
  const classified = classifyOptionalVlmResult(record, identity);
  if (malformed) {
    return failureOutcome(identity, "invalid_result", "MALFORMED_RESPONSE");
  }
  return classified;
}

function qaOutcome(identity: ImageQcProviderIdentity): OptionalVlmClassificationResult {
  return classifyOptionalVlmResult({
    status: "qa_failed",
    error_code: "MODEL_DETECTED_DEFECT",
    provider: identity.provider,
    model: identity.model,
  }, identity);
}

const IMAGE_QC_OUTCOME_PRIORITY: Record<OptionalVlmClassification, number> = {
  available: 0,
  unavailable_optional: 1,
  execution_failed: 2,
  invalid_result: 2,
  qa_failed: 3,
};

function preferImageQcFailure(
  current: OptionalVlmClassificationResult | null,
  candidate: OptionalVlmClassificationResult | null,
): OptionalVlmClassificationResult | null {
  if (!candidate) return current;
  if (!current || IMAGE_QC_OUTCOME_PRIORITY[candidate.classification] > IMAGE_QC_OUTCOME_PRIORITY[current.classification]) {
    return candidate;
  }
  return current;
}

// ── Gate stage ───────────────────────────────────────────────────────

export async function runImageQcGate(options: RunImageQcGateOptions): Promise<ImageQcGateResult> {
  const projectDir = path.resolve(options.projectDir);
  const analysisDir = path.join(projectDir, "03_analysis");
  const assetsPath = path.join(analysisDir, "assets.json");
  if (!fs.existsSync(assetsPath)) return { report: null, reportPath: null, applicable: false };

  const assetsDoc = readJsonDocument(assetsPath);
  const assets = imageAssets(assetsDoc);
  if (assets.length === 0) return { report: null, reportPath: null, applicable: false };
  const segmentsPath = path.join(analysisDir, "segments.json");
  const segmentsDoc = fs.existsSync(segmentsPath) ? readJsonDocument(segmentsPath) : { items: [] };
  const segments = (Array.isArray(segmentsDoc.items) ? segmentsDoc.items : [])
    .filter((item): item is SegmentRow => isRecord(item)) as SegmentRow[];
  const projectId = readCanonicalProjectId(projectDir, assetsDoc);
  const profile = options.capabilityProfile ?? loadProjectOptionalVlmCapability(projectDir);
  const policy = resolveCanonicalImageQcPolicy(projectDir);
  const brief = readBrief(projectDir);
  const inspectionFn = options.inspectionFn ?? createGeminiInspectionFn();
  const regenerationFn = options.regenerationFn ?? createGeminiRegenerationFn();
  const providerIdentity: ImageQcProviderIdentity = {
    provider: IMAGE_QC_PROVIDER,
    model: DEFAULT_IMAGE_QC_MODEL,
  };
  const currentUnavailable = unavailableOutcome(providerIdentity);
  const existing = readReportIfPresent(path.join(analysisDir, "image_qc_report.json"));
  if (!inspectionFn && existing && canReuseNonWaivableReport(existing, projectDir, assets, profile, projectId)) {
    return {
      report: existing,
      reportPath: path.join(analysisDir, "image_qc_report.json"),
      applicable: true,
    };
  }
  if (!inspectionFn && existing && canReuseUnavailableReport(existing, projectDir, assets, profile, projectId, currentUnavailable)) {
    return {
      report: existing,
      reportPath: path.join(analysisDir, "image_qc_report.json"),
      applicable: true,
    };
  }
  if (inspectionFn && existing && canReuseProviderUnavailableReport(existing, projectDir, assets, profile, projectId)) {
    return {
      report: existing,
      reportPath: path.join(analysisDir, "image_qc_report.json"),
      applicable: true,
    };
  }
  if (existing && canReuseApprovedReport(existing, projectDir, assets, profile, projectId)) {
    return {
      report: existing,
      reportPath: path.join(analysisDir, "image_qc_report.json"),
      applicable: true,
    };
  }

  const warnings: string[] = [];
  const assetReports: ImageQcAssetReport[] = [];
  let failure: OptionalVlmClassificationResult | null = null;
  let qaFailed = false;
  const reportIdentity = hashText(stableStringify({
    artifact_version: IMAGE_QC_ARTIFACT_VERSION,
    project_id: projectId,
    asset_ids: assets.map((asset) => asset.asset_id),
    policy,
  }));

  for (const asset of assets) {
    const frame = resolveFrame(analysisDir, asset);
    if (!frame) {
      const reason = frameFailureReason(analysisDir, asset);
      warnings.push(`${safeAssetId(asset.asset_id)}:${reason}`);
      assetReports.push(skippedAssetReport(asset, "unknown", "", reason));
      continue;
    }
    const expected = asBareSha(asset.still_image?.normalized_frame_content_sha256);
    if (!expected) {
      const reason = "still_frame_hash_missing";
      warnings.push(`${safeAssetId(asset.asset_id)}:${reason}`);
      assetReports.push(skippedAssetReport(asset, frame.relativePath, frame.sha, reason));
      failure = preferImageQcFailure(failure, failureOutcome(providerIdentity, "invalid_result", "MALFORMED_RESPONSE"));
      continue;
    }
    if (expected !== frame.sha) {
      warnings.push(`${safeAssetId(asset.asset_id)}:still_frame_hash_mismatch`);
      assetReports.push(skippedAssetReport(asset, frame.relativePath, frame.sha, "still_frame_hash_mismatch"));
      continue;
    }
    if (!inspectionFn) {
      assetReports.push(skippedAssetReport(asset, frame.relativePath, frame.sha, "image_qc_inspection_unavailable"));
      continue;
    }

    const result = await inspectAssetWithRetry({
      asset,
      frame,
      projectId,
      brief,
      policy,
      inspectionFn,
      regenerationFn,
      reportIdentity,
      assetsDoc,
      segmentsDoc,
      segments,
      assetsPath,
      segmentsPath,
    });
    assetReports.push(result.asset);
    failure = preferImageQcFailure(failure, result.failure);
    qaFailed ||= result.qaFailed;
    if (result.failure) warnings.push(`${safeAssetId(asset.asset_id)}:image_qc_provider_unavailable`);
  }

  const outcome = qaFailed
    ? qaOutcome(providerIdentity)
    : failure ?? (inspectionFn ? classifyOptionalVlmResult({
      status: "available",
      provider: providerIdentity.provider,
      model: providerIdentity.model,
    }, providerIdentity) : currentUnavailable);
  const report = buildReport({
    projectId,
    profile,
    capability: profile.capability,
    policy,
    brief,
    assets: assetReports,
    warnings,
    outcome,
    now: options.now,
    executionMode: "production",
  });
  const reportPath = path.join(analysisDir, "image_qc_report.json");
  atomicWriteJson(reportPath, report);
  return { report, reportPath, applicable: true };
}

async function inspectAssetWithRetry(args: {
  asset: AssetRow;
  frame: FrameInfo;
  projectId: string;
  brief: { text: string; available: boolean };
  policy: ImageQcPolicy;
  inspectionFn: ImageQcInspectionFn;
  regenerationFn?: ImageQcRegenerationFn;
  reportIdentity: string;
  assetsDoc: JsonDocument;
  segmentsDoc: JsonDocument;
  segments: SegmentRow[];
  assetsPath: string;
  segmentsPath: string;
}): Promise<AssetInspectionResult> {
  const { asset, frame, projectId, brief, policy, inspectionFn, regenerationFn, reportIdentity } = args;
  const basePrompt = buildImageQcPrompt(brief.text);
  const attempts: ImageQcAttempt[] = [];
  const regenerationProviders: string[] = [];
  const regenerationFailures: string[] = [];
  let regenerationSkippedReason: string | null = null;
  let regenerationAttempts = 0;
  let currentFrame = frame;
  let constraints: ImageQcRepairConstraints | null = null;
  let lastRegeneration: ImageQcAttemptRegeneration | null = null;
  let prompt = basePrompt;
  let failure: OptionalVlmClassificationResult | null = null;
  let qaFailed = false;

  while (true) {
    let execution: ImageQcExecutionResult;
    try {
      execution = await inspectionFn({
        project_id: projectId,
        asset_id: asset.asset_id,
        frame_path: currentFrame.absolutePath,
        frame_sha256: currentFrame.sha,
        prompt,
        brief_context_sha256: hashText(brief.text),
        attempt_index: attempts.length + 1,
        repair_constraints: constraints,
        report_identity: reportIdentity,
      });
      const inspection = normalizeImageQcResult(execution.inspection);
      const verdict = computeImageQcVerdict(inspection, policy, { briefAvailable: brief.available });
      attempts.push({
        attempt: attempts.length + 1,
        provider: safeIdentity(execution.provider, IMAGE_QC_PROVIDER),
        model: safeIdentity(execution.model, DEFAULT_IMAGE_QC_MODEL),
        prompt_sha256: hashText(prompt),
        regeneration: attempts.length === 0 ? null : lastRegeneration,
        prompt_template_id: IMAGE_QC_PROMPT_TEMPLATE_ID,
        prompt_hash: computeImageQcPromptHash(brief.text, constraints ?? undefined),
        repair_constraints: constraints,
        inspection,
        overall_score: verdict.overall_score,
        verdict: verdict.verdict,
        rejection_reasons: verdict.rejection_reasons.map((reason) => sanitizeImageQcText(reason, 500)),
        frame_content_sha256: `sha256:${currentFrame.sha}`,
      });
      if (verdict.verdict === "approved") {
        return {
          asset: {
            asset_id: asset.asset_id,
            frame_path: currentFrame.relativePath,
            frame_content_sha256: `sha256:${currentFrame.sha}`,
            inspected: true,
            status: "approved",
            overall_score: verdict.overall_score,
            attempts,
            regeneration_attempts: regenerationAttempts,
            regeneration_providers: regenerationProviders,
            regeneration_failures: regenerationFailures,
            regeneration_skipped_reason: null,
            unavailable_reason: null,
          },
          failure,
          qaFailed,
        };
      }

      if (regenerationAttempts >= IMAGE_QC_MAX_REGENERATION_ATTEMPTS) {
        regenerationSkippedReason = "max_regeneration_attempts_reached";
        break;
      }
      if (!regenerationFn) {
        regenerationSkippedReason = "image_regeneration_provider_unavailable";
        break;
      }
      constraints = buildRepairConstraints(defectsOf(inspection));
      try {
        const regeneration = await regenerationFn({
          asset_id: asset.asset_id,
          frame_path: currentFrame.absolutePath,
          frame_sha256: currentFrame.sha,
          repair_constraints: constraints,
          attempt: regenerationAttempts + 1,
        });
        lastRegeneration = {
          provider: safeIdentity(regeneration.provider, IMAGE_QC_PROVIDER),
          model: safeIdentity(regeneration.model, DEFAULT_IMAGE_QC_REGENERATION_MODEL),
        };
        regenerationProviders.push(lastRegeneration.provider);
      } catch {
        regenerationFailures.push("provider_error");
        regenerationSkippedReason = "regeneration_provider_unavailable";
        break;
      }
      const nextSha = bareSha256(currentFrame.absolutePath);
      if (nextSha === currentFrame.sha) {
        regenerationFailures.push("identical_bytes");
        regenerationSkippedReason = "regeneration_did_not_change_frame";
        break;
      }
      regenerationAttempts += 1;
      restampStillFrameHash(args, currentFrame.sha, nextSha);
      currentFrame = { ...currentFrame, sha: nextSha };
      prompt = buildImageQcRepairPrompt(basePrompt, constraints);
    } catch (error) {
      const identity = {
        provider: IMAGE_QC_PROVIDER,
        model: DEFAULT_IMAGE_QC_MODEL,
      };
      failure = classifyImageQcProviderError(error, identity);
      const inspected = attempts.length > 0;
      return {
        asset: {
          asset_id: asset.asset_id,
          frame_path: currentFrame.relativePath,
          frame_content_sha256: `sha256:${currentFrame.sha}`,
          inspected,
          status: inspected ? "rejected" : "skipped",
          overall_score: attempts.at(-1)?.overall_score ?? null,
          attempts,
          regeneration_attempts: regenerationAttempts,
          regeneration_providers: regenerationProviders,
          regeneration_failures: regenerationFailures,
          regeneration_skipped_reason: inspected ? "inspection_provider_failed" : null,
          unavailable_reason: failure.classification === "unavailable_optional"
            ? "image_qc_inspection_unavailable"
            : "image_qc_provider_failed",
        },
        failure,
        qaFailed,
      };
    }
  }

  const last = attempts[attempts.length - 1];
  return {
    asset: {
      asset_id: asset.asset_id,
      frame_path: currentFrame.relativePath,
      frame_content_sha256: `sha256:${currentFrame.sha}`,
      inspected: attempts.length > 0,
      status: "rejected",
      overall_score: last?.overall_score ?? null,
      attempts,
      regeneration_attempts: regenerationAttempts,
      regeneration_providers: regenerationProviders,
      regeneration_failures: regenerationFailures,
      regeneration_skipped_reason: regenerationSkippedReason,
      unavailable_reason: null,
    },
    failure,
    qaFailed: true,
  };
}

function resolveFrame(analysisDir: string, asset: AssetRow): FrameInfo | null {
  const relativePath = typeof asset.still_image?.normalized_frame_path === "string"
    ? asset.still_image.normalized_frame_path
    : "";
  if (!relativePath || relativePath.includes("?") || relativePath.includes("#")
    || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) return null;
  const absolutePath = path.resolve(analysisDir, relativePath);
  const relative = path.relative(analysisDir, absolutePath);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  try {
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { relativePath, absolutePath, sha: bareSha256(absolutePath) };
  } catch {
    return null;
  }
}

function frameFailureReason(analysisDir: string, asset: AssetRow): string {
  const relativePath = typeof asset.still_image?.normalized_frame_path === "string"
    ? asset.still_image.normalized_frame_path
    : "";
  if (!relativePath || relativePath.includes("?") || relativePath.includes("#")
    || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    return "still_frame_path_invalid";
  }
  const absolute = path.resolve(analysisDir, relativePath);
  try {
    const stat = fs.lstatSync(absolute);
    return stat.isSymbolicLink() ? "still_frame_symlink_rejected" : "still_frame_missing";
  } catch {
    return "still_frame_missing";
  }
}

function skippedAssetReport(
  asset: AssetRow,
  framePath: string,
  sha: string,
  reason: string,
): ImageQcAssetReport {
  return {
    asset_id: asset.asset_id,
    frame_path: framePath,
    frame_content_sha256: `sha256:${sha || "0".repeat(64)}`,
    inspected: false,
    status: "skipped",
    overall_score: null,
    attempts: [],
    regeneration_attempts: 0,
    regeneration_providers: [],
    regeneration_failures: [],
    regeneration_skipped_reason: null,
    unavailable_reason: reason,
  };
}

function restampStillFrameHash(
  args: {
    assetsDoc: JsonDocument;
    segmentsDoc: JsonDocument;
    segments: SegmentRow[];
    assetsPath: string;
    segmentsPath: string;
    asset: AssetRow;
  },
  previousSha: string,
  nextSha: string,
): void {
  const still = isRecord(args.asset.still_image) ? args.asset.still_image : undefined;
  if (still) still.normalized_frame_content_sha256 = nextSha;
  atomicWriteJson(args.assetsPath, args.assetsDoc);
  if (fs.existsSync(args.segmentsPath)) {
    for (const segment of args.segments) {
      if (segment.asset_id !== args.asset.asset_id) continue;
      const tags = isRecord(segment.provenance?.tags) ? segment.provenance!.tags! : undefined;
      const hashes = Array.isArray(tags?.frame_content_sha256) ? tags.frame_content_sha256 : undefined;
      if (hashes && tags) tags.frame_content_sha256 = hashes.map((hash) => hash === previousSha ? nextSha : hash);
    }
    atomicWriteJson(args.segmentsPath, args.segmentsDoc);
  }
}

// ── Report assembly and Issue 44 projection ─────────────────────────

function buildReport(args: {
  projectId: string;
  profile: OptionalVlmCapabilityProfile;
  capability: OptionalVlmCapability;
  policy: ImageQcPolicy;
  brief: { text: string; available: boolean };
  assets: ImageQcAssetReport[];
  warnings: string[];
  outcome: OptionalVlmClassificationResult;
  executionMode: ImageQcExecutionMode;
  now?: () => string;
}): ImageQcReport {
  const inspected = args.assets.filter((asset) => asset.inspected);
  const rejected = args.assets.filter((asset) => asset.status === "rejected");
  const skipped = args.assets.filter((asset) => asset.status === "skipped");
  const requiredUnavailable = args.capability.requirement === "required"
    && args.outcome.classification === "unavailable_optional";
  const failClosedOutcome = ["execution_failed", "invalid_result", "qa_failed"].includes(args.outcome.classification);
  const status: ImageQcReportStatus = rejected.length > 0 || requiredUnavailable || failClosedOutcome
    ? "blocked"
    : inspected.length === 0
      ? "skipped"
      : skipped.length > 0
        ? "partial"
        : "ready";
  const firstAttempt = args.assets.flatMap((asset) => asset.attempts)[0];
  const regeneration = args.assets.flatMap((asset) => asset.attempts)
    .map((attempt) => attempt.regeneration)
    .find((item): item is ImageQcAttemptRegeneration => item !== null) ?? null;
  return {
    version: IMAGE_QC_REPORT_VERSION,
    artifact_version: IMAGE_QC_ARTIFACT_VERSION,
    created_at: args.now?.() ?? new Date().toISOString(),
    project_id: args.projectId,
    profile_id: safeIdentity(args.profile.profile_id, "generic-editorial"),
    capability: {
      id: "visual_model",
      requirement: args.capability.requirement,
      provider: safeIdentity(args.capability.provider, "marlin-local"),
      model: safeIdentity(args.capability.model, "NemoStation_Marlin-2B"),
    },
    outcome: args.outcome,
    policy: { ...args.policy, max_regeneration_attempts: IMAGE_QC_MAX_REGENERATION_ATTEMPTS },
    summary: {
      status,
      image_asset_count: args.assets.length,
      inspected_assets: inspected.length,
      approved_assets: args.assets.filter((asset) => asset.status === "approved").length,
      rejected_assets: rejected.length,
      skipped_assets: skipped.length,
      regeneration_attempts: args.assets.reduce((sum, asset) => sum + asset.regeneration_attempts, 0),
      total_attempts: args.assets.reduce((sum, asset) => sum + asset.attempts.length, 0),
    },
    assets: args.assets,
    warnings: args.warnings.map((warning) => sanitizeImageQcText(warning, 200)),
    provenance: {
      producer: IMAGE_QC_CANONICAL_PRODUCER,
      connector_version: IMAGE_QC_CONNECTOR_VERSION,
      prompt_template_id: IMAGE_QC_PROMPT_TEMPLATE_ID,
      prompt_hash: computeImageQcPromptHash(args.brief.text),
      response_format: IMAGE_QC_RESPONSE_FORMAT,
      policy_hash: computeImageQcPolicyHash(args.policy),
      brief_context_sha256: hashText(args.brief.text),
      brief_available: args.brief.available,
      inspection_provider: firstAttempt?.provider ?? IMAGE_QC_PROVIDER,
      inspection_model: firstAttempt?.model ?? DEFAULT_IMAGE_QC_MODEL,
      regeneration_provider: regeneration?.provider ?? null,
      regeneration_model: regeneration?.model ?? null,
      execution_mode: args.executionMode,
      issue44_handoff: args.outcome.classification === "unavailable_optional"
        && args.capability.requirement === "optional"
        ? OPTIONAL_HANDOFF
        : null,
    },
  };
}

// ── Report persistence and bounded unavailable reuse ─────────────────

function readReportIfPresent(reportPath: string): ImageQcReport | null {
  if (!fs.existsSync(reportPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed as unknown as ImageQcReport : null;
  } catch {
    return null;
  }
}

function currentAssetBindings(projectDir: string, assets: AssetRow[]): boolean {
  const analysisDir = path.join(path.resolve(projectDir), "03_analysis");
  return assets.every((asset) => {
    const frame = resolveFrame(analysisDir, asset);
    if (!frame) return false;
    const declared = asBareSha(asset.still_image?.normalized_frame_content_sha256);
    return Boolean(declared && declared === frame.sha);
  });
}

function reportMatchesCurrentAssets(projectDir: string, report: ImageQcReport, assets: AssetRow[], projectId: string): boolean {
  if (!Array.isArray(report.assets) || report.project_id !== projectId || report.assets.length !== assets.length) return false;
  if (!currentAssetBindings(projectDir, assets)) return false;
  const analysisDir = path.join(path.resolve(projectDir), "03_analysis");
  return assets.every((asset) => {
    const reportAsset = report.assets.find((candidate) => candidate.asset_id === asset.asset_id);
    const frame = resolveFrame(analysisDir, asset);
    return Boolean(reportAsset && frame && reportAsset.frame_content_sha256 === `sha256:${frame.sha}`);
  });
}

function canReuseUnavailableReport(
  report: ImageQcReport,
  projectDir: string,
  assets: AssetRow[],
  profile: OptionalVlmCapabilityProfile,
  projectId: string,
  current: OptionalVlmClassificationResult,
): boolean {
  return reportMatchesCurrentAssets(projectDir, report, assets, projectId)
    && report.provenance?.brief_context_sha256 === hashText(readBrief(projectDir).text)
    && report.profile_id === safeIdentity(profile.profile_id, "generic-editorial")
    && report.capability?.requirement === profile.capability.requirement
    && !shouldRetryOptionalVlm(report.outcome, current)
    && sameOptionalUnavailableResult(report.outcome, current)
    && report.provenance?.issue44_handoff === OPTIONAL_HANDOFF;
}

function canReuseNonWaivableReport(
  report: ImageQcReport,
  projectDir: string,
  assets: AssetRow[],
  profile: OptionalVlmCapabilityProfile,
  projectId: string,
): boolean {
  const outcome = report.outcome?.classification;
  return Array.isArray(report.assets)
    && reportMatchesCurrentAssets(projectDir, report, assets, projectId)
    && report.provenance?.brief_context_sha256 === hashText(readBrief(projectDir).text)
    && report.profile_id === safeIdentity(profile.profile_id, "generic-editorial")
    && report.capability?.requirement === profile.capability.requirement
    && (outcome === "qa_failed"
      || outcome === "execution_failed"
      || outcome === "invalid_result"
      || report.assets.some((asset) => asset.status === "rejected"));
}

function canReuseProviderUnavailableReport(
  report: ImageQcReport,
  projectDir: string,
  assets: AssetRow[],
  profile: OptionalVlmCapabilityProfile,
  projectId: string,
): boolean {
  return Array.isArray(report.assets)
    && report.outcome?.classification === "unavailable_optional"
    // OPTIONAL_UNAVAILABLE is the cheap no-configuration sentinel. A
    // configured provider's specific unavailable result (401/403/cache/etc.)
    // is stable and must not trigger another expensive request on every
    // analyze/compile invocation.
    && report.outcome.error_code !== "OPTIONAL_UNAVAILABLE"
    && report.provenance?.issue44_handoff === OPTIONAL_HANDOFF
    && reportMatchesCurrentAssets(projectDir, report, assets, projectId)
    && report.provenance?.brief_context_sha256 === hashText(readBrief(projectDir).text)
    && report.profile_id === safeIdentity(profile.profile_id, "generic-editorial")
    && report.capability?.requirement === profile.capability.requirement;
}

function canReuseApprovedReport(
  report: ImageQcReport,
  projectDir: string,
  assets: AssetRow[],
  profile: OptionalVlmCapabilityProfile,
  projectId: string,
): boolean {
  return report.summary?.status === "ready"
    && report.outcome?.classification === "available"
    && reportMatchesCurrentAssets(projectDir, report, assets, projectId)
    && report.provenance?.brief_context_sha256 === hashText(readBrief(projectDir).text)
    && report.profile_id === safeIdentity(profile.profile_id, "generic-editorial")
    && report.capability?.requirement === profile.capability.requirement;
}

// ── Compile gate ─────────────────────────────────────────────────────

export function imageQcAppliesToProject(projectDir: string): boolean {
  const assetsPath = path.join(path.resolve(projectDir), "03_analysis", "assets.json");
  if (!fs.existsSync(assetsPath)) return false;
  try {
    return imageAssets(readJsonDocument(assetsPath)).length > 0;
  } catch {
    return false;
  }
}

export function imageQcCompileGateReason(report: ImageQcReport): string | null {
  const candidate = report as unknown as Record<string, unknown>;
  const assets = Array.isArray(candidate.assets) ? candidate.assets as ImageQcAssetReport[] : [];
  const outcome = isRecord(candidate.outcome) ? candidate.outcome as Partial<OptionalVlmClassificationResult> : {};
  const capability = isRecord(candidate.capability) ? candidate.capability as Partial<OptionalVlmCapability> : {};
  const provenance = isRecord(candidate.provenance) ? candidate.provenance as Partial<ImageQcReportProvenance> : {};
  const rejected = assets.filter((asset) => asset.status === "rejected");
  if (rejected.length > 0 || outcome.classification === "qa_failed") {
    return rejected.length > 0
      ? `rejected assets: ${rejected.map((asset) => safeAssetId(asset.asset_id)).join(", ")}`
      : "qa_failed cannot be waived";
  }
  if (outcome.classification === "execution_failed") return "visual_model execution_failed is fail-closed";
  if (outcome.classification === "invalid_result") return "visual_model invalid_result is fail-closed";
  if (outcome.classification === "unavailable_optional") {
    if (capability.requirement !== "optional") return "required visual_model capability is unavailable";
    if (provenance.issue44_handoff !== OPTIONAL_HANDOFF) return "optional visual QA handoff is missing";
    if (assets.some((asset) => asset.status === "skipped"
      && asset.unavailable_reason !== "image_qc_inspection_unavailable")) {
      return "image QC input is unavailable";
    }
    return null;
  }
  if (assets.some((asset) => asset.status === "skipped")) return "image QC has skipped assets";
  const status = isRecord(candidate.summary) ? candidate.summary.status : undefined;
  return status === "ready" ? null : `gate_status_${String(status ?? "invalid")}`;
}

export class ImageQcGateError extends Error {
  readonly code = "IMAGE_QC_GATE_BLOCKED";
  constructor(readonly rejectedAssetIds: string[], readonly issues: string[]) {
    super(`image_qc_gate_blocked: ${rejectedAssetIds.length > 0 ? `rejected assets: ${rejectedAssetIds.join(", ")}` : issues.join("; ")}`);
    this.name = "ImageQcGateError";
  }
}

export function assertImageQcGateOpen(projectDir: string): void {
  if (!imageQcAppliesToProject(projectDir)) return;
  const reportPath = path.join(path.resolve(projectDir), IMAGE_QC_REPORT_RELATIVE_PATH);
  if (!fs.existsSync(reportPath)) throw new ImageQcGateError([], ["image_qc_report_missing"]);
  let report: unknown;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch {
    throw new ImageQcGateError([], ["image_qc_report_unparsable"]);
  }
  const integrity = validateImageQcReportIntegrity(report, { projectDir, verifier: "canonical" });
  if (integrity.violations.length > 0) throw new ImageQcGateError([], integrity.violations);
  const reason = imageQcCompileGateReason(report as ImageQcReport);
  if (reason) {
    throw new ImageQcGateError(
      (report as ImageQcReport).assets.filter((asset) => asset.status === "rejected").map((asset) => asset.asset_id),
      [reason],
    );
  }
}

/** Public report-only API used by the patch route and compatibility callers. */
export async function enforceCanonicalImageQcGate(projectDir: string): Promise<ImageQcReport> {
  const result = await runImageQcGate({ projectDir: path.resolve(projectDir) });
  if (!result.applicable || !result.report) return result.report as ImageQcReport;
  assertImageQcGateOpen(projectDir);
  return result.report;
}

// ── Integrity and current-project binding ────────────────────────────

export interface ImageQcReportIntegrityResult {
  violations: string[];
}

export interface ImageQcReportIntegrityContext {
  projectDir?: string;
  verifier?: "canonical" | "non-production";
}

export function validateImageQcReportIntegrity(
  data: unknown,
  context: ImageQcReportIntegrityContext = {},
): ImageQcReportIntegrityResult {
  const violations: string[] = [];
  if (!isRecord(data)) return { violations: ["image_qc_report_not_an_object"] };
  const report = data as Record<string, unknown>;
  if (report.version !== IMAGE_QC_REPORT_VERSION) violations.push("version_unsupported");
  if (report.artifact_version !== IMAGE_QC_ARTIFACT_VERSION) violations.push("artifact_version_unsupported");
  if (typeof report.created_at !== "string" || Number.isNaN(Date.parse(report.created_at))) violations.push("created_at_invalid");
  if (typeof report.project_id !== "string" || !report.project_id) violations.push("project_id_invalid");
  if (typeof report.profile_id !== "string" || !report.profile_id) violations.push("profile_id_invalid");
  const policy = report.policy as Partial<ImageQcPolicy> | undefined;
  if (!isRecord(policy)) violations.push("policy_missing");
  else {
    if (policy.max_regeneration_attempts !== IMAGE_QC_MAX_REGENERATION_ATTEMPTS) violations.push("policy_retry_bound_invalid");
    if (typeof policy.approve_at_or_above !== "number" || policy.approve_at_or_above < 0 || policy.approve_at_or_above > 1) violations.push("policy_threshold_invalid");
    if (typeof policy.critical_defect_rejects !== "boolean") violations.push("policy_critical_defect_flag_invalid");
  }
  const capability = isRecord(report.capability) ? report.capability : undefined;
  if (!capability || capability.id !== "visual_model"
    || !["required", "optional"].includes(String(capability.requirement))
    || typeof capability.provider !== "string" || !capability.provider
    || typeof capability.model !== "string" || !capability.model) {
    violations.push("capability_invalid");
  }
  const outcome = isRecord(report.outcome) ? report.outcome : undefined;
  if (!outcome || !["available", "unavailable_optional", "execution_failed", "invalid_result", "qa_failed"].includes(String(outcome.classification))) {
    violations.push("outcome_invalid");
  } else {
    const expected = classifyOptionalVlmResult(outcome, {
      provider: outcome.provider,
      model: outcome.model,
    });
    if (outcome.classification !== expected.classification || outcome.error_code !== expected.error_code || outcome.provider !== expected.provider || outcome.model !== expected.model) {
      violations.push("outcome_not_issue44_classified");
    }
    if (outcome.result_fingerprint !== expected.result_fingerprint) violations.push("outcome_fingerprint_mismatch");
  }
  const provenance = isRecord(report.provenance) ? report.provenance : undefined;
  if (!provenance) violations.push("provenance_missing");
  else {
    for (const field of ["producer", "connector_version", "prompt_template_id", "response_format", "inspection_provider", "inspection_model"] as const) {
      if (typeof provenance[field] !== "string" || !provenance[field]) violations.push(`provenance_${field}_invalid`);
    }
    for (const field of ["prompt_hash", "policy_hash", "brief_context_sha256"] as const) {
      if (typeof provenance[field] !== "string" || !SHA256.test(provenance[field] as string)) violations.push(`provenance_${field}_invalid`);
    }
    if (typeof provenance.brief_available !== "boolean") violations.push("provenance_brief_available_invalid");
    if (!["production", "test", "untrusted"].includes(String(provenance.execution_mode))) violations.push("provenance_execution_mode_invalid");
    if (provenance.issue44_handoff !== null && provenance.issue44_handoff !== OPTIONAL_HANDOFF) violations.push("provenance_issue44_handoff_invalid");
    if (isRecord(policy) && provenance.policy_hash !== computeImageQcPolicyHash(policy as ImageQcPolicy)) violations.push("provenance_policy_hash_mismatch");
  }

  const assets = Array.isArray(report.assets) ? report.assets : undefined;
  if (!assets) violations.push("assets_not_an_array");
  const normalizedAssets: ImageQcAssetReport[] = [];
  for (const rawAsset of assets ?? []) {
    if (!isRecord(rawAsset)) {
      violations.push("asset_not_an_object");
      continue;
    }
    const asset = rawAsset as unknown as ImageQcAssetReport;
    normalizedAssets.push(asset);
    if (typeof asset.asset_id !== "string" || !asset.asset_id) violations.push("asset_id_invalid");
    if (typeof asset.frame_path !== "string" || path.isAbsolute(asset.frame_path) || asset.frame_path.split(/[\\/]/).includes("..")) violations.push(`${asset.asset_id}:frame_path_invalid`);
    if (typeof asset.frame_content_sha256 !== "string" || !SHA256.test(asset.frame_content_sha256)) violations.push(`${asset.asset_id}:frame_hash_invalid`);
    if (!(["approved", "rejected", "skipped"] as string[]).includes(asset.status)) violations.push(`${asset.asset_id}:status_invalid`);
    if (!Array.isArray(asset.attempts)) {
      violations.push(`${asset.asset_id}:attempts_not_an_array`);
      continue;
    }
    if (asset.inspected !== (asset.attempts.length > 0)) violations.push(`${asset.asset_id}:inspected_mismatch`);
    if (asset.regeneration_attempts < 0 || asset.regeneration_attempts > IMAGE_QC_MAX_REGENERATION_ATTEMPTS) violations.push(`${asset.asset_id}:regeneration_bound_invalid`);
    if (asset.regeneration_attempts < Math.max(0, asset.attempts.length - 1)
      || asset.regeneration_attempts > asset.attempts.length) {
      violations.push(`${asset.asset_id}:regeneration_count_mismatch`);
    }
    for (let index = 0; index < asset.attempts.length; index += 1) {
      const attempt = asset.attempts[index];
      if (!isRecord(attempt)) {
        violations.push(`${asset.asset_id}:attempt_${index + 1}_invalid`);
        continue;
      }
      if (attempt.attempt !== index + 1) violations.push(`${asset.asset_id}:attempt_${index + 1}_number_invalid`);
      if (typeof attempt.prompt_sha256 !== "string" || !SHA256.test(attempt.prompt_sha256)) violations.push(`${asset.asset_id}:attempt_${index + 1}_prompt_hash_invalid`);
      if (typeof attempt.prompt_hash !== "string" || !SHA256.test(attempt.prompt_hash)) violations.push(`${asset.asset_id}:attempt_${index + 1}_prompt_contract_invalid`);
      if (typeof attempt.frame_content_sha256 !== "string" || !SHA256.test(attempt.frame_content_sha256)) violations.push(`${asset.asset_id}:attempt_${index + 1}_frame_hash_invalid`);
      if (!isRecord(attempt.inspection)) {
        violations.push(`${asset.asset_id}:attempt_${index + 1}_inspection_invalid`);
        continue;
      }
      try {
        const inspection = normalizeImageQcResult(attempt.inspection as unknown as Parameters<typeof normalizeImageQcResult>[0]);
        const expectedVerdict = computeImageQcVerdict(inspection, policy as ImageQcPolicy, {
          briefAvailable: provenance?.brief_available === true,
        });
        if (attempt.overall_score !== expectedVerdict.overall_score) violations.push(`${asset.asset_id}:attempt_${index + 1}_score_mismatch`);
        if (attempt.verdict !== expectedVerdict.verdict) violations.push(`${asset.asset_id}:attempt_${index + 1}_verdict_mismatch`);
        if (JSON.stringify(attempt.rejection_reasons) !== JSON.stringify(expectedVerdict.rejection_reasons.map((reason) => sanitizeImageQcText(reason, 500)))) violations.push(`${asset.asset_id}:attempt_${index + 1}_reasons_mismatch`);
      } catch {
        violations.push(`${asset.asset_id}:attempt_${index + 1}_inspection_unreadable`);
      }
    }
    if (asset.status === "approved" && asset.attempts.length === 0) violations.push(`${asset.asset_id}:approved_without_attempt`);
    if (asset.status === "rejected" && asset.attempts.length === 0) violations.push(`${asset.asset_id}:rejected_without_attempt`);
  }
  const summary = isRecord(report.summary) ? report.summary : undefined;
  if (!summary) violations.push("summary_missing");
  else {
    const expectedStatus = normalizedAssets.some((asset) => asset.status === "rejected")
      || ["execution_failed", "invalid_result", "qa_failed"].includes(String(outcome?.classification))
      || capability?.requirement === "required" && outcome?.classification === "unavailable_optional"
      ? "blocked"
      : normalizedAssets.filter((asset) => asset.inspected).length === 0
        ? "skipped"
        : normalizedAssets.some((asset) => asset.status === "skipped") ? "partial" : "ready";
    if (summary.status !== expectedStatus) violations.push("summary_status_mismatch");
    const counts = {
      image_asset_count: normalizedAssets.length,
      inspected_assets: normalizedAssets.filter((asset) => asset.inspected).length,
      approved_assets: normalizedAssets.filter((asset) => asset.status === "approved").length,
      rejected_assets: normalizedAssets.filter((asset) => asset.status === "rejected").length,
      skipped_assets: normalizedAssets.filter((asset) => asset.status === "skipped").length,
      regeneration_attempts: normalizedAssets.reduce((sum, asset) => sum + asset.regeneration_attempts, 0),
      total_attempts: normalizedAssets.reduce((sum, asset) => sum + asset.attempts.length, 0),
    };
    for (const [key, value] of Object.entries(counts)) if (summary[key] !== value) violations.push(`summary_${key}_mismatch`);
  }
  if (!Array.isArray(report.warnings) || report.warnings.some((warning) => typeof warning !== "string")) violations.push("warnings_invalid");

  const serialized = JSON.stringify(data);
  if (/https?:\/\/[^\s"']+\?/i.test(serialized)
    || /\b(?:token|api[_ -]?key|authorization|bearer|request[_ -]?id|query(?:_string)?|search[_ -]?params?)\s*[:=]\s*[^\s,;"}]+/i.test(serialized)) {
    violations.push("report_contains_unsanitized_provider_data");
  }
  if (context.projectDir) violations.push(...validateReportBinding(report, normalizedAssets, context.projectDir));
  return { violations };
}

function validateReportBinding(report: Record<string, unknown>, assets: ImageQcAssetReport[], projectDir: string): string[] {
  const violations: string[] = [];
  const absProject = path.resolve(projectDir);
  const analysisDir = path.join(absProject, "03_analysis");
  const assetsPath = path.join(analysisDir, "assets.json");
  if (!fs.existsSync(assetsPath)) return ["binding_assets_json_missing"];
  let currentDoc: JsonDocument;
  try {
    currentDoc = readJsonDocument(assetsPath);
  } catch {
    return ["binding_assets_json_unparsable"];
  }
  const currentAssets = imageAssets(currentDoc);
  const currentProjectId = readCanonicalProjectId(absProject, currentDoc);
  if (report.project_id !== currentProjectId) violations.push("binding_project_id_mismatch");
  if (currentAssets.length !== assets.length || currentAssets.some((asset) => !assets.some((candidate) => candidate.asset_id === asset.asset_id))) {
    violations.push("binding_asset_set_mismatch");
  }
  const brief = readBrief(absProject);
  const provenance = report.provenance as Partial<ImageQcReportProvenance> | undefined;
  if (provenance?.brief_context_sha256 !== hashText(brief.text)) violations.push("binding_brief_hash_mismatch");
  const expectedProfile = loadProjectOptionalVlmCapability(absProject);
  const capability = report.capability as Partial<OptionalVlmCapability> | undefined;
  if (capability?.requirement !== expectedProfile.capability.requirement) violations.push("binding_capability_requirement_mismatch");
  if (report.profile_id !== safeIdentity(expectedProfile.profile_id, "generic-editorial")) violations.push("binding_profile_id_mismatch");
  for (const asset of assets) {
    const current = currentAssets.find((candidate) => candidate.asset_id === asset.asset_id);
    if (!current) continue;
    const frame = resolveFrame(analysisDir, current);
    if (!frame) {
      violations.push(`${asset.asset_id}:binding_frame_missing`);
      continue;
    }
    const declared = asBareSha(current.still_image?.normalized_frame_content_sha256);
    if (!declared) violations.push(`${asset.asset_id}:binding_declared_frame_hash_missing`);
    else if (declared !== frame.sha) violations.push(`${asset.asset_id}:binding_declared_frame_hash_mismatch`);
    if (asset.frame_content_sha256 !== `sha256:${frame.sha}`) violations.push(`${asset.asset_id}:binding_frame_content_changed_since_qc`);
  }
  return violations;
}

export type { ImageQcExecutionMode, OptionalVlmClassification };
