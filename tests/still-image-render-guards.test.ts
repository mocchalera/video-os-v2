import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const remotionMocks = vi.hoisted(() => ({
  bundle: vi.fn(),
  renderMedia: vi.fn(),
  selectComposition: vi.fn(),
}));
vi.mock("@remotion/bundler", () => ({ bundle: remotionMocks.bundle }));
vi.mock("@remotion/renderer", () => ({
  renderMedia: remotionMocks.renderMedia,
  selectComposition: remotionMocks.selectComposition,
}));
const { bundle, renderMedia, selectComposition } = remotionMocks;

import { assembleTimelineToMp4 } from "../runtime/render/assembler.js";
import { renderRemotionAssembly } from "../runtime/render/remotion/render-remotion.js";
import { renderPreviewSegment } from "../runtime/preview/segment-renderer.js";
import { runRenderPipeline } from "../runtime/render/pipeline.js";
import { renderRoughCut } from "../scripts/render-rough-cut.js";
import { evaluateReviewVisualQA } from "../runtime/review/visual-qa.js";
import { finishPromoCut } from "../runtime/render/promo-finisher.js";
import { assertTimelineRenderSupported } from "../runtime/render/media-kind-guard.js";
import { authoritativeStillInRenderSpec, PreviewJobService } from "../editor/server/services/preview-job-service.js";

const dirs: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function guardedProject(metadataOnly = false): { project: string; timelinePath: string } {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "vos-render-guard-"));
  dirs.push(project);
  const timelinePath = path.join(project, "05_timeline", "timeline.json");
  fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
  fs.writeFileSync(timelinePath, JSON.stringify({
    version: "1", project_id: "P", created_at: "2026-01-01T00:00:00Z",
    sequence: { name: "still", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
    tracks: { video: [{ track_id: "V1", kind: "video", clips: [{
      clip_id: "CLP_IMG", segment_id: "SEG_IMG", asset_id: "AST_IMG",
      src_in_us: 0, src_out_us: 1, timeline_in_frame: 0, timeline_duration_frames: 72,
      role: "hero", motivation: "still", beat_id: "b01", fallback_segment_ids: [], confidence: 1,
      quality_flags: [], ...(metadataOnly ? {} : { media_kind: "image" }),
      still_image: { hold_frames: 72, min_hold_frames: 24, max_hold_frames: 240, hold_source: "global_default", policy_clamp: "none", motion_mode: "static", fit_mode: "contain", background: "black" },
    }] }], audio: [] }, markers: [],
    provenance: { brief_path: "", blueprint_path: "", selects_path: "", compiler_version: "test" },
  }));
  return { project, timelinePath };
}

function expectRenderBlock(promise: Promise<unknown>): Promise<void> {
  return expect(promise).rejects.toMatchObject({ name: "CanonicalRenderInputError" });
}

function stripClipTruthAndWriteAuthoritativeImage(project: string, timelinePath: string): void {
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  const clip = timeline.tracks.video[0].clips[0];
  delete clip.media_kind;
  delete clip.still_image;
  fs.writeFileSync(timelinePath, JSON.stringify(timeline));
  fs.mkdirSync(path.join(project, "03_analysis"), { recursive: true });
  fs.writeFileSync(path.join(project, "03_analysis", "assets.json"), JSON.stringify({ items: [{
    asset_id: "AST_IMG", filename: "truthful-still.jpg", media_kind: "image",
  }] }));
  fs.mkdirSync(path.join(project, "02_media"), { recursive: true });
  fs.writeFileSync(path.join(project, "02_media", "source_map.json"), JSON.stringify({ items: [{
    asset_id: "AST_IMG", source_locator: "02_media/truthful-still.jpg", media_kind: "image",
  }] }));
}

describe("EYE-070C2B direct-entry render guards", () => {
  it("blocks FFmpeg assembler before its injected executor", async () => {
    const { project, timelinePath } = guardedProject();
    const execFileImpl = vi.fn();
    await expectRenderBlock(assembleTimelineToMp4({ projectDir: project, timelinePath, execFileImpl }));
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("blocks Remotion before bundle, composition, or renderer invocation", async () => {
    const { project, timelinePath } = guardedProject();
    await expectRenderBlock(renderRemotionAssembly({ timelinePath, sourceMap: {}, outputPath: path.join(project, "out.mp4") }));
    expect(bundle).not.toHaveBeenCalled();
    expect(selectComposition).not.toHaveBeenCalled();
    expect(renderMedia).not.toHaveBeenCalled();
  });

  it("blocks exact preview before output or FFmpeg work", async () => {
    const { project, timelinePath } = guardedProject();
    const outputPath = path.join(project, "preview", "out.mp4");
    await expectRenderBlock(renderPreviewSegment({
      projectDir: project, timelinePath, outputPath,
      sourceMap: { path: "", document: { version: "1", project_id: "P", items: [] }, entryMap: new Map() } as never,
    }));
    expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
  });

  it("blocks rough-cut before source resolution or output creation", async () => {
    const { project } = guardedProject();
    await expectRenderBlock(renderRoughCut({ projectPath: project } as never));
    expect(fs.existsSync(path.join(project, "09_output"))).toBe(false);
  });

  it("blocks render pipeline before output directory creation", async () => {
    const { project, timelinePath } = guardedProject();
    const outputDir = path.join(project, "render-pipeline");
    await expectRenderBlock(runRenderPipeline({
      timelinePath, outputDir, fps: 24,
      captionPolicy: { language: "ja", delivery_mode: "none", source: "none", styling_class: "clean-lower-third" },
    } as never));
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it("blocks visual QA before renderer callback invocation", async () => {
    const { project } = guardedProject();
    const render = vi.fn();
    await expectRenderBlock(evaluateReviewVisualQA(project, { render: true, assembleTimelineToMp4Impl: render } as never));
    expect(render).not.toHaveBeenCalled();
  });

  it("blocks promo finishing before workdir, injected assembler, or exec invocation", async () => {
    const { project, timelinePath } = guardedProject();
    const workDir = path.join(project, "promo-work");
    const assemble = vi.fn();
    const exec = vi.fn();
    await expectRenderBlock(finishPromoCut({
      projectDir: project,
      timelinePath,
      workDir,
      assembleTimelineToMp4Impl: assemble,
      execFileImpl: exec as never,
    }));
    expect(assemble).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(fs.existsSync(workDir)).toBe(false);
  });

  it("blocks malformed still_image-only truth at every direct renderer boundary", async () => {
    const { project, timelinePath } = guardedProject(true);
    const assemblerExec = vi.fn();
    const previewOut = path.join(project, "preview-malformed", "out.mp4");
    const pipelineOut = path.join(project, "pipeline-malformed");
    const visualRender = vi.fn();
    const promoAssemble = vi.fn();
    const promoExec = vi.fn();
    const promoWork = path.join(project, "promo-malformed");
    await expectRenderBlock(assembleTimelineToMp4({ projectDir: project, timelinePath, execFileImpl: assemblerExec }));
    await expectRenderBlock(renderRemotionAssembly({ timelinePath, sourceMap: {}, outputPath: path.join(project, "remotion.mp4") }));
    await expectRenderBlock(renderPreviewSegment({
      projectDir: project, timelinePath, outputPath: previewOut,
      sourceMap: { path: "", document: { version: "1", project_id: "P", items: [] }, entryMap: new Map() } as never,
    }));
    await expectRenderBlock(renderRoughCut({ projectPath: project } as never));
    await expectRenderBlock(runRenderPipeline({
      timelinePath, outputDir: pipelineOut, fps: 24,
      captionPolicy: { language: "ja", delivery_mode: "none", source: "none", styling_class: "clean-lower-third" },
    } as never));
    await expectRenderBlock(evaluateReviewVisualQA(project, { render: true, assembleTimelineToMp4Impl: visualRender } as never));
    await expectRenderBlock(finishPromoCut({
      projectDir: project,
      timelinePath,
      workDir: promoWork,
      assembleTimelineToMp4Impl: promoAssemble,
      execFileImpl: promoExec as never,
    }));
    expect(assemblerExec).not.toHaveBeenCalled();
    expect(bundle).not.toHaveBeenCalled();
    expect(selectComposition).not.toHaveBeenCalled();
    expect(renderMedia).not.toHaveBeenCalled();
    expect(visualRender).not.toHaveBeenCalled();
    expect(promoAssemble).not.toHaveBeenCalled();
    expect(promoExec).not.toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(previewOut))).toBe(false);
    expect(fs.existsSync(pipelineOut)).toBe(false);
    expect(fs.existsSync(promoWork)).toBe(false);
  });

  it("blocks marker-stripped authoritative images at all seven direct render boundaries with zero calls or side effects", async () => {
    const { project, timelinePath } = guardedProject();
    stripClipTruthAndWriteAuthoritativeImage(project, timelinePath);
    const sourceLocator = path.join(project, "02_media", "truthful-still.jpg");
    const sourceMap = {
      path: path.join(project, "02_media", "source_map.json"),
      document: { version: "1", project_id: "P", items: [] },
      entryMap: new Map([["AST_IMG", { asset_id: "AST_IMG", source_locator: sourceLocator, media_kind: "image" }]]),
      locatorMap: new Map([["AST_IMG", sourceLocator]]),
      entries: [],
    } as never;
    const assemblerExec = vi.fn();
    const previewOut = path.join(project, "preview-stripped", "out.mp4");
    const pipelineOut = path.join(project, "pipeline-stripped");
    const visualRender = vi.fn();
    const promoAssemble = vi.fn();
    const promoExec = vi.fn();
    const promoWork = path.join(project, "promo-stripped");

    await expectRenderBlock(assembleTimelineToMp4({
      projectDir: project, timelinePath, sourceOverrides: { AST_IMG: sourceLocator }, execFileImpl: assemblerExec,
    }));
    await expectRenderBlock(renderRemotionAssembly({
      // Empty direct sourceMap proves the standard 05_timeline project-root
      // resolution reaches authoritative assets/source_map before bundling.
      timelinePath, sourceMap: {}, outputPath: path.join(project, "remotion-stripped.mp4"),
    }));
    await expectRenderBlock(renderPreviewSegment({ projectDir: project, timelinePath, outputPath: previewOut, sourceMap }));
    await expectRenderBlock(renderRoughCut({ projectPath: project } as never));
    await expectRenderBlock(runRenderPipeline({
      projectDir: project, timelinePath, sourceMap: { AST_IMG: sourceLocator }, outputDir: pipelineOut, fps: 24,
      captionPolicy: { language: "ja", delivery_mode: "none", source: "none", styling_class: "clean-lower-third" },
    } as never));
    await expectRenderBlock(evaluateReviewVisualQA(project, {
      render: true, assembleTimelineToMp4Impl: visualRender,
    } as never));
    await expectRenderBlock(finishPromoCut({
      projectDir: project, timelinePath, workDir: promoWork,
      assembleTimelineToMp4Impl: promoAssemble, execFileImpl: promoExec as never,
    }));

    expect(assemblerExec).not.toHaveBeenCalled();
    expect(bundle).not.toHaveBeenCalled();
    expect(selectComposition).not.toHaveBeenCalled();
    expect(renderMedia).not.toHaveBeenCalled();
    expect(visualRender).not.toHaveBeenCalled();
    expect(promoAssemble).not.toHaveBeenCalled();
    expect(promoExec).not.toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(previewOut))).toBe(false);
    expect(fs.existsSync(pipelineOut)).toBe(false);
    expect(fs.existsSync(promoWork)).toBe(false);
  });

  it("uses source-map kind or registered locator extension, requires a project root for derived media, and preserves legacy video", () => {
    const { project, timelinePath } = guardedProject();
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    delete timeline.tracks.video[0].clips[0].media_kind;
    delete timeline.tracks.video[0].clips[0].still_image;
    expect(() => assertTimelineRenderSupported(timeline, {
      sourceLocators: { AST_IMG: { source_locator: "media/still.PNG" } },
    })).toThrowError(expect.objectContaining({ reason: "image_project_root_unresolved" }));
    expect(() => assertTimelineRenderSupported(timeline, {
      sourceLocators: { AST_IMG: { source_locator: "media/frames.bin", media_kind: "image" } },
    })).toThrowError(expect.objectContaining({ reason: "image_project_root_unresolved" }));
    expect(() => assertTimelineRenderSupported(timeline, {
      sourceLocators: { AST_IMG: { source_locator: "media/frames.bin", media_kind: "sequence" } },
    })).toThrowError(expect.objectContaining({ reason: "sequence_project_root_unresolved" }));
    expect(() => assertTimelineRenderSupported(timeline, {
      sourceLocators: { AST_IMG: "media/legacy.mov" },
    })).not.toThrow();
  });

  it.each(["overlay", "caption"] as const)("enumerates and blocks image truth on the %s lane", (lane) => {
    const timeline = {
      tracks: { video: [], audio: [], [lane]: [{ clips: [{ asset_id: "AST_LANE", media_kind: "image" }] }] },
    };
    expect(() => assertTimelineRenderSupported(timeline)).toThrowError(expect.objectContaining({
      reason: "image_project_root_unresolved",
    }));
  });

  it.each(["audio", "overlay", "caption"] as const)("fails closed for clip-only image truth on the %s lane with a standard project root", (lane) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "vos-image-lane-"));
    dirs.push(project);
    const timelinePath = path.join(project, "05_timeline/timeline.json");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    const timeline = { tracks: { video: [], audio: [], [lane]: [{ clips: [{ asset_id: "AST_LANE", media_kind: "image" }] }] } };
    fs.writeFileSync(timelinePath, JSON.stringify(timeline));
    expect(() => assertTimelineRenderSupported(timeline, { projectDir: project, timelinePath }))
      .toThrowError(expect.objectContaining({ reason: "still_image_invalid_lane", assetId: "AST_LANE" }));
  });

  it("classifies PreviewJobService by authoritative asset identity, not caller extension", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "vos-preview-authority-"));
    dirs.push(project);
    fs.mkdirSync(path.join(project, "02_media"), { recursive: true });
    fs.mkdirSync(path.join(project, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(project, "02_media/source_map.json"), JSON.stringify({ items: [
      { asset_id: "AST_BIN_IMAGE", source_locator: path.join(project, "image.bin"), media_kind: "image" },
      { asset_id: "AST_VIDEO", source_locator: path.join(project, "video.mp4"), media_kind: "video" },
    ] }));
    fs.writeFileSync(path.join(project, "03_analysis/assets.json"), JSON.stringify({ items: [
      { asset_id: "AST_BIN_IMAGE", filename: "image.bin", media_kind: "image" },
      { asset_id: "AST_VIDEO", filename: "video.mp4", media_kind: "video" },
    ] }));
    const spec = (assetId: string, sourcePath: string) => ({
      sequence: { fps: 24 }, video: { clips: [{ assetId, clipId: "C", sourcePath }], transitions: [] },
    }) as any;
    expect(authoritativeStillInRenderSpec(project, spec("AST_BIN_IMAGE", path.join(project, "image.bin")))).toBe(true);
    expect(authoritativeStillInRenderSpec(project, spec("AST_VIDEO", path.join(project, "misleading.jpg")))).toBe(false);

    const imageSpec = {
      ...spec("AST_BIN_IMAGE", path.join(project, "image.bin")),
      timelineRevision: "rev-image",
      renderSpecHash: "hash-image",
      warnings: [],
    } as never;
    const onComplete = vi.fn();
    const service = new PreviewJobService(onComplete);
    const state = service.request("P", project, imageSpec);
    expect(state).toMatchObject({
      status: "error",
      error: "exact_preview_still_requires_canonical_timeline",
      previewUrl: null,
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(project, "05_timeline/previews"))).toBe(false);
  });
});
