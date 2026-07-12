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
  checkPackageCompleteness,
  checkDialogueOccupancy,
  checkResolutionSpec,
  getRequiredChecks,
  type ExpectedVideoFrameSpec,
  type QaReport,
  type QaCheckResult,
} from "../packaging/qa.js";
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
} from "../packaging/qa-measure.js";
import { assembleTimelineToMp4 } from "../render/assembler.js";
import { runRenderPipeline } from "../render/pipeline.js";
import { readCreativeBriefAutonomyMode } from "../autonomy.js";
import { publishFinalVideo } from "../packaging/deliverable.js";
import {
  getReleaseSafetyMode,
  isP4aReleaseSafetyEnabled,
  runReleaseSafetyPreflight,
  writeReleaseSafetyReport,
  type ReleaseSafetyReport,
} from "../artifacts/p4a-release-safety.js";

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
  const ctx = initCommand(projectDir, commandName, allowedStates);
  if (isCommandError(ctx)) {
    return { success: false, error: ctx };
  }

  const { projectDir: absDir, doc } = ctx;
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

  const timelinePath = path.join(absDir, "05_timeline/timeline.json");
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
  const currentTimelineVersion = timeline.version || "1";

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
  fs.mkdirSync(path.join(packageDir, "video"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "audio"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "captions"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "logs"), { recursive: true });

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
  const captionPolicy = blueprint.caption_policy || {
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
  let qaMeasurementAssemblyPath: string | undefined = options?.assemblyPath;
  let finalVideoSourcePath: string | undefined;
  const defaultAssemblyPath = path.join(absDir, "05_timeline/assembly.mp4");
  if (!qaMeasurementAssemblyPath && fs.existsSync(defaultAssemblyPath)) {
    qaMeasurementAssemblyPath = defaultAssemblyPath;
  }
  let completenessCheck: QaCheckResult | undefined;

  // timeline_schema_valid
  const timelineValidation = validateAgainstSchema(timeline, "timeline-ir.schema.json");
  checks.push({
    name: "timeline_schema_valid",
    passed: timelineValidation.valid,
    details: timelineValidation.valid
      ? "timeline-ir.schema.json validation passed"
      : timelineValidation.errors.join("; "),
  });

  // caption_policy_valid
  const policyValid =
    ["transcript", "authored", "none"].includes(captionPolicy.source) &&
    (captionPolicy.source === "none" ||
      ["burn_in", "sidecar", "both"].includes(captionPolicy.delivery_mode));
  checks.push({
    name: "caption_policy_valid",
    passed: policyValid,
    details: policyValid
      ? `source=${captionPolicy.source} delivery_mode=${captionPolicy.delivery_mode}`
      : `field=caption_policy reason=invalid_combination`,
  });

  // Profile-specific checks
  if (sourceOfTruth === "engine_render") {
    // Caption density
    if (captionApproval && captionPolicy.source !== "none") {
      const densityCheck = checkCaptionDensity(
        captionApproval.speech_captions || [],
        fps,
        captionPolicy.language,
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
      // For testing: create stub files and assume standard artifacts exist
      const stubs = [
        path.join(packageDir, "video/final.mp4"),
        path.join(packageDir, "video/raw_video.mp4"),
        path.join(packageDir, "audio/raw_dialogue.wav"),
        path.join(packageDir, "audio/final_mix.wav"),
      ];
      for (const stub of stubs) {
        if (!fs.existsSync(stub)) {
          fs.writeFileSync(stub, "stub", "utf-8");
        }
      }
      existingArtifacts.add("final_video");
      existingArtifacts.add("raw_video");
      existingArtifacts.add("raw_dialogue");
      existingArtifacts.add("final_mix");
      existingArtifacts.add("qa_report");
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
        if (!assemblyPath) {
          assemblyPath = path.join(absDir, "05_timeline/assembly.mp4");
          if (!fs.existsSync(assemblyPath)) {
            await assembleTimelineToMp4({
              projectDir: absDir,
              timelinePath,
              outputPath: assemblyPath,
            });
          }
        }

        const renderResult = await runRenderPipeline({
          projectDir: absDir,
          timelinePath,
          captionApprovalPath,
          musicCuesPath,
          assemblyPath,
          captionPolicy: captionPolicy as {
            language: string;
            delivery_mode: "burn_in" | "sidecar" | "both";
            source: "transcript" | "authored" | "none";
            styling_class: string;
          },
          outputDir: packageDir,
          fps,
        });
        qaMeasurementAssemblyPath = assemblyPath;
        qaMeasurementVideoPath = renderResult.finalVideoPath;
        finalVideoSourcePath = renderResult.finalVideoPath;
        qaMeasurementAudioPath = renderResult.finalMixPath;

        // Check which artifacts the render produced
        if (fs.existsSync(renderResult.finalVideoPath)) existingArtifacts.add("final_video");
        if (fs.existsSync(renderResult.rawVideoPath)) existingArtifacts.add("raw_video");
        if (fs.existsSync(renderResult.rawDialoguePath)) existingArtifacts.add("raw_dialogue");
        if (fs.existsSync(renderResult.finalMixPath)) existingArtifacts.add("final_mix");
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
    completenessCheck = checkPackageCompleteness(
      sourceOfTruth,
      captionPolicy,
      existingArtifacts,
    );
    if (!qaMeasurementVideoPath) {
      qaMeasurementVideoPath = path.join(packageDir, "video/final.mp4");
    }
    if (!finalVideoSourcePath) {
      finalVideoSourcePath = qaMeasurementVideoPath;
    }
    if (!qaMeasurementAudioPath) {
      qaMeasurementAudioPath = path.join(packageDir, "audio/final_mix.wav");
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
      assemblyPath: qaMeasurementAssemblyPath,
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

  if (sourceOfTruth === "engine_render") {
    const occupancyCheck = checkDialogueOccupancy(
      qaMeasurements.dialogue_window_ms,
      qaMeasurements.observed_non_silent_ms,
    );
    checks.push(occupancyCheck);
    metrics.dialogue_occupancy_ratio = qaMeasurements.dialogue_occupancy;

    const driftCheck = checkAvDrift(
      qaMeasurements.video_duration_ms,
      qaMeasurements.audio_duration_ms,
      frameDurationMs,
    );
    checks.push(driftCheck);
    metrics.av_drift_ms = qaMeasurements.av_drift_ms;

    const loudnessCheck = checkLoudnessTarget(
      qaMeasurements.loudness_integrated,
      qaMeasurements.loudness_true_peak,
    );
    checks.push(loudnessCheck);
    metrics.integrated_lufs = qaMeasurements.loudness_integrated;
    metrics.true_peak_dbtp = qaMeasurements.loudness_true_peak;
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

  // 6. Build QA report
  const qaReport = buildQaReport(
    doc.project_id,
    sourceOfTruth,
    checks,
    metrics,
    {
      final_video: "07_package/video/final.mp4",
      final_mix: sourceOfTruth === "engine_render"
        ? "07_package/audio/final_mix.wav"
        : undefined,
    },
  );

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

interface ResolveQaMeasurementsOptions {
  packageDir: string;
  sourceOfTruth: SourceOfTruth;
  createdAt: string;
  skipRender: boolean;
  finalVideoPath?: string;
  finalAudioPath?: string;
  assemblyPath?: string;
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
  for (const warning of collectQaMeasurementWarnings(measurements)) {
    console.warn(`[package] QA warning: ${warning.message}`);
  }
}
