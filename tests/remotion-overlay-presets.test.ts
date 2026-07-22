import { describe, expect, it } from "vitest";
import {
  getOverlayText,
  overlayPresets,
  resolveOverlayPreset,
} from "../runtime/render/remotion/styles/overlay-presets.js";

const PRESET_IDS = [
  "vos:overlay.title-card",
  "vos:overlay.hook-title",
  "vos:overlay.cta-card",
  "vos:overlay.lower-third",
  "vos:overlay.chapter-kicker",
  "vos:overlay.location-tag",
  "vos:overlay.credit",
  "vos:overlay.emphasis-word",
] as const;

describe("Remotion overlay preset registry", () => {
  it("resolves the title-card preset", () => {
    const preset = resolveOverlayPreset("vos:overlay.title-card");

    expect(preset).not.toBeNull();
    expect(preset?.id).toBe("vos:overlay.title-card");
  });

  it("keeps legacy unnamespaced authoring compatible", () => {
    expect(resolveOverlayPreset("title-card")?.id).toBe("vos:overlay.title-card");
  });

  it("returns null for unknown and legacy styling classes", () => {
    expect(resolveOverlayPreset("vos:overlay.unknown")).toBeNull();
    expect(resolveOverlayPreset("default")).toBeNull();
  });

  it("contains the registered vos:overlay.* presets with render functions", () => {
    expect(overlayPresets.size).toBe(8);

    for (const id of PRESET_IDS) {
      const preset = resolveOverlayPreset(id);
      expect(preset).not.toBeNull();
      expect(preset?.id).toBe(id);
      expect(typeof preset?.render).toBe("function");
    }
  });
});

describe("getOverlayText", () => {
  it("prefers metadata.overlay.text over legacy text fields", () => {
    expect(getOverlayText({ overlay: { text: "A" }, text: "B", overlay_text: "C" })).toBe("A");
  });

  it("falls back to metadata.text", () => {
    expect(getOverlayText({ text: "B", overlay_text: "C" })).toBe("B");
  });

  it("falls back to metadata.overlay_text", () => {
    expect(getOverlayText({ overlay_text: "C" })).toBe("C");
  });

  it("returns null when no supported text field exists", () => {
    expect(getOverlayText({})).toBeNull();
  });

  it("returns null for nullish metadata", () => {
    expect(getOverlayText(null)).toBeNull();
    expect(getOverlayText(undefined)).toBeNull();
  });
});
