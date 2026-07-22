import { resolveContentTemplate } from "./template-registry.js";
import type { ContentAnchor, ContentElementV1, TimedContentElement } from "./types.js";
import { assertValidContentElement } from "./validation.js";
import {
  DEFAULT_VIDEO_WEB_FONT_ASSET,
  type VideoWebFontAsset,
} from "../../editor/shared/font-contract.js";

export interface HyperFramesCompositionInput {
  composition_id: string;
  width: number;
  height: number;
  fps: number;
  duration_frames: number;
  elements: TimedContentElement[];
}

export interface HyperFramesHTMLOptions {
  fontAsset?: VideoWebFontAsset;
}

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' data:",
  "font-src 'self' data:",
  "script-src 'self' 'unsafe-inline' blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join("; ");

function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function seconds(frames: number, fps: number): string {
  return (frames / fps).toFixed(6).replace(/\.?0+$/, "");
}

function anchorPosition(anchor: ContentAnchor): { left: number; top: number; tx: number; ty: number } {
  const columns = {
    top_left: [0, 0, 0, 0],
    top_center: [50, 0, -50, 0],
    top_right: [100, 0, -100, 0],
    center_left: [0, 50, 0, -50],
    center: [50, 50, -50, -50],
    center_right: [100, 50, -100, -50],
    bottom_left: [0, 100, 0, -100],
    bottom_center: [50, 100, -50, -100],
    bottom_right: [100, 100, -100, -100],
  } satisfies Record<ContentAnchor, [number, number, number, number]>;
  const [left, top, tx, ty] = columns[anchor];
  return { left, top, tx, ty };
}

function wrapperStyle(element: ContentElementV1): string {
  const position = anchorPosition(element.layout.anchor);
  const safe = element.layout.safe_area ? "var(--safe-x)" : "0px";
  const safeY = element.layout.safe_area ? "var(--safe-y)" : "0px";
  const xDirection = position.left === 100 ? -1 : 1;
  const yDirection = position.top === 100 ? -1 : 1;
  const left = `calc(${position.left}% + ${xDirection} * ${safe} + ${element.layout.x * 100}%)`;
  const top = `calc(${position.top}% + ${yDirection} * ${safeY} + ${element.layout.y * 100}%)`;
  const width = element.layout.width === undefined ? "auto" : `${element.layout.width * 100}vw`;
  const height = element.layout.height === undefined ? "auto" : `${element.layout.height * 100}vh`;
  return [
    `left:${left}`,
    `top:${top}`,
    `width:${width}`,
    `height:${height}`,
    `opacity:${element.layout.opacity}`,
    `z-index:${element.layout.z_index}`,
    `transform:translate(${position.tx}%,${position.ty}%) scale(${element.layout.scale}) rotate(${element.layout.rotation_deg}deg)`,
  ].join(";");
}

function renderSectionLabel(element: ContentElementV1): string {
  const title = escapeHTML(String(element.props.title ?? ""));
  const eyebrow = typeof element.props.eyebrow === "string" && element.props.eyebrow.length > 0
    ? `<div class="section-eyebrow">${escapeHTML(element.props.eyebrow)}</div>`
    : "";
  return `<div class="section-panel"><div class="section-rule"></div><div>${eyebrow}<div class="section-title">${title}</div></div></div>`;
}

function renderQuestionCard(element: ContentElementV1): string {
  const question = escapeHTML(String(element.props.question ?? ""));
  const label = typeof element.props.label === "string" && element.props.label.length > 0
    ? escapeHTML(element.props.label)
    : "QUESTION";
  return `<div class="question-panel"><div class="question-label">${label}</div><div class="question-text">${question}</div></div>`;
}

function renderLowerThird(element: ContentElementV1): string {
  const name = escapeHTML(String(element.props.name ?? ""));
  const role = typeof element.props.role === "string" && element.props.role.length > 0
    ? `<div class="lower-third-role">${escapeHTML(element.props.role)}</div>`
    : "";
  return `<div class="lower-third"><div class="lower-third-name">${name}</div>${role}</div>`;
}

function renderElement(timed: TimedContentElement, fps: number): string {
  const element = assertValidContentElement(timed.element);
  const manifest = element.template_ref ? resolveContentTemplate(element.template_ref) : null;
  if (manifest === null || manifest.preferred_renderer !== "hyperframes") {
    throw new Error(`HyperFrames does not own template ${element.template_ref ?? "(none)"}`);
  }
  if (timed.start_frame < 0 || !Number.isInteger(timed.start_frame)) {
    throw new Error(`Invalid start_frame for ${element.element_id}`);
  }
  if (timed.duration_frames < 1 || !Number.isInteger(timed.duration_frames)) {
    throw new Error(`Invalid duration_frames for ${element.element_id}`);
  }

  let body: string;
  if (manifest.id === "vos:content.section-label/v1") body = renderSectionLabel(element);
  else if (manifest.id === "vos:content.question-card/v1") body = renderQuestionCard(element);
  else if (manifest.id === "vos:content.lower-third/v1") body = renderLowerThird(element);
  else throw new Error(`HyperFrames HTML generator has no v1 body for ${manifest.id}`);

  return [
    `    <section id="${escapeHTML(element.element_id)}" class="clip content-element ${escapeHTML(manifest.semantic_role)}"`,
    `      data-start="${seconds(timed.start_frame, fps)}" data-duration="${seconds(timed.duration_frames, fps)}"`,
    `      data-track-index="${timed.track_index ?? element.layout.z_index}" data-renderer-owner="hyperframes"`,
    `      aria-label="${escapeHTML(String(element.props[manifest.accessibility_label_prop] ?? ""))}"`,
    `      style="${escapeHTML(wrapperStyle(element))}">`,
    `      <div class="motion">${body}</div>`,
    "    </section>",
  ].join("\n");
}

export function generateHyperFramesHTML(
  input: HyperFramesCompositionInput,
  options: HyperFramesHTMLOptions = {},
): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(input.composition_id)) throw new Error("Invalid composition_id");
  if (!Number.isInteger(input.width) || input.width < 1) throw new Error("width must be a positive integer");
  if (!Number.isInteger(input.height) || input.height < 1) throw new Error("height must be a positive integer");
  if (!Number.isFinite(input.fps) || input.fps <= 0) throw new Error("fps must be positive");
  if (!Number.isInteger(input.duration_frames) || input.duration_frames < 1) {
    throw new Error("duration_frames must be a positive integer");
  }

  const elements = [...input.elements]
    .sort((left, right) =>
      left.start_frame - right.start_frame ||
      left.element.layout.z_index - right.element.layout.z_index ||
      left.element.element_id.localeCompare(right.element.element_id, "en"),
    )
    .map((entry) => renderElement(entry, input.fps))
    .join("\n");
  const fontAsset = options.fontAsset ?? DEFAULT_VIDEO_WEB_FONT_ASSET;

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHTML(CSP)}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { --safe-x: ${Math.round(input.width * 0.05)}px; --safe-y: ${Math.round(input.height * 0.067)}px; }
    * { box-sizing: border-box; }
    @font-face { font-family: "${fontAsset.family}"; src: url("./${fontAsset.webPublicPath}") format("${fontAsset.format}"); font-style: ${fontAsset.style}; font-weight: ${fontAsset.weightRange[0]} ${fontAsset.weightRange[1]}; font-display: block; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
    body { font-family: "${fontAsset.family}", sans-serif; color: #fff; }
    #root { position: relative; width: ${input.width}px; height: ${input.height}px; overflow: hidden; background: transparent; }
    .content-element { position: absolute; pointer-events: none; }
    .motion { animation: vos-fade-rise 450ms cubic-bezier(.2,0,0,1) both; }
    .section-panel { display: flex; align-items: stretch; gap: 18px; max-width: ${Math.round(input.width * 0.72)}px; }
    .section-rule { width: 7px; min-height: 72px; background: #00d4ff; border-radius: 999px; box-shadow: 0 2px 8px rgba(0,0,0,.7); }
    .section-eyebrow { margin-bottom: 5px; color: #00d4ff; font-size: ${Math.round(input.height * 0.021)}px; font-weight: 750; letter-spacing: .08em; -webkit-text-stroke: 1px rgba(0,0,0,.72); paint-order: stroke fill; }
    .section-title { font-size: ${Math.round(input.height * 0.052)}px; font-weight: 780; line-height: 1.12; white-space: pre-wrap; -webkit-text-stroke: ${Math.max(2, Math.round(input.height * 0.003))}px #080808; paint-order: stroke fill; text-shadow: 0 3px 8px rgba(0,0,0,.55); }
    .question-panel { width: ${Math.round(input.width * 0.86)}px; text-align: center; }
    .question-label { margin-bottom: 14px; color: #00d4ff; font-size: ${Math.round(input.height * 0.022)}px; font-weight: 800; letter-spacing: .12em; -webkit-text-stroke: 1px rgba(0,0,0,.72); paint-order: stroke fill; }
    .question-text { font-size: ${Math.round(input.height * 0.058)}px; font-weight: 800; line-height: 1.18; white-space: pre-wrap; text-wrap: balance; -webkit-text-stroke: ${Math.max(2, Math.round(input.height * 0.0035))}px #080808; paint-order: stroke fill; text-shadow: 0 3px 10px rgba(0,0,0,.58); }
    .lower-third { max-width: ${Math.round(input.width * 0.64)}px; }
    .lower-third-name { display: inline-block; font-size: ${Math.round(input.height * 0.043)}px; font-weight: 800; line-height: 1.1; -webkit-text-stroke: ${Math.max(2, Math.round(input.height * 0.0028))}px #080808; paint-order: stroke fill; text-shadow: 0 3px 8px rgba(0,0,0,.55); }
    .lower-third-name::after { content: ""; display: block; width: 72%; height: 5px; margin-top: 9px; border-radius: 999px; background: #00d4ff; box-shadow: 0 2px 5px rgba(0,0,0,.5); }
    .lower-third-role { margin-top: 10px; color: rgba(255,255,255,.94); font-size: ${Math.round(input.height * 0.024)}px; font-weight: 700; -webkit-text-stroke: 1px rgba(0,0,0,.8); paint-order: stroke fill; }
    @keyframes vos-fade-rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>
  <main id="root" data-composition-id="${escapeHTML(input.composition_id)}" data-width="${input.width}" data-height="${input.height}" data-fps="${input.fps}" data-start="0" data-duration="${seconds(input.duration_frames, input.fps)}" data-no-timeline>
${elements}
  </main>
</body>
</html>
`;
}
