import * as fs from "node:fs";
import * as path from "node:path";
import {
  bindGenerationArtifact,
  type SocialReviewGeneration,
  type SocialReviewQA,
} from "../../runtime/review/social-review-generation.js";
import { evaluateDeterministicLayoutQA } from "../../runtime/review/deterministic-layout-qa.js";
import {
  parseSubjectOccupancyTrack,
  subjectOccupancyPayloadHash,
} from "../../runtime/review/subject-occupancy.js";
import {
  parseVerticalCompositionPolicy,
  verticalCompositionPolicyContentHash,
} from "../../runtime/visual/vertical-composition.js";

const hash = (char: string): string => `sha256:${char.repeat(64)}`;

function policyFixture() {
  return parseVerticalCompositionPolicy({
    version: "vertical-composition-policy/v1",
    policy_id: "ready-receipt-collision-v1",
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
}

function subjectFixture(generationId: string) {
  return parseSubjectOccupancyTrack({
    version: "subject-occupancy-track/v1",
    generation_id: generationId,
    source_identity: {
      asset_id: "ASSET", segment_id: "SEGMENT", source_content_hash: hash("7"),
      source_range: { src_in_us: 0, src_out_us: 400_000 },
    },
    source_av_geometry: {
      video: { width: 1920, height: 1080, fps_num: 30, fps_den: 1 },
      audio: { sample_rate: 48_000, channels: 2 },
    },
    provenance: { source: "manual_annotation", producer: "fixture", producer_version: "1", confidence: 0.9 },
    coverage: { start_frame: 0, end_frame: 1620 },
    tracks: [{
      track_id: "TRACK_READY", subject_id: "SUBJECT_TRACK_ONLY", identity_scope: "track_only_not_person_identity",
      motion: "static", confidence: 0.9,
      samples: [{
        start_frame: 0, end_frame: 1620, bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
        evidence_roles: ["first", "representative", "last"],
      }],
    }],
  });
}

export function socialReviewCollisionInputHashes(): {
  subjectOccupancyPayloadHash: string;
  verticalCompositionPolicyHash: string;
} {
  return {
    subjectOccupancyPayloadHash: subjectOccupancyPayloadHash(subjectFixture(hash("0"))),
    verticalCompositionPolicyHash: verticalCompositionPolicyContentHash(policyFixture()),
  };
}

export function createVerifiedCollisionLayoutEvidence(
  generation: SocialReviewGeneration,
  prefix = "ready",
  captionLayerIds: string[] = ["c1", "c2"],
): Pick<SocialReviewQA, "layout" | "layout_evidence"> {
  const subject = subjectFixture(generation.generation_id);
  const policy = policyFixture();
  const snapshot = {
    version: "render-layout-snapshot/v1" as const,
    binding: {
      generation_id: generation.generation_id,
      renderer_capability_sha256: generation.inputs.renderer_capability_sha256,
    },
    frame: {
      width: 100, height: 100, fps_num: 30, fps_den: 1, total_frames: 1620,
      safe_area: { top: 8, right: 8, bottom: 22, left: 8 },
    },
    layers: [
      {
        layer_id: captionLayerIds[0], semantic_role: "speech_caption" as const, caption_role: "baseline" as const,
        source: "remotion" as const, start_frame: 30, end_frame: 300,
        bounds: { x: 10, y: 60, width: 80, height: 10 },
        font: { status: "verified" as const, requested_family: "fixture", missing_glyphs: [] },
      },
      {
        layer_id: captionLayerIds[1], semantic_role: "speech_caption" as const, caption_role: "baseline" as const,
        source: "remotion" as const, start_frame: 600, end_frame: 1500,
        bounds: { x: 10, y: 60, width: 80, height: 10 },
        font: { status: "verified" as const, requested_family: "fixture", missing_glyphs: [] },
      },
    ],
    ending: { final_frame_state: "moving_source" as const },
  };
  const layout = evaluateDeterministicLayoutQA(snapshot, { subjectCollision: {
    generationId: generation.generation_id,
    rendererCapabilityHash: generation.inputs.renderer_capability_sha256,
    subjectOccupancy: subject,
    verticalCompositionPolicy: policy,
    policyRef: "04_plan/vertical-composition-policy.json",
    policyHash: verticalCompositionPolicyContentHash(policy),
  } });
  const snapshotPath = path.join(generation.generation_dir, `${prefix}-layout-snapshot.json`);
  const subjectPath = path.join(generation.generation_dir, `${prefix}-subject-occupancy-track.json`);
  const policyPath = path.join(generation.generation_dir, `${prefix}-vertical-composition-policy.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), { flag: "wx" });
  fs.writeFileSync(subjectPath, JSON.stringify(subject), { flag: "wx" });
  fs.writeFileSync(policyPath, JSON.stringify(policy), { flag: "wx" });
  return {
    layout,
    layout_evidence: {
      snapshot: bindGenerationArtifact(generation, snapshotPath),
      subject_occupancy: bindGenerationArtifact(generation, subjectPath),
      vertical_composition_policy: bindGenerationArtifact(generation, policyPath),
    },
  };
}
