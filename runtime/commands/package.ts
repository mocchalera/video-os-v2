/**
 * /package Command
 *
 * Orchestrates the final packaging pipeline:
 * 1. Gate 10 check (source of truth decision)
 * 2. Caption projection + music cue projection
 * 3. Render pipeline (engine_render) or validation (nle_finishing)
 * 4. QA validation
 * 5. Package manifest generation
 * 6. State transition: approved → packaged, or refresh packaged outputs
 *
 * Allowed start states: approved, packaged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { materializeFileSync } from "../filesystem/materialize-file.js";
import { validateArtifact } from "../artifacts/loaders.js";
import { assertTimelineRenderSupported } from "../render/media-kind-guard.js";
import { parse as parseYaml } from "yaml";
import {
  initCommand,
  parseJsonRejectDuplicateKeys,
  transitionState,
  validateAgainstSchema,
  type CommandError,
} from "./shared.js";
import {
  writeProjectState,
  readProjectState,
  computeFileHash,
  snapshotArtifacts,
  type ProjectState,
} from "../state/reconcile.js";
import {
  checkGate10,
  type Gate10ReviewReport,
  type SourceOfTruth,
} from "../packaging/gate10.js";
import {
  loadProjectOptionalVlmCapability,
  readCurrentOptionalVlmGateContext,
  readOptionalVlmPolicy,
  type OptionalVlmPolicyArtifact,
  type OptionalVlmGateContext,
} from "../review/optional-vlm-policy.js";
import {
  buildQaReport,
  checkCaptionDensity,
  checkCaptionAlignment,
  checkAvDrift,
  checkLoudnessTargetForAudioPolicy,
  checkAudioMixPolicy,
  checkMusicMasterAudioPlan,
  checkAudioRenderPlanParity,
  checkSfxMixPolicy,
  checkPackageCompleteness,
  checkDialogueOccupancy,
  checkDialogueTimelineAlignment,
  checkResolutionSpec,
  checkDeterministicFinalOutput,
  checkDeterministicLayoutQA,
  checkFinalCaptionStructuralInvariants,
  getRequiredChecks,
  type ExpectedVideoFrameSpec,
  type ExpectedAudioDeliveryProfileRef,
  type QaReport,
  type QaCheckResult,
} from "../packaging/qa.js";
import { hasCaptionStylePreset } from "../../editor/shared/caption-style-tokens.js";
import { checkSocialRetentionFinishing, resolveCompilerRetentionPolicy } from "../packaging/social-retention-qa.js";
import {
  buildEngineRenderManifest,
  buildNleFinishingManifest,
  type PackageManifest,
} from "../packaging/manifest.js";
import { buildDerivedVideoProvenance } from "../packaging/derived-video-provenance.js";
import {
  buildQaMeasurementsFromPrecomputed,
  collectQaMeasurementWarnings,
  measureQaMedia,
  writeQaMeasurements,
  type PrecomputedQaMetrics,
  type QaMeasurements,
  type TimeWindowMs,
} from "../packaging/qa-measure.js";
import {
  deriveDeterministicAllowedRanges,
  type DeterministicEndingIntent,
  type DeterministicOutputQAAllowedRange,
  type DeterministicTimelineIntent,
} from "../review/deterministic-output-qa.js";
import {
  evaluateDeterministicLayoutQA,
  incompleteDeterministicLayoutQA,
  type DeterministicLayoutQAResult,
} from "../review/deterministic-layout-qa.js";
import { buildRenderLayoutSnapshot } from "../review/render-layout-snapshot.js";
import { evaluateSpeechCadenceQA } from "../review/speech-cadence-qa.js";
import type { AudioEventsArtifact } from "../artifacts/audio-events.js";
import { resolveSharedAudioRenderPlan } from "../audio/render-route.js";
import {
  type AudioRenderPlan,
} from "../audio/render-plan.js";
import {
  resolveSfxCuePlan,
  type SfxCuesDoc,
} from "../audio/sfx-cues.js";
import { evaluateCaptionDeliveryQA } from "../review/caption-delivery-qa.js";
import type { CaptionReviewPreview } from "../caption/review-core.js";
import { assembleTimelineToMp4 } from "../render/assembler.js";
import { runRenderPipeline } from "../render/pipeline.js";
import { timelineEmbeddedMusicAssetIds } from "../audio/timeline-music.js";
import { shouldPreserveOriginalAudioLevel } from "../audio/preservation.js";
import type { AssemblyEngine } from "../render/assembly-orchestrator.js";
import {
  resolveProjectRenderRoute,
  writeRenderRouteReceipt,
  type DeliveryVideoOperation,
  type RenderRouteDecision,
} from "../render/route-resolver.js";
import { HYPERFRAMES_RENDERER_VERSION } from "../content/hyperframes-renderer.js";
import { REMOTION_RENDERER_VERSION } from "../render/remotion/render-remotion.js";
import { loadSourceMap } from "../media/source-map.js";
import { readCreativeBriefAutonomyMode } from "../autonomy.js";
import { publishFinalVideo } from "../packaging/deliverable.js";
import {
  resolveDeliveryArtifactPathsStrict,
  deriveDeliveryIdentityAnchors,
  type DeliveryArtifactPaths,
} from "../packaging/active-delivery.js";
import { computeSha256 } from "../packaging/manifest.js";
import {
  generationIdFromKey,
  generationKeyFromInputs,
  recomputeCurrentGenerationKeyInputs,
  type CaptionGenerationKeyInputs,
} from "../caption/generation-identity.js";
import {
  getReleaseSafetyMode,
  isP4aReleaseSafetyEnabled,
  runReleaseSafetyPreflight,
  writeReleaseSafetyReport,
  type ReleaseSafetyReport,
} from "../artifacts/p4a-release-safety.js";
import { assessMusicAssetEligibility } from "../music/asset-eligibility.js";
import type { AudioMixReport } from "../audio/mixer.js";
import { timelineHasVisualClips } from "../review/visual-qa.js";
import {
  assessRenderArtifactFreshness,
  assertSourceInputsUnchanged,
  createSourceInputAttestation,
  writeRenderFreshnessMetadata,
  type RenderArtifactFreshness,
} from "../render/source-input-attestation.js";
import { inspectFinalRenderApproval } from "../packaging/final-render-approval.js";
import { assertNoLegacyClipCaptionsForPackage } from "../render/legacy-caption-guard.js";
import {
  assertCaptionFontContractReady,
  captionFontContractForReceipt,
} from "../caption/font-contract.js";
import type { CaptionApproval } from "../caption/approval.js";
import type { CaptionVisualTreatmentInput } from "../caption/visual-treatment.js";
import {
  resolveAndVerifyCanonicalCaptionVisualTreatmentInput,
  shouldPreflightCanonicalCaptionVisualTreatment,
} from "../render/canonical-render-input.js";

// ── Types ────────────────────────────────────────────────────────

export interface PackageCommandResult {
  success: boolean;
  error?: CommandError;
  qaReport?: QaReport;
  packageManifest?: PackageManifest;
  releaseSafetyReport?: ReleaseSafetyReport;
  deliverablePath?: string;
  sourceOfTruth?: SourceOfTruth;
  stateTransitioned?: boolean;
}

export interface PackageCommandOptions {
  /** Explicit repository-common SFX authority root. */
  repoSfxRoot?: string;
  /** Project identity resolved by the package preflight. Direct callers fall back to canonical artifacts. */
  projectId?: string;
  /** Pre-built assembly.mp4 path (skips Remotion) */
  assemblyPath?: string;
  /** Produce assembly through the selected engine instead of prebuilding with FFmpeg. */
  assemblyEngine?: AssemblyEngine;
  /** For nle_finishing: operator-provided final.mp4 */
  suppliedFinalPath?: string;
  /** Timestamp override for testing */
  createdAt?: string;
  /** Skip render pipeline (for validation-only/testing) */
  skipRender?: boolean;
  /** Precomputed metrics for testing (skips ffprobe/ffmpeg measurement) */
  precomputedMetrics?: PrecomputedQaMetrics;
}

/**
 * MODULE-PRIVATE stage options: internal authority/path/activation overrides are
 * unreachable from public callers — only this module's routes construct them, and
 * every value is re-derived from or validated against canonical authority.
 */
interface PackageStageInternalOptions extends PackageCommandOptions {
  /** Internal route metadata is fixed by the owning command wrapper. */
  commandName: string;
  actorName: string;
  allowedStates?: ProjectState[];
  /** Transaction-owned package root. Defaults to the legacy 07_package path. */
  deliveryOutputDir?: string;
  /** Explicit immutable approval intent used by a delivery transaction. */
  captionApprovalPath?: string;
  /** Versioned RFA-020 typography profile and optional human visual-treatment patch. */
  typographyPolicyPath?: string;
  visualTreatmentPatchPath?: string;
  /** Shared canonical RFA-020 input; prevents preview/package re-resolution drift. */
  captionVisualTreatmentInput?: CaptionVisualTreatmentInput;
  /** Render-pipeline evidence paths passed into the package manifest. */
  renderReportPath?: string;
  /** Optional supplied/external route receipt for an NLE finishing handoff. */
  renderRouteReceiptPath?: string;
  /** Keep project_state and 09_output untouched; the caller owns activation. */
  deferActivation?: boolean;
  /** Verified generation-local font directory for caption-finalize only. */
  captionFontsDir?: string;
  /** Canonical lyric ASS to burn (caption-finalize lyric deliveries). */
  /** Internal final-render approval gate used only by /render. */
  requireFinalRenderApproval?: boolean;
}

// ── Command ─────────────────────────────────────────────────────

const CAPTION_FINALIZE_ROOT_RELATIVE_PATH = "07_package/caption-finalize";


const PUBLIC_PACKAGE_OPTION_KEYS: ReadonlySet<string> = new Set([
  "repoSfxRoot", "projectId", "assemblyPath", "assemblyEngine",
  "suppliedFinalPath", "createdAt", "skipRender", "precomputedMetrics",
]);

const INTERNAL_PACKAGE_OPTION_KEYS: ReadonlySet<string> = new Set([
  "commandName", "actorName", "allowedStates", "requireFinalRenderApproval",
  "deliveryOutputDir", "captionApprovalPath",
  "typographyPolicyPath", "visualTreatmentPatchPath", "captionVisualTreatmentInput",
  "renderReportPath", "renderRouteReceiptPath", "deferActivation", "captionFontsDir",
  "lyricsAssPath", "sourceMap", "assemblyOutputPath", "bundleCacheDir",
  "musicCuesPath", "sfxCuesPath",
]);

/**
 * Runtime mirror of the exported options split: internal authority/path
 * fields (own OR inherited/prototype keys) and any unknown alias are
 * rejected BEFORE any read or side effect. Extra own properties that are
 * not part of the public contract are rejected so serialized/aliased
 * objects cannot smuggle authority.
 */
function assertPublicPackageOptions(
  options: PackageCommandOptions | undefined,
  route: string,
): void {
  if (options === undefined) return;
  const value = options as Record<PropertyKey, unknown>;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${route}: options prototype is not a public option; authority and artifact paths derive from the strict current authority`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error(`${route}: unknown option "${String(key)}" (aliases and internal overrides are rejected)`);
    }
    if (INTERNAL_PACKAGE_OPTION_KEYS.has(key)) {
      throw new Error(`${route}: options.${key} is not a public option; authority and artifact paths derive from the strict current authority`);
    }
    if (route === "caption-finalize" && key === "suppliedFinalPath") {
      throw new Error(`${route}: options.${key} is not a public option; the fresh staged route owns the final video`);
    }
    if (!PUBLIC_PACKAGE_OPTION_KEYS.has(key)) {
      throw new Error(`${route}: unknown option "${key}" (aliases and internal overrides are rejected)`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(`${route}: options.${key} must be a data property`);
    }
  }
}

/**
 * The strict current authority is the ONLY entry into packaging: every
 * public route (packageCommand, the finalize composite, preflight, CLI,
 * skipRender, deferActivation) resolves its delivery through
 * resolveDeliveryArtifactPathsStrict or, for the finalize composite, through
 * canonical recomputation of the fresh staged generation. No caller-supplied
 * paths, tokens, or internal arguments exist.
 */
async function runPackageStage(
  projectDir: string,
  options: PackageStageInternalOptions | undefined,
  resolvedDelivery: DeliveryArtifactPaths,
  renderLyricsAssPath: string | undefined,
): Promise<PackageCommandResult> {
  const allowedStates: ProjectState[] = options?.allowedStates ?? ["approved", "packaged"];
  const commandName = options?.commandName ?? "package";
  const actorName = options?.actorName ?? "package_command";
  const requestedProjectDir = path.resolve(projectDir);
  const deferActivation = options?.deferActivation === true;
  const requestedTimelinePath = path.join(requestedProjectDir, "05_timeline", "timeline.json");
  if (fs.existsSync(requestedTimelinePath)) {
    assertTimelineRenderSupported(JSON.parse(fs.readFileSync(requestedTimelinePath, "utf8")), {
      projectDir: requestedProjectDir,
      timelinePath: requestedTimelinePath,
    });
  }
  const ctx = deferActivation
    ? initDeferredPackageContext(requestedProjectDir, commandName, allowedStates)
    : initCommand(projectDir, commandName, allowedStates);
  if ("code" in ctx) {
    return { success: false, error: ctx };
  }

  const { projectDir: absDir, doc } = ctx;
  const timelinePath = path.join(absDir, "05_timeline", "timeline.json");
  const createdAt = options?.createdAt || new Date().toISOString();
  const autonomyMode = readCreativeBriefAutonomyMode(absDir);
  if (!autonomyMode) {
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: "creative_brief.yaml not found. Run /intent first.",
      },
    };
  }
  const creativeBrief = parseYaml(
    fs.readFileSync(path.join(absDir, "01_intent/creative_brief.yaml"), "utf-8"),
  );

  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
  const projectIdentity = resolvePackageCommandProjectId({
    preflight: options?.projectId,
    timeline: timeline.project_id,
    state: doc.project_id,
  });
  if ("error" in projectIdentity) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: projectIdentity.error,
      },
    };
  }
  // Legacy projects may have an empty state identity while a canonical
  // timeline is already present. Keep one resolved identity throughout QA,
  // manifest generation, and the eventual state transition.
  doc.project_id = projectIdentity.projectId;
  const baseTimelineRequiresAudio = (timeline.tracks?.audio ?? []).some((track: { clips?: unknown[] }) => (track.clips?.length ?? 0) > 0) ||
    typeof timeline.audio_mix?.bgm_asset_id === "string";
  const timelineAudioProfileRef = timeline.metadata?.audio_delivery_profile_ref
    ?? timeline.provenance?.audio_delivery_profile_ref;
  const expectedAudioProfileRef = timelineAudioProfileRef
    && typeof timelineAudioProfileRef === "object"
    && !Array.isArray(timelineAudioProfileRef)
    ? timelineAudioProfileRef as ExpectedAudioDeliveryProfileRef
    : typeof timelineAudioProfileRef === "string"
      ? timelineAudioProfileRef
      : undefined;
  const requiresAudioProfilePlan = Boolean(expectedAudioProfileRef);
  const currentTimelineVersion = timeline.version || "1";
  const embeddedMusicAssetIds = timelineEmbeddedMusicAssetIds(timeline);

  const blueprintPath = path.join(absDir, "04_plan/edit_blueprint.yaml");
  const blueprint = parseYaml(
    fs.readFileSync(blueprintPath, "utf-8"),
  ) as {
    caption_policy?: { language: string; delivery_mode: string; source: string; styling_class: string };
    ending_policy?: DeterministicEndingIntent;
  };

  // delivery paths are AUTHORITY-DERIVED: the stage root/caption approval
  // come from the resolved delivery (pointer generation, fresh staged
  // generation, or legacy layout) — never from caller options
  const packageDir = resolvedDelivery.source === "active_delivery" || resolvedDelivery.source === "fresh_staged"
    ? path.dirname(resolvedDelivery.packageManifestPath)
    : path.join(absDir, "07_package");
  const inputPackageDir = path.join(absDir, "07_package");
  const captionApprovalPath = resolvedDelivery.captionApprovalPath;
  const captionApproval = fs.existsSync(captionApprovalPath)
    ? JSON.parse(fs.readFileSync(captionApprovalPath, "utf-8"))
    : null;
  const musicCuesPath = path.join(inputPackageDir, "music_cues.json");
  const musicCues = fs.existsSync(musicCuesPath)
    ? JSON.parse(fs.readFileSync(musicCuesPath, "utf-8"))
    : null;
  const sfxCuesPath = path.join(inputPackageDir, "sfx_cues.json");
  const sfxCues = fs.existsSync(sfxCuesPath)
    ? JSON.parse(fs.readFileSync(sfxCuesPath, "utf-8")) as SfxCuesDoc
    : null;
  let canonicalAudioPlan: AudioRenderPlan | undefined;
  try {
    canonicalAudioPlan = resolveSharedAudioRenderPlan({
      projectDir: absDir,
      ...(options?.repoSfxRoot ? { repoSfxRoot: options.repoSfxRoot } : {}),
      timelinePath,
      musicCuesPath: fs.existsSync(musicCuesPath) ? musicCuesPath : undefined,
      sfxCuesPath: fs.existsSync(sfxCuesPath) ? sfxCuesPath : undefined,
    });
  } catch (error) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `Canonical audio render plan failed: ${String(error)}`,
      },
    };
  }
  const timelineRequiresAudio = baseTimelineRequiresAudio || Boolean(canonicalAudioPlan);
  const preserveOriginalAudioLevel = (
    shouldPreserveOriginalAudioLevel(timeline)
    || (canonicalAudioPlan?.strategy === "music_master"
      && canonicalAudioPlan.music_master?.audio_decision === "preserve")
  ) && embeddedMusicAssetIds.length === 0;
  const canonicalAudioPlanPath = canonicalAudioPlan
    ? path.join(packageDir, "audio-render-plan.json")
    : undefined;
  if (
    sfxCues
    && timeline.provenance?.audio_policy?.mode !== "original_only"
  ) {
    try {
      resolveSfxCuePlan({
        projectDir: absDir,
        ...(options?.repoSfxRoot ? { repoSfxRoot: options.repoSfxRoot } : {}),
        timeline,
        cuesPath: sfxCuesPath,
      });
    } catch (error) {
      return {
        success: false,
        error: {
          code: "GATE_CHECK_FAILED",
          message: `SFX contract failed: ${String(error)}`,
        },
      };
    }
  }
  const musicEligibility = assessMusicAssetEligibility(absDir, musicCues);
  if (!musicEligibility.eligible) {
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: musicEligibility.message ?? "BGM asset is not eligible for packaging.",
      },
    };
  }
  const reviewReportResult = readReviewReportForGate10(absDir);
  if (reviewReportResult.error) {
    return {
      success: false,
      error: reviewReportResult.error,
    };
  }
  const optionalVlmPolicyResult = readOptionalVlmPolicyForGate10(absDir);
  if (optionalVlmPolicyResult.error) {
    return {
      success: false,
      error: optionalVlmPolicyResult.error,
    };
  }

  // 1. Gate 10 check
  const gate10 = checkGate10(doc, {
    autonomyMode,
    decidedAt: createdAt,
    currentTimelineVersion,
    blueprint,
    captionApproval,
    musicCues,
    reviewReport: reviewReportResult.reviewReport,
    visualQaApplicable: timelineHasVisualClips(timelinePath),
    optionalVlmCapability: loadProjectOptionalVlmCapability(absDir).capability,
    optionalVlmPolicy: optionalVlmPolicyResult.policy,
    optionalVlmContext: optionalVlmPolicyResult.context,
  });
  if (!gate10.passed) {
    return {
      success: false,
      error: {
        code: "GATE_CHECK_FAILED",
        message: `Gate 10 failed: ${gate10.errors.join("; ")}`,
      },
    };
  }
  if (gate10.auto_defaulted_handoff && gate10.handoff_resolution) {
    console.log("[auto:full_autonomy] Gate 10 defaulted handoff_resolution to engine_render.");
    doc.handoff_resolution = gate10.handoff_resolution as typeof doc.handoff_resolution;
    if (!deferActivation) writeProjectState(absDir, doc);
  }

  const sourceOfTruth = gate10.source_of_truth!;
  if (options?.requireFinalRenderApproval === true) {
    const approval = inspectFinalRenderApproval(absDir, {
      captionApprovalPath,
    });
    if (!approval.ready) {
      return {
        success: false,
        sourceOfTruth,
        error: {
          code: "GATE_CHECK_FAILED",
          message: `Final render approval is ${approval.status}: ${approval.issues.join("; ")}`,
        },
      };
    }
  }
  let renderRouteDecision: RenderRouteDecision;
  try {
    // Route selection is a runtime authority decision.  Public callers may
    // request an assembly engine, but cannot inject the resolved route or
    // its provenance into the package stage.
    renderRouteDecision = resolveProjectRenderRoute(absDir, options?.assemblyEngine ?? "auto");
  } catch (err) {
    return {
      success: false,
      sourceOfTruth,
      error: {
        code: "VALIDATION_FAILED",
        message: `Render route resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  let deliverableSourceInputs: ReturnType<typeof createSourceInputAttestation>;
  try {
    deliverableSourceInputs = createSourceInputAttestation(absDir, {
      timelinePath,
      includeAudio: !canonicalAudioPlan,
    });
  } catch (err) {
    return {
      success: false,
      sourceOfTruth,
      error: {
        code: "VALIDATION_FAILED",
        message: `Source provenance preflight failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  fs.mkdirSync(path.join(packageDir, "video"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "audio"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "captions"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "logs"), { recursive: true });
  if (canonicalAudioPlan && canonicalAudioPlanPath) {
    fs.writeFileSync(
      canonicalAudioPlanPath,
      `${JSON.stringify(canonicalAudioPlan, null, 2)}\n`,
      "utf8",
    );
  }
  if (sourceOfTruth === "engine_render" && !timelineRequiresAudio) {
    for (const staleAudioArtifact of [
      path.join(packageDir, "audio/raw_dialogue.wav"),
      path.join(packageDir, "audio/final_mix.wav"),
      path.join(packageDir, "logs/audio-mix-report.json"),
    ]) {
      fs.rmSync(staleAudioArtifact, { force: true });
    }
  }

  let releaseSafetyReport: ReleaseSafetyReport | undefined;
  if (isP4aReleaseSafetyEnabled()) {
    try {
      const releaseSafetyResult = runReleaseSafetyPreflight({
        projectDir: absDir,
        producer: commandName === "/render" ? "/render" : "/package",
        mode: getReleaseSafetyMode(),
        createdAt,
        sourceOfTruth,
      });
      releaseSafetyReport = releaseSafetyResult.report;
      if (!deferActivation) writeReleaseSafetyReport(absDir, releaseSafetyReport);
    } catch (err) {
      return {
        success: false,
        sourceOfTruth,
        error: {
          code: "VALIDATION_FAILED",
          message: `Release safety preflight failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  // 2. Read timeline and caption_policy
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  const frameDurationMs = 1000 / fps;
  // The approved caption artifact is the finishing source of truth. Operators
  // may refine the concrete style after the blueprint is compiled; rendering
  // the older blueprint alias can silently fall back to the default font and
  // discard speaker separation even though every approved cue names the final
  // preset.
  const authoredCaptionPolicy = captionApproval?.caption_policy ||
    blueprint.caption_policy || {
    language: "ja",
    delivery_mode: "both",
    source: "none",
    styling_class: "clean-lower-third",
  };
  const captionPolicy = !captionApproval && authoredCaptionPolicy.source !== "none"
    ? { ...authoredCaptionPolicy, source: "none" }
    : authoredCaptionPolicy;
  if (sourceOfTruth === "engine_render") {
    try {
      assertNoLegacyClipCaptionsForPackage(timeline);
      if (captionPolicy.source !== "none") {
        assertCaptionFontContractReady(captionPolicy.styling_class);
      }
    } catch (error) {
      return {
        success: false,
        sourceOfTruth,
        error: {
          code: "VALIDATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // 5. Build QA checks
  const checks: QaCheckResult[] = [];
  const metrics: QaReport["metrics"] = {};
  const audioEventsPath = path.join(absDir, "03_analysis", "audio_events.json");
  let audioEvents: AudioEventsArtifact | undefined;
  if (fs.existsSync(audioEventsPath)) {
    try {
      audioEvents = JSON.parse(
        fs.readFileSync(audioEventsPath, "utf8"),
      ) as AudioEventsArtifact;
    } catch {
      // The cadence projection reports missing/unreadable evidence as
      // incomplete. It remains review-only until genre false-positive
      // benchmarks justify promotion to a hard package gate.
    }
  }
  metrics.speech_cadence_qa = evaluateSpeechCadenceQA({
    timeline,
    brief: creativeBrief,
    audioEvents,
  });
  const captionReviewPreviewPaths = [
    path.join(path.dirname(captionApprovalPath), "caption_review_preview.json"),
    path.join(inputPackageDir, "caption_review_preview.json"),
  ];
  let captionReviewPreview: CaptionReviewPreview | undefined;
  for (const candidate of [...new Set(captionReviewPreviewPaths)]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      captionReviewPreview = JSON.parse(
        fs.readFileSync(candidate, "utf8"),
      ) as CaptionReviewPreview;
      break;
    } catch {
      // Caption delivery QA remains incomplete rather than trusting malformed
      // timing evidence. It is advisory and does not recreate approval policy.
    }
  }
  metrics.caption_delivery_qa = evaluateCaptionDeliveryQA({
    timeline,
    brief: creativeBrief,
    approval: captionApproval as CaptionApproval | undefined,
    reviewPreview: captionReviewPreview,
  });
  let qaMeasurementVideoPath: string | undefined;
  let qaMeasurementAudioPath: string | undefined;
  let qaMeasurementDialoguePath: string | undefined;
  let qaMeasurementAssemblyPath: string | undefined = options?.assemblyPath;
  let finalVideoSourcePath: string | undefined;
  const defaultAssemblyPath = deferActivation
    ? path.join(packageDir, "staging", "assembly.mp4")
    : path.join(absDir, "05_timeline/assembly.mp4");
  if (!options?.assemblyEngine && !qaMeasurementAssemblyPath && fs.existsSync(defaultAssemblyPath)) {
    qaMeasurementAssemblyPath = defaultAssemblyPath;
  }
  let completenessCheck: QaCheckResult | undefined;
  let audioMixReportPath = path.join(packageDir, "logs/audio-mix-report.json");
  let finalAudioMixReport: AudioMixReport | null = null;
  let assemblyFreshness: RenderArtifactFreshness | undefined;
  let renderRouteReceiptPath: string | undefined;
  let renderReportPath: string | undefined;
  let resolvedCaptionVisualTreatmentInput: CaptionVisualTreatmentInput | undefined = options?.captionVisualTreatmentInput;

  // timeline_schema_valid
  const timelineValidation = validateAgainstSchema(timeline, "timeline-ir.schema.json");
  checks.push({
    name: "timeline_schema_valid",
    passed: timelineValidation.valid,
    details: timelineValidation.valid
      ? "timeline-ir.schema.json validation passed"
      : timelineValidation.errors.join("; "),
  });
  const visualTreatmentArtifactsPresent = shouldPreflightCanonicalCaptionVisualTreatment(absDir, {
    typographyPolicyPath: options?.typographyPolicyPath,
    visualTreatmentPatchPath: options?.visualTreatmentPatchPath,
    approval: captionApproval?.approval,
  });
  if (renderRouteDecision.genre === "social_talking_head") {
    try {
      const compilerRetentionPolicy = resolveCompilerRetentionPolicy(absDir, timeline);
      checks.push(...checkSocialRetentionFinishing(timeline, creativeBrief, compilerRetentionPolicy));
    } catch (error) {
      checks.push({
        name: "social_retention_policy_provenance",
        passed: false,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (visualTreatmentArtifactsPresent || options?.captionVisualTreatmentInput) {
    try {
      resolvedCaptionVisualTreatmentInput = resolveAndVerifyCanonicalCaptionVisualTreatmentInput(absDir, {
        approvalPath: captionApprovalPath,
        typographyPolicyPath: options?.typographyPolicyPath ?? "04_plan/typography_policy.json",
        visualTreatmentPatchPath: options?.visualTreatmentPatchPath,
        providedInput: options?.captionVisualTreatmentInput,
      });
      checks.push({
        name: "canonical_caption_visual_treatment_input_valid",
        passed: resolvedCaptionVisualTreatmentInput.status !== "blocked" && resolvedCaptionVisualTreatmentInput.status !== "human_hold",
        details: `visual-treatment input=${resolvedCaptionVisualTreatmentInput.input_hash} approval=${resolvedCaptionVisualTreatmentInput.approval_hash} profile=${resolvedCaptionVisualTreatmentInput.typography_policy_hash} patch=${resolvedCaptionVisualTreatmentInput.visual_treatment_patch_hash ?? "missing"} status=${resolvedCaptionVisualTreatmentInput.status}`,
      });
    } catch (error) {
      checks.push({
        name: "canonical_caption_visual_treatment_input_valid",
        passed: false,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // caption_policy_valid
  const socialCaptionStyleValid = renderRouteDecision.genre !== "social_talking_head"
    || captionPolicy.source === "none"
    || hasCaptionStylePreset(captionPolicy.styling_class);
  const policyValid =
    ["transcript", "authored", "none"].includes(captionPolicy.source) &&
    (captionPolicy.source === "none" ||
      ["burn_in", "sidecar", "both"].includes(captionPolicy.delivery_mode)) &&
    socialCaptionStyleValid;
  checks.push({
    name: "caption_policy_valid",
    passed: policyValid,
    details: policyValid
      ? `source=${captionPolicy.source} delivery_mode=${captionPolicy.delivery_mode}`
      : socialCaptionStyleValid
        ? `field=caption_policy reason=invalid_combination`
        : `field=caption_policy.styling_class reason=unknown_social_style value=${captionPolicy.styling_class}`,
  });

  // Profile-specific checks
  if (sourceOfTruth === "engine_render") {
    // Caption density
    if (captionApproval && captionPolicy.source !== "none") {
      const densityCheck = checkCaptionDensity(
        captionApproval.speech_captions || [],
        fps,
        captionPolicy.language,
        captionPolicy.styling_class,
        { humanApproved: captionApproval.approval?.status === "approved" },
      );
      checks.push(densityCheck);
      metrics.caption_max_density = parseDensityFromDetails(densityCheck.details);
      checks.push(checkFinalCaptionStructuralInvariants(
        captionApproval.speech_captions || [],
        fps,
        captionPolicy.language,
      ));

      const alignCheck = checkCaptionAlignment(
        captionApproval.speech_captions || [],
      );
      checks.push(alignCheck);
    }

    const existingArtifacts = new Set<string>();
    if (options?.skipRender) {
      if (qaMeasurementAssemblyPath && fs.existsSync(qaMeasurementAssemblyPath)) {
        assemblyFreshness = assessRenderArtifactFreshness(absDir, qaMeasurementAssemblyPath);
        if (assemblyFreshness.status !== "fresh") {
          return {
            success: false,
            sourceOfTruth,
            error: {
              code: "VALIDATION_FAILED",
              message: `Assembly is not fresh: ${assemblyFreshness.reason ?? assemblyFreshness.status}`,
            },
          };
        }
      }
      // For testing: create visual stubs only. An independent music_master
      // source must never be replaced by a fictional v1/dialogue receipt.
      const isMusicMasterPackage = canonicalAudioPlan?.strategy === "music_master";
      const stubs = [
        path.join(packageDir, "video/final.mp4"),
        path.join(packageDir, "video/raw_video.mp4"),
        ...(timelineRequiresAudio && !isMusicMasterPackage ? [
          path.join(packageDir, "audio/raw_dialogue.wav"),
          path.join(packageDir, "audio/final_mix.wav"),
        ] : []),
      ];
      for (const stub of stubs) {
        if (!fs.existsSync(stub)) {
          fs.writeFileSync(stub, "stub", "utf-8");
        }
      }
      let fontReceiptPath: string | undefined;
      if (captionPolicy.source !== "none") {
        const fontContract = captionFontContractForReceipt(captionPolicy.styling_class);
        fontReceiptPath = path.join(packageDir, "logs", "caption-font-receipt.json");
        const stagedManifestPath = resolvedDelivery.captionFontsDir
          ? path.join(resolvedDelivery.captionFontsDir, "font-manifest.json")
          : undefined;
        fs.writeFileSync(fontReceiptPath, `${JSON.stringify({
          version: "caption-font-receipt/v1",
          styling_class: captionPolicy.styling_class,
          contract: fontContract,
          ...(stagedManifestPath && fs.existsSync(stagedManifestPath)
            ? {
                staged_font_manifest: {
                  path: path.resolve(stagedManifestPath),
                  sha256: `sha256:${createHash("sha256").update(fs.readFileSync(stagedManifestPath)).digest("hex")}`,
                },
              }
            : {}),
        }, null, 2)}\n`, "utf8");
      }
      const operations: DeliveryVideoOperation[] = [
        { id: "base_assembly", kind: "lossy_video_generation", codec: "h264" },
        ...(renderRouteDecision.delivery.lossy_video_encode_passes > 1
          ? [{
              id: "final_visual_composite",
              kind: "lossy_video_generation" as const,
              codec: "h264",
            }]
          : []),
        { id: "final_video_materialize", kind: "stream_copy", codec: "h264" },
      ];
      renderRouteReceiptPath = writeRenderRouteReceipt(packageDir, renderRouteDecision, {
        baseAssemblyPath: qaMeasurementAssemblyPath ?? path.join(packageDir, "video/final.mp4"),
        effectiveAssemblyPath: path.join(packageDir, "video/final.mp4"),
        timelinePath,
        captionApprovalPath: fs.existsSync(captionApprovalPath)
          ? captionApprovalPath
          : undefined,
        finalVideoPath: path.join(packageDir, "video/final.mp4"),
        fontReceiptPath,
        operations,
        sourceInputs: deliverableSourceInputs,
        ...(canonicalAudioPlan ? { audioRenderPlan: canonicalAudioPlan } : {}),
        ...(canonicalAudioPlanPath ? { audioRenderPlanPath: canonicalAudioPlanPath } : {}),
        ...(fs.existsSync(audioMixReportPath) ? { audioMixReportPath } : {}),
        ...(resolvedCaptionVisualTreatmentInput ? {
          captionVisualTreatment: {
            inputPath: path.join(packageDir, "caption_visual_treatment_input.json"),
            input: resolvedCaptionVisualTreatmentInput,
          },
        } : {}),
        measurementSource: "execution_plan",
        rendererVersions: {
          ...(renderRouteDecision.visual_layers.some((layer) => layer.renderer === "hyperframes")
            ? { hyperframes: HYPERFRAMES_RENDERER_VERSION }
            : {}),
          ...(renderRouteDecision.base_engine === "remotion"
            || renderRouteDecision.visual_layers.some((layer) => layer.renderer === "remotion")
            ? { remotion: REMOTION_RENDERER_VERSION }
            : {}),
        },
      });
      existingArtifacts.add("final_video");
      existingArtifacts.add("raw_video");
      if (timelineRequiresAudio) {
        existingArtifacts.add("raw_dialogue");
        existingArtifacts.add("final_mix");
      }
      existingArtifacts.add("qa_report");
      if (isMusicMasterPackage) {
        const musicMaster = canonicalAudioPlan!.music_master!;
        const sourcePath = path.resolve(absDir, musicMaster.source.source_ref);
        const rawDialoguePath = path.join(packageDir, "audio/raw_dialogue.wav");
        const finalMixPath = path.join(packageDir, "audio/final_mix.wav");
        const masteredMp3Path = path.join(packageDir, "audio/music_master_320.mp3");
        if (!fs.existsSync(rawDialoguePath) && musicMaster.audio_decision === "preserve") {
          fs.copyFileSync(sourcePath, rawDialoguePath);
        }
        if (!fs.existsSync(finalMixPath) && musicMaster.audio_decision === "preserve") {
          fs.copyFileSync(sourcePath, finalMixPath);
        }
        if (!fs.existsSync(rawDialoguePath) || !fs.existsSync(finalMixPath)
          || !fs.existsSync(audioMixReportPath)
          || (musicMaster.audio_decision === "mastering" && !fs.existsSync(masteredMp3Path))) {
          return {
            success: false,
            sourceOfTruth,
            error: {
              code: "VALIDATION_FAILED",
              message: "music_master skipRender requires existing plan-bound audio output and receipt; no stub fallback is allowed",
            },
          };
        }
        existingArtifacts.add("raw_dialogue");
        existingArtifacts.add("final_mix");
        existingArtifacts.add("audio_mix_report");
        if (musicMaster.audio_decision === "mastering") existingArtifacts.add("mastered_mp3");
      } else {
      const stubMixReport: AudioMixReport = preserveOriginalAudioLevel
        ? {
            version: "audio-mix-report/v1",
            has_bgm: false,
            strategy: "original_passthrough_v1",
            final_mastering: {
              applied: false,
              loudness_target_lufs: -16,
              lra_target: 7,
              true_peak_target_dbtp: -1.5,
              premaster_measurement: stubLoudnormMeasurement(),
            },
          }
        : embeddedMusicAssetIds.length > 0
        ? {
            version: "audio-mix-report/v1",
            has_bgm: true,
            strategy: "timeline_embedded_bgm_mastering_v1",
            bgm_ownership: {
              owner: "timeline_assembler",
              asset_ids: embeddedMusicAssetIds,
            },
            final_mastering: {
              loudness_target_lufs: -16,
              lra_target: 7,
              true_peak_target_dbtp: -1.5,
              premaster_measurement: stubLoudnormMeasurement(),
            },
          }
        : musicCues
        ? {
            version: "audio-mix-report/v1",
            has_bgm: true,
            strategy: "waveform_sidechain_v1",
            final_mastering: {
              loudness_target_lufs: -16,
              lra_target: 7,
              true_peak_target_dbtp: -1.5,
              premaster_measurement: stubLoudnormMeasurement(),
            },
            bgm_reference_mastering: {
              loudness_target_lufs: -23,
              lra_target: 7,
              true_peak_target_dbtp: -2,
              source_measurement: stubLoudnormMeasurement(),
            },
            sidechain: {
              detector: "dialogue_waveform_rms",
              threshold: 0.03,
              ratio: 13,
              attack_ms: 80,
              release_ms: 180,
              base_gain_db: -16,
              requested_duck_gain_db: -24,
            },
          }
        : {
            version: "audio-mix-report/v1",
            has_bgm: false,
            strategy: "dialogue_only_mastering_v1",
            final_mastering: {
              loudness_target_lufs: -16,
              lra_target: 7,
              true_peak_target_dbtp: -1.5,
              premaster_measurement: stubLoudnormMeasurement(),
            },
          };
      if (timelineRequiresAudio) {
        fs.writeFileSync(audioMixReportPath, `${JSON.stringify(stubMixReport, null, 2)}\n`, "utf-8");
        existingArtifacts.add("audio_mix_report");
      }
      }
      if (captionPolicy.source !== "none" &&
          (captionPolicy.delivery_mode === "sidecar" || captionPolicy.delivery_mode === "both")) {
        existingArtifacts.add("srt_sidecar");
        existingArtifacts.add("vtt_sidecar");
      }
    } else {
      // Run the actual render pipeline
      let assemblyPath = options?.assemblyPath;
      const renderCaptionApprovalPath = fs.existsSync(captionApprovalPath)
        ? captionApprovalPath
        : undefined;
      const renderMusicCuesPath = fs.existsSync(musicCuesPath)
        ? musicCuesPath
        : undefined;
      const renderSfxCuesPath = fs.existsSync(sfxCuesPath)
        ? sfxCuesPath
        : undefined;

      try {
        const assemblyEngine = options?.assemblyEngine ?? renderRouteDecision.assembly_engine;
        const sharedAudioPlan = canonicalAudioPlan ?? resolveSharedAudioRenderPlan({
          projectDir: absDir,
          ...(options?.repoSfxRoot ? { repoSfxRoot: options.repoSfxRoot } : {}),
          timelinePath,
          musicCuesPath: renderMusicCuesPath,
          sfxCuesPath: renderSfxCuesPath,
        });
        const sourceInputsBefore = createSourceInputAttestation(absDir, {
          timelinePath,
          includeAudio: !sharedAudioPlan,
        });
        if (!assemblyPath && assemblyEngine === "ffmpeg") {
          const existingFreshness = assessRenderArtifactFreshness(absDir, defaultAssemblyPath);
          if (existingFreshness.status === "fresh") {
            assemblyPath = defaultAssemblyPath;
          } else {
            await assembleTimelineToMp4({
              projectDir: absDir,
              timelinePath,
              outputPath: defaultAssemblyPath,
              includeAudio: !sharedAudioPlan,
              legacyCaptionMode: "reject",
            });
            writeRenderFreshnessMetadata(absDir, defaultAssemblyPath, { sourceInputsBefore, createdAt });
            assemblyPath = defaultAssemblyPath;
          }
        }
        if (assemblyPath) {
          const suppliedFreshness = assessRenderArtifactFreshness(absDir, assemblyPath);
          if (suppliedFreshness.status !== "fresh") {
            throw new Error(
              `Assembly is not fresh: ${suppliedFreshness.reason ?? suppliedFreshness.status}`,
            );
          }
        }
        const sourceMap = !assemblyPath
          ? Object.fromEntries(loadSourceMap(absDir).locatorMap)
          : undefined;
        const renderResult = await runRenderPipeline({
          projectDir: absDir,
          timelinePath,
          captionApprovalPath: renderCaptionApprovalPath,
          ...(resolvedCaptionVisualTreatmentInput ? {
            ...(visualTreatmentArtifactsPresent ? {
              typographyPolicyPath: options?.typographyPolicyPath ?? "04_plan/typography_policy.json",
              visualTreatmentPatchPath: options?.visualTreatmentPatchPath,
            } : {}),
            captionVisualTreatmentInput: resolvedCaptionVisualTreatmentInput,
          } : {}),
          musicCuesPath: renderMusicCuesPath,
          sfxCuesPath: renderSfxCuesPath,
          audioRenderPlan: sharedAudioPlan,
          ...(canonicalAudioPlanPath ? { audioRenderPlanPath: canonicalAudioPlanPath } : {}),
          assemblyPath,
          ...(!assemblyPath ? {
            assemblyEngine,
            sourceMap,
            assemblyOutputPath: defaultAssemblyPath,
          } : {}),
          renderRouteDecision,
          captionPolicy: captionPolicy as {
            language: string;
            delivery_mode: "burn_in" | "sidecar" | "both";
            source: "transcript" | "authored" | "none";
            styling_class: string;
          },
          outputDir: packageDir,
          fps,
          captionFontsDir: resolvedDelivery.captionFontsDir,
          lyricsAssPath: renderLyricsAssPath,
        });
        const freshnessArtifactPath = renderRouteDecision.hyperframes_overlay
          ? renderResult.baseAssemblyPath
          : renderResult.assemblyPath;
        if (!options?.assemblyPath) {
          writeRenderFreshnessMetadata(absDir, freshnessArtifactPath, {
            sourceInputsBefore,
            createdAt,
          });
        } else {
          assertSourceInputsUnchanged(
            sourceInputsBefore,
            createSourceInputAttestation(absDir, {
              timelinePath,
              includeAudio: !sharedAudioPlan,
            }),
          );
        }
        assemblyFreshness = assessRenderArtifactFreshness(absDir, freshnessArtifactPath);
        if (assemblyFreshness.status !== "fresh") {
          throw new Error(
            `Rendered assembly is not fresh: ${assemblyFreshness.reason ?? assemblyFreshness.status}`,
          );
        }
        qaMeasurementAssemblyPath = renderResult.assemblyPath;
        qaMeasurementVideoPath = renderResult.finalVideoPath;
        finalVideoSourcePath = renderResult.finalVideoPath;
        qaMeasurementAudioPath = renderResult.finalMixPath;
        qaMeasurementDialoguePath = renderResult.rawDialoguePath;
        audioMixReportPath = renderResult.audioMixReportPath;
        renderRouteReceiptPath = renderResult.renderRouteReceiptPath;
        renderReportPath = renderResult.renderReportPath;

        // Check which artifacts the render produced
        if (fs.existsSync(renderResult.finalVideoPath)) existingArtifacts.add("final_video");
        if (fs.existsSync(renderResult.rawVideoPath)) existingArtifacts.add("raw_video");
        if (fs.existsSync(renderResult.rawDialoguePath)) existingArtifacts.add("raw_dialogue");
        if (fs.existsSync(renderResult.finalMixPath)) existingArtifacts.add("final_mix");
        if (fs.existsSync(renderResult.audioMixReportPath)) {
          existingArtifacts.add("audio_mix_report");
        }
        if (canonicalAudioPlan?.strategy === "music_master"
          && canonicalAudioPlan.music_master?.audio_decision === "mastering"
          && fs.existsSync(path.join(packageDir, "audio", "music_master_320.mp3"))) {
          existingArtifacts.add("mastered_mp3");
        }
        for (const sp of renderResult.sidecarPaths) {
          if (sp.endsWith(".srt")) existingArtifacts.add("srt_sidecar");
          if (sp.endsWith(".vtt")) existingArtifacts.add("vtt_sidecar");
        }
      } catch (err) {
        return {
          success: false,
          error: {
            code: "VALIDATION_FAILED",
            message: `Render pipeline failed: ${String(err)}`,
          },
          sourceOfTruth,
        };
      }
      existingArtifacts.add("qa_report"); // Will be generated below
    }
    finalAudioMixReport = readAudioMixReport(audioMixReportPath);
    if (canonicalAudioPlan?.strategy === "music_master") {
      checks.push(checkMusicMasterAudioPlan(
        canonicalAudioPlan,
        finalAudioMixReport,
        {
          finalMixPath: path.join(packageDir, "audio", "final_mix.wav"),
          masteredMp3Path: path.join(packageDir, "audio", "music_master_320.mp3"),
          finalVideoPath: path.join(packageDir, "video", "final.mp4"),
          projectDir: absDir,
        },
      ));
    }
    const requiresSharedAudioPlan = (
      musicCues?.version === "2.0.0"
      || sfxCues?.version === "sfx-cues/v1"
      || requiresAudioProfilePlan
      || canonicalAudioPlan?.strategy === "music_master"
    )
      && timeline.provenance?.audio_policy?.mode !== "original_only";
    const requiresSharedAudioCuePlan = (
      musicCues?.version === "2.0.0"
      || sfxCues?.version === "sfx-cues/v1"
    ) && timeline.provenance?.audio_policy?.mode !== "original_only";
    checks.push(timelineRequiresAudio
      ? checkAudioMixPolicy(
          finalAudioMixReport,
          Boolean(musicCues) || embeddedMusicAssetIds.length > 0,
          renderRouteDecision.genre === "social_talking_head",
          musicCues,
          sfxCues,
          expectedAudioProfileRef,
          absDir,
        )
      : { name: "audio_mix_policy_valid", passed: true, details: "not_applicable: timeline has no audio or BGM" });
    checks.push(checkAudioRenderPlanParity(
      finalAudioMixReport,
      readAudioMixReport(path.join(
        absDir,
        "09_output",
        "social-review-work",
        "audio",
        "audio-mix-report.json",
      )),
      requiresSharedAudioCuePlan,
    ));
    if (sfxCues?.required === true) {
      checks.push(checkSfxMixPolicy(finalAudioMixReport, sfxCues));
    }
    completenessCheck = checkPackageCompleteness(
      sourceOfTruth,
      captionPolicy,
      existingArtifacts,
      timelineRequiresAudio,
      canonicalAudioPlan?.strategy === "music_master"
        && canonicalAudioPlan.music_master?.audio_decision === "mastering",
    );
    if (!qaMeasurementVideoPath) {
      qaMeasurementVideoPath = path.join(packageDir, "video/final.mp4");
    }
    if (!finalVideoSourcePath) {
      finalVideoSourcePath = qaMeasurementVideoPath;
    }
    if (timelineRequiresAudio && !qaMeasurementAudioPath) {
      qaMeasurementAudioPath = path.join(packageDir, "audio/final_mix.wav");
    }
    if (timelineRequiresAudio && !qaMeasurementDialoguePath) {
      qaMeasurementDialoguePath = path.join(packageDir, "audio/raw_dialogue.wav");
    }
  } else {
    // nle_finishing checks
    // supplied_export_probe_valid (simplified)
    renderRouteReceiptPath = resolvedDelivery.renderRouteReceiptPath
      ?? (fs.existsSync(path.join(packageDir, "logs/render-route.json"))
        ? path.join(packageDir, "logs/render-route.json")
        : undefined);
    qaMeasurementVideoPath = options?.suppliedFinalPath ||
      path.join(packageDir, "video/final.mp4");
    finalVideoSourcePath = qaMeasurementVideoPath;
    const suppliedExists = options?.suppliedFinalPath
      ? fs.existsSync(options.suppliedFinalPath)
      : fs.existsSync(path.join(packageDir, "video/final.mp4"));
    checks.push({
      name: "supplied_export_probe_valid",
      passed: suppliedExists,
      details: suppliedExists
        ? "probe_field=container value=mp4"
        : "probe_field=existence value=missing",
    });

    // caption_delivery_valid
    const captionDeliveryOk =
      captionPolicy.source === "none" ||
      captionPolicy.delivery_mode === "burn_in" ||
      fs.existsSync(path.join(packageDir, "captions/speech.vtt"));
    checks.push({
      name: "caption_delivery_valid",
      passed: captionDeliveryOk,
      details: captionDeliveryOk
        ? `delivery_mode=${captionPolicy.delivery_mode}`
        : `delivery_mode=${captionPolicy.delivery_mode} missing=sidecar`,
    });

    const nleArtifacts = new Set<string>(["final_video", "qa_report"]);
    if (
      captionPolicy.source !== "none" &&
      (captionPolicy.delivery_mode === "sidecar" || captionPolicy.delivery_mode === "both")
    ) {
      if (fs.existsSync(path.join(packageDir, "captions/speech.approved.srt"))) {
        nleArtifacts.add("srt_sidecar");
      }
      if (fs.existsSync(path.join(packageDir, "captions/speech.vtt"))) {
        nleArtifacts.add("vtt_sidecar");
      }
    }
    if (canonicalAudioPlan?.strategy === "music_master") {
      const musicMasterReport = readAudioMixReport(audioMixReportPath);
      const musicMasterFinalMixPath = path.join(packageDir, "audio", "final_mix.wav");
      checks.push(checkMusicMasterAudioPlan(
        canonicalAudioPlan,
        musicMasterReport,
        {
          finalMixPath: musicMasterFinalMixPath,
          masteredMp3Path: path.join(packageDir, "audio", "music_master_320.mp3"),
          finalVideoPath: qaMeasurementVideoPath,
          projectDir: absDir,
        },
      ));
      if (fs.existsSync(musicMasterFinalMixPath)) nleArtifacts.add("final_mix");
      if (fs.existsSync(audioMixReportPath)) nleArtifacts.add("audio_mix_report");
      if (canonicalAudioPlan.music_master?.audio_decision === "mastering"
        && fs.existsSync(path.join(packageDir, "audio", "music_master_320.mp3"))) {
        nleArtifacts.add("mastered_mp3");
      }
    }
    completenessCheck = checkPackageCompleteness(
      sourceOfTruth,
      captionPolicy,
      nleArtifacts,
      canonicalAudioPlan?.strategy === "music_master"
        && canonicalAudioPlan.music_master?.audio_decision === "mastering",
    );
  }

  let qaMeasurements: QaMeasurements;
  try {
    qaMeasurements = await resolveQaMeasurements({
      packageDir,
      sourceOfTruth,
      createdAt,
      skipRender: options?.skipRender ?? false,
      finalVideoPath: qaMeasurementVideoPath,
      finalAudioPath: qaMeasurementAudioPath,
      dialoguePath: qaMeasurementDialoguePath,
      expectedDialogueWindowsMs: sourceOfTruth === "engine_render"
        ? resolveDialogueWindowsMs(timeline, fps)
        : undefined,
      assemblyPath: qaMeasurementAssemblyPath,
      requireAudio: timelineRequiresAudio,
      precomputedMetrics: options?.precomputedMetrics,
      deterministicAllowedRanges: deriveDeterministicAllowedRanges(
        timeline as DeterministicTimelineIntent,
        blueprint.ending_policy,
      ),
    });
  } catch (err) {
    return {
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `QA measurement failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      sourceOfTruth,
    };
  }
  const canonicalEncodedLoudness = finalAudioMixReport?.encoded_result?.loudness;
  if (canonicalEncodedLoudness?.status === "measured"
    && canonicalEncodedLoudness.integrated_lufs !== null
    && canonicalEncodedLoudness.true_peak_dbtp !== null) {
    qaMeasurements = {
      ...qaMeasurements,
      // Package loudness QA is authoritative from the encoded deliverable.
      // In particular, true peak comes from encoded loudnorm input_tp, not an
      // intended target or a pre-encode stem.
      loudness_integrated: canonicalEncodedLoudness.integrated_lufs,
      loudness_true_peak: canonicalEncodedLoudness.true_peak_dbtp,
    };
    writeQaMeasurements(path.join(packageDir, "qa-measurements.json"), qaMeasurements);
  }
  logQaMeasurementWarnings(qaMeasurements);

  const deterministicOutputQA = qaMeasurements.deterministic_output_qa;
  checks.push(...checkDeterministicFinalOutput(deterministicOutputQA));
  if (deterministicOutputQA) {
    metrics.deterministic_output_qa = deterministicOutputQA;
  }

  let layoutSnapshotPath: string | undefined;
  if (sourceOfTruth === "engine_render") {
    let deterministicLayoutQA: DeterministicLayoutQAResult;
    try {
      const layoutSnapshot = buildRenderLayoutSnapshot(
        timeline,
        captionApproval as CaptionApproval | undefined,
      );
      const snapshotValidation = validateAgainstSchema(
        layoutSnapshot,
        "render-layout-snapshot.schema.json",
      );
      deterministicLayoutQA = snapshotValidation.valid
        ? evaluateDeterministicLayoutQA(layoutSnapshot)
        : incompleteDeterministicLayoutQA(
          `render layout snapshot schema failed: ${snapshotValidation.errors.join("; ")}`,
        );
      layoutSnapshotPath = path.join(packageDir, "layout-qa-snapshot.json");
      fs.writeFileSync(
        layoutSnapshotPath,
        `${JSON.stringify(layoutSnapshot, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      deterministicLayoutQA = incompleteDeterministicLayoutQA(
        `render layout snapshot failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    checks.push(...checkDeterministicLayoutQA(deterministicLayoutQA));
    metrics.deterministic_layout_qa = deterministicLayoutQA;
  }

  const resolutionCheck = checkResolutionSpec(
    qaMeasurements.video_frame,
    resolveExpectedVideoFrameSpec(absDir, timeline),
    qaMeasurements.video_frame_probe_error,
  );
  checks.push({
    name: resolutionCheck.name,
    passed: resolutionCheck.passed,
    details: resolutionCheck.details,
  });
  Object.assign(metrics, resolutionCheck.metrics);

  if (sourceOfTruth === "engine_render" && timelineRequiresAudio) {
    const occupancyCheck = checkDialogueOccupancy(
      qaMeasurements.dialogue_window_ms,
      qaMeasurements.observed_non_silent_ms,
    );
    checks.push(occupancyCheck);
    metrics.dialogue_occupancy_ratio = qaMeasurements.dialogue_occupancy;

    const alignmentCheck = checkDialogueTimelineAlignment(
      qaMeasurements.dialogue_outside_expected_ms,
      frameDurationMs,
    );
    checks.push(alignmentCheck);
    if (qaMeasurements.dialogue_outside_expected_ms != null) {
      metrics.dialogue_outside_expected_ms = qaMeasurements.dialogue_outside_expected_ms;
    }
    if (qaMeasurements.dialogue_first_signal_ms != null) {
      metrics.dialogue_first_signal_ms = qaMeasurements.dialogue_first_signal_ms;
    }
    if (qaMeasurements.dialogue_last_signal_ms != null) {
      metrics.dialogue_last_signal_ms = qaMeasurements.dialogue_last_signal_ms;
    }
    if (qaMeasurements.expected_dialogue_start_ms != null) {
      metrics.expected_dialogue_start_ms = qaMeasurements.expected_dialogue_start_ms;
    }
    if (qaMeasurements.expected_dialogue_end_ms != null) {
      metrics.expected_dialogue_end_ms = qaMeasurements.expected_dialogue_end_ms;
    }

    const driftCheck = checkAvDrift(
      qaMeasurements.video_duration_ms,
      qaMeasurements.audio_duration_ms,
      frameDurationMs,
    );
    checks.push(driftCheck);
    metrics.av_duration_delta_ms = qaMeasurements.av_duration_delta_ms ?? qaMeasurements.av_drift_ms;
    metrics.av_drift_ms = qaMeasurements.av_drift_ms;

    const loudnessCheck = checkLoudnessTargetForAudioPolicy(
      preserveOriginalAudioLevel,
      qaMeasurements.loudness_integrated,
      qaMeasurements.loudness_true_peak,
    );
    checks.push(loudnessCheck);
    metrics.integrated_lufs = qaMeasurements.loudness_integrated;
    metrics.true_peak_dbtp = qaMeasurements.loudness_true_peak;
  } else if (sourceOfTruth === "engine_render") {
    checks.push(
      { name: "dialogue_occupancy_valid", passed: true, details: "not_applicable: timeline has no audio" },
      { name: "dialogue_timeline_alignment_valid", passed: true, details: "not_applicable: video-only timeline" },
      { name: "av_drift_valid", passed: true, details: "not_applicable: video-only timeline" },
      { name: "loudness_target_valid", passed: true, details: "not_applicable: timeline has no audio" },
    );
  } else {
    const syncCheck = checkAvDrift(
      qaMeasurements.video_duration_ms,
      qaMeasurements.audio_duration_ms,
      frameDurationMs,
    );
    checks.push({
      name: "supplied_av_sync_valid",
      passed: syncCheck.passed,
      details: syncCheck.details,
    });
    metrics.av_duration_delta_ms = qaMeasurements.av_duration_delta_ms ?? qaMeasurements.av_drift_ms;
    metrics.av_drift_ms = qaMeasurements.av_drift_ms;

    const loudnessCheck = checkLoudnessTargetForAudioPolicy(
      preserveOriginalAudioLevel,
      qaMeasurements.loudness_integrated,
      qaMeasurements.loudness_true_peak,
    );
    checks.push(loudnessCheck);
    metrics.integrated_lufs = qaMeasurements.loudness_integrated;
    metrics.true_peak_dbtp = qaMeasurements.loudness_true_peak;
  }

  if (completenessCheck) {
    checks.push(completenessCheck);
  }
  if (sourceOfTruth === "engine_render" && assemblyFreshness) {
    checks.push({
      name: "source_inputs_freshness_valid",
      passed: assemblyFreshness.status === "fresh",
      details: assemblyFreshness.status === "fresh"
        ? `status=fresh source_inputs_hash=${assemblyFreshness.sourceInputsHash ?? "not_applicable"}`
        : `status=${assemblyFreshness.status} reason=${assemblyFreshness.reason ?? "unknown"}`,
    });
  }

  // 6. Build QA report
  const qaReport: QaReport = {
    ...buildQaReport(
      doc.project_id,
      sourceOfTruth,
      checks,
      metrics,
      {
        final_video: projectRelativePath(absDir, path.join(packageDir, "video", "final.mp4")),
        ...(layoutSnapshotPath
          ? { layout_snapshot: projectRelativePath(absDir, layoutSnapshotPath) }
          : {}),
        ...(sourceOfTruth === "engine_render" && timelineRequiresAudio ? {
          final_mix: projectRelativePath(absDir, path.join(packageDir, "audio", "final_mix.wav")),
          audio_mix_report: projectRelativePath(absDir, path.join(packageDir, "logs", "audio-mix-report.json")),
        } : {}),
      },
    ),
    ...(assemblyFreshness ? {
      source_inputs_freshness: {
        status: assemblyFreshness.status === "fresh" ? "fresh" as const : "stale" as const,
        ...(assemblyFreshness.reason ? { reason: assemblyFreshness.reason } : {}),
        ...(assemblyFreshness.sourceInputsHash
          ? { source_inputs_hash: assemblyFreshness.sourceInputsHash }
          : {}),
        ...(assemblyFreshness.sourceInputsStatus
          ? { attestation_status: assemblyFreshness.sourceInputsStatus }
          : {}),
        ...(assemblyFreshness.sourceInputWarnings?.length
          ? { warnings: assemblyFreshness.sourceInputWarnings }
          : {}),
      },
    } : {}),
  };

  // Write QA report
  fs.writeFileSync(
    path.join(packageDir, "qa-report.json"),
    JSON.stringify(qaReport, null, 2),
    "utf-8",
  );

  // Generate human-readable QA report
  const mdLines = [
    `# QA Report`,
    ``,
    `- **Project**: ${doc.project_id}`,
    `- **Source of Truth**: ${sourceOfTruth}`,
    `- **Passed**: ${qaReport.passed ? "YES" : "NO"}`,
    ``,
    `## Checks`,
    ``,
  ];
  for (const check of qaReport.checks) {
    mdLines.push(`- ${check.passed ? "PASS" : "**FAIL**"} \`${check.name}\`: ${check.details}`);
  }
  fs.writeFileSync(
    path.join(packageDir, "qa-report.md"),
    mdLines.join("\n"),
    "utf-8",
  );

  // 7. If QA failed, don't transition to packaged
  if (!qaReport.passed) {
    return {
      success: false,
      qaReport,
      releaseSafetyReport,
      sourceOfTruth,
      error: {
        code: "VALIDATION_FAILED",
        message: "QA checks failed - cannot transition to packaged",
        details: checks.filter((c) => !c.passed),
      },
    };
  }

  // 8. Build package manifest
  const editorialTimelineHash = computeFileHash(timelinePath);
  const renderDefaultsPath = path.join(absDir, "runtime", "render-pipeline-defaults.yaml");
  const renderDefaultsHash = fs.existsSync(renderDefaultsPath)
    ? computeFileHash(renderDefaultsPath)
    : undefined;
  const packageSourceInputs = sourceOfTruth === "engine_render"
    ? canonicalAudioPlan
      ? {
          hash: deliverableSourceInputs.source_inputs_hash,
          status: deliverableSourceInputs.status,
        }
      : assemblyFreshness?.sourceInputsHash && assemblyFreshness.sourceInputsStatus
      ? {
          hash: assemblyFreshness.sourceInputsHash,
          status: assemblyFreshness.sourceInputsStatus,
        }
      : (() => {
          return {
            hash: deliverableSourceInputs.source_inputs_hash,
            status: deliverableSourceInputs.status,
          };
        })()
    : undefined;
  let packageManifest: PackageManifest;
  if (deferActivation && sourceOfTruth === "nle_finishing") {
    const finalizedStagedVideo = path.join(packageDir, "video", "final.mp4");
    fs.mkdirSync(path.dirname(finalizedStagedVideo), { recursive: true });
    if (path.resolve(finalVideoSourcePath!) !== path.resolve(finalizedStagedVideo)) {
      materializeFileSync(finalVideoSourcePath!, finalizedStagedVideo);
    }
    finalVideoSourcePath = finalizedStagedVideo;
  }
  const publishedFinalVideo = deferActivation
    ? {
        path: path.resolve(finalVideoSourcePath!),
        relativePath: projectRelativePath(absDir, finalVideoSourcePath!),
      }
    : publishFinalVideo(absDir, finalVideoSourcePath!);
  const captionApprovalHash = fs.existsSync(captionApprovalPath)
    ? computeFileHash(captionApprovalPath)
    : undefined;
  if (sourceOfTruth === "engine_render"
      && (!renderRouteReceiptPath || !fs.existsSync(renderRouteReceiptPath))) {
    throw new Error("render_route_receipt_missing_for_engine_render_manifest");
  }
  const derivedVideoProvenancePath = path.join(
    packageDir,
    "derived-video-provenance.json",
  );
  const derivedVideoProvenance = buildDerivedVideoProvenance({
    projectDir: absDir,
    projectId: doc.project_id,
    producer: sourceOfTruth,
    timelinePath,
    finalVideoPath: publishedFinalVideo.path,
    captionMode: captionPolicy.source === "none"
      ? "none"
      : captionPolicy.delivery_mode as "burn_in" | "sidecar" | "both",
    captionApprovalPath: captionPolicy.source === "none"
      ? undefined
      : captionApprovalPath,
    renderRouteReceiptPath: sourceOfTruth === "engine_render"
      ? renderRouteReceiptPath!
      : undefined,
    handoffId: sourceOfTruth === "nle_finishing"
      ? doc.handoff_resolution?.handoff_id || "unknown"
      : undefined,
    sourceInputs: deliverableSourceInputs,
    createdAt,
  });
  fs.writeFileSync(
    derivedVideoProvenancePath,
    `${JSON.stringify(derivedVideoProvenance, null, 2)}\n`,
    "utf-8",
  );

  if (sourceOfTruth === "engine_render") {
    packageManifest = buildEngineRenderManifest({
      projectId: doc.project_id,
      baseTimelineVersion: timeline.version || "1",
      editorialTimelineHash,
      outputDir: packageDir,
      captionApprovalHash,
      musicCuesHash: doc.artifact_hashes?.music_cues_hash,
      renderDefaultsHash,
      sourceInputsHash: packageSourceInputs!.hash,
      sourceInputsAttestationStatus: packageSourceInputs!.status,
      sourceInputsFreshnessReason: assemblyFreshness
        ? assemblyFreshness.reason ?? "fresh"
        : undefined,
      captionPolicy,
      renderRouteReceiptPath: renderRouteReceiptPath!,
      ...(resolvedCaptionVisualTreatmentInput ? { captionVisualTreatmentInput: resolvedCaptionVisualTreatmentInput } : {}),
      ...(renderReportPath ? { renderReportPath } : {}),
      ...(canonicalAudioPlanPath ? { audioRenderPlanPath: canonicalAudioPlanPath } : {}),
      derivedVideoProvenancePath,
      layoutSnapshotPath,
      finalVideoPath: publishedFinalVideo.path,
      createdAt,
    });
  } else {
    packageManifest = buildNleFinishingManifest({
      projectId: doc.project_id,
      baseTimelineVersion: timeline.version || "1",
      editorialTimelineHash,
      outputDir: packageDir,
      handoffId: doc.handoff_resolution?.handoff_id || "unknown",
      captionApprovalHash,
      renderDefaultsHash,
      captionPolicy,
      finalVideoPath: publishedFinalVideo.path,
      qaReportPath: path.join(packageDir, "qa-report.json"),
      ...(canonicalAudioPlan?.strategy === "music_master" && canonicalAudioPlanPath
        ? {
            audioRenderPlanPath: canonicalAudioPlanPath,
            audioMixReportPath,
            audioFinalMixPath: path.join(packageDir, "audio", "final_mix.wav"),
            ...(canonicalAudioPlan.music_master?.audio_decision === "mastering"
              ? { audioMasteredMp3Path: path.join(packageDir, "audio", "music_master_320.mp3") }
              : {}),
          }
        : {}),
      routeReceiptPath: renderRouteReceiptPath,
      sidecarPaths: [
        path.join(packageDir, "captions", "speech.approved.srt"),
        path.join(packageDir, "captions", "speech.vtt"),
      ],
      derivedVideoProvenancePath,
      layoutSnapshotPath,
      createdAt,
    });
  }

  // Write manifest
  fs.writeFileSync(
    path.join(packageDir, "package_manifest.json"),
    JSON.stringify(packageManifest, null, 2),
    "utf-8",
  );

  // QA and manifest are written by this command. Persist their current hashes
  // before the state transition so the next reconcile does not interpret the
  // package command's own outputs as an external invalidation.
  if (!deferActivation) {
    doc.artifact_hashes = snapshotArtifacts(absDir).hashes;

    // 9. Transition state: approved → packaged
    transitionState(
      absDir,
      doc,
      "packaged",
      commandName,
      actorName,
      `packaged via ${sourceOfTruth}`,
    );
  }

  return {
    success: true,
    qaReport,
    packageManifest,
    releaseSafetyReport,
    deliverablePath: publishedFinalVideo.path,
    sourceOfTruth,
    stateTransitioned: !deferActivation,
  };
}

function initDeferredPackageContext(
  projectDir: string,
  commandName: string,
  allowedStates: ProjectState[],
): { projectDir: string; doc: NonNullable<ReturnType<typeof readProjectState>> } | CommandError {
  const doc = readProjectState(projectDir);
  if (!doc) {
    return {
      code: "STATE_CHECK_FAILED",
      message: "project_state.yaml is missing",
    };
  }
  if (!allowedStates.includes(doc.current_state)) {
    return {
      code: "STATE_CHECK_FAILED",
      message: `Command ${commandName} requires state in [${allowedStates.join(", ")}], ` +
        `but current state is "${doc.current_state}"`,
      details: { current_state: doc.current_state, allowed_states: allowedStates },
    };
  }
  return { projectDir, doc };
}

function projectRelativePath(projectDir: string, filePath: string): string {
  return path.relative(path.resolve(projectDir), path.resolve(filePath)).split(path.sep).join("/");
}

function resolvePackageCommandProjectId(input: {
  preflight?: unknown;
  timeline?: unknown;
  state?: unknown;
}): { projectId: string } | { error: string } {
  const sources = Object.entries(input).flatMap(([source, value]) => {
    if (typeof value !== "string" || value.trim().length === 0) return [];
    return [{ source, projectId: value.trim() }];
  });
  const projectIds = [...new Set(sources.map((source) => source.projectId))];
  if (projectIds.length === 0) {
    return { error: "project identity is unresolved" };
  }
  if (projectIds.length > 1) {
    return {
      error: `project identity mismatch: ${sources.map((source) => `${source.source}=${source.projectId}`).join(" ")}`,
    };
  }
  return { projectId: projectIds[0] };
}

// ── Helpers ─────────────────────────────────────────────────────

function readReviewReportForGate10(projectDir: string): {
  reviewReport: Gate10ReviewReport | null;
  error?: CommandError;
} {
  const reportPath = path.join(projectDir, "06_review/review_report.yaml");
  if (!fs.existsSync(reportPath)) {
    return { reviewReport: null };
  }

  try {
    const reviewReport = parseYaml(fs.readFileSync(reportPath, "utf-8")) as Gate10ReviewReport;
    if (reviewReport.visual_qa?.optional_vlm_classification !== undefined
      || reviewReport.visual_qa?.optional_vlm_error_code !== undefined) {
      try {
        validateArtifact(reviewReport, "review-report.schema.json");
      } catch {
        return {
          reviewReport: null,
          error: {
            code: "VALIDATION_FAILED",
            message: "review_report optional VLM classification/error code is invalid",
          },
        };
      }
    }
    return {
      reviewReport,
    };
  } catch (err) {
    return {
      reviewReport: null,
      error: {
        code: "VALIDATION_FAILED",
        message: `Failed to parse review_report.yaml: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

function readOptionalVlmPolicyForGate10(projectDir: string): {
  policy: OptionalVlmPolicyArtifact | null;
  context?: OptionalVlmGateContext;
  error?: CommandError;
} {
  const policyPath = path.join(projectDir, "06_review/optional-vlm-policy.json");
  if (!fs.existsSync(policyPath)) return { policy: null };
  try {
    const policy = readOptionalVlmPolicy(projectDir);
    if (!policy) return { policy: null };
    let context: OptionalVlmGateContext;
    try {
      context = readCurrentOptionalVlmGateContext(projectDir);
    } catch {
      return {
        policy: null,
        error: {
          code: "VALIDATION_FAILED",
          message: "optional_vlm_policy current review-ready identity is unavailable",
        },
      };
    }
    return { policy, context };
  } catch {
    return {
      policy: null,
      error: {
        code: "VALIDATION_FAILED",
        message: "optional_vlm_policy artifact is malformed",
      },
    };
  }
}

function readAudioMixReport(reportPath: string): AudioMixReport | null {
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf-8")) as AudioMixReport;
  } catch {
    return null;
  }
}

function stubLoudnormMeasurement(): AudioMixReport["final_mastering"]["premaster_measurement"] {
  return null;
}

const ASPECT_RATIO_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

function resolveExpectedVideoFrameSpec(
  projectDir: string,
  timeline: unknown,
): ExpectedVideoFrameSpec | null {
  return resolvePackageSettingsVideoFrameSpec(projectDir) ??
    resolveTimelineVideoFrameSpec(timeline) ??
    resolveBriefAspectVideoFrameSpec(projectDir);
}

function resolvePackageSettingsVideoFrameSpec(
  projectDir: string,
): ExpectedVideoFrameSpec | null {
  const profilesDir = path.join(projectDir, "07_package/delivery_profiles");
  if (!fs.existsSync(profilesDir)) return null;

  const files = fs.readdirSync(profilesDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
  const candidates: Array<{ file: string; spec: ExpectedVideoFrameSpec }> = [];

  for (const file of files) {
    const parsed = safeParseYaml(path.join(profilesDir, file));
    const profile = asRecord(parsed);
    const constraints = asRecord(asRecord(profile?.video_constraints)?.resolution);
    const videoConstraints = asRecord(profile?.video_constraints);
    const width = readPositiveInteger(constraints?.width);
    const height = readPositiveInteger(constraints?.height);
    if (!width || !height) continue;

    const aspectRatio = readString(videoConstraints?.aspect_ratio);
    const frameRateMode = readString(videoConstraints?.frame_rate_mode);
    const fps = fpsFromFrameRateMode(frameRateMode);
    candidates.push({ file, spec: {
      source: "package_settings",
      source_detail: `delivery_profile:${readString(profile?.profile_id) ?? file}`,
      width,
      height,
      dar: aspectRatio && aspectRatio !== "custom" ? aspectRatio : ratioFromDimensions(width, height),
      ...(fps ? { fps_num: fps.num, fps_den: fps.den, fps: fps.value } : {}),
      ...(aspectRatio && aspectRatio !== "custom" ? { aspect_ratio: aspectRatio } : {}),
    } });
  }

  if (candidates.length === 0) return null;
  const defaultCandidate = candidates.find((candidate) => /^default\.ya?ml$/i.test(candidate.file));
  if (defaultCandidate) {
    return defaultCandidate.spec;
  }
  return candidates.length === 1 ? candidates[0].spec : null;
}

function resolveTimelineVideoFrameSpec(timeline: unknown): ExpectedVideoFrameSpec | null {
  const sequence = asRecord(asRecord(timeline)?.sequence);
  if (!sequence) return null;

  const width = readPositiveInteger(sequence.width);
  const height = readPositiveInteger(sequence.height);
  const fpsNum = readPositiveInteger(sequence.fps_num);
  const fpsDen = readPositiveInteger(sequence.fps_den);
  const aspectRatio = readString(sequence.output_aspect_ratio);

  if (!width && !height && !aspectRatio && (!fpsNum || !fpsDen)) {
    return null;
  }

  return {
    source: "timeline",
    source_detail: "05_timeline/timeline.json#sequence",
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio, dar: aspectRatio } : width && height ? { dar: ratioFromDimensions(width, height) } : {}),
    ...(fpsNum && fpsDen ? { fps_num: fpsNum, fps_den: fpsDen, fps: fpsNum / fpsDen } : {}),
  };
}

function resolveBriefAspectVideoFrameSpec(projectDir: string): ExpectedVideoFrameSpec | null {
  const briefPath = path.join(projectDir, "01_intent/creative_brief.yaml");
  const brief = asRecord(safeParseYaml(briefPath));
  const aspectRatio = readString(asRecord(brief?.editorial)?.aspect_ratio);
  if (!aspectRatio || aspectRatio === "unknown") return null;

  const dims = ASPECT_RATIO_DIMENSIONS[aspectRatio];
  if (!dims) return null;

  return {
    source: "creative_brief",
    source_detail: "01_intent/creative_brief.yaml#editorial.aspect_ratio",
    width: dims.width,
    height: dims.height,
    dar: aspectRatio,
    aspect_ratio: aspectRatio,
  };
}

function safeParseYaml(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseYaml(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fpsFromFrameRateMode(mode: string | undefined): { num: number; den: number; value: number } | null {
  switch (mode) {
    case "cfr_24":
      return { num: 24, den: 1, value: 24 };
    case "cfr_25":
      return { num: 25, den: 1, value: 25 };
    case "cfr_29.97":
      return { num: 30000, den: 1001, value: 30000 / 1001 };
    case "cfr_30":
      return { num: 30, den: 1, value: 30 };
    case "cfr_60":
      return { num: 60, den: 1, value: 60 };
    default:
      return null;
  }
}

function ratioFromDimensions(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcd(b, a % b);
}

function parseDensityFromDetails(details: string): number | undefined {
  const match = details.match(/max_density=([\d.]+)/);
  return match ? parseFloat(match[1]) : undefined;
}

function resolveDialogueWindowsMs(
  timeline: {
    tracks?: {
      audio?: Array<{
        clips?: Array<{
          timeline_in_frame?: number;
          timeline_duration_frames?: number;
          role?: string;
          audio_role?: string;
        }>;
      }>;
    };
  },
  fps: number,
): TimeWindowMs[] {
  if (!Number.isFinite(fps) || fps <= 0) return [];

  return (timeline.tracks?.audio ?? []).flatMap((track) =>
    (track.clips ?? [])
      .filter((clip) => clip.role !== "music" && clip.role !== "bgm" && clip.audio_role !== "music")
      .flatMap((clip) => {
        const startFrame = clip.timeline_in_frame;
        const durationFrames = clip.timeline_duration_frames;
        if (
          !Number.isFinite(startFrame) ||
          !Number.isFinite(durationFrames) ||
          (durationFrames ?? 0) <= 0
        ) {
          return [];
        }
        return [{
          start_ms: (startFrame! / fps) * 1000,
          end_ms: ((startFrame! + durationFrames!) / fps) * 1000,
        }];
      })
  );
}

interface ResolveQaMeasurementsOptions {
  packageDir: string;
  sourceOfTruth: SourceOfTruth;
  createdAt: string;
  skipRender: boolean;
  finalVideoPath?: string;
  finalAudioPath?: string;
  dialoguePath?: string;
  expectedDialogueWindowsMs?: TimeWindowMs[];
  assemblyPath?: string;
  requireAudio: boolean;
  precomputedMetrics?: PrecomputedQaMetrics;
  deterministicAllowedRanges?: DeterministicOutputQAAllowedRange[];
}

async function resolveQaMeasurements(
  options: ResolveQaMeasurementsOptions,
): Promise<QaMeasurements> {
  const outputPath = path.join(options.packageDir, "qa-measurements.json");
  const assemblyExists = !!options.assemblyPath && fs.existsSync(options.assemblyPath);
  const finalVideoExists = !!options.finalVideoPath && fs.existsSync(options.finalVideoPath);

  if (options.skipRender) {
    if (options.precomputedMetrics) {
      const precomputed = buildQaMeasurementsFromPrecomputed(
        options.precomputedMetrics,
        options.createdAt,
      );
      writeQaMeasurements(outputPath, precomputed);
      return precomputed;
    }

    // Packaging QA evaluates the deliverable when one already exists. The
    // assembly remains a fallback for legacy validation-only callers, but it
    // may legitimately be one frame shorter than the normalized final mux.
    if (finalVideoExists) {
      const measuredAudioPath = options.finalAudioPath && fs.existsSync(options.finalAudioPath)
        ? options.finalAudioPath
        : undefined;
      return measureQaMedia({
        videoPath: options.finalVideoPath!,
        audioPath: measuredAudioPath,
        dialoguePath: options.dialoguePath && fs.existsSync(options.dialoguePath)
          ? options.dialoguePath
          : undefined,
        expectedDialogueWindowsMs: options.expectedDialogueWindowsMs,
        videoOnly: !options.requireAudio,
        outputPath,
        createdAt: options.createdAt,
        deterministicAllowedRanges: options.deterministicAllowedRanges,
      });
    }

    if (options.sourceOfTruth === "engine_render" && assemblyExists) {
      return measureQaMedia({
        videoPath: options.assemblyPath!,
        dialoguePath: options.dialoguePath && fs.existsSync(options.dialoguePath)
          ? options.dialoguePath
          : undefined,
        expectedDialogueWindowsMs: options.expectedDialogueWindowsMs,
        videoOnly: !options.requireAudio,
        outputPath,
        createdAt: options.createdAt,
        deterministicAllowedRanges: options.deterministicAllowedRanges,
      });
    }
  }

  const measuredVideoPath = finalVideoExists
    ? options.finalVideoPath
    : options.sourceOfTruth === "engine_render" && assemblyExists
      ? options.assemblyPath
      : undefined;

  if (measuredVideoPath) {
    const measuredAudioPath = options.finalAudioPath && fs.existsSync(options.finalAudioPath)
      ? options.finalAudioPath
      : undefined;
    return measureQaMedia({
      videoPath: measuredVideoPath,
      audioPath: measuredAudioPath,
      dialoguePath: options.dialoguePath && fs.existsSync(options.dialoguePath)
        ? options.dialoguePath
        : undefined,
      expectedDialogueWindowsMs: options.expectedDialogueWindowsMs,
      videoOnly: !options.requireAudio,
      outputPath,
      createdAt: options.createdAt,
      deterministicAllowedRanges: options.deterministicAllowedRanges,
    });
  }

  if (options.precomputedMetrics) {
    const precomputed = buildQaMeasurementsFromPrecomputed(
      options.precomputedMetrics,
      options.createdAt,
    );
    writeQaMeasurements(outputPath, precomputed);
    return precomputed;
  }

  throw new Error("No measurable media artifact available for QA");
}

function logQaMeasurementWarnings(measurements: QaMeasurements): void {
  if (!measurements.audio_path) return;
  for (const warning of collectQaMeasurementWarnings(measurements)) {
    console.warn(`[package] QA warning: ${warning.message}`);
  }
}


// ── Public authority routes (no internal shortcuts exist) ────────────────

/**
 * The staged lyric mode of a candidate generation: the canonical request
 * artifact written before generation is the mode authority.
 */
function readStagedLyricMode(generationDir: string): "present" | "absent" {
  const coreArtifacts = [
    path.join(generationDir, "captions", "lyrics.ass"),
    path.join(generationDir, "captions", "lyric-typography-plan.json"),
  ];
  const present = coreArtifacts.filter((artifact) => fs.existsSync(artifact));
  if (present.length === 0 && !fs.existsSync(path.join(generationDir, "captions", "lyrics.lrc"))) return "absent";
  if (present.length !== coreArtifacts.length) throw new Error(`staged lyric delivery is incomplete in ${generationDir}`);
  const scriptPath = path.join(generationDir, "captions", "lyrics.lrc");
  if (fs.existsSync(scriptPath)) return "present";
  const planPath = path.join(generationDir, "captions", "lyric-typography-plan.json");
  const plan = parseJsonRejectDuplicateKeys<{ authority?: { kind?: unknown } }>(
    fs.readFileSync(planPath, "utf8"),
    planPath,
  );
  if (plan.authority?.kind !== "authored_caption_approval") {
    throw new Error(`staged lyric delivery has no source artifact or authored authority in ${generationDir}`);
  }
  return "present";
}

/** Public package route: strict pointer/current authority, always. */
export async function packageCommand(
  projectDir: string,
  options?: PackageCommandOptions,
): Promise<PackageCommandResult> {
  // lyric ASS paths are never caller-selectable: telops are consumed through
  // the finalize composite (canonical recomputation) or the strict pointer
  assertPublicPackageOptions(options, "/package");
  const resolvedDelivery = resolveDeliveryArtifactPathsStrict(path.resolve(projectDir));
  return runPackageStage(projectDir, {
    ...options,
    commandName: "package",
    actorName: "package_command",
    allowedStates: ["approved", "packaged"],
  }, resolvedDelivery, resolvedDelivery.lyricsAssPath);
}

/** Internal-authority render route used by /render after strict resolution. */
export async function packageRenderCommand(
  projectDir: string,
  options?: PackageCommandOptions,
): Promise<PackageCommandResult> {
  assertPublicPackageOptions(options, "/render");
  const resolvedDelivery = resolveDeliveryArtifactPathsStrict(path.resolve(projectDir));
  return runPackageStage(projectDir, {
    ...options,
    commandName: "/render",
    actorName: "render-video",
    allowedStates: ["approved", "packaged"],
    requireFinalRenderApproval: true,
  }, resolvedDelivery, resolvedDelivery.lyricsAssPath);
}

/**
 * Public finalize-composite route: packages the FRESH staged generation,
 * derived purely by canonical recomputation (01_intent/lyric_typography_request.json,
 * 01_intent/lyrics.lrc, staged font bytes, approvals, timeline, music cues,
 * source attestation). No caller-selected paths, tokens, or internal
 * arguments exist; a generation whose directory does not match its own
 * recomputed identity fails closed.
 */
export async function packageCaptionFinalizeGeneration(
  projectDir: string,
  options?: PackageCommandOptions,
): Promise<PackageCommandResult> {
  assertPublicPackageOptions(options, "caption-finalize");
  const absProject = path.resolve(projectDir);
  const anchors = deriveDeliveryIdentityAnchors(absProject);
  const generationsDir = path.join(absProject, CAPTION_FINALIZE_ROOT_RELATIVE_PATH, "generations");
  if (!fs.existsSync(generationsDir)) {
    throw new Error(`no staged caption-finalize generations: ${generationsDir}`);
  }
  // Among generations whose directory name equals their own recomputed
  // identity, the MOST RECENTLY STAGED one is the fresh finalize target
  // (an older generation with identical canonical inputs may legitimately
  // exist from a prior finalize of the same approval state).
  let matched: {
    generationDir: string;
    generationId: string;
    generationKey: string;
    mtimeMs: number;
    routeEvidence: ReturnType<typeof recomputeCurrentGenerationKeyInputs>["routeEvidence"];
  } | undefined;
  for (const entry of fs.readdirSync(generationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidateDir = path.join(generationsDir, entry.name);
    if (!fs.existsSync(path.join(candidateDir, "font-manifest.json"))) continue;
    let recomputed: CaptionGenerationKeyInputs;
    let routeEvidence: ReturnType<typeof recomputeCurrentGenerationKeyInputs>["routeEvidence"];
    try {
      ({ inputs: recomputed, routeEvidence } = recomputeCurrentGenerationKeyInputs({
        projectDir: absProject,
        generationDir: candidateDir,
        anchors,
        expectedProjectId: anchors.expectedProjectId,
        lyricDeliveryMode: readStagedLyricMode(candidateDir),
        lyricContract: undefined,
      }));
    } catch {
      continue; // not a viable staged generation under current canonical state
    }
    const key = generationKeyFromInputs(recomputed);
    const id = generationIdFromKey(key);
    if (entry.name === id) {
      const mtimeMs = fs.statSync(candidateDir).mtimeMs;
      if (!matched || mtimeMs > matched.mtimeMs) {
        matched = { generationDir: candidateDir, generationId: id, generationKey: key, mtimeMs, routeEvidence };
      }
    }
  }
  if (!matched) {
    throw new Error("no staged caption-finalize generation matches the current canonical identity");
  }
  const generationDir = matched.generationDir;
  const lyricAssPath = path.join(generationDir, "captions", "lyrics.ass");
  const routeReceiptPath = path.join(generationDir, "logs", "render-route.json");
  const suppliedFinalPath = path.join(generationDir, "staging", "direct-render.mp4");
  const suppliedFinalReceiptPath = path.join(generationDir, "staging", "input-caption-receipt.json");
  const resolvedDelivery: DeliveryArtifactPaths = {
    source: "fresh_staged",
    captionApprovalPath: path.join(generationDir, "caption_approval.json"),
    captionAssPath: path.join(generationDir, "captions", "speech.ass"),
    captionSrtPath: path.join(generationDir, "captions", "speech.approved.srt"),
    finalVideoPath: path.join(generationDir, "video", "final.mp4"),
    qaReportPath: path.join(generationDir, "qa-report.json"),
    packageManifestPath: path.join(generationDir, "package_manifest.json"),
    previewPath: path.join(generationDir, "preview", "final.mp4"),
    previewReceiptPath: path.join(generationDir, "preview", "receipt.json"),
    receiptPath: path.join(generationDir, "caption-finalize-receipt.json"),
    lyricsAssPath: fs.existsSync(lyricAssPath) ? lyricAssPath : undefined,
    packageFinalVideoPath: path.join(generationDir, "video", "final.mp4"),
    finalMixPath: path.join(generationDir, "audio", "final_mix.wav"),
    captionFontsDir: path.join(generationDir, "fonts"),
    typographyPolicyPath: fs.existsSync(path.join(absProject, "04_plan", "typography_policy.json"))
      ? path.join(absProject, "04_plan", "typography_policy.json")
      : undefined,
    visualTreatmentPatchPath: fs.existsSync(path.join(absProject, "04_plan", "visual-treatment-patch.json"))
      ? path.join(absProject, "04_plan", "visual-treatment-patch.json")
      : undefined,
    renderRouteReceiptPath: fs.existsSync(routeReceiptPath) ? routeReceiptPath : undefined,
    ...(matched.routeEvidence.route_kind === "supplied_final"
      ? {
          suppliedFinalPath,
          suppliedFinalReceiptPath,
        }
      : {}),
  };
  const internal: PackageStageInternalOptions = {
    ...options,
    commandName: "caption-finalize",
    actorName: "caption-finalize",
    allowedStates: ["approved", "packaged"],
    deferActivation: true,
    captionApprovalPath: resolvedDelivery.captionApprovalPath,
    captionFontsDir: resolvedDelivery.captionFontsDir,
    ...(resolvedDelivery.typographyPolicyPath
      ? { typographyPolicyPath: resolvedDelivery.typographyPolicyPath }
      : {}),
    ...(resolvedDelivery.visualTreatmentPatchPath
      ? { visualTreatmentPatchPath: resolvedDelivery.visualTreatmentPatchPath }
      : {}),
    ...(resolvedDelivery.renderRouteReceiptPath
      ? { renderRouteReceiptPath: resolvedDelivery.renderRouteReceiptPath }
      : {}),
    ...(resolvedDelivery.suppliedFinalPath
      ? { suppliedFinalPath: resolvedDelivery.suppliedFinalPath }
      : {}),
    ...(resolvedDelivery.suppliedFinalReceiptPath
      ? { suppliedFinalReceiptPath: resolvedDelivery.suppliedFinalReceiptPath }
      : {}),
  };
  return runPackageStage(projectDir, internal, resolvedDelivery, resolvedDelivery.lyricsAssPath);
}
