import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { candidateSupportsVisual } from "../artifacts/source-media-capabilities.js";
import { deriveShortFormRetentionProfile } from "../editorial/short-form-retention.js";
import { getCandidateRef } from "./candidate-ref.js";
import type { UtteranceSpan } from "./trim.js";
import type { CreatorShortVoBrollProvenance, EditBlueprint, SelectsCandidates } from "./types.js";

const KICKOFF_PHRASES_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../editorial/kickoff-phrases.yaml",
);

interface KickoffPhraseConfig {
  version: "1";
  policy: "creator-short-kickoff-phrases/v1";
  phrases: string[];
}

export interface CreatorShortKickoffAnchor {
  status: "detected";
  phrasePolicy: "creator-short-kickoff-phrases/v1";
  matchedPhrase: string;
  candidateRef: string;
  assetId: string;
  sourceTimeUs: number;
  detectionSource: "transcript_item" | "candidate_transcript_excerpt";
}

export interface CreatorShortVoBrollPreset {
  policy: "creator-short-vo-broll/v1";
  minInsertFrames: number;
  maxInsertFrames: number;
  kickoffAnchor: CreatorShortKickoffAnchor | null;
  provenance: CreatorShortVoBrollProvenance;
}

export function loadCreatorShortKickoffPhrases(
  configPath: string = KICKOFF_PHRASES_PATH,
): KickoffPhraseConfig {
  const parsed = parseYaml(fs.readFileSync(configPath, "utf-8")) as Partial<KickoffPhraseConfig>;
  if (
    parsed.version !== "1" ||
    parsed.policy !== "creator-short-kickoff-phrases/v1" ||
    !Array.isArray(parsed.phrases) ||
    parsed.phrases.length === 0 ||
    parsed.phrases.some((phrase) => typeof phrase !== "string" || phrase.trim().length === 0)
  ) {
    throw new Error(`creator_short_kickoff_phrases_invalid:${configPath}`);
  }
  return {
    version: parsed.version,
    policy: parsed.policy,
    phrases: parsed.phrases.map((phrase) => phrase.trim()),
  };
}

function normalizeKickoffText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja-JP")
    .replace(/[\s\u3000、。！？!?・…「」『』"'（）()]/g, "");
}

function matchingPhrase(text: string, phrases: string[]): string | undefined {
  const normalized = normalizeKickoffText(text);
  return phrases.find((phrase) => normalized.includes(normalizeKickoffText(phrase)));
}

export function detectCreatorShortKickoffAnchor(
  selects: Pick<SelectsCandidates, "candidates">,
  utterancesByAsset: ReadonlyMap<string, UtteranceSpan[]> = new Map(),
  config: KickoffPhraseConfig = loadCreatorShortKickoffPhrases(),
): CreatorShortKickoffAnchor | null {
  const detected: CreatorShortKickoffAnchor[] = [];
  for (const candidate of selects.candidates) {
    if (candidate.role !== "dialogue" || candidate.media_kind === "image") continue;
    const candidateRef = getCandidateRef(candidate);
    const utterances = utterancesByAsset.get(candidate.asset_id) ?? [];
    for (const utterance of utterances) {
      if (
        !utterance.text ||
        utterance.end_us <= candidate.src_in_us ||
        utterance.start_us >= candidate.src_out_us
      ) continue;
      const phrase = matchingPhrase(utterance.text, config.phrases);
      if (!phrase) continue;
      detected.push({
        status: "detected",
        phrasePolicy: config.policy,
        matchedPhrase: phrase,
        candidateRef,
        assetId: candidate.asset_id,
        sourceTimeUs: Math.max(candidate.src_in_us, utterance.start_us),
        detectionSource: "transcript_item",
      });
    }
    const excerptPhrase = candidate.transcript_excerpt
      ? matchingPhrase(candidate.transcript_excerpt, config.phrases)
      : undefined;
    if (excerptPhrase && !detected.some((anchor) => anchor.candidateRef === candidateRef)) {
      detected.push({
        status: "detected",
        phrasePolicy: config.policy,
        matchedPhrase: excerptPhrase,
        candidateRef,
        assetId: candidate.asset_id,
        sourceTimeUs: candidate.src_in_us,
        detectionSource: "candidate_transcript_excerpt",
      });
    }
  }
  return detected.sort((left, right) =>
    left.sourceTimeUs - right.sourceTimeUs ||
    left.assetId.localeCompare(right.assetId) ||
    left.candidateRef.localeCompare(right.candidateRef)
  )[0] ?? null;
}

/**
 * Activate only for a real short-social talking-head project that has both
 * authored dialogue and usable B-roll. Human-authored exact plans stay
 * authoritative and are never rewritten by this automatic preset.
 */
export function resolveCreatorShortVoBrollPreset(
  brief: unknown,
  blueprint: Pick<EditBlueprint, "track_layout">,
  selects: Pick<SelectsCandidates, "candidates" | "editorial_summary">,
  fpsNum: number,
  fpsDen: number,
  exactCandidatePlanOrder: boolean,
  utterancesByAsset: ReadonlyMap<string, UtteranceSpan[]> = new Map(),
): CreatorShortVoBrollPreset | null {
  const shortForm = deriveShortFormRetentionProfile(brief);
  if (
    !shortForm.enabled ||
    exactCandidatePlanOrder ||
    (blueprint.track_layout ?? "single") !== "single" ||
    selects.editorial_summary?.dominant_visual_mode !== "talking_head"
  ) {
    return null;
  }
  const hasBroll = selects.candidates.some((candidate) =>
    candidateSupportsVisual(candidate) &&
    (candidate.role === "support" || candidate.role === "texture")
  );
  const hasDialogue = selects.candidates.some((candidate) =>
    candidate.role === "dialogue" &&
    candidate.media_kind !== "image" &&
    candidate.source_capabilities?.has_audio !== false
  );
  if (!hasBroll || !hasDialogue) return null;

  const fps = fpsNum / fpsDen;
  const kickoffAnchor = detectCreatorShortKickoffAnchor(selects, utterancesByAsset);
  const minInsertFrames = Math.max(1, Math.ceil(1.5 * fps));
  const maxInsertFrames = Math.max(1, Math.floor(3 * fps));
  const provenance: CreatorShortVoBrollProvenance = {
    policy: "creator-short-vo-broll/v1",
    phrase_policy: "creator-short-kickoff-phrases/v1",
    min_insert_frames: minInsertFrames,
    max_insert_frames: maxInsertFrames,
    audio_mode: "dialogue_voice_over",
    anchor_status: kickoffAnchor ? "detected" : "degraded_no_kickoff_phrase",
    degraded: kickoffAnchor === null,
    ...(kickoffAnchor
      ? {
          matched_phrase: kickoffAnchor.matchedPhrase,
          candidate_ref: kickoffAnchor.candidateRef,
          asset_id: kickoffAnchor.assetId,
          source_time_us: kickoffAnchor.sourceTimeUs,
          detection_source: kickoffAnchor.detectionSource,
        }
      : { degrade_reason: "kickoff_phrase_not_detected" as const }),
  };
  return {
    policy: "creator-short-vo-broll/v1",
    minInsertFrames,
    maxInsertFrames,
    kickoffAnchor,
    provenance,
  };
}
