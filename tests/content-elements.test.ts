import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { generateHyperFramesHTML } from "../runtime/content/hyperframes-html.js";
import { normalizeOverlayClipContent } from "../runtime/content/normalize.js";
import { buildContentRenderPlan } from "../runtime/content/render-plan.js";
import type { ContentElementV1 } from "../runtime/content/types.js";
import { validateContentElement } from "../runtime/content/validation.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): (value: unknown) => boolean;
};

function sectionElement(overrides: Partial<ContentElementV1> = {}): ContentElementV1 {
  return {
    version: "content-element/v1",
    element_id: "section_01",
    kind: "template",
    template_ref: "vos:content.section-label/v1",
    template_version: "1.0.0",
    props: { title: "会社が変わったこと" },
    layout: {
      anchor: "top_left",
      x: 0,
      y: 0,
      scale: 1,
      rotation_deg: 0,
      opacity: 1,
      safe_area: true,
      z_index: 100,
    },
    animation: { in: { preset: "fade-rise", duration_frames: 12 } },
    renderer_hint: "auto",
    ...overrides,
  };
}

describe("content-element/v1 validation", () => {
  it("compiles the standalone JSON Schema and accepts the runtime fixture", () => {
    const schema = JSON.parse(readFileSync(path.resolve("schemas/content-element.schema.json"), "utf8")) as object;
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    expect(validate(sectionElement())).toBe(true);
  });

  it("accepts an allow-listed section label", () => {
    expect(validateContentElement(sectionElement())).toEqual({
      ok: true,
      issues: [],
      value: sectionElement(),
    });
  });

  it.each([
    "/Users/operator/secret.png",
    "file:///tmp/secret.png",
    "https://example.com/logo.png",
    "../assets/logo.png",
  ])("rejects unsafe nested asset references: %s", (src) => {
    const result = validateContentElement(sectionElement({
      props: { title: "安全性", nested: { src } },
    }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "unsafe_asset_reference")).toBe(true);
  });

  it("requires logo assets to use a contained asset_id", () => {
    const result = validateContentElement(sectionElement({
      template_ref: "vos:content.logo-bug/v1",
      props: { asset_id: "../logo.png" },
    }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path === "props.asset_id")).toBe(true);
  });

  it("rejects unknown template props before rendering", () => {
    const result = validateContentElement(sectionElement({ props: { title: "見出し", color: "red" } }));
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "props.color", code: "invalid_template_props" }),
    ]));
  });

  it.each([
    ["vos:content.title-card/v1", { title: "本気のビートボックス" }, "remotion"],
    ["vos:content.hook-title/v1", { title: "AIに頼んだ結果" }, "remotion"],
    ["vos:content.cta-card/v1", { headline: "次の一歩を始める", action: "無料相談へ", brand: "VIDEO OS" }, "remotion"],
    ["vos:content.emphasis-word/v1", { text: "BOOM" }, "remotion"],
  ] as const)("accepts canonical Remotion template %s", (templateRef, props, owner) => {
    const element = sectionElement({ template_ref: templateRef, props });
    const validation = validateContentElement(element);
    expect(validation.ok).toBe(true);
    const normalized = normalizeOverlayClipContent({
      clip_id: "REMOTION_CANONICAL",
      metadata: { content_element: element },
    });
    expect(normalized.renderer_owner).toBe(owner);
  });
});

describe("legacy overlay normalization", () => {
  it("maps chapter-kicker to one HyperFrames-owned section label", () => {
    const result = normalizeOverlayClipContent({
      clip_id: "OVL_001",
      metadata: {
        overlay: {
          overlay_id: "OVL_001",
          text: "経理をAI基準で作り直す",
          styling_class: "vos:overlay.chapter-kicker",
          anchor: "top-left",
        },
      },
    });

    expect(result.source).toBe("legacy");
    expect(result.renderer_owner).toBe("hyperframes");
    expect(result.element?.template_ref).toBe("vos:content.section-label/v1");
    expect(result.element?.props).toEqual({ title: "経理をAI基準で作り直す" });
  });

  it("keeps title-card on Remotion without creating a duplicate element", () => {
    const result = normalizeOverlayClipContent({
      clip_id: "OVL_002",
      metadata: { overlay: { text: "AX-1", styling_class: "vos:overlay.title-card" } },
    });
    expect(result).toMatchObject({
      element: null,
      renderer_owner: "remotion",
      source: "legacy-remotion",
      issues: [],
    });
  });

  it("keeps hook-title on the explicit Remotion hook renderer", () => {
    const result = normalizeOverlayClipContent({
      clip_id: "OVL_HOOK",
      metadata: { overlay: { text: "AIに頼んだ結果", styling_class: "vos:overlay.hook-title" } },
    });
    expect(result).toMatchObject({ renderer_owner: "remotion", source: "legacy-remotion", issues: [] });
  });

  it("fails unknown legacy styling classes instead of changing their look", () => {
    const result = normalizeOverlayClipContent({
      clip_id: "OVL_003",
      metadata: { overlay: { text: "Unknown", styling_class: "vos:overlay.unknown" } },
    });
    expect(result.renderer_owner).toBeNull();
    expect(result.issues[0]?.message).toContain("Unknown legacy styling_class");
  });
});

describe("deterministic HyperFrames HTML", () => {
  it("escapes authored text and emits a local-only CSP", () => {
    const html = generateHyperFramesHTML({
      composition_id: "content_spike",
      width: 1920,
      height: 1080,
      fps: 30,
      duration_frames: 150,
      elements: [{
        element: sectionElement({ props: { title: '<script src="https://bad.example/x.js">危険</script>' } }),
        start_frame: 0,
        duration_frames: 150,
      }],
    });

    expect(html).not.toContain("<script src=");
    expect(html).toContain("&lt;script src=&quot;https://bad.example/x.js&quot;&gt;");
    expect(html).toContain("connect-src &#39;none&#39;");
    expect(html).toContain('data-renderer-owner="hyperframes"');
    expect(html).toContain('url("./fonts/NotoSansJP-Variable.ttf")');
    expect(html).not.toContain("Arial Unicode MS");
  });

  it("is byte-stable and sorts elements independently of input order", () => {
    const question = sectionElement({
      element_id: "question_01",
      template_ref: "vos:content.question-card/v1",
      props: { question: "なぜ経営者本人が学ぶ必要があるのか？", label: "QUESTION" },
      layout: { ...sectionElement().layout, anchor: "center", z_index: 110 },
    });
    const first = generateHyperFramesHTML({
      composition_id: "stable",
      width: 1920,
      height: 1080,
      fps: 30,
      duration_frames: 150,
      elements: [
        { element: question, start_frame: 60, duration_frames: 90 },
        { element: sectionElement(), start_frame: 0, duration_frames: 60 },
      ],
    });
    const second = generateHyperFramesHTML({
      composition_id: "stable",
      width: 1920,
      height: 1080,
      fps: 30,
      duration_frames: 150,
      elements: [
        { element: sectionElement(), start_frame: 0, duration_frames: 60 },
        { element: question, start_frame: 60, duration_frames: 90 },
      ],
    });
    expect(first).toBe(second);
    expect(first.indexOf('id="section_01"')).toBeLessThan(first.indexOf('id="question_01"'));
  });

  it("renders lower thirds as outlined type without a background panel", () => {
    const lowerThird = sectionElement({
      element_id: "speaker_sakamoto",
      template_ref: "vos:content.lower-third/v1",
      props: { name: "坂本" },
      layout: { ...sectionElement().layout, anchor: "bottom_left" },
    });
    const html = generateHyperFramesHTML({
      composition_id: "lower_third",
      width: 1080,
      height: 1920,
      fps: 30,
      duration_frames: 90,
      elements: [{ element: lowerThird, start_frame: 0, duration_frames: 90 }],
    });

    expect(html).toContain("坂本");
    expect(html).toContain("-webkit-text-stroke");
    expect(html).toContain("lower-third-name");
    expect(html).not.toContain("lower-third-panel");
  });
});

describe("content render ownership plan", () => {
  it("assigns each overlay to exactly one renderer", () => {
    const clipBase = {
      segment_id: "SEG",
      asset_id: "AST",
      src_in_us: 0,
      src_out_us: 1_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 30,
      role: "overlay",
      motivation: "test",
      beat_id: "B1",
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
    };
    const plan = buildContentRenderPlan({
      sequence: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 },
      tracks: {
        video: [],
        audio: [],
        overlay: [{
          track_id: "V3",
          kind: "overlay",
          clips: [
            {
              ...clipBase,
              clip_id: "HF",
              metadata: { overlay: { text: "AIビートボックス", styling_class: "vos:overlay.chapter-kicker" } },
            },
            {
              ...clipBase,
              clip_id: "REMOTION",
              metadata: { overlay: { text: "AIが本気を出す", styling_class: "vos:overlay.title-card" } },
            },
          ],
        }],
      },
    });

    expect(plan.hyperframes_elements.map((entry) => entry.element.element_id)).toEqual(["HF"]);
    expect(plan.remotion_clip_ids).toEqual(["REMOTION"]);
    expect(plan.issues).toEqual([]);
  });
});
