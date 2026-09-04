import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const remotionMocks = vi.hoisted(() => ({
  bundle: vi.fn(),
  renderMedia: vi.fn(),
  selectComposition: vi.fn(),
  currentFrame: { value: 0 },
}));

vi.mock("remotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remotion")>();
  return {
    ...actual,
    useCurrentFrame: () => remotionMocks.currentFrame.value,
  };
});

vi.mock("@remotion/bundler", () => ({ bundle: remotionMocks.bundle }));
vi.mock("@remotion/renderer", () => ({
  renderMedia: remotionMocks.renderMedia,
  selectComposition: remotionMocks.selectComposition,
}));

import {
  createRemotionBundleIdentity,
  createRemotionLayerFingerprint,
  renderRemotionContentLayer,
  renderRemotionAssembly,
  type RemotionAlphaCompositeInput,
  type RemotionLayerProgressEvent,
} from "../runtime/render/remotion/render-remotion.js";
import {
  remotionCapabilityIdentityHash,
  REMOTION_OVERLAY_CAPABILITY_VERSION,
} from "../runtime/render/remotion/overlay-capability.js";
import { resolveRemotionOverlayClip } from "../runtime/render/remotion/overlay-clip-resolver.js";
import { resolveOverlayPreset } from "../runtime/render/remotion/styles/overlay-presets.js";
import { REMOTION_OVERLAY_COMPOSITION_ID } from "../runtime/render/remotion/timeline-to-props.js";

describe("Remotion renderer-owned alpha layer", () => {
  let projectDir: string;
  let timelinePath: string;
  let outputDir: string;
  const probedMedia = {
    version: "alpha-layer-media/v1" as const,
    codec_name: "vp9",
    pixel_format: "yuva420p",
    alpha_mode: "1",
    has_alpha: true,
    width: 640,
    height: 360,
    fps_num: 30_000,
    fps_den: 1_001,
    duration_frames: 60,
    time_base: "1/1000",
    audio_stream_count: 0,
  };

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-layer-"));
    timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    outputDir = path.join(projectDir, "07_package");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(timelinePath, JSON.stringify(timelineFixture()));

    remotionMocks.bundle.mockReset().mockResolvedValue("/tmp/remotion-bundle");
    remotionMocks.selectComposition.mockReset().mockResolvedValue({
      id: REMOTION_OVERLAY_COMPOSITION_ID,
      durationInFrames: 60,
      fps: 30_000 / 1_001,
      width: 640,
      height: 360,
    });
    remotionMocks.renderMedia.mockReset().mockImplementation(async (options: {
      outputLocation: string;
      onProgress?: (progress: { progress: number }) => void;
    }) => {
      options.onProgress?.({ progress: 1 });
      fs.mkdirSync(path.dirname(options.outputLocation), { recursive: true });
      fs.writeFileSync(options.outputLocation, "transparent-vp9");
    });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("renders VP9 yuva420p without base video or audio and writes a hash-bound receipt", async () => {
    const result = await renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    });

    expect(result).not.toBeNull();
    expect(remotionMocks.selectComposition).toHaveBeenCalledWith(expect.objectContaining({
      id: REMOTION_OVERLAY_COMPOSITION_ID,
    }));
    expect(remotionMocks.renderMedia).toHaveBeenCalledWith(expect.objectContaining({
      codec: "vp9",
      audioCodec: null,
      muted: true,
      imageFormat: "png",
      pixelFormat: "yuva420p",
    }));
    expect(JSON.parse(fs.readFileSync(result!.receiptPath, "utf8"))).toMatchObject({
      version: "remotion-layer-receipt/v3",
      state: "complete",
      complete: true,
      renderer: "remotion",
      renderer_version: "4.0.452",
      composite_stage: "under_caption",
      element_ids: ["TITLE_1"],
      fps_num: 30_000,
      fps_den: 1_001,
      media: probedMedia,
    });
  });

  it("records resolved layout and capability identity in the layer receipt", async () => {
    const result = await renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    });

    const receipt = JSON.parse(fs.readFileSync(result!.receiptPath, "utf8"));
    expect(receipt.capability_version).toBe(REMOTION_OVERLAY_CAPABILITY_VERSION);
    expect(receipt.capability_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.resolved_layout).toEqual([{
      element_id: "TITLE_1",
      clip_id: "TITLE_CLIP",
      layout: {
        anchor: "top_center",
        x: 0,
        y: 0,
        scale: 1,
        rotation_deg: 0,
        opacity: 1,
        safe_area: true,
        z_index: 100,
      },
      animation_in: undefined,
    }]);
  });

  it("produces a deterministic capability hash that tracks capability definition changes", () => {
    const baseline = remotionCapabilityIdentityHash();
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    expect(remotionCapabilityIdentityHash()).toBe(baseline);
    const mutated = {
      version: REMOTION_OVERLAY_CAPABILITY_VERSION,
      renderer: "remotion" as const,
      layout_fields: ["anchor", "x"],
      animation: { phases: ["in"], presets: ["none", "fade"], ref_fields: ["preset"] },
    };
    expect(remotionCapabilityIdentityHash(mutated)).not.toBe(baseline);
  });

  it("renders a canonical element whose animation uses the supported vocabulary", async () => {
    writeTimelineWithElement(timelinePath, animationElement("fade-rise"));
    const result = await renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    });
    expect(result).not.toBeNull();
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(1);
  });

  it("applies canonical animation vocabulary to drawn title-card frames", () => {
    const clip = timelineFixture().tracks.overlay[0].clips[0];
    (clip.metadata as Record<string, unknown>).content_element = animationElement("fade-rise");
    const resolved = resolveRemotionOverlayClip(clip as never);
    expect(resolved?.animationIn?.preset).toBe("fade-rise");
    const preset = resolveOverlayPreset(resolved!.presetId);
    expect(preset).not.toBeNull();

    const renderWith = (frame: number, animationIn: Record<string, unknown>) => {
      remotionMocks.currentFrame.value = frame;
      return preset!.render({
        text: resolved!.text,
        anchor: resolved!.anchor,
        durationInFrames: 90,
        fps: 30,
        animation_in: animationIn as never,
      });
    };

    // fade vs fade-rise at the same frame differ in drawn JSX: only
    // fade-rise carries the rising translateY while mid-motion.
    const fadeMid = renderWith(6, { preset: "fade", duration_frames: 12 });
    const riseMid = renderWith(6, { preset: "fade-rise", duration_frames: 12 });
    expect(findTransform(fadeMid)).not.toContain("translateY");
    expect(findTransform(riseMid)).toContain("translateY");

    // duration_frames changes the sampled opacity at the same frame.
    const fastFade = renderWith(3, { preset: "fade", duration_frames: 6 });
    const slowFade = renderWith(3, { preset: "fade", duration_frames: 24 });
    expect(findOpacity(fastFade)!).toBeGreaterThan(findOpacity(slowFade)!);

    // delay_frames holds the enter state until the delay elapses.
    const delayedStart = renderWith(2, { preset: "fade", duration_frames: 12, delay_frames: 6 });
    const immediateStart = renderWith(2, { preset: "fade", duration_frames: 12 });
    expect(findOpacity(delayedStart)).toBe(0);
    expect(findOpacity(immediateStart)!).toBeGreaterThan(0);

    // Motion completes within the clip duration.
    const settled = renderWith(40, { preset: "fade-rise", duration_frames: 12 });
    expect(findOpacity(settled)).toBe(1);
    expect(findTransform(settled)).not.toContain("translateY");
  });
  it("fails closed before renderMedia for an unsupported animation preset", async () => {
    writeTimelineWithElement(timelinePath, animationElement("slide-up"));
    await expect(renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    })).rejects.toThrow(/TITLE_1.*animation\.in\.preset.*slide-up/);
    expect(remotionMocks.bundle).not.toHaveBeenCalled();
    expect(remotionMocks.renderMedia).not.toHaveBeenCalled();
  });

  it("fails closed for an unsupported layout field", async () => {
    writeTimelineWithElement(timelinePath, elementWithLayout({ blur: 0.5 }));
    await expect(renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    })).rejects.toThrow(/TITLE_1.*layout\.blur/);
    expect(remotionMocks.renderMedia).not.toHaveBeenCalled();
  });

  it("fails closed with element id and field name for an invalid content element", async () => {
    writeTimelineWithElement(timelinePath, invalidElement());
    await expect(renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    })).rejects.toThrow(/TITLE_1.*field=layout.*opacity/);
    expect(remotionMocks.renderMedia).not.toHaveBeenCalled();
  });

  it("fails closed for an element that no renderer owns instead of silently dropping it", async () => {
    writeTimelineWithElement(timelinePath, nonTemplateElement());
    await expect(renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["RAWTEXT_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    })).rejects.toThrow(/RAWTEXT_1.*field=renderer_hint.*no_renderer_owner/);
    expect(remotionMocks.renderMedia).not.toHaveBeenCalled();
  });

  it("fails closed for a raw auto-hinted element that no implemented renderer owns", async () => {
    writeTimelineWithElement(timelinePath, rawAutoElement());
    await expect(renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["RAW_AUTO"],
      probeAlphaLayerImpl: async () => probedMedia,
    })).rejects.toThrow(/RAW_AUTO.*field=template_ref.*no_renderer_owner/);
    expect(remotionMocks.renderMedia).not.toHaveBeenCalled();
  });

  it("reuses the layer when only nonvisual timeline metadata changes", async () => {
    const first = await renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    });
    const changed = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    changed.metadata = { audio_finish: "changed" };
    fs.writeFileSync(timelinePath, JSON.stringify(changed));

    const second = await renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      probeAlphaLayerImpl: async () => probedMedia,
    });

    expect(second).toMatchObject({
      overlayPath: first!.overlayPath,
      receiptPath: first!.receiptPath,
      layerCacheHit: true,
    });
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(1);
  });

  it("reuses 14 of 15 element media entries for first, middle, and last single-element changes", async () => {
    fs.writeFileSync(timelinePath, JSON.stringify(multiElementTimeline(15)));
    const compositeCalls: RemotionAlphaCompositeInput[] = [];
    const compositeAlphaLayersImpl = async (input: RemotionAlphaCompositeInput) => {
      compositeCalls.push(input);
      fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
      fs.writeFileSync(input.outputPath, input.elements.map((element) => element.elementId).join("\n"));
    };
    const render = () => renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption" as const,
      generationId: `sha256:${"a".repeat(64)}`,
      compositeAlphaLayersImpl,
      probeAlphaLayerImpl: async () => probedMedia,
    });

    const cold = await render();
    expect(cold?.elementCache).toMatchObject({ total: 15, hits: 0, misses: 15 });
    expect(cold?.elementCache?.dirtyElementIds).toHaveLength(15);
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(15);

    const warm = await render();
    expect(warm?.elementCache).toMatchObject({ total: 15, hits: 15, misses: 0 });
    expect(warm?.layerCacheHit).toBe(true);
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(15);

    for (const index of [0, 7, 14]) {
      const changed = multiElementTimeline(15);
      const changedElement = changed.tracks.overlay[0].clips[index].metadata.content_element;
      changedElement.props = { title: `only element ${index + 1} changed` };
      fs.writeFileSync(timelinePath, JSON.stringify(changed, null, 2));
      const oneDirty = await render();
      const ordinal = String(index + 1).padStart(2, "0");
      expect(oneDirty?.elementCache).toMatchObject({ total: 15, hits: 14, misses: 1 });
      expect(oneDirty?.elementCache?.dirtyElementIds).toEqual([`TITLE_${ordinal}`]);
    }
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(18);
    expect(compositeCalls).toHaveLength(4);
  });

  it("keys media by resolved drawing props while keeping locator and element IDs in the composite identity", async () => {
    const compositeOrders: string[] = [];
    const render = () => renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption" as const,
      compositeAlphaLayersImpl: async (input) => {
        compositeOrders.push(input.elements.map((element) => element.elementId).join(","));
        fs.writeFileSync(input.outputPath, input.elements.map((element) => element.elementId).join(","));
      },
      probeAlphaLayerImpl: async () => probedMedia,
    });
    const first = await render();
    const relocated = timelineFixture();
    const relocatedClip = relocated.tracks.overlay[0].clips[0];
    relocatedClip.clip_id = "RELOCATED_CLIP";
    relocatedClip.segment_id = "RELOCATED_SEGMENT";
    relocatedClip.metadata.content_element.element_id = "RELOCATED_ELEMENT";
    relocated.provenance.brief_path = "elsewhere/brief.yaml";
    fs.writeFileSync(timelinePath, JSON.stringify(relocated));
    const sameDrawing = await render();

    expect(sameDrawing?.elementCache).toMatchObject({ hits: 1, misses: 0 });
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(1);
    expect(sameDrawing?.compositeIdentity).not.toBe(first?.compositeIdentity);
    expect(compositeOrders).toEqual(["TITLE_1", "RELOCATED_ELEMENT"]);

    relocatedClip.metadata.content_element.props.title = "再利用できる演出!";
    fs.writeFileSync(timelinePath, JSON.stringify(relocated));
    const changedDrawing = await render();
    expect(changedDrawing?.elementCache).toMatchObject({ hits: 0, misses: 1 });
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate selected element IDs before renderer or receipt writes", async () => {
    const duplicate = multiElementTimeline(2);
    duplicate.tracks.overlay[0].clips[1].metadata.content_element.element_id = "TITLE_01";
    fs.writeFileSync(timelinePath, JSON.stringify(duplicate));

    await expect(renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      probeAlphaLayerImpl: async () => probedMedia,
    })).rejects.toThrow(/duplicate_remotion_element_id:TITLE_01/);
    expect(remotionMocks.bundle).not.toHaveBeenCalled();
    expect(remotionMocks.selectComposition).not.toHaveBeenCalled();
    expect(remotionMocks.renderMedia).not.toHaveBeenCalled();
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it("keeps element identity stable across timeline bytes/locator changes but recomposes order changes", async () => {
    const firstTimeline = multiElementTimeline(3, { sameZIndex: true });
    const relocated = structuredClone(firstTimeline);
    relocated.created_at = "2030-01-01T00:00:00.000Z";
    relocated.provenance.brief_path = "relocated/brief.yaml";
    expect(createRemotionLayerFingerprint(firstTimeline as never, "under_caption", ["TITLE_01"]))
      .toBe(createRemotionLayerFingerprint(relocated as never, "under_caption", ["TITLE_01"]));

    fs.writeFileSync(timelinePath, JSON.stringify(firstTimeline));
    const outputs: string[] = [];
    const compositeAlphaLayersImpl = async (input: RemotionAlphaCompositeInput) => {
      const value = input.elements.map((element) => element.elementId).join(",");
      outputs.push(value);
      fs.writeFileSync(input.outputPath, value);
    };
    const render = () => renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption" as const,
      compositeAlphaLayersImpl,
      probeAlphaLayerImpl: async () => probedMedia,
    });
    const cold = await render();
    const reordered = structuredClone(firstTimeline);
    reordered.tracks.overlay[0].clips.reverse();
    fs.writeFileSync(timelinePath, JSON.stringify(reordered));
    const orderChanged = await render();

    expect(orderChanged?.elementCache).toMatchObject({ hits: 3, misses: 0 });
    expect(orderChanged?.compositeIdentity).not.toBe(cold?.compositeIdentity);
    expect(outputs).toEqual(["TITLE_01,TITLE_02,TITLE_03", "TITLE_03,TITLE_02,TITLE_01"]);
  });

  it("reuses element media when z-index swaps while recomposing the final order", async () => {
    const firstTimeline = multiElementTimeline(2);
    firstTimeline.tracks.overlay[0].clips[0].metadata.content_element.layout.z_index = 100;
    firstTimeline.tracks.overlay[0].clips[1].metadata.content_element.layout.z_index = 200;
    fs.writeFileSync(timelinePath, JSON.stringify(firstTimeline));
    const outputs: string[] = [];
    const compositeAlphaLayersImpl = async (input: RemotionAlphaCompositeInput) => {
      const value = input.elements.map((element) => element.elementId).join(",");
      outputs.push(value);
      fs.writeFileSync(input.outputPath, value);
    };
    const render = () => renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption" as const,
      compositeAlphaLayersImpl,
      probeAlphaLayerImpl: async () => probedMedia,
    });

    const cold = await render();
    expect(cold?.elementCache).toMatchObject({ total: 2, hits: 0, misses: 2 });
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(2);

    const swapped = structuredClone(firstTimeline);
    swapped.tracks.overlay[0].clips[0].metadata.content_element.layout.z_index = 200;
    swapped.tracks.overlay[0].clips[1].metadata.content_element.layout.z_index = 100;
    fs.writeFileSync(timelinePath, JSON.stringify(swapped));
    const orderChanged = await render();

    expect(orderChanged?.elementCache).toMatchObject({ total: 2, hits: 2, misses: 0 });
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(2);
    expect(orderChanged?.compositeIdentity).not.toBe(cold?.compositeIdentity);
    expect(outputs).toEqual(["TITLE_01,TITLE_02", "TITLE_02,TITLE_01"]);
  });

  it("separates bundle identity from content media identity and invalidates renderer/capability changes", () => {
    const value = multiElementTimeline(1);
    const bundleA = createRemotionBundleIdentity({ rendererVersion: "4.0.452", sourceVersion: "source-a" });
    const bundleB = createRemotionBundleIdentity({ rendererVersion: "4.0.452", sourceVersion: "source-b" });
    expect(bundleA).not.toBe(bundleB);
    const mediaA = createRemotionLayerFingerprint(value as never, "under_caption", ["TITLE_01"], {
      rendererVersion: "4.0.452", capabilitySha256: "a".repeat(64), bundleIdentity: bundleA,
    });
    expect(createRemotionLayerFingerprint(value as never, "under_caption", ["TITLE_01"], {
      rendererVersion: "4.0.453", capabilitySha256: "a".repeat(64), bundleIdentity: bundleA,
    })).not.toBe(mediaA);
    expect(createRemotionLayerFingerprint(value as never, "under_caption", ["TITLE_01"], {
      rendererVersion: "4.0.452", capabilitySha256: "b".repeat(64), bundleIdentity: bundleA,
    })).not.toBe(mediaA);
    expect(createRemotionLayerFingerprint(value as never, "under_caption", ["TITLE_01"], {
      rendererVersion: "4.0.452", capabilitySha256: "a".repeat(64), bundleIdentity: bundleB,
    })).not.toBe(mediaA);
  });

  it("reuses resolved element media across generations but never reuses a final layer bound to generation A for B", async () => {
    let composites = 0;
    const render = (generationId: string) => renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption" as const,
      generationId,
      compositeAlphaLayersImpl: async (input) => {
        composites += 1;
        fs.writeFileSync(input.outputPath, `generation-composite-${composites}`);
      },
      probeAlphaLayerImpl: async () => probedMedia,
    });
    const generationA = `sha256:${"a".repeat(64)}`;
    const generationB = `sha256:${"b".repeat(64)}`;
    await render(generationA);
    const second = await render(generationB);

    expect(second?.elementCache).toMatchObject({ hits: 1, misses: 0 });
    expect(second?.layerCacheHit).toBe(false);
    expect(composites).toBe(2);
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(second!.receiptPath, "utf8"))).toMatchObject({
      generation_id: generationB,
      complete: true,
    });
  });

  it("reports monotonic actual renderMedia alpha progress with frame and cache context", async () => {
    const events: RemotionLayerProgressEvent[] = [];
    remotionMocks.renderMedia.mockImplementationOnce(async (options: {
      outputLocation: string;
      onProgress?: (progress: { progress: number }) => void;
    }) => {
      options.onProgress?.({ progress: 0.25 });
      options.onProgress?.({ progress: 0.5 });
      options.onProgress?.({ progress: 0.25 });
      options.onProgress?.({ progress: 1 });
      fs.writeFileSync(options.outputLocation, "transparent-vp9-progress");
    });
    await renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      progressIntervalFrames: 1,
      onProgress: (event) => events.push(event),
      compositeAlphaLayersImpl: async (input) => fs.writeFileSync(input.outputPath, "composite"),
      probeAlphaLayerImpl: async () => probedMedia,
    });
    const rendering = events.filter((event) => event.phase === "rendering");
    expect(rendering.map((event) => event.completedFrames)).toEqual([15, 30, 60]);
    expect(rendering.every((event) => event.totalFrames === 60)).toBe(true);
    expect(rendering.every((event) => event.elementIds.join() === "TITLE_1")).toBe(true);
    expect(rendering.every((event) => event.elapsedMs >= 0 && event.cacheState === "miss")).toBe(true);
    const elementReceipt = fs.readdirSync(path.join(outputDir, "cache", "remotion-elements"))
      .find((entry) => entry.endsWith(".json"));
    expect(JSON.parse(fs.readFileSync(
      path.join(outputDir, "cache", "remotion-elements", elementReceipt!),
      "utf8",
    )).progress_evidence).toEqual({
      version: "remotion-render-progress-evidence/v1",
      event_count: 4,
      completed_frames: 60,
      total_frames: 60,
    });
  });

  it("rejects missing or throwing miss-render progress evidence and rerenders next time", async () => {
    const compositeAlphaLayersImpl = vi.fn(async (input: RemotionAlphaCompositeInput) => {
      fs.writeFileSync(input.outputPath, "composite");
    });
    const options = {
      timelinePath,
      outputDir,
      compositeStage: "under_caption" as const,
      elementIds: ["TITLE_1"],
      compositeAlphaLayersImpl,
      probeAlphaLayerImpl: async () => probedMedia,
    };
    remotionMocks.renderMedia.mockImplementationOnce(async (renderOptions: { outputLocation: string }) => {
      fs.writeFileSync(renderOptions.outputLocation, "no-progress");
    });
    await expect(renderRemotionContentLayer(options)).rejects.toThrow(/remotion_progress_evidence_missing:TITLE_1/);
    expect(compositeAlphaLayersImpl).not.toHaveBeenCalled();
    const cacheDir = path.join(outputDir, "cache", "remotion-elements");
    const receiptPath = path.join(cacheDir, fs.readdirSync(cacheDir).find((entry) => entry.endsWith(".json"))!);
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toMatchObject({ state: "failed", complete: false });
    expect(fs.readdirSync(cacheDir).some((entry) => entry.endsWith(".webm"))).toBe(false);

    remotionMocks.renderMedia.mockImplementationOnce(async (renderOptions: {
      outputLocation: string;
      onProgress?: (progress: { progress: number }) => void;
    }) => {
      renderOptions.onProgress?.({ progress: 0.5 });
      fs.writeFileSync(renderOptions.outputLocation, "observer-throw");
    });
    await expect(renderRemotionContentLayer({
      ...options,
      onProgress: (event) => {
        if (event.phase === "rendering") throw new Error("progress observer failed");
      },
    })).rejects.toThrow(/progress observer failed/);
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toMatchObject({ state: "failed", complete: false });
    expect(fs.readdirSync(cacheDir).some((entry) => entry.endsWith(".webm"))).toBe(false);

    const recovered = await renderRemotionContentLayer(options);
    expect(recovered?.elementCache).toMatchObject({ hits: 0, misses: 1 });
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(3);
  });

  it("rejects a selected composition frame mismatch before render or composite promotion", async () => {
    remotionMocks.selectComposition.mockResolvedValueOnce({
      id: REMOTION_OVERLAY_COMPOSITION_ID,
      durationInFrames: 59,
      fps: 30_000 / 1_001,
      width: 640,
      height: 360,
    });
    const compositeAlphaLayersImpl = vi.fn(async (input: RemotionAlphaCompositeInput) => {
      fs.writeFileSync(input.outputPath, "composite");
    });
    await expect(renderRemotionContentLayer({
      timelinePath,
      outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_1"],
      compositeAlphaLayersImpl,
      probeAlphaLayerImpl: async () => probedMedia,
    })).rejects.toThrow(/remotion_composition_contract_mismatch.*duration_frames=59.*expected=60/);

    expect(remotionMocks.renderMedia).not.toHaveBeenCalled();
    expect(compositeAlphaLayersImpl).not.toHaveBeenCalled();
    const cacheDir = path.join(outputDir, "cache", "remotion-elements");
    const cacheEntries = fs.readdirSync(cacheDir);
    expect(cacheEntries.some((entry) => entry.endsWith(".webm"))).toBe(false);
    const elementReceipt = JSON.parse(fs.readFileSync(
      path.join(cacheDir, cacheEntries.find((entry) => entry.endsWith(".json"))!),
      "utf8",
    ));
    expect(elementReceipt).toMatchObject({ state: "failed", complete: false });
    const finalReceipt = JSON.parse(fs.readFileSync(
      path.join(outputDir, "logs", "remotion-under-caption-layer-receipt.json"),
      "utf8",
    ));
    expect(finalReceipt).toMatchObject({ state: "failed", complete: false });
  });

  it("leaves failed/partial alpha artifacts invalid and rerenders on the next invocation", async () => {
    remotionMocks.renderMedia.mockImplementationOnce(async (options: { outputLocation: string }) => {
      fs.writeFileSync(options.outputLocation, "partial");
      throw new Error("interrupted render");
    });
    const options = {
      timelinePath,
      outputDir,
      compositeStage: "under_caption" as const,
      elementIds: ["TITLE_1"],
      compositeAlphaLayersImpl: async (input: RemotionAlphaCompositeInput) => fs.writeFileSync(input.outputPath, "composite"),
      probeAlphaLayerImpl: async () => probedMedia,
    };
    await expect(renderRemotionContentLayer(options)).rejects.toThrow("interrupted render");
    const partialReceipts = fs.readdirSync(path.join(outputDir, "cache", "remotion-elements"))
      .filter((entry) => entry.endsWith(".json"));
    expect(partialReceipts).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, "cache", "remotion-elements", partialReceipts[0]), "utf8")))
      .toMatchObject({ complete: false, state: "failed" });

    remotionMocks.renderMedia.mockImplementationOnce(async (renderOptions: {
      outputLocation: string;
      onProgress?: (progress: { progress: number }) => void;
    }) => {
      renderOptions.onProgress?.({ progress: 1 });
      fs.writeFileSync(renderOptions.outputLocation, "complete");
    });
    const recovered = await renderRemotionContentLayer(options);
    expect(recovered?.elementCache).toMatchObject({ hits: 0, misses: 1 });
  });

  it("fails closed before the assembly cache lookup when a requires_base_frame element is invalid", async () => {
    const assemblyOutput = path.join(outputDir, "video", "assembly.mp4");
    const clean = assemblyTimeline([
      assemblyOverlayClip("BASEFRAME_1", baseFrameElement("BASEFRAME_1")),
    ]);
    fs.writeFileSync(timelinePath, JSON.stringify(clean));
    const first = await renderRemotionAssembly({
      timelinePath,
      sourceMap: {},
      outputPath: assemblyOutput,
    });
    expect(first.assemblyCacheHit).toBe(false);

    // The receipt records capability identity and resolved layout.
    const receipt = JSON.parse(fs.readFileSync(`${assemblyOutput}.remotion-cache.json`, "utf8"));
    expect(receipt.capability_version).toBe(REMOTION_OVERLAY_CAPABILITY_VERSION);
    expect(receipt.capability_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.resolved_layout).toEqual([expect.objectContaining({
      element_id: "BASEFRAME_1",
      clip_id: "BASEFRAME_1",
    })]);

    // Same fingerprint (the invalid element is filtered out of it), but the
    // gate must throw before the cache lookup can mask the corruption.
    const corrupted = assemblyTimeline([
      assemblyOverlayClip("BASEFRAME_1", baseFrameElement("BASEFRAME_1")),
      assemblyOverlayClip("BAD_CLIP", baseFrameElement("BAD_1", (element) => {
        delete (element.layout as Record<string, unknown>).opacity;
      })),
    ]);
    fs.writeFileSync(timelinePath, JSON.stringify(corrupted));
    await expect(renderRemotionAssembly({
      timelinePath,
      sourceMap: {},
      outputPath: assemblyOutput,
    })).rejects.toThrow(/BAD_1.*invalid_content_element/);
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(1);
  });

  it("reuses the assembly cache deterministically for identical logical input", async () => {
    const assemblyOutput = path.join(outputDir, "video", "assembly-deterministic.mp4");
    fs.writeFileSync(timelinePath, JSON.stringify(assemblyTimeline([])));
    const first = await renderRemotionAssembly({
      timelinePath,
      sourceMap: {},
      outputPath: assemblyOutput,
    });
    const second = await renderRemotionAssembly({
      timelinePath,
      sourceMap: {},
      outputPath: assemblyOutput,
    });
    expect(first.assemblyCacheHit).toBe(false);
    expect(second.assemblyCacheHit).toBe(true);
    expect(remotionMocks.renderMedia).toHaveBeenCalledTimes(1);
  });
});

type JsxNode = { props?: { style?: Record<string, unknown>; children?: unknown } };

function findOpacity(node: unknown): number | undefined {
  if (!node || typeof node !== "object") return undefined;
  const element = node as JsxNode;
  const style = element.props?.style;
  if (style && typeof style.opacity === "number") return style.opacity;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findOpacity(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findTransform(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const element = node as JsxNode;
  const style = element.props?.style;
  if (style && typeof style.transform === "string") return style.transform;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findTransform(child);
    if (found) return found;
  }
  return "";
}

function baseElement(): Record<string, unknown> {
  return {
    version: "content-element/v1",
    element_id: "TITLE_1",
    kind: "template",
    template_ref: "vos:content.title-card/v1",
    template_version: "1.0.0",
    props: { title: "再利用できる演出" },
    layout: {
      anchor: "top_center",
      x: 0,
      y: 0,
      scale: 1,
      rotation_deg: 0,
      opacity: 1,
      safe_area: true,
      z_index: 100,
    },
    renderer_hint: "remotion",
    creative_recipe: {
      version: "creative-recipe/v1",
      reuse_scope: "brand",
      authoring_surface: "typed_component",
      layer_mode: "alpha_overlay",
      composite_stage: "under_caption",
      requires_base_frame: false,
    },
  };
}

function animationElement(preset: string) {
  return { ...baseElement(), animation: { in: { preset, duration_frames: 12 } } };
}

function elementWithLayout(extraLayout: Record<string, unknown>) {
  const layout = { ...(baseElement().layout as Record<string, unknown>), ...extraLayout };
  return { ...baseElement(), layout };
}

function invalidElement() {
  const element = baseElement();
  const layout = { ...(element.layout as Record<string, unknown>) };
  delete layout.opacity;
  return { ...element, layout };
}

function nonTemplateElement() {
  const { template_ref: _templateRef, template_version: _templateVersion, ...rest } = baseElement();
  return {
    ...rest,
    element_id: "RAWTEXT_1",
    kind: "text",
    props: { title: "raw" },
  };
}

function rawAutoElement() {
  const { template_ref: _t, template_version: _v, creative_recipe: _c, ...rest } = baseElement();
  return {
    ...rest,
    element_id: "RAW_AUTO",
    kind: "text",
    renderer_hint: "auto",
    props: { title: "raw auto" },
  };
}

function assemblyTimeline(overlayClips: unknown[]) {
  return {
    version: "2",
    project_id: "remotion-assembly-capability",
    created_at: "2026-08-23T00:00:00.000Z",
    sequence: {
      name: "Assembly",
      fps_num: 30,
      fps_den: 1,
      width: 640,
      height: 360,
      start_frame: 0,
      letterbox_policy: "none",
    },
    tracks: { video: [], audio: [], overlay: overlayClips.length > 0 ? [{
      track_id: "O1",
      kind: "overlay",
      clips: overlayClips,
    }] : [] },
    markers: [],
    provenance: {
      brief_path: "",
      blueprint_path: "",
      selects_path: "",
      compiler_version: "test",
    },
  };
}

function assemblyOverlayClip(clipId: string, element: Record<string, unknown>) {
  return {
    clip_id: clipId,
    segment_id: `SEG_${clipId}`,
    asset_id: "AST_BASE",
    src_in_us: 0,
    src_out_us: 1_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 30,
    role: "title",
    motivation: "test",
    beat_id: "B1",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    metadata: { content_element: element },
  };
}

function baseFrameElement(elementId: string, overrides?: (element: Record<string, unknown>) => void) {
  const element = baseElement();
  element.element_id = elementId;
  (element.creative_recipe as Record<string, unknown>).requires_base_frame = true;
  overrides?.(element);
  return element;
}

function writeTimelineWithElement(targetTimelinePath: string, element: Record<string, unknown>) {
  const timeline = timelineFixture();
  const clip = timeline.tracks.overlay[0].clips[0];
  (clip.metadata as Record<string, unknown>).content_element = element;
  fs.writeFileSync(targetTimelinePath, JSON.stringify(timeline));
}

function timelineFixture() {
  return {
    version: "2",
    project_id: "remotion-layer",
    created_at: "2026-07-24T00:00:00.000Z",
    sequence: {
      name: "Layer",
      fps_num: 30_000,
      fps_den: 1_001,
      width: 640,
      height: 360,
      start_frame: 0,
      letterbox_policy: "none",
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "BASE",
          segment_id: "SEG_BASE",
          asset_id: "AST_BASE",
          src_in_us: 0,
          src_out_us: 2_002_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 60,
          role: "dialogue",
          motivation: "test",
          beat_id: "B1",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }],
      audio: [],
      overlay: [{
        track_id: "O1",
        kind: "overlay",
        clips: [{
          clip_id: "TITLE_CLIP",
          segment_id: "SEG_TITLE",
          asset_id: "AST_BASE",
          src_in_us: 0,
          src_out_us: 1_001_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 30,
          role: "title",
          motivation: "test",
          beat_id: "B1",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
          metadata: {
            content_element: {
              version: "content-element/v1",
              element_id: "TITLE_1",
              kind: "template",
              template_ref: "vos:content.title-card/v1",
              template_version: "1.0.0",
              props: { title: "再利用できる演出" },
              layout: {
                anchor: "top_center",
                x: 0,
                y: 0,
                scale: 1,
                rotation_deg: 0,
                opacity: 1,
                safe_area: true,
                z_index: 100,
              },
              renderer_hint: "remotion",
              creative_recipe: {
                version: "creative-recipe/v1",
                reuse_scope: "brand",
                authoring_surface: "typed_component",
                layer_mode: "alpha_overlay",
                composite_stage: "under_caption",
                requires_base_frame: false,
              },
            },
          },
        }],
      }],
    },
    markers: [],
    provenance: {
      brief_path: "",
      blueprint_path: "",
      selects_path: "",
      compiler_version: "test",
    },
  };
}

function multiElementTimeline(count: number, options: { sameZIndex?: boolean } = {}) {
  const value = timelineFixture();
  value.tracks.overlay[0].clips = Array.from({ length: count }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    const clip = structuredClone(timelineFixture().tracks.overlay[0].clips[0]);
    clip.clip_id = `TITLE_CLIP_${ordinal}`;
    clip.segment_id = `SEG_TITLE_${ordinal}`;
    clip.timeline_in_frame = index;
    const element = clip.metadata.content_element;
    element.element_id = `TITLE_${ordinal}`;
    element.props = { title: `title ${ordinal}` };
    element.layout.z_index = options.sameZIndex ? 100 : 100 + index;
    return clip;
  });
  return value;
}
