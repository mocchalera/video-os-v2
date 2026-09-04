import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hashCanonical } from "../../runtime/review/social-review-generation.js";
import {
  buildReviewReadyReceipt,
  captureSocialReviewGeneration,
  prepareImmutableGeneration,
  promoteLatestGeneration,
  writeReviewReadyReceipt,
} from "../../runtime/review/social-review-generation.js";
import {
  audioReportFromReceipt,
  buildSocialReviewAudioReceipt,
  deriveSocialReviewAudioPlanIdentity,
} from "../../runtime/review/social-review-audio.js";
import {
  FakeReviewAskAdapter,
  dispatchReviewAsk,
  finalizeReviewReady,
  recordReviewResponse,
  type ReviewReadyInput,
} from "../../runtime/review/review-ready-transaction.js";
import {
  createVerifiedCollisionLayoutEvidence,
  socialReviewCollisionInputHashes,
} from "./social-review-collision-evidence.js";
import { writeCanonicalSocialReviewAudioPlan } from "./social-review-audio-plan.js";
import { readReviewRoundLedger, reviewRoundIdentity } from "../../runtime/review/review-rounds-ledger.js";

/**
 * Real-flow review-round project fixture: builds a canonical project and
 * drives genuine review-ready generations through the production Issue #8
 * transaction (finalize → dispatch → human response) so every round's
 * receipts, pointers, and ledger events are authentic.
 */

export function sha(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

let mediaFixture: { wav: Buffer; mp4: Buffer } | undefined;
function mediaBytes(): { wav: Buffer; mp4: Buffer } {
  if (mediaFixture) return mediaFixture;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-media-"));
  const wav = path.join(root, "audio.wav");
  const mp4 = path.join(root, "video.mp4");
  for (const [command, args] of [
    ["ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-ac", "2", "-y", wav]],
    ["ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=1", "-i", wav, "-shortest", "-c:v", "libx264", "-c:a", "aac", "-y", mp4]],
  ] as const) {
    const result = spawnSync(command, args);
    if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr?.toString() ?? result.error?.message ?? "unknown"}`);
  }
  mediaFixture = { wav: fs.readFileSync(wav), mp4: fs.readFileSync(mp4) };
  fs.rmSync(root, { recursive: true, force: true });
  return mediaFixture;
}

export interface RoundProject {
  root: string;
  projectId: string;
  paths: Record<string, string>;
  adapter: FakeReviewAskAdapter;
  timelineVersion: number;
}

export interface RoundResult {
  roundIndex: number;
  generationId: string;
  reviewIdentity: string;
  askId: string;
  askEventIdentity: string;
  responseEventIdentity: string;
  roundIdentity: string;
  decision: string;
  input: ReviewReadyInput;
  outputSha256: string;
  timelineSha256: string;
  timelineVersion: string;
}

function clip(clipId: string, segmentId: string, assetId: string, srcInUs: number, srcOutUs: number, timelineInFrame: number, duration: number): Record<string, unknown> {
  return { clip_id: clipId, segment_id: segmentId, asset_id: assetId, src_in_us: srcInUs, src_out_us: srcOutUs, timeline_in_frame: timelineInFrame, timeline_duration_frames: duration };
}

function timelineBytes(projectId: string, version: string, rounds: number): string {
  return JSON.stringify({
    version,
    project_id: projectId,
    sequence: { fps_num: 30, fps_den: 1 },
    rounds,
    tracks: {
      video: [{ track_id: "V1", clips: [
        clip("CLP_1", "SEG_1", "AST_1", 1000000, 4000000, 0, 300),
        clip("CLP_2", "SEG_2", "AST_2", 5000000, 8000000, 300, 300),
      ] }],
      audio: [],
    },
  });
}

function baselineTimelineBytes(projectId: string): string {
  return JSON.stringify({
    version: "0",
    project_id: projectId,
    sequence: { fps_num: 30, fps_den: 1 },
    tracks: {
      video: [{ track_id: "V1", clips: [
        clip("OLD_1", "SEG_1", "AST_1", 1500000, 3500000, 0, 200),
        clip("OLD_2", "SEG_2", "AST_2", 5100000, 7900000, 200, 100),
      ] }],
      audio: [],
    },
  });
}

export function createReviewRoundProject(options: { projectId?: string } = {}): RoundProject {
  const projectId = options.projectId ?? "phase6";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-project-"));
  const paths: Record<string, string> = {
    timeline: write(root, "05_timeline/timeline.json", timelineBytes(projectId, "1", 0)),
    baseline: write(root, "05_timeline/v001.timeline.json", baselineTimelineBytes(projectId)),
    sourceMap: write(root, "02_media/source_map.json", JSON.stringify({ version: "3", items: [] })),
    delivery: write(root, "04_plan/delivery.json", JSON.stringify({ id: "reel-vertical" })),
    framing: write(root, "04_plan/framing-policy.json", JSON.stringify({ lower_third_exclusion: true })),
    captionPolicy: write(root, "04_plan/caption-policy.json", JSON.stringify({ mode: "review_only" })),
    patch: write(root, "06_review/review_patch.json", "patch-v1"),
    mapping: write(root, "05_timeline/derived-frame-mapping.json", "mapping-v1"),
    reviewTimeline: write(root, "05_timeline/review-timeline.json", "review-timeline-v1"),
    visual: write(root, "06_review/visual-treatment.json", "visual-v1"),
    content: write(root, "06_review/content-plan.json", "content-v1"),
    audio: write(root, "06_review/audio-plan.json", "audio-v1"),
    renderer: write(root, "06_review/renderer-capability.json", "renderer-v1"),
    sampleSheet: write(root, "06_review/sample-sheet.json", JSON.stringify({ samples: Array.from({ length: 6 }, (_, index) => ({
      clip_id: `clip-${index + 1}`,
      timestamp_frame: index * 120,
      inspection_space: index < 3 ? "source_frame" : "delivery_crop",
      measurement: { face_eye_line_ratio: 0.34 },
      allowed_range: { min: 0.3, max: 0.38 },
      status: "pass",
    })) })),
    captionPlan: "06_review/caption-preview-plan.json",
    storyboard: "04_plan/review-projections/p1/manifest.json",
  };
  write(root, "project_state.yaml", `version: 1\nproject_id: ${projectId}\ncurrent_state: timeline_drafted\ngates:\n  review_gate: blocked\nhistory: []\n`);
  write(root, "progress.json", JSON.stringify({ project_id: projectId, phase: "compile", gate: 4, status: "completed", completed: 1, total: 1, artifacts_created: [], errors: [], started_at: "2026-08-29T00:00:00.000Z", updated_at: "2026-08-29T00:00:00.000Z" }));
  return { root, projectId, paths, adapter: new FakeReviewAskAdapter(), timelineVersion: 1 };
}

function write(root: string, relative: string, bytes: string | Buffer): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return relative;
}

export interface BuiltRoundInput {
  input: ReviewReadyInput;
  generationId: string;
  reviewIdentity: string;
  outputSha256: string;
  timelineSha256: string;
  timelineVersion: string;
}

/** Build (capture, promote, prepare finalize input) WITHOUT finalizing. */
export function buildRoundInput(
  project: RoundProject,
  options: { decision?: "approve" | "request_changes" | "free_text" } = {},
): BuiltRoundInput {
  const { root, projectId, paths } = project;
  project.timelineVersion += 1;
  const timelineVersion = String(project.timelineVersion);
  const decision = options.decision ?? "request_changes";

  const timelineBytesJson = timelineBytes(projectId, timelineVersion, project.timelineVersion);
  fs.writeFileSync(path.join(root, paths.timeline), timelineBytesJson);
  const timelineSha256 = sha(fs.readFileSync(path.join(root, paths.timeline)));

  const captionCues = [
    { cue_id: "c1", text: "first", timeline_in_frame: 30, timeline_out_frame: 300 },
    { cue_id: "c2", text: "second", timeline_in_frame: 600, timeline_out_frame: 1500 },
  ];
  write(root, paths.captionPlan, JSON.stringify({
    schema_version: "private-caption-plan/v2", base_timeline_version: timelineVersion,
    base_timeline_hash: timelineSha256, review_only_unapproved: true, cues: captionCues,
  }));

  const deliveryHash = sha(fs.readFileSync(path.join(root, paths.delivery)));
  const storyboard = {
    version: "editorial-storyboard-projection/v1", projection_id: "p1", project_id: projectId,
    generated_at: "2026-08-29T00:00:00.000Z", source_mode: "timeline", project_title: null,
    delivery: { mode: "single", ids: ["reel-vertical"], profiles: [{ profile_id: "reel-vertical", profile_name: "Reel vertical", platform: "generic", path: paths.delivery, hash: deliveryHash, aspect_ratio: "9:16", resolution_width: 1080, resolution_height: 1920, fps_mode: "source", caption_mode: "burn_in" }] },
    inputs: [{ role: "timeline", path: paths.timeline, hash: timelineSha256, required: true }, { role: "policy", path: paths.delivery, hash: deliveryHash, required: true }],
    artifact_hashes: { timeline: timelineSha256 },
    approval_identity: { artifact_hashes: { timeline: timelineSha256 }, delivery_hash: deliveryHash, beat_count: 1, total_frames: 1620 },
    review_diff_summary: { trims: [`round ${timelineVersion} trim`], crops: ["6 sampled crops"] },
    canvas: { aspect_ratio_label: "9:16", aspect: 0.5625, width: 1080, height: 1920, fps_num: 30, fps_den: 1, basis: "delivery_profile" },
    fps: { num: 30, den: 1 }, policy_summaries: { music: "none", dialogue: "source", caption: "review only" }, caption_policy_language: null,
    beat_count: 1, total_frames: 1620, total_frames_basis: "timeline_span_frames", compiled_span_frames: 1620, timeline_end_frame: 1620,
    representative_frames: [], warnings: [], invalid: [], outputs: [], regenerate_command: "render-storyboard", generator: "render-editorial-storyboard",
  };
  write(root, paths.storyboard, JSON.stringify(storyboard));

  const masteringPolicy = { loudness_target_lufs: -16, lra_target: 7, true_peak_target_dbtp: -1.5 };
  const canonicalAudioPlan = writeCanonicalSocialReviewAudioPlan({
    projectDir: root, projectId, timelinePath: path.join(root, paths.timeline), policy: masteringPolicy,
  });
  const sharedAudioPlanHash = canonicalAudioPlan.hash;

  const generation = captureSocialReviewGeneration({
    projectDir: root,
    projectId,
    canonicalTimelineHash: timelineSha256,
    acceptedPatchHash: sha(fs.readFileSync(path.join(root, paths.patch))),
    derivedMappingReceiptHash: sha(fs.readFileSync(path.join(root, paths.mapping))),
    reviewTimelineHash: sha(fs.readFileSync(path.join(root, paths.reviewTimeline))),
    captionTextTimingHash: hashCanonical(captionCues.map((cue) => ({ text: cue.text, in_frame: cue.timeline_in_frame, out_frame: cue.timeline_out_frame }))),
    visualTreatmentHash: sha(fs.readFileSync(path.join(root, paths.visual))),
    contentPlanHash: sha(fs.readFileSync(path.join(root, paths.content))),
    audioPlanHash: deriveSocialReviewAudioPlanIdentity({ state: "mastered", sharedAudioPlanHash, policy: masteringPolicy }),
    rendererCapabilityHash: sha(fs.readFileSync(path.join(root, paths.renderer))),
    ...socialReviewCollisionInputHashes(),
    sourceInputAttestation: {
      version: "source-input-attestation/v3", status: "verified", source_inputs_hash: sha("source-inputs").slice(7),
      source_inputs: [{ asset_id: "asset-1", media_kind: "video", content_sha256: sha("asset-1").slice(7), identity_status: "verified", render_input_identity: { relationship: "same_as_original", content_sha256: sha("asset-1").slice(7) } }],
      source_input_count: 1, persisted_source_input_count: 1, source_inputs_truncated: false,
      warnings: [], warning_count: 0, warnings_suppressed: 0,
      usage_policy: { include_video: true, include_audio: true }, timeline_hash: timelineSha256.slice(7, 23),
    },
    files: [
      paths.timeline, paths.patch, paths.mapping, paths.reviewTimeline, paths.captionPlan,
      paths.visual, paths.content, paths.audio, paths.renderer, paths.delivery, paths.storyboard,
      { logicalPath: "audio/shared-render-plan", filePath: canonicalAudioPlan.filePath },
    ],
  });
  if (prepareImmutableGeneration(generation).status !== "owner") throw new Error("generation collision in fixture");

  const media = mediaBytes();
  const premasterPath = path.join(generation.generation_dir, "work/audio/premaster_mix.wav");
  const masteredPath = path.join(generation.generation_dir, "work/audio/final_mix.wav");
  fs.mkdirSync(path.dirname(premasterPath), { recursive: true });
  fs.writeFileSync(premasterPath, media.wav);
  fs.writeFileSync(masteredPath, media.wav);
  fs.writeFileSync(generation.output_path, media.mp4);

  const audioReceipt = buildSocialReviewAudioReceipt({
    state: "mastered",
    generationId: generation.generation_id,
    sharedAudioPlanHash,
    projectDir: root,
    inputAudioPath: premasterPath,
    outputAudioPath: masteredPath,
    reviewVideoPath: generation.output_path,
    policy: masteringPolicy,
    masteringCount: 1,
    inputKind: "premaster",
  });
  const audioEvidence = write(root, path.relative(root, path.join(generation.generation_dir, "audio-mastering-receipt.json")), `${JSON.stringify(audioReceipt, null, 2)}\n`);
  const renderReportPath = write(root, path.relative(root, path.join(generation.generation_dir, "social-review-report.json")), JSON.stringify({
    version: "social-review-render/v3", generation_id: generation.generation_id,
    output_sha256: sha(fs.readFileSync(generation.output_path)), duration_frames: 1620, duration_sec: 54,
    fps_num: 30, fps_den: 1, width: 1080, height: 1920, audio_present: true, bgm_present: false, gap_free: true,
    audio_mastering: audioReportFromReceipt(audioReceipt),
  }));
  const layerEvidence = write(root, path.relative(root, path.join(generation.generation_dir, "work/layer-qa.json")), "layer-ok");
  const receipt = buildReviewReadyReceipt(generation, generation.output_path, {
    output: { status: "verified", duration_sec: 54, width: 1080, height: 1920, issues: [], scans: { decode: { status: "complete" }, black: { status: "complete", detections: [] }, freeze: { status: "complete", detections: [] }, layout_inset: { status: "complete", detections: [] } } },
    ...createVerifiedCollisionLayoutEvidence(generation),
    audio: { status: "verified", evidence: { path: audioEvidence, sha256: sha(fs.readFileSync(path.join(root, audioEvidence))) } },
    layers: { status: "verified", evidence: [{ path: layerEvidence, sha256: sha(fs.readFileSync(path.join(root, layerEvidence))) }] },
  }, path.join(root, renderReportPath));
  writeReviewReadyReceipt(generation, receipt);
  promoteLatestGeneration(generation, receipt);

  const input: ReviewReadyInput = {
    projectDir: root,
    generationId: generation.generation_id,
    artifacts: {
      timeline: paths.timeline, source_map: paths.sourceMap, delivery: paths.delivery,
      framing_policy: paths.framing, caption_policy: paths.captionPolicy,
      caption_plan: paths.captionPlan, render_report: renderReportPath,
      sample_sheet: paths.sampleSheet, storyboard_manifest: paths.storyboard,
    },
    technical: { duration_frames: 1620, duration_seconds: 54, fps: { num: 30, den: 1 }, resolution: { width: 1080, height: 1920 }, audio_stream: "present", bgm: "absent" },
    gaps: { primary_video: { status: "pass", count: 0 }, audio: { status: "pass", count: 0 }, freeze: { status: "pass", count: 0 }, black: { status: "pass", count: 0 } },
    source: { attestation_status: "verified", unresolved_media: [] },
    framing: {
      coverage: "sampled",
      samples: Array.from({ length: 6 }, (_, index) => ({ clip_id: `clip-${index + 1}`, timestamp_frame: index * 120, inspection_space: index < 3 ? "source_frame" : "delivery_crop", measurement: { face_eye_line_ratio: 0.34 }, allowed_range: { min: 0.3, max: 0.38 }, status: "pass" as const })),
    },
    captions: { cue_count: 2, display_range: { first_frame: 30, last_frame: 1500 }, safe_rect: { x: 0.08, y: 0.08, width: 0.84, height: 0.7 }, collision_status: "pass", transcript_grounding: "unverified", evidence_level: "policy_only", platform_safety_claims: [] },
    coverage: { video: "full_frame", audio: "full_frame", framing: "sampled", captions: "sampled" },
    findings: { pass: ["gap-free"], warnings: ["platform geometry not measured"], blockers: [], human_residual: [] },
    reviewSummary: { projection_id: "p1", trims: [`round ${timelineVersion} trim`], crops: ["6 sampled crops"], captions: ["2 review-only cues"] },
  };
  const reviewIdentity = hashCanonical({
    version: "review-identity/v1",
    ...(receipt as unknown as { identity: Record<string, unknown> }).identity,
  });
  return {
    input,
    generationId: generation.generation_id,
    reviewIdentity,
    outputSha256: sha(fs.readFileSync(generation.output_path)),
    timelineSha256,
    timelineVersion,
  };
}

export async function runReviewRound(
  project: RoundProject,
  options: { decision?: "approve" | "request_changes" | "free_text"; responseText?: string | null; skipResponse?: boolean; skipDispatch?: boolean } = {},
): Promise<RoundResult> {
  const { root } = project;
  const decision = options.decision ?? "request_changes";
  const built = buildRoundInput(project, options);
  const finalized = finalizeReviewReady(built.input);
  if (options.skipDispatch) {
    return {
      roundIndex: project.timelineVersion - 1,
      generationId: built.generationId,
      reviewIdentity: finalized.reviewIdentity,
      askId: "",
      askEventIdentity: "",
      responseEventIdentity: "",
      roundIdentity: "",
      decision,
      input: built.input,
      outputSha256: built.outputSha256,
      timelineSha256: built.timelineSha256,
      timelineVersion: built.timelineVersion,
    };
  }
  const ask = await dispatchReviewAsk(root, project.adapter);
  if (options.skipResponse) {
    const ledger = readReviewRoundLedger(root);
    const askEvent = ledger.chain.find((entry) => entry.event.version === "review-round-ask/v1"
      && (entry.event as { ask_id: string }).ask_id === ask.ask_id)!;
    return {
      roundIndex: project.timelineVersion - 1,
      generationId: built.generationId,
      reviewIdentity: finalized.reviewIdentity,
      askId: ask.ask_id!,
      askEventIdentity: askEvent.identity,
      responseEventIdentity: "",
      roundIdentity: "",
      decision,
      input: built.input,
      outputSha256: built.outputSha256,
      timelineSha256: built.timelineSha256,
      timelineVersion: built.timelineVersion,
    };
  }
  const response = await recordReviewResponse(root, {
    review_identity: finalized.reviewIdentity,
    generation_id: built.generationId,
    video_sha256: finalized.receipt.identity.video_sha256,
    timeline_sha256: finalized.receipt.identity.timeline_sha256,
    ask_id: ask.ask_id!,
    decision,
    text: options.responseText ?? null,
  });

  const ledger = readReviewRoundLedger(root);
  const askEvent = ledger.chain.find((entry) => entry.event.version === "review-round-ask/v1"
    && (entry.event as { ask_id: string }).ask_id === ask.ask_id)!;
  const responseEvent = ledger.chain.find((entry) => entry.event.version === "review-round-response/v1"
    && (entry.event as { ask_event: string }).ask_event === askEvent.identity)!;
  return {
    roundIndex: project.timelineVersion - 1,
    generationId: built.generationId,
    reviewIdentity: finalized.reviewIdentity,
    askId: ask.ask_id!,
    askEventIdentity: askEvent.identity,
    responseEventIdentity: responseEvent.identity,
    roundIdentity: reviewRoundIdentity(askEvent.identity, responseEvent.identity),
    decision,
    input: built.input,
    outputSha256: finalized.receipt.identity.video_sha256,
    timelineSha256: built.timelineSha256,
    timelineVersion: built.timelineVersion,
  };
}
