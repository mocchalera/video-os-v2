import * as fs from "node:fs";
import * as path from "node:path";
import type { Candidate, SourceMediaSummary } from "../compiler/types.js";
import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import {
  audioStoryNodesForWindow,
  readAudioStoryGraph,
} from "./p2-audio-story-graph.js";
import {
  assertCandidatePlanningMediaKindsSupported,
  inferAudioRole,
  isAudioOnlyCandidate,
  readAssetMediaCapabilities,
  summarizeCandidateMedia,
} from "./source-media-capabilities.js";

export function materializeCandidateMediaCapabilities(
  projectDir: string,
  selects: { candidates: Candidate[]; source_media?: SourceMediaSummary },
  segments: Array<Pick<SegmentItem, "segment_id" | "transcript_excerpt">>,
): typeof selects {
  if (!Array.isArray(selects.candidates)) return selects;
  const capabilities = readAssetMediaCapabilities(projectDir);
  const segmentsById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const audioEvents = readAudioEventEvidence(projectDir);
  const graph = readAudioStoryGraph(projectDir);

  for (const candidate of selects.candidates) {
    const capability = capabilities.get(candidate.asset_id);
    if (capability) {
      candidate.media_kind = capability.media_kind;
      candidate.source_capabilities = { ...capability.source_capabilities };
    }
    if (!isAudioOnlyCandidate(candidate)) continue;

    const segment = segmentsById.get(candidate.segment_id);
    const transcript = segment?.transcript_excerpt?.trim() ?? candidate.transcript_excerpt?.trim() ?? "";
    const events = (audioEvents.get(candidate.asset_id) ?? []).filter((event) =>
      event.start_us < candidate.src_out_us && event.end_us > candidate.src_in_us
    );
    const nodes = graph
      ? audioStoryNodesForWindow(graph, candidate.asset_id, candidate.src_in_us, candidate.src_out_us)
      : [];
    const evidence = uniqueStrings([
      ...(transcript ? [`Transcript: ${transcript}`] : []),
      ...events.map((event) => `Audio event: ${event.type}${event.label ? ` (${event.label})` : ""}`),
      ...nodes.map((node) => `Audio story: ${node.node_type}${node.story_role ? ` role=${node.story_role}` : ""}${node.text ? ` text=${node.text}` : ""}`),
    ]);
    candidate.transcript_excerpt = transcript;
    candidate.audio_role = inferAudioRole(candidate);
    const existingWhy = groundedAudioText(candidate.why_it_matches) ? candidate.why_it_matches.trim() : "";
    candidate.why_it_matches = uniqueStrings([
      ...(existingWhy ? [existingWhy] : []),
      ...(evidence.length > 0 ? evidence : ["Canonical audio-only source window; visual evidence not applicable."]),
    ]).join("; ");
    candidate.evidence = uniqueStrings([
      ...(candidate.evidence ?? []).filter(groundedAudioText),
      ...(evidence.length > 0 ? evidence : ["Canonical audio-only source window; visual evidence not applicable."]),
    ]);
    candidate.motif_tags = uniqueStrings([
      ...(candidate.motif_tags ?? []),
      ...events.map((event) => event.type),
      ...nodes.map((node) => node.node_type),
      ...nodes.map((node) => node.story_role ?? ""),
    ]);
    stripUngroundedVisualClaims(candidate);
  }
  assertCandidatePlanningMediaKindsSupported(selects.candidates);
  selects.source_media = summarizeCandidateMedia(selects.candidates);
  return selects;
}

function stripUngroundedVisualClaims(candidate: Candidate): void {
  if (candidate.editorial_signals) {
    const {
      visual_tags: _visual,
      motion_energy_score: _motion,
      face_detected: _face,
      peak_ref: _peakRef,
      peak_type: _peakType,
      peak_strength_score: _peakStrength,
      peak_source_pass: _peakPass,
      ...audioSignals
    } = candidate.editorial_signals;
    candidate.editorial_signals = Object.keys(audioSignals).length > 0 ? audioSignals : undefined;
  }
  candidate.peak_signals = undefined;
  if (candidate.trim_hint) {
    const {
      interest_point_label: _label,
      interest_point_confidence: _confidence,
      peak_ref: _peakRef,
      peak_type: _peakType,
      center_source: _center,
      rationale,
      ...groundedTrimRaw
    } = candidate.trim_hint;
    const groundedTrim: NonNullable<Candidate["trim_hint"]> = { ...groundedTrimRaw };
    if (typeof rationale === "string" && groundedAudioText(rationale)) groundedTrim.rationale = rationale;
    candidate.trim_hint = Object.keys(groundedTrim).length > 0 ? groundedTrim : undefined;
  }
}

function groundedAudioText(value: string): boolean {
  return !/(frame|visual|visible|shot|camera|motion|composition|被写体|映像|画面|構図|カメラ|動き)/i.test(value);
}

function readAudioEventEvidence(projectDir: string): Map<string, Array<{
  type: string;
  label?: string;
  start_us: number;
  end_us: number;
}>> {
  const filePath = path.join(projectDir, "03_analysis", "audio_events.json");
  if (!fs.existsSync(filePath)) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return new Map();
    const grouped = new Map<string, Array<{ type: string; label?: string; start_us: number; end_us: number }>>();
    for (const value of parsed.items) {
      if (!value || typeof value !== "object") continue;
      const event = value as { asset_id?: unknown; type?: unknown; label?: unknown; start_us?: unknown; end_us?: unknown };
      if (typeof event.asset_id !== "string" || typeof event.type !== "string" || typeof event.start_us !== "number" || typeof event.end_us !== "number") continue;
      const items = grouped.get(event.asset_id) ?? [];
      items.push({ type: event.type, ...(typeof event.label === "string" ? { label: event.label } : {}), start_us: event.start_us, end_us: event.end_us });
      grouped.set(event.asset_id, items);
    }
    return grouped;
  } catch {
    return new Map();
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
