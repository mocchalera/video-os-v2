import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  BriefCaptionPolicy,
  CaptionOverlay,
  Candidate,
  CreativeBrief,
  EditBlueprint,
  TimelineIR,
} from "../compiler/types.js";
import { loadProfiles } from "../editorial/policy-resolver.js";

export type CaptionPolicySource = "explicit_brief" | "profile_default" | "global_default";

export interface ResolvedCaptionPolicy {
  mode: BriefCaptionPolicy;
  source: CaptionPolicySource;
}

export interface CaptionContext {
  brief: CreativeBrief;
  blueprint: EditBlueprint;
  candidates: Candidate[];
  projectPath: string;
  repoRoot: string;
  fpsNum: number;
  fpsDen: number;
}

interface GrowthManualMoment {
  segment_id?: string;
  asset_id?: string;
  date?: string;
  caption?: string;
  milestone?: string;
  label?: string;
  title?: string;
}

export function resolveCaptionPolicy(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
  repoRoot: string,
): ResolvedCaptionPolicy {
  if (brief.caption_policy) {
    return { mode: brief.caption_policy, source: "explicit_brief" };
  }

  const profileId = blueprint.resolved_profile?.id ?? brief.editorial?.profile_hint;
  if (profileId) {
    const profile = loadProfiles(path.join(repoRoot, "runtime/editorial/profiles")).get(profileId);
    if (profile?.defaults.caption_policy) {
      return { mode: profile.defaults.caption_policy, source: "profile_default" };
    }
    if (profileId === "family-growth-recap") {
      return { mode: "auto", source: "profile_default" };
    }
  }

  const projectFormat = (brief.project as { format?: string } | undefined)?.format;
  if (brief.project?.strategy === "family-growth-recap" || projectFormat === "keepsake") {
    return { mode: "auto", source: "global_default" };
  }

  return { mode: "off", source: "global_default" };
}

export function calculateAgeLabel(birthDate: string, eventDate: string): string | null {
  const birth = parseDateOnly(birthDate);
  const event = parseDateOnly(eventDate);
  if (!birth || !event || event.getTime() < birth.getTime()) return null;

  let months = (event.getUTCFullYear() - birth.getUTCFullYear()) * 12 +
    (event.getUTCMonth() - birth.getUTCMonth());
  if (event.getUTCDate() < birth.getUTCDate()) {
    months -= 1;
  }
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  return `${years}歳${remainingMonths}ヶ月`;
}

export function attachAutoCaptions(
  timeline: TimelineIR,
  ctx: CaptionContext,
  policy: ResolvedCaptionPolicy = resolveCaptionPolicy(ctx.brief, ctx.blueprint, ctx.repoRoot),
): void {
  timeline.provenance.caption_policy = policy;
  if (policy.mode !== "auto") return;

  const candidatesByRef = new Map<string, Candidate>();
  const candidatesBySegment = new Map<string, Candidate[]>();
  for (const candidate of ctx.candidates) {
    if (candidate.candidate_id) candidatesByRef.set(candidate.candidate_id, candidate);
    const list = candidatesBySegment.get(candidate.segment_id) ?? [];
    list.push(candidate);
    candidatesBySegment.set(candidate.segment_id, list);
  }

  const manualMoments = loadGrowthManualMoments(ctx.projectPath);
  const beatById = new Map(ctx.blueprint.beats.map((beat) => [beat.id, beat]));
  const fps = ctx.fpsNum / ctx.fpsDen;

  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) {
      const candidate = (clip.candidate_ref ? candidatesByRef.get(clip.candidate_ref) : undefined) ??
        candidatesBySegment.get(clip.segment_id)?.[0];
      const beat = beatById.get(clip.beat_id);
      const manual = findManualMoment(manualMoments, clip.segment_id, clip.asset_id);
      const eventDate = manual?.date ?? inferDateForClip(candidate, beat?.label);
      const milestone = cleanMilestone(
        manual?.milestone ??
        manual?.caption ??
        manual?.label ??
        manual?.title ??
        candidate?.trim_hint?.interest_point_label ??
        beat?.purpose ??
        candidate?.why_it_matches,
      );

      const parts = [
        eventDate ? formatYearMonth(eventDate) : undefined,
        eventDate && ctx.brief.subject?.birth_date
          ? calculateAgeLabel(ctx.brief.subject.birth_date, eventDate)
          : undefined,
        milestone,
      ].filter((part): part is string => !!part && part.trim().length > 0);

      if (parts.length === 0) continue;
      const text = dedupeParts(parts).join("  ");
      const inFrame = clip.timeline_in_frame + Math.min(Math.round(fps * 0.35), Math.max(0, clip.timeline_duration_frames - 1));
      const captionDuration = Math.min(clip.timeline_duration_frames, Math.max(Math.round(fps * 3.2), Math.round(clip.timeline_duration_frames * 0.45)));
      const outFrame = Math.min(
        clip.timeline_in_frame + clip.timeline_duration_frames,
        inFrame + captionDuration,
      );
      if (outFrame <= inFrame) continue;

      const caption: CaptionOverlay = {
        text,
        in_frame: inFrame,
        out_frame: outFrame,
        style: milestone ? "gentle-lower-third" : "simple-shadow",
      };
      clip.captions = [caption];
    }
  }
}

export function inferDateForClip(candidate?: Candidate, beatLabel?: string): string | undefined {
  const sources = [
    candidate?.segment_id,
    candidate?.trim_hint?.peak_ref,
    beatLabel,
  ].filter((value): value is string => !!value);
  for (const source of sources) {
    const dashed = source.match(/(20\d{2}|19\d{2})[-_/年.]?([01]\d)[-_/月.]?([0-3]\d)/);
    if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
  }
  return undefined;
}

function parseDateOnly(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function formatYearMonth(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!match) return value;
  return `${match[1]}/${match[2]}`;
}

function cleanMilestone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/^\d{4}[-/年.]\d{2}[-/月.]\d{2}\s*/, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function dedupeParts(parts: string[]): string[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    if (seen.has(part)) return false;
    seen.add(part);
    return true;
  });
}

function loadGrowthManualMoments(projectPath: string): GrowthManualMoment[] {
  const specPath = path.join(projectPath, "04_plan/growth_manual_spec.json");
  if (!fs.existsSync(specPath)) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(specPath, "utf-8")) as {
      moments?: GrowthManualMoment[];
      clips?: GrowthManualMoment[];
      items?: GrowthManualMoment[];
      segments?: GrowthManualMoment[];
    };
    return doc.moments ?? doc.clips ?? doc.items ?? doc.segments ?? [];
  } catch {
    return [];
  }
}

function findManualMoment(
  moments: GrowthManualMoment[],
  segmentId: string,
  assetId: string,
): GrowthManualMoment | undefined {
  return moments.find((moment) => moment.segment_id === segmentId) ??
    moments.find((moment) => moment.asset_id === assetId);
}

export function readBriefForCaptionPolicy(projectDir: string): CreativeBrief {
  return parseYaml(fs.readFileSync(path.join(projectDir, "01_intent/creative_brief.yaml"), "utf-8")) as CreativeBrief;
}
