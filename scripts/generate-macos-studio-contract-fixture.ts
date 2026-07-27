#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { evaluatePlaybackContract } from "../runtime/preview/playback-contract.js";
import {
  computePackagingProjectionHash,
  computeSha256,
} from "../runtime/packaging/manifest.js";
import { verifyExistingPackage } from "../runtime/packaging/package-verification.js";
import { createSourceInputAttestation } from "../runtime/render/source-input-attestation.js";
import { computeFileHash } from "../runtime/state/reconcile.js";
import { resolveProjectRenderRoute } from "../runtime/render/route-resolver.js";
import { captionFontContractForReceipt } from "../runtime/caption/font-contract.js";
import { HYPERFRAMES_RENDERER_VERSION } from "../runtime/content/hyperframes-renderer.js";
import { REMOTION_RENDERER_VERSION } from "../runtime/render/remotion/render-remotion.js";
import { buildPackagePreflight } from "./package.js";
import {
  approveFinalRenderChecklist,
  FINAL_RENDER_APPROVAL_RELATIVE_PATH,
} from "../runtime/packaging/final-render-approval.js";

export const MACOS_STUDIO_CONTRACT_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../apps/macos-studio/Tests/VideoOSStudioCoreTests/Fixtures/macos-studio-contract-v1.json",
);

interface FileCase {
  id: string;
  files: Record<string, string>;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, "utf8");
  }
}

function withMaterializedCase<T>(testCase: FileCase, evaluate: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "macos-studio-contract-"));
  try {
    writeFiles(root, testCase.files);
    return evaluate(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function playbackCases(): Array<FileCase> {
  const timelineV1 = jsonText({ version: "1", project_id: "studio-contract" });
  const timelineV2 = jsonText({ version: "2", project_id: "studio-contract" });
  const hash = withMaterializedCase({
    id: "hash",
    files: { "05_timeline/timeline.json": timelineV1 },
  }, (root) => evaluatePlaybackContract(root).timeline_hash);
  return [
    { id: "missing_timeline", files: {} },
    { id: "missing_manifest", files: { "05_timeline/timeline.json": timelineV1 } },
    {
      id: "legacy_manifest",
      files: {
        "05_timeline/timeline.json": timelineV1,
        "05_timeline/preview-manifest.json": jsonText({ version: "1" }),
      },
    },
    {
      id: "exact",
      files: {
        "05_timeline/timeline.json": timelineV1,
        "05_timeline/preview-manifest.json": jsonText({ version: "1", base_timeline_hash: hash }),
      },
    },
    {
      id: "stale",
      files: {
        "05_timeline/timeline.json": timelineV2,
        "05_timeline/preview-manifest.json": jsonText({ version: "1", base_timeline_hash: hash }),
      },
    },
  ];
}

function gate10BaseFiles(): Record<string, string> {
  return {
    "01_intent/creative_brief.yaml": stringifyYaml({
      version: "1",
      project_id: "studio-contract",
      project: { id: "studio-contract", title: "Studio Contract", runtime_target_sec: 10 },
      autonomy: { mode: "full", may_decide: ["render"], must_ask: [] },
    }),
    "04_plan/edit_blueprint.yaml": stringifyYaml({
      version: "1",
      project_id: "studio-contract",
      caption_policy: { source: "none", delivery_mode: "both" },
    }),
    "05_timeline/timeline.json": jsonText({
      version: "timeline-v2",
      project_id: "studio-contract",
      sequence: {
        name: "Studio Contract",
        fps_num: 30,
        fps_den: 1,
        width: 1920,
        height: 1080,
        start_frame: 0,
      },
      tracks: {
        video: [],
        audio: [{
          track_id: "A1",
          kind: "audio",
          clips: [{
            clip_id: "audio-1",
            segment_id: "segment-1",
            asset_id: "asset-1",
            src_in_us: 0,
            src_out_us: 10_000_000,
            timeline_in_frame: 0,
            timeline_duration_frames: 300,
            role: "dialogue",
            motivation: "Exercise the audio-only Gate 10 exemption.",
            media_kind: "audio",
            source_capabilities: { has_video: false, has_audio: true },
            audio_role: "dialogue",
          }],
        }],
      },
      markers: [],
      provenance: {
        brief_path: "01_intent/creative_brief.yaml",
        blueprint_path: "04_plan/edit_blueprint.yaml",
        selects_path: "03_selects/selects.yaml",
        compiler_version: "studio-contract-fixture",
      },
    }),
    "06_review/review_report.yaml": stringifyYaml({
      version: "1",
      project_id: "studio-contract",
      timeline_version: "timeline-v2",
      summary_judgment: {
        status: "approved",
        rationale: "Fixture is ready for packaging.",
      },
      strengths: [],
      weaknesses: [],
      fatal_issues: [],
      warnings: [],
      mismatches_to_brief: [],
      mismatches_to_blueprint: [],
      recommended_next_pass: {
        goal: "Package the approved timeline.",
        actions: ["Run the package preflight."],
      },
      visual_qa: {
        status: "not_applicable",
        reason: "audio_only_timeline",
        min_score: 70,
        issues: { total: 0, critical: 0, warning: 0, info: 0 },
        issue_summaries: [],
      },
    }),
    "project_state.yaml": stringifyYaml({
      version: 1,
      project_id: "studio-contract",
      current_state: "approved",
      approval_record: { status: "clean" },
      handoff_resolution: {
        handoff_id: "HND_studio_contract",
        status: "decided",
        source_of_truth_decision: "engine_render",
      },
      gates: { review_gate: "open" },
    }),
  };
}

function withFinalRenderApproval(files: Record<string, string>): Record<string, string> {
  const approved = structuredClone(files);
  return withMaterializedCase({ id: "final-render-approval", files: approved }, (root) => {
    approveFinalRenderChecklist(root, {
      approvedBy: "fixture-operator",
      approvedAt: "2026-07-23T00:00:00Z",
      checklist: {
        captions: "not_applicable",
        caption_typography: "not_applicable",
        section_titles: "not_applicable",
        audio: {
          decision: "preserve",
          preview_reviewed: false,
          bgm: "none",
        },
        output_spec: "approved",
      },
    });
    approved[FINAL_RENDER_APPROVAL_RELATIVE_PATH] = fs.readFileSync(
      path.join(root, FINAL_RENDER_APPROVAL_RELATIVE_PATH),
      "utf8",
    );
    return approved;
  });
}

function preflightCases(): Array<FileCase> {
  const base = withFinalRenderApproval(gate10BaseFiles());
  const ready = structuredClone(base);
  ready["07_package/qa-report.json"] = jsonText({ project_id: "studio-contract" });
  ready["07_package/package_manifest.json"] = jsonText({ project_id: "studio-contract" });

  const emptyIdentity = structuredClone(base);
  const emptyIdentityState = parseYaml(emptyIdentity["project_state.yaml"]) as Record<string, unknown>;
  emptyIdentityState.project_id = "";
  emptyIdentity["project_state.yaml"] = stringifyYaml(emptyIdentityState);

  const identityMismatch = structuredClone(ready);
  identityMismatch["07_package/package_manifest.json"] = jsonText({ project_id: "other-project" });

  const malformedIdentityArtifact = structuredClone(ready);
  malformedIdentityArtifact["07_package/qa-report.json"] = "{not-json\n";

  const missingApproval = { ...base };
  const stateWithoutApproval = JSON.parse(JSON.stringify({
    version: 1,
    project_id: "studio-contract",
    current_state: "approved",
    handoff_resolution: {
      handoff_id: "HND_studio_contract",
      status: "decided",
      source_of_truth_decision: "engine_render",
    },
    gates: { review_gate: "open" },
  }));
  missingApproval["project_state.yaml"] = stringifyYaml(stateWithoutApproval);

  const staleCaption = structuredClone(base);
  staleCaption["04_plan/edit_blueprint.yaml"] = stringifyYaml({
    version: "1",
    project_id: "studio-contract",
    caption_policy: { source: "transcript", delivery_mode: "both" },
  });
  staleCaption["07_package/caption_approval.json"] = jsonText({
    version: "1",
    project_id: "studio-contract",
    base_timeline_version: "timeline-v1",
    approval: { status: "approved" },
  });
  const staleCaptionWithApproval = withFinalRenderApproval(staleCaption);

  const missingFinalRenderApproval = structuredClone(base);
  delete missingFinalRenderApproval[FINAL_RENDER_APPROVAL_RELATIVE_PATH];

  return [
    { id: "ready_engine_render", files: ready },
    { id: "empty_id_inferred", files: emptyIdentity },
    { id: "project_id_mismatch", files: identityMismatch },
    { id: "malformed_identity_artifact", files: malformedIdentityArtifact },
    { id: "missing_approval", files: missingApproval },
    { id: "stale_caption_approval", files: staleCaptionWithApproval },
    { id: "missing_final_render_approval", files: missingFinalRenderApproval },
  ];
}

function buildPreflightProcessCases(cases: FileCase[]): Array<{
  id: string;
  files: Record<string, string>;
  exitCode: number;
  stdout: string;
  expected: { available: boolean; canPackage: boolean; failureLabel?: string };
}> {
  const responses = new Map(cases.map((testCase) => [
    testCase.id,
    withMaterializedCase(testCase, (root) => ({
      files: testCase.files,
      preflight: normalizeFixturePaths(buildPackagePreflight(root), root),
    })),
  ]));
  const ready = responses.get("ready_engine_render");
  const empty = responses.get("empty_id_inferred");
  const mismatch = responses.get("project_id_mismatch");
  if (!ready || !empty || !mismatch) {
    throw new Error("required package preflight process fixtures are missing");
  }
  return [
    {
      id: "normal",
      files: ready.files,
      exitCode: 0,
      stdout: jsonText(ready.preflight),
      expected: { available: true, canPackage: true },
    },
    {
      id: "empty_id_inferred",
      files: empty.files,
      exitCode: 0,
      stdout: jsonText(empty.preflight),
      expected: { available: true, canPackage: true },
    },
    {
      id: "project_id_mismatch",
      files: mismatch.files,
      exitCode: 1,
      stdout: jsonText(mismatch.preflight),
      expected: {
        available: true,
        canPackage: false,
        failureLabel: (mismatch.preflight as { issues: string[] }).issues[0],
      },
    },
    {
      id: "malformed_json",
      files: ready.files,
      exitCode: 1,
      stdout: "{not-json\n",
      expected: {
        available: false,
        canPackage: false,
        failureLabel: "package preflight unavailable",
      },
    },
    {
      id: "exit_json_contradiction",
      files: ready.files,
      exitCode: 1,
      stdout: jsonText(ready.preflight),
      expected: {
        available: false,
        canPackage: false,
        failureLabel: "package preflight unavailable",
      },
    },
  ];
}

function validQAReport(): Record<string, unknown> {
  return {
    version: "1",
    project_id: "studio-contract",
    source_of_truth: "engine_render",
    qa_profile: "engine_render",
    passed: true,
    checks: [{ name: "timeline_schema_valid", passed: true, details: "ok" }],
  };
}

function validManifest(): Record<string, unknown> {
  return {
    version: "package-v1",
    project_id: "studio-contract",
    source_of_truth: "engine_render",
    base_timeline_version: "timeline-v2",
    packaging_projection_hash: computePackagingProjectionHash({}),
    created_at: "2026-07-22T00:00:00Z",
    artifacts: {
      final_video: { path: "09_output/final.mp4", sha256: "pending" },
      qa_report: { path: "07_package/qa-report.json", sha256: "pending" },
    },
    provenance: { editorial_timeline_hash: "pending", render: "pending" },
  };
}

function canonicalPackageFiles(): Record<string, string> {
  const gateFiles = gate10BaseFiles();
  const files: Record<string, string> = {
    "01_intent/creative_brief.yaml": gateFiles["01_intent/creative_brief.yaml"],
    "04_plan/edit_blueprint.yaml": gateFiles["04_plan/edit_blueprint.yaml"],
    "05_timeline/timeline.json": gate10BaseFiles()["05_timeline/timeline.json"],
    "00_sources/fixture-audio.wav": "fixture-audio",
    "02_media/fixture-audio.wav": "fixture-audio",
    "02_media/source_map.json": jsonText({
      version: "1",
      project_id: "studio-contract",
      media_dir: "02_media",
      generated_at: "2026-07-22T00:00:00Z",
      items: [{
        asset_id: "asset-1",
        source_locator: "00_sources/fixture-audio.wav",
        local_source_path: "02_media/fixture-audio.wav",
        link_path: "02_media/fixture-audio.wav",
        media_kind: "audio",
      }],
    }),
    "07_package/qa-report.json": jsonText(validQAReport()),
    "07_package/package_manifest.json": jsonText(validManifest()),
    "07_package/logs/render-route.json": jsonText({ pending: true }),
    "09_output/final.mp4": "fixture-video",
    "project_state.yaml": stringifyYaml({
      version: 1,
      project_id: "studio-contract",
      current_state: "packaged",
      handoff_resolution: {
        handoff_id: "HND_studio_contract",
        status: "decided",
        source_of_truth_decision: "engine_render",
      },
    }),
  };
  return rebindPackageHashes(files);
}

function rebindPackageHashes(files: Record<string, string>): Record<string, string> {
  const rebound = structuredClone(files);
  return withMaterializedCase({ id: "rebind", files: rebound }, (root) => {
    const manifest = JSON.parse(rebound["07_package/package_manifest.json"]) as ReturnType<typeof validManifest> & {
      artifacts: {
        final_video: { path: string; sha256: string };
        qa_report: { path: string; sha256: string };
      };
      provenance: {
        editorial_timeline_hash: string;
        source_inputs_hash?: string;
        source_inputs_attestation_status?: string;
        render?: unknown;
      };
    };
    manifest.artifacts.final_video.sha256 = computeSha256(path.join(root, "09_output/final.mp4"));
    manifest.artifacts.qa_report.sha256 = computeSha256(path.join(root, "07_package/qa-report.json"));
    manifest.provenance.editorial_timeline_hash = computeFileHash(path.join(root, "05_timeline/timeline.json"));
    const route = resolveProjectRenderRoute(root);
    const ffmpegVersion = execFileSync("ffmpeg", ["-version"], {
      encoding: "utf8",
    }).split(/\r?\n/, 1)[0].trim();
    const timelineSha256 = computeSha256(path.join(root, "05_timeline/timeline.json"));
    const finalSha256 = computeSha256(path.join(root, "09_output/final.mp4"));
    const blueprint = parseYaml(
      rebound["04_plan/edit_blueprint.yaml"],
    ) as { caption_policy?: { styling_class?: string } };
    let fontReceipt: { path: string; sha256: string } | undefined;
    if (route.caption_layer.engine === "ffmpeg-libass") {
      const fontReceiptPath = "07_package/logs/caption-font-receipt.json";
      const stylingClass = blueprint.caption_policy?.styling_class ?? "";
      rebound[fontReceiptPath] = jsonText({
        version: "caption-font-receipt/v1",
        styling_class: stylingClass,
        contract: captionFontContractForReceipt(stylingClass),
      });
      fs.writeFileSync(path.join(root, fontReceiptPath), rebound[fontReceiptPath]);
      fontReceipt = {
        path: fontReceiptPath,
        sha256: computeSha256(path.join(root, fontReceiptPath)),
      };
    }
    const operations = [
      { id: "base_assembly", kind: "lossy_video_generation", codec: "h264" },
      ...(route.delivery.lossy_video_encode_passes > 1
        ? [{ id: "final_visual_composite", kind: "lossy_video_generation", codec: "h264" }]
        : []),
      { id: "final_video_materialize", kind: "stream_copy", codec: "h264" },
    ];
    const receipt = {
      ...route,
      receipt_version: "render-route-receipt/v3",
      renderer_versions: {
        ffmpeg: ffmpegVersion,
        ...(route.visual_layers.some((layer) => layer.renderer === "hyperframes")
          ? { hyperframes: HYPERFRAMES_RENDERER_VERSION }
          : {}),
        ...(route.base_engine === "remotion"
          || route.visual_layers.some((layer) => layer.renderer === "remotion")
          ? { remotion: REMOTION_RENDERER_VERSION }
          : {}),
      },
      inputs: {
        timeline: {
          path: "05_timeline/timeline.json",
          sha256: timelineSha256,
        },
      },
      outputs: {
        final_video: {
          path: "09_output/final.mp4",
          sha256: finalSha256,
        },
      },
      layer_receipts: [],
      ...(fontReceipt ? { font_receipt: fontReceipt } : {}),
      delivery_execution: {
        definition: "sequential_h264_generations/v1",
        measurement_source: "execution_plan",
        lossy_video_encode_passes: route.delivery.lossy_video_encode_passes,
        operations,
      },
      base_assembly_path: "09_output/final.mp4",
      effective_assembly_path: "09_output/final.mp4",
    };
    rebound["07_package/logs/render-route.json"] = jsonText(receipt);
    fs.writeFileSync(
      path.join(root, "07_package/logs/render-route.json"),
      rebound["07_package/logs/render-route.json"],
    );
    const renderSummary = {
      contract_version: "render-provenance/v1",
      route_receipt: {
        path: "07_package/logs/render-route.json",
        sha256: computeSha256(path.join(root, "07_package/logs/render-route.json")),
      },
      renderer_versions: receipt.renderer_versions,
      layer_receipts: receipt.layer_receipts,
      ...(receipt.font_receipt ? { font_receipt: receipt.font_receipt } : {}),
      delivery_execution: receipt.delivery_execution,
      inputs: receipt.inputs,
      outputs: receipt.outputs,
    };
    manifest.provenance.render = renderSummary;
    const sourceInputs = createSourceInputAttestation(root);
    manifest.provenance.source_inputs_hash = sourceInputs.source_inputs_hash;
    manifest.provenance.source_inputs_attestation_status = sourceInputs.status;
    rebound["07_package/package_manifest.json"] = jsonText(manifest);
    return rebound;
  });
}

function mutateRenderReceipt(
  files: Record<string, string>,
  mutate: (receipt: Record<string, unknown>) => void,
): Record<string, string> {
  const mutated = structuredClone(files);
  const receiptPath = "07_package/logs/render-route.json";
  const receipt = JSON.parse(mutated[receiptPath]) as Record<string, unknown>;
  mutate(receipt);
  mutated[receiptPath] = jsonText(receipt);
  const manifest = JSON.parse(mutated["07_package/package_manifest.json"]) as {
    provenance: { render: Record<string, unknown> };
  };
  const render = manifest.provenance.render;
  render.route_receipt = {
    path: receiptPath,
    sha256: `sha256:${createHash("sha256").update(mutated[receiptPath]).digest("hex")}`,
  };
  for (const key of [
    "renderer_versions",
    "layer_receipts",
    "font_receipt",
    "delivery_execution",
    "inputs",
    "outputs",
  ]) {
    if (key in receipt) render[key] = receipt[key];
    else delete render[key];
  }
  mutated["07_package/package_manifest.json"] = jsonText(manifest);
  return mutated;
}

function mutateJson(
  files: Record<string, string>,
  relativePath: string,
  mutate: (value: Record<string, unknown>) => void,
  rebind = true,
): Record<string, string> {
  const mutated = structuredClone(files);
  const value = JSON.parse(mutated[relativePath]) as Record<string, unknown>;
  mutate(value);
  mutated[relativePath] = jsonText(value);
  return rebind ? rebindPackageHashes(mutated) : mutated;
}

function packageCases(): FileCase[] {
  const valid = canonicalPackageFiles();
  const captionedInput = structuredClone(valid);
  const captionedBlueprint = parseYaml(
    captionedInput["04_plan/edit_blueprint.yaml"],
  ) as Record<string, unknown> & {
    caption_policy: Record<string, unknown>;
  };
  captionedBlueprint.caption_policy = {
    source: "authored",
    delivery_mode: "both",
    styling_class: "clean-lower-third",
  };
  captionedInput["04_plan/edit_blueprint.yaml"] = stringifyYaml(captionedBlueprint);
  const validCaptioned = rebindPackageHashes(captionedInput);
  const fontReceiptMissing = mutateRenderReceipt(validCaptioned, (receipt) => {
    delete receipt.font_receipt;
  });
  const fontReceiptTampered = structuredClone(validCaptioned);
  const fontReceiptPath = "07_package/logs/caption-font-receipt.json";
  const tamperedFontReceipt = JSON.parse(fontReceiptTampered[fontReceiptPath]) as {
    contract: { selected_family?: string };
  };
  tamperedFontReceipt.contract.selected_family = "Tampered Font";
  fontReceiptTampered[fontReceiptPath] = jsonText(tamperedFontReceipt);
  const layerReceiptMissingInput = structuredClone(valid);
  const layerTimeline = JSON.parse(
    layerReceiptMissingInput["05_timeline/timeline.json"],
  ) as { tracks: Record<string, unknown> };
  layerTimeline.tracks.overlay = [{
    track_id: "O1",
    kind: "overlay",
    clips: [{
      clip_id: "HF_MISSING",
      segment_id: "SEG_HF_MISSING",
      asset_id: "asset-1",
      src_in_us: 0,
      src_out_us: 1_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 30,
      role: "overlay",
      motivation: "Exercise missing layer receipt verification.",
      metadata: {
        content_element: {
          version: "content-element/v1",
          element_id: "HF_MISSING",
          kind: "template",
          template_ref: "vos:content.section-label/v1",
          template_version: "1.0.0",
          props: { title: "Missing receipt" },
          layout: {
            anchor: "top_left",
            x: 0,
            y: 0,
            scale: 1,
            rotation_deg: 0,
            opacity: 1,
            safe_area: true,
            z_index: 100,
          },
        },
      },
    }],
  }];
  layerReceiptMissingInput["05_timeline/timeline.json"] = jsonText(layerTimeline);
  const layerReceiptMissing = rebindPackageHashes(layerReceiptMissingInput);
  const qaMissingDetails = mutateJson(valid, "07_package/qa-report.json", (qa) => {
    delete (qa.checks as Array<Record<string, unknown>>)[0].details;
  });
  const qaUnknownProperty = mutateJson(valid, "07_package/qa-report.json", (qa) => {
    qa.unexpected = true;
  });
  const manifestMissingProvenance = mutateJson(valid, "07_package/package_manifest.json", (manifest) => {
    delete manifest.provenance;
  }, false);
  const manifestUnknownProperty = mutateJson(valid, "07_package/package_manifest.json", (manifest) => {
    (manifest.artifacts as Record<string, unknown>).unexpected = true;
  }, false);
  const qaProfileMismatch = mutateJson(valid, "07_package/qa-report.json", (qa) => {
    qa.qa_profile = "nle_finishing";
  });
  const projectMismatch = mutateJson(valid, "07_package/package_manifest.json", (manifest) => {
    manifest.project_id = "other-project";
  }, false);
  const sourceMismatch = mutateJson(valid, "07_package/package_manifest.json", (manifest) => {
    manifest.source_of_truth = "nle_finishing";
  }, false);
  const finalHashMismatch = mutateJson(valid, "07_package/package_manifest.json", (manifest) => {
    ((manifest.artifacts as Record<string, unknown>).final_video as Record<string, unknown>).sha256 = "sha256:stale";
  }, false);
  const qaHashMismatch = mutateJson(valid, "07_package/package_manifest.json", (manifest) => {
    ((manifest.artifacts as Record<string, unknown>).qa_report as Record<string, unknown>).sha256 = "sha256:stale";
  }, false);
  const timelineHashMismatch = mutateJson(valid, "07_package/package_manifest.json", (manifest) => {
    (manifest.provenance as Record<string, unknown>).editorial_timeline_hash = "stale";
  }, false);
  const projectionMismatch = mutateJson(valid, "07_package/package_manifest.json", (manifest) => {
    manifest.packaging_projection_hash = "stale";
  }, false);
  const projectionInputChanged = structuredClone(valid);
  projectionInputChanged["07_package/caption_approval.json"] = jsonText({
    version: "1",
    project_id: "studio-contract",
    base_timeline_version: "timeline-v2",
    approval: { status: "approved" },
  });
  const qaAggregateContradiction = mutateJson(valid, "07_package/qa-report.json", (qa) => {
    (qa.checks as Array<Record<string, unknown>>)[0].passed = false;
  });
  const qaEmptyChecks = mutateJson(valid, "07_package/qa-report.json", (qa) => {
    qa.checks = [];
  });
  const timelineVersionMismatch = mutateJson(valid, "07_package/package_manifest.json", (manifest) => {
    manifest.base_timeline_version = "timeline-v1";
  }, false);
  const sourceInputsMissing = mutateJson(valid, "07_package/package_manifest.json", (manifest) => {
    const provenance = manifest.provenance as Record<string, unknown>;
    delete provenance.source_inputs_hash;
    delete provenance.source_inputs_attestation_status;
  }, false);
  const renderReceiptTampered = structuredClone(valid);
  const tamperedRoute = JSON.parse(renderReceiptTampered["07_package/logs/render-route.json"]);
  tamperedRoute.genre = "cinematic";
  renderReceiptTampered["07_package/logs/render-route.json"] = jsonText(tamperedRoute);
  const renderRouteDrift = mutateRenderReceipt(valid, (receipt) => {
    receipt.genre = "cinematic";
  });
  const rendererVersionDrift = mutateRenderReceipt(valid, (receipt) => {
    (receipt.renderer_versions as Record<string, unknown>).ffmpeg = "ffmpeg forged";
  });
  const encodePassDrift = mutateRenderReceipt(valid, (receipt) => {
    (receipt.delivery_execution as Record<string, unknown>).lossy_video_encode_passes = 2;
  });
  const stateUnknownProperty = structuredClone(valid);
  const state = parseYaml(stateUnknownProperty["project_state.yaml"]) as Record<string, unknown>;
  state.unexpected = true;
  stateUnknownProperty["project_state.yaml"] = stringifyYaml(state);

  return [
    { id: "valid", files: valid },
    { id: "valid_captioned", files: validCaptioned },
    { id: "qa_missing_details", files: qaMissingDetails },
    { id: "qa_unknown_property", files: qaUnknownProperty },
    { id: "manifest_missing_provenance", files: manifestMissingProvenance },
    { id: "manifest_unknown_property", files: manifestUnknownProperty },
    { id: "qa_profile_mismatch", files: qaProfileMismatch },
    { id: "project_id_mismatch", files: projectMismatch },
    { id: "source_of_truth_mismatch", files: sourceMismatch },
    { id: "final_hash_mismatch", files: finalHashMismatch },
    { id: "qa_hash_mismatch", files: qaHashMismatch },
    { id: "timeline_hash_mismatch", files: timelineHashMismatch },
    { id: "packaging_projection_mismatch", files: projectionMismatch },
    { id: "packaging_projection_input_changed", files: projectionInputChanged },
    { id: "qa_passed_with_failed_check", files: qaAggregateContradiction },
    { id: "qa_empty_checks", files: qaEmptyChecks },
    { id: "timeline_version_mismatch", files: timelineVersionMismatch },
    { id: "source_inputs_provenance_missing", files: sourceInputsMissing },
    { id: "render_route_receipt_tampered", files: renderReceiptTampered },
    { id: "render_route_drift", files: renderRouteDrift },
    { id: "renderer_version_drift", files: rendererVersionDrift },
    { id: "encode_pass_drift", files: encodePassDrift },
    { id: "font_receipt_missing", files: fontReceiptMissing },
    { id: "font_receipt_tampered", files: fontReceiptTampered },
    { id: "layer_receipt_missing", files: layerReceiptMissing },
    { id: "state_unknown_property", files: stateUnknownProperty },
  ];
}

export function buildMacOSStudioContractFixture(): object {
  const packagePreflightCases = preflightCases();
  return {
    artifactVersion: "macos-studio-contract/v1",
    generatedFrom: [
      "runtime/preview/playback-contract.ts",
      "scripts/package.ts#buildPackagePreflight",
      "runtime/packaging/package-verification.ts",
    ],
    playbackCases: playbackCases().map((testCase) => ({
      ...testCase,
      expected: withMaterializedCase(testCase, evaluatePlaybackContract),
    })),
    preflightCases: packagePreflightCases.map((testCase) => {
      const preflight = withMaterializedCase(testCase, (root) => buildPackagePreflight(root));
      return {
        ...testCase,
        expected: {
          version: preflight.version,
          decision: preflight.decision,
          project_identity: preflight.project_identity,
          structured_issues: preflight.structured_issues,
          next_action: preflight.next_action,
          ok: preflight.ok,
          issues: preflight.issues,
          nextSteps: preflight.nextSteps,
          sourceOfTruth: preflight.sourceOfTruth,
          autonomyMode: preflight.autonomyMode,
          projectId: preflight.projectId,
          currentState: preflight.currentState,
          visualQaSummary: preflight.visualQaSummary,
        },
      };
    }),
    preflightProcessCases: buildPreflightProcessCases(packagePreflightCases),
    packageCases: packageCases().map((testCase) => ({
      ...testCase,
      expected: withMaterializedCase(testCase, (root) => (
        normalizeFixturePaths(verifyExistingPackage(root), root)
      )),
    })),
  };
}

function normalizeFixturePaths<T>(value: T, projectDir: string): T {
  if (typeof value === "string") {
    return value.replaceAll(projectDir, "$PROJECT_DIR") as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeFixturePaths(item, projectDir)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeFixturePaths(item, projectDir)]),
    ) as T;
  }
  return value;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function serializeMacOSStudioContractFixture(): string {
  return jsonText(buildMacOSStudioContractFixture());
}

export function main(argv: string[] = process.argv): number {
  const expected = serializeMacOSStudioContractFixture();
  if (argv.includes("--check")) {
    const actual = fs.existsSync(MACOS_STUDIO_CONTRACT_FIXTURE_PATH)
      ? fs.readFileSync(MACOS_STUDIO_CONTRACT_FIXTURE_PATH, "utf8")
      : "";
    if (actual === expected) {
      console.log(`macOS Studio contracts are current: ${MACOS_STUDIO_CONTRACT_FIXTURE_PATH}`);
      return 0;
    }
    console.error(`macOS Studio contracts are stale: ${MACOS_STUDIO_CONTRACT_FIXTURE_PATH}`);
    return 1;
  }
  fs.mkdirSync(path.dirname(MACOS_STUDIO_CONTRACT_FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(MACOS_STUDIO_CONTRACT_FIXTURE_PATH, expected, "utf8");
  console.log(`Generated ${MACOS_STUDIO_CONTRACT_FIXTURE_PATH}`);
  return 0;
}

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) process.exitCode = main();
