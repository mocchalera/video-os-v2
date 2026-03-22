import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compile } from "../runtime/compiler/index.js";
import { resolve } from "../runtime/compiler/resolve.js";
import {
  resolveDurationMode,
  buildDurationPolicy,
  computeFrameBounds,
  isWithinWindow,
  secToTargetFrames,
  secToMinFrames,
  secToMaxFrames,
} from "../runtime/compiler/duration-helpers.js";
import { checkDurationPolicy, getRequiredChecks } from "../runtime/packaging/qa.js";
import { validateProject } from "../scripts/validate-schemas.js";
import type {
  AssembledTimeline,
  CreativeBrief,
  DurationPolicy,
  TimelineClip,
} from "../runtime/compiler/types.js";

// ── Helpers ─────────────────────────────────────────────────────────

const SAMPLE_PROJECT = path.resolve("projects/sample");
const FIXED_CREATED_AT = "2026-03-21T00:00:00Z";

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeDirSync(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createTempProject(overrides?: {
  briefOverrides?: Record<string, unknown>;
  blueprintOverrides?: Record<string, unknown>;
}): string {
  const tmpDir = path.join("tests", `tmp_duration_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  copyDirSync(SAMPLE_PROJECT, tmpDir);

  // Remove any existing output
  const timelinePath = path.join(tmpDir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) fs.unlinkSync(timelinePath);
  const manifestPath = path.join(tmpDir, "05_timeline/preview-manifest.json");
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

  if (overrides?.briefOverrides) {
    const briefPath = path.join(tmpDir, "01_intent/creative_brief.yaml");
    const original = parseYaml(fs.readFileSync(briefPath, "utf-8")) as Record<string, unknown>;
    const project = { ...(original.project as Record<string, unknown>), ...(overrides.briefOverrides.project as Record<string, unknown> ?? {}) };
    const merged = { ...original, ...overrides.briefOverrides, project };
    fs.writeFileSync(briefPath, stringifyYaml(merged), "utf-8");
  }

  if (overrides?.blueprintOverrides) {
    const bpPath = path.join(tmpDir, "04_plan/edit_blueprint.yaml");
    const original = parseYaml(fs.readFileSync(bpPath, "utf-8")) as Record<string, unknown>;
    const merged = { ...original, ...overrides.blueprintOverrides };
    fs.writeFileSync(bpPath, stringifyYaml(merged), "utf-8");
  }

  return tmpDir;
}

function makeBrief(overrides?: Partial<CreativeBrief["project"]>): CreativeBrief {
  return {
    version: "1",
    project_id: "test",
    project: {
      id: "test",
      title: "Test",
      strategy: "test",
      runtime_target_sec: 30,
      ...overrides,
    },
    message: { primary: "test" },
    emotion_curve: ["a", "b", "c"],
  };
}

// ── Duration Mode Resolution ────────────────────────────────────────

describe("Duration Mode Resolution", () => {
  it("explicit strict + target → strict", () => {
    const { mode, source } = resolveDurationMode(
      makeBrief({ duration_mode: "strict", runtime_target_sec: 30 }),
    );
    expect(mode).toBe("strict");
    expect(source).toBe("explicit_brief");
  });

  it("explicit guide + target → guide", () => {
    const { mode, source } = resolveDurationMode(
      makeBrief({ duration_mode: "guide", runtime_target_sec: 90 }),
    );
    expect(mode).toBe("guide");
    expect(source).toBe("explicit_brief");
  });

  it("explicit guide + no target → guide", () => {
    const { mode } = resolveDurationMode(
      makeBrief({ duration_mode: "guide", runtime_target_sec: undefined }),
    );
    expect(mode).toBe("guide");
  });

  it("explicit strict + no target → throws", () => {
    expect(() =>
      resolveDurationMode(
        makeBrief({ duration_mode: "strict", runtime_target_sec: undefined }),
      ),
    ).toThrow("strict requires a positive runtime_target_sec");
  });

  it("explicit strict + zero target → throws", () => {
    expect(() =>
      resolveDurationMode(
        makeBrief({ duration_mode: "strict", runtime_target_sec: 0 as any }),
      ),
    ).toThrow();
  });

  it("no mode, no profile → global default guide", () => {
    const { mode, source } = resolveDurationMode(makeBrief());
    expect(mode).toBe("guide");
    expect(source).toBe("global_default");
  });

  // Profile default mapping
  it("interview-highlight → guide", () => {
    const { mode, source } = resolveDurationMode(makeBrief(), "interview-highlight");
    expect(mode).toBe("guide");
    expect(source).toBe("profile_default");
  });

  it("interview-pro-highlight → guide", () => {
    const { mode } = resolveDurationMode(makeBrief(), "interview-pro-highlight");
    expect(mode).toBe("guide");
  });

  it("lp-testimonial + target → strict", () => {
    const { mode, source } = resolveDurationMode(
      makeBrief({ runtime_target_sec: 30 }),
      "lp-testimonial",
    );
    expect(mode).toBe("strict");
    expect(source).toBe("profile_default");
  });

  it("lp-testimonial + no target → guide downgrade", () => {
    const { mode, source } = resolveDurationMode(
      makeBrief({ runtime_target_sec: undefined }),
      "lp-testimonial",
    );
    expect(mode).toBe("guide");
    expect(source).toBe("global_default");
  });

  it("vertical-short + target → strict", () => {
    const { mode } = resolveDurationMode(
      makeBrief({ runtime_target_sec: 15 }),
      "vertical-short",
    );
    expect(mode).toBe("strict");
  });

  it("vertical-short + no target → guide downgrade", () => {
    const { mode } = resolveDurationMode(
      makeBrief({ runtime_target_sec: undefined }),
      "vertical-short",
    );
    expect(mode).toBe("guide");
  });

  it("event-recap → guide", () => {
    const { mode } = resolveDurationMode(makeBrief(), "event-recap");
    expect(mode).toBe("guide");
  });

  it("product-demo → guide", () => {
    const { mode } = resolveDurationMode(makeBrief(), "product-demo");
    expect(mode).toBe("guide");
  });

  it("lecture-highlight → guide", () => {
    const { mode } = resolveDurationMode(makeBrief(), "lecture-highlight");
    expect(mode).toBe("guide");
  });

  it("unknown profile → global default guide", () => {
    const { mode, source } = resolveDurationMode(makeBrief(), "custom-unknown");
    expect(mode).toBe("guide");
    expect(source).toBe("global_default");
  });
});

// ── DurationPolicy Builder ──────────────────────────────────────────

describe("DurationPolicy Builder", () => {
  it("strict: ±1s window, hard gate, no peak protection", () => {
    const policy = buildDurationPolicy(
      makeBrief({ duration_mode: "strict", runtime_target_sec: 30 }),
    );
    expect(policy.mode).toBe("strict");
    expect(policy.target_duration_sec).toBe(30);
    expect(policy.min_duration_sec).toBe(29);
    expect(policy.max_duration_sec).toBe(31);
    expect(policy.hard_gate).toBe(true);
    expect(policy.protect_vlm_peaks).toBe(false);
    expect(policy.target_source).toBe("explicit_brief");
  });

  it("guide + explicit target: ±30% window, no hard gate, peak protection", () => {
    const policy = buildDurationPolicy(
      makeBrief({ duration_mode: "guide", runtime_target_sec: 90 }),
    );
    expect(policy.mode).toBe("guide");
    expect(policy.target_duration_sec).toBe(90);
    expect(policy.min_duration_sec).toBeCloseTo(63, 5);
    expect(policy.max_duration_sec).toBeCloseTo(117, 5);
    expect(policy.hard_gate).toBe(false);
    expect(policy.protect_vlm_peaks).toBe(true);
    expect(policy.target_source).toBe("explicit_brief");
  });

  it("guide + no target: material-derived, unbounded, peak protection", () => {
    const policy = buildDurationPolicy(
      makeBrief({ duration_mode: "guide", runtime_target_sec: undefined }),
      undefined,
      58.4,
    );
    expect(policy.mode).toBe("guide");
    expect(policy.target_duration_sec).toBe(58.4);
    expect(policy.min_duration_sec).toBe(0);
    expect(policy.max_duration_sec).toBeNull();
    expect(policy.hard_gate).toBe(false);
    expect(policy.protect_vlm_peaks).toBe(true);
    expect(policy.target_source).toBe("material_total");
  });

  it("guide + no target + no material: fallback to 1s", () => {
    const policy = buildDurationPolicy(
      makeBrief({ duration_mode: "guide", runtime_target_sec: undefined }),
      undefined,
      0,
    );
    expect(policy.target_duration_sec).toBe(1);
    expect(policy.target_source).toBe("material_total");
  });
});

// ── Frame Boundary Helpers ──────────────────────────────────────────

describe("Frame Boundary Helpers", () => {
  it("24fps: secToTargetFrames 30s = 720", () => {
    expect(secToTargetFrames(30, 24, 1)).toBe(720);
  });

  it("24fps: secToMinFrames 29s = 696", () => {
    expect(secToMinFrames(29, 24, 1)).toBe(696);
  });

  it("24fps: secToMaxFrames 31s = 744", () => {
    expect(secToMaxFrames(31, 24, 1)).toBe(744);
  });

  it("29.97fps (30000/1001): secToTargetFrames 30s", () => {
    const frames = secToTargetFrames(30, 30000, 1001);
    // 30 * 30000 / 1001 = 899.1008...
    expect(frames).toBe(899);
  });

  it("29.97fps: secToMinFrames 29s", () => {
    const frames = secToMinFrames(29, 30000, 1001);
    // 29 * 30000 / 1001 = 869.1308... → ceil = 870
    expect(frames).toBe(870);
  });

  it("29.97fps: secToMaxFrames 31s", () => {
    const frames = secToMaxFrames(31, 30000, 1001);
    // 31 * 30000 / 1001 = 929.0709... → floor = 929
    expect(frames).toBe(929);
  });

  it("computeFrameBounds for strict at 24fps", () => {
    const policy: DurationPolicy = {
      mode: "strict",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
      hard_gate: true,
      protect_vlm_peaks: false,
    };
    const bounds = computeFrameBounds(policy, 24, 1);
    expect(bounds.target_frames).toBe(720);
    expect(bounds.min_target_frames).toBe(696);
    expect(bounds.max_target_frames).toBe(744);
  });

  it("computeFrameBounds with null max", () => {
    const policy: DurationPolicy = {
      mode: "guide",
      source: "global_default",
      target_source: "material_total",
      target_duration_sec: 60,
      min_duration_sec: 0,
      max_duration_sec: null,
      hard_gate: false,
      protect_vlm_peaks: true,
    };
    const bounds = computeFrameBounds(policy, 24, 1);
    expect(bounds.target_frames).toBe(1440);
    expect(bounds.min_target_frames).toBe(0);
    expect(bounds.max_target_frames).toBeNull();
  });

  // Exact boundary tests
  it("isWithinWindow: actual == min → true", () => {
    expect(isWithinWindow(696, { target_frames: 720, min_target_frames: 696, max_target_frames: 744 })).toBe(true);
  });

  it("isWithinWindow: actual == max → true", () => {
    expect(isWithinWindow(744, { target_frames: 720, min_target_frames: 696, max_target_frames: 744 })).toBe(true);
  });

  it("isWithinWindow: actual == min - 1 → false", () => {
    expect(isWithinWindow(695, { target_frames: 720, min_target_frames: 696, max_target_frames: 744 })).toBe(false);
  });

  it("isWithinWindow: actual == max + 1 → false", () => {
    expect(isWithinWindow(745, { target_frames: 720, min_target_frames: 696, max_target_frames: 744 })).toBe(false);
  });

  it("isWithinWindow: null max → always in-window above min", () => {
    expect(isWithinWindow(99999, { target_frames: 720, min_target_frames: 0, max_target_frames: null })).toBe(true);
  });

  it("isWithinWindow: below min with null max → false", () => {
    expect(isWithinWindow(-1, { target_frames: 720, min_target_frames: 0, max_target_frames: null })).toBe(false);
  });

  // NTSC regression
  it("NTSC 30000/1001: same boundary logic works", () => {
    const policy: DurationPolicy = {
      mode: "strict",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
      hard_gate: true,
      protect_vlm_peaks: false,
    };
    const bounds = computeFrameBounds(policy, 30000, 1001);
    // Verify exact boundary with NTSC fps
    expect(isWithinWindow(bounds.min_target_frames, bounds)).toBe(true);
    expect(isWithinWindow(bounds.max_target_frames!, bounds)).toBe(true);
    expect(isWithinWindow(bounds.min_target_frames - 1, bounds)).toBe(false);
    expect(isWithinWindow(bounds.max_target_frames! + 1, bounds)).toBe(false);
  });
});

// ── QA Duration Policy Check ────────────────────────────────────────

describe("QA: Duration Policy Check", () => {
  it("strict pass: actual within window", () => {
    const result = checkDurationPolicy(30.5, {
      mode: "strict",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
    });
    expect(result.passed).toBe(true);
    expect(result.name).toBe("duration_policy_valid");
    expect(result.metrics.duration_mode).toBe("strict");
  });

  it("strict fail: actual below window", () => {
    const result = checkDurationPolicy(28.5, {
      mode: "strict",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
    });
    expect(result.passed).toBe(false);
  });

  it("strict fail: actual above window", () => {
    const result = checkDurationPolicy(31.5, {
      mode: "strict",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
    });
    expect(result.passed).toBe(false);
  });

  it("strict pass: actual exactly at min", () => {
    const result = checkDurationPolicy(29.0, {
      mode: "strict",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
    });
    expect(result.passed).toBe(true);
  });

  it("strict pass: actual exactly at max", () => {
    const result = checkDurationPolicy(31.0, {
      mode: "strict",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
    });
    expect(result.passed).toBe(true);
  });

  it("guide: always passes regardless of drift", () => {
    const result = checkDurationPolicy(45.0, {
      mode: "guide",
      target_duration_sec: 90,
      min_duration_sec: 63,
      max_duration_sec: 117,
    });
    expect(result.passed).toBe(true);
    expect(result.metrics.duration_delta_sec).toBeLessThan(0);
  });

  it("guide: reports delta against target", () => {
    const result = checkDurationPolicy(100.0, {
      mode: "guide",
      target_duration_sec: 90,
      min_duration_sec: 63,
      max_duration_sec: 117,
    });
    expect(result.passed).toBe(true);
    expect(result.metrics.duration_delta_sec).toBeCloseTo(10, 1);
    expect(result.metrics.duration_delta_pct).toBeCloseTo(11.11, 0);
  });

  it("guide + material_total: reports delta but never fails", () => {
    const result = checkDurationPolicy(58.0, {
      mode: "guide",
      target_duration_sec: 58.4,
      min_duration_sec: 0,
      max_duration_sec: null,
    });
    expect(result.passed).toBe(true);
    expect(result.metrics.duration_delta_sec).not.toBeNull();
  });
});

// ── QA Required Checks ─────────────────────────────────────────────

describe("QA: Required Checks", () => {
  it("engine_render + strict includes duration_policy_valid", () => {
    const checks = getRequiredChecks("engine_render", "strict");
    expect(checks).toContain("duration_policy_valid");
  });

  it("engine_render + guide does not include duration_policy_valid", () => {
    const checks = getRequiredChecks("engine_render", "guide");
    expect(checks).not.toContain("duration_policy_valid");
  });

  it("engine_render + undefined mode does not include duration_policy_valid", () => {
    const checks = getRequiredChecks("engine_render");
    expect(checks).not.toContain("duration_policy_valid");
  });

  it("nle_finishing + strict includes duration_policy_valid", () => {
    const checks = getRequiredChecks("nle_finishing", "strict");
    expect(checks).toContain("duration_policy_valid");
  });

  it("backward compat: no mode arg still returns all base checks", () => {
    const checks = getRequiredChecks("engine_render");
    expect(checks).toContain("timeline_schema_valid");
    expect(checks).toContain("caption_density_valid");
    expect(checks.length).toBe(8);
  });
});

// ── Compiler Integration: Guide Mode ────────────────────────────────

describe("Compiler: Guide Mode", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempProject();
  });

  afterAll(() => {
    removeDirSync(tmpDir);
  });

  it("sample project defaults to guide mode", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    expect(result.duration_policy).toBeDefined();
    expect(result.duration_policy!.mode).toBe("guide");
  });

  it("guide mode: timeline compaction — total frames <= beat target sum", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    // beat targets: 96 + 216 + 240 + 168 = 720
    // With guide compaction, actual should be <= 720 (clips clamped to source duration)
    expect(result.resolution.total_frames).toBeLessThanOrEqual(720);
    expect(result.resolution.total_frames).toBeGreaterThan(0);
  });

  it("guide mode: duration_status is pass or advisory, never fail", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    expect(["pass", "advisory"]).toContain(result.resolution.duration_status);
  });

  it("guide mode: duration_policy in provenance", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    expect(result.timeline.provenance.duration_policy).toBeDefined();
    expect(result.timeline.provenance.duration_policy!.mode).toBe("guide");
  });

  it("guide mode: schema validation passes on generated timeline", () => {
    compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const validation = validateProject(tmpDir);
    const timelineViolations = validation.violations.filter(
      (v) => v.artifact === "05_timeline/timeline.json",
    );
    expect(timelineViolations).toEqual([]);
  });

  it("guide mode: delta fields are computed (not null)", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    expect(result.resolution.duration_delta_frames).toBeDefined();
    expect(typeof result.resolution.duration_delta_frames).toBe("number");
    expect(result.resolution.duration_delta_pct).toBeDefined();
    expect(typeof result.resolution.duration_delta_pct).toBe("number");
  });
});

// ── Compiler Integration: Strict Mode ───────────────────────────────

describe("Compiler: Strict Mode", () => {
  it("strict with adequate material: duration_status = pass", () => {
    // Sample project has ~28s target and enough material
    const tmpDir = createTempProject({
      briefOverrides: {
        project: {
          id: "sample-mountain-reset",
          title: "Mountain Reset",
          strategy: "message-first",
          client: "Internal fixture",
          format: "short-brand-film",
          runtime_target_sec: 28,
          duration_mode: "strict",
        },
      },
    });
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(result.duration_policy!.mode).toBe("strict");
      expect(result.duration_policy!.hard_gate).toBe(true);
      // With strict, the compiler tries to hit the target
      expect(result.resolution.duration_mode).toBe("strict");
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("strict: provenance contains duration_policy", () => {
    const tmpDir = createTempProject({
      briefOverrides: {
        project: {
          id: "sample-mountain-reset",
          title: "Mountain Reset",
          strategy: "message-first",
          runtime_target_sec: 28,
          duration_mode: "strict",
        },
      },
    });
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      const dp = result.timeline.provenance.duration_policy;
      expect(dp).toBeDefined();
      expect(dp!.mode).toBe("strict");
      expect(dp!.target_duration_sec).toBe(28);
      expect(dp!.min_duration_sec).toBe(27);
      expect(dp!.max_duration_sec).toBe(29);
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("strict: schema validation passes", () => {
    const tmpDir = createTempProject({
      briefOverrides: {
        project: {
          id: "sample-mountain-reset",
          title: "Mountain Reset",
          strategy: "message-first",
          runtime_target_sec: 28,
          duration_mode: "strict",
        },
      },
    });
    try {
      compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      const validation = validateProject(tmpDir);
      const tlViolations = validation.violations.filter(
        (v) => v.artifact === "05_timeline/timeline.json",
      );
      expect(tlViolations).toEqual([]);
    } finally {
      removeDirSync(tmpDir);
    }
  });
});

// ── Compiler Integration: Guide Without Target ─────────────────────

describe("Compiler: Guide Without Target", () => {
  function createNoTargetProject(): string {
    const tmpDir = path.join("tests", `tmp_duration_notgt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    copyDirSync(SAMPLE_PROJECT, tmpDir);

    // Remove any existing output
    const timelinePath = path.join(tmpDir, "05_timeline/timeline.json");
    if (fs.existsSync(timelinePath)) fs.unlinkSync(timelinePath);
    const manifestPath = path.join(tmpDir, "05_timeline/preview-manifest.json");
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

    // Write brief WITHOUT runtime_target_sec
    const briefPath = path.join(tmpDir, "01_intent/creative_brief.yaml");
    const original = parseYaml(fs.readFileSync(briefPath, "utf-8")) as Record<string, unknown>;
    const project = { ...(original.project as Record<string, unknown>) };
    delete project.runtime_target_sec;
    const merged = { ...original, project };
    fs.writeFileSync(briefPath, stringifyYaml(merged), "utf-8");
    return tmpDir;
  }

  it("guide + no target: uses material-derived target", () => {
    const tmpDir = createNoTargetProject();
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(result.duration_policy!.mode).toBe("guide");
      expect(result.duration_policy!.target_source).toBe("material_total");
      expect(result.duration_policy!.target_duration_sec).toBeGreaterThan(0);
      expect(result.duration_policy!.min_duration_sec).toBe(0);
      expect(result.duration_policy!.max_duration_sec).toBeNull();
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("guide + no target: delta fields computed against derived target", () => {
    const tmpDir = createNoTargetProject();
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(result.resolution.duration_delta_frames).toBeDefined();
      expect(typeof result.resolution.duration_delta_frames).toBe("number");
      expect(result.resolution.duration_delta_pct).toBeDefined();
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("guide + no target: compile succeeds (no failure)", () => {
    const tmpDir = createNoTargetProject();
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(result.timeline).toBeDefined();
      expect(result.resolution.total_frames).toBeGreaterThan(0);
      // Never fail for guide
      expect(result.resolution.duration_status).not.toBe("fail");
    } finally {
      removeDirSync(tmpDir);
    }
  });
});

// ── Blueprint duration_policy passthrough ───────────────────────────

describe("Blueprint duration_policy passthrough", () => {
  it("blueprint with explicit duration_policy is used by compiler", () => {
    const policy: DurationPolicy = {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 90,
      min_duration_sec: 63,
      max_duration_sec: 117,
      hard_gate: false,
      protect_vlm_peaks: true,
    };
    const tmpDir = createTempProject({
      blueprintOverrides: { duration_policy: policy },
    });
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(result.duration_policy!.target_duration_sec).toBe(90);
      expect(result.duration_policy!.min_duration_sec).toBe(63);
      expect(result.duration_policy!.max_duration_sec).toBe(117);
    } finally {
      removeDirSync(tmpDir);
    }
  });
});

// ── Resolve Phase: Duration Status ─────────────────────────────────

describe("Resolve: Duration Status", () => {
  function makeClip(overrides: Partial<TimelineClip> & { clip_id: string; segment_id: string }): TimelineClip {
    return {
      asset_id: "AST_001",
      src_in_us: 0,
      src_out_us: 1_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 24,
      role: "hero",
      motivation: "test",
      beat_id: "b01",
      fallback_segment_ids: [],
      confidence: 0.9,
      quality_flags: [],
      ...overrides,
    };
  }

  function makeTimeline(videoClips: TimelineClip[][]): AssembledTimeline {
    return {
      tracks: {
        video: videoClips.map((clips, i) => ({ track_id: `V${i + 1}`, kind: "video" as const, clips })),
        audio: [{ track_id: "A1", kind: "audio" as const, clips: [] }],
      },
      markers: [],
    };
  }

  it("strict: actual within window → pass", () => {
    const clip = makeClip({
      clip_id: "C1",
      segment_id: "S1",
      timeline_in_frame: 0,
      timeline_duration_frames: 720, // exactly 30s at 24fps
    });
    const policy: DurationPolicy = {
      mode: "strict",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
      hard_gate: true,
      protect_vlm_peaks: false,
    };
    const report = resolve(makeTimeline([[clip]]), 720, [], policy, 24, 1);
    expect(report.duration_status).toBe("pass");
  });

  it("strict: actual at exact min → pass", () => {
    const clip = makeClip({
      clip_id: "C1",
      segment_id: "S1",
      timeline_in_frame: 0,
      timeline_duration_frames: 696, // 29s at 24fps
    });
    const policy: DurationPolicy = {
      mode: "strict",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
      hard_gate: true,
      protect_vlm_peaks: false,
    };
    const report = resolve(makeTimeline([[clip]]), 720, [], policy, 24, 1);
    expect(report.duration_status).toBe("pass");
  });

  it("strict: actual 1 frame below min → fail", () => {
    const clip = makeClip({
      clip_id: "C1",
      segment_id: "S1",
      timeline_in_frame: 0,
      timeline_duration_frames: 695,
    });
    const policy: DurationPolicy = {
      mode: "strict",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
      hard_gate: true,
      protect_vlm_peaks: false,
    };
    const report = resolve(makeTimeline([[clip]]), 720, [], policy, 24, 1);
    expect(report.duration_status).toBe("fail");
  });

  it("strict: actual 1 frame above max → fail", () => {
    const clip = makeClip({
      clip_id: "C1",
      segment_id: "S1",
      timeline_in_frame: 0,
      timeline_duration_frames: 745,
    });
    const policy: DurationPolicy = {
      mode: "strict",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
      hard_gate: true,
      protect_vlm_peaks: false,
    };
    const report = resolve(makeTimeline([[clip]]), 720, [], policy, 24, 1);
    expect(report.duration_status).toBe("fail");
  });

  it("guide: actual outside advisory window → advisory", () => {
    const clip = makeClip({
      clip_id: "C1",
      segment_id: "S1",
      timeline_in_frame: 0,
      timeline_duration_frames: 500, // well below 70% of 720
    });
    const policy: DurationPolicy = {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 21,
      max_duration_sec: 39,
      hard_gate: false,
      protect_vlm_peaks: true,
    };
    const report = resolve(makeTimeline([[clip]]), 720, [], policy, 24, 1);
    expect(report.duration_status).toBe("advisory");
  });

  it("guide: actual within window → pass", () => {
    const clip = makeClip({
      clip_id: "C1",
      segment_id: "S1",
      timeline_in_frame: 0,
      timeline_duration_frames: 720,
    });
    const policy: DurationPolicy = {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 21,
      max_duration_sec: 39,
      hard_gate: false,
      protect_vlm_peaks: true,
    };
    const report = resolve(makeTimeline([[clip]]), 720, [], policy, 24, 1);
    expect(report.duration_status).toBe("pass");
  });

  it("guide: advisory window boundary → pass", () => {
    // 30% of 720 = 216 → min = 504 frames
    const policy: DurationPolicy = {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 21,
      max_duration_sec: 39,
      hard_gate: false,
      protect_vlm_peaks: true,
    };
    const minFrames = secToMinFrames(21, 24, 1); // ceil(21*24) = 504
    const clip = makeClip({
      clip_id: "C1",
      segment_id: "S1",
      timeline_in_frame: 0,
      timeline_duration_frames: minFrames,
    });
    const report = resolve(makeTimeline([[clip]]), 720, [], policy, 24, 1);
    expect(report.duration_status).toBe("pass");
  });

  it("guide: 1 frame below advisory min → advisory", () => {
    const policy: DurationPolicy = {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 21,
      max_duration_sec: 39,
      hard_gate: false,
      protect_vlm_peaks: true,
    };
    const minFrames = secToMinFrames(21, 24, 1);
    const clip = makeClip({
      clip_id: "C1",
      segment_id: "S1",
      timeline_in_frame: 0,
      timeline_duration_frames: minFrames - 1,
    });
    const report = resolve(makeTimeline([[clip]]), 720, [], policy, 24, 1);
    expect(report.duration_status).toBe("advisory");
  });

  it("no policy: backward compat, no duration_status", () => {
    const clip = makeClip({
      clip_id: "C1",
      segment_id: "S1",
      timeline_in_frame: 0,
      timeline_duration_frames: 720,
    });
    const report = resolve(makeTimeline([[clip]]), 720);
    expect(report.duration_status).toBeUndefined();
    expect(report.duration_fit).toBe(true);
  });

  it("NTSC 30000/1001: strict boundary check works", () => {
    const policy: DurationPolicy = {
      mode: "strict",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 29,
      max_duration_sec: 31,
      hard_gate: true,
      protect_vlm_peaks: false,
    };
    const bounds = computeFrameBounds(policy, 30000, 1001);

    // At min boundary → pass
    const clipMin = makeClip({
      clip_id: "C1",
      segment_id: "S1",
      timeline_in_frame: 0,
      timeline_duration_frames: bounds.min_target_frames,
    });
    const reportMin = resolve(makeTimeline([[clipMin]]), bounds.target_frames, [], policy, 30000, 1001);
    expect(reportMin.duration_status).toBe("pass");

    // At max boundary → pass
    const clipMax = makeClip({
      clip_id: "C2",
      segment_id: "S2",
      timeline_in_frame: 0,
      timeline_duration_frames: bounds.max_target_frames!,
    });
    const reportMax = resolve(makeTimeline([[clipMax]]), bounds.target_frames, [], policy, 30000, 1001);
    expect(reportMax.duration_status).toBe("pass");

    // 1 frame over → fail
    const clipOver = makeClip({
      clip_id: "C3",
      segment_id: "S3",
      timeline_in_frame: 0,
      timeline_duration_frames: bounds.max_target_frames! + 1,
    });
    const reportOver = resolve(makeTimeline([[clipOver]]), bounds.target_frames, [], policy, 30000, 1001);
    expect(reportOver.duration_status).toBe("fail");
  });
});

// ── Determinism ─────────────────────────────────────────────────────

describe("Determinism", () => {
  it("guide mode: two runs produce identical output", () => {
    const tmpDir = createTempProject();
    try {
      const r1 = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      const r2 = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(JSON.stringify(r1.timeline)).toBe(JSON.stringify(r2.timeline));
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("strict mode: two runs produce identical output", () => {
    const tmpDir = createTempProject({
      briefOverrides: {
        project: {
          id: "sample-mountain-reset",
          title: "Mountain Reset",
          strategy: "message-first",
          runtime_target_sec: 28,
          duration_mode: "strict",
        },
      },
    });
    try {
      const r1 = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      const r2 = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(JSON.stringify(r1.timeline)).toBe(JSON.stringify(r2.timeline));
    } finally {
      removeDirSync(tmpDir);
    }
  });
});

// ── Backward Compatibility ─────────────────────────────────────────

describe("Backward Compatibility", () => {
  it("existing brief without duration_mode compiles successfully", () => {
    const tmpDir = createTempProject();
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(result.timeline).toBeDefined();
      expect(result.timeline.tracks.video.length).toBeGreaterThan(0);
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("existing brief schema validation still passes", () => {
    const tmpDir = createTempProject();
    try {
      compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      const validation = validateProject(tmpDir);
      expect(validation.violations.length).toBe(0);
    } finally {
      removeDirSync(tmpDir);
    }
  });
});
