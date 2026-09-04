import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { validateArtifact } from "../artifacts/loaders.js";
import { evaluateFramingPolicy, type FramingObservation, type FramingPolicyDocument, type FramingPolicyResult } from "./framing-policy.js";
import { canonicalJson } from "./framing-policy.js";
import { verifyReframeCandidateEvidence, type ReframeCandidateEvidence } from "./reframe.js";
import type { RegisteredVisualIntent, SourceEvidencePin } from "./types.js";

export type VerticalFrameRole = "first" | "representative" | "last";
export type VerticalZoomIntent = "emphasis" | "reaction" | "evidence" | "reset";

export interface VerticalCompositionPolicy {
  version: "vertical-composition-policy/v1";
  policy_id: string;
  output: { aspect_ratio: "9:16"; coordinate_system: "normalized_top_left"; width: number; height: number };
  checks: {
    person_occupancy: { minimum: number; maximum: number };
    headroom: { minimum_top_margin: number; maximum_top_margin: number };
    look_room: { minimum_margin: number };
    hands: EvidenceRequirement;
    microphone: EvidenceRequirement;
    evidence: EvidenceRequirement;
    /** Subject-caption thresholds and proposal anchors are policy-owned. */
    caption_collision?: {
      thresholds: Record<"baseline" | "emphasis" | "title", number>;
      candidate_anchors: { lower: string; upper: string };
      auto_move: false;
    };
  };
  layout_anchors: Record<string, NormalizedRect>;
  zoom_intents: Record<VerticalZoomIntent, { max_zoom: number; allow: boolean }>;
  frames: { required_roles: VerticalFrameRole[]; representative_count: number };
  source: { require_identity: boolean; require_av_geometry: boolean };
  platform_geometry?: {
    status: "unknown" | "provisional" | "measured";
    evidence_level: "policy_only" | "platform_measured" | "human_verified";
    source?: string;
    observed_at?: string;
    device?: string;
    app?: string;
    screenshot_sha256?: string;
  };
  degrade: { missing_evidence: "safe_degrade" | "human_hold"; failed_check: "safe_degrade" | "human_hold"; safe_mode: "identity" | "safe_crop" };
}

interface EvidenceRequirement { mode: "required" | "protect_if_present" | "ignore"; minimum_confidence: number }
export interface NormalizedRect { x: number; y: number; width: number; height: number }
export interface VerticalSourceAvGeometry { video: { width: number; height: number; fps_num: number; fps_den: number }; audio: { sample_rate: number; channels: number } }
export interface VerticalFrameObservation {
  role: VerticalFrameRole;
  observation?: FramingObservation;
  microphone?: { present: boolean; confidence: number };
  evidence?: { present: boolean; confidence: number };
  layout_anchor?: string;
}
export interface VerticalCompositionInput {
  intent?: RegisteredVisualIntent;
  source_identity?: SourceEvidencePin;
  source_av_geometry?: VerticalSourceAvGeometry;
  frames: VerticalFrameObservation[];
  framing_policy?: FramingPolicyDocument;
  framing_result?: FramingPolicyResult;
  reframe_candidate?: ReframeCandidateEvidence;
  zoom_intent?: VerticalZoomIntent;
}

export interface VerticalCompositionFinding { check: string; status: "pass" | "fail" | "unknown"; reason: string; evidence_count: number }
export interface VerticalCompositionResolution {
  version: "vertical-composition-resolution/v1";
  status: "ready" | "degraded" | "human_hold";
  policy_id: string;
  policy_hash: string;
  source_identity?: SourceEvidencePin;
  source_av_geometry?: VerticalSourceAvGeometry;
  frame_roles: Record<VerticalFrameRole, number>;
  zoom_intent: VerticalZoomIntent;
  framing_result?: FramingPolicyResult;
  safe_degrade?: { mode: "identity" | "safe_crop"; reason: string };
  findings: VerticalCompositionFinding[];
  receipt_hash: string;
}

export class VerticalCompositionError extends Error {
  constructor(public readonly issues: string[]) { super(`Vertical composition policy is invalid: ${issues.join("; ")}`); this.name = "VerticalCompositionError"; }
}

export function parseVerticalCompositionPolicy(input: unknown): VerticalCompositionPolicy {
  try {
    return structuredClone(validateArtifact<VerticalCompositionPolicy>(input, "vertical-composition-policy.schema.json"));
  } catch (error) {
    throw new VerticalCompositionError([error instanceof Error ? error.message : String(error)]);
  }
}

export function loadVerticalCompositionPolicy(filePath: string): VerticalCompositionPolicy {
  return parseVerticalCompositionPolicy(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

export function verticalCompositionPolicyContentHash(policy: VerticalCompositionPolicy): string {
  return `sha256:${createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex")}`;
}

function finding(check: string, status: VerticalCompositionFinding["status"], reason: string, evidence_count = 0): VerticalCompositionFinding {
  return { check, status, reason, evidence_count };
}

function validIdentity(identity: SourceEvidencePin | undefined): boolean {
  return Boolean(identity?.asset_id && identity.segment_id && identity.source_content_hash && identity.source_range &&
    Number.isFinite(identity.source_range.src_in_us) && Number.isFinite(identity.source_range.src_out_us) &&
    identity.source_range.src_out_us > identity.source_range.src_in_us);
}

function validAvGeometry(geometry: VerticalSourceAvGeometry | undefined): boolean {
  return Boolean(geometry && geometry.video && geometry.audio && geometry.video.width > 0 && geometry.video.height > 0 && geometry.video.fps_num > 0 &&
    geometry.video.fps_den > 0 && geometry.audio.sample_rate > 0 && geometry.audio.channels > 0);
}

function evaluateEvidence(
  name: string,
  requirement: EvidenceRequirement,
  values: Array<{ present: boolean; confidence: number } | undefined>,
): VerticalCompositionFinding {
  if (requirement.mode === "ignore") return finding(name, "pass", "policy ignores this evidence", values.length);
  const usable = values.filter((value): value is { present: boolean; confidence: number } => Boolean(value));
  if (usable.length === 0) return finding(name, requirement.mode === "required" ? "unknown" : "pass", "evidence not present", 0);
  const failed = usable.some((value) => value.present && value.confidence < requirement.minimum_confidence);
  if (failed) return finding(name, "fail", "present evidence is below the policy confidence", usable.length);
  if (requirement.mode === "required" && usable.every((value) => !value.present)) return finding(name, "fail", "required evidence is absent", usable.length);
  return finding(name, "pass", "evidence satisfies the policy", usable.length);
}

function evaluateFrameChecks(policy: VerticalCompositionPolicy, frames: VerticalFrameObservation[]): VerticalCompositionFinding[] {
  const findings: VerticalCompositionFinding[] = [];
  const selectedFrames: VerticalFrameObservation[] = [];
  const requiredRoles = policy.frames.required_roles;
  for (const role of requiredRoles) {
    const requiredCount = role === "representative" ? policy.frames.representative_count : 1;
    const roleFrames = frames.filter((frame) => frame.role === role);
    const selected = roleFrames.slice(0, requiredCount);
    selectedFrames.push(...selected);
    if (roleFrames.length < requiredCount) {
      findings.push(finding(`frame_role:${role}`, "unknown", `required ${requiredCount} observation(s), found ${roleFrames.length}`, roleFrames.length));
    }
    for (const [index, frame] of selected.entries()) {
      const suffix = requiredCount === 1 ? role : `${role}[${index}]`;
      const observation = frame.observation;
      if (!observation?.person) {
        findings.push(finding(`person_occupancy:${suffix}`, "unknown", "person observation is missing", 0));
        findings.push(finding(`headroom:${suffix}`, "unknown", "head observation is missing", 0));
        findings.push(finding(`look_room:${suffix}`, "unknown", "person observation is missing", 0));
        continue;
      }
      const occupancy = observation.person.width * observation.person.height;
      const personPass = occupancy >= policy.checks.person_occupancy.minimum && occupancy <= policy.checks.person_occupancy.maximum;
      const headTop = observation.head?.y;
      const headroomPass = typeof headTop === "number" && headTop >= policy.checks.headroom.minimum_top_margin && headTop <= policy.checks.headroom.maximum_top_margin;
      const yaw = observation.head?.yaw_radians ?? 0;
      const lookMargin = yaw > 0 ? 1 - ((observation.person.x ?? 0) + observation.person.width) : yaw < 0 ? observation.person.x : Math.min(observation.person.x, 1 - observation.person.x - observation.person.width);
      findings.push(finding(`person_occupancy:${suffix}`, personPass ? "pass" : "fail", `occupancy=${occupancy.toFixed(4)}`, 1));
      findings.push(finding(`headroom:${suffix}`, headroomPass ? "pass" : "fail", typeof headTop === "number" ? `top_margin=${headTop.toFixed(4)}` : "head observation is missing", observation.head ? 1 : 0));
      findings.push(finding(`look_room:${suffix}`, lookMargin >= policy.checks.look_room.minimum_margin ? "pass" : "fail", `look_margin=${lookMargin.toFixed(4)}`, 1));
    }
  }
  for (const check of ["person_occupancy", "headroom", "look_room"] as const) {
    const roleFindings = findings.filter((item) => item.check.startsWith(`${check}:`));
    const status = roleFindings.some((item) => item.status === "fail") ? "fail" : roleFindings.some((item) => item.status === "unknown") ? "unknown" : "pass";
    findings.push(finding(check, status, `required frame roles evaluated: ${requiredRoles.join(", ")}`, roleFindings.reduce((count, item) => count + item.evidence_count, 0)));
  }
  for (const [name, requirement, values] of [
    ["hands", policy.checks.hands, selectedFrames.map((frame) => ({ present: Boolean(frame.observation?.hands?.length), confidence: frame.observation?.hands?.[0]?.confidence ?? 0 }))],
    ["microphone", policy.checks.microphone, selectedFrames.map((frame) => frame.microphone)],
    ["evidence", policy.checks.evidence, selectedFrames.map((frame) => frame.evidence)],
  ] as const) {
    findings.push(evaluateEvidence(name, requirement, values));
    for (const role of requiredRoles) {
      const requiredCount = role === "representative" ? policy.frames.representative_count : 1;
      const roleFrames = selectedFrames.filter((frame) => frame.role === role);
      findings.push(evaluateEvidence(`${name}:${role}`, requirement, roleFrames.map((frame) => name === "hands"
        ? { present: Boolean(frame.observation?.hands?.length), confidence: frame.observation?.hands?.[0]?.confidence ?? 0 }
        : name === "microphone" ? frame.microphone : frame.evidence)));
      if (roleFrames.length < requiredCount) findings.push(finding(`${name}:${role}:count`, "unknown", `required ${requiredCount} observation(s), found ${roleFrames.length}`, roleFrames.length));
    }
  }
  for (const role of requiredRoles) {
    const roleFrames = selectedFrames.filter((frame) => frame.role === role);
    const anchors = roleFrames.map((frame) => frame.layout_anchor).filter((anchor): anchor is string => Boolean(anchor));
    findings.push(finding(`layout_anchor:${role}`, anchors.length > 0 && anchors.every((anchor) => Boolean(policy.layout_anchors[anchor])) ? "pass" : "unknown", anchors.length > 0 ? `registered anchor=${anchors[0]}` : "no registered layout anchor", anchors.length));
  }
  return findings;
}

export function resolveVerticalComposition(input: VerticalCompositionInput, policy: VerticalCompositionPolicy): VerticalCompositionResolution {
  const framesByRole = new Map<VerticalFrameRole, number>();
  for (const frame of input.frames) framesByRole.set(frame.role, (framesByRole.get(frame.role) ?? 0) + 1);
  const findings: VerticalCompositionFinding[] = [];
  const missingRoles = policy.frames.required_roles.filter((role) => !framesByRole.has(role));
  findings.push(finding("frame_roles", missingRoles.length === 0 ? "pass" : "unknown", missingRoles.length === 0 ? "required first/representative/last evidence is present" : `missing roles: ${missingRoles.join(", ")}`, input.frames.length));
  const identityPass = validIdentity(input.source_identity);
  findings.push(finding("source_identity", !policy.source.require_identity || identityPass ? "pass" : "unknown", identityPass ? "source asset, segment, hash, and range are pinned" : "source identity is missing or incomplete", input.source_identity ? 1 : 0));
  const avPass = validAvGeometry(input.source_av_geometry);
  findings.push(finding("source_av_geometry", !policy.source.require_av_geometry || avPass ? "pass" : "unknown", avPass ? "source video and audio geometry are recorded" : "source A/V geometry is missing or invalid", input.source_av_geometry ? 1 : 0));

  let framingResult = input.framing_result;
  if (input.reframe_candidate) {
    try {
      verifyReframeCandidateEvidence(input.reframe_candidate);
      framingResult = input.reframe_candidate.result;
      findings.push(finding("reframe_candidate", "pass", "RFA-008 to RFA-010 candidate evidence is verified", 1));
    } catch (error) {
      findings.push(finding("reframe_candidate", "fail", error instanceof Error ? error.message : String(error), 1));
    }
  }
  if (!framingResult && input.framing_policy && input.intent?.framing_input) {
    framingResult = evaluateFramingPolicy({
      observations: input.intent.framing_input.observations,
      output: input.intent.framing_input.output,
      mode: input.intent.framing_mode ?? "wide",
      requested_transform: input.intent.transform,
    }, input.framing_policy);
  }
  findings.push(...evaluateFrameChecks(policy, input.frames));
  const requiredAnchorFindings = findings.filter((item) => item.check.startsWith("layout_anchor:"));
  findings.push(finding("layout_anchor", requiredAnchorFindings.some((item) => item.status === "fail") ? "fail" : requiredAnchorFindings.some((item) => item.status === "unknown") ? "unknown" : "pass", "required frame roles evaluated", requiredAnchorFindings.reduce((count, item) => count + item.evidence_count, 0)));
  const zoomIntent = input.zoom_intent ?? (input.intent?.framing_mode === "punch" ? "emphasis" : "reset");
  const zoom = framingResult?.transform.zoom ?? 1;
  const zoomPolicy = policy.zoom_intents[zoomIntent];
  findings.push(finding("zoom_intent", zoomPolicy.allow && zoom <= zoomPolicy.max_zoom ? "pass" : "fail", `intent=${zoomIntent} zoom=${zoom}`, framingResult ? 1 : 0));
  findings.push(finding("framing_result", framingResult?.status === "ready" ? "pass" : framingResult ? "fail" : "unknown", framingResult ? `framing status=${framingResult.status}` : "framing result is unavailable", framingResult ? 1 : 0));

  const unknown = findings.some((item) => item.status === "unknown");
  const failed = findings.some((item) => item.status === "fail");
  let status: VerticalCompositionResolution["status"] = "ready";
  let safe_degrade: VerticalCompositionResolution["safe_degrade"];
  if (failed || unknown) {
    const policyAction = failed ? policy.degrade.failed_check : policy.degrade.missing_evidence;
    if (policyAction === "human_hold") {
      status = "human_hold";
      safe_degrade = { mode: policy.degrade.safe_mode, reason: failed ? "composition policy check failed" : "composition evidence is incomplete" };
    } else {
      status = "degraded";
      safe_degrade = { mode: policy.degrade.safe_mode, reason: failed ? "composition policy check failed; safe degrade selected" : "composition evidence incomplete; safe degrade selected" };
    }
  }
  const result: Omit<VerticalCompositionResolution, "receipt_hash"> = {
    version: "vertical-composition-resolution/v1", status, policy_id: policy.policy_id, policy_hash: verticalCompositionPolicyContentHash(policy),
    ...(input.source_identity ? { source_identity: structuredClone(input.source_identity) } : {}),
    ...(input.source_av_geometry ? { source_av_geometry: structuredClone(input.source_av_geometry) } : {}),
    frame_roles: { first: framesByRole.get("first") ?? 0, representative: framesByRole.get("representative") ?? 0, last: framesByRole.get("last") ?? 0 },
    zoom_intent: zoomIntent, ...(framingResult ? { framing_result: structuredClone(framingResult) } : {}), ...(safe_degrade ? { safe_degrade } : {}), findings,
  };
  return { ...result, receipt_hash: `sha256:${createHash("sha256").update(canonicalJson(result), "utf8").digest("hex")}` };
}
