/**
 * Lyric typography delivery (Issue 36) — the bridge from authored lyric
 * scripts to the canonical caption delivery surface.
 *
 * A lyric MV project stores its lyric script as an LRC-style text file
 * (`[00:12.00] 夜が降る`, with `[Aメロ]` / `[Chorus glow=amber]` / `[Punk]`
 * standalone section tags). This module:
 *
 * 1. Skips script-level non-lyric lines (credits, `Title:`/`BGM:` directives,
 *    comments, separators) — including timestamped ones — and parses LRC line
 *    timestamps into cue timing. Timing is never invented: the first lyric
 *    line must carry a timestamp, a line ends when the next starts, and the
 *    tail is clamped to the video duration when known.
 * 2. Runs the canonical engine (`planLyricTypography` with exact-face glyph
 *    measurement and the real system font probe) and refuses delivery when
 *    the plan reports any violation.
 * 3. Validates the plan against `lyric-typography-plan.schema.json`, stages
 *    the exact bound face binaries into the generation fonts dir (so libass
 *    loads the same bytes the planner measured), and writes the burn-ready
 *    `captions/lyrics.ass`, the auditable `captions/lyric-typography-plan.json`,
 *    and a content copy of the script (`captions/lyrics.lrc`).
 *
 * Text integrity: only metadata is stripped; lyric characters are never
 * rewritten. The speech caption pipeline is untouched — lyric delivery is
 * additive and opt-in via `CaptionFinalizeOptions.lyricScriptPath`.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildLyricAssDocument,
  isNonLyricScriptLine,
  planLyricTypography,
  type LyricPositioning,
  type LyricTypographyAuthority,
  type LyricLineInput,
  type LyricSectionInput,
  type LyricTypographyPlan,
} from "./lyric-typography.js";
import {
  hashAuthoredTextAuthority,
  hashAuthoredTimingAuthority,
} from "./authored-lyrics.js";
import type { CaptionApproval } from "./approval.js";
import { validateAgainstSchema } from "../commands/shared.js";

/** Leading LRC timestamp tag(s) of a lyric line (one or more). */
const LRC_LINE_TIMESTAMPS = /^((?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+)\s*/;
const LRC_TAG = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g;

/** SHA-256 of file bytes (font binaries / script copies). */
function sha256File(filePath: string): string {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

/** Parse one LRC timestamp tag (`[mm:ss.xx]`) into seconds. */
export function parseLrcTimestampSeconds(tag: string): number {
  const match = tag.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/);
  if (!match) throw new Error(`invalid LRC timestamp: ${tag}`);
  const fraction = match[3] ?? "0";
  const fractionSec = Number(fraction) / 10 ** fraction.length;
  return Number(match[1]) * 60 + Number(match[2]) + fractionSec;
}

export interface LoadLyricLineInputsOptions {
  /** End time of the last lyric line relative to its start (default 4s). */
  tailSec?: number;
  /**
   * Rendered video duration in seconds. Cues at/after the end are dropped
   * and the final tail is clamped — nothing renders past the video.
   */
  videoDurationSec?: number;
}

/**
 * Convert an LRC-style lyric script into engine input. Script-level
 * non-lyric lines (credits, directives, comments, separators) never become
 * timing slots — including timestamped ones. Lines without a timestamp
 * extend the previous timestamped slot. Throws when timing cannot be
 * derived — the caller's lyric input owns timing.
 */
export function loadLyricLineInputs(
  raw: string,
  options: LoadLyricLineInputsOptions = {},
): LyricLineInput[] {
  const tailSec = options.tailSec ?? 4;
  const entries: Array<{ start: number; text: string }> = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    // credits / directives / comments / separators never consume a slot
    if (isNonLyricScriptLine(trimmed)) continue;
    const match = trimmed.match(LRC_LINE_TIMESTAMPS);
    if (!match) {
      if (entries.length === 0) {
        throw new Error(
          "lyric script lines must start with an LRC timestamp (e.g. [00:12.00]); refusing to invent timing",
        );
      }
      const previous = entries[entries.length - 1];
      previous.text += `\n${trimmed}`;
      continue;
    }
    const text = trimmed.slice(match[0].length);
    // Timestamped metadata (`[00:01.00]BGM: …`, `[00:02.00]作詞：…`,
    // `[00:03.00]// note`) is sanitized AFTER timestamp removal: it never
    // opens a display slot and never reaches a Dialogue.
    if (isNonLyricScriptLine(text)) continue;
    const tags = match[1].match(LRC_TAG) ?? [];
    for (const tag of tags) {
      entries.push({ start: parseLrcTimestampSeconds(tag), text });
    }
  }
  if (entries.length === 0) {
    throw new Error("lyric script contains no timed lines");
  }
  entries.sort((a, b) => a.start - b.start);
  // Same timestamp = same display slot (LRC convention): merge metadata lines,
  // section tags, and the lyric they annotate into one engine input.
  const merged: Array<{ start: number; text: string }> = [];
  for (const entry of entries) {
    const previous = merged[merged.length - 1];
    if (previous && previous.start === entry.start) {
      previous.text += `\n${entry.text}`;
    } else {
      merged.push({ ...entry });
    }
  }
  // Video duration clamp: drop cues at/after the end, clamp the last tail.
  const usable = options.videoDurationSec !== undefined
    ? merged.filter((entry) => entry.start < options.videoDurationSec!)
    : merged;
  if (usable.length === 0) {
    throw new Error("lyric script has no lyric lines inside the video duration");
  }
  return usable.map((entry, index) => {
    const naturalEnd = index + 1 < usable.length ? usable[index + 1].start : entry.start + tailSec;
    const endSec = options.videoDurationSec !== undefined
      ? Math.min(naturalEnd, options.videoDurationSec)
      : naturalEnd;
    return { text: entry.text, startSec: entry.start, endSec };
  });
}

export interface ApprovedAuthoredLyricLineInputs {
  /** Derived plan inputs; the #41 text authority remains the source of truth. */
  lyrics: LyricLineInput[];
  authority: LyricTypographyAuthority;
  sections?: LyricSectionInput[];
}

/**
 * Adapt the approved #41 caption projection into the lyric planner's input
 * shape. Sanitization is deliberately deferred to the planner: this adapter
 * carries the exact authored body text and records its derived authority
 * hashes without rewriting the source artifact.
 */
export function loadApprovedAuthoredLyricLineInputs(input: {
  approval: CaptionApproval;
  fps: number;
  approvalSha256: string;
  timelineSha256: string;
  sections?: LyricSectionInput[];
}): ApprovedAuthoredLyricLineInputs {
  const { approval } = input;
  if (approval.caption_policy.source !== "authored" || approval.approval.status !== "approved") {
    throw new Error("approved authored caption approval is required for lyric typography");
  }
  if (!approval.text_authority || !approval.timing_authority) {
    throw new Error("approved authored caption authority is incomplete");
  }
  if (!Number.isFinite(input.fps) || input.fps <= 0) {
    throw new Error("a positive finite fps is required for authored lyric typography");
  }
  if (!input.approvalSha256 || !input.timelineSha256) {
    throw new Error("approval and timeline hashes are required for lyric typography authority");
  }

  const textLines = new Map(approval.text_authority.lines.map((line) => [line.line_id, line]));
  const timingCues = new Map(approval.timing_authority.cues.map((cue) => [cue.cue_id, cue]));
  const seenLineIds = new Set<string>();
  const seenCueIds = new Set<string>();
  const captions = [...approval.speech_captions].sort((left, right) =>
    left.timeline_in_frame - right.timeline_in_frame || (left.cue_id ?? "").localeCompare(right.cue_id ?? ""));
  if (captions.length === 0) throw new Error("approved authored caption approval contains no speech captions");

  const lyrics = captions.map((caption) => {
    if (caption.source !== "authored" || !caption.line_id || !caption.cue_id) {
      throw new Error("authored lyric typography requires authored line_id and cue_id on every caption");
    }
    if (seenLineIds.has(caption.line_id) || seenCueIds.has(caption.cue_id)) {
      throw new Error(`duplicate authored lyric identity: ${caption.line_id}/${caption.cue_id}`);
    }
    seenLineIds.add(caption.line_id);
    seenCueIds.add(caption.cue_id);
    const textLine = textLines.get(caption.line_id);
    const timingCue = timingCues.get(caption.cue_id);
    if (!textLine || textLine.text !== caption.text) {
      throw new Error(`approved caption text does not match authored body for ${caption.line_id}`);
    }
    if (!timingCue || timingCue.line_id !== caption.line_id || timingCue.status !== "matched" ||
      timingCue.timeline_in_frame !== caption.timeline_in_frame ||
      timingCue.timeline_duration_frames !== caption.timeline_duration_frames) {
      throw new Error(`approved caption timing does not match authored timing authority for ${caption.cue_id}`);
    }
    const startSec = caption.timeline_in_frame / input.fps;
    const endSec = (caption.timeline_in_frame + caption.timeline_duration_frames) / input.fps;
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      throw new Error(`invalid authored lyric timing for ${caption.cue_id}`);
    }
    return {
      text: textLine.text,
      startSec,
      endSec,
      lineId: textLine.line_id,
      cueId: timingCue.cue_id,
    };
  });

  return {
    lyrics,
    authority: {
      kind: "authored_caption_approval",
      approval_sha256: input.approvalSha256,
      timeline_sha256: input.timelineSha256,
      text_authority_sha256: hashAuthoredTextAuthority(approval.text_authority),
      timing_authority_sha256: hashAuthoredTimingAuthority(approval.timing_authority),
    },
    ...(input.sections ? { sections: input.sections } : {}),
  };
}

export interface LyricDeliveryOptions {
  /** Explicit timed sections (e.g. from BGM section analysis). */
  sections?: LyricSectionInput[];
  /** Accessibility: static cards instead of bounce/staccato motion. */
  reducedMotion?: boolean;
  /** Staccato bounds: per-character slot and final hold caps (seconds). */
  staccato?: { maxPerCharSec?: number; maxHoldSec?: number };
  /** End time of the last lyric line relative to its start (default 4s). */
  tailSec?: number;
  /** Rendered video duration; clamps cues so nothing renders past the end. */
  videoDurationSec?: number;
  /** Explicit placement style; poster crossing remains the default. */
  positioning?: LyricPositioning;
}

export interface LyricTypographyDeliveryResult {
  assPath: string;
  planPath: string;
  /** Content copy of the script, hashed into the receipt/active delivery. */
  scriptPath?: string;
  plan: LyricTypographyPlan;
  /** Exact faces staged into the render fonts dir (binary-bound rendering). */
  stagedFaces: Array<{
    role: string;
    family: string;
    postscript_name?: string;
    face_index: number;
    source_path: string;
    staged_path: string;
    font_sha256: string;
  }>;
}

/** Write a plan derived from the approved #41 authority without creating a second lyric source file. */
export function writeApprovedAuthoredLyricTypographyDeliveryArtifacts(input: {
  authoredInputs: ApprovedAuthoredLyricLineInputs;
  outputDir: string;
  options?: LyricDeliveryOptions;
  fontsDir?: string;
}): LyricTypographyDeliveryResult {
  return writeLyricTypographyPlanArtifacts({
    lyrics: input.authoredInputs.lyrics,
    ...(input.authoredInputs.sections ? { sections: input.authoredInputs.sections } : {}),
    authority: input.authoredInputs.authority,
    outputDir: input.outputDir,
    options: input.options,
    fontsDir: input.fontsDir,
  });
}

/**
 * Plan + write the lyric typography delivery artifacts. Fails closed: any
 * engine violation (unsafe width, invalid timing, staccato failure, missing
 * font binding) or a schema-invalid plan aborts delivery instead of writing
 * an overflowed ASS.
 *
 * Binary binding: each role's exact bound face binary is copied into the
 * generation fonts dir (`fontsDir`), hashed, and the copy is what libass
 * loads via the compositor fontsdir — measurement and rendering come from
 * byte-identical binaries.
 */
export function writeLyricTypographyDeliveryArtifacts(input: {
  lyricScriptPath: string;
  /** Generation directory; artifacts land in `<outputDir>/captions/`. */
  outputDir: string;
  options?: LyricDeliveryOptions;
  /** Generation staged fonts dir; bound faces are copied here for libass. */
  fontsDir?: string;
}): LyricTypographyDeliveryResult {
  const options = input.options ?? {};
  const raw = fs.readFileSync(input.lyricScriptPath, "utf8");
  const lyrics = loadLyricLineInputs(raw, {
    ...(options.tailSec !== undefined ? { tailSec: options.tailSec } : {}),
    ...(options.videoDurationSec !== undefined ? { videoDurationSec: options.videoDurationSec } : {}),
  });
  return writeLyricTypographyPlanArtifacts({
    lyrics,
    outputDir: input.outputDir,
    options,
    scriptPath: input.lyricScriptPath,
    fontsDir: input.fontsDir,
  });
}

function writeLyricTypographyPlanArtifacts(input: {
  lyrics: LyricLineInput[];
  sections?: LyricSectionInput[];
  authority?: LyricTypographyAuthority;
  outputDir: string;
  options?: LyricDeliveryOptions;
  /** Only direct LRC delivery carries a script copy; authored delivery does not. */
  scriptPath?: string;
  fontsDir?: string;
}): LyricTypographyDeliveryResult {
  const options = input.options ?? {};
  const plan = planLyricTypography({
    lyrics: input.lyrics,
    ...(input.sections ?? options.sections ? { sections: input.sections ?? options.sections } : {}),
    ...(options.reducedMotion !== undefined ? { reducedMotion: options.reducedMotion } : {}),
    ...(options.staccato ? { staccato: options.staccato } : {}),
    ...(options.positioning ? { positioning: options.positioning } : {}),
    ...(input.authority ? { authority: input.authority } : {}),
  });
  if (plan.violations.length > 0) {
    const details = plan.violations
      .map((violation) => `${violation.code}: ${violation.message}`)
      .join("; ");
    throw new Error(`lyric typography plan has unresolved violations: ${details}`);
  }
  const validation = validateAgainstSchema(
    JSON.parse(JSON.stringify(plan)),
    "lyric-typography-plan.schema.json",
  );
  if (!validation.valid) {
    throw new Error(`lyric typography plan failed schema validation: ${validation.errors.join("; ")}`);
  }

  // Stage the bound face binaries into the render fonts dir. libass selects
  // the face by the ASS family name from THESE bytes — the same bytes the
  // planner measured (hash verified after copy).
  const stagedFaces: LyricTypographyDeliveryResult["stagedFaces"] = [];
  if (input.fontsDir) {
    fs.mkdirSync(input.fontsDir, { recursive: true });
    for (const role of ["verse", "chorus", "punk"] as const) {
      const font = plan.fonts[role];
      if (!font.font_path || font.face_index === undefined) continue;
      // one staged copy per ROLE: two roles may bind different faces of the
      // same source binary (e.g. Hiragino Mincho ProN W3 vs W6 in one TTC)
      {
        const ext = path.extname(font.font_path) || ".ttf";
        const stagedPath = path.join(input.fontsDir, `lyrics-${role}${ext}`);
        fs.copyFileSync(font.font_path, stagedPath);
        const fontSha256 = sha256File(stagedPath);
        if (font.font_sha256 && fontSha256 !== font.font_sha256) {
          throw new Error(
            `staged lyric font hash mismatch for ${role}: ${fontSha256} != ${font.font_sha256}`,
          );
        }
        var staged = { stagedPath, fontSha256 };
      }
      stagedFaces.push({
        role,
        family: font.resolved_family,
        ...(font.postscript_name ? { postscript_name: font.postscript_name } : {}),
        face_index: font.face_index,
        source_path: font.font_path,
        staged_path: staged.stagedPath,
        font_sha256: staged.fontSha256,
      });
    }
    // Every role with cues must have staged a binary — an unbound role means
    // the plan measured widths no renderable font can reproduce.
    for (const role of ["verse", "chorus", "punk"] as const) {
      if (plan.cues.some((cue) => cue.section_role === role) && !stagedFaces.some((f) => f.role === role)) {
        throw new Error(`no font binary staged for lyric role ${role}; refusing to deliver`);
      }
    }
  }

  const ass = buildLyricAssDocument(plan);
  const captionsDir = path.join(input.outputDir, "captions");
  fs.mkdirSync(captionsDir, { recursive: true });
  const assPath = path.join(captionsDir, "lyrics.ass");
  const planPath = path.join(captionsDir, "lyric-typography-plan.json");
  const scriptPath = path.join(captionsDir, "lyrics.lrc");
  fs.writeFileSync(assPath, ass, "utf8");
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  if (input.scriptPath) fs.copyFileSync(input.scriptPath, scriptPath);
  return {
    assPath,
    planPath,
    ...(input.scriptPath ? { scriptPath } : {}),
    plan,
    stagedFaces,
  };
}
