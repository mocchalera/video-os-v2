/**
 * Single authority for caption-finalize generation identity (Issue 36).
 *
 * The expected generation key is recomputed from CURRENT canonical project
 * sources only — persisted `generation_key_inputs` are comparison evidence,
 * never authority. Canonical sources:
 * - approval:            07_package/caption_approval.json (bytes + project binding)
 * - final approval:      06_review/final-render-approval.json
 * - timeline:            05_timeline/timeline.json (bytes)
 * - lyric script:        01_intent/lyrics.lrc (canonical project lyric source; present mode)
 * - lyric request:       01_intent/lyric_typography_request.json (pre-generation
 *                        canonical options authority for BOTH modes)
 * - typography policy:   04_plan/typography_policy.json (when present)
 * - fonts:               staged binaries in the generation fonts dir, verified
 *                        against the staged font manifest (actual bytes)
 * - music cues:          07_package/music_cues.json
 * - source attestation:  createSourceInputAttestation (current)
 * - supplied-final mode: the staged final video + staged route receipt bytes
 *
 * The generation id/directory must be derived solely from the complete
 * independently recomputed inputs.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonRejectDuplicateKeys, validateAgainstSchema } from "../commands/shared.js";
import { createSourceInputAttestation } from "../render/source-input-attestation.js";
import { computeSha256 } from "../packaging/manifest.js";
import {
  hashAuthoredTextAuthority,
  hashAuthoredTimingAuthority,
} from "./authored-lyrics.js";
import { resolveLyricFontBindings, type LyricPositioning } from "./lyric-typography.js";

export const CAPTION_FINALIZE_CONTRACT_VERSION = "v5" as const;

/** Canonical lyric script source resolved inside the project. */
export const LYRIC_SCRIPT_RELATIVE_PATH = "01_intent/lyrics.lrc";
/** Canonical pre-generation lyric request (options authority, both modes). */
export const LYRIC_REQUEST_RELATIVE_PATH = "01_intent/lyric_typography_request.json";
/** Canonical typography policy (optional key input). */
export const TYPOGRAPHY_POLICY_RELATIVE_PATH = "04_plan/typography_policy.json";

export interface CaptionGenerationKeyInputs extends Record<string, string> {
  caption_finalize_contract: string;
  approval: string;
  timeline: string;
  final_render_approval: string;
  font_primary: string;
  font_ass_bold: string;
  font_ass_heavy: string;
  font_selected_family: string;
  font_selected_role: string;
  font_selected: string;
  typography_policy: string;
  visual_treatment_input: string;
  lyric_input: string;
  /** Hash of the exact lyric role face bindings (family, PS name, TTC index, bytes). */
  lyric_face_identity: string;
  lyric_request: string;
  sourceInputsHash: string;
  suppliedFinalSha256: string;
  suppliedFinalReceiptSha256: string;
  /** Hash of the OUTPUT route receipt for supplied-final generations. */
  suppliedFinalRouteReceiptSha256: string;
  musicSha256: string;
}

export interface GenerationKeyInputSpec {
  approvalSha256: string;
  timelineSha256: string;
  finalRenderApprovalSha256?: string;
  lyricRequestSha256?: string;
  typographyPolicySha256?: string;
  suppliedFinalPath?: string;
  suppliedFinalReceiptPath?: string;
  suppliedFinalRouteReceiptPath?: string;
  fontPrimarySha256: string;
  fontAssBoldSha256: string;
  fontAssHeavySha256: string;
  fontSelectedFamily: string;
  fontSelectedRole: "primary" | "ass_bold" | "ass_heavy";
  fontSelectedSha256: string;
  lyricInputDigest?: string;
  lyricFaceIdentity?: string;
}

function hashOrEmpty(filePath: string): string {
  return fs.existsSync(filePath) ? computeSha256(filePath) : "";
}

function resolveProjectInputFile(projectDir: string, candidate: string, label: string): string {
  const projectRoot = path.resolve(projectDir);
  const resolved = path.resolve(projectRoot, candidate);
  const relative = path.relative(projectRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the project directory`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} is missing: ${resolved}`);
  }
  const projectReal = fs.realpathSync(projectRoot);
  const resolvedReal = fs.realpathSync(resolved);
  const realRelative = path.relative(projectReal, resolvedReal);
  if (realRelative === "" || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`${label} escaped the project directory through a symlink`);
  }
  return resolved;
}

/** SHA-256 of canonical JSON — the one key derivation, used everywhere. */
export function generationKeyFromInputs(inputs: CaptionGenerationKeyInputs): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(inputs)).digest("hex")}`;
}

/** Canonical generation id: the first 24 hex chars of the key digest. */
export function generationIdFromKey(key: string): string {
  return key.slice("sha256:".length, "sha256:".length + 24);
}

export function computeGenerationKey(
  projectDir: string,
  input: GenerationKeyInputSpec,
): string {
  return generationKeyFromInputs(buildGenerationKeyInputs(projectDir, input));
}

export function buildGenerationKeyInputs(
  projectDir: string,
  input: GenerationKeyInputSpec,
): CaptionGenerationKeyInputs {
  // Source attestation is a mandatory key input: unavailable fails closed.
  const sourceInputsHash = createSourceInputAttestation(projectDir).source_inputs_hash;
  const suppliedPathCount = [
    input.suppliedFinalPath,
    input.suppliedFinalReceiptPath,
    input.suppliedFinalRouteReceiptPath,
  ].filter((candidate) => candidate !== undefined).length;
  if (suppliedPathCount !== 0 && suppliedPathCount !== 3) {
    throw new Error("supplied-final generation key inputs require final, input receipt, and route receipt together");
  }
  const hashSupplied = (candidate: string | undefined, label: string): string =>
    candidate === undefined ? "" : computeSha256(resolveProjectInputFile(projectDir, candidate, label));
  const suppliedFinalSha256 = hashSupplied(input.suppliedFinalPath, "supplied final");
  const suppliedFinalReceiptSha256 = hashSupplied(input.suppliedFinalReceiptPath, "supplied final receipt");
  const suppliedFinalRouteReceiptSha256 = hashSupplied(
    input.suppliedFinalRouteReceiptPath,
    "supplied final route receipt",
  );
  const musicPath = path.join(projectDir, "07_package", "music_cues.json");
  const musicSha256 = fs.existsSync(musicPath) ? computeSha256(musicPath) : "";
  // typography policy: ALWAYS the canonical project policy file (the CLI
  // path must be canonical or omitted — no implicit omission mismatch)
  const canonicalPolicy = path.join(projectDir, TYPOGRAPHY_POLICY_RELATIVE_PATH);
  const typographyPolicySha256 = fs.existsSync(canonicalPolicy) ? computeSha256(canonicalPolicy) : "";
  return {
    caption_finalize_contract: CAPTION_FINALIZE_CONTRACT_VERSION,
    approval: input.approvalSha256,
    timeline: input.timelineSha256,
    final_render_approval: input.finalRenderApprovalSha256 ?? "",
    font_primary: input.fontPrimarySha256,
    font_ass_bold: input.fontAssBoldSha256,
    font_ass_heavy: input.fontAssHeavySha256,
    font_selected_family: input.fontSelectedFamily,
    font_selected_role: input.fontSelectedRole,
    font_selected: input.fontSelectedSha256,
    typography_policy: typographyPolicySha256,
    visual_treatment_input: hashOrEmpty(path.join(projectDir, "04_plan", "visual-treatment-patch.json")),
    lyric_input: input.lyricInputDigest ?? "",
    lyric_face_identity: input.lyricFaceIdentity ?? "",
    lyric_request: input.lyricRequestSha256 ?? "",
    sourceInputsHash,
    suppliedFinalSha256,
    suppliedFinalReceiptSha256,
    suppliedFinalRouteReceiptSha256,
    musicSha256,
  };
}

// ── Lyric options canonicalization ───────────────────────────────────────

export interface CanonicalLyricOptions {
  reducedMotion: boolean;
  sections: unknown[];
  staccatoMaxHoldSec: number | null;
  staccatoMaxPerCharSec: number | null;
  tailSec: number | null;
  videoDurationSec: number | null;
  positioning?: LyricPositioning;
}

export interface LyricFaceIdentity {
  role: "verse" | "chorus" | "punk";
  family: string;
  postscript_name: string;
  face_index: number;
  font_sha256: string;
}

/** Stable identity for the exact face used by measurement and libass. */
export function canonicalLyricFaceIdentity(faces: readonly LyricFaceIdentity[]): string {
  const canonical = faces
    .map((face) => ({
      role: face.role,
      family: face.family,
      postscript_name: face.postscript_name,
      face_index: face.face_index,
      font_sha256: face.font_sha256,
    }))
    .sort((left, right) => left.role.localeCompare(right.role));
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(canonical)).digest("hex")}`;
}

export function canonicalLyricOptionsDigest(options: CanonicalLyricOptions): string {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(options)).digest("hex")}`;
}

/** Stable JSON for evidence comparisons and option digests. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The canonical pre-generation request artifact (options authority). */
export interface LyricRequestArtifact {
  version: "lyric-request/v1";
  mode: "present" | "absent";
  options: CanonicalLyricOptions;
}

export function buildLyricRequestArtifact(
  mode: "present" | "absent",
  options: CanonicalLyricOptions | undefined,
): LyricRequestArtifact {
  return {
    version: "lyric-request/v1",
    mode,
    options: mode === "present"
      ? (options ?? {
        reducedMotion: false,
        sections: [],
        staccatoMaxHoldSec: null,
        staccatoMaxPerCharSec: null,
        tailSec: null,
        videoDurationSec: null,
        positioning: "poster_boundary_cross",
      })
      : {
        reducedMotion: false,
        sections: [],
        staccatoMaxHoldSec: null,
        staccatoMaxPerCharSec: null,
        tailSec: null,
        videoDurationSec: null,
      },
  };
}

// ── Full current recomputation (strict boundary authority core) ──────────

export interface LyricContractShape {
  source_kind?: "lrc_script" | "authored_caption_approval";
  script_sha256?: string;
  options_digest?: string;
  authority?: {
    kind: "authored_caption_approval";
    approval_sha256: string;
    timeline_sha256: string;
    text_authority_sha256: string;
    timing_authority_sha256: string;
  };
  faces: Array<{ role: string; family: string; postscript_name: string; face_index: number; font_path: string; font_sha256: string }>;
}

export interface RecomputeContext {
  projectDir: string;
  generationDir: string;
  expectedProjectId: string;
  anchors: {
    approvalPath: string;
    timelinePath: string;
    finalRenderApprovalPath: string;
  };
  /** "present" | "absent" from the receipt discriminator. */
  lyricDeliveryMode: "present" | "absent";
  lyricContract?: LyricContractShape;
  /** Persisted inputs: comparison evidence only (must match exactly). */
  persistedInputs?: Record<string, string>;
  /** Persisted evidence for fields without a current canonical source. */
}

const KEY_INPUT_FIELDS: Array<keyof CaptionGenerationKeyInputs> = [
  "caption_finalize_contract", "approval", "timeline", "final_render_approval",
  "font_primary", "font_ass_bold", "font_ass_heavy", "font_selected_family",
  "font_selected_role", "font_selected", "typography_policy",
  "visual_treatment_input", "lyric_input", "lyric_face_identity", "lyric_request",
  "sourceInputsHash", "suppliedFinalSha256", "suppliedFinalReceiptSha256", "musicSha256",
  "suppliedFinalRouteReceiptSha256",
];

/**
 * Recompute the COMPLETE expected generation-key inputs from current
 * canonical sources. Every field is mandatory: the persisted evidence must
 * contain exactly the same key set and match every recomputed value.
 */
export interface RouteEvidence {
  route_kind: "engine_render" | "supplied_final" | "external_manual_nle";
  render_route_receipt_sha256: string;
}

/**
 * Recompute the generation's route evidence from the staged render-route
 * receipt bytes (OUTPUT route authority). Supplied-final claims without the
 * staged final video fail closed; staged finals without route evidence fail
 * closed; provenance-only routes fail closed.
 */
export function recomputeRouteEvidence(generationDir: string): RouteEvidence {
  const stagedFinal = path.join(generationDir, "staging", "direct-render.mp4");
  const stagedRoute = path.join(generationDir, "logs", "render-route.json");
  const stagedProvenance = path.join(generationDir, "staging", "supplied-final-provenance.json");
  let routeKind: RouteEvidence["route_kind"] = "engine_render";
  let renderRouteReceiptSha256 = "";
  if (fs.existsSync(stagedRoute)) {
    const route = parseJsonRejectDuplicateKeys<{ receipt_version?: unknown; route_evidence?: { route_kind?: string }; outputs?: { final_video?: { path?: unknown; sha256?: unknown } } }>(
      fs.readFileSync(stagedRoute, "utf8"),
      stagedRoute,
    );
    const routeSchema = validateAgainstSchema(route, "render-route-receipt.schema.json");
    if (!routeSchema.valid) {
      throw new Error(`staged render-route receipt is schema-invalid: ${routeSchema.errors.join("; ")}`);
    }
    if (route.receipt_version !== "render-route-receipt/v3" || !route.route_evidence) {
      throw new Error(`staged render-route receipt is not a v3 receipt: ${stagedRoute}`);
    }
    if (route.route_evidence.route_kind !== "canonical_engine_render"
      && route.route_evidence.route_kind !== "supplied_final"
      && route.route_evidence.route_kind !== "external_manual_nle") {
      throw new Error(`staged render-route receipt has an unsupported route kind: ${String(route.route_evidence.route_kind)}`);
    }
    const routeOutputHash = route.outputs?.final_video?.sha256;
    if (typeof routeOutputHash !== "string") {
      throw new Error(`staged render-route receipt does not bind a final video: ${stagedRoute}`);
    }
    if (route.route_evidence.route_kind === "canonical_engine_render") {
      if (fs.existsSync(stagedFinal) || fs.existsSync(stagedProvenance)) {
        throw new Error("canonical engine route cannot carry supplied-final staging artifacts");
      }
    }
    if (route.route_evidence?.route_kind === "supplied_final") {
      routeKind = "supplied_final";
      if (!fs.existsSync(stagedFinal)) {
        throw new Error(`route receipt claims supplied_final but the staged final video is missing: ${stagedFinal}`);
      }
      const inputReceipt = path.join(generationDir, "staging", "input-caption-receipt.json");
      if (!fs.existsSync(inputReceipt)) {
        throw new Error(`supplied-final mode requires the input caption-finalize receipt: ${inputReceipt}`);
      }
      renderRouteReceiptSha256 = computeSha256(stagedRoute);
      // route/video mismatch fails closed
      const boundVideoSha = route.outputs?.final_video?.sha256;
      const stagedSha = computeSha256(stagedFinal);
      if (boundVideoSha !== stagedSha) {
        throw new Error("route receipt does not bind the staged supplied final video");
      }
    } else if (route.route_evidence?.route_kind === "external_manual_nle") {
      // External NLE evidence is a distinct non-canonical route. Its output
      // hash is still checked when the referenced output is generation-local,
      // and the verified staged receipt is canonical route evidence even
      // though it is not a supplied-final video identity input.
      routeKind = "external_manual_nle";
      renderRouteReceiptSha256 = computeSha256(stagedRoute);
      const outputPath = route.outputs?.final_video?.path;
      if (typeof outputPath !== "string" || !outputPath) {
        throw new Error("external NLE route receipt does not name its final video");
      }
      const resolvedOutput = path.isAbsolute(outputPath)
        ? path.resolve(outputPath)
        : path.resolve(path.dirname(stagedRoute), outputPath);
      if (!fs.existsSync(resolvedOutput) || !fs.statSync(resolvedOutput).isFile()) {
        throw new Error("external NLE route receipt references a missing final video");
      }
      if (computeSha256(resolvedOutput) !== routeOutputHash) {
        throw new Error("external NLE route receipt does not bind its referenced output");
      }
    }
  } else if (fs.existsSync(stagedProvenance) && fs.existsSync(stagedFinal)) {
    // provenance-only route: the OUTPUT render-route receipt is REQUIRED
    throw new Error(`supplied-final provenance present but the output render-route receipt is missing: ${stagedRoute}`);
  } else if (fs.existsSync(stagedFinal)) {
    throw new Error(`staged final video present without supplied-final route evidence: ${stagedFinal}`);
  }
  return { route_kind: routeKind, render_route_receipt_sha256: renderRouteReceiptSha256 };
}

export function recomputeCurrentGenerationKeyInputs(context: RecomputeContext): { inputs: CaptionGenerationKeyInputs; routeEvidence: { route_kind: string; render_route_receipt_sha256: string } } {
  const { projectDir, generationDir, anchors, lyricDeliveryMode } = context;
  const hashOrEmpty = (filePath: string): string =>
    fs.existsSync(filePath) ? computeSha256(filePath) : "";

  // approval / final approval / timeline: current canonical bytes
  const approval = hashOrEmpty(anchors.approvalPath);
  if (!approval) throw new Error(`canonical caption approval missing: ${anchors.approvalPath}`);
  // the approval must identify THIS project (foreign copies fail even rehashed)
  const approvalDoc = parseJsonRejectDuplicateKeys<{ project_id?: unknown }>(
    fs.readFileSync(anchors.approvalPath, "utf8"),
    anchors.approvalPath,
  );
  const timeline = hashOrEmpty(anchors.timelinePath);
  if (!timeline) throw new Error(`canonical timeline missing: ${anchors.timelinePath}`);
  const finalRenderApproval = hashOrEmpty(anchors.finalRenderApprovalPath);

  // canonical lyric request: mandatory for BOTH modes (options authority)
  const requestPath = path.join(projectDir, LYRIC_REQUEST_RELATIVE_PATH);
  if (!fs.existsSync(requestPath)) {
    throw new Error(`canonical lyric request missing: ${requestPath}`);
  }
  const request = parseJsonRejectDuplicateKeys<LyricRequestArtifact>(
    fs.readFileSync(requestPath, "utf8"),
    requestPath,
  );
  if (request.version !== "lyric-request/v1" || (request.mode !== "present" && request.mode !== "absent")) {
    throw new Error(`canonical lyric request is malformed: ${requestPath}`);
  }
  if (request.mode !== lyricDeliveryMode) {
    throw new Error(
      `canonical lyric request mode ${request.mode} does not match the delivery mode ${lyricDeliveryMode}`,
    );
  }

  // Canonical lyric input: direct LRC bytes for the legacy script route, or
  // the current #41 approval/body/timing authority for authored delivery.
  let lyricInput = "";
  let lyricFaceIdentity = "";
  let expectedLyricAuthority: LyricContractShape["authority"] | undefined;
  if (lyricDeliveryMode === "present") {
    let sourceKind = context.lyricContract?.source_kind;
    if (!sourceKind) {
      const planPath = path.join(generationDir, "captions", "lyric-typography-plan.json");
      if (fs.existsSync(planPath)) {
        const stagedPlan = parseJsonRejectDuplicateKeys<{ authority?: { kind?: unknown } }>(
          fs.readFileSync(planPath, "utf8"),
          planPath,
        );
        sourceKind = stagedPlan.authority?.kind === "authored_caption_approval"
          ? "authored_caption_approval"
          : "lrc_script";
      } else {
        sourceKind = "lrc_script";
      }
    }
    if (sourceKind === "authored_caption_approval") {
      const approvalWithAuthority = parseJsonRejectDuplicateKeys<{
        caption_policy?: { source?: unknown };
        text_authority?: Parameters<typeof hashAuthoredTextAuthority>[0];
        timing_authority?: Parameters<typeof hashAuthoredTimingAuthority>[0];
      }>(fs.readFileSync(anchors.approvalPath, "utf8"), anchors.approvalPath);
      if (approvalWithAuthority.caption_policy?.source !== "authored"
        || !approvalWithAuthority.text_authority || !approvalWithAuthority.timing_authority) {
        throw new Error("current canonical approval lacks the authored lyric authorities");
      }
      const authority = context.lyricContract?.authority;
      const textAuthoritySha = hashAuthoredTextAuthority(approvalWithAuthority.text_authority);
      const timingAuthoritySha = hashAuthoredTimingAuthority(approvalWithAuthority.timing_authority);
      expectedLyricAuthority = {
        kind: "authored_caption_approval",
        approval_sha256: approval,
        timeline_sha256: timeline,
        text_authority_sha256: textAuthoritySha,
        timing_authority_sha256: timingAuthoritySha,
      };
      if (authority && (
        authority.kind !== "authored_caption_approval"
        || authority.approval_sha256 !== approval
        || authority.timeline_sha256 !== timeline
        || authority.text_authority_sha256 !== textAuthoritySha
        || authority.timing_authority_sha256 !== timingAuthoritySha
      )) {
        throw new Error("lyric contract authority does not match the current authored approval/timeline");
      }
      lyricInput = `sha256:${crypto.createHash("sha256").update(JSON.stringify({
        source_kind: sourceKind,
        approval,
        timeline,
        text_authority_sha256: textAuthoritySha,
        timing_authority_sha256: timingAuthoritySha,
        options_digest: canonicalLyricOptionsDigest(request.options),
      })).digest("hex")}`;
    } else {
      const canonicalScript = path.join(projectDir, LYRIC_SCRIPT_RELATIVE_PATH);
      if (!fs.existsSync(canonicalScript)) {
        throw new Error(`canonical lyric script missing: ${canonicalScript}`);
      }
      const canonicalSha = computeSha256(canonicalScript);
      const contractScript = context.lyricContract?.script_sha256;
      if (contractScript && contractScript !== canonicalSha) {
        throw new Error("lyric contract script hash does not match the canonical project lyric source");
      }
      lyricInput = `sha256:${crypto.createHash("sha256").update(JSON.stringify({
        source_kind: sourceKind,
        script_sha256: canonicalSha,
        options_digest: canonicalLyricOptionsDigest(request.options),
      })).digest("hex")}`;
    }
    // the receipt's options digest must match the canonical request options
    if (context.lyricContract?.options_digest) {
      const requestDigest = canonicalLyricOptionsDigest(request.options);
      if (requestDigest !== context.lyricContract.options_digest) {
        throw new Error("lyric contract options digest does not match the canonical request");
      }
    }
    lyricFaceIdentity = recomputeCurrentLyricFaceIdentity(
      generationDir,
      sourceKind === "authored_caption_approval"
        ? expectedLyricAuthority
        : undefined,
    );
  }

  // fonts: hash the STAGED binaries (actual bytes); manifest paths are
  // relative to the generation root
  const manifestPath = path.join(generationDir, "font-manifest.json");
  const manifest = parseJsonRejectDuplicateKeys<{
    selected_family?: string;
    selected_asset?: { role?: string; path?: string; sha256?: string };
    assets?: Array<{ role?: string; path?: string; sha256?: string }>;
  }>(fs.readFileSync(manifestPath, "utf8"), manifestPath);
  const manifestSchema = validateAgainstSchema(manifest, "font-staging-manifest.schema.json");
  if (!manifestSchema.valid) {
    throw new Error(`font staging manifest is schema-invalid: ${manifestSchema.errors.join("; ")}`);
  }
  const resolveStagedAsset = (assetPath: string, label: string): string => {
    if (path.isAbsolute(assetPath)) {
      throw new Error(`font manifest ${label} path must be relative to the generation`);
    }
    const absolute = path.resolve(generationDir, assetPath);
    const root = `${path.resolve(generationDir)}${path.sep}`;
    if (!absolute.startsWith(root)) {
      throw new Error(`font manifest ${label} path escaped the generation directory`);
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`font manifest ${label} path is missing: ${assetPath}`);
    }
    return absolute;
  };
  const hashStaged = (role: string): string => {
    const asset = manifest.assets?.find((a) => a.role === role);
    if (!asset?.path) throw new Error(`font manifest is missing the ${role} asset`);
    const absolute = resolveStagedAsset(asset.path, role);
    const actual = computeSha256(absolute);
    if (asset.sha256 && actual !== asset.sha256) {
      throw new Error(`staged font bytes differ from the font manifest for ${role}`);
    }
    return actual;
  };
  const fontPrimary = hashStaged("primary");
  const fontAssBold = hashStaged("ass_bold");
  const fontAssHeavy = hashStaged("ass_heavy");
  const selectedPath = manifest.selected_asset?.path;
  if (!selectedPath) throw new Error("font manifest is missing the selected asset");
  const fontSelected = computeSha256(resolveStagedAsset(selectedPath, "selected asset"));

  const musicPath = path.join(projectDir, "07_package", "music_cues.json");
  const musicSha256 = fs.existsSync(musicPath) ? computeSha256(musicPath) : "";

  // Source attestation is a mandatory key input: unavailable fails closed.
  const sourceInputsHash = createSourceInputAttestation(projectDir).source_inputs_hash;

  // supplied-final mode inputs: mode is read from the OUTPUT render-route
  // receipt's route_evidence.route_kind. The INPUT caption-finalize receipt
  // (proves caption staging) and the OUTPUT render-route receipt (proves the
  // exact supplied final video + route kind) are DISTINCT required artifacts.
  const routeEvidence = recomputeRouteEvidence(generationDir);
  const suppliedFinalSha256 = routeEvidence.route_kind === "supplied_final"
    ? computeSha256(path.join(generationDir, "staging", "direct-render.mp4"))
    : "";
  const suppliedFinalReceiptSha256 = routeEvidence.route_kind === "supplied_final"
    ? computeSha256(path.join(generationDir, "staging", "input-caption-receipt.json"))
    : "";

  const recomputed: CaptionGenerationKeyInputs = {
    caption_finalize_contract: CAPTION_FINALIZE_CONTRACT_VERSION,
    approval,
    timeline,
    final_render_approval: finalRenderApproval,
    font_primary: fontPrimary,
    font_ass_bold: fontAssBold,
    font_ass_heavy: fontAssHeavy,
    font_selected_family: manifest.selected_family ?? "",
    font_selected_role: manifest.selected_asset?.role ?? "",
    font_selected: fontSelected,
    typography_policy: hashOrEmpty(path.join(projectDir, TYPOGRAPHY_POLICY_RELATIVE_PATH)),
    visual_treatment_input: hashOrEmpty(path.join(projectDir, "04_plan", "visual-treatment-patch.json")),
    lyric_input: lyricInput,
    lyric_face_identity: lyricFaceIdentity,
    lyric_request: computeSha256(requestPath),
    sourceInputsHash,
    suppliedFinalSha256,
    suppliedFinalReceiptSha256,
    suppliedFinalRouteReceiptSha256: routeEvidence.route_kind === "supplied_final"
      ? routeEvidence.render_route_receipt_sha256
      : "",
    musicSha256,
  };

  // the approval must identify THIS project (foreign copies fail even
  // rehashed) — enforced BEFORE any return, so missing persistedInputs
  // never weakens validation
  if (approvalDoc.project_id !== context.expectedProjectId) {
    throw new Error(`canonical approval belongs to project ${String(approvalDoc.project_id)}, not ${context.expectedProjectId}`);
  }

  // Persisted inputs are comparison evidence: the field sets must be
  // IDENTICAL and every value must match the recomputation. Missing fields
  // (e.g. a stripped lyric_input) are rejections, never skipped. This
  // comparison runs LAST; every canonical check above already passed.
  const persisted = context.persistedInputs;
  if (!persisted) return { inputs: recomputed, routeEvidence };
  const persistedFields = Object.keys(persisted).sort();
  const expectedFields = KEY_INPUT_FIELDS.slice().sort() as string[];
  if (persistedFields.length !== expectedFields.length
    || persistedFields.some((field, index) => field !== expectedFields[index])) {
    throw new Error(
      `persisted generation key inputs do not cover the mandatory field set (got ${persistedFields.length}, expected ${expectedFields.length})`,
    );
  }
  for (const field of KEY_INPUT_FIELDS) {
    if (persisted[field] !== recomputed[field]) {
      throw new Error(
        `generation key input ${field} does not match the current canonical state (persisted=${persisted[field]}, recomputed=${recomputed[field]}, dir=${context.generationDir})`,
      );
    }
  }
  return { inputs: recomputed, routeEvidence };
}

function recomputeCurrentLyricFaceIdentity(
  generationDir: string,
  expectedAuthority?: LyricContractShape["authority"],
): string {
  const planPath = path.join(generationDir, "captions", "lyric-typography-plan.json");
  if (!fs.existsSync(planPath)) {
    throw new Error(`lyric typography plan is missing: ${planPath}`);
  }
  const plan = parseJsonRejectDuplicateKeys<{
    fonts?: Record<string, {
      resolved_family?: unknown;
      face_index?: unknown;
      postscript_name?: unknown;
      font_sha256?: unknown;
    }>;
    authority?: unknown;
    violations?: unknown[];
    cues?: Array<{ position?: { within_safe_zone?: unknown } }>;
  }>(fs.readFileSync(planPath, "utf8"), planPath);
  const planSchema = validateAgainstSchema(plan, "lyric-typography-plan.schema.json");
  if (!planSchema.valid) {
    throw new Error(`lyric typography plan is schema-invalid: ${planSchema.errors.join("; ")}`);
  }
  if (plan.violations && plan.violations.length > 0) {
    throw new Error(`lyric typography plan contains unresolved violations: ${planPath}`);
  }
  if (plan.cues?.some((cue) => cue.position?.within_safe_zone !== true)) {
    throw new Error(`lyric typography plan contains an unsafe cue position: ${planPath}`);
  }
  if (expectedAuthority && canonicalJson(plan.authority) !== canonicalJson(expectedAuthority)) {
    throw new Error(`lyric typography plan authority differs from the current authored approval: ${planPath}`);
  }
  const bindings = resolveLyricFontBindings();
  const fontsDir = path.join(generationDir, "fonts");
  const faces = (["verse", "chorus", "punk"] as const).map((role) => {
    const binding = bindings[role];
    if (!binding.font_path || binding.face_index === undefined || !binding.postscript_name || !binding.font_sha256) {
      throw new Error(`current lyric font binding is incomplete for role ${role}`);
    }
    const planned = plan.fonts?.[role];
    if (!planned
      || planned.resolved_family !== binding.family
      || planned.face_index !== binding.face_index
      || planned.postscript_name !== binding.postscript_name
      || planned.font_sha256 !== binding.font_sha256) {
      throw new Error(`lyric typography plan face identity differs from the current ${role} binding`);
    }
    if (!fs.existsSync(fontsDir)) {
      throw new Error(`lyric font staging directory is missing: ${fontsDir}`);
    }
    const candidates = fs.readdirSync(fontsDir)
      .filter((name) => name.startsWith(`lyrics-${role}.`));
    if (candidates.length !== 1) {
      throw new Error(`lyric font staging must contain exactly one ${role} face copy`);
    }
    const stagedPath = path.join(fontsDir, candidates[0]);
    if (computeSha256(stagedPath) !== binding.font_sha256) {
      throw new Error(`staged lyric font bytes differ from the current ${role} face`);
    }
    return {
      role,
      family: binding.family,
      postscript_name: binding.postscript_name,
      face_index: binding.face_index,
      font_sha256: binding.font_sha256,
    } satisfies LyricFaceIdentity;
  });
  return canonicalLyricFaceIdentity(faces);
}
