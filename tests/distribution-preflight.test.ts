import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  distributeThroughPreflight, evaluateDistributionPreflight,
  type DistributionPreflightRequest,
} from "../runtime/distribution/preflight.js";
import {
  bindGenerationArtifact, buildReviewReadyReceipt, captureSocialReviewGeneration, prepareImmutableGeneration,
  hashCanonical, promoteLatestGeneration, writeReviewReadyReceipt,
  type SocialReviewGenerationReceipt,
  type SocialReviewQA,
} from "../runtime/review/social-review-generation.js";
import {
  audioReportFromReceipt,
  buildSocialReviewAudioReceipt,
  deriveSocialReviewAudioPlanIdentity,
  type SocialReviewAudioReceipt,
} from "../runtime/review/social-review-audio.js";
import { runYoutubeUploadThroughDistributionPreflight } from "../scripts/youtube-upload.js";
import {
  createVerifiedCollisionLayoutEvidence,
  socialReviewCollisionInputHashes,
} from "./helpers/social-review-collision-evidence.js";
import { writeCanonicalSocialReviewAudioPlan } from "./helpers/social-review-audio-plan.js";
import {
  writeReviewAudioIdentityMedia,
  type ReviewAudioMismatchKind,
} from "./helpers/social-review-audio-media.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const fileSha = (file: string) => sha(fs.readFileSync(file));
function write(root: string, relative: string, value: string): string {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file;
}

let mediaFixture: { wav: Buffer; mp4: Buffer } | undefined;
function mediaBytes(): { wav: Buffer; mp4: Buffer } {
  if (mediaFixture) return mediaFixture;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "distribution-media-"));
  const wav = path.join(root, "audio.wav");
  const mp4 = path.join(root, "video.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-ac", "2", "-y", wav]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=1", "-i", wav, "-shortest", "-c:v", "libx264", "-c:a", "aac", "-y", mp4]);
  mediaFixture = { wav: fs.readFileSync(wav), mp4: fs.readFileSync(mp4) };
  fs.rmSync(root, { recursive: true, force: true });
  return mediaFixture;
}

function fixture(options: {
  forgedSharedAudioPlanHash?: string;
  audioMismatch?: ReviewAudioMismatchKind;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "distribution-preflight-")); roots.push(root);
  const inputFile = write(root, "05_timeline/timeline.json", "timeline-v1");
  const masteringPolicy = { loudness_target_lufs: -16, lra_target: 7, true_peak_target_dbtp: -1.5 };
  const canonicalAudioPlan = writeCanonicalSocialReviewAudioPlan({
    projectDir: root,
    projectId: "distribution-fixture",
    timelinePath: inputFile,
    policy: masteringPolicy,
  });
  const sharedAudioPlanHash = options.forgedSharedAudioPlanHash ?? canonicalAudioPlan.hash;
  const generation = captureSocialReviewGeneration({
    projectDir: root, projectId: "distribution-fixture", canonicalTimelineHash: fileSha(inputFile),
    acceptedPatchHash: sha("patch"), derivedMappingReceiptHash: sha("mapping"), reviewTimelineHash: sha("review"),
    captionTextTimingHash: sha("captions"), visualTreatmentHash: sha("visual"), contentPlanHash: sha("content"),
    audioPlanHash: deriveSocialReviewAudioPlanIdentity({
      state: "mastered", sharedAudioPlanHash, policy: masteringPolicy,
    }), rendererCapabilityHash: sha("renderer"),
    ...socialReviewCollisionInputHashes(),
    sourceInputAttestation: { version: "test", status: "verified" },
    files: [
      "05_timeline/timeline.json",
      { logicalPath: "audio/shared-render-plan", filePath: canonicalAudioPlan.filePath },
    ],
  });
  prepareImmutableGeneration(generation);
  const premaster = path.join(generation.generation_dir, "work/audio/premaster_mix.wav");
  const mastered = path.join(generation.generation_dir, "work/audio/mastered.wav");
  fs.mkdirSync(path.dirname(premaster), { recursive: true });
  let audioReceipt: SocialReviewAudioReceipt;
  if (options.audioMismatch) {
    const media = writeReviewAudioIdentityMedia({
      root: path.join(generation.generation_dir, "work/audio/identity-fixture"),
      kind: options.audioMismatch,
    });
    fs.copyFileSync(media.outputAudioPath, premaster);
    fs.copyFileSync(media.outputAudioPath, mastered);
    fs.copyFileSync(media.mismatchedVideoPath, generation.output_path);
    const matchingReceipt = buildSocialReviewAudioReceipt({
      state: "mastered", generationId: generation.generation_id, sharedAudioPlanHash, projectDir: generation.project_dir,
      inputAudioPath: premaster, outputAudioPath: mastered, reviewVideoPath: media.matchingVideoPath,
      policy: masteringPolicy, masteringCount: 1, inputKind: "premaster",
    });
    const mismatchedReceipt = buildSocialReviewAudioReceipt({
      state: "mastered", generationId: generation.generation_id, sharedAudioPlanHash, projectDir: generation.project_dir,
      inputAudioPath: media.mismatchedAudioPath, outputAudioPath: media.mismatchedAudioPath,
      reviewVideoPath: generation.output_path,
      policy: masteringPolicy, masteringCount: 1, inputKind: "premaster",
    });
    audioReceipt = {
      ...matchingReceipt,
      review_video: mismatchedReceipt.review_video,
      review_video_audio: mismatchedReceipt.review_video_audio,
    };
  } else {
    const media = mediaBytes();
    fs.writeFileSync(premaster, media.wav);
    fs.writeFileSync(mastered, media.wav);
    fs.writeFileSync(generation.output_path, media.mp4);
    audioReceipt = buildSocialReviewAudioReceipt({
      state: "mastered", generationId: generation.generation_id, sharedAudioPlanHash, projectDir: generation.project_dir,
      inputAudioPath: premaster, outputAudioPath: mastered, reviewVideoPath: generation.output_path,
      policy: masteringPolicy, masteringCount: 1, inputKind: "premaster",
    });
  }
  const audio = write(
    root,
    path.relative(root, path.join(generation.generation_dir, "audio-mastering-receipt.json")),
    `${JSON.stringify(audioReceipt, null, 2)}\n`,
  );
  const layer = write(root, path.relative(root, path.join(generation.generation_dir, "work/layer.json")), "layer");
  const report = write(
    root,
    path.relative(root, path.join(generation.generation_dir, "social-review-report.json")),
    `${JSON.stringify({ audio_mastering: audioReportFromReceipt(audioReceipt) }, null, 2)}\n`,
  );
  const qa: SocialReviewQA = {
    output: { status: "verified", issues: [], scans: { decode: { status: "complete" }, black: { status: "complete", detections: [] }, freeze: { status: "complete", detections: [] }, layout_inset: { status: "complete", detections: [] } } },
    ...createVerifiedCollisionLayoutEvidence(generation),
    audio: { status: "verified", evidence: { path: path.relative(root, audio), sha256: fileSha(audio) } },
    layers: { status: "verified", evidence: [{ path: path.relative(root, layer), sha256: fileSha(layer) }] },
  };
  let generationReceipt: SocialReviewGenerationReceipt;
  if (options.forgedSharedAudioPlanHash || options.audioMismatch) {
    const qaPath = path.join(generation.generation_dir, "qa-results.json");
    fs.writeFileSync(qaPath, `${JSON.stringify(qa, null, 2)}\n`);
    generationReceipt = {
      version: "social-review-generation-receipt/v1",
      project_id: generation.project_id,
      generation_id: generation.generation_id,
      inputs: generation.inputs,
      input_files: generation.input_files,
      output: { path: path.relative(root, generation.output_path), sha256: fileSha(generation.output_path) },
      qa,
      qa_artifact: { path: path.relative(root, qaPath), sha256: fileSha(qaPath) },
      audio_mastering_receipt: qa.audio.evidence,
      render_report: bindGenerationArtifact(generation, report),
      source_input_attestation: bindGenerationArtifact(
        generation,
        path.join(generation.generation_dir, "source-input-attestation.json"),
      ),
      review_ready: true,
      review_only: true,
    };
    fs.writeFileSync(generation.receipt_path, `${JSON.stringify(generationReceipt, null, 2)}\n`);
    const latestPath = path.join(root, "09_output/social-review/latest.json");
    fs.writeFileSync(latestPath, `${JSON.stringify({
      version: "social-review-latest/v1",
      project_id: generation.project_id,
      generation_id: generation.generation_id,
      receipt_path: path.relative(root, generation.receipt_path),
      receipt_sha256: fileSha(generation.receipt_path),
      output_path: generationReceipt.output.path,
      output_sha256: generationReceipt.output.sha256,
    }, null, 2)}\n`);
  } else {
    generationReceipt = buildReviewReadyReceipt(generation, generation.output_path, qa, report);
    writeReviewReadyReceipt(generation, generationReceipt);
    promoteLatestGeneration(generation, generationReceipt);
  }

  const dummyNames = ["source_map", "delivery", "framing_policy", "caption_policy", "caption_plan", "render_report", "sample_sheet", "storyboard_manifest"];
  const artifacts: Record<string, { path: string; sha256: string }> = {};
  artifacts.timeline = { path: "05_timeline/timeline.json", sha256: fileSha(inputFile) };
  for (const name of dummyNames) { const file = write(root, `06_review/${name}.json`, `{\"name\":\"${name}\"}`); artifacts[name] = { path: path.relative(root, file), sha256: fileSha(file) }; }
  for (const name of ["framing_policy", "caption_policy"]) {
    const file = write(root, `06_review/${name}.json`, JSON.stringify({ evidence_level: "platform_measured" }));
    artifacts[name] = { path: path.relative(root, file), sha256: fileSha(file) };
  }
  artifacts.review_video = { path: path.relative(root, generation.output_path), sha256: fileSha(generation.output_path) };
  artifacts.generation_receipt = { path: path.relative(root, generation.receipt_path), sha256: fileSha(generation.receipt_path) };
  const attestation = path.join(generation.generation_dir, "source-input-attestation.json");
  artifacts.source_input_attestation = { path: path.relative(root, attestation), sha256: fileSha(attestation) };
  const reviewIdentity = hashCanonical({ version: "review-identity/v1", generation_id: generation.generation_id, delivery_id: "delivery", timeline_sha256: artifacts.timeline.sha256, source_map_sha256: artifacts.source_map.sha256, delivery_sha256: artifacts.delivery.sha256, framing_policy_sha256: artifacts.framing_policy.sha256, caption_policy_sha256: artifacts.caption_policy.sha256, caption_plan_sha256: artifacts.caption_plan.sha256, video_sha256: artifacts.review_video.sha256 });
  const reviewReceipt = {
    version: "review-qa-receipt/v1", project_id: "distribution-fixture", review_identity: reviewIdentity,
    identity: { generation_id: generation.generation_id, delivery_id: "delivery", timeline_sha256: artifacts.timeline.sha256, source_map_sha256: artifacts.source_map.sha256, delivery_sha256: artifacts.delivery.sha256, framing_policy_sha256: artifacts.framing_policy.sha256, caption_policy_sha256: artifacts.caption_policy.sha256, caption_plan_sha256: artifacts.caption_plan.sha256, video_sha256: artifacts.review_video.sha256 },
    artifacts,
    technical: { duration_frames: 30, duration_seconds: 1, fps: { num: 30, den: 1 }, resolution: { width: 1080, height: 1920 }, audio_stream: "present", bgm: "absent" },
    gaps: { primary_video: { status: "pass", count: 0 }, audio: { status: "pass", count: 0 }, freeze: { status: "pass", count: 0 }, black: { status: "pass", count: 0 } },
    source: { attestation_status: "verified", unresolved_media: [] },
    framing: { coverage: "sampled", evidence_level: "platform_measured", samples: [{ clip_id: "clip", timestamp_frame: 0, inspection_space: "delivery_crop", measurement: { face_eye_line_ratio: 0.34 }, allowed_range: { min: 0.3, max: 0.4 }, status: "pass" }] },
    captions: { cue_count: 0, display_range: { first_frame: 0, last_frame: 0 }, safe_rect: { x: 0, y: 0, width: 1, height: 1 }, collision_status: "pass", transcript_grounding: "verified", evidence_level: "platform_measured", platform_safety_claims: [] },
    coverage: { video: "full_frame", audio: "full_frame", framing: "sampled", captions: "full_frame" },
    findings: { pass: ["verified"], warnings: [], blockers: [], human_residual: [] }, review_summary: { projection_id: "projection", trims: [], crops: [], captions: [] }, status: "pass", review_only: true,
  };
  const reviewReceiptPath = write(root, `09_output/social-review/generations/${generation.generation_id.slice(7)}/review-qa-receipt.json`, `${JSON.stringify(reviewReceipt)}\n`);
  write(root, "06_review/review-ready-state.json", `${JSON.stringify({ version: "review-ready-state/v1", project_id: "distribution-fixture", review_identity: reviewIdentity, generation_id: generation.generation_id, status: "ready", artifacts: { preview: "CURRENT", qa_receipt: "CURRENT", unanswered_ask: "CURRENT" }, qa_receipt: { path: path.relative(root, reviewReceiptPath), sha256: fileSha(reviewReceiptPath) }, ask_payload_sha256: sha("ask"), reason: null })}\n`);
  write(root, "project_state.yaml", `version: 1\nproject_id: distribution-fixture\ncurrent_state: review_ready\ngates:\n  review_gate: open\nreview_transaction:\n  version: review-transaction/v1\n  review_identity: ${reviewIdentity}\n  status: ready\n  reason: null\n`);

  const finalVideo = write(root, "07_package/video/final.mp4", "final-package-video");
  const packageQa = { version: "1.0.0", project_id: "distribution-fixture", source_of_truth: "nle_finishing", qa_profile: "nle_finishing", passed: true, checks: [{ name: "complete", passed: true, details: "complete" }], source_inputs_freshness: { status: "fresh" } };
  const packageQaPath = write(root, "07_package/qa-report.json", JSON.stringify(packageQa));
  const manifest = { version: "1.0.0", project_id: "distribution-fixture", source_of_truth: "nle_finishing", base_timeline_version: "1", packaging_projection_hash: sha("projection").slice(7), created_at: "2026-08-24T00:00:00.000Z", artifacts: { final_video: { path: path.relative(root, finalVideo), sha256: fileSha(finalVideo) }, qa_report: { path: path.relative(root, packageQaPath), sha256: fileSha(packageQaPath) } }, provenance: { editorial_timeline_hash: artifacts.timeline.sha256.slice(7) } };
  const manifestPath = write(root, "07_package/package_manifest.json", JSON.stringify(manifest));
  const request: DistributionPreflightRequest = { version: "distribution-preflight-request/v1", project_dir: root, project_id: "distribution-fixture", action: "external_upload", generation_id: generation.generation_id, review_identity: reviewIdentity, output: { locator: "project:07_package/video/final.mp4", sha256: fileSha(finalVideo) }, package: { manifest_locator: "project:07_package/package_manifest.json", manifest_sha256: fileSha(manifestPath) }, platform_geometry: { status: "measured", evidence_level: "platform_measured" }, declared_holds: [], override_locator: null, evaluated_at: "2026-08-24T12:00:00.000Z" };
  return { root, request, generation, reviewReceiptPath, finalVideo, manifestPath, packageQaPath, artifacts, audio, report };
}

function forgeAudioMeasurementAndRebind(target: ReturnType<typeof fixture>): void {
  const audioReceipt = JSON.parse(fs.readFileSync(target.audio, "utf8"));
  audioReceipt.measurement_raw.input_i = String(Number(audioReceipt.measurement_raw.input_i) + 6);
  audioReceipt.measurement_raw.input_tp = String(Number(audioReceipt.measurement_raw.input_tp) + 6);
  audioReceipt.measurement.integrated_lufs = Number(audioReceipt.measurement_raw.input_i);
  audioReceipt.measurement.true_peak_dbtp = Number(audioReceipt.measurement_raw.input_tp);
  fs.writeFileSync(target.audio, `${JSON.stringify(audioReceipt, null, 2)}\n`);

  const generationReceipt = JSON.parse(fs.readFileSync(target.generation.receipt_path, "utf8"));
  generationReceipt.qa.audio.evidence.sha256 = fileSha(target.audio);
  generationReceipt.audio_mastering_receipt.sha256 = fileSha(target.audio);
  fs.writeFileSync(target.report, `${JSON.stringify({ audio_mastering: audioReportFromReceipt(audioReceipt) }, null, 2)}\n`);
  generationReceipt.render_report.sha256 = fileSha(target.report);
  const qaPath = path.join(target.root, generationReceipt.qa_artifact.path);
  fs.writeFileSync(qaPath, `${JSON.stringify(generationReceipt.qa, null, 2)}\n`);
  generationReceipt.qa_artifact.sha256 = fileSha(qaPath);
  fs.writeFileSync(target.generation.receipt_path, `${JSON.stringify(generationReceipt, null, 2)}\n`);

  const reviewReceipt = JSON.parse(fs.readFileSync(target.reviewReceiptPath, "utf8"));
  reviewReceipt.artifacts.generation_receipt.sha256 = fileSha(target.generation.receipt_path);
  fs.writeFileSync(target.reviewReceiptPath, `${JSON.stringify(reviewReceipt)}\n`);
  const statePath = path.join(target.root, "06_review/review-ready-state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.qa_receipt.sha256 = fileSha(target.reviewReceiptPath);
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
}

function rewriteReviewIdentity(target: ReturnType<typeof fixture>, mutate: (receipt: any) => void): void {
  const receipt = JSON.parse(fs.readFileSync(target.reviewReceiptPath, "utf8"));
  mutate(receipt);
  receipt.review_identity = hashCanonical({ version: "review-identity/v1", ...receipt.identity });
  fs.writeFileSync(target.reviewReceiptPath, `${JSON.stringify(receipt)}\n`);
  const statePath = path.join(target.root, "06_review/review-ready-state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.review_identity = receipt.review_identity;
  state.qa_receipt.sha256 = fileSha(target.reviewReceiptPath);
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  fs.writeFileSync(path.join(target.root, "project_state.yaml"), `version: 1\nproject_id: distribution-fixture\ncurrent_state: review_ready\ngates:\n  review_gate: open\nreview_transaction:\n  version: review-transaction/v1\n  review_identity: ${receipt.review_identity}\n  status: ready\n  reason: null\n`);
  target.request.review_identity = receipt.review_identity;
}

const codes = (request: DistributionPreflightRequest) => evaluateDistributionPreflight(request).reasons.map((item) => item.code);

describe("Issue #22 shared distribution preflight", () => {
  it.each(["near-tone", "truncated", "near-speech", "level-plus-1.5db", "stereo-swap"] as const)(
    "blocks forged decoded-content mismatch %s before every distribution sender",
    async (kind) => {
      const target = fixture({ audioMismatch: kind });
      const outputBefore = fileSha(target.generation.output_path);
      expect(codes(target.request)).toContain("REVIEW_RECEIPT_INVALID");
      let senderCalls = 0;
      const result = await distributeThroughPreflight("cli", target.request, {
        send: async () => { senderCalls += 1; },
      });
      expect(result.decision.decision).toBe("BLOCK");
      expect(senderCalls).toBe(0);
      expect(fileSha(target.generation.output_path)).toBe(outputBefore);
    },
  );

  it("rejects a fully rebound shared plan identity when the canonical plan source is unchanged", async () => {
    const target = fixture({ forgedSharedAudioPlanHash: sha("forged-shared-audio-plan") });
    expect(codes(target.request)).toContain("REVIEW_RECEIPT_INVALID");
    let sendCalls = 0;
    const result = await distributeThroughPreflight("cli", target.request, {
      send: async () => { sendCalls += 1; },
    });
    expect(result.decision.decision).toBe("BLOCK");
    expect(sendCalls).toBe(0);
  });

  it("rejects rehashed self-consistent loudness metadata at the distribution boundary", () => {
    const target = fixture();
    forgeAudioMeasurementAndRebind(target);
    expect(codes(target.request)).toContain("REVIEW_RECEIPT_INVALID");
  });

  it("allows one current generation/review/package identity and is deterministic", () => {
    const { request } = fixture(); const first = evaluateDistributionPreflight(request); const second = evaluateDistributionPreflight(request);
    expect(first).toEqual(second); expect(first.decision).toBe("ALLOW"); expect(first.identity).toMatchObject({ generation_id: request.generation_id, review_identity: request.review_identity, output_sha256: request.output.sha256, package_manifest_sha256: request.package.manifest_sha256 });
    expect(validateAgainstSchema(first, "distribution-preflight-decision.schema.json").valid).toBe(true);
    expect(validateAgainstSchema({ ...first, identity: { ...first.identity, extra: true } }, "distribution-preflight-decision.schema.json").valid).toBe(false);
  });

  it("blocks QA fail/incomplete, stale/different generation, gate closed, and declared holds", () => {
    const qaFail = fixture(); const qa = JSON.parse(fs.readFileSync(qaFail.packageQaPath, "utf8")); qa.passed = false; fs.writeFileSync(qaFail.packageQaPath, JSON.stringify(qa)); expect(codes(qaFail.request)).toContain("QA_FAILED");
    const incomplete = fixture(); const incompleteQa = JSON.parse(fs.readFileSync(incomplete.packageQaPath, "utf8")); incompleteQa.checks = []; fs.writeFileSync(incomplete.packageQaPath, JSON.stringify(incompleteQa)); const incompleteManifest = JSON.parse(fs.readFileSync(incomplete.manifestPath, "utf8")); incompleteManifest.artifacts.qa_report.sha256 = fileSha(incomplete.packageQaPath); fs.writeFileSync(incomplete.manifestPath, JSON.stringify(incompleteManifest)); incomplete.request.package.manifest_sha256 = fileSha(incomplete.manifestPath); expect(codes(incomplete.request)).toContain("QA_INCOMPLETE");
    const stale = fixture(); fs.appendFileSync(stale.reviewReceiptPath, "stale"); expect(codes(stale.request)).toContain("REVIEW_RECEIPT_INVALID");
    const generation = fixture(); expect(codes({ ...generation.request, generation_id: sha("other-generation") })).toContain("CURRENT_GENERATION_MISMATCH");
    const gate = fixture(); fs.writeFileSync(path.join(gate.root, "project_state.yaml"), `version: 1\nproject_id: distribution-fixture\ncurrent_state: review_failed\ngates:\n  review_gate: blocked\n`); expect(codes(gate.request)).toContain("REVIEW_GATE_NOT_OPEN");
    const hold = fixture(); expect(codes({ ...hold.request, declared_holds: ["self-declared hold"] })).toContain("DECLARED_HOLD");
  });

  it("blocks missing/empty/mismatched packages, output mismatch, and package symlink escape", async () => {
    const missing = fixture(); fs.unlinkSync(missing.manifestPath); expect(codes(missing.request)).toContain("PACKAGE_MISSING");
    const empty = fixture(); fs.writeFileSync(empty.manifestPath, ""); expect(codes(empty.request)).toContain("PACKAGE_EMPTY");
    const mismatch = fixture(); fs.writeFileSync(mismatch.finalVideo, "changed"); expect(codes(mismatch.request)).toContain("OUTPUT_HASH_MISMATCH");
    const packageHash = fixture(); packageHash.request.package.manifest_sha256 = sha("wrong-package-hash"); expect(codes(packageHash.request)).toContain("PACKAGE_HASH_MISMATCH");
    const escaped = fixture(); const outside = write(os.tmpdir(), `outside-${Date.now()}.mp4`, "outside"); fs.unlinkSync(escaped.finalVideo); fs.symlinkSync(outside, escaped.finalVideo); expect(codes(escaped.request)).toContain("PACKAGE_PATH_ESCAPE"); fs.unlinkSync(outside);
    const zero = fixture(); fs.writeFileSync(zero.finalVideo, ""); const zeroManifest = JSON.parse(fs.readFileSync(zero.manifestPath, "utf8")); zeroManifest.artifacts.final_video.sha256 = fileSha(zero.finalVideo); fs.writeFileSync(zero.manifestPath, JSON.stringify(zeroManifest)); zero.request.output.sha256 = fileSha(zero.finalVideo); zero.request.package.manifest_sha256 = fileSha(zero.manifestPath); expect(codes(zero.request)).toContain("PACKAGE_EMPTY"); let zeroCalls = 0; await distributeThroughPreflight("cli", zero.request, { send: async () => { zeroCalls += 1; } }); expect(zeroCalls).toBe(0);
    const caption = fixture(); const captionFile = write(caption.root, "07_package/captions/review.srt", "caption"); const captionManifest = JSON.parse(fs.readFileSync(caption.manifestPath, "utf8")); captionManifest.artifacts.captions = [{ kind: "captions", delivery: "sidecar", path: path.relative(caption.root, captionFile), sha256: fileSha(captionFile) }]; fs.writeFileSync(caption.manifestPath, JSON.stringify(captionManifest)); caption.request.package.manifest_sha256 = fileSha(caption.manifestPath); fs.unlinkSync(captionFile); expect(codes(caption.request)).toContain("PACKAGE_ARTIFACT_MISSING");
  });

  it("re-derives canonical review timeline and geometry from immutable/current bytes", async () => {
    const timeline = fixture(); const alternate = write(timeline.root, "06_review/alternate-timeline.json", JSON.stringify({ altered: true }));
    rewriteReviewIdentity(timeline, (receipt) => { receipt.artifacts.timeline = { path: path.relative(timeline.root, alternate), sha256: fileSha(alternate) }; receipt.identity.timeline_sha256 = fileSha(alternate); });
    const manifest = JSON.parse(fs.readFileSync(timeline.manifestPath, "utf8")); manifest.provenance.editorial_timeline_hash = fileSha(alternate).slice(7); fs.writeFileSync(timeline.manifestPath, JSON.stringify(manifest)); timeline.request.package.manifest_sha256 = fileSha(timeline.manifestPath);
    let timelineCalls = 0; const timelineDecision = await distributeThroughPreflight("cli", timeline.request, { send: async () => { timelineCalls += 1; } }); expect(timelineDecision.decision.decision).toBe("BLOCK"); expect(timelineDecision.decision.reasons.map((item) => item.code)).toContain("REVIEW_RECEIPT_INVALID"); expect(timelineCalls).toBe(0);

    const geometry = fixture(); const captionPolicy = path.join(geometry.root, geometry.artifacts.caption_policy.path); fs.writeFileSync(captionPolicy, JSON.stringify({ evidence_level: "policy_only" }));
    rewriteReviewIdentity(geometry, (receipt) => { receipt.artifacts.caption_policy.sha256 = fileSha(captionPolicy); receipt.identity.caption_policy_sha256 = fileSha(captionPolicy); });
    let geometryCalls = 0; const geometryDecision = await distributeThroughPreflight("cli", geometry.request, { send: async () => { geometryCalls += 1; } }); expect(geometryDecision.decision.reasons.map((item) => item.code)).toContain("POLICY_ONLY_AS_PLATFORM_MEASURED"); expect(geometryCalls).toBe(0);
  });

  it("blocks unknown/provisional geometry and a policy-only platform-safe claim", () => {
    const unknown = fixture(); expect(codes({ ...unknown.request, platform_geometry: { status: "unknown", evidence_level: "policy_only" } })).toContain("GEOMETRY_UNKNOWN");
    const provisional = fixture(); expect(codes({ ...provisional.request, platform_geometry: { status: "provisional", evidence_level: "policy_only" } })).toContain("GEOMETRY_PROVISIONAL");
    const policy = fixture(); expect(codes({ ...policy.request, platform_geometry: { status: "measured", evidence_level: "policy_only" } })).toContain("POLICY_ONLY_AS_PLATFORM_MEASURED");
  });

  it("keeps local preparation available, calls no sender on BLOCK, and calls once on ALLOW through every adapter fake", async () => {
    const blocked = fixture(); const local = write(blocked.root, "07_package/local-prepared.txt", "local-ok"); let calls = 0;
    const blockedRequest = { ...blocked.request, declared_holds: ["hold"] };
    const blockedResult = await distributeThroughPreflight("connector", blockedRequest, { send: async () => { calls += 1; return "sent"; } });
    expect(fs.readFileSync(local, "utf8")).toBe("local-ok"); expect(blockedResult.sent).toBe(false); expect(calls).toBe(0);
    const driftCodes = await Promise.all((["connector", "cockpit", "cli"] as const).map(async (adapter) => (await distributeThroughPreflight(adapter, blockedRequest, { send: async () => "sent" })).decision.reasons.map((item) => item.code)));
    expect(driftCodes[1]).toEqual(driftCodes[0]); expect(driftCodes[2]).toEqual(driftCodes[0]);
    const allowed = fixture(); const once = await distributeThroughPreflight("connector", allowed.request, { send: async (decision) => { calls += 1; expect(decision.identity.generation_id).toBe(allowed.request.generation_id); return "sent"; } });
    expect(once.sent).toBe(true); expect(once.decision.reasons).toEqual([]); expect(calls).toBe(1);
    const adapterDecisions = [];
    for (const adapter of ["connector", "cockpit", "cli"] as const) { let adapterCalls = 0; const result = await distributeThroughPreflight(adapter, allowed.request, { send: async () => { adapterCalls += 1; return "sent"; } }); expect(adapterCalls).toBe(1); adapterDecisions.push(result.decision); }
    expect(adapterDecisions[1]).toEqual(adapterDecisions[0]); expect(adapterDecisions[2]).toEqual(adapterDecisions[0]);
  });

  it("puts the actual YouTube upload callback behind the same public-upload preflight", async () => {
    const target = fixture(); let calls = 0;
    const valid = { ...target.request, action: "public_upload" as const };
    const blocked = await runYoutubeUploadThroughDistributionPreflight({ ...valid, declared_holds: ["hold"] }, async () => { calls += 1; return "uploaded"; });
    expect(blocked.sent).toBe(false); expect(calls).toBe(0); expect(blocked.decision.reasons.map((item) => item.code)).toContain("DECLARED_HOLD");
    const allowed = await runYoutubeUploadThroughDistributionPreflight(valid, async () => { calls += 1; return "uploaded"; });
    expect(allowed.sent).toBe(true); expect(allowed.result).toBe("uploaded"); expect(calls).toBe(1);
  });

  it("accepts only a current complete review-only override and never elevates it to publication", () => {
    const current = fixture(); const base = { version: "distribution-review-override/v1", actor: "reviewer", scope: "review_only_distribution", project_id: current.request.project_id, generation_id: current.request.generation_id, review_identity: current.request.review_identity, timeline_sha256: current.artifacts.timeline.sha256, output_sha256: current.request.output.sha256, package_manifest_sha256: current.request.package.manifest_sha256, reason: "share QA failure for review", issued_at: "2026-08-24T11:00:00.000Z", expires_at: "2026-08-24T13:00:00.000Z" };
    const override = write(current.root, "06_review/distribution-override.json", JSON.stringify(base)); const reviewRequest = { ...current.request, action: "review_share" as const, declared_holds: ["review hold"], override_locator: "project:06_review/distribution-override.json" };
    expect(evaluateDistributionPreflight(reviewRequest).decision).toBe("ALLOW");
    for (const field of ["actor", "scope", "project_id", "generation_id", "review_identity", "timeline_sha256", "output_sha256", "package_manifest_sha256", "reason", "issued_at", "expires_at"] as const) { const invalid = { ...base } as Record<string, unknown>; delete invalid[field]; fs.writeFileSync(override, JSON.stringify(invalid)); expect(evaluateDistributionPreflight(reviewRequest).decision).toBe("BLOCK"); }
    fs.writeFileSync(override, JSON.stringify({ ...base, expires_at: "2026-08-24T11:30:00.000Z" })); expect(codes(reviewRequest)).toContain("OVERRIDE_EXPIRED");
    fs.writeFileSync(override, JSON.stringify({ ...base, generation_id: sha("other") })); expect(codes(reviewRequest)).toContain("OVERRIDE_IDENTITY_MISMATCH");
    fs.writeFileSync(override, JSON.stringify({ ...base, timeline_sha256: sha("other-timeline") })); expect(codes(reviewRequest)).toContain("OVERRIDE_IDENTITY_MISMATCH");
    fs.writeFileSync(override, JSON.stringify(base));
    for (const action of ["production_release", "publication", "public_upload"] as const) expect(evaluateDistributionPreflight({ ...reviewRequest, action }).decision).toBe("BLOCK");
  });
});
