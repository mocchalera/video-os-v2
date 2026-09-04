/**
 * Markdown fallback summary for the editorial storyboard projection.
 *
 * The HTML projection is the primary review surface; this file keeps the
 * beat order and decision information readable in plain text environments.
 */

import type { FramingPlan, ProjectionManifest, StoryboardBeat } from "./types.js";

export interface MarkdownRenderInput {
  manifest: ProjectionManifest;
  beats: StoryboardBeat[];
  framingByBeat: Map<string, FramingPlan[]>;
  unassignedWarnings: Array<{ clip_id: string; reason: string }>;
  frameFileByBeat: Map<string, string | null>;
}

export function renderReviewSummaryMarkdown(input: MarkdownRenderInput): string {
  const { manifest } = input;
  const lines: string[] = [];

  lines.push(`# Editorial storyboard — ${manifest.project_title ?? manifest.project_id}`);
  lines.push("");
  lines.push(`- Projection: \`${manifest.projection_id}\` (${manifest.source_mode} mode)`);
  lines.push(`- Delivery: ${formatDelivery(manifest)}`);
  lines.push(`- Canvas: ${manifest.canvas.aspect_ratio_label}${manifest.canvas.width ? ` (${manifest.canvas.width}x${manifest.canvas.height})` : ""} — basis: ${manifest.canvas.basis}`);
  lines.push(`- Beats: ${manifest.beat_count}`);
  lines.push(`- Total frames (blueprint target): ${manifest.total_frames}`);
  if (manifest.compiled_span_frames !== null) {
    lines.push(`- Compiled timeline span: ${manifest.compiled_span_frames} frames`);
  }
  if (manifest.fps) {
    lines.push(`- FPS: ${manifest.fps.num}/${manifest.fps.den}`);
  }
  lines.push(`- Unresolved uncertainties: ${countEscalations(manifest)}`);
  lines.push(`- Approval identity: blueprint ${manifest.approval_identity.artifact_hashes.blueprint ?? "n/a"}`);
  lines.push("");

  lines.push("## Timeline ribbon");
  lines.push("");
  for (const beat of input.beats) {
    const position = beat.compiled
      ? `${beat.compiled.start_frame ?? "?"}–${beat.compiled.end_frame ?? "?"}`
      : `${beat.plan_start_frame}–${beat.plan_start_frame + beat.plan_duration_frames}`;
    const flags = [
      ...(beat.invalid_reasons.length > 0 ? ["INVALID"] : []),
      ...beat.warnings.map((warning) => warning),
    ];
    lines.push(
      `- ${String(beat.index).padStart(2, "0")} **${beat.label}** (${beat.beat_id}) · frames ${position} · ${
        beat.story_role ?? "role n/a"
      }${flags.length > 0 ? ` · ⚠ ${flags.join("; ")}` : ""}`,
    );
  }
  lines.push("");

  lines.push("## Beat cards");
  lines.push("");
  for (const beat of input.beats) {
    lines.push(`### ${String(beat.index).padStart(2, "0")} ${beat.label} (${beat.beat_id})`);
    lines.push("");
    if (beat.purpose) lines.push(`- Purpose: ${beat.purpose}`);
    lines.push(
      `- Position: plan ${beat.plan_start_frame}–${beat.plan_start_frame + beat.plan_duration_frames} frames${
        beat.compiled && beat.compiled.clip_count > 0
          ? `; compiled ${beat.compiled.start_frame}–${beat.compiled.end_frame} (${beat.compiled.compiled_frames}f)`
          : ""
      }`,
    );
    const transcript = beat.transcript_excerpt;
    if (transcript || beat.media_kind === "audio") {
      lines.push(`- Audio/transcript: ${transcript ?? "(no transcript excerpt)"}`);
    }
    for (const uncertainty of beat.uncertainties) {
      lines.push(`- Uncertainty: ${uncertainty}`);
    }
    for (const risk of collectRisks(beat)) {
      lines.push(`- Risk: ${risk}`);
    }

    const frame = input.frameFileByBeat.get(beat.beat_id) ?? null;
    const frameLine = frame
      ? `\`frames/${frame}\``
      : `unavailable — ${beat.representative.basis_detail}`;
    lines.push(`- Representative frame: ${frameLine}`);
    lines.push(`  - Basis: ${beat.representative.basis} — ${beat.representative.basis_detail}`);

    for (const framing of input.framingByBeat.get(beat.beat_id) ?? []) {
      const label = framing.canvas.basis === "delivery_profile" ? framing.canvas.aspect_ratio_label : `${framing.canvas.aspect_ratio_label} (source/timeline)`;
      lines.push(`- Delivery framing [${label}]: ${framing.fit}; ${framing.note}`);
    }

    if (beat.primary) {
      lines.push(
        `- Primary candidate: ${beat.primary.resolved ? beat.primary.ref : `UNRESOLVED (${beat.primary.ref})`}`,
      );
      if (beat.primary.resolved && beat.primary.segment_id) {
        lines.push(
          `  - ${beat.primary.segment_id} @ ${beat.primary.src_in_us}–${beat.primary.src_out_us}us · confidence ${beat.primary.confidence ?? "n/a"}`,
        );
      }
    }
    for (const fallback of beat.fallbacks) {
      lines.push(
        `- Fallback candidate: ${fallback.resolved ? fallback.ref : `UNRESOLVED (${fallback.ref})`}`,
      );
    }

    if (beat.warnings.length > 0) {
      for (const warning of beat.warnings) {
        lines.push(`- ⚠ Warning: ${warning}`);
      }
    }
    if (beat.invalid_reasons.length > 0) {
      for (const reason of beat.invalid_reasons) {
        lines.push(`- ✕ INVALID: ${reason}`);
      }
    }
    lines.push("");
  }

  if (input.unassignedWarnings.length > 0) {
    lines.push("## Unassigned compiled clips");
    lines.push("");
    for (const warning of input.unassignedWarnings) {
      lines.push(`- ${warning.clip_id}: ${warning.reason}`);
    }
    lines.push("");
  }

  lines.push("## Regenerate");
  lines.push("");
  lines.push("```sh");
  lines.push(manifest.regenerate_command);
  lines.push("```");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function formatDelivery(manifest: ProjectionManifest): string {
  if (manifest.delivery.mode === "all" && manifest.delivery.ids.length > 0) {
    return `all (${manifest.delivery.ids.join(", ")})`;
  }
  if (manifest.delivery.ids.length > 0) return manifest.delivery.ids.join(", ");
  return "none (source aspect, no delivery profile)";
}

function countEscalations(manifest: ProjectionManifest): number {
  // Escalation counts are derived at generation time and surfaced via warnings.
  return manifest.warnings.filter((warning) => warning.startsWith("escalation:")).length;
}

function collectRisks(beat: StoryboardBeat): string[] {
  return [...beat.primary?.risks ?? [], ...beat.fallbacks.flatMap((fallback) => fallback.risks)];
}
