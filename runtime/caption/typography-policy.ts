import * as fs from "node:fs";
import { validateArtifact } from "../artifacts/loaders.js";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import { breakLines, measureDisplayUnits, type BreakPriority, type LineBreakResult, type LayoutPolicy } from "./line-breaker.js";
import { hasCaptionStylePreset } from "../../editor/shared/caption-style-tokens.js";

export interface TypographyPolicyDocument {
  version: "typography-policy/v1";
  profile_id: string;
  caption_mode: "full_transcript" | "keyword_telop" | "content_element";
  baseline_style_ref: string;
  font_contract_ref: "existing-caption-font-contract/v1";
  measurement: { method: "unicode-display-units/v1"; full_width_unit: number; latin_unit: number; max_line_units: number; max_lines: number; max_cps: number };
  wrapping: { break_priorities: string[]; protected_terms: string[]; line_start_punctuation: string[]; line_end_punctuation: string[]; orphan_tokens?: string[]; orphan_policy: "avoid" | "allow" | "human_review"; manual_override: { source: "caption-review-patch/v1"; allowed: boolean } };
  reference_scale: { output_width: number; output_height: number; font_scale_relation: string; line_height_relation: string };
  visual: { tracking: number; outline: { enabled: boolean; style_ref: string }; shadow: { enabled: boolean; style_ref: string }; panel: { enabled: boolean; style_ref: string }; contrast: { fill_rgba: string; background_rgba: string; minimum_ratio: number } };
  hierarchy: Record<"speech" | "keyword" | "annotation" | "speaker" | "cta", string>;
  fallback: { registered_emphasis: string[]; registered_animation: string[]; registered_effect: string[]; unsupported_renderer: "registered_fallback" | "nle_handoff" | "blocker" };
  accessibility: { reduced_motion: "static" | "registered_fallback" | "human_review"; high_contrast: "registered_fallback" | "human_review"; audio_off: "retain_text" | "registered_fallback" | "human_review"; small_screen: "scale_profile" | "registered_fallback" | "human_review" };
}

export interface TypographyLayoutResolution {
  version: "typography-layout-resolution/v1";
  text: string;
  machine_lines: string[];
  lines: string[];
  manual_override_applied: boolean;
  display_units: number[];
  status: "ready" | "review" | "blocked";
  selection_reason?: string;
  issues: Array<{ code: "line_count" | "line_width" | "protected_term" | "orphan" | "punctuation" | "contrast" | "text_integrity"; severity: "warn" | "block"; reason: string }>;
}

export interface TypographyAccessibilityResolution { status: "ready" | "fallback" | "human_hold"; reduced_motion: boolean; high_contrast: boolean; audio_off: boolean; small_screen: boolean; reasons: string[] }

export function parseTypographyPolicy(input: unknown): TypographyPolicyDocument {
  const policy = structuredClone(validateArtifact<TypographyPolicyDocument>(input, "typography-policy.schema.json"));
  if (!hasCaptionStylePreset(policy.baseline_style_ref)) throw new Error(`typography baseline_style_ref is not registered: ${policy.baseline_style_ref}`);
  return policy;
}
export function loadTypographyPolicy(filePath: string): TypographyPolicyDocument {
  return parseTypographyPolicy(JSON.parse(fs.readFileSync(filePath, "utf8")));
}
export function typographyPolicyContentHash(policy: TypographyPolicyDocument): string { return computeNormalizedJsonHash(policy); }

function toLayoutPolicy(policy: TypographyPolicyDocument, language: string): LayoutPolicy {
  return { maxCharsPerLine: policy.measurement.max_line_units, maxLines: policy.measurement.max_lines, maxCps: policy.measurement.max_cps, language, measurement_mode: "unicode_display_units", full_width_unit: policy.measurement.full_width_unit, latin_unit: policy.measurement.latin_unit, maxLineUnits: policy.measurement.max_line_units, line_start_punctuation: policy.wrapping.line_start_punctuation, line_end_punctuation: policy.wrapping.line_end_punctuation, orphan_tokens: policy.wrapping.orphan_tokens, break_after: policy.wrapping.line_start_punctuation.flatMap((value) => [...value]), break_priorities: policy.wrapping.break_priorities as BreakPriority[] };
}

function contrastChannel(value: string): number {
  const channel = Number.parseInt(value, 16) / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
function contrastRatio(fill: string, background: string): number {
  const luminance = (value: string) => 0.2126 * contrastChannel(value.slice(0, 2)) + 0.7152 * contrastChannel(value.slice(2, 4)) + 0.0722 * contrastChannel(value.slice(4, 6));
  const left = luminance(fill); const right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function lineIssues(lines: string[], text: string, policy: TypographyPolicyDocument, layout: LayoutPolicy): TypographyLayoutResolution["issues"] {
  const issues: TypographyLayoutResolution["issues"] = [];
  if (lines.length > policy.measurement.max_lines) issues.push({ code: "line_count", severity: "block", reason: `line count ${lines.length} exceeds policy maximum` });
  lines.forEach((line) => {
    if (measureDisplayUnits(line, layout) > policy.measurement.max_line_units) issues.push({ code: "line_width", severity: "block", reason: "line exceeds policy display units" });
    if (policy.wrapping.line_start_punctuation.some((value) => [...value].some((part) => line.startsWith(part)))) issues.push({ code: "punctuation", severity: "warn", reason: "line begins with policy-declared punctuation" });
    if (/^ja/i.test(layout.language) && (policy.wrapping.orphan_tokens ?? []).some((value) => line.startsWith(value))) issues.push({ code: "orphan", severity: policy.wrapping.orphan_policy === "human_review" ? "block" : "warn", reason: "line starts with a policy-declared orphan token" });
  });
  for (const term of policy.wrapping.protected_terms) {
    if (!term || !text.includes(term)) continue;
    if (!lines.some((line) => line.includes(term))) issues.push({ code: "protected_term", severity: "block", reason: `protected term is split: ${term}` });
  }
  const ratio = contrastRatio(policy.visual.contrast.fill_rgba, policy.visual.contrast.background_rgba);
  if (ratio < policy.visual.contrast.minimum_ratio) issues.push({ code: "contrast", severity: "block", reason: `contrast ratio ${ratio.toFixed(3)} is below policy minimum` });
  return issues;
}

/** Resolve typography only; text and timing remain owned by the caption review layer. */
export function resolveTypographyLayout(input: { text: string; language: string; manual_lines?: string[]; policy: TypographyPolicyDocument }): TypographyLayoutResolution {
  const layout = toLayoutPolicy(input.policy, input.language);
  const machine: LineBreakResult = breakLines(input.text, layout, input.policy.wrapping.protected_terms);
  const manual = input.manual_lines !== undefined && input.policy.wrapping.manual_override.allowed;
  const lines = manual ? input.manual_lines!.map((line) => line.trim()).filter(Boolean) : machine.lines;
  const issues = lineIssues(lines, input.text, input.policy, layout);
  const flattened = lines.join("");
  const sourceComparable = input.text.replace(/\r?\n/g, "").replace(/\s+/g, " ");
  const linesComparable = flattened.replace(/\s+/g, " ");
  if (sourceComparable !== linesComparable) {
    issues.push({ code: "text_integrity", severity: "block", reason: "line-break input changes caption text; text/timing remains owned by the caption layer" });
  }
  if (machine.needsSplit) issues.push({ code: "line_count", severity: "block", reason: "machine breaker proposes a split beyond the declared line policy" });
  return { version: "typography-layout-resolution/v1", text: input.text, machine_lines: machine.lines, lines, manual_override_applied: manual, display_units: lines.map((line) => measureDisplayUnits(line, layout)), status: issues.some((issue) => issue.severity === "block") ? "blocked" : issues.length > 0 ? "review" : "ready", ...(machine.selection_reason ? { selection_reason: machine.selection_reason } : {}), issues };
}

export function resolveTypographyAccessibility(policy: TypographyPolicyDocument, input: { reduced_motion?: boolean; high_contrast?: boolean; audio_off?: boolean; small_screen?: boolean }): TypographyAccessibilityResolution {
  const reasons: string[] = [];
  let fallback = false;
  let hold = false;
  if (input.reduced_motion && policy.accessibility.reduced_motion !== "static") { reasons.push(`reduced motion uses ${policy.accessibility.reduced_motion}`); fallback = policy.accessibility.reduced_motion === "registered_fallback"; hold = policy.accessibility.reduced_motion === "human_review"; }
  if (input.high_contrast) { reasons.push(`high contrast uses ${policy.accessibility.high_contrast}`); fallback = true; hold ||= policy.accessibility.high_contrast === "human_review"; }
  if (input.audio_off && policy.accessibility.audio_off !== "retain_text") { reasons.push(`audio-off uses ${policy.accessibility.audio_off}`); fallback = true; hold ||= policy.accessibility.audio_off === "human_review"; }
  if (input.small_screen) { reasons.push(`small screen uses ${policy.accessibility.small_screen}`); fallback = true; hold ||= policy.accessibility.small_screen === "human_review"; }
  return { status: hold ? "human_hold" : fallback ? "fallback" : "ready", reduced_motion: Boolean(input.reduced_motion), high_contrast: Boolean(input.high_contrast), audio_off: Boolean(input.audio_off), small_screen: Boolean(input.small_screen), reasons };
}
