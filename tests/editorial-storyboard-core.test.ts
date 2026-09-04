import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  aspectFromDimensions,
  computeFramingPlan,
  parseAspectRatio,
  resolveCanvas,
} from "../runtime/review/editorial-storyboard/framing.js";
import { selectRepresentativeTimestamp } from "../runtime/review/editorial-storyboard/beats.js";
import { deliveryIdentityHash } from "../runtime/review/editorial-storyboard/manifest.js";
import type { ResolvedCandidateBinding, ResolvedCanvas } from "../runtime/review/editorial-storyboard/types.js";
import {
  createFixtureProject,
  type FixtureProjectOptions,
} from "./helpers/editorial-storyboard-fixtures.js";

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixture(options: FixtureProjectOptions): string {
  const dir = createFixtureProject(options);
  cleanup.push(dir);
  return dir;
}

function binding(overrides: Partial<ResolvedCandidateBinding> = {}): ResolvedCandidateBinding {
  return {
    ref: "CAND_A",
    resolved: true,
    candidate_id: "CAND_A",
    segment_id: "SEG_0001",
    asset_id: "AST_001",
    src_in_us: 1_000_000,
    src_out_us: 5_000_000,
    role: "hero",
    confidence: 0.9,
    media_kind: "video",
    quality_flags: [],
    risks: [],
    evidence: [],
    transcript_excerpt: null,
    audio_role: null,
    speaker_role: null,
    trim_hint: null,
    still_image: null,
    freeze_frame_hold: null,
    asset_hash: "sha256:" + "a".repeat(64),
    asset_missing: false,
    ...overrides,
  };
}

const emptySegments = new Map<string, { segment_id: string; src_in_us: number; src_out_us: number }>();

describe("aspect parsing (generic, no hardcoded ratios)", () => {
  it("parses arbitrary W:H ratios including cinema ratios", () => {
    expect(parseAspectRatio("16:9")?.aspect).toBeCloseTo(16 / 9);
    expect(parseAspectRatio("9:16")?.aspect).toBeCloseTo(9 / 16);
    expect(parseAspectRatio("4:5")?.aspect).toBeCloseTo(4 / 5);
    expect(parseAspectRatio("1:1")?.aspect).toBe(1);
    expect(parseAspectRatio("2.39:1")?.aspect).toBeCloseTo(2.39);
    expect(parseAspectRatio("21:9")?.aspect).toBeCloseTo(21 / 9);
    expect(parseAspectRatio("custom")).toBeNull();
    expect(parseAspectRatio("nonsense")).toBeNull();
  });

  it("derives compact ratios from dimensions", () => {
    expect(aspectFromDimensions(1920, 1080)?.label).toBe("16:9");
    expect(aspectFromDimensions(1080, 1920)?.label).toBe("9:16");
    // Non-reducible cinema ratios keep a decimal label but the exact aspect value.
    const cine = aspectFromDimensions(2048, 858);
    expect(cine?.aspect).toBeCloseTo(2048 / 858);
    expect(aspectFromDimensions(0, 100)).toBeNull();
  });
});

describe("canvas resolution never guesses", () => {
  const timeline = { fps_num: 24, fps_den: 1, width: 1920, height: 1080, output_aspect_ratio: "16:9" };

  it("prefers the delivery profile over the timeline sequence", () => {
    const canvas = resolveCanvas({
      profiles: [
        {
          profile_id: "DPROF_A",
          profile_name: "A",
          platform: "shorts",
          path: "07_package/delivery_profiles/a.yaml",
          hash: "sha256:x",
          aspect_ratio: "9:16",
          resolution_width: 1080,
          resolution_height: 1920,
          fps_mode: "cfr_30",
          caption_mode: "burned_in",
        },
      ],
      requestedDeliveryId: "DPROF_A",
      timeline,
    });
    expect(canvas.aspect_ratio_label).toBe("9:16");
    expect(canvas.basis).toBe("delivery_profile");
    expect(canvas.fps_num).toBe(30);
  });

  it("falls back to the timeline sequence when no profile is selected", () => {
    const canvas = resolveCanvas({ profiles: [], requestedDeliveryId: null, timeline });
    expect(canvas.aspect_ratio_label).toBe("16:9");
    expect(canvas.basis).toBe("timeline_sequence");
  });

  it("returns unspecified (not an inferred ratio) when neither source exists", () => {
    const canvas = resolveCanvas({ profiles: [], requestedDeliveryId: null, timeline: null });
    expect(canvas.basis).toBe("unspecified");
    expect(canvas.aspect_ratio_label).toBe("unspecified");
    expect(canvas.aspect).toBeNull();
  });

  it("resolves custom cinema aspect from resolution when the ratio string is custom", () => {
    const canvas = resolveCanvas({
      profiles: [
        {
          profile_id: "DPROF_CINE",
          profile_name: "Cine",
          platform: "custom",
          path: "07_package/delivery_profiles/cine.yaml",
          hash: "sha256:y",
          aspect_ratio: "custom",
          resolution_width: 2048,
          resolution_height: 858,
          fps_mode: "cfr_24",
          caption_mode: "none",
        },
      ],
      requestedDeliveryId: "DPROF_CINE",
      timeline: null,
    });
    expect(canvas.aspect).toBeCloseTo(2048 / 858);
    expect(canvas.basis).toBe("delivery_profile");
  });
});

describe("framing plan math", () => {
  const canvas9x16: ResolvedCanvas = {
    aspect_ratio_label: "9:16",
    aspect: 9 / 16,
    width: 1080,
    height: 1920,
    fps_num: 30,
    fps_den: 1,
    basis: "delivery_profile",
  };

  it("center-crops a wider source horizontally with exact math", () => {
    const plan = computeFramingPlan({ canvas: canvas9x16, sourceAspect: 16 / 9 });
    expect(plan.fit).toBe("crop");
    expect(plan.crop_basis).toBe("default_center_cover");
    expect(plan.crop_rect?.width).toBeCloseTo((9 / 16) / (16 / 9));
    expect(plan.crop_rect?.x).toBeCloseTo((1 - plan.crop_rect!.width) / 2);
    expect(plan.crop_rect?.height).toBe(1);
    expect(plan.note).toContain("default centered cover-crop preview");
  });

  it("center-crops a taller source vertically", () => {
    const canvas16x9: ResolvedCanvas = { ...canvas9x16, aspect_ratio_label: "16:9", aspect: 16 / 9 };
    const plan = computeFramingPlan({ canvas: canvas16x9, sourceAspect: 9 / 16 });
    expect(plan.fit).toBe("crop");
    // Full source width is kept; the visible height fraction is srcAspect/canvasAspect.
    expect(plan.crop_rect?.width).toBe(1);
    expect(plan.crop_rect?.height).toBeCloseTo((9 / 16) / (16 / 9));
    expect(plan.crop_rect?.y).toBeCloseTo((1 - plan.crop_rect!.height) / 2);
  });

  it("marks passthrough for matching aspect", () => {
    const plan = computeFramingPlan({ canvas: canvas9x16, sourceAspect: 9 / 16 });
    expect(plan.fit).toBe("passthrough");
    expect(plan.crop_rect).toBeNull();
  });

  it("prefers an authored crop from registered visual intents", () => {
    const plan = computeFramingPlan({
      canvas: canvas9x16,
      sourceAspect: 16 / 9,
      authoredCropRect: { x: 0.1, y: 0, width: 0.5, height: 1 },
    });
    expect(plan.crop_basis).toBe("registered_visual_intent");
    expect(plan.crop_rect?.x).toBe(0.1);
  });

  it("stays unknown when source aspect cannot be probed", () => {
    const plan = computeFramingPlan({ canvas: canvas9x16, sourceAspect: null });
    expect(plan.fit).toBe("unknown");
    expect(plan.note).toContain("source aspect could not be determined");
  });

  it("works identically for 4:5, 1:1, and 2.39:1 canvases (no per-ratio logic)", () => {
    for (const [label, w, h] of [["4:5", 4, 5], ["1:1", 1, 1], ["2.39:1", 2.39, 1]] as const) {
      const canvas: ResolvedCanvas = { ...canvas9x16, aspect_ratio_label: label, aspect: w / h };
      const plan = computeFramingPlan({ canvas, sourceAspect: 16 / 9 });
      expect(plan.fit).toBe("crop");
      const ratio = (w / h) / (16 / 9);
      if (ratio <= 1) {
        // Canvas narrower than source → horizontal crop keeps full height.
        expect(plan.crop_rect?.width).toBeCloseTo(ratio);
        expect(plan.crop_rect?.height).toBe(1);
      } else {
        // Canvas wider than source (2.39:1) → vertical crop keeps full width.
        expect(plan.crop_rect?.height).toBeCloseTo(1 / ratio);
        expect(plan.crop_rect?.width).toBe(1);
      }
    }
  });
});

describe("representative frame selection order", () => {
  const base = { segmentsBySegmentId: emptySegments, mediaKind: "video" as const };

  it("1. prefers the authored freeze-frame timestamp", () => {
    const plan = selectRepresentativeTimestamp({
      binding: binding({ freeze_frame_hold: { source_time_us: 2_500_000, hold_frames: 24 }, trim_hint: { source_center_us: 3_000_000, recommended_in_us: null, recommended_out_us: null, center_source: null, peak_ref: null } }),
      ...base,
    });
    expect(plan.basis).toBe("authored_freeze_frame");
    expect(plan.timestamp_us).toBe(2_500_000);
  });

  it("2. uses still_image basis for image candidates", () => {
    const plan = selectRepresentativeTimestamp({
      binding: binding({ media_kind: "image" }),
      segmentsBySegmentId: emptySegments,
      mediaKind: "image",
    });
    expect(plan.basis).toBe("still_image");
  });

  it("3. uses trim_hint.source_center_us", () => {
    const plan = selectRepresentativeTimestamp({
      binding: binding({ trim_hint: { source_center_us: 3_100_000, recommended_in_us: null, recommended_out_us: null, center_source: "refine_filmstrip", peak_ref: null } }),
      ...base,
    });
    expect(plan.basis).toBe("trim_hint_center");
    expect(plan.timestamp_us).toBe(3_100_000);
  });

  it("4. uses the selected recommended trim center as peak basis", () => {
    const plan = selectRepresentativeTimestamp({
      binding: binding({ trim_hint: { source_center_us: null, recommended_in_us: 2_000_000, recommended_out_us: 3_000_000, center_source: "precision_dense_frames", peak_ref: "peak1" } }),
      ...base,
    });
    expect(plan.basis).toBe("selected_peak");
    expect(plan.timestamp_us).toBe(2_500_000);
  });

  it("5. falls back to the candidate midpoint", () => {
    const plan = selectRepresentativeTimestamp({ binding: binding(), ...base });
    expect(plan.basis).toBe("candidate_midpoint");
    expect(plan.timestamp_us).toBe(3_000_000);
  });

  it("6. uses the analysis segment midpoint as the last fallback", () => {
    const segments = new Map([["SEG_0001", { segment_id: "SEG_0001", src_in_us: 0, src_out_us: 8_000_000 }]]);
    const plan = selectRepresentativeTimestamp({
      binding: binding({ src_in_us: null, src_out_us: null }),
      segmentsBySegmentId: segments,
      mediaKind: "video",
    });
    expect(plan.basis).toBe("segment_midpoint");
    expect(plan.timestamp_us).toBe(4_000_000);
  });

  it("reports unavailable for unresolved bindings instead of guessing", () => {
    const plan = selectRepresentativeTimestamp({ binding: null, ...base });
    expect(plan.basis).toBe("unavailable");
    expect(plan.timestamp_us).toBeNull();
  });
});

describe("delivery identity hash", () => {
  it("is order-independent and distinguishes profile sets", () => {
    const a = deliveryIdentityHash(["sha256:aa", "sha256:bb"]);
    const b = deliveryIdentityHash(["sha256:bb", "sha256:aa"]);
    const c = deliveryIdentityHash(["sha256:aa"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(deliveryIdentityHash([])).toBe("source-aspect:no-delivery-profile");
  });
});

describe("fixture project generation (offline, skip-frames)", () => {
  it("matches blueprint beat count and total frames and never mutates canonical artifacts", async () => {
    const { generateEditorialStoryboard } = await import("../runtime/review/editorial-storyboard/generate.js");
    const projectDir = makeFixture({
      beats: [
        { id: "b01", label: "hook", frames: 96, primaryRef: "CAND_HOOK" },
        { id: "b02", label: "body", frames: 216, primaryRef: "CAND_BODY", fallbackRefs: ["CAND_HOOK"] },
      ],
      candidates: [
        { candidateId: "CAND_HOOK", segmentId: "SEG_0001", assetId: "AST_001", transcriptExcerpt: "hello there" },
        { candidateId: "CAND_BODY", segmentId: "SEG_0002", assetId: "AST_002" },
      ],
    });

    const canonicalFiles = ["01_intent/creative_brief.yaml", "04_plan/selects_candidates.yaml", "04_plan/edit_blueprint.yaml", "04_plan/uncertainty_register.yaml"];
    const before = Object.fromEntries(
      canonicalFiles.map((file) => [file, fs.readFileSync(path.join(projectDir, file), "utf-8")]),
    );

    const result = await generateEditorialStoryboard({
      projectDir,
      sourceMode: "blueprint",
      delivery: "all",
      generatedAt: "2026-08-01T00:00:00.000Z",
      skipFrames: true,
    });

    expect(result.manifest.beat_count).toBe(2);
    expect(result.manifest.total_frames).toBe(312);
    expect(result.manifest.total_frames_basis).toBe("blueprint_target_frames");

    const html = fs.readFileSync(path.join(result.projectionDir, "index.html"), "utf-8");
    expect((html.match(/<article class="sb-beat/g) ?? []).length).toBe(2);
    expect(fs.existsSync(path.join(result.projectionDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.projectionDir, "review-summary.md"))).toBe(true);
    expect(fs.existsSync(path.join(result.projectionDir, "frames"))).toBe(true);

    for (const file of canonicalFiles) {
      expect(fs.readFileSync(path.join(projectDir, file), "utf-8")).toBe(before[file]);
    }
  });

  it("is deterministic for identical inputs (HTML bytes and manifest identity)", async () => {
    const { generateEditorialStoryboard } = await import("../runtime/review/editorial-storyboard/generate.js");
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", frames: 96, primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
    });

    const first = await generateEditorialStoryboard({ projectDir, sourceMode: "blueprint", delivery: "all", generatedAt: "2026-08-01T00:00:00.000Z", skipFrames: true });
    const htmlBefore = fs.readFileSync(path.join(first.projectionDir, "index.html"), "utf-8");
    const summaryBefore = fs.readFileSync(path.join(first.projectionDir, "review-summary.md"), "utf-8");

    // Regenerate in place: same inputs must reproduce byte-identical outputs.
    const second = await generateEditorialStoryboard({ projectDir, sourceMode: "blueprint", delivery: "all", generatedAt: "2026-08-01T00:00:00.000Z", skipFrames: true });
    expect(second.projectionId).toBe(first.projectionId);
    expect(fs.readFileSync(path.join(second.projectionDir, "index.html"), "utf-8")).toBe(htmlBefore);
    expect(fs.readFileSync(path.join(second.projectionDir, "review-summary.md"), "utf-8")).toBe(summaryBefore);
  });

  it("flags unresolved candidate refs as INVALID without silent fallback", async () => {
    const { generateEditorialStoryboard } = await import("../runtime/review/editorial-storyboard/generate.js");
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", primaryRef: "CAND_MISSING" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
    });
    const result = await generateEditorialStoryboard({ projectDir, sourceMode: "blueprint", delivery: "all", generatedAt: "2026-08-01T00:00:00.000Z", skipFrames: true });
    expect(result.manifest.invalid.length).toBeGreaterThan(0);
    expect(result.manifest.invalid[0]).toContain("CAND_MISSING");
    const html = fs.readFileSync(path.join(result.projectionDir, "index.html"), "utf-8");
    expect(html).toContain("INVALID");
    expect(html).toContain("CAND_MISSING");
  });

  it("renders five aspect ratios through the same code path", async () => {
    const { generateEditorialStoryboard } = await import("../runtime/review/editorial-storyboard/generate.js");
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", frames: 96, primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
      deliveryProfiles: [
        { profileId: "DPROF_V", platform: "shorts", aspectRatio: "9:16", width: 1080, height: 1920 },
        { profileId: "DPROF_H", platform: "youtube", aspectRatio: "16:9", width: 1920, height: 1080 },
        { profileId: "DPROF_P", platform: "instagram_feed", aspectRatio: "4:5", width: 1080, height: 1350 },
        { profileId: "DPROF_S", platform: "instagram_feed", aspectRatio: "1:1", width: 1080, height: 1080 },
        { profileId: "DPROF_C", platform: "custom", aspectRatio: "2.39:1", width: 2048, height: 858 },
      ],
    });
    const result = await generateEditorialStoryboard({ projectDir, sourceMode: "blueprint", delivery: "all", generatedAt: "2026-08-01T00:00:00.000Z", skipFrames: true });
    const html = fs.readFileSync(path.join(result.projectionDir, "index.html"), "utf-8");
    for (const label of ["9:16", "16:9", "4:5", "1:1", "2.39:1"]) {
      expect(html).toContain(label);
    }
    expect(result.manifest.delivery.profiles).toHaveLength(5);
  });

  it("uses source aspect without inference when no delivery profile exists", async () => {
    const { generateEditorialStoryboard } = await import("../runtime/review/editorial-storyboard/generate.js");
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", frames: 96, primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
    });
    const result = await generateEditorialStoryboard({ projectDir, sourceMode: "blueprint", delivery: "all", generatedAt: "2026-08-01T00:00:00.000Z", skipFrames: true });
    expect(result.manifest.canvas.basis).toBe("unspecified");
    expect(result.manifest.canvas.aspect_ratio_label).toBe("unspecified");
    const html = fs.readFileSync(path.join(result.projectionDir, "index.html"), "utf-8");
    expect(html).toContain("source aspect used, ratio not inferred");
  });

  it("keeps audio-only beats on transcript representation with an explicit waveform warning", async () => {
    const { generateEditorialStoryboard } = await import("../runtime/review/editorial-storyboard/generate.js");
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "vo", primaryRef: "CAND_VO" }],
      candidates: [{ candidateId: "CAND_VO", segmentId: "SEG_A", assetId: "AST_A", mediaKind: "audio", transcriptExcerpt: "音声のみのビート" }],
    });
    const result = await generateEditorialStoryboard({ projectDir, sourceMode: "blueprint", delivery: "all", generatedAt: "2026-08-01T00:00:00.000Z", skipFrames: true });
    const html = fs.readFileSync(path.join(result.projectionDir, "index.html"), "utf-8");
    expect(html).toContain("音声のみのビート");
    expect(html.toLowerCase()).toContain("waveform unavailable");
  });

  it("attaches compiled placement with gap/overrun/trim delta in timeline and compare modes", async () => {
    const { generateEditorialStoryboard } = await import("../runtime/review/editorial-storyboard/generate.js");
    const projectDir = makeFixture({
      beats: [
        { id: "b01", label: "hook", frames: 96, primaryRef: "CAND_A" },
        { id: "b02", label: "body", frames: 100, primaryRef: "CAND_B" },
      ],
      candidates: [
        { candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001", srcInUs: 1_000_000, srcOutUs: 5_000_000 },
        { candidateId: "CAND_B", segmentId: "SEG_0002", assetId: "AST_002" },
      ],
      withTimeline: true,
      timelineOverrunBeatId: "b02",
    });

    const timeline = await generateEditorialStoryboard({ projectDir, sourceMode: "timeline", delivery: "all", generatedAt: "2026-08-01T00:00:00.000Z", skipFrames: true });
    expect(timeline.manifest.total_frames_basis).toBe("timeline_span_frames");
    // b01: 0–96, b02: 96–216 (120f compiled vs 100f target → +20 overrun).
    expect(timeline.manifest.compiled_span_frames).toBe(216);
    const timelineHtml = fs.readFileSync(path.join(timeline.projectionDir, "index.html"), "utf-8");
    expect(timelineHtml).toContain("overrun");

    const compare = await generateEditorialStoryboard({ projectDir, sourceMode: "compare", delivery: "all", generatedAt: "2026-08-01T00:00:00.000Z", skipFrames: true });
    const compareHtml = fs.readFileSync(path.join(compare.projectionDir, "index.html"), "utf-8");
    expect(compareHtml).toContain("trim Δ");
  });

  it("rejects an explicitly requested but nonexistent delivery profile", async () => {
    const { generateEditorialStoryboard } = await import("../runtime/review/editorial-storyboard/generate.js");
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
    });
    await expect(
      generateEditorialStoryboard({ projectDir, sourceMode: "blueprint", delivery: "DPROF_NOPE", generatedAt: "2026-08-01T00:00:00.000Z", skipFrames: true }),
    ).rejects.toThrow(/DPROF_NOPE/);
  });
});
