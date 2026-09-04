import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  assertGenerationInputsUnchanged,
  bindGenerationArtifact,
  buildReviewReadyReceipt,
  captureSocialReviewGeneration,
  prepareImmutableGeneration,
  promoteLatestGeneration,
  verifyLatestGeneration,
  verifyReviewReadyReceipt,
  writeReviewReadyReceipt,
  type SocialReviewGenerationInput,
  type SocialReviewGenerationReceipt,
  type SocialReviewQA,
} from "../runtime/review/social-review-generation.js";
import { evaluateDeterministicLayoutQA } from "../runtime/review/deterministic-layout-qa.js";
import {
  parseSubjectOccupancyTrack,
  subjectOccupancyPayloadHash,
} from "../runtime/review/subject-occupancy.js";
import {
  parseVerticalCompositionPolicy,
  verticalCompositionPolicyContentHash,
} from "../runtime/visual/vertical-composition.js";
import {
  buildReencodeGeneration,
  verifyReencodeGeneration,
} from "../runtime/review/reencode-generation.js";
import {
  createVerifiedCollisionLayoutEvidence,
  socialReviewCollisionInputHashes,
} from "./helpers/social-review-collision-evidence.js";
import {
  audioReportFromReceipt,
  buildSocialReviewAudioReceipt,
  deriveSocialReviewAudioPlanIdentity,
  type SocialReviewAudioReceipt,
} from "../runtime/review/social-review-audio.js";
import { hashAudioRenderPlan, type AudioRenderPlan } from "../runtime/audio/render-plan.js";
import { deriveSocialReviewGenerationAudioPlanHash } from "../scripts/render-social-review.js";
import { writeCanonicalSocialReviewAudioPlan } from "./helpers/social-review-audio-plan.js";
import {
  writeReviewAudioIdentityMedia,
  type ReviewAudioMismatchKind,
} from "./helpers/social-review-audio-media.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function hash(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function fixture() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-generation-"));
  roots.push(projectDir);
  for (const relative of ["05_timeline", "06_review", "09_output"]) {
    fs.mkdirSync(path.join(projectDir, relative), { recursive: true });
  }
  const files = {
    timeline: "05_timeline/timeline.json",
    patch: "06_review/review_patch.json",
    mapping: "05_timeline/derived-frame-mapping.json",
    identity: "05_timeline/review-edit-identity.json",
    captions: "06_review/captions.json",
  };
  fs.writeFileSync(path.join(projectDir, files.timeline), "timeline-v1\n");
  fs.writeFileSync(path.join(projectDir, files.patch), "patch-v2\n");
  fs.writeFileSync(path.join(projectDir, files.mapping), "mapping-v1\n");
  fs.writeFileSync(path.join(projectDir, files.identity), "identity-v1\n");
  fs.writeFileSync(path.join(projectDir, files.captions), "captions-v1\n");
  const base = {
    projectDir,
    projectId: "p1",
    canonicalTimelineHash: hash("a"),
    acceptedPatchHash: hash("b"),
    derivedMappingReceiptHash: hash("c"),
    reviewTimelineHash: hash("d"),
    captionTextTimingHash: hash("e"),
    visualTreatmentHash: hash("f"),
    contentPlanHash: hash("1"),
    audioPlanHash: deriveSocialReviewAudioPlanIdentity({
      state: "not_applicable",
      sharedAudioPlanHash: null,
      policy: { loudness_target_lufs: -16, lra_target: 7, true_peak_target_dbtp: -1.5 },
    }),
    rendererCapabilityHash: hash("3"),
    ...socialReviewCollisionInputHashes(),
    sourceInputAttestation: { version: "source-input-attestation/test", source_inputs_hash: hash("7") },
    files: Object.values(files),
  };
  return { projectDir, files, base };
}

function verifiedQa(
  generation: ReturnType<typeof captureSocialReviewGeneration>,
  audioPolicy = { loudness_target_lufs: -16, lra_target: 7, true_peak_target_dbtp: -1.5 },
) {
  const audioPath = path.join(generation.generation_dir, "audio-mastering-receipt.json");
  const layerPath = path.join(generation.generation_dir, "work", "layers", "layer-receipt.json");
  fs.mkdirSync(path.dirname(layerPath), { recursive: true });
  const audioReceipt = buildSocialReviewAudioReceipt({
    state: "not_applicable",
    reason: "review_video_has_no_audio_stream",
    generationId: generation.generation_id,
    projectDir: generation.project_dir,
    reviewVideoPath: generation.output_path,
    policy: audioPolicy,
  });
  fs.writeFileSync(audioPath, `${JSON.stringify(audioReceipt, null, 2)}\n`, { flag: "wx" });
  fs.writeFileSync(layerPath, "layer-evidence\n", { flag: "wx" });
  const collisionEvidence = createVerifiedCollisionLayoutEvidence(generation);
  return {
    output: {
      status: "verified" as const,
      issues: [],
      scans: {
        decode: { status: "complete" as const },
        black: { status: "complete" as const, detections: [] },
        freeze: { status: "complete" as const, detections: [] },
        layout_inset: { status: "complete" as const, detections: [] },
      },
    },
    ...collisionEvidence,
    audio: {
      status: "verified" as const,
      evidence: { path: path.relative(generation.project_dir, audioPath), sha256: hashFile(audioPath) },
    },
    layers: {
      status: "verified" as const,
      evidence: [{ path: path.relative(generation.project_dir, layerPath), sha256: hashFile(layerPath) }],
    },
  };
}

function hashFile(filePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function writeNoAudioOutput(generation: ReturnType<typeof captureSocialReviewGeneration>, bytes: string) {
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=0.2",
    "-metadata", `comment=${bytes}`, "-c:v", "libx264", "-an", generation.output_path,
  ]);
}

function claimWithOutput(generation: ReturnType<typeof captureSocialReviewGeneration>, bytes = "mp4-v1") {
  expect(prepareImmutableGeneration(generation).status).toBe("owner");
  writeNoAudioOutput(generation, bytes);
}

function renderReport(generation: ReturnType<typeof captureSocialReviewGeneration>): string {
  const reportPath = path.join(generation.generation_dir, "social-review-report.json");
  if (!fs.existsSync(reportPath)) {
    const audioReceipt = JSON.parse(fs.readFileSync(
      path.join(generation.generation_dir, "audio-mastering-receipt.json"),
      "utf8",
    )) as SocialReviewAudioReceipt;
    fs.writeFileSync(reportPath, JSON.stringify({
      version: "social-review-render/test",
      generation_id: generation.generation_id,
      audio_mastering: audioReportFromReceipt(audioReceipt),
    }));
  }
  return reportPath;
}

let masteredMedia: { wav: Buffer; mp4: Buffer } | undefined;
function masteredMediaBytes(): { wav: Buffer; mp4: Buffer } {
  if (masteredMedia) return masteredMedia;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-generation-media-"));
  const wav = path.join(root, "audio.wav");
  const mp4 = path.join(root, "review.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-ac", "2", "-y", wav]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=1", "-i", wav, "-shortest", "-c:v", "libx264", "-c:a", "aac", "-y", mp4]);
  masteredMedia = { wav: fs.readFileSync(wav), mp4: fs.readFileSync(mp4) };
  fs.rmSync(root, { recursive: true, force: true });
  return masteredMedia;
}

function prepareMasteredGeneration(
  source: ReturnType<typeof fixture>,
  policy = { loudness_target_lufs: -16, lra_target: 7, true_peak_target_dbtp: -1.5 },
  claimedSharedAudioPlanHash?: string,
  options: { audioMismatch?: ReviewAudioMismatchKind } = {},
) {
  const canonicalPlan = writeCanonicalSocialReviewAudioPlan({
    projectDir: source.projectDir,
    projectId: source.base.projectId,
    timelinePath: path.join(source.projectDir, source.files.timeline),
    policy,
  });
  const sharedAudioPlanHash = claimedSharedAudioPlanHash ?? canonicalPlan.hash;
  const generation = captureSocialReviewGeneration({
    ...source.base,
    audioPlanHash: deriveSocialReviewAudioPlanIdentity({
      state: "mastered", sharedAudioPlanHash, policy,
    }),
    files: [
      ...source.base.files,
      { logicalPath: "audio/shared-render-plan", filePath: canonicalPlan.filePath },
    ],
  });
  expect(prepareImmutableGeneration(generation).status).toBe("owner");
  const premaster = path.join(generation.generation_dir, "work/audio/premaster.wav");
  const outputAudio = path.join(generation.generation_dir, "work/audio/mastered.wav");
  fs.mkdirSync(path.dirname(premaster), { recursive: true });
  let audioReceipt: SocialReviewAudioReceipt;
  if (options.audioMismatch) {
    const media = writeReviewAudioIdentityMedia({
      root: path.join(generation.generation_dir, "work/audio/identity-fixture"),
      kind: options.audioMismatch,
    });
    fs.copyFileSync(media.outputAudioPath, premaster);
    fs.copyFileSync(media.outputAudioPath, outputAudio);
    fs.copyFileSync(media.mismatchedVideoPath, generation.output_path);
    const matchingReceipt = buildSocialReviewAudioReceipt({
      state: "mastered", generationId: generation.generation_id, sharedAudioPlanHash, projectDir: generation.project_dir,
      inputAudioPath: premaster, outputAudioPath: outputAudio, reviewVideoPath: media.matchingVideoPath,
      policy, masteringCount: 1, inputKind: "premaster",
    });
    const mismatchedReceipt = buildSocialReviewAudioReceipt({
      state: "mastered", generationId: generation.generation_id, sharedAudioPlanHash, projectDir: generation.project_dir,
      inputAudioPath: media.mismatchedAudioPath, outputAudioPath: media.mismatchedAudioPath,
      reviewVideoPath: generation.output_path,
      policy, masteringCount: 1, inputKind: "premaster",
    });
    audioReceipt = {
      ...matchingReceipt,
      review_video: mismatchedReceipt.review_video,
      review_video_audio: mismatchedReceipt.review_video_audio,
    };
  } else {
    const media = masteredMediaBytes();
    fs.writeFileSync(premaster, media.wav);
    fs.writeFileSync(outputAudio, media.wav);
    fs.writeFileSync(generation.output_path, media.mp4);
    audioReceipt = buildSocialReviewAudioReceipt({
      state: "mastered", generationId: generation.generation_id, sharedAudioPlanHash, projectDir: generation.project_dir,
      inputAudioPath: premaster, outputAudioPath: outputAudio, reviewVideoPath: generation.output_path,
      policy, masteringCount: 1, inputKind: "premaster",
    });
  }
  const audioPath = path.join(generation.generation_dir, "audio-mastering-receipt.json");
  fs.writeFileSync(audioPath, `${JSON.stringify(audioReceipt, null, 2)}\n`);
  const layerPath = path.join(generation.generation_dir, "work/layers/layer.json");
  fs.mkdirSync(path.dirname(layerPath), { recursive: true });
  fs.writeFileSync(layerPath, "layer\n");
  const qa: SocialReviewQA = {
    output: {
      status: "verified",
      issues: [],
      scans: {
        decode: { status: "complete" },
        black: { status: "complete", detections: [] },
        freeze: { status: "complete", detections: [] },
        layout_inset: { status: "complete", detections: [] },
      },
    },
    ...createVerifiedCollisionLayoutEvidence(generation),
    audio: {
      status: "verified",
      evidence: { path: path.relative(generation.project_dir, audioPath), sha256: hashFile(audioPath) },
    },
    layers: {
      status: "verified",
      evidence: [{ path: path.relative(generation.project_dir, layerPath), sha256: hashFile(layerPath) }],
    },
  };
  return {
    generation,
    qa,
    reportPath: renderReport(generation),
    canonicalPlan,
    sharedAudioPlanHash,
  };
}

function writeUnsafeReadyReceipt(
  target: ReturnType<typeof prepareMasteredGeneration>,
): SocialReviewGenerationReceipt {
  const { generation, qa, reportPath } = target;
  const qaPath = path.join(generation.generation_dir, "qa-results.json");
  fs.writeFileSync(qaPath, `${JSON.stringify(qa, null, 2)}\n`);
  const receipt: SocialReviewGenerationReceipt = {
    version: "social-review-generation-receipt/v1",
    project_id: generation.project_id,
    generation_id: generation.generation_id,
    inputs: generation.inputs,
    input_files: generation.input_files,
    output: {
      path: path.relative(generation.project_dir, generation.output_path).split(path.sep).join("/"),
      sha256: hashFile(generation.output_path),
    },
    qa,
    qa_artifact: {
      path: path.relative(generation.project_dir, qaPath).split(path.sep).join("/"),
      sha256: hashFile(qaPath),
    },
    audio_mastering_receipt: qa.audio.evidence,
    render_report: bindGenerationArtifact(generation, reportPath),
    source_input_attestation: bindGenerationArtifact(
      generation,
      path.join(generation.generation_dir, "source-input-attestation.json"),
    ),
    review_ready: true,
    review_only: true,
  };
  fs.writeFileSync(generation.receipt_path, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function musicMasterGenerationPlan(
  projectId: string,
  timelinePath: string,
  sourcePath: string,
): AudioRenderPlan {
  const sourceHash = hashFile(sourcePath);
  return {
    version: "audio-render-plan/v1",
    project_id: projectId,
    strategy: "music_master",
    timeline: {
      path: "05_timeline/timeline.json",
      version: "test",
      content_hash: hashFile(timelinePath),
      duration_frames: 24,
      fps: { num: 24, den: 1 },
    },
    inputs: {},
    dialogue: { source_track_id: "A1", clips: [], finish_scope: "none" },
    music: { enabled: false, source_track_id: "A2", cues: [] },
    music_master: {
      enabled: true,
      source: {
        role: "music_master",
        asset_id: "SONG_FULL_01",
        source_ref: "00_sources/full-song.wav",
        source_content_hash: sourceHash,
        source_size_bytes: fs.statSync(sourcePath).size,
        source_duration_us: 1_000_000,
        source_range_us: { in_us: 0, out_us: 1_000_000 },
        timeline_range: { in_frame: 0, out_frame: 24 },
        gain_linear: 1,
        channel_layout: "stereo",
        codec: "pcm_s16le",
      },
      audio_decision: "preserve",
      input_audio_hash: sourceHash,
      policy_hash: hash("b"),
      processing_graph: { version: "audio-processing-graph/v1", operations: ["stream_copy"] },
      codec: { input: "pcm_s16le", output: "pcm_s16le", operation: "stream_copy" },
      measurement_tolerance: {
        integrated_lufs_db: 0.5,
        lra_lu: 0.5,
        true_peak_dbtp: 0.5,
      },
    },
    final_mastering: {
      loudness_target_lufs: -16,
      lra_target: 7,
      true_peak_target_dbtp: -1.5,
      count: 0,
      stage: "not_applied",
      owner: "shared_audio_render_plan",
    },
    expected_artifacts: {
      dialogue_stem: "raw_dialogue.wav",
      final_mix: "final_mix.wav",
      report: "audio-mix-report.json",
    },
    warnings: [],
  };
}

describe("Issue #19 immutable social-review generation", () => {
  it("binds a music_master preserve count-zero generation identity through receipt to review-ready", () => {
    const source = fixture();
    const sourcePath = path.join(source.projectDir, "00_sources", "full-song.wav");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    const media = masteredMediaBytes();
    fs.writeFileSync(sourcePath, media.wav);
    const plan = musicMasterGenerationPlan(
      source.base.projectId,
      path.join(source.projectDir, source.files.timeline),
      sourcePath,
    );
    const planPath = path.join(source.projectDir, "07_package", "audio-render-plan.json");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const sharedAudioPlanHash = hashAudioRenderPlan(plan);
    const generation = captureSocialReviewGeneration({
      ...source.base,
      audioPlanHash: deriveSocialReviewGenerationAudioPlanHash(plan),
      files: [
        ...source.base.files,
        { logicalPath: "audio/shared-render-plan", filePath: planPath },
      ],
    });
    prepareImmutableGeneration(generation);
    const premasterPath = path.join(generation.generation_dir, "work/audio/premaster.wav");
    const outputAudioPath = path.join(generation.generation_dir, "work/audio/mastered.wav");
    fs.mkdirSync(path.dirname(premasterPath), { recursive: true });
    fs.writeFileSync(premasterPath, media.wav);
    fs.writeFileSync(outputAudioPath, media.wav);
    fs.writeFileSync(generation.output_path, media.mp4);
    const audioReceipt = buildSocialReviewAudioReceipt({
      state: "mastered",
      generationId: generation.generation_id,
      sharedAudioPlanHash,
      projectDir: generation.project_dir,
      inputAudioPath: premasterPath,
      outputAudioPath,
      reviewVideoPath: generation.output_path,
      policy: plan.final_mastering,
      masteringCount: 0,
      inputKind: "premaster",
      musicMaster: plan.music_master,
    });
    expect(generation.inputs.audio_plan_sha256).toBe(audioReceipt.audio_plan_sha256);
    const audioPath = path.join(generation.generation_dir, "audio-mastering-receipt.json");
    fs.writeFileSync(audioPath, `${JSON.stringify(audioReceipt, null, 2)}\n`);
    const layerPath = path.join(generation.generation_dir, "work/layers/layer-receipt.json");
    fs.mkdirSync(path.dirname(layerPath), { recursive: true });
    fs.writeFileSync(layerPath, "layer-evidence\n");
    const qa: SocialReviewQA = {
      output: {
        status: "verified",
        issues: [],
        scans: {
          decode: { status: "complete" },
          black: { status: "complete", detections: [] },
          freeze: { status: "complete", detections: [] },
          layout_inset: { status: "complete", detections: [] },
        },
      },
      ...createVerifiedCollisionLayoutEvidence(generation),
      audio: {
        status: "verified",
        evidence: { path: path.relative(generation.project_dir, audioPath), sha256: hashFile(audioPath) },
      },
      layers: {
        status: "verified",
        evidence: [{ path: path.relative(generation.project_dir, layerPath), sha256: hashFile(layerPath) }],
      },
    };
    const receipt = buildReviewReadyReceipt(
      generation,
      generation.output_path,
      qa,
      renderReport(generation),
    );
    expect(receipt.review_ready).toBe(true);
    writeReviewReadyReceipt(generation, receipt);
    expect(() => verifyReviewReadyReceipt(generation, receipt)).not.toThrow();
  });

  it.each(["near-tone", "truncated", "near-speech", "level-plus-1.5db", "stereo-swap"] as const)(
    "rejects forged decoded-content mismatch %s at build, verify, promote, and latest",
    (kind) => {
      const target = prepareMasteredGeneration(fixture(), undefined, undefined, { audioMismatch: kind });
      const latestPath = path.join(target.generation.project_dir, "09_output/social-review/latest.json");
      const outputBefore = hashFile(target.generation.output_path);
      expect(() => buildReviewReadyReceipt(
        target.generation,
        target.generation.output_path,
        target.qa,
        target.reportPath,
      )).toThrow(/video audio|content|decoded|duration|fingerprint/i);
      expect(fs.existsSync(path.join(target.generation.generation_dir, "qa-results.json"))).toBe(false);
      expect(fs.existsSync(latestPath)).toBe(false);
      expect(hashFile(target.generation.output_path)).toBe(outputBefore);

      const receipt = writeUnsafeReadyReceipt(target);
      expect(() => verifyReviewReadyReceipt(target.generation, receipt))
        .toThrow(/video audio|content|decoded|duration|fingerprint/i);
      expect(() => promoteLatestGeneration(target.generation, receipt))
        .toThrow(/video audio|content|decoded|duration|fingerprint/i);
      expect(fs.existsSync(latestPath)).toBe(false);
      expect(hashFile(target.generation.output_path)).toBe(outputBefore);

      fs.writeFileSync(latestPath, `${JSON.stringify({
        version: "social-review-latest/v1",
        project_id: target.generation.project_id,
        generation_id: target.generation.generation_id,
        receipt_path: path.relative(target.generation.project_dir, target.generation.receipt_path).split(path.sep).join("/"),
        receipt_sha256: hashFile(target.generation.receipt_path),
        output_path: receipt.output.path,
        output_sha256: receipt.output.sha256,
      }, null, 2)}\n`);
      expect(() => verifyLatestGeneration(target.generation.project_dir))
        .toThrow(/video audio|content|decoded|duration|fingerprint/i);
      expect(hashFile(target.generation.output_path)).toBe(outputBefore);
    },
  );

  it("rejects a shared-plan-only full rehash against unchanged canonical plan source at every generation boundary", () => {
    const target = prepareMasteredGeneration(fixture(), undefined, hash("8"));
    const latestPath = path.join(target.generation.project_dir, "09_output/social-review/latest.json");
    expect(() => buildReviewReadyReceipt(
      target.generation,
      target.generation.output_path,
      target.qa,
      target.reportPath,
    )).toThrow(/current|canonical|shared.*plan/i);
    expect(fs.existsSync(path.join(target.generation.generation_dir, "qa-results.json"))).toBe(false);
    expect(fs.existsSync(latestPath)).toBe(false);

    const receipt = writeUnsafeReadyReceipt(target);
    expect(() => verifyReviewReadyReceipt(target.generation, receipt))
      .toThrow(/current|canonical|shared.*plan/i);
    expect(() => promoteLatestGeneration(target.generation, receipt))
      .toThrow(/current|canonical|shared.*plan/i);
    expect(fs.existsSync(latestPath)).toBe(false);

    fs.writeFileSync(latestPath, `${JSON.stringify({
      version: "social-review-latest/v1",
      project_id: target.generation.project_id,
      generation_id: target.generation.generation_id,
      receipt_path: path.relative(target.generation.project_dir, target.generation.receipt_path).split(path.sep).join("/"),
      receipt_sha256: hashFile(target.generation.receipt_path),
      output_path: receipt.output.path,
      output_sha256: receipt.output.sha256,
    }, null, 2)}\n`);
    expect(() => verifyLatestGeneration(target.generation.project_dir))
      .toThrow(/current|canonical|shared.*plan/i);
  });

  it("accepts the canonical shared plan and makes a real plan/policy source change a new identity", () => {
    const source = fixture();
    const first = prepareMasteredGeneration(source);
    const firstReceipt = buildReviewReadyReceipt(
      first.generation,
      first.generation.output_path,
      first.qa,
      first.reportPath,
    );
    writeReviewReadyReceipt(first.generation, firstReceipt);
    expect(() => verifyReviewReadyReceipt(first.generation, firstReceipt)).not.toThrow();
    promoteLatestGeneration(first.generation, firstReceipt);
    expect(verifyLatestGeneration(first.generation.project_dir).generation_id)
      .toBe(first.generation.generation_id);

    const changedPolicy = { loudness_target_lufs: -18, lra_target: 7, true_peak_target_dbtp: -1.5 };
    const second = prepareMasteredGeneration(source, changedPolicy);
    expect(second.generation.generation_id).not.toBe(first.generation.generation_id);
    expect(second.sharedAudioPlanHash).not.toBe(first.sharedAudioPlanHash);
    expect(() => verifyReviewReadyReceipt(first.generation, firstReceipt))
      .toThrow(/input logical path changed|source hash mismatch|canonical/i);
    expect(() => buildReviewReadyReceipt(
      second.generation,
      second.generation.output_path,
      second.qa,
      second.reportPath,
    )).not.toThrow();
  });

  it("rejects a fully rehashed receipt policy that differs from the current canonical social-review policy", () => {
    const source = fixture();
    const forgedPolicy = { loudness_target_lufs: -9, lra_target: 7, true_peak_target_dbtp: -1.5 };
    const generation = captureSocialReviewGeneration({
      ...source.base,
      audioPlanHash: deriveSocialReviewAudioPlanIdentity({
        state: "not_applicable", sharedAudioPlanHash: null, policy: forgedPolicy,
      }),
    });
    claimWithOutput(generation, "policy-forged-video");
    const qa = verifiedQa(generation, forgedPolicy);
    expect(() => buildReviewReadyReceipt(
      generation,
      generation.output_path,
      qa,
      renderReport(generation),
    )).toThrow(/current|canonical|policy|profile/i);
  });

  it("rejects caller-verified layout without bound subject collision evidence", () => {
    const generation = captureSocialReviewGeneration(fixture().base);
    claimWithOutput(generation, "unbound-ready");
    const qa = verifiedQa(generation);
    const unboundQa = structuredClone(qa);
    delete unboundQa.layout.subject_collision_binding;
    delete (unboundQa as Partial<typeof unboundQa>).layout_evidence;
    expect(() => buildReviewReadyReceipt(
      generation,
      generation.output_path,
      unboundQa,
      renderReport(generation),
    )).toThrow(/subject|policy|collision|layout.*evidence|binding/i);
  });

  it("rejects every missing ready-layout evidence component in build, verify, and promotion", () => {
    const cases: Array<[string, (qa: SocialReviewQA) => void]> = [
      ["layout evidence", (qa) => { delete qa.layout_evidence; }],
      ["layout snapshot", (qa) => {
        delete (qa.layout_evidence as Partial<NonNullable<SocialReviewQA["layout_evidence"]>>).snapshot;
      }],
      ["subject occupancy", (qa) => { qa.layout_evidence!.subject_occupancy = null; }],
      ["vertical composition policy", (qa) => { qa.layout_evidence!.vertical_composition_policy = null; }],
      ["collision binding", (qa) => { delete qa.layout.subject_collision_binding; }],
    ];
    for (const [label, removeEvidence] of cases) {
      const buildGeneration = captureSocialReviewGeneration(fixture().base);
      claimWithOutput(buildGeneration, `build-${label}`);
      const buildQa: SocialReviewQA = verifiedQa(buildGeneration);
      removeEvidence(buildQa);
      expect(() => buildReviewReadyReceipt(
        buildGeneration,
        buildGeneration.output_path,
        buildQa,
        renderReport(buildGeneration),
      ), label).toThrow(/verified layout|subject|policy|collision|snapshot|evidence|binding/i);

      const forgedGeneration = captureSocialReviewGeneration(fixture().base);
      claimWithOutput(forgedGeneration, `forged-${label}`);
      const validReceipt = buildReviewReadyReceipt(
        forgedGeneration,
        forgedGeneration.output_path,
        verifiedQa(forgedGeneration),
        renderReport(forgedGeneration),
      );
      removeEvidence(validReceipt.qa);
      validReceipt.review_ready = true;
      const qaArtifactPath = path.join(forgedGeneration.project_dir, validReceipt.qa_artifact.path);
      fs.writeFileSync(qaArtifactPath, `${JSON.stringify(validReceipt.qa, null, 2)}\n`);
      validReceipt.qa_artifact.sha256 = hashFile(qaArtifactPath);
      expect(validateAgainstSchema(
        validReceipt,
        "social-review-generation-receipt.schema.json",
      ).valid, label).toBe(false);
      fs.writeFileSync(
        forgedGeneration.receipt_path,
        `${JSON.stringify(validReceipt, null, 2)}\n`,
      );
      expect(() => verifyReviewReadyReceipt(forgedGeneration, validReceipt), label)
        .toThrow(/schema|verified layout|subject|policy|collision|snapshot|evidence|binding/i);
      expect(() => promoteLatestGeneration(forgedGeneration, validReceipt), label)
        .toThrow(/schema|verified layout|subject|policy|collision|snapshot|evidence|binding/i);
    }
  });

  it("rejects a forged ready receipt derived from not_provided subject and policy sentinels", () => {
    const source = fixture();
    const missingBase: SocialReviewGenerationInput = { ...source.base };
    delete missingBase.subjectOccupancyPayloadHash;
    delete missingBase.verticalCompositionPolicyHash;
    const generation = captureSocialReviewGeneration(missingBase);
    claimWithOutput(generation, "sentinel-forged-ready");
    const incompleteQa: SocialReviewQA = verifiedQa(generation);
    delete incompleteQa.layout.subject_collision_binding;
    delete incompleteQa.layout_evidence;
    incompleteQa.layout.status = "incomplete";
    const receipt = buildReviewReadyReceipt(
      generation,
      generation.output_path,
      incompleteQa,
      renderReport(generation),
    );
    expect(receipt.review_ready).toBe(false);

    receipt.qa.layout.status = "verified";
    receipt.review_ready = true;
    const qaArtifactPath = path.join(generation.project_dir, receipt.qa_artifact.path);
    fs.writeFileSync(qaArtifactPath, `${JSON.stringify(receipt.qa, null, 2)}\n`);
    receipt.qa_artifact.sha256 = hashFile(qaArtifactPath);
    expect(validateAgainstSchema(
      receipt,
      "social-review-generation-receipt.schema.json",
    ).valid).toBe(false);
    fs.writeFileSync(generation.receipt_path, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => verifyReviewReadyReceipt(generation, receipt)).toThrow(
      /not_provided|verified layout|collision binding|schema/i,
    );
    expect(() => promoteLatestGeneration(generation, receipt)).toThrow(
      /not_provided|verified layout|collision binding|schema/i,
    );
    expect(fs.existsSync(path.join(
      generation.project_dir,
      "09_output/social-review/latest.json",
    ))).toBe(false);
  });

  it("changes generation path for every identity input and detects same-path byte mutation", () => {
    const { base, projectDir, files } = fixture();
    const first = captureSocialReviewGeneration(base);
    expect(captureSocialReviewGeneration(base).generation_id).toBe(first.generation_id);
    const fields = [
      "canonicalTimelineHash", "acceptedPatchHash", "derivedMappingReceiptHash",
      "reviewTimelineHash", "captionTextTimingHash", "visualTreatmentHash",
      "contentPlanHash", "audioPlanHash", "rendererCapabilityHash",
    ] as const;
    for (const field of fields) {
      const changed = captureSocialReviewGeneration({ ...base, [field]: hash("9") });
      expect(changed.generation_id).not.toBe(first.generation_id);
      expect(changed.generation_dir).not.toBe(first.generation_dir);
    }
    fs.writeFileSync(path.join(projectDir, files.captions), "captions-mutated\n");
    expect(() => assertGenerationInputsUnchanged(first)).toThrow(/logical path changed/i);

    const sourcePath = path.join(projectDir, "02_media", "source.mov");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "source-v1");
    const sourceV1 = captureSocialReviewGeneration({
      ...base,
      files: [...base.files, { logicalPath: "source-media/asset-1", filePath: sourcePath }],
    });
    fs.writeFileSync(sourcePath, "source-v2");
    const sourceV2 = captureSocialReviewGeneration({
      ...base,
      files: [...base.files, { logicalPath: "source-media/asset-1", filePath: sourcePath }],
    });
    expect(sourceV2.generation_id).not.toBe(sourceV1.generation_id);
  });

  it("refuses overwrite, reuses only exact bytes+receipt, and rejects stale latest", () => {
    const generation = captureSocialReviewGeneration(fixture().base);
    claimWithOutput(generation);
    const videoBytes = fs.readFileSync(generation.output_path);
    const receipt = buildReviewReadyReceipt(generation, generation.output_path, verifiedQa(generation), renderReport(generation));
    writeReviewReadyReceipt(generation, receipt);
    expect(prepareImmutableGeneration(generation).status).toBe("reused");

    promoteLatestGeneration(generation, receipt);
    const reportPath = renderReport(generation);
    const reportBytes = fs.readFileSync(reportPath);
    fs.appendFileSync(reportPath, "tampered");
    expect(() => verifyLatestGeneration(generation.project_dir)).toThrow(/render report.*hash mismatch/i);
    fs.writeFileSync(reportPath, reportBytes);

    fs.writeFileSync(generation.output_path, "stale-mp4");
    expect(() => prepareImmutableGeneration(generation)).toThrow(/overwrite|mismatch/i);
    fs.writeFileSync(generation.output_path, videoBytes);
    promoteLatestGeneration(generation, receipt);
    expect(verifyLatestGeneration(generation.project_dir).generation_id).toBe(generation.generation_id);
    fs.writeFileSync(generation.output_path, "fresh-but-pointer-stale");
    expect(() => verifyLatestGeneration(generation.project_dir)).toThrow(/stale latest/i);
  });

  it("binds audio receipt bytes and receipt-derived report values through verify, promotion, and latest", () => {
    const generation = captureSocialReviewGeneration(fixture().base);
    claimWithOutput(generation, "audio-bound-mp4");
    const qa = verifiedQa(generation);
    const reportPath = renderReport(generation);
    const receipt = buildReviewReadyReceipt(generation, generation.output_path, qa, reportPath);
    writeReviewReadyReceipt(generation, receipt);
    promoteLatestGeneration(generation, receipt);
    const latestPath = path.join(generation.project_dir, "09_output/social-review/latest.json");
    const latestBytes = fs.readFileSync(latestPath);
    const audioPath = path.join(generation.project_dir, receipt.audio_mastering_receipt!.path);
    const audioBytes = fs.readFileSync(audioPath);

    fs.appendFileSync(audioPath, "x");
    expect(() => verifyLatestGeneration(generation.project_dir)).toThrow(/audio.*hash mismatch|bound artifact hash/i);
    expect(fs.readFileSync(latestPath)).toEqual(latestBytes);
    fs.writeFileSync(audioPath, audioBytes);

    const forgedReport = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
      audio_mastering: { integrated_lufs: number | null };
    };
    forgedReport.audio_mastering.integrated_lufs = -9;
    fs.writeFileSync(reportPath, JSON.stringify(forgedReport));
    const forgedReceipt = structuredClone(receipt);
    forgedReceipt.render_report.sha256 = hashFile(reportPath);
    expect(() => verifyReviewReadyReceipt(generation, forgedReceipt)).toThrow(/report audio values.*receipt/i);
    expect(() => promoteLatestGeneration(generation, forgedReceipt)).toThrow(/report audio values.*receipt/i);
    expect(fs.readFileSync(latestPath)).toEqual(latestBytes);
  });

  it("rejects a review video symlink escaping the project during promotion and latest verification", () => {
    const generation = captureSocialReviewGeneration(fixture().base);
    claimWithOutput(generation);
    const videoBytes = fs.readFileSync(generation.output_path);
    const receipt = buildReviewReadyReceipt(generation, generation.output_path, verifiedQa(generation), renderReport(generation));
    writeReviewReadyReceipt(generation, receipt);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-generation-outside-"));
    roots.push(outsideDir);
    const outsideVideo = path.join(outsideDir, "review.mp4");
    fs.writeFileSync(outsideVideo, videoBytes);

    fs.unlinkSync(generation.output_path);
    fs.symlinkSync(outsideVideo, generation.output_path);
    expect(() => promoteLatestGeneration(generation, receipt)).toThrow(/review video|generation|contain|escape/i);

    fs.unlinkSync(generation.output_path);
    fs.writeFileSync(generation.output_path, videoBytes);
    promoteLatestGeneration(generation, receipt);
    fs.unlinkSync(generation.output_path);
    fs.symlinkSync(outsideVideo, generation.output_path);
    expect(() => verifyLatestGeneration(generation.project_dir)).toThrow(/review video|generation|contain|escape|stale latest/i);
  });

  it("rejects an external receipt symlink before promotion and leaves latest unchanged", () => {
    const generation = captureSocialReviewGeneration(fixture().base);
    claimWithOutput(generation);
    const videoBytes = fs.readFileSync(generation.output_path);
    const receipt = buildReviewReadyReceipt(generation, generation.output_path, verifiedQa(generation), renderReport(generation));
    writeReviewReadyReceipt(generation, receipt);
    promoteLatestGeneration(generation, receipt);
    const latestPath = path.join(generation.project_dir, "09_output/social-review/latest.json");
    const latestBefore = fs.readFileSync(latestPath);
    const receiptBytes = fs.readFileSync(generation.receipt_path);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-receipt-outside-"));
    roots.push(outsideDir);
    const outsideReceipt = path.join(outsideDir, "review-ready-receipt.json");
    fs.writeFileSync(outsideReceipt, receiptBytes);
    fs.unlinkSync(generation.receipt_path);
    fs.symlinkSync(outsideReceipt, generation.receipt_path);

    expect(() => promoteLatestGeneration(generation, receipt)).toThrow(/receipt.*(symlink|generation|contain|canonical|escape)/i);
    expect(fs.readFileSync(latestPath)).toEqual(latestBefore);
    expect(() => verifyLatestGeneration(generation.project_dir)).toThrow(/receipt.*(symlink|generation|contain|canonical|escape)|stale latest/i);
  });

  it("rejects stale MP4/fresh receipt, fresh MP4/stale receipt, missing QA evidence, and unknown fields", () => {
    const generation = captureSocialReviewGeneration(fixture().base);
    claimWithOutput(generation);
    const videoBytes = fs.readFileSync(generation.output_path);
    const receipt = buildReviewReadyReceipt(generation, generation.output_path, verifiedQa(generation), renderReport(generation));
    expect(receipt.review_ready).toBe(true);
    expect(validateAgainstSchema(receipt, "social-review-generation-receipt.schema.json").valid).toBe(true);
    expect(validateAgainstSchema({ ...receipt, surprise: true }, "social-review-generation-receipt.schema.json").valid).toBe(false);
    expect(validateAgainstSchema({ ...receipt, inputs: { ...receipt.inputs, surprise: hash("8") } }, "social-review-generation-receipt.schema.json").valid).toBe(false);
    expect(validateAgainstSchema({
      ...receipt,
      qa: { ...receipt.qa, output: { ...receipt.qa.output, issues: [{ kind: "decode", severity: "blocking", detail: "x", surprise: true }] } },
    }, "social-review-generation-receipt.schema.json").valid).toBe(false);
    expect(validateAgainstSchema({
      ...receipt,
      input_files: receipt.input_files.map((entry, index) => index === 0 ? { ...entry, surprise: true } : entry),
    }, "social-review-generation-receipt.schema.json").valid).toBe(false);
    expect(validateAgainstSchema({
      ...receipt,
      qa: { ...receipt.qa, audio: { ...receipt.qa.audio, evidence: { ...receipt.qa.audio.evidence!, surprise: true } } },
    }, "social-review-generation-receipt.schema.json").valid).toBe(false);
    expect(validateAgainstSchema({
      ...receipt,
      qa: { ...receipt.qa, layout: { ...receipt.qa.layout, review_items: [{
        issue_id: "x", code: "renderer_evidence_incomplete", severity: "blocking", title_ja: "x",
        remediation_ja: "x", layer_ids: [], surprise: true,
      }] } },
    }, "social-review-generation-receipt.schema.json").valid).toBe(false);

    fs.writeFileSync(generation.output_path, "mp4-v2");
    expect(() => verifyReviewReadyReceipt(generation, receipt)).toThrow(/output.*mismatch/i);
    fs.writeFileSync(generation.output_path, videoBytes);
    expect(() => verifyReviewReadyReceipt(generation, { ...receipt, generation_id: hash("9") })).toThrow(/generation.*mismatch/i);
    for (const qaCase of ["output-incomplete", "output-blocked", "layout-incomplete", "audio-incomplete", "layers-incomplete"]) {
      const blockedGeneration = captureSocialReviewGeneration(fixture().base);
      claimWithOutput(blockedGeneration, "blocked-mp4");
      const baseQa = verifiedQa(blockedGeneration);
      const qa = qaCase === "output-incomplete" ? { ...baseQa, output: { ...baseQa.output, status: "incomplete" as const } }
        : qaCase === "output-blocked" ? { ...baseQa, output: { ...baseQa.output, status: "blocked" as const } }
        : qaCase === "layout-incomplete" ? { ...baseQa, layout: { ...baseQa.layout, status: "incomplete" as const } }
        : qaCase === "audio-incomplete" ? { ...baseQa, audio: { status: "incomplete" as const, evidence: null } }
        : { ...baseQa, layers: { status: "incomplete" as const, evidence: [] } };
      expect(buildReviewReadyReceipt(blockedGeneration, blockedGeneration.output_path, qa, renderReport(blockedGeneration)).review_ready).toBe(false);
    }
    fs.writeFileSync(path.join(generation.generation_dir, "qa-results.json"), "{}\n");
    expect(() => verifyReviewReadyReceipt(generation, receipt)).toThrow(/QA results artifact hash mismatch/i);
  });

  it("rejects blocked reuse/latest, tampered evidence, and concurrent shared writers", () => {
    const blocked = captureSocialReviewGeneration(fixture().base);
    claimWithOutput(blocked, "blocked");
    const verifiedBlockedQa = verifiedQa(blocked);
    const blockedQa = {
      ...verifiedBlockedQa,
      audio: { ...verifiedBlockedQa.audio, status: "blocked" as const },
    };
    const blockedReceipt = buildReviewReadyReceipt(blocked, blocked.output_path, blockedQa, renderReport(blocked));
    writeReviewReadyReceipt(blocked, blockedReceipt);
    expect(() => prepareImmutableGeneration(blocked)).toThrow(/review.ready|blocked|incomplete/i);
    expect(() => promoteLatestGeneration(blocked, blockedReceipt)).toThrow(/review.ready/i);

    const generation = captureSocialReviewGeneration(fixture().base);
    expect(prepareImmutableGeneration(generation).status).toBe("owner");
    expect(() => prepareImmutableGeneration(generation)).toThrow(/claim|incomplete/i);
    writeNoAudioOutput(generation, "mp4");
    const qa = verifiedQa(generation);
    const receipt = buildReviewReadyReceipt(generation, generation.output_path, qa, renderReport(generation));
    const audioEvidenceBytes = fs.readFileSync(path.join(generation.project_dir, qa.audio.evidence!.path));
    fs.unlinkSync(path.join(generation.project_dir, qa.audio.evidence!.path));
    expect(() => verifyReviewReadyReceipt(generation, receipt)).toThrow(/audio.*evidence/i);
    fs.writeFileSync(path.join(generation.project_dir, qa.audio.evidence!.path), "tampered");
    expect(() => verifyReviewReadyReceipt(generation, receipt)).toThrow(/audio.*evidence/i);
    fs.writeFileSync(path.join(generation.project_dir, qa.audio.evidence!.path), audioEvidenceBytes);
    fs.unlinkSync(path.join(generation.project_dir, qa.layers.evidence[0].path));
    expect(() => verifyReviewReadyReceipt(generation, receipt)).toThrow(/layer.*evidence/i);
    fs.writeFileSync(path.join(generation.project_dir, qa.layers.evidence[0].path), "tampered");
    expect(() => verifyReviewReadyReceipt(generation, receipt)).toThrow(/layer.*evidence/i);
  });

  it("carries render-layout subject collision evidence through the actual receipt consumer and rejects mixed evidence", () => {
    const compositionPolicy = parseVerticalCompositionPolicy({
      version: "vertical-composition-policy/v1",
      policy_id: "receipt-collision-v1",
      output: { aspect_ratio: "9:16", coordinate_system: "normalized_top_left", width: 100, height: 100 },
      checks: {
        person_occupancy: { minimum: 0.01, maximum: 0.9 },
        headroom: { minimum_top_margin: 0, maximum_top_margin: 0.5 },
        look_room: { minimum_margin: 0 },
        hands: { mode: "ignore", minimum_confidence: 0 },
        microphone: { mode: "ignore", minimum_confidence: 0 },
        evidence: { mode: "required", minimum_confidence: 0.5 },
        caption_collision: {
          thresholds: { baseline: 0.1, emphasis: 0.4, title: 0.6 },
          candidate_anchors: { lower: "lower", upper: "upper" },
          auto_move: false,
        },
      },
      layout_anchors: {
        lower: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
        upper: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
      },
      zoom_intents: {
        emphasis: { max_zoom: 1, allow: true }, reaction: { max_zoom: 1, allow: true },
        evidence: { max_zoom: 1, allow: true }, reset: { max_zoom: 1, allow: true },
      },
      frames: { required_roles: ["first", "representative", "last"], representative_count: 1 },
      source: { require_identity: true, require_av_geometry: true },
      platform_geometry: {
        status: "measured", evidence_level: "platform_measured", source: "fixture",
        observed_at: "2026-08-24T00:00:00.000Z", device: "fixture-device", app: "fixture-app",
        screenshot_sha256: hash("8"),
      },
      degrade: { missing_evidence: "human_hold", failed_check: "human_hold", safe_mode: "identity" },
    });
    const subjectDraft = parseSubjectOccupancyTrack({
      version: "subject-occupancy-track/v1",
      generation_id: hash("0"),
      source_identity: {
        asset_id: "ASSET", segment_id: "SEGMENT", source_content_hash: hash("7"),
        source_range: { src_in_us: 0, src_out_us: 400_000 },
      },
      source_av_geometry: {
        video: { width: 1920, height: 1080, fps_num: 30, fps_den: 1 },
        audio: { sample_rate: 48_000, channels: 2 },
      },
      provenance: { source: "manual_annotation", producer: "fixture", producer_version: "1", confidence: 0.9 },
      coverage: { start_frame: 0, end_frame: 12 },
      tracks: [{
        track_id: "TRACK_1", subject_id: "SUBJECT_TRACK_ONLY", identity_scope: "track_only_not_person_identity",
        motion: "static", confidence: 0.9,
        samples: [{ start_frame: 0, end_frame: 12, bounds: { x: 0.3, y: 0.6, width: 0.4, height: 0.2 }, evidence_roles: ["first", "representative", "last"] }],
      }],
    });
    const source = fixture();
    const generation = captureSocialReviewGeneration({
      ...source.base,
      subjectOccupancyPayloadHash: subjectOccupancyPayloadHash(subjectDraft),
      verticalCompositionPolicyHash: verticalCompositionPolicyContentHash(compositionPolicy),
    });
    subjectDraft.generation_id = generation.generation_id;
    claimWithOutput(generation, "collision-mp4");
    const snapshot = {
      version: "render-layout-snapshot/v1" as const,
      binding: { generation_id: generation.generation_id, renderer_capability_sha256: generation.inputs.renderer_capability_sha256 },
      frame: { width: 100, height: 100, fps_num: 30, fps_den: 1, total_frames: 12, safe_area: { top: 0, right: 0, bottom: 0, left: 0 } },
      layers: [{
        layer_id: "CAP_1", semantic_role: "speech_caption" as const, caption_role: "baseline" as const,
        source: "ffmpeg-libass" as const, start_frame: 0, end_frame: 12,
        bounds: { x: 20, y: 60, width: 60, height: 20 },
        font: { status: "verified" as const, requested_family: "Fixture", resolved_family: "Fixture", missing_glyphs: [] },
      }],
      ending: { final_frame_state: "moving_source" as const },
    };
    const layout = evaluateDeterministicLayoutQA(snapshot, { subjectCollision: {
      generationId: generation.generation_id,
      rendererCapabilityHash: generation.inputs.renderer_capability_sha256,
      subjectOccupancy: subjectDraft,
      verticalCompositionPolicy: compositionPolicy,
      policyRef: "04_plan/vertical-composition-policy.json",
      policyHash: verticalCompositionPolicyContentHash(compositionPolicy),
    } });
    expect(layout.review_items[0]).toMatchObject({
      caption_id: "CAP_1", subject_track_id: "TRACK_1", start_frame: 0, end_frame: 12,
      collision_ratio: 0.666667, threshold: 0.1, generation_id: generation.generation_id,
    });
    const snapshotPath = path.join(generation.generation_dir, "layout-snapshot.json");
    const subjectPath = path.join(generation.generation_dir, "subject-occupancy-track.json");
    const policyPath = path.join(generation.generation_dir, "vertical-composition-policy.json");
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
    fs.writeFileSync(subjectPath, JSON.stringify(subjectDraft));
    fs.writeFileSync(policyPath, JSON.stringify(compositionPolicy));
    const baseQa = verifiedQa(generation);
    const qa = {
      ...baseQa,
      layout,
      layout_evidence: {
        snapshot: bindGenerationArtifact(generation, snapshotPath),
        subject_occupancy: bindGenerationArtifact(generation, subjectPath),
        vertical_composition_policy: bindGenerationArtifact(generation, policyPath),
      },
    };
    const receipt = buildReviewReadyReceipt(
      generation,
      generation.output_path,
      qa,
      renderReport(generation),
    );
    expect(receipt.review_ready).toBe(false);
    expect(() => verifyReviewReadyReceipt(generation, receipt)).not.toThrow();

    const generationBSnapshot = structuredClone(snapshot);
    generationBSnapshot.binding.generation_id = hash("9");
    const mixedLayout = evaluateDeterministicLayoutQA(generationBSnapshot, {
      subjectCollision: {
        generationId: generation.generation_id,
        rendererCapabilityHash: generation.inputs.renderer_capability_sha256,
        subjectOccupancy: subjectDraft,
        verticalCompositionPolicy: compositionPolicy,
        policyRef: "04_plan/vertical-composition-policy.json",
        policyHash: verticalCompositionPolicyContentHash(compositionPolicy),
      },
    });
    expect(() => buildReviewReadyReceipt(
      generation,
      generation.output_path,
      { ...qa, layout: mixedLayout },
      renderReport(generation),
    )).toThrow(/mixed-generation evidence rejected before write/i);

    const mixed = structuredClone(receipt);
    mixed.qa.layout.subject_collision_binding!.generation_id = hash("9");
    expect(() => verifyReviewReadyReceipt(generation, mixed)).toThrow(
      /receipt QA results mismatch|generation identity mismatch/i,
    );
    fs.writeFileSync(subjectPath, `${JSON.stringify(subjectDraft)} `);
    expect(() => verifyReviewReadyReceipt(generation, receipt)).toThrow(/subject occupancy evidence hash mismatch/i);
  });

  it("atomically grants exactly one owner to concurrent prepare processes", async () => {
    const { base } = fixture();
    const moduleUrl = pathToFileURL(path.resolve("runtime/review/social-review-generation.ts")).href;
    const code = `
      import { captureSocialReviewGeneration, prepareImmutableGeneration } from ${JSON.stringify(moduleUrl)};
      try {
        const generation = captureSocialReviewGeneration(JSON.parse(process.env.SOCIAL_GENERATION_INPUT));
        process.stdout.write(prepareImmutableGeneration(generation).status);
      } catch (error) {
        process.stderr.write(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    `;
    const run = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
        cwd: process.cwd(),
        env: { ...process.env, SOCIAL_GENERATION_INPUT: JSON.stringify(base) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("close", (exitCode) => resolve({ code: exitCode, stdout, stderr }));
    });
    const results = await Promise.all([run(), run()]);
    expect(results.filter((result) => result.code === 0 && result.stdout === "owner")).toHaveLength(1);
    expect(results.filter((result) => result.code === 2 && /claim.*incomplete/i.test(result.stderr))).toHaveLength(1);
  });

  it("binds distribution re-encode to source generation bytes and transform conditions", () => {
    const generation = captureSocialReviewGeneration(fixture().base);
    claimWithOutput(generation, "source-mp4");
    const receipt = buildReviewReadyReceipt(generation, generation.output_path, verifiedQa(generation), renderReport(generation));
    writeReviewReadyReceipt(generation, receipt);
    promoteLatestGeneration(generation, receipt);
    const first = buildReencodeGeneration({
      sourceGeneration: generation,
      sourceReceipt: receipt,
      transform: { container: "mp4", video_codec: "h264", max_width: 720, crf: 23 },
    });
    const changed = buildReencodeGeneration({
      sourceGeneration: generation,
      sourceReceipt: receipt,
      transform: { container: "mp4", video_codec: "h264", max_width: 720, crf: 24 },
    });
    expect(changed.generation_id).not.toBe(first.generation_id);
    fs.mkdirSync(first.generation_dir, { recursive: true });
    fs.writeFileSync(first.output_path, "delivery-mp4");
    const reencodeReceipt = first.buildReceipt();
    expect(validateAgainstSchema(reencodeReceipt, "review-reencode-receipt.schema.json").valid).toBe(true);
    expect(validateAgainstSchema({ ...reencodeReceipt, surprise: true }, "review-reencode-receipt.schema.json").valid).toBe(false);
    expect(validateAgainstSchema({
      ...reencodeReceipt,
      source_receipt: { ...reencodeReceipt.source_receipt, surprise: true },
    }, "review-reencode-receipt.schema.json").valid).toBe(false);
    expect(() => verifyReencodeGeneration(first, reencodeReceipt)).not.toThrow();
    fs.writeFileSync(generation.output_path, "tampered-source");
    expect(() => verifyReencodeGeneration(first, reencodeReceipt)).toThrow(/output.*hash|source.*hash/i);
    fs.writeFileSync(generation.output_path, "source-mp4");
    expect(() => verifyReencodeGeneration(first, { ...reencodeReceipt, transform: { ...reencodeReceipt.transform, crf: 99 } })).toThrow(/transform/i);
  });

  it("rejects re-encode finalization and reuse after source input mutation", () => {
    const { base, projectDir, files } = fixture();
    const generation = captureSocialReviewGeneration(base);
    claimWithOutput(generation, "source-mp4");
    const receipt = buildReviewReadyReceipt(generation, generation.output_path, verifiedQa(generation), renderReport(generation));
    writeReviewReadyReceipt(generation, receipt);
    promoteLatestGeneration(generation, receipt);
    const reencode = buildReencodeGeneration({
      sourceGeneration: generation,
      sourceReceipt: receipt,
      transform: { container: "mp4", video_codec: "h264", max_width: 720, crf: 23 },
    });
    fs.mkdirSync(reencode.generation_dir, { recursive: true });
    fs.writeFileSync(reencode.output_path, "delivery");
    fs.writeFileSync(path.join(projectDir, files.captions), "changed-after-preflight\n");
    expect(() => reencode.buildReceipt()).toThrow(/source|input|generation/i);
  });
});
