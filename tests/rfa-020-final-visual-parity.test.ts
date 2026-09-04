import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildEngineRenderManifest, computeSha256 } from "../runtime/packaging/manifest.js";
import { verifyPackageGeneration } from "../runtime/packaging/package-verification.js";
import { loadContentRenderPlan } from "../runtime/content/render-plan.js";
import { resolveRenderRoute } from "../runtime/render/route-resolver.js";
import { runRenderPipeline } from "../runtime/render/pipeline.js";
import { resolveAndVerifyCanonicalCaptionVisualTreatmentInput, resolveCanonicalCaptionVisualTreatmentInput } from "../runtime/render/canonical-render-input.js";
import { captionRendererCapabilitiesForPolicy, captionVisualTreatmentCanonicalInputHash, captionVisualTreatmentPatchHash, captionApprovalBindingHash, parseCaptionVisualTreatmentPatch } from "../runtime/caption/visual-treatment.js";
import { loadTypographyPolicy } from "../runtime/caption/typography-policy.js";
import { loadPlatformSafeZoneProfile } from "../runtime/platform/safe-zone-profile.js";
import { captionVisualTreatmentReceiptSummary } from "../runtime/caption/visual-treatment.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { computeNormalizedJsonHash } from "../runtime/artifacts/p1-manifest-coverage.js";
import type { LoadedSourceMap } from "../runtime/media/source-map.js";

const execFileAsync = promisify(execFile);
const tempProjects: string[] = [];

afterEach(() => {
  for (const project of tempProjects.splice(0)) fs.rmSync(project, { recursive: true, force: true });
});

describe("RFA-020 final visual parity", () => {
  it("uses one resolved visual input for baseline preview and final render and applies it in ASS/libass", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-rfa020-parity-"));
    tempProjects.push(projectDir);
    const timelineDir = path.join(projectDir, "05_timeline");
    const mediaDir = path.join(projectDir, "02_media");
    const planDir = path.join(projectDir, "04_plan");
    const packageDir = path.join(projectDir, "07_package");
    const safeZonePath = path.join(projectDir, "delivery_profiles/platform-safe-zone/fixture/anonymous-verified-v1.yaml");
    for (const dir of [timelineDir, mediaDir, planDir, packageDir, path.dirname(safeZonePath)]) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.resolve("delivery_profiles/platform-safe-zone/fixture/anonymous-verified-v1.yaml"), safeZonePath);
    const safeZone = loadPlatformSafeZoneProfile(safeZonePath);

    const sourcePath = path.join(mediaDir, "anonymous-rfa020-fixture.mp4");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath,
    ]);

    const timelinePath = path.join(timelineDir, "timeline.json");
    fs.writeFileSync(timelinePath, `${JSON.stringify({
      version: "1",
      project_id: "anonymous-rfa020-fixture",
      created_at: "2026-08-21T00:00:00Z",
      sequence: { name: "Anonymous RFA-020 fixture", fps_num: 24, fps_den: 1, width: 160, height: 90, start_frame: 0 },
      tracks: {
        video: [{ track_id: "V1", kind: "video", clips: [{ clip_id: "CLP_VIDEO", segment_id: "SEG_VIDEO", asset_id: "AST_FIXTURE", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 24, beat_id: "b01", role: "hero", motivation: "anonymous real media fixture", fallback_segment_ids: [], confidence: 1, quality_flags: [] }] }],
        audio: [{ track_id: "A1", kind: "audio", role: "dialogue", clips: [{ clip_id: "CLP_AUDIO", segment_id: "SEG_AUDIO", asset_id: "AST_FIXTURE", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 24, beat_id: "b01", role: "dialogue", motivation: "anonymous real media fixture", fallback_segment_ids: [], confidence: 1, quality_flags: [] }] }],
      },
      markers: [], provenance: { compiler_version: "anonymous-rfa020-fixture" },
    }, null, 2)}\n`, "utf8");

    const policy = loadTypographyPolicy(path.resolve("tests/fixtures/rfa-caption/typography-policy.json"));
    const policyHash = computeNormalizedJsonHash(policy);
    fs.writeFileSync(path.join(planDir, "typography_policy.json"), `${JSON.stringify(policy, null, 2)}\n`, "utf8");
    const approval: any = {
      version: "caption-draft/v1", project_id: "anonymous-rfa020-fixture", base_timeline_version: "1",
      caption_policy: { language: "en", delivery_mode: "burn_in", source: "transcript", styling_class: "sns-vertical-outline" },
      speech_captions: [{ caption_id: "SC_0001", root_id: "SC_0001", asset_id: "AST_FIXTURE", segment_id: "SEG_CAPTION", timeline_in_frame: 4, timeline_duration_frames: 12, text: "Anonymous keyword", source: "transcript", styling_class: "sns-vertical-outline", metrics: { cps: 14, dwell_ms: 500 } }],
      text_overlays: [],
      approval: {
        status: "approved", approved_by: "anonymous-human-reviewer", approved_at: "2026-08-21T00:00:00Z",
        base_caption_draft_hash: `sha256:${"b".repeat(64)}`, base_timeline_hash: `sha256:${"c".repeat(64)}`, typography_policy_hash: policyHash,
        visual_treatment_context: {
          accessibility: { reduced_motion: false, high_contrast: false, audio_off: false, small_screen: false },
          safe_zone_profile: { profile_id: safeZone.profile.profile_id, path: "delivery_profiles/platform-safe-zone/fixture/anonymous-verified-v1.yaml", sha256: safeZone.hash },
        },
      },
    };
    const patchCandidate: any = {
      version: "caption-visual-treatment-patch/v1", project_id: approval.project_id,
      base_caption_draft_hash: approval.approval.base_caption_draft_hash, base_timeline_hash: approval.approval.base_timeline_hash,
      typography_policy_hash: policyHash, caption_approval_hash: captionApprovalBindingHash(approval),
      operations: [{ caption_id: "SC_0001", stable_root_id: "SC_0001", anchor: "center", rect: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 }, style_ref: "sns-vertical-outline", reference_scale: 0.9, hierarchy_role: "keyword", emphasis_ref: "emphasis-word", animation_ref: "semantic-reveal", effect_ref: "outline", fallback: "registered_fallback" }],
      session: { reviewer: "anonymous-human-reviewer", updated_at: "2026-08-21T00:00:00Z" },
    };
    const patch = parseCaptionVisualTreatmentPatch(patchCandidate);
    const capabilities = captionRendererCapabilitiesForPolicy(policy);
    approval.approval.caption_visual_treatment_patch_hash = captionVisualTreatmentPatchHash(patch);
    approval.approval.visual_treatment_input_hash = captionVisualTreatmentCanonicalInputHash({
      approval, patch, typography_policy: policy, capabilities,
      platform_safe_zone_profile_hash: safeZone.hash,
      platform_safe_zone_profile_id: safeZone.profile.profile_id,
      platform_safe_zone_profile_path: "delivery_profiles/platform-safe-zone/fixture/anonymous-verified-v1.yaml",
      platform_safe_zone_profile: safeZone.profile,
      accessibility: approval.approval.visual_treatment_context.accessibility,
    });
    fs.writeFileSync(path.join(packageDir, "caption_approval.json"), `${JSON.stringify(approval, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(packageDir, "caption_visual_treatment_patch.json"), `${JSON.stringify(patch, null, 2)}\n`, "utf8");
    const resolvedInput = resolveCanonicalCaptionVisualTreatmentInput(projectDir, { typographyPolicyPath: "04_plan/typography_policy.json" });
    expect(resolvedInput.status).toBe("ready");
    fs.writeFileSync(path.join(packageDir, "caption_visual_treatment_input.json"), `${JSON.stringify(resolvedInput, null, 2)}\n`, "utf8");

    const sourceMapEntry = { asset_id: "AST_FIXTURE", source_locator: sourcePath, local_source_path: sourcePath, link_path: "02_media/anonymous-rfa020-fixture.mp4", source_content_sha256: computeSha256(sourcePath) };
    const sourceMap: LoadedSourceMap = { locatorMap: new Map([["AST_FIXTURE", sourcePath]]), entryMap: new Map([["AST_FIXTURE", sourceMapEntry]]), entries: [sourceMapEntry] };
    const sourceOverrides = Object.fromEntries(sourceMap.locatorMap);
    const route = resolveRenderRoute({ requestedEngine: "auto", contentPlan: loadContentRenderPlan(timelinePath), aspectRatio: "16:9", captionsEnabled: true });
    const preview = await (await import("../runtime/preview/baseline-fast-preview.js")).renderBaselineFastPreview({ projectDir, timelinePath, sourceMap, firstNSec: 0.75 });
    const finalDir = path.join(projectDir, "final-render");
    const final = await runRenderPipeline({
      projectDir, timelinePath, captionApprovalPath: path.join(packageDir, "caption_approval.json"),
      typographyPolicyPath: "04_plan/typography_policy.json", visualTreatmentPatchPath: "07_package/caption_visual_treatment_patch.json",
      captionVisualTreatmentInput: resolvedInput, assemblyPath: sourcePath, sourceMap: sourceOverrides, renderRouteDecision: route,
      captionPolicy: approval.caption_policy, outputDir: finalDir, fps: 24,
      assertMediaWriteReadyImpl: () => ({ ok: true, checks: [] }),
    });

    const previewRoute = JSON.parse(fs.readFileSync(`${preview.outputPath}.render-route.json`, "utf8"));
    const finalRoute = JSON.parse(fs.readFileSync(final.renderRouteReceiptPath, "utf8"));
    expect(previewRoute.caption_visual_treatment.input_hash).toBe(resolvedInput.input_hash);
    expect(finalRoute.caption_visual_treatment.input_hash).toBe(resolvedInput.input_hash);
    expect(previewRoute.caption_visual_treatment.text_timing_hash).toBe(finalRoute.caption_visual_treatment.text_timing_hash);
    expect(previewRoute.caption_layer.engine).toBe("ffmpeg-libass");
    expect(finalRoute.caption_layer.engine).toBe("ffmpeg-libass");
    expect(validateAgainstSchema(JSON.parse(fs.readFileSync(final.renderReportPath!, "utf8")), "render-report.schema.json").valid).toBe(true);
    expect(JSON.parse(fs.readFileSync(final.renderReportPath!, "utf8")).caption_visual_treatment.resolved_input_hash).toBe(resolvedInput.input_hash);
    const expectedReceiptContext = captionVisualTreatmentReceiptSummary(resolvedInput);
    expect(previewRoute.caption_visual_treatment).toMatchObject(expectedReceiptContext);
    expect(finalRoute.caption_visual_treatment).toMatchObject(expectedReceiptContext);
    const { input_hash: expectedReportInputHash, ...expectedReportContext } = expectedReceiptContext;
    expect(JSON.parse(fs.readFileSync(final.renderReportPath!, "utf8")).caption_visual_treatment).toMatchObject({
      ...expectedReportContext,
      resolved_input_hash: expectedReportInputHash,
    });

    fs.writeFileSync(path.join(finalDir, "qa-report.json"), JSON.stringify({ version: "qa-report/v1", status: "pass" }));
    const packageManifest = buildEngineRenderManifest({
      projectId: approval.project_id,
      baseTimelineVersion: "1",
      editorialTimelineHash: computeSha256(timelinePath),
      outputDir: finalDir,
      finalVideoPath: final.finalVideoPath,
      captionPolicy: approval.caption_policy,
      renderRouteReceiptPath: final.renderRouteReceiptPath,
      sourceInputsHash: computeSha256(sourcePath).slice("sha256:".length),
      sourceInputsAttestationStatus: "verified",
      captionApprovalHash: computeSha256(path.join(packageDir, "caption_approval.json")),
      captionVisualTreatmentInput: resolvedInput,
      renderReportPath: final.renderReportPath,
    });
    const manifestValidation = validateAgainstSchema(packageManifest, "package-manifest.schema.json");
    expect(manifestValidation.valid, manifestValidation.errors.join("; ")).toBe(true);
    expect(packageManifest.provenance.render?.caption_visual_treatment?.resolved_input_hash).toBe(resolvedInput.input_hash);
    expect(packageManifest.provenance.render?.render_report?.sha256).toBe(computeSha256(final.renderReportPath!));

    // Package verification must re-resolve and re-hash every live visual
    // artifact, including the render report, before declaring the package
    // contract fresh. The wider package fixture is intentionally irrelevant
    // here; these are the production verification checks for this real render.
    fs.writeFileSync(path.join(packageDir, "package_manifest.json"), `${JSON.stringify(packageManifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(projectDir, "project_state.yaml"), [
      "version: 1",
      "project_id: anonymous-rfa020-fixture",
      "current_state: packaged",
      "handoff_resolution:",
      "  handoff_id: HND_rfa020_fixture",
      "  status: decided",
      "  source_of_truth_decision: engine_render",
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(packageDir, "qa-report.json"), JSON.stringify({
      version: "1",
      project_id: "anonymous-rfa020-fixture",
      source_of_truth: "engine_render",
      qa_profile: "engine_render",
      passed: true,
      checks: [{ name: "rfa020_real_render", passed: true, details: "real ffmpeg/libass fixture" }],
    }, null, 2), "utf8");
    const packageVerification = verifyPackageGeneration(projectDir, {
      qaReportPath: path.join(packageDir, "qa-report.json"),
      packageManifestPath: path.join(packageDir, "package_manifest.json"),
      finalVideoPath: final.finalVideoPath,
      captionApprovalPath: path.join(packageDir, "caption_approval.json"),
    });
    for (const checkName of [
      "caption_visual_treatment_typography_policy_hash_matches",
      "caption_visual_treatment_patch_hash_matches",
      "caption_visual_treatment_input_hash_matches",
      "render_report_hash_matches",
      "caption_visual_treatment_live_canonical_matches",
      "caption_visual_treatment_receipt_matches_canonical",
      "caption_visual_treatment_summary_matches_canonical",
      "render_report_schema_valid",
      "render_report_visual_treatment_matches_canonical",
    ]) {
      expect(packageVerification.checks.find((check) => check.name === checkName), checkName).toMatchObject({ passed: true });
    }

    const freshnessTamperCases = [
      ["04_plan/typography_policy.json", "caption_visual_treatment_typography_policy_hash_matches"],
      ["07_package/caption_visual_treatment_patch.json", "caption_visual_treatment_patch_hash_matches"],
      [finalRoute.inputs.caption_visual_treatment_input.path, "caption_visual_treatment_input_hash_matches"],
      [final.renderReportPath!, "render_report_hash_matches"],
    ] as const;
    for (const [relativePath, checkName] of freshnessTamperCases) {
      const artifactPath = path.isAbsolute(relativePath) ? relativePath : path.join(projectDir, relativePath);
      const original = fs.readFileSync(artifactPath);
      fs.writeFileSync(artifactPath, Buffer.concat([original, Buffer.from("tampered\n", "utf8")]));
      const tampered = verifyPackageGeneration(projectDir, {
        qaReportPath: path.join(packageDir, "qa-report.json"),
        packageManifestPath: path.join(packageDir, "package_manifest.json"),
        finalVideoPath: final.finalVideoPath,
        captionApprovalPath: path.join(packageDir, "caption_approval.json"),
      });
      expect(tampered.checks.find((check) => check.name === checkName), `${relativePath}:${checkName}`).toMatchObject({ passed: false });
      fs.writeFileSync(artifactPath, original);
    }
    const routeOriginal = JSON.parse(fs.readFileSync(final.renderRouteReceiptPath!, "utf8")) as Record<string, any>;
    for (const mutateReceipt of [
      (receipt: Record<string, any>) => { receipt.caption_visual_treatment.platform_safe_zone_profile_path = "delivery_profiles/stale-profile.yaml"; },
      (receipt: Record<string, any>) => { delete receipt.caption_visual_treatment.accessibility; },
    ]) {
      const tamperedReceipt = structuredClone(routeOriginal);
      mutateReceipt(tamperedReceipt);
      fs.writeFileSync(final.renderRouteReceiptPath!, `${JSON.stringify(tamperedReceipt, null, 2)}\n`, "utf8");
      const staleContext = verifyPackageGeneration(projectDir, {
        qaReportPath: path.join(packageDir, "qa-report.json"),
        packageManifestPath: path.join(packageDir, "package_manifest.json"),
        finalVideoPath: final.finalVideoPath,
        captionApprovalPath: path.join(packageDir, "caption_approval.json"),
      });
      expect(staleContext.checks.find((check) => check.name === "caption_visual_treatment_receipt_matches_canonical")).toMatchObject({ passed: false });
    }
    fs.writeFileSync(final.renderRouteReceiptPath!, `${JSON.stringify(finalRoute, null, 2)}\n`, "utf8");
    const manifestPath = path.join(packageDir, "package_manifest.json");
    const manifestOriginal = fs.readFileSync(manifestPath, "utf8");
    const manifestTampered = JSON.parse(manifestOriginal) as Record<string, any>;
    manifestTampered.provenance.render.caption_visual_treatment.platform_safe_zone_profile_id = "stale-profile-id";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifestTampered, null, 2)}\n`, "utf8");
    const manifestContext = verifyPackageGeneration(projectDir, {
      qaReportPath: path.join(packageDir, "qa-report.json"),
      packageManifestPath: manifestPath,
      finalVideoPath: final.finalVideoPath,
      captionApprovalPath: path.join(packageDir, "caption_approval.json"),
    });
    expect(manifestContext.checks.find((check) => check.name === "caption_visual_treatment_summary_matches_canonical")).toMatchObject({ passed: false });
    fs.writeFileSync(manifestPath, manifestOriginal);

    const assPath = path.join(finalDir, "captions", "speech.approved.burn.ass");
    const ass = fs.readFileSync(assPath, "utf8");
    expect(ass).toContain("\\pos(80,31)");
    expect(ass).toContain("\\fad(40,80)");
    expect(ass).toContain("\\fscx110");
    expect(ass).toContain("Anonymous keyword");

    const tamperedInput = structuredClone(resolvedInput);
    tamperedInput.caption_identity[0].text = "tampered after canonical resolution";
    expect(() => resolveAndVerifyCanonicalCaptionVisualTreatmentInput(projectDir, {
      approvalPath: path.join(packageDir, "caption_approval.json"),
      typographyPolicyPath: "04_plan/typography_policy.json",
      visualTreatmentPatchPath: "07_package/caption_visual_treatment_patch.json",
      providedInput: tamperedInput,
    })).toThrow(/does not exactly match the live canonical result/);
    await expect(runRenderPipeline({
      projectDir, timelinePath, captionApprovalPath: path.join(packageDir, "caption_approval.json"),
      typographyPolicyPath: "04_plan/typography_policy.json", visualTreatmentPatchPath: "07_package/caption_visual_treatment_patch.json",
      captionVisualTreatmentInput: tamperedInput, assemblyPath: sourcePath, sourceMap: sourceOverrides, renderRouteDecision: route,
      captionPolicy: approval.caption_policy, outputDir: path.join(projectDir, "tampered-final"), fps: 24,
      assertMediaWriteReadyImpl: () => ({ ok: true, checks: [] }),
    })).rejects.toThrow(/does not exactly match the live canonical result/);
    await expect((await import("../runtime/preview/baseline-fast-preview.js")).renderBaselineFastPreview({
      projectDir, timelinePath, sourceMap, firstNSec: 0.75, captionVisualTreatmentInput: tamperedInput,
      outputPath: path.join(projectDir, "tampered-preview.mp4"),
    })).rejects.toThrow(/does not exactly match the live canonical result/);

    // Full-frame SSIM proves geometry/encode parity. The ROI oracle is the
    // caption-sensitive gate: raw source omission must fail this threshold.
    const similarity = await execFileAsync("ffmpeg", ["-v", "error", "-i", final.finalVideoPath, "-i", preview.outputPath, "-filter_complex", "[0:v][1:v]ssim=stats_file=-", "-frames:v", "18", "-f", "null", "-"], { maxBuffer: 10 * 1024 * 1024 });
    const ssim = Number((`${similarity.stdout}\n${similarity.stderr}`.match(/All:([0-9.]+)/)?.[1] ?? "0"));
    expect(ssim).toBeGreaterThan(0.7);
    const omission = await execFileAsync("ffmpeg", ["-v", "error", "-i", final.finalVideoPath, "-i", sourcePath, "-filter_complex", "[0:v]crop=80:24:40:18[a];[1:v]crop=80:24:40:18[b];[a][b]ssim=stats_file=-", "-frames:v", "18", "-f", "null", "-"], { maxBuffer: 10 * 1024 * 1024 });
    const omissionSsim = Number((`${omission.stdout}\n${omission.stderr}`.match(/All:([0-9.]+)/)?.[1] ?? "1"));
    // The anonymous testsrc makes the caption only a few pixels at this
    // fixture scale, so the caption ROI is intentionally tight. 0.99999 is
    // above the measured untreated-source control (0.999948 here) while
    // remaining far below an exact/omitted ROI match of 1.0.
    expect(omissionSsim).toBeLessThan(0.99999);
    expect(fs.existsSync(`${preview.outputPath}.caption-visual-treatment-input.json`)).toBe(true);
  }, 120_000);
});
