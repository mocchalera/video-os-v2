import { execFile } from "node:child_process";
import * as path from "node:path";

export type CameraMotionType =
  | "static"
  | "pan"
  | "tilt"
  | "push_in"
  | "pull_out"
  | "tracking"
  | "handheld"
  | "reveal"
  | "fast_action"
  | "mixed"
  | "unknown";

export type ScreenMotionDirection =
  | "none"
  | "ltr"
  | "rtl"
  | "up"
  | "down"
  | "toward_camera"
  | "away_camera"
  | "mixed"
  | "unknown";

export type CameraStability = "stable" | "slight" | "shaky" | "unknown";

export type UnifiedShotScale =
  | "extreme_wide"
  | "wide"
  | "medium_wide"
  | "medium"
  | "medium_close"
  | "close"
  | "extreme_close"
  | "detail"
  | "unknown";

export interface CameraMotionExtraction {
  camera_motion_description: string;
  camera_motion_type: CameraMotionType;
  camera_motion_direction: ScreenMotionDirection;
  camera_stability: CameraStability;
  motion_confidence: number | null;
  evidence: string[];
}

export interface SceneShotTakeExtraction {
  scene_number: string | null;
  shot_number: string | null;
  take_number: string | null;
  clip_number: string | null;
  camera_id: string | null;
  card_id: string | null;
  source: "filename_parser" | "unknown";
  confidence: number | null;
  evidence: string[];
}

export interface AudioLevelExtraction {
  peak_dbfs: number | null;
  rms_dbfs: number | null;
  integrated_lufs: number | null;
  silence_ratio: number | null;
  silence_head_us: number | null;
  silence_tail_us: number | null;
  has_silence: boolean;
  evidence: string[];
}

export interface AudioRange {
  startUs: number;
  endUs: number;
}

export const EDITORIAL_OBSERVATION_FIELDS = [
  "visual_tags",
  "motion_type",
  "camera_motion_direction",
  "subject_motion_direction",
  "shot_scale",
  "composition_anchor",
  "screen_side",
  "gaze_direction",
  "camera_axis",
  "dominant_subject_type",
  "avg_luma",
  "dominant_colors",
  "text_presence",
] as const;

export type EditorialObservationField = typeof EDITORIAL_OBSERVATION_FIELDS[number];

export interface EditorialObservationExtraction {
  present: boolean;
  values: Partial<Record<EditorialObservationField, string | number | string[]>>;
  field_confidence: Partial<Record<EditorialObservationField, number>>;
  field_evidence_refs: Partial<Record<EditorialObservationField, string[]>>;
  evidence_refs: string[];
  index_terms: string[];
  evidence_terms: string[];
}

const OBSERVATION_CONFIDENCE_GROUP: Record<EditorialObservationField, string> = {
  visual_tags: "tags",
  motion_type: "motion",
  camera_motion_direction: "direction",
  subject_motion_direction: "direction",
  shot_scale: "framing",
  composition_anchor: "framing",
  screen_side: "framing",
  gaze_direction: "direction",
  camera_axis: "direction",
  dominant_subject_type: "appearance",
  avg_luma: "appearance",
  dominant_colors: "appearance",
  text_presence: "text",
};

/**
 * Reads only the materialized top-level observation. Producer snapshots are
 * deliberately ignored: the reducer's top-level values are the canonical truth.
 */
export function extractEditorialObservation(raw: unknown): EditorialObservationExtraction {
  const observation = objectValue(raw);
  if (!observation) return emptyEditorialObservationExtraction();
  const confidence = objectValue(observation.confidence) ?? {};
  const evidence = Array.isArray(observation.evidence) ? observation.evidence : [];
  const values: EditorialObservationExtraction["values"] = {};
  const fieldConfidence: EditorialObservationExtraction["field_confidence"] = {};
  const fieldEvidenceRefs: EditorialObservationExtraction["field_evidence_refs"] = {};
  const evidenceRefs: string[] = [];
  const indexTerms: string[] = [];
  const evidenceTerms: string[] = [];

  for (const field of EDITORIAL_OBSERVATION_FIELDS) {
    const value = canonicalObservationValue(field, observation[field]);
    if (value === undefined) continue;
    values[field] = value;
    indexTerms.push(...observationFieldTerms(field, value));
    evidenceTerms.push(...observationEvidenceTerms(field, value));
    const group = objectValue(confidence[OBSERVATION_CONFIDENCE_GROUP[field]]);
    const score = finiteScore(group?.score);
    if (score != null) {
      fieldConfidence[field] = score;
      indexTerms.push(`editorial_observation.confidence.${OBSERVATION_CONFIDENCE_GROUP[field]}=${score}`);
    }
    const refs = stringArray(group?.evidence_refs);
    if (refs.length > 0) {
      fieldEvidenceRefs[field] = refs;
      evidenceRefs.push(...refs);
      indexTerms.push(...refs.map((ref) => `editorial_observation.evidence_ref=${ref}`));
    }
  }

  for (const item of evidence) {
    const record = objectValue(item);
    const ref = typeof record?.evidence_ref === "string" ? record.evidence_ref.trim() : "";
    if (ref) evidenceRefs.push(ref);
  }
  return {
    present: true,
    values,
    field_confidence: fieldConfidence,
    field_evidence_refs: fieldEvidenceRefs,
    evidence_refs: Array.from(new Set(evidenceRefs)),
    index_terms: Array.from(new Set(indexTerms)),
    evidence_terms: Array.from(new Set(evidenceTerms)),
  };
}

function emptyEditorialObservationExtraction(): EditorialObservationExtraction {
  return {
    present: false,
    values: {},
    field_confidence: {},
    field_evidence_refs: {},
    evidence_refs: [],
    index_terms: [],
    evidence_terms: [],
  };
}

function canonicalObservationValue(
  field: EditorialObservationField,
  value: unknown,
): string | number | string[] | undefined {
  if (field === "avg_luma") return finiteScore(value) ?? undefined;
  if (field === "visual_tags" || field === "dominant_colors") {
    return Array.isArray(value) ? stringArray(value) : undefined;
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function observationFieldTerms(field: EditorialObservationField, value: string | number | string[]): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (item === "unknown" || item === "not_applicable") return [];
    return [
      `editorial_observation.${field}=${String(item)}`,
      `${field}=${String(item)}`,
      String(item),
    ];
  });
}

function observationEvidenceTerms(field: EditorialObservationField, value: string | number | string[]): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => `editorial_observation.${field}=${String(item)}`);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)));
}

function finiteScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

export function extractCameraMotion(description: string): CameraMotionExtraction {
  const text = normalized(description);
  const evidence = evidenceSentences(description);
  const cameraStability = extractStability(text);
  const base = {
    camera_motion_description: evidence.join(" "),
    camera_stability: cameraStability,
    evidence,
  };

  if (/\b(static\s+shot|stationary|remains?\s+stationary|fixed|locked\s*off|tripod)\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "static",
      camera_motion_direction: "none",
      motion_confidence: 0.65,
    };
  }
  if (/\b(?:camera\s+)?pan(?:s|ning|ned)?(?:\s+\w+){0,4}\s+(?:to\s+the\s+)?right\b|\bright(?:ward)?\s+pan\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "pan",
      camera_motion_direction: "ltr",
      motion_confidence: 0.65,
    };
  }
  if (/\b(?:camera\s+)?pan(?:s|ning|ned)?(?:\s+\w+){0,4}\s+(?:to\s+the\s+)?left\b|\bleft(?:ward)?\s+pan\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "pan",
      camera_motion_direction: "rtl",
      motion_confidence: 0.65,
    };
  }
  if (/\b(?:camera\s+)?pan(?:s|ning|ned)?\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "pan",
      camera_motion_direction: "unknown",
      motion_confidence: 0.55,
    };
  }
  if (/\b(?:camera\s+)?tilt(?:s|ing|ed)?(?:\s+\w+){0,4}\s+up\b|\btilt\s+up\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "tilt",
      camera_motion_direction: "up",
      motion_confidence: 0.65,
    };
  }
  if (/\b(?:camera\s+)?tilt(?:s|ing|ed)?(?:\s+\w+){0,4}\s+down\b|\btilt\s+down\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "tilt",
      camera_motion_direction: "down",
      motion_confidence: 0.65,
    };
  }
  if (/\b(?:camera\s+)?tilt(?:s|ing|ed)?\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "tilt",
      camera_motion_direction: "unknown",
      motion_confidence: 0.55,
    };
  }
  if (/\b(dolly\s+in|push(?:es|ing)?\s+in|camera\s+(?:moves?\s+)?(?:forward|advances?)|camera\s+moves?\s+toward|tracks?\s+in)\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "push_in",
      camera_motion_direction: "toward_camera",
      motion_confidence: 0.65,
    };
  }
  if (/\b(dolly\s+out|pull(?:s|ing)?\s+back|camera\s+moves?\s+back(?:ward)?|camera\s+moves?\s+away|tracks?\s+out)\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "pull_out",
      camera_motion_direction: "away_camera",
      motion_confidence: 0.65,
    };
  }
  if (/\b(tracking\s+shot|camera\s+tracks?|camera\s+follows?|camera\s+following)\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "tracking",
      camera_motion_direction: inferDirection(text),
      motion_confidence: 0.6,
    };
  }
  if (/\bhandheld\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "handheld",
      camera_motion_direction: inferDirection(text),
      motion_confidence: 0.6,
    };
  }
  if (/\b(reveal|reveals)\b/.test(text) && /\bcamera\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "reveal",
      camera_motion_direction: inferDirection(text),
      motion_confidence: 0.55,
    };
  }
  if (/\b(whip\s+pan|fast\s+action|rapid\s+camera|quick\s+camera)\b/.test(text)) {
    return {
      ...base,
      camera_motion_type: "fast_action",
      camera_motion_direction: inferDirection(text),
      motion_confidence: 0.55,
    };
  }

  return {
    ...base,
    camera_motion_type: "unknown",
    camera_motion_direction: "unknown",
    motion_confidence: null,
  };
}

export function extractShotScale(description: string): UnifiedShotScale {
  const text = normalized(description);
  if (/\b(extreme\s+wide|very\s+wide)\b/.test(text)) return "extreme_wide";
  if (/\b(wide\s+shot|panoramic|establishing|long\s+shot)\b/.test(text)) return "wide";
  if (/\b(full\s+shot|head\s+to\s+toe|full\s+body|medium\s+wide)\b/.test(text)) return "medium_wide";
  if (/\b(medium\s+close(?:-|\s*)up|medium\s+close)\b/.test(text)) return "medium_close";
  if (/\b(extreme\s+close(?:-|\s*)up|very\s+close)\b/.test(text)) return "extreme_close";
  if (/\b(detail\s+of|detail\s+shot|macro|person'?s\s+hand|hands?\b|fingers?\b|object\s+detail)\b/.test(text)) return "detail";
  if (/\b(close(?:-|\s*)up|close\s+shot)\b/.test(text)) return "close";
  if (/\b(medium\s+shot|waist\s+up|waist-up)\b/.test(text)) return "medium";
  return "unknown";
}

export function extractSceneShotTake(filename: string): SceneShotTakeExtraction {
  const stem = path.basename(filename, path.extname(filename));
  const explicitSst = stem.match(/(?:^|[_\-\s])S(?<scene>\d{1,4})(?:[_\-\s]+SH?(?<shot>\d{1,4})|[_\-\s]+S(?<shotAlt>\d{1,4}))?(?:[_\-\s]+T(?:K)?(?<take>\d{1,4}))?(?:$|[_\-\s])/i);
  if (explicitSst?.groups) {
    const scene = explicitSst.groups.scene;
    const shot = explicitSst.groups.shot ?? explicitSst.groups.shotAlt;
    return filenameExtraction({
      scene_number: scene ?? null,
      shot_number: shot ?? null,
      take_number: explicitSst.groups.take ?? null,
      evidence: [`filename:${stem}`],
      confidence: 0.85,
    });
  }

  const explicitWords = stem.match(/scene[_\-\s]*(?<scene>\d{1,4}).*shot[_\-\s]*(?<shot>\d{1,4}).*take[_\-\s]*(?<take>\d{1,4})/i);
  if (explicitWords?.groups) {
    return filenameExtraction({
      scene_number: explicitWords.groups.scene ?? null,
      shot_number: explicitWords.groups.shot ?? null,
      take_number: explicitWords.groups.take ?? null,
      evidence: [`filename:${stem}`],
      confidence: 0.85,
    });
  }

  const gopro = stem.match(/^(?:GOPR|GP|GH|GX)(?<clip>\d{4})$/i);
  if (gopro?.groups?.clip) {
    return filenameExtraction({
      clip_number: gopro.groups.clip,
      take_number: gopro.groups.clip,
      evidence: [`filename:${stem}`, "gopro_clip_number"],
      confidence: 0.7,
    });
  }

  const dji = stem.match(/^DJI_(?<clip>\d{4})$/i);
  if (dji?.groups?.clip) {
    return filenameExtraction({
      clip_number: dji.groups.clip,
      take_number: dji.groups.clip,
      evidence: [`filename:${stem}`, "dji_clip_number"],
      confidence: 0.7,
    });
  }

  const blackmagicClip = stem.match(/^(?:(?<card>[A-Z]\d{3}).*)?(?:^|[_\-\s])C(?<clip>\d{3,5})(?:$|[_\-\s])/i);
  if (blackmagicClip?.groups?.clip) {
    return filenameExtraction({
      card_id: blackmagicClip.groups.card ?? null,
      clip_number: blackmagicClip.groups.clip,
      take_number: blackmagicClip.groups.clip,
      evidence: [`filename:${stem}`, "camera_clip_number"],
      confidence: 0.7,
    });
  }

  return filenameExtraction({});
}

export async function extractAudioLevels(sourcePath: string, range?: AudioRange): Promise<AudioLevelExtraction | null> {
  try {
    const [volume, loudness, silence] = await Promise.all([
      runFfmpegFilter(sourcePath, "volumedetect", range),
      runFfmpegFilter(sourcePath, "ebur128=peak=true", range),
      runFfmpegFilter(sourcePath, "silencedetect=noise=-35dB:d=0.35", range),
    ]);
    const durationUs = range ? Math.max(0, range.endUs - range.startUs) : null;
    const silenceWindows = parseSilenceWindows(silence, durationUs);
    return {
      peak_dbfs: parseLastDb(volume, /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/gi),
      rms_dbfs: parseLastDb(volume, /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/gi),
      integrated_lufs: parseLastDb(loudness, /\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/gi),
      silence_ratio: silenceWindows.ratio,
      silence_head_us: silenceWindows.headUs,
      silence_tail_us: silenceWindows.tailUs,
      has_silence: silenceWindows.windows.length > 0,
      evidence: ["ffmpeg:volumedetect", "ffmpeg:ebur128", "ffmpeg:silencedetect"],
    };
  } catch {
    return null;
  }
}

function extractStability(text: string): CameraStability {
  if (/\b(shaky|unstable|unsteady|shake|shaking|jittery)\b/.test(text)) return "shaky";
  if (/\bhandheld|slight\s+movement|subtle\s+movement|gentle\s+movement|minor\s+movement\b/.test(text)) return "slight";
  if (/\b(stable|smooth|tripod|locked\s*off|fixed|stationary)\b/.test(text)) return "stable";
  return "unknown";
}

function inferDirection(text: string): ScreenMotionDirection {
  if (/\b(left\s+to\s+right|toward\s+the\s+right|to\s+the\s+right|rightward)\b/.test(text)) return "ltr";
  if (/\b(right\s+to\s+left|toward\s+the\s+left|to\s+the\s+left|leftward)\b/.test(text)) return "rtl";
  if (/\b(up|upward|rises?|ascending|lifts?)\b/.test(text)) return "up";
  if (/\b(down|downward|descends?|descending|drops?)\b/.test(text)) return "down";
  if (/\b(toward|towards|closer|forward|in)\b/.test(text)) return "toward_camera";
  if (/\b(away|backward|back|out)\b/.test(text)) return "away_camera";
  return "unknown";
}

function filenameExtraction(values: Partial<SceneShotTakeExtraction>): SceneShotTakeExtraction {
  const hasEvidence = (values.evidence ?? []).length > 0;
  return {
    scene_number: values.scene_number ?? null,
    shot_number: values.shot_number ?? null,
    take_number: values.take_number ?? null,
    clip_number: values.clip_number ?? null,
    camera_id: values.camera_id ?? null,
    card_id: values.card_id ?? null,
    source: hasEvidence ? "filename_parser" : "unknown",
    confidence: values.confidence ?? null,
    evidence: values.evidence ?? [],
  };
}

function evidenceSentences(value: string): string[] {
  const normalizedValue = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalizedValue) return [];
  return normalizedValue
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => /\b(camera|shot|pan|tilt|dolly|push|pull|tracking|handheld|static|locked|tripod|shaky|stationary|drone|aerial|crane|jib)\b/i.test(sentence))
    .slice(0, 3);
}

function parseLastDb(text: string, pattern: RegExp): number | null {
  let parsed: number | null = null;
  for (const match of text.matchAll(pattern)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) parsed = value;
  }
  return parsed;
}

function parseSilenceWindows(text: string, durationUs: number | null): {
  windows: Array<{ startUs: number; endUs: number }>;
  ratio: number | null;
  headUs: number | null;
  tailUs: number | null;
} {
  const starts = Array.from(text.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/gi))
    .map((match) => secondsToUs(Number.parseFloat(match[1])))
    .filter((value): value is number => value != null);
  const ends = Array.from(text.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/gi))
    .map((match) => secondsToUs(Number.parseFloat(match[1])))
    .filter((value): value is number => value != null);
  const windows = starts.map((startUs, index) => ({
    startUs,
    endUs: ends[index] ?? durationUs ?? startUs,
  })).filter((window) => window.endUs > window.startUs);
  const silentUs = windows.reduce((sum, window) => sum + window.endUs - window.startUs, 0);
  const ratio = durationUs && durationUs > 0 ? Math.max(0, Math.min(1, silentUs / durationUs)) : null;
  const headUs = windows.find((window) => window.startUs <= 100_000)?.endUs ?? null;
  const tailUs = durationUs == null
    ? null
    : [...windows].reverse().find((window) => window.endUs >= durationUs - 100_000)?.startUs == null
      ? null
      : durationUs - ([...windows].reverse().find((window) => window.endUs >= durationUs - 100_000)?.startUs ?? durationUs);
  return { windows, ratio, headUs, tailUs };
}

function secondsToUs(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 1_000_000);
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function runFfmpegFilter(sourcePath: string, filter: string, range?: AudioRange): Promise<string> {
  const args = ["-hide_banner", "-nostats"];
  if (range && range.startUs > 0) args.push("-ss", secondsArg(range.startUs));
  if (range && range.endUs > range.startUs) args.push("-t", secondsArg(range.endUs - range.startUs));
  args.push("-i", sourcePath, "-vn", "-af", filter, "-f", "null", "-");
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      args,
      { maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error) reject(error);
        else resolve(stderr);
      },
    );
  });
}

function secondsArg(us: number): string {
  return (us / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
