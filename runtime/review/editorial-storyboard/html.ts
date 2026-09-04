/**
 * Offline, self-contained semantic HTML renderer for the editorial
 * storyboard projection.
 *
 * - No scripts, no network: strict CSP, inline CSS only.
 * - Semantic DOM order is identical at every viewport and remains readable
 *   with CSS disabled (headings → summary list → ribbon list → beat cards).
 * - Source frame and delivery framing are always separately labeled.
 * - Missing visual evidence renders an explicit INVALID/warning block; the
 *   renderer never substitutes a silent fallback image.
 */

import type {
  FramingPlan,
  ProjectionManifest,
  ResolvedCandidateBinding,
  StoryboardBeat,
} from "./types.js";
import { framedPreviewGeometry } from "./framing.js";

export interface HtmlRenderInput {
  manifest: ProjectionManifest;
  beats: StoryboardBeat[];
  /** Framing plans per beat id, in delivery display order. */
  framingByBeat: Map<string, FramingPlan[]>;
  /** Relative frame file (inside frames/) per beat id; null when unavailable. */
  primaryFrameByBeat: Map<string, string | null>;
  filmstripFileByBeat: Map<string, string | null>;
  waveformFileByBeat: Map<string, string | null>;
  fallbackFrameFilesByBeat: Map<string, Array<{ ref: string; file: string | null }>>;
  sourceAspectByBeat: Map<string, number | null>;
  unassignedWarnings: Array<{ clip_id: string; reason: string }>;
}

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join("; ");

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return String(value);
}

function fmtUs(us: number | null): string {
  if (us === null) return "—";
  return `${(us / 1_000_000).toFixed(3)}s`;
}

export function renderStoryboardHtml(input: HtmlRenderInput): string {
  const { manifest } = input;
  const status = manifest.invalid.length > 0 ? "INVALID" : "CURRENT";
  const statusGlyph = status === "INVALID" ? "✕" : "✓";

  return `<!doctype html>
<html lang="${esc(guessLang(manifest))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${esc(CSP)}">
<title>Editorial storyboard — ${esc(manifest.project_title ?? manifest.project_id)} (${esc(status)})</title>
<style>
:root { color-scheme: light dark; --ink: #16211c; --paper: #fbfaf7; --card: #ffffff; --line: #d8d5cc; --accent: #14655a; --warn-bg: #fdf3e3; --warn-line: #b97d24; --invalid-bg: #fbeaea; --invalid-line: #b03434; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0 auto; max-width: 76rem; padding: 1rem clamp(.75rem, 2vw, 2rem) 4rem; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.55; color: var(--ink); background: var(--paper); overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; display: block; }
a { color: var(--accent); }
a:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.sb-status { display: inline-block; font-weight: 700; letter-spacing: .04em; padding: .35rem .8rem; min-height: 44px; border: 2px solid var(--accent); border-radius: .4rem; background: #e7f2ef; }
.sb-status-invalid { border-color: var(--invalid-line); background: var(--invalid-bg); color: var(--invalid-line); }
.sb-summary dl { display: grid; grid-template-columns: max-content 1fr; gap: .15rem .9rem; margin: 1rem 0; }
.sb-summary dt { font-weight: 600; }
.sb-summary dd { margin: 0; }
.sb-hash { font-family: ui-monospace, monospace; font-size: .82em; word-break: break-all; }
.sb-ribbon ol { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; margin: .5rem 0 0; padding: 0; }
.sb-ribbon li { flex: 1 1 8rem; min-width: 8rem; }
.sb-ribbon a { display: block; min-height: 44px; padding: .5rem .65rem; border: 1px solid var(--line); border-radius: .45rem; background: var(--card); text-decoration: none; }
.sb-ribbon a:hover { border-color: var(--accent); }
.sb-beat { border: 1px solid var(--line); border-radius: .6rem; background: var(--card); padding: 1rem 1.1rem 1.25rem; margin: 1.25rem 0; scroll-margin-top: 1rem; }
.sb-beat-invalid { border-color: var(--invalid-line); border-width: 2px; }
.sb-grid { display: grid; grid-template-columns: 1fr; gap: 1.1rem; }
.sb-figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr)); gap: 1rem; margin: 0; }
.sb-figures figure { margin: 0; }
.sb-figures figcaption { font-size: .85rem; margin-top: .35rem; }
figcaption .sb-kind { display: inline-block; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; font-size: .72rem; padding: .1rem .45rem; border-radius: .3rem; border: 1px solid currentColor; }
.sb-source-frame .sb-kind { color: #5a4a12; background: #f6eecf; }
.sb-framed .sb-kind, .sb-waveform .sb-kind { color: var(--accent); background: #e7f2ef; }
.sb-filmstrip .sb-kind { color: #4a3c74; background: #ece7fa; }
.sb-canvas { position: relative; width: 100%; overflow: hidden; border-radius: .35rem; border: 1px solid var(--line); background: repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50% / 16px 16px; }
.sb-canvas img { position: absolute; max-width: none; height: auto; }
.sb-placeholder { border: 2px dashed var(--warn-line); background: var(--warn-bg); color: #6a4a10; padding: 1rem; border-radius: .35rem; font-size: .9rem; }
.sb-warning, .sb-invalid-note { border-left: 4px solid var(--warn-line); background: var(--warn-bg); padding: .5rem .75rem; margin: .5rem 0; }
.sb-invalid-note { border-color: var(--invalid-line); background: var(--invalid-bg); }
.sb-meta { font-size: .85rem; color: #4c564f; }
details.sb-details { margin-top: .75rem; border: 1px solid var(--line); border-radius: .45rem; padding: .5rem .8rem; background: #f6f5f1; }
details.sb-details summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; font-weight: 600; }
details.sb-details table { border-collapse: collapse; width: 100%; font-size: .82rem; }
details.sb-details td, details.sb-details th { border: 1px solid var(--line); padding: .3rem .5rem; text-align: left; vertical-align: top; }
.sb-checklist li { margin: .3rem 0; }
footer.sb-footer { margin-top: 3rem; border-top: 1px solid var(--line); padding-top: 1rem; font-size: .85rem; }
footer.sb-footer code { word-break: break-all; }
@media (min-width: 700px) { .sb-grid { grid-template-columns: 1fr 1fr; } .sb-grid > .sb-info { grid-column: 1 / -1; } }
@media (min-width: 1100px) { body { padding-top: 1.5rem; } .sb-grid { grid-template-columns: minmax(0, 7fr) minmax(14rem, 3fr); align-items: start; } .sb-grid > .sb-info { grid-column: auto; } .sb-beat { padding: 1.25rem 1.5rem 1.5rem; } }
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
</style>
</head>
<body>
<header class="sb-summary">
<h1>${esc(manifest.project_title ?? manifest.project_id)}</h1>
<p><span class="sb-status${status === "INVALID" ? " sb-status-invalid" : ""}">${statusGlyph} ${esc(status)}</span></p>
<p class="sb-meta">Editorial storyboard review projection · <code>${esc(manifest.projection_id)}</code> · generated from canonical artifacts (read-only)</p>
<dl>
<dt>Projection source</dt><dd>${esc(manifest.source_mode)} mode</dd>
<dt>Delivery</dt><dd>${esc(formatDelivery(manifest))}</dd>
<dt>Canvas</dt><dd>${esc(manifest.canvas.aspect_ratio_label)}${manifest.canvas.width ? ` (${manifest.canvas.width}×${manifest.canvas.height})` : ""} — basis: ${esc(manifest.canvas.basis)}</dd>
<dt>FPS</dt><dd>${manifest.fps ? `${manifest.fps.num}/${manifest.fps.den}` : "not specified by blueprint (frames shown without seconds)"}</dd>
<dt>Total frames</dt><dd>${num(manifest.total_frames)} (blueprint target)</dd>
${manifest.compiled_span_frames !== null ? `<dt>Compiled span</dt><dd>${num(manifest.compiled_span_frames)} frames${manifest.timeline_end_frame !== null ? `, end frame ${num(manifest.timeline_end_frame)}` : ""}</dd>` : ""}
<dt>Beats</dt><dd>${manifest.beat_count}</dd>
<dt>BGM policy</dt><dd>${esc(manifest.policy_summaries.music || "not specified")}</dd>
<dt>Dialogue policy</dt><dd>${esc(manifest.policy_summaries.dialogue || "not specified")}</dd>
<dt>Caption policy</dt><dd>${esc(manifest.policy_summaries.caption || "not specified")}</dd>
<dt>Unresolved uncertainty count</dt><dd>${esc(String(manifest.warnings.filter((w) => w.startsWith("escalation:")).length))}</dd>
<dt>Approval target</dt><dd class="sb-hash">blueprint ${esc(hashTail(manifest.approval_identity.artifact_hashes.blueprint))} · selects ${esc(hashTail(manifest.approval_identity.artifact_hashes.selects))} · delivery ${esc(hashTail(manifest.approval_identity.delivery_hash))}</dd>
</dl>
<p class="sb-meta">Approval is bound to canonical artifact hashes above — not to this HTML. After any input change this projection is STALE and must not be approved.</p>
</header>
<nav class="sb-ribbon" aria-label="Timeline ribbon (reading path)">
<h2 style="font-size:1rem;margin:.75rem 0 0">Timeline ribbon</h2>
<ol>
${input.beats.map((beat) => ribbonItem(beat, manifest)).join("\n")}
</ol>
</nav>
<main>
<h2>Storyboards</h2>
${input.beats.map((beat) => renderBeat(input, beat)).join("\n")}
</main>
<section aria-labelledby="sb-uncertainties">
<h2 id="sb-uncertainties">Uncertainties and approval checklist</h2>
${renderUncertaintiesSection(input)}
${renderChecklist(input)}
</section>
<footer class="sb-footer">
<p>Projection <code>${esc(manifest.projection_id)}</code> · mode ${esc(manifest.source_mode)} · generator ${esc(manifest.generator)} · inputs tracked with hashes in <code>manifest.json</code>.</p>
<p>Regenerate after changes:</p>
<p><code>${esc(manifest.regenerate_command)}</code></p>
</footer>
</body>
</html>
`;
}

// ── Section renderers ───────────────────────────────────────────────

function ribbonItem(beat: StoryboardBeat, manifest: ProjectionManifest): string {
  const start = beat.compiled?.start_frame ?? beat.plan_start_frame;
  const end = beat.compiled?.end_frame ?? beat.plan_start_frame + beat.plan_duration_frames;
  const flags = beat.invalid_reasons.length > 0 ? " ✕ INVALID" : beat.warnings.length > 0 ? " ⚠" : "";
  const weight = Math.max(beat.compiled?.compiled_frames ?? beat.plan_duration_frames, 1);
  void manifest;
  return `  <li style="flex-grow:${weight}"><a href="#beat-${esc(beat.beat_id)}">${String(beat.index).padStart(2, "0")} ${esc(beat.label)}<br><span class="sb-meta">${start}–${end}${flags}</span></a></li>`;
}

function renderBeat(input: HtmlRenderInput, beat: StoryboardBeat): string {
  const invalid = beat.invalid_reasons.length > 0;
  const framingPlans = input.framingByBeat.get(beat.beat_id) ?? [];
  const sourceAspect = input.sourceAspectByBeat.get(beat.beat_id) ?? null;
  const position = beat.compiled && beat.compiled.clip_count > 0
    ? `plan frames ${beat.plan_start_frame}–${beat.plan_start_frame + beat.plan_duration_frames}; compiled frames ${num(beat.compiled.start_frame)}–${num(beat.compiled.end_frame)} (${num(beat.compiled.compiled_frames)}f across ${beat.compiled.clip_count} clip(s))`
    : `plan frames ${beat.plan_start_frame}–${beat.plan_start_frame + beat.plan_duration_frames}`;

  return `<article class="sb-beat${invalid ? " sb-beat-invalid" : ""}" id="beat-${esc(beat.beat_id)}" aria-labelledby="beat-${esc(beat.beat_id)}-title">
<h3 id="beat-${esc(beat.beat_id)}-title">${String(beat.index).padStart(2, "0")} · ${esc(beat.label)}${beat.viewer_label ? ` — ${esc(beat.viewer_label)}` : ""}</h3>
<p class="sb-meta">${esc(position)}${beat.story_role ? ` · story role: ${esc(beat.story_role)}` : ""}</p>
<div class="sb-grid">
<div class="sb-visuals">
<div class="sb-figures">
${renderPrimaryVisual(input, beat)}
${renderFramedVisuals(framingPlans, sourceAspect)}
${renderFallbackVisuals(input, beat)}
${renderFilmstrip(input, beat)}
${renderAudioVisual(input, beat)}
</div>
</div>
<div class="sb-info">
${beat.purpose ? `<p><strong>Purpose.</strong> ${esc(beat.purpose)}</p>` : ""}
${beat.transcript_excerpt ? `<p><strong>Speech / caption.</strong> 「${esc(beat.transcript_excerpt)}」</p>` : beat.media_kind === "audio" ? "<p><strong>Audio-only beat.</strong> No transcript excerpt available for this candidate.</p>" : ""}
${beat.required_roles.length > 0 ? `<p class="sb-meta">Required roles: ${esc(beat.required_roles.join(", "))}</p>` : ""}
${beat.notes ? `<p class="sb-meta">Notes: ${esc(beat.notes)}</p>` : ""}
${beat.uncertainties.map((u) => `<p class="sb-warning">⚠ Uncertainty: ${esc(u)}</p>`).join("\n")}
${collectRisks(beat).map((r) => `<p class="sb-warning">⚠ Risk: ${esc(r)}</p>`).join("\n")}
${beat.invalid_reasons.map((reason) => `<p class="sb-invalid-note">✕ INVALID: ${esc(reason)}</p>`).join("\n")}
${beat.warnings.map((warning) => `<p class="sb-warning">⚠ ${esc(warning)}</p>`).join("\n")}
<details class="sb-details">
<summary>Technical details</summary>
${renderTechDetails(beat)}
</details>
</div>
</div>
</article>`;
}

function renderPrimaryVisual(input: HtmlRenderInput, beat: StoryboardBeat): string {
  const file = input.primaryFrameByBeat.get(beat.beat_id) ?? null;
  const caption = `Source frame — representative of ${esc(beat.label)}. Basis: ${esc(beat.representative.basis)} (${esc(beat.representative.basis_detail)})`;
  if (!file) {
    return `<figure class="sb-source-frame">
<span class="sb-kind">source frame</span>
<div class="sb-placeholder">No representative frame available. ${esc(beat.representative.basis_detail)} This card must not be approved as visually verified.</div>
<figcaption>${caption}</figcaption>
</figure>`;
  }
  return `<figure class="sb-source-frame">
<span class="sb-kind">source frame</span>
<img src="frames/${esc(file)}" alt="${esc(`Representative source frame for beat ${beat.index}: ${beat.label}`)}">
<figcaption>${caption}<br><span class="sb-meta">asset ${esc(beat.representative.source_asset_id ?? "—")} · hash ${esc(hashTail(beat.representative.source_asset_hash))}</span></figcaption>
</figure>`;
}

function renderFramedVisuals(plans: FramingPlan[], sourceAspect: number | null): string {
  return plans.map((plan) => {
    const geometry = framedPreviewGeometry(plan, sourceAspect);
    const src = plan.primary_frame_relative_path ?? "";
    const label = plan.canvas.basis === "delivery_profile"
      ? `Delivery framing — ${esc(plan.canvas.aspect_ratio_label)} canvas`
      : `Delivery framing — ${esc(plan.canvas.aspect_ratio_label)} canvas (timeline/source basis)`;
    const treatment = plan.fit === "crop"
      ? `${plan.crop_basis === "registered_visual_intent" ? "authored crop" : "default center cover-crop preview"}`
      : plan.fit;
    if (!src) {
      return `<figure class="sb-framed">
<span class="sb-kind">delivery framing</span>
<div class="sb-placeholder">${esc(label)}: no source frame available, so the framed preview cannot be rendered. ${esc(treatment)} planned.</div>
<figcaption>${label} · ${esc(treatment)}<br><span class="sb-meta">${esc(plan.note)}</span></figcaption>
</figure>`;
    }
    return `<figure class="sb-framed">
<span class="sb-kind">delivery framing</span>
<div class="sb-canvas" style="aspect-ratio:${esc(plan.canvas.aspect_ratio_label.replace(":", "/"))}">
<img src="frames/${esc(src)}" alt="${esc(`Delivery framing preview on ${plan.canvas.aspect_ratio_label} canvas for this beat`)}" style="width:${geometry.imgWidthPercent}%;height:${geometry.imgHeightPercent}%;left:${geometry.imgLeftPercent}%;top:${geometry.imgTopPercent}%;">
${plan.safe_overlays.map((overlay) => `<span role="presentation" title="${esc(overlay.label)}" style="position:absolute;left:${overlay.rect.x * 100}%;top:${overlay.rect.y * 100}%;width:${overlay.rect.width * 100}%;height:${overlay.rect.height * 100}%;border:2px dashed rgba(180,40,40,.75);border-radius:4px;"></span>`).join("")}
</div>
<figcaption>${label} · ${esc(treatment)}<br><span class="sb-meta">${esc(plan.note)}${plan.safe_area_note ? `<br>${esc(plan.safe_area_note)}` : ""}</span></figcaption>
</figure>`;
  }).join("\n");
}

function renderFallbackVisuals(input: HtmlRenderInput, beat: StoryboardBeat): string {
  const entries = input.fallbackFrameFilesByBeat.get(beat.beat_id) ?? [];
  return entries.map(({ ref, file }, i) => {
    const binding = beat.fallbacks[i];
    if (!file) {
      return `<figure class="sb-fallback">
<span class="sb-kind">fallback</span>
<div class="sb-placeholder">Fallback candidate ${esc(ref)}: no frame available.${binding && !binding.resolved ? " This fallback reference is UNRESOLVED." : ""}</div>
<figcaption>Fallback comparison — ${esc(ref)}</figcaption>
</figure>`;
    }
    return `<figure class="sb-fallback">
<span class="sb-kind">fallback</span>
<img src="frames/${esc(file)}" alt="${esc(`Fallback candidate frame for beat ${beat.index}: ${ref}`)}">
<figcaption>Fallback comparison — ${esc(ref)}<br><span class="sb-meta">${binding?.segment_id ? `${esc(binding.segment_id)} @ ${fmtUs(binding.src_in_us)}–${fmtUs(binding.src_out_us)}` : ""}</span></figcaption>
</figure>`;
  }).join("\n");
}

function renderFilmstrip(input: HtmlRenderInput, beat: StoryboardBeat): string {
  const file = input.filmstripFileByBeat.get(beat.beat_id) ?? null;
  if (!file) return "";
  return `<figure class="sb-filmstrip">
<span class="sb-kind">filmstrip</span>
<img src="frames/${esc(file)}" alt="${esc(`Filmstrip of the selected range for beat ${beat.index}: ${beat.label}`)}">
<figcaption>Selected source range overview — ${esc(fmtUs(beat.primary?.src_in_us ?? null))}–${esc(fmtUs(beat.primary?.src_out_us ?? null))}</figcaption>
</figure>`;
}

function renderAudioVisual(input: HtmlRenderInput, beat: StoryboardBeat): string {
  if (beat.media_kind !== "audio") return "";
  const file = input.waveformFileByBeat.get(beat.beat_id) ?? null;
  const transcript = beat.transcript_excerpt;
  const speaker = [beat.primary?.speaker_role, beat.primary?.audio_role].filter(Boolean).join(" · ");
  if (file) {
    return `<figure class="sb-waveform">
<span class="sb-kind">waveform</span>
<img src="frames/${esc(file)}" alt="${esc(`Waveform of the selected audio range for beat ${beat.index}`)}">
<figcaption>Selected audio range ${esc(fmtUs(beat.primary?.src_in_us ?? null))}–${esc(fmtUs(beat.primary?.src_out_us ?? null))}${speaker ? ` · ${esc(speaker)}` : ""}</figcaption>
</figure>`;
  }
  return `<figure class="sb-waveform">
<span class="sb-kind">audio</span>
<div class="sb-placeholder">Waveform unavailable (ffmpeg or source audio missing). Transcript representation below is authoritative for review.</div>
${transcript ? `<p>Transcript excerpt: 「${esc(transcript)}」</p>` : "<p>No transcript excerpt available.</p>"}
<figcaption>Audio-only beat${speaker ? ` · ${esc(speaker)}` : ""} · selected range ${esc(fmtUs(beat.primary?.src_in_us ?? null))}–${esc(fmtUs(beat.primary?.src_out_us ?? null))}</figcaption>
</figure>`;
}

function renderTechDetails(beat: StoryboardBeat): string {
  const rows: string[] = [];
  const addRow = (label: string, value: string) =>
    rows.push(`<tr><th scope="row">${esc(label)}</th><td>${value}</td></tr>`);

  if (beat.primary) {
    addRow("primary candidate ref", `<code>${esc(beat.primary.ref)}</code>${beat.primary.resolved ? "" : ' <strong>UNRESOLVED</strong>'}`);
    if (beat.primary.resolved) {
      addRow("candidate id / segment", `${esc(beat.primary.candidate_id ?? "—")} / ${esc(beat.primary.segment_id ?? "—")}`);
      addRow("asset", `${esc(beat.primary.asset_id ?? "—")} · content hash ${esc(beat.primary.asset_hash ?? "unregistered")}`);
      addRow("source in/out", `${esc(fmtUs(beat.primary.src_in_us))}–${esc(fmtUs(beat.primary.src_out_us))}`);
      addRow("confidence / role", `${esc(num(beat.primary.confidence))} / ${esc(beat.primary.role ?? "—")}`);
      if (beat.primary.quality_flags.length > 0) addRow("quality flags", esc(beat.primary.quality_flags.join(", ")));
      if (beat.primary.evidence.length > 0) addRow("evidence", esc(beat.primary.evidence.join(", ")));
      if (beat.primary.trim_hint) {
        addRow(
          "trim hint",
          `center ${esc(fmtUs(beat.primary.trim_hint.source_center_us))}${beat.primary.trim_hint.center_source ? ` (${esc(beat.primary.trim_hint.center_source)})` : ""}${beat.primary.trim_hint.peak_ref ? ` peak ${esc(beat.primary.trim_hint.peak_ref)}` : ""}`,
        );
      }
    }
  }
  for (const fallback of beat.fallbacks) {
    addRow(
      `fallback ${esc(fallback.ref)}`,
      fallback.resolved
        ? `${esc(fallback.segment_id ?? "—")} @ ${esc(fmtUs(fallback.src_in_us))}–${esc(fmtUs(fallback.src_out_us))}`
        : "UNRESOLVED against selects_candidates.yaml",
    );
  }
  addRow("representative basis", `${esc(beat.representative.basis)} @ ${esc(fmtUs(beat.representative.timestamp_us))}`);
  addRow("representative asset hash", esc(beat.representative.source_asset_hash ?? "unregistered"));
  if (beat.compiled && beat.compiled.clips.length > 0) {
    addRow(
      "compiled clips",
      beat.compiled.clips.map((clip) =>
        `<code>${esc(clip.clip_id)}</code> (${esc(clip.track_id)}) @ ${num(clip.timeline_in_frame)}+${num(clip.timeline_duration_frames)}f · src ${esc(fmtUs(clip.src_in_us))}–${esc(fmtUs(clip.src_out_us))}${
          clip.head_trim_us !== null || clip.tail_trim_us !== null
            ? ` · trim Δ head ${esc(num(clip.head_trim_us))}us / tail ${esc(num(clip.tail_trim_us))}us`
            : ""
        }`,
      ).join("<br>"),
    );
    if (beat.compiled.overrun_frames !== null) addRow("overrun/shortfall vs target", `${num(beat.compiled.overrun_frames)} frames`);
  }

  return `<table>
<tbody>
${rows.join("\n")}
</tbody>
</table>`;
}

function renderUncertaintiesSection(input: HtmlRenderInput): string {
  const beatsWithUncertainty = input.beats.filter((beat) => beat.uncertainties.length > 0);
  if (beatsWithUncertainty.length === 0) {
    return "<p>No beat-level uncertainties recorded in 04_plan/uncertainty_register.yaml.</p>";
  }
  return `<ul>
${beatsWithUncertainty.flatMap((beat) => beat.uncertainties.map((u) => `<li>${esc(u)} — affects <a href="#beat-${esc(beat.beat_id)}">${esc(beat.label)}</a></li>`)).join("\n")}
</ul>`;
}

function renderChecklist(input: HtmlRenderInput): string {
  const items = input.beats.map((beat) =>
    `  <li><a href="#beat-${esc(beat.beat_id)}">${String(beat.index).padStart(2, "0")} ${esc(beat.label)}</a>${
      beat.invalid_reasons.length > 0 ? " — ✕ INVALID (must fix before approval)" : beat.warnings.length > 0 ? " — ⚠ has warnings" : ""
    }</li>`,
  );
  return `<h3>Per-beat decision units</h3>
<p>Decide OK / 要修正 per unit. Approval is recorded against canonical artifact hashes, not this HTML.</p>
<ul class="sb-checklist">
${items.join("\n")}
</ul>
${input.unassignedWarnings.length > 0 ? `<h3>Unassigned compiled clips</h3><ul>${input.unassignedWarnings.map((warning) => `<li><code>${esc(warning.clip_id)}</code>: ${esc(warning.reason)}</li>`).join("")}</ul>` : ""}`;
}

// ── Small helpers ───────────────────────────────────────────────────

function collectRisks(beat: StoryboardBeat): string[] {
  return [...beat.primary?.risks ?? [], ...beat.fallbacks.flatMap((fallback) => fallback.risks)];
}

function formatDelivery(manifest: ProjectionManifest): string {
  if (manifest.delivery.mode === "all" && manifest.delivery.ids.length > 0) {
    return `all deliveries (${manifest.delivery.ids.join(", ")})`;
  }
  if (manifest.delivery.ids.length > 0) return manifest.delivery.ids.join(", ");
  return "no delivery profile — source aspect used, ratio not inferred";
}

function hashTail(value: string | null | undefined): string {
  if (!value) return "n/a";
  return value.startsWith("sha256:") ? value.slice(7, 19) : value.slice(0, 12);
}

function guessLang(manifest: ProjectionManifest): string {
  const captionLang = manifest.caption_policy_language;
  return typeof captionLang === "string" && captionLang.length >= 2 ? captionLang.slice(0, 2) : "en";
}
