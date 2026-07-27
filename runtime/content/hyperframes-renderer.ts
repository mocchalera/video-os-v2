import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { composeFinalVisuals } from "../render/final-visual-compositor.js";
import { writeHyperFramesProject } from "./hyperframes-project.js";
import { loadContentRenderPlan, type ContentRenderPlan } from "./render-plan.js";
import type { CreativeCompositeStage } from "./types.js";
import {
  assertAlphaLayerMediaContract,
  probeAlphaLayerMedia,
  type AlphaLayerMediaContract,
  type ProbeAlphaLayerMedia,
} from "../render/alpha-layer-contract.js";

export const HYPERFRAMES_RENDERER_VERSION = "0.7.60";
const HYPERFRAMES_VISUAL_CONTRACT_VERSION = "hyperframes-visual/v2";

export interface HyperFramesRenderResult {
  compositePath: string;
  overlayPath: string;
  receiptPath: string;
  elementCount: number;
}

export interface HyperFramesRenderOptions {
  timelinePath: string;
  baseAssemblyPath: string;
  outputDir: string;
  executablePath?: string;
}

export interface HyperFramesLayerRenderResult {
  overlayPath: string;
  receiptPath: string;
  elementCount: number;
}

export interface HyperFramesLayerRenderOptions {
  timelinePath: string;
  outputDir: string;
  executablePath?: string;
  compositeStage?: CreativeCompositeStage;
  probeAlphaLayerImpl?: ProbeAlphaLayerMedia;
}

export function hyperFramesFpsArgument(
  plan: Pick<ContentRenderPlan, "fps_num" | "fps_den">,
): string {
  return `${plan.fps_num}/${plan.fps_den}`;
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function selectedElements(
  plan: ContentRenderPlan,
  compositeStage?: CreativeCompositeStage,
): ContentRenderPlan["hyperframes_elements"] {
  if (!compositeStage) return plan.hyperframes_elements;
  return plan.hyperframes_elements.filter((entry) =>
    (entry.element.creative_recipe?.composite_stage ?? "under_caption") === compositeStage
  );
}

export function hyperFramesVisualProjectionSha256(
  plan: ContentRenderPlan,
  compositeStage?: CreativeCompositeStage,
): string {
  return createHash("sha256").update(JSON.stringify({
    visual_contract_version: HYPERFRAMES_VISUAL_CONTRACT_VERSION,
    width: plan.width,
    height: plan.height,
    fps_num: plan.fps_num,
    fps_den: plan.fps_den,
    duration_frames: plan.duration_frames,
    composite_stage: compositeStage ?? "all",
    elements: selectedElements(plan, compositeStage),
  })).digest("hex");
}

function layerBasename(compositeStage?: CreativeCompositeStage): string {
  return compositeStage ? `hyperframes-${compositeStage.replace("_", "-")}` : "hyperframes";
}

async function readCachedHyperFramesLayer(
  options: HyperFramesLayerRenderOptions,
  elementIDs: string[],
  projectionSha256: string,
  plan: ContentRenderPlan,
): Promise<HyperFramesLayerRenderResult | null> {
  const videoDir = path.join(options.outputDir, "video");
  const logsDir = path.join(options.outputDir, "logs");
  const basename = layerBasename(options.compositeStage);
  const overlayPath = path.join(videoDir, `${basename}-overlay.webm`);
  const receiptPath = path.join(logsDir, `${basename}-layer-receipt.json`);
  if (![overlayPath, receiptPath].every((candidate) => fs.existsSync(candidate))) {
    return null;
  }

  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown> & {
      media?: AlphaLayerMediaContract;
    };
    const cachedElementIDs = Array.isArray(receipt.element_ids)
      ? receipt.element_ids.filter((value): value is string => typeof value === "string")
      : [];
    if (
      receipt.version !== "hyperframes-layer-receipt/v3" ||
      receipt.renderer !== "hyperframes" ||
      receipt.renderer_version !== HYPERFRAMES_RENDERER_VERSION ||
      receipt.timeline_visual_projection_sha256 !== projectionSha256 ||
      receipt.overlay_sha256 !== sha256(overlayPath) ||
      JSON.stringify(cachedElementIDs) !== JSON.stringify(elementIDs) ||
      !receipt.media
    ) {
      return null;
    }
    const liveMedia = await (options.probeAlphaLayerImpl ?? probeAlphaLayerMedia)(overlayPath);
    assertAlphaLayerMediaContract(liveMedia, {
      width: plan.width,
      height: plan.height,
      fpsNum: plan.fps_num,
      fpsDen: plan.fps_den,
      durationFrames: plan.duration_frames,
    });
    if (JSON.stringify(liveMedia) !== JSON.stringify(receipt.media)) return null;
    return {
      overlayPath,
      receiptPath,
      elementCount: elementIDs.length,
    };
  } catch {
    return null;
  }
}

/**
 * Render only the transparent renderer-owned layer. Base-video compositing is
 * deliberately deferred to the shared final visual compositor so captions
 * and all creative layers cost one H.264 generation in total.
 */
export async function renderHyperFramesContentLayer(
  options: HyperFramesLayerRenderOptions,
): Promise<HyperFramesLayerRenderResult | null> {
  const plan = loadContentRenderPlan(options.timelinePath);
  if (plan.issues.length > 0) {
    throw new Error(`Content render plan is invalid: ${plan.issues.map((issue) => `${issue.clip_id}: ${issue.message}`).join("; ")}`);
  }
  const elements = selectedElements(plan, options.compositeStage);
  if (elements.length === 0) return null;
  const elementIDs = elements.map((entry) => entry.element.element_id);
  const projectionSha256 = hyperFramesVisualProjectionSha256(plan, options.compositeStage);
  const cached = await readCachedHyperFramesLayer(
    options,
    elementIDs,
    projectionSha256,
    plan,
  );
  if (cached) return cached;

  const executablePath = options.executablePath
    ?? path.resolve("node_modules/.bin/hyperframes");
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Pinned HyperFrames CLI is not installed: ${executablePath}`);
  }

  const videoDir = path.join(options.outputDir, "video");
  const logsDir = path.join(options.outputDir, "logs");
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const basename = layerBasename(options.compositeStage);
  const overlayPath = path.join(videoDir, `${basename}-overlay.webm`);
  const receiptPath = path.join(logsDir, `${basename}-layer-receipt.json`);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-hyperframes-"));

  try {
    const written = writeHyperFramesProject(projectDir, {
      composition_id: "vos_content_overlay",
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      duration_frames: plan.duration_frames,
      elements,
    });
    const hfEnv = { HYPERFRAMES_NO_TELEMETRY: "1" };
    const lint = await run(executablePath, ["lint", projectDir, "--json"], hfEnv);
    await run(executablePath, [
      "render", projectDir,
      "--format", "webm",
      "--output", overlayPath,
      "--fps", hyperFramesFpsArgument(plan),
      "--quality", "high",
      "--workers", "1",
      "--strict",
      "--no-browser-gpu",
      "--quiet",
    ], hfEnv);
    const media = await (options.probeAlphaLayerImpl ?? probeAlphaLayerMedia)(overlayPath);
    assertAlphaLayerMediaContract(media, {
      width: plan.width,
      height: plan.height,
      fpsNum: plan.fps_num,
      fpsDen: plan.fps_den,
      durationFrames: plan.duration_frames,
    });

    const receipt = {
      version: "hyperframes-layer-receipt/v3",
      renderer: "hyperframes",
      renderer_version: HYPERFRAMES_RENDERER_VERSION,
      timeline_path: path.resolve(options.timelinePath),
      timeline_sha256: sha256(options.timelinePath),
      timeline_visual_projection_sha256: projectionSha256,
      composite_stage: options.compositeStage ?? "all",
      overlay_path: overlayPath,
      element_ids: elementIDs,
      template_refs: elements.map((entry) => entry.element.template_ref),
      font: {
        family: written.font.family,
        mode: written.font.mode,
        sha256: sha256(written.font.fontPath),
      },
      lint: JSON.parse(lint.stdout),
      overlay_sha256: sha256(overlayPath),
      media,
    };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return {
      overlayPath,
      receiptPath,
      elementCount: elements.length,
    };
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * Backward-compatible adapter for callers that still request an immediate
 * composite. Production and review pipelines use renderHyperFramesContentLayer
 * and defer this step to the shared single-pass compositor.
 */
export async function renderHyperFramesContentOverlay(
  options: HyperFramesRenderOptions,
): Promise<HyperFramesRenderResult | null> {
  const layer = await renderHyperFramesContentLayer(options);
  if (!layer) return null;
  const plan = loadContentRenderPlan(options.timelinePath);
  const videoDir = path.join(options.outputDir, "video");
  const logsDir = path.join(options.outputDir, "logs");
  const compositePath = path.join(videoDir, "assembly.with-content.mp4");
  const receiptPath = path.join(logsDir, "hyperframes-render-receipt.json");
  await composeFinalVisuals({
    baseVideoPath: options.baseAssemblyPath,
    layers: [{
      path: layer.overlayPath,
      renderer: "hyperframes",
      compositeStage: "under_caption",
      zIndex: Math.min(...plan.hyperframes_elements.map((entry) => entry.element.layout.z_index)),
      elementIds: plan.hyperframes_elements.map((entry) => entry.element.element_id),
    }],
    outputPath: compositePath,
    width: plan.width,
    height: plan.height,
    fpsNum: plan.fps_num,
    fpsDen: plan.fps_den,
    durationFrames: plan.duration_frames,
  });
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    version: "hyperframes-render-receipt/v1",
    renderer: "hyperframes",
    timeline_path: path.resolve(options.timelinePath),
    timeline_sha256: sha256(options.timelinePath),
    base_assembly_path: path.resolve(options.baseAssemblyPath),
    base_assembly_sha256: sha256(options.baseAssemblyPath),
    overlay_path: layer.overlayPath,
    composite_path: compositePath,
    element_ids: plan.hyperframes_elements.map((entry) => entry.element.element_id),
    layer_receipt_path: layer.receiptPath,
    overlay_sha256: sha256(layer.overlayPath),
    composite_sha256: sha256(compositePath),
  }, null, 2)}\n`, "utf8");
  return {
    compositePath,
    overlayPath: layer.overlayPath,
    receiptPath,
    elementCount: layer.elementCount,
  };
}
