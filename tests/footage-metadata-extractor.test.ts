import { describe, expect, it } from "vitest";
import {
  extractCameraMotion,
  extractEditorialObservation,
  extractSceneShotTake,
  extractShotScale,
} from "../runtime/artifacts/footage-metadata-extractor.js";

describe("footage metadata extractor", () => {
  it("extracts unified camera motion, direction, and stability terms", () => {
    expect(extractCameraMotion("The camera pans to the right across the market.")).toMatchObject({
      camera_motion_type: "pan",
      camera_motion_direction: "ltr",
      motion_confidence: 0.65,
    });
    expect(extractCameraMotion("Camera tilts down slowly to the table.")).toMatchObject({
      camera_motion_type: "tilt",
      camera_motion_direction: "down",
    });
    expect(extractCameraMotion("A shaky handheld camera follows the subject.")).toMatchObject({
      camera_motion_type: "tracking",
      camera_stability: "shaky",
    });
    expect(extractCameraMotion("Static shot; the camera remains stationary.")).toMatchObject({
      camera_motion_type: "static",
      camera_motion_direction: "none",
      camera_stability: "stable",
    });
  });

  it("defaults ambiguous Marlin prose to unknown instead of concrete labels", () => {
    expect(extractCameraMotion("The child follows the path through the forest.")).toMatchObject({
      camera_motion_type: "unknown",
      camera_motion_direction: "unknown",
      camera_stability: "unknown",
    });
    expect(extractShotScale("ordinary activity with no scale cue")).toBe("unknown");
  });

  it("extracts unified shot scale from explicit description phrases", () => {
    expect(extractShotScale("close-up of a face")).toBe("close");
    expect(extractShotScale("A person's hand turns the dial")).toBe("detail");
    expect(extractShotScale("wide shot establishing view of the river")).toBe("wide");
    expect(extractShotScale("wide angle lens view of the room")).toBe("unknown");
    expect(extractShotScale("medium shot from the waist up")).toBe("medium");
    expect(extractShotScale("head to toe full body framing")).toBe("medium_wide");
  });

  it("parses configured-production filename patterns as strings", () => {
    expect(extractSceneShotTake("NINJAV_S001_S002_T084.MOV")).toMatchObject({
      scene_number: "001",
      shot_number: "002",
      take_number: "084",
      source: "filename_parser",
    });
    expect(extractSceneShotTake("A001_20260619_143015_C0007.mov")).toMatchObject({
      scene_number: null,
      shot_number: null,
      take_number: "0007",
      card_id: "A001",
      clip_number: "0007",
    });
  });

  it("extracts GoPro and DJI clip numbers without inventing scene or shot", () => {
    expect(extractSceneShotTake("GOPR0123.MP4")).toMatchObject({
      scene_number: null,
      shot_number: null,
      take_number: "0123",
      clip_number: "0123",
    });
    expect(extractSceneShotTake("GH0456.MP4")).toMatchObject({
      scene_number: null,
      shot_number: null,
      take_number: "0456",
      clip_number: "0456",
    });
    expect(extractSceneShotTake("GX0789.MP4")).toMatchObject({
      scene_number: null,
      shot_number: null,
      take_number: "0789",
      clip_number: "0789",
    });
    expect(extractSceneShotTake("DJI_0075.MOV")).toMatchObject({
      scene_number: null,
      shot_number: null,
      take_number: "0075",
      clip_number: "0075",
    });
  });

  it("extracts only top-level canonical observation values and keeps unknown out of index text", () => {
    const extracted = extractEditorialObservation({
      status: "partial",
      visual_tags: ["title_card"],
      camera_motion_direction: "right",
      shot_scale: "unknown",
      text_presence: "present",
      confidence: {
        direction: { score: 0.91, evidence_refs: ["frame:right"] },
        framing: { score: 0.72, evidence_refs: ["frame:scale"] },
      },
      evidence: [{ evidence_ref: "frame:right" }],
      producer_snapshots: {
        grounded_vlm: {
          values: { camera_motion_direction: "left", shot_scale: "close_up" },
        },
      },
    });

    expect(extracted.values).toMatchObject({
      visual_tags: ["title_card"],
      camera_motion_direction: "right",
      shot_scale: "unknown",
      text_presence: "present",
    });
    expect(extracted.field_confidence.camera_motion_direction).toBe(0.91);
    expect(extracted.evidence_terms).toContain("editorial_observation.shot_scale=unknown");
    expect(extracted.index_terms.join(" ")).not.toContain("unknown");
    expect(extracted.index_terms.join(" ")).not.toContain("close_up");
  });
});
