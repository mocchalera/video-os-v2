#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { evaluatePlaybackContract } from "../runtime/preview/playback-contract.js";
import {
  computePackagingProjectionHash,
  computeSha256,
} from "../runtime/packaging/manifest.js";
import { verifyExistingPackage } from "../runtime/packaging/package-verification.js";
import { createSourceInputAttestation } from "../runtime/render/source-input-attestation.js";
import { computeFileHash } from "../runtime/state/reconcile.js";
import { buildPackagePreflight } from "./package.js";

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

function preflightCases(): Array<FileCase> {
  const ready = gate10BaseFiles();
  const missingApproval = { ...ready };
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

  const staleCaption = { ...ready };
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

  return [
    { id: "ready_engine_render", files: ready },
    { id: "missing_approval", files: missingApproval },
    { id: "stale_caption_approval", files: staleCaption },
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
    provenance: { editorial_timeline_hash: "pending" },
  };
}

function canonicalPackageFiles(): Record<string, string> {
  const files: Record<string, string> = {
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
      };
    };
    manifest.artifacts.final_video.sha256 = computeSha256(path.join(root, "09_output/final.mp4"));
    manifest.artifacts.qa_report.sha256 = computeSha256(path.join(root, "07_package/qa-report.json"));
    manifest.provenance.editorial_timeline_hash = computeFileHash(path.join(root, "05_timeline/timeline.json"));
    const sourceInputs = createSourceInputAttestation(root);
    manifest.provenance.source_inputs_hash = sourceInputs.source_inputs_hash;
    manifest.provenance.source_inputs_attestation_status = sourceInputs.status;
    rebound["07_package/package_manifest.json"] = jsonText(manifest);
    return rebound;
  });
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
  const stateUnknownProperty = structuredClone(valid);
  const state = parseYaml(stateUnknownProperty["project_state.yaml"]) as Record<string, unknown>;
  state.unexpected = true;
  stateUnknownProperty["project_state.yaml"] = stringifyYaml(state);

  return [
    { id: "valid", files: valid },
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
    { id: "state_unknown_property", files: stateUnknownProperty },
  ];
}

export function buildMacOSStudioContractFixture(): object {
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
    preflightCases: preflightCases().map((testCase) => {
      const preflight = withMaterializedCase(testCase, (root) => buildPackagePreflight(root));
      return {
        ...testCase,
        expected: {
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
