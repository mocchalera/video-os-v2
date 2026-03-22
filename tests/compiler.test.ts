import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compile } from "../runtime/compiler/index.js";
import { resolve } from "../runtime/compiler/resolve.js";
import { validateProject } from "../scripts/validate-schemas.js";
import type { AssembledTimeline, Candidate, TimelineClip } from "../runtime/compiler/types.js";

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

function createTempProject(): string {
  const tmpDir = path.join("tests", `tmp_compiler_${Date.now()}`);
  copyDirSync(SAMPLE_PROJECT, tmpDir);
  // Remove any existing timeline.json so tests start clean
  const timelinePath = path.join(tmpDir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) {
    fs.unlinkSync(timelinePath);
  }
  return tmpDir;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Timeline Compiler", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempProject();
  });

  afterAll(() => {
    removeDirSync(tmpDir);
  });

  it("generates timeline.json from fixture project", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    expect(result.outputPath).toContain("timeline.json");
    expect(fs.existsSync(result.outputPath)).toBe(true);

    const timeline = result.timeline;
    expect(timeline.version).toBe("1");
    expect(timeline.project_id).toBe("sample-mountain-reset");
    expect(timeline.tracks.video.length).toBeGreaterThan(0);
    expect(timeline.tracks.audio.length).toBeGreaterThan(0);
  });

  it("schema validation passes on generated timeline", () => {
    compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const validation = validateProject(tmpDir);
    const timelineViolations = validation.violations.filter(
      (v) => v.artifact === "05_timeline/timeline.json",
    );
    expect(timelineViolations).toEqual([]);
    expect(validation.gate2_timeline_valid).toBe(true);
  });

  it("is deterministic: two runs produce identical output", () => {
    const result1 = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const json1 = JSON.stringify(result1.timeline);

    const result2 = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const json2 = JSON.stringify(result2.timeline);

    expect(json1).toBe(json2);
  });

  it("all clips have motivation set", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const allClips = [
      ...result.timeline.tracks.video.flatMap((t) => t.clips),
      ...result.timeline.tracks.audio.flatMap((t) => t.clips),
    ];

    expect(allClips.length).toBeGreaterThan(0);
    for (const clip of allClips) {
      expect(clip.motivation).toBeTruthy();
      expect(clip.motivation.length).toBeGreaterThan(0);
    }
  });

  it("all clips have fallback_segment_ids set (array, possibly empty)", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const allClips = [
      ...result.timeline.tracks.video.flatMap((t) => t.clips),
      ...result.timeline.tracks.audio.flatMap((t) => t.clips),
    ];

    for (const clip of allClips) {
      expect(Array.isArray(clip.fallback_segment_ids)).toBe(true);
    }
  });

  it("V1 track contains hero clips", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const v1 = result.timeline.tracks.video.find((t) => t.track_id === "V1");
    expect(v1).toBeDefined();
    expect(v1!.clips.length).toBeGreaterThan(0);

    const heroClips = v1!.clips.filter((c) => c.role === "hero");
    expect(heroClips.length).toBeGreaterThan(0);
  });

  it("beat boundary markers are placed at correct frames", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const markers = result.timeline.markers;
    expect(markers.length).toBe(4);

    const beatMarkers = markers.filter((m) => m.kind === "beat");
    expect(beatMarkers.length).toBe(4);

    // Beat boundaries: b01=0, b02=96, b03=312, b04=552
    expect(beatMarkers[0].frame).toBe(0);
    expect(beatMarkers[0].label).toContain("b01");
    expect(beatMarkers[1].frame).toBe(96);
    expect(beatMarkers[1].label).toContain("b02");
    expect(beatMarkers[2].frame).toBe(312);
    expect(beatMarkers[2].label).toContain("b03");
    expect(beatMarkers[3].frame).toBe(552);
    expect(beatMarkers[3].label).toContain("b04");
  });

  it("no duplicate source-range usage across all tracks", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const allClips = [
      ...result.timeline.tracks.video.flatMap((t) => t.clips),
      ...result.timeline.tracks.audio.flatMap((t) => t.clips),
    ];

    const usageKeys = allClips.map((c) => `${c.segment_id}:${c.src_in_us}:${c.src_out_us}`);
    const unique = new Set(usageKeys);
    expect(usageKeys.length).toBe(unique.size);
  });

  it("all clips have src_in_us < src_out_us", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const allClips = [
      ...result.timeline.tracks.video.flatMap((t) => t.clips),
      ...result.timeline.tracks.audio.flatMap((t) => t.clips),
    ];

    for (const clip of allClips) {
      expect(clip.src_in_us).toBeLessThan(clip.src_out_us);
    }
  });

  it("provenance references correct source paths", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const prov = result.timeline.provenance;
    expect(prov.brief_path).toBe("01_intent/creative_brief.yaml");
    expect(prov.blueprint_path).toBe("04_plan/edit_blueprint.yaml");
    expect(prov.selects_path).toBe("04_plan/selects_candidates.yaml");
    expect(prov.compiler_version).toBeTruthy();
  });

  it("created_at uses the provided timestamp, not Date.now()", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    expect(result.timeline.created_at).toBe(FIXED_CREATED_AT);
  });

  it("total timeline fits within target duration", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    expect(result.resolution.duration_fit).toBe(true);
    // Sample project: 96 + 216 + 240 + 168 = 720 frames
    expect(result.resolution.total_frames).toBeLessThanOrEqual(
      result.resolution.target_frames,
    );
  });

  it("sequence metadata is correctly set", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const seq = result.timeline.sequence;
    expect(seq.name).toBe("Mountain Reset");
    expect(seq.fps_num).toBe(24);
    expect(seq.fps_den).toBe(1);
    expect(seq.width).toBe(1920);
    expect(seq.height).toBe(1080);
    expect(seq.start_frame).toBe(0);
  });

  it("fps_num propagates from --fps option to timeline", () => {
    const result30 = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT, fpsNum: 30 });
    expect(result30.timeline.sequence.fps_num).toBe(30);
    expect(result30.timeline.sequence.fps_den).toBe(1);

    const result24 = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    expect(result24.timeline.sequence.fps_num).toBe(24);
  });

  it("A2 and A3 tracks exist but are empty in M1", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const a2 = result.timeline.tracks.audio.find((t) => t.track_id === "A2");
    const a3 = result.timeline.tracks.audio.find((t) => t.track_id === "A3");
    expect(a2).toBeDefined();
    expect(a3).toBeDefined();
    expect(a2!.clips).toEqual([]);
    expect(a3!.clips).toEqual([]);
  });

  it("all clip IDs are unique", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const allClips = [
      ...result.timeline.tracks.video.flatMap((t) => t.clips),
      ...result.timeline.tracks.audio.flatMap((t) => t.clips),
    ];

    const clipIds = allClips.map((c) => c.clip_id);
    const unique = new Set(clipIds);
    expect(clipIds.length).toBe(unique.size);
  });

  it("all clips reference a beat_id", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const allClips = [
      ...result.timeline.tracks.video.flatMap((t) => t.clips),
      ...result.timeline.tracks.audio.flatMap((t) => t.clips),
    ];

    const validBeatIds = ["b01", "b02", "b03", "b04"];
    for (const clip of allClips) {
      expect(validBeatIds).toContain(clip.beat_id);
    }
  });

  it("otioPath and previewManifestPath are returned", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    // M1: otioPath is empty string (stub)
    expect(typeof result.otioPath).toBe("string");
    // previewManifestPath should point to a real file
    expect(result.previewManifestPath).toContain("preview-manifest.json");
    expect(fs.existsSync(result.previewManifestPath)).toBe(true);
  });
});

// ── Phase 4 resolve() unit tests ─────────────────────────────────────

describe("Phase 4: resolve()", () => {
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

  function makeTimeline(videoClips: TimelineClip[][], audioClips: TimelineClip[][] = [[]]): AssembledTimeline {
    return {
      tracks: {
        video: videoClips.map((clips, i) => ({ track_id: `V${i + 1}`, kind: "video" as const, clips })),
        audio: audioClips.map((clips, i) => ({ track_id: `A${i + 1}`, kind: "audio" as const, clips })),
      },
      markers: [],
    };
  }

  it("fixes src_in_us == src_out_us by extending out by 1 second", () => {
    const clip = makeClip({ clip_id: "C1", segment_id: "S1", src_in_us: 100, src_out_us: 100 });
    const timeline = makeTimeline([[clip]]);
    const report = resolve(timeline, 1000);

    expect(report.resolved_invalid_ranges).toBe(1);
    expect(timeline.tracks.video[0].clips[0].src_in_us).toBe(100);
    expect(timeline.tracks.video[0].clips[0].src_out_us).toBe(100 + 1_000_000);
  });

  it("fixes inverted src_in_us > src_out_us by swapping", () => {
    const clip = makeClip({ clip_id: "C1", segment_id: "S1", src_in_us: 500, src_out_us: 100 });
    const timeline = makeTimeline([[clip]]);
    const report = resolve(timeline, 1000);

    expect(report.resolved_invalid_ranges).toBe(1);
    expect(timeline.tracks.video[0].clips[0].src_in_us).toBe(100);
    expect(timeline.tracks.video[0].clips[0].src_out_us).toBe(500);
  });

  it("replaces duplicate source range with full candidate data from fallback", () => {
    const candidates: Candidate[] = [
      {
        segment_id: "SEG_FALLBACK",
        asset_id: "AST_099",
        src_in_us: 7000,
        src_out_us: 8000,
        role: "support",
        why_it_matches: "fallback candidate",
        risks: [],
        confidence: 0.8,
      },
    ];

    const clip1 = makeClip({
      clip_id: "C1",
      segment_id: "SEG_DUP",
      asset_id: "AST_001",
      src_in_us: 10,
      src_out_us: 20,
    });
    const clip2 = makeClip({
      clip_id: "C2",
      segment_id: "SEG_DUP",
      asset_id: "AST_002",
      src_in_us: 10,
      src_out_us: 20,
      fallback_segment_ids: ["SEG_FALLBACK"],
    });

    const timeline = makeTimeline([[clip1], [clip2]]);
    const report = resolve(timeline, 1000, candidates);

    expect(report.resolved_duplicates).toBe(1);
    // clip2 should now have full fallback candidate data
    const replaced = timeline.tracks.video[1].clips[0];
    expect(replaced.segment_id).toBe("SEG_FALLBACK");
    expect(replaced.asset_id).toBe("AST_099");
    expect(replaced.src_in_us).toBe(7000);
    expect(replaced.src_out_us).toBe(8000);
    expect(replaced.confidence).toBe(0.8);
  });

  it("removes clip when duplicate source range has no fallback candidates", () => {
    const clip1 = makeClip({ clip_id: "C1", segment_id: "SEG_DUP" });
    const clip2 = makeClip({ clip_id: "C2", segment_id: "SEG_DUP", fallback_segment_ids: [] });
    const timeline = makeTimeline([[clip1], [clip2]]);
    const report = resolve(timeline, 1000, []);

    expect(report.resolved_duplicates).toBe(1);
    expect(timeline.tracks.video[1].clips.length).toBe(0);
  });

  it("keeps clips when segment_id matches but source ranges differ", () => {
    const clip1 = makeClip({
      clip_id: "C1",
      segment_id: "SEG_SHARED",
      src_in_us: 0,
      src_out_us: 1_000_000,
    });
    const clip2 = makeClip({
      clip_id: "C2",
      segment_id: "SEG_SHARED",
      src_in_us: 2_000_000,
      src_out_us: 3_000_000,
    });

    const timeline = makeTimeline([[clip1], [clip2]]);
    const report = resolve(timeline, 1000, []);

    expect(report.resolved_duplicates).toBe(0);
    expect(timeline.tracks.video[0].clips).toHaveLength(1);
    expect(timeline.tracks.video[1].clips).toHaveLength(1);
  });
});

// ── Failure path tests ──────────────────────────────────────────────

describe("Failure paths", () => {
  function createTempProjectWithSelects(selectsOverride: object): string {
    const tmpDir = path.join("tests", `tmp_fail_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    copyDirSync(SAMPLE_PROJECT, tmpDir);
    const timelinePath = path.join(tmpDir, "05_timeline/timeline.json");
    if (fs.existsSync(timelinePath)) fs.unlinkSync(timelinePath);
    const manifestPath = path.join(tmpDir, "05_timeline/preview-manifest.json");
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

    // Override selects_candidates.yaml
    const selectsPath = path.join(tmpDir, "04_plan/selects_candidates.yaml");
    const original = parseYaml(fs.readFileSync(selectsPath, "utf-8")) as Record<string, unknown>;
    const merged = { ...original, ...selectsOverride };
    fs.writeFileSync(selectsPath, stringifyYaml(merged), "utf-8");
    return tmpDir;
  }

  it("empty candidates produces a timeline with no clips", () => {
    const tmpDir = createTempProjectWithSelects({ candidates: [] });
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      const allClips = [
        ...result.timeline.tracks.video.flatMap((t) => t.clips),
        ...result.timeline.tracks.audio.flatMap((t) => t.clips),
      ];
      expect(allClips.length).toBe(0);
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("all-reject candidates produces a timeline with no clips", () => {
    const tmpDir = createTempProjectWithSelects({
      candidates: [
        {
          segment_id: "SEG_R1",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 1000000,
          role: "reject",
          why_it_matches: "rejected",
          risks: [],
          confidence: 0.1,
        },
      ],
    });
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      const allClips = [
        ...result.timeline.tracks.video.flatMap((t) => t.clips),
        ...result.timeline.tracks.audio.flatMap((t) => t.clips),
      ];
      expect(allClips.length).toBe(0);
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("candidates with no matching required_roles produce empty tracks", () => {
    // All candidates are "texture" but b01 requires "hero"
    const tmpDir = createTempProjectWithSelects({
      candidates: [
        {
          segment_id: "SEG_TEX1",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 5000000,
          role: "texture",
          why_it_matches: "texture only",
          risks: [],
          confidence: 0.9,
          eligible_beats: ["b01"],
        },
      ],
    });
    try {
      const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
      const v1 = result.timeline.tracks.video.find((t) => t.track_id === "V1");
      // V1 expects hero clips — should have none since no hero candidates
      const heroClips = v1?.clips.filter((c) => c.role === "hero") ?? [];
      expect(heroClips.length).toBe(0);
    } finally {
      removeDirSync(tmpDir);
    }
  });
});
