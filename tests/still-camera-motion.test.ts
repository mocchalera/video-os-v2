import { describe, expect, it } from "vitest";
import {
  STILL_CAMERA_MOTION_DEFAULT_INTENSITY,
  STILL_CAMERA_MOTION_MAX_INTENSITY,
  STILL_CAMERA_MOTION_MIN_INTENSITY,
  buildStillVerticalStaticFilter,
  cameraMotionRemotionTransform,
  cameraMotionTrajectory,
  cameraWindowState,
  resolveStillCameraMotion,
  resolveVerticalStillComposition,
  sanitizeStillCameraMotionIntent,
  smoothstepEase,
  type StillCameraMotionPreset,
} from "../runtime/render/camera-motion.js";
import { resolveStillRenderMotion } from "../runtime/render/assembler.js";
import {
  resolveStillDurationPolicy,
  resolveStillImageHold,
} from "../runtime/artifacts/still-image-policy.js";

function plan(preset: StillCameraMotionPreset, frames: number, extra: Record<string, unknown> = {}) {
  return resolveStillCameraMotion({ preset, ...extra }, frames);
}

describe("still camera motion plan resolution (still-camera-motion/v1)", () => {
  it("resolves a clamped, provenance-carried plan synchronized to the hold frame count", () => {
    const resolved = resolveStillCameraMotion({ preset: "push_in" }, 90);
    expect(resolved).toEqual({
      preset: "push_in",
      easing: "smoothstep",
      intensity: STILL_CAMERA_MOTION_DEFAULT_INTENSITY,
      frame_count: 90,
      policy: "still-camera-motion/v1",
    });
  });

  it("clamps intensity into the supported band and records the clamped value", () => {
    expect(resolveStillCameraMotion({ preset: "push_in", intensity: 0.9 }, 30).intensity)
      .toBe(STILL_CAMERA_MOTION_MAX_INTENSITY);
    expect(resolveStillCameraMotion({ preset: "push_in", intensity: 0.001 }, 30).intensity)
      .toBe(STILL_CAMERA_MOTION_MIN_INTENSITY);
  });

  it("fails closed on invalid presets, easings, intensities, and frame counts", () => {
    expect(() => resolveStillCameraMotion({ preset: "ken_burns_zoom" }, 30))
      .toThrow(/still_camera_motion_invalid_preset/);
    expect(() => resolveStillCameraMotion({ preset: "push_in", easing: "bounce" }, 30))
      .toThrow(/still_camera_motion_invalid_easing/);
    expect(() => resolveStillCameraMotion({ preset: "push_in", intensity: "strong" }, 30))
      .toThrow(/still_camera_motion_invalid_intensity/);
    expect(() => resolveStillCameraMotion({ preset: "push_in" }, 0))
      .toThrow(/still_camera_motion_frame_count_invalid/);
    // metadata-only motion (claim without plan) is rejected
    expect(() => resolveStillCameraMotion(undefined, 30))
      .toThrow(/still_camera_motion_metadata_without_plan/);
  });

  it("sanitizes valid intents and rejects authored-but-invalid blocks", () => {
    expect(sanitizeStillCameraMotionIntent(undefined)).toBeUndefined();
    expect(sanitizeStillCameraMotionIntent({ preset: "tilt_down" })).toEqual({ preset: "tilt_down" });
    expect(() => sanitizeStillCameraMotionIntent({ preset: 42 })).toThrow(/still_camera_motion_invalid_preset/);
    expect(() => sanitizeStillCameraMotionIntent("push_in")).toThrow(/still_camera_motion_invalid/);
  });
});

describe("duration-synchronized easing", () => {
  it("starts exactly settled and completes exactly on the last displayed frame", () => {
    for (const easing of ["smoothstep", "linear"] as const) {
      for (const preset of ["push_in", "pull_out", "horizontal_tracking", "tilt_down", "diagonal_drift", "pan_zoom"] as const) {
        const p = plan(preset, 45, { easing });
        const trajectory = cameraMotionTrajectory(p);
        expect(trajectory).toHaveLength(45);
        // zoom endpoints prove completion within the displayed seconds
        if (preset === "push_in") {
          expect(trajectory[0].zoom).toBeCloseTo(1, 12);
          expect(trajectory[44].zoom).toBeCloseTo(1 + p.intensity, 12);
        }
        if (preset === "pull_out") {
          expect(trajectory[0].zoom).toBeCloseTo(1 + p.intensity, 12);
          expect(trajectory[44].zoom).toBeCloseTo(1, 12);
        }
        if (preset === "horizontal_tracking") {
          expect(trajectory[0].centerX).toBeLessThan(0.5);
          expect(trajectory[44].centerX).toBeCloseTo(0.5 + (0.5 - trajectory[0].centerX), 12);
        }
        if (preset === "tilt_down") {
          expect(trajectory[0].centerY).toBeLessThan(0.5);
          expect(trajectory[44].centerY).toBeCloseTo(0.5 + (0.5 - trajectory[0].centerY), 12);
        }
        if (preset === "diagonal_drift") {
          expect(trajectory[0].centerX).toBeLessThan(0.5);
          expect(trajectory[44].centerX).toBeGreaterThan(0.5);
          expect(trajectory[44].centerY).toBeGreaterThan(0.5);
        }
        if (preset === "pan_zoom") {
          expect(trajectory[0].zoom).toBeCloseTo(1, 12);
          expect(trajectory[44].zoom).toBeCloseTo(1 + p.intensity, 12);
          expect(trajectory[0].centerX).toBeCloseTo(0.5, 12);
          expect(trajectory[44].centerX).toBeGreaterThan(0.5);
          expect(trajectory[0].centerY).toBeCloseTo(0.5, 12);
        }
      }
    }
  });

  it("applies smoothstep 3t²−2t³ with zero end derivatives", () => {
    expect(smoothstepEase(0)).toBe(0);
    expect(smoothstepEase(1)).toBe(1);
    expect(smoothstepEase(0.5)).toBeCloseTo(0.5, 12);
    // zero slope at both ends: first and last eased steps are the smallest
    const steps: number[] = [];
    for (let i = 1; i < 45; i++) steps.push(smoothstepEase(i / 44) - smoothstepEase((i - 1) / 44));
    expect(steps[0]).toBeLessThan(steps[10]);
    expect(steps[steps.length - 1]).toBeLessThan(steps[20]);
    for (const step of steps) expect(step).toBeGreaterThanOrEqual(0); // monotonic
  });

  it("keeps trajectories monotonic and inside the valid window for every preset", () => {
    for (const preset of ["push_in", "pull_out", "horizontal_tracking", "tilt_down", "diagonal_drift", "pan_zoom"] as const) {
      const p = plan(preset, 60, { intensity: 0.2 });
      const trajectory = cameraMotionTrajectory(p);
      for (const state of trajectory) {
        expect(state.zoom).toBeGreaterThanOrEqual(1);
        // window (1/z of base view) must stay inside the base view
        expect(state.centerX - 1 / (2 * state.zoom)).toBeGreaterThanOrEqual(-1e-12);
        expect(state.centerX + 1 / (2 * state.zoom)).toBeLessThanOrEqual(1 + 1e-12);
        expect(state.centerY - 1 / (2 * state.zoom)).toBeGreaterThanOrEqual(-1e-12);
        expect(state.centerY + 1 / (2 * state.zoom)).toBeLessThanOrEqual(1 + 1e-12);
      }
      const zooms = trajectory.map((s) => s.zoom);
      const diffs = zooms.slice(1).map((z, i) => z - zooms[i]);
      for (const d of diffs) expect(Math.sign(d) === Math.sign(diffs[0]) || d === 0).toBe(true);
    }
  });

  it("plans sub-0.001px float64 steps: coordinates survive below the granularity contract", () => {
    const p = plan("horizontal_tracking", 300, { intensity: 0.02 });
    const trajectory = cameraMotionTrajectory(p);
    const width = 1080;
    const screenX = (s: { centerX: number; zoom: number }) => (s.centerX - 0.5) * s.zoom * width;
    const steps = trajectory.slice(1).map((s, i) => Math.abs(screenX(s) - screenX(trajectory[i])));
    // the smallest eased step is a distinct float64 value below 0.001 output
    // px — the render path must carry these coordinates through unrounded
    expect(Math.min(...steps)).toBeGreaterThan(0);
    expect(Math.min(...steps)).toBeLessThan(0.001);
    // smoothstep's palindromic step profile yields mirrored duplicates, but a
    // quantizing renderer would collapse this to a tiny lattice: continuity
    // keeps the vast majority of the 299 steps pairwise distinct
    expect(new Set(steps).size).toBeGreaterThan(steps.length / 2);
  });

  it("produces identical trajectories for identical plans (determinism)", () => {
    const a = cameraMotionTrajectory(plan("diagonal_drift", 33, { intensity: 0.15 }));
    const b = cameraMotionTrajectory(resolveStillCameraMotion({ preset: "diagonal_drift", intensity: 0.15 }, 33));
    expect(a).toEqual(b);
  });

  it("plans simultaneous horizontal pan plus zoom inside the valid window", () => {
    const trajectory = cameraMotionTrajectory(plan("pan_zoom", 60, { intensity: 0.3 }));
    expect(trajectory.some((state, index) => index > 0 && state.zoom > 1 && state.centerX !== 0.5)).toBe(true);
    expect(trajectory.at(-1)).toMatchObject({ zoom: 1.3 });
    const featureScreenX = trajectory.map((state) => (0.25 - state.centerX) * state.zoom);
    const cumulativeTravel = featureScreenX.map((value) => value - featureScreenX[0]);
    // A left-of-center feature must never first travel right while the pan
    // range grows. This cumulative assertion fails the old expanding-range
    // interpolation even though each individual reverse step is tiny.
    expect(Math.max(...cumulativeTravel)).toBeLessThanOrEqual(1e-12);
    expect(trajectory[0]).toMatchObject({ zoom: 1, centerX: 0.5, centerY: 0.5 });
    expect(trajectory.at(-1)!.centerX).toBeCloseTo(0.5 + (1 - 1 / 1.3) / 2, 12);
    for (const state of trajectory) {
      expect(state.centerX - 1 / (2 * state.zoom)).toBeGreaterThanOrEqual(-1e-12);
      expect(state.centerX + 1 / (2 * state.zoom)).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

describe("Float64 render contract (NumPy Lanczos worker lane)", () => {
  it("serializes the trajectory through JSON at full float64 precision", () => {
    // The worker receives the trajectory as JSON; the round-trip must be
    // lossless so rendered coordinates equal the planner's doubles exactly.
    for (const preset of ["push_in", "horizontal_tracking", "diagonal_drift"] as const) {
      const trajectory = cameraMotionTrajectory(plan(preset, 37, { intensity: 0.23 }));
      const roundTripped = JSON.parse(JSON.stringify(trajectory));
      expect(roundTripped).toEqual(trajectory);
    }
  });

  it("rejects metadata-only motion claims and mode/plan mismatches before rendering", () => {
    // claim without plan
    expect(() => resolveStillRenderMotion({ motion_mode: "camera_motion" }, {
      width: 1080, height: 1080, frameCount: 30,
    })).toThrow(/still_camera_motion_metadata_without_plan/);
    // plan without the matching mode
    expect(() => resolveStillRenderMotion({
      motion_mode: "static",
      camera_motion: { preset: "push_in", easing: "smoothstep", intensity: 0.1, frame_count: 30, policy: "still-camera-motion/v1" },
    }, { width: 1080, height: 1080, frameCount: 30 })).toThrow(/still_camera_motion_mode_mismatch/);
    // a valid claim re-synchronizes the plan to the displayed frame count
    const resolved = resolveStillRenderMotion({
      motion_mode: "camera_motion",
      camera_motion: { preset: "push_in", easing: "smoothstep", intensity: 0.1, frame_count: 90, policy: "still-camera-motion/v1" },
    }, { width: 1080, height: 1080, frameCount: 45 });
    expect(resolved.motion).toMatchObject({ preset: "push_in", frame_count: 45 });
  });

  it("preserves the legacy cover default for motion while static stills contain", () => {
    const motion = resolveStillRenderMotion({
      motion_mode: "camera_motion",
      camera_motion: {
        preset: "push_in",
        easing: "smoothstep",
        intensity: 0.1,
        frame_count: 24,
        policy: "still-camera-motion/v1",
      },
    }, { width: 1080, height: 1920, frameCount: 24 });
    expect(motion.fitMode).toBe("cover");
    expect(resolveStillRenderMotion(undefined, {
      width: 1080, height: 1920, frameCount: 24,
    }).fitMode).toBe("contain");
  });

  it("builds the static vertical blur-backdrop composite graph with the registered Y anchor", () => {
    const composition = resolveVerticalStillComposition(1080, 1920);
    expect(composition).toMatchObject({ kind: "vertical_blur_backdrop", width: 1080, height: 1920, fgSize: 1080, fgY: 320 });
    const filterComplex = buildStillVerticalStaticFilter(composition!);
    expect(filterComplex).toContain("[0:v]split=2[bgsrc][fgsrc]");
    expect(filterComplex).toContain("gblur=sigma=28:steps=2");
    expect(filterComplex).toContain("overlay=0:320");
    expect(filterComplex.endsWith("[vout]")).toBe(true);
    // no zoompan anywhere: the rejected integer-quantization lane is gone
    expect(filterComplex).not.toContain("zoompan");
  });
});

describe("automatic vertical composition geometry", () => {
  it("resolves the canonical 1080x1080 foreground at Y=320 for 1080x1920", () => {
    expect(resolveVerticalStillComposition(1080, 1920)).toMatchObject({ fgSize: 1080, fgY: 320, blurSigma: 28 });
  });

  it("does not engage for landscape, square, or non-9:16 canvases unless forced", () => {
    expect(resolveVerticalStillComposition(1920, 1080)).toBeNull();
    expect(resolveVerticalStillComposition(1080, 1080)).toBeNull();
    expect(resolveVerticalStillComposition(1080, 1350)).toBeNull();
    // explicit authoring override wins in both directions
    expect(resolveVerticalStillComposition(1080, 1920, "fit")).toBeNull();
    expect(resolveVerticalStillComposition(1080, 1350, "vertical_blur_backdrop"))
      .toMatchObject({ fgSize: 1080, fgY: 225 });
  });
});

describe("still-image policy carries executable camera motion", () => {
  const briefPolicy = {
    still_image_intent: {
      min_hold_sec: 1,
      default_hold_sec: 3,
      max_hold_sec: 10,
      camera_motion: { preset: "push_in", easing: "smoothstep", intensity: 0.12 },
    },
  } as const;

  it("stamps a camera_motion plan with frame_count equal to the resolved hold", () => {
    const policy = resolveStillDurationPolicy(briefPolicy, undefined, 30, 1);
    const metadata = resolveStillImageHold({ still_image: {} }, policy, 300);
    expect(metadata.motion_mode).toBe("camera_motion");
    expect(metadata.camera_motion).toMatchObject({
      preset: "push_in",
      easing: "smoothstep",
      intensity: 0.12,
      frame_count: 90,
      policy: "still-camera-motion/v1",
    });
    // legacy pending ken-burns contract is not engaged when motion executes
    expect(metadata.requested_motion_mode).toBeUndefined();
    expect(metadata.motion_status).toBeUndefined();
  });

  it("keeps the pending_EYE-070C2B contract for subtle_ken_burns without camera motion", () => {
    const policy = resolveStillDurationPolicy({
      still_image_intent: { motion_mode: "subtle_ken_burns" },
    }, undefined, 24, 1);
    const metadata = resolveStillImageHold({ still_image: {} }, policy, 96);
    expect(metadata.motion_mode).toBe("static");
    expect(metadata.requested_motion_mode).toBe("subtle_ken_burns");
    expect(metadata.motion_status).toBe("pending_EYE-070C2B");
    expect(metadata.camera_motion).toBeUndefined();
  });

  it("propagates policy-level camera motion when the candidate does not author one", () => {
    const policy = resolveStillDurationPolicy({}, {
      still_image_intent: { camera_motion: { preset: "diagonal_drift" } },
    }, 24, 1);
    const metadata = resolveStillImageHold({ still_image: {} }, policy, 48);
    expect(metadata.motion_mode).toBe("camera_motion");
    expect(metadata.camera_motion).toMatchObject({ preset: "diagonal_drift", frame_count: 48 });
  });

  it("fails closed on invalid authored presets instead of rendering static", () => {
    expect(() => resolveStillDurationPolicy({}, {
      still_image_intent: { camera_motion: { preset: "spin_360" } as never },
    }, 24, 1)).toThrow(/still_camera_motion_invalid_preset/);
  });

  it("carries the authored composition override into clip metadata", () => {
    const policy = resolveStillDurationPolicy({
      still_image_intent: { composition: "fit" },
    }, undefined, 24, 1);
    const metadata = resolveStillImageHold({ still_image: {} }, policy, 48);
    expect(metadata.composition).toBe("fit");
  });
});

describe("remotion transform parity with the shared planner", () => {
  it("maps the CSS transform back to the exact planned window state", () => {
    const p = plan("horizontal_tracking", 40, { intensity: 0.25 });
    const width = 1080;
    const height = 1920;
    for (let frame = 0; frame < p.frame_count; frame++) {
      const state = cameraWindowState(p, frame);
      const { zoom, translateX, translateY } = cameraMotionRemotionTransform(p, frame, { width, height });
      expect(zoom).toBe(state.zoom);
      // translate then scale about center: c = 0.5 − t/(z·size)
      expect(0.5 - translateX / (zoom * width)).toBeCloseTo(state.centerX, 12);
      expect(0.5 - translateY / (zoom * height)).toBeCloseTo(state.centerY, 12);
    }
  });
});
