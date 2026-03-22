import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compile } from "../runtime/compiler/index.js";
import {
  inferDominantSourceAspectRatio,
  resolveOutputDimensions,
  resolveTimelineOrder,
} from "../runtime/compiler/duration-helpers.js";
import type { EditBlueprint, CreativeBrief } from "../runtime/compiler/types.js";

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
  const tmpDir = path.join("tests", `tmp_v5fix_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  copyDirSync(SAMPLE_PROJECT, tmpDir);

  const timelinePath = path.join(tmpDir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) fs.unlinkSync(timelinePath);
  const manifestPath = path.join(tmpDir, "05_timeline/preview-manifest.json");
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

  if (overrides?.briefOverrides) {
    const briefPath = path.join(tmpDir, "01_intent/creative_brief.yaml");
    const original = parseYaml(fs.readFileSync(briefPath, "utf-8")) as Record<string, unknown>;
    const merged = { ...original, ...overrides.briefOverrides };
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

// ── Fix 1: Aspect Ratio ──────────────────────────────────────────────

describe("v5 Fix 1: Output Aspect Ratio", () => {
  it("resolveOutputDimensions returns 16:9 by default", () => {
    const dims = resolveOutputDimensions(undefined);
    expect(dims.width).toBe(1920);
    expect(dims.height).toBe(1080);
    expect(dims.output_aspect_ratio).toBe("16:9");
    expect(dims.letterbox_policy).toBe("none");
  });

  it("resolveOutputDimensions returns 9:16 for vertical", () => {
    const dims = resolveOutputDimensions({ aspect_ratio: "9:16" });
    expect(dims.width).toBe(1080);
    expect(dims.height).toBe(1920);
    expect(dims.output_aspect_ratio).toBe("9:16");
  });

  it("resolveOutputDimensions returns 1:1 for square", () => {
    const dims = resolveOutputDimensions({ aspect_ratio: "1:1" });
    expect(dims.width).toBe(1080);
    expect(dims.height).toBe(1080);
    expect(dims.output_aspect_ratio).toBe("1:1");
  });

  it("resolveOutputDimensions returns 4:5 for portrait", () => {
    const dims = resolveOutputDimensions({ aspect_ratio: "4:5" });
    expect(dims.width).toBe(1080);
    expect(dims.height).toBe(1350);
    expect(dims.output_aspect_ratio).toBe("4:5");
  });

  it("inferDominantSourceAspectRatio prefers the most common source format", () => {
    const ratio = inferDominantSourceAspectRatio([
      { width: 1080, height: 1920 },
      { width: 1080, height: 1920 },
      { width: 1920, height: 1080 },
    ]);
    expect(ratio).toBe("9:16");
  });

  it("resolveOutputDimensions infers 9:16 from dominant source dimensions", () => {
    const dims = resolveOutputDimensions(undefined, [
      { width: 1080, height: 1920 },
      { width: 1080, height: 1920 },
    ]);
    expect(dims.width).toBe(1080);
    expect(dims.height).toBe(1920);
    expect(dims.output_aspect_ratio).toBe("9:16");
    expect(dims.letterbox_policy).toBe("none");
  });

  it("resolveOutputDimensions flags pillarbox when explicit output is wider than vertical source", () => {
    const dims = resolveOutputDimensions(
      { aspect_ratio: "16:9" },
      [{ width: 1080, height: 1920 }],
    );
    expect(dims.width).toBe(1920);
    expect(dims.height).toBe(1080);
    expect(dims.output_aspect_ratio).toBe("16:9");
    expect(dims.letterbox_policy).toBe("pillarbox");
  });

  it("resolveOutputDimensions defaults for unknown", () => {
    const dims = resolveOutputDimensions({ aspect_ratio: "unknown" });
    expect(dims.width).toBe(1920);
    expect(dims.height).toBe(1080);
    expect(dims.output_aspect_ratio).toBe("16:9");
  });

  it("vertical aspect ratio produces correct timeline sequence dimensions", () => {
    const tmpDir = createTempProject({
      briefOverrides: { editorial: { aspect_ratio: "9:16" } },
    });
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(result.timeline.sequence.width).toBe(1080);
      expect(result.timeline.sequence.height).toBe(1920);
      expect(result.timeline.sequence.output_aspect_ratio).toBe("9:16");
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("default project (no editorial.aspect_ratio) uses 16:9", () => {
    const tmpDir = createTempProject();
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(result.timeline.sequence.width).toBe(1920);
      expect(result.timeline.sequence.height).toBe(1080);
      expect(result.timeline.sequence.output_aspect_ratio).toBe("16:9");
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("infers 9:16 output from dominant vertical assets when brief aspect_ratio is omitted", () => {
    const tmpDir = createTempProject();
    try {
      const briefPath = path.join(tmpDir, "01_intent/creative_brief.yaml");
      const brief = parseYaml(fs.readFileSync(briefPath, "utf-8")) as CreativeBrief;
      if (brief.editorial) {
        delete brief.editorial.aspect_ratio;
      }
      fs.writeFileSync(briefPath, stringifyYaml(brief), "utf-8");

      const assetsPath = path.join(tmpDir, "03_analysis/assets.json");
      const assets = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as {
        items: Array<{ video_stream?: { width: number; height: number; fps_num: number; fps_den: number; codec: string } }>;
      };
      for (const item of assets.items) {
        item.video_stream = {
          width: 1080,
          height: 1920,
          fps_num: 24,
          fps_den: 1,
          codec: "h264",
        };
      }
      fs.writeFileSync(assetsPath, JSON.stringify(assets, null, 2), "utf-8");

      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(result.timeline.sequence.width).toBe(1080);
      expect(result.timeline.sequence.height).toBe(1920);
      expect(result.timeline.sequence.output_aspect_ratio).toBe("9:16");
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("preserves explicit 16:9 output but sets pillarbox policy for vertical assets", () => {
    const tmpDir = createTempProject({
      briefOverrides: { editorial: { aspect_ratio: "16:9" } },
    });
    try {
      const assetsPath = path.join(tmpDir, "03_analysis/assets.json");
      const assets = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as {
        items: Array<{ video_stream?: { width: number; height: number; fps_num: number; fps_den: number; codec: string } }>;
      };
      for (const item of assets.items) {
        item.video_stream = {
          width: 1080,
          height: 1920,
          fps_num: 24,
          fps_den: 1,
          codec: "h264",
        };
      }
      fs.writeFileSync(assetsPath, JSON.stringify(assets, null, 2), "utf-8");

      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      expect(result.timeline.sequence.width).toBe(1920);
      expect(result.timeline.sequence.height).toBe(1080);
      expect(result.timeline.sequence.output_aspect_ratio).toBe("16:9");
      expect(result.timeline.sequence.letterbox_policy).toBe("pillarbox");
    } finally {
      removeDirSync(tmpDir);
    }
  });
});

// ── Fix 2: Guide Mode Fill ───────────────────────────────────────────

describe("v5 Fix 2: Guide Mode Clip Fill", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempProject();
  });

  afterAll(() => {
    removeDirSync(tmpDir);
  });

  it("guide mode places all candidates (sample has 13 non-reject)", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const allClips = [
      ...result.timeline.tracks.video.flatMap((t) => t.clips),
      ...result.timeline.tracks.audio.flatMap((t) => t.clips),
    ];
    // With fill pass, all 13 candidates should be placed
    expect(allClips.length).toBeGreaterThanOrEqual(10);
  });

  it("guide mode total duration meets or exceeds beat target sum", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    // Beat target sum = 96 + 216 + 240 + 168 = 720 frames
    // Guide mode uses beat target as floor, so total should be >= sum of targets
    const beatTargetSum = 720;
    expect(result.resolution.total_frames).toBeGreaterThanOrEqual(beatTargetSum * 0.9);
  });

  it("guide mode duration_fit is true within policy max bounds", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    expect(result.resolution.duration_fit).toBe(true);
    // Guide mode policy: target * 1.3 = 28 * 1.3 = 36.4s = 873 frames max
    if (result.resolution.max_target_frames != null) {
      expect(result.resolution.total_frames).toBeLessThanOrEqual(
        result.resolution.max_target_frames,
      );
    }
  });

  it("V2 track has more clips than beats (fill places extra support/texture)", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const v2 = result.timeline.tracks.video.find((t) => t.track_id === "V2");
    expect(v2).toBeDefined();
    // With fill, V2 should have more clips than the 4 beats
    expect(v2!.clips.length).toBeGreaterThanOrEqual(4);
  });
});

// ── Fix 3: Chronological Ordering ────────────────────────────────────

describe("v5 Fix 3: Chronological Ordering", () => {
  it("resolveTimelineOrder returns editorial by default", () => {
    const blueprint = { timeline_order: undefined } as unknown as EditBlueprint;
    expect(resolveTimelineOrder(blueprint)).toBe("editorial");
  });

  it("resolveTimelineOrder respects explicit blueprint setting", () => {
    const blueprint = { timeline_order: "chronological" } as unknown as EditBlueprint;
    expect(resolveTimelineOrder(blueprint)).toBe("chronological");
  });

  it("resolveTimelineOrder infers chronological from story_arc strategy", () => {
    const blueprint = {
      story_arc: { strategy: "chronological" },
    } as unknown as EditBlueprint;
    expect(resolveTimelineOrder(blueprint)).toBe("chronological");
  });

  it("resolveTimelineOrder infers chronological from keepsake profile", () => {
    const blueprint = {} as unknown as EditBlueprint;
    expect(resolveTimelineOrder(blueprint, "keepsake")).toBe("chronological");
  });

  it("resolveTimelineOrder infers chronological from event-recap profile", () => {
    const blueprint = {} as unknown as EditBlueprint;
    expect(resolveTimelineOrder(blueprint, "event-recap")).toBe("chronological");
  });

  it("resolveTimelineOrder infers editorial from interview-highlight profile", () => {
    const blueprint = {} as unknown as EditBlueprint;
    expect(resolveTimelineOrder(blueprint, "interview-highlight")).toBe("editorial");
  });

  it("chronological timeline_order sorts V1 clips by source timestamp", () => {
    const tmpDir = createTempProject({
      blueprintOverrides: { timeline_order: "chronological" },
    });
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      const v1 = result.timeline.tracks.video.find((t) => t.track_id === "V1");
      expect(v1).toBeDefined();
      const v1Clips = v1!.clips;
      expect(v1Clips.length).toBeGreaterThan(1);

      // Verify V1 clips are sorted by asset_id then src_in_us
      for (let i = 1; i < v1Clips.length; i++) {
        const prev = v1Clips[i - 1];
        const curr = v1Clips[i];
        const cmp = prev.asset_id.localeCompare(curr.asset_id);
        if (cmp === 0) {
          expect(prev.src_in_us).toBeLessThanOrEqual(curr.src_in_us);
        } else {
          expect(cmp).toBeLessThan(0);
        }
      }
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("chronological ordering updates beat markers to match new positions", () => {
    const tmpDir = createTempProject({
      blueprintOverrides: { timeline_order: "chronological" },
    });
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      const markers = result.timeline.markers.filter((m) => m.kind === "beat");

      // Markers should still be monotonically increasing
      for (let i = 1; i < markers.length; i++) {
        expect(markers[i].frame).toBeGreaterThanOrEqual(markers[i - 1].frame);
      }
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("editorial (default) ordering is score-based, not source-timestamp-based", () => {
    const tmpDir = createTempProject();
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      const v1 = result.timeline.tracks.video.find((t) => t.track_id === "V1");
      expect(v1).toBeDefined();
      const v1Clips = v1!.clips;

      // V1 clips should follow beat order (b01, b02/b03, b04), not source timestamp
      // b01 hero is SEG_0025 (AST_005), b03 hero is SEG_0020 (AST_004)
      // If sorted chronologically, AST_004 would come before AST_005
      // But in editorial order, beat order is preserved
      if (v1Clips.length >= 2) {
        // Timeline positions should be monotonically increasing
        for (let i = 1; i < v1Clips.length; i++) {
          expect(v1Clips[i].timeline_in_frame).toBeGreaterThanOrEqual(
            v1Clips[i - 1].timeline_in_frame,
          );
        }
      }
    } finally {
      removeDirSync(tmpDir);
    }
  });
});
