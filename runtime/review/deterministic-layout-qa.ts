import { createHash } from "node:crypto";

export const RENDER_LAYOUT_SNAPSHOT_VERSION =
  "render-layout-snapshot/v1" as const;
export const DETERMINISTIC_LAYOUT_QA_VERSION =
  "deterministic-layout-qa/v2" as const;

export type RenderLayoutSemanticRole = "speech_caption" | "title" | "cta";
export type RenderLayoutLayerSource =
  | "ffmpeg-libass"
  | "remotion"
  | "hyperframes";
export type RenderLayoutFinalFrameState =
  | "moving_source"
  | "natural_speaker"
  | "meaningful_end_card"
  | "intentional_still"
  | "not_applicable"
  | "static_source"
  | "black"
  | "frozen"
  | "unknown";

export interface RenderLayoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderLayoutSafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface RenderLayoutFontEvidence {
  status: "verified" | "fallback" | "missing";
  requested_family: string;
  resolved_family?: string;
  missing_glyphs: string[];
}

export interface RenderLayoutLayer {
  layer_id: string;
  semantic_role: RenderLayoutSemanticRole;
  source: RenderLayoutLayerSource;
  start_frame: number;
  end_frame: number;
  bounds: RenderLayoutBounds;
  font?: RenderLayoutFontEvidence;
}

export interface RenderLayoutSnapshot {
  version: typeof RENDER_LAYOUT_SNAPSHOT_VERSION;
  frame: {
    width: number;
    height: number;
    fps_num: number;
    fps_den: number;
    total_frames: number;
    safe_area: RenderLayoutSafeArea;
  };
  layers: RenderLayoutLayer[];
  ending: {
    final_frame_state: RenderLayoutFinalFrameState;
    end_card_layer_id?: string;
  };
}

export type DeterministicLayoutQAIssueCode =
  | "renderer_evidence_incomplete"
  | "caption_outside_safe_area"
  | "glyph_clipped"
  | "font_fallback"
  | "missing_glyph"
  | "duplicate_speech_caption_layer"
  | "caption_visual_collision"
  | "end_card_hold_invalid"
  | "final_frame_state_invalid";

export interface DeterministicLayoutQAIssue {
  code: DeterministicLayoutQAIssueCode;
  severity: "blocking";
  detail: string;
  layer_ids?: string[];
  start_frame?: number;
  end_frame?: number;
}

export interface DeterministicLayoutQAReviewItem {
  issue_id: string;
  code: DeterministicLayoutQAIssueCode;
  severity: "blocking";
  title_ja: string;
  remediation_ja: string;
  layer_ids: string[];
  start_frame?: number;
  end_frame?: number;
  start_timecode?: string;
  end_timecode?: string;
}

export interface DeterministicLayoutQAResult {
  version: typeof DETERMINISTIC_LAYOUT_QA_VERSION;
  status: "verified" | "blocked" | "incomplete";
  snapshot_version: typeof RENDER_LAYOUT_SNAPSHOT_VERSION;
  snapshot_sha256?: string;
  issues: DeterministicLayoutQAIssue[];
  review_items: DeterministicLayoutQAReviewItem[];
}

export interface DeterministicLayoutQAOptions {
  minimumEndCardSec?: number;
  maximumEndCardSec?: number;
}

const DEFAULT_MINIMUM_END_CARD_SEC = 2;
const DEFAULT_MAXIMUM_END_CARD_SEC = 6;
const VALID_FINAL_FRAME_STATES = new Set<RenderLayoutFinalFrameState>([
  "moving_source",
  "natural_speaker",
  "meaningful_end_card",
  "intentional_still",
  "not_applicable",
]);
const REVIEW_PRESENTATION: Record<
  DeterministicLayoutQAIssueCode,
  { priority: number; title: string; remediation: string }
> = {
  renderer_evidence_incomplete: {
    priority: 0,
    title: "レイアウト検証証拠が不足",
    remediation:
      "字幕承認・タイムライン・フォント証拠を揃えて再パッケージし、レイアウトスナップショットを再生成してください。",
  },
  duplicate_speech_caption_layer: {
    priority: 1,
    title: "字幕が二重に表示される",
    remediation:
      "speech captionの描画経路を1つに統一し、重複する字幕レイヤーを削除してください。",
  },
  caption_visual_collision: {
    priority: 2,
    title: "字幕と画面テキストが衝突",
    remediation: "字幕またはCTAの表示区間・位置を分離してください。",
  },
  glyph_clipped: {
    priority: 3,
    title: "字幕が画面外で切れる",
    remediation:
      "字幕の位置・最大幅・フォントサイズを調整し、全字形をフレーム内へ収めてください。",
  },
  caption_outside_safe_area: {
    priority: 4,
    title: "字幕が安全領域を外れる",
    remediation:
      "字幕の位置または余白を調整し、宣言済みcaption safe area内へ収めてください。",
  },
  font_fallback: {
    priority: 5,
    title: "字幕フォントが代替された",
    remediation:
      "要求された同梱フォントを解決し、fallbackなしで再レンダーしてください。",
  },
  missing_glyph: {
    priority: 6,
    title: "字幕に未収録文字がある",
    remediation:
      "不足字形を収録した同梱フォントまたは表記へ変更し、字形検証を再実行してください。",
  },
  end_card_hold_invalid: {
    priority: 7,
    title: "CTAの表示時間が不適切",
    remediation:
      "CTAを動画の終端まで保持し、表示時間を2〜6秒の範囲へ調整してください。",
  },
  final_frame_state_invalid: {
    priority: 8,
    title: "終端フレームが不自然",
    remediation:
      "話者の自然な表情、意味のあるCTA、または明示した静止画で動画を着地させてください。",
  },
};

/**
 * Evaluate renderer-derived layout evidence without inspecting project names,
 * speaker identity, or campaign copy. Missing evidence fails closed because a
 * guessed geometry result is not approval-grade.
 */
export function evaluateDeterministicLayoutQA(
  snapshot: RenderLayoutSnapshot,
  options: DeterministicLayoutQAOptions = {},
): DeterministicLayoutQAResult {
  const evidenceErrors = validateSnapshotEvidence(snapshot);
  if (evidenceErrors.length > 0) {
    const issues: DeterministicLayoutQAIssue[] = evidenceErrors.map((detail) => ({
      code: "renderer_evidence_incomplete",
      severity: "blocking",
      detail,
    }));
    return {
      version: DETERMINISTIC_LAYOUT_QA_VERSION,
      status: "incomplete",
      snapshot_version: RENDER_LAYOUT_SNAPSHOT_VERSION,
      snapshot_sha256: hashSnapshot(snapshot),
      issues,
      review_items: buildLayoutReviewItems(issues, snapshot.frame),
    };
  }

  const issues: DeterministicLayoutQAIssue[] = [];
  const captions = snapshot.layers.filter(
    (layer) => layer.semantic_role === "speech_caption",
  );
  const visualText = snapshot.layers.filter(
    (layer) => layer.semantic_role === "title" || layer.semantic_role === "cta",
  );
  const safeRect = {
    x: snapshot.frame.safe_area.left,
    y: snapshot.frame.safe_area.top,
    width: snapshot.frame.width -
      snapshot.frame.safe_area.left -
      snapshot.frame.safe_area.right,
    height: snapshot.frame.height -
      snapshot.frame.safe_area.top -
      snapshot.frame.safe_area.bottom,
  };
  const frameRect = {
    x: 0,
    y: 0,
    width: snapshot.frame.width,
    height: snapshot.frame.height,
  };

  for (const caption of captions) {
    if (!containsRect(frameRect, caption.bounds)) {
      issues.push({
        code: "glyph_clipped",
        severity: "blocking",
        detail: `${caption.layer_id} extends outside the rendered frame`,
        layer_ids: [caption.layer_id],
        start_frame: caption.start_frame,
        end_frame: caption.end_frame,
      });
    } else if (!containsRect(safeRect, caption.bounds)) {
      issues.push({
        code: "caption_outside_safe_area",
        severity: "blocking",
        detail: `${caption.layer_id} extends outside the declared caption safe area`,
        layer_ids: [caption.layer_id],
        start_frame: caption.start_frame,
        end_frame: caption.end_frame,
      });
    }

    if (caption.font!.status !== "verified") {
      issues.push({
        code: "font_fallback",
        severity: "blocking",
        detail:
          `${caption.layer_id} resolved ${caption.font!.requested_family} ` +
          `with status=${caption.font!.status}` +
          (caption.font!.resolved_family
            ? ` as ${caption.font!.resolved_family}`
            : ""),
        layer_ids: [caption.layer_id],
        start_frame: caption.start_frame,
        end_frame: caption.end_frame,
      });
    }
    if (caption.font!.missing_glyphs.length > 0) {
      issues.push({
        code: "missing_glyph",
        severity: "blocking",
        detail:
          `${caption.layer_id} is missing ${caption.font!.missing_glyphs.length} ` +
          `glyph(s): ${caption.font!.missing_glyphs.join(" ")}`,
        layer_ids: [caption.layer_id],
        start_frame: caption.start_frame,
        end_frame: caption.end_frame,
      });
    }
  }

  for (let leftIndex = 0; leftIndex < captions.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < captions.length;
      rightIndex += 1
    ) {
      const left = captions[leftIndex];
      const right = captions[rightIndex];
      const overlap = frameOverlap(left, right);
      if (!overlap) continue;
      issues.push({
        code: "duplicate_speech_caption_layer",
        severity: "blocking",
        detail:
          `${left.layer_id} and ${right.layer_id} are simultaneously active ` +
          `speech-caption layers`,
        layer_ids: [left.layer_id, right.layer_id],
        start_frame: overlap.start,
        end_frame: overlap.end,
      });
    }
  }

  for (const caption of captions) {
    for (const visual of visualText) {
      const overlap = frameOverlap(caption, visual);
      if (!overlap || !rectsOverlap(caption.bounds, visual.bounds)) continue;
      issues.push({
        code: "caption_visual_collision",
        severity: "blocking",
        detail:
          `${caption.layer_id} collides with ${visual.semantic_role} ` +
          `${visual.layer_id}`,
        layer_ids: [caption.layer_id, visual.layer_id],
        start_frame: overlap.start,
        end_frame: overlap.end,
      });
    }
  }

  const endCard = snapshot.ending.end_card_layer_id
    ? snapshot.layers.find(
      (layer) => layer.layer_id === snapshot.ending.end_card_layer_id,
    )
    : undefined;
  if (endCard) {
    const fps = snapshot.frame.fps_num / snapshot.frame.fps_den;
    const holdSec = (endCard.end_frame - endCard.start_frame) / fps;
    const minimum = options.minimumEndCardSec ?? DEFAULT_MINIMUM_END_CARD_SEC;
    const maximum = options.maximumEndCardSec ?? DEFAULT_MAXIMUM_END_CARD_SEC;
    if (
      endCard.semantic_role !== "cta" ||
      endCard.end_frame !== snapshot.frame.total_frames ||
      holdSec < minimum ||
      holdSec > maximum
    ) {
      issues.push({
        code: "end_card_hold_invalid",
        severity: "blocking",
        detail:
          `${endCard.layer_id} holds ${holdSec.toFixed(3)}s; required terminal ` +
          `CTA hold is ${minimum.toFixed(1)}-${maximum.toFixed(1)}s`,
        layer_ids: [endCard.layer_id],
        start_frame: endCard.start_frame,
        end_frame: endCard.end_frame,
      });
    }
  }

  if (
    !VALID_FINAL_FRAME_STATES.has(snapshot.ending.final_frame_state) ||
    (
      snapshot.ending.final_frame_state === "meaningful_end_card" &&
      !endCard
    ) ||
    (
      snapshot.ending.final_frame_state === "not_applicable" &&
      (snapshot.frame.total_frames !== 0 || snapshot.layers.length !== 0)
    )
  ) {
    issues.push({
      code: "final_frame_state_invalid",
      severity: "blocking",
      detail:
        `final_frame_state=${snapshot.ending.final_frame_state} is not ` +
        "approval-grade renderer evidence",
      ...(endCard ? { layer_ids: [endCard.layer_id] } : {}),
      ...(snapshot.frame.total_frames > 0
        ? {
          start_frame: snapshot.frame.total_frames - 1,
          end_frame: snapshot.frame.total_frames,
        }
        : {}),
    });
  }

  return {
    version: DETERMINISTIC_LAYOUT_QA_VERSION,
    status: issues.length > 0 ? "blocked" : "verified",
    snapshot_version: RENDER_LAYOUT_SNAPSHOT_VERSION,
    snapshot_sha256: hashSnapshot(snapshot),
    issues,
    review_items: buildLayoutReviewItems(issues, snapshot.frame),
  };
}

export function incompleteDeterministicLayoutQA(
  detail: string,
): DeterministicLayoutQAResult {
  const issues: DeterministicLayoutQAIssue[] = [{
    code: "renderer_evidence_incomplete",
    severity: "blocking",
    detail,
  }];
  return {
    version: DETERMINISTIC_LAYOUT_QA_VERSION,
    status: "incomplete",
    snapshot_version: RENDER_LAYOUT_SNAPSHOT_VERSION,
    issues,
    review_items: buildLayoutReviewItems(issues),
  };
}

export function buildLayoutReviewItems(
  issues: DeterministicLayoutQAIssue[],
  frame?: Pick<
    RenderLayoutSnapshot["frame"],
    "fps_num" | "fps_den" | "total_frames"
  >,
): DeterministicLayoutQAReviewItem[] {
  const frameRateValid = positiveInteger(frame?.fps_num) &&
    positiveInteger(frame?.fps_den);
  const items = issues.map((issue): DeterministicLayoutQAReviewItem => {
    const presentation = REVIEW_PRESENTATION[issue.code];
    const layerIds = [...new Set(issue.layer_ids ?? [])];
    const range = nonNegativeInteger(issue.start_frame) &&
        positiveInteger(issue.end_frame) &&
        issue.end_frame > issue.start_frame
      ? { start: issue.start_frame, end: issue.end_frame }
      : undefined;
    return {
      issue_id: stableReviewIssueID(issue),
      code: issue.code,
      severity: "blocking",
      title_ja: presentation.title,
      remediation_ja: presentation.remediation,
      layer_ids: layerIds,
      ...(range
        ? {
          start_frame: range.start,
          end_frame: range.end,
          ...(frameRateValid
            ? {
              start_timecode: formatFrameClock(
                range.start,
                frame!.fps_num,
                frame!.fps_den,
              ),
              end_timecode: formatFrameClock(
                range.end,
                frame!.fps_num,
                frame!.fps_den,
              ),
            }
            : {}),
        }
        : {}),
    };
  });
  return items.sort((left, right) => {
    const leftFrame = left.start_frame ?? Number.MAX_SAFE_INTEGER;
    const rightFrame = right.start_frame ?? Number.MAX_SAFE_INTEGER;
    if (leftFrame !== rightFrame) return leftFrame - rightFrame;
    const priorityDelta =
      REVIEW_PRESENTATION[left.code].priority -
      REVIEW_PRESENTATION[right.code].priority;
    if (priorityDelta !== 0) return priorityDelta;
    return left.issue_id.localeCompare(right.issue_id, "en");
  });
}

function stableReviewIssueID(issue: DeterministicLayoutQAIssue): string {
  const digest = createHash("sha256")
    .update(canonicalJson({
      code: issue.code,
      detail: issue.detail,
      layer_ids: issue.layer_ids ?? [],
      start_frame: issue.start_frame,
      end_frame: issue.end_frame,
    }))
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `LAYOUTQA_${digest}`;
}

function formatFrameClock(
  frame: number,
  fpsNum: number,
  fpsDen: number,
): string {
  const totalMs = Math.round(frame * fpsDen * 1_000 / fpsNum);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const milliseconds = totalMs % 1_000;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":") + `.${String(milliseconds).padStart(3, "0")}`;
}

function validateSnapshotEvidence(snapshot: RenderLayoutSnapshot): string[] {
  const errors: string[] = [];
  if (snapshot.version !== RENDER_LAYOUT_SNAPSHOT_VERSION) {
    errors.push(`unsupported snapshot version: ${String(snapshot.version)}`);
  }
  const frame = snapshot.frame;
  if (
    !positiveInteger(frame?.width) ||
    !positiveInteger(frame?.height) ||
    !positiveInteger(frame?.fps_num) ||
    !positiveInteger(frame?.fps_den) ||
    !nonNegativeInteger(frame?.total_frames)
  ) {
    errors.push(
      "frame dimensions and rate must be positive integers; total_frames must be non-negative",
    );
  }
  const safe = frame?.safe_area;
  if (
    !nonNegativeNumber(safe?.top) ||
    !nonNegativeNumber(safe?.right) ||
    !nonNegativeNumber(safe?.bottom) ||
    !nonNegativeNumber(safe?.left) ||
    safe.left + safe.right >= frame.width ||
    safe.top + safe.bottom >= frame.height
  ) {
    errors.push("frame.safe_area is missing or invalid");
  }
  if (!Array.isArray(snapshot.layers)) {
    errors.push("layers must be an array");
    return errors;
  }
  const ids = new Set<string>();
  for (const layer of snapshot.layers) {
    if (!layer.layer_id?.trim()) {
      errors.push("every layer requires layer_id");
    } else if (ids.has(layer.layer_id)) {
      errors.push(`layer_id is duplicated: ${layer.layer_id}`);
    } else {
      ids.add(layer.layer_id);
    }
    if (
      !nonNegativeInteger(layer.start_frame) ||
      !positiveInteger(layer.end_frame) ||
      layer.end_frame <= layer.start_frame ||
      layer.end_frame > frame.total_frames
    ) {
      errors.push(`${layer.layer_id || "unnamed layer"} has an invalid frame range`);
    }
    if (!validBounds(layer.bounds)) {
      errors.push(`${layer.layer_id || "unnamed layer"} has invalid bounds`);
    }
    if (layer.semantic_role === "speech_caption") {
      if (!layer.font) {
        errors.push(`${layer.layer_id || "unnamed caption"} is missing font evidence`);
      } else if (
        !layer.font.requested_family?.trim() ||
        !Array.isArray(layer.font.missing_glyphs)
      ) {
        errors.push(`${layer.layer_id || "unnamed caption"} has invalid font evidence`);
      }
    }
  }
  if (!snapshot.ending || !snapshot.ending.final_frame_state) {
    errors.push("ending.final_frame_state is required");
  }
  if (
    snapshot.ending?.end_card_layer_id &&
    !ids.has(snapshot.ending.end_card_layer_id)
  ) {
    errors.push(
      `ending.end_card_layer_id is unknown: ${snapshot.ending.end_card_layer_id}`,
    );
  }
  return errors;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validBounds(bounds: RenderLayoutBounds | undefined): boolean {
  return Boolean(bounds) &&
    Number.isFinite(bounds!.x) &&
    Number.isFinite(bounds!.y) &&
    Number.isFinite(bounds!.width) &&
    Number.isFinite(bounds!.height) &&
    bounds!.width > 0 &&
    bounds!.height > 0;
}

function containsRect(
  outer: RenderLayoutBounds,
  inner: RenderLayoutBounds,
): boolean {
  return inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
}

function rectsOverlap(
  left: RenderLayoutBounds,
  right: RenderLayoutBounds,
): boolean {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y;
}

function frameOverlap(
  left: Pick<RenderLayoutLayer, "start_frame" | "end_frame">,
  right: Pick<RenderLayoutLayer, "start_frame" | "end_frame">,
): { start: number; end: number } | null {
  const start = Math.max(left.start_frame, right.start_frame);
  const end = Math.min(left.end_frame, right.end_frame);
  return end > start ? { start, end } : null;
}

function hashSnapshot(snapshot: RenderLayoutSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
