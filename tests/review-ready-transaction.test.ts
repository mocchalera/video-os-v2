import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  buildReviewReadyReceipt,
  captureSocialReviewGeneration,
  prepareImmutableGeneration,
  promoteLatestGeneration,
  writeReviewReadyReceipt,
  hashCanonical,
} from "../runtime/review/social-review-generation.js";
import {
  audioReportFromReceipt,
  buildSocialReviewAudioReceipt,
  deriveSocialReviewAudioPlanIdentity,
} from "../runtime/review/social-review-audio.js";
import {
  FakeReviewAskAdapter,
  dispatchReviewAsk,
  finalizeReviewReady,
  recordReviewResponse,
  readCurrentReviewResponse,
  refreshReviewFreshness,
  type ReviewReadyInput,
} from "../runtime/review/review-ready-transaction.js";
import { runReviewReadyCli } from "../scripts/review-ready.js";
import {
  createVerifiedCollisionLayoutEvidence,
  socialReviewCollisionInputHashes,
} from "./helpers/social-review-collision-evidence.js";
import { writeCanonicalSocialReviewAudioPlan } from "./helpers/social-review-audio-plan.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function write(root: string, relative: string, bytes: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return relative;
}

let mediaFixture: { wav: Buffer; mp4: Buffer; silentMp4: Buffer } | undefined;
function mediaBytes(): { wav: Buffer; mp4: Buffer; silentMp4: Buffer } {
  if (mediaFixture) return mediaFixture;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-ready-media-"));
  const wav = path.join(root, "audio.wav");
  const mp4 = path.join(root, "video.mp4");
  const silentMp4 = path.join(root, "silent-video.mp4");
  for (const [command, args] of [
    ["ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-ac", "2", "-y", wav]],
    ["ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=1", "-i", wav, "-shortest", "-c:v", "libx264", "-c:a", "aac", "-y", mp4]],
    ["ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=1", "-c:v", "libx264", "-an", "-y", silentMp4]],
  ] as const) {
    const result = spawnSync(command, args);
    if (result.status !== 0) throw new Error(result.stderr.toString());
  }
  mediaFixture = { wav: fs.readFileSync(wav), mp4: fs.readFileSync(mp4), silentMp4: fs.readFileSync(silentMp4) };
  fs.rmSync(root, { recursive: true, force: true });
  return mediaFixture;
}

function fixture(options: { silent?: boolean; platform?: string; generatedCaptionIds?: boolean } = {}): { root: string; input: ReviewReadyInput; paths: Record<string, string> } {
  const silent = options.silent === true;
  const generatedCaptionIds = options.generatedCaptionIds === true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-ready-phase3-"));
  roots.push(root);
  const paths = {
    timeline: write(root, "05_timeline/timeline.json", JSON.stringify({ version: "2", sequence: { fps: 30 } })),
    sourceMap: write(root, "02_media/source_map.json", JSON.stringify({ version: "3", items: [] })),
    delivery: write(root, "04_plan/delivery.json", JSON.stringify({ id: "reel-vertical" })),
    framing: write(root, "04_plan/framing-policy.json", JSON.stringify({ lower_third_exclusion: true })),
    captionPolicy: write(root, "04_plan/caption-policy.json", JSON.stringify({ mode: "review_only" })),
    patch: write(root, "06_review/review_patch.json", "patch-v2"),
    mapping: write(root, "05_timeline/derived-frame-mapping.json", "mapping-v1"),
    reviewTimeline: write(root, "05_timeline/review-timeline.json", "review-timeline-v1"),
    visual: write(root, "06_review/visual-treatment.json", "visual-v1"),
    content: write(root, "06_review/content-plan.json", "content-v1"),
    audio: write(root, "06_review/audio-plan.json", "audio-v1"),
    renderer: write(root, "06_review/renderer-capability.json", "renderer-v1"),
    renderReport: "",
    captionPlan: "06_review/caption-preview-plan.json",
    sampleSheet: write(root, "06_review/sample-sheet.json", JSON.stringify({ samples: Array.from({ length: 6 }, (_, index) => ({
      clip_id: `clip-${index + 1}`,
      timestamp_frame: index * 120,
      inspection_space: index < 3 ? "source_frame" : "delivery_crop",
      measurement: { face_eye_line_ratio: 0.34 },
      allowed_range: { min: 0.3, max: 0.38 },
      status: "pass",
    })) })),
    storyboard: "04_plan/review-projections/p1/manifest.json",
  };
  const timelineHash = sha(fs.readFileSync(path.join(root, paths.timeline)));
  const captionCues = [
    { ...(generatedCaptionIds ? {} : { cue_id: "c1" }), text: "first", timeline_in_frame: 30, timeline_out_frame: 300 },
    { ...(generatedCaptionIds ? {} : { cue_id: "c2" }), text: "second", timeline_in_frame: 600, timeline_out_frame: 1500 },
  ];
  write(root, paths.captionPlan, JSON.stringify({ schema_version: "private-caption-plan/v2", base_timeline_version: "2", base_timeline_hash: timelineHash, review_only_unapproved: true, cues: captionCues }));
  const deliveryHash = sha(fs.readFileSync(path.join(root, paths.delivery)));
  write(root, paths.storyboard, JSON.stringify({
    version: "editorial-storyboard-projection/v1", projection_id: "p1", project_id: "phase3",
    generated_at: "2026-08-24T00:00:00.000Z", source_mode: "timeline", project_title: null,
    delivery: { mode: "single", ids: ["reel-vertical"], profiles: [{ profile_id: "reel-vertical", profile_name: "Reel vertical", platform: options.platform ?? "generic", path: paths.delivery, hash: deliveryHash, aspect_ratio: "9:16", resolution_width: 1080, resolution_height: 1920, fps_mode: "source", caption_mode: "burn_in" }] },
    inputs: [{ role: "timeline", path: paths.timeline, hash: timelineHash, required: true }, { role: "policy", path: paths.delivery, hash: deliveryHash, required: true }],
    artifact_hashes: { timeline: timelineHash },
    approval_identity: { artifact_hashes: { timeline: timelineHash }, delivery_hash: deliveryHash, beat_count: 1, total_frames: 1620 },
    review_diff_summary: { trims: ["intro +1 frame"], crops: ["6 sampled crops"] },
    canvas: { aspect_ratio_label: "9:16", aspect: 0.5625, width: 1080, height: 1920, fps_num: 30, fps_den: 1, basis: "delivery_profile" },
    fps: { num: 30, den: 1 }, policy_summaries: { music: "none", dialogue: "source", caption: "review only" }, caption_policy_language: null,
    beat_count: 1, total_frames: 1620, total_frames_basis: "timeline_span_frames", compiled_span_frames: 1620, timeline_end_frame: 1620,
    representative_frames: [], warnings: [], invalid: [], outputs: [], regenerate_command: "render-storyboard", generator: "render-editorial-storyboard",
  }));
  write(root, "project_state.yaml", "version: 1\nproject_id: phase3\ncurrent_state: timeline_drafted\ngates:\n  review_gate: blocked\nhistory: []\n");
  write(root, "progress.json", JSON.stringify({ project_id: "phase3", phase: "compile", gate: 4, status: "completed", completed: 1, total: 1, artifacts_created: [], errors: [], started_at: "2026-08-24T00:00:00.000Z", updated_at: "2026-08-24T00:00:00.000Z" }));

  const masteringPolicy = { loudness_target_lufs: -16, lra_target: 7, true_peak_target_dbtp: -1.5 };
  const canonicalAudioPlan = silent ? null : writeCanonicalSocialReviewAudioPlan({
    projectDir: root,
    projectId: "phase3",
    timelinePath: path.join(root, paths.timeline),
    policy: masteringPolicy,
  });
  const sharedAudioPlanHash = canonicalAudioPlan?.hash ?? null;
  const generation = captureSocialReviewGeneration({
    projectDir: root,
    projectId: "phase3",
    canonicalTimelineHash: timelineHash,
    acceptedPatchHash: sha(fs.readFileSync(path.join(root, paths.patch))),
    derivedMappingReceiptHash: sha(fs.readFileSync(path.join(root, paths.mapping))),
    reviewTimelineHash: sha(fs.readFileSync(path.join(root, paths.reviewTimeline))),
    captionTextTimingHash: hashCanonical(captionCues.map((cue) => ({ text: cue.text, in_frame: cue.timeline_in_frame, out_frame: cue.timeline_out_frame }))),
    visualTreatmentHash: sha(fs.readFileSync(path.join(root, paths.visual))),
    contentPlanHash: sha(fs.readFileSync(path.join(root, paths.content))),
    audioPlanHash: deriveSocialReviewAudioPlanIdentity({
      state: silent ? "not_applicable" : "mastered", sharedAudioPlanHash, policy: masteringPolicy,
    }),
    rendererCapabilityHash: sha(fs.readFileSync(path.join(root, paths.renderer))),
    ...socialReviewCollisionInputHashes(),
    sourceInputAttestation: {
      version: "source-input-attestation/v3", status: "verified", source_inputs_hash: sha("source-inputs").slice(7),
      source_inputs: [{ asset_id: "asset-1", media_kind: "video", content_sha256: sha("asset-1").slice(7), identity_status: "verified", render_input_identity: { relationship: "same_as_original", content_sha256: sha("asset-1").slice(7) } }],
      source_input_count: 1, persisted_source_input_count: 1, source_inputs_truncated: false,
      warnings: [], warning_count: 0, warnings_suppressed: 0,
      usage_policy: { include_video: true, include_audio: true }, timeline_hash: timelineHash.slice(7, 23),
    },
    files: [
      paths.timeline, paths.patch, paths.mapping, paths.reviewTimeline, paths.captionPlan,
      paths.visual, paths.content, paths.audio, paths.renderer, paths.delivery, paths.storyboard,
      ...(canonicalAudioPlan ? [{ logicalPath: "audio/shared-render-plan", filePath: canonicalAudioPlan.filePath }] : []),
    ],
  });
  expect(prepareImmutableGeneration(generation).status).toBe("owner");
  const premasterPath = path.join(generation.generation_dir, "work/audio/premaster_mix.wav");
  const masteredPath = path.join(generation.generation_dir, "work/audio/final_mix.wav");
  fs.mkdirSync(path.dirname(premasterPath), { recursive: true });
  const media = mediaBytes();
  let audioReceipt: ReturnType<typeof buildSocialReviewAudioReceipt>;
  if (silent) {
    fs.writeFileSync(generation.output_path, media.silentMp4);
    audioReceipt = buildSocialReviewAudioReceipt({
      state: "not_applicable",
      reason: "review_video_has_no_audio_stream",
      generationId: generation.generation_id,
      projectDir: root,
      reviewVideoPath: generation.output_path,
      policy: masteringPolicy,
    });
  } else {
    fs.writeFileSync(premasterPath, media.wav);
    fs.writeFileSync(masteredPath, media.wav);
    fs.writeFileSync(generation.output_path, media.mp4);
    audioReceipt = buildSocialReviewAudioReceipt({
      state: "mastered",
      generationId: generation.generation_id,
      sharedAudioPlanHash: sharedAudioPlanHash!,
      projectDir: root,
      inputAudioPath: premasterPath,
      outputAudioPath: masteredPath,
      reviewVideoPath: generation.output_path,
      policy: masteringPolicy,
      masteringCount: 1,
      inputKind: "premaster",
    });
  }
  const audioEvidence = write(
    root,
    path.relative(root, path.join(generation.generation_dir, "audio-mastering-receipt.json")),
    `${JSON.stringify(audioReceipt, null, 2)}\n`,
  );
  paths.renderReport = write(root, path.relative(root, path.join(generation.generation_dir, "social-review-report.json")), JSON.stringify({
    version: "social-review-render/v3", generation_id: generation.generation_id,
    output_sha256: sha(fs.readFileSync(generation.output_path)), duration_frames: 1620, duration_sec: 54,
    fps_num: 30, fps_den: 1, width: 1080, height: 1920, audio_present: !silent, bgm_present: false, gap_free: true,
    audio_mastering: audioReportFromReceipt(audioReceipt),
  }));
  const layerEvidence = write(root, path.relative(root, path.join(generation.generation_dir, "work/layer-qa.json")), "layer-ok");
  const receipt = buildReviewReadyReceipt(generation, generation.output_path, {
    output: { status: "verified", duration_sec: 54, width: 1080, height: 1920, issues: [], scans: { decode: { status: "complete" }, black: { status: "complete", detections: [] }, freeze: { status: "complete", detections: [] }, layout_inset: { status: "complete", detections: [] } } },
    ...createVerifiedCollisionLayoutEvidence(
      generation,
      "ready",
      generatedCaptionIds ? ["social-caption-0001", "social-caption-0002"] : undefined,
    ),
    audio: { status: "verified", evidence: { path: audioEvidence, sha256: sha(fs.readFileSync(path.join(root, audioEvidence))) } },
    layers: { status: "verified", evidence: [{ path: layerEvidence, sha256: sha(fs.readFileSync(path.join(root, layerEvidence))) }] },
  }, path.join(root, paths.renderReport));
  writeReviewReadyReceipt(generation, receipt);
  promoteLatestGeneration(generation, receipt);

  const input: ReviewReadyInput = {
    projectDir: root,
    generationId: generation.generation_id,
    artifacts: {
      timeline: paths.timeline, source_map: paths.sourceMap, delivery: paths.delivery,
      framing_policy: paths.framing, caption_policy: paths.captionPolicy,
      caption_plan: paths.captionPlan, render_report: paths.renderReport,
      sample_sheet: paths.sampleSheet, storyboard_manifest: paths.storyboard,
    },
    technical: { duration_frames: 1620, duration_seconds: 54, fps: { num: 30, den: 1 }, resolution: { width: 1080, height: 1920 }, audio_stream: silent ? "absent" : "present", bgm: "absent" },
    gaps: { primary_video: { status: "pass", count: 0 }, audio: { status: "pass", count: 0 }, freeze: { status: "pass", count: 0 }, black: { status: "pass", count: 0 } },
    source: { attestation_status: "verified", unresolved_media: [] },
    framing: {
      coverage: "sampled",
      samples: Array.from({ length: 6 }, (_, index) => ({ clip_id: `clip-${index + 1}`, timestamp_frame: index * 120, inspection_space: index < 3 ? "source_frame" : "delivery_crop", measurement: { face_eye_line_ratio: 0.34 }, allowed_range: { min: 0.3, max: 0.38 }, status: "pass" as const })),
    },
    captions: { cue_count: 2, display_range: { first_frame: 30, last_frame: 1500 }, safe_rect: { x: 0.08, y: 0.08, width: 0.84, height: 0.7 }, collision_status: "pass", transcript_grounding: "unverified", evidence_level: "policy_only", platform_safety_claims: [] },
    coverage: { video: "full_frame", audio: "full_frame", framing: "sampled", captions: "sampled" },
    findings: { pass: ["gap-free"], warnings: ["platform geometry not measured"], blockers: [], human_residual: [] },
    reviewSummary: { projection_id: "p1", trims: ["intro +1 frame"], crops: ["6 sampled crops"], captions: ["2 review-only cues"] },
  };
  return { root, input, paths };
}

describe("Issue #8 atomic review-ready transaction", () => {
  it("opens review only for a gap-free immutable generation with every required artifact", () => {
    const { root, input } = fixture();
    const result = finalizeReviewReady(input);
    expect(result.receipt.version).toBe("review-qa-receipt/v1");
    expect(result.receipt.status).toBe("warning");
    expect(result.receipt.identity.generation_id).toBe(input.generationId);
    expect(result.receipt.identity.timeline_sha256).toBe(sha(fs.readFileSync(path.join(root, input.artifacts.timeline))));
    expect(validateAgainstSchema(result.receipt, "review-qa-receipt.schema.json").valid).toBe(true);
    expect(parseYaml(fs.readFileSync(path.join(root, "project_state.yaml"), "utf8"))).toMatchObject({ current_state: "review_ready", gates: { review_gate: "open" }, review_transaction: { review_identity: result.reviewIdentity, status: "ready" } });
    expect(JSON.parse(fs.readFileSync(path.join(root, "progress.json"), "utf8"))).toMatchObject({ phase: "review", status: "completed", review_identity: result.reviewIdentity, review_status: "ready" });
    expect(JSON.parse(fs.readFileSync(path.join(root, "06_review/review-ask.json"), "utf8"))).toMatchObject({ review_identity: result.reviewIdentity, status: "pending" });
  });

  it("derives a deterministic identity and keeps every new nested schema strict", () => {
    const first = fixture();
    const second = fixture();
    const left = finalizeReviewReady(first.input);
    const right = finalizeReviewReady(second.input);
    expect(right.reviewIdentity).toBe(left.reviewIdentity);
    expect(validateAgainstSchema({ ...left.receipt, identity: { ...left.receipt.identity, surprise: true } }, "review-qa-receipt.schema.json").valid).toBe(false);
    expect(validateAgainstSchema({ ...left.receipt, artifacts: { ...left.receipt.artifacts, timeline: { ...left.receipt.artifacts.timeline, surprise: true } } }, "review-qa-receipt.schema.json").valid).toBe(false);
    const readyState = JSON.parse(fs.readFileSync(path.join(first.root, "06_review/review-ready-state.json"), "utf8"));
    const ask = JSON.parse(fs.readFileSync(path.join(first.root, "06_review/review-ask.json"), "utf8"));
    expect(validateAgainstSchema({ ...readyState, artifacts: { ...readyState.artifacts, surprise: true } }, "review-ready-state.schema.json").valid).toBe(false);
    expect(validateAgainstSchema({ ...ask, payload: { ...ask.payload, storyboard: { ...ask.payload.storyboard, surprise: true } } }, "review-ask-dispatch.schema.json").valid).toBe(false);
  });

  it("rejects project traversal and symlink escape for every bound artifact", () => {
    const traversal = fixture();
    traversal.input.artifacts.sample_sheet = "../outside.json";
    expect(() => finalizeReviewReady(traversal.input)).toThrow(/project-relative and contained/i);

    const escaped = fixture();
    const outside = path.join(os.tmpdir(), `review-outside-${Date.now()}.json`);
    fs.writeFileSync(outside, "{}");
    const link = path.join(escaped.root, "06_review/escaped-sample.json");
    fs.symlinkSync(outside, link);
    escaped.input.artifacts.sample_sheet = "06_review/escaped-sample.json";
    expect(() => finalizeReviewReady(escaped.input)).toThrow(/not contained/i);
    fs.unlinkSync(outside);
  });

  it("refuses a different receipt for the same identity and marks tampered QA receipt STALE", () => {
    const immutable = fixture();
    const ready = finalizeReviewReady(immutable.input);
    const receiptPath = path.join(immutable.root, "09_output/social-review/generations", immutable.input.generationId.slice(7), "review-qa-receipt.json");
    fs.appendFileSync(receiptPath, "tampered");
    expect(() => finalizeReviewReady(immutable.input)).toThrow(/immutable review QA receipt overwrite refused/i);
    expect(parseYaml(fs.readFileSync(path.join(immutable.root, "project_state.yaml"), "utf8"))).toMatchObject({ current_state: "review_failed", gates: { review_gate: "blocked" } });

    const stale = fixture();
    const staleReady = finalizeReviewReady(stale.input);
    const staleReceiptPath = path.join(stale.root, "09_output/social-review/generations", stale.input.generationId.slice(7), "review-qa-receipt.json");
    fs.appendFileSync(staleReceiptPath, "tampered");
    expect(refreshReviewFreshness(stale.root)).toMatchObject({ status: "stale", review_identity: staleReady.reviewIdentity, artifacts: { preview: "STALE", qa_receipt: "STALE", unanswered_ask: "STALE" } });
    expect(ready.reviewIdentity).toBe(staleReady.reviewIdentity);
  });

  it("rejects a same-version different-hash caption plan and missing required artifacts fail closed", () => {
    const stale = fixture();
    const planPath = path.join(stale.root, stale.paths.captionPlan);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    plan.base_timeline_hash = sha("different-v2-bytes");
    fs.writeFileSync(planPath, JSON.stringify(plan));
    expect(() => finalizeReviewReady(stale.input)).toThrow(/caption plan.*timeline hash|generation input logical path changed/i);
    expect(parseYaml(fs.readFileSync(path.join(stale.root, "project_state.yaml"), "utf8"))).toMatchObject({ current_state: "review_failed", gates: { review_gate: "blocked" } });

    const missing = fixture();
    fs.unlinkSync(path.join(missing.root, missing.paths.sampleSheet));
    expect(() => finalizeReviewReady(missing.input)).toThrow(/sample.sheet|missing/i);
    expect(parseYaml(fs.readFileSync(path.join(missing.root, "project_state.yaml"), "utf8"))).toMatchObject({ current_state: "review_failed", gates: { review_gate: "blocked" } });
  });

  it("rejects caption content not bound by the generation and caller-invented technical QA", () => {
    const captionMismatch = fixture();
    const latestPath = path.join(captionMismatch.root, "09_output/social-review/latest.json");
    const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
    const receiptPath = path.join(captionMismatch.root, latest.receipt_path);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    receipt.inputs.caption_text_timing_sha256 = sha("different-caption-text-and-timing");
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    latest.receipt_sha256 = sha(fs.readFileSync(receiptPath));
    fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2) + "\n");
    expect(() => finalizeReviewReady(captionMismatch.input)).toThrow(/caption.*generation|generation identity mismatch/i);

    const invented = fixture();
    invented.input.technical = { duration_frames: 999, duration_seconds: 999, fps: { num: 1, den: 1 }, resolution: { width: 7, height: 9 }, audio_stream: "absent", bgm: "present" };
    expect(() => finalizeReviewReady(invented.input)).toThrow(/technical.*verified|duration.*generation|render report/i);
  });

  it("rejects blocked source attestation, unresolved media, and delivery mismatch despite caller claims", () => {
    const blocked = fixture();
    const latest = JSON.parse(fs.readFileSync(path.join(blocked.root, "09_output/social-review/latest.json"), "utf8"));
    const receiptPath = path.join(blocked.root, latest.receipt_path);
    const generationReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const attestationPath = path.join(blocked.root, generationReceipt.source_input_attestation.path);
    const invalidAttestation = { version: "source-input-attestation/v3", status: "blocked", unresolved_media: ["asset-missing"], delivery_id: "other-delivery" };
    fs.writeFileSync(attestationPath, JSON.stringify(invalidAttestation));
    generationReceipt.source_input_attestation.sha256 = sha(fs.readFileSync(attestationPath));
    generationReceipt.inputs.source_input_attestation_sha256 = hashCanonical(invalidAttestation);
    fs.writeFileSync(receiptPath, JSON.stringify(generationReceipt, null, 2) + "\n");
    latest.receipt_sha256 = sha(fs.readFileSync(receiptPath));
    fs.writeFileSync(path.join(blocked.root, "09_output/social-review/latest.json"), JSON.stringify(latest, null, 2) + "\n");
    expect(() => finalizeReviewReady(blocked.input)).toThrow(/source.*attestation|unresolved|delivery|schema|generation identity mismatch/i);

    const deliveryMismatch = fixture();
    deliveryMismatch.input.artifacts.delivery = write(deliveryMismatch.root, "04_plan/other-delivery.json", JSON.stringify({ id: "other-delivery" }));
    expect(() => finalizeReviewReady(deliveryMismatch.input)).toThrow(/delivery.*(identity|bound|generation)/i);
  });

  it("rejects invalid or incomplete storyboard manifests and caller-authored diff summaries", () => {
    const invalid = fixture();
    fs.writeFileSync(path.join(invalid.root, invalid.paths.storyboard), JSON.stringify({
      version: "editorial-storyboard-projection/v1", projection_id: "p1",
      inputs: [{ role: "timeline", path: "05_timeline/missing.json", hash: sha("missing"), required: true }],
      invalid: ["canonical inputs stale"],
      review_diff_summary: invalid.input.reviewSummary,
    }));
    expect(() => finalizeReviewReady(invalid.input)).toThrow(/storyboard.*(invalid|missing|stale)|generation input logical path changed/i);

    const arbitrary = fixture();
    arbitrary.input.reviewSummary.trims = ["invented trim summary"];
    expect(() => finalizeReviewReady(arbitrary.input)).toThrow(/diff summary|review summary/i);

    const selfReported = fixture();
    const manifestPath = path.join(selfReported.root, selfReported.paths.storyboard);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.inputs;
    manifest.review_diff_summary = { trims: ["invented trim summary"], crops: ["invented crop summary"] };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    selfReported.input.reviewSummary = {
      projection_id: "p1",
      trims: ["invented trim summary"],
      crops: ["invented crop summary"],
      captions: ["2 review-only cues"],
    };
    expect(() => finalizeReviewReady(selfReported.input)).toThrow(/storyboard.*(input|provenance|summary|hash|schema)|generation input logical path changed/i);
  });

  it("rejects a self-consistent manifest and receipt rewrite when the generation ID is not rederived", () => {
    const changed = fixture();
    const manifestPath = path.join(changed.root, changed.paths.storyboard);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.review_diff_summary = { trims: ["rewritten trim"], crops: ["rewritten crop"] };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    changed.input.reviewSummary = { projection_id: "p1", trims: ["rewritten trim"], crops: ["rewritten crop"], captions: ["2 review-only cues"] };

    const latestPath = path.join(changed.root, "09_output/social-review/latest.json");
    const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
    const receiptPath = path.join(changed.root, latest.receipt_path);
    const generationReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const manifestHash = sha(fs.readFileSync(manifestPath));
    const manifestInput = generationReceipt.input_files.find((entry: { locator: string }) => entry.locator === `project:${changed.paths.storyboard}`);
    expect(manifestInput).toBeDefined();
    manifestInput.sha256 = manifestHash;
    fs.writeFileSync(receiptPath, JSON.stringify(generationReceipt, null, 2) + "\n");
    latest.receipt_sha256 = sha(fs.readFileSync(receiptPath));
    fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2) + "\n");

    expect(() => finalizeReviewReady(changed.input)).toThrow(/generation.*(derived|canonical|identity|mismatch)/i);
    expect(parseYaml(fs.readFileSync(path.join(changed.root, "project_state.yaml"), "utf8"))).toMatchObject({ current_state: "review_failed", gates: { review_gate: "blocked" } });
  });

  it("keeps sampled framing honest and never converts policy-only evidence into SNS safety", () => {
    const { input } = fixture();
    const result = finalizeReviewReady(input);
    expect(result.receipt.framing.coverage).toBe("sampled");
    expect(result.receipt.framing.samples).toHaveLength(6);
    expect(new Set(result.receipt.framing.samples.map((sample) => sample.inspection_space))).toEqual(new Set(["source_frame", "delivery_crop"]));
    expect(result.receipt.captions.evidence_level).toBe("policy_only");
    expect(result.receipt.captions.platform_safety_claims).toEqual([]);

    const unsafe = fixture();
    unsafe.input.captions.platform_safety_claims = ["Instagram safe"];
    expect(() => finalizeReviewReady(unsafe.input)).toThrow(/policy.only.*platform safety/i);
  });

  it("derives technical and editorial QA from bound evidence instead of caller fields", () => {
    const mutations: Array<(input: ReviewReadyInput) => void> = [
      (input) => { input.gaps.primary_video.count = 1; },
      (input) => { input.gaps.audio.status = "warning"; },
      (input) => { input.gaps.freeze.count = 1; },
      (input) => { input.gaps.black.count = 1; },
      (input) => { input.findings.pass = ["forged pass"]; },
      (input) => { input.findings.human_residual = ["invented human residual"]; },
    ];
    for (const mutate of mutations) {
      const forged = fixture();
      mutate(forged.input);
      expect(() => finalizeReviewReady(forged.input)).toThrow(/immutable|evidence|findings|QA/i);
    }

    const framing = fixture();
    framing.input.framing.samples[0] = { ...framing.input.framing.samples[0], clip_id: "replacement-clip" };
    expect(() => finalizeReviewReady(framing.input)).toThrow(/framing evidence/i);

    const safeRect = fixture();
    safeRect.input.captions.safe_rect = { ...safeRect.input.captions.safe_rect, x: 0.09 };
    expect(() => finalizeReviewReady(safeRect.input)).toThrow(/caption safe_rect/i);

    const collision = fixture();
    collision.input.captions.collision_status = "warning";
    expect(() => finalizeReviewReady(collision.input)).toThrow(/caption collision_status/i);

    const coverage = fixture();
    coverage.input.coverage.captions = "full_frame";
    expect(() => finalizeReviewReady(coverage.input)).toThrow(/coverage/i);

    const transcript = fixture();
    transcript.input.captions.transcript_grounding = "verified";
    expect(() => finalizeReviewReady(transcript.input)).toThrow(/transcript_grounding/i);
  });

  it("accepts a production-shaped caption plan with renderer-generated layer identities", () => {
    const productionShape = fixture({ generatedCaptionIds: true });
    const plan = JSON.parse(fs.readFileSync(path.join(productionShape.root, productionShape.paths.captionPlan), "utf8"));
    expect(plan.cues).toEqual([
      { text: "first", timeline_in_frame: 30, timeline_out_frame: 300 },
      { text: "second", timeline_in_frame: 600, timeline_out_frame: 1500 },
    ]);
    const result = finalizeReviewReady(productionShape.input);
    expect(result.receipt.captions.cue_count).toBe(2);
    expect(result.receipt.coverage.captions).toBe("sampled");
  });

  it("fails closed on a bound framing blocker without changing the generation receipt", () => {
    const blocked = fixture();
    const latest = JSON.parse(fs.readFileSync(path.join(blocked.root, "09_output/social-review/latest.json"), "utf8"));
    const generationReceiptPath = path.join(blocked.root, latest.receipt_path);
    const generationReceiptBefore = fs.readFileSync(generationReceiptPath, "utf8");
    const sampleSheetPath = path.join(blocked.root, blocked.paths.sampleSheet);
    const sampleSheet = JSON.parse(fs.readFileSync(sampleSheetPath, "utf8"));
    sampleSheet.samples[0].status = "blocker";
    fs.writeFileSync(sampleSheetPath, JSON.stringify(sampleSheet));
    expect(() => finalizeReviewReady(blocked.input)).toThrow(/derived review QA has blockers/i);
    expect(fs.readFileSync(generationReceiptPath, "utf8")).toBe(generationReceiptBefore);
  });

  it("accepts a verified silent generation without treating verified audio as present", () => {
    const { root, input } = fixture({ silent: true });
    const result = finalizeReviewReady(input);
    expect(result.receipt.technical.audio_stream).toBe("absent");
    expect(result.receipt.gaps.audio).toEqual({ status: "pass", count: 0 });
    expect(result.receipt.coverage.audio).toBe("full_frame");
    const latest = JSON.parse(fs.readFileSync(path.join(root, "09_output/social-review/latest.json"), "utf8"));
    const generation = JSON.parse(fs.readFileSync(path.join(root, latest.receipt_path), "utf8"));
    const audioReceipt = JSON.parse(fs.readFileSync(path.join(root, generation.qa.audio.evidence.path), "utf8"));
    expect(audioReceipt).toMatchObject({ state: "not_applicable", reason: "review_video_has_no_audio_stream", review_video_audio: { state: "absent" } });
  });

  it("does not upgrade project-only geometry policy to a named platform claim", () => {
    const namedPlatform = fixture({ platform: "instagram_reels" });
    const result = finalizeReviewReady(namedPlatform.input);
    expect(result.receipt.captions.evidence_level).toBe("policy_only");
    expect(result.receipt.captions.platform_safety_claims).toEqual([]);
  });

  it.each(["timeline", "caption_plan", "framing_policy", "audio-plan", "visual-treatment"])("marks preview, QA receipt, and unanswered Ask STALE after %s mutation", (kind) => {
    const { root, input, paths } = fixture();
    const ready = finalizeReviewReady(input);
    const relative = kind === "timeline" ? paths.timeline
      : kind === "caption_plan" ? paths.captionPlan
      : kind === "framing_policy" ? paths.framing
      : kind === "audio-plan" ? paths.audio
      : paths.visual;
    fs.appendFileSync(path.join(root, relative), kind === "timeline" ? "\n" : "-mutated");
    const stale = refreshReviewFreshness(root);
    expect(stale.status).toBe("stale");
    expect(stale.review_identity).toBe(ready.reviewIdentity);
    expect(stale.artifacts).toEqual({ preview: "STALE", qa_receipt: "STALE", unanswered_ask: "STALE" });
    expect(parseYaml(fs.readFileSync(path.join(root, "project_state.yaml"), "utf8"))).toMatchObject({ current_state: "review_pending", gates: { review_gate: "blocked" }, review_transaction: { status: "stale" } });
  });

  it("uses one Ask per identity across post-create failure, successful retry, and further retries", async () => {
    const { root, input } = fixture();
    const ready = finalizeReviewReady(input);
    const adapter = new FakeReviewAskAdapter({ failAfterCreateOnce: true });
    await expect(dispatchReviewAsk(root, adapter)).rejects.toThrow(/synthetic dispatch failure/i);
    expect(adapter.createdCount).toBe(1);
    const retried = await dispatchReviewAsk(root, adapter);
    const repeated = await dispatchReviewAsk(root, adapter);
    expect(adapter.createdCount).toBe(1);
    expect(retried.ask_id).toBe(repeated.ask_id);
    expect(adapter.requests[0].idempotencyKey).toBe(ready.reviewIdentity);
    expect(adapter.requests[0].payload).toMatchObject({ media: { locator: expect.stringContaining("review.mp4") }, duration_seconds: 54, bgm: "absent", caption_count: 2, choices: ["approve", "request_changes", "free_text"], storyboard: { projection_id: "p1" } });
  });

  it("rejects a different payload for the same Ask idempotency key before retry dispatch", async () => {
    const { root, input } = fixture();
    finalizeReviewReady(input);
    const adapter = new FakeReviewAskAdapter({ failAfterCreateOnce: true });
    await expect(dispatchReviewAsk(root, adapter)).rejects.toThrow(/synthetic dispatch failure/i);
    const askPath = path.join(root, "06_review/review-ask.json");
    const ask = JSON.parse(fs.readFileSync(askPath, "utf8"));
    ask.payload.duration_seconds = 999;
    fs.writeFileSync(askPath, JSON.stringify(ask, null, 2) + "\n");
    await expect(dispatchReviewAsk(root, adapter)).rejects.toThrow(/payload.*(hash|idempotency)/i);
    expect(adapter.createdCount).toBe(1);
  });

  it("rejects a tampered persisted payload before the dispatched idempotent return", async () => {
    const { root, input } = fixture();
    finalizeReviewReady(input);
    const adapter = new FakeReviewAskAdapter();
    await dispatchReviewAsk(root, adapter);
    const askPath = path.join(root, "06_review/review-ask.json");
    const ask = JSON.parse(fs.readFileSync(askPath, "utf8"));
    ask.payload.duration_seconds = 999;
    fs.writeFileSync(askPath, JSON.stringify(ask, null, 2) + "\n");
    await expect(dispatchReviewAsk(root, adapter)).rejects.toThrow(/payload.*(hash|idempotency)/i);
    expect(adapter.createdCount).toBe(1);
    expect(adapter.requests).toHaveLength(1);
  });

  it("rolls back every injected commit-point failure to one closed failed identity", () => {
    for (let point = 0; point < 5; point += 1) {
      const { root, input } = fixture();
      expect(() => finalizeReviewReady(input, { failAtCommitPoint: point })).toThrow(/injected commit failure/i);
      const state = parseYaml(fs.readFileSync(path.join(root, "project_state.yaml"), "utf8")) as any;
      const progress = JSON.parse(fs.readFileSync(path.join(root, "progress.json"), "utf8"));
      const gate = JSON.parse(fs.readFileSync(path.join(root, "06_review/review-ready-state.json"), "utf8"));
      const ask = JSON.parse(fs.readFileSync(path.join(root, "06_review/review-ask.json"), "utf8"));
      const identities = [state.review_transaction.review_identity, progress.review_identity, gate.review_identity, ask.review_identity];
      expect(new Set(identities).size).toBe(1);
      expect(state).toMatchObject({ current_state: "review_failed", gates: { review_gate: "blocked" }, review_transaction: { status: "failed" } });
      expect(gate.status).toBe("failed");
      expect(ask.status).toBe("blocked");
    }
  });

  it("recovers a real process interruption after a final-bundle rename to one closed identity", () => {
    for (let point = 0; point < 5; point += 1) {
      const { root, input } = fixture();
      const modulePath = path.resolve("runtime/review/review-ready-transaction.ts");
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
        const { finalizeReviewReady } = await import(${JSON.stringify(modulePath)});
        const input = JSON.parse(process.env.REVIEW_READY_INPUT);
        finalizeReviewReady(input, { interruptAfterCommitPoint: ${point} });
      `], { cwd: process.cwd(), env: { ...process.env, REVIEW_READY_INPUT: JSON.stringify(input) } });
      expect(child.signal).toBe("SIGKILL");
      expect(fs.existsSync(path.join(root, "06_review/review-transaction-journal.json"))).toBe(true);

      const recovered = refreshReviewFreshness(root);
      const projectState = parseYaml(fs.readFileSync(path.join(root, "project_state.yaml"), "utf8")) as any;
      const progress = JSON.parse(fs.readFileSync(path.join(root, "progress.json"), "utf8"));
      const ask = JSON.parse(fs.readFileSync(path.join(root, "06_review/review-ask.json"), "utf8"));
      expect(new Set([projectState.review_transaction.review_identity, progress.review_identity, recovered.review_identity, ask.review_identity]).size).toBe(1);
      expect(projectState).toMatchObject({ current_state: "review_failed", gates: { review_gate: "blocked" }, review_transaction: { status: "failed" } });
      expect(recovered).toMatchObject({ status: "failed", qa_receipt: null });
      expect(ask.status).toBe("blocked");
      expect(fs.existsSync(path.join(root, "06_review/review-transaction-journal.json"))).toBe(false);
    }
  }, 60_000);

  it.each(["partial-json", "unknown-field"])("closes mixed state when the prepared journal is %s", (corruption) => {
    const { root, input } = fixture();
    const modulePath = path.resolve("runtime/review/review-ready-transaction.ts");
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      const { finalizeReviewReady } = await import(${JSON.stringify(modulePath)});
      finalizeReviewReady(JSON.parse(process.env.REVIEW_READY_INPUT), { interruptAfterCommitPoint: 2 });
    `], { cwd: process.cwd(), env: { ...process.env, REVIEW_READY_INPUT: JSON.stringify(input) } });
    expect(child.signal).toBe("SIGKILL");
    const marker = path.join(root, "06_review/review-transaction-journal.json");
    const raw = fs.readFileSync(marker, "utf8");
    if (corruption === "partial-json") {
      fs.writeFileSync(marker, raw.slice(0, raw.indexOf('"targets"') + 12));
    } else {
      fs.writeFileSync(marker, JSON.stringify({ ...JSON.parse(raw), surprise: true }, null, 2) + "\n");
    }

    const recovered = refreshReviewFreshness(root);
    const projectState = parseYaml(fs.readFileSync(path.join(root, "project_state.yaml"), "utf8")) as any;
    const progress = JSON.parse(fs.readFileSync(path.join(root, "progress.json"), "utf8"));
    const ask = JSON.parse(fs.readFileSync(path.join(root, "06_review/review-ask.json"), "utf8"));
    expect(new Set([projectState.review_transaction.review_identity, progress.review_identity, recovered.review_identity, ask.review_identity]).size).toBe(1);
    expect(projectState).toMatchObject({ current_state: "review_failed", gates: { review_gate: "blocked" }, review_transaction: { status: "failed" } });
    expect(recovered).toMatchObject({ status: "failed", qa_receipt: null });
    expect(ask.status).toBe("blocked");
    expect(fs.existsSync(marker)).toBe(false);

    const retried = finalizeReviewReady(input);
    expect(retried.receipt.identity.generation_id).toBe(input.generationId);
    expect(refreshReviewFreshness(root).status).toBe("ready");
  });

  it("rejects stale or tampered human responses instead of approving a new generation", async () => {
    const { root, input, paths } = fixture();
    const ready = finalizeReviewReady(input);
    const adapter = new FakeReviewAskAdapter();
    const ask = await dispatchReviewAsk(root, adapter);
    const bound = { review_identity: ready.reviewIdentity, generation_id: input.generationId, video_sha256: ready.receipt.identity.video_sha256, timeline_sha256: ready.receipt.identity.timeline_sha256 };
    expect((await recordReviewResponse(root, { ...bound, ask_id: ask.ask_id!, decision: "approve", text: null })).decision).toBe("approve");

    for (const field of ["review_identity", "generation_id", "video_sha256", "timeline_sha256"] as const) {
      const changed = fixture();
      const current = finalizeReviewReady(changed.input);
      const currentAsk = await dispatchReviewAsk(changed.root, new FakeReviewAskAdapter());
      await expect(recordReviewResponse(changed.root, { review_identity: current.reviewIdentity, generation_id: changed.input.generationId, video_sha256: current.receipt.identity.video_sha256, timeline_sha256: current.receipt.identity.timeline_sha256, ask_id: currentAsk.ask_id!, decision: "approve", text: null, [field]: sha("tampered") })).rejects.toThrow(/response.*binding/i);
    }

    const stale = fixture();
    const staleReady = finalizeReviewReady(stale.input);
    const staleAsk = await dispatchReviewAsk(stale.root, new FakeReviewAskAdapter());
    fs.appendFileSync(path.join(stale.root, paths.timeline), "one-frame-equivalent");
    refreshReviewFreshness(stale.root);
    await expect(recordReviewResponse(stale.root, { review_identity: staleReady.reviewIdentity, generation_id: stale.input.generationId, video_sha256: staleReady.receipt.identity.video_sha256, timeline_sha256: staleReady.receipt.identity.timeline_sha256, ask_id: staleAsk.ask_id!, decision: "approve", text: null })).rejects.toThrow(/stale/i);
  });

  it("marks a responded Ask and approval receipt stale when canonical identity changes", async () => {
    const { root, input, paths } = fixture();
    const ready = finalizeReviewReady(input);
    const ask = await dispatchReviewAsk(root, new FakeReviewAskAdapter());
    await recordReviewResponse(root, {
      review_identity: ready.reviewIdentity,
      generation_id: input.generationId,
      video_sha256: ready.receipt.identity.video_sha256,
      timeline_sha256: ready.receipt.identity.timeline_sha256,
      ask_id: ask.ask_id!, decision: "approve", text: null,
    });
    fs.appendFileSync(path.join(root, paths.timeline), "one-frame-equivalent");
    refreshReviewFreshness(root);
    expect(JSON.parse(fs.readFileSync(path.join(root, "06_review/review-ask.json"), "utf8"))).toMatchObject({ status: "stale" });
    expect(JSON.parse(fs.readFileSync(path.join(root, "06_review/review-response.json"), "utf8"))).toMatchObject({ status: "stale", invalid_for_current: true });
    expect(() => readCurrentReviewResponse(root)).toThrow(/stale|invalid.*current/i);
  });

  it("dispatches through the injected CLI adapter and records all exact resolved response mappings", async () => {
    for (const [eventAnswer, decision, text] of [
      [{ type: "choice", value: "approve" }, "approve", null],
      [{ type: "choice", value: "request_changes" }, "request_changes", null],
      [{ type: "input", value: "Please revise the opening." }, "free_text", "Please revise the opening."],
    ] as const) {
      const { root, input } = fixture();
      const ready = finalizeReviewReady(input);
      const adapter = new FakeReviewAskAdapter();
      const useFactory = decision === "request_changes";
      const ask = await runReviewReadyCli(["dispatch", "--project", root], useFactory
        ? { adapterFactory: (projectDir) => { expect(projectDir).toBe(root); return adapter; } }
        : { adapter }) as { ask_id: string };
      expect(ask.ask_id).toMatch(/^fake-ask-/);
      const event = {
        event: "cockpit.ask.resolved", version: 1, ask_id: ask.ask_id, outcome: "answered", answered_by: "user", answers: [eventAnswer],
      };
      const eventPath = path.join(root, "resolved-event.json");
      fs.writeFileSync(eventPath, JSON.stringify(event) + "\n");
      const response = eventAnswer.type === "input"
        ? await runReviewReadyCli(["record-response", "--project", root, "--event-stdin"], { eventStdin: JSON.stringify(event) })
        : await runReviewReadyCli(["record-response", "--project", root, "--event", eventPath]);
      expect(response).toMatchObject({ review_identity: ready.reviewIdentity, ask_id: ask.ask_id, decision, text, status: "current" });
    }
  });

  it("rejects malformed, attached, unknown, and stale resolved events without accepting a response", async () => {
    const { root, input, paths } = fixture();
    finalizeReviewReady(input);
    const adapter = new FakeReviewAskAdapter();
    const ask = await runReviewReadyCli(["dispatch", "--project", root], { adapter }) as { ask_id: string };
    const eventPath = path.join(root, "resolved-event.json");
    fs.writeFileSync(eventPath, JSON.stringify({ ask_id: ask.ask_id, decision: "approve", text: null }) + "\n");
    await expect(runReviewReadyCli(["record-response", "--project", root, "--event", eventPath])).rejects.toThrow(/unexpected or missing|resolved Cockpit/i);
    expect(fs.existsSync(path.join(root, "06_review/review-response.json"))).toBe(false);

    fs.writeFileSync(eventPath, JSON.stringify({
      event: "cockpit.ask.resolved", version: 1, ask_id: ask.ask_id, outcome: "answered", answered_by: "user", answers: [{ type: "input", value: "   ", attachments: [] }],
    }) + "\n");
    await expect(runReviewReadyCli(["record-response", "--project", root, "--event", eventPath])).rejects.toThrow(/exact|nonblank|fields|free-form/i);
    expect(fs.existsSync(path.join(root, "06_review/review-response.json"))).toBe(false);

    fs.writeFileSync(eventPath, JSON.stringify({
      event: "cockpit.ask.resolved", version: 1, ask_id: "ask-unknown", outcome: "answered", answered_by: "user", answers: [{ type: "choice", value: "approve" }],
    }) + "\n");
    await expect(runReviewReadyCli(["record-response", "--project", root, "--event", eventPath])).rejects.toThrow(/Ask ID|current dispatched/i);
    fs.appendFileSync(path.join(root, paths.timeline), "one-frame-equivalent");
    await expect(runReviewReadyCli(["record-response", "--project", root, "--event", eventPath])).rejects.toThrow(/stale|current/i);
  });
});
