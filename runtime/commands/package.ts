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
import { assertTimelineRenderSupported } from "../render/media-kind-guard.js";
import { parse as parseYaml } from "yaml";
import {
  initCommand,
  isCommandError,
  transitionState,
  validateAgainstSchema,
  type CommandError,
} from "./shared.js";
import {
  writeProjectState,
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
  buildQaReport,
  checkCaptionDensity,
  checkCaptionAlignment,
  checkAvDrift,
  checkLoudnessTarget,
  checkAudioMixPolicy,
  checkPackageCompleteness,
  checkDialogueOccupancy,
  checkDialogueTimelineAlignment,
  checkResolutionSpec,
  getRequiredChecks,
  type ExpectedVideoFrameSpec,
  type QaReport,
  type QaCheckResult,
} from "../packaging/qa.js";
import { hasCaptionStylePreset } from "../../editor/shared/caption-style-tokens.js";
import { checkSocialRetentionFinishing } from "../packaging/social-retention-qa.js";
import {
  buildEngineRenderManifest,
  buildNleFinishingManifest,
  type PackageManifest,
} from "../packaging/manifest.js";
import {
  buildQaMeasurementsFromPrecomputed,
  collectQaMeasurementWarnings,
  measureQaMedia,
  writeQaMeasurements,
  type PrecomputedQaMetrics,
  type QaMeasurements,
  type TimeWindowMs,
} from "../packaging/qa-measure.js";
import { assembleTimelineToMp4 } from "../render/assembler.js";
import { runRenderPipeline } from "../render/pipeline.js";
import { timelineEmbeddedMusicAssetIds } from "../audio/timeline-music.js";
import type { AssemblyEngine } from "../render/assembly-orchestrator.js";
import {
  resolveProjectRenderRoute,
  type RenderRouteDecision,
} from "../render/route-resolver.js";
import { loadSourceMap } from "../media/source-map.js";
import { readCreativeBriefAutonomyMode } from "../autonomy.js";
import { publishFinalVideo } from "../packaging/deliverable.js";
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
  /** Pre-built assembly.mp4 path (skips Remotion) */
  assemblyPath?: string;
  /** Produce assembly through the selected engine instead of prebuilding with FFmpeg. */
  assemblyEngine?: AssemblyEngine;
  /** Capability-based route resolved by the package CLI. */
  renderRouteDecision?: RenderRouteDecision;
  /** For nle_finishing: operator-provided final.mp4 */
  suppliedFinalPath?: string;
  /** Timestamp override for testing */
  createdAt?: string;
  /** Skip render pipeline (for validation-only/testing) */
  skipRender?: boolean;
  /** Precomputed metrics for testing (skips ffprobe/ffmpeg measurement) */
  precomputedMetrics?: PrecomputedQaMetrics;
  /** Internal override used by /render phase wrapper */
  commandName?: string;
  /** Internal override used by /render phase wrapper */
  actorName?: string;
  /** Internal override used by /render phase wrapper */
  allowedStates?: ProjectState[];
}

// ── Command ─────────────────────────────────────────────────────

export async function packageCommand(
  projectDir: string,
  options?: PackageCommandOptions,
): Promise<PackageCommandResult> {
  const allowedStates: ProjectState[] = options?.allowedStates ?? ["approved", "packaged"];
  const commandName = options?.commandName ?? "package";
  const actorName = options?.actorName ?? "package_command";
  const requestedProjectDir = path.resolve(projectDir);
  const requestedTimelinePath = path.join(requestedProjectDir, "05_timeline", "timeline.json");
  if (fs.existsSync(requestedTimelinePath)) {
    assertTimelineRenderSupported(JSON.parse(fs.readFileSync(requestedTimelinePath, "utf8")), {
      projectDir: requestedProjectDir,
      timelinePath: requestedTimelinePath,
    });
  }
  const ctx = initCommand(projectDir, commandName, allowedStates);
  if (isCommandError(ctx)) {
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
  const timelineRequiresAudio = (timeline.tracks?.audio ?? []).some((track: { clips?: unknown[] }) => (track.clips?.length ?? 0) > 0) ||
    typeof timeline.audio_mix?.bgm_asset_id === "string";
  const currentTimelineVersion = timeline.version || "1";
  const embeddedMusicAssetIds = timelineEmbeddedMusicAssetIds(timeline);

  const blueprintPath = path.join(absDir, "04_plan/edit_blueprint.yaml");
  const blueprint = parseYaml(
    fs.readFileSync(blueprintPath, "utf-8"),
  ) as {
    caption_policy?: { language: string; delivery_mode: string; source: string; styling_class: string };
  };

  const packageDir = path.join(absDir, "07_package");
  const captionApprovalPath = path.join(packageDir, "caption_approval.json");
  const captionApproval = fs.existsSync(captionApprovalPath)
    ? JSON.parse(fs.readFileSync(captionApprovalPath, "utf-8"))
    : null;
  const musicCuesPath = path.join(packageDir, "music_cues.json");
  const musicCues = fs.existsSync(musicCuesPath)
    ? JSON.parse(fs.readFileSync(musicCuesPath, "utf-8"))
    : null;
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
    writeProjectState(absDir, doc);
  }

  const sourceOfTruth = gate10.source_of_truth!;
  let renderRouteDecision: RenderRouteDecision;
  try {
    renderRouteDecision = options?.renderRouteDecision
      ?? resolveProjectRenderRoute(absDir, options?.assemblyEngine ?? "auto");
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
  fs.mkdirSync(path.join(packageDir, "video"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "audio"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "captions"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "logs"), { recursive: true });
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
      writeReleaseSafetyReport(absDir, releaseSafetyReport);
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
  const captionPolicy = captionApproval?.caption_policy || blueprint.caption_policy || {
    language: "ja",
    delivery_mode: "both",
    source: "none",
    styling_class: "clean-lower-third",
  };

  // 5. Build QA checks
  const checks: QaCheckResult[] = [];
  const metrics: QaReport["metrics"] = {};
  let qaMeasurementVideoPath: string | undefined;
  let qaMeasurementAudioPath: string | undefined;
  let qaMeasurementDialoguePath: string | undefined;
  let qaMeasurementAssemblyPath: string | undefined = options?.assemblyPath;
  let finalVideoSourcePath: string | undefined;
  const defaultAssemblyPath = path.join(absDir, "05_timeline/assembly.mp4");
  if (!options?.assemblyEngine && !qaMeasurementAssemblyPath && fs.existsSync(defaultAssemblyPath)) {
    qaMeasurementAssemblyPath = defaultAssemblyPath;
  }
  let completenessCheck: QaCheckResult | undefined;
  let audioMixReportPath = path.join(packageDir, "logs/audio-mix-report.json");
  let assemblyFreshness: RenderArtifactFreshness | undefined;

  // timeline_schema_valid
  const timelineValidation = validateAgainstSchema(timeline, "timeline-ir.schema.json");
  checks.push({
    name: "timeline_schema_valid",
    passed: timelineValidation.valid,
    details: timelineValidation.valid
      ? "timeline-ir.schema.json validation passed"
      : timelineValidation.errors.join("; "),
  });
  if (renderRouteDecision.genre === "social_talking_head") {
    checks.push(...checkSocialRetentionFinishing(timeline, creativeBrief));
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
      );
      checks.push(densityCheck);
      metrics.caption_max_density = parseDensityFromDetails(densityCheck.details);

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
      // For testing: create stub files and assume standard artifacts exist
      const stubs = [
        path.join(packageDir, "video/final.mp4"),
        path.join(packageDir, "video/raw_video.mp4"),
        ...(timelineRequiresAudio ? [
          path.join(packageDir, "audio/raw_dialogue.wav"),
          path.join(packageDir, "audio/final_mix.wav"),
        ] : []),
      ];
      for (const stub of stubs) {
        if (!fs.existsSync(stub)) {
          fs.writeFileSync(stub, "stub", "utf-8");
        }
      }
      existingArtifacts.add("final_video");
      existingArtifacts.add("raw_video");
      if (timelineRequiresAudio) {
        existingArtifacts.add("raw_dialogue");
        existingArtifacts.add("final_mix");
      }
      existingArtifacts.add("qa_report");
      const stubMixReport: AudioMixReport = embeddedMusicAssetIds.length > 0
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
      if (captionPolicy.source !== "none" &&
          (captionPolicy.delivery_mode === "sidecar" || captionPolicy.delivery_mode === "both")) {
        existingArtifacts.add("srt_sidecar");
        existingArtifacts.add("vtt_sidecar");
      }
    } else {
      // Run the actual render pipeline
      let assemblyPath = options?.assemblyPath;
      const captionApprovalPath = fs.existsSync(path.join(packageDir, "caption_approval.json"))
        ? path.join(packageDir, "caption_approval.json")
        : undefined;
      const musicCuesPath = fs.existsSync(path.join(packageDir, "music_cues.json"))
        ? path.join(packageDir, "music_cues.json")
        : undefined;

      try {
        const assemblyEngine = options?.assemblyEngine ?? renderRouteDecision.assembly_engine;
        const sourceInputsBefore = createSourceInputAttestation(absDir, { timelinePath });
        if (!assemblyPath && assemblyEngine === "ffmpeg") {
          const existingFreshness = assessRenderArtifactFreshness(absDir, defaultAssemblyPath);
          if (existingFreshness.status === "fresh") {
            assemblyPath = defaultAssemblyPath;
          } else {
            await assembleTimelineToMp4({
              projectDir: absDir,
              timelinePath,
              outputPath: defaultAssemblyPath,
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
          captionApprovalPath,
          musicCuesPath,
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
        });
        if (!options?.assemblyPath) {
          writeRenderFreshnessMetadata(absDir, renderResult.assemblyPath, {
            sourceInputsBefore,
            createdAt,
          });
        } else {
          assertSourceInputsUnchanged(
            sourceInputsBefore,
            createSourceInputAttestation(absDir, { timelinePath }),
          );
        }
        assemblyFreshness = assessRenderArtifactFreshness(absDir, renderResult.assemblyPath);
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

        // Check which artifacts the render produced
        if (fs.existsSync(renderResult.finalVideoPath)) existingArtifacts.add("final_video");
        if (fs.existsSync(renderResult.rawVideoPath)) existingArtifacts.add("raw_video");
        if (fs.existsSync(renderResult.rawDialoguePath)) existingArtifacts.add("raw_dialogue");
        if (fs.existsSync(renderResult.finalMixPath)) existingArtifacts.add("final_mix");
        if (fs.existsSync(renderResult.audioMixReportPath)) {
          existingArtifacts.add("audio_mix_report");
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
    checks.push(timelineRequiresAudio
      ? checkAudioMixPolicy(
          readAudioMixReport(audioMixReportPath),
          Boolean(musicCues) || embeddedMusicAssetIds.length > 0,
          renderRouteDecision.genre === "social_talking_head",
        )
      : { name: "audio_mix_policy_valid", passed: true, details: "not_applicable: timeline has no audio or BGM" });
    completenessCheck = checkPackageCompleteness(
      sourceOfTruth,
      captionPolicy,
      existingArtifacts,
      timelineRequiresAudio,
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
    completenessCheck = checkPackageCompleteness(
      sourceOfTruth,
      captionPolicy,
      nleArtifacts,
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
  logQaMeasurementWarnings(qaMeasurements);

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

    const loudnessCheck = checkLoudnessTarget(
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

    const loudnessCheck = checkLoudnessTarget(
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
        final_video: "07_package/video/final.mp4",
        ...(sourceOfTruth === "engine_render" && timelineRequiresAudio ? {
          final_mix: "07_package/audio/final_mix.wav",
          audio_mix_report: "07_package/logs/audio-mix-report.json",
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
    ? assemblyFreshness?.sourceInputsHash && assemblyFreshness.sourceInputsStatus
      ? {
          hash: assemblyFreshness.sourceInputsHash,
          status: assemblyFreshness.sourceInputsStatus,
        }
      : (() => {
          const attestation = createSourceInputAttestation(absDir, { timelinePath });
          return { hash: attestation.source_inputs_hash, status: attestation.status };
        })()
    : undefined;
  let packageManifest: PackageManifest;
  const publishedFinalVideo = publishFinalVideo(absDir, finalVideoSourcePath!);

  if (sourceOfTruth === "engine_render") {
    packageManifest = buildEngineRenderManifest({
      projectId: doc.project_id,
      baseTimelineVersion: timeline.version || "1",
      editorialTimelineHash,
      outputDir: packageDir,
      captionApprovalHash: doc.artifact_hashes?.caption_approval_hash,
      musicCuesHash: doc.artifact_hashes?.music_cues_hash,
      renderDefaultsHash,
      sourceInputsHash: packageSourceInputs!.hash,
      sourceInputsAttestationStatus: packageSourceInputs!.status,
      sourceInputsFreshnessReason: assemblyFreshness
        ? assemblyFreshness.reason ?? "fresh"
        : undefined,
      captionPolicy,
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
      captionApprovalHash: doc.artifact_hashes?.caption_approval_hash,
      renderDefaultsHash,
      captionPolicy,
      finalVideoPath: publishedFinalVideo.path,
      qaReportPath: path.join(packageDir, "qa-report.json"),
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

  return {
    success: true,
    qaReport,
    packageManifest,
    releaseSafetyReport,
    deliverablePath: publishedFinalVideo.path,
    sourceOfTruth,
    stateTransitioned: true,
  };
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
    return {
      reviewReport: parseYaml(fs.readFileSync(reportPath, "utf-8")) as Gate10ReviewReport,
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

function readAudioMixReport(reportPath: string): AudioMixReport | null {
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf-8")) as AudioMixReport;
  } catch {
    return null;
  }
}

function stubLoudnormMeasurement(): AudioMixReport["final_mastering"]["premaster_measurement"] {
  return {
    input_i: "-16.00",
    input_tp: "-1.50",
    input_lra: "7.00",
    input_thresh: "-26.00",
    target_offset: "0.00",
  };
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
}

async function resolveQaMeasurements(
  options: ResolveQaMeasurementsOptions,
): Promise<QaMeasurements> {
  const outputPath = path.join(options.packageDir, "qa-measurements.json");
  const assemblyExists = !!options.assemblyPath && fs.existsSync(options.assemblyPath);

  if (options.skipRender) {
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
  }

  const finalVideoExists = !!options.finalVideoPath && fs.existsSync(options.finalVideoPath);
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
