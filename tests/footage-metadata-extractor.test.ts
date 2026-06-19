import { describe, expect, it } from "vitest";
import {
  extractCameraMotion,
  extractSceneShotTake,
  extractShotScale,
} from "../runtime/artifacts/footage-metadata-extractor.js";

describe("footage metadata extractor", () => {
  it("extracts camera motion and stability from Marlin-style descriptions", () => {
    expect(extractCameraMotion("The camera pans to the right across the market.")).toMatchObject({
      camera_motion: "pan_right",
      motion_direction: "right",
      motion_speed: "medium",
      stability: "stable",
    });
    expect(extractCameraMotion("Camera tilts down slowly to the table.")).toMatchObject({
      camera_motion: "tilt_down",
      motion_direction: "down",
      motion_speed: "slow",
    });
    expect(extractCameraMotion("A shaky handheld view follows the subject.")).toMatchObject({
      camera_motion: "tracking",
      stability: "shaky",
    });
    expect(extractCameraMotion("Static shot; the camera remains stationary.")).toMatchObject({
      camera_motion: "static",
      motion_direction: null,
      stability: "stable",
    });
  });

  it("extracts shot scale from description phrases", () => {
    expect(extractShotScale("close-up of a face")).toBe("closeup");
    expect(extractShotScale("A person's hand turns the dial")).toBe("detail");
    expect(extractShotScale("wide angle establishing view of the river")).toBe("wide");
    expect(extractShotScale("medium shot from the waist up")).toBe("medium");
    expect(extractShotScale("head to toe full body framing")).toBe("full");
    expect(extractShotScale("ordinary activity with no scale cue")).toBe("medium");
  });

  it("parses scene, shot, and take from Blackmagic-style filenames", () => {
    expect(extractSceneShotTake("NINJAV_S001_S002_T084.MOV")).toEqual({
      scene_number: 1,
      shot_number: 2,
      take_number: 84,
    });
    expect(extractSceneShotTake("A001_20260619_143015_C0007.mov")).toEqual({
      scene_number: 20260619,
      shot_number: 143015,
      take_number: 7,
    });
    expect(extractSceneShotTake("clip_C0012.mov", "2026-06-19T10:05:30Z")).toEqual({
      scene_number: 20260619,
      shot_number: 100530,
      take_number: 12,
    });
  });
});
